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
//     and adoption-by-pid at the next startup is the only *lossless* resume
//     that exists before PLAN-persistence lands snapshots.
//  2. **A war whose server did die is not demoted to a lobby room.** The
//     orphan sweep recycles a room to Filling; doing that to a war hands a
//     running world back to its host as a set-up screen.
//  3. **A joiner brings the war back up — but only when nothing else is.**
//     The two decline cases (already live, already starting) are what keeps a
//     single room from binding two ports and splitting its war across two
//     sims.
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

TEST_CASE("war lifecycle: joining a down war resumes it") {
    // Both states a held orphan can be sitting in when someone walks up to it:
    // Active (the lobby died mid-war) and Filling (a war that was recycled by
    // an older build, or one that has never been started).
    CHECK(DecideWarResume(SessionKind::PersistentWar, /*hasLiveServer=*/false,
                          ERoomState::Active) == WarResumeOutcome::Resume);
    CHECK(DecideWarResume(SessionKind::PersistentWar, /*hasLiveServer=*/false,
                          ERoomState::Filling) == WarResumeOutcome::Resume);
    CHECK(DecideWarResume(SessionKind::PersistentWar, /*hasLiveServer=*/false,
                          ERoomState::Ended) == WarResumeOutcome::Resume);
}

TEST_CASE("war lifecycle: a live war is joined, not respawned") {
    CHECK(DecideWarResume(SessionKind::PersistentWar, /*hasLiveServer=*/true,
                          ERoomState::Active) == WarResumeOutcome::AlreadyLive);
    // Liveness outranks state: a room the lobby still calls Loading whose
    // server is up is joined, not restarted.
    CHECK(DecideWarResume(SessionKind::PersistentWar, /*hasLiveServer=*/true,
                          ERoomState::Loading) == WarResumeOutcome::AlreadyLive);
}

TEST_CASE("war lifecycle: a war whose server is still coming up is not respawned") {
    // The window between fork and the server's first `ready=1` publication.
    // Two joiners arriving inside it must not produce two servers for one room
    // — they would bind two ports and split the war across two sims.
    CHECK(DecideWarResume(SessionKind::PersistentWar, /*hasLiveServer=*/false,
                          ERoomState::Loading) == WarResumeOutcome::ComingUp);
}

TEST_CASE("war lifecycle: a skirmish is never started by a joiner") {
    // Every state, including the one where the room is idle and startable: a
    // skirmish is started by its host pressing Start Game, and a joiner
    // walking in is not that.
    for (const auto st : {ERoomState::Configuring, ERoomState::Filling,
                          ERoomState::ReadyCheck, ERoomState::Loading,
                          ERoomState::Active, ERoomState::Ended}) {
        CHECK(DecideWarResume(SessionKind::Skirmish, /*hasLiveServer=*/false, st) ==
              WarResumeOutcome::NotAWar);
    }
}

TEST_CASE("war lifecycle: every outcome names itself for the operator log") {
    // Same rule as DynamicJoin's: a lifecycle decision that leaves no line
    // behind is indistinguishable from the bug it prevents.
    CHECK(std::string(WarResumeOutcomeToString(WarResumeOutcome::NotAWar)) !=
          std::string(WarResumeOutcomeToString(WarResumeOutcome::AlreadyLive)));
    CHECK(std::string(WarResumeOutcomeToString(WarResumeOutcome::ComingUp)) !=
          std::string(WarResumeOutcomeToString(WarResumeOutcome::Resume)));
    for (const auto o : {WarResumeOutcome::NotAWar, WarResumeOutcome::AlreadyLive,
                         WarResumeOutcome::ComingUp, WarResumeOutcome::Resume}) {
        CHECK(std::string(WarResumeOutcomeToString(o)) != std::string("unknown"));
    }
}
