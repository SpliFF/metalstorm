/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/**
 * LuaArchive — archive/VFS system has been removed from the server build.
 * All functions return empty/nil to Lua rather than crashing.
 */

#include "LuaArchive.h"
#include "LuaInclude.h"
#include "LuaHashString.h"
#include "LuaUtils.h"
#include "System/Log/ILog.h"

#include <string>


bool LuaArchive::PushEntries(lua_State* L)
{
	REGISTER_LUA_CFUNC(GetMaps);
	REGISTER_LUA_CFUNC(GetGames);
	REGISTER_LUA_CFUNC(GetAllArchives);
	REGISTER_LUA_CFUNC(HasArchive);
	REGISTER_LUA_CFUNC(GetLoadedArchives);

	REGISTER_LUA_CFUNC(GetArchivePath);
	REGISTER_LUA_CFUNC(GetArchiveInfo);
	REGISTER_LUA_CFUNC(GetArchiveDependencies);
	REGISTER_LUA_CFUNC(GetArchiveReplaces);

	REGISTER_LUA_CFUNC(GetArchiveChecksum);

	REGISTER_LUA_CFUNC(GetNameFromRapidTag);

	REGISTER_LUA_CFUNC(GetAvailableAIs);

	return true;
}


int LuaArchive::GetMaps(lua_State* L)
{
	// Archive system removed; return empty table
	lua_createtable(L, 0, 0);
	return 1;
}

int LuaArchive::GetGames(lua_State* L)
{
	lua_createtable(L, 0, 0);
	return 1;
}

int LuaArchive::GetAllArchives(lua_State* L)
{
	lua_createtable(L, 0, 0);
	return 1;
}

int LuaArchive::HasArchive(lua_State* L)
{
	lua_pushboolean(L, false);
	return 1;
}

int LuaArchive::GetLoadedArchives(lua_State* L)
{
	lua_createtable(L, 0, 0);
	return 1;
}

int LuaArchive::GetArchivePath(lua_State* L)
{
	return 0;
}

int LuaArchive::GetArchiveInfo(lua_State* L)
{
	return 0;
}

int LuaArchive::GetArchiveDependencies(lua_State* L)
{
	return 0;
}

int LuaArchive::GetArchiveReplaces(lua_State* L)
{
	return 0;
}

int LuaArchive::GetArchiveChecksum(lua_State* L)
{
	return 0;
}

int LuaArchive::GetNameFromRapidTag(lua_State* L)
{
	return 0;
}

int LuaArchive::GetAvailableAIs(lua_State* L)
{
	// ExternalAI system removed; return empty table
	lua_createtable(L, 0, 0);
	return 1;
}
