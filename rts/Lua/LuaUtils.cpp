/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

//#include "System/Platform/Win/win32.h"

#include <cmath>
#include <cstring>
#include <cctype>

#include "LuaUtils.h"
#include "LuaConfig.h"

#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "lua"

#include "Game/GameVersion.h"
#include "Sim/Projectiles/Projectile.h"
#include "Sim/Features/Feature.h"
#include "Sim/Features/FeatureDef.h"
#include "Sim/Objects/SolidObjectDef.h"
#include "Sim/Units/Unit.h"
#include "Sim/Units/UnitDef.h"
#include "Sim/Units/CommandAI/CommandDescription.h"
#include "Sim/Misc/LosHandler.h"
#include "System/FileSystem/FileSystem.h"
#include "System/Log/ILog.h"
#include "System/UnorderedMap.hpp"
#include "System/UnorderedSet.hpp"
#include "System/StringHash.h"
#include "System/StringUtil.h"

#if !defined UNITSYNC && !defined BUILDING_AI
	#include "System/TimeProfiler.h"
#else
	#define SCOPED_TIMER(x)
#endif


static const int maxDepth = 16;

// Json::Value LuaStackDumper removed — no jsoncpp on headless server

/******************************************************************************/
/******************************************************************************/


static bool CopyPushData(lua_State* dst, lua_State* src, int index, int depth, spring::unsynced_map<const void*, int>& alreadyCopied);
static bool CopyPushTable(lua_State* dst, lua_State* src, int index, int depth, spring::unsynced_map<const void*, int>& alreadyCopied);


static inline int PosAbsLuaIndex(lua_State* src, int index)
{
	if (index > 0)
		return index;

	return (lua_gettop(src) + index + 1);
}


static bool CopyPushData(lua_State* dst, lua_State* src, int index, int depth, spring::unsynced_map<const void*, int>& alreadyCopied)
{
	switch (lua_type(src, index)) {
		case LUA_TBOOLEAN: {
			lua_pushboolean(dst, lua_toboolean(src, index));
		} break;

		case LUA_TNUMBER: {
			lua_pushnumber(dst, lua_tonumber(src, index));
		} break;

		case LUA_TSTRING: {
			// get string (pointer)
			size_t len;
			const char* data = lua_tolstring(src, index, &len);

			// check cache
			auto it = alreadyCopied.find(data);
			if (it != alreadyCopied.end()) {
				lua_rawgeti(dst, LUA_REGISTRYINDEX, it->second);
				break;
			}

			// copy string
			lua_pushlstring(dst, data, len);

			// cache it
			lua_pushvalue(dst, -1);
			const int dstRef = luaL_ref(dst, LUA_REGISTRYINDEX);
			alreadyCopied[data] = dstRef;
		} break;

		case LUA_TTABLE: {
			CopyPushTable(dst, src, index, depth, alreadyCopied);
		} break;

		default: {
			lua_pushnil(dst); // unhandled type
			return false;
		}
	}

	return true;
}


static bool CopyPushTable(lua_State* dst, lua_State* src, int index, int depth, spring::unsynced_map<const void*, int>& alreadyCopied)
{
	const int table = PosAbsLuaIndex(src, index);

	// check cache
	const void* p = lua_topointer(src, table);
	auto it = alreadyCopied.find(p);
	if (it != alreadyCopied.end()) {
		lua_rawgeti(dst, LUA_REGISTRYINDEX, it->second);
		return true;
	}

	// check table depth
	if (depth++ > maxDepth) {
		LOG("CopyTable: reached max table depth '%i'", depth);
		lua_pushnil(dst); // push something
		return false;
	}

	// create new table
	const auto array_len = lua_objlen(src, table);
	lua_createtable(dst, array_len, 5);

	// cache it
	lua_pushvalue(dst, -1);
	const int dstRef = luaL_ref(dst, LUA_REGISTRYINDEX);
	alreadyCopied[p] = dstRef;

	// copy table entries
	for (lua_pushnil(src); lua_next(src, table) != 0; lua_pop(src, 1)) {
		CopyPushData(dst, src, -2, depth, alreadyCopied); // copy the key
		CopyPushData(dst, src, -1, depth, alreadyCopied); // copy the value
		lua_rawset(dst, -3);
	}

	return true;
}


int LuaUtils::CopyData(lua_State* dst, lua_State* src, int count)
{
	SCOPED_TIMER("Lua::CopyData");

	const int srcTop = lua_gettop(src);
	const int dstTop = lua_gettop(dst);
	if (srcTop < count) {
		LOG_L(L_ERROR, "LuaUtils::CopyData: tried to copy more data than there is");
		return 0;
	}
	lua_checkstack(dst, count + 3); // +3 needed for table copying
	lua_lock(src); // we need to be sure tables aren't changed while we iterate them

	// hold a map of all already copied tables in the lua's registry table
	// needed for recursive tables, i.e. "local t = {}; t[t] = t"
	// the order of traversal doesn't matter so we can use an unsynced map
	spring::unsynced_map<const void*, int> alreadyCopied;

	const int startIndex = (srcTop - count + 1);
	const int endIndex   = srcTop;
	for (int i = startIndex; i <= endIndex; i++) {
		CopyPushData(dst, src, i, 0, alreadyCopied);
	}

	// clear map
	for (auto& pair: alreadyCopied) {
		luaL_unref(dst, LUA_REGISTRYINDEX, pair.second);
	}

	const int curSrcTop = lua_gettop(src);
	assert(srcTop == curSrcTop);
	lua_settop(dst, dstTop + count);
	lua_unlock(src);
	return count;
}

/******************************************************************************/
/******************************************************************************/

// The functions below are not used anymore for anything in the engine.
// There are left behind here disabled for archival purposes.
#if 0

int LuaUtils::exportedDataSize = 0;

static bool BackupData(LuaUtils::DataDump& d, lua_State* src, int index, int depth);
static bool RestoreData(const LuaUtils::DataDump& d, lua_State* dst, int depth);
static bool BackupTable(LuaUtils::DataDump& d, lua_State* src, int index, int depth);
static bool RestoreTable(const LuaUtils::DataDump& d, lua_State* dst, int depth);


static bool BackupData(LuaUtils::DataDump& d, lua_State* src, int index, int depth) {
	++LuaUtils::exportedDataSize;
	const int type = lua_type(src, index);
	d.type = type;
	switch (type) {
		case LUA_TBOOLEAN: {
			d.bol = lua_toboolean(src, index);
			break;
		}
		case LUA_TNUMBER: {
			d.num = lua_tonumber(src, index);
			break;
		}
		case LUA_TSTRING: {
			size_t len = 0;
			const char* data = lua_tolstring(src, index, &len);
			if (len > 0) {
				d.str.resize(len);
				memcpy(&d.str[0], data, len);
			}
			break;
		}
		case LUA_TTABLE: {
			if (!BackupTable(d, src, index, depth))
				d.type = LUA_TNIL;
			break;
		}
		default: {
			d.type = LUA_TNIL;
			break;
		}
	}
	return true;
}

static bool RestoreData(const LuaUtils::DataDump& d, lua_State* dst, int depth) {
	--LuaUtils::exportedDataSize;

	switch (d.type) {
		case LUA_TBOOLEAN: {
			lua_pushboolean(dst, d.bol);
		} break;

		case LUA_TNUMBER: {
			lua_pushnumber(dst, d.num);
		} break;

		case LUA_TSTRING: {
			lua_pushlstring(dst, d.str.c_str(), d.str.size());
		} break;

		case LUA_TTABLE: {
			RestoreTable(d, dst, depth);
		} break;

		default: {
			lua_pushnil(dst);
		} break;
	}

	return true;
}

static bool BackupTable(LuaUtils::DataDump& d, lua_State* src, int index, int depth) {
	if (depth++ > maxDepth)
		return false;

	const int tableIdx = PosAbsLuaIndex(src, index);
	for (lua_pushnil(src); lua_next(src, tableIdx) != 0; lua_pop(src, 1)) {
		LuaUtils::DataDump dk, dv;
		BackupData(dk, src, -2, depth);
		BackupData(dv, src, -1, depth);
		d.table.emplace_back(dk ,dv);
	}

	return true;
}

static bool RestoreTable(const LuaUtils::DataDump& d, lua_State* dst, int depth) {
	if (depth++ > maxDepth) {
		lua_pushnil(dst);
		return false;
	}

	lua_newtable(dst);
	for (const auto& di: d.table) {
		RestoreData(di.first, dst, depth);
		RestoreData(di.second, dst, depth);
		lua_rawset(dst, -3);
	}

	return true;
}


int LuaUtils::Backup(std::vector<LuaUtils::DataDump>& backup, lua_State* src, int count) {
	const int srcTop = lua_gettop(src);
	if (srcTop < count)
		return 0;

	const int startIndex = (srcTop - count + 1);
	const int endIndex   = srcTop;
	for (int i = startIndex; i <= endIndex; i++) {
		backup.emplace_back();
		BackupData(backup.back(), src, i, 0);
	}

	return count;
}


int LuaUtils::Restore(const std::vector<LuaUtils::DataDump>& backup, lua_State* dst) {
	const int dstTop = lua_gettop(dst);
	int count = backup.size();
	lua_checkstack(dst, count + 3);

	for (const auto& dd: backup) {
		RestoreData(dd, dst, 0);
	}
	lua_settop(dst, dstTop + count);

	return count;
}

#endif

/******************************************************************************/
/******************************************************************************/

static void PushCurrentFunc(lua_State* L, const char* caller)
{
	// get the current function
	lua_Debug ar;
	if (lua_getstack(L, 1, &ar) == 0)
		luaL_error(L, "%s() lua_getstack() error", caller);

	if (lua_getinfo(L, "f", &ar) == 0)
		luaL_error(L, "%s() lua_getinfo() error", caller);

	if (!lua_isfunction(L, -1))
		luaL_error(L, "%s() invalid current function", caller);
}


static void PushFunctionEnv(lua_State* L, const char* caller, int funcIndex)
{
	lua_getfenv(L, funcIndex);

	// If the fenv isn't even a table yet — e.g. the caller is a C
	// closure whose first upvalue is something other than a table, or
	// a Lua 5.4 function compiled without any captured globals so it
	// has no _ENV upvalue at all — fall back to the globals table.
	// This matches what Lua 5.1's `getfenv` would have returned for
	// a C function and keeps gadgets.lua's `loadstring(code, name)`
	// path working when the caller doesn't have a classical fenv.
	// This is a normal fallback, not an error, so it's silent.
	if (!lua_istable(L, -1)) {
		lua_pop(L, 1);
		lua_pushglobaltable(L);
	}

	lua_pushliteral(L, "__fenv");
	lua_rawget(L, -2);
	if (lua_isnil(L, -1)) {
		lua_pop(L, 1); // there is no fenv proxy
	} else {
		lua_remove(L, -2); // remove the orig table, leave the proxy
	}

	if (!lua_istable(L, -1)) {
		// This should now be unreachable given the fallback above,
		// but keep the check as a belt-and-braces assertion so we
		// never pass a non-table to lua_setfenv.
		SLOG(SPRING_LOG_ERROR,
			"%s(): __fenv proxy resolved to a %s, not a table",
			caller, luaL_typename(L, -1));
		luaL_error(L, "%s() invalid fenv", caller);
	}
}


void LuaUtils::PushCurrentFuncEnv(lua_State* L, const char* caller)
{
	PushCurrentFunc(L, caller);
	PushFunctionEnv(L, caller, -1);
	lua_remove(L, -2); // remove the function
}

/******************************************************************************/
/******************************************************************************/

static void LowerKeysReal(lua_State* L, spring::unsynced_set<const void*>& checkedSet)
{
	luaL_checkstack(L, 8, __func__);

	const int  sourceTableIdx = lua_gettop(L);
	const int changedTableIdx = sourceTableIdx + 1;

	{
		const void* p = lua_topointer(L, sourceTableIdx);
		if (checkedSet.find(p) != checkedSet.end())
			return;

		checkedSet.insert(p);
	}

	// a new table for changed values
	lua_newtable(L);

	for (lua_pushnil(L); lua_next(L, sourceTableIdx) != 0; lua_pop(L, 1)) {
		if (lua_istable(L, -1))
			LowerKeysReal(L, checkedSet);

		if (!lua_israwstring(L, -2))
			continue;

		const string rawKey = lua_tostring(L, -2);
		const string lowerKey = StringToLower(rawKey);

		if (rawKey == lowerKey)
			continue;

		// removed the mixed case entry
		lua_pushvalue(L, -2); // the key
		lua_pushnil(L);
		lua_rawset(L, sourceTableIdx);
		// does the lower case key alread exist in the table?
		lua_pushsstring(L, lowerKey);
		lua_rawget(L, sourceTableIdx);

		if (lua_isnil(L, -1)) {
			// lower case does not exist, add it to the changed table
			lua_pushsstring(L, lowerKey);
			lua_pushvalue(L, -3); // the value
			lua_rawset(L, changedTableIdx);
		}

		lua_pop(L, 1);
	}

	// copy the changed values into the table
	for (lua_pushnil(L); lua_next(L, changedTableIdx) != 0; lua_pop(L, 1)) {
		lua_pushvalue(L, -2); // copy the key to the top
		lua_pushvalue(L, -2); // copy the value to the top
		lua_rawset(L, sourceTableIdx);
	}

	lua_pop(L, 1); // pop the changed table
}


bool LuaUtils::LowerKeys(lua_State* L, int table)
{
	if (!lua_istable(L, table))
		return false;

	// table of processed tables
	spring::unsynced_set<const void*> checkedSet;
	luaL_checkstack(L, 1, __func__);

	lua_pushvalue(L, table); // push the table onto the top of the stack
	LowerKeysReal(L, checkedSet);

	lua_pop(L, 1); // the lowered table, and the check table
	return true;
}


static bool CheckForNaNsReal(lua_State* L, const std::string& path)
{
	luaL_checkstack(L, 3, __func__);
	const int table = lua_gettop(L);
	bool foundNaNs = false;

	for (lua_pushnil(L); lua_next(L, table) != 0; lua_pop(L, 1)) {
		if (lua_istable(L, -1)) {
			// We can't work on -2 directly cause lua_tostring would replace the value in -2,
			// so we need to make a copy and convert that to a string.
			lua_pushvalue(L, -2);
			const char* key = lua_tostring(L, -1);
			const std::string subpath = path + key + ".";
			lua_pop(L, 1);

			foundNaNs |= CheckForNaNsReal(L, subpath);
			continue;
		}

		if (!lua_isnumber(L, -1))
			continue;

		// Check for NaN
		const float value = lua_tonumber(L, -1);
		if (!math::isinf(value) && !math::isnan(value))
			continue;

		// can't work on -2 directly (lua_tostring would replace the value)
		// so we need to make a copy and convert that to a string
		lua_pushvalue(L, -2);
		const char* key = lua_tostring(L, -1);
		LOG_L(L_WARNING, "%s%s: Got Invalid NaN/Inf!", path.c_str(), key);
		lua_pop(L, 1);

		foundNaNs = true;
	}

	return foundNaNs;
}


bool LuaUtils::CheckTableForNaNs(lua_State* L, int table, const std::string& name)
{
	if (!lua_istable(L, table))
		return false;

	luaL_checkstack(L, 2, __func__);

	// table of processed tables
	lua_newtable(L);
	// push the table onto the top of the stack
	lua_pushvalue(L, table);

	const bool foundNaNs = CheckForNaNsReal(L, name + ": ");

	lua_pop(L, 2); // the lowered table, and the check table

	return foundNaNs;
}


/******************************************************************************/
/******************************************************************************/

// copied from lua/src/lauxlib.cpp:luaL_checkudata()
void* LuaUtils::GetUserData(lua_State* L, int index, const string& type)
{
	const char* tname = type.c_str();
	void *p = lua_touserdata(L, index);
	if (p != nullptr) {                               // value is a userdata?
		if (lua_getmetatable(L, index)) {            // does it have a metatable?
			lua_getfield(L, LUA_REGISTRYINDEX, tname); // get correct metatable
			if (lua_rawequal(L, -1, -2)) {             // the correct mt?
				lua_pop(L, 2);                           // remove both metatables
				return p;
			}
		}
	}
	return nullptr;
}


/******************************************************************************/
/******************************************************************************/

int LuaUtils::IsEngineMinVersion(lua_State* L)
{
	const int minMajorVer = luaL_checkint(L, 1);
	const int minMinorVer = luaL_optint(L, 2, 0);
	const int minCommits  = luaL_optint(L, 3, 0);

	if (StringToInt(SpringVersion::GetMajor()) < minMajorVer) {
		lua_pushboolean(L, false);
		return 1;
	}

	if (StringToInt(SpringVersion::GetMajor()) == minMajorVer) {
		if (StringToInt(SpringVersion::GetMinor()) < minMinorVer) {
			lua_pushboolean(L, false);
			return 1;
		}

		if (StringToInt(SpringVersion::GetCommits()) < minCommits) {
			lua_pushboolean(L, false);
			return 1;
		}
	}

	lua_pushboolean(L, true);
	return 1;

}

/******************************************************************************/
/******************************************************************************/

int LuaUtils::ParseIntArray(lua_State* L, int index, int* array, int size)
{
	if (!lua_istable(L, index))
		return -1;

	for (int i = 0, absIdx = PosAbsLuaIndex(L, index); i < size; i++) {
		lua_rawgeti(L, absIdx, (i + 1));

		if (lua_isnumber(L, -1)) {
			array[i] = lua_toint(L, -1);
			lua_pop(L, 1);
		} else {
			lua_pop(L, 1);
			return i;
		}
	}

	return size;
}

int LuaUtils::ParseFloatArray(lua_State* L, int index, float* array, int size)
{
	if (!lua_istable(L, index))
		return -1;

	for (int i = 0, absIdx = PosAbsLuaIndex(L, index); i < size; i++) {
		lua_rawgeti(L, absIdx, (i + 1));

		if (lua_isnumber(L, -1)) {
			array[i] = lua_tofloat(L, -1);
			lua_pop(L, 1);
		} else {
			lua_pop(L, 1);
			return i;
		}
	}

	return size;
}

int LuaUtils::ParseStringArray(lua_State* L, int index, string* array, int size)
{
	if (!lua_istable(L, index))
		return -1;

	for (int i = 0, absIdx = PosAbsLuaIndex(L, index); i < size; i++) {
		lua_rawgeti(L, absIdx, (i + 1));

		if (lua_isstring(L, -1)) {
			array[i] = lua_tostring(L, -1);
			lua_pop(L, 1);
		} else {
			lua_pop(L, 1);
			return i;
		}
	}

	return size;
}

int LuaUtils::ParseIntVector(lua_State* L, int index, vector<int>& vec)
{
	if (!lua_istable(L, index))
		return -1;

	vec.clear();

	for (int i = 0, absIdx = PosAbsLuaIndex(L, index); ; i++) {
		lua_rawgeti(L, absIdx, (i + 1));

		if (lua_isnumber(L, -1)) {
			vec.push_back(lua_toint(L, -1));
			lua_pop(L, 1);
			continue;
		}

		lua_pop(L, 1);
		return i;
	}
}

int LuaUtils::ParseFloatVector(lua_State* L, int index, vector<float>& vec)
{
	if (!lua_istable(L, index))
		return -1;

	vec.clear();

	for (int i = 0, absIdx = PosAbsLuaIndex(L, index); ; i++) {
		lua_rawgeti(L, absIdx, (i + 1));

		if (lua_isnumber(L, -1)) {
			vec.push_back(lua_tofloat(L, -1));
			lua_pop(L, 1);
			continue;
		}

		lua_pop(L, 1);
		return i;
	}
}

int LuaUtils::ParseStringVector(lua_State* L, int index, vector<string>& vec)
{
	if (!lua_istable(L, index))
		return -1;

	vec.clear();

	for (int i = 0, absIdx = PosAbsLuaIndex(L, index); ; i++) {
		lua_rawgeti(L, absIdx, (i + 1));

		if (lua_isstring(L, -1)) {
			vec.emplace_back(lua_tostring(L, -1));
			lua_pop(L, 1);
			continue;
		}

		lua_pop(L, 1);
		return i;
	}
}


#if !defined UNITSYNC && !defined BUILDING_AI


int LuaUtils::PushModelHeight(lua_State* L, const SolidObjectDef* def, bool isUnitDef)
{
	// The server doesn't render but still loads each unit's piece tree from
	// the gltf SPRINGRTS_geometry extension (see SolidObjectDef::LoadModel),
	// which carries radius/height. ZK's unit_centeroffset.lua reads ud.height
	// to seed Spring.SetUnitRadiusAndHeight; returning 0 here leaves projectile
	// collision volumes 1 elmo tall and the target unhittable.
	const S3DModel* m = (def != nullptr) ? def->LoadModel() : nullptr;
	lua_pushnumber(L, (m != nullptr) ? m->height : 0.0f);
	return 1;
}

int LuaUtils::PushModelRadius(lua_State* L, const SolidObjectDef* def, bool isUnitDef)
{
	const S3DModel* m = (def != nullptr) ? def->LoadModel() : nullptr;
	lua_pushnumber(L, (m != nullptr) ? m->radius : 0.0f);
	return 1;
}

int LuaUtils::PushFeatureModelDrawType(lua_State* L, const FeatureDef* def)
{
	switch (def->drawType) {
		case DRAWTYPE_NONE:  { HSTR_PUSH(L,  "none"); } break;
		case DRAWTYPE_MODEL: { HSTR_PUSH(L, "model"); } break;
		default:             { HSTR_PUSH(L,  "tree"); } break;
	}

	return 1;
}

int LuaUtils::PushModelName(lua_State* L, const SolidObjectDef* def)
{
	lua_pushsstring(L, def->modelName);
	return 1;
}

int LuaUtils::PushModelType(lua_State* L, const SolidObjectDef* def)
{
	// Model loading removed server-side; type not available
	lua_pushsstring(L, std::string{});
	return 1;
}

int LuaUtils::PushModelPath(lua_State* L, const SolidObjectDef* def)
{
	// Model loading removed server-side; path not available
	lua_pushsstring(L, def->modelName);
	return 1;
}


int LuaUtils::PushModelTable(lua_State* L, const SolidObjectDef* def) {
	// Pull bounds + midpos from the loaded model (SPRINGRTS_geometry extension
	// in the .gltf). ZK's unit_centeroffset.lua reads `ud.model.midx/midy/midz`
	// and feeds it straight into Spring.SetUnitMidAndAimPos — zero here leaves
	// every unit's mid/aim sitting at its foot, which both breaks the visible
	// aim point and (more importantly) parks the cylinder/sphere collision
	// volume below the unit so projectiles fly straight through.
	lua_newtable(L);

	const S3DModel* m = (def != nullptr) ? def->LoadModel() : nullptr;
	if (m != nullptr) {
		HSTR_PUSH_NUMBER(L, "minx", m->mins.x);
		HSTR_PUSH_NUMBER(L, "miny", m->mins.y);
		HSTR_PUSH_NUMBER(L, "minz", m->mins.z);
		HSTR_PUSH_NUMBER(L, "maxx", m->maxs.x);
		HSTR_PUSH_NUMBER(L, "maxy", m->maxs.y);
		HSTR_PUSH_NUMBER(L, "maxz", m->maxs.z);

		HSTR_PUSH_NUMBER(L, "midx", m->relMidPos.x);
		HSTR_PUSH_NUMBER(L, "midy", m->relMidPos.y);
		HSTR_PUSH_NUMBER(L, "midz", m->relMidPos.z);
	} else {
		HSTR_PUSH_NUMBER(L, "minx", 0.0f);
		HSTR_PUSH_NUMBER(L, "miny", 0.0f);
		HSTR_PUSH_NUMBER(L, "minz", 0.0f);
		HSTR_PUSH_NUMBER(L, "maxx", 0.0f);
		HSTR_PUSH_NUMBER(L, "maxy", 0.0f);
		HSTR_PUSH_NUMBER(L, "maxz", 0.0f);

		HSTR_PUSH_NUMBER(L, "midx", 0.0f);
		HSTR_PUSH_NUMBER(L, "midy", 0.0f);
		HSTR_PUSH_NUMBER(L, "midz", 0.0f);
	}

	HSTR_PUSH(L, "textures");
	lua_newtable(L);
	// model["textures"] = {} (rendering-side concept; not used on server)
	lua_rawset(L, -3);

	return 1;
}

int LuaUtils::PushColVolTable(lua_State* L, const CollisionVolume* vol) {
	assert(vol != nullptr);

	lua_createtable(L, 0, 11);
	switch (vol->GetVolumeType()) {
		case CollisionVolume::COLVOL_TYPE_ELLIPSOID:
			HSTR_PUSH_CSTRING(L, "type", "ellipsoid");
			break;
		case CollisionVolume::COLVOL_TYPE_CYLINDER:
			HSTR_PUSH_CSTRING(L, "type", "cylinder");
			break;
		case CollisionVolume::COLVOL_TYPE_BOX:
			HSTR_PUSH_CSTRING(L, "type", "box");
			break;
		case CollisionVolume::COLVOL_TYPE_SPHERE:
			HSTR_PUSH_CSTRING(L, "type", "sphere");
			break;
	}

	LuaPushNamedNumber(L, "scaleX", vol->GetScales().x);
	LuaPushNamedNumber(L, "scaleY", vol->GetScales().y);
	LuaPushNamedNumber(L, "scaleZ", vol->GetScales().z);
	LuaPushNamedNumber(L, "offsetX", vol->GetOffsets().x);
	LuaPushNamedNumber(L, "offsetY", vol->GetOffsets().y);
	LuaPushNamedNumber(L, "offsetZ", vol->GetOffsets().z);
	LuaPushNamedNumber(L, "boundingRadius", vol->GetBoundingRadius());
	LuaPushNamedBool(L, "defaultToSphere",    vol->DefaultToSphere());
	LuaPushNamedBool(L, "defaultToFootPrint", vol->DefaultToFootPrint());
	LuaPushNamedBool(L, "defaultToPieceTree", vol->DefaultToPieceTree());
	return 1;
}

int LuaUtils::PushColVolData(lua_State* L, const CollisionVolume* vol) {
	lua_pushnumber(L, vol->GetScales().x);
	lua_pushnumber(L, vol->GetScales().y);
	lua_pushnumber(L, vol->GetScales().z);
	lua_pushnumber(L, vol->GetOffsets().x);
	lua_pushnumber(L, vol->GetOffsets().y);
	lua_pushnumber(L, vol->GetOffsets().z);
	lua_pushnumber(L, vol->GetVolumeType());
	lua_pushnumber(L, int(vol->UseContHitTest()));
	lua_pushnumber(L, vol->GetPrimaryAxis());
	lua_pushboolean(L, vol->IgnoreHits());
	return 10;
}


int LuaUtils::ParseColVolData(lua_State* L, int idx, CollisionVolume* vol)
{
	const float xs = luaL_checkfloat(L, idx++);
	const float ys = luaL_checkfloat(L, idx++);
	const float zs = luaL_checkfloat(L, idx++);
	const float xo = luaL_checkfloat(L, idx++);
	const float yo = luaL_checkfloat(L, idx++);
	const float zo = luaL_checkfloat(L, idx++);
	const int vType = luaL_checkint (L, idx++);
	const int tType = luaL_checkint (L, idx++);
	const int pAxis = luaL_checkint (L, idx++);

	const float3 scales(xs, ys, zs);
	const float3 offsets(xo, yo, zo);

	vol->InitShape(scales, offsets, vType, tType, pAxis);
	return 0;
}


#endif //!defined UNITSYNC && !defined BUILDING_AI


void LuaUtils::PushCommandParamsTable(lua_State* L, const Command& cmd, bool subtable)
{
	if (subtable)
		HSTR_PUSH(L, "params");

	lua_createtable(L, cmd.GetNumParams(), 0);

	for (unsigned int p = 0; p < cmd.GetNumParams(); p++) {
		lua_pushnumber(L, cmd.GetParam(p));
		lua_rawseti(L, -2, p + 1);
	}

	if (subtable)
		lua_rawset(L, -3);
}

void LuaUtils::PushCommandOptionsTable(lua_State* L, const Command& cmd, bool subtable)
{
	if (subtable)
		HSTR_PUSH(L, "options");

	lua_createtable(L, 0, 7);
	HSTR_PUSH_NUMBER(L, "coded", cmd.GetOpts());
	HSTR_PUSH_BOOL(L, "alt",      !!(cmd.GetOpts() & ALT_KEY        ));
	HSTR_PUSH_BOOL(L, "ctrl",     !!(cmd.GetOpts() & CONTROL_KEY    ));
	HSTR_PUSH_BOOL(L, "shift",    !!(cmd.GetOpts() & SHIFT_KEY      ));
	HSTR_PUSH_BOOL(L, "right",    !!(cmd.GetOpts() & RIGHT_MOUSE_KEY));
	HSTR_PUSH_BOOL(L, "meta",     !!(cmd.GetOpts() & META_KEY       ));
	HSTR_PUSH_BOOL(L, "internal", !!(cmd.GetOpts() & INTERNAL_ORDER ));

	if (subtable)
		lua_rawset(L, -3);
}

int LuaUtils::PushUnitAndCommand(lua_State* L, const CUnit* unit, const Command& cmd)
{
	lua_pushnumber(L, unit->id);
	lua_pushnumber(L, unit->unitDef->id);
	lua_pushnumber(L, unit->team);

	lua_pushnumber(L, cmd.GetID());

	PushCommandParamsTable(L, cmd, false);
	PushCommandOptionsTable(L, cmd, false);

	lua_pushnumber(L, cmd.GetTag());
	return 7;
}


static bool ParseCommandOptions(
	lua_State* L,
	Command& cmd,
	const char* caller,
	const int idx
) {
	if (lua_isnumber(L, idx)) {
		cmd.SetOpts(lua_tonumber(L, idx));
		return true;
	}

	if (lua_istable(L, idx)) {
		for (lua_pushnil(L); lua_next(L, idx) != 0; lua_pop(L, 1)) {
			// "key" = value (table format of CommandNotify)
			// ignore the "coded" key; not a boolean value
			if (lua_israwstring(L, -2)) {
				if (!lua_isboolean(L, -1))
					continue;

				const bool value = lua_toboolean(L, -1);

				switch (hashString(lua_tostring(L, -2))) {
					case hashString("right"): {
						cmd.SetOpts(cmd.GetOpts() | (RIGHT_MOUSE_KEY * value));
					} break;
					case hashString("alt"): {
						cmd.SetOpts(cmd.GetOpts() | (ALT_KEY * value));
					} break;
					case hashString("ctrl"): {
						cmd.SetOpts(cmd.GetOpts() | (CONTROL_KEY * value));
					} break;
					case hashString("shift"): {
						cmd.SetOpts(cmd.GetOpts() | (SHIFT_KEY * value));
					} break;
					case hashString("meta"): {
						cmd.SetOpts(cmd.GetOpts() | (META_KEY * value));
					} break;
				}

				continue;
			}

			// [idx] = "value", avoid 'n'
			if (lua_israwnumber(L, -2)) {
				if (!lua_isstring(L, -1))
					continue;

				switch (hashString(lua_tostring(L, -1))) {
					case hashString("right"): {
						cmd.SetOpts(cmd.GetOpts() | RIGHT_MOUSE_KEY);
					} break;
					case hashString("alt"): {
						cmd.SetOpts(cmd.GetOpts() | ALT_KEY);
					} break;
					case hashString("ctrl"): {
						cmd.SetOpts(cmd.GetOpts() | CONTROL_KEY);
					} break;
					case hashString("shift"): {
						cmd.SetOpts(cmd.GetOpts() | SHIFT_KEY);
					} break;
					case hashString("meta"): {
						cmd.SetOpts(cmd.GetOpts() | META_KEY);
					} break;
				}
			}
		}

		return true;
	}

	luaL_error(L, "%s(): bad options-argument type", caller);
	return false;
}

static bool ParseCommandTimeOut(
	lua_State* L,
	Command& cmd,
	const char* caller,
	const int idx
) {
	if (!lua_isnumber(L, idx))
		return false;

	cmd.SetTimeOut(lua_tonumber(L, idx));
	return true;
}

Command LuaUtils::ParseCommand(lua_State* L, const char* caller, int idIndex)
{
	// cmdID
	if (!lua_isnumber(L, idIndex))
		luaL_error(L, "%s(): bad command ID", caller);

	Command cmd(lua_toint(L, idIndex));

	{
		// params
		const int paramTableIdx = idIndex + 1;

		if (lua_isnumber(L, paramTableIdx)) {
			cmd.PushParam(lua_tofloat(L, paramTableIdx));
		} else if (lua_istable(L, paramTableIdx)) {
			for (lua_pushnil(L); lua_next(L, paramTableIdx) != 0; lua_pop(L, 1)) {
				if (!lua_israwnumber(L, -2))
					continue; // avoid 'n'

				if (!lua_isnumber(L, -1))
					luaL_error(L, "%s(): expected <number idx=%d, number value> in params-table", caller, lua_tonumber(L, -2));

				cmd.PushParam(lua_tofloat(L, -1));
			}
		} else {
			luaL_error(L, "%s(): bad param (expected table or number)", caller);
		}
	}

	// options
	ParseCommandOptions(L, cmd, caller, idIndex + 2);
	// timeout
	ParseCommandTimeOut(L, cmd, caller, idIndex + 3);

	// XXX should do some sanity checking?
	return cmd;
}


Command LuaUtils::ParseCommandTable(lua_State* L, const char* caller, int tableIdx)
{
	// cmdID
	lua_rawgeti(L, tableIdx, 1);

	if (!lua_isnumber(L, -1))
		luaL_error(L, "%s(): bad command ID", caller);

	Command cmd(lua_toint(L, -1));
	lua_pop(L, 1);

	{
		// params
		lua_rawgeti(L, tableIdx, 2);

		if (lua_isnumber(L, -1)) {
			cmd.PushParam(lua_tofloat(L, -1));
		} else if (lua_istable(L, -1)) {
			const int paramTableIdx = lua_gettop(L);

			for (lua_pushnil(L); lua_next(L, paramTableIdx) != 0; lua_pop(L, 1)) {
				if (!lua_israwnumber(L, -2))
					continue; // avoid 'n'

				if (!lua_isnumber(L, -1))
					luaL_error(L, "%s(): bad param table entry", caller);

				cmd.PushParam(lua_tofloat(L, -1));
			}
		} else {
			luaL_error(L, "%s(): bad param (expected table or number)", caller);
		}

		lua_pop(L, 1);
	}

	{
		// options
		lua_rawgeti(L, tableIdx, 3);
		ParseCommandOptions(L, cmd, caller, lua_gettop(L));
		lua_pop(L, 1);
	}
	{
		// timeout
		lua_rawgeti(L, tableIdx, 4);
		ParseCommandTimeOut(L, cmd, caller, lua_gettop(L));
		lua_pop(L, 1);
	}

	// XXX should do some sanity checking?
	return cmd;
}


void LuaUtils::ParseCommandArray(
	lua_State* L,
	const char* caller,
	int tableIdx,
	std::vector<Command>& commands
) {
	if (!lua_istable(L, tableIdx))
		luaL_error(L, "%s(): error parsing command array", caller);

	for (lua_pushnil(L); lua_next(L, tableIdx) != 0; lua_pop(L, 1)) {
		if (!lua_istable(L, -1))
			continue;

		commands.emplace_back(ParseCommandTable(L, caller, lua_gettop(L)));
	}
}


int LuaUtils::ParseFacing(lua_State* L, const char* caller, int index)
{
	if (lua_israwnumber(L, index))
		return std::max(0, std::min(3, lua_toint(L, index)));

	if (lua_israwstring(L, index)) {
		const char* dir = lua_tostring(L, index);

		switch (dir[0]) {
			case 'S': case 's': { return 0; } break;
			case 'E': case 'e': { return 1; } break;
			case 'N': case 'n': { return 2; } break;
			case 'W': case 'w': { return 3; } break;
			default           : {           } break;
		}

		luaL_error(L, "%s(): bad facing string \"%s\"", caller, dir);
	}

	luaL_error(L, "%s(): bad facing parameter", caller);
	return 0;
}


/******************************************************************************/
/******************************************************************************/


int LuaUtils::Next(const ParamMap& paramMap, lua_State* L)
{
	luaL_checktype(L, 1, LUA_TTABLE);
	lua_settop(L, 2); // create a 2nd argument if there isn't one

	// internal parameters first
	if (lua_isnoneornil(L, 2)) {
		const string& nextKey = paramMap.begin()->first;
		lua_pushsstring(L, nextKey); // push the key
		lua_pushvalue(L, 3);         // copy the key
		lua_gettable(L, 1);          // get the value
		return 2;
	}

	// all internal parameters use strings as keys
	if (lua_isstring(L, 2)) {
		const char* key = lua_tostring(L, 2);
		ParamMap::const_iterator it = paramMap.find(key);
		if ((it != paramMap.end()) && (it->second.type != READONLY_TYPE)) {
			// last key was an internal parameter
			++it;
			while ((it != paramMap.end()) && (it->second.type == READONLY_TYPE || it->second.deprecated)) {
				++it; // skip read-only and deprecated/error parameters
			}
			if ((it != paramMap.end()) && (it->second.type != READONLY_TYPE)) {
				// next key is an internal parameter
				const string& nextKey = it->first;
				lua_pushsstring(L, nextKey); // push the key
				lua_pushvalue(L, 3);         // copy the key
				lua_gettable(L, 1);          // get the value (proxied)
				return 2;
			}
			// start the user parameters,
			// remove the internal key and push a nil
			lua_settop(L, 1);
			lua_pushnil(L);
		}
	}

	// user parameter
	if (lua_next(L, 1))
		return 2;

	// end of the line
	lua_pushnil(L);
	return 1;
}


/******************************************************************************/
/******************************************************************************/

static void LogMsg(lua_State* L, const char* logSection, int logLevel, int argIndex)
{
	// mostly copied from lua/src/lbaselib.cpp
	std::string msg;

	const int numArgs = lua_gettop(L);

	// rely on Lua's own number formatting
	lua_getglobal(L, "tostring");

	if (numArgs != argIndex || !lua_istable(L, argIndex)) {
		// print individual args
		for (int i = argIndex; i <= numArgs; i++) {
			lua_pushvalue(L, -1);     // function to be called
			lua_pushvalue(L, i);      // value to print
			lua_pcall(L, 1, 1, 0);

			const char* s = lua_tostring(L, -1);  // get result

			if (i > argIndex)
				msg += ", ";
			if (s != nullptr)
				msg += s;

			lua_pop(L, 1);            // pop result
		}
	} else {
		// print table values (array style)
		msg = "TABLE: ";

		for (lua_pushnil(L); lua_next(L, argIndex) != 0; lua_pop(L, 1)) {
			if (!lua_israwnumber(L, -2)) // only numeric keys
				continue;

			lua_pushvalue(L, -3);    // function to be called
			lua_pushvalue(L, -2);    // value to print
			lua_pcall(L, 1, 1, 0);

			const char* s = lua_tostring(L, -1);  // get result

			if ((msg.size() + 1) > sizeof("TABLE: "))
				msg += ", ";
			if (s != nullptr)
				msg += s;

			lua_pop(L, 1);            // pop result
		}
	}

	if (logSection == nullptr) {
		LOG("%s", msg.c_str());
	} else {
		LOG_SI(logSection, logLevel, "%s", msg.c_str());
	}
}


int LuaUtils::Echo(lua_State* L)
{
	LogMsg(L, nullptr, -1, 1);
	return 0;
}


bool LuaUtils::PushLogEntries(lua_State* L)
{
#define PUSH_LOG_LEVEL(cmd) LuaPushNamedNumber(L, #cmd, LOG_LEVEL_ ## cmd)
	PUSH_LOG_LEVEL(DEBUG);
	PUSH_LOG_LEVEL(INFO);
	PUSH_LOG_LEVEL(NOTICE);
	PUSH_LOG_LEVEL(WARNING);
	PUSH_LOG_LEVEL(ERROR);
	PUSH_LOG_LEVEL(FATAL);
	return true;
}

int LuaUtils::ParseLogLevel(lua_State* L, int index)
{
	if (lua_israwnumber(L, index))
		return (lua_tonumber(L, index));

	if (lua_israwstring(L, index)) {
		switch (lua_tostring(L, index)[0]) {
			case 'D': case 'd': { return LOG_LEVEL_DEBUG  ; } break;
			case 'I': case 'i': { return LOG_LEVEL_INFO   ; } break;
			case 'N': case 'n': { return LOG_LEVEL_NOTICE ; } break;
			case 'W': case 'w': { return LOG_LEVEL_WARNING; } break;
			case 'E': case 'e': { return LOG_LEVEL_ERROR  ; } break;
			case 'F': case 'f': { return LOG_LEVEL_FATAL  ; } break;
			default           : {                           } break;
		}
	}

	return -1;
}

/*-
	Logs a msg to the logfile / console
	@param loglevel loglevel that will be used for the message
	@param msg string to be logged
	@fn Spring.Log(string logsection, int loglevel, ...)
	@fn Spring.Log(string logsection, string loglevel, ...)
*/
int LuaUtils::Log(lua_State* L)
{
	const int args = lua_gettop(L); // number of arguments
	if (args < 3)
		return luaL_error(L, "Incorrect arguments to Spring.Log(logsection, loglevel, ...)");

	const char* section = luaL_checkstring(L, 1);

	const int loglevel = LuaUtils::ParseLogLevel(L, 2);
	if (loglevel < 0)
		return luaL_error(L, "Incorrect arguments to Spring.Log(logsection, loglevel, ...)");

	LogMsg(L, section, loglevel, 3);
	return 0;
}

/******************************************************************************/
/******************************************************************************/

LuaUtils::ScopedStackChecker::ScopedStackChecker(lua_State* L, int _returnVars)
	: luaState(L)
	, prevTop(lua_gettop(luaState))
	, returnVars(_returnVars)
{
}

LuaUtils::ScopedStackChecker::~ScopedStackChecker() {
	const int curTop = lua_gettop(luaState); // use var so you can print it in gdb
	assert(curTop == prevTop + returnVars);
}

/******************************************************************************/
/******************************************************************************/

#define DEBUG_TABLE "debug"
#define DEBUG_FUNC "traceback"

/// this function always leaves one item on the stack
/// and returns its index if valid and zero otherwise
int LuaUtils::PushDebugTraceback(lua_State* L)
{
	lua_getglobal(L, DEBUG_TABLE);

	if (lua_istable(L, -1)) {
		lua_getfield(L, -1, DEBUG_FUNC);
		lua_remove(L, -2); // remove DEBUG_TABLE from stack

		if (!lua_isfunction(L, -1)) {
			return 0; // leave a stub on stack
		}
	} else {
		lua_pop(L, 1);
		static const LuaHashString traceback("traceback");
		if (!traceback.GetRegistryFunc(L)) {
			lua_pushnil(L); // leave a stub on stack
			return 0;
		}
	}

	return lua_gettop(L);
}



LuaUtils::ScopedDebugTraceBack::ScopedDebugTraceBack(lua_State* lst)
	: L(lst)
	, errFuncIdx(PushDebugTraceback(lst))
{
	assert(errFuncIdx >= 0);
}

LuaUtils::ScopedDebugTraceBack::~ScopedDebugTraceBack() {
	// make sure we are at same position on the stack
	const int curTop = lua_gettop(L);
	assert(errFuncIdx == 0 || curTop == errFuncIdx);

	lua_pop(L, 1);
}

/******************************************************************************/
/******************************************************************************/

void LuaUtils::PushStringVector(lua_State* L, const vector<string>& vec)
{
	lua_createtable(L, vec.size(), 0);
	for (size_t i = 0; i < vec.size(); i++) {
		lua_pushsstring(L, vec[i]);
		lua_rawseti(L, -2, (int)(i + 1));
	}
}

/******************************************************************************/
/******************************************************************************/

void LuaUtils::PushCommandDesc(lua_State* L, const SCommandDescription& cd)
{
	const int numParams = cd.params.size();
	const int numTblKeys = 12;

	lua_checkstack(L, 1 + 1 + 1 + 1);
	lua_createtable(L, 0, numTblKeys);

	HSTR_PUSH_NUMBER(L, "id",          cd.id);
	HSTR_PUSH_NUMBER(L, "type",        cd.type);
	HSTR_PUSH_STRING(L, "name",        cd.name);
	HSTR_PUSH_STRING(L, "action",      cd.action);
	HSTR_PUSH_STRING(L, "tooltip",     cd.tooltip);
	HSTR_PUSH_STRING(L, "texture",     cd.iconname);
	HSTR_PUSH_STRING(L, "cursor",      cd.mouseicon);
	HSTR_PUSH_BOOL(L,   "queueing",    cd.queueing);
	HSTR_PUSH_BOOL(L,   "hidden",      cd.hidden);
	HSTR_PUSH_BOOL(L,   "disabled",    cd.disabled);
	HSTR_PUSH_BOOL(L,   "showUnique",  cd.showUnique);
	HSTR_PUSH_BOOL(L,   "onlyTexture", cd.onlyTexture);

	HSTR_PUSH(L, "params");

	lua_createtable(L, 0, numParams);

	for (int p = 0; p < numParams; p++) {
		lua_pushsstring(L, cd.params[p]);
		lua_rawseti(L, -2, p + 1);
	}

	// CmdDesc["params"] = {[1] = "string1", [2] = "string2", ...}
	lua_settable(L, -3);
}

void LuaUtils::LuaStackDumper::PrintStack(lua_State* L, int parseDepth)
{
	int n = lua_gettop(L);
	LOG("[LuaStackDumper] stack has %d items", n);
	for (int i = 1; i <= n; ++i) {
		LOG("  [%d] type=%s", i, lua_typename(L, lua_type(L, i)));
	}

}

void LuaUtils::LuaStackDumper::ParseTable(lua_State* L, int i, int parseDepth) {}
void LuaUtils::LuaStackDumper::ParseLuaItem(lua_State* L, int i, bool asKey, int parseDepth) {}
void LuaUtils::LuaStackDumper::PrintBuffer() {}


#if !defined UNITSYNC && !defined BUILDING_AI
int LuaUtils::ParseAllegiance(lua_State* L, const char* caller, int index)
{
	if (!lua_isnumber(L, index))
		return AllUnits;

	const int teamID = lua_toint(L, index);

	// MyUnits, AllyUnits, and EnemyUnits do not apply to fullRead
	if (CLuaHandle::GetHandleFullRead(L) && (teamID < 0))
		return AllUnits;

	if (teamID < EnemyUnits) {
		luaL_error(L, "Bad teamID in %s (%d)", caller, teamID);
	}
	else if (teamID >= teamHandler.ActiveTeams()) {
		luaL_error(L, "Bad teamID in %s (%d)", caller, teamID);
	}

	return teamID;
}

bool LuaUtils::IsAlliedTeam(lua_State* L, int team)
{
	if (CLuaHandle::GetHandleReadAllyTeam(L) < 0)
		return CLuaHandle::GetHandleFullRead(L);

	return (teamHandler.AllyTeam(team) == CLuaHandle::GetHandleReadAllyTeam(L));
}

bool LuaUtils::IsAlliedAllyTeam(lua_State* L, int allyTeam)
{
	if (CLuaHandle::GetHandleReadAllyTeam(L) < 0)
		return CLuaHandle::GetHandleFullRead(L);

	return (allyTeam == CLuaHandle::GetHandleReadAllyTeam(L));
}

bool LuaUtils::IsAllyUnit(lua_State* L, const CUnit* unit) { return (IsAlliedAllyTeam(L, unit->allyteam)); }
bool LuaUtils::IsEnemyUnit(lua_State* L, const CUnit* unit) { return (!IsAllyUnit(L, unit)); }

bool LuaUtils::IsUnitVisible(lua_State* L, const CUnit* unit)
{
	if (IsAllyUnit(L, unit))
		return true;

	return (unit->losStatus[CLuaHandle::GetHandleReadAllyTeam(L)] & (LOS_INLOS | LOS_INRADAR));
}

bool LuaUtils::IsUnitInLos(lua_State* L, const CUnit* unit)
{
	if (IsAllyUnit(L, unit))
		return true;

	return (unit->losStatus[CLuaHandle::GetHandleReadAllyTeam(L)] & LOS_INLOS);
}

bool LuaUtils::IsUnitTyped(lua_State* L, const CUnit* unit)
{
	if (IsAllyUnit(L, unit))
		return true;

	const unsigned short losStatus = unit->losStatus[CLuaHandle::GetHandleReadAllyTeam(L)];
	const unsigned short prevMask = (LOS_PREVLOS | LOS_CONTRADAR);

	// currently in LOS or not lost from radar since being visible means unit's type can be accessed
	return ((losStatus & LOS_INLOS) || ((losStatus & prevMask) == prevMask));
}

const UnitDef* LuaUtils::EffectiveUnitDef(lua_State* L, const CUnit* unit)
{
	const UnitDef* ud = unit->unitDef;

	if (IsAllyUnit(L, unit))
		return ud;

	if (ud->decoyDef)
		return ud->decoyDef;

	return ud;
}

bool LuaUtils::IsFeatureVisible(lua_State* L, const CFeature* feature)
{
	if (CLuaHandle::GetHandleFullRead(L))
		return true;
	if (CLuaHandle::GetHandleReadAllyTeam(L) < 0)
		return false;

	return feature->IsInLosForAllyTeam(CLuaHandle::GetHandleReadAllyTeam(L));
}

bool LuaUtils::IsProjectileVisible(lua_State* L, const CProjectile* pro)
{
	if (CLuaHandle::GetHandleReadAllyTeam(L) < 0)
		return CLuaHandle::GetHandleFullRead(L);

	return !((CLuaHandle::GetHandleReadAllyTeam(L) != pro->GetAllyteamID()) &&
		(!losHandler->InLos(pro->pos, CLuaHandle::GetHandleReadAllyTeam(L))));
}

void LuaUtils::PushAttackerDef(lua_State* L, const CUnit* const attacker)
{
	if (attacker == nullptr) {
		lua_pushnil(L);
		return;
	}

	PushAttackerDef(L, *attacker);
}

void LuaUtils::PushAttackerDef(lua_State* L, const CUnit& attacker)
{
	if (LuaUtils::IsUnitTyped(L, &attacker)) {
		lua_pushnumber(L, LuaUtils::EffectiveUnitDef(L, &attacker)->id);
		return;
	}

	lua_pushnil(L);
}

void LuaUtils::PushAttackerInfo(lua_State* L, const CUnit* const attacker)
{
	if (attacker && IsUnitVisible(L, attacker)) {
		lua_pushnumber(L, attacker->id);
		PushAttackerDef(L, *attacker);
		lua_pushnumber(L, attacker->team);
		return;
	}

	lua_pushnil(L);
	lua_pushnil(L);
	lua_pushnil(L);
}
#endif


/******************************************************************************/
/******************************************************************************/
//
//  Lua 5.1 → 5.4 compatibility shims
//
//  Most Spring games (Zero-K, BA, BAR, Metalstorm, every map shipping
//  a LuaGaia gadget) were written against Lua 5.1. Our engine runs
//  Lua 5.4 which removed several core builtins outright. Rather than
//  forcing every game author to port their scripts up front, we
//  provide wrappers that emulate the 5.1 behaviour where possible,
//  and emit a one-time deprecation warning the first time each is
//  used so developers know what to migrate and why.
//
//  The set of shims provided here is intentionally minimal — only
//  what actual published Spring games are known to call. Adding more
//  is cheap (each is 10-20 lines) and should happen the moment a
//  game hits a `nil value` error on a removed builtin.

namespace {

/// Emit a one-shot deprecation warning for a 5.1 builtin. Uses a
/// single upvalue (a boolean stored as a light-userdata flag) to
/// ensure each call site only fires once per Lua state — otherwise
/// gadgets.lua's 200+ setfenv calls would drown the log.
void DeprecationWarn(lua_State* L,
                     const char* name,
                     const char* advice)
{
	// Upvalue 1 is a boolean: true once warned.
	if (lua_toboolean(L, lua_upvalueindex(1)))
		return;

	lua_Debug ar;
	std::string where = "?";
	if (lua_getstack(L, 1, &ar) && lua_getinfo(L, "Sl", &ar)) {
		char buf[256];
		SNPRINTF(buf, sizeof(buf), "%s:%d", ar.short_src, ar.currentline);
		where = buf;
	}

	SLOG(SPRING_LOG_DEBUG,
		"deprecated Lua 5.1 builtin `%s` used at %s: %s "
		"(further uses will be silently shimmed)",
		name, where.c_str(), advice);

	// Mark warned — replace upvalue 1 with `true`.
	lua_pushboolean(L, 1);
	lua_replace(L, lua_upvalueindex(1));
}

// Lua 5.1 setfenv(f, table): set the environment of function f to
// the given table. In 5.4, functions have an `_ENV` upvalue instead;
// we set upvalue 1 via lua_setfenv's C-side shim.
//
// setfenv(0, t) and setfenv(level, t) set the env of a stack frame
// (level 0 = current, 1 = caller …). We only support positive
// function arguments and level numbers up to a reasonable depth —
// most real-world uses pass an explicit function.
int Compat_setfenv(lua_State* L)
{
	DeprecationWarn(L, "setfenv",
		"Lua 5.4 removed setfenv/getfenv. For chunks loaded with "
		"load()/loadstring(), set the environment via the 4th arg: "
		"  load(code, name, 't', env). Per-function environments "
		"are no longer supported; wrap the code in a closure that "
		"captures the desired upvalues instead.");

	luaL_checktype(L, 2, LUA_TTABLE);

	if (lua_isnumber(L, 1)) {
		const int level = static_cast<int>(lua_tointeger(L, 1));
		lua_Debug ar;
		if (lua_getstack(L, level, &ar) == 0)
			return luaL_error(L, "setfenv: invalid level %d", level);
		if (lua_getinfo(L, "f", &ar) == 0 || !lua_isfunction(L, -1))
			return luaL_error(L, "setfenv: could not resolve level %d", level);
		// Stack: [level, t, func]  — put t on top then setfenv on func
		lua_pushvalue(L, 2);                // [..., func, t]
		if (lua_setfenv(L, -2) == 0)        // sets upvalue 1 of func
			return luaL_error(L, "setfenv: failed to set env for level %d", level);
		lua_pop(L, 1);                      // pop the func
		return 0;
	}

	if (!lua_isfunction(L, 1))
		return luaL_error(L, "setfenv: first arg must be a function or level number");

	// Stack: [func, t]
	lua_pushvalue(L, 2);                    // [func, t, t]
	if (lua_setfenv(L, 1) == 0)             // sets upvalue 1 of arg 1 (func)
		return luaL_error(L, "setfenv: failed to set env on function (is it a C function?)");
	lua_pushvalue(L, 1);                    // return the function, per 5.1 contract
	return 1;
}

// Lua 5.1 getfenv(f_or_level): return the environment of f, or of
// the function at the given stack level. Defaults to level 1 (the
// caller of getfenv).
int Compat_getfenv(lua_State* L)
{
	DeprecationWarn(L, "getfenv",
		"Lua 5.4 removed setfenv/getfenv. Read `_ENV` directly in "
		"the scope you care about, or use debug.getupvalue(f, 1) "
		"which returns the `_ENV` upvalue of function f.");

	int level = 1;
	if (lua_isnumber(L, 1)) {
		level = static_cast<int>(lua_tointeger(L, 1));
	} else if (lua_isfunction(L, 1)) {
		lua_getfenv(L, 1);
		return 1;
	}

	if (level == 0) {
		lua_pushglobaltable(L);
		return 1;
	}

	lua_Debug ar;
	if (lua_getstack(L, level, &ar) == 0)
		return luaL_error(L, "getfenv: invalid level %d", level);
	if (lua_getinfo(L, "f", &ar) == 0)
		return luaL_error(L, "getfenv: could not resolve level %d", level);
	lua_getfenv(L, -1);
	lua_remove(L, -2); // remove the function, leave env on top
	return 1;
}

// Lua 5.1 unpack(t [, i [, j]]): moved to table.unpack in 5.2+.
// Most published gadgets still call the bare name.
int Compat_unpack(lua_State* L)
{
	DeprecationWarn(L, "unpack",
		"Lua 5.4 moved `unpack` into the table library. "
		"Use `table.unpack(t, i, j)` instead.");

	// Delegate to table.unpack, which exists in 5.4.
	lua_getglobal(L, "table");
	lua_getfield(L, -1, "unpack");
	lua_remove(L, -2); // remove 'table'
	lua_insert(L, 1);  // move table.unpack before the original args
	lua_call(L, lua_gettop(L) - 1, LUA_MULTRET);
	return lua_gettop(L);
}

// Helper: register a C function with an upvalue slot for the
// one-shot deprecation flag.
void PushCompatCFunc(lua_State* L, lua_CFunction fn)
{
	lua_pushboolean(L, 0); // upvalue 1 = "not warned yet"
	lua_pushcclosure(L, fn, 1);
}

} // namespace


// Lua 5.1 math.max/math.min coerced string arguments to numbers.
// Lua 5.4 does not — `math.max(1, "30")` raises an error.  Many
// Spring games (ZK, BAR) pass customParams values (which are always
// strings) directly into math.max/min.  Rather than patching every
// gadget, shim the original behaviour.
int LuaUtils::Compat_math_max(lua_State* L)
{
	int n = lua_gettop(L);
	luaL_argcheck(L, n >= 1, 1, "value expected");
	lua_Number best = luaL_checknumber(L, 1);
	for (int i = 2; i <= n; i++) {
		lua_Number v = luaL_checknumber(L, i); // coerces strings to numbers
		if (v > best) best = v;
	}
	lua_pushnumber(L, best);
	return 1;
}

int LuaUtils::Compat_math_min(lua_State* L)
{
	int n = lua_gettop(L);
	luaL_argcheck(L, n >= 1, 1, "value expected");
	lua_Number best = luaL_checknumber(L, 1);
	for (int i = 2; i <= n; i++) {
		lua_Number v = luaL_checknumber(L, i);
		if (v < best) best = v;
	}
	lua_pushnumber(L, best);
	return 1;
}


// math.pow(x, y) was removed in Lua 5.3 in favour of the `^` operator.
// Many Spring 5.1 games still call math.pow directly.
int LuaUtils::Compat_math_pow(lua_State* L)
{
	const lua_Number x = luaL_checknumber(L, 1);
	const lua_Number y = luaL_checknumber(L, 2);
	lua_pushnumber(L, std::pow(x, y));
	return 1;
}

// math.atan2(y, x) was merged into math.atan(y[, x]) in Lua 5.3.
int LuaUtils::Compat_math_atan2(lua_State* L)
{
	const lua_Number y = luaL_checknumber(L, 1);
	const lua_Number x = luaL_checknumber(L, 2);
	lua_pushnumber(L, std::atan2(y, x));
	return 1;
}

// math.log10(x) was removed in Lua 5.2; equivalent is math.log(x, 10).
int LuaUtils::Compat_math_log10(lua_State* L)
{
	const lua_Number x = luaL_checknumber(L, 1);
	lua_pushnumber(L, std::log10(x));
	return 1;
}

// math.mod was renamed to math.fmod in 5.1; some legacy code still calls
// the old name. (Spring's existing 5.1 distribution kept it as an alias.)
int LuaUtils::Compat_math_mod(lua_State* L)
{
	const lua_Number x = luaL_checknumber(L, 1);
	const lua_Number y = luaL_checknumber(L, 2);
	lua_pushnumber(L, std::fmod(x, y));
	return 1;
}


void LuaUtils::Register51CompatShims(lua_State* L)
{
	PushCompatCFunc(L, Compat_setfenv);
	lua_setglobal(L, "setfenv");

	PushCompatCFunc(L, Compat_getfenv);
	lua_setglobal(L, "getfenv");

	PushCompatCFunc(L, Compat_unpack);
	lua_setglobal(L, "unpack");

	// Override math.max/min with coercing versions, and add the
	// 5.1 math builtins that 5.2/5.3 removed (pow, atan2, log10, mod).
	lua_getglobal(L, "math");
	lua_pushcfunction(L, Compat_math_max);
	lua_setfield(L, -2, "max");
	lua_pushcfunction(L, Compat_math_min);
	lua_setfield(L, -2, "min");
	lua_pushcfunction(L, Compat_math_pow);
	lua_setfield(L, -2, "pow");
	lua_pushcfunction(L, Compat_math_atan2);
	lua_setfield(L, -2, "atan2");
	lua_pushcfunction(L, Compat_math_log10);
	lua_setfield(L, -2, "log10");
	lua_pushcfunction(L, Compat_math_mod);
	lua_setfield(L, -2, "mod");
	lua_pop(L, 1); // pop math table
}
