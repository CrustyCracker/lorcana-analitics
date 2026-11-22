<?php
/**
 * Strip PlayHub payloads to fields the UI / TIE engine actually use.
 * Drops profile pictures, nested user blobs, judge metadata, etc.
 * Preserves match outcomes, player ids, standings points & tiebreakers.
 */

if (!defined('LORCANA_PAYLOAD_SLIM_VERSION')) {
    // v2: keep compact ink pairings (deck_descriptor_label → inks[]) without signed image URLs.
    define('LORCANA_PAYLOAD_SLIM_VERSION', 2);
}

/**
 * Compact PlayHub deck_descriptor_label into [{key,name,hex}, ...] (max 2 inks).
 * Drops signed GCS symbol image URLs that inflate ink-pairing events (~2.5MB/round).
 *
 * @param mixed $ddl
 * @return array<int, array{key:string,name:string,hex:?string}>|null
 */
function lorcana_slim_deck_descriptor($ddl) {
    if (!is_array($ddl)) {
        return null;
    }

    $inks = [];
    $seen = [];

    $push = function ($key, $name = null, $hex = null) use (&$inks, &$seen) {
        $key = strtolower(trim((string)$key));
        if ($key === '' || isset($seen[$key])) {
            return;
        }
        $seen[$key] = true;
        $display = trim((string)($name ?? ''));
        if ($display === '') {
            $display = ucfirst($key);
        }
        $hexOut = null;
        if (is_string($hex) && preg_match('/^#?[0-9A-Fa-f]{6}$/', $hex)) {
            $hexOut = str_starts_with($hex, '#') ? $hex : ('#' . $hex);
        }
        $inks[] = [
            'key' => $key,
            'name' => $display,
            'hex' => $hexOut,
        ];
    };

    $parts = $ddl['parts'] ?? null;
    if (is_array($parts)) {
        foreach ($parts as $part) {
            if (!is_array($part)) {
                continue;
            }
            $symbols = $part['symbols'] ?? null;
            if (is_array($symbols) && count($symbols) > 0) {
                foreach ($symbols as $sym) {
                    if (!is_array($sym)) {
                        continue;
                    }
                    $push(
                        $sym['symbol_key'] ?? $sym['name'] ?? '',
                        $sym['name'] ?? null,
                        $sym['hex_code'] ?? $sym['hex'] ?? null
                    );
                }
                continue;
            }
            $value = $part['value'] ?? $part['display'] ?? '';
            if (is_string($value) && $value !== '') {
                foreach (preg_split('/\s*,\s*/', $value) as $piece) {
                    $push($piece);
                }
            }
        }
    }

    if (!$inks && !empty($ddl['label']) && is_string($ddl['label'])) {
        foreach (preg_split('/\s*,\s*/', $ddl['label']) as $piece) {
            $push($piece);
        }
    }

    if (!$inks) {
        return null;
    }
    return array_slice($inks, 0, 2);
}

function lorcana_slim_player_ref($player, $inks = null) {
    if ($player === null || $player === '') {
        return null;
    }
    if (is_int($player) || (is_string($player) && ctype_digit($player))) {
        $idOnly = (int)$player;
        if (is_array($inks) && $inks) {
            return ['id' => $idOnly, 'inks' => $inks];
        }
        return $idOnly;
    }
    if (!is_array($player)) {
        return null;
    }
    $id = $player['id'] ?? $player['player_id'] ?? $player['user_id'] ?? null;
    $name = $player['best_identifier'] ?? $player['name'] ?? null;
    if ($id === null && $name === null && !(is_array($inks) && $inks)) {
        return null;
    }
    $out = [];
    if ($id !== null) {
        $out['id'] = is_numeric($id) ? (int)$id : $id;
    }
    if ($name !== null && $name !== '') {
        $out['best_identifier'] = (string)$name;
    }
    $existingInks = is_array($player['inks'] ?? null) ? $player['inks'] : null;
    $useInks = is_array($inks) && $inks ? $inks : $existingInks;
    if (is_array($useInks) && $useInks) {
        $out['inks'] = array_slice($useInks, 0, 2);
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
    // Always keep players[] as bare ids (PlayHub + Melee). Object refs belong in
    // player_match_relationships — otherwise getMatchScores compares "[object Object]".
    $players = [];
    if (isset($match['players']) && is_array($match['players'])) {
        foreach ($match['players'] as $p) {
            if (is_int($p) || (is_string($p) && ctype_digit($p))) {
                $players[] = (int)$p;
            } elseif (is_array($p) && isset($p['id']) && (is_int($p['id']) || (is_string($p['id']) && ctype_digit((string)$p['id'])))) {
                $players[] = (int)$p['id'];
            }
        }
    }

    $rels = [];
    if (isset($match['player_match_relationships']) && is_array($match['player_match_relationships'])) {
        foreach ($match['player_match_relationships'] as $rel) {
            if (!is_array($rel)) {
                continue;
            }
            $ues = is_array($rel['user_event_status'] ?? null) ? $rel['user_event_status'] : [];
            $inks = lorcana_slim_deck_descriptor($ues['deck_descriptor_label'] ?? null);
            if ($inks === null && is_array($rel['player']['inks'] ?? null)) {
                $inks = array_slice($rel['player']['inks'], 0, 2);
            }
            // Prefer nested player.id (PlayHub user id) — UES id is a different namespace.
            $player = lorcana_slim_player_ref($rel['player'] ?? null, $inks);
            if ($player === null && $ues) {
                $nick = $ues['best_identifier'] ?? null;
                $pid = $ues['user']['id'] ?? null;
                if ($pid !== null || $nick || $inks) {
                    $player = [];
                    if ($pid !== null) {
                        $player['id'] = is_numeric($pid) ? (int)$pid : $pid;
                    }
                    if ($nick) {
                        $player['best_identifier'] = (string)$nick;
                    }
                    if ($inks) {
                        $player['inks'] = $inks;
                    }
                }
            }
            if ($player === null) {
                continue;
            }
            $rels[] = ['player' => $player];
            if (count($players) < 2 && isset($player['id'])) {
                $pid = is_numeric($player['id']) ? (int)$player['id'] : $player['id'];
                // Avoid bye duplicates when players[] already has the sole competitor.
                if (!in_array($pid, $players, true)) {
                    $players[] = $pid;
                }
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

function lorcana_slim_standing(array $row, $inks = null) {
    $rowInks = is_array($row['inks'] ?? null) ? $row['inks'] : null;
    $uesIn = is_array($row['user_event_status'] ?? null) ? $row['user_event_status'] : [];
    $uesInks = is_array($uesIn['inks'] ?? null) ? $uesIn['inks'] : null;
    $ddlInks = lorcana_slim_deck_descriptor($uesIn['deck_descriptor_label'] ?? null);
    $useInks = null;
    foreach ([$inks, $rowInks, $uesInks, $ddlInks] as $candidate) {
        if (is_array($candidate) && $candidate) {
            $useInks = array_slice($candidate, 0, 2);
            break;
        }
    }

    $player = lorcana_slim_player_ref($row['player'] ?? null, $useInks);
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
        if ($useInks) {
            $ues['inks'] = $useInks;
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
    if ($useInks) {
        $out['inks'] = $useInks;
    }
    if (isset($row['round_number'])) {
        $out['round_number'] = $row['round_number'];
    }
    return $out;
}

/**
 * Normalize compact ink list (max 2) for durable cache / standings.
 *
 * @param mixed $inks
 * @return array<int, array{key:string,name:string,hex:?string}>
 */
function lorcana_normalize_compact_inks($inks) {
    if (!is_array($inks)) {
        return [];
    }
    $out = [];
    foreach ($inks as $ink) {
        if (count($out) >= 2) {
            break;
        }
        if (!is_array($ink)) {
            continue;
        }
        $key = strtolower(trim((string)($ink['key'] ?? $ink['name'] ?? '')));
        $name = trim((string)($ink['name'] ?? $ink['key'] ?? ''));
        if ($key === '' && $name === '') {
            continue;
        }
        $hex = null;
        $rawHex = $ink['hex'] ?? $ink['hex_code'] ?? null;
        if (is_string($rawHex) && preg_match('/^#?[0-9A-Fa-f]{6}$/', $rawHex)) {
            $hex = str_starts_with($rawHex, '#') ? $rawHex : ('#' . $rawHex);
        }
        $out[] = [
            'key' => $key !== '' ? $key : strtolower($name),
            'name' => $name !== '' ? $name : $key,
            'hex' => $hex,
        ];
    }
    return $out;
}

/**
 * Read durable player-inks sidecar (never drops known pairings across refreshes).
 *
 * @return array<string, array<int, array{key:string,name:string,hex:?string}>>
 */
function lorcana_read_player_inks_cache($eventId) {
    $path = function_exists('lorcana_inks_cache_file')
        ? lorcana_inks_cache_file($eventId)
        : (dirname(__DIR__) . '/cache_' . (int)$eventId . '.inks.json');
    if (!is_file($path)) {
        return [];
    }
    $raw = (string)@file_get_contents($path);
    $data = $raw !== '' ? json_decode($raw, true) : null;
    if (!is_array($data)) {
        return [];
    }
    $map = [];
    foreach ($data as $pid => $inks) {
        $n = lorcana_normalize_compact_inks($inks);
        if ($n) {
            $map[(string)$pid] = $n;
        }
    }
    return $map;
}

/**
 * Merge incoming inks into durable sidecar. Never removes previously known players.
 *
 * @param array<string, mixed> $incoming
 * @return array<string, array<int, array{key:string,name:string,hex:?string}>>
 */
function lorcana_merge_player_inks_cache($eventId, array $incoming) {
    $map = lorcana_read_player_inks_cache($eventId);
    $changed = false;
    foreach ($incoming as $pid => $inks) {
        $n = lorcana_normalize_compact_inks($inks);
        if (!$n) {
            continue;
        }
        $key = (string)$pid;
        if ($key === '') {
            continue;
        }
        $prev = $map[$key] ?? null;
        if ($prev !== $n) {
            $map[$key] = $n;
            $changed = true;
        }
    }
    // Do not create an empty cache_{id}.inks.json for old tournaments with zero inks.
    if ($changed) {
        $path = function_exists('lorcana_inks_cache_file')
            ? lorcana_inks_cache_file($eventId)
            : (dirname(__DIR__) . '/cache_' . (int)$eventId . '.inks.json');
        if (function_exists('lorcana_atomic_write_json')) {
            lorcana_atomic_write_json($path, $map);
        } else {
            @file_put_contents($path, json_encode($map, JSON_UNESCAPED_UNICODE), LOCK_EX);
        }
    }
    return $map;
}

function lorcana_player_inks_cache_count($eventId) {
    return count(lorcana_read_player_inks_cache($eventId));
}

/**
 * Harvest compact inks already attached to standings rows.
 *
 * @param mixed $standings
 * @return array<string, array<int, array{key:string,name:string,hex:?string}>>
 */
function lorcana_collect_inks_from_standings($standings) {
    $map = [];
    if (!is_array($standings)) {
        return $map;
    }
    $rows = isset($standings['standings']) && is_array($standings['standings'])
        ? $standings['standings']
        : $standings;
    if (!is_array($rows)) {
        return $map;
    }
    foreach ($rows as $row) {
        if (!is_array($row)) {
            continue;
        }
        $inks = null;
        foreach ([
            $row['inks'] ?? null,
            $row['user_event_status']['inks'] ?? null,
            $row['player']['inks'] ?? null,
        ] as $candidate) {
            $n = lorcana_normalize_compact_inks($candidate);
            if ($n) {
                $inks = $n;
                break;
            }
        }
        if (!$inks) {
            $ddl = $row['user_event_status']['deck_descriptor_label'] ?? null;
            $fromDdl = lorcana_slim_deck_descriptor($ddl);
            if (is_array($fromDdl) && $fromDdl) {
                $inks = lorcana_normalize_compact_inks($fromDdl);
            }
        }
        if (!$inks) {
            continue;
        }
        $ids = [];
        if (isset($row['player']['id'])) {
            $ids[] = (string)$row['player']['id'];
        }
        if (isset($row['user_event_status']['user']['id'])) {
            $ids[] = (string)$row['user_event_status']['user']['id'];
        }
        if (isset($row['id'])) {
            $ids[] = (string)$row['id'];
        }
        foreach ($ids as $id) {
            if ($id !== '') {
                $map[$id] = $inks;
            }
        }
    }
    return $map;
}

/**
 * Count standings rows that already carry compact inks (for rewrite decisions).
 */
function lorcana_count_standings_with_inks($standings) {
    if (!is_array($standings)) {
        return 0;
    }
    $rows = isset($standings['standings']) && is_array($standings['standings'])
        ? $standings['standings']
        : $standings;
    if (!is_array($rows)) {
        return 0;
    }
    $n = 0;
    foreach ($rows as $row) {
        if (!is_array($row)) {
            continue;
        }
        if (lorcana_normalize_compact_inks($row['inks'] ?? null)
            || lorcana_normalize_compact_inks($row['user_event_status']['inks'] ?? null)
            || lorcana_normalize_compact_inks($row['player']['inks'] ?? null)) {
            $n++;
        }
    }
    return $n;
}

/**
 * Merge payload harvest + durable sidecar, apply onto standings, persist sidecar.
 * Safe to call on every serve/slim — never drops known player inks.
 *
 * @param array $payload
 * @return array
 */
function lorcana_apply_durable_player_inks(array $payload) {
    $eventId = (int)($payload['eventId'] ?? 0);
    if ($eventId <= 0) {
        return $payload;
    }

    $incoming = [];
    $fromRounds = lorcana_collect_player_inks($payload['roundsMatches'] ?? null);
    foreach ($fromRounds as $pid => $inks) {
        $incoming[$pid] = $inks;
    }
    if (isset($payload['pairings'])) {
        $fromPairings = lorcana_collect_player_inks(['pairings' => ['matches' => $payload['pairings']]]);
        foreach ($fromPairings as $pid => $inks) {
            $incoming[$pid] = $inks;
        }
    }
    $fromStandings = lorcana_collect_inks_from_standings($payload['standings'] ?? null);
    foreach ($fromStandings as $pid => $inks) {
        // Prefer match/pairing harvest when both present; standings fill gaps.
        if (!isset($incoming[$pid])) {
            $incoming[$pid] = $inks;
        }
    }

    $merged = lorcana_merge_player_inks_cache($eventId, $incoming);
    if ($merged) {
        if (isset($payload['standings'])) {
            $payload['standings'] = lorcana_apply_inks_to_standings($payload['standings'], $merged);
        }
        $payload['hasInkPairings'] = true;
    } else {
        // Zero harvest + empty/missing sidecar → old PlayHub format (or never supported).
        $payload['hasInkPairings'] = false;
    }
    $payload['playerInksCached'] = count($merged);
    return $payload;
}

/**
 * Harvest compact inks from slimmed (or raw) match lists → playerId => inks[].
 *
 * @param mixed $roundsMatches
 * @return array<string, array<int, array{key:string,name:string,hex:?string}>>
 */
function lorcana_collect_player_inks($roundsMatches) {
    $map = [];
    if (!is_array($roundsMatches)) {
        return $map;
    }

    $ingestMatch = function ($match) use (&$map) {
        if (!is_array($match)) {
            return;
        }
        $rels = $match['player_match_relationships'] ?? null;
        if (is_array($rels)) {
            foreach ($rels as $rel) {
                if (!is_array($rel)) {
                    continue;
                }
                $player = $rel['player'] ?? null;
                $inks = null;
                if (is_array($player) && is_array($player['inks'] ?? null)) {
                    $inks = $player['inks'];
                }
                if ($inks === null) {
                    $ues = is_array($rel['user_event_status'] ?? null) ? $rel['user_event_status'] : [];
                    $inks = lorcana_slim_deck_descriptor($ues['deck_descriptor_label'] ?? null);
                }
                if (!is_array($inks) || !$inks) {
                    continue;
                }
                $pid = null;
                if (is_array($player) && isset($player['id'])) {
                    $pid = $player['id'];
                } elseif (is_int($player) || (is_string($player) && ctype_digit($player))) {
                    $pid = $player;
                }
                if ($pid === null) {
                    continue;
                }
                $map[(string)$pid] = array_slice($inks, 0, 2);
            }
        }
        // Also accept already-slimmed players[] objects that carry inks.
        if (isset($match['players']) && is_array($match['players'])) {
            foreach ($match['players'] as $p) {
                if (!is_array($p) || !isset($p['id']) || !is_array($p['inks'] ?? null)) {
                    continue;
                }
                $map[(string)$p['id']] = array_slice($p['inks'], 0, 2);
            }
        }
    };

    foreach ($roundsMatches as $rData) {
        if (!is_array($rData)) {
            continue;
        }
        // roundsMatches[n].matches or a bare match list / pairings wrapper
        $matches = $rData['matches'] ?? $rData;
        if (isset($matches['results']) && is_array($matches['results'])) {
            $matches = $matches['results'];
        }
        if (!is_array($matches)) {
            continue;
        }
        // Guard: associative meta wrapper without numeric match rows
        $isList = array_keys($matches) === range(0, count($matches) - 1);
        if (!$isList && !isset($rData['matches'])) {
            continue;
        }
        foreach ($matches as $m) {
            $ingestMatch($m);
        }
    }

    return $map;
}

/**
 * Attach harvested inks onto standings rows (top-level + UES + player).
 *
 * @param mixed $standings
 * @param array $inkMap
 * @return mixed
 */
function lorcana_apply_inks_to_standings($standings, array $inkMap) {
    if (!is_array($standings) || !$inkMap) {
        return $standings;
    }

    $applyRow = function (array $row) use ($inkMap) {
        if (is_array($row['inks'] ?? null) && $row['inks']) {
            return $row;
        }
        $ids = [];
        if (isset($row['player']['id'])) {
            $ids[] = (string)$row['player']['id'];
        }
        if (isset($row['user_event_status']['user']['id'])) {
            $ids[] = (string)$row['user_event_status']['user']['id'];
        }
        if (isset($row['id'])) {
            $ids[] = (string)$row['id'];
        }
        $inks = null;
        foreach ($ids as $id) {
            if (isset($inkMap[$id])) {
                $inks = $inkMap[$id];
                break;
            }
        }
        if (!$inks) {
            return $row;
        }
        $row['inks'] = $inks;
        if (isset($row['player']) && is_array($row['player'])) {
            $row['player']['inks'] = $inks;
        }
        if (isset($row['user_event_status']) && is_array($row['user_event_status'])) {
            $row['user_event_status']['inks'] = $inks;
        }
        return $row;
    };

    if (isset($standings['standings']) && is_array($standings['standings'])) {
        foreach ($standings['standings'] as $i => $row) {
            if (is_array($row)) {
                $standings['standings'][$i] = $applyRow($row);
            }
        }
        return $standings;
    }

    if (array_keys($standings) === range(0, count($standings) - 1)) {
        foreach ($standings as $i => $row) {
            if (is_array($row)) {
                $standings[$i] = $applyRow($row);
            }
        }
    }
    return $standings;
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
 * Always re-applies durable host ink cache so critical-mode refreshes keep
 * previously seen pairings on standings (and meta).
 */
function lorcana_slim_event_payload(array $payload) {
    $alreadySlim = (int)($payload['_slimVersion'] ?? 0) === LORCANA_PAYLOAD_SLIM_VERSION;

    if (!$alreadySlim) {
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

        if (isset($payload['standings'])) {
            $payload['standings'] = lorcana_slim_standings($payload['standings']);
        }

        $payload['_slimVersion'] = LORCANA_PAYLOAD_SLIM_VERSION;
    }

    // Harvest current payload + merge durable host sidecar onto standings.
    $beforeInks = lorcana_count_standings_with_inks($payload['standings'] ?? null);
    $payload = lorcana_apply_durable_player_inks($payload);

    if (!empty($payload['hasInkPairings']) || !empty($payload['playerInksCached'])) {
        // Inks live on standings for UI; strip duplicates from match player refs to shrink wire.
        if (isset($payload['roundsMatches']) && is_array($payload['roundsMatches'])) {
            $payload['roundsMatches'] = lorcana_strip_match_player_inks($payload['roundsMatches']);
        }
    }

    $afterInks = lorcana_count_standings_with_inks($payload['standings'] ?? null);
    if ($afterInks > $beforeInks) {
        $payload['_inksEnriched'] = true;
    }

    return $payload;
}

/**
 * Remove player.inks from slimmed match relationships after harvest to standings.
 *
 * @param array $roundsMatches
 * @return array
 */
function lorcana_strip_match_player_inks(array $roundsMatches) {
    foreach ($roundsMatches as $rNum => $rData) {
        if (!is_array($rData)) {
            continue;
        }
        $matches = $rData['matches'] ?? null;
        if (!is_array($matches)) {
            continue;
        }
        $list = isset($matches['results']) && is_array($matches['results']) ? $matches['results'] : $matches;
        if (!is_array($list)) {
            continue;
        }
        foreach ($list as $i => $m) {
            if (!is_array($m)) {
                continue;
            }
            if (isset($m['player_match_relationships']) && is_array($m['player_match_relationships'])) {
                foreach ($m['player_match_relationships'] as $j => $rel) {
                    if (isset($rel['player']['inks'])) {
                        unset($list[$i]['player_match_relationships'][$j]['player']['inks']);
                    }
                }
            }
            if (isset($m['players']) && is_array($m['players'])) {
                foreach ($m['players'] as $j => $p) {
                    if (is_array($p) && isset($p['inks'])) {
                        unset($list[$i]['players'][$j]['inks']);
                    }
                }
            }
        }
        if (isset($matches['results'])) {
            $roundsMatches[$rNum]['matches']['results'] = $list;
        } else {
            $roundsMatches[$rNum]['matches'] = $list;
        }
    }
    return $roundsMatches;
}
