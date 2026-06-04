/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */


#include "LuaVFS.h"
#include "LuaInclude.h"
#include "LuaHashString.h"
#include "LuaUtils.h"
#include "System/FileSystem/FileHandler.h"
#include "System/FileSystem/VFSModes.h"
#include "System/StringUtil.h"


/******************************************************************************/
/******************************************************************************/

bool LuaVFS::PushCommon(lua_State* L)
{
	HSTR_PUSH_CSTRING(L, "RAW",       SPRING_VFS_RAW);
	HSTR_PUSH_CSTRING(L, "MOD",       SPRING_VFS_MOD);
	HSTR_PUSH_CSTRING(L, "GAME",      SPRING_VFS_MOD); // synonym to MOD
	HSTR_PUSH_CSTRING(L, "MAP",       SPRING_VFS_MAP);
	HSTR_PUSH_CSTRING(L, "BASE",      SPRING_VFS_BASE);
	HSTR_PUSH_CSTRING(L, "MENU",      SPRING_VFS_MENU);
	HSTR_PUSH_CSTRING(L, "ZIP",       SPRING_VFS_ZIP);
	HSTR_PUSH_CSTRING(L, "RAW_FIRST", SPRING_VFS_RAW_FIRST);
	HSTR_PUSH_CSTRING(L, "ZIP_FIRST", SPRING_VFS_ZIP_FIRST);
	HSTR_PUSH_CSTRING(L, "RAW_ONLY",  SPRING_VFS_RAW); // backwards compatibility
	HSTR_PUSH_CSTRING(L, "ZIP_ONLY",  SPRING_VFS_ZIP); // backwards compatibility

	HSTR_PUSH_CFUNC(L, "PackU8",    PackU8);
	HSTR_PUSH_CFUNC(L, "PackU16",   PackU16);
	HSTR_PUSH_CFUNC(L, "PackU32",   PackU32);
	HSTR_PUSH_CFUNC(L, "PackS8",    PackS8);
	HSTR_PUSH_CFUNC(L, "PackS16",   PackS16);
	HSTR_PUSH_CFUNC(L, "PackS32",   PackS32);
	HSTR_PUSH_CFUNC(L, "PackF32",   PackF32);
	HSTR_PUSH_CFUNC(L, "UnpackU8",  UnpackU8);
	HSTR_PUSH_CFUNC(L, "UnpackU16", UnpackU16);
	HSTR_PUSH_CFUNC(L, "UnpackU32", UnpackU32);
	HSTR_PUSH_CFUNC(L, "UnpackS8",  UnpackS8);
	HSTR_PUSH_CFUNC(L, "UnpackS16", UnpackS16);
	HSTR_PUSH_CFUNC(L, "UnpackS32", UnpackS32);
	HSTR_PUSH_CFUNC(L, "UnpackF32", UnpackF32);

	// compression should be safe in synced context
	HSTR_PUSH_CFUNC(L, "ZlibCompress", ZlibCompress);
	HSTR_PUSH_CFUNC(L, "ZlibDecompress", ZlibDecompress);
	HSTR_PUSH_CFUNC(L, "CalculateHash", CalculateHash);

	return true;
}


bool LuaVFS::PushSynced(lua_State* L)
{
	PushCommon(L);

	HSTR_PUSH_CFUNC(L, "Include",    SyncInclude);
	HSTR_PUSH_CFUNC(L, "LoadFile",   SyncLoadFile);
	HSTR_PUSH_CFUNC(L, "FileExists", SyncFileExists);
	HSTR_PUSH_CFUNC(L, "DirList",    SyncDirList);
	HSTR_PUSH_CFUNC(L, "SubDirs",    SyncSubDirs);

	return true;
}


bool LuaVFS::PushUnsynced(lua_State* L)
{
	PushCommon(L);

	HSTR_PUSH_CFUNC(L, "Include",             UnsyncInclude);
	HSTR_PUSH_CFUNC(L, "LoadFile",            UnsyncLoadFile);
	HSTR_PUSH_CFUNC(L, "FileExists",          UnsyncFileExists);
	HSTR_PUSH_CFUNC(L, "DirList",             UnsyncDirList);
	HSTR_PUSH_CFUNC(L, "SubDirs",             UnsyncSubDirs);

	HSTR_PUSH_CFUNC(L, "GetFileAbsolutePath", GetFileAbsolutePath);

	return true;
}


/******************************************************************************/
/******************************************************************************/

const string LuaVFS::GetModes(lua_State* L, int index, bool /*synced*/)
{
	// Server reads from plain directories — CFileHandler ignores mode strings.
	// Just pass through whatever the caller specifies (or a default).
	return luaL_optstring(L, index, SPRING_VFS_RAW_FIRST);
}


/******************************************************************************/

static int LoadFileWithModes(const std::string& fileName, std::string& data, const std::string& vfsModes)
{
	CFileHandler fh(fileName, vfsModes);

	if (!fh.FileExists())
		return 0;

	return (fh.LoadStringData(data));
}


/******************************************************************************/
/******************************************************************************/

int LuaVFS::Include(lua_State* L, bool synced)
{
	const std::string fileName = luaL_checkstring(L, 1);
	      std::string fileData;

	#if 0
	ScopedOnceTimer timer("LuaVFS::Include(" + fileName + ")");
	#endif

	// the path may point to a file or dir outside of any data-dir
	// if (!LuaIO::IsSimplePath(fileName)) return 0;

	// note: this check must happen before luaL_loadbuffer gets called
	// it pushes new values on the stack and if only index 1 was given
	// to Include those by luaL_loadbuffer are pushed to index 2,3,...
	const bool hasCustomEnv = !lua_isnoneornil(L, 2);

	if (hasCustomEnv)
		luaL_checktype(L, 2, LUA_TTABLE);

	int loadCode = 0;
	int luaError = 0;

	if ((loadCode = LoadFileWithModes(fileName, fileData, GetModes(L, 3, synced))) != 1) {
		char buf[1024];
		SNPRINTF(buf, sizeof(buf), "[LuaVFS::%s(synced=%d)][loadvfs] file=%s status=%d cenv=%d", __func__, synced, fileName.c_str(), loadCode, hasCustomEnv);
		lua_pushstring(L, buf);
 		lua_error(L);
	}

	if ((luaError = luaL_loadbuffer(L, fileData.c_str(), fileData.size(), fileName.c_str())) != 0) {
		char buf[1024];
		SNPRINTF(buf, sizeof(buf), "[LuaVFS::%s(synced=%d)][loadbuf] file=%s error=%i (%s) cenv=%d", __func__, synced, fileName.c_str(), luaError, lua_tostring(L, -1), hasCustomEnv);
		lua_pushstring(L, buf);
		lua_error(L);
	}


	// set the chunk's fenv to the current fenv, or a user table
	if (hasCustomEnv) {
		luaL_checktype(L, 2, LUA_TTABLE);
		lua_pushvalue(L, 2);
	} else {
		LuaUtils::PushCurrentFuncEnv(L, __func__);
		luaL_checktype(L, -1, LUA_TTABLE);
	}

	// set the include fenv to the current function's fenv
	if (lua_setfenv(L, -2) == 0)
		luaL_error(L, "[LuaVFS::%s(synced=%d)][setfenv] file=%s type=%d cenv=%d", __func__, synced, fileName.c_str(), lua_type(L, -2), hasCustomEnv);


	const int paramTop = lua_gettop(L) - 1;

	if ((luaError = lua_pcall(L, 0, LUA_MULTRET, 0)) != 0) {
		char buf[1024];
		SNPRINTF(buf, sizeof(buf), "[LuaVFS::%s(synced=%d)][pcall] file=%s error=%i (%s) ptop=%d cenv=%d", __func__, synced, fileName.c_str(), luaError, lua_tostring(L, -1), paramTop, hasCustomEnv);
		lua_pushstring(L, buf);
		lua_error(L);
	}

	// FIXME -- adjust stack?
	return lua_gettop(L) - paramTop;
}


int LuaVFS::SyncInclude(lua_State* L)
{
	return Include(L, true);
}


int LuaVFS::UnsyncInclude(lua_State* L)
{
	return Include(L, false);
}


/******************************************************************************/

int LuaVFS::LoadFile(lua_State* L, bool synced)
{
	const string filename = luaL_checkstring(L, 1);
	// the path may point to a file or dir outside of any data-dir
	// if (!LuaIO::IsSimplePath(filename)) return 0;

	string data;
	if (LoadFileWithModes(filename, data, GetModes(L, 2, synced)) == 1) {
		lua_pushsstring(L, data);
		return 1;
	}
	return 0;
}


int LuaVFS::SyncLoadFile(lua_State* L)
{
	return LoadFile(L, true);
}


int LuaVFS::UnsyncLoadFile(lua_State* L)
{
	return LoadFile(L, false);
}


/******************************************************************************/

int LuaVFS::FileExists(lua_State* L, bool synced)
{
	const std::string& filename = luaL_checkstring(L, 1);
	const std::string& vfsModes = GetModes(L, 2, synced);

	// FIXME: return 0, keep searches within the Spring directory
	// the path may point to a file or dir outside of any data-dir
	// if (!LuaIO::IsSimplePath(filename)) return 0;

	lua_pushboolean(L, CFileHandler::FileExists(filename, vfsModes));
	return 1;
}


int LuaVFS::  SyncFileExists(lua_State* L) { return FileExists(L,  true); }
int LuaVFS::UnsyncFileExists(lua_State* L) { return FileExists(L, false); }


/******************************************************************************/

int LuaVFS::DirList(lua_State* L, bool synced)
{
	const std::string& dir = luaL_checkstring(L, 1);

	// FIXME: return 0, keep searches within the Spring directory
	// the path may point to a file or dir outside of any data-dir
	// if (!LuaIO::IsSimplePath(dir)) return 0;

	const std::string& pattern = luaL_optstring(L, 2, "*");
	const std::string& modes = GetModes(L, 3, synced);
	const bool recursive = luaL_optboolean(L, 4, false);

	LuaUtils::PushStringVector(L, CFileHandler::DirList(dir, pattern, modes, recursive));
	return 1;
}


int LuaVFS::SyncDirList(lua_State* L)
{
	return DirList(L, true);
}


int LuaVFS::UnsyncDirList(lua_State* L)
{
	return DirList(L, false);
}


/******************************************************************************/

int LuaVFS::SubDirs(lua_State* L, bool synced)
{
	const std::string& dir = luaL_checkstring(L, 1);

	// FIXME: return 0, keep searches within the Spring directory
	// the path may point to a file or dir outside of any data-dir
	// if (!LuaIO::IsSimplePath(dir)) return 0;

	const std::string& pattern = luaL_optstring(L, 2, "*");
	const std::string& modes = GetModes(L, 3, synced);

	LuaUtils::PushStringVector(L, CFileHandler::SubDirs(dir, pattern, modes));
	return 1;
}


int LuaVFS::SyncSubDirs(lua_State* L)
{
	return SubDirs(L, true);
}

int LuaVFS::UnsyncSubDirs(lua_State* L)
{
	return SubDirs(L, false);
}


int LuaVFS::GetFileAbsolutePath(lua_State* L)
{
	const std::string filename = luaL_checkstring(L, 1);

	// FIXME: return 0, keep searches within the Spring directory
	// the path may point to a file or dir outside of any data-dir
	// if (!LuaIO::IsSimplePath(filename)) return 0;

	if (!CFileHandler::FileExists(filename, GetModes(L, 2, false)))
		return 0;

	const std::string& absolutePath = CFileHandler::GetFileAbsolutePath(filename, GetModes(L, 2, false));

	if (absolutePath.empty())
		return 0;

	lua_pushsstring(L, absolutePath);
	return 1;
}

int LuaVFS::ZlibCompress(lua_State* L)
{
	size_t inSize = 0;
	const std::uint8_t* inData = reinterpret_cast<const std::uint8_t*>(luaL_checklstring(L, 1, &inSize));

	const std::vector<std::uint8_t> compressed = std::move(zlib::deflate(inData, inSize));

	if (!compressed.empty()) {
		lua_pushlstring(L, reinterpret_cast<const char*>(compressed.data()), compressed.size());
		return 1;
	}

	return luaL_error(L, "Error while compressing");
}

int LuaVFS::ZlibDecompress(lua_State* L)
{
	size_t inSize = 0;
	const std::uint8_t* inData = reinterpret_cast<const std::uint8_t*>(luaL_checklstring(L, 1, &inSize));

	const std::vector<std::uint8_t> uncompressed = std::move(zlib::inflate(inData, inSize));

	if (!uncompressed.empty()) {
		lua_pushlstring(L, reinterpret_cast<const char*>(uncompressed.data()), uncompressed.size());
		return 1;
	}

	return luaL_error(L, "Error while decompressing");
}


int LuaVFS::CalculateHash(lua_State* L)
{
	// sha512 / CalcHash removed — archive crypto not available on server build.
	luaL_error(L, "[VFS::%s] hash calculation not available on server", __func__);
	return 0;
}

/******************************************************************************/
/******************************************************************************/
//
//  NOTE: Endianess should be handled
//

template <typename T>
int PackType(lua_State* L)
{
	std::vector<T> vals;
	std::vector<char> buf;

	if (lua_istable(L, 1)) {
		vals.reserve(lua_objlen(L, 1));

		for (int i = 1; lua_rawgeti(L, 1, i), lua_isnumber(L, -1); lua_pop(L, 1), i++) {
			vals.push_back(static_cast<T>(lua_tonumber(L, -1)));
		}
	} else {
		vals.resize(lua_gettop(L));

		for (size_t i = 0; i < vals.size(); i++) {
			if (!lua_isnumber(L, i + 1))
				break;

			vals[i] = static_cast<T>(lua_tonumber(L, i + 1));
		}
	}

	if (vals.empty())
		return 0;

	buf.resize(sizeof(T) * vals.size(), 0);

	for (size_t i = 0; i < vals.size(); i++) {
		memcpy(buf.data() + (i * sizeof(T)), &vals[i], sizeof(T));
	}

	lua_pushlstring(L, buf.data(), buf.size());
	return 1;
}


int LuaVFS::PackU8 (lua_State* L) { return PackType<std::uint8_t >(L); }
int LuaVFS::PackU16(lua_State* L) { return PackType<std::uint16_t>(L); }
int LuaVFS::PackU32(lua_State* L) { return PackType<std::uint32_t>(L); }
int LuaVFS::PackS8 (lua_State* L) { return PackType<std::int8_t  >(L); }
int LuaVFS::PackS16(lua_State* L) { return PackType<std::int16_t >(L); }
int LuaVFS::PackS32(lua_State* L) { return PackType<std::int32_t >(L); }
int LuaVFS::PackF32(lua_State* L) { return PackType<     float   >(L); }


/******************************************************************************/

template <typename T>
int UnpackType(lua_State* L)
{
	if (!lua_isstring(L, 1))
		return 0;

	size_t len;
	const char* str = lua_tolstring(L, 1, &len);

	if (lua_isnumber(L, 2)) {
		const int pos = lua_toint(L, 2);
		if ((pos < 1) || ((size_t)pos >= len))
			return 0;

		const int offset = (pos - 1);
		str += offset;
		len -= offset;
	}

	const size_t eSize = sizeof(T);
	if (len < eSize)
		return 0;

	if (!lua_isnumber(L, 3)) {
		lua_pushnumber(L, *(reinterpret_cast<const T*>(str)));
		return 1;
	}

	const size_t maxCount = len / eSize;
	int tableCount = lua_toint(L, 3);
	if (tableCount < 0)
		tableCount = maxCount;

	lua_createtable(L, tableCount = std::min((int)maxCount, tableCount), 0);
	for (int i = 0; i < tableCount; i++) {
		lua_pushnumber(L, *(reinterpret_cast<const T*>(str) + i));
		lua_rawseti(L, -2, (i + 1));
	}
	return 1;
}


int LuaVFS::UnpackU8(lua_State*  L) { return UnpackType<std::uint8_t>(L);  }
int LuaVFS::UnpackU16(lua_State* L) { return UnpackType<std::uint16_t>(L); }
int LuaVFS::UnpackU32(lua_State* L) { return UnpackType<std::uint32_t>(L); }
int LuaVFS::UnpackS8(lua_State*  L) { return UnpackType<std::int8_t>(L);   }
int LuaVFS::UnpackS16(lua_State* L) { return UnpackType<std::int16_t>(L);  }
int LuaVFS::UnpackS32(lua_State* L) { return UnpackType<std::int32_t>(L);  }
int LuaVFS::UnpackF32(lua_State* L) { return UnpackType<float>(L);         }


/******************************************************************************/
/******************************************************************************/

