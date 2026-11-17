const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    TIE_GOAL_PRESETS,
    TIE_GOAL_KEYS_BY_MODE,
    getTieGoalPreset,
    getTieGoalKeysForMode,
    getTieGoalCatalogForMode,
    getDefaultTieGoalKeyForMode,
    resolveTieGoalKey,
    applyTieGoalToCutUi,
    syncTieGoalPickerUi,
    rebuildTieGoalPicker,
    refreshModeDependentTieUi,
    shouldShowSoftEucPanel,
    syncFrontSoftEucHost,
    applyTournamentSelection,
    siteConfig
} = require('../app.js');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function makeEl(id) {
    return {
        id,
        value: '',
        textContent: '',
        innerHTML: '',
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
        getAttribute(name) {
            if (name === 'data-tie-goal') return this._tieGoal || null;
            return null;
        },
        querySelectorAll() { return []; },
        addEventListener() {}
    };
}

function makeDomStub() {
    const els = new Map();
    const buttons = [];
    global.document = {
        getElementById(id) {
            if (!els.has(id)) els.set(id, makeEl(id));
            return els.get(id);
        },
        querySelector(sel) {
            if (sel === '.tie-goal-picker') return this.getElementById('tieGoalPicker');
            return null;
        },
        querySelectorAll(sel) {
            if (sel === '.tie-goal-btn[data-tie-goal]') return buttons;
            return [];
        },
        _buttons: buttons
    };
    for (const id of [
        'cutSize', 'cutRule', 'tieGoalHint', 'tieGoalPicker',
        'frontSoftEucHost', 'softEucPlayHint', 'eventId', 'tournamentSwitcher',
        'cutPrefsHint', 'bracketDrawSize', 'bracketDrawHint'
    ]) {
        els.set(id, makeEl(id));
    }
    return { els, buttons };
}

describe('Can I Tie — cel strategii per tryb (MAIN1 / MAIN2 / other)', () => {
    it('ma otwarty moduł TIE i host pickera w index.html + cache-bust', () => {
        assert.match(indexHtml, /id="tieModule"[^>]*\bopen\b/);
        assert.match(indexHtml, /id="tieGoalPicker"/);
        assert.match(indexHtml, /data-tie-goal="top8"/);
        assert.match(indexHtml, /data-tie-goal="gaston"/);
        assert.match(indexHtml, /id="frontSoftEucHost"/);
        assert.match(indexHtml, /id="playerSearchInput"/);
        assert.match(indexHtml, /app\.js\?v=20261117inkcache2/);
    });

    it('katalog MAIN1: Top8/Top16 hard + Continentals soft32 + Gaston soft64', () => {
        assert.deepEqual(getTieGoalKeysForMode('MAIN1'), ['top8', 'top16', 'continentals', 'gaston']);
        assert.deepEqual(getTieGoalKeysForMode('ME1'), ['top8', 'top16', 'continentals', 'gaston']);
        assert.deepEqual([...TIE_GOAL_KEYS_BY_MODE.MAIN1], ['top8', 'top16', 'continentals', 'gaston']);

        const cat = getTieGoalCatalogForMode('MAIN1');
        assert.equal(cat.length, 4);
        assert.equal(cat[0].cutSize, 8);
        assert.equal(cat[0].cutRule, 'hard');
        assert.match(cat[1].label, /Top 16.*mata/i);
        assert.equal(cat[1].cutRule, 'hard');
        assert.equal(cat[2].key, 'continentals');
        assert.equal(cat[2].cutSize, 32);
        assert.equal(cat[2].cutRule, 'soft');
        assert.equal(cat[3].key, 'gaston');
        assert.equal(cat[3].cutSize, 64);
        assert.equal(cat[3].cutRule, 'soft');
        assert.equal(getDefaultTieGoalKeyForMode('MAIN1'), 'top8');
    });

    it('katalog MAIN2: Top8 hard (EUC) + Top32 hard (Madam Mim); bez soft', () => {
        assert.deepEqual(getTieGoalKeysForMode('MAIN2'), ['top8', 'top32']);
        assert.deepEqual(getTieGoalKeysForMode('ME2'), ['top8', 'top32']);
        const cat = getTieGoalCatalogForMode('MAIN2');
        assert.equal(cat.length, 2);
        assert.equal(cat[0].cutSize, 8);
        assert.equal(cat[0].cutRule, 'hard');
        assert.match(cat[0].sub, /EUC/i);
        assert.equal(cat[1].cutSize, 32);
        assert.equal(cat[1].cutRule, 'hard');
        assert.match(cat[1].sub, /Madam Mim/i);
        assert.ok(!cat.some((g) => g.cutRule === 'soft'));
    });

    it('katalog other/CCQ/custom: Top2–Top32 all hard', () => {
        for (const mode of ['CCQ', 'custom', 'INFINITY', 'other']) {
            const keys = getTieGoalKeysForMode(mode);
            assert.deepEqual(keys, ['top2', 'top4', 'top8', 'top16', 'top32']);
            const cat = getTieGoalCatalogForMode(mode);
            assert.equal(cat.length, 5);
            assert.ok(cat.every((g) => g.cutRule === 'hard'));
        }
    });

    it('resolveTieGoalKey mapuje cutSize/cutRule (w tym gaston soft64 i top32 hard)', () => {
        assert.equal(resolveTieGoalKey(8, 'hard'), 'top8');
        assert.equal(resolveTieGoalKey(16, 'hard'), 'top16');
        assert.equal(resolveTieGoalKey(32, 'soft'), 'continentals');
        assert.equal(resolveTieGoalKey(64, 'soft'), 'gaston');
        assert.equal(resolveTieGoalKey(32, 'hard'), 'top32');
        assert.equal(resolveTieGoalKey(2, 'hard'), 'top2');
        assert.equal(resolveTieGoalKey(4, 'hard'), 'top4');
        assert.equal(resolveTieGoalKey(8, 'soft'), null);
        assert.equal(getTieGoalPreset('continentals').cutRule, 'soft');
        assert.equal(TIE_GOAL_PRESETS.gaston.cutSize, 64);
        assert.equal(TIE_GOAL_PRESETS.top32.cutRule, 'hard');
    });

    it('Soft EUC panel tylko dla MAIN1 (nie MAIN2/CCQ/custom)', () => {
        assert.equal(shouldShowSoftEucPanel('MAIN1'), true);
        assert.equal(shouldShowSoftEucPanel('ME1'), true);
        assert.equal(shouldShowSoftEucPanel('MAIN2'), false);
        assert.equal(shouldShowSoftEucPanel('ME2'), false);
        assert.equal(shouldShowSoftEucPanel('CCQ'), false);
        assert.equal(shouldShowSoftEucPanel('custom'), false);
    });

    it('applyTieGoalToCutUi ustawia cutSize/cutRule pod MC/hybrid (w tym gaston + top32)', () => {
        const { els } = makeDomStub();
        els.get('cutSize').value = '4';
        els.get('cutRule').value = 'hard';

        assert.equal(applyTieGoalToCutUi('continentals', { triggerRecalc: false }), true);
        assert.equal(els.get('cutSize').value, '32');
        assert.equal(els.get('cutRule').value, 'soft');

        assert.equal(applyTieGoalToCutUi('gaston', { triggerRecalc: false }), true);
        assert.equal(els.get('cutSize').value, '64');
        assert.equal(els.get('cutRule').value, 'soft');

        assert.equal(applyTieGoalToCutUi('top32', { triggerRecalc: false }), true);
        assert.equal(els.get('cutSize').value, '32');
        assert.equal(els.get('cutRule').value, 'hard');

        assert.equal(applyTieGoalToCutUi('top2', { triggerRecalc: false }), true);
        assert.equal(els.get('cutSize').value, '2');
        assert.equal(els.get('cutRule').value, 'hard');

        assert.equal(applyTieGoalToCutUi('nope', { triggerRecalc: false }), false);
        syncTieGoalPickerUi(16, 'hard');
    });

    it('rebuildTieGoalPicker buduje 4/2/5 przycisków wg trybu', () => {
        const { els } = makeDomStub();

        rebuildTieGoalPicker('MAIN1');
        assert.equal((els.get('tieGoalPicker').innerHTML.match(/data-tie-goal=/g) || []).length, 4);
        assert.match(els.get('tieGoalPicker').innerHTML, /data-tie-goal="gaston"/);
        assert.match(els.get('tieGoalPicker').innerHTML, /Continentals/);

        rebuildTieGoalPicker('MAIN2');
        assert.equal((els.get('tieGoalPicker').innerHTML.match(/data-tie-goal=/g) || []).length, 2);
        assert.match(els.get('tieGoalPicker').innerHTML, /data-tie-goal="top32"/);
        assert.doesNotMatch(els.get('tieGoalPicker').innerHTML, /data-tie-goal="continentals"/);

        rebuildTieGoalPicker('CCQ');
        assert.equal((els.get('tieGoalPicker').innerHTML.match(/data-tie-goal=/g) || []).length, 5);
        assert.match(els.get('tieGoalPicker').innerHTML, /data-tie-goal="top2"/);
    });

    it('przełączenie turnieju: Soft EUC widoczny tylko na MAIN1; cele przebudowane', () => {
        const { els } = makeDomStub();
        siteConfig.tournaments = [
            { id: 't1', eventId: 1001, name: 'ME1', mode: 'MAIN1', cutSize: 32, cutRule: 'soft' },
            { id: 't2', eventId: 1002, name: 'ME2', mode: 'MAIN2', cutSize: 8, cutRule: 'hard' },
            { id: 't3', eventId: 1003, name: 'CCQ', mode: 'CCQ', cutSize: 8, cutRule: 'hard' }
        ];
        const front = els.get('frontSoftEucHost');

        applyTournamentSelection(siteConfig.tournaments[0], { track: false, clearLocalCut: true });
        assert.equal(front.style.display, 'block');
        assert.ok(String(front.innerHTML).length > 0);
        assert.equal((els.get('tieGoalPicker').innerHTML.match(/data-tie-goal=/g) || []).length, 4);
        assert.equal(els.get('cutSize').value, '8');
        assert.equal(els.get('cutRule').value, 'hard');

        applyTournamentSelection(siteConfig.tournaments[1], { track: false, clearLocalCut: true });
        assert.equal(front.style.display, 'none');
        assert.equal(front.innerHTML, '');
        assert.equal((els.get('tieGoalPicker').innerHTML.match(/data-tie-goal=/g) || []).length, 2);
        assert.match(els.get('tieGoalPicker').innerHTML, /data-tie-goal="top32"/);

        applyTournamentSelection(siteConfig.tournaments[2], { track: false, clearLocalCut: true });
        assert.equal(front.style.display, 'none');
        assert.equal((els.get('tieGoalPicker').innerHTML.match(/data-tie-goal=/g) || []).length, 5);

        refreshModeDependentTieUi({ applyDefaultGoal: false, triggerRecalc: false });
        syncFrontSoftEucHost();
    });
});
