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

function lorcana_collect_event_ids($explicitEventId = null) {
    $ids = [];
    if ($explicitEventId) {
        $ids[(int)$explicitEventId] = true;
    }
    foreach (lorcana_load_tracked_events() as $row) {
        $id = (int)($row['eventId'] ?? 0);
        if ($id > 0) {
            $ids[$id] = true;
        }
    }
    $last = lorcana_get_default_event_id();
    if ($last > 0) {
        $ids[$last] = true;
    }
    // Also pick up any existing cache_*.json files (recent tournaments)
    $files = glob(LORCANA_CACHE_ROOT . '/cache_*.json') ?: [];
    foreach ($files as $f) {
        if (preg_match('/cache_(\d+)\.json$/', $f, $m)) {
            $ids[(int)$m[1]] = true;
        }
    }
    return array_map('intval', array_keys($ids));
}

/**
 * One refresh pass over tracked/cached events.
 * @return array{startedAt:string,results:array,durationMs:int}
 */
function lorcana_run_refresh_pass($eventIds, $force = false, $allowLocalSsl = false) {
    $started = microtime(true);
    $results = [];
    $authToken = lorcana_load_auth_token();

    foreach ($eventIds as $eventId) {
        $t0 = microtime(true);
        $res = lorcana_refresh_event_cache($eventId, [
            'force' => $force,
            'blocking' => false,
            'allowLocalSslFallback' => $allowLocalSsl,
            'authToken' => $authToken,
        ]);
        $ms = (int)round((microtime(true) - $t0) * 1000);
        $results[] = [
            'eventId' => $eventId,
            'ok' => !empty($res['ok']),
            'skipped' => !empty($res['skipped']),
            'reason' => $res['reason'] ?? null,
            'error' => $res['error'] ?? null,
            'ms' => $ms,
            'playerCount' => isset($res['payload']['playerCount']) ? $res['payload']['playerCount'] : null,
            'ttl' => isset($res['payload']) ? lorcana_cache_ttl_seconds($res['payload']) : ($res['ttl'] ?? null),
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
    // Avoid hanging the HTTP worker forever on large multi-event refresh
    @set_time_limit(120);
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
