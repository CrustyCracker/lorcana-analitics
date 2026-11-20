<?php
/**
 * ONE-TIME bootstrap: write gitignored admin_pw.hash then self-delete.
 * Do not leave this file on production. Token is single-use intent (remove after).
 * POST fields: token, hash (bcrypt $2y$...). Never send plaintext password here.
 */
declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

const LORCANA_BOOTSTRAP_TOKEN = 'aaabdd0d75957f45daf2853d125483299da90caf68a8451c';

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    http_response_code(405);
    echo json_encode(['error' => 'POST only']);
    exit;
}

$provided = (string)($_POST['token'] ?? ($_SERVER['HTTP_X_BOOTSTRAP_TOKEN'] ?? ''));
if ($provided === '' || !hash_equals(LORCANA_BOOTSTRAP_TOKEN, $provided)) {
    http_response_code(403);
    echo json_encode(['error' => 'forbidden']);
    exit;
}

$hash = trim((string)($_POST['hash'] ?? ''));
if ($hash === '' || !preg_match('/^\$2[ayb]\$\d{2}\$[A-Za-z0-9\.\/]{53}$/', $hash)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid bcrypt hash']);
    exit;
}

$target = __DIR__ . DIRECTORY_SEPARATOR . 'admin_pw.hash';
$written = @file_put_contents($target, $hash . "\n", LOCK_EX);
if ($written === false) {
    http_response_code(500);
    echo json_encode(['error' => 'write failed', 'path' => 'admin_pw.hash']);
    exit;
}

@chmod($target, 0600);

$selfDeleted = false;
if (@unlink(__FILE__)) {
    $selfDeleted = !is_file(__FILE__);
}

echo json_encode([
    'ok' => true,
    'written_bytes' => $written,
    'self_deleted' => $selfDeleted,
]);
