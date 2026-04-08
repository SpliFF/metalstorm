// AIRuntimePool — manages AI lifecycle and tick scheduling.

#include "AIRuntimePool.h"
#include "AIStateSnapshot.h"

#include "Sim/Misc/TeamHandler.h"

#include <cstdio>

AIRuntimePool::AIRuntimePool() = default;

AIRuntimePool::~AIRuntimePool() {
    Shutdown();
}

bool AIRuntimePool::AddAI(const std::string& name, int teamId, int allyTeamId,
                          const std::string& scriptCode) {
    auto ctx = std::make_unique<AIScriptContext>(name, teamId, allyTeamId);

    if (!ctx->Init(scriptCode, name + ".lua")) {
        std::fprintf(stderr, "[AIPool] failed to initialise AI '%s' for team %d\n",
            name.c_str(), teamId);
        return false;
    }

    aiContexts.push_back(std::move(ctx));
    std::fprintf(stderr, "[AIPool] added AI '%s' for team %d (%zu total)\n",
        name.c_str(), teamId, aiContexts.size());
    return true;
}

void AIRuntimePool::Tick(int frame) {
    if (aiContexts.empty()) return;
    if ((frame % tickInterval) != 0) return;

    // Build snapshots and process each AI synchronously for now.
    // Phase 6 will move this to actual worker threads.
    for (auto& ctx : aiContexts) {
        if (!ctx->IsRunning()) continue;

        int allyTeam = teamHandler.AllyTeam(ctx->GetTeamId());
        auto snapshot = BuildAISnapshot(ctx->GetTeamId(), allyTeam);
        ctx->PushSnapshot(std::move(snapshot));
        ctx->ProcessSnapshot();
    }
}

std::vector<AICommand> AIRuntimePool::DrainCommands() {
    return aiCommandQueue.Drain();
}

void AIRuntimePool::Shutdown() {
    for (auto& ctx : aiContexts) {
        ctx->Shutdown();
    }
    aiContexts.clear();
    std::fprintf(stderr, "[AIPool] shut down\n");
}
