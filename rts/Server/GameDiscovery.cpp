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
#include "System/SpringLog/SpringLog.h"

#define LOG_SECTION "game-disc"

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
    // modinfo authors differ on casing — ZK uses `shortname`, BAR uses
    // `shortName`. GetString is case-sensitive, so try both.
    std::string shortName = cfg->GetString("shortName", "");
    if (shortName.empty())
        shortName = cfg->GetString("shortname", "");
    // `lighting` selects the client-side shader variant. Default
    // `"gameplay"` matches the half-Lambert + 0.45-ambient formula the
    // codebase shipped with; `"realistic"` switches to true Lambert
    // with stronger front/back contrast. The lobby surfaces the value
    // verbatim and lets the client decide how to interpret it — adding
    // a new style is a client-only change here.
    std::string lighting = cfg->GetString("lighting", "gameplay");
    // `modelMaterialPort` names the client model-material port the game
    // wants applied (PLAN-bar.md A4). Empty default ⇒ engine-default
    // material. The client decides whether its hand-port matches this id;
    // the lobby just relays the string. Legacy games (ZK) hand-declare it
    // in modinfo; the proper fix is for gameconverter to fingerprint the
    // template and emit it at conversion time.
    std::string modelMaterialPort = cfg->GetString("modelMaterialPort", "");
    // `archived` marks a game that is still on disk but does not run
    // (PLAN-endtoend.md D26). Data-driven rather than an id list in the
    // lobby binary, so archiving the next game is one line in its config
    // and no C++ change. Defaults false: silence means playable, which is
    // the only safe direction — a parse slip must not make a live game
    // unpickable.
    bool archived = cfg->GetBool("archived", false);
    std::string archivedReason = cfg->GetString("archivedReason", "");
    // `resourceEconomy` says whether metal/energy mean anything in this
    // game (PLAN-endtoend.md D9). Defaults TRUE — the opposite direction to
    // `archived`, and for the same reason: silence must not remove a
    // surface a legacy game needs. Only a game that explicitly says it has
    // no resource economy (Metalstorm) loses the client's economy bar.
    bool resourceEconomy = cfg->GetBool("resourceEconomy", true);

    // Fall back to the folder name if the config doesn't declare
    // one. Keeps the game visible even if an author forgot the
    // field in an early-draft config.
    if (name.empty()) {
        name = folder.filename().string();
        SLOG(SPRING_LOG_WARNING,
            "%s: config has no `name` field, using folder name",
            folder.string().c_str());
    }

    out.id = ToLower(folder.filename().string());
    out.displayName = name;
    // Fall back to the uppercased id when modinfo omits a short name.
    if (shortName.empty()) {
        shortName = out.id;
        for (auto& c : shortName)
            c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    }
    out.shortName = shortName;
    out.description = description;
    out.version = version;
    out.lighting = lighting;
    out.modelMaterialPort = modelMaterialPort;
    out.archived = archived;
    out.archivedReason = archivedReason;
    out.resourceEconomy = resourceEconomy;
    out.folderPath = folder.string();
    return true;
}

} // namespace

namespace GameDiscovery {

std::vector<GameInfo> Discover(const std::string& gamesDir) {
    std::vector<GameInfo> out;

    const fs::path root(gamesDir);
    if (!fs::exists(root) || !fs::is_directory(root)) {
        SLOG(SPRING_LOG_ERROR,
            "games directory '%s' does not exist",
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

    SLOG(SPRING_LOG_INFO, "discovered %zu game(s) in '%s'",
        out.size(), gamesDir.c_str());
    for (const auto& info : out) {
        SLOG(SPRING_LOG_INFO, "  - %s (%s)%s%s%s",
            info.displayName.c_str(), info.id.c_str(),
            info.version.empty() ? "" : " v",
            info.version.c_str(),
            info.archived ? " [archived]" : "");
    }

    return out;
}

const GameInfo* FindById(const std::vector<GameInfo>& games,
                         const std::string& id) {
    for (const auto& g : games)
        if (g.id == id) return &g;
    return nullptr;
}

const GameInfo* DefaultPlayable(const std::vector<GameInfo>& games) {
    for (const auto& g : games)
        if (!g.archived) return &g;
    return nullptr;
}

} // namespace GameDiscovery
