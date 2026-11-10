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
 * @param {{ completedRounds?: number, totalRounds?: number, cutSize?: number, polishEvery?: number, eventName?: string, pairingsMode?: 'just_started'|'mid_round' }} [opts]
 * pairingsMode:
 *   - 'just_started' — wszystkie mecze aktywnej rundy IN_PROGRESS (świeżo wystawione)
 *   - 'mid_round' — część stołów już COMPLETE (domyślne dla stress)
 */
function createSyntheticField(playerCount, opts = {}) {
  const n = Math.max(2, playerCount | 0);
  const completedRounds = opts.completedRounds ?? 7;
  const polishEvery = opts.polishEvery ?? 40;
  const pairingsMode = opts.pairingsMode === 'just_started' ? 'just_started' : 'mid_round';
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

  const activeRound = completedRounds + 1;
  const totalRounds = Math.max(
    activeRound,
    opts.totalRounds != null ? (opts.totalRounds | 0) : getDefaultRoundsForN(n)
  );
  const cutSize = opts.cutSize ?? (n >= 1000 ? 64 : 8);

  // Pełna lista meczów aktywnej rundy — każdy gracz w dokładnie jednym stole (jak prawdziwy Swiss live).
  const pairings = buildFullRoundPairings(standings, {
    roundNumber: activeRound,
    pairingsMode
  });

  // Minimalna struktura rund (historyczne mecze puste — TIE używa standings + live pairings).
  const roundsMatches = {};
  for (let r = 1; r <= completedRounds; r++) {
    roundsMatches[r] = {
      round_number: r,
      round_id: r,
      status: 'COMPLETE',
      matches: []
    };
  }
  // Osobna kopia listy — LIVE / Can I Tie czytają data.pairings; rundy też muszą mieć pełny R_active.
  roundsMatches[activeRound] = {
    round_number: activeRound,
    round_id: activeRound,
    status: 'IN_PROGRESS',
    matches: pairings.slice()
  };

  const inProgressCount = pairings.filter(m => String(m.status).toUpperCase() === 'IN_PROGRESS').length;
  const completeCount = pairings.length - inProgressCount;

  return {
    eventId: opts.eventId ?? (900000 + n),
    eventName: opts.eventName || `Synthetic Stress ${n}`,
    playerCount: n,
    displayStatus: 'in_progress',
    isCompleted: false,
    standingsRound: completedRounds,
    activeRound,
    totalRounds,
    cutSize,
    demoMeta: {
      kind: 'synthetic',
      completedRounds,
      activeRound,
      totalRounds,
      cutSize,
      bubbleHintRank: cutSize,
      pairingsMode,
      liveMatchCount: pairings.length,
      liveInProgressCount: inProgressCount,
      liveCompleteCount: completeCount,
      uiHint: pairingsMode === 'just_started'
        ? `Po R${completedRounds} (standings). R${activeRound}/${totalRounds} właśnie wystartowała — ${pairings.length} meczów LIVE (wszystkie IN_PROGRESS).`
        : `Po R${completedRounds}. R${activeRound}/${totalRounds} w toku — ${pairings.length} meczów (${inProgressCount} live / ${completeCount} koniec).`
    },
    standings: { standings },
    // Kształt jak Hydraproxy paginated matches payload
    pairings: {
      results: pairings,
      count: pairings.length,
      next: null,
      previous: null
    },
    roundsMatches
  };
}

/**
 * Pełne parowanie Swiss: każdy standing w dokładnie jednym meczu aktywnej rundy.
 * just_started → wszystkie IN_PROGRESS (bez wyniku); mid_round → co 3. stół COMPLETE.
 */
function buildFullRoundPairings(standings, opts = {}) {
  const list = Array.isArray(standings) ? standings : [];
  const pairingsMode = opts.pairingsMode === 'just_started' ? 'just_started' : 'mid_round';
  const roundNumber = opts.roundNumber || 1;
  const pairings = [];

  for (let i = 0; i < list.length; i += 2) {
    const s1 = list[i];
    const s2 = list[i + 1];
    const table = (i / 2) + 1;
    const p1 = {
      id: s1.player.id,
      best_identifier: s1.player.best_identifier
    };

    // Nieparzyste pole → BYE dla ostatniego (rzadkie; demo 2k jest parzyste).
    if (!s2) {
      pairings.push({
        id: roundNumber * 100000 + table,
        table_number: table,
        round_number: roundNumber,
        status: 'COMPLETE',
        is_bye: true,
        round_type: 'BYE',
        match_is_intentional_draw: false,
        match_is_unintentional_draw: false,
        team_1_game_wins: 2,
        team_2_game_wins: 0,
        players: [p1],
        player_1: p1,
        player_match_relationships: [{ player: p1 }]
      });
      break;
    }

    const p2 = {
      id: s2.player.id,
      best_identifier: s2.player.best_identifier
    };
    const finished = pairingsMode === 'mid_round' && table % 3 === 0;
    const draw = finished && table % 9 === 0;

    if (finished) {
      const match = {
        id: roundNumber * 100000 + table,
        table_number: table,
        round_number: roundNumber,
        status: 'COMPLETE',
        is_bye: false,
        match_is_intentional_draw: draw,
        match_is_unintentional_draw: false,
        players: [p1, p2],
        player_1: p1,
        player_2: p2,
        player_match_relationships: [{ player: p1 }, { player: p2 }]
      };
      if (draw) {
        match.team_1_game_wins = 1;
        match.team_2_game_wins = 1;
      } else {
        match.team_1_game_wins = 2;
        match.team_2_game_wins = 0;
        match.games_won_by_winner = 2;
        match.games_won_by_loser = 0;
        match.winning_player = { id: p1.id };
        match.winner_id = p1.id;
      }
      pairings.push(match);
    } else {
      // Świeży / trwający mecz — bez winnerów, 0:0, status LIVE
      pairings.push({
        id: roundNumber * 100000 + table,
        table_number: table,
        round_number: roundNumber,
        status: 'IN_PROGRESS',
        is_bye: false,
        match_is_intentional_draw: false,
        match_is_unintentional_draw: false,
        team_1_game_wins: 0,
        team_2_game_wins: 0,
        players: [p1, p2],
        player_1: p1,
        player_2: p2,
        player_match_relationships: [{ player: p1 }, { player: p2 }]
      });
    }
  }

  return pairings;
}

/**
 * Demo /tests: po 11 rundach Swiss, R12 właśnie wystartowała.
 * standingsRound=11, activeRound=12, PEŁNA lista pairings R12 (wszystkie IN_PROGRESS).
 */
function createDemo2kRound12(overrides = {}) {
  const { pairingsMode: modeOverride, ...rest } = overrides;
  const data = createSyntheticField(2000, {
    completedRounds: 11,
    totalRounds: 12,
    cutSize: 64,
    eventId: 920012,
    eventName: 'Demo 2k — po R11, R12 właśnie wystartowała (Top 64)',
    polishEvery: 35,
    pairingsMode: modeOverride === 'mid_round' ? 'mid_round' : 'just_started',
    ...rest
  });

  const players = data.standings.standings.length;
  const live = data.pairings.results;
  const expectedTables = Math.floor(players / 2);
  if (live.length < expectedTables) {
    throw new Error(`Demo 2k: partial R12 pairings (${live.length}/${expectedTables})`);
  }
  const paired = new Set();
  for (const m of live) {
    for (const rel of (m.player_match_relationships || [])) {
      if (rel?.player?.id != null) paired.add(rel.player.id);
    }
  }
  if (paired.size < players - (players % 2)) {
    throw new Error(`Demo 2k: unpaired players in R12 (${paired.size}/${players})`);
  }
  const allLive = live.every(m => String(m.status).toUpperCase() === 'IN_PROGRESS' || m.is_bye);
  if (modeOverride !== 'mid_round' && !allLive) {
    throw new Error('Demo 2k: expected every non-BYE R12 match IN_PROGRESS');
  }
  return data;
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

const api = {
  createSyntheticField,
  createDemo2kRound12,
  buildFullRoundPairings,
  binomialBuckets,
  getDefaultRoundsForN
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
}
if (typeof window !== 'undefined') {
  window.LorcanaDemoFixture = api;
}
