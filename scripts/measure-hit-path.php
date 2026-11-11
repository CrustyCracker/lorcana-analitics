<?php
/**
 * Local probe: cost of HIT path phases for a cached event.
 * Usage: php scripts/measure-hit-path.php [eventId]
 */
require_once dirname(__DIR__) . '/lib/playhub_cache.php';
require_once dirname(__DIR__) . '/lib/playhub_slim.php';

$id = isset($argv[1]) ? (int)$argv[1] : 1233041;
$path = lorcana_cache_file($id);
if (!is_file($path)) {
    fwrite(STDERR, "No cache for event $id\n");
    exit(1);
}

// --- Legacy path (decode + encode + gzip) ---
$t0 = microtime(true);
$c = lorcana_read_cache($id);
$t1 = microtime(true);
$slim = lorcana_slim_event_payload($c['data']);
$t2 = microtime(true);
$meta = lorcana_cache_meta('HIT', $c['age'], lorcana_cache_ttl_seconds($slim), $c['mtime']);
$body = json_encode(lorcana_attach_cache_meta($slim, $meta), JSON_UNESCAPED_UNICODE);
$t3 = microtime(true);
$gz = function_exists('gzencode') ? gzencode($body, 6) : false;
$t4 = microtime(true);

// Ensure sidecars for fast path
lorcana_ensure_cache_sidecars($id, $c['raw'], $slim);

// --- Fast path (stat + meta + stream gz) ---
$t5 = microtime(true);
$stat = lorcana_stat_cache($id);
$sidecar = lorcana_read_cache_meta_sidecar($id);
$gzFresh = lorcana_cache_gz_is_fresh($id);
$t6 = microtime(true);
$gzPath = lorcana_cache_gz_file($id);
$gzSize = $gzFresh ? (int)filesize($gzPath) : 0;
// Simulate streaming cost: readfile into void
ob_start();
if ($gzFresh) {
    readfile($gzPath);
} else {
    readfile($path);
}
$streamed = ob_get_clean();
$t7 = microtime(true);

echo json_encode([
    'eventId' => $id,
    'rawBytes' => (int)filesize($path),
    'slimVersion' => (int)($sidecar['slimVersion'] ?? ($c['data']['_slimVersion'] ?? 0)),
    'legacyMs' => [
        'readDecode' => round(($t1 - $t0) * 1000, 1),
        'slim' => round(($t2 - $t1) * 1000, 1),
        'encode' => round(($t3 - $t2) * 1000, 1),
        'gzip' => round(($t4 - $t3) * 1000, 1),
        'total' => round(($t4 - $t0) * 1000, 1),
    ],
    'fastMs' => [
        'statMeta' => round(($t6 - $t5) * 1000, 1),
        'stream' => round(($t7 - $t6) * 1000, 1),
        'total' => round(($t7 - $t5) * 1000, 1),
        'gzFresh' => $gzFresh,
        'gzBytes' => $gzSize,
        'streamBytes' => strlen($streamed),
    ],
    'speedup' => round((($t4 - $t0) / max(0.0001, ($t7 - $t5))), 1) . 'x',
], JSON_PRETTY_PRINT) . "\n";
