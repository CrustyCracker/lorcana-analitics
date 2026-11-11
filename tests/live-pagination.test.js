const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  PAGE_SIZE,
  LIVE_ROW_HEIGHT,
  LIVE_OVERSCAN,
  LIVE_VIEWPORT_ROWS,
  getLiveVirtualWindow,
  getLivePageFromScroll
} = require('../app.js');

describe('LIVE standings pagination (virtualized)', () => {
  it('getLivePageFromScroll matches changeLivePage target tops (not win.start/overscan)', () => {
    const totalItems = 200;
    for (let page = 1; page <= 5; page++) {
      const targetTop = (page - 1) * PAGE_SIZE * LIVE_ROW_HEIGHT;
      const win = getLiveVirtualWindow(
        totalItems,
        targetTop,
        LIVE_VIEWPORT_ROWS * LIVE_ROW_HEIGHT
      );
      // Regression: deriving page from win.start (overscan) pinned page 2 → 1.
      const brokenFromWinStart = Math.max(1, Math.floor(win.start / PAGE_SIZE) + 1);
      if (page === 2) {
        assert.equal(brokenFromWinStart, 1, 'overscan still shifts win.start into page 1');
        assert.ok(win.start < PAGE_SIZE, `expected overscan start < ${PAGE_SIZE}, got ${win.start}`);
        assert.equal(LIVE_OVERSCAN > 0, true);
      }
      assert.equal(
        getLivePageFromScroll(targetTop, totalItems),
        page,
        `scrollTop=${targetTop} should be page ${page}`
      );
    }
  });

  it('Następna from page 1 advances to page 2 (safe next target)', () => {
    const totalItems = 96; // 3 pages
    const page1Top = 0;
    const current = getLivePageFromScroll(page1Top, totalItems);
    assert.equal(current, 1);
    const nextTop = current * PAGE_SIZE * LIVE_ROW_HEIGHT;
    assert.equal(getLivePageFromScroll(nextTop, totalItems), 2);
  });

  it('clamps to last page for huge scroll', () => {
    const totalItems = 64; // 2 pages
    const huge = 999999;
    assert.equal(getLivePageFromScroll(huge, totalItems), 2);
    assert.equal(getLivePageFromScroll(0, 0), 1);
  });
});
