#include <doctest/doctest.h>

#include "Server/GameServersDb.h"

#include <sqlite3.h>
#include <string>

// DECISIONS.md Part 6 — the sibling symptom of the un-owned lobby crash: a
// game_servers table created before the `map_id` column existed made every
// subsequent persistGameServer/removeGameServer prepare fail (logged as
// "ExecPrepared prepare failed: table game_servers has no column named
// map_id") for the rest of the process lifetime, because the table was only
// ever created with a bare `CREATE TABLE IF NOT EXISTS` — a real column
// addition is a no-op against an existing table. EnsureTables now probes for
// `map_id` and drops+recreates on a stale schema, same pattern as
// RoomManager::EnsureTables / MapMetadataDb::EnsureTable.

namespace {

bool HasColumn(sqlite3* db, const std::string& table, const std::string& column) {
    sqlite3_stmt* stmt = nullptr;
    const std::string sql = "SELECT " + column + " FROM " + table + " LIMIT 1";
    int rc = sqlite3_prepare_v2(db, sql.c_str(), -1, &stmt, nullptr);
    sqlite3_finalize(stmt);
    return rc == SQLITE_OK;
}

}  // namespace

TEST_CASE("GameServersDb.EnsureTables creates game_servers and game_status fresh") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);

    GameServersDb::EnsureTables(db);

    CHECK(HasColumn(db, "game_servers", "map_id"));
    CHECK(HasColumn(db, "game_servers", "game_id"));
    CHECK(HasColumn(db, "game_status", "ready"));
    sqlite3_close(db);
}

TEST_CASE("GameServersDb.EnsureTables migrates a stale pre-map_id schema instead of leaving it broken") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);

    // Simulate a lobby DB from before the `map_id` column was added, with a
    // live row already in it (the scenario that used to wedge persistence).
    REQUIRE(sqlite3_exec(db,
        "CREATE TABLE game_servers ("
        "  room_id INTEGER PRIMARY KEY,"
        "  port INTEGER NOT NULL,"
        "  pid INTEGER NOT NULL,"
        "  game_id TEXT,"
        "  started_at INTEGER,"
        "  state TEXT"
        ")", nullptr, nullptr, nullptr) == SQLITE_OK);
    REQUIRE(sqlite3_exec(db,
        "INSERT INTO game_servers (room_id, port, pid, game_id, state) "
        "VALUES (1, 8452, 999, 'metalstorm', 'running')",
        nullptr, nullptr, nullptr) == SQLITE_OK);
    REQUIRE_FALSE(HasColumn(db, "game_servers", "map_id"));

    GameServersDb::EnsureTables(db);

    // Migrated to the current schema — map_id is now selectable ...
    CHECK(HasColumn(db, "game_servers", "map_id"));
    // ... and a fresh INSERT naming map_id (what persistGameServer does)
    // succeeds instead of failing to prepare.
    sqlite3_stmt* stmt = nullptr;
    int rc = sqlite3_prepare_v2(db,
        "INSERT OR REPLACE INTO game_servers (room_id, port, pid, map_id, game_id, state) "
        "VALUES (2, 8453, 1000, 'someplanet', 'metalstorm', 'starting')",
        -1, &stmt, nullptr);
    REQUIRE(rc == SQLITE_OK);
    CHECK(sqlite3_step(stmt) == SQLITE_DONE);
    sqlite3_finalize(stmt);

    sqlite3_close(db);
}

TEST_CASE("GameServersDb.EnsureTables is idempotent and preserves rows on a current schema") {
    sqlite3* db = nullptr;
    REQUIRE(sqlite3_open(":memory:", &db) == SQLITE_OK);

    GameServersDb::EnsureTables(db);
    REQUIRE(sqlite3_exec(db,
        "INSERT INTO game_servers (room_id, port, pid, map_id, game_id, state) "
        "VALUES (5, 8500, 42, 'redcomet', 'zk', 'running')",
        nullptr, nullptr, nullptr) == SQLITE_OK);

    GameServersDb::EnsureTables(db);  // second call — must not drop the table

    sqlite3_stmt* stmt = nullptr;
    REQUIRE(sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM game_servers", -1, &stmt, nullptr) == SQLITE_OK);
    REQUIRE(sqlite3_step(stmt) == SQLITE_ROW);
    CHECK(sqlite3_column_int(stmt, 0) == 1);
    sqlite3_finalize(stmt);

    sqlite3_close(db);
}
