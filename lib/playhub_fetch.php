<?php
/**
 * PlayHub / Hydraproxy fetch + aggregate event payload builder.
 */

require_once __DIR__ . '/playhub_cache.php';
require_once __DIR__ . '/playhub_slim.php';

/** Rozmiar strony Hydraproxy — większy = mniej round-tripów przy cold-load 2k–4k. */
if (!defined('LORCANA_MATCH_PAGE_SIZE')) {
    define('LORCANA_MATCH_PAGE_SIZE', 250);
}
if (!defined('LORCANA_MATCH_MAX_PAGES')) {
    define('LORCANA_MATCH_MAX_PAGES', 40); // 40 * 250 = 10k meczów
}
/** Per-request curl headroom: ~9s @777 players was near old 10s cap; need room for ~3k. */
if (!defined('LORCANA_CURL_CONNECT_TIMEOUT')) {
    define('LORCANA_CURL_CONNECT_TIMEOUT', 20);
}
if (!defined('LORCANA_CURL_TIMEOUT')) {
    define('LORCANA_CURL_TIMEOUT', 60);
}
/** Whole cold-fill / refresh budget (many parallel pages × rounds). */
if (!defined('LORCANA_FETCH_TIME_LIMIT')) {
    define('LORCANA_FETCH_TIME_LIMIT', 300);
}

function lorcana_raise_fetch_time_limit($seconds = null) {
    $seconds = $seconds === null ? LORCANA_FETCH_TIME_LIMIT : (int)$seconds;
    if ($seconds < 1) {
        return;
    }
    @ini_set('max_execution_time', (string)$seconds);
    @set_time_limit($seconds);
}

/**
 * Best-effort field size for an event.
 * PlayHub often leaves registered_user_count=1 on completed events while
 * starting_player_count (and standings length) reflect the real field.
 *
 * @param array $eventData Raw event JSON from Hydraproxy
 * @param array|null $standingsData Optional standings payload (standings/results list)
 * @return int
 */
function lorcana_resolve_player_count($eventData, $standingsData = null) {
    $registered = (int)($eventData['registered_user_count'] ?? 0);
    $starting = (int)($eventData['starting_player_count'] ?? 0);
    $count = max($registered, $starting);

    if (is_array($standingsData)) {
        $list = null;
        if (isset($standingsData['standings']) && is_array($standingsData['standings'])) {
            $list = $standingsData['standings'];
        } elseif (isset($standingsData['results']) && is_array($standingsData['results'])) {
            $list = $standingsData['results'];
        }
        if (is_array($list)) {
            $count = max($count, count($list));
        }
    }

    return $count;
}

function lorcana_apply_curl_timeouts($ch) {
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, LORCANA_CURL_CONNECT_TIMEOUT);
    curl_setopt($ch, CURLOPT_TIMEOUT, LORCANA_CURL_TIMEOUT);
}

function lorcana_fetch_url_with_status($url, $token = null, $allowLocalSslFallback = false) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_MAXREDIRS, 3);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
    lorcana_apply_curl_timeouts($ch);
    curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    $headers = [
        'Accept: application/json',
        'Content-Type: application/json',
        'Origin: https://tcg.ravensburgerplay.com',
        'Referer: https://tcg.ravensburgerplay.com/'
    ];

    if ($token) {
        $headers[] = 'Authorization: ' . $token;
    }

    curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
    $output = curl_exec($ch);
    $curlErrNo = curl_errno($ch);

    // Fallback wyłącznie na lokalnym środowisku deweloperskim (np. XAMPP bez skonfigurowanego cacert.pem)
    if ($output === false && in_array($curlErrNo, [60, 77], true) && $allowLocalSslFallback) {
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
        $output = curl_exec($ch);
    }

    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['body' => $output, 'code' => $httpCode];
}

function lorcana_build_matches_page_url($roundId, $page, $pageSize = LORCANA_MATCH_PAGE_SIZE) {
    $safeRoundId = (int)$roundId;
    $page = (int)$page;
    $pageSize = (int)$pageSize;
    return "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{$safeRoundId}/matches/paginated/?page={$page}&page_size={$pageSize}&avoid_cache=false";
}

/**
 * Równoległy GET wielu URL-i (curl_multi). Zwraca mapę key => decoded JSON|null.
 */
function lorcana_fetch_urls_parallel($urlsByKey, $token = null, $allowLocalSslFallback = false) {
    $out = [];
    if (empty($urlsByKey)) {
        return $out;
    }
    if (!function_exists('curl_multi_init') || count($urlsByKey) === 1) {
        foreach ($urlsByKey as $key => $url) {
            $res = lorcana_fetch_url_with_status($url, $token, $allowLocalSslFallback);
            $data = json_decode($res['body'], true);
            $out[$key] = is_array($data) ? $data : null;
        }
        return $out;
    }

    $mh = curl_multi_init();
    $handles = [];
    foreach ($urlsByKey as $key => $url) {
        $ch = curl_init();
        curl_setopt($ch, CURLOPT_URL, $url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        curl_setopt($ch, CURLOPT_MAXREDIRS, 3);
        if ($allowLocalSslFallback) {
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 0);
        } else {
            curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
            curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
        }
        lorcana_apply_curl_timeouts($ch);
        curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        $headers = [
            'Accept: application/json',
            'Content-Type: application/json',
            'Origin: https://tcg.ravensburgerplay.com',
            'Referer: https://tcg.ravensburgerplay.com/'
        ];
        if ($token) {
            $headers[] = 'Authorization: ' . $token;
        }
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_multi_add_handle($mh, $ch);
        $handles[$key] = $ch;
    }

    $running = null;
    do {
        $mrc = curl_multi_exec($mh, $running);
        if ($running) {
            curl_multi_select($mh, 1.0);
        }
    } while ($running && $mrc === CURLM_OK);

    foreach ($handles as $key => $ch) {
        $body = curl_multi_getcontent($ch);
        curl_multi_remove_handle($mh, $ch);
        curl_close($ch);
        $data = json_decode($body, true);
        $out[$key] = is_array($data) ? $data : null;
    }
    curl_multi_close($mh);
    return $out;
}

function lorcana_extract_match_page_chunk($data) {
    if (!is_array($data)) {
        return [null, 'invalid'];
    }
    if (isset($data['results']) && is_array($data['results'])) {
        return [$data['results'], 'paged'];
    }
    if (isset($data['data']) && is_array($data['data'])) {
        return [$data['data'], 'paged'];
    }
    if ($data !== [] && array_keys($data) === range(0, count($data) - 1)) {
        return [$data, 'flat'];
    }
    return [null, 'empty'];
}

/**
 * Pobiera WSZYSTKIE mecze rundy.
 * Strona 1 sekwencyjnie (żeby poznać count), potem pozostałe strony równolegle.
 */
function lorcana_fetch_all_paginated_matches($roundId, $token = null, $allowLocalSslFallback = false) {
    $pageSize = LORCANA_MATCH_PAGE_SIZE;
    $maxPages = LORCANA_MATCH_MAX_PAGES;

    $page1 = lorcana_fetch_urls_parallel(
        ['p1' => lorcana_build_matches_page_url($roundId, 1, $pageSize)],
        $token,
        $allowLocalSslFallback
    );
    $data = $page1['p1'] ?? null;
    if (!is_array($data)) {
        return null;
    }

    list($chunk, $kind) = lorcana_extract_match_page_chunk($data);
    if ($kind === 'flat') {
        return [
            'results' => $chunk,
            'count' => count($chunk),
            'next' => null,
            'previous' => null
        ];
    }
    if ($chunk === null) {
        return null;
    }

    $pages = [1 => $chunk];
    $lastPayload = $data;
    $totalCount = isset($data['count']) ? (int)$data['count'] : null;
    $hasNext = !empty($data['next']);

    $pagesNeeded = 1;
    if ($totalCount !== null && $totalCount > $pageSize) {
        $pagesNeeded = (int)ceil($totalCount / $pageSize);
    } elseif ($hasNext && count($chunk) >= $pageSize) {
        $pagesNeeded = 2;
    }
    $pagesNeeded = min($pagesNeeded, $maxPages);

    if ($pagesNeeded > 1) {
        $urls = [];
        for ($p = 2; $p <= $pagesNeeded; $p++) {
            $urls['p' . $p] = lorcana_build_matches_page_url($roundId, $p, $pageSize);
        }
        $fetched = lorcana_fetch_urls_parallel($urls, $token, $allowLocalSslFallback);
        foreach ($fetched as $key => $pageData) {
            $pNum = (int)substr($key, 1);
            list($pageChunk, $pageKind) = lorcana_extract_match_page_chunk($pageData);
            if ($pageKind === 'paged' && is_array($pageChunk) && count($pageChunk) > 0) {
                $pages[$pNum] = $pageChunk;
                $lastPayload = $pageData;
                if ($totalCount === null && count($pageChunk) >= $pageSize && !empty($pageData['next']) && $pNum >= $pagesNeeded && $pagesNeeded < $maxPages) {
                    $extraPage = $pNum + 1;
                    $extra = lorcana_fetch_urls_parallel(
                        ['p' . $extraPage => lorcana_build_matches_page_url($roundId, $extraPage, $pageSize)],
                        $token,
                        $allowLocalSslFallback
                    );
                    $extraData = $extra['p' . $extraPage] ?? null;
                    list($extraChunk, $extraKind) = lorcana_extract_match_page_chunk($extraData);
                    if ($extraKind === 'paged' && is_array($extraChunk) && count($extraChunk) > 0) {
                        $pages[$extraPage] = $extraChunk;
                        $lastPayload = $extraData;
                        $pagesNeeded = $extraPage;
                        while (
                            $pagesNeeded < $maxPages
                            && is_array($lastPayload)
                            && !empty($lastPayload['next'])
                            && count($pages[$pagesNeeded]) >= $pageSize
                        ) {
                            $nextP = $pagesNeeded + 1;
                            $more = lorcana_fetch_urls_parallel(
                                ['p' . $nextP => lorcana_build_matches_page_url($roundId, $nextP, $pageSize)],
                                $token,
                                $allowLocalSslFallback
                            );
                            $moreData = $more['p' . $nextP] ?? null;
                            list($moreChunk, $moreKind) = lorcana_extract_match_page_chunk($moreData);
                            if ($moreKind !== 'paged' || !is_array($moreChunk) || count($moreChunk) === 0) {
                                break;
                            }
                            $pages[$nextP] = $moreChunk;
                            $lastPayload = $moreData;
                            $pagesNeeded = $nextP;
                        }
                    }
                }
            }
        }
    }

    ksort($pages, SORT_NUMERIC);
    $allResults = [];
    foreach ($pages as $pageChunk) {
        foreach ($pageChunk as $row) {
            $allResults[] = $row;
        }
    }

    $out = is_array($lastPayload) ? $lastPayload : [];
    $out['results'] = $allResults;
    $out['count'] = count($allResults);
    $out['next'] = null;
    $out['previous'] = null;
    return $out;
}

/**
 * Równoległe pobranie pełnych list meczów dla wielu rund.
 */
function lorcana_fetch_all_paginated_matches_for_rounds($roundIdsByKey, $token = null, $allowLocalSslFallback = false) {
    $out = [];
    if (empty($roundIdsByKey)) {
        return $out;
    }

    $pageSize = LORCANA_MATCH_PAGE_SIZE;
    $maxPages = LORCANA_MATCH_MAX_PAGES;

    $page1Urls = [];
    foreach ($roundIdsByKey as $key => $roundId) {
        $page1Urls[$key] = lorcana_build_matches_page_url($roundId, 1, $pageSize);
    }
    $page1Data = lorcana_fetch_urls_parallel($page1Urls, $token, $allowLocalSslFallback);

    $pagesByRound = [];
    $meta = [];
    $moreUrls = [];

    foreach ($roundIdsByKey as $key => $roundId) {
        $data = $page1Data[$key] ?? null;
        list($chunk, $kind) = lorcana_extract_match_page_chunk($data);
        if ($kind === 'flat') {
            $out[$key] = [
                'results' => $chunk,
                'count' => count($chunk),
                'next' => null,
                'previous' => null
            ];
            continue;
        }
        if ($chunk === null) {
            $out[$key] = null;
            continue;
        }

        $pagesByRound[$key] = [1 => $chunk];
        $meta[$key] = [
            'roundId' => (int)$roundId,
            'lastPayload' => $data,
            'totalCount' => isset($data['count']) ? (int)$data['count'] : null
        ];

        $needed = 1;
        if ($meta[$key]['totalCount'] !== null && $meta[$key]['totalCount'] > $pageSize) {
            $needed = min($maxPages, (int)ceil($meta[$key]['totalCount'] / $pageSize));
        } elseif (!empty($data['next']) && count($chunk) >= $pageSize) {
            $needed = min($maxPages, 2);
        }
        for ($p = 2; $p <= $needed; $p++) {
            $moreUrls[$key . ':' . $p] = lorcana_build_matches_page_url($roundId, $p, $pageSize);
        }
    }

    if (!empty($moreUrls)) {
        $moreData = lorcana_fetch_urls_parallel($moreUrls, $token, $allowLocalSslFallback);
        foreach ($moreData as $compositeKey => $pageData) {
            $parts = explode(':', $compositeKey, 2);
            if (count($parts) !== 2) {
                continue;
            }
            $key = $parts[0];
            $pNum = (int)$parts[1];
            if (!isset($pagesByRound[$key])) {
                continue;
            }
            list($pageChunk, $pageKind) = lorcana_extract_match_page_chunk($pageData);
            if ($pageKind === 'paged' && is_array($pageChunk) && count($pageChunk) > 0) {
                $pagesByRound[$key][$pNum] = $pageChunk;
                $meta[$key]['lastPayload'] = $pageData;
            }
        }
    }

    foreach ($pagesByRound as $key => $pages) {
        if (isset($out[$key])) {
            continue;
        }
        $totalCount = $meta[$key]['totalCount'] ?? null;
        $roundId = $meta[$key]['roundId'];
        if ($totalCount !== null) {
            continue;
        }
        $lastPage = max(array_keys($pages));
        $guard = 0;
        while ($guard < $maxPages) {
            $guard++;
            $lastChunk = $pages[$lastPage] ?? [];
            $lastPayload = $meta[$key]['lastPayload'] ?? null;
            if (count($lastChunk) < $pageSize || empty($lastPayload['next'])) {
                break;
            }
            $nextP = $lastPage + 1;
            if ($nextP > $maxPages) {
                break;
            }
            $extra = lorcana_fetch_urls_parallel(
                [$key . ':' . $nextP => lorcana_build_matches_page_url($roundId, $nextP, $pageSize)],
                $token,
                $allowLocalSslFallback
            );
            $extraData = $extra[$key . ':' . $nextP] ?? null;
            list($extraChunk, $extraKind) = lorcana_extract_match_page_chunk($extraData);
            if ($extraKind !== 'paged' || !is_array($extraChunk) || count($extraChunk) === 0) {
                break;
            }
            $pages[$nextP] = $extraChunk;
            $meta[$key]['lastPayload'] = $extraData;
            $lastPage = $nextP;
        }
        $pagesByRound[$key] = $pages;
    }

    foreach ($pagesByRound as $key => $pages) {
        ksort($pages, SORT_NUMERIC);
        $allResults = [];
        foreach ($pages as $pageChunk) {
            foreach ($pageChunk as $row) {
                $allResults[] = $row;
            }
        }
        $payload = is_array($meta[$key]['lastPayload'] ?? null) ? $meta[$key]['lastPayload'] : [];
        $payload['results'] = $allResults;
        $payload['count'] = count($allResults);
        $payload['next'] = null;
        $payload['previous'] = null;
        $out[$key] = $payload;
    }
    return $out;
}

/**
 * Live fetch from PlayHub and build the aggregated event payload (no disk I/O).
 *
 * @return array{ok:bool,payload?:array,error?:string,httpCode?:int}
 */
function lorcana_build_event_payload($eventId, $authToken = null, $allowLocalSslFallback = false) {
    $eventId = (int)$eventId;
    if ($eventId <= 0) {
        return ['ok' => false, 'error' => 'Nieprawidłowy identyfikator turnieju (eventId).', 'httpCode' => 400];
    }

    lorcana_raise_fetch_time_limit();

    if ($authToken === null) {
        $authToken = lorcana_load_auth_token();
    }

    $eventUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/events/{$eventId}/";
    $eventRes = lorcana_fetch_url_with_status($eventUrl, null, $allowLocalSslFallback);
    $eventData = json_decode($eventRes['body'], true);

    if (!$eventData) {
        return [
            'ok' => false,
            'error' => "Nie udało się połączyć z API Lorcany (HTTP {$eventRes['code']}).",
            'httpCode' => (int)$eventRes['code']
        ];
    }

    $eventName = $eventData['name'] ?? 'Nieznany Event';
    // Finished events often report registered_user_count=1; starting_player_count is the real field size.
    $playerCount = lorcana_resolve_player_count($eventData);

    $standingsRoundId = null;
    $standingsRoundNumber = 0;
    $pairingsRoundId = null;
    $activeRoundNumber = 0;
    $totalRounds = 0;
    $eligibleRounds = [];

    if (isset($eventData['tournament_phases'])) {
        foreach ($eventData['tournament_phases'] as $phase) {
            if (isset($phase['rounds']) && is_array($phase['rounds'])) {
                $totalRounds = max($totalRounds, count($phase['rounds']));

                foreach ($phase['rounds'] as $round) {
                    $rNum = (int)($round['round_number'] ?? 0);

                    if (($round['standings_status'] ?? '') === 'GENERATED') {
                        if ($rNum > $standingsRoundNumber) {
                            $standingsRoundId = $round['id'];
                            $standingsRoundNumber = $rNum;
                        }
                    }

                    $status = strtoupper($round['status'] ?? '');
                    $pStatus = strtoupper($round['pairings_status'] ?? '');

                    if ($pStatus === 'GENERATED' || in_array($status, ['IN_PROGRESS', 'COMPLETE', 'FINISHED'])) {
                        if ($rNum >= $activeRoundNumber) {
                            $pairingsRoundId = $round['id'];
                            $activeRoundNumber = $rNum;
                        }
                        if ($rNum > 0) {
                            $eligibleRounds[$rNum] = [
                                'id' => $round['id'],
                                'round_number' => $rNum,
                                'status' => $status
                            ];
                        }
                    }
                }
            }
        }
    }

    if ($totalRounds === 0 && $playerCount > 0) {
        if ($playerCount <= 8) $totalRounds = 3;
        elseif ($playerCount <= 16) $totalRounds = 4;
        elseif ($playerCount <= 32) $totalRounds = 5;
        elseif ($playerCount <= 64) $totalRounds = 6;
        elseif ($playerCount <= 128) $totalRounds = 7;
        elseif ($playerCount <= 226) $totalRounds = 8;
        else $totalRounds = 9;
    }

    if (!$pairingsRoundId && $standingsRoundId) {
        $pairingsRoundId = $standingsRoundId;
        $activeRoundNumber = $standingsRoundNumber;
    }

    $standingsData = null;
    $pairingsData = null;
    $roundsMatches = [];

    $standingsUrl = null;
    if ($standingsRoundId) {
        $safeStandingsRoundId = (int)$standingsRoundId;
        $standingsUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{$safeStandingsRoundId}/standings/";
    }

    if (!empty($eligibleRounds)) {
        ksort($eligibleRounds);
        $toFetch = [];
        foreach ($eligibleRounds as $rNum => $rInfo) {
            $toFetch[$rNum] = (int)$rInfo['id'];
        }

        if ($standingsUrl) {
            $standingsBundle = lorcana_fetch_urls_parallel(['standings' => $standingsUrl], $authToken, $allowLocalSslFallback);
            $standingsData = $standingsBundle['standings'] ?? null;
        }

        // Sequential per-round fetch + immediate slim: ink-pairing descriptors with
        // signed image URLs are ~2.5MB/round; parallel keep-all OOMs shared hosts.
        foreach ($toFetch as $rNum => $safeRoundId) {
            $mData = lorcana_fetch_all_paginated_matches($safeRoundId, $authToken, $allowLocalSslFallback);
            if ($mData) {
                $rawMatches = $mData['results'] ?? $mData['data'] ?? $mData;
                $slimMatches = lorcana_slim_matches_list($rawMatches);
                unset($mData, $rawMatches);
                $roundsMatches[$rNum] = [
                    'round_number' => $rNum,
                    'round_id' => $safeRoundId,
                    'status' => $eligibleRounds[$rNum]['status'],
                    'matches' => $slimMatches,
                ];
                if ($pairingsRoundId && $safeRoundId === (int)$pairingsRoundId) {
                    // Placeholder only — final slim collapses active pairings to sourceRound.
                    $pairingsData = [
                        'sourceRound' => $rNum,
                        'count' => is_array($slimMatches['results'] ?? null)
                            ? count($slimMatches['results'])
                            : (is_array($slimMatches) ? count($slimMatches) : 0),
                        'results' => [],
                    ];
                }
                unset($slimMatches);
            }
        }
    } elseif ($standingsUrl) {
        $standingsBundle = lorcana_fetch_urls_parallel(['standings' => $standingsUrl], $authToken, $allowLocalSslFallback);
        $standingsData = $standingsBundle['standings'] ?? null;
    }

    if ($pairingsRoundId && !$pairingsData) {
        $rawPairings = lorcana_fetch_all_paginated_matches($pairingsRoundId, $authToken, $allowLocalSslFallback);
        if ($rawPairings) {
            $pairingsData = lorcana_slim_matches_list($rawPairings);
            unset($rawPairings);
        }
    }

    // Slim standings early (drops profile picture URLs) before building the payload.
    if (is_array($standingsData)) {
        $standingsData = lorcana_slim_standings($standingsData);
    }

    $displayStatus = strtolower($eventData['display_status'] ?? '');
    $isCompleted = in_array($displayStatus, ['complete', 'completed', 'finished']);

    // Prefer the larger of registration / starting / standings length once rows exist.
    $playerCount = lorcana_resolve_player_count($eventData, $standingsData);

    $payload = [
        'eventId' => $eventId,
        'lastEventId' => $eventId,
        'eventName' => $eventName,
        'playerCount' => $playerCount,
        'displayStatus' => $displayStatus,
        'isCompleted' => $isCompleted,
        'standingsRound' => $standingsRoundNumber,
        'activeRound' => $activeRoundNumber,
        'totalRounds' => $totalRounds,
        'hasTokenConfigured' => !empty($authToken),
        'standings' => $standingsData,
        'pairings' => $pairingsData,
        'roundsMatches' => $roundsMatches
    ];

    // Strip residual bloat + harvest compact ink pairings onto standings rows.
    $payload = lorcana_slim_event_payload($payload);

    return ['ok' => true, 'payload' => $payload];
}

/**
 * Refresh one event into disk cache under a per-event lock.
 *
 * @return array{ok:bool,skipped?:bool,reason?:string,error?:string,payload?:array,age?:int}
 */
function lorcana_refresh_event_cache($eventId, $options = []) {
    $eventId = (int)$eventId;
    $force = !empty($options['force']);
    $allowLocalSslFallback = !empty($options['allowLocalSslFallback']);
    $authToken = array_key_exists('authToken', $options) ? $options['authToken'] : lorcana_load_auth_token();

    lorcana_raise_fetch_time_limit();

    $lock = lorcana_acquire_lock(lorcana_refresh_lock_file($eventId), !empty($options['blocking']));
    if (!$lock) {
        return ['ok' => false, 'skipped' => true, 'reason' => 'locked'];
    }

    try {
        if (!$force) {
            $cached = lorcana_read_cache($eventId);
            if ($cached['exists'] && is_array($cached['data'])) {
                $ttl = lorcana_poll_interval_seconds($cached['data']);
                if ($cached['age'] !== null && $cached['age'] < $ttl) {
                    return [
                        'ok' => true,
                        'skipped' => true,
                        'reason' => 'fresh',
                        'age' => $cached['age'],
                        'ttl' => $ttl,
                        'payload' => $cached['data']
                    ];
                }
            }
        }

        $built = lorcana_build_event_payload($eventId, $authToken, $allowLocalSslFallback);
        if (empty($built['ok'])) {
            return [
                'ok' => false,
                'error' => $built['error'] ?? 'fetch failed',
                'httpCode' => $built['httpCode'] ?? 0
            ];
        }

        $payload = $built['payload'];
        lorcana_write_cache($eventId, $payload);
        lorcana_mark_event_refreshed($eventId);
        lorcana_set_last_event_id($eventId);
        lorcana_prune_old_caches();

        return ['ok' => true, 'skipped' => false, 'payload' => $payload];
    } finally {
        lorcana_release_lock($lock);
    }
}
