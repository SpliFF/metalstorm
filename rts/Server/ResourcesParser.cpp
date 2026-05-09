// ResourcesParser — see header.
//
// Implementation strategy: spin up a bare lua_State, install just
// enough VFS surface for `gamedata/resources.lua` and its transitive
// includes (parse_tdf.lua, scars.lua) to run, execute the script,
// then walk the returned table and serialise to JSON.
//
// The VFS shim here is intentionally narrower than rts/System/
// FileSystem/LuaVFSSimple.cpp:
//   - No archive/zip support — every lookup is a direct file read.
//   - Two roots only: the game dir (acts as MOD/GAME) and the engine
//     base dir (BASE). Mode strings ('m', 's', 'ms', etc.) are
//     respected to the extent that they decide whether to try MOD
//     and/or BASE; any unrecognised mode defaults to MOD-then-BASE.
//   - No DirList/SubDirs (resources.lua doesn't use them; if a future
//     game does, add them here).
//
// The Script global stubs out the engine-version check ZK's scars.lua
// uses. We claim "always recent enough" because spring-web pretends
// to be the latest engine for all compat-shim purposes — see
// project_engine_version_compat memory note.
//
// Lua-to-JSON serialisation handles tables (object or array, picked
// by iterating with rawlen and looking for non-1-keyed string keys),
// strings (escaped), numbers, and booleans. Functions and userdata
// are skipped silently — the resources.lua file shouldn't contain
// any after evaluation, but we don't want a stray closure to abort
// the whole parse.

#include "ResourcesParser.h"

#include "System/SpringLog/SpringLog.h"

// Bundled Lua is compiled as C++ — same convention as ConfigReader.cpp.
// Wrapping in extern "C" would demand un-mangled symbols and fail to link.
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace fs = std::filesystem;

namespace ResourcesParser {

namespace {

constexpr const char* kGameDirRegistryKey   = "resparse.game_dir";
constexpr const char* kEngineDirRegistryKey = "resparse.engine_dir";

#define LOG_SECTION "resparse"

std::string ReadFileText(const fs::path& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f.is_open()) return {};
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
}

std::string GetRegistryString(lua_State* L, const char* key) {
    lua_pushstring(L, key);
    lua_gettable(L, LUA_REGISTRYINDEX);
    std::string out;
    if (lua_isstring(L, -1)) {
        size_t len = 0;
        const char* s = lua_tolstring(L, -1, &len);
        if (s) out.assign(s, len);
    }
    lua_pop(L, 1);
    return out;
}

// Decide which roots to consult for a given mode string. Spring uses
// chars: 'm' = mod (game), 's' = base (engine). Any combination is
// valid — "ms" means mod-first-then-base, "sm" the reverse. Default
// (unset / unrecognised) is "ms".
struct ModeFlags {
    bool searchGame = true;
    bool searchEngine = true;
    bool gameFirst = true;
};

ModeFlags ParseMode(const char* modes) {
    ModeFlags out;
    if (!modes || !*modes) return out;
    out.searchGame = false;
    out.searchEngine = false;
    out.gameFirst = true;
    bool seenAny = false;
    for (const char* c = modes; *c; ++c) {
        switch (*c) {
            case 'm': case 'M':
                if (!seenAny) out.gameFirst = true;
                out.searchGame = true; seenAny = true; break;
            case 's': case 'S':
                if (!seenAny) out.gameFirst = false;
                out.searchEngine = true; seenAny = true; break;
            case 'r': case 'R':
                // RAW — fall through to game/engine; we don't have a
                // separate "raw" root, the game dir is already raw.
                out.searchGame = true; seenAny = true; break;
            default: break;
        }
    }
    if (!seenAny) {
        out.searchGame = true;
        out.searchEngine = true;
    }
    return out;
}

// Try to resolve `path` under the two configured roots, returning the
// first match. `mode` controls which roots are searched and in what
// order. Empty path on miss.
fs::path Resolve(lua_State* L, const std::string& path, const char* mode) {
    const std::string gameDir   = GetRegistryString(L, kGameDirRegistryKey);
    const std::string engineDir = GetRegistryString(L, kEngineDirRegistryKey);
    const ModeFlags m = ParseMode(mode);

    auto tryRoot = [&](const std::string& root) -> fs::path {
        if (root.empty()) return {};
        const fs::path candidate = fs::path(root) / path;
        std::error_code ec;
        if (fs::exists(candidate, ec) && fs::is_regular_file(candidate, ec))
            return candidate;
        // Case-insensitive fallback. Spring archives mix Cases freely.
        const fs::path parent = candidate.parent_path();
        if (!fs::is_directory(parent, ec)) return {};
        std::string want = candidate.filename().string();
        std::string wantLower = want;
        for (auto& c : wantLower)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        for (const auto& entry : fs::directory_iterator(parent, ec)) {
            if (ec) break;
            std::string have = entry.path().filename().string();
            std::string haveLower = have;
            for (auto& c : haveLower)
                c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
            if (haveLower == wantLower) return entry.path();
        }
        return {};
    };

    fs::path first, second;
    if (m.gameFirst) {
        if (m.searchGame)   first  = tryRoot(gameDir);
        if (!first.empty()) return first;
        if (m.searchEngine) second = tryRoot(engineDir);
        return second;
    } else {
        if (m.searchEngine) first  = tryRoot(engineDir);
        if (!first.empty()) return first;
        if (m.searchGame)   second = tryRoot(gameDir);
        return second;
    }
}

// VFS.Include(path [, env [, modes]]) — load and execute a Lua file
// returning whatever the file returned. Missing files raise (matches
// Spring's behaviour for required includes; resources.lua wraps
// optional ones in `if VFS.FileExists(...)`).
int L_VFS_Include(lua_State* L) {
    const char* pathArg = luaL_checkstring(L, 1);
    const char* modes = nullptr;
    if (lua_isstring(L, 3))
        modes = lua_tostring(L, 3);
    else if (lua_isstring(L, 2) && !lua_istable(L, 2))
        modes = lua_tostring(L, 2);

    const fs::path target = Resolve(L, pathArg, modes);
    if (target.empty()) {
        return luaL_error(L, "VFS.Include: file not found '%s'", pathArg);
    }

    if (luaL_loadfile(L, target.string().c_str()) != LUA_OK) {
        return luaL_error(L, "VFS.Include: parse error in %s: %s",
            target.string().c_str(), lua_tostring(L, -1));
    }
    // Optional env table at arg 2 — set as the chunk's _ENV upvalue.
    if (lua_istable(L, 2)) {
        lua_pushvalue(L, 2);
        const char* upname = lua_setupvalue(L, -2, 1);
        if (!upname) lua_pop(L, 1);
    }
    int top = lua_gettop(L) - 1;
    if (lua_pcall(L, 0, LUA_MULTRET, 0) != LUA_OK) {
        return luaL_error(L, "VFS.Include: exec error in %s: %s",
            target.string().c_str(), lua_tostring(L, -1));
    }
    return lua_gettop(L) - top;
}

// VFS.FileExists(path [, modes]) → boolean
int L_VFS_FileExists(lua_State* L) {
    const char* pathArg = luaL_checkstring(L, 1);
    const char* modes = luaL_optstring(L, 2, "ms");
    const fs::path target = Resolve(L, pathArg, modes);
    lua_pushboolean(L, !target.empty());
    return 1;
}

// VFS.LoadFile(path [, modes]) → string | nil
int L_VFS_LoadFile(lua_State* L) {
    const char* pathArg = luaL_checkstring(L, 1);
    const char* modes = luaL_optstring(L, 2, "ms");
    const fs::path target = Resolve(L, pathArg, modes);
    if (target.empty()) {
        lua_pushnil(L);
        return 1;
    }
    const std::string content = ReadFileText(target);
    lua_pushlstring(L, content.data(), content.size());
    return 1;
}

void InstallVFS(lua_State* L) {
    lua_newtable(L);
    lua_pushcfunction(L, L_VFS_Include);    lua_setfield(L, -2, "Include");
    lua_pushcfunction(L, L_VFS_FileExists); lua_setfield(L, -2, "FileExists");
    lua_pushcfunction(L, L_VFS_LoadFile);   lua_setfield(L, -2, "LoadFile");
    // Mode constants — strings, matching VFSModes.h.
    lua_pushstring(L, "r");   lua_setfield(L, -2, "RAW");
    lua_pushstring(L, "m");   lua_setfield(L, -2, "MOD");
    lua_pushstring(L, "m");   lua_setfield(L, -2, "GAME");
    lua_pushstring(L, "p");   lua_setfield(L, -2, "MAP");
    lua_pushstring(L, "s");   lua_setfield(L, -2, "BASE");
    lua_pushstring(L, "e");   lua_setfield(L, -2, "MENU");
    lua_pushstring(L, "msp"); lua_setfield(L, -2, "ZIP");
    lua_pushstring(L, "rms"); lua_setfield(L, -2, "RAW_FIRST");
    lua_pushstring(L, "msr"); lua_setfield(L, -2, "ZIP_FIRST");
    lua_pushstring(L, "r");   lua_setfield(L, -2, "RAW_ONLY");
    lua_pushstring(L, "msp"); lua_setfield(L, -2, "ZIP_ONLY");
    lua_setglobal(L, "VFS");
}

// Script.IsEngineMinVersion(major, minor, patch) — always true; we
// pretend to be the latest. Some game-data scripts gate behaviour
// (e.g. ZK's scars.lua picks a fallback set on older engines) and
// we want them to take the modern branch.
int L_Script_IsEngineMinVersion(lua_State* L) {
    (void)L; // ignore args
    lua_pushboolean(L, 1);
    return 1;
}

void InstallScript(lua_State* L) {
    lua_newtable(L);
    lua_pushcfunction(L, L_Script_IsEngineMinVersion);
    lua_setfield(L, -2, "IsEngineMinVersion");
    lua_setglobal(L, "Script");
}

// JSON encoder — write Lua value at stack `idx` to `out`. Skips
// functions/userdata. Tables are emitted as JSON arrays when their
// non-nil keys are exactly 1..n integers, otherwise as objects with
// stringified keys. NaN/inf numbers are emitted as null (JSON has
// no representation for them and the consumer doesn't expect them).
void EncodeJson(lua_State* L, int idx, std::string& out, int depth = 0);

void EncodeString(const char* s, size_t len, std::string& out) {
    out += '"';
    for (size_t i = 0; i < len; ++i) {
        unsigned char c = static_cast<unsigned char>(s[i]);
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
        }
    }
    out += '"';
}

bool TableLooksLikeArray(lua_State* L, int idx) {
    idx = lua_absindex(L, idx);
    // Iterate the table, look at every key. If every key is an
    // integer in [1,n] for some n equal to the count of visited
    // keys, it's an array. Otherwise it's an object.
    lua_Integer maxIdx = 0;
    int count = 0;
    lua_pushnil(L);
    while (lua_next(L, idx) != 0) {
        ++count;
        if (lua_type(L, -2) != LUA_TNUMBER) {
            lua_pop(L, 2); // pop value + key
            return false;
        }
        if (!lua_isinteger(L, -2)) {
            // Lua 5.4 distinguishes integer/float; treat float keys
            // as object keys to avoid index gaps.
            lua_Number n = lua_tonumber(L, -2);
            if (n != static_cast<lua_Integer>(n)) {
                lua_pop(L, 2);
                return false;
            }
        }
        const lua_Integer ki = lua_tointeger(L, -2);
        if (ki < 1) { lua_pop(L, 2); return false; }
        if (ki > maxIdx) maxIdx = ki;
        lua_pop(L, 1); // pop value, keep key for next iter
    }
    return maxIdx == count;
}

void EncodeJson(lua_State* L, int idx, std::string& out, int depth) {
    if (depth > 32) {
        // Cycle protection — resources.lua doesn't have cycles but
        // we don't want a malformed mod to spin forever.
        out += "null";
        return;
    }
    idx = lua_absindex(L, idx);
    int t = lua_type(L, idx);
    switch (t) {
        case LUA_TNIL: out += "null"; break;
        case LUA_TBOOLEAN:
            out += lua_toboolean(L, idx) ? "true" : "false"; break;
        case LUA_TNUMBER: {
            lua_Number n = lua_tonumber(L, idx);
            if (n != n || n == HUGE_VAL || n == -HUGE_VAL) {
                out += "null";
            } else if (lua_isinteger(L, idx)) {
                out += std::to_string(lua_tointeger(L, idx));
            } else {
                char buf[32];
                std::snprintf(buf, sizeof(buf), "%.17g", n);
                out += buf;
            }
            break;
        }
        case LUA_TSTRING: {
            size_t len; const char* s = lua_tolstring(L, idx, &len);
            EncodeString(s, len, out);
            break;
        }
        case LUA_TTABLE: {
            if (TableLooksLikeArray(L, idx)) {
                out += '[';
                int count = static_cast<int>(lua_rawlen(L, idx));
                for (int i = 1; i <= count; ++i) {
                    if (i > 1) out += ',';
                    lua_rawgeti(L, idx, i);
                    EncodeJson(L, -1, out, depth + 1);
                    lua_pop(L, 1);
                }
                out += ']';
            } else {
                out += '{';
                bool first = true;
                lua_pushnil(L);
                while (lua_next(L, idx) != 0) {
                    int vt = lua_type(L, -1);
                    if (vt == LUA_TFUNCTION || vt == LUA_TUSERDATA ||
                        vt == LUA_TLIGHTUSERDATA || vt == LUA_TTHREAD) {
                        lua_pop(L, 1); continue;
                    }
                    if (!first) out += ',';
                    first = false;
                    // Stringify key (numeric keys become quoted).
                    if (lua_type(L, -2) == LUA_TSTRING) {
                        size_t kl; const char* ks = lua_tolstring(L, -2, &kl);
                        EncodeString(ks, kl, out);
                    } else {
                        // Convert to string in a way that doesn't
                        // mutate the key on the stack (lua_next uses
                        // it for the next iteration).
                        lua_pushvalue(L, -2);
                        size_t kl; const char* ks = lua_tolstring(L, -1, &kl);
                        EncodeString(ks, kl, out);
                        lua_pop(L, 1);
                    }
                    out += ':';
                    EncodeJson(L, -1, out, depth + 1);
                    lua_pop(L, 1);
                }
                out += '}';
            }
            break;
        }
        default:
            out += "null"; break;
    }
}

} // namespace

std::string ParseGameResources(const std::string& gameId,
                               const std::string& gameDir,
                               const std::string& engineBaseDir)
{
    lua_State* L = luaL_newstate();
    if (!L) {
        SLOG(SPRING_LOG_ERROR, "[%s] luaL_newstate failed", gameId.c_str());
        return {};
    }
    luaL_openlibs(L);

    // Stash the two roots in the registry so VFS shims can read them
    // without pulling them through a closure.
    lua_pushstring(L, gameDir.c_str());
    lua_setfield(L, LUA_REGISTRYINDEX, kGameDirRegistryKey);
    lua_pushstring(L, engineBaseDir.c_str());
    lua_setfield(L, LUA_REGISTRYINDEX, kEngineDirRegistryKey);

    InstallVFS(L);
    InstallScript(L);

    // Resolve gamedata/resources.lua via game-then-engine; both are
    // expected to ship one (engine has the canonical fallback).
    const fs::path target = Resolve(L, "gamedata/resources.lua", "ms");
    if (target.empty()) {
        SLOG(SPRING_LOG_WARNING,
            "[%s] gamedata/resources.lua missing in both %s and %s",
            gameId.c_str(), gameDir.c_str(), engineBaseDir.c_str());
        lua_close(L);
        return {};
    }

    if (luaL_loadfile(L, target.string().c_str()) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "[%s] parse error in %s: %s",
            gameId.c_str(), target.string().c_str(), lua_tostring(L, -1));
        lua_close(L);
        return {};
    }
    if (lua_pcall(L, 0, 1, 0) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "[%s] exec error in %s: %s",
            gameId.c_str(), target.string().c_str(), lua_tostring(L, -1));
        lua_close(L);
        return {};
    }
    if (!lua_istable(L, -1)) {
        SLOG(SPRING_LOG_ERROR,
            "[%s] resources.lua did not return a table",
            gameId.c_str());
        lua_close(L);
        return {};
    }

    std::string json;
    json.reserve(16 * 1024);
    EncodeJson(L, -1, json);
    lua_close(L);
    return json;
}

} // namespace ResourcesParser
