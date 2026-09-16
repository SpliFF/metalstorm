// tool-io-fake.js — a fake `toolIo` for the module-hosted tool handlers.
//
// The handlers in world-tools.js / ai-tools.js / nl-tools.js never touch fetch
// or sqlite directly: everything arrives through the injected `io` (server.js
// builds the real one). This is the test-side twin — routes matched by
// `METHOD /path`, calls recorded, and `authedFetch` handing out a fixed token
// so a test can assert the Authorization header was actually set.

/**
 * @param routes  { 'GET /api/world': {status?, body} | fn({url, init}) }
 * @returns {io, calls}
 */
export function fakeIo(routes = {}, opts = {}) {
    const calls = [];
    const fetch = async (url, init = {}) => {
        const method = (init.method || 'GET').toUpperCase();
        const u = new URL(url);
        const key = `${method} ${u.pathname}`;
        calls.push({ key, url, method, init, query: Object.fromEntries(u.searchParams) });
        let route = routes[key];
        if (route === undefined) {
            return response(404, { error: 'no_such_route', key });
        }
        if (typeof route === 'function') route = await route({ url: u, init, method });
        if (route && route.stream) return streamResponse(route);
        return response(route.status ?? 200, route.body ?? {});
    };
    const io = {
        lobbyUrl: opts.lobbyUrl || 'http://lobby.test:8011',
        logServerUrl: 'http://logs.test:8010',
        fetch,
        authedFetch: async (makeReq) => makeReq(opts.token || 'TOKEN-abc'),
        resolveServer: opts.resolveServer
            || (async (roomId) => ({ server: { url: 'http://game.test:9100', room_id: roomId ?? 5, port: 9100 } })),
        getGameServers: async () => opts.servers || [],
        execLua: opts.execLua || (async () => ({ success: false, output: 'no execLua in this fake' })),
        execJsonVerb: opts.execJsonVerb || (async () => ({ legacy: null })),
        authUser: 'mcp',
    };
    return { io, calls };
}

function response(status, body) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

/** An SSE-ish response: `stream` is an array of chunks, optionally delayed. */
function streamResponse({ status = 200, stream = [], delayMs = 0 }) {
    async function* gen() {
        for (const chunk of stream) {
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            yield Buffer.from(chunk, 'utf8');
        }
    }
    return { ok: status >= 200 && status < 300, status, body: gen(), text: async () => '' };
}
