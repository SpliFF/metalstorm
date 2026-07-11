#include <doctest/doctest.h>

#include "Server/GameMetrics.h"

#include <sqlite3.h>
#include <ctime>
#include <string>

// PLAN-gm-tools task 1 — the per-game metric writer. The writer borrows the
// caller's sqlite3 handle, so these tests hold the same handle to read back
// what it wrote. Covers p95, the cadence gate, and the E5 downsampling.

namespace {

int64_t scalar(sqlite3* db, const std::string& sql) {
    sqlite3_stmt* s = nullptr;
    int64_t v = -1;
    if (sqlite3_prepare_v2(db, sql.c_str(), -1, &s, nullptr) == SQLITE_OK &&
        sqlite3_step(s) == SQLITE_ROW)
        v = sqlite3_column_int64(s, 0);
    sqlite3_finalize(s);
    return v;
}

void insertOldRaw(sqlite3* db, int roomId, int64_t takenAt) {
    sqlite3_stmt* s = nullptr;
    const char* sql =
        "INSERT INTO game_metrics (room_id, frame, taken_at, resolution) "
        "VALUES (?, 0, ?, 'raw')";
    if (sqlite3_prepare_v2(db, sql, -1, &s, nullptr) == SQLITE_OK) {
        sqlite3_bind_int(s, 1, roomId);
        sqlite3_bind_int64(s, 2, takenAt);
        sqlite3_step(s);
    }
    sqlite3_finalize(s);
}

}  // namespace

TEST_CASE("GameMetricsWriter writes a row with correct p95 and last-tick") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    GameMetricsWriter w;
    REQUIRE(w.Init(db, /*roomId=*/5, /*cadenceSec=*/60));

    for (int i = 1; i <= 100; i++) w.SampleTick(i);   // tick durations 1..100 µs
    w.WriteNow(/*frame=*/300, /*clients=*/2, /*entities=*/42,
               /*simFps=*/29.5f, /*speed=*/1.0f, /*running=*/true);

    CHECK(scalar(db, "SELECT COUNT(*) FROM game_metrics WHERE room_id=5") == 1);
    // Nearest-rank p95 over 1..100 = 95; last sampled tick = 100.
    CHECK(scalar(db, "SELECT tick_p95_us FROM game_metrics WHERE room_id=5") == 95);
    CHECK(scalar(db, "SELECT tick_us FROM game_metrics WHERE room_id=5") == 100);
    CHECK(scalar(db, "SELECT entity_count FROM game_metrics WHERE room_id=5") == 42);
    CHECK(scalar(db, "SELECT client_count FROM game_metrics WHERE room_id=5") == 2);
    // db_size is engine-sourced and non-zero (PRAGMA page_count*page_size).
    CHECK(scalar(db, "SELECT db_size_bytes FROM game_metrics WHERE room_id=5") > 0);
    sqlite3_close(db);
}

TEST_CASE("GameMetricsWriter.MaybeWrite respects the cadence gate") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    GameMetricsWriter w;
    REQUIRE(w.Init(db, /*roomId=*/1, /*cadenceSec=*/3600));   // 1-hour cadence

    w.SampleTick(10);
    w.MaybeWrite(1, 0, 0, 30.0f, 1.0f, true);   // far under cadence → no row
    CHECK(scalar(db, "SELECT COUNT(*) FROM game_metrics WHERE room_id=1") == 0);

    w.WriteNow(2, 0, 0, 30.0f, 1.0f, true);     // forced → one row
    CHECK(scalar(db, "SELECT COUNT(*) FROM game_metrics WHERE room_id=1") == 1);
    sqlite3_close(db);
}

TEST_CASE("GameMetricsWriter downsamples raw rows older than 7 days to hourly") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);
    GameMetricsWriter w;
    REQUIRE(w.Init(db, /*roomId=*/9, /*cadenceSec=*/60));   // Init creates the table

    // Two whole hours, 10 days ago (older than the 7-day raw window). Floor to an
    // hour boundary so all rows in a group share taken_at/3600.
    const int64_t now = static_cast<int64_t>(std::time(nullptr));
    const int64_t hourA = (now / 3600 - 240) * 3600;   // 240h ≈ 10 days back
    const int64_t hourB = hourA + 3600;
    for (int i = 0; i < 5; i++) insertOldRaw(db, 9, hourA + i);   // hour A: 5 rows
    for (int i = 0; i < 3; i++) insertOldRaw(db, 9, hourB + i);   // hour B: 3 rows
    CHECK(scalar(db, "SELECT COUNT(*) FROM game_metrics WHERE room_id=9") == 8);

    // A fresh write triggers the downsample pass.
    w.WriteNow(1, 0, 0, 30.0f, 1.0f, false);

    // Each old hour collapses to exactly one 'hourly' row; the old raw rows are
    // gone; the fresh write is the only remaining 'raw' row.
    CHECK(scalar(db, "SELECT COUNT(*) FROM game_metrics WHERE room_id=9 AND resolution='hourly'") == 2);
    CHECK(scalar(db, "SELECT COUNT(*) FROM game_metrics WHERE room_id=9 AND resolution='raw'") == 1);
    CHECK(scalar(db, "SELECT COUNT(*) FROM game_metrics WHERE room_id=9") == 3);
    sqlite3_close(db);
}
