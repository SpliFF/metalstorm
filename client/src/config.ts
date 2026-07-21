/**
 * Client configuration — reads from build-time defines set by Vite.
 */

declare const __GAME_SERVER_PORT__: string;

const gamePort = typeof __GAME_SERVER_PORT__ !== 'undefined'
    ? __GAME_SERVER_PORT__
    : '8011';

// `globalThis.location` resolves to Window.location on the main thread and
// WorkerLocation in a worker (both expose `.hostname`) — GW4 imports the
// def/render modules that pull in CONFIG into the game-processor worker.
const host = globalThis.location.hostname || 'localhost';

export const CONFIG = {
    gameServerPort: gamePort,
    httpUrl: `http://${host}:${gamePort}`,
    /** Build stamp from the server — used for cache-busting asset URLs. */
    buildStamp: 'dev',
    /**
     * PLAN-client-resilience.md task 3: server-operator opt-out for the
     * `/api/client-errors` report channel (spring-lobby
     * `--disable-client-error-reports`). Defaults true (fail-open) until
     * /api/version answers — matches the courtesy default ("default on for
     * the official beta, off in the sample config" is a server-side choice,
     * surfaced here, not a client default).
     */
    errorReportingEnabled: true,
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
            if (data.errorReportingEnabled === false) CONFIG.errorReportingEnabled = false;
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
