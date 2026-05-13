// ResourcesParser — parse Spring's `gamedata/resources.lua` into JSON.
//
// resources.lua is a small Lua script that runs inside Spring's VFS
// environment to define the game's projectile-texture name → file
// path map (and a few related categories: groundfx, smoke, scars,
// caustics, trees, maps). Both the engine base and each game ship
// their own copy; the game's overrides the engine's.
//
// The lobby calls `ParseGameResources(gameId)` once per game on first
// request and caches the JSON result; the client fetches the JSON,
// looks up logical names against it, and resolves them to .ktx2 URLs
// via the recursive bitmaps manifest.
//
// We deliberately don't reuse ConfigReader because resources.lua
// needs more VFS surface than config files (Include with mode-aware
// game-then-engine fallback, FileExists, mode constants, plus the
// Script.IsEngineMinVersion stub ZK's scars.lua exercises). All
// dependencies are file-local — no link to the rts/Lua subsystem.
#pragma once

#include <string>
#include <unordered_set>

namespace ResourcesParser {

/// Parse `<gameDir>/gamedata/resources.lua` (with engine fallback
/// at `cont/base/springcontent/`) and return a JSON serialisation
/// of the returned table. Returns an empty string on any error;
/// the calling code should treat that as "no resource data" and
/// fall back to bare-name lookup.
///
/// `gameId` is used only for logging.
std::string ParseGameResources(const std::string& gameId,
                               const std::string& gameDir,
                               const std::string& engineBaseDir);

/// Parse the same `gamedata/resources.lua` and return just the keys
/// of `graphics.projectiletextures`. Used by the weapon-def baker to
/// decide between a primary texture name and its fallback when
/// applying Spring's per-`weaponType` defaults (Recoil's
/// CProjectileDrawer::LoadWeaponTextures). Returns an empty set on
/// any error.
std::unordered_set<std::string> GetProjectileTextureNames(
    const std::string& gameId,
    const std::string& gameDir,
    const std::string& engineBaseDir);

} // namespace ResourcesParser
