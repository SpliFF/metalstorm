// LuaExecEngine — executes Lua code in specific contexts.

#include "LuaExecEngine.h"
#include "System/SpringLog/SpringLog.h"

#include "Lua/LuaRules.h"
#include "Lua/LuaGaia.h"
#include "Lua/LuaHandle.h"

#include "Sim/Units/UnitHandler.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/UnitDefHandler.h"
#include "Sim/Weapons/WeaponDefHandler.h"
#include "Sim/Misc/TeamHandler.h"
#include "Sim/Misc/GlobalSynced.h"
#include "Server/LuaDebugger.h"


// Lua compiled as C++ in this project
#include <lua.h>
#include <lauxlib.h>
#include <lualib.h>

#include <sstream>
#include <string>
#include <cstring>

#define LOG_SECTION "exec"

namespace {

// Serialize a Lua value at the given stack index to a JSON-ish string.
// Handles: string, number, boolean, nil, table (1 level deep).
std::string LuaValueToString(lua_State* L, int idx, int depth = 0) {
    int t = lua_type(L, idx);
    switch (t) {
        case LUA_TNIL:    return "nil";
        case LUA_TBOOLEAN: return lua_toboolean(L, idx) ? "true" : "false";
        case LUA_TNUMBER:  {
            char buf[64];
            if (lua_isinteger(L, idx))
                snprintf(buf, sizeof(buf), "%lld", (long long)lua_tointeger(L, idx));
            else
                snprintf(buf, sizeof(buf), "%.6g", lua_tonumber(L, idx));
            return buf;
        }
        case LUA_TSTRING:  return lua_tostring(L, idx);
        case LUA_TTABLE: {
            if (depth > 2) return "{...}";
            std::string result = "{";
            bool first = true;
            lua_pushnil(L);
            while (lua_next(L, idx < 0 ? idx - 1 : idx)) {
                if (!first) result += ", ";
                first = false;
                // Key
                if (lua_type(L, -2) == LUA_TSTRING)
                    result += std::string(lua_tostring(L, -2)) + " = ";
                else if (lua_type(L, -2) == LUA_TNUMBER) {
                    char buf[32];
                    snprintf(buf, sizeof(buf), "[%.0f] = ", lua_tonumber(L, -2));
                    result += buf;
                }
                // Value
                result += LuaValueToString(L, -1, depth + 1);
                lua_pop(L, 1);
                if (result.size() > 4096) { result += ", ...}"; return result; }
            }
            result += "}";
            return result;
        }
        default: {
            char buf[64];
            snprintf(buf, sizeof(buf), "<%s>", lua_typename(L, t));
            return buf;
        }
    }
}

// Execute Lua code in a given lua_State, return result string.
std::string ExecuteInLuaState(lua_State* L, const std::string& code) {
    if (!L) return "error: Lua state is null";

    int top = lua_gettop(L);

    // Try loading as expression first (prepend "return ")
    std::string expr = "return " + code;
    int err = luaL_loadstring(L, expr.c_str());
    if (err != LUA_OK) {
        lua_pop(L, 1);
        // Try as statement
        err = luaL_loadstring(L, code.c_str());
        if (err != LUA_OK) {
            std::string msg = lua_tostring(L, -1);
            lua_pop(L, 1);
            return "syntax error: " + msg;
        }
    }

    err = lua_pcall(L, 0, LUA_MULTRET, 0);
    if (err != LUA_OK) {
        std::string msg = lua_tostring(L, -1);
        lua_pop(L, 1);
        return "runtime error: " + msg;
    }

    // Collect return values
    int nresults = lua_gettop(L) - top;
    if (nresults == 0) return "ok";

    std::string result;
    for (int i = 1; i <= nresults; i++) {
        if (i > 1) result += "\t";
        result += LuaValueToString(L, top + i);
    }

    lua_settop(L, top);
    return result;
}

// Execute a built-in server command (not Lua)
std::string ExecuteServerCommand(const std::string& cmd) {
    if (cmd == "frame") {
        return std::to_string(gs->frameNum);
    }
    if (cmd == "state") {
        std::ostringstream ss;
        ss << "frame=" << gs->frameNum
           << " teams=" << teamHandler.ActiveTeams()
           << " units=" << unitHandler.GetActiveUnits().size();
        return ss.str();
    }
    if (cmd.rfind("units", 0) == 0) {
        // "units" or "units <teamId>"
        int filterTeam = -1;
        if (cmd.size() > 6) filterTeam = std::atoi(cmd.c_str() + 6);

        std::ostringstream ss;
        int count = 0;
        for (const CUnit* u : unitHandler.GetActiveUnits()) {
            if (!u) continue;
            if (filterTeam >= 0 && u->team != filterTeam) continue;
            if (count > 0) ss << "\n";
            ss << "id=" << u->id << " def=" << u->unitDef->name
               << " team=" << u->team
               << " hp=" << u->health << "/" << u->maxHealth;
            count++;
            if (count > 100) { ss << "\n... (" << unitHandler.GetActiveUnits().size() << " total)"; break; }
        }
        if (count == 0) ss << "(no units)";
        return ss.str();
    }
    if (cmd == "defs") {
        std::ostringstream ss;
        ss << "unit defs: " << unitDefHandler->NumUnitDefs()
           << ", weapon defs: " << weaponDefHandler->NumWeaponDefs();
        return ss.str();
    }
    if (cmd == "pause") {
        gs->paused = true;
        return "paused";
    }
    if (cmd == "unpause") {
        gs->paused = false;
        return "unpaused";
    }
    if (cmd.rfind("speed ", 0) == 0) {
        float spd = std::atof(cmd.c_str() + 6);
        if (spd > 0.0f && spd <= 100.0f) {
            gs->speedFactor = spd;
            char buf[64];
            snprintf(buf, sizeof(buf), "speed set to %.1f", spd);
            return buf;
        }
        return "invalid speed (0-100)";
    }
    // Debugger commands
    if (cmd == "continue" || cmd == "c") {
        g_luaDebugger.Continue();
        return "resumed";
    }
    if (cmd == "step" || cmd == "s") {
        g_luaDebugger.StepLine();
        return "stepping";
    }
    if (cmd == "step_over" || cmd == "n") {
        g_luaDebugger.StepOver();
        return "step over";
    }
    if (cmd == "step_out" || cmd == "o") {
        g_luaDebugger.StepOut();
        return "step out";
    }
    if (cmd.rfind("break ", 0) == 0) {
        // "break file.lua:42"
        std::string spec = cmd.substr(6);
        auto colon = spec.rfind(':');
        if (colon == std::string::npos) return "usage: break file.lua:line";
        std::string file = spec.substr(0, colon);
        int line = std::atoi(spec.substr(colon + 1).c_str());
        int id = g_luaDebugger.AddBreakpoint(file, line);
        return "breakpoint " + std::to_string(id) + " set";
    }
    if (cmd == "break clear") {
        g_luaDebugger.ClearBreakpoints();
        return "all breakpoints cleared";
    }
    if (cmd == "break list") {
        auto bps = g_luaDebugger.ListBreakpoints();
        if (bps.empty()) return "(no breakpoints)";
        std::ostringstream ss;
        for (const auto& bp : bps) {
            ss << "#" << bp.id << " " << bp.file << ":" << bp.line << "\n";
        }
        return ss.str();
    }
    return "unknown command: " + cmd;
}

} // namespace

LuaExecResult ExecuteLuaExecRequest(const LuaExecRequest& req) {
    LuaExecResult result;
    result.requestId = req.requestId;
    result.scope = req.scope;
    result.clientId = req.clientId;

    if (req.scope == "LuaRules") {
        if (!luaRules) {
            result.success = false;
            result.output = "LuaRules not loaded";
        } else {
            result.output = ExecuteInLuaState(
                luaRules->syncedLuaHandle.GetLuaState(), req.code);
            result.success = result.output.find("error:") != 0
                          && result.output.find("syntax error:") != 0
                          && result.output.find("runtime error:") != 0;
        }
    }
    else if (req.scope == "LuaGaia") {
        if (!luaGaia) {
            result.success = false;
            result.output = "LuaGaia not loaded";
        } else {
            result.output = ExecuteInLuaState(
                luaGaia->syncedLuaHandle.GetLuaState(), req.code);
            result.success = result.output.find("error:") != 0
                          && result.output.find("syntax error:") != 0
                          && result.output.find("runtime error:") != 0;
        }
    }
    else if (req.scope.rfind("LuaAI:", 0) == 0) {
        // AI exec not yet implemented — needs AIRuntimePool.ExecuteLua()
        result.success = false;
        result.output = "LuaAI exec not yet implemented";
    }
    else if (req.scope == "server") {
        result.output = ExecuteServerCommand(req.code);
        result.success = result.output.find("unknown command:") != 0;
    }
    else {
        result.success = false;
        result.output = "unknown scope: " + req.scope;
    }

    SLOG(SPRING_LOG_DEBUG, "[%s] exec: %s -> %s",
         req.scope.c_str(), req.code.c_str(), result.output.c_str());

    return result;
}
