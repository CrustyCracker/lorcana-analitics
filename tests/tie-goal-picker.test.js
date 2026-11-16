const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    TIE_GOAL_PRESETS,
    getTieGoalPreset,
    resolveTieGoalKey,
    applyTieGoalToCutUi,
    syncTieGoalPickerUi
} = require('../app.js');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

describe('Can I Tie — cel strategii (Top 8 / Top 16 / Continentals)', () => {
    it('ma otwarty moduł TIE i picker trzech celów w index.html', () => {
        assert.match(indexHtml, /id="tieModule"[^>]*\bopen\b/);
        assert.match(indexHtml, /data-tie-goal="top8"/);
        assert.match(indexHtml, /data-tie-goal="top16"/);
        assert.match(indexHtml, /data-tie-goal="continentals"/);
        assert.match(indexHtml, /id="playerSearchInput"/);
        assert.match(indexHtml, /app\.js\?v=20261116inkmeta1/);
    });

    it('mapuje preset Continentals na soft Top 32 (równe punkty)', () => {
        const c = getTieGoalPreset('continentals');
        assert.equal(c.cutSize, 32);
        assert.equal(c.cutRule, 'soft');
        assert.equal(resolveTieGoalKey(32, 'soft'), 'continentals');
        assert.equal(resolveTieGoalKey(8, 'hard'), 'top8');
        assert.equal(resolveTieGoalKey(16, 'hard'), 'top16');
        assert.equal(resolveTieGoalKey(32, 'hard'), null);
        assert.equal(resolveTieGoalKey(8, 'soft'), null);
        assert.equal(TIE_GOAL_PRESETS.top8.cutRule, 'hard');
        assert.equal(TIE_GOAL_PRESETS.top16.cutSize, 16);
    });

    it('applyTieGoalToCutUi ustawia cutSize/cutRule pod MC/hybrid', () => {
        const els = new Map();
        global.document = {
            getElementById(id) {
                if (!els.has(id)) {
                    els.set(id, { value: '', textContent: '', style: {}, classList: { toggle() {} }, setAttribute() {} });
                }
                return els.get(id);
            },
            querySelectorAll() {
                return [];
            }
        };
        els.set('cutSize', { value: '4' });
        els.set('cutRule', { value: 'hard' });
        els.set('tieGoalHint', { textContent: '' });

        assert.equal(applyTieGoalToCutUi('continentals', { triggerRecalc: false }), true);
        assert.equal(els.get('cutSize').value, '32');
        assert.equal(els.get('cutRule').value, 'soft');

        assert.equal(applyTieGoalToCutUi('top8', { triggerRecalc: false }), true);
        assert.equal(els.get('cutSize').value, '8');
        assert.equal(els.get('cutRule').value, 'hard');

        assert.equal(applyTieGoalToCutUi('top16', { triggerRecalc: false }), true);
        assert.equal(els.get('cutSize').value, '16');
        assert.equal(els.get('cutRule').value, 'hard');

        assert.equal(applyTieGoalToCutUi('nope', { triggerRecalc: false }), false);
        syncTieGoalPickerUi(16, 'hard');
        assert.match(els.get('tieGoalHint').textContent, /Top 16|twardy/i);
    });
});
