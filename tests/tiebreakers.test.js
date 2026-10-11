const { describe, it } = require('node:test');
const assert = require('node:assert');

// Logika obliczeniowa tiebreakerów Lorcany
function calculatePlayerMwp(points, roundsPlayed) {
    if (roundsPlayed <= 0) return 0.33333333;
    const raw = points / (roundsPlayed * 3);
    return Math.max(0.33333333, raw);
}

function calculatePlayerOmwp(opponentDataList) {
    if (!opponentDataList || opponentDataList.length === 0) return 0.33333333;
    const sum = opponentDataList.reduce((acc, opp) => {
        return acc + calculatePlayerMwp(opp.points, opp.roundsPlayed);
    }, 0);
    return sum / opponentDataList.length;
}

function sortStandingsByTiebreakers(players) {
    return [...players].sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.omwp !== a.omwp) return b.omwp - a.omwp;
        if (b.gwp !== a.gwp) return b.gwp - a.gwp;
        return (b.ogwp || 0) - (a.ogwp || 0);
    });
}

describe('Lorcana Tiebreaker Mechanics', () => {
    it('powinien stosować zasadę Floor 33.33% dla graczy z niską liczbą punktów', () => {
        // Gracz ma 0 punktów w 4 rundach (0-4) -> surowy MWP = 0.0, ale floor to 0.33333333
        const mwpZero = calculatePlayerMwp(0, 4);
        assert.ok(Math.abs(mwpZero - 0.33333333) < 0.0001, 'MWP dla 0 pkt powinno wynosić 33.33%');

        // Gracz z 1 punktem w 4 rundach (1/12 = 0.0833) -> floor 33.33%
        const mwpLow = calculatePlayerMwp(1, 4);
        assert.ok(Math.abs(mwpLow - 0.33333333) < 0.0001, 'MWP poniżej progu powinno być podniesione do 33.33%');

        // Gracz z 9 punktami w 4 rundach (9/12 = 0.75) -> powyżej progu, bez zmian
        const mwpNormal = calculatePlayerMwp(9, 4);
        assert.strictEqual(mwpNormal, 0.75, 'MWP powyżej 33.33% powinno być zachowane');
    });

    it('powinien poprawnie liczyć OMWP jako średnią MWP wszystkich przeciwników', () => {
        const opponents = [
            { points: 9, roundsPlayed: 4 }, // 0.75
            { points: 6, roundsPlayed: 4 }, // 0.50
            { points: 3, roundsPlayed: 4 }, // 0.25 -> floor 0.33333333
            { points: 12, roundsPlayed: 4 } // 1.00
        ];
        const omwp = calculatePlayerOmwp(opponents);
        const expected = (0.75 + 0.50 + 0.33333333 + 1.00) / 4;
        assert.ok(Math.abs(omwp - expected) < 0.0001, `OMWP (${omwp}) powinno być równe oczekiwanemu (${expected})`);
    });

    it('powinien sortować graczy zgodnie z 4-stopniową hierarchią (Punkty -> OMWP -> GWP -> OGWP)', () => {
        const players = [
            { name: 'Player A', points: 15, omwp: 0.55, gwp: 0.60, ogwp: 0.52 },
            { name: 'Player B', points: 18, omwp: 0.50, gwp: 0.50, ogwp: 0.50 }, // Więcej punktów -> 1. miejsce
            { name: 'Player C', points: 15, omwp: 0.58, gwp: 0.50, ogwp: 0.50 }, // Równe punkty z A, lepsze OMWP -> 2. miejsce
            { name: 'Player D', points: 15, omwp: 0.55, gwp: 0.65, ogwp: 0.50 }, // Równe pkt i OMWP z A, lepsze GWP -> 3. miejsce
            { name: 'Player E', points: 15, omwp: 0.55, gwp: 0.60, ogwp: 0.55 }  // Równe pkt, OMWP i GWP z A, lepsze OGWP -> przed A
        ];

        const sorted = sortStandingsByTiebreakers(players);
        assert.strictEqual(sorted[0].name, 'Player B', 'Najwięcej punktów (18 pkt)');
        assert.strictEqual(sorted[1].name, 'Player C', 'Najwyższe OMWP wśród 15 pkt (58%)');
        assert.strictEqual(sorted[2].name, 'Player D', 'Wyższe GWP wśród 15 pkt / 55% OMWP (65%)');
        assert.strictEqual(sorted[3].name, 'Player E', 'Wyższe OGWP wśród 15 pkt / 55% OMWP / 60% GWP (55%)');
        assert.strictEqual(sorted[4].name, 'Player A', 'Pozostały gracz z identycznymi parametrami');
    });
});
