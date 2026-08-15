/**
 * PLAN-protocol-guard.md task 4 — the client half of the wire-schema guard.
 *
 * The server refuses a handshake whose `schema_hash` is missing or does not
 * equal its own (`Protocol::CheckHandshake`, task 3) with
 * `AuthStatus.VersionMismatch`. That verdict means exactly one thing: the
 * bundle in this tab was built against a different `schemas/protocol.fbs` than
 * the server is running. The remedy is a reload that actually refetches, and
 * the failure mode of that remedy is a reload LOOP — a cache that keeps
 * serving the same stale entry document reaches the same verdict forever.
 *
 * So the decision is kept here, pure, away from the DOM: a `sessionStorage`
 * flag records that this tab has already spent its one reload, and the second
 * mismatch renders a card instead of reloading again. Task 3's reusable half
 * was that a rule nobody can reach is a rule nobody tests; this module exists
 * so both arms — reload and give-up — are reachable from a unit test without a
 * browser, since the live second arm requires a genuinely poisoned cache.
 *
 * The DOM/`location` side lives in main.ts (`applySchemaMismatch`).
 */

/** sessionStorage key: this tab has already spent its one automatic reload. */
export const VM_RELOAD_FLAG = 'sw:vm-reloaded';

/** Query param carrying the cache-buster; stripped again on a clean auth. */
export const VM_CACHE_BUST_PARAM = 'sw_cb';

/** The subset of `Storage` this policy needs (workers have none; main does). */
export interface MismatchStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export type SchemaMismatchAction =
    /** First mismatch in this tab: navigate to `url` (cache-busted). */
    | { kind: 'reload'; url: string }
    /** Second mismatch: the reload did not help — show a persistent card. */
    | { kind: 'card'; message: string };

/**
 * Decide what a `VersionMismatch` rejection should do, and record the choice.
 *
 * `serverMessage` is the server's human-readable text, which carries both
 * hashes (truncated to 12 chars) — it is quoted verbatim in the card because
 * that pair is the only thing that tells a reader WHICH side is stale.
 *
 * Storage is best-effort: a tab with sessionStorage blocked (private mode,
 * embedded contexts) still gets one reload rather than an exception, and if
 * writing the flag throws we fall through to the card — a client that cannot
 * remember it reloaded must not be allowed to reload forever.
 */
export function decideSchemaMismatch(
    storage: MismatchStorage | null,
    currentUrl: string,
    cacheBustToken: string,
    serverMessage: string,
): SchemaMismatchAction {
    const card: SchemaMismatchAction = {
        kind: 'card',
        message: serverMessage,
    };
    if (!storage) return { kind: 'reload', url: cacheBustUrl(currentUrl, cacheBustToken) };
    let already: string | null = null;
    try {
        already = storage.getItem(VM_RELOAD_FLAG);
    } catch {
        // Unreadable storage — treat as "already reloaded". Reloading blind is
        // the one outcome with no exit.
        return card;
    }
    if (already) return card;
    try {
        storage.setItem(VM_RELOAD_FLAG, cacheBustToken);
    } catch {
        return card;
    }
    return { kind: 'reload', url: cacheBustUrl(currentUrl, cacheBustToken) };
}

/**
 * Clear the guard. Called on a successful auth: the tab is talking to a server
 * that accepts its schema, so the next mismatch (a future deploy) is entitled
 * to its own reload. Also strips the cache-buster so the URL a player copies
 * out of the address bar is the one they started with.
 */
export function clearSchemaMismatchGuard(
    storage: MismatchStorage | null,
    currentUrl: string,
): string {
    try {
        storage?.removeItem(VM_RELOAD_FLAG);
    } catch { /* best-effort */ }
    return stripCacheBust(currentUrl);
}

/**
 * Point the URL at a copy of itself the HTTP cache has never seen. A plain
 * `location.reload()` is not enough on its own — task 5 audits whether the
 * entry document is served `no-cache`, and until it says so a same-URL reload
 * can be answered from cache with the very bundle that was just rejected.
 */
export function cacheBustUrl(currentUrl: string, token: string): string {
    const url = new URL(currentUrl);
    url.searchParams.set(VM_CACHE_BUST_PARAM, token);
    return url.toString();
}

/** Remove the cache-buster param, preserving everything else. */
export function stripCacheBust(currentUrl: string): string {
    const url = new URL(currentUrl);
    if (!url.searchParams.has(VM_CACHE_BUST_PARAM)) return currentUrl;
    url.searchParams.delete(VM_CACHE_BUST_PARAM);
    return url.toString();
}

/** Overlay element id — one card at a time, and findable from a test. */
export const VM_OVERLAY_ID = 'schema-mismatch-overlay';

/**
 * Render the give-up card. Lives here rather than in main.ts so a jsdom test
 * can assert the surface a player actually reads — the alternative is a DOM
 * that only exists inside a browser session this lane cannot always get.
 * (A DOM assertion is still blind to CSS: the in-browser check is the
 * `window.test.highResScreenshot()` pass in §4.1, since CDP cannot see the
 * WebGL2 canvas this card overlays.)
 */
export function renderSchemaMismatchCard(
    doc: Document,
    serverMessage: string,
    onReturnToLobby: () => void,
): HTMLElement {
    doc.getElementById(VM_OVERLAY_ID)?.remove();
    const overlay = doc.createElement('div');
    overlay.id = VM_OVERLAY_ID;
    overlay.style.cssText =
        'position:fixed;inset:0;z-index:200;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(8,10,14,0.94);color:#e6e8ec;' +
        'font-family:system-ui,sans-serif;';
    const card = doc.createElement('div');
    card.style.cssText =
        'max-width:34rem;padding:2rem 2.25rem;background:#161a22;border:1px solid #2a3140;' +
        'border-radius:10px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,0.5);';
    const h = doc.createElement('h2');
    h.textContent = 'Client/server version mismatch persists';
    h.style.cssText = 'margin:0 0 0.75rem;font-size:1.25rem;';
    const p = doc.createElement('p');
    p.textContent = schemaMismatchCardText(serverMessage);
    p.style.cssText =
        'margin:0 0 1.5rem;line-height:1.5;color:#aab2c0;white-space:pre-wrap;' +
        'text-align:left;';
    // No "retry" button: retrying is precisely what just failed twice.
    const btn = doc.createElement('button');
    btn.textContent = 'Return to lobby';
    btn.style.cssText =
        'padding:0.6rem 1.4rem;font-size:1rem;border:0;border-radius:6px;' +
        'background:#3b6fe0;color:#fff;cursor:pointer;';
    btn.addEventListener('click', () => { overlay.remove(); onReturnToLobby(); });
    card.append(h, p, btn);
    overlay.append(card);
    doc.body.appendChild(overlay);
    return overlay;
}

/** The card's body text. The server message carries both hashes. */
export function schemaMismatchCardText(serverMessage: string): string {
    return 'This client was built against a different game protocol than the '
        + 'server is running, and reloading once did not pick up a new build. '
        + 'Hard-refresh (Cmd-Shift-R / Ctrl-Shift-R) or clear this site’s '
        + `data.\n\nServer said: ${serverMessage}`;
}
