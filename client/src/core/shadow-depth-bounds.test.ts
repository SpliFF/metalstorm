/**
 * PLAN-perf M8 — the analytic CSM depth slab.
 *
 * The whole point of the milestone is that this replaces a *measurement* (a
 * scene depth pass reduced to 1×1 and read back) with geometry, so the geometry
 * has to be right: too wide only costs cascade texel density, but too narrow
 * silently drops shadows. Every case below therefore checks the slab against a
 * hand-derived answer, and the "must contain" cases assert containment rather
 * than equality.
 */

import { describe, it, expect } from 'vitest';
import {
    viewDepthRangeOfBox, HeightRangeGrid, type ViewFrustum, type WorldBox,
} from './shadow-depth-bounds.js';

/** A 1000×1000 map, ground at y=0, 100 elmos of headroom. */
const MAP: WorldBox = { minX: 0, maxX: 1000, minY: 0, maxY: 100, minZ: 0, maxZ: 1000 };

/** 90° square frustum (xScale = yScale = 1 ⇒ half-extent == depth). */
function frustum(pos: {x: number, y: number, z: number},
                 forward: {x: number, y: number, z: number},
                 opts: Partial<ViewFrustum> = {}): ViewFrustum {
    // Any orthonormal completion works — the slab depends only on `forward`
    // and the extents, and the frustum is symmetric in right/up.
    const f = normalise(forward);
    const ref = Math.abs(f.y) > 0.9 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 };
    const right = normalise(cross(ref, f));
    const up = cross(f, right);
    return { pos, right, up, forward: f, xScale: 1, yScale: 1, near: 1, far: 10000, ...opts };
}

function cross(a: {x: number, y: number, z: number}, b: {x: number, y: number, z: number}) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function normalise(v: {x: number, y: number, z: number}) {
    const l = Math.hypot(v.x, v.y, v.z);
    return { x: v.x / l, y: v.y / l, z: v.z / l };
}

describe('viewDepthRangeOfBox', () => {
    it('straight down at the map centre: the slab is the box top and bottom', () => {
        // Camera 500 above the centre looking down. The nearest visible point
        // is the box top directly below (depth 500 - 100 = 400); the farthest
        // is the box floor at the frustum's corner, 500 below and 500 out in
        // both x and z ⇒ depth 500 (the *depth* is the along-forward
        // component, which is the height drop, so the floor is at 500).
        const r = viewDepthRangeOfBox(
            frustum({ x: 500, y: 500, z: 500 }, { x: 0, y: -1, z: 0 }), MAP);
        expect(r).not.toBeNull();
        expect(r!.minDepth).toBeCloseTo(400, 6);
        expect(r!.maxDepth).toBeCloseTo(500, 6);
    });

    it('an RTS three-quarter view brackets the ground point it is aimed at', () => {
        // 45° down from 400 up, looking toward +z. The look-at ground point is
        // 400 ahead horizontally and 400 below ⇒ view depth 400·√2 ≈ 565.7.
        const view = frustum({ x: 500, y: 400, z: 100 }, { x: 0, y: -1, z: 1 });
        const r = viewDepthRangeOfBox(view, MAP);
        expect(r).not.toBeNull();
        expect(r!.minDepth).toBeLessThan(400 * Math.SQRT2);
        expect(r!.maxDepth).toBeGreaterThan(400 * Math.SQRT2);
    });

    it('the slab never starts before the near plane or ends past the far plane', () => {
        const view = frustum({ x: 500, y: 50, z: 500 }, { x: 0, y: 0, z: 1 },
                             { near: 7, far: 300 });
        const r = viewDepthRangeOfBox(view, MAP)!;
        expect(r.minDepth).toBeGreaterThanOrEqual(7);
        expect(r.maxDepth).toBeLessThanOrEqual(300);
        // Sitting inside the box, so the near plane itself is already in it.
        expect(r.minDepth).toBeCloseTo(7, 6);
        expect(r.maxDepth).toBeCloseTo(300, 6);
    });

    it('returns null when the camera looks away from the map', () => {
        // Off the west edge, looking further west. Nothing of the box is in
        // front of the camera at all.
        expect(viewDepthRangeOfBox(
            frustum({ x: -2000, y: 200, z: 500 }, { x: -1, y: 0, z: 0 }), MAP)).toBeNull();
    });

    it('returns null when the camera looks up at the sky', () => {
        expect(viewDepthRangeOfBox(
            frustum({ x: 500, y: 500, z: 500 }, { x: 0, y: 1, z: 0 }), MAP)).toBeNull();
    });

    it('a narrow field of view yields a tighter slab than a wide one', () => {
        // Same pose; zooming in (larger xScale/yScale) must never widen the
        // slab, because the frustum it clips with is a subset.
        const pos = { x: 500, y: 600, z: 200 }, fwd = { x: 0, y: -1, z: 1 };
        const wide = viewDepthRangeOfBox(frustum(pos, fwd), MAP)!;
        const narrow = viewDepthRangeOfBox(
            frustum(pos, fwd, { xScale: 4, yScale: 4 }), MAP)!;
        expect(narrow.minDepth).toBeGreaterThanOrEqual(wide.minDepth - 1e-9);
        expect(narrow.maxDepth).toBeLessThanOrEqual(wide.maxDepth + 1e-9);
    });

    it('contains every box corner that is actually inside the frustum', () => {
        // Property check across a spread of poses: the slab must bracket the
        // depth of any box vertex the frustum can see, or that vertex's shadow
        // would fall outside every cascade.
        const poses = [
            { p: { x: 500, y: 900, z: 500 }, f: { x: 0, y: -1, z: 0 } },
            { p: { x: -300, y: 400, z: -300 }, f: { x: 1, y: -0.6, z: 1 } },
            { p: { x: 1400, y: 250, z: 500 }, f: { x: -1, y: -0.2, z: 0 } },
            { p: { x: 500, y: 60, z: 500 }, f: { x: 0.3, y: -0.1, z: 1 } },
            { p: { x: 2500, y: 2000, z: 2500 }, f: { x: -1, y: -1, z: -1 } },
        ];
        for (const { p, f } of poses) {
            const view = frustum(p, f);
            const r = viewDepthRangeOfBox(view, MAP);
            for (let i = 0; i < 8; i++) {
                const c = {
                    x: (i & 1) ? MAP.maxX : MAP.minX,
                    y: (i & 2) ? MAP.maxY : MAP.minY,
                    z: (i & 4) ? MAP.maxZ : MAP.minZ,
                };
                const d = { x: c.x - p.x, y: c.y - p.y, z: c.z - p.z };
                const vz = d.x * view.forward.x + d.y * view.forward.y + d.z * view.forward.z;
                const vx = d.x * view.right.x + d.y * view.right.y + d.z * view.right.z;
                const vy = d.x * view.up.x + d.y * view.up.y + d.z * view.up.z;
                const visible = vz >= view.near && vz <= view.far
                    && Math.abs(vx) <= vz / view.xScale && Math.abs(vy) <= vz / view.yScale;
                if (!visible) continue;
                expect(r).not.toBeNull();
                expect(r!.minDepth).toBeLessThanOrEqual(vz + 1e-6);
                expect(r!.maxDepth).toBeGreaterThanOrEqual(vz - 1e-6);
            }
        }
    });

    it('rejects a degenerate projection instead of emitting NaN bounds', () => {
        const view = frustum({ x: 500, y: 500, z: 500 }, { x: 0, y: -1, z: 0 },
                             { xScale: 0 });
        expect(viewDepthRangeOfBox(view, MAP)).toBeNull();
    });

    it('reports the XZ footprint the height grid then tightens the box with', () => {
        // Straight down from 500 with a 90° frustum: the footprint at the box
        // top (y=100, depth 400) is ±400 and at the floor (depth 500) is ±500,
        // so the union is the ±500 square, clipped to the map.
        const r = viewDepthRangeOfBox(
            frustum({ x: 500, y: 500, z: 500 }, { x: 0, y: -1, z: 0 }), MAP)!;
        expect(r.minX).toBeCloseTo(0, 6);
        expect(r.maxX).toBeCloseTo(1000, 6);
        expect(r.minZ).toBeCloseTo(0, 6);
        expect(r.maxZ).toBeCloseTo(1000, 6);
    });

    it('is far tighter than the unfitted 1..8000 slab at RTS zoom', () => {
        // The number that makes M8 worth doing: at a normal RTS pose the fitted
        // slab is a small fraction of what the cascades would otherwise span.
        const r = viewDepthRangeOfBox(
            frustum({ x: 500, y: 620, z: 100 }, { x: 0, y: -0.7, z: 1 },
                    { near: 1, far: 50000 }), MAP)!;
        expect(r.maxDepth - r.minDepth).toBeLessThan(2000);
    });
});

describe('HeightRangeGrid', () => {
    /** 257×257 heightmap: a flat plain at 0 with one mountain in the NE corner. */
    function makeGrid() {
        const n = 257, hm = new Uint16Array(n * n);
        for (let z = 0; z < n; z++) {
            for (let x = 0; x < n; x++) {
                // Raw 65535 maps to maxHeight (1000); the mountain is the
                // block x>=200, z>=200, i.e. world x,z >= 3200 at squareSize 16.
                hm[z * n + x] = (x >= 200 && z >= 200) ? 65535 : 0;
            }
        }
        return new HeightRangeGrid(hm, n, n, 0, 1000, 16);
    }

    it('reports the flat plain, not the map-wide maximum, away from the mountain', () => {
        const g = makeGrid();
        const r = g.rangeOverRect(0, 1000, 0, 1000);
        expect(r.min).toBeCloseTo(0, 3);
        // The dilation and the mip level can only reach a little past the
        // query; it must not drag in the mountain 2000 elmos away.
        expect(r.max).toBeLessThan(500);
    });

    it('reports the mountain when the query covers it', () => {
        const g = makeGrid();
        const r = g.rangeOverRect(3300, 4000, 3300, 4000);
        expect(r.max).toBeCloseTo(1000, 3);
    });

    it('is conservative: a query never under-reports what it covers', () => {
        const g = makeGrid();
        // A rect straddling the mountain edge must include the mountain even
        // though most of it is plain — under-reporting here would cut casters
        // out of the cascades.
        const r = g.rangeOverRect(3100, 3400, 3100, 3400);
        expect(r.max).toBeCloseTo(1000, 3);
        expect(r.min).toBeCloseTo(0, 3);
    });

    it('falls back to a coarser level for a whole-map query instead of scanning every cell', () => {
        const g = makeGrid();
        const r = g.rangeOverRect(0, 4112, 0, 4112);
        expect(r.min).toBeCloseTo(0, 3);
        expect(r.max).toBeCloseTo(1000, 3);
    });
});
