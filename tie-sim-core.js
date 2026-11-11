/**
 * Tie / cut simulation (Monte Carlo + exact last-round enumeration).
 * Input must be a plain serializable context from prepareTieSimulationContext().
 */
(function (root) {
    'use strict';

    /** Max unfinished field matches (excl. target table) for exact / hybrid. */
    var EXACT_MAX_MATCHES_HYBRID = 10;
    var EXACT_MAX_MATCHES_STRICT = 12;

    var MATCH_OUTCOMES = [
        { key: 'draw', p1: 1, p2: 1, ghostPts: 1, weight: 0.08 },
        { key: 'p1', p1: 3, p2: 0, ghostPts: 3, weight: 0.46 },
        { key: 'p2', p1: 0, p2: 3, ghostPts: 0, weight: 0.46 }
    ];

    function getAdaptiveSimCount(playerCount) {
        const n = Number(playerCount) || 0;
        if (n > 800) return 100;
        if (n > 200) return 200;
        return 600;
    }

    function normalizeAlgorithm(algo) {
        const a = String(algo || 'hybrid').toLowerCase();
        if (a === 'montecarlo' || a === 'exact' || a === 'hybrid') return a;
        return 'hybrid';
    }

    /**
     * Exact enumeration only when last round (matchesLeft===1) and unfinished
     * field space is small enough. Multi-round Swiss stays Monte Carlo.
     */
    function canUseExactEnumeration(ctx) {
        const algo = normalizeAlgorithm(ctx && ctx.algorithm);
        if (algo === 'montecarlo') return false;
        if (!ctx || Number(ctx.matchesLeft) !== 1) return false;
        // Future Swiss rounds require pairing model → MC only.
        if (Number(ctx.currentRound) < Number(ctx.totalRounds)) return false;
        const n = Array.isArray(ctx.liveUnfinishedMatches) ? ctx.liveUnfinishedMatches.length : 0;
        const max = algo === 'exact' ? EXACT_MAX_MATCHES_STRICT : EXACT_MAX_MATCHES_HYBRID;
        return n <= max;
    }

    function emptyScenarioCounters() {
        return {
            tieSuccesses: 0,
            oppTieSuccesses: 0,
            winSuccesses: 0,
            lossSuccesses: 0,
            doubleTieSuccesses: 0,
            oppDoubleTieSuccesses: 0,
            winTieSuccesses: 0,
            winLossSuccesses: 0,
            tieLossSuccesses: 0,
            doubleWinSuccesses: 0,
            tripleTieSuccesses: 0,
            oppTripleTieSuccesses: 0,
            winDoubleTieSuccesses: 0,
            oppWinDoubleTieSuccesses: 0,
            winTieLossSuccesses: 0,
            twoWinLossSuccesses: 0,
            twoWinTieSuccesses: 0,
            tripleWinSuccesses: 0,
            simBubbleSum: 0,
            weightSum: 0
        };
    }

    function buildResultPayload(ctx, counters, denom, method, extra) {
        const matchesLeft = ctx.matchesLeft;
        const isCurrentMatchFinished = Boolean(ctx.isCurrentMatchFinished);
        const basePtsForCalc = ctx.targetBasePts;
        const basePlayers = ctx.basePlayers || [];
        const projectedFinalBubble = ctx.projectedFinalBubble;
        const simProjectedBubble = counters.simBubbleSum > 0 && denom > 0
            ? Math.round(counters.simBubbleSum / denom)
            : projectedFinalBubble;
        const pct = (n) => denom > 0 ? Math.round((n / denom) * 100) : 0;

        return Object.assign({
            matchesLeft,
            isCurrentMatchFinished,
            chanceTie: pct(counters.tieSuccesses),
            oppChanceTie: pct(counters.oppTieSuccesses),
            chanceWin: pct(counters.winSuccesses),
            chanceLoss: pct(counters.lossSuccesses),
            chanceDoubleTie: pct(counters.doubleTieSuccesses),
            oppChanceDoubleTie: pct(counters.oppDoubleTieSuccesses),
            chanceWinTie: pct(counters.winTieSuccesses),
            chanceWinLoss: pct(counters.winLossSuccesses),
            chanceTieLoss: pct(counters.tieLossSuccesses),
            chanceDoubleWin: pct(counters.doubleWinSuccesses),
            chanceTripleTie: pct(counters.tripleTieSuccesses),
            oppChanceTripleTie: pct(counters.oppTripleTieSuccesses),
            chanceWinDoubleTie: pct(counters.winDoubleTieSuccesses),
            oppChanceWinDoubleTie: pct(counters.oppWinDoubleTieSuccesses),
            chanceWinTieLoss: pct(counters.winTieLossSuccesses),
            chanceTwoWinLoss: pct(counters.twoWinLossSuccesses),
            chanceTwoWinTie: pct(counters.twoWinTieSuccesses),
            chanceTripleWin: pct(counters.tripleWinSuccesses),
            ptsDoubleTie: basePtsForCalc + 2,
            ptsWinTie: basePtsForCalc + 4,
            ptsWinLoss: basePtsForCalc + 3,
            ptsTieLoss: basePtsForCalc + 1,
            ptsDoubleWin: basePtsForCalc + 6,
            ptsTripleTie: basePtsForCalc + 3,
            ptsWinDoubleTie: basePtsForCalc + 5,
            ptsWinTieLoss: basePtsForCalc + 4,
            ptsTwoWinLoss: basePtsForCalc + 6,
            ptsTwoWinTie: basePtsForCalc + 7,
            ptsTripleWin: basePtsForCalc + 9,
            projectedBubble: simProjectedBubble,
            scoped: Boolean(ctx.scoped),
            scopedPlayerCount: ctx.scopedPlayerCount || basePlayers.length,
            fullPlayerCount: ctx.fullPlayerCount || basePlayers.length,
            method: method,
            algorithm: normalizeAlgorithm(ctx.algorithm)
        }, extra || {});
    }

    function makeCheckPlayerCut(simBoard, fixedAheadCount, cutSize, cutRule) {
        return function checkPlayerCut(playerId, simPoints, simOmwp, simGwp, simOgwp, correlatedOppId, correlatedOppPts) {
            let playersAhead = fixedAheadCount;
            for (let i = 0; i < simBoard.length; i++) {
                const p = simBoard[i];
                if (p.id === playerId) continue;
                const pPts = (correlatedOppId && p.id === correlatedOppId && correlatedOppPts !== undefined)
                    ? correlatedOppPts
                    : p.points;
                if (pPts > simPoints) {
                    playersAhead++;
                } else if (pPts === simPoints) {
                    if (p.finalOmwp > simOmwp) {
                        playersAhead++;
                    } else if (p.finalOmwp === simOmwp) {
                        if ((p.gwp || 0) > (simGwp || 0)) {
                            playersAhead++;
                        } else if ((p.gwp || 0) === (simGwp || 0)) {
                            if ((p.ogwp || 0) > (simOgwp || 0)) {
                                playersAhead++;
                            }
                        }
                    }
                }
            }
            const rank = playersAhead + 1;
            if (cutRule === 'hard') {
                return rank <= cutSize;
            }
            const sortedPoints = [];
            for (let i = 0; i < simBoard.length; i++) {
                const p = simBoard[i];
                if (p.id === playerId) continue;
                const pPts = (correlatedOppId && p.id === correlatedOppId && correlatedOppPts !== undefined)
                    ? correlatedOppPts
                    : p.points;
                sortedPoints.push(pPts);
            }
            for (let i = 0; i < fixedAheadCount; i++) {
                sortedPoints.push(simPoints + 99);
            }
            sortedPoints.push(simPoints);
            sortedPoints.sort((a, b) => b - a);
            const softBubbleIdx = Math.min(cutSize - 1, sortedPoints.length - 1);
            return simPoints >= sortedPoints[softBubbleIdx];
        };
    }

    function applyOmwp(simBoard, boardMap, totalRounds, matchesLeft) {
        const baseWeight = Math.max(1, totalRounds - matchesLeft);
        for (let i = 0; i < simBoard.length; i++) {
            const p = simBoard[i];
            let oppMwpSum = 0;
            for (let oi = 0; oi < p.opponents.length; oi++) {
                const opp = boardMap.get(p.opponents[oi]);
                if (opp) {
                    oppMwpSum += Math.max(0.3333, opp.points / (totalRounds * 3));
                } else {
                    oppMwpSum += 0.3333;
                }
            }
            p.finalOmwp = ((p.baseOmwp * baseWeight) + oppMwpSum) / (baseWeight + p.opponents.length);
        }
    }

    function scoreLastRoundScenarios(ctx, simBoard, boardMap, counters, weight) {
        const targetId = ctx.targetId;
        const opponentId = ctx.opponentId || null;
        const cutSize = ctx.cutSize;
        const cutRule = ctx.cutRule || 'hard';
        const fixedAheadCount = Number(ctx.fixedAheadCount) || 0;
        const isCurrentMatchFinished = Boolean(ctx.isCurrentMatchFinished);
        const targetBasePts = ctx.targetBasePts;
        const oppBasePts = ctx.oppBasePts || 0;
        const matchesLeft = ctx.matchesLeft;

        const checkPlayerCut = makeCheckPlayerCut(simBoard, fixedAheadCount, cutSize, cutRule);

        const sortedEndPts = simBoard.map(p => p.points).sort((a, b) => b - a);
        const bubbleIdx = Math.min(Math.max(0, cutSize - 1 - fixedAheadCount), sortedEndPts.length - 1);
        counters.simBubbleSum += (sortedEndPts[bubbleIdx] || 0) * weight;
        counters.weightSum += weight;

        const targetP = boardMap.get(targetId);
        const oppP = opponentId ? boardMap.get(opponentId) : null;
        const targetOmwp = targetP?.finalOmwp || 0.5;
        const oppOmwp = oppP?.finalOmwp || 0.5;
        const targetGwp = targetP?.gwp || 0.33;
        const oppGwp = oppP?.gwp || 0.33;
        const targetOgwp = targetP?.ogwp || 0.33;
        const oppOgwp = oppP?.ogwp || 0.33;

        const corrOppId = (!isCurrentMatchFinished && opponentId) ? opponentId : null;
        const corrTargetId = (!isCurrentMatchFinished && opponentId) ? targetId : null;

        // matchesLeft===1 → no auto-after future rounds
        const tPtsTie = targetBasePts + 1;
        const oPtsTie = oppBasePts + 1;
        if (checkPlayerCut(targetId, tPtsTie, targetOmwp, targetGwp, targetOgwp, corrOppId, oPtsTie)) {
            counters.tieSuccesses += weight;
        }
        if (oppP && checkPlayerCut(opponentId, oPtsTie, oppOmwp, oppGwp, oppOgwp, corrTargetId, tPtsTie)) {
            counters.oppTieSuccesses += weight;
        }

        const tPtsWin = targetBasePts + 3;
        const oPtsWhenTargetWins = oppBasePts + 0;
        if (checkPlayerCut(targetId, tPtsWin, targetOmwp, targetGwp, targetOgwp, corrOppId, oPtsWhenTargetWins)) {
            counters.winSuccesses += weight;
        }

        const tPtsLoss = targetBasePts + 0;
        const oPtsWhenTargetLoses = oppBasePts + 3;
        if (checkPlayerCut(targetId, tPtsLoss, targetOmwp, targetGwp, targetOgwp, corrOppId, oPtsWhenTargetLoses)) {
            counters.lossSuccesses += weight;
        }

        // Multi-round paths unused when matchesLeft===1 — keep zeros for API parity.
        void matchesLeft;
    }

    /**
     * Exhaustive weighted enumeration of unfinished last-round matches.
     */
    function executeExactTieSimulation(ctx) {
        const fixedMatchDeltas = new Map(ctx.fixedMatchDeltas || []);
        const completedRoundOpponents = new Map(ctx.completedRoundOpponents || []);
        const liveUnfinishedMatches = ctx.liveUnfinishedMatches || [];
        const basePlayers = ctx.basePlayers || [];
        const totalRounds = ctx.totalRounds;
        const matchesLeft = ctx.matchesLeft;
        const counters = emptyScenarioCounters();

        function buildBaseBoard() {
            const simBoard = basePlayers.map(p => {
                const completedOpp = completedRoundOpponents.get(p.id);
                return {
                    id: p.id,
                    name: p.name,
                    points: p.points + (fixedMatchDeltas.get(p.id) || 0),
                    baseOmwp: p.baseOmwp,
                    gwp: p.gwp,
                    ogwp: p.ogwp,
                    opponents: completedOpp ? [completedOpp] : []
                };
            });
            const boardMap = new Map();
            for (let i = 0; i < simBoard.length; i++) {
                boardMap.set(simBoard[i].id, simBoard[i]);
            }
            return { simBoard, boardMap };
        }

        function applyMatchOutcome(boardMap, m, outcome) {
            const p1 = boardMap.get(m.id1);
            if (!p1) return;
            if (m.ghost || m.id2 == null) {
                if (typeof m.forcedPts === 'number') {
                    p1.points += m.forcedPts;
                } else {
                    p1.points += outcome.ghostPts;
                }
                return;
            }
            const p2 = boardMap.get(m.id2);
            if (!p2) return;
            if (typeof m.forcedPts1 === 'number' || typeof m.forcedPts2 === 'number') {
                p1.points += Number(m.forcedPts1) || 0;
                p2.points += Number(m.forcedPts2) || 0;
            } else {
                p1.points += outcome.p1;
                p2.points += outcome.p2;
            }
            p1.opponents.push(p2.id);
            p2.opponents.push(p1.id);
        }

        function matchOutcomesFor(m) {
            // Forced outcomes collapse to a single weight-1 branch.
            if (m.ghost || m.id2 == null) {
                if (typeof m.forcedPts === 'number') {
                    return [{ key: 'forced', p1: 0, p2: 0, ghostPts: m.forcedPts, weight: 1 }];
                }
                return MATCH_OUTCOMES;
            }
            if (typeof m.forcedPts1 === 'number' || typeof m.forcedPts2 === 'number') {
                return [{
                    key: 'forced',
                    p1: Number(m.forcedPts1) || 0,
                    p2: Number(m.forcedPts2) || 0,
                    ghostPts: 0,
                    weight: 1
                }];
            }
            return MATCH_OUTCOMES;
        }

        const choices = new Array(liveUnfinishedMatches.length);
        let exactCombinations = 0;
        const dfsCounted = function (matchIdx, weight) {
            if (weight === 0) return;
            if (matchIdx >= liveUnfinishedMatches.length) {
                exactCombinations++;
                const built = buildBaseBoard();
                for (let i = 0; i < choices.length; i++) {
                    applyMatchOutcome(built.boardMap, liveUnfinishedMatches[i], choices[i]);
                }
                applyOmwp(built.simBoard, built.boardMap, totalRounds, matchesLeft);
                scoreLastRoundScenarios(ctx, built.simBoard, built.boardMap, counters, weight);
                return;
            }
            const m = liveUnfinishedMatches[matchIdx];
            const outs = matchOutcomesFor(m);
            for (let oi = 0; oi < outs.length; oi++) {
                choices[matchIdx] = outs[oi];
                dfsCounted(matchIdx + 1, weight * outs[oi].weight);
            }
        };

        if (liveUnfinishedMatches.length === 0) {
            const { simBoard, boardMap } = buildBaseBoard();
            applyOmwp(simBoard, boardMap, totalRounds, matchesLeft);
            scoreLastRoundScenarios(ctx, simBoard, boardMap, counters, 1);
            exactCombinations = 1;
        } else {
            dfsCounted(0, 1);
        }

        const denom = counters.weightSum > 0 ? counters.weightSum : 1;
        return buildResultPayload(ctx, counters, denom, 'exact', {
            simCountUsed: 0,
            exactCombinations: exactCombinations,
            exactUnfinishedMatches: liveUnfinishedMatches.length
        });
    }

    /**
     * @param {object} ctx serializable simulation context
     * @returns {object} chance* / pts* result payload
     */
    function executeMonteCarloTieSimulation(ctx) {
        const SIM_COUNT = Math.max(20, Number(ctx.simCount) || 100);
        const targetId = ctx.targetId;
        const opponentId = ctx.opponentId || null;
        const cutSize = ctx.cutSize;
        const cutRule = ctx.cutRule || 'hard';
        const currentRound = ctx.currentRound;
        const totalRounds = ctx.totalRounds;
        const projectedFinalBubble = ctx.projectedFinalBubble;
        const matchesLeft = ctx.matchesLeft;
        const isCurrentMatchFinished = Boolean(ctx.isCurrentMatchFinished);
        const targetBasePts = ctx.targetBasePts;
        const oppBasePts = ctx.oppBasePts || 0;
        const fixedAheadCount = Number(ctx.fixedAheadCount) || 0;
        const basePlayers = ctx.basePlayers || [];

        const fixedMatchDeltas = new Map(ctx.fixedMatchDeltas || []);
        const completedRoundOpponents = new Map(ctx.completedRoundOpponents || []);
        const liveUnfinishedMatches = ctx.liveUnfinishedMatches || [];

        const counters = emptyScenarioCounters();
        let tieSuccesses = 0;
        let oppTieSuccesses = 0;
        let winSuccesses = 0;
        let lossSuccesses = 0;
        let doubleTieSuccesses = 0;
        let oppDoubleTieSuccesses = 0;
        let winTieSuccesses = 0;
        let winLossSuccesses = 0;
        let tieLossSuccesses = 0;
        let doubleWinSuccesses = 0;
        let tripleTieSuccesses = 0;
        let oppTripleTieSuccesses = 0;
        let winDoubleTieSuccesses = 0;
        let oppWinDoubleTieSuccesses = 0;
        let winTieLossSuccesses = 0;
        let twoWinLossSuccesses = 0;
        let twoWinTieSuccesses = 0;
        let tripleWinSuccesses = 0;
        let simBubbleSum = 0;

        const rollSingleMatchPts = () => {
            const r = Math.random();
            if (r < 0.08) return 1;
            if (r < 0.54) return 3;
            return 0;
        };

        for (let simIdx = 0; simIdx < SIM_COUNT; simIdx++) {
            const simBoard = basePlayers.map(p => {
                const completedOpp = completedRoundOpponents.get(p.id);
                return {
                    id: p.id,
                    name: p.name,
                    points: p.points + (fixedMatchDeltas.get(p.id) || 0),
                    baseOmwp: p.baseOmwp,
                    gwp: p.gwp,
                    ogwp: p.ogwp,
                    opponents: completedOpp ? [completedOpp] : []
                };
            });

            const boardMap = new Map();
            for (let i = 0; i < simBoard.length; i++) {
                boardMap.set(simBoard[i].id, simBoard[i]);
            }

            for (let ui = 0; ui < liveUnfinishedMatches.length; ui++) {
                const m = liveUnfinishedMatches[ui];
                const p1 = boardMap.get(m.id1);
                if (!p1) continue;

                if (m.ghost || m.id2 == null) {
                    if (typeof m.forcedPts === 'number') {
                        p1.points += m.forcedPts;
                    } else {
                        const roll = Math.random();
                        if (roll < 0.08) p1.points += 1;
                        else if (roll < 0.54) p1.points += 3;
                    }
                    continue;
                }

                const p2 = boardMap.get(m.id2);
                if (!p2) continue;

                if (typeof m.forcedPts1 === 'number' || typeof m.forcedPts2 === 'number') {
                    p1.points += Number(m.forcedPts1) || 0;
                    p2.points += Number(m.forcedPts2) || 0;
                } else {
                    const roll = Math.random();
                    if (roll < 0.08) {
                        p1.points += 1;
                        p2.points += 1;
                    } else if (roll < 0.54) {
                        p1.points += 3;
                    } else {
                        p2.points += 3;
                    }
                }
                p1.opponents.push(p2.id);
                p2.opponents.push(p1.id);
            }

            for (let r = currentRound + 1; r <= totalRounds; r++) {
                simBoard.sort((a, b) => {
                    if (b.points !== a.points) return b.points - a.points;
                    return (Math.random() - 0.5);
                });

                const isFinalRound = (r === totalRounds);
                const currentBubbleBeforeRound = simBoard[Math.min(cutSize - 1, simBoard.length - 1)]?.points || projectedFinalBubble;

                for (let pi = 0; pi < simBoard.length; pi += 2) {
                    if (pi + 1 >= simBoard.length) {
                        simBoard[pi].points += 3;
                        continue;
                    }

                    const p1 = simBoard[pi];
                    const p2 = simBoard[pi + 1];
                    p1.opponents.push(p2.id);
                    p2.opponents.push(p1.id);

                    const bothCanID = isFinalRound && (p1.points > currentBubbleBeforeRound && p2.points > currentBubbleBeforeRound);

                    const roll = Math.random();
                    if (bothCanID && roll < 0.75) {
                        p1.points += 1;
                        p2.points += 1;
                    } else if (roll < 0.08) {
                        p1.points += 1;
                        p2.points += 1;
                    } else if (roll < 0.54) {
                        p1.points += 3;
                    } else {
                        p2.points += 3;
                    }
                }
            }

            let targetAutoAfter1 = 0;
            let oppAutoAfter1 = 0;
            let targetAutoAfter2 = 0;
            let oppAutoAfter2 = 0;
            let targetAutoAfter3 = 0;
            let oppAutoAfter3 = 0;

            for (let mIdx = 1; mIdx < matchesLeft; mIdx++) {
                const tRoll = rollSingleMatchPts();
                const oRoll = rollSingleMatchPts();
                targetAutoAfter1 += tRoll;
                oppAutoAfter1 += oRoll;
                if (mIdx >= 2) {
                    targetAutoAfter2 += tRoll;
                    oppAutoAfter2 += oRoll;
                }
                if (mIdx >= 3) {
                    targetAutoAfter3 += tRoll;
                    oppAutoAfter3 += oRoll;
                }
            }

            applyOmwp(simBoard, boardMap, totalRounds, matchesLeft);

            const sortedEndPts = simBoard.map(p => p.points).sort((a, b) => b - a);
            const bubbleIdx = Math.min(Math.max(0, cutSize - 1 - fixedAheadCount), sortedEndPts.length - 1);
            simBubbleSum += sortedEndPts[bubbleIdx] || 0;

            const checkPlayerCut = makeCheckPlayerCut(simBoard, fixedAheadCount, cutSize, cutRule);

            const targetP = boardMap.get(targetId);
            const oppP = opponentId ? boardMap.get(opponentId) : null;
            const targetOmwp = targetP?.finalOmwp || 0.5;
            const oppOmwp = oppP?.finalOmwp || 0.5;
            const targetGwp = targetP?.gwp || 0.33;
            const oppGwp = oppP?.gwp || 0.33;
            const targetOgwp = targetP?.ogwp || 0.33;
            const oppOgwp = oppP?.ogwp || 0.33;

            const corrOppId = (!isCurrentMatchFinished && opponentId) ? opponentId : null;
            const corrTargetId = (!isCurrentMatchFinished && opponentId) ? targetId : null;

            const tPtsTie = targetBasePts + 1 + targetAutoAfter1;
            const oPtsTie = oppBasePts + 1 + oppAutoAfter1;
            if (checkPlayerCut(targetId, tPtsTie, targetOmwp, targetGwp, targetOgwp, corrOppId, oPtsTie)) tieSuccesses++;
            if (oppP && checkPlayerCut(opponentId, oPtsTie, oppOmwp, oppGwp, oppOgwp, corrTargetId, tPtsTie)) oppTieSuccesses++;

            const tPtsWin = targetBasePts + 3 + targetAutoAfter1;
            const oPtsWhenTargetWins = oppBasePts + 0 + oppAutoAfter1;
            if (checkPlayerCut(targetId, tPtsWin, targetOmwp, targetGwp, targetOgwp, corrOppId, oPtsWhenTargetWins)) winSuccesses++;

            const tPtsLoss = targetBasePts + 0 + targetAutoAfter1;
            const oPtsWhenTargetLoses = oppBasePts + 3 + oppAutoAfter1;
            if (checkPlayerCut(targetId, tPtsLoss, targetOmwp, targetGwp, targetOgwp, corrOppId, oPtsWhenTargetLoses)) lossSuccesses++;

            const tPts2Tie = targetBasePts + 2 + targetAutoAfter2;
            const oPts2Tie = oppBasePts + 2 + oppAutoAfter2;
            if (checkPlayerCut(targetId, tPts2Tie, targetOmwp, targetGwp, targetOgwp, corrOppId, oPts2Tie)) doubleTieSuccesses++;
            if (oppP && checkPlayerCut(opponentId, oPts2Tie, oppOmwp, oppGwp, oppOgwp, corrTargetId, tPts2Tie)) oppDoubleTieSuccesses++;

            if (checkPlayerCut(targetId, targetBasePts + 4 + targetAutoAfter2, targetOmwp, targetGwp, targetOgwp)) winTieSuccesses++;
            if (checkPlayerCut(targetId, targetBasePts + 3 + targetAutoAfter2, targetOmwp, targetGwp, targetOgwp)) winLossSuccesses++;
            if (checkPlayerCut(targetId, targetBasePts + 1 + targetAutoAfter2, targetOmwp, targetGwp, targetOgwp)) tieLossSuccesses++;
            if (checkPlayerCut(targetId, targetBasePts + 6 + targetAutoAfter2, targetOmwp, targetGwp, targetOgwp)) doubleWinSuccesses++;

            const tPts3Tie = targetBasePts + 3 + targetAutoAfter3;
            const oPts3Tie = oppBasePts + 3 + oppAutoAfter3;
            if (checkPlayerCut(targetId, tPts3Tie, targetOmwp, targetGwp, targetOgwp, corrOppId, oPts3Tie)) tripleTieSuccesses++;
            if (oppP && checkPlayerCut(opponentId, oPts3Tie, oppOmwp, oppGwp, oppOgwp, corrTargetId, tPts3Tie)) oppTripleTieSuccesses++;

            const tPtsWin2Tie = targetBasePts + 5 + targetAutoAfter3;
            const oPtsWin2Tie = oppBasePts + 5 + oppAutoAfter3;
            if (checkPlayerCut(targetId, tPtsWin2Tie, targetOmwp, targetGwp, targetOgwp)) winDoubleTieSuccesses++;
            if (oppP && checkPlayerCut(opponentId, oPtsWin2Tie, oppOmwp, oppGwp, oppOgwp)) oppWinDoubleTieSuccesses++;

            if (checkPlayerCut(targetId, targetBasePts + 4 + targetAutoAfter3, targetOmwp, targetGwp, targetOgwp)) winTieLossSuccesses++;
            if (checkPlayerCut(targetId, targetBasePts + 6 + targetAutoAfter3, targetOmwp, targetGwp, targetOgwp)) twoWinLossSuccesses++;
            if (checkPlayerCut(targetId, targetBasePts + 7 + targetAutoAfter3, targetOmwp, targetGwp, targetOgwp)) twoWinTieSuccesses++;
            if (checkPlayerCut(targetId, targetBasePts + 9 + targetAutoAfter3, targetOmwp, targetGwp, targetOgwp)) tripleWinSuccesses++;
        }

        counters.tieSuccesses = tieSuccesses;
        counters.oppTieSuccesses = oppTieSuccesses;
        counters.winSuccesses = winSuccesses;
        counters.lossSuccesses = lossSuccesses;
        counters.doubleTieSuccesses = doubleTieSuccesses;
        counters.oppDoubleTieSuccesses = oppDoubleTieSuccesses;
        counters.winTieSuccesses = winTieSuccesses;
        counters.winLossSuccesses = winLossSuccesses;
        counters.tieLossSuccesses = tieLossSuccesses;
        counters.doubleWinSuccesses = doubleWinSuccesses;
        counters.tripleTieSuccesses = tripleTieSuccesses;
        counters.oppTripleTieSuccesses = oppTripleTieSuccesses;
        counters.winDoubleTieSuccesses = winDoubleTieSuccesses;
        counters.oppWinDoubleTieSuccesses = oppWinDoubleTieSuccesses;
        counters.winTieLossSuccesses = winTieLossSuccesses;
        counters.twoWinLossSuccesses = twoWinLossSuccesses;
        counters.twoWinTieSuccesses = twoWinTieSuccesses;
        counters.tripleWinSuccesses = tripleWinSuccesses;
        counters.simBubbleSum = simBubbleSum;

        return buildResultPayload(ctx, counters, SIM_COUNT, 'montecarlo', {
            simCountUsed: SIM_COUNT
        });
    }

    function executePreparedTieSimulation(ctx) {
        const input = ctx || {};
        if (canUseExactEnumeration(input)) {
            return executeExactTieSimulation(input);
        }
        const result = executeMonteCarloTieSimulation(input);
        const algo = normalizeAlgorithm(input.algorithm);
        if (algo === 'exact' && Number(input.matchesLeft) === 1) {
            result.method = 'montecarlo_fallback';
            result.exactFallbackReason = 'too_many_unfinished_or_not_last_round';
        }
        return result;
    }

    const api = {
        getAdaptiveSimCount,
        canUseExactEnumeration,
        normalizeAlgorithm,
        EXACT_MAX_MATCHES_HYBRID,
        EXACT_MAX_MATCHES_STRICT,
        executePreparedTieSimulation,
        executeMonteCarloTieSimulation,
        executeExactTieSimulation
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.LorcanaTieSim = api;
})(typeof self !== 'undefined' ? self : globalThis);
