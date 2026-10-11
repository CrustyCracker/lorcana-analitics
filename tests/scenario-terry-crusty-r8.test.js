const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Turniej 1007231 (Iconic Tour CCQ) - Symulacja Rundy 8: Terry vs Crusty', () => {
    const fixturePath = path.join(__dirname, 'fixtures/event_1007231_r8_data.json');
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

    const TERRY_ID = 10870;
    const CRUSTY_ID = 27669;
    const CUT_SIZE = 32;

    function computeOmwpForPlayer(playerId, pointsMap, opponentsMap, roundsPlayedMap) {
        const opps = opponentsMap[playerId] || [];
        if (opps.length === 0) return 0.33333333;
        let sum = 0;
        for (const oppId of opps) {
            const pts = pointsMap.get(oppId) || 0;
            const rPlayed = roundsPlayedMap[oppId] || 8;
            const raw = pts / (rPlayed * 3);
            sum += Math.max(0.33333333, raw);
        }
        return sum / opps.length;
    }

    function simulateTournamentStandings(overridePointsMap) {
        const pointsMap = new Map();
        fixture.standings.forEach(p => pointsMap.set(p.id, p.match_points));

        // Zastosowanie ewentualnych nadpisań punktów (np. zmiana wyniku meczu)
        if (overridePointsMap) {
            for (const [id, pts] of overridePointsMap.entries()) {
                pointsMap.set(id, pts);
            }
        }

        const simulatedPlayers = fixture.standings.map(p => {
            const omwp = computeOmwpForPlayer(p.id, pointsMap, fixture.opponentsMap, fixture.roundsPlayedMap);
            return {
                id: p.id,
                name: p.name,
                match_points: pointsMap.get(p.id),
                omwp: omwp,
                gwp: p.gwp || 0,
                ogwp: p.ogwp || 0
            };
        });

        // Oficjalne sortowanie Swiss (Punkty -> OMWP -> GWP -> OGWP)
        simulatedPlayers.sort((a, b) => {
            if (b.match_points !== a.match_points) return b.match_points - a.match_points;
            if (b.omwp !== a.omwp) return b.omwp - a.omwp;
            if (b.gwp !== a.gwp) return b.gwp - a.gwp;
            return b.ogwp - a.ogwp;
        });

        simulatedPlayers.forEach((p, idx) => {
            p.rank = idx + 1;
            p.inCut = p.rank <= CUT_SIZE;
        });

        return simulatedPlayers;
    }

    it('Rzeczywisty wynik turnieju: Terry wygrywa mecz R8 (Terry awansuje, Crusty odpada)', () => {
        const standings = simulateTournamentStandings();
        const terry = standings.find(p => p.id === TERRY_ID);
        const crusty = standings.find(p => p.id === CRUSTY_ID);

        assert.ok(terry, 'Terry powinien znajdować się w tabeli');
        assert.ok(crusty, 'Crusty powinien znajdować się w tabeli');

        assert.strictEqual(terry.match_points, 18, 'Terry zdobył 18 punktów (6-2-0)');
        assert.strictEqual(crusty.match_points, 15, 'Crusty zdobył 15 punktów (5-3-0)');

        assert.ok(terry.rank <= CUT_SIZE, `Terry (miejsce ${terry.rank}) awansował do Top ${CUT_SIZE}`);
        assert.ok(crusty.rank > CUT_SIZE, `Crusty (miejsce ${crusty.rank}) odpadł poza Top ${CUT_SIZE}`);
    });

    it('SCENARIUSZ TESTOWY: Czy jeśli Terry i Crusty wzięliby remis w 8 rundzie, to OBYDWOJE dostaliby się do Top 32?', () => {
        // Przed R8 obaj mieli bilans 5-2-0 (15 pkt).
        // Przy remisie w R8 obaj otrzymują po +1 pkt = 16 pkt (bilans 5-2-1).
        const drawScenarioOverrides = new Map();
        drawScenarioOverrides.set(TERRY_ID, 16);
        drawScenarioOverrides.set(CRUSTY_ID, 16);

        const newStandings = simulateTournamentStandings(drawScenarioOverrides);
        const terry = newStandings.find(p => p.id === TERRY_ID);
        const crusty = newStandings.find(p => p.id === CRUSTY_ID);

        // Wyświetlenie raportu z testu
        console.log('\n--- RAPORT TESTU: REMIS TERRY & CRUSTY W RUNDZIE 8 ---');
        console.log(`[GPL] Crusty: Miejsce #${crusty.rank} | ${crusty.match_points} pkt | OMWP: ${(crusty.omwp * 100).toFixed(2)}% | Top 32: ${crusty.inCut ? 'TAK ✅' : 'NIE ❌'}`);
        console.log(`Terry M:      Miejsce #${terry.rank} | ${terry.match_points} pkt | OMWP: ${(terry.omwp * 100).toFixed(2)}% | Top 32: ${terry.inCut ? 'TAK ✅' : 'NIE ❌'}`);

        const cutoffPlayer = newStandings[CUT_SIZE - 1]; // Miejsce 32
        const firstOutPlayer = newStandings[CUT_SIZE];   // Miejsce 33
        console.log(`Próg Cut (Miejsce #32): ${cutoffPlayer.name} (${cutoffPlayer.match_points} pkt, OMWP: ${(cutoffPlayer.omwp * 100).toFixed(2)}%)`);
        console.log(`Pierwszy pod kreską (#33): ${firstOutPlayer.name} (${firstOutPlayer.match_points} pkt, OMWP: ${(firstOutPlayer.omwp * 100).toFixed(2)}%)`);
        console.log('-------------------------------------------------------\n');

        // GŁÓWNA ASERCJA BIZNESOWA:
        assert.strictEqual(crusty.match_points, 16, 'Crusty po remisie ma 16 pkt');
        assert.strictEqual(terry.match_points, 16, 'Terry po remisie ma 16 pkt');

        assert.strictEqual(crusty.inCut, true, 'Crusty MUSI awansować do Top 32 przy remisie!');
        assert.strictEqual(terry.inCut, true, 'Terry MUSI awansować do Top 32 przy remisie!');

        assert.strictEqual(crusty.rank, 30, 'Crusty zajmuje 30. miejsce w tabeli');
        assert.strictEqual(terry.rank, 31, 'Terry zajmuje 31. miejsce w tabeli');

        // Upewniamy się, że obaj wyprzedzają próg cutu (miejsce 32)
        assert.ok(crusty.omwp > cutoffPlayer.omwp || crusty.rank <= CUT_SIZE);
        assert.ok(terry.omwp > cutoffPlayer.omwp || terry.rank <= CUT_SIZE);
    });
});
