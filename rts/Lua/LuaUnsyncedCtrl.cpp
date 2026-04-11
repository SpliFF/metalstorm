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
// table the engine already binds (LOG.INFO = 30, LOG.WARNING = 40, …).
int Log(lua_State* L)
{
    // Section defaults to "lua" so empty-string callers (e.g.
    // gadgets.lua's `local LOG_SECTION = ""` which has a FIXME note
    // about never being registered) still produce a sensible prefix
    // instead of `[lua::…]`.
    const char* section = "lua";
    if (lua_type(L, 1) == LUA_TSTRING) {
        const char* s = lua_tostring(L, 1);
        if (s && s[0] != '\0') section = s;
    }

    // Level first — distinguish number from string explicitly
    // because lua_isstring returns true for numbers too in Lua 5.4
    // (auto-coerce), which would otherwise turn LOG.INFO into the
    // literal string "30.0".
    const char* level = "info";
    const int levelType = lua_type(L, 2);
    if (levelType == LUA_TNUMBER) {
        const int lvl = static_cast<int>(lua_tonumber(L, 2));
        if      (lvl >= 60) level = "fatal";
        else if (lvl >= 50) level = "error";
        else if (lvl >= 40) level = "warning";
        else if (lvl >= 30) level = "notice";
        else if (lvl >= 20) level = "info";
        else                level = "debug";
    } else if (levelType == LUA_TSTRING) {
        level = lua_tostring(L, 2);
    }

    std::fprintf(stderr, "[%s:%s] ", section, level);
    const int nargs = lua_gettop(L);
    for (int i = 3; i <= nargs; ++i) {
        if (i > 3) std::fputc(' ', stderr);
        if (lua_type(L, i) == LUA_TSTRING) {
            std::fputs(lua_tostring(L, i), stderr);
        } else if (lua_type(L, i) == LUA_TNUMBER) {
            std::fprintf(stderr, "%g", lua_tonumber(L, i));
        } else if (lua_isboolean(L, i)) {
            std::fputs(lua_toboolean(L, i) ? "true" : "false", stderr);
        } else if (lua_isnil(L, i)) {
            std::fputs("nil", stderr);
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

// ============================================================
// Server-side no-op stubs
// ============================================================
//
// Bundle of Spring APIs that are purely client/render/audio concerns
// in the authoritative-server architecture. Gadgets call them
// expecting them to exist; on a renderless headless server they
// have nothing sensible to do. Rather than leave them undefined
// (which crashes gadgets with "attempt to call a nil value") we
// register a family of noop_* C functions that silently return nil.
//
// Each noop fires a one-shot log line the first time it's invoked
// so developers see in the game log that a gadget is leaning on a
// feature the server doesn't support. The message points at the
// relevant client-side replacement where one exists (e.g. "use a
// client widget in LuaUI/Widgets/ for audio cue playback").
//
// This is deliberately separate from the 5.1 compat shims — those
// emulate removed Lua builtins, these are semantic deprecations
// for server-vs-client responsibility splits in the new engine.

/// Holds per-stub "warned already" state in a closure upvalue.
template <const char* StubName, const char* Advice>
int ServerNoopStub(lua_State* L)
{
    if (!lua_toboolean(L, lua_upvalueindex(1))) {
        lua_Debug ar;
        std::string where = "?";
        if (lua_getstack(L, 1, &ar) && lua_getinfo(L, "Sl", &ar)) {
            char buf[256];
            SNPRINTF(buf, sizeof(buf), "%s:%d", ar.short_src, ar.currentline);
            where = buf;
        }
        std::fprintf(stderr,
            "[server stub] Spring.%s() called at %s\n"
            "              %s\n"
            "              (silently returning nil; further calls "
            "will be suppressed)\n",
            StubName, where.c_str(), Advice);
        lua_pushboolean(L, 1);
        lua_replace(L, lua_upvalueindex(1));
    }
    lua_pushnil(L);
    return 1;
}

// Stub name + advice strings have to live at namespace scope
// because they're template non-type parameters.
constexpr char kLoadSoundDefName[]   = "LoadSoundDef";
constexpr char kLoadSoundDefAdvice[] =
    "audio is handled by the browser client; ship your sounds.lua "
    "as part of the client bundle and load it from a LuaUI widget. "
    "See PLAN-audio.md for the Web Audio routing model.";

constexpr char kPlaySoundFileName[]  = "PlaySoundFile";
constexpr char kPlaySoundFileAdvice[] =
    "the server doesn't play audio. Emit an event through the "
    "pub-sub layer (PLAN-messages.md) and let client widgets "
    "translate it into a PlaySoundFile call on the client.";

constexpr char kPlaySoundStreamName[] = "PlaySoundStream";
constexpr char kPlaySoundStreamAdvice[] =
    "music/streamed audio is a client-side concern. Emit a server "
    "event to trigger playback on the client.";

/// Register a noop stub with its own per-call-site upvalue slot.
template <const char* Name, const char* Advice>
void PushNoopStub(lua_State* L)
{
    lua_pushboolean(L, 0); // upvalue 1 = "not warned yet"
    lua_pushcclosure(L, ServerNoopStub<Name, Advice>, 1);
}

} // namespace

bool LuaUnsyncedCtrl::PushEntries(lua_State* L)
{
    if (!lua_istable(L, -1)) return false;

    LuaPushNamedCFunc(L, "Echo",  LuaUtils::Echo);
    LuaPushNamedCFunc(L, "Log",   Log);
    LuaPushNamedCFunc(L, "Error", Error);

    // Server-side noop stubs for client/render/audio APIs.
    // See the ServerNoopStub template above for rationale.
    lua_pushstring(L, "LoadSoundDef");
    PushNoopStub<kLoadSoundDefName, kLoadSoundDefAdvice>(L);
    lua_rawset(L, -3);

    lua_pushstring(L, "PlaySoundFile");
    PushNoopStub<kPlaySoundFileName, kPlaySoundFileAdvice>(L);
    lua_rawset(L, -3);

    lua_pushstring(L, "PlaySoundStream");
    PushNoopStub<kPlaySoundStreamName, kPlaySoundStreamAdvice>(L);
    lua_rawset(L, -3);

    return true;
}
