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
    int countdownSeconds = 0;

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
