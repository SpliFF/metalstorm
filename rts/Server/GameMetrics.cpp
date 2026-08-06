/**
 * GameMetrics — see GameMetrics.h.
 */
#include "GameMetrics.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "metrics"

#include <sqlite3.h>
#include <algorithm>
#include <cstdio>

namespace {
// Sim frames per game-second — mirrors GAME_SPEED in Sim/Misc/GlobalConstants.h.
// Kept local so the metric writer stays free of sim headers (it is compiled
// into the plain server + is trivially unit-testable in isolation).
constexpr double kGameSpeed = 30.0;
// p95 window: at 30Hz this is ~68s of ticks — comfortably covers a 60s cadence.
constexpr size_t kTickWindow = 2048;
// Raw rows live at cadence granularity for this long; older rows collapse to
// one 'hourly' row per hour (PLAN-gm-tools E5 / PLAN-long-uptime S8).
constexpr int64_t kRawRetentionSec = 7 * 24 * 3600;
}  // namespace

bool GameMetricsWriter::Init(sqlite3* db, uint32_t roomId, int cadenceSec) {
    if (!db)
        return false;
    db_ = db;
    roomId_ = roomId;
    cadenceSec_ = cadenceSec > 0 ? cadenceSec : 60;

    const char* sql = R"(
        CREATE TABLE IF NOT EXISTS game_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL,
            frame INTEGER NOT NULL,
            taken_at INTEGER NOT NULL,
            resolution TEXT NOT NULL DEFAULT 'raw',
            tick_us INTEGER NOT NULL DEFAULT 0,
            tick_p95_us INTEGER NOT NULL DEFAULT 0,
            frames_behind INTEGER NOT NULL DEFAULT 0,
            entity_count INTEGER NOT NULL DEFAULT 0,
            client_count INTEGER NOT NULL DEFAULT 0,
            sim_fps REAL NOT NULL DEFAULT 0,
            uptime_sec INTEGER NOT NULL DEFAULT 0,
            db_size_bytes INTEGER NOT NULL DEFAULT 0,
            snapshot_age_sec INTEGER NOT NULL DEFAULT -1,
            extra_json TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_game_metrics_room_time
            ON game_metrics(room_id, taken_at);
    )";
    char* err = nullptr;
    if (sqlite3_exec(db_, sql, nullptr, nullptr, &err) != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "failed to create game_metrics: %s", err ? err : "?");
        sqlite3_free(err);
        db_ = nullptr;
        return false;
    }

    tickRing_.assign(kTickWindow, 0);
    ringCap_ = kTickWindow;
    ringPos_ = ringCount_ = 0;

    startSteady_ = lastWriteSteady_ = std::chrono::steady_clock::now();
    startWall_ = std::chrono::system_clock::now();
    lastWriteFrame_ = 0;
    primed_ = true;
    return true;
}

void GameMetricsWriter::SampleTick(int64_t tickUs) {
    if (!primed_ || ringCap_ == 0)
        return;
    tickRing_[ringPos_] = tickUs;
    ringPos_ = (ringPos_ + 1) % ringCap_;
    if (ringCount_ < ringCap_)
        ringCount_++;
}

int64_t GameMetricsWriter::Percentile95Us() const {
    if (ringCount_ == 0)
        return 0;
    std::vector<int64_t> tmp(tickRing_.begin(), tickRing_.begin() + ringCount_);
    std::sort(tmp.begin(), tmp.end());
    // Nearest-rank p95.
    size_t idx = static_cast<size_t>(0.95 * (tmp.size() - 1) + 0.5);
    if (idx >= tmp.size())
        idx = tmp.size() - 1;
    return tmp[idx];
}

int64_t GameMetricsWriter::DbSizeBytes() const {
    if (!db_)
        return 0;
    int64_t pageCount = 0, pageSize = 0;
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, "PRAGMA page_count", -1, &stmt, nullptr) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW)
            pageCount = sqlite3_column_int64(stmt, 0);
        sqlite3_finalize(stmt);
    }
    if (sqlite3_prepare_v2(db_, "PRAGMA page_size", -1, &stmt, nullptr) == SQLITE_OK) {
        if (sqlite3_step(stmt) == SQLITE_ROW)
            pageSize = sqlite3_column_int64(stmt, 0);
        sqlite3_finalize(stmt);
    }
    return pageCount * pageSize;
}

bool GameMetricsWriter::DueForWrite() const {
    if (!primed_ || !db_)
        return false;
    const auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(
                             std::chrono::steady_clock::now() - lastWriteSteady_).count();
    return elapsed >= cadenceSec_;
}

void GameMetricsWriter::MaybeWrite(int frame, int clientCount, int entityCount,
                                   float simFps, float speedFactor, bool simRunning,
                                   const std::string& extraJson) {
    if (!primed_ || !db_)
        return;
    const auto now = std::chrono::steady_clock::now();
    const auto elapsed =
        std::chrono::duration_cast<std::chrono::seconds>(now - lastWriteSteady_).count();
    if (elapsed < cadenceSec_)
        return;
    WriteNow(frame, clientCount, entityCount, simFps, speedFactor, simRunning, extraJson);
}

void GameMetricsWriter::WriteNow(int frame, int clientCount, int entityCount,
                                 float simFps, float speedFactor, bool simRunning,
                                 const std::string& extraJson) {
    if (!primed_ || !db_)
        return;

    const auto now = std::chrono::steady_clock::now();
    const double windowSec =
        std::chrono::duration_cast<std::chrono::duration<double>>(now - lastWriteSteady_).count();

    // Frames-behind: over this window, how many sim frames the game *should*
    // have produced (wall × GAME_SPEED × speed) minus what it produced. Only
    // meaningful while actively ticking — a paused/empty game reports 0, not a
    // spurious backlog. Clamped at 0 (running ahead isn't "behind").
    int64_t framesBehind = 0;
    if (simRunning && windowSec > 0.0 && speedFactor > 0.0f) {
        const double expected = windowSec * kGameSpeed * static_cast<double>(speedFactor);
        const double produced = static_cast<double>(frame - lastWriteFrame_);
        framesBehind = static_cast<int64_t>(std::max(0.0, expected - produced));
    }

    WriteRow(frame, clientCount, entityCount, simFps, framesBehind, extraJson);

    const int64_t nowEpoch =
        std::chrono::duration_cast<std::chrono::seconds>(startWall_.time_since_epoch()).count() +
        static_cast<int64_t>(
            std::chrono::duration_cast<std::chrono::seconds>(now - startSteady_).count());
    Downsample(nowEpoch);

    lastWriteSteady_ = now;
    lastWriteFrame_ = frame;
}

void GameMetricsWriter::WriteRow(int frame, int clientCount, int entityCount, float simFps,
                                 int64_t framesBehind, const std::string& extraJson) {
    const int64_t uptimeSec =
        std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - startSteady_).count();

    const char* sql =
        "INSERT INTO game_metrics "
        "(room_id, frame, taken_at, resolution, tick_us, tick_p95_us, frames_behind, "
        " entity_count, client_count, sim_fps, uptime_sec, db_size_bytes, "
        " snapshot_age_sec, extra_json) "
        "VALUES (?, ?, strftime('%s','now'), 'raw', ?, ?, ?, ?, ?, ?, ?, ?, -1, ?)";
    sqlite3_stmt* stmt = nullptr;
    if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) != SQLITE_OK) {
        SLOG(SPRING_LOG_ERROR, "game_metrics insert prepare failed: %s", sqlite3_errmsg(db_));
        return;
    }

    // tick_us: most-recent sampled tick (last written ring slot).
    const int64_t lastTickUs = ringCount_ > 0
        ? tickRing_[(ringPos_ + ringCap_ - 1) % ringCap_] : 0;

    int c = 1;
    sqlite3_bind_int(stmt, c++, static_cast<int>(roomId_));
    sqlite3_bind_int(stmt, c++, frame);
    sqlite3_bind_int64(stmt, c++, lastTickUs);
    sqlite3_bind_int64(stmt, c++, Percentile95Us());
    sqlite3_bind_int64(stmt, c++, framesBehind);
    sqlite3_bind_int(stmt, c++, entityCount);
    sqlite3_bind_int(stmt, c++, clientCount);
    sqlite3_bind_double(stmt, c++, simFps);
    sqlite3_bind_int64(stmt, c++, uptimeSec);
    sqlite3_bind_int64(stmt, c++, DbSizeBytes());
    sqlite3_bind_text(stmt, c++, extraJson.c_str(), -1, SQLITE_TRANSIENT);

    if (sqlite3_step(stmt) != SQLITE_DONE)
        SLOG(SPRING_LOG_ERROR, "game_metrics insert failed: %s", sqlite3_errmsg(db_));
    sqlite3_finalize(stmt);
}

void GameMetricsWriter::Downsample(int64_t nowEpoch) {
    const int64_t cutoff = nowEpoch - kRawRetentionSec;

    // Step 1: for raw rows older than the retention window, promote the
    // newest row of each hour to 'hourly' (keep one representative per hour).
    {
        const char* sql =
            "UPDATE game_metrics SET resolution='hourly' "
            "WHERE room_id=? AND resolution='raw' AND taken_at < ? AND id IN ("
            "  SELECT MAX(id) FROM game_metrics "
            "  WHERE room_id=? AND resolution='raw' AND taken_at < ? "
            "  GROUP BY taken_at/3600)";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) == SQLITE_OK) {
            sqlite3_bind_int(stmt, 1, static_cast<int>(roomId_));
            sqlite3_bind_int64(stmt, 2, cutoff);
            sqlite3_bind_int(stmt, 3, static_cast<int>(roomId_));
            sqlite3_bind_int64(stmt, 4, cutoff);
            sqlite3_step(stmt);
            sqlite3_finalize(stmt);
        }
    }
    // Step 2: delete the raw non-survivors older than the window.
    {
        const char* sql =
            "DELETE FROM game_metrics "
            "WHERE room_id=? AND resolution='raw' AND taken_at < ?";
        sqlite3_stmt* stmt = nullptr;
        if (sqlite3_prepare_v2(db_, sql, -1, &stmt, nullptr) == SQLITE_OK) {
            sqlite3_bind_int(stmt, 1, static_cast<int>(roomId_));
            sqlite3_bind_int64(stmt, 2, cutoff);
            sqlite3_step(stmt);
            sqlite3_finalize(stmt);
        }
    }
}
