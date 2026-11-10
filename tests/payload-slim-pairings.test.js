/**
 * Slim API payloads omit duplicated pairings.results and point at
 * roundsMatches[activeRound] via sourceRound — TIE/LIVE must still see matches.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app.js');

describe('getActivePairingsList (slim payload)', () => {
    it('falls back to roundsMatches[sourceRound] when pairings.results is empty', () => {
        const match = {
            id: 1,
            table_number: 7,
            status: 'IN_PROGRESS',
            players: [101, 202],
            match_is_intentional_draw: false,
            games_won_by_winner: null,
            games_won_by_loser: null,
            winning_player: null
        };
        const data = {
            activeRound: 8,
            pairings: { sourceRound: 8, count: 1, results: [] },
            roundsMatches: {
                8: { round_number: 8, matches: [match] }
            }
        };
        const list = app.getActivePairingsList(data);
        assert.equal(list.length, 1);
        assert.equal(list[0].table_number, 7);
        assert.deepEqual(list[0].players, [101, 202]);
    });

    it('prefers non-empty pairings.results when present', () => {
        const data = {
            activeRound: 3,
            pairings: {
                results: [{ id: 9, table_number: 1, players: [1, 2], status: 'COMPLETE' }]
            },
            roundsMatches: {
                3: {
                    matches: [{ id: 99, table_number: 99, players: [3, 4], status: 'IN_PROGRESS' }]
                }
            }
        };
        const list = app.getActivePairingsList(data);
        assert.equal(list.length, 1);
        assert.equal(list[0].id, 9);
    });

    it('getMatchScores works on slim numeric players[] + winning_player id', () => {
        const m = {
            players: [10, 20],
            games_won_by_winner: 2,
            games_won_by_loser: 0,
            winning_player: 10,
            status: 'COMPLETE'
        };
        const scores = app.getMatchScores(m);
        assert.equal(scores.hasScore, true);
        assert.equal(scores.winnerId, 10);
        assert.equal(scores.score1, 2);
        assert.equal(scores.score2, 0);
    });
});
