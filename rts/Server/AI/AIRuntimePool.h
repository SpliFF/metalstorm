// AIRuntimePool — manages AI script contexts and their worker threads.
//
// The sim thread calls Tick() each frame. This builds snapshots for
// each AI, pushes them to worker threads, and drains completed commands.
#pragma once

#include "AIScriptContext.h"
#include "AICommandQueue.h"

#include <memory>
#include <string>
#include <thread>
#include <vector>

class AIRuntimePool {
public:
    AIRuntimePool();
    ~AIRuntimePool();

    /// Add an AI player. Loads the script from the given code string.
    /// `pluginDir` is the plugin's on-disk folder, used by the AI VM's
    /// plugin-scoped `require` loader (AI0-loader) to resolve sibling
    /// modules; pass "" for single-buffer AIs. `playerId` is the AI's virtual
    /// playerID (AI3) — its authority charge identity; pass -1 if unattributed.
    /// Returns true on success.
    bool AddAI(const std::string& name, int teamId, int allyTeamId,
               const std::string& scriptCode, const std::string& pluginDir = "",
               int playerId = -1);

    /// Called by the sim thread every N ticks.
    /// Builds snapshots, pushes to AIs, drains commands.
    void Tick(int frame);

    /// Drain AI commands and apply them to the sim.
    /// Called from the sim thread.
    std::vector<AICommand> DrainCommands();

    /// Number of active AI instances.
    size_t GetAICount() const { return aiContexts.size(); }

    /// Shut down all AIs.
    void Shutdown();

private:
    std::vector<std::unique_ptr<AIScriptContext>> aiContexts;

    // Tick interval — AIs don't need to run every frame
    int tickInterval = 10; // every 10 sim frames (~3Hz at 30Hz sim)
};
