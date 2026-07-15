// GameServersDb — SQLite schema for the `game_servers` / `game_status`
// tables the lobby maintains in real time so external tools (MCP debug
// server, springcli, the admin dashboard) can discover running game server
// ports without querying the lobby HTTP API.

#pragma once

struct sqlite3;

class GameServersDb {
public:
    /// Ensure the game_servers / game_status tables exist at the current
    /// schema version. If the schema is stale (probe for the newest column
    /// fails) game_servers is dropped and recreated. Same pattern as
    /// RoomManager::EnsureTables / MapMetadataDb::EnsureTable — call before
    /// any INSERT/SELECT against either table.
    ///
    /// A DB created before `map_id` was added to game_servers would
    /// otherwise silently fail every persistGameServer/removeGameServer
    /// prepare for the rest of the process lifetime (logged as "ExecPrepared
    /// prepare failed: table game_servers has no column named map_id").
    static void EnsureTables(sqlite3* db);
};
