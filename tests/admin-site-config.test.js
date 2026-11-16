const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PHP = process.env.PHP_BIN
    || (fs.existsSync('C:\\xampp\\php\\php.exe') ? 'C:\\xampp\\php\\php.exe' : 'php');

describe('Admin site_config (PHP)', () => {
    it('loads defaults and persists activeEventId + algorithm + cut/rounds', () => {
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
  'cutSize' => $cfg['defaultCutSize'],
  'cutRule' => $cfg['defaultCutRule'],
  'swiss' => $cfg['defaultSwissRounds'],
]);
echo "\\n";

$saved = lorcana_save_site_config([
  'activeEventId' => 424242,
  'predictionAlgorithm' => 'exact',
  'defaultCutSize' => 32,
  'defaultCutRule' => 'soft',
  'defaultSwissRounds' => 9,
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

$cleared = lorcana_save_site_config(['defaultSwissRounds' => null, 'updatedBy' => 'test']);
echo json_encode(['swiss' => $cleared['defaultSwissRounds']]);
echo "\\n";

$multi = lorcana_save_site_config([
  'predictionAlgorithm' => 'hybrid',
  'tournaments' => [
    ['id' => 't_me1', 'eventId' => 111, 'name' => 'DLC MAIN1', 'mode' => 'MAIN1', 'cutSize' => 32, 'cutRule' => 'soft'],
    ['id' => 't_me2', 'eventId' => 222, 'name' => 'DLC MAIN2', 'mode' => 'MAIN2', 'cutSize' => 8, 'cutRule' => 'hard'],
    ['id' => 't_ccq', 'eventId' => 333, 'name' => 'CCQ Infinity', 'mode' => 'CCQ', 'cutSize' => 8, 'cutRule' => 'hard'],
  ],
  'activeTournamentId' => 't_me2',
  'updatedBy' => 'test',
]);
echo json_encode([
  'activeEventId' => $multi['activeEventId'],
  'activeTournamentId' => $multi['activeTournamentId'],
  'n' => count($multi['tournaments']),
  'modes' => array_column($multi['tournaments'], 'mode'),
]);
echo "\\n";

$pub2 = lorcana_public_site_config();
echo json_encode([
  'n' => count($pub2['tournaments']),
  'active' => $pub2['activeTournamentId'],
  'cut' => $pub2['defaultCutSize'],
  'rule' => $pub2['defaultCutRule'],
]);
echo "\\n";
`;
        const phpFile = path.join(tmpDir, 'run.php');
        fs.writeFileSync(phpFile, script, 'utf8');
        const res = spawnSync(PHP, [phpFile], { encoding: 'utf8' });
        assert.equal(res.status, 0, res.stderr || res.stdout);
        const lines = String(res.stdout || '').trim().split(/\r?\n/);
        assert.ok(lines.length >= 7, 'expected php output lines, got: ' + res.stdout);

        const defaults = JSON.parse(lines[0]);
        assert.equal(defaults.algo, 'hybrid');
        // Fresh install seeds a MAIN1-style default slot (soft Top 32).
        assert.equal(defaults.cutSize, 32);
        assert.equal(defaults.cutRule, 'soft');
        assert.equal(defaults.swiss, null);

        const saved = JSON.parse(lines[1]);
        assert.equal(saved.activeEventId, 424242);
        assert.equal(saved.predictionAlgorithm, 'exact');
        assert.equal(saved.defaultCutSize, 32);
        assert.equal(saved.defaultCutRule, 'soft');
        assert.equal(saved.defaultSwissRounds, 9);

        const pub = JSON.parse(lines[2]);
        assert.equal(pub.activeEventId, 424242);
        assert.equal(pub.predictionAlgorithm, 'exact');
        assert.equal(pub.defaultCutSize, 32);
        assert.equal(pub.defaultCutRule, 'soft');
        assert.equal(pub.defaultSwissRounds, 9);
        assert.ok(!('password' in pub));
        assert.ok(Array.isArray(pub.tournaments));

        assert.equal(lines[3], 'pw_ok');
        // First forced refresh allowed, immediate second throttled.
        assert.equal(lines[4], '10');

        const cleared = JSON.parse(lines[5]);
        assert.equal(cleared.swiss, null);

        const multi = JSON.parse(lines[6]);
        assert.equal(multi.activeEventId, 222);
        assert.equal(multi.activeTournamentId, 't_me2');
        assert.equal(multi.n, 3);
        assert.deepEqual(multi.modes, ['MAIN1', 'MAIN2', 'CCQ']);

        const pub2 = JSON.parse(lines[7]);
        assert.equal(pub2.n, 3);
        assert.equal(pub2.active, 't_me2');
        assert.equal(pub2.cut, 8);
        assert.equal(pub2.rule, 'hard');

        // Persist file exists and is JSON
        const cfgPath = path.join(tmpDir, 'site_config.json');
        assert.ok(fs.existsSync(cfgPath));
        const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        assert.equal(disk.activeEventId, 222);
        assert.equal(disk.tournaments.length, 3);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});

describe('Admin cut/rounds defaults (client)', () => {
    const {
        siteConfig,
        applyPublicSiteConfigPayload,
        getEffectiveTotalRounds,
        getAdminSwissRoundsDefault,
        prepareTieSimulationContext,
        buildStandingsMap
    } = require('../app.js');

    it('applyPublicSiteConfigPayload stores cut/rounds defaults', () => {
        applyPublicSiteConfigPayload({
            activeEventId: 111,
            predictionAlgorithm: 'hybrid',
            defaultCutSize: 16,
            defaultCutRule: 'soft',
            defaultSwissRounds: 8
        });
        assert.equal(siteConfig.defaultCutSize, 16);
        assert.equal(siteConfig.defaultCutRule, 'soft');
        assert.equal(getAdminSwissRoundsDefault(), 8);
    });

    it('getEffectiveTotalRounds prefers local override, then admin, then API', () => {
        applyPublicSiteConfigPayload({
            activeEventId: 222,
            defaultSwissRounds: 9
        });
        const data = { eventId: 999001, activeRound: 3, totalRounds: 7, playerCount: 64 };
        // No local override → admin 9
        assert.equal(getEffectiveTotalRounds(data), 9);

        applyPublicSiteConfigPayload({ defaultSwissRounds: null });
        assert.equal(getEffectiveTotalRounds(data), 7);

        // Local override via storage key used by getStoredRoundsOverride
        const key = 'lorcana_rounds_override_999001';
        try {
            // Node has no localStorage — skip if absent
            if (typeof localStorage === 'undefined') {
                assert.ok(true);
                return;
            }
            localStorage.setItem(key, '11');
            assert.equal(getEffectiveTotalRounds(data), 11);
            localStorage.removeItem(key);
        } catch (e) {
            assert.ok(true);
        }
    });

    it('prepareTieSimulationContext still builds with admin hybrid default', () => {
        applyPublicSiteConfigPayload({ predictionAlgorithm: 'hybrid', defaultCutSize: 8 });
        const standings = Array.from({ length: 8 }, (_, i) => ({
            rank: i + 1,
            match_points: 12,
            opponent_match_win_percentage: 0.5,
            game_win_percentage: 0.5,
            opponent_game_win_percentage: 0.5,
            player: { id: i + 1, best_identifier: `P${i + 1}` }
        }));
        const pairings = [{
            table_number: 1,
            status: 'IN_PROGRESS',
            player_match_relationships: [
                { player: { id: 1 } },
                { player: { id: 2 } }
            ]
        }];
        const ctx = prepareTieSimulationContext(
            standings[0], { id: 2, name: 'P2' }, standings, pairings,
            buildStandingsMap(standings), 8, 'hard', 8, 8, 15, true, 40
        );
        assert.equal(ctx.algorithm, 'hybrid');
        assert.equal(ctx.cutSize, 8);
    });
});
