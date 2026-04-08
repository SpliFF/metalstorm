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
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/Scripts/UnitScriptEngine.h"
#include "Sim/Projectiles/ProjectileHandler.h"
#include "Sim/Features/FeatureHandler.h"
#include "Sim/Path/IPathManager.h"
#include "Game/GameHelper.h"
#include "Game/Players/PlayerHandler.h"
#include "Game/WaitCommandsAI.h"
#include "Game/GlobalUnsynced.h"
#include "Map/MapDamage.h"
#include "System/EventHandler.h"
#include "System/Log/ILog.h"


void CSimulation::Init()
{
    // Initialise global state objects
    gs->Init();
    gu->Init();

    // The full subsystem initialisation chain (map loading, def parsing,
    // unitHandler.Init(), etc.) is a later step — it requires map files
    // and game content on disk. For now we just mark ourselves as running
    // so the tick loop can execute empty frames.
    //
    // TODO (Phase 1): Load map, parse defs, then call:
    //   helper->Init()
    //   unitHandler.Init()
    //   featureHandler.Init()
    //   projectileHandler.Init()
    //   CUnitScriptEngine::InitStatic()
    //   CLosHandler::InitStatic()  (needs map dims)
    //   IPathManager::GetInstance() (needs map)
    //   IMapDamage::InitMapDamage() (needs map)
    //   teamHandler.LoadFromSetup()
    //   playerHandler.LoadFromSetup()

    running = true;
    LOG("[Simulation] initialised (frame %d)", gs->frameNum);
}

void CSimulation::Kill()
{
    running = false;
    gs->Kill();
    LOG("[Simulation] shut down");
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
