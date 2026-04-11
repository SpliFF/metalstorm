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
        std::fprintf(stderr,
            "[ai] skipping %s: no ai.config.lua or ai.config.json found\n",
            folder.string().c_str());
        return false;
    }

    // `name` is the only mandatory field — an AI without a human
    // label can't be displayed in the lobby, and that's the whole
    // reason a config file exists.
    const std::string name = cfg->GetString("name", "");
    if (name.empty()) {
        std::fprintf(stderr,
            "[ai] skipping %s: ai.config is missing `name` field\n",
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
        std::fprintf(stderr,
            "[ai] skipping %s: entry file '%s' not found\n",
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

    std::fprintf(stderr,
        "[ai] discovered %zu AI plugin(s) "
        "(engine root: %s, game root: %s)\n",
        out.size(), enginePath.c_str(), gamePath.c_str());
    for (const auto& info : out) {
        std::fprintf(stderr, "[ai]   - %s (%s)%s\n",
            info.displayName.c_str(),
            info.id.c_str(),
            info.isEngineProvided ? " [engine]" : "");
    }

    return out;
}

} // namespace AIDiscovery
