import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, Mesh } from '@babylonjs/core';
import { CombatFX } from './combat-fx.js';
import type { VolleyOutcomeInfo } from './connection.js';

// PLAN-perf.md M18. M11 measured the pre-M18 path at 1.76 ms of `render` and
// 177 draws/frame on the L-battle: every tracer, puff and burst allocated its
// own Babylon mesh with its own draw call. These tests assert the *mechanism*
// of the fix — that the meshes are gone and that the thin instances replacing
// them land in exactly the same place — not merely that a flag flipped.

function makeFx(): { fx: CombatFX; scene: Scene } {
    const scene = new Scene(new NullEngine());
    return { fx: new CombatFX(scene), scene };
}

/** One statistical-combat volley: `rounds` tracers + an impact or dust puff. */
function volley(rounds: number, result = 0): VolleyOutcomeInfo[] {
    return [{
        attackerId: 1, targetId: 2, weaponDefId: 0, result,
        rounds, damage: 100, x: 500, y: 20, z: 700,
    } as VolleyOutcomeInfo];
}

const attackerAt = () => ({ x: 100, y: 10, z: 200 });

/** Scene meshes that are not pool prototypes — i.e. per-effect allocations. */
function perEffectMeshes(scene: Scene): Mesh[] {
    return scene.meshes.filter(m => !m.name.startsWith('fxPool_')) as Mesh[];
}

/**
 * Instance `i`'s 16 matrix floats, read from the buffer the renderer uploads.
 * NOT `thinInstanceGetWorldMatrices()` — that decodes into a cache which only
 * `thinInstanceSetBuffer` invalidates, so on the per-frame `thinInstanceBuffer-
 * Updated` path it happily returns last frame's transforms.
 */
function instanceMatrix(mesh: Mesh, i: number): number[] {
    const data = (mesh as unknown as {
        _thinInstanceDataStorage: { matrixData: Float32Array };
    })._thinInstanceDataStorage.matrixData;
    return Array.from(data.subarray(i * 16, i * 16 + 16));
}

describe('CombatFX thin-instance pooling (M18)', () => {
    it('draws many effects through one mesh per shape, not one mesh each', () => {
        const { fx, scene } = makeFx();
        for (let i = 0; i < 40; i++) fx.onVolleyOutcome(volley(8), attackerAt);
        fx.tick(0.001);

        // 40 volleys x 8 rounds = 320 tracers + 40 impact spheres.
        expect(fx.activeCount).toBe(360);
        expect(perEffectMeshes(scene)).toHaveLength(0);
        // Two shapes reached (stretched box + sphere), so two prototypes.
        const pools = scene.meshes.filter(m => m.name.startsWith('fxPool_'));
        expect(pools).toHaveLength(2);
        expect(pools.reduce((n, m) => n + (m as Mesh).thinInstanceCount, 0)).toBe(360);
    });

    it('grows the matrix buffer past its initial capacity', () => {
        const { fx, scene } = makeFx();
        // 64 is the initial pool capacity; 200 tracers must all be drawn.
        for (let i = 0; i < 25; i++) fx.onVolleyOutcome(volley(8), attackerAt);
        fx.tick(0.001);
        const tracers = scene.meshes.find(
            m => m.name.startsWith('fxPool_0:tracerFxMat')) as Mesh;
        expect(tracers.thinInstanceCount).toBe(200);
    });

    it('places a pooled tracer exactly where the per-mesh path put it', () => {
        // The pooled tracer is a unit box stretched and rotated by its instance
        // matrix; the legacy one was built to length and oriented by lookAt().
        // Those are two different code paths to the same world transform, and a
        // drift in either would be invisible in a screenshot of a 0.12 s streak
        // — so pin the endpoint jitter and compare them element by element.
        const withoutJitter = <T>(run: () => T): T => {
            const real = Math.random;
            Math.random = () => 0.5;              // jitter = 0
            try { return run(); } finally { Math.random = real; }
        };

        const legacy = makeFx();
        legacy.fx.setPooled(false);
        withoutJitter(() => {
            legacy.fx.onVolleyOutcome(volley(1), attackerAt);
            legacy.fx.tick(0.001);
        });
        const mesh = perEffectMeshes(legacy.scene).find(m => m.name === 'volleyTracer')!;
        expect(mesh).toBeDefined();
        const legacyM = mesh.computeWorldMatrix(true).asArray();

        const pooled = makeFx();
        withoutJitter(() => {
            pooled.fx.onVolleyOutcome(volley(1), attackerAt);
            pooled.fx.tick(0.001);
        });
        const pool = pooled.scene.meshes.find(
            m => m.name.startsWith('fxPool_0:tracerFxMat')) as Mesh;
        const pooledM = instanceMatrix(pool, 0);

        // The legacy box baked its dimensions into the geometry, so its world
        // matrix is a pure rotation + translation; the pooled one carries the
        // dimensions as scale. Divide it out and the two must be identical.
        const dims = [0.7, 0.7, Math.hypot(500 - 100, 26 - 18, 700 - 200)];
        for (let row = 0; row < 3; row++) {
            for (let c = 0; c < 3; c++) {
                expect(pooledM[row * 4 + c] / dims[row]).toBeCloseTo(legacyM[row * 4 + c], 5);
            }
        }
        for (let c = 0; c < 3; c++) {
            expect(pooledM[12 + c]).toBeCloseTo(legacyM[12 + c], 4);
        }
        // …and the transform really is the one the effect is meant to have:
        // centred between muzzle (+8 in y) and impact, local +Z along the shot.
        expect(pooledM[12]).toBeCloseTo((100 + 500) / 2, 4);
        expect(pooledM[13]).toBeCloseTo((18 + 26) / 2, 4);
        expect(pooledM[14]).toBeCloseTo((200 + 700) / 2, 4);
        const len = dims[2];
        expect(pooledM[8] / len).toBeCloseTo((500 - 100) / len, 5);
        expect(pooledM[9] / len).toBeCloseTo((26 - 18) / len, 5);
        expect(pooledM[10] / len).toBeCloseTo((700 - 200) / len, 5);
    });

    it('fades a pooled puff by scaling its instance, and retires it', () => {
        const { fx, scene } = makeFx();
        fx.onVolleyOutcome(volley(0, 1), attackerAt);   // Miss -> dust puff only
        fx.tick(0.001);
        const dust = scene.meshes.find(
            m => m.name.startsWith('fxPool_1:dirtFxMat')) as Mesh;
        const sizeAt = (): number => {
            const a = instanceMatrix(dust, 0);
            return Math.hypot(a[0], a[1], a[2]);
        };
        // Diameter 5, faded by min(lifetime * 4, 1) exactly as the per-mesh
        // path scaled its own sphere.
        expect(dust.thinInstanceCount).toBe(1);
        expect(sizeAt()).toBeCloseTo(5 * 0.199 * 4, 3);  // 0.199s left
        fx.tick(0.1);
        expect(sizeAt()).toBeCloseTo(5 * 0.099 * 4, 3);  // 0.099s left
        fx.tick(0.2);                                    // expired
        expect(fx.activeCount).toBe(0);
        expect(dust.thinInstanceCount).toBe(0);
        expect(dust.isVisible).toBe(false);
    });

    it('is reversible, so the win stays measurable as a within-session A/B', () => {
        const { fx, scene } = makeFx();
        expect(fx.setPooled(false)).toBe(false);
        fx.onVolleyOutcome(volley(4), attackerAt);
        fx.tick(0.001);
        expect(perEffectMeshes(scene).length).toBe(5);   // 4 tracers + 1 impact

        fx.setPooled(true);
        fx.tick(0.5);                                    // retire the legacy set
        fx.onVolleyOutcome(volley(4), attackerAt);
        fx.tick(0.001);
        expect(perEffectMeshes(scene)).toHaveLength(0);
        expect(fx.activeCount).toBe(5);
    });

    it('drops pooled instances on reset but keeps the prototypes', () => {
        const { fx, scene } = makeFx();
        fx.onVolleyOutcome(volley(4), attackerAt);
        fx.tick(0.001);
        const before = scene.meshes.length;
        fx.reset();
        expect(fx.activeCount).toBe(0);
        expect(scene.meshes.length).toBe(before);
        for (const m of scene.meshes) expect((m as Mesh).thinInstanceCount).toBe(0);
    });
});
