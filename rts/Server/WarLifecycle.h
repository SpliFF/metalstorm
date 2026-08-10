// WarLifecycle — what happens to a persistent war when nobody is in it, and
// what happens to it when the lobby that spawned it goes away.
//
// PLAN-metalstorm-lobby.md §5.2/§5.3, task 3. Task 1 let a war start without
// its roster and task 2 let a stranger join one; both make the same new state
// reachable — a war sitting with **zero connected humans**, which for a
// skirmish is the definition of "over" and for a war is just Tuesday.
//
// ── The three end-on-empty surfaces, and which one was actually wrong ──
// A war can be torn down from three places, and only one of them was:
//   1. the room-level abandon (`RoomManager::LeaveRoom` → `Abandoned`) —
//      already gated on `persistent`, and `CreateRoom` enforces
//      PersistentWar ⇒ persistent, so a war returns `StillPersistent`;
//   2. the game server's own idle self-termination — already gated on the
//      session kind (server_main.cpp, task 1);
//   3. **the lobby's clean shutdown, which SIGTERMs every game server it
//      knows about.** That one killed wars, and it is the one path where the
//      process would otherwise have survived intact: the startup adoption
//      pass re-attaches to a live server by pid, so a war whose process is
//      still running comes back *with its sim*, which is the only lossless
//      resume that exists before PLAN-persistence lands snapshots.
//
// Everything here is a pure function of values — the same discipline
// DynamicJoin.h and GameStartCoordinator.h use, so the policy is testable
// without a lobby, a database or a process to kill.
#pragma once

#include <cstdint>

#include "RoomManager.h"   // SessionKind, ERoomState

/// What the lobby does with a game server it owns when the lobby itself is
/// shutting down cleanly.
enum class LobbyExitAction : uint8_t {
    /// SIGTERM it. A skirmish's server exists to host one bounded match for
    /// the people in the room; with the lobby gone there is nothing to rejoin
    /// through and nobody to reap the process later.
    KillServer = 0,
    /// Leave it running. The war outlives this lobby process — the next
    /// lobby's startup adoption pass finds the pid in `game_servers` and
    /// re-attaches to it, sim and all.
    LeaveRunning,
};

/// @param kind            the room's session kind
/// @param killWarsOnExit  operator override (`--kill-wars-on-exit`, env
///                        `SPRING_LOBBY_KILL_WARS_ON_EXIT`). Exists because a
///                        developer restarting the stack in a loop wants the
///                        machine back, and because a test harness that leaves
///                        wars running leaks processes across runs. Default is
///                        off: the safe default for a *war* is to survive.
inline LobbyExitAction ActionOnLobbyExit(SessionKind kind, bool killWarsOnExit) {
    if (kind == SessionKind::PersistentWar && !killWarsOnExit)
        return LobbyExitAction::LeaveRunning;
    return LobbyExitAction::KillServer;
}

/// What to do with a room whose game server is gone (dead pid at startup, or
/// an exit observed by the health-check loop).
enum class OrphanedRoomAction : uint8_t {
    /// Recycle it: back to Filling, ready flags cleared, port zeroed. Correct
    /// for a skirmish — the match is over and the room's next act is another
    /// Start Game.
    RecycleToFilling = 0,
    /// Keep the war as a war. Resetting it to Filling would demote a running
    /// world into a lobby room waiting to be re-hosted: the host would have to
    /// press Start Game for a war that is supposed to already exist, and every
    /// player who walked up to it in between would find a set-up screen.
    /// The room keeps its state and is resumed on the next join.
    HoldForResume,
};

inline OrphanedRoomAction ActionForOrphanedRoom(SessionKind kind) {
    return kind == SessionKind::PersistentWar ? OrphanedRoomAction::HoldForResume
                                              : OrphanedRoomAction::RecycleToFilling;
}

/// Why a join did or did not bring a war's game server back up.
enum class WarResumeOutcome : uint8_t {
    /// Not a persistent war — a skirmish is started by its host, never by a
    /// joiner walking in.
    NotAWar = 0,
    /// A server is already running for this room; the joiner connects to it.
    AlreadyLive,
    /// A spawn is already in flight (the room is Loading and its server has
    /// not published ready yet). Spawning a second one would bind a second
    /// port for the same room and split the war between two sims.
    ComingUp,
    /// Bring the war back up, then let the joiner in.
    Resume,
};

inline const char* WarResumeOutcomeToString(WarResumeOutcome o) {
    switch (o) {
        case WarResumeOutcome::NotAWar:     return "not a persistent war";
        case WarResumeOutcome::AlreadyLive: return "war already live";
        case WarResumeOutcome::ComingUp:    return "war server already starting";
        case WarResumeOutcome::Resume:      return "resuming the war";
    }
    return "unknown";
}

/// Decide whether joining this room should relaunch its game server.
///
/// @param kind           the room's session kind
/// @param hasLiveServer  a game server process for this room is alive *now*
///                       (checked by pid, not by the `game_servers` row —
///                       a stale row is exactly the case this exists for)
/// @param state          the room's state
///
/// ⚠ A resumed war restarts its **sim** from frame 0: nothing snapshots the
/// world yet (PLAN-persistence owns that, and creg is stubbed out — see
/// PLAN-metalstorm-lobby.md §5.4). Resume here means "the war is there when
/// you walk up to it", not "the war is where you left it". The lossless case
/// is the one above — a war whose process never died.
inline WarResumeOutcome DecideWarResume(SessionKind kind, bool hasLiveServer,
                                        ERoomState state) {
    if (kind != SessionKind::PersistentWar)
        return WarResumeOutcome::NotAWar;
    if (hasLiveServer)
        return WarResumeOutcome::AlreadyLive;
    if (state == ERoomState::Loading)
        return WarResumeOutcome::ComingUp;
    return WarResumeOutcome::Resume;
}
