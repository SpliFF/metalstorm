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
};

/// An AI player slot in a room. Populated by the host via
/// RoomAddAI messages before the game starts. At game launch, the
/// lobby translates these into `--ai id:team` args for spring-server,
/// which runs its own AIDiscovery and loads the matching plugin.
///
/// Unlike RoomPlayer, AI slots have no playerId or clientId — they
/// don't consume a session. A room can have arbitrarily many AI
/// slots up to a per-room limit enforced by RoomManager.
struct RoomAISlot {
    std::string aiId;         // stable id (folder name), matches AIInfo::id
    std::string displayName;  // human-readable label from ai.config
    uint8_t team = 0;
};

struct GameRoom {
    uint32_t id = 0;
    std::string name;
    std::string mapName;
    std::string gameName;
    ERoomState state = ERoomState::Configuring;
    uint8_t maxPlayers = 8;
    std::string password;      // empty = no password
    uint32_t hostPlayerId = 0;

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
    /// Create a new room. Returns room ID.
    uint32_t CreateRoom(const std::string& name, const std::string& mapName,
                        const std::string& gameName, uint8_t maxPlayers,
                        const std::string& password,
                        uint32_t hostPlayerId, ClientID hostClientId,
                        const std::string& hostUsername);

    /// Join a room. Returns true on success.
    bool JoinRoom(uint32_t roomId, uint32_t playerId, ClientID clientId,
                  const std::string& username, const std::string& password,
                  bool asSpectator = false);

    /// Leave a room.
    void LeaveRoom(uint32_t roomId, uint32_t playerId);

    /// Set a player's team.
    bool SetTeam(uint32_t roomId, uint32_t playerId, uint8_t team);

    /// Set a player's ready state.
    bool SetReady(uint32_t roomId, uint32_t playerId, bool ready);

    /// Kick a player (host only).
    bool KickPlayer(uint32_t roomId, uint32_t requesterId, uint32_t targetId);

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

    /// Start the game (host triggers, requires all players ready).
    bool StartGame(uint32_t roomId, uint32_t requesterId);

    /// Transition a room to a new state.
    void SetRoomState(uint32_t roomId, ERoomState newState);

    /// Get a room by ID.
    GameRoom* GetRoom(uint32_t roomId);

    /// Get all rooms (for room browser).
    std::vector<GameRoom*> GetAllRooms();

    /// Find which room a client is in.
    GameRoom* FindRoomByClient(ClientID clientId);

    /// Remove a client from any room they're in.
    void RemoveClient(ClientID clientId);

private:
    std::mutex mutex;
    std::unordered_map<uint32_t, GameRoom> rooms;
    uint32_t nextRoomId = 1;
};
