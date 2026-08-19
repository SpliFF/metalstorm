#include <doctest/doctest.h>

#include <sqlite3.h>

#include <string>

#include "Server/GameStateStore.h"
#include "Server/Hibernation.h"
#include "Server/RoomManager.h"
#include "Server/WarResume.h"

// PLAN-persistence task 3b — the LOBBY's half of the hibernation lifecycle.
//
// Task 3a gave the game server two ends (checkpoint out, `--resume` in) and
// left `--hibernate-idle-seconds` OFF, because a war that exits when the last
// player leaves is unjoinable until something respawns it. These tests pin the
// something:
//
//  1. **A war's first launch must not ask to resume.** `DoResume` treats a
//     missing snapshot as FATAL by design, so `--resume` on a war that has
//     never run would abort the process rather than start it. This is the one
//     failure mode that turns 3b into "wars no longer launch at all".
//  2. **A held war is never permanently "coming up".** The superseded
//     `DecideWarResume` gated on `state == Loading`, and `onOrphanedRoom` HOLDS
//     a war in whatever state it died in — so a war whose server died mid-
//     launch answered "already starting" to every join thereafter, forever.
//  3. **Hibernated and crashed are different words.** They are indistinguishable
//     from the pid (gone either way) and from the exit code (a debug build
//     reports 134 for both — task 3a's field note). The store's newest label is
//     the evidence, and the two files have to agree on its spelling.
//  4. **E5's second joiner waits on a named state**, rather than forking a
//     rival sim or getting a bare 200 with nothing to show the player.

namespace {

warresume::WarFacts Live(bool ready) {
    warresume::WarFacts f;
    f.serverProcessAlive = true;
    f.serverReady = ready;
    f.roomState = ready ? ERoomState::Active : ERoomState::Loading;
    return f;
}

warresume::WarFacts Down(ERoomState st, bool hasSnap, bool hibernated,
                         int32_t frame = 4242) {
    warresume::WarFacts f;
    f.roomState = st;
    f.snapshot.has = hasSnap;
    f.snapshot.frame = hasSnap ? frame : -1;
    f.snapshot.label = hasSnap ? (hibernated ? "hibernate:signal" : "gm:manual")
                               : std::string();
    f.snapshot.fromHibernation = hasSnap && hibernated;
    return f;
}

}  // namespace

TEST_CASE("war resume: a war with no history launches WITHOUT --resume") {
    // The fatal case. `--resume` with nothing stored aborts the process, so the
    // very first join of a brand-new war would never produce a server.
    for (const auto st : {ERoomState::Filling, ERoomState::Configuring,
                          ERoomState::Loading, ERoomState::Active}) {
        const auto p = warresume::PlanJoin(SessionKind::PersistentWar,
                                           Down(st, /*hasSnap=*/false, false));
        CHECK(p.action == warresume::WarJoinAction::Spawn);
        CHECK(p.withResume == false);
        CHECK(p.resumeFrame == -1);
    }
}

TEST_CASE("war resume: a frozen war comes back on its stored world") {
    const auto p = warresume::PlanJoin(
        SessionKind::PersistentWar,
        Down(ERoomState::Active, /*hasSnap=*/true, /*hibernated=*/true, 1885));
    CHECK(p.action == warresume::WarJoinAction::Spawn);
    CHECK(p.withResume == true);
    CHECK(p.resumeFrame == 1885);
    CHECK(p.state == warresume::WarState::Hibernated);
    // The frame is in the operator's line, not just in the plan: "resumed" with
    // no frame is the claim task 3a exists to stop anyone from making blindly.
    CHECK(warresume::Describe(p).find("1885") != std::string::npos);
}

TEST_CASE("war resume: a war held in Loading with a dead server IS respawned") {
    // The liveness bug in the superseded policy. A war whose server died while
    // the room was still Loading keeps that state (HoldForResume), so a
    // state-based "already coming up" answer was permanent and no join could
    // ever change it.
    const auto p = warresume::PlanJoin(
        SessionKind::PersistentWar,
        Down(ERoomState::Loading, /*hasSnap=*/true, /*hibernated=*/false));
    CHECK(p.action == warresume::WarJoinAction::Spawn);
    // Crashed, not Hibernated: it was in flight and left no exit checkpoint.
    CHECK(p.state == warresume::WarState::Crashed);
    // Still resumable — an older snapshot beats frame 0 — and the state is what
    // says frames were lost.
    CHECK(p.withResume == true);
}

TEST_CASE("war resume: a live process is joined, never respawned") {
    const auto ready = warresume::PlanJoin(SessionKind::PersistentWar, Live(true));
    CHECK(ready.action == warresume::WarJoinAction::ConnectToLive);
    CHECK(ready.state == warresume::WarState::Live);

    // E5: the second joiner, arriving while the first joiner's respawn is still
    // coming up. One process, and this joiner is told which state it waits on.
    const auto comingUp = warresume::PlanJoin(SessionKind::PersistentWar, Live(false));
    CHECK(comingUp.action == warresume::WarJoinAction::ConnectToLive);
    CHECK(comingUp.state == warresume::WarState::Resuming);
    CHECK(std::string(warresume::ToString(comingUp.state)) == "resuming");
}

TEST_CASE("war resume: a skirmish is never launched by a joiner") {
    for (const auto st : {ERoomState::Configuring, ERoomState::Filling,
                          ERoomState::ReadyCheck, ERoomState::Loading,
                          ERoomState::Active, ERoomState::Ended}) {
        const auto p = warresume::PlanJoin(SessionKind::Skirmish,
                                           Down(st, /*hasSnap=*/true, true));
        CHECK(p.action == warresume::WarJoinAction::None);
        CHECK(p.state == warresume::WarState::NotAWar);
        CHECK(p.withResume == false);
    }
}

TEST_CASE("war resume: hibernated, crashed and fresh are three different cards") {
    const auto kind = SessionKind::PersistentWar;
    // Clean exit: the store's newest row is an exit checkpoint.
    CHECK(warresume::Classify(kind, Down(ERoomState::Active, true, true)) ==
          warresume::WarState::Hibernated);
    // Died in flight with only an older GM checkpoint to its name. Resumable and
    // lossy, and only the lossy half belongs on a card unprompted.
    CHECK(warresume::Classify(kind, Down(ERoomState::Active, true, false)) ==
          warresume::WarState::Crashed);
    // Died in flight with nothing stored at all.
    CHECK(warresume::Classify(kind, Down(ERoomState::Active, false, false)) ==
          warresume::WarState::Crashed);
    // Never ran: no process, no history, never in flight.
    CHECK(warresume::Classify(kind, Down(ERoomState::Filling, false, false)) ==
          warresume::WarState::Fresh);
    // A GM checkpoint on a war that is not in flight is history, not a crash.
    CHECK(warresume::Classify(kind, Down(ERoomState::Filling, true, false)) ==
          warresume::WarState::Hibernated);
}

TEST_CASE("war resume: every state and plan names itself for the log") {
    for (const auto s : {warresume::WarState::NotAWar, warresume::WarState::Live,
                         warresume::WarState::Resuming,
                         warresume::WarState::Hibernated,
                         warresume::WarState::Crashed,
                         warresume::WarState::Fresh}) {
        CHECK(std::string(warresume::ToString(s)) != std::string("unknown"));
    }
    const auto kind = SessionKind::PersistentWar;
    CHECK(warresume::Describe(warresume::PlanJoin(kind, Live(true))) !=
          warresume::Describe(warresume::PlanJoin(kind, Live(false))));
    for (const auto& f : {Live(true), Live(false),
                          Down(ERoomState::Active, true, true),
                          Down(ERoomState::Filling, false, false)}) {
        CHECK(warresume::Describe(warresume::PlanJoin(kind, f)) !=
              std::string("unknown join plan"));
    }
}

TEST_CASE("war resume: the label Hibernation writes is the label WarResume reads") {
    // The two files agree on one string, and nothing in the type system makes
    // them. Every ExitReason that produces a checkpoint must classify as a
    // hibernation here, and a GM label must not.
    for (const auto r : {hibernate::ExitReason::Signal, hibernate::ExitReason::Idle}) {
        hibernate::ExitContext c;
        c.reason = r;
        c.serializerAttached = true;
        c.gameStarted = true;
        const auto d = hibernate::DecideExitCheckpoint(c);
        REQUIRE(d.checkpoint);
        CHECK(warresume::IsHibernationLabel(d.label));
    }
    CHECK_FALSE(warresume::IsHibernationLabel("gm:manual"));
    CHECK_FALSE(warresume::IsHibernationLabel("auto"));
    CHECK_FALSE(warresume::IsHibernationLabel(""));
    // The prefix alone is not a label — a bare "hibernate:" names no reason.
    CHECK_FALSE(warresume::IsHibernationLabel("hibernate:"));
}

TEST_CASE("war resume: LatestSnapshot reads the store the game server wrote") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);

    // Before the table exists at all — a lobby on a database no game server has
    // ever opened. "No history", not an error.
    CHECK(warresume::LatestSnapshot(db, "metalstorm", 77).has == false);

    // The real schema, from its owner. Hand-rolling the DDL here would let this
    // test keep passing after the store's columns moved.
    gamestate::GameStateStore::EnsureTables(db);
    CHECK(warresume::LatestSnapshot(db, "metalstorm", 77).has == false);

    auto insert = [&](const char* game, int room, int frame, const char* label) {
        sqlite3_stmt* st = nullptr;
        REQUIRE(sqlite3_prepare_v2(db,
            "INSERT INTO game_snapshots (game_id, room_id, frame, taken_at,"
            " engine_hash, map_hash, label, raw_size, blob_size, sha256, blob)"
            " VALUES (?, ?, ?, 1700000000, 'e', 'm', ?, 1, 1, 's', x'00')",
            -1, &st, nullptr) == SQLITE_OK);
        sqlite3_bind_text(st, 1, game, -1, SQLITE_TRANSIENT);
        sqlite3_bind_int(st, 2, room);
        sqlite3_bind_int(st, 3, frame);
        sqlite3_bind_text(st, 4, label, -1, SQLITE_TRANSIENT);
        REQUIRE(sqlite3_step(st) == SQLITE_DONE);
        sqlite3_finalize(st);
    };

    insert("metalstorm", 77, 185, "gm:manual");
    insert("metalstorm", 77, 717, "hibernate:signal");
    // Another room, and another game with the SAME room id: a snapshot's
    // partition key is the PAIR, and reading either of these for room 77 would
    // hand a war somebody else's world.
    insert("metalstorm", 78, 999, "hibernate:idle");
    insert("otherGame", 77, 5000, "hibernate:idle");

    const auto s = warresume::LatestSnapshot(db, "metalstorm", 77);
    CHECK(s.has);
    CHECK(s.frame == 717);
    CHECK(s.label == "hibernate:signal");
    CHECK(s.fromHibernation);
    CHECK(s.takenAt == 1700000000);

    // Newest means most recently WRITTEN, not highest frame — the same
    // `ORDER BY id DESC` GameStateStore::NewestFrame uses, so the lobby's card
    // and a `--resume` cannot disagree about which blob will be applied.
    insert("metalstorm", 77, 300, "gm:rollback");
    const auto after = warresume::LatestSnapshot(db, "metalstorm", 77);
    CHECK(after.frame == 300);
    CHECK_FALSE(after.fromHibernation);

    CHECK(warresume::LatestSnapshot(db, "metalstorm", 999).has == false);
    CHECK(warresume::LatestSnapshot(nullptr, "metalstorm", 77).has == false);

    sqlite3_close(db);
}

// ── A war that ENDED is not a war that crashed (wars task 4, D4) ───────────

TEST_CASE("war resume: a finished war is not a crashed war") {
    const auto kind = SessionKind::PersistentWar;
    // The shape of a scheduled `--postgame-exit-seconds` exit: no process, no
    // exit checkpoint (a finished war has nothing to resume, so
    // DecideExitCheckpoint deliberately declines to take one), and a room
    // still in the state it was playing in. That is, byte for byte, the test
    // for `Crashed` — which is how both wars that completed the §7 chain
    // correctly came to tell their players their war "stopped without saving
    // its last stretch".
    auto ended = Down(ERoomState::Active, /*hasSnap=*/false, false);
    CHECK(warresume::Classify(kind, ended) == warresume::WarState::Crashed);
    ended.warEnded = true;
    CHECK(warresume::Classify(kind, ended) == warresume::WarState::Finished);

    // It outranks the other no-process verdicts too: none of their questions
    // apply to a war nobody is going to resume.
    auto withSnap = Down(ERoomState::Active, true, false);
    withSnap.warEnded = true;
    CHECK(warresume::Classify(kind, withSnap) == warresume::WarState::Finished);
    auto hibernated = Down(ERoomState::Active, true, true);
    hibernated.warEnded = true;
    CHECK(warresume::Classify(kind, hibernated) == warresume::WarState::Finished);
    auto upgraded = Down(ERoomState::Active, true, true);
    upgraded.warEnded = true;
    upgraded.snapshot.engineHash = "aaaaaaaaaaaaaaaa";
    upgraded.binary.engineHash = "bbbbbbbbbbbbbbbb";
    CHECK(warresume::Classify(kind, upgraded) == warresume::WarState::Finished);

    // But NOT the live one: a finished war whose server is still serving the
    // result overlay is live, and the post-game timer is what ends that.
    auto serving = Live(true);
    serving.warEnded = true;
    CHECK(warresume::Classify(kind, serving) == warresume::WarState::Live);

    // And a skirmish is still not a war, however its room ended.
    CHECK(warresume::Classify(SessionKind::Skirmish, ended) ==
          warresume::WarState::NotAWar);

    // The new state names itself for the log and the card.
    CHECK(std::string(warresume::ToString(warresume::WarState::Finished)) ==
          std::string("finished"));
}
