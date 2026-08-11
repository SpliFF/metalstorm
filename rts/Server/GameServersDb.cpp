#include "GameServersDb.h"

#include <sqlite3.h>

int GameServersDb::DeleteForRoom(sqlite3* db, uint32_t roomId) {
    if (!db) return 0;
    // Named one by one rather than looped over a table list: each of the three
    // is a separate contract with a separate writer, and a table added to this
    // schema must be a decision here, not a silent inclusion.
    static const char* kSql[] = {
        "DELETE FROM game_servers WHERE room_id=?",
        "DELETE FROM game_status  WHERE room_id=?",
        "DELETE FROM war_summary  WHERE room_id=?",
    };
    int deleted = 0;
    for (const char* sql : kSql) {
        sqlite3_stmt* st = nullptr;
        if (sqlite3_prepare_v2(db, sql, -1, &st, nullptr) != SQLITE_OK) {
            // Table absent on a database that predates it. Not an error: the
            // row cannot be inherited if it cannot exist.
            sqlite3_finalize(st);
            continue;
        }
        sqlite3_bind_int(st, 1, static_cast<int>(roomId));
        sqlite3_step(st);
        sqlite3_finalize(st);
        deleted += sqlite3_changes(db);
    }
    return deleted;
}

void GameServersDb::EnsureTables(sqlite3* db) {
    if (!db) return;
    // Probe for the newest-added column. A failure means either the table
    // is missing or it predates that column; drop+recreate is acceptable in
    // dev because this table is a real-time mirror of in-memory state
    // (gameServers in lobby_main.cpp), not the durable source of truth.
    {
        sqlite3_stmt* stmt = nullptr;
        int rc = sqlite3_prepare_v2(db,
            "SELECT map_id FROM game_servers LIMIT 1", -1, &stmt, nullptr);
        sqlite3_finalize(stmt);
        if (rc != SQLITE_OK) {
            sqlite3_exec(db, "DROP TABLE IF EXISTS game_servers", nullptr, nullptr, nullptr);
        }
    }
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS game_servers ("
        "  room_id INTEGER PRIMARY KEY,"
        "  port INTEGER NOT NULL,"
        "  pid INTEGER NOT NULL,"
        "  map_id TEXT,"
        "  game_id TEXT,"
        "  started_at INTEGER DEFAULT (strftime('%s','now')),"
        "  state TEXT DEFAULT 'starting'"
        ")", nullptr, nullptr, nullptr);
    // game_status — liveness/readiness published by each running game server
    // (spring-server is the only writer; the lobby + tooling only read it).
    // Created here too so reads work before the first game ever launches.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS game_status ("
        "  room_id INTEGER PRIMARY KEY,"
        "  ready INTEGER NOT NULL DEFAULT 0,"
        "  client_count INTEGER NOT NULL DEFAULT 0,"
        "  pid INTEGER NOT NULL DEFAULT 0,"
        "  port INTEGER NOT NULL DEFAULT 0,"
        "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))"
        ")", nullptr, nullptr, nullptr);
    // war_summary — the per-war digest a running war publishes for the war
    // browser (PLAN-metalstorm-lobby.md §4, task 6). Same rendezvous shape as
    // game_status: spring-server is the only writer, the lobby only reads.
    // Created here as well so the browser's SELECT works on a lobby that has
    // never launched a war — otherwise every room JSON build would log a
    // prepare failure until the first war starts.
    sqlite3_exec(db,
        "CREATE TABLE IF NOT EXISTS war_summary ("
        "  room_id INTEGER PRIMARY KEY,"
        "  summary_json TEXT NOT NULL DEFAULT '',"
        "  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))"
        ")", nullptr, nullptr, nullptr);
}
