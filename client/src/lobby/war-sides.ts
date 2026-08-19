// war-sides — the room's slot list: which sides a player or AI slot may be
// seated on, and what each one is called.
//
// WHY THIS EXISTS (PLAN-metalstorm-wars.md §7.4, PLAN-endtoend.md D19).
// The room screen used to render a hardcoded two-entry dropdown — `Team 1` /
// `Team 2`, i.e. team indices 0 and 1. Meridian Basin declares its compact
// side as teams 0–3 and its union side as teams 4–7, and stages a starting
// force for teams 0 and 4 only. So a war created through the Create Game
// dialog seated the AI opponent on team 1: a declared compact *teammate* with
// no units, while the union's entire army was skipped for want of a team 4.
// Measured live at frame 1169 — team 0 = 13 units, team 1 = 0 units. The war
// had one army and could not be played.
//
// The fix is that a slot picks a SIDE. The lobby resolves each side to the
// team the scenario stages that side's army on and publishes the result as
// the room's `war_sides` modoption (`"compact:0,union:4"`), written once at
// create time by applyRoomScenario. This module is the client's reader for
// that one string. The server is the single owner of the mapping; nothing
// here re-derives it from scenario content.

/// One offerable slot position.
export interface WarSide {
    /// The scenario's faction key, e.g. "compact". Empty for the legacy
    /// two-team fallback, which has no faction to name.
    faction: string;
    /// The team index a slot on this side is seated on.
    team: number;
    /// What the dropdown shows.
    label: string;
}

/// What a room with no `war_sides` offers: the two-team room every game that
/// ships no scenarios (Paper Tanks, ZK) has always had. Kept as the fallback
/// rather than an error case — most rooms are still this.
export const LEGACY_SIDES: readonly WarSide[] = [
    { faction: '', team: 0, label: 'Team 1' },
    { faction: '', team: 1, label: 'Team 2' },
];

/// "compact" → "Compact", "free_cities" → "Free Cities". The faction key is
/// authored content and carries no display name of its own, so the label is
/// derived rather than invented per-scenario.
function labelForFaction(faction: string): string {
    return faction
        .split(/[_\s]+/)
        .filter(w => w.length > 0)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/// Parse the `war_sides` modoption (`"<faction>:<team>[,<faction>:<team>…]"`).
///
/// Anything malformed is dropped rather than coerced: a `Number()` that
/// quietly yields 0 would seat two sides on the same team, which looks like a
/// working room right up until nobody has an opponent. An entry with no
/// faction name is not a side however parseable its number is. If nothing
/// survives, the caller gets the legacy two-team room — the same result as a
/// room that declares no sides at all.
export function parseWarSides(spec: string | undefined | null): WarSide[] {
    const out: WarSide[] = [];
    for (const entry of (spec ?? '').split(',')) {
        const colon = entry.indexOf(':');
        if (colon <= 0) continue;
        const faction = entry.slice(0, colon).trim();
        const teamStr = entry.slice(colon + 1).trim();
        if (!faction || !/^\d+$/.test(teamStr)) continue;
        const team = Number(teamStr);
        if (team < 0 || team > 255) continue;
        if (out.some(s => s.team === team)) continue;
        out.push({ faction, team, label: labelForFaction(faction) });
    }
    return out.length > 0 ? out : LEGACY_SIDES.map(s => ({ ...s }));
}

/// The slot list for a room, read off its modoptions.
export function warSidesForRoom(
    modOptions: Record<string, string> | undefined,
): WarSide[] {
    return parseWarSides(modOptions?.war_sides);
}

/// Escape for interpolation into an attribute or text node. Faction keys come
/// from scenario files rather than from users, but they reach the DOM through
/// innerHTML like every other room field and are escaped on the same terms.
function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/// Render the `<option>` list for a slot's side dropdown.
///
/// `selected` is the slot's current team. A slot sitting on a team no side
/// offers — a manifest-created room can legitimately do this, e.g. Meridian's
/// reaver NPC on team 8 — gets an extra trailing entry so the dropdown shows
/// where it actually is instead of silently reading as side one.
export function renderSideOptions(sides: WarSide[], selected: number): string {
    const opts = sides.map(s =>
        `<option value="${s.team}"${s.team === selected ? ' selected' : ''}>`
        + `${esc(s.label)}</option>`);
    if (!sides.some(s => s.team === selected))
        opts.push(`<option value="${selected}" selected>Team ${selected + 1}`
            + `</option>`);
    return opts.join('');
}

/// The side to default a newly-added AI slot to: the first one nobody holds,
/// else the last side (so a second AI at least lands opposite the host rather
/// than always on side one). Mirrors the lobby's own firstFreeSlotTeam.
export function defaultTeamForNewSlot(
    sides: WarSide[],
    occupied: readonly number[],
): number {
    const free = sides.find(s => !occupied.includes(s.team));
    if (free) return free.team;
    return sides.length > 0 ? sides[sides.length - 1].team : 1;
}

/// The side an account's permanent faction binds it to in this room, or
/// undefined if this war declares no side for it (PLAN-endtoend.md D40).
///
/// The server has already seated the player here and refuses
/// `POST /api/rooms/team` for anything else, so this is what lets the room
/// screen stop OFFERING the other side — D41's lesson is that a refusal the
/// player can walk into is worse than a control that isn't there.
///
/// An empty faction never matches, and the legacy fallback's sides have no
/// faction names, so a no-scenario room binds nobody.
export function sideForFaction(
    sides: readonly WarSide[],
    faction: string | undefined,
): WarSide | undefined {
    if (!faction) return undefined;
    return sides.find(s => s.faction !== '' && s.faction === faction);
}
