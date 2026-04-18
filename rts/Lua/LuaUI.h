/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * LuaUI stub — the client-side Lua UI system has been removed.
 * The server build only needs this header to satisfy references in
 * LuaHandle.cpp and LuaInterCall.cpp.  All methods are no-ops.
 */

#pragma once

#include "LuaHandle.h"
#include <string>

class CLuaUI : public CLuaHandle
{
public:
	bool ConfigureLayout(const std::string& /*msg*/) { return false; }
	bool RecvLuaMsg(const std::string& /*msg*/, int /*playerID*/) { return false; }
};

inline CLuaUI* luaUI = nullptr;
