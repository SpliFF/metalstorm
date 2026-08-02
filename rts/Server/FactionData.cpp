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
