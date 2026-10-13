<?php
/**
 * GitHub Marketplace & Deployment Webhook Handler
 * 
 * Obsługuje zdarzenia GitHub Webhook:
 * 1. marketplace_purchase: powiadomienia o zmianach planów kont klientów (purchased, cancelled, changed, pending_change, pending_change_cancelled)
 * 2. ping: test połączenia z GitHub Marketplace / GitHub Webhooks
 * 3. push: automatyczne przekazywanie zdarzenia push do webhooka auto-deploy na hostingu OVHcloud
 */

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: SAMEORIGIN');

$remoteIp = $_SERVER['REMOTE_ADDR'] ?? '';
$isLocalRequest = in_array($remoteIp, ['127.0.0.1', '::1'], true)
    || ($remoteIp !== '' && filter_var($remoteIp, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false);

$subscriptionsFile = __DIR__ . '/marketplace_subscriptions.json';
$logFile = __DIR__ . '/webhook_log.json';
$secretFile = __DIR__ . '/webhook_secret.txt';

// URL do webhooka automatycznego wdrażania Git na hostingu OVHcloud
$ovhDeployWebhookUrl = 'https://webhooks-webhosting.eu.ovhapis.com/1.0/vcs/github/push/eyJhbGciOiJFZERTQSIsImtpZCI6IjEiLCJ0eXAiOiJKV1QifQ.eyJzdWIiOiJnaXRodWIvd3IxMjMwNzktb3ZoIiwiZXhwIjoyNTI0NjA3OTk5LCJqdGkiOiJhMWQ3M2IxZTdlNDNiNmVhNWNjZjRiMmM1MzE5YjFiZjdkOGE3ZDlmIiwidmVyc2lvbiI6MSwibmFtZSI6InZvamtvdnEuY2x1c3RlcjAyMS5ob3N0aW5nLm92aC5uZXQiLCJwYXRoIjoic2l0IiwiY291bnRlciI6MH0.aMaCPdbHXtxvU4lMGZdDf20QYdJGhZDLftNUTYEYW2SUk3-2Y38ifnC3-2Pl4byl20CB05TG2_o9NRT7I2m5Aw';

// Pobieranie webhook secret (ze zmiennej środowiskowej lub z pliku)
$webhookSecret = getenv('GITHUB_MARKETPLACE_WEBHOOK_SECRET') ?: getenv('GITHUB_WEBHOOK_SECRET');
if (empty($webhookSecret) && file_exists($secretFile)) {
    $webhookSecret = trim((string)file_get_contents($secretFile));
}

// -------------------------------------------------------------
// GET Endpointy pomocnicze (status, sprawdzenie planu użytkownika)
// -------------------------------------------------------------
$requestMethod = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if (empty($_GET) && !empty($_SERVER['QUERY_STRING'])) {
    parse_str($_SERVER['QUERY_STRING'], $_GET);
}

if ($requestMethod === 'GET') {
    $action = $_GET['action'] ?? 'status';

    if ($action === 'status') {
        $subs = file_exists($subscriptionsFile) ? json_decode((string)file_get_contents($subscriptionsFile), true) : [];
        $logs = file_exists($logFile) ? json_decode((string)file_get_contents($logFile), true) : [];
        $lastLog = is_array($logs) && !empty($logs) ? end($logs) : null;

        $activeCount = 0;
        if (is_array($subs)) {
            foreach ($subs as $sub) {
                if (($sub['status'] ?? '') === 'active') {
                    $activeCount++;
                }
            }
        }

        echo json_encode([
            "status" => "ok",
            "service" => "Lorcana GitHub Marketplace Webhook Handler",
            "hasSecretConfigured" => !empty($webhookSecret),
            "totalSubscribers" => is_array($subs) ? count($subs) : 0,
            "activeSubscribers" => $activeCount,
            "ovhDeployConfigured" => true,
            "lastEvent" => $lastLog ? [
                "event" => $lastLog['event'] ?? 'unknown',
                "action" => $lastLog['action'] ?? null,
                "timestamp" => $lastLog['timestamp'] ?? null
            ] : null
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        exit;
    }

    if ($action === 'check_plan') {
        $username = trim((string)($_GET['user'] ?? ''));
        if (empty($username)) {
            http_response_code(400);
            echo json_encode(["error" => "Brak parametru 'user'."]);
            exit;
        }

        $subs = file_exists($subscriptionsFile) ? json_decode((string)file_get_contents($subscriptionsFile), true) : [];
        $key = strtolower($username);

        if (isset($subs[$key])) {
            $userSub = $subs[$key];
            echo json_encode([
                "found" => true,
                "user" => $username,
                "status" => $userSub['status'] ?? 'unknown',
                "plan" => $userSub['plan'] ?? null,
                "billing_cycle" => $userSub['billing_cycle'] ?? null,
                "next_billing_date" => $userSub['next_billing_date'] ?? null
            ]);
        } else {
            echo json_encode([
                "found" => false,
                "user" => $username,
                "status" => "none",
                "plan" => null
            ]);
        }
        exit;
    }

    if ($action === 'list_subscriptions') {
        $providedKey = $_GET['admin_key'] ?? ($_SERVER['HTTP_X_ADMIN_KEY'] ?? '');
        $expectedKey = getenv('LORCANA_ADMIN_KEY');
        $authorized = $isLocalRequest || (!empty($expectedKey) && hash_equals($expectedKey, (string)$providedKey));

        if (!$authorized) {
            http_response_code(403);
            echo json_encode(["error" => "Brak uprawnień administratora."]);
            exit;
        }

        $subs = file_exists($subscriptionsFile) ? json_decode((string)file_get_contents($subscriptionsFile), true) : [];
        echo json_encode(["subscriptions" => $subs], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        exit;
    }

    http_response_code(404);
    echo json_encode(["error" => "Nieznana akcja GET."]);
    exit;
}

// -------------------------------------------------------------
// POST: Konfiguracja sekretu przez administratora
// -------------------------------------------------------------
if ($requestMethod === 'POST' && isset($_POST['set_secret'])) {
    $providedKey = $_POST['admin_key'] ?? ($_SERVER['HTTP_X_ADMIN_KEY'] ?? '');
    $expectedKey = getenv('LORCANA_ADMIN_KEY');
    $authorized = $isLocalRequest || (!empty($expectedKey) && hash_equals($expectedKey, (string)$providedKey));

    if (!$authorized) {
        http_response_code(403);
        echo json_encode(["error" => "Brak uprawnień do zmiany sekretu webhooka."]);
        exit;
    }

    $newSecret = trim((string)$_POST['set_secret']);
    if (!empty($newSecret)) {
        file_put_contents($secretFile, $newSecret, LOCK_EX);
        @chmod($secretFile, 0600);
        echo json_encode(["success" => true, "message" => "Sekret webhooka został pomyślnie zapisany."]);
    } else {
        @unlink($secretFile);
        echo json_encode(["success" => true, "message" => "Sekret webhooka usunięty."]);
    }
    exit;
}

// -------------------------------------------------------------
// POST: Ręczne wywołanie deployu na OVH (dla administratora)
// -------------------------------------------------------------
if ($requestMethod === 'POST' && isset($_GET['action']) && $_GET['action'] === 'deploy_ovh') {
    $providedKey = $_POST['admin_key'] ?? ($_SERVER['HTTP_X_ADMIN_KEY'] ?? '');
    $expectedKey = getenv('LORCANA_ADMIN_KEY');
    $authorized = $isLocalRequest || (!empty($expectedKey) && hash_equals($expectedKey, (string)$providedKey));

    if (!$authorized) {
        http_response_code(403);
        echo json_encode(["error" => "Brak uprawnień do wywołania wdrożenia OVH."]);
        exit;
    }

    $ch = curl_init($ovhDeployWebhookUrl);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(["ref" => "refs/heads/main", "manual_trigger" => true]));
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json', 'User-Agent: Lorcana-Analytics-Relay']);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 15);
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    echo json_encode([
        "success" => $httpCode >= 200 && $httpCode < 300,
        "ovh_http_code" => $httpCode,
        "ovh_response" => $response
    ]);
    exit;
}

// -------------------------------------------------------------
// POST: Obsługa zdarzeń GitHub Webhook (Marketplace & Push)
// -------------------------------------------------------------
$rawPayload = file_get_contents('php://input');
if ($rawPayload === false || trim($rawPayload) === '') {
    if (php_sapi_name() === 'cli') {
        $rawPayload = @file_get_contents('php://stdin');
    }
}
if ($rawPayload === false || trim($rawPayload) === '') {
    // Sprawdzenie czy payload przyszedł jako application/x-www-form-urlencoded
    if (isset($_POST['payload'])) {
        $rawPayload = (string)$_POST['payload'];
    }
}

if (empty($rawPayload)) {
    http_response_code(400);
    echo json_encode(["error" => "Brak treści (payload) w zapytaniu webhooka."]);
    exit;
}

// 1. Walidacja podpisu HMAC (X-Hub-Signature-256)
$githubSignature256 = $_SERVER['HTTP_X_HUB_SIGNATURE_256'] ?? '';
$githubSignature = $_SERVER['HTTP_X_HUB_SIGNATURE'] ?? '';

if (!empty($webhookSecret)) {
    $expectedSig256 = 'sha256=' . hash_hmac('sha256', $rawPayload, $webhookSecret);
    $isValid256 = !empty($githubSignature256) && hash_equals($expectedSig256, $githubSignature256);

    $expectedSigSha1 = 'sha1=' . hash_hmac('sha1', $rawPayload, $webhookSecret);
    $isValidSha1 = !empty($githubSignature) && hash_equals($expectedSigSha1, $githubSignature);

    if (!$isValid256 && !$isValidSha1) {
        http_response_code(401);
        echo json_encode(["error" => "Niepoprawny podpis kryptograficzny X-Hub-Signature-256."]);
        exit;
    }
}

$payloadData = json_decode($rawPayload, true);
if (!is_array($payloadData)) {
    http_response_code(400);
    echo json_encode(["error" => "Nieprawidłowy format JSON payloadu."]);
    exit;
}

$githubEvent = strtolower(trim((string)($_SERVER['HTTP_X_GITHUB_EVENT'] ?? 'unknown')));

// Funkcja pomocnicza do zapisu logów
function logWebhookEvent($filePath, $entry) {
    $logs = file_exists($filePath) ? json_decode((string)file_get_contents($filePath), true) : [];
    if (!is_array($logs)) $logs = [];
    $logs[] = $entry;
    // Ograniczenie rozmiaru pliku do ostatnich 100 zdarzeń
    if (count($logs) > 100) {
        $logs = array_slice($logs, -100);
    }
    file_put_contents($filePath, json_encode($logs, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
}

// 2. Obsługa zdarzenia 'ping' (GitHub Healthcheck / Webhook Creation)
if ($githubEvent === 'ping') {
    $zen = $payloadData['zen'] ?? 'Keep it logically awesome.';
    $hookId = $payloadData['hook_id'] ?? null;

    logWebhookEvent($logFile, [
        "timestamp" => date('c'),
        "event" => "ping",
        "hook_id" => $hookId,
        "zen" => $zen
    ]);

    http_response_code(200);
    echo json_encode([
        "success" => true,
        "message" => "Pong! Webhook aktywny i gotowy do odbioru zdarzeń z GitHub Marketplace.",
        "zen" => $zen
    ]);
    exit;
}

// 3. Obsługa zdarzenia 'marketplace_purchase' (Zmiany planów klientów)
if ($githubEvent === 'marketplace_purchase') {
    $action = $payloadData['action'] ?? 'unknown';
    $effectiveDate = $payloadData['effective_date'] ?? date('c');
    $mp = $payloadData['marketplace_purchase'] ?? [];

    $account = $mp['account'] ?? [];
    $accountLogin = $account['login'] ?? ($payloadData['sender']['login'] ?? 'unknown');
    $accountId = $account['id'] ?? 0;
    $accountType = $account['type'] ?? 'User';

    $plan = $mp['plan'] ?? [];
    $planId = $plan['id'] ?? 0;
    $planName = $plan['name'] ?? 'Free';
    $billingCycle = $mp['billing_cycle'] ?? 'monthly';
    $nextBillingDate = $mp['next_billing_date'] ?? null;
    $onFreeTrial = (bool)($mp['on_free_trial'] ?? false);
    $unitCount = $mp['unit_count'] ?? 1;

    // Odczyt istniejących subskrypcji
    $subs = file_exists($subscriptionsFile) ? json_decode((string)file_get_contents($subscriptionsFile), true) : [];
    if (!is_array($subs)) $subs = [];

    $userKey = strtolower($accountLogin);
    $previousEntry = $subs[$userKey] ?? null;

    $subscriptionData = [
        "account_id" => $accountId,
        "account_login" => $accountLogin,
        "account_type" => $accountType,
        "status" => "active",
        "action" => $action,
        "plan" => [
            "id" => $planId,
            "name" => $planName,
            "description" => $plan['description'] ?? '',
            "monthly_price_in_cents" => $plan['monthly_price_in_cents'] ?? 0,
            "yearly_price_in_cents" => $plan['yearly_price_in_cents'] ?? 0
        ],
        "billing_cycle" => $billingCycle,
        "unit_count" => $unitCount,
        "on_free_trial" => $onFreeTrial,
        "effective_date" => $effectiveDate,
        "next_billing_date" => $nextBillingDate,
        "updated_at" => date('c')
    ];

    switch ($action) {
        case 'purchased':
            $subscriptionData['status'] = 'active';
            $subscriptionData['created_at'] = date('c');
            break;

        case 'changed':
            $subscriptionData['status'] = 'active';
            $subscriptionData['previous_plan'] = $payloadData['previous_marketplace_purchase']['plan'] ?? ($previousEntry['plan'] ?? null);
            break;

        case 'cancelled':
            $subscriptionData['status'] = 'cancelled';
            $subscriptionData['cancelled_at'] = date('c');
            break;

        case 'pending_change':
            $subscriptionData['status'] = 'active';
            $subscriptionData['pending_plan'] = $plan;
            $subscriptionData['pending_effective_date'] = $effectiveDate;
            break;

        case 'pending_change_cancelled':
            $subscriptionData['status'] = 'active';
            unset($subscriptionData['pending_plan'], $subscriptionData['pending_effective_date']);
            break;

        default:
            $subscriptionData['status'] = 'unknown';
            break;
    }

    $subs[$userKey] = $subscriptionData;
    file_put_contents($subscriptionsFile, json_encode($subs, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
    @chmod($subscriptionsFile, 0600);

    logWebhookEvent($logFile, [
        "timestamp" => date('c'),
        "event" => "marketplace_purchase",
        "action" => $action,
        "account" => $accountLogin,
        "plan" => $planName,
        "effective_date" => $effectiveDate
    ]);

    http_response_code(200);
    echo json_encode([
        "success" => true,
        "event" => "marketplace_purchase",
        "action" => $action,
        "account" => $accountLogin,
        "plan" => $planName,
        "status" => $subscriptionData['status'],
        "message" => "Pomyślnie zaktualizowano plan konta klienta z GitHub Marketplace."
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    exit;
}

// 4. Obsługa zdarzenia 'push' (Auto-Deploy Relay na OVHcloud)
if ($githubEvent === 'push') {
    // Przekazanie zapytania POST do webhooka auto-deploy na hostingu OVH
    $ch = curl_init($ovhDeployWebhookUrl);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $rawPayload);
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'User-Agent: Lorcana-Analytics-GitHub-Relay',
        'X-GitHub-Event: push'
    ]);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 15);
    $ovhResponse = curl_exec($ch);
    $ovhHttpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    logWebhookEvent($logFile, [
        "timestamp" => date('c'),
        "event" => "push",
        "ref" => $payloadData['ref'] ?? 'unknown',
        "head_commit" => $payloadData['head_commit']['id'] ?? 'unknown',
        "ovh_deploy_http_code" => $ovhHttpCode
    ]);

    http_response_code(200);
    echo json_encode([
        "success" => true,
        "event" => "push",
        "message" => "Zdarzenie push odebrane i przekazane do wdrożenia OVHcloud.",
        "ovh_status_code" => $ovhHttpCode
    ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    exit;
}

// 5. Inne zdarzenia (np. star, watch, fork)
logWebhookEvent($logFile, [
    "timestamp" => date('c'),
    "event" => $githubEvent,
    "sender" => $payloadData['sender']['login'] ?? 'unknown'
]);

http_response_code(200);
echo json_encode([
    "success" => true,
    "event" => $githubEvent,
    "message" => "Zdarzenie odebrane i zalogowane."
]);
exit;
?>
