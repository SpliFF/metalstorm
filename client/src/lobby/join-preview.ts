// Pre-join legibility for a persistent war — PLAN-metalstorm-lobby.md §2.4,
// task 5.
//
// §2.4 splits onboarding in two: the sim makes the grants (the hook contract in
// rts/Server/PlayerOnboarding.h) and "the lobby's job is to make this legible
// pre-join ('you'll join Side B near the River Line with 100 authority')".
//
// A war is the one room kind where "what happens if I click Join" is neither
// obvious nor chosen. The side comes from an immutable faction the player
// cannot change; the seat may already be theirs from a session last week; the
// authority they arrive with is a fresh grant, their own restored pool, or a
// stipend, depending on how long they have been away. A room card that says
// "3/8 players" answers none of it.
//
// The wording lives here, on its own, because the numbers come from the server
// (`POST /api/wars/join-preview`, which composes the SAME seating functions the
// game server seats with) and the sentence is the only part worth testing in
// the browser.

/// One row of `POST /api/wars/join-preview`. Field names are the wire's.
export interface WarJoinPreview {
    room_id: number;
    /// Whether this account takes a PLAYING seat. False still joins — as a
    /// spectator, which is what every declined dynamic join falls back to.
    will_fight: boolean;
    /// `DynamicJoinOutcomeToString` — why not, when `will_fight` is false.
    reason: string;
    team: number;
    /// The faction key of the side, as the war declares it.
    side: string;
    humans_on_side: number;
    /// 0 = no per-side cap.
    capacity_per_side: number;
    authority: number;
    /// `join_grant` | `restored_pool` | `onboarding_stipend` | `none`.
    authority_source: string;
    /// True when this account already holds this seat.
    returning: boolean;
}

/// Title-case a faction key for display. The keys are lowercased by the
/// engine's own `SideParser::StringToLower(name)` derivation (task 0), so
/// there is no cased spelling to recover from the wire — only the key.
function factionLabel(key: string): string {
    if (!key) return '';
    return key.charAt(0).toUpperCase() + key.slice(1);
}

/// Round to at most one decimal, without the trailing `.0` that
/// `toFixed(1)` leaves on every whole number.
function num(n: number): string {
    return String(Math.round(n * 10) / 10);
}

/// The sentence shown on a war's room card. Returns '' when there is nothing
/// worth saying (a preview for a room that is not a war).
export function formatJoinPreview(p: WarJoinPreview): string {
    if (!p.will_fight) {
        // A refusal has to say what would fix it, and the three causes have
        // three different fixes: register a faction, find a war that fields
        // yours, or wait for a seat. Anything vaguer sends a player to look
        // for a button that does not exist.
        switch (p.reason) {
            case 'account has no faction':
                return 'You will watch — this account has no faction.';
            case 'war declares no side for this faction':
                return 'You will watch — your faction fields no side in this war.';
            case 'the faction\'s side is full':
                return `You will watch — your side is full (${p.humans_on_side}/${p.capacity_per_side}).`;
            default:
                return '';
        }
    }

    const side = factionLabel(p.side);
    // "rejoin" vs "fight for" is the difference between a war you are already
    // in and one you are entering, and it is the fact a returning player most
    // wants confirmed before clicking.
    const lead = p.returning
        ? `Rejoin ${side}`
        : `You will fight for ${side}`;
    const seats = p.capacity_per_side > 0
        ? ` (${p.humans_on_side + 1}/${p.capacity_per_side})`
        : '';

    let authority: string;
    switch (p.authority_source) {
        case 'restored_pool':
            authority = `with your ${num(p.authority)} authority restored`;
            break;
        case 'onboarding_stipend':
            // Deliberately says the pool is gone rather than quietly quoting a
            // smaller number: a player who left with 400 and comes back to 100
            // is owed the reason.
            authority = `with a ${num(p.authority)} authority stipend — your old pool has expired`;
            break;
        case 'join_grant':
            authority = `with ${num(p.authority)} authority`;
            break;
        default:
            authority = '';
    }

    return authority ? `${lead}${seats} ${authority}.` : `${lead}${seats}.`;
}
