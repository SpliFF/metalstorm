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
#include "Sim/Projectiles/WeaponProjectiles/WeaponProjectileTypes.h"
#include <flatbuffers/flatbuffers.h>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <vector>

namespace Protocol {

constexpr uint8_t ENVELOPE_FLATBUFFERS = 0x01;
constexpr uint8_t ENVELOPE_ENTITY_STATE = 0x02;
constexpr uint8_t ENVELOPE_PROJECTILE_STATE = 0x04;

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
    const std::string& message = "",
    int8_t team = -1)
{
    flatbuffers::FlatBufferBuilder fbb(256);
    auto resp = SpringWeb::CreateAuthResponseDirect(fbb, status,
        token.empty() ? nullptr : token.c_str(),
        playerId,
        message.empty() ? nullptr : message.c_str(),
        team);
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

/// Build a PlayerLeft message (broadcast to remaining clients on disconnect).
inline std::vector<uint8_t> BuildPlayerLeft(
    uint32_t playerId, const std::string& username, int8_t team, uint8_t reason)
{
    flatbuffers::FlatBufferBuilder fbb(256);
    auto nameOff = fbb.CreateString(username);
    auto pl = SpringWeb::CreatePlayerLeft(fbb, playerId, nameOff, team, reason);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_PlayerLeft, pl.Union());
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
    auto mapOff = fbb.CreateString(room.mapName);
    auto gameOff = fbb.CreateString(room.gameName);

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
    auto miniUrl = fbb.CreateString("/api/maps/data/" + m.id + "/minimap.dxt1");
    auto tilesUrl = fbb.CreateString("/api/maps/data/" + m.id + "/tiles.dxt1");
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

/// Build one GameUnitDef FlatBuffer entry for a single unit def.
/// Factored out so both the bulk and incremental senders can reuse it.
template<typename UnitDefT>
inline flatbuffers::Offset<SpringWeb::GameUnitDef> BuildSingleUnitDef(
    flatbuffers::FlatBufferBuilder& fbb,
    const UnitDefT& ud,
    const std::filesystem::path& modelsDir,
    const std::string& gameId)
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
    auto modelOff = fbb.CreateString(modelUrl);
    auto texOff = fbb.CreateString("");

    return SpringWeb::CreateGameUnitDef(
        fbb, static_cast<uint16_t>(ud.id), nameOff, modelOff, texOff);
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

    std::vector<flatbuffers::Offset<SpringWeb::GameUnitDef>> offsets;
    for (size_t i = 1; i < defs.size(); i++) {
        offsets.push_back(BuildSingleUnitDef(fbb, defs[i], modelsDir, gameId));
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

    std::vector<flatbuffers::Offset<SpringWeb::GameUnitDef>> offsets;
    for (uint16_t id : defIds) {
        if (id > 0 && static_cast<size_t>(id) < allDefs.size()) {
            offsets.push_back(BuildSingleUnitDef(fbb, allDefs[id], modelsDir, gameId));
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
template<typename WeaponDefT>
inline flatbuffers::Offset<SpringWeb::GameWeaponDef> BuildSingleWeaponDef(
    flatbuffers::FlatBufferBuilder& fbb,
    const WeaponDefT& wd)
{
    auto nameOff = fbb.CreateString(wd.name);
    auto visualType = MapProjectileVisualType(wd.projectileType);

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
    return wdb.Finish();
}

/// Build a GameWeaponDefs message listing every weapon type and its visual params.
template<typename WeaponDefVec>
inline std::vector<uint8_t> BuildGameWeaponDefs(const WeaponDefVec& defs) {
    flatbuffers::FlatBufferBuilder fbb(1024);

    std::vector<flatbuffers::Offset<SpringWeb::GameWeaponDef>> offsets;
    for (size_t i = 1; i < defs.size(); i++) {
        offsets.push_back(BuildSingleWeaponDef(fbb, defs[i]));
    }

    auto defsVec = fbb.CreateVector(offsets);
    auto msg = SpringWeb::CreateGameWeaponDefs(fbb, defsVec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameWeaponDefs, msg.Union());
}

/// Build a GameWeaponDefs message containing only the specified def IDs.
template<typename WeaponDefVec>
inline std::vector<uint8_t> BuildGameWeaponDefsSubset(
    const WeaponDefVec& allDefs,
    const std::vector<uint16_t>& defIds)
{
    flatbuffers::FlatBufferBuilder fbb(512);

    std::vector<flatbuffers::Offset<SpringWeb::GameWeaponDef>> offsets;
    for (uint16_t id : defIds) {
        if (id > 0 && static_cast<size_t>(id) < allDefs.size()) {
            offsets.push_back(BuildSingleWeaponDef(fbb, allDefs[id]));
        }
    }

    auto defsVec = fbb.CreateVector(offsets);
    auto msg = SpringWeb::CreateGameWeaponDefs(fbb, defsVec);
    return BuildServerMessage(fbb, SpringWeb::ServerPayload_GameWeaponDefs, msg.Union());
}

} // namespace Protocol
