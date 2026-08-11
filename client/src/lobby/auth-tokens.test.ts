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
    ACCESS_EXPIRY_KEY, ACCESS_TOKEN_KEY, AccessTokenRenewer, EXPIRY_SKEW_MS,
    MAX_RENEW_DELAY_MS, MIN_RENEW_DELAY_MS, REFRESH_LOCK_KEY, REFRESH_TOKEN_KEY,
    clearTokens, fetchWarReconnectToken, gameAuthToken, getAccessToken,
    isAccessTokenExpired, refreshAccessToken, releaseRefreshLock,
    renewDelayMs, storeTokens, tryAcquireRefreshLock, warTokenKey,
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

// ─────────────────────────────────────────────────────────────────────────────
// 8a-follow-on — the access TTL went 24 h → 1 h, so the client has to know
// when its token dies and renew before it does. Every case below is one where
// the pre-8a-follow-on code was silently wrong at 1 h and silently fine at 24.
// ─────────────────────────────────────────────────────────────────────────────

describe('access expiry', () => {
    it('records an absolute expiry from expires_in', () => {
        const s = memStore();
        storeTokens({ token: 'a', expires_in: 3600 }, s, 1_000_000);
        expect(s.all[ACCESS_EXPIRY_KEY]).toBe(String(1_000_000 + 3_600_000));
    });

    it('clears a stale expiry when a new token arrives without one', () => {
        // The failure this guards is the silent direction: an expiry left over
        // from the PREVIOUS token would vouch for the new one for a window it
        // never had, so `getAccessToken` hands out a string the server refuses.
        const s = memStore({ [ACCESS_EXPIRY_KEY]: String(1_000) });
        storeTokens({ token: 'b' }, s, 500);
        expect(s.all[ACCESS_EXPIRY_KEY]).toBeUndefined();
    });

    it('treats an unrecorded expiry as unknown, not as expired', () => {
        // A session adopted by an older build, or by the scenario runner's
        // attachSession, has no expiry recorded. Reading that as "expired"
        // would log every such client out on sight.
        const s = memStore({ [ACCESS_TOKEN_KEY]: 'a' });
        expect(isAccessTokenExpired(s, 9e12)).toBe(false);
        expect(getAccessToken(s, 9e12)).toBe('a');
    });

    it('expires EXPIRY_SKEW_MS early', () => {
        const s = memStore();
        storeTokens({ token: 'a', expires_in: 3600 }, s, 0);
        expect(getAccessToken(s, 3_600_000 - EXPIRY_SKEW_MS - 1)).toBe('a');
        expect(getAccessToken(s, 3_600_000 - EXPIRY_SKEW_MS)).toBeNull();
    });

    it('clearTokens drops the expiry with the token', () => {
        const s = memStore();
        storeTokens({ token: 'a', refresh_token: 'r', expires_in: 60 }, s, 0);
        clearTokens(s);
        expect(s.all[ACCESS_EXPIRY_KEY]).toBeUndefined();
    });
});

describe('gameAuthToken with an expired session', () => {
    it('falls through to the war token rather than presenting a dead session', () => {
        // THE bug this milestone exists to prevent. The game server tries the
        // war reconnect token only when the session lookup fails — but the
        // client sends exactly ONE credential, so a stale access token in
        // localStorage is what stops the 7-day war token ever being presented.
        const s = memStore({ [warTokenKey(9)]: 'war-9' });
        storeTokens({ token: 'access', expires_in: 3600 }, s, 0);
        expect(gameAuthToken(9, s, 0)).toEqual({ token: 'access', kind: 'session' });
        expect(gameAuthToken(9, s, 3_700_000)).toEqual({ token: 'war-9', kind: 'war' });
    });

    it('still prefers a live session over a war token', () => {
        const s = memStore({ [warTokenKey(9)]: 'war-9' });
        storeTokens({ token: 'access', expires_in: 3600 }, s, 0);
        expect(gameAuthToken(9, s, 60_000)?.kind).toBe('session');
    });
});

describe('renewDelayMs', () => {
    it('halves the REMAINING life, not the original TTL', () => {
        // A page loaded 50 min into a 60 min session has 10 min left, not 30.
        expect(renewDelayMs(600_000, 0)).toBe(300_000);
    });

    it('renews immediately when the token is already dead', () => {
        expect(renewDelayMs(1_000, 5_000)).toBe(0);
    });

    it('never re-arms tighter than MIN_RENEW_DELAY_MS', () => {
        // A very short server TTL must not become a refresh loop.
        expect(renewDelayMs(10_000, 0)).toBe(MIN_RENEW_DELAY_MS);
    });

    it('clamps a long TTL to MAX_RENEW_DELAY_MS', () => {
        expect(renewDelayMs(30 * 24 * 3600_000, 0)).toBe(MAX_RENEW_DELAY_MS);
    });

    it('schedules nothing when no expiry is recorded', () => {
        expect(renewDelayMs(null, 0)).toBeNull();
    });
});

describe('the cross-tab refresh lock', () => {
    it('refuses a second holder inside the lock TTL', () => {
        const s = memStore();
        expect(tryAcquireRefreshLock(s, 1000)).toBe(true);
        expect(tryAcquireRefreshLock(s, 1500)).toBe(false);
    });

    it('steals a lock left behind by a tab that closed mid-refresh', () => {
        const s = memStore();
        tryAcquireRefreshLock(s, 1000);
        expect(tryAcquireRefreshLock(s, 1000 + 15_001)).toBe(true);
    });

    it('releases', () => {
        const s = memStore();
        tryAcquireRefreshLock(s, 1000);
        releaseRefreshLock(s);
        expect(tryAcquireRefreshLock(s, 1001)).toBe(true);
    });
});

describe('AccessTokenRenewer', () => {
    /// The renewer with every clock and timer injected, so the decisions are
    /// reachable without waiting an hour.
    function makeRenewer(s: TokenStore, now: () => number, fetchImpl: any) {
        const timers: Array<{ fn: () => void; delay: number }> = [];
        const r = new AccessTokenRenewer(
            'http://lobby', s, fetchImpl, now,
            ((fn: () => void, delay: number) => {
                timers.push({ fn, delay });
                return timers.length as any;
            }) as any,
            (() => {}) as any,
        );
        return { r, timers };
    }

    it('publishes the current token to a new subscriber immediately', () => {
        const s = memStore();
        storeTokens({ token: 'a', expires_in: 3600 }, s, 0);
        const { r } = makeRenewer(s, () => 0, async () => { throw new Error('no'); });
        const seen: Array<string | null> = [];
        r.subscribe((t) => seen.push(t));
        expect(seen).toEqual(['a']);
    });

    it('publishes a renewed token to every holder', async () => {
        const s = memStore();
        storeTokens({ token: 'old', refresh_token: 'r1', expires_in: 3600 }, s, 0);
        const { r } = makeRenewer(
            s, () => 3_600_000,
            fakeFetch(200, { token: 'new', refresh_token: 'r2', expires_in: 3600 }));
        const seen: Array<string | null> = [];
        r.subscribe((t) => seen.push(t));
        const outcome = await r.renewNow();
        expect(outcome.kind).toBe('refreshed');
        expect(seen.at(-1)).toBe('new');
    });

    it('drops a repeat publication of the same string', () => {
        const s = memStore();
        storeTokens({ token: 'a', expires_in: 3600 }, s, 0);
        const { r } = makeRenewer(s, () => 0, async () => { throw new Error('no'); });
        const seen: Array<string | null> = [];
        r.subscribe((t) => seen.push(t));
        r.publish();
        r.publish();
        // Without the value check this churns the worker on every timer re-arm.
        expect(seen).toEqual(['a']);
    });

    it('skips the round trip when a peer tab already renewed', async () => {
        // The multi-tab race that a timer turns from a coincidence into a
        // scheduled event: two tabs holding the same single-use refresh token
        // both rotating is indistinguishable from a replayed theft, and the
        // family-wide revocation signs the player out everywhere.
        const s = memStore();
        storeTokens({ token: 'old', refresh_token: 'r1', expires_in: 3600 }, s, 0);
        let calls = 0;
        const { r } = makeRenewer(s, () => 3_600_000, async () => {
            calls++;
            return { ok: true, status: 200,
                     json: async () => ({ token: 'mine', expires_in: 3600 }) } as any;
        });
        // The peer renews between our timer firing and our taking the lock.
        storeTokens({ token: 'theirs', expires_in: 3600 }, s, 3_600_000);
        const outcome = await r.renewNow();
        expect(outcome.kind).toBe('skipped');
        expect(calls).toBe(0);
        expect(s.all[ACCESS_TOKEN_KEY]).toBe('theirs');
    });

    it('does not renew while a peer holds the lock', async () => {
        const s = memStore({ [REFRESH_LOCK_KEY]: '3600000' });
        storeTokens({ token: 'old', refresh_token: 'r1', expires_in: 3600 }, s, 0);
        let calls = 0;
        const { r } = makeRenewer(s, () => 3_600_000, async () => {
            calls++; throw new Error('should not be called');
        });
        expect((await r.renewNow()).kind).toBe('skipped');
        expect(calls).toBe(0);
    });

    it('releases the lock even when the refresh throws', async () => {
        const s = memStore();
        storeTokens({ token: 'old', refresh_token: 'r1', expires_in: 3600 }, s, 0);
        const { r } = makeRenewer(s, () => 3_600_000, async () => {
            throw new Error('offline');
        });
        expect((await r.renewNow()).kind).toBe('unreachable');
        // A lock held forever by a crashed refresh wedges every tab of the
        // origin until its TTL runs out.
        expect(s.all[REFRESH_LOCK_KEY]).toBeUndefined();
    });

    it('re-arms after an unreachable refresh but not after a rejection', async () => {
        const dead = memStore();
        storeTokens({ token: 'old', refresh_token: 'r1', expires_in: 3600 }, dead, 0);
        const a = makeRenewer(dead, () => 3_600_000, fakeFetch(401, {}, false));
        expect((await a.r.renewNow()).kind).toBe('rejected');
        expect(a.timers.length).toBe(0);   // family gone — nothing to retry

        const flaky = memStore();
        storeTokens({ token: 'old', refresh_token: 'r1', expires_in: 3600 }, flaky, 0);
        const b = makeRenewer(flaky, () => 3_600_000, async () => {
            throw new Error('offline');
        });
        expect((await b.r.renewNow()).kind).toBe('unreachable');
        expect(b.timers.length).toBe(1);
    });

    it('arms nothing for a session with no recorded expiry', () => {
        // The scenario runner's attachSession: a token with no refresh token
        // and no expiry. Renewing it is impossible and must not be attempted.
        const s = memStore({ [ACCESS_TOKEN_KEY]: 'runner' });
        const { r, timers } = makeRenewer(s, () => 0, async () => { throw new Error('no'); });
        r.subscribe(() => {});
        r.start();
        expect(timers.length).toBe(0);
    });

    it('re-arms when a same-tab login stores a token', () => {
        // `storage` fires only in OTHER tabs, so without the storeTokens hook
        // the tab that just logged in is the one tab that never renews.
        const s = memStore();
        const { r, timers } = makeRenewer(s, () => 0, async () => { throw new Error('no'); });
        r.start();
        expect(timers.length).toBe(0);
        storeTokens({ token: 'a', refresh_token: 'r1', expires_in: 3600 }, s, 0);
        expect(timers.length).toBe(1);
        expect(timers[0].delay).toBe(1_800_000);
        r.stop();
    });
});
