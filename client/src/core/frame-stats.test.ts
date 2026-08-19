import { describe, it, expect } from 'vitest';
import { luminanceStats } from './frame-stats.js';

/** Build an RGBA buffer from per-pixel [r,g,b] triples. */
function rgba(px: [number, number, number][]): Uint8ClampedArray {
    const out = new Uint8ClampedArray(px.length * 4);
    px.forEach(([r, g, b], i) => {
        out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
    });
    return out;
}

describe('luminanceStats', () => {
    it('reports zeroes for an all-black buffer', () => {
        expect(luminanceStats(rgba([[0, 0, 0], [0, 0, 0]])))
            .toEqual({ min: 0, max: 0, mean: 0 });
    });

    it('collapses to a single value on a flat surface', () => {
        const s = luminanceStats(rgba(Array(16).fill([128, 128, 128])));
        expect(s.min).toBeCloseTo(128, 6);
        expect(s.max).toBeCloseTo(128, 6);
        expect(s.mean).toBeCloseTo(128, 6);
    });

    it('spreads min..max over a gradient', () => {
        const s = luminanceStats(rgba([[0, 0, 0], [64, 64, 64], [255, 255, 255]]));
        expect(s.max - s.min).toBeGreaterThan(6);   // the render-sanity floor
        expect(s.mean).toBeGreaterThan(s.min);
        expect(s.mean).toBeLessThan(s.max);
    });

    it('uses the Rec.601 weights render-sanity samples with', () => {
        // Pure green is the discriminating channel: 0.587 * 255.
        expect(luminanceStats(rgba([[0, 255, 0]])).mean).toBeCloseTo(0.587 * 255, 6);
        expect(luminanceStats(rgba([[255, 0, 0]])).mean).toBeCloseTo(0.299 * 255, 6);
        expect(luminanceStats(rgba([[0, 0, 255]])).mean).toBeCloseTo(0.114 * 255, 6);
    });

    it('reports zeroes — not min:255 — for an empty buffer', () => {
        // "nothing measured" must not read as "measured pitch black".
        expect(luminanceStats(new Uint8ClampedArray(0)))
            .toEqual({ min: 0, max: 0, mean: 0 });
    });
});
