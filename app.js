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
let currentLiveStatusFilter = 'all';
let currentPredictorScenario = 'WIN';
let whatIfOverrides = new Map();
let lastTrackedEventId = null;
let pairingsSearchQuery = '';
let liveTableSearchQuery = '';
let isOfficialTableCollapsed = false;

function onPairingsSearchInput() {
    const input = document.getElementById('pairingsSearchInput');
    const clearBtn = document.getElementById('pairingsSearchClearBtn');
    pairingsSearchQuery = (input?.value || '').trim().toLowerCase();
    if (clearBtn) {
        clearBtn.style.display = pairingsSearchQuery.length > 0 ? 'inline-block' : 'none';
    }
    currentPages.pairings = 1;
    renderPairingsTable();
}

function clearPairingsSearch() {
    const input = document.getElementById('pairingsSearchInput');
    const clearBtn = document.getElementById('pairingsSearchClearBtn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    pairingsSearchQuery = '';
    currentPages.pairings = 1;
    renderPairingsTable();
}

function onLiveTableSearchInput() {
    const input = document.getElementById('liveTableSearchInput');
    const clearBtn = document.getElementById('liveTableSearchClearBtn');
    liveTableSearchQuery = (input?.value || '').trim().toLowerCase();
    if (clearBtn) {
        clearBtn.style.display = liveTableSearchQuery.length > 0 ? 'inline-block' : 'none';
    }
    currentPages.live = 1;
    renderLiveStandingsTable();
}

function clearLiveTableSearch() {
    const input = document.getElementById('liveTableSearchInput');
    const clearBtn = document.getElementById('liveTableSearchClearBtn');
    if (input) input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    liveTableSearchQuery = '';
    currentPages.live = 1;
    renderLiveStandingsTable();
}

function toggleOfficialTableSection(forceCollapse = null) {
    const wrapper = document.getElementById('officialStandingsWrapper');
    const btn = document.getElementById('toggleOfficialTableBtn');
    if (!wrapper) return;
    isOfficialTableCollapsed = forceCollapse !== null ? forceCollapse : !isOfficialTableCollapsed;
    wrapper.style.display = isOfficialTableCollapsed ? 'none' : 'block';
    if (btn) {
        btn.innerText = isOfficialTableCollapsed ? 'Pokaż ▼' : 'Ukryj ▲';
    }
}

function scrollToMobileSection(sectionId, btnEl) {
    const el = document.getElementById(sectionId);
    if (!el) return;
    if (el.style.display === 'none') {
        el.style.display = 'block';
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (btnEl && typeof document !== 'undefined') {
        document.querySelectorAll('.mobile-nav-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
    }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
        if (window.innerWidth < 768) {
            toggleOfficialTableSection(true);
        }
    });
}

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
    renderTopCutBracketPanel(cachedLiveStandings, cachedCutContext.cutSize);
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

function escapeHtml(val) {
    if (val === null || val === undefined) return '';
    return String(val)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeJsAttr(val) {
    if (val === null || val === undefined) return '';
    return escapeHtml(String(val).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
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
    const rawEventId = document.getElementById('eventId')?.value || '865248';
    const eventId = String(rawEventId).replace(/\D/g, '') || '865248';
    if (lastTrackedEventId !== null && String(lastTrackedEventId) !== String(eventId)) {
        whatIfOverrides.clear();
        updateWhatIfStatusBar();
    }
    lastTrackedEventId = eventId;
    setElText('status', "Status: Pobieranie danych...");
    
    fetchData(eventId);
    if (trackingInterval) clearInterval(trackingInterval);
    trackingInterval = setInterval(() => fetchData(eventId), 20000);
}

let lastAutoCutSyncedEventId = null;

async function fetchData(eventId) {
    try {
        const safeEventId = encodeURIComponent(String(eventId).replace(/\D/g, ''));
        const response = await fetch(`api.php?eventId=${safeEventId}&t=${Date.now()}`);
        const data = await response.json();
        
        if (data.error) {
            setElText('status', "BŁĄD: " + data.error);
            return;
        }
        
        latestData = data;
        if (lastAutoCutSyncedEventId !== String(safeEventId) && data.roundsMatches) {
            const tcInfo = detectActualTopCutInfo(data.roundsMatches, data.standings?.standings || []);
            if (tcInfo.isTopCutActive && tcInfo.actualBracketSize) {
                const cutSelect = document.getElementById('cutSize');
                if (cutSelect && Array.from(cutSelect.options || []).some(o => Number(o.value) === tcInfo.actualBracketSize)) {
                    cutSelect.value = String(tcInfo.actualBracketSize);
                }
            }
            lastAutoCutSyncedEventId = String(safeEventId);
        }

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
// TRYB „WHAT-IF” (RĘCZNE SYMULOWANIE WYNIKÓW STOŁÓW LIVE)
// -------------------------------------------------------------

function getMatchWhatIfKey(match, fallbackIdx = 0) {
    const tbl = match?.table_number ?? match?.tableNumber ?? match?.id;
    if (tbl !== undefined && tbl !== null) return `T_${tbl}`;
    return `IDX_${fallbackIdx}`;
}

function getSingleMatchOutcomePoints(match, standingsMap) {
    const p1 = resolvePlayer(getMatchParticipant(match, 1), standingsMap);
    const p2 = resolvePlayer(getMatchParticipant(match, 2), standingsMap);
    const id1 = p1?.id;
    const id2 = p2?.id;
    const { score1, score2, hasScore, winnerId } = getMatchScores(match);
    const status = (match.status || match.state || "").toUpperCase();
    const isComplete = status === "COMPLETE" || status === "FINISHED" || status === "COMPLETED" || winnerId != null || hasScore;
    const isDraw = match.match_is_intentional_draw || match.match_is_unintentional_draw || status === "DRAW";

    let pts1 = 0;
    let pts2 = 0;
    if (isComplete) {
        if (isDraw) {
            pts1 = 1;
            pts2 = 1;
        } else if (score1 > score2 || (winnerId && id1 && String(id1) === String(winnerId))) {
            pts1 = 3;
            pts2 = 0;
        } else if (score2 > score1 || (winnerId && id2 && String(id2) === String(winnerId))) {
            pts1 = 0;
            pts2 = 3;
        }
    }
    return { id1, id2, pts1, pts2, isComplete, isDraw };
}

function applyWhatIfToPairings(pairingsList, overridesMap, standingsMap) {
    if (!pairingsList || !Array.isArray(pairingsList)) return [];
    if (!overridesMap || overridesMap.size === 0) return pairingsList;

    return pairingsList.map((m, idx) => {
        const key = getMatchWhatIfKey(m, idx);
        const outcome = overridesMap.get(key);
        if (!outcome) return m;

        const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
        const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);

        const clone = { ...m, _isWhatIf: true, _whatIfOutcome: outcome, status: 'COMPLETE', state: 'COMPLETE' };
        if (outcome === 'DRAW') {
            clone.match_is_intentional_draw = true;
            clone.match_is_unintentional_draw = false;
            clone.winning_player = null;
            clone.winner_id = null;
            clone.games_won_by_winner = 1;
            clone.games_won_by_loser = 1;
            clone.team_1_score = 1;
            clone.team_2_score = 1;
        } else if (outcome === 'P1_WIN') {
            clone.match_is_intentional_draw = false;
            clone.match_is_unintentional_draw = false;
            clone.winning_player = p1?.id ?? 1;
            clone.winner_id = p1?.id ?? 1;
            clone.games_won_by_winner = 2;
            clone.games_won_by_loser = 0;
            clone.team_1_score = 2;
            clone.team_2_score = 0;
        } else if (outcome === 'P2_WIN') {
            clone.match_is_intentional_draw = false;
            clone.match_is_unintentional_draw = false;
            clone.winning_player = p2?.id ?? 2;
            clone.winner_id = p2?.id ?? 2;
            clone.games_won_by_winner = 2;
            clone.games_won_by_loser = 0;
            clone.team_1_score = 0;
            clone.team_2_score = 2;
        }
        return clone;
    });
}

function computeWhatIfEffectiveData(standings, rawPairingsList, overridesMap, standingsMap, isLiveRoundInProgress) {
    const effectivePairingsList = applyWhatIfToPairings(rawPairingsList, overridesMap, standingsMap);
    if (!overridesMap || overridesMap.size === 0 || isLiveRoundInProgress) {
        return { effectiveStandings: standings, effectivePairingsList };
    }

    // Gdy runda jest już oficjalnie zamknięta (!isLiveRoundInProgress), oficjalne match_points zawierają już wynik z rawPairingsList.
    // Aby umożliwić graczowi symulację „Co by było, gdyby w ostatniej rundzie padł inny wynik na stole #X”,
    // korygujemy punkty o różnicę (nowe punkty What-If minus oryginalne punkty z meczu).
    const pointAdjustments = new Map();
    rawPairingsList.forEach((rawMatch, idx) => {
        const key = getMatchWhatIfKey(rawMatch, idx);
        if (!overridesMap.has(key)) return;
        const orig = getSingleMatchOutcomePoints(rawMatch, standingsMap);
        const sim = getSingleMatchOutcomePoints(effectivePairingsList[idx], standingsMap);
        if (orig.id1 != null) {
            pointAdjustments.set(String(orig.id1), (pointAdjustments.get(String(orig.id1)) || 0) + (sim.pts1 - orig.pts1));
        }
        if (orig.id2 != null) {
            pointAdjustments.set(String(orig.id2), (pointAdjustments.get(String(orig.id2)) || 0) + (sim.pts2 - orig.pts2));
        }
    });

    const effectiveStandings = standings.map(p => {
        const adj = pointAdjustments.get(String(p.player?.id || p.id)) || 0;
        if (adj === 0) return p;
        return {
            ...p,
            match_points: Math.max(0, (p.match_points || 0) + adj)
        };
    });

    return { effectiveStandings, effectivePairingsList };
}

function setWhatIfOverride(matchKey, outcome) {
    if (!matchKey) return;
    if (!outcome || whatIfOverrides.get(matchKey) === outcome) {
        whatIfOverrides.delete(matchKey);
    } else {
        whatIfOverrides.set(matchKey, outcome);
    }
    updateWhatIfStatusBar();
    if (latestData) {
        processPairings(latestData);
        processStandings(latestData);
        if (currentSelectedPlayerId) {
            recalculateTieForSelectedPlayer();
        }
    }
}

function clearAllWhatIfOverrides() {
    whatIfOverrides.clear();
    updateWhatIfStatusBar();
    if (latestData) {
        processPairings(latestData);
        processStandings(latestData);
        if (currentSelectedPlayerId) {
            recalculateTieForSelectedPlayer();
        }
    }
}

function updateWhatIfStatusBar() {
    const bar = document.getElementById('whatIfStatusBar');
    const countEl = document.getElementById('whatIfCountDisplay');
    if (!bar) return;
    if (whatIfOverrides.size > 0) {
        bar.style.display = 'flex';
        if (countEl) countEl.innerText = String(whatIfOverrides.size);
    } else {
        bar.style.display = 'none';
    }
}

// -------------------------------------------------------------
// TABELA MECZÓW LIVE
// -------------------------------------------------------------

function processPairings(data) {
    setElText('pairingsRoundNum', data.activeRound || "-");
    const rawPairingsList = extractPairingsList(data.pairings);
    const standingsList = data.standings?.standings || [];
    const standingsMap = buildStandingsMap(standingsList);
    const pairingsList = applyWhatIfToPairings(rawPairingsList, whatIfOverrides, standingsMap);

    cachedPairings = pairingsList;
    cachedStandingsMap = standingsMap;
    updateWhatIfStatusBar();

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
        const whatIfNote = whatIfOverrides.size > 0 ? ` (w tym ${whatIfOverrides.size} What-If)` : "";
        setElText('matchesProgress', `${completedCount}/${pairingsList.length} wpisane${whatIfNote}`);
    }

    renderPairingsTable();
}

function renderPairingsTable() {
    const tbody = document.getElementById('pairingsBody');
    if (!tbody) return;

    let list = (cachedPairings || []).map((match, origIdx) => ({ match, origIdx }));
    if (filterOnlyPoles) {
        list = list.filter(({ match }) => {
            const raw1 = getMatchParticipant(match, 1);
            const raw2 = getMatchParticipant(match, 2);
            const p1 = resolvePlayer(raw1, cachedStandingsMap);
            const p2 = resolvePlayer(raw2, cachedStandingsMap);
            return isPolishPlayer(p1, cachedStandingsMap) || (p2 && isPolishPlayer(p2, cachedStandingsMap));
        });
    }

    if (pairingsSearchQuery) {
        const q = pairingsSearchQuery.replace(/^#/, '');
        list = list.filter(({ match, origIdx }) => {
            const tableNum = String(match.table_number || match.tableNumber || (origIdx + 1)).toLowerCase();
            if (tableNum === q || `#${tableNum}`.includes(pairingsSearchQuery)) return true;
            const p1 = resolvePlayer(getMatchParticipant(match, 1), cachedStandingsMap);
            const raw2 = getMatchParticipant(match, 2);
            const p2 = raw2 ? resolvePlayer(raw2, cachedStandingsMap) : null;
            const n1 = (p1?.name || '').toLowerCase();
            const n2 = (p2?.name || '').toLowerCase();
            return n1.includes(pairingsSearchQuery) || n2.includes(pairingsSearchQuery);
        });
    }

    if (!list || list.length === 0) {
        let emptyMsg = "Oczekiwanie na wygenerowanie parowań dla tej rundy...";
        if (pairingsSearchQuery) emptyMsg = "Brak stołów lub graczy pasujących do wyszukiwania.";
        else if (filterOnlyPoles) emptyMsg = "Brak meczów z udziałem polskich graczy w tej rundzie.";
        tbody.innerHTML = `<tr><td colspan="6" style="color: #888; padding: 20px;">${emptyMsg}</td></tr>`;
        renderPagination('pairingsPagination', 0, 1, 'changePairingsPage');
        return;
    }

    const totalItems = list.length;
    const totalPages = Math.ceil(totalItems / PAGE_SIZE);
    currentPages.pairings = Math.max(1, Math.min(currentPages.pairings, totalPages));

    const start = (currentPages.pairings - 1) * PAGE_SIZE;
    const pageItems = list.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = "";

    pageItems.forEach(({ match, origIdx }) => {
        const globalIdx = origIdx;
        const tr = document.createElement('tr');
        const tableNum = match.table_number || match.tableNumber || (globalIdx + 1);
        const matchKey = getMatchWhatIfKey(match, globalIdx);
        const activeOverride = whatIfOverrides.get(matchKey) || null;
        
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
        } else if (match._isWhatIf) {
            statusBadge = `<span class="badge badge-whatif" title="Wynik ustawiony ręcznie w trybie What-If">🎛️ What-If</span>`;
            displayScore = isDraw ? `<span style="color:#f1c40f;">REMIS (ID)</span>` : `${score1} : ${score2}`;
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

        const p1Won = isComplete && !isDraw && (score1 > score2 || (winnerId && p1 && String(p1.id) === String(winnerId)));
        const p2Won = isComplete && !isDraw && (score2 > score1 || (winnerId && p2 && String(p2.id) === String(winnerId)));
        
        const p1Style = p1Won ? 'color: #2ecc71; font-weight: bold;' : '';
        const p2Style = p2Won ? 'color: #2ecc71; font-weight: bold;' : '';

        if (match._isWhatIf) {
            tr.style.background = "rgba(155, 89, 182, 0.14)";
        }

        const safeKeyAttr = escapeJsAttr(matchKey);
        const safeName1 = escapeHtml(name1);
        const safeName2 = escapeHtml(name2);
        const safeTableNum = escapeHtml(tableNum);

        const whatIfControlsHtml = isBye ? `-` : `
            <div class="whatif-btn-group">
                <button type="button" class="whatif-btn ${activeOverride === 'P1_WIN' ? 'active-w1' : ''}" title="Symuluj wygraną Gracza 1" onclick="setWhatIfOverride('${safeKeyAttr}', 'P1_WIN')">1</button>
                <button type="button" class="whatif-btn ${activeOverride === 'DRAW' ? 'active-tie' : ''}" title="Symuluj remis (ID)" onclick="setWhatIfOverride('${safeKeyAttr}', 'DRAW')">ID</button>
                <button type="button" class="whatif-btn ${activeOverride === 'P2_WIN' ? 'active-w2' : ''}" title="Symuluj wygraną Gracza 2" onclick="setWhatIfOverride('${safeKeyAttr}', 'P2_WIN')">2</button>
                ${activeOverride ? `<button type="button" class="whatif-btn whatif-reset-mini" title="Cofnij zmianę dla tego stołu" onclick="setWhatIfOverride('${safeKeyAttr}', null)">✕</button>` : ''}
            </div>
        `;

        tr.innerHTML = `
            <td><strong>#${safeTableNum}</strong></td>
            <td class="player-cell-truncate" style="${p1Style}" title="${safeName1}">${safeName1}</td>
            <td class="score-box">${displayScore}</td>
            <td class="player-cell-truncate" style="${p2Style}" title="${safeName2}">${safeName2}</td>
            <td>${statusBadge}</td>
            <td>${whatIfControlsHtml}</td>
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
    const rawStandings = data.standings?.standings || [];
    
    const activeRound = data.activeRound || 1;
    const totalRounds = Math.max(data.totalRounds || getDefaultTotalRounds(data.playerCount), activeRound);
    const standingsRound = data.standingsRound || 0;
    const isCompleted = Boolean(data.isCompleted || data.displayStatus === 'complete');

    // Sprawdzamy, czy w bieżącej rundzie mecze jeszcze trwają i nie są ujęte w oficjalnej tabeli standings.
    // W turniejach historycznych lub gdy standings zostały już wygenerowane dla bieżącej rundy (standingsRound >= activeRound),
    // oficjalne punkty w tabeli zawierają już komplet wyników – doliczanie delty zdublowałoby punkty z ostatniej rundy!
    const isLiveRoundInProgress = Boolean(activeRound > standingsRound && !isCompleted);

    setElText('eventNameDisplay', data.eventName || 'Turniej');
    setElText('totalPlayersDisplay', data.playerCount || 0);
    setElText('activeRoundInfo', `${activeRound}/${totalRounds}`);
    
    const roundsLeftCount = Math.max(0, totalRounds - activeRound);
    let roundsLeftLabel = "";
    if (isCompleted || (!isLiveRoundInProgress && roundsLeftCount === 0)) {
        roundsLeftLabel = "Turniej zakończony";
    } else if (roundsLeftCount === 0) {
        roundsLeftLabel = "Ostatnia runda!";
    } else if (roundsLeftCount === 1) {
        roundsLeftLabel = "2 z tą";
    } else {
        roundsLeftLabel = `${roundsLeftCount + 1} z tą`;
    }
    setElText('roundsLeftInfo', roundsLeftLabel);
    setElText('officialRoundNum', data.standingsRound || "-");
    
    if (!rawStandings || rawStandings.length === 0) return;

    const rawPairingsList = extractPairingsList(data.pairings);
    const standingsMap = buildStandingsMap(rawStandings);
    const { effectiveStandings: standings, effectivePairingsList: pairingsList } = computeWhatIfEffectiveData(
        rawStandings,
        rawPairingsList,
        whatIfOverrides,
        standingsMap,
        isLiveRoundInProgress
    );

    // 1. Zbieramy delty punktowe z zakończonych meczów w bieżącej rundzie (tylko gdy runda na żywo jest w toku)
    const liveScoreDeltas = new Map();
    if (isLiveRoundInProgress) {
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
    }

    // 2. Budujemy tablicę LIVE STANDINGS (bazowe punkty + punkty z zakończonych meczów bieżącej rundy)
    const liveStandings = standings.map(p => {
        const delta = liveScoreDeltas.get(String(p.player.id)) || 0;
        return {
            ...p,
            livePoints: p.match_points + delta,
            delta: delta
        };
    });

    // Sortujemy tabelę LIVE według zasad tiebreakerów Lorcany (Match Points -> OMW% -> GW% -> OGW%)
    liveStandings.sort((a, b) => {
        if (b.livePoints !== a.livePoints) return b.livePoints - a.livePoints;
        if ((b.opponent_match_win_percentage || 0) !== (a.opponent_match_win_percentage || 0)) {
            return (b.opponent_match_win_percentage || 0) - (a.opponent_match_win_percentage || 0);
        }
        if ((b.game_win_percentage || 0) !== (a.game_win_percentage || 0)) {
            return (b.game_win_percentage || 0) - (a.game_win_percentage || 0);
        }
        return (b.opponent_game_win_percentage || 0) - (a.opponent_game_win_percentage || 0);
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
        
        const simRes = runLiveTieSimulation(p, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, activeRound, totalRounds, projectedFinalBubble, isLiveRoundInProgress);
        simulatedResultsCache.set(String(p.player.id), { sim: simRes, opp: myOpponent });
    });

    // 5. Renderujemy obie tabele, analizę kreski (Cut Line Breakdown) oraz drabinkę Top Cut
    renderCutLineBreakdownPanel(liveStandings, cutSize, cutRule, activeRound, totalRounds);
    renderLiveStandingsTable(liveStandings, cutSize, cutRule, activeRound, totalRounds);
    renderOfficialStandingsTable(rawStandings, cutSize, cutRule);
    renderTopCutBracketPanel(liveStandings, cutSize);
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

    if (currentLiveStatusFilter !== 'all') {
        list = list.filter(p => {
            const cached = simulatedResultsCache.get(String(p.player.id));
            const sim = cached?.sim;
            const category = getCutStatusCategory(p, sim, ctx.cutSize);
            if (currentLiveStatusFilter === 'cut') return category === 'cut' || category === 'bubble';
            if (currentLiveStatusFilter === 'bubble') return category === 'bubble';
            return true;
        });
    }

    if (liveTableSearchQuery) {
        list = list.filter(p => {
            const formattedName = formatStandingsPlayerName(p).toLowerCase();
            return formattedName.includes(liveTableSearchQuery);
        });
    }

    if (!list || list.length === 0) {
        let emptyMsg = "Trwa symulacja wyników live...";
        if (liveTableSearchQuery) emptyMsg = "Brak graczy pasujących do wyszukiwanej frazy.";
        else if (filterOnlyPoles) emptyMsg = "Brak graczy z Polski w tabeli LIVE.";
        else if (currentLiveStatusFilter !== 'all') emptyMsg = "Brak graczy pasujących do wybranego filtra statusu.";

        tbody.innerHTML = `<tr><td colspan="7" style="color: #888; padding: 20px;">${emptyMsg}</td></tr>`;
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
        const ogwp = ((player.opponent_game_win_percentage || 0) * 100).toFixed(1) + "%";
        
        const cached = simulatedResultsCache.get(String(player.player.id));
        const sim = cached?.sim;
        
        const inCut = (displayRank <= ctx.cutSize);
        const { ptsNeededText, strategyText, rowClass } = derivePlayerStrategy(sim, inCut);
        
        const cutBadgeHtml = getCutStatusBadge(player, sim, inCut, ctx.cutSize, sim?.matchesLeft ?? 0);

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

        const safeName = escapeHtml(formattedName);
        const safePlayerId = escapeJsAttr(player.player.id);

        tr.innerHTML = `
            <td><strong>${displayRank}</strong></td>
            <td class="player-cell-truncate" style="text-align: left;" title="${safeName}"><strong>${safeName}</strong></td>
            <td>${pointsDisplay}</td>
            <td class="tiebreaker omwp-clickable" title="Kliknij, aby otworzyć Inspektora Tiebreakerów (OMW% / GW% / OGW%)" onclick="event.stopPropagation(); openOmwpInspector('${safePlayerId}')">${omwp} / ${gwp} / ${ogwp} 🔍</td>
            <td><strong>${ptsNeededText}</strong></td>
            <td class="strategy">${strategyText}</td>
            <td>${cutBadgeHtml}</td>
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
        const safeName = escapeHtml(formattedName);
        const safePlayerId = escapeJsAttr(player.player.id);
        const safeRecord = escapeHtml(player.record || player.match_record || "-");
        const omwp = ((player.opponent_match_win_percentage || 0) * 100).toFixed(1) + "%";
        const gwp = ((player.game_win_percentage || 0) * 100).toFixed(1) + "%";
        const ogwp = ((player.opponent_game_win_percentage || 0) * 100).toFixed(1) + "%";
        
        const inCut = ctx.cutRule === 'soft' 
            ? player.match_points >= bubbleScore 
            : (displayRank <= ctx.cutSize);

        tr.className = inCut ? "safe" : (player.match_points >= bubbleScore ? "bubble" : "dead");
        tr.innerHTML = `
            <td>${displayRank}</td>
            <td class="player-cell-truncate" style="text-align: left;" title="${safeName}">${safeName}</td>
            <td><strong>${player.match_points}</strong></td>
            <td>${safeRecord}</td>
            <td class="tiebreaker omwp-clickable" title="Kliknij, aby otworzyć Inspektora Tiebreakerów (OMW% / GW% / OGW%)" onclick="openOmwpInspector('${safePlayerId}')">${omwp} / ${gwp} / ${ogwp} 🔍</td>
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

    const rawStandings = latestData.standings.standings;
    const activeRound = latestData.activeRound || 1;
    const totalRounds = Math.max(latestData.totalRounds || getDefaultTotalRounds(latestData.playerCount), activeRound);

    const cutSize = parseInt(document.getElementById('cutSize')?.value || '4');
    const cutRule = document.getElementById('cutRule')?.value || 'hard';

    const isCompleted = Boolean(latestData.isCompleted || latestData.displayStatus === 'complete');
    const isLiveRoundInProgress = Boolean(activeRound > (latestData.standingsRound || 0) && !isCompleted);

    const rawPairingsList = extractPairingsList(latestData.pairings);
    const standingsMap = buildStandingsMap(rawStandings);
    const { effectiveStandings: standings, effectivePairingsList: pairingsList } = computeWhatIfEffectiveData(
        rawStandings,
        rawPairingsList,
        whatIfOverrides,
        standingsMap,
        isLiveRoundInProgress
    );

    const targetPlayer = standings.find(p => String(p.player?.id || p.id) === String(currentSelectedPlayerId));
    if (!targetPlayer) return;
    
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

    const simResults = runLiveTieSimulation(targetPlayer, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, activeRound, totalRounds, projectedFinalBubble, isLiveRoundInProgress);

    const formattedName = formatStandingsPlayerName(targetPlayer);
    setElText('selectedPlayerName', formattedName);
    setElText('selectedPlayerTable', myMatch ? `(Stół #${myMatch.table_number || myMatch.tableNumber || '?'} vs ${myOpponent?.name || 'BYE'})` : "");
    const baseOmw = ((targetPlayer.opponent_match_win_percentage || 0) * 100).toFixed(1);
    const baseGw = ((targetPlayer.game_win_percentage || 0) * 100).toFixed(1);
    const baseOgw = ((targetPlayer.opponent_game_win_percentage || 0) * 100).toFixed(1);
    setElText('selectedPlayerBaseStats', `Stan bazowy: ${targetPlayer.match_points} pkt | OMW: ${baseOmw}% | GW: ${baseGw}% | OGW: ${baseOgw}%`);

    // 1. Pasek kontekstu rundy
    const tieRoundContextEl = document.getElementById('tieRoundContext');
    if (tieRoundContextEl) {
        if (simResults.matchesLeft === 0) {
            tieRoundContextEl.innerHTML = `
                <span class="round-pill">🎯 Wszystkie rundy rozegrane (${totalRounds}/${totalRounds})</span>
                <span class="round-pill" style="background: rgba(46, 204, 113, 0.2); color: #2ecc71; border-color: #2ecc71;">🏆 Turniej / Faza Swiss zakończona</span>
            `;
        } else {
            let matchStatePill = "";
            if (simResults.isCurrentMatchFinished) {
                matchStatePill = `<span style="color: #2ecc71;">✅ Twój mecz w R${activeRound} jest zakończony${myMatch?._isWhatIf ? ' (What-If)' : ''}.</span>`;
            } else if (myMatch) {
                const safeTbl = escapeHtml(myMatch.table_number || myMatch.tableNumber || '?');
                const safeOpp = escapeHtml(myOpponent?.name || 'BYE');
                matchStatePill = `<span>⚔️ Stół #${safeTbl} vs <strong>${safeOpp}</strong></span>`;
            }
            
            let roundWord = simResults.matchesLeft === 1 ? 'mecz' : (simResults.matchesLeft >= 2 && simResults.matchesLeft <= 4 ? 'mecze' : 'meczów');
            tieRoundContextEl.innerHTML = `
                <span class="round-pill">🎯 Runda ${activeRound} z ${totalRounds}</span>
                <span class="round-pill">⏳ Pozostało do rozegrania: ${simResults.matchesLeft} ${roundWord}</span>
                ${matchStatePill}
            `;
        }
    }

    // Widoczność sekcji scenariuszy bieżącego meczu (ukrywamy, gdy faza Swiss jest zakończona)
    const currentMatchScenariosWrapper = document.getElementById('currentMatchScenariosWrapper');
    if (currentMatchScenariosWrapper) {
        currentMatchScenariosWrapper.style.display = simResults.matchesLeft === 0 ? 'none' : 'block';
    }

    // 2. Podpowiedź: Czy 2 remisy z rzędu dają Top Cut?
    renderDoubleTiePrompt(simResults, targetPlayer, myOpponent, totalRounds);

    // 3. Ścieżki awansu (Scenariusze wielorundowe)
    renderMultiRoundScenarios(simResults);

    // 4. Scenariusze dla obecnego pojedynczego meczu
    const currentMatchBasePts = targetPlayer.match_points;
    setElText('tieCurrentRoundNum', activeRound);
    setElText('chanceTieDisplay', simResults.chanceTie + "%");
    setElText('ptsTieDisplay', `Pkt po TIE: ${currentMatchBasePts + 1}`);
    setElText('oppTieChanceDisplay', myOpponent ? `Rywal po TIE: ${simResults.oppChanceTie}%` : `Brak rywala`);
    
    setElText('chanceWinDisplay', simResults.chanceWin + "%");
    setElText('ptsWinDisplay', `Pkt po WIN: ${currentMatchBasePts + 3}`);
    
    setElText('chanceLossDisplay', simResults.chanceLoss + "%");
    setElText('ptsLossDisplay', `Pkt po LOSS: ${currentMatchBasePts}`);

    // 5. Główny baner z poradą taktyczną
    updateRecommendationBanner(simResults, myMatch, targetPlayer, myOpponent, activeRound, totalRounds);

    // 6. Rozstawienie (Seeding) i przywilej Play/Draw w Top Cut
    renderPlayDrawSeedingPanel(targetPlayer, myOpponent, simResults.isCurrentMatchFinished, cachedLiveStandings, cutSize);

    // 7. Sąsiednie stoły Bubble (Szybki What-If)
    renderBubbleNeighborsWhatIf(targetPlayer, pairingsList, standingsMap, cutSize);

    // 8. Odświeżenie podświetlenia w Drabince Top Cut
    renderTopCutBracketPanel(cachedLiveStandings, cutSize);

    // 9. Symulator parowań na następną rundę
    recalculateNextRoundPairingsPredictor(simResults, targetPlayer, activeRound, totalRounds);
}

function renderDoubleTiePrompt(sim, targetPlayer, myOpponent, totalRounds) {
    const panel = document.getElementById('doubleTiePromptPanel');
    const titleEl = document.getElementById('doubleTiePromptTitle');
    const badgeEl = document.getElementById('doubleTieVerdictBadge');
    const descEl = document.getElementById('doubleTiePromptDesc');
    const oppNoteEl = document.getElementById('doubleTieOpponentNote');
    if (!panel || !badgeEl || !descEl) return;

    if (!sim || sim.matchesLeft === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    const oppName = escapeHtml(myOpponent?.name || "Twój rywal");

    if (sim.matchesLeft >= 3) {
        if (titleEl) titleEl.innerText = "🤝 Plan na 3 mecze: Czy ID / 1x WIN + 2x ID dają mi Top Cut?";

        if (sim.chanceTripleTie >= 90) {
            badgeEl.className = 'verdict-badge verdict-yes';
            badgeEl.innerText = `3x ID PEWNE (${sim.chanceTripleTie}%)`;
            descEl.innerHTML = `🎉 <strong>PEWNY AWANS (3x ID):</strong> Nawet 3 remisy z rzędu dadzą Ci łącznie <strong>${sim.ptsTripleTie} pkt</strong> (próg Cutu: ok. <strong>${sim.projectedBubble} pkt</strong>), co oznacza <strong>${sim.chanceTripleTie}%</strong> szans na awans!`;
        } else if (sim.chanceWinDoubleTie >= 80) {
            badgeEl.className = 'verdict-badge verdict-yes';
            badgeEl.innerText = `1x W + 2x ID (${sim.chanceWinDoubleTie}%)`;
            descEl.innerHTML = `🎯 <strong>OPTYMALNA ŚCIEŻKA (1x WIN + 2x TIE):</strong> 3 remisy to za mało (${sim.chanceTripleTie}%), ale wystarczy <strong>1 wygrana i 2 remisy</strong> (łącznie <strong>${sim.ptsWinDoubleTie} pkt</strong>), aby mieć aż <strong>${sim.chanceWinDoubleTie}%</strong> szans na Top Cut!`;
        } else if (sim.chanceTwoWinLoss >= 75) {
            badgeEl.className = 'verdict-badge verdict-maybe';
            badgeEl.innerText = `2x W + 1x L (${sim.chanceTwoWinLoss}%)`;
            descEl.innerHTML = `⚡ <strong>DOBRE TIEBREAKERY PRACUJĄ NA CIEBIE:</strong> Bilans <strong>2-1 (2x WIN + 1x LOSS = ${sim.ptsTwoWinLoss} pkt)</strong> daje Ci aż <strong>${sim.chanceTwoWinLoss}%</strong> szans na Top Cut dzięki wysokiemu OMWP. Z kolei 2x WIN + 1x ID daje <strong>${sim.chanceTwoWinTie}%</strong>.`;
        } else if (sim.chanceTwoWinTie >= 75) {
            badgeEl.className = 'verdict-badge verdict-bubble';
            badgeEl.innerText = `WYMAGA 2x W + 1x ID (${sim.chanceTwoWinTie}%)`;
            descEl.innerHTML = `⚠️ <strong>UWAGA NA NISKIE OMWP (SUBMARINE):</strong> Sam bilans 2-1 (${sim.ptsTwoWinLoss} pkt) daje tylko <strong>${sim.chanceTwoWinLoss}%</strong> szans przez słabsze tiebreakery. Aby pewnie wejść do Top Cutu bez oglądania się na OMWP, celuj w <strong>2x WIN + 1x TIE (${sim.ptsTwoWinTie} pkt, ${sim.chanceTwoWinTie}%)</strong>!`;
        } else if (sim.chanceTripleWin >= 40) {
            badgeEl.className = 'verdict-badge verdict-no';
            badgeEl.innerText = `TYLKO 3x WIN (${sim.chanceTripleWin}%)`;
            descEl.innerHTML = `🛑 <strong>KONIECZNY KOMPLET 3 ZWYCIĘSTW:</strong> Każda strata punktów zamyka drogę do Cutu (2x W + 1x T daje tylko ${sim.chanceTwoWinTie}%). Musisz wygrać wszystkie 3 pozostałe mecze (<strong>${sim.ptsTripleWin} pkt</strong> -> <strong>${sim.chanceTripleWin}%</strong> szans).`;
        } else {
            badgeEl.className = 'verdict-badge verdict-no';
            badgeEl.innerText = `POZA ZASIĘGIEM (${sim.chanceTripleWin}%)`;
            descEl.innerHTML = `🛑 <strong>BRAK SZANS NA CUT:</strong> Nawet komplet 3 zwycięstw z rzędu (${sim.ptsTripleWin} pkt) daje tylko <strong>${sim.chanceTripleWin}%</strong> szans (próg: ok. ${sim.projectedBubble} pkt).`;
        }

        if (myOpponent && oppNoteEl) {
            oppNoteEl.innerHTML = `ℹ️ Szansa rywala (${oppName}) przy 1x WIN + 2x TIE: <strong>${sim.oppChanceWinDoubleTie}%</strong> (przy 3x TIE: <strong>${sim.oppChanceTripleTie}%</strong>).`;
        } else if (oppNoteEl) {
            oppNoteEl.innerHTML = '';
        }
    } else if (sim.matchesLeft === 2) {
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

    const cards = sim.matchesLeft >= 3 ? [
        {
            title: '3x TIE (3x ID)',
            chance: sim.chanceTripleTie,
            pts: sim.ptsTripleTie,
            color: getCardColor(sim.chanceTripleTie),
            tag: getTag(sim.chanceTripleTie)
        },
        {
            title: '1x WIN + 2x TIE',
            chance: sim.chanceWinDoubleTie,
            pts: sim.ptsWinDoubleTie,
            color: getCardColor(sim.chanceWinDoubleTie),
            tag: getTag(sim.chanceWinDoubleTie)
        },
        {
            title: '2x WIN + 1x LOSS',
            chance: sim.chanceTwoWinLoss,
            pts: sim.ptsTwoWinLoss,
            color: getCardColor(sim.chanceTwoWinLoss),
            tag: getTag(sim.chanceTwoWinLoss)
        },
        {
            title: '2x WIN + 1x TIE',
            chance: sim.chanceTwoWinTie,
            pts: sim.ptsTwoWinTie,
            color: getCardColor(sim.chanceTwoWinTie),
            tag: getTag(sim.chanceTwoWinTie)
        },
        {
            title: '3x WIN (Komplet)',
            chance: sim.chanceTripleWin,
            pts: sim.ptsTripleWin,
            color: getCardColor(sim.chanceTripleWin),
            tag: getTag(sim.chanceTripleWin)
        }
    ] : [
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
            color: getCardColor(sim.chanceDoubleWin),
            tag: getTag(sim.chanceDoubleWin)
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

function runLiveTieSimulation(targetPlayer, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, currentRound, totalRounds, projectedFinalBubble, isLiveRoundInProgress = true) {
    const SIM_COUNT = 600;
    const targetId = targetPlayer.player.id;
    const opponentId = myOpponent?.id || null;

    let isCurrentMatchFinished = !isLiveRoundInProgress;
    let targetFixedRoundDelta = 0;
    let opponentFixedRoundDelta = 0;
    const fixedMatchDeltas = new Map();
    const liveUnfinishedMatches = [];
    const completedRoundOpponents = new Map();

    // Jeśli runda na żywo jest w toku, sprawdzamy status trwających stołów i doliczamy delty punktowe
    if (isLiveRoundInProgress) {
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
        ogwp: p.opponent_game_win_percentage || 0.33,
        activeOpponentId: roundPairingPairs.get(p.player.id) || null
    }));

    if (isLiveRoundInProgress) {
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
                if (id1 && id2) {
                    completedRoundOpponents.set(id1, id2);
                    completedRoundOpponents.set(id2, id1);
                }
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
    }

    const oppBasePlayer = opponentId ? basePlayers.find(p => p.id === opponentId) : null;
    const targetBasePts = targetPlayer.match_points + (isCurrentMatchFinished ? targetFixedRoundDelta : 0);
    const oppBasePts = oppBasePlayer ? (oppBasePlayer.points + (isCurrentMatchFinished ? opponentFixedRoundDelta : 0)) : 0;

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

    let tripleTieSuccesses = 0;
    let oppTripleTieSuccesses = 0;
    let winDoubleTieSuccesses = 0;
    let oppWinDoubleTieSuccesses = 0;
    let winTieLossSuccesses = 0;
    let twoWinLossSuccesses = 0;
    let twoWinTieSuccesses = 0;
    let tripleWinSuccesses = 0;

    let simBubbleSum = 0;

    const rollSingleMatchPts = () => {
        const r = Math.random();
        if (r < 0.08) return 1;
        if (r < 0.54) return 3;
        return 0;
    };

    for (let simIdx = 0; simIdx < SIM_COUNT; simIdx++) {
        const simBoard = basePlayers.map(p => {
            const completedOpp = completedRoundOpponents.get(p.id);
            return {
                id: p.id,
                name: p.name,
                points: p.points + (fixedMatchDeltas.get(p.id) || 0),
                baseOmwp: p.baseOmwp,
                gwp: p.gwp,
                ogwp: p.ogwp,
                opponents: completedOpp ? [completedOpp] : []
            };
        });

        const boardMap = new Map();
        simBoard.forEach(p => boardMap.set(p.id, p));

        liveUnfinishedMatches.forEach(m => {
            const p1 = boardMap.get(m.id1);
            const p2 = boardMap.get(m.id2);
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

        for (let r = currentRound + 1; r <= totalRounds; r++) {
            simBoard.sort((a, b) => {
                if (b.points !== a.points) return b.points - a.points;
                return (Math.random() - 0.5);
            });

            const isFinalRound = (r === totalRounds);
            const currentBubbleBeforeRound = simBoard[Math.min(cutSize - 1, simBoard.length - 1)]?.points || projectedFinalBubble;

            for (let pi = 0; pi < simBoard.length; pi += 2) {
                if (pi + 1 >= simBoard.length) {
                    simBoard[pi].points += 3;
                    continue;
                }

                const p1 = simBoard[pi];
                const p2 = simBoard[pi + 1];
                p1.opponents.push(p2.id);
                p2.opponents.push(p1.id);

                const bothCanID = isFinalRound && (p1.points > currentBubbleBeforeRound && p2.points > currentBubbleBeforeRound);

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
        }

        // Niezależne rzuty na kolejne mecze po 1., 2. i 3. zaplanowanym meczu
        let targetAutoAfter1 = 0;
        let oppAutoAfter1 = 0;
        let targetAutoAfter2 = 0;
        let oppAutoAfter2 = 0;
        let targetAutoAfter3 = 0;
        let oppAutoAfter3 = 0;

        for (let mIdx = 1; mIdx < matchesLeft; mIdx++) {
            const tRoll = rollSingleMatchPts();
            const oRoll = rollSingleMatchPts();
            targetAutoAfter1 += tRoll;
            oppAutoAfter1 += oRoll;
            if (mIdx >= 2) {
                targetAutoAfter2 += tRoll;
                oppAutoAfter2 += oRoll;
            }
            if (mIdx >= 3) {
                targetAutoAfter3 += tRoll;
                oppAutoAfter3 += oRoll;
            }
        }

        const baseWeight = Math.max(1, totalRounds - matchesLeft);
        simBoard.forEach(p => {
            let oppMwpSum = 0;
            p.opponents.forEach(oppId => {
                const opp = boardMap.get(oppId);
                if (opp) {
                    oppMwpSum += Math.max(0.3333, opp.points / (totalRounds * 3));
                } else {
                    oppMwpSum += 0.3333;
                }
            });
            p.finalOmwp = ((p.baseOmwp * baseWeight) + oppMwpSum) / (baseWeight + p.opponents.length);
        });

        const sortedEndPts = simBoard.map(p => p.points).sort((a, b) => b - a);
        simBubbleSum += sortedEndPts[Math.min(cutSize - 1, sortedEndPts.length - 1)] || 0;

        const checkPlayerCut = (playerId, simPoints, simOmwp, simGwp, simOgwp, correlatedOppId = null, correlatedOppPts = undefined) => {
            let playersAhead = 0;
            for (const p of simBoard) {
                if (p.id === playerId) continue;
                const pPts = (correlatedOppId && p.id === correlatedOppId && correlatedOppPts !== undefined) ? correlatedOppPts : p.points;
                if (pPts > simPoints) {
                    playersAhead++;
                } else if (pPts === simPoints) {
                    if (p.finalOmwp > simOmwp) {
                        playersAhead++;
                    } else if (p.finalOmwp === simOmwp) {
                        if ((p.gwp || 0) > (simGwp || 0)) {
                            playersAhead++;
                        } else if ((p.gwp || 0) === (simGwp || 0)) {
                            if ((p.ogwp || 0) > (simOgwp || 0)) {
                                playersAhead++;
                            }
                        }
                    }
                }
            }
            const rank = playersAhead + 1;
            if (cutRule === 'hard') {
                return rank <= cutSize;
            } else {
                const sortedPoints = [];
                for (const p of simBoard) {
                    if (p.id === playerId) continue;
                    const pPts = (correlatedOppId && p.id === correlatedOppId && correlatedOppPts !== undefined) ? correlatedOppPts : p.points;
                    sortedPoints.push(pPts);
                }
                sortedPoints.push(simPoints);
                sortedPoints.sort((a, b) => b - a);
                const bubbleIdx = Math.min(cutSize - 1, sortedPoints.length - 1);
                return simPoints >= sortedPoints[bubbleIdx];
            }
        };

        const targetP = boardMap.get(targetId);
        const oppP = opponentId ? boardMap.get(opponentId) : null;
        const targetOmwp = targetP?.finalOmwp || 0.5;
        const oppOmwp = oppP?.finalOmwp || 0.5;
        const targetGwp = targetP?.gwp || 0.33;
        const oppGwp = oppP?.gwp || 0.33;
        const targetOgwp = targetP?.ogwp || 0.33;
        const oppOgwp = oppP?.ogwp || 0.33;

        const corrOppId = (!isCurrentMatchFinished && opponentId) ? opponentId : null;
        const corrTargetId = (!isCurrentMatchFinished && opponentId) ? targetId : null;

        // 1. Scenariusz REMIS w bieżącym meczu
        const tPtsTie = targetBasePts + 1 + targetAutoAfter1;
        const oPtsTie = oppBasePts + 1 + oppAutoAfter1;
        if (checkPlayerCut(targetId, tPtsTie, targetOmwp, targetGwp, targetOgwp, corrOppId, oPtsTie)) tieSuccesses++;

        if (oppP) {
            if (checkPlayerCut(opponentId, oPtsTie, oppOmwp, oppGwp, oppOgwp, corrTargetId, tPtsTie)) oppTieSuccesses++;
        }

        // 2. Scenariusz WYGRANA w bieżącym meczu (rywal przegrywa bieżący mecz)
        const tPtsWin = targetBasePts + 3 + targetAutoAfter1;
        const oPtsWhenTargetWins = oppBasePts + 0 + oppAutoAfter1;
        if (checkPlayerCut(targetId, tPtsWin, targetOmwp, targetGwp, targetOgwp, corrOppId, oPtsWhenTargetWins)) winSuccesses++;

        // 3. Scenariusz PRZEGRANA w bieżącym meczu (rywal wygrywa bieżący mecz)
        const tPtsLoss = targetBasePts + 0 + targetAutoAfter1;
        const oPtsWhenTargetLoses = oppBasePts + 3 + oppAutoAfter1;
        if (checkPlayerCut(targetId, tPtsLoss, targetOmwp, targetGwp, targetOgwp, corrOppId, oPtsWhenTargetLoses)) lossSuccesses++;

        // 4. Scenariusze 2-meczowe (2x TIE, WIN+TIE, WIN+LOSS, TIE+LOSS, 2x WIN)
        const tPts2Tie = targetBasePts + 2 + targetAutoAfter2;
        const oPts2Tie = oppBasePts + 2 + oppAutoAfter2;
        if (checkPlayerCut(targetId, tPts2Tie, targetOmwp, targetGwp, targetOgwp, corrOppId, oPts2Tie)) doubleTieSuccesses++;
        if (oppP && checkPlayerCut(opponentId, oPts2Tie, oppOmwp, oppGwp, oppOgwp, corrTargetId, tPts2Tie)) oppDoubleTieSuccesses++;

        if (checkPlayerCut(targetId, targetBasePts + 4 + targetAutoAfter2, targetOmwp, targetGwp, targetOgwp)) winTieSuccesses++;
        if (checkPlayerCut(targetId, targetBasePts + 3 + targetAutoAfter2, targetOmwp, targetGwp, targetOgwp)) winLossSuccesses++;
        if (checkPlayerCut(targetId, targetBasePts + 1 + targetAutoAfter2, targetOmwp, targetGwp, targetOgwp)) tieLossSuccesses++;
        if (checkPlayerCut(targetId, targetBasePts + 6 + targetAutoAfter2, targetOmwp, targetGwp, targetOgwp)) doubleWinSuccesses++;

        // 5. Scenariusze 3-meczowe (dla dużych turniejów DLC, gdy pozostały 3 rundy)
        const tPts3Tie = targetBasePts + 3 + targetAutoAfter3;
        const oPts3Tie = oppBasePts + 3 + oppAutoAfter3;
        if (checkPlayerCut(targetId, tPts3Tie, targetOmwp, targetGwp, targetOgwp, corrOppId, oPts3Tie)) tripleTieSuccesses++;
        if (oppP && checkPlayerCut(opponentId, oPts3Tie, oppOmwp, oppGwp, oppOgwp, corrTargetId, tPts3Tie)) oppTripleTieSuccesses++;

        const tPtsWin2Tie = targetBasePts + 5 + targetAutoAfter3;
        const oPtsWin2Tie = oppBasePts + 5 + oppAutoAfter3;
        if (checkPlayerCut(targetId, tPtsWin2Tie, targetOmwp, targetGwp, targetOgwp)) winDoubleTieSuccesses++;
        if (oppP && checkPlayerCut(opponentId, oPtsWin2Tie, oppOmwp, oppGwp, oppOgwp)) oppWinDoubleTieSuccesses++;

        if (checkPlayerCut(targetId, targetBasePts + 4 + targetAutoAfter3, targetOmwp, targetGwp, targetOgwp)) winTieLossSuccesses++;
        if (checkPlayerCut(targetId, targetBasePts + 6 + targetAutoAfter3, targetOmwp, targetGwp, targetOgwp)) twoWinLossSuccesses++;
        if (checkPlayerCut(targetId, targetBasePts + 7 + targetAutoAfter3, targetOmwp, targetGwp, targetOgwp)) twoWinTieSuccesses++;
        if (checkPlayerCut(targetId, targetBasePts + 9 + targetAutoAfter3, targetOmwp, targetGwp, targetOgwp)) tripleWinSuccesses++;
    }

    const basePtsForCalc = targetBasePts;
    const simProjectedBubble = simBubbleSum > 0 ? Math.round(simBubbleSum / SIM_COUNT) : projectedFinalBubble;

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
        chanceTripleTie: Math.round((tripleTieSuccesses / SIM_COUNT) * 100),
        oppChanceTripleTie: Math.round((oppTripleTieSuccesses / SIM_COUNT) * 100),
        chanceWinDoubleTie: Math.round((winDoubleTieSuccesses / SIM_COUNT) * 100),
        oppChanceWinDoubleTie: Math.round((oppWinDoubleTieSuccesses / SIM_COUNT) * 100),
        chanceWinTieLoss: Math.round((winTieLossSuccesses / SIM_COUNT) * 100),
        chanceTwoWinLoss: Math.round((twoWinLossSuccesses / SIM_COUNT) * 100),
        chanceTwoWinTie: Math.round((twoWinTieSuccesses / SIM_COUNT) * 100),
        chanceTripleWin: Math.round((tripleWinSuccesses / SIM_COUNT) * 100),
        ptsDoubleTie: basePtsForCalc + 2,
        ptsWinTie: basePtsForCalc + 4,
        ptsWinLoss: basePtsForCalc + 3,
        ptsTieLoss: basePtsForCalc + 1,
        ptsDoubleWin: basePtsForCalc + 6,
        ptsTripleTie: basePtsForCalc + 3,
        ptsWinDoubleTie: basePtsForCalc + 5,
        ptsWinTieLoss: basePtsForCalc + 4,
        ptsTwoWinLoss: basePtsForCalc + 6,
        ptsTwoWinTie: basePtsForCalc + 7,
        ptsTripleWin: basePtsForCalc + 9,
        projectedBubble: simProjectedBubble
    };
}

function updateRecommendationBanner(sim, myMatch, targetPlayer, myOpponent, activeRound, totalRounds) {
    const banner = document.getElementById('tieRecommendationBanner');
    if (!banner || !sim) return;

    if (sim.matchesLeft === 0) {
        const cutSize = cachedCutContext.cutSize || 4;
        const rank = targetPlayer.liveRank || targetPlayer.rank || 999;
        const inCut = rank <= cutSize;
        if (inCut) {
            banner.className = "recommendation-box rec-safe";
            banner.innerHTML = `🏆 <strong>TURNIEJ ZAKOŃCZONY:</strong> Faza Swiss dobiegła końca. Gracz zakwalifikował się do Top Cut (miejsce #${rank}) z dorobkiem <strong>${targetPlayer.livePoints || targetPlayer.match_points} pkt</strong>!`;
        } else {
            banner.className = "recommendation-box rec-danger";
            banner.innerHTML = `🏁 <strong>TURNIEJ ZAKOŃCZONY:</strong> Faza Swiss dobiegła końca. Gracz ukończył turniej na miejscu #${rank} (<strong>${targetPlayer.livePoints || targetPlayer.match_points} pkt</strong>) poza strefą Top Cut.`;
        }
        return;
    }

    const oppName = escapeHtml(myOpponent?.name || "Twój rywal");

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

    if (sim.matchesLeft >= 3) {
        if (sim.chanceTripleTie >= 85 && sim.oppChanceTripleTie >= 85) {
            banner.className = "recommendation-box rec-safe";
            banner.innerHTML = `
                🤝 <strong>POTRÓJNY ZŁOTY REMIS (PEWNY 3x ID):</strong> Do końca fazy Swiss pozostały ${sim.matchesLeft} mecze. 
                Zarówno Ty (<strong>${sim.chanceTripleTie}%</strong>), jak i ${oppName} (<strong>${sim.oppChanceTripleTie}%</strong>) wchodzicie do Top Cut przy 3 remisach z rzędu!
            `;
            return;
        }
        if (sim.chanceWinDoubleTie >= 80) {
            banner.className = "recommendation-box rec-safe";
            banner.innerHTML = `
                🎯 <strong>PLAN NA 3 RUNDY: WYSTARCZY 1x WIN + 2x ID (${sim.chanceWinDoubleTie}%):</strong> 3 remisy dają tylko <strong>${sim.chanceTripleTie}%</strong>, 
                ale wygranie 1 meczu i wzięcie 2 remisów (${sim.ptsWinDoubleTie} pkt) gwarantuje Ci bezpieczny awans do Top Cutu!
            `;
            return;
        }
        if (sim.chanceTwoWinLoss >= 75) {
            banner.className = "recommendation-box rec-risk";
            banner.innerHTML = `
                ⚡ <strong>CELUJ W 2x WIN + 1x LOSS (${sim.chanceTwoWinLoss}%):</strong> Dzięki świetnym tiebreakerom (OMWP) bilans 2-1 w ostatnich 3 rundach (${sim.ptsTwoWinLoss} pkt) daje Ci aż <strong>${sim.chanceTwoWinLoss}%</strong> szans na Cut!
            `;
            return;
        }
        if (sim.chanceTwoWinTie >= 75) {
            banner.className = "recommendation-box rec-warning";
            banner.innerHTML = `
                ⚠️ <strong>NISKIE OMWP – CELUJ W 2x WIN + 1x ID (${sim.chanceTwoWinTie}%):</strong> Przy bilansie 2-1 (${sim.ptsTwoWinLoss} pkt) Twoje OMWP daje tylko <strong>${sim.chanceTwoWinLoss}%</strong> szans. 
                Potrzebujesz 2 zwycięstw i 1 remisu (${sim.ptsTwoWinTie} pkt), aby bezpiecznie przeskoczyć próg bubble!
            `;
            return;
        }
        if (sim.chanceTripleWin >= 40) {
            banner.className = "recommendation-box rec-danger";
            banner.innerHTML = `
                🛑 <strong>MUST WIN OUT (3x WIN = ${sim.chanceTripleWin}%):</strong> Nie masz już marginesu błędu – musisz wygrać wszystkie 3 pozostałe mecze (${sim.ptsTripleWin} pkt), aby wejść do Top Cutu.
            `;
            return;
        }
        banner.className = "recommendation-box rec-danger";
        banner.innerHTML = `
            🛑 <strong>POZA ZASIĘGIEM TOP CUTU:</strong> Nawet komplet 3 zwycięstw z rzędu (${sim.ptsTripleWin} pkt) daje zaledwie <strong>${sim.chanceTripleWin}%</strong> szans na awans.
        `;
        return;
    }

    if (sim.matchesLeft === 2) {
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

// -------------------------------------------------------------
// FUNKCJE POMOCNICZE STRATEGII, STATUSU I ETYKIET CUT
// -------------------------------------------------------------

function derivePlayerStrategy(sim, inCut) {
    if (!sim || sim.matchesLeft === 0) {
        return {
            ptsNeededText: "Koniec",
            strategyText: inCut ? "Awans w Cut" : "Odpada",
            rowClass: inCut ? "safe" : "dead"
        };
    }

    if (sim.matchesLeft >= 3) {
        if (sim.chanceTripleTie >= 90) {
            return { ptsNeededText: "3x TIE (+3)", strategyText: `Pewny 3x ID (${sim.chanceTripleTie}%)`, rowClass: "safe" };
        } else if (sim.chanceWinDoubleTie >= 80) {
            return { ptsNeededText: "1x W + 2x T (+5)", strategyText: `1x W + 2x ID (${sim.chanceWinDoubleTie}%)`, rowClass: "safe" };
        } else if (sim.chanceTwoWinLoss >= 75) {
            return { ptsNeededText: "2x W + 1x L (+6)", strategyText: `Wystarczy 2x W (${sim.chanceTwoWinLoss}%)`, rowClass: "bubble" };
        } else if (sim.chanceTwoWinTie >= 75) {
            return { ptsNeededText: "2x W + 1x T (+7)", strategyText: `Wymaga 2x W + ID (${sim.chanceTwoWinTie}%)`, rowClass: "bubble" };
        } else if (sim.chanceTripleWin >= 40) {
            return { ptsNeededText: "3x WIN (+9)", strategyText: `Musi wygrać 3x (${sim.chanceTripleWin}%)`, rowClass: "bubble" };
        } else {
            return { ptsNeededText: "3x WIN", strategyText: "Minimalne szanse", rowClass: "dead" };
        }
    }

    if (sim.matchesLeft === 2) {
        if (sim.chanceDoubleTie >= 90) {
            return { ptsNeededText: "2x TIE (+2)", strategyText: `Pewny 2x ID (${sim.chanceDoubleTie}%)`, rowClass: "safe" };
        } else if (sim.chanceDoubleTie >= 75) {
            return { ptsNeededText: "2x TIE (+2)", strategyText: `Możliwy 2x ID (${sim.chanceDoubleTie}%)`, rowClass: "safe" };
        } else if (sim.chanceWinLoss >= 80) {
            return { ptsNeededText: "1x W + 1x L (+3)", strategyText: `Wystarczy 1x W (${sim.chanceWinLoss}%)`, rowClass: "safe" };
        } else if (sim.chanceWinTie >= 75) {
            return { ptsNeededText: "1x W + 1x T (+4)", strategyText: `Wymaga 1x W + ID (${sim.chanceWinTie}%)`, rowClass: "bubble" };
        } else if (sim.chanceDoubleWin >= 40) {
            return { ptsNeededText: "2x WIN (+6)", strategyText: `Musi wygrać 2x (${sim.chanceDoubleWin}%)`, rowClass: "bubble" };
        } else {
            return { ptsNeededText: "2x WIN", strategyText: "Minimalne szanse", rowClass: "dead" };
        }
    }

    // matchesLeft === 1 (ostatni mecz)
    if (sim.chanceLoss >= 90) {
        return { ptsNeededText: "0 pkt (LOCKED)", strategyText: `Pewny Cut (${sim.chanceLoss}%)`, rowClass: "safe" };
    } else if (sim.chanceTie >= 90 && sim.oppChanceTie >= 90) {
        return { ptsNeededText: "TIE (1 pkt)", strategyText: "Bezpieczny ID", rowClass: "safe" };
    } else if (sim.chanceTie >= 75) {
        return { ptsNeededText: "TIE (1 pkt)", strategyText: `Możliwy ID (${sim.chanceTie}%)`, rowClass: "safe" };
    } else if (sim.chanceWin >= 35) {
        return { ptsNeededText: "WIN (3 pkt)", strategyText: "Wymaga 1x W", rowClass: "bubble" };
    } else {
        return { ptsNeededText: "WIN", strategyText: "Odpada", rowClass: "dead" };
    }
}

function setLiveStatusFilter(filterType) {
    currentLiveStatusFilter = filterType;
    currentPages.live = 1;
    ['filterStatusAll', 'filterStatusCut', 'filterStatusBubble'].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.classList.remove('active');
    });
    if (filterType === 'all') document.getElementById('filterStatusAll')?.classList.add('active');
    if (filterType === 'cut') document.getElementById('filterStatusCut')?.classList.add('active');
    if (filterType === 'bubble') document.getElementById('filterStatusBubble')?.classList.add('active');
    renderLiveStandingsTable();
}

function getCutStatusCategory(player, sim, cutSize) {
    const rank = player.liveRank || 999;
    const inCut = (rank <= cutSize);
    if (!sim || sim.matchesLeft === 0) {
        return inCut ? 'cut' : 'dead';
    }
    if (sim.matchesLeft >= 3) {
        if (sim.chanceTripleTie >= 75 || sim.chanceWinDoubleTie >= 75) return 'cut';
        if (sim.chanceTwoWinLoss >= 40 || sim.chanceTwoWinTie >= 40 || sim.chanceTripleWin >= 40) return 'bubble';
        return 'dead';
    }
    if (sim.matchesLeft === 2) {
        if (sim.chanceDoubleTie >= 75 || sim.chanceWinTie >= 75) return 'cut';
        if (sim.chanceDoubleWin >= 40 || sim.chanceWin >= 40) return 'bubble';
        return 'dead';
    } else {
        if (sim.chanceTie >= 75 || sim.chanceWin >= 75) return 'cut';
        if (sim.chanceWin >= 35) return 'bubble';
        return 'dead';
    }
}

function getCutStatusBadge(player, sim, inCut, cutSize, matchesLeft) {
    if (!sim || matchesLeft === 0) {
        return inCut 
            ? `<span class="cut-badge badge-locked" title="Gracz jest w strefie Top Cut">🔒 W CUT</span>`
            : `<span class="cut-badge badge-eliminated" title="Poza strefą Cut">💀 ODPADA</span>`;
    }

    if (matchesLeft >= 3) {
        if (sim.chanceTripleTie >= 90) {
            return `<span class="cut-badge badge-locked" title="Pewny awans nawet po 3 remisach (${sim.chanceTripleTie}%)">🔒 LOCKED</span>`;
        } else if (sim.chanceTripleTie >= 75 || sim.chanceWinDoubleTie >= 80) {
            return `<span class="cut-badge badge-safe-id" title="1x WIN + 2x ID daje ${sim.chanceWinDoubleTie}% awansu">🤝 SAFE ID</span>`;
        } else if (sim.chanceTwoWinLoss >= 75 || sim.chanceTwoWinTie >= 75) {
            return `<span class="cut-badge badge-win-in" title="2 wygrane dają bezpieczny awans (${sim.chanceTwoWinTie}%)">🎯 WIN & IN</span>`;
        } else if (sim.chanceTripleWin >= 40) {
            if (sim.chanceTwoWinTie < 45) {
                return `<span class="cut-badge badge-must-win" title="Konieczny komplet 3 zwycięstw (${sim.chanceTripleWin}%)">⚠️ MUST WIN OUT</span>`;
            }
            return `<span class="cut-badge badge-bubble" title="Strefa Bubble - szanse zależne od OMWP (${sim.chanceTripleWin}%)">🟡 BUBBLE</span>`;
        } else {
            return `<span class="cut-badge badge-eliminated" title="Minimalne szanse na awans">💀 ELIMINATED</span>`;
        }
    }
    
    if (matchesLeft === 2) {
        if (sim.chanceDoubleTie >= 90) {
            return `<span class="cut-badge badge-locked" title="Pewny awans nawet po 2 remisach (${sim.chanceDoubleTie}%)">🔒 LOCKED</span>`;
        } else if (sim.chanceDoubleTie >= 75) {
            return `<span class="cut-badge badge-safe-id" title="2 remisy dają awans na ${sim.chanceDoubleTie}%">🤝 SAFE ID</span>`;
        } else if (sim.chanceWinTie >= 75) {
            return `<span class="cut-badge badge-win-in" title="1 wygrana i 1 remis dają ${sim.chanceWinTie}% awansu">🎯 WIN & IN</span>`;
        } else if (sim.chanceDoubleWin >= 40) {
            if (sim.chanceDoubleTie < 35 && sim.chanceWinTie < 55) {
                return `<span class="cut-badge badge-must-win" title="Konieczny komplet 2 zwycięstw (${sim.chanceDoubleWin}%)">⚠️ MUST WIN OUT</span>`;
            }
            return `<span class="cut-badge badge-bubble" title="Strefa Bubble - szanse zależne od OMWP (${sim.chanceDoubleWin}%)">🟡 BUBBLE</span>`;
        } else {
            return `<span class="cut-badge badge-eliminated" title="Minimalne szanse na awans">💀 ELIMINATED</span>`;
        }
    } else {
        // matchesLeft === 1
        if (sim.chanceLoss >= 90 || (sim.chanceTie >= 90 && sim.oppChanceTie >= 90)) {
            return `<span class="cut-badge badge-locked" title="Pewny awans do Top Cut">🔒 LOCKED</span>`;
        } else if (sim.chanceTie >= 75) {
            return `<span class="cut-badge badge-safe-id" title="Remis daje ${sim.chanceTie}% szans na Cut">🤝 SAFE ID</span>`;
        } else if (sim.chanceWin >= 75) {
            return `<span class="cut-badge badge-win-in" title="Wygrana daje ${sim.chanceWin}% szans na Cut">🎯 WIN & IN</span>`;
        } else if (sim.chanceWin >= 35) {
            return `<span class="cut-badge badge-bubble" title="Strefa Bubble - o awansie decydują tiebreakery">🟡 BUBBLE</span>`;
        } else {
            return `<span class="cut-badge badge-eliminated" title="Brak realnych szans na awans">💀 ELIMINATED</span>`;
        }
    }
}

// -------------------------------------------------------------
// HISTORIA MECZÓW I INSPEKTOR TIEBREAKERÓW OMWP
// -------------------------------------------------------------

function getPlayerHistoricalMatches(playerId, data) {
    const history = [];
    if (!data) return history;
    const standingsMap = buildStandingsMap(data.standings?.standings || []);
    const pIdStr = String(playerId);
    
    if (data.roundsMatches && typeof data.roundsMatches === 'object') {
        const roundsKeys = Object.keys(data.roundsMatches).map(Number).sort((a,b) => a - b);
        for (const rNum of roundsKeys) {
            const rData = data.roundsMatches[rNum] || data.roundsMatches[String(rNum)];
            if (!rData) continue;
            const matches = extractPairingsList(rData.matches);
            for (const m of matches) {
                const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
                const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
                const id1 = p1 ? String(p1.id) : null;
                const id2 = p2 ? String(p2.id) : null;
                
                if (id1 === pIdStr || id2 === pIdStr) {
                    const isP1 = (id1 === pIdStr);
                    const opp = isP1 ? p2 : p1;
                    const scores = getMatchScores(m);
                    const status = (m.status || m.state || "").toUpperCase();
                    const isDraw = m.match_is_intentional_draw || m.match_is_unintentional_draw || status === "DRAW";
                    const isComplete = status === "COMPLETE" || status === "FINISHED" || status === "COMPLETED" || scores.winnerId != null || scores.hasScore;
                    
                    let outcome = "W TOKU";
                    let myScore = isP1 ? scores.score1 : scores.score2;
                    let oppScore = isP1 ? scores.score2 : scores.score1;
                    
                    if (isComplete) {
                        if (isDraw) outcome = "TIE";
                        else if (scores.winnerId != null) {
                            outcome = (String(scores.winnerId) === pIdStr) ? "WIN" : "LOSS";
                        } else if (myScore > oppScore) {
                            outcome = "WIN";
                        } else if (oppScore > myScore) {
                            outcome = "LOSS";
                        }
                    }
                    
                    history.push({
                        round: rNum,
                        match: m,
                        table: m.table_number || m.tableNumber || "?",
                        opponent: opp,
                        myScore,
                        oppScore,
                        outcome,
                        isComplete
                    });
                    break;
                }
            }
        }
    } else {
        const currentMatches = extractPairingsList(data.pairings);
        for (const m of currentMatches) {
            const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
            const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
            const id1 = p1 ? String(p1.id) : null;
            const id2 = p2 ? String(p2.id) : null;
            if (id1 === pIdStr || id2 === pIdStr) {
                const isP1 = (id1 === pIdStr);
                const opp = isP1 ? p2 : p1;
                const scores = getMatchScores(m);
                const status = (m.status || m.state || "").toUpperCase();
                const isDraw = m.match_is_intentional_draw || m.match_is_unintentional_draw || status === "DRAW";
                const isComplete = status === "COMPLETE" || status === "FINISHED" || status === "COMPLETED" || scores.winnerId != null || scores.hasScore;
                
                let outcome = "W TOKU";
                if (isComplete) {
                    if (isDraw) outcome = "TIE";
                    else if (scores.winnerId != null) outcome = (String(scores.winnerId) === pIdStr) ? "WIN" : "LOSS";
                    else if (scores.score1 > scores.score2) outcome = isP1 ? "WIN" : "LOSS";
                    else if (scores.score2 > scores.score1) outcome = isP1 ? "LOSS" : "WIN";
                }

                history.push({
                    round: data.activeRound || 1,
                    match: m,
                    table: m.table_number || m.tableNumber || "?",
                    opponent: opp,
                    myScore: isP1 ? scores.score1 : scores.score2,
                    oppScore: isP1 ? scores.score2 : scores.score1,
                    outcome,
                    isComplete
                });
                break;
            }
        }
    }
    return history;
}

function openOmwpInspector(playerId) {
    if (!latestData || !latestData.standings?.standings) return;
    const standings = latestData.standings.standings;
    const targetPlayer = standings.find(p => String(p.player?.id || p.id) === String(playerId));
    if (!targetPlayer) return;

    const modal = document.getElementById('omwpInspectorModal');
    if (!modal) return;

    const name = formatStandingsPlayerName(targetPlayer);
    setElText('omwpPlayerName', name);

    const officialOmwp = ((targetPlayer.opponent_match_win_percentage || 0) * 100).toFixed(2);
    const officialGwp = ((targetPlayer.game_win_percentage || 0) * 100).toFixed(2);
    const officialOgwp = ((targetPlayer.opponent_game_win_percentage || 0) * 100).toFixed(2);
    setElText('omwpCurrentVal', officialOmwp + "%");
    setElText('omwpCurrentGwp', officialGwp + "%");
    setElText('omwpCurrentOgwp', officialOgwp + "%");

    const history = getPlayerHistoricalMatches(playerId, latestData);
    const standingsMap = buildStandingsMap(standings);
    const totalRounds = Math.max(latestData.totalRounds || 1, latestData.activeRound || 1);
    const activePairingsList = extractPairingsList(latestData.pairings);

    const tbody = document.getElementById('omwpOpponentsBody');
    if (!tbody) return;

    if (history.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="padding: 20px; color: #888;">Brak zapisanej historii meczów dla tego gracza w pobranych rundach.</td></tr>`;
        setElText('omwpMaxVal', officialOmwp + "%");
        setElText('omwpMinVal', officialOmwp + "%");
        setElHtml('omwpInsightBox', `Brak danych o rozegranych rundach. Tiebreaker bazuje na oficjalnym OMWP (${officialOmwp}%) oraz OGW% (${officialOgwp}%) z API.`);
        modal.style.display = 'flex';
        return;
    }

    let floorCount = 0;
    let boostCount = 0;
    let dragCount = 0;
    let rowsHtml = "";

    let currentMwpSum = 0;
    let maxMwpSum = 0;
    let minMwpSum = 0;

    history.forEach(item => {
        const oppId = item.opponent?.id;
        const oppStanding = oppId ? standings.find(p => String(p.player?.id || p.id) === String(oppId)) : null;
        
        let oppName = item.opponent?.name || "Nieznany";
        if (oppStanding) oppName = formatStandingsPlayerName(oppStanding);

        const safeOppName = escapeHtml(oppName);
        const oppPts = oppStanding ? (oppStanding.livePoints || oppStanding.match_points) : 0;
        const oppRecord = escapeHtml(oppStanding ? (oppStanding.record || oppStanding.match_record || `${oppStanding.user_event_status?.matches_won || 0}-${oppStanding.user_event_status?.matches_lost || 0}`) : "-");
        const oppGwp = oppStanding ? ((oppStanding.game_win_percentage || 0) * 100).toFixed(1) + "%" : "-";

        const maxPtsTotal = totalRounds * 3;
        const rawMwp = Math.min(1.0, oppPts / Math.max(1, maxPtsTotal));
        const isFloor = rawMwp < 0.3333;
        const oppMwp = Math.max(0.3333, rawMwp);

        currentMwpSum += oppMwp;

        let liveMatchInfo = "Zakończony";
        let isOppStillPlaying = false;
        if (oppId) {
            for (const m of activePairingsList) {
                const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
                const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
                if ((p1 && String(p1.id) === String(oppId)) || (p2 && String(p2.id) === String(oppId))) {
                    const scores = getMatchScores(m);
                    const status = (m.status || m.state || "").toUpperCase();
                    const isComplete = status === "COMPLETE" || status === "FINISHED" || status === "COMPLETED" || scores.winnerId != null || scores.hasScore;
                    if (!isComplete) {
                        isOppStillPlaying = true;
                        liveMatchInfo = `<span style="color: #f39c12; font-weight: bold;">⚔️ Stół #${escapeHtml(m.table_number || '?')} (W grze)</span>`;
                    }
                    break;
                }
            }
        }

        if (isOppStillPlaying) {
            maxMwpSum += Math.max(0.3333, (oppPts + 3) / maxPtsTotal);
            minMwpSum += Math.max(0.3333, (oppPts + 0) / maxPtsTotal);
        } else {
            maxMwpSum += oppMwp;
            minMwpSum += oppMwp;
        }

        let impactBadge = "";
        const playerOmwpFloat = (targetPlayer.opponent_match_win_percentage || 0.5);
        if (isFloor) {
            impactBadge = `<span class="badge-floor">🛡️ Floor 33.3%</span>`;
            floorCount++;
        } else if (oppMwp > playerOmwpFloat) {
            const diff = ((oppMwp - playerOmwpFloat) * 100).toFixed(1);
            impactBadge = `<span class="badge-boost">🚀 Podbija (+${diff}%)</span>`;
            boostCount++;
        } else {
            const diff = ((playerOmwpFloat - oppMwp) * 100).toFixed(1);
            impactBadge = `<span class="badge-drag">📉 Obniża (-${diff}%)</span>`;
            dragCount++;
        }

        let resultBadge = `<span style="color: #aaa;">${escapeHtml(item.outcome)}</span>`;
        if (item.outcome === "WIN") resultBadge = `<span style="color: #2ecc71; font-weight: bold;">WIN (${item.myScore}-${item.oppScore})</span>`;
        if (item.outcome === "LOSS") resultBadge = `<span style="color: #e74c3c; font-weight: bold;">LOSS (${item.myScore}-${item.oppScore})</span>`;
        if (item.outcome === "TIE") resultBadge = `<span style="color: #f1c40f; font-weight: bold;">TIE (${item.myScore}-${item.oppScore})</span>`;

        rowsHtml += `
            <tr>
                <td><strong>R${item.round}</strong></td>
                <td style="text-align: left; font-weight: 600;">${safeOppName}</td>
                <td>${resultBadge}</td>
                <td>${oppRecord}</td>
                <td><strong>${oppPts} pkt</strong></td>
                <td><strong>${(oppMwp * 100).toFixed(1)}%</strong></td>
                <td>${oppGwp}</td>
                <td>${impactBadge}</td>
                <td>${liveMatchInfo}</td>
            </tr>
        `;
    });

    tbody.innerHTML = rowsHtml;

    const maxOmwp = ((maxMwpSum / history.length) * 100).toFixed(1);
    const minOmwp = ((minMwpSum / history.length) * 100).toFixed(1);
    setElText('omwpMaxVal', maxOmwp + "%");
    setElText('omwpMinVal', minOmwp + "%");

    let insightText = `Gracz rozegrał mecze z <strong>${history.length}</strong> rywalami. `;
    if (boostCount > 0) insightText += `Aż <strong>${boostCount}</strong> rywali radzi sobie świetnie i ciągnie OMWP w górę (🚀). `;
    if (floorCount > 0) insightText += `<strong>${floorCount}</strong> rywali jest objętych ochronnym limitem Floor 33.33% (🛡️), dzięki czemu ich porażki nie obniżają OMWP poniżej 33.3%. `;
    if (maxOmwp !== minOmwp) {
        insightText += `<br/>⚡ <strong>Wpływ trwających meczów:</strong> Część Twoich byłych rywali wciąż gra w tej rundzie! Jeśli wygrają swoje mecze, Twoje OMWP może wzrosnąć nawet do <strong>${maxOmwp}%</strong>.`;
    }
    insightText += `<br/>ℹ️ <strong>OGW% (${officialOgwp}%):</strong> Średnia z indywidualnych Game Win % (GW%) Twoich przeciwników. Jeśli Ty i inny gracz macie identyczne punkty, OMW% i GW%, to właśnie wyższy OGW% decyduje o awansie!`;

    setElHtml('omwpInsightBox', insightText);
    modal.style.display = 'flex';
}

function closeOmwpInspector(event) {
    if (event && event.target && event.target.id !== 'omwpInspectorModal' && !event.target.classList.contains('modal-close-btn')) {
        return;
    }
    const modal = document.getElementById('omwpInspectorModal');
    if (modal) modal.style.display = 'none';
}

// -------------------------------------------------------------
// SYMULATOR PAROWAŃ NA NASTĘPNĄ RUNDĘ (SWISS PREDICTOR)
// -------------------------------------------------------------

function switchPredictorScenario(scenario) {
    currentPredictorScenario = scenario;
    ['scenarioBtnWin', 'scenarioBtnTie', 'scenarioBtnLoss'].forEach(id => {
        document.getElementById(id)?.classList.remove('active');
    });
    if (scenario === 'WIN') document.getElementById('scenarioBtnWin')?.classList.add('active');
    if (scenario === 'TIE') document.getElementById('scenarioBtnTie')?.classList.add('active');
    if (scenario === 'LOSS') document.getElementById('scenarioBtnLoss')?.classList.add('active');
    
    if (latestData && currentSelectedPlayerId) {
        const standings = latestData.standings?.standings || [];
        const targetPlayer = standings.find(p => String(p.player?.id || p.id) === String(currentSelectedPlayerId));
        const activeRound = latestData.activeRound || 1;
        const totalRounds = Math.max(latestData.totalRounds || 1, activeRound);
        const cached = simulatedResultsCache.get(String(currentSelectedPlayerId));
        if (targetPlayer) {
            recalculateNextRoundPairingsPredictor(cached?.sim, targetPlayer, activeRound, totalRounds);
        }
    }
}

function recalculateNextRoundPairingsPredictor(sim, targetPlayer, activeRound, totalRounds) {
    const panel = document.getElementById('nextRoundPairingsPanel');
    if (!panel) return;

    if (!latestData || activeRound >= totalRounds) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    setElText('predictorNextRoundNum', activeRound + 1);

    const basePts = (targetPlayer.livePoints || targetPlayer.match_points);
    const isFinished = sim?.isCurrentMatchFinished ?? false;

    const pWin = isFinished ? basePts : (basePts + 3);
    const pTie = isFinished ? basePts : (basePts + 1);
    const pLoss = isFinished ? basePts : basePts;

    setElText('predictorWinPts', pWin);
    setElText('predictorTiePts', pTie);
    setElText('predictorLossPts', pLoss);

    let targetScenarioPts = pWin;
    if (currentPredictorScenario === 'TIE') targetScenarioPts = pTie;
    if (currentPredictorScenario === 'LOSS') targetScenarioPts = pLoss;

    const history = getPlayerHistoricalMatches(targetPlayer.player.id, latestData);
    const playedOpponentsIds = new Set(history.map(h => String(h.opponent?.id)).filter(Boolean));
    playedOpponentsIds.add(String(targetPlayer.player.id));

    const standings = latestData.standings?.standings || [];
    const candidates = [];

    standings.forEach(p => {
        const pIdStr = String(p.player?.id || p.id);
        if (playedOpponentsIds.has(pIdStr)) return;

        const candLivePts = (p.livePoints || p.match_points);
        let candExpectedPts = candLivePts;
        if (!isFinished && p.delta === 0) {
            candExpectedPts = candLivePts + 1.5;
        }

        const delta = Math.abs(candExpectedPts - targetScenarioPts);
        let weight = 2;
        let bracketTag = "Możliwy Pair-down";

        if (delta <= 0.8) {
            weight = 100;
            bracketTag = "Ten sam koszyk punktowy";
        } else if (delta <= 1.8) {
            weight = 45;
            bracketTag = (candExpectedPts > targetScenarioPts) ? "Bliski Pair-up (+1)" : "Bliski Pair-down (-1)";
        } else if (delta <= 3.2) {
            weight = 18;
            bracketTag = (candExpectedPts > targetScenarioPts) ? "Pair-up (+3)" : "Pair-down (-3)";
        } else {
            weight = 3;
            bracketTag = (candExpectedPts > targetScenarioPts) ? "Daleki Pair-up" : "Daleki Pair-down";
        }

        const candOmwp = p.opponent_match_win_percentage || 0.5;
        const targetOmwp = targetPlayer.opponent_match_win_percentage || 0.5;
        const omwpCloseness = Math.max(0.5, 1.0 - Math.abs(candOmwp - targetOmwp));
        weight *= omwpCloseness;

        candidates.push({
            player: p,
            name: formatStandingsPlayerName(p),
            pts: candLivePts,
            omwp: (candOmwp * 100).toFixed(1) + "%",
            record: p.record || p.match_record || "-",
            weight,
            bracketTag
        });
    });

    const listEl = document.getElementById('predictorCandidatesList');
    const summaryEl = document.getElementById('predictorSummaryText');
    if (!listEl) return;

    if (candidates.length === 0) {
        listEl.innerHTML = `<div style="grid-column: span 2; padding: 15px; color: #888; text-align: center;">Brak dostępnych rywali w systemie Swiss (grano już ze wszystkimi graczami).</div>`;
        if (summaryEl) summaryEl.innerHTML = `Rozegrano już mecze z każdym uczestnikiem turnieju.`;
        return;
    }

    const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
    candidates.forEach(c => {
        c.prob = Math.max(1, Math.round((c.weight / totalWeight) * 100));
    });

    candidates.sort((a, b) => b.prob - a.prob);
    const topCandidates = candidates.slice(0, 8);

    if (summaryEl) {
        const scenarioLabel = currentPredictorScenario === 'WIN' ? 'WYGRANEJ' : (currentPredictorScenario === 'TIE' ? 'REMISIE' : 'PORAŻCE');
        summaryEl.innerHTML = `
            🎯 Przy Twoim wyniku po <strong>${scenarioLabel}</strong> (${targetScenarioPts} pkt), algorytm zidentyfikował 
            <strong>${candidates.length}</strong> uprawnionych rywali (z którymi jeszcze nie grałeś). Poniżej najbardziej prawdopodobne parowania w Rundzie ${activeRound + 1}:
        `;
    }

    listEl.innerHTML = topCandidates.map(c => `
        <div class="candidate-card clickable-row" onclick="selectPlayerForTie('${escapeJsAttr(c.player.player?.id || c.player.id)}')" title="Kliknij, aby przeanalizować mecz z tym rywalem">
            <div>
                <div class="candidate-name">${escapeHtml(c.name)}</div>
                <div class="candidate-sub">Aktualnie: <strong>${c.pts} pkt</strong> | Bilans: ${escapeHtml(c.record)} | OMWP: ${c.omwp}</div>
                <div class="candidate-bracket-tag">${escapeHtml(c.bracketTag)}</div>
            </div>
            <div class="candidate-prob-badge">
                ${c.prob}%
                <div style="font-size: 10px; color: #94a3b8; font-weight: normal;">szans</div>
            </div>
        </div>
    `).join('');
}

// -------------------------------------------------------------
// KALKULATOR ROZKŁADU KOSZYKÓW PUNKTOWYCH (CUT LINE BREAKDOWN)
// -------------------------------------------------------------

function calculateCutLineBreakdown(liveStandings, cutSize = 4, cutRule = 'hard') {
    if (!liveStandings || liveStandings.length === 0) {
        return null;
    }

    const sorted = [...liveStandings].sort((a, b) => {
        const ptsA = a.livePoints ?? a.match_points ?? 0;
        const ptsB = b.livePoints ?? b.match_points ?? 0;
        if (ptsB !== ptsA) return ptsB - ptsA;
        if ((b.opponent_match_win_percentage || 0) !== (a.opponent_match_win_percentage || 0)) {
            return (b.opponent_match_win_percentage || 0) - (a.opponent_match_win_percentage || 0);
        }
        if ((b.game_win_percentage || 0) !== (a.game_win_percentage || 0)) {
            return (b.game_win_percentage || 0) - (a.game_win_percentage || 0);
        }
        return (b.opponent_game_win_percentage || 0) - (a.opponent_game_win_percentage || 0);
    });

    const bubbleIdx = Math.min(Math.max(1, cutSize) - 1, sorted.length - 1);
    const gatekeeperPlayer = sorted[bubbleIdx];
    const bubblePts = gatekeeperPlayer.livePoints ?? gatekeeperPlayer.match_points ?? 0;

    const aboveBubblePlayers = sorted.filter(p => (p.livePoints ?? p.match_points ?? 0) > bubblePts);
    const lockedAboveCount = aboveBubblePlayers.length;
    const safePts = lockedAboveCount > 0
        ? Math.min(...aboveBubblePlayers.map(p => p.livePoints ?? p.match_points ?? 0))
        : (bubblePts + 1);

    const bubbleBracketPlayers = sorted.filter(p => (p.livePoints ?? p.match_points ?? 0) === bubblePts);
    const totalInBubbleBracket = bubbleBracketPlayers.length;

    const spotsForBubbleBracket = cutRule === 'soft'
        ? totalInBubbleBracket
        : Math.max(0, Math.min(totalInBubbleBracket, cutSize - lockedAboveCount));

    const missingFromBubbleBracket = Math.max(0, totalInBubbleBracket - spotsForBubbleBracket);
    const bubblePassRatePct = totalInBubbleBracket > 0
        ? Math.round((spotsForBubbleBracket / totalInBubbleBracket) * 100)
        : 0;

    const gatekeeper = {
        rank: bubbleIdx + 1,
        id: gatekeeperPlayer.player?.id || gatekeeperPlayer.id,
        name: formatStandingsPlayerName(gatekeeperPlayer),
        points: bubblePts,
        omwp: Number(((gatekeeperPlayer.opponent_match_win_percentage || 0) * 100).toFixed(2)),
        gwp: Number(((gatekeeperPlayer.game_win_percentage || 0) * 100).toFixed(2)),
        ogwp: Number(((gatekeeperPlayer.opponent_game_win_percentage || 0) * 100).toFixed(2))
    };

    const firstOutIdx = cutRule === 'soft' ? (lockedAboveCount + totalInBubbleBracket) : cutSize;
    const firstOutPlayer = sorted[firstOutIdx] || null;
    let firstOut = null;
    if (firstOutPlayer) {
        const foPts = firstOutPlayer.livePoints ?? firstOutPlayer.match_points ?? 0;
        const foOmwp = Number(((firstOutPlayer.opponent_match_win_percentage || 0) * 100).toFixed(2));
        firstOut = {
            rank: firstOutIdx + 1,
            id: firstOutPlayer.player?.id || firstOutPlayer.id,
            name: formatStandingsPlayerName(firstOutPlayer),
            points: foPts,
            omwp: foOmwp,
            gwp: Number(((firstOutPlayer.game_win_percentage || 0) * 100).toFixed(2)),
            ogwp: Number(((firstOutPlayer.opponent_game_win_percentage || 0) * 100).toFixed(2)),
            samePointsAsBubble: foPts === bubblePts,
            omwpGap: Number((gatekeeper.omwp - foOmwp).toFixed(2))
        };
    }

    // Grupowanie w koszyki punktowe
    const bucketMap = new Map();
    sorted.forEach((p, idx) => {
        const pts = p.livePoints ?? p.match_points ?? 0;
        const rank = idx + 1;
        const inCut = cutRule === 'soft' ? (pts >= bubblePts) : (rank <= cutSize);
        const omwp = Number(((p.opponent_match_win_percentage || 0) * 100).toFixed(1));

        if (!bucketMap.has(pts)) {
            bucketMap.set(pts, {
                points: pts,
                total: 0,
                inCutCount: 0,
                minOmwp: omwp,
                maxOmwp: omwp
            });
        }
        const b = bucketMap.get(pts);
        b.total++;
        if (inCut) b.inCutCount++;
        if (omwp < b.minOmwp) b.minOmwp = omwp;
        if (omwp > b.maxOmwp) b.maxOmwp = omwp;
    });

    const brackets = Array.from(bucketMap.values())
        .sort((a, b) => b.points - a.points)
        .map(b => ({
            ...b,
            passRatePct: Math.round((b.inCutCount / Math.max(1, b.total)) * 100),
            status: b.inCutCount === b.total ? 'safe' : (b.inCutCount > 0 ? 'split' : 'out')
        }));

    return {
        cutSize,
        cutRule,
        bubblePts,
        safePts,
        lockedAboveCount,
        totalInBubbleBracket,
        spotsForBubbleBracket,
        missingFromBubbleBracket,
        bubblePassRatePct,
        gatekeeper,
        firstOut,
        brackets
    };
}

function renderCutLineBreakdownPanel(liveStandings, cutSize, cutRule, activeRound, totalRounds) {
    const panel = document.getElementById('cutBreakdownPanel');
    const gridEl = document.getElementById('cutBreakdownMetricsGrid');
    const rowEl = document.getElementById('cutBreakdownBracketsRow');
    const subtitleEl = document.getElementById('breakdownSummarySubtitle');
    if (!panel || !gridEl || !rowEl) return;

    const bd = calculateCutLineBreakdown(liveStandings, cutSize, cutRule);
    if (!bd) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    setElText('breakdownCutSizeLabel', cutSize);

    if (subtitleEl) {
        if (bd.missingFromBubbleBracket > 0) {
            subtitleEl.innerHTML = `W koszyku <strong>${bd.bubblePts} pkt</strong> o ostatnie <strong>${bd.spotsForBubbleBracket}</strong> miejsc walczy <strong>${bd.totalInBubbleBracket}</strong> graczy (odpada ${bd.missingFromBubbleBracket} na tiebreakerach OMW%)`;
        } else {
            subtitleEl.innerHTML = `Wszyscy gracze z dorobkiem <strong>>= ${bd.bubblePts} pkt</strong> mieszczą się obecnie w Top ${cutSize}`;
        }
    }

    const firstOutHtml = bd.firstOut
        ? `
            <div class="metric-val" style="color: #e74c3c; font-size: 14px;">#${bd.firstOut.rank} ${escapeHtml(bd.firstOut.name)}</div>
            <div class="metric-sub">${bd.firstOut.points} pkt | OMW: <strong>${bd.firstOut.omwp.toFixed(2)}%</strong> ${bd.firstOut.samePointsAsBubble ? `<span style="color:#f39c12;">(-${bd.firstOut.omwpGap.toFixed(2)}% do Cutu)</span>` : ''}</div>
        `
        : `<div class="metric-val" style="color: #888;">Brak graczy poza Cut</div><div class="metric-sub">-</div>`;

    gridEl.innerHTML = `
        <div class="cut-metric-card">
            <div class="metric-label">🟢 Czysty Awans (Bez OMW%)</div>
            <div class="metric-val" style="color: #2ecc71;">>= ${bd.safePts} pkt (${bd.lockedAboveCount} os.)</div>
            <div class="metric-sub">100% graczy powyżej ${bd.bubblePts} pkt jest w Top ${cutSize}</div>
        </div>
        <div class="cut-metric-card">
            <div class="metric-label">🟡 Koszyk na Kresce (${bd.bubblePts} pkt)</div>
            <div class="metric-val" style="color: #f1c40f;">Wchodzi ${bd.spotsForBubbleBracket} z ${bd.totalInBubbleBracket} (${bd.bubblePassRatePct}%)</div>
            <div class="metric-sub">${bd.missingFromBubbleBracket > 0 ? `Odpada ${bd.missingFromBubbleBracket} graczy z ${bd.bubblePts} pkt przez OMW%` : `Cały koszyk ${bd.bubblePts} pkt wchodzi do Cutu`}</div>
        </div>
        <div class="cut-metric-card clickable-row" onclick="selectPlayerForTie('${escapeJsAttr(bd.gatekeeper.id)}')" title="Kliknij, aby zbadać ostatniego wchodzącego gracza">
            <div class="metric-label">🔒 Ostatni w Cut (#${bd.gatekeeper.rank} Gatekeeper)</div>
            <div class="metric-val" style="color: #3498db; font-size: 14px;">#${bd.gatekeeper.rank} ${escapeHtml(bd.gatekeeper.name)}</div>
            <div class="metric-sub">${bd.gatekeeper.points} pkt | Wymagane OMW: <strong>${bd.gatekeeper.omwp.toFixed(2)}%</strong> (GW: ${bd.gatekeeper.gwp.toFixed(1)}%)</div>
        </div>
        <div class="cut-metric-card ${bd.firstOut ? 'clickable-row' : ''}" ${bd.firstOut ? `onclick="selectPlayerForTie('${escapeJsAttr(bd.firstOut.id)}')"` : ''} title="Pierwszy gracz pod kreską">
            <div class="metric-label">🎯 Pierwszy Poza Cut (Sniper)</div>
            ${firstOutHtml}
        </div>
    `;

    const visibleBrackets = bd.brackets.filter(b => b.points >= Math.max(0, bd.bubblePts - 6));
    rowEl.innerHTML = visibleBrackets.map(b => {
        const pillClass = b.status === 'safe' ? 'pill-safe' : (b.status === 'split' ? 'pill-split' : 'pill-out');
        const statusIcon = b.status === 'safe' ? '🟢' : (b.status === 'split' ? '🟡' : '🔴');
        return `
            <div class="bracket-pill ${pillClass}">
                <div><strong>${statusIcon} ${b.points} pkt:</strong> ${b.inCutCount}/${b.total} w Cut (${b.passRatePct}%)</div>
                <div style="font-size: 10px; color: #94a3b8;">OMW%: ${b.minOmwp}% – ${b.maxOmwp}%</div>
            </div>
        `;
    }).join('');
}

// -------------------------------------------------------------
// SYMULATOR DRABINKI TOP CUT (BRACKET TREE & PLAY/DRAW PREDICTOR)
// -------------------------------------------------------------

let bracketDisplayMode = 'projected'; // 'projected' | 'strict'
let playerPathScenarioMode = 'CURRENT'; // 'CURRENT' | 'WIN' | 'TIE'

function setBracketDisplayMode(mode) {
    bracketDisplayMode = mode === 'strict' ? 'strict' : 'projected';
    const projBtn = document.getElementById('bracketModeProjectedBtn');
    const strictBtn = document.getElementById('bracketModeStrictBtn');
    if (projBtn) projBtn.classList.toggle('active', bracketDisplayMode === 'projected');
    if (strictBtn) strictBtn.classList.toggle('active', bracketDisplayMode === 'strict');
    const cutSize = parseInt(document.getElementById('cutSize')?.value || '8', 10);
    renderTopCutBracketPanel(cachedLiveStandings, cutSize);
}

function setPlayerPathScenarioMode(mode) {
    playerPathScenarioMode = mode || 'CURRENT';
    if (currentSelectedPlayerId) {
        recalculateTieForSelectedPlayer();
    }
}

function getBracketSeedOrder(cutSize = 8) {
    let n = 2;
    while (n < Math.max(2, cutSize) && n < 128) {
        n *= 2;
    }
    let seeds = [1];
    while (seeds.length < n) {
        const next = [];
        const sum = seeds.length * 2 + 1;
        for (const s of seeds) {
            next.push(s, sum - s);
        }
        seeds = next;
    }
    return seeds;
}

function getBracketStageLabel(stageSize) {
    if (stageSize >= 64) return '1/32 Finału (Top 64)';
    if (stageSize === 32) return '1/16 Finału (Top 32)';
    if (stageSize === 16) return '1/8 Finału (Top 16)';
    if (stageSize === 8) return 'Ćwierćfinał (Top 8)';
    if (stageSize === 4) return 'Półfinał (Top 4)';
    if (stageSize === 2) return '🏆 Wielki Finał';
    return `Top ${stageSize}`;
}

function generateTopCutBracket(liveStandings, cutSize = 8) {
    if (!liveStandings || liveStandings.length === 0) return { bracketSize: 0, pairings: [] };

    const seedsOrder = getBracketSeedOrder(cutSize);
    const bracketSize = seedsOrder.length;
    const pairings = [];

    for (let i = 0; i < bracketSize; i += 2) {
        const s1 = seedsOrder[i];
        const s2 = seedsOrder[i + 1];
        const highSeed = Math.min(s1, s2);
        const lowSeed = Math.max(s1, s2);

        const pHigh = liveStandings[highSeed - 1] || null;
        const pLow = liveStandings[lowSeed - 1] || null;

        pairings.push({
            matchNumber: (i / 2) + 1,
            bracketHalf: i < bracketSize / 2 ? 'Górna połowa drabinki' : 'Dolna połowa drabinki',
            highSeed,
            lowSeed,
            highSeedPlayer: pHigh ? {
                id: pHigh.player?.id || pHigh.id,
                name: formatStandingsPlayerName(pHigh),
                points: pHigh.livePoints ?? pHigh.match_points ?? 0,
                omwp: Number(((pHigh.opponent_match_win_percentage || 0) * 100).toFixed(1)),
                hasPlayDraw: true,
                raw: pHigh
            } : null,
            lowSeedPlayer: pLow ? {
                id: pLow.player?.id || pLow.id,
                name: formatStandingsPlayerName(pLow),
                points: pLow.livePoints ?? pLow.match_points ?? 0,
                omwp: Number(((pLow.opponent_match_win_percentage || 0) * 100).toFixed(1)),
                hasPlayDraw: false,
                raw: pLow
            } : null
        });
    }

    return { bracketSize, pairings };
}

function detectActualTopCutInfo(roundsMatches, liveStandings = [], standingsMap = null) {
    if (!roundsMatches || typeof roundsMatches !== 'object') {
        return { isTopCutActive: false };
    }
    const rNums = Object.keys(roundsMatches)
        .map(Number)
        .filter(n => !Number.isNaN(n) && n > 0)
        .sort((a, b) => a - b);

    if (rNums.length < 4) return { isTopCutActive: false };

    const mapToUse = standingsMap || buildStandingsMap(liveStandings || []);
    let firstElimRoundNum = null;
    let actualBracketSize = 0;

    for (let i = 1; i < rNums.length; i++) {
        const rNum = rNums[i];
        if (rNum < 4) continue;
        const curMatches = extractPairingsList(roundsMatches[rNum]?.matches || roundsMatches[rNum]);
        const prevMatches = extractPairingsList(roundsMatches[rNums[i - 1]]?.matches || roundsMatches[rNums[i - 1]]);
        const curCount = curMatches.length;
        const prevCount = prevMatches.length;

        const isPowerOfTwoTables = [1, 2, 4, 8, 16, 32].includes(curCount);
        if (isPowerOfTwoTables && curCount >= 2 && prevCount > curCount * 1.4) {
            firstElimRoundNum = rNum;
            actualBracketSize = curCount * 2;
            break;
        }
    }

    if (!firstElimRoundNum || !actualBracketSize) {
        return { isTopCutActive: false };
    }

    const swissSeedsByPlayerId = new Map();
    const playersBySwissSeed = new Map();
    const firstRoundMatches = extractPairingsList(roundsMatches[firstElimRoundNum]?.matches || roundsMatches[firstElimRoundNum]);

    firstRoundMatches.forEach((m, idx) => {
        const tbl = Number(m.table_number || m.tableNumber || (idx + 1));
        if (tbl < 1 || tbl > actualBracketSize / 2) return;
        const highSeed = tbl;
        const lowSeed = actualBracketSize + 1 - tbl;

        const p1Resolved = resolvePlayer(getMatchParticipant(m, 1), mapToUse);
        const p2Resolved = resolvePlayer(getMatchParticipant(m, 2), mapToUse);

        const buildSeedNode = (resolved, seedNum) => {
            if (!resolved) return null;
            const stObj = resolved.raw || (liveStandings || []).find(s => String(s.player?.id || s.id) === String(resolved.id));
            return {
                id: resolved.id,
                seed: seedNum,
                name: stObj ? formatStandingsPlayerName(stObj) : resolved.name,
                points: stObj ? (stObj.livePoints ?? stObj.match_points ?? 0) : 0,
                omwp: stObj ? Number(((stObj.opponent_match_win_percentage || 0) * 100).toFixed(1)) : 0,
                raw: stObj || resolved
            };
        };

        const nodeHigh = buildSeedNode(p1Resolved, highSeed);
        const nodeLow = buildSeedNode(p2Resolved, lowSeed);

        if (nodeHigh && nodeHigh.id != null) {
            swissSeedsByPlayerId.set(String(nodeHigh.id), highSeed);
            playersBySwissSeed.set(highSeed, nodeHigh);
        }
        if (nodeLow && nodeLow.id != null) {
            swissSeedsByPlayerId.set(String(nodeLow.id), lowSeed);
            playersBySwissSeed.set(lowSeed, nodeLow);
        }
    });

    return {
        isTopCutActive: true,
        firstElimRoundNum,
        actualBracketSize,
        swissSeedsByPlayerId,
        playersBySwissSeed
    };
}

function buildFullTopCutBracketTree(liveStandings, cutSize = 8, roundsMatches = null, standingsMap = null) {
    if (!liveStandings || liveStandings.length === 0) {
        return { bracketSize: 0, isTopCutActive: false, rounds: [], champion: null, projectedChampion: null };
    }

    const mapToUse = standingsMap || buildStandingsMap(liveStandings);
    const topCutInfo = detectActualTopCutInfo(roundsMatches, liveStandings, mapToUse);

    const seedsOrder = getBracketSeedOrder(cutSize);
    const bracketSize = seedsOrder.length;
    const numRounds = Math.round(Math.log2(bracketSize));

    // Czy rzeczywiste rundy Top Cut w roundsMatches pasują do wybranego rozmiaru drabinki (lub stanowią jej późniejszy etap)?
    let stageZeroRoundNum = null;
    if (topCutInfo.isTopCutActive) {
        if (topCutInfo.actualBracketSize === bracketSize) {
            stageZeroRoundNum = topCutInfo.firstElimRoundNum;
        } else if (topCutInfo.actualBracketSize > bracketSize) {
            const offset = Math.round(Math.log2(topCutInfo.actualBracketSize / bracketSize));
            const candidateRound = topCutInfo.firstElimRoundNum + offset;
            const candMatches = extractPairingsList(roundsMatches?.[candidateRound]?.matches || roundsMatches?.[candidateRound]);
            if (candMatches.length === bracketSize / 2) {
                stageZeroRoundNum = candidateRound;
            }
        }
    }

    const getSeedPlayerFromStandings = (seedNum) => {
        if (topCutInfo.isTopCutActive && topCutInfo.actualBracketSize === bracketSize && topCutInfo.playersBySwissSeed.has(seedNum)) {
            return { ...topCutInfo.playersBySwissSeed.get(seedNum), isConfirmed: true };
        }
        const stObj = liveStandings[seedNum - 1];
        if (!stObj) return null;
        return {
            id: stObj.player?.id || stObj.id,
            seed: seedNum,
            name: formatStandingsPlayerName(stObj),
            points: stObj.livePoints ?? stObj.match_points ?? 0,
            omwp: Number(((stObj.opponent_match_win_percentage || 0) * 100).toFixed(1)),
            isConfirmed: true,
            raw: stObj
        };
    };

    const evaluateRealMatch = (realMatch, playerA, playerB) => {
        if (!realMatch) return { isCompleted: false, isInProgress: false, scoreA: null, scoreB: null, winnerSlot: null, winnerPlayer: null };
        const p1 = resolvePlayer(getMatchParticipant(realMatch, 1), mapToUse);
        const p2 = resolvePlayer(getMatchParticipant(realMatch, 2), mapToUse);
        const { score1, score2, hasScore, winnerId } = getMatchScores(realMatch);
        const statusRaw = (realMatch.status || realMatch.state || '').toUpperCase();
        const isCompleted = statusRaw === 'COMPLETE' || statusRaw === 'FINISHED' || statusRaw === 'COMPLETED' || winnerId != null || hasScore;
        const isInProgress = !isCompleted && (statusRaw === 'IN_PROGRESS' || statusRaw === 'STARTED' || Boolean(p1 && p2));

        const p1MatchesA = playerA && p1 && String(p1.id) === String(playerA.id);
        const scoreA = hasScore ? (p1MatchesA ? score1 : score2) : null;
        const scoreB = hasScore ? (p1MatchesA ? score2 : score1) : null;

        let winnerSlot = null;
        if (isCompleted) {
            if (winnerId != null) {
                if (playerA && String(winnerId) === String(playerA.id)) winnerSlot = 'A';
                else if (playerB && String(winnerId) === String(playerB.id)) winnerSlot = 'B';
            }
            if (!winnerSlot && scoreA !== null && scoreB !== null && scoreA !== scoreB) {
                winnerSlot = scoreA > scoreB ? 'A' : 'B';
            }
        }
        const winnerPlayer = winnerSlot === 'A' ? playerA : (winnerSlot === 'B' ? playerB : null);
        return { isCompleted, isInProgress, scoreA, scoreB, winnerSlot, winnerPlayer };
    };

    const rounds = [];

    for (let stageIdx = 0; stageIdx < numRounds; stageIdx++) {
        const stageSize = bracketSize / Math.pow(2, stageIdx);
        const stageLabel = getBracketStageLabel(stageSize);
        const realRoundNum = stageZeroRoundNum !== null ? (stageZeroRoundNum + stageIdx) : null;
        const realRoundMatches = realRoundNum ? extractPairingsList(roundsMatches?.[realRoundNum]?.matches || roundsMatches?.[realRoundNum]) : [];
        const stageMatches = [];

        if (stageIdx === 0) {
            const matchCount = bracketSize / 2;
            for (let mIdx = 0; mIdx < matchCount; mIdx++) {
                const s1 = seedsOrder[mIdx * 2];
                const s2 = seedsOrder[mIdx * 2 + 1];
                const highSeed = Math.min(s1, s2);
                const lowSeed = Math.max(s1, s2);

                let slotA = getSeedPlayerFromStandings(highSeed);
                let slotB = getSeedPlayerFromStandings(lowSeed);

                // Szukamy rzeczywistego meczu w 1. rundzie Top Cut
                let realMatch = null;
                if (realRoundMatches.length > 0) {
                    realMatch = realRoundMatches.find(rm => {
                        const rp1 = resolvePlayer(getMatchParticipant(rm, 1), mapToUse);
                        const rp2 = resolvePlayer(getMatchParticipant(rm, 2), mapToUse);
                        if (slotA && slotB && rp1 && rp2) {
                            const ids = [String(rp1.id), String(rp2.id)];
                            return ids.includes(String(slotA.id)) && ids.includes(String(slotB.id));
                        }
                        return Number(rm.table_number || rm.tableNumber) === highSeed;
                    }) || null;
                }

                const outcome = evaluateRealMatch(realMatch, slotA, slotB);
                const playDrawSlot = (!slotA || !slotB) ? 'A' : (slotA.seed <= slotB.seed ? 'A' : 'B');
                const projectedWinnerSlot = outcome.winnerSlot || playDrawSlot;
                const projectedWinnerPlayer = projectedWinnerSlot === 'A' ? slotA : slotB;
                const contenders = outcome.isCompleted && outcome.winnerPlayer
                    ? [outcome.winnerPlayer]
                    : [slotA, slotB].filter(Boolean).sort((a, b) => a.seed - b.seed);

                const quadrantSize = Math.max(1, matchCount / 4);
                const quadrantNum = Math.min(4, Math.floor(mIdx / quadrantSize) + 1);

                stageMatches.push({
                    stageIndex: stageIdx,
                    stageSize,
                    stageLabel,
                    realRoundNum,
                    matchIndex: mIdx,
                    matchNumber: mIdx + 1,
                    tableNumber: realMatch?.table_number || realMatch?.tableNumber || highSeed,
                    quadrantNum,
                    bracketHalf: mIdx < matchCount / 2 ? 'Górna połowa drabinki' : 'Dolna połowa drabinki',
                    highSeed,
                    lowSeed,
                    slotA,
                    slotB,
                    playDrawSlot,
                    ...outcome,
                    projectedWinnerSlot,
                    projectedWinnerPlayer,
                    contenders,
                    feederA: null,
                    feederB: null
                });
            }
        } else {
            const prevMatches = rounds[stageIdx - 1].matches;
            const matchCount = prevMatches.length / 2;

            for (let mIdx = 0; mIdx < matchCount; mIdx++) {
                const feederA = prevMatches[mIdx * 2];
                const feederB = prevMatches[mIdx * 2 + 1];

                let slotA = feederA.winnerPlayer
                    ? { ...feederA.winnerPlayer, isConfirmed: true }
                    : (feederA.projectedWinnerPlayer ? { ...feederA.projectedWinnerPlayer, isConfirmed: false } : null);
                let slotB = feederB.winnerPlayer
                    ? { ...feederB.winnerPlayer, isConfirmed: true }
                    : (feederB.projectedWinnerPlayer ? { ...feederB.projectedWinnerPlayer, isConfirmed: false } : null);

                // Jeśli w roundsMatches jest rzeczywisty mecz dla tej gałęzi, używamy faktycznych graczy
                let realMatch = null;
                if (realRoundMatches.length > 0) {
                    const contIdsA = new Set(feederA.contenders.map(c => String(c.id)));
                    const contIdsB = new Set(feederB.contenders.map(c => String(c.id)));

                    realMatch = realRoundMatches.find(rm => {
                        const rp1 = resolvePlayer(getMatchParticipant(rm, 1), mapToUse);
                        const rp2 = resolvePlayer(getMatchParticipant(rm, 2), mapToUse);
                        if (!rp1 || !rp2) return false;
                        const id1 = String(rp1.id);
                        const id2 = String(rp2.id);
                        return (contIdsA.has(id1) && contIdsB.has(id2)) || (contIdsA.has(id2) && contIdsB.has(id1));
                    }) || null;

                    if (realMatch) {
                        const rp1 = resolvePlayer(getMatchParticipant(realMatch, 1), mapToUse);
                        const rp2 = resolvePlayer(getMatchParticipant(realMatch, 2), mapToUse);
                        const fromA = feederA.contenders.find(c => String(c.id) === String(rp1?.id)) ||
                                      feederA.contenders.find(c => String(c.id) === String(rp2?.id));
                        const fromB = feederB.contenders.find(c => String(c.id) === String(rp1?.id)) ||
                                      feederB.contenders.find(c => String(c.id) === String(rp2?.id));
                        if (fromA) slotA = { ...fromA, isConfirmed: true };
                        if (fromB) slotB = { ...fromB, isConfirmed: true };
                    }
                }

                const outcome = evaluateRealMatch(realMatch, slotA, slotB);
                const playDrawSlot = (!slotA || !slotB) ? 'A' : (slotA.seed <= slotB.seed ? 'A' : 'B');
                const projectedWinnerSlot = outcome.winnerSlot || playDrawSlot;
                const projectedWinnerPlayer = projectedWinnerSlot === 'A' ? slotA : slotB;
                const contenders = outcome.isCompleted && outcome.winnerPlayer
                    ? [outcome.winnerPlayer]
                    : [...feederA.contenders, ...feederB.contenders].sort((a, b) => a.seed - b.seed);

                stageMatches.push({
                    stageIndex: stageIdx,
                    stageSize,
                    stageLabel,
                    realRoundNum,
                    matchIndex: mIdx,
                    matchNumber: mIdx + 1,
                    tableNumber: realMatch?.table_number || realMatch?.tableNumber || (mIdx + 1),
                    quadrantNum: feederA.quadrantNum,
                    bracketHalf: mIdx < Math.max(1, matchCount / 2) ? 'Górna połowa drabinki' : 'Dolna połowa drabinki',
                    highSeed: slotA?.seed || null,
                    lowSeed: slotB?.seed || null,
                    slotA,
                    slotB,
                    playDrawSlot,
                    ...outcome,
                    projectedWinnerSlot,
                    projectedWinnerPlayer,
                    contenders,
                    feederA,
                    feederB
                });
            }
        }

        rounds.push({
            stageIndex: stageIdx,
            stageSize,
            stageLabel,
            realRoundNum,
            matches: stageMatches
        });
    }

    const finalMatch = rounds[rounds.length - 1]?.matches?.[0] || null;
    const champion = finalMatch?.isCompleted ? finalMatch.winnerPlayer : null;
    const projectedChampion = finalMatch?.projectedWinnerPlayer || null;

    return {
        bracketSize,
        isTopCutActive: Boolean(stageZeroRoundNum !== null),
        firstElimRoundNum: stageZeroRoundNum,
        actualTournamentCutSize: topCutInfo.actualBracketSize || null,
        rounds,
        champion,
        projectedChampion
    };
}

function getPlayerBracketPath(playerId, bracketTree) {
    if (!playerId || !bracketTree || !bracketTree.rounds || bracketTree.rounds.length === 0) {
        return null;
    }

    const targetIdStr = String(playerId);
    const round0 = bracketTree.rounds[0];
    let matchIdx = -1;
    let myPlayer = null;

    for (let i = 0; i < round0.matches.length; i++) {
        const m = round0.matches[i];
        if (m.slotA && String(m.slotA.id) === targetIdStr) {
            matchIdx = i;
            myPlayer = m.slotA;
            break;
        }
        if (m.slotB && String(m.slotB.id) === targetIdStr) {
            matchIdx = i;
            myPlayer = m.slotB;
            break;
        }
    }

    if (matchIdx === -1 || !myPlayer) return null;

    const stages = [];
    let eliminatedInStage = null;
    let curMatchIdx = matchIdx;

    for (let stageIdx = 0; stageIdx < bracketTree.rounds.length; stageIdx++) {
        const rObj = bracketTree.rounds[stageIdx];
        const match = rObj.matches[curMatchIdx];
        if (!match) break;

        let mySide = 'A';
        if (stageIdx === 0) {
            mySide = (match.slotA && String(match.slotA.id) === targetIdStr) ? 'A' : 'B';
        } else {
            const prevMatchIdx = stages[stageIdx - 1].matchIndex;
            mySide = (prevMatchIdx % 2 === 0) ? 'A' : 'B';
        }

        const oppSlot = mySide === 'A' ? match.slotB : match.slotA;
        const oppFeeder = mySide === 'A' ? match.feederB : match.feederA;

        const decorateOpponent = (opp) => {
            if (!opp) return null;
            const myRole = myPlayer.seed < opp.seed ? 'PLAY' : 'DRAW';
            return {
                id: opp.id,
                seed: opp.seed,
                name: opp.name,
                points: opp.points,
                omwp: opp.omwp,
                myRole
            };
        };

        let confirmedOpponent = null;
        let potentialOpponents = [];

        if (stageIdx === 0) {
            confirmedOpponent = decorateOpponent(oppSlot);
            potentialOpponents = confirmedOpponent ? [confirmedOpponent] : [];
        } else {
            if (oppSlot && oppSlot.isConfirmed) {
                confirmedOpponent = decorateOpponent(oppSlot);
            }
            const rawContenders = oppFeeder?.contenders || (oppSlot ? [oppSlot] : []);
            potentialOpponents = rawContenders.map(decorateOpponent).filter(Boolean);
        }

        const projectedOpponent = confirmedOpponent || potentialOpponents[0] || decorateOpponent(oppSlot);

        let stageStatus = 'PROJECTED_UPCOMING';
        let myScore = null;
        let oppScore = null;

        if (eliminatedInStage !== null) {
            stageStatus = 'ELIMINATED_EARLIER';
        } else {
            const playerReachedThisMatch = stageIdx === 0 || stages[stageIdx - 1]?.stageStatus === 'WON';
            if (playerReachedThisMatch && match.isCompleted) {
                myScore = mySide === 'A' ? match.scoreA : match.scoreB;
                oppScore = mySide === 'A' ? match.scoreB : match.scoreA;
                if (match.winnerPlayer && String(match.winnerPlayer.id) === targetIdStr) {
                    stageStatus = 'WON';
                } else {
                    stageStatus = 'LOST';
                    eliminatedInStage = stageIdx;
                }
            } else if (playerReachedThisMatch && match.isInProgress) {
                stageStatus = 'IN_PROGRESS';
            } else if (confirmedOpponent) {
                stageStatus = 'CONFIRMED_UPCOMING';
            }
        }

        stages.push({
            stageIndex: stageIdx,
            stageSize: rObj.stageSize,
            stageLabel: rObj.stageLabel,
            realRoundNum: rObj.realRoundNum,
            matchIndex: curMatchIdx,
            matchNumber: match.matchNumber,
            tableNumber: match.tableNumber,
            stageStatus,
            myScore,
            oppScore,
            confirmedOpponent,
            projectedOpponent,
            potentialOpponents
        });

        curMatchIdx = Math.floor(curMatchIdx / 2);
    }

    return {
        player: myPlayer,
        bracketSize: bracketTree.bracketSize,
        isTopCutActive: bracketTree.isTopCutActive,
        eliminatedInStage,
        stages
    };
}

function analyzePlayerTopCutSeeding(targetPlayer, myOpponent, isCurrentMatchFinished, liveStandings, cutSize = 8) {
    if (!targetPlayer || !liveStandings || liveStandings.length === 0) return null;

    const seedsOrder = getBracketSeedOrder(cutSize);
    const bracketSize = seedsOrder.length;
    const topHalfCutoff = bracketSize / 2;
    const topQuarterCutoff = Math.max(1, bracketSize / 4);

    const targetId = String(targetPlayer.player?.id || targetPlayer.id);
    const oppId = myOpponent?.id ? String(myOpponent.id) : null;

    const sortBoard = (board) => {
        board.sort((a, b) => {
            if (b.simPts !== a.simPts) return b.simPts - a.simPts;
            if ((b.opponent_match_win_percentage || 0) !== (a.opponent_match_win_percentage || 0)) {
                return (b.opponent_match_win_percentage || 0) - (a.opponent_match_win_percentage || 0);
            }
            if ((b.game_win_percentage || 0) !== (a.game_win_percentage || 0)) {
                return (b.game_win_percentage || 0) - (a.game_win_percentage || 0);
            }
            return (b.opponent_game_win_percentage || 0) - (a.opponent_game_win_percentage || 0);
        });
    };

    const evalScenario = (targetDelta, oppDelta) => {
        const board = liveStandings.map(p => {
            const pid = String(p.player?.id || p.id);
            const currentPts = p.livePoints ?? p.match_points ?? 0;
            const baseUnfinishedPts = isCurrentMatchFinished ? currentPts : (p.match_points ?? currentPts);
            let simPts = currentPts;
            if (!isCurrentMatchFinished) {
                if (pid === targetId) simPts = baseUnfinishedPts + targetDelta;
                else if (oppId && pid === oppId) simPts = baseUnfinishedPts + oppDelta;
            }
            return { ...p, simPts, livePoints: simPts };
        });

        sortBoard(board);
        const idx = board.findIndex(p => String(p.player?.id || p.id) === targetId);
        const seed = idx !== -1 ? idx + 1 : 999;
        const inCut = seed <= bracketSize;
        const hasPlayDrawR1 = inCut && seed <= topHalfCutoff;
        const hasPlayDrawR2 = inCut && seed <= topQuarterCutoff;

        let r1OpponentSeed = null;
        let r1OpponentName = null;
        if (inCut) {
            r1OpponentSeed = bracketSize + 1 - seed;
            const oppObj = board[r1OpponentSeed - 1];
            if (oppObj) {
                r1OpponentName = formatStandingsPlayerName(oppObj);
            }
        }

        return {
            seed,
            points: board[idx]?.simPts ?? 0,
            inCut,
            hasPlayDrawR1,
            hasPlayDrawR2,
            roleR1: !inCut ? 'OUT' : (hasPlayDrawR1 ? 'PLAY' : 'DRAW'),
            r1OpponentSeed,
            r1OpponentName,
            simulatedBoard: board
        };
    };

    const current = evalScenario(0, 0);
    const scenarios = {
        WIN: isCurrentMatchFinished ? current : evalScenario(3, 0),
        TIE: isCurrentMatchFinished ? current : evalScenario(1, 1),
        LOSS: isCurrentMatchFinished ? current : evalScenario(0, 3)
    };

    return {
        bracketSize,
        topHalfCutoff,
        current,
        scenarios
    };
}

function renderPlayerBracketPathHtml(pathData, scenarioTitle = '') {
    if (!pathData || !pathData.stages || pathData.stages.length === 0) return '';

    const stagesHtml = pathData.stages.map((st, idx) => {
        const isFinal = st.stageSize === 2;
        let cardClass = 'path-stage-card';
        if (st.stageStatus === 'WON') cardClass += ' stage-won';
        else if (st.stageStatus === 'LOST' || st.stageStatus === 'ELIMINATED_EARLIER') cardClass += ' stage-lost';
        else if (isFinal) cardClass += ' stage-final';

        let statusBadge = '';
        if (st.stageStatus === 'WON') {
            const scoreTxt = (st.myScore !== null && st.oppScore !== null) ? ` (${st.myScore}:${st.oppScore})` : '';
            statusBadge = `<span style="color:#2ecc71; font-weight:800;">✅ WYGRANA${scoreTxt}</span>`;
        } else if (st.stageStatus === 'LOST') {
            const scoreTxt = (st.myScore !== null && st.oppScore !== null) ? ` (${st.myScore}:${st.oppScore})` : '';
            statusBadge = `<span style="color:#e74c3c; font-weight:800;">❌ PORAŻKA${scoreTxt}</span>`;
        } else if (st.stageStatus === 'ELIMINATED_EARLIER') {
            statusBadge = `<span style="color:#64748b;">Poza grą</span>`;
        } else if (st.stageStatus === 'IN_PROGRESS') {
            statusBadge = `<span style="color:#f39c12; font-weight:800;">⏳ W GRZE</span>`;
        } else if (st.confirmedOpponent) {
            statusBadge = `<span style="color:#38bdf8;">⚔️ Mecz #${st.matchNumber}</span>`;
        } else {
            statusBadge = `<span style="color:#94a3b8;">🔮 Projekcja</span>`;
        }

        const renderRolePill = (role) => role === 'PLAY'
            ? `<span class="play-draw-pill pill-play" title="Twój seed (#${pathData.player.seed}) jest wyższy od rywala — zaczynasz mecz (PLAY)">🟢 PLAY</span>`
            : `<span class="play-draw-pill pill-draw" title="Rywal ma wyższy seed po Swiss — zaczynasz jako drugi (DRAW)">🟡 DRAW</span>`;

        let oppsContent = '';
        if (st.confirmedOpponent) {
            const op = st.confirmedOpponent;
            oppsContent = `
                <div style="font-size: 11px; color: #94a3b8; margin-bottom: 2px;">Bezpośredni przeciwnik:</div>
                <div class="path-opp-item fav-opp" onclick="selectPlayerForTie('${escapeJsAttr(op.id)}')">
                    <div>
                        <span class="bracket-seed-badge">#${op.seed}</span>
                        <strong style="color:#fff;">${escapeHtml(op.name)}</strong>
                        <div style="font-size: 10.5px; color: #94a3b8; margin-top: 2px;">${op.points} pkt • OMW: ${op.omwp}%</div>
                    </div>
                    ${renderRolePill(op.myRole)}
                </div>
            `;
        } else {
            const topOpps = st.potentialOpponents.slice(0, 4);
            const extraCount = Math.max(0, st.potentialOpponents.length - topOpps.length);
            oppsContent = `
                <div style="font-size: 11px; color: #94a3b8; margin-bottom: 2px;">
                    Potencjalni rywale z sąsiedniej gałęzi (${st.potentialOpponents.length}):
                </div>
                ${topOpps.map((op, opIdx) => `
                    <div class="path-opp-item ${opIdx === 0 ? 'fav-opp' : ''}" onclick="selectPlayerForTie('${escapeJsAttr(op.id)}')">
                        <div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
                            <span class="bracket-seed-badge">#${op.seed}</span>
                            <span style="${opIdx === 0 ? 'font-weight:700; color:#fff;' : 'color:#cbd5e1;'}">${escapeHtml(op.name)}</span>
                            ${opIdx === 0 ? `<span style="font-size:10px; color:#f1c40f; margin-left:3px;" title="Najwyższy seed w przeciwnej gałęzi">★ Faworyt</span>` : ''}
                        </div>
                        ${renderRolePill(op.myRole)}
                    </div>
                `).join('')}
                ${extraCount > 0 ? `<div style="font-size: 10.5px; color: #64748b; text-align: right;">+ ${extraCount} innych niższych seedów (wszystkie 🟢 PLAY lub wg seedu)</div>` : ''}
            `;
        }

        return `
            <div class="${cardClass}">
                <div class="path-stage-header">
                    <span>${idx + 1}. ${escapeHtml(st.stageLabel)}</span>
                    ${statusBadge}
                </div>
                ${oppsContent}
            </div>
        `;
    }).join('');

    return `
        <div class="player-bracket-path-box">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
                <div style="font-size: 13px; font-weight: 800; color: #f8fafc;">
                    🗺️ Ścieżka w Drabince Pucharowej: <span style="color: #f1c40f;">Seed #${pathData.player.seed} ${escapeHtml(pathData.player.name)}</span>
                    ${scenarioTitle ? `<span style="font-size: 11px; color: #38bdf8; margin-left: 6px;">(${escapeHtml(scenarioTitle)})</span>` : ''}
                </div>
                <div style="font-size: 11px; color: #94a3b8;">
                    Kliknij dowolnego rywala, aby przeanalizować jego profil
                </div>
            </div>
            <div class="player-bracket-path-grid">
                ${stagesHtml}
            </div>
        </div>
    `;
}

function renderPlayDrawSeedingPanel(targetPlayer, myOpponent, isCurrentMatchFinished, liveStandings, cutSize) {
    const panel = document.getElementById('playDrawSeedingPanel');
    const badgeEl = document.getElementById('playDrawCurrentBadge');
    const bodyEl = document.getElementById('playDrawSeedingBody');
    if (!panel || !badgeEl || !bodyEl) return;

    const analysis = analyzePlayerTopCutSeeding(targetPlayer, myOpponent, isCurrentMatchFinished, liveStandings, cutSize);
    if (!analysis) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    const targetId = String(targetPlayer.player?.id || targetPlayer.id);
    const roundsMatches = latestData?.roundsMatches || null;

    // Sprawdzamy, czy gracz już uczestniczy w rzeczywistej fazie Top Cut
    const realBracketTree = buildFullTopCutBracketTree(liveStandings, cutSize, roundsMatches, cachedStandingsMap);
    const realPlayerPath = getPlayerBracketPath(targetId, realBracketTree);

    const cur = analysis.current;
    const effectiveSeed = realPlayerPath ? realPlayerPath.player.seed : cur.seed;
    const effectiveInCut = Boolean(realPlayerPath || cur.inCut);
    const effectiveHasPlayDrawR1 = effectiveInCut && effectiveSeed <= analysis.topHalfCutoff;

    badgeEl.style.background = '';
    badgeEl.style.color = '';
    badgeEl.style.border = '';

    if (effectiveInCut) {
        if (effectiveHasPlayDrawR1) {
            badgeEl.className = 'play-draw-pill pill-play';
            badgeEl.innerText = `SEED #${effectiveSeed} — PRZYWILEJ PLAY 🟢`;
        } else {
            badgeEl.className = 'play-draw-pill pill-draw';
            badgeEl.innerText = `SEED #${effectiveSeed} — NA DRAW 🟡`;
        }
    } else {
        badgeEl.className = 'play-draw-pill';
        badgeEl.style.background = 'rgba(231, 76, 60, 0.2)';
        badgeEl.style.color = '#e74c3c';
        badgeEl.style.border = '1px solid #e74c3c';
        badgeEl.innerText = `SEED #${cur.seed} (POZA TOP ${analysis.bracketSize})`;
    }

    const formatScen = (label, sc, color) => {
        if (!sc.inCut) {
            return `<div>• <strong>${label} (${sc.points} pkt):</strong> Miejsce <strong>#${sc.seed}</strong> — <span style="color:#e74c3c;">Poza Top ${analysis.bracketSize}</span></div>`;
        }
        const pdBadge = sc.hasPlayDrawR1
            ? `<span style="color:#2ecc71; font-weight:bold;">🟢 ZACZYNASZ (PLAY w R1${sc.hasPlayDrawR2 ? ' i R2' : ''})</span>`
            : `<span style="color:#f1c40f; font-weight:bold;">🟡 DRUGI GRACZ (DRAW w R1)</span>`;
        return `<div>• <strong style="color:${color};">${label} (${sc.points} pkt):</strong> Seed <strong>#${sc.seed}</strong> (${pdBadge}) — mecz w R1 Top Cut vs <strong>#${sc.r1OpponentSeed} ${escapeHtml(sc.r1OpponentName || '')}</strong></div>`;
    };

    let tacticalTip = '';
    const { WIN, TIE } = analysis.scenarios;
    if (!isCurrentMatchFinished && !realBracketTree.isTopCutActive && TIE.inCut && WIN.inCut) {
        if (!TIE.hasPlayDrawR1 && WIN.hasPlayDrawR1) {
            tacticalTip = `<div style="margin-top: 8px; padding: 8px 10px; background: rgba(241, 196, 15, 0.12); border-left: 3px solid #f1c40f; border-radius: 4px; color: #fde68a;">
                💡 <strong>Dylemat Play/Draw (Top Half Seeding):</strong> Remis (ID) daje Ci miejsce w Top Cut (#${TIE.seed}), ale spadniesz do dolnej połowy drabinki (będziesz na <strong>DRAW</strong> w R1!). Wygrana daje Ci <strong>Seed #${WIN.seed}</strong> (Top ${analysis.topHalfCutoff}) i przywilej rozpoczynania gry (<strong>PLAY</strong>)!
            </div>`;
        } else if (TIE.hasPlayDrawR1) {
            tacticalTip = `<div style="margin-top: 8px; padding: 8px 10px; background: rgba(46, 204, 113, 0.12); border-left: 3px solid #2ecc71; border-radius: 4px; color: #bbf7d0;">
                ✅ <strong>Komfortowy ID z Play/Draw:</strong> Nawet po wzięciu remisu (ID) utrzymasz Seed <strong>#${TIE.seed}</strong> w górnej połowie (Top ${analysis.topHalfCutoff}) i zachowasz przywilej <strong>PLAY</strong> w 1. rundzie Top Cutu!
            </div>`;
        }
    }

    // Budujemy pełną ścieżkę matchupów w drabince Top Cut dla wybranego gracza
    let bracketPathSectionHtml = '';
    if (realBracketTree.isTopCutActive && realPlayerPath) {
        bracketPathSectionHtml = renderPlayerBracketPathHtml(realPlayerPath, 'Faza pucharowa Top Cut');
    } else {
        // Jeśli mecz w Swiss jeszcze trwa, pozwalamy przełączać podgląd ścieżki w drabince pomiędzy Aktualnym Seedem / Po WIN / Po ID
        const availableModes = [];
        if (cur.inCut) availableModes.push({ key: 'CURRENT', label: `Aktualnie (Seed #${cur.seed})`, sc: cur });
        if (!isCurrentMatchFinished && WIN.inCut) availableModes.push({ key: 'WIN', label: `Po WYGRANEJ (Seed #${WIN.seed})`, sc: WIN });
        if (!isCurrentMatchFinished && TIE.inCut) availableModes.push({ key: 'TIE', label: `Po REMISIE / ID (Seed #${TIE.seed})`, sc: TIE });

        if (availableModes.length > 0) {
            const activeModeObj = availableModes.find(m => m.key === playerPathScenarioMode) || availableModes[0];
            const simTree = buildFullTopCutBracketTree(activeModeObj.sc.simulatedBoard, cutSize, null, cachedStandingsMap);
            const simPath = getPlayerBracketPath(targetId, simTree);

            const modeButtonsHtml = availableModes.length > 1 ? `
                <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px;">
                    ${availableModes.map(m => `
                        <button type="button" class="bracket-mode-btn ${m.key === activeModeObj.key ? 'active' : ''}" onclick="setPlayerPathScenarioMode('${m.key}')">
                            ${escapeHtml(m.label)}
                        </button>
                    `).join('')}
                </div>
            ` : '';

            bracketPathSectionHtml = modeButtonsHtml + renderPlayerBracketPathHtml(simPath, activeModeObj.label);
        }
    }

    const swissScenariosSummary = realBracketTree.isTopCutActive ? `
        <div style="margin-bottom: 6px; color: #fde68a;">
            ⚡ Turniej znajduje się w <strong>fazie pucharowej (Top ${realBracketTree.bracketSize})</strong>. Rozstawienie po rundach Swiss oraz przywilej <strong>PLAY / DRAW</strong> obowiązują przez całą drabinkę!
        </div>
    ` : `
        <div style="margin-bottom: 6px;">
            W fazie pucharowej Lorcany wyższy seed po fazie Swiss (w R1 miejsca <strong>#1 – #${analysis.topHalfCutoff}</strong>) zawsze wybiera kto zaczyna mecz (<strong>🟢 PLAY</strong>), a niższy seed jest na <strong>🟡 DRAW</strong>.
        </div>
        ${formatScen('Po WYGRANEJ (WIN)', analysis.scenarios.WIN, '#2ecc71')}
        ${formatScen('Po REMISIE (ID)', analysis.scenarios.TIE, '#f1c40f')}
        ${formatScen('Po PORAŻCE (LOSS)', analysis.scenarios.LOSS, '#e74c3c')}
        ${tacticalTip}
    `;

    bodyEl.innerHTML = `
        ${swissScenariosSummary}
        ${bracketPathSectionHtml}
    `;
}

function renderTopCutBracketPanel(liveStandings, cutSize) {
    const panel = document.getElementById('topCutBracketPanel');
    const gridEl = document.getElementById('topCutBracketGrid');
    const statusTextEl = document.getElementById('bracketPhaseStatusText');
    const selectedBannerEl = document.getElementById('bracketSelectedPlayerBanner');
    if (!panel || !gridEl) return;

    if (!liveStandings || liveStandings.length === 0) {
        panel.style.display = 'none';
        return;
    }

    const roundsMatches = latestData?.roundsMatches || null;
    const tree = buildFullTopCutBracketTree(liveStandings, cutSize, roundsMatches, cachedStandingsMap);
    if (!tree.rounds || tree.rounds.length === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    setElText('bracketSizeTitle', tree.bracketSize);

    if (statusTextEl) {
        if (tree.isTopCutActive) {
            statusTextEl.innerHTML = `🔥 <strong>Trwa / zakończono fazę pucharową Top ${tree.bracketSize}</strong> (od Rundy ${tree.firstElimRoundNum}). Drzewko pokazuje rzeczywiste wyniki meczów oraz przywilej <strong>🟢 PLAY / 🟡 DRAW</strong> wg oryginalnego Seedu po Swiss!`;
        } else if (tree.actualTournamentCutSize && tree.actualTournamentCutSize !== tree.bracketSize) {
            statusTextEl.innerHTML = `ℹ️ Ten turniej miał fazę pucharową <strong>Top ${tree.actualTournamentCutSize}</strong> (wybrano widok Top ${tree.bracketSize}). Przełącz próg odcięcia na <strong>Top ${tree.actualTournamentCutSize}</strong>, aby zobaczyć pełne wyniki od 1. rundy pucharowej!`;
        } else {
            statusTextEl.innerHTML = `Oficjalne drzewko pucharowe (od 1. rundy Top ${tree.bracketSize} aż do Finału) na podstawie tabeli LIVE. W każdej rundzie wyższy seed po fazie Swiss ma przywilej <strong>🟢 PLAY</strong>!`;
        }
    }

    // Jeśli wybrany jest gracz, sprawdzamy jego ścieżkę w tej drabince i podświetlamy wszystkie jego mecze
    const selectedPath = currentSelectedPlayerId ? getPlayerBracketPath(currentSelectedPlayerId, tree) : null;
    const selectedStageMatchKeys = new Set();
    if (selectedPath) {
        selectedPath.stages.forEach(st => {
            selectedStageMatchKeys.add(`${st.stageIndex}_${st.matchIndex}`);
        });
    }

    if (selectedBannerEl) {
        if (selectedPath) {
            const pathSummaryParts = selectedPath.stages.map(st => {
                const opp = st.confirmedOpponent || st.projectedOpponent;
                const roleIcon = opp ? (opp.myRole === 'PLAY' ? '🟢 PLAY' : '🟡 DRAW') : '';
                const oppText = opp ? `#${opp.seed} ${escapeHtml(opp.name)} (${roleIcon})` : 'TBD';
                return `<span style="white-space:nowrap;"><strong>${escapeHtml(st.stageLabel)}:</strong> vs ${oppText}</span>`;
            });
            selectedBannerEl.style.display = 'block';
            selectedBannerEl.innerHTML = `
                <div style="background: rgba(52, 152, 219, 0.14); border: 1px solid #3498db; border-left: 4px solid #f1c40f; border-radius: 6px; padding: 8px 12px; font-size: 12px; color: #e2e8f0;">
                    <div style="font-weight: 800; color: #fff; margin-bottom: 4px;">
                        🎯 Podświetlona ścieżka w drabince: <span style="color:#f1c40f;">Seed #${selectedPath.player.seed} ${escapeHtml(selectedPath.player.name)}</span>
                    </div>
                    <div style="display: flex; flex-wrap: wrap; gap: 6px 14px; color: #cbd5e1; font-size: 11.5px;">
                        ${pathSummaryParts.join(' <span style="color:#64748b;">➔</span> ')}
                    </div>
                </div>
            `;
        } else {
            selectedBannerEl.style.display = 'none';
            selectedBannerEl.innerHTML = '';
        }
    }

    // Jeśli włączony filtr Tylko Polacy, sprawdzamy czy w drabince jest chociaż jeden Polak
    if (filterOnlyPoles) {
        const anyPoleInCut = tree.rounds[0].matches.some(m =>
            (m.slotA && isPolishPlayer(m.slotA.raw, cachedStandingsMap)) ||
            (m.slotB && isPolishPlayer(m.slotB.raw, cachedStandingsMap))
        );
        if (!anyPoleInCut) {
            gridEl.innerHTML = `<div style="padding: 18px; color: #888; text-align: center;">Brak polskich graczy w prognozowanej drabince Top ${tree.bracketSize}.</div>`;
            return;
        }
    }

    const renderSlotRow = (slotPlayer, feeder, side, match) => {
        const showProjected = bracketDisplayMode === 'projected';
        const isConfirmed = Boolean(slotPlayer && slotPlayer.isConfirmed);
        const displayPlayer = (isConfirmed || showProjected) ? slotPlayer : null;

        const isWinner = match.isCompleted && match.winnerSlot === side;
        const isEliminated = match.isCompleted && match.winnerSlot && match.winnerSlot !== side;
        const isSelectedPlayer = displayPlayer && currentSelectedPlayerId && String(displayPlayer.id) === String(currentSelectedPlayerId);

        const hasPlayDraw = match.playDrawSlot === side;
        const rowSeedClass = hasPlayDraw ? 'bracket-high-seed' : 'bracket-low-seed';
        const winnerClass = isWinner ? 'bracket-winner-row' : (isEliminated ? 'bracket-eliminated-row' : '');
        const selectedRowClass = isSelectedPlayer ? 'bracket-selected-player-row' : '';

        if (!displayPlayer) {
            const feederSeeds = feeder ? feeder.contenders.slice(0, 2).map(c => `#${c.seed}`).join(' / ') : 'TBD';
            const feederLabel = feeder ? `Zwycięzca M#${feeder.matchNumber} (${feederSeeds})` : 'TBD';
            return `
                <div class="bracket-player-row ${rowSeedClass}" style="cursor: default; opacity: 0.75;">
                    <div style="color: #94a3b8; font-style: italic; font-size: 11.5px;">${escapeHtml(feederLabel)}</div>
                    <span class="play-draw-pill ${hasPlayDraw ? 'pill-play' : 'pill-draw'}">${hasPlayDraw ? '🟢 PLAY' : '🟡 DRAW'}</span>
                </div>
            `;
        }

        const scoreVal = side === 'A' ? match.scoreA : match.scoreB;
        const scoreBadge = (match.isCompleted && scoreVal !== null)
            ? `<span class="bracket-score-pill ${isWinner ? 'win' : ''}">${scoreVal}</span>`
            : '';

        const projTag = !isConfirmed
            ? `<span style="font-size: 9.5px; color: #38bdf8; margin-left: 3px; font-weight: 600;" title="Projekcja awansu wyższego seedu">(Proj.)</span>`
            : '';

        const metaSub = match.stageIndex === 0
            ? `<span style="font-size: 10.5px; color: #94a3b8; margin-left: 3px;">(${displayPlayer.points}p, ${displayPlayer.omwp}%)</span>`
            : projTag;

        return `
            <div class="bracket-player-row ${rowSeedClass} ${winnerClass} ${selectedRowClass}" onclick="selectPlayerForTie('${escapeJsAttr(displayPlayer.id)}')">
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
                    <span class="bracket-seed-badge">#${displayPlayer.seed}</span>
                    <span>${escapeHtml(displayPlayer.name)}</span>
                    ${metaSub}
                </div>
                <div style="display: flex; align-items: center; gap: 4px; flex-shrink: 0;">
                    <span class="play-draw-pill ${hasPlayDraw ? 'pill-play' : 'pill-draw'}" title="${hasPlayDraw ? 'Wyższy seed po Swiss — wybiera PLAY/DRAW' : 'Niższy seed po Swiss — na DRAW'}">
                        ${hasPlayDraw ? '🟢 PLAY' : '🟡 DRAW'}
                    </span>
                    ${scoreBadge}
                </div>
            </div>
        `;
    };

    const columnsHtml = tree.rounds.map(rObj => {
        const completedInStage = rObj.matches.filter(m => m.isCompleted).length;
        const roundSubText = completedInStage > 0
            ? `${completedInStage}/${rObj.matches.length} zakończone`
            : (rObj.realRoundNum ? `Runda ${rObj.realRoundNum}` : `${rObj.matches.length} ${rObj.matches.length === 1 ? 'mecz' : 'mecze/ów'}`);

        const matchesHtml = rObj.matches.map(m => {
            const isSelectedPathMatch = selectedStageMatchKeys.has(`${m.stageIndex}_${m.matchIndex}`);
            let matchStatusTag = '';
            if (m.isCompleted) {
                matchStatusTag = `<span style="color:#2ecc71;">✅ Zakończony</span>`;
            } else if (m.isInProgress && tree.isTopCutActive) {
                matchStatusTag = `<span style="color:#f39c12;">⏳ Stół #${escapeHtml(m.tableNumber)}</span>`;
            } else if (m.stageIndex === 0) {
                matchStatusTag = `<span>Ćwiartka ${m.quadrantNum} • #${m.highSeed} vs #${m.lowSeed}</span>`;
            } else {
                matchStatusTag = `<span>M#${m.feederA.matchNumber} vs M#${m.feederB.matchNumber}</span>`;
            }

            return `
                <div class="bracket-match-card ${isSelectedPathMatch ? 'selected-in-bracket' : ''}">
                    <div class="bracket-match-header">
                        <span>Mecz #${m.matchNumber} ${m.stageIndex === 0 ? `(Stół #${escapeHtml(m.tableNumber)})` : ''}</span>
                        ${matchStatusTag}
                    </div>
                    ${renderSlotRow(m.slotA, m.feederA, 'A', m)}
                    ${renderSlotRow(m.slotB, m.feederB, 'B', m)}
                </div>
            `;
        }).join('');

        return `
            <div class="bracket-round-col">
                <div class="bracket-round-header">
                    <span class="bracket-round-title">${escapeHtml(rObj.stageLabel)}</span>
                    <span class="bracket-round-sub">${escapeHtml(roundSubText)}</span>
                </div>
                <div class="bracket-round-matches">
                    ${matchesHtml}
                </div>
            </div>
        `;
    }).join('');

    // Kolumna Triumfatora na końcu drzewka
    const champ = tree.champion || (bracketDisplayMode === 'projected' ? tree.projectedChampion : null);
    const isRealChamp = Boolean(tree.champion);
    const championColHtml = `
        <div class="bracket-round-col" style="width: 230px;">
            <div class="bracket-round-header" style="border-top-color: #2ecc71;">
                <span class="bracket-round-title">${isRealChamp ? '🏆 Zwycięzca' : '👑 Faworyt Drabinki'}</span>
                <span class="bracket-round-sub">Top 1</span>
            </div>
            <div class="bracket-round-matches">
                <div class="bracket-champion-card" ${champ ? `style="cursor:pointer;" onclick="selectPlayerForTie('${escapeJsAttr(champ.id)}')"` : ''}>
                    <div style="font-size: 28px; margin-bottom: 6px;">🏆</div>
                    <div style="font-size: 11px; color: #fde68a; text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px;">
                        ${isRealChamp ? 'Mistrz Turnieju' : 'Projektowany Triumfator'}
                    </div>
                    ${champ ? `
                        <div style="font-size: 15px; font-weight: 800; color: #fff; margin-top: 6px;">
                            <span class="bracket-seed-badge">#${champ.seed}</span> ${escapeHtml(champ.name)}
                        </div>
                        <div style="font-size: 11px; color: #cbd5e1; margin-top: 4px;">
                            Swiss: ${champ.points} pkt • OMW: ${champ.omwp}%
                        </div>
                    ` : `
                        <div style="font-size: 13px; color: #94a3b8; margin-top: 6px; font-style: italic;">
                            Oczekiwanie na rozstrzygnięcie Finału
                        </div>
                    `}
                </div>
            </div>
        </div>
    `;

    gridEl.innerHTML = `<div class="bracket-tree">${columnsHtml}${championColHtml}</div>`;
}

// -------------------------------------------------------------
// SZYBKI SYMULATOR „WHAT-IF” DLA SĄSIEDNICH STOŁÓW BUBBLE
// -------------------------------------------------------------

function renderBubbleNeighborsWhatIf(targetPlayer, pairingsList, standingsMap, cutSize) {
    const panel = document.getElementById('bubbleNeighborsWhatIfPanel');
    const listEl = document.getElementById('bubbleNeighborsList');
    if (!panel || !listEl) return;

    if (!pairingsList || pairingsList.length === 0 || !cachedLiveStandings || cachedLiveStandings.length === 0) {
        panel.style.display = 'none';
        return;
    }

    const bubbleIdx = Math.min(Math.max(1, cutSize) - 1, cachedLiveStandings.length - 1);
    const bubblePts = cachedLiveStandings[bubbleIdx]?.livePoints ?? cachedLiveStandings[bubbleIdx]?.match_points ?? 0;
    const targetPts = targetPlayer.livePoints ?? targetPlayer.match_points ?? bubblePts;

    // Wybieramy stoły wokół progu Bubble oraz koszyka punktowego wybranego gracza
    const scoredMatches = [];
    pairingsList.forEach((m, idx) => {
        const raw2 = getMatchParticipant(m, 2);
        const isBye = m.is_bye || m.bye || !raw2 || m.round_type === 'BYE';
        if (isBye) return;

        const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
        const p2 = resolvePlayer(raw2, standingsMap);
        if (!p1 || !p2) return;

        const s1 = p1.raw || cachedLiveStandings.find(s => String(s.player?.id || s.id) === String(p1.id));
        const s2 = p2.raw || cachedLiveStandings.find(s => String(s.player?.id || s.id) === String(p2.id));
        const pts1 = s1 ? (s1.livePoints ?? s1.match_points ?? 0) : 0;
        const pts2 = s2 ? (s2.livePoints ?? s2.match_points ?? 0) : 0;
        const maxPts = Math.max(pts1, pts2);

        const { hasScore, winnerId } = getMatchScores(m);
        const statusRaw = (m.status || m.state || "").toUpperCase();
        const isComplete = statusRaw === "COMPLETE" || statusRaw === "FINISHED" || statusRaw === "COMPLETED" || winnerId != null || hasScore;

        const key = getMatchWhatIfKey(m, idx);
        const activeOverride = whatIfOverrides.get(key) || null;

        // Priorytet mają stoły jeszcze trwające lub ręcznie zmienione przez użytkownika blisko progu Bubble
        const distFromTarget = Math.min(Math.abs(maxPts - targetPts), Math.abs(maxPts - bubblePts));
        const priority = (activeOverride ? -100 : (isComplete ? 50 : 0)) + distFromTarget;

        scoredMatches.push({
            match: m,
            idx,
            key,
            tableNum: m.table_number || m.tableNumber || (idx + 1),
            p1,
            p2,
            pts1,
            pts2,
            activeOverride,
            isComplete,
            priority
        });
    });

    scoredMatches.sort((a, b) => a.priority - b.priority || a.tableNum - b.tableNum);
    const topNeighbors = scoredMatches.slice(0, 6);

    if (topNeighbors.length === 0) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    listEl.innerHTML = topNeighbors.map(item => {
        const ov = item.activeOverride;
        const safeKey = escapeJsAttr(item.key);
        return `
            <div class="candidate-card" style="${ov ? 'border-color: #f39c12; background: rgba(243, 156, 18, 0.12);' : ''}">
                <div style="flex: 1; padding-right: 8px;">
                    <div class="candidate-name" style="font-size: 13px;">Stół #${escapeHtml(item.tableNum)}: ${escapeHtml(item.p1.name)} <span style="color:#888;">vs</span> ${escapeHtml(item.p2.name)}</div>
                    <div class="candidate-sub">Pkt: <strong>${item.pts1}</strong> vs <strong>${item.pts2}</strong> ${ov ? `<span style="color:#f39c12; font-weight:bold;">(What-If: ${escapeHtml(ov)})</span>` : (item.isComplete ? '(Zakończony)' : '(W grze)')}</div>
                </div>
                <div class="whatif-btn-group">
                    <button type="button" class="whatif-btn ${ov === 'P1_WIN' ? 'active-w1' : ''}" onclick="setWhatIfOverride('${safeKey}', 'P1_WIN')" title="Wygrywa ${escapeHtml(item.p1.name)}">1</button>
                    <button type="button" class="whatif-btn ${ov === 'DRAW' ? 'active-tie' : ''}" onclick="setWhatIfOverride('${safeKey}', 'DRAW')" title="Remis (ID)">ID</button>
                    <button type="button" class="whatif-btn ${ov === 'P2_WIN' ? 'active-w2' : ''}" onclick="setWhatIfOverride('${safeKey}', 'P2_WIN')" title="Wygrywa ${escapeHtml(item.p2.name)}">2</button>
                    ${ov ? `<button type="button" class="whatif-btn whatif-reset-mini" onclick="setWhatIfOverride('${safeKey}', null)" title="Resetuj stół">✕</button>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        escapeHtml,
        escapeJsAttr,
        runLiveTieSimulation,
        derivePlayerStrategy,
        getCutStatusCategory,
        getCutStatusBadge,
        buildStandingsMap,
        extractPairingsList,
        resolvePlayer,
        getMatchParticipant,
        getMatchScores,
        getDefaultTotalRounds,
        getPlayerHistoricalMatches,
        getMatchWhatIfKey,
        applyWhatIfToPairings,
        computeWhatIfEffectiveData,
        calculateCutLineBreakdown,
        getBracketSeedOrder,
        getBracketStageLabel,
        generateTopCutBracket,
        detectActualTopCutInfo,
        buildFullTopCutBracketTree,
        getPlayerBracketPath,
        analyzePlayerTopCutSeeding
    };
}