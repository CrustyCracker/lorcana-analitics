<?php
/**
 * Melee.gg public tournament ingest → same slim payload shape as PlayHub.
 *
 * Uses the same DataTables AJAX endpoints the public tournament page hits
 * (no official Melee OAuth API key required for public standings/pairings):
 *   GET  /Tournament/View/{id}
 *   GET  /Standing/GetStandingsConfig/{id}
 *   POST /Standing/GetRoundStandings/{roundId}
 *   POST /Match/GetRoundMatches/{roundId}
 *
 * Scoring assumption (Cyberpunk / Melee Swiss, documented):
 *   Win = 3 match points, Draw = 1, Loss = 0.
 *   Tiebreakers: OMW → PGW/TMW → OGW (Melee defaults).
 *   We trust Melee's Points / MatchRecord / TB percentages; we do not recompute.
 */

require_once __DIR__ . '/playhub_slim.php';

if (!defined('MELEE_BASE_URL')) {
    define('MELEE_BASE_URL', 'https://melee.gg');
}

/**
 * Parse tournament id from a bare id or Melee URL.
 * @return int
 */
function melee_parse_tournament_id($raw) {
    if (is_int($raw)) {
        return $raw > 0 ? $raw : 0;
    }
    $s = trim((string)$raw);
    if ($s === '') {
        return 0;
    }
    if (preg_match('/Tournament\/(?:View|Control|Edit)\/(\d+)/i', $s, $m)) {
        return (int)$m[1];
    }
    if (preg_match('/[?&]id=(\d+)/i', $s, $m)) {
        return (int)$m[1];
    }
    if (preg_match('/^\d{1,9}$/', $s)) {
        return (int)$s;
    }
    return 0;
}

function melee_raise_fetch_time_limit($seconds = null) {
    if (function_exists('lorcana_raise_fetch_time_limit')) {
        lorcana_raise_fetch_time_limit($seconds);
        return;
    }
    $sec = $seconds === null ? 120 : (int)$seconds;
    if ($sec > 0) {
        @set_time_limit($sec);
    }
}

/**
 * @return array{ok:bool,code:int,body:string,error?:string}
 */
function melee_http_request($url, array $options = []) {
    $method = strtoupper((string)($options['method'] ?? 'GET'));
    $body = $options['body'] ?? null;
    $timeout = (int)($options['timeout'] ?? 45);
    $referer = (string)($options['referer'] ?? (MELEE_BASE_URL . '/'));

    $asAjax = !empty($options['ajax']);
    $headers = [
        'Accept-Language: en-US,en;q=0.9',
        'Referer: ' . $referer,
        'Origin: ' . MELEE_BASE_URL,
    ];
    if ($asAjax) {
        $headers[] = 'Accept: application/json, text/javascript, */*; q=0.01';
        $headers[] = 'X-Requested-With: XMLHttpRequest';
    } else {
        $headers[] = 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
    }
    if ($method === 'POST') {
        $headers[] = 'Content-Type: application/x-www-form-urlencoded; charset=UTF-8';
    }

    $ch = curl_init($url);
    if ($ch === false) {
        return ['ok' => false, 'code' => 0, 'body' => '', 'error' => 'curl_init failed'];
    }
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_ENCODING => '',
    ]);
    if ($method === 'POST') {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, is_string($body) ? $body : http_build_query($body ?: []));
    }
    $resp = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);

    if ($resp === false) {
        return ['ok' => false, 'code' => $code, 'body' => '', 'error' => $err ?: 'request failed'];
    }
    return ['ok' => $code >= 200 && $code < 300, 'code' => $code, 'body' => (string)$resp, 'error' => $err ?: null];
}

/**
 * DataTables POST body with named columns (required by GetRoundStandings).
 */
function melee_datatables_body(array $columns, $roundId = null, $start = 0, $length = 500) {
    $query = [
        'draw' => 1,
        'start' => (int)$start,
        'length' => (int)$length,
        'search' => ['value' => '', 'regex' => 'false'],
        'order' => [['column' => 0, 'dir' => 'asc']],
    ];
    if ($roundId !== null) {
        $query['roundId'] = (int)$roundId;
    }
    foreach (array_values($columns) as $i => $name) {
        $query['columns'][$i] = [
            'data' => $name,
            'name' => $name,
            'searchable' => 'true',
            'orderable' => 'true',
            'search' => ['value' => '', 'regex' => 'false'],
        ];
    }
    return http_build_query($query);
}

/**
 * @return list<array{id:int,number:int,name:string,started:bool,completed:bool}>
 */
function melee_parse_round_buttons($html, $containerId) {
    $rounds = [];
    if (!is_string($html) || $html === '') {
        return $rounds;
    }
    $pattern = '/id="' . preg_quote($containerId, '/') . '"[^>]*>([\s\S]*?)<\/div>/i';
    if (!preg_match($pattern, $html, $block)) {
        return $rounds;
    }
    if (!preg_match_all(
        '/<button[^>]*class="[^"]*round-selector[^"]*"[^>]*>/i',
        $block[1],
        $btns
    )) {
        return $rounds;
    }
    foreach ($btns[0] as $tag) {
        $id = 0;
        $name = '';
        $started = false;
        $completed = false;
        if (preg_match('/data-id="(\d+)"/i', $tag, $m)) {
            $id = (int)$m[1];
        }
        if (preg_match('/data-name="([^"]*)"/i', $tag, $m)) {
            $name = html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
        }
        if (preg_match('/data-is-started="([^"]*)"/i', $tag, $m)) {
            $started = strcasecmp($m[1], 'True') === 0;
        }
        if (preg_match('/data-is-completed="([^"]*)"/i', $tag, $m)) {
            $completed = strcasecmp($m[1], 'True') === 0;
        }
        if ($id <= 0) {
            continue;
        }
        $number = 0;
        if (preg_match('/Round\s+(\d+)/i', $name, $m)) {
            $number = (int)$m[1];
        } else {
            $number = count($rounds) + 1;
        }
        $rounds[] = [
            'id' => $id,
            'number' => $number,
            'name' => $name !== '' ? $name : ('Round ' . $number),
            'started' => $started || $completed,
            'completed' => $completed,
        ];
    }
    usort($rounds, static function ($a, $b) {
        return $a['number'] <=> $b['number'];
    });
    return $rounds;
}

function melee_parse_event_name($html) {
    if (preg_match('/<meta\s+property="og:title"\s+content="([^"]+)"/i', $html, $m)) {
        $t = html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $t = preg_replace('/\s*\|\s*Melee\s*$/i', '', $t);
        return trim($t);
    }
    if (preg_match('/<title>\s*([^<]+?)\s*<\/title>/i', $html, $m)) {
        $t = html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $t = preg_replace('/\s*\|\s*Melee\s*$/i', '', $t);
        return trim($t);
    }
    if (preg_match('/id="tournament-headline-name"[^>]*>\s*([^<]+)/i', $html, $m)) {
        return trim(html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }
    if (preg_match('/<h[12][^>]*>\s*([^<]+?)\s*<\/h[12]>/i', $html, $m)) {
        return trim(html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }
    return 'Melee Tournament';
}

function melee_parse_display_status($html) {
    if (preg_match('/\bEnded\b/i', $html)) {
        return 'completed';
    }
    if (preg_match('/\bIn\s*Progress\b/i', $html)) {
        return 'in_progress';
    }
    if (preg_match('/\bRegistration\b/i', $html)) {
        return 'registration';
    }
    return 'unknown';
}

function melee_parse_game_label($html) {
    if (preg_match('/Game:\s*([^<\n]+)/i', $html, $m)) {
        return trim(html_entity_decode(strip_tags($m[1]), ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    }
    return null;
}

/**
 * First player on a Melee Team object.
 * @return array{id:int,name:string}|null
 */
function melee_team_primary_player($team) {
    if (!is_array($team)) {
        return null;
    }
    $players = $team['Players'] ?? $team['players'] ?? null;
    if (!is_array($players) || !$players) {
        return null;
    }
    $p = $players[0];
    if (!is_array($p)) {
        return null;
    }
    $id = $p['ID'] ?? $p['Id'] ?? $p['id'] ?? null;
    if ($id === null) {
        return null;
    }
    $name = $p['Username'] ?? $p['DisplayName'] ?? $p['ScreenName'] ?? ('Player ' . $id);
    return ['id' => (int)$id, 'name' => (string)$name];
}

/**
 * Map one Melee standings row → PlayHub-slim standing.
 */
function melee_normalize_standing_row(array $row) {
    $player = melee_team_primary_player($row['Team'] ?? null);
    $pid = $player['id'] ?? (int)($row['TeamId'] ?? 0);
    $pname = $player['name'] ?? ('Player ' . $pid);

    $wins = (int)($row['MatchWins'] ?? 0);
    $losses = (int)($row['MatchLosses'] ?? 0);
    $draws = (int)($row['MatchDraws'] ?? 0);
    $points = (int)($row['Points'] ?? (($wins * 3) + $draws));
    $record = (string)($row['MatchRecord'] ?? ($wins . '-' . $losses . '-' . $draws));

    $playerRef = [
        'id' => $pid,
        'best_identifier' => $pname,
    ];

    return [
        'id' => $row['ID'] ?? $pid,
        'rank' => isset($row['Rank']) ? (int)$row['Rank'] : null,
        'record' => $record,
        'match_record' => $record,
        'match_points' => $points,
        'opponent_match_win_percentage' => isset($row['OpponentMatchWinPercentage'])
            ? (float)$row['OpponentMatchWinPercentage'] : null,
        'game_win_percentage' => isset($row['TeamGameWinPercentage'])
            ? (float)$row['TeamGameWinPercentage'] : null,
        'opponent_game_win_percentage' => isset($row['OpponentGameWinPercentage'])
            ? (float)$row['OpponentGameWinPercentage'] : null,
        'player' => $playerRef,
        'user_event_status' => [
            'id' => $row['TeamId'] ?? $pid,
            'best_identifier' => $pname,
            'matches_won' => $wins,
            'matches_lost' => $losses,
            'matches_drawn' => $draws,
            'total_match_points' => $points,
            'user' => [
                'id' => $pid,
                'best_identifier' => $pname,
                'username' => $pname,
            ],
        ],
        'round_number' => isset($row['RoundNumber']) ? (int)$row['RoundNumber'] : null,
    ];
}

/**
 * Parse Melee ResultString → winner name + game scores.
 * Examples: "Zabson won 2-1-0", "0-0-3 draw", "Draw 1-1-1"
 *
 * @return array{winnerName:?string,gw: ?int,gl: ?int,gd: ?int,isDraw:bool}
 */
function melee_parse_result_string($resultString) {
    $s = trim((string)$resultString);
    $out = ['winnerName' => null, 'gw' => null, 'gl' => null, 'gd' => null, 'isDraw' => false];
    if ($s === '') {
        return $out;
    }
    if (preg_match('/^(.+?)\s+won\s+(\d+)\s*-\s*(\d+)\s*-\s*(\d+)\s*$/i', $s, $m)) {
        $out['winnerName'] = trim($m[1]);
        $out['gw'] = (int)$m[2];
        $out['gl'] = (int)$m[3];
        $out['gd'] = (int)$m[4];
        return $out;
    }
    if (preg_match('/(\d+)\s*-\s*(\d+)\s*-\s*(\d+).*draw/i', $s, $m)
        || preg_match('/draw.*?(\d+)\s*-\s*(\d+)\s*-\s*(\d+)/i', $s, $m)) {
        $out['isDraw'] = true;
        $out['gw'] = (int)$m[1];
        $out['gl'] = (int)$m[2];
        $out['gd'] = (int)$m[3];
        return $out;
    }
    if (stripos($s, 'draw') !== false) {
        $out['isDraw'] = true;
    }
    return $out;
}

/**
 * Map one Melee match row → PlayHub-slim match.
 */
function melee_normalize_match_row(array $row) {
    $competitors = is_array($row['Competitors'] ?? null) ? $row['Competitors'] : [];
    $players = [];
    $rels = [];
    $nameToId = [];

    foreach ($competitors as $comp) {
        if (!is_array($comp)) {
            continue;
        }
        $p = melee_team_primary_player($comp['Team'] ?? null);
        if (!$p) {
            continue;
        }
        $ref = ['id' => $p['id'], 'best_identifier' => $p['name']];
        $players[] = $ref;
        $rels[] = ['player' => $ref];
        $nameToId[strtolower($p['name'])] = $p['id'];
    }

    $isBye = !empty($row['ByeReason']) || !empty($row['ByeReasonDescription']) || count($players) < 2;
    $parsed = melee_parse_result_string($row['ResultString'] ?? '');
    $hasResult = !empty($row['HasResult']) || ($parsed['winnerName'] !== null) || $parsed['isDraw'] || $isBye;

    $winningPlayer = null;
    if ($parsed['winnerName'] !== null) {
        $key = strtolower($parsed['winnerName']);
        if (isset($nameToId[$key])) {
            $winningPlayer = $nameToId[$key];
        } else {
            // Fuzzy: result may use DisplayName while we keyed Username
            foreach ($competitors as $comp) {
                $plist = $comp['Team']['Players'] ?? [];
                if (!is_array($plist) || !$plist) {
                    continue;
                }
                $pp = $plist[0];
                $candidates = [
                    $pp['Username'] ?? null,
                    $pp['DisplayName'] ?? null,
                    $pp['DisplayNameLastFirst'] ?? null,
                ];
                foreach ($candidates as $cand) {
                    if ($cand !== null && strcasecmp((string)$cand, $parsed['winnerName']) === 0) {
                        $winningPlayer = (int)($pp['ID'] ?? 0) ?: null;
                        break 2;
                    }
                }
            }
        }
    }

    // Infer winner from GameWins when ResultString is missing but HasResult.
    if ($winningPlayer === null && $hasResult && !$parsed['isDraw'] && !$isBye && count($competitors) >= 2) {
        $g0 = (int)($competitors[0]['GameWins'] ?? -1);
        $g1 = (int)($competitors[1]['GameWins'] ?? -1);
        if ($g0 > $g1) {
            $p = melee_team_primary_player($competitors[0]['Team'] ?? null);
            $winningPlayer = $p['id'] ?? null;
            if ($parsed['gw'] === null) {
                $parsed['gw'] = $g0;
                $parsed['gl'] = $g1;
            }
        } elseif ($g1 > $g0) {
            $p = melee_team_primary_player($competitors[1]['Team'] ?? null);
            $winningPlayer = $p['id'] ?? null;
            if ($parsed['gw'] === null) {
                $parsed['gw'] = $g1;
                $parsed['gl'] = $g0;
            }
        } elseif ($g0 === $g1 && $g0 >= 0) {
            $parsed['isDraw'] = true;
        }
    }

    $status = $hasResult ? 'COMPLETE' : 'IN_PROGRESS';
    if ($isBye && $hasResult && $winningPlayer === null && count($players) === 1) {
        $winningPlayer = $players[0]['id'];
    }

    $out = [
        'id' => $row['Guid'] ?? $row['ID'] ?? null,
        'table_number' => isset($row['TableNumber']) ? (int)$row['TableNumber'] : null,
        'status' => $status,
        'match_is_intentional_draw' => $parsed['isDraw'],
        'match_is_unintentional_draw' => false,
        'match_is_bye' => $isBye,
        'games_won_by_winner' => $parsed['gw'],
        'games_won_by_loser' => $parsed['gl'],
        'winning_player' => $winningPlayer,
        'players' => $players,
        'player_match_relationships' => $rels,
    ];
    if ($isBye) {
        $out['is_bye'] = true;
        $out['round_type'] = 'BYE';
    }
    return $out;
}

/**
 * @return array{ok:bool,data?:list,error?:string,httpCode?:int}
 */
function melee_fetch_round_standings($roundId, $referer) {
    $roundId = (int)$roundId;
    $cols = [
        'Rank', 'Player', 'Decklists', 'MatchRecord', 'GameRecord', 'Points',
        'OpponentMatchWinPercentage', 'TeamGameWinPercentage', 'OpponentGameWinPercentage', 'OpponentCount',
    ];
    $url = MELEE_BASE_URL . '/Standing/GetRoundStandings/' . $roundId;
    $res = melee_http_request($url, [
        'method' => 'POST',
        'body' => melee_datatables_body($cols, $roundId),
        'referer' => $referer,
        'ajax' => true,
    ]);
    if (!$res['ok']) {
        return ['ok' => false, 'error' => 'Standings HTTP ' . $res['code'], 'httpCode' => $res['code']];
    }
    $json = json_decode($res['body'], true);
    if (!is_array($json) || !isset($json['data']) || !is_array($json['data'])) {
        return ['ok' => false, 'error' => 'Standings JSON invalid', 'httpCode' => $res['code']];
    }
    return ['ok' => true, 'data' => $json['data']];
}

/**
 * @return array{ok:bool,data?:list,error?:string,httpCode?:int}
 */
function melee_fetch_round_matches($roundId, $referer) {
    $roundId = (int)$roundId;
    $cols = ['TableNumber', 'PodNumber', 'Teams', 'Decklists', 'ResultString'];
    $url = MELEE_BASE_URL . '/Match/GetRoundMatches/' . $roundId;
    $res = melee_http_request($url, [
        'method' => 'POST',
        'body' => melee_datatables_body($cols, null),
        'referer' => $referer,
        'ajax' => true,
    ]);
    if (!$res['ok']) {
        return ['ok' => false, 'error' => 'Matches HTTP ' . $res['code'], 'httpCode' => $res['code']];
    }
    $json = json_decode($res['body'], true);
    if (!is_array($json) || !isset($json['data']) || !is_array($json['data'])) {
        return ['ok' => false, 'error' => 'Matches JSON invalid', 'httpCode' => $res['code']];
    }
    return ['ok' => true, 'data' => $json['data']];
}

/**
 * Build aggregated event payload from Melee public endpoints.
 *
 * @return array{ok:bool,payload?:array,error?:string,httpCode?:int}
 */
function melee_build_event_payload($tournamentId, $options = []) {
    $tournamentId = melee_parse_tournament_id($tournamentId);
    if ($tournamentId <= 0) {
        return ['ok' => false, 'error' => 'Nieprawidłowy Melee tournament id.', 'httpCode' => 400];
    }

    melee_raise_fetch_time_limit();
    $referer = MELEE_BASE_URL . '/Tournament/View/' . $tournamentId;
    $page = melee_http_request($referer, ['referer' => MELEE_BASE_URL . '/', 'timeout' => 60]);
    if (!$page['ok'] || $page['body'] === '') {
        return [
            'ok' => false,
            'error' => 'Nie udało się pobrać strony Melee (HTTP ' . $page['code'] . ').',
            'httpCode' => (int)$page['code'],
        ];
    }
    $html = $page['body'];

    $pairRounds = melee_parse_round_buttons($html, 'pairings-round-selector-container');
    $standRounds = melee_parse_round_buttons($html, 'standings-round-selector-container');
    if (!$pairRounds && $standRounds) {
        $pairRounds = $standRounds;
    }
    if (!$standRounds && $pairRounds) {
        $standRounds = $pairRounds;
    }

    $eventName = melee_parse_event_name($html);
    $displayStatus = melee_parse_display_status($html);
    $gameLabel = melee_parse_game_label($html);
    $isCompleted = in_array($displayStatus, ['complete', 'completed', 'finished'], true);

    $standingsRoundNumber = 0;
    $standingsRoundId = null;
    foreach ($standRounds as $r) {
        if (!empty($r['completed']) || !empty($r['started'])) {
            if ($r['number'] >= $standingsRoundNumber) {
                $standingsRoundNumber = $r['number'];
                $standingsRoundId = $r['id'];
            }
        }
    }
    if ($standingsRoundId === null && $standRounds) {
        $last = $standRounds[count($standRounds) - 1];
        $standingsRoundId = $last['id'];
        $standingsRoundNumber = $last['number'];
    }

    $activeRoundNumber = 0;
    $pairingsRoundId = null;
    foreach ($pairRounds as $r) {
        if (!empty($r['started'])) {
            if ($r['number'] >= $activeRoundNumber) {
                $activeRoundNumber = $r['number'];
                $pairingsRoundId = $r['id'];
            }
        }
    }
    if ($pairingsRoundId === null && $pairRounds) {
        $last = $pairRounds[count($pairRounds) - 1];
        $pairingsRoundId = $last['id'];
        $activeRoundNumber = $last['number'];
    }

    $totalRounds = max(count($pairRounds), count($standRounds));
    // Prefer published round count from page copy ("Rounds Cap: 4") when buttons missing.
    if ($totalRounds === 0 && preg_match('/Rounds?\s+Cap:\s*(\d+)/i', $html, $m)) {
        $totalRounds = (int)$m[1];
    }

    $roundsModeOpt = $options['roundsMode'] ?? null;
    if ($roundsModeOpt !== 'critical' && $roundsModeOpt !== 'all') {
        $roundsModeOpt = null;
    }
    $roundsMode = $roundsModeOpt ?? (count($pairRounds) > 3 ? 'critical' : 'all');

    $toFetch = [];
    foreach ($pairRounds as $r) {
        if (!empty($r['started']) || !empty($r['completed'])) {
            $toFetch[$r['number']] = $r['id'];
        }
    }
    if ($roundsMode === 'critical' && $activeRoundNumber > 0 && isset($toFetch[$activeRoundNumber])) {
        $crit = [$activeRoundNumber => $toFetch[$activeRoundNumber]];
        if ($standingsRoundNumber > 0 && isset($toFetch[$standingsRoundNumber])) {
            $crit[$standingsRoundNumber] = $toFetch[$standingsRoundNumber];
        }
        $toFetch = $crit;
    }

    $roundsMatches = [];
    $pairingsData = null;
    foreach ($toFetch as $rNum => $rId) {
        $mRes = melee_fetch_round_matches($rId, $referer);
        if (empty($mRes['ok'])) {
            continue;
        }
        $slim = [];
        foreach ($mRes['data'] as $row) {
            if (is_array($row)) {
                $slim[] = melee_normalize_match_row($row);
            }
        }
        $matchesList = ['results' => $slim, 'count' => count($slim)];
        $status = 'COMPLETE';
        foreach ($pairRounds as $pr) {
            if ((int)$pr['id'] === (int)$rId) {
                $status = !empty($pr['completed']) ? 'COMPLETE' : (!empty($pr['started']) ? 'IN_PROGRESS' : 'UNKNOWN');
                break;
            }
        }
        $roundsMatches[$rNum] = [
            'round_number' => (int)$rNum,
            'round_id' => (int)$rId,
            'status' => $status,
            'matches' => $matchesList,
        ];
        if ($pairingsRoundId && (int)$rId === (int)$pairingsRoundId) {
            $pairingsData = [
                'sourceRound' => (int)$rNum,
                'count' => count($slim),
                'results' => [],
            ];
        }
    }

    $standingsRows = [];
    if ($standingsRoundId) {
        $sRes = melee_fetch_round_standings($standingsRoundId, $referer);
        if (!empty($sRes['ok'])) {
            foreach ($sRes['data'] as $row) {
                if (is_array($row)) {
                    $standingsRows[] = melee_normalize_standing_row($row);
                }
            }
        } elseif (!$roundsMatches) {
            return [
                'ok' => false,
                'error' => $sRes['error'] ?? 'Brak standings z Melee.',
                'httpCode' => $sRes['httpCode'] ?? 0,
            ];
        }
    }

    usort($standingsRows, static function ($a, $b) {
        $ra = (int)($a['rank'] ?? 0);
        $rb = (int)($b['rank'] ?? 0);
        if ($ra && $rb && $ra !== $rb) {
            return $ra <=> $rb;
        }
        return ((int)($b['match_points'] ?? 0)) <=> ((int)($a['match_points'] ?? 0));
    });

    $playerCount = count($standingsRows);
    if ($playerCount === 0 && preg_match('/(\d+)\s+of\s+\d+\s+Enrolled/i', $html, $m)) {
        $playerCount = (int)$m[1];
    }

    $standingsData = ['standings' => $standingsRows];

    $payload = [
        'eventId' => $tournamentId,
        'lastEventId' => $tournamentId,
        'eventName' => $eventName,
        'playerCount' => $playerCount,
        'displayStatus' => $displayStatus,
        'isCompleted' => $isCompleted,
        'standingsRound' => $standingsRoundNumber,
        'activeRound' => $activeRoundNumber,
        'totalRounds' => $totalRounds,
        'roundsFetchMode' => $roundsMode,
        'roundsFetched' => array_map('intval', array_keys($roundsMatches)),
        'hasTokenConfigured' => false,
        'dataSource' => 'melee',
        'gameLabel' => $gameLabel,
        'scoringAssumptions' => [
            'winPoints' => 3,
            'drawPoints' => 1,
            'lossPoints' => 0,
            'tiebreakers' => ['OMW', 'PGW', 'OGW'],
            'notes' => 'Melee Swiss defaults; Points taken from Melee standings (not recomputed).',
        ],
        'standings' => $standingsData,
        'pairings' => $pairingsData,
        'roundsMatches' => $roundsMatches,
    ];

    $payload = lorcana_slim_event_payload($payload);
    return ['ok' => true, 'payload' => $payload];
}
