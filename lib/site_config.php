<?php
/**
 * Shared site settings: active tournament, prediction algorithm, cut/rounds defaults.
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
    return [
        'activeEventId' => $fallbackEvent,
        'predictionAlgorithm' => 'hybrid',
        'defaultCutSize' => 4,
        'defaultCutRule' => 'hard',
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
 * @return array{
 *   activeEventId:int,
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
    $eventId = (int)($data['activeEventId'] ?? $defaults['activeEventId']);
    if ($eventId <= 0 || $eventId > 999999999) {
        $eventId = $defaults['activeEventId'];
    }
    $swiss = array_key_exists('defaultSwissRounds', $data)
        ? lorcana_normalize_swiss_rounds($data['defaultSwissRounds'])
        : $defaults['defaultSwissRounds'];

    return [
        'activeEventId' => $eventId,
        'predictionAlgorithm' => $algo,
        'defaultCutSize' => lorcana_normalize_cut_size(
            $data['defaultCutSize'] ?? $defaults['defaultCutSize'],
            $defaults['defaultCutSize']
        ),
        'defaultCutRule' => lorcana_normalize_cut_rule(
            $data['defaultCutRule'] ?? $defaults['defaultCutRule'],
            $defaults['defaultCutRule']
        ),
        'defaultSwissRounds' => $swiss,
        'updatedAt' => isset($data['updatedAt']) ? (string)$data['updatedAt'] : null,
        'updatedBy' => isset($data['updatedBy']) ? (string)$data['updatedBy'] : null,
    ];
}

/**
 * @param array $patch
 * @return array updated config
 */
function lorcana_save_site_config(array $patch) {
    $current = lorcana_load_site_config();
    if (isset($patch['activeEventId'])) {
        $id = (int)$patch['activeEventId'];
        if ($id > 0 && $id <= 999999999) {
            $current['activeEventId'] = $id;
        }
    }
    if (isset($patch['predictionAlgorithm'])) {
        $algo = strtolower(trim((string)$patch['predictionAlgorithm']));
        if (in_array($algo, ['montecarlo', 'hybrid', 'exact'], true)) {
            $current['predictionAlgorithm'] = $algo;
        }
    }
    if (array_key_exists('defaultCutSize', $patch)) {
        $current['defaultCutSize'] = lorcana_normalize_cut_size(
            $patch['defaultCutSize'],
            $current['defaultCutSize']
        );
    }
    if (array_key_exists('defaultCutRule', $patch)) {
        $current['defaultCutRule'] = lorcana_normalize_cut_rule(
            $patch['defaultCutRule'],
            $current['defaultCutRule']
        );
    }
    if (array_key_exists('defaultSwissRounds', $patch)) {
        $current['defaultSwissRounds'] = lorcana_normalize_swiss_rounds($patch['defaultSwissRounds']);
    }
    $current['updatedAt'] = gmdate('c');
    if (isset($patch['updatedBy'])) {
        $current['updatedBy'] = (string)$patch['updatedBy'];
    }

    if (function_exists('lorcana_atomic_write_json')) {
        lorcana_atomic_write_json(lorcana_site_config_file(), $current);
    } else {
        @file_put_contents(
            lorcana_site_config_file(),
            json_encode($current, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT),
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

    return $current;
}

function lorcana_public_site_config() {
    $cfg = lorcana_load_site_config();
    return [
        'activeEventId' => (int)$cfg['activeEventId'],
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
