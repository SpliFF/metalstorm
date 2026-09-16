/**
 * world-ledger.ts — the pure half of the World screen's ONE access point for
 * global world data (the "ledger" drawer) and of the faction panel.
 *
 * Parsers for the read routes the drill-down panels open on demand:
 *
 *   GET  /api/world             → `parseSeasonStatus` (the `season` fold, W12)
 *   GET  /api/world/seasons     → `parseSeasonsIndex`
 *   GET  /api/world/seasons/{n} → `parseSeasonArchive` (digest rows)
 *   GET  /api/world/stats       → `parseWorldStats` (economy + rosters + rank)
 *   GET  /api/world/factions    → `parseFactionCatalogue` (roster + archetypes + founding rules)
 *   POST /api/world/me          → `parseMembership` (the W7 half; W8's stats
 *                                 are `parseWorldPlayerStats` in world-map.ts)
 *
 * Every parser drops what it cannot read rather than throwing, for the reason
 * the rest of the lane's parsers do: a lobby one milestone behind answers
 * without a key, and that must render as "not yet" rather than as a broken
 * drawer. No DOM.
 */

function num(v: unknown, fallback = 0): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function str(v: unknown, fallback = ''): string {
    return typeof v === 'string' ? v : fallback;
}

// ─────────────────────────── seasons (W12) ───────────────────────────

/// The active season as `GET /api/world` folds it (`WorldSeasons::AttachSeasonStatus`).
export interface SeasonStatus {
    number: number;
    startedWorldMs: number;
    endsWorldMs: number;
    lengthWorldMs: number;
    remainingWorldMs: number;
}

export function parseSeasonStatus(worldJson: unknown): SeasonStatus | null {
    const s = (worldJson as any)?.season;
    if (!s || typeof s !== 'object' || typeof s.number !== 'number') return null;
    return {
        number: s.number,
        startedWorldMs: num(s.startedWorldMs),
        endsWorldMs: num(s.endsWorldMs),
        lengthWorldMs: num(s.lengthWorldMs),
        remainingWorldMs: Math.max(0, num(s.remainingWorldMs)),
    };
}

/// One season row (`SeasonRowJson`).
export interface SeasonRow {
    number: number;
    state: string;
    seasonId: string;
    startedWorldMs: number;
    endedWorldMs: number;
}

function parseSeasonRow(raw: unknown): SeasonRow | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.number !== 'number') return null;
    return {
        number: r.number,
        state: str(r.state, 'archived'),
        seasonId: str(r.seasonId),
        startedWorldMs: num(r.startedWorldMs),
        endedWorldMs: num(r.endedWorldMs),
    };
}

/// `GET /api/world/seasons` — newest first, as served.
export function parseSeasonsIndex(json: unknown): SeasonRow[] | null {
    const arr = (json as any)?.seasons;
    if (!Array.isArray(arr)) return null;
    return arr.map(parseSeasonRow).filter((s): s is SeasonRow => s !== null);
}

/// One faction's archived digest for one season.
export interface SeasonDigest {
    /// Empty string is the server's "no faction" marker (null on the wire).
    factionId: string;
    settlementsWon: number;
    poiIncomeTotal: number;
    decayTotal: number;
    treasuryAtRollover: number;
}

export interface SeasonArchive {
    season: SeasonRow;
    digests: SeasonDigest[];
}

/// `GET /api/world/seasons/{n}`. An ACTIVE season answers with an empty
/// `digests` — it has not been archived yet, and the drawer says so rather
/// than showing zeroes.
export function parseSeasonArchive(json: unknown): SeasonArchive | null {
    if (!json || typeof json !== 'object' || (json as any).error) return null;
    const season = parseSeasonRow((json as any).season);
    if (!season) return null;
    const digests: SeasonDigest[] = [];
    for (const d of (Array.isArray((json as any).digests) ? (json as any).digests : []) as Record<string, unknown>[]) {
        if (!d || typeof d !== 'object') continue;
        digests.push({
            factionId: typeof d.factionId === 'string' ? d.factionId : '',
            settlementsWon: num(d.settlementsWon),
            poiIncomeTotal: num(d.poiIncomeTotal),
            decayTotal: num(d.decayTotal),
            treasuryAtRollover: num(d.treasuryAtRollover),
        });
    }
    // Standing: most settlements won, then the richest treasury at rollover.
    digests.sort((a, b) => b.settlementsWon - a.settlementsWon
        || b.treasuryAtRollover - a.treasuryAtRollover);
    return { season, digests };
}

// ─────────────────────────── stats / economy (W8 + W9) ───────────────────────

export interface EconomyRates {
    poiIncomePerWorldDay: number;
    treasuryDecayPerWorldDay: number;
    treasuryFloor: number;
}

export interface FactionEconomy {
    factionId: string;
    treasury: number;
    poisHeld: number;
}

export interface RosterMember {
    accountId: number;
    username: string;
    role: string;
    rankTotal: number;
}

export interface FactionRoster {
    factionId: string;
    name: string;
    colour: string;
    members: RosterMember[];
    rankTotal: number;
}

export interface WorldStatsBody {
    economy: { rates: EconomyRates; factions: FactionEconomy[] } | null;
    factions: FactionRoster[];
}

/// `GET /api/world/stats` — the two things the panels read off it: each
/// faction's treasury/holdings (`WorldEconomy::EconomyJson`, folded in by
/// the transport layer) and each faction's roster with derived Rank. The
/// per-commander list is not parsed here; the player's own commanders come
/// from `/api/world/me`.
export function parseWorldStats(json: unknown): WorldStatsBody | null {
    if (!json || typeof json !== 'object' || (json as any).error) return null;
    const raw = json as Record<string, unknown>;
    let economy: WorldStatsBody['economy'] = null;
    if (raw.economy && typeof raw.economy === 'object') {
        const e = raw.economy as Record<string, unknown>;
        const factions: FactionEconomy[] = [];
        for (const f of (Array.isArray(e.factions) ? e.factions : []) as Record<string, unknown>[]) {
            if (!f || typeof f.factionId !== 'string' || !f.factionId) continue;
            factions.push({ factionId: f.factionId, treasury: num(f.treasury), poisHeld: num(f.poisHeld) });
        }
        economy = {
            rates: {
                poiIncomePerWorldDay: num(e.poiIncomePerWorldDay, 2),
                treasuryDecayPerWorldDay: num(e.treasuryDecayPerWorldDay),
                treasuryFloor: num(e.treasuryFloor),
            },
            factions: factions.sort((a, b) => b.treasury - a.treasury),
        };
    }
    const factions: FactionRoster[] = [];
    for (const f of (Array.isArray(raw.factions) ? raw.factions : []) as Record<string, unknown>[]) {
        if (!f || typeof f.factionId !== 'string' || !f.factionId) continue;
        const members: RosterMember[] = [];
        for (const m of (Array.isArray(f.members) ? f.members : []) as Record<string, unknown>[]) {
            if (!m || typeof m !== 'object') continue;
            members.push({
                accountId: num(m.accountId),
                username: str(m.username, `#${num(m.accountId)}`),
                role: str(m.role, 'member'),
                rankTotal: num((m.rank as any)?.total),
            });
        }
        // Served in rank order already; sorting again is cheap insurance
        // against a lobby that stops doing so.
        members.sort((a, b) => b.rankTotal - a.rankTotal);
        factions.push({
            factionId: f.factionId,
            name: str(f.name, f.factionId),
            colour: str(f.colour),
            members,
            rankTotal: num(f.rankTotal),
        });
    }
    return { economy, factions };
}

// ─────────────────────────── factions (W7) ───────────────────────────

export interface FactionArchetype {
    key: string;
    name: string;
    description: string;
    governance: string;
    colour: string;
}

export interface FactionRow {
    id: string;
    name: string;
    archetype: string;
    governance: string;
    colour: string;
    sideKey: string | null;
    state: string;
    memberCount: number;
    foundedAt: number;
}

export interface FactionCatalogue {
    factions: FactionRow[];
    archetypes: FactionArchetype[];
    rules: {
        foundFactionAuthority: number;
        foundFactionCost: number;
        nameMinLen: number;
        nameMaxLen: number;
    };
}

/// `GET /api/world/factions`.
export function parseFactionCatalogue(json: unknown): FactionCatalogue | null {
    if (!json || typeof json !== 'object' || (json as any).error) return null;
    const raw = json as Record<string, unknown>;
    if (!Array.isArray(raw.factions)) return null;
    const factions: FactionRow[] = [];
    for (const f of raw.factions as Record<string, unknown>[]) {
        if (!f || typeof f.id !== 'string' || !f.id) continue;
        factions.push({
            id: f.id,
            name: str(f.name, f.id),
            archetype: str(f.archetype),
            governance: str(f.governance),
            colour: /^#[0-9a-fA-F]{6}$/.test(str(f.colour)) ? str(f.colour) : '',
            sideKey: typeof f.sideKey === 'string' && f.sideKey ? f.sideKey : null,
            state: str(f.state, 'active'),
            memberCount: num(f.memberCount),
            foundedAt: num(f.foundedAt),
        });
    }
    const archetypes: FactionArchetype[] = [];
    for (const a of (Array.isArray(raw.archetypes) ? raw.archetypes : []) as Record<string, unknown>[]) {
        if (!a || typeof a.key !== 'string' || !a.key) continue;
        archetypes.push({
            key: a.key,
            name: str(a.name, a.key),
            description: str(a.description),
            governance: str(a.governance),
            colour: /^#[0-9a-fA-F]{6}$/.test(str(a.colour)) ? str(a.colour) : '',
        });
    }
    const r = (raw.rules && typeof raw.rules === 'object' ? raw.rules : {}) as Record<string, unknown>;
    return {
        factions: factions.sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name)),
        archetypes,
        rules: {
            foundFactionAuthority: num(r.foundFactionAuthority, 100),
            foundFactionCost: num(r.foundFactionCost),
            nameMinLen: num(r.nameMinLen, 3),
            nameMaxLen: num(r.nameMaxLen, 40),
        },
    };
}

/// The W7 half of `POST /api/world/me`: membership, the founding gate and
/// the account's battle side (for explaining a `side_mismatch` BEFORE the
/// join click, which is what the route sends `sideKey` for).
export interface WorldMembership {
    accountId: number;
    /// W7's world authority — the founding gate's and the claim's number.
    authority: number;
    canFound: boolean;
    sideKey: string | null;
    membership: {
        factionId: string;
        role: string;
        rank: number;
        name: string;
        colour: string;
        sideKey: string | null;
    } | null;
}

export function parseMembership(json: unknown): WorldMembership | null {
    if (!json || typeof json !== 'object' || (json as any).error) return null;
    const raw = json as Record<string, unknown>;
    if (typeof raw.accountId !== 'number' && raw.membership === undefined) return null;
    const m = raw.membership;
    let membership: WorldMembership['membership'] = null;
    if (m && typeof m === 'object' && typeof (m as any).factionId === 'string' && (m as any).factionId) {
        const mm = m as Record<string, unknown>;
        membership = {
            factionId: mm.factionId as string,
            role: str(mm.role, 'member'),
            rank: num(mm.rank),
            name: str(mm.name, mm.factionId as string),
            colour: /^#[0-9a-fA-F]{6}$/.test(str(mm.colour)) ? str(mm.colour) : '',
            sideKey: typeof mm.sideKey === 'string' && mm.sideKey ? mm.sideKey : null,
        };
    }
    return {
        accountId: num(raw.accountId),
        authority: num(raw.authority),
        canFound: raw.canFound === true,
        sideKey: typeof raw.sideKey === 'string' && raw.sideKey ? raw.sideKey : null,
        membership,
    };
}

/// Why a join would be refused before it is clicked: the side-key seam
/// (`ReconcileSideKey`). Adopting is fine, differing is a 409.
export function joinSideConflict(accountSide: string | null, factionSide: string | null): boolean {
    return !!accountSide && !!factionSide && accountSide !== factionSide;
}

/// The founding route's tokens (`/api/world/factions/found`, `/join`,
/// `/leave`) as sentences. `detail` is the server's own explanation where it
/// sends one — shown after the sentence, never instead of it.
export function factionErrorText(token: string, extra?: { detail?: string; have?: number; need?: number }): string {
    const detail = extra?.detail ? ` (${extra.detail})` : '';
    switch (token) {
        case 'insufficient_authority':
            return typeof extra?.need === 'number'
                ? `Founding needs ${Math.round(extra.need)} world authority — you have ${Math.round(extra.have ?? 0)}.`
                : 'Not enough world authority to found a faction.';
        case 'name_taken':     return 'A faction with that name already exists.';
        case 'already_member': return 'You are already in a faction — leave it first.';
        case 'seat_taken':     return 'That seat is already another faction\'s.';
        case 'bad_seat':       return 'That seat is not a place in this world.';
        case 'bad_name':       return `That name will not do${detail}.`;
        case 'bad_archetype':  return 'Choose an archetype.';
        case 'no_such_faction': return 'That faction no longer exists.';
        case 'side_mismatch':  return `Your account fights for a different side${detail}.`;
        case 'bad_request':    return `The request was malformed${detail}.`;
        case 'unauthorized':   return 'Your session has expired — sign in again.';
        case 'world_database_unavailable': return 'The world database is unavailable right now.';
        case 'db_error':       return 'The world could not record that — try again.';
        case 'failed':         return 'The world could not accept that.';
        default:               return token + detail;
    }
}

// ─────────────────────────── the clock's pause ledger (W4) ───────────────────

/// The `/api/world/pause` answer. `changed:false` is a no-op, not an error.
export interface PauseAnswer { ok: boolean; changed: boolean; error: string | null }

export function parsePauseAnswer(json: unknown): PauseAnswer {
    if (!json || typeof json !== 'object')
        return { ok: false, changed: false, error: 'failed' };
    const raw = json as Record<string, unknown>;
    if (raw.ok === true) return { ok: true, changed: raw.changed === true, error: null };
    return { ok: false, changed: false, error: str(raw.error, 'failed') };
}

// ─────────────────────────── display helpers ───────────────────────────

/// Signed, one decimal below 100 — for treasury deltas and digest lines.
export function formatSigned(v: number): string {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v) >= 100 ? Math.round(Math.abs(v)).toString()
        : (Math.round(Math.abs(v) * 10) / 10).toString();
    return v < 0 ? `−${abs}` : `+${abs}`;
}

/// One season digest as a sentence, with the faction NAMED (the wire carries
/// an id). "No faction" rows are the world's own ledger line.
export function formatDigestLine(d: SeasonDigest, factionName: (id: string) => string): string {
    const who = d.factionId ? factionName(d.factionId) : 'Unaffiliated';
    const won = `${d.settlementsWon} settlement${d.settlementsWon === 1 ? '' : 's'} won`;
    const income = `income ${formatSigned(d.poiIncomeTotal)}`;
    const decay = d.decayTotal !== 0 ? `, decay ${formatSigned(-Math.abs(d.decayTotal))}` : '';
    return `${who}: ${won}, ${income}${decay}, treasury ${Math.round(d.treasuryAtRollover)} at rollover`;
}
