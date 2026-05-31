import { describe, it, expect } from 'vitest';
import { EntityInterpolator } from './entity-interpolator.js';

function push(interp: EntityInterpolator, id: number, frame: number, x: number, z: number, heading = 0) {
    interp.pushState(id, frame, x, 0, z, heading);
}

describe('EntityInterpolator (frame-keyed jitter buffer)', () => {
    it('interpolates between the two samples bracketing the cursor', () => {
        const interp = new EntityInterpolator();
        push(interp, 1, 100, 0, 0);
        push(interp, 1, 103, 30, 0); // moved +30 over 3 frames
        const p = interp.getInterpolated(1, 101.5)!; // halfway
        expect(p.x).toBeCloseTo(15, 5);
    });

    it('clamps to the oldest sample when the cursor is behind the buffer', () => {
        const interp = new EntityInterpolator();
        push(interp, 1, 100, 10, 0);
        push(interp, 1, 103, 40, 0);
        const p = interp.getInterpolated(1, 90)!;
        expect(p.x).toBeCloseTo(10, 5);
    });

    it('bounded-extrapolates then holds past the newest sample', () => {
        const interp = new EntityInterpolator();
        push(interp, 1, 100, 0, 0);
        push(interp, 1, 103, 30, 0); // velocity = 10/frame
        // 1 frame past newest → extrapolate to 40.
        expect(interp.getInterpolated(1, 104)!.x).toBeCloseTo(40, 5);
        // 2 frames past (EXTRAP_MAX) → 50.
        expect(interp.getInterpolated(1, 105)!.x).toBeCloseTo(50, 5);
        // Far past → holds at the EXTRAP_MAX-capped value (50), not flung out.
        expect(interp.getInterpolated(1, 130)!.x).toBeCloseTo(50, 5);
    });

    it('snaps across a teleport instead of lerping (LOS-regain guard)', () => {
        const interp = new EntityInterpolator();
        push(interp, 1, 100, 0, 0);
        push(interp, 1, 103, 1000, 0); // > 200 elmo jump
        const p = interp.getInterpolated(1, 101.5)!;
        // Should snap to the fresher sample, not draw a comet streak.
        expect(p.x).toBeCloseTo(1000, 5);
    });

    it('returns the lone sample when only one exists', () => {
        const interp = new EntityInterpolator();
        push(interp, 1, 100, 7, 9);
        const p = interp.getInterpolated(1, 200)!;
        expect(p.x).toBeCloseTo(7, 5);
        expect(p.z).toBeCloseTo(9, 5);
    });

    it('inserts reordered (late) samples in frame order', () => {
        const interp = new EntityInterpolator();
        push(interp, 1, 100, 0, 0);
        push(interp, 1, 106, 60, 0);
        push(interp, 1, 103, 30, 0); // arrives late, belongs in the middle
        // Cursor at 104.5 must bracket 103↔106, giving x≈45.
        const p = interp.getInterpolated(1, 104.5)!;
        expect(p.x).toBeCloseTo(45, 5);
    });

    it('lerps heading along the shortest path across the wrap', () => {
        const interp = new EntityInterpolator();
        push(interp, 1, 100, 0, 0, 64000); // near top of u16 range
        push(interp, 1, 103, 0, 0, 1000);  // wrapped just past 0
        const p = interp.getInterpolated(1, 101.5)!;
        // Shortest path crosses 0, not the long way down through 32000.
        expect(p.heading > 64000 || p.heading < 1500).toBe(true);
    });

    it('evicts old samples beyond the ring cap', () => {
        const interp = new EntityInterpolator();
        for (let i = 0; i < 20; i++) push(interp, 1, 100 + i * 3, i * 3, 0);
        // Oldest sample (frame 100) should have been evicted; cursor there
        // now clamps to whatever the oldest retained sample is (> 100).
        const p = interp.getInterpolated(1, 100)!;
        expect(p.x).toBeGreaterThan(0);
    });

    it('removes and clears entities', () => {
        const interp = new EntityInterpolator();
        push(interp, 1, 100, 0, 0);
        push(interp, 2, 100, 0, 0);
        expect(interp.size).toBe(2);
        interp.remove(1);
        expect(interp.size).toBe(1);
        interp.clear();
        expect(interp.size).toBe(0);
    });
});
