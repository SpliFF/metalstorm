import { describe, it, expect } from 'vitest';
import { TrailStore, tessellateTrail, writeRibbonIndices, GaitTracker } from './decal-trails.js';

const W = 24; // track width used throughout

/** Drive a unit along a path, one append per point. */
function drive(store: TrailStore, unitId: number, pts: [number, number][]): void {
    for (const [x, z] of pts) store.append(unitId, x, z, 0, W);
}

function straight(store: TrailStore, unitId = 1, n = 10, step = 20): void {
    for (let i = 0; i < n; i++) store.append(unitId, i * step, 0, 0, W);
}

describe('TrailStore', () => {
    it('thresholds appends on travelled distance (E5)', () => {
        const s = new TrailStore({ minStep: 6 });
        expect(s.append(1, 0, 0, 0, W)).toBe(true);
        expect(s.append(1, 2, 0, 0, W)).toBe(false); // creeping: below minStep
        expect(s.append(1, 5.9, 0, 0, W)).toBe(false);
        expect(s.append(1, 6, 0, 0, W)).toBe(true);
        expect(s.pointCount).toBe(2);
    });

    it('keeps arc length monotonic and equal to travelled distance', () => {
        const s = new TrailStore();
        drive(s, 1, [[0, 0], [30, 0], [30, 40], [0, 40]]);
        const pts = s.drawable()[0].points;
        expect(pts.map((p) => p.s)).toEqual([0, 30, 70, 100]);
        for (let i = 1; i < pts.length; i++) expect(pts[i].s).toBeGreaterThan(pts[i - 1].s);
    });

    it('splits the trail on an LOS gap / teleport instead of bridging (E1)', () => {
        const s = new TrailStore({ gapWidths: 8 });
        drive(s, 1, [[0, 0], [30, 0]]);
        s.append(1, 30 + W * 8 + 1, 0, 0, W); // beyond the gap threshold
        const trails = s.trails();
        expect(trails.length).toBe(2);
        expect(trails[0].open).toBe(false);
        expect(trails[1].points.length).toBe(1);
        expect(trails[1].points[0].s).toBe(0); // fresh arc-length origin
    });

    it('closes the trail on destroy so a reused id starts fresh (E2)', () => {
        const s = new TrailStore();
        drive(s, 7, [[0, 0], [30, 0]]);
        s.close(7);
        s.append(7, 60, 0, 0, W); // id reused by a new unit
        const drawn = s.drawable();
        expect(drawn.length).toBe(1);         // the closed one; the new has 1 pt
        expect(drawn[0].points.length).toBe(2);
        expect(s.trailCount).toBe(2);
    });

    it('fades and retires points from the tail, oldest first', () => {
        const s = new TrailStore({ fadeHoldS: 10, fadeOutS: 10 });
        s.append(1, 0, 0, 0, W);
        s.tick(5);
        s.append(1, 30, 0, 0, W);
        s.tick(10); // head age 15 (mid-fade), tail age 10... clock = 15
        const pts = s.drawable()[0].points;
        expect(s.fadeAt(pts[0].birth)).toBeCloseTo(0.5, 5); // age 15
        expect(s.fadeAt(pts[1].birth)).toBe(1);             // age 10
        s.tick(10); // clock 25: tail age 25 (gone), head age 20 (gone at 20)
        s.retire();
        expect(s.pointCount).toBe(0);
        expect(s.trailCount).toBe(0);
    });

    it('evicts per point, not per trail, over the global budget', () => {
        const s = new TrailStore({ pointBudget: 5, minStep: 1 });
        straight(s, 1, 4, 10);
        s.tick(1);
        straight(s, 2, 4, 10);
        expect(s.pointCount).toBe(8);
        s.retire();
        expect(s.pointCount).toBe(5);
        // The older unit shed 3 of its 4 points; both trails survive, and the
        // younger trail is untouched (eviction is per point, oldest-first).
        expect(s.trailCount).toBe(2);
        const drawn = s.drawable();
        expect(drawn.length).toBe(1);
        expect(drawn[0].unitId).toBe(2);
        expect(drawn[0].points.length).toBe(4);
    });

    it('caps points per trail', () => {
        const s = new TrailStore({ perTrailPoints: 8, minStep: 1 });
        straight(s, 1, 40, 10);
        expect(s.drawable()[0].points.length).toBe(8);
        expect(s.pointCount).toBe(8);
    });
});

describe('tessellateTrail', () => {
    const fade = () => 1;

    it('leaves straights at one station per point (2 verts/point)', () => {
        const s = new TrailStore();
        straight(s, 1, 6, 20);
        const st = tessellateTrail(s.drawable()[0], fade);
        expect(st.length).toBe(6);
    });

    it('subdivides turns and keeps s monotonic through them', () => {
        const s = new TrailStore();
        // 90° corner: the turn must be subdivided rather than kinked (Q2).
        drive(s, 1, [[0, 0], [40, 0], [80, 0], [80, 40], [80, 80]]);
        const st = tessellateTrail(s.drawable()[0], fade);
        expect(st.length).toBeGreaterThan(5);
        for (let i = 1; i < st.length; i++) expect(st[i].s).toBeGreaterThan(st[i - 1].s);
    });

    it('stays within the station budget on a spiral', () => {
        const s = new TrailStore({ perTrailPoints: 512, minStep: 1 });
        for (let i = 0; i < 400; i++) {
            const a = i * 0.4;
            const r = 40 + i * 0.5;
            s.append(1, Math.cos(a) * r, Math.sin(a) * r, 0, W);
        }
        const trail = s.drawable()[0];
        const st = tessellateTrail(trail, fade, { maxStations: 600 });
        expect(st.length).toBeLessThanOrEqual(600);
        expect(st.length).toBeGreaterThan(trail.points.length);
    });

    it('produces continuous unit normals — adjacent quads share edge verts', () => {
        const s = new TrailStore();
        drive(s, 1, [[0, 0], [40, 0], [80, 20], [100, 60], [100, 100]]);
        const st = tessellateTrail(s.drawable()[0], fade);
        for (const p of st) expect(Math.hypot(p.nx, p.nz)).toBeCloseTo(1, 6);
        // A strip shares stations between consecutive quads by construction, so
        // "shared edge verts" reduces to: no normal flips or jumps between them.
        for (let i = 1; i < st.length; i++) {
            const dot = st[i].nx * st[i - 1].nx + st[i].nz * st[i - 1].nz;
            expect(dot).toBeGreaterThan(0.86); // < 30° between adjacent normals
        }
    });

    it('tapers fade along the ribbon from the ageing tail', () => {
        const s = new TrailStore({ fadeHoldS: 0, fadeOutS: 100 });
        for (let i = 0; i < 5; i++) { s.append(1, i * 20, 0, 0, W); s.tick(10); }
        const st = tessellateTrail(s.drawable()[0], (b) => s.fadeAt(b));
        expect(st[0].fade).toBeLessThan(st[st.length - 1].fade);
        for (const p of st) { expect(p.fade).toBeGreaterThanOrEqual(0); expect(p.fade).toBeLessThanOrEqual(1); }
    });

    it('emits quads that share their edge vertices exactly (Q1)', () => {
        const out = new Uint32Array(64);
        const end = writeRibbonIndices(4, 10, out, 0);
        expect(end).toBe(3 * 6); // 3 quads
        // Quad k spans verts 10+2k..10+2k+3; quad k+1 starts at 10+2k+2, i.e.
        // the two vertices are shared, not duplicated — no second surface to
        // double-add at a joint.
        expect([...out.subarray(0, 6)]).toEqual([10, 11, 12, 11, 13, 12]);
        expect([...out.subarray(6, 12)]).toEqual([12, 13, 14, 13, 15, 14]);
        const used = new Set(out.subarray(0, end));
        expect(used.size).toBe(8); // 4 stations × 2 verts, nothing duplicated
    });

    it('survives a self-crossing figure-8 with both turn senses (E3)', () => {
        // The Q1/Q2/Q3 shot: a lemniscate turns left AND right and drives over
        // its own ground. One trail, one strip — the crossing is two separate
        // additive passes, which is correct; what must not happen is a kink, a
        // normal flip, or a non-monotonic s.
        const s = new TrailStore({ perTrailPoints: 512, minStep: 1 });
        const R = 260;
        for (let i = 0; i <= 240; i++) {
            const t = (i / 240) * Math.PI * 2;
            const d = 1 + Math.sin(t) * Math.sin(t);
            s.append(1, (R * Math.cos(t)) / d, (R * Math.sin(t) * Math.cos(t)) / d, 0, W);
        }
        expect(s.trailCount).toBe(1); // no spurious gap split on the tight lobes
        const st = tessellateTrail(s.drawable()[0], () => 1, { maxStations: 4096 });
        for (let i = 1; i < st.length; i++) {
            expect(st[i].s).toBeGreaterThan(st[i - 1].s);
            expect(Math.hypot(st[i].nx, st[i].nz)).toBeCloseTo(1, 6);
            const dot = st[i].nx * st[i - 1].nx + st[i].nz * st[i - 1].nz;
            expect(dot).toBeGreaterThan(0.5); // no flip through the crossing
        }
        // Total tessellated arc length tracks the polyline it was built from.
        const raw = s.drawable()[0].points;
        expect(st[st.length - 1].s).toBeGreaterThan(raw[raw.length - 1].s * 0.9);
    });

    it('draws nothing for a single-point trail', () => {
        const s = new TrailStore();
        s.append(1, 0, 0, 0, W);
        expect(tessellateTrail(s.trails()[0], fade)).toEqual([]);
    });
});

describe('GaitTracker', () => {
    it('alternates left/right starting on the left', () => {
        const g = new GaitTracker();
        expect(g.step(1, 0, 0).side).toBe(-1);
        expect(g.step(1, 10, 0).side).toBe(1);
        expect(g.step(1, 20, 0).side).toBe(-1);
        expect(g.step(1, 30, 0).side).toBe(1);
    });

    it('measures stride as distance from the previous stamp, 0 for the first', () => {
        const g = new GaitTracker();
        expect(g.step(1, 0, 0).stride).toBe(0);
        expect(g.step(1, 30, 40).stride).toBe(50); // 3-4-5 triangle
        expect(g.step(1, 30, 52).stride).toBe(12);
    });

    it('tracks units independently', () => {
        const g = new GaitTracker();
        g.step(1, 0, 0);
        expect(g.step(2, 0, 0).side).toBe(-1); // unit 2's first stamp, unaffected by unit 1
        expect(g.step(1, 10, 0).side).toBe(1);
        expect(g.step(2, 10, 0).side).toBe(1);
    });

    it('resets to the left after close, so a reused id starts fresh (E2)', () => {
        const g = new GaitTracker();
        g.step(7, 0, 0);
        g.step(7, 10, 0); // now due on the right
        g.close(7);
        const step = g.step(7, 100, 100); // reused id
        expect(step.side).toBe(-1);
        expect(step.stride).toBe(0); // no memory of the prior position
    });

    it('clear() forgets every unit', () => {
        const g = new GaitTracker();
        g.step(1, 0, 0);
        g.step(2, 0, 0);
        g.clear();
        expect(g.step(1, 5, 5).side).toBe(-1);
        expect(g.step(2, 5, 5).side).toBe(-1);
    });
});
