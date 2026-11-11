<?php
/**
 * Disk cache + tracked-event helpers for PlayHub payloads.
 * Atomic writes; adaptive TTL (faster during live Swiss).
 */

if (!defined('LORCANA_CACHE_ROOT')) {
    define('LORCANA_CACHE_ROOT', dirname(__DIR__));
}

function lorcana_cache_file($eventId) {
    $id = (int)$eventId;
    return LORCANA_CACHE_ROOT . '/cache_' . $id . '.json';
}

/** Pre-gzipped body for HIT serve (same JSON bytes as cache_*.json). */
function lorcana_cache_gz_file($eventId) {
    return lorcana_cache_file($eventId) . '.gz';
}

/** Tiny sidecar: slim/TTL fields without decoding the full snapshot. */
function lorcana_cache_meta_file($eventId) {
    $id = (int)$eventId;
    return LORCANA_CACHE_ROOT . '/cache_' . $id . '.meta.json';
}

function lorcana_tracked_events_file() {
    return LORCANA_CACHE_ROOT . '/tracked_events.json';
}

function lorcana_last_event_file() {
    return LORCANA_CACHE_ROOT . '/last_event.txt';
}

function lorcana_token_file() {
    return LORCANA_CACHE_ROOT . '/token.txt';
}

function lorcana_refresh_lock_file($eventId = null) {
    if ($eventId === null) {
        return LORCANA_CACHE_ROOT . '/cache_refresh.lock';
    }
    return LORCANA_CACHE_ROOT . '/cache_' . (int)$eventId . '.lock';
}

/**
 * Adaptive soft TTL (seconds) for stale-while-revalidate.
 * Live Swiss → short; completed → long; large fields slightly longer.
 */
function lorcana_cache_ttl_seconds(array $payload) {
    $playerCount = (int)($payload['playerCount'] ?? 0);
    $isCompleted = !empty($payload['isCompleted']);
    $display = strtolower((string)($payload['displayStatus'] ?? ''));
    $activeRound = (int)($payload['activeRound'] ?? 0);
    $totalRounds = (int)($payload['totalRounds'] ?? 0);
    $standingsRound = (int)($payload['standingsRound'] ?? 0);

    if ($isCompleted || in_array($display, ['complete', 'completed', 'finished'], true)) {
        return 600; // 10 min — finished events rarely change
    }

    $inLiveSwiss = $activeRound > 0
        && ($totalRounds <= 0 || $activeRound <= $totalRounds)
        && !in_array($display, ['complete', 'completed', 'finished'], true);

    // Live Swiss default cadence ~30s (was ~10–20s).
    if ($inLiveSwiss && $standingsRound < $activeRound) {
        if ($playerCount >= 1000) {
            return 45;
        }
        if ($playerCount >= 400) {
            return 35;
        }
        return 30;
    }

    if ($inLiveSwiss) {
        if ($playerCount >= 1000) {
            return 45;
        }
        if ($playerCount >= 400) {
            return 35;
        }
        return 30;
    }

    // Default / unknown status
    if ($playerCount >= 1000) {
        return 60;
    }
    if ($playerCount >= 400) {
        return 45;
    }
    return 30;
}

/** How often the background poller should revisit an event (may equal soft TTL). */
function lorcana_poll_interval_seconds(array $payload) {
    return lorcana_cache_ttl_seconds($payload);
}

function lorcana_atomic_write_json($path, $data) {
    $json = is_string($data) ? $data : json_encode($data, JSON_UNESCAPED_UNICODE);
    if ($json === false || $json === '') {
        return false;
    }
    $dir = dirname($path);
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    $tmp = $path . '.tmp.' . getmypid() . '.' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $json, LOCK_EX) === false) {
        // Last resort: overwrite in place (file never disappears).
        return @file_put_contents($path, $json, LOCK_EX) !== false;
    }

    // Prefer replace that never unlinks the live file first.
    // Windows cannot rename-over-existing; unlink+rename created a HIT/MISS race.
    // copy($tmp, $path, true) overwrites destination while keeping the path present.
    if (@copy($tmp, $path)) {
        @unlink($tmp);
        return true;
    }

    // Unix fallback: atomic rename into place when destination is absent / replaceable
    if (@rename($tmp, $path)) {
        return true;
    }

    $ok = @file_put_contents($path, $json, LOCK_EX) !== false;
    @unlink($tmp);
    return $ok;
}

/**
 * @return array{exists:bool,age:int|null,mtime:int|null,raw:string,data:array|null}
 */
function lorcana_read_cache($eventId) {
    $path = lorcana_cache_file($eventId);
    if (!file_exists($path)) {
        return [
            'exists' => false,
            'age' => null,
            'mtime' => null,
            'raw' => '',
            'data' => null,
        ];
    }
    $mtime = @filemtime($path);
    $raw = (string)@file_get_contents($path);
    $data = $raw !== '' ? json_decode($raw, true) : null;
    $age = is_int($mtime) ? max(0, time() - $mtime) : null;
    return [
        'exists' => true,
        'age' => $age,
        'mtime' => is_int($mtime) ? $mtime : null,
        'raw' => $raw,
        'data' => is_array($data) ? $data : null,
    ];
}

/**
 * Build lightweight meta for fast HIT (no full JSON decode needed later).
 */
function lorcana_cache_sidecar_meta_from_payload(array $payload) {
    return [
        'slimVersion' => (int)($payload['_slimVersion'] ?? 0),
        'ttlSeconds' => (int)lorcana_cache_ttl_seconds($payload),
        'playerCount' => (int)($payload['playerCount'] ?? 0),
        'displayStatus' => (string)($payload['displayStatus'] ?? ''),
        'isCompleted' => !empty($payload['isCompleted']),
        'activeRound' => (int)($payload['activeRound'] ?? 0),
        'totalRounds' => (int)($payload['totalRounds'] ?? 0),
        'standingsRound' => (int)($payload['standingsRound'] ?? 0),
        'eventId' => (int)($payload['eventId'] ?? 0),
    ];
}

/**
 * Write gzip sidecar for $jsonPath when zlib is available.
 */
function lorcana_write_cache_gz_from_string($eventId, $json) {
    if (!function_exists('gzencode')) {
        return false;
    }
    $json = (string)$json;
    if ($json === '') {
        return false;
    }
    $gz = gzencode($json, 6);
    if ($gz === false || $gz === '') {
        return false;
    }
    $path = lorcana_cache_gz_file($eventId);
    $tmp = $path . '.tmp.' . getmypid() . '.' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $gz, LOCK_EX) === false) {
        return @file_put_contents($path, $gz, LOCK_EX) !== false;
    }
    if (@copy($tmp, $path)) {
        @unlink($tmp);
        return true;
    }
    if (@rename($tmp, $path)) {
        return true;
    }
    $ok = @file_put_contents($path, $gz, LOCK_EX) !== false;
    @unlink($tmp);
    return $ok;
}

function lorcana_write_cache_meta_sidecar($eventId, array $meta) {
    $meta['jsonBytes'] = (int)(@filesize(lorcana_cache_file($eventId)) ?: ($meta['jsonBytes'] ?? 0));
    $gzPath = lorcana_cache_gz_file($eventId);
    if (is_file($gzPath)) {
        $meta['gzBytes'] = (int)(@filesize($gzPath) ?: 0);
        $meta['gzMtime'] = (int)(@filemtime($gzPath) ?: 0);
    }
    $meta['writtenAt'] = time();
    return lorcana_atomic_write_json(lorcana_cache_meta_file($eventId), $meta);
}

function lorcana_write_cache($eventId, array $payload) {
    $path = lorcana_cache_file($eventId);
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE);
    if ($json === false || $json === '') {
        return false;
    }
    $ok = lorcana_atomic_write_json($path, $json);
    if (!$ok) {
        return false;
    }
    $meta = lorcana_cache_sidecar_meta_from_payload($payload);
    lorcana_write_cache_gz_from_string($eventId, $json);
    lorcana_write_cache_meta_sidecar($eventId, $meta);
    return true;
}

/**
 * Read tiny meta sidecar if present and fresh vs JSON mtime.
 * @return array|null
 */
function lorcana_read_cache_meta_sidecar($eventId) {
    $metaPath = lorcana_cache_meta_file($eventId);
    $jsonPath = lorcana_cache_file($eventId);
    if (!is_file($metaPath) || !is_file($jsonPath)) {
        return null;
    }
    $jsonMtime = (int)(@filemtime($jsonPath) ?: 0);
    $metaMtime = (int)(@filemtime($metaPath) ?: 0);
    // Meta older than JSON → stale sidecar (ignore).
    if ($jsonMtime > 0 && $metaMtime > 0 && $metaMtime + 1 < $jsonMtime) {
        return null;
    }
    $raw = (string)@file_get_contents($metaPath);
    $data = $raw !== '' ? json_decode($raw, true) : null;
    return is_array($data) ? $data : null;
}

/**
 * Peek _slimVersion from raw JSON without full decode (fast path gate).
 */
function lorcana_raw_peek_slim_version($raw) {
    if (!is_string($raw) || $raw === '') {
        return 0;
    }
    // Prefer near end — field is written last by slim pipeline.
    $tail = strlen($raw) > 800 ? substr($raw, -800) : $raw;
    if (preg_match('/"_slimVersion"\s*:\s*(\d+)/', $tail, $m)) {
        return (int)$m[1];
    }
    if (preg_match('/"_slimVersion"\s*:\s*(\d+)/', $raw, $m)) {
        return (int)$m[1];
    }
    return 0;
}

/**
 * Cheap TTL guess from raw JSON head (avoids full decode when meta sidecar missing).
 */
function lorcana_raw_peek_ttl_seconds($raw) {
    if (!is_string($raw) || $raw === '') {
        return 30;
    }
    $head = strlen($raw) > 2500 ? substr($raw, 0, 2500) : $raw;
    $completed = false;
    if (preg_match('/"isCompleted"\s*:\s*true/', $head)) {
        $completed = true;
    } elseif (preg_match('/"displayStatus"\s*:\s*"(complete|completed|finished)"/i', $head)) {
        $completed = true;
    }
    if ($completed) {
        return 600;
    }
    $playerCount = 0;
    if (preg_match('/"playerCount"\s*:\s*(\d+)/', $head, $m)) {
        $playerCount = (int)$m[1];
    }
    if ($playerCount >= 1000) {
        return 45;
    }
    if ($playerCount >= 400) {
        return 35;
    }
    return 30;
}

/**
 * True when gzip sidecar exists and is at least as new as the JSON snapshot.
 */
function lorcana_cache_gz_is_fresh($eventId) {
    $jsonPath = lorcana_cache_file($eventId);
    $gzPath = lorcana_cache_gz_file($eventId);
    if (!is_file($jsonPath) || !is_file($gzPath)) {
        return false;
    }
    $jsonMtime = (int)(@filemtime($jsonPath) ?: 0);
    $gzMtime = (int)(@filemtime($gzPath) ?: 0);
    return $gzMtime + 1 >= $jsonMtime && (int)(@filesize($gzPath) ?: 0) > 0;
}

/**
 * Ensure meta + gzip sidecars exist for an already-slim disk snapshot.
 * Safe to call after the HTTP response is finished.
 */
function lorcana_ensure_cache_sidecars($eventId, $raw = null, array $payload = null) {
    $eventId = (int)$eventId;
    $jsonPath = lorcana_cache_file($eventId);
    if (!is_file($jsonPath)) {
        return false;
    }
    if ($raw === null) {
        $raw = (string)@file_get_contents($jsonPath);
    }
    if ($raw === '') {
        return false;
    }
    if ($payload === null) {
        $payload = json_decode($raw, true);
    }
    if (!is_array($payload)) {
        return false;
    }
    $targetSlim = defined('LORCANA_PAYLOAD_SLIM_VERSION') ? (int)LORCANA_PAYLOAD_SLIM_VERSION : 1;
    if ((int)($payload['_slimVersion'] ?? 0) !== $targetSlim) {
        return false;
    }
    $meta = lorcana_cache_sidecar_meta_from_payload($payload);
    if (!lorcana_cache_gz_is_fresh($eventId)) {
        lorcana_write_cache_gz_from_string($eventId, $raw);
    }
    lorcana_write_cache_meta_sidecar($eventId, $meta);
    return true;
}

/**
 * Stat-only cache probe (no decode) for fast HIT / 304.
 * @return array{exists:bool,age:int|null,mtime:int|null,size:int,path:string}
 */
function lorcana_stat_cache($eventId) {
    $path = lorcana_cache_file($eventId);
    if (!is_file($path)) {
        return [
            'exists' => false,
            'age' => null,
            'mtime' => null,
            'size' => 0,
            'path' => $path,
        ];
    }
    $mtime = @filemtime($path);
    $size = (int)(@filesize($path) ?: 0);
    $age = is_int($mtime) ? max(0, time() - $mtime) : null;
    return [
        'exists' => true,
        'age' => $age,
        'mtime' => is_int($mtime) ? $mtime : null,
        'size' => $size,
        'path' => $path,
    ];
}

function lorcana_prune_old_caches($maxFiles = 25, $maxAgeSeconds = 3600) {
    $existing = glob(LORCANA_CACHE_ROOT . '/cache_*.json');
    if (!is_array($existing) || count($existing) <= $maxFiles) {
        return;
    }
    $now = time();
    foreach ($existing as $oldCache) {
        // Skip lock sidecar names if any match pattern oddly
        if (substr($oldCache, -5) !== '.json') {
            continue;
        }
        // Ignore .meta.json (glob cache_*.json can match cache_1.meta.json on some FS — require _digits.json)
        if (!preg_match('/cache_\d+\.json$/', $oldCache)) {
            continue;
        }
        if ($now - (int)@filemtime($oldCache) > $maxAgeSeconds) {
            @unlink($oldCache);
            @unlink($oldCache . '.gz');
            if (preg_match('/cache_(\d+)\.json$/', $oldCache, $m)) {
                @unlink(lorcana_cache_meta_file((int)$m[1]));
            }
        }
    }
}

function lorcana_load_auth_token() {
    $tokenFile = lorcana_token_file();
    $rawToken = file_exists($tokenFile) ? trim((string)file_get_contents($tokenFile)) : '';
    $rawToken = preg_replace('/[\r\n]+/', '', $rawToken);
    $rawToken = preg_replace('/^authorization:\s*/i', '', $rawToken);
    if (!empty($rawToken) && !str_starts_with($rawToken, 'Token ') && !str_starts_with($rawToken, 'Bearer ')) {
        $rawToken = 'Token ' . $rawToken;
    }
    return !empty($rawToken) ? $rawToken : null;
}

function lorcana_get_default_event_id() {
    $lastEventFile = lorcana_last_event_file();
    $defaultEventId = file_exists($lastEventFile) ? (int)trim((string)file_get_contents($lastEventFile)) : 873264;
    if ($defaultEventId <= 0) {
        $defaultEventId = 873264;
    }
    return $defaultEventId;
}

function lorcana_set_last_event_id($eventId) {
    @file_put_contents(lorcana_last_event_file(), (string)(int)$eventId, LOCK_EX);
}

/**
 * Remember event IDs the UI (or poller) cares about.
 * @return array<string,array{eventId:int,lastRequestAt:int,lastRefreshAt?:int}>
 */
function lorcana_load_tracked_events() {
    $path = lorcana_tracked_events_file();
    if (!file_exists($path)) {
        return [];
    }
    $raw = (string)@file_get_contents($path);
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return [];
    }
    // Support plain list of ids
    if (array_keys($data) === range(0, count($data) - 1)) {
        $map = [];
        foreach ($data as $id) {
            $id = (int)$id;
            if ($id > 0) {
                $map[(string)$id] = ['eventId' => $id, 'lastRequestAt' => time()];
            }
        }
        return $map;
    }
    $out = [];
    foreach ($data as $key => $row) {
        if (is_array($row)) {
            $id = (int)($row['eventId'] ?? $key);
            if ($id > 0) {
                $out[(string)$id] = [
                    'eventId' => $id,
                    'lastRequestAt' => (int)($row['lastRequestAt'] ?? time()),
                    'lastRefreshAt' => isset($row['lastRefreshAt']) ? (int)$row['lastRefreshAt'] : null,
                ];
            }
        } elseif (is_numeric($row)) {
            $id = (int)$key;
            if ($id > 0) {
                $out[(string)$id] = [
                    'eventId' => $id,
                    'lastRequestAt' => (int)$row,
                    'lastRefreshAt' => null,
                ];
            }
        }
    }
    return $out;
}

function lorcana_save_tracked_events(array $map) {
    // Drop stale tracks (>7 days without request)
    $cutoff = time() - 7 * 86400;
    $clean = [];
    foreach ($map as $key => $row) {
        $id = (int)($row['eventId'] ?? $key);
        if ($id <= 0) {
            continue;
        }
        $lastReq = (int)($row['lastRequestAt'] ?? 0);
        if ($lastReq > 0 && $lastReq < $cutoff) {
            continue;
        }
        $clean[(string)$id] = [
            'eventId' => $id,
            'lastRequestAt' => $lastReq ?: time(),
            'lastRefreshAt' => isset($row['lastRefreshAt']) ? (int)$row['lastRefreshAt'] : null,
        ];
    }
    return lorcana_atomic_write_json(lorcana_tracked_events_file(), $clean);
}

function lorcana_track_event($eventId) {
    $id = (int)$eventId;
    if ($id <= 0) {
        return;
    }
    $map = lorcana_load_tracked_events();
    $prev = $map[(string)$id] ?? [];
    $map[(string)$id] = [
        'eventId' => $id,
        'lastRequestAt' => time(),
        'lastRefreshAt' => $prev['lastRefreshAt'] ?? null,
    ];
    lorcana_save_tracked_events($map);
    lorcana_set_last_event_id($id);
}

function lorcana_mark_event_refreshed($eventId) {
    $id = (int)$eventId;
    if ($id <= 0) {
        return;
    }
    $map = lorcana_load_tracked_events();
    $prev = $map[(string)$id] ?? ['eventId' => $id, 'lastRequestAt' => time()];
    $prev['lastRefreshAt'] = time();
    $map[(string)$id] = $prev;
    lorcana_save_tracked_events($map);
}

/**
 * Non-blocking exclusive lock. Returns resource|false.
 * Caller must lorcana_release_lock($fp).
 */
function lorcana_acquire_lock($lockPath, $blocking = false) {
    $fp = @fopen($lockPath, 'c+');
    if (!$fp) {
        return false;
    }
    $flags = LOCK_EX;
    if (!$blocking) {
        $flags |= LOCK_NB;
    }
    if (!flock($fp, $flags)) {
        fclose($fp);
        return false;
    }
    ftruncate($fp, 0);
    fwrite($fp, (string)getmypid() . ' ' . date('c'));
    fflush($fp);
    return $fp;
}

function lorcana_release_lock($fp) {
    if ($fp === false || $fp === null) {
        return;
    }
    @flock($fp, LOCK_UN);
    @fclose($fp);
}

/**
 * Build _cache meta for API responses (not persisted on disk).
 */
function lorcana_cache_meta($status, $age, $ttl, $mtime) {
    return [
        'status' => $status,
        'ageSeconds' => $age,
        'ttlSeconds' => $ttl,
        'cachedAt' => $mtime,
        'cachedAtIso' => $mtime ? gmdate('c', $mtime) : null,
    ];
}

function lorcana_attach_cache_meta(array $payload, array $meta) {
    $payload['_cache'] = $meta;
    return $payload;
}
