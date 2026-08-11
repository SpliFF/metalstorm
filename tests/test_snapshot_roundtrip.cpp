#include <doctest/doctest.h>

#include "Server/SnapshotRoundTrip.h"

#include <string>
#include <vector>

// PLAN-persistence §8 — the driver behind `--snapshot-roundtrip`. The
// comparison itself has to run on a populated sim (a map, a def handler, real
// units, live gadgets), which no doctest can stand up; what CAN be tested off
// the engine is everything around it, and that is what these cases pin:
//
//   * the state machine walks arm A, restores, walks arm B and stops — and it
//     counts SIM TICKS, not loop iterations, so the server loop spinning
//     between ticks cannot shorten an arm;
//   * every way the comparison can fail to be honest is a FAILURE, not a
//     silent pass: a divergent hash, a payload that differs where the hash
//     agrees, a non-idempotent re-capture, a restore that did not rewind the
//     frame, a run that ended before it compared anything;
//   * the spec parser refuses frame 0, which would compare two empty
//     pre-GameStart worlds and pass.
//
// The engine-coupled half is one block in server_main.cpp: it performs the
// capture/restore this controller asks for and feeds back a frame, a hash and
// a payload.

using namespace snapshotrt;

namespace {

// The bytes a fixture "serializer" hands back. Content is irrelevant to the
// controller — only equality is.
std::vector<uint8_t> blob(uint8_t tag, size_t n = 8)
{
    return std::vector<uint8_t>(n, tag);
}

// Drive a whole run with a scripted world: `hashAt(frame, arm)` decides what
// the sim hashes to, so a divergence can be injected at a chosen tick.
struct Fixture {
    Controller c;
    std::vector<uint8_t> checkpoint = blob(0xA1);
    std::vector<uint8_t> recapture = blob(0xA1);   // idempotent by default
    std::vector<uint8_t> terminalA = blob(0xB2, 16);
    std::vector<uint8_t> terminalB = blob(0xB2, 16);
    int64_t restoreFrame = -1;   // -1 = "wherever the checkpoint was taken"
    int64_t divergeAtTick = -1;  // 1-based tick index within the arm
    bool inArmB = false;

    explicit Fixture(int64_t atFrame, int64_t ticks)
    {
        Config cfg;
        cfg.enabled = true;
        cfg.atFrame = atFrame;
        cfg.ticks = ticks;
        c.Configure(cfg);
    }

    // One server-loop pass at `frame`, mirroring server_main's block exactly.
    void Pass(int64_t frame)
    {
        const Step s = c.OnFrame(frame);
        if (s.capture)
            c.SetCheckpoint(checkpoint);
        if (s.record) {
            const int64_t tick = frame - c.StartFrame();
            uint64_t h = 0x1000 + static_cast<uint64_t>(tick);
            if (inArmB && tick == divergeAtTick)
                h ^= 0xDEADull;
            c.RecordHash(h);
        }
        if (s.captureTerminal)
            c.SetTerminalPayload(inArmB ? terminalB : terminalA);
        if (s.restore) {
            inArmB = true;
            const int64_t f = (restoreFrame >= 0) ? restoreFrame : c.StartFrame();
            c.OnRestored(f, recapture);
        }
    }

    // Run to completion (or until the controller gives up), with the frame
    // rewind the restore performs.
    void RunAll(int64_t upTo)
    {
        for (int64_t f = 1;
             f <= upTo && !inArmB && c.CurrentPhase() != Phase::Done; ++f)
            Pass(f);
        if (c.CurrentPhase() == Phase::Done) return;
        // arm B replays the same frame numbers
        for (int64_t f = c.StartFrame() + 1;
             c.CurrentPhase() != Phase::Done && f <= c.StartFrame() + c.Cfg().ticks;
             ++f)
            Pass(f);
    }
};

}  // namespace

// ───────────────────────────── spec parsing ─────────────────────────────

TEST_CASE("ParseSpec: frame alone defaults to the §8 tick count") {
    Config cfg;
    std::string err;
    REQUIRE(ParseSpec("600", cfg, err));
    CHECK(cfg.enabled);
    CHECK(cfg.atFrame == 600);
    CHECK(cfg.ticks == 100);
    CHECK(err.empty());
}

TEST_CASE("ParseSpec: frame:ticks") {
    Config cfg;
    std::string err;
    REQUIRE(ParseSpec("1200:250", cfg, err));
    CHECK(cfg.atFrame == 1200);
    CHECK(cfg.ticks == 250);
}

TEST_CASE("ParseSpec: frame 0 is refused (the comparison would be vacuous)") {
    // Frame 0 is before GameStart: no units, no gadget state. A round-trip
    // there compares two empty worlds and passes, which is the one result this
    // test must never be able to produce.
    Config cfg;
    std::string err;
    CHECK_FALSE(ParseSpec("0", cfg, err));
    CHECK_FALSE(err.empty());
    CHECK_FALSE(cfg.enabled);
}

TEST_CASE("ParseSpec: malformed specs are refused, not coerced") {
    Config cfg;
    std::string err;
    CHECK_FALSE(ParseSpec("", cfg, err));
    CHECK_FALSE(ParseSpec("abc", cfg, err));
    CHECK_FALSE(ParseSpec("600:", cfg, err));
    CHECK_FALSE(ParseSpec("600:0", cfg, err));
    CHECK_FALSE(ParseSpec("600:xyz", cfg, err));
    CHECK_FALSE(ParseSpec("-5", cfg, err));       // '-' is not a digit
    CHECK_FALSE(ParseSpec("600:99999999", cfg, err));  // past the ceiling
}

// ───────────────────────────── the happy path ─────────────────────────────

TEST_CASE("a clean round-trip passes and reports both arms") {
    Fixture f(10, 5);
    f.RunAll(20);

    REQUIRE(f.c.CurrentPhase() == Phase::Done);
    const Result& r = f.c.Result_();
    CHECK(r.ran);
    CHECK(r.pass);
    CHECK(r.failure.empty());
    CHECK(r.startFrame == 10);
    CHECK(r.endFrame == 15);
    CHECK(r.hashesCompared == 5);
    CHECK(r.firstDivergentFrame == -1);
    CHECK(r.restoreRecaptureIdentical);
    CHECK(r.terminalPayloadIdentical);
    CHECK(r.terminalBytes == 16);
    CHECK(r.checkpointBytes == 8);
    CHECK(f.c.FormatVerdict().find("PASS") != std::string::npos);
}

TEST_CASE("the checkpoint is taken at the first frame at or past the spec") {
    // The sim does not necessarily present the exact frame asked for (a
    // headless run under load skips ticks), so the checkpoint lands on the
    // first frame that reaches it — and every later expectation is relative to
    // THAT frame, not to the spec.
    Fixture f(10, 3);
    f.Pass(8);
    CHECK(f.c.CurrentPhase() == Phase::Idle);
    f.Pass(12);
    CHECK(f.c.CurrentPhase() == Phase::ArmA);
    CHECK(f.c.StartFrame() == 12);
    f.Pass(13); f.Pass(14); f.Pass(15);
    CHECK(f.c.CurrentPhase() == Phase::ArmB);
    f.Pass(13); f.Pass(14); f.Pass(15);
    REQUIRE(f.c.CurrentPhase() == Phase::Done);
    CHECK(f.c.Result_().pass);
    CHECK(f.c.Result_().startFrame == 12);
}

TEST_CASE("loop passes that do not advance the frame are not ticks") {
    // The server loop iterates faster than it ticks. Counting passes rather
    // than frames would fill an arm with duplicate hashes of the same world —
    // which agree — and the comparison would pass without simulating anything.
    Fixture f(2, 3);
    f.Pass(2);
    for (int i = 0; i < 5; ++i) f.Pass(2);   // spinning, no tick
    CHECK(f.c.CurrentPhase() == Phase::ArmA);
    f.Pass(3);
    for (int i = 0; i < 5; ++i) f.Pass(3);
    f.Pass(4); f.Pass(5);
    CHECK(f.c.CurrentPhase() == Phase::ArmB);
    f.Pass(3); f.Pass(4); f.Pass(5);
    REQUIRE(f.c.CurrentPhase() == Phase::Done);
    CHECK(f.c.Result_().pass);
    CHECK(f.c.Result_().hashesCompared == 3);
}

// ───────────────────────────── the failure modes ─────────────────────────────

TEST_CASE("a divergent hash FAILS and names the frame it diverged at") {
    Fixture f(10, 5);
    f.divergeAtTick = 3;
    f.RunAll(20);

    REQUIRE(f.c.CurrentPhase() == Phase::Done);
    const Result& r = f.c.Result_();
    CHECK(r.ran);
    CHECK_FALSE(r.pass);
    CHECK(r.firstDivergentFrame == 13);      // startFrame 10 + tick 3
    CHECK(r.expected != r.actual);
    CHECK(r.failure.find("diverged at frame 13") != std::string::npos);
    CHECK(f.c.FormatVerdict().find("FAILED") != std::string::npos);
}

TEST_CASE("terminal payloads that differ FAIL even when every hash agreed") {
    // This is the case the narrow hash exists to be backstopped on: it folds
    // unit id/team/pos/health and the RNG, so a team's resources, a command
    // queue, a stockpile or a gadget's Lua table can all drift with the hash
    // track dead flat.
    Fixture f(10, 5);
    f.terminalB = blob(0xB2, 16);
    f.terminalB[9] = 0xFF;
    f.RunAll(20);

    const Result& r = f.c.Result_();
    CHECK(r.ran);
    CHECK_FALSE(r.pass);
    CHECK(r.firstDivergentFrame == -1);       // the hashes agreed
    CHECK_FALSE(r.terminalPayloadIdentical);
    CHECK(r.firstDifferentByte == 9);
    CHECK(r.failure.find("terminal payloads differ") != std::string::npos);
}

TEST_CASE("a non-idempotent re-capture FAILS on its own") {
    // capture → apply → capture must reproduce the same bytes. If it does not,
    // the walk drops or re-derives something at apply time — a capture bug the
    // ticks that follow can easily be blind to.
    Fixture f(10, 5);
    f.recapture = blob(0xC3);
    f.RunAll(20);

    const Result& r = f.c.Result_();
    CHECK(r.ran);
    CHECK_FALSE(r.pass);
    CHECK(r.firstDivergentFrame == -1);
    CHECK_FALSE(r.restoreRecaptureIdentical);
    CHECK(r.failure.find("re-captured") != std::string::npos);
}

TEST_CASE("a restore that does not rewind the frame FAILS immediately") {
    // The frame counter is captured state (the `globals` section). If it did
    // not come back, the restore did not restore, and arm B would otherwise be
    // walked over frames arm A never visited.
    Fixture f(10, 5);
    f.restoreFrame = 15;   // the world stayed where arm A left it
    f.RunAll(20);

    REQUIRE(f.c.CurrentPhase() == Phase::Done);
    const Result& r = f.c.Result_();
    CHECK_FALSE(r.ran);        // nothing was compared
    CHECK_FALSE(r.pass);
    CHECK(r.failure.find("frame 15") != std::string::npos);
}

TEST_CASE("a skipped tick FAILS rather than comparing misaligned arms") {
    Fixture f(10, 5);
    f.Pass(10);
    f.Pass(11);
    f.Pass(13);   // frame 12 never arrived
    REQUIRE(f.c.CurrentPhase() == Phase::Done);
    CHECK_FALSE(f.c.Result_().ran);
    CHECK(f.c.Result_().failure.find("expected frame 12") != std::string::npos);
}

TEST_CASE("a run that ends before the comparison reports INCOMPLETE, not success") {
    // The wall ceiling, a game-over, a signal. `ran` is what separates
    // "compared and agreed" from "never got that far"; a bare pass flag would
    // read the second as the first.
    Fixture f(1000, 5);
    for (int64_t i = 1; i <= 20; ++i) f.Pass(i);
    CHECK(f.c.CurrentPhase() == Phase::Idle);
    CHECK_FALSE(f.c.Result_().ran);
    CHECK_FALSE(f.c.Result_().pass);
    CHECK(f.c.FormatVerdict().find("INCOMPLETE") != std::string::npos);

    Fixture g(2, 5);
    g.Pass(2); g.Pass(3);        // died mid-arm-A
    CHECK(g.c.CurrentPhase() == Phase::ArmA);
    CHECK(g.c.FormatVerdict().find("INCOMPLETE") != std::string::npos);
}

TEST_CASE("an engine-side refusal is terminal and keeps its reason") {
    // What server_main calls when the serializer refuses a capture or a
    // restore fails: the run stops and says so, rather than comparing tracks
    // it has no reason to trust.
    Fixture f(10, 5);
    f.Pass(10);
    f.c.Fail("the serializer refused the checkpoint: synced Lua coverage incomplete");
    CHECK(f.c.CurrentPhase() == Phase::Done);
    CHECK_FALSE(f.c.Result_().ran);
    CHECK(f.c.Result_().failure.find("coverage incomplete") != std::string::npos);
    // Further frames are inert — a controller that kept walking after a
    // failure would overwrite the reason with a later, less useful one.
    const Step s = f.c.OnFrame(11);
    CHECK_FALSE(s.record);
    CHECK(f.c.Result_().failure.find("coverage incomplete") != std::string::npos);
}

TEST_CASE("a disabled controller is completely inert") {
    Controller c;
    CHECK_FALSE(c.Enabled());
    for (int64_t f = 1; f <= 50; ++f) {
        const Step s = c.OnFrame(f);
        CHECK_FALSE(s.capture);
        CHECK_FALSE(s.record);
        CHECK_FALSE(s.restore);
        CHECK_FALSE(s.finish);
    }
    CHECK(c.CurrentPhase() == Phase::Idle);
    CHECK_FALSE(c.Result_().ran);
}
