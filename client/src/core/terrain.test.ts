import { describe, it, expect } from 'vitest';
import {
    planAtlasPages, extractKtx2Levels, compositeAtlasLevel,
    type AtlasPagePlan, type MapDimensions,
} from './terrain.js';

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

/**
 * Build a minimal KTX2 buffer matching the layout WrapRawDxt1AsKtx2
 * produces (--no-zstd, VK_FORMAT_BC1_RGB, one or more levels), with
 * synthetic level payloads so the parser's offsets/lengths can be checked
 * against known content.
 */
function buildSyntheticKtx2(levelPayloads: Uint8Array[]): ArrayBuffer {
    const lvlIdxBase = 80;
    const headerSize = lvlIdxBase + levelPayloads.length * 24;
    const totalLevelBytes = levelPayloads.reduce((s, p) => s + p.length, 0);
    const buf = new ArrayBuffer(headerSize + totalLevelBytes);
    const dv = new DataView(buf);
    const bytes = new Uint8Array(buf);

    const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb,
                   0x0d, 0x0a, 0x1a, 0x0a];
    magic.forEach((b, i) => dv.setUint8(i, b));
    dv.setUint32(40, levelPayloads.length, true); // levelCount
    dv.setUint32(44, 0, true);                    // supercompressionScheme = none

    let cursor = headerSize;
    levelPayloads.forEach((payload, lvl) => {
        const entryBase = lvlIdxBase + lvl * 24;
        dv.setBigUint64(entryBase + 0, BigInt(cursor), true);
        dv.setBigUint64(entryBase + 8, BigInt(payload.length), true);
        dv.setBigUint64(entryBase + 16, BigInt(payload.length), true);
        bytes.set(payload, cursor);
        cursor += payload.length;
    });
    return buf;
}

describe('extractKtx2Levels', () => {
    it('extracts a single level (pre-mip-chain-fix map packages)', () => {
        const level0 = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const levels = extractKtx2Levels(buildSyntheticKtx2([level0]));
        expect(levels).toHaveLength(1);
        expect(Array.from(levels[0])).toEqual(Array.from(level0));
    });

    it('extracts all 4 levels in order with correct byte ranges', () => {
        const level0 = new Uint8Array(512).fill(0);
        const level1 = new Uint8Array(128).fill(1);
        const level2 = new Uint8Array(32).fill(2);
        const level3 = new Uint8Array(8).fill(3);
        const levels = extractKtx2Levels(buildSyntheticKtx2([level0, level1, level2, level3]));
        expect(levels).toHaveLength(4);
        expect(levels[0].length).toBe(512);
        expect(levels[1].length).toBe(128);
        expect(levels[2].length).toBe(32);
        expect(levels[3].length).toBe(8);
        expect(levels[1].every((b) => b === 1)).toBe(true);
        expect(levels[3].every((b) => b === 3)).toBe(true);
    });

    it('rejects a non-KTX2 buffer', () => {
        expect(() => extractKtx2Levels(new ArrayBuffer(100))).toThrow('not a KTX2 file');
    });

    it('rejects a supercompressed file (mapconverter must emit --no-zstd)', () => {
        const buf = buildSyntheticKtx2([new Uint8Array(8)]);
        new DataView(buf).setUint32(44, 2, true); // pretend Zstd
        expect(() => extractKtx2Levels(buf)).toThrow(/supercompression/);
    });
});

describe('compositeAtlasLevel', () => {
    // 2x1 tiles, tile index maps (0,0)->tile 1, (1,0)->tile 0.
    const dims: MapDimensions = { mapx: 8, mapy: 4, minHeight: 0, maxHeight: 0, tilesX: 2, tilesZ: 1 };
    const tileIndex = new Int32Array([1, 0]);

    it('places each tile\'s blocks contiguously at the right atlas offset (mip0, 32x32)', () => {
        // tile bytes distinguishable per-tile: tile0 filled with 0xAA, tile1 with 0xBB.
        const tileBytes = 512;
        const levelData = new Uint8Array(tileBytes * 2);
        levelData.fill(0xaa, 0, tileBytes);
        levelData.fill(0xbb, tileBytes, tileBytes * 2);

        const { page, pageW, pageH, placed, skipped } = compositeAtlasLevel(
            dims, tileIndex, levelData, 32, tileBytes, 0, 0, 2, 1);

        expect(pageW).toBe(64);
        expect(pageH).toBe(32);
        expect(placed).toBe(2);
        expect(skipped).toBe(0);
        // Left half of the page (tile x=0, maps to tileIndex 1 -> 0xbb).
        expect(page[0]).toBe(0xbb);
        // Right half (tile x=1, maps to tileIndex 0 -> 0xaa) starts at block-row
        // byte offset (tileBlocks=8 blocks/row * 8 bytes/block = 64 bytes in).
        expect(page[64]).toBe(0xaa);
    });

    it('scales correctly to the 4x4-texel mip3 level (1 block, 8 bytes/tile)', () => {
        const tileBytes = 8;
        const levelData = new Uint8Array(tileBytes * 2);
        levelData.fill(0xaa, 0, tileBytes);
        levelData.fill(0xbb, tileBytes, tileBytes * 2);

        const { page, pageW, pageH, placed } = compositeAtlasLevel(
            dims, tileIndex, levelData, 4, tileBytes, 0, 0, 2, 1);

        expect(pageW).toBe(8);
        expect(pageH).toBe(4);
        expect(placed).toBe(2);
        expect(page.length).toBe(16); // 2 blocks * 8 bytes
        expect(page[0]).toBe(0xbb);
        expect(page[8]).toBe(0xaa);
    });

    it('skips tiles with a negative index and out-of-range offsets, zero-filling', () => {
        const emptyIndex = new Int32Array([-1, 0]);
        const levelData = new Uint8Array(512); // only 1 tile's worth of data
        const { page, placed, skipped } = compositeAtlasLevel(
            dims, emptyIndex, levelData, 32, 512, 0, 0, 2, 1);
        expect(placed).toBe(1);
        expect(skipped).toBe(1);
        // Skipped tile's blocks stay zero.
        expect(page.slice(0, 64).every((b) => b === 0)).toBe(true);
    });
});
