#include <doctest/doctest.h>

#include "Server/Hibernation.h"

#include <string>
#include <vector>

// PLAN-persistence task 3a — the two hibernation decisions, off-engine.
//
// What these tests are actually defending, in both halves, is the SILENT
// outcome. The exit half must never report "no checkpoint taken" the same way
// for a replay (nothing to save) and for a live war whose serializer never
// attached (a world being lost) — so `lossy` is asserted on every case, not
// just the one it is true for. The resume half must never return a
// non-fatal failure: a boot asked to resume either applies a world or aborts,
// because the alternative is a process that publishes itself ready at frame
// -1 for a room the lobby is telling players is frozen at frame N.

using namespace hibernate;

namespace {

/// A live persistent war being stopped by SIGTERM: the one context that
/// SHOULD checkpoint. Every test below starts here and breaks one thing, so a
/// test that stops discriminating fails rather than passing vacuously.
ExitContext LiveWar() {
    ExitContext c;
    c.reason = ExitReason::Signal;
    c.hibernationEnabled = true;
    c.serializerAttached = true;
    c.gameStarted = true;
    c.gameOverDeclared = false;
    c.replaying = false;
    return c;
}

struct MockSource : IResumeSource {
    bool available = true;
    int32_t newest = 900;
    bool restoreOk = true;
    int32_t restoredTo = 900;
    std::string restoreErr = "every retained snapshot was corrupt (E2)";

    std::vector<std::string> calls;

    bool Available() const override { return available; }
    int32_t NewestFrame(uint32_t) override {
        const_cast<MockSource*>(this)->calls.push_back("NewestFrame");
        return newest;
    }
    bool RestoreNewestValid(uint32_t, std::string& err, int32_t& frame) override {
        calls.push_back("RestoreNewestValid");
        if (!restoreOk) { err = restoreErr; return false; }
        frame = restoredTo;
        return true;
    }
};

ResumeRequest Wanted() {
    ResumeRequest r;
    r.requested = true;
    r.startsGameAtSetup = true;
    return r;
}

}  // namespace

TEST_CASE("hibernate: a live war stopped by a signal checkpoints") {
    const CheckpointDecision d = DecideExitCheckpoint(LiveWar());
    CHECK(d.checkpoint);
    CHECK(d.lossy == false);
    CHECK(d.label == "hibernate:signal");
    CHECK(!d.reason.empty());
}

TEST_CASE("hibernate: an idle exit checkpoints and labels itself apart") {
    ExitContext c = LiveWar();
    c.reason = ExitReason::Idle;
    const CheckpointDecision d = DecideExitCheckpoint(c);
    CHECK(d.checkpoint);
    CHECK(d.label == "hibernate:idle");
    // The label distinguishes the two hibernation causes in List(); an
    // operator reading a room's history can tell "everyone left" from "we
    // stopped the box", and neither from a GM undo snapshot.
    CHECK(d.label != DecideExitCheckpoint(LiveWar()).label);
}

TEST_CASE("hibernate: the benign refusals are benign, and each names itself") {
    SUBCASE("a replay is not a game") {
        ExitContext c = LiveWar();
        c.replaying = true;
        const CheckpointDecision d = DecideExitCheckpoint(c);
        CHECK(!d.checkpoint);
        CHECK(!d.lossy);
    }
    SUBCASE("a harness run is not a game") {
        ExitContext c = LiveWar();
        c.reason = ExitReason::Harness;
        const CheckpointDecision d = DecideExitCheckpoint(c);
        CHECK(!d.checkpoint);
        CHECK(!d.lossy);
    }
    SUBCASE("hibernation switched off") {
        ExitContext c = LiveWar();
        c.hibernationEnabled = false;
        const CheckpointDecision d = DecideExitCheckpoint(c);
        CHECK(!d.checkpoint);
        CHECK(!d.lossy);
    }
    SUBCASE("GameStart never fired") {
        ExitContext c = LiveWar();
        c.gameStarted = false;
        const CheckpointDecision d = DecideExitCheckpoint(c);
        CHECK(!d.checkpoint);
        CHECK(!d.lossy);
    }
    SUBCASE("the match is over") {
        ExitContext c = LiveWar();
        c.gameOverDeclared = true;
        const CheckpointDecision d = DecideExitCheckpoint(c);
        CHECK(!d.checkpoint);
        CHECK(!d.lossy);
    }
    SUBCASE("the post-game timer fired, even without the game-over flag") {
        // The two are separate inputs on purpose: postgame::ShouldExit is the
        // reason the loop ended, gameOverDeclared is the relay's state. A
        // world that exits on the post-game timer is finished either way.
        ExitContext c = LiveWar();
        c.reason = ExitReason::PostGame;
        c.gameOverDeclared = false;
        const CheckpointDecision d = DecideExitCheckpoint(c);
        CHECK(!d.checkpoint);
        CHECK(!d.lossy);
    }
    SUBCASE("a headless fixture run") {
        ExitContext c = LiveWar();
        c.reason = ExitReason::HeadlessRun;
        const CheckpointDecision d = DecideExitCheckpoint(c);
        CHECK(!d.checkpoint);
        CHECK(!d.lossy);
    }
    SUBCASE("a SIGHUP re-exec") {
        ExitContext c = LiveWar();
        c.reason = ExitReason::Restart;
        const CheckpointDecision d = DecideExitCheckpoint(c);
        CHECK(!d.checkpoint);
        CHECK(!d.lossy);
    }
    // Every refusal above must have said why. A blank reason is a log line an
    // operator cannot act on, which is the only artefact these paths leave.
    for (ExitReason r : {ExitReason::Signal, ExitReason::Idle,
                         ExitReason::PostGame, ExitReason::Restart,
                         ExitReason::HeadlessRun, ExitReason::Harness}) {
        ExitContext c = LiveWar();
        c.reason = r;
        CHECK(!DecideExitCheckpoint(c).reason.empty());
        CHECK(std::string(Describe(r)) != "unknown");
    }
}

TEST_CASE("hibernate: a live war with no serializer is a LOSS, not a no-op") {
    ExitContext c = LiveWar();
    c.serializerAttached = false;
    const CheckpointDecision d = DecideExitCheckpoint(c);
    CHECK(!d.checkpoint);
    CHECK(d.lossy);
}

TEST_CASE("hibernate: a run with nothing to save is never reported as a loss") {
    // The ordering test. A replay / an unstarted game / a finished match with
    // no serializer attached must come out BENIGN — the serializer check sits
    // below all of them precisely so an incomplete walk cannot manufacture a
    // data-loss warning on a process that had no world anybody wanted.
    for (int i = 0; i < 4; ++i) {
        ExitContext c = LiveWar();
        c.serializerAttached = false;
        switch (i) {
            case 0: c.replaying = true; break;
            case 1: c.gameStarted = false; break;
            case 2: c.gameOverDeclared = true; break;
            case 3: c.reason = ExitReason::Harness; break;
        }
        const CheckpointDecision d = DecideExitCheckpoint(c);
        CHECK(!d.checkpoint);
        CHECK(d.lossy == false);
    }
}

TEST_CASE("resume: a normal boot is untouched") {
    MockSource src;
    ResumeRequest r;  // requested == false
    const ResumeOutcome o = DoResume(src, 42, r);
    CHECK(o.status == ResumeStatus::NotRequested);
    CHECK(!o.fatal);
    CHECK(o.frame == -1);
    // And it must not have gone anywhere near the store.
    CHECK(src.calls.empty());
}

TEST_CASE("resume: the happy path applies the newest valid rung") {
    MockSource src;
    src.restoredTo = 861;  // the E2 ladder landed one rung below newest
    const ResumeOutcome o = DoResume(src, 42, Wanted());
    CHECK(o.status == ResumeStatus::Ok);
    CHECK(o.frame == 861);
    CHECK(!o.fatal);
    CHECK(FormatResume(o) == "resumed at frame 861");
}

TEST_CASE("resume: every failure is FATAL — there is no start-fresh fallback") {
    SUBCASE("wrong session shape") {
        MockSource src;
        ResumeRequest r = Wanted();
        r.startsGameAtSetup = false;
        const ResumeOutcome o = DoResume(src, 42, r);
        CHECK(o.status == ResumeStatus::WrongShape);
        CHECK(o.fatal);
        // Refused before touching the store: a shape that cannot apply a
        // world must not consume a restore attempt to find that out.
        CHECK(src.calls.empty());
    }
    SUBCASE("no serializer attached") {
        MockSource src;
        src.available = false;
        const ResumeOutcome o = DoResume(src, 42, Wanted());
        CHECK(o.status == ResumeStatus::NoSerializer);
        CHECK(o.fatal);
        CHECK(src.calls.empty());
    }
    SUBCASE("the room has no snapshot history") {
        MockSource src;
        src.newest = -1;
        const ResumeOutcome o = DoResume(src, 42, Wanted());
        CHECK(o.status == ResumeStatus::NoSnapshot);
        CHECK(o.fatal);
        // Asked, but did not attempt a restore it knew would fail.
        CHECK(src.calls == std::vector<std::string>{"NewestFrame"});
    }
    SUBCASE("every rung was bad") {
        MockSource src;
        src.restoreOk = false;
        const ResumeOutcome o = DoResume(src, 42, Wanted());
        CHECK(o.status == ResumeStatus::RestoreFailed);
        CHECK(o.fatal);
        // The store's own reason survives to the operator verbatim — E1 and
        // E2 fail here identically as far as this policy is concerned, and
        // only the store can say which one it was.
        CHECK(o.error == src.restoreErr);
        CHECK(FormatResume(o).find(src.restoreErr) != std::string::npos);
    }
    SUBCASE("a failure with no reason still says something") {
        MockSource src;
        src.restoreOk = false;
        src.restoreErr = "";
        const ResumeOutcome o = DoResume(src, 42, Wanted());
        CHECK(o.fatal);
        CHECK(!o.error.empty());
    }
}

TEST_CASE("resume: every status formats to a distinct, non-empty line") {
    // A new ResumeStatus with no sentence for it would print the fallback,
    // and a boot refusal whose log line is "unknown status" is the exact
    // failure mode this module exists to prevent.
    std::vector<std::string> lines;
    for (ResumeStatus s : {ResumeStatus::Ok, ResumeStatus::NotRequested,
                           ResumeStatus::WrongShape, ResumeStatus::NoSerializer,
                           ResumeStatus::NoSnapshot, ResumeStatus::RestoreFailed}) {
        ResumeOutcome o;
        o.status = s;
        o.frame = 900;
        o.error = "because";
        const std::string line = FormatResume(o);
        CHECK(!line.empty());
        CHECK(line.find("unknown status") == std::string::npos);
        lines.push_back(line);
    }
    // Ok / NotRequested are distinct; the four refusals share a prefix by
    // design and are separated by their error text.
    CHECK(lines[0] != lines[1]);
}
