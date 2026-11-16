/**
 * Player ink localStorage cache + tournament meta aggregation.
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');

function mockLocalStorage() {
    const store = new Map();
    return {
        getItem(k) { return store.has(k) ? store.get(k) : null; },
        setItem(k, v) { store.set(String(k), String(v)); },
        removeItem(k) { store.delete(k); },
        clear() { store.clear(); },
        _store: store
    };
}

describe('ink localStorage cache + tournament meta', () => {
    let prevLocalStorage;

    beforeEach(() => {
        prevLocalStorage = global.localStorage;
        global.localStorage = mockLocalStorage();
        app.playerInksMemoryByEvent.clear();
    });

    afterEach(() => {
        if (prevLocalStorage === undefined) delete global.localStorage;
        else global.localStorage = prevLocalStorage;
        app.playerInksMemoryByEvent.clear();
    });

    it('playerInksStorageKey is scoped by eventId digits', () => {
        assert.equal(
            app.playerInksStorageKey('1254364'),
            app.PLAYER_INKS_STORAGE_PREFIX + '1254364'
        );
        assert.equal(app.playerInksStorageKey('evt-99'), app.PLAYER_INKS_STORAGE_PREFIX + '99');
        assert.equal(app.playerInksStorageKey(''), null);
    });

    it('remember + lookup persist across memory clear via localStorage', () => {
        const eventId = '1254364';
        const inks = [
            { key: 'emerald', name: 'Emerald', hex: '#50C878' },
            { key: 'steel', name: 'Steel', hex: '#71797E' }
        ];
        assert.equal(app.rememberPlayerInks(eventId, 42, inks), true);
        app.playerInksMemoryByEvent.clear();
        const got = app.lookupCachedPlayerInks(eventId, 42);
        assert.deepEqual(got.map(i => i.key), ['emerald', 'steel']);
        assert.match(got[0].hex, /#50C878/i);
    });

    it('getPlayerInks falls back to cache when payload has no inks', () => {
        const eventId = '1001';
        app.rememberPlayerInks(eventId, 7, [{ key: 'ruby', name: 'Ruby' }]);
        const fromCache = app.getPlayerInks({ player: { id: 7 } }, { eventId });
        assert.deepEqual(fromCache.map(i => i.key), ['ruby']);

        const liveWins = app.getPlayerInks(
            { player: { id: 7 }, inks: [{ key: 'amber', name: 'Amber' }] },
            { eventId }
        );
        assert.deepEqual(liveWins.map(i => i.key), ['amber']);
    });

    it('harvestPlayerInksFromData merges standings + pairings into cache', () => {
        const data = {
            eventId: '555',
            standings: {
                standings: [
                    {
                        player: { id: 1, best_identifier: 'A' },
                        inks: [{ key: 'amber', name: 'Amber' }, { key: 'sapphire', name: 'Sapphire' }]
                    },
                    { player: { id: 2, best_identifier: 'B' } }
                ]
            },
            pairings: {
                results: [
                    {
                        players: [
                            { id: 2, inks: [{ key: 'ruby', name: 'Ruby' }, { key: 'amethyst', name: 'Amethyst' }] },
                            { id: 3, inks: [{ key: 'steel', name: 'Steel' }, { key: 'emerald', name: 'Emerald' }] }
                        ]
                    }
                ]
            }
        };
        const res = app.harvestPlayerInksFromData(data);
        assert.ok(res.totalCached >= 3);
        assert.deepEqual(app.lookupCachedPlayerInks('555', 1).map(i => i.key), ['amber', 'sapphire']);
        assert.deepEqual(app.lookupCachedPlayerInks('555', 2).map(i => i.key), ['ruby', 'amethyst']);
        assert.deepEqual(app.lookupCachedPlayerInks('555', 3).map(i => i.key), ['steel', 'emerald']);
    });

    it('computeTournamentInkMeta aggregates pairs and color share', () => {
        const eventId = '777';
        app.rememberPlayerInks(eventId, 1, [
            { key: 'amber', name: 'Amber' },
            { key: 'sapphire', name: 'Sapphire' }
        ]);
        app.rememberPlayerInks(eventId, 2, [
            { key: 'sapphire', name: 'Sapphire' },
            { key: 'amber', name: 'Amber' }
        ]);
        app.rememberPlayerInks(eventId, 3, [
            { key: 'emerald', name: 'Emerald' },
            { key: 'steel', name: 'Steel' }
        ]);

        const standings = [
            { player: { id: 1 } },
            { player: { id: 2 } },
            { player: { id: 3 } },
            { player: { id: 4 } }
        ];
        const meta = app.computeTournamentInkMeta(eventId, standings);
        assert.equal(meta.known, 3);
        assert.equal(meta.unknown, 1);
        assert.equal(meta.pairs.length, 2);
        const amberSapph = meta.pairs.find(p => p.key === 'amber/sapphire');
        assert.ok(amberSapph);
        assert.equal(amberSapph.count, 2);
        assert.ok(meta.singles.some(s => s.key === 'amber' && s.count === 2));
        assert.ok(meta.singles.some(s => s.key === 'sapphire' && s.count === 2));
    });

    it('formatPlayerCellHtml uses cached inks when payload is bare', () => {
        const eventId = '888';
        app.rememberPlayerInks(eventId, 99, [
            { key: 'steel', name: 'Steel', hex: '#71797E' }
        ]);
        const html = app.formatPlayerCellHtml(
            { player: { id: 99 } },
            'CachedPlayer',
            { strong: true, eventId }
        );
        assert.match(html, /ink-dot/);
        assert.match(html, /CachedPlayer/);
        assert.match(html, /#71797E/);
    });
});
