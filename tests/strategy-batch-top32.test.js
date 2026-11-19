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
                if (!this._label) this._label = { textContent: 'Strategia Top 32' };
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

describe('Batch optymalna strategia — Top 32', () => {
    beforeEach(() => {
        makeDomStub();
        resetStrategyBatchState();
    });

    it('UI + cache-bust w index i /tests', () => {
        assert.match(indexHtml, /id="strategyBatchBtn"/);
        assert.match(indexHtml, /id="strategyBatchProgress"/);
        assert.match(indexHtml, /kolejne z Top 32/);
        assert.match(indexHtml, /runNextTop32Strategy/);
        assert.match(indexHtml, /app\.js\?v=20261119top32strat1/);
        assert.match(testsHtml, /id="strategyBatchBtn"/);
        assert.match(testsHtml, /kolejne z Top 32/);
        assert.match(testsHtml, /app\.js\?v=20261119top32strat1/);
        assert.equal(STRATEGY_BATCH_SIZE, 32);
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

    it('getStrategyBatchCohort bierze pierwsze 32 z kolejności tabeli', () => {
        const fake = [];
        for (let i = 1; i <= 40; i++) {
            fake.push({
                liveRank: i,
                player: { id: 'id' + i, best_identifier: 'P' + i },
                match_points: 30 - Math.floor(i / 2)
            });
        }
        const app = require('../app.js');
        // cachedLiveStandings starts empty in Node — cohort falls back to latestData.standings
        app.setLatestDataForTest({
            eventId: 999001,
            standings: { standings: fake }
        });
        resetStrategyBatchState();
        const cohort = getStrategyBatchCohort(32);
        assert.equal(cohort.length, 32);
        assert.equal(String(cohort[0].player.id), 'id1');
        assert.equal(String(cohort[31].player.id), 'id32');
        assert.equal(getStrategyBatchState().cursor, -1);
    });
});
