/**
 * Framing presets, black-frame verdicts and subject-sphere math for
 * `test.captureSubject()` / the `capture_subject` MCP tool.
 *
 * The point of these tests is that the three historical failures — wrong zoom
 * for the subject's size, a black frame handed back as a deliverable, and a
 * retry ladder that never actually changed the camera — are each pinned by an
 * assertion rather than by a comment.
 */

import { describe, expect, it } from 'vitest';
import {
    CAPTURE_ANGLES,
    DEFAULT_CAPTURE_ANGLE,
    DEFAULT_LUMINANCE_FLOOR,
    DEFAULT_POINT_RADIUS,
    ELMOS_PER_METRE,
    FILL_MAX,
    FILL_MIN,
    clampFill,
    diagnose,
    luminanceVerdict,
    mergeSubjectSpheres,
    metresAcross,
    resolveFraming,
    retryFraming,
    sphereFromArea,
    sphereFromPosition,
    type AttemptRecord,
} from './capture-subject.js';
import { clampOrbitDistance, frameDistance, orbitCameraPos } from './orbit-rig.js';

describe('angle presets', () => {
    it('every preset sits inside the rig\'s pitch clamp', () => {
        for (const [name, f] of Object.entries(CAPTURE_ANGLES)) {
            expect(f.pitchDeg, name).toBeGreaterThanOrEqual(5);
            expect(f.pitchDeg, name).toBeLessThanOrEqual(85);
        }
    });

    it('every preset fill survives the fill clamp unchanged', () => {
        // A preset the clamp would rewrite is a preset that lies about what it does.
        for (const [name, f] of Object.entries(CAPTURE_ANGLES)) {
            expect(clampFill(f.fill), name).toBe(f.fill);
        }
    });

    it('"front" looks at the −Z face, which is where heading 0 points', () => {
        // docs/coordinate-system.md: −Z is forward. Camera must be on −Z.
        const pos = orbitCameraPos({ x: 0, y: 0, z: 0 },
            CAPTURE_ANGLES.front.yawDeg, CAPTURE_ANGLES.front.pitchDeg, 100);
        expect(pos.z).toBeLessThan(-50);
        expect(Math.abs(pos.x)).toBeLessThan(1e-6);
    });

    it('"rear" is the opposite bearing from "front"', () => {
        expect(Math.abs(CAPTURE_ANGLES.rear.yawDeg - CAPTURE_ANGLES.front.yawDeg)).toBe(180);
    });

    it('"three-quarter" is the default and shows front and side at once', () => {
        expect(DEFAULT_CAPTURE_ANGLE).toBe('three-quarter');
        const pos = orbitCameraPos({ x: 0, y: 0, z: 0 },
            CAPTURE_ANGLES['three-quarter'].yawDeg,
            CAPTURE_ANGLES['three-quarter'].pitchDeg, 100);
        expect(pos.x).toBeGreaterThan(0);   // off to one side
        expect(pos.z).toBeLessThan(0);      // and in front
        expect(pos.y).toBeGreaterThan(0);   // and above
    });

    it('"low" frames looser than "three-quarter" so terrain stays in shot', () => {
        expect(CAPTURE_ANGLES.low.fill).toBeLessThan(CAPTURE_ANGLES['three-quarter'].fill);
        expect(CAPTURE_ANGLES.low.pitchDeg).toBeLessThan(CAPTURE_ANGLES['three-quarter'].pitchDeg);
    });
});

describe('resolveFraming', () => {
    it('unknown/absent angle falls back to the default preset', () => {
        expect(resolveFraming()).toMatchObject(CAPTURE_ANGLES[DEFAULT_CAPTURE_ANGLE]);
        expect(resolveFraming({ angle: 'nope' as never }).angle).toBe(DEFAULT_CAPTURE_ANGLE);
    });

    it('per-axis overrides compose with a preset', () => {
        const f = resolveFraming({ angle: 'top', yawDeg: 0 });
        expect(f.yawDeg).toBe(0);
        expect(f.pitchDeg).toBe(CAPTURE_ANGLES.top.pitchDeg);
        expect(f.fill).toBe(CAPTURE_ANGLES.top.fill);
    });

    it('a zero override is honoured, not treated as absent', () => {
        expect(resolveFraming({ angle: 'front', yawDeg: 0 }).yawDeg).toBe(0);
    });

    it('an out-of-range fill is clamped, so the reported framing is the applied one', () => {
        expect(resolveFraming({ fill: 0.01 }).fill).toBe(FILL_MIN);
        expect(resolveFraming({ fill: 5 }).fill).toBe(FILL_MAX);
    });
});

describe('fill clamp vs the rig zoom clamp', () => {
    // The clamp exists so the distance we ask for is a distance the rig will
    // actually adopt. If these drift apart the primitive silently lies.
    const FOV_Y = 0.8;      // Babylon default vertical FOV
    const ASPECT = 1280 / 800;

    for (const fill of [FILL_MIN, 0.5, 0.7, FILL_MAX]) {
        it(`fill ${fill} survives clampOrbitDistance for a 4 m and a 65 m subject`, () => {
            for (const metres of [4, 65]) {
                const radius = (metres / 2) * ELMOS_PER_METRE;
                const want = frameDistance(radius, FOV_Y, ASPECT, fill);
                expect(clampOrbitDistance(want, radius)).toBeCloseTo(want, 6);
            }
        });
    }

    it('the same fill gives a 65 m subject a proportionally larger distance', () => {
        const small = frameDistance(4 / 2 * ELMOS_PER_METRE, FOV_Y, ASPECT, 0.7);
        const big = frameDistance(65 / 2 * ELMOS_PER_METRE, FOV_Y, ASPECT, 0.7);
        // This ratio is the whole point: one constant height cannot serve both.
        expect(big / small).toBeCloseTo(65 / 4, 5);
    });
});

describe('retryFraming', () => {
    const base = { yawDeg: -45, pitchDeg: 12, fill: 0.75 };

    it('attempt 0 is exactly what the caller asked for', () => {
        expect(retryFraming(base, 0)).toEqual(base);
    });

    it('each retry actually moves the camera — up and out', () => {
        const a1 = retryFraming(base, 1);
        const a2 = retryFraming(base, 2);
        expect(a1.pitchDeg).toBeGreaterThan(base.pitchDeg);
        expect(a1.fill).toBeLessThan(base.fill);
        expect(a2.pitchDeg).toBeGreaterThan(a1.pitchDeg);
        expect(a2.fill).toBeLessThanOrEqual(a1.fill);
    });

    it('never escalates a high-pitch request back down', () => {
        const a1 = retryFraming({ yawDeg: 0, pitchDeg: 80, fill: 0.9 }, 1);
        expect(a1.pitchDeg).toBe(80);
    });

    it('the final rung stays inside the rig clamps', () => {
        const a2 = retryFraming(base, 2);
        expect(a2.pitchDeg).toBeLessThanOrEqual(85);
        expect(a2.fill).toBeGreaterThanOrEqual(FILL_MIN);
    });
});

describe('luminanceVerdict', () => {
    it('a black frame is black', () => {
        const v = luminanceVerdict({ min: 0, max: 3, mean: 0.4 });
        expect(v.black).toBe(true);
        expect(v.reason).toMatch(/near-black/);
    });

    it('the floor is inclusive', () => {
        expect(luminanceVerdict({ min: 0, max: 40, mean: DEFAULT_LUMINANCE_FLOOR }).black)
            .toBe(true);
        expect(luminanceVerdict({ min: 0, max: 40, mean: DEFAULT_LUMINANCE_FLOOR + 0.1 }).black)
            .toBe(false);
    });

    it('a bright but featureless frame is flat, not black', () => {
        const v = luminanceVerdict({ min: 130, max: 133, mean: 131 });
        expect(v.black).toBe(false);
        expect(v.flat).toBe(true);
        expect(v.reason).toMatch(/featureless/);
    });

    it('a real picture passes with no reason', () => {
        expect(luminanceVerdict({ min: 4, max: 240, mean: 96 }))
            .toMatchObject({ black: false, flat: false, reason: null });
    });

    it('missing stats is reported as unchecked, never as fine', () => {
        const v = luminanceVerdict(undefined);
        expect(v.reason).toMatch(/not checked/);
    });

    it('the floor is overridable', () => {
        expect(luminanceVerdict({ min: 0, max: 60, mean: 20 }, { luminanceFloor: 25 }).black)
            .toBe(true);
    });
});

describe('diagnose', () => {
    const black = (): AttemptRecord => ({
        framing: { yawDeg: 0, pitchDeg: 30, fill: 0.7 },
        stats: { min: 0, max: 1, mean: 0.2 },
        verdict: luminanceVerdict({ min: 0, max: 1, mean: 0.2 }),
    });
    const good = (): AttemptRecord => ({
        framing: { yawDeg: 0, pitchDeg: 30, fill: 0.7 },
        stats: { min: 3, max: 250, mean: 110 },
        verdict: luminanceVerdict({ min: 3, max: 250, mean: 110 }),
    });

    it('a good final frame has no diagnosis', () => {
        expect(diagnose([black(), good()])).toBeNull();
    });

    it('names fog of war first when LOS was not revealed', () => {
        const d = diagnose([black(), black()], { revealed: false });
        expect(d).toMatch(/fog of war/);
        expect(d!.indexOf('fog of war')).toBeLessThan(d!.indexOf('night'));
    });

    it('does NOT blame fog of war when LOS was already revealed', () => {
        expect(diagnose([black()], { revealed: true })).not.toMatch(/fog of war/);
    });

    it('mentions the water plane only for a submerged subject', () => {
        expect(diagnose([black()], { underwater: true })).toMatch(/water plane/);
        expect(diagnose([black()], { underwater: false })).not.toMatch(/water plane/);
    });

    it('reports the attempt count so "it retried" is verifiable', () => {
        expect(diagnose([black(), black(), black()])).toMatch(/3 framing attempt/);
    });

    it('a flat final frame is surfaced as a warning sentence', () => {
        const flat: AttemptRecord = {
            framing: { yawDeg: 0, pitchDeg: 30, fill: 0.7 },
            stats: { min: 130, max: 132, mean: 131 },
            verdict: luminanceVerdict({ min: 130, max: 132, mean: 131 }),
        };
        expect(diagnose([flat])).toMatch(/featureless/);
    });

    it('no attempts at all is itself a diagnosis', () => {
        expect(diagnose([])).toMatch(/no capture attempts/);
    });
});

describe('subject spheres', () => {
    it('an area becomes its centroid plus half-diagonal', () => {
        const s = sphereFromArea({ x1: 100, z1: 200, x2: 300, z2: 600 });
        expect(s.x).toBe(200);
        expect(s.z).toBe(400);
        expect(s.radius).toBeCloseTo(Math.hypot(100, 200), 6);
    });

    it('corner order does not matter', () => {
        expect(sphereFromArea({ x1: 300, z1: 600, x2: 100, z2: 200 }))
            .toEqual(sphereFromArea({ x1: 100, z1: 200, x2: 300, z2: 600 }));
    });

    it('a degenerate area still has a framable radius', () => {
        expect(sphereFromArea({ x1: 50, z1: 50, x2: 50, z2: 50 }).radius).toBeGreaterThan(0);
    });

    it('a bare position gets a readable default radius, not a point', () => {
        expect(sphereFromPosition({ x: 10, z: 20 }))
            .toEqual({ x: 10, y: 0, z: 20, radius: DEFAULT_POINT_RADIUS });
    });

    it('an explicit radius and y win', () => {
        expect(sphereFromPosition({ x: 1, z: 2, y: -30, radius: 40 }))
            .toEqual({ x: 1, y: -30, z: 2, radius: 40 });
    });

    it('several units merge into one sphere that contains them all', () => {
        const merged = mergeSubjectSpheres([
            { x: 0, y: 0, z: 0, radius: 10 },
            { x: 200, y: 0, z: 0, radius: 10 },
        ])!;
        expect(merged.radius).toBeGreaterThanOrEqual(110);
        expect(merged.x).toBeCloseTo(100, 6);
    });

    it('an empty subject list is null, not a sphere at the origin', () => {
        expect(mergeSubjectSpheres([])).toBeNull();
    });
});

describe('metresAcross', () => {
    it('reports the world-scale contract, 8 elmos = 1 m', () => {
        // A 65 m submarine: radius 260 elmos.
        expect(metresAcross({ x: 0, y: 0, z: 0, radius: 260 })).toBeCloseTo(65, 6);
        // A 4 m rifleman: radius 16 elmos.
        expect(metresAcross({ x: 0, y: 0, z: 0, radius: 16 })).toBeCloseTo(4, 6);
    });
});
