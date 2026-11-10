<?php
/**
 * Strip PlayHub payloads to fields the UI / TIE engine actually use.
 * Drops profile pictures, nested user blobs, judge metadata, etc.
 * Preserves match outcomes, player ids, standings points & tiebreakers.
 */

if (!defined('LORCANA_PAYLOAD_SLIM_VERSION')) {
    define('LORCANA_PAYLOAD_SLIM_VERSION', 1);
}

function lorcana_slim_player_ref($player) {
    if ($player === null || $player === '') {
        return null;
    }
    if (is_int($player) || (is_string($player) && ctype_digit($player))) {
        return (int)$player;
    }
    if (!is_array($player)) {
        return null;
    }
    $id = $player['id'] ?? $player['player_id'] ?? $player['user_id'] ?? null;
    $name = $player['best_identifier'] ?? $player['name'] ?? null;
    if ($id === null && $name === null) {
        return null;
    }
    $out = [];
    if ($id !== null) {
        $out['id'] = is_numeric($id) ? (int)$id : $id;
    }
    if ($name !== null && $name !== '') {
        $out['best_identifier'] = (string)$name;
    }
    return $out;
}

function lorcana_slim_winning_player($winner) {
    if ($winner === null || $winner === '') {
        return null;
    }
    if (is_int($winner) || (is_string($winner) && ctype_digit((string)$winner))) {
        return (int)$winner;
    }
    if (is_array($winner) && isset($winner['id'])) {
        return is_numeric($winner['id']) ? (int)$winner['id'] : $winner['id'];
    }
    return null;
}

/**
 * Compact one match while keeping every field getMatchScores / pairings / OMWP need.
 */
function lorcana_slim_match(array $match) {
    $players = [];
    if (isset($match['players']) && is_array($match['players'])) {
        foreach ($match['players'] as $p) {
            if (is_int($p) || (is_string($p) && ctype_digit($p))) {
                $players[] = (int)$p;
            } else {
                $ref = lorcana_slim_player_ref(is_array($p) ? $p : null);
                if ($ref !== null) {
                    $players[] = $ref;
                }
            }
        }
    }

    $rels = [];
    if (isset($match['player_match_relationships']) && is_array($match['player_match_relationships'])) {
        foreach ($match['player_match_relationships'] as $rel) {
            if (!is_array($rel)) {
                continue;
            }
            // Prefer nested player.id (PlayHub user id) — UES id is a different namespace.
            $player = lorcana_slim_player_ref($rel['player'] ?? null);
            if ($player === null && isset($rel['user_event_status']) && is_array($rel['user_event_status'])) {
                $ues = $rel['user_event_status'];
                $nick = $ues['best_identifier'] ?? null;
                $pid = $ues['user']['id'] ?? $ues['id'] ?? null;
                if ($pid !== null || $nick) {
                    $player = [];
                    if ($pid !== null) {
                        $player['id'] = is_numeric($pid) ? (int)$pid : $pid;
                    }
                    if ($nick) {
                        $player['best_identifier'] = (string)$nick;
                    }
                }
            }
            if ($player === null) {
                continue;
            }
            $rels[] = ['player' => $player];
            if (count($players) < 2 && isset($player['id'])) {
                $players[] = $player['id'];
            }
        }
    }

    $out = [
        'id' => $match['id'] ?? null,
        'table_number' => $match['table_number'] ?? $match['tableNumber'] ?? null,
        'status' => $match['status'] ?? $match['state'] ?? null,
        'match_is_intentional_draw' => !empty($match['match_is_intentional_draw']),
        'match_is_unintentional_draw' => !empty($match['match_is_unintentional_draw']),
        'match_is_bye' => !empty($match['match_is_bye']) || !empty($match['is_bye']) || !empty($match['bye']),
        'games_won_by_winner' => $match['games_won_by_winner'] ?? null,
        'games_won_by_loser' => $match['games_won_by_loser'] ?? null,
        'winning_player' => lorcana_slim_winning_player($match['winning_player'] ?? $match['winner_id'] ?? $match['winner'] ?? null),
        'players' => $players,
    ];

    if (!empty($rels)) {
        $out['player_match_relationships'] = $rels;
    }

    // Optional aliases some older fixtures use
    if (isset($match['is_bye']) || isset($match['bye']) || isset($match['round_type'])) {
        $out['is_bye'] = !empty($match['is_bye']) || !empty($match['bye']) || (($match['round_type'] ?? '') === 'BYE');
        if (isset($match['round_type'])) {
            $out['round_type'] = $match['round_type'];
        }
    }

    return $out;
}

function lorcana_slim_matches_list($matches) {
    if (!is_array($matches)) {
        return [];
    }
    // Paginated wrapper
    if (isset($matches['results']) && is_array($matches['results'])) {
        $slimmed = [];
        foreach ($matches['results'] as $m) {
            if (is_array($m)) {
                $slimmed[] = lorcana_slim_match($m);
            }
        }
        return [
            'results' => $slimmed,
            'count' => count($slimmed),
            'next' => null,
            'previous' => null,
        ];
    }

    $out = [];
    foreach ($matches as $m) {
        if (is_array($m)) {
            $out[] = lorcana_slim_match($m);
        }
    }
    return $out;
}

function lorcana_slim_standing(array $row) {
    $player = lorcana_slim_player_ref($row['player'] ?? null);
    $uesIn = is_array($row['user_event_status'] ?? null) ? $row['user_event_status'] : [];
    $userIn = is_array($uesIn['user'] ?? null) ? $uesIn['user'] : [];

    $ues = [];
    if ($uesIn) {
        if (isset($uesIn['id'])) {
            $ues['id'] = is_numeric($uesIn['id']) ? (int)$uesIn['id'] : $uesIn['id'];
        }
        if (isset($uesIn['best_identifier'])) {
            $ues['best_identifier'] = (string)$uesIn['best_identifier'];
        }
        foreach (['matches_won', 'matches_lost', 'matches_drawn', 'total_match_points'] as $k) {
            if (isset($uesIn[$k])) {
                $ues[$k] = $uesIn[$k];
            }
        }
        if ($userIn) {
            $user = [];
            if (isset($userIn['id'])) {
                $user['id'] = is_numeric($userIn['id']) ? (int)$userIn['id'] : $userIn['id'];
            }
            $uname = $userIn['username'] ?? $userIn['best_identifier'] ?? null;
            if ($uname !== null && $uname !== '') {
                $user['best_identifier'] = (string)$uname;
                if (isset($userIn['username'])) {
                    $user['username'] = (string)$userIn['username'];
                }
            }
            if ($user) {
                $ues['user'] = $user;
            }
        }
    }

    $out = [
        'id' => $row['id'] ?? null,
        'rank' => $row['rank'] ?? null,
        'record' => $row['record'] ?? null,
        'match_record' => $row['match_record'] ?? null,
        'match_points' => $row['match_points'] ?? $row['points'] ?? 0,
        'opponent_match_win_percentage' => $row['opponent_match_win_percentage'] ?? null,
        'game_win_percentage' => $row['game_win_percentage'] ?? null,
        'opponent_game_win_percentage' => $row['opponent_game_win_percentage'] ?? null,
        'player' => $player,
    ];
    if ($ues) {
        $out['user_event_status'] = $ues;
    }
    if (isset($row['round_number'])) {
        $out['round_number'] = $row['round_number'];
    }
    return $out;
}

function lorcana_slim_standings($standings) {
    if (!is_array($standings)) {
        return null;
    }
    $list = $standings['standings'] ?? null;
    if (!is_array($list)) {
        // Already a bare list
        if (array_keys($standings) === range(0, count($standings) - 1)) {
            $slimmed = [];
            foreach ($standings as $row) {
                if (is_array($row)) {
                    $slimmed[] = lorcana_slim_standing($row);
                }
            }
            return ['standings' => $slimmed];
        }
        return $standings;
    }
    $slimmed = [];
    foreach ($list as $row) {
        if (is_array($row)) {
            $slimmed[] = lorcana_slim_standing($row);
        }
    }
    return ['standings' => $slimmed];
}

/**
 * Slim full event payload. Idempotent when _slimVersion matches.
 */
function lorcana_slim_event_payload(array $payload) {
    if ((int)($payload['_slimVersion'] ?? 0) === LORCANA_PAYLOAD_SLIM_VERSION) {
        return $payload;
    }

    if (isset($payload['standings'])) {
        $payload['standings'] = lorcana_slim_standings($payload['standings']);
    }

    $activeRound = (int)($payload['activeRound'] ?? 0);
    $roundsMatches = $payload['roundsMatches'] ?? null;
    if (is_array($roundsMatches)) {
        $slimRounds = [];
        foreach ($roundsMatches as $rNum => $rData) {
            if (!is_array($rData)) {
                continue;
            }
            $matches = $rData['matches'] ?? [];
            $slimRounds[$rNum] = [
                'round_number' => $rData['round_number'] ?? (is_numeric($rNum) ? (int)$rNum : $rNum),
                'round_id' => $rData['round_id'] ?? null,
                'status' => $rData['status'] ?? null,
                'matches' => lorcana_slim_matches_list($matches),
            ];
        }
        $payload['roundsMatches'] = $slimRounds;

        // Avoid duplicating the active-round match list under pairings.
        // Client reads pairings via getActivePairingsList() → roundsMatches[activeRound].
        if ($activeRound > 0 && isset($slimRounds[$activeRound])) {
            $activeMatches = $slimRounds[$activeRound]['matches'];
            $count = 0;
            if (is_array($activeMatches)) {
                if (isset($activeMatches['results']) && is_array($activeMatches['results'])) {
                    $count = count($activeMatches['results']);
                } else {
                    $count = count($activeMatches);
                }
            }
            $payload['pairings'] = [
                'sourceRound' => $activeRound,
                'count' => $count,
                'results' => [],
            ];
        } elseif (isset($payload['pairings'])) {
            $payload['pairings'] = lorcana_slim_matches_list($payload['pairings']);
        }
    } elseif (isset($payload['pairings'])) {
        $payload['pairings'] = lorcana_slim_matches_list($payload['pairings']);
    }

    $payload['_slimVersion'] = LORCANA_PAYLOAD_SLIM_VERSION;
    return $payload;
}
