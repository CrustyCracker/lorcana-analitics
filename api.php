<?php
/**
 * Lorcana Analytics API — serves PlayHub event snapshots.
 *
 * Default: stale-while-revalidate from disk cache (fast).
 * If a cache file exists → ALWAYS return HIT/STALE immediately (never block on PlayHub).
 * MISS (sync PlayHub) only when no cache file exists, or ?refresh=1 / ?force=1.
 * Background refresh: deferred after response, and/or refresh_cache.php cron.
 */
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');

require_once __DIR__ . '/lib/playhub_cache.php';
require_once __DIR__ . '/lib/playhub_fetch.php';
require_once __DIR__ . '/lib/playhub_slim.php';

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
 * Ensure payload is slimmed; rewrite disk cache when we compacted a fat snapshot.
 * @return array{payload:array,rewrote:bool}
 */
function lorcana_api_ensure_slim(array $payload, $eventId) {
    $before = (int)($payload['_slimVersion'] ?? 0);
    $slimmed = lorcana_slim_event_payload($payload);
    $rewrote = false;
    if ($before !== (int)($slimmed['_slimVersion'] ?? 0) || $before !== LORCANA_PAYLOAD_SLIM_VERSION) {
        // Persist slimmed form so next HIT skips re-slim + ships smaller disk IO.
        if (lorcana_write_cache($eventId, $slimmed)) {
            $rewrote = true;
        }
    }
    return ['payload' => $slimmed, 'rewrote' => $rewrote];
}

/**
 * Build JSON body + cache headers. Returns body string (does not echo).
 */
function lorcana_api_build_body(array $payload, $status, $age, $ttl, $mtime) {
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
    if (!empty($payload['_slimVersion'])) {
        header('X-Lorcana-Slim: ' . (int)$payload['_slimVersion']);
    }
    return json_encode($out, JSON_UNESCAPED_UNICODE);
}

/**
 * Optionally gzip the body when the client accepts it (shared-hosting bandwidth win).
 * @return array{0:string,1:bool} [body, gzipped]
 */
function lorcana_api_maybe_gzip($body) {
    $body = (string)$body;
    $accept = $_SERVER['HTTP_ACCEPT_ENCODING'] ?? '';
    if ($body === '' || stripos($accept, 'gzip') === false || !function_exists('gzencode')) {
        return [$body, false];
    }
    // Skip tiny payloads — gzip overhead not worth it
    if (strlen($body) < 2048) {
        return [$body, false];
    }
    $gz = gzencode($body, 6);
    if ($gz === false || strlen($gz) >= strlen($body)) {
        return [$body, false];
    }
    return [$gz, true];
}

/**
 * ETag from cache file identity (mtime+size+slim), NOT response body —
 * body embeds ageSeconds which would defeat 304 every second.
 */
function lorcana_api_etag_for_cache($eventId, $mtime = null) {
    $path = lorcana_cache_file($eventId);
    $mtime = $mtime !== null ? (int)$mtime : (int)(@filemtime($path) ?: 0);
    $size = (int)(@filesize($path) ?: 0);
    return '"' . dechex($mtime) . '-' . dechex($size) . '-s' . LORCANA_PAYLOAD_SLIM_VERSION . '"';
}

/**
 * 304 Not Modified — client keeps prior JSON; no body transfer/parse.
 */
function lorcana_api_finish_not_modified($etag, $status, $age, $ttl, $mtime) {
    header('ETag: ' . $etag);
    header('Cache-Control: private, no-cache');
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
    http_response_code(304);
    header('Content-Length: 0');
    header('Connection: close');
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
    return 'not_modified';
}

/**
 * Send body and close the client connection so SWR revalidate cannot block the browser.
 */
function lorcana_api_finish_response($body, $etag = null) {
    $body = (string)$body;
    if ($etag) {
        header('ETag: ' . $etag);
        header('Cache-Control: private, no-cache');
    }

    list($out, $gzipped) = lorcana_api_maybe_gzip($body);
    if ($gzipped) {
        header('Content-Encoding: gzip');
        header('Vary: Accept-Encoding');
    }
    header('Content-Length: ' . strlen($out));
    header('Connection: close');
    echo $out;

    ignore_user_abort(true);

    if (function_exists('fastcgi_finish_request')) {
        @fastcgi_finish_request();
        return 'sent';
    }
    if (function_exists('litespeed_finish_request')) {
        @litespeed_finish_request();
        return 'sent';
    }

    while (ob_get_level() > 0) {
        @ob_end_flush();
    }
    @flush();
    return 'sent';
}

/**
 * Kick a non-blocking refresh for one event (CLI spawn when possible).
 * Falls back to in-process refresh after the HTTP response is finished.
 */
function lorcana_api_revalidate_async($eventId, $authToken, $allowLocalSslFallback) {
    $eventId = (int)$eventId;
    $script = LORCANA_CACHE_ROOT . DIRECTORY_SEPARATOR . 'refresh_cache.php';
    $php = defined('PHP_BINARY') && PHP_BINARY ? PHP_BINARY : 'php';

    // Detached CLI is the only reliable non-block on Apache/mod_php (XAMPP).
    if (is_file($script) && !empty($php)) {
        if (strtoupper(substr(PHP_OS, 0, 3)) === 'WIN') {
            $cmd = 'start /B "" ' . escapeshellarg($php) . ' ' . escapeshellarg($script) . ' --event=' . $eventId;
            @pclose(@popen($cmd, 'r'));
            return 'spawn_win';
        }
        $cmd = escapeshellarg($php) . ' ' . escapeshellarg($script) . ' --event=' . $eventId
            . ' > /dev/null 2>&1 &';
        @exec($cmd);
        return 'spawn_unix';
    }

    lorcana_raise_fetch_time_limit();
    lorcana_refresh_event_cache($eventId, [
        'force' => false,
        'blocking' => false,
        'allowLocalSslFallback' => $allowLocalSslFallback,
        'authToken' => $authToken,
    ]);
    return 'inline';
}

// --- SWR path: cache file exists → NEVER block on PlayHub (HIT or STALE) ---
if (!$forceRefresh) {
    $cached = lorcana_read_cache($eventId);
    if ($cached['exists'] && $cached['raw'] !== '' && is_array($cached['data'])) {
        $ensured = lorcana_api_ensure_slim($cached['data'], $eventId);
        $payload = $ensured['payload'];
        $mtime = @filemtime(lorcana_cache_file($eventId)) ?: ($cached['mtime'] ?? time());
        // Age relative to original snapshot when we only rewrote slim (mtime may bump).
        $ageBase = $ensured['rewrote'] ? ($cached['mtime'] ?? $mtime) : $mtime;
        $age = max(0, time() - (int)$ageBase);
        $ttl = lorcana_cache_ttl_seconds($payload);
        $status = ($age < $ttl) ? 'HIT' : 'STALE';
        lorcana_set_last_event_id($eventId);

        $etag = lorcana_api_etag_for_cache($eventId, $mtime);
        $inm = trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''));
        if ($inm !== '' && $inm === $etag) {
            lorcana_api_finish_not_modified($etag, $status, $age, $ttl, $mtime);
            if ($status === 'STALE') {
                lorcana_api_revalidate_async($eventId, $authToken, $isLocalRequest);
            }
            exit;
        }

        $body = lorcana_api_build_body($payload, $status, $age, $ttl, $mtime);
        lorcana_api_finish_response($body, $etag);

        // Revalidate only when soft-TTL expired — after the client already has the snapshot.
        if ($status === 'STALE') {
            lorcana_api_revalidate_async($eventId, $authToken, $isLocalRequest);
        }
        exit;
    }

    // File present but unreadable/corrupt: still do not block on PlayHub for default GETs.
    if ($cached['exists']) {
        http_response_code(503);
        $err = json_encode([
            'error' => 'Cache snapshot damaged; try Shift+click refresh or wait for poller.',
            '_cache' => lorcana_cache_meta('ERROR', $cached['age'], null, $cached['mtime']),
        ]);
        lorcana_api_finish_response($err);
        if ($cached['age'] === null || $cached['age'] > 5) {
            lorcana_api_revalidate_async($eventId, $authToken, $isLocalRequest);
        }
        exit;
    }
}

// Force refresh or true cold miss (no cache file): synchronous PlayHub fetch
lorcana_raise_fetch_time_limit();
$refreshed = lorcana_refresh_event_cache($eventId, [
    'force' => true,
    'blocking' => true,
    'allowLocalSslFallback' => $isLocalRequest,
    'authToken' => $authToken,
]);

if (!empty($refreshed['ok']) && !empty($refreshed['payload'])) {
    $payload = lorcana_slim_event_payload($refreshed['payload']);
    $mtime = @filemtime(lorcana_cache_file($eventId)) ?: time();
    $ttl = lorcana_cache_ttl_seconds($payload);
    // Only label MISS when this was a cold fill (no prior file). Forced refresh stays MISS too (explicit).
    $body = lorcana_api_build_body($payload, 'MISS', 0, $ttl, $mtime);
    $etag = lorcana_api_etag_for_cache($eventId, $mtime);
    lorcana_api_finish_response($body, $etag);
    exit;
}

// Fetch failed — fall back to any stale cache we still have
$cached = lorcana_read_cache($eventId);
if ($cached['exists'] && is_array($cached['data'])) {
    $ensured = lorcana_api_ensure_slim($cached['data'], $eventId);
    $payload = $ensured['payload'];
    $ttl = lorcana_cache_ttl_seconds($payload);
    $mtime = @filemtime(lorcana_cache_file($eventId)) ?: ($cached['mtime'] ?? time());
    $etag = lorcana_api_etag_for_cache($eventId, $mtime);
    $body = lorcana_api_build_body($payload, 'STALE', $cached['age'], $ttl, $mtime);
    lorcana_api_finish_response($body, $etag);
    exit;
}

http_response_code(502);
echo json_encode([
    'error' => $refreshed['error'] ?? 'Nie udało się pobrać danych turnieju.',
]);
