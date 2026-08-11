// room-transition — what a room update means for the screen.
//
// WHY THIS EXISTS (PLAN-endtoend.md D25).
// Entering a game stops the room stream and hides the lobby. Nothing used to
// start that stream again, so once a war finished and the player came back to
// the lobby, the room view was frozen on the state it had at kickoff: it read
// "Loading" for a war that was over and offered a "Rejoin Game" button aimed
// at a port whose subprocess had already exited. Pressing it mounted an empty
// game shell with no widgets and no obvious way out — the last thing that
// happened to a player who had just won.
//
// The decision was three overlapping conditions read inline in
// `updateCurrentRoomFromJson`, which is why "the lobby never restarts the
// stream" and "an update that arrives in the lobby must be allowed to
// re-render" were not visible as separate facts. It is one function here, and
// the table it implies is the test.

/// Which surface currently owns the screen, plus the guards that decide
/// whether an incoming room update may change that.
export interface RoomViewState {
    /// The room id the game surface was last entered for, or null if the
    /// player has never entered this room's game (the double-fire guard).
    gameStartedForRoomId: number | null;
    /// The game canvas + HUD own the screen right now.
    inGame: boolean;
    /// A detached session is parked: the worker is alive, but the player is
    /// deliberately in the lobby. Updates must not drag them back in.
    detached: boolean;
    /// The room id the player has just explicitly asked to (re)join — the war
    /// notice's Rejoin, a war card's Fight/Rejoin, a room-list Join. One-shot:
    /// the caller clears it once the update it belongs to has been decided.
    ///
    /// This is the only thing that distinguishes "the player asked to go back
    /// into this war" from "a poll happened to mention it", and the two need
    /// opposite answers for a persistent war (see below).
    rejoinRequestedRoomId?: number | null;
}

/// `RoomManager::SessionKind` on the wire (PLAN-metalstorm-lobby task 1).
/// Absent on any room a pre-task-1 lobby describes, which is read as a
/// skirmish — the behaviour every room had before wars existed.
export type SessionKind = 'skirmish' | 'persistent';

/// The lobby's room lifecycle, as the server reports it. Named because the
/// numbers are load-bearing in three places and "state >= 5" read as "the
/// game is over" for a year while the lobby actually recycles a finished
/// room to `Filling` (RoomManager::ResetRoomForNextGame).
export const enum RoomState {
    Configuring = 0,
    Filling = 1,
    ReadyCheck = 2,
    Loading = 3,
    Active = 4,
    Ended = 5,
}

export type RoomTransition =
    /// Hide the lobby and mount the game surface for this room.
    | 'enter-game'
    /// The game surface owns the screen; keep `currentRoom` fresh, touch
    /// nothing else.
    | 'stay-in-game'
    /// The lobby owns the screen and the room view is out of date.
    | 'refresh-room'
    /// As `refresh-room`, and the room is no longer running a game: drop the
    /// saved room/port reconnect creds and re-arm the start guard.
    | 'refresh-room-game-gone';

/**
 * Decide what an incoming room update does to the screen.
 *
 * The one rule that is easy to get wrong: a room that is Loading/Active with
 * a live port does NOT mean "put the player in the game". It means that only
 * on the transition — the first update for a room the player has not entered.
 * Afterwards the same update means "the war this player already played is
 * still winding down", and the correct response is to leave them where they
 * are and let the room view follow the server.
 *
 * The exception is a persistent war (PLAN-persistence Q-P3). A skirmish winds
 * down and is played once, so "already entered this room" really does mean
 * "this is the tail of the game I just played". A war is a world that outlives
 * every visit to it: the identical state means "the war I was in an hour ago
 * is up, and I have just asked to go back". So for a war an EXPLICIT rejoin
 * request re-enters — and a passive poll update still does not, or quitting a
 * war to the lobby would be undone by the next broadcast.
 */
export function decideRoomTransition(
    roomId: number,
    state: number,
    gameServerPort: number,
    view: RoomViewState,
    sessionKind?: SessionKind,
): RoomTransition {
    const running = state === RoomState.Loading || state === RoomState.Active;
    if (running && gameServerPort > 0) {
        if (view.detached) return 'refresh-room';
        if (view.inGame) return 'stay-in-game';
        if (view.gameStartedForRoomId !== roomId) return 'enter-game';
        // Q-P3: a second visit to a live war, asked for by the player.
        if (sessionKind === 'persistent' && view.rejoinRequestedRoomId === roomId)
            return 'enter-game';
        // Already played this room's game and came back to the lobby. The
        // subprocess lives ~180 s past a finish (PostGamePolicy), so this is
        // the normal post-victory state, not a stale read.
        return 'refresh-room';
    }
    // Running but no port yet — the room has been told to start and the
    // subprocess has not published its port. Nothing to enter and nothing to
    // clear; the next update carries the port.
    if (running) return 'refresh-room';
    // Not running: either pregame (a finished room is recycled to Filling) or
    // Ended. Either way the saved port is dead and the start guard must
    // re-arm so a *next* game in the same room is entered.
    return 'refresh-room-game-gone';
}
