let trackingInterval = null;
let latestData = null;
let currentSelectedPlayerId = null;
let simulatedResultsCache = new Map();
let lastTieSimMs = null;

const PAGE_SIZE = 32;
/** Powyżej tego N wyłączamy ciężkie panele UI (bracket); rada TIE działa zawsze. */
const LARGE_EVENT_PLAYER_THRESHOLD = 400;
/** Virtual window LIVE: stała wysokość wiersza + overscan — max DOM rows ≪ N. */
const LIVE_ROW_HEIGHT = 44;
const LIVE_VIEWPORT_ROWS = 16;
const LIVE_OVERSCAN = 6;
const LIVE_MAX_DOM_ROWS = LIVE_VIEWPORT_ROWS + LIVE_OVERSCAN * 2;
let lastProcessFingerprint = null;
let currentPages = {
    pairings: 1,
    official: 1,
    live: 1
};
let cachedPairings = [];
let cachedOfficialStandings = [];
let cachedLiveStandings = [];
let cachedFilteredLiveList = [];
let liveVirtScrollTop = 0;
let liveVirtRaf = null;
let liveVirtLastWindowKey = '';
let cachedStandingsMap = new Map();
let cachedCutContext = { cutSize: 4, cutRule: 'hard', activeRound: 1, totalRounds: 1 };

function getTieSimCore() {
    if (typeof LorcanaTieSim !== 'undefined' && LorcanaTieSim) return LorcanaTieSim;
    if (typeof require !== 'undefined') {
        return require('./tie-sim-core.js');
    }
    throw new Error('tie-sim-core.js niedostepny');
}

function getAdaptiveSimCount(playerCount) {
    try {
        return getTieSimCore().getAdaptiveSimCount(playerCount);
    } catch (e) {
        const n = Number(playerCount) || 0;
        if (n > 800) return 100;
        if (n > 200) return 200;
        return 600;
    }
}

/** Web Worker do MC — jedna instancja na sesje */
let tieSimWorker = null;
let tieSimWorkerFailed = false;
let tieSimRequestSeq = 0;
let tieSimActiveRequestId = 0;

function getTieSimWorker() {
    if (tieSimWorkerFailed || typeof Worker === 'undefined') return null;
    if (tieSimWorker) return tieSimWorker;
    try {
        tieSimWorker = new Worker('tie-sim-worker.js');
        return tieSimWorker;
    } catch (e) {
        console.warn('Nie udalo sie uruchomic Web Workera TIE — fallback sync.', e);
        tieSimWorkerFailed = true;
        return null;
    }
}

function runTieSimulationAsync(input) {
    return new Promise((resolve, reject) => {
        const requestId = ++tieSimRequestSeq;
        tieSimActiveRequestId = requestId;
        const worker = getTieSimWorker();
        if (!worker) {
            try {
                resolve(getTieSimCore().executePreparedTieSimulation(input));
            } catch (err) {
                reject(err);
            }
            return;
        }
        const onMsg = (event) => {
            const msg = event.data || {};
            if (msg.requestId !== requestId) return;
            worker.removeEventListener('message', onMsg);
            worker.removeEventListener('error', onErr);
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
        };
        const onErr = () => {
            worker.removeEventListener('message', onMsg);
            worker.removeEventListener('error', onErr);
            tieSimWorkerFailed = true;
            try { worker.terminate(); } catch (e) {}
            tieSimWorker = null;
            try {
                resolve(getTieSimCore().executePreparedTieSimulation(input));
            } catch (fallbackErr) {
                reject(fallbackErr);
            }
        };
        worker.addEventListener('message', onMsg);
        worker.addEventListener('error', onErr);
        worker.postMessage({ requestId, input });
    });
}

const CUT_SIZE_STORAGE_KEY = 'lorcana_cut_size';
const CUT_RULE_STORAGE_KEY = 'lorcana_cut_rule';
const ROUNDS_OVERRIDE_KEY_PREFIX = 'lorcana_rounds_override_';

function roundsOverrideStorageKey(eventId) {
    const id = String(eventId || '').replace(/\D/g, '');
    return id ? `${ROUNDS_OVERRIDE_KEY_PREFIX}${id}` : null;
}

function getApiTotalRounds(data) {
    const activeRound = data?.activeRound || 1;
    const fromApi = data?.totalRounds || getDefaultTotalRounds(data?.playerCount);
    return Math.max(fromApi || 1, activeRound);
}

function getStoredRoundsOverride(eventId) {
    const key = roundsOverrideStorageKey(eventId);
    if (!key) return null;
    try {
        const raw = localStorage.getItem(key);
        if (raw && /^\d+$/.test(raw)) {
            const n = parseInt(raw, 10);
            if (n >= 1 && n <= 20) return n;
        }
    } catch (e) {}
    return null;
}

function setStoredRoundsOverride(eventId, rounds) {
    const key = roundsOverrideStorageKey(eventId);
    if (!key) return;
    try {
        if (rounds == null) localStorage.removeItem(key);
        else localStorage.setItem(key, String(rounds));
    } catch (e) {}
}

/** Efektywna liczba rund Swiss: ręczny override (per event) albo PlayHub/API. */
function getEffectiveTotalRounds(data) {
    const activeRound = data?.activeRound || 1;
    const apiRounds = getApiTotalRounds(data);
    const override = getStoredRoundsOverride(data?.eventId);
    if (override != null) return Math.max(override, activeRound);
    return apiRounds;
}

function syncRoundsOverrideUi(data) {
    const input = document.getElementById('totalRoundsOverride');
    const hint = document.getElementById('roundsOverrideHint');
    if (!data) return;
    const apiRounds = getApiTotalRounds(data);
    const override = getStoredRoundsOverride(data.eventId);
    const effective = getEffectiveTotalRounds(data);
    if (input) {
        input.dataset.apiRounds = String(apiRounds);
        input.dataset.eventId = String(data.eventId || '');
        // Puste pole = tryb auto (PlayHub); wypełnione = override
        input.value = override != null ? String(override) : '';
        input.placeholder = `Auto: ${apiRounds}`;
    }
    if (hint) {
        if (override != null) {
            hint.textContent = `Ręcznie: ${effective} rund (PlayHub podaje ${apiRounds}). Przycisk „PlayHub” przywraca auto.`;
            hint.style.color = '#f39c12';
        } else {
            hint.textContent = `Auto z PlayHub: ${apiRounds} rund. Wpisz inną liczbę, jeśli organizatorzy podali złą.`;
            hint.style.color = '#64748b';
        }
    }
}

function onRoundsOverrideChanged() {
    const input = document.getElementById('totalRoundsOverride');
    if (!input || !latestData) return;
    const eventId = latestData.eventId || input.dataset.eventId;
    const apiRounds = getApiTotalRounds(latestData);
    const raw = String(input.value || '').trim();
    if (!raw) {
        setStoredRoundsOverride(eventId, null);
    } else if (/^\d+$/.test(raw)) {
        const n = parseInt(raw, 10);
        if (n >= 1 && n <= 20) {
            // Zapisuj override nawet gdy równy API — użytkownik świadomie ustawił wartość
            setStoredRoundsOverride(eventId, n);
        }
    }
    syncRoundsOverrideUi(latestData);
    lastProcessFingerprint = null;
    processStandings(latestData);
    if (currentSelectedPlayerId) recalculateTieForSelectedPlayer();
}

function clearRoundsOverride() {
    const eventId = latestData?.eventId
        || document.getElementById('totalRoundsOverride')?.dataset?.eventId
        || document.getElementById('eventId')?.value;
    setStoredRoundsOverride(eventId, null);
    if (latestData) {
        syncRoundsOverrideUi(latestData);
        lastProcessFingerprint = null;
        processStandings(latestData);
        if (currentSelectedPlayerId) recalculateTieForSelectedPlayer();
    } else {
        const input = document.getElementById('totalRoundsOverride');
        const hint = document.getElementById('roundsOverrideHint');
        if (input) input.value = '';
        if (hint) {
            hint.textContent = 'Domyślnie: wartość z PlayHub. Możesz nadpisać ręcznie.';
            hint.style.color = '#64748b';
        }
    }
}

function loadCutPrefsIntoUi() {
    const cutSizeEl = document.getElementById('cutSize');
    const cutRuleEl = document.getElementById('cutRule');
    if (!cutSizeEl && !cutRuleEl) return;
    try {
        const savedSize = localStorage.getItem(CUT_SIZE_STORAGE_KEY);
        const savedRule = localStorage.getItem(CUT_RULE_STORAGE_KEY);
        if (cutSizeEl && savedSize && /^\d+$/.test(savedSize)) {
            const n = parseInt(savedSize, 10);
            if (n >= 2 && n <= 256) cutSizeEl.value = String(n);
        }
        if (cutRuleEl && (savedRule === 'hard' || savedRule === 'soft')) {
            cutRuleEl.value = savedRule;
        }
    } catch (e) {}
}

function saveCutPrefsFromUi() {
    const cutSizeEl = document.getElementById('cutSize');
    const cutRuleEl = document.getElementById('cutRule');
    try {
        if (cutSizeEl) {
            const n = parseInt(cutSizeEl.value || '4', 10);
            if (Number.isFinite(n) && n >= 2 && n <= 256) {
                localStorage.setItem(CUT_SIZE_STORAGE_KEY, String(n));
            }
        }
        if (cutRuleEl && (cutRuleEl.value === 'hard' || cutRuleEl.value === 'soft')) {
            localStorage.setItem(CUT_RULE_STORAGE_KEY, cutRuleEl.value);
        }
    } catch (e) {}
}

function onCutPrefsChanged() {
    saveCutPrefsFromUi();
    lastProcessFingerprint = null;
    if (latestData) {
        processStandings(latestData);
        if (currentSelectedPlayerId) recalculateTieForSelectedPlayer();
    }
}

function shouldGateHeavyUi(playerCount) {
    return (Number(playerCount) || 0) >= LARGE_EVENT_PLAYER_THRESHOLD;
}

function buildDataFingerprint(data, cutSize, cutRule) {
    const standings = data?.standings?.standings || [];
    const pairings = extractPairingsList(data?.pairings);
    let completedSig = 0;
    let unfinished = 0;
    for (let i = 0; i < pairings.length; i++) {
        const m = pairings[i];
        const { score1, score2, hasScore, winnerId } = getMatchScores(m);
        const status = String(m.status || m.state || '').toUpperCase();
        const isDraw = m.match_is_intentional_draw || m.match_is_unintentional_draw || status === 'DRAW';
        const isComplete = status === 'COMPLETE' || status === 'FINISHED' || status === 'COMPLETED' || winnerId != null || hasScore || isDraw;
        if (isComplete) {
            completedSig = (completedSig * 33 + (Number(winnerId) || 0) + (score1 || 0) * 7 + (score2 || 0) * 11 + (isDraw ? 99 : 0) + i) | 0;
        } else {
            unfinished++;
        }
    }
    const effectiveRounds = getEffectiveTotalRounds(data);
    return [
        data?.eventId || '',
        data?.activeRound || 0,
        data?.standingsRound || 0,
        data?.playerCount || 0,
        standings.length,
        pairings.length,
        completedSig,
        unfinished,
        cutSize,
        cutRule,
        effectiveRounds
    ].join('::');
}

function buildOpponentLookup(pairingsList, standingsMap) {
    const map = new Map();
    for (const m of pairingsList) {
        const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
        const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
        if (p1?.id) map.set(String(p1.id), p2 || null);
        if (p2?.id) map.set(String(p2.id), p1 || null);
    }
    return map;
}

// -------------------------------------------------------------
// FILTR: POLSCY GRACZE (FLAGA PL, GÓRY, SZCZUR, DRUŻYNY)
// -------------------------------------------------------------
const POLISH_TEAM_TAGS = ['GPL', 'M7', 'OSA', 'LV', 'Q2W', 'L4', 'EX', 'IDK'];
const POLISH_RAT_CREW_LABEL = 'rat crew';
const POLISH_FLAG_REGEX = /[\u{1F1F5}\u{1F1F1}]|🇵🇱/u;
const POLISH_MOUNTAIN_REGEX = /[\u{1F3D4}\u{26F0}\u{1F5FB}]|[🏔⛰🗻]/u;
const POLISH_RAT_REGEX = /[\u{1F400}\u{1F401}]|[🐀🐁]/u;

/** Ręczna lista nicków PL (dokładne display + znormalizowane / core nick). Nie usuwać istniejących. */
const POLISH_KNOWN_NICKS = [
    "[M7] damaneks 🇵🇱 🏔️",
    "[M7] Emanuel 🇵🇱 🗻",
    "[M7] Leviniuch",
    "[M7] stankol 🇵🇱⛰️",
    "[M7] Czaro",
    "[M7] Gr4b4rz",
    "[M7] Greyvall",
    "Gamus",
    "Koster",
    "Farfocja",
    "wojtekkow",
    "[GPL] Crusty 🇵🇱 🏔️",
    "[OSA] Zavada 🇵🇱 🐝",
    "[OSA] Erlod  🇵🇱 🏔️",
    "[OSA] Voj4k",
    "[OSA] helisa",
    "Kunikosia",
    "Vanos",
    "[GPL] EvilBunny 🇵🇱🏔️",
    "[EX] Wodnik",
    "[EX] Figure",
    "MaksG",
    "Lisu192 🇵🇱",
    "AgaAlis",
    "[IDK] Yao",
    "Luq1989",
    "🐀Bayo jayo",
    "🐀IamDearDeer🦌🐀",
    "[IDK] timhalf",
    "[LV] Mayxs",
    "[LV] Olawa",
    "🐀Sheitene🐀",
    "NightRaven 🇵🇱🏔️",
    "🐀Zergulek🐀",
    "[GPL] J4kubb 🇵🇱 🏔️",
    "[IDK] simograj  🇵🇱 🏔️",
    "[IDK] Hitorit 🇵🇱🏔",
    "🐀ZZZ_Karation☕🐀",
    "[LV] Chrapek",
    "[LV] Artemizu",
    "daavcio",
    "exeq",
    "Asia",
    "🐀Terry 🥖🐀",
    "Rogal",
    "Ingvar-ᛁᚾᚷᚡᚨᚱ",
    "Szumek",
    "🐀Slonce 🌚🐀",
    "🐀 Aliar 🐀",
    "[LV] Yoza",
    "cziter",
    "[OSA] Moluk🇵🇱🏔️",
    "[OSA] Staś🇵🇱🐝",
    "[LV] Esus 😜",
    "Bags",
    "[OSA] Rico 🇵🇱 🏔️",
    "Rybisznurek",
    "karzel6",
    "🐀Liryq🐀🇵🇱🏔️",
    "🐀Bart_April🐀",
    "🐀Ada_April🐀",
    "Nati",
    "Granit",
    "Nimble_hamster_8174",
    "MichalTrz",
    "Northern",
    "MacMagica",
    "Drago",
    "Gaby"
];

function normalizePolishNickKey(text) {
    return String(text || '')
        .normalize('NFKC')
        .replace(/\uFE0F/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function extractPolishNickCore(text) {
    let s = String(text || '').normalize('NFKC');
    s = s.replace(/^\s*\[[^\]]+\]\s*/u, '');
    s = s.replace(/[\u{1F1E0}-\u{1F1FF}\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '');
    s = s.replace(/\uFE0F/g, '');
    return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

const POLISH_KNOWN_NICK_KEYS = new Set(POLISH_KNOWN_NICKS.map(normalizePolishNickKey).filter(Boolean));
const POLISH_KNOWN_NICK_CORES = new Set(POLISH_KNOWN_NICKS.map(extractPolishNickCore).filter((c) => c && c.length >= 2));

function extractBracketTeamTagsFromText(text) {
    const tags = [];
    const s = String(text || '');
    const re = /\[([^\]]+)\]/gu;
    let m;
    while ((m = re.exec(s)) !== null) {
        const tag = String(m[1] || '').trim().toUpperCase();
        if (tag) tags.push(tag);
    }
    return tags;
}

/** Katalog tagów drużyn PL: stała lista + tagi wyciągnięte z POLISH_KNOWN_NICKS. */
function buildPolishTeamTagCatalog() {
    const set = new Set(POLISH_TEAM_TAGS.map((t) => String(t).toUpperCase()));
    for (const nick of POLISH_KNOWN_NICKS) {
        for (const tag of extractBracketTeamTagsFromText(nick)) {
            set.add(tag);
        }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
}

const POLISH_TEAM_TAG_CATALOG = buildPolishTeamTagCatalog();

function textMatchesPolishTeamTag(text, tag) {
    if (!text || !tag) return false;
    const escaped = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp('(?:^|[\\s_\\|\\-\\[\\(\\{/])' + escaped + '(?=[\\s_\\|\\-\\]\\)\\}:/]|$|\\b)', 'i');
    return regex.test(text);
}

function getPlayerIdentityTexts(playerOrName) {
    if (!playerOrName) return [];
    if (typeof playerOrName === 'string') return [playerOrName].filter(Boolean);

    const standingObj = playerOrName.raw || playerOrName;
    return [
        playerOrName.name,
        standingObj?.user_event_status?.best_identifier,
        standingObj?.player?.best_identifier,
        standingObj?.user_event_status?.user?.username,
        standingObj?.name
    ].filter(Boolean);
}

function getStandingMatchPoints(player) {
    if (!player) return 0;
    const pts = player.livePoints ?? player.match_points ?? 0;
    return Number.isFinite(pts) ? pts : 0;
}

function averagePoints(values) {
    if (!values || values.length === 0) return null;
    const sum = values.reduce((acc, v) => acc + v, 0);
    return sum / values.length;
}

/**
 * Statystyki średnich punktów: gracze z flagą PL oraz per tag drużyny PL
 * (katalog z POLISH_TEAM_TAGS / POLISH_KNOWN_NICKS + „rat crew” z emoji szczura).
 */
function computePolishAvgPointsStats(standings) {
    const list = Array.isArray(standings) ? standings : [];
    const flagPoints = [];
    const teamPoints = new Map();
    for (const tag of POLISH_TEAM_TAG_CATALOG) {
        teamPoints.set(tag, []);
    }
    teamPoints.set(POLISH_RAT_CREW_LABEL, []);

    for (const player of list) {
        const texts = getPlayerIdentityTexts(player);
        if (texts.length === 0) continue;
        const pts = getStandingMatchPoints(player);

        if (texts.some((t) => POLISH_FLAG_REGEX.test(t))) {
            flagPoints.push(pts);
        }
        if (texts.some((t) => POLISH_RAT_REGEX.test(t))) {
            teamPoints.get(POLISH_RAT_CREW_LABEL).push(pts);
        }
        for (const tag of POLISH_TEAM_TAG_CATALOG) {
            if (texts.some((t) => textMatchesPolishTeamTag(t, tag))) {
                teamPoints.get(tag).push(pts);
            }
        }
    }

    const teams = [];
    for (const [tag, values] of teamPoints.entries()) {
        if (values.length === 0) continue;
        teams.push({
            tag,
            count: values.length,
            avgPoints: averagePoints(values)
        });
    }
    teams.sort((a, b) => {
        const avgDiff = (b.avgPoints ?? 0) - (a.avgPoints ?? 0);
        if (avgDiff !== 0) return avgDiff;
        return String(a.tag).localeCompare(String(b.tag));
    });

    return {
        flag: {
            count: flagPoints.length,
            avgPoints: averagePoints(flagPoints)
        },
        teams
    };
}

function formatAvgPointsDisplay(avg) {
    if (avg == null || !Number.isFinite(avg)) return '—';
    return (Math.round(avg * 10) / 10).toFixed(1);
}

function renderPolishAvgPointsTable(standings) {
    const wrap = document.getElementById('polishAvgPointsWrap');
    const body = document.getElementById('polishAvgPointsBody');
    if (!wrap || !body) return;

    const stats = computePolishAvgPointsStats(standings);
    const rows = [];

    if (stats.flag.count > 0) {
        rows.push({
            label: '🇵🇱 Flaga PL',
            count: stats.flag.count,
            avgPoints: stats.flag.avgPoints
        });
    }
    for (const team of stats.teams) {
        const label = team.tag === POLISH_RAT_CREW_LABEL
            ? '🐀 rat crew'
            : `[${team.tag}]`;
        rows.push({
            label,
            count: team.count,
            avgPoints: team.avgPoints
        });
    }

    const hasAny = rows.length > 0;
    wrap.style.display = hasAny ? 'block' : 'none';
    if (!hasAny) {
        body.innerHTML = '';
        return;
    }

    body.innerHTML = rows.map((r) => (
        `<tr>` +
        `<td>${escapeHtml(r.label)}</td>` +
        `<td>${r.count}</td>` +
        `<td><strong>${formatAvgPointsDisplay(r.avgPoints)}</strong></td>` +
        `</tr>`
    )).join('');
}

let filterOnlyPoles = false;
let currentLiveStatusFilter = 'all';
let currentPredictorScenario = 'WIN';
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
    const onReady = () => {
        if (window.innerWidth < 768) {
            toggleOfficialTableSection(true);
        }
        initDefaultEventAndAutoTrack();
    };
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', onReady);
    } else {
        onReady();
    }
}

function checkTextForPolishIndicators(text) {
    if (!text || typeof text !== 'string') return false;
    if (POLISH_FLAG_REGEX.test(text)) return true;
    if (POLISH_MOUNTAIN_REGEX.test(text)) return true;
    if (POLISH_RAT_REGEX.test(text)) return true;

    const nickKey = normalizePolishNickKey(text);
    if (nickKey && POLISH_KNOWN_NICK_KEYS.has(nickKey)) return true;
    const nickCore = extractPolishNickCore(text);
    if (nickCore && POLISH_KNOWN_NICK_CORES.has(nickCore)) return true;

    for (const tag of POLISH_TEAM_TAG_CATALOG) {
        if (textMatchesPolishTeamTag(text, tag)) return true;
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
    const list = cachedFilteredLiveList.length
        ? cachedFilteredLiveList
        : filterLiveStandingsList(cachedLiveStandings, {
            filterOnlyPoles,
            statusFilter: currentLiveStatusFilter,
            searchQuery: liveTableSearchQuery,
            standingsMap: cachedStandingsMap,
            cutSize: cachedCutContext.cutSize,
            simCache: simulatedResultsCache
        });
    const totalPages = Math.ceil((list.length || 0) / PAGE_SIZE);
    currentPages.live = Math.max(1, Math.min(newPage, totalPages || 1));
    const viewport = typeof document !== 'undefined' ? document.getElementById('liveStandingsViewport') : null;
    if (viewport) {
        const targetTop = (currentPages.live - 1) * PAGE_SIZE * LIVE_ROW_HEIGHT;
        viewport.scrollTop = targetTop;
        liveVirtScrollTop = targetTop;
    }
    renderLiveStandingsTable();
}

function onLiveStandingsScroll(ev) {
    const el = ev?.target || (typeof document !== 'undefined' ? document.getElementById('liveStandingsViewport') : null);
    if (!el) return;
    liveVirtScrollTop = el.scrollTop || 0;
    if (liveVirtRaf) return;
    liveVirtRaf = (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : (fn) => setTimeout(fn, 16))(() => {
        liveVirtRaf = null;
        renderLiveStandingsTable({ fromScroll: true });
    });
}

/**
 * Filtr listy LIVE (PL / status cut / wyszukiwarka) — czysta funkcja pod UI i stress.
 */
function filterLiveStandingsList(liveStandings, opts = {}) {
    const {
        filterOnlyPoles: onlyPl = false,
        statusFilter = 'all',
        searchQuery = '',
        standingsMap = null,
        cutSize = 4,
        simCache = null
    } = opts;

    let list = Array.isArray(liveStandings) ? liveStandings : [];
    if (onlyPl) {
        list = list.filter(p => isPolishPlayer(p, standingsMap));
    }
    if (statusFilter && statusFilter !== 'all') {
        list = list.filter(p => {
            const cached = simCache?.get?.(String(p.player.id));
            const sim = cached?.sim;
            const category = getCutStatusCategory(p, sim, cutSize);
            if (statusFilter === 'cut') return category === 'cut' || category === 'bubble';
            if (statusFilter === 'bubble') return category === 'bubble';
            return true;
        });
    }
    const q = String(searchQuery || '').trim().toLowerCase();
    if (q) {
        list = list.filter(p => formatStandingsPlayerName(p).toLowerCase().includes(q));
    }
    return list;
}

/**
 * Okno wirtualne: które indeksy renderować + paddings (px) dla scrolla.
 * Gwarantuje domRows ≤ LIVE_MAX_DOM_ROWS (przy sensownym viewportHeight).
 */
function getLiveVirtualWindow(totalItems, scrollTop, viewportHeight, rowHeight = LIVE_ROW_HEIGHT, overscan = LIVE_OVERSCAN) {
    const total = Math.max(0, totalItems | 0);
    const rowH = Math.max(1, rowHeight | 0);
    const vh = Math.max(rowH, viewportHeight || LIVE_VIEWPORT_ROWS * rowH);
    if (total === 0) {
        return { start: 0, end: 0, topPad: 0, bottomPad: 0, domRows: 0 };
    }
    const start = Math.max(0, Math.floor((scrollTop || 0) / rowH) - overscan);
    const capacity = Math.min(LIVE_MAX_DOM_ROWS, Math.ceil(vh / rowH) + overscan * 2);
    const end = Math.min(total, start + capacity);
    return {
        start,
        end,
        topPad: start * rowH,
        bottomPad: Math.max(0, (total - end) * rowH),
        domRows: Math.max(0, end - start)
    };
}

/**
 * Czysta ścieżka process→LIVE ranking (bez DOM) — do stress / testów.
 */
function computeLiveStandingsList(rawStandings, pairingsList, options = {}) {
    const standingsMap = options.standingsMap || buildStandingsMap(rawStandings || []);
    const isLiveRoundInProgress = Boolean(options.isLiveRoundInProgress);
    const liveScoreDeltas = new Map();
    if (isLiveRoundInProgress && Array.isArray(pairingsList)) {
        for (const m of pairingsList) {
            const p1 = resolvePlayer(getMatchParticipant(m, 1), standingsMap);
            const p2 = resolvePlayer(getMatchParticipant(m, 2), standingsMap);
            const id1 = p1?.id;
            const id2 = p2?.id;
            const { score1, score2, hasScore, winnerId } = getMatchScores(m);
            const status = (m.status || m.state || "").toUpperCase();
            const isComplete = status === "COMPLETE" || status === "FINISHED" || status === "COMPLETED" || winnerId != null || hasScore;
            const isDraw = m.match_is_intentional_draw || m.match_is_unintentional_draw || status === "DRAW";
            if (!isComplete) continue;
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
    }

    const liveStandings = (rawStandings || []).map(p => {
        const delta = liveScoreDeltas.get(String(p.player.id)) || 0;
        return {
            ...p,
            livePoints: (p.match_points || 0) + delta,
            delta
        };
    });

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
    return liveStandings;
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

function nowPerfMs() {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

/** Readable load duration: ms under 1s, otherwise seconds. */
function formatLoadDuration(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1000) return `${Math.round(n)} ms`;
    const s = n / 1000;
    return `${s < 10 ? s.toFixed(2) : s.toFixed(1)} s`;
}

let dataLoadSeq = 0;

function setLoadButtonBusy(busy) {
    const btn = document.querySelector('button.btn-load');
    if (!btn) return;
    btn.disabled = Boolean(busy);
    btn.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function setStatusLoadBusy(message) {
    const el = document.getElementById('status');
    if (!el) return;
    el.classList.add('is-loading');
    el.classList.remove('is-error');
    el.setAttribute('aria-busy', 'true');
    el.innerHTML = `<span class="load-spinner" aria-hidden="true"></span><span class="load-status-text">${escapeHtml(message || 'Ładowanie…')}</span>`;
    setLoadButtonBusy(true);
}

function formatCacheAgeLabel(cacheMeta) {
    if (!cacheMeta || typeof cacheMeta !== 'object') return '';
    const age = Number(cacheMeta.ageSeconds);
    const status = String(cacheMeta.status || '').toUpperCase();
    if (!Number.isFinite(age) || age < 0) {
        return status ? `cache ${status}` : '';
    }
    let ageTxt;
    if (age < 60) ageTxt = `${Math.round(age)}s`;
    else if (age < 3600) ageTxt = `${Math.round(age / 60)}m`;
    else ageTxt = `${(age / 3600).toFixed(1)}h`;
    const tag = status === 'HIT' || status === 'STALE' || status === 'MISS' ? status : 'CACHE';
    return `${tag} · ${ageTxt}`;
}

function setStatusLoadIdle(message, elapsedMs, opts = {}) {
    const el = document.getElementById('status');
    if (!el) return;
    el.classList.remove('is-loading');
    el.classList.toggle('is-error', Boolean(opts.error));
    el.setAttribute('aria-busy', 'false');
    const hasTiming = elapsedMs != null && Number.isFinite(Number(elapsedMs));
    const timing = hasTiming
        ? `<span class="load-timing-pill" title="Pełny cykl klienta: sieć (fetch api.php) + parse JSON + przeliczenie tabel/UI — nie sam RTT">⏱ cykl ${escapeHtml(formatLoadDuration(elapsedMs))}</span>`
        : '';
    const cacheLabel = formatCacheAgeLabel(opts.cacheMeta);
    const cachePill = cacheLabel
        ? `<span class="load-cache-pill" title="Wiek snapshotu cache na serwerze">${escapeHtml(cacheLabel)}</span>`
        : '';
    el.innerHTML = `<span class="load-status-text">${escapeHtml(message || '')}</span>${timing}${cachePill}`;
    setLoadButtonBusy(false);
}

function resolveLoadElapsedMs(opts = {}) {
    if (opts.loadStartedAt != null && Number.isFinite(Number(opts.loadStartedAt))) {
        return nowPerfMs() - Number(opts.loadStartedAt);
    }
    if (opts.loadMs != null && Number.isFinite(Number(opts.loadMs))) {
        return Number(opts.loadMs);
    }
    return null;
}

function startTracking(ev) {
    const rawEventId = document.getElementById('eventId')?.value;
    const eventId = String(rawEventId || '').replace(/\D/g, '');
    if (!eventId) {
        setStatusLoadIdle('Wpisz Event ID turnieju...');
        return;
    }
    if (lastTrackedEventId !== null && String(lastTrackedEventId) !== String(eventId)) {
        // event changed — cut prefs stay (user choice)
    }
    lastTrackedEventId = eventId;
    try {
        localStorage.setItem('lorcana_last_event_id', eventId);
    } catch (e) {}

    // Shift+click → force live PlayHub refresh; normal path uses server cache.
    const forceRefresh = Boolean(ev && ev.shiftKey);
    fetchData(eventId, { forceRefresh });
    if (trackingInterval) clearInterval(trackingInterval);
    trackingInterval = setInterval(() => fetchData(eventId), 30000);
}

function isTestsPage() {
    if (typeof document !== 'undefined' && document.body?.dataset?.page === 'tests') return true;
    if (typeof location === 'undefined') return false;
    const path = String(location.pathname || '').replace(/\\/g, '/').toLowerCase();
    return /\/tests(?:\.html|\/|$)/.test(path) || path.endsWith('/tests');
}

/**
 * Lokalne demo ~2000 graczy / Swiss 12 (aktywna runda 12) — bez PlayHub.
 * Tylko strona /tests — nie eksponować na głównej.
 */
function loadDemo2k12() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (!isTestsPage()) {
        console.warn('[demo] loadDemo2k12 dostępne tylko na /tests');
        setStatusLoadIdle('Demo dostępne tylko na stronie /tests', null, { error: true });
        return;
    }

    const factory = (typeof LorcanaDemoFixture !== 'undefined' && LorcanaDemoFixture.createDemo2kRound12)
        ? LorcanaDemoFixture.createDemo2kRound12
        : null;
    if (!factory) {
        setStatusLoadIdle('Brak generatora demo (scripts/stress-fixture.js).', null, { error: true });
        return;
    }

    if (trackingInterval) {
        clearInterval(trackingInterval);
        trackingInterval = null;
    }

    const loadSeq = ++dataLoadSeq;
    const tGen0 = nowPerfMs();
    setStatusLoadBusy('Generowanie demo 2k / 12 rund…');

    // Odłóż ciężką generację, żeby UI zdążył pokazać spinner
    const run = () => {
        if (loadSeq !== dataLoadSeq) return;
        const data = factory();
        const genMs = Math.round(nowPerfMs() - tGen0);

        const cutEl = document.getElementById('cutSize');
        if (cutEl) {
            cutEl.value = String(data.cutSize || 64);
            try { saveCutPrefsFromUi(); } catch (e) {}
        }
        const eventInput = document.getElementById('eventId');
        if (eventInput) eventInput.value = String(data.eventId || 920012);

        // Demo niesie totalRounds=12 — wyczyść lokalny override bez reprocess starego eventu
        try {
            const overrideInput = document.getElementById('totalRoundsOverride');
            if (overrideInput) overrideInput.value = '';
            setStoredRoundsOverride(data.eventId, null);
        } catch (e) {}

        lastTrackedEventId = String(data.eventId);
        lastProcessFingerprint = null;
        lastAutoCutSyncedEventId = null;
        currentSelectedPlayerId = null;
        simulatedResultsCache = new Map();

        const liveN = data.demoMeta?.liveMatchCount ?? extractPairingsList(data.pairings).length;
        const liveOpen = data.demoMeta?.liveInProgressCount ?? liveN;
        const uiHint = data.demoMeta?.uiHint || 'Po R11, R12 właśnie wystartowała';
        applyLoadedTournamentData(data, {
            statusPrefix: `Demo 2k: ${uiHint} · mecze R${data.activeRound}: ${liveOpen}/${liveN} IN_PROGRESS (gen ${genMs} ms)`,
            autoSelectBubble: true,
            loadStartedAt: tGen0,
            loadSeq
        });
    };

    if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(() => setTimeout(run, 0));
    } else {
        setTimeout(run, 0);
    }
}

/**
 * Wspólna ścieżka po fetch API / demo: process + opcjonalny auto-wybór bubble.
 */
function applyLoadedTournamentData(data, opts = {}) {
    const loadMs = resolveLoadElapsedMs(opts);
    if (opts.loadSeq != null && opts.loadSeq !== dataLoadSeq) return;

    if (!data || data.error) {
        setStatusLoadIdle('BŁĄD: ' + (data?.error || 'brak danych'), loadMs, { error: true });
        return;
    }

    latestData = data;
    const statsPanel = document.getElementById('statsPanel');
    if (statsPanel) statsPanel.style.display = 'block';

    syncRoundsOverrideUi(data);

    const cutSize = parseInt(document.getElementById('cutSize')?.value || String(data.cutSize || 4), 10);
    const cutRule = document.getElementById('cutRule')?.value || 'hard';
    const fingerprint = buildDataFingerprint(data, cutSize, cutRule);
    lastProcessFingerprint = fingerprint;

    processPairings(data);
    processStandings(data);

    let bubbleId = null;
    if (opts.autoSelectBubble) {
        const list = (cachedLiveStandings && cachedLiveStandings.length)
            ? cachedLiveStandings
            : (data.standings?.standings || []);
        const idx = Math.min(Math.max(0, cutSize - 1), list.length - 1);
        const bubble = list[idx];
        bubbleId = bubble?.player?.id || bubble?.id || null;
        if (bubbleId != null) {
            // selectPlayerForTie odpala Can I Tie + timing
            selectPlayerForTie(bubbleId);
        }
    } else if (currentSelectedPlayerId) {
        recalculateTieForSelectedPlayer();
    }

    if (opts.loadSeq != null && opts.loadSeq !== dataLoadSeq) return;

    const prefix = opts.statusPrefix || 'Zaktualizowano';
    const bubbleNote = bubbleId != null ? ` | bubble #${cutSize} id=${bubbleId}` : '';
    const finalMs = resolveLoadElapsedMs(opts);
    setStatusLoadIdle(`${prefix}${bubbleNote} · ${new Date().toLocaleTimeString()}`, finalMs, {
        cacheMeta: opts.cacheMeta || data?._cache || null
    });
}

let lastAutoCutSyncedEventId = null;

async function initDefaultEventAndAutoTrack() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const eventInput = document.getElementById('eventId');
    if (!eventInput) return;

    loadCutPrefsIntoUi();

    // Obsługa wciśnięcia Enter w polu wyszukiwania turnieju
    eventInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            startTracking();
        }
    });

    const urlParams = new URLSearchParams(window.location.search);

    // Demo 2k tylko na stronie /tests (nie na głównej)
    if (isTestsPage()) {
        const demoParam = (urlParams.get('demo') || '').toLowerCase();
        if (demoParam === '2k' || demoParam === '2k12' || demoParam === '2000') {
            loadDemo2k12();
            return;
        }
        // Na /tests bez ?demo=2k nie auto-startujemy żywego eventu
        const testsEventId = urlParams.get('eventId') || urlParams.get('event');
        if (testsEventId && /^\d+$/.test(testsEventId.trim())) {
            eventInput.value = testsEventId.trim();
            startTracking();
        }
        return;
    }

    // 1. Sprawdzamy parametr w adresie URL (?eventId=... lub ?event=...)
    const urlEventId = urlParams.get('eventId') || urlParams.get('event');
    if (urlEventId && /^\d+$/.test(urlEventId.trim())) {
        const cleanId = urlEventId.trim();
        eventInput.value = cleanId;
        try { localStorage.setItem('lorcana_last_event_id', cleanId); } catch (e) {}
        startTracking();
        return;
    }

    // 2. Tymczasowo podstawiamy ostatni turniej zapamiętany lokalnie w przeglądarce (jeśli istnieje)
    let localEventId = null;
    try {
        localEventId = localStorage.getItem('lorcana_last_event_id');
    } catch (e) {}
    if (localEventId && /^\d+$/.test(localEventId.trim())) {
        eventInput.value = localEventId.trim();
    }

    // 3. Pobieramy z serwera turniej, który ostatnio wpisał jakikolwiek użytkownik (last_event.txt)
    try {
        const apiBase = (typeof window !== 'undefined' && window.LORCANA_API_BASE) ? String(window.LORCANA_API_BASE) : '';
        const res = await fetch(`${apiBase}api.php?action=get_last_event&t=${Date.now()}`);
        const data = await res.json();
        if (data && data.lastEventId) {
            const serverLastEventId = String(data.lastEventId);
            eventInput.value = serverLastEventId;
            try { localStorage.setItem('lorcana_last_event_id', serverLastEventId); } catch (e) {}
        }
    } catch (err) {
        // Fallback do wartości lokalnej
    }

    // 4. Jeśli pole ma wartość, automatycznie rozpoczynamy śledzenie
    if (eventInput.value && /^\d+$/.test(eventInput.value.trim())) {
        startTracking();
    }
}

/** Client abort budget for api.php (cold PlayHub @~3k can exceed old ~10s PHP curl caps). SWR hits stay fast. */
const LORCANA_FETCH_ABORT_MS = 180000;

async function fetchData(eventId, opts = {}) {
    const loadSeq = ++dataLoadSeq;
    const t0 = nowPerfMs();
    const forceRefresh = Boolean(opts.forceRefresh);
    setStatusLoadBusy(forceRefresh ? 'Odświeżanie z PlayHub…' : 'Pobieranie z cache…');
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    let abortTimer = null;
    if (controller) {
        abortTimer = setTimeout(() => {
            try { controller.abort(); } catch (e) {}
        }, LORCANA_FETCH_ABORT_MS);
    }
    try {
        const safeEventId = encodeURIComponent(String(eventId).replace(/\D/g, ''));
        const apiBase = (typeof window !== 'undefined' && window.LORCANA_API_BASE) ? String(window.LORCANA_API_BASE) : '';
        // Default: server disk cache (SWR). Optional force → ?refresh=1 (slow live PlayHub).
        const refreshQ = forceRefresh ? '&refresh=1' : '';
        const fetchOpts = controller ? { signal: controller.signal } : {};
        const response = await fetch(`${apiBase}api.php?eventId=${safeEventId}${refreshQ}&t=${Date.now()}`, fetchOpts);
        const data = await response.json();

        if (loadSeq !== dataLoadSeq) return;

        if (data.error) {
            setStatusLoadIdle('BŁĄD: ' + data.error, nowPerfMs() - t0, { error: true });
            return;
        }

        if (data.lastEventId) {
            try { localStorage.setItem('lorcana_last_event_id', String(data.lastEventId)); } catch (e) {}
        }

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

        const cutSize = parseInt(document.getElementById('cutSize')?.value || '4');
        const cutRule = document.getElementById('cutRule')?.value || 'hard';
        const fingerprint = buildDataFingerprint(data, cutSize, cutRule);
        if (fingerprint === lastProcessFingerprint) {
            if (loadSeq !== dataLoadSeq) return;
            setStatusLoadIdle('Bez zmian · ' + new Date().toLocaleTimeString(), nowPerfMs() - t0, {
                cacheMeta: data._cache || null
            });
            return;
        }

        applyLoadedTournamentData(data, {
            statusPrefix: 'Zaktualizowano',
            loadStartedAt: t0,
            loadSeq,
            cacheMeta: data._cache || null
        });
    } catch (error) {
        console.error("Błąd pobierania danych:", error);
        if (loadSeq !== dataLoadSeq) return;
        const aborted = error && (error.name === 'AbortError' || error.code === 20);
        setStatusLoadIdle(
            aborted ? 'Timeout pobierania (zimny PlayHub >3 min). Spróbuj ponownie.' : 'Błąd komunikacji z serwerem.',
            nowPerfMs() - t0,
            { error: true }
        );
    } finally {
        if (abortTimer) clearTimeout(abortTimer);
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
    const rawPairingsList = extractPairingsList(data.pairings);
    const standingsList = data.standings?.standings || [];
    const standingsMap = buildStandingsMap(standingsList);
    const pairingsList = rawPairingsList;

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
        tbody.innerHTML = `<tr><td colspan="5" style="color: #888; padding: 20px;">${emptyMsg}</td></tr>`;
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

        const p1Won = isComplete && !isDraw && (score1 > score2 || (winnerId && p1 && String(p1.id) === String(winnerId)));
        const p2Won = isComplete && !isDraw && (score2 > score1 || (winnerId && p2 && String(p2.id) === String(winnerId)));
        
        const p1Style = p1Won ? 'color: #2ecc71; font-weight: bold;' : '';
        const p2Style = p2Won ? 'color: #2ecc71; font-weight: bold;' : '';

        const safeName1 = escapeHtml(name1);
        const safeName2 = escapeHtml(name2);
        const safeTableNum = escapeHtml(tableNum);

        tr.innerHTML = `
            <td><strong>#${safeTableNum}</strong></td>
            <td class="player-cell-truncate" style="${p1Style}" title="${safeName1}">${safeName1}</td>
            <td class="score-box">${displayScore}</td>
            <td class="player-cell-truncate" style="${p2Style}" title="${safeName2}">${safeName2}</td>
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
    const rawStandings = data.standings?.standings || [];
    
    const activeRound = data.activeRound || 1;
    const totalRounds = getEffectiveTotalRounds(data);
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
    const standings = rawStandings;
    const pairingsList = rawPairingsList;

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
    renderPolishAvgPointsTable(liveStandings);

    const drawStats = calculateTournamentDrawStats(data, pairingsList);
    setElText('tournamentDrawsInfo', `${drawStats.drawMatches} (${drawStats.pct}%)`);
    const drawCardEl = document.getElementById('tournamentDrawsInfo');
    if (drawCardEl) {
        drawCardEl.title = `${drawStats.drawMatches} z ${drawStats.totalMatches} meczów zakończyło się remisem`;
    }

    // 4. Bez MC dla całej sali — wcześniej N×600 sims na main thread padało przy ~700.
    // Symulacja TIE liczy się wyłącznie w recalculateTieForSelectedPlayer (wybrany gracz).
    simulatedResultsCache.clear();

    // 5. Renderujemy tabele / cut-line; ciężki bracket tylko poniżej progu dużego eventu
    renderCutLineBreakdownPanel(liveStandings, cutSize, cutRule, activeRound, totalRounds);
    renderLiveStandingsTable(liveStandings, cutSize, cutRule, activeRound, totalRounds);
    renderOfficialStandingsTable(rawStandings, cutSize, cutRule);
    if (!shouldGateHeavyUi(data.playerCount || liveStandings.length)) {
        renderTopCutBracketPanel(liveStandings, cutSize);
    } else {
        const bracketPanel = document.getElementById('topCutBracketPanel');
        if (bracketPanel) {
            bracketPanel.style.display = 'none';
        }
    }
    updatePolesFilterUI();
}

// -------------------------------------------------------------
// TABELA 1: LIVE STANDINGS & STRATEGIA
// -------------------------------------------------------------

function renderLiveStandingsTable(liveStandings, cutSize, cutRule, activeRound, totalRounds) {
    const fromScroll = !!(liveStandings && typeof liveStandings === 'object' && !Array.isArray(liveStandings) && liveStandings.fromScroll);
    if (!fromScroll) {
        if (liveStandings) cachedLiveStandings = liveStandings;
        if (cutSize !== undefined) cachedCutContext.cutSize = cutSize;
        if (cutRule !== undefined) cachedCutContext.cutRule = cutRule;
        if (activeRound !== undefined) cachedCutContext.activeRound = activeRound;
        if (totalRounds !== undefined) cachedCutContext.totalRounds = totalRounds;
    }

    const ctx = cachedCutContext;
    const tbody = document.getElementById('liveStandingsBody');
    if (!tbody) return;

    const list = filterLiveStandingsList(cachedLiveStandings, {
        filterOnlyPoles,
        statusFilter: currentLiveStatusFilter,
        searchQuery: liveTableSearchQuery,
        standingsMap: cachedStandingsMap,
        cutSize: ctx.cutSize,
        simCache: simulatedResultsCache
    });
    cachedFilteredLiveList = list;

    const infoEl = document.getElementById('liveWindowInfo');
    const viewport = document.getElementById('liveStandingsViewport');

    if (!list || list.length === 0) {
        let emptyMsg = "Trwa symulacja wyników live...";
        if (liveTableSearchQuery) emptyMsg = "Brak graczy pasujących do wyszukiwanej frazy.";
        else if (filterOnlyPoles) emptyMsg = "Brak graczy z Polski w tabeli LIVE.";
        else if (currentLiveStatusFilter !== 'all') emptyMsg = "Brak graczy pasujących do wybranego filtra statusu.";

        tbody.innerHTML = '<tr><td colspan="7" style="color: #888; padding: 20px;">' + emptyMsg + '</td></tr>';
        if (infoEl) infoEl.style.display = 'none';
        renderPagination('livePagination', 0, 1, 'changeLivePage');
        liveVirtLastWindowKey = '';
        return;
    }

    const totalItems = list.length;
    const viewportHeight = viewport
        ? (viewport.clientHeight || LIVE_VIEWPORT_ROWS * LIVE_ROW_HEIGHT)
        : LIVE_VIEWPORT_ROWS * LIVE_ROW_HEIGHT;
    if (viewport && !fromScroll) {
        liveVirtScrollTop = viewport.scrollTop || liveVirtScrollTop;
    }

    const win = getLiveVirtualWindow(totalItems, liveVirtScrollTop, viewportHeight, LIVE_ROW_HEIGHT, LIVE_OVERSCAN);
    const windowKey = totalItems + ':' + win.start + ':' + win.end + ':' + ctx.cutSize + ':' + (currentSelectedPlayerId || '');
    if (fromScroll && windowKey === liveVirtLastWindowKey) {
        return;
    }
    liveVirtLastWindowKey = windowKey;

    currentPages.live = Math.max(1, Math.floor(win.start / PAGE_SIZE) + 1);

    const frag = document.createDocumentFragment();
    if (win.topPad > 0) {
        const topSpacer = document.createElement('tr');
        topSpacer.className = 'live-virt-spacer';
        topSpacer.innerHTML = '<td colspan="7" style="height:' + win.topPad + 'px;"></td>';
        frag.appendChild(topSpacer);
    }

    for (let i = win.start; i < win.end; i++) {
        const player = list[i];
        const displayRank = player.liveRank || (i + 1);
        const tr = document.createElement('tr');
        tr.className = "clickable-row";
        tr.style.height = LIVE_ROW_HEIGHT + 'px';
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
        const cutBadgeHtml = getCutStatusBadge(player, sim, inCut, ctx.cutSize, sim?.matchesLeft);

        let pointsDisplay = '<strong>' + player.livePoints + '</strong>';
        if (player.delta > 0) {
            pointsDisplay += ' <span style="font-size: 11px; color: #2ecc71;">(+' + player.delta + ')</span>';
        }

        tr.className += " " + rowClass;
        if (currentSelectedPlayerId && String(player.player.id) === String(currentSelectedPlayerId)) {
            tr.style.outline = "2px solid #3498db";
            tr.style.backgroundColor = "rgba(52, 152, 219, 0.2)";
        }

        const safeName = escapeHtml(formattedName);
        const safePlayerId = escapeJsAttr(player.player.id);

        tr.innerHTML =
            '<td><strong>' + displayRank + '</strong></td>' +
            '<td class="player-cell-truncate" style="text-align: left;" title="' + safeName + '"><strong>' + safeName + '</strong></td>' +
            '<td>' + pointsDisplay + '</td>' +
            '<td class="tiebreaker omwp-clickable" title="Kliknij, aby otworzyć Inspektora Tiebreakerów (OMW% / GW% / OGW%)" onclick="event.stopPropagation(); openOmwpInspector(\'' + safePlayerId + '\')">' + omwp + ' / ' + gwp + ' / ' + ogwp + ' \uD83D\uDD0D</td>' +
            '<td><strong>' + ptsNeededText + '</strong></td>' +
            '<td class="strategy">' + strategyText + '</td>' +
            '<td>' + cutBadgeHtml + '</td>';
        frag.appendChild(tr);
    }

    if (win.bottomPad > 0) {
        const bottomSpacer = document.createElement('tr');
        bottomSpacer.className = 'live-virt-spacer';
        bottomSpacer.innerHTML = '<td colspan="7" style="height:' + win.bottomPad + 'px;"></td>';
        frag.appendChild(bottomSpacer);
    }

    tbody.innerHTML = '';
    tbody.appendChild(frag);

    if (infoEl) {
        infoEl.style.display = 'block';
        infoEl.textContent = 'Widok wirtualny: wiersze ' + (win.start + 1) + '-' + win.end + ' z ' + totalItems + ' (w DOM <= ' + LIVE_MAX_DOM_ROWS + ')';
    }

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

    // Przewiń wirtualne okno LIVE do wybranego gracza
    const list = cachedFilteredLiveList.length
        ? cachedFilteredLiveList
        : filterLiveStandingsList(cachedLiveStandings, {
            filterOnlyPoles,
            statusFilter: currentLiveStatusFilter,
            searchQuery: liveTableSearchQuery,
            standingsMap: cachedStandingsMap,
            cutSize: cachedCutContext.cutSize,
            simCache: simulatedResultsCache
        });

    if (list && list.length > 0) {
        const pIdx = list.findIndex(p => String(p.player?.id || p.id) === String(playerId));
        if (pIdx !== -1) {
            const viewport = document.getElementById('liveStandingsViewport');
            const targetTop = Math.max(0, pIdx * LIVE_ROW_HEIGHT - LIVE_ROW_HEIGHT * 2);
            if (viewport) {
                viewport.scrollTop = targetTop;
            }
            liveVirtScrollTop = targetTop;
            currentPages.live = Math.floor(pIdx / PAGE_SIZE) + 1;
        }
    }
    renderLiveStandingsTable();

    const resultArea = document.getElementById('tieResultArea');
    if (resultArea) resultArea.style.display = 'block';
    
    recalculateTieForSelectedPlayer();
    
    const tieMod = document.getElementById('tieModule');
    if (tieMod) tieMod.scrollIntoView({ behavior: 'smooth' });
}

function showTieSimLoadingBanner() {
    const banner = document.getElementById('tieRecommendationBanner');
    if (!banner) return;
    banner.className = 'recommendation-box rec-risk';
    banner.innerHTML = '⏳ <strong>Liczenie strategii TIE…</strong> Symulacja Monte Carlo działa w tle (UI pozostaje responsywne).';
}

function applyTieSimulationResults(simResults, targetPlayer, myOpponent, myMatch, activeRound, totalRounds, cutSize, timingMs = null) {
    if (!simResults || !targetPlayer) return;
    if (String(currentSelectedPlayerId) !== String(targetPlayer.player?.id || targetPlayer.id)) return;

    simulatedResultsCache.set(String(currentSelectedPlayerId), { sim: simResults, opp: myOpponent });
    if (timingMs != null && Number.isFinite(timingMs)) {
        lastTieSimMs = timingMs;
        try { console.log(`[Can I Tie] symulacja: ${timingMs} ms`); } catch (e) {}
        const timingEl = document.getElementById('tieSimTimingDisplay');
        if (timingEl) {
            timingEl.style.display = 'inline';
            timingEl.textContent = `Can I Tie: ${timingMs} ms`;
        }
    }

    const formattedName = formatStandingsPlayerName(targetPlayer);
    setElText('selectedPlayerName', formattedName);
    setElText('selectedPlayerTable', myMatch ? `(Stół #${myMatch.table_number || myMatch.tableNumber || '?'} vs ${myOpponent?.name || 'BYE'})` : "");
    const baseOmw = ((targetPlayer.opponent_match_win_percentage || 0) * 100).toFixed(1);
    const baseGw = ((targetPlayer.game_win_percentage || 0) * 100).toFixed(1);
    const baseOgw = ((targetPlayer.opponent_game_win_percentage || 0) * 100).toFixed(1);
    let scopeNote = '';
    if (simResults.scoped) {
        scopeNote = ` | scope ${simResults.scopedPlayerCount}/${simResults.fullPlayerCount}`;
    }
    setElText('selectedPlayerBaseStats', `Stan bazowy: ${targetPlayer.match_points} pkt | OMW: ${baseOmw}% | GW: ${baseGw}% | OGW: ${baseOgw}%${scopeNote}`);

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
                matchStatePill = `<span style="color: #2ecc71;">✅ Twój mecz w R${activeRound} jest zakończony.</span>`;
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

    const currentMatchScenariosWrapper = document.getElementById('currentMatchScenariosWrapper');
    if (currentMatchScenariosWrapper) {
        currentMatchScenariosWrapper.style.display = simResults.matchesLeft === 0 ? 'none' : 'block';
    }

    renderDoubleTiePrompt(simResults, targetPlayer, myOpponent, totalRounds);
    renderMultiRoundScenarios(simResults);

    const currentMatchBasePts = targetPlayer.match_points;
    setElText('tieCurrentRoundNum', activeRound);
    setElText('chanceTieDisplay', simResults.chanceTie + "%");
    setElText('ptsTieDisplay', `Pkt po TIE: ${currentMatchBasePts + 1}`);
    setElText('oppTieChanceDisplay', myOpponent ? `Rywal po TIE: ${simResults.oppChanceTie}%` : `Brak rywala`);

    setElText('chanceWinDisplay', simResults.chanceWin + "%");
    setElText('ptsWinDisplay', `Pkt po WIN: ${currentMatchBasePts + 3}`);

    setElText('chanceLossDisplay', simResults.chanceLoss + "%");
    setElText('ptsLossDisplay', `Pkt po LOSS: ${currentMatchBasePts}`);

    updateRecommendationBanner(simResults, myMatch, targetPlayer, myOpponent, activeRound, totalRounds);
    if (timingMs != null && Number.isFinite(timingMs)) {
        const banner = document.getElementById('tieRecommendationBanner');
        if (banner && banner.innerHTML) {
            banner.innerHTML += ` <span class="tie-timing-pill" title="Czas Monte Carlo Can I Tie">⏱ ${timingMs} ms</span>`;
        }
    }
    renderPlayDrawSeedingPanel(targetPlayer, myOpponent, simResults.isCurrentMatchFinished, cachedLiveStandings, cutSize);

    const playerCount = latestData?.playerCount || (latestData?.standings?.standings?.length || 0);
    if (!shouldGateHeavyUi(playerCount)) {
        renderTopCutBracketPanel(cachedLiveStandings, cutSize);
    } else {
        const bracketPanel = document.getElementById('topCutBracketPanel');
        if (bracketPanel) bracketPanel.style.display = 'none';
    }
    recalculateNextRoundPairingsPredictor(simResults, targetPlayer, activeRound, totalRounds);
    renderLiveStandingsTable();
}

function recalculateTieForSelectedPlayer() {
    if (!latestData || !latestData.standings?.standings || !currentSelectedPlayerId) return;

    const rawStandings = latestData.standings.standings;
    const activeRound = latestData.activeRound || 1;
    const totalRounds = getEffectiveTotalRounds(latestData);

    const cutSize = parseInt(document.getElementById('cutSize')?.value || '4');
    const cutRule = document.getElementById('cutRule')?.value || 'hard';

    const isCompleted = Boolean(latestData.isCompleted || latestData.displayStatus === 'complete');
    const isLiveRoundInProgress = Boolean(activeRound > (latestData.standingsRound || 0) && !isCompleted);

    const rawPairingsList = extractPairingsList(latestData.pairings);
    const standingsMap = buildStandingsMap(rawStandings);
    const standings = rawStandings;
    const pairingsList = rawPairingsList;

    const targetPlayer = standings.find(p => String(p.player?.id || p.id) === String(currentSelectedPlayerId));
    if (!targetPlayer) return;

    let myMatch = null;
    let myOpponent = null;
    const oppLookup = buildOpponentLookup(pairingsList, standingsMap);
    myOpponent = oppLookup.get(String(currentSelectedPlayerId)) || null;

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

    let bubbleScore = standings[Math.min(cutSize - 1, standings.length - 1)]?.match_points || 0;
    if (cachedLiveStandings && cachedLiveStandings.length > 0) {
        const liveBubbleIdx = Math.min(cutSize - 1, cachedLiveStandings.length - 1);
        bubbleScore = cachedLiveStandings[liveBubbleIdx]?.livePoints ?? bubbleScore;
    }
    const projectedFinalBubble = Math.ceil((bubbleScore / Math.max(1, activeRound)) * totalRounds);

    const selectedIdAtStart = String(currentSelectedPlayerId);
    showTieSimLoadingBanner();

    const ctx = prepareTieSimulationContext(
        targetPlayer, myOpponent, standings, pairingsList, standingsMap,
        cutSize, cutRule, activeRound, totalRounds, projectedFinalBubble,
        isLiveRoundInProgress
    );

    const requestToken = tieSimRequestSeq + 1;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());

    runTieSimulationAsync(ctx).then((simResults) => {
        const elapsed = Math.round(((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0));
        if (tieSimActiveRequestId !== requestToken) return;
        if (String(currentSelectedPlayerId) !== selectedIdAtStart) return;
        applyTieSimulationResults(simResults, targetPlayer, myOpponent, myMatch, activeRound, totalRounds, cutSize, elapsed);
        const statusEl = document.getElementById('status');
        if (statusEl && latestData?.demoMeta) {
            const textEl = statusEl.querySelector('.load-status-text');
            if (textEl) {
                const cleaned = (textEl.textContent || '').replace(/\s*·\s*TIE\s+\d+\s*ms/i, '');
                textEl.textContent = `${cleaned} · TIE ${elapsed} ms`;
            } else {
                const prev = statusEl.textContent || '';
                const cleaned = prev.replace(/\s*·\s*TIE\s+\d+\s*ms/i, '');
                setElText('status', `${cleaned} · TIE ${elapsed} ms`);
            }
        }
    }).catch((err) => {
        console.error('Błąd symulacji TIE:', err);
        if (String(currentSelectedPlayerId) !== selectedIdAtStart) return;
        const banner = document.getElementById('tieRecommendationBanner');
        if (banner) {
            banner.className = 'recommendation-box rec-danger';
            banner.innerHTML = '🛑 <strong>Błąd symulacji TIE.</strong> Spróbuj ponownie wybrać gracza.';
        }
    });
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

function prepareTieSimulationContext(targetPlayer, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, currentRound, totalRounds, projectedFinalBubble, isLiveRoundInProgress = true, simCountOverride = null) {
    const fullPlayerCount = Array.isArray(standings) ? standings.length : 0;
    const targetId = targetPlayer.player.id;
    const opponentId = myOpponent?.id || null;

    let isCurrentMatchFinished = !isLiveRoundInProgress;
    let targetFixedRoundDelta = 0;
    let opponentFixedRoundDelta = 0;
    const fixedMatchDeltas = new Map();
    const liveUnfinishedMatches = [];
    const completedRoundOpponents = new Map();

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
            } else if (id1 && id2) {
                liveUnfinishedMatches.push({ id1, id2 });
            }
        });
    }

    const targetBasePts = targetPlayer.match_points + (isCurrentMatchFinished ? targetFixedRoundDelta : 0);
    const maxGain = matchesLeft * 3;
    // Max punktow targetu: baza (z delty) + pozostale otwarte mecze * 3
    const targetCap = targetBasePts + (isCurrentMatchFinished ? matchesLeft * 3 : Math.max(0, matchesLeft - 1) * 3);

    const SCOPE_FULL_FIELD_LIMIT = 250;
    let scopedStandings = standings;
    let fixedAheadCount = 0;
    let scoped = false;

    if (fullPlayerCount > SCOPE_FULL_FIELD_LIMIT) {
        const low = Math.max(0, Math.min(targetBasePts, projectedFinalBubble) - maxGain - 3);
        const high = Math.max(targetCap, projectedFinalBubble) + 3;
        const kept = [];
        for (const p of standings) {
            const pts = p.match_points || 0;
            const pid = p.player?.id;
            const isTarget = String(pid) === String(targetId);
            const isOpp = opponentId && String(pid) === String(opponentId);
            if (isTarget || isOpp || (pts >= low && pts <= high)) {
                kept.push(p);
            } else if (pts > targetCap) {
                fixedAheadCount++;
            }
        }
        const minKeep = Math.min(fullPlayerCount, Math.max(cutSize * 5, 120));
        if (kept.length >= Math.min(minKeep, Math.floor(fullPlayerCount * 0.15)) || kept.length >= 80) {
            scopedStandings = kept;
            scoped = true;
        } else {
            fixedAheadCount = 0;
            scopedStandings = standings;
            scoped = false;
        }
    }

    const scopedIds = new Set(scopedStandings.map(p => p.player.id));
    const basePlayers = scopedStandings.map(p => ({
        id: p.player.id,
        name: p.player.best_identifier,
        points: p.match_points,
        baseOmwp: p.opponent_match_win_percentage || 0.33,
        gwp: p.game_win_percentage || 0.33,
        ogwp: p.opponent_game_win_percentage || 0.33,
        activeOpponentId: roundPairingPairs.get(p.player.id) || null
    }));

    const oppBasePlayer = opponentId ? basePlayers.find(p => p.id === opponentId) : null;
    const oppBasePts = oppBasePlayer
        ? (oppBasePlayer.points + (isCurrentMatchFinished ? opponentFixedRoundDelta : 0))
        : 0;

    const scopedUnfinished = liveUnfinishedMatches.filter(m => scopedIds.has(m.id1) && scopedIds.has(m.id2));
    const scopedFixedDeltas = [];
    fixedMatchDeltas.forEach((delta, id) => {
        if (scopedIds.has(id)) scopedFixedDeltas.push([id, delta]);
    });
    const scopedCompletedOpponents = [];
    completedRoundOpponents.forEach((opp, id) => {
        if (scopedIds.has(id)) scopedCompletedOpponents.push([id, opp]);
    });

    const simCount = Math.max(20, Number(simCountOverride) || getAdaptiveSimCount(fullPlayerCount));

    return {
        simCount,
        targetId,
        opponentId,
        cutSize,
        cutRule,
        currentRound,
        totalRounds,
        projectedFinalBubble,
        matchesLeft,
        isCurrentMatchFinished,
        targetBasePts,
        oppBasePts,
        fixedAheadCount: scoped ? fixedAheadCount : 0,
        basePlayers,
        fixedMatchDeltas: scopedFixedDeltas,
        completedRoundOpponents: scopedCompletedOpponents,
        liveUnfinishedMatches: scoped ? scopedUnfinished : liveUnfinishedMatches.map(m => ({ id1: m.id1, id2: m.id2 })),
        scoped,
        scopedPlayerCount: basePlayers.length,
        fullPlayerCount
    };
}

function runLiveTieSimulation(targetPlayer, myOpponent, standings, pairingsList, standingsMap, cutSize, cutRule, currentRound, totalRounds, projectedFinalBubble, isLiveRoundInProgress = true, simCountOverride = null) {
    const ctx = prepareTieSimulationContext(
        targetPlayer, myOpponent, standings, pairingsList, standingsMap,
        cutSize, cutRule, currentRound, totalRounds, projectedFinalBubble,
        isLiveRoundInProgress, simCountOverride
    );
    return getTieSimCore().executePreparedTieSimulation(ctx);
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
    // Bez MC (reszta tabeli): lekka heurystyka rankingowa — nie udawaj końca Swiss
    if (!sim) {
        return {
            ptsNeededText: "—",
            strategyText: inCut ? "W strefie Cut" : "Poza Cut (wybierz gracza)",
            rowClass: inCut ? "safe" : "dead"
        };
    }
    if (sim.matchesLeft === 0) {
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
    if (!sim) {
        const bubbleBand = Math.max(4, Math.floor(cutSize * 0.25));
        if (rank <= cutSize) return 'cut';
        if (rank <= cutSize + bubbleBand) return 'bubble';
        return 'dead';
    }
    if (sim.matchesLeft === 0) {
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
    // Bez pełnego MC: badge z rankingu LIVE (tania heurystyka zamiast N×sims)
    if (!sim) {
        const rank = player.liveRank || 999;
        const bubbleBand = Math.max(4, Math.floor(cutSize * 0.25));
        if (rank <= Math.max(1, Math.floor(cutSize * 0.5))) {
            return `<span class="cut-badge badge-locked" title="Heurystyka rankingu LIVE (bez MC) — górna połowa Cut">🔒 W CUT</span>`;
        }
        if (rank <= cutSize) {
            return `<span class="cut-badge badge-bubble" title="Heurystyka rankingu LIVE — dolna część Cut / bubble">🟡 BUBBLE</span>`;
        }
        if (rank <= cutSize + bubbleBand) {
            return `<span class="cut-badge badge-bubble" title="Heurystyka rankingu LIVE — tuż pod kreską">🟡 BUBBLE</span>`;
        }
        return `<span class="cut-badge badge-eliminated" title="Heurystyka rankingu LIVE — poza zasięgiem Cut">💀 ODPADA</span>`;
    }
    if (matchesLeft === 0) {
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
    const totalRounds = getEffectiveTotalRounds(latestData);
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
        const totalRounds = getEffectiveTotalRounds(latestData);
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

    // Przy bardzo dużych polach ogranicz listę kandydatów (UI), rachunek i tak jest O(N)
    const gateHeavy = shouldGateHeavyUi(latestData.playerCount || 0);

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
    const topCandidates = candidates.slice(0, gateHeavy ? 5 : 8);

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
                const isPredictedOpp = !st.confirmedOpponent && Boolean(st.projectedOpponent);
                const opp = st.confirmedOpponent || st.projectedOpponent;
                const roleIcon = opp ? (opp.myRole === 'PLAY' ? '🟢 PLAY' : '🟡 DRAW') : '';
                const predBadge = isPredictedOpp
                    ? ` <span class="bracket-pred-badge" title="Przeciwnik spekulacyjny (projekcja awansu)">pred.</span>`
                    : '';
                const oppText = opp
                    ? `<span style="${isPredictedOpp ? 'color:#94a3b8; opacity:0.85;' : ''}">#${opp.seed} ${escapeHtml(opp.name)}${predBadge} (${roleIcon})</span>`
                    : 'TBD';
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
        const isPredicted = Boolean(slotPlayer) && !isConfirmed;
        const displayPlayer = (isConfirmed || showProjected) ? slotPlayer : null;

        const isWinner = match.isCompleted && match.winnerSlot === side;
        const isEliminated = match.isCompleted && match.winnerSlot && match.winnerSlot !== side;
        const isSelectedPlayer = displayPlayer && currentSelectedPlayerId && String(displayPlayer.id) === String(currentSelectedPlayerId);

        const hasPlayDraw = match.playDrawSlot === side;
        const rowSeedClass = hasPlayDraw ? 'bracket-high-seed' : 'bracket-low-seed';
        const winnerClass = isWinner ? 'bracket-winner-row' : (isEliminated ? 'bracket-eliminated-row' : '');
        const selectedRowClass = isSelectedPlayer ? 'bracket-selected-player-row' : '';
        const predictedRowClass = (isPredicted && displayPlayer) ? 'bracket-predicted-row' : '';

        if (!displayPlayer) {
            const feederSeeds = feeder ? feeder.contenders.slice(0, 2).map(c => `#${c.seed}`).join(' / ') : 'TBD';
            const feederLabel = feeder ? `Zwycięzca M#${feeder.matchNumber} (${feederSeeds})` : 'TBD';
            return `
                <div class="bracket-player-row ${rowSeedClass} bracket-predicted-row" style="cursor: default;">
                    <div style="color: #94a3b8; font-style: italic; font-size: 11.5px;">
                        ${escapeHtml(feederLabel)}
                        <span class="bracket-pred-badge" title="Miejsce w drabince jeszcze nie potwierdzone">pred.</span>
                    </div>
                    <span class="play-draw-pill ${hasPlayDraw ? 'pill-play' : 'pill-draw'}">${hasPlayDraw ? '🟢 PLAY' : '🟡 DRAW'}</span>
                </div>
            `;
        }

        const scoreVal = side === 'A' ? match.scoreA : match.scoreB;
        const scoreBadge = (match.isCompleted && scoreVal !== null)
            ? `<span class="bracket-score-pill ${isWinner ? 'win' : ''}">${scoreVal}</span>`
            : '';

        const predBadge = isPredicted
            ? `<span class="bracket-pred-badge" title="Projekcja awansu (wyższy seed) — nie potwierdzony wynik">pred.</span>`
            : '';

        const swissMeta = match.stageIndex === 0
            ? `<span style="font-size: 10.5px; color: #94a3b8; margin-left: 3px;">(${displayPlayer.points}p, ${displayPlayer.omwp}%)</span>`
            : '';

        return `
            <div class="bracket-player-row ${rowSeedClass} ${winnerClass} ${selectedRowClass} ${predictedRowClass}" onclick="selectPlayerForTie('${escapeJsAttr(displayPlayer.id)}')"${isPredicted ? ' title="Projekcja — możliwy awans, nie wynik"' : ''}>
                <div style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
                    <span class="bracket-seed-badge">#${displayPlayer.seed}</span>
                    <span>${escapeHtml(displayPlayer.name)}</span>
                    ${swissMeta}${predBadge}
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
            const hasPredictedSlot = Boolean(
                (m.slotA && !m.slotA.isConfirmed) ||
                (m.slotB && !m.slotB.isConfirmed)
            );
            const isPredictedMatch = !m.isCompleted && !m.isInProgress && (m.stageIndex > 0 || hasPredictedSlot);
            let matchStatusTag = '';
            if (m.isCompleted) {
                matchStatusTag = `<span style="color:#2ecc71;">✅ Zakończony</span>`;
            } else if (m.isInProgress && tree.isTopCutActive) {
                matchStatusTag = `<span style="color:#f39c12;">⏳ Stół #${escapeHtml(m.tableNumber)}</span>`;
            } else if (isPredictedMatch) {
                matchStatusTag = `<span class="bracket-pred-badge" title="Spekulacyjna para / awans wg seedu">pred.</span>`;
            } else if (m.stageIndex === 0) {
                matchStatusTag = `<span>Ćwiartka ${m.quadrantNum} • #${m.highSeed} vs #${m.lowSeed}</span>`;
            } else {
                matchStatusTag = `<span>M#${m.feederA.matchNumber} vs M#${m.feederB.matchNumber}</span>`;
            }

            return `
                <div class="bracket-match-card ${isSelectedPathMatch ? 'selected-in-bracket' : ''} ${isPredictedMatch ? 'predicted-match' : ''}">
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
            <div class="bracket-round-header" style="border-top-color: ${isRealChamp ? '#2ecc71' : 'rgba(125, 211, 252, 0.55)'};">
                <span class="bracket-round-title">${isRealChamp ? '🏆 Zwycięzca' : '👑 Faworyt (pred.)'}</span>
                <span class="bracket-round-sub">Top 1</span>
            </div>
            <div class="bracket-round-matches">
                <div class="bracket-champion-card ${isRealChamp ? '' : 'predicted'}" ${champ ? `style="cursor:pointer;" onclick="selectPlayerForTie('${escapeJsAttr(champ.id)}')"` : ''}>
                    <div style="font-size: 28px; margin-bottom: 6px;${isRealChamp ? '' : ' opacity:0.7;'}">🏆</div>
                    <div style="font-size: 11px; color: ${isRealChamp ? '#fde68a' : '#7dd3fc'}; text-transform: uppercase; font-weight: 800; letter-spacing: 0.5px;">
                        ${isRealChamp
                            ? 'Mistrz Turnieju'
                            : `<span class="bracket-pred-badge" title="Spekulacja wg seedu — nie oficjalny wynik">pred.</span> Projektowany triumfator`}
                    </div>
                    ${champ ? `
                        <div style="font-size: 15px; font-weight: ${isRealChamp ? '800' : '600'}; color: ${isRealChamp ? '#fff' : '#cbd5e1'}; margin-top: 6px;">
                            <span class="bracket-seed-badge">#${champ.seed}</span> ${escapeHtml(champ.name)}
                        </div>
                        <div style="font-size: 11px; color: #94a3b8; margin-top: 4px;">
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        escapeHtml,
        escapeJsAttr,
        formatLoadDuration,
        runLiveTieSimulation,
        prepareTieSimulationContext,
        getAdaptiveSimCount,
        shouldGateHeavyUi,
        LARGE_EVENT_PLAYER_THRESHOLD,
        POLISH_KNOWN_NICKS,
        POLISH_TEAM_TAGS,
        POLISH_TEAM_TAG_CATALOG,
        POLISH_RAT_CREW_LABEL,
        normalizePolishNickKey,
        extractPolishNickCore,
        extractBracketTeamTagsFromText,
        buildPolishTeamTagCatalog,
        textMatchesPolishTeamTag,
        getPlayerIdentityTexts,
        computePolishAvgPointsStats,
        formatAvgPointsDisplay,
        checkTextForPolishIndicators,
        isPolishPlayer,
        PAGE_SIZE,
        LIVE_ROW_HEIGHT,
        LIVE_VIEWPORT_ROWS,
        LIVE_OVERSCAN,
        LIVE_MAX_DOM_ROWS,
        filterLiveStandingsList,
        getLiveVirtualWindow,
        computeLiveStandingsList,
        derivePlayerStrategy,
        getCutStatusCategory,
        getCutStatusBadge,
        buildStandingsMap,
        extractPairingsList,
        resolvePlayer,
        getMatchParticipant,
        getMatchScores,
        getDefaultTotalRounds,
        getApiTotalRounds,
        getEffectiveTotalRounds,
        getPlayerHistoricalMatches,

        calculateCutLineBreakdown,
        getBracketSeedOrder,
        getBracketStageLabel,
        generateTopCutBracket,
        detectActualTopCutInfo,
        buildFullTopCutBracketTree,
        getPlayerBracketPath,
        analyzePlayerTopCutSeeding,
        initDefaultEventAndAutoTrack,
        loadCutPrefsIntoUi,
        saveCutPrefsFromUi,
        onCutPrefsChanged,
        onRoundsOverrideChanged,
        clearRoundsOverride,
        syncRoundsOverrideUi,
        loadDemo2k12,
        applyLoadedTournamentData,
        isTestsPage
    };
}