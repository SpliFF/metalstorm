// WorldClock — the world layer's clock, as arithmetic.
//
// PLAN-worldsim.md W1; design PLAN-metalstorm-worldbuilding.md §"World
// structure" (world time) + Capture 11. The rule that defines this file:
// **the world clock is not a process.** It is not a thread, not a tick, not a
// counter anybody increments. It is a pure function of
//
//     (epoch, ratio, the pause ledger, now)
//
// and that is deliberate: Capture 11 says world time "runs independently of
// battles, regardless of whether players are online", so there is no process
// whose uptime could define it. A lobby that was down for six hours must come
// back and agree with a client that stayed up — which it does, because both
// evaluate the same function over the same rows. Pausing is therefore a DB
// row (an interval in `world_pause_ledger`), not a stopped timer.
//
// Everything here is header-only and free of sqlite, nlohmann and the lobby,
// the way `WarSeeding.h` / `WarTermination.h` are: the store (WorldDirector)
// reads the rows, this decides what they mean, and the test drives this with
// hand-built vectors and no database at all.
//
// UNITS. Two different milliseconds appear below and mixing them is the one
// mistake this file is shaped to prevent:
//   * *real* ms — wall clock, the same `now` every other lobby table stamps.
//   * *world* ms — in-fiction time, running `ratioNum/ratioDen` times faster.
// Every name says which one it is. Nothing returns a bare "ms".
//
// NUMBERS ARE DATA (pillar 7): the 24× ratio is a DEFAULT here and a per-world
// column in `worlds`. Nothing in this header may hardcode it into arithmetic —
// the constants below exist so a seeder has something to write, not so the
// clock can assume it.

#pragma once

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

/// Wall-clock "now" in real ms. The ONE place the world layer reads a clock:
/// everything else here takes `nowRealMs` as an argument, which is what makes
/// the whole file testable at a fixed instant rather than against today.
///
/// system_clock and not steady_clock, deliberately — the epoch is a persisted
/// absolute instant, so a monotonic clock that restarts with the process would
/// re-found the world on every lobby restart.
inline int64_t WorldNowRealMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}

/// The working ratio from the directive: **1 world day per battle hour**.
/// Expressed as a fraction so a world can be tuned to anything (3/2, 48/1)
/// without introducing floating point into a clock that must agree exactly
/// across processes.
inline constexpr int64_t kDefaultWorldTimeRatioNum = 24;
inline constexpr int64_t kDefaultWorldTimeRatioDen = 1;

/// One row of `world_pause_ledger`, in real ms. `endedAtMs <= 0` means the
/// pause is still open — the world is paused right now.
struct WorldPauseInterval {
    int64_t startedAtMs = 0;
    int64_t endedAtMs   = 0;  ///< <= 0 → open (still paused)

    bool IsOpen() const { return endedAtMs <= 0; }
};

/// A world's clock definition — the `worlds` columns this file cares about.
struct WorldClockConfig {
    /// Real-time instant at which the world clock reads `epochWorldMs`.
    int64_t epochRealMs = 0;
    /// World time at the epoch. Non-zero lets a world be founded on, say,
    /// world-year 40 without back-dating its real epoch.
    int64_t epochWorldMs = 0;
    int64_t ratioNum = kDefaultWorldTimeRatioNum;
    int64_t ratioDen = kDefaultWorldTimeRatioDen;

    /// World ms per real ms, as the fraction actually used. A zero or negative
    /// denominator is a corrupt row, not a reason to divide by zero: fall back
    /// to 1 so a bad row makes the world slow, never crashes the lobby.
    int64_t SafeRatioNum() const { return ratioNum < 0 ? 0 : ratioNum; }
    int64_t SafeRatioDen() const { return ratioDen <= 0 ? 1 : ratioDen; }
};

/// What the clock reads at one instant. Every field is derived; nothing here
/// is stored.
struct WorldClockReading {
    int64_t realMs        = 0;  ///< the `now` this was evaluated at
    int64_t worldMs       = 0;  ///< the world clock
    int64_t runningRealMs = 0;  ///< real ms since the epoch, pauses removed
    int64_t pausedRealMs  = 0;  ///< real ms spent paused since the epoch
    bool    paused        = false;
};

/// A world timestamp split for display. Days are 0-based *since the world
/// epoch*; `dayNumber` is the 1-based form the UI shows ("Day 1" on the day a
/// world is founded).
struct WorldCalendar {
    int64_t day        = 0;
    int64_t dayNumber  = 1;
    int     hour       = 0;
    int     minute     = 0;
    int     second     = 0;
};

/// Sort, clamp and MERGE a pause ledger into disjoint intervals ending no
/// later than `nowRealMs`.
///
/// Merging is not tidiness. The admin pause is a route: two admins can open a
/// pause seconds apart, and a resume closes what is open. Overlapping rows are
/// therefore an ordinary state of the table, and summing them raw would
/// double-count the overlap and make the world clock run BACKWARDS relative to
/// a reading taken before the second pause. Overlap is counted once here.
///
/// An open interval (`endedAtMs <= 0`) is treated as ending *now* — a pause in
/// progress has, so far, cost exactly the time since it started.
inline std::vector<WorldPauseInterval> NormalizeWorldPauses(
    std::vector<WorldPauseInterval> intervals, int64_t nowRealMs) {
    std::vector<WorldPauseInterval> out;
    out.reserve(intervals.size());
    for (auto& iv : intervals) {
        const int64_t start = iv.startedAtMs;
        const int64_t end   = iv.IsOpen() ? nowRealMs : iv.endedAtMs;
        // A row that ends before it starts is corrupt; it contributes nothing
        // rather than negative time (which would make the world run fast).
        if (end <= start) continue;
        out.push_back({start, end});
    }
    std::sort(out.begin(), out.end(),
              [](const WorldPauseInterval& a, const WorldPauseInterval& b) {
                  return a.startedAtMs < b.startedAtMs;
              });
    std::vector<WorldPauseInterval> merged;
    for (const auto& iv : out) {
        if (!merged.empty() && iv.startedAtMs <= merged.back().endedAtMs) {
            merged.back().endedAtMs = std::max(merged.back().endedAtMs, iv.endedAtMs);
            continue;
        }
        merged.push_back(iv);
    }
    return merged;
}

/// Real ms of pause overlapping the half-open window `[fromRealMs, toRealMs)`.
/// `intervals` need not be sorted or disjoint — it is normalized here.
inline int64_t WorldPausedRealMsBetween(const std::vector<WorldPauseInterval>& intervals,
                                        int64_t fromRealMs, int64_t toRealMs) {
    if (toRealMs <= fromRealMs) return 0;
    int64_t total = 0;
    for (const auto& iv : NormalizeWorldPauses(intervals, toRealMs)) {
        const int64_t lo = std::max(iv.startedAtMs, fromRealMs);
        const int64_t hi = std::min(iv.endedAtMs, toRealMs);
        if (hi > lo) total += hi - lo;
    }
    return total;
}

/// True if any interval is open at `nowRealMs` (started, not yet ended).
inline bool IsWorldPausedAt(const std::vector<WorldPauseInterval>& intervals,
                            int64_t nowRealMs) {
    for (const auto& iv : intervals) {
        if (iv.startedAtMs > nowRealMs) continue;
        if (iv.IsOpen() || iv.endedAtMs > nowRealMs) return true;
    }
    return false;
}

/// THE function. World time at `nowRealMs`, from the epoch, the ratio and the
/// ledger.
///
/// Before the epoch the clock reads exactly `epochWorldMs` — it does not run
/// backwards. Pause time is removed from the real elapsed span *before* the
/// ratio is applied, so a paused world's clock is frozen rather than merely
/// slowed, and the multiply is done before the divide so a fractional ratio
/// (3/2) does not truncate away most of a short interval.
inline WorldClockReading ReadWorldClock(const WorldClockConfig& cfg,
                                        const std::vector<WorldPauseInterval>& intervals,
                                        int64_t nowRealMs) {
    WorldClockReading r;
    r.realMs  = nowRealMs;
    r.paused  = IsWorldPausedAt(intervals, nowRealMs);
    r.worldMs = cfg.epochWorldMs;
    if (nowRealMs <= cfg.epochRealMs) return r;

    const int64_t elapsed = nowRealMs - cfg.epochRealMs;
    r.pausedRealMs  = WorldPausedRealMsBetween(intervals, cfg.epochRealMs, nowRealMs);
    r.runningRealMs = std::max<int64_t>(0, elapsed - r.pausedRealMs);
    r.worldMs = cfg.epochWorldMs +
                (r.runningRealMs * cfg.SafeRatioNum()) / cfg.SafeRatioDen();
    return r;
}

/// Split a world timestamp into days/hours/minutes/seconds. Negative input is
/// clamped to the epoch rather than producing negative fields.
inline WorldCalendar WorldCalendarFromMs(int64_t worldMs) {
    WorldCalendar c;
    if (worldMs < 0) worldMs = 0;
    const int64_t sec = worldMs / 1000;
    c.day       = sec / 86400;
    c.dayNumber = c.day + 1;
    c.hour      = static_cast<int>((sec / 3600) % 24);
    c.minute    = static_cast<int>((sec / 60) % 60);
    c.second    = static_cast<int>(sec % 60);
    return c;
}

/// "Day 12, 07:31" — the speakable form (pillar 1: everything addressable has
/// a name, and the world date is addressable).
inline std::string FormatWorldCalendar(const WorldCalendar& c) {
    char buf[64];
    snprintf(buf, sizeof(buf), "Day %lld, %02d:%02d",
             static_cast<long long>(c.dayNumber), c.hour, c.minute);
    return buf;
}
