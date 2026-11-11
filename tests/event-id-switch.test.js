const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    canReuseCachedEventSnapshot,
    buildDataFingerprint
} = require('../app.js');

describe('Tournament ID switch — cached snapshot reuse', () => {
    it('rejects 304/fingerprint reuse when UI still shows a different event', () => {
        assert.equal(canReuseCachedEventSnapshot('1233041', { eventId: 1007231 }), false);
        assert.equal(canReuseCachedEventSnapshot('1233041', null), false);
        assert.equal(canReuseCachedEventSnapshot('1233041', {}), false);
        assert.equal(canReuseCachedEventSnapshot('', { eventId: 1233041 }), false);
    });

    it('allows 304 reuse only when latestData.eventId matches the requested id', () => {
        assert.equal(canReuseCachedEventSnapshot('1233041', { eventId: 1233041 }), true);
        assert.equal(canReuseCachedEventSnapshot('1233041', { eventId: '1233041' }), true);
        assert.equal(canReuseCachedEventSnapshot('abc1233041xyz', { eventId: '1233041' }), true);
    });

    it('fingerprints differ across eventIds even with identical round/player counts', () => {
        const base = {
            activeRound: 8,
            standingsRound: 7,
            playerCount: 64,
            standings: { standings: new Array(64).fill({ player: { id: 1 } }) },
            pairings: { pairings: [] },
            _slimVersion: 1
        };
        const a = buildDataFingerprint({ ...base, eventId: 1007231 }, 8, 'hard');
        const b = buildDataFingerprint({ ...base, eventId: 1233041 }, 8, 'hard');
        assert.notEqual(a, b);
        assert.match(a, /^1007231::/);
        assert.match(b, /^1233041::/);
    });
});
