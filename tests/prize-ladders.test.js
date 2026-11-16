const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    normalizeMode,
    getModeDefaults,
    getLadder,
    getFormatProfile,
    getFormatSwissRounds,
    resolveEventPhase,
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

    it('MAIN1 defaults soft Top32; MAIN2 hard Top8; swiss lengths encoded', () => {
        assert.deepEqual(getModeDefaults('MAIN1'), {
            mode: 'MAIN1', cutSize: 32, cutRule: 'soft', label: 'DLC MAIN1', swissRounds: 15
        });
        assert.equal(getModeDefaults('MAIN2').cutRule, 'hard');
        assert.equal(getModeDefaults('MAIN2').cutSize, 8);
        assert.equal(getModeDefaults('MAIN2').swissRounds, 11);
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

describe('DLC format profiles', () => {
    it('MAIN1 is 8+7=15 Swiss then hard Top8 SE; Day2=18', () => {
        const f = getFormatProfile('MAIN1');
        assert.equal(f.day1Rounds, 8);
        assert.equal(f.day2Rounds, 7);
        assert.equal(f.totalSwissRounds, 15);
        assert.equal(f.day2MinPoints, 18);
        assert.equal(f.hasTopCut, true);
        assert.equal(f.topCutSize, 8);
        assert.equal(getFormatSwissRounds('MAIN1'), 15);
    });

    it('MAIN2 is 8+3=11 Swiss with NO playoffs; Day2=18', () => {
        const f = getFormatProfile('MAIN2');
        assert.equal(f.day1Rounds, 8);
        assert.equal(f.day2Rounds, 3);
        assert.equal(f.totalSwissRounds, 11);
        assert.equal(f.day2MinPoints, 18);
        assert.equal(f.hasTopCut, false);
        assert.equal(getFormatSwissRounds('MAIN2'), 11);
        assert.equal(getTopCutBracketSize('MAIN2', 8), 0);
    });

    it('phase: Swiss mid-event vs topcut/complete', () => {
        const mid = resolveEventPhase('MAIN1', { activeRound: 12, totalRounds: 15 });
        assert.equal(mid.phase, 'swiss');
        assert.equal(mid.swissDone, false);
        assert.equal(mid.roundsLeft, 3);
        assert.equal(mid.day1Done, true);
        assert.equal(mid.roundsLeftDay1, 0);

        const cut = resolveEventPhase('MAIN1', { activeRound: 16, totalRounds: 15, topCutActive: true });
        assert.equal(cut.phase, 'topcut');
        assert.equal(cut.swissDone, true);
        assert.equal(cut.roundsLeft, 0);

        const me2done = resolveEventPhase('MAIN2', { activeRound: 11, totalRounds: 11, isCompleted: true });
        assert.equal(me2done.phase, 'complete');
        assert.equal(me2done.swissDone, true);
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
            cutSize: 8, cutRule: 'hard', activeRound: 10, totalRounds: 11
        });
        const inv = ev.rungs.find((r) => r.id === 'inv');
        assert.ok(inv.status === 'in_play' || inv.status === 'missed');
        assert.equal(ev.mode, 'MAIN2');
        assert.equal(ev.phase, 'swiss');
        assert.ok(ev.groups.in_play.length + ev.groups.locked.length + ev.groups.missed.length > 0);
    });

    it('after Swiss / in Top8: #9 with same pts as T8 is missed (not orange fighting)', () => {
        // Mirrors ME1: #7/#8/#9 all on 37 — only Top8 secured after Swiss.
        const standings = [];
        for (let i = 1; i <= 16; i++) {
            let pts = 40 - i;
            if (i >= 7 && i <= 9) pts = 37;
            standings.push(mkPlayer(i, pts, i, 12, 0.6 - i * 0.01));
        }
        const opts = {
            cutSize: 8, cutRule: 'hard',
            activeRound: 18, totalRounds: 15,
            totalSwissRounds: 15, topCutActive: true
        };
        const top8 = evaluatePlayerTableChips('MAIN1', standings, 8, opts);
        const t8ok = top8.chips.find((c) => c.id === 't8');
        assert.equal(t8ok.status, 'locked');

        const nine = evaluatePlayerTableChips('MAIN1', standings, 9, opts);
        const t8miss = nine.chips.find((c) => c.id === 't8');
        assert.equal(t8miss.status, 'missed');
        assert.equal(t8miss.className, 'prize-chip--missed');
        assert.equal(nine.phase, 'topcut');
    });

    it('MAIN2 after R11: hard T8/EUC locked or missed by TB, never mid-bracket fight', () => {
        const standings = [];
        for (let i = 1; i <= 16; i++) {
            standings.push(mkPlayer(i, 30 - i, i, 10));
        }
        const opts = {
            cutSize: 8, cutRule: 'hard',
            activeRound: 11, totalRounds: 11,
            isCompleted: true
        };
        const in8 = evaluatePlayerTableChips('MAIN2', standings, 3, opts);
        assert.equal(in8.chips.find((c) => c.id === 't8').status, 'locked');
        assert.equal(in8.chips.find((c) => c.id === 'inv').status, 'locked');

        const out = evaluatePlayerTableChips('MAIN2', standings, 12, opts);
        assert.equal(out.chips.find((c) => c.id === 't8').status, 'missed');
        assert.equal(out.chips.find((c) => c.id === 'inv').status, 'missed');
        assert.equal(out.phase, 'complete');
    });

    it('Day2 missed after Day1 even if Day2 Swiss rounds remain', () => {
        const standings = [mkPlayer(1, 15, 50, 5)];
        const ev = evaluatePlayerPrizes('MAIN1', standings, 1, {
            cutSize: 8, cutRule: 'hard', activeRound: 8, totalRounds: 15
        });
        assert.equal(ev.day1Done, true);
        assert.equal(ev.rungs.find((r) => r.id === 'd2').status, 'missed');
        assert.equal(ev.phase, 'swiss');
        assert.equal(ev.roundsLeft, 7);
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
    it('MAIN1 bracket size is hard Top 8; MAIN2 has no playoff bracket', () => {
        assert.equal(getTopCutBracketSize('MAIN1', 32), 8);
        assert.equal(getTopCutBracketSize('MAIN2', 8), 0);
        assert.equal(getTopCutBracketSize('CCQ', 8), 8);
        assert.equal(getTopCutBracketSize('custom', 16), 16);
    });

    it('MAIN1 table chips cover BePrep/DAY2/T64/T32/EUC/T16/T8', () => {
        const chips = getTableChipRungs('MAIN1').map((c) => c.chip);
        assert.deepEqual(chips, ['🦁', 'DAY2', 'T64', 'T32', 'EUC', 'T16', 'T8']);
    });

    it('MAIN2 chips include hard EUC + T8 (same Top8 threshold, no soft invite)', () => {
        const defs = getTableChipRungs('MAIN2');
        assert.deepEqual(defs.map((c) => c.chip), ['🦁', 'DAY2', 'T32', 'EUC', 'T8']);
        const inv = getLadder('MAIN2').rungs.find((r) => r.id === 'inv');
        assert.equal(inv.kind, 'hard_rank');
        assert.equal(inv.topN, 8);
        const t8 = getLadder('MAIN2').rungs.find((r) => r.id === 't8');
        assert.equal(t8.tableChip, true);
        assert.equal(t8.topN, 8);
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
