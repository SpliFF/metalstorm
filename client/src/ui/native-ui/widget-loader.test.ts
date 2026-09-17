/**
 * widget-loader.test.ts — `ctx.api`, the lobby-API door handed to a game-dir
 * widget (journey-lobby-routes fire 2: `mentor-card.js`'s
 * `fetch('/api/mentor/ai', {credentials:'include'})` always 401s, since the
 * lobby has no cookie auth, only `Authorization: Bearer`, and a game-dir
 * widget is a standalone ES module with no import of the client's token code
 * to attach one itself).
 *
 * `WidgetLoader.load()` itself needs a live `#ui-root` and a manifest fetch
 * to exercise, so this tests the pure `createWidgetApiPort` factory it wires
 * into every widget's context — store/fetch are injected, matching
 * `auth-tokens.test.ts`'s `memStore` pattern, so no browser is needed.
 */

import { describe, it, expect, vi } from 'vitest';
import { createWidgetApiPort } from './widget-loader.js';
import { ACCESS_TOKEN_KEY, type TokenStore } from '../../lobby/auth-tokens.js';

function memStore(initial: Record<string, string> = {}): TokenStore {
    const all = { ...initial };
    return {
        get: (k) => (k in all ? all[k] : null),
        set: (k, v) => { all[k] = v; },
        remove: (k) => { delete all[k]; },
    };
}

describe('createWidgetApiPort', () => {
    it('attaches the bearer token and resolves a relative path against the lobby base', async () => {
        const store = memStore({ [ACCESS_TOKEN_KEY]: 'tok-123' });
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        const api = createWidgetApiPort('http://lobby.test', store, fetchMock);

        await api.fetch('/api/mentor/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });

        expect(fetchMock).toHaveBeenCalledWith('http://lobby.test/api/mentor/ai', {
            method: 'POST',
            body: '{}',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-123' },
        });
    });

    it('sends no Authorization header when no token is held', async () => {
        const store = memStore();
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        const api = createWidgetApiPort('http://lobby.test', store, fetchMock);

        await api.fetch('/api/mentor/ai', { method: 'POST' });

        const [, init] = fetchMock.mock.calls[0];
        expect(init.headers).not.toHaveProperty('Authorization');
    });

    it('leaves an already-absolute path alone', async () => {
        const store = memStore({ [ACCESS_TOKEN_KEY]: 'tok-123' });
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        const api = createWidgetApiPort('http://lobby.test', store, fetchMock);

        await api.fetch('https://elsewhere.test/api/x');

        expect(fetchMock.mock.calls[0][0]).toBe('https://elsewhere.test/api/x');
    });

    it('exposes the lobby base for a widget that needs to build its own URL', () => {
        const api = createWidgetApiPort('http://lobby.test');
        expect(api.lobbyBase).toBe('http://lobby.test');
    });
});
