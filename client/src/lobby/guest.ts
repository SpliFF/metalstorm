/**
 * guest.ts — the client half of PLAN-metalstorm-lobby.md §7.1 (task 8c):
 * provisional accounts and the upgrade.
 *
 * Same shape as `auth-tokens.ts`, `totp.ts` and `logout.ts`: LobbyUI keeps the
 * DOM and the side effects, this module keeps the decisions, so they can be
 * tested without a browser.
 *
 * ── Why the device token is not stored under the access-token key ──────────
 * `springrts-token` is read straight out of localStorage by six call sites
 * that each send it as a Bearer header. A device token is not a Bearer
 * credential — it is the input to `/api/auth/guest/resume` and nothing else —
 * and it outlives every session it mints, so sharing a key would both break
 * those call sites and put the guest's only permanent credential on the wire
 * of every request. Same argument as REFRESH_TOKEN_KEY, one credential along.
 */

export const DEVICE_TOKEN_KEY = 'springrts-device-token';

export interface TokenStoreLike {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
}

/// The subset of the three guest responses the client cares about. Shaped like
/// AuthTokenResponse on purpose — /api/auth/{guest,guest/resume,upgrade} all
/// answer in the login response's shape so `storeTokens` works unchanged.
export interface GuestResponse {
    token?: string;
    user_id?: number;
    username?: string;
    role?: string;
    faction?: string;
    provisional?: boolean;
    device_token?: string;
    refresh_token?: string;
    cleared_bindings?: number;
    cleared_war_tokens?: number;
}

/// Persist a device token if the response carried one.
///
/// Written only when present, for the same reason `storeTokens` is: the resume
/// response deliberately does NOT re-issue one, and a blind write would clear
/// the guest's only credential every time they came back.
export function storeDeviceToken(data: GuestResponse, store: TokenStoreLike): void {
    if (data.device_token) store.set(DEVICE_TOKEN_KEY, data.device_token);
}

/// Forget the device token. Called on a completed upgrade (the server has
/// already revoked it) and on logout.
export function clearDeviceToken(store: TokenStoreLike): void {
    store.remove(DEVICE_TOKEN_KEY);
}

/**
 * What should this browser do on start-up?
 *
 * The ordering is the decision, and it runs one way only: **an access token
 * beats a device token**. A device token can only ever open a guest account,
 * while the access token may belong to a full one — including the full account
 * this very browser upgraded into, whose device token is now revoked and would
 * fail. Trying the device first would replace a working session with a 401 on
 * every reload after an upgrade.
 */
export type BootAction =
    /// Validate the access token we hold (the existing path).
    | { kind: 'session' }
    /// No session, but a device token — resume the guest silently.
    | { kind: 'resume-guest'; deviceToken: string }
    /// Nothing held: show the login screen.
    | { kind: 'login' };

export function decideBoot(accessToken: string | null,
                          deviceToken: string | null): BootAction {
    if (accessToken) return { kind: 'session' };
    if (deviceToken) return { kind: 'resume-guest', deviceToken };
    return { kind: 'login' };
}

/**
 * The promise made to a guest before they commit to an upgrade.
 *
 * This exists because the honest answer is not "you keep everything" — §1b
 * says moving off a faction gives up the seats held on it, and the upgrade
 * inherits that rule. Told before the button is pressed rather than reported
 * after, since it is not reversible and the guest is the only one who knows
 * whether the seat matters.
 *
 * `current` is the provisional faction (empty if the guest never picked one).
 */
export function describeUpgradeCost(current: string, chosen: string): string {
    if (!chosen || chosen === current) {
        return current
            ? 'You keep your faction, your war seats and everything you have earned.'
            : 'Choose the faction you will fight for.';
    }
    if (!current) {
        return 'You have not fought for anyone yet, so nothing is given up.';
    }
    return `Switching from ${current} to ${chosen} gives up every war seat `
        + `you hold — they are seats on ${current}'s side. Your account, name `
        + `and history stay.`;
}

export type UpgradeOutcome =
    | { kind: 'ok'; data: GuestResponse }
    /// The account is in a room, so the RENAME (not the upgrade) is refused.
    /// Distinct from `taken` because the player fixes it by leaving the game,
    /// not by inventing another name — and because they can also just upgrade
    /// without renaming, which the caller can offer.
    | { kind: 'name-in-use'; message: string }
    | { kind: 'failed'; message: string };

export interface UpgradeResponseLike {
    ok: boolean;
    status: number;
}

export function classifyUpgradeResponse(
    resp: UpgradeResponseLike,
    data: GuestResponse & { error?: string; name_in_use?: boolean } | null,
): UpgradeOutcome {
    if (resp.ok && data && typeof data.token === 'string' && data.token) {
        return { kind: 'ok', data };
    }
    if (data?.name_in_use === true) {
        return {
            kind: 'name-in-use',
            message: data.error ?? 'Leave your current game before changing your name',
        };
    }
    return { kind: 'failed', message: data?.error ?? 'Upgrade failed' };
}

/// Is this a generated guest name? The UI uses it to decide whether to offer a
/// name field at all — a guest who has already claimed a name is upgrading
/// something else, and re-asking would invite a rename they did not want.
export function isGuestName(username: string): boolean {
    return /^guest-[0-9a-f]{8}$/.test(username);
}

/// A guest name, shortened for a header where the full one is noise. The tail
/// is kept rather than the head because the head is the same six characters
/// for every guest in the lobby.
export function displayGuestName(username: string): string {
    return isGuestName(username) ? `Guest ${username.slice(-4)}` : username;
}
