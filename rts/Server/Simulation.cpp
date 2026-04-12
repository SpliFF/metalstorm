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
#include "Map/MapParser.h"
#include "Server/LobbyIpc.h"
#include "Map/ReadMap.h"
#include "Map/MetalMap.h"
#include "Sim/Misc/ModInfo.h"
#include "Sim/Misc/QuadField.h"
#include "Sim/Misc/SmoothHeightMesh.h"
#include "Sim/Misc/GroundBlockingObjectMap.h"
#include "Sim/Misc/BuildingMaskMap.h"
#include "Sim/Misc/AllyTeam.h"
#include "Sim/Misc/Team.h"
#include "Sim/Units/UnitLoader.h"
#include "Sim/Units/UnitDefHandler.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Units/CommandAI/Command.h"
#include "System/EventHandler.h"
#include "System/Config/ConfigHandler.h"
#include "System/Log/ILog.h"
#include "System/Platform/Threading.h"
#include "System/FileSystem/FileHandler.h"
#include "System/FileSystem/FileSystem.h"

#include "System/Scripting/ScriptEventDispatcher.h"
#include "Lua/LuaScriptContext.h"
#include "Lua/LuaRules.h"
#include "Lua/LuaGaia.h"

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

    // Log any non-fatal errors from the parser
    if (!defsParser->GetErrorLog().empty()) {
        std::fprintf(stderr, "[sim] defs parser log: %s\n",
            defsParser->GetErrorLog().c_str());
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

    // moveDefHandler must init before unitDefHandler (units reference move classes)
    if (hasMap)
        moveDefHandler.Init(defsParser.get());

    weaponDefHandler->Init(defsParser.get());
    unitDefHandler->Init(defsParser.get());
    std::fprintf(stderr, "[sim] loaded %u unit defs, %u weapon defs\n",
        unitDefHandler->NumUnitDefs(), weaponDefHandler->NumWeaponDefs());
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

        // moveDefHandler already initialized above (before unitDefHandler)
        CLosHandler::InitStatic();
        mapDamage = IMapDamage::InitMapDamage();
        pathManager = IPathManager::GetInstance(modInfo.pathFinderSystem);

        groundBlockingObjectMap.Init(mapDims.mapSquares);
        buildingMaskMap.Init(mapDims.hmapx * mapDims.hmapy);

        featureDefHandler->LoadFeatureDefsFromMap();
        featureHandler.LoadFeaturesFromMap();

        envResHandler.LoadTidal(mapInfo->map.tidalStrength);
        envResHandler.LoadWind(mapInfo->atmosphere.minWind, mapInfo->atmosphere.maxWind);

        // Init heightmap digests for LOS system
        readMap->InitHeightMapDigestVectors(losHandler->los.size);

        // Finalize pathfinder (pre-computes caches)
        pathManager->Finalize();

        std::fprintf(stderr, "[sim] map-dependent subsystems initialised\n");
    } else {
        std::fprintf(stderr, "[sim] map-dependent subsystems skipped (no map)\n");
    }

    std::fprintf(stderr, "[sim] subsystems initialised\n");
}


void CSimulation::SetupTestGame()
{
    if (!defsLoaded || !mapLoaded)
        return;

    std::fprintf(stderr, "[sim] setting up game...\n");

    const auto& defs = unitDefHandler->GetUnitDefsVec();

    // Try to find Paper Tanks units by name first
    const char* wantedNames[] = {"pt_lighttank", "pt_heavytank", "pt_artillery", "pt_scout"};
    std::vector<const UnitDef*> spawnDefs;

    for (const char* name : wantedNames) {
        for (size_t i = 1; i < defs.size(); i++) {
            if (defs[i].name == name) {
                spawnDefs.push_back(&defs[i]);
                break;
            }
        }
    }

    // Fallback: pick any movable land units
    if (spawnDefs.empty()) {
        for (size_t i = 1; i < defs.size() && spawnDefs.size() < 4; i++) {
            if (defs[i].canmove && !defs[i].IsAirUnit())
                spawnDefs.push_back(&defs[i]);
        }
    }

    if (spawnDefs.empty()) {
        std::fprintf(stderr, "[sim] WARNING: no spawnable unit defs found\n");
        return;
    }
    std::fprintf(stderr, "[sim] spawning: ");
    for (auto* d : spawnDefs) std::fprintf(stderr, "'%s' ", d->name.c_str());
    std::fprintf(stderr, "\n");

    const float3 mapCenter(mapDims.mapx * SQUARE_SIZE * 0.5f, 0.0f,
                           mapDims.mapy * SQUARE_SIZE * 0.5f);

    // Build the effective roster. When the lobby passes --player /
    // --ai args, rosterEntries is already filled and we spawn one
    // team per entry at that entry's map start position. When the
    // vector is empty (direct CLI invocation for dev smoketests),
    // fall back to the historical 2-team "teams in the middle of
    // the map" layout so the smoketest keeps working.
    std::vector<RosterEntry> effective = rosterEntries;
    const bool usingFallback = effective.empty();
    if (usingFallback) {
        effective.push_back({0, -1});
        effective.push_back({1, -1});
    }

    // Resolve the map's start positions once via MapParser. mapinfo
    // stores them under `teams[i].startPos = {x, z}`; MapParser's
    // GetStartPos returns false if the team index has no entry. We
    // look up on demand rather than caching so the parser's error
    // messages surface through the normal log.
    const std::string mapConfig = MapParser::GetMapConfigName(mapInfo->map.name);
    MapParser mapParser(mapConfig);

    auto teamStartPos = [&](int posIdx, float3& out) -> bool {
        if (posIdx < 0) return false;
        if (!mapParser.IsValid()) return false;
        return mapParser.GetStartPos(posIdx, out);
    };

    // Track spawn counts per team for logging. We don't care about
    // a specific upper bound — the handler serves N teams and we
    // emit a per-team count at the end.
    std::vector<int> spawnedPerTeam;

    for (size_t e = 0; e < effective.size(); ++e) {
        const RosterEntry& entry = effective[e];
        const int team = entry.team;

        // Resolve spawn origin: prefer the authored start position;
        // fall back to a deterministic grid layout around the map
        // centre so even a map with no `teams[]` table gives
        // playable spawns. Fallback layout is a square-ish ring
        // spaced 200 elmos apart to keep small maps visible and
        // large maps from stacking units on top of each other.
        float3 origin = mapCenter;
        if (!teamStartPos(entry.startPosIdx, origin)) {
            if (usingFallback) {
                // Preserve the legacy "teams 100 elmos apart on x"
                // layout so dev smoketests look identical.
                origin.x = mapCenter.x + (team == 0 ? -100.0f : 100.0f);
            } else {
                // Spread entries in a ring around the map centre
                // by angle derived from their index.
                const float angle =
                    (static_cast<float>(e) / effective.size()) * 6.2831853f;
                const float radius = 400.0f;
                origin.x = mapCenter.x + radius * std::cos(angle);
                origin.z = mapCenter.z + radius * std::sin(angle);
            }
            std::fprintf(stderr,
                "[sim] team %d: no map start pos (idx=%d), using fallback (%.0f, %.0f)\n",
                team, entry.startPosIdx, origin.x, origin.z);
        }

        int spawnedThisTeam = 0;
        const int totalPerTeam = static_cast<int>(spawnDefs.size()) * 3;
        for (size_t d = 0; d < spawnDefs.size(); d++) {
            for (int i = 0; i < 3; i++) {
                float3 pos = origin;
                // Spread units along z, centred on origin.z. Use
                // signed-int math — unsigned underflow from size_t
                // arithmetic happily produces astronomical values.
                const int unitIdx = static_cast<int>(d) * 3 + i;
                pos.z += (unitIdx - (totalPerTeam - 1) * 0.5f) * 40.0f;
                // y is left at 0 intentionally — CUnitLoader::LoadUnit
                // ground-clamps non-flying unit spawn positions
                // for us.

                UnitLoadParams params;
                params.unitDef = spawnDefs[d];
                params.builder = nullptr;
                params.pos = pos;
                params.speed = ZeroVector;
                params.unitID = -1;
                params.teamID = team;
                // Face units toward the map centre so multi-team
                // games look sensible. Heading is 0..65535 unsigned;
                // we just pick one of four cardinal facings based
                // on the dominant axis of (centre - origin).
                const float dx = mapCenter.x - origin.x;
                const float dz = mapCenter.z - origin.z;
                if (std::fabs(dx) > std::fabs(dz))
                    params.facing = (dx > 0) ? 1 : 3; // east or west
                else
                    params.facing = (dz > 0) ? 0 : 2; // south or north
                params.beingBuilt = false;
                params.flattenGround = false;

                try {
                    CUnit* unit = unitLoader->LoadUnit(params);
                    if (unit != nullptr)
                        spawnedThisTeam++;
                } catch (const std::exception& ex) {
                    std::fprintf(stderr, "[sim] failed to spawn '%s' for team %d: %s\n",
                        spawnDefs[d]->name.c_str(), team, ex.what());
                }
            }
        }
        if (static_cast<size_t>(team) >= spawnedPerTeam.size())
            spawnedPerTeam.resize(team + 1, 0);
        spawnedPerTeam[team] += spawnedThisTeam;
    }

    int total = 0;
    for (int n : spawnedPerTeam) total += n;
    std::fprintf(stderr, "[sim] spawned %d units across %zu team(s):",
        total, effective.size());
    for (size_t t = 0; t < spawnedPerTeam.size(); ++t) {
        if (spawnedPerTeam[t] > 0)
            std::fprintf(stderr, " t%zu=%d", t, spawnedPerTeam[t]);
    }
    std::fprintf(stderr, "\n");

    // Units spawn idle — strategic direction is delegated to the
    // AI slot system (content/engine/ai, content/games/<game>/ai)
    // which the lobby host opts into before game start. Spring's
    // normal FIRESTATE_FIREATWILL default is preserved, so a parked
    // unit still returns fire on enemies in range; only strategic
    // movement/attack decisions are now the AI's responsibility.
    std::fprintf(stderr, "[sim] units spawned idle (AI opt-in via lobby)\n");
}


void CSimulation::InitScripting()
{
    if (!defsLoaded)
        return;

    std::fprintf(stderr, "[sim] initialising scripting...\n");

    // Create the script event dispatcher
    scriptDispatcher = new ScriptEventDispatcher();
    scriptDispatcher->Register();

    // Try to load LuaRules (game-wide synced gadgets) and LuaGaia
    // (map/environment synced gadgets). Either can be absent — the
    // underlying InitSynced() logs the precise reason (file missing,
    // empty, Lua syntax error, etc.) so we don't second-guess it here
    // with a misleading "no main.lua" message.
    if (CLuaRules::LoadHandler(true)) {
        auto* ctx = new LuaScriptContext(&luaRules->syncedLuaHandle);
        scriptDispatcher->AddContext(ctx);
        scriptingLoaded = true;
        std::fprintf(stderr, "[sim] LuaRules attached to event dispatcher\n");
    } else {
        std::fprintf(stderr, "[sim] LuaRules not loaded (see [lua:LuaRules] above for reason)\n");
    }

    if (CLuaGaia::LoadHandler(true)) {
        auto* ctx = new LuaScriptContext(&luaGaia->syncedLuaHandle);
        scriptDispatcher->AddContext(ctx);
        scriptingLoaded = true;
        std::fprintf(stderr, "[sim] LuaGaia attached to event dispatcher\n");
    } else {
        std::fprintf(stderr, "[sim] LuaGaia not loaded (see [lua:LuaGaia] above for reason)\n");
    }

    std::fprintf(stderr, "[sim] scripting initialised (%zu contexts)\n",
        scriptDispatcher->GetContexts().size());
}

void CSimulation::Init(const std::string& mapName)
{
    // Tell the threading system this is the main thread
    Threading::SetMainThread();
    Threading::SetGameLoadThread();

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

    // Set up teams + ally teams based on the roster.
    //
    // The team count is driven by the highest team id used in the
    // roster (plus one), so a roster of e.g. {team=0, team=2}
    // creates three teams 0..2 — team 1 is unused but still exists
    // as a slot so the id stays stable. Empty roster falls back to
    // the legacy 2-team layout. Each non-Gaia team is its own ally
    // team for now (teamAllyteam == team), which preserves Spring's
    // "everyone is their own ally until modinfo says otherwise"
    // default.
    int maxTeamId = -1;
    for (const auto& e : rosterEntries)
        if (e.team > maxTeamId) maxTeamId = e.team;
    const int playerTeamCount = std::max(2, maxTeamId + 1);
    // +1 for the Gaia team (neutral/environment), +1 for its ally team
    const int gaiaTeamIdx     = playerTeamCount;
    const int gaiaAllyTeamIdx = playerTeamCount;
    const int totalTeams      = playerTeamCount + 1;
    const int totalAllyTeams  = playerTeamCount + 1;

    {
        auto& allyTeams = teamHandler.GetAllyTeams();
        allyTeams.resize(totalAllyTeams);
        for (int i = 0; i < totalAllyTeams; i++) {
            allyTeams[i].allies.assign(totalAllyTeams, false);
            allyTeams[i].allies[i] = true;
        }

        auto& teams = teamHandler.GetTeams();
        teams.resize(totalTeams);
        for (int i = 0; i < playerTeamCount; i++) {
            teams[i].teamNum = i;
            teams[i].teamAllyteam = i;
            teams[i].SetDefaultColor(i);
            teams[i].SetMaxUnits(MAX_UNITS / std::max(1, totalTeams));
            if (hasMap) {
                // Start positions are set for real in SetupTestGame
                // once MapParser has had a chance to resolve them
                // against the map's teams[] table. The placeholder
                // here is only used by sim code that reads
                // team->startPos before a unit has been spawned.
                teams[i].SetStartPos(float3(
                    mapDims.mapx * SQUARE_SIZE * 0.5f,
                    0.0f,
                    mapDims.mapy * SQUARE_SIZE * 0.5f));
            }
        }

        // Gaia team: neutral/environment, its own ally team, no allies
        teams[gaiaTeamIdx].teamNum = gaiaTeamIdx;
        teams[gaiaTeamIdx].teamAllyteam = gaiaAllyTeamIdx;
        teams[gaiaTeamIdx].SetDefaultColor(gaiaTeamIdx);
        teams[gaiaTeamIdx].SetMaxUnits(MAX_UNITS / std::max(1, totalTeams));

        teamHandler.SetGaiaTeamID(gaiaTeamIdx);
        teamHandler.SetGaiaAllyTeamID(gaiaAllyTeamIdx);
        gs->useLuaGaia = true;
    }

    // Initialise all subsystems
    InitSubsystems(hasMap);
    mapLoaded = hasMap;

    // Start game scripting (LuaRules, LuaGaia) BEFORE spawning any
    // units. If we spawned first, every UnitCreated / UnitFinished
    // event would fire before the gadget handler had a chance to
    // register its listeners — gadgets would load into a world full
    // of units they never saw being born. Real Spring games rely on
    // game_spawn.lua firing from GameStart to create starting units,
    // which avoids the ordering problem entirely; we preserve that
    // invariant here so ported gadgets behave the same way.
    InitScripting();

    // Fire GameStart once LuaRules is live. Real Spring calls this
    // after the loading screen finishes; we do it immediately after
    // script init since there's no loading screen to wait for.
    // Without this, gadget:GameStart() callins never fire and
    // anything that initialises team state / spawns starting units
    // from there silently does nothing.
    if (scriptingLoaded) {
        std::fprintf(stderr, "[sim] firing GameStart\n");
        eventHandler.GameStart();
        // Tell the lobby we've made it past the boot sequence so
        // it can transition the room from Loading to Active. No-op
        // if no event pipe was provided on the command line (dev
        // smoketest path).
        LobbyIpc::SendGameStarted(static_cast<uint32_t>(gs->frameNum));
    }

    // Spawn test units for development / headless integration
    // testing. In a real game this call goes away — starting units
    // come from a LuaRules `game_spawn` gadget, which runs at this
    // point because GameStart has now fired.
    SetupTestGame();

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
