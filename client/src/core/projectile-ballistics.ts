/**
 * Which projectiles the client should integrate gravity for, and in which
 * direction.
 *
 * Kept in its own module (rather than inside `projectile-renderer.ts`) so the
 * rule is a pure, headless-testable predicate — the renderer itself pulls in
 * Babylon and `config.ts`, neither of which loads outside a browser.
 *
 * See `projectile-gravity.test.ts` for the measurements that motivated this.
 */

import { ProjectileType } from './weapon-fx-dispatch.js';

/// Projectile classes whose sim counterpart actually integrates
/// `mygravity`. Every `CWeaponProjectile` subclass overrides `Update()`, and
/// only these five add `UpVector * mygravity` — see
/// `rts/Sim/Projectiles/WeaponProjectiles/{Explosive,FireBall,Missile,
/// Starburst,Torpedo}Projectile.cpp`. Lasers, beams, EMG, flame and lightning
/// fly dead straight in the sim.
///
/// The wire carries `mygravity` unconditionally (the server sends the field
/// for every projectile, gravity-affected or not), so the client has to apply
/// this gate itself. Without it, straight-flying bolts got a ballistic arc the
/// sim never gave them and drifted off the aim ray.
const BALLISTIC_PROJECTILE_TYPES =
    ProjectileType.Explosive |
    ProjectileType.Fireball |
    ProjectileType.Missile |
    ProjectileType.Starburst |
    ProjectileType.Torpedo;

/**
 * Whether a projectile of this type should have gravity integrated
 * client-side. Unknown/absent types fall through to `false` — a bolt that
 * flies straight when it should arc is a far smaller visual error than one
 * that curves away from its target.
 */
export function isBallistic(projectileType: number | undefined): boolean {
    return projectileType !== undefined
        && (projectileType & BALLISTIC_PROJECTILE_TYPES) !== 0;
}
