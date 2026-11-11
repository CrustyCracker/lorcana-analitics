<?php
/**
 * Panel admina — hasło sesyjne, aktywny turniej, algorytm predykcji.
 * Hasło weryfikowane przez bcrypt (LORCANA_ADMIN_PASSWORD_HASH); nie ma plaintextu w JS.
 */
declare(strict_types=1);

session_start();

require_once __DIR__ . '/lib/playhub_cache.php';
require_once __DIR__ . '/lib/site_config.php';

header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');
header('Cache-Control: no-store');

function admin_is_logged_in(): bool {
    return !empty($_SESSION['lorcana_admin_ok']) && $_SESSION['lorcana_admin_ok'] === true;
}

function admin_require_post(): void {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        http_response_code(405);
        exit('Method Not Allowed');
    }
}

$flash = null;
$error = null;

if (isset($_GET['logout'])) {
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $p = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
    }
    session_destroy();
    header('Location: admin.php');
    exit;
}

if (isset($_POST['login'])) {
    admin_require_post();
    $pw = (string)($_POST['password'] ?? '');
    if ($pw !== '' && password_verify($pw, LORCANA_ADMIN_PASSWORD_HASH)) {
        session_regenerate_id(true);
        $_SESSION['lorcana_admin_ok'] = true;
        $_SESSION['lorcana_admin_at'] = time();
        header('Location: admin.php');
        exit;
    }
    $error = 'Nieprawidłowe hasło.';
}

if (admin_is_logged_in() && isset($_POST['save_config'])) {
    admin_require_post();
    $eventId = (int)preg_replace('/\D+/', '', (string)($_POST['activeEventId'] ?? ''));
    $algo = strtolower(trim((string)($_POST['predictionAlgorithm'] ?? 'hybrid')));
    $cutSize = lorcana_normalize_cut_size($_POST['defaultCutSize'] ?? 4, 4);
    $cutRule = lorcana_normalize_cut_rule($_POST['defaultCutRule'] ?? 'hard', 'hard');
    $swissRaw = trim((string)($_POST['defaultSwissRounds'] ?? ''));
    $swissRounds = ($swissRaw === '') ? null : lorcana_normalize_swiss_rounds($swissRaw);
    if ($eventId <= 0) {
        $error = 'Podaj poprawne ID turnieju.';
    } elseif (!in_array($algo, ['montecarlo', 'hybrid', 'exact'], true)) {
        $error = 'Nieznany algorytm.';
    } elseif ($swissRaw !== '' && $swissRounds === null) {
        $error = 'Liczba rund Swiss musi być pusta (PlayHub) albo 1–20.';
    } else {
        lorcana_save_site_config([
            'activeEventId' => $eventId,
            'predictionAlgorithm' => $algo,
            'defaultCutSize' => $cutSize,
            'defaultCutRule' => $cutRule,
            'defaultSwissRounds' => $swissRounds,
            'updatedBy' => 'admin',
        ]);
        if (function_exists('lorcana_track_event')) {
            // Track for poller without letting anonymous GETs own last_event.
            $map = lorcana_load_tracked_events();
            $map[(string)$eventId] = [
                'eventId' => $eventId,
                'lastRequestAt' => time(),
                'lastRefreshAt' => $map[(string)$eventId]['lastRefreshAt'] ?? null,
            ];
            lorcana_save_tracked_events($map);
        }
        $swissLabel = $swissRounds === null ? 'PlayHub' : (string)$swissRounds;
        $flash = 'Zapisano: #' . $eventId
            . ', algorytm=' . $algo
            . ', cut=' . $cutSize . '/' . $cutRule
            . ', rundy=' . $swissLabel . '.';
    }
}

if (admin_is_logged_in() && isset($_POST['force_refresh'])) {
    admin_require_post();
    $cfg = lorcana_load_site_config();
    $eventId = (int)$cfg['activeEventId'];
    require_once __DIR__ . '/lib/playhub_fetch.php';
    $authToken = lorcana_load_auth_token();
    lorcana_allow_forced_refresh($eventId, true);
    lorcana_raise_fetch_time_limit();
    $refreshed = lorcana_refresh_event_cache($eventId, [
        'force' => true,
        'blocking' => true,
        'allowLocalSslFallback' => true,
        'authToken' => $authToken,
    ]);
    if (!empty($refreshed['ok'])) {
        $flash = 'Wymuszono odświeżenie cache dla #' . $eventId . '.';
    } else {
        $error = 'Odświeżenie nieudane: ' . (string)($refreshed['error'] ?? 'nieznany błąd');
    }
}

$cfg = lorcana_load_site_config();
$cacheStatus = null;
if (admin_is_logged_in()) {
    $cached = lorcana_read_cache($cfg['activeEventId']);
    $ttl = is_array($cached['data']) ? lorcana_cache_ttl_seconds($cached['data']) : null;
    $cacheStatus = [
        'exists' => $cached['exists'],
        'ageSeconds' => $cached['age'],
        'ttlSeconds' => $ttl,
        'fresh' => $cached['exists'] && $ttl !== null && $cached['age'] !== null && $cached['age'] < $ttl,
        'playerCount' => is_array($cached['data']) ? ($cached['data']['playerCount'] ?? null) : null,
        'displayStatus' => is_array($cached['data']) ? ($cached['data']['displayStatus'] ?? null) : null,
        'activeRound' => is_array($cached['data']) ? ($cached['data']['activeRound'] ?? null) : null,
        'totalRounds' => is_array($cached['data']) ? ($cached['data']['totalRounds'] ?? null) : null,
    ];
}

?><!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Admin — Lorcana Should I TIE?</title>
    <style>
        :root {
            --bg: #0b1220;
            --panel: #121a2b;
            --line: #243049;
            --text: #e8eef8;
            --mute: #94a3b8;
            --gold: #e8c547;
            --ok: #34d399;
            --bad: #f87171;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: "Segoe UI", Tahoma, sans-serif;
            background: radial-gradient(1200px 600px at 20% -10%, #1a2744, var(--bg));
            color: var(--text);
            min-height: 100vh;
            padding: 24px 16px 48px;
        }
        .wrap { max-width: 640px; margin: 0 auto; }
        h1 { font-size: 1.45rem; margin: 0 0 6px; }
        .sub { color: var(--mute); margin: 0 0 22px; font-size: 0.95rem; }
        .card {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 16px;
        }
        label { display: block; font-size: 0.85rem; color: var(--mute); margin-bottom: 6px; }
        input[type="password"], input[type="number"], select {
            width: 100%;
            padding: 10px 12px;
            border-radius: 8px;
            border: 1px solid var(--line);
            background: #0b1220;
            color: var(--text);
            font-size: 1rem;
            margin-bottom: 14px;
        }
        button, .btn {
            display: inline-block;
            border: 0;
            border-radius: 8px;
            padding: 10px 16px;
            background: var(--gold);
            color: #111;
            font-weight: 700;
            cursor: pointer;
            text-decoration: none;
            font-size: 0.95rem;
        }
        button.secondary { background: #243049; color: var(--text); margin-left: 8px; }
        .flash { background: rgba(52,211,153,.12); border: 1px solid rgba(52,211,153,.35); color: var(--ok); padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; }
        .err { background: rgba(248,113,113,.12); border: 1px solid rgba(248,113,113,.35); color: var(--bad); padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; }
        .meta { font-size: 0.85rem; color: var(--mute); line-height: 1.5; }
        .meta strong { color: var(--text); }
        .topnav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; gap: 12px; flex-wrap: wrap; }
        .topnav a { color: var(--gold); }
        code { background: #0b1220; padding: 2px 6px; border-radius: 4px; }
    </style>
</head>
<body>
<div class="wrap">
    <div class="topnav">
        <div>
            <h1>Panel admina</h1>
            <p class="sub">Lorcana Should I TIE? — konfiguracja live</p>
        </div>
        <div>
            <a href="index.html">← Strona publiczna</a>
            <?php if (admin_is_logged_in()): ?>
                · <a href="admin.php?logout=1">Wyloguj</a>
            <?php endif; ?>
        </div>
    </div>

    <?php if ($flash): ?><div class="flash"><?= htmlspecialchars($flash, ENT_QUOTES, 'UTF-8') ?></div><?php endif; ?>
    <?php if ($error): ?><div class="err"><?= htmlspecialchars($error, ENT_QUOTES, 'UTF-8') ?></div><?php endif; ?>

    <?php if (!admin_is_logged_in()): ?>
        <div class="card">
            <form method="post" autocomplete="current-password">
                <label for="password">Hasło</label>
                <input type="password" id="password" name="password" required autofocus>
                <button type="submit" name="login" value="1">Zaloguj</button>
            </form>
            <p class="meta" style="margin-top:14px;">Sesja PHP — hasło nie trafia do publicznego JS.</p>
        </div>
    <?php else: ?>
        <div class="card">
            <form method="post">
                <label for="activeEventId">Aktywne ID turnieju (PlayHub)</label>
                <input type="number" id="activeEventId" name="activeEventId" min="1" max="999999999"
                       value="<?= (int)$cfg['activeEventId'] ?>" required inputmode="numeric">

                <label for="predictionAlgorithm">Algorytm Can I Tie / strategii</label>
                <select id="predictionAlgorithm" name="predictionAlgorithm">
                    <option value="hybrid" <?= $cfg['predictionAlgorithm'] === 'hybrid' ? 'selected' : '' ?>>hybrid (domyślny) — exact na ostatniej rundzie, MC inaczej</option>
                    <option value="montecarlo" <?= $cfg['predictionAlgorithm'] === 'montecarlo' ? 'selected' : '' ?>>montecarlo — zawsze Monte Carlo</option>
                    <option value="exact" <?= $cfg['predictionAlgorithm'] === 'exact' ? 'selected' : '' ?>>exact — enumeracja gdy mała przestrzeń, inaczej MC</option>
                </select>

                <label for="defaultCutSize">Domyślny Top Cut — od którego miejsca</label>
                <input type="number" id="defaultCutSize" name="defaultCutSize" min="2" max="256"
                       value="<?= (int)$cfg['defaultCutSize'] ?>" required inputmode="numeric">

                <label for="defaultCutRule">Domyślny typ Top Cut</label>
                <select id="defaultCutRule" name="defaultCutRule">
                    <option value="hard" <?= $cfg['defaultCutRule'] === 'hard' ? 'selected' : '' ?>>Twardy Cut (sztywne Top X) [ME 2]</option>
                    <option value="soft" <?= $cfg['defaultCutRule'] === 'soft' ? 'selected' : '' ?>>Miękki Cut (Top X + remisy punktowe) [ME 1]</option>
                </select>

                <label for="defaultSwissRounds">Domyślna liczba rund Swiss</label>
                <input type="number" id="defaultSwissRounds" name="defaultSwissRounds" min="1" max="20"
                       value="<?= $cfg['defaultSwissRounds'] === null ? '' : (int)$cfg['defaultSwissRounds'] ?>"
                       placeholder="Puste = PlayHub (auto)" inputmode="numeric">
                <p class="meta" style="margin:-6px 0 14px;">Puste pole = goście bez lokalnego override biorą rundy z PlayHub. Wartość 1–20 = domyślna dla nowych wizyt.</p>

                <button type="submit" name="save_config" value="1">Zapisz konfigurację</button>
            </form>
            <p class="meta" style="margin-top:12px;">
                Publiczni użytkownicy mogą nadpisać cut/rundy tylko lokalnie (localStorage) — to <strong>nie zmienia</strong> tych domyślnych ani innych gości.
                Nowi odwiedzający / po wyczyszczeniu lokalnego override biorą wartości stąd.
            </p>
            <?php if (!empty($cfg['updatedAt'])): ?>
                <p class="meta" style="margin-top:8px;">Ostatnia zmiana: <strong><?= htmlspecialchars((string)$cfg['updatedAt'], ENT_QUOTES, 'UTF-8') ?></strong></p>
            <?php endif; ?>
        </div>

        <div class="card">
            <h2 style="font-size:1.05rem;margin:0 0 10px;">Cache / poller</h2>
            <?php if ($cacheStatus): ?>
                <p class="meta">
                    Event <strong>#<?= (int)$cfg['activeEventId'] ?></strong><br>
                    Cache: <strong><?= $cacheStatus['exists'] ? ($cacheStatus['fresh'] ? 'HIT (świeży)' : 'STALE') : 'BRAK' ?></strong>
                    <?php if ($cacheStatus['ageSeconds'] !== null): ?>
                        · wiek <?= (int)$cacheStatus['ageSeconds'] ?>s
                        <?php if ($cacheStatus['ttlSeconds']): ?> / TTL <?= (int)$cacheStatus['ttlSeconds'] ?>s<?php endif; ?>
                    <?php endif; ?><br>
                    <?php if ($cacheStatus['playerCount'] !== null): ?>
                        Graczy: <strong><?= (int)$cacheStatus['playerCount'] ?></strong>
                        · status: <?= htmlspecialchars((string)($cacheStatus['displayStatus'] ?? '—'), ENT_QUOTES, 'UTF-8') ?>
                        · runda <?= htmlspecialchars((string)($cacheStatus['activeRound'] ?? '?'), ENT_QUOTES, 'UTF-8') ?>
                        / <?= htmlspecialchars((string)($cacheStatus['totalRounds'] ?? '?'), ENT_QUOTES, 'UTF-8') ?>
                    <?php endif; ?>
                </p>
            <?php endif; ?>
            <form method="post" style="margin-top:12px;">
                <button type="submit" name="force_refresh" value="1">Wymuś odświeżenie cache (PlayHub)</button>
            </form>
            <p class="meta" style="margin-top:12px;">
                Poller: uruchamiaj okresowo <code>refresh_cache.php</code> (cron), żeby ~100 klientów dostawało HIT/304 bez stampede na PlayHub.
                Publiczne <code>?refresh=1</code> jest limitowane (~8&nbsp;s / event).
            </p>
        </div>
    <?php endif; ?>
</div>
</body>
</html>
