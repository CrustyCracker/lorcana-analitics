<?php
/**
 * Lorcana Analytics API — serves PlayHub event snapshots.
 *
 * Default: stale-while-revalidate from disk cache (fast).
 * Optional: ?refresh=1 / ?force=1 for synchronous PlayHub fetch.
 * Background refresh: refresh_cache.php (CLI or cron HTTP).
 */
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');

require_once __DIR__ . '/lib/playhub_cache.php';
require_once __DIR__ . '/lib/playhub_fetch.php';

$requestMethod = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($requestMethod === 'OPTIONS') {
    exit;
}

$remoteIp = $_SERVER['REMOTE_ADDR'] ?? '';
$isLocalRequest = in_array($remoteIp, ['127.0.0.1', '::1'], true)
    || ($remoteIp !== '' && filter_var($remoteIp, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false);

$tokenFile = lorcana_token_file();
if ($requestMethod === 'POST' && isset($_POST['set_token'])) {
    $expectedAdminKey = getenv('LORCANA_ADMIN_KEY');
    $providedAdminKey = $_POST['admin_key'] ?? ($_SERVER['HTTP_X_ADMIN_KEY'] ?? '');
    $isAuthorizedAdmin = $isLocalRequest || (!empty($expectedAdminKey) && hash_equals($expectedAdminKey, (string)$providedAdminKey));

    if (!$isAuthorizedAdmin) {
        http_response_code(403);
        echo json_encode(["error" => "Brak uprawnień do modyfikacji tokenu autoryzacyjnego."]);
        exit;
    }

    $newToken = trim((string)$_POST['set_token']);
    if (!empty($newToken)) {
        $newToken = preg_replace('/[\r\n]+/', '', $newToken);
        $newToken = preg_replace('/^authorization:\s*/i', '', $newToken);
        if (!str_starts_with($newToken, 'Token ') && !str_starts_with($newToken, 'Bearer ')) {
            $newToken = 'Token ' . $newToken;
        }
        file_put_contents($tokenFile, $newToken, LOCK_EX);
        @chmod($tokenFile, 0600);
        echo json_encode(["success" => true, "message" => "Token został zapisany!"]);
    } else {
        @unlink($tokenFile);
        echo json_encode(["success" => true, "message" => "Token usunięty."]);
    }
    exit;
}

$authToken = lorcana_load_auth_token();
$defaultEventId = lorcana_get_default_event_id();

if (isset($_GET['action']) && $_GET['action'] === 'get_last_event') {
    echo json_encode(["lastEventId" => $defaultEventId]);
    exit;
}

if (isset($_GET['action']) && $_GET['action'] === 'cache_status') {
    $eventId = isset($_GET['eventId']) ? filter_var($_GET['eventId'], FILTER_VALIDATE_INT) : $defaultEventId;
    if ($eventId === false || $eventId <= 0) {
        http_response_code(400);
        echo json_encode(["error" => "Nieprawidłowy eventId."]);
        exit;
    }
    $cached = lorcana_read_cache($eventId);
    $ttl = is_array($cached['data']) ? lorcana_cache_ttl_seconds($cached['data']) : null;
    echo json_encode([
        'eventId' => (int)$eventId,
        'exists' => $cached['exists'],
        'ageSeconds' => $cached['age'],
        'ttlSeconds' => $ttl,
        'fresh' => $cached['exists'] && $ttl !== null && $cached['age'] !== null && $cached['age'] < $ttl,
        'cachedAt' => $cached['mtime'],
        'playerCount' => is_array($cached['data']) ? ($cached['data']['playerCount'] ?? null) : null,
        'displayStatus' => is_array($cached['data']) ? ($cached['data']['displayStatus'] ?? null) : null,
    ]);
    exit;
}

$eventId = isset($_GET['eventId']) ? filter_var($_GET['eventId'], FILTER_VALIDATE_INT) : $defaultEventId;
if ($eventId === false || $eventId <= 0 || $eventId > 999999999) {
    http_response_code(400);
    echo json_encode(["error" => "Nieprawidłowy identyfikator turnieju (eventId)."]);
    exit;
}

// Force sync refresh: refresh|force|nocache (nocache still localhost-only to avoid DoS)
$forceRefresh = isset($_GET['refresh']) || isset($_GET['force']);
$noCacheLocal = isset($_GET['nocache']) && $isLocalRequest;
$forceRefresh = $forceRefresh || $noCacheLocal;

lorcana_track_event($eventId);

/**
 * Emit payload JSON with cache headers + _cache meta.
 */
function lorcana_api_emit(array $payload, $status, $age, $ttl, $mtime) {
    $meta = lorcana_cache_meta($status, $age, $ttl, $mtime);
    $out = lorcana_attach_cache_meta($payload, $meta);
    header('X-Lorcana-Cache: ' . $status);
    if ($age !== null) {
        header('X-Lorcana-Cache-Age: ' . (int)$age);
    }
    if ($ttl !== null) {
        header('X-Lorcana-Cache-TTL: ' . (int)$ttl);
    }
    if ($mtime) {
        header('X-Lorcana-Cache-At: ' . gmdate('c', (int)$mtime));
    }
    echo json_encode($out);
}

// --- Default path: serve disk cache (HIT / STALE), cold miss → sync fetch ---
if (!$forceRefresh) {
    $cached = lorcana_read_cache($eventId);
    if ($cached['exists'] && is_array($cached['data']) && $cached['raw'] !== '') {
        $ttl = lorcana_cache_ttl_seconds($cached['data']);
        $age = $cached['age'] ?? 0;
        $status = ($age < $ttl) ? 'HIT' : 'STALE';
        lorcana_set_last_event_id($eventId);
        lorcana_api_emit($cached['data'], $status, $age, $ttl, $cached['mtime']);

        // Stale-while-revalidate: after responding, try a non-blocking refresh
        // (poller is preferred; this covers XAMPP without a running loop).
        if ($status === 'STALE') {
            ignore_user_abort(true);
            if (function_exists('fastcgi_finish_request')) {
                @fastcgi_finish_request();
            } elseif (function_exists('litespeed_finish_request')) {
                @litespeed_finish_request();
            } else {
                while (ob_get_level() > 0) {
                    @ob_end_flush();
                }
                @flush();
            }
            @set_time_limit(90);
            lorcana_refresh_event_cache($eventId, [
                'force' => false,
                'blocking' => false,
                'allowLocalSslFallback' => $isLocalRequest,
                'authToken' => $authToken,
            ]);
        }
        exit;
    }
}

// Force refresh or cold miss: synchronous PlayHub fetch
$refreshed = lorcana_refresh_event_cache($eventId, [
    'force' => true,
    'blocking' => true,
    'allowLocalSslFallback' => $isLocalRequest,
    'authToken' => $authToken,
]);

if (!empty($refreshed['ok']) && !empty($refreshed['payload'])) {
    $payload = $refreshed['payload'];
    $mtime = @filemtime(lorcana_cache_file($eventId)) ?: time();
    $ttl = lorcana_cache_ttl_seconds($payload);
    lorcana_api_emit($payload, 'MISS', 0, $ttl, $mtime);
    exit;
}

// Fetch failed — fall back to any stale cache we still have
$cached = lorcana_read_cache($eventId);
if ($cached['exists'] && is_array($cached['data'])) {
    $ttl = lorcana_cache_ttl_seconds($cached['data']);
    lorcana_api_emit($cached['data'], 'STALE', $cached['age'], $ttl, $cached['mtime']);
    exit;
}

http_response_code(502);
echo json_encode([
    'error' => $refreshed['error'] ?? 'Nie udało się pobrać danych turnieju.',
]);
