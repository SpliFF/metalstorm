#include <doctest/doctest.h>

#include <sqlite3.h>

#include <string>
#include <vector>

#include "Server/DeployDrain.h"
#include "Server/EngineIdentity.h"
#include "Server/GameStateStore.h"
#include "Server/RoomManager.h"
#include "Server/WarResume.h"

// PLAN-persistence task 3c — the deploy drain, and the post-upgrade refusal it
// exists to make a POLICY rather than a side effect.
//
// §8 asks for exactly one integration test here: "deploy drain across 3
// concurrent games (all refuse resume post-upgrade with the E1 reason — the
// policy test)". These are that test, split into the two halves that can be
// pinned without three processes:
//
//  1. **The drain classifies its own exits.** A war that exits leaving a FRESH
//     exit checkpoint kept its world; one that exits without moving the store's
//     newest row lost it — and an old checkpoint still lying there is exactly
//     the trap, because the row is present either way. A SIGKILLed process is
//     never clean, whatever appeared in the store.
//  2. **A world this binary may not load must never be passed `--resume`.**
//     Before 3c the join saw a row, passed the flag, and the server aborted on
//     E1 (by design — `DoResume` is fatal, because coming up empty while
//     publishing `game_status.ready` is worse). `PlanJoin` gates on a LIVE PID,
//     so the next join planned the identical spawn: a post-upgrade war was
//     unjoinable forever, one aborted process per attempt, with nothing in the
//     lobby able to say why. The three neutralisations at the end of this file
//     are the ones that must fail.
//
// The engine hash the policy compares is a build-stamp hash, so "post-upgrade"
// and "after any rebuild" are the same event here — which is why the pre-flight
// has to be a decision with a sentence attached rather than a crash.

namespace {

deploydrain::DrainTarget War(uint32_t room, int pid, bool alive = true) {
    deploydrain::DrainTarget t;
    t.roomId = room;
    t.pid = pid;
    t.kind = SessionKind::PersistentWar;
    t.alive = alive;
    return t;
}

deploydrain::DrainTarget Skirmish(uint32_t room, int pid, bool alive = true) {
    deploydrain::DrainTarget t;
    t.roomId = room;
    t.pid = pid;
    t.kind = SessionKind::Skirmish;
    t.alive = alive;
    return t;
}

warresume::SnapshotFacts Snap(int32_t frame, const char* label, int64_t takenAt,
                              const char* engine = "aaaaaaaaaaaaaaaa",
                              const char* map = "meridian_basin") {
    warresume::SnapshotFacts s;
    s.has = true;
    s.frame = frame;
    s.label = label;
    s.takenAt = takenAt;
    s.engineHash = engine;
    s.mapHash = map;
    s.fromHibernation = warresume::IsHibernationLabel(label);
    return s;
}

}  // namespace

TEST_CASE("drain: every live server is signalled, war or skirmish") {
    // The design call, pinned. `ActionOnLobbyExit` deliberately LEAVES a war
    // running when the lobby stops — correct there, and exactly wrong for a
    // deploy, where the binary that process is executing is about to be
    // replaced under it. A drain that inherited that rule would look like it
    // worked and would leave every war on the old engine.
    CHECK(deploydrain::DecideDrainAction(War(1, 4242)) ==
          deploydrain::DrainAction::Signal);
    CHECK(deploydrain::DecideDrainAction(Skirmish(2, 4243)) ==
          deploydrain::DrainAction::Signal);
    // A replay server is a process running the old binary too.
    auto replay = War(3, 4244);
    replay.isReplay = true;
    CHECK(deploydrain::DecideDrainAction(replay) ==
          deploydrain::DrainAction::Signal);
    // Nothing to signal.
    CHECK(deploydrain::DecideDrainAction(War(4, 4245, /*alive=*/false)) ==
          deploydrain::DrainAction::None);
    CHECK(deploydrain::DecideDrainAction(War(5, 0)) ==
          deploydrain::DrainAction::None);
}

TEST_CASE("drain: a FRESH exit checkpoint is what proves the world survived") {
    const auto before = Snap(300, "hibernate:idle", 1700000000);

    // Exited having written a newer exit checkpoint.
    CHECK(deploydrain::ClassifyDrainExit(
              /*exited=*/true, /*escalated=*/false, before,
              Snap(902, "hibernate:signal", 1700000600)) ==
          deploydrain::DrainOutcome::Checkpointed);

    // Exited and the store's newest row never moved. The row IS present — this
    // is the trap the freshness check exists for, and a `.has` test would call
    // this a clean drain.
    CHECK(deploydrain::ClassifyDrainExit(true, false, before, before) ==
          deploydrain::DrainOutcome::ExitedWithoutCheckpoint);

    // Same frame, same second, but a different reason: a real second write.
    CHECK(deploydrain::ClassifyDrainExit(
              true, false, before, Snap(300, "hibernate:signal", 1700000000)) ==
          deploydrain::DrainOutcome::Checkpointed);

    // A war with no history at all that checkpoints on the way out.
    CHECK(deploydrain::ClassifyDrainExit(true, false, warresume::SnapshotFacts{},
                                         Snap(60, "hibernate:signal", 1700000001)) ==
          deploydrain::DrainOutcome::Checkpointed);

    // A GM checkpoint written by something else during the drain is not an exit
    // checkpoint and must not be read as one.
    CHECK(deploydrain::ClassifyDrainExit(true, false, before,
                                         Snap(950, "gm:manual", 1700000600)) ==
          deploydrain::DrainOutcome::ExitedWithoutCheckpoint);

    // SIGKILLed: never clean, even if a row appeared from the SIGTERM it sat on.
    CHECK(deploydrain::ClassifyDrainExit(true, /*escalated=*/true, before,
                                         Snap(902, "hibernate:signal", 1700000600)) ==
          deploydrain::DrainOutcome::KilledAfterTimeout);

    // Never went away.
    CHECK(deploydrain::ClassifyDrainExit(false, false, before, before) ==
          deploydrain::DrainOutcome::StillAlive);
}

TEST_CASE("drain: loss is a property of what the process was FOR") {
    const auto none = warresume::SnapshotFacts{};

    // A war that exits with nothing new: its world is gone.
    const auto lostWar = deploydrain::BuildResult(War(1, 10), true, false, 120,
                                                  none, none);
    CHECK(lostWar.outcome == deploydrain::DrainOutcome::ExitedWithoutCheckpoint);
    CHECK(lostWar.lossy);
    CHECK(deploydrain::Describe(lostWar).find("WORLD IS LOST") != std::string::npos);

    // A skirmish is one bounded match nobody resumes. Same outcome, not a loss.
    const auto skirmish = deploydrain::BuildResult(Skirmish(2, 11), true, false,
                                                   80, none, none);
    CHECK(skirmish.outcome == deploydrain::DrainOutcome::ExitedWithoutCheckpoint);
    CHECK_FALSE(skirmish.lossy);
    CHECK(deploydrain::Describe(skirmish).find("nothing to save") !=
          std::string::npos);

    // A replay room is replaying a recording that is still on disk.
    auto replayTarget = War(3, 12);
    replayTarget.isReplay = true;
    const auto replay =
        deploydrain::BuildResult(replayTarget, true, false, 40, none, none);
    CHECK_FALSE(replay.lossy);

    // A war that checkpointed reports the frame it froze at, from the store.
    const auto kept = deploydrain::BuildResult(
        War(4, 13), true, false, 310, Snap(300, "hibernate:idle", 1700000000),
        Snap(1204, "hibernate:signal", 1700000600));
    CHECK(kept.outcome == deploydrain::DrainOutcome::Checkpointed);
    CHECK(kept.frame == 1204);
    CHECK(kept.label == "hibernate:signal");
    CHECK_FALSE(kept.lossy);
    CHECK(deploydrain::Describe(kept).find("1204") != std::string::npos);

    // A war that would not die is lossy AND blocks the deploy.
    const auto stuck =
        deploydrain::BuildResult(War(5, 14), false, false, 10000, none, none);
    CHECK(stuck.outcome == deploydrain::DrainOutcome::StillAlive);
    CHECK(stuck.lossy);

    // No live process: not a loss, not a signal, not counted.
    const auto absent = deploydrain::BuildResult(War(6, 15, /*alive=*/false),
                                                 false, false, 0, none, none);
    CHECK(absent.outcome == deploydrain::DrainOutcome::NotRunning);
    CHECK_FALSE(absent.lossy);
}

TEST_CASE("drain: the summary is what gates the deploy — three concurrent games") {
    // §8's shape: three servers drained at once, with the three outcomes that
    // decide whether it is safe to replace the binary.
    const auto none = warresume::SnapshotFacts{};
    std::vector<deploydrain::DrainResult> rs;
    rs.push_back(deploydrain::BuildResult(
        War(1, 100), true, false, 250, Snap(300, "hibernate:idle", 1700000000),
        Snap(902, "hibernate:signal", 1700000600)));
    rs.push_back(deploydrain::BuildResult(War(2, 101), true, false, 400, none,
                                          none));  // lossy
    rs.push_back(deploydrain::BuildResult(Skirmish(3, 102), true, true, 10000,
                                          none, none));  // SIGKILLed
    rs.push_back(deploydrain::BuildResult(War(4, 103, /*alive=*/false), false,
                                          false, 0, none, none));  // not running

    const auto s = deploydrain::Summarise(rs);
    CHECK(s.servers == 3);  // the dead one is not a server that was drained
    CHECK(s.checkpointed == 1);
    CHECK(s.lossy == 1);
    CHECK(s.killed == 1);
    CHECK(s.stillAlive == 0);
    CHECK(s.drained);  // everything really did stop

    // Anything still running makes the machine undrained, whatever else is true.
    rs.push_back(deploydrain::BuildResult(Skirmish(5, 104), false, false, 10000,
                                          none, none));
    const auto s2 = deploydrain::Summarise(rs);
    CHECK_FALSE(s2.drained);
    CHECK(s2.stillAlive == 1);
    CHECK(deploydrain::Describe(s2).find("do not replace the binary") !=
          std::string::npos);
    CHECK(deploydrain::Describe(s2).find("WORLD(S) LOST") != std::string::npos);

    CHECK(deploydrain::Describe(deploydrain::Summarise({})).find(
              "already drained") != std::string::npos);
}

TEST_CASE("drain: every outcome names itself for the report") {
    for (const auto o : {deploydrain::DrainOutcome::NotRunning,
                         deploydrain::DrainOutcome::Checkpointed,
                         deploydrain::DrainOutcome::ExitedWithoutCheckpoint,
                         deploydrain::DrainOutcome::KilledAfterTimeout,
                         deploydrain::DrainOutcome::StillAlive}) {
        CHECK(std::string(deploydrain::ToString(o)) != std::string("unknown"));
    }
}

// ───────────────────────── the E1 policy (§2 / §8) ─────────────────────────

TEST_CASE("E1 policy: a snapshot from another build is NOT resumed") {
    warresume::BinaryIdentity cur;
    cur.engineHash = "bbbbbbbbbbbbbbbb";
    cur.mapHash = "meridian_basin";

    const auto v = warresume::DecideResumeEligibility(
        Snap(302, "hibernate:idle", 1700000000, "aaaaaaaaaaaaaaaa"), cur);
    CHECK(v.eligibility == warresume::ResumeEligibility::EngineChanged);
    CHECK(warresume::RefusesResume(v.eligibility));
    // The reason names both hashes and the frame being dropped — this string is
    // the whole difference between a policy and an aborting process.
    CHECK(v.reason.find("302") != std::string::npos);
    CHECK(v.reason.find("aaaaaaaaaaaaaaaa") != std::string::npos);
    CHECK(v.reason.find("bbbbbbbbbbbbbbbb") != std::string::npos);
    CHECK(v.reason.find("E1") != std::string::npos);

    // Same build: resumable.
    const auto ok = warresume::DecideResumeEligibility(
        Snap(302, "hibernate:idle", 1700000000, "bbbbbbbbbbbbbbbb"), cur);
    CHECK(ok.eligibility == warresume::ResumeEligibility::Resumable);
    CHECK_FALSE(warresume::RefusesResume(ok.eligibility));
}

TEST_CASE("E1 policy: a re-pointed map is refused, and engine outranks map") {
    warresume::BinaryIdentity cur;
    cur.engineHash = "aaaaaaaaaaaaaaaa";
    cur.mapHash = "skerry_reach";

    const auto mapOnly = warresume::DecideResumeEligibility(
        Snap(500, "hibernate:signal", 1700000000, "aaaaaaaaaaaaaaaa",
             "meridian_basin"),
        cur);
    CHECK(mapOnly.eligibility == warresume::ResumeEligibility::MapChanged);
    CHECK(mapOnly.reason.find("meridian_basin") != std::string::npos);
    CHECK(mapOnly.reason.find("skerry_reach") != std::string::npos);

    // Both wrong → the engine is the one reported: an upgraded binary cannot
    // load the blob at all, so the map question is moot.
    warresume::BinaryIdentity other = cur;
    other.engineHash = "cccccccccccccccc";
    CHECK(warresume::DecideResumeEligibility(
              Snap(500, "hibernate:signal", 1700000000, "aaaaaaaaaaaaaaaa",
                   "meridian_basin"),
              other)
              .eligibility == warresume::ResumeEligibility::EngineChanged);
}

TEST_CASE("E1 policy: an un-probed binary ABSTAINS rather than refusing") {
    // The failure mode of failing closed: a probe that could not run would look
    // exactly like an engine upgrade and would reset a live campaign to frame 0
    // on every join. The pre-flight is an optimisation over the game server's
    // own E1 check, never a second authority.
    const auto snap = Snap(700, "hibernate:idle", 1700000000, "aaaaaaaaaaaaaaaa");
    warresume::BinaryIdentity unprobed;  // engineHash empty
    unprobed.mapHash = "meridian_basin";
    const auto v = warresume::DecideResumeEligibility(snap, unprobed);
    CHECK(v.eligibility == warresume::ResumeEligibility::UnknownBinary);
    CHECK_FALSE(warresume::RefusesResume(v.eligibility));

    // A pre-3c snapshot row (no stamp read back) abstains for the same reason.
    auto unstamped = snap;
    unstamped.engineHash.clear();
    warresume::BinaryIdentity known;
    known.engineHash = "bbbbbbbbbbbbbbbb";
    CHECK(warresume::DecideResumeEligibility(unstamped, known).eligibility ==
          warresume::ResumeEligibility::UnknownBinary);

    // And an unknown MAP hash on either side is not a mismatch — only two
    // present, different values are.
    auto noMap = snap;
    noMap.mapHash.clear();
    warresume::BinaryIdentity sameEngine;
    sameEngine.engineHash = "aaaaaaaaaaaaaaaa";
    sameEngine.mapHash = "skerry_reach";
    CHECK(warresume::DecideResumeEligibility(noMap, sameEngine).eligibility ==
          warresume::ResumeEligibility::Resumable);

    // Nothing stored: NoHistory, which is not a refusal either (it is a war's
    // first launch, and `--resume` on it would abort the process).
    CHECK(warresume::DecideResumeEligibility(warresume::SnapshotFacts{}, known)
              .eligibility == warresume::ResumeEligibility::NoHistory);
    CHECK_FALSE(warresume::RefusesResume(warresume::ResumeEligibility::NoHistory));
}

TEST_CASE("E1 policy: the join plan drops --resume and says which frame it lost") {
    warresume::WarFacts f;
    f.roomState = ERoomState::Active;
    f.snapshot = Snap(302, "hibernate:idle", 1700000000, "aaaaaaaaaaaaaaaa");
    f.binary.engineHash = "bbbbbbbbbbbbbbbb";
    f.binary.mapHash = "meridian_basin";

    const auto p = warresume::PlanJoin(SessionKind::PersistentWar, f);
    // Still joinable — the war comes back, at frame 0.
    CHECK(p.action == warresume::WarJoinAction::Spawn);
    CHECK_FALSE(p.withResume);
    // -1, not 302: no caller can print a promise out of a loss.
    CHECK(p.resumeFrame == -1);
    CHECK(p.lostFrame == 302);
    CHECK(p.state == warresume::WarState::Unresumable);
    CHECK(std::string(warresume::ToString(p.state)) == "unresumable");
    CHECK(p.eligibility == warresume::ResumeEligibility::EngineChanged);
    const std::string line = warresume::Describe(p);
    CHECK(line.find("NOT resuming") != std::string::npos);
    CHECK(line.find("302") != std::string::npos);

    // Unresumable outranks Crashed: a war that died in flight AND was then
    // rebuilt past its own snapshots is not "missing the frames since the last
    // checkpoint", it is going back to frame 0 — and that is what the next
    // joiner needs to be told.
    auto crashedAndUpgraded = f;
    crashedAndUpgraded.snapshot = Snap(302, "gm:manual", 1700000000,
                                       "aaaaaaaaaaaaaaaa");
    CHECK(warresume::Classify(SessionKind::PersistentWar, crashedAndUpgraded) ==
          warresume::WarState::Unresumable);

    // A live process still short-circuits everything: E1 is about what a SPAWN
    // may load, and there is no spawn here.
    auto live = f;
    live.serverProcessAlive = true;
    live.serverReady = true;
    const auto lp = warresume::PlanJoin(SessionKind::PersistentWar, live);
    CHECK(lp.action == warresume::WarJoinAction::ConnectToLive);
    CHECK(lp.state == warresume::WarState::Live);
    CHECK(lp.blockedReason.empty());
}

TEST_CASE("E1 policy: the stamp the lobby compares is the one the store writes") {
    // The comparison is a string compare against `game_snapshots.engine_hash`,
    // so the width and case of the hex are load-bearing. Written by the store's
    // own INSERT path here, read back by the lobby's own SELECT, and compared
    // against the shared recipe — the three cannot drift apart silently.
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);

    const uint64_t h = engineid::StampHash("abc1234-20260812010203");
    const std::string hex = engineid::HashHex(h);
    CHECK(hex.size() == 16);
    // Pinned against an INDEPENDENT computation of FNV-1a over that exact
    // stamp (a five-line Python loop), not against what this build printed —
    // otherwise the pin only says the function is deterministic.
    CHECK(hex == "3b841d7d964b34f9");

    gamestate::StoreConfig cfg;
    cfg.gameId = "metalstorm";
    cfg.engineHash = h;
    cfg.mapHash = "meridian_basin";
    gamestate::GameStateStore store(db, cfg);
    struct Ser : gamestate::ISimSerializer {
        bool Serialize(std::vector<uint8_t>& out, std::string&) override {
            out.assign(64, 0x5a);
            return true;
        }
        bool Deserialize(const uint8_t*, size_t, std::string&) override { return true; }
        uint64_t LayoutHash() const override { return 7; }
        int32_t Frame() const override { return 302; }
    } ser;
    store.SetSerializer(&ser);
    std::string err;
    REQUIRE(store.Checkpoint(4, "hibernate:idle", err) == 302);

    const auto snap = warresume::LatestSnapshot(db, "metalstorm", 4);
    REQUIRE(snap.has);
    CHECK(snap.engineHash == hex);
    CHECK(snap.mapHash == "meridian_basin");

    // Same binary → resumable. One rebuild later → refused, with the reason.
    warresume::BinaryIdentity same{hex, "meridian_basin"};
    CHECK(warresume::DecideResumeEligibility(snap, same).eligibility ==
          warresume::ResumeEligibility::Resumable);
    warresume::BinaryIdentity rebuilt{
        engineid::HashHex(engineid::StampHash("abc1234-20260812010204")),
        "meridian_basin"};
    CHECK(rebuilt.engineHash != same.engineHash);  // one second is a new engine
    CHECK(warresume::DecideResumeEligibility(snap, rebuilt).eligibility ==
          warresume::ResumeEligibility::EngineChanged);

    sqlite3_close(db);
}

TEST_CASE("drain: the engine-hash probe accepts only an answer") {
    CHECK(deploydrain::ParseEngineHashOutput("3f2e6ee9c3b90dc1\n") ==
          "3f2e6ee9c3b90dc1");
    CHECK(deploydrain::ParseEngineHashOutput("  3f2e6ee9c3b90dc1  \n") ==
          "3f2e6ee9c3b90dc1");
    // Everything an OLD binary might do instead. Each must read as "cannot
    // pre-check" — if any of them parsed, a probe failure would masquerade as a
    // hash and refuse every resume in the deployment.
    CHECK(deploydrain::ParseEngineHashOutput("").empty());
    CHECK(deploydrain::ParseEngineHashOutput("\n").empty());
    CHECK(deploydrain::ParseEngineHashOutput("unknown option\n").empty());
    CHECK(deploydrain::ParseEngineHashOutput("3f2e6ee9c3b90dc\n").empty());   // 15
    CHECK(deploydrain::ParseEngineHashOutput("3f2e6ee9c3b90dc12\n").empty()); // 17
    CHECK(deploydrain::ParseEngineHashOutput("3F2E6EE9C3B90DC1\n").empty());  // case
    CHECK(deploydrain::ParseEngineHashOutput("0x2e6ee9c3b90dc1\n").empty());
    CHECK(deploydrain::ParseEngineHashOutput(
              "[notice] starting\n3f2e6ee9c3b90dc1\n").empty());
    std::string err;
    CHECK(deploydrain::ProbeServerEngineHash("", err).empty());
    CHECK_FALSE(err.empty());
}
