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
#include "MusicStateTracker.h"
#include "ProjectileEventCollector.h"
#include "SoundEventCollector.h"
#include "IntelEventCollector.h"
#include "RoomManager.h"
#include "MapMetadata.h"
#include "Sim/Projectiles/WeaponProjectiles/WeaponProjectileTypes.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Weapons/WeaponDef.h"
#include "Sim/Misc/GuiSoundSet.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Units/CommandAI/CommandDescription.h"
#include "Sim/Units/CommandAI/CommandQueue.h"
#include <flatbuffers/flatbuffers.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <unordered_map>
#include <vector>

namespace Protocol {

constexpr uint8_t ENVELOPE_FLATBUFFERS = 0x01;
constexpr uint8_t ENVELOPE_ENTITY_STATE = 0x02;
constexpr uint8_t ENVELOPE_PROJECTILE_STATE = 0x04;
constexpr uint8_t ENVELOPE_PIECE_STATE = 0x05;
constexpr uint8_t ENVELOPE_BUILD_ACTIVITY = 0x06;
/// LOS bitmap snapshot (Phase 5). Hand-packed binary, three planes
/// (in-LOS / in-radar / explored) at <= 64x64 squares. Sent 1 Hz per
/// session, filtered to the viewer's own ally team (round-robin for
/// spectators). Header is u8 envelope + u8 allyTeam + u8 width +
/// u8 height + u32 frame (LE) followed by three bit-packed planes
/// of (width*height + 7) / 8 bytes each, MSB-first per byte.
constexpr uint8_t ENVELOPE_LOS_BITMAP = 0x07;

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
///
/// `defsCacheKey` is the content-addressed key the client uses to fetch
/// the game's UnitDefs/WeaponDefs FlatBuffer payloads via HTTP. Empty
/// for the lobby (no defs) or when the bake step failed (client falls
/// back to whatever streaming path is wired).
inline std::vector<uint8_t> BuildAuthResponse(
    SpringWeb::AuthStatus status,
    const std::string& token,
    uint32_t playerId,
    const std::string& message = "",
    int8_t team = -1,
    const std::string& defsCacheKey = "")
{
    flatbuffers::FlatBufferBuilder fbb(256);
    auto resp = SpringWeb::CreateAuthResponseDirect(fbb, status,
        token.empty() ? nullptr : token.c_str(),
        playerId,
        message.empty() ? nullptr : message.c_str(),
        team,
        defsCacheKey.empty() ? nullptr : defsCacheKey.c_str());
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_AuthResponse, resp.Union());
}

/// Build a ServerError.
inline std::vector<uint8_t> BuildServerError(uint16_t code, const std::string& msg) {
    flatbuffers::FlatBufferBuilder fbb(256);
    auto err = SpringWeb::CreateServerErrorDirect(fbb, code, msg.c_str());
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_ServerError, err.Union());
}

/// Build a ConsoleResponse.
inline std::vector<uint8_t> BuildConsoleResponse(
    uint32_t requestId,
    const std::string& scope,
    bool success,
    const std::string& output,
    uint8_t level = 0)
{
    flatbuffers::FlatBufferBuilder fbb(256 + output.size());
    auto resp = SpringWeb::CreateConsoleResponseDirect(fbb,
        requestId, scope.c_str(), success, output.c_str(), level);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_ConsoleResponse, resp.Union());
}

/// Build a GameStarted message (game server → lobby).
inline std::vector<uint8_t> BuildGameStarted(uint32_t frame) {
    flatbuffers::FlatBufferBuilder fbb(64);
    auto gs = SpringWeb::CreateGameStarted(fbb, frame);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameStarted, gs.Union());
}

/// Build a GameRestarting message — tells clients the server is about
/// to execvp itself and they should reset + reconnect.
inline std::vector<uint8_t> BuildGameRestarting() {
    flatbuffers::FlatBufferBuilder fbb(64);
    auto gr = SpringWeb::CreateGameRestarting(fbb);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameRestarting, gr.Union());
}

/// Build a GameEventBatch containing combat events and projectile lifecycle
/// events (fired / impacts / trajectory changes). Any vector may be empty.
inline std::vector<uint8_t> BuildCombatEventBatch(
    uint32_t frame,
    const std::vector<CombatEventData>& events,
    const std::vector<ProjectileFiredEventData>& projFired = {},
    const std::vector<ProjectileImpactEventData>& projImpacts = {},
    const std::vector<ProjectileTrajectoryEventData>& projTrajectories = {},
    const std::vector<SoundEventData>& sounds = {},
    const std::vector<SeismicPingData>& seismicPings = {})
{
    flatbuffers::FlatBufferBuilder fbb(
        256 + events.size() * 32
            + projFired.size() * 64
            + projImpacts.size() * 32
            + projTrajectories.size() * 40
            + sounds.size() * 32
            + seismicPings.size() * 24);

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

    std::vector<flatbuffers::Offset<SpringWeb::ProjectileFiredEvent>> firedOffsets;
    firedOffsets.reserve(projFired.size());
    for (const auto& e : projFired) {
        auto pos = SpringWeb::Vec3(e.pos.x, e.pos.y, e.pos.z);
        auto vel = SpringWeb::Vec3(e.vel.x, e.vel.y, e.vel.z);
        auto tgt = SpringWeb::Vec3(e.targetPos.x, e.targetPos.y, e.targetPos.z);
        firedOffsets.push_back(SpringWeb::CreateProjectileFiredEvent(
            fbb,
            e.projId,
            e.weaponDefId,
            e.ownerId,
            e.team,
            &pos,
            &vel,
            &tgt,
            e.targetId,
            e.ttl,
            e.gravity,
            e.hitscan));
    }

    std::vector<flatbuffers::Offset<SpringWeb::ProjectileImpactEvent>> impactOffsets;
    impactOffsets.reserve(projImpacts.size());
    for (const auto& e : projImpacts) {
        auto pos = SpringWeb::Vec3(e.pos.x, e.pos.y, e.pos.z);
        impactOffsets.push_back(SpringWeb::CreateProjectileImpactEvent(
            fbb,
            e.projId,
            &pos,
            static_cast<SpringWeb::ProjectileImpactKind>(e.impactKind),
            e.targetId,
            e.team));
    }

    std::vector<flatbuffers::Offset<SpringWeb::ProjectileTrajectoryEvent>> trajOffsets;
    trajOffsets.reserve(projTrajectories.size());
    for (const auto& e : projTrajectories) {
        auto pos = SpringWeb::Vec3(e.pos.x, e.pos.y, e.pos.z);
        auto vel = SpringWeb::Vec3(e.vel.x, e.vel.y, e.vel.z);
        trajOffsets.push_back(SpringWeb::CreateProjectileTrajectoryEvent(
            fbb,
            e.projId,
            &pos,
            &vel,
            static_cast<SpringWeb::ProjectileTrajectoryReason>(e.reason),
            e.team));
    }

    std::vector<flatbuffers::Offset<SpringWeb::SoundEvent>> soundOffsets;
    soundOffsets.reserve(sounds.size());
    for (const auto& s : sounds) {
        auto pos = SpringWeb::Vec3(s.position.x, s.position.y, s.position.z);
        SpringWeb::SoundEventBuilder seb(fbb);
        seb.add_sound_id(s.soundId);
        seb.add_source_def_id(s.sourceDefId);
        seb.add_source_kind(static_cast<SpringWeb::SoundSourceKind>(s.sourceKind));
        seb.add_position(&pos);
        seb.add_volume(s.volume);
        seb.add_pitch(s.pitch);
        seb.add_priority(s.priority);
        seb.add_team(s.team);
        seb.add_channel(static_cast<SpringWeb::SoundChannel>(s.channel));
        soundOffsets.push_back(seb.Finish());
    }

    std::vector<flatbuffers::Offset<SpringWeb::SeismicPing>> seismicOffsets;
    seismicOffsets.reserve(seismicPings.size());
    for (const auto& p : seismicPings) {
        auto pos = SpringWeb::Vec3(p.pos.x, p.pos.y, p.pos.z);
        SpringWeb::SeismicPingBuilder spb(fbb);
        spb.add_pos(&pos);
        spb.add_strength(p.strength);
        spb.add_ally_team(p.allyTeam);
        seismicOffsets.push_back(spb.Finish());
    }

    // Music-state transitions. Tick the tracker against the combat
    // count for this batch first; then drain at most one pending
    // transition. Most batches will produce zero events here.
    musicState.Tick(static_cast<uint32_t>(events.size()));
    std::vector<flatbuffers::Offset<SpringWeb::MusicEvent>> musicOffsets;
    {
        MusicStateValue st;
        uint16_t fadeMs;
        if (musicState.DrainTransition(st, fadeMs)) {
            SpringWeb::MusicEventBuilder meb(fbb);
            meb.add_state(static_cast<SpringWeb::MusicState>(st));
            meb.add_fade_ms(fadeMs);
            musicOffsets.push_back(meb.Finish());
        }
    }

    auto combatVec  = fbb.CreateVector(combatOffsets);
    auto firedVec   = fbb.CreateVector(firedOffsets);
    auto impactVec  = fbb.CreateVector(impactOffsets);
    auto trajVec    = fbb.CreateVector(trajOffsets);
    auto soundVec   = fbb.CreateVector(soundOffsets);
    auto seismicVec = fbb.CreateVector(seismicOffsets);
    auto musicVec   = fbb.CreateVector(musicOffsets);
    auto batch = SpringWeb::CreateGameEventBatch(
        fbb, frame, /*events=*/0, combatVec, firedVec, impactVec, trajVec, soundVec, seismicVec, musicVec);
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

/// Build an EntitySensorUpdate message — broadcast when
/// `Spring.SetUnitSensorRadius` mutates a sensor at runtime. The client
/// stores the override and serves it from `Spring.GetUnitSensorRadius`
/// in the widget worker so range-circle widgets refresh immediately.
inline std::vector<uint8_t> BuildEntitySensorUpdate(
    uint32_t entityId, SpringWeb::SensorType sensorType, float radius)
{
    flatbuffers::FlatBufferBuilder fbb(64);
    auto upd = SpringWeb::CreateEntitySensorUpdate(fbb, entityId, sensorType, radius);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_EntitySensorUpdate, upd.Union());
}

/// Build a PlayerLeft message (broadcast to remaining clients on disconnect).
inline std::vector<uint8_t> BuildPlayerLeft(
    uint32_t playerId, const std::string& username, int8_t team, uint8_t reason)
{
    flatbuffers::FlatBufferBuilder fbb(256);
    auto nameOff = fbb.CreateString(username);
    auto pl = SpringWeb::CreatePlayerLeft(fbb, playerId, nameOff, team, reason);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_PlayerLeft, pl.Union());
}

/// Build a ResourceUpdate message for a single team. All rate fields
/// (income/pull/expense/share/sent/received/excess) are per-second values
/// derived from CTeam::resPrev* — Spring resets those accumulators every
/// `gs->GetResourceMapSize()` frames (currently 32, ~1.07s), so they're
/// already a per-second rate by construction.
inline std::vector<uint8_t> BuildResourceUpdate(
    uint8_t team, float metal, float maxMetal,
    float energy, float maxEnergy,
    float metalIncome, float energyIncome,
    float metalPull = 0.0f, float energyPull = 0.0f,
    float metalExpense = 0.0f, float energyExpense = 0.0f,
    float metalShare = 0.0f, float energyShare = 0.0f,
    float metalSent = 0.0f, float energySent = 0.0f,
    float metalReceived = 0.0f, float energyReceived = 0.0f,
    float metalExcess = 0.0f, float energyExcess = 0.0f)
{
    flatbuffers::FlatBufferBuilder fbb(192);
    auto ru = SpringWeb::CreateResourceUpdate(
        fbb, team, metal, maxMetal, energy, maxEnergy,
        metalIncome, energyIncome,
        metalPull, energyPull,
        metalExpense, energyExpense,
        metalShare, energyShare,
        metalSent, energySent,
        metalReceived, energyReceived,
        metalExcess, energyExcess);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_ResourceUpdate, ru.Union());
}

/// Serialize the command queues of a set of units. The queues are
/// emitted in the order the units appear in `units`; callers typically
/// pass a single team's units.
inline std::vector<uint8_t> BuildUnitCommandQueues(const std::vector<CUnit*>& units) {
    flatbuffers::FlatBufferBuilder fbb(2048);

    std::vector<flatbuffers::Offset<SpringWeb::UnitCommandQueue>> queueOffsets;
    queueOffsets.reserve(units.size());

    for (const CUnit* u : units) {
        if (u == nullptr || u->commandAI == nullptr) continue;
        const CCommandQueue& q = u->commandAI->commandQue;

        std::vector<flatbuffers::Offset<SpringWeb::UnitOrder>> orderOffsets;
        orderOffsets.reserve(q.size());
        for (const Command& c : q) {
            // Internal-order spam (auto-generated path & guard commands)
            // would dominate the wire if we let them through; widgets
            // generally expect only player-issued / queued orders.
            if (c.IsInternalOrder()) continue;

            const unsigned int n = c.GetNumParams();
            std::vector<float> params(n);
            for (unsigned int i = 0; i < n; ++i) params[i] = c.GetParams(i)[0];
            auto paramsOff = fbb.CreateVector(params);

            orderOffsets.push_back(SpringWeb::CreateUnitOrder(
                fbb,
                static_cast<int32_t>(c.GetID()),
                paramsOff,
                static_cast<uint8_t>(c.GetOpts()),
                static_cast<uint32_t>(c.GetTag()),
                static_cast<int32_t>(c.GetTimeOut())));
        }

        // Skip units with no externally-visible orders to keep the
        // payload tight; the client treats absence as "empty queue".
        if (orderOffsets.empty()) continue;

        auto ordersVec = fbb.CreateVector(orderOffsets);
        queueOffsets.push_back(SpringWeb::CreateUnitCommandQueue(
            fbb, static_cast<uint32_t>(u->id), ordersVec));
    }

    auto queuesVec = fbb.CreateVector(queueOffsets);
    auto upd = SpringWeb::CreateUnitCommandQueuesUpdate(fbb, queuesVec);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_UnitCommandQueuesUpdate, upd.Union());
}

/// Serialize each unit's available build-command descriptors. Builds and
/// factories often have build options assigned dynamically (Spring.InsertUnitCmdDesc
/// from gadgets) so the static UnitDef.build_options list is not authoritative.
/// We stream only the negative-id (build) entries — positional/standing-order
/// command buttons are handled client-side from the CMD_* enum.
inline std::vector<uint8_t> BuildUnitCmdDescs(const std::vector<CUnit*>& units) {
    flatbuffers::FlatBufferBuilder fbb(2048);

    std::vector<flatbuffers::Offset<SpringWeb::UnitCmdDescs>> unitOffsets;
    unitOffsets.reserve(units.size());

    for (const CUnit* u : units) {
        if (u == nullptr || u->commandAI == nullptr) continue;
        const auto& descs = u->commandAI->GetPossibleCommands();

        std::vector<flatbuffers::Offset<SpringWeb::UnitCmdDesc>> cmdOffsets;
        cmdOffsets.reserve(descs.size());
        for (const SCommandDescription* d : descs) {
            if (d == nullptr || d->hidden) continue;
            // First pass: build commands only. Standing-order toggles
            // come later when the client UI grows beyond build placement.
            if (d->id >= 0) continue;
            cmdOffsets.push_back(SpringWeb::CreateUnitCmdDesc(
                fbb,
                static_cast<int32_t>(d->id),
                d->disabled));
        }

        // Skip units with no build-command descs to keep the payload tight.
        if (cmdOffsets.empty()) continue;

        auto cmdsVec = fbb.CreateVector(cmdOffsets);
        unitOffsets.push_back(SpringWeb::CreateUnitCmdDescs(
            fbb, static_cast<uint32_t>(u->id), cmdsVec));
    }

    auto unitsVec = fbb.CreateVector(unitOffsets);
    auto upd = SpringWeb::CreateUnitCmdDescsUpdate(fbb, unitsVec);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_UnitCmdDescsUpdate, upd.Union());
}

/// Build a GameInfo message (map, game, speed, frame, paused, env state).
inline std::vector<uint8_t> BuildGameInfo(
    const std::string& mapId, const std::string& gameId,
    float speed, uint32_t frame, bool paused,
    float windX = 0, float windY = 0, float windZ = 0,
    float windStrength = 0, float tidalStrength = 0)
{
    flatbuffers::FlatBufferBuilder fbb(256);
    auto mapOff = fbb.CreateString(mapId);
    auto gameOff = fbb.CreateString(gameId);
    auto info = SpringWeb::CreateGameInfo(
        fbb, mapOff, gameOff, speed, frame, paused,
        windX, windY, windZ, windStrength, tidalStrength);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameInfo, info.Union());
}

/// Build a RoomStateUpdate message.
inline std::vector<uint8_t> BuildRoomStateUpdate(const GameRoom& room) {
    flatbuffers::FlatBufferBuilder fbb(512);

    std::vector<flatbuffers::Offset<SpringWeb::RoomPlayerInfo>> playerOffsets;
    for (const auto& p : room.players) {
        auto nameOff = fbb.CreateString(p.username);
        playerOffsets.push_back(SpringWeb::CreateRoomPlayerInfo(
            fbb, p.playerId, nameOff, p.team, p.ready, p.isSpectator,
            p.isHost, p.startPos));
    }
    auto playersVec = fbb.CreateVector(playerOffsets);

    // AI slot roster: matches the order the host added them. The
    // client keys removal operations by index into this array, so
    // the server must emit the exact same order it holds internally.
    std::vector<flatbuffers::Offset<SpringWeb::RoomAISlot>> aiSlotOffsets;
    for (const auto& s : room.aiSlots) {
        auto aiIdOff = fbb.CreateString(s.aiId);
        auto displayOff = fbb.CreateString(s.displayName);
        aiSlotOffsets.push_back(SpringWeb::CreateRoomAISlot(
            fbb, aiIdOff, displayOff, s.team, s.startPos));
    }
    auto aiSlotsVec = fbb.CreateVector(aiSlotOffsets);

    auto nameOff = fbb.CreateString(room.name);
    auto mapOff = fbb.CreateString(room.mapId);
    auto gameOff = fbb.CreateString(room.gameId);

    auto update = SpringWeb::CreateRoomStateUpdate(
        fbb, room.id, static_cast<SpringWeb::RoomState>(room.state),
        nameOff, mapOff, gameOff, playersVec,
        static_cast<uint8_t>(room.countdownSeconds),
        room.gameServerPort, aiSlotsVec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_RoomStateUpdate, update.Union());
}

/// Build an AIListUpdate from a discovered-AI vector. Called by
/// the lobby in response to AIListRequest, plus once after room
/// join so the client UI has something to populate its "Add AI"
/// dropdown with.
template<typename AIInfoT>
inline std::vector<uint8_t> BuildAIListUpdate(const std::vector<AIInfoT>& ais) {
    flatbuffers::FlatBufferBuilder fbb(512);
    std::vector<flatbuffers::Offset<SpringWeb::RoomAIInfo>> offsets;
    offsets.reserve(ais.size());
    for (const auto& ai : ais) {
        auto idOff = fbb.CreateString(ai.id);
        auto nameOff = fbb.CreateString(ai.displayName);
        auto descOff = fbb.CreateString(ai.description);
        offsets.push_back(SpringWeb::CreateRoomAIInfo(
            fbb, idOff, nameOff, descOff, ai.isEngineProvided));
    }
    auto aisVec = fbb.CreateVector(offsets);
    auto update = SpringWeb::CreateAIListUpdate(fbb, aisVec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_AIListUpdate, update.Union());
}

/// Build a GameListUpdate from a discovered-games vector. Called
/// by the lobby in response to GameListRequest. Templated on the
/// caller's GameInfo type so we can pass in either the lobby's
/// GameDiscovery::GameInfo directly or a thin proxy struct —
/// anything with `id`, `displayName`, `description`, `version`
/// string members works.
template<typename GameInfoT>
inline std::vector<uint8_t> BuildGameListUpdate(const std::vector<GameInfoT>& games) {
    flatbuffers::FlatBufferBuilder fbb(512);
    std::vector<flatbuffers::Offset<SpringWeb::LobbyGameInfo>> offsets;
    offsets.reserve(games.size());
    for (const auto& g : games) {
        auto idOff = fbb.CreateString(g.id);
        auto nameOff = fbb.CreateString(g.displayName);
        auto descOff = fbb.CreateString(g.description);
        auto verOff = fbb.CreateString(g.version);
        offsets.push_back(SpringWeb::CreateLobbyGameInfo(
            fbb, idOff, nameOff, descOff, verOff));
    }
    auto gamesVec = fbb.CreateVector(offsets);
    auto update = SpringWeb::CreateGameListUpdate(fbb, gamesVec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameListUpdate, update.Union());
}

/// Read entire binary file into a vector. Returns empty on failure.
inline std::vector<uint8_t> ReadFileBytes(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open()) return {};
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)),
                                 std::istreambuf_iterator<char>());
}

/// Build a MapListUpdate from a list of MapMetadata (lobby map browser).
inline std::vector<uint8_t> BuildMapListUpdate(const std::vector<MapMetadata>& maps) {
    flatbuffers::FlatBufferBuilder fbb(2048);

    std::vector<flatbuffers::Offset<SpringWeb::MapInfo>> entries;
    entries.reserve(maps.size());
    for (const auto& m : maps) {
        auto idOff   = fbb.CreateString(m.id);
        auto nmOff   = fbb.CreateString(m.name);
        auto snOff   = fbb.CreateString(m.shortName);
        auto descOff = fbb.CreateString(m.description);
        auto authOff = fbb.CreateString(m.author);
        auto verOff  = fbb.CreateString(m.version);
        std::string minimapUrl = "/api/maps/data/" + m.id + "/minimap.ktx2";
        auto miniOff = fbb.CreateString(minimapUrl);

        std::vector<SpringWeb::MapStartPos> sps;
        sps.reserve(m.startPositions.size());
        for (const auto& sp : m.startPositions)
            sps.emplace_back(sp.x, sp.z);
        auto spsOff = fbb.CreateVectorOfStructs(sps);

        SpringWeb::MapInfoBuilder mb(fbb);
        mb.add_id(idOff);
        mb.add_name(nmOff);
        mb.add_short_name(snOff);
        mb.add_description(descOff);
        mb.add_author(authOff);
        mb.add_version(verOff);
        mb.add_mapx(static_cast<uint16_t>(m.mapx));
        mb.add_mapy(static_cast<uint16_t>(m.mapy));
        mb.add_width_elmos(m.widthElmos);
        mb.add_height_elmos(m.heightElmos);
        mb.add_min_height(m.minHeight);
        mb.add_max_height(m.maxHeight);
        mb.add_max_players(static_cast<uint8_t>(m.startPositions.size()));
        mb.add_start_positions(spsOff);
        mb.add_gravity(m.gravity);
        mb.add_tidal_strength(m.tidalStrength);
        mb.add_max_metal(m.maxMetal);
        mb.add_extractor_radius(m.extractorRadius);
        mb.add_minimap_url(miniOff);
        mb.add_has_lua_gaia(m.hasLuaGaia);
        entries.push_back(mb.Finish());
    }
    auto vec = fbb.CreateVector(entries);
    auto update = SpringWeb::CreateMapListUpdate(fbb, vec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_MapListUpdate, update.Union());
}

/// Build a MapData message for a single map (sent by the game server on auth).
/// Embeds heightmap/tileindex/typemap/metalmap binary data inline.
/// Texture URLs are absolute paths under the lobby HTTP root.
inline std::vector<uint8_t> BuildMapData(const MapMetadata& m) {
    flatbuffers::FlatBufferBuilder fbb(64 * 1024);

    // --- Load embedded binary data from processedDir ---
    auto hmBytes  = ReadFileBytes(m.processedDir + "/heightmap.bin");
    auto tiBytes  = ReadFileBytes(m.processedDir + "/tileindex.bin");
    auto tmBytes  = ReadFileBytes(m.processedDir + "/typemap.bin");
    auto mmBytes  = ReadFileBytes(m.processedDir + "/metalmap.bin");

    // Heightmap is uint16[]
    flatbuffers::Offset<flatbuffers::Vector<uint16_t>> hmOff = 0;
    if (hmBytes.size() >= 2) {
        const uint16_t* p = reinterpret_cast<const uint16_t*>(hmBytes.data());
        hmOff = fbb.CreateVector(p, hmBytes.size() / 2);
    }
    flatbuffers::Offset<flatbuffers::Vector<int32_t>> tiOff = 0;
    if (tiBytes.size() >= 4) {
        const int32_t* p = reinterpret_cast<const int32_t*>(tiBytes.data());
        tiOff = fbb.CreateVector(p, tiBytes.size() / 4);
    }
    auto tmOff = fbb.CreateVector(tmBytes.data(), tmBytes.size());
    auto mmOff = fbb.CreateVector(mmBytes.data(), mmBytes.size());

    // --- Start positions ---
    std::vector<SpringWeb::MapStartPos> sps;
    sps.reserve(m.startPositions.size());
    for (const auto& sp : m.startPositions)
        sps.emplace_back(sp.x, sp.z);
    auto spsOff = fbb.CreateVectorOfStructs(sps);

    // --- Feature types and instances ---
    std::vector<flatbuffers::Offset<flatbuffers::String>> typeOffs;
    typeOffs.reserve(m.featureTypes.size());
    for (const auto& t : m.featureTypes)
        typeOffs.push_back(fbb.CreateString(t));
    auto typesOff = fbb.CreateVector(typeOffs);

    std::vector<flatbuffers::Offset<SpringWeb::MapFeature>> featOffs;
    featOffs.reserve(m.features.size());
    for (const auto& f : m.features) {
        featOffs.push_back(SpringWeb::CreateMapFeature(
            fbb,
            static_cast<uint16_t>(f.featureType),
            f.x, f.y, f.z, f.rotation, f.relativeSize));
    }
    auto featuresOff = fbb.CreateVector(featOffs);

    // Feature defs — parallel to feature_types. Each entry's model/texture
    // URLs point at the converted assets in the map's processed dir.
    std::vector<flatbuffers::Offset<SpringWeb::MapFeatureDef>> defOffs;
    defOffs.reserve(m.featureDefs.size());
    for (const auto& d : m.featureDefs) {
        auto nameOff = fbb.CreateString(d.name);
        auto modelOff = d.modelFile.empty()
            ? fbb.CreateString("")
            : fbb.CreateString("/api/maps/data/" + m.id + "/features/" + d.modelFile);
        auto texOff = d.textureFile.empty()
            ? fbb.CreateString("")
            : fbb.CreateString("/api/maps/data/" + m.id + "/features/" + d.textureFile);
        SpringWeb::MapFeatureDefBuilder fdb(fbb);
        fdb.add_name(nameOff);
        fdb.add_model_url(modelOff);
        fdb.add_texture_url(texOff);
        fdb.add_footprint_x(static_cast<uint16_t>(d.footprintX));
        fdb.add_footprint_z(static_cast<uint16_t>(d.footprintZ));
        fdb.add_height(d.height);
        fdb.add_radius(d.radius);
        fdb.add_blocking(d.blocking);
        fdb.add_reclaimable(d.reclaimable);
        fdb.add_metal(d.metal);
        fdb.add_energy(d.energy);
        fdb.add_damage(d.damage);
        defOffs.push_back(fdb.Finish());
    }
    auto featureDefsOff = fbb.CreateVector(defOffs);

    // --- Decals ---
    auto decalUrl = [&](const std::string& f) {
        if (f.empty()) return fbb.CreateString("");
        return fbb.CreateString("/api/maps/data/" + m.id + "/" + f);
    };
    auto detailUrl   = decalUrl(m.decals.detailTex);
    auto specUrl     = decalUrl(m.decals.specularTex);
    auto splatDtlUrl = decalUrl(m.decals.splatDetailTex);
    auto splatDistUrl= decalUrl(m.decals.splatDistrTex);
    auto sn0Url      = decalUrl(m.decals.splatDetailNormalTex[0]);
    auto sn1Url      = decalUrl(m.decals.splatDetailNormalTex[1]);
    auto sn2Url      = decalUrl(m.decals.splatDetailNormalTex[2]);
    auto sn3Url      = decalUrl(m.decals.splatDetailNormalTex[3]);
    auto detNrmUrl   = decalUrl(m.decals.detailNormalTex);
    auto scalesOff   = fbb.CreateVector(m.decals.splatScales, 4);
    auto multsOff    = fbb.CreateVector(m.decals.splatMults,  4);

    SpringWeb::MapDecalsBuilder db(fbb);
    db.add_detail_tex(detailUrl);
    db.add_specular_tex(specUrl);
    db.add_splat_detail_tex(splatDtlUrl);
    db.add_splat_distr_tex(splatDistUrl);
    db.add_splat_normal_0(sn0Url);
    db.add_splat_normal_1(sn1Url);
    db.add_splat_normal_2(sn2Url);
    db.add_splat_normal_3(sn3Url);
    db.add_detail_normal_tex(detNrmUrl);
    db.add_splat_scales(scalesOff);
    db.add_splat_mults(multsOff);
    auto decalsOff = db.Finish();

    // --- Water ---
    auto waterBaseOff    = fbb.CreateVector(m.water.baseColor,    3);
    auto waterSurfaceOff = fbb.CreateVector(m.water.surfaceColor, 3);
    auto waterMinOff     = fbb.CreateVector(m.water.minColor,     3);
    SpringWeb::MapWaterBuilder wb(fbb);
    wb.add_base_color(waterBaseOff);
    wb.add_surface_color(waterSurfaceOff);
    wb.add_min_color(waterMinOff);
    wb.add_surface_alpha(m.water.surfaceAlpha);
    wb.add_damage(m.water.damage);
    wb.add_void_water(m.water.voidWater);
    auto waterOff = wb.Finish();

    // --- Texture URLs (lobby HTTP) ---
    auto miniUrl = fbb.CreateString("/api/maps/data/" + m.id + "/minimap.ktx2");
    auto tilesUrl = fbb.CreateString("/api/maps/data/" + m.id + "/tiles.ktx2");
    auto baseUrl = fbb.CreateString("/api/maps/data/" + m.id);
    auto sourceUrl = fbb.CreateString("/api/maps/data/" + m.id);

    // --- Widget filenames (relative to mapSourceUrl) ---
    std::vector<flatbuffers::Offset<flatbuffers::String>> widgetOffs;
    widgetOffs.reserve(m.widgets.size());
    for (const auto& w : m.widgets) widgetOffs.push_back(fbb.CreateString(w));
    auto widgetsOff = fbb.CreateVector(widgetOffs);

    SpringWeb::MapDataBuilder mdb(fbb);
    mdb.add_mapx(static_cast<uint16_t>(m.mapx));
    mdb.add_mapy(static_cast<uint16_t>(m.mapy));
    mdb.add_square_size(8);
    mdb.add_min_height(m.minHeight);
    mdb.add_max_height(m.maxHeight);
    mdb.add_tiles_x(static_cast<uint16_t>(m.tilesX));
    mdb.add_tiles_z(static_cast<uint16_t>(m.tilesZ));
    mdb.add_num_tiles(m.numTiles);
    mdb.add_tile_size(32);
    mdb.add_start_positions(spsOff);
    mdb.add_feature_types(typesOff);
    mdb.add_features(featuresOff);
    mdb.add_feature_defs(featureDefsOff);
    if (!hmOff.IsNull()) mdb.add_heightmap(hmOff);
    if (!tiOff.IsNull()) mdb.add_tileindex(tiOff);
    mdb.add_typemap(tmOff);
    mdb.add_metalmap(mmOff);
    mdb.add_minimap_url(miniUrl);
    mdb.add_tiles_url(tilesUrl);
    mdb.add_map_data_url(baseUrl);
    mdb.add_map_source_url(sourceUrl);
    mdb.add_decals(decalsOff);
    mdb.add_water(waterOff);
    mdb.add_widgets(widgetsOff);
    mdb.add_has_lua_gaia(m.hasLuaGaia);
    auto data = mdb.Finish();

    return BuildServerMessage(fbb, SpringWeb::ServerPayload_MapData, data.Union());
}

/// Build a RoomListUpdate with all rooms.
inline std::vector<uint8_t> BuildRoomListUpdate(const std::vector<GameRoom*>& rooms) {
    flatbuffers::FlatBufferBuilder fbb(256 + rooms.size() * 128);

    std::vector<flatbuffers::Offset<SpringWeb::RoomListEntry>> entries;
    for (const auto* r : rooms) {
        auto nameOff = fbb.CreateString(r->name);
        auto mapOff = fbb.CreateString(r->mapId);
        auto gameOff = fbb.CreateString(r->gameId);
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

/// Translate a (possibly stem-only) sound name into the canonical
/// `sounds/<rel>.webm` form the content server publishes. Every
/// audio asset on disk is `.webm` (Opus) post-audioconverter; the
/// client never sees a `.wav`/`.ogg`/`.mp3` URL.
///
/// Three input shapes are normalised:
///   - `weapon/laser1`           -> `sounds/weapon/laser1.webm`
///   - `sounds/weapon/laser1.wav`-> `sounds/weapon/laser1.webm`
///   - `weapon/laser1.ogg`       -> `sounds/weapon/laser1.webm`
///
/// The raw unresolved string still flows separately as `SoundRef.name`
/// so the client can look up SoundItem metadata in `gamedata/sounds.lua`.
inline std::string NormalizeSoundPath(const std::string& name) {
    if (name.empty()) return {};
    std::string out = name;
    // Strip a leading `sounds/` once if present; we add it back below.
    auto hasPrefix = [&](const char* p) {
        const size_t n = std::strlen(p);
        return out.size() >= n && std::strncmp(out.c_str(), p, n) == 0;
    };
    if (hasPrefix("sounds/")) out.erase(0, 7);
    // Replace any existing extension with `.webm`, or append `.webm`
    // if there's no extension. Engine convention historically was
    // `.wav` but post-audioconverter every asset is `.webm`.
    const auto dot = out.find_last_of('.');
    const auto slash = out.find_last_of('/');
    const bool hasExt = (dot != std::string::npos) &&
                        (slash == std::string::npos || dot > slash);
    if (hasExt) {
        out.erase(dot);
    }
    out += ".webm";
    return std::string("sounds/") + out;
}

/// Serialize a GuiSoundSet into one or more SoundRefs sharing a category.
/// Returns the number of refs appended. Each GuiSoundSet may carry several
/// alternates (e.g. a weapon with two firing samples) which we expose as
/// successive SoundRef IDs sharing the same `category`.
inline uint16_t AppendSoundRefs(
    std::vector<flatbuffers::Offset<SpringWeb::SoundRef>>& out,
    flatbuffers::FlatBufferBuilder& fbb,
    const GuiSoundSet& set,
    SpringWeb::SoundCategory category,
    uint16_t& nextId)
{
    const int n = static_cast<int>(set.NumSounds());
    uint16_t appended = 0;
    for (int i = 0; i < n; i++) {
        const GuiSoundSetData& d = set.GetSoundData(i);
        if (d.name.empty()) continue;
        const std::string path = NormalizeSoundPath(d.name);
        auto pathOff = fbb.CreateString(path);
        // The raw unresolved logical name (e.g. `"weapon/laser1"` or
        // `"bot_select"`). The client uses this to look up SoundItem
        // metadata in `gamedata/sounds.lua` for per-item gain/pitch/
        // priority/maxconcurrent/etc. defaults that the server can't
        // know about.
        auto nameOff = fbb.CreateString(d.name);
        SpringWeb::SoundRefBuilder b(fbb);
        b.add_id(nextId++);
        b.add_path(pathOff);
        b.add_name(nameOff);
        b.add_category(category);
        // Spring volumes >1 are common; clamp the *default* into 0..1
        // so the client can multiply unbounded SoundEvent.volume against
        // it without re-clamping. Pitch is always 1.0 from the def.
        const float vol = (d.volume > 0.0f) ? std::min(d.volume, 4.0f) : 1.0f;
        b.add_volume(vol);
        b.add_pitch(1.0f);
        out.push_back(b.Finish());
        appended++;
    }
    return appended;
}

/// Build one GameUnitDef FlatBuffer entry for a single unit def.
/// Factored out so both the bulk and incremental senders can reuse it.
/// `nameToDefId` is consulted to translate buildOptions entries (which
/// the engine stores as unit-name strings) into numeric def IDs the
/// client can index. Pass an empty map to skip buildOptions resolution.
template<typename UnitDefT>
inline flatbuffers::Offset<SpringWeb::GameUnitDef> BuildSingleUnitDef(
    flatbuffers::FlatBufferBuilder& fbb,
    const UnitDefT& ud,
    const std::filesystem::path& modelsDir,
    const std::string& gameId,
    const std::unordered_map<std::string, int>& nameToDefId = {})
{
    namespace fs = std::filesystem;
    auto nameOff = fbb.CreateString(ud.name);

    std::string modelUrl;
    if (!ud.modelName.empty()) {
        std::string stem = fs::path(ud.modelName).stem().string();
        fs::path glbPath = modelsDir / (stem + ".glb");
        if (fs::exists(glbPath)) {
            modelUrl = "/api/games/data/" + gameId + "/models/" + stem + ".glb";
        }
    }
    auto modelOff   = fbb.CreateString(modelUrl);
    auto texOff     = fbb.CreateString("");
    auto humanOff   = fbb.CreateString(ud.humanName);
    auto tooltipOff = fbb.CreateString(ud.tooltip);
    auto wreckOff   = fbb.CreateString(ud.wreckName);

    // Pack behaviour flags. The bit assignments are documented in
    // schemas/protocol.fbs alongside the `flags` field.
    uint32_t flags = 0;
    if (ud.builder)         flags |= (1u << 0);
    if (ud.canmove)         flags |= (1u << 1);
    if (ud.canfly)          flags |= (1u << 2);
    if (ud.canSubmerge)     flags |= (1u << 3);
    if (ud.floatOnWater)    flags |= (1u << 4);
    if (ud.canCloak)        flags |= (1u << 5);
    if (ud.canKamikaze)     flags |= (1u << 6);
    if (ud.canManualFire)   flags |= (1u << 7);
    if (ud.stealth)         flags |= (1u << 8);
    if (ud.sonarStealth)    flags |= (1u << 9);
    if (ud.reclaimable)     flags |= (1u << 10);
    if (ud.IsFactoryUnit()) flags |= (1u << 11);
    if (ud.IsBuildingUnit())flags |= (1u << 12);
    if (ud.IsAirUnit())     flags |= (1u << 13);
    if (ud.IsExtractorUnit())flags|= (1u << 14);
    if (ud.HasWeapons())    flags |= (1u << 15);

    // Build options — resolved to numeric def IDs. The engine stores
    // them as a map<slot,name>; we sort by slot so the wire order is
    // deterministic and matches what build menu widgets expect.
    std::vector<uint16_t> buildOptions;
    if (!ud.buildOptions.empty() && !nameToDefId.empty()) {
        std::vector<std::pair<int, const std::string*>> slots;
        slots.reserve(ud.buildOptions.size());
        for (const auto& kv : ud.buildOptions) {
            slots.emplace_back(kv.first, &kv.second);
        }
        std::sort(slots.begin(), slots.end(),
            [](const auto& a, const auto& b){ return a.first < b.first; });
        buildOptions.reserve(slots.size());
        for (const auto& s : slots) {
            auto it = nameToDefId.find(*s.second);
            if (it != nameToDefId.end() && it->second > 0) {
                buildOptions.push_back(static_cast<uint16_t>(it->second));
            }
        }
    }

    // Weapon def IDs in slot order. Unused slots are zero so the array
    // length always matches the engine's weapon slot count.
    std::vector<uint16_t> weaponDefIds;
    weaponDefIds.reserve(ud.weapons.size());
    for (const auto& w : ud.weapons) {
        weaponDefIds.push_back(w.def != nullptr ? static_cast<uint16_t>(w.def->id) : 0u);
    }
    while (!weaponDefIds.empty() && weaponDefIds.back() == 0) weaponDefIds.pop_back();

    auto buildOptsOff = fbb.CreateVector(buildOptions);
    auto weaponIdsOff = fbb.CreateVector(weaponDefIds);

    // customParams — game-specific key/value extension. ZK widgets read
    // dozens of these (level, commtype, dynamic_comm, child_of_factory,
    // planetwars_structure, thrower_gather, nuke_coverage, etc.).
    std::vector<flatbuffers::Offset<SpringWeb::CustomParam>> customParamsOffsets;
    customParamsOffsets.reserve(ud.customParams.size());
    for (const auto& kv : ud.customParams) {
        auto kOff = fbb.CreateString(kv.first);
        auto vOff = fbb.CreateString(kv.second);
        SpringWeb::CustomParamBuilder pb(fbb);
        pb.add_key(kOff);
        pb.add_value(vOff);
        customParamsOffsets.push_back(pb.Finish());
    }
    auto customParamsOff = fbb.CreateVector(customParamsOffsets);
    if (ud.name == "amphaa" || ud.name == "staticmex" || ud.name == "gunshiptrans") {
        std::fprintf(stderr, "[Protocol.h] %s: ud.customParams.size=%zu transportSize=%d repairSpeed=%f\n",
            ud.name.c_str(), ud.customParams.size(), ud.transportSize, ud.repairSpeed);
        int dbgCount = 0;
        for (const auto& kv : ud.customParams) {
            std::fprintf(stderr, "  cp: %s=%s\n", kv.first.c_str(), kv.second.c_str());
            if (++dbgCount >= 5) break;
        }
    }

    // Yardmap — serialise to a string of digits (one per cell). ZK
    // widgets use the length to derive footprint shape.
    std::string yardmapStr;
    yardmapStr.reserve(ud.yardmap.size());
    for (auto status : ud.yardmap) {
        yardmapStr.push_back(static_cast<char>('0' + static_cast<int>(status)));
    }
    auto yardmapOff = fbb.CreateString(yardmapStr);
    auto scriptOff  = fbb.CreateString(ud.scriptName);
    auto buildPicOff = fbb.CreateString(ud.buildPicName);

    // Unit sound assets. SoundEvent.sound_id indexes into this array;
    // the categories tell the client which logical sound to play
    // (select / OK / build_start / build_done / ...). The order here
    // also defines the ID assignment — we use a running counter so a
    // single category can contribute multiple alternates.
    std::vector<flatbuffers::Offset<SpringWeb::SoundRef>> soundOffsets;
    {
        uint16_t nextSoundId = 0;
        AppendSoundRefs(soundOffsets, fbb, ud.sounds.select,      SpringWeb::SoundCategory_Select,     nextSoundId);
        AppendSoundRefs(soundOffsets, fbb, ud.sounds.ok,          SpringWeb::SoundCategory_OrderAck,   nextSoundId);
        AppendSoundRefs(soundOffsets, fbb, ud.sounds.arrived,     SpringWeb::SoundCategory_Move,       nextSoundId);
        AppendSoundRefs(soundOffsets, fbb, ud.sounds.build,       SpringWeb::SoundCategory_BuildStart, nextSoundId);
        AppendSoundRefs(soundOffsets, fbb, ud.sounds.repair,      SpringWeb::SoundCategory_Working,    nextSoundId);
        AppendSoundRefs(soundOffsets, fbb, ud.sounds.working,     SpringWeb::SoundCategory_Working,    nextSoundId);
        AppendSoundRefs(soundOffsets, fbb, ud.sounds.underattack, SpringWeb::SoundCategory_Idle,       nextSoundId);
        AppendSoundRefs(soundOffsets, fbb, ud.sounds.cant,        SpringWeb::SoundCategory_Cancel,     nextSoundId);
        AppendSoundRefs(soundOffsets, fbb, ud.sounds.activate,    SpringWeb::SoundCategory_Activate,   nextSoundId);
        AppendSoundRefs(soundOffsets, fbb, ud.sounds.deactivate,  SpringWeb::SoundCategory_Deactivate, nextSoundId);
    }
    auto soundsOff = fbb.CreateVector(soundOffsets);

    SpringWeb::GameUnitDefBuilder b(fbb);
    b.add_def_id(static_cast<uint16_t>(ud.id));
    b.add_name(nameOff);
    b.add_model_url(modelOff);
    b.add_texture_url(texOff);
    b.add_human_name(humanOff);
    b.add_tooltip(tooltipOff);
    b.add_wreck_name(wreckOff);
    b.add_metal_cost(ud.cost.metal);
    b.add_energy_cost(ud.cost.energy);
    b.add_build_time(ud.buildTime);
    b.add_metal_make(ud.resourceMake.metal);
    b.add_energy_make(ud.resourceMake.energy);
    b.add_metal_upkeep(ud.upkeep.metal);
    b.add_energy_upkeep(ud.upkeep.energy);
    b.add_metal_storage(ud.storage.metal);
    b.add_energy_storage(ud.storage.energy);
    b.add_extracts_metal(ud.extractsMetal);
    b.add_health(ud.health);
    b.add_mass(ud.mass);
    b.add_radius(ud.GetModelRadius());
    b.add_xsize(ud.xsize);
    b.add_zsize(ud.zsize);
    b.add_speed(ud.speed);
    b.add_turn_rate(ud.turnRate);
    b.add_max_acc(ud.maxAcc);
    b.add_max_dec(ud.maxDec);
    b.add_los_radius(ud.losRadius);
    b.add_air_los_radius(ud.airLosRadius);
    b.add_radar_radius(ud.radarRadius);
    b.add_sonar_radius(ud.sonarRadius);
    b.add_jammer_radius(ud.jammerRadius);
    b.add_seismic_radius(ud.seismicRadius);
    b.add_flags(flags);
    b.add_build_distance(ud.buildDistance);
    b.add_build_speed(ud.buildSpeed);
    b.add_build_options(buildOptsOff);
    b.add_weapon_def_ids(weaponIdsOff);

    // Tier 4 fields.
    b.add_custom_params(customParamsOff);
    b.add_repair_speed(ud.repairSpeed);
    b.add_transport_size(ud.transportSize);
    b.add_transport_mass(ud.transportMass);
    b.add_transport_capacity(ud.transportCapacity);
    b.add_yardmap(yardmapOff);
    b.add_script(scriptOff);
    b.add_build_pic(buildPicOff);
    b.add_max_velocity(ud.speed);
    b.add_cost(ud.cost.metal + ud.cost.energy);
    b.add_max_weapon_range(ud.maxWeaponRange);
    b.add_max_this_unit(ud.maxThisUnit);
    b.add_can_be_assisted(ud.canBeAssisted);
    b.add_can_self_destruct(ud.canSelfD);
    b.add_self_d_countdown(ud.selfDCountdown);
    b.add_category_bits(ud.category);
    b.add_sounds(soundsOff);
    return b.Finish();
}

/// Build a name→def-id index from the engine's unit def vector. Used by
/// BuildSingleUnitDef to translate buildOptions name strings into IDs.
template<typename UnitDefVec>
inline std::unordered_map<std::string, int> BuildNameToDefIdMap(const UnitDefVec& defs) {
    std::unordered_map<std::string, int> out;
    out.reserve(defs.size());
    for (size_t i = 1; i < defs.size(); i++) {
        out.emplace(defs[i].name, defs[i].id);
    }
    return out;
}

/// Build a GameUnitDefs message listing every unit type and its model URL.
template<typename UnitDefVec>
inline std::vector<uint8_t> BuildGameUnitDefs(
    const UnitDefVec& defs,
    const std::string& gameId)
{
    namespace fs = std::filesystem;
    const fs::path modelsDir = fs::path("data/games") / gameId / "models";
    flatbuffers::FlatBufferBuilder fbb(1024);
    auto nameToId = BuildNameToDefIdMap(defs);

    std::vector<flatbuffers::Offset<SpringWeb::GameUnitDef>> offsets;
    for (size_t i = 1; i < defs.size(); i++) {
        offsets.push_back(BuildSingleUnitDef(fbb, defs[i], modelsDir, gameId, nameToId));
    }

    auto defsVec = fbb.CreateVector(offsets);
    auto baseOff = fbb.CreateString("");
    auto msg = SpringWeb::CreateGameUnitDefs(fbb, defsVec, baseOff);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameUnitDefs, msg.Union());
}

/// Build a GameUnitDefs message containing only the specified def IDs.
/// Used for incremental streaming — only send defs the client hasn't seen.
template<typename UnitDefVec>
inline std::vector<uint8_t> BuildGameUnitDefsSubset(
    const UnitDefVec& allDefs,
    const std::vector<uint16_t>& defIds,
    const std::string& gameId)
{
    namespace fs = std::filesystem;
    const fs::path modelsDir = fs::path("data/games") / gameId / "models";
    flatbuffers::FlatBufferBuilder fbb(512);
    auto nameToId = BuildNameToDefIdMap(allDefs);

    std::vector<flatbuffers::Offset<SpringWeb::GameUnitDef>> offsets;
    for (uint16_t id : defIds) {
        if (id > 0 && static_cast<size_t>(id) < allDefs.size()) {
            offsets.push_back(BuildSingleUnitDef(fbb, allDefs[id], modelsDir, gameId, nameToId));
        }
    }

    auto defsVec = fbb.CreateVector(offsets);
    auto baseOff = fbb.CreateString("");
    auto msg = SpringWeb::CreateGameUnitDefs(fbb, defsVec, baseOff);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameUnitDefs, msg.Union());
}

/// Map Spring's projectile type bitmask to the FlatBuffers ProjectileVisualType enum.
inline SpringWeb::ProjectileVisualType MapProjectileVisualType(unsigned int projType) {
    if (projType & WEAPON_BEAMLASER_PROJECTILE)      return SpringWeb::ProjectileVisualType_BeamLaser;
    if (projType & WEAPON_LARGEBEAMLASER_PROJECTILE)  return SpringWeb::ProjectileVisualType_BeamLaser;
    if (projType & WEAPON_LASER_PROJECTILE)           return SpringWeb::ProjectileVisualType_Laser;
    if (projType & WEAPON_MISSILE_PROJECTILE)         return SpringWeb::ProjectileVisualType_Missile;
    if (projType & WEAPON_STARBURST_PROJECTILE)       return SpringWeb::ProjectileVisualType_Missile;
    if (projType & WEAPON_TORPEDO_PROJECTILE)         return SpringWeb::ProjectileVisualType_Missile;
    if (projType & WEAPON_LIGHTNING_PROJECTILE)        return SpringWeb::ProjectileVisualType_Lightning;
    if (projType & WEAPON_FLAME_PROJECTILE)           return SpringWeb::ProjectileVisualType_Flame;
    if (projType & WEAPON_FIREBALL_PROJECTILE)        return SpringWeb::ProjectileVisualType_Flame;
    // Cannon, EMG, Explosive, and anything else → Cannon
    return SpringWeb::ProjectileVisualType_Cannon;
}

/// Build one GameWeaponDef FlatBuffer entry for a single weapon def.
/// `modelsDir` and `gameId` allow us to resolve the projectile's `.glb`
/// asset URL when the weapon def references a model — same convention
/// as BuildSingleUnitDef. Both default to empty so call sites that
/// don't have a game context yet still compile.
template<typename WeaponDefT>
inline flatbuffers::Offset<SpringWeb::GameWeaponDef> BuildSingleWeaponDef(
    flatbuffers::FlatBufferBuilder& fbb,
    const WeaponDefT& wd,
    const std::filesystem::path& modelsDir = {},
    const std::string& gameId = {})
{
    namespace fs = std::filesystem;
    auto nameOff = fbb.CreateString(wd.name);
    auto typeOff = fbb.CreateString(wd.type);
    auto descOff = fbb.CreateString(wd.description);
    auto visualType = MapProjectileVisualType(wd.projectileType);

    // Projectile model URL — populated only when the weapondef points
    // at a real `.glb` we've actually converted. ZK's missile/cannon/
    // flame weapons reference s3o/dae models in `Objects3d/` which the
    // game-converter ships as `models/<stem>.glb`. If the file is
    // missing on disk we leave the URL empty and the client falls back
    // to per-visual-type procedural shapes.
    std::string modelUrl;
    if (!wd.visuals.modelName.empty() && !gameId.empty()) {
        const std::string stem = fs::path(wd.visuals.modelName).stem().string();
        const fs::path glbPath = modelsDir / (stem + ".glb");
        if (fs::exists(glbPath)) {
            modelUrl = "/api/games/data/" + gameId + "/models/" + stem + ".glb";
        }
    }
    auto modelUrlOff = fbb.CreateString(modelUrl);

    // texture1/2/3 — Spring's three projectile texture slots
    // (`texNames[0..2]`). texture1 is the main diffuse / beam middle;
    // texture2 is the beam end-cap or smoketrail; texture3 is the
    // muzzle/flare exhaust. We send the bare logical name verbatim;
    // the client looks it up in /api/games/<id>/resources.json
    // (the parsed `graphics.projectiletextures` map) and resolves
    // the file path to a `.ktx2` URL via the recursive bitmaps
    // manifest. Selection/fallback rules live entirely on the client.
    // (texNames[3] — large-beam flare — is unused by the current
    // renderer; not streamed.)
    auto texture1Off = fbb.CreateString(wd.visuals.texNames[0]);
    auto texture2Off = fbb.CreateString(wd.visuals.texNames[1]);
    auto texture3Off = fbb.CreateString(wd.visuals.texNames[2]);

    // CEG tags. Spring's `cegTag` (every-frame trail) lives at
    // `visuals.ptrailExpGenTag`; `explosionGenerator` (impact) at
    // `visuals.impactExpGenTag`; `bounceExplosionGenerator` at
    // `visuals.bounceExpGenTag`. The server parses every CEG these
    // tags reference and ships them as a `GameCegDefs` table; the
    // client looks up by name to spawn particles on Fired / Impact.
    // Strip any `custom:` prefix the source tags carry — `LoadGenerator`
    // adds it internally but the bare tag is what indexes into the
    // explosion table.
    auto stripCustom = [](const std::string& tag) -> std::string {
        constexpr const char* kPrefix = "custom:";
        constexpr size_t kPrefixLen = 7;
        if (tag.size() >= kPrefixLen
            && std::strncmp(tag.c_str(), kPrefix, kPrefixLen) == 0)
            return tag.substr(kPrefixLen);
        return tag;
    };
    auto cegTagOff = fbb.CreateString(stripCustom(wd.visuals.ptrailExpGenTag));
    auto expGenOff = fbb.CreateString(stripCustom(wd.visuals.impactExpGenTag));
    auto bounceOff = fbb.CreateString(stripCustom(wd.visuals.bounceExpGenTag));

    // Per-armor-class damage table. Element 0 is the default; we ship
    // the whole vector so widgets can compute "damage vs class N" the
    // way ZK's tooltip widget does. Empty if every entry equals
    // damages[0] (saves bandwidth on simple weapons).
    std::vector<float> damageTable;
    bool varies = false;
    const float def = wd.damages.GetDefault();
    const int numTypes = wd.damages.GetNumTypes();
    damageTable.reserve(numTypes);
    for (int ai = 0; ai < numTypes; ai++) {
        const float d = wd.damages.Get(ai);
        damageTable.push_back(d);
        if (d != def) varies = true;
    }
    if (!varies) damageTable.clear();
    auto damagesOff = fbb.CreateVector(damageTable);

    uint32_t flags = 0;
    if (wd.tracks)               flags |= (1u << 0);
    if (wd.paralyzer)            flags |= (1u << 1);
    if (wd.noSelfDamage)         flags |= (1u << 2);
    if (wd.manualfire)           flags |= (1u << 3);
    if (wd.noAutoTarget)         flags |= (1u << 4);
    if (wd.stockpile)            flags |= (1u << 5);
    if (wd.waterweapon)          flags |= (1u << 6);
    if (wd.fireSubmersed)        flags |= (1u << 7);
    if (wd.submissile)           flags |= (1u << 8);
    if (wd.turret)               flags |= (1u << 9);
    if (wd.onlyForward)          flags |= (1u << 10);
    if (wd.fixedLauncher)        flags |= (1u << 11);
    if (wd.canAttackGround)      flags |= (1u << 12);
    if (wd.avoidFriendly)        flags |= (1u << 13);
    if (wd.avoidFeature)         flags |= (1u << 14);
    if (wd.avoidNeutral)         flags |= (1u << 15);
    if (wd.gravityAffected)      flags |= (1u << 16);
    if (wd.noExplode)            flags |= (1u << 17);
    if (wd.largeBeamLaser)       flags |= (1u << 18);
    if (wd.laserHardStop)        flags |= (1u << 19);
    if (wd.isShield)             flags |= (1u << 20);
    if (wd.smartShield)          flags |= (1u << 21);
    if (wd.exteriorShield)       flags |= (1u << 22);
    if (wd.visibleShield)        flags |= (1u << 23);

    // customParams for the weapon. ZK widgets use these for things like
    // tooltips, AOE overrides, special-effect markers, etc.
    std::vector<flatbuffers::Offset<SpringWeb::CustomParam>> customParamsOffsets;
    customParamsOffsets.reserve(wd.customParams.size());
    for (const auto& kv : wd.customParams) {
        auto kOff = fbb.CreateString(kv.first);
        auto vOff = fbb.CreateString(kv.second);
        SpringWeb::CustomParamBuilder pb(fbb);
        pb.add_key(kOff);
        pb.add_value(vOff);
        customParamsOffsets.push_back(pb.Finish());
    }
    auto wdCustomParamsOff = fbb.CreateVector(customParamsOffsets);

    // Weapon sound assets. `fireSound` holds the firing samples
    // (Spring's `soundStart`). `hitSound` holds two entries in the order
    // [dry, wet] since WeaponDef::ParseWeaponSounds always loads both
    // (soundHitDry then soundHitWet) before any other call site appends
    // alternates — see WeaponDef::ParseWeaponSounds.
    std::vector<flatbuffers::Offset<SpringWeb::SoundRef>> wdSoundOffsets;
    {
        uint16_t nextSoundId = 0;
        AppendSoundRefs(wdSoundOffsets, fbb, wd.fireSound, SpringWeb::SoundCategory_Fire, nextSoundId);
        // hitSound carries [dry, wet]. NumSounds() == 2 in the common case;
        // pull them out individually so we can tag each correctly.
        const int numHit = static_cast<int>(wd.hitSound.NumSounds());
        for (int i = 0; i < numHit; i++) {
            const GuiSoundSetData& d = wd.hitSound.GetSoundData(i);
            if (d.name.empty()) continue;
            const SpringWeb::SoundCategory cat = (i == 0)
                ? SpringWeb::SoundCategory_HitDry
                : SpringWeb::SoundCategory_HitWet;
            auto pathOff = fbb.CreateString(NormalizeSoundPath(d.name));
            auto nameOff = fbb.CreateString(d.name);
            SpringWeb::SoundRefBuilder sb(fbb);
            sb.add_id(nextSoundId++);
            sb.add_path(pathOff);
            sb.add_name(nameOff);
            sb.add_category(cat);
            const float vol = (d.volume > 0.0f) ? std::min(d.volume, 4.0f) : 1.0f;
            sb.add_volume(vol);
            sb.add_pitch(1.0f);
            wdSoundOffsets.push_back(sb.Finish());
        }
    }
    auto wdSoundsOff = fbb.CreateVector(wdSoundOffsets);

    SpringWeb::GameWeaponDefBuilder wdb(fbb);
    wdb.add_def_id(static_cast<uint16_t>(wd.id));
    wdb.add_name(nameOff);
    wdb.add_visual_type(visualType);
    wdb.add_projectile_speed(wd.projectilespeed);
    wdb.add_range(wd.range);
    wdb.add_aoe(wd.damages.damageAreaOfEffect);
    wdb.add_size(wd.size);
    wdb.add_intensity(wd.intensity);
    wdb.add_color_r(wd.visuals.color.x);
    wdb.add_color_g(wd.visuals.color.y);
    wdb.add_color_b(wd.visuals.color.z);
    wdb.add_duration(wd.duration);
    wdb.add_high_trajectory(wd.highTrajectory == 1);

    wdb.add_type_name(typeOff);
    wdb.add_description(descOff);
    wdb.add_default_damage(def);
    wdb.add_damages(damagesOff);
    wdb.add_reload_time(wd.reload);
    wdb.add_salvo_size(wd.salvosize);
    wdb.add_salvo_delay(wd.salvodelay);
    wdb.add_accuracy(wd.accuracy);
    wdb.add_spray_angle(wd.sprayAngle);
    wdb.add_moving_accuracy(wd.movingAccuracy);
    wdb.add_target_move_error(wd.targetMoveError);
    wdb.add_lead_limit(wd.leadLimit);
    wdb.add_edge_effectiveness(wd.damages.edgeEffectiveness);
    wdb.add_impulse_factor(wd.damages.impulseFactor);
    wdb.add_impulse_boost(wd.damages.impulseBoost);
    wdb.add_crater_mult(wd.damages.craterMult);
    wdb.add_crater_boost(wd.damages.craterBoost);
    wdb.add_crater_aoe(wd.damages.craterAreaOfEffect);
    wdb.add_fire_starter(wd.fireStarter);
    wdb.add_flight_time(wd.flighttime);
    wdb.add_weapon_acceleration(wd.weaponacceleration);
    wdb.add_turn_rate(wd.turnrate);
    wdb.add_uptime(wd.uptime);
    wdb.add_coverage_range(wd.coverageRange);
    wdb.add_stockpile_time(wd.stockpileTime);
    wdb.add_metal_cost(wd.cost.metal);
    wdb.add_energy_cost(wd.cost.energy);
    wdb.add_flags(flags);
    wdb.add_custom_params(wdCustomParamsOff);
    wdb.add_model_url(modelUrlOff);
    wdb.add_texture1(texture1Off);
    wdb.add_texture2(texture2Off);
    wdb.add_texture3(texture3Off);
    wdb.add_ceg_tag(cegTagOff);
    wdb.add_explosion_generator(expGenOff);
    wdb.add_bounce_explosion_generator(bounceOff);
    wdb.add_scroll_speed(wd.visuals.scrollspeed);
    wdb.add_sounds(wdSoundsOff);
    return wdb.Finish();
}

/// Build a GameWeaponDefs message listing every weapon type and its visual params.
template<typename WeaponDefVec>
inline std::vector<uint8_t> BuildGameWeaponDefs(const WeaponDefVec& defs,
                                                const std::string& gameId = {}) {
    namespace fs = std::filesystem;
    flatbuffers::FlatBufferBuilder fbb(1024);

    const fs::path modelsDir = gameId.empty() ? fs::path{}
        : fs::path("data/games") / gameId / "models";

    std::vector<flatbuffers::Offset<SpringWeb::GameWeaponDef>> offsets;
    for (size_t i = 1; i < defs.size(); i++) {
        offsets.push_back(BuildSingleWeaponDef(fbb, defs[i], modelsDir, gameId));
    }

    auto defsVec = fbb.CreateVector(offsets);
    auto msg = SpringWeb::CreateGameWeaponDefs(fbb, defsVec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameWeaponDefs, msg.Union());
}

/// Build a GameWeaponDefs message containing only the specified def IDs.
template<typename WeaponDefVec>
inline std::vector<uint8_t> BuildGameWeaponDefsSubset(
    const WeaponDefVec& allDefs,
    const std::vector<uint16_t>& defIds,
    const std::string& gameId = {})
{
    namespace fs = std::filesystem;
    flatbuffers::FlatBufferBuilder fbb(512);

    const fs::path modelsDir = gameId.empty() ? fs::path{}
        : fs::path("data/games") / gameId / "models";

    std::vector<flatbuffers::Offset<SpringWeb::GameWeaponDef>> offsets;
    for (uint16_t id : defIds) {
        if (id > 0 && static_cast<size_t>(id) < allDefs.size()) {
            offsets.push_back(BuildSingleWeaponDef(fbb, allDefs[id], modelsDir, gameId));
        }
    }

    auto defsVec = fbb.CreateVector(offsets);
    auto msg = SpringWeb::CreateGameWeaponDefs(fbb, defsVec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameWeaponDefs, msg.Union());
}

} // namespace Protocol
