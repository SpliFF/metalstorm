/**
 * Bounding-sphere + framing math tests for the orbit rig
 * (PLAN-model-harness §11): single unit, squad cloud, degenerate flat
 * model, pitch/zoom clamps, orbit pose.
 */

import { describe, expect, it } from 'vitest';
import {
    clampOrbitDistance,
    clampPitchDeg,
    frameDistance,
    mergeSpheres,
    orbitCameraPos,
    ORBIT_PITCH_MAX_DEG,
    ORBIT_PITCH_MIN_DEG,
    type Sphere,
} from './orbit-rig.js';

describe('mergeSpheres', () => {
    it('single sphere is returned unchanged', () => {
        const s: Sphere = { x: 10, y: 5, z: -3, radius: 22 };
        expect(mergeSpheres([s])).toEqual(s);
    });

    it('empty cloud yields null', () => {
        expect(mergeSpheres([])).toBeNull();
    });

    it('contained sphere does not grow the bound', () => {
        const big: Sphere = { x: 0, y: 0, z: 0, radius: 100 };
        const small: Sphere = { x: 10, y: 0, z: 0, radius: 5 };
        expect(mergeSpheres([big, small])).toEqual(big);
        // Order-independent: the small-first case swaps to the big one.
        expect(mergeSpheres([small, big])).toEqual(big);
    });

    it('squad cloud: bound contains every member sphere', () => {
        // 5 members in a loose line-abreast formation.
        const cloud: Sphere[] = [
            { x: -80, y: 0, z: 0, radius: 12 },
            { x: -40, y: 0, z: 10, radius: 12 },
            { x: 0, y: 0, z: -5, radius: 12 },
            { x: 40, y: 0, z: 8, radius: 12 },
            { x: 80, y: 2, z: 0, radius: 12 },
        ];
        const b = mergeSpheres(cloud)!;
        for (const m of cloud) {
            const d = Math.hypot(m.x - b.x, m.y - b.y, m.z - b.z);
            expect(d + m.radius).toBeLessThanOrEqual(b.radius + 1e-9);
        }
        // And it is not wildly loose (within 2× the exact span/2 = 92).
        expect(b.radius).toBeLessThan(184);
    });

    it('two disjoint equal spheres bound is the classic midpoint merge', () => {
        const b = mergeSpheres([
            { x: -50, y: 0, z: 0, radius: 10 },
            { x: 50, y: 0, z: 0, radius: 10 },
        ])!;
        expect(b.x).toBeCloseTo(0, 9);
        expect(b.radius).toBeCloseTo(60, 9);
    });
});

describe('frameDistance', () => {
    const FOV = 0.8; // Babylon default vertical FOV (radians)

    it('fills 70% of the vertical axis on a landscape viewport', () => {
        const r = 50;
        const d = frameDistance(r, FOV, 16 / 9, 0.7);
        // Projected angular radius / half-fov should equal the fill.
        expect(Math.atan(r / d) / (FOV / 2)).toBeCloseTo(0.7, 1);
    });

    it('portrait viewports frame against the horizontal axis', () => {
        const landscape = frameDistance(50, FOV, 16 / 9, 0.7);
        const portrait = frameDistance(50, FOV, 9 / 16, 0.7);
        // Horizontal half-fov is smaller in portrait → camera further away.
        expect(portrait).toBeGreaterThan(landscape);
    });

    it('degenerate flat model (radius 0) still frames at the floor radius', () => {
        const d = frameDistance(0, FOV, 16 / 9, 0.7);
        expect(d).toBeGreaterThan(0);
        expect(Number.isFinite(d)).toBe(true);
        // Same as an explicit floor-radius sphere.
        expect(d).toBeCloseTo(frameDistance(4, FOV, 16 / 9, 0.7), 9);
    });

    it('scales linearly with radius', () => {
        const d1 = frameDistance(20, FOV, 16 / 9);
        const d2 = frameDistance(40, FOV, 16 / 9);
        expect(d2 / d1).toBeCloseTo(2, 9);
    });
});

describe('clamps', () => {
    it('pitch clamps to the documented 5°–85° band', () => {
        expect(clampPitchDeg(-30)).toBe(ORBIT_PITCH_MIN_DEG);
        expect(clampPitchDeg(200)).toBe(ORBIT_PITCH_MAX_DEG);
        expect(clampPitchDeg(45)).toBe(45);
    });

    it('zoom clamps to 1.2×–10× sphere radius', () => {
        expect(clampOrbitDistance(1, 50)).toBeCloseTo(60, 9);
        expect(clampOrbitDistance(1e6, 50)).toBeCloseTo(500, 9);
        expect(clampOrbitDistance(200, 50)).toBe(200);
    });

    it('zoom clamp floors degenerate radii', () => {
        const d = clampOrbitDistance(0, 0);
        expect(d).toBeGreaterThan(0);
    });
});

describe('orbitCameraPos', () => {
    const anchor = { x: 100, y: 20, z: -50 };

    it('keeps the requested distance from the anchor', () => {
        for (const yaw of [0, 45, 133, 270]) {
            for (const pitch of [5, 30, 85]) {
                const p = orbitCameraPos(anchor, yaw, pitch, 240);
                const d = Math.hypot(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z);
                expect(d).toBeCloseTo(240, 9);
            }
        }
    });

    it('pitch 90 would be straight above; pitch 5 is nearly level', () => {
        const high = orbitCameraPos(anchor, 0, 85, 100);
        const low = orbitCameraPos(anchor, 0, 5, 100);
        expect(high.y - anchor.y).toBeGreaterThan(low.y - anchor.y);
        expect(low.y - anchor.y).toBeCloseTo(100 * Math.sin(5 * Math.PI / 180), 9);
    });

    it('yaw sweeps the horizontal circle', () => {
        const east = orbitCameraPos(anchor, 0, 30, 100);
        const south = orbitCameraPos(anchor, 90, 30, 100);
        expect(east.x).toBeGreaterThan(anchor.x);
        expect(Math.abs(east.z - anchor.z)).toBeLessThan(1e-9);
        expect(south.z).toBeGreaterThan(anchor.z);
        expect(Math.abs(south.x - anchor.x)).toBeLessThan(1e-9);
    });
});
