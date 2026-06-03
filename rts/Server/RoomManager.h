// RoomManager — manages game rooms and their state machines.
//
// Room lifecycle:
//   CONFIGURING → FILLING → READY_CHECK → LOADING → ACTIVE → ENDED
//
// Each room tracks players, teams, readiness, and transitions.
// The server can host multiple rooms simultaneously.
#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

struct sqlite3;

using ClientID = uint32_t;

enum class ERoomState : uint8_t {
    Configuring = 0,
    Filling,
    ReadyCheck,
    Loading,
    Active,
    Ended,
};

struct RoomPlayer {
    uint32_t playerId = 0;
    ClientID clientId = 0;
    std::string username;
    uint8_t team = 0;
    bool ready = false;
    bool isSpectator = false;
    bool isHost = false;
    /// Map start position index (into the map's start_positions
    /// array). -1 means "unassigned" — the lobby auto-fills on
    /// game start if it's still -1 at that point.
    int8_t startPos = -1;
};

/// An AI player slot in a room. Populated by the host via
/// RoomAddAI messages before the game starts. At game launch, the
/// lobby translates these into `--ai id:team:pos` args for spring-server,
/// which runs its own AIDiscovery and loads the matching plugin.
///
/// Unlike RoomPlayer, AI slots have no playerId or clientId — they
/// don't consume a session. A room can have arbitrarily many AI
/// slots up to a per-room limit enforced by RoomManager.
struct RoomAISlot {
    std::string aiId;         // stable id (folder name), matches AIInfo::id
    std::string displayName;  // human-readable label from ai.config
    uint8_t team = 0;
    /// Same semantics as RoomPlayer.startPos — -1 means auto-fill
    /// at game start.
    int8_t startPos = -1;
};

/// Result of a LeaveRoom call, telling the caller what action to take.
enum class LeaveResult : uint8_t {
    Left,           // Player removed; room still has humans
    HostTransferred,// Host left; new host assigned
    Abandoned,      // Last human left non-persistent room; room deleted
    StillPersistent,// Last human left a persistent room; room stays
    NotFound,       // Room or player not found
};

struct GameRoom {
    uint32_t id = 0;
    std::string name;
    std::string mapId;
    std::string gameId;
    ERoomState state = ERoomState::Configuring;
    uint8_t maxPlayers = 8;
    std::string password;      // empty = no password
    uint32_t hostPlayerId = 0;

    /// When true, the room persists even with zero human players.
    /// The original host retains host status indefinitely. Only
    /// the persistent host can modify or end the game. Used for
    /// AI testing, persistent worlds, etc.
    bool persistent = false;

    std::vector<RoomPlayer> players;

    /// AI players slotted into this room by the host. Empty until
    /// the host adds the first one. Preserved across room state
    /// transitions up to game start, at which point the roster is
    /// handed off to spring-server via --ai command-line args.
    std::vector<RoomAISlot> aiSlots;

    int countdownSeconds = 0;
    uint16_t gameServerPort = 0;   // set when game server is spawned

    /// Original player roster at game start (for reconnection).
    /// Maps playerId → team. Set when room transitions to Loading.
    std::unordered_map<uint32_t, uint8_t> originalRoster;

    /// Check if a player was in the original game roster.
    bool WasOriginalPlayer(uint32_t playerId) const {
        return originalRoster.count(playerId) > 0;
    }

    /// Get original team for a reconnecting player. Returns -1 if not found.
    int GetOriginalTeam(uint32_t playerId) const {
        auto it = originalRoster.find(playerId);
        return (it != originalRoster.end()) ? static_cast<int>(it->second) : -1;
    }

    // --- Helpers ---

    RoomPlayer* FindPlayer(uint32_t playerId) {
        for (auto& p : players)
            if (p.playerId == playerId) return &p;
        return nullptr;
    }

    RoomPlayer* FindPlayerByClient(ClientID clientId) {
        for (auto& p : players)
            if (p.clientId == clientId) return &p;
        return nullptr;
    }

    bool IsFull() const {
        int nonSpectators = 0;
        for (const auto& p : players)
            if (!p.isSpectator) nonSpectators++;
        return nonSpectators >= maxPlayers;
    }

    bool AllReady() const {
        for (const auto& p : players)
            if (!p.isSpectator && !p.ready) return false;
        return !players.empty();
    }

    int PlayerCount() const { return static_cast<int>(players.size()); }
};

class RoomManager {
public:
    /// Attach a SQLite database for write-through persistence. When set,
    /// every state-changing method writes to both the in-memory map and
    /// the `rooms` / `room_members` / `room_ai_slots` tables.
    ///
    /// The lobby calls this once at startup. spring-server does not
    /// (its RoomManager is process-local for the lifetime of the game
    /// and should not race the lobby on the same tables).
    ///
    /// Caller owns the sqlite3* and must call this with nullptr (or
    /// destroy the RoomManager) before closing the handle.
    void SetDatabase(sqlite3* db);

    /// Ensure the rooms / room_members / room_ai_slots tables exist
    /// at the current schema version. If the schema is stale (probe
    /// for the newest column fails) the tables are dropped and
    /// recreated. Same pattern as MapMetadataDb::EnsureTable.
    static void EnsureTables(sqlite3* db);

    /// Replay the rooms / room_members / room_ai_slots tables into
    /// memory. Called once at lobby startup before the main loop, so
    /// the room browser is correct from the first request. Sets
    /// nextRoomId to MAX(rooms.id)+1 so freshly-created rooms don't
    /// reuse the id of a still-running game.
    void LoadFromDatabase();

    /// Create a new room. Returns room ID.
    uint32_t CreateRoom(const std::string& name, const std::string& mapId,
                        const std::string& gameId, uint8_t maxPlayers,
                        const std::string& password,
                        uint32_t hostPlayerId, ClientID hostClientId,
                        const std::string& hostUsername,
                        bool persistent = false);

    /// Join a room. Returns true on success.
    bool JoinRoom(uint32_t roomId, uint32_t playerId, ClientID clientId,
                  const std::string& username, const std::string& password,
                  bool asSpectator = false);

    /// Leave a room. Returns what happened so the caller can take
    /// appropriate action (e.g. kill game server on Abandoned).
    LeaveResult LeaveRoom(uint32_t roomId, uint32_t playerId);

    /// Set a player's team.
    bool SetTeam(uint32_t roomId, uint32_t playerId, uint8_t team);

    /// Set a player's ready state.
    bool SetReady(uint32_t roomId, uint32_t playerId, bool ready);

    /// Kick a player (host only).
    bool KickPlayer(uint32_t roomId, uint32_t requesterId, uint32_t targetId);

    /// Delete a room unconditionally (internal use — called after
    /// LeaveRoom returns Abandoned). Callers must kill any game
    /// subprocess before calling this.
    void DeleteRoom(uint32_t roomId);

    /// Reap abandoned rooms.
    ///
    /// The lobby is HTTP-only: there is no persistent lobby socket whose
    /// disconnect could abandon a room (RemoveClient is never called), so
    /// non-persistent rooms with no running game accumulate in the DB and
    /// survive lobby restarts via LoadFromDatabase. This removes any room
    /// that is (a) not persistent, (b) not hosting a live game
    /// (gameServerPort == 0 and state ∉ {Loading, Active}), and (c) has not
    /// been touched (`rooms.updated_at`) within `maxIdleSeconds`.
    ///
    /// Staleness is a proxy for player presence — the HTTP lobby tracks no
    /// liveness signal, so a room is judged abandoned by how long since its
    /// last mutation. Persistent rooms and rooms with a live game server are
    /// always kept. `maxIdleSeconds <= 0` reaps every eligible room
    /// regardless of age (force-clean). Returns the ids reaped so the caller
    /// can release any associated resources and refresh the room browser.
    std::vector<uint32_t> ReapStaleRooms(int64_t maxIdleSeconds);

    /// Add an AI slot to the room (host only). `aiId` / `displayName`
    /// are opaque strings from the lobby's AIDiscovery list; the
    /// caller is responsible for validating the id against the
    /// discovered set before calling. Returns true on success.
    /// Fails if the requester is not the host, the room is past
    /// Filling (too late to add AI), or the AI slot cap is reached.
    bool AddAISlot(uint32_t roomId, uint32_t requesterId,
                   const std::string& aiId,
                   const std::string& displayName,
                   uint8_t team);

    /// Remove the AI slot at `slotIndex` (host only). Out-of-range
    /// indices are silently ignored.
    bool RemoveAISlot(uint32_t roomId, uint32_t requesterId,
                      uint8_t slotIndex);

    /// Reassign the AI slot at `slotIndex` to a different team
    /// (host only). Start position is preserved. Returns false if
    /// the requester is not the host or the index is out of range.
    bool SetAITeam(uint32_t roomId, uint32_t requesterId,
                   uint8_t slotIndex, uint8_t team);

    /// Set the start position for a player slot.
    ///
    /// Permissions: a player can only set their own slot; the host
    /// can set any player's slot. `posIndex == -1` clears the slot
    /// (it'll be auto-assigned at game start).
    ///
    /// Returns false if the requester lacks permission, the target
    /// player doesn't exist in the room, the position is out of
    /// range for `maxStartPos`, or the position is already taken
    /// by another slot.
    bool SetPlayerStartPos(uint32_t roomId, uint32_t requesterId,
                           uint32_t targetPlayerId, int8_t posIndex,
                           int8_t maxStartPos);

    /// Set the start position for an AI slot. Host-only; otherwise
    /// same semantics as SetPlayerStartPos.
    bool SetAIStartPos(uint32_t roomId, uint32_t requesterId,
                       uint8_t slotIndex, int8_t posIndex,
                       int8_t maxStartPos);

    /// Persist `room.gameServerPort` and the host's `start_pos` after
    /// AutoAssignStartPositions runs. Called by the lobby right
    /// before spawning the game subprocess. No-op when no DB is set.
    void PersistRoomGameSession(uint32_t roomId);

    /// Auto-assign unassigned start positions in the room. Called
    /// by the lobby at game-start time so any slot that still has
    /// `startPos == -1` gets a concrete index before the roster is
    /// handed off to spring-server. Positions are picked in
    /// ascending order from the pool `[0, maxStartPos)`, skipping
    /// anything already taken. Slots that can't be auto-assigned
    /// (not enough unique positions in the map) are left at -1
    /// and the caller decides whether to proceed or error.
    void AutoAssignStartPositions(uint32_t roomId, int8_t maxStartPos);

    /// Start the game (host triggers, requires all players ready).
    bool StartGame(uint32_t roomId, uint32_t requesterId);

    /// Transition a room to a new state.
    void SetRoomState(uint32_t roomId, ERoomState newState);

    /// Recycle a room after its game subprocess has exited. Puts
    /// the room back into Filling state, clears per-player ready
    /// flags, zeroes the stored gameServerPort, and drops the
    /// original-roster reconnection map. Called by the health-check
    /// loop in lobby_main when a game's subprocess dies so the
    /// same room can immediately host another game without the
    /// host having to close + recreate it. No-op on unknown roomId.
    void ResetRoomForNextGame(uint32_t roomId);

    /// Get a room by ID.
    GameRoom* GetRoom(uint32_t roomId);

    /// Get all rooms (for room browser).
    std::vector<GameRoom*> GetAllRooms();

    /// Find which room a client is in.
    GameRoom* FindRoomByClient(ClientID clientId);

    /// Remove a client from any room they're in.
    void RemoveClient(ClientID clientId);

private:
    // --- SQLite write-through helpers (no-op when db is null) ---
    void PersistRoomLocked(const GameRoom& room);
    void DeleteRoomFromDb(uint32_t roomId);
    void PersistMembersLocked(const GameRoom& room);
    void PersistAISlotsLocked(const GameRoom& room);

    std::recursive_mutex mutex;
    std::unordered_map<uint32_t, GameRoom> rooms;
    uint32_t nextRoomId = 1;
    sqlite3* db = nullptr;
};
