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
//      still running comes back *with its sim*.
//      (When this was written that was the ONLY lossless resume there was. It
//      is no longer: PLAN-persistence task 3a/3b give a war an exit checkpoint
//      and a `--resume` boot, so a war whose process really did die comes back
//      at the frame it froze at. Leaving a live process alone is still
//      preferred — it is free and exact — but it is no longer the only option,
//      and `warresume::PlanJoin` owns the other one.)
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

// ─── Resume-on-join moved out (PLAN-persistence task 3b, 2026-08-12) ───
//
// `WarResumeOutcome` / `DecideWarResume` used to live here. They are SUPERSEDED
// by `warresume::PlanJoin` (rts/Server/WarResume.h) and were deleted rather
// than deprecated in place: a join now has to decide whether to pass `--resume`
// as well as whether to spawn, and that needs the snapshot store, which this
// header deliberately cannot see. Two policies for one decision is the failure
// mode this lane keeps finding.
//
// The old `ComingUp` outcome also carried a liveness bug worth remembering
// here, next to `HoldForResume` which is what made it reachable: it gated on
// `state == Loading`, and a HELD war keeps the state it died in — so a war
// whose server died mid-launch read as "already coming up" to every subsequent
// join, forever, with nothing coming up. `PlanJoin` gates on a live pid.
