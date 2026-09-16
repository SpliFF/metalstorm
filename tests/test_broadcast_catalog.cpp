// Broadcast catalog tests (PLAN-beta-broadcast.md lane L).
//
// The three decisions the lobby's browser and maintenance sweep lean on, each
// tested as the pure function it is: does a `.msb` become listable exactly
// when its delay has elapsed and not a moment before; do several segments
// list newest-first; does the retention sweep age off exactly what its name
// says it will.

#include <doctest/doctest.h>

#include <cstdio>
#include <filesystem>
#include <string>
#include <vector>

#include <unistd.h>

#include "Server/BroadcastCatalog.h"
#include "Server/BroadcastLog.h"

namespace {

std::string TempPath(const char *stem) {
  auto p = std::filesystem::temp_directory_path() /
           (std::string("msbcatalog-") + stem + "-" +
            std::to_string(::getpid()) + ".msb");
  return p.string();
}

replay::Header MakeHeader() {
  replay::Header h;
  h.gameId = "metalstorm";
  h.mapId = "beta-basin";
  h.roomId = 7;
  return h;
}

/// A summary whose header/trailer/records came out of a real `.msb`, not a
/// hand-built struct — `Availability` reads several fields at once
/// (`ok`/`truncated`/`firstWallMs`/`lastWallMs`/`trailer.endWallMs`) and a
/// fixture assembled by hand could silently drift from what `LoadSummary`
/// actually produces.
broadcast::Summary WriteAndLoad(uint64_t firstWallMs, uint64_t lastWallMs,
                                bool close) {
  const std::string path = TempPath("fixture");
  {
    broadcast::Writer w;
    std::string err;
    REQUIRE(w.Open(path, MakeHeader(), err));
    const uint8_t byte = 1;
    w.AppendRecord(firstWallMs, 0, /*cls=*/1, /*lane=*/0, /*broadcast=*/false,
                  &byte, 1);
    if (lastWallMs != firstWallMs)
      w.AppendRecord(lastWallMs, 10, 1, 0, false, &byte, 1);
    w.Flush();
    if (close) {
      broadcast::Trailer t;
      t.endFrame = 10;
      t.endWallMs = lastWallMs;
      w.Close(t);
    }
  }
  auto sum = broadcast::LoadSummary(path);
  std::filesystem::remove(path);
  return sum;
}

} // namespace

TEST_CASE("availability: not yet available before the delay elapses") {
  const auto sum = WriteAndLoad(/*firstWallMs=*/100000, /*lastWallMs=*/100000,
                                /*close=*/false);
  REQUIRE(sum.ok);
  const auto a = broadcastcatalog::Availability(sum, /*delaySeconds=*/3600,
                                                /*nowMs=*/100000 + 3600 * 1000 - 1);
  CHECK_FALSE(a.available);
  CHECK(a.availableSinceMs == 100000 + 3600ull * 1000);
}

TEST_CASE("availability: available and live once the delay has just elapsed") {
  const auto sum = WriteAndLoad(100000, 130000, /*close=*/false);
  REQUIRE(sum.ok);
  REQUIRE(sum.truncated); // no trailer written
  const auto a = broadcastcatalog::Availability(sum, 3600,
                                                100000 + 3600ull * 1000);
  CHECK(a.available);
  CHECK(a.state == broadcastcatalog::State::Live);
  CHECK(a.behindSeconds == 3600);
  CHECK(a.durationMs == 30000); // lastWallMs - firstWallMs, since it is live
}

TEST_CASE("availability: recorded once a trailer closes the segment") {
  const auto sum = WriteAndLoad(100000, 160000, /*close=*/true);
  REQUIRE(sum.ok);
  CHECK_FALSE(sum.truncated);
  const auto a = broadcastcatalog::Availability(sum, 3600,
                                                100000 + 3600ull * 1000 + 5000);
  CHECK(a.available);
  CHECK(a.state == broadcastcatalog::State::Recorded);
  CHECK(a.behindSeconds == 0); // nothing live left to be behind
  CHECK(a.durationMs == 60000);
}

TEST_CASE("availability: a lower dev floor opens a segment sooner") {
  const auto sum = WriteAndLoad(100000, 100000, /*close=*/false);
  REQUIRE(sum.ok);
  const auto a = broadcastcatalog::Availability(sum, /*delaySeconds=*/30,
                                                /*nowMs=*/100000 + 30 * 1000);
  CHECK(a.available);
  CHECK(a.behindSeconds == 30);
}

TEST_CASE("segment name parsing: the lobby's own <roomId>-<ts>.msb shape") {
  broadcastcatalog::SegmentName n;
  REQUIRE(broadcastcatalog::ParseSegmentName("7-1758000000000.msb", n));
  CHECK(n.roomId == 7);
  CHECK(n.timestampMs == 1758000000000ull);

  CHECK_FALSE(broadcastcatalog::ParseSegmentName("not-a-broadcast.msb", n));
  CHECK_FALSE(broadcastcatalog::ParseSegmentName("7.msb", n));      // no dash
  CHECK_FALSE(broadcastcatalog::ParseSegmentName("-123.msb", n));   // empty roomId
  CHECK_FALSE(broadcastcatalog::ParseSegmentName("7-.msb", n));     // empty ts
  CHECK_FALSE(broadcastcatalog::ParseSegmentName("7-123.msr", n));  // wrong ext
}

TEST_CASE("segment ordering: newest timestamp first, filename as tie-break") {
  std::vector<broadcastcatalog::SegmentEntry> in = {
      {"7-1000.msb", 1000}, {"7-3000.msb", 3000}, {"7-2000.msb", 2000},
      {"9-3000.msb", 3000}, // ties with 7-3000 at the same instant
  };
  const auto out = broadcastcatalog::OrderSegmentsNewestFirst(in);
  REQUIRE(out.size() == 4);
  CHECK(out[0].file == "9-3000.msb"); // tie: "9-3000.msb" > "7-3000.msb"
  CHECK(out[1].file == "7-3000.msb");
  CHECK(out[2].file == "7-2000.msb");
  CHECK(out[3].file == "7-1000.msb");
}

TEST_CASE("retention: swept exactly past the window, not a moment before") {
  constexpr uint64_t kDayMs = 86400ull * 1000;
  const uint64_t now = 20 * kDayMs;

  CHECK_FALSE(broadcastcatalog::ShouldSweep(now - 14 * kDayMs, now, 14));
  CHECK(broadcastcatalog::ShouldSweep(now - 14 * kDayMs - 1, now, 14));
  CHECK_FALSE(broadcastcatalog::ShouldSweep(now - 13 * kDayMs, now, 14));

  // A file whose mtime is still advancing (an active tap) never ages out.
  CHECK_FALSE(broadcastcatalog::ShouldSweep(now, now, 14));

  // Retention disabled.
  CHECK_FALSE(broadcastcatalog::ShouldSweep(0, now, 0));
  CHECK_FALSE(broadcastcatalog::ShouldSweep(0, now, -1));
}
