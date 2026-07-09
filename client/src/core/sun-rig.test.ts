/**
 * Sun vector math tests (PLAN-model-harness §11): azimuth/elevation →
 * light direction, angle round-trip, and the day–night cycle arc.
 */

import { describe, expect, it } from 'vitest';
import {
    anglesFromLightDirection,
    CYCLE_HORIZON_DIP_DEG,
    daylightFactor,
    sunCycleAngles,
    sunDirectionFromAngles,
} from './sun-rig.js';

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

describe('sunDirectionFromAngles', () => {
    it('overhead sun (el=90) shines straight down', () => {
        const d = sunDirectionFromAngles({ azimuthDeg: 0, elevationDeg: 90 });
        expect(close(d.x, 0, 1e-12)).toBe(true);
        expect(d.y).toBeCloseTo(-1, 12);
        expect(close(d.z, 0, 1e-12)).toBe(true);
    });

    it('horizon sun at azimuth 0 shines toward −X, level', () => {
        const d = sunDirectionFromAngles({ azimuthDeg: 0, elevationDeg: 0 });
        expect(d.x).toBeCloseTo(-1, 12);
        expect(d.y).toBeCloseTo(0, 12);
        expect(d.z).toBeCloseTo(0, 12);
    });

    it('azimuth 90 puts the sun toward +Z (light toward −Z)', () => {
        const d = sunDirectionFromAngles({ azimuthDeg: 90, elevationDeg: 45 });
        expect(d.z).toBeLessThan(0);
        expect(Math.abs(d.x)).toBeLessThan(1e-9);
        expect(d.y).toBeCloseTo(-Math.SQRT1_2, 6);
    });

    it('is always unit length', () => {
        for (const az of [0, 33, 90, 180, 251, 359]) {
            for (const el of [-30, -5, 0, 15, 60, 89]) {
                const d = sunDirectionFromAngles({ azimuthDeg: az, elevationDeg: el });
                expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
            }
        }
    });

    it('round-trips through anglesFromLightDirection', () => {
        for (const az of [10, 87, 178, 265]) {
            for (const el of [-20, 5, 45, 80]) {
                const back = anglesFromLightDirection(
                    sunDirectionFromAngles({ azimuthDeg: az, elevationDeg: el }));
                // atan2 returns (−180, 180]; normalise for comparison.
                const azBack = (back.azimuthDeg + 360) % 360;
                expect(azBack).toBeCloseTo(az, 6);
                expect(back.elevationDeg).toBeCloseTo(el, 6);
            }
        }
    });
});

describe('sunCycleAngles', () => {
    it('dawn (phase 0) sits at the horizon dip', () => {
        const a = sunCycleAngles(0);
        expect(a.elevationDeg).toBeCloseTo(CYCLE_HORIZON_DIP_DEG, 9);
        expect(a.azimuthDeg).toBeCloseTo(0, 9);
    });

    it('noon (phase 0.25) reaches the peak elevation', () => {
        expect(sunCycleAngles(0.25, 60).elevationDeg).toBeCloseTo(60, 9);
        expect(sunCycleAngles(0.25, 45).elevationDeg).toBeCloseTo(45, 9);
    });

    it('dusk (phase 0.5) returns to the horizon dip', () => {
        expect(sunCycleAngles(0.5).elevationDeg).toBeCloseTo(CYCLE_HORIZON_DIP_DEG, 9);
    });

    it('night (phase 0.75) is below the horizon', () => {
        expect(sunCycleAngles(0.75).elevationDeg).toBeLessThan(CYCLE_HORIZON_DIP_DEG);
    });

    it('azimuth sweeps the full 360° over a day', () => {
        expect(sunCycleAngles(0.5).azimuthDeg).toBeCloseTo(180, 9);
        expect(sunCycleAngles(0.999).azimuthDeg).toBeCloseTo(359.64, 2);
    });

    it('wraps phase outside [0,1)', () => {
        const a = sunCycleAngles(1.25);
        const b = sunCycleAngles(0.25);
        expect(a.azimuthDeg).toBeCloseTo(b.azimuthDeg, 9);
        expect(a.elevationDeg).toBeCloseTo(b.elevationDeg, 9);
    });
});

describe('daylightFactor', () => {
    it('full night below the dip, full day above +10°', () => {
        expect(daylightFactor(-10)).toBe(0);
        expect(daylightFactor(CYCLE_HORIZON_DIP_DEG)).toBe(0);
        expect(daylightFactor(10)).toBe(1);
        expect(daylightFactor(60)).toBe(1);
    });

    it('twilight is monotonic between the two', () => {
        let prev = 0;
        for (let el = CYCLE_HORIZON_DIP_DEG; el <= 10; el += 1) {
            const f = daylightFactor(el);
            expect(f).toBeGreaterThanOrEqual(prev);
            prev = f;
        }
    });
});
