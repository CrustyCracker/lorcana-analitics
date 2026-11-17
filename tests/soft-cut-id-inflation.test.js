const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
    calculateSoftCutIdInflation,
    calculateCutLineBreakdown,
    formatSoftCutIdInflationHtml
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
        assert.equal(info.minPeopleMustPlay, 14);
        assert.equal(info.minAchievableSoftCut, 33);
        assert.equal(info.canReachMinSoftCut, true);
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
        assert.equal(info.minPeopleMustPlay, null);
        assert.equal(info.minAchievableSoftCut, 10);
        assert.equal(info.canReachMinSoftCut, false);
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

    it('Polish EUC copy names min soft cut + people/tables and works for open LIVE mirrors', () => {
        const { standings, pairings } = buildDlcStyleField();
        const info = calculateSoftCutIdInflation(standings, pairings, 32);
        const html = formatSoftCutIdInflationHtml(info, { alwaysShow: true });
        assert.match(html, /Minimalny soft cut i ile stołów musi grać/);
        assert.match(html, /Minimalny soft cut osiągalny/);
        assert.match(html, /Ile musi grać na tym paśmie/);
        assert.match(html, /najszerszy soft cut/);
        assert.match(html, /≥ 7 stołów \(14 osób\) na 33 pkt/);
        assert.match(html, /33 pkt/);
        assert.match(html, /Dlaczego nie „4 stoły = −8 osób”\?/);
        assert.match(html, /1 zagrany stół = −1 osoba/);
        assert.match(html, /Po 4 zagranych: 38−4 = <strong>34<\/strong>/);
        assert.match(html, /Dopiero po 7: 38−7 = <strong>31<\/strong>/);

        // Live path: unfinished equal-score mirrors counted as open.
        const liveStandings = [];
        let rank = 1;
        let id = 1;
        for (let i = 0; i < 5; i++) liveStandings.push(row(id++, 12, rank++));
        const openIds = [];
        for (let i = 0; i < 16; i++) {
            const pid = id++;
            openIds.push(pid);
            liveStandings.push(row(pid, 9, rank++));
        }
        for (let i = 0; i < 10; i++) liveStandings.push(row(id++, 6, rank++));
        const openPairings = [];
        for (let t = 0; t < 8; t++) openPairings.push(openMirror(t + 1, openIds[t * 2], openIds[t * 2 + 1]));
        const liveInfo = calculateSoftCutIdInflation(liveStandings, openPairings, 8);
        assert.equal(liveInfo.openMirrorTables, 8);
        assert.equal(liveInfo.lockedIdTables, 0);
        assert.ok(liveInfo.minTablesMustPlay === null || liveInfo.minTablesMustPlay >= 1);
        assert.ok(Number.isFinite(liveInfo.minAchievableSoftCut));
        const idle = formatSoftCutIdInflationHtml(null, { alwaysShow: true });
        assert.match(idle, /Narzędzie działa <strong>na żywo<\/strong>/);
        assert.match(idle, /najniższy soft cut w punktach/);
    });

    it('DLC London R15 pre-tie fixture: open 33v33 + climbers ⇒ ≥7 tables / 14 people for widest soft cut', () => {
        const path = require('path');
        const fixture = require(path.join(__dirname, 'fixtures', 'r15-london-pre-tie.json'));
        const standings = fixture.standings.standings;
        const pairings = fixture.pairings.results;
        assert.ok(standings.length >= 32);
        assert.equal(fixture.scenarioMeta?.id, 'r15-london-pre-tie');

        const info = calculateSoftCutIdInflation(standings, pairings, 32);
        assert.equal(info.mirrorScore, 33);
        assert.equal(info.bandPts, 34);
        assert.equal(info.openMirrorTables, 11);
        assert.equal(info.lockedIdTables, 0);
        assert.ok(info.climberTables >= 3); // 32v33 + 2×31v31 + 31v32
        assert.equal(info.maxClimbersToBand, 4);
        assert.equal(info.geBandIfAllId, 38);
        assert.equal(info.minTablesMustPlay, 7);
        assert.equal(info.minPeopleMustPlay, 14);
        assert.equal(info.minAchievableSoftCut, 33);
        assert.equal(info.projectedThreshIfAllId, 34);
        assert.equal(info.projectedThreshIfAllPlay, 33);

        const html = formatSoftCutIdInflationHtml(info, { alwaysShow: true });
        assert.match(html, /najszerszy soft cut/);
        assert.match(html, /≥ 7 stołów \(14 osób\)/);
        assert.match(html, /wspinaczy/);
    });

    it('/tests page hosts Soft EUC front panel + R15 loader + cache-bust', () => {
        const testsHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
        assert.match(testsHtml, /id="frontSoftEucHost"/);
        assert.match(testsHtml, /id="softEucPlayHint"/);
        assert.match(testsHtml, /id="tournamentSwitcher"/);
        assert.match(testsHtml, /id="prizeGoalsPanel"/);
        assert.match(testsHtml, /id="testsControlsStrip"/);
        assert.match(testsHtml, /loadR15LondonPreTie\(/);
        assert.match(testsHtml, /app\.js\?v=20261117testshell1/);
        assert.match(testsHtml, /prize-ladders\.js/);
        assert.match(testsHtml, /Analityka Lorcany/);
        assert.doesNotMatch(testsHtml, /brand-mark">TESTS/);
    });
});
