let trackingInterval = null;

function startTracking() {
    const eventId = document.getElementById('eventId').value;
    document.getElementById('status').innerText = "Status: Kalkulowanie strategii...";
    fetchData(eventId);
    if (trackingInterval) clearInterval(trackingInterval);
    trackingInterval = setInterval(() => fetchData(eventId), 35000);
}

async function fetchData(eventId) {
    try {
        const response = await fetch(`api.php?eventId=${eventId}`);
        const data = await response.json();
        
        if (data.error) return document.getElementById('status').innerText = "BŁĄD API: " + data.error;
        
        document.getElementById('statsPanel').style.display = "block";
        processStandings(data);
        document.getElementById('status').innerText = "Status: Zaktualizowano pomyślnie " + new Date().toLocaleTimeString();
    } catch (error) {
        console.error(error);
        document.getElementById('status').innerText = "Błąd komunikacji z lokalnym proxy.";
    }
}

// FORMATOWANIE NICKNAME (Imię N.)
function formatPlayerName(player) {
    let rawName = player.player.best_identifier || "Nieznany";
    let nickname = player.user_event_status?.best_identifier || rawName;
    
    let parts = rawName.split(" ");
    if (parts.length > 1) {
        let firstName = parts[0];
        let lastInitial = parts[parts.length - 1].charAt(0).toUpperCase();
        return `${nickname} (${firstName} ${lastInitial}.)`;
    }
    return rawName;
}

// KOROWA LOGIKA OPTYMALNEJ STRATEGII
// Przeszukuje wszystkie kombinacje w pozostałych rundach, szukając drogi o najmniejszym ryzyku (minWins, potem minTies).
function getOptimalStrategy(currentPoints, remainingRounds, targetBubble) {
    if (remainingRounds === 0) return currentPoints >= targetBubble ? "Kwalifikacja" : "Brak Kwalifikacji";
    
    let ptsNeeded = targetBubble - currentPoints;
    if (ptsNeeded <= 0) return "Bezpieczny (Nie musisz grać)";
    if (ptsNeeded > remainingRounds * 3) return "Martwy matematycznie";

    let bestW = Infinity;
    let bestT = Infinity;

    for (let w = 0; w <= remainingRounds; w++) {
        for (let t = 0; t <= remainingRounds - w; t++) {
            if (w * 3 + t >= ptsNeeded) {
                // Preferujemy mniej wygranych (mniejsze ryzyko porażki)
                if (w < bestW || (w === bestW && t < bestT)) {
                    bestW = w;
                    bestT = t;
                }
            }
        }
    }

    if (bestW === Infinity) return "Martwy matematycznie";
    
    let actions = [];
    if (bestW > 0) actions.push(`${bestW}x WIN`);
    if (bestT > 0) actions.push(`${bestT}x TIE(ID)`);
    
    let margin = remainingRounds - bestW - bestT;
    let marginText = margin > 0 ? ` (Możesz przegrać ${margin}x)` : "";

    return actions.join(" + ") + marginText;
}

function processStandings(data) {
    const cutSize = parseInt(document.getElementById('cutSize').value);
    const cutRule = document.getElementById('cutRule').value;
    const standings = data.standings.standings; 
    
    document.getElementById('eventNameDisplay').innerText = data.eventName;
    document.getElementById('totalPlayersDisplay').innerText = data.playerCount;
    document.getElementById('roundInfo').innerText = `${data.currentRound} / ${data.totalRounds}`;
    
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

    // Dynamiczna projekcja bubble'a bazująca na tempie zdobywania punktów
    let projectedFinalBubble = 0;
    if (data.currentRound > 0) {
        let pointsPerRound = currentBubbleScore / data.currentRound;
        projectedFinalBubble = Math.ceil(pointsPerRound * data.totalRounds);
    }

    document.getElementById('bubbleScore').innerText = currentBubbleScore + " pkt";
    document.getElementById('projectedBubbleScore').innerText = projectedFinalBubble + " pkt";
    document.getElementById('playersInCut').innerText = playersInCut + " os.";

    renderTable(standings, currentBubbleScore, projectedFinalBubble, playersInCut, data.currentRound, data.totalRounds);
}

function renderTable(standings, currentBubbleScore, projectedFinalBubble, playersInCut, currentRound, totalRounds) {
    const tbody = document.getElementById('standingsBody');
    tbody.innerHTML = "";
    
    const remainingRounds = totalRounds - currentRound;
    
    standings.forEach((player, index) => {
        const tr = document.createElement('tr');
        
        const currentPoints = player.match_points;
        const maxPotential = currentPoints + (remainingRounds * 3);
        const formattedName = formatPlayerName(player);
        
        const omwp = (player.opponent_match_win_percentage * 100).toFixed(2) + "%";
        const gwp = (player.game_win_percentage * 100).toFixed(2) + "%";
        const ogwp = (player.opponent_game_win_percentage * 100).toFixed(2) + "%";
        
        // Obliczanie najlepszej strategii dla tego gracza w danym momencie turnieju
        const optimalStrategyText = getOptimalStrategy(currentPoints, remainingRounds, projectedFinalBubble);
        const ptsNeeded = Math.max(0, projectedFinalBubble - currentPoints);

        let status = "";
        let rowClass = "";
        
        if (index < playersInCut) {
            status = "W strefie awansu";
            rowClass = "safe";
        } else if (maxPotential >= projectedFinalBubble) {
            status = "Gra o wszystko";
            rowClass = "bubble";
        } else {
            status = "Odpada";
            rowClass = "dead";
        }
        
        tr.className = rowClass;
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td><strong>${formattedName}</strong></td>
            <td>${currentPoints}</td>
            <td class="tiebreaker">OMWP: ${omwp} <br> GWP: ${gwp} <br> OGWP: ${ogwp}</td>
            <td>Brakuje ${ptsNeeded} pkt do progu ${projectedFinalBubble}</td>
            <td class="strategy">${optimalStrategyText}</td>
            <td>${status}</td>
        `;
        tbody.appendChild(tr);
    });
}