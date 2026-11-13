/**
 * Ink pairings UI helpers — compact dots from slim payload inks[].
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');

describe('ink pairings UI', () => {
    it('getPlayerInks reads top-level, UES, or player.inks', () => {
        assert.deepEqual(
            app.getPlayerInks({ inks: [{ key: 'emerald', name: 'Emerald', hex: '#50C878' }] }).map(i => i.key),
            ['emerald']
        );
        assert.deepEqual(
            app.getPlayerInks({
                user_event_status: { inks: [{ key: 'steel', name: 'Steel' }] }
            }).map(i => i.key),
            ['steel']
        );
        assert.deepEqual(
            app.getPlayerInks({
                player: { id: 1, inks: [{ key: 'ruby', name: 'Ruby' }] }
            }).map(i => i.key),
            ['ruby']
        );
        assert.deepEqual(app.getPlayerInks({}), []);
    });

    it('resolveInkHex prefers API hex and falls back by key', () => {
        assert.equal(app.resolveInkHex({ hex: '50C878', key: 'emerald' }), '#50C878');
        assert.equal(app.resolveInkHex({ key: 'amber' }), app.INK_HEX_FALLBACKS.amber);
        assert.equal(app.resolveInkHex({ key: 'unknown' }), '#888888');
    });

    it('renderInkBadgesHtml emits two dots without remote images', () => {
        const html = app.renderInkBadgesHtml([
            { key: 'emerald', name: 'Emerald', hex: '#50C878' },
            { key: 'steel', name: 'Steel', hex: '#71797E' }
        ]);
        assert.match(html, /ink-pair/);
        assert.match(html, /ink-dot/);
        assert.match(html, /#50C878/);
        assert.match(html, /#71797E/);
        assert.doesNotMatch(html, /image_url|googleapis|X-Goog/);
    });

    it('formatPlayerCellHtml wraps name with ink badges when present', () => {
        const withInk = app.formatPlayerCellHtml(
            { inks: [{ key: 'ruby', name: 'Ruby', hex: '#E0115F' }] },
            'Crusty',
            { strong: true }
        );
        assert.match(withInk, /player-cell-with-inks/);
        assert.match(withInk, /ink-dot/);
        assert.match(withInk, /Crusty/);

        const plain = app.formatPlayerCellHtml({}, 'NoInk', { strong: false });
        assert.doesNotMatch(plain, /ink-pair/);
        assert.match(plain, /NoInk/);
    });
});
