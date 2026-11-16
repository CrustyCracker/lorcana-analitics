<?php
/**
 * Shared site settings: multi-tournament slots, prediction algorithm, cut/rounds defaults.
 * Persisted as site_config.json (gitignored runtime file).
 */

if (!defined('LORCANA_CACHE_ROOT')) {
    define('LORCANA_CACHE_ROOT', dirname(__DIR__));
}

/** bcrypt of admin password (UTF-8 "jebaćm7") — never the plaintext. */
if (!defined('LORCANA_ADMIN_PASSWORD_HASH')) {
    define(
        'LORCANA_ADMIN_PASSWORD_HASH',
        '$2y$10$jail64N./r..SsxW6MeK7eZiNAdDI0yL4EGh66yvYLXVphC/VlUbq'
    );
}

function lorcana_site_config_file() {
    return LORCANA_CACHE_ROOT . '/site_config.json';
}

/** Known DLC / CCQ modes → cut defaults. */
function lorcana_prize_mode_defaults($mode) {
    $m = lorcana_normalize_prize_mode($mode);
    if ($m === 'MAIN1') {
        return ['cutSize' => 32, 'cutRule' => 'soft', 'label' => 'DLC MAIN1'];
    }
    if ($m === 'MAIN2') {
        return ['cutSize' => 8, 'cutRule' => 'hard', 'label' => 'DLC MAIN2'];
    }
    if ($m === 'CCQ') {
        return ['cutSize' => 8, 'cutRule' => 'hard', 'label' => 'CCQ / Infinity'];
    }
    return ['cutSize' => 8, 'cutRule' => 'hard', 'label' => 'Własny'];
}

function lorcana_normalize_prize_mode($value) {
    $m = strtoupper(trim((string)$value));
    if (in_array($m, ['MAIN1', 'DLC_MAIN1', 'ME1'], true)) {
        return 'MAIN1';
    }
    if (in_array($m, ['MAIN2', 'DLC_MAIN2', 'ME2'], true)) {
        return 'MAIN2';
    }
    if (in_array($m, ['CCQ', 'INFINITY', 'CCQ_INFINITY'], true)) {
        return 'CCQ';
    }
    return 'custom';
}

function lorcana_new_tournament_slot_id() {
    try {
        return 't_' . bin2hex(random_bytes(4));
    } catch (Throwable $e) {
        return 't_' . substr(sha1(uniqid('', true)), 0, 8);
    }
}

/**
 * @return array{id:string,eventId:int,name:string,mode:string,cutSize:int,cutRule:string,swissRounds:?int}
 */
function lorcana_normalize_tournament_slot($raw, $fallbackEventId = 1007231) {
    $defaultsMode = 'custom';
    if (is_array($raw) && isset($raw['mode'])) {
        $defaultsMode = lorcana_normalize_prize_mode($raw['mode']);
    }
    $modeDefs = lorcana_prize_mode_defaults($defaultsMode);

    $eventId = is_array($raw) ? (int)($raw['eventId'] ?? $fallbackEventId) : (int)$fallbackEventId;
    if ($eventId <= 0 || $eventId > 999999999) {
        $eventId = (int)$fallbackEventId;
    }

    $id = is_array($raw) ? trim((string)($raw['id'] ?? '')) : '';
    if ($id === '' || !preg_match('/^[a-zA-Z0-9_-]{1,40}$/', $id)) {
        $id = lorcana_new_tournament_slot_id();
    }

    $name = is_array($raw) ? trim((string)($raw['name'] ?? '')) : '';
    if ($name === '') {
        $name = (string)$modeDefs['label'] . ' #' . $eventId;
    }
    if (function_exists('mb_substr')) {
        $name = mb_substr($name, 0, 80);
    } else {
        $name = substr($name, 0, 80);
    }

    $cutSize = lorcana_normalize_cut_size(
        is_array($raw) ? ($raw['cutSize'] ?? $modeDefs['cutSize']) : $modeDefs['cutSize'],
        $modeDefs['cutSize']
    );
    $cutRule = lorcana_normalize_cut_rule(
        is_array($raw) ? ($raw['cutRule'] ?? $modeDefs['cutRule']) : $modeDefs['cutRule'],
        $modeDefs['cutRule']
    );
    $swiss = null;
    if (is_array($raw) && array_key_exists('swissRounds', $raw)) {
        $swiss = lorcana_normalize_swiss_rounds($raw['swissRounds']);
    }

    return [
        'id' => $id,
        'eventId' => $eventId,
        'name' => $name,
        'mode' => $defaultsMode,
        'cutSize' => $cutSize,
        'cutRule' => $cutRule,
        'swissRounds' => $swiss,
    ];
}

/**
 * Apply mode defaults onto a slot (cut size/rule) when mode changes or applyDefaults=true.
 */
function lorcana_apply_mode_defaults_to_slot(array $slot, $force = false) {
    $defs = lorcana_prize_mode_defaults($slot['mode'] ?? 'custom');
    if ($force || empty($slot['cutSize'])) {
        $slot['cutSize'] = (int)$defs['cutSize'];
    }
    if ($force || empty($slot['cutRule'])) {
        $slot['cutRule'] = (string)$defs['cutRule'];
    }
    if ($force) {
        $slot['cutSize'] = (int)$defs['cutSize'];
        $slot['cutRule'] = (string)$defs['cutRule'];
    }
    return $slot;
}

function lorcana_site_config_defaults() {
    $fallbackEvent = 1007231;
    if (function_exists('lorcana_last_event_file')) {
        $path = lorcana_last_event_file();
        if (is_file($path)) {
            $n = (int)trim((string)@file_get_contents($path));
            if ($n > 0) {
                $fallbackEvent = $n;
            }
        }
    }
    $slot = lorcana_normalize_tournament_slot([
        'id' => 't_default',
        'eventId' => $fallbackEvent,
        'name' => 'Aktywny turniej',
        'mode' => 'MAIN1',
        'cutSize' => 32,
        'cutRule' => 'soft',
        'swissRounds' => null,
    ], $fallbackEvent);

    return [
        'activeEventId' => $fallbackEvent,
        'activeTournamentId' => $slot['id'],
        'tournaments' => [$slot],
        'predictionAlgorithm' => 'hybrid',
        'defaultCutSize' => (int)$slot['cutSize'],
        'defaultCutRule' => (string)$slot['cutRule'],
        /** null = goście biorą liczbę rund z PlayHub (gdy brak lokalnego override). */
        'defaultSwissRounds' => null,
        'updatedAt' => null,
        'updatedBy' => null,
    ];
}

function lorcana_normalize_cut_size($value, $fallback = 4) {
    $n = (int)$value;
    if ($n < 2 || $n > 256) {
        return (int)$fallback;
    }
    return $n;
}

function lorcana_normalize_cut_rule($value, $fallback = 'hard') {
    $rule = strtolower(trim((string)$value));
    if ($rule === 'hard' || $rule === 'soft') {
        return $rule;
    }
    $fb = strtolower(trim((string)$fallback));
    return ($fb === 'soft') ? 'soft' : 'hard';
}

/**
 * @return int|null null = PlayHub auto
 */
function lorcana_normalize_swiss_rounds($value) {
    if ($value === null || $value === '' || $value === false) {
        return null;
    }
    if (is_string($value) && strtolower(trim($value)) === 'auto') {
        return null;
    }
    $n = (int)$value;
    if ($n < 1 || $n > 20) {
        return null;
    }
    return $n;
}

/**
 * Ensure tournaments[] exists; migrate legacy single-event configs.
 *
 * @param array $data
 * @param array $defaults
 * @return array
 */
function lorcana_hydrate_tournaments(array $data, array $defaults) {
    $fallbackEvent = (int)($data['activeEventId'] ?? $defaults['activeEventId']);
    if ($fallbackEvent <= 0) {
        $fallbackEvent = (int)$defaults['activeEventId'];
    }

    $rawList = $data['tournaments'] ?? null;
    $tournaments = [];
    if (is_array($rawList) && count($rawList) > 0) {
        foreach ($rawList as $raw) {
            if (!is_array($raw)) {
                continue;
            }
            $tournaments[] = lorcana_normalize_tournament_slot($raw, $fallbackEvent);
        }
    }

    if (count($tournaments) === 0) {
        $tournaments[] = lorcana_normalize_tournament_slot([
            'id' => 't_default',
            'eventId' => $fallbackEvent,
            'name' => 'Aktywny turniej',
            'mode' => ($data['defaultCutRule'] ?? '') === 'soft' ? 'MAIN1' : 'custom',
            'cutSize' => $data['defaultCutSize'] ?? $defaults['defaultCutSize'],
            'cutRule' => $data['defaultCutRule'] ?? $defaults['defaultCutRule'],
            'swissRounds' => array_key_exists('defaultSwissRounds', $data)
                ? $data['defaultSwissRounds']
                : $defaults['defaultSwissRounds'],
        ], $fallbackEvent);
    }

    // Dedupe ids
    $seen = [];
    foreach ($tournaments as &$t) {
        if (isset($seen[$t['id']])) {
            $t['id'] = lorcana_new_tournament_slot_id();
        }
        $seen[$t['id']] = true;
    }
    unset($t);

    $activeTid = isset($data['activeTournamentId']) ? trim((string)$data['activeTournamentId']) : '';
    $active = null;
    foreach ($tournaments as $t) {
        if ($t['id'] === $activeTid) {
            $active = $t;
            break;
        }
    }
    if ($active === null) {
        // Prefer slot matching activeEventId
        foreach ($tournaments as $t) {
            if ((int)$t['eventId'] === $fallbackEvent) {
                $active = $t;
                break;
            }
        }
    }
    if ($active === null) {
        $active = $tournaments[0];
    }

    return [
        'tournaments' => $tournaments,
        'activeTournamentId' => $active['id'],
        'activeEventId' => (int)$active['eventId'],
        'defaultCutSize' => (int)$active['cutSize'],
        'defaultCutRule' => (string)$active['cutRule'],
        'defaultSwissRounds' => array_key_exists('swissRounds', $active)
            ? $active['swissRounds']
            : (array_key_exists('defaultSwissRounds', $data) ? lorcana_normalize_swiss_rounds($data['defaultSwissRounds']) : null),
        'active' => $active,
    ];
}

/**
 * @return array{
 *   activeEventId:int,
 *   activeTournamentId:string,
 *   tournaments:list,
 *   predictionAlgorithm:string,
 *   defaultCutSize:int,
 *   defaultCutRule:string,
 *   defaultSwissRounds:?int,
 *   updatedAt:?string,
 *   updatedBy:?string
 * }
 */
function lorcana_load_site_config() {
    $defaults = lorcana_site_config_defaults();
    $path = lorcana_site_config_file();
    if (!is_file($path)) {
        return $defaults;
    }
    $raw = (string)@file_get_contents($path);
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return $defaults;
    }
    $algo = strtolower(trim((string)($data['predictionAlgorithm'] ?? 'hybrid')));
    if (!in_array($algo, ['montecarlo', 'hybrid', 'exact'], true)) {
        $algo = 'hybrid';
    }

    $hydrated = lorcana_hydrate_tournaments($data, $defaults);

    return [
        'activeEventId' => (int)$hydrated['activeEventId'],
        'activeTournamentId' => (string)$hydrated['activeTournamentId'],
        'tournaments' => $hydrated['tournaments'],
        'predictionAlgorithm' => $algo,
        'defaultCutSize' => (int)$hydrated['defaultCutSize'],
        'defaultCutRule' => (string)$hydrated['defaultCutRule'],
        'defaultSwissRounds' => $hydrated['defaultSwissRounds'] === null ? null : (int)$hydrated['defaultSwissRounds'],
        'updatedAt' => isset($data['updatedAt']) ? (string)$data['updatedAt'] : null,
        'updatedBy' => isset($data['updatedBy']) ? (string)$data['updatedBy'] : null,
    ];
}

/**
 * Find tournament slot by id.
 */
function lorcana_find_tournament(array $cfg, $tournamentId) {
    $tid = trim((string)$tournamentId);
    foreach ($cfg['tournaments'] ?? [] as $t) {
        if (($t['id'] ?? '') === $tid) {
            return $t;
        }
    }
    return null;
}

/**
 * @param array $patch
 * @return array updated config
 */
function lorcana_save_site_config(array $patch) {
    $current = lorcana_load_site_config();

    if (isset($patch['predictionAlgorithm'])) {
        $algo = strtolower(trim((string)$patch['predictionAlgorithm']));
        if (in_array($algo, ['montecarlo', 'hybrid', 'exact'], true)) {
            $current['predictionAlgorithm'] = $algo;
        }
    }

    // Full tournaments replace (from admin form).
    if (isset($patch['tournaments']) && is_array($patch['tournaments'])) {
        $list = [];
        foreach ($patch['tournaments'] as $raw) {
            if (!is_array($raw)) {
                continue;
            }
            $slot = lorcana_normalize_tournament_slot($raw, $current['activeEventId']);
            if (!empty($patch['applyModeDefaults'])) {
                $slot = lorcana_apply_mode_defaults_to_slot($slot, true);
            }
            $list[] = $slot;
        }
        if (count($list) === 0) {
            $list = $current['tournaments'];
        }
        // Cap slots to keep admin UI sane
        if (count($list) > 12) {
            $list = array_slice($list, 0, 12);
        }
        $current['tournaments'] = $list;
    }

    if (isset($patch['activeTournamentId'])) {
        $found = lorcana_find_tournament($current, $patch['activeTournamentId']);
        if ($found) {
            $current['activeTournamentId'] = $found['id'];
            $current['activeEventId'] = (int)$found['eventId'];
            $current['defaultCutSize'] = (int)$found['cutSize'];
            $current['defaultCutRule'] = (string)$found['cutRule'];
            $current['defaultSwissRounds'] = $found['swissRounds'];
        }
    } elseif (isset($patch['activeEventId'])) {
        // Legacy: set active by event id — match slot or update first / create.
        $id = (int)$patch['activeEventId'];
        if ($id > 0 && $id <= 999999999) {
            $matched = null;
            foreach ($current['tournaments'] as $t) {
                if ((int)$t['eventId'] === $id) {
                    $matched = $t;
                    break;
                }
            }
            if ($matched) {
                $current['activeTournamentId'] = $matched['id'];
                $current['activeEventId'] = $id;
                $current['defaultCutSize'] = (int)$matched['cutSize'];
                $current['defaultCutRule'] = (string)$matched['cutRule'];
                $current['defaultSwissRounds'] = $matched['swissRounds'];
            } else {
                // Update the active slot's eventId
                foreach ($current['tournaments'] as &$t) {
                    if ($t['id'] === $current['activeTournamentId']) {
                        $t['eventId'] = $id;
                        $current['activeEventId'] = $id;
                        break;
                    }
                }
                unset($t);
                $current['activeEventId'] = $id;
            }
        }
    }

    // Legacy single-field cut/rounds patches apply to the active slot.
    $touchActive = false;
    if (array_key_exists('defaultCutSize', $patch)) {
        $current['defaultCutSize'] = lorcana_normalize_cut_size(
            $patch['defaultCutSize'],
            $current['defaultCutSize']
        );
        $touchActive = true;
    }
    if (array_key_exists('defaultCutRule', $patch)) {
        $current['defaultCutRule'] = lorcana_normalize_cut_rule(
            $patch['defaultCutRule'],
            $current['defaultCutRule']
        );
        $touchActive = true;
    }
    if (array_key_exists('defaultSwissRounds', $patch)) {
        $current['defaultSwissRounds'] = lorcana_normalize_swiss_rounds($patch['defaultSwissRounds']);
        $touchActive = true;
    }
    if ($touchActive) {
        foreach ($current['tournaments'] as &$t) {
            if ($t['id'] === $current['activeTournamentId']) {
                $t['cutSize'] = (int)$current['defaultCutSize'];
                $t['cutRule'] = (string)$current['defaultCutRule'];
                $t['swissRounds'] = $current['defaultSwissRounds'];
                $t['eventId'] = (int)$current['activeEventId'];
                break;
            }
        }
        unset($t);
    }

    // Re-sync active fields from chosen slot (source of truth).
    $active = lorcana_find_tournament($current, $current['activeTournamentId']);
    if (!$active && count($current['tournaments']) > 0) {
        $active = $current['tournaments'][0];
        $current['activeTournamentId'] = $active['id'];
    }
    if ($active) {
        $current['activeEventId'] = (int)$active['eventId'];
        $current['defaultCutSize'] = (int)$active['cutSize'];
        $current['defaultCutRule'] = (string)$active['cutRule'];
        $current['defaultSwissRounds'] = $active['swissRounds'];
    }

    $current['updatedAt'] = gmdate('c');
    if (isset($patch['updatedBy'])) {
        $current['updatedBy'] = (string)$patch['updatedBy'];
    }

    $toWrite = [
        'activeEventId' => (int)$current['activeEventId'],
        'activeTournamentId' => (string)$current['activeTournamentId'],
        'tournaments' => $current['tournaments'],
        'predictionAlgorithm' => (string)$current['predictionAlgorithm'],
        'defaultCutSize' => (int)$current['defaultCutSize'],
        'defaultCutRule' => (string)$current['defaultCutRule'],
        'defaultSwissRounds' => $current['defaultSwissRounds'],
        'updatedAt' => $current['updatedAt'],
        'updatedBy' => $current['updatedBy'],
    ];

    if (function_exists('lorcana_atomic_write_json')) {
        lorcana_atomic_write_json(lorcana_site_config_file(), $toWrite);
    } else {
        @file_put_contents(
            lorcana_site_config_file(),
            json_encode($toWrite, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT),
            LOCK_EX
        );
    }

    // Keep last_event.txt in sync for poller / legacy readers.
    if (function_exists('lorcana_set_last_event_id')) {
        lorcana_set_last_event_id($current['activeEventId']);
    } else {
        @file_put_contents(
            LORCANA_CACHE_ROOT . '/last_event.txt',
            (string)$current['activeEventId'],
            LOCK_EX
        );
    }

    // Track all configured event ids for the poller.
    if (function_exists('lorcana_load_tracked_events') && function_exists('lorcana_save_tracked_events')) {
        $map = lorcana_load_tracked_events();
        foreach ($current['tournaments'] as $t) {
            $eid = (int)$t['eventId'];
            if ($eid <= 0) {
                continue;
            }
            $key = (string)$eid;
            $map[$key] = [
                'eventId' => $eid,
                'lastRequestAt' => time(),
                'lastRefreshAt' => $map[$key]['lastRefreshAt'] ?? null,
            ];
        }
        lorcana_save_tracked_events($map);
    }

    return $current;
}

function lorcana_public_site_config() {
    $cfg = lorcana_load_site_config();
    $publicTournaments = [];
    foreach ($cfg['tournaments'] as $t) {
        $publicTournaments[] = [
            'id' => (string)$t['id'],
            'eventId' => (int)$t['eventId'],
            'name' => (string)$t['name'],
            'mode' => (string)$t['mode'],
            'cutSize' => (int)$t['cutSize'],
            'cutRule' => (string)$t['cutRule'],
            'swissRounds' => $t['swissRounds'] === null ? null : (int)$t['swissRounds'],
        ];
    }
    return [
        'activeEventId' => (int)$cfg['activeEventId'],
        'activeTournamentId' => (string)$cfg['activeTournamentId'],
        'tournaments' => $publicTournaments,
        'predictionAlgorithm' => (string)$cfg['predictionAlgorithm'],
        'defaultCutSize' => (int)$cfg['defaultCutSize'],
        'defaultCutRule' => (string)$cfg['defaultCutRule'],
        'defaultSwissRounds' => $cfg['defaultSwissRounds'] === null ? null : (int)$cfg['defaultSwissRounds'],
        'updatedAt' => $cfg['updatedAt'],
    ];
}

/** Min seconds between public ?refresh=1 hits per event (anti-stampede). */
function lorcana_refresh_min_interval_seconds() {
    return 8;
}

function lorcana_refresh_rate_file($eventId) {
    return LORCANA_CACHE_ROOT . '/cache_' . (int)$eventId . '.refresh_at';
}

/**
 * Returns true if a forced refresh is allowed now; records the attempt when allowed.
 */
function lorcana_allow_forced_refresh($eventId, $bypass = false) {
    $eventId = (int)$eventId;
    if ($eventId <= 0) {
        return false;
    }
    if ($bypass) {
        @file_put_contents(lorcana_refresh_rate_file($eventId), (string)time(), LOCK_EX);
        return true;
    }
    $path = lorcana_refresh_rate_file($eventId);
    $last = is_file($path) ? (int)trim((string)@file_get_contents($path)) : 0;
    $min = lorcana_refresh_min_interval_seconds();
    if ($last > 0 && (time() - $last) < $min) {
        return false;
    }
    @file_put_contents($path, (string)time(), LOCK_EX);
    return true;
}
