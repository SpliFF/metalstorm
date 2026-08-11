/**
 * logout.ts — the ordered logout sequence, separated from the DOM.
 *
 * PLAN-endtoend.md D45: the lobby shipped no way off an account at all. The
 * control itself is one button; what needs to be *right* is the order of the
 * three things behind it, so that order lives here where it can be tested
 * without a browser (jsdom is not installed in this project — see
 * `authority-bar-widget.test.ts`).
 *
 * Same shape as `room-transition.ts`: LobbyUI keeps the side effects, this
 * module keeps the decision.
 */

/**
 * Every localStorage key a logout must clear.
 *
 * `springrts-game-room` / `-game-port` are on this list because they are read
 * at boot by the auto-rejoin path, not by auth: leaving them behind would
 * drop the *next* account on this browser into the previous account's room.
 */
export const LOGOUT_CLEARED_KEYS = [
    'springrts-username',
    'springrts-token',
    // Task 8a. Without this the 30-day refresh token outlives the logout, and
    // the very next page load rotates it into a fresh session for the account
    // the player just left — a logout that undoes itself. Clearing it locally
    // is only half the job; `revokeToken` also presents it so the server kills
    // the family, because a copy taken off this machine is still live.
    'springrts-refresh-token',
    // Task 8c, same failure one credential along: a device token left behind
    // resumes the guest on the very next page load, so the logout undoes
    // itself. Note what this costs and why it is still right — a guest account
    // has no password, so clearing the device token is the END of that
    // account, not a sign-out. That is what "log out" has to mean on a shared
    // machine (the control exists so the next person is not you), so the
    // button warns instead of the key staying behind; see LobbyUI's
    // `wireGuestPanel`.
    'springrts-device-token',
    'springrts-game-room',
    'springrts-game-port',
] as const;

export interface LogoutSteps {
    /// Whether a session token exists. Both server steps need one; without it
    /// there is no room seat to release and no session row to revoke, and the
    /// logout is purely local.
    hasToken: boolean;
    /// Whether the player currently occupies a room.
    inRoom: boolean;
    /// POST /api/rooms/leave — needs the token, so it must run first.
    leaveRoom(): Promise<unknown>;
    /// POST /api/auth/logout — deletes the session row server-side.
    revokeToken(): Promise<unknown>;
    /// Drop the local token, the cached room, and LOGOUT_CLEARED_KEYS.
    clearLocalState(): void;
}

/**
 * Run the logout in the only order that works:
 *
 *   1. **leave the room while the token still authenticates.** A host who
 *      revokes first strands their seat — and their room — until it ages out.
 *   2. **revoke the session.** Clearing localStorage alone is not a logout:
 *      the session row survives for its full 24h, so anything that copied the
 *      token keeps the account.
 *   3. **clear the local state.** Unconditional, and this is deliberate: both
 *      server steps are best-effort, because a player who asked to leave an
 *      account must not stay signed in to it because the network was down.
 *      The server route is 200-on-unknown-token for the same reason.
 */
export async function runLogout(steps: LogoutSteps): Promise<void> {
    if (steps.hasToken) {
        if (steps.inRoom) {
            try { await steps.leaveRoom(); } catch { /* best effort */ }
        }
        try { await steps.revokeToken(); } catch { /* best effort */ }
    }
    steps.clearLocalState();
}
