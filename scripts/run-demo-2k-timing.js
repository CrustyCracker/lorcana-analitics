#!/usr/bin/env node
'use strict';

const path = require('path');
const { performance } = require('perf_hooks');
const { createDemo2kRound12 } = require('./stress-fixture');
const app = require(path.join(__dirname, '..', 'app.js'));

function findOpponent(pairingsList, playerId, standingsMap) {
  const id = String(playerId);
  for (const m of pairingsList) {
    const p1 = app.resolvePlayer(app.getMatchParticipant(m, 1), standingsMap);
    const p2 = app.resolvePlayer(app.getMatchParticipant(m, 2), standingsMap);
    if (p1 && String(p1.id) === id) {
      return p2 ? { id: p2.id, name: p2.best_identifier || '' } : null;
    }
    if (p2 && String(p2.id) === id) {
      return p1 ? { id: p1.id, name: p1.best_identifier || '' } : null;
    }
  }
  return null;
}

function main() {
  const tGen0 = performance.now();
  const data = createDemo2kRound12();
  const genMs = Math.round(performance.now() - tGen0);

  const raw = data.standings.standings;
  const pairings = app.extractPairingsList(data.pairings);
  const map = app.buildStandingsMap(raw);
  const live = app.computeLiveStandingsList(raw, pairings, {
    standingsMap: map,
    isLiveRoundInProgress: true
  });

  const cutSize = data.cutSize || 64;
  const bubble = live[Math.min(cutSize - 1, live.length - 1)];
  const opp = findOpponent(pairings, bubble.player.id, map);
  const simCount = app.getAdaptiveSimCount(data.playerCount);

  const t0 = performance.now();
  const sim = app.runLiveTieSimulation(
    bubble,
    opp,
    live,
    pairings,
    map,
    cutSize,
    'hard',
    data.activeRound,
    data.totalRounds,
    bubble.livePoints,
    true,
    simCount
  );
  const tieMs = Math.round(performance.now() - t0);

  const out = {
    players: data.playerCount,
    activeRound: data.activeRound,
    totalRounds: data.totalRounds,
    cutSize,
    bubbleRank: bubble.liveRank,
    bubbleId: bubble.player.id,
    genMs,
    tieMs,
    wallMs: genMs + tieMs,
    matchesLeft: sim.matchesLeft,
    chanceTie: sim.chanceTie,
    chanceWin: sim.chanceWin,
    simCount
  };
  console.log(JSON.stringify(out, null, 2));
}

main();
