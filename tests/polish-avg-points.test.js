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
    formatStarPlayerDisplay,
    polishTeamGroupLabel,
    checkTextForPolishIndicators,
    isPolishPlayer
} = require('../app.js');

function standing(id, name, points, livePoints, liveRank) {
    return {
        player: { id, best_identifier: name },
        user_event_status: { best_identifier: name },
        match_points: points,
        livePoints: livePoints != null ? livePoints : points,
        liveRank: liveRank != null ? liveRank : undefined
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
        assert.equal(isPolishPlayer('🐀Sheitene🐀'), true);
        assert.equal(polishTeamGroupLabel(POLISH_RAT_CREW_LABEL), '🐀 rat crew');
    });

    it('treats rat emoji as its own skład (separate from bracket tags)', () => {
        const standings = [
            standing(1, '🐀Terry 🥖🐀', 18),
            standing(2, '🐀Bayo jayo', 12),
            standing(3, '[GPL] Crusty 🇵🇱 🏔️', 15),
            standing(4, '🐀Liryq🐀🇵🇱🏔️', 9)
        ];
        const stats = computePolishAvgPointsStats(standings);
        const rat = stats.teams.find((t) => t.tag === POLISH_RAT_CREW_LABEL);
        const gpl = stats.teams.find((t) => t.tag === 'GPL');

        assert.ok(rat, 'rat crew row must exist');
        assert.equal(rat.count, 3);
        assert.equal(rat.avgPoints, (18 + 12 + 9) / 3);
        assert.equal(rat.star.name, '🐀Terry 🥖🐀');
        assert.equal(rat.star.points, 18);

        assert.ok(gpl);
        assert.equal(gpl.count, 1);
        assert.equal(gpl.star.name, '[GPL] Crusty 🇵🇱 🏔️');

        // Flag group includes Crusty + Liryq (both have 🇵🇱)
        assert.equal(stats.flag.count, 2);
        assert.equal(stats.flag.star.name, '[GPL] Crusty 🇵🇱 🏔️');
        // Terry + Bayo: Polish via 🐀, no 🇵🇱
        assert.equal(stats.noFlag.count, 2);
        assert.equal(stats.noFlag.avgPoints, (18 + 12) / 2);
        assert.equal(stats.noFlag.star.name, '🐀Terry 🥖🐀');
    });

    it('computes avg points and star player for PL-flag / no-flag / teams / rat crew', () => {
        const standings = [
            standing(1, '[GPL] Crusty 🇵🇱 🏔️', 15, 15, 2),
            standing(2, '[GPL] EvilBunny 🇵🇱🏔️', 12, 12, 5),
            standing(3, '[M7] Leviniuch', 9),
            standing(4, '🐀Terry 🥖🐀', 18),
            standing(5, 'Foreign Ace', 21),
            standing(6, '[LV] Mayxs', 6),
            standing(7, 'NightRaven 🇵🇱🏔️', 10)
        ];

        const stats = computePolishAvgPointsStats(standings);

        assert.equal(stats.flag.count, 3); // Crusty, EvilBunny, NightRaven
        assert.equal(stats.flag.avgPoints, (15 + 12 + 10) / 3);
        assert.equal(stats.flag.star.name, '[GPL] Crusty 🇵🇱 🏔️');
        assert.equal(stats.flag.star.points, 15);

        // Leviniuch + Terry + Mayxs: Polish without 🇵🇱 (team tag / rat / known nick)
        assert.equal(stats.noFlag.count, 3);
        assert.equal(stats.noFlag.avgPoints, (9 + 18 + 6) / 3);
        assert.equal(stats.noFlag.star.name, '🐀Terry 🥖🐀');
        assert.equal(stats.noFlag.star.points, 18);

        const byTag = Object.fromEntries(stats.teams.map((t) => [t.tag, t]));
        assert.equal(byTag.GPL.count, 2);
        assert.equal(byTag.GPL.avgPoints, (15 + 12) / 2);
        assert.equal(byTag.GPL.star.name, '[GPL] Crusty 🇵🇱 🏔️');
        assert.equal(byTag.M7.count, 1);
        assert.equal(byTag.M7.star.name, '[M7] Leviniuch');
        assert.equal(byTag.LV.count, 1);
        assert.equal(byTag.LV.avgPoints, 6);
        assert.equal(byTag[POLISH_RAT_CREW_LABEL].count, 1);
        assert.equal(byTag[POLISH_RAT_CREW_LABEL].avgPoints, 18);
        assert.equal(byTag[POLISH_RAT_CREW_LABEL].star.name, '🐀Terry 🥖🐀');
        assert.equal(byTag.OSA, undefined);
        assert.equal(formatAvgPointsDisplay(stats.flag.avgPoints), '12.3');
        assert.equal(formatAvgPointsDisplay(stats.noFlag.avgPoints), '11.0');
        assert.equal(formatAvgPointsDisplay(null), '—');
        assert.equal(formatStarPlayerDisplay(stats.flag.star), '⭐ [GPL] Crusty 🇵🇱 🏔️ (15 pkt)');
        assert.equal(formatStarPlayerDisplay(stats.noFlag.star), '⭐ 🐀Terry 🥖🐀 (18 pkt)');
    });

    it('prefers livePoints when present and breaks star ties by liveRank', () => {
        const standings = [
            standing(1, '[OSA] Zavada 🇵🇱 🐝', 9, 12, 4),
            standing(2, '[OSA] helisa', 6, 12, 3),
            standing(3, '[OSA] Erlod  🇵🇱 🏔️', 6, 6, 10)
        ];
        const stats = computePolishAvgPointsStats(standings);
        const osa = stats.teams.find((t) => t.tag === 'OSA');
        assert.ok(osa);
        assert.equal(osa.avgPoints, 10); // (12 + 12 + 6) / 3
        assert.equal(osa.star.name, '[OSA] helisa'); // same 12 pts, better liveRank
        assert.equal(osa.star.points, 12);
        assert.equal(stats.flag.count, 2);
        assert.equal(stats.flag.star.name, '[OSA] Zavada 🇵🇱 🐝');
        assert.equal(stats.flag.star.points, 12);
        assert.equal(stats.noFlag.count, 1);
        assert.equal(stats.noFlag.star.name, '[OSA] helisa');
        assert.equal(stats.noFlag.avgPoints, 12);
    });

    it('splits Poles with flag vs without flag for the comparison rows', () => {
        const standings = [
            standing(1, 'Lisu192 🇵🇱', 15),
            standing(2, 'Gamus', 12),
            standing(3, 'Farfocja', 9),
            standing(4, 'RandomForeign', 21)
        ];
        const stats = computePolishAvgPointsStats(standings);
        assert.equal(stats.flag.count, 1);
        assert.equal(stats.flag.avgPoints, 15);
        assert.equal(stats.flag.star.name, 'Lisu192 🇵🇱');
        assert.equal(stats.noFlag.count, 2); // Gamus + Farfocja via known-nicks whitelist
        assert.equal(stats.noFlag.avgPoints, (12 + 9) / 2);
        assert.equal(stats.noFlag.star.name, 'Gamus');
    });
});
