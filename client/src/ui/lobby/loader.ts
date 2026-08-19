/**
 * Lobby template loader.
 *
 * The lobby UI is built from a small bundle of `.html` + `.css` files
 * under `client/src/ui/lobby/`. The engine ships a minimalist default
 * set; games can override any subset by shipping replacements at
 * `<game>/ui/lobby/<path>`, served by the lobby HTTP at
 * `/api/games/<id>/ui/lobby/<path>`.
 *
 * The "active" templates are the engine defaults until a game id is
 * known (via URL param, CLI arg, or in-lobby selection), at which
 * point `loadGameLobbyTemplates(gameId)` fetches the override bundle
 * in parallel with per-file fallback to the bundled default. The
 * loader returns the same shape either way so callers (the LobbyUI
 * class) don't need to know which is which.
 */

import { stampUrl } from '../../config.js';
import lobbyCss from './lobby.css?raw';
import reconnectingHtml from './reconnecting.html?raw';
import loginHtml from './login/login.html?raw';
import browserHtml from './browser/browser.html?raw';
import roomEntryHtml from './browser/room-entry.html?raw';
import warEntryHtml from './browser/war-entry.html?raw';
import replayEntryHtml from './browser/replay-entry.html?raw';
import mapCardHtml from './browser/map-card.html?raw';
import roomHtml from './room/room.html?raw';
import playerRowHtml from './room/player-row.html?raw';

/// Bundle of templates the lobby renders. Each entry is a raw string —
/// CSS for `styles`, HTML for everything else. `renderTemplate` from
/// `../ui.ts` does `{{name}}` substitution at render time.
export interface LobbyTemplates {
    styles: string;
    reconnecting: string;
    login: string;
    browser: string;
    browserRoomEntry: string;
    /// One row of the WAR browser (PLAN-metalstorm-lobby.md §4, task 6). A
    /// separate template from `browserRoomEntry` because it answers a
    /// different question — which side, how many seats, how the front stands
    /// — and a game that restyles one has no reason to be forced to restyle
    /// the other.
    browserWarEntry: string;
    /// One row of the replay browser (PLAN-replay task 4c).
    browserReplayEntry: string;
    browserMapCard: string;
    room: string;
    roomPlayerRow: string;
}

/// Each template's relative path under `<game>/ui/lobby/`. The same
/// path is used both as the HTTP override URL suffix and as the
/// reference for documentation.
const TEMPLATE_PATHS: Record<keyof LobbyTemplates, string> = {
    styles:          'lobby.css',
    reconnecting:    'reconnecting.html',
    login:           'login/login.html',
    browser:         'browser/browser.html',
    browserRoomEntry: 'browser/room-entry.html',
    browserWarEntry: 'browser/war-entry.html',
    browserReplayEntry: 'browser/replay-entry.html',
    browserMapCard:  'browser/map-card.html',
    room:            'room/room.html',
    roomPlayerRow:   'room/player-row.html',
};

const DEFAULT_TEMPLATES: LobbyTemplates = {
    styles:          lobbyCss,
    reconnecting:    reconnectingHtml,
    login:           loginHtml,
    browser:         browserHtml,
    browserRoomEntry: roomEntryHtml,
    browserWarEntry: warEntryHtml,
    browserReplayEntry: replayEntryHtml,
    browserMapCard:  mapCardHtml,
    room:            roomHtml,
    roomPlayerRow:   playerRowHtml,
};

/// Return a copy of the bundled engine-default templates. Use this for
/// the no-game-selected state and as the seed for game overrides.
export function getDefaultLobbyTemplates(): LobbyTemplates {
    return { ...DEFAULT_TEMPLATES };
}

/**
 * Fetch a game's lobby template overrides from the lobby HTTP server,
 * falling back per-file to the bundled default on any error or 404.
 *
 * Games can override **any subset** of the templates — only the files
 * that exist on disk under `<game>/ui/lobby/` are returned, and missing
 * files keep the engine default. This means a game can ship a single
 * `lobby.css` colour-restyle without re-templating the HTML.
 */
export async function loadGameLobbyTemplates(
    gameId: string,
    httpBase: string,
): Promise<LobbyTemplates> {
    const result = getDefaultLobbyTemplates();
    // Game content (source + converted) is served from data/games/{id}/
    // via /api/games/data/*. Lobby UI overrides nest at <game>/ui/lobby/.
    // The ui-manifest endpoint returns a JSON list of override files that
    // actually exist (always 200, empty array when the game ships no
    // ui/ directory). Without this we'd 404 every TEMPLATE_PATHS entry,
    // polluting the devtools network panel — browsers log 4xx responses
    // even though our `fetch().ok` check handles them silently.
    let present: Set<string>;
    try {
        const res = await fetch(stampUrl(
            `${httpBase}/api/games/${encodeURIComponent(gameId)}/ui-manifest`));
        if (!res.ok) return result;
        const json = await res.json() as { files?: string[] };
        present = new Set(json.files ?? []);
    } catch {
        return result;
    }

    const base = `${httpBase}/api/games/data/${encodeURIComponent(gameId)}/ui/lobby`;
    const fetchOne = async (key: keyof LobbyTemplates) => {
        const path = TEMPLATE_PATHS[key];
        if (!present.has(`lobby/${path}`)) return;
        try {
            const res = await fetch(stampUrl(`${base}/${path}`));
            if (res.ok) {
                result[key] = await res.text();
            }
        } catch {
            // Network error — keep the default.
        }
    };

    await Promise.all((Object.keys(TEMPLATE_PATHS) as (keyof LobbyTemplates)[])
        .map(fetchOne));

    return result;
}
