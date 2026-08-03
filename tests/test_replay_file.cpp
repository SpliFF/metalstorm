// Replay container tests (PLAN-replay.md task 2).
//
// What is actually under test here is the claim a replay file makes about
// itself: that a stream written by the recording funnel comes back byte-for-
// byte, and that a file whose recorder DIED mid-write is distinguishable from
// one that ended. The second half is the one that matters in the field — a
// crashed game server is the normal way a replay file ends, and a reader that
// cannot tell "the game ended here" from "the recording stopped here" turns
// every crash into a mystery about the game instead of about the crash.

#include <doctest/doctest.h>

#include <cstdio>
#include <string>

#include <unistd.h>

#include "Server/ReplayFile.h"

using syncedinput::InputKind;
using syncedinput::Record;
using syncedinput::TickPhase;

namespace {

std::string TempPath(const char* name) {
    return std::string("/tmp/springweb-replay-test-") + name + ".msr";
}

replay::Header SampleHeader() {
    replay::Header h;
    h.engineHash   = "proto1-testing";
    h.gameId       = "papertanks";
    h.gameVersion  = "1.0";
    h.mapId        = "green_flat_x34_v3";
    h.defsCacheKey = "deadbeefcafe";
    h.roomId       = 17;
    h.startFrame   = 0;
    h.seed         = 0x0123456789abcdefULL;
    h.recordedAt   = "2026-08-03T00:00:00Z";
    h.modOptions.emplace_back("ffa", "1");
    h.modOptions.emplace_back("commshare", "0");
    h.players.push_back({"alice", 0, 2});
    h.aiSlots.push_back({"basic_ai", 1, 3});
    return h;
}

Record MakeRecord(uint64_t seq, int32_t frame, TickPhase phase, InputKind kind,
                  const std::string& payload) {
    Record r;
    r.seq      = seq;
    r.frame    = frame;
    r.phase    = phase;
    r.kind     = kind;
    r.subKind  = 9;
    r.playerId = 3;
    r.clientId = 42;
    r.payload.assign(payload.begin(), payload.end());
    return r;
}

}  // namespace

TEST_CASE("header round-trips every launch-spec field") {
    const replay::Header in = SampleHeader();
    replay::Header out;
    std::string err;
    REQUIRE(replay::DecodeHeaderJson(replay::EncodeHeaderJson(in), out, err));

    CHECK(out.engineHash == in.engineHash);
    CHECK(out.gameId == in.gameId);
    CHECK(out.gameVersion == in.gameVersion);
    CHECK(out.mapId == in.mapId);
    CHECK(out.defsCacheKey == in.defsCacheKey);
    CHECK(out.roomId == in.roomId);
    CHECK(out.seed == in.seed);
    // The whole point of carrying these is that `--replay <file>` needs no
    // other argument — a dropped modoption or AI slot is a silently different
    // world, not a cosmetic loss.
    REQUIRE(out.modOptions.size() == 2);
    CHECK(out.modOptions[0].first == "ffa");
    CHECK(out.modOptions[1].second == "0");
    REQUIRE(out.players.size() == 1);
    CHECK(out.players[0].username == "alice");
    CHECK(out.players[0].startPos == 2);
    REQUIRE(out.aiSlots.size() == 1);
    CHECK(out.aiSlots[0].aiId == "basic_ai");
    CHECK(out.aiSlots[0].team == 1);
}

TEST_CASE("a record survives encode/decode with every field intact") {
    const Record in = MakeRecord(7, 300, TickPhase::LuaExec, InputKind::LuaExec,
                                 std::string("LuaRules\0Spring.Echo('hi')", 25));
    std::vector<uint8_t> buf;
    replay::EncodeRecord(in, buf);

    size_t off = 0;
    Record out;
    REQUIRE(replay::DecodeRecord(buf, off, out));
    CHECK(off == buf.size());
    CHECK(out.seq == in.seq);
    CHECK(out.frame == in.frame);
    CHECK(out.phase == in.phase);
    CHECK(out.kind == in.kind);
    CHECK(out.subKind == in.subKind);
    CHECK(out.playerId == in.playerId);
    CHECK(out.clientId == in.clientId);
    CHECK(out.payload == in.payload);
    // Embedded NULs are not a hypothetical: RecordLuaExec's payload is
    // "<scope>\0<code>" by construction.
    CHECK(out.payload.size() == 25);
}

TEST_CASE("a short buffer decodes as failure without consuming input") {
    std::vector<uint8_t> buf;
    replay::EncodeRecord(MakeRecord(1, 0, TickPhase::Inbound,
                                    InputKind::ClientMessage, "abcdef"), buf);
    buf.resize(buf.size() - 3);   // torn tail, mid-payload

    size_t off = 0;
    Record out;
    CHECK_FALSE(replay::DecodeRecord(buf, off, out));
    CHECK(off == 0);   // caller can trust its cursor after a failed decode
}

TEST_CASE("a cleanly closed file round-trips and reports its end frame") {
    const std::string path = TempPath("clean");
    replay::Header h = SampleHeader();

    {
        replay::Writer w;
        std::string err;
        REQUIRE(w.Open(path, h, err));
        w.Append(MakeRecord(1, 0, TickPhase::Inbound, InputKind::GameStart, "t0:a0:l0;"));
        w.Append(MakeRecord(2, 30, TickPhase::Stream, InputKind::AICommand, "\x01\x02"));
        w.Append(MakeRecord(3, 90, TickPhase::LuaExec, InputKind::LuaExec, "s\0c"));
        w.Flush();
        replay::Trailer t;
        t.endFrame = 120;
        t.recordCount = w.Written();
        w.Close(t);
        CHECK_FALSE(w.Failed());
    }

    const replay::LoadResult res = replay::Load(path);
    REQUIRE(res.ok);
    CHECK_FALSE(res.truncated);
    CHECK(res.trailer.endFrame == 120);
    CHECK(res.trailer.recordCount == 3);
    REQUIRE(res.records.size() == 3);
    CHECK(res.records[0].kind == InputKind::GameStart);
    CHECK(res.records[1].frame == 30);
    CHECK(res.records[2].phase == TickPhase::LuaExec);
    CHECK(res.header.mapId == h.mapId);

    std::remove(path.c_str());
}

TEST_CASE("a file with no trailer loads as a truncated segment, not an error") {
    // §6 E1: the recorder died between its last flush and a clean close. Every
    // complete record it managed to write is still a valid prefix of a real
    // game and must be replayable; what must NOT happen is the reader calling
    // it clean and the operator wondering why the game "ended" at frame 90.
    const std::string path = TempPath("truncated");
    {
        replay::Writer w;
        std::string err;
        REQUIRE(w.Open(path, SampleHeader(), err));
        w.Append(MakeRecord(1, 0, TickPhase::Inbound, InputKind::GameStart, "t0:a0:l0;"));
        w.Append(MakeRecord(2, 90, TickPhase::Stream, InputKind::AICommand, "xy"));
        w.Flush();
        // No Close(): the destructor closes the FILE* without a trailer, which
        // is exactly what a killed process leaves behind.
    }

    const replay::LoadResult res = replay::Load(path);
    REQUIRE(res.ok);
    CHECK(res.truncated);
    CHECK(res.records.size() == 2);
    CHECK(res.trailer.endFrame == -1);

    std::remove(path.c_str());
}

TEST_CASE("a half-written trailing record is dropped and the rest kept") {
    const std::string path = TempPath("torn");
    {
        replay::Writer w;
        std::string err;
        REQUIRE(w.Open(path, SampleHeader(), err));
        w.Append(MakeRecord(1, 0, TickPhase::Inbound, InputKind::GameStart, "t0:a0:l0;"));
        w.Append(MakeRecord(2, 60, TickPhase::Stream, InputKind::AICommand,
                            "a long-enough payload to truncate into"));
        w.Flush();
    }
    // Chop the tail: the last record is now unreadable.
    {
        std::FILE* f = std::fopen(path.c_str(), "rb");
        REQUIRE(f != nullptr);
        std::fseek(f, 0, SEEK_END);
        const long size = std::ftell(f);
        std::fclose(f);
        REQUIRE(size > 20);
        CHECK(::truncate(path.c_str(), size - 12) == 0);
    }

    const replay::LoadResult res = replay::Load(path);
    REQUIRE(res.ok);
    CHECK(res.truncated);
    CHECK(res.records.size() == 1);         // the complete one survives
    CHECK(res.records[0].kind == InputKind::GameStart);

    std::remove(path.c_str());
}

TEST_CASE("a non-replay file is refused rather than misparsed") {
    const std::string path = TempPath("garbage");
    {
        std::FILE* f = std::fopen(path.c_str(), "wb");
        REQUIRE(f != nullptr);
        const char junk[] = "this is not a replay, it is a shopping list";
        std::fwrite(junk, 1, sizeof(junk), f);
        std::fclose(f);
    }
    const replay::LoadResult res = replay::Load(path);
    CHECK_FALSE(res.ok);
    CHECK(res.error.find("bad magic") != std::string::npos);
    std::remove(path.c_str());
}

TEST_CASE("a missing file is an error, never an empty replay") {
    const replay::LoadResult res = replay::Load("/tmp/springweb-no-such-replay.msr");
    CHECK_FALSE(res.ok);
    CHECK(res.records.empty());
}
