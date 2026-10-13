const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const PHP_BIN = 'c:\\xampp\\php\\php.exe';
const WEBHOOK_SCRIPT = path.join(__dirname, '..', 'webhook.php');
const SECRET_FILE = path.join(__dirname, '..', 'webhook_secret.txt');
const SUBS_FILE = path.join(__dirname, '..', 'marketplace_subscriptions.json');
const LOG_FILE = path.join(__dirname, '..', 'webhook_log.json');

const TEST_SECRET = 'lorcana_test_secret_key_12345';

function callWebhook({ method = 'GET', queryString = '', headers = {}, body = '' }) {
    const env = {
        ...process.env,
        REQUEST_METHOD: method,
        QUERY_STRING: queryString,
        CONTENT_LENGTH: Buffer.byteLength(body, 'utf8').toString(),
        CONTENT_TYPE: 'application/json',
        REMOTE_ADDR: '127.0.0.1',
        GITHUB_MARKETPLACE_WEBHOOK_SECRET: TEST_SECRET
    };

    for (const [key, val] of Object.entries(headers)) {
        const headerKey = 'HTTP_' + key.toUpperCase().replace(/-/g, '_');
        env[headerKey] = val;
    }

    const res = spawnSync(PHP_BIN, [WEBHOOK_SCRIPT], {
        env,
        input: body,
        encoding: 'utf8'
    });

    const output = res.stdout || '';
    // Wyciągamy ciało odpowiedzi JSON (po ewentualnych nagłówkach HTTP wygenerowanych przez PHP)
    const jsonMatch = output.match(/\{[\s\S]*\}$/);
    let parsed = null;
    if (jsonMatch) {
        try {
            parsed = JSON.parse(jsonMatch[0]);
        } catch {}
    }

    return {
        exitCode: res.status,
        rawOutput: output,
        parsed,
        stderr: res.stderr
    };
}

describe('GitHub Marketplace Webhook Handler (webhook.php) Tests', () => {

    before(() => {
        // Zapisujemy testowy secret
        fs.writeFileSync(SECRET_FILE, TEST_SECRET, 'utf8');
        // Czyszczenie tymczasowych subskrypcji
        if (fs.existsSync(SUBS_FILE)) fs.unlinkSync(SUBS_FILE);
        if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
    });

    after(() => {
        // Czyszczenie po testach
        if (fs.existsSync(SECRET_FILE)) fs.unlinkSync(SECRET_FILE);
        if (fs.existsSync(SUBS_FILE)) fs.unlinkSync(SUBS_FILE);
        if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE);
    });

    it('zwraca poprawny status zdrowia (GET ?action=status)', () => {
        const res = callWebhook({ method: 'GET', queryString: 'action=status' });
        assert.equal(res.exitCode, 0);
        assert.ok(res.parsed, 'Odpowiedź musi być prawidłowym JSON-em');
        assert.equal(res.parsed.status, 'ok');
        assert.equal(res.parsed.hasSecretConfigured, true);
        assert.equal(res.parsed.ovhDeployConfigured, true);
    });

    it('obsługuje zdarzenie testowe ping od GitHuba', () => {
        const pingPayload = JSON.stringify({
            zen: 'Practicality beats purity.',
            hook_id: 998877
        });
        const sig = 'sha256=' + crypto.createHmac('sha256', TEST_SECRET).update(pingPayload).digest('hex');

        const res = callWebhook({
            method: 'POST',
            headers: {
                'X-GitHub-Event': 'ping',
                'X-Hub-Signature-256': sig
            },
            body: pingPayload
        });

        assert.equal(res.exitCode, 0);
        assert.ok(res.parsed);
        assert.equal(res.parsed.success, true);
        assert.ok(res.parsed.message.includes('Pong'));
    });

    it('odrzuca zapytanie z niepoprawnym podpisem HMAC (401 Unauthorized)', () => {
        const payload = JSON.stringify({ action: 'purchased' });
        const invalidSig = 'sha256=invalid_hash_value_12345';

        const res = callWebhook({
            method: 'POST',
            headers: {
                'X-GitHub-Event': 'marketplace_purchase',
                'X-Hub-Signature-256': invalidSig
            },
            body: payload
        });

        assert.ok(res.parsed);
        assert.ok(res.parsed.error.includes('Niepoprawny podpis'));
    });

    it('obsługuje zakup nowego planu (action: purchased) i zapisuje subskrypcję klienta', () => {
        const purchasePayload = JSON.stringify({
            action: 'purchased',
            effective_date: '2026-10-13T20:00:00Z',
            sender: { login: 'lorcana_champion', id: 456 },
            marketplace_purchase: {
                account: {
                    id: 456,
                    login: 'lorcana_champion',
                    type: 'User'
                },
                billing_cycle: 'monthly',
                unit_count: 1,
                next_billing_date: '2026-11-13T00:00:00Z',
                plan: {
                    id: 201,
                    name: 'Pro Tier DLC Analytics',
                    description: 'Pełny dostęp do analizy drabinek turniejowych',
                    monthly_price_in_cents: 900
                }
            }
        });
        const sig = 'sha256=' + crypto.createHmac('sha256', TEST_SECRET).update(purchasePayload).digest('hex');

        const res = callWebhook({
            method: 'POST',
            headers: {
                'X-GitHub-Event': 'marketplace_purchase',
                'X-Hub-Signature-256': sig
            },
            body: purchasePayload
        });

        assert.equal(res.exitCode, 0);
        assert.ok(res.parsed);
        assert.equal(res.parsed.success, true);
        assert.equal(res.parsed.action, 'purchased');
        assert.equal(res.parsed.account, 'lorcana_champion');
        assert.equal(res.parsed.plan, 'Pro Tier DLC Analytics');
        assert.equal(res.parsed.status, 'active');

        // Sprawdzamy czy użytkownik figuruje teraz w bazie planów (GET ?action=check_plan)
        const checkRes = callWebhook({
            method: 'GET',
            queryString: 'action=check_plan&user=lorcana_champion'
        });
        assert.equal(checkRes.exitCode, 0);
        assert.ok(checkRes.parsed);
        assert.equal(checkRes.parsed.found, true);
        assert.equal(checkRes.parsed.status, 'active');
        assert.equal(checkRes.parsed.plan.name, 'Pro Tier DLC Analytics');
    });

    it('obsługuje zmianę planu (action: changed - upgrade/downgrade)', () => {
        const changePayload = JSON.stringify({
            action: 'changed',
            effective_date: '2026-10-14T10:00:00Z',
            sender: { login: 'lorcana_champion', id: 456 },
            marketplace_purchase: {
                account: { id: 456, login: 'lorcana_champion', type: 'User' },
                billing_cycle: 'yearly',
                unit_count: 1,
                next_billing_date: '2027-10-14T00:00:00Z',
                plan: {
                    id: 301,
                    name: 'Master Tier (Yearly)',
                    monthly_price_in_cents: 8000
                }
            },
            previous_marketplace_purchase: {
                plan: { id: 201, name: 'Pro Tier DLC Analytics' }
            }
        });
        const sig = 'sha256=' + crypto.createHmac('sha256', TEST_SECRET).update(changePayload).digest('hex');

        const res = callWebhook({
            method: 'POST',
            headers: {
                'X-GitHub-Event': 'marketplace_purchase',
                'X-Hub-Signature-256': sig
            },
            body: changePayload
        });

        assert.equal(res.exitCode, 0);
        assert.ok(res.parsed);
        assert.equal(res.parsed.action, 'changed');
        assert.equal(res.parsed.plan, 'Master Tier (Yearly)');

        // Weryfikacja planu po aktualizacji
        const checkRes = callWebhook({
            method: 'GET',
            queryString: 'action=check_plan&user=lorcana_champion'
        });
        assert.equal(checkRes.parsed.plan.name, 'Master Tier (Yearly)');
        assert.equal(checkRes.parsed.billing_cycle, 'yearly');
    });

    it('obsługuje anulowanie subskrypcji (action: cancelled)', () => {
        const cancelPayload = JSON.stringify({
            action: 'cancelled',
            effective_date: '2026-10-15T00:00:00Z',
            sender: { login: 'lorcana_champion', id: 456 },
            marketplace_purchase: {
                account: { id: 456, login: 'lorcana_champion', type: 'User' },
                plan: { id: 301, name: 'Master Tier (Yearly)' }
            }
        });
        const sig = 'sha256=' + crypto.createHmac('sha256', TEST_SECRET).update(cancelPayload).digest('hex');

        const res = callWebhook({
            method: 'POST',
            headers: {
                'X-GitHub-Event': 'marketplace_purchase',
                'X-Hub-Signature-256': sig
            },
            body: cancelPayload
        });

        assert.equal(res.exitCode, 0);
        assert.ok(res.parsed);
        assert.equal(res.parsed.action, 'cancelled');
        assert.equal(res.parsed.status, 'cancelled');

        // Weryfikacja statusu cancelled
        const checkRes = callWebhook({
            method: 'GET',
            queryString: 'action=check_plan&user=lorcana_champion'
        });
        assert.equal(checkRes.parsed.status, 'cancelled');
    });

});
