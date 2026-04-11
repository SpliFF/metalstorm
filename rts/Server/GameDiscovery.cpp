// GameDiscovery — implementation. See GameDiscovery.h for the design.
//
// Uses ConfigReader (a tiny Lua-backed loader, see ConfigReader.h)
// rather than the sim's LuaConfigLoader so the lobby binary doesn't
// have to link against the full rts/Lua/ dep tree. ConfigReader
// follows the same `.config.lua` / `.config.json` convention as
// LuaConfigLoader but spins up a bare lua_State — good enough for
// flat metadata tables like the one we need here.
//
// Expected shape at `<game>/game.config.lua` or `<game>/game.config.json`:
//
//     return {
//         name        = "Paper Tanks",
//         description = "Minimalist cardboard-cutout RTS demo",
//         version     = "0.1",
//     }

#include "GameDiscovery.h"
#include "ConfigReader.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <filesystem>
#include <string>

namespace fs = std::filesystem;

namespace {

/// Lowercase a string — used to derive the stable id from the
/// folder name.
std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
        [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

/// Parse one game folder into a GameInfo. Returns false if the
/// folder isn't a recognised game (no `game.config.{lua,json}`);
/// missing optional fields inside the config are tolerated and
/// filled with fallbacks so a barebones config still produces a
/// usable entry in the lobby UI.
bool LoadOne(const fs::path& folder, GameDiscovery::GameInfo& out) {
    // ConfigReader::Load probes `<basePath>.config.lua` first, then
    // `<basePath>.config.json`, matching the rest of the project's
    // config convention. We point it at `<folder>/game` so it looks
    // for `game.config.lua` / `game.config.json` inside the folder.
    auto cfg = ConfigReader::Config::Load((folder / "game").string());
    if (!cfg) {
        // Not a game folder as far as the lobby is concerned. A
        // folder may still have a legacy Spring `modinfo.lua` — and
        // the sim's full ModInfo::Init will parse that at game-start
        // time — but for *discovery* we require the explicit
        // `game.config.{lua,json}` so the lobby has a guaranteed
        // shape to read from without running the sim Lua API.
        return false;
    }

    std::string name = cfg->GetString("name", "");
    std::string description = cfg->GetString("description", "");
    std::string version = cfg->GetString("version", "");

    // Fall back to the folder name if the config doesn't declare
    // one. Keeps the game visible even if an author forgot the
    // field in an early-draft config.
    if (name.empty()) {
        name = folder.filename().string();
        std::fprintf(stderr,
            "[game] %s: config has no `name` field, using folder name\n",
            folder.string().c_str());
    }

    out.id = ToLower(folder.filename().string());
    out.displayName = name;
    out.description = description;
    out.version = version;
    out.folderPath = folder.string();
    return true;
}

} // namespace

namespace GameDiscovery {

std::vector<GameInfo> Discover(const std::string& gamesDir) {
    std::vector<GameInfo> out;

    const fs::path root(gamesDir);
    if (!fs::exists(root) || !fs::is_directory(root)) {
        std::fprintf(stderr,
            "[game] games directory '%s' does not exist\n",
            gamesDir.c_str());
        return out;
    }

    for (const auto& entry : fs::directory_iterator(root)) {
        if (!entry.is_directory()) continue;
        GameInfo info;
        if (LoadOne(entry.path(), info))
            out.push_back(std::move(info));
    }

    // Stable alphabetical order so the lobby UI's "create game"
    // dropdown doesn't reshuffle between restarts.
    std::sort(out.begin(), out.end(),
        [](const GameInfo& a, const GameInfo& b) {
            return a.id < b.id;
        });

    std::fprintf(stderr, "[game] discovered %zu game(s) in '%s'\n",
        out.size(), gamesDir.c_str());
    for (const auto& info : out) {
        std::fprintf(stderr, "[game]   - %s (%s)%s%s\n",
            info.displayName.c_str(), info.id.c_str(),
            info.version.empty() ? "" : " v",
            info.version.c_str());
    }

    return out;
}

} // namespace GameDiscovery
