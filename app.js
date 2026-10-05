let trackingInterval = null;

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
        
        document.getElementById('statsPanel').style.display = "block";
        processPairings(data);
        processStandings(data);
        
        document.getElementById('status').innerText = "Zaktualizowano: " + new Date().toLocaleTimeString();
    } catch (error) {
        console.error(error);
        document.getElementById('status').innerText = "Błąd komunikacji z serwerem.";
    }
}

// Formatowanie nazwy gracza
function extractPlayerName(playerObj) {
    if (!playerObj) return "BYE (Wolny los)";
    if (typeof playerObj === 'string') return playerObj;
    
    let raw = playerObj.best_identifier || 
              playerObj.player?.best_identifier ||
              playerObj.user_event_status?.best_identifier ||
              playerObj.name || 
              playerObj.playerName || 
              playerObj.username ||
              playerObj.team_name ||
              "";
              
    if (!raw && playerObj.user) {
        raw = playerObj.user.best_identifier || playerObj.user.username || "";
    }
    if (!raw && Array.isArray(playerObj.players) && playerObj.players[0]) {
        return extractPlayerName(playerObj.players[0]);
    }
    return raw || "Nieznany";
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

// Uniwersalny ekstraktor tablicy pojedynków (obsługuje .results z endpointu paginowanego)
function extractPairingsList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (raw.results && Array.isArray(raw.results)) return raw.results; // Klucz z /matches/paginated/
    if (raw.matches && Array.isArray(raw.matches)) return raw.matches;
    if (raw.data && Array.isArray(raw.data)) return raw.data;
    if (raw.pairings) {
        if (Array.isArray(raw.pairings)) return raw.pairings;
        if (raw.pairings.results && Array.isArray(raw.pairings.results)) return raw.pairings.results;
    }
    return [];
}

function processPairings(data) {
    const tbody = document.getElementById('pairingsBody');
    const roundNumSpan = document.getElementById('pairingsRoundNum');
    const progressSpan = document.getElementById('matchesProgress');
    
    roundNumSpan.innerText = data.activeRound || "-";
    const pairingsList = extractPairingsList(data.pairings);

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
        
        const p1 = match.player_1 || match.player1 || match.team_1 || (match.players && match.players[0]) || (match.competitors && match.competitors[0]);
        const p2 = match.player_2 || match.player2 || match.team_2 || (match.players && match.players[1]) || (match.competitors && match.competitors[1]);
        
        const name1 = extractPlayerName(p1);
        const isBye = match.is_bye || match.bye || !p2 || match.round_type === 'BYE';
        const name2 = isBye ? "BYE (Wolny los)" : extractPlayerName(p2);
        
        const score1 = match.player_1_game_wins ?? match.score_1 ?? match.competitor_1_score ?? 0;
        const score2 = match.player_2_game_wins ?? match.score_2 ?? match.competitor_2_score ?? 0;
        
        const statusRaw = (match.status || match.state || match.match_status || "").toUpperCase();
        let statusBadge = "";
        
        if (isBye) {
            statusBadge = `<span class="badge badge-bye">BYE</span>`;
            completedCount++;
        } else if (statusRaw === "COMPLETE" || statusRaw === "FINISHED" || statusRaw === "COMPLETED" || match.winner_id != null || (score1 + score2 > 0 && statusRaw !== "IN_PROGRESS")) {
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

function getOptimalStrategy(currentPoints, remainingRounds, targetBubble) {
    if (remainingRounds === 0) return currentPoints >= targetBubble ? "Awans" : "Brak Awansu";
    
    let ptsNeeded = targetBubble - currentPoints;
    if (ptsNeeded <= 0) return "Bezpieczny (Bierz ID)";
    if (ptsNeeded > remainingRounds * 3) return "Matematycznie Odpada";

    let bestW = Infinity;
    let bestT = Infinity;

    for (let w = 0; w <= remainingRounds; w++) {
        for (let t = 0; t <= remainingRounds - w; t++) {
            if (w * 3 + t >= ptsNeeded) {
                if (w < bestW || (w === bestW && t < bestT)) {
                    bestW = w;
                    bestT = t;
                }
            }
        }
    }

    if (bestW === Infinity) return "Matematycznie Odpada";
    
    let actions = [];
    if (bestW > 0) actions.push(`${bestW}x W`);
    if (bestT > 0) actions.push(`${bestT}x ID`);
    
    let margin = remainingRounds - bestW - bestT;
    let marginText = margin > 0 ? ` (Margines L: ${margin})` : "";

    return actions.join(" + ") + marginText;
}

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
        
        const currentPoints = player.match_points;
        const maxPotential = currentPoints + (remainingRounds * 3);
        const formattedName = formatStandingsPlayerName(player);
        
        const omwp = ((player.opponent_match_win_percentage || 0) * 100).toFixed(1) + "%";
        const gwp = ((player.game_win_percentage || 0) * 100).toFixed(1) + "%";
        
        const optimalStrategyText = getOptimalStrategy(currentPoints, remainingRounds, projectedFinalBubble);
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
        
        tr.className = rowClass;
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td style="text-align: left;"><strong>${formattedName}</strong></td>
            <td><strong>${currentPoints}</strong></td>
            <td class="tiebreaker">${omwp} / ${gwp}</td>
            <td>${ptsNeeded > 0 ? ptsNeeded + " pkt" : "OK"}</td>
            <td class="strategy">${optimalStrategyText}</td>
            <td>${status}</td>
        `;
        tbody.appendChild(tr);
    });
}