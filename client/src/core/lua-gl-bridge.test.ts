import { describe, it, expect } from 'vitest';
import { groundCircleVertices } from './lua-gl-bridge.js';

describe('groundCircleVertices (gl.DrawGroundCircle geometry)', () => {
    it('emits exactly `divs` vertices (3 floats each)', () => {
        const v = groundCircleVertices(0, 0, 0, 100, 24, null);
        expect(v.length).toBe(24 * 3);
    });

    it('places points on the circle of the given radius around the centre', () => {
        const cx = 500, cz = 300, r = 128;
        const v = groundCircleVertices(cx, 0, cz, r, 32, null);
        for (let i = 0; i < v.length; i += 3) {
            const dx = v[i] - cx;
            const dz = v[i + 2] - cz;
            expect(Math.hypot(dx, dz)).toBeCloseTo(r, 4);
        }
    });

    it('uses the flat fallback Y when no sampler is wired', () => {
        const v = groundCircleVertices(0, 42, 0, 50, 8, null);
        for (let i = 1; i < v.length; i += 3) expect(v[i]).toBe(42);
    });

    it('lifts each vertex to the sampled terrain height', () => {
        // sampler returns a height that depends on x so we can tell vertices apart
        const sample = (x: number, _z: number) => x * 0.5;
        const v = groundCircleVertices(0, 999, 0, 200, 12, sample);
        for (let i = 0; i < v.length; i += 3) {
            expect(v[i + 1]).toBeCloseTo(v[i] * 0.5, 6);
        }
        // and never the flat fallback
        expect(v.some((_, i) => i % 3 === 1 && v[i] === 999)).toBe(false);
    });

    it('starts at the +Z point (angle 0 → sin 0, cos 1)', () => {
        const v = groundCircleVertices(10, 0, 20, 64, 16, null);
        expect(v[0]).toBeCloseTo(10, 6);     // x = px + r·sin(0)
        expect(v[2]).toBeCloseTo(20 + 64, 6); // z = pz + r·cos(0)
    });
});
