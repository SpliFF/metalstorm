// BroadcastCatalog — pure decisions behind the lobby's broadcast browser
// (PLAN-beta-broadcast.md lane L: POST /api/broadcasts/list, /watch, retention).
//
// `lobby_main.cpp` owns the directory walk, the room bookkeeping and the JSON —
// everything here is a pure function over a `broadcast::Summary` (the cheap
// header/trailer read BroadcastLog.h already provides), a clock and a couple
// of ints. Three decisions are worth a doctest apart from the HTTP plumbing:
// whether a segment is watchable yet at all, in what order several segments
// should list, and whether an old one is due to be swept.
#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

#include "BroadcastLog.h"

namespace broadcastcatalog {

/// Mirrors the two words the brief's listing row uses verbatim.
enum class State : uint8_t { Live, Recorded };

inline const char *StateName(State s) {
  return s == State::Live ? "live" : "recorded";
}

/// The catalog's verdict for one `.msb` file at one instant.
struct AvailabilityResult {
  /// `firstWallMs + delaySeconds*1000 <= nowMs`. A listing drops a row for
  /// which this is false — the mission has started but the enforced delay
  /// has not opened it up yet.
  bool available = false;
  State state = State::Recorded;
  /// How far behind "now" the watchable edge sits. The enforced delay while
  /// the log is still live (that is what joining right now costs a watcher);
  /// 0 once the segment is recorded — a finished mission is not behind
  /// anything live anymore.
  int64_t behindSeconds = 0;
  /// The wall-clock instant `available` flips true.
  uint64_t availableSinceMs = 0;
  /// Wall-clock span of the segment's content so far. 0 if nothing was ever
  /// tapped (a log with no records at all).
  uint64_t durationMs = 0;
};

/// Pure. `delaySeconds` is the enforced relay floor — the SAME number a relay
/// will apply when this file is watched (`broadcast::kMinBroadcastDelaySec`,
/// or a `--dev-broadcast-floor` override in a test) — so a segment never
/// advertises availability the relay would then refuse.
///
/// `state` is Live exactly when the log has no trailer: the recorder is still
/// running, or it died mid-write, and either reading is "there may be more (or
/// nothing final) to see" — which a broadcast catalogue cannot tell apart from
/// content alone (BroadcastLog.h's own truncation rule). Recorded once a clean
/// `Writer::Close()` wrote one.
inline AvailabilityResult Availability(const broadcast::Summary &sum,
                                       int delaySeconds, uint64_t nowMs) {
  AvailabilityResult a;
  const uint64_t delayMs =
      static_cast<uint64_t>(std::max(0, delaySeconds)) * 1000ull;
  a.availableSinceMs = sum.firstWallMs + delayMs;
  a.available = sum.ok && a.availableSinceMs <= nowMs;
  a.state = sum.truncated ? State::Live : State::Recorded;
  a.behindSeconds = a.state == State::Live ? delaySeconds : 0;
  const uint64_t endMs =
      sum.truncated ? sum.lastWallMs : sum.trailer.endWallMs;
  a.durationMs = (endMs > sum.firstWallMs) ? (endMs - sum.firstWallMs) : 0;
  return a;
}

/// One listing entry's sort key: a segment file plus the timestamp encoded in
/// its own name (the lobby writes `<roomId>-<ts>.msb`, `spawnGameServer`'s tap
/// wiring — see `ParseSegmentName` below).
struct SegmentEntry {
  std::string file;
  uint64_t timestampMs = 0;
};

/// Newest first: a room that hibernated and resumed writes a fresh segment
/// each time (hibernate/end closes one; a resumed mission opens another), and
/// the newest is what a browser wants at the top. Ties (same millisecond —
/// possible only if two rooms happened to start together) break on filename
/// so the order is deterministic rather than input-order-dependent.
inline std::vector<SegmentEntry>
OrderSegmentsNewestFirst(std::vector<SegmentEntry> segments) {
  std::sort(segments.begin(), segments.end(),
           [](const SegmentEntry &a, const SegmentEntry &b) {
             if (a.timestampMs != b.timestampMs)
               return a.timestampMs > b.timestampMs;
             return a.file > b.file;
           });
  return segments;
}

/// `<roomId>-<ts>.msb` → its two fields. False for anything else — a file this
/// lane did not name itself (a stray `.msb` dropped into the directory by
/// hand) is not something the catalog should guess a room or a time for.
struct SegmentName {
  uint32_t roomId = 0;
  uint64_t timestampMs = 0;
};

inline bool ParseSegmentName(const std::string &filename, SegmentName &out) {
  constexpr char kExt[] = ".msb";
  constexpr size_t kExtLen = sizeof(kExt) - 1;
  if (filename.size() <= kExtLen ||
      filename.compare(filename.size() - kExtLen, kExtLen, kExt) != 0)
    return false;
  const std::string stem = filename.substr(0, filename.size() - kExtLen);
  const auto dash = stem.find('-');
  if (dash == std::string::npos || dash == 0 || dash + 1 >= stem.size())
    return false;
  const std::string roomPart = stem.substr(0, dash);
  const std::string tsPart = stem.substr(dash + 1);
  const auto allDigits = [](const std::string &s) {
    return !s.empty() &&
           std::all_of(s.begin(), s.end(), [](char c) {
             return c >= '0' && c <= '9';
           });
  };
  if (!allDigits(roomPart) || !allDigits(tsPart))
    return false;
  out.roomId = static_cast<uint32_t>(std::strtoul(roomPart.c_str(), nullptr, 10));
  out.timestampMs = static_cast<uint64_t>(std::strtoull(tsPart.c_str(), nullptr, 10));
  return true;
}

/// `--broadcast-retention-days` sweep, pure. `fileMtimeMs` is the file's own
/// last-write time, not the timestamp in its name: a segment still being
/// tapped is touched by `Writer::Flush()` on every tick, so its mtime never
/// ages past the retention window while the mission runs, and a finished
/// segment's mtime is "when the trailer was written" — both are the honest
/// answer to "how long has this sat there", which a name-only timestamp
/// (fixed at the mission's START) is not.
inline bool ShouldSweep(uint64_t fileMtimeMs, uint64_t nowMs, int retentionDays) {
  if (retentionDays <= 0)
    return false;
  const uint64_t ageMs = nowMs > fileMtimeMs ? nowMs - fileMtimeMs : 0;
  const uint64_t retentionMs =
      static_cast<uint64_t>(retentionDays) * 86400ull * 1000ull;
  return ageMs > retentionMs;
}

} // namespace broadcastcatalog
