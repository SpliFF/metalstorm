/**
 * auth-tokens.ts — the client half of PLAN-metalstorm-lobby.md §7.2/§7.3
 * (task 8a): the rotating refresh token, and the per-war reconnect key.
 *
 * Same shape as `logout.ts`: LobbyUI keeps the side effects and the DOM, this
 * module keeps the decisions, so they can be tested without a browser.
 *
 * ── Why the refresh token is stored under its own key ──────────────────────
 * Every holder of `springrts-token` expects an ACCESS token and would send a
 * refresh token as a Bearer header if the two ever shared a key — the failure
 * where the credential that exists to survive a compromise is handed to every
 * endpoint in the app.
 *
 * ── 8a-follow-on (this file's second half) ─────────────────────────────────
 * Task 8a left the access TTL at 24 h because the token had holders that
 * cached it for the life of an object, so shrinking it would have broken them
 * silently. This module now owns the token's *lifetime* as well as its
 * storage: an expiry recorded next to it (`ACCESS_EXPIRY_KEY`), a read-at-use
 * accessor (`getAccessToken`), and `AccessTokenRenewer` — a timer plus a
 * publication, because two of the holders are Worker realms that have no
 * `localStorage` to re-read. The TTL is now 1 h
 * (`AuthTokens::kAccessTtlSeconds`, server-side).
 *
 * The audit of who held a copy found SEVEN, not the six task 8a counted: the
 * four `localStorage.getItem` reads in main.ts, the game worker's `gp:init`
 * credential, the LuaUI worker's telemetry channel, and `LobbyUI.authToken` —
 * a private field read by ~20 methods that no note had ever named. (The
 * viewport.ts / minimap.ts / connection.ts sites the 8a note lists do not read
 * the key at all; they are handed a token by their caller.)
 */

export const ACCESS_TOKEN_KEY  = 'springrts-token';
export const REFRESH_TOKEN_KEY = 'springrts-refresh-token';

/// Absolute epoch-ms at which the access token stops being honoured, derived
/// from the `expires_in` every auth response already carried and nobody read.
///
/// Stored rather than recomputed because the client has no other way to know:
/// the token is opaque (a random hex string, not a JWT), so "is this stale?"
/// is unanswerable without either this record or a round trip. A MISSING value
/// means "unknown", and every reader below treats unknown as *not* expired —
/// so a session adopted by an older build, or by the scenario runner's
/// `attachSession`, degrades to exactly the pre-8a-follow-on behaviour instead
/// of being thrown away.
export const ACCESS_EXPIRY_KEY = 'springrts-token-expires';

/// Cross-tab mutex for the refresh round trip. Value is the epoch-ms at which
/// the holder took it; a stale holder is stolen after `LOCK_TTL_MS`.
export const REFRESH_LOCK_KEY = 'springrts-refresh-lock';

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
    /// Seconds. Server-side lifetime of `token` (HttpAuth's
    /// `AuthTokens::kAccessTtlSeconds`). Every one of the four responses has
    /// shipped this since task 8a; 8a-follow-on is what started reading it.
    expires_in?: number;
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
export function storeTokens(
    data: AuthTokenResponse,
    store: TokenStore,
    nowMs: number = Date.now(),
): void {
    if (data.token) {
        store.set(ACCESS_TOKEN_KEY, data.token);
        // Recorded alongside the token it describes, and CLEARED when a new
        // token arrives without one: an expiry left over from the previous
        // token would either expire a live credential early or — worse, since
        // it is the direction that fails silently — vouch for a dead one.
        if (typeof data.expires_in === 'number' && data.expires_in > 0) {
            store.set(ACCESS_EXPIRY_KEY,
                      String(nowMs + data.expires_in * 1000));
        } else {
            store.remove(ACCESS_EXPIRY_KEY);
        }
    }
    if (data.refresh_token) store.set(REFRESH_TOKEN_KEY, data.refresh_token);
    for (const fn of tokensStoredListeners) {
        try { fn(); } catch (e) { console.warn('[auth] storeTokens listener threw', e); }
    }
}

/// Same-tab counterpart to the `storage` event, which fires only in OTHER tabs
/// of the origin. Without it a login in THIS tab would leave the renewer armed
/// against whatever expiry was in the store at boot — i.e. none — so the tab
/// that just logged in would be the one tab that never renews. `storeTokens`
/// is the right hook because it is the single write path for the access token
/// (every login/register/refresh/guest/upgrade arm goes through it).
const tokensStoredListeners = new Set<() => void>();
export function onTokensStored(fn: () => void): () => void {
    tokensStoredListeners.add(fn);
    return () => { tokensStoredListeners.delete(fn); };
}

/// Epoch-ms, or null when unrecorded/unparsable ("unknown", not "expired").
export function accessTokenExpiresAt(store: TokenStore): number | null {
    const raw = store.get(ACCESS_EXPIRY_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/// Treat the token as spent this many ms before it actually is. A request in
/// flight when the clock crosses the line is refused by the server, and the
/// two clocks are not the same clock.
export const EXPIRY_SKEW_MS = 30_000;

export function isAccessTokenExpired(
    store: TokenStore,
    nowMs: number = Date.now(),
    skewMs: number = EXPIRY_SKEW_MS,
): boolean {
    const at = accessTokenExpiresAt(store);
    if (at === null) return false;   // unknown ⇒ not expired (see the key doc)
    return nowMs + skewMs >= at;
}

/// The live access token, or null — read at USE time, never cached.
///
/// This accessor is the whole point of 8a-follow-on: with a 24 h TTL every
/// holder could snapshot the string at construction and be right for the life
/// of the page, and six of them did. At 1 h that is wrong within one match.
export function getAccessToken(
    store: TokenStore,
    nowMs: number = Date.now(),
): string | null {
    const t = store.get(ACCESS_TOKEN_KEY);
    if (!t) return null;
    return isAccessTokenExpired(store, nowMs) ? null : t;
}

/// Drop both account-wide credentials. Per-war keys are deliberately NOT
/// cleared here — `clearAllWarTokens` is a separate verb, because leaving an
/// account is not the same act as abandoning the wars it is standing in, and
/// logout already has its own key list (LOGOUT_CLEARED_KEYS).
export function clearTokens(store: TokenStore): void {
    store.remove(ACCESS_TOKEN_KEY);
    store.remove(ACCESS_EXPIRY_KEY);
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
///
/// 8a-follow-on: "when present" became "when present AND still live". A stale
/// access token is worse than no access token here — the game server's
/// `AuthRequest` tries the war reconnect token only when the session lookup
/// fails, and the client sends exactly one credential, so an expired string
/// sitting in localStorage is what *prevents* the 7-day war token from ever
/// being presented. That path was already reachable at a 24 h TTL; at 1 h it
/// would be the common case.
export function gameAuthToken(
    roomId: number,
    store: TokenStore,
    nowMs: number = Date.now(),
): { token: string; kind: 'session' | 'war' } | null {
    const access = getAccessToken(store, nowMs);
    if (access) return { token: access, kind: 'session' };
    const war = roomId > 0 ? store.get(warTokenKey(roomId)) : null;
    if (war) return { token: war, kind: 'war' };
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 8a-follow-on: keeping the access token live, and telling everyone who holds
// a copy.
//
// Task 8a deliberately refused a refresh timer — "an expiry the client never
// observes needs no refresh, and a timer would rotate the credential (and burn
// a family generation) on every idle tab." That reasoning is sound at 24 h and
// wrong at 1 h, for one reason: the 401 that drives the on-demand path only
// exists on the LOBBY's HTTP surface. The game server authenticates once, at
// `AuthRequest`, over a connection that then lives for the whole match — there
// is no 401 to react to, so a session that ages out mid-match is not observed
// until the player tries to reconnect and gets asked for a password. Renewal
// therefore has to be proactive.
//
// **The hazard the timer introduces is multi-tab, and it is not hypothetical.**
// Refresh tokens are single-use with family-wide reuse detection: if two tabs
// holding the same token both rotate, the second one is indistinguishable from
// a replayed theft and the whole family is revoked — signing the player out of
// every tab. That race exists today on the 401 path (two tabs, one expiry, both
// reacting) but needs a coincidence; a timer makes it a scheduled event. Three
// things address it, in order of how much they matter:
//
//   1. A localStorage lock, so only one tab makes the call.
//   2. A re-read of the expiry AFTER taking the lock — if a peer already
//      renewed, there is nothing to do. This is what actually closes the race,
//      because it is a check on the outcome rather than on the intent, and it
//      holds even when the lock is lost to the (unavoidable, non-atomic)
//      read-then-write window.
//   3. The `storage` event, which is how the peers learn about it: it fires in
//      every OTHER tab of the origin, so a renewal in one is a re-read in all.
// ─────────────────────────────────────────────────────────────────────────────

const LOCK_TTL_MS = 15_000;

/// Never re-arm tighter than this: a server that hands out a very short TTL
/// (or a clock that is already past it) must not turn into a refresh loop.
export const MIN_RENEW_DELAY_MS = 30_000;
/// setTimeout's argument overflows past 2^31 ms; well before that, a timer this
/// far out is better re-derived at the next page load anyway.
export const MAX_RENEW_DELAY_MS = 6 * 60 * 60 * 1000;

/**
 * How long to wait before renewing, given the recorded expiry.
 *
 * Half of the REMAINING life, not half of the original TTL — the two differ on
 * every path that matters (a page loaded 50 minutes into a 60-minute session
 * has 10 minutes left, not 30), and the client cannot see the original anyway.
 * Halving leaves a full second attempt inside the window if the first fails.
 *
 * `null` means "no expiry recorded" ⇒ do not schedule anything. That is the
 * pre-8a-follow-on world, and it stays working rather than being renewed at a
 * guess.
 */
export function renewDelayMs(
    expiresAtMs: number | null,
    nowMs: number,
): number | null {
    if (expiresAtMs === null) return null;
    const remaining = expiresAtMs - nowMs;
    if (remaining <= 0) return 0;   // already dead — renew now, not in 30 s
    const half = Math.floor(remaining / 2);
    return Math.min(MAX_RENEW_DELAY_MS, Math.max(MIN_RENEW_DELAY_MS, half));
}

/// Take the cross-tab refresh lock, stealing it if the holder is older than
/// `LOCK_TTL_MS` (a tab closed mid-refresh must not wedge the origin).
///
/// localStorage has no compare-and-swap, so this is advisory. It is correct to
/// build on anyway because the caller re-checks the *expiry* after taking it —
/// see the block comment above. Exported for the tests.
export function tryAcquireRefreshLock(
    store: TokenStore,
    nowMs: number,
    lockTtlMs: number = LOCK_TTL_MS,
): boolean {
    const held = Number(store.get(REFRESH_LOCK_KEY) ?? '');
    if (Number.isFinite(held) && held > 0 && nowMs - held < lockTtlMs) return false;
    store.set(REFRESH_LOCK_KEY, String(nowMs));
    return true;
}

export function releaseRefreshLock(store: TokenStore): void {
    store.remove(REFRESH_LOCK_KEY);
}

export type AccessTokenListener = (token: string | null) => void;

/**
 * The live access token and everyone holding a copy of it.
 *
 * A subscriber list rather than "make the six call sites re-read", because two
 * of the holders physically cannot re-read: `localStorage` does not exist in a
 * Worker realm, and both the game worker and the LuaUI worker authenticate
 * with this token. Push is the only mechanism that reaches them, so push is
 * the mechanism — and the main-thread holders use the same one instead of a
 * second, subtly different path.
 */
export class AccessTokenRenewer {
    private listeners = new Set<AccessTokenListener>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private storageHandler: ((e: StorageEvent) => void) | null = null;
    private unsubscribeStored: (() => void) | null = null;
    private lastPublished: string | null = null;

    constructor(
        private readonly httpUrl: string,
        private readonly store: TokenStore,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly now: () => number = () => Date.now(),
        private readonly setTimer = setTimeout,
        private readonly clearTimer = clearTimeout,
    ) {}

    /// Register `fn` and hand it the current value immediately, so a holder
    /// never has to snapshot the token itself to get started.
    subscribe(fn: AccessTokenListener): () => void {
        this.listeners.add(fn);
        const t = getAccessToken(this.store, this.now());
        fn(t);
        // Also the last-published mark: every OTHER listener already holds
        // this value (that is publish's invariant), so after this call the
        // whole set is current and a following publish() is genuinely a no-op.
        // Leaving the mark behind made the first publish after any subscribe
        // re-broadcast — which is a redundant `gp:token` to the worker on
        // every boot, and it is what the "drops a repeat" test caught.
        this.lastPublished = t;
        return () => { this.listeners.delete(fn); };
    }

    /// Push the current token to every holder. Idempotent by value: a repeated
    /// publish of the same string is dropped, so re-arming the timer (or a
    /// `storage` event for an unrelated key) does not churn the worker.
    publish(force = false): void {
        const t = getAccessToken(this.store, this.now());
        if (!force && t === this.lastPublished) return;
        this.lastPublished = t;
        for (const fn of this.listeners) {
            try { fn(t); } catch (e) { console.warn('[auth] token listener threw', e); }
        }
    }

    /// Begin renewing. Safe to call again (a re-login does): the timer is
    /// re-derived from whatever expiry is now recorded.
    start(): void {
        if (!this.storageHandler && typeof window !== 'undefined') {
            this.storageHandler = (e: StorageEvent) => {
                // A peer tab renewed (or logged out). Both keys are watched:
                // the token alone is not enough, because a renewal that
                // happened to mint the same string still moved the expiry.
                if (e.key === ACCESS_TOKEN_KEY || e.key === ACCESS_EXPIRY_KEY) {
                    this.publish();
                    this.arm();
                }
            };
            window.addEventListener('storage', this.storageHandler);
        }
        if (!this.unsubscribeStored) {
            this.unsubscribeStored = onTokensStored(() => {
                this.publish();
                this.arm();
            });
        }
        this.publish(true);
        this.arm();
    }

    stop(): void {
        if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
        this.unsubscribeStored?.();
        this.unsubscribeStored = null;
        if (this.storageHandler && typeof window !== 'undefined') {
            window.removeEventListener('storage', this.storageHandler);
            this.storageHandler = null;
        }
    }

    private arm(): void {
        if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
        const delay = renewDelayMs(accessTokenExpiresAt(this.store), this.now());
        if (delay === null) return;
        this.timer = this.setTimer(() => { void this.renewNow(); }, delay);
    }

    /// One renewal attempt. Exposed (and awaited by the tests) rather than
    /// buried in the timer callback so the lock/skip/backoff decisions are
    /// reachable without a real clock.
    async renewNow(): Promise<RefreshOutcome | { kind: 'skipped' }> {
        const now = this.now();
        if (!tryAcquireRefreshLock(this.store, now)) {
            // A peer is mid-flight. Re-arm rather than give up: if it fails,
            // this tab tries in its own time.
            this.arm();
            return { kind: 'skipped' };
        }
        try {
            // The check that actually closes the multi-tab race: a peer may
            // have renewed between our timer firing and our taking the lock,
            // in which case the token we hold is already the new one and
            // presenting the refresh token again would be the replay.
            const delay = renewDelayMs(accessTokenExpiresAt(this.store), now);
            if (delay !== null && delay > MIN_RENEW_DELAY_MS) {
                this.publish();
                this.arm();
                return { kind: 'skipped' };
            }
            const outcome = await refreshAccessToken(
                this.httpUrl, this.store, this.fetchImpl);
            if (outcome.kind === 'refreshed') this.publish();
            // 'rejected' means the family is gone — nothing to re-arm against;
            // the next lobby request 401s and the login form appears, which is
            // the one place that decision belongs. 'unreachable' and 'none'
            // both re-arm: the former is a network blip, the latter a session
            // that never had a refresh token (the scenario runner's
            // `attachSession`) and must not be touched.
            if (outcome.kind !== 'rejected') this.arm();
            return outcome;
        } finally {
            releaseRefreshLock(this.store);
        }
    }
}
