#include "GameServersDb.h"

#include <sqlite3.h>

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
