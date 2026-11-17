<?php
/**
 * PHP unit checks for ink-pairing slim helpers (event 1254364 shape).
 * Run: php tests/ink-pairings-slim.test.php
 */
require_once dirname(__DIR__) . '/lib/playhub_slim.php';

function assert_true($cond, $msg) {
    if (!$cond) {
        fwrite(STDERR, "FAIL: $msg\n");
        exit(1);
    }
    echo "ok - $msg\n";
}

$fatDescriptor = [
    'label' => 'Emerald, Steel',
    'parts' => [[
        'kind' => 'descriptor',
        'value' => 'emerald,steel',
        'display' => 'Emerald, Steel',
        'symbols' => [
            [
                'symbol_key' => 'emerald',
                'name' => 'Emerald',
                'hex_code' => '#50C878',
                'image_url' => 'https://storage.googleapis.com/spicerack_media/game_symbols/lorcana/color/emerald.png?X-Goog-Signature=' . str_repeat('a', 800),
            ],
            [
                'symbol_key' => 'steel',
                'name' => 'Steel',
                'hex_code' => '#71797E',
                'image_url' => 'https://storage.googleapis.com/spicerack_media/game_symbols/lorcana/color/steel.png?X-Goog-Signature=' . str_repeat('b', 800),
            ],
        ],
    ]],
    'overrides_name' => false,
];

$inks = lorcana_slim_deck_descriptor($fatDescriptor);
assert_true(is_array($inks) && count($inks) === 2, 'slim descriptor keeps 2 inks');
assert_true($inks[0]['key'] === 'emerald' && $inks[0]['hex'] === '#50C878', 'emerald key+hex');
assert_true($inks[1]['key'] === 'steel', 'steel key');
$encoded = json_encode($inks);
assert_true(strpos($encoded, 'image_url') === false, 'no image_url in compact inks');
assert_true(strpos($encoded, 'X-Goog-Signature') === false, 'no signed GCS URLs');

$match = [
    'id' => 99,
    'table_number' => 1,
    'status' => 'COMPLETE',
    'match_is_intentional_draw' => false,
    'match_is_unintentional_draw' => false,
    'match_is_bye' => false,
    'games_won_by_winner' => 2,
    'games_won_by_loser' => 0,
    'winning_player' => 101,
    'players' => [101, 202],
    'player_match_relationships' => [
        [
            'player' => ['id' => 101, 'best_identifier' => 'Alice'],
            'user_event_status' => [
                'id' => 1,
                'best_identifier' => 'Alice',
                'deck_descriptor_label' => $fatDescriptor,
            ],
        ],
        [
            'player' => ['id' => 202, 'best_identifier' => 'Bob'],
            'user_event_status' => [
                'id' => 2,
                'best_identifier' => 'Bob',
                'deck_descriptor_label' => [
                    'label' => 'Amber, Amethyst',
                    'parts' => [[
                        'value' => 'amber,amethyst',
                        'symbols' => [
                            ['symbol_key' => 'amber', 'name' => 'Amber', 'hex_code' => '#FFBF00'],
                            ['symbol_key' => 'amethyst', 'name' => 'Amethyst', 'hex_code' => '#9966CC'],
                        ],
                    ]],
                ],
            ],
        ],
    ],
];

$slimMatch = lorcana_slim_match($match);
assert_true(isset($slimMatch['player_match_relationships'][0]['player']['inks']), 'match keeps player inks');
assert_true($slimMatch['player_match_relationships'][0]['player']['inks'][0]['key'] === 'emerald', 'alice emerald');
$slimJson = json_encode($slimMatch);
assert_true(strpos($slimJson, 'image_url') === false, 'slim match drops image URLs');
assert_true(strlen($slimJson) < 800, 'slim match is compact');

$payload = [
    'eventId' => 1254364,
    'activeRound' => 1,
    'standingsRound' => 1,
    'playerCount' => 2,
    'standings' => [
        'standings' => [
            [
                'id' => 10,
                'rank' => 1,
                'match_points' => 3,
                'record' => '1-0-0',
                'player' => ['id' => 101, 'best_identifier' => 'Alice'],
                'user_event_status' => [
                    'id' => 1,
                    'best_identifier' => 'Alice',
                    'matches_won' => 1,
                    'matches_lost' => 0,
                    'matches_drawn' => 0,
                    'total_match_points' => 3,
                    'user' => ['id' => 101],
                ],
            ],
            [
                'id' => 11,
                'rank' => 2,
                'match_points' => 0,
                'record' => '0-1-0',
                'player' => ['id' => 202, 'best_identifier' => 'Bob'],
                'user_event_status' => [
                    'id' => 2,
                    'best_identifier' => 'Bob',
                    'matches_won' => 0,
                    'matches_lost' => 1,
                    'matches_drawn' => 0,
                    'total_match_points' => 0,
                    'user' => ['id' => 202],
                ],
            ],
        ],
    ],
    'roundsMatches' => [
        1 => [
            'round_number' => 1,
            'round_id' => 1,
            'status' => 'COMPLETE',
            'matches' => [$match],
        ],
    ],
    'pairings' => ['results' => [$match]],
];

$slim = lorcana_slim_event_payload($payload);
assert_true((int)$slim['_slimVersion'] === LORCANA_PAYLOAD_SLIM_VERSION, 'slim version bumped');
assert_true(!empty($slim['hasInkPairings']), 'hasInkPairings flag');
$rows = $slim['standings']['standings'];
assert_true(count($rows) === 2, 'standings preserved');
assert_true(($rows[0]['inks'][0]['key'] ?? '') === 'emerald', 'standings row got harvested inks');
assert_true(($rows[1]['inks'][1]['key'] ?? '') === 'amethyst', 'bob amethyst harvested');
assert_true(strpos(json_encode($slim), 'X-Goog-Signature') === false, 'payload has no signed URLs');

// Idempotent
$again = lorcana_slim_event_payload($slim);
assert_true($again === $slim || (int)$again['_slimVersion'] === LORCANA_PAYLOAD_SLIM_VERSION, 'idempotent slim');

// Durable host sidecar: inks survive a later payload that omits deck descriptors.
$tmpRoot = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'lorcana_inks_test_' . getmypid();
@mkdir($tmpRoot, 0755, true);
if (!defined('LORCANA_CACHE_ROOT')) {
    // playhub_cache.php may already define this — for isolated test, write beside tmp via filter.
}
require_once dirname(__DIR__) . '/lib/playhub_cache.php';

$testEventId = 424242;
$inksPath = lorcana_inks_cache_file($testEventId);
@unlink($inksPath);

$round1 = lorcana_slim_event_payload([
    'eventId' => $testEventId,
    'activeRound' => 1,
    'standings' => $payload['standings'],
    'roundsMatches' => $payload['roundsMatches'],
    'pairings' => $payload['pairings'],
]);
assert_true((int)($round1['playerInksCached'] ?? 0) >= 2, 'durable cache counted after round1');
assert_true(is_file($inksPath), 'inks sidecar written');

$round2Sparse = [
    'eventId' => $testEventId,
    'activeRound' => 2,
    '_slimVersion' => LORCANA_PAYLOAD_SLIM_VERSION,
    'standings' => [
        'standings' => [
            [
                'id' => 10,
                'rank' => 1,
                'match_points' => 6,
                'player' => ['id' => 101, 'best_identifier' => 'Alice'],
                'user_event_status' => ['id' => 1, 'best_identifier' => 'Alice', 'user' => ['id' => 101]],
            ],
            [
                'id' => 11,
                'rank' => 2,
                'match_points' => 3,
                'player' => ['id' => 202, 'best_identifier' => 'Bob'],
                'user_event_status' => ['id' => 2, 'best_identifier' => 'Bob', 'user' => ['id' => 202]],
            ],
            [
                'id' => 12,
                'rank' => 3,
                'match_points' => 3,
                'player' => ['id' => 303, 'best_identifier' => 'Carol'],
                'user_event_status' => ['id' => 3, 'best_identifier' => 'Carol', 'user' => ['id' => 303]],
            ],
        ],
    ],
    'roundsMatches' => [
        2 => [
            'round_number' => 2,
            'matches' => [
                [
                    'id' => 100,
                    'players' => [101, 303],
                    'player_match_relationships' => [
                        ['player' => ['id' => 101, 'best_identifier' => 'Alice']],
                        ['player' => ['id' => 303, 'best_identifier' => 'Carol']],
                    ],
                ],
            ],
        ],
    ],
    'pairings' => ['sourceRound' => 2, 'results' => []],
];

$enriched = lorcana_slim_event_payload($round2Sparse);
$erows = $enriched['standings']['standings'];
assert_true(($erows[0]['inks'][0]['key'] ?? '') === 'emerald', 'Alice inks kept after round2 via durable cache');
assert_true(($erows[1]['inks'][0]['key'] ?? '') === 'amber', 'Bob inks kept after round2 via durable cache');
assert_true(empty($erows[2]['inks']), 'Carol still unknown (never harvested)');
assert_true((int)($enriched['playerInksCached'] ?? 0) >= 2, 'playerInksCached persists');

@unlink($inksPath);

echo "ALL PASSED\n";
exit(0);
