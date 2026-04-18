#pragma once
// Server-build stub — platform constants not needed server-side.
struct lua_State;
namespace LuaConstPlatform {
	inline bool PushEntries(lua_State*) { return true; }
}
