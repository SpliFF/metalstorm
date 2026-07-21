// AIStateSnapshot — serialized game state for AI thread-pool consumption.
//
// Built by the sim thread each tick, consumed by AI worker threads.
// Contains only IDs and scalar data — no C++ pointers. AI code queries
// this snapshot instead of touching live sim objects.
#pragma once

#include "System/float3.h"
#include <cstdint>
#include <string>
#include <unordered_map>
#include <vector>

/// Per-squad data visible to the AI.
struct AISquadInfo {
    uint32_t unitId = 0;
    uint16_t defId = 0;
    uint8_t team = 0;
    float3 position;
    float health = 0.0f;       // 0-1 ratio
    float maxHealth = 0.0f;
    bool isMoving = false;
    bool hasCommands = false;
};

/// One rulesParam value visible to the AI (AI1). Mirrors the wire producer's
/// bool→number coercion (StateStreamer::ParamToWire): a param is either a
/// number or a string.
struct AIRulesParamValue {
    bool isString = false;
    double num = 0.0;
    std::string str;
};

/// Serialized game state snapshot for one AI player.
struct AIStateSnapshot {
    int frame = 0;
    int teamId = -1;
    int allyTeamId = -1;

    // rulesParams mirrors (AI1). `game` scope is the public strategic mirror
    // (objectives, regions, pools); `team` scope is this AI's own team params.
    // Populated from CSplitLuaHandle::GetGameParams() + Team::modParams.
    std::unordered_map<std::string, AIRulesParamValue> gameParams;
    std::unordered_map<std::string, AIRulesParamValue> teamParams;

    // Own units (full detail)
    std::vector<AISquadInfo> ownUnits;

    // Allied units (full detail)
    std::vector<AISquadInfo> alliedUnits;

    // Enemy units visible in LOS (filtered)
    std::vector<AISquadInfo> visibleEnemies;

    // Economy
    float metal = 0.0f;
    float maxMetal = 0.0f;
    float energy = 0.0f;
    float maxEnergy = 0.0f;
    float metalIncome = 0.0f;
    float energyIncome = 0.0f;

    // Map info
    int mapWidth = 0;     // in elmos
    int mapHeight = 0;

    // LOD level (0=full, 1=simplified, 2=abstract, 3=dormant)
    int lodLevel = 0;
};

/// Build a snapshot for a specific AI team from the current sim state.
AIStateSnapshot BuildAISnapshot(int teamId, int allyTeamId, int lodLevel = 0);
