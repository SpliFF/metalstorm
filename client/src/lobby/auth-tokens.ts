/**
 * auth-tokens.ts — the client half of PLAN-metalstorm-lobby.md §7.2/§7.3
 * (task 8a): the rotating refresh token, and the per-war reconnect key.
 *
 * Same shape as `logout.ts`: LobbyUI keeps the side effects and the DOM, this
 * module keeps the decisions, so they can be tested without a browser.
 *
 * ── Why the refresh token is stored under its own key ──────────────────────
 * `springrts-token` is read straight out of localStorage by six call sites
 * (main.ts ×5, viewport.ts, minimap.ts, connection.ts). Every one of them
 * expects an ACCESS token and would send a refresh token as a Bearer header if
 * the two ever shared a key — which is the failure where the credential that
 * exists to survive a compromise is handed to every endpoint in the app.
 */

export const ACCESS_TOKEN_KEY  = 'springrts-token';
export const REFRESH_TOKEN_KEY = 'springrts-refresh-token';

/// Per-war reconnect keys are stored one per room, because they are one per
/// room: a single key would be silently overwritten by whichever war the
/// player looked at last, and the token for the war they are actually fighting
/// in is the one that would go.
export function warTokenKey(roomId: number): string {
    return `springrts-war-token-${roomId}`;
}

/// The subset of /api/auth/{login,register,refresh} the client cares about.
/// All three responses are the same shape by design (see HttpAuth.h) so this
/// is one type, not three.
export interface AuthTokenResponse {
    token?: string;
    refresh_token?: string;
    user_id?: number;
    username?: string;
    role?: string;
    faction?: string;
}

export interface TokenStore {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
}

/// localStorage, as a TokenStore. Injected rather than reached for so the
/// decisions below are testable.
export const browserTokenStore: TokenStore = {
    get: (k) => localStorage.getItem(k),
    set: (k, v) => localStorage.setItem(k, v),
    remove: (k) => localStorage.removeItem(k),
};

/**
 * Persist whatever credentials a login/register/refresh response carried.
 *
 * The refresh token is written only when one is present, and this is
 * load-bearing rather than defensive: a deployment that mints no refresh token
 * must leave an existing one alone, not clear it — and, more importantly, a
 * *rotation* response that somehow arrived without its successor must not wipe
 * the predecessor the client is still holding, or one bad response logs the
 * player out for good.
 */
export function storeTokens(data: AuthTokenResponse, store: TokenStore): void {
    if (data.token) store.set(ACCESS_TOKEN_KEY, data.token);
    if (data.refresh_token) store.set(REFRESH_TOKEN_KEY, data.refresh_token);
}

/// Drop both account-wide credentials. Per-war keys are deliberately NOT
/// cleared here — `clearAllWarTokens` is a separate verb, because leaving an
/// account is not the same act as abandoning the wars it is standing in, and
/// logout already has its own key list (LOGOUT_CLEARED_KEYS).
export function clearTokens(store: TokenStore): void {
    store.remove(ACCESS_TOKEN_KEY);
    store.remove(REFRESH_TOKEN_KEY);
}

export type RefreshOutcome =
    | { kind: 'refreshed'; token: string; data: AuthTokenResponse }
    /// No refresh token held — this client has never logged in, or logged in
    /// against a build that predates task 8a. Not an error: the caller falls
    /// back to the password form exactly as before.
    | { kind: 'none' }
    /// The server refused the token. It is dead — the family may have been
    /// revoked by a reuse elsewhere — so it is dropped rather than retried,
    /// or every page load re-presents a token that will never work again.
    | { kind: 'rejected' }
    /// The request never got an answer. The token is NOT dropped: a flaky
    /// network must not cost the player their month-long credential.
    | { kind: 'unreachable' };

/**
 * Exchange the stored refresh token for a new access session.
 *
 * The rejected/unreachable split is the whole reason this is a function and
 * not three lines at the call site. Treating a network failure as a rejection
 * discards a valid 30-day credential because the wifi dropped; treating a
 * rejection as a network failure leaves a dead token in place forever and the
 * player never sees the login form.
 */
export async function refreshAccessToken(
    httpUrl: string,
    store: TokenStore,
    fetchImpl: typeof fetch = fetch,
): Promise<RefreshOutcome> {
    const refresh = store.get(REFRESH_TOKEN_KEY);
    if (!refresh) return { kind: 'none' };

    let resp: Response;
    try {
        resp = await fetchImpl(`${httpUrl}/api/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refresh }),
        });
    } catch {
        return { kind: 'unreachable' };
    }

    if (!resp.ok) {
        // A 429 is rate-limiting, not a verdict on the token — the server
        // sheds load on repeated FAILED refreshes, and throwing the credential
        // away here would turn a burst into a permanent logout.
        if (resp.status === 429) return { kind: 'unreachable' };
        store.remove(REFRESH_TOKEN_KEY);
        return { kind: 'rejected' };
    }

    let data: AuthTokenResponse;
    try {
        data = await resp.json() as AuthTokenResponse;
    } catch {
        return { kind: 'unreachable' };
    }
    if (!data.token) return { kind: 'rejected' };

    storeTokens(data, store);
    return { kind: 'refreshed', token: data.token, data };
}

/**
 * Ask the lobby for this account's long-TTL key back into one war, and cache
 * it. Best-effort by construction: every caller is on a path that already
 * works without it (the access session is still live at the moment we ask),
 * so a failure here costs the player nothing today — it costs them a password
 * prompt in three days.
 */
export async function fetchWarReconnectToken(
    httpUrl: string,
    accessToken: string,
    roomId: number,
    store: TokenStore,
    fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
    try {
        const resp = await fetchImpl(`${httpUrl}/api/wars/reconnect-token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ room_id: roomId }),
        });
        if (!resp.ok) return null;
        const data = await resp.json() as { token?: string };
        if (!data.token) return null;
        store.set(warTokenKey(roomId), data.token);
        return data.token;
    } catch {
        return null;
    }
}

/// The credential to present to the game server for `roomId`.
///
/// The access token wins when present, and that ordering is deliberate: it is
/// account-wide, so it authenticates the player as themselves everywhere,
/// while the war token authenticates them only into this room. The war token
/// is the fallback for exactly the case it was built for — the access session
/// aged out while the war did not.
export function gameAuthToken(
    roomId: number,
    store: TokenStore,
): { token: string; kind: 'session' | 'war' } | null {
    const access = store.get(ACCESS_TOKEN_KEY);
    if (access) return { token: access, kind: 'session' };
    const war = roomId > 0 ? store.get(warTokenKey(roomId)) : null;
    if (war) return { token: war, kind: 'war' };
    return null;
}
