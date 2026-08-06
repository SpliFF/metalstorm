// FactionData — implementation. See FactionData.h for the design.

#include "FactionData.h"
#include "System/SpringLog/SpringLog.h"

// Bundled Lua is compiled as C++ (CMake glob over rts/lib/lua/src/*.cpp)
// so the headers are included without extern "C" — see ConfigReader.cpp.
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

#define LOG_SECTION "faction"

#include <algorithm>
#include <cctype>
#include <filesystem>
#include <unordered_set>

namespace fs = std::filesystem;

namespace {

std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

/// Read a string field off the table at the top of the stack. Leaves the
/// stack depth unchanged.
std::string GetStringField(lua_State* L, const char* field) {
    lua_getfield(L, -1, field);
    std::string v = lua_isstring(L, -1) ? lua_tostring(L, -1) : "";
    lua_pop(L, 1);
    return v;
}

/// Registry key holding the game folder that `VFS.Include` resolves
/// against. Set before the sidedata chunk runs. Same mechanism as
/// ConfigReader's kBaseDirRegistryKey — separate key so the two shims
/// can never read each other's base dir if they ever share a state.
constexpr const char* kBaseDirRegistryKey = "factiondata.base_dir";

/// VFS.Include(path) — minimal shim, deliberately a subset of the sim's.
/// Resolves `path` against the game folder in the registry and returns
/// whatever the included chunk returned. A missing file returns nil,
/// matching Spring's own VFS.Include, so a game whose sidedata.lua tests
/// its include for nil (BAR does) gets the error message it wrote rather
/// than an opaque Lua type error.
int L_VFS_Include(lua_State* L) {
    const char* pathArg = luaL_checkstring(L, 1);

    lua_pushstring(L, kBaseDirRegistryKey);
    lua_gettable(L, LUA_REGISTRYINDEX);
    const std::string baseDir = lua_isstring(L, -1) ? lua_tostring(L, -1) : "";
    lua_pop(L, 1);

    const fs::path target =
        baseDir.empty() ? fs::path(pathArg) : fs::path(baseDir) / pathArg;

    std::error_code ec;
    if (!fs::exists(target, ec)) {
        lua_pushnil(L);
        return 1;
    }
    if (luaL_loadfile(L, target.string().c_str()) != LUA_OK)
        return luaL_error(L, "VFS.Include: parse error in %s: %s",
            target.string().c_str(), lua_tostring(L, -1));
    if (lua_pcall(L, 0, 1, 0) != LUA_OK)
        return luaL_error(L, "VFS.Include: exec error in %s: %s",
            target.string().c_str(), lua_tostring(L, -1));
    return 1;
}

/// Install `_G.VFS = { Include = ... }` and point the shim at `baseDir`.
void InstallVFS(lua_State* L, const fs::path& baseDir) {
    lua_pushstring(L, kBaseDirRegistryKey);
    lua_pushstring(L, baseDir.string().c_str());
    lua_settable(L, LUA_REGISTRYINDEX);

    lua_newtable(L);
    lua_pushcfunction(L, L_VFS_Include);
    lua_setfield(L, -2, "Include");
    lua_setglobal(L, "VFS");
}

} // namespace

namespace FactionData {

std::vector<FactionInfo> Discover(const std::string& gameFolderPath) {
    std::vector<FactionInfo> out;

    const fs::path path = fs::path(gameFolderPath) / "gamedata" / "sidedata.lua";
    std::error_code ec;
    if (!fs::exists(path, ec))
        return out;

    lua_State* L = luaL_newstate();
    if (!L) {
        SLOG(SPRING_LOG_WARNING, "sidedata.lua: lua_newstate failed");
        return out;
    }
    luaL_openlibs(L);
    // Resolve VFS.Include relative to the game folder, so BAR's
    // `VFS.Include("gamedata/sides_enum.lua")` lands inside the archive
    // and not the lobby's cwd. See FactionData.h.
    InstallVFS(L, fs::path(gameFolderPath));

    if (luaL_loadfile(L, path.string().c_str()) != LUA_OK ||
        lua_pcall(L, 0, 1, 0) != LUA_OK) {
        const char* err = lua_tostring(L, -1);
        SLOG(SPRING_LOG_WARNING, "sidedata.lua: %s", err ? err : "evaluation failed");
        lua_close(L);
        return out;
    }

    if (!lua_istable(L, -1)) {
        SLOG(SPRING_LOG_WARNING, "sidedata.lua: did not return a table");
        lua_close(L);
        return out;
    }

    std::unordered_set<std::string> seenKeys;
    const int len = static_cast<int>(lua_rawlen(L, -1));
    for (int i = 1; i <= len; ++i) {
        lua_rawgeti(L, -1, i);
        if (!lua_istable(L, -1)) { lua_pop(L, 1); continue; }

        FactionInfo info;
        info.name        = GetStringField(L, "name");
        info.fullName    = GetStringField(L, "fullName");
        info.description = GetStringField(L, "description");
        info.startUnit   = GetStringField(L, "startUnit");
        if (info.startUnit.empty())
            info.startUnit = GetStringField(L, "startunit"); // see FactionData.h
        lua_pop(L, 1); // entry table

        if (info.name.empty()) {
            SLOG(SPRING_LOG_WARNING, "sidedata.lua: entry %d missing `name`, skipped", i);
            continue;
        }
        info.key = ToLower(info.name);
        if (info.fullName.empty())
            info.fullName = info.name;

        if (!seenKeys.insert(info.key).second) {
            SLOG(SPRING_LOG_WARNING, "sidedata.lua: duplicate faction key '%s', skipped",
                info.key.c_str());
            continue;
        }
        out.push_back(std::move(info));
    }
    lua_pop(L, 1); // root table

    lua_close(L);
    return out;
}

} // namespace FactionData
