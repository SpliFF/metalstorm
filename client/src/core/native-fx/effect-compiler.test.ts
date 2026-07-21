/**
 * effect-compiler tests — row packing, alias resolution, spread sampling,
 * and weapon-fx resolution order. Pure node; no GL.
 *
 * Fixtures are trimmed shapes of data/games/metalstorm/effects/library.json
 * and weapon-fx.json — field names must stay in lockstep with those files
 * and with the shaders/fx attribute layouts (see the README there).
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    MUZZLE_FLOATS,
    PARTICLE_FLOATS,
    SHOCK_FLOATS,
    TRACER_FLOATS,
    TRAIL_FLOATS,
    compileEffect,
    compileEmitter,
    defaultModeForUsage,
    effectsUsingShader,
    packTracer,
    packTrailSegment,
    resolveEffect,
    resolveWeaponFx,
    samplePosSpread,
    sampleSpread,
    type FxLibrary,
    type SpawnContext,
    type WeaponFxMap,
} from './effect-compiler.js';

const LIB: FxLibrary = {
    atlas: {
        texture: 'unittextures/fx_atlas.ktx2', cols: 8, rows: 8,
        frames: { spark: 1, fireball: 2, smoke: 3, scorch: 24 },
    },
    effects: {
        boom: {
            usage: 'impact',
            emitters: [
                { shader: 'particle', count: 4, sprite: 'fireball', orient: 'billboard',
                  life: [0.2, 0.4], size: [10, 30], speed: [5, 20], spread: 'hemisphere',
                  gravity: -3, colorStart: [4.5, 2.4, 0.7, 1], colorEnd: [1.2, 0.4, 0.1, 0] },
                { shader: 'shockwave', maxRadius: 90, strength: 0.7, life: 0.5 },
                { shader: 'particle', count: 1, sprite: 'scorch', orient: 'ground',
                  life: 5, size: [70, 84], speed: 0, delay: 0.1,
                  colorStart: [0.1, 0.1, 0.1, 0.7], colorEnd: [0.1, 0.1, 0.1, 0] },
            ],
        },
        flash: {
            usage: 'muzzle',
            emitters: [
                { shader: 'muzzleFlash', size: 12, life: 0.08, color: [6, 3.6, 1.1, 1], spin: 4 },
            ],
        },
        streak: {
            usage: 'projectile',
            emitters: [
                { shader: 'tracer', length: 90, width: 1.1, coreBoost: 5, taper: 0.9,
                  color: [2.6, 3.6, 6.5, 1], life: 3 },
            ],
        },
        plume: {
            usage: 'trail',
            emitters: [
                { shader: 'trail', sprite: 'smoketrail', width: [5, 18], tileLength: 48,
                  nodeInterval: 0.04, life: 1.4, tint: [0.6, 0.58, 0.55], alpha: [0.85, 0] },
            ],
        },
        scattered: {
            usage: 'death',
            emitters: [
                { shader: 'particle', count: 16, sprite: 'smoke', orient: 'billboard',
                  life: 1, size: [10, 30], speed: 0, posSpread: 40,
                  colorStart: [0.4, 0.4, 0.4, 0.7], colorEnd: [0.2, 0.2, 0.2, 0] },
            ],
        },
        __default_explosion: { usage: 'impact', alias: 'boom' },
        dangling: { usage: 'impact', alias: 'nope' },
    },
};

/** Deterministic LCG so packing assertions are reproducible. */
function lcg(seed = 42): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

function ctx(over: Partial<SpawnContext> = {}): SpawnContext {
    return { x: 10, y: 5, z: -20, dirX: 0, dirY: 1, dirZ: 0, now: 100, rng: lcg(), ...over };
}

describe('resolveEffect', () => {
    it('resolves aliases to the target definition', () => {
        const r = resolveEffect(LIB, '__default_explosion');
        expect(r.name).toBe('boom');
        expect(r.def.emitters).toHaveLength(3);
    });

    it('throws on unknown and dangling names', () => {
        expect(() => resolveEffect(LIB, 'missing')).toThrow(/unknown effect/);
        expect(() => resolveEffect(LIB, 'dangling')).toThrow(/unknown effect "nope"/);
    });
});

describe('compileEffect row packing', () => {
    it('packs particle rows to the documented 7×vec4 layout', () => {
        const b = compileEffect(LIB, 'boom', ctx());
        expect(b.particleCount).toBe(4);                       // delayed scorch excluded
        expect(b.particles!.length).toBe(4 * PARTICLE_FLOATS);
        const o = 0;
        // iPosLife: spawn pos + life within authored range
        expect(b.particles![o + 0]).toBe(10);
        expect(b.particles![o + 1]).toBe(5);
        expect(b.particles![o + 2]).toBe(-20);
        expect(b.particles![o + 3]).toBeGreaterThanOrEqual(0.2);
        expect(b.particles![o + 3]).toBeLessThanOrEqual(0.4);
        // iVelTime.w = birth
        expect(b.particles![o + 7]).toBe(100);
        // iSize = (10, 30, -3, 1)
        expect(b.particles![o + 8]).toBe(10);
        expect(b.particles![o + 9]).toBe(30);
        expect(b.particles![o + 10]).toBe(-3);
        // iRot.z = billboard(0); iAnim.x = fireball frame 2
        expect(b.particles![o + 14]).toBe(0);
        expect(b.particles![o + 16]).toBe(2);
        // HDR colour passthrough
        expect(b.particles![o + 20]).toBeCloseTo(4.5);
        expect(b.particles![o + 27]).toBe(0);
    });

    it('packs shockwave rows and defers delayed emitters', () => {
        const b = compileEffect(LIB, 'boom', ctx());
        expect(b.shockCount).toBe(1);
        expect(b.shocks!.length).toBe(SHOCK_FLOATS);
        expect(b.shocks![3]).toBe(0.5);        // lifetime
        expect(b.shocks![4]).toBe(100);        // birthTime
        expect(b.shocks![5]).toBe(90);         // maxRadius
        expect(b.shocks![6]).toBeCloseTo(0.7); // strength
        expect(b.delayed).toHaveLength(1);
        expect(b.delayed[0].delay).toBeCloseTo(0.1);
        expect(b.delayed[0].emitter.sprite).toBe('scorch');
    });

    it('packs muzzle rows (3×vec4) with seed jitter in [0, 2π)', () => {
        const b = compileEffect(LIB, 'flash', ctx());
        expect(b.muzzleCount).toBe(1);
        expect(b.muzzles!.length).toBe(MUZZLE_FLOATS);
        expect(b.muzzles![3]).toBeCloseTo(0.08); // lifetime
        expect(b.muzzles![4]).toBe(100);         // birthTime
        expect(b.muzzles![5]).toBe(12);          // size
        expect(b.muzzles![6]).toBe(4);           // spin
        expect(b.muzzles![7]).toBeGreaterThanOrEqual(0);
        expect(b.muzzles![7]).toBeLessThan(Math.PI * 2);
        expect(b.muzzles![8]).toBe(6);           // colour R (HDR)
    });

    it('returns tracer and trail specs as descriptors, not rows', () => {
        const t = compileEffect(LIB, 'streak', ctx());
        expect(t.tracers).toHaveLength(1);
        expect(t.tracers[0]).toMatchObject({ length: 90, coreBoost: 5, life: 3 });
        const p = compileEffect(LIB, 'plume', ctx());
        expect(p.trails).toHaveLength(1);
        expect(p.trails[0]).toMatchObject({
            sprite: 'smoketrail', widthHead: 5, widthTail: 18, nodeInterval: 0.04,
        });
    });
});

describe('pack helpers', () => {
    it('packTracer writes the 4×vec4 layout at an offset', () => {
        const out = new Float32Array(2 * TRACER_FLOATS);
        packTracer(out, TRACER_FLOATS, [1, 2, 3], [4, 5, 6],
            { length: 90, width: 1.1, coreBoost: 5, taper: 0.9, color: [2.6, 3.6, 6.5, 1], life: 3 },
            77);
        expect(out[TRACER_FLOATS + 0]).toBe(1);
        expect(out[TRACER_FLOATS + 3]).toBe(3);    // life
        expect(out[TRACER_FLOATS + 7]).toBe(77);   // birth
        expect(out[TRACER_FLOATS + 8]).toBe(90);   // length
        expect(out[TRACER_FLOATS + 10]).toBe(5);   // coreBoost
    });

    it('packTrailSegment writes the 3×vec4 layout', () => {
        const out = new Float32Array(TRAIL_FLOATS);
        packTrailSegment(out, 0, [1, 2, 3], 5, [4, 5, 6], 18, 0.25, 0.5, 0.85, 0.1);
        expect(out[3]).toBe(5);            // width1
        expect(out[7]).toBe(18);           // width2
        expect(out[8]).toBeCloseTo(0.25);  // uMin
        expect(out[11]).toBeCloseTo(0.1);  // a2
    });
});

describe('sampleSpread', () => {
    const rng = lcg(7);

    it('cone:<deg> stays within the half-angle of dir — including dir = up (the rotateZTo degenerate axis)', () => {
        for (const dir of [[0, 1, 0], [1, 0, 0], [0.7, 0.7, 0]] as const) {
            for (let i = 0; i < 200; i++) {
                const v = sampleSpread('cone:20', [...dir] as [number, number, number], rng);
                const len = Math.hypot(...v);
                expect(len).toBeCloseTo(1, 5);
                const d = Math.hypot(...dir);
                const dot = (v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2]) / d;
                expect(dot).toBeGreaterThanOrEqual(Math.cos((20 * Math.PI) / 180) - 1e-4);
            }
        }
    });

    it('hemisphere biases along dir; disc stays in the ground plane', () => {
        for (let i = 0; i < 100; i++) {
            const h = sampleSpread('hemisphere', [0, 1, 0], rng);
            expect(h[1]).toBeGreaterThanOrEqual(0);
            const d = sampleSpread('disc', [0, 1, 0], rng);
            expect(Math.abs(d[1])).toBeLessThan(1e-6);
        }
    });
});

describe('shipped library.json (data/games/metalstorm/effects)', () => {
    // The real authored library, not a fixture — this is what makes the
    // "dangling aliases are surfaced by tests" claim in effect-compiler.ts's
    // effectsUsingShader true: every alias must resolve and every effect
    // (including its delayed emitters) must compile.
    const libPath = path.resolve(__dirname, '../../../../data/games/metalstorm/effects/library.json');
    const shipped = JSON.parse(fs.readFileSync(libPath, 'utf8')) as FxLibrary;

    it('every effect resolves (no dangling or circular aliases)', () => {
        for (const name of Object.keys(shipped.effects)) {
            expect(() => resolveEffect(shipped, name), name).not.toThrow();
        }
    });

    it('every effect compiles, including its delayed emitters', () => {
        for (const name of Object.keys(shipped.effects)) {
            const b = compileEffect(shipped, name, ctx());
            for (const d of b.delayed) {
                expect(() => compileEmitter(shipped, d.emitter, ctx()), `${name} delayed emitter`)
                    .not.toThrow();
            }
        }
    });

    it('every particle emitter sprite names a real atlas frame', () => {
        for (const name of Object.keys(shipped.effects)) {
            const { def } = resolveEffect(shipped, name);
            for (const e of def.emitters ?? []) {
                if (e.sprite != null) {
                    expect(shipped.atlas.frames, `${name}: sprite "${e.sprite}"`)
                        .toHaveProperty(e.sprite);
                }
            }
        }
    });
});

describe('posSpread', () => {
    const rng = lcg(11);

    it('scalar posSpread scatters spawn positions within the sphere radius', () => {
        const b = compileEffect(LIB, 'scattered', ctx({ rng: lcg(11) }));
        expect(b.particleCount).toBe(16);
        let maxR = 0;
        let anyOffset = false;
        for (let i = 0; i < 16; i++) {
            const o = i * PARTICLE_FLOATS;
            const dx = b.particles![o + 0] - 10;
            const dy = b.particles![o + 1] - 5;
            const dz = b.particles![o + 2] - (-20);
            const r = Math.hypot(dx, dy, dz);
            maxR = Math.max(maxR, r);
            if (r > 1) anyOffset = true;
        }
        expect(maxR).toBeLessThanOrEqual(40 + 1e-4);
        expect(anyOffset).toBe(true);
    });

    it('triple posSpread stays inside the box half-extents; zero/absent means no offset', () => {
        for (let i = 0; i < 100; i++) {
            const [x, y, z] = samplePosSpread([30, 5, 10], rng);
            expect(Math.abs(x)).toBeLessThanOrEqual(30);
            expect(Math.abs(y)).toBeLessThanOrEqual(5);
            expect(Math.abs(z)).toBeLessThanOrEqual(10);
        }
        expect(samplePosSpread(undefined, rng)).toEqual([0, 0, 0]);
        expect(samplePosSpread(0, rng)).toEqual([0, 0, 0]);
    });
});

describe('menus & weapon-fx resolution', () => {
    it('effectsUsingShader filters by (alias-resolved) emitter shader and skips dangling aliases', () => {
        expect(effectsUsingShader(LIB, 'shockwave')).toEqual(['__default_explosion', 'boom']);
        expect(effectsUsingShader(LIB, 'tracer')).toEqual(['streak']);
        expect(effectsUsingShader(LIB, null)).not.toContain('dangling');
    });

    it('defaultModeForUsage maps usages onto harness modes', () => {
        expect(defaultModeForUsage('muzzle')).toBe('muzzle');
        expect(defaultModeForUsage('projectile')).toBe('projectile');
        expect(defaultModeForUsage('trail')).toBe('projectile');
        expect(defaultModeForUsage('impact')).toBe('impact');
        expect(defaultModeForUsage('death')).toBe('impact');
        expect(defaultModeForUsage('attached')).toBe('loop');
        expect(defaultModeForUsage(undefined)).toBe('impact');
    });

    it('resolveWeaponFx honours exact → defaults[type] → __fallback order', () => {
        const map: WeaponFxMap = {
            defaults: {
                _doc: 'ignored',
                Cannon: { muzzle: 'flash', projectile: 'streak', trail: null,
                          impact: 'boom', fireSound: 'ac', impactSound: 'blast' },
            },
            __fallback: { muzzle: null, projectile: null, trail: null,
                          impact: '__default_explosion', fireSound: null, impactSound: null },
            weapons: {
                MS_RAILGUN_S1: { muzzle: 'flash', projectile: 'streak', trail: null,
                                 impact: 'boom', fireSound: 'rail', impactSound: 'hit' },
            },
        };
        expect(resolveWeaponFx(map, 'MS_RAILGUN_S1', 'Cannon').fireSound).toBe('rail');
        expect(resolveWeaponFx(map, 'MS_AC_S1', 'Cannon').fireSound).toBe('ac');
        expect(resolveWeaponFx(map, 'MS_MYSTERY_S1', 'BeamLaser').impact).toBe('__default_explosion');
        // `_doc` keys in defaults must never satisfy the type lookup.
        expect(resolveWeaponFx(map, 'MS_MYSTERY_S1', '_doc').impact).toBe('__default_explosion');
    });
});
