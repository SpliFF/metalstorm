/**
 * @vitest-environment happy-dom
 *
 * `TestHarness.captureSubject()` — the ORDERING contract.
 *
 * The framing arithmetic is covered by capture-subject.test.ts. What is
 * covered here is the thing that actually broke in the field: the *sequence*.
 * Every assertion below is a failure that has really happened —
 *
 *   - the camera moved but the shot was taken from the old pose (the rig was
 *     never re-committed, or the capture went first);
 *   - the shot was taken before the subject had streamed in, framing empty
 *     ground;
 *   - a black frame came back as a deliverable with no diagnosis;
 *   - a failed capture left the render loop paused and the camera hijacked,
 *     poisoning the rest of the session.
 *
 * The harness is driven through a fake `workerCall`, so this runs with no
 * Babylon, no worker and no game.
 */

import { describe, it, expect } from 'vitest';
import { TestHarness, type TestHarnessDeps } from './test-harness.js';

const POSE = { pos: { x: 0, y: 100, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } };

interface Call { method: string; args: unknown[] }

interface RigOpts { yawDeg?: number; pitchDeg?: number }

/**
 * A worker stand-in with just enough behaviour to be lied to convincingly:
 * it tracks the rig pose, and each `captureFrame` returns the luminance the
 * scenario dictates for that attempt.
 */
function makeHarness(opts: {
    bounds?: (id: number) => { x: number; y: number; z: number; radius: number;
                               hasModel: boolean | null } | null;
    byDef?: (def: string) => number[];
    luminance?: (attempt: number) => { min: number; max: number; mean: number };
} = {}): { h: TestHarness; calls: Call[]; rig: () => RigOpts & { fill: number } } {
    const calls: Call[] = [];
    let rigYaw = 0, rigPitch = 0, rigFill = 0;
    let anchor = { x: 0, y: 0, z: 0, radius: 40 };
    let captureN = 0;
    const bounds = opts.bounds ?? ((id: number) =>
        ({ x: 100, y: 20, z: 200, radius: 64, hasModel: true, id } as never));

    const deps: TestHarnessDeps = {
        gameHttpUrl: 'http://localhost:9100',
        token: 't',
        workerCall: async (method, args = []) => {
            calls.push({ method, args });
            switch (method) {
                case 'entityBounds': return bounds(args[0] as number);
                case 'entitiesByDef': return (opts.byDef ?? (() => [7, 3]))(args[0] as string);
                case 'orbitStart': {
                    const t = args[0] as number | { x: number; y?: number; z: number; radius?: number };
                    if (typeof t === 'number') {
                        const b = bounds(t);
                        if (b) anchor = { x: b.x, y: b.y, z: b.z, radius: b.radius };
                    } else {
                        anchor = { x: t.x, y: t.y ?? 0, z: t.z, radius: t.radius ?? 40 };
                    }
                    const o = (args[1] ?? {}) as RigOpts;
                    rigYaw = o.yawDeg ?? rigYaw;
                    rigPitch = o.pitchDeg ?? rigPitch;
                    return { yawDeg: rigYaw, pitchDeg: rigPitch, distance: 200,
                             follow: true, anchor };
                }
                case 'orbitSet': {
                    const o = (args[0] ?? {}) as RigOpts;
                    rigYaw = o.yawDeg ?? rigYaw;
                    rigPitch = o.pitchDeg ?? rigPitch;
                    return { yawDeg: rigYaw, pitchDeg: rigPitch, distance: 200,
                             follow: true, anchor };
                }
                case 'orbitFrame':
                    rigFill = (args[0] as number) ?? 0.7;
                    return { yawDeg: rigYaw, pitchDeg: rigPitch,
                             distance: anchor.radius / rigFill, follow: true, anchor };
                case 'captureFrame': {
                    const stats = (opts.luminance ?? (() => ({ min: 2, max: 250, mean: 110 })))(
                        captureN++);
                    return { dataUrl: 'data:image/jpeg;base64,AAA', width: 640, height: 400,
                             frameId: 900 + captureN, gameFrame: 1200, stats };
                }
                case 'cameraPose': return POSE;
                default: return null;
            }
        },
        getSelection: () => [],
        getCameraPose: () => POSE,
        getSceneFrame: () => ({ gameFrame: 1200, ageMs: 80 }),
        getTiming: () => ({ anchored: true, newestFrame: 1210 }),
        getMinimap: () => null,
    };
    return {
        h: new TestHarness(deps), calls,
        rig: () => ({ yawDeg: rigYaw, pitchDeg: rigPitch, fill: rigFill }),
    };
}

const names = (calls: Call[]): string[] => calls.map((c) => c.method);
const idx = (calls: Call[], m: string): number => names(calls).indexOf(m);
const FAST = { settleMs: 0, resolveTimeoutMs: 0 } as const;

describe('captureSubject — subject resolution', () => {
    it('refuses to guess when no subject is given', async () => {
        const { h } = makeHarness();
        await expect(h.captureSubject({})).rejects.toThrow(/needs a subject/);
    });

    it('frames a unit from ITS OWN bounds, not a constant height', async () => {
        const { h, calls } = makeHarness();
        const r = await h.captureSubject({ unitId: 42, ...FAST });
        expect(r.subject.kind).toBe('unit');
        expect(r.subject.unitId).toBe(42);
        expect(r.subject.sphere.radius).toBe(64);
        // 64 elmos radius = 128 elmos across = 16 m at 8 elmos/m.
        expect(r.subject.metresAcross).toBeCloseTo(16, 6);
        expect(idx(calls, 'entityBounds')).toBeGreaterThanOrEqual(0);
        expect(idx(calls, 'entityBounds')).toBeLessThan(idx(calls, 'orbitStart'));
    });

    it('a def resolves to the NEWEST live instance and says how many it saw', async () => {
        const { h } = makeHarness({ byDef: () => [91, 55, 12] });
        const r = await h.captureSubject({ def: 'ms_subs_s4', ...FAST });
        expect(r.subject.unitId).toBe(91);
        expect(r.subject.def).toBe('ms_subs_s4');
        expect(r.warnings.join(' ')).toMatch(/3 live "ms_subs_s4"/);
    });

    it('a def this client has never streamed is an error, not an empty-ground shot', async () => {
        const { h, calls } = makeHarness({ byDef: () => [] });
        await expect(h.captureSubject({ def: 'ms_ghost', ...FAST }))
            .rejects.toThrow(/no live entity of def "ms_ghost"/);
        expect(names(calls)).not.toContain('captureFrame');
    });

    it('a unit with no client-side bounds is an error, not an empty-ground shot', async () => {
        const { h, calls } = makeHarness({ bounds: () => null });
        await expect(h.captureSubject({ unitId: 5, ...FAST }))
            .rejects.toThrow(/no client-side bounds/);
        expect(names(calls)).not.toContain('captureFrame');
    });

    it('several units are framed as one merged sphere on a STATIC anchor', async () => {
        const at = (x: number) => ({ x, y: 0, z: 0, radius: 20, hasModel: true });
        const { h, calls } = makeHarness({
            bounds: (id) => at(id === 1 ? 0 : 400),
        });
        const r = await h.captureSubject({ unitIds: [1, 2], ...FAST });
        expect(r.subject.kind).toBe('units');
        expect(r.subject.sphere.radius).toBeGreaterThanOrEqual(220);
        // Following unit 1 would let unit 2 walk out of shot.
        const start = calls.find((c) => c.method === 'orbitStart')!;
        expect(typeof start.args[0]).toBe('object');
        expect((start.args[1] as { follow: boolean }).follow).toBe(false);
    });

    it('an area becomes a ground anchor with no y, so the rig samples the heightmap',
        async () => {
            const { h, calls } = makeHarness();
            const r = await h.captureSubject({
                area: { x1: 0, z1: 0, x2: 400, z2: 400 }, ...FAST });
            expect(r.subject.kind).toBe('area');
            const t = calls.find((c) => c.method === 'orbitStart')!.args[0] as
                Record<string, number>;
            expect(t).toEqual({ x: 200, z: 200, radius: expect.any(Number) });
            expect('y' in t).toBe(false);
        });

    it('a position with an explicit y keeps it (a submerged subject must not be clamped)',
        async () => {
            const { h, calls } = makeHarness();
            await h.captureSubject({ position: { x: 10, z: 20, y: -80, radius: 300 },
                                     ...FAST });
            expect(calls.find((c) => c.method === 'orbitStart')!.args[0])
                .toEqual({ x: 10, y: -80, z: 20, radius: 300 });
        });
});

describe('captureSubject — ordering', () => {
    it('frames BEFORE it captures, and holds the render loop across the shot', async () => {
        const { h, calls } = makeHarness();
        await h.captureSubject({ unitId: 1, settleMs: 0, resolveTimeoutMs: 0 });
        const order = names(calls);
        expect(idx(calls, 'orbitStart')).toBeLessThan(idx(calls, 'orbitFrame'));
        expect(idx(calls, 'orbitFrame')).toBeLessThan(idx(calls, 'captureFrame'));
        expect(idx(calls, 'pause')).toBeLessThan(idx(calls, 'captureFrame'));
        expect(order.lastIndexOf('resume')).toBeGreaterThan(order.lastIndexOf('captureFrame'));
    });

    it('asks for luminance stats on every capture — an unchecked frame is not a check',
        async () => {
            const { h, calls } = makeHarness();
            await h.captureSubject({ unitId: 1, ...FAST });
            for (const c of calls.filter((x) => x.method === 'captureFrame')) {
                expect((c.args[0] as { stats: boolean }).stats).toBe(true);
            }
        });

    it('holdRender:false leaves the render loop alone', async () => {
        const { h, calls } = makeHarness();
        await h.captureSubject({ unitId: 1, holdRender: false, ...FAST });
        expect(names(calls)).not.toContain('pause');
    });

    it('restores the pre-capture view by default, and keeps it with restore:false',
        async () => {
            const { h, calls } = makeHarness();
            await h.captureSubject({ unitId: 1, ...FAST });
            expect(names(calls)).toContain('orbitStop');

            const b = makeHarness();
            await b.h.captureSubject({ unitId: 1, restore: false, ...FAST });
            expect(names(b.calls)).not.toContain('orbitStop');
        });
});

describe('captureSubject — black-frame handling', () => {
    const black = { min: 0, max: 2, mean: 0.5 };
    const good = { min: 3, max: 250, mean: 120 };

    it('a good first frame is taken once and returned clean', async () => {
        const { h, calls } = makeHarness();
        const r = await h.captureSubject({ unitId: 1, ...FAST });
        expect(calls.filter((c) => c.method === 'captureFrame')).toHaveLength(1);
        expect(r.ok).toBe(true);
        expect(r.diagnosis).toBeNull();
        expect(r.attempts).toHaveLength(1);
    });

    it('a black first frame is retried from a NEW pose, and the retry can succeed',
        async () => {
            const { h, calls, rig } = makeHarness({
                luminance: (n) => (n === 0 ? black : good),
            });
            const r = await h.captureSubject({ unitId: 1, ...FAST });
            expect(calls.filter((c) => c.method === 'captureFrame')).toHaveLength(2);
            expect(r.ok).toBe(true);
            expect(r.diagnosis).toBeNull();
            // The retry must actually have moved the camera — the historical bug
            // was a "retry" that re-shot the identical pose.
            expect(r.attempts[1].framing.pitchDeg).toBeGreaterThan(r.attempts[0].framing.pitchDeg);
            expect(rig().pitchDeg).toBe(r.attempts[1].framing.pitchDeg);
            expect(rig().fill).toBe(r.attempts[1].framing.fill);
            // …and the reported framing is the one that produced the image.
            expect(r.framing.pitchDeg).toBe(r.attempts[1].framing.pitchDeg);
        });

    it('an all-black run comes back as a DIAGNOSIS, not a deliverable', async () => {
        const { h, calls } = makeHarness({ luminance: () => black });
        const r = await h.captureSubject({ unitId: 1, ...FAST });
        expect(calls.filter((c) => c.method === 'captureFrame')).toHaveLength(3);  // 1 + 2 retries
        expect(r.ok).toBe(false);
        expect(r.diagnosis).toMatch(/fog of war/);
        expect(r.dataUrl).toBeTruthy();   // still returned, so it can be looked at
    });

    it('a caller that already revealed LOS is not told to reveal LOS', async () => {
        const { h } = makeHarness({ luminance: () => black });
        const r = await h.captureSubject({ unitId: 1, revealed: true, ...FAST });
        expect(r.diagnosis).not.toMatch(/fog of war/);
    });

    it('a submerged subject gets the water-plane cause named', async () => {
        const { h } = makeHarness({
            bounds: () => ({ x: 0, y: -120, z: 0, radius: 260, hasModel: true }),
            luminance: () => black,
        });
        const r = await h.captureSubject({ unitId: 1, ...FAST });
        expect(r.diagnosis).toMatch(/water plane/);
    });

    it('retries:0 takes exactly one shot', async () => {
        const { h, calls } = makeHarness({ luminance: () => black });
        await h.captureSubject({ unitId: 1, retries: 0, ...FAST });
        expect(calls.filter((c) => c.method === 'captureFrame')).toHaveLength(1);
    });

    it('a failed capture still un-pauses and un-hijacks the camera', async () => {
        const { h, calls } = makeHarness({
            luminance: () => { throw new Error('worker exploded'); },
        });
        await expect(h.captureSubject({ unitId: 1, ...FAST })).rejects.toThrow(/exploded/);
        expect(names(calls)).toContain('resume');
        expect(names(calls)).toContain('orbitStop');
    });
});

describe('captureSubject — model status', () => {
    it('a procedural fallback shape is called out, because it is NOT the art', async () => {
        const { h } = makeHarness({
            bounds: () => ({ x: 0, y: 0, z: 0, radius: 30, hasModel: false }),
        });
        const r = await h.captureSubject({ unitId: 1, ...FAST });
        expect(r.subject.hasModel).toBe(false);
        expect(r.warnings.join(' ')).toMatch(/FALLBACK/);
    });

    it('a still-loading template is flagged as possibly a placeholder', async () => {
        const { h } = makeHarness({
            bounds: () => ({ x: 0, y: 0, z: 0, radius: 30, hasModel: null }),
        });
        const r = await h.captureSubject({ unitId: 1, ...FAST });
        expect(r.subject.hasModel).toBeNull();
        expect(r.warnings.join(' ')).toMatch(/still loading/);
    });

    it('WAITS for a loading template rather than framing the def-radius fallback',
        async () => {
            // Observed in the field: a freshly spawned 17 m heavy whose template
            // had not landed reported "2.5 m across" (the def-radius fallback)
            // and was photographed from 34 elmos. Resolution must not settle for
            // hasModel:null while there is still budget.
            let polls = 0;
            const { h } = makeHarness({
                bounds: () => (++polls < 3
                    ? { x: 0, y: 0, z: 0, radius: 10, hasModel: null }
                    : { x: 0, y: 0, z: 0, radius: 90, hasModel: true }),
            });
            const r = await h.captureSubject({ unitId: 1, resolveTimeoutMs: 2000, settleMs: 0 });
            expect(r.subject.hasModel).toBe(true);
            expect(r.subject.sphere.radius).toBe(90);
            expect(r.warnings).toEqual([]);
        });

    it('a loaded model produces no model warning at all', async () => {
        const { h } = makeHarness();
        const r = await h.captureSubject({ unitId: 1, ...FAST });
        expect(r.subject.hasModel).toBe(true);
        expect(r.warnings).toEqual([]);
    });
});
