const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
    prepareTieSimulationContext,
    buildStandingsMap,
    siteConfig
} = require('../app.js');
const {
    canUseExactEnumeration,
    executePreparedTieSimulation,
    executeExactTieSimulation,
    EXACT_MAX_MATCHES_HYBRID
} = require('../tie-sim-core.js');

function buildTinyLastRoundField() {
    // 8 players, Top 4, last round — 3 unfinished field matches + target table.
    const standings = [];
    for (let i = 0; i < 8; i++) {
        standings.push({
            rank: i + 1,
            match_points: i < 4 ? 15 : 12,
            opponent_match_win_percentage: 0.55 - i * 0.01,
            game_win_percentage: 0.5,
            opponent_game_win_percentage: 0.5,
            player: { id: i + 1, best_identifier: `P${i + 1}` }
        });
    }
    const pairings = [
        // Target (P5 @12) vs P6 @12 — unfinished
        {
            table_number: 1,
            status: 'IN_PROGRESS',
            player_match_relationships: [
                { player: { id: 5 } },
                { player: { id: 6 } }
            ]
        },
        // Field unfinished
        {
            table_number: 2,
            status: 'IN_PROGRESS',
            player_match_relationships: [
                { player: { id: 1 } },
                { player: { id: 2 } }
            ]
        },
        {
            table_number: 3,
            status: 'IN_PROGRESS',
            player_match_relationships: [
                { player: { id: 3 } },
                { player: { id: 4 } }
            ]
        },
        {
            table_number: 4,
            status: 'IN_PROGRESS',
            player_match_relationships: [
                { player: { id: 7 } },
                { player: { id: 8 } }
            ]
        }
    ];
    return { standings, pairings, target: standings[4], opponent: { id: 6, name: 'P6' } };
}

describe('Hybrid / exact last-round path', () => {
    let prevAlgo;

    before(() => {
        prevAlgo = siteConfig.predictionAlgorithm;
        siteConfig.predictionAlgorithm = 'hybrid';
    });

    after(() => {
        siteConfig.predictionAlgorithm = prevAlgo || 'hybrid';
    });

    it('canUseExactEnumeration: true on last round with small unfinished set', () => {
        const { standings, pairings, target, opponent } = buildTinyLastRoundField();
        const map = buildStandingsMap(standings);
        const ctx = prepareTieSimulationContext(
            target, opponent, standings, pairings, map,
            4, 'hard', 8, 8, 15, true, 40
        );
        ctx.algorithm = 'hybrid';
        assert.equal(ctx.matchesLeft, 1);
        assert.equal(ctx.currentRound, 8);
        assert.equal(ctx.totalRounds, 8);
        assert.ok(ctx.liveUnfinishedMatches.length <= EXACT_MAX_MATCHES_HYBRID);
        assert.equal(canUseExactEnumeration(ctx), true);
    });

    it('hybrid last-round uses method=exact', () => {
        const { standings, pairings, target, opponent } = buildTinyLastRoundField();
        const map = buildStandingsMap(standings);
        const ctx = prepareTieSimulationContext(
            target, opponent, standings, pairings, map,
            4, 'hard', 8, 8, 15, true, 40
        );
        ctx.algorithm = 'hybrid';
        const result = executePreparedTieSimulation(ctx);
        assert.equal(result.method, 'exact');
        assert.ok(result.exactCombinations >= 1);
        assert.ok(result.chanceTie >= 0 && result.chanceTie <= 100);
        assert.ok(result.chanceWin >= result.chanceTie, 'WIN should dominate or equal TIE on bubble');
    });

    it('montecarlo mode never picks exact even on last round', () => {
        const { standings, pairings, target, opponent } = buildTinyLastRoundField();
        const map = buildStandingsMap(standings);
        const ctx = prepareTieSimulationContext(
            target, opponent, standings, pairings, map,
            4, 'hard', 8, 8, 15, true, 40
        );
        ctx.algorithm = 'montecarlo';
        assert.equal(canUseExactEnumeration(ctx), false);
        const result = executePreparedTieSimulation(ctx);
        assert.equal(result.method, 'montecarlo');
        assert.ok(result.simCountUsed >= 20);
    });

    it('multi-round (matchesLeft>1) stays Monte Carlo under hybrid', () => {
        const { standings, pairings, target, opponent } = buildTinyLastRoundField();
        const map = buildStandingsMap(standings);
        // Round 7 of 8 → matchesLeft=2
        const ctx = prepareTieSimulationContext(
            target, opponent, standings, pairings, map,
            4, 'hard', 7, 8, 15, true, 40
        );
        ctx.algorithm = 'hybrid';
        assert.ok(ctx.matchesLeft >= 2);
        assert.equal(canUseExactEnumeration(ctx), false);
        const result = executePreparedTieSimulation(ctx);
        assert.equal(result.method, 'montecarlo');
    });

    it('exact enumeration is deterministic for forced field results', () => {
        const { standings, pairings, target, opponent } = buildTinyLastRoundField();
        const map = buildStandingsMap(standings);
        const ctx = prepareTieSimulationContext(
            target, opponent, standings, pairings, map,
            4, 'hard', 8, 8, 15, true, 40
        );
        ctx.algorithm = 'exact';
        // Force every unfinished field match to a draw.
        ctx.liveUnfinishedMatches = ctx.liveUnfinishedMatches.map(m => ({
            ...m,
            forcedPts1: 1,
            forcedPts2: 1
        }));
        const a = executeExactTieSimulation(ctx);
        const b = executeExactTieSimulation(ctx);
        assert.equal(a.method, 'exact');
        assert.equal(a.chanceTie, b.chanceTie);
        assert.equal(a.chanceWin, b.chanceWin);
        assert.equal(a.chanceLoss, b.chanceLoss);
        assert.equal(a.exactCombinations, 1);
    });

    it('too many unfinished matches → MC fallback in exact mode', () => {
        const standings = [];
        for (let i = 0; i < 40; i++) {
            standings.push({
                rank: i + 1,
                match_points: 12,
                opponent_match_win_percentage: 0.5,
                game_win_percentage: 0.5,
                opponent_game_win_percentage: 0.5,
                player: { id: i + 1, best_identifier: `X${i + 1}` }
            });
        }
        const pairings = [];
        for (let i = 0; i < 20; i++) {
            pairings.push({
                table_number: i + 1,
                status: 'IN_PROGRESS',
                player_match_relationships: [
                    { player: { id: i * 2 + 1 } },
                    { player: { id: i * 2 + 2 } }
                ]
            });
        }
        const map = buildStandingsMap(standings);
        const ctx = prepareTieSimulationContext(
            standings[0], { id: 2, name: 'X2' }, standings, pairings, map,
            8, 'hard', 9, 9, 15, true, 40
        );
        ctx.algorithm = 'exact';
        assert.ok(ctx.liveUnfinishedMatches.length > 12);
        assert.equal(canUseExactEnumeration(ctx), false);
        const result = executePreparedTieSimulation(ctx);
        assert.equal(result.method, 'montecarlo_fallback');
    });
});
