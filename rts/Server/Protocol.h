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
#include "MapProcessor.h"
#include <flatbuffers/flatbuffers.h>
#include <cstdint>
#include <fstream>
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
        static_cast<uint8_t>(room.countdownSeconds),
        room.gameServerPort);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_RoomStateUpdate, update.Union());
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
        std::string minimapUrl = "/api/maps/data/" + m.id + "/minimap.dxt1";
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
    auto miniUrl = fbb.CreateString("/api/maps/data/" + m.id + "/minimap.dxt1");
    auto tilesUrl = fbb.CreateString("/api/maps/data/" + m.id + "/tiles.dxt1");
    auto baseUrl = fbb.CreateString("/api/maps/data/" + m.id);
    auto sourceUrl = fbb.CreateString("/api/maps/source/" + m.id);

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
