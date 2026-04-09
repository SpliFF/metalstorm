/**
 * Protocol helpers — envelope framing and message construction.
 *
 * Every WebSocket binary frame starts with a u8 envelope byte:
 *   0x01 = FlatBuffers message
 *   0x02 = Entity state update (custom binary, Tier 2)
 */
#pragma once

#include "protocol_generated.h"
#include "CombatEventCollector.h"
#include "RoomManager.h"
#include <flatbuffers/flatbuffers.h>
#include <cstdint>
#include <vector>

namespace Protocol {

constexpr uint8_t ENVELOPE_FLATBUFFERS = 0x01;
constexpr uint8_t ENVELOPE_ENTITY_STATE = 0x02;

/// Build a framed ServerMessage (envelope byte + FlatBuffers payload).
inline std::vector<uint8_t> BuildServerMessage(
    flatbuffers::FlatBufferBuilder& fbb,
    SpringWeb::ServerPayload payload_type,
    flatbuffers::Offset<void> payload)
{
    auto msg = SpringWeb::CreateServerMessage(fbb, payload_type, payload);
    fbb.Finish(msg);

    const uint8_t* buf = fbb.GetBufferPointer();
    size_t size = fbb.GetSize();

    std::vector<uint8_t> frame;
    frame.reserve(1 + size);
    frame.push_back(ENVELOPE_FLATBUFFERS);
    frame.insert(frame.end(), buf, buf + size);
    return frame;
}

/// Parse a framed ClientMessage. Returns nullptr if invalid.
inline const SpringWeb::ClientMessage* ParseClientMessage(
    const uint8_t* data, size_t len)
{
    if (len < 2 || data[0] != ENVELOPE_FLATBUFFERS)
        return nullptr;

    auto verifier = flatbuffers::Verifier(data + 1, len - 1);
    if (!SpringWeb::VerifyClientMessageBuffer(verifier))
        return nullptr;

    return SpringWeb::GetClientMessage(data + 1);
}

/// Build a Pong response.
inline std::vector<uint8_t> BuildPong(uint64_t clientTime, uint64_t serverTime) {
    flatbuffers::FlatBufferBuilder fbb(128);
    auto pong = SpringWeb::CreatePong(fbb, clientTime, serverTime);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_Pong, pong.Union());
}

/// Build an AuthResponse.
inline std::vector<uint8_t> BuildAuthResponse(
    SpringWeb::AuthStatus status,
    const std::string& token,
    uint32_t playerId,
    const std::string& message = "")
{
    flatbuffers::FlatBufferBuilder fbb(256);
    auto resp = SpringWeb::CreateAuthResponseDirect(fbb, status,
        token.empty() ? nullptr : token.c_str(),
        playerId,
        message.empty() ? nullptr : message.c_str());
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_AuthResponse, resp.Union());
}

/// Build a ServerError.
inline std::vector<uint8_t> BuildServerError(uint16_t code, const std::string& msg) {
    flatbuffers::FlatBufferBuilder fbb(256);
    auto err = SpringWeb::CreateServerErrorDirect(fbb, code, msg.c_str());
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_ServerError, err.Union());
}

/// Build a GameEventBatch containing combat events.
inline std::vector<uint8_t> BuildCombatEventBatch(
    uint32_t frame,
    const std::vector<CombatEventData>& events)
{
    flatbuffers::FlatBufferBuilder fbb(256 + events.size() * 32);

    std::vector<flatbuffers::Offset<SpringWeb::CombatEvent>> combatOffsets;
    combatOffsets.reserve(events.size());

    for (const auto& e : events) {
        auto pos = SpringWeb::Vec3(e.position.x, e.position.y, e.position.z);
        combatOffsets.push_back(SpringWeb::CreateCombatEvent(
            fbb,
            e.attackerId,
            e.targetId,
            e.weaponDefId,
            static_cast<SpringWeb::CombatResult>(e.result),
            e.damage,
            &pos));
    }

    auto combatVec = fbb.CreateVector(combatOffsets);
    auto batch = SpringWeb::CreateGameEventBatch(fbb, frame, 0, combatVec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameEventBatch, batch.Union());
}

/// Build an EntityDestroy message.
inline std::vector<uint8_t> BuildEntityDestroy(uint32_t entityId, uint8_t destructionType,
                                                float x, float y, float z) {
    flatbuffers::FlatBufferBuilder fbb(128);
    auto pos = SpringWeb::Vec3(x, y, z);
    auto destroy = SpringWeb::CreateEntityDestroy(fbb, entityId, destructionType, &pos);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_EntityDestroy, destroy.Union());
}

/// Build a GameInfo message (map, game, speed, frame, paused).
inline std::vector<uint8_t> BuildGameInfo(
    const std::string& mapName, const std::string& gameName,
    float speed, uint32_t frame, bool paused)
{
    flatbuffers::FlatBufferBuilder fbb(256);
    auto mapOff = fbb.CreateString(mapName);
    auto gameOff = fbb.CreateString(gameName);
    auto info = SpringWeb::CreateGameInfo(fbb, mapOff, gameOff, speed, frame, paused);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameInfo, info.Union());
}

/// Build a RoomStateUpdate message.
inline std::vector<uint8_t> BuildRoomStateUpdate(const GameRoom& room) {
    flatbuffers::FlatBufferBuilder fbb(512);

    std::vector<flatbuffers::Offset<SpringWeb::RoomPlayerInfo>> playerOffsets;
    for (const auto& p : room.players) {
        auto nameOff = fbb.CreateString(p.username);
        playerOffsets.push_back(SpringWeb::CreateRoomPlayerInfo(
            fbb, p.playerId, nameOff, p.team, p.ready, p.isSpectator, p.isHost));
    }
    auto playersVec = fbb.CreateVector(playerOffsets);
    auto nameOff = fbb.CreateString(room.name);
    auto mapOff = fbb.CreateString(room.mapName);
    auto gameOff = fbb.CreateString(room.gameName);

    auto update = SpringWeb::CreateRoomStateUpdate(
        fbb, room.id, static_cast<SpringWeb::RoomState>(room.state),
        nameOff, mapOff, gameOff, playersVec,
        static_cast<uint8_t>(room.countdownSeconds));
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_RoomStateUpdate, update.Union());
}

/// Build a RoomListUpdate with all rooms.
inline std::vector<uint8_t> BuildRoomListUpdate(const std::vector<GameRoom*>& rooms) {
    flatbuffers::FlatBufferBuilder fbb(256 + rooms.size() * 128);

    std::vector<flatbuffers::Offset<SpringWeb::RoomListEntry>> entries;
    for (const auto* r : rooms) {
        auto nameOff = fbb.CreateString(r->name);
        auto mapOff = fbb.CreateString(r->mapName);
        auto gameOff = fbb.CreateString(r->gameName);
        // Find host name
        std::string hostName;
        for (const auto& p : r->players) {
            if (p.isHost) { hostName = p.username; break; }
        }
        auto hostOff = fbb.CreateString(hostName);

        entries.push_back(SpringWeb::CreateRoomListEntry(
            fbb, r->id, nameOff, mapOff, gameOff,
            static_cast<SpringWeb::RoomState>(r->state),
            static_cast<uint8_t>(r->PlayerCount()),
            r->maxPlayers,
            !r->password.empty(),
            hostOff));
    }
    auto vec = fbb.CreateVector(entries);
    auto update = SpringWeb::CreateRoomListUpdate(fbb, vec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_RoomListUpdate, update.Union());
}

} // namespace Protocol
