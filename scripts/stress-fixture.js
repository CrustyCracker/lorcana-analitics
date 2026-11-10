/**
 * Generator syntetycznego pola Swiss (standings + pairings) bez PlayHub.
 * Użycie: require('./stress-fixture').createSyntheticField(4000, { completedRounds: 7 })
 */

'use strict';

function binomialBuckets(n, rounds) {
  // Przybliżony rozkład wyniku po `rounds` rundach (każdy mecz W/L, bez remisów).
  // count[k] ≈ graczy z k wygranymi.
  const counts = new Array(rounds + 1).fill(0);
  // Prosty „szczyt w środku” + lekkie spłaszczenie ogonów — wystarczy do stress.
  for (let wins = 0; wins <= rounds; wins++) {
    const x = wins / rounds;
    // dzwon wokół 0.5
    const w = Math.exp(-Math.pow((x - 0.5) * 3.2, 2));
    counts[wins] = w;
  }
  const sum = counts.reduce((a, b) => a + b, 0);
  let assigned = 0;
  const buckets = [];
  for (let wins = rounds; wins >= 0; wins--) {
    let c = Math.round((counts[wins] / sum) * n);
    buckets.push({ wins, losses: rounds - wins, count: c });
    assigned += c;
  }
  // Korekta do dokładnie n
  let diff = n - assigned;
  let i = 0;
  while (diff !== 0 && buckets.length) {
    const b = buckets[i % buckets.length];
    if (diff > 0) {
      b.count++;
      diff--;
    } else if (b.count > 0) {
      b.count--;
      diff++;
    }
    i++;
  }
  return buckets.filter(b => b.count > 0);
}

/**
 * @param {number} playerCount  np. 2000 / 4000
 * @param {{ completedRounds?: number, cutSize?: number, polishEvery?: number }} [opts]
 */
function createSyntheticField(playerCount, opts = {}) {
  const n = Math.max(2, playerCount | 0);
  const completedRounds = opts.completedRounds ?? 7;
  const polishEvery = opts.polishEvery ?? 40;
  const buckets = binomialBuckets(n, completedRounds);

  const standings = [];
  let idCounter = 100000;
  let rank = 1;

  for (const bucket of buckets) {
    const pts = bucket.wins * 3;
    for (let i = 0; i < bucket.count; i++) {
      const id = idCounter++;
      const frac = bucket.count > 1 ? (1 - i / (bucket.count - 1)) : 0.5;
      const omwp = Number((0.40 + frac * 0.28).toFixed(4));
      const gwp = Number((0.38 + frac * 0.30).toFixed(4));
      const ogwp = Number((0.40 + frac * 0.24).toFixed(4));
      const isPl = (rank % polishEvery) === 0;
      const tag = isPl ? ' 🇵🇱 [GPL]' : '';
      standings.push({
        rank: rank++,
        match_points: pts,
        record: `${bucket.wins}-${bucket.losses}-0`,
        opponent_match_win_percentage: omwp,
        game_win_percentage: gwp,
        opponent_game_win_percentage: ogwp,
        player: {
          id,
          best_identifier: `Stress_Player_${id}${tag}`
        },
        user_event_status: {
          best_identifier: `Stress_${id}`,
          matches_won: bucket.wins,
          matches_lost: bucket.losses,
          matches_drawn: 0
        }
      });
    }
  }

  // Aktywna runda = completedRounds + 1 — half finished
  const pairings = [];
  for (let i = 0; i < standings.length; i += 2) {
    const p1 = standings[i];
    const p2 = standings[i + 1];
    if (!p2) break;
    const table = (i / 2) + 1;
    const finished = table % 3 === 0;
    const draw = finished && table % 9 === 0;
    pairings.push({
      table_number: table,
      status: finished ? 'COMPLETE' : 'IN_PROGRESS',
      match_is_intentional_draw: draw,
      match_is_unintentional_draw: false,
      games_won_by_winner: finished && !draw ? 2 : null,
      games_won_by_loser: finished && !draw ? 0 : null,
      winning_player: finished && !draw ? { id: p1.player.id } : null,
      player_match_relationships: [
        { player: { id: p1.player.id, best_identifier: p1.player.best_identifier } },
        { player: { id: p2.player.id, best_identifier: p2.player.best_identifier } }
      ]
    });
  }

  const activeRound = completedRounds + 1;
  const totalRounds = Math.max(activeRound, getDefaultRoundsForN(n));

  return {
    eventId: 900000 + n,
    eventName: `Synthetic Stress ${n}`,
    playerCount: n,
    displayStatus: 'in_progress',
    isCompleted: false,
    standingsRound: completedRounds,
    activeRound,
    totalRounds,
    cutSize: opts.cutSize ?? (n >= 1000 ? 64 : 8),
    standings: { standings },
    pairings: { results: pairings, count: pairings.length },
    roundsMatches: {
      [completedRounds]: {
        round_number: completedRounds,
        round_id: 1,
        status: 'COMPLETE',
        matches: [] // historyczne mecze nie są wymagane do process/render/tie smoke
      }
    }
  };
}

function getDefaultRoundsForN(n) {
  if (n <= 8) return 3;
  if (n <= 16) return 4;
  if (n <= 32) return 5;
  if (n <= 64) return 6;
  if (n <= 128) return 7;
  if (n <= 226) return 8;
  return 9;
}

module.exports = {
  createSyntheticField,
  binomialBuckets,
  getDefaultRoundsForN
};
