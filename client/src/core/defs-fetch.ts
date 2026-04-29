/**
 * defs-fetch — eager HTTP fetch for the game's UnitDefs / WeaponDefs.
 *
 * The game server bakes both into content-addressed `.bin` files at
 * startup (one per modOptions hash) and the lobby's static handler
 * serves them with `Cache-Control: immutable`. Each file is the same
 * framed FlatBuffer the WebRTC stream would carry — envelope byte +
 * `ServerMessage` payload — so we just download the bytes and feed
 * them through Connection.ingestFramedMessage(), which dispatches
 * to the existing GameUnitDefs / GameWeaponDefs handlers and from
 * there into DefCache via onUnitDefs / onWeaponDefs.
 *
 * Browser HTTP caching keys on the URL itself; bumping `version` in
 * modinfo.lua or changing modOptions changes the path and forces a
 * fresh download.
 */
import type { Connection } from './connection.js';

/** Fetch UnitDefs + WeaponDefs in parallel and dispatch each into the
 *  given Connection so existing onUnitDefs / onWeaponDefs callbacks
 *  fire and DefCache populates. Resolves once both files have been
 *  ingested; throws if either fetch fails (caller decides whether to
 *  retry, fall back, or abort the bootstrap). */
export async function fetchAndIngestDefs(
    lobbyHttpUrl: string,
    gameId: string,
    cacheKey: string,
    conn: Connection,
): Promise<void> {
    if (!gameId || !cacheKey) return;
    const base = `${lobbyHttpUrl}/api/games/data/${gameId}/cache/defs/${cacheKey}`;
    const [unitDefBytes, weaponDefBytes] = await Promise.all([
        fetchBin(`${base}/unitdefs.bin`),
        fetchBin(`${base}/weapondefs.bin`),
    ]);
    conn.ingestFramedMessage(unitDefBytes);
    conn.ingestFramedMessage(weaponDefBytes);
}

async function fetchBin(url: string): Promise<Uint8Array> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`def fetch ${r.status}: ${url}`);
    return new Uint8Array(await r.arrayBuffer());
}
