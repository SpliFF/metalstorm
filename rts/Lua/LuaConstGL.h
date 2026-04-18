/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * LuaConstGL stub — OpenGL constants for Lua are client-side only.
 * The server build does not use GL; this header exists only to satisfy
 * the include in LuaHandleSynced.cpp.
 */

#pragma once

struct lua_State;

namespace LuaConstGL {
	inline bool PushEntries(lua_State* /*L*/) { return true; }
}
