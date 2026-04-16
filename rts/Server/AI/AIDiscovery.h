// AIDiscovery — enumerate AI plugins from game and engine content
// directories.
//
// An "AI plugin" is a folder containing:
//   - ai.config.json and/or ai.config.lua (metadata, read via LuaConfig)
//   - main.lua                            (entry point, run by AIRuntimePool)
//
// The config minimally needs a `name` field (human-readable label shown
// in the lobby). Optional fields: `description`, `version`, `author`,
// `entry` (overrides the default main.lua filename).
//
// Discovery scans two roots, in this order, and merges the results:
//
//   content/engine/ai/<plugin>/    — engine-provided AIs (e.g. "Null AI")
//   <gamePath>/ai/<plugin>/        — game-provided AIs  (e.g. papertanks/ai/basic_ai/)
//
// Duplicate names resolve in favour of the game directory so a game
// can shadow an engine default if it wants to. The `id` field of each
// AIInfo is the folder name (lowercase, usable as a stable key on the
// wire); the `displayName` is the config's human-readable `name`.
//
// The discovery list is immutable for the lifetime of a lobby
// process; games and engine content don't change at runtime. Lobby
// callers hold onto the vector and reference entries by `id` or by
// index into the vector.
#pragma once

#include <string>
#include <vector>

namespace AIDiscovery {

/// One discovered AI plugin.
struct AIInfo {
    /// Stable identifier — derived from the folder name, lowercased.
    /// This is what goes on the wire in RoomAddAI and what the game
    /// server uses to resolve the AI on startup. Unique within a
    /// DiscoveryResult.
    std::string id;

    /// Human-readable name from ai.config (`name` field). Shown in
    /// the lobby UI. Not guaranteed unique across plugins.
    std::string displayName;

    /// Optional description from ai.config (`description` field).
    /// May be empty.
    std::string description;

    /// Absolute path to the AI folder on disk. Used by the game
    /// server when it needs to locate main.lua at startup.
    std::string folderPath;

    /// Absolute path to the AI's Lua entry point — by default
    /// `<folderPath>/main.lua`, overridden by the config's `entry`
    /// field if present.
    std::string entryPath;

    /// Whether this plugin came from the engine root (true) or the
    /// game root (false). Useful for UIs that want to visually
    /// distinguish built-ins from game-authored AIs.
    bool isEngineProvided = false;
};

/// Discover all AIs in the engine root and the given game root.
///
/// `enginePath` is typically `content/engine` (relative to the
/// working directory) — the folder that contains `ai/<plugin>/`.
/// `gamePath` is typically `data/games/<gameId>` — its `ai/`
/// subdirectory is scanned if it exists. Missing directories are
/// silently skipped; a lobby that ships no game-specific AIs still
/// gets the engine defaults.
///
/// Entries are returned in a stable order (engine first, then game,
/// each group sorted by id) so the lobby UI doesn't reshuffle.
std::vector<AIInfo> Discover(
    const std::string& enginePath,
    const std::string& gamePath);

} // namespace AIDiscovery
