/**
 * GameMetrics — per-game sim-health metric writer (PLAN-gm-tools task 1).
 *
 * The game server samples tick timings every sim frame and, on a wall-clock
 * cadence, appends one row of aggregate health to the shared `game_metrics`
 * SQLite table. The lobby's GM dashboard reads those rows for the fleet view
 * (tick p95, frames-behind, entity count, uptime, db size) and the per-game
 * metric timeline (PLAN-gm-tools §2).
 *
 * Downsampling (PLAN-gm-tools E5 / PLAN-long-uptime S8): raw rows are kept for
 * a 7-day window at cadence granularity; older raw rows are collapsed to one
 * `hourly` row per hour so the table stays bounded across the weeks-to-months
 * uptime the Metalstorm premise requires.
 *
 * Economy / long-uptime counters (velocity, Gini, heap watermark, id
 * high-water — PLAN-metalstorm-economy §2, PLAN-long-uptime §3) are sourced
 * from game Lua that is Stage-7-gated; they ride the free-form `extra_json`
 * column and stay empty until that Lua exists. The fixed columns here are the
 * engine-sourced metrics available today.
 *
 * This writer shares the caller's sqlite3 handle (the same `game_status` DB the
 * server already opens); it does not own or close it.
 */
#pragma once

#include <cstdint>
#include <chrono>
#include <string>
#include <vector>

struct sqlite3;

class GameMetricsWriter {
public:
    /// Create the table (if absent) and anchor the uptime/cadence clocks.
    /// `db` is borrowed, not owned. `cadenceSec` is the metric-write interval
    /// (default 60s — a live-dashboard cadence; when PLAN-persistence lands,
    /// checkpoints will drive an additional write on the snapshot cadence).
    /// Returns false if `db` is null or the table can't be created.
    bool Init(sqlite3* db, uint32_t roomId, int cadenceSec = 60);

    /// Push one sim-tick duration into the p95 window. Called every sim frame
    /// (cheap ring insert, no allocation after Init).
    void SampleTick(int64_t tickUs);

    /// Would the next MaybeWrite actually write? Lets a caller skip gathering
    /// expensive `extraJson` inputs 1799 frames out of 1800 — the
    /// PLAN-long-uptime growth counters walk the spawn-generation table and
    /// every team's rulesParams map, which is fine once a minute and is not
    /// fine every sim frame.
    bool DueForWrite() const;

    /// Called every server-loop iteration. Writes a metric row + runs the
    /// downsample/prune when `cadenceSec` has elapsed since the last write;
    /// a no-op otherwise. `simRunning` = the sim actually ticked this window
    /// (not paused, has a client) — gates the frames-behind estimate so a
    /// paused/empty game doesn't report false lag. `extraJson` carries
    /// game-Lua metrics when available ("" today).
    void MaybeWrite(int frame, int clientCount, int entityCount,
                    float simFps, float speedFactor, bool simRunning,
                    const std::string& extraJson = "");

    /// Force a final row (graceful shutdown / game-over), bypassing the
    /// cadence gate. Same args as MaybeWrite.
    void WriteNow(int frame, int clientCount, int entityCount,
                  float simFps, float speedFactor, bool simRunning,
                  const std::string& extraJson = "");

private:
    void WriteRow(int frame, int clientCount, int entityCount, float simFps,
                  int64_t framesBehind, const std::string& extraJson);
    void Downsample(int64_t nowEpoch);
    int64_t Percentile95Us() const;
    int64_t DbSizeBytes() const;

    sqlite3* db_ = nullptr;
    uint32_t roomId_ = 0;
    int cadenceSec_ = 60;

    // Fixed-capacity ring of recent tick durations (µs) for the p95.
    std::vector<int64_t> tickRing_;
    size_t ringCap_ = 0;
    size_t ringPos_ = 0;
    size_t ringCount_ = 0;

    std::chrono::steady_clock::time_point startSteady_{};
    std::chrono::steady_clock::time_point lastWriteSteady_{};
    std::chrono::system_clock::time_point startWall_{};
    int lastWriteFrame_ = 0;
    bool primed_ = false;
};
