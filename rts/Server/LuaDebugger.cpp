// LuaDebugger — breakpoint + interactive debugging for Lua contexts.

#include "LuaDebugger.h"
#include "System/SpringLog/SpringLog.h"

// Lua compiled as C++ in this project — no extern "C"
#include <lua.h>
#include <lauxlib.h>

#include <algorithm>
#include <thread>
#include <chrono>
#include <cstring>
#include <sstream>

#define LOG_SECTION "debugger"

LuaDebugger g_luaDebugger;

// Debug hook callback — bridges to the global debugger
static void DebugHookCB(lua_State* L, lua_Debug* ar) {
    g_luaDebugger.OnHook(L, ar);
}

LuaDebugger::LuaDebugger() = default;

int LuaDebugger::AddBreakpoint(const std::string& file, int line) {
    std::lock_guard<std::mutex> lock(mutex_);
    int id = nextBpId_++;
    breakpoints_.push_back({file, line, id});
    SLOG(SPRING_LOG_NOTICE, "breakpoint %d set: %s:%d", id, file.c_str(), line);
    return id;
}

void LuaDebugger::RemoveBreakpoint(int id) {
    std::lock_guard<std::mutex> lock(mutex_);
    breakpoints_.erase(
        std::remove_if(breakpoints_.begin(), breakpoints_.end(),
            [id](const BreakpointInfo& bp) { return bp.id == id; }),
        breakpoints_.end());
}

void LuaDebugger::ClearBreakpoints() {
    std::lock_guard<std::mutex> lock(mutex_);
    breakpoints_.clear();
    SLOG(SPRING_LOG_NOTICE, "all breakpoints cleared");
}

std::vector<BreakpointInfo> LuaDebugger::ListBreakpoints() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return breakpoints_;
}

void LuaDebugger::Attach(lua_State* L) {
    if (!L) return;
    lua_sethook(L, DebugHookCB, LUA_MASKLINE, 0);
    SLOG(SPRING_LOG_INFO, "debug hook attached");
}

void LuaDebugger::Detach(lua_State* L) {
    if (!L) return;
    lua_sethook(L, nullptr, 0, 0);
    paused_.store(false);
}

bool LuaDebugger::ShouldBreak(const std::string& source, int line) const {
    std::lock_guard<std::mutex> lock(mutex_);
    for (const auto& bp : breakpoints_) {
        if (bp.line == line && source.find(bp.file) != std::string::npos)
            return true;
    }
    return false;
}

void LuaDebugger::OnHook(lua_State* L, lua_Debug* ar) {
    if (ar->event != LUA_HOOKLINE) return;

    lua_getinfo(L, "Sl", ar);
    const char* src = ar->source ? ar->source : "?";
    int line = ar->currentline;

    bool shouldBreak = false;

    if (stepMode_ == Line) {
        shouldBreak = true;
        stepMode_ = None;
    } else if (stepMode_ == Over) {
        // Break when we're back at the same or shallower depth
        lua_Debug check;
        int depth = 0;
        while (lua_getstack(L, depth, &check)) depth++;
        if (depth <= stepDepth_) {
            shouldBreak = true;
            stepMode_ = None;
        }
    } else if (stepMode_ == Out) {
        lua_Debug check;
        int depth = 0;
        while (lua_getstack(L, depth, &check)) depth++;
        if (depth < stepDepth_) {
            shouldBreak = true;
            stepMode_ = None;
        }
    } else {
        shouldBreak = ShouldBreak(src, line);
    }

    if (!shouldBreak) return;

    SLOG(SPRING_LOG_NOTICE, "paused at %s:%d", src, line);
    paused_.store(true);

    // Spin-wait while paused — the sim loop checks IsPaused() and
    // processes debug commands instead of ticking.
    while (paused_.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
}

std::vector<StackFrame> LuaDebugger::GetCallStack(lua_State* L) const {
    std::vector<StackFrame> frames;
    lua_Debug ar;
    for (int level = 0; lua_getstack(L, level, &ar); level++) {
        lua_getinfo(L, "Snl", &ar);
        StackFrame f;
        f.source = ar.source ? ar.source : "?";
        f.line = ar.currentline;
        f.name = ar.name ? ar.name : "(anonymous)";
        f.what = ar.what ? ar.what : "?";
        frames.push_back(f);
        if (frames.size() > 50) break;
    }
    return frames;
}

std::vector<LocalVar> LuaDebugger::GetLocals(lua_State* L, int frameLevel) const {
    std::vector<LocalVar> vars;
    lua_Debug ar;
    if (!lua_getstack(L, frameLevel, &ar)) return vars;

    for (int i = 1; ; i++) {
        const char* name = lua_getlocal(L, &ar, i);
        if (!name) break;
        LocalVar v;
        v.name = name;
        v.type = luaL_typename(L, -1);
        v.value = LuaValueToStr(L, -1);
        lua_pop(L, 1);
        vars.push_back(v);
        if (vars.size() > 100) break;
    }
    return vars;
}

std::vector<LocalVar> LuaDebugger::GetUpvalues(lua_State* L, int frameLevel) const {
    std::vector<LocalVar> vars;
    lua_Debug ar;
    if (!lua_getstack(L, frameLevel, &ar)) return vars;

    lua_getinfo(L, "f", &ar); // push function
    if (!lua_isfunction(L, -1)) { lua_pop(L, 1); return vars; }

    for (int i = 1; ; i++) {
        const char* name = lua_getupvalue(L, -1, i);
        if (!name) break;
        LocalVar v;
        v.name = name;
        v.type = luaL_typename(L, -1);
        v.value = LuaValueToStr(L, -1);
        lua_pop(L, 1);
        vars.push_back(v);
    }
    lua_pop(L, 1); // pop function
    return vars;
}

std::string LuaDebugger::Eval(lua_State* L, const std::string& expr) const {
    std::string code = "return " + expr;
    if (luaL_loadstring(L, code.c_str()) != LUA_OK) {
        std::string err = lua_tostring(L, -1);
        lua_pop(L, 1);
        return "error: " + err;
    }
    if (lua_pcall(L, 0, 1, 0) != LUA_OK) {
        std::string err = lua_tostring(L, -1);
        lua_pop(L, 1);
        return "error: " + err;
    }
    std::string result = LuaValueToStr(L, -1);
    lua_pop(L, 1);
    return result;
}

void LuaDebugger::Continue() {
    stepMode_ = None;
    paused_.store(false);
}

void LuaDebugger::StepLine() {
    stepMode_ = Line;
    paused_.store(false);
}

void LuaDebugger::StepOver() {
    stepMode_ = Over;
    paused_.store(false);
}

void LuaDebugger::StepOut() {
    stepMode_ = Out;
    paused_.store(false);
}

std::string LuaDebugger::LuaValueToStr(lua_State* L, int idx) const {
    int t = lua_type(L, idx);
    switch (t) {
        case LUA_TNIL:     return "nil";
        case LUA_TBOOLEAN: return lua_toboolean(L, idx) ? "true" : "false";
        case LUA_TNUMBER: {
            char buf[64];
            if (lua_isinteger(L, idx))
                snprintf(buf, sizeof(buf), "%lld", (long long)lua_tointeger(L, idx));
            else
                snprintf(buf, sizeof(buf), "%.6g", lua_tonumber(L, idx));
            return buf;
        }
        case LUA_TSTRING: {
            size_t len;
            const char* s = lua_tolstring(L, idx, &len);
            if (len > 200) return std::string(s, 200) + "...";
            return std::string(s, len);
        }
        case LUA_TTABLE: return "{table}";
        case LUA_TFUNCTION: return "{function}";
        default: {
            char buf[32];
            snprintf(buf, sizeof(buf), "<%s>", lua_typename(L, t));
            return buf;
        }
    }
}
