import { describe, it, expect } from 'vitest';
import {
    planPageGrid, pageKey, decodePageKey, keyOf, parentPage, ancestorsOf,
    pageWorldRect, pageSampleTransform, physicalUvOfPayload, pageAt,
    residentLayerBudget, isValidPage,
    PAGE_PAYLOAD_TEXELS, PAGE_BORDER_TEXELS, PAGE_PHYSICAL_TEXELS, PAGE_BYTES,
    DEFAULT_CACHE_BYTES,
} from './terrain-page-grid.js';

describe('page format', () => {
    it('keeps every stored dimension BC1-block aligned', () => {
        // compressedTexSubImage3D rejects a non-multiple-of-4 extent for S3TC,
        // so this is a hard requirement of the upload path, not a preference.
        expect(PAGE_PHYSICAL_TEXELS % 4).toBe(0);
        expect(PAGE_PAYLOAD_TEXELS % 4).toBe(0);
        expect(PAGE_BORDER_TEXELS % 4).toBe(0);
        expect(PAGE_PHYSICAL_TEXELS)
            .toBe(PAGE_PAYLOAD_TEXELS + 2 * PAGE_BORDER_TEXELS);
    });

    it('sizes a page at half a byte per texel (BC1)', () => {
        expect(PAGE_BYTES).toBe(PAGE_PHYSICAL_TEXELS * PAGE_PHYSICAL_TEXELS / 2);
    });

    it('fits the §1.2 ~96 MB budget in a plausible layer count', () => {
        const layers = residentLayerBudget(DEFAULT_CACHE_BYTES, 2048);
        expect(layers).toBeGreaterThan(500);
        expect(layers * PAGE_BYTES).toBeLessThanOrEqual(DEFAULT_CACHE_BYTES);
    });

    it('clamps to MAX_ARRAY_TEXTURE_LAYERS on a floor-spec device', () => {
        // WebGL2 guarantees only 256 layers; the cache is then a third the
        // size and the fallback chain carries more of the frame.
        expect(residentLayerBudget(DEFAULT_CACHE_BYTES, 256)).toBe(256);
        expect(residentLayerBudget(DEFAULT_CACHE_BYTES, 0)).toBe(1);
    });
});

describe('planPageGrid', () => {
    it('builds the pyramid for a 16 384-elmo map down to a 1x1 root', () => {
        const g = planPageGrid(16384, 16384);
        expect(g.levels.map((l) => l.pagesX)).toEqual([32, 16, 8, 4, 2, 1]);
        expect(g.rootLevel).toBe(5);
        expect(g.totalPages).toBe(32 * 32 + 16 * 16 + 8 * 8 + 4 * 4 + 2 * 2 + 1);
        expect(g.levels[0].texelElmos).toBe(1);
        expect(g.levels[5].pageElmos).toBe(512 * 32);
    });

    it('does not pretend a small map needs streaming', () => {
        const g = planPageGrid(512, 512);
        expect(g.rootLevel).toBe(0);
        expect(g.totalPages).toBe(1);
    });

    it('handles a non-square map and a degenerate one', () => {
        const g = planPageGrid(4096, 1024);
        expect(g.levels[0].pagesX).toBe(8);
        expect(g.levels[0].pagesZ).toBe(2);
        expect(g.levels[g.rootLevel].pagesX).toBe(1);
        expect(g.levels[g.rootLevel].pagesZ).toBe(1);
        expect(planPageGrid(0, -5).rootLevel).toBe(0);
    });

    it('honours texelsPerElmo', () => {
        const half = planPageGrid(16384, 16384, 0.5);
        expect(half.texelsX).toBe(8192);
        expect(half.elmosPerTexel).toBe(2);
        expect(half.levels[0].texelElmos).toBe(2);
        expect(half.rootLevel).toBe(4);
    });
});

describe('page keys', () => {
    it('round-trips every level/x/z through a single int', () => {
        for (const id of [
            { level: 0, x: 0, z: 0 }, { level: 5, x: 1, z: 2 },
            { level: 3, x: 16383, z: 16383 }, { level: 15, x: 7, z: 9 },
        ]) {
            expect(decodePageKey(keyOf(id))).toEqual(id);
        }
    });

    it('gives distinct keys to the same x/z at different levels', () => {
        expect(pageKey(0, 3, 4)).not.toBe(pageKey(1, 3, 4));
    });
});

describe('the fallback chain', () => {
    const g = planPageGrid(16384, 16384);

    it('walks a fine page up to the root and stops there', () => {
        const chain = ancestorsOf(g, { level: 0, x: 21, z: 13 });
        expect(chain).toEqual([
            { level: 1, x: 10, z: 6 }, { level: 2, x: 5, z: 3 },
            { level: 3, x: 2, z: 1 }, { level: 4, x: 1, z: 0 },
            { level: 5, x: 0, z: 0 },
        ]);
        expect(parentPage(g, { level: 5, x: 0, z: 0 })).toBeNull();
    });

    it('keeps every ancestor covering the same ground', () => {
        const fine = { level: 0, x: 21, z: 13 };
        const r = pageWorldRect(g, fine);
        for (const a of ancestorsOf(g, fine)) {
            const ar = pageWorldRect(g, a);
            expect(ar.x0).toBeLessThanOrEqual(r.x0);
            expect(ar.x1).toBeGreaterThanOrEqual(r.x1);
            expect(ar.z0).toBeLessThanOrEqual(r.z0);
            expect(ar.z1).toBeGreaterThanOrEqual(r.z1);
        }
    });

    it('validates addresses against the level grid', () => {
        expect(isValidPage(g, { level: 0, x: 31, z: 31 })).toBe(true);
        expect(isValidPage(g, { level: 0, x: 32, z: 0 })).toBe(false);
        expect(isValidPage(g, { level: 5, x: 1, z: 0 })).toBe(false);
        expect(isValidPage(g, { level: 6, x: 0, z: 0 })).toBe(false);
    });
});

describe('sample transform', () => {
    const g = planPageGrid(16384, 16384);

    /** What the shader computes: global map UV → payload UV in a page. */
    const payloadUv = (id: Parameters<typeof pageSampleTransform>[1],
                       u: number, v: number) => {
        const t = pageSampleTransform(g, id);
        return { u: u * t.scaleU - t.offU, v: v * t.scaleV - t.offV };
    };

    it('maps a page to the full 0..1 payload range', () => {
        const id = { level: 0, x: 5, z: 7 };
        const r = pageWorldRect(g, id);
        const a = payloadUv(id, r.x0 / g.mapElmosX, r.z0 / g.mapElmosZ);
        const b = payloadUv(id, r.x1 / g.mapElmosX, r.z1 / g.mapElmosZ);
        expect(a.u).toBeCloseTo(0, 6); expect(a.v).toBeCloseTo(0, 6);
        expect(b.u).toBeCloseTo(1, 6); expect(b.v).toBeCloseTo(1, 6);
    });

    it('lands a fine page inside its parent at the right quadrant', () => {
        // The parent-UV fallback: the same world point sampled through the
        // parent must sit in the sub-quadrant the child occupies.
        const child = { level: 0, x: 5, z: 7 };
        const parent = parentPage(g, child)!;
        const r = pageWorldRect(g, child);
        const midU = (r.x0 + r.x1) / 2 / g.mapElmosX;
        const midV = (r.z0 + r.z1) / 2 / g.mapElmosZ;
        const p = payloadUv(parent, midU, midV);
        // x=5 is the odd (right) half of parent x=2; z=7 the odd (lower) half.
        expect(p.u).toBeCloseTo(0.75, 6);
        expect(p.v).toBeCloseTo(0.75, 6);
    });

    it('insets the border so a payload edge tap never leaves the page', () => {
        expect(physicalUvOfPayload(0))
            .toBeCloseTo(PAGE_BORDER_TEXELS / PAGE_PHYSICAL_TEXELS, 9);
        expect(physicalUvOfPayload(1))
            .toBeCloseTo(1 - PAGE_BORDER_TEXELS / PAGE_PHYSICAL_TEXELS, 9);
        expect(physicalUvOfPayload(0.5)).toBeCloseTo(0.5, 9);
    });

    it('clips an edge page to the map but not its UV subdivision', () => {
        const g2 = planPageGrid(3000, 3000);   // 6x6 level-0 pages, last one short
        const edge = { level: 0, x: 5, z: 5 };
        const r = pageWorldRect(g2, edge);
        expect(r.x1).toBe(3000);
        // The transform stays a clean power-of-two subdivision regardless.
        const t = pageSampleTransform(g2, edge);
        expect(t.scaleU).toBeCloseTo(3000 / 512, 9);
    });
});

describe('pageAt', () => {
    const g = planPageGrid(16384, 16384);
    it('locates and clamps', () => {
        expect(pageAt(g, 0, 0, 0)).toEqual({ level: 0, x: 0, z: 0 });
        expect(pageAt(g, 0, 513, 1025)).toEqual({ level: 0, x: 1, z: 2 });
        expect(pageAt(g, 0, 999999, -50)).toEqual({ level: 0, x: 31, z: 0 });
        expect(pageAt(g, 99, 100, 100)).toEqual({ level: 5, x: 0, z: 0 });
    });
});
