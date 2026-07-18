/**
 * CSimulation — orchestrates the Spring simulation loop.
 *
 * The sim tick order is preserved from the original CGame::SimFrame()
 * (Game.cpp:1478 in pre-Phase-0 code). Only the synced portion is kept;
 * unsynced client code (sound, UI, eoh, grouphandlers) is gone.
 */

#include "Simulation.h"

const std::unordered_map<int, std::string>* gAITeams = nullptr;

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
#include "Sim/Weapons/StatisticalCombat.h"
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
// LobbyIpc removed — GameStarted is now sent over WebSocket (Tier 2)
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "sim"

#include "Map/ReadMap.h"
#include "Map/MetalMap.h"
#include "Sim/Misc/ModInfo.h"
#include "Sim/Misc/QuadField.h"
#include "Sim/Misc/SmoothHeightMesh.h"
#include "Sim/Misc/GroundBlockingObjectMap.h"
#include "Sim/Misc/BuildingMaskMap.h"
#include "Sim/Misc/YardmapStatusEffectsMap.h"
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
#include "Server/IntelEventCollector.h"
#include "Server/UnitLifecycleCollector.h"
#include "Server/FeatureLifecycleCollector.h"
#include "Server/UnitCommandCollector.h"
#include "Lua/LuaScriptContext.h"
#include "Lua/LuaRules.h"
#include "Lua/LuaGaia.h"

#include <cstdio>
#include <filesystem>


CSimulation::CSimulation() = default;
CSimulation::~CSimulation() noexcept = default;

bool CSimulation::LoadDefs()
{
    SLOG(SPRING_LOG_INFO, "loading game definitions from gamedata/defs.lua...");

    defsParser = std::make_unique<LuaParser>(
        "gamedata/defs.lua",
        SPRING_VFS_MOD_BASE,
        SPRING_VFS_ZIP,
        LuaParser::boolean{true},   // synced
        LuaParser::boolean{false}   // don't auto-setup — we call SetupLua manually
    );

    defsParser->SetupLua(true, true);

    // Customize the defs environment with a subset of LuaSyncedRead — the
    // bare LuaParser has no access to it. Ported 1:1 from upstream Recoil
    // Game::LoadDefs (rts/Game/Game.cpp, LSR_ADDFUNC block); our month-old
    // port only had GetModOptions/GetMapOptions, which is why BAR's defs
    // pipeline crashed: gamedata/unitdefs.lua calls
    // Spring.Utilities.Gametype.IsScavengers() → teamFunctions.getSettings()
    // → Spring.GetGaiaTeamID()/GetTeamInfo()/GetAllyTeamList()/... at parse
    // time. These read the real team handler (game setup is loaded before
    // defs parse), so scav/raptor/gametype detection gets correct values.
    #define LSR_ADDFUNC(f) defsParser->AddFunc(#f, LuaSyncedRead::f)
    defsParser->GetTable("Spring");
    LSR_ADDFUNC(GetModOptions);
    LSR_ADDFUNC(GetModOption);
    LSR_ADDFUNC(GetMapOptions);
    LSR_ADDFUNC(GetMapOption);
    LSR_ADDFUNC(GetTeamLuaAI);
    LSR_ADDFUNC(GetTeamList);
    LSR_ADDFUNC(GetGaiaTeamID);
    LSR_ADDFUNC(GetPlayerList);
    LSR_ADDFUNC(GetAllyTeamList);
    LSR_ADDFUNC(GetTeamInfo);
    LSR_ADDFUNC(GetAllyTeamInfo);
    LSR_ADDFUNC(GetAIInfo);
    LSR_ADDFUNC(GetTeamAllyTeamID);
    LSR_ADDFUNC(AreTeamsAllied);
    LSR_ADDFUNC(ArePlayersAllied);
    LSR_ADDFUNC(GetSideData);
    defsParser->EndTable();
    #undef LSR_ADDFUNC

    if (!defsParser->Execute()) {
        SLOG(SPRING_LOG_ERROR, "defs parser failed: %s",
            defsParser->GetErrorLog().c_str());
        return false;
    }

    // Log any non-fatal errors from the parser
    if (!defsParser->GetErrorLog().empty()) {
        SLOG(SPRING_LOG_NOTICE, "defs parser log: %s",
            defsParser->GetErrorLog().c_str());
    }

    const LuaTable root = defsParser->GetRoot();
    if (!root.IsValid()) {
        SLOG(SPRING_LOG_ERROR, "defs parser returned no root table");
        return false;
    }

    // Verify required tables exist
    const char* requiredTables[] = {"UnitDefs", "FeatureDefs", "WeaponDefs", "ArmorDefs", "MoveDefs"};
    for (const char* name : requiredTables) {
        if (!root.SubTable(name).IsValid()) {
            SLOG(SPRING_LOG_ERROR, "missing required table '%s'", name);
            return false;
        }
    }

    SLOG(SPRING_LOG_INFO, "game definitions loaded successfully");
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
        SLOG(SPRING_LOG_ERROR, "no .smf file found for map '%s'", mapName.c_str());
        return false;
    }

    SLOG(SPRING_LOG_INFO, "loading map: %s", smfPath.c_str());

    // Create CMapInfo from the map's mapinfo.lua
    // MapParser looks for mapinfo.lua in content roots (the map directory)
    try {
        mapInfo = new CMapInfo(smfPath, FileSystem::GetBasename(smfPath));
    } catch (const std::exception& e) {
        SLOG(SPRING_LOG_ERROR, "failed to load map info: %s", e.what());
        return false;
    }

    // Load the SMF heightmap
    try {
        readMap = CReadMap::LoadMap(smfPath);
    } catch (const std::exception& e) {
        SLOG(SPRING_LOG_ERROR, "failed to load SMF: %s", e.what());
        return false;
    }

    if (readMap == nullptr) {
        SLOG(SPRING_LOG_ERROR, "CReadMap::LoadMap returned null");
        return false;
    }

    SLOG(SPRING_LOG_INFO, "map loaded: %dx%d (%dx%d elmos)",
        mapDims.mapx, mapDims.mapy,
        mapDims.mapx * SQUARE_SIZE, mapDims.mapy * SQUARE_SIZE);
    loadedMapPath = smfPath;
    return true;
}


void CSimulation::InitSubsystems(bool hasMap)
{
    SLOG(SPRING_LOG_INFO, "initialising subsystems...");

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
    SLOG(SPRING_LOG_INFO, "loaded %u unit defs, %u weapon defs",
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
    statisticalCombatManager.Init();

    // --- Map-dependent subsystems ---
    if (hasMap) {
        // Faithful to Recoil (Game.cpp): the first arg is the corner-square
        // count (mapDims.mapx/mapy), NOT world-elmo extents, and res/radius come
        // from modInfo. Passing float3::maxxpos (= mapx*SQUARE_SIZE) and
        // SQUARE_SIZE-scaled res/radius here over-scaled every argument by
        // SQUARE_SIZE (8x), so GetRealGroundHeight's (x + y*mapxp1)*resolution
        // index ran ~8x past the corner heightmap — an OOB read that SIGSEGV'd
        // on large maps (green_flat 2176^2) and read garbage on small ones.
        smoothGround.Init(int2(mapDims.mapx, mapDims.mapy), modInfo.smoothMeshResDivider, modInfo.smoothMeshSmoothRadius);
        quadField.Init(int2(mapDims.mapx, mapDims.mapy), CQuadField::BASE_QUAD_SIZE);

        // moveDefHandler already initialized above (before unitDefHandler)
        CLosHandler::InitStatic();
        mapDamage = IMapDamage::InitMapDamage();
        pathManager = IPathManager::GetInstance(modInfo.pathFinderSystem);

        groundBlockingObjectMap.Init(mapDims.mapSquares);
        buildingMaskMap.Init(mapDims.hmapx * mapDims.hmapy);
        // Path estimator queries this map for exit-only / block-building
        // squares — must be sized before pathManager->Finalize() below.
        yardmapStatusEffectsMap.InitNewYardmapStatusEffectsMap();

        featureDefHandler->LoadFeatureDefsFromMap();
        featureHandler.LoadFeaturesFromMap();

        envResHandler.LoadTidal(mapInfo->map.tidalStrength);
        envResHandler.LoadWind(mapInfo->atmosphere.minWind, mapInfo->atmosphere.maxWind);

        // Init heightmap digests for LOS system
        readMap->InitHeightMapDigestVectors(losHandler->los.size);

        // Finalize pathfinder (pre-computes caches)
        pathManager->Finalize();

        SLOG(SPRING_LOG_INFO, "map-dependent subsystems initialised");
    } else {
        SLOG(SPRING_LOG_INFO, "map-dependent subsystems skipped (no map)");
    }

    SLOG(SPRING_LOG_INFO, "subsystems initialised");
}


void CSimulation::FireGameStart()
{
    if (!scriptingLoaded || gameStarted)
        return;

    // --- Assign team leaders (faithful to Recoil's GameSetup TeamLeader) ---
    //
    // Recoil populates every team's `leader` from the start script's
    // `GAME\TEAM\X\TeamLeader` field before the sim runs: human teams get
    // their controlling player, AI teams get their hosting player. We build no
    // start script, so the leader stays at its -1 default and GetTeamInfo()
    // reports "no leader" for every team. Games that gate liveness on it then
    // misbehave: BAR's game_end.lua treats `hasLeader == false` as a wiped-out
    // team, marks every allyteam dead, and fires a premature GameOver (~frame
    // 120). Do the equivalent assignment here, now that the whole roster has
    // connected — a team with active human players takes the lowest as leader
    // (via CTeam::AddPlayer, the same join path Recoil uses); an AI team takes
    // the host player (the lowest active human, our single-host model — matches
    // the assumption already baked into GetAIInfo's hostPlayer = leader).
    {
        int hostPlayer = -1;
        for (int p = 0; p < playerHandler.ActivePlayers(); ++p) {
            const CPlayer* pl = playerHandler.Player(p);
            if (pl != nullptr && pl->active && !pl->IsSpectator()) {
                hostPlayer = p;
                break;
            }
        }
        const int numTeams = teamHandler.ActiveTeams();
        for (int t = 0; t < numTeams; ++t) {
            if (t == teamHandler.GaiaTeamID())
                continue;
            CTeam* team = teamHandler.Team(t);
            if (team == nullptr || team->HasLeader())
                continue;
            const std::vector<int> teamPlayers = playerHandler.ActivePlayersInTeam(t);
            if (!teamPlayers.empty()) {
                team->AddPlayer(teamPlayers.front());
            } else if (gAITeams != nullptr && gAITeams->count(t) > 0 && hostPlayer >= 0) {
                team->SetLeader(hostPlayer);
            }
        }
    }

    springlog_log(SPRING_LOG_NOTICE, "sim", "", springlog_get_frame(),
                  "firing GameStart");
    eventHandler.GameStart();
    gameStarted = true;

    // TODO(Tier 2): Send GameStarted over WebSocket to lobby
}


void CSimulation::InitScripting()
{
    if (!defsLoaded)
        return;

    SLOG(SPRING_LOG_INFO, "initialising scripting...");

    // Create the script event dispatcher
    scriptDispatcher = new ScriptEventDispatcher();
    scriptDispatcher->Register();

    // Intel event collector — captures UnitSeismicPing into a per-tick
    // queue that server_main.cpp drains and broadcasts (per-allyteam
    // filtered) inside GameEventBatch.
    if (intelEvents == nullptr) {
        intelEvents = new IntelEventCollector();
        intelEvents->Register();
    }

    // Lifecycle event collector — captures UnitFromFactory / UnitTaken /
    // UnitGiven into a per-tick queue that server_main.cpp drains and
    // broadcasts as UnitLifecycleBatch envelopes. These callins can't be
    // derived from the entity stream client-side (UnitFromFactory needs
    // factory id; UnitTaken/UnitGiven need the transfer cause), so the
    // server emits them explicitly.
    if (unitLifecycleEvents == nullptr) {
        unitLifecycleEvents = new UnitLifecycleCollector();
        unitLifecycleEvents->Register();
    }

    // Feature lifecycle collector — captures FeatureCreated / FeatureDestroyed
    // so server_main can stream wreck spawns and despawns to clients via
    // FeatureLifecycleBatch envelopes. Wrecks (CFeatureHandler::CreateWreckage)
    // are created on the server when units die but the renderer has no way
    // to discover them without an explicit stream.
    if (featureLifecycleEvents == nullptr) {
        featureLifecycleEvents = new FeatureLifecycleCollector();
        featureLifecycleEvents->Register();
    }

    // Command event collector — captures UnitCommand / UnitCmdDone
    // callins. Drained per tick and broadcast as UnitCommandBatch
    // envelopes, filtered to the viewer's allied teams. Required by
    // ZK widgets that need to observe commands as they're issued
    // (unit_state_icons, cmd_stop_selfd, cmd_keep_target, etc.).
    if (unitCommandEvents == nullptr) {
        unitCommandEvents = new UnitCommandCollector();
        unitCommandEvents->Register();
    }

    // Try to load LuaRules (game-wide synced gadgets) and LuaGaia
    // (map/environment synced gadgets). Either can be absent — the
    // underlying InitSynced() logs the precise reason (file missing,
    // empty, Lua syntax error, etc.) so we don't second-guess it here
    // with a misleading "no main.lua" message.
    //
    // The bool param is `dryRun` (per DECL_LOAD_SPLIT_HANDLER in LuaDefs.h):
    // false = actually load main.lua + draw.lua. Passing true here was a
    // misread of the declared `onlySynced` name in the header — it left the
    // synced state initialised but with main.lua never executed, so the
    // gadget handler never registered and RecvLuaMsg / GameStart / etc.
    // dispatched into an empty _G. (Symptom: ZK commander selection
    // bounced off a no-op luaRules->RecvLuaMsg and no commander spawned
    // even though the message reached the server.)
    if (CLuaRules::LoadHandler(false)) {
        auto* ctx = new LuaScriptContext(&luaRules->syncedLuaHandle);
        scriptDispatcher->AddContext(ctx);
        scriptingLoaded = true;
        SLOG(SPRING_LOG_INFO, "LuaRules attached to event dispatcher");
    } else {
        SLOG(SPRING_LOG_NOTICE, "LuaRules not loaded (see lua:LuaRules above for reason)");
    }

    if (CLuaGaia::LoadHandler(false)) {
        auto* ctx = new LuaScriptContext(&luaGaia->syncedLuaHandle);
        scriptDispatcher->AddContext(ctx);
        scriptingLoaded = true;
        SLOG(SPRING_LOG_INFO, "LuaGaia attached to event dispatcher");
    } else {
        SLOG(SPRING_LOG_NOTICE, "LuaGaia not loaded (see lua:LuaGaia above for reason)");
    }

    SLOG(SPRING_LOG_INFO, "scripting initialised (%zu contexts)",
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
        SLOG(SPRING_LOG_WARNING, "running without game definitions");
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

        // Resolve real start positions. Preferred source: the
        // persisted `MapMetadata.startPositions` populated by
        // mapconverter, whose Z values are already RH-canonical
        // (MapProcessor reflects them at conversion when the source map
        // is `legacyCoordSystem = true` — see MapProcessor::ProcessMap).
        // Fallback: live-parse mapinfo.lua via MapParser and reflect if
        // legacy. Final fallback: map centre (sim never refuses to start).
        const float3 mapCenter(
            mapDims.mapx * SQUARE_SIZE * 0.5f, 0.0f,
            mapDims.mapy * SQUARE_SIZE * 0.5f);
        std::unique_ptr<MapParser> mapStartParser;
        const bool useMetadata = haveMapMetadata && !mapMetadata.startPositions.empty();
        if (!useMetadata && hasMap && !loadedMapPath.empty()) {
            mapStartParser = std::make_unique<MapParser>(loadedMapPath);
            if (!mapStartParser->IsValid()) mapStartParser.reset();
        }

        // The map's RH-flip flag: applies when the live mapinfo.lua
        // path is taken (MapMetadata records are pre-flipped). Falls
        // back to true (LH-source) for unknown maps so dev-test maps
        // shipped under the old convention still work.
        const bool mapIsLegacy = haveMapMetadata
            ? mapMetadata.legacyCoordSystem
            : true;

        // Roster ordering matters here: the i-th roster entry slots
        // into team i, and its `startPosIdx` indexes the map's teams[]
        // array. We accept duplicates / -1 / out-of-range entries and
        // fall back to map centre so the sim never refuses to start.
        auto findRosterStartPos = [&](int teamId) -> int {
            for (const auto& e : rosterEntries) {
                if (e.team == teamId) return e.startPosIdx;
            }
            return -1;
        };

        for (int i = 0; i < playerTeamCount; i++) {
            teams[i].teamNum = i;
            teams[i].teamAllyteam = i;
            teams[i].SetDefaultColor(i);
            teams[i].SetMaxUnits(MAX_UNITS / std::max(1, totalTeams));
            if (!hasMap) continue;

            float3 startPos = mapCenter;
            const int posIdx = findRosterStartPos(i);

            if (useMetadata && posIdx >= 0
                && posIdx < static_cast<int>(mapMetadata.startPositions.size()))
            {
                const auto& sp = mapMetadata.startPositions[posIdx];
                startPos.x = sp.x;
                startPos.z = sp.z;
            } else if (posIdx >= 0 && mapStartParser != nullptr) {
                float3 mp;
                if (mapStartParser->GetStartPos(posIdx, mp)) {
                    // y unspecified by mapinfo.lua — units rely on
                    // ground sampling for vertical placement; leave 0
                    // here, the spawn path (CreateUnit → CUnit::PreInit)
                    // clamps to ground. Reflect the Z through mapZ/2 if
                    // the map is legacy LH (matches MapProcessor's
                    // conversion-time reflection so the metadata path
                    // and the live-parse path agree).
                    startPos.x = mp.x;
                    const float mapZ = static_cast<float>(mapDims.mapy * SQUARE_SIZE);
                    startPos.z = mapIsLegacy ? (mapZ - mp.z) : mp.z;
                }
            }
            teams[i].SetStartPos(startPos);
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

    // Populate AI team map from roster entries so Lua APIs
    // (GetTeamInfo, GetTeamLuaAI) can report AI status.
    for (const auto& e : rosterEntries) {
        if (e.isAI)
            aiTeams[e.team] = e.aiName;
    }
    gAITeams = &aiTeams;

    // Initialise all subsystems
    InitSubsystems(hasMap);
    mapLoaded = hasMap;

    // Load game scripting (LuaRules, LuaGaia). Gadgets initialise
    // their data structures but GameStart does NOT fire yet — that
    // waits until all players have connected and registered CPlayers
    // via FireGameStart(). Real Spring also defers GameStart until
    // all clients signal "loaded".
    InitScripting();

    running = true;
    SLOG(SPRING_LOG_INFO, "initialised (frame %d, defs=%s, map=%s)",
        gs->frameNum,
        defsLoaded ? "loaded" : "empty",
        mapLoaded ? "loaded" : "none");
}

void CSimulation::Kill()
{
    running = false;
    defsParser.reset();
    gs->Kill();
    SLOG(SPRING_LOG_INFO, "shut down");
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

    // Unit script animations (COB/Lua piece turns, spins, moves).
    // Tick BEFORE unitHandler.Update() so the piece transforms read by
    // CWeapon::UpdateWeaponVectors (inside UpdateUnitWeapons) reflect the
    // animation advances scheduled by the previous frame's AimWeapon call,
    // rather than lagging one tick behind. Symptom this fixes: turrets
    // that appear to aim one tick late and projectiles that spawn from
    // last-frame's barrel pose. See PLAN-combat-vfx.md F1.
    if (unitScriptEngine != nullptr)
        unitScriptEngine->Tick(33); // 33ms ≈ 1 tick at 30Hz

    unitHandler.Update();
    // Drain statistical volleys whose scheduled resolve frame has arrived
    // (damage applied via DoDamage). Runs right after unitHandler.Update(),
    // where this frame's volleys were rolled + queued during weapon fire.
    statisticalCombatManager.Update(gs->frameNum);
    projectileHandler.Update();
    featureHandler.Update();

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
