<?php
header('Content-Type: application/json');

$eventId = isset($_GET['eventId']) ? (int)$_GET['eventId'] : 1074323;
$cacheFile = 'cache_' . $eventId . '.json';
$cacheTime = 25; 

if (file_exists($cacheFile) && (time() - filemtime($cacheFile) < $cacheTime)) {
    echo file_get_contents($cacheFile);
    exit;
}

function fetchUrl($url) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
    curl_setopt($ch, CURLOPT_USERAGENT, 'LorcanaTracker/2.0');
    $output = curl_exec($ch);
    curl_close($ch);
    return $output;
}

$eventUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/events/{$eventId}/";
$eventData = json_decode(fetchUrl($eventUrl), true);

if (!$eventData) {
    echo json_encode(["error" => "Nie udało się połączyć z API Lorcany."]);
    exit;
}

$eventName = isset($eventData['name']) ? $eventData['name'] : 'Nieznany Event';
$playerCount = isset($eventData['registered_user_count']) ? $eventData['registered_user_count'] : 0;

$roundId = null;
$currentRoundNumber = 0;
$totalRounds = 0;

if (isset($eventData['tournament_phases'])) {
    foreach ($eventData['tournament_phases'] as $phase) {
        if (isset($phase['rounds']) && is_array($phase['rounds'])) {
            $totalRounds = max($totalRounds, count($phase['rounds']));
            foreach ($phase['rounds'] as $round) {
                if (isset($round['standings_status']) && $round['standings_status'] === 'GENERATED') {
                    if ($round['round_number'] > $currentRoundNumber) {
                        $roundId = $round['id'];
                        $currentRoundNumber = $round['round_number'];
                    }
                }
            }
        }
    }
}

if (!$roundId) {
    echo json_encode(["error" => "Turniej zlokalizowany, ale rundy nie mają jeszcze wyników.", "playerCount" => $playerCount]);
    exit;
}

$standingsUrl = "https://api.cloudflare.ravensburgerplay.com/hydraproxy/api/v2/tournament-rounds/{$roundId}/standings/";
$standingsData = json_decode(fetchUrl($standingsUrl), true);

$result = [
    "eventId" => $eventId,
    "eventName" => $eventName,
    "playerCount" => $playerCount,
    "currentRound" => $currentRoundNumber,
    "totalRounds" => $totalRounds,
    "standings" => $standingsData
];

file_put_contents($cacheFile, json_encode($result));
echo json_encode($result);
?>