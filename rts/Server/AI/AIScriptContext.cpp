// AIScriptContext — AI Lua VM running on worker threads.

#include "AIScriptContext.h"
#include "AICommandQueue.h"
#include "LuaInclude.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "ai"

#include <cstdio>

// Store the AIScriptContext pointer in the Lua extra space
static AIScriptContext* GetAIContext(lua_State* L) {
    void** extra = (void**)lua_getextraspace(L);
    return reinterpret_cast<AIScriptContext*>(*extra);
}

AIScriptContext::AIScriptContext(const std::string& name, int teamId, int allyTeamId)
    : name(name), teamId(teamId), allyTeamId(allyTeamId)
{
    permissions.synced = false; // AI doesn't directly modify sim state
    permissions.fullRead = false;
    permissions.fullCtrl = false;
    permissions.readTeam = teamId;
    permissions.ctrlTeam = teamId;
    permissions.readAllyTeam = allyTeamId;
}

AIScriptContext::~AIScriptContext() {
    Shutdown();
}

bool AIScriptContext::Init(const std::string& code, const std::string& source) {
    L = luaL_newstate();
    if (!L) return false;

    // Store this pointer in Lua extra space
    void** extra = (void**)lua_getextraspace(L);
    *extra = this;

    // Open safe standard libraries (no os, io, debug)
    luaL_requiref(L, "_G", luaopen_base, 1); lua_pop(L, 1);
    luaL_requiref(L, "table", luaopen_table, 1); lua_pop(L, 1);
    luaL_requiref(L, "string", luaopen_string, 1); lua_pop(L, 1);
    luaL_requiref(L, "math", luaopen_math, 1); lua_pop(L, 1);
    luaL_requiref(L, "utf8", luaopen_utf8, 1); lua_pop(L, 1);

    RegisterAPI();

    // Load and execute the AI script
    int err = luaL_loadbuffer(L, code.c_str(), code.size(), source.c_str());
    if (err != LUA_OK) {
        SLOG_SCOPED(SPRING_LOG_ERROR, name.c_str(), "load error: %s", lua_tostring(L, -1));
        lua_pop(L, 1);
        return false;
    }

    err = lua_pcall(L, 0, 0, 0);
    if (err != LUA_OK) {
        SLOG_SCOPED(SPRING_LOG_ERROR, name.c_str(), "init error: %s", lua_tostring(L, -1));
        lua_pop(L, 1);
        return false;
    }

    running.store(true);
    SLOG_SCOPED(SPRING_LOG_INFO, name.c_str(), "initialised for team %d", teamId);
    return true;
}

void AIScriptContext::Shutdown() {
    running.store(false);
    if (L) {
        lua_close(L);
        L = nullptr;
    }
}

bool AIScriptContext::WantsEvent(uint16_t eventType) const {
    // AI only cares about GameFrame (triggers snapshot processing)
    return (eventType == 4); // ScriptEventType::GameFrame
}

void AIScriptContext::HandleEvent(const ScriptEvent& event) {
    // Events are delivered async via PushSnapshot, not directly
    (void)event;
}

bool AIScriptContext::HandleControlEvent(ScriptEvent& event) {
    // AI never handles control events (Allow*, etc.)
    (void)event;
    return false;
}

void AIScriptContext::CollectGarbage(bool forced) {
    if (!L) return;
    if (forced) {
        lua_gc(L, LUA_GCCOLLECT, 0);
    } else {
        lua_gc(L, LUA_GCSTEP, 10);
    }
}

void AIScriptContext::PushSnapshot(AIStateSnapshot&& snapshot) {
    std::lock_guard<std::mutex> lock(snapshotMutex);
    // Keep only the latest snapshot (drop older ones)
    while (!snapshotQueue.empty()) snapshotQueue.pop();
    snapshotQueue.push(std::move(snapshot));
}

void AIScriptContext::ProcessSnapshot() {
    if (!L || !running.load()) return;

    // Get latest snapshot
    {
        std::lock_guard<std::mutex> lock(snapshotMutex);
        if (snapshotQueue.empty()) return;
        currentSnapshot = std::move(snapshotQueue.front());
        snapshotQueue.pop();
    }

    // Call the AI's onUpdate function
    lua_getglobal(L, "onUpdate");
    if (!lua_isfunction(L, -1)) {
        lua_pop(L, 1);
        return;
    }

    lua_pushinteger(L, currentSnapshot.frame);
    int err = lua_pcall(L, 1, 0, 0);
    if (err != LUA_OK) {
        SLOG_SCOPED(SPRING_LOG_ERROR, name.c_str(), "onUpdate error: %s",
            lua_tostring(L, -1));
        lua_pop(L, 1);
    }
}

// === Lua API functions exposed to AI scripts ===

void AIScriptContext::RegisterAPI() {
    // Create the Spring.AI table
    lua_newtable(L);

    lua_pushcfunction(L, l_getOwnUnits);
    lua_setfield(L, -2, "getOwnUnits");

    lua_pushcfunction(L, l_getVisibleEnemies);
    lua_setfield(L, -2, "getVisibleEnemies");

    lua_pushcfunction(L, l_issueCommand);
    lua_setfield(L, -2, "issueCommand");

    lua_pushcfunction(L, l_getFrame);
    lua_setfield(L, -2, "getFrame");

    lua_pushcfunction(L, l_getMapSize);
    lua_setfield(L, -2, "getMapSize");

    lua_setglobal(L, "AI");
}

int AIScriptContext::l_getOwnUnits(lua_State* L) {
    auto* ctx = GetAIContext(L);
    const auto& units = ctx->currentSnapshot.ownUnits;

    lua_createtable(L, units.size(), 0);
    for (size_t i = 0; i < units.size(); i++) {
        const auto& u = units[i];
        lua_createtable(L, 0, 6);
        lua_pushinteger(L, u.unitId);  lua_setfield(L, -2, "id");
        lua_pushinteger(L, u.defId);   lua_setfield(L, -2, "defId");
        lua_pushnumber(L, u.position.x); lua_setfield(L, -2, "x");
        lua_pushnumber(L, u.position.y); lua_setfield(L, -2, "y");
        lua_pushnumber(L, u.position.z); lua_setfield(L, -2, "z");
        lua_pushnumber(L, u.health);   lua_setfield(L, -2, "health");
        lua_pushboolean(L, u.hasCommands); lua_setfield(L, -2, "hasCommands");
        lua_rawseti(L, -2, i + 1);
    }
    return 1;
}

int AIScriptContext::l_getVisibleEnemies(lua_State* L) {
    auto* ctx = GetAIContext(L);
    const auto& units = ctx->currentSnapshot.visibleEnemies;

    lua_createtable(L, units.size(), 0);
    for (size_t i = 0; i < units.size(); i++) {
        const auto& u = units[i];
        lua_createtable(L, 0, 5);
        lua_pushinteger(L, u.unitId);  lua_setfield(L, -2, "id");
        lua_pushinteger(L, u.defId);   lua_setfield(L, -2, "defId");
        lua_pushnumber(L, u.position.x); lua_setfield(L, -2, "x");
        lua_pushnumber(L, u.position.z); lua_setfield(L, -2, "z");
        lua_pushnumber(L, u.health);   lua_setfield(L, -2, "health");
        lua_rawseti(L, -2, i + 1);
    }
    return 1;
}

int AIScriptContext::l_issueCommand(lua_State* L) {
    auto* ctx = GetAIContext(L);

    AICommand cmd;
    cmd.teamId = ctx->teamId;
    cmd.unitId = static_cast<uint32_t>(luaL_checkinteger(L, 1));
    cmd.commandId = static_cast<int>(luaL_checkinteger(L, 2));

    // Remaining args are command parameters
    int nargs = lua_gettop(L);
    cmd.numParams = std::min(nargs - 2, 8);
    for (int i = 0; i < cmd.numParams; i++) {
        cmd.params[i] = static_cast<float>(luaL_checknumber(L, 3 + i));
    }

    aiCommandQueue.Push(cmd);
    return 0;
}

int AIScriptContext::l_getFrame(lua_State* L) {
    auto* ctx = GetAIContext(L);
    lua_pushinteger(L, ctx->currentSnapshot.frame);
    return 1;
}

int AIScriptContext::l_getMapSize(lua_State* L) {
    auto* ctx = GetAIContext(L);
    lua_pushinteger(L, ctx->currentSnapshot.mapWidth);
    lua_pushinteger(L, ctx->currentSnapshot.mapHeight);
    return 2;
}
