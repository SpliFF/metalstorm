/**
 * logout.test.ts — regression for PLAN-endtoend.md D45.
 *
 * The button is trivial; the sequence behind it is not. Each case here is one
 * way a naive logout gets it wrong:
 *   - revoke before leaving → the host strands their own room;
 *   - abort on a failed request → the player cannot leave the account at
 *     exactly the moment they most need to (dead lobby, bad token);
 *   - clear only the auth keys → the next account auto-rejoins the previous
 *     account's room on the following page load.
 */

import { describe, it, expect } from 'vitest';
import { LOGOUT_CLEARED_KEYS, runLogout, type LogoutSteps } from './logout.js';

function recorder(overrides: Partial<LogoutSteps> = {}) {
    const calls: string[] = [];
    const steps: LogoutSteps = {
        hasToken: true,
        inRoom: true,
        leaveRoom: async () => { calls.push('leaveRoom'); },
        revokeToken: async () => { calls.push('revokeToken'); },
        clearLocalState: () => { calls.push('clearLocalState'); },
        ...overrides,
    };
    return { calls, steps };
}

describe('runLogout', () => {
    it('leaves the room before revoking the token', async () => {
        const { calls, steps } = recorder();
        await runLogout(steps);
        expect(calls).toEqual(['leaveRoom', 'revokeToken', 'clearLocalState']);
    });

    it('skips the room leave when the player is not in a room', async () => {
        const { calls, steps } = recorder({ inRoom: false });
        await runLogout(steps);
        expect(calls).toEqual(['revokeToken', 'clearLocalState']);
    });

    it('is purely local without a token', async () => {
        const { calls, steps } = recorder({ hasToken: false });
        await runLogout(steps);
        expect(calls).toEqual(['clearLocalState']);
    });

    it('still clears local state when the room leave fails', async () => {
        const { calls, steps } = recorder({
            leaveRoom: async () => { calls.push('leaveRoom'); throw new Error('offline'); },
        });
        await runLogout(steps);
        expect(calls).toEqual(['leaveRoom', 'revokeToken', 'clearLocalState']);
    });

    it('still clears local state when the revoke fails', async () => {
        const { calls, steps } = recorder({
            revokeToken: async () => { calls.push('revokeToken'); throw new Error('offline'); },
        });
        await runLogout(steps);
        expect(calls).toEqual(['leaveRoom', 'revokeToken', 'clearLocalState']);
    });

    it('clears the rejoin keys as well as the auth keys', () => {
        // The two rejoin keys are the ones a "log out = forget the token"
        // implementation leaves behind. `springrts-refresh-token` joined them
        // in task 8a and is the worst of the three to miss: a 30-day
        // credential left in localStorage rotates itself into a fresh session
        // on the next page load, so the logout silently undoes itself.
        expect([...LOGOUT_CLEARED_KEYS]).toEqual([
            'springrts-username',
            'springrts-token',
            'springrts-refresh-token',
            'springrts-game-room',
            'springrts-game-port',
        ]);
    });
});
