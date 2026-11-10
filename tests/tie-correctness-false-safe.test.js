const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    prepareTieSimulationContext,
    runLiveTieSimulation,
    buildStandingsMap
} = require('../app.js');
const { executePreparedTieSimulation } = require('../tie-sim-core.js');

/**
 * 300-player final-round field where many bubble players are paired DOWN
 * against out-of-scope lows. Dropping those cross-boundary matches was a
 * catastrophic false-safe-TIE bug (sim said 100% while winners flood the cut).
 */
function buildPairDownBubbleField() {
    const standings = [];
    for (let i = 0; i < 300; i++) {
        let pts;
        if (i < 4) pts = 18;
        else if (i < 12) pts = 15;
        else if (i < 20) pts = 12;
        else pts = Math.max(0, 9 - Math.floor((i - 20) / 40) * 3);

        standings.push({
            rank: i + 1,
            match_points: pts,
            opponent_match_win_percentage: Number((0.58 - i * 0.0004).toFixed(4)),
            game_win_percentage: 0.55,
            opponent_game_win_percentage: 0.50,
            player: { id: i + 1, best_identifier: `P${i + 1}` }
        });
    }

    const fifteen = standings.filter(p => p.match_points === 15);
    const lows = standings.filter(p => p.match_points <= 3).slice(0, fifteen.length);
    const tops = standings.filter(p => p.match_points === 18);

    const pairings = [];
    for (let i = 0; i < fifteen.length; i++) {
        pairings.push({
            table_number: i + 1,
            status: 'IN_PROGRESS',
            player_match_relationships: [
                { player: { id: fifteen[i].player.id, best_identifier: fifteen[i].player.best_identifier } },
                { player: { id: lows[i].player.id, best_identifier: lows[i].player.best_identifier } }
            ]
        });
    }
    for (let i = 0; i < tops.length; i += 2) {
        pairings.push({
            table_number: 100 + i,
            status: 'IN_PROGRESS',
            player_match_relationships: [
                { player: { id: tops[i].player.id } },
                { player: { id: tops[i + 1].player.id } }
            ]
        });
    }

    const target = fifteen[0];
    const opponent = fifteen[1];
    return { standings, pairings, target, opponent, fifteen };
}

describe('Can I Tie correctness — no false-safe TIE', () => {
    it('targetCap counts the unfinished current match (matchesLeft * 3)', () => {
        const standings = Array.from({ length: 260 }, (_, i) => ({
            rank: i + 1,
            match_points: i < 2 ? 15 : (i < 40 ? 12 : 3),
            opponent_match_win_percentage: 0.5,
            game_win_percentage: 0.5,
            opponent_game_win_percentage: 0.5,
            player: { id: i + 1, best_identifier: `T${i + 1}` }
        }));
        const pairings = [{
            table_number: 1,
            status: 'IN_PROGRESS',
            player_match_relationships: [
                { player: { id: 1 } },
                { player: { id: 2 } }
            ]
        }];
        const map = buildStandingsMap(standings);
        const ctx = prepareTieSimulationContext(
            standings[0],
            { id: 2, name: 'T2' },
            standings,
            pairings,
            map,
            8,
            'hard',
            8,
            9,
            18,
            true,
            40
        );
        // Unfinished R8 with R9 left => matchesLeft=2, max = 15+6=21 (not 15+3)
        assert.equal(ctx.matchesLeft, 2);
        assert.equal(ctx.targetCap, 21, 'Understated targetCap previously treated catchable players as fixedAhead');
    });

    it('scoped board keeps ghost results for cross-boundary unfinished pair-downs', () => {
        const { standings, pairings, target, opponent, fifteen } = buildPairDownBubbleField();
        const map = buildStandingsMap(standings);
        const ctx = prepareTieSimulationContext(
            target,
            { id: opponent.player.id, name: opponent.player.best_identifier },
            standings,
            pairings,
            map,
            8,
            'hard',
            9,
            9,
            16,
            true,
            200
        );

        assert.equal(ctx.scoped, true);
        assert.ok(ctx.fullPlayerCount > 250);

        const ghosts = ctx.liveUnfinishedMatches.filter(m => m.ghost);
        assert.ok(
            ghosts.length >= 6,
            `Expected >=6 ghost pair-downs for other 15-pt players, got ${ghosts.length}`
        );

        // Target vs opponent must NOT also be RNG'd on the board (hypothetical W/T/L path)
        const targetId = target.player.id;
        const oppId = opponent.player.id;
        const leakedTargetMatch = ctx.liveUnfinishedMatches.some(m => {
            if (m.ghost) return false;
            return (m.id1 === targetId && m.id2 === oppId) || (m.id1 === oppId && m.id2 === targetId);
        });
        assert.equal(leakedTargetMatch, false, 'Target unfinished match must not be double-simulated on the board');

        const ghostIds = new Set(ghosts.map(m => m.id1));
        for (const p of fifteen) {
            if (p.player.id === targetId || p.player.id === oppId) continue;
            assert.ok(
                ghostIds.has(p.player.id),
                `15-pt player ${p.player.id} pair-down missing from ghost unfinished list`
            );
        }
    });

    it('REGRESSION: when all pair-down rivals win, TIE must NOT report safe cut', () => {
        const { standings, pairings, target, opponent } = buildPairDownBubbleField();
        const map = buildStandingsMap(standings);
        const ctx = prepareTieSimulationContext(
            target,
            { id: opponent.player.id, name: opponent.player.best_identifier },
            standings,
            pairings,
            map,
            8,
            'hard',
            9,
            9,
            16,
            true,
            300
        );

        // Adversarial field: every ghost pair-down wins (+3 → 18). Tops play out normally
        // unless forced — force tops to split so 4 players remain >=18, plus 6 ghosts at 18.
        const forced = {
            ...ctx,
            liveUnfinishedMatches: ctx.liveUnfinishedMatches.map(m => {
                if (m.ghost) return { ...m, forcedPts: 3 };
                // Top tables: give both +0 via forced draw-less split encoded as p1 win
                return { ...m, forcedPts1: 3, forcedPts2: 0 };
            })
        };

        const sim = executePreparedTieSimulation(forced);
        // 4 tops with at least 2 winners at 21 + 2 losers at 18, plus 6 ghosts at 18
        // => >=8 players strictly above target's TIE score of 16 => chanceTie must be 0
        assert.equal(
            sim.chanceTie,
            0,
            `False-safe TIE: expected 0% after pair-down wins flood the cut, got ${sim.chanceTie}%`
        );
        // WIN to 18 can still clear a Top-8 vs the same pack (OMWP) — that is fine.
        // The catastrophic bug was marking TIE-to-16 as safe while rivals leap to 18.
        assert.ok(
            sim.chanceWin >= sim.chanceTie,
            'WIN chance must be at least TIE chance'
        );
    });

    it('REGRESSION: live scoped Monte Carlo must not claim ~100% TIE on pair-down bubble', () => {
        const { standings, pairings, target, opponent } = buildPairDownBubbleField();
        const map = buildStandingsMap(standings);
        const sim = runLiveTieSimulation(
            target,
            { id: opponent.player.id, name: opponent.player.best_identifier },
            standings,
            pairings,
            map,
            8,
            'hard',
            9,
            9,
            16,
            true,
            400
        );

        // Before the ghost fix this returned 100. Safe banner threshold is 85/90 —
        // staying under 70 keeps the UI out of "PEWNY ID" territory for this trap.
        assert.ok(
            sim.chanceTie < 70,
            `Scoped pair-down field must not overstate TIE (got ${sim.chanceTie}%; was 100% pre-fix)`
        );
    });
});
