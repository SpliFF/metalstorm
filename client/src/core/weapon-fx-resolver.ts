/**
 * weapon-fx-resolver — weapon def → Metalstorm native-FX slots.
 *
 * PURE DATA MODULE (no GL, no Babylon, no I/O): the one place that answers
 * "what does this weapon look like" for the native FX stack, so the dispatch
 * sites in combat-fx.ts / projectile-renderer.ts stay one `if` each.
 *
 * Resolution order is effect-compiler.ts's, unchanged: exact weapon entry →
 * `defaults[weapontype]` → `__fallback`. Two things are added here that the
 * compiler deliberately does not know about:
 *
 *  - case-insensitive exact lookup. `weapon-fx.json` is authored against
 *    weapons.lua's UPPERCASE keys (`MS_AC_S2`); the engine lowercases weapon
 *    def names on the way to the client, so a literal lookup would miss every
 *    weapon and silently fall through to `__fallback`.
 *  - `weaponTypeForProjectileType`, because `WeaponDefInfo` streams Recoil's
 *    `projectileType` bitmask rather than the authored `weapontype` string.
 *
 * `ceg-runtime` stays the path for maps, features and the ZK/BAR games: a
 * Metalstorm resolver hit wins, anything else keeps the existing path.
 */

import {
    resolveWeaponFx as resolveSlots,
    type WeaponFxMap,
    type WeaponFxSlots,
} from './native-fx/effect-compiler.js';
import { ProjectileType } from './weapon-fx-dispatch.js';

export type { WeaponFxMap, WeaponFxSlots };

/** Lower-cased index per map object; built once, lives as long as the map. */
const indexCache = new WeakMap<WeaponFxMap, Map<string, WeaponFxSlots>>();

function indexOf(map: WeaponFxMap): Map<string, WeaponFxSlots> {
    let idx = indexCache.get(map);
    if (idx) return idx;
    idx = new Map<string, WeaponFxSlots>();
    for (const [name, slots] of Object.entries(map.weapons ?? {})) {
        idx.set(name.toLowerCase(), slots);
    }
    indexCache.set(map, idx);
    return idx;
}

/**
 * Resolve one weapon's FX slots. Always returns slots (`__fallback` is the
 * floor); `slotsHaveEffects` is the "did this actually resolve to anything
 * drawable" test the dispatch sites branch on.
 */
export function resolveWeaponFx(
    map: WeaponFxMap, weaponDefName: string, weapontype?: string,
): WeaponFxSlots {
    const exact = indexOf(map).get(weaponDefName.toLowerCase());
    if (exact) return exact;
    // No case-insensitive hit — hand the rest of the chain (defaults →
    // __fallback) back to the compiler so there is one implementation of it.
    return resolveSlots(map, weaponDefName, weapontype);
}

/** True when the slots name at least one library effect (i.e. drawing them
 *  through the native stack is better than the Babylon fallback). */
export function slotsHaveEffects(s: WeaponFxSlots | null | undefined): boolean {
    return !!s && !!(s.muzzle || s.projectile || s.trail || s.impact);
}

/**
 * Recoil `projectileType` bitmask → the authored `weapontype` string
 * `weapon-fx.json.defaults` is keyed by. Only the four types Metalstorm
 * authors defaults for are mapped; anything else returns undefined and the
 * chain falls through to `__fallback`.
 */
export function weaponTypeForProjectileType(projectileType: number): string | undefined {
    if (projectileType & ProjectileType.Missile) return 'MissileLauncher';
    if (projectileType & ProjectileType.Starburst) return 'MissileLauncher';
    if (projectileType & ProjectileType.Torpedo) return 'TorpedoLauncher';
    if (projectileType & ProjectileType.Explosive) return 'Cannon';
    return undefined;
}

/**
 * What a dispatch site needs from the live native-FX system. Implemented by
 * the game-processor's FX pass (native-fx/fx-game-loader.ts); combat-fx and
 * projectile-renderer hold one of these and nothing else, so neither pulls GL
 * or the worker loader into its import graph.
 */
export interface NativeFxSink {
    /** Slots for a weapon def, or null when no native FX library is loaded. */
    resolve(weaponDefName: string, projectileType?: number): WeaponFxSlots | null;
    /** Does the loaded library define this effect name? */
    has(effect: string): boolean;
    /** Spawn a named library effect at a point, emitting along (dx, dy, dz). */
    spawn(effect: string, x: number, y: number, z: number,
        dx: number, dy: number, dz: number): void;
    /**
     * Cosmetic tracers for a statistical volley: `rounds` copies of `effect`
     * travelling from → to, each jittered within `spreadDeg` of the line, the
     * whole burst spread over `burstSec`.
     */
    volleyTracers(effect: string,
        from: { x: number; y: number; z: number },
        to: { x: number; y: number; z: number },
        rounds: number, spreadDeg: number, burstSec: number): void;
    /** Raise a ground scar for an impact (routed to the decal overlay's
     *  existing `onSnapshot(scars, …)` path by the game-processor). */
    scar(x: number, y: number, z: number, radius: number): void;
}
