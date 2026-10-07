<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    exit;
}

$tokenFile = __DIR__ . '/token.txt';
if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['set_token'])) {
    $newToken = trim($_POST['set_token']);
    if (!empty($newToken)) {
        $newToken = preg_replace('/^authorization:\s*/i', '', $newToken);
        if (!str_starts_with($newToken, 'Token ') && !str_starts_with($newToken, 'Bearer ')) {
            $newToken = 'Token ' . $newToken;
        }
        file_put_contents($tokenFile, $newToken);
        echo json_encode(["success" => true, "message" => "Token został zapisany!"]);
    } else {
        @unlink($tokenFile);
        echo json_encode(["success" => true, "message" => "Token usunięty."]);
    }
    exit;
}

$rawToken = file_exists($tokenFile) ? trim(file_get_contents($tokenFile)) : '';
$rawToken = preg_replace('/^authorization:\s*/i', '', $rawToken);
if (!empty($rawToken) && !str_starts_with($rawToken, 'Token ') && !str_starts_with($rawToken, 'Bearer ')) {
    $rawToken = 'Token ' . $rawToken;
}
$authToken = !empty($rawToken) ? $rawToken : null;

$eventId = isset($_GET['eventId']) ? (int)$_GET['eventId'] : 1074323;
$cacheFile = __DIR__ . '/cache_' . $eventId . '.json';
$cacheTime = 15;

$noCache = isset($_GET['nocache']);
if (!$noCache && file_exists($cacheFile) && (time() - filemtime($cacheFile) < $cacheTime)) {
    echo file_get_contents($cacheFile);
    exit;
}

function fetchUrlWithStatus($url, $token = null) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
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
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    return ['body' => $output, 'code' => $httpCode];
}

$eventUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/events/{$eventId}/";
$eventRes = fetchUrlWithStatus($eventUrl);
$eventData = json_decode($eventRes['body'], true);

if (!$eventData) {
    echo json_encode(["error" => "Nie udało się połączyć z API Lorcany (HTTP {$eventRes['code']})."]);
    exit;
}

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
    $standingsUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{$standingsRoundId}/standings/";
    $standingsRes = fetchUrlWithStatus($standingsUrl);
    $standingsData = json_decode($standingsRes['body'], true);
}

$pairingsData = null;
if ($pairingsRoundId) {
    $matchesPaginatedUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{$pairingsRoundId}/matches/paginated/?page=1&page_size=150&avoid_cache=false";
    $resMatches = fetchUrlWithStatus($matchesPaginatedUrl, $authToken);
    $pairingsData = json_decode($resMatches['body'], true);
}

$roundsMatches = [];
if (!empty($eligibleRounds)) {
    ksort($eligibleRounds);
    foreach ($eligibleRounds as $rNum => $rInfo) {
        if ($pairingsRoundId && $rInfo['id'] == $pairingsRoundId && $pairingsData) {
            $roundsMatches[$rNum] = [
                'round_number' => $rNum,
                'round_id' => $rInfo['id'],
                'status' => $rInfo['status'],
                'matches' => $pairingsData['results'] ?? $pairingsData['data'] ?? $pairingsData
            ];
        } else {
            $mUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{$rInfo['id']}/matches/paginated/?page=1&page_size=150&avoid_cache=false";
            $mRes = fetchUrlWithStatus($mUrl, $authToken);
            $mData = json_decode($mRes['body'], true);
            if ($mData) {
                $roundsMatches[$rNum] = [
                    'round_number' => $rNum,
                    'round_id' => $rInfo['id'],
                    'status' => $rInfo['status'],
                    'matches' => $mData['results'] ?? $mData['data'] ?? $mData
                ];
            }
        }
    }
}

$result = [
    "eventId" => $eventId,
    "eventName" => $eventName,
    "playerCount" => $playerCount,
    "standingsRound" => $standingsRoundNumber,
    "activeRound" => $activeRoundNumber,
    "totalRounds" => $totalRounds,
    "hasTokenConfigured" => !empty($authToken),
    "standings" => $standingsData,
    "pairings" => $pairingsData,
    "roundsMatches" => $roundsMatches
];

file_put_contents($cacheFile, json_encode($result));
echo json_encode($result);
?>