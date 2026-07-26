// AIScriptContext — IScriptContext for server-side AI running in a thread pool.
//
// Unlike LuaScriptContext (which wraps CLuaHandle on the sim thread),
// AIScriptContext owns its own Lua VM and runs on a worker thread.
// It receives AIStateSnapshot via async queue, runs AI logic, and
// pushes commands to AICommandQueue.
//
// Thread safety: never touches live sim objects. All data comes from
// the serialized snapshot. Commands are validated by the sim thread
// when drained.
#pragma once

#include "AIStateSnapshot.h"
#include "AICommandQueue.h"
#include "System/Scripting/IScriptContext.h"
#include "System/Scripting/ScriptPermissions.h"

#include <atomic>
#include <mutex>
#include <string>
#include <queue>

struct lua_State;

class AIScriptContext : public IScriptContext {
public:
    /// `pluginDir` is the AI plugin's folder on disk (where main.lua and its
    /// sibling modules live). It anchors the plugin-scoped `require` loader
    /// (engine ask AI0-loader) so a multi-file AI (e.g. strategos) can boot.
    /// Empty disables the loader (single-buffer AIs still work).
    ///
    /// `mapDataDir` / `defExportDir` are the two sandboxed read roots for the
    /// AI4 file API (`AI.getMapData` / `AI.getDefExport`): the processed map's
    /// data dir (`data/maps/<id>`, holds regions.json) and the game's def
    /// cache dir (`data/games/<id>/cache/defs/<key>`, holds power.json). Empty
    /// disables the corresponding accessor (it returns nil — an unconfigured
    /// AI is blind, which the Picture builder treats as "unknown", not error).
    AIScriptContext(const std::string& name, int teamId, int allyTeamId,
                    const std::string& pluginDir = "",
                    const std::string& mapDataDir = "",
                    const std::string& defExportDir = "");
    ~AIScriptContext() override;

    // --- IScriptContext ---
    const std::string& GetName() const override { return name; }
    int GetOrder() const override { return 1000 + teamId; }
    const ScriptPermissions& GetPermissions() const override { return permissions; }
    ScriptPermissions& GetPermissions() override { return permissions; }

    bool Init(const std::string& code, const std::string& source) override;
    void Shutdown() override;
    bool IsRunning() const override { return running.load(); }

    bool WantsEvent(uint16_t eventType) const override;
    void HandleEvent(const ScriptEvent& event) override;
    bool HandleControlEvent(ScriptEvent& event) override;
    void CollectGarbage(bool forced) override;

    // --- AI-specific ---

    /// Push a new state snapshot for the AI to process.
    /// Called from the sim thread.
    void PushSnapshot(AIStateSnapshot&& snapshot);

    /// Process the latest snapshot on a worker thread.
    /// Runs the AI Lua script and collects commands.
    void ProcessSnapshot();

    /// Get the team this AI controls.
    int GetTeamId() const { return teamId; }

    /// Diagnostic/test accessor: read a numeric global from the VM (e.g.
    /// picture.lua's static-load summary). Returns false if the VM is dead
    /// or the global is absent/non-numeric. Not thread-safe — call only
    /// when no worker is processing a snapshot (tests, or between ticks).
    bool TryGetGlobalNumber(const char* name, double& out) const;

private:
    /// Register the AI API functions into the Lua state.
    void RegisterAPI();

    // Lua C API callbacks
    static int l_getOwnUnits(lua_State* L);
    static int l_getVisibleEnemies(lua_State* L);
    static int l_issueCommand(lua_State* L);
    static int l_getFrame(lua_State* L);
    static int l_getMapSize(lua_State* L);
    static int l_getTeamId(lua_State* L);      // AI-team down payment
    static int l_getRulesParam(lua_State* L);  // AI1
    static int l_require(lua_State* L);         // AI0-loader
    static int l_getMapData(lua_State* L);      // AI4: map data dir read
    static int l_getDefExport(lua_State* L);    // AI4: def export dir read
    // AI2: directive-shaped write surface (org-group / directive / posture).
    // These push AICommands the drain routes through the SAME manager + charge
    // path as a human player's wire message (StateStreamer::TickAI). There is
    // deliberately NO per-squad command verb here — the strategic floor
    // (PLAN-metalstorm-ai §1/§4). The pre-existing l_issueCommand stays as the
    // generic runtime's per-unit path (test channel / non-Metalstorm AIs).
    static int l_createGroup(lua_State* L);
    static int l_issueDirective(lua_State* L);
    static int l_setPosture(lua_State* L);

    std::string name;
    int teamId;
    int allyTeamId;
    std::string pluginDir;    // AI0-loader: module resolution root
    std::string mapDataDir;   // AI4: getMapData sandbox root (data/maps/<id>)
    std::string defExportDir; // AI4: getDefExport sandbox root (def cache dir)
    ScriptPermissions permissions;
    lua_State* L = nullptr;

    std::atomic<bool> running{false};

    // AI2: monotonic counter minting client-local group tokens for
    // createGroup→issueDirective correlation (see AICommandQueue.h). Worker
    // thread only (the AI VM runs single-threaded per context).
    uint32_t nextGroupToken = 1;

    // Snapshot queue (sim thread writes, worker thread reads)
    std::mutex snapshotMutex;
    std::queue<AIStateSnapshot> snapshotQueue;

    // Current snapshot being processed (worker thread only)
    AIStateSnapshot currentSnapshot;
};
