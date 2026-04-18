#pragma once
// Server-build stub — UI command functions are client-side only.
struct lua_State;
namespace LuaUICommand {
	inline bool PushEntries(lua_State*) { return true; }
}
