// room-seat — what to call a player on a room screen (PLAN-persistence Q-P3).
//
// WHY THIS EXISTS. The room screen has always labelled a row off
// `is_spectator`, which is the right answer for a room the lobby is still
// filling: before a game starts, the lobby seats everyone, so "not on a team"
// and "spectator" are the same fact.
//
// On a RUNNING room they are not. `is_spectator` there means "not seated by the
// lobby" — which is true of every human the game server seated itself: every
// dynamic joiner (PLAN-metalstorm-lobby task 2) and every player whose seat was
// restored from their war binding (PLAN-persistence task 4). Task 6 recorded
// exactly this trap for `spectate_only`; the room screen was still reading the
// flag. The visible result was Q-P3's second half: a player who had just been
// resumed into a war, whose own join-preview row says `enlisted: true,
// seat: restored`, was rendered "Spectator" and offered **Enlist**.
//
// The seat source that IS true for a running war is the war's join preview —
// the row the lobby composes out of the same seating functions the game server
// seats with (`POST /api/wars/join-preview`, task 5). It only covers THIS
// account, which is the honest limit of what the lobby knows: nothing publishes
// per-player seats for a running war, so another player's row resolves to
// `unknown` rather than to a label this side cannot support.
//
// Pure. `lobby-ui` renders whatever this returns.

/// The seat facts a preview carries. A subset of `WarJoinPreview` on purpose:
/// this module must not grow a second reason to know about the wire.
export interface SeatPreview {
    /// This account takes a playing seat if it joins now.
    will_fight: boolean;
    /// This account asked to WATCH rather than fight (task 6). A choice, and it
    /// outranks every seating rule.
    watching?: boolean;
    /// This account holds a binding in this war (task 4c) — it is seated even
    /// when a *fresh* join would be declined (a full side turns away a new
    /// volunteer, never the veteran holding the seat).
    enlisted?: boolean;
}

/// `fighter` and `spectator` are claims; `unknown` is the absence of one, and
/// callers must render it as such rather than defaulting it to either.
export type RoomSeat = 'fighter' | 'spectator' | 'unknown';

export interface RoomSeatQuery {
    /// The room is Loading/Active — the game server, not the lobby, owns who
    /// is playing.
    running: boolean;
    /// The room is a persistent war, so a join preview exists for it.
    isWar: boolean;
    /// This row is the viewing account's own.
    mine: boolean;
    /// The room row's `is_spectator` for this player.
    isSpectatorFlag: boolean;
    /// This account's preview for this war, when the lobby published one.
    preview?: SeatPreview;
}

/**
 * Resolve one room-screen row to a seat.
 *
 * The fallbacks are ordered so that every case the old code got right keeps its
 * old answer: a pre-game room and a running skirmish still read the flag, and a
 * war with no preview (an older lobby, or a `join-preview` call that failed —
 * it is explicitly an enrichment) also still reads the flag. Only the case the
 * flag cannot answer changes.
 */
export function resolveRoomSeat(q: RoomSeatQuery): RoomSeat {
    // Pre-game: the lobby did the seating, so its flag is the truth.
    if (!q.running) return q.isSpectatorFlag ? 'spectator' : 'fighter';
    // A running skirmish's roster was fixed at spawn from this same flag, so it
    // is still the best (and only) source there.
    if (!q.isWar) return q.isSpectatorFlag ? 'spectator' : 'fighter';
    // A running war. Only this account has a preview.
    if (!q.mine) return 'unknown';
    if (!q.preview) return q.isSpectatorFlag ? 'spectator' : 'fighter';
    if (q.preview.watching) return 'spectator';
    if (q.preview.will_fight || q.preview.enlisted) return 'fighter';
    // Declined by a seating rule (no faction, no side for it, side full) — the
    // one case where a running war really does seat this account as a watcher.
    return 'spectator';
}

/// The status column's text. `unknown` gets the same em dash a not-ready player
/// gets, because "we cannot say" and "nothing to say" read identically and the
/// alternative is inventing a claim.
///
/// A seated fighter in a running room says so. Readiness is a pre-game fact and
/// a war has no ready check at all, so `'—'` there was the room screen agreeing
/// with the Spectator label that the player holds nothing.
export function roomSeatStatus(seat: RoomSeat, ready: boolean, running: boolean): string {
    if (seat === 'spectator') return 'Spectator';
    if (seat === 'unknown') return '—';
    if (running) return 'Fighting';
    return ready ? '✓ Ready' : '—';
}
