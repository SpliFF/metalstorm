#pragma once
// Server-build stub — unsynced (client-side) read functions not used server-side.
struct lua_State;
namespace LuaUnsyncedRead {
	inline bool PushEntries(lua_State*) { return true; }
}
