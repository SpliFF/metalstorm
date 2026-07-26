// AIRuntimePool — manages AI lifecycle and tick scheduling.

#include "AIRuntimePool.h"
#include "AIStateSnapshot.h"

#include "Sim/Misc/TeamHandler.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "ai"

#include <cstdio>

AIRuntimePool::AIRuntimePool() = default;

AIRuntimePool::~AIRuntimePool() {
    Shutdown();
}

bool AIRuntimePool::AddAI(const std::string& name, int teamId, int allyTeamId,
                          const std::string& scriptCode, const std::string& pluginDir,
                          const std::string& mapDataDir,
                          const std::string& defExportDir) {
    auto ctx = std::make_unique<AIScriptContext>(name, teamId, allyTeamId, pluginDir,
                                                 mapDataDir, defExportDir);

    if (!ctx->Init(scriptCode, name + ".lua")) {
        SLOG(SPRING_LOG_ERROR, "failed to initialise AI '%s' for team %d",
            name.c_str(), teamId);
        return false;
    }

    aiContexts.push_back(std::move(ctx));
    SLOG(SPRING_LOG_INFO, "added AI '%s' for team %d (%zu total)",
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
    SLOG(SPRING_LOG_INFO, "shut down");
}
