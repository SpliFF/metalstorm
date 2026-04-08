// Spring RTS Web — Lua 5.4 include header with 5.1 compatibility shims.
//
// This replaces Spring's heavily customized LuaInclude.h. The engine
// code uses some Lua 5.1 APIs that were removed in 5.2+. This header
// provides inline compatibility wrappers.
#ifndef SPRING_LUA_INCLUDE
#define SPRING_LUA_INCLUDE

#include <string>
#include <cstring>
#include <cassert>

// Lua compiled as C++ — no extern "C" needed
#include "lua.h"
#include "lualib.h"
#include "lauxlib.h"

// For LOG_L in safety wrappers
#include "System/Log/ILog.h"

// ===================================================================
// Lua 5.1 → 5.4 compatibility shims
// ===================================================================

// LUA_GLOBALSINDEX was removed in 5.2. Provide helper functions instead.
// IMPORTANT: lua_rawset/lua_gettable with this pseudo-index do NOT work
// in Lua 5.4. Use lua_pushglobaltable(L) explicitly.

// Helper: push the global table onto the stack (replaces lua_pushvalue(L, LUA_GLOBALSINDEX))
#ifndef lua_pushglobaltable
#define lua_pushglobaltable(L) lua_rawgeti(L, LUA_REGISTRYINDEX, LUA_RIDX_GLOBALS)
#endif

// Compat: rawset into the global table (key and value already on stack)
static inline void lua_rawset_global(lua_State* L) {
    lua_pushglobaltable(L);     // stack: ... key value globals
    lua_insert(L, -3);          // stack: ... globals key value
    lua_rawset(L, -3);          // stack: ... globals
    lua_pop(L, 1);              // stack: ...
}

// Compat: gettable from the global table (key on stack, pushes value)
static inline void lua_gettable_global(lua_State* L) {
    lua_pushglobaltable(L);     // stack: ... key globals
    lua_insert(L, -2);          // stack: ... globals key
    lua_gettable(L, -2);        // stack: ... globals value
    lua_remove(L, -2);          // stack: ... value
}

// LUA_ENVIRONINDEX was removed in 5.2. Not directly replaceable;
// code using it needs case-by-case fixes. Define as a sentinel.
#ifndef LUA_ENVIRONINDEX
#define LUA_ENVIRONINDEX (-10001)
#endif

// lua_objlen → lua_rawlen
#ifndef lua_objlen
#define lua_objlen(L, i) lua_rawlen(L, i)
#endif

// lua_equal → lua_compare
static inline int lua_equal(lua_State* L, int idx1, int idx2) {
    return lua_compare(L, idx1, idx2, LUA_OPEQ);
}

// lua_lessthan → lua_compare
static inline int lua_lessthan(lua_State* L, int idx1, int idx2) {
    return lua_compare(L, idx1, idx2, LUA_OPLT);
}

// luaL_checkint / luaL_optint removed in 5.3.
// Lua 5.4 luaL_checkinteger is strict — rejects floats like 160.0.
// Spring games pass float division results to C functions expecting
// ints (e.g. spot.x / squareSize). Use luaL_checknumber + cast to
// match the lenient Lua 5.1 behaviour.
#ifndef luaL_checkint
#define luaL_checkint(L, n) ((int)luaL_checknumber(L, n))
#endif
#ifndef luaL_optint
#define luaL_optint(L, n, d) ((int)luaL_optnumber(L, n, (lua_Number)(d)))
#endif

// lua_strlen removed (was alias for lua_objlen, now lua_rawlen)
#ifndef lua_strlen
#define lua_strlen(L, i) lua_rawlen(L, i)
#endif

// lua_cpcall removed in 5.2. Implement via lua_pushcfunction + lua_pcall.
static inline int lua_cpcall(lua_State* L, lua_CFunction func, void* ud) {
    lua_pushcfunction(L, func);
    lua_pushlightuserdata(L, ud);
    return lua_pcall(L, 1, 0, 0);
}

// luaL_typerror removed in 5.2
static inline int luaL_typerror(lua_State* L, int narg, const char* tname) {
    return luaL_error(L, "bad argument #%d (%s expected, got %s)",
                      narg, tname, luaL_typename(L, narg));
}

// luaL_register removed in 5.2. Use luaL_setfuncs + lua_setglobal.
static inline void luaL_register(lua_State* L, const char* libname, const luaL_Reg* l) {
    if (libname) {
        lua_newtable(L);
        luaL_setfuncs(L, l, 0);
        lua_setglobal(L, libname);
    } else {
        luaL_setfuncs(L, l, 0);
    }
}

// luaL_findtable removed in 5.2. Simplified reimplementation.
static inline const char* luaL_findtable(lua_State* L, int idx, const char* fname, int szhint) {
    (void)szhint;
    if (idx != LUA_REGISTRYINDEX) {
        lua_pushvalue(L, idx);
    } else {
        lua_pushvalue(L, LUA_REGISTRYINDEX);
    }
    // Split fname by '.' and navigate/create subtables
    const char* e;
    while ((e = strchr(fname, '.')) != nullptr) {
        lua_pushlstring(L, fname, e - fname);
        lua_rawget(L, -2);
        if (lua_isnil(L, -1)) {
            lua_pop(L, 1);
            lua_pushlstring(L, fname, e - fname);
            lua_newtable(L);
            lua_rawset(L, -3);
            lua_pushlstring(L, fname, e - fname);
            lua_rawget(L, -2);
        }
        lua_remove(L, -2);
        fname = e + 1;
    }
    lua_pushstring(L, fname);
    lua_rawget(L, -2);
    if (lua_isnil(L, -1)) {
        lua_pop(L, 1);
        lua_pushstring(L, fname);
        lua_newtable(L);
        lua_rawset(L, -3);
        lua_pushstring(L, fname);
        lua_rawget(L, -2);
    }
    lua_remove(L, -2);
    return nullptr;
}

// lua_setfenv / lua_getfenv removed in 5.2.
// In Lua 5.4, function environments are the first upvalue (_ENV).
static inline int lua_setfenv(lua_State* L, int idx) {
    int absIdx = (idx > 0) ? idx : lua_gettop(L) + idx + 1;
    if (!lua_isfunction(L, absIdx)) {
        lua_pop(L, 1);
        return 0;
    }
    // The first upvalue of a Lua 5.4 function is _ENV
    const char* name = lua_setupvalue(L, absIdx, 1);
    return (name != nullptr) ? 1 : 0;
}

static inline void lua_getfenv(lua_State* L, int idx) {
    int absIdx = (idx > 0) ? idx : lua_gettop(L) + idx + 1;
    if (lua_isfunction(L, absIdx)) {
        const char* name = lua_getupvalue(L, absIdx, 1);
        if (name == nullptr)
            lua_pushglobaltable(L);
    } else {
        lua_pushglobaltable(L);
    }
}

// lua_resume signature changed: 5.4 has (L, from, nargs, &nresults)
// The engine likely calls the 5.1 signature: lua_resume(L, nargs)
// We can't easily shim this without knowing the calling context,
// so individual call sites may need manual fixes.

// ===================================================================
// Spring convenience wrappers (kept from original LuaInclude.h)
// ===================================================================

static inline void lua_pushsstring(lua_State* L, const std::string& str) {
    lua_pushlstring(L, str.data(), str.size());
}

static inline std::string luaL_tosstring(lua_State* L, int index) {
    size_t len = 0;
    const char* s = lua_tolstring(L, index, &len);
    return s ? std::string(s, len) : std::string();
}

static inline std::string luaL_checksstring(lua_State* L, int index) {
    size_t len = 0;
    const char* s = luaL_checklstring(L, index, &len);
    return std::string(s, len);
}

static inline std::string luaL_optsstring(lua_State* L, int index, const std::string& def) {
    if (lua_isnoneornil(L, index)) return def;
    return luaL_checksstring(L, index);
}

static inline bool lua_israwnumber(lua_State* L, int index) {
    return (lua_type(L, index) == LUA_TNUMBER);
}

static inline bool lua_israwstring(lua_State* L, int index) {
    return (lua_type(L, index) == LUA_TSTRING);
}

static inline int lua_checkgeti(lua_State* L, int idx, int n) {
    lua_rawgeti(L, idx, n);
    if (lua_isnoneornil(L, -1)) {
        lua_pop(L, 1);
        return 0;
    }
    return 1;
}

static inline int lua_toint(lua_State* L, int idx) {
    return (int)lua_tointeger(L, idx);
}

static inline float lua_tofloat(lua_State* L, int idx) {
    return (float)lua_tonumber(L, idx);
}

static inline float luaL_checkfloat(lua_State* L, int idx) {
    return (float)luaL_checknumber(L, idx);
}

static inline float luaL_optfloat(lua_State* L, int idx, float def) {
    return (float)luaL_optnumber(L, idx, def);
}

static inline bool luaL_checkboolean(lua_State* L, int idx) {
    luaL_checktype(L, idx, LUA_TBOOLEAN);
    return lua_toboolean(L, idx);
}

static inline bool luaL_optboolean(lua_State* L, int idx, bool def) {
    if (lua_isnoneornil(L, idx)) return def;
    return lua_toboolean(L, idx);
}

// Safe lua_pop with assertion
#undef lua_pop
static inline void lua_pop(lua_State* L, const int args) {
    assert(args > 0);
    lua_settop(L, -(args)-1);
}

static inline int luaS_absIndex(lua_State* L, const int i) {
    if (i <= 0 && i > LUA_REGISTRYINDEX)
        return lua_gettop(L) + (i) + 1;
    return i;
}

// ===================================================================
// Spring custom Lua API shims (these don't exist in standard Lua)
// ===================================================================

// lua_calchash / lua_pushhstring were Spring's pre-computed hash string
// pushes. Standard Lua 5.4 already interns short strings efficiently.
static inline unsigned int lua_calchash(const char* s, size_t len) {
    (void)s; (void)len;
    return 0; // hash value unused with standard Lua
}

static inline void lua_pushhstring(lua_State* L, unsigned int hash, const char* s, size_t len) {
    (void)hash;
    lua_pushlstring(L, s, len);
}

// spring_lua_get_handle_name — used by debug logging
static inline const char* spring_lua_get_handle_name(lua_State* L) {
    (void)L;
    return "LuaHandle";
}

// spring_lua_alloc_skip_gc — custom GC throttling, not needed with Lua 5.4's generational GC
static inline bool spring_lua_alloc_skip_gc(float) { return false; }

// lua_lock/lua_unlock — Spring's threading macros. No-ops in standard Lua.
#ifndef lua_lock
#define lua_lock(L) ((void)0)
#endif
#ifndef lua_unlock
#define lua_unlock(L) ((void)0)
#endif

// luaL_checknumber_noassert — Spring version without NaN assertion
static inline lua_Number luaL_checknumber_noassert(lua_State* L, int idx) {
    return luaL_checknumber(L, idx);
}

// ===================================================================
// Context data — associates luaContextData with lua_State
// ===================================================================

struct luaContextData;

// In standard Lua 5.4, we use lua_getextraspace() to store a pointer
// to the luaContextData. This avoids patching Lua internals.
static inline luaContextData* GetLuaContextData(const lua_State* L) {
    void** extra = (void**)lua_getextraspace(const_cast<lua_State*>(L));
    return reinterpret_cast<luaContextData*>(*extra);
}

static inline void SetLuaContextData(lua_State* L, luaContextData* lcd) {
    void** extra = (void**)lua_getextraspace(L);
    *extra = lcd;
}

// ===================================================================
// State creation & destruction
// ===================================================================

// Standard Lua 5.4 state creation
static inline lua_State* LUA_OPEN(luaContextData* lcd) {
    lua_State* L = luaL_newstate();
    if (L && lcd)
        SetLuaContextData(L, lcd);
    return L;
}

static inline void LUA_CLOSE(lua_State** L) {
    assert((*L) != nullptr);
    lua_close(*L);
    *L = nullptr;
}

static inline void LUA_UNLOAD_LIB(lua_State* L, std::string libname) {
    luaL_findtable(L, LUA_REGISTRYINDEX, "_LOADED", 1);
    lua_pushsstring(L, libname);
    lua_pushnil(L);
    lua_rawset(L, -3);
    lua_pop(L, 1); // pop _LOADED table

    lua_pushnil(L);
    lua_setglobal(L, libname.c_str());
}

// Lua 5.4: use luaL_requiref to properly register standard libraries globally.
// The old lua_pushcfunction+lua_pcall(0,0,0) approach doesn't register globals in 5.4.
static inline void lua_openlib(lua_State* L, const char* name, lua_CFunction func) {
    luaL_requiref(L, name, func, 1);
    lua_pop(L, 1);
}

#define LUA_OPEN_LIB(L, lib) lua_openlib((L), LUA_OPEN_LIB_NAME(lib), lib)

// Map luaopen_* function names to library names
#define LUA_OPEN_LIB_NAME(lib) LUA_OPEN_LIB_NAME_##lib
#define LUA_OPEN_LIB_NAME_luaopen_base    "_G"
#define LUA_OPEN_LIB_NAME_luaopen_math    LUA_MATHLIBNAME
#define LUA_OPEN_LIB_NAME_luaopen_table   LUA_TABLIBNAME
#define LUA_OPEN_LIB_NAME_luaopen_string  LUA_STRLIBNAME
#define LUA_OPEN_LIB_NAME_luaopen_io      LUA_IOLIBNAME
#define LUA_OPEN_LIB_NAME_luaopen_os      LUA_OSLIBNAME
#define LUA_OPEN_LIB_NAME_luaopen_package LUA_LOADLIBNAME
#define LUA_OPEN_LIB_NAME_luaopen_debug   LUA_DBLIBNAME
#define LUA_OPEN_LIB_NAME_luaopen_coroutine LUA_COLIBNAME
#define LUA_OPEN_LIB_NAME_luaopen_utf8    LUA_UTF8LIBNAME

#define SPRING_LUA_OPEN_LIB(L, lib) LUA_OPEN_LIB(L, lib)

#endif // SPRING_LUA_INCLUDE
