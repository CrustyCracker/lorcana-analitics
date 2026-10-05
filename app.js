let trackingInterval = null;
let latestData = null;
let currentSelectedPlayerId = null;
let simulatedResultsCache = new Map();

const PAGE_SIZE = 32;
let currentPages = {
    pairings: 1,
    official: 1,
    live: 1
};
let cachedPairings = [];
let cachedOfficialStandings = [];
let cachedLiveStandings = [];
let cachedStandingsMap = new Map();
let cachedCutContext = { cutSize: 4, cutRule: 'hard', activeRound: 1, totalRounds: 1 };

// -------------------------------------------------------------
// FILTR: POLSCY GRACZE (FLAGA PL, GÓRY, SZCZUR, DRUŻYNY)
// -------------------------------------------------------------
const POLISH_TEAM_TAGS = ['GPL', 'M7', 'OSA', 'LV', 'Q2W', 'L4', 'EX', 'IDK'];
const POLISH_FLAG_REGEX = /[\u{1F1F5}\u{1F1F1}]|🇵🇱/u;
const POLISH_MOUNTAIN_REGEX = /[\u{1F3D4}\u{26F0}\u{1F5FB}]|[🏔⛰🗻]/u;
const POLISH_RAT_REGEX = /[\u{1F400}\u{1F401}]|[🐀🐁]/u;

let filterOnlyPoles = false;

function checkTextForPolishIndicators(text) {
    if (!text || typeof text !== 'string') return false;
    if (POLISH_FLAG_REGEX.test(text)) return true;
    if (POLISH_MOUNTAIN_REGEX.test(text)) return true;
    if (POLISH_RAT_REGEX.test(text)) return true;

    for (const tag of POLISH_TEAM_TAGS) {
        const regex = new RegExp('(?:^|[\\s_\\|\\-\\\[\\(\\{/])' + tag + '(?=[\\s_\\|\\-\\\\]\\)\\}:/]|$|\\b)', 'i');
        if (regex.test(text)) return true;
    }
    return false;
}

function isPolishPlayer(playerOrName, standingsMap = null) {
    if (!playerOrName) return false;
    if (typeof playerOrName === 'string') return checkTextForPolishIndicators(playerOrName);

    let standingObj = playerOrName.raw || playerOrName;
    if (standingsMap && playerOrName.id) {
        const found = standingsMap.get(String(playerOrName.id));
        if (found && found.raw) standingObj = found.raw;
    }

    const texts = [
        playerOrName.name,
        standingObj?.user_event_status?.best_identifier,
        standingObj?.player?.best_identifier,
        standingObj?.user_event_status?.user?.username,
        standingObj?.name
    ].filter(Boolean);

    for (const text of texts) {
        if (checkTextForPolishIndicators(text)) return true;
    }
    return false;
}

function toggleOnlyPoles() {
    filterOnlyPoles = !filterOnlyPoles;
    currentPages.pairings = 1;
    currentPages.official = 1;
    currentPages.live = 1;
    updatePolesFilterUI();
    renderPairingsTable();
    renderLiveStandingsTable();
    renderOfficialStandingsTable();
}

function updatePolesFilterUI() {
    const btn = document.getElementById('polesFilterToggleBtn');
    const text = document.getElementById('polesFilterBtnText');
    const badge = document.getElementById('polesCountBadge');
    
    const pairingsNotice = document.getElementById('pairingsPolesNotice');
    const officialNotice = document.getElementById('officialPolesNotice');
    const liveNotice = document.getElementById('livePolesNotice');

    let polishCount = 0;
    if (cachedLiveStandings && cachedLiveStandings.length > 0) {
        polishCount = cachedLiveStandings.filter(p => isPolishPlayer(p, cachedStandingsMap)).length;
    } else if (cachedOfficialStandings && cachedOfficialStandings.length > 0) {
        polishCount = cachedOfficialStandings.filter(p => isPolishPlayer(p, cachedStandingsMap)).length;
    }

    if (badge) {
        if (polishCount > 0) {
            badge.style.display = 'inline-block';
            badge.innerText = `${polishCount} PL`;
        } else {
            badge.style.display = 'none';
        }
    }

    if (btn) {
        if (filterOnlyPoles) {
            btn.classList.add('active');
            if (text) text.innerText = 'Tylko Polacy (Aktywny)';
        } else {
            btn.classList.remove('active');
            if (text) text.innerText = 'Śledź tylko Polaków';
        }
    }

    const displayNotice = filterOnlyPoles ? 'inline-block' : 'none';
    if (pairingsNotice) pairingsNotice.style.display = displayNotice;
    if (officialNotice) officialNotice.style.display = displayNotice;
    if (liveNotice) liveNotice.style.display = displayNotice;
}

function renderPagination(containerId, totalItems, currentPage, onPageChangeName) {
    const el = document.getElementById(containerId);
    if (!el) return;

    if (totalItems <= PAGE_SIZE) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }

    const totalPages = Math.ceil(totalItems / PAGE_SIZE);
    const safePage = Math.max(1, Math.min(currentPage, totalPages));

    let pagesHtml = '';
    for (let p = 1; p <= totalPages; p++) {
        if (totalPages <= 7 || p === 1 || p === totalPages || (p >= safePage - 1 && p <= safePage + 1)) {
            const isActive = (p === safePage);
            pagesHtml += `<button class="pagination-btn ${isActive ? 'active' : ''}" style="${isActive ? 'background:#3498db; border-color:#3498db; font-weight:bold; color:#fff;' : ''}" onclick="${onPageChangeName}(${p})">${p}</button>`;
        } else if (p === safePage - 2 || p === safePage + 2) {
            pagesHtml += `<span style="padding: 0 4px; color: #666; font-size: 13px;">...</span>`;
        }
    }

    el.style.display = 'flex';
    el.innerHTML = `
        <button class="pagination-btn" onclick="${onPageChangeName}(${safePage - 1})" ${safePage <= 1 ? 'disabled' : ''}>« Poprzednia</button>
        ${pagesHtml}
        <button class="pagination-btn" onclick="${onPageChangeName}(${safePage + 1})" ${safePage >= totalPages ? 'disabled' : ''}>Następna »</button>
        <span class="pagination-info" style="margin-left: 8px;">(${totalItems} pozycji)</span>
    `;
}

function changePairingsPage(newPage) {
    let list = cachedPairings;
    if (filterOnlyPoles) {
        list = list.filter(m => {
            const p1 = resolvePlayer(getMatchParticipant(m, 1), cachedStandingsMap);
            const p2 = resolvePlayer(getMatchParticipant(m, 2), cachedStandingsMap);
            return isPolishPlayer(p1, cachedStandingsMap) || (p2 && isPolishPlayer(p2, cachedStandingsMap));
        });
    }
    const totalPages = Math.ceil((list.length || 0) / PAGE_SIZE);
    currentPages.pairings = Math.max(1, Math.min(newPage, totalPages || 1));
    renderPairingsTable();
}

function changeLivePage(newPage) {
    let list = cachedLiveStandings;
    if (filterOnlyPoles) {
        list = list.filter(p => isPolishPlayer(p, cachedStandingsMap));
    }
    const totalPages = Math.ceil((list.length || 0) / PAGE_SIZE);
    currentPages.live = Math.max(1, Math.min(newPage, totalPages || 1));
    renderLiveStandingsTable();
}

function changeOfficialPage(newPage) {
    let list = cachedOfficialStandings;
    if (filterOnlyPoles) {
        list = list.filter(p => isPolishPlayer(p, cachedStandingsMap));
    }
    const totalPages = Math.ceil((list.length || 0) / PAGE_SIZE);
    currentPages.official = Math.max(1, Math.min(newPage, totalPages || 1));
    renderOfficialStandingsTable();
}

function setElText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

function setElHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

function startTracking() {
    const eventId = document.getElementById('eventId')?.value || '865248';
    setElText('status', "Status: Pobieranie danych...");
    
    fetchData(eventId);
    if (trackingInterval) clearInterval(trackingInterval);
    trackingInterval = setInterval(() => fetchData(eventId), 20000);
}

async function fetchData(eventId) {
    try {
        const response = await fetch(`api.php?eventId=${eventId}&t=${Date.now()}`);
        const data = await response.json();
        
        if (data.error) {
            setElText('status', "BŁĄD: " + data.error);
            return;
        }
        
        latestData = data;
        const statsPanel = document.getElementById('statsPanel');
        if (statsPanel) statsPanel.style.display = "block";
        
        processPairings(data);
        processStandings(data);
        
        if (currentSelectedPlayerId) {
            recalculateTieForSelectedPlayer();
        }
        
        setElText('status', "Zaktualizowano: " + new Date().toLocaleTimeString());
    } catch (error) {
        console.error("Błąd pobierania danych:", error);
        setElText('status', "Błąd komunikacji z serwerem.");
    }
}

// -------------------------------------------------------------
// PANCERNY EKSTRAKTOR WYNIKU GIER (Z OBSŁUGĄ GAMES_WON_BY_WINNER)
// -------------------------------------------------------------

function getMatchScores(match) {
    const winnerId = match.winning_player ?? match.winner_id ?? match.winner?.id ?? null;
    const wonWinner = match.games_won_by_winner;
    const wonLoser = match.games_won_by_loser;

    if (wonWinner !== null && wonWinner !== undefined) {
        const p1Id = match.players?.[0] ?? 
                     match.player_match_relationships?.[0]?.player?.id ?? 
                     match.player_1?.id ?? match.team_1_id;
                     
        const p2Id = match.players?.[1] ?? 
                     match.player_match_relationships?.[1]?.player?.id ?? 
                     match.player_2?.id ?? match.team_2_id;

        if (winnerId !== null && String(p1Id) === String(winnerId)) {
            return { score1: Number(wonWinner), score2: Number(wonLoser ?? 0), hasScore: true, winnerId };
        } else if (winnerId !== null && String(p2Id) === String(winnerId)) {
            return { score1: Number(wonLoser ?? 0), score2: Number(wonWinner), hasScore: true, winnerId };
        }
    }

    const s1 = match.team_1_game_wins ?? match.player_1_game_wins ?? match.team_1_score ?? match.score_1 ?? 0;
    const s2 = match.team_2_game_wins ?? match.player_2_game_wins ?? match.team_2_score ?? match.score_2 ?? 0;
    const hasScore = (s1 > 0 || s2 > 0);

    return { score1: Number(s1), score2: Number(s2), hasScore, winnerId };
}

// -------------------------------------------------------------
// SŁOWNIK I MAPOWANIE GRACZY ZE STANDINGS NA MECZE LIVE
// -------------------------------------------------------------

function buildStandingsMap(standingsList) {
    const map = new Map();
    if (!standingsList || !Array.isArray(standingsList)) return map;
    
    standingsList.forEach(p => {
        const displayName = p.user_event_status?.best_identifier || 
                            p.player?.best_identifier || 
                            p.user_event_status?.user?.username || 
                            p.name || 
                            "Nieznany";
                            
        const playerObj = {
            id: p.player?.id || p.id,
            user_event_status_id: p.user_event_status?.id,
            name: displayName,
            raw: p
        };
        
        if (p.id) map.set(String(p.id), playerObj);
        if (p.player?.id) map.set(String(p.player.id), playerObj);
        if (p.user_event_status?.id) map.set(String(p.user_event_status.id), playerObj);
        if (p.user_event_status?.user?.id) map.set(String(p.user_event_status.user.id), playerObj);
    });
    
    return map;
}

function getMatchParticipant(match, slotIndex) {
    if (slotIndex === 1) {
        return match.players?.[0] ?? match.player_match_relationships?.[0]?.player ?? 
               match.player_1 ?? match.player1 ?? match.team_1 ?? match.team1 ?? null;
    } else {
        return match.players?.[1] ?? match.player_match_relationships?.[1]?.player ?? 
               match.player_2 ?? match.player2 ?? match.team_2 ?? match.team2 ?? null;
    }
}

function resolvePlayer(rawParticipant, standingsMap) {
    if (rawParticipant === null || rawParticipant === undefined) return null;
    
    if (typeof rawParticipant === 'number' || (typeof rawParticipant === 'string' && /^\d+$/.test(rawParticipant))) {
        const found = standingsMap.get(String(rawParticipant));
        if (found) return found;
        return { id: Number(rawParticipant), name: `Gracz #${rawParticipant}` };
    }
    
    if (typeof rawParticipant === 'object') {
        const possibleIds = [
            rawParticipant.id,
            rawParticipant.player_id,
            rawParticipant.user_id,
            rawParticipant.player?.id,
            rawParticipant.user_event_status?.id
        ].filter(Boolean);
        
        for (const id of possibleIds) {
            const found = standingsMap.get(String(id));
            if (found) return found;
        }
        
        const directName = rawParticipant.best_identifier ||
                           rawParticipant.player?.best_identifier ||
                           rawParticipant.user_event_status?.best_identifier ||
                           rawParticipant.name;
                           
        if (directName) {
            return {
                id: rawParticipant.id || rawParticipant.player?.id || null,
                name: directName
            };
        }
    }
    
    if (typeof rawParticipant === 'string') {
        return { id: null, name: rawParticipant };
    }
    
    return { id: null, name: "Nieznany" };
}

function formatStandingsPlayerName(player) {
    let rawName = player.player?.best_identifier || "Nieznany";
    let nickname = player.user_event_status?.best_identifier || rawName;
    
    let displayName = nickname;
    let parts = rawName.trim().split(/\s+/);
    if (parts.length > 1) {
        let firstName = parts[0];
        let lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
        displayName = `${nickname} (${firstName} ${lastInitial}.)`;
    }

    if (isPolishPlayer(player, cachedStandingsMap) && !POLISH_FLAG_REGEX.test(displayName)) {
        displayName += ' 🇵🇱';
    }
    return displayName;
}

function extractPairingsList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (raw.results && Array.isArray(raw.results)) return raw.results;
    if (raw.matches && Array.isArray(raw.matches)) return raw.matches;
    if (raw.data && Array.isArray(raw.data)) return raw.data;
    if (raw.pairings) {
        if (Array.isArray(raw.pairings)) return raw.pairings;
        if (raw.pairings.results && Array.isArray(raw.pairings.results)) return raw.pairings.results;
    }
    return [];
}

// -------------------------------------------------------------
// TABELA MECZÓW LIVE
// -------------------------------------------------------------

function processPairings(data) {
    setElText('pairingsRoundNum', data.activeRound || "-");
    const pairingsList = extractPairingsList(data.pairings);
    const standingsList = data.standings?.standings || [];
    const standingsMap = buildStandingsMap(standingsList);

    cachedPairings = pairingsList;
    cachedStandingsMap = standingsMap;

    let completedCount = 0;
    pairingsList.forEach(match => {
        const raw2 = getMatchParticipant(match, 2);
        const isBye = match.is_bye || match.bye || !raw2 || match.round_type === 'BYE';
        const { hasScore, winnerId } = getMatchScores(match);
        const statusRaw = (match.status || match.state || "").toUpperCase();
        const isComplete = statusRaw === "COMPLETE" || statusRaw === "FINISHED" || statusRaw === "COMPLETED" || winnerId != null || hasScore;
        if (isBye || isComplete) completedCount++;
    });

    if (pairingsList.length === 0) {
        setElText('matchesProgress', "0 zakończonych");
    } else {
        setElText('matchesProgress', `${completedCount}/${pairingsList.length} wpisane`);
    }

    renderPairingsTable();
}

function renderPairingsTable() {
    const tbody = document.getElementById('pairingsBody');
    if (!tbody) return;

    let list = cachedPairings;
    if (filterOnlyPoles) {
        list = list.filter(match => {
            const raw1 = getMatchParticipant(match, 1);
            const raw2 = getMatchParticipant(match, 2);
            const p1 = resolvePlayer(raw1, cachedStandingsMap);
            const p2 = resolvePlayer(raw2, cachedStandingsMap);
            return isPolishPlayer(p1, cachedStandingsMap) || (p2 && isPolishPlayer(p2, cachedStandingsMap));
        });
    }

    if (!list || list.length === 0) {
        tbody.innerHTML = filterOnlyPoles
            ? `<tr><td colspan="5" style="color: #888; padding: 20px;">Brak meczów z udziałem polskich graczy w tej rundzie.</td></tr>`
            : `<tr><td colspan="5" style="color: #888; padding: 20px;">Oczekiwanie na wygenerowanie parowań dla tej rundy...</td></tr>`;
        renderPagination('pairingsPagination', 0, 1, 'changePairingsPage');
        return;
    }

    const totalItems = list.length;
    const totalPages = Math.ceil(totalItems / PAGE_SIZE);
    currentPages.pairings = Math.max(1, Math.min(currentPages.pairings, totalPages));

    const start = (currentPages.pairings - 1) * PAGE_SIZE;
    const pageItems = list.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = "";

    pageItems.forEach((match, pageIdx) => {
        const globalIdx = start + pageIdx;
        const tr = document.createElement('tr');
        const tableNum = match.table_number || match.tableNumber || (globalIdx + 1);
        
        const raw1 = getMatchParticipant(match, 1);
        const raw2 = getMatchParticipant(match, 2);
        
        const p1 = resolvePlayer(raw1, cachedStandingsMap);
        const isBye = match.is_bye || match.bye || !raw2 || match.round_type === 'BYE';
        const p2 = isBye ? { id: null, name: "BYE (Wolny los)" } : resolvePlayer(raw2, cachedStandingsMap);
        
        let name1 = p1 ? p1.name : "Nieznany";
        if (isPolishPlayer(p1, cachedStandingsMap) && !POLISH_FLAG_REGEX.test(name1)) {
            name1 += ' 🇵🇱';
        }

        let name2 = isBye ? "BYE" : (p2 ? p2.name : "Nieznany");
        if (!isBye && isPolishPlayer(p2, cachedStandingsMap) && !POLISH_FLAG_REGEX.test(name2)) {
            name2 += ' 🇵🇱';
        }
        
        const { score1, score2, hasScore, winnerId } = getMatchScores(match);
        const statusRaw = (match.status || match.state || "").toUpperCase();
        const isComplete = statusRaw === "COMPLETE" || statusRaw === "FINISHED" || statusRaw === "COMPLETED" || winnerId != null || hasScore;
        const isDraw = match.match_is_intentional_draw || match.match_is_unintentional_draw || statusRaw === "DRAW";

        let statusBadge = "";
        let displayScore = `${score1} : ${score2}`;

        if (isBye) {
            statusBadge = `<span class="badge badge-bye">BYE</span>`;
            displayScore = `2 : 0`;
        } else if (isComplete) {
            statusBadge = `<span class="badge badge-complete">Koniec</span>`;
            
            if (isDraw) {
                displayScore = `<span style="color:#f1c40f;">REMIS</span>`;
            } else {
                displayScore = `${score1} : ${score2}`;
            }
        } else {
            statusBadge = `<span class="badge badge-live">Live</span>`;
        }

        const p1Won = isComplete && (score1 > score2 || (winnerId && p1 && String(p1.id) === String(winnerId)));
        const p2Won = isComplete && (score2 > score1 || (winnerId && p2 && String(p2.id) === String(winnerId)));
        
        const p1Style = p1Won ? 'color: #2ecc71; font-weight: bold;' : '';
        const p2Style = p2Won ? 'color: #2ecc71; font-weight: bold;' : '';

        tr.innerHTML = `
            <td><strong>#${tableNum}</strong></td>
            <td style="${p1Style}">${name1}</td>
            <td class="score-box">${displayScore}</td>
            <td style="${p2Style}">${name2}</td>
            <td>${statusBadge}</td>
        `;
        tbody.appendChild(tr);
    });

    renderPagination('pairingsPagination', totalItems, currentPages.pairings, 'changePairingsPage');
}

// -------------------------------------------------------------
// GŁÓWNA OBSŁUGA STANDINGS (ROZDZIELENIE NA LIVE I OFICJALNĄ)
// -------------------------------------------------------------

function getDefaultTotalRounds(playerCount) {
    if (!playerCount || playerCount <= 8) return 3;
    if (playerCount <= 16) return 4;
    if (playerCount <= 32) return 5;
    if (playerCount <= 64) return 6;
    if (playerCount <= 128) return 7;
    if (playerCount <= 226) return 8;
    if (playerCount <= 409) return 9;
    return 10;
}

function calculateTournamentDrawStats(data, pairingsList) {
    const standings = data.standings?.standings || [];
    let playerWins = 0, playerLosses = 0, playerDraws = 0;

    standings.forEach(p => {
        const u = p.user_event_status;
        if (u) {
            playerWins += (u.matches_won || 0);
            playerLosses += (u.matches_lost || 0);
            playerDraws += (u.matches_drawn || 0);
        } else if (p.match_record) {
            const parts = p.match_record.split('-').map(Number);
            playerWins += parts[0] || 0;
            playerLosses += parts[1] || 0;
            playerDraws += parts[2] || 0;
        }
    });

    let totalMatches = Math.round((playerWins + playerLosses + playerDraws) / 2);
    let drawMatches = Math.round(playerDraws / 2);

    // Jeśli w bieżącej rundzie na żywo są mecze, które nie zostały jeszcze uwzględnione w oficjalnej tabeli:
    if (data.activeRound > (data.standingsRound || 0) && pairingsList && pairingsList.length > 0) {
        pairingsList.forEach(m => {
            const status = (m.status || m.state || '').toUpperCase();
            const { score1, score2, hasScore, winnerId } = getMatchScores(m);
            const isComplete = status === 'COMPLETE' || status === 'FINISHED' || status === 'COMPLETED' || winnerId != null || hasScore;
            const isDraw = m.match_is_intentional_draw || m.match_is_unintentional_draw || status === 'DRAW';
            if (isComplete) {
                totalMatches++;
                if (isDraw) drawMatches++;
            }
        });
    }

    const pct = totalMatches > 0 ? ((drawMatches / totalMatches) * 100).toFixed(1) : '0.0';
    return { drawMatches, totalMatches, pct };
}

function processStandings(data) {
    const cutSize = parseInt(document.getElementById('cutSize')?.value || '4');
    const cutRule = document.getElementById('cutRule')?.value || 'hard';
    const standings = data.standings?.standings || [];
    
    const activeRound = data.activeRound || 1;
    const totalRounds = Math.max(data.totalRounds || getDefaultTotalRounds(data.playerCount), activeRound);

    setElText('eventNameDisplay', data.eventName || 'Turniej');
    setElText('totalPlayersDisplay', data.playerCount || 0);
    setElText('activeRoundInfo', `${activeRound}/${totalRounds}`);
    
    const roundsLeftCount = Math.max(0, totalRounds - activeRound);
    let roundsLeftLabel = "";
    if (roundsLeftCount === 0) {
        roundsLeftLabel = "Ostatnia runda!";
    } else if (roundsLeftCount === 1) {
        roundsLeftLabel = "2 z tą";
    } else {
        roundsLeftLabel = `${roundsLeftCount + 1} z tą`;
    }
    setElText('roundsLeftInfo', roundsLeftLabel);
    setElText('officialRoundNum', data.standingsRound || "-");
    
    if (!standings || standings.length === 0) return;

    const pairingsList = extractPairingsList(data.pairings);
    const standingsMap = buildStandingsMap(standings);

    // 1. Zbieramy delty punktowe z zakończonych meczów w bieżącej rundzie
    const liveScoreDeltas = new Map();
    pairingsList.forEach(m => {
        const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
        const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
        const id1 = p1?.id;
        const id2 = p2?.id;

        const { score1, score2, hasScore, winnerId } = getMatchScores(m);
        const status = (m.status || m.state || "").toUpperCase();
        const isComplete = status === "COMPLETE" || status === "FINISHED" || status === "COMPLETED" || winnerId != null || hasScore;
        const isDraw = m.match_is_intentional_draw || m.match_is_unintentional_draw || status === "DRAW";

        if (isComplete) {
            if (isDraw) {
                if (id1) liveScoreDeltas.set(String(id1), 1);
                if (id2) liveScoreDeltas.set(String(id2), 1);
            } else if (score1 > score2 || (winnerId && id1 && String(id1) === String(winnerId))) {
                if (id1) liveScoreDeltas.set(String(id1), 3);
                if (id2) liveScoreDeltas.set(String(id2), 0);
            } else if (score2 > score1 || (winnerId && id2 && String(id2) === String(winnerId))) {
                if (id1) liveScoreDeltas.set(String(id1), 0);
                if (id2) liveScoreDeltas.set(String(id2), 3);
            }
        }
    });

    // 2. Budujemy tablicę LIVE STANDINGS (bazowe punkty + punkty z zakończonych meczów bieżącej rundy)
    const liveStandings = standings.map(p => {
        const delta = liveScoreDeltas.get(String(p.player.id)) || 0;
        return {
            ...p,
            livePoints: p.match_points + delta,
            delta: delta
        };
    });

    // Sortujemy tabelę LIVE według zasad tiebreakerów Lorcany
    liveStandings.sort((a, b) => {
        if (b.livePoints !== a.livePoints) return b.livePoints - a.livePoints;
        if ((b.opponent_match_win_percentage || 0) !== (a.opponent_match_win_percentage || 0)) {
            return (b.opponent_match_win_percentage || 0) - (a.opponent_match_win_percentage || 0);
        }
        return (b.game_win_percentage || 0) - (a.game_win_percentage || 0);
    });

    liveStandings.forEach((p, idx) => {
        p.liveRank = idx + 1;
    });

    // 3. Obliczenia progu Cut
    let bubbleIndex = Math.min(cutSize - 1, liveStandings.length - 1);
    let currentBubbleScore = liveStandings[bubbleIndex].livePoints;
    let playersInCut = cutRule === 'soft' 
        ? liveStandings.filter(p => p.livePoints >= currentBubbleScore).length 
        : cutSize;

    let projectedFinalBubble = 0;
    if (activeRound > 0) {
        let pointsPerRound = currentBubbleScore / Math.max(1, activeRound);
        projectedFinalBubble = Math.ceil(pointsPerRound * totalRounds);
    }

    setElText('bubbleScore', currentBubbleScore);
    setElText('projectedBubbleScore', projectedFinalBubble);
    setElText('playersInCut', playersInCut);

    const drawStats = calculateTournamentDrawStats(data, pairingsList);
    setElText('tournamentDrawsInfo', `${drawStats.drawMatches} (${drawStats.pct}%)`);
    const drawCardEl = document.getElementById('tournamentDrawsInfo');
    if (drawCardEl) {
        drawCardEl.title = `${drawStats.drawMatches} z ${drawStats.totalMatches} meczów zakończyło się remisem`;
    }

    // 4. Przeliczamy symulacje Monte Carlo dla strategii w tabeli LIVE
    simulatedResultsCache.clear();
    standings.forEach(p => {
        let myOpponent = null;
        for (const m of pairingsList) {
            const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
            const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
            if (p1 && String(p1.id) === String(p.player.id)) {
                myOpponent = p2;
                break;
            } else if (p2 && String(p2.id) === String(p.player.id)) {
                myOpponent = p1;
                break;
            }
        }
        
        const simRes = runLiveTieSimulation(p, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, activeRound, totalRounds, projectedFinalBubble);
        simulatedResultsCache.set(String(p.player.id), { sim: simRes, opp: myOpponent });
    });

    // 5. Renderujemy obie tabele
    renderLiveStandingsTable(liveStandings, cutSize, cutRule, activeRound, totalRounds);
    renderOfficialStandingsTable(standings, cutSize, cutRule);
    updatePolesFilterUI();
}

// -------------------------------------------------------------
// TABELA 1: LIVE STANDINGS & STRATEGIA
// -------------------------------------------------------------

function renderLiveStandingsTable(liveStandings, cutSize, cutRule, activeRound, totalRounds) {
    if (liveStandings) cachedLiveStandings = liveStandings;
    if (cutSize !== undefined) cachedCutContext.cutSize = cutSize;
    if (cutRule !== undefined) cachedCutContext.cutRule = cutRule;
    if (activeRound !== undefined) cachedCutContext.activeRound = activeRound;
    if (totalRounds !== undefined) cachedCutContext.totalRounds = totalRounds;

    const ctx = cachedCutContext;
    const tbody = document.getElementById('liveStandingsBody');
    if (!tbody) return;

    let list = cachedLiveStandings;
    if (filterOnlyPoles) {
        list = list.filter(p => isPolishPlayer(p, cachedStandingsMap));
    }

    if (!list || list.length === 0) {
        tbody.innerHTML = filterOnlyPoles
            ? `<tr><td colspan="7" style="color: #888; padding: 20px;">Brak graczy z Polski w tabeli LIVE.</td></tr>`
            : `<tr><td colspan="7" style="color: #666; padding: 20px;">Trwa symulacja wyników live...</td></tr>`;
        renderPagination('livePagination', 0, 1, 'changeLivePage');
        return;
    }

    const totalItems = list.length;
    const totalPages = Math.ceil(totalItems / PAGE_SIZE);
    currentPages.live = Math.max(1, Math.min(currentPages.live, totalPages));

    const start = (currentPages.live - 1) * PAGE_SIZE;
    const pageItems = list.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = "";

    pageItems.forEach((player, pageIdx) => {
        const displayRank = player.liveRank || (start + pageIdx + 1);
        const tr = document.createElement('tr');
        tr.className = "clickable-row";
        tr.title = "Kliknij, aby otworzyć szczegóły w module Can I take a TIE";
        tr.onclick = () => selectPlayerForTie(player.player.id);
        
        const formattedName = formatStandingsPlayerName(player);
        const omwp = ((player.opponent_match_win_percentage || 0) * 100).toFixed(1) + "%";
        const gwp = ((player.game_win_percentage || 0) * 100).toFixed(1) + "%";
        
        const cached = simulatedResultsCache.get(String(player.player.id));
        const sim = cached?.sim;
        
        let ptsNeededText = "";
        let strategyText = "";
        let status = "";
        let rowClass = "";
        
        const inCut = (displayRank <= ctx.cutSize);

        if (!sim || sim.matchesLeft === 0) {
            status = inCut ? "W Cut" : "Odpada";
            rowClass = inCut ? "safe" : "dead";
            ptsNeededText = "Koniec";
            strategyText = status;
        } else if (sim.matchesLeft >= 2) {
            if (sim.chanceDoubleTie >= 90) {
                ptsNeededText = "2x TIE (+2)";
                strategyText = `Pewny 2x ID (${sim.chanceDoubleTie}%)`;
                status = "W Cut";
                rowClass = "safe";
            } else if (sim.chanceDoubleTie >= 75) {
                ptsNeededText = "2x TIE (+2)";
                strategyText = `Możliwy 2x ID (${sim.chanceDoubleTie}%)`;
                status = "W Cut";
                rowClass = "safe";
            } else if (sim.chanceWinTie >= 75) {
                ptsNeededText = "1x W + 1x T (+4)";
                strategyText = `Wymaga 1x W (${sim.chanceWinTie}%)`;
                status = "W grze";
                rowClass = "bubble";
            } else if (sim.chanceDoubleWin >= 40) {
                ptsNeededText = "2x WIN (+6)";
                strategyText = `Musi wygrać 2x (${sim.chanceDoubleWin}%)`;
                status = "W grze";
                rowClass = "bubble";
            } else {
                ptsNeededText = "2x WIN";
                strategyText = "Minimalne szanse";
                status = "Odpada";
                rowClass = "dead";
            }
        } else {
            // matchesLeft === 1 (ostatni mecz)
            if (sim.chanceTie >= 90 && sim.oppChanceTie >= 90) {
                ptsNeededText = "TIE (1 pkt)";
                strategyText = "Bezpieczny ID";
                status = "W Cut";
                rowClass = "safe";
            } else if (sim.chanceTie >= 75) {
                ptsNeededText = "TIE (1 pkt)";
                strategyText = `Możliwy ID (${sim.chanceTie}%)`;
                status = "W Cut";
                rowClass = "safe";
            } else if (sim.chanceWin >= 35) {
                ptsNeededText = "WIN (3 pkt)";
                strategyText = "Wymaga 1x W";
                status = "W grze";
                rowClass = "bubble";
            } else {
                ptsNeededText = "WIN";
                strategyText = "Odpada";
                status = "Odpada";
                rowClass = "dead";
            }
        }
        
        // Zaznaczenie dodanych punktów live (np. 1 + 3)
        let pointsDisplay = `<strong>${player.livePoints}</strong>`;
        if (player.delta > 0) {
            pointsDisplay += ` <span style="font-size: 11px; color: #2ecc71;">(+${player.delta})</span>`;
        }

        tr.className += " " + rowClass;
        if (currentSelectedPlayerId && String(player.player.id) === String(currentSelectedPlayerId)) {
            tr.style.outline = "2px solid #3498db";
            tr.style.backgroundColor = "rgba(52, 152, 219, 0.2)";
        }

        tr.innerHTML = `
            <td><strong>${displayRank}</strong></td>
            <td style="text-align: left;"><strong>${formattedName}</strong></td>
            <td>${pointsDisplay}</td>
            <td class="tiebreaker">${omwp} / ${gwp}</td>
            <td><strong>${ptsNeededText}</strong></td>
            <td class="strategy">${strategyText}</td>
            <td>${status}</td>
        `;
        tbody.appendChild(tr);
    });

    renderPagination('livePagination', totalItems, currentPages.live, 'changeLivePage');
}

// -------------------------------------------------------------
// TABELA 2: OFICJALNA TABELA RAVENSBURGERA (CZYSTE DANE API)
// -------------------------------------------------------------

function renderOfficialStandingsTable(standings, cutSize, cutRule) {
    if (standings) cachedOfficialStandings = standings;
    if (cutSize !== undefined) cachedCutContext.cutSize = cutSize;
    if (cutRule !== undefined) cachedCutContext.cutRule = cutRule;

    const ctx = cachedCutContext;
    const tbody = document.getElementById('officialStandingsBody');
    if (!tbody) return;

    if (!cachedOfficialStandings || cachedOfficialStandings.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="color: #666; padding: 20px;">Brak oficjalnej tabeli.</td></tr>`;
        renderPagination('officialPagination', 0, 1, 'changeOfficialPage');
        return;
    }

    // Kopia posortowana według oficjalnej kolejności API
    let officialList = [...cachedOfficialStandings].sort((a, b) => (a.rank || 0) - (b.rank || 0));
    if (filterOnlyPoles) {
        officialList = officialList.filter(p => isPolishPlayer(p, cachedStandingsMap));
    }

    if (officialList.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" style="color: #888; padding: 20px;">Brak graczy z Polski w oficjalnej tabeli.</td></tr>`;
        renderPagination('officialPagination', 0, 1, 'changeOfficialPage');
        return;
    }

    let bubbleIndex = Math.min(ctx.cutSize - 1, cachedOfficialStandings.length - 1);
    let bubbleScore = cachedOfficialStandings[bubbleIndex]?.match_points ?? 0;

    const totalItems = officialList.length;
    const totalPages = Math.ceil(totalItems / PAGE_SIZE);
    currentPages.official = Math.max(1, Math.min(currentPages.official, totalPages));

    const start = (currentPages.official - 1) * PAGE_SIZE;
    const pageItems = officialList.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = "";

    pageItems.forEach((player, pageIdx) => {
        const displayRank = player.rank || (start + pageIdx + 1);
        const tr = document.createElement('tr');
        const formattedName = formatStandingsPlayerName(player);
        const omwp = ((player.opponent_match_win_percentage || 0) * 100).toFixed(1) + "%";
        const gwp = ((player.game_win_percentage || 0) * 100).toFixed(1) + "%";
        
        const inCut = ctx.cutRule === 'soft' 
            ? player.match_points >= bubbleScore 
            : (displayRank <= ctx.cutSize);

        tr.className = inCut ? "safe" : (player.match_points >= bubbleScore ? "bubble" : "dead");
        tr.innerHTML = `
            <td>${displayRank}</td>
            <td style="text-align: left;">${formattedName}</td>
            <td><strong>${player.match_points}</strong></td>
            <td>${player.record || player.match_record || "-"}</td>
            <td class="tiebreaker">${omwp} / ${gwp}</td>
            <td>${inCut ? 'W Cut' : 'Poza Cut'}</td>
        `;
        tbody.appendChild(tr);
    });

    renderPagination('officialPagination', totalItems, currentPages.official, 'changeOfficialPage');
}

// -------------------------------------------------------------
// MODUŁ: CAN I TAKE A TIE? (MUTUAL SIMULATOR ENGINE)
// -------------------------------------------------------------

function onPlayerSearchInput() {
    const query = document.getElementById('playerSearchInput')?.value.toLowerCase().trim() || '';
    const dropdown = document.getElementById('playerSuggestions');
    if (!dropdown) return;
    
    if (!latestData || !latestData.standings?.standings || query.length < 1) {
        dropdown.style.display = 'none';
        return;
    }

    const standings = latestData.standings.standings;
    const matches = standings.filter(p => {
        let name = (p.player?.best_identifier || "").toLowerCase();
        let nick = (p.user_event_status?.best_identifier || "").toLowerCase();
        return name.includes(query) || nick.includes(query);
    });

    if (matches.length === 0) {
        dropdown.style.display = 'none';
        return;
    }

    dropdown.innerHTML = "";
    matches.slice(0, 8).forEach(p => {
        const item = document.createElement('div');
        item.className = "suggestion-item";
        item.innerText = `${formatStandingsPlayerName(p)} — ${p.match_points} pkt`;
        item.onclick = () => {
            selectPlayerForTie(p.player.id);
            dropdown.style.display = 'none';
            const input = document.getElementById('playerSearchInput');
            if (input) input.value = formatStandingsPlayerName(p);
        };
        dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
}

function selectPlayerForTie(playerId) {
    currentSelectedPlayerId = playerId;

    // Jeśli wybrany gracz znajduje się na innej stronie w tabeli LIVE, przełącz stronę
    let list = cachedLiveStandings;
    if (filterOnlyPoles) {
        list = list.filter(p => isPolishPlayer(p, cachedStandingsMap));
    }

    if (list && list.length > PAGE_SIZE) {
        const pIdx = list.findIndex(p => String(p.player?.id || p.id) === String(playerId));
        if (pIdx !== -1) {
            const targetPage = Math.floor(pIdx / PAGE_SIZE) + 1;
            if (currentPages.live !== targetPage) {
                currentPages.live = targetPage;
            }
        }
    }
    renderLiveStandingsTable();

    const resultArea = document.getElementById('tieResultArea');
    if (resultArea) resultArea.style.display = 'block';
    
    recalculateTieForSelectedPlayer();
    
    const tieMod = document.getElementById('tieModule');
    if (tieMod) tieMod.scrollIntoView({ behavior: 'smooth' });
}

function recalculateTieForSelectedPlayer() {
    if (!latestData || !latestData.standings?.standings || !currentSelectedPlayerId) return;

    const standings = latestData.standings.standings;
    const targetPlayer = standings.find(p => String(p.player?.id || p.id) === String(currentSelectedPlayerId));
    if (!targetPlayer) return;

    const activeRound = latestData.activeRound || 1;
    const totalRounds = Math.max(latestData.totalRounds || getDefaultTotalRounds(latestData.playerCount), activeRound);

    const cutSize = parseInt(document.getElementById('cutSize')?.value || '4');
    const cutRule = document.getElementById('cutRule')?.value || 'hard';

    const pairingsList = extractPairingsList(latestData.pairings);
    const standingsMap = buildStandingsMap(standings);
    
    let myMatch = null;
    let myOpponent = null;

    for (const m of pairingsList) {
        const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
        const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
        if (p1 && String(p1.id) === String(currentSelectedPlayerId)) {
            myMatch = m;
            myOpponent = p2;
            break;
        } else if (p2 && String(p2.id) === String(currentSelectedPlayerId)) {
            myMatch = m;
            myOpponent = p1;
            break;
        }
    }

    let bubbleIndex = Math.min(cutSize - 1, standings.length - 1);
    let bubbleScore = standings[bubbleIndex]?.match_points || 0;
    let projectedFinalBubble = Math.ceil((bubbleScore / Math.max(1, activeRound)) * totalRounds);

    const simResults = runLiveTieSimulation(targetPlayer, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, activeRound, totalRounds, projectedFinalBubble);

    const formattedName = formatStandingsPlayerName(targetPlayer);
    setElText('selectedPlayerName', formattedName);
    setElText('selectedPlayerTable', myMatch ? `(Stół #${myMatch.table_number || myMatch.tableNumber || '?'} vs ${myOpponent?.name || 'BYE'})` : "");
    setElText('selectedPlayerBaseStats', `Stan bazowy: ${targetPlayer.match_points} pkt | OMWP: ${(targetPlayer.opponent_match_win_percentage * 100).toFixed(1)}%`);

    // 1. Pasek kontekstu rundy
    const tieRoundContextEl = document.getElementById('tieRoundContext');
    if (tieRoundContextEl) {
        let matchStatePill = "";
        if (simResults.isCurrentMatchFinished) {
            matchStatePill = `<span style="color: #2ecc71;">✅ Twój mecz w R${activeRound} jest zakończony.</span>`;
        } else if (myMatch) {
            matchStatePill = `<span>⚔️ Stół #${myMatch.table_number || myMatch.tableNumber || '?'} vs <strong>${myOpponent?.name || 'BYE'}</strong></span>`;
        }
        
        let roundWord = simResults.matchesLeft === 1 ? 'mecz' : (simResults.matchesLeft >= 2 && simResults.matchesLeft <= 4 ? 'mecze' : 'meczów');
        tieRoundContextEl.innerHTML = `
            <span class="round-pill">🎯 Runda ${activeRound} z ${totalRounds}</span>
            <span class="round-pill">⏳ Pozostało do rozegrania: ${simResults.matchesLeft} ${roundWord}</span>
            ${matchStatePill}
        `;
    }

    // 2. Podpowiedź: Czy 2 remisy z rzędu dają Top Cut?
    renderDoubleTiePrompt(simResults, targetPlayer, myOpponent, totalRounds);

    // 3. Ścieżki awansu (Scenariusze wielorundowe)
    renderMultiRoundScenarios(simResults);

    // 4. Scenariusze dla obecnego pojedynczego meczu
    setElText('tieCurrentRoundNum', activeRound);
    setElText('chanceTieDisplay', simResults.chanceTie + "%");
    setElText('ptsTieDisplay', `Pkt po TIE: ${(targetPlayer.livePoints || targetPlayer.match_points) + 1}`);
    setElText('oppTieChanceDisplay', myOpponent ? `Rywal po TIE: ${simResults.oppChanceTie}%` : `Brak rywala`);
    
    setElText('chanceWinDisplay', simResults.chanceWin + "%");
    setElText('ptsWinDisplay', `Pkt po WIN: ${(targetPlayer.livePoints || targetPlayer.match_points) + 3}`);
    
    setElText('chanceLossDisplay', simResults.chanceLoss + "%");
    setElText('ptsLossDisplay', `Pkt po LOSS: ${(targetPlayer.livePoints || targetPlayer.match_points)}`);

    // 5. Główny baner z poradą taktyczną
    updateRecommendationBanner(simResults, myMatch, targetPlayer, myOpponent, activeRound, totalRounds);
}

function renderDoubleTiePrompt(sim, targetPlayer, myOpponent, totalRounds) {
    const panel = document.getElementById('doubleTiePromptPanel');
    const titleEl = document.getElementById('doubleTiePromptTitle');
    const badgeEl = document.getElementById('doubleTieVerdictBadge');
    const descEl = document.getElementById('doubleTiePromptDesc');
    const oppNoteEl = document.getElementById('doubleTieOpponentNote');
    if (!panel || !badgeEl || !descEl) return;

    panel.style.display = 'block';
    const oppName = myOpponent?.name || "Twój rywal";

    if (sim.matchesLeft >= 2) {
        if (titleEl) titleEl.innerText = "🤝 Czy 2 remisy z rzędu (2x ID) dają mi Top Cut?";
        
        if (sim.chanceDoubleTie >= 90) {
            badgeEl.className = 'verdict-badge verdict-yes';
            badgeEl.innerText = `TAK (${sim.chanceDoubleTie}%)`;
            descEl.innerHTML = `🎉 <strong>PEWNY AWANS:</strong> 2 remisy z rzędu (ID teraz oraz w kolejnej rundzie) dadzą Ci łącznie <strong>${sim.ptsDoubleTie} pkt</strong>. Szacowany próg Top Cut to ok. <strong>${sim.projectedBubble} pkt</strong>. Matematyka daje Ci aż <strong>${sim.chanceDoubleTie}%</strong> szans na wejście do fazy pucharowej! Możesz bezpiecznie brać Intentional Draw.`;
        } else if (sim.chanceDoubleTie >= 75) {
            badgeEl.className = 'verdict-badge verdict-maybe';
            badgeEl.innerText = `BARDZO PRAWDOPODOBNE (${sim.chanceDoubleTie}%)`;
            descEl.innerHTML = `🟡 <strong>WYSOKA SZANSA, ALE PILNUJ TIEBREAKERÓW:</strong> Po 2 remisach kończysz z <strong>${sim.ptsDoubleTie} pkt</strong> (${sim.chanceDoubleTie}% szans na Cut). Jesteś blisko progu – o awansie mogą zadecydować tiebreakery OMWP. Jeśli Twój rywal ma gorsze OMWP, może woleć grać o zwycięstwo.`;
        } else if (sim.chanceDoubleTie >= 45) {
            badgeEl.className = 'verdict-badge verdict-bubble';
            badgeEl.innerText = `RYZYKOWNE / BUBBLE (${sim.chanceDoubleTie}%)`;
            descEl.innerHTML = `⚠️ <strong>STREFA BUBBLE:</strong> 2 remisy to za duże ryzyko (tylko <strong>${sim.chanceDoubleTie}%</strong> szans). Prawdopodobnie wyprzedzą Cię gracze z niższych stołów, którzy wygrają swoje mecze. <strong>Lepsza strategia:</strong> powalcz o przynajmniej 1 zwycięstwo – scenariusz 1x WIN + 1x TIE podnosi Twoje szanse aż do <strong>${sim.chanceWinTie}%</strong>!`;
        } else {
            badgeEl.className = 'verdict-badge verdict-no';
            badgeEl.innerText = `NIE (${sim.chanceDoubleTie}%)`;
            descEl.innerHTML = `🛑 <strong>2 REMISY TO ZA MAŁO:</strong> Dwa remisy z rzędu dają tylko <strong>${sim.chanceDoubleTie}%</strong> szans. Kończysz z ${sim.ptsDoubleTie} pkt, podczas gdy próg odcięcia wyniesie ok. ${sim.projectedBubble} pkt. <strong>Musisz wygrać co najmniej jeden mecz</strong> (1x WIN + 1x TIE daje Ci <strong>${sim.chanceWinTie}%</strong> szans).`;
        }

        if (myOpponent && oppNoteEl) {
            if (sim.oppChanceDoubleTie >= 85) {
                oppNoteEl.innerHTML = `🤝 <strong>Wspólny interes:</strong> ${oppName} przy 2 remisach z rzędu również wchodzi do Cutu na <strong>${sim.oppChanceDoubleTie}%</strong>. Oboje macie idealną sytuację na obopólny ID!`;
            } else if (sim.oppChanceDoubleTie < 50) {
                oppNoteEl.innerHTML = `⚠️ <strong>Uwaga na rywala:</strong> ${oppName} przy 2 remisach ma tylko <strong>${sim.oppChanceDoubleTie}%</strong> szans. Może odrzucić propozycję remisu, bo desperacko potrzebuje 3 punktów (WIN)!`;
            } else {
                oppNoteEl.innerHTML = `ℹ️ Szansa rywala (${oppName}) przy podwójnym remisie wynosi ok. <strong>${sim.oppChanceDoubleTie}%</strong>.`;
            }
        } else if (oppNoteEl) {
            oppNoteEl.innerHTML = '';
        }
    } else {
        // matchesLeft === 1
        if (titleEl) titleEl.innerText = "🏁 Ostatnia runda: Czy remis (ID) daje mi Top Cut?";
        
        if (sim.chanceTie >= 90) {
            badgeEl.className = 'verdict-badge verdict-yes';
            badgeEl.innerText = `TAK (${sim.chanceTie}%)`;
            descEl.innerHTML = `🎉 <strong>PEWNY CUT:</strong> To ostatnia runda! Remis daje Ci łącznie <strong>${(targetPlayer.livePoints || targetPlayer.match_points) + 1} pkt</strong> i <strong>${sim.chanceTie}%</strong> gwarancji awansu do Top Cutu.`;
        } else if (sim.chanceTie >= 75) {
            badgeEl.className = 'verdict-badge verdict-maybe';
            badgeEl.innerText = `PRAWDOPODOBNE (${sim.chanceTie}%)`;
            descEl.innerHTML = `🟡 <strong>DOBRA SZANSA:</strong> Remis daje Ci <strong>${sim.chanceTie}%</strong> szans na Top Cut. O ewentualnym wypadnięciu zadecydują ułamki procenta OMWP.`;
        } else if (sim.chanceTie >= 45) {
            badgeEl.className = 'verdict-badge verdict-bubble';
            badgeEl.innerText = `RYZYKOWNE (${sim.chanceTie}%)`;
            descEl.innerHTML = `⚠️ <strong>STREFA BUBBLE:</strong> Remis daje Ci tylko <strong>${sim.chanceTie}%</strong> szans. Przy remisie ryzykujesz wypadnięciem z Top Cutu! Wygrana daje <strong>${sim.chanceWin}%</strong>.`;
        } else {
            badgeEl.className = 'verdict-badge verdict-no';
            badgeEl.innerText = `NIE (${sim.chanceTie}%)`;
            descEl.innerHTML = `🛑 <strong>REMIS NIE DAJE AWANSU:</strong> Remis to zaledwie <strong>${sim.chanceTie}%</strong> szans. Twoja jedyna droga do Top Cutu to wygrana (WIN daje <strong>${sim.chanceWin}%</strong> szans).`;
        }

        if (myOpponent && oppNoteEl) {
            if (sim.oppChanceTie >= 85) {
                oppNoteEl.innerHTML = `🤝 <strong>Rywal:</strong> ${oppName} przy remisie również awansuje (${sim.oppChanceTie}%). Zgoda na ID jest bardzo prawdopodobna!`;
            } else if (sim.oppChanceTie < 50) {
                oppNoteEl.innerHTML = `⚠️ <strong>Rywal:</strong> ${oppName} przy remisie ma tylko ${sim.oppChanceTie}% szans i prawdopodobnie odrzuci ID.`;
            } else {
                oppNoteEl.innerHTML = `ℹ️ Szansa rywala (${oppName}) po remisie: ${sim.oppChanceTie}%.`;
            }
        } else if (oppNoteEl) {
            oppNoteEl.innerHTML = '';
        }
    }
}

function renderMultiRoundScenarios(sim) {
    const wrapper = document.getElementById('multiRoundScenariosWrapper');
    const grid = document.getElementById('multiRoundScenarioGrid');
    if (!wrapper || !grid) return;

    if (sim.matchesLeft < 2) {
        wrapper.style.display = 'none';
        return;
    }

    wrapper.style.display = 'block';

    const getCardColor = (c) => c >= 80 ? '#2ecc71' : (c >= 50 ? '#f1c40f' : '#e74c3c');
    const getTag = (c) => c >= 85 ? 'Bezpieczny' : (c >= 50 ? 'Bubble' : 'Za mało');

    const cards = [
        {
            title: '2x TIE (Remisy z rzędu)',
            chance: sim.chanceDoubleTie,
            pts: sim.ptsDoubleTie,
            color: getCardColor(sim.chanceDoubleTie),
            tag: getTag(sim.chanceDoubleTie)
        },
        {
            title: '1x WIN + 1x TIE',
            chance: sim.chanceWinTie,
            pts: sim.ptsWinTie,
            color: getCardColor(sim.chanceWinTie),
            tag: getTag(sim.chanceWinTie)
        },
        {
            title: '1x WIN + 1x LOSS',
            chance: sim.chanceWinLoss,
            pts: sim.ptsWinLoss,
            color: getCardColor(sim.chanceWinLoss),
            tag: getTag(sim.chanceWinLoss)
        },
        {
            title: '1x TIE + 1x LOSS',
            chance: sim.chanceTieLoss,
            pts: sim.ptsTieLoss,
            color: getCardColor(sim.chanceTieLoss),
            tag: getTag(sim.chanceTieLoss)
        },
        {
            title: '2x WIN (Komplet)',
            chance: sim.chanceDoubleWin,
            pts: sim.ptsDoubleWin,
            color: '#2ecc71',
            tag: 'Pewny awans'
        }
    ];

    grid.innerHTML = cards.map(c => `
        <div class="scenario-card">
            <div class="scenario-title">${c.title}</div>
            <div class="scenario-chance" style="color: ${c.color};">${c.chance}%</div>
            <div class="scenario-pts">Punkty: <strong>${c.pts}</strong></div>
            <div class="scenario-tag" style="background: rgba(${c.chance >= 80 ? '46,204,113' : (c.chance >= 50 ? '241,196,15' : '231,76,60')}, 0.2); color: ${c.color};">
                ${c.tag}
            </div>
        </div>
    `).join('');
}

function runLiveTieSimulation(targetPlayer, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, currentRound, totalRounds, projectedFinalBubble) {
    const SIM_COUNT = 600;
    const targetId = targetPlayer.player.id;
    const opponentId = myOpponent?.id || null;

    let isCurrentMatchFinished = false;
    let targetFixedRoundDelta = 0;
    let opponentFixedRoundDelta = 0;

    for (const m of pairingsList) {
        const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
        const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
        if ((p1 && String(p1.id) === String(targetId)) || (p2 && String(p2.id) === String(targetId))) {
            const { score1, score2, hasScore, winnerId } = getMatchScores(m);
            const status = (m.status || m.state || "").toUpperCase();
            const isComplete = status === "COMPLETE" || status === "FINISHED" || status === "COMPLETED" || winnerId != null || hasScore;
            const isDraw = m.match_is_intentional_draw || m.match_is_unintentional_draw || status === "DRAW";
            
            if (isComplete) {
                isCurrentMatchFinished = true;
                const isP1 = (p1 && String(p1.id) === String(targetId));
                if (isDraw) {
                    targetFixedRoundDelta = 1;
                    opponentFixedRoundDelta = 1;
                } else if (score1 > score2 || (winnerId && p1 && String(p1.id) === String(winnerId))) {
                    targetFixedRoundDelta = isP1 ? 3 : 0;
                    opponentFixedRoundDelta = isP1 ? 0 : 3;
                } else if (score2 > score1 || (winnerId && p2 && String(p2.id) === String(winnerId))) {
                    targetFixedRoundDelta = isP1 ? 0 : 3;
                    opponentFixedRoundDelta = isP1 ? 3 : 0;
                }
            }
            break;
        }
    }

    const futureRoundsCount = Math.max(0, totalRounds - currentRound);
    const matchesLeft = isCurrentMatchFinished ? futureRoundsCount : (1 + futureRoundsCount);

    const roundPairingPairs = new Map();
    pairingsList.forEach(m => {
        const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
        const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
        if (p1?.id && p2?.id) {
            roundPairingPairs.set(p1.id, p2.id);
            roundPairingPairs.set(p2.id, p1.id);
        }
    });

    const basePlayers = standings.map(p => ({
        id: p.player.id,
        name: p.player.best_identifier,
        points: p.match_points,
        baseOmwp: p.opponent_match_win_percentage || 0.33,
        gwp: p.game_win_percentage || 0.33,
        activeOpponentId: roundPairingPairs.get(p.player.id) || null
    }));

    const fixedMatchDeltas = new Map();
    const liveUnfinishedMatches = [];

    pairingsList.forEach(m => {
        const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
        const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
        const id1 = p1?.id;
        const id2 = p2?.id;

        if (!isCurrentMatchFinished && (id1 === targetId || id2 === targetId)) {
            return;
        }

        const { score1, score2, hasScore, winnerId } = getMatchScores(m);
        const status = (m.status || m.state || "").toUpperCase();
        const isComplete = status === "COMPLETE" || status === "FINISHED" || status === "COMPLETED" || winnerId != null || hasScore;
        const isDraw = m.match_is_intentional_draw || m.match_is_unintentional_draw || status === "DRAW";

        if (isComplete) {
            if (isDraw) {
                if (id1) fixedMatchDeltas.set(id1, 1);
                if (id2) fixedMatchDeltas.set(id2, 1);
            } else if (score1 > score2 || (winnerId && id1 && String(id1) === String(winnerId))) {
                if (id1) fixedMatchDeltas.set(id1, 3);
                if (id2) fixedMatchDeltas.set(id2, 0);
            } else if (score2 > score1 || (winnerId && id2 && String(id2) === String(winnerId))) {
                if (id1) fixedMatchDeltas.set(id1, 0);
                if (id2) fixedMatchDeltas.set(id2, 3);
            }
        } else {
            if (id1 && id2) {
                liveUnfinishedMatches.push({ id1, id2 });
            }
        }
    });

    let tieSuccesses = 0;
    let oppTieSuccesses = 0;
    let winSuccesses = 0;
    let lossSuccesses = 0;

    let doubleTieSuccesses = 0;
    let oppDoubleTieSuccesses = 0;
    let winTieSuccesses = 0;
    let winLossSuccesses = 0;
    let tieLossSuccesses = 0;
    let doubleWinSuccesses = 0;

    for (let simIdx = 0; simIdx < SIM_COUNT; simIdx++) {
        const simBoard = basePlayers.map(p => ({
            id: p.id,
            name: p.name,
            points: p.points + (fixedMatchDeltas.get(p.id) || 0),
            baseOmwp: p.baseOmwp,
            gwp: p.gwp,
            opponents: p.activeOpponentId ? [p.activeOpponentId] : []
        }));

        liveUnfinishedMatches.forEach(m => {
            const p1 = simBoard.find(p => p.id === m.id1);
            const p2 = simBoard.find(p => p.id === m.id2);
            if (!p1 || !p2) return;

            const roll = Math.random();
            if (roll < 0.08) {
                p1.points += 1;
                p2.points += 1;
            } else if (roll < 0.54) {
                p1.points += 3;
            } else {
                p2.points += 3;
            }
            p1.opponents.push(p2.id);
            p2.opponents.push(p1.id);
        });

        let targetFutureAuto = 0;
        let oppFutureAuto = 0;

        for (let r = currentRound + 1; r <= totalRounds; r++) {
            simBoard.sort((a, b) => {
                if (b.points !== a.points) return b.points - a.points;
                return (Math.random() - 0.5);
            });

            for (let pi = 0; pi < simBoard.length; pi += 2) {
                if (pi + 1 >= simBoard.length) {
                    simBoard[pi].points += 3;
                    continue;
                }

                const p1 = simBoard[pi];
                const p2 = simBoard[pi + 1];
                p1.opponents.push(p2.id);
                p2.opponents.push(p1.id);

                const isFinalRound = (r === totalRounds);
                const bothCanID = isFinalRound && (p1.points >= projectedFinalBubble && p2.points >= projectedFinalBubble);

                const roll = Math.random();
                if (bothCanID && roll < 0.75) {
                    p1.points += 1;
                    p2.points += 1;
                } else if (roll < 0.08) {
                    p1.points += 1;
                    p2.points += 1;
                } else if (roll < 0.54) {
                    p1.points += 3;
                } else {
                    p2.points += 3;
                }
            }

            if (r > currentRound + 1) {
                const autoRollT = Math.random();
                if (autoRollT < 0.08) targetFutureAuto += 1;
                else if (autoRollT < 0.54) targetFutureAuto += 3;

                const autoRollO = Math.random();
                if (autoRollO < 0.08) oppFutureAuto += 1;
                else if (autoRollO < 0.54) oppFutureAuto += 3;
            }
        }

        simBoard.forEach(p => {
            let oppMwpSum = 0;
            p.opponents.forEach(oppId => {
                const opp = simBoard.find(o => o.id === oppId);
                if (opp) {
                    oppMwpSum += Math.max(0.3333, opp.points / (totalRounds * 3));
                } else {
                    oppMwpSum += 0.3333;
                }
            });
            const baseWeight = Math.max(1, currentRound - 1);
            p.finalOmwp = ((p.baseOmwp * baseWeight) + oppMwpSum) / (baseWeight + p.opponents.length);
        });

        const checkPlayerCut = (playerId, simPoints, simOmwp) => {
            let playersAhead = 0;
            for (const p of simBoard) {
                if (p.id === playerId) continue;
                if (p.points > simPoints) {
                    playersAhead++;
                } else if (p.points === simPoints && p.finalOmwp > simOmwp) {
                    playersAhead++;
                }
            }
            const rank = playersAhead + 1;
            if (cutRule === 'hard') {
                return rank <= cutSize;
            } else {
                const sortedPoints = simBoard.filter(p => p.id !== playerId).map(p => p.points);
                sortedPoints.push(simPoints);
                sortedPoints.sort((a, b) => b - a);
                const bubbleIdx = Math.min(cutSize - 1, sortedPoints.length - 1);
                return simPoints >= sortedPoints[bubbleIdx];
            }
        };

        const targetP = simBoard.find(p => p.id === targetId);
        const oppP = opponentId ? simBoard.find(p => p.id === opponentId) : null;
        const targetBasePts = targetPlayer.match_points + (isCurrentMatchFinished ? targetFixedRoundDelta : 0);
        const oppBasePts = oppP ? (oppP.points - (fixedMatchDeltas.get(opponentId) || 0) + (isCurrentMatchFinished ? opponentFixedRoundDelta : 0)) : 0;
        const targetOmwp = targetP?.finalOmwp || 0.5;
        const oppOmwp = oppP?.finalOmwp || 0.5;

        // 1. Scenariusz REMIS w bieżącym meczu
        const tPtsTie = targetBasePts + 1 + targetFutureAuto;
        if (checkPlayerCut(targetId, tPtsTie, targetOmwp)) tieSuccesses++;

        if (oppP) {
            const oPtsTie = oppBasePts + 1 + oppFutureAuto;
            if (checkPlayerCut(opponentId, oPtsTie, oppOmwp)) oppTieSuccesses++;
        }

        // 2. Scenariusz WYGRANA w bieżącym meczu
        const tPtsWin = targetBasePts + 3 + targetFutureAuto;
        if (checkPlayerCut(targetId, tPtsWin, targetOmwp)) winSuccesses++;

        // 3. Scenariusz PRZEGRANA w bieżącym meczu
        const tPtsLoss = targetBasePts + 0 + targetFutureAuto;
        if (checkPlayerCut(targetId, tPtsLoss, targetOmwp)) lossSuccesses++;

        // 4. Scenariusze wielorundowe (2x TIE, WIN+TIE itp.)
        if (checkPlayerCut(targetId, targetBasePts + 2 + targetFutureAuto, targetOmwp)) doubleTieSuccesses++;
        if (oppP && checkPlayerCut(opponentId, oppBasePts + 2 + oppFutureAuto, oppOmwp)) oppDoubleTieSuccesses++;

        if (checkPlayerCut(targetId, targetBasePts + 4 + targetFutureAuto, targetOmwp)) winTieSuccesses++;
        if (checkPlayerCut(targetId, targetBasePts + 3 + targetFutureAuto, targetOmwp)) winLossSuccesses++;
        if (checkPlayerCut(targetId, targetBasePts + 1 + targetFutureAuto, targetOmwp)) tieLossSuccesses++;
        if (checkPlayerCut(targetId, targetBasePts + 6 + targetFutureAuto, targetOmwp)) doubleWinSuccesses++;
    }

    const basePtsForCalc = targetPlayer.match_points + (isCurrentMatchFinished ? targetFixedRoundDelta : 0);

    return {
        matchesLeft,
        isCurrentMatchFinished,
        chanceTie: Math.round((tieSuccesses / SIM_COUNT) * 100),
        oppChanceTie: Math.round((oppTieSuccesses / SIM_COUNT) * 100),
        chanceWin: Math.round((winSuccesses / SIM_COUNT) * 100),
        chanceLoss: Math.round((lossSuccesses / SIM_COUNT) * 100),
        chanceDoubleTie: Math.round((doubleTieSuccesses / SIM_COUNT) * 100),
        oppChanceDoubleTie: Math.round((oppDoubleTieSuccesses / SIM_COUNT) * 100),
        chanceWinTie: Math.round((winTieSuccesses / SIM_COUNT) * 100),
        chanceWinLoss: Math.round((winLossSuccesses / SIM_COUNT) * 100),
        chanceTieLoss: Math.round((tieLossSuccesses / SIM_COUNT) * 100),
        chanceDoubleWin: Math.round((doubleWinSuccesses / SIM_COUNT) * 100),
        ptsDoubleTie: basePtsForCalc + 2,
        ptsWinTie: basePtsForCalc + 4,
        ptsWinLoss: basePtsForCalc + 3,
        ptsTieLoss: basePtsForCalc + 1,
        ptsDoubleWin: basePtsForCalc + 6,
        projectedBubble: projectedFinalBubble
    };
}

function updateRecommendationBanner(sim, myMatch, targetPlayer, myOpponent, activeRound, totalRounds) {
    const banner = document.getElementById('tieRecommendationBanner');
    if (!banner || !sim) return;

    const oppName = myOpponent?.name || "Twój rywal";

    if (!myOpponent) {
        if (sim.chanceTie >= 80) {
            banner.className = "recommendation-box rec-safe";
            banner.innerHTML = `🎉 <strong>PEWNY AWANS (${sim.chanceTie}%):</strong> Masz wolny los (BYE) lub jesteś bezpieczny w Top Cut!`;
        } else {
            banner.className = "recommendation-box rec-risk";
            banner.innerHTML = `⚠️ <strong>SZANSA PO REMISIE: ${sim.chanceTie}%:</strong> Gra o wygraną daje ${sim.chanceWin}%.`;
        }
        return;
    }

    if (sim.matchesLeft >= 2) {
        if (sim.chanceDoubleTie >= 85 && sim.oppChanceDoubleTie >= 85) {
            banner.className = "recommendation-box rec-safe";
            banner.innerHTML = `
                🤝 <strong>PODWÓJNY ZŁOTY REMIS (PEWNY 2x ID):</strong> Do końca fazy Swiss pozostało ${sim.matchesLeft} meczów. 
                Zarówno Ty (<strong>${sim.chanceDoubleTie}%</strong>), jak i ${oppName} (<strong>${sim.oppChanceDoubleTie}%</strong>) wchodzicie do Top Cut przy 2 remisach z rzędu! 
                <strong>Zaproponuj remis już w tej rundzie – rywal ma dokładnie taki sam interes i powinien natychmiast przyjąć ID!</strong>
            `;
            return;
        }

        if (sim.chanceDoubleTie >= 75 && sim.oppChanceDoubleTie < 50) {
            banner.className = "recommendation-box rec-warning";
            banner.innerHTML = `
                ⚠️ <strong>ASYMETRIA TABELI (RYWAL MOŻE ODRZUCIĆ ID):</strong> 2 remisy z rzędu dają Ci aż <strong>${sim.chanceDoubleTie}%</strong> awansu, 
                ale Twój rywal (${oppName}) przy 2 remisach ma tylko <strong>${sim.oppChanceDoubleTie}%</strong> szans na Cut. 
                <strong>Rywal może odmówić remisu i chcieć grać o 3 punkty!</strong> Zaproponuj ID, ale przygotuj się do twardej walki o zwycięstwo.
            `;
            return;
        }

        if (sim.chanceDoubleTie < 50 && sim.chanceWinTie >= 75) {
            banner.className = "recommendation-box rec-risk";
            banner.innerHTML = `
                🎯 <strong>2x TIE TO ZA MAŁO – POTRZEBNA 1 WYGRANA:</strong> Dwa remisy z rzędu dają tylko <strong>${sim.chanceDoubleTie}%</strong> szans. 
                Aby bezpiecznie wejść do Top Cutu, musisz w pozostałych 2 rundach wygrać przynajmniej 1 mecz (scenariusz 1x WIN + 1x TIE podnosi szanse do <strong>${sim.chanceWinTie}%</strong>). 
                Jeśli zremisujesz teraz, w następnej rundzie będziesz pod presją bezwzględnej wygranej!
            `;
            return;
        }

        if (sim.chanceDoubleWin < 40) {
            banner.className = "recommendation-box rec-danger";
            banner.innerHTML = `
                🛑 <strong>POZA ZASIĘGIEM TOP CUTU:</strong> Nawet 2 zwycięstwa z rzędu (komplet 6 punktów) dają tylko <strong>${sim.chanceDoubleWin}%</strong> szans na wejście do Cutu z powodu niskiego dorobku punktowego lub OMWP.
            `;
            return;
        }

        banner.className = "recommendation-box rec-risk";
        banner.innerHTML = `
            ⚠️ <strong>WALKA O KAŻDY PUNKT:</strong> 2 remisy dają Ci ${sim.chanceDoubleTie}% szans (rywalowi: ${sim.oppChanceDoubleTie}%). 
            Gra o wygraną w tym meczu daje ${sim.chanceWin}% szans na Cut.
        `;
        return;
    }

    // matchesLeft === 1 (Decydujący mecz / ostatnia runda)
    if (sim.chanceTie >= 85 && sim.oppChanceTie >= 85) {
        banner.className = "recommendation-box rec-safe";
        banner.innerHTML = `
            🤝 <strong>OBOPÓLNY ZŁOTY REMIS (PEWNY ID):</strong> To ostatnia runda turnieju! Matematyka jest idealna dla OBU graczy: 
            Zarówno Ty (<strong>${sim.chanceTie}%</strong>), jak i ${oppName} (<strong>${sim.oppChanceTie}%</strong>) wchodzicie do Top Cutu przy remisie. 
            <strong>Zaproponuj Intentional Draw (ID) – rywal natychmiast się zgodzi!</strong>
        `;
        return;
    }

    if (sim.chanceTie >= 70 && sim.oppChanceTie < 50) {
        banner.className = "recommendation-box rec-warning";
        banner.innerHTML = `
            ⚠️ <strong>ASYMETRIA STOŁU (RYWAL MOŻE ODRZUCIĆ ID):</strong> W tej rundzie remis daje Ci aż <strong>${sim.chanceTie}%</strong> awansu, 
            ALE Twój rywal (${oppName}) przy remisie ma zaledwie <strong>${sim.oppChanceTie}%</strong> szans na Top Cut. 
            <strong>Rywal może odrzucić propozycję ID</strong> i grać o pełną pulę (WIN). Zaproponuj remis, ale bądź przygotowany na grę o zwycięstwo!
        `;
        return;
    }

    if (sim.chanceTie < 50 && sim.oppChanceTie >= 70) {
        banner.className = "recommendation-box rec-danger";
        banner.innerHTML = `
            🛑 <strong>NIE BIERZ REMISU (${sim.chanceTie}%):</strong> Remis wyrzuca Cię z Top Cutu! 
            ${oppName} ma lepszy tiebreaker i przy remisie to on zgarnia awans (${sim.oppChanceTie}%), a Ty lądujesz pod kreską. 
            Twoja jedyna droga to gra o zwycięstwo (WIN daje <strong>${sim.chanceWin}%</strong> szans)!
        `;
        return;
    }

    if (sim.chanceTie < 50) {
        banner.className = "recommendation-box rec-danger";
        banner.innerHTML = `
            🛑 <strong>NIEOPŁACALNY REMIS (${sim.chanceTie}%):</strong> Remis zepchnie Cię poniżej progu Cutu przez zwycięzców z innych stołów. 
            Graj o wygraną (WIN daje <strong>${sim.chanceWin}%</strong> szans).
        `;
        return;
    }

    banner.className = "recommendation-box rec-risk";
    banner.innerHTML = `
        ⚠️ <strong>STREFA BUBBLE:</strong> Szansa po remisie wynosi ${sim.chanceTie}% (dla rywala: ${sim.oppChanceTie}%). 
        Obserwuj sąsiednie stoły – jeśli rywale z innych stołów przegrają swoje mecze, sytuacja może ulec poprawie.
    `;
}