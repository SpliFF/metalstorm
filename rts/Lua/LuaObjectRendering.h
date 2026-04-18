/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * LuaObjectRendering stub — rendering hooks for Lua are client-side only.
 * The server build does not perform rendering; this header exists only to
 * satisfy the include in LuaRules.cpp.
 */

#pragma once

struct lua_State;

namespace LuaObjectRendering {
	inline bool PushEntries(lua_State* /*L*/) { return true; }
}
