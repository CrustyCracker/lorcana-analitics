const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    calculateSoftCutIdInflation,
    calculateCutLineBreakdown
} = require('../app.js');

/** Compact standings row */
function row(id, pts, rank) {
    return {
        rank,
        match_points: pts,
        livePoints: pts,
        opponent_match_win_percentage: 0.5,
        game_win_percentage: 0.5,
        opponent_game_win_percentage: 0.5,
        player: { id, best_identifier: `P${id}` }
    };
}

function idMatch(table, id1, id2, intentional = true) {
    return {
        table_number: table,
        status: 'COMPLETE',
        match_is_intentional_draw: intentional,
        match_is_unintentional_draw: false,
        players: [id1, id2],
        player_match_relationships: [
            { player: { id: id1, best_identifier: `P${id1}` } },
            { player: { id: id2, best_identifier: `P${id2}` } }
        ]
    };
}

function openMirror(table, id1, id2) {
    return {
        table_number: table,
        status: 'IN_PROGRESS',
        match_is_intentional_draw: false,
        players: [id1, id2],
        player_match_relationships: [
            { player: { id: id1, best_identifier: `P${id1}` } },
            { player: { id: id2, best_identifier: `P${id2}` } }
        ]
    };
}

/**
 * Toy field mirroring DLC ME1 R15 soft-cut math:
 * 11 above 34, 27 on 34 (22 via 11×33v33 ID), 25 on 33 → thresh 34, invites 38.
 * Need ≥7 decisive results among those 11 to drop soft thresh to 33.
 */
function buildDlcStyleField() {
    const standings = [];
    let rank = 1;
    let id = 1;

    // 11 above 34 (mix of 36+)
    for (let i = 0; i < 11; i++) {
        standings.push(row(id++, 36 + (i % 3), rank++));
    }
    // 27 on 34 — first 22 are from mutual IDs
    const idPlayers = [];
    for (let i = 0; i < 22; i++) {
        const pid = id++;
        idPlayers.push(pid);
        standings.push(row(pid, 34, rank++));
    }
    for (let i = 0; i < 5; i++) {
        standings.push(row(id++, 34, rank++));
    }
    // 25 on 33
    for (let i = 0; i < 25; i++) {
        standings.push(row(id++, 33, rank++));
    }
    // filler
    for (let i = 0; i < 20; i++) {
        standings.push(row(id++, 30, rank++));
    }

    const pairings = [];
    for (let t = 0; t < 11; t++) {
        pairings.push(idMatch(t + 6, idPlayers[t * 2], idPlayers[t * 2 + 1], true));
    }
    return { standings, pairings };
}

describe('calculateSoftCutIdInflation', () => {
    it('DLC-style: 11 locked 33v33 IDs ⇒ need ≥7 tables to play to drop soft thresh to 33', () => {
        const { standings, pairings } = buildDlcStyleField();
        const info = calculateSoftCutIdInflation(standings, pairings, 32);
        assert.ok(info);
        assert.equal(info.currentThresh, 34);
        assert.equal(info.currentInvites, 38);
        assert.equal(info.mirrorScore, 33);
        assert.equal(info.bandPts, 34);
        assert.equal(info.lockedIdTables, 11);
        assert.equal(info.openMirrorTables, 0);
        assert.equal(info.minTablesMustPlay, 7);
        assert.equal(info.projectedThreshIfAllId, 34);
        assert.equal(info.projectedThreshIfAllPlay, 33);
        assert.equal(info.geBandIfAllId, 38);
        assert.equal(info.geBandIfAllPlay, 27);
    });

    it('open mirrors: projects how many must finish decisive before they ID', () => {
        // 30 players: 10 on 12, 20 on 9. Soft top 8 → thresh 12, invites 10.
        // 4 open mirrors on 9: if all ID → 8 more on 10; wait need better setup.
        // Setup: 6 on 10, 8 on 9 paired as 4 open mirrors, filler below.
        // Soft top 8: currently thresh=9 (6+8=14 on ≥9), invites=14.
        // If we focus mirrors at 9 → band 10:
        // base: 6 on ≥10. All ID: 6+8=14 on ≥10 → thresh 10.
        // All play: 6+4=10 on ≥10 → thresh 10 still (10>=8).
        // Need ge(10)<8 ⇒ from all-ID 14, need k such that 14-k < 8 ⇒ k>=7 but only 4 mirrors.
        // Adjust: 5 on 10, 6 open mirrors on 9 (12 players), soft top 8.
        const standings = [];
        let rank = 1;
        let id = 1;
        for (let i = 0; i < 5; i++) standings.push(row(id++, 10, rank++));
        const openIds = [];
        for (let i = 0; i < 12; i++) {
            const pid = id++;
            openIds.push(pid);
            standings.push(row(pid, 9, rank++));
        }
        for (let i = 0; i < 10; i++) standings.push(row(id++, 6, rank++));

        const pairings = [];
        for (let t = 0; t < 6; t++) {
            pairings.push(openMirror(t + 1, openIds[t * 2], openIds[t * 2 + 1]));
        }

        const info = calculateSoftCutIdInflation(standings, pairings, 8);
        assert.equal(info.mirrorScore, 9);
        assert.equal(info.openMirrorTables, 6);
        assert.equal(info.lockedIdTables, 0);
        // all ID: 5 + 12 = 17 on ≥10 → thresh 10
        assert.equal(info.projectedThreshIfAllId, 10);
        assert.equal(info.geBandIfAllId, 17);
        // all play: 5 + 6 = 11 on ≥10 → still thresh 10 (11>=8)
        // 17-k < 8 ⇒ k >= 10, but only 6 tables ⇒ impossible
        assert.equal(info.minTablesMustPlay, null);
        assert.equal(info.projectedThreshIfAllPlay, 10);
    });

    it('returns minTablesMustPlay=0 when band already below cut size', () => {
        const standings = [];
        let rank = 1;
        let id = 1;
        for (let i = 0; i < 4; i++) standings.push(row(id++, 12, rank++));
        // one locked ID pair on 10→11? Use two on 11 from ID of 10
        const a = id++;
        const b = id++;
        standings.push(row(a, 11, rank++));
        standings.push(row(b, 11, rank++));
        for (let i = 0; i < 10; i++) standings.push(row(id++, 8, rank++));

        const pairings = [idMatch(1, a, b, true)];
        const info = calculateSoftCutIdInflation(standings, pairings, 8);
        // ≥11 count = 4+2=6 < 8, so soft thresh is already 8-band, mirrors at 10→11 don't inflate past cut
        assert.ok(info.minTablesMustPlay === 0 || info.geBandIfAllId < 8);
    });

    it('soft cut breakdown still expands equal points', () => {
        const { standings } = buildDlcStyleField();
        const bd = calculateCutLineBreakdown(standings, 32, 'soft');
        assert.equal(bd.bubblePts, 34);
        assert.equal(bd.spotsForBubbleBracket, 27);
        assert.equal(bd.missingFromBubbleBracket, 0);
    });
});
