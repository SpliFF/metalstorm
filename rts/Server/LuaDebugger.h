// LuaDebugger — breakpoint and inspection support for server-side Lua.
//
// Manages breakpoints per LuaHandle (LuaRules, LuaGaia, each LuaAI).
// When a breakpoint is hit, pauses the sim until a continue/step
// command is received via the console command interface.

#pragma once

#include <string>
#include <vector>
#include <set>
#include <mutex>
#include <atomic>

// Lua compiled as C++ in this project
#include <lua.h>

struct BreakpointInfo {
    std::string file;
    int line;
    int id;
};

struct StackFrame {
    std::string source;
    int line;
    std::string name;
    std::string what; // "Lua", "C", "main"
};

struct LocalVar {
    std::string name;
    std::string value;
    std::string type;
};

class LuaDebugger {
public:
    LuaDebugger();

    // Breakpoint management
    int AddBreakpoint(const std::string& file, int line);
    void RemoveBreakpoint(int id);
    void ClearBreakpoints();
    std::vector<BreakpointInfo> ListBreakpoints() const;

    // Install/remove debug hook on a lua_State
    void Attach(lua_State* L);
    void Detach(lua_State* L);

    // State queries (while paused)
    bool IsPaused() const { return paused_.load(); }
    std::vector<StackFrame> GetCallStack(lua_State* L) const;
    std::vector<LocalVar> GetLocals(lua_State* L, int frameLevel = 0) const;
    std::vector<LocalVar> GetUpvalues(lua_State* L, int frameLevel = 0) const;
    std::string Eval(lua_State* L, const std::string& expr) const;

    // Continue commands
    void Continue();
    void StepLine();
    void StepOver();
    void StepOut();

    // Called from debug hook — do not call directly
    void OnHook(lua_State* L, lua_Debug* ar);

private:
    bool ShouldBreak(const std::string& source, int line) const;
    std::string LuaValueToStr(lua_State* L, int idx) const;

    mutable std::mutex mutex_;
    std::vector<BreakpointInfo> breakpoints_;
    int nextBpId_ = 1;
    std::atomic<bool> paused_{false};

    enum StepMode { None, Line, Over, Out };
    StepMode stepMode_ = None;
    int stepDepth_ = 0;
};

// Global debugger instance
extern LuaDebugger g_luaDebugger;
