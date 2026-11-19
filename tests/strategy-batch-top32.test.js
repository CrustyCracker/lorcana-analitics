const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    STRATEGY_BATCH_SIZE,
    MAIN1_RUNG_TO_TIE_GOAL,
    MAIN1_TIE_GOAL_AMBITION,
    pickMain1TieGoalByRank,
    pickMain1BatchTieGoalForPlayer,
    resolveBatchTieGoalForPlayer,
    getStrategyBatchCohort,
    getStrategyBatchWindow,
    formatStrategyBatchRange,
    resetStrategyBatchState,
    getStrategyBatchState,
    applyTieGoalToCutUi,
    getTieGoalKeysForMode,
    TIE_GOAL_PRESETS
} = require('../app.js');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const testsHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function makeEl(id) {
    return {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
        disabled: false,
        style: { display: '' },
        classList: {
            _set: new Set(),
            toggle(name, on) {
                if (on) this._set.add(name);
                else this._set.delete(name);
            },
            contains(name) { return this._set.has(name); }
        },
        setAttribute() {},
        getAttribute() { return null; },
        querySelector(sel) {
            if (sel === '.strategy-batch-btn-label') {
                if (!this._label) this._label = { textContent: 'Strategia ×32' };
                return this._label;
            }
            return null;
        },
        querySelectorAll() { return []; },
        addEventListener() {}
    };
}

function makeDomStub() {
    const els = new Map();
    global.document = {
        getElementById(id) {
            if (!els.has(id)) els.set(id, makeEl(id));
            return els.get(id);
        },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
    for (const id of [
        'cutSize', 'cutRule', 'tieGoalHint', 'tieGoalPicker',
        'strategyBatchBtn', 'strategyBatchProgress', 'strategyBatchGoalHint',
        'frontSoftEucHost', 'softEucPlayHint', 'eventId', 'tournamentSwitcher',
        'cutPrefsHint', 'bracketDrawSize', 'bracketDrawHint'
    ]) {
        els.set(id, makeEl(id));
    }
    els.get('cutSize').value = '8';
    els.get('cutRule').value = 'hard';
    return { els };
}

function makeStandings(n) {
    const fake = [];
    for (let i = 1; i <= n; i++) {
        fake.push({
            liveRank: i,
            player: { id: 'id' + i, best_identifier: 'P' + i },
            match_points: 40 - Math.floor(i / 2)
        });
    }
    return fake;
}

describe('Batch optymalna strategia — okna po 32', () => {
    beforeEach(() => {
        makeDomStub();
        resetStrategyBatchState();
    });

    it('UI + cache-bust w index i /tests (paczka 32 / następne okno)', () => {
        assert.match(indexHtml, /id="strategyBatchBtn"/);
        assert.match(indexHtml, /id="strategyBatchProgress"/);
        assert.match(indexHtml, /kolejne z Top 32/);
        assert.match(indexHtml, /paczka 32/);
        assert.match(indexHtml, /runNextTop32Strategy/);
        assert.match(indexHtml, /Następne 32|#33–64/);
        assert.match(indexHtml, /app\.js\?v=20261119top32strat3/);
        assert.match(testsHtml, /id="strategyBatchBtn"/);
        assert.match(testsHtml, /paczka 32/);
        assert.match(testsHtml, /app\.js\?v=20261119top32strat3/);
        // Batch finish must not call selectPlayerForTie (that scrolls to Can I Tie).
        const appSrc = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
        const batchFn = appSrc.slice(
            appSrc.indexOf('async function runNextTop32Strategy'),
            appSrc.indexOf('function roundsOverrideStorageKey')
        );
        assert.doesNotMatch(batchFn, /selectPlayerForTie\s*\(/);
        assert.match(appSrc, /scrollToTie/);
        assert.equal(STRATEGY_BATCH_SIZE, 32);
        assert.equal(formatStrategyBatchRange(0, 32), '#1–32');
        assert.equal(formatStrategyBatchRange(32, 64), '#33–64');
    });

    it('mapowanie MAIN1 rung → cel (T8/T16/EUC/Gaston)', () => {
        assert.equal(MAIN1_RUNG_TO_TIE_GOAL.t8, 'top8');
        assert.equal(MAIN1_RUNG_TO_TIE_GOAL.t16, 'top16');
        assert.equal(MAIN1_RUNG_TO_TIE_GOAL.inv, 'continentals');
        assert.equal(MAIN1_RUNG_TO_TIE_GOAL.t64, 'gaston');
        assert.deepEqual([...MAIN1_TIE_GOAL_AMBITION], ['top8', 'top16', 'continentals', 'gaston']);
        assert.deepEqual(getTieGoalKeysForMode('MAIN1'), ['top8', 'top16', 'continentals', 'gaston']);
        assert.equal(TIE_GOAL_PRESETS.continentals.cutRule, 'soft');
        assert.equal(TIE_GOAL_PRESETS.gaston.cutSize, 64);
    });

    it('heurystyka rank MAIN1: Top8 / Top16 / soft32 / soft64', () => {
        assert.equal(pickMain1TieGoalByRank(1), 'top8');
        assert.equal(pickMain1TieGoalByRank(8), 'top8');
        assert.equal(pickMain1TieGoalByRank(9), 'top16');
        assert.equal(pickMain1TieGoalByRank(16), 'top16');
        assert.equal(pickMain1TieGoalByRank(17), 'continentals');
        assert.equal(pickMain1TieGoalByRank(32), 'continentals');
        assert.equal(pickMain1TieGoalByRank(40), 'gaston');
    });

    it('pickMain1BatchTieGoalForPlayer używa rank gdy brak prize API / eval', () => {
        assert.equal(
            pickMain1BatchTieGoalForPlayer({ liveRank: 12, player: { id: 'p12' } }, 'p12'),
            'top16'
        );
        assert.equal(
            pickMain1BatchTieGoalForPlayer({ liveRank: 28, player: { id: 'p28' } }, 'p28'),
            'continentals'
        );
    });

    it('MAIN2 / other: resolveBatchTieGoalForPlayer trzyma picker (nie wymusza Top8)', () => {
        applyTieGoalToCutUi('top32', { triggerRecalc: false });
        const main2 = resolveBatchTieGoalForPlayer({ liveRank: 5, player: { id: 'x' } }, 'MAIN2');
        assert.equal(main2.goalKey, 'top32');
        assert.equal(main2.source, 'picker');

        applyTieGoalToCutUi('top4', { triggerRecalc: false });
        const other = resolveBatchTieGoalForPlayer({ liveRank: 3, player: { id: 'y' } }, 'CCQ');
        assert.equal(other.goalKey, 'top4');
    });

    it('getStrategyBatchWindow: #1–32 potem #33–64', () => {
        const app = require('../app.js');
        app.setLatestDataForTest({
            eventId: 999002,
            standings: { standings: makeStandings(70) }
        });
        resetStrategyBatchState();

        const first = getStrategyBatchWindow(0, 32);
        assert.equal(first.players.length, 32);
        assert.equal(first.start, 0);
        assert.equal(first.end, 32);
        assert.equal(String(first.players[0].player.id), 'id1');
        assert.equal(String(first.players[31].player.id), 'id32');
        assert.equal(first.maxWindow, 2);

        const second = getStrategyBatchWindow(1, 32);
        assert.equal(second.players.length, 32);
        assert.equal(second.start, 32);
        assert.equal(second.end, 64);
        assert.equal(String(second.players[0].player.id), 'id33');
        assert.equal(String(second.players[31].player.id), 'id64');

        const third = getStrategyBatchWindow(2, 32);
        assert.equal(third.players.length, 6);
        assert.equal(third.start, 64);
        assert.equal(third.end, 70);
        assert.equal(String(third.players[0].player.id), 'id65');

        const cohort = getStrategyBatchCohort(32);
        assert.equal(cohort.length, 32);
        assert.equal(String(cohort[0].player.id), 'id1');
        assert.equal(getStrategyBatchState().windowIndex, 0);
    });
});
