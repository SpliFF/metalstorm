// AIDiscovery — implementation. See AIDiscovery.h for the design.
//
// Walks `<root>/ai/<plugin>/` folders and parses each plugin's
// `ai.config.{lua,json}` via ConfigReader (a tiny Lua-backed loader;
// see rts/Server/ConfigReader.h for why we don't reuse the sim's
// LuaConfigLoader here). Every discovered plugin must declare a
// `name` in its config and must have an entry file that actually
// exists on disk; anything missing is logged and skipped so the
// lobby log makes it obvious which plugin got dropped and why.

#include "AIDiscovery.h"
#include "../ConfigReader.h"
#include "System/SpringLog/SpringLog.h"

// Bundled Lua is compiled as C++ (CMake glob over rts/lib/lua/src/*.cpp)
// so the headers are included without extern "C" — see ConfigReader.cpp.
#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"

#define LOG_SECTION "ai"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <string>

namespace fs = std::filesystem;

namespace {

/// Lowercase a string. Used to derive the stable id from a folder
/// name — the folder on disk is the canonical case, but the wire/
/// lookup key is lowercase so clients can match loosely.
std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

/// Try to read one AI folder into an AIInfo. Returns false on any
/// failure (missing config, missing entry, missing name field) and
/// logs the reason so the lobby operator can tell which plugin got
/// dropped. A partial success is never returned — either the plugin
/// is valid and gets wired up, or it's skipped entirely.
bool LoadOne(const fs::path& folder, bool isEngine, AIDiscovery::AIInfo& out) {
    // ConfigReader::Load probes `<basePath>.config.lua` first, then
    // `<basePath>.config.json`. Pointing it at `<folder>/ai` makes
    // it look for `ai.config.lua` / `ai.config.json` inside the
    // plugin folder.
    auto cfg = ConfigReader::Config::Load((folder / "ai").string());
    if (!cfg) {
        SLOG(SPRING_LOG_WARNING,
            "skipping %s: no ai.config.lua or ai.config.json found",
            folder.string().c_str());
        return false;
    }

    // `name` is the only mandatory field — an AI without a human
    // label can't be displayed in the lobby, and that's the whole
    // reason a config file exists.
    const std::string name = cfg->GetString("name", "");
    if (name.empty()) {
        SLOG(SPRING_LOG_WARNING,
            "skipping %s: ai.config is missing `name` field",
            folder.string().c_str());
        return false;
    }

    // Default entry point is main.lua in the same folder; authors
    // who split their AI across multiple files can override with
    // the `entry` field. We require the entry file to exist at
    // discovery time so we fail loudly here instead of at game
    // start when the whole room is waiting to load.
    const std::string entryName = cfg->GetString("entry", "main.lua");
    const fs::path entryPath = folder / entryName;
    if (!fs::exists(entryPath)) {
        SLOG(SPRING_LOG_WARNING,
            "skipping %s: entry file '%s' not found",
            folder.string().c_str(), entryName.c_str());
        return false;
    }

    out.id = ToLower(folder.filename().string());
    out.displayName = name;
    out.description = cfg->GetString("description", "");
    out.folderPath = folder.string();
    out.entryPath = entryPath.string();
    out.isEngineProvided = isEngine;
    return true;
}

/// Case-insensitive substring match. Used to filter Chicken-mode
/// LuaAI entries — they're not selectable in the lobby because
/// chicken is a separate game mode toggled by modoptions, not by
/// player AI choice.
bool ContainsCaseInsensitive(const std::string& haystack, const std::string& needle) {
    if (needle.empty()) return true;
    auto it = std::search(
        haystack.begin(), haystack.end(),
        needle.begin(),   needle.end(),
        [](unsigned char a, unsigned char b) {
            return std::tolower(a) == std::tolower(b);
        });
    return it != haystack.end();
}

/// Scan `<gamePath>/LuaAI.lua` for the game's classic Spring "LuaAI"
/// registry. Each entry is a `{name=..., desc=...}` table; the AI
/// itself is not a standalone plugin — it's implemented inside the
/// game's synced LuaRules gadgets, which discover it via
/// `Spring.GetTeamLuaAI(teamId)`. We surface non-Chicken entries as
/// AIInfo so the lobby can list them; the game server short-circuits
/// the AddAI call for `isLuaAI = true` entries (the team roster
/// already drives `GetTeamLuaAI`).
///
/// `id` preserves the original case from LuaAI.lua because that's the
/// exact string the game's gadgets compare against (e.g. ZK's CAI
/// gadget keys `aiConfigByName["CAI"]`). Lowercasing it the way the
/// regular plugin path does would silently break dispatch.
///
/// Filename probe is case-insensitive: real Spring games are
/// inconsistent (`LuaAI.lua` in ZK, `luaai.lua` in some derivatives),
/// and we don't get to demand a canonical case from upstream.
void ScanGameLuaAIFile(const std::string& gamePath,
                       std::vector<AIDiscovery::AIInfo>& out)
{
    fs::path luaAIPath;
    {
        std::error_code ec;
        const fs::path dir(gamePath);
        if (!fs::is_directory(dir, ec)) return;
        for (const auto& e : fs::directory_iterator(dir, ec)) {
            if (!e.is_regular_file(ec)) continue;
            const std::string fname = e.path().filename().string();
            if (fname.size() != 9) continue; // "luaai.lua" length
            std::string lower = fname;
            std::transform(lower.begin(), lower.end(), lower.begin(),
                [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
            if (lower == "luaai.lua") {
                luaAIPath = e.path();
                break;
            }
        }
    }
    if (luaAIPath.empty()) return;

    lua_State* L = luaL_newstate();
    if (!L) {
        SLOG(SPRING_LOG_WARNING, "luaai.lua: lua_newstate failed");
        return;
    }
    luaL_openlibs(L);

    if (luaL_loadfile(L, luaAIPath.string().c_str()) != LUA_OK ||
        lua_pcall(L, 0, 1, 0) != LUA_OK) {
        const char* err = lua_tostring(L, -1);
        SLOG(SPRING_LOG_WARNING, "luaai.lua: %s",
            err ? err : "evaluation failed");
        lua_close(L);
        return;
    }

    if (!lua_istable(L, -1)) {
        SLOG(SPRING_LOG_WARNING, "luaai.lua: did not return a table");
        lua_close(L);
        return;
    }

    int kept = 0, skipped = 0;
    const int len = static_cast<int>(lua_rawlen(L, -1));
    for (int i = 1; i <= len; ++i) {
        lua_rawgeti(L, -1, i);
        if (!lua_istable(L, -1)) { lua_pop(L, 1); continue; }

        lua_getfield(L, -1, "name");
        const std::string name = lua_isstring(L, -1) ? lua_tostring(L, -1) : "";
        lua_pop(L, 1);

        lua_getfield(L, -1, "desc");
        const std::string desc = lua_isstring(L, -1) ? lua_tostring(L, -1) : "";
        lua_pop(L, 1);

        lua_pop(L, 1); // entry table

        if (name.empty()) { skipped++; continue; }

        // Chicken is a special PvE game mode — its "AI" is selected
        // by the chicken_control gadget when modoptions enable it,
        // not by adding a player slot. Don't expose it in the lobby.
        if (ContainsCaseInsensitive(name, "chicken")) {
            skipped++;
            continue;
        }

        // The engine ships a Null AI (content/engine/ai/null/); games
        // that re-declare it in luaai.lua would just produce a
        // duplicate row in the lobby dropdown. Drop the LuaAI copy
        // and let the engine entry stand — it does the same thing
        // (own a team, issue no commands) and the LuaAI variant has
        // no game gadget on the receiving end anyway.
        if (ContainsCaseInsensitive(name, "null ai") ||
            ContainsCaseInsensitive(name, "null_ai")) {
            skipped++;
            continue;
        }

        AIDiscovery::AIInfo info;
        info.id = name;                 // case preserved — see comment above
        info.displayName = name;
        info.description = desc;
        info.folderPath = gamePath;
        info.entryPath = "";            // no standalone entry script
        info.isEngineProvided = false;
        info.isLuaAI = true;
        out.push_back(std::move(info));
        kept++;
    }

    lua_close(L);
    SLOG(SPRING_LOG_INFO, "luaai.lua: %d kept, %d skipped (chicken/empty)",
        kept, skipped);
}

/// Scan `<root>/ai/` for plugin folders and emit matching AIInfo
/// entries into `out`. Missing roots are silent — both the engine
/// root and the game root are optional.
void ScanRoot(const std::string& root, bool isEngine,
              std::vector<AIDiscovery::AIInfo>& out)
{
    const fs::path aiDir = fs::path(root) / "ai";
    if (!fs::exists(aiDir) || !fs::is_directory(aiDir))
        return;

    std::vector<AIDiscovery::AIInfo> found;
    for (const auto& entry : fs::directory_iterator(aiDir)) {
        if (!entry.is_directory()) continue;
        AIDiscovery::AIInfo info;
        if (LoadOne(entry.path(), isEngine, info))
            found.push_back(std::move(info));
    }

    // Sort by id within each group so the lobby UI has a stable
    // order regardless of filesystem enumeration quirks.
    std::sort(found.begin(), found.end(),
        [](const AIDiscovery::AIInfo& a, const AIDiscovery::AIInfo& b) {
            return a.id < b.id;
        });

    for (auto& info : found) {
        out.push_back(std::move(info));
    }
}

} // namespace

namespace AIDiscovery {

std::vector<AIInfo> Discover(
    const std::string& enginePath,
    const std::string& gamePath)
{
    std::vector<AIInfo> all;

    // Engine first so engine AIs appear at the top of the list and
    // game AIs that share an id can override them (by being appended
    // after). We de-duplicate by id below.
    ScanRoot(enginePath, /*isEngine*/ true,  all);
    ScanRoot(gamePath,   /*isEngine*/ false, all);
    // Classic Spring "LuaAI" registry — game-author table that names
    // AIs implemented inside the game's synced gadgets (e.g. ZK's CAI).
    ScanGameLuaAIFile(gamePath, all);

    // Dedupe: if a game AI has the same id as an engine AI, the
    // game one wins. We walk the list in reverse so the last entry
    // with a given id is the one kept, then reverse the result back.
    std::vector<AIInfo> out;
    out.reserve(all.size());
    for (auto it = all.rbegin(); it != all.rend(); ++it) {
        const bool dupe = std::any_of(out.begin(), out.end(),
            [&](const AIInfo& existing) { return existing.id == it->id; });
        if (!dupe) out.push_back(*it);
    }
    std::reverse(out.begin(), out.end());

    SLOG(SPRING_LOG_INFO,
        "discovered %zu AI plugin(s) "
        "(engine root: %s, game root: %s)",
        out.size(), enginePath.c_str(), gamePath.c_str());
    for (const auto& info : out) {
        SLOG(SPRING_LOG_INFO, "  - %s (%s)%s",
            info.displayName.c_str(),
            info.id.c_str(),
            info.isEngineProvided ? " [engine]" : "");
    }

    return out;
}

} // namespace AIDiscovery
