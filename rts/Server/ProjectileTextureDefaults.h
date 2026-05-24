/* This file is part of the Spring engine (GPL v2 or later), see LICENSE.html */

/* ResolveProjectileTextureDefaults — apply Spring's per-`weaponType`
 * projectile-texture defaults. Extracted from Protocol.h so both
 * the (legacy) FlatBuffer weapon-def serializer and the new
 * LuaDefsSerializer can use it without dragging in the rest of
 * Protocol.h's FB plumbing.
 *
 * Originally lived in upstream Recoil's `CProjectileDrawer::
 * LoadWeaponTextures`. Server-side rendering is gone but the
 * defaults are still authoritative for which texture name each
 * weapon archetype expects — the client's resolver looks them up
 * against the game's bitmap manifest.
 */

#pragma once

#include <array>
#include <string>
#include <unordered_set>

/// `availableNames`, when non-null, is the set of keys in the
/// parsed `graphics.projectiletextures` table. When a default has a
/// fallback name (e.g. `missileflaretexture → flare`) and the
/// primary is absent from `availableNames`, the fallback is written
/// in its place. With `availableNames == nullptr` the primary is
/// always used and the client's resolver picks up any further
/// fallback.
inline std::array<std::string, 4> ResolveProjectileTextureDefaults(
    const std::string& weaponType,
    bool largeBeamLaser,
    const std::array<std::string, 4>& source,
    const std::unordered_set<std::string>* availableNames)
{
    std::array<std::string, 4> out = source;

    auto pick = [&](const char* primary, const char* fallback) -> std::string {
        if (!availableNames || !fallback) return primary;
        if (availableNames->count(primary)) return primary;
        return fallback;
    };

    if (weaponType == "Cannon" || weaponType == "EmgCannon"
        || weaponType == "AircraftBomb" || weaponType == "TorpedoLauncher") {
        if (out[0].empty()) out[0] = pick("plasmatexture", "circularthingy");
    } else if (weaponType == "Shield") {
        if (out[0].empty()) out[0] = pick("perlintex", "flare");
    } else if (weaponType == "Flame") {
        if (out[0].empty()) out[0] = "flame";
    } else if (weaponType == "MissileLauncher") {
        if (out[0].empty()) out[0] = pick("missileflaretexture", "flare");
        if (out[1].empty()) out[1] = pick("missiletrailtexture", "smoketrail");
    } else if (weaponType == "LaserCannon") {
        if (out[0].empty()) out[0] = "laserfalloff";
        if (out[1].empty()) out[1] = "laserend";
    } else if (weaponType == "BeamLaser") {
        if (largeBeamLaser) {
            if (out[0].empty()) out[0] = "largebeam";
            if (out[1].empty()) out[1] = "laserend";
            if (out[2].empty()) out[2] = "muzzleside";
            if (out[3].empty()) out[3] = pick("beamlaserflaretexture", "flare");
        } else {
            if (out[0].empty()) out[0] = "laserfalloff";
            if (out[1].empty()) out[1] = "laserend";
            if (out[2].empty()) out[2] = pick("beamlaserflaretexture", "flare");
        }
    } else if (weaponType == "LightningCannon") {
        if (out[0].empty()) out[0] = "laserfalloff";
    } else if (weaponType == "StarburstLauncher") {
        if (out[0].empty()) out[0] = pick("sbflaretexture", "flare");
        if (out[1].empty()) out[1] = pick("sbtrailtexture", "smoketrail");
        if (out[2].empty()) out[2] = "explo";
    } else {
        if (out[0].empty()) out[0] = pick("plasmatexture", "circularthingy");
        if (out[1].empty()) out[1] = pick("plasmatexture", "circularthingy");
    }
    return out;
}
