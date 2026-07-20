// AIStateSnapshot — builds a visibility-filtered snapshot from sim state.

#include "AIStateSnapshot.h"

#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/CommandAI/CommandAI.h"
#include "Sim/Misc/Team.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/LosHandler.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Map/ReadMap.h"
#include "Lua/LuaHandleSynced.h"
#include "Lua/LuaRulesParams.h"

// AI1: copy a rulesParams store (game or team scope) into the snapshot's
// AI-visible map, mirroring the wire producer's bool→number coercion.
static void CopyRulesParams(const LuaRulesParams::Params& src,
                            std::unordered_map<std::string, AIRulesParamValue>& dst) {
    dst.reserve(src.size());
    for (const auto& [key, p] : src) {
        AIRulesParamValue out;
        std::visit([&](auto&& v) {
            using T = std::decay_t<decltype(v)>;
            if constexpr (std::is_same_v<T, bool>) {
                out.isString = false; out.num = v ? 1.0 : 0.0;
            } else if constexpr (std::is_same_v<T, float>) {
                out.isString = false; out.num = static_cast<double>(v);
            } else { // std::string
                out.isString = true; out.str = v;
            }
        }, p.value);
        dst[key] = std::move(out);
    }
}

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

    // rulesParams mirrors (AI1). Game scope is the public strategic mirror
    // (objectives/regions/pools are published game-public — the same numbers a
    // player sees). Team scope is this AI's own team params only (fog-limited:
    // never another team's private state). The picture builder reads these via
    // AI.getRulesParam('game'|'team', key).
    CopyRulesParams(CSplitLuaHandle::GetGameParams(), snap.gameParams);
    if (teamId >= 0 && teamId < teamHandler.ActiveTeams()) {
        if (const CTeam* team = teamHandler.Team(teamId))
            CopyRulesParams(team->modParams, snap.teamParams);
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
