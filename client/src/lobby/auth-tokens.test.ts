/**
 * auth-tokens.test.ts — PLAN-metalstorm-lobby.md §7.2/§7.3, task 8a.
 *
 * The server-side rotation ladder is pinned in tests/test_auth_tokens.cpp.
 * What is testable only here is the client's *judgement* about a failed
 * refresh, and every case below is one where the obvious code is wrong in a
 * way no type checks:
 *
 *   - a network failure treated as a rejection throws away a valid 30-day
 *     credential because the wifi dropped;
 *   - a rejection treated as a network failure leaves a dead token in place
 *     forever, and the login form never appears;
 *   - a 429 is the server shedding load, not a verdict on the token — but it
 *     arrives as `!resp.ok`, exactly like a 401;
 *   - a response that omits `refresh_token` must not clear the one being held,
 *     or one odd reply logs the player out permanently.
 */

import { describe, it, expect } from 'vitest';
import {
    ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, clearTokens, fetchWarReconnectToken,
    gameAuthToken, refreshAccessToken, storeTokens, warTokenKey,
    type TokenStore,
} from './auth-tokens.js';

function memStore(initial: Record<string, string> = {}): TokenStore & {
    all: Record<string, string>;
} {
    const all = { ...initial };
    return {
        all,
        get: (k) => (k in all ? all[k] : null),
        set: (k, v) => { all[k] = v; },
        remove: (k) => { delete all[k]; },
    };
}

/// A `fetch` that answers once with the given status/body.
function fakeFetch(status: number, body: unknown, ok = status < 400) {
    return async () => ({
        ok,
        status,
        json: async () => body,
    }) as unknown as Response;
}

describe('storeTokens', () => {
    it('writes both credentials under separate keys', () => {
        const s = memStore();
        storeTokens({ token: 'access-1', refresh_token: 'refresh-1' }, s);
        expect(s.all[ACCESS_TOKEN_KEY]).toBe('access-1');
        expect(s.all[REFRESH_TOKEN_KEY]).toBe('refresh-1');
    });

    it('leaves the held refresh token alone when a response omits one', () => {
        const s = memStore({ [REFRESH_TOKEN_KEY]: 'refresh-1' });
        storeTokens({ token: 'access-2' }, s);
        expect(s.all[ACCESS_TOKEN_KEY]).toBe('access-2');
        // The failure this guards: a rotation reply that somehow arrived
        // without its successor wiping the predecessor still in hand.
        expect(s.all[REFRESH_TOKEN_KEY]).toBe('refresh-1');
    });

    it('clearTokens drops both, and leaves per-war keys standing', () => {
        const s = memStore({
            [ACCESS_TOKEN_KEY]: 'a',
            [REFRESH_TOKEN_KEY]: 'r',
            [warTokenKey(7)]: 'w',
        });
        clearTokens(s);
        expect(s.all[ACCESS_TOKEN_KEY]).toBeUndefined();
        expect(s.all[REFRESH_TOKEN_KEY]).toBeUndefined();
        expect(s.all[warTokenKey(7)]).toBe('w');
    });
});

describe('refreshAccessToken', () => {
    it('rotates and stores both new credentials', async () => {
        const s = memStore({ [REFRESH_TOKEN_KEY]: 'r1' });
        const out = await refreshAccessToken('http://x', s,
            fakeFetch(200, { token: 'a2', refresh_token: 'r2' }));
        expect(out.kind).toBe('refreshed');
        expect(s.all[ACCESS_TOKEN_KEY]).toBe('a2');
        expect(s.all[REFRESH_TOKEN_KEY]).toBe('r2');
    });

    it('reports "none" and touches nothing when no refresh token is held', async () => {
        const s = memStore();
        let called = false;
        const out = await refreshAccessToken('http://x', s, (async () => {
            called = true;
            return {} as Response;
        }) as unknown as typeof fetch);
        expect(out.kind).toBe('none');
        expect(called).toBe(false);
    });

    it('drops the token on a 401 — it will never work again', async () => {
        const s = memStore({ [REFRESH_TOKEN_KEY]: 'r1' });
        const out = await refreshAccessToken('http://x', s,
            fakeFetch(401, { error: 'invalid or expired refresh token' }));
        expect(out.kind).toBe('rejected');
        expect(s.all[REFRESH_TOKEN_KEY]).toBeUndefined();
    });

    it('KEEPS the token when the request never got an answer', async () => {
        const s = memStore({ [REFRESH_TOKEN_KEY]: 'r1' });
        const out = await refreshAccessToken('http://x', s, (async () => {
            throw new Error('offline');
        }) as unknown as typeof fetch);
        expect(out.kind).toBe('unreachable');
        expect(s.all[REFRESH_TOKEN_KEY]).toBe('r1');
    });

    it('KEEPS the token on a 429 — rate limiting is not a verdict', async () => {
        const s = memStore({ [REFRESH_TOKEN_KEY]: 'r1' });
        const out = await refreshAccessToken('http://x', s,
            fakeFetch(429, { error: 'too many refresh attempts' }));
        // Arrives as !resp.ok exactly like the 401 above; collapsing the two
        // turns a burst of load-shedding into a permanent logout.
        expect(out.kind).toBe('unreachable');
        expect(s.all[REFRESH_TOKEN_KEY]).toBe('r1');
    });

    it('treats a 200 with no access token as a rejection', async () => {
        const s = memStore({ [REFRESH_TOKEN_KEY]: 'r1' });
        const out = await refreshAccessToken('http://x', s,
            fakeFetch(200, { user_id: 3 }));
        expect(out.kind).toBe('rejected');
    });
});

describe('fetchWarReconnectToken', () => {
    it('caches the token under the room it opens', async () => {
        const s = memStore();
        const tok = await fetchWarReconnectToken('http://x', 'access', 7, s,
            fakeFetch(200, { room_id: 7, token: 'war-7' }));
        expect(tok).toBe('war-7');
        expect(s.all[warTokenKey(7)]).toBe('war-7');
    });

    it('is best-effort: a refusal caches nothing and throws nothing', async () => {
        const s = memStore();
        const tok = await fetchWarReconnectToken('http://x', 'access', 7, s,
            fakeFetch(403, { error: 'no seat held in this war' }));
        expect(tok).toBeNull();
        expect(s.all[warTokenKey(7)]).toBeUndefined();
    });

    it('keeps one key per room rather than one key overall', async () => {
        const s = memStore();
        await fetchWarReconnectToken('http://x', 'a', 7, s,
            fakeFetch(200, { token: 'war-7' }));
        await fetchWarReconnectToken('http://x', 'a', 9, s,
            fakeFetch(200, { token: 'war-9' }));
        // A single shared key would leave the war the player is actually
        // fighting in holding the token for the one they last looked at.
        expect(s.all[warTokenKey(7)]).toBe('war-7');
        expect(s.all[warTokenKey(9)]).toBe('war-9');
    });
});

describe('gameAuthToken', () => {
    it('prefers the account session when there is one', () => {
        const s = memStore({
            [ACCESS_TOKEN_KEY]: 'a', [warTokenKey(7)]: 'w',
        });
        expect(gameAuthToken(7, s)).toEqual({ token: 'a', kind: 'session' });
    });

    it('falls back to the war token once the session is gone', () => {
        const s = memStore({ [warTokenKey(7)]: 'w' });
        expect(gameAuthToken(7, s)).toEqual({ token: 'w', kind: 'war' });
    });

    it('never offers another war’s token', () => {
        const s = memStore({ [warTokenKey(7)]: 'w' });
        expect(gameAuthToken(8, s)).toBeNull();
        expect(gameAuthToken(0, s)).toBeNull();
    });
});
