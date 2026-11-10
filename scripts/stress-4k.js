#!/usr/bin/env node
/**
 * Synthetic 2k–4k stress harness (bez żywego PlayHub).
 *
 * Uruchomienie z katalogu projektu:
 *   node scripts/stress-4k.js
 *   node scripts/stress-4k.js --sizes=2000,4000
 *   npm run stress:4k
 *
 * Mierzy: generator, buildStandingsMap, computeLiveStandingsList,
 * filter+virtual window, Monte Carlo TIE (1 gracz bubble).
 */

'use strict';

const path = require('path');
const { performance } = require('perf_hooks');

const root = path.join(__dirname, '..');
const { createSyntheticField } = require('./stress-fixture');
const app = require(path.join(root, 'app.js'));

function parseSizes(argv) {
  const arg = argv.find(a => a.startsWith('--sizes='));
  if (!arg) return [2000, 4000];
  return arg.slice('--sizes='.length).split(',').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
}

function ms(t0) {
  return Math.round((performance.now() - t0) * 10) / 10;
}

function findOpponent(pairingsList, playerId, standingsMap) {
  const id = String(playerId);
  for (const m of pairingsList) {
    const p1 = app.resolvePlayer(app.getMatchParticipant(m, 1), standingsMap);
    const p2 = app.resolvePlayer(app.getMatchParticipant(m, 2), standingsMap);
    if (p1 && String(p1.id) === id) {
      return p2 ? { id: p2.id, name: p2.best_identifier || p2.name || '' } : null;
    }
    if (p2 && String(p2.id) === id) {
      return p1 ? { id: p1.id, name: p1.best_identifier || p1.name || '' } : null;
    }
  }
  return null;
}

function runSize(n) {
  const report = { players: n, timingsMs: {}, checks: {} };

  let t0 = performance.now();
  const data = createSyntheticField(n, { completedRounds: 7, cutSize: 64 });
  report.timingsMs.generateFixture = ms(t0);
  report.pairings = data.pairings.results.length;
  report.standings = data.standings.standings.length;

  const rawStandings = data.standings.standings;
  const pairingsList = app.extractPairingsList(data.pairings);

  t0 = performance.now();
  const standingsMap = app.buildStandingsMap(rawStandings);
  report.timingsMs.buildStandingsMap = ms(t0);

  t0 = performance.now();
  const live = app.computeLiveStandingsList(rawStandings, pairingsList, {
    standingsMap,
    isLiveRoundInProgress: true
  });
  report.timingsMs.computeLiveStandings = ms(t0);
  report.checks.liveCount = live.length;
  report.checks.liveSorted =
    live.length < 2 || live.every((p, i) => i === 0 || live[i - 1].livePoints >= p.livePoints);

  t0 = performance.now();
  const filtered = app.filterLiveStandingsList(live, {
    filterOnlyPoles: false,
    statusFilter: 'all',
    searchQuery: '',
    standingsMap,
    cutSize: data.cutSize,
    simCache: new Map()
  });
  const viewportH = app.LIVE_VIEWPORT_ROWS * app.LIVE_ROW_HEIGHT;
  const midScroll = Math.floor(filtered.length / 2) * app.LIVE_ROW_HEIGHT;
  const winTop = app.getLiveVirtualWindow(filtered.length, 0, viewportH);
  const winMid = app.getLiveVirtualWindow(filtered.length, midScroll, viewportH);
  report.timingsMs.filterAndWindow = ms(t0);
  report.checks.windowDomRowsTop = winTop.domRows;
  report.checks.windowDomRowsMid = winMid.domRows;
  report.checks.windowWithinCap =
    winTop.domRows <= app.LIVE_MAX_DOM_ROWS && winMid.domRows <= app.LIVE_MAX_DOM_ROWS;

  const cutIdx = Math.min(data.cutSize - 1, live.length - 1);
  const bubble = live[cutIdx];
  const projectedFinalBubble = bubble.livePoints;
  const myOpponent = findOpponent(pairingsList, bubble.player.id, standingsMap);
  const simCount = app.getAdaptiveSimCount(n);

  t0 = performance.now();
  const sim = app.runLiveTieSimulation(
    bubble,
    myOpponent,
    live,
    pairingsList,
    standingsMap,
    data.cutSize,
    'hard',
    data.activeRound,
    data.totalRounds,
    projectedFinalBubble,
    true,
    simCount
  );
  report.timingsMs.tieSimulation = ms(t0);
  report.checks.tieOk = Boolean(sim && typeof sim.matchesLeft === 'number');
  report.simCount = simCount;
  report.bubbleRank = bubble.liveRank;
  report.tieSummary = sim
    ? {
        matchesLeft: sim.matchesLeft,
        chanceWin: sim.chanceWin,
        chanceTie: sim.chanceTie,
        chanceLose: sim.chanceLose
      }
    : null;

  report.timingsMs.total =
    Math.round(
      (report.timingsMs.generateFixture +
        report.timingsMs.buildStandingsMap +
        report.timingsMs.computeLiveStandings +
        report.timingsMs.filterAndWindow +
        report.timingsMs.tieSimulation) *
        10
    ) / 10;

  return report;
}

function main() {
  const sizes = parseSizes(process.argv.slice(2));
  console.log('Lorcana 4k stress harness');
  console.log('sizes:', sizes.join(', '));
  console.log('LIVE_MAX_DOM_ROWS:', app.LIVE_MAX_DOM_ROWS);
  console.log('---');

  const results = [];
  let failed = false;
  for (const n of sizes) {
    const r = runSize(n);
    results.push(r);
    console.log(JSON.stringify(r, null, 2));
    if (
      !r.checks.liveSorted ||
      !r.checks.windowWithinCap ||
      r.checks.liveCount !== n ||
      !r.checks.tieOk
    ) {
      failed = true;
      console.error('FAIL checks for N=', n);
    } else {
      console.log(
        `OK N=${n} total=${r.timingsMs.total}ms (tie=${r.timingsMs.tieSimulation}ms, live=${r.timingsMs.computeLiveStandings}ms)`
      );
    }
    console.log('---');
  }

  const summary = {
    ok: !failed,
    results: results.map(r => ({
      players: r.players,
      totalMs: r.timingsMs.total,
      generateMs: r.timingsMs.generateFixture,
      liveMs: r.timingsMs.computeLiveStandings,
      tieMs: r.timingsMs.tieSimulation,
      windowCapOk: r.checks.windowWithinCap,
      domRowsMid: r.checks.windowDomRowsMid
    }))
  };
  console.log('SUMMARY', JSON.stringify(summary, null, 2));
  process.exit(failed ? 1 : 0);
}

main();
