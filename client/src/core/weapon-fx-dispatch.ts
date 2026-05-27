/**
 * Shared weapon-VFX dispatch helpers.
 *
 * Centralises the mapping from (weaponDef, impactKind) -> named CEG
 * effect. Owned by the projectile renderer historically, lifted into
 * its own module so combat-fx can spawn matching impact CEGs without
 * a circular import.
 */

import type { WeaponDefInfo } from './connection.js';

/// Mirrors `SpringWeb::ProjectileImpactKind` in protocol.fbs.
/// Regular enum (not `const enum`) so the constants survive cross-module
/// import without depending on isolatedModules / bundler behaviour.
export enum ImpactKind {
    Terrain = 0,
    Unit = 1,
    Feature = 2,
    Shield = 3,
    SelfDetonate = 4,
    Intercepted = 5,
    Other = 6,
}

/// Mirrors Recoil's `WEAPON_*_PROJECTILE` bitmask in
/// `rts/Sim/Projectiles/WeaponProjectiles/WeaponProjectileTypes.h`. The
/// server emits this value directly from `WeaponDef::projectileType`,
/// which Recoil's `CWeaponDef` populates per weapon-type. Each value
/// names the projectile class that gets spawned, which is the right
/// granularity for the renderer dispatch (BeamLaser ≠ LaserCannon,
/// Starburst ≠ Missile, etc.).
export enum ProjectileType {
    Base           = 1 << 0,
    BeamLaser      = 1 << 1,
    Emg            = 1 << 2,
    Explosive      = 1 << 3,   // Cannon, AircraftBomb
    Fireball       = 1 << 4,   // DGun
    Flame          = 1 << 5,
    LargeBeamLaser = 1 << 6,   // BeamLaser with largeBeamLaser=true
    Laser          = 1 << 7,   // LaserCannon
    Lightning      = 1 << 8,
    Missile        = 1 << 9,
    Starburst      = 1 << 10,
    Torpedo        = 1 << 11,
}

/// Name of the runtime's built-in fallback explosion. Mirrors the
/// `DEFAULT_EXPLOSION_NAME` constant in ceg-runtime.ts (kept in sync
/// by hand — the dispatch module shouldn't import from the runtime
/// just to read one string). Used by `effectForImpact` when the
/// weapondef doesn't author an `explosionGenerator` so terrain/feature
/// hits always render *something* instead of silently no-opping.
const DEFAULT_EXPLOSION_NAME = '__default_explosion';

/// Pick the muzzle CEG name for a weapon firing event. Streamed
/// `cegTag` wins; weapons that didn't author one render no muzzle.
/// (Before Phase 8 cleanup, archetype-keyed placeholders supplied a
/// muzzle flash for every weapon — those have been removed in favour
/// of relying on the streamed CEG library plus authored cegTag.)
export function effectForFire(def: WeaponDefInfo | undefined): string | null {
    if (!def?.cegTag) return null;
    const tag = def.cegTag;
    // Spring's documented sentinel for "no CEG" — skip explicitly.
    if (tag.toLowerCase() === 'none') return null;
    return tag;
}

/// Pick the impact CEG name from impact kind + weapondef.
///
/// `forceWeaponDispatch=true` overrides the Unit-skip behaviour, which
/// projectile-renderer needs (it cedes Unit impacts to combat-fx's
/// CombatEvent path) but combat-fx itself needs to honour when it's
/// the one driving the explosion.
///
/// Fallback chain (after Phase 8 cleanup): Shield → `impact_shield`;
/// authored `explosionGenerator` → that tag; otherwise →
/// `__default_explosion` so terrain/feature impacts always render the
/// runtime's built-in flash + heat cloud. Unit impacts still cede to
/// combat-fx unless `forceWeaponDispatch`.
export function effectForImpact(
    impactKind: number,
    def: WeaponDefInfo | undefined,
    forceWeaponDispatch: boolean = false,
): string | null {
    const kind = impactKind as ImpactKind;
    if (kind === ImpactKind.Shield) return 'impact_shield';
    if (kind === ImpactKind.Unit && !forceWeaponDispatch) return null;

    if (def?.explosionGenerator) {
        const tag = def.explosionGenerator;
        if (tag.toLowerCase() === 'none') return null;
        return tag;
    }
    return DEFAULT_EXPLOSION_NAME;
}

/// Map an impact event onto the CEG visibility-context bits — same
/// bit layout as `CEG_FLAG_*` in ceg-runtime.ts. Spring's water level
/// is fixed at y = 0; anything below is in-water / underwater.
export function impactContextFlags(impactKind: number, posY: number): number {
    let flags = 0;
    const inWater = posY < 0;
    if (inWater) {
        flags |= 1 << 2;             // CEG_FLAG_WATER
        if (posY < -8) flags |= 1 << 4;   // CEG_FLAG_UNDERWATER
    }
    if (impactKind === ImpactKind.Unit) {
        flags |= 1 << 3;             // CEG_FLAG_UNIT
    } else if (!inWater) {
        flags |= 1 << 0;             // CEG_FLAG_GROUND
    }
    return flags;
}
