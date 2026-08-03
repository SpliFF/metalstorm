// Replay driver tests (PLAN-replay.md task 2).
//
// The driver's whole job is ordering: hand back exactly the inputs that were
// due at a given (frame, phase), in the order they were recorded, never twice,
// never dropped. Every one of those adverbs is a divergence if it fails, so
// they are asserted individually rather than through one round-trip test.

#include <doctest/doctest.h>

#include <cstdio>
#include <string>

#include "Server/ReplayFile.h"
#include "Server/ReplayPlayer.h"

using syncedinput::InputKind;
using syncedinput::Record;
using syncedinput::TickPhase;

namespace {

Record Rec(uint64_t seq, int32_t frame, TickPhase phase, InputKind kind) {
    Record r;
    r.seq   = seq;
    r.frame = frame;
    r.phase = phase;
    r.kind  = kind;
    return r;
}

/// Write a stream to a temp file and load a Player from it — the Player's only
/// ingest path is a file, so the tests go through one rather than reaching into
/// its internals.
replay::Player LoadFrom(const std::string& path, const std::vector<Record>& recs,
                        bool clean, int32_t endFrame) {
    {
        replay::Writer w;
        replay::Header h;
        h.gameId = "papertanks";
        h.mapId  = "green_flat_x34_v3";
        std::string err;
        REQUIRE(w.Open(path, h, err));
        for (const Record& r : recs) {
            Record copy = r;
            w.Append(std::move(copy));
        }
        if (clean) {
            replay::Trailer t;
            t.endFrame = endFrame;
            t.recordCount = recs.size();
            w.Close(t);
        }
    }
    replay::Player p;
    std::string err;
    REQUIRE(p.Load(path, err));
    std::remove(path.c_str());
    return p;
}

}  // namespace

TEST_CASE("records are handed back at their recorded frame and phase") {
    replay::Player p = LoadFrom("/tmp/springweb-replay-order.msr", {
        Rec(1, 0,  TickPhase::Inbound,    InputKind::GameStart),
        Rec(2, 30, TickPhase::Inbound,    InputKind::ClientMessage),
        Rec(3, 30, TickPhase::Stream,     InputKind::AICommand),
        Rec(4, 60, TickPhase::LuaExec,    InputKind::LuaExec),
    }, /*clean=*/true, /*endFrame=*/90);

    CHECK(p.RecordCount() == 4);
    CHECK(p.EndFrame() == 90);

    // Frame 0: only the anchor is due.
    auto due = p.Due(0, TickPhase::Inbound);
    REQUIRE(due.size() == 1);
    CHECK(due[0]->kind == InputKind::GameStart);

    // Frame 0's later phases have nothing — and crucially do NOT pull frame
    // 30's records forward.
    CHECK(p.Due(0, TickPhase::Stream).empty());

    // Frame 30, inbound phase: the client message, but not the Stream-phase AI
    // command that belongs later in the same tick.
    due = p.Due(30, TickPhase::Inbound);
    REQUIRE(due.size() == 1);
    CHECK(due[0]->kind == InputKind::ClientMessage);

    due = p.Due(30, TickPhase::Stream);
    REQUIRE(due.size() == 1);
    CHECK(due[0]->kind == InputKind::AICommand);

    CHECK_FALSE(p.Exhausted());
    due = p.Due(60, TickPhase::LuaExec);
    REQUIRE(due.size() == 1);
    CHECK(due[0]->kind == InputKind::LuaExec);
    CHECK(p.Exhausted());
    CHECK(p.Fed() == 4);
    CHECK(p.Late() == 0);
}

TEST_CASE("the whole pre-GameStart prologue is fed on the first tick") {
    // The sim frame does not advance before GameStart, so an unbounded number
    // of inputs share frame 0 and seq order IS their semantics. Feeding them
    // one-per-tick would be wrong in a subtler way than it looks: the recording
    // did not spread them over frames either.
    replay::Player p = LoadFrom("/tmp/springweb-replay-prologue.msr", {
        Rec(1, 0, TickPhase::Inbound, InputKind::ClientMessage),
        Rec(2, 0, TickPhase::Inbound, InputKind::ClientMessage),
        Rec(3, 0, TickPhase::Inbound, InputKind::ClientMessage),
        Rec(4, 0, TickPhase::Inbound, InputKind::GameStart),
    }, true, 0);

    auto due = p.Due(0, TickPhase::Inbound);
    CHECK(due.size() == 4);
    CHECK(due[0]->seq == 1);
    CHECK(due[3]->kind == InputKind::GameStart);
}

TEST_CASE("a record whose frame has already passed is fed late, not dropped") {
    // Dropping it would silently shorten the cause stream — the one thing this
    // subsystem may never do. Feeding it keeps the stream complete, and the
    // late counter is what tells the operator the frame progression diverged.
    replay::Player p = LoadFrom("/tmp/springweb-replay-late.msr", {
        Rec(1, 10, TickPhase::Inbound, InputKind::ClientMessage),
        Rec(2, 20, TickPhase::Inbound, InputKind::ClientMessage),
    }, true, 30);

    auto due = p.Due(25, TickPhase::Inbound);   // both overdue
    CHECK(due.size() == 2);
    CHECK(p.Late() == 2);
    CHECK(p.Exhausted());
}

TEST_CASE("a truncated file ends at its last complete record") {
    replay::Player p = LoadFrom("/tmp/springweb-replay-trunc.msr", {
        Rec(1, 0,  TickPhase::Inbound, InputKind::GameStart),
        Rec(2, 45, TickPhase::Stream,  InputKind::AICommand),
    }, /*clean=*/false, 0);

    CHECK(p.Truncated());
    // No trailer, so the furthest frame the segment is known consistent to is
    // the last record's — not "0" and not "run forever" (§6 E1).
    CHECK(p.EndFrame() == 45);
}

TEST_CASE("fast-forward is on until the seek target is reached") {
    replay::Player p = LoadFrom("/tmp/springweb-replay-seek.msr", {
        Rec(1, 0, TickPhase::Inbound, InputKind::GameStart),
    }, true, 900);

    CHECK_FALSE(p.FastForwarding(0));   // no target set = ordinary playback
    p.SetSeekTarget(600);
    CHECK(p.FastForwarding(0));
    CHECK(p.FastForwarding(599));
    CHECK_FALSE(p.FastForwarding(600));
    CHECK_FALSE(p.FastForwarding(601));
}

TEST_CASE("verification matches, locates the first divergence, and never passes vacuously") {
    replay::Player p = LoadFrom("/tmp/springweb-replay-verify.msr", {
        Rec(1, 0, TickPhase::Inbound, InputKind::GameStart),
    }, true, 900);

    p.SetHashTrack({{300, 0xAAAA}, {600, 0xBBBB}, {900, 0xCCCC}});
    CHECK(p.WantHashAt(300));
    CHECK_FALSE(p.WantHashAt(301));

    CHECK(p.CheckHash(300, 0xAAAA));
    CHECK_FALSE(p.CheckHash(600, 0xDEAD));
    CHECK(p.CheckHash(900, 0xCCCC));   // re-converged, but the verdict stands

    p.FinishVerify(900);
    const auto& v = p.Verify();
    CHECK(v.checked == 3);
    CHECK(v.matched == 2);
    CHECK(v.missing == 0);
    CHECK(v.firstDivergenceFrame == 600);   // FIRST, not last — it is the bisect point
    CHECK(v.expected == 0xBBBB);
    CHECK(v.actual == 0xDEAD);
    CHECK_FALSE(v.Passed());
}

TEST_CASE("a run that ended early fails verification instead of passing on a prefix") {
    // The dangerous shape: every hash the run reached matched, so a naive
    // verifier reports PASS — for a replay that stopped a third of the way in.
    replay::Player p = LoadFrom("/tmp/springweb-replay-short.msr", {
        Rec(1, 0, TickPhase::Inbound, InputKind::GameStart),
    }, true, 900);

    p.SetHashTrack({{300, 0xAAAA}, {600, 0xBBBB}, {900, 0xCCCC}});
    CHECK(p.CheckHash(300, 0xAAAA));
    p.FinishVerify(300);

    const auto& v = p.Verify();
    CHECK(v.checked == 1);
    CHECK(v.matched == 1);
    CHECK(v.missing == 2);
    CHECK_FALSE(v.Passed());
}

TEST_CASE("verification with no reference points does not report success") {
    replay::Player p = LoadFrom("/tmp/springweb-replay-empty.msr", {
        Rec(1, 0, TickPhase::Inbound, InputKind::GameStart),
    }, true, 90);
    p.FinishVerify(90);
    CHECK_FALSE(p.Verify().Passed());
}

TEST_CASE("a stop request latches its first reason") {
    replay::Player p = LoadFrom("/tmp/springweb-replay-stop.msr", {
        Rec(1, 0, TickPhase::Inbound, InputKind::GameStart),
    }, true, 90);

    CHECK_FALSE(p.StopRequested());
    p.RequestStop("snapshot restore");
    p.RequestStop("something later and less useful");
    CHECK(p.StopRequested());
    CHECK(p.StopReason() == "snapshot restore");
}

TEST_CASE("virtual client ids cannot collide with live transport ids") {
    // A replay server serves live spectators while feeding recorded messages
    // from connections that no longer exist. Both id spaces start at 1, so the
    // recorded ones are offset — otherwise a spectator would inherit a
    // recorded player's session.
    CHECK(replay::VirtualClientId(1) != 1u);
    CHECK(replay::IsVirtualClient(replay::VirtualClientId(1)));
    CHECK(replay::IsVirtualClient(replay::VirtualClientId(9999)));
    CHECK_FALSE(replay::IsVirtualClient(1));
    CHECK_FALSE(replay::IsVirtualClient(9999));
    // Distinct recorded connections stay distinct after remapping.
    CHECK(replay::VirtualClientId(1) != replay::VirtualClientId(2));
}

// ─────────────────── task 3: embedded hash track ──────────────────────────

TEST_CASE("a file's own hash track is installed on load") {
    // The point of embedding it: `--verify` needs no second file, and cannot be
    // pointed at the wrong one by accident.
    const std::string path = "/tmp/springweb-replay-player-embedded.msr";
    {
        replay::Writer w;
        replay::Header h;
        h.gameId = "papertanks";
        std::string err;
        REQUIRE(w.Open(path, h, err));
        w.Append(Rec(1, 0, TickPhase::Inbound, InputKind::GameStart));
        w.AppendHashPoint(300, 0xAAAAAAAAAAAAAAAAULL);
        w.AppendHashPoint(600, 0xBBBBBBBBBBBBBBBBULL);
        replay::Trailer t;
        t.endFrame = 600;
        t.recordCount = w.Written();
        w.Close(t);
    }
    replay::Player p;
    std::string err;
    REQUIRE(p.Load(path, err));
    CHECK(p.HasHashTrack());
    CHECK(p.HashTrackSize() == 2);
    CHECK(p.WantHashAt(300));
    CHECK_FALSE(p.WantHashAt(301));
    CHECK(p.CheckHash(300, 0xAAAAAAAAAAAAAAAAULL));
    CHECK_FALSE(p.CheckHash(600, 0xBBBBBBBBBBBBBBBCULL));
    CHECK(p.Verify().firstDivergenceFrame == 600);
    p.FinishVerify(600);
    CHECK_FALSE(p.Verify().Passed());
    std::remove(path.c_str());
}

TEST_CASE("a truncated segment ends at its last hash point, not its last record") {
    // Records are sparse and hash points are on a cadence, so on a killed
    // recording the last hash point is usually the later of the two — and it
    // proves the sim reached that frame. Ending at the last RECORD instead
    // makes an AI-only game (whose sole record is the frame -1 GameStart
    // anchor) claim to end before its first tick, and every embedded reference
    // point is then reported MISSING rather than checked. Seen in the field.
    const std::string path = "/tmp/springweb-replay-player-trunc-hash.msr";
    {
        replay::Writer w;
        replay::Header h;
        std::string err;
        REQUIRE(w.Open(path, h, err));
        w.Append(Rec(1, -1, TickPhase::Inbound, InputKind::GameStart));
        w.AppendHashPoint(150, 0x11);
        w.AppendHashPoint(300, 0x22);
        w.Flush();
        // no Close(): killed mid-recording
    }
    replay::Player p;
    std::string err;
    REQUIRE(p.Load(path, err));
    CHECK(p.Truncated());
    CHECK(p.EndFrame() == 300);
    std::remove(path.c_str());
}
