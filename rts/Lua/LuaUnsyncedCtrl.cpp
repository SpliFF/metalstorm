// LuaUnsyncedCtrl — see header for rationale.
//
// This file is a deliberate minimal shim. The original Spring
// LuaUnsyncedCtrl.cpp was ~4000 lines of rendering, sound, and
// player-side control bindings. None of that applies to our headless
// authoritative server, but gadgets still expect the very basic
// logging API (Spring.Echo / Spring.Log / Spring.Error) to exist in
// both the synced and unsynced Lua contexts.
//
// The implementation uses the shared `LuaUtils::Echo` — the same
// one that `LuaParser` already binds — and adds `Log` and `Error`.

#include "LuaUnsyncedCtrl.h"
#include "LuaUtils.h"

extern "C" {
#include "lua.h"
#include "lauxlib.h"
}

namespace {

// Spring.Log(section, level, msg, …) — mirrors the Spring API surface
// that gadgets actually invoke. We don't have a multi-sink log router
// in the sim yet, so for now we just format everything as one stderr
// line prefixed with the section and level. `level` can be a string
// ("error" / "warning" / "info" / "debug") or an integer from the LOG
// table the engine already binds.
int Log(lua_State* L)
{
    const char* section = luaL_optstring(L, 1, "?");
    const char* level   = "info";
    if (lua_isstring(L, 2)) {
        level = lua_tostring(L, 2);
    } else if (lua_isnumber(L, 2)) {
        const int lvl = static_cast<int>(lua_tonumber(L, 2));
        if (lvl >= 50)      level = "error";
        else if (lvl >= 40) level = "warning";
        else if (lvl >= 30) level = "notice";
        else if (lvl >= 20) level = "info";
        else                level = "debug";
    }

    std::fprintf(stderr, "[lua:%s:%s] ", section, level);
    const int nargs = lua_gettop(L);
    for (int i = 3; i <= nargs; ++i) {
        if (i > 3) std::fputc('\t', stderr);
        if (lua_isstring(L, i) || lua_isnumber(L, i)) {
            std::fputs(lua_tostring(L, i), stderr);
        } else {
            std::fprintf(stderr, "<%s>", luaL_typename(L, i));
        }
    }
    std::fputc('\n', stderr);
    return 0;
}

// Spring.Error(msg) — raise a Lua error. In Spring this is
// functionally `error(…)` but with a distinctive name gadgets use
// instead of the raw `error` builtin.
int Error(lua_State* L)
{
    const char* msg = luaL_optstring(L, 1, "(no message)");
    return luaL_error(L, "%s", msg);
}

} // namespace

bool LuaUnsyncedCtrl::PushEntries(lua_State* L)
{
    if (!lua_istable(L, -1)) return false;

    LuaPushNamedCFunc(L, "Echo",  LuaUtils::Echo);
    LuaPushNamedCFunc(L, "Log",   Log);
    LuaPushNamedCFunc(L, "Error", Error);
    return true;
}
