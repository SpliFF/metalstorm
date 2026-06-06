import { describe, it, expect } from 'vitest';
import { planAtlasPages, type AtlasPagePlan } from './terrain.js';

const TILE_PIXELS = 32;
const MAX = 16384; // typical WebGL2 MAX_TEXTURE_SIZE
const maxPageTiles = MAX / TILE_PIXELS; // 512

// Every page must fit the cap, the pages must tile the whole map with no
// gaps/overlap, and the UV remap (uScale/uOffset) a page material would use
// must map that page's global UV span onto [0,1].
function checkPlanCoversMap(plan: AtlasPagePlan, tilesX: number, tilesZ: number) {
    // pages fit the cap
    for (const r of plan.rects) {
        expect(r.tileCountX).toBeLessThanOrEqual(maxPageTiles);
        expect(r.tileCountZ).toBeLessThanOrEqual(maxPageTiles);
        expect(r.tileCountX).toBeGreaterThan(0);
        expect(r.tileCountZ).toBeGreaterThan(0);
    }
    // every map tile is covered by exactly one page (plain JS, assert once —
    // per-tile expect() over 100k+ tiles is too slow)
    const covered = new Uint8Array(tilesX * tilesZ);
    let overlap = false, outOfBounds = false;
    for (const r of plan.rects) {
        for (let tz = r.tileZ0; tz < r.tileZ0 + r.tileCountZ; tz++) {
            for (let tx = r.tileX0; tx < r.tileX0 + r.tileCountX; tx++) {
                if (tz >= tilesZ || tx >= tilesX) { outOfBounds = true; continue; }
                if (covered[tz * tilesX + tx]) overlap = true;
                covered[tz * tilesX + tx] = 1;
            }
        }
    }
    expect(outOfBounds).toBe(false);
    expect(overlap).toBe(false);
    expect(covered.every((v) => v === 1)).toBe(true); // no gaps

    // UV remap: a vertex at the page's tile-span edges lands at [0,1].
    for (const r of plan.rects) {
        const uScale = tilesX / r.tileCountX;
        const uOffset = -r.tileX0 / r.tileCountX;
        const uStart = r.tileX0 / tilesX; // global UV at page's left edge
        const uEnd = (r.tileX0 + r.tileCountX) / tilesX;
        expect(uStart * uScale + uOffset).toBeCloseTo(0, 6);
        expect(uEnd * uScale + uOffset).toBeCloseTo(1, 6);
    }
}

describe('planAtlasPages', () => {
    it('uses a single full-map page when the map fits the cap', () => {
        // 224x224 tiles → 7168px, well under 16384
        const plan = planAtlasPages(224, 224, MAX);
        expect(plan.pagesX).toBe(1);
        expect(plan.pagesZ).toBe(1);
        expect(plan.rects).toHaveLength(1);
        expect(plan.rects[0]).toEqual({ tileX0: 0, tileZ0: 0, tileCountX: 224, tileCountZ: 224 });
        checkPlanCoversMap(plan, 224, 224);
    });

    it('exactly at the cap stays a single page', () => {
        const plan = planAtlasPages(512, 512, MAX); // 16384px == cap
        expect(plan.pagesX).toBe(1);
        expect(plan.pagesZ).toBe(1);
        checkPlanCoversMap(plan, 512, 512);
    });

    it('splits the real over-cap case (544x544 tiles → 17408px) into 2x2', () => {
        const plan = planAtlasPages(544, 544, MAX);
        expect(plan.pagesX).toBe(2);
        expect(plan.pagesZ).toBe(2);
        expect(plan.pageTilesX).toBe(272); // balanced, not 512+32
        expect(plan.pageTilesZ).toBe(272);
        expect(plan.rects).toHaveLength(4);
        // 272 tiles = 8704px ≤ 16384
        for (const r of plan.rects) {
            expect(r.tileCountX * TILE_PIXELS).toBeLessThanOrEqual(MAX);
        }
        checkPlanCoversMap(plan, 544, 544);
    });

    it('handles a non-square over-cap map with an uneven remainder', () => {
        const plan = planAtlasPages(600, 513, MAX);
        expect(plan.pagesX).toBe(2); // 600 > 512
        expect(plan.pagesZ).toBe(2); // 513 > 512
        checkPlanCoversMap(plan, 600, 513);
    });

    it('handles a very large map needing a 3x1 grid', () => {
        const plan = planAtlasPages(1500, 300, MAX);
        expect(plan.pagesX).toBe(3); // ceil(1500/512)
        expect(plan.pagesZ).toBe(1);
        checkPlanCoversMap(plan, 1500, 300);
    });
});
