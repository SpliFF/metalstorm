// Broadcast relay cursor tests (PLAN-beta-broadcast.md lane S2).
//
// Four claims, one per mechanism the relay introduces: the delay floor cannot
// be argued down, a backward seek lands on a keyframe and catches up from
// there, the catch-up collapses State lanes to the newest, and a paced pump
// hands out records by wall-clock deltas and stops dead at the live edge.

#include <doctest/doctest.h>

#include <filesystem>
#include <string>
#include <vector>

#include <unistd.h>

#include "Server/BroadcastRelay.h"

namespace {

constexpr uint8_t kControl = 0;
constexpr uint8_t kState   = 1;
constexpr uint8_t kBulk    = 3;

std::string TempPath(const char* stem) {
    auto p = std::filesystem::temp_directory_path() /
             (std::string("msbrelay-") + stem + "-" + std::to_string(::getpid()) + ".msb");
    return p.string();
}

replay::Header MakeHeader() {
    replay::Header h;
    h.gameId = "metalstorm";
    h.mapId  = "beta-basin";
    return h;
}

/// One byte of payload is enough to identify a record in an assertion.
void Rec(broadcast::Writer& w, uint64_t wallMs, int32_t frame, uint8_t cls,
         uint8_t lane, uint8_t tag) {
    w.AppendRecord(wallMs, frame, cls, lane, /*broadcast=*/false, &tag, 1);
}

uint8_t Tag(const broadcast::Emission& e) { return e.payload.at(0); }

/// A log with keyframes at 1000 ms and 3000 ms and a record every 500 ms.
/// Frames advance with wall time so a frame assertion means something.
std::string WriteFixture(const char* stem) {
    const std::string path = TempPath(stem);
    broadcast::Writer w;
    std::string err;
    REQUIRE(w.Open(path, MakeHeader(), err));
    w.AppendKeyframe(1000, 30);
    Rec(w, 1000, 30, kControl, 0, 1);   // the keyframe bundle
    Rec(w, 1000, 30, kState,   0, 2);
    Rec(w, 1500, 45, kState,   0, 3);
    Rec(w, 2000, 60, kBulk,    0, 4);
    Rec(w, 2500, 75, kState,   0, 5);
    Rec(w, 2500, 75, kState,   1, 6);   // a second lane, also stale by 3000
    w.AppendKeyframe(3000, 90);
    Rec(w, 3000, 90, kControl, 0, 7);
    Rec(w, 3500, 105, kState,  0, 8);
    w.Flush();
    w.Close({});
    return path;
}

}  // namespace

TEST_CASE("the broadcast delay floor cannot be argued down") {
    // The product is the delay; a caller asking for less gets the floor.
    CHECK(broadcast::ClampDelaySeconds(0) == broadcast::kMinBroadcastDelaySec);
    CHECK(broadcast::ClampDelaySeconds(60) == broadcast::kMinBroadcastDelaySec);
    CHECK(broadcast::ClampDelaySeconds(-9999) == broadcast::kMinBroadcastDelaySec);
    // Longer than the floor is the operator's business.
    CHECK(broadcast::ClampDelaySeconds(7200) == 7200);
    // Only an explicit dev floor lowers it, and a negative one is still not live.
    CHECK(broadcast::ClampDelaySeconds(30, /*floorSec=*/30) == 30);
    CHECK(broadcast::ClampDelaySeconds(0, /*floorSec=*/-5) == 0);

    // The edge is `now - delay`, and it never runs off the bottom of the clock.
    CHECK(broadcast::LiveEdgeMs(10'000, 3) == 7'000);
    CHECK(broadcast::LiveEdgeMs(1'000, 3600) == 0);
}

TEST_CASE("catch-up keeps only the last State record per lane") {
    std::vector<broadcast::Emission> span;
    auto push = [&](uint8_t cls, uint32_t lane, uint8_t tag) {
        broadcast::Emission e;
        e.cls = cls; e.lane = lane; e.payload = {tag};
        span.push_back(e);
    };
    push(kState,   0, 1);
    push(kControl, 0, 2);
    push(kState,   0, 3);
    push(kState,   1, 4);
    push(kBulk,    0, 5);
    push(kState,   0, 6);

    broadcast::BroadcastCursor::CollapseCatchUp(span);

    // Control and Bulk survive whole and in order; lane 0 collapses to its
    // newest (6) and lane 1 to its only one (4).
    std::vector<uint8_t> tags;
    for (const auto& e : span) tags.push_back(Tag(e));
    CHECK(tags == std::vector<uint8_t>{2, 4, 5, 6});
}

TEST_CASE("a backward seek lands on the nearest keyframe and catches up") {
    const std::string path = WriteFixture("seek");
    broadcast::Reader r;
    std::string err;
    REQUIRE(r.Open(path, err));

    broadcast::BroadcastCursor cur;
    cur.Attach(&r, /*startWallMs=*/3500, /*nowMs=*/0);

    // Seek back to 2500: nearest K at or before is 1000, so the bundle and the
    // span 1000..2500 are re-sent.
    std::vector<broadcast::Emission> out;
    CHECK(cur.Seek(2500, /*liveEdgeMs=*/10'000, out) == 2500);
    std::vector<uint8_t> tags;
    for (const auto& e : out) tags.push_back(Tag(e));
    // 1 (Control) and 4 (Bulk) uncapped; lane 0's States 2,3,5 collapse to 5;
    // lane 1's single State 6 survives. Nothing from past the target.
    CHECK(tags == std::vector<uint8_t>{1, 4, 5, 6});
    CHECK(cur.VirtualWallMs() == 2500);
    CHECK(cur.CurrentFrame() == 75);

    // A seek past the live edge is clamped, not refused, and lands on the
    // keyframe before the clamped target.
    out.clear();
    CHECK(cur.Seek(999'999, /*liveEdgeMs=*/3200, out) == 3200);
    tags.clear();
    for (const auto& e : out) tags.push_back(Tag(e));
    CHECK(tags == std::vector<uint8_t>{7});   // the 3000 K bundle only

    // A seek before the first keyframe clamps up to it rather than off the file.
    out.clear();
    CHECK(cur.Seek(0, /*liveEdgeMs=*/10'000, out) == 1000);
    CHECK(!out.empty());

    // The whole log ahead of the live edge — a mission that started ten
    // minutes ago under a one-hour delay — serves NOTHING. Not the first
    // keyframe, not the opening instant: the delay is the product.
    out.clear();
    CHECK(cur.Seek(0, /*liveEdgeMs=*/500, out) == 500);
    CHECK(out.empty());

    std::filesystem::remove(path);
}

TEST_CASE("pacing follows wall-clock deltas and stops at the live edge") {
    const std::string path = WriteFixture("pace");
    broadcast::Reader r;
    std::string err;
    REQUIRE(r.Open(path, err));

    broadcast::BroadcastCursor cur;
    // Join at 1000 (the first keyframe) with the real clock at 0.
    cur.Attach(&r, /*startWallMs=*/1000, /*nowMs=*/0);

    // 0 ms of real time has passed: only what is stamped AT 1000 is due.
    std::vector<broadcast::Emission> out;
    CHECK(cur.Pump(/*nowMs=*/0, /*liveEdgeMs=*/10'000, out) == broadcast::PumpStop::AtTail);
    CHECK(out.size() == 2);   // tags 1 and 2

    // 1000 ms later the cursor is at 2000 and has taken 3 (1500) and 4 (2000).
    out.clear();
    CHECK(cur.Pump(/*nowMs=*/1000, /*liveEdgeMs=*/10'000, out) == broadcast::PumpStop::AtTail);
    CHECK(out.size() == 2);
    CHECK(Tag(out.back()) == 4);
    CHECK(cur.VirtualWallMs() == 2000);

    // Double speed covers twice the log per second of real time.
    out.clear();
    cur.SetSpeed(2.0f);
    CHECK(cur.Pump(/*nowMs=*/1500, /*liveEdgeMs=*/10'000, out) == broadcast::PumpStop::AtTail);
    CHECK(cur.VirtualWallMs() == 3000);
    CHECK(Tag(out.back()) == 7);

    // The live edge is a hard stop: the cursor parks ON it and emits nothing
    // past it, however much real time goes by.
    out.clear();
    cur.SetSpeed(1.0f);
    CHECK(cur.Pump(/*nowMs=*/99'999, /*liveEdgeMs=*/3200, out) == broadcast::PumpStop::AtEdge);
    CHECK(out.empty());
    CHECK(cur.VirtualWallMs() == 3200);

    // Paused, the virtual clock does not move even when the edge is far ahead.
    cur.SetPaused(true);
    out.clear();
    CHECK(cur.Pump(/*nowMs=*/200'000, /*liveEdgeMs=*/10'000, out) == broadcast::PumpStop::Paused);
    CHECK(out.empty());
    CHECK(cur.VirtualWallMs() == 3200);

    // Resumed, the record past the old edge finally lands.
    cur.SetPaused(false);
    out.clear();
    CHECK(cur.Pump(/*nowMs=*/200'500, /*liveEdgeMs=*/10'000, out) == broadcast::PumpStop::AtTail);
    REQUIRE(out.size() == 1);
    CHECK(Tag(out.front()) == 8);

    std::filesystem::remove(path);
}
