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

/// Coarse archetype tag for a weapon def. The CEG library dispatches
/// by archetype rather than raw projectileType so a few hand-ported ZK CEG
/// signatures can override the generic muzzle/impact effects.
export type WeaponArchetype =
    | 'disintegrator'
    | 'flame'
    | 'lightninggun'
    | 'largelaser'
    | 'lightcannon'
    | 'default';

export function classifyWeaponArchetype(def: WeaponDefInfo | undefined): WeaponArchetype {
    if (!def) return 'default';
    const name = (def.name || '').toLowerCase();
    const tex1 = (def.texture1 || '').toLowerCase();
    const pt = def.projectileType;
    if (pt === ProjectileType.Fireball) return 'disintegrator';
    if (pt === ProjectileType.Flame) return 'flame';
    if (pt === ProjectileType.Lightning || name.includes('lightning')) return 'lightninggun';
    if (pt === ProjectileType.LargeBeamLaser || tex1.includes('largelaser')) return 'largelaser';
    if (pt === ProjectileType.Explosive && def.size <= 4) return 'lightcannon';
    return 'default';
}

/// Per-archetype muzzle flash. Returning null skips the muzzle CEG.
export const FIRE_EFFECT_BY_ARCHETYPE: Record<WeaponArchetype, string | null> = {
    disintegrator: 'muzzleflash_disintegrator',
    flame:         'muzzleflash_flame',
    lightninggun:  'muzzleflash_lightninggun',
    largelaser:    null,
    lightcannon:   null,
    default:       null,
};

/// Per-archetype impact effect. Shield deflections always render
/// `impact_shield` regardless of archetype, and Unit impacts are ceded
/// to combat-fx's CombatEvent path (see effectForImpact below).
export const IMPACT_EFFECT_BY_ARCHETYPE: Record<WeaponArchetype, string | null> = {
    disintegrator: 'impact_disintegrator',
    flame:         'impact_flame',
    lightninggun:  'impact_lightninggun',
    largelaser:    'impact_largelaser',
    lightcannon:   'impact_lightcannon',
    default:       null,
};

/// Pick the muzzle CEG name for a weapon firing event. Streamed
/// `cegTag` wins over heuristic dispatch; null means render no muzzle.
export function effectForFire(def: WeaponDefInfo | undefined): string | null {
    if (def?.cegTag) {
        const tag = def.cegTag;
        // Spring's documented sentinel for "no CEG" — skip explicitly.
        if (tag.toLowerCase() === 'none') return null;
        return tag;
    }
    return FIRE_EFFECT_BY_ARCHETYPE[classifyWeaponArchetype(def)];
}

/// Pick the impact CEG name from impact kind + weapon archetype.
///
/// `forceWeaponDispatch=true` overrides the Unit-skip behaviour, which
/// projectile-renderer needs (it cedes Unit impacts to combat-fx's
/// CombatEvent path) but combat-fx itself needs to honour when it's
/// the one driving the explosion.
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
    return IMPACT_EFFECT_BY_ARCHETYPE[classifyWeaponArchetype(def)];
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
