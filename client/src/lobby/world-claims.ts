/**
 * world-claims.ts — the pure half of conquest on the World screen
 * (rts/Server/WorldConquest.h, USER-DECIDED 2026-08-27: the explicit claim
 * act).
 *
 * The rule, as the panel must state it: POI ownership changes at war end
 * ONLY to a winning-side faction that filed a claim on that POI before the
 * war ended. Filing costs world authority (`claimPoiCost`, 25 by default),
 * losing refunds a fraction, an open claim expires after `claimExpiryWorldMs`
 * of WORLD time, and the DEFENDER'S SHIELD means a POI whose owner is on the
 * winning side never changes hands — so a claim on a place your own side
 * holds can only ever burn authority. The server refuses those cases; this
 * module refuses them first so the button is not offered.
 *
 * No DOM. `GET /api/world/claims` in, eligibility and labels out.
 */

export type WorldClaimState = 'open' | 'won' | 'lost' | 'expired' | 'withdrawn';

/// One `world_poi_claims` row as `WorldConquest::ClaimJson` carries it.
export interface WorldClaim {
    claimId: number;
    poi: string;
    faction: string;
    accountId: number;
    cost: number;
    refund: number;
    state: WorldClaimState;
    filedAtWorldMs: number;
    /// Real ms, 0 while open.
    resolvedAt: number;
    /// A label into the world's settlement ledger, 0 unless a war resolved
    /// it. Never a room key.
    settlementId: number;
}

/// Mirrors `WorldConquestRules`. Served on `GET /api/world/claims` as
/// `rules`; the defaults here are the server's defaults for a lobby that
/// answers without them.
export interface ClaimRules {
    claimPoiCost: number;
    claimRefundFraction: number;
    claimExpiryWorldMs: number;
}

export const DEFAULT_CLAIM_RULES: ClaimRules = {
    claimPoiCost: 25,
    claimRefundFraction: 0.5,
    claimExpiryWorldMs: 30 * 24 * 3600_000,
};

export interface WorldClaims {
    worldId: string;
    rules: ClaimRules;
    claims: WorldClaim[];
}

const STATES: readonly WorldClaimState[] = ['open', 'won', 'lost', 'expired', 'withdrawn'];

function num(v: unknown, fallback = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/// Parse `GET /api/world/claims`. Null for a body that is not the route's
/// (a pre-conquest lobby 404s it and `lobbyGet` hands back null). A row with
/// no id or an unknown state is dropped rather than shown with a made-up
/// state — a claim shown as "open" that the server thinks is lost is a lie
/// about what the player could still win.
export function parseClaims(json: unknown): WorldClaims | null {
    if (!json || typeof json !== 'object') return null;
    const raw = json as Record<string, unknown>;
    if (!Array.isArray(raw.claims)) return null;
    const rules = { ...DEFAULT_CLAIM_RULES };
    if (raw.rules && typeof raw.rules === 'object') {
        const r = raw.rules as Record<string, unknown>;
        for (const key of Object.keys(rules) as (keyof ClaimRules)[]) {
            if (typeof r[key] === 'number' && Number.isFinite(r[key] as number)) rules[key] = r[key] as number;
        }
    }
    const claims: WorldClaim[] = [];
    for (const item of raw.claims as Record<string, unknown>[]) {
        if (!item || typeof item !== 'object') continue;
        const claimId = num(item.claimId);
        if (claimId <= 0) continue;
        if (typeof item.poi !== 'string' || !item.poi) continue;
        if (typeof item.faction !== 'string' || !item.faction) continue;
        const state = STATES.includes(item.state as WorldClaimState) ? item.state as WorldClaimState : null;
        if (!state) continue;
        claims.push({
            claimId,
            poi: item.poi,
            faction: item.faction,
            accountId: num(item.accountId),
            cost: num(item.cost),
            refund: num(item.refund),
            state,
            filedAtWorldMs: num(item.filedAtWorldMs),
            resolvedAt: num(item.resolvedAt),
            settlementId: num(item.settlementId),
        });
    }
    return {
        worldId: typeof raw.worldId === 'string' ? raw.worldId : '',
        rules,
        claims,
    };
}

export function openClaimsAt(claims: readonly WorldClaim[], poiId: string): WorldClaim[] {
    return claims.filter(c => c.state === 'open' && c.poi === poiId);
}

export function myOpenClaimAt(
    claims: readonly WorldClaim[], factionId: string | null, poiId: string,
): WorldClaim | null {
    if (!factionId) return null;
    return openClaimsAt(claims, poiId).find(c => c.faction === factionId) ?? null;
}

/// The queue order a settlement reads: earliest `filedAtWorldMs` first, ties
/// by `claimId` (file order). Deterministic, and the same order the server
/// resolves in (WorldConquest.h rule 5), so the panel's "2nd in line" is the
/// server's.
export function claimQueue(claims: readonly WorldClaim[], poiId: string): WorldClaim[] {
    return openClaimsAt(claims, poiId).sort((a, b) =>
        a.filedAtWorldMs - b.filedAtWorldMs || a.claimId - b.claimId);
}

export type ClaimIneligibleReason =
    | 'no-session' | 'no-faction' | 'own-poi' | 'already-claimed' | 'insufficient-authority';

export interface ClaimEligibility {
    ok: boolean;
    reason: ClaimIneligibleReason | null;
    /// What filing charges — shown on the button whether or not it is
    /// enabled, so the cost is never a surprise.
    cost: number;
    have: number;
    /// Refund on any outcome but "won", as a fraction of `cost`.
    refundFraction: number;
    /// The player's own open claim here, if any (the withdraw control's row).
    existing: WorldClaim | null;
}

/// Whether the panel may offer "File claim" at all — the server's refusals
/// (`already_owner`, `already_claimed`, `insufficient_authority`,
/// `not_in_a_faction`) restated as which control exists.
export function claimEligibility(args: {
    poiOwner: string | null;
    myFactionId: string | null;
    hasSession: boolean;
    worldAuthority: number;
    claims: readonly WorldClaim[];
    poiId: string;
    rules: ClaimRules;
}): ClaimEligibility {
    const cost = args.rules.claimPoiCost;
    const base = {
        cost, have: args.worldAuthority, refundFraction: args.rules.claimRefundFraction,
        existing: myOpenClaimAt(args.claims, args.myFactionId, args.poiId),
    };
    if (!args.hasSession) return { ...base, ok: false, reason: 'no-session' };
    if (args.myFactionId === null) return { ...base, ok: false, reason: 'no-faction' };
    if (args.poiOwner === args.myFactionId) return { ...base, ok: false, reason: 'own-poi' };
    if (base.existing) return { ...base, ok: false, reason: 'already-claimed' };
    if (args.worldAuthority < cost) return { ...base, ok: false, reason: 'insufficient-authority' };
    return { ...base, ok: true, reason: null };
}

/// The sentence for each reason, so the panel explains an absent button.
export function claimIneligibleText(reason: ClaimIneligibleReason, e: ClaimEligibility): string {
    switch (reason) {
        case 'no-session': return 'Sign in to file a claim.';
        case 'no-faction': return 'Join a faction before filing a claim.';
        case 'own-poi':    return 'Your faction holds this place — the defender needs no claim.';
        case 'already-claimed': return 'Your faction already has a claim filed here.';
        case 'insufficient-authority':
            return `Filing costs ${fmt(e.cost)} world authority — you have ${fmt(e.have)}.`;
    }
}

/// World ms until an open claim expires, or null when expiry is disabled.
/// Never negative.
export function claimExpiresIn(claim: WorldClaim, rules: ClaimRules, nowWorldMs: number): number | null {
    if (!(rules.claimExpiryWorldMs > 0)) return null;
    return Math.max(0, claim.filedAtWorldMs + rules.claimExpiryWorldMs - nowWorldMs);
}

export function claimStateLabel(state: WorldClaimState): string {
    switch (state) {
        case 'open':      return 'open';
        case 'won':       return 'won';
        case 'lost':      return 'lost';
        case 'expired':   return 'expired';
        case 'withdrawn': return 'withdrawn';
    }
}

/// The route's tokens as sentences (`/api/world/claims/file` and
/// `/withdraw`). `insufficient_authority` carries `have`/`need` on the wire;
/// the caller passes them through so the sentence has the numbers.
export function claimErrorText(token: string, extra?: { have?: number; need?: number }): string {
    switch (token) {
        case 'already_owner':   return 'Your faction already holds this place.';
        case 'already_claimed': return 'Your faction already has an open claim here.';
        case 'no_poi':          return 'That place is no longer on the map.';
        case 'no_faction':      return 'Your faction is no longer in this world.';
        case 'not_in_a_faction': return 'Join a faction before filing a claim.';
        case 'not_your_claim':  return 'Only the claiming faction can withdraw it.';
        case 'no_claim':        return 'That claim no longer exists.';
        case 'insufficient_authority':
            return extra && typeof extra.need === 'number'
                ? `Not enough world authority — filing costs ${fmt(extra.need)}, you have ${fmt(extra.have ?? 0)}.`
                : 'Not enough world authority to file a claim.';
        case 'unauthorized':    return 'Your session has expired — sign in again.';
        case 'world_database_unavailable': return 'The world database is unavailable right now.';
        case 'db_error':        return 'The world could not record that — try again.';
        case 'failed':          return 'The world could not accept that claim.';
        default:                return token;
    }
}

function fmt(v: number): string {
    if (!Number.isFinite(v)) return '—';
    return Math.abs(v) >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString();
}
