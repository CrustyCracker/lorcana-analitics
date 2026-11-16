'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

function stubDocument() {
    const els = new Map();
    const makeEl = (id, value = '') => {
        const el = {
            id,
            value: String(value),
            style: {},
            hidden: false,
            innerHTML: '',
            textContent: '',
            classList: { toggle() {}, add() {}, remove() {} },
            dataset: {},
            querySelectorAll: () => [],
            addEventListener() {},
            scrollIntoView() {}
        };
        els.set(id, el);
        return el;
    };
    makeEl('cutSize', '8');
    makeEl('cutRule', 'hard');
    makeEl('bracketDrawSize', '8');
    makeEl('bracketDrawHint');
    makeEl('topCutBracketPanel');
    makeEl('topCutBracketGrid');
    makeEl('bracketSelectedPlayerBanner');
    makeEl('bracketSizeTitle');
    makeEl('bracketPhaseStatusText');
    makeEl('eventId', '');
    global.document = {
        getElementById: (id) => els.get(id) || makeEl(id),
        querySelectorAll: () => [],
        addEventListener() {}
    };
    return els;
}

describe('on-demand Top Cut bracket size', () => {
    let app;
    let els;

    before(() => {
        els = stubDocument();
        // eslint-disable-next-line global-require
        app = require('../app.js');
    });

    after(() => {
        delete global.document;
    });

    it('normalizes to next power of two', () => {
        assert.equal(app.normalizeBracketDrawSize(4), 4);
        assert.equal(app.normalizeBracketDrawSize(8), 8);
        assert.equal(app.normalizeBracketDrawSize(7), 8);
        assert.equal(app.normalizeBracketDrawSize(9), 16);
        assert.equal(app.normalizeBracketDrawSize(33), 64);
    });

    it('MAIN1 default draw size is hard Top 8 even when soft cut is 32', () => {
        els.get('cutSize').value = '32';
        app.applyTournamentSelection({
            id: 't_test_main1',
            eventId: 999001,
            name: 'TEST MAIN1',
            mode: 'MAIN1',
            cutSize: 32,
            cutRule: 'soft',
            swissRounds: 15
        }, { track: false, clearLocalCut: true });
        assert.equal(app.resolveTopCutBracketSize(32), 8);
        assert.equal(app.getDefaultBracketDrawSize(), 8);
    });

    it('MAIN2 resolve is 0 (no playoffs); draw default falls back to cut size', () => {
        els.get('cutSize').value = '8';
        app.applyTournamentSelection({
            id: 't_test_main2',
            eventId: 999002,
            name: 'TEST MAIN2',
            mode: 'MAIN2',
            cutSize: 8,
            cutRule: 'hard',
            swissRounds: 11
        }, { track: false, clearLocalCut: true });
        assert.equal(app.resolveTopCutBracketSize(8), 0);
        assert.equal(app.getDefaultBracketDrawSize(), 8);
    });

    it('custom mode uses configured cut size', () => {
        els.get('cutSize').value = '16';
        app.applyTournamentSelection({
            id: 't_test_custom',
            eventId: 999003,
            name: 'TEST CUSTOM',
            mode: 'custom',
            cutSize: 16,
            cutRule: 'hard',
            swissRounds: null
        }, { track: false, clearLocalCut: true });
        assert.equal(app.resolveTopCutBracketSize(16), 16);
        assert.equal(app.getDefaultBracketDrawSize(), 16);
    });
});
