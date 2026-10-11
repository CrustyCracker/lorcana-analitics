const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    escapeHtml,
    escapeJsAttr,
    buildStandingsMap,
    getMatchWhatIfKey,
    applyWhatIfToPairings,
    computeWhatIfEffectiveData,
    calculateCutLineBreakdown,
    getBracketSeedOrder,
    generateTopCutBracket,
    buildFullTopCutBracketTree,
    getPlayerBracketPath,
    analyzePlayerTopCutSeeding
} = require('../app.js');

const fixturePath = path.join(__dirname, 'fixtures', 'event_1007231_r8_data.json');
const tournament1007231 = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

describe('Nowe moduły: Drabinka Top Cut (Play/Draw), Tryb What-If oraz Cut Line Breakdown', () => {

    describe('1. Symulator Drabinki Top Cut i Przywileju Play/Draw', () => {
        it('generuje oficjalną kolejność parowań drzewka pucharowego dla Top 8 i Top 32', () => {
            const order8 = getBracketSeedOrder(8);
            // W oficjalnej drabince Top 8: Mecz 1 (#1 vs #8), Mecz 2 (#4 vs #5), Mecz 3 (#2 vs #7), Mecz 4 (#3 vs #6)
            assert.deepEqual(order8, [1, 8, 4, 5, 2, 7, 3, 6]);

            const order32 = getBracketSeedOrder(32);
            assert.equal(order32.length, 32);
            // Pierwszy mecz górnej połówki: #1 vs #32, drugi: #16 vs #17
            assert.equal(order32[0], 1);
            assert.equal(order32[1], 32);
            assert.equal(order32[2], 16);
            assert.equal(order32[3], 17);
            // Pierwszy mecz dolnej połówki: #2 vs #31
            assert.equal(order32[16], 2);
            assert.equal(order32[17], 31);
        });

        it('przypisuje przywilej PLAY wyższemu seedowi (#1..#16) i DRAW niższemu seedowi (#17..#32) w Top 32', () => {
            const standings = tournament1007231.standings;
            const bracket = generateTopCutBracket(standings, 32);

            assert.equal(bracket.bracketSize, 32);
            assert.equal(bracket.pairings.length, 16);

            for (const match of bracket.pairings) {
                assert.equal(match.highSeed + match.lowSeed, 33, 'Suma seedów w każdej parze R1 Top 32 musi wynosić 33');
                assert.ok(match.highSeed <= 16, 'Wyższy seed musi być w przedziale 1..16');
                assert.ok(match.lowSeed >= 17, 'Niższy seed musi być w przedziale 17..32');
                assert.equal(match.highSeedPlayer.hasPlayDraw, true, 'Wyższy seed musi mieć przywilej PLAY');
                assert.equal(match.lowSeedPlayer.hasPlayDraw, false, 'Niższy seed musi być na DRAW');
            }
        });

        it('wykrywa dylemat Play/Draw (Top Half Seeding): ID daje spadek na DRAW, a WIN daje awans na PLAY', () => {
            // Tworzymy sytuację przed ostatnią rundą dla Top 8 (miejsca #1-#4 mają PLAY, #5-#8 mają DRAW)
            const mockStandings = [
                { player: { id: 1, best_identifier: 'Seed1' }, match_points: 15, livePoints: 15, opponent_match_win_percentage: 0.70 },
                { player: { id: 2, best_identifier: 'Seed2' }, match_points: 15, livePoints: 15, opponent_match_win_percentage: 0.68 },
                { player: { id: 3, best_identifier: 'Seed3' }, match_points: 13, livePoints: 13, opponent_match_win_percentage: 0.65 },
                { player: { id: 4, best_identifier: 'Seed4' }, match_points: 13, livePoints: 13, opponent_match_win_percentage: 0.62 },
                { player: { id: 5, best_identifier: 'TargetBubblePlayDraw' }, match_points: 12, livePoints: 12, opponent_match_win_percentage: 0.66 },
                { player: { id: 6, best_identifier: 'OpponentBubble' }, match_points: 12, livePoints: 12, opponent_match_win_percentage: 0.64 },
                { player: { id: 7, best_identifier: 'Other7' }, match_points: 12, livePoints: 12, opponent_match_win_percentage: 0.55 },
                { player: { id: 8, best_identifier: 'Other8' }, match_points: 12, livePoints: 12, opponent_match_win_percentage: 0.52 },
                { player: { id: 9, best_identifier: 'Outside9' }, match_points: 9, livePoints: 9, opponent_match_win_percentage: 0.50 }
            ];

            const target = mockStandings[4]; // 12 pkt, miejsce #5
            const opp = { id: 6, name: 'OpponentBubble' };

            const seeding = analyzePlayerTopCutSeeding(target, opp, false, mockStandings, 8);

            // Po REMISIE (ID): obaj mają po 13 pkt, ale niższe OMWP/pozycję niż Seed1-2 (15 pkt),
            // a jeśli Seed3 i Seed4 mieli więcej pkt (np. 14), sprawdźmy konkretnie dla 14 pkt u Seed3 i Seed4:
            mockStandings[2].match_points = 14;
            mockStandings[2].livePoints = 14;
            mockStandings[3].match_points = 14;
            mockStandings[3].livePoints = 14;

            const seedingDilemma = analyzePlayerTopCutSeeding(target, opp, false, mockStandings, 8);

            // Po REMISIE (12 + 1 = 13 pkt): gracz jest na miejscu #5 (wchodzi do Top 8, ale w dolnej połówce #5-#8 -> DRAW!)
            assert.equal(seedingDilemma.scenarios.TIE.inCut, true);
            assert.equal(seedingDilemma.scenarios.TIE.seed, 5);
            assert.equal(seedingDilemma.scenarios.TIE.hasPlayDrawR1, false, 'Po ID gracz ląduje na #5 seedzie i traci przywilej PLAY');
            assert.equal(seedingDilemma.scenarios.TIE.roleR1, 'DRAW');

            // Po WYGRANEJ (12 + 3 = 15 pkt): gracz wskakuje na #3 seed (Top 4 -> ma przywilej PLAY w R1!)
            assert.equal(seedingDilemma.scenarios.WIN.inCut, true);
            assert.equal(seedingDilemma.scenarios.WIN.seed, 3);
            assert.equal(seedingDilemma.scenarios.WIN.hasPlayDrawR1, true, 'Po WIN gracz wskakuje na #3 seed i zyskuje przywilej PLAY');
            assert.equal(seedingDilemma.scenarios.WIN.roleR1, 'PLAY');
        });
    });

    describe('2. Tryb „What-If” (Ręczna zmiana wyników na stołach)', () => {
        it('pozwala w historycznym turnieju 1007231 przełączyć stół #16 (Terry vs Crusty) na ID (DRAW) i potwierdza awans obu do Top 32', () => {
            const rawStandings = tournament1007231.standings.map(p => ({
                rank: p.rank,
                player: { id: p.id, best_identifier: p.name },
                match_points: p.match_points,
                opponent_match_win_percentage: p.omwp,
                game_win_percentage: p.gwp,
                opponent_game_win_percentage: p.ogwp
            }));

            const terryId = 10870;
            const crustyId = 27669;

            // W rzeczywistości w R8 na stole #16 Terry M (10870) pokonał [GPL] Crusty (27669)
            const rawPairings = [
                {
                    id: 999016,
                    table_number: 16,
                    winning_player: terryId,
                    match_is_intentional_draw: false,
                    match_is_unintentional_draw: false,
                    games_won_by_winner: 2,
                    games_won_by_loser: 1,
                    player_match_relationships: [
                        { player: { id: terryId, best_identifier: 'Terry M' } },
                        { player: { id: crustyId, best_identifier: '[GPL] Crusty' } }
                    ]
                }
            ];

            const standingsMap = buildStandingsMap(rawStandings);
            const matchIdx = 0;
            const matchKey = getMatchWhatIfKey(rawPairings[matchIdx], matchIdx);
            const overrides = new Map([[matchKey, 'DRAW']]);

            // Turniej jest zakończony (isLiveRoundInProgress = false), więc computeWhatIfEffectiveData koryguje oficjalne punkty:
            // Terry: 18 -> 16 pkt (-2), Crusty: 15 -> 16 pkt (+1)
            const { effectiveStandings, effectivePairingsList } = computeWhatIfEffectiveData(
                rawStandings,
                rawPairings,
                overrides,
                standingsMap,
                false
            );

            assert.equal(effectivePairingsList[matchIdx]._isWhatIf, true);
            assert.equal(effectivePairingsList[matchIdx].match_is_intentional_draw, true);

            const breakdownAfterWhatIf = calculateCutLineBreakdown(effectiveStandings, 32, 'hard');
            const sortedAfter = [...effectiveStandings].sort((a, b) => {
                if (b.match_points !== a.match_points) return b.match_points - a.match_points;
                if (b.opponent_match_win_percentage !== a.opponent_match_win_percentage) {
                    return b.opponent_match_win_percentage - a.opponent_match_win_percentage;
                }
                return b.game_win_percentage - a.game_win_percentage;
            });

            const terryRank = sortedAfter.findIndex(p => p.player.id === terryId) + 1;
            const crustyRank = sortedAfter.findIndex(p => p.player.id === crustyId) + 1;

            assert.equal(sortedAfter[terryRank - 1].match_points, 16);
            assert.equal(sortedAfter[crustyRank - 1].match_points, 16);
            assert.ok(crustyRank <= 32, `Crusty po kliknięciu What-If ID powinien być w Top 32 (miejsce #${crustyRank})`);
            assert.ok(terryRank <= 32, `Terry po kliknięciu What-If ID powinien być w Top 32 (miejsce #${terryRank})`);
            assert.equal(breakdownAfterWhatIf.bubblePts, 16);
        });
    });

    describe('3. Kalkulator rozkładu koszyków punktowych (Cut Line Breakdown)', () => {
        it('poprawnie wylicza statystyki kreski, Gatekeepera (#32), Snipera (#33) i koszyki punktowe dla turnieju 1007231', () => {
            const standings = tournament1007231.standings;
            const bd = calculateCutLineBreakdown(standings, 32, 'hard');

            assert.ok(bd !== null);
            assert.equal(bd.cutSize, 32);
            assert.equal(bd.bubblePts, 16, 'Próg punktowy Top 32 w turnieju 1007231 wynosi 16 pkt');
            assert.ok(bd.lockedAboveCount > 0, 'Gracze z >=17 pkt mają czysty awans bez tiebreakerów');
            assert.equal(
                bd.lockedAboveCount + bd.spotsForBubbleBracket,
                32,
                'Suma graczy powyżej progu oraz miejsc dla koszyka Bubble musi równać się rozmiarowi Top Cut (32)'
            );
            assert.equal(bd.gatekeeper.rank, 32);
            assert.equal(bd.firstOut.rank, 33);
            assert.ok(bd.gatekeeper.omwp >= bd.firstOut.omwp || bd.gatekeeper.points > bd.firstOut.points);

            // Sprawdzamy, czy koszyk 16 pkt ma status 'split' lub 'safe'
            const bracket16 = bd.brackets.find(b => b.points === 16);
            assert.ok(bracket16, 'Koszyk 16 pkt musi znajdować się na liście koszyków');
            assert.equal(bracket16.inCutCount, bd.spotsForBubbleBracket);
        });
    });

    describe('4. Zabezpieczenia XSS (escapeHtml i escapeJsAttr)', () => {
        it('neutralizuje złośliwe payloady HTML oraz próby ucieczki z atrybutów onclick', () => {
            const maliciousNick = `<img src=x onerror="alert('XSS')"> & 'Jan'`;
            const safeHtml = escapeHtml(maliciousNick);
            assert.equal(
                safeHtml,
                `&lt;img src=x onerror=&quot;alert(&#39;XSS&#39;)&quot;&gt; &amp; &#39;Jan&#39;`
            );
            assert.ok(!safeHtml.includes('<img'), 'Tag HTML musi zostać zneutralizowany');

            const maliciousId = `123'); alert("XSS"); //`;
            const safeAttr = escapeJsAttr(maliciousId);
            assert.ok(!safeAttr.includes(`'`), 'Pojedynczy cudzysłów musi zostać zakodowany');
            assert.ok(!safeAttr.includes(`"`), 'Podwójny cudzysłów musi zostać zakodowany');
        });
    });

    describe('5. Pełne Drzewko Pucharowe (buildFullTopCutBracketTree) i Ścieżka Gracza (getPlayerBracketPath)', () => {
        it('buduje 5-rundowe drzewko Top 32 aż do Finału i rozpisuje dokładne matchupy oraz Play/Draw dla wybranego Seedu', () => {
            const standings = tournament1007231.standings.map(p => ({
                rank: p.rank,
                player: { id: p.id, best_identifier: p.name },
                match_points: p.match_points,
                opponent_match_win_percentage: p.omwp,
                game_win_percentage: p.gwp,
                opponent_game_win_percentage: p.ogwp
            }));

            const tree = buildFullTopCutBracketTree(standings, 32);
            assert.equal(tree.bracketSize, 32);
            assert.equal(tree.rounds.length, 5, 'Drabinka Top 32 musi mieć 5 rund (1/16, 1/8, Ćwierćfinał, Półfinał, Finał)');
            assert.equal(tree.rounds[0].matches.length, 16);
            assert.equal(tree.rounds[1].matches.length, 8);
            assert.equal(tree.rounds[2].matches.length, 4);
            assert.equal(tree.rounds[3].matches.length, 2);
            assert.equal(tree.rounds[4].matches.length, 1);

            // Sprawdzamy ścieżkę dla Seedu #16 (Jakub R, id: 15136)
            const seed16Player = standings[15];
            const path16 = getPlayerBracketPath(seed16Player.player.id, tree);
            assert.ok(path16 !== null);
            assert.equal(path16.player.seed, 16);
            assert.equal(path16.stages.length, 5);

            // Runda 1 Top 32 (1/16 Finału): Seed #16 gra na Seed #17 i ma przywilej PLAY!
            const stage1 = path16.stages[0];
            assert.equal(stage1.confirmedOpponent.seed, 17);
            assert.equal(stage1.confirmedOpponent.myRole, 'PLAY');

            // Runda 2 Top 32 (1/8 Finału): Seed #16 trafia na zwycięzcę pary #1 vs #32!
            // Przeciwko #1 ma DRAW, a przeciwko #32 ma PLAY!
            const stage2 = path16.stages[1];
            const oppSeedsStage2 = stage2.potentialOpponents.map(o => o.seed);
            assert.deepEqual(oppSeedsStage2, [1, 32]);
            const vsSeed1 = stage2.potentialOpponents.find(o => o.seed === 1);
            const vsSeed32 = stage2.potentialOpponents.find(o => o.seed === 32);
            assert.equal(vsSeed1.myRole, 'DRAW', 'Seed #16 przeciwko Seedowi #1 musi być na DRAW');
            assert.equal(vsSeed32.myRole, 'PLAY', 'Seed #16 przeciwko Seedowi #32 musi mieć przywilej PLAY');
        });
    });
});


