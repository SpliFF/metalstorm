#include "AISpawn.h"

#include "AIDiscovery.h"

#include <fstream>
#include <iterator>

AISpawnRelay aiSpawnRelay;

const char* AISpawnVerdictName(AISpawnVerdict v)
{
    switch (v) {
        case AISpawnVerdict::Spawn:            return "spawn";
        case AISpawnVerdict::RefuseNoTeam:     return "refused: no such team";
        case AISpawnVerdict::RefuseNoId:       return "refused: empty AI id";
        case AISpawnVerdict::RefuseTeamHasAI:  return "refused: team already has an AI";
        case AISpawnVerdict::RefuseNotStarted: return "refused: game has not started";
    }
    return "refused: unknown";
}

AISpawnVerdict DecideAISpawn(int teamId, const std::string& aiId,
                             bool teamHasActiveAI, bool gameStarted)
{
    // Order matters only for the log line, not for the outcome — but a caller
    // reading "no such team" for a request that was ALSO pre-GameStart would
    // chase the wrong half, so the cheapest structural facts are tested first.
    if (teamId < 0)
        return AISpawnVerdict::RefuseNoTeam;
    if (aiId.empty())
        return AISpawnVerdict::RefuseNoId;
    if (!gameStarted)
        return AISpawnVerdict::RefuseNotStarted;
    if (teamHasActiveAI)
        return AISpawnVerdict::RefuseTeamHasAI;
    return AISpawnVerdict::Spawn;
}

bool AISpawnRelay::Request(const AISpawnRequest& rq)
{
    for (const auto& p : pending) {
        if (p.teamId == rq.teamId)
            return false;
    }
    pending.push_back(rq);
    return true;
}

std::vector<AISpawnRequest> AISpawnRelay::Drain()
{
    std::vector<AISpawnRequest> out;
    out.swap(pending);
    return out;
}

bool ResolveAIPlugin(const std::string& enginePath, const std::string& gamePath,
                     const std::string& id, ResolvedAIPlugin& out,
                     std::string& err)
{
    if (id.empty()) {
        err = "empty AI id";
        return false;
    }

    const auto discovered = AIDiscovery::Discover(enginePath, gamePath);
    const AIDiscovery::AIInfo* match = nullptr;
    for (const auto& ai : discovered) {
        if (ai.id == id) { match = &ai; break; }
    }
    if (match == nullptr) {
        err = "no matching plugin found for id '" + id + "'";
        return false;
    }

    out = ResolvedAIPlugin{};
    out.id          = match->id;
    out.displayName = match->displayName;
    out.folderPath  = match->folderPath;
    out.isLuaAI     = match->isLuaAI;

    // A LuaAI has no entry script by construction (AIDiscovery leaves
    // entryPath empty) — the game's own gadgets are its runtime. Resolving one
    // is a success; loading one is the caller's error to refuse.
    if (match->isLuaAI)
        return true;

    std::ifstream entry(match->entryPath, std::ios::binary);
    if (!entry.is_open()) {
        err = "failed to open entry '" + match->entryPath + "'";
        return false;
    }
    out.code.assign((std::istreambuf_iterator<char>(entry)),
                     std::istreambuf_iterator<char>());
    return true;
}
