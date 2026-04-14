/**
 * In-game template loader.
 *
 * The in-game UI (HUD, quit-confirm overlay, game-over overlay) is built
 * from `.html` + `.css` files under `client/src/ui/`. The engine ships a
 * default set; games can override any subset by shipping replacements at
 * `<game>/ui/<component>/<file>`, served by the lobby HTTP at
 * `/api/games/data/<id>/ui/<component>/<file>`.
 *
 * The loader returns the same `GameTemplates` shape whether or not
 * overrides exist, with per-file fallback to the bundled default. Callers
 * don't need to know which source a template came from.
 */

import { stampUrl } from '../../config.js';
import hudHtml from '../hud/hud.html?raw';
import hudCss from '../hud/hud.css?raw';
import quitConfirmHtml from '../quit-confirm/quit-confirm.html?raw';
import quitConfirmCss from '../quit-confirm/quit-confirm.css?raw';
import gameOverHtml from '../game-over/game-over.html?raw';
import gameOverCss from '../game-over/game-over.css?raw';

/// Bundle of in-game UI templates. Each entry is a raw string — CSS for
/// style keys, HTML for the rest. `renderTemplate` from `../ui.ts` does
/// `{{name}}` substitution at render time.
export interface GameTemplates {
    hudHtml: string;
    hudCss: string;
    quitConfirmHtml: string;
    quitConfirmCss: string;
    gameOverHtml: string;
    gameOverCss: string;
}

/// Each template's relative path under `<game>/ui/`. The same path is
/// used as the HTTP override URL suffix.
const TEMPLATE_PATHS: Record<keyof GameTemplates, string> = {
    hudHtml:          'hud/hud.html',
    hudCss:           'hud/hud.css',
    quitConfirmHtml:  'quit-confirm/quit-confirm.html',
    quitConfirmCss:   'quit-confirm/quit-confirm.css',
    gameOverHtml:     'game-over/game-over.html',
    gameOverCss:      'game-over/game-over.css',
};

const DEFAULT_TEMPLATES: GameTemplates = {
    hudHtml,
    hudCss,
    quitConfirmHtml,
    quitConfirmCss,
    gameOverHtml,
    gameOverCss,
};

/// Return a copy of the bundled engine-default templates.
export function getDefaultGameTemplates(): GameTemplates {
    return { ...DEFAULT_TEMPLATES };
}

/**
 * Fetch a game's in-game template overrides from the lobby HTTP server,
 * falling back per-file to the bundled default on any error or 404.
 *
 * Games can override **any subset** — only the files that exist on disk
 * under `<game>/ui/` are returned; missing files keep the engine default.
 */
export async function loadGameTemplates(
    gameId: string,
    httpBase: string,
): Promise<GameTemplates> {
    const result = getDefaultGameTemplates();
    const base = `${httpBase}/api/games/data/${encodeURIComponent(gameId)}/ui`;

    const fetchOne = async (key: keyof GameTemplates) => {
        const path = TEMPLATE_PATHS[key];
        try {
            const res = await fetch(stampUrl(`${base}/${path}`));
            if (res.ok) {
                result[key] = await res.text();
            }
        } catch {
            // Network error or 404 — keep the default.
        }
    };

    await Promise.all(
        (Object.keys(TEMPLATE_PATHS) as (keyof GameTemplates)[]).map(fetchOne),
    );

    return result;
}
