const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Minimal document stub so processStandings / reset can stamp event markers
 * and replace LIVE rows without a browser.
 */
function installMinimalDom() {
    const elements = new Map();

    function makeEl(id, tag = 'div') {
        const el = {
            id,
            tagName: String(tag).toUpperCase(),
            style: {},
            dataset: {},
            innerHTML: '',
            innerText: '',
            textContent: '',
            children: [],
            value: '',
            scrollTop: 0,
            clientHeight: 704,
            appendChild(child) {
                this.children.push(child);
                if (child && child.outerHTML) {
                    this.innerHTML += child.outerHTML;
                } else if (child && child.innerHTML != null) {
                    this.innerHTML += child.innerHTML || '';
                }
                return child;
            },
            setAttribute() {},
            getAttribute() { return null; }
        };
        elements.set(id, el);
        return el;
    }

    makeEl('liveStandingsBody', 'tbody');
    makeEl('officialStandingsBody', 'tbody');
    makeEl('pairingsBody', 'tbody');
    makeEl('liveStandingsViewport', 'div');
    makeEl('liveWindowInfo', 'div');
    makeEl('livePagination', 'div');
    makeEl('officialPagination', 'div');
    makeEl('topCutBracketPanel', 'div');
    makeEl('topCutBracketGrid', 'div');
    makeEl('eventNameDisplay', 'span');
    makeEl('totalPlayersDisplay', 'span');
    makeEl('activeRoundInfo', 'span');
    makeEl('roundsLeftInfo', 'span');
    makeEl('officialRoundNum', 'span');
    makeEl('bubbleScore', 'span');
    makeEl('projectedBubbleScore', 'span');
    makeEl('playersInCut', 'span');
    makeEl('tournamentDrawsInfo', 'span');
    makeEl('cutSize', 'input').value = '4';
    makeEl('cutRule', 'select').value = 'hard';
    makeEl('statsPanel', 'div');
    makeEl('polishAvgPointsBody', 'tbody');
    makeEl('cutLineBreakdownPanel', 'div');

    global.document = {
        getElementById(id) {
            return elements.get(id) || null;
        },
        createElement(tag) {
            return {
                tagName: String(tag).toUpperCase(),
                className: '',
                style: {},
                innerHTML: '',
                title: '',
                onclick: null,
                appendChild() { return null; }
            };
        },
        createDocumentFragment() {
            const kids = [];
            return {
                childNodes: kids,
                appendChild(c) { kids.push(c); return c; },
                get innerHTML() {
                    return kids.map(k => k.innerHTML || '').join('');
                }
            };
        }
    };

    // Run deferred paint synchronously so tests don't race afterEach teardown.
    global.requestAnimationFrame = (fn) => {
        fn();
        return 1;
    };
    global.cancelAnimationFrame = () => {};
    global.requestIdleCallback = (fn) => {
        fn();
        return 1;
    };
    global.cancelIdleCallback = () => {};

    return elements;
}

function standingRow(id, name, pts, rank) {
    return {
        id,
        rank,
        match_points: pts,
        record: '1-0-0',
        match_record: '1-0-0',
        opponent_match_win_percentage: 0.5,
        game_win_percentage: 0.5,
        opponent_game_win_percentage: 0.5,
        player: { id, best_identifier: name },
        user_event_status: { best_identifier: name }
    };
}

function makeEventPayload(eventId, players) {
    return {
        eventId,
        eventName: `Event ${eventId}`,
        playerCount: players.length,
        activeRound: 3,
        standingsRound: 2,
        displayStatus: 'inprogress',
        pairings: { pairings: [] },
        standings: { standings: players }
    };
}

describe('Stale standings after tournament ID switch', () => {
    let app;
    let elements;

    beforeEach(() => {
        // Fresh module state per test (app.js keeps module-level caches).
        delete require.cache[require.resolve('../app.js')];
        elements = installMinimalDom();
        app = require('../app.js');
    });

    afterEach(() => {
        try { app.bumpUiApplyGeneration(); } catch (e) {}
        delete global.document;
        delete global.requestAnimationFrame;
        delete global.cancelAnimationFrame;
        delete global.requestIdleCallback;
        delete global.cancelIdleCallback;
        delete require.cache[require.resolve('../app.js')];
    });

    it('reset on ID switch clears cached LIVE rows and stamps the new event marker', () => {
        app.setLatestDataForTest(makeEventPayload(1007231, [
            standingRow(1, 'Alice', 9, 1),
            standingRow(2, 'Bob', 6, 2)
        ]));
        app.setLastTrackedEventIdForTest('1007231');
        app.processStandings(app.getLatestData());
        assert.ok(app.getCachedLiveStandings().length >= 2);
        assert.equal(elements.get('liveStandingsBody').dataset.eventId, '1007231');
        assert.match(elements.get('liveStandingsBody').innerHTML, /Alice|Bob/);

        const gen = app.resetTournamentViewForEventSwitch('1233041');
        assert.ok(gen >= 1);
        assert.equal(app.getCachedLiveStandings().length, 0);
        assert.equal(app.getLatestData(), null);
        assert.equal(elements.get('liveStandingsBody').dataset.eventId, '1233041');
        assert.match(elements.get('liveStandingsBody').innerHTML, /Ładowanie|nowego turnieju/i);
        assert.doesNotMatch(elements.get('liveStandingsBody').innerHTML, /Alice|Bob/);
    });

    it('ID switch A→B replaces LIVE standings rows and event marker', () => {
        const eventA = makeEventPayload(1007231, [
            standingRow(11, 'OldChamp', 18, 1),
            standingRow(12, 'OldSecond', 15, 2)
        ]);
        const eventB = makeEventPayload(1233041, [
            standingRow(21, 'NewLead', 12, 1),
            standingRow(22, 'NewTwo', 9, 2),
            standingRow(23, 'NewThree', 6, 3)
        ]);

        app.setLastTrackedEventIdForTest('1007231');
        app.applyLoadedTournamentData(eventA, { loadSeq: null });
        assert.equal(elements.get('liveStandingsBody').dataset.eventId, '1007231');
        assert.match(elements.get('liveStandingsBody').innerHTML, /OldChamp/);

        app.resetTournamentViewForEventSwitch('1233041');
        app.setLastTrackedEventIdForTest('1233041');
        app.applyLoadedTournamentData(eventB, { loadSeq: null });

        assert.equal(elements.get('liveStandingsBody').dataset.eventId, '1233041');
        assert.match(elements.get('liveStandingsBody').innerHTML, /NewLead/);
        assert.doesNotMatch(elements.get('liveStandingsBody').innerHTML, /OldChamp|OldSecond/);
        assert.equal(app.getCachedLiveStandings().length, 3);
        assert.equal(normalizeEventId(app.getLatestData()?.eventId), '1233041');
    });

    it('empty standings for the new event clear old LIVE rows (no silent early-return keep)', () => {
        const eventA = makeEventPayload(1007231, [
            standingRow(1, 'StickyRow', 9, 1)
        ]);
        const eventB = {
            eventId: 876881,
            eventName: 'Upcoming',
            playerCount: 19,
            activeRound: 0,
            standingsRound: 0,
            displayStatus: 'upcoming',
            pairings: { pairings: [] },
            standings: null
        };

        app.setLastTrackedEventIdForTest('1007231');
        app.applyLoadedTournamentData(eventA, { loadSeq: null });
        assert.match(elements.get('liveStandingsBody').innerHTML, /StickyRow/);

        app.resetTournamentViewForEventSwitch('876881');
        app.setLastTrackedEventIdForTest('876881');
        app.applyLoadedTournamentData(eventB, { loadSeq: null });

        assert.equal(elements.get('liveStandingsBody').dataset.eventId, '876881');
        assert.equal(app.getCachedLiveStandings().length, 0);
        assert.doesNotMatch(elements.get('liveStandingsBody').innerHTML, /StickyRow/);
        assert.match(elements.get('liveStandingsBody').innerHTML, /Brak tabeli|Ładowanie/i);
    });

    it('top cut change applies to the current tracked eventId only', () => {
        const eventB = makeEventPayload(1233041, [
            standingRow(1, 'P1', 12, 1),
            standingRow(2, 'P2', 9, 2),
            standingRow(3, 'P3', 6, 3),
            standingRow(4, 'P4', 3, 4),
            standingRow(5, 'P5', 0, 5)
        ]);
        app.setLastTrackedEventIdForTest('1233041');
        app.applyLoadedTournamentData(eventB, { loadSeq: null });

        elements.get('cutSize').value = '8';
        app.onCutPrefsChanged();
        assert.equal(app.getUiApplyGeneration() >= 1, true);
        // Re-render still bound to current event marker.
        assert.equal(elements.get('liveStandingsBody').dataset.eventId, '1233041');
        assert.match(elements.get('liveStandingsBody').innerHTML, /P1/);

        // Stale latestData from a previous event must not drive cut updates.
        app.setLatestDataForTest(makeEventPayload(1007231, [standingRow(9, 'Stale', 99, 1)]));
        elements.get('cutSize').value = '2';
        app.onCutPrefsChanged();
        assert.doesNotMatch(elements.get('liveStandingsBody').innerHTML, /Stale/);
        assert.equal(elements.get('liveStandingsBody').dataset.eventId, '1233041');
    });
});

function normalizeEventId(eventId) {
    return String(eventId || '').replace(/\D/g, '');
}
