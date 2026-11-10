<?php
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');

$requestMethod = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($requestMethod === 'OPTIONS') {
    exit;
}

$remoteIp = $_SERVER['REMOTE_ADDR'] ?? '';
$isLocalRequest = in_array($remoteIp, ['127.0.0.1', '::1'], true)
    || ($remoteIp !== '' && filter_var($remoteIp, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false);

$tokenFile = __DIR__ . '/token.txt';
if ($requestMethod === 'POST' && isset($_POST['set_token'])) {
    $expectedAdminKey = getenv('LORCANA_ADMIN_KEY');
    $providedAdminKey = $_POST['admin_key'] ?? ($_SERVER['HTTP_X_ADMIN_KEY'] ?? '');
    $isAuthorizedAdmin = $isLocalRequest || (!empty($expectedAdminKey) && hash_equals($expectedAdminKey, (string)$providedAdminKey));

    if (!$isAuthorizedAdmin) {
        http_response_code(403);
        echo json_encode(["error" => "Brak uprawnień do modyfikacji tokenu autoryzacyjnego."]);
        exit;
    }

    $newToken = trim((string)$_POST['set_token']);
    if (!empty($newToken)) {
        $newToken = preg_replace('/[\r\n]+/', '', $newToken);
        $newToken = preg_replace('/^authorization:\s*/i', '', $newToken);
        if (!str_starts_with($newToken, 'Token ') && !str_starts_with($newToken, 'Bearer ')) {
            $newToken = 'Token ' . $newToken;
        }
        file_put_contents($tokenFile, $newToken, LOCK_EX);
        @chmod($tokenFile, 0600);
        echo json_encode(["success" => true, "message" => "Token został zapisany!"]);
    } else {
        @unlink($tokenFile);
        echo json_encode(["success" => true, "message" => "Token usunięty."]);
    }
    exit;
}

$rawToken = file_exists($tokenFile) ? trim((string)file_get_contents($tokenFile)) : '';
$rawToken = preg_replace('/[\r\n]+/', '', $rawToken);
$rawToken = preg_replace('/^authorization:\s*/i', '', $rawToken);
if (!empty($rawToken) && !str_starts_with($rawToken, 'Token ') && !str_starts_with($rawToken, 'Bearer ')) {
    $rawToken = 'Token ' . $rawToken;
}
$authToken = !empty($rawToken) ? $rawToken : null;

$lastEventFile = __DIR__ . '/last_event.txt';
$defaultEventId = file_exists($lastEventFile) ? (int)trim((string)file_get_contents($lastEventFile)) : 873264;
if ($defaultEventId <= 0) {
    $defaultEventId = 873264;
}

if (isset($_GET['action']) && $_GET['action'] === 'get_last_event') {
    echo json_encode(["lastEventId" => $defaultEventId]);
    exit;
}

$eventId = isset($_GET['eventId']) ? filter_var($_GET['eventId'], FILTER_VALIDATE_INT) : $defaultEventId;
if ($eventId === false || $eventId <= 0 || $eventId > 999999999) {
    http_response_code(400);
    echo json_encode(["error" => "Nieprawidłowy identyfikator turnieju (eventId)."]);
    exit;
}

$cacheFile = __DIR__ . '/cache_' . $eventId . '.json';
// Domyślny TTL; dla dużych eventów wydłużamy, żeby cold-load nie walił Hydraproxy przy każdym odświeżeniu.
$cacheTime = 20;

// Parametr nocache dozwolony wyłącznie z localhosta, aby zapobiec atakom DoS omijającym cache
$noCache = isset($_GET['nocache']) && $isLocalRequest;
if (!$noCache && file_exists($cacheFile)) {
    $age = time() - filemtime($cacheFile);
    $rawCached = (string)@file_get_contents($cacheFile);
    $cachedHint = json_decode($rawCached, true);
    $hintPlayers = is_array($cachedHint) ? (int)($cachedHint['playerCount'] ?? 0) : 0;
    if ($hintPlayers >= 1000) {
        $cacheTime = 45;
    } elseif ($hintPlayers >= 400) {
        $cacheTime = 30;
    }
    if ($age < $cacheTime && $rawCached !== '') {
        @file_put_contents($lastEventFile, (string)$eventId, LOCK_EX);
        header('X-Lorcana-Cache: HIT');
        header('X-Lorcana-Cache-Age: ' . $age);
        echo $rawCached;
        exit;
    }
}

function fetchUrlWithStatus($url, $token = null, $allowLocalSslFallback = false) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_MAXREDIRS, 3);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
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

/** Rozmiar strony Hydraproxy — większy = mniej round-tripów przy cold-load 2k–4k. */
define('LORCANA_MATCH_PAGE_SIZE', 250);
define('LORCANA_MATCH_MAX_PAGES', 40); // 40 * 250 = 10k meczów

function buildMatchesPageUrl($roundId, $page, $pageSize = LORCANA_MATCH_PAGE_SIZE) {
    $safeRoundId = (int)$roundId;
    $page = (int)$page;
    $pageSize = (int)$pageSize;
    return "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{$safeRoundId}/matches/paginated/?page={$page}&page_size={$pageSize}&avoid_cache=false";
}

/**
 * Równoległy GET wielu URL-i (curl_multi). Zwraca mapę key => decoded JSON|null.
 */
function fetchUrlsParallel($urlsByKey, $token = null, $allowLocalSslFallback = false) {
    $out = [];
    if (empty($urlsByKey)) {
        return $out;
    }
    if (!function_exists('curl_multi_init') || count($urlsByKey) === 1) {
        foreach ($urlsByKey as $key => $url) {
            $res = fetchUrlWithStatus($url, $token, $allowLocalSslFallback);
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
        curl_setopt($ch, CURLOPT_TIMEOUT, 12);
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

function extractMatchPageChunk($data) {
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
function fetchAllPaginatedMatches($roundId, $token = null, $allowLocalSslFallback = false) {
    $pageSize = LORCANA_MATCH_PAGE_SIZE;
    $maxPages = LORCANA_MATCH_MAX_PAGES;

    $page1 = fetchUrlsParallel(
        ['p1' => buildMatchesPageUrl($roundId, 1, $pageSize)],
        $token,
        $allowLocalSslFallback
    );
    $data = $page1['p1'] ?? null;
    if (!is_array($data)) {
        return null;
    }

    list($chunk, $kind) = extractMatchPageChunk($data);
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
        // Brak count — dociągamy sekwencyjnie falami (równolegle po odkryciu next).
        $pagesNeeded = 2;
    }
    $pagesNeeded = min($pagesNeeded, $maxPages);

    if ($pagesNeeded > 1) {
        $urls = [];
        for ($p = 2; $p <= $pagesNeeded; $p++) {
            $urls['p' . $p] = buildMatchesPageUrl($roundId, $p, $pageSize);
        }
        $fetched = fetchUrlsParallel($urls, $token, $allowLocalSslFallback);
        foreach ($fetched as $key => $pageData) {
            $pNum = (int)substr($key, 1);
            list($pageChunk, $pageKind) = extractMatchPageChunk($pageData);
            if ($pageKind === 'paged' && is_array($pageChunk) && count($pageChunk) > 0) {
                $pages[$pNum] = $pageChunk;
                $lastPayload = $pageData;
                // Jeśli nie było count i ostatnia strona jest pełna + ma next — dociągamy kolejną falę.
                if ($totalCount === null && count($pageChunk) >= $pageSize && !empty($pageData['next']) && $pNum >= $pagesNeeded && $pagesNeeded < $maxPages) {
                    $extraPage = $pNum + 1;
                    $extra = fetchUrlsParallel(
                        ['p' . $extraPage => buildMatchesPageUrl($roundId, $extraPage, $pageSize)],
                        $token,
                        $allowLocalSslFallback
                    );
                    $extraData = $extra['p' . $extraPage] ?? null;
                    list($extraChunk, $extraKind) = extractMatchPageChunk($extraData);
                    if ($extraKind === 'paged' && is_array($extraChunk) && count($extraChunk) > 0) {
                        $pages[$extraPage] = $extraChunk;
                        $lastPayload = $extraData;
                        $pagesNeeded = $extraPage;
                        // Kontynuuj w pętli while poniżej jeśli nadal next
                        while (
                            $pagesNeeded < $maxPages
                            && is_array($lastPayload)
                            && !empty($lastPayload['next'])
                            && count($pages[$pagesNeeded]) >= $pageSize
                        ) {
                            $nextP = $pagesNeeded + 1;
                            $more = fetchUrlsParallel(
                                ['p' . $nextP => buildMatchesPageUrl($roundId, $nextP, $pageSize)],
                                $token,
                                $allowLocalSslFallback
                            );
                            $moreData = $more['p' . $nextP] ?? null;
                            list($moreChunk, $moreKind) = extractMatchPageChunk($moreData);
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

$eventUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/events/{$eventId}/";
$eventRes = fetchUrlWithStatus($eventUrl, null, $isLocalRequest);
$eventData = json_decode($eventRes['body'], true);

if (!$eventData) {
    echo json_encode(["error" => "Nie udało się połączyć z API Lorcany (HTTP {$eventRes['code']})."]);
    exit;
}

// Zapisujemy ten turniej jako ostatnio wpisany i pomyślnie pobrany turniej domyślny
@file_put_contents($lastEventFile, (string)$eventId, LOCK_EX);

$eventName = $eventData['name'] ?? 'Nieznany Event';
$playerCount = $eventData['registered_user_count'] ?? 0;

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

/**
 * Równoległe pobranie pełnych list meczów dla wielu rund.
 * Fala 1: page=1 wszystkich rund naraz (poznajemy count).
 * Fala 2+: wszystkie brakujące strony wszystkich rund w jednym curl_multi.
 */
function fetchAllPaginatedMatchesForRounds($roundIdsByKey, $token = null, $allowLocalSslFallback = false) {
    $out = [];
    if (empty($roundIdsByKey)) {
        return $out;
    }

    $pageSize = LORCANA_MATCH_PAGE_SIZE;
    $maxPages = LORCANA_MATCH_MAX_PAGES;

    // Fala 1 — pierwsze strony
    $page1Urls = [];
    foreach ($roundIdsByKey as $key => $roundId) {
        $page1Urls[$key] = buildMatchesPageUrl($roundId, 1, $pageSize);
    }
    $page1Data = fetchUrlsParallel($page1Urls, $token, $allowLocalSslFallback);

    $pagesByRound = [];
    $meta = [];
    $moreUrls = [];

    foreach ($roundIdsByKey as $key => $roundId) {
        $data = $page1Data[$key] ?? null;
        list($chunk, $kind) = extractMatchPageChunk($data);
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
            $moreUrls[$key . ':' . $p] = buildMatchesPageUrl($roundId, $p, $pageSize);
        }
    }

    // Fala 2 — pozostałe strony wszystkich rund równolegle
    if (!empty($moreUrls)) {
        $moreData = fetchUrlsParallel($moreUrls, $token, $allowLocalSslFallback);
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
            list($pageChunk, $pageKind) = extractMatchPageChunk($pageData);
            if ($pageKind === 'paged' && is_array($pageChunk) && count($pageChunk) > 0) {
                $pagesByRound[$key][$pNum] = $pageChunk;
                $meta[$key]['lastPayload'] = $pageData;
            }
        }
    }

    // Dociągnięcie braków gdy nie było count (rzadkie) — sekwencyjne fale next
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
            $extra = fetchUrlsParallel(
                [$key . ':' . $nextP => buildMatchesPageUrl($roundId, $nextP, $pageSize)],
                $token,
                $allowLocalSslFallback
            );
            $extraData = $extra[$key . ':' . $nextP] ?? null;
            list($extraChunk, $extraKind) = extractMatchPageChunk($extraData);
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

// Standings + wszystkie rundy meczów: najpierw standings równolegle z page-batch meczów.
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

    // Standings lecą równolegle z pierwszą falą page=1 meczów (oszczędność latency cold-load).
    if ($standingsUrl) {
        $standingsBundle = fetchUrlsParallel(['standings' => $standingsUrl], $authToken, $isLocalRequest);
        $standingsData = $standingsBundle['standings'] ?? null;
    }

    $fetched = fetchAllPaginatedMatchesForRounds($toFetch, $authToken, $isLocalRequest);
    foreach ($toFetch as $rNum => $safeRoundId) {
        $mData = $fetched[$rNum] ?? null;
        if ($mData) {
            $roundsMatches[$rNum] = [
                'round_number' => $rNum,
                'round_id' => $safeRoundId,
                'status' => $eligibleRounds[$rNum]['status'],
                'matches' => $mData['results'] ?? $mData['data'] ?? $mData
            ];
            if ($pairingsRoundId && $safeRoundId === (int)$pairingsRoundId) {
                $pairingsData = $mData;
            }
        }
    }
} elseif ($standingsUrl) {
    $standingsBundle = fetchUrlsParallel(['standings' => $standingsUrl], $authToken, $isLocalRequest);
    $standingsData = $standingsBundle['standings'] ?? null;
}

if ($pairingsRoundId && !$pairingsData) {
    $pairingsData = fetchAllPaginatedMatches($pairingsRoundId, $authToken, $isLocalRequest);
}

$displayStatus = strtolower($eventData['display_status'] ?? '');
$isCompleted = in_array($displayStatus, ['complete', 'completed', 'finished']);

$result = [
    "eventId" => $eventId,
    "lastEventId" => $eventId,
    "eventName" => $eventName,
    "playerCount" => $playerCount,
    "displayStatus" => $displayStatus,
    "isCompleted" => $isCompleted,
    "standingsRound" => $standingsRoundNumber,
    "activeRound" => $activeRoundNumber,
    "totalRounds" => $totalRounds,
    "hasTokenConfigured" => !empty($authToken),
    "standings" => $standingsData,
    "pairings" => $pairingsData,
    "roundsMatches" => $roundsMatches
];

// Automatyczne czyszczenie starych plików cache (ochrona przed zapełnieniem dysku)
$existingCaches = glob(__DIR__ . '/cache_*.json');
if (is_array($existingCaches) && count($existingCaches) > 25) {
    $now = time();
    foreach ($existingCaches as $oldCache) {
        if ($now - @filemtime($oldCache) > 3600) {
            @unlink($oldCache);
        }
    }
}

$payloadJson = json_encode($result);
$tmpCache = $cacheFile . '.tmp.' . getmypid();
if (@file_put_contents($tmpCache, $payloadJson, LOCK_EX) !== false) {
    @rename($tmpCache, $cacheFile);
    @unlink($tmpCache);
} else {
    @file_put_contents($cacheFile, $payloadJson, LOCK_EX);
}
header('X-Lorcana-Cache: MISS');
echo $payloadJson;
?>