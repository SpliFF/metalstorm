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
#include "Sim/Misc/ModInfo.h"
#include "System/EventHandler.h"
#include "System/Config/ConfigHandler.h"
#include "System/Log/ILog.h"

#include <cstdio>


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

void CSimulation::InitSubsystems()
{
    std::fprintf(stderr, "[sim] initialising subsystems...\n");

    // Order follows CGame::PreLoadSimulation + PostLoadSimulation

    // Provide a default mapInfo if no map is loaded
    if (mapInfo == nullptr)
        mapInfo = new CMapInfo();

    // Load mod rules (gamedata/modrules.lua)
    std::fprintf(stderr, "[sim]   modInfo.Init...\n");
    modInfo.Init("");

    // --- Map-independent subsystems ---

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

    // --- Map-dependent subsystems (deferred until map is loaded) ---
    // moveDefHandler.Init(defsParser.get())  — needs mapInfo->terrainTypes
    // CLosHandler::InitStatic()              — needs map dimensions
    // IPathManager::GetInstance()            — needs map
    // IMapDamage::InitMapDamage()            — needs map
    // featureDefHandler->LoadFeatureDefsFromMap() — needs readMap

    std::fprintf(stderr, "[sim] subsystems initialised\n");
}


void CSimulation::Init()
{
    // Initialise global state objects
    ConfigHandler::Instantiate("", false);
    gs->Init();
    gu->Init();

    // Try to load game definitions.
    // If no game content is configured, this will fail gracefully
    // and the sim will run with empty defs (useful for testing).
    if (LoadDefs()) {
        InitSubsystems();
        defsLoaded = true;
    } else {
        std::fprintf(stderr, "[sim] WARNING: running without game definitions\n");
    }

    running = true;
    std::fprintf(stderr, "[sim] initialised (frame %d, defs=%s)\n",
        gs->frameNum, defsLoaded ? "loaded" : "empty");
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
