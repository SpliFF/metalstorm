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
import briefingHtml from '../briefing/briefing.html?raw';
import briefingCss from '../briefing/briefing.css?raw';

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
    /// The scenario briefing splash (S2). Overridable like any other surface,
    /// so a game can dress its own story screen.
    briefingHtml: string;
    briefingCss: string;
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
    briefingHtml:     'briefing/briefing.html',
    briefingCss:      'briefing/briefing.css',
};

const DEFAULT_TEMPLATES: GameTemplates = {
    hudHtml,
    hudCss,
    quitConfirmHtml,
    quitConfirmCss,
    gameOverHtml,
    gameOverCss,
    briefingHtml,
    briefingCss,
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
    // The ui-manifest endpoint returns the set of override files that
    // actually exist under data/games/<id>/ui/ (always 200, empty array
    // when the game ships no ui/ directory). Without this we'd 404 every
    // TEMPLATE_PATHS entry, polluting the devtools network panel.
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

    const base = `${httpBase}/api/games/data/${encodeURIComponent(gameId)}/ui`;
    const fetchOne = async (key: keyof GameTemplates) => {
        const path = TEMPLATE_PATHS[key];
        if (!present.has(path)) return;
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
