<?php
/**
 * Measure slim savings for a cache_*.json (or any event payload JSON).
 * Usage: php scripts/measure-slim.php cache_1233041.json
 */
require_once dirname(__DIR__) . '/lib/playhub_slim.php';

$path = $argv[1] ?? '';
if ($path === '' || !is_file($path)) {
    fwrite(STDERR, "Usage: php scripts/measure-slim.php <cache_or_payload.json>\n");
    exit(1);
}

$raw = file_get_contents($path);
$payload = json_decode($raw, true);
if (!is_array($payload)) {
    fwrite(STDERR, "Invalid JSON\n");
    exit(1);
}

// Force re-slim even if already marked
unset($payload['_slimVersion']);
$t0 = microtime(true);
$slim = lorcana_slim_event_payload($payload);
$ms = (microtime(true) - $t0) * 1000;
$out = json_encode($slim, JSON_UNESCAPED_UNICODE);
$gz = function_exists('gzencode') ? gzencode($out, 6) : null;

$rounds = 0;
$matches = 0;
foreach (($slim['roundsMatches'] ?? []) as $r) {
    $rounds++;
    $m = $r['matches'] ?? [];
    if (isset($m['results']) && is_array($m['results'])) {
        $matches += count($m['results']);
    } elseif (is_array($m)) {
        $matches += count($m);
    }
}

echo json_encode([
    'file' => basename($path),
    'beforeBytes' => strlen($raw),
    'afterBytes' => strlen($out),
    'ratioPct' => round(strlen($out) / max(1, strlen($raw)) * 100, 1),
    'gzipBytes' => $gz !== null ? strlen($gz) : null,
    'gzipRatioPct' => $gz !== null ? round(strlen($gz) / max(1, strlen($out)) * 100, 1) : null,
    'slimMs' => round($ms, 1),
    'playerCount' => $slim['playerCount'] ?? null,
    'standings' => count($slim['standings']['standings'] ?? []),
    'rounds' => $rounds,
    'matches' => $matches,
    'slimVersion' => $slim['_slimVersion'] ?? null,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . PHP_EOL;
