const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

function installMinimalDom() {
    const elements = new Map();

    function makeEl(id, tag = 'div') {
        const el = {
            id,
            tagName: String(tag).toUpperCase(),
            style: {},
            dataset: {},
            innerHTML: '',
            innerText: '',
            textContent: '',
            children: [],
            value: '',
            scrollTop: 0,
            clientHeight: 704,
            appendChild(child) {
                this.children.push(child);
                return child;
            },
            setAttribute() {},
            getAttribute() { return null; }
        };
        elements.set(id, el);
        return el;
    }

    makeEl('liveStandingsBody', 'tbody');
    makeEl('officialStandingsBody', 'tbody');
    makeEl('pairingsBody', 'tbody');
    makeEl('liveStandingsViewport', 'div');
    makeEl('liveWindowInfo', 'div');
    makeEl('livePagination', 'div');
    makeEl('officialPagination', 'div');
    makeEl('topCutBracketPanel', 'div');
    makeEl('topCutBracketGrid', 'div');
    makeEl('eventNameDisplay', 'span');
    makeEl('totalPlayersDisplay', 'span');
    makeEl('activeRoundInfo', 'span');
    makeEl('roundsLeftInfo', 'span');
    makeEl('officialRoundNum', 'span');
    makeEl('bubbleScore', 'span');
    makeEl('projectedBubbleScore', 'span');
    makeEl('playersInCut', 'span');
    makeEl('tournamentDrawsInfo', 'span');
    makeEl('cutSize', 'input').value = '4';
    makeEl('cutRule', 'select').value = 'hard';
    makeEl('polishAvgPointsWrap', 'div').style.display = 'none';
    makeEl('polishAvgPointsBody', 'tbody');
    makeEl('cutBreakdownPanel', 'div').style.display = 'none';
    makeEl('cutBreakdownMetricsGrid', 'div');
    makeEl('cutBreakdownBracketsRow', 'div');
    makeEl('breakdownSummarySubtitle', 'div');
    makeEl('breakdownCutSizeLabel', 'span');

    global.document = {
        getElementById(id) {
            return elements.get(id) || null;
        },
        createElement(tag) {
            return {
                tagName: String(tag).toUpperCase(),
                className: '',
                style: {},
                innerHTML: '',
                title: '',
                onclick: null,
                appendChild() { return null; }
            };
        },
        createDocumentFragment() {
            const kids = [];
            return {
                childNodes: kids,
                appendChild(c) { kids.push(c); return c; },
                get innerHTML() {
                    return kids.map(k => k.innerHTML || '').join('');
                }
            };
        }
    };

    global.requestAnimationFrame = (fn) => { fn(); return 1; };
    global.cancelAnimationFrame = () => {};
    global.requestIdleCallback = (fn) => { fn(); return 1; };
    global.cancelIdleCallback = () => {};

    return elements;
}

function standingRow(id, name, pts, rank) {
    return {
        id,
        rank,
        match_points: pts,
        record: '1-0-0',
        match_record: '1-0-0',
        opponent_match_win_percentage: 0.5,
        game_win_percentage: 0.5,
        opponent_game_win_percentage: 0.5,
        player: { id, best_identifier: name },
        user_event_status: { best_identifier: name }
    };
}

describe('Site audit fixes (player count / activeRound 0 / panel clear)', () => {
    let app;
    let elements;

    beforeEach(() => {
        delete require.cache[require.resolve('../app.js')];
        elements = installMinimalDom();
        app = require('../app.js');
    });

    afterEach(() => {
        try { app.bumpUiApplyGeneration(); } catch (e) {}
        delete global.document;
        delete global.requestAnimationFrame;
        delete global.cancelAnimationFrame;
        delete global.requestIdleCallback;
        delete global.cancelIdleCallback;
        delete require.cache[require.resolve('../app.js')];
    });

    it('resolvePlayerCount prefers standings length over truthy meta=1', () => {
        assert.equal(app.resolvePlayerCount({ playerCount: 1 }, 778), 778);
        assert.equal(app.resolvePlayerCount({ playerCount: 205 }, 200), 205);
        assert.equal(app.resolvePlayerCount({ playerCount: 0 }, 19), 19);
        assert.equal(app.resolvePlayerCount({}, 0), 0);
    });

    it('resolveActiveRound preserves 0 instead of coercing to 1', () => {
        assert.equal(app.resolveActiveRound({ activeRound: 0 }), 0);
        assert.equal(app.resolveActiveRound({ activeRound: 3 }), 3);
        assert.equal(app.resolveActiveRound({}), 0);
        assert.equal(app.resolveActiveRound({ activeRound: '2' }), 2);
    });

    it('finished event with playerCount=1 displays standings length (~778)', () => {
        const rows = Array.from({ length: 12 }, (_, i) =>
            standingRow(i + 1, `P${i + 1}`, 30 - i, i + 1)
        );
        const data = {
            eventId: 1233041,
            eventName: 'Bangkok',
            playerCount: 1,
            activeRound: 9,
            standingsRound: 9,
            totalRounds: 9,
            displayStatus: 'complete',
            isCompleted: true,
            pairings: { pairings: [] },
            standings: { standings: rows }
        };
        app.setLastTrackedEventIdForTest('1233041');
        app.processStandings(data);
        assert.equal(elements.get('totalPlayersDisplay').innerText, 12);
        assert.equal(app.resolvePlayerCount(data, 778), 778);
        assert.equal(app.shouldGateHeavyUi(app.resolvePlayerCount({ playerCount: 1 }, 778)), true);
        assert.equal(app.shouldGateHeavyUi(1), false);
    });

    it('upcoming activeRound=0 paints 0/N and Nie rozpoczęty (not 1/N / N z tą)', () => {
        const data = {
            eventId: 876881,
            eventName: 'Upcoming',
            playerCount: 19,
            activeRound: 0,
            standingsRound: 0,
            totalRounds: 5,
            displayStatus: 'upcoming',
            pairings: { pairings: [] },
            standings: null
        };
        app.processStandings(data);
        assert.equal(elements.get('activeRoundInfo').innerText, '0/5');
        assert.match(String(elements.get('roundsLeftInfo').innerText), /Nie rozpoczęty/i);
        assert.doesNotMatch(String(elements.get('roundsLeftInfo').innerText), /z tą/i);
        assert.equal(elements.get('polishAvgPointsWrap').style.display, 'none');
        assert.equal(elements.get('cutBreakdownPanel').style.display, 'none');
    });
});

describe('PHP lorcana_resolve_player_count', () => {
    it('prefers starting_player_count and standings length over registered=1', () => {
        const fs = require('node:fs');
        const os = require('node:os');
        const phpBinCandidates = [
            process.env.PHP_BIN,
            'C:\\xampp\\php\\php.exe',
            'php'
        ].filter(Boolean);
        const fetchLib = path.join(__dirname, '..', 'lib', 'playhub_fetch.php').replace(/\\/g, '/');
        const phpScript = `<?php
require_once '${fetchLib}';
$event = ['registered_user_count' => 1, 'starting_player_count' => 778];
if (lorcana_resolve_player_count($event) !== 778) { fwrite(STDERR, "starting fail\\n"); exit(1); }
$standings = ['standings' => array_fill(0, 12, ['id' => 1])];
if (lorcana_resolve_player_count(['registered_user_count' => 1], $standings) !== 12) { fwrite(STDERR, "standings fail\\n"); exit(1); }
if (lorcana_resolve_player_count(['registered_user_count' => 19, 'starting_player_count' => 0]) !== 19) { fwrite(STDERR, "registered fail\\n"); exit(1); }
echo "ok\\n";
`;
        const tmp = path.join(os.tmpdir(), `lorcana-player-count-${process.pid}.php`);
        fs.writeFileSync(tmp, phpScript, 'utf8');
        let result = null;
        try {
            for (const bin of phpBinCandidates) {
                result = spawnSync(bin, [tmp], { encoding: 'utf8' });
                if (!(result.error && result.error.code === 'ENOENT')) break;
            }
        } finally {
            try { fs.unlinkSync(tmp); } catch (e) {}
        }
        if (result && result.error && result.error.code === 'ENOENT') {
            assert.fail('php binary not found (tried XAMPP + PATH)');
        }
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout || '', /ok/);
    });
});
