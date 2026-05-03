// LuaUnsyncedCtrl — see header for rationale.
//
// This file is a deliberate minimal shim. The original Spring
// LuaUnsyncedCtrl.cpp was ~4000 lines of rendering, sound, and
// player-side control bindings. None of that applies to our headless
// authoritative server, but gadgets still expect the very basic
// logging API (Spring.Echo / Spring.Log / Spring.Error) to exist in
// both the synced and unsynced Lua contexts.
//
// All three route through springlog_log so every sink (stderr, file,
// network) sees the messages.

#include "LuaUnsyncedCtrl.h"
#include "LuaUtils.h"
#include "System/SpringLog/SpringLog.h"

#include <cstdio>
#include <string>

extern "C" {
#include "lua.h"
#include "lauxlib.h"
}

#define LOG_SECTION "lua"

namespace {

// Spring.Log(section, level, msg, …) — mirrors the Spring API surface
// that gadgets actually invoke. Routes through springlog_log so all
// sinks (stderr, file, network) see the message. `level` can be a
// string ("error"/"warning"/"info"/"debug") or an integer from the
// LOG table the engine already binds (LOG.INFO = 30, LOG.WARNING = 40, …).
int Log(lua_State* L)
{
    // Section defaults to "lua" so empty-string callers (e.g.
    // gadgets.lua's `local LOG_SECTION = ""` which has a FIXME note
    // about never being registered) still produce a sensible prefix.
    const char* section = "lua";
    if (lua_type(L, 1) == LUA_TSTRING) {
        const char* s = lua_tostring(L, 1);
        if (s && s[0] != '\0') section = s;
    }

    // Map Lua level to SpringLogLevel. Distinguish number from string
    // explicitly because lua_isstring returns true for numbers too in
    // Lua 5.4 (auto-coerce).
    int logLevel = SPRING_LOG_INFO;
    const int levelType = lua_type(L, 2);
    if (levelType == LUA_TNUMBER) {
        const int lvl = static_cast<int>(lua_tonumber(L, 2));
        if      (lvl >= 60) logLevel = SPRING_LOG_FATAL;
        else if (lvl >= 50) logLevel = SPRING_LOG_ERROR;
        else if (lvl >= 40) logLevel = SPRING_LOG_WARNING;
        else if (lvl >= 30) logLevel = SPRING_LOG_NOTICE;
        else if (lvl >= 20) logLevel = SPRING_LOG_INFO;
        else                logLevel = SPRING_LOG_DEBUG;
    } else if (levelType == LUA_TSTRING) {
        const char* s = lua_tostring(L, 2);
        if (s) {
            switch (s[0]) {
                case 'f': case 'F': logLevel = SPRING_LOG_FATAL;   break;
                case 'e': case 'E': logLevel = SPRING_LOG_ERROR;   break;
                case 'w': case 'W': logLevel = SPRING_LOG_WARNING; break;
                case 'n': case 'N': logLevel = SPRING_LOG_NOTICE;  break;
                case 'i': case 'I': logLevel = SPRING_LOG_INFO;    break;
                case 'd': case 'D': logLevel = SPRING_LOG_DEBUG;   break;
            }
        }
    }

    // Build the message string from all remaining arguments.
    std::string msg;
    const int nargs = lua_gettop(L);
    for (int i = 3; i <= nargs; ++i) {
        if (i > 3) msg += ' ';
        if (lua_type(L, i) == LUA_TSTRING) {
            msg += lua_tostring(L, i);
        } else if (lua_type(L, i) == LUA_TNUMBER) {
            char buf[64];
            std::snprintf(buf, sizeof(buf), "%g", lua_tonumber(L, i));
            msg += buf;
        } else if (lua_isboolean(L, i)) {
            msg += lua_toboolean(L, i) ? "true" : "false";
        } else if (lua_isnil(L, i)) {
            msg += "nil";
        } else {
            msg += '<';
            msg += luaL_typename(L, i);
            msg += '>';
        }
    }

    springlog_log(logLevel, section, "", springlog_get_frame(),
                  "%s", msg.c_str());
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
        SLOG(SPRING_LOG_WARNING,
            "Spring.%s() called at %s  %s  "
            "(silently returning nil; further calls will be suppressed)",
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

constexpr char kSetCustomCommandDrawDataName[] = "SetCustomCommandDrawData";
constexpr char kSetCustomCommandDrawDataAdvice[] =
    "command draw data is a client-side rendering concern.";

constexpr char kSpawnCEGName[] = "SpawnCEG";
constexpr char kSpawnCEGAdvice[] =
    "CEG (custom explosion generators) are a client-side visual effect.";

constexpr char kMarkerAddPointName[] = "MarkerAddPoint";
constexpr char kMarkerAddPointAdvice[] =
    "map markers are a client-side UI feature.";

constexpr char kMarkerAddLineName[] = "MarkerAddLine";
constexpr char kMarkerAddLineAdvice[] =
    "map markers are a client-side UI feature.";

constexpr char kMarkerErasePositionName[] = "MarkerErasePosition";
constexpr char kMarkerErasePositionAdvice[] =
    "map markers are a client-side UI feature.";

constexpr char kSendCommandsName[] = "SendCommands";
constexpr char kSendCommandsAdvice[] =
    "Spring.SendCommands() is a client-side console command dispatcher.";

constexpr char kSetDrawGroundName[] = "SetDrawGround";
constexpr char kSetDrawGroundAdvice[] =
    "SetDrawGround is a client rendering toggle.";

constexpr char kSetDrawSkyName[] = "SetDrawSky";
constexpr char kSetDrawSkyAdvice[] =
    "SetDrawSky is a client rendering toggle.";

constexpr char kSetDrawWaterName[] = "SetDrawWater";
constexpr char kSetDrawWaterAdvice[] =
    "SetDrawWater is a client rendering toggle.";

constexpr char kSetSunLightingName[] = "SetSunLighting";
constexpr char kSetSunLightingAdvice[] =
    "sun lighting is a client rendering parameter.";

constexpr char kSetAtmosphereName[] = "SetAtmosphere";
constexpr char kSetAtmosphereAdvice[] =
    "atmosphere settings are a client rendering parameter.";

/// Register a noop stub with its own per-call-site upvalue slot.
template <const char* Name, const char* Advice>
void PushNoopStub(lua_State* L)
{
    lua_pushboolean(L, 0); // upvalue 1 = "not warned yet"
    lua_pushcclosure(L, ServerNoopStub<Name, Advice>, 1);
}

/// Silent noop — no warning, returns 0 results. Used for rendering/
/// client functions that gadgets call but have no server effect.
int SilentNoop(lua_State* /*L*/)
{
    return 0;
}

/// Noop that returns a single number (0). For GetTimer etc.
int NoopReturnZero(lua_State* L)
{
    lua_pushnumber(L, 0);
    return 1;
}

/// For GetTimer — returns a userdata-like number (used with DiffTimers).
int NoopGetTimer(lua_State* L)
{
    lua_pushnumber(L, 0);
    return 1;
}

/// For DiffTimers — returns elapsed ms (always 0 on server).
int NoopDiffTimers(lua_State* L)
{
    lua_pushnumber(L, 0);
    return 1;
}

// Spring.Echo(…) — route through springlog at NOTICE level. Uses
// Lua's tostring() for each argument, comma-separated, matching
// the LuaUtils::Echo formatting convention.
int EchoSpringLog(lua_State* L)
{
    std::string msg;
    const int nargs = lua_gettop(L);
    lua_getglobal(L, "tostring");
    for (int i = 1; i <= nargs; ++i) {
        lua_pushvalue(L, -1);  // tostring function
        lua_pushvalue(L, i);   // value
        lua_pcall(L, 1, 1, 0);
        const char* s = lua_tostring(L, -1);
        if (i > 1) msg += ", ";
        if (s) msg += s;
        lua_pop(L, 1);
    }
    lua_pop(L, 1); // pop tostring
    springlog_log(SPRING_LOG_NOTICE, LOG_SECTION, "", springlog_get_frame(),
                  "%s", msg.c_str());
    return 0;
}

/// Register a noop stub for a rendering/client API function.
#define REGISTER_NOOP_STUB(funcName) \
    lua_pushstring(L, #funcName); \
    PushNoopStub<k##funcName##Name, k##funcName##Advice>(L); \
    lua_rawset(L, -3)

} // namespace

bool LuaUnsyncedCtrl::PushEntries(lua_State* L)
{
    if (!lua_istable(L, -1)) return false;

    LuaPushNamedCFunc(L, "Echo",  EchoSpringLog);
    LuaPushNamedCFunc(L, "Log",   Log);
    LuaPushNamedCFunc(L, "Error", Error);

    // Server-side noop stubs for client/render/audio APIs.
    // See the ServerNoopStub template above for rationale.
    REGISTER_NOOP_STUB(LoadSoundDef);
    REGISTER_NOOP_STUB(PlaySoundFile);
    REGISTER_NOOP_STUB(PlaySoundStream);
    REGISTER_NOOP_STUB(SetCustomCommandDrawData);
    REGISTER_NOOP_STUB(SpawnCEG);
    REGISTER_NOOP_STUB(MarkerAddPoint);
    REGISTER_NOOP_STUB(MarkerAddLine);
    REGISTER_NOOP_STUB(MarkerErasePosition);
    REGISTER_NOOP_STUB(SendCommands);
    REGISTER_NOOP_STUB(SetDrawGround);
    REGISTER_NOOP_STUB(SetDrawSky);
    REGISTER_NOOP_STUB(SetDrawWater);
    REGISTER_NOOP_STUB(SetSunLighting);
    REGISTER_NOOP_STUB(SetAtmosphere);

    // Silent noops for frequently-called rendering functions
    LuaPushNamedCFunc(L, "AssignMouseCursor", SilentNoop);
    LuaPushNamedCFunc(L, "ReplaceMouseCursor", SilentNoop);
    LuaPushNamedCFunc(L, "SetMouseCursor", SilentNoop);
    LuaPushNamedCFunc(L, "WarpMouse", SilentNoop);

    // Timing functions (used for profiling in gadgets)
    LuaPushNamedCFunc(L, "GetTimer", NoopGetTimer);
    LuaPushNamedCFunc(L, "DiffTimers", NoopDiffTimers);

    // UnitRendering table (client-side visual overrides). ZK's
    // LuaRules/Utilities/UnitRendering.lua reads SetLODCount and
    // SetMaterialLastLOD at top-level even on a headless server, so
    // they need to exist as no-ops or `draw.lua` errors out before
    // any gadget loads.
    lua_createtable(L, 0, 6);
    LuaPushNamedCFunc(L, "SetUnitLuaDraw", SilentNoop);
    LuaPushNamedCFunc(L, "SetFeatureLuaDraw", SilentNoop);
    LuaPushNamedCFunc(L, "SetUnitNoDraw", SilentNoop);
    LuaPushNamedCFunc(L, "SetFeatureNoDraw", SilentNoop);
    LuaPushNamedCFunc(L, "SetLODCount", SilentNoop);
    LuaPushNamedCFunc(L, "SetMaterialLastLOD", SilentNoop);
    lua_setfield(L, -2, "UnitRendering");

    // FeatureRendering — same shape, parallel API. Also touched by
    // ZK's UnitRendering.lua at module load time.
    lua_createtable(L, 0, 2);
    LuaPushNamedCFunc(L, "SetLODCount", SilentNoop);
    LuaPushNamedCFunc(L, "SetMaterialLastLOD", SilentNoop);
    lua_setfield(L, -2, "FeatureRendering");

    #undef REGISTER_NOOP_STUB

    return true;
}
