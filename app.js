let trackingInterval = null;
let latestData = null;
let currentSelectedPlayerId = null;

function toggleTokenPanel() {
    const p = document.getElementById('tokenPanel');
    p.style.display = p.style.display === 'block' ? 'none' : 'block';
}

async function saveToken() {
    const token = document.getElementById('tokenInput').value.trim();
    const formData = new FormData();
    formData.append('set_token', token);

    try {
        const res = await fetch('api.php', { method: 'POST', body: formData });
        const data = await res.json();
        alert(data.message || 'Zapisano token!');
        toggleTokenPanel();
        startTracking();
    } catch (e) {
        alert('Błąd podczas zapisywania tokena.');
    }
}

function startTracking() {
    const eventId = document.getElementById('eventId').value;
    document.getElementById('status').innerText = "Status: Pobieranie danych...";
    
    fetchData(eventId);
    if (trackingInterval) clearInterval(trackingInterval);
    trackingInterval = setInterval(() => fetchData(eventId), 20000);
}

async function fetchData(eventId) {
    try {
        const response = await fetch(`api.php?eventId=${eventId}&t=${Date.now()}`);
        const data = await response.json();
        
        if (data.error) {
            document.getElementById('status').innerText = "BŁĄD: " + data.error;
            return;
        }
        
        latestData = data;
        document.getElementById('statsPanel').style.display = "block";
        processPairings(data);
        processStandings(data);
        
        if (currentSelectedPlayerId) {
            recalculateTieForSelectedPlayer();
        }
        
        document.getElementById('status').innerText = "Zaktualizowano: " + new Date().toLocaleTimeString();
    } catch (error) {
        console.error(error);
        document.getElementById('status').innerText = "Błąd komunikacji z serwerem.";
    }
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
        
        // Indeksujemy po wszystkich możliwych ID, jakie API może odesłać w meczu
        if (p.id) map.set(String(p.id), playerObj);
        if (p.player?.id) map.set(String(p.player.id), playerObj);
        if (p.user_event_status?.id) map.set(String(p.user_event_status.id), playerObj);
        if (p.user_event_status?.user?.id) map.set(String(p.user_event_status.user.id), playerObj);
    });
    
    return map;
}

function getMatchParticipant(match, slotIndex) {
    if (slotIndex === 1) {
        return match.player_1 ?? match.player1 ?? match.team_1 ?? match.team1 ?? match.competitor_1 ?? match.competitor1 ?? 
               match.team_1_id ?? match.player_1_id ?? match.competitor_1_id ??
               match.participants?.[0] ?? match.tournament_match_participants?.[0] ?? match.competitors?.[0] ?? match.players?.[0] ?? match.teams?.[0] ?? null;
    } else {
        return match.player_2 ?? match.player2 ?? match.team_2 ?? match.team2 ?? match.competitor_2 ?? match.competitor2 ?? 
               match.team_2_id ?? match.player_2_id ?? match.competitor_2_id ??
               match.participants?.[1] ?? match.tournament_match_participants?.[1] ?? match.competitors?.[1] ?? match.players?.[1] ?? match.teams?.[1] ?? null;
    }
}

function resolvePlayer(rawParticipant, standingsMap) {
    if (rawParticipant === null || rawParticipant === undefined) return null;
    
    // 1. Jeśli to bezpośrednio liczba lub ciąg cyfr (ID)
    if (typeof rawParticipant === 'number' || (typeof rawParticipant === 'string' && /^\d+$/.test(rawParticipant))) {
        const found = standingsMap.get(String(rawParticipant));
        if (found) return found;
        return { id: Number(rawParticipant), name: `Gracz #${rawParticipant}` };
    }
    
    // 2. Jeśli to obiekt, sprawdzamy po jego polach ID
    if (typeof rawParticipant === 'object') {
        const possibleIds = [
            rawParticipant.id,
            rawParticipant.player_id,
            rawParticipant.user_id,
            rawParticipant.team_id,
            rawParticipant.user_event_status_id,
            rawParticipant.competitor_id,
            rawParticipant.player?.id,
            rawParticipant.user_event_status?.id,
            rawParticipant.user?.id
        ].filter(Boolean);
        
        for (const id of possibleIds) {
            const found = standingsMap.get(String(id));
            if (found) return found;
        }
        
        // 3. Jeśli nie ma w słowniku, sprawdzamy bezpośrednie pole tekstowe
        const directName = rawParticipant.best_identifier ||
                           rawParticipant.player?.best_identifier ||
                           rawParticipant.user_event_status?.best_identifier ||
                           rawParticipant.display_name ||
                           rawParticipant.name ||
                           rawParticipant.playerName ||
                           rawParticipant.username ||
                           rawParticipant.team_name ||
                           rawParticipant.user?.best_identifier ||
                           rawParticipant.user?.username;
                           
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
    
    let parts = rawName.trim().split(/\s+/);
    if (parts.length > 1) {
        let firstName = parts[0];
        let lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
        return `${nickname} (${firstName} ${lastInitial}.)`;
    }
    return `${nickname}`;
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
    const tbody = document.getElementById('pairingsBody');
    const roundNumSpan = document.getElementById('pairingsRoundNum');
    const progressSpan = document.getElementById('matchesProgress');
    
    roundNumSpan.innerText = data.activeRound || "-";
    const pairingsList = extractPairingsList(data.pairings);
    const standingsList = data.standings?.standings || [];
    const standingsMap = buildStandingsMap(standingsList);

    if (!pairingsList || pairingsList.length === 0) {
        let hint = data.hasTokenConfigured ? "Brak meczów dla tej rundy." : "Wymagany Token API do podglądu stołów.";
        tbody.innerHTML = `<tr><td colspan="5" style="color: #e67e22; padding: 15px;">${hint}</td></tr>`;
        progressSpan.innerText = "0 zakończonych";
        return;
    }

    tbody.innerHTML = "";
    let completedCount = 0;

    pairingsList.forEach((match, idx) => {
        const tr = document.createElement('tr');
        const tableNum = match.table_number || match.tableNumber || (idx + 1);
        
        const raw1 = getMatchParticipant(match, 1);
        const raw2 = getMatchParticipant(match, 2);
        
        const p1 = resolvePlayer(raw1, standingsMap);
        const isBye = match.is_bye || match.bye || !raw2 || match.round_type === 'BYE';
        const p2 = isBye ? { id: null, name: "BYE (Wolny los)" } : resolvePlayer(raw2, standingsMap);
        
        const name1 = p1 ? p1.name : "Nieznany";
        const name2 = isBye ? "BYE" : (p2 ? p2.name : "Nieznany");
        
        const score1 = match.player_1_game_wins ?? match.score_1 ?? match.team_1_score ?? 0;
        const score2 = match.player_2_game_wins ?? match.score_2 ?? match.team_2_score ?? 0;
        
        const statusRaw = (match.status || match.state || "").toUpperCase();
        let statusBadge = "";
        
        if (isBye) {
            statusBadge = `<span class="badge badge-bye">BYE</span>`;
            completedCount++;
        } else if (statusRaw === "COMPLETE" || statusRaw === "FINISHED" || match.winner_id != null || (score1 + score2 > 0 && statusRaw !== "IN_PROGRESS")) {
            statusBadge = `<span class="badge badge-complete">Koniec</span>`;
            completedCount++;
        } else {
            statusBadge = `<span class="badge badge-live">Live</span>`;
        }

        tr.innerHTML = `
            <td><strong>#${tableNum}</strong></td>
            <td>${name1}</td>
            <td class="score-box">${score1}:${score2}</td>
            <td>${name2}</td>
            <td>${statusBadge}</td>
        `;
        tbody.appendChild(tr);
    });

    progressSpan.innerText = `${completedCount}/${pairingsList.length} wpisane`;
}

// -------------------------------------------------------------
// TABELA GENERALNA (STANDINGS)
// -------------------------------------------------------------

function processStandings(data) {
    const cutSize = parseInt(document.getElementById('cutSize').value);
    const cutRule = document.getElementById('cutRule').value;
    const standings = data.standings?.standings || [];
    
    document.getElementById('eventNameDisplay').innerText = data.eventName;
    document.getElementById('totalPlayersDisplay').innerText = data.playerCount;
    document.getElementById('activeRoundInfo').innerText = `${data.activeRound}/${data.totalRounds}`;
    document.getElementById('standingsRoundInfo').innerText = `${data.standingsRound}/${data.totalRounds}`;
    
    if (!standings || standings.length === 0) return;
    standings.sort((a, b) => b.match_points - a.match_points);
    
    let bubbleIndex = Math.min(cutSize - 1, standings.length - 1);
    let currentBubbleScore = standings[bubbleIndex].match_points;
    let playersInCut = 0;

    if (cutRule === 'soft') {
        playersInCut = standings.filter(p => p.match_points >= currentBubbleScore).length;
    } else {
        playersInCut = cutSize;
    }

    let projectedFinalBubble = 0;
    if (data.standingsRound > 0) {
        let pointsPerRound = currentBubbleScore / data.standingsRound;
        projectedFinalBubble = Math.ceil(pointsPerRound * data.totalRounds);
    }

    document.getElementById('bubbleScore').innerText = currentBubbleScore;
    document.getElementById('projectedBubbleScore').innerText = projectedFinalBubble;
    document.getElementById('playersInCut').innerText = playersInCut;

    renderStandingsTable(standings, currentBubbleScore, projectedFinalBubble, playersInCut, data.standingsRound, data.totalRounds);
}

function renderStandingsTable(standings, currentBubbleScore, projectedFinalBubble, playersInCut, standingsRound, totalRounds) {
    const tbody = document.getElementById('standingsBody');
    tbody.innerHTML = "";
    
    const remainingRounds = totalRounds - standingsRound;
    
    standings.forEach((player, index) => {
        const tr = document.createElement('tr');
        tr.className = "clickable-row";
        tr.title = "Kliknij, aby sprawdzić szanse na remis w module Can I take a TIE";
        tr.onclick = () => selectPlayerForTie(player.player.id);
        
        const currentPoints = player.match_points;
        const maxPotential = currentPoints + (remainingRounds * 3);
        const formattedName = formatStandingsPlayerName(player);
        
        const omwp = ((player.opponent_match_win_percentage || 0) * 100).toFixed(1) + "%";
        const gwp = ((player.game_win_percentage || 0) * 100).toFixed(1) + "%";
        
        const strategyText = getLiveStrategyText(player, remainingRounds, projectedFinalBubble);
        const ptsNeeded = Math.max(0, projectedFinalBubble - currentPoints);

        let status = "";
        let rowClass = "";
        
        if (index < playersInCut) {
            status = "W Cut";
            rowClass = "safe";
        } else if (maxPotential >= projectedFinalBubble) {
            status = "W grze";
            rowClass = "bubble";
        } else {
            status = "Odpada";
            rowClass = "dead";
        }
        
        tr.className += " " + rowClass;
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td style="text-align: left;"><strong>${formattedName}</strong></td>
            <td><strong>${currentPoints}</strong></td>
            <td class="tiebreaker">${omwp} / ${gwp}</td>
            <td>${ptsNeeded > 0 ? ptsNeeded + " pkt" : "OK"}</td>
            <td class="strategy">${strategyText}</td>
            <td>${status}</td>
        `;
        tbody.appendChild(tr);
    });
}

function getLiveStrategyText(player, remainingRounds, targetBubble) {
    if (remainingRounds === 0) return player.match_points >= targetBubble ? "Awans" : "Brak Awansu";
    let ptsNeeded = targetBubble - player.match_points;
    if (ptsNeeded <= 0) return "Bezpieczny ID";
    if (ptsNeeded > remainingRounds * 3) return "Odpada";

    if (remainingRounds === 1 && ptsNeeded === 1) {
        return "Możliwy ID (Sprawdź kalkulator)";
    }
    
    let bestW = Math.ceil(ptsNeeded / 3);
    return `Wymaga ${bestW}x W`;
}

// -------------------------------------------------------------
// MODUŁ: CAN I TAKE A TIE? (LIVE SIMULATOR)
// -------------------------------------------------------------

function onPlayerSearchInput() {
    const query = document.getElementById('playerSearchInput').value.toLowerCase().trim();
    const dropdown = document.getElementById('playerSuggestions');
    
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
            document.getElementById('playerSearchInput').value = formatStandingsPlayerName(p);
        };
        dropdown.appendChild(item);
    });
    dropdown.style.display = 'block';
}

function selectPlayerForTie(playerId) {
    currentSelectedPlayerId = playerId;
    document.getElementById('tieResultArea').style.display = 'block';
    recalculateTieForSelectedPlayer();
    document.getElementById('tieModule').scrollIntoView({ behavior: 'smooth' });
}

function recalculateTieForSelectedPlayer() {
    if (!latestData || !latestData.standings?.standings || !currentSelectedPlayerId) return;

    const standings = latestData.standings.standings;
    const targetPlayer = standings.find(p => p.player.id === currentSelectedPlayerId);
    if (!targetPlayer) return;

    const cutSize = parseInt(document.getElementById('cutSize').value);
    const cutRule = document.getElementById('cutRule').value;
    const pairingsList = extractPairingsList(latestData.pairings);
    const standingsMap = buildStandingsMap(standings);
    
    let myMatch = pairingsList.find(m => {
        const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
        const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
        return (p1 && p1.id === currentSelectedPlayerId) || (p2 && p2.id === currentSelectedPlayerId);
    });

    const formattedName = formatStandingsPlayerName(targetPlayer);
    document.getElementById('selectedPlayerName').innerText = formattedName;
    document.getElementById('selectedPlayerTable').innerText = myMatch ? `(Stół #${myMatch.table_number || myMatch.tableNumber})` : "";
    document.getElementById('selectedPlayerBaseStats').innerText = `Teraz: ${targetPlayer.match_points} pkt | OMWP: ${(targetPlayer.opponent_match_win_percentage * 100).toFixed(1)}%`;

    const simResults = runLiveTieSimulation(targetPlayer, standings, pairingsList, standingsMap, cutSize, cutRule, latestData.standingsRound, latestData.totalRounds);

    document.getElementById('chanceTieDisplay').innerText = simResults.chanceTie + "%";
    document.getElementById('ptsTieDisplay').innerText = `Pkt po TIE: ${targetPlayer.match_points + 1}`;
    
    document.getElementById('chanceWinDisplay').innerText = simResults.chanceWin + "%";
    document.getElementById('ptsWinDisplay').innerText = `Pkt po WIN: ${targetPlayer.match_points + 3}`;
    
    document.getElementById('chanceLossDisplay').innerText = simResults.chanceLoss + "%";
    document.getElementById('ptsLossDisplay').innerText = `Pkt po LOSS: ${targetPlayer.match_points}`;

    updateRecommendationBanner(simResults, myMatch, targetPlayer);
}

function runLiveTieSimulation(targetPlayer, standings, pairingsList, standingsMap, cutSize, cutRule, currentRound, totalRounds) {
    const SIM_COUNT = 600;
    let tieSuccesses = 0;
    let winSuccesses = 0;
    let lossSuccesses = 0;

    const remainingRounds = Math.max(0, totalRounds - currentRound);

    const basePlayers = standings.map(p => ({
        id: p.player.id,
        name: p.player.best_identifier,
        points: p.match_points,
        omwp: p.opponent_match_win_percentage || 0.33,
        gwp: p.game_win_percentage || 0.33
    }));

    const fixedMatchDeltas = new Map();
    const liveUnfinishedMatches = [];

    pairingsList.forEach(m => {
        const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
        const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
        const id1 = p1?.id;
        const id2 = p2?.id;
        
        const score1 = m.player_1_game_wins ?? m.score_1 ?? 0;
        const score2 = m.player_2_game_wins ?? m.score_2 ?? 0;
        const status = (m.status || m.state || "").toUpperCase();
        const isComplete = status === "COMPLETE" || status === "FINISHED" || (score1 + score2 > 0 && status !== "IN_PROGRESS");

        if (isComplete) {
            if (score1 > score2) {
                if (id1) fixedMatchDeltas.set(id1, 3);
                if (id2) fixedMatchDeltas.set(id2, 0);
            } else if (score2 > score1) {
                if (id1) fixedMatchDeltas.set(id1, 0);
                if (id2) fixedMatchDeltas.set(id2, 3);
            } else {
                if (id1) fixedMatchDeltas.set(id1, 1);
                if (id2) fixedMatchDeltas.set(id2, 1);
            }
        } else {
            if (id1 && id2) {
                liveUnfinishedMatches.push({ id1, id2 });
            }
        }
    });

    for (let i = 0; i < SIM_COUNT; i++) {
        if (simulateSingleTournament(targetPlayer.player.id, 1, basePlayers, fixedMatchDeltas, liveUnfinishedMatches, cutSize, cutRule, remainingRounds)) {
            tieSuccesses++;
        }
        if (simulateSingleTournament(targetPlayer.player.id, 3, basePlayers, fixedMatchDeltas, liveUnfinishedMatches, cutSize, cutRule, remainingRounds)) {
            winSuccesses++;
        }
        if (simulateSingleTournament(targetPlayer.player.id, 0, basePlayers, fixedMatchDeltas, liveUnfinishedMatches, cutSize, cutRule, remainingRounds)) {
            lossSuccesses++;
        }
    }

    return {
        chanceTie: Math.round((tieSuccesses / SIM_COUNT) * 100),
        chanceWin: Math.round((winSuccesses / SIM_COUNT) * 100),
        chanceLoss: Math.round((lossSuccesses / SIM_COUNT) * 100)
    };
}

function simulateSingleTournament(targetId, myOutcomePoints, basePlayers, fixedDeltas, unfinishedMatches, cutSize, cutRule, remainingRounds) {
    const simBoard = basePlayers.map(p => ({
        id: p.id,
        points: p.points + (fixedDeltas.get(p.id) || 0),
        omwp: p.omwp,
        gwp: p.gwp
    }));

    const target = simBoard.find(p => p.id === targetId);
    if (target) {
        target.points = basePlayers.find(p => p.id === targetId).points + myOutcomePoints;
    }

    unfinishedMatches.forEach(m => {
        if (m.id1 === targetId || m.id2 === targetId) return;

        const roll = Math.random();
        const p1 = simBoard.find(p => p.id === m.id1);
        const p2 = simBoard.find(p => p.id === m.id2);

        if (roll < 0.10) {
            if (p1) p1.points += 1;
            if (p2) p2.points += 1;
        } else if (roll < 0.55) {
            if (p1) p1.points += 3;
        } else {
            if (p2) p2.points += 3;
        }
    });

    if (remainingRounds > 1) {
        simBoard.forEach(p => {
            if (p.id !== targetId) {
                p.points += Math.floor(Math.random() * (remainingRounds - 1) * 3);
            }
        });
    }

    simBoard.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.omwp !== a.omwp) return b.omwp - a.omwp;
        return b.gwp - a.gwp;
    });

    let bubbleIndex = Math.min(cutSize - 1, simBoard.length - 1);
    let bubbleScore = simBoard[bubbleIndex].points;

    if (cutRule === 'soft') {
        return target && target.points >= bubbleScore;
    } else {
        let myRank = simBoard.findIndex(p => p.id === targetId) + 1;
        return myRank <= cutSize;
    }
}

function updateRecommendationBanner(sim, myMatch, targetPlayer) {
    const banner = document.getElementById('tieRecommendationBanner');
    
    if (sim.chanceTie >= 98) {
        banner.className = "recommendation-box rec-safe";
        banner.innerHTML = `
            🚀 <strong>GWARANTOWANY TOP CUT (100%):</strong> Wyniki z pozostałych stołów ułożyły się tak, że remis daje Ci <strong>bezwzględny awans</strong>! 
            Nie ryzykuj gry – bierz natychmiast Intentional Draw (ID) ze swoim rywalem!
        `;
    } else if (sim.chanceTie >= 75) {
        banner.className = "recommendation-box rec-safe";
        banner.innerHTML = `
            🟢 <strong>BARDZO WYSOKA SZANSA NA TIE (${sim.chanceTie}%):</strong> Remis stawia Cię w świetnej pozycji. 
            Ryzykujesz odpadnięcie tylko przy ekstremalnie niekorzystnym splocie wygranych na dolnych stołach. ID jest mocno rekomendowane.
        `;
    } else if (sim.chanceTie >= 30) {
        banner.className = "recommendation-box rec-risk";
        banner.innerHTML = `
            ⚠️ <strong>STREFA BUBBLE / RYZYKO TIEBREAKERÓW (${sim.chanceTie}%):</strong> Remis daje Ci walkę na tiebreakery (Twój OMWP to ${(targetPlayer.opponent_match_win_percentage*100).toFixed(1)}%). 
            Obserwuj sąsiednie stoły! Jeśli na stole obok przegra rywal walczący o ten sam próg, Twoja szansa po remisie wzrośnie. Jeśli nie – rozważ grę o WIN (${sim.chanceWin}% szans).
        `;
    } else {
        banner.className = "recommendation-box rec-danger";
        banner.innerHTML = `
            🛑 <strong>NIE BIERZ REMISU (${sim.chanceTie}%):</strong> Remis praktycznie wyrzuca Cię z Top Cutu! Zwycięzcy innych stołów zepchną Cię pod kreskę. 
            Twoja jedyna droga do awansu to pełna gra o wygraną (WIN daje ${sim.chanceWin}% szans).
        `;
    }
}