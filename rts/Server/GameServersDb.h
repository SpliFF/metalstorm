// GameServersDb — SQLite schema for the `game_servers` / `game_status`
// tables the lobby maintains in real time so external tools (MCP debug
// server, springcli, the admin dashboard) can discover running game server
// ports without querying the lobby HTTP API.

#pragma once

#include <cstdint>

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

    /// Drop a room's rows from all three tables — the rendezvous row, the
    /// readiness flag and the war digest. Every one of them is keyed on
    /// `room_id` alone (PRIMARY KEY), so they are inherited wholesale by the
    /// next war handed that number: a fresh room would read "ready" and carry
    /// the population and frame of a war that is over.
    ///
    /// Two callers, deliberately: the lobby's `removeGameServer` (a server
    /// exited but the room survives to host another) and
    /// `RoomManager::DeleteRoomFromDb` (the room itself is gone). The second
    /// is what makes the STARTUP reap safe — it deletes rooms without going
    /// near the lobby's game-server bookkeeping.
    ///
    /// Returns rows deleted across the three tables (0..3).
    static int DeleteForRoom(sqlite3* db, uint32_t roomId);
};
