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

import lobbyCss from './lobby.css?raw';
import reconnectingHtml from './reconnecting.html?raw';
import loginHtml from './login/login.html?raw';
import browserHtml from './browser/browser.html?raw';
import roomEntryHtml from './browser/room-entry.html?raw';
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
    // The lobby's existing /api/vfs/game/* handler maps to
    // content/games/{id}/{path} on disk, so we just nest the lobby UI
    // override files at <game>/ui/lobby/<path> and reuse it.
    const base = `${httpBase}/api/vfs/game/${encodeURIComponent(gameId)}/ui/lobby`;

    const fetchOne = async (key: keyof LobbyTemplates) => {
        const path = TEMPLATE_PATHS[key];
        try {
            const res = await fetch(`${base}/${path}`);
            if (res.ok) {
                result[key] = await res.text();
            }
        } catch {
            // Network error — keep the default. We log nothing here
            // because games legitimately ship partial overrides and we
            // don't want a 404 storm in the console.
        }
    };

    await Promise.all((Object.keys(TEMPLATE_PATHS) as (keyof LobbyTemplates)[])
        .map(fetchOne));

    return result;
}
