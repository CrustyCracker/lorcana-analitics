const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    POLISH_TEAM_TAGS,
    POLISH_TEAM_TAG_CATALOG,
    POLISH_RAT_CREW_LABEL,
    POLISH_KNOWN_NICKS,
    extractBracketTeamTagsFromText,
    buildPolishTeamTagCatalog,
    textMatchesPolishTeamTag,
    computePolishAvgPointsStats,
    formatAvgPointsDisplay,
    checkTextForPolishIndicators
} = require('../app.js');

function standing(id, name, points, livePoints) {
    return {
        player: { id, best_identifier: name },
        user_event_status: { best_identifier: name },
        match_points: points,
        livePoints: livePoints != null ? livePoints : points
    };
}

describe('Polish avg points stats', () => {
    it('derives team tag catalog from POLISH_TEAM_TAGS and POLISH_KNOWN_NICKS brackets', () => {
        for (const tag of POLISH_TEAM_TAGS) {
            assert.ok(POLISH_TEAM_TAG_CATALOG.includes(String(tag).toUpperCase()), `missing ${tag}`);
        }
        const fromNicks = new Set();
        for (const nick of POLISH_KNOWN_NICKS) {
            for (const tag of extractBracketTeamTagsFromText(nick)) {
                fromNicks.add(tag);
            }
        }
        assert.ok(fromNicks.has('GPL'));
        assert.ok(fromNicks.has('M7'));
        assert.ok(fromNicks.has('LV'));
        assert.ok(fromNicks.has('OSA'));
        assert.ok(fromNicks.has('EX'));
        assert.ok(fromNicks.has('IDK'));
        for (const tag of fromNicks) {
            assert.ok(POLISH_TEAM_TAG_CATALOG.includes(tag), `catalog missing nick tag ${tag}`);
        }
        assert.deepEqual(buildPolishTeamTagCatalog(), POLISH_TEAM_TAG_CATALOG);
    });

    it('matches bracket team tags with the same Polish-filter heuristic', () => {
        assert.equal(textMatchesPolishTeamTag('[GPL] Crusty 🇵🇱 🏔️', 'GPL'), true);
        assert.equal(textMatchesPolishTeamTag('[M7] damaneks', 'M7'), true);
        assert.equal(textMatchesPolishTeamTag('AGPL Bot', 'GPL'), false);
        assert.equal(textMatchesPolishTeamTag('NoTeamHere', 'M7'), false);
        assert.equal(checkTextForPolishIndicators('[Q2W] Test'), true);
        assert.equal(checkTextForPolishIndicators('🐀Bayo jayo'), true);
    });

    it('computes avg points for PL-flag players and per team / rat crew', () => {
        const standings = [
            standing(1, '[GPL] Crusty 🇵🇱 🏔️', 15),
            standing(2, '[GPL] EvilBunny 🇵🇱🏔️', 12),
            standing(3, '[M7] Leviniuch', 9),
            standing(4, '🐀Terry 🥖🐀', 18),
            standing(5, 'Foreign Ace', 21),
            standing(6, '[LV] Mayxs', 6),
            standing(7, 'NightRaven 🇵🇱🏔️', 10)
        ];

        const stats = computePolishAvgPointsStats(standings);

        assert.equal(stats.flag.count, 3); // Crusty, EvilBunny, NightRaven
        assert.equal(stats.flag.avgPoints, (15 + 12 + 10) / 3);

        const byTag = Object.fromEntries(stats.teams.map((t) => [t.tag, t]));
        assert.equal(byTag.GPL.count, 2);
        assert.equal(byTag.GPL.avgPoints, (15 + 12) / 2);
        assert.equal(byTag.M7.count, 1);
        assert.equal(byTag.M7.avgPoints, 9);
        assert.equal(byTag.LV.count, 1);
        assert.equal(byTag.LV.avgPoints, 6);
        assert.equal(byTag[POLISH_RAT_CREW_LABEL].count, 1);
        assert.equal(byTag[POLISH_RAT_CREW_LABEL].avgPoints, 18);
        assert.equal(byTag.OSA, undefined);
        assert.equal(formatAvgPointsDisplay(stats.flag.avgPoints), '12.3');
        assert.equal(formatAvgPointsDisplay(null), '—');
    });

    it('prefers livePoints when present', () => {
        const standings = [
            standing(1, '[OSA] Zavada 🇵🇱 🐝', 9, 12),
            standing(2, '[OSA] helisa', 6, 6)
        ];
        const stats = computePolishAvgPointsStats(standings);
        const osa = stats.teams.find((t) => t.tag === 'OSA');
        assert.ok(osa);
        assert.equal(osa.avgPoints, 9); // (12 + 6) / 2
        assert.equal(stats.flag.count, 1);
        assert.equal(stats.flag.avgPoints, 12);
    });
});
