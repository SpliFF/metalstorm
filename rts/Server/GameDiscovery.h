// GameDiscovery — enumerate game plugins under the games directory.
//
// A "game" is a folder that contains (at minimum) a `modinfo.lua`
// file following Spring's standard shape:
//
//     return {
//         name        = 'Paper Tanks',
//         shortName   = 'papertanks',
//         description = '…',
//         version     = '0.1',
//         ...
//     }
//
// We parse it with the same lightweight regex approach used by
// AIDiscovery — no Lua VM in the lobby binary — which is safe for
// the small handful of string fields the lobby cares about. Authors
// who want rich behaviour still have the real Lua interpreter at
// game-server startup; this discovery path exists only to populate
// the room browser's "create game" UI.
//
// Discovery happens once at lobby startup. Each `GameInfo` holds
// the filesystem path to the game folder, which is what the lobby
// hands to `spawnGameServer` when the host starts the room.
#pragma once

#include <string>
#include <vector>

namespace GameDiscovery {

/// One discovered game plugin.
struct GameInfo {
    /// Stable identifier — derived from the folder name, lowercased.
    /// Matches `shortName` in modinfo.lua by convention but we trust
    /// the folder name for uniqueness (authors might ship a modinfo
    /// with a stale shortName after renaming their directory).
    std::string id;

    /// Human-readable name from modinfo.lua's `name` field. Falls
    /// back to the folder name if the field is missing or empty.
    std::string displayName;

    /// Optional description from modinfo.lua's `description` field.
    /// May be empty.
    std::string description;

    /// Optional version string from modinfo.lua's `version` field.
    /// May be empty.
    std::string version;

    /// Absolute path to the game folder on disk (e.g. "data/games/papertanks").
    /// Used for content loading and AI discovery.
    std::string folderPath;
};

/// Scan `gamesDir` (default: data/games) for subdirectories
/// containing a `modinfo.lua`, parse each, and return a sorted
/// vector of `GameInfo`. Missing `gamesDir` returns an empty
/// vector — the lobby will still run, it just has no games to
/// offer until one is added.
std::vector<GameInfo> Discover(const std::string& gamesDir);

} // namespace GameDiscovery
