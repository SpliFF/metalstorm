// LuaVFSSimple — registers VFS.* Lua functions backed by CFileHandler.
//
// Plain-directory VFS only (no sd7/sdz archive support).
// Provides: VFS.Include, VFS.LoadFile, VFS.FileExists, VFS.DirList, VFS.SubDirs
//
// Usage:
//   lua_State* L = luaL_newstate();
//   LuaVFSSimple::Register(L);
//   // Now Lua scripts can call VFS.Include("path/to/file.lua") etc.
#pragma once

struct lua_State;

namespace LuaVFSSimple {
    /// Register the VFS table into a Lua state.
    void Register(lua_State* L);
}
