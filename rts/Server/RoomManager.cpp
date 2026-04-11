// RoomManager — game room lifecycle management.

#include "RoomManager.h"
#include <algorithm>
#include <cstdio>

uint32_t RoomManager::CreateRoom(
    const std::string& name, const std::string& mapName,
    const std::string& gameName, uint8_t maxPlayers,
    const std::string& password,
    uint32_t hostPlayerId, ClientID hostClientId,
    const std::string& hostUsername)
{
    std::lock_guard<std::mutex> lock(mutex);

    uint32_t id = nextRoomId++;
    GameRoom& room = rooms[id];
    room.id = id;
    room.name = name;
    room.mapName = mapName;
    room.gameName = gameName;
    room.maxPlayers = maxPlayers;
    room.password = password;
    room.hostPlayerId = hostPlayerId;
    room.state = ERoomState::Filling;

    RoomPlayer host;
    host.playerId = hostPlayerId;
    host.clientId = hostClientId;
    host.username = hostUsername;
    host.team = 0;
    host.isHost = true;
    room.players.push_back(host);

    std::fprintf(stderr, "[room] created room %u '%s' (host=%s, map=%s)\n",
        id, name.c_str(), hostUsername.c_str(), mapName.c_str());
    return id;
}

bool RoomManager::JoinRoom(
    uint32_t roomId, uint32_t playerId, ClientID clientId,
    const std::string& username, const std::string& password,
    bool asSpectator)
{
    std::lock_guard<std::mutex> lock(mutex);

    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;

    GameRoom& room = it->second;

    // Allow joining Active/Loading rooms (reconnect or spectate)
    bool isActive = (room.state == ERoomState::Loading || room.state == ERoomState::Active);
    if (!isActive && room.state != ERoomState::Filling) return false;
    if (!room.password.empty() && password != room.password) return false;

    // If player is already in the room, update their clientId (reconnection)
    auto* existing = room.FindPlayer(playerId);
    if (existing) {
        existing->clientId = clientId;
        std::fprintf(stderr, "[room] player '%s' reconnected to room %u (updated clientId)\n",
            username.c_str(), roomId);
        return true;
    }

    RoomPlayer player;
    player.playerId = playerId;
    player.clientId = clientId;
    player.username = username;

    if (isActive) {
        // Check if this player was in the original roster (reconnecting)
        int originalTeam = room.GetOriginalTeam(playerId);
        if (originalTeam >= 0) {
            player.isSpectator = false;
            player.team = static_cast<uint8_t>(originalTeam);
            player.ready = true;
            std::fprintf(stderr, "[room] player '%s' RECONNECTED to room %u team %d\n",
                username.c_str(), roomId, originalTeam);
        } else {
            // New player joining active game = spectator
            player.isSpectator = true;
            std::fprintf(stderr, "[room] player '%s' joined room %u as spectator (in progress)\n",
                username.c_str(), roomId);
        }
    } else {
        // Filling state — normal join
        player.isSpectator = asSpectator;
        if (!asSpectator) {
            if (room.IsFull()) return false;
            int team0 = 0, team1 = 0;
            for (const auto& p : room.players) {
                if (!p.isSpectator) {
                    if (p.team == 0) team0++;
                    else team1++;
                }
            }
            player.team = (team0 <= team1) ? 0 : 1;
        }
        std::fprintf(stderr, "[room] player '%s' joined room %u%s\n",
            username.c_str(), roomId, asSpectator ? " (spectator)" : "");
    }

    room.players.push_back(player);
    return true;
}

void RoomManager::LeaveRoom(uint32_t roomId, uint32_t playerId) {
    std::lock_guard<std::mutex> lock(mutex);

    auto it = rooms.find(roomId);
    if (it == rooms.end()) return;

    GameRoom& room = it->second;
    auto& players = room.players;
    players.erase(
        std::remove_if(players.begin(), players.end(),
            [playerId](const RoomPlayer& p) { return p.playerId == playerId; }),
        players.end());

    // If host left, promote next player or delete room
    if (playerId == room.hostPlayerId) {
        if (!players.empty()) {
            players[0].isHost = true;
            room.hostPlayerId = players[0].playerId;
            std::fprintf(stderr, "[room] host left room %u, promoted '%s'\n",
                roomId, players[0].username.c_str());
        } else {
            std::fprintf(stderr, "[room] room %u empty, removing\n", roomId);
            rooms.erase(it);
        }
    }
}

bool RoomManager::SetTeam(uint32_t roomId, uint32_t playerId, uint8_t team) {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    auto* player = it->second.FindPlayer(playerId);
    if (!player || player->isSpectator) return false;
    player->team = team;
    return true;
}

bool RoomManager::SetReady(uint32_t roomId, uint32_t playerId, bool ready) {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    auto* player = it->second.FindPlayer(playerId);
    if (!player) return false;
    player->ready = ready;
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
    std::lock_guard<std::mutex> lock(mutex);
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

    std::fprintf(stderr, "[room] room %u: host added AI '%s' to team %u (slots=%zu)\n",
        roomId, aiId.c_str(), static_cast<unsigned>(team), room.aiSlots.size());
    return true;
}

bool RoomManager::RemoveAISlot(
    uint32_t roomId, uint32_t requesterId, uint8_t slotIndex)
{
    std::lock_guard<std::mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;

    if (room.hostPlayerId != requesterId) return false;
    if (slotIndex >= room.aiSlots.size()) return false;

    const std::string removedId = room.aiSlots[slotIndex].aiId;
    room.aiSlots.erase(room.aiSlots.begin() + slotIndex);
    std::fprintf(stderr, "[room] room %u: host removed AI '%s' (slot %u)\n",
        roomId, removedId.c_str(), static_cast<unsigned>(slotIndex));
    return true;
}

bool RoomManager::KickPlayer(uint32_t roomId, uint32_t requesterId, uint32_t targetId) {
    std::lock_guard<std::mutex> lock(mutex);
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
    return players.size() < before;
}

bool RoomManager::StartGame(uint32_t roomId, uint32_t requesterId) {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;
    if (room.hostPlayerId != requesterId) return false;
    if (room.state != ERoomState::Filling) return false;
    if (!room.AllReady()) return false;

    room.state = ERoomState::Loading;
    std::fprintf(stderr, "[room] room %u transitioning to LOADING\n", roomId);
    return true;
}

void RoomManager::SetRoomState(uint32_t roomId, ERoomState newState) {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return;
    it->second.state = newState;
}

GameRoom* RoomManager::GetRoom(uint32_t roomId) {
    auto it = rooms.find(roomId);
    return (it != rooms.end()) ? &it->second : nullptr;
}

std::vector<GameRoom*> RoomManager::GetAllRooms() {
    std::vector<GameRoom*> result;
    for (auto& [id, room] : rooms)
        result.push_back(&room);
    return result;
}

GameRoom* RoomManager::FindRoomByClient(ClientID clientId) {
    for (auto& [id, room] : rooms) {
        if (room.FindPlayerByClient(clientId))
            return &room;
    }
    return nullptr;
}

void RoomManager::RemoveClient(ClientID clientId) {
    for (auto& [id, room] : rooms) {
        auto* player = room.FindPlayerByClient(clientId);
        if (player) {
            LeaveRoom(id, player->playerId);
            return;
        }
    }
}
