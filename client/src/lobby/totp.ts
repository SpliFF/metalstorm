/**
 * totp.ts — the client half of PLAN-metalstorm-lobby.md §7.2 (task 8d): the
 * optional second factor.
 *
 * Same shape as `auth-tokens.ts` and `logout.ts`: LobbyUI keeps the DOM and
 * the side effects, this module keeps the decisions, so they can be tested
 * without a browser.
 *
 * ── The decision that needs a module ───────────────────────────────────────
 * `doLogin` has always treated "login failed and a confirm-password was
 * typed" as "this must be a new account — register it". A two-factor
 * challenge is *also* a failed login, and falling through to registration on
 * one would answer a 2FA prompt with `409 username already taken` — the
 * player's own account, reported to them as somebody else's. So the
 * login-response classification stops being an `if (!resp.ok && pass2)` at the
 * call site and becomes a function with a name and a test.
 */

/// What the server said about a login attempt, and what to do next.
export type LoginOutcome =
    /// Through: `data` carries the tokens.
    | { kind: 'ok'; data: Record<string, unknown> }
    /// The password was right and a code is needed. NOT a failure to retry
    /// blindly and NOT a registration opportunity — the account exists and the
    /// caller is very probably its owner.
    | { kind: 'totp-required'; message: string }
    /// No such account (and the caller offered a confirm-password), so the
    /// register call is the next step.
    | { kind: 'register' }
    /// Anything else. `message` is the server's own wording where it gave one.
    | { kind: 'failed'; message: string };

export interface LoginResponseLike {
    ok: boolean;
    status: number;
}

/**
 * Classify a /api/auth/login response.
 *
 * `canRegister` is "the player typed a confirm-password", i.e. they signalled
 * that a new account is an acceptable outcome. The `totp_required` flag beats
 * it, which is the whole point of this function: a 401 carrying that flag
 * means the account exists and its password was correct.
 */
export function classifyLoginResponse(
    resp: LoginResponseLike,
    data: Record<string, unknown> | null,
    canRegister: boolean,
): LoginOutcome {
    const totpRequired = data?.totp_required === true;
    if (resp.ok && data && typeof data.token === 'string' && data.token) {
        return { kind: 'ok', data };
    }
    if (totpRequired) {
        return {
            kind: 'totp-required',
            message: typeof data?.error === 'string'
                ? data.error : 'Two-factor code required',
        };
    }
    if (!resp.ok && canRegister) return { kind: 'register' };
    return {
        kind: 'failed',
        message: typeof data?.error === 'string' ? data.error : 'Login failed',
    };
}

/// Strip the spaces and dashes a player types or pastes. Sent normalised
/// rather than raw because the server's own normalisation is an implementation
/// detail we should not be relying on from here — and a code with a stray
/// space is the single most common way an authenticator entry is transcribed.
export function normaliseCode(input: string): string {
    return input.replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
}

/// Is this plausibly a 6-digit TOTP code (as opposed to a recovery code)?
/// Used only to decide whether to bother the server; both go in the same field
/// because asking a player which kind of code they are holding is a worse
/// question than accepting either.
export function looksLikeTotpCode(input: string): boolean {
    return /^[0-9]{6}$/.test(normaliseCode(input));
}

/// The secret, grouped for reading off a screen and typing into a phone.
/// Four-character groups because that is what every authenticator's own
/// manual-entry hint uses.
export function formatSecret(secret: string): string {
    return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

export interface TotpStatus {
    enabled: boolean;
    pending: boolean;
    recovery_remaining: number;
}

/// One line describing where the account stands, including the case that
/// matters and is easy to leave out: 2FA on, recovery codes all spent, i.e.
/// one lost phone away from a lost account.
export function describeStatus(status: TotpStatus): string {
    if (!status.enabled) {
        return status.pending
            ? 'Two-factor set-up started but not confirmed.'
            : 'Two-factor authentication is off.';
    }
    if (status.recovery_remaining === 0) {
        return 'Two-factor is on. No recovery codes left — losing your '
            + 'authenticator would lock you out.';
    }
    return `Two-factor is on. ${status.recovery_remaining} recovery `
        + `code${status.recovery_remaining === 1 ? '' : 's'} left.`;
}
