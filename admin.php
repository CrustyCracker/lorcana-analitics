<?php
/**
 * Panel admina — hasło sesyjne, multi-turniej (DLC MAIN1/MAIN2/CCQ), algorytm predykcji.
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

/**
 * Parse tournaments[] from POST (parallel arrays).
 * @return list<array>
 */
function admin_parse_tournaments_from_post(): array {
    $ids = $_POST['t_id'] ?? [];
    $eventIds = $_POST['t_eventId'] ?? [];
    $names = $_POST['t_name'] ?? [];
    $modes = $_POST['t_mode'] ?? [];
    $cutSizes = $_POST['t_cutSize'] ?? [];
    $cutRules = $_POST['t_cutRule'] ?? [];
    $swissList = $_POST['t_swissRounds'] ?? [];

    if (!is_array($ids)) {
        $ids = [];
    }
    $n = count($ids);
    $out = [];
    for ($i = 0; $i < $n; $i++) {
        $eid = (int)preg_replace('/\D+/', '', (string)($eventIds[$i] ?? ''));
        if ($eid <= 0) {
            continue;
        }
        $swissRaw = trim((string)($swissList[$i] ?? ''));
        $out[] = [
            'id' => (string)($ids[$i] ?? ''),
            'eventId' => $eid,
            'name' => trim((string)($names[$i] ?? '')),
            'mode' => (string)($modes[$i] ?? 'custom'),
            'cutSize' => $cutSizes[$i] ?? 8,
            'cutRule' => $cutRules[$i] ?? 'hard',
            'swissRounds' => $swissRaw === '' ? null : $swissRaw,
        ];
    }
    return $out;
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
    $algo = strtolower(trim((string)($_POST['predictionAlgorithm'] ?? 'hybrid')));
    $tournaments = admin_parse_tournaments_from_post();
    $activeTid = trim((string)($_POST['activeTournamentId'] ?? ''));
    $applyModeDefaults = !empty($_POST['applyModeDefaults']);

    if (!in_array($algo, ['montecarlo', 'hybrid', 'exact'], true)) {
        $error = 'Nieznany algorytm.';
    } elseif (count($tournaments) === 0) {
        $error = 'Dodaj przynajmniej jeden turniej (event ID).';
    } else {
        foreach ($tournaments as $t) {
            $swissRaw = $t['swissRounds'];
            if ($swissRaw !== null && $swissRaw !== '' && lorcana_normalize_swiss_rounds($swissRaw) === null) {
                $error = 'Liczba rund Swiss musi być pusta (PlayHub) albo 1–20 (slot: ' . ($t['name'] ?: $t['eventId']) . ').';
                break;
            }
        }
    }

    if ($error === null) {
        if ($applyModeDefaults) {
            foreach ($tournaments as &$t) {
                $defs = lorcana_prize_mode_defaults($t['mode']);
                $t['cutSize'] = $defs['cutSize'];
                $t['cutRule'] = $defs['cutRule'];
            }
            unset($t);
        }
        if ($activeTid === '' || !in_array($activeTid, array_column($tournaments, 'id'), true)) {
            $activeTid = (string)$tournaments[0]['id'];
        }
        $saved = lorcana_save_site_config([
            'tournaments' => $tournaments,
            'activeTournamentId' => $activeTid,
            'predictionAlgorithm' => $algo,
            'updatedBy' => 'admin',
        ]);
        $names = array_map(static function ($t) {
            return ($t['name'] ?: ('#' . $t['eventId'])) . ' [' . $t['mode'] . ']';
        }, $saved['tournaments']);
        $flash = 'Zapisano ' . count($saved['tournaments']) . ' turniej(e). Domyślny: '
            . (string)$saved['activeTournamentId']
            . ' · #' . (int)$saved['activeEventId']
            . ' · algo=' . $algo
            . '. Lista: ' . implode('; ', $names);
    }
}

if (admin_is_logged_in() && isset($_POST['force_refresh'])) {
    admin_require_post();
    $cfg = lorcana_load_site_config();
    $refreshId = (int)preg_replace('/\D+/', '', (string)($_POST['refreshEventId'] ?? ''));
    if ($refreshId <= 0) {
        $refreshId = (int)$cfg['activeEventId'];
    }
    require_once __DIR__ . '/lib/playhub_fetch.php';
    $authToken = lorcana_load_auth_token();
    lorcana_allow_forced_refresh($refreshId, true);
    lorcana_raise_fetch_time_limit();
    $refreshed = lorcana_refresh_event_cache($refreshId, [
        'force' => true,
        'blocking' => true,
        'allowLocalSslFallback' => true,
        'authToken' => $authToken,
    ]);
    if (!empty($refreshed['ok'])) {
        $flash = 'Wymuszono odświeżenie cache dla #' . $refreshId . '.';
    } else {
        $error = 'Odświeżenie nieudane: ' . (string)($refreshed['error'] ?? 'nieznany błąd');
    }
}

$cfg = lorcana_load_site_config();
$cacheStatuses = [];
if (admin_is_logged_in()) {
    foreach ($cfg['tournaments'] as $t) {
        $eid = (int)$t['eventId'];
        $cached = lorcana_read_cache($eid);
        $ttl = is_array($cached['data']) ? lorcana_cache_ttl_seconds($cached['data']) : null;
        $cacheStatuses[$eid] = [
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
}

?><!DOCTYPE html>
<html lang="pl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Admin — Analityka Lorcany</title>
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
        .wrap { max-width: 920px; margin: 0 auto; }
        h1 { font-size: 1.45rem; margin: 0 0 6px; }
        h2 { font-size: 1.05rem; margin: 0 0 10px; }
        .sub { color: var(--mute); margin: 0 0 22px; font-size: 0.95rem; }
        .card {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 16px;
        }
        label { display: block; font-size: 0.85rem; color: var(--mute); margin-bottom: 6px; }
        input[type="password"], input[type="number"], input[type="text"], select {
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
        button.danger { background: #7f1d1d; color: #fecaca; }
        .flash { background: rgba(52,211,153,.12); border: 1px solid rgba(52,211,153,.35); color: var(--ok); padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; }
        .err { background: rgba(248,113,113,.12); border: 1px solid rgba(248,113,113,.35); color: var(--bad); padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; }
        .meta { font-size: 0.85rem; color: var(--mute); line-height: 1.5; }
        .meta strong { color: var(--text); }
        .topnav { display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; gap: 12px; flex-wrap: wrap; }
        .topnav a { color: var(--gold); }
        code { background: #0b1220; padding: 2px 6px; border-radius: 4px; }
        .slot {
            border: 1px solid var(--line);
            border-radius: 10px;
            padding: 14px;
            margin-bottom: 12px;
            background: #0e1626;
        }
        .slot-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            margin-bottom: 10px;
            flex-wrap: wrap;
        }
        .slot-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 0 12px;
        }
        @media (min-width: 720px) {
            .slot-grid { grid-template-columns: 1fr 1fr; }
        }
        .slot-grid .full { grid-column: 1 / -1; }
        .check-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 10px;
            color: var(--text);
            font-size: 0.95rem;
        }
        .check-row input { width: auto; margin: 0; }
        .slot-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .pill {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 999px;
            font-size: 12px;
            background: #243049;
            color: var(--gold);
        }
    </style>
</head>
<body>
<div class="wrap">
    <div class="topnav">
        <div>
            <h1>Panel admina</h1>
            <p class="sub">Analityka Lorcany — multi-turniej (DLC MAIN1 / MAIN2 / CCQ)</p>
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
        <form method="post" id="adminConfigForm">
            <div class="card">
                <h2>Turnieje weekendu</h2>
                <p class="meta" style="margin-top:0;">
                    Dodaj kilka eventów naraz (np. <strong>DLC MAIN1</strong>, <strong>DLC MAIN2</strong>, <strong>CCQ Infinity</strong>).
                    Publiczna strona przełącza je zakładkami — każdy event ma własny cache PlayHub (<code>cache_{id}.json</code>).
                    Tryb ustawia domyślny cut (MAIN1 = soft Top&nbsp;32, MAIN2 = hard Top&nbsp;8, CCQ = hard Top&nbsp;8).
                </p>

                <div id="tournamentSlots">
                    <?php foreach ($cfg['tournaments'] as $idx => $t): ?>
                        <div class="slot" data-slot>
                            <div class="slot-head">
                                <label class="check-row" style="margin:0;">
                                    <input type="radio" name="activeTournamentId" value="<?= htmlspecialchars((string)$t['id'], ENT_QUOTES, 'UTF-8') ?>"
                                        <?= $cfg['activeTournamentId'] === $t['id'] ? 'checked' : '' ?>>
                                    Domyślny na wejściu
                                </label>
                                <div class="slot-actions">
                                    <span class="pill"><?= htmlspecialchars((string)$t['mode'], ENT_QUOTES, 'UTF-8') ?></span>
                                    <button type="button" class="secondary danger" data-remove-slot>Usuń</button>
                                </div>
                            </div>
                            <input type="hidden" name="t_id[]" value="<?= htmlspecialchars((string)$t['id'], ENT_QUOTES, 'UTF-8') ?>">
                            <div class="slot-grid">
                                <div>
                                    <label>Nazwa (publiczna)</label>
                                    <input type="text" name="t_name[]" maxlength="80"
                                           value="<?= htmlspecialchars((string)$t['name'], ENT_QUOTES, 'UTF-8') ?>"
                                           placeholder="np. DLC London MAIN1">
                                </div>
                                <div>
                                    <label>PlayHub event ID</label>
                                    <input type="number" name="t_eventId[]" min="1" max="999999999" required inputmode="numeric"
                                           value="<?= (int)$t['eventId'] ?>">
                                </div>
                                <div>
                                    <label>Tryb nagród / cut</label>
                                    <select name="t_mode[]" data-mode-select>
                                        <?php
                                        $modes = [
                                            'MAIN1' => 'DLC MAIN1 (soft EUC Top32+ties)',
                                            'MAIN2' => 'DLC MAIN2 (hard Top8 invite)',
                                            'CCQ' => 'CCQ / Infinity',
                                            'custom' => 'Własny (ręczny cut)',
                                        ];
                                        foreach ($modes as $val => $label):
                                        ?>
                                            <option value="<?= $val ?>" <?= $t['mode'] === $val ? 'selected' : '' ?>><?= $label ?></option>
                                        <?php endforeach; ?>
                                    </select>
                                </div>
                                <div>
                                    <label>Top Cut — miejsce</label>
                                    <input type="number" name="t_cutSize[]" min="2" max="256" required inputmode="numeric"
                                           value="<?= (int)$t['cutSize'] ?>" data-cut-size>
                                </div>
                                <div>
                                    <label>Typ Top Cut</label>
                                    <select name="t_cutRule[]" data-cut-rule>
                                        <option value="soft" <?= $t['cutRule'] === 'soft' ? 'selected' : '' ?>>Miękki (Top X + remisy pkt)</option>
                                        <option value="hard" <?= $t['cutRule'] === 'hard' ? 'selected' : '' ?>>Twardy (ścisłe Top X / TB)</option>
                                    </select>
                                </div>
                                <div>
                                    <label>Rundy Swiss (puste = PlayHub)</label>
                                    <input type="number" name="t_swissRounds[]" min="1" max="20" inputmode="numeric"
                                           value="<?= $t['swissRounds'] === null ? '' : (int)$t['swissRounds'] ?>"
                                           placeholder="Auto">
                                </div>
                            </div>
                        </div>
                    <?php endforeach; ?>
                </div>

                <div class="slot-actions" style="margin-bottom:14px;">
                    <button type="button" class="secondary" id="addTournamentSlot">+ Dodaj turniej</button>
                    <label class="check-row" style="margin:0;">
                        <input type="checkbox" name="applyModeDefaults" value="1">
                        Przy zapisie nadpisz cut wartościami trybu (MAIN1→32 soft, MAIN2→8 hard…)
                    </label>
                </div>

                <label for="predictionAlgorithm">Algorytm Can I Tie / strategii</label>
                <select id="predictionAlgorithm" name="predictionAlgorithm">
                    <option value="hybrid" <?= $cfg['predictionAlgorithm'] === 'hybrid' ? 'selected' : '' ?>>hybrid (domyślny) — exact na ostatniej rundzie, MC inaczej</option>
                    <option value="montecarlo" <?= $cfg['predictionAlgorithm'] === 'montecarlo' ? 'selected' : '' ?>>montecarlo — zawsze Monte Carlo</option>
                    <option value="exact" <?= $cfg['predictionAlgorithm'] === 'exact' ? 'selected' : '' ?>>exact — enumeracja gdy mała przestrzeń, inaczej MC</option>
                </select>

                <button type="submit" name="save_config" value="1">Zapisz konfigurację</button>
                <?php if (!empty($cfg['updatedAt'])): ?>
                    <p class="meta" style="margin-top:12px;">Ostatnia zmiana: <strong><?= htmlspecialchars((string)$cfg['updatedAt'], ENT_QUOTES, 'UTF-8') ?></strong></p>
                <?php endif; ?>
            </div>
        </form>

        <div class="card">
            <h2>Cache / poller (per event)</h2>
            <?php foreach ($cfg['tournaments'] as $t):
                $st = $cacheStatuses[(int)$t['eventId']] ?? null;
                ?>
                <p class="meta">
                    <strong><?= htmlspecialchars((string)$t['name'], ENT_QUOTES, 'UTF-8') ?></strong>
                    · #<?= (int)$t['eventId'] ?> · <?= htmlspecialchars((string)$t['mode'], ENT_QUOTES, 'UTF-8') ?>
                    <?php if ($st): ?>
                        · Cache: <strong><?= $st['exists'] ? ($st['fresh'] ? 'HIT' : 'STALE') : 'BRAK' ?></strong>
                        <?php if ($st['ageSeconds'] !== null): ?>
                            (<?= (int)$st['ageSeconds'] ?>s<?php if ($st['ttlSeconds']): ?> / TTL <?= (int)$st['ttlSeconds'] ?>s<?php endif; ?>)
                        <?php endif; ?>
                        <?php if ($st['playerCount'] !== null): ?>
                            · graczy <?= (int)$st['playerCount'] ?>
                            · runda <?= htmlspecialchars((string)($st['activeRound'] ?? '?'), ENT_QUOTES, 'UTF-8') ?>
                            / <?= htmlspecialchars((string)($st['totalRounds'] ?? '?'), ENT_QUOTES, 'UTF-8') ?>
                        <?php endif; ?>
                    <?php endif; ?>
                </p>
                <form method="post" style="margin:0 0 14px;">
                    <input type="hidden" name="refreshEventId" value="<?= (int)$t['eventId'] ?>">
                    <button type="submit" name="force_refresh" value="1" class="secondary">Odśwież cache #<?= (int)$t['eventId'] ?></button>
                </form>
            <?php endforeach; ?>
            <p class="meta">
                Poller: <code>refresh_cache.php</code> śledzi wszystkie eventy z listy.
                Publiczne <code>?refresh=1</code> limitowane ~8&nbsp;s / event — przełączanie zakładek NIE wali w PlayHub, bierze osobny cache.
            </p>
        </div>

        <template id="tournamentSlotTemplate">
            <div class="slot" data-slot>
                <div class="slot-head">
                    <label class="check-row" style="margin:0;">
                        <input type="radio" name="activeTournamentId" value="">
                        Domyślny na wejściu
                    </label>
                    <div class="slot-actions">
                        <span class="pill">nowy</span>
                        <button type="button" class="secondary danger" data-remove-slot>Usuń</button>
                    </div>
                </div>
                <input type="hidden" name="t_id[]" value="">
                <div class="slot-grid">
                    <div>
                        <label>Nazwa (publiczna)</label>
                        <input type="text" name="t_name[]" maxlength="80" placeholder="np. DLC MAIN2" value="">
                    </div>
                    <div>
                        <label>PlayHub event ID</label>
                        <input type="number" name="t_eventId[]" min="1" max="999999999" required inputmode="numeric" value="">
                    </div>
                    <div>
                        <label>Tryb nagród / cut</label>
                        <select name="t_mode[]" data-mode-select>
                            <option value="MAIN1">DLC MAIN1 (soft EUC Top32+ties)</option>
                            <option value="MAIN2" selected>DLC MAIN2 (hard Top8 invite)</option>
                            <option value="CCQ">CCQ / Infinity</option>
                            <option value="custom">Własny (ręczny cut)</option>
                        </select>
                    </div>
                    <div>
                        <label>Top Cut — miejsce</label>
                        <input type="number" name="t_cutSize[]" min="2" max="256" required inputmode="numeric" value="8" data-cut-size>
                    </div>
                    <div>
                        <label>Typ Top Cut</label>
                        <select name="t_cutRule[]" data-cut-rule>
                            <option value="soft">Miękki (Top X + remisy pkt)</option>
                            <option value="hard" selected>Twardy (ścisłe Top X / TB)</option>
                        </select>
                    </div>
                    <div>
                        <label>Rundy Swiss (puste = PlayHub)</label>
                        <input type="number" name="t_swissRounds[]" min="1" max="20" inputmode="numeric" value="" placeholder="Auto">
                    </div>
                </div>
            </div>
        </template>

        <script>
        (function () {
            const MODE_DEFAULTS = {
                MAIN1: { cutSize: 32, cutRule: 'soft' },
                MAIN2: { cutSize: 8, cutRule: 'hard' },
                CCQ: { cutSize: 8, cutRule: 'hard' },
                custom: { cutSize: 8, cutRule: 'hard' }
            };
            const host = document.getElementById('tournamentSlots');
            const tpl = document.getElementById('tournamentSlotTemplate');
            const addBtn = document.getElementById('addTournamentSlot');

            function newId() {
                if (window.crypto && crypto.getRandomValues) {
                    const a = new Uint8Array(4);
                    crypto.getRandomValues(a);
                    return 't_' + Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
                }
                return 't_' + Math.random().toString(16).slice(2, 10);
            }

            function bindSlot(slot) {
                const modeSel = slot.querySelector('[data-mode-select]');
                const cutSize = slot.querySelector('[data-cut-size]');
                const cutRule = slot.querySelector('[data-cut-rule]');
                const removeBtn = slot.querySelector('[data-remove-slot]');
                if (modeSel) {
                    modeSel.addEventListener('change', () => {
                        const d = MODE_DEFAULTS[modeSel.value] || MODE_DEFAULTS.custom;
                        if (cutSize) cutSize.value = String(d.cutSize);
                        if (cutRule) cutRule.value = d.cutRule;
                    });
                }
                if (removeBtn) {
                    removeBtn.addEventListener('click', () => {
                        const slots = host.querySelectorAll('[data-slot]');
                        if (slots.length <= 1) {
                            alert('Zostaw przynajmniej jeden turniej.');
                            return;
                        }
                        const wasChecked = slot.querySelector('input[type=radio]')?.checked;
                        slot.remove();
                        if (wasChecked) {
                            const first = host.querySelector('input[type=radio]');
                            if (first) first.checked = true;
                        }
                    });
                }
            }

            host.querySelectorAll('[data-slot]').forEach(bindSlot);

            addBtn?.addEventListener('click', () => {
                const node = tpl.content.firstElementChild.cloneNode(true);
                const id = newId();
                node.querySelector('input[name="t_id[]"]').value = id;
                const radio = node.querySelector('input[type=radio]');
                radio.value = id;
                host.appendChild(node);
                bindSlot(node);
                node.querySelector('input[name="t_eventId[]"]')?.focus();
            });
        })();
        </script>
    <?php endif; ?>
</div>
</body>
</html>
