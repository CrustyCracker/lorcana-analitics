/**
 * DLC / CCQ prize ladders + layman status for „O co jeszcze gramy”.
 * Source of truth for MAIN1/MAIN2:
 *   docs/dlc-s3-prize-rules-me1.md + docs/dlc-s3-tournament-format.md (Pan Paździoch).
 */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.LorcanaPrizeLadders = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    /**
     * Real DLC S3 Swiss / cut shapes (phase-aware prizes).
     * MAIN1: Day1 8 + Day2 7 = 15 Swiss → hard Top8 SE.
     * MAIN2: Day1 8 + Day2 3 = 11 Swiss → NO playoffs; hard Top8 = invite by TB.
     * Day2 threshold: 18 match points after Day1.
     */
    const FORMAT_PROFILES = {
        MAIN1: {
            mode: 'MAIN1',
            day1Rounds: 8,
            day2Rounds: 7,
            totalSwissRounds: 15,
            day2MinPoints: 18,
            hasTopCut: true,
            topCutSize: 8,
            topCutStyle: 'se',
            note: '15 Swiss (8+7), potem hard Top8 SE (QF/SF Bo3, finał Bo5).'
        },
        MAIN2: {
            mode: 'MAIN2',
            day1Rounds: 8,
            day2Rounds: 3,
            totalSwissRounds: 11,
            day2MinPoints: 18,
            hasTopCut: false,
            topCutSize: 8,
            topCutStyle: null,
            note: '11 Swiss (8+3), bez playoffów — hard Top8 = zaproszenie EUC po TB na końcu Swiss.'
        },
        CCQ: {
            mode: 'CCQ',
            day1Rounds: null,
            day2Rounds: null,
            totalSwissRounds: null,
            day2MinPoints: null,
            hasTopCut: true,
            topCutSize: 8,
            topCutStyle: 'se',
            note: 'Lokalny format CCQ / Infinity.'
        },
        custom: {
            mode: 'custom',
            day1Rounds: null,
            day2Rounds: null,
            totalSwissRounds: null,
            day2MinPoints: null,
            hasTopCut: true,
            topCutSize: 8,
            topCutStyle: 'se',
            note: 'Cut i rundy z konfiguracji admina.'
        }
    };

    const MODE_DEFAULTS = {
        MAIN1: { cutSize: 32, cutRule: 'soft', label: 'DLC MAIN1', swissRounds: 15 },
        MAIN2: { cutSize: 8, cutRule: 'hard', label: 'DLC MAIN2', swissRounds: 11 },
        CCQ: { cutSize: 8, cutRule: 'hard', label: 'CCQ / Infinity', swissRounds: null },
        custom: { cutSize: 8, cutRule: 'hard', label: 'Własny tryb', swissRounds: null }
    };

    /** @type {Record<string, object>} */
    const LADDERS = {
        MAIN1: {
            id: 'MAIN1',
            title: 'DLC Main Event 1',
            blurb: 'Zaproszenie EUC/NAC: Top 32 + wszyscy z tą samą liczbą punktów (bez TB). Nagrody rzeczowe: dokładne miejsce po TB. Format: 15 Swiss → hard Top8.',
            inviteSoftTopN: 32,
            day2MinPoints: 18,
            // Top Cut drabinka = hard Top 8; soft EUC = osobny próg (inv), nie soft cut drabinki.
            rungs: [
                { id: 'part', kind: 'participation', category: 'promo', short: 'Promo za udział', detail: 'Ursula – Deceiver', tableChip: false },
                { id: 'w3', kind: 'wins', wins: 3, category: 'promo', short: '🦁 Be Prepared (3W)', detail: 'Promo Be Prepared za 3 wygrane', tableChip: true, chip: '🦁', chipTitle: 'Be Prepared — 3 wygrane' },
                { id: 'd2', kind: 'day2_points', minPoints: 18, category: 'mat', short: 'DAY2 mata', detail: 'Be Prepared (awans do Day 2 ≥18 pkt po Day1)', tableChip: true, chip: 'DAY2', chipTitle: 'Day 2 — mata Be Prepared (≥18 pkt po Day1)' },
                { id: 't64', kind: 'hard_rank', topN: 64, category: 'promo', short: 'Promo Top 64', detail: 'Gaston – Superior Archer (po TB)', tableChip: true, chip: 'T64', chipTitle: 'Promo Top 64 (Gaston)' },
                { id: 't32promo', kind: 'hard_rank', topN: 32, category: 'promo', short: 'Promo Top 32', detail: 'Madam Mim – Resourceful Trickster (po TB)', tableChip: true, chip: 'T32', chipTitle: 'Promo Top 32 (Madam Mim)' },
                { id: 'inv', kind: 'soft_invite', topN: 32, category: 'invite', short: 'EUC soft (T32+remisy)', detail: 'Top 32 + równi punktami (bez TB)', tableChip: true, chip: 'EUC', chipTitle: 'Zaproszenie EUC/NAC — Top 32 + remisy' },
                { id: 't16', kind: 'hard_rank', topN: 16, category: 'mat', short: 'Mata Top 16', detail: 'Madam Mim – Resourceful Trickster (po TB)', tableChip: true, chip: 'T16', chipTitle: 'Mata Top 16 (Madam Mim)' },
                { id: 't8', kind: 'hard_rank', topN: 8, category: 'promo', short: 'Top Cut /250', detail: 'Hades – Dark Usurper — ścisłe Top 8 po TB (po R15)', tableChip: true, chip: 'T8', chipTitle: 'Top Cut (hard Top 8 po Swiss) — Hades /250' },
                { id: 't4', kind: 'hard_rank', topN: 4, category: 'cut', short: 'Uncut foil Top 4', detail: 'Niepocięty arkusz foil', tableChip: false },
                { id: 't2', kind: 'hard_rank', topN: 2, category: 'cut', short: 'Full foil set Top 2', detail: 'Pełny set foil najnowszego dodatku', tableChip: false },
                { id: 't1', kind: 'hard_rank', topN: 1, category: 'cut', short: 'Trofeum + Worlds', detail: '1. miejsce: trofeum i zaproszenie Worlds 2027', tableChip: false }
            ]
        },
        MAIN2: {
            id: 'MAIN2',
            title: 'DLC Main Event 2',
            blurb: '11 Swiss (8+3), bez playoffów. Zaproszenie EUC/NAC = ścisłe Top 8 po TB na końcu Swiss. Top 32 promo bez zaproszenia.',
            inviteSoftTopN: null,
            day2MinPoints: 18,
            // ME2: EUC = hard Top 8 po Swiss (nie drabinka mid-event). Chip T8 = ten sam próg.
            rungs: [
                { id: 'part', kind: 'participation', category: 'promo', short: 'Promo za udział', detail: 'Karta promo za start', tableChip: false },
                { id: 'w3', kind: 'wins', wins: 3, category: 'promo', short: '🦁 Be Prepared (3W)', detail: 'Promo za 3 wygrane mecze', tableChip: true, chip: '🦁', chipTitle: 'Be Prepared — 3 wygrane' },
                { id: 'd2', kind: 'day2_points', minPoints: 18, category: 'mat', short: 'DAY2', detail: 'Awans do Day 2 (≥18 pkt po Day1)', tableChip: true, chip: 'DAY2', chipTitle: 'Day 2 (≥18 pkt po Day1)' },
                { id: 't32promo', kind: 'hard_rank', topN: 32, category: 'promo', short: 'Promo Top 32', detail: 'Madam Mim — BEZ zaproszenia EUC/NAC', tableChip: true, chip: 'T32', chipTitle: 'Promo Top 32 (bez EUC)' },
                { id: 'inv', kind: 'hard_rank', topN: 8, category: 'invite', short: 'EUC hard Top 8', detail: 'Wyłącznie ścisłe Top 8 po TB na końcu Swiss (bez playoffów)', tableChip: true, chip: 'EUC', chipTitle: 'Zaproszenie EUC/NAC — hard Top 8 po Swiss + TB' },
                { id: 't8', kind: 'hard_rank', topN: 8, category: 'cut', short: 'Hard Top 8 (po Swiss)', detail: 'To samo co EUC — ranking po R11 + TB, nie drabinka', tableChip: true, chip: 'T8', chipTitle: 'Hard Top 8 po Swiss + TB (invite, bez playoffów)' },
                { id: 't4', kind: 'hard_rank', topN: 4, category: 'cut', short: 'Top 4', detail: 'Miejsce w tabeli po Swiss + TB', tableChip: false },
                { id: 't2', kind: 'hard_rank', topN: 2, category: 'cut', short: 'Top 2', detail: 'Miejsce w tabeli po Swiss + TB', tableChip: false },
                { id: 't1', kind: 'hard_rank', topN: 1, category: 'cut', short: '1. miejsce', detail: 'Zwycięzca ME2 po Swiss + TB', tableChip: false }
            ]
        },
        CCQ: {
            id: 'CCQ',
            title: 'CCQ / Infinity',
            blurb: 'Challenge Championship Qualifier / Infinity Constructed — cut i nagrody według lokalnych zasad (domyślnie twardy Top 8).',
            inviteSoftTopN: null,
            day2MinPoints: null,
            rungs: [
                { id: 'part', kind: 'participation', category: 'promo', short: 'Udział', detail: 'Start w CCQ / Infinity', tableChip: false },
                { id: 'cut', kind: 'hard_rank', topN: 8, category: 'cut', short: 'Top Cut', detail: 'Awans do Top Cut (domyślnie Top 8, po TB)', tableChip: true, chip: 'T8', chipTitle: 'Top Cut (hard Top 8)' },
                { id: 'inv', kind: 'hard_rank', topN: 1, category: 'invite', short: 'Zaproszenie / slot', detail: 'Zwycięzca CCQ — typowo slot kontynentalny (sprawdź lokalne zasady)', tableChip: false },
                { id: 't4', kind: 'hard_rank', topN: 4, category: 'cut', short: 'Top 4', detail: 'Miejsce w Top 4 po TB', tableChip: false },
                { id: 't2', kind: 'hard_rank', topN: 2, category: 'cut', short: 'Finał', detail: 'Awans do finału', tableChip: false }
            ]
        },
        custom: {
            id: 'custom',
            title: 'Własny tryb',
            blurb: 'Cut i zasady z konfiguracji admina. Panel nagród pokazuje tylko Top Cut.',
            inviteSoftTopN: null,
            day2MinPoints: null,
            rungs: [
                { id: 'cut', kind: 'mode_cut', category: 'cut', short: 'Top Cut', detail: 'Awans według ustawionego cutu admina', tableChip: true, chip: 'CUT', chipTitle: 'Top Cut (ustawienie admina)' }
            ]
        }
    };

    function normalizeMode(mode) {
        const m = String(mode || 'custom').toUpperCase();
        if (m === 'MAIN1' || m === 'DLC_MAIN1' || m === 'ME1') return 'MAIN1';
        if (m === 'MAIN2' || m === 'DLC_MAIN2' || m === 'ME2') return 'MAIN2';
        if (m === 'CCQ' || m === 'INFINITY' || m === 'CCQ_INFINITY') return 'CCQ';
        return 'custom';
    }

    function getModeDefaults(mode) {
        const id = normalizeMode(mode);
        return Object.assign({ mode: id }, MODE_DEFAULTS[id] || MODE_DEFAULTS.custom);
    }

    function getFormatProfile(mode) {
        const id = normalizeMode(mode);
        return FORMAT_PROFILES[id] || FORMAT_PROFILES.custom;
    }

    function getLadder(mode) {
        const id = normalizeMode(mode);
        return LADDERS[id] || LADDERS.custom;
    }

    function parseWins(player) {
        const ues = player?.user_event_status;
        if (ues && ues.matches_won != null) return Number(ues.matches_won) || 0;
        const rec = String(player?.record || player?.match_record || '');
        const m = rec.match(/^(\d+)\s*-\s*\d+/);
        if (m) return Number(m[1]) || 0;
        return 0;
    }

    function playerPoints(player) {
        return Number(player?.livePoints ?? player?.match_points ?? player?.points ?? 0) || 0;
    }

    function playerRank(player, indexFallback) {
        const r = Number(player?.rank ?? player?.liveRank);
        if (Number.isFinite(r) && r > 0) return r;
        return (indexFallback != null ? indexFallback + 1 : 9999);
    }

    function sortByPointsThenTb(list) {
        return [...(list || [])].sort((a, b) => {
            const ptsA = playerPoints(a);
            const ptsB = playerPoints(b);
            if (ptsB !== ptsA) return ptsB - ptsA;
            const omwA = Number(a.opponent_match_win_percentage || 0);
            const omwB = Number(b.opponent_match_win_percentage || 0);
            if (omwB !== omwA) return omwB - omwA;
            const gwA = Number(a.game_win_percentage || 0);
            const gwB = Number(b.game_win_percentage || 0);
            if (gwB !== gwA) return gwB - gwA;
            return Number(b.opponent_game_win_percentage || 0) - Number(a.opponent_game_win_percentage || 0);
        });
    }

    function softThresholdPoints(standings, topN) {
        const sorted = sortByPointsThenTb(standings);
        if (!sorted.length) return null;
        const idx = Math.min(Math.max(1, topN) - 1, sorted.length - 1);
        return playerPoints(sorted[idx]);
    }

    function maxReachablePoints(pts, roundsLeft) {
        return pts + 3 * Math.max(0, roundsLeft | 0);
    }

    function gatekeeperPointsForHardRank(standings, topN) {
        const sorted = sortByPointsThenTb(standings);
        if (!sorted.length) return 0;
        const idx = Math.min(Math.max(1, topN) - 1, sorted.length - 1);
        return playerPoints(sorted[idx]);
    }

    /**
     * Resolve Swiss / TopCut / complete phase from format + live opts.
     * @returns {{ phase: 'swiss'|'topcut'|'complete', swissDone: boolean, totalSwissRounds: number, roundsLeft: number, day1Done: boolean, roundsLeftDay1: number, format: object }}
     */
    function resolveEventPhase(mode, opts = {}) {
        const format = getFormatProfile(mode);
        const activeRound = Math.max(0, Number(opts.activeRound) || 0);
        const configuredTotal = Math.max(1, Number(opts.totalRounds) || 1);
        const formatSwiss = format.totalSwissRounds != null ? Number(format.totalSwissRounds) : null;
        const optSwiss = opts.totalSwissRounds != null ? Number(opts.totalSwissRounds) : null;
        const totalSwissRounds = Math.max(
            1,
            optSwiss || formatSwiss || configuredTotal
        );

        const topCutActive = Boolean(opts.topCutActive);
        const isCompleted = Boolean(opts.isCompleted);

        let phase = 'swiss';
        if (isCompleted) {
            phase = 'complete';
        } else if (topCutActive || (format.hasTopCut && activeRound > totalSwissRounds)) {
            phase = 'topcut';
        } else if (!format.hasTopCut && activeRound >= totalSwissRounds) {
            phase = 'complete';
        } else if (activeRound >= totalSwissRounds) {
            // Swiss board filled; waiting / seeding cut
            phase = format.hasTopCut ? 'topcut' : 'complete';
        }

        const swissDone = phase === 'topcut' || phase === 'complete';
        const roundsLeft = swissDone ? 0 : Math.max(0, totalSwissRounds - activeRound);

        const day1Rounds = format.day1Rounds != null ? Number(format.day1Rounds) : null;
        const day1Done = day1Rounds == null
            ? swissDone
            : (swissDone || activeRound >= day1Rounds);
        const roundsLeftDay1 = day1Rounds == null
            ? roundsLeft
            : (day1Done ? 0 : Math.max(0, day1Rounds - activeRound));

        return {
            phase,
            swissDone,
            totalSwissRounds,
            roundsLeft,
            day1Done,
            roundsLeftDay1,
            day1Rounds,
            format,
            activeRound
        };
    }

    /**
     * Evaluate one rung for a player.
     * status: locked | in_play | missed
     */
    function evaluateRung(rung, ctx) {
        const {
            points,
            wins,
            rank,
            roundsLeft,
            standings,
            cutSize,
            cutRule,
            swissDone,
            day1Done,
            roundsLeftDay1,
            phase,
            hasTopCut
        } = ctx;

        const base = {
            id: rung.id,
            kind: rung.kind,
            category: rung.category,
            short: rung.short,
            detail: rung.detail,
            status: 'in_play',
            note: ''
        };

        if (rung.kind === 'participation') {
            return Object.assign(base, {
                status: 'locked',
                note: 'Masz za sam udział.'
            });
        }

        if (rung.kind === 'wins') {
            const need = Number(rung.wins) || 3;
            if (wins >= need) {
                return Object.assign(base, { status: 'locked', note: `Masz już ${wins} wygranych.` });
            }
            const maxWins = wins + Math.max(0, roundsLeft);
            if (maxWins < need) {
                return Object.assign(base, { status: 'missed', note: `Za mało rund, by dojść do ${need} wygranych.` });
            }
            return Object.assign(base, {
                status: 'in_play',
                note: `Potrzebujesz jeszcze ${need - wins} wygranych (masz ${wins}).`
            });
        }

        if (rung.kind === 'day2_points') {
            const minPts = Number(rung.minPoints) || 18;
            if (points >= minPts) {
                return Object.assign(base, {
                    status: 'locked',
                    note: `Masz ${points} pkt (próg Day 2: ${minPts} po Day1).`
                });
            }
            // Day2 cut is decided after Day1 — remaining Day2 Swiss cannot create Day2 berth.
            const reachRounds = (roundsLeftDay1 != null) ? roundsLeftDay1 : roundsLeft;
            if (day1Done || swissDone || maxReachablePoints(points, reachRounds) < minPts) {
                return Object.assign(base, {
                    status: 'missed',
                    note: day1Done || swissDone
                        ? `Day1 zamknięty — ${points} pkt < ${minPts} (próg Day 2).`
                        : `Nawet same wygrane w Day1 nie dadzą ${minPts} pkt.`
                });
            }
            return Object.assign(base, {
                status: 'in_play',
                note: `Cel: ≥${minPts} pkt po Day1 (masz ${points}, max ${maxReachablePoints(points, reachRounds)}).`
            });
        }

        if (rung.kind === 'soft_invite') {
            const topN = Number(rung.topN) || 32;
            const thresh = softThresholdPoints(standings, topN);
            if (thresh == null) {
                return Object.assign(base, { status: 'in_play', note: 'Brak standings.' });
            }
            if (points >= thresh) {
                return Object.assign(base, {
                    status: 'locked',
                    note: swissDone
                        ? `Soft próg = ${thresh} pkt — jesteś na zaproszeniu (równe punkty wliczone).`
                        : `Teraz soft próg = ${thresh} pkt — trzymasz zaproszenie, jeśli nie spadniesz poniżej.`
                });
            }
            if (swissDone || maxReachablePoints(points, roundsLeft) < thresh) {
                return Object.assign(base, {
                    status: 'missed',
                    note: swissDone
                        ? `Swiss / cut zamknięty — soft próg ${thresh} pkt, masz ${points}.`
                        : `Soft próg ${thresh} pkt jest poza zasięgiem (max ${maxReachablePoints(points, roundsLeft)}).`
                });
            }
            return Object.assign(base, {
                status: 'in_play',
                note: `Cel: dołączyć do koszyka ≥${thresh} pkt (Top ${topN} + remisy). Masz ${points}.`
            });
        }

        if (rung.kind === 'mode_cut') {
            const topN = Math.max(2, Number(cutSize) || 8);
            const rule = cutRule === 'soft' ? 'soft' : 'hard';
            if (rule === 'soft') {
                return evaluateRung(
                    { id: rung.id, kind: 'soft_invite', topN, category: rung.category, short: rung.short, detail: rung.detail },
                    ctx
                );
            }
            return evaluateRung(
                { id: rung.id, kind: 'hard_rank', topN, category: rung.category, short: rung.short, detail: rung.detail },
                ctx
            );
        }

        if (rung.kind === 'hard_rank') {
            const topN = Math.max(1, Number(rung.topN) || 8);
            const gatePts = gatekeeperPointsForHardRank(standings, topN);

            // After Swiss (or in Top8 / complete): hard places are settled by TB — no orange „fighting”.
            if (swissDone || roundsLeft <= 0) {
                if (rank <= topN) {
                    const phaseNote = phase === 'topcut'
                        ? (hasTopCut
                            ? `Faza Top Cut — #${rank} ma secured Top ${topN}.`
                            : `Swiss zakończony — #${rank} w ścisłym Top ${topN} po TB.`)
                        : `Miejsce #${rank} — w ścisłym Top ${topN} po TB.`;
                    return Object.assign(base, { status: 'locked', note: phaseNote });
                }
                return Object.assign(base, {
                    status: 'missed',
                    note: phase === 'topcut' && hasTopCut
                        ? `Po Swiss / w Top Cut: tylko Top ${topN} ma cut. Jesteś #${rank} — T${topN} missed.`
                        : `Swiss zakończony — #${rank} poza ścisłym Top ${topN} (TB rozstrzygnięte; równe punkty nie wystarczą).`
                });
            }

            if (rank <= topN) {
                return Object.assign(base, {
                    status: 'in_play',
                    note: hasTopCut === false
                        ? `Jesteś #${rank}/${topN} na żywo — jeszcze ${roundsLeft} rund Swiss; hard Top ${topN} pada po TB na końcu (bez playoffów).`
                        : `Jesteś #${rank}/${topN} na żywo — jeszcze ${roundsLeft} rund Swiss, TB mogą przestawić.`
                });
            }
            if (maxReachablePoints(points, roundsLeft) < gatePts) {
                return Object.assign(base, {
                    status: 'missed',
                    note: `Top ${topN} siedzi na ≥${gatePts} pkt; Twój max to ${maxReachablePoints(points, roundsLeft)}.`
                });
            }
            // Still possible by points, but may need TB if tied.
            if (points > gatePts || (points === gatePts && rank <= topN * 3)) {
                return Object.assign(base, {
                    status: 'in_play',
                    note: hasTopCut === false
                        ? `W grze o hard Top ${topN} po Swiss + TB (gate ~${gatePts} pkt, #${rank}, ${points} pkt) — bez drabinki.`
                        : `W grze o Top ${topN} po Swiss (gate ~${gatePts} pkt, jesteś #${rank}, ${points} pkt).`
                });
            }
            return Object.assign(base, {
                status: 'in_play',
                note: `Potrzebujesz dogonić ~${gatePts} pkt (masz ${points}, max ${maxReachablePoints(points, roundsLeft)}).`
            });
        }

        return Object.assign(base, { status: 'in_play', note: '' });
    }

    function findPlayerInStandings(standings, playerId) {
        if (playerId == null) return { player: null, index: -1 };
        const id = String(playerId);
        for (let i = 0; i < (standings || []).length; i++) {
            const p = standings[i];
            const pid = p?.player?.id ?? p?.id;
            if (String(pid) === id) return { player: p, index: i };
        }
        return { player: null, index: -1 };
    }

    /**
     * @returns {{ mode, ladder, playerName, points, wins, rank, roundsLeft, phase, groups: {locked,in_play,missed}, rungs }}
     */
    function evaluatePlayerPrizes(mode, standings, playerId, opts = {}) {
        const ladder = getLadder(mode);
        const cutSize = opts.cutSize != null ? Number(opts.cutSize) : (getModeDefaults(mode).cutSize || 8);
        const cutRule = opts.cutRule === 'soft' ? 'soft' : (opts.cutRule === 'hard' ? 'hard' : getModeDefaults(mode).cutRule);
        const phaseInfo = resolveEventPhase(mode, opts);
        const {
            phase,
            swissDone,
            roundsLeft,
            day1Done,
            roundsLeftDay1,
            totalSwissRounds,
            format
        } = phaseInfo;

        const { player, index } = findPlayerInStandings(standings, playerId);
        if (!player) {
            return {
                mode: normalizeMode(mode),
                ladder,
                playerName: null,
                points: 0,
                wins: 0,
                rank: null,
                roundsLeft,
                phase,
                swissDone,
                totalSwissRounds,
                cutSize,
                cutRule,
                groups: { locked: [], in_play: [], missed: [] },
                rungs: [],
                emptyReason: 'Wybierz gracza (klik w LIVE albo wyszukaj), żeby zobaczyć o co jeszcze gra.'
            };
        }

        const points = playerPoints(player);
        const wins = parseWins(player);
        const rank = playerRank(player, index);
        const name = player?.player?.best_identifier
            || player?.user_event_status?.best_identifier
            || player?.name
            || `#${playerId}`;

        const ctx = {
            points,
            wins,
            rank,
            roundsLeft,
            standings,
            cutSize,
            cutRule,
            swissDone,
            day1Done,
            roundsLeftDay1,
            phase,
            hasTopCut: Boolean(format.hasTopCut)
        };
        const rungs = (ladder.rungs || []).map((r) => evaluateRung(r, ctx));
        const groups = {
            locked: rungs.filter((r) => r.status === 'locked'),
            in_play: rungs.filter((r) => r.status === 'in_play'),
            missed: rungs.filter((r) => r.status === 'missed')
        };

        return {
            mode: normalizeMode(mode),
            ladder,
            format,
            playerName: name,
            playerId,
            points,
            wins,
            rank,
            roundsLeft,
            phase,
            swissDone,
            totalSwissRounds,
            day1Done,
            cutSize,
            cutRule,
            softThresh: ladder.inviteSoftTopN ? softThresholdPoints(standings, ladder.inviteSoftTopN) : null,
            groups,
            rungs,
            emptyReason: null
        };
    }

    function statusLabelPl(status) {
        if (status === 'locked') return 'Masz / trzymasz';
        if (status === 'missed') return 'Już nie';
        return 'Jeszcze w grze';
    }

    function categoryLabelPl(cat) {
        if (cat === 'promo') return 'Promo';
        if (cat === 'mat') return 'Mata';
        if (cat === 'invite') return 'Zaproszenie';
        if (cat === 'cut') return 'Cut / podium';
        return 'Nagroda';
    }

    /** Compact chip color class: green / orange / red. */
    function statusChipClass(status) {
        if (status === 'locked') return 'prize-chip--locked';
        if (status === 'missed') return 'prize-chip--missed';
        return 'prize-chip--play';
    }

    function statusChipLegendPl(status) {
        if (status === 'locked') return 'zielony = już masz / trzymasz';
        if (status === 'missed') return 'czerwony = już niemożliwe';
        return 'pomarańczowy = jeszcze walczysz';
    }

    /**
     * MAIN1: drabinka pucharowa zawsze hard Top 8
     * (soft Top32 MAIN1 dotyczy tylko zaproszenia EUC, nie bracketu).
     * MAIN2: brak playoffów — „Top 8” = hard invite po Swiss + TB.
     */
    function getTopCutBracketSize(mode, configuredCutSize) {
        const id = normalizeMode(mode);
        const format = getFormatProfile(id);
        if (id === 'MAIN1') return 8;
        if (id === 'MAIN2') return format.hasTopCut ? 8 : 0;
        const n = Number(configuredCutSize);
        if (Number.isFinite(n) && n >= 2) return n;
        return getModeDefaults(id).cutSize || 8;
    }

    /** Preferred Swiss round count for UI / TIE when mode has a fixed format. */
    function getFormatSwissRounds(mode) {
        const n = getFormatProfile(mode).totalSwissRounds;
        return n != null && Number.isFinite(Number(n)) ? Number(n) : null;
    }

    function getTableChipRungs(mode) {
        const ladder = getLadder(mode);
        return (ladder.rungs || []).filter((r) => r.tableChip !== false && r.chip);
    }

    /**
     * Compact per-player chip list for LIVE/official tables.
     * @returns {{ mode, chips: Array<{id,chip,title,status,note,className}>, emptyReason?: string }}
     */
    function evaluatePlayerTableChips(mode, standings, playerId, opts = {}) {
        const ev = evaluatePlayerPrizes(mode, standings, playerId, opts);
        if (ev.emptyReason) {
            return { mode: ev.mode, chips: [], emptyReason: ev.emptyReason, phase: ev.phase };
        }
        const byId = new Map((ev.rungs || []).map((r) => [r.id, r]));
        const chips = getTableChipRungs(mode).map((def) => {
            const hit = byId.get(def.id);
            const status = hit?.status || 'in_play';
            return {
                id: def.id,
                chip: def.chip,
                title: def.chipTitle || def.short || def.chip,
                status,
                note: hit?.note || '',
                className: statusChipClass(status)
            };
        });
        return { mode: ev.mode, chips, emptyReason: null, phase: ev.phase, swissDone: ev.swissDone };
    }

    return {
        MODE_DEFAULTS,
        FORMAT_PROFILES,
        LADDERS,
        normalizeMode,
        getModeDefaults,
        getFormatProfile,
        getFormatSwissRounds,
        getLadder,
        parseWins,
        softThresholdPoints,
        resolveEventPhase,
        evaluatePlayerPrizes,
        evaluatePlayerTableChips,
        evaluateRung,
        getTableChipRungs,
        getTopCutBracketSize,
        statusLabelPl,
        statusChipClass,
        statusChipLegendPl,
        categoryLabelPl,
        sortByPointsThenTb
    };
});
