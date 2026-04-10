// LuaVFSSimple — VFS.* Lua functions backed by CFileHandler.

#include "LuaVFSSimple.h"
#include "FileHandler.h"

// Lua compiled as C++
#include "lua.h"
#include "lualib.h"
#include "lauxlib.h"

#include <cstdio>
#include <string>
#include <vector>

// ============================================================
// VFS.LoadFile(path) → string or nil
// ============================================================
static int l_LoadFile(lua_State* L) {
    const char* path = luaL_checkstring(L, 1);
    CFileHandler fh(path);
    if (!fh.FileExists()) {
        lua_pushnil(L);
        return 1;
    }
    std::string content;
    if (!fh.LoadStringData(content)) {
        lua_pushnil(L);
        return 1;
    }
    lua_pushlstring(L, content.data(), content.size());
    return 1;
}

// ============================================================
// VFS.FileExists(path) → boolean
// ============================================================
static int l_FileExists(lua_State* L) {
    const char* path = luaL_checkstring(L, 1);
    CFileHandler fh(path);
    lua_pushboolean(L, fh.FileExists());
    return 1;
}

// ============================================================
// VFS.DirList(dir, pattern) → {string, ...}
// ============================================================
static int l_DirList(lua_State* L) {
    const char* dir = luaL_checkstring(L, 1);
    const char* pattern = luaL_optstring(L, 2, "*");
    auto files = CFileHandler::DirList(dir, pattern);
    lua_createtable(L, files.size(), 0);
    for (size_t i = 0; i < files.size(); i++) {
        lua_pushlstring(L, files[i].data(), files[i].size());
        lua_rawseti(L, -2, i + 1);
    }
    return 1;
}

// ============================================================
// VFS.SubDirs(dir, pattern) → {string, ...}
// ============================================================
static int l_SubDirs(lua_State* L) {
    const char* dir = luaL_checkstring(L, 1);
    const char* pattern = luaL_optstring(L, 2, "*");
    auto dirs = CFileHandler::SubDirs(dir, pattern);
    lua_createtable(L, dirs.size(), 0);
    for (size_t i = 0; i < dirs.size(); i++) {
        lua_pushlstring(L, dirs[i].data(), dirs[i].size());
        lua_rawseti(L, -2, i + 1);
    }
    return 1;
}

// ============================================================
// VFS.Include(path [, envTable]) → results from loaded file
// ============================================================
static int l_Include(lua_State* L) {
    const char* path = luaL_checkstring(L, 1);

    // Load the file content via CFileHandler
    CFileHandler fh(path);
    if (!fh.FileExists()) {
        return luaL_error(L, "VFS.Include: file not found '%s'", path);
    }

    std::string code;
    if (!fh.LoadStringData(code)) {
        return luaL_error(L, "VFS.Include: could not read '%s'", path);
    }

    // Compile the chunk
    if (luaL_loadbuffer(L, code.c_str(), code.size(), path) != LUA_OK) {
        return lua_error(L); // propagate compile error
    }

    // If a custom environment table is provided (arg 2), set it as _ENV
    if (lua_istable(L, 2)) {
        lua_pushvalue(L, 2);
        // Set as first upvalue (_ENV) of the loaded chunk
        const char* name = lua_setupvalue(L, -2, 1);
        if (!name) lua_pop(L, 1); // setupvalue failed, pop the table
    }

    // Execute the chunk
    int top = lua_gettop(L) - 1; // stack before the chunk
    if (lua_pcall(L, 0, LUA_MULTRET, 0) != LUA_OK) {
        return lua_error(L); // propagate runtime error
    }

    return lua_gettop(L) - top; // return all results
}

// ============================================================
// Register all VFS functions
// ============================================================

static const luaL_Reg vfsFuncs[] = {
    {"LoadFile",   l_LoadFile},
    {"FileExists", l_FileExists},
    {"DirList",    l_DirList},
    {"SubDirs",    l_SubDirs},
    {"Include",    l_Include},
    {nullptr, nullptr}
};

void LuaVFSSimple::Register(lua_State* L) {
    lua_newtable(L);
    luaL_setfuncs(L, vfsFuncs, 0);

    // Also add common VFS mode constants (ignored but maps reference them)
    lua_pushstring(L, ""); lua_setfield(L, -2, "RAW");
    lua_pushstring(L, ""); lua_setfield(L, -2, "MOD");
    lua_pushstring(L, ""); lua_setfield(L, -2, "MAP");
    lua_pushstring(L, ""); lua_setfield(L, -2, "BASE");
    lua_pushstring(L, ""); lua_setfield(L, -2, "GAME");
    lua_pushstring(L, ""); lua_setfield(L, -2, "MENU");

    lua_setglobal(L, "VFS");
}
