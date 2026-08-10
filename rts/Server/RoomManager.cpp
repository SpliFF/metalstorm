// RoomManager — game room lifecycle management.

#include "RoomManager.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "lobby"

#include <algorithm>
#include <cstdio>
#include <set>
#include <sqlite3.h>

// ============================================================
// SQLite schema + write-through persistence
// ============================================================
//
// Three tables — `rooms`, `room_members`, `room_ai_slots` — hold the
// full lobby state so it survives a `spring-lobby` restart. Schema
// versioning follows the same pattern as `maps`: probe for the
// newest-added column; if it's missing, DROP+CREATE.
//
// Write-through: every mutation method that lands in this file
// updates the in-memory `rooms` map first, then mirrors the change
// into SQLite. Reads still come from memory — the DB is purely
// durable storage and the source of truth for "what existed before
// the lobby restarted".

void RoomManager::SetDatabase(sqlite3* d) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    db = d;
}

void RoomManager::EnsureTables(sqlite3* db) {
    if (!db) return;
    // Probe for the newest-added column on each table. A failure means
    // either the table is missing or its schema is stale; drop+recreate
    // is acceptable in dev because this is process-local lobby state
    // (no production-grade migration required for Phase A).
    {
        sqlite3_stmt* stmt = nullptr;
        int rc = sqlite3_prepare_v2(db,
            "SELECT persistent FROM rooms LIMIT 1", -1, &stmt, nullptr);
        sqlite3_finalize(stmt);
        if (rc != SQLITE_OK) {
            sqlite3_exec(db, "DROP TABLE IF EXISTS rooms", nullptr, nullptr, nullptr);
            sqlite3_exec(db, "DROP TABLE IF EXISTS room_members", nullptr, nullptr, nullptr);
            sqlite3_exec(db, "DROP TABLE IF EXISTS room_ai_slots", nullptr, nullptr, nullptr);
            sqlite3_exec(db, "DROP TABLE IF EXISTS room_mod_options", nullptr, nullptr, nullptr);
        }
    }
    {
        // Second probe, same pattern: room_ai_slots grew a `profile` column
        // (PLAN-metalstorm-ai.md §10 task 6) after the table above had
        // already shipped, so its own staleness isn't caught by the
        // `persistent` probe alone.
        sqlite3_stmt* stmt = nullptr;
        int rc = sqlite3_prepare_v2(db,
            "SELECT profile FROM room_ai_slots LIMIT 1", -1, &stmt, nullptr);
        sqlite3_finalize(stmt);
        if (rc != SQLITE_OK) {
            sqlite3_exec(db, "DROP TABLE IF EXISTS rooms", nullptr, nullptr, nullptr);
            sqlite3_exec(db, "DROP TABLE IF EXISTS room_members", nullptr, nullptr, nullptr);
            sqlite3_exec(db, "DROP TABLE IF EXISTS room_ai_slots", nullptr, nullptr, nullptr);
            sqlite3_exec(db, "DROP TABLE IF EXISTS room_mod_options", nullptr, nullptr, nullptr);
        }
    }
    sqlite3_exec(db, R"(
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            host_player_id INTEGER NOT NULL,
            map_id TEXT,
            game_id TEXT,
            max_players INTEGER NOT NULL DEFAULT 8,
            password TEXT NOT NULL DEFAULT '',
            state INTEGER NOT NULL DEFAULT 1,
            game_server_port INTEGER NOT NULL DEFAULT 0,
            persistent INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );
    )", nullptr, nullptr, nullptr);
    sqlite3_exec(db, R"(
        CREATE TABLE IF NOT EXISTS room_members (
            room_id INTEGER NOT NULL,
            player_id INTEGER NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            team INTEGER NOT NULL DEFAULT 0,
            start_pos INTEGER NOT NULL DEFAULT -1,
            ready INTEGER NOT NULL DEFAULT 0,
            is_spectator INTEGER NOT NULL DEFAULT 0,
            is_host INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (room_id, player_id)
        );
    )", nullptr, nullptr, nullptr);
    sqlite3_exec(db, R"(
        CREATE TABLE IF NOT EXISTS room_ai_slots (
            room_id INTEGER NOT NULL,
            slot_index INTEGER NOT NULL,
            ai_id TEXT NOT NULL,
            display_name TEXT NOT NULL DEFAULT '',
            team INTEGER NOT NULL DEFAULT 0,
            start_pos INTEGER NOT NULL DEFAULT -1,
            profile TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (room_id, slot_index)
        );
    )", nullptr, nullptr, nullptr);
    sqlite3_exec(db, R"(
        CREATE TABLE IF NOT EXISTS room_mod_options (
            room_id INTEGER NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (room_id, key)
        );
    )", nullptr, nullptr, nullptr);
}

// Helper: bind a std::string to a sqlite stmt parameter (1-based) as
// transient — sqlite copies, so the source string can go out of scope.
static void BindText(sqlite3_stmt* s, int idx, const std::string& v) {
    sqlite3_bind_text(s, idx, v.c_str(), -1, SQLITE_TRANSIENT);
}

void RoomManager::PersistRoomLocked(const GameRoom& room) {
    if (!db) return;
    static const char* kSql =
        "INSERT INTO rooms (id, name, host_player_id, map_id, game_id, "
        "  max_players, password, state, game_server_port, persistent, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s','now')) "
        "ON CONFLICT(id) DO UPDATE SET "
        "  name=excluded.name, host_player_id=excluded.host_player_id, "
        "  map_id=excluded.map_id, game_id=excluded.game_id, "
        "  max_players=excluded.max_players, password=excluded.password, "
        "  state=excluded.state, game_server_port=excluded.game_server_port, "
        "  persistent=excluded.persistent, updated_at=strftime('%s','now')";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, kSql, -1, &s, nullptr) != SQLITE_OK) {
        SLOG(SPRING_LOG_WARNING, "PersistRoom prepare failed: %s", sqlite3_errmsg(db));
        return;
    }
    sqlite3_bind_int(s, 1, static_cast<int>(room.id));
    BindText(s, 2, room.name);
    sqlite3_bind_int(s, 3, static_cast<int>(room.hostPlayerId));
    BindText(s, 4, room.mapId);
    BindText(s, 5, room.gameId);
    sqlite3_bind_int(s, 6, room.maxPlayers);
    BindText(s, 7, room.password);
    sqlite3_bind_int(s, 8, static_cast<int>(room.state));
    sqlite3_bind_int(s, 9, room.gameServerPort);
    sqlite3_bind_int(s, 10, room.persistent ? 1 : 0);
    if (sqlite3_step(s) != SQLITE_DONE) {
        SLOG(SPRING_LOG_WARNING, "PersistRoom step failed: %s", sqlite3_errmsg(db));
    }
    sqlite3_finalize(s);
    PersistMembersLocked(room);
    PersistAISlotsLocked(room);
    PersistModOptionsLocked(room);
}

void RoomManager::PersistMembersLocked(const GameRoom& room) {
    if (!db) return;
    // Simplest correct strategy: wipe + reinsert. Rosters are small
    // (≤16 players) and this avoids upsert vs. delete bookkeeping per
    // player. Wrap in a single transaction so a read-mid-write doesn't
    // see an empty roster.
    sqlite3_exec(db, "BEGIN", nullptr, nullptr, nullptr);
    {
        char sql[128];
        snprintf(sql, sizeof(sql),
            "DELETE FROM room_members WHERE room_id=%u", room.id);
        sqlite3_exec(db, sql, nullptr, nullptr, nullptr);
    }
    static const char* kInsert =
        "INSERT INTO room_members (room_id, player_id, username, team, "
        "start_pos, ready, is_spectator, is_host) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, kInsert, -1, &s, nullptr) == SQLITE_OK) {
        for (const auto& p : room.players) {
            sqlite3_reset(s);
            sqlite3_bind_int(s, 1, static_cast<int>(room.id));
            sqlite3_bind_int(s, 2, static_cast<int>(p.playerId));
            BindText(s, 3, p.username);
            sqlite3_bind_int(s, 4, p.team);
            sqlite3_bind_int(s, 5, p.startPos);
            sqlite3_bind_int(s, 6, p.ready ? 1 : 0);
            sqlite3_bind_int(s, 7, p.isSpectator ? 1 : 0);
            sqlite3_bind_int(s, 8, p.isHost ? 1 : 0);
            if (sqlite3_step(s) != SQLITE_DONE) {
                SLOG(SPRING_LOG_WARNING, "PersistMembers step: %s",
                    sqlite3_errmsg(db));
            }
        }
        sqlite3_finalize(s);
    }
    sqlite3_exec(db, "COMMIT", nullptr, nullptr, nullptr);
}

void RoomManager::PersistAISlotsLocked(const GameRoom& room) {
    if (!db) return;
    sqlite3_exec(db, "BEGIN", nullptr, nullptr, nullptr);
    {
        char sql[128];
        snprintf(sql, sizeof(sql),
            "DELETE FROM room_ai_slots WHERE room_id=%u", room.id);
        sqlite3_exec(db, sql, nullptr, nullptr, nullptr);
    }
    static const char* kInsert =
        "INSERT INTO room_ai_slots (room_id, slot_index, ai_id, "
        "display_name, team, start_pos, profile) VALUES (?, ?, ?, ?, ?, ?, ?)";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, kInsert, -1, &s, nullptr) == SQLITE_OK) {
        for (size_t i = 0; i < room.aiSlots.size(); ++i) {
            const auto& slot = room.aiSlots[i];
            sqlite3_reset(s);
            sqlite3_bind_int(s, 1, static_cast<int>(room.id));
            sqlite3_bind_int(s, 2, static_cast<int>(i));
            BindText(s, 3, slot.aiId);
            BindText(s, 4, slot.displayName);
            sqlite3_bind_int(s, 5, slot.team);
            sqlite3_bind_int(s, 6, slot.startPos);
            BindText(s, 7, slot.profile);
            if (sqlite3_step(s) != SQLITE_DONE) {
                SLOG(SPRING_LOG_WARNING, "PersistAISlots step: %s",
                    sqlite3_errmsg(db));
            }
        }
        sqlite3_finalize(s);
    }
    sqlite3_exec(db, "COMMIT", nullptr, nullptr, nullptr);
}

void RoomManager::PersistModOptionsLocked(const GameRoom& room) {
    if (!db) return;
    sqlite3_exec(db, "BEGIN", nullptr, nullptr, nullptr);
    {
        char sql[128];
        snprintf(sql, sizeof(sql),
            "DELETE FROM room_mod_options WHERE room_id=%u", room.id);
        sqlite3_exec(db, sql, nullptr, nullptr, nullptr);
    }
    static const char* kInsert =
        "INSERT INTO room_mod_options (room_id, key, value) VALUES (?, ?, ?)";
    sqlite3_stmt* s = nullptr;
    if (sqlite3_prepare_v2(db, kInsert, -1, &s, nullptr) == SQLITE_OK) {
        for (const auto& kv : room.modOptions) {
            sqlite3_reset(s);
            sqlite3_bind_int(s, 1, static_cast<int>(room.id));
            BindText(s, 2, kv.first);
            BindText(s, 3, kv.second);
            if (sqlite3_step(s) != SQLITE_DONE) {
                SLOG(SPRING_LOG_WARNING, "PersistModOptions step: %s",
                    sqlite3_errmsg(db));
            }
        }
        sqlite3_finalize(s);
    }
    sqlite3_exec(db, "COMMIT", nullptr, nullptr, nullptr);
}

void RoomManager::DeleteRoomFromDb(uint32_t roomId) {
    if (!db) return;
    char sql[160];
    snprintf(sql, sizeof(sql), "DELETE FROM rooms WHERE id=%u", roomId);
    sqlite3_exec(db, sql, nullptr, nullptr, nullptr);
    snprintf(sql, sizeof(sql), "DELETE FROM room_members WHERE room_id=%u", roomId);
    sqlite3_exec(db, sql, nullptr, nullptr, nullptr);
    snprintf(sql, sizeof(sql), "DELETE FROM room_ai_slots WHERE room_id=%u", roomId);
    sqlite3_exec(db, sql, nullptr, nullptr, nullptr);
    snprintf(sql, sizeof(sql), "DELETE FROM room_mod_options WHERE room_id=%u", roomId);
    sqlite3_exec(db, sql, nullptr, nullptr, nullptr);
}

void RoomManager::LoadFromDatabase() {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    if (!db) return;
    rooms.clear();

    // 1. Rooms
    {
        const char* kSql =
            "SELECT id, name, host_player_id, map_id, game_id, max_players, "
            "password, state, game_server_port, persistent FROM rooms";
        sqlite3_stmt* s = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &s, nullptr) == SQLITE_OK) {
            while (sqlite3_step(s) == SQLITE_ROW) {
                GameRoom r;
                r.id = static_cast<uint32_t>(sqlite3_column_int(s, 0));
                const unsigned char* nm = sqlite3_column_text(s, 1);
                r.name = nm ? reinterpret_cast<const char*>(nm) : "";
                r.hostPlayerId = static_cast<uint32_t>(sqlite3_column_int(s, 2));
                const unsigned char* mi = sqlite3_column_text(s, 3);
                r.mapId = mi ? reinterpret_cast<const char*>(mi) : "";
                const unsigned char* gi = sqlite3_column_text(s, 4);
                r.gameId = gi ? reinterpret_cast<const char*>(gi) : "";
                r.maxPlayers = static_cast<uint8_t>(sqlite3_column_int(s, 5));
                const unsigned char* pw = sqlite3_column_text(s, 6);
                r.password = pw ? reinterpret_cast<const char*>(pw) : "";
                r.state = static_cast<ERoomState>(sqlite3_column_int(s, 7));
                r.gameServerPort = static_cast<uint16_t>(sqlite3_column_int(s, 8));
                r.persistent = (sqlite3_column_int(s, 9) != 0);
                rooms[r.id] = std::move(r);
            }
            sqlite3_finalize(s);
        }
    }

    // 2. Members
    {
        const char* kSql =
            "SELECT room_id, player_id, username, team, start_pos, "
            "ready, is_spectator, is_host FROM room_members";
        sqlite3_stmt* s = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &s, nullptr) == SQLITE_OK) {
            while (sqlite3_step(s) == SQLITE_ROW) {
                uint32_t rid = static_cast<uint32_t>(sqlite3_column_int(s, 0));
                auto it = rooms.find(rid);
                if (it == rooms.end()) continue;
                RoomPlayer p;
                p.playerId = static_cast<uint32_t>(sqlite3_column_int(s, 1));
                p.clientId = 0;  // re-established when the client reconnects
                const unsigned char* un = sqlite3_column_text(s, 2);
                p.username = un ? reinterpret_cast<const char*>(un) : "";
                p.team = static_cast<uint8_t>(sqlite3_column_int(s, 3));
                p.startPos = static_cast<int8_t>(sqlite3_column_int(s, 4));
                p.ready = (sqlite3_column_int(s, 5) != 0);
                p.isSpectator = (sqlite3_column_int(s, 6) != 0);
                p.isHost = (sqlite3_column_int(s, 7) != 0);
                it->second.players.push_back(std::move(p));
            }
            sqlite3_finalize(s);
        }
    }

    // 3. AI slots — preserve slot_index ordering
    {
        const char* kSql =
            "SELECT room_id, ai_id, display_name, team, start_pos, profile "
            "FROM room_ai_slots ORDER BY room_id, slot_index";
        sqlite3_stmt* s = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &s, nullptr) == SQLITE_OK) {
            while (sqlite3_step(s) == SQLITE_ROW) {
                uint32_t rid = static_cast<uint32_t>(sqlite3_column_int(s, 0));
                auto it = rooms.find(rid);
                if (it == rooms.end()) continue;
                RoomAISlot slot;
                const unsigned char* ai = sqlite3_column_text(s, 1);
                slot.aiId = ai ? reinterpret_cast<const char*>(ai) : "";
                const unsigned char* dn = sqlite3_column_text(s, 2);
                slot.displayName = dn ? reinterpret_cast<const char*>(dn) : "";
                slot.team = static_cast<uint8_t>(sqlite3_column_int(s, 3));
                slot.startPos = static_cast<int8_t>(sqlite3_column_int(s, 4));
                const unsigned char* pr = sqlite3_column_text(s, 5);
                slot.profile = pr ? reinterpret_cast<const char*>(pr) : "";
                it->second.aiSlots.push_back(std::move(slot));
            }
            sqlite3_finalize(s);
        }
    }

    // 4. Mod options
    {
        const char* kSql =
            "SELECT room_id, key, value FROM room_mod_options";
        sqlite3_stmt* s = nullptr;
        if (sqlite3_prepare_v2(db, kSql, -1, &s, nullptr) == SQLITE_OK) {
            while (sqlite3_step(s) == SQLITE_ROW) {
                uint32_t rid = static_cast<uint32_t>(sqlite3_column_int(s, 0));
                auto it = rooms.find(rid);
                if (it == rooms.end()) continue;
                const unsigned char* k = sqlite3_column_text(s, 1);
                const unsigned char* v = sqlite3_column_text(s, 2);
                if (!k) continue;
                it->second.modOptions[reinterpret_cast<const char*>(k)] =
                    v ? reinterpret_cast<const char*>(v) : "";
            }
            sqlite3_finalize(s);
        }
    }

    // 5. nextRoomId = MAX(id)+1 so we don't collide with adopted rooms.
    nextRoomId = 1;
    {
        sqlite3_stmt* s = nullptr;
        if (sqlite3_prepare_v2(db, "SELECT MAX(id) FROM rooms", -1, &s, nullptr)
            == SQLITE_OK)
        {
            if (sqlite3_step(s) == SQLITE_ROW
                && sqlite3_column_type(s, 0) != SQLITE_NULL)
            {
                nextRoomId = static_cast<uint32_t>(sqlite3_column_int(s, 0)) + 1;
            }
            sqlite3_finalize(s);
        }
    }

    SLOG(SPRING_LOG_NOTICE, "loaded %zu room(s) from db, nextRoomId=%u",
        rooms.size(), nextRoomId);
}

uint32_t RoomManager::CreateRoom(
    const std::string& name, const std::string& mapId,
    const std::string& gameId, uint8_t maxPlayers,
    const std::string& password,
    uint32_t hostPlayerId, ClientID hostClientId,
    const std::string& hostUsername,
    bool persistent, const std::string& hostFactionId)
{
    std::lock_guard<std::recursive_mutex> lock(mutex);

    uint32_t id = nextRoomId++;
    GameRoom& room = rooms[id];
    room.id = id;
    room.name = name;
    room.mapId = mapId;
    room.gameId = gameId;
    room.maxPlayers = maxPlayers;
    room.password = password;
    room.hostPlayerId = hostPlayerId;
    room.persistent = persistent;
    room.state = ERoomState::Filling;

    RoomPlayer host;
    host.playerId = hostPlayerId;
    host.clientId = hostClientId;
    host.username = hostUsername;
    // Team 0 is provisional: the room has no `war_sides` yet (the caller
    // applies the scenario after this returns), so the host's side is settled
    // afterwards by the lobby's seatHostOnSide, which reads this faction.
    host.team = 0;
    host.factionId = hostFactionId;
    host.isHost = true;
    room.players.push_back(host);

    SLOG(SPRING_LOG_INFO, "created room %u '%s' (host=%s, map=%s)",
        id, name.c_str(), hostUsername.c_str(), mapId.c_str());
    PersistRoomLocked(room);
    return id;
}

bool RoomManager::JoinRoom(
    uint32_t roomId, uint32_t playerId, ClientID clientId,
    const std::string& username, const std::string& password,
    bool asSpectator, const std::string& factionId)
{
    std::lock_guard<std::recursive_mutex> lock(mutex);

    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;

    GameRoom& room = it->second;

    // Allow joining Active/Loading rooms (reconnect or spectate)
    bool isActive = (room.state == ERoomState::Loading || room.state == ERoomState::Active);
    if (!isActive && room.state != ERoomState::Filling) return false;
    if (!room.password.empty() && password != room.password) return false;

    // If player is already in the room, update their clientId (reconnection).
    // clientId itself isn't persisted (it's a transient session
    // identifier), so there's nothing to flush to SQLite here.
    auto* existing = room.FindPlayer(playerId);
    if (existing) {
        existing->clientId = clientId;
        SLOG(SPRING_LOG_INFO, "player '%s' reconnected to room %u (updated clientId)",
            username.c_str(), roomId);
        return true;
    }

    RoomPlayer player;
    player.playerId = playerId;
    player.clientId = clientId;
    player.username = username;
    player.factionId = factionId;

    if (isActive) {
        // Check if this player was in the original roster (reconnecting)
        int originalTeam = room.GetOriginalTeam(playerId);
        if (originalTeam >= 0) {
            player.isSpectator = false;
            player.team = static_cast<uint8_t>(originalTeam);
            player.ready = true;
            SLOG(SPRING_LOG_INFO, "player '%s' RECONNECTED to room %u team %d",
                username.c_str(), roomId, originalTeam);
        } else {
            // New player joining active game = spectator
            player.isSpectator = true;
            SLOG(SPRING_LOG_INFO, "player '%s' joined room %u as spectator (in progress)",
                username.c_str(), roomId);
        }
    } else {
        // Filling state — normal join
        player.isSpectator = asSpectator;
        if (!asSpectator) {
            if (room.IsFull()) return false;
            // A player's faction outranks the balancer. `faction_id` is a
            // permanent, immutable allegiance chosen at sign-up, so seating a
            // union account on compact because compact happened to be emptier
            // is not "balancing", it is overruling the one choice the account
            // model calls permanent (endtoend D40 — measured live twice: two
            // accounts registered `union` and were both seated on compact).
            // Deliberately unconditional on occupancy: a lopsided war is a
            // content/AI problem, a player fighting for the wrong side is a
            // broken promise.
            const std::optional<uint8_t> sideTeam =
                room.TeamForFaction(factionId);
            if (sideTeam) {
                player.team = *sideTeam;
                SLOG(SPRING_LOG_INFO,
                    "player '%s' seated on team %u — faction '%s'",
                    username.c_str(), static_cast<unsigned>(*sideTeam),
                    factionId.c_str());
            } else {
                // No side for this account's faction (or no faction at all):
                // seat on the least-occupied of the room's slot teams, in
                // offer order. This used to hardcode 0-vs-1, which on a
                // scenario whose sides are teams 0 and 4 dropped every joiner
                // onto team 1 — a team the scenario stages no army for
                // (endtoend D19, PLAN-metalstorm-wars.md §7.4). On a legacy
                // two-team room SlotTeams() is {0,1} and this is the same
                // round-robin it always was.
                if (!factionId.empty())
                    SLOG(SPRING_LOG_NOTICE,
                        "room %u declares no side for '%s' faction '%s' — "
                        "seating by balance instead",
                        roomId, username.c_str(), factionId.c_str());
                const std::vector<uint8_t> slotTeams = room.SlotTeams();
                player.team = slotTeams.front();
                size_t best = static_cast<size_t>(-1);
                for (const uint8_t t : slotTeams) {
                    size_t occupants = 0;
                    for (const auto& p : room.players)
                        if (!p.isSpectator && p.team == t) occupants++;
                    for (const auto& a : room.aiSlots)
                        if (a.team == t) occupants++;
                    if (occupants < best) {
                        best = occupants;
                        player.team = t;
                    }
                }
            }
        }
        SLOG(SPRING_LOG_INFO, "player '%s' joined room %u%s",
            username.c_str(), roomId, asSpectator ? " (spectator)" : "");
    }

    room.players.push_back(player);
    PersistMembersLocked(room);
    return true;
}

LeaveResult RoomManager::LeaveRoom(uint32_t roomId, uint32_t playerId) {
    std::lock_guard<std::recursive_mutex> lock(mutex);

    auto it = rooms.find(roomId);
    if (it == rooms.end()) return LeaveResult::NotFound;

    GameRoom& room = it->second;
    auto& players = room.players;

    // Check the player is actually in the room
    bool found = false;
    for (const auto& p : players)
        if (p.playerId == playerId) { found = true; break; }
    if (!found) return LeaveResult::NotFound;

    bool wasHost = (playerId == room.hostPlayerId);

    players.erase(
        std::remove_if(players.begin(), players.end(),
            [playerId](const RoomPlayer& p) { return p.playerId == playerId; }),
        players.end());

    // Room is now empty of human players
    if (players.empty()) {
        if (room.persistent) {
            // Persistent rooms survive with 0 humans.
            // Host stays set to the original host.
            SLOG(SPRING_LOG_INFO, "room %u: last human left (persistent, keeping)",
                roomId);
            PersistMembersLocked(room);
            return LeaveResult::StillPersistent;
        }
        SLOG(SPRING_LOG_INFO, "room %u: last human left, abandoning", roomId);
        // Don't erase here — caller needs the room data to find
        // the game server. Caller calls DeleteRoom() after cleanup,
        // and DeleteRoom takes care of the SQLite cascade.
        return LeaveResult::Abandoned;
    }

    // Host left but other humans remain — transfer host
    if (wasHost) {
        // Pick a random human player as new host
        size_t idx = static_cast<size_t>(rand()) % players.size();
        players[idx].isHost = true;
        room.hostPlayerId = players[idx].playerId;
        SLOG(SPRING_LOG_INFO, "room %u: host left, promoted '%s'",
            roomId, players[idx].username.c_str());
        PersistRoomLocked(room);   // host_player_id changed
        return LeaveResult::HostTransferred;
    }

    PersistMembersLocked(room);
    return LeaveResult::Left;
}

bool RoomManager::SetTeam(uint32_t roomId, uint32_t playerId, uint8_t team) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    auto* player = it->second.FindPlayer(playerId);
    if (!player || player->isSpectator) return false;
    player->team = team;
    PersistMembersLocked(it->second);
    return true;
}

bool RoomManager::SetReady(uint32_t roomId, uint32_t playerId, bool ready) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    auto* player = it->second.FindPlayer(playerId);
    if (!player) return false;
    player->ready = ready;
    PersistMembersLocked(it->second);
    return true;
}

bool RoomManager::EnlistSpectator(uint32_t roomId, uint32_t playerId, uint8_t team) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;

    auto* player = it->second.FindPlayer(playerId);
    if (!player) return false;

    // Can only enlist if currently a spectator
    if (!player->isSpectator) return false;

    // Check if room is full (excluding spectators)
    if (it->second.IsFull()) return false;

    // Auto-assign team if 255
    if (team == 255) {
        // Faction first, exactly as in JoinRoom (D40) — an "auto" seat is
        // still a seat chosen for the player, and a spectator who enlists
        // must land on their own side. The faction was captured at join
        // time on RoomPlayer, so this needs no new parameter and no DB read.
        // An explicit team (anything but 255) is the host or the player
        // choosing on purpose and is left alone; `war_sides` is an offer,
        // not a whitelist.
        const auto sideTeam = it->second.TeamForFaction(player->factionId);
        if (sideTeam) {
            team = *sideTeam;
            SLOG(SPRING_LOG_INFO,
                "player '%s' enlisting on team %u — faction '%s'",
                player->username.c_str(), static_cast<unsigned>(team),
                player->factionId.c_str());
        } else {
            // Find the next available team (simple round-robin)
            std::set<uint8_t> usedTeams;
            for (const auto& p : it->second.players) {
                if (!p.isSpectator) {
                    usedTeams.insert(p.team);
                }
            }
            for (const auto& ai : it->second.aiSlots) {
                usedTeams.insert(ai.team);
            }

            // Assign to the first unoccupied slot team, or the first one if
            // every side is taken. Walks the room's offered teams rather than
            // 0..maxPlayers, so an enlisting spectator lands on a side the
            // scenario actually stages an army for (§7.4).
            //
            // Deliberate behaviour change for a legacy room with maxPlayers > 2:
            // this used to be the ONE path that could seat somebody on team 2 or
            // 3, while JoinRoom above only ever produced 0 or 1 and the room
            // screen only ever offered two. Enlist was the outlier — it could put
            // a player on a team the rest of the room could not represent — and
            // it now agrees with them. On a 2-slot room this is identical.
            const std::vector<uint8_t> slotTeams = it->second.SlotTeams();
            team = slotTeams.front();
            for (const uint8_t t : slotTeams) {
                if (usedTeams.find(t) == usedTeams.end()) {
                    team = t;
                    break;
                }
            }
        }
    }

    // Convert spectator to player
    player->isSpectator = false;
    player->team = team;
    player->ready = false;  // Reset ready state on enlist

    // TODO(PLAN-metalstorm-onboarding §3): Auto-add mentor AI for first-session accounts.
    // Hook point: if Database::GetSessionCount(playerId) <= 1 (or last_login IS NULL),
    // call AddAISlot(roomId, playerId, "strategos", "Mentor", team) to spawn the
    // suggest-only co-commander (profiles/mentor.lua). Requires:
    //   1. Database::GetSessionCount() or similar first-session signal
    //   2. Passing Database* to EnlistSpectator, or accessing via a member field
    //   3. Game-specific check (mentor is Metalstorm-only; other games may not have it)
    // Deferred: the session-tracking infrastructure doesn't exist yet. When implemented,
    // insert the check + AddAISlot call here, before PersistMembersLocked.

    PersistMembersLocked(it->second);
    return true;
}

/// Hard cap on how many AI slots a single room can hold. Mostly a
/// sanity check — the real limit comes from the game's max-team
/// count, but that lives in the game definition, not the lobby.
/// 16 is comfortably larger than any realistic RTS team layout.
static constexpr size_t kMaxAISlotsPerRoom = 16;

bool RoomManager::AddAISlot(
    uint32_t roomId, uint32_t requesterId,
    const std::string& aiId,
    const std::string& displayName,
    uint8_t team)
{
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;

    // Host-only. The lobby main loop also checks this, but defence
    // in depth keeps the RoomManager self-consistent if another
    // code path forgets the guard.
    if (room.hostPlayerId != requesterId) return false;

    // Only allowed before the game starts — once the room is in
    // Loading/Active/Ended, the AI roster has already been handed
    // off to spring-server and changing it in the lobby would have
    // no effect anyway.
    if (room.state != ERoomState::Filling &&
        room.state != ERoomState::Configuring &&
        room.state != ERoomState::ReadyCheck) {
        return false;
    }

    if (room.aiSlots.size() >= kMaxAISlotsPerRoom) return false;
    if (aiId.empty()) return false;

    RoomAISlot slot;
    slot.aiId = aiId;
    slot.displayName = displayName.empty() ? aiId : displayName;
    slot.team = team;
    room.aiSlots.push_back(std::move(slot));

    SLOG(SPRING_LOG_INFO, "room %u: host added AI '%s' to team %u (slots=%zu)",
        roomId, aiId.c_str(), static_cast<unsigned>(team), room.aiSlots.size());
    PersistAISlotsLocked(room);
    return true;
}

bool RoomManager::RemoveAISlot(
    uint32_t roomId, uint32_t requesterId, uint8_t slotIndex)
{
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;

    if (room.hostPlayerId != requesterId) return false;
    if (slotIndex >= room.aiSlots.size()) return false;

    const std::string removedId = room.aiSlots[slotIndex].aiId;
    room.aiSlots.erase(room.aiSlots.begin() + slotIndex);
    SLOG(SPRING_LOG_INFO, "room %u: host removed AI '%s' (slot %u)",
        roomId, removedId.c_str(), static_cast<unsigned>(slotIndex));
    PersistAISlotsLocked(room);
    return true;
}

bool RoomManager::SetModOption(
    uint32_t roomId, uint32_t requesterId,
    const std::string& key, const std::string& value)
{
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;

    // Host-only, pre-game only. After the roster is handed off to
    // spring-server (Loading/Active/Ended) the modoptions are already
    // baked into the spawned process and the def-cache key, so a late
    // change would have no effect.
    if (room.hostPlayerId != requesterId) return false;
    if (room.state != ERoomState::Filling &&
        room.state != ERoomState::Configuring &&
        room.state != ERoomState::ReadyCheck) {
        return false;
    }
    if (key.empty()) return false;

    if (value.empty()) {
        room.modOptions.erase(key);
        SLOG(SPRING_LOG_INFO, "room %u: host cleared modoption '%s'",
            roomId, key.c_str());
    } else {
        room.modOptions[key] = value;
        SLOG(SPRING_LOG_INFO, "room %u: host set modoption '%s'='%s'",
            roomId, key.c_str(), value.c_str());
    }
    PersistModOptionsLocked(room);
    return true;
}

bool RoomManager::SetAITeam(
    uint32_t roomId, uint32_t requesterId,
    uint8_t slotIndex, uint8_t team)
{
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;

    // Host-only, same as AddAISlot / RemoveAISlot. AI slots have
    // no intrinsic owner besides the host.
    if (room.hostPlayerId != requesterId) return false;
    if (slotIndex >= room.aiSlots.size()) return false;

    room.aiSlots[slotIndex].team = team;
    SLOG(SPRING_LOG_INFO, "room %u: ai slot %u (%s) team -> %u",
        roomId, static_cast<unsigned>(slotIndex),
        room.aiSlots[slotIndex].aiId.c_str(),
        static_cast<unsigned>(team));
    PersistAISlotsLocked(room);
    return true;
}

bool RoomManager::SetAIProfile(
    uint32_t roomId, uint32_t requesterId,
    uint8_t slotIndex, const std::string& profile)
{
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;

    // Host-only, same as AddAISlot / SetAITeam. AI slots have no
    // intrinsic owner besides the host.
    if (room.hostPlayerId != requesterId) return false;
    if (slotIndex >= room.aiSlots.size()) return false;

    room.aiSlots[slotIndex].profile = profile;
    SLOG(SPRING_LOG_INFO, "room %u: ai slot %u (%s) profile -> '%s'",
        roomId, static_cast<unsigned>(slotIndex),
        room.aiSlots[slotIndex].aiId.c_str(), profile.c_str());
    PersistAISlotsLocked(room);
    return true;
}

/// Helper: returns true if `pos` is already held by any player or
/// AI slot in `room` — EXCLUDING the slot identified by
/// `excludePlayerId` / `excludeAISlot`, so a caller that's trying
/// to re-set its own slot's position (e.g. to the same value)
/// doesn't collide with itself.
static bool IsStartPosTaken(const GameRoom& room, int8_t pos,
                            uint32_t excludePlayerId,
                            int excludeAISlot)
{
    if (pos < 0) return false;
    for (const auto& p : room.players) {
        if (p.playerId == excludePlayerId) continue;
        if (p.startPos == pos) return true;
    }
    for (size_t i = 0; i < room.aiSlots.size(); ++i) {
        if (static_cast<int>(i) == excludeAISlot) continue;
        if (room.aiSlots[i].startPos == pos) return true;
    }
    return false;
}

bool RoomManager::SetPlayerStartPos(
    uint32_t roomId, uint32_t requesterId,
    uint32_t targetPlayerId, int8_t posIndex,
    int8_t maxStartPos)
{
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;

    // Permission: player can set own slot; host can set any slot.
    // A targetPlayerId of 0 is shorthand for "the requester's
    // own slot" — callers on the wire protocol side use this so
    // non-host clients don't need to know their own id ahead of
    // the RoomStateUpdate that carries it.
    uint32_t actualTarget = targetPlayerId != 0 ? targetPlayerId : requesterId;
    if (actualTarget != requesterId && room.hostPlayerId != requesterId)
        return false;

    auto* target = room.FindPlayer(actualTarget);
    if (!target) return false;

    // Range: -1 (clear) or [0, maxStartPos).
    if (posIndex < -1) return false;
    if (posIndex >= 0 && (maxStartPos <= 0 || posIndex >= maxStartPos))
        return false;

    // Occupancy: can't take a slot already held by someone else.
    // Setting to the same value we already hold is a no-op, and
    // setting to -1 (clear) never collides.
    if (posIndex >= 0 &&
        IsStartPosTaken(room, posIndex, actualTarget, -1))
        return false;

    target->startPos = posIndex;
    SLOG(SPRING_LOG_DEBUG, "room %u: player %u start pos -> %d",
        roomId, actualTarget, static_cast<int>(posIndex));
    PersistMembersLocked(room);
    return true;
}

bool RoomManager::SetAIStartPos(
    uint32_t roomId, uint32_t requesterId,
    uint8_t slotIndex, int8_t posIndex,
    int8_t maxStartPos)
{
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;

    // Host-only. AI slots don't have a natural "owner" besides the
    // room host.
    if (room.hostPlayerId != requesterId) return false;
    if (slotIndex >= room.aiSlots.size()) return false;

    if (posIndex < -1) return false;
    if (posIndex >= 0 && (maxStartPos <= 0 || posIndex >= maxStartPos))
        return false;

    if (posIndex >= 0 &&
        IsStartPosTaken(room, posIndex, /*excludePlayerId*/ 0,
                        static_cast<int>(slotIndex)))
        return false;

    room.aiSlots[slotIndex].startPos = posIndex;
    SLOG(SPRING_LOG_DEBUG, "room %u: ai slot %u (%s) start pos -> %d",
        roomId, static_cast<unsigned>(slotIndex),
        room.aiSlots[slotIndex].aiId.c_str(),
        static_cast<int>(posIndex));
    PersistAISlotsLocked(room);
    return true;
}

void RoomManager::AutoAssignStartPositions(
    uint32_t roomId, int8_t maxStartPos)
{
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return;
    GameRoom& room = it->second;

    if (maxStartPos <= 0) return;

    // Build a set of positions already held by any slot.
    std::vector<bool> taken(static_cast<size_t>(maxStartPos), false);
    auto mark = [&](int8_t p) {
        if (p >= 0 && p < maxStartPos) taken[p] = true;
    };
    for (const auto& p : room.players) mark(p.startPos);
    for (const auto& s : room.aiSlots) mark(s.startPos);

    // Walk unassigned slots in stable order (players first so humans
    // get the low-numbered spawns, which tend to be the nicer ones
    // on most maps) and hand out the next available index. Slots
    // that still can't be assigned (more slots than the map has
    // positions) stay at -1; SetupTestGame falls back to a derived
    // default for those.
    int8_t nextFree = 0;
    auto nextAvailable = [&]() -> int8_t {
        while (nextFree < maxStartPos && taken[nextFree]) nextFree++;
        if (nextFree >= maxStartPos) return -1;
        taken[nextFree] = true;
        return nextFree++;
    };

    int assigned = 0;
    for (auto& p : room.players) {
        if (p.isSpectator) continue;
        if (p.startPos >= 0) continue;
        const int8_t pick = nextAvailable();
        if (pick < 0) break;
        p.startPos = pick;
        assigned++;
    }
    for (auto& s : room.aiSlots) {
        if (s.startPos >= 0) continue;
        const int8_t pick = nextAvailable();
        if (pick < 0) break;
        s.startPos = pick;
        assigned++;
    }

    if (assigned > 0) {
        SLOG(SPRING_LOG_INFO,
            "room %u: auto-assigned %d start position(s)",
            roomId, assigned);
        PersistMembersLocked(room);
        PersistAISlotsLocked(room);
    }
}

void RoomManager::DeleteRoom(uint32_t roomId) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return;
    SLOG(SPRING_LOG_INFO, "room %u: deleted (was '%s')",
        roomId, it->second.name.c_str());
    DeleteRoomFromDb(roomId);
    rooms.erase(it);
}

std::vector<uint32_t> RoomManager::ReapStaleRooms(int64_t maxIdleSeconds) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    std::vector<uint32_t> reaped;
    if (!db) return reaped;

    // Cutoff time, computed in SQL so we compare against the same clock
    // (strftime('%s','now')) that stamped rooms.updated_at on write.
    //
    // Fail CLOSED on a read error. Every branch below treats a missing value
    // as "stale, reap it", so a faulted handle used to mean the reaper
    // deleted every eligible room on its first tick and logged "idle >
    // 1800s" about rooms created seconds earlier — D33's second symptom.
    // Losing rooms is irreversible; skipping a reap cycle is not.
    int64_t cutoff = 0;
    {
        sqlite3_stmt* s = nullptr;
        bool got = false;
        if (sqlite3_prepare_v2(db, "SELECT strftime('%s','now')", -1, &s, nullptr)
                == SQLITE_OK
            && sqlite3_step(s) == SQLITE_ROW) {
            cutoff = sqlite3_column_int64(s, 0) - maxIdleSeconds;
            got = true;
        }
        if (s) sqlite3_finalize(s);
        if (!got) {
            SLOG(SPRING_LOG_ERROR,
                "ReapStaleRooms: cannot read the clock (%s) — skipping this "
                "reap cycle rather than reaping every room as stale",
                sqlite3_errmsg(db));
            return reaped;
        }
    }

    // Collect candidates first (don't mutate `rooms` mid-iteration).
    for (auto& [id, room] : rooms) {
        if (room.persistent) continue;             // explicitly kept alive
        if (room.gameServerPort != 0) continue;    // hosting a live game
        if (room.state == ERoomState::Loading ||
            room.state == ERoomState::Active) continue;  // mid-game

        // Read the persisted last-touched time. The in-memory GameRoom
        // doesn't carry updated_at, so source it from the DB.
        int64_t updatedAt = 0;
        bool readOk = false;
        sqlite3_stmt* s = nullptr;
        if (sqlite3_prepare_v2(db, "SELECT updated_at FROM rooms WHERE id=?",
                -1, &s, nullptr) == SQLITE_OK) {
            sqlite3_bind_int(s, 1, static_cast<int>(id));
            const int rc = sqlite3_step(s);
            if (rc == SQLITE_ROW) {
                updatedAt = sqlite3_column_int64(s, 0);
                readOk = true;
            } else if (rc == SQLITE_DONE) {
                readOk = true;  // genuinely no row — never persisted
            }
        }
        if (s) sqlite3_finalize(s);

        // A failed read is not evidence of staleness — see the fail-closed
        // note above. Leave the room alone and say so.
        if (!readOk) {
            SLOG(SPRING_LOG_ERROR,
                "ReapStaleRooms: room %u: updated_at read failed (%s) — "
                "NOT reaping; treating a DB fault as staleness would delete "
                "live rooms", id, sqlite3_errmsg(db));
            continue;
        }

        // No row (never persisted) or stale → reap.
        if (updatedAt == 0 || updatedAt < cutoff)
            reaped.push_back(id);
    }

    for (uint32_t id : reaped) {
        SLOG(SPRING_LOG_NOTICE,
            "room %u: reaped (abandoned, idle > %llds)",
            id, static_cast<long long>(maxIdleSeconds));
        DeleteRoomFromDb(id);
        rooms.erase(id);
    }
    return reaped;
}

bool RoomManager::KickPlayer(uint32_t roomId, uint32_t requesterId, uint32_t targetId) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    if (it->second.hostPlayerId != requesterId) return false;
    if (requesterId == targetId) return false;

    auto& players = it->second.players;
    auto before = players.size();
    players.erase(
        std::remove_if(players.begin(), players.end(),
            [targetId](const RoomPlayer& p) { return p.playerId == targetId; }),
        players.end());
    if (players.size() < before) {
        PersistMembersLocked(it->second);
        return true;
    }
    return false;
}

bool RoomManager::StartGame(uint32_t roomId, uint32_t requesterId) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;
    if (room.hostPlayerId != requesterId) return false;
    if (room.state != ERoomState::Filling) return false;
    if (!room.AllReady()) return false;

    room.state = ERoomState::Loading;
    SLOG(SPRING_LOG_INFO, "room %u transitioning to LOADING", roomId);
    PersistRoomLocked(room);
    return true;
}

void RoomManager::ResetRoomForNextGame(uint32_t roomId) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return;
    GameRoom& room = it->second;

    // Back to Filling so RoomManager::StartGame accepts the next
    // Start request. The client's showRoom() already treats Ended
    // as a pregame-equivalent for UI purposes; going back to
    // Filling makes the *state machine* match the UI state too
    // and avoids a dedicated "ended-but-startable" gate inside
    // StartGame.
    room.state = ERoomState::Filling;

    // Clear ready flags so everyone consciously opts in to the
    // next game. Reusing stale ready flags from the previous round
    // would let the host start another game before anyone had
    // time to react — which feels like a silent protocol
    // violation even if it happens to work.
    for (auto& p : room.players)
        p.ready = false;

    // The stored port belongs to the dead subprocess. Leaving it
    // would cause handleRoomState on clients that reconnect post-
    // reset to auto-jump into a dead game canvas.
    room.gameServerPort = 0;

    // The reconnection roster is for the game that just ended.
    // A fresh one will be built on the next RoomStartGame.
    room.originalRoster.clear();

    SLOG(SPRING_LOG_INFO, "room %u recycled for next game", roomId);
    PersistRoomLocked(room);
}

void RoomManager::SetRoomState(uint32_t roomId, ERoomState newState) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return;
    it->second.state = newState;
    PersistRoomLocked(it->second);
}

void RoomManager::PersistRoomGameSession(uint32_t roomId) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return;
    // Called after the lobby finalises gameServerPort and the auto-
    // assigned start positions on the host's RoomStartGame path.
    // Both pieces of state are already in memory; we just flush.
    PersistRoomLocked(it->second);
}

GameRoom* RoomManager::GetRoom(uint32_t roomId) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    auto it = rooms.find(roomId);
    return (it != rooms.end()) ? &it->second : nullptr;
}

std::vector<GameRoom*> RoomManager::GetAllRooms() {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    std::vector<GameRoom*> result;
    for (auto& [id, room] : rooms)
        result.push_back(&room);
    return result;
}

GameRoom* RoomManager::FindRoomByClient(ClientID clientId) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    for (auto& [id, room] : rooms) {
        if (room.FindPlayerByClient(clientId))
            return &room;
    }
    return nullptr;
}

void RoomManager::RemoveClient(ClientID clientId) {
    std::lock_guard<std::recursive_mutex> lock(mutex);
    for (auto& [id, room] : rooms) {
        auto* player = room.FindPlayerByClient(clientId);
        if (player) {
            LeaveRoom(id, player->playerId);
            return;
        }
    }
}
