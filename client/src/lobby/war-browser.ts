// The war browser — PLAN-metalstorm-lobby.md §4, task 6.
//
// §4: "Players choose a *war to join*, not a lobby to fill, and the default
// view is **wars where my faction is fighting**." A room browser answers "is
// there a game?"; a war browser answers a different question — "is there room
// for ME, on my side, in a war worth walking into" — and the fields that
// answer it are per-faction, not per-room.
//
// ── Two sources, and which fact comes from which is load-bearing ──────────
// The `war` block on a room row (lobby_main.cpp) is deliberately half durable
// and half live:
//
//   * `bound` / `open` come from `war_player_bindings` — a seat held by a
//     player who is offline is NOT free, and a war whose server is not even
//     running still lists with its sides and its capacity (task 3).
//   * `online` / `ais` / `regions` / `spectators` / `control` / `uptime_sec`
//     come from the digest a running server publishes, and are simply absent
//     otherwise. `live` says which of the two you are looking at.
//
// So every formatter here has to read correctly with the live half missing.
// That is not a defensive nicety: "the server is down" is a state a
// persistent war spends real time in, and it is the state in which a player
// most wants to see the war and rejoin it.

/// One side of a war, as the room JSON carries it. Field names are the wire's.
export interface WarSide {
    team: number;
    /// Faction key, lowercased by the engine's own side derivation.
    faction: string;
    /// Humans holding a seat on this side, online or not (durable).
    bound: number;
    /// Seats left, derived from `bound` — never from `online`.
    open: number;
    /// Humans connected right now. Absent when no server is publishing.
    online?: number;
    ais?: number;
    regions?: number;
}

/// The `war` block of a room row.
export interface WarInfo {
    /// True when a running server published a digest in the last 30s.
    live: boolean;
    capacity_per_side: number;
    sides: WarSide[];
    spectators?: number;
    frame?: number;
    uptime_sec?: number;
    control?: { total: number; contested: number; neutral: number };
}

/// A room row narrowed to what the war browser needs.
export interface WarRow {
    id: number;
    name: string;
    mapId: string;
    /// Room state — 3+ means the war is loading/running.
    state: number;
    war: WarInfo;
    /// True when this account already holds a seat in this war (from the
    /// join preview, which is the only per-account source).
    returning?: boolean;
    /// True when this account asked to WATCH this war (§3).
    watching?: boolean;
}

/// Which wars the browser is showing. `my-faction` is the default because it
/// is the question §4 says a player is actually asking.
export type WarFilter = 'my-faction' | 'my-wars' | 'all';

export const WAR_FILTER_LABELS: Record<WarFilter, string> = {
    'my-faction': 'My faction',
    'my-wars': 'My wars',
    'all': 'All wars',
};

/// The side of `war` this faction fields, or undefined when the war declares
/// none. A war with no side for you is not "full" — it is a war you can only
/// ever watch, and the two read very differently on a card.
export function sideForFaction(war: WarInfo, faction: string): WarSide | undefined {
    if (!faction) return undefined;
    return war.sides.find(s => s.faction === faction);
}

/// Can this account take a seat in this war right now? The decisive field of
/// §4 — "my-faction's open-slot count ... is there room for *me*".
///
/// Deliberately NOT a re-derivation of the seating rule: the authoritative
/// answer for a specific account is the join preview, which composes the same
/// functions the game server seats with. This is the list-level filter, and
/// it answers the coarser question the filter chip asks.
export function hasRoomForFaction(war: WarInfo, faction: string): boolean {
    const side = sideForFaction(war, faction);
    return !!side && side.open > 0;
}

export function filterWars(wars: WarRow[], filter: WarFilter, faction: string): WarRow[] {
    switch (filter) {
        case 'my-faction':
            // Wars my faction FIELDS A SIDE IN — not wars I can squeeze into.
            // A full war my faction is fighting is still my war to watch, and
            // hiding it would hide the thing that is happening in the world.
            return wars.filter(w => !!sideForFaction(w.war, faction));
        case 'my-wars':
            return wars.filter(w => w.returning);
        case 'all':
            return wars;
    }
}

/// Title-case a faction key for display. The keys are lowercased by the
/// engine's `SideParser::StringToLower(name)` derivation (task 0), so there is
/// no cased spelling to recover — only the key.
export function factionLabel(key: string): string {
    if (!key) return '';
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/// "Compact 2/8" — and "Compact 2/8 (1 online)" when the war is live and the
/// two numbers differ, which is the case a player has to be able to see: a
/// side can be full of people who are not there.
export function formatSide(side: WarSide, capacity: number, live: boolean): string {
    const seats = capacity > 0 ? `${side.bound}/${capacity}` : `${side.bound}`;
    let s = `${factionLabel(side.faction)} ${seats}`;
    const extras: string[] = [];
    if (live && side.online !== undefined && side.online !== side.bound)
        extras.push(`${side.online} online`);
    if (live && side.ais) extras.push(`${side.ais} AI`);
    if (extras.length) s += ` (${extras.join(', ')})`;
    return s;
}

/// "up 14m" / "up 3h 02m". Coarse on purpose: the browser is answering "has
/// this been going a while", not timing anything.
export function formatUptime(sec: number): string {
    if (sec < 60) return 'just started';
    const mins = Math.floor(sec / 60);
    if (mins < 60) return `up ${mins}m`;
    const hrs = Math.floor(mins / 60);
    return `up ${hrs}h ${String(mins % 60).padStart(2, '0')}m`;
}

/// The war's front, in one clause: "11 regions · 2 contested". Empty when the
/// map publishes no regions at all (not every map has the gadget) rather than
/// printing a row of zeroes that reads like a stalled war.
export function formatControl(war: WarInfo): string {
    const c = war.control;
    if (!c || c.total === 0) return '';
    const parts = [`${c.total} regions`];
    if (c.contested > 0) parts.push(`${c.contested} contested`);
    if (c.neutral > 0) parts.push(`${c.neutral} neutral`);
    return parts.join(' · ');
}

/// The line under a war's name: map, every side's population, spectators,
/// uptime. Sides always; the rest only when a server is publishing.
export function formatWarDetail(row: WarRow): string {
    const parts: string[] = [];
    if (row.mapId) parts.push(row.mapId);
    for (const side of row.war.sides)
        parts.push(formatSide(side, row.war.capacity_per_side, row.war.live));
    if (row.war.live) {
        if (row.war.spectators) parts.push(`${row.war.spectators} watching`);
        if (row.war.uptime_sec !== undefined)
            parts.push(formatUptime(row.war.uptime_sec));
    } else {
        // Said plainly rather than omitted. A war with no server is a real
        // state that a join RESUMES (task 3) — a card that just goes quiet
        // reads as a broken row.
        parts.push('no server running — a join restarts it');
    }
    return parts.join(' · ');
}

/// The label on the primary button. A war you already hold a seat in is a
/// rejoin, and that is the word a returning player is looking for.
export function fightLabel(row: WarRow): string {
    return row.returning ? 'Rejoin' : 'Fight';
}
