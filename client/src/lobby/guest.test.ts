import { describe, it, expect } from 'vitest';
import {
    DEVICE_TOKEN_KEY,
    classifyUpgradeResponse,
    clearDeviceToken,
    decideBoot,
    describeUpgradeCost,
    displayGuestName,
    isGuestName,
    storeDeviceToken,
} from './guest';
import type { TokenStoreLike } from './guest';

// PLAN-metalstorm-lobby.md §7.1, task 8c — the client's half of guest
// accounts. Three decisions, each of which is wrong in a way that is invisible
// from the code: which credential wins at boot, what an upgrade actually costs
// the player, and which upgrade failure is which.

function makeStore(initial: Record<string, string> = {}): TokenStoreLike & { map: Record<string, string> } {
    const map = { ...initial };
    return {
        map,
        get: (k) => (k in map ? map[k] : null),
        set: (k, v) => { map[k] = v; },
        remove: (k) => { delete map[k]; },
    };
}

describe('decideBoot', () => {
    it('prefers an access token over a device token', () => {
        // The failure this pins: after an upgrade the browser holds BOTH a
        // session for the now-full account and a device token the server has
        // revoked. Trying the device first would 401 on every reload and drop
        // a logged-in player back to the login screen.
        const out = decideBoot('access', 'device');
        expect(out.kind).toBe('session');
    });

    it('resumes the guest when only a device token is held', () => {
        const out = decideBoot(null, 'device');
        expect(out).toEqual({ kind: 'resume-guest', deviceToken: 'device' });
    });

    it('falls back to the login screen with nothing held', () => {
        expect(decideBoot(null, null).kind).toBe('login');
        expect(decideBoot('', '').kind).toBe('login');
    });
});

describe('storeDeviceToken', () => {
    it('writes a device token when the response carries one', () => {
        const store = makeStore();
        storeDeviceToken({ token: 't', device_token: 'dev' }, store);
        expect(store.map[DEVICE_TOKEN_KEY]).toBe('dev');
    });

    it('leaves an existing token alone when the response omits one', () => {
        // `/api/auth/guest/resume` deliberately does not re-issue a device
        // token. A blind write would clear the guest's only credential every
        // single time they came back — i.e. the second visit works and the
        // third does not.
        const store = makeStore({ [DEVICE_TOKEN_KEY]: 'dev' });
        storeDeviceToken({ token: 'fresh-session' }, store);
        expect(store.map[DEVICE_TOKEN_KEY]).toBe('dev');
    });

    it('clears on request', () => {
        const store = makeStore({ [DEVICE_TOKEN_KEY]: 'dev' });
        clearDeviceToken(store);
        expect(store.map[DEVICE_TOKEN_KEY]).toBeUndefined();
    });
});

describe('describeUpgradeCost', () => {
    it('promises nothing is lost when the faction is kept', () => {
        const text = describeUpgradeCost('union', 'union');
        expect(text).toContain('keep');
        expect(text).not.toContain('gives up');
    });

    it('says plainly that switching gives up the seats', () => {
        // §1b inherited: the seats are seats on a side, and moving off the
        // side gives them up. The player has to be told BEFORE the button,
        // because it is not reversible and only they know if it matters.
        const text = describeUpgradeCost('union', 'compact');
        expect(text).toContain('gives up');
        expect(text).toContain('union');
        expect(text).toContain('compact');
    });

    it('does not threaten a guest who never picked a faction', () => {
        // nullopt → set is not a change: nothing was held, so nothing is lost.
        const text = describeUpgradeCost('', 'compact');
        expect(text).not.toContain('gives up');
    });

    it('asks a factionless guest to choose', () => {
        expect(describeUpgradeCost('', '')).toContain('Choose');
    });
});

describe('classifyUpgradeResponse', () => {
    it('passes a successful upgrade through', () => {
        const out = classifyUpgradeResponse({ ok: true, status: 200 },
            { token: 'abc', username: 'Ravager', provisional: false });
        expect(out.kind).toBe('ok');
    });

    it('keeps "you are in a game" distinct from "name taken"', () => {
        // Both are 409. Reporting the first as the second sends the player off
        // to invent a name they do not need — and hides the fact that they can
        // upgrade right now by not renaming.
        const inUse = classifyUpgradeResponse({ ok: false, status: 409 },
            { error: 'leave your current game before changing your name',
              name_in_use: true });
        expect(inUse.kind).toBe('name-in-use');

        const taken = classifyUpgradeResponse({ ok: false, status: 409 },
            { error: 'username already taken' });
        expect(taken.kind).toBe('failed');
        expect(taken.message).toBe('username already taken');
    });

    it('reports the server wording on any other failure', () => {
        const out = classifyUpgradeResponse({ ok: false, status: 400 },
            { error: 'password must be at least 8 characters' });
        expect(out).toEqual({
            kind: 'failed',
            message: 'password must be at least 8 characters',
        });
    });

    it('does not call a 200 with no token a success', () => {
        const out = classifyUpgradeResponse({ ok: true, status: 200 }, {});
        expect(out.kind).toBe('failed');
    });
});

describe('guest names', () => {
    it('recognises a generated name and nothing else', () => {
        expect(isGuestName('guest-deadbeef')).toBe(true);
        expect(isGuestName('guest-DEADBEEF')).toBe(false);  // server writes lower hex
        expect(isGuestName('guestly')).toBe(false);
        expect(isGuestName('Ravager')).toBe(false);
    });

    it('shortens a guest name but leaves a claimed one alone', () => {
        expect(displayGuestName('guest-deadbeef')).toBe('Guest beef');
        expect(displayGuestName('Ravager')).toBe('Ravager');
    });
});
