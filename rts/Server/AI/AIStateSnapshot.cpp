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

#include <string_view>

// GAME-scoped keys that reach the AI regardless of the los they were
// published with (see AISnapshotGameParamVisible's header). The diplomacy
// board is the whole list: game_parley.lua publishes `parley_count`,
// `parley_<id>_*` and the `trust_<lo>_<hi>` ledger with the engine's default
// (private) los, and a proposal an AI cannot read is a proposal it can never
// answer — recon_01's Diplomacy Mission waits forever on exactly that.
static constexpr std::string_view kGameParamPrefixAllow[] = {
    "parley_",   // proposals, pacts, and the toast ring
    "trust_",    // the per-pair trust ledger the same board is valued against
};

bool AISnapshotGameParamVisible(const std::string& key, int los) {
    if ((los & LuaRulesParams::RULESPARAMLOS_PUBLIC_MASK) != 0) return true;
    for (const std::string_view prefix : kGameParamPrefixAllow) {
        if (std::string_view(key).starts_with(prefix)) return true;
    }
    return false;
}

// AI1: copy a rulesParams store (game or team scope) into the snapshot's
// AI-visible map, mirroring the wire producer's bool→number coercion.
// `gameScope` selects the allow-listed predicate above; team scope keeps the
// plain mask test (a team's own params are private-readable by their owner).
static void CopyRulesParams(const LuaRulesParams::Params& src,
                            std::unordered_map<std::string, AIRulesParamValue>& dst,
                            int losMask = LuaRulesParams::RULESPARAMLOS_PRIVATE_MASK,
                            bool gameScope = false) {
    dst.reserve(src.size());
    for (const auto& [key, p] : src) {
        // Mirror LuaSyncedRead's mask semantics (ai-actuation F11): an entry
        // the mask cannot read never reaches the snapshot — the AI sees what
        // a player on its side could read, no cheating channel.
        if (gameScope ? !AISnapshotGameParamVisible(key, p.los)
                      : ((p.los & losMask) == 0)) continue;
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
    // Game params cross the side boundary, so only PUBLIC entries travel
    // (F11) — plus the allow-listed diplomacy board, which every player's Lua
    // reads already (AISnapshotGameParamVisible). The AI's OWN team params are
    // private-readable by their owner.
    CopyRulesParams(CSplitLuaHandle::GetGameParams(), snap.gameParams,
                    LuaRulesParams::RULESPARAMLOS_PUBLIC_MASK, /*gameScope=*/true);
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
            // Enemy — full sighting only if in LOS; a radar-covered contact
            // outside LOS degrades to a position-only blip (fog-honest: the
            // same distinction the client's radar-dot rendering draws).
            if (losHandler != nullptr && losHandler->InLos(u, allyTeamId)) {
                snap.visibleEnemies.push_back(MakeSquadInfo(u));
            } else if (losHandler != nullptr && losHandler->InRadar(u, allyTeamId)) {
                AIRadarBlip blip;
                blip.unitId = static_cast<uint32_t>(u->id);
                blip.x = u->pos.x;
                blip.z = u->pos.z;
                snap.radarBlips.push_back(blip);
            }
        }
    }

    return snap;
}
