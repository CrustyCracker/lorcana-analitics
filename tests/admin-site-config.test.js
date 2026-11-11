const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PHP = process.env.PHP_BIN
    || (fs.existsSync('C:\\xampp\\php\\php.exe') ? 'C:\\xampp\\php\\php.exe' : 'php');

describe('Admin site_config (PHP)', () => {
    it('loads defaults and persists activeEventId + algorithm', () => {
        const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lorcana-cfg-'));
        const script = `
<?php
define('LORCANA_CACHE_ROOT', ${JSON.stringify(tmpDir)});
require ${JSON.stringify(path.join(ROOT, 'lib/playhub_cache.php'))};
require ${JSON.stringify(path.join(ROOT, 'lib/site_config.php'))};

$cfg = lorcana_load_site_config();
echo json_encode([
  'algo' => $cfg['predictionAlgorithm'],
  'event' => $cfg['activeEventId'],
]);
echo "\\n";

$saved = lorcana_save_site_config([
  'activeEventId' => 424242,
  'predictionAlgorithm' => 'exact',
  'updatedBy' => 'test',
]);
echo json_encode($saved);
echo "\\n";

$pub = lorcana_public_site_config();
echo json_encode($pub);
echo "\\n";

$ok = password_verify("jebaćm7", LORCANA_ADMIN_PASSWORD_HASH) ? 'pw_ok' : 'pw_bad';
echo $ok, "\\n";

$allow1 = lorcana_allow_forced_refresh(424242, false) ? '1' : '0';
$allow2 = lorcana_allow_forced_refresh(424242, false) ? '1' : '0';
echo $allow1, $allow2, "\\n";
`;
        const phpFile = path.join(tmpDir, 'run.php');
        fs.writeFileSync(phpFile, script, 'utf8');
        const res = spawnSync(PHP, [phpFile], { encoding: 'utf8' });
        assert.equal(res.status, 0, res.stderr || res.stdout);
        const lines = String(res.stdout || '').trim().split(/\r?\n/);
        assert.ok(lines.length >= 4, 'expected php output lines, got: ' + res.stdout);

        const defaults = JSON.parse(lines[0]);
        assert.equal(defaults.algo, 'hybrid');

        const saved = JSON.parse(lines[1]);
        assert.equal(saved.activeEventId, 424242);
        assert.equal(saved.predictionAlgorithm, 'exact');

        const pub = JSON.parse(lines[2]);
        assert.equal(pub.activeEventId, 424242);
        assert.equal(pub.predictionAlgorithm, 'exact');
        assert.ok(!('password' in pub));

        assert.equal(lines[3], 'pw_ok');
        // First forced refresh allowed, immediate second throttled.
        assert.equal(lines[4], '10');

        // Persist file exists and is JSON
        const cfgPath = path.join(tmpDir, 'site_config.json');
        assert.ok(fs.existsSync(cfgPath));
        const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.equal(disk.activeEventId, 424242);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});
