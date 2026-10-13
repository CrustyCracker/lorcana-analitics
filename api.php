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
$cacheTime = 15;

// Parametr nocache dozwolony wyłącznie z localhosta, aby zapobiec atakom DoS omijającym cache
$noCache = isset($_GET['nocache']) && $isLocalRequest;
if (!$noCache && file_exists($cacheFile) && (time() - filemtime($cacheFile) < $cacheTime)) {
    @file_put_contents($lastEventFile, (string)$eventId, LOCK_EX);
    echo file_get_contents($cacheFile);
    exit;
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

$standingsData = null;
if ($standingsRoundId) {
    $safeStandingsRoundId = (int)$standingsRoundId;
    $standingsUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{$safeStandingsRoundId}/standings/";
    $standingsRes = fetchUrlWithStatus($standingsUrl, null, $isLocalRequest);
    $standingsData = json_decode($standingsRes['body'], true);
}

$pairingsData = null;
if ($pairingsRoundId) {
    $safePairingsRoundId = (int)$pairingsRoundId;
    $matchesPaginatedUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{$safePairingsRoundId}/matches/paginated/?page=1&page_size=150&avoid_cache=false";
    $resMatches = fetchUrlWithStatus($matchesPaginatedUrl, $authToken, $isLocalRequest);
    $pairingsData = json_decode($resMatches['body'], true);
}

$roundsMatches = [];
if (!empty($eligibleRounds)) {
    ksort($eligibleRounds);
    foreach ($eligibleRounds as $rNum => $rInfo) {
        $safeRoundId = (int)$rInfo['id'];
        if ($pairingsRoundId && $safeRoundId === (int)$pairingsRoundId && $pairingsData) {
            $roundsMatches[$rNum] = [
                'round_number' => $rNum,
                'round_id' => $safeRoundId,
                'status' => $rInfo['status'],
                'matches' => $pairingsData['results'] ?? $pairingsData['data'] ?? $pairingsData
            ];
        } else {
            $mUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{$safeRoundId}/matches/paginated/?page=1&page_size=150&avoid_cache=false";
            $mRes = fetchUrlWithStatus($mUrl, $authToken, $isLocalRequest);
            $mData = json_decode($mRes['body'], true);
            if ($mData) {
                $roundsMatches[$rNum] = [
                    'round_number' => $rNum,
                    'round_id' => $safeRoundId,
                    'status' => $rInfo['status'],
                    'matches' => $mData['results'] ?? $mData['data'] ?? $mData
                ];
            }
        }
    }
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

file_put_contents($cacheFile, json_encode($result), LOCK_EX);
echo json_encode($result);
?>