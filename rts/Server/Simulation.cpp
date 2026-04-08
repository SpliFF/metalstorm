/**
 * CSimulation — orchestrates the Spring simulation loop.
 *
 * The sim tick order is preserved from the original CGame::SimFrame()
 * (Game.cpp:1478 in pre-Phase-0 code). Only the synced portion is kept;
 * unsynced client code (sound, UI, eoh, grouphandlers) is gone.
 */

#include "Simulation.h"

#include "Sim/Misc/GlobalSynced.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/Wind.h"
#include "Sim/Misc/InterceptHandler.h"
#include "Sim/Misc/LosHandler.h"
#include "Sim/Misc/DamageArrayHandler.h"
#include "Sim/Misc/CommonDefHandler.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/UnitDefHandler.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/Scripts/UnitScriptEngine.h"
#include "Sim/Units/Scripts/UnitScriptFactory.h"
#include "Sim/Weapons/WeaponDefHandler.h"
#include "Sim/Weapons/WeaponLoader.h"
#include "Sim/Features/FeatureHandler.h"
#include "Sim/Features/FeatureDefHandler.h"
#include "Sim/MoveTypes/MoveDefHandler.h"
#include "Sim/MoveTypes/MoveTypeFactory.h"
#include "Sim/Projectiles/ProjectileHandler.h"
#include "Sim/Projectiles/ExplosionGenerator.h"
#include "Sim/Path/IPathManager.h"
#include "Game/GameHelper.h"
#include "Game/Players/PlayerHandler.h"
#include "Game/WaitCommandsAI.h"
#include "Game/GlobalUnsynced.h"
#include "Lua/LuaParser.h"
#include "Lua/LuaSyncedRead.h"
#include "Map/MapDamage.h"
#include "Map/MapInfo.h"
#include "Map/ReadMap.h"
#include "Map/MetalMap.h"
#include "Sim/Misc/ModInfo.h"
#include "Sim/Misc/QuadField.h"
#include "Sim/Misc/SmoothHeightMesh.h"
#include "Sim/Misc/GroundBlockingObjectMap.h"
#include "Sim/Misc/BuildingMaskMap.h"
#include "System/EventHandler.h"
#include "System/Config/ConfigHandler.h"
#include "System/Log/ILog.h"
#include "System/FileSystem/FileHandler.h"
#include "System/FileSystem/FileSystem.h"

#include <cstdio>
#include <filesystem>


CSimulation::CSimulation() = default;
CSimulation::~CSimulation() noexcept = default;

bool CSimulation::LoadDefs()
{
    std::fprintf(stderr, "[sim] loading game definitions from gamedata/defs.lua...\n");

    defsParser = std::make_unique<LuaParser>(
        "gamedata/defs.lua",
        SPRING_VFS_MOD_BASE,
        SPRING_VFS_ZIP,
        LuaParser::boolean{true},   // synced
        LuaParser::boolean{false}   // don't auto-setup — we call SetupLua manually
    );

    defsParser->SetupLua(true, true);

    // Provide Spring.GetModOptions / Spring.GetMapOptions
    // (returns empty tables until a real game setup is loaded)
    defsParser->GetTable("Spring");
    defsParser->AddFunc("GetModOptions", LuaSyncedRead::GetModOptions);
    defsParser->AddFunc("GetMapOptions", LuaSyncedRead::GetMapOptions);
    defsParser->EndTable();

    if (!defsParser->Execute()) {
        std::fprintf(stderr, "[sim] ERROR: defs parser failed: %s\n",
            defsParser->GetErrorLog().c_str());
        return false;
    }

    const LuaTable root = defsParser->GetRoot();
    if (!root.IsValid()) {
        std::fprintf(stderr, "[sim] ERROR: defs parser returned no root table\n");
        return false;
    }

    // Verify required tables exist
    const char* requiredTables[] = {"UnitDefs", "FeatureDefs", "WeaponDefs", "ArmorDefs", "MoveDefs"};
    for (const char* name : requiredTables) {
        if (!root.SubTable(name).IsValid()) {
            std::fprintf(stderr, "[sim] ERROR: missing required table '%s'\n", name);
            return false;
        }
    }

    std::fprintf(stderr, "[sim] game definitions loaded successfully\n");
    return true;
}

bool CSimulation::LoadMap(const std::string& mapName)
{
    if (mapName.empty())
        return false;

    // Find the .smf file
    std::string smfPath;
    namespace fs = std::filesystem;

    if (fs::exists(mapName) && fs::is_regular_file(mapName)) {
        smfPath = mapName;
    } else {
        // Search for .smf files in the map directory
        auto mapFiles = CFileHandler::DirList("maps", "*.smf");
        if (!mapFiles.empty()) {
            smfPath = CFileHandler::GetFileAbsolutePath(mapFiles[0]);
        }
    }

    if (smfPath.empty()) {
        std::fprintf(stderr, "[sim] ERROR: no .smf file found for map '%s'\n", mapName.c_str());
        return false;
    }

    std::fprintf(stderr, "[sim] loading map: %s\n", smfPath.c_str());

    // Create CMapInfo from the map's mapinfo.lua
    // MapParser looks for mapinfo.lua in content roots (the map directory)
    try {
        mapInfo = new CMapInfo(smfPath, FileSystem::GetBasename(smfPath));
    } catch (const std::exception& e) {
        std::fprintf(stderr, "[sim] ERROR: failed to load map info: %s\n", e.what());
        return false;
    }

    // Load the SMF heightmap
    try {
        readMap = CReadMap::LoadMap(smfPath);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "[sim] ERROR: failed to load SMF: %s\n", e.what());
        return false;
    }

    if (readMap == nullptr) {
        std::fprintf(stderr, "[sim] ERROR: CReadMap::LoadMap returned null\n");
        return false;
    }

    std::fprintf(stderr, "[sim] map loaded: %dx%d (%dx%d elmos)\n",
        mapDims.mapx, mapDims.mapy,
        mapDims.mapx * SQUARE_SIZE, mapDims.mapy * SQUARE_SIZE);
    return true;
}


void CSimulation::InitSubsystems(bool hasMap)
{
    std::fprintf(stderr, "[sim] initialising subsystems...\n");

    // Provide a default mapInfo if no map is loaded
    if (mapInfo == nullptr)
        mapInfo = new CMapInfo();

    // Load mod rules (gamedata/modrules.lua)
    modInfo.Init("");

    // --- Always-init subsystems ---

    damageArrayHandler.Init(defsParser.get());
    explGenHandler.Init();
    CommonDefHandler::InitStatic();
    weaponDefHandler->Init(defsParser.get());
    unitDefHandler->Init(defsParser.get());
    featureDefHandler->Init(defsParser.get());

    CUnit::InitStatic();
    CCommandAI::InitCommandDescriptionCache();
    CUnitScriptFactory::InitStatic();
    CUnitScriptEngine::InitStatic();
    MoveTypeFactory::InitStatic();
    CWeaponLoader::InitStatic();

    helper->Init();
    unitHandler.Init();
    featureHandler.Init();
    projectileHandler.Init();

    // --- Map-dependent subsystems ---
    if (hasMap) {
        smoothGround.Init(float3::maxxpos, float3::maxzpos, SQUARE_SIZE * 2, SQUARE_SIZE * 40);
        quadField.Init(int2(mapDims.mapx, mapDims.mapy), CQuadField::BASE_QUAD_SIZE);

        moveDefHandler.Init(defsParser.get());
        CLosHandler::InitStatic();
        mapDamage = IMapDamage::InitMapDamage();
        pathManager = IPathManager::GetInstance(modInfo.pathFinderSystem);

        groundBlockingObjectMap.Init(mapDims.mapSquares);
        buildingMaskMap.Init(mapDims.hmapx * mapDims.hmapy);

        featureDefHandler->LoadFeatureDefsFromMap();
        featureHandler.LoadFeaturesFromMap();

        envResHandler.LoadTidal(mapInfo->map.tidalStrength);
        envResHandler.LoadWind(mapInfo->atmosphere.minWind, mapInfo->atmosphere.maxWind);

        // Finalize pathfinder (pre-computes caches)
        pathManager->Finalize();

        std::fprintf(stderr, "[sim] map-dependent subsystems initialised\n");
    } else {
        std::fprintf(stderr, "[sim] map-dependent subsystems skipped (no map)\n");
    }

    std::fprintf(stderr, "[sim] subsystems initialised\n");
}


void CSimulation::Init(const std::string& mapName)
{
    // Initialise global state objects
    ConfigHandler::Instantiate("", false);
    gs->Init();
    gu->Init();

    // Try to load game definitions
    if (!LoadDefs()) {
        std::fprintf(stderr, "[sim] WARNING: running without game definitions\n");
        running = true;
        return;
    }
    defsLoaded = true;

    // Try to load the map
    bool hasMap = LoadMap(mapName);

    // Initialise all subsystems
    InitSubsystems(hasMap);
    mapLoaded = hasMap;

    running = true;
    std::fprintf(stderr, "[sim] initialised (frame %d, defs=%s, map=%s)\n",
        gs->frameNum,
        defsLoaded ? "loaded" : "empty",
        mapLoaded ? "loaded" : "none");
}

void CSimulation::Kill()
{
    running = false;
    defsParser.reset();
    gs->Kill();
    std::fprintf(stderr, "[sim] shut down\n");
}

void CSimulation::SimFrame()
{
    if (!running)
        return;

    // Advance frame counter (starts at -1, first real frame is 0)
    gs->frameNum += 1;

    // --- Synced simulation tick ---
    // Order preserved from CGame::SimFrame().

    // Lua game-frame call-in + garbage collection
    eventHandler.CollectGarbage(false);
    eventHandler.GameFrame(gs->frameNum);

    // Core sim updates
    helper->Update();
    mapDamage->Update();
    pathManager->Update();
    unitHandler.Update();
    projectileHandler.Update();
    featureHandler.Update();

    // Unit script animations (COB/Lua piece turns, spins, moves)
    if (unitScriptEngine != nullptr)
        unitScriptEngine->Tick(33); // 33ms ≈ 1 tick at 30Hz

    // Environment (wind, tidal)
    envResHandler.Update();

    // Line-of-sight
    if (losHandler != nullptr)
        losHandler->Update();

    // Interceptor/anti-nuke tracking
    interceptHandler.Update(false);

    // Team and player frame hooks
    teamHandler.GameFrame(gs->frameNum);
    playerHandler.GameFrame(gs->frameNum);

    // Wait-command AI (squad-wait, death-wait, etc.)
    waitCommandsAI.Update();
}

int CSimulation::GetFrameNum() const
{
    return gs->frameNum;
}
