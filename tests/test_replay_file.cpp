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

// ─────────────────── task 3: hash track / index / packer ──────────────────

TEST_CASE("the state-hash track round-trips and the trailer counts it") {
    // §4: the hash track IS the verification reference. If the container can
    // lose a point, `--verify` silently checks fewer frames than it claims to,
    // which is the "degrades from proof to usually works" failure the plan
    // names by hand.
    const std::string path = TempPath("hashtrack");
    {
        replay::Writer w;
        std::string err;
        REQUIRE(w.Open(path, SampleHeader(), err));
        w.Append(MakeRecord(1, 0, TickPhase::Inbound, InputKind::GameStart, "t0:a0:l0;"));
        w.AppendHashPoint(300, 0xfeedfacecafebeefULL);
        w.Append(MakeRecord(2, 310, TickPhase::Stream, InputKind::AICommand, "z"));
        w.AppendHashPoint(600, 0x0000000000000001ULL);
        w.AppendHashPoint(900, 0xffffffffffffffffULL);
        CHECK(w.HashPointsWritten() == 3);
        replay::Trailer t;
        t.endFrame = 900;
        t.recordCount = w.Written();
        w.Close(t);
        CHECK_FALSE(w.Failed());
    }

    const replay::LoadResult res = replay::Load(path);
    REQUIRE(res.ok);
    CHECK_FALSE(res.truncated);
    CHECK(res.records.size() == 2);
    REQUIRE(res.hashTrack.size() == 3);
    CHECK(res.hashTrack[0].frame == 300);
    CHECK(res.hashTrack[0].hash == 0xfeedfacecafebeefULL);
    // The full 64-bit range must survive: a hash truncated to 53 bits (the
    // JSON-number trap docs/debugging-tools.md warns about for the stats dump)
    // would still "match" often enough to look fine.
    CHECK(res.hashTrack[2].hash == 0xffffffffffffffffULL);
    // Close() states what was written, not what the caller hoped.
    CHECK(res.trailer.hashPointCount == 3);
    CHECK(res.trailer.checkpointCount == 0);

    std::remove(path.c_str());
}

TEST_CASE("hash points and records interleave without confusing the reader") {
    // The recorder writes both as they happen, so the file is interleaved; the
    // packer writes them in sections. Both must read identically.
    const std::string path = TempPath("interleaved");
    {
        replay::Writer w;
        std::string err;
        REQUIRE(w.Open(path, SampleHeader(), err));
        for (int i = 1; i <= 5; ++i) {
            w.Append(MakeRecord(static_cast<uint64_t>(i), i * 100,
                                TickPhase::Inbound, InputKind::ClientMessage, "m"));
            w.AppendHashPoint(i * 100, static_cast<uint64_t>(i) * 0x1111111111111111ULL);
        }
        replay::Trailer t;
        t.endFrame = 500;
        t.recordCount = w.Written();
        w.Close(t);
    }
    const replay::LoadResult res = replay::Load(path);
    REQUIRE(res.ok);
    CHECK(res.records.size() == 5);
    REQUIRE(res.hashTrack.size() == 5);
    CHECK(res.hashTrack[4].frame == 500);
    std::remove(path.c_str());
}

TEST_CASE("the checkpoint index and start checkpoint carry opaque blobs") {
    // Nothing writes these yet (PLAN-persistence's sim serializer is unbuilt),
    // so this is the format's own proof that it is ready for them — and that
    // an empty index reads as empty rather than as a parse failure.
    const std::string path = TempPath("checkpoints");
    const std::vector<uint8_t> start{0xDE, 0xAD, 0x00, 0xBE, 0xEF};
    const std::vector<uint8_t> mid(4096, 0x5A);
    {
        replay::Writer w;
        std::string err;
        REQUIRE(w.Open(path, SampleHeader(), err));
        w.WriteStartCheckpoint(start);
        w.Append(MakeRecord(1, 0, TickPhase::Inbound, InputKind::GameStart, "g"));
        w.AppendCheckpoint(9000, mid);
        CHECK(w.CheckpointsWritten() == 1);
        replay::Trailer t;
        t.endFrame = 9000;
        t.recordCount = w.Written();
        w.Close(t);
        CHECK_FALSE(w.Failed());
    }
    const replay::LoadResult res = replay::Load(path);
    REQUIRE(res.ok);
    CHECK(res.startCheckpoint == start);          // embedded NUL survives
    REQUIRE(res.checkpoints.size() == 1);
    CHECK(res.checkpoints[0].frame == 9000);
    CHECK(res.checkpoints[0].blob == mid);
    CHECK(res.trailer.checkpointCount == 1);
    std::remove(path.c_str());
}

TEST_CASE("a start checkpoint written after the stream began is refused") {
    // It would describe a world the already-written records were applied to.
    const std::string path = TempPath("late-start-ckpt");
    replay::Writer w;
    std::string err;
    REQUIRE(w.Open(path, SampleHeader(), err));
    w.Append(MakeRecord(1, 0, TickPhase::Inbound, InputKind::GameStart, "g"));
    w.WriteStartCheckpoint({1, 2, 3});
    CHECK(w.Failed());
    std::remove(path.c_str());
}

TEST_CASE("an unknown block marker is a named error, not a truncation") {
    // The header promises that new sections attach at the marker seam and that
    // an unknown one stops the reader loudly. Silently treating it as a torn
    // tail would hand back a short replay that looks like a crashed recording.
    const std::string path = TempPath("unknown-section");
    {
        replay::Writer w;
        std::string err;
        REQUIRE(w.Open(path, SampleHeader(), err));
        w.Append(MakeRecord(1, 0, TickPhase::Inbound, InputKind::GameStart, "g"));
        w.Flush();
        std::FILE* f = std::fopen(path.c_str(), "ab");
        REQUIRE(f != nullptr);
        const uint8_t future[] = {0x5A, 0x01, 0x02, 0x03, 0x04};   // 'Z' block
        std::fwrite(future, 1, sizeof(future), f);
        std::fclose(f);
    }
    const replay::LoadResult res = replay::Load(path);
    CHECK_FALSE(res.ok);
    CHECK(res.error.find("unknown replay block marker 0x5A") != std::string::npos);
    std::remove(path.c_str());
}

TEST_CASE("packing round-trips every section and shrinks a real stream") {
    const std::string raw    = TempPath("pack-src");
    const std::string packed = TempPath("pack-out");
    const std::string back   = TempPath("pack-back");
    {
        replay::Writer w;
        std::string err;
        REQUIRE(w.Open(raw, SampleHeader(), err));
        w.WriteStartCheckpoint(std::vector<uint8_t>(64, 0x11));
        // Wire traffic repeats heavily, which is the case the codec is for.
        for (int i = 1; i <= 200; ++i) {
            w.Append(MakeRecord(static_cast<uint64_t>(i), i * 10,
                                TickPhase::Inbound, InputKind::ClientMessage,
                                std::string(120, static_cast<char>('a' + (i % 7)))));
            if (i % 10 == 0)
                w.AppendHashPoint(i * 10, static_cast<uint64_t>(i) * 0x9E3779B97F4A7C15ULL);
        }
        w.AppendCheckpoint(2000, std::vector<uint8_t>(512, 0x22));
        replay::Trailer t;
        t.endFrame = 2000;
        t.recordCount = w.Written();
        w.Close(t);
    }

    std::string perr;
    REQUIRE(replay::Pack(raw, packed, replay::Codec::Deflate, perr));

    const replay::LoadResult src = replay::Load(raw);
    const replay::LoadResult dst = replay::Load(packed);
    REQUIRE(dst.ok);
    CHECK(dst.codec == replay::Codec::Deflate);
    CHECK_FALSE(dst.truncated);
    REQUIRE(dst.records.size() == src.records.size());
    CHECK(dst.records.back().payload == src.records.back().payload);
    CHECK(dst.records.back().seq == src.records.back().seq);
    REQUIRE(dst.hashTrack.size() == 20);
    REQUIRE(src.hashTrack.size() == 20);
    for (size_t i = 0; i < dst.hashTrack.size(); ++i) {
        CHECK(dst.hashTrack[i].frame == src.hashTrack[i].frame);
        CHECK(dst.hashTrack[i].hash == src.hashTrack[i].hash);
    }
    CHECK(dst.startCheckpoint == src.startCheckpoint);
    REQUIRE(dst.checkpoints.size() == 1);
    CHECK(dst.checkpoints[0].blob == src.checkpoints[0].blob);
    CHECK(dst.trailer.endFrame == src.trailer.endFrame);
    CHECK(dst.trailer.hashPointCount == src.trailer.hashPointCount);
    CHECK(dst.header.mapId == src.header.mapId);

    auto sizeOf = [](const std::string& p) -> long {
        std::FILE* f = std::fopen(p.c_str(), "rb");
        if (f == nullptr) return -1;
        std::fseek(f, 0, SEEK_END);
        const long n = std::ftell(f);
        std::fclose(f);
        return n;
    };
    CHECK(sizeOf(packed) > 0);
    CHECK(sizeOf(packed) < sizeOf(raw));

    // Import: unpacking is the same call with Codec::None, and it must be
    // byte-for-byte re-loadable.
    REQUIRE(replay::Pack(packed, back, replay::Codec::None, perr));
    const replay::LoadResult round = replay::Load(back);
    REQUIRE(round.ok);
    CHECK(round.codec == replay::Codec::None);
    CHECK(round.records.size() == src.records.size());
    CHECK(round.hashTrack.size() == src.hashTrack.size());
    CHECK(round.checkpoints.size() == src.checkpoints.size());

    std::remove(raw.c_str());
    std::remove(packed.c_str());
    std::remove(back.c_str());
}

TEST_CASE("packing a truncated segment keeps it truncated") {
    // The one thing the packer must never do is launder a crashed recording
    // into a clean-looking artefact — the trailer's absence is the only signal
    // that the game did not actually end where the file does (§6 E1).
    const std::string raw    = TempPath("pack-trunc-src");
    const std::string packed = TempPath("pack-trunc-out");
    {
        replay::Writer w;
        std::string err;
        REQUIRE(w.Open(raw, SampleHeader(), err));
        w.Append(MakeRecord(1, 0, TickPhase::Inbound, InputKind::GameStart, "g"));
        w.AppendHashPoint(300, 0x1234);
        w.Flush();
        // no Close(): killed mid-recording
    }
    std::string perr;
    REQUIRE(replay::Pack(raw, packed, replay::Codec::Deflate, perr));
    const replay::LoadResult res = replay::Load(packed);
    REQUIRE(res.ok);
    CHECK(res.truncated);
    CHECK(res.records.size() == 1);
    CHECK(res.hashTrack.size() == 1);
    CHECK(res.trailer.endFrame == -1);
    std::remove(raw.c_str());
    std::remove(packed.c_str());
}

TEST_CASE("a corrupted packed body is refused, never half-parsed") {
    const std::string raw    = TempPath("pack-corrupt-src");
    const std::string packed = TempPath("pack-corrupt-out");
    {
        replay::Writer w;
        std::string err;
        REQUIRE(w.Open(raw, SampleHeader(), err));
        for (int i = 1; i <= 50; ++i)
            w.Append(MakeRecord(static_cast<uint64_t>(i), i, TickPhase::Inbound,
                                InputKind::ClientMessage, std::string(64, 'q')));
        replay::Trailer t;
        t.endFrame = 50;
        t.recordCount = w.Written();
        w.Close(t);
    }
    std::string perr;
    REQUIRE(replay::Pack(raw, packed, replay::Codec::Deflate, perr));
    {
        std::FILE* f = std::fopen(packed.c_str(), "r+b");
        REQUIRE(f != nullptr);
        std::fseek(f, 40, SEEK_SET);       // inside the deflate stream
        const uint8_t junk[] = {0xFF, 0x00, 0xFF, 0x00};
        std::fwrite(junk, 1, sizeof(junk), f);
        std::fclose(f);
    }
    const replay::LoadResult res = replay::Load(packed);
    CHECK_FALSE(res.ok);
    CHECK(res.records.empty());
    std::remove(raw.c_str());
    std::remove(packed.c_str());
}

TEST_CASE("codec names parse, and zstd is refused as reserved-not-built") {
    replay::Codec c = replay::Codec::None;
    std::string err;
    CHECK(replay::ParseCodec("deflate", c, err));
    CHECK(c == replay::Codec::Deflate);
    CHECK(replay::ParseCodec("none", c, err));
    CHECK(c == replay::Codec::None);
    // The plan says zstd; this tree links zlib. That deviation must be a
    // spoken error, not a silent substitution into a different codec.
    CHECK_FALSE(replay::ParseCodec("zstd", c, err));
    CHECK(err.find("reserved") != std::string::npos);
    CHECK_FALSE(replay::ParseCodec("lzma", c, err));
}
