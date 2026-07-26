// AIScriptContext — AI Lua VM running on worker threads.

#include "AIScriptContext.h"
#include "AICommandQueue.h"
#include "LuaInclude.h"
#include "System/SpringLog/SpringLog.h"

#include <nlohmann/json.hpp>

#define LOG_SECTION "ai"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <string>
#include <system_error>

// Store the AIScriptContext pointer in the Lua extra space
static AIScriptContext* GetAIContext(lua_State* L) {
    void** extra = (void**)lua_getextraspace(L);
    return reinterpret_cast<AIScriptContext*>(*extra);
}

namespace {

// AI4 file-read sandbox. The two read roots (map data dir, def export dir)
// are FLAT — regions.json and power.json sit directly in them — so the leaf
// check is stricter than l_require's: it forbids ALL path separators, not
// just leading ones, and any '..'. There is no legitimate subdirectory read,
// so refusing them removes a whole class of traversal before it starts.
bool IsSafeLeafName(const std::string& n) {
    if (n.empty()) return false;
    if (n.find("..") != std::string::npos) return false;
    for (char c : n) {
        if (c == '/' || c == '\\') return false;
    }
    return true;
}

// Recursively push a decoded JSON value as the equivalent Lua value.
// JSON null → Lua nil (harmless for our flat objects; our exports carry
// no nulls inside arrays where a nil would punch a hole).
void PushJson(lua_State* L, const nlohmann::json& j) {
    switch (j.type()) {
        case nlohmann::json::value_t::boolean:
            lua_pushboolean(L, j.get<bool>() ? 1 : 0);
            break;
        case nlohmann::json::value_t::number_integer:
            lua_pushinteger(L, static_cast<lua_Integer>(j.get<int64_t>()));
            break;
        case nlohmann::json::value_t::number_unsigned:
            lua_pushinteger(L, static_cast<lua_Integer>(j.get<uint64_t>()));
            break;
        case nlohmann::json::value_t::number_float:
            lua_pushnumber(L, j.get<double>());
            break;
        case nlohmann::json::value_t::string: {
            const std::string& s = j.get_ref<const nlohmann::json::string_t&>();
            lua_pushlstring(L, s.data(), s.size());
            break;
        }
        case nlohmann::json::value_t::array: {
            lua_createtable(L, static_cast<int>(j.size()), 0);
            int idx = 1;
            for (const auto& el : j) {
                PushJson(L, el);
                lua_rawseti(L, -2, idx++);
            }
            break;
        }
        case nlohmann::json::value_t::object: {
            lua_createtable(L, 0, static_cast<int>(j.size()));
            for (auto it = j.begin(); it != j.end(); ++it) {
                PushJson(L, it.value());
                lua_setfield(L, -2, it.key().c_str());
            }
            break;
        }
        default:  // null, discarded, binary
            lua_pushnil(L);
            break;
    }
}

// Shared body for AI.getMapData / AI.getDefExport. Reads a JSON file from a
// sandboxed root and pushes the decoded table.
//
// Contract, deliberately mirroring l_require's sandbox posture:
//   * unconfigured root (empty) or missing file → nil (honest degrade: an
//     AI with no data does nothing rash, per PLAN-metalstorm-ai §2);
//   * a name that tries to escape the root → a LOUD Lua error (like
//     l_require rejecting '..'), so a broken/hostile plugin fails visibly;
//   * malformed JSON → a Lua error (the file exists but is corrupt — not a
//     "blind AI" case, a real fault worth surfacing).
int ReadSandboxedJson(lua_State* L, const std::string& root, const char* api) {
    const char* rawName = luaL_checkstring(L, 1);
    if (root.empty()) {           // feature not configured for this AI
        lua_pushnil(L);
        return 1;
    }

    const std::string name = rawName;
    if (!IsSafeLeafName(name)) {
        return luaL_error(L, "%s: illegal file name '%s'", api, rawName);
    }

    namespace fs = std::filesystem;
    const fs::path path = fs::path(root) / name;

    // Defence in depth against a symlinked root/leaf: resolve and require
    // the target stays under the root prefix. weakly_canonical tolerates a
    // not-yet-existing leaf (normalises lexically past the missing tail).
    std::error_code ec;
    const fs::path canonRoot = fs::weakly_canonical(fs::path(root), ec);
    const fs::path canonPath = fs::weakly_canonical(path, ec);
    if (!ec) {
        const std::string r = canonRoot.string();
        const std::string p = canonPath.string();
        if (p.size() < r.size() || p.compare(0, r.size(), r) != 0) {
            return luaL_error(L, "%s: path escapes sandbox '%s'", api, rawName);
        }
    }

    std::ifstream file(path, std::ios::binary);
    if (!file.is_open()) {        // missing → nil (not an error)
        lua_pushnil(L);
        return 1;
    }
    const std::string src((std::istreambuf_iterator<char>(file)),
                          std::istreambuf_iterator<char>());

    nlohmann::json j = nlohmann::json::parse(src, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded()) {
        return luaL_error(L, "%s: '%s' is not valid JSON", api, rawName);
    }

    PushJson(L, j);
    return 1;
}

} // namespace

AIScriptContext::AIScriptContext(const std::string& name, int teamId, int allyTeamId,
                                 const std::string& pluginDir,
                                 const std::string& mapDataDir,
                                 const std::string& defExportDir)
    : name(name), teamId(teamId), allyTeamId(allyTeamId), pluginDir(pluginDir),
      mapDataDir(mapDataDir), defExportDir(defExportDir)
{
    permissions.synced = false; // AI doesn't directly modify sim state
    permissions.fullRead = false;
    permissions.fullCtrl = false;
    permissions.readTeam = teamId;
    permissions.ctrlTeam = teamId;
    permissions.readAllyTeam = allyTeamId;
}

AIScriptContext::~AIScriptContext() {
    Shutdown();
}

bool AIScriptContext::Init(const std::string& code, const std::string& source) {
    L = luaL_newstate();
    if (!L) return false;

    // Store this pointer in Lua extra space
    void** extra = (void**)lua_getextraspace(L);
    *extra = this;

    // Open safe standard libraries (no os, io, debug)
    luaL_requiref(L, "_G", luaopen_base, 1); lua_pop(L, 1);
    luaL_requiref(L, "table", luaopen_table, 1); lua_pop(L, 1);
    luaL_requiref(L, "string", luaopen_string, 1); lua_pop(L, 1);
    luaL_requiref(L, "math", luaopen_math, 1); lua_pop(L, 1);
    luaL_requiref(L, "utf8", luaopen_utf8, 1); lua_pop(L, 1);

    // AI0-loader: a plugin-scoped `require`. The VM opens no `package`/`io`
    // lib (kept sandboxed), so multi-file AIs get a minimal module system:
    // `require(name)` reads `<pluginDir>/<name-with-dots-as-slashes>.lua`,
    // runs it once, and caches the result. This is what lets strategos'
    // main.lua wire its sibling modules (config/picture/slate/planner/...).
    // Disabled when pluginDir is empty (single-buffer AIs need no loader).
    if (!pluginDir.empty()) {
        lua_newtable(L);
        lua_setfield(L, LUA_REGISTRYINDEX, "ai_module_cache");
        lua_pushcfunction(L, l_require);
        lua_setglobal(L, "require");
    }

    RegisterAPI();

    // Load and execute the AI script
    int err = luaL_loadbuffer(L, code.c_str(), code.size(), source.c_str());
    if (err != LUA_OK) {
        SLOG_SCOPED(SPRING_LOG_ERROR, name.c_str(), "load error: %s", lua_tostring(L, -1));
        lua_pop(L, 1);
        return false;
    }

    err = lua_pcall(L, 0, 0, 0);
    if (err != LUA_OK) {
        SLOG_SCOPED(SPRING_LOG_ERROR, name.c_str(), "init error: %s", lua_tostring(L, -1));
        lua_pop(L, 1);
        return false;
    }

    running.store(true);
    SLOG_SCOPED(SPRING_LOG_INFO, name.c_str(), "initialised for team %d", teamId);
    return true;
}

void AIScriptContext::Shutdown() {
    running.store(false);
    if (L) {
        lua_close(L);
        L = nullptr;
    }
}

bool AIScriptContext::WantsEvent(uint16_t eventType) const {
    // AI only cares about GameFrame (triggers snapshot processing)
    return (eventType == 4); // ScriptEventType::GameFrame
}

void AIScriptContext::HandleEvent(const ScriptEvent& event) {
    // Events are delivered async via PushSnapshot, not directly
    (void)event;
}

bool AIScriptContext::HandleControlEvent(ScriptEvent& event) {
    // AI never handles control events (Allow*, etc.)
    (void)event;
    return false;
}

void AIScriptContext::CollectGarbage(bool forced) {
    if (!L) return;
    if (forced) {
        lua_gc(L, LUA_GCCOLLECT, 0);
    } else {
        lua_gc(L, LUA_GCSTEP, 10);
    }
}

void AIScriptContext::PushSnapshot(AIStateSnapshot&& snapshot) {
    std::lock_guard<std::mutex> lock(snapshotMutex);
    // Keep only the latest snapshot (drop older ones)
    while (!snapshotQueue.empty()) snapshotQueue.pop();
    snapshotQueue.push(std::move(snapshot));
}

void AIScriptContext::ProcessSnapshot() {
    if (!L || !running.load()) return;

    // Get latest snapshot
    {
        std::lock_guard<std::mutex> lock(snapshotMutex);
        if (snapshotQueue.empty()) return;
        currentSnapshot = std::move(snapshotQueue.front());
        snapshotQueue.pop();
    }

    // Call the AI's onUpdate function
    lua_getglobal(L, "onUpdate");
    if (!lua_isfunction(L, -1)) {
        lua_pop(L, 1);
        return;
    }

    lua_pushinteger(L, currentSnapshot.frame);
    int err = lua_pcall(L, 1, 0, 0);
    if (err != LUA_OK) {
        SLOG_SCOPED(SPRING_LOG_ERROR, name.c_str(), "onUpdate error: %s",
            lua_tostring(L, -1));
        lua_pop(L, 1);
    }
}

// === Lua API functions exposed to AI scripts ===

void AIScriptContext::RegisterAPI() {
    // Create the Spring.AI table
    lua_newtable(L);

    lua_pushcfunction(L, l_getOwnUnits);
    lua_setfield(L, -2, "getOwnUnits");

    lua_pushcfunction(L, l_getVisibleEnemies);
    lua_setfield(L, -2, "getVisibleEnemies");

    lua_pushcfunction(L, l_issueCommand);
    lua_setfield(L, -2, "issueCommand");

    lua_pushcfunction(L, l_getFrame);
    lua_setfield(L, -2, "getFrame");

    lua_pushcfunction(L, l_getMapSize);
    lua_setfield(L, -2, "getMapSize");

    lua_pushcfunction(L, l_getTeamId);
    lua_setfield(L, -2, "getTeamId");

    lua_pushcfunction(L, l_getRulesParam);
    lua_setfield(L, -2, "getRulesParam");

    lua_pushcfunction(L, l_getMapData);
    lua_setfield(L, -2, "getMapData");

    lua_pushcfunction(L, l_getDefExport);
    lua_setfield(L, -2, "getDefExport");

    lua_setglobal(L, "AI");
}

// AI0-loader: plugin-scoped require. Resolves `name` (dotted → path) against
// pluginDir, loads+runs the file once, caches by name in the registry.
// Sandboxed: rejects absolute paths and any `..` traversal, and only ever
// touches files under the plugin folder.
int AIScriptContext::l_require(lua_State* L) {
    namespace fs = std::filesystem;
    auto* ctx = GetAIContext(L);
    const char* rawName = luaL_checkstring(L, 1);
    std::string name = rawName;

    // Cache hit? (cache table lives in the registry)
    lua_getfield(L, LUA_REGISTRYINDEX, "ai_module_cache"); // [cache]
    lua_getfield(L, -1, name.c_str());                     // [cache][mod]
    if (!lua_isnil(L, -1))
        return 1;                                          // returns [mod]
    lua_pop(L, 1);                                         // [cache]

    // Reject anything that could escape the plugin folder.
    if (name.find("..") != std::string::npos ||
        (!name.empty() && (name[0] == '/' || name[0] == '\\'))) {
        return luaL_error(L, "require: illegal module name '%s'", rawName);
    }

    // Dotted module path → relative file path.
    std::string rel = name;
    for (char& ch : rel) if (ch == '.') ch = '/';
    const fs::path path = fs::path(ctx->pluginDir) / (rel + ".lua");

    std::ifstream file(path, std::ios::binary);
    if (!file.is_open())
        return luaL_error(L, "require: module '%s' not found (%s)",
            rawName, path.string().c_str());
    const std::string src((std::istreambuf_iterator<char>(file)),
                           std::istreambuf_iterator<char>());

    const std::string chunkName = "@" + path.string();
    if (luaL_loadbuffer(L, src.c_str(), src.size(), chunkName.c_str()) != LUA_OK)
        return lua_error(L);                               // propagate load error
    if (lua_pcall(L, 0, 1, 0) != LUA_OK)
        return lua_error(L);                               // propagate run error

    // require convention: a module returning nil is recorded as `true`.
    if (lua_isnil(L, -1)) {
        lua_pop(L, 1);
        lua_pushboolean(L, 1);
    }
    // Cache: cache[name] = result. Stack: [cache][result]
    lua_pushvalue(L, -1);
    lua_setfield(L, -3, name.c_str());
    return 1;                                              // returns [result]
}

int AIScriptContext::l_getTeamId(lua_State* L) {
    auto* ctx = GetAIContext(L);
    lua_pushinteger(L, ctx->teamId);
    return 1;
}

// AI1: read a game- or team-scoped rulesParam mirror from the snapshot.
// getRulesParam(scope, key) → number | string | nil. Scope is 'game'
// (public strategic mirror: objectives, regions, pools) or 'team' (own
// team's params). Only player-visible data — no cheating channel: the
// snapshot builder filters to what this AI's team may read.
int AIScriptContext::l_getRulesParam(lua_State* L) {
    auto* ctx = GetAIContext(L);
    const char* scope = luaL_checkstring(L, 1);
    const char* key = luaL_checkstring(L, 2);

    const auto& params = (std::strcmp(scope, "team") == 0)
        ? ctx->currentSnapshot.teamParams
        : ctx->currentSnapshot.gameParams;

    auto it = params.find(key);
    if (it == params.end()) {
        lua_pushnil(L);
        return 1;
    }
    if (it->second.isString)
        lua_pushstring(L, it->second.str.c_str());
    else
        lua_pushnumber(L, it->second.num);
    return 1;
}

// AI4: AI.getMapData(name) — read a JSON file from the processed map's data
// dir (regions.json + friends), decoded to a Lua table. Same file the client
// fetches from /api/maps/data/<id>/, so the AI's region graph and the client's
// mirror stay honest by construction (no separate AI map data).
int AIScriptContext::l_getMapData(lua_State* L) {
    auto* ctx = GetAIContext(L);
    return ReadSandboxedJson(L, ctx->mapDataDir, "AI.getMapData");
}

// AI4: AI.getDefExport(name) — read a JSON file from the game's def cache dir
// (power.json = the expected-DPS power table), decoded to a Lua table. The
// power table is computed from the SAME parsed defs as weapondefs.lua's
// expected_dps and written into the HTTP-served cache dir, so the AI and the
// client read identical numbers (combat-resolution §2.3 / ask C7).
int AIScriptContext::l_getDefExport(lua_State* L) {
    auto* ctx = GetAIContext(L);
    return ReadSandboxedJson(L, ctx->defExportDir, "AI.getDefExport");
}

bool AIScriptContext::TryGetGlobalNumber(const char* name, double& out) const {
    if (!L) return false;
    lua_getglobal(L, name);
    const bool ok = lua_isnumber(L, -1) != 0;
    if (ok) out = lua_tonumber(L, -1);
    lua_pop(L, 1);
    return ok;
}

int AIScriptContext::l_getOwnUnits(lua_State* L) {
    auto* ctx = GetAIContext(L);
    const auto& units = ctx->currentSnapshot.ownUnits;

    lua_createtable(L, units.size(), 0);
    for (size_t i = 0; i < units.size(); i++) {
        const auto& u = units[i];
        lua_createtable(L, 0, 6);
        lua_pushinteger(L, u.unitId);  lua_setfield(L, -2, "id");
        lua_pushinteger(L, u.defId);   lua_setfield(L, -2, "defId");
        lua_pushnumber(L, u.position.x); lua_setfield(L, -2, "x");
        lua_pushnumber(L, u.position.y); lua_setfield(L, -2, "y");
        lua_pushnumber(L, u.position.z); lua_setfield(L, -2, "z");
        lua_pushnumber(L, u.health);   lua_setfield(L, -2, "health");
        lua_pushboolean(L, u.hasCommands); lua_setfield(L, -2, "hasCommands");
        lua_rawseti(L, -2, i + 1);
    }
    return 1;
}

int AIScriptContext::l_getVisibleEnemies(lua_State* L) {
    auto* ctx = GetAIContext(L);
    const auto& units = ctx->currentSnapshot.visibleEnemies;

    lua_createtable(L, units.size(), 0);
    for (size_t i = 0; i < units.size(); i++) {
        const auto& u = units[i];
        lua_createtable(L, 0, 5);
        lua_pushinteger(L, u.unitId);  lua_setfield(L, -2, "id");
        lua_pushinteger(L, u.defId);   lua_setfield(L, -2, "defId");
        lua_pushnumber(L, u.position.x); lua_setfield(L, -2, "x");
        lua_pushnumber(L, u.position.z); lua_setfield(L, -2, "z");
        lua_pushnumber(L, u.health);   lua_setfield(L, -2, "health");
        lua_rawseti(L, -2, i + 1);
    }
    return 1;
}

int AIScriptContext::l_issueCommand(lua_State* L) {
    auto* ctx = GetAIContext(L);

    AICommand cmd;
    cmd.teamId = ctx->teamId;
    cmd.unitId = static_cast<uint32_t>(luaL_checkinteger(L, 1));
    cmd.commandId = static_cast<int>(luaL_checkinteger(L, 2));

    // Remaining args are command parameters
    int nargs = lua_gettop(L);
    cmd.numParams = std::min(nargs - 2, 8);
    for (int i = 0; i < cmd.numParams; i++) {
        cmd.params[i] = static_cast<float>(luaL_checknumber(L, 3 + i));
    }

    aiCommandQueue.Push(cmd);
    return 0;
}

int AIScriptContext::l_getFrame(lua_State* L) {
    auto* ctx = GetAIContext(L);
    lua_pushinteger(L, ctx->currentSnapshot.frame);
    return 1;
}

int AIScriptContext::l_getMapSize(lua_State* L) {
    auto* ctx = GetAIContext(L);
    lua_pushinteger(L, ctx->currentSnapshot.mapWidth);
    lua_pushinteger(L, ctx->currentSnapshot.mapHeight);
    return 2;
}
