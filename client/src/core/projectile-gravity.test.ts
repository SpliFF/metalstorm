/**
 * Regression: client-side ballistic integration must match the sim's.
 *
 * Measured 2026-08-04 on ZK (`green_flat_x34_v3`, four `shieldraid` vs one):
 * the sim's own projectiles sat 22.8–30.0 elmos above ground along the whole
 * flight, while the client's live set had `vel.y` of +230…+375 elmos/s and
 * climbing. Every bolt accelerated upward out of the play area, leaving only
 * the ground-projected CEG flashes visible — which reads exactly like "the
 * shots hit the ground instead of the units".
 *
 * Two independent defects produced that:
 *
 *  1. **Sign.** The wire's `gravity` is the sim's `mygravity`, which is
 *     ALREADY negative for downward pull (`rts/Map/MapInfo.cpp`:
 *     `map.gravity = -map.gravity / (GAME_SPEED * GAME_SPEED)`). The sim ADDS
 *     it (`CProjectile::Update`: `SetVelocityAndSpeed(speed + UpVector *
 *     mygravity)`), so the client must add it too. It subtracted.
 *
 *  2. **Gating.** Every `CWeaponProjectile` subclass overrides `Update()`, and
 *     only Explosive / FireBall / Missile / Starburst / Torpedo add
 *     `mygravity`. Lasers, beams, EMG, flame and lightning fly dead straight
 *     in the sim. The server sends the `gravity` field regardless, so the
 *     client has to gate on projectile type or it bends straight-flying bolts
 *     off the aim ray.
 *
 * The sim's aim itself was measured correct and is NOT what these tests pin:
 * the BeamLaser's firing ray matched the exact muzzle→target geometry
 * (`dirY = -0.0927` vs the geometric `-0.0929`) and both beam and cannon
 * landed damage. That measurement came from the `aim-origin-probe` bench
 * scenario, which was retired 2026-08-04 with the ZK port (Metalstorm has
 * no hit-scan weapon, so the beam-vs-ballistic discriminator it relied on
 * cannot be built) — the finding stands, the harness that produced it is
 * gone.
 */

import { describe, it, expect } from 'vitest';
import { isBallistic } from './projectile-ballistics.js';
import { ProjectileType } from './weapon-fx-dispatch.js';

/** The client's per-tick integration, extracted verbatim from
 *  `ProjectileRenderer.tick()` so the sign is pinned independently of the
 *  Babylon-dependent renderer (which can't be constructed headless). */
function step(p: { y: number; vy: number; gravity: number }, dt: number): void {
    p.vy += p.gravity * dt;
    p.y += p.vy * dt;
}

/** The sim's integration, per `CProjectile::Update()`. Works in per-frame
 *  units (elmos/frame, elmos/frame²) exactly as the sim does. */
function simStep(p: { y: number; vy: number; mygravity: number }): void {
    p.vy += p.mygravity;
    p.y += p.vy;
}

const GAME_SPEED = 30;
/** A map `gravity = 130` becomes this per-frame² value — negative. */
const MAP_GRAVITY_PER_FRAME2 = -130 / (GAME_SPEED * GAME_SPEED);

describe('projectile gravity sign', () => {
    it('wire gravity is negative for downward pull', () => {
        expect(MAP_GRAVITY_PER_FRAME2).toBeLessThan(0);
    });

    it('a ballistic shell falls rather than climbs', () => {
        const p = { y: 100, vy: 0, gravity: MAP_GRAVITY_PER_FRAME2 * GAME_SPEED * GAME_SPEED };
        for (let i = 0; i < 30; i++) step(p, 1 / GAME_SPEED);
        expect(p.vy).toBeLessThan(0);
        expect(p.y).toBeLessThan(100);
    });

    it('client integration matches the sim exactly over a full second', () => {
        // Same launch state, same elapsed time, different unit systems. With
        // the client using the sim's semi-implicit ordering (gravity, then
        // position) the two agree to floating-point noise — not merely
        // "close enough".
        const client = { y: 100, vy: 60, gravity: MAP_GRAVITY_PER_FRAME2 * GAME_SPEED * GAME_SPEED };
        const sim = { y: 100, vy: 60 / GAME_SPEED, mygravity: MAP_GRAVITY_PER_FRAME2 };
        for (let i = 0; i < GAME_SPEED; i++) {
            step(client, 1 / GAME_SPEED);
            simStep(sim);
        }
        expect(client.y).toBeCloseTo(sim.y, 6);
        expect(client.vy).toBeCloseTo(sim.vy * GAME_SPEED, 6);
    });

    it('integrating position before gravity drifts off the sim', () => {
        // Pins WHY the ordering matters: the discarded ordering diverges by
        // |g| * dt * elapsed, which is what walked long shots off target.
        const dt = 1 / GAME_SPEED;
        const g = MAP_GRAVITY_PER_FRAME2 * GAME_SPEED * GAME_SPEED;
        const posFirst = { y: 100, vy: 60 };
        const sim = { y: 100, vy: 60 / GAME_SPEED, mygravity: MAP_GRAVITY_PER_FRAME2 };
        for (let i = 0; i < GAME_SPEED; i++) {
            posFirst.y += posFirst.vy * dt;
            posFirst.vy += g * dt;
            simStep(sim);
        }
        expect(Math.abs(posFirst.y - sim.y)).toBeCloseTo(Math.abs(g) * dt * 1.0, 6);
    });

    it('the old subtracting form sent shells upward (the reported bug)', () => {
        const p = { y: 100, vy: 0, gravity: MAP_GRAVITY_PER_FRAME2 * GAME_SPEED * GAME_SPEED };
        for (let i = 0; i < 30; i++) {
            p.vy -= p.gravity * (1 / GAME_SPEED); // the bug
            p.y += p.vy * (1 / GAME_SPEED);
        }
        expect(p.vy).toBeGreaterThan(0);
        expect(p.y).toBeGreaterThan(100);
    });
});

describe('isBallistic gating', () => {
    it('accepts exactly the five sim classes that integrate mygravity', () => {
        for (const t of [
            ProjectileType.Explosive,
            ProjectileType.Fireball,
            ProjectileType.Missile,
            ProjectileType.Starburst,
            ProjectileType.Torpedo,
        ]) {
            expect(isBallistic(t)).toBe(true);
        }
    });

    it('rejects the straight-flying classes', () => {
        for (const t of [
            ProjectileType.Laser,
            ProjectileType.BeamLaser,
            ProjectileType.LargeBeamLaser,
            ProjectileType.Emg,
            ProjectileType.Flame,
            ProjectileType.Lightning,
            ProjectileType.Base,
        ]) {
            expect(isBallistic(t)).toBe(false);
        }
    });

    it('treats an unknown/absent type as non-ballistic', () => {
        expect(isBallistic(undefined)).toBe(false);
        expect(isBallistic(0)).toBe(false);
    });

    it('a LaserCannon bolt keeps the aim ray it was fired along', () => {
        // A shieldraid_laser fired flat: with gating it stays flat, so it
        // still arrives at the height the sim aimed it.
        const gravity = isBallistic(ProjectileType.Laser)
            ? MAP_GRAVITY_PER_FRAME2 * GAME_SPEED * GAME_SPEED : 0;
        const p = { y: 62.5, vy: 0, gravity };
        for (let i = 0; i < 30; i++) step(p, 1 / GAME_SPEED);
        expect(p.y).toBeCloseTo(62.5, 6);
    });
});
