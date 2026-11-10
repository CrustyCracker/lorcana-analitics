/**
 * Pure Monte Carlo tie / cut simulation (main thread + Web Worker + Node tests).
 * Input must be a plain serializable context from prepareTieSimulationContext().
 */
(function (root) {
    'use strict';

    function getAdaptiveSimCount(playerCount) {
        const n = Number(playerCount) || 0;
        if (n > 800) return 100;
        if (n > 200) return 200;
        return 600;
    }

    /**
     * @param {object} ctx serializable simulation context
     * @returns {object} chance* / pts* result payload
     */
    function executePreparedTieSimulation(ctx) {
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

                // Ghost: in-scope player paired with someone outside the scoped board.
                // Dropping these matches understates the field and can falsely mark TIE as safe.
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

            const sortedEndPts = simBoard.map(p => p.points).sort((a, b) => b - a);
            // fixedAheadCount = gracze poza scope'em zawsze powyżej koszyka cut — koryguj indeks bubble
            const bubbleIdx = Math.min(Math.max(0, cutSize - 1 - fixedAheadCount), sortedEndPts.length - 1);
            simBubbleSum += sortedEndPts[bubbleIdx] || 0;

            const checkPlayerCut = (playerId, simPoints, simOmwp, simGwp, simOgwp, correlatedOppId, correlatedOppPts) => {
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
                // Gracze fixedAhead mają punkty powyżej zakresu — traktuj jako powyżej dowolnego scenariusza w scope
                for (let i = 0; i < fixedAheadCount; i++) {
                    sortedPoints.push(simPoints + 99);
                }
                sortedPoints.push(simPoints);
                sortedPoints.sort((a, b) => b - a);
                const softBubbleIdx = Math.min(cutSize - 1, sortedPoints.length - 1);
                return simPoints >= sortedPoints[softBubbleIdx];
            };

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

        const basePtsForCalc = targetBasePts;
        const simProjectedBubble = simBubbleSum > 0 ? Math.round(simBubbleSum / SIM_COUNT) : projectedFinalBubble;

        return {
            matchesLeft,
            isCurrentMatchFinished,
            chanceTie: Math.round((tieSuccesses / SIM_COUNT) * 100),
            oppChanceTie: Math.round((oppTieSuccesses / SIM_COUNT) * 100),
            chanceWin: Math.round((winSuccesses / SIM_COUNT) * 100),
            chanceLoss: Math.round((lossSuccesses / SIM_COUNT) * 100),
            chanceDoubleTie: Math.round((doubleTieSuccesses / SIM_COUNT) * 100),
            oppChanceDoubleTie: Math.round((oppDoubleTieSuccesses / SIM_COUNT) * 100),
            chanceWinTie: Math.round((winTieSuccesses / SIM_COUNT) * 100),
            chanceWinLoss: Math.round((winLossSuccesses / SIM_COUNT) * 100),
            chanceTieLoss: Math.round((tieLossSuccesses / SIM_COUNT) * 100),
            chanceDoubleWin: Math.round((doubleWinSuccesses / SIM_COUNT) * 100),
            chanceTripleTie: Math.round((tripleTieSuccesses / SIM_COUNT) * 100),
            oppChanceTripleTie: Math.round((oppTripleTieSuccesses / SIM_COUNT) * 100),
            chanceWinDoubleTie: Math.round((winDoubleTieSuccesses / SIM_COUNT) * 100),
            oppChanceWinDoubleTie: Math.round((oppWinDoubleTieSuccesses / SIM_COUNT) * 100),
            chanceWinTieLoss: Math.round((winTieLossSuccesses / SIM_COUNT) * 100),
            chanceTwoWinLoss: Math.round((twoWinLossSuccesses / SIM_COUNT) * 100),
            chanceTwoWinTie: Math.round((twoWinTieSuccesses / SIM_COUNT) * 100),
            chanceTripleWin: Math.round((tripleWinSuccesses / SIM_COUNT) * 100),
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
            simCountUsed: SIM_COUNT
        };
    }

    const api = {
        getAdaptiveSimCount,
        executePreparedTieSimulation
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    root.LorcanaTieSim = api;
})(typeof self !== 'undefined' ? self : globalThis);
