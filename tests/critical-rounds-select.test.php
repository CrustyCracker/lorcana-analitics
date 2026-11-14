<?php
/**
 * critical rounds selector keeps active + standings only.
 */
error_reporting(E_ALL);
require_once dirname(__DIR__) . '/lib/playhub_fetch.php';

$toFetch = [];
for ($i = 1; $i <= 14; $i++) {
    $toFetch[$i] = 1000 + $i;
}

$all = lorcana_select_rounds_to_fetch($toFetch, 14, 1014, 'all', 13);
if (count($all) !== 14) {
    fwrite(STDERR, "all mode should keep 14, got " . count($all) . "\n");
    exit(1);
}

$crit = lorcana_select_rounds_to_fetch($toFetch, 14, 1014, 'critical', 13);
if (array_keys($crit) !== [13, 14]) {
    fwrite(STDERR, "critical expected [13,14] got " . json_encode(array_keys($crit)) . "\n");
    exit(1);
}
if ((int)$crit[14] !== 1014 || (int)$crit[13] !== 1013) {
    fwrite(STDERR, "critical ids mismatch\n");
    exit(1);
}

$fallback = lorcana_select_rounds_to_fetch($toFetch, 0, null, 'critical', 0);
if (array_keys($fallback) !== [14]) {
    fwrite(STDERR, "fallback expected max round 14\n");
    exit(1);
}

echo "critical-rounds-select OK\n";
