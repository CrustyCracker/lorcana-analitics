let trackingInterval = null;
let latestData = null;
let currentSelectedPlayerId = null;
let simulatedResultsCache = new Map();

function setElText(id, text) {
    const el = document.getElementById(id);
    if (el) el.innerText = text;
}

function setElHtml(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

function toggleTokenPanel() {
    const p = document.getElementById('tokenPanel');
    if (p) p.style.display = p.style.display === 'block' ? 'none' : 'block';
}

async function saveToken() {
    const token = document.getElementById('tokenInput')?.value.trim() || '';
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
    if (!tbody) return;
    
    setElText('pairingsRoundNum', data.activeRound || "-");
    const pairingsList = extractPairingsList(data.pairings);
    const standingsList = data.standings?.standings || [];
    const standingsMap = buildStandingsMap(standingsList);

    if (!pairingsList || pairingsList.length === 0) {
        let hint = data.hasTokenConfigured ? "Brak meczów dla tej rundy." : "Wymagany Token API do podglądu stołów.";
        tbody.innerHTML = `<tr><td colspan="5" style="color: #e67e22; padding: 15px;">${hint}</td></tr>`;
        setElText('matchesProgress', "0 zakończonych");
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
        
        const { score1, score2, hasScore, winnerId } = getMatchScores(match);
        const statusRaw = (match.status || match.state || "").toUpperCase();
        const isComplete = statusRaw === "COMPLETE" || statusRaw === "FINISHED" || statusRaw === "COMPLETED" || winnerId != null || hasScore;
        const isDraw = match.match_is_intentional_draw || match.match_is_unintentional_draw || statusRaw === "DRAW";

        let statusBadge = "";
        let displayScore = `${score1} : ${score2}`;

        if (isBye) {
            statusBadge = `<span class="badge badge-bye">BYE</span>`;
            displayScore = `2 : 0`;
            completedCount++;
        } else if (isComplete) {
            statusBadge = `<span class="badge badge-complete">Koniec</span>`;
            completedCount++;
            
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

    setElText('matchesProgress', `${completedCount}/${pairingsList.length} wpisane`);
}

// -------------------------------------------------------------
// GŁÓWNA OBSŁUGA STANDINGS (ROZDZIELENIE NA LIVE I OFICJALNĄ)
// -------------------------------------------------------------

function processStandings(data) {
    const cutSize = parseInt(document.getElementById('cutSize')?.value || '4');
    const cutRule = document.getElementById('cutRule')?.value || 'hard';
    const standings = data.standings?.standings || [];
    
    setElText('eventNameDisplay', data.eventName || 'Turniej');
    setElText('totalPlayersDisplay', data.playerCount || 0);
    setElText('activeRoundInfo', `${data.activeRound}/${data.totalRounds}`);
    setElText('standingsRoundInfo', `${data.standingsRound}/${data.totalRounds}`);
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

    // 3. Obliczenia progu Cut
    let bubbleIndex = Math.min(cutSize - 1, liveStandings.length - 1);
    let currentBubbleScore = liveStandings[bubbleIndex].livePoints;
    let playersInCut = cutRule === 'soft' 
        ? liveStandings.filter(p => p.livePoints >= currentBubbleScore).length 
        : cutSize;

    let projectedFinalBubble = 0;
    if (data.standingsRound > 0) {
        let pointsPerRound = currentBubbleScore / Math.max(1, data.activeRound);
        projectedFinalBubble = Math.ceil(pointsPerRound * data.totalRounds);
    }

    setElText('bubbleScore', currentBubbleScore);
    setElText('projectedBubbleScore', projectedFinalBubble);
    setElText('playersInCut', playersInCut);

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
        
        const simRes = runLiveTieSimulation(p, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, data.standingsRound, data.totalRounds);
        simulatedResultsCache.set(String(p.player.id), { sim: simRes, opp: myOpponent });
    });

    // 5. Renderujemy obie tabele
    renderLiveStandingsTable(liveStandings, cutSize, cutRule, data.standingsRound, data.totalRounds);
    renderOfficialStandingsTable(standings, cutSize, cutRule);
}

// -------------------------------------------------------------
// TABELA 1: LIVE STANDINGS & STRATEGIA
// -------------------------------------------------------------

function renderLiveStandingsTable(liveStandings, cutSize, cutRule, standingsRound, totalRounds) {
    const tbody = document.getElementById('liveStandingsBody');
    if (!tbody) return;
    tbody.innerHTML = "";
    
    const remainingRounds = Math.max(0, totalRounds - standingsRound);

    liveStandings.forEach((player, index) => {
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
        
        const inCut = (index < cutSize);

        if (remainingRounds === 0) {
            status = inCut ? "W Cut" : "Odpada";
            rowClass = inCut ? "safe" : "dead";
            ptsNeededText = "Koniec";
            strategyText = status;
        } else if (sim) {
            if (sim.chanceLoss >= 90) {
                ptsNeededText = "OK";
                strategyText = "Pewny Cut";
                status = "W Cut";
                rowClass = "safe";
            } else if (sim.chanceTie >= 90 && sim.oppChanceTie >= 90) {
                ptsNeededText = "TIE (1 pkt)";
                strategyText = "Bezpieczny ID";
                status = "W Cut";
                rowClass = "safe";
            } else if (sim.chanceTie >= 80) {
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
                ptsNeededText = "-";
                strategyText = "Odpada";
                status = "Odpada";
                rowClass = "dead";
            }
        } else {
            ptsNeededText = "-";
            strategyText = "Przetwarzanie...";
            status = "W grze";
        }
        
        // Zaznaczenie dodanych punktów live (np. 1 + 3)
        let pointsDisplay = `<strong>${player.livePoints}</strong>`;
        if (player.delta > 0) {
            pointsDisplay += ` <span style="font-size: 11px; color: #2ecc71;">(+${player.delta})</span>`;
        }

        tr.className += " " + rowClass;
        tr.innerHTML = `
            <td><strong>${index + 1}</strong></td>
            <td style="text-align: left;"><strong>${formattedName}</strong></td>
            <td>${pointsDisplay}</td>
            <td class="tiebreaker">${omwp} / ${gwp}</td>
            <td><strong>${ptsNeededText}</strong></td>
            <td class="strategy">${strategyText}</td>
            <td>${status}</td>
        `;
        tbody.appendChild(tr);
    });
}

// -------------------------------------------------------------
// TABELA 2: OFICJALNA TABELA RAVENSBURGERA (CZYSTE DANE API)
// -------------------------------------------------------------

function renderOfficialStandingsTable(standings, cutSize, cutRule) {
    const tbody = document.getElementById('officialStandingsBody');
    if (!tbody) return;
    tbody.innerHTML = "";

    // Kopia posortowana według oficjalnej kolejności API
    const officialList = [...standings].sort((a, b) => (a.rank || 0) - (b.rank || 0));

    let bubbleIndex = Math.min(cutSize - 1, officialList.length - 1);
    let bubbleScore = officialList[bubbleIndex]?.match_points ?? 0;

    officialList.forEach((player, index) => {
        const tr = document.createElement('tr');
        const formattedName = formatStandingsPlayerName(player);
        const omwp = ((player.opponent_match_win_percentage || 0) * 100).toFixed(1) + "%";
        const gwp = ((player.game_win_percentage || 0) * 100).toFixed(1) + "%";
        
        const inCut = cutRule === 'soft' 
            ? player.match_points >= bubbleScore 
            : index < cutSize;

        tr.className = inCut ? "safe" : (player.match_points >= bubbleScore ? "bubble" : "dead");
        tr.innerHTML = `
            <td>${player.rank || (index + 1)}</td>
            <td style="text-align: left;">${formattedName}</td>
            <td><strong>${player.match_points}</strong></td>
            <td>${player.record || player.match_record || "-"}</td>
            <td class="tiebreaker">${omwp} / ${gwp}</td>
            <td>${inCut ? 'W Cut' : 'Poza Cut'}</td>
        `;
        tbody.appendChild(tr);
    });
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

    const cached = simulatedResultsCache.get(String(currentSelectedPlayerId));
    const pairingsList = extractPairingsList(latestData.pairings);
    const standingsMap = buildStandingsMap(standings);
    
    let myMatch = null;
    let myOpponent = cached?.opp || null;

    if (!myOpponent) {
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
    } else {
        myMatch = pairingsList.find(m => {
            const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
            const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
            return (p1 && String(p1.id) === String(currentSelectedPlayerId)) || (p2 && String(p2.id) === String(currentSelectedPlayerId));
        });
    }

    const cutSize = parseInt(document.getElementById('cutSize')?.value || '4');
    const cutRule = document.getElementById('cutRule')?.value || 'hard';

    const simResults = cached?.sim || runLiveTieSimulation(targetPlayer, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, latestData.standingsRound, latestData.totalRounds);

    const formattedName = formatStandingsPlayerName(targetPlayer);
    setElText('selectedPlayerName', formattedName);
    setElText('selectedPlayerTable', myMatch ? `(Stół #${myMatch.table_number || myMatch.tableNumber} vs ${myOpponent?.name || 'BYE'})` : "");
    setElText('selectedPlayerBaseStats', `Stan bazowy: ${targetPlayer.match_points} pkt | OMWP: ${(targetPlayer.opponent_match_win_percentage * 100).toFixed(1)}%`);

    setElText('chanceTieDisplay', simResults.chanceTie + "%");
    setElText('ptsTieDisplay', `Pkt po TIE: ${targetPlayer.match_points + 1}`);
    setElText('oppTieChanceDisplay', myOpponent ? `Rywal po TIE: ${simResults.oppChanceTie}%` : `Brak rywala`);
    
    setElText('chanceWinDisplay', simResults.chanceWin + "%");
    setElText('ptsWinDisplay', `Pkt po WIN: ${targetPlayer.match_points + 3}`);
    
    setElText('chanceLossDisplay', simResults.chanceLoss + "%");
    setElText('ptsLossDisplay', `Pkt po LOSS: ${targetPlayer.match_points}`);

    updateRecommendationBanner(simResults, myMatch, targetPlayer, myOpponent);
}

function runLiveTieSimulation(targetPlayer, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, currentRound, totalRounds) {
    const SIM_COUNT = 600;
    let tieSuccesses = 0;
    let oppTieSuccesses = 0;
    let winSuccesses = 0;
    let lossSuccesses = 0;

    const targetId = targetPlayer.player.id;
    const opponentId = myOpponent?.id || null;

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

        if (id1 === targetId || id2 === targetId) return;

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

    for (let i = 0; i < SIM_COUNT; i++) {
        const tieRes = evaluateTournamentOutcome(targetId, opponentId, 1, basePlayers, fixedMatchDeltas, liveUnfinishedMatches, cutSize, cutRule, currentRound);
        if (tieRes.targetCut) tieSuccesses++;
        if (tieRes.opponentCut) oppTieSuccesses++;

        const winRes = evaluateTournamentOutcome(targetId, opponentId, 3, basePlayers, fixedMatchDeltas, liveUnfinishedMatches, cutSize, cutRule, currentRound);
        if (winRes.targetCut) winSuccesses++;

        const lossRes = evaluateTournamentOutcome(targetId, opponentId, 0, basePlayers, fixedMatchDeltas, liveUnfinishedMatches, cutSize, cutRule, currentRound);
        if (lossRes.targetCut) lossSuccesses++;
    }

    return {
        chanceTie: Math.round((tieSuccesses / SIM_COUNT) * 100),
        oppChanceTie: Math.round((oppTieSuccesses / SIM_COUNT) * 100),
        chanceWin: Math.round((winSuccesses / SIM_COUNT) * 100),
        chanceLoss: Math.round((lossSuccesses / SIM_COUNT) * 100)
    };
}

function evaluateTournamentOutcome(targetId, opponentId, myOutcomePoints, basePlayers, fixedDeltas, unfinishedMatches, cutSize, cutRule, currentRound) {
    const simBoard = basePlayers.map(p => ({
        id: p.id,
        name: p.name,
        points: p.points + (fixedDeltas.get(p.id) || 0),
        baseOmwp: p.baseOmwp,
        omwp: p.baseOmwp,
        gwp: p.gwp,
        activeOpponentId: p.activeOpponentId
    }));

    const target = simBoard.find(p => p.id === targetId);
    const opponent = opponentId ? simBoard.find(p => p.id === opponentId) : null;

    if (target) {
        target.points += myOutcomePoints;
    }
    if (opponent) {
        if (myOutcomePoints === 3) opponent.points += 0;
        else if (myOutcomePoints === 1) opponent.points += 1;
        else if (myOutcomePoints === 0) opponent.points += 3;
    }

    unfinishedMatches.forEach(m => {
        const roll = Math.random();
        const p1 = simBoard.find(p => p.id === m.id1);
        const p2 = simBoard.find(p => p.id === m.id2);

        if (roll < 0.08) {
            if (p1) p1.points += 1;
            if (p2) p2.points += 1;
        } else if (roll < 0.54) {
            if (p1) p1.points += 3;
        } else {
            if (p2) p2.points += 3;
        }
    });

    simBoard.forEach(p => {
        if (p.activeOpponentId) {
            const opp = simBoard.find(o => o.id === p.activeOpponentId);
            if (opp) {
                const oppMwp = Math.max(0.3333, opp.points / (currentRound * 3));
                p.omwp = ((p.baseOmwp * (currentRound - 1)) + oppMwp) / currentRound;
            }
        }
    });

    simBoard.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (Math.abs(b.omwp - a.omwp) > 0.0001) return b.omwp - a.omwp;
        return b.gwp - a.gwp;
    });

    let targetCut = false;
    let opponentCut = false;

    if (cutRule === 'soft') {
        let bubbleIndex = Math.min(cutSize - 1, simBoard.length - 1);
        let bubbleScore = simBoard[bubbleIndex].points;
        targetCut = target ? target.points >= bubbleScore : false;
        opponentCut = opponent ? opponent.points >= bubbleScore : false;
    } else {
        let tRank = simBoard.findIndex(p => p.id === targetId) + 1;
        targetCut = tRank > 0 && tRank <= cutSize;
        if (opponentId) {
            let oRank = simBoard.findIndex(p => p.id === opponentId) + 1;
            opponentCut = oRank > 0 && oRank <= cutSize;
        }
    }

    return { targetCut, opponentCut };
}

function updateRecommendationBanner(sim, myMatch, targetPlayer, myOpponent) {
    const banner = document.getElementById('tieRecommendationBanner');
    if (!banner || !sim) return;
    
    const oppName = myOpponent?.name || "Twój rywal";
    
    if (!myOpponent) {
        if (sim.chanceTie >= 80) {
            banner.className = "recommendation-box rec-safe";
            banner.innerHTML = `🎉 <strong>PEWNY AWANS (${sim.chanceTie}%):</strong> Masz BYE lub jesteś bezpieczny w Top Cut!`;
        } else {
            banner.className = "recommendation-box rec-risk";
            banner.innerHTML = `⚠️️ <strong>SZANSA PO REMISIE: ${sim.chanceTie}%:</strong> Gra o pełną wygraną daje ${sim.chanceWin}%.`;
        }
        return;
    }

    if (sim.chanceTie >= 85 && sim.oppChanceTie >= 85) {
        banner.className = "recommendation-box rec-safe";
        banner.innerHTML = `
            🤝 <strong>OBOPÓLNY ZŁOTY REMIS (PEWNY ID):</strong> Matematyka jest idealna dla OBU graczy! 
            Zarówno Ty (${sim.chanceTie}%), jak i ${oppName} (${sim.oppChanceTie}%) wchodzicie do Top Cutu przy remisie. 
            <strong>Zaproponuj Intentional Draw (ID) – rywal natychmiast się zgodzi!</strong>
        `;
        return;
    }

    if (sim.chanceTie >= 70 && sim.oppChanceTie < 50) {
        banner.className = "recommendation-box rec-warning";
        banner.innerHTML = `
            ⚠️ <strong>ASYMETRIA STOŁU (RYWAL MOŻE ODRZUCIĆ ID):</strong> Matematycznie remis daje Ci aż <strong>${sim.chanceTie}%</strong> awansu, 
            ALE Twój rywal (${oppName}) przy remisie ma zaledwie <strong>${sim.oppChanceTie}%</strong> szans na Top Cut. 
            <strong>Rywal może odrzucić propozycję ID</strong> i grać o pełną pulę (WIN). Zaproponuj remis, ale bądź przygotowany na grę o zwycięstwo!
        `;
        return;
    }

    if (sim.chanceTie < 50 && sim.oppChanceTie >= 70) {
        banner.className = "recommendation-box rec-danger";
        banner.innerHTML = `
            🛑 <strong>NIE BIERZ REMISU (${sim.chanceTie}%):</strong> Remis wyrzuca Cię z Top Cutu! 
            ${oppName} ma lepszy tiebreaker i przy remisie to on zgarnia slot (${sim.oppChanceTie}%), a Ty lądujesz pod kreską. 
            Twoja jedyna droga do awansu to gra o zwycięstwo (WIN daje ${sim.chanceWin}% szans)!
        `;
        return;
    }

    if (sim.chanceTie < 50) {
        banner.className = "recommendation-box rec-danger";
        banner.innerHTML = `
            🛑 <strong>NIEOPŁACALNY REMIS (${sim.chanceTie}%):</strong> Remis zepchnie Cię poniżej progu Cutu przez zwycięzców z innych stołów. 
            Graj o wygraną (WIN daje ${sim.chanceWin}% szans).
        `;
        return;
    }

    banner.className = "recommendation-box rec-risk";
    banner.innerHTML = `
        ⚠️ <strong>STREFA BUBBLE:</strong> Szansa po remisie wynosi ${sim.chanceTie}% (dla rywala: ${sim.oppChanceTie}%). 
        Obserwuj sąsiednie stoły – jeśli rywale z innych stołów przegrają swoje mecze, sytuacja może ulec poprawie.
    `;
}