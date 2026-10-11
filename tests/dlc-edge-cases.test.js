const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    runLiveTieSimulation,
    derivePlayerStrategy,
    getCutStatusCategory,
    getCutStatusBadge,
    buildStandingsMap
} = require('../app.js');

/**
 * Generator realistycznego turnieju DLC (512 graczy, 9 rund Swiss, Top 64 Cut).
 * Wykorzystuje rozkład dwumianowy dla wyników po zadanej liczbie ukończonych rund.
 */
function createDlcFieldAfterRound(completedRounds) {
    const standings = [];
    let idCounter = 1000;

    // Dla R=6: koszyki punktowe od 6-0 (18 pkt) do 0-6 (0 pkt) dla 512 graczy
    // Dla R=7: koszyki punktowe od 7-0 (21 pkt) do 0-7 (0 pkt) dla 512 graczy
    const distributionR6 = [
        { wins: 6, losses: 0, count: 8 },
        { wins: 5, losses: 1, count: 48 },
        { wins: 4, losses: 2, count: 120 },
        { wins: 3, losses: 3, count: 160 },
        { wins: 2, losses: 4, count: 120 },
        { wins: 1, losses: 5, count: 48 },
        { wins: 0, losses: 6, count: 8 }
    ];

    const distributionR7 = [
        { wins: 7, losses: 0, count: 4 },
        { wins: 6, losses: 1, count: 28 },
        { wins: 5, losses: 2, count: 84 },
        { wins: 4, losses: 3, count: 140 },
        { wins: 3, losses: 4, count: 140 },
        { wins: 2, losses: 5, count: 84 },
        { wins: 1, losses: 6, count: 28 },
        { wins: 0, losses: 7, count: 4 }
    ];

    const dist = completedRounds === 7 ? distributionR7 : distributionR6;
    let rank = 1;

    for (const bucket of dist) {
        const pts = bucket.wins * 3;
        for (let i = 0; i < bucket.count; i++) {
            const id = idCounter++;
            // Rozkład OMWP wewnątrz koszyka od 0.64 (góra koszyka) do 0.42 (dół koszyka)
            const frac = bucket.count > 1 ? (1 - i / (bucket.count - 1)) : 0.5;
            const omwp = Number((0.42 + frac * 0.22).toFixed(4));
            const gwp = Number((0.40 + frac * 0.25).toFixed(4));
            const ogwp = Number((0.42 + frac * 0.20).toFixed(4));

            standings.push({
                rank: rank++,
                match_points: pts,
                record: `${bucket.wins}-${bucket.losses}-0`,
                opponent_match_win_percentage: omwp,
                game_win_percentage: gwp,
                opponent_game_win_percentage: ogwp,
                player: {
                    id,
                    best_identifier: `DLC_Player_${id}_${bucket.wins}_${bucket.losses}`
                },
                user_event_status: {
                    best_identifier: `DLC_Player_${id}`,
                    matches_won: bucket.wins,
                    matches_lost: bucket.losses,
                    matches_drawn: 0
                }
            });
        }
    }

    // Parowania trwającej rundy (activeRound = completedRounds + 1)
    const pairings = [];
    for (let i = 0; i < standings.length; i += 2) {
        const p1 = standings[i];
        const p2 = standings[i + 1];
        pairings.push({
            table_number: (i / 2) + 1,
            status: 'IN_PROGRESS',
            match_is_intentional_draw: false,
            match_is_unintentional_draw: false,
            games_won_by_winner: null,
            games_won_by_loser: null,
            winning_player: null,
            player_match_relationships: [
                { player: { id: p1.player.id, best_identifier: p1.player.best_identifier } },
                { player: { id: p2.player.id, best_identifier: p2.player.best_identifier } }
            ]
        });
    }

    return { standings, pairings };
}

describe('Skrajne przypadki i strategia wielorundowa (2-3 rundy do końca na dużym DLC 512 graczy)', () => {
    const DLC_CUT_SIZE = 32; // Przy 512 graczach i 9 rundach Swiss ok. 46 graczy osiąga >=21 pkt (7-2), więc próg Top 32 tnie dokładnie koszyk 21 pkt

    it('Runda 7 z 9 (3 mecze do końca): niepokonany lider 6-0 (18 pkt) ma 100% awansu przy scenariuszu 1x WIN + 2x TIE (23 pkt)', () => {
        const { standings, pairings } = createDlcFieldAfterRound(6);
        const standingsMap = buildStandingsMap(standings);

        // Pierwsza para na Stole #1: dwaj gracze 6-0 (18 pkt)
        const leader = standings[0];
        const opponent = standings[1];

        const sim = runLiveTieSimulation(
            leader,
            { id: opponent.player.id, name: opponent.player.best_identifier },
            standings,
            pairings,
            standingsMap,
            DLC_CUT_SIZE,
            'hard',
            7,      // Runda 7
            9,      // 9 rund Swiss
            21,     // Próg ok. 21 pkt
            true
        );

        assert.equal(sim.matchesLeft, 3, 'W 7. rundzie z 9 (mecz w toku) powinny pozostać dokładnie 3 mecze');
        assert.equal(sim.ptsWinDoubleTie, 23, '18 pkt + 1x WIN (3) + 2x TIE (2) musi dawać 23 pkt');
        assert.equal(sim.ptsTripleTie, 21, '18 pkt + 3x TIE (3) musi dawać 21 pkt');
        assert.ok(sim.chanceWinDoubleTie >= 95, `1x W + 2x ID (23 pkt) musi dawać pewny awans (>=95%), otrzymano: ${sim.chanceWinDoubleTie}%`);

        const strat = derivePlayerStrategy(sim, true);
        assert.equal(strat.rowClass, 'safe');
        assert.ok(
            strat.ptsNeededText === '3x TIE (+3)' || strat.ptsNeededText === '1x W + 2x T (+5)',
            `Strategia lidera 6-0 powinna wskazywać 3x TIE lub 1x W + 2x T, otrzymano: ${strat.ptsNeededText}`
        );
    });

    it('Runda 7 z 9 (3 mecze do końca): "Early Leader" (5-1, OMWP 72%) vs "Submarine" (5-1, OMWP 35%) dostają różne strategie', () => {
        const { standings, pairings } = createDlcFieldAfterRound(6);

        // Gracze 5-1 (15 pkt) znajdują się na indeksach 8..55
        const earlyLeader = standings[8];  // Góra koszyka 5-1
        const earlyLeaderOpp = standings[9];
        earlyLeader.opponent_match_win_percentage = 0.72;
        earlyLeader.game_win_percentage = 0.75;
        earlyLeader.opponent_game_win_percentage = 0.68;

        const submarine = standings[54];   // Dół koszyka 5-1 ("Submarine" po łatwych rywalach z dołu tabeli)
        const submarineOpp = standings[55];
        submarine.opponent_match_win_percentage = 0.35;
        submarine.game_win_percentage = 0.48;
        submarine.opponent_game_win_percentage = 0.36;

        const standingsMap = buildStandingsMap(standings);

        const simEarlyLeader = runLiveTieSimulation(
            earlyLeader,
            { id: earlyLeaderOpp.player.id, name: earlyLeaderOpp.player.best_identifier },
            standings,
            pairings,
            standingsMap,
            DLC_CUT_SIZE,
            'hard',
            7,
            9,
            21,
            true
        );

        const simSubmarine = runLiveTieSimulation(
            submarine,
            { id: submarineOpp.player.id, name: submarineOpp.player.best_identifier },
            standings,
            pairings,
            standingsMap,
            DLC_CUT_SIZE,
            'hard',
            7,
            9,
            21,
            true
        );

        // Obaj przy bilansie 2-1 (2x WIN + 1x LOSS) kończą z 21 pkt (dokładnie na progu Bubble)
        assert.equal(simEarlyLeader.ptsTwoWinLoss, 21);
        assert.equal(simSubmarine.ptsTwoWinLoss, 21);

        // Early Leader z OMWP 72% wygrywa walkę na tiebreakery przy 21 pkt:
        assert.ok(
            simEarlyLeader.chanceTwoWinLoss >= 80,
            `Early Leader (OMWP 72%) przy 2x W + 1x L (21 pkt) powinien wchodzić do Cutu (>=80%), otrzymano: ${simEarlyLeader.chanceTwoWinLoss}%`
        );

        // Submarine z OMWP 35% przegrywa tiebreakery przy 21 pkt, ale wchodzi czysto przy 2x W + 1x T (22 pkt):
        assert.ok(
            simSubmarine.chanceTwoWinLoss <= 35,
            `Submarine (OMWP 35%) przy 2x W + 1x L (21 pkt) powinien mieć niskie szanse (<=35%), otrzymano: ${simSubmarine.chanceTwoWinLoss}%`
        );
        assert.ok(
            simSubmarine.chanceTwoWinTie >= 90,
            `Submarine przy 2x W + 1x T (22 pkt) omija tiebreakery i wchodzi na >=90%, otrzymano: ${simSubmarine.chanceTwoWinTie}%`
        );

        const stratLeader = derivePlayerStrategy(simEarlyLeader, true);
        const stratSubmarine = derivePlayerStrategy(simSubmarine, false);

        assert.equal(stratLeader.ptsNeededText, '2x W + 1x L (+6)', 'Early Leader potrzebuje tylko 2 zwycięstw (2x W + 1x L)');
        assert.equal(stratSubmarine.ptsNeededText, '2x W + 1x T (+7)', 'Submarine musi dorzucić remis ponad 2 wygrane (2x W + 1x T), aby nie odpaść na OMWP');
    });

    it('Runda 7 z 9 (3 mecze do końca): gracz 4-2 (12 pkt) otrzymuje strategię "Musi wygrać 3x" (MUST WIN OUT), a gracz 3-3 (9 pkt) jest ELIMINATED', () => {
        const { standings, pairings } = createDlcFieldAfterRound(6);

        // Gracz 4-2 (12 pkt) z wysokim OMWP (0.72) na indeksie 56
        const bubbleChaser = standings[56];
        const bubbleChaserOpp = standings[57];
        bubbleChaser.opponent_match_win_percentage = 0.72;

        // Gracz 3-3 (9 pkt) na indeksie 180
        const eliminatedPlayer = standings[180];
        const eliminatedOpp = standings[181];

        const standingsMap = buildStandingsMap(standings);

        const simChaser = runLiveTieSimulation(
            bubbleChaser,
            { id: bubbleChaserOpp.player.id, name: bubbleChaserOpp.player.best_identifier },
            standings,
            pairings,
            standingsMap,
            DLC_CUT_SIZE,
            'hard',
            7,
            9,
            21,
            true
        );

        const simEliminated = runLiveTieSimulation(
            eliminatedPlayer,
            { id: eliminatedOpp.player.id, name: eliminatedOpp.player.best_identifier },
            standings,
            pairings,
            standingsMap,
            DLC_CUT_SIZE,
            'hard',
            7,
            9,
            21,
            true
        );

        // Dla gracza 4-2 (12 pkt): 2x W + 1x T daje tylko 19 pkt (0% szans), ale 3x WIN daje 21 pkt (>=55% szans dzięki OMWP 72%)
        assert.equal(simChaser.ptsTwoWinTie, 19);
        assert.equal(simChaser.ptsTripleWin, 21);
        assert.equal(simChaser.chanceTwoWinTie, 0);
        assert.ok(simChaser.chanceTripleWin >= 55, `Gracz 4-2 z wysokim OMWP przy 3x WIN (21 pkt) powinien mieć >=55% szans, otrzymano: ${simChaser.chanceTripleWin}%`);

        const stratChaser = derivePlayerStrategy(simChaser, false);
        assert.equal(stratChaser.ptsNeededText, '3x WIN (+9)');
        assert.ok(stratChaser.strategyText.includes('Musi wygrać 3x'));

        const badgeChaser = getCutStatusBadge(bubbleChaser, simChaser, false, DLC_CUT_SIZE, simChaser.matchesLeft);
        assert.ok(badgeChaser.includes('MUST WIN OUT'), `Oczekiwano odznaki MUST WIN OUT, otrzymano: ${badgeChaser}`);

        // Dla gracza 3-3 (9 pkt): nawet 3x WIN daje 18 pkt (0% szans na Cut)
        assert.equal(simEliminated.ptsTripleWin, 18);
        assert.equal(simEliminated.chanceTripleWin, 0);

        const stratEliminated = derivePlayerStrategy(simEliminated, false);
        assert.equal(stratEliminated.rowClass, 'dead');
        assert.equal(stratEliminated.strategyText, 'Minimalne szanse');
        assert.equal(getCutStatusCategory(eliminatedPlayer, simEliminated, DLC_CUT_SIZE), 'dead');
    });

    it('Runda 8 z 9 (2 mecze do końca): obopólny 2x ID na szczycie (21 pkt) vs asymetria stołu (pair-down 19 pkt vs 18 pkt)', () => {
        const { standings, pairings } = createDlcFieldAfterRound(7);

        // 1. Stół #1: dwaj gracze 7-0 (21 pkt)
        const top1 = standings[0];
        const top2 = standings[1];

        // 2. Stół z asymetrią (pair-down): Gracz A ma 19 pkt (6-0-1) i OMWP 72%, a jego rywal Gracz B ma 18 pkt (6-1) i niskie OMWP 40%
        const asymPlayerA = standings[10];
        const asymPlayerB = standings[11];
        asymPlayerA.match_points = 19;
        asymPlayerA.opponent_match_win_percentage = 0.72;
        asymPlayerB.match_points = 18;
        asymPlayerB.opponent_match_win_percentage = 0.40;

        const standingsMap = buildStandingsMap(standings);

        // Symulacja dla stołu #1 (21 pkt vs 21 pkt)
        const simTop = runLiveTieSimulation(
            top1,
            { id: top2.player.id, name: top2.player.best_identifier },
            standings,
            pairings,
            standingsMap,
            DLC_CUT_SIZE,
            'hard',
            8,
            9,
            21,
            true
        );

        assert.equal(simTop.matchesLeft, 2);
        assert.equal(simTop.chanceDoubleTie, 100, 'Gracz 7-0 (21 pkt) po 2x ID (23 pkt) ma 100% Cut');
        assert.equal(simTop.oppChanceDoubleTie, 100, 'Rywal 7-0 (21 pkt) po 2x ID (23 pkt) również ma 100% Cut');

        // Symulacja dla stołu asymetrycznego (19 pkt OMWP 72% vs 18 pkt OMWP 40%)
        const simAsymA = runLiveTieSimulation(
            asymPlayerA,
            { id: asymPlayerB.player.id, name: asymPlayerB.player.best_identifier },
            standings,
            pairings,
            standingsMap,
            DLC_CUT_SIZE,
            'hard',
            8,
            9,
            21,
            true
        );

        assert.equal(simAsymA.ptsDoubleTie, 21, 'Gracz A (19 pkt) po 2x ID kończy z 21 pkt');
        assert.ok(simAsymA.chanceDoubleTie >= 80, `Gracz A (19 pkt, 72% OMWP) po 2x ID powinien mieć >=80% szans, otrzymano: ${simAsymA.chanceDoubleTie}%`);
        assert.equal(simAsymA.oppChanceDoubleTie, 0, 'Rywal B (18 pkt) po 2x ID kończy z 20 pkt i ma 0% szans na Cut (odrzuci propozycję 2x ID!)');
    });

    it('Edge Case: gracz ukończył już swój mecz w trwającej rundzie (isCurrentMatchFinished = true w R6 z 9) – brak duplikacji rund', () => {
        const { standings, pairings } = createDlcFieldAfterRound(5);
        standings[0].match_points = 15; // 5-0 po 5 rundach
        standings[1].match_points = 15;
        // Ustawiamy wygraną 2-0 na Stole #1 w trwającej Rundzie 6 z 9
        pairings[0].status = 'COMPLETE';
        pairings[0].games_won_by_winner = 2;
        pairings[0].games_won_by_loser = 0;
        pairings[0].winning_player = standings[0].player.id;

        const standingsMap = buildStandingsMap(standings);
        const winner = standings[0]; // W oficjalnych standings po R5 ma 15 pkt, właśnie wygrał R6 (+3 = 18 pkt live)
        const loser = standings[1];

        const simWinner = runLiveTieSimulation(
            winner,
            { id: loser.player.id, name: loser.player.best_identifier },
            standings,
            pairings,
            standingsMap,
            DLC_CUT_SIZE,
            'hard',
            6, // Trwa Runda 6
            9, // 9 rund łącznie
            21,
            true
        );

        assert.equal(simWinner.isCurrentMatchFinished, true, 'Mecz gracza w R6 powinien zostać wykryty jako zakończony');
        assert.equal(simWinner.matchesLeft, 3, 'Po zakończeniu meczu w R6 z 9 graczowi pozostają dokładnie 3 przyszłe rundy (R7, R8, R9)');
        assert.equal(simWinner.ptsTripleTie, 15 + 3 + 3, 'Punkty bazowe (15 + 3 z R6 = 18) + 3x TIE (3) = 21 pkt');
        assert.equal(simWinner.ptsTripleWin, 15 + 3 + 9, 'Punkty bazowe (15 + 3 z R6 = 18) + 3x WIN (9) = 27 pkt');
    });

    it('Edge Case: Hard Cut vs Soft Cut na progu punktowym z minimalnym OMWP (Floor 33.33%) oraz status LOCKED przy 0 pkt w ostatniej rundzie', () => {
        const { standings, pairings } = createDlcFieldAfterRound(7);
        const standingsMap = buildStandingsMap(standings);

        // 1. Gracz 8-0 (24 pkt) w ostatniej 9. rundzie – ma pewny awans nawet przy porażce (0 pkt potrzebnych)
        const lockedLeader = standings[0];
        lockedLeader.match_points = 24;
        const lockedOpp = standings[1];
        lockedOpp.match_points = 24;

        const simLocked = runLiveTieSimulation(
            lockedLeader,
            { id: lockedOpp.player.id, name: lockedOpp.player.best_identifier },
            standings,
            pairings,
            standingsMap,
            DLC_CUT_SIZE,
            'hard',
            9,
            9,
            21,
            true
        );

        assert.equal(simLocked.matchesLeft, 1);
        assert.equal(simLocked.chanceLoss, 100, 'Gracz z 24 pkt w R9 wchodzi do Top Cut nawet przy porażce (100%)');
        const stratLocked = derivePlayerStrategy(simLocked, true);
        assert.equal(stratLocked.ptsNeededText, '0 pkt (LOCKED)');
        assert.ok(getCutStatusBadge(lockedLeader, simLocked, true, DLC_CUT_SIZE, 1).includes('LOCKED'));

        // 2. Porównanie Hard Cut vs Soft Cut dla gracza z OMWP równym dolnej granicy Floor (33.33%)
        // Tworzymy kontrolowaną tabelę 8 graczy (Top 4 Cut) w ostatniej rundzie, gdzie wszyscy mają po 12 pkt po remisie
        const miniStandings = Array.from({ length: 8 }, (_, idx) => ({
            rank: idx + 1,
            match_points: 11,
            record: '3-0-2',
            opponent_match_win_percentage: idx === 7 ? 0.3333 : 0.65,
            game_win_percentage: idx === 7 ? 0.3333 : 0.65,
            opponent_game_win_percentage: idx === 7 ? 0.3333 : 0.65,
            player: { id: 900 + idx, best_identifier: `Mini_${idx}` }
        }));
        const miniPairings = [];
        for (let i = 0; i < 8; i += 2) {
            miniPairings.push({
                table_number: (i / 2) + 1,
                status: 'COMPLETE',
                match_is_intentional_draw: true,
                player_match_relationships: [
                    { player: { id: 900 + i, best_identifier: `Mini_${i}` } },
                    { player: { id: 900 + i + 1, best_identifier: `Mini_${i + 1}` } }
                ]
            });
        }
        // Ostatni stół (Mini_6 vs Mini_7) jeszcze trwa
        miniPairings[3].status = 'IN_PROGRESS';
        miniPairings[3].match_is_intentional_draw = false;

        const miniMap = buildStandingsMap(miniStandings);
        const floorPlayer = miniStandings[7]; // OMWP 33.33%
        const floorOpp = miniStandings[6];

        const simHard = runLiveTieSimulation(
            floorPlayer,
            { id: floorOpp.player.id, name: floorOpp.player.best_identifier },
            miniStandings,
            miniPairings,
            miniMap,
            4,
            'hard',
            5,
            5,
            12,
            true
        );

        const simSoft = runLiveTieSimulation(
            floorPlayer,
            { id: floorOpp.player.id, name: floorOpp.player.best_identifier },
            miniStandings,
            miniPairings,
            miniMap,
            4,
            'soft',
            5,
            5,
            12,
            true
        );

        assert.equal(simHard.chanceTie, 0, 'W trybie Hard Cut gracz na progu z Floor OMWP (33.33%) zajmuje 8. miejsce i odpada (0%)');
        assert.equal(simSoft.chanceTie, 100, 'W trybie Soft Cut (wszyscy z punktami >= progu 4. miejsca) ten sam gracz wchodzi do Cutu (100%)');
    });
});
