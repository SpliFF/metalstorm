/**
 * Client configuration — reads from build-time defines set by Vite.
 */

declare const __GAME_SERVER_PORT__: string;

const gamePort = typeof __GAME_SERVER_PORT__ !== 'undefined'
    ? __GAME_SERVER_PORT__
    : '8011';

const host = window.location.hostname || 'localhost';

export const CONFIG = {
    gameServerPort: gamePort,
    wsUrl: `ws://${host}:${gamePort}`,
    httpUrl: `http://${host}:${gamePort}`,
    /** Build stamp from the server — used for cache-busting asset URLs. */
    buildStamp: 'dev',
};

/**
 * Fetch the engine version and build stamp from the lobby.
 * Called once at startup. Asset URLs use ?v=<stamp> to bust caches
 * on new deployments without requiring hard refresh.
 */
export async function fetchBuildStamp(): Promise<void> {
    try {
        const resp = await fetch(`${CONFIG.httpUrl}/api/version`);
        if (resp.ok) {
            const data = await resp.json();
            if (data.stamp) CONFIG.buildStamp = data.stamp;
        }
    } catch {
        // Server may not support /api/version yet — keep default
    }
}

/**
 * Append the build stamp to a URL for cache-busting.
 * Use for all asset fetches (maps, models, textures).
 */
export function stampUrl(url: string): string {
    if (CONFIG.buildStamp === 'dev') return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}v=${CONFIG.buildStamp}`;
}
