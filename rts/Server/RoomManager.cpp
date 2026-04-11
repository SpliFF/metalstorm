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

bool RoomManager::SetAITeam(
    uint32_t roomId, uint32_t requesterId,
    uint8_t slotIndex, uint8_t team)
{
    std::lock_guard<std::mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    GameRoom& room = it->second;

    // Host-only, same as AddAISlot / RemoveAISlot. AI slots have
    // no intrinsic owner besides the host.
    if (room.hostPlayerId != requesterId) return false;
    if (slotIndex >= room.aiSlots.size()) return false;

    room.aiSlots[slotIndex].team = team;
    std::fprintf(stderr, "[room] room %u: ai slot %u (%s) team -> %u\n",
        roomId, static_cast<unsigned>(slotIndex),
        room.aiSlots[slotIndex].aiId.c_str(),
        static_cast<unsigned>(team));
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
    std::lock_guard<std::mutex> lock(mutex);
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
    std::fprintf(stderr, "[room] room %u: player %u start pos -> %d\n",
        roomId, actualTarget, static_cast<int>(posIndex));
    return true;
}

bool RoomManager::SetAIStartPos(
    uint32_t roomId, uint32_t requesterId,
    uint8_t slotIndex, int8_t posIndex,
    int8_t maxStartPos)
{
    std::lock_guard<std::mutex> lock(mutex);
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
    std::fprintf(stderr, "[room] room %u: ai slot %u (%s) start pos -> %d\n",
        roomId, static_cast<unsigned>(slotIndex),
        room.aiSlots[slotIndex].aiId.c_str(),
        static_cast<int>(posIndex));
    return true;
}

void RoomManager::AutoAssignStartPositions(
    uint32_t roomId, int8_t maxStartPos)
{
    std::lock_guard<std::mutex> lock(mutex);
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
        std::fprintf(stderr,
            "[room] room %u: auto-assigned %d start position(s)\n",
            roomId, assigned);
    }
}

bool RoomManager::CloseRoom(uint32_t roomId, uint32_t requesterId) {
    std::lock_guard<std::mutex> lock(mutex);
    auto it = rooms.find(roomId);
    if (it == rooms.end()) return false;
    if (it->second.hostPlayerId != requesterId) return false;

    std::fprintf(stderr, "[room] room %u: host closed (was '%s')\n",
        roomId, it->second.name.c_str());
    rooms.erase(it);
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

void RoomManager::ResetRoomForNextGame(uint32_t roomId) {
    std::lock_guard<std::mutex> lock(mutex);
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

    std::fprintf(stderr, "[room] room %u recycled for next game\n", roomId);
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
