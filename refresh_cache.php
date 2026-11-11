<?php
/**
 * Background / cron-friendly PlayHub cache refresher.
 *
 * CLI (XAMPP / Task Scheduler / loop):
 *   php refresh_cache.php
 *   php refresh_cache.php --event=1233041 --force
 *   php refresh_cache.php --loop --sleep=30
 *
 * HTTP (shared hosting cron, e.g. Voj4k):
 *   GET refresh_cache.php?key=YOUR_CRON_KEY
 *   GET refresh_cache.php?key=...&eventId=1233041&force=1
 *
 * Env / config:
 *   LORCANA_CRON_KEY  — required for remote HTTP; local requests exempt
 *   Or file cron_key.txt in project root (gitignored)
 */

require_once __DIR__ . '/lib/playhub_cache.php';
require_once __DIR__ . '/lib/playhub_fetch.php';

$isCli = (PHP_SAPI === 'cli' || PHP_SAPI === 'phpdbg');

function lorcana_cron_key_expected() {
    $env = getenv('LORCANA_CRON_KEY');
    if (is_string($env) && $env !== '') {
        return $env;
    }
    $file = LORCANA_CACHE_ROOT . '/cron_key.txt';
    if (file_exists($file)) {
        return trim((string)file_get_contents($file));
    }
    return '';
}

function lorcana_parse_cli_args(array $argv) {
    $opts = [
        'eventId' => null,
        'force' => false,
        'loop' => false,
        'sleep' => 30,
        'once' => true,
    ];
    foreach (array_slice($argv, 1) as $arg) {
        if ($arg === '--force' || $arg === '-f') {
            $opts['force'] = true;
        } elseif ($arg === '--loop') {
            $opts['loop'] = true;
            $opts['once'] = false;
        } elseif (preg_match('/^--event(?:=|:)(\d+)$/', $arg, $m)) {
            $opts['eventId'] = (int)$m[1];
        } elseif (preg_match('/^--sleep(?:=|:)(\d+)$/', $arg, $m)) {
            $opts['sleep'] = max(1, (int)$m[1]);
        } elseif (preg_match('/^\d+$/', $arg)) {
            $opts['eventId'] = (int)$arg;
        }
    }
    return $opts;
}

function lorcana_is_local_http() {
    $remoteIp = $_SERVER['REMOTE_ADDR'] ?? '';
    return in_array($remoteIp, ['127.0.0.1', '::1'], true)
        || ($remoteIp !== '' && filter_var($remoteIp, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false);
}

/**
 * Collect event IDs to keep warm, prioritized for active / recently requested.
 * @return int[]
 */
function lorcana_collect_event_ids($explicitEventId = null) {
    $scored = [];
    $bump = function ($id, $score) use (&$scored) {
        $id = (int)$id;
        if ($id <= 0) {
            return;
        }
        $scored[$id] = max($score, $scored[$id] ?? 0);
    };

    if ($explicitEventId) {
        $bump($explicitEventId, 1000);
    }

    $now = time();
    foreach (lorcana_load_tracked_events() as $row) {
        $id = (int)($row['eventId'] ?? 0);
        if ($id <= 0) {
            continue;
        }
        $lastReq = (int)($row['lastRequestAt'] ?? 0);
        $recency = $lastReq > 0 ? max(0, 500 - (int)floor(($now - $lastReq) / 60)) : 50;
        $bump($id, 200 + $recency);
    }

    $last = lorcana_get_default_event_id();
    if ($last > 0) {
        $bump($last, 400);
    }

    // Existing cache files — prefer live/incomplete via meta sidecar when present.
    $files = glob(LORCANA_CACHE_ROOT . '/cache_*.json') ?: [];
    foreach ($files as $f) {
        if (!preg_match('/cache_(\d+)\.json$/', $f, $m)) {
            continue;
        }
        $id = (int)$m[1];
        $score = 20;
        $meta = lorcana_read_cache_meta_sidecar($id);
        if (is_array($meta)) {
            $completed = !empty($meta['isCompleted'])
                || in_array(strtolower((string)($meta['displayStatus'] ?? '')), ['complete', 'completed', 'finished'], true);
            if (!$completed) {
                $score = 300; // live / in-progress → keep warm first
            } else {
                $score = 40;
            }
            // Ensure gzip/meta sidecars stay present for fast HIT.
            if (!lorcana_cache_gz_is_fresh($id)) {
                @lorcana_ensure_cache_sidecars($id);
            }
        } else {
            // No meta yet — warm sidecars opportunistically so next browser HIT is fast.
            @lorcana_ensure_cache_sidecars($id);
            $score = 80;
        }
        $bump($id, $score);
    }

    arsort($scored, SORT_NUMERIC);
    return array_map('intval', array_keys($scored));
}

/**
 * One refresh pass over tracked/cached events.
 * @return array{startedAt:string,results:array,durationMs:int}
 */
function lorcana_run_refresh_pass($eventIds, $force = false, $allowLocalSsl = false) {
    $started = microtime(true);
    $results = [];
    $authToken = lorcana_load_auth_token();

    // Cap per pass so shared-hosting cron stays inside typical 60–120s limits;
    // highest-priority (live / recent) IDs come first from lorcana_collect_event_ids().
    $maxPerPass = 8;
    if (count($eventIds) > $maxPerPass) {
        $eventIds = array_slice(array_values($eventIds), 0, $maxPerPass);
    }

    foreach ($eventIds as $eventId) {
        $t0 = microtime(true);
        $res = lorcana_refresh_event_cache($eventId, [
            'force' => $force,
            'blocking' => false,
            'allowLocalSslFallback' => $allowLocalSsl,
            'authToken' => $authToken,
        ]);
        $ms = (int)round((microtime(true) - $t0) * 1000);
        if (!empty($res['ok']) && !empty($res['payload'])) {
            @lorcana_ensure_cache_sidecars($eventId, null, $res['payload']);
        } elseif (!empty($res['ok'])) {
            @lorcana_ensure_cache_sidecars($eventId);
        }
        $results[] = [
            'eventId' => $eventId,
            'ok' => !empty($res['ok']),
            'skipped' => !empty($res['skipped']),
            'reason' => $res['reason'] ?? null,
            'error' => $res['error'] ?? null,
            'ms' => $ms,
            'playerCount' => isset($res['payload']['playerCount']) ? $res['payload']['playerCount'] : null,
            'ttl' => isset($res['payload']) ? lorcana_cache_ttl_seconds($res['payload']) : ($res['ttl'] ?? null),
            'gzFresh' => lorcana_cache_gz_is_fresh($eventId),
        ];
    }

    return [
        'startedAt' => gmdate('c'),
        'results' => $results,
        'durationMs' => (int)round((microtime(true) - $started) * 1000),
    ];
}

// --------------- CLI ---------------
if ($isCli) {
    $opts = lorcana_parse_cli_args($argv ?? []);
    $allowLocalSsl = true; // XAMPP often lacks CA bundle

    $globalLock = lorcana_acquire_lock(lorcana_refresh_lock_file(null), false);
    if (!$globalLock) {
        fwrite(STDERR, "refresh_cache: another poller holds the global lock; exiting.\n");
        exit(0);
    }

    try {
        do {
            $ids = lorcana_collect_event_ids($opts['eventId']);
            if (empty($ids)) {
                fwrite(STDOUT, "refresh_cache: no tracked events; idle.\n");
            } else {
                $pass = lorcana_run_refresh_pass($ids, $opts['force'], $allowLocalSsl);
                foreach ($pass['results'] as $r) {
                    $state = !$r['ok'] ? ('ERR ' . ($r['error'] ?? '')) : ($r['skipped'] ? ('skip:' . ($r['reason'] ?? '')) : 'refreshed');
                    fwrite(STDOUT, sprintf(
                        "[%s] event=%d %s %dms players=%s ttl=%s\n",
                        gmdate('H:i:s'),
                        $r['eventId'],
                        $state,
                        $r['ms'],
                        $r['playerCount'] ?? '-',
                        $r['ttl'] ?? '-'
                    ));
                }
                fwrite(STDOUT, sprintf("pass done in %dms (%d events)\n", $pass['durationMs'], count($pass['results'])));
            }

            // --force only applies to first loop iteration
            $opts['force'] = false;

            if ($opts['loop']) {
                sleep((int)$opts['sleep']);
            }
        } while ($opts['loop']);
    } finally {
        lorcana_release_lock($globalLock);
    }
    exit(0);
}

// --------------- HTTP ---------------
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

$expectedKey = lorcana_cron_key_expected();
$providedKey = (string)($_GET['key'] ?? ($_SERVER['HTTP_X_CRON_KEY'] ?? ''));
$authorized = lorcana_is_local_http()
    || ($expectedKey !== '' && hash_equals($expectedKey, $providedKey));

if (!$authorized) {
    http_response_code(403);
    echo json_encode([
        'error' => 'Forbidden. Set LORCANA_CRON_KEY / cron_key.txt and pass ?key=…',
    ]);
    exit;
}

$force = isset($_GET['force']) || isset($_GET['refresh']);
$eventId = isset($_GET['eventId']) ? filter_var($_GET['eventId'], FILTER_VALIDATE_INT) : null;
if ($eventId === false) {
    $eventId = null;
}

$globalLock = lorcana_acquire_lock(lorcana_refresh_lock_file(null), false);
if (!$globalLock) {
    echo json_encode([
        'ok' => true,
        'skipped' => true,
        'reason' => 'global_lock',
        'message' => 'Another refresh is already running.',
    ]);
    exit;
}

try {
    // Large multi-event refresh needs headroom for ~3k cold fills
    lorcana_raise_fetch_time_limit();
    $ids = lorcana_collect_event_ids($eventId);
    $pass = lorcana_run_refresh_pass($ids, $force, lorcana_is_local_http());
    echo json_encode([
        'ok' => true,
        'skipped' => false,
        'eventCount' => count($ids),
        'pass' => $pass,
    ]);
} finally {
    lorcana_release_lock($globalLock);
}
