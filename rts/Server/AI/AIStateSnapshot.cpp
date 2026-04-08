// AIStateSnapshot — builds a visibility-filtered snapshot from sim state.

#include "AIStateSnapshot.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/LosHandler.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Map/ReadMap.h"

static AISquadInfo MakeSquadInfo(const CUnit* u) {
    AISquadInfo info;
    info.unitId = static_cast<uint32_t>(u->id);
    info.defId = static_cast<uint16_t>(u->unitDef->id);
    info.team = static_cast<uint8_t>(u->team);
    info.position = u->pos;
    info.maxHealth = u->maxHealth;
    info.health = (u->maxHealth > 0.0f) ? (u->health / u->maxHealth) : 0.0f;
    info.isMoving = (u->speed.SqLength() > 1.0f);
    info.hasCommands = !u->commandAI->commandQue.empty();
    return info;
}

AIStateSnapshot BuildAISnapshot(int teamId, int allyTeamId, int lodLevel) {
    AIStateSnapshot snap;
    snap.frame = gs->frameNum;
    snap.teamId = teamId;
    snap.allyTeamId = allyTeamId;
    snap.lodLevel = lodLevel;

    // Map dimensions
    if (readMap != nullptr) {
        snap.mapWidth = mapDims.mapx * SQUARE_SIZE;
        snap.mapHeight = mapDims.mapy * SQUARE_SIZE;
    }

    // Economy (simplified — real economy comes from resource handler)
    // TODO: read from team resource state

    const auto& activeUnits = unitHandler.GetActiveUnits();
    for (CUnit* u : activeUnits) {
        if (u == nullptr || u->isDead) continue;

        int unitAllyTeam = teamHandler.AllyTeam(u->team);

        if (u->team == teamId) {
            // Own unit — full detail
            snap.ownUnits.push_back(MakeSquadInfo(u));
        } else if (unitAllyTeam == allyTeamId) {
            // Allied unit — full detail
            snap.alliedUnits.push_back(MakeSquadInfo(u));
        } else {
            // Enemy — only if in LOS
            if (losHandler != nullptr && losHandler->InLos(u, allyTeamId)) {
                snap.visibleEnemies.push_back(MakeSquadInfo(u));
            }
        }
    }

    return snap;
}
