#pragma once
// Server-build stub — unsynced (client-side) control functions not used server-side.
struct lua_State;
namespace LuaUnsyncedCtrl {
	inline bool PushEntries(lua_State*) { return true; }
}
