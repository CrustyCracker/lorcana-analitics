const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeMode,
    getModeDefaults,
    getLadder,
    evaluatePlayerPrizes,
    evaluatePlayerTableChips,
    getTableChipRungs,
    getTopCutBracketSize,
    softThresholdPoints
} = require('../prize-ladders.js');

function mkPlayer(id, pts, rank, wins = 0, omwp = 0.5) {
    return {
        id,
        player: { id, best_identifier: `P${id}` },
        rank,
        match_points: pts,
        livePoints: pts,
        record: `${wins}-0-0`,
        user_event_status: { matches_won: wins, best_identifier: `P${id}` },
        opponent_match_win_percentage: omwp,
        game_win_percentage: 0.5,
        opponent_game_win_percentage: 0.5
    };
}

describe('prize ladder modes', () => {
    it('normalizes MAIN1/MAIN2/CCQ aliases', () => {
        assert.equal(normalizeMode('ME1'), 'MAIN1');
        assert.equal(normalizeMode('DLC_MAIN2'), 'MAIN2');
        assert.equal(normalizeMode('Infinity'), 'CCQ');
        assert.equal(normalizeMode('custom'), 'custom');
    });

    it('MAIN1 defaults soft Top32; MAIN2 hard Top8', () => {
        assert.deepEqual(getModeDefaults('MAIN1'), {
            mode: 'MAIN1', cutSize: 32, cutRule: 'soft', label: 'DLC MAIN1'
        });
        assert.equal(getModeDefaults('MAIN2').cutRule, 'hard');
        assert.equal(getModeDefaults('MAIN2').cutSize, 8);
        assert.equal(getModeDefaults('CCQ').cutSize, 8);
    });

    it('MAIN1 ladder has soft invite + hard physical prizes', () => {
        const ladder = getLadder('MAIN1');
        const invite = ladder.rungs.find((r) => r.id === 'inv');
        const promo32 = ladder.rungs.find((r) => r.id === 't32promo');
        assert.equal(invite.kind, 'soft_invite');
        assert.equal(invite.topN, 32);
        assert.equal(promo32.kind, 'hard_rank');
        assert.match(invite.detail, /Top 32/);
    });

    it('MAIN2 invite is hard Top8 only', () => {
        const ladder = getLadder('MAIN2');
        const invite = ladder.rungs.find((r) => r.id === 'inv');
        assert.equal(invite.kind, 'hard_rank');
        assert.equal(invite.topN, 8);
        assert.match(invite.detail, /Top 8/);
    });
});

describe('evaluatePlayerPrizes', () => {
    it('soft invite locks when points >= soft thresh (MAIN1)', () => {
        const standings = [];
        for (let i = 1; i <= 40; i++) {
            // Top 32 at 34 pts, then 33/32 below
            const pts = i <= 32 ? 34 : (i === 33 ? 33 : 30);
            standings.push(mkPlayer(i, pts, i, 10));
        }
        assert.equal(softThresholdPoints(standings, 32), 34);

        const locked = evaluatePlayerPrizes('MAIN1', standings, 10, {
            cutSize: 32, cutRule: 'soft', activeRound: 15, totalRounds: 15
        });
        const inv = locked.rungs.find((r) => r.id === 'inv');
        assert.equal(inv.status, 'locked');

        const missed = evaluatePlayerPrizes('MAIN1', standings, 40, {
            cutSize: 32, cutRule: 'soft', activeRound: 15, totalRounds: 15
        });
        const invMiss = missed.rungs.find((r) => r.id === 'inv');
        assert.equal(invMiss.status, 'missed');
    });

    it('MAIN2 hard invite in play for #9 with rounds left', () => {
        const standings = [];
        for (let i = 1; i <= 16; i++) {
            standings.push(mkPlayer(i, 24 - Math.floor((i - 1) / 2), i, 7));
        }
        const ev = evaluatePlayerPrizes('MAIN2', standings, 9, {
            cutSize: 8, cutRule: 'hard', activeRound: 10, totalRounds: 12
        });
        const inv = ev.rungs.find((r) => r.id === 'inv');
        assert.ok(inv.status === 'in_play' || inv.status === 'missed');
        assert.equal(ev.mode, 'MAIN2');
        assert.ok(ev.groups.in_play.length + ev.groups.locked.length + ev.groups.missed.length > 0);
    });

    it('participation always locked; wins gate promo', () => {
        const standings = [mkPlayer(1, 6, 1, 2)];
        const ev = evaluatePlayerPrizes('MAIN1', standings, 1, {
            cutSize: 32, cutRule: 'soft', activeRound: 4, totalRounds: 15
        });
        assert.equal(ev.rungs.find((r) => r.id === 'part').status, 'locked');
        assert.equal(ev.rungs.find((r) => r.id === 'w3').status, 'in_play');
    });

    it('empty player returns guidance', () => {
        const ev = evaluatePlayerPrizes('CCQ', [], null, {});
        assert.ok(ev.emptyReason);
        assert.equal(ev.rungs.length, 0);
    });
});

describe('table chips + hard Top8 bracket', () => {
    it('MAIN1/MAIN2 bracket size is hard Top 8 even if soft cut is 32', () => {
        assert.equal(getTopCutBracketSize('MAIN1', 32), 8);
        assert.equal(getTopCutBracketSize('MAIN2', 8), 8);
        assert.equal(getTopCutBracketSize('CCQ', 8), 8);
        assert.equal(getTopCutBracketSize('custom', 16), 16);
    });

    it('MAIN1 table chips cover BePrep/DAY2/T64/T32/EUC/T16/T8', () => {
        const chips = getTableChipRungs('MAIN1').map((c) => c.chip);
        assert.deepEqual(chips, ['🦁', 'DAY2', 'T64', 'T32', 'EUC', 'T16', 'T8']);
    });

    it('MAIN2 chips have hard EUC and no soft Top32 invite chip spam', () => {
        const defs = getTableChipRungs('MAIN2');
        assert.deepEqual(defs.map((c) => c.chip), ['🦁', 'DAY2', 'T32', 'EUC']);
        const inv = getLadder('MAIN2').rungs.find((r) => r.id === 'inv');
        assert.equal(inv.kind, 'hard_rank');
        assert.equal(inv.topN, 8);
    });

    it('evaluatePlayerTableChips colors locked/play/missed', () => {
        const standings = [];
        for (let i = 1; i <= 40; i++) {
            const pts = i <= 32 ? 34 : 24;
            standings.push(mkPlayer(i, pts, i, i <= 5 ? 11 : 3));
        }
        const pack = evaluatePlayerTableChips('MAIN1', standings, 1, {
            cutSize: 32, cutRule: 'soft', activeRound: 15, totalRounds: 15
        });
        const byId = Object.fromEntries(pack.chips.map((c) => [c.id, c]));
        assert.equal(byId.w3.status, 'locked');
        assert.equal(byId.w3.className, 'prize-chip--locked');
        assert.equal(byId.inv.status, 'locked');
        assert.equal(byId.t8.status, 'locked');

        const low = evaluatePlayerTableChips('MAIN1', standings, 40, {
            cutSize: 32, cutRule: 'soft', activeRound: 15, totalRounds: 15
        });
        const lowInv = low.chips.find((c) => c.id === 'inv');
        assert.equal(lowInv.status, 'missed');
        assert.equal(lowInv.className, 'prize-chip--missed');
    });
});
