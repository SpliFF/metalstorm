/**
 * Protocol helpers — envelope framing and message construction.
 *
 * Every binary frame starts with a u8 envelope byte (carried over WebTransport
 * streams/datagrams — see PLAN-game-worker.md):
 *   0x01 = FlatBuffers message     0x02/0x03 = entity state (full/delta)
 *   0x05 = piece state  0x06 = build activity  0x07 = LOS bitmap
 *   0x08 = decals       0x09 = heightmap patch
 */
#pragma once

#include "protocol_generated.h"
#include "CombatEventCollector.h"
#include "DecalEventCollector.h"
#include "MusicStateTracker.h"
#include "ProjectileEventCollector.h"
#include "SoundEventCollector.h"
#include "IntelEventCollector.h"
#include "UnitLifecycleCollector.h"
#include "FeatureLifecycleCollector.h"
#include "PlayerTeamEventCollector.h"
#include "UnitCommandCollector.h"
#include "RoomManager.h"
#include "MapMetadata.h"
#include "StandingOrders.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Weapons/Weapon.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "Sim/Units/CommandAI/CommandDescription.h"
#include "Sim/Units/CommandAI/CommandQueue.h"
#include <flatbuffers/flatbuffers.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <string>
#include <unordered_set>
#include <vector>

namespace Protocol {

/// Wire-protocol version negotiated in the Handshake (C1). Bump on any
/// breaking change to the FlatBuffers schema or binary envelope formats; the
/// server rejects clients that send a different value (a stale cached JS
/// bundle against a changed schema is exactly the failure this prevents).
/// Additive, default-valued FlatBuffers fields do NOT require a bump.
/// Keep in sync with PROTOCOL_VERSION in client/src/core/connection.ts.
constexpr uint16_t CURRENT_PROTOCOL_VERSION = 1;

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
/// Ground decals (scars + track segments). Custom binary struct-of-arrays,
/// write-once (no delta). Layout: u8 envelope + u32 frame + u16 scarCount +
/// scars[] + u16 trackCount + tracks[]. See BuildDecalBatch below.
constexpr uint8_t ENVELOPE_DECALS = 0x08;
/// Heightmap deformation patch (PLAN-deformable-terrain T2). One changed
/// corner-rect of the synced heightmap, broadcast to all clients each tick
/// the terrain deforms (engine craters + Spring.*HeightMap terraforming).
/// Terrain has no fog of war, so it is not LOS-filtered. Heights are int16
/// quantised at 1/16 elmo (range +-2048 elmo). Layout: u8 envelope + u32
/// frame + u16 x1 + u16 z1 + u16 x2 + u16 z2 (inclusive corner coords) +
/// int16 heights[(x2-x1+1)*(z2-z1+1)] row-major (z outer, x inner).
/// See BuildHeightmapUpdate below.
constexpr uint8_t ENVELOPE_HEIGHTMAP = 0x09;

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
            e.team,
            e.weaponDefId));
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

/// Build a SendToUnsyncedEvent — forwarded `Spring.SendToUnsynced(...)`
/// from a synced LuaRules gadget. The variadic args were validated to
/// nil/bool/number/string by the synced callout (see
/// CSyncedLuaHandle::SendToUnsynced) so the variant kind drives a
/// straight 1:1 serialise. First arg is conventionally the topic the
/// widget worker dispatches on; the field is kept as a generic arg
/// vector to match upstream's `RecvFromSynced(topic, ...)` shape.
inline std::vector<uint8_t> BuildSendToUnsyncedEvent(
    const SendToUnsyncedEventData& ev)
{
    flatbuffers::FlatBufferBuilder fbb(256);
    std::vector<flatbuffers::Offset<SpringWeb::SendToUnsyncedArg>> argOffs;
    argOffs.reserve(ev.args.size());
    for (const auto& a : ev.args) {
        flatbuffers::Offset<flatbuffers::String> strOff = 0;
        if (a.kind == SendToUnsyncedArgValue::Kind::String)
            strOff = fbb.CreateString(a.strVal);
        SpringWeb::SendToUnsyncedArgBuilder ab(fbb);
        ab.add_kind(static_cast<SpringWeb::SendToUnsyncedArgKind>(a.kind));
        ab.add_num_val(a.numVal);
        ab.add_bool_val(a.boolVal);
        if (strOff.o != 0) ab.add_str_val(strOff);
        argOffs.push_back(ab.Finish());
    }
    auto argsVec = fbb.CreateVector(argOffs);
    SpringWeb::SendToUnsyncedEventBuilder eb(fbb);
    eb.add_client_id(ev.clientId);
    eb.add_args(argsVec);
    auto evOff = eb.Finish();
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_SendToUnsyncedEvent,
                              evOff.Union());
}

/// Build a LuaUIMsgRelay (relayed `Spring.SendLuaUIMsg` → receiver's
/// `widget:RecvLuaMsg(data, playerID)`). The audience filter has already
/// been applied by the caller; this only frames the payload + sender id.
inline std::vector<uint8_t> BuildLuaUIMsgRelay(
    const std::string& data, int32_t playerId)
{
    flatbuffers::FlatBufferBuilder fbb(64 + data.size());
    auto dataVec = fbb.CreateVector(
        reinterpret_cast<const uint8_t*>(data.data()), data.size());
    SpringWeb::LuaUIMsgRelayBuilder rb(fbb);
    rb.add_data(dataVec);
    rb.add_player_id(playerId);
    auto off = rb.Finish();
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_LuaUIMsgRelay,
                              off.Union());
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

/// Serialize each unit's available command descriptors. Streams the
/// full SCommandDescription surface (name, action, texture, tooltip,
/// type, params, hidden, disabled) so ZK's gui_chili_integral_menu and
/// every cmd_*.lua widget has the data it needs to render and bind
/// hotkeys.
///
/// Bandwidth: a unit has 10-40 cmd-descs; at ~50 bytes per entry that's
/// ~2 KB per unit. Callers should restrict `units` to the player's
/// current selection (see SelectionState) — broadcasting the union of
/// every team unit's cmd-descs would be wasteful since only selected
/// units' command panels are rendered.
inline std::vector<uint8_t> BuildUnitCmdDescs(const std::vector<CUnit*>& units) {
    flatbuffers::FlatBufferBuilder fbb(4096);

    std::vector<flatbuffers::Offset<SpringWeb::UnitCmdDescs>> unitOffsets;
    unitOffsets.reserve(units.size());

    for (const CUnit* u : units) {
        if (u == nullptr || u->commandAI == nullptr) continue;
        const auto& descs = u->commandAI->GetPossibleCommands();

        std::vector<flatbuffers::Offset<SpringWeb::UnitCmdDesc>> cmdOffsets;
        cmdOffsets.reserve(descs.size());
        for (const SCommandDescription* d : descs) {
            if (d == nullptr) continue;
            // Send hidden descs too — widgets sometimes need to query
            // them. The `hidden` field on the wire lets the renderer
            // skip them.
            auto nameOff    = fbb.CreateString(d->name);
            auto actionOff  = fbb.CreateString(d->action);
            auto textureOff = fbb.CreateString(d->iconname);
            auto tooltipOff = fbb.CreateString(d->tooltip);

            std::vector<flatbuffers::Offset<flatbuffers::String>> paramOffs;
            paramOffs.reserve(d->params.size());
            for (const auto& p : d->params) {
                paramOffs.push_back(fbb.CreateString(p));
            }
            auto paramsVec = fbb.CreateVector(paramOffs);

            cmdOffsets.push_back(SpringWeb::CreateUnitCmdDesc(
                fbb,
                static_cast<int32_t>(d->id),
                d->disabled,
                nameOff,
                actionOff,
                textureOff,
                tooltipOff,
                static_cast<int32_t>(d->type),
                paramsVec,
                d->hidden));
        }

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

/// Build a UnitTransportUpdate. Walks `units` and emits an entry per
/// transporter with non-empty cargo. Non-transport units and idle
/// transports are skipped — the client treats absence as "no cargo".
inline std::vector<uint8_t> BuildUnitTransportUpdate(const std::vector<CUnit*>& units) {
    flatbuffers::FlatBufferBuilder fbb(256);

    std::vector<flatbuffers::Offset<SpringWeb::UnitTransportInfo>> entries;
    for (const CUnit* u : units) {
        if (u == nullptr) continue;
        if (u->transportedUnits.empty()) continue;
        std::vector<uint32_t> cargo;
        cargo.reserve(u->transportedUnits.size());
        for (const CUnit::TransportedUnit& tu : u->transportedUnits) {
            if (tu.unit != nullptr)
                cargo.push_back(static_cast<uint32_t>(tu.unit->id));
        }
        if (cargo.empty()) continue;
        auto cargoVec = fbb.CreateVector(cargo);
        entries.push_back(SpringWeb::CreateUnitTransportInfo(
            fbb, static_cast<uint32_t>(u->id), cargoVec));
    }

    auto entriesVec = fbb.CreateVector(entries);
    auto upd = SpringWeb::CreateUnitTransportUpdate(fbb, entriesVec);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_UnitTransportUpdate, upd.Union());
}

/// Build a UnitSelfDUpdate. Emits an entry for every unit whose
/// `selfDCountdown` is non-zero. Snapshot semantics: a unit not
/// present is treated as having no active countdown.
inline std::vector<uint8_t> BuildUnitSelfDUpdate(const std::vector<CUnit*>& units) {
    flatbuffers::FlatBufferBuilder fbb(256);

    std::vector<flatbuffers::Offset<SpringWeb::UnitSelfDInfo>> entries;
    for (const CUnit* u : units) {
        if (u == nullptr) continue;
        if (u->selfDCountdown <= 0) continue;
        const uint16_t secs = static_cast<uint16_t>(
            std::min(u->selfDCountdown, 65535));
        entries.push_back(SpringWeb::CreateUnitSelfDInfo(
            fbb, static_cast<uint32_t>(u->id), secs));
    }

    auto entriesVec = fbb.CreateVector(entries);
    auto upd = SpringWeb::CreateUnitSelfDUpdate(fbb, entriesVec);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_UnitSelfDUpdate, upd.Union());
}

/// Build a UnitStockpileUpdate. Emits an entry for every unit whose
/// stockpileWeapon is non-null AND has non-zero counters or non-zero
/// build progress. Snapshot semantics.
inline std::vector<uint8_t> BuildUnitStockpileUpdate(const std::vector<CUnit*>& units) {
    flatbuffers::FlatBufferBuilder fbb(256);

    std::vector<flatbuffers::Offset<SpringWeb::UnitStockpileInfo>> entries;
    for (const CUnit* u : units) {
        if (u == nullptr || u->stockpileWeapon == nullptr) continue;
        const CWeapon* w = u->stockpileWeapon;
        const int ready  = w->numStockpiled;
        const int queued = w->numStockpileQued;
        const float bp   = w->buildPercent;
        if (ready == 0 && queued == 0 && bp == 0.0f) continue;
        entries.push_back(SpringWeb::CreateUnitStockpileInfo(
            fbb, static_cast<uint32_t>(u->id),
            static_cast<uint16_t>(std::clamp(ready,  0, 65535)),
            static_cast<uint16_t>(std::clamp(queued, 0, 65535)),
            bp));
    }

    auto entriesVec = fbb.CreateVector(entries);
    auto upd = SpringWeb::CreateUnitStockpileUpdate(fbb, entriesVec);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_UnitStockpileUpdate, upd.Union());
}

/// Build a UnitArmoredUpdate. Emits an entry for every unit whose
/// armored state is true OR whose armoredMultiple differs from 1.0
/// (the default non-armored damage multiplier).
inline std::vector<uint8_t> BuildUnitArmoredUpdate(const std::vector<CUnit*>& units) {
    flatbuffers::FlatBufferBuilder fbb(256);

    std::vector<flatbuffers::Offset<SpringWeb::UnitArmoredInfo>> entries;
    for (const CUnit* u : units) {
        if (u == nullptr) continue;
        if (!u->armoredState && u->armoredMultiple == 1.0f) continue;
        entries.push_back(SpringWeb::CreateUnitArmoredInfo(
            fbb, static_cast<uint32_t>(u->id),
            u->armoredState, u->armoredMultiple));
    }

    auto entriesVec = fbb.CreateVector(entries);
    auto upd = SpringWeb::CreateUnitArmoredUpdate(fbb, entriesVec);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_UnitArmoredUpdate, upd.Union());
}

/// Build a UnitLifecycleBatch from a drained event list. Returns an
/// empty vector if `events` is empty so the caller can skip the send.
inline std::vector<uint8_t> BuildUnitLifecycleBatch(
    const std::vector<UnitLifecycleEventData>& events)
{
    if (events.empty()) return {};
    flatbuffers::FlatBufferBuilder fbb(512);

    std::vector<flatbuffers::Offset<SpringWeb::UnitLifecycleEvent>> entries;
    entries.reserve(events.size());
    for (const auto& e : events) {
        SpringWeb::UnitLifecycleKind kind;
        switch (e.kind) {
            case UnitLifecycleKind::FromFactory:
                kind = SpringWeb::UnitLifecycleKind_FromFactory; break;
            case UnitLifecycleKind::Taken:
                kind = SpringWeb::UnitLifecycleKind_Taken; break;
            case UnitLifecycleKind::Given:
                kind = SpringWeb::UnitLifecycleKind_Given; break;
            case UnitLifecycleKind::Created:
                kind = SpringWeb::UnitLifecycleKind_Created; break;
        }
        entries.push_back(SpringWeb::CreateUnitLifecycleEvent(
            fbb, kind,
            e.unitId, e.unitDefId, e.unitTeam,
            e.factoryId, e.factoryDefId, e.userOrders,
            e.oldTeam, e.newTeam,
            e.builderId));
    }

    auto entriesVec = fbb.CreateVector(entries);
    auto batch = SpringWeb::CreateUnitLifecycleBatch(fbb, entriesVec);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_UnitLifecycleBatch, batch.Union());
}

/// Build a FeatureLifecycleBatch from the per-tick spawn + remove lists.
/// Returns an empty vector when both lists are empty so the caller can
/// skip the send (most ticks have no feature churn).
inline std::vector<uint8_t> BuildFeatureLifecycleBatch(
    const std::vector<FeatureSpawnEventData>& spawns,
    const std::vector<FeatureRemovedEventData>& removed)
{
    if (spawns.empty() && removed.empty()) return {};
    flatbuffers::FlatBufferBuilder fbb(512);

    std::vector<flatbuffers::Offset<SpringWeb::FeatureSpawn>> spawnOffs;
    spawnOffs.reserve(spawns.size());
    for (const auto& s : spawns) {
        SpringWeb::FeatureSpawnBuilder b(fbb);
        b.add_feature_id(s.featureId);
        b.add_def_id(s.defId);
        b.add_x(s.x);
        b.add_y(s.y);
        b.add_z(s.z);
        b.add_heading(s.heading);
        b.add_build_facing(s.buildFacing);
        b.add_team(s.team);
        b.add_ally_team(s.allyTeam);
        spawnOffs.push_back(b.Finish());
    }

    std::vector<uint32_t> removedIds;
    removedIds.reserve(removed.size());
    for (const auto& r : removed) removedIds.push_back(r.featureId);

    auto spawnsVec = fbb.CreateVector(spawnOffs);
    auto removedVec = fbb.CreateVector(removedIds);
    auto batch = SpringWeb::CreateFeatureLifecycleBatch(
        fbb, spawnsVec, removedVec);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_FeatureLifecycleBatch, batch.Union());
}

/// Build a UnitCommandBatch from a drained event list. Caller is
/// expected to have already filtered the events to ones the receiving
/// session is allowed to see (allied teams). Returns an empty vector
/// if `events` is empty.
inline std::vector<uint8_t> BuildUnitCommandBatch(
    const std::vector<UnitCommandEventData>& events)
{
    if (events.empty()) return {};
    flatbuffers::FlatBufferBuilder fbb(1024);

    std::vector<flatbuffers::Offset<SpringWeb::UnitCommandEvent>> entries;
    entries.reserve(events.size());
    for (const auto& e : events) {
        SpringWeb::UnitCommandKind kind =
            (e.kind == UnitCommandKind::Issued)
                ? SpringWeb::UnitCommandKind_Issued
                : SpringWeb::UnitCommandKind_Done;
        auto paramsVec = fbb.CreateVector(e.params);
        entries.push_back(SpringWeb::CreateUnitCommandEvent(
            fbb, kind,
            e.unitId, e.unitDefId, e.unitTeam,
            e.cmdId, paramsVec, e.options, e.tag,
            e.playerId, e.fromSynced, e.fromLua));
    }

    auto entriesVec = fbb.CreateVector(entries);
    auto batch = SpringWeb::CreateUnitCommandBatch(fbb, entriesVec);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_UnitCommandBatch, batch.Union());
}

/// Build a PathResponse for a single path request. `waypoints` may be
/// empty if the path manager couldn't find a path; the response still
/// fires so the client can release its pending-request slot.
inline std::vector<uint8_t> BuildPathResponse(
    uint32_t requestId,
    const std::vector<float3>& waypoints,
    float length)
{
    flatbuffers::FlatBufferBuilder fbb(64 + waypoints.size() * 12);
    std::vector<SpringWeb::Vec3> wps;
    wps.reserve(waypoints.size());
    for (const float3& p : waypoints) {
        wps.emplace_back(p.x, p.y, p.z);
    }
    auto wpsVec = fbb.CreateVectorOfStructs(wps);
    auto resp = SpringWeb::CreatePathResponse(fbb, requestId, wpsVec, length);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_PathResponse, resp.Union());
}

/// Build a StandingOrderState snapshot for one viewer team. Includes
/// orders owned by the viewer's team plus orders owned by every team
/// in `alliedTeams` (which should NOT include the viewer's own team —
/// the caller supplies the union). Enemy orders are never included.
/// Sent on any standing-order state change, never per-tick.
inline std::vector<uint8_t> BuildStandingOrderState(
    int viewerTeam,
    const std::vector<int>& alliedTeams,
    const std::vector<StandingOrder>& allOrders)
{
    flatbuffers::FlatBufferBuilder fbb(256 + allOrders.size() * 64);

    auto allowed = [&](int team) {
        if (team == viewerTeam) return true;
        for (int a : alliedTeams) if (a == team) return true;
        return false;
    };

    std::vector<flatbuffers::Offset<SpringWeb::StandingOrderInfo>> infos;
    infos.reserve(allOrders.size());
    for (const StandingOrder& o : allOrders) {
        if (!allowed(o.team)) continue;

        // Build the conditions table. Empty/default fields stay default
        // on the wire (FlatBuffers omits them in the table layout).
        auto squadTypesVec = o.conditions.squadTypes.empty()
            ? flatbuffers::Offset<flatbuffers::Vector<uint16_t>>()
            : fbb.CreateVector(o.conditions.squadTypes);
        std::vector<flatbuffers::Offset<flatbuffers::String>> capStrs;
        capStrs.reserve(o.conditions.hasCapabilities.size());
        for (const std::string& s : o.conditions.hasCapabilities)
            capStrs.push_back(fbb.CreateString(s));
        auto capsVec = capStrs.empty()
            ? flatbuffers::Offset<flatbuffers::Vector<flatbuffers::Offset<flatbuffers::String>>>()
            : fbb.CreateVector(capStrs);

        SpringWeb::Vec3 within(o.conditions.withinCenter.x, o.conditions.withinCenter.y, o.conditions.withinCenter.z);
        SpringWeb::Vec3 outside(o.conditions.outsideCenter.x, o.conditions.outsideCenter.y, o.conditions.outsideCenter.z);

        SpringWeb::StandingOrderConditionsBuilder cb(fbb);
        cb.add_idle_only(o.conditions.idleOnly);
        if (!o.conditions.squadTypes.empty()) cb.add_squad_types(squadTypesVec);
        cb.add_within_radius_center(&within);
        cb.add_within_radius_radius(o.conditions.withinRadius);
        cb.add_outside_radius_center(&outside);
        cb.add_outside_radius_radius(o.conditions.outsideRadius);
        cb.add_min_strength(o.conditions.minStrength);
        if (!capStrs.empty()) cb.add_has_capabilities(capsVec);
        auto condsOff = cb.Finish();

        auto paramsVec = o.params.empty()
            ? flatbuffers::Offset<flatbuffers::Vector<float>>()
            : fbb.CreateVector(o.params);

        SpringWeb::StandingOrderInfoBuilder ib(fbb);
        ib.add_order_id(o.id);
        ib.add_owner_team(static_cast<uint8_t>(o.team));
        ib.add_type(static_cast<SpringWeb::StandingOrderType>(o.type));
        ib.add_priority(o.priority);
        if (!o.params.empty()) ib.add_params(paramsVec);
        ib.add_conditions(condsOff);
        ib.add_assigned_squad_count(static_cast<uint16_t>(o.assigned.size()));
        ib.add_active(o.active);
        ib.add_expires_at_frame(o.expiresAtFrame);
        ib.add_created_at_frame(o.createdAtFrame);
        infos.push_back(ib.Finish());
    }

    auto ordersVec = fbb.CreateVector(infos);
    auto stateOff = SpringWeb::CreateStandingOrderState(fbb, ordersVec);
    return BuildServerMessage(fbb,
        SpringWeb::ServerPayload_StandingOrderState, stateOff.Union());
}

/// Read a StandingOrderConditions FlatBuffer table into the server
/// struct. Missing fields fall back to defaults.
inline StandingOrderConditions ReadStandingOrderConditions(
    const SpringWeb::StandingOrderConditions* fb)
{
    StandingOrderConditions out;
    if (fb == nullptr) return out;
    out.idleOnly = fb->idle_only();
    if (auto* st = fb->squad_types()) {
        out.squadTypes.reserve(st->size());
        for (unsigned i = 0; i < st->size(); i++) out.squadTypes.push_back(st->Get(i));
    }
    if (auto* wc = fb->within_radius_center()) out.withinCenter = float3(wc->x(), wc->y(), wc->z());
    out.withinRadius = fb->within_radius_radius();
    if (auto* oc = fb->outside_radius_center()) out.outsideCenter = float3(oc->x(), oc->y(), oc->z());
    out.outsideRadius = fb->outside_radius_radius();
    out.minStrength = fb->min_strength();
    if (auto* caps = fb->has_capabilities()) {
        out.hasCapabilities.reserve(caps->size());
        for (unsigned i = 0; i < caps->size(); i++) {
            if (auto* s = caps->Get(i)) out.hasCapabilities.emplace_back(s->str());
        }
    }
    return out;
}

/// Build a GameInfo message (map, game, speed, frame, paused, env state).
inline std::vector<uint8_t> BuildGameInfo(
    const std::string& mapId, const std::string& gameId,
    float speed, uint32_t frame, bool paused,
    float windX = 0, float windY = 0, float windZ = 0,
    float windStrength = 0, float tidalStrength = 0,
    bool legacyCoordSystem = false)
{
    flatbuffers::FlatBufferBuilder fbb(256);
    auto mapOff = fbb.CreateString(mapId);
    auto gameOff = fbb.CreateString(gameId);
    auto info = SpringWeb::CreateGameInfo(
        fbb, mapOff, gameOff, speed, frame, paused,
        windX, windY, windZ, windStrength, tidalStrength,
        legacyCoordSystem);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameInfo, info.Union());
}

/// Build a TeamStartInfo message from pre-built struct vectors (the caller
/// owns the TeamHandler/AllyTeam iteration so Protocol.h stays sim-agnostic).
inline std::vector<uint8_t> BuildTeamStartInfo(
    const std::vector<SpringWeb::TeamStartPos>& teams,
    const std::vector<SpringWeb::AllyStartBox>& boxes)
{
    flatbuffers::FlatBufferBuilder fbb(256);
    auto teamsOff = fbb.CreateVectorOfStructs(teams);
    auto boxesOff = fbb.CreateVectorOfStructs(boxes);
    auto info = SpringWeb::CreateTeamStartInfo(fbb, teamsOff, boxesOff);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_TeamStartInfo, info.Union());
}

/// Build a GameModOptions message from the game's modoption set. Sent reliably,
/// once per client on auth (modoptions are immutable for the game-server's
/// lifetime). The caller passes plain string pairs so Protocol.h stays free of
/// the sim's `spring::unordered_map`.
inline std::vector<uint8_t> BuildGameModOptions(
    const std::vector<std::pair<std::string, std::string>>& options)
{
    flatbuffers::FlatBufferBuilder fbb(256);
    std::vector<flatbuffers::Offset<SpringWeb::ModOption>> offs;
    offs.reserve(options.size());
    for (const auto& kv : options) {
        offs.push_back(SpringWeb::CreateModOption(
            fbb, fbb.CreateString(kv.first), fbb.CreateString(kv.second)));
    }
    auto vec = fbb.CreateVector(offs);
    auto info = SpringWeb::CreateGameModOptions(fbb, vec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameModOptions, info.Union());
}

/// Build a PlayerTeamEventBatch from drained collector events. Reliable; the
/// widget worker fans out to widget:PlayerChanged / PlayerAdded /
/// PlayerRemoved / TeamDied.
inline std::vector<uint8_t> BuildPlayerTeamEventBatch(
    const std::vector<PlayerTeamEventData>& events)
{
    flatbuffers::FlatBufferBuilder fbb(128);
    std::vector<SpringWeb::PlayerTeamEventItem> items;
    items.reserve(events.size());
    for (const auto& e : events)
        items.emplace_back(e.kind, e.reason, e.id);
    auto itemsOff = fbb.CreateVectorOfStructs(items);
    auto batch = SpringWeb::CreatePlayerTeamEventBatch(fbb, itemsOff);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_PlayerTeamEventBatch, batch.Union());
}

/// One team's stats-history delta, ready to serialise. The caller (server_main,
/// which owns the TeamHandler) fills `entries` with SpringWeb::TeamStatsEntry
/// values straight off each `CTeam::statHistory` slot so Protocol.h stays
/// sim-agnostic. `baseIndex` is the 0-based slot of entries[0] in the full
/// history.
struct TeamStatsHistoryItemData {
    uint32_t teamId = 0;
    uint32_t baseIndex = 0;
    std::vector<SpringWeb::TeamStatsEntry> entries;
};

/// Build a TeamStatsHistoryBatch (one item per changed team). Reliable; the
/// widget worker splices the entries into its per-team history array and
/// answers Spring.GetTeamStatsHistory from it (applying the alliance gate).
inline std::vector<uint8_t> BuildTeamStatsHistoryBatch(
    const std::vector<TeamStatsHistoryItemData>& teams)
{
    flatbuffers::FlatBufferBuilder fbb(512);
    std::vector<flatbuffers::Offset<SpringWeb::TeamStatsHistoryItem>> items;
    items.reserve(teams.size());
    for (const auto& t : teams) {
        auto entriesOff = fbb.CreateVectorOfStructs(t.entries);
        items.push_back(SpringWeb::CreateTeamStatsHistoryItem(
            fbb, t.teamId, t.baseIndex, entriesOff));
    }
    auto itemsOff = fbb.CreateVector(items);
    auto batch = SpringWeb::CreateTeamStatsHistoryBatch(fbb, itemsOff);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_TeamStatsHistoryBatch, batch.Union());
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
/// anything with `id`, `displayName`, `description`, `version`,
/// `lighting` string members works.
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
        auto lightOff = fbb.CreateString(g.lighting);
        offsets.push_back(SpringWeb::CreateLobbyGameInfo(
            fbb, idOff, nameOff, descOff, verOff, lightOff));
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

/// Build a ground-decal batch (envelope 0x08). Scars + track segments for one
/// frame, packed little-endian. Returns just the envelope byte + header when
/// both lists are empty (caller should skip the send in that case).
inline std::vector<uint8_t> BuildDecalBatch(
    uint32_t frameNo,
    const std::vector<ScarEventData>& scars,
    const std::vector<TrackSegmentEventData>& tracks)
{
    std::vector<uint8_t> out;
    auto putU8  = [&](uint8_t v) { out.push_back(v); };
    auto putU16 = [&](uint16_t v) { out.push_back(uint8_t(v)); out.push_back(uint8_t(v >> 8)); };
    auto putU32 = [&](uint32_t v) { for (int i = 0; i < 4; ++i) out.push_back(uint8_t(v >> (8 * i))); };
    auto putF32 = [&](float v) { uint32_t b; std::memcpy(&b, &v, 4); putU32(b); };
    auto putByte01 = [&](float c) {
        const float x = c < 0.0f ? 0.0f : (c > 1.0f ? 1.0f : c);
        out.push_back(uint8_t(x * 255.0f + 0.5f));
    };

    putU8(ENVELOPE_DECALS);
    putU32(frameNo);

    const size_t scarN = std::min<size_t>(scars.size(), 0xFFFF);
    putU16(uint16_t(scarN));
    for (size_t i = 0; i < scarN; ++i) {
        const ScarEventData& s = scars[i];
        putF32(s.pos.x); putF32(s.pos.y); putF32(s.pos.z);
        putF32(s.radius); putF32(s.ttl); putF32(s.alpha);
        putF32(s.glow); putF32(s.glowTtl);
        putByte01(s.r); putByte01(s.g); putByte01(s.b); putByte01(s.a);
    }

    const size_t trackN = std::min<size_t>(tracks.size(), 0xFFFF);
    putU16(uint16_t(trackN));
    for (size_t i = 0; i < trackN; ++i) {
        const TrackSegmentEventData& t = tracks[i];
        putU32(t.unitId);
        putF32(t.pos.x); putF32(t.pos.y); putF32(t.pos.z);
        putF32(t.dirX); putF32(t.dirZ);
        putF32(t.width); putF32(t.strength);
        putU16(t.trackTypeId);
        putU8(t.team);
    }

    return out;
}

// Heightmap deformation patch (envelope 0x09). Reads the current synced
// corner heights for the inclusive corner-rect [x1..x2] x [z1..z2] and packs
// them int16-quantised at 1/16 elmo. `cornerHeights` is the (mapx+1)-wide
// corner heightmap (CReadMap::GetCornerHeightMapSynced()); `cornerStride` is
// mapx+1. Caller has already merged/clamped the rect to valid corner bounds.
inline std::vector<uint8_t> BuildHeightmapUpdate(
    uint32_t frameNo,
    int x1, int z1, int x2, int z2,
    const float* cornerHeights, int cornerStride)
{
    std::vector<uint8_t> out;
    auto putU8  = [&](uint8_t v) { out.push_back(v); };
    auto putU16 = [&](uint16_t v) { out.push_back(uint8_t(v)); out.push_back(uint8_t(v >> 8)); };
    auto putU32 = [&](uint32_t v) { for (int i = 0; i < 4; ++i) out.push_back(uint8_t(v >> (8 * i))); };
    auto putI16 = [&](int16_t v) { uint16_t u = uint16_t(v); out.push_back(uint8_t(u)); out.push_back(uint8_t(u >> 8)); };

    const int w = (x2 - x1 + 1);
    const int h = (z2 - z1 + 1);

    putU8(ENVELOPE_HEIGHTMAP);
    putU32(frameNo);
    putU16(uint16_t(x1)); putU16(uint16_t(z1));
    putU16(uint16_t(x2)); putU16(uint16_t(z2));

    out.reserve(out.size() + size_t(w) * size_t(h) * 2);
    for (int z = z1; z <= z2; ++z) {
        const float* row = cornerHeights + size_t(z) * cornerStride;
        for (int x = x1; x <= x2; ++x) {
            // int16 at 1/16 elmo; clamp to the representable +-2048 elmo range.
            float q = row[x] * 16.0f;
            if (q >  32767.0f) q =  32767.0f;
            if (q < -32768.0f) q = -32768.0f;
            putI16(int16_t(q >= 0.0f ? q + 0.5f : q - 0.5f));
        }
    }
    return out;
}

} // namespace Protocol
