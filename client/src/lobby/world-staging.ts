/**
 * world-staging.ts — the pure half of the World screen's staging flow
 * (PLAN-worldsim.md W10, PLAN-metalstorm-transports.md §7).
 *
 * No DOM, no timers, no fetch. Everything here is a function of data the
 * screen already holds (the POI graph, the clock, the player's standing) and
 * mirrors a rule the server applies, so the panel can SHOW the player what
 * the world will do before they click rather than after:
 *
 *   - `predictStagingWindow` prices the window exactly as
 *     `WorldStaging::Commit` does (rts/Server/WorldStaging.cpp:
 *     `CheapestTransitTo` + `StagingWindowFor`) — a direct edge from any POI
 *     the faction holds, cheapest wins, clamped by the world's rules. The
 *     server remains the authority: the screen re-reads the row it opened
 *     and shows THAT countdown once it exists. This is the preview.
 *   - `stagingControlState` is the §7.1 rule restated as which control
 *     exists, so the player is never offered an act the world refuses.
 *   - `remainingAfter` ticks a served countdown between fetches on the
 *     world clock the screen already ticks, so a window does not appear
 *     frozen for the thirty seconds between resyncs.
 */

import type { WorldEdge, WorldGraph, WorldPoi } from './world-map.js';

/// Mirrors `WorldStagingRules` (rts/Server/WorldStaging.h) — the defaults are
/// the server's defaults, and `parseStagingRules` reads the same keys off the
/// world's `config` (served whole on `GET /api/world`) so a per-world retune
/// is reflected here without a rebuild.
export interface StagingRules {
    stagingWindowDefaultWorldMs: number;
    stagingWindowPerTransitMs: number;
    stagingWindowMinWorldMs: number;
    stagingWindowMaxWorldMs: number;
}

export const DEFAULT_STAGING_RULES: StagingRules = {
    stagingWindowDefaultWorldMs: 12 * 3600_000,
    stagingWindowPerTransitMs: 1,
    stagingWindowMinWorldMs: 1 * 3600_000,
    stagingWindowMaxWorldMs: 72 * 3600_000,
};

/// Read the staging rules off a `GET /api/world` body's `config`. Missing or
/// malformed keys fall back per key — the same "a partial config must not
/// disable the rules it omits" discipline the server's `CfgDouble` follows.
export function parseStagingRules(worldJson: unknown): StagingRules {
    const cfg = (worldJson as any)?.config;
    const out = { ...DEFAULT_STAGING_RULES };
    if (!cfg || typeof cfg !== 'object') return out;
    for (const key of Object.keys(out) as (keyof StagingRules)[]) {
        const v = cfg[key];
        if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    }
    return out;
}

/// `StagingWindowFor`, verbatim: the transit weight times the per-transit
/// factor, clamped; no priceable transit means the world's default window.
/// A max below the min is a misconfiguration, not a licence to invert the
/// clamp — the floor wins, because "warning IS the mechanic".
export function stagingWindowFor(transitWorldMs: number, rules: StagingRules): number {
    const lo = Math.max(0, rules.stagingWindowMinWorldMs);
    const hi = Math.max(lo, rules.stagingWindowMaxWorldMs);
    const raw = transitWorldMs > 0
        ? transitWorldMs * rules.stagingWindowPerTransitMs
        : rules.stagingWindowDefaultWorldMs;
    return Math.min(hi, Math.max(lo, raw));
}

/// Every POI a faction holds. Empty for a faction with no holdings and for
/// `null` (no faction).
export function holdingsOf(graph: WorldGraph, factionId: string | null): WorldPoi[] {
    if (!factionId) return [];
    return graph.pois.filter(p => p.owner === factionId);
}

/// `CheapestTransitTo`, verbatim — DIRECT edges only, not a shortest path.
/// The server does not route a march across the graph, so a client that did
/// would predict a window the server will not open. A one-way edge counts in
/// its own direction only.
export function cheapestTransitTo(
    edges: WorldEdge[], fromPois: readonly string[], poiId: string,
): { worldMs: number; originId: string | null } {
    if (!poiId || fromPois.length === 0) return { worldMs: 0, originId: null };
    const from = new Set(fromPois);
    let best = 0;
    let origin: string | null = null;
    for (const e of edges) {
        if (!(e.transitWorldMs > 0)) continue;
        let o: string | null = null;
        if (e.to === poiId && from.has(e.from)) o = e.from;
        else if (e.bidirectional && e.from === poiId && from.has(e.to)) o = e.to;
        if (o === null) continue;
        if (best === 0 || e.transitWorldMs < best) { best = e.transitWorldMs; origin = o; }
    }
    return { worldMs: best, originId: origin };
}

export interface StagingPrediction {
    /// The transit the window is priced from, or 0 when no direct edge from a
    /// holding reaches the target (the default window applies).
    transitWorldMs: number;
    /// The holding the march would leave from, or null when unpriced.
    originId: string | null;
    windowWorldMs: number;
    /// Whether the window came from an edge or from the world's default —
    /// the panel says which, because "12h" from nowhere and "12h" from a
    /// real road are different promises.
    priced: 'edge' | 'default';
}

/// What `POST /api/world/staging/commit` would open for `factionId` at
/// `targetId` — with no `origin` in the body, which is how the screen sends
/// it (the server picks the cheapest holding, same as this).
export function predictStagingWindow(
    graph: WorldGraph, factionId: string | null, targetId: string, rules: StagingRules,
): StagingPrediction {
    const origins = holdingsOf(graph, factionId).map(p => p.id);
    const { worldMs, originId } = cheapestTransitTo(graph.edges, origins, targetId);
    return {
        transitWorldMs: worldMs,
        originId,
        windowWorldMs: stagingWindowFor(worldMs, rules),
        priced: worldMs > 0 ? 'edge' : 'default',
    };
}

/// Which staging control the POI panel offers, in the order the player meets
/// the reasons: no session, no faction, nowhere to fight, already yours.
export type StagingControlState =
    | 'no-session' | 'no-faction' | 'world-only' | 'held' | 'offer';

export function stagingControlState(
    poi: Pick<WorldPoi, 'mapId' | 'owner'>, myFactionId: string | null, hasSession: boolean,
): StagingControlState {
    if (!hasSession) return 'no-session';
    if (myFactionId === null) return 'no-faction';
    if (!poi.mapId) return 'world-only';
    if (poi.owner === myFactionId) return 'held';
    return 'offer';
}

/// A served countdown, advanced by the world time that has passed since it
/// was served. Never negative: an overdue window is materialising, i.e. zero
/// left. The elapsed figure comes from the screen's own ticked clock, which
/// stops during a pause — so a paused world shows a frozen countdown, which
/// is the truth.
export function remainingAfter(remainingWorldMs: number, elapsedWorldMs: number): number {
    if (!Number.isFinite(remainingWorldMs)) return 0;
    const elapsed = Number.isFinite(elapsedWorldMs) ? Math.max(0, elapsedWorldMs) : 0;
    return Math.max(0, remainingWorldMs - elapsed);
}

/// The force fields, cleaned: an integer of at least one, because "at least
/// one transport carrying at least one squad" is the rule and anything less
/// is not a smaller commitment but a malformed one. Capped so a typo cannot
/// commit a thousand transports.
export const MAX_FORCE_FIELD = 99;
export function cleanForceField(raw: unknown): number {
    const v = Math.floor(Number(raw));
    if (!Number.isFinite(v) || v < 1) return 1;
    return Math.min(MAX_FORCE_FIELD, v);
}

/// The route's machine tokens, as sentences. A player who committed force and
/// got "no_transport" back is owed the rule, not the token — and the mapping
/// lives here rather than in the server body so that a lobby answering a token
/// this client has never heard of degrades to the token instead of to nothing.
export function commitErrorText(token: string): string {
    switch (token) {
        case 'no_transport':   return 'A commitment needs at least one transport.';
        case 'no_squads':      return 'Those transports are carrying nothing.';
        case 'already_held':   return 'Your faction already holds this place.';
        case 'no_battle_map':  return 'Nothing can be fought over here — this POI has no battle map.';
        case 'not_in_a_faction': return 'Join a faction before committing force.';
        case 'not_your_commitment': return 'Only the committing faction can withdraw.';
        case 'no_poi':         return 'That place is no longer on the map.';
        case 'no_faction':     return 'Your faction is no longer in this world.';
        case 'no_staging':     return 'That commitment has already resolved.';
        case 'no_world':       return 'This world is no longer available.';
        case 'unauthorized':   return 'Your session has expired — sign in again.';
        case 'world_database_unavailable': return 'The world database is unavailable right now.';
        case 'db_error':       return 'The world could not record that — try again.';
        case 'failed':         return 'The world could not accept that commitment.';
        default:               return token;
    }
}
