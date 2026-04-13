// ConfigReader — implementation. See ConfigReader.h for the design.
//
// The whole file is built around one invariant: after Load() succeeds,
// the config's top-level table sits at lua stack index 1 of the owned
// lua_State, and every getter reads fields off that table without
// touching anything below it. The state is destroyed with the Config
// instance, so there's no lifetime issue with the getters returning
// std::string copies.

#include "ConfigReader.h"
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "config"

// The `lua` target's include directories (rts/lib/lua/include) are
// already on spring-lobby's include path, so this picks up the
// bundled 5.4 headers without any extra CMake wiring.
//
// IMPORTANT: the bundled Lua library is compiled as C++ (see the
// `file(GLOB LUA_SOURCES rts/lib/lua/src/*.cpp)` in CMakeLists.txt),
// which means its exported symbols are C++-mangled. Wrapping these
// headers in `extern "C"` would demand un-mangled symbols and fail
// to link. Include them plainly and let C++ linkage resolve.
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

// Embedded json.lua — same generated header the sim's LuaParser uses.
// CMake's configure_file step produces this in the build's generated/
// directory, which is already on spring-lobby's include path.
#include "LuaJsonSrc.h"

#include <cctype>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>

namespace fs = std::filesystem;

namespace {

/// Registry key for the "current config base directory". Set by
/// Config::Load() before the target file runs so the VFS shim
/// below can resolve `VFS.Include('foo.lua')` relative to the
/// archive root rather than whatever the process cwd is.
constexpr const char* kBaseDirRegistryKey = "configreader.base_dir";

/// Read a whole file into memory. Empty string on failure.
std::string ReadFileText(const fs::path& path) {
    std::ifstream f(path);
    if (!f.is_open()) return {};
    std::stringstream buf;
    buf << f.rdbuf();
    return buf.str();
}

/// Case-insensitive filename resolver. `dir` is an existing
/// directory; `wantLower` is the desired filename in lowercase.
/// Returns the first child of `dir` whose lowercased name matches,
/// or an empty path if none found. Spring game archives routinely
/// mix capitalisations (`modinfo.lua`, `ModInfo.lua`,
/// `ModOptions.lua`, `modoptions.lua`) — every caller in this file
/// that honours legacy layouts has to tolerate that.
fs::path ResolveCaseInsensitive(const fs::path& dir, const std::string& wantLower) {
    if (!fs::exists(dir) || !fs::is_directory(dir))
        return {};
    for (const auto& entry : fs::directory_iterator(dir)) {
        std::string name = entry.path().filename().string();
        std::string lower = name;
        for (auto& c : lower) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        if (lower == wantLower)
            return entry.path();
    }
    return {};
}

/// Read the per-state "base directory" from the registry. Set by
/// Config::Load() before the target file starts running. Returns
/// an empty string if nothing is set, in which case VFS.Include
/// resolves paths relative to the process cwd.
std::string GetBaseDir(lua_State* L) {
    lua_pushstring(L, kBaseDirRegistryKey);
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

/// VFS.Include(path) — minimal shim that honours the Spring-archive
/// convention of `config = VFS.Include('modinfo.lua')`. Resolves
/// `path` relative to the base directory stored in the registry,
/// falls back to a case-insensitive directory scan for games with
/// mixed-case filenames, loads the file via `luaL_dofile`, and
/// returns whatever the file returned. Missing files return nil
/// (rather than raising) so the gameconverter-generated wrapper
/// can cleanly test for `modoptions.lua` without wrapping each
/// include in pcall.
int L_VFS_Include(lua_State* L) {
    const char* pathArg = luaL_checkstring(L, 1);
    const std::string baseDir = GetBaseDir(L);

    fs::path target = baseDir.empty()
        ? fs::path(pathArg)
        : fs::path(baseDir) / pathArg;

    // Case-insensitive fallback for legacy archives (ModOptions.lua
    // vs modoptions.lua, etc). Only kicks in if the exact path
    // doesn't exist on disk.
    if (!fs::exists(target)) {
        const fs::path parent = target.parent_path();
        const std::string want = target.filename().string();
        std::string wantLower = want;
        for (auto& c : wantLower)
            c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        const fs::path alt = ResolveCaseInsensitive(parent, wantLower);
        if (!alt.empty()) target = alt;
    }

    if (!fs::exists(target)) {
        // Missing file: return nil. Spring's own VFS.Include would
        // also return nil here, and the wrapper generated by
        // gameconverter relies on this to treat modoptions.lua as
        // optional.
        lua_pushnil(L);
        return 1;
    }

    if (luaL_loadfile(L, target.string().c_str()) != LUA_OK) {
        return luaL_error(L, "VFS.Include: parse error in %s: %s",
            target.string().c_str(), lua_tostring(L, -1));
    }
    if (lua_pcall(L, 0, 1, 0) != LUA_OK) {
        return luaL_error(L, "VFS.Include: exec error in %s: %s",
            target.string().c_str(), lua_tostring(L, -1));
    }
    return 1;
}

/// Install a `VFS` table with an `Include` method into the given
/// lua_State's global environment. The table stays empty for now;
/// future lobby scripting can layer more members onto it without
/// touching the sim Lua API. Only Include is intentional public
/// surface — everything else is reserved for later.
void InstallVFS(lua_State* L) {
    lua_newtable(L);                            // VFS
    lua_pushcfunction(L, L_VFS_Include);        // VFS, fn
    lua_setfield(L, -2, "Include");             // VFS.Include = fn
    lua_setglobal(L, "VFS");                    // _G.VFS = VFS
}

/// Open standard libs, load the embedded json.lua so configs
/// (and JSON-to-Lua wrappers) can call `json.decode`, and install
/// the minimal `VFS.Include` shim used by legacy-game wrappers.
/// Returns the new state on success, nullptr on failure. Caller
/// owns the state.
lua_State* NewState() {
    lua_State* L = luaL_newstate();
    if (!L) return nullptr;
    luaL_openlibs(L);

    // Load the JSON library text as an anonymous chunk, run it to
    // get the module table, and stash it as a global named `json`.
    // The json.lua distribution returns the module via OBJDEF; that
    // table is left on the stack after pcall completes.
    if (luaL_loadstring(L, LuaJson::kJsonLuaSource) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "json.lua load error: %s",
            lua_tostring(L, -1));
        lua_close(L);
        return nullptr;
    }
    if (lua_pcall(L, 0, 1, 0) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "json.lua run error: %s",
            lua_tostring(L, -1));
        lua_close(L);
        return nullptr;
    }
    lua_setglobal(L, "json");

    InstallVFS(L);
    return L;
}

/// Load a `.config.lua` file. Pushes the returned table onto `L` on
/// success and returns true. Returns false and logs on any error —
/// a script that doesn't end with `return <table>` is treated as a
/// hard failure because every field read afterwards would be junk.
bool LoadLuaFile(lua_State* L, const fs::path& path) {
    if (luaL_loadfile(L, path.string().c_str()) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "parse error in %s: %s",
            path.string().c_str(), lua_tostring(L, -1));
        lua_pop(L, 1);
        return false;
    }
    if (lua_pcall(L, 0, 1, 0) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "exec error in %s: %s",
            path.string().c_str(), lua_tostring(L, -1));
        lua_pop(L, 1);
        return false;
    }
    if (!lua_istable(L, -1)) {
        SLOG(SPRING_LOG_ERROR,
            "%s: root value is not a table "
            "(did the script forget `return { ... }`?)",
            path.string().c_str());
        lua_pop(L, 1);
        return false;
    }
    return true;
}

/// Load a `.config.json` file by wrapping its contents in
/// `return json.decode([==[ ... ]==])`. The long-bracket delimiter
/// level is chosen to be larger than any `]=*]` sequence the JSON
/// contains, so the JSON body is passed to the decoder as a literal
/// string regardless of how much escaping it contains.
bool LoadJsonFile(lua_State* L, const fs::path& path) {
    const std::string raw = ReadFileText(path);
    if (raw.empty()) {
        SLOG(SPRING_LOG_ERROR, "%s: empty or unreadable JSON",
            path.string().c_str());
        return false;
    }

    // Pick the shortest long-bracket level that isn't used inside
    // the JSON body. JSON almost never contains `]==]`, but a user
    // who pastes escaped strings with many equals might — so we
    // escalate up to `]==========]` (10 equals) which is more than
    // enough for real content.
    int level = 2;
    while (level < 10) {
        std::string needle = "]";
        needle.append(level, '=');
        needle.push_back(']');
        if (raw.find(needle) == std::string::npos) break;
        level++;
    }
    const std::string eqs(level, '=');

    // NB: json.lua's OBJDEF uses Lua metatable methods, so `decode`
    // must be invoked with colon syntax (`json:decode(str)`) to pass
    // the module table as `self`. Calling it with dot syntax trips
    // an assertion inside the library ("must be called in method
    // format") — a common gotcha when adopting this vendor file.
    std::string shim;
    shim.reserve(raw.size() + 64);
    shim.append("return json:decode([").append(eqs).append("[");
    shim.append(raw);
    shim.append("]").append(eqs).append("])");

    const std::string srcName = "@" + path.string();
    if (luaL_loadbuffer(L, shim.data(), shim.size(), srcName.c_str()) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "JSON wrap error in %s: %s",
            path.string().c_str(), lua_tostring(L, -1));
        lua_pop(L, 1);
        return false;
    }
    if (lua_pcall(L, 0, 1, 0) != LUA_OK) {
        SLOG(SPRING_LOG_ERROR, "JSON decode error in %s: %s",
            path.string().c_str(), lua_tostring(L, -1));
        lua_pop(L, 1);
        return false;
    }
    if (!lua_istable(L, -1)) {
        SLOG(SPRING_LOG_ERROR,
            "%s: decoded JSON is not an object",
            path.string().c_str());
        lua_pop(L, 1);
        return false;
    }
    return true;
}

} // namespace

namespace ConfigReader {

std::unique_ptr<Config> Config::Load(const std::string& basePath) {
    const fs::path luaPath  = basePath + kLuaSuffix;
    const fs::path jsonPath = basePath + kJsonSuffix;

    if (!fs::exists(luaPath) && !fs::exists(jsonPath))
        return nullptr;

    lua_State* L = NewState();
    if (!L) return nullptr;

    // Set the registry base directory so VFS.Include() inside the
    // target script resolves relative paths against the archive
    // root. Legacy-game wrappers rely on this: their `game.config.lua`
    // does `VFS.Include('modinfo.lua')` and expects the lookup to
    // land on `<game>/modinfo.lua`, not `<cwd>/modinfo.lua`.
    const fs::path baseDir = fs::path(basePath).parent_path();
    lua_pushstring(L, kBaseDirRegistryKey);
    lua_pushstring(L, baseDir.string().c_str());
    lua_settable(L, LUA_REGISTRYINDEX);

    // Lua wins when both exist: a .config.lua is how humans author
    // overrides, a .config.json is what the tool chain emits. Keeping
    // the hand-edited version authoritative avoids a tool run silently
    // clobbering author changes.
    bool ok = false;
    if (fs::exists(luaPath)) {
        ok = LoadLuaFile(L, luaPath);
    } else {
        ok = LoadJsonFile(L, jsonPath);
    }
    if (!ok) {
        lua_close(L);
        return nullptr;
    }

    // The getters assume the table is at stack index 1 (the bottom
    // of the stack, no other values above it). Right now the stack
    // holds: [json module?, config table]. NewState() did a
    // lua_setglobal for json, so the json module value is no longer
    // on the stack — we should just have the table.
    auto cfg = std::unique_ptr<Config>(new Config());
    cfg->L = L;
    return cfg;
}

Config::Config() = default;

Config::~Config() {
    if (L) {
        lua_close(L);
        L = nullptr;
    }
}

std::string Config::GetString(const std::string& key,
                              const std::string& defaultValue) const
{
    if (!L) return defaultValue;
    lua_getfield(L, 1, key.c_str());
    std::string out = defaultValue;
    if (lua_isstring(L, -1)) {
        size_t len = 0;
        const char* s = lua_tolstring(L, -1, &len);
        if (s) out.assign(s, len);
    }
    lua_pop(L, 1);
    return out;
}

int Config::GetInt(const std::string& key, int defaultValue) const {
    if (!L) return defaultValue;
    lua_getfield(L, 1, key.c_str());
    int out = defaultValue;
    if (lua_isnumber(L, -1))
        out = static_cast<int>(lua_tointeger(L, -1));
    lua_pop(L, 1);
    return out;
}

float Config::GetFloat(const std::string& key, float defaultValue) const {
    if (!L) return defaultValue;
    lua_getfield(L, 1, key.c_str());
    float out = defaultValue;
    if (lua_isnumber(L, -1))
        out = static_cast<float>(lua_tonumber(L, -1));
    lua_pop(L, 1);
    return out;
}

bool Config::GetBool(const std::string& key, bool defaultValue) const {
    if (!L) return defaultValue;
    lua_getfield(L, 1, key.c_str());
    bool out = defaultValue;
    if (lua_isboolean(L, -1))
        out = (lua_toboolean(L, -1) != 0);
    lua_pop(L, 1);
    return out;
}

} // namespace ConfigReader
