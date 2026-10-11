const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

function checkLiveRoundStatus(activeRound, standingsRound, isCompleted) {
    return Boolean(activeRound > (standingsRound || 0) && !isCompleted);
}

function computeLiveStandingsDeltas(pairingsList, standingsMap, isLiveRoundInProgress) {
    const liveScoreDeltas = new Map();
    if (!isLiveRoundInProgress || !pairingsList) return liveScoreDeltas;

    pairingsList.forEach(m => {
        const p1Id = m.players?.[0] || m.player_match_relationships?.[0]?.player?.id;
        const p2Id = m.players?.[1] || m.player_match_relationships?.[1]?.player?.id;
        const winnerId = m.winning_player;
        const isComplete = m.status === 'COMPLETE' || m.status === 'FINISHED' || winnerId != null;
        const isDraw = m.match_is_intentional_draw || m.match_is_unintentional_draw;

        if (isComplete) {
            if (isDraw) {
                if (p1Id) liveScoreDeltas.set(String(p1Id), 1);
                if (p2Id) liveScoreDeltas.set(String(p2Id), 1);
            } else if (winnerId === p1Id) {
                if (p1Id) liveScoreDeltas.set(String(p1Id), 3);
                if (p2Id) liveScoreDeltas.set(String(p2Id), 0);
            } else if (winnerId === p2Id) {
                if (p1Id) liveScoreDeltas.set(String(p1Id), 0);
                if (p2Id) liveScoreDeltas.set(String(p2Id), 3);
            }
        }
    });

    return liveScoreDeltas;
}

describe('Live Standings & Historical Tournament Round Detection', () => {
    it('powinien poprawnie wykrywać rundę na żywo vs turniej zakończony', () => {
        // Runda 3 w toku, tabela oficjalna z rundy 2 -> LIVE
        assert.strictEqual(checkLiveRoundStatus(3, 2, false), true);

        // Runda 1 w toku, brak tabeli oficjalnej (0) -> LIVE
        assert.strictEqual(checkLiveRoundStatus(1, 0, false), true);

        // Turniej historyczny: standingsRound = 3, activeRound = 3 -> NIE LIVE (standings już wygenerowane)
        assert.strictEqual(checkLiveRoundStatus(3, 3, false), false);

        // Turniej zakończony flagą isCompleted = true -> NIE LIVE
        assert.strictEqual(checkLiveRoundStatus(3, 2, true), false);
    });

    it('nie powinien dodawać delty punktowej dla turnieju historycznego (brak dublowania punktów)', () => {
        const dummyPairings = [
            {
                players: [101, 102],
                status: 'COMPLETE',
                winning_player: 101
            }
        ];

        // Gdy runda NIE jest w toku (np. turniej historyczny)
        const deltasHistorical = computeLiveStandingsDeltas(dummyPairings, null, false);
        assert.strictEqual(deltasHistorical.size, 0, 'Deltas powinny być puste');
        assert.strictEqual(deltasHistorical.get('101') || 0, 0, 'Delta gracza powinna wynosić 0');

        // Gdy runda JEST w toku (na żywo)
        const deltasLive = computeLiveStandingsDeltas(dummyPairings, null, true);
        assert.strictEqual(deltasLive.get('101'), 3, 'Zwycięzca w rundzie live powinien otrzymać +3');
        assert.strictEqual(deltasLive.get('102'), 0, 'Przegrany w rundzie live powinien otrzymać 0');
    });

    it('powinien poprawnie weryfikować realne dane turnieju 865248 z cache', () => {
        const cachePath = path.join(__dirname, '../cache_865248.json');
        if (!fs.existsSync(cachePath)) return;

        const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        const isLive = checkLiveRoundStatus(data.activeRound, data.standingsRound, data.isCompleted);
        
        assert.strictEqual(isLive, false, 'Turniej 865248 (R3/R3) nie powinien być traktowany jako live');

        const topPlayer = data.standings.standings[0];
        assert.strictEqual(topPlayer.match_points, 9, 'Top gracz Paul N ma 9 punktów w oficjalnej tabeli');
        
        const pairings = data.pairings?.results || [];
        const deltas = computeLiveStandingsDeltas(pairings, null, isLive);
        
        const livePoints = topPlayer.match_points + (deltas.get(String(topPlayer.player.id)) || 0);
        assert.strictEqual(livePoints, 9, 'Punkty w tabeli live nie mogą być zdublowane do 12');
    });
});
