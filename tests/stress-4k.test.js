const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { performance } = require('perf_hooks');

const {
  buildStandingsMap,
  extractPairingsList,
  computeLiveStandingsList,
  filterLiveStandingsList,
  getLiveVirtualWindow,
  runLiveTieSimulation,
  getAdaptiveSimCount,
  resolvePlayer,
  getMatchParticipant,
  LIVE_MAX_DOM_ROWS,
  LIVE_ROW_HEIGHT,
  LIVE_VIEWPORT_ROWS
} = require('../app.js');

const { createSyntheticField } = require('../scripts/stress-fixture');

function findOpponent(pairingsList, playerId, standingsMap) {
  const id = String(playerId);
  for (const m of pairingsList) {
    const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
    const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
    if (p1 && String(p1.id) === id) {
      return p2 ? { id: p2.id, name: p2.best_identifier || '' } : null;
    }
    if (p2 && String(p2.id) === id) {
      return p1 ? { id: p1.id, name: p1.best_identifier || '' } : null;
    }
  }
  return null;
}

describe('Synthetic stress harness (2k–4k, bez PlayHub)', () => {
  it('virtual window nigdy nie przekracza LIVE_MAX_DOM_ROWS przy 4000', () => {
    const win = getLiveVirtualWindow(4000, 88000, LIVE_VIEWPORT_ROWS * LIVE_ROW_HEIGHT);
    assert.ok(win.domRows > 0);
    assert.ok(win.domRows <= LIVE_MAX_DOM_ROWS, `domRows=${win.domRows} > cap ${LIVE_MAX_DOM_ROWS}`);
    assert.equal(win.start + win.domRows, win.end);
  });

  it('generator tworzy dokładnie N standings i ~N/2 pairings', () => {
    const data = createSyntheticField(512, { completedRounds: 6, cutSize: 32 });
    assert.equal(data.standings.standings.length, 512);
    assert.equal(data.pairings.results.length, 256);
  });

  it('process/render/tie path działa dla 2000 graczy (timing w assert message)', () => {
    const n = 2000;
    const tAll = performance.now();
    const data = createSyntheticField(n, { completedRounds: 7, cutSize: 64 });
    const raw = data.standings.standings;
    const pairings = extractPairingsList(data.pairings);
    const map = buildStandingsMap(raw);
    const live = computeLiveStandingsList(raw, pairings, { standingsMap: map, isLiveRoundInProgress: true });
    assert.equal(live.length, n);

    const filtered = filterLiveStandingsList(live, {
      filterOnlyPoles: false,
      statusFilter: 'all',
      searchQuery: '',
      standingsMap: map,
      cutSize: 64,
      simCache: new Map()
    });
    const win = getLiveVirtualWindow(filtered.length, 0, LIVE_VIEWPORT_ROWS * LIVE_ROW_HEIGHT);
    assert.ok(win.domRows <= LIVE_MAX_DOM_ROWS);

    const bubble = live[63];
    const opp = findOpponent(pairings, bubble.player.id, map);
    const sim = runLiveTieSimulation(
      bubble,
      opp,
      live,
      pairings,
      map,
      64,
      'hard',
      data.activeRound,
      data.totalRounds,
      bubble.livePoints,
      true,
      getAdaptiveSimCount(n)
    );
    assert.equal(typeof sim.matchesLeft, 'number');
    const elapsed = Math.round(performance.now() - tAll);
    assert.ok(elapsed < 120000, `2000-player stress took too long: ${elapsed}ms`);
    console.log(`[stress-4k.test] N=2000 elapsed=${elapsed}ms matchesLeft=${sim.matchesLeft}`);
  });

  it('process/render/tie path działa dla 4000 graczy (timing w assert message)', () => {
    const n = 4000;
    const tAll = performance.now();
    const data = createSyntheticField(n, { completedRounds: 7, cutSize: 64 });
    const raw = data.standings.standings;
    const pairings = extractPairingsList(data.pairings);
    const map = buildStandingsMap(raw);
    const live = computeLiveStandingsList(raw, pairings, { standingsMap: map, isLiveRoundInProgress: true });
    assert.equal(live.length, n);

    const winMid = getLiveVirtualWindow(
      live.length,
      Math.floor(live.length / 2) * LIVE_ROW_HEIGHT,
      LIVE_VIEWPORT_ROWS * LIVE_ROW_HEIGHT
    );
    assert.ok(winMid.domRows <= LIVE_MAX_DOM_ROWS);

    const bubble = live[63];
    const opp = findOpponent(pairings, bubble.player.id, map);
    const tTie = performance.now();
    const sim = runLiveTieSimulation(
      bubble,
      opp,
      live,
      pairings,
      map,
      64,
      'hard',
      data.activeRound,
      data.totalRounds,
      bubble.livePoints,
      true,
      getAdaptiveSimCount(n)
    );
    const tieMs = Math.round(performance.now() - tTie);
    assert.equal(typeof sim.matchesLeft, 'number');
    const elapsed = Math.round(performance.now() - tAll);
    assert.ok(elapsed < 180000, `4000-player stress took too long: ${elapsed}ms`);
    console.log(`[stress-4k.test] N=4000 elapsed=${elapsed}ms tieMs=${tieMs} matchesLeft=${sim.matchesLeft}`);
  });
});
