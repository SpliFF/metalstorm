#include <doctest/doctest.h>

#include "Server/RoomManager.h"
#include "Server/WarLifecycle.h"

// PLAN-metalstorm-lobby.md §5.2/§5.3, task 3 — persistent-war lifecycle.
//
// Tasks 1 and 2 made one new state reachable: a war sitting with **zero
// connected humans**. For a skirmish that state means the match is over and
// every teardown path in the stack is written for it. For a war it is the
// normal condition between sessions, and the teardown paths must not fire.
//
// What these tests pin down:
//
//  1. **A war survives the lobby that spawned it.** The lobby's clean
//     shutdown SIGTERMs every game server it owns; for a war that is the one
//     teardown path where the process would otherwise have survived intact,
//     and adoption-by-pid at the next startup keeps the sim exactly as it was.
//     (No longer the ONLY lossless resume — task 3a/3b give a dead war an exit
//     checkpoint and a `--resume` boot — but still the free one.)
//  2. **A war whose server did die is not demoted to a lobby room.** The
//     orphan sweep recycles a room to Filling; doing that to a war hands a
//     running world back to its host as a set-up screen.
//  3. **A joiner brings the war back up — but only when nothing else is.**
//     Moved to test_war_resume.cpp with the policy itself (PLAN-persistence
//     task 3b): the decision now also has to choose whether the respawn carries
//     the stored world, which needs the snapshot store this header cannot see.
//
// Values only, no lobby and no processes: the policy is a pure function, which
// is the whole reason it lives in a header rather than inside the route.

TEST_CASE("war lifecycle: a persistent war outlives its lobby") {
    CHECK(ActionOnLobbyExit(SessionKind::PersistentWar, /*killWarsOnExit=*/false) ==
          LobbyExitAction::LeaveRunning);
}

TEST_CASE("war lifecycle: a skirmish server is killed with its lobby") {
    // Nothing to rejoin through and nobody left to reap the process.
    CHECK(ActionOnLobbyExit(SessionKind::Skirmish, /*killWarsOnExit=*/false) ==
          LobbyExitAction::KillServer);
}

TEST_CASE("war lifecycle: the operator override kills wars too") {
    // A developer restarting the stack in a loop wants the machine back, and a
    // harness that leaves wars running leaks processes across runs.
    CHECK(ActionOnLobbyExit(SessionKind::PersistentWar, /*killWarsOnExit=*/true) ==
          LobbyExitAction::KillServer);
    CHECK(ActionOnLobbyExit(SessionKind::Skirmish, /*killWarsOnExit=*/true) ==
          LobbyExitAction::KillServer);
}

TEST_CASE("war lifecycle: an orphaned war is held, an orphaned skirmish recycled") {
    CHECK(ActionForOrphanedRoom(SessionKind::PersistentWar) ==
          OrphanedRoomAction::HoldForResume);
    CHECK(ActionForOrphanedRoom(SessionKind::Skirmish) ==
          OrphanedRoomAction::RecycleToFilling);
}
