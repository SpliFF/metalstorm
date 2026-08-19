import { describe, it, expect } from 'vitest';
import { HeightRangeGrid, type ViewFrustum } from './shadow-depth-bounds.js';
import { planPageGrid, decodePageKey } from './terrain-page-grid.js';
import {
    computeVisiblePages, levelForDepth, worldUnitsPerPixel,
} from './terrain-page-visibility.js';

const MAP_ELMOS = 16384;
const SQUARE = 8;

/** Flat map at y=0, heightmap sized so one sample covers one map square. */
function flatHeights(): HeightRangeGrid {
    const n = 513;
    return new HeightRangeGrid(new Uint16Array(n * n), n, n, 0, 1000,
        MAP_ELMOS / (n - 1));
}

/** A map with a ridge across the far half, to prove the height term bites. */
function ridgeHeights(): HeightRangeGrid {
    const n = 513;
    const hm = new Uint16Array(n * n);
    for (let z = 0; z < n; z++) {
        for (let x = 0; x < n; x++) if (z > n / 2) hm[z * n + x] = 65535;
    }
    return new HeightRangeGrid(hm, n, n, 0, 4000, MAP_ELMOS / (n - 1));
}

function norm(v: { x: number; y: number; z: number }) {
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
}
function cross(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
    return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** An RTS-ish oblique camera looking at (`tx`, 0, `tz`) from `height` up. */
function camera(tx: number, tz: number, height: number,
                opts: Partial<ViewFrustum> = {}): ViewFrustum {
    const pos = { x: tx, y: height, z: tz - height };
    const forward = norm({ x: 0, y: -height, z: height });
    const ref = { x: 1, y: 0, z: 0 };
    const right = norm(cross(ref, forward).y === 0 ? ref : ref);
    const up = norm(cross(forward, right));
    return {
        pos, right, up: { x: -up.x, y: -up.y, z: -up.z }, forward,
        xScale: 1.5, yScale: 2.0, near: 1, far: 40000, ...opts,
    };
}

const OPTS = { viewportHeightPx: 1200, maxPages: 256 };

describe('screen-space level selection', () => {
    const grid = planPageGrid(MAP_ELMOS, MAP_ELMOS);

    it('scales world-per-pixel linearly with depth and inversely with zoom', () => {
        expect(worldUnitsPerPixel(1000, 2, 1200)).toBeCloseTo(2000 / 2400, 9);
        expect(worldUnitsPerPixel(2000, 2, 1200))
            .toBeCloseTo(2 * worldUnitsPerPixel(1000, 2, 1200), 9);
        expect(worldUnitsPerPixel(1000, 4, 1200))
            .toBeCloseTo(worldUnitsPerPixel(1000, 2, 1200) / 2, 9);
        expect(worldUnitsPerPixel(1000, 0, 1200)).toBe(Infinity);
    });

    it('picks finer levels closer to the camera, and never leaves the pyramid', () => {
        const near = levelForDepth(grid, 200, 2, 1200);
        const mid = levelForDepth(grid, 4000, 2, 1200);
        const far = levelForDepth(grid, 40000, 2, 1200);
        expect(near).toBe(0);
        expect(mid).toBeGreaterThan(near);
        expect(far).toBeGreaterThanOrEqual(mid);
        expect(far).toBeLessThanOrEqual(grid.rootLevel);
        expect(levelForDepth(grid, 1e9, 2, 1200)).toBe(grid.rootLevel);
    });

    it('levelBias trades sharpness for residency in whole levels', () => {
        const base = levelForDepth(grid, 4000, 2, 1200, 0);
        expect(levelForDepth(grid, 4000, 2, 1200, 1)).toBe(base + 1);
        expect(levelForDepth(grid, 4000, 2, 1200, -1)).toBe(base - 1);
    });
});

describe('computeVisiblePages', () => {
    const grid = planPageGrid(MAP_ELMOS, MAP_ELMOS);
    const heights = flatHeights();

    it('returns a bounded, multi-resolution set nearest-first', () => {
        const set = computeVisiblePages(
            grid, heights, camera(8192, 8192, 1500), OPTS);
        expect(set.length).toBeGreaterThan(0);
        expect(set.length).toBeLessThanOrEqual(256);
        // Nearest first — this is the order requests are issued in.
        for (let i = 1; i < set.length; i++) {
            expect(set[i].depth).toBeGreaterThanOrEqual(set[i - 1].depth);
        }
        // Multi-resolution: fine under the camera, coarse toward the horizon.
        const levels = new Set(set.map((p) => p.id.level));
        expect(levels.size).toBeGreaterThan(1);
        expect(set[0].id.level).toBeLessThan(set[set.length - 1].id.level);
    });

    it('never emits a page twice, and every page is a real address', () => {
        const set = computeVisiblePages(
            grid, heights, camera(8192, 8192, 1500), OPTS);
        expect(new Set(set.map((p) => p.key)).size).toBe(set.length);
        for (const p of set) {
            expect(decodePageKey(p.key)).toEqual(p.id);
            expect(p.id.x).toBeLessThan(grid.levels[p.id.level].pagesX);
            expect(p.id.z).toBeLessThan(grid.levels[p.id.level].pagesZ);
        }
    });

    it('emits pages near the camera and not the far corner behind it', () => {
        // Camera at the NW corner looking south-east-ish: the SE corner of the
        // map must not be in the set at level 0.
        const set = computeVisiblePages(
            grid, heights, camera(1024, 1024, 800), OPTS);
        const fine = set.filter((p) => p.id.level === 0);
        expect(fine.length).toBeGreaterThan(0);
        for (const p of fine) {
            expect(p.id.x).toBeLessThan(12);
            expect(p.id.z).toBeLessThan(12);
        }
    });

    it('culls against the heightfield, not just the map box', () => {
        // A narrow frustum from 3000 elmos up, tilted slightly UP: its lower
        // edge never descends below y=3000, so flat ground at y=0 is outside
        // it everywhere. Only terrain that stands up into the slab is visible.
        // This is the "∩ heightfield" half — with a map-wide height box both
        // arms would return the same set.
        const f = norm({ x: 0, y: 0.15, z: 1 });
        const right = { x: 1, y: 0, z: 0 };
        const view: ViewFrustum = {
            pos: { x: 8192, y: 3000, z: 0 },
            forward: f, right, up: norm(cross(f, right)),
            xScale: 20, yScale: 20, near: 1, far: 40000,
        };
        expect(computeVisiblePages(grid, flatHeights(), view, OPTS)).toEqual([]);
        expect(computeVisiblePages(grid, ridgeHeights(), view, OPTS).length)
            .toBeGreaterThan(0);
    });

    it('honours maxPages by coarsening, never by dropping ground', () => {
        const big = computeVisiblePages(
            grid, heights, camera(8192, 8192, 1500), { ...OPTS, maxPages: 256 });
        const small = computeVisiblePages(
            grid, heights, camera(8192, 8192, 1500), { ...OPTS, maxPages: 24 });
        expect(small.length).toBeLessThanOrEqual(24);
        // Coarsened, not truncated: the capped run's mean level is higher.
        const mean = (s: typeof big) =>
            s.reduce((a, p) => a + p.id.level, 0) / s.length;
        expect(mean(small)).toBeGreaterThan(mean(big));
    });

    it('adds a predicted ring that never outranks the visible set', () => {
        const view = camera(8192, 8192, 1500);
        const plain = computeVisiblePages(grid, heights, view, OPTS);
        const padded = computeVisiblePages(
            grid, heights, view, { ...OPTS, predictPadFrac: 0.5 });
        expect(padded.length).toBeGreaterThan(plain.length);
        const firstPredicted = padded.findIndex((p) => p.want === 'predicted');
        expect(firstPredicted).toBeGreaterThan(0);
        for (let i = firstPredicted; i < padded.length; i++) {
            expect(padded[i].want).toBe('predicted');
        }
    });

    it('reports a texel-to-pixel ratio at or above 1 for what it emits', () => {
        const set = computeVisiblePages(
            grid, heights, camera(8192, 8192, 1500), OPTS);
        // The descent stops at the coarsest level still finer than the screen,
        // so a page below 1.0 would be a page blurrier than it needed to be.
        const undersampled = set.filter(
            (p) => p.id.level > 0 && p.texelsPerPixel < 0.999);
        expect(undersampled).toEqual([]);
    });

    it('returns nothing when the camera looks away from the world', () => {
        const away: ViewFrustum = {
            ...camera(8192, 8192, 1500),
            pos: { x: 8192, y: 5000, z: 8192 },
            forward: { x: 0, y: 1, z: 0 },
            up: { x: 0, y: 0, z: 1 }, right: { x: 1, y: 0, z: 0 },
        };
        expect(computeVisiblePages(grid, heights, away, OPTS)).toEqual([]);
    });
});
