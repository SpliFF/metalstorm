// Broadcast log container tests (PLAN-beta-broadcast.md lane S1).
//
// What is under test is the claim a `.msb` makes about itself. Two of these
// cases have no counterpart in the replay container and are the reason this is
// a separate format: a broadcast log is read WHILE IT IS BEING WRITTEN, so a
// short tail must be "the recorder is mid-write" (retryable, cursor unmoved)
// rather than "corrupt", and the keyframe index a backward seek lands on must
// be buildable without decoding a single payload.

#include <doctest/doctest.h>

#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

#include <unistd.h>

#include "Server/BroadcastLog.h"

namespace {

std::string TempPath(const char* stem) {
    auto p = std::filesystem::temp_directory_path() /
             (std::string("msbtest-") + stem + "-" + std::to_string(::getpid()) + ".msb");
    return p.string();
}

replay::Header MakeHeader() {
    replay::Header h;
    h.gameId       = "metalstorm";
    h.mapId        = "beta-basin";
    h.defsCacheKey = "deadbeef";
    h.schemaHash   = "cafebabe";
    h.roomId       = 42;
    h.modOptions.emplace_back("war_sides", "2");
    h.players.push_back({"ada", 0, 1});
    return h;
}

std::vector<uint8_t> Payload(uint8_t seed, size_t len) {
    std::vector<uint8_t> v(len);
    for (size_t i = 0; i < len; ++i) v[i] = static_cast<uint8_t>(seed + i);
    return v;
}

}  // namespace

TEST_CASE("broadcast log round-trips header, records and trailer") {
    const std::string path = TempPath("roundtrip");
    const auto a = Payload(1, 64);
    const auto b = Payload(9, 7);

    {
        broadcast::Writer w;
        std::string err;
        REQUIRE(w.Open(path, MakeHeader(), err));
        w.AppendRecord(1000, 10, /*cls=*/1, /*lane=*/0, /*broadcast=*/false, a.data(), a.size());
        w.AppendRecord(1100, 11, /*cls=*/0, /*lane=*/4, /*broadcast=*/true, b.data(), b.size());
        w.Flush();
        broadcast::Trailer t;
        t.endFrame  = 11;
        t.endWallMs = 1200;
        w.Close(t);
        CHECK_FALSE(w.Failed());
        CHECK(w.Written() == 2);
        CHECK(w.BytesWritten() == a.size() + b.size());
    }

    broadcast::Reader r;
    std::string err;
    REQUIRE(r.Open(path, err));
    // The header is replay::Header, reused verbatim — a relay needs exactly the
    // launch spec a replay server needs.
    CHECK(r.GetHeader().gameId == "metalstorm");
    CHECK(r.GetHeader().roomId == 42);
    REQUIRE(r.GetHeader().modOptions.size() == 1);
    CHECK(r.GetHeader().modOptions[0].second == "2");

    broadcast::Record rec;
    REQUIRE(r.Next(rec));
    CHECK(rec.wallMs == 1000);
    CHECK(rec.frame == 10);
    CHECK(rec.cls == 1);
    CHECK(rec.lane == 0);
    CHECK(rec.broadcast == 0);
    CHECK(rec.payload == a);

    REQUIRE(r.Next(rec));
    CHECK(rec.frame == 11);
    CHECK(rec.cls == 0);
    CHECK(rec.lane == 4);
    CHECK(rec.broadcast == 1);
    CHECK(rec.payload == b);

    CHECK_FALSE(r.Next(rec));      // trailer
    CHECK(r.SawTrailer());
    CHECK(r.GetTrailer().endFrame == 11);
    CHECK(r.GetTrailer().recordCount == 2);
    CHECK_FALSE(r.Torn());

    std::filesystem::remove(path);
}

TEST_CASE("a log with no trailer reads as still-live, keeping every whole record") {
    const std::string path = TempPath("truncated");
    const auto a = Payload(3, 32);
    {
        broadcast::Writer w;
        std::string err;
        REQUIRE(w.Open(path, MakeHeader(), err));
        w.AppendRecord(500, 5, 1, 0, false, a.data(), a.size());
        w.Flush();
        // No Close(): the destructor leaves the file trailer-less, which is
        // what a killed recorder — and a mission still running — both look like.
    }

    const auto sum = broadcast::LoadSummary(path);
    REQUIRE(sum.ok);
    CHECK(sum.truncated);
    CHECK(sum.recordCount == 1);
    CHECK(sum.firstFrame == 5);
    CHECK(sum.EndFrame() == 5);       // from the record, since there is no trailer

    // Now lop a record's payload in half: the whole record before it survives
    // and the torn one is simply not there yet.
    {
        broadcast::Writer w;
        std::string err;
        const std::string path2 = TempPath("halfrecord");
        REQUIRE(w.Open(path2, MakeHeader(), err));
        w.AppendRecord(500, 5, 1, 0, false, a.data(), a.size());
        w.AppendRecord(600, 6, 1, 0, false, a.data(), a.size());
        w.Flush();
        const auto full = std::filesystem::file_size(path2);
        w.Close({});
        std::filesystem::resize_file(path2, full - 8);   // cut inside the last payload

        const auto s2 = broadcast::LoadSummary(path2);
        REQUIRE(s2.ok);
        CHECK(s2.truncated);
        CHECK(s2.recordCount == 1);
        CHECK(s2.lastFrame == 5);
        std::filesystem::remove(path2);
    }

    std::filesystem::remove(path);
}

TEST_CASE("a reader over a growing file retries the short tail instead of failing") {
    const std::string path = TempPath("growing");
    const auto a = Payload(7, 48);

    broadcast::Writer w;
    std::string err;
    REQUIRE(w.Open(path, MakeHeader(), err));
    w.AppendRecord(10, 1, 1, 0, false, a.data(), a.size());
    w.Flush();

    broadcast::Reader r;
    REQUIRE(r.Open(path, err));
    broadcast::Record rec;
    REQUIRE(r.Next(rec));
    CHECK(rec.frame == 1);

    // Nothing more written yet: Next() is false and — the load-bearing part —
    // the cursor has NOT moved, so the same read succeeds once bytes arrive.
    const uint64_t parked = r.Offset();
    CHECK_FALSE(r.Next(rec));
    CHECK(r.Offset() == parked);
    CHECK_FALSE(r.Torn());
    CHECK_FALSE(r.Rescan());          // nothing appended since Open

    w.AppendRecord(20, 2, 2, 3, true, a.data(), a.size());
    w.Flush();
    CHECK(r.Rescan());
    REQUIRE(r.Next(rec));
    CHECK(rec.frame == 2);
    CHECK(rec.broadcast == 1);
    CHECK(rec.lane == 3);

    w.Close({});
    std::filesystem::remove(path);
}

TEST_CASE("keyframe index is built by skipping payloads and seeks land on the marker") {
    const std::string path = TempPath("keyframes");
    const auto a = Payload(5, 100);
    {
        broadcast::Writer w;
        std::string err;
        REQUIRE(w.Open(path, MakeHeader(), err));
        w.AppendKeyframe(1000, 0);
        w.AppendRecord(1001, 0, 1, 0, false, a.data(), a.size());
        w.AppendRecord(1002, 900, 1, 0, false, a.data(), a.size());
        w.AppendKeyframe(2000, 1800);
        w.AppendRecord(2001, 1800, 1, 0, false, a.data(), a.size());
        broadcast::Trailer t;
        t.endFrame = 1800;
        w.Close(t);
        CHECK(w.KeyframesWritten() == 2);
    }

    const auto sum = broadcast::LoadSummary(path);
    REQUIRE(sum.ok);
    CHECK_FALSE(sum.truncated);
    CHECK(sum.recordCount == 3);
    CHECK(sum.trailer.keyframeCount == 2);
    REQUIRE(sum.keyframes.size() == 2);
    CHECK(sum.keyframes[0].frame == 0);
    CHECK(sum.keyframes[1].frame == 1800);
    CHECK(sum.keyframes[1].wallMs == 2000);

    // A backward seek: nearest K at or before frame 1800, then the bundle that
    // follows is the next record.
    broadcast::Reader r;
    std::string err;
    REQUIRE(r.Open(path, err));
    const uint64_t atFirstBlock = r.Offset();
    r.ScanIndex();
    REQUIRE(r.Keyframes().size() == 2);
    CHECK(r.Offset() == atFirstBlock);   // indexing must not disturb the cursor
    REQUIRE(r.SeekTo(r.Keyframes()[1].offset));
    broadcast::Record rec;
    REQUIRE(r.Next(rec));
    CHECK(rec.frame == 1800);
    CHECK(rec.wallMs == 2001);

    std::filesystem::remove(path);
}
