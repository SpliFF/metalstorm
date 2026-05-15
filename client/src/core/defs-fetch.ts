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

/** Fetch UnitDefs + WeaponDefs + CegDefs in parallel and dispatch
 *  each into the given Connection so existing onUnitDefs /
 *  onWeaponDefs / onCegDefs callbacks fire and DefCache populates.
 *  Resolves once all three files have been ingested. Unit/weapon
 *  fetches throw on failure (caller decides whether to retry,
 *  fall back, or abort the bootstrap); the CEG fetch is best-effort
 *  — older bakes won't have a cegdefs.bin and the projectile renderer
 *  falls through to BUILTIN_EFFECTS in that case. */
export async function fetchAndIngestDefs(
    lobbyHttpUrl: string,
    gameId: string,
    cacheKey: string,
    conn: Connection,
): Promise<void> {
    if (!gameId || !cacheKey) return;
    const base = `${lobbyHttpUrl}/api/games/data/${gameId}/cache/defs/${cacheKey}`;
    const [unitDefBytes, weaponDefBytes, cegDefBytes, featureDefBytes] = await Promise.all([
        fetchBin(`${base}/unitdefs.bin`),
        fetchBin(`${base}/weapondefs.bin`),
        fetchBinOptional(`${base}/cegdefs.bin`),
        fetchBinOptional(`${base}/featuredefs.bin`),
    ]);
    conn.ingestFramedMessage(unitDefBytes);
    conn.ingestFramedMessage(weaponDefBytes);
    // CEG and feature defs are best-effort — a parse failure here
    // should never black-screen the whole game. Swallow + log so the
    // archetype-based CEG dispatch and placeholder-cube wreck renderer
    // keep covering for missing data.
    if (cegDefBytes) {
        try {
            conn.ingestFramedMessage(cegDefBytes);
        } catch (err) {
            console.warn('[defs-fetch] CEG ingest failed; falling back to BUILTIN_EFFECTS:', err);
        }
    }
    if (featureDefBytes) {
        try {
            conn.ingestFramedMessage(featureDefBytes);
        } catch (err) {
            console.warn('[defs-fetch] FeatureDefs ingest failed; wrecks will render as placeholders:', err);
        }
    }
}

async function fetchBin(url: string): Promise<Uint8Array> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`def fetch ${r.status}: ${url}`);
    return new Uint8Array(await r.arrayBuffer());
}

/// Best-effort fetch — returns null on 404 so older v9 bakes (which
/// only wrote unitdefs.bin / weapondefs.bin) keep booting cleanly.
async function fetchBinOptional(url: string): Promise<Uint8Array | null> {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return new Uint8Array(await r.arrayBuffer());
    } catch {
        return null;
    }
}
