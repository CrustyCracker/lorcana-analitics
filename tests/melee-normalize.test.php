<?php
/**
 * Melee → PlayHub-shape normalizer unit checks.
 * Run: php tests/melee-normalize.test.php
 */
require_once dirname(__DIR__) . '/lib/melee_fetch.php';
require_once dirname(__DIR__) . '/lib/site_config.php';

function assert_true($cond, $msg) {
    if (!$cond) {
        fwrite(STDERR, "FAIL: $msg\n");
        exit(1);
    }
    echo "ok - $msg\n";
}

assert_true(melee_parse_tournament_id('496782') === 496782, 'bare id');
assert_true(melee_parse_tournament_id('https://melee.gg/Tournament/View/496782') === 496782, 'view url');
assert_true(melee_parse_tournament_id('https://www.melee.gg/Tournament/View/496782?x=1') === 496782, 'www url');
assert_true(lorcana_normalize_data_source('Melee.gg') === 'melee', 'source melee');
assert_true(lorcana_normalize_data_source('playhub') === 'playhub', 'source playhub');

$standing = melee_normalize_standing_row([
    'Team' => [
        'Players' => [[
            'ID' => 42,
            'Username' => 'Arkan',
            'DisplayName' => 'Arkan',
        ]],
        'ID' => 99,
    ],
    'TeamId' => 99,
    'ID' => 887,
    'Rank' => 7,
    'Points' => 6,
    'MatchWins' => 2,
    'MatchLosses' => 2,
    'MatchDraws' => 0,
    'MatchRecord' => '2-2-0',
    'OpponentMatchWinPercentage' => 0.5,
    'TeamGameWinPercentage' => 0.55,
    'OpponentGameWinPercentage' => 0.48,
    'RoundNumber' => 4,
]);
assert_true((int)$standing['match_points'] === 6, 'standing points');
assert_true((int)$standing['player']['id'] === 42, 'standing player id');
assert_true($standing['player']['best_identifier'] === 'Arkan', 'standing name');
assert_true((int)$standing['user_event_status']['matches_won'] === 2, 'ues wins');

$match = melee_normalize_match_row([
    'Guid' => 'abc',
    'TableNumber' => 2,
    'HasResult' => true,
    'ResultString' => 'Zabson won 2-1-0',
    'ByeReason' => null,
    'Competitors' => [
        [
            'Team' => ['Players' => [['ID' => 1, 'Username' => 'Zabson', 'DisplayName' => 'Zabson']]],
            'GameWins' => 2,
        ],
        [
            'Team' => ['Players' => [['ID' => 2, 'Username' => 'Czeresnia', 'DisplayName' => 'Czeresnia']]],
            'GameWins' => 1,
        ],
    ],
]);
assert_true((int)$match['winning_player'] === 1, 'winner from ResultString');
assert_true((int)$match['games_won_by_winner'] === 2, 'gw');
assert_true((int)$match['games_won_by_loser'] === 1, 'gl');
assert_true(count($match['players']) === 2, 'two players');
assert_true((int)$match['players'][0] === 1 && (int)$match['players'][1] === 2, 'players are bare ids');
assert_true((int)$match['team_1_game_wins'] === 2 && (int)$match['team_2_game_wins'] === 1, 'slot game wins');
assert_true($match['status'] === 'COMPLETE', 'complete status');
assert_true(is_array($match['player_match_relationships'][0]['player'] ?? null), 'rels keep name refs');

$draw = melee_normalize_match_row([
    'Guid' => 'd1',
    'HasResult' => true,
    'ResultString' => '0-0-3 draw',
    'Competitors' => [
        ['Team' => ['Players' => [['ID' => 3, 'Username' => 'A']]], 'GameWins' => 0],
        ['Team' => ['Players' => [['ID' => 4, 'Username' => 'B']]], 'GameWins' => 0],
    ],
]);
assert_true($draw['match_is_intentional_draw'] === true, 'draw flag');
assert_true($draw['winning_player'] === null, 'draw no winner');

$bye = melee_normalize_match_row([
    'Guid' => 'b1',
    'HasResult' => true,
    'ResultString' => 'Milqm was assigned a bye',
    'ByeReason' => 0,
    'Competitors' => [
        ['Team' => ['Players' => [['ID' => 9, 'Username' => 'Milqm']]], 'GameWins' => null],
    ],
]);
assert_true($bye['match_is_bye'] === true, 'bye from ByeReason=0');
assert_true((int)$bye['winning_player'] === 9, 'bye winner');
assert_true((int)$bye['games_won_by_winner'] === 2, 'bye default score');
assert_true((int)$bye['players'][0] === 9, 'bye player id');

// Slim must keep players[] as ids even if a legacy object slipped in.
require_once dirname(__DIR__) . '/lib/playhub_slim.php';
$slimmed = lorcana_slim_match([
    'status' => 'COMPLETE',
    'games_won_by_winner' => 2,
    'games_won_by_loser' => 1,
    'winning_player' => 1,
    'players' => [
        ['id' => 1, 'best_identifier' => 'Zabson'],
        ['id' => 2, 'best_identifier' => 'Czeresnia'],
    ],
    'player_match_relationships' => [
        ['player' => ['id' => 1, 'best_identifier' => 'Zabson']],
        ['player' => ['id' => 2, 'best_identifier' => 'Czeresnia']],
    ],
]);
assert_true((int)$slimmed['players'][0] === 1 && (int)$slimmed['players'][1] === 2, 'slim coerces player objects to ids');

$slot = lorcana_normalize_tournament_slot([
    'id' => 't_melee',
    'eventId' => 0,
    'name' => 'Night City',
    'mode' => 'MAIN1',
    'source' => 'melee',
    'meleeUrl' => 'https://melee.gg/Tournament/View/496782',
    'cutSize' => 8,
    'cutRule' => 'soft',
], 1);
assert_true((int)$slot['eventId'] === 496782, 'slot parses melee url id');
assert_true($slot['source'] === 'melee', 'slot source');
assert_true($slot['mode'] === 'custom', 'MAIN1 coerced away on melee');
assert_true($slot['cutRule'] === 'hard', 'soft coerced to hard on melee');

echo "ALL PASS\n";
