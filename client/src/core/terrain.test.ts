import { describe, it, expect } from 'vitest';
import { NullEngine, Scene, VertexBuffer, StandardMaterial, Texture } from '@babylonjs/core';
import {
    planAtlasPages, extractKtx2Levels, compositeAtlasLevel,
    fogTierAlpha255, DEFAULT_FOG_DARKENING,
    planTerrainChunks, buildSurfaceGeometry, computeSurfaceNormals,
    buildTerrainMesh, DeformableTerrain, isTerrainMesh,
    attachTerrainSplatFromDecals, attachTerrainDetailPlainFromDecals,
    attachTerrainSplatNormalFromDecals, attachTerrainDetailFromDecals,
    applyWebGLTexture, applyGroundTexture, loadTerrainTextures,
    setTerrainDetailPluginEnabled, drainGlErrors,
    type AtlasPagePlan, type MapDimensions, type SurfaceGeometry,
} from './terrain.js';
import { TerrainSplatPlugin } from './terrain-splat-plugin.js';

const SQUARE_SIZE = 8;

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

describe('drainGlErrors', () => {
    /** Minimal stand-in: `getError` pops one queued code per call, then
     *  reports NO_ERROR, exactly as WebGL does. */
    const fakeGl = (queued: number[], stuck = false) => {
        const q = [...queued];
        return {
            NO_ERROR: 0,
            getError: () => (stuck ? 0x9242 : (q.shift() ?? 0)),
        } as unknown as WebGL2RenderingContext;
    };

    it('returns an empty list on a clean context', () => {
        expect(drainGlErrors(fakeGl([]))).toEqual([]);
    });

    it('drains every queued error and reports them in order', () => {
        const gl = fakeGl([0x501, 0x502]);
        expect(drainGlErrors(gl)).toEqual([0x501, 0x502]);
        // Queue is now empty, so a later check can only see new failures —
        // this is the whole point of the drain (pools_of_ilys read a 0x501
        // that predated the atlas upload).
        expect(drainGlErrors(gl)).toEqual([]);
    });

    it('gives up after `limit` on a lost context rather than spinning', () => {
        expect(drainGlErrors(fakeGl([], true), 4))
            .toEqual([0x9242, 0x9242, 0x9242, 0x9242]);
    });
});

describe('fogTierAlpha255 (FOW terrain darkening)', () => {
    const D = DEFAULT_FOG_DARKENING;

    it('in-LOS squares get no overlay (fully visible)', () => {
        // inLos wins regardless of the other bits.
        expect(fogTierAlpha255(true, true, true, D)).toBe(0);
        expect(fogTierAlpha255(true, false, false, D)).toBe(0);
    });

    it('radar-only is the lightest dim', () => {
        expect(fogTierAlpha255(false, true, true, D)).toBe(Math.round(D.radar * 255));
    });

    it('explored-but-not-radar is the medium dim', () => {
        expect(fogTierAlpha255(false, false, true, D)).toBe(Math.round(D.explored * 255));
    });

    it('unscouted is a strong dim but NEVER fully opaque (readable terrain)', () => {
        const a = fogTierAlpha255(false, false, false, D);
        expect(a).toBe(Math.round(D.unscouted * 255));
        // The whole point of the rework: unseen ground must stay recognisable.
        expect(a).toBeLessThan(255);
        // ...but still clearly darker than the visible tiers.
        expect(a).toBeGreaterThan(fogTierAlpha255(false, false, true, D));
    });

    it('darkening tiers are monotonic: visible < radar < explored < unscouted', () => {
        const vis = fogTierAlpha255(true, false, false, D);
        const rad = fogTierAlpha255(false, true, false, D);
        const exp = fogTierAlpha255(false, false, true, D);
        const uns = fogTierAlpha255(false, false, false, D);
        expect(vis).toBeLessThan(rad);
        expect(rad).toBeLessThan(exp);
        expect(exp).toBeLessThan(uns);
    });

    it('clamps out-of-range levels into [0,255]', () => {
        const bad = { radar: -1, explored: 5, unscouted: 2 };
        expect(fogTierAlpha255(false, true, false, bad)).toBe(0);
        expect(fogTierAlpha255(false, false, true, bad)).toBe(255);
        expect(fogTierAlpha255(false, false, false, bad)).toBe(255);
    });
});

// ---------------------------------------------------------------------------
// Chunked full-resolution terrain (PLAN-maps.md M4)
// ---------------------------------------------------------------------------

describe('planTerrainChunks', () => {
    it('keeps small maps (≤513² heightmaps) on the single-mesh, no-LOD path', () => {
        for (const hm of [129, 257, 513]) {
            const plan = planTerrainChunks(hm, hm);
            expect(plan.single).toBe(true);
            expect(plan.chunksX).toBe(1);
            expect(plan.chunksZ).toBe(1);
            expect(plan.lodStep).toBe(0); // no LOD level at all
        }
    });

    it('splits a 2049² heightmap (16384-elmo map) into 8x8 full-res chunks', () => {
        const plan = planTerrainChunks(2049, 2049);
        expect(plan.single).toBe(false);
        // 2048 quads / 8 chunks = 256 quads per chunk → 257² verts at step 1.
        expect(plan.chunkQuads).toBe(256);
        expect(plan.chunksX).toBe(8);
        expect(plan.chunksZ).toBe(8);
        // Draw-call guardrail (PLAN-maps.md §3): ≤ ~64 terrain draws.
        expect(plan.chunksX * plan.chunksZ).toBeLessThanOrEqual(64);
        expect(plan.lodStep).toBe(4);
        // The switch has to clear a chunk's own half-diagonal (Babylon measures
        // to the bounding-sphere centre) or the ground under the camera pops.
        const halfDiag = (plan.chunkQuads * SQUARE_SIZE * Math.SQRT2) / 2;
        expect(plan.lodDistance).toBeGreaterThan(halfDiag);
    });

    it('uses the 128-quad default when it already fits the chunk cap', () => {
        const plan = planTerrainChunks(1025, 1025);
        expect(plan.chunkQuads).toBe(128);
        expect(plan.chunksX).toBe(8);
        expect(plan.chunksZ).toBe(8);
    });

    it('handles non-square maps and a non-power-of-two remainder', () => {
        const plan = planTerrainChunks(2049, 1025);
        expect(plan.chunksX).toBe(8);
        expect(plan.chunksZ).toBe(4);   // 1024 quads / 256
        const p2 = planTerrainChunks(801, 801, { chunkQuads: 128 });
        expect(p2.chunksX).toBe(Math.ceil(800 / 128)); // 7 (last chunk short)
    });
});

/** Sampler standing in for a real heightmap: a deterministic ridge. */
const ridgeY = (sx: number, sz: number): number =>
    100 * Math.sin(sx * 0.01) + 50 * Math.cos(sz * 0.013);

function chunkGeo(x0: number, x1: number, z0: number, z1: number,
                  step: number, hm = 2049, skirt = true): SurfaceGeometry {
    return buildSurfaceGeometry({
        x0, z0, x1, z1, step, hmW: hm, hmH: hm, sampleY: ridgeY, skirt,
    });
}

describe('buildSurfaceGeometry (terrain chunk)', () => {
    it('is full-resolution at step 1 — one vertex per heightmap corner', () => {
        const geo = chunkGeo(256, 512, 0, 256, 1);
        expect(geo.gw).toBe(257);
        expect(geo.gh).toBe(257);
        expect(geo.gridVerts).toBe(257 * 257);
        for (let i = 0; i < geo.gw; i++) expect(geo.srcXs[i]).toBe(256 + i);
        // A step-1 chunk of a 2049² map is exactly one vertex per 8 elmos.
        expect(geo.positions[3] - geo.positions[0]).toBe(SQUARE_SIZE);
    });

    it('places vertices at world XZ = corner × SQUARE_SIZE with the sampled Y', () => {
        const geo = chunkGeo(256, 512, 128, 384, 1);
        const at = (ix: number, iz: number) => {
            const v = (iz * geo.gw + ix) * 3;
            return [geo.positions[v], geo.positions[v + 1], geo.positions[v + 2]];
        };
        // Float32 vertex buffer — compare with float32 tolerance.
        const near = (got: number[], want: number[]) =>
            got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 4));
        near(at(0, 0), [256 * SQUARE_SIZE, ridgeY(256, 128), 128 * SQUARE_SIZE]);
        near(at(geo.gw - 1, geo.gh - 1),
            [512 * SQUARE_SIZE, ridgeY(512, 384), 384 * SQUARE_SIZE]);
    });

    it('keeps UVs in GLOBAL 0..1 map space (atlas paging + splat depend on it)', () => {
        const geo = chunkGeo(256, 512, 512, 768, 1);
        const uvAt = (ix: number, iz: number) => {
            const v = (iz * geo.gw + ix) * 2;
            return [geo.uvs[v], geo.uvs[v + 1]];
        };
        expect(uvAt(0, 0)).toEqual([256 / 2048, 512 / 2048]);
        expect(uvAt(geo.gw - 1, geo.gh - 1)).toEqual([512 / 2048, 768 / 2048]);
        // Whole-map corner chunks anchor the 0..1 range exactly.
        const first = chunkGeo(0, 256, 0, 256, 1);
        expect(first.uvs[0]).toBe(0);
        const last = chunkGeo(1792, 2048, 1792, 2048, 1);
        const lastV = (last.gh * last.gw - 1) * 2;
        expect(last.uvs[lastV]).toBe(1);
        expect(last.uvs[lastV + 1]).toBe(1);
    });

    it('neighbouring chunks agree exactly on their shared border column', () => {
        const left = chunkGeo(0, 256, 0, 256, 1);
        const right = chunkGeo(256, 512, 0, 256, 1);
        for (let iz = 0; iz < left.gh; iz++) {
            const l = (iz * left.gw + (left.gw - 1)) * 3;   // left chunk's last column
            const r = (iz * right.gw) * 3;                  // right chunk's first column
            expect(left.positions[l]).toBe(right.positions[r]);
            expect(left.positions[l + 1]).toBe(right.positions[r + 1]);
            expect(left.positions[l + 2]).toBe(right.positions[r + 2]);
            const lu = (iz * left.gw + (left.gw - 1)) * 2, ru = (iz * right.gw) * 2;
            expect(left.uvs[lu]).toBe(right.uvs[ru]);
            expect(left.uvs[lu + 1]).toBe(right.uvs[ru + 1]);
        }
    });

    it('LOD1 (step 4) shares the chunk border vertices with LOD0', () => {
        const lod0 = chunkGeo(256, 512, 256, 512, 1);
        const lod1 = chunkGeo(256, 512, 256, 512, 4);
        expect(lod1.gw).toBe(65); // 256 quads / 4 + 1
        expect(lod1.srcXs[0]).toBe(lod0.srcXs[0]);
        expect(lod1.srcXs[lod1.gw - 1]).toBe(lod0.srcXs[lod0.gw - 1]);
        expect(lod1.positions[1]).toBe(lod0.positions[1]); // same corner height
    });

    it('includes the final corner when the span is not a multiple of the step', () => {
        // Last chunk of an 801-corner map: 800 - 768 = 32 quads, step 4 divides
        // it; step 3 (pathological) must still land the last vertex on 800.
        const geo = buildSurfaceGeometry({
            x0: 768, z0: 0, x1: 800, z1: 32, step: 3,
            hmW: 801, hmH: 801, sampleY: ridgeY, skirt: false,
        });
        expect(geo.srcXs[geo.gw - 1]).toBe(800);
        expect(geo.srcZs[geo.gh - 1]).toBe(32);
    });

    it('adds a downward border skirt that inherits the edge UVs', () => {
        const geo = chunkGeo(256, 512, 256, 512, 1);
        expect(geo.skirtSrc.length).toBe(2 * geo.gw + 2 * geo.gh);
        expect(geo.skirtDepth).toBeGreaterThan(0);
        expect(geo.positions.length / 3).toBe(geo.gridVerts + geo.skirtSrc.length);
        for (let k = 0; k < geo.skirtSrc.length; k++) {
            const d = geo.gridVerts + k, s = geo.skirtSrc[k];
            expect(geo.positions[d * 3]).toBe(geo.positions[s * 3]);         // same X
            expect(geo.positions[d * 3 + 2]).toBe(geo.positions[s * 3 + 2]); // same Z
            expect(geo.positions[d * 3 + 1])
                .toBeCloseTo(geo.positions[s * 3 + 1] - geo.skirtDepth, 3);  // hangs down
            expect(geo.uvs[d * 2]).toBe(geo.uvs[s * 2]);
            expect(geo.uvs[d * 2 + 1]).toBe(geo.uvs[s * 2 + 1]);
        }
        // Skirt-free surfaces (the single-mesh small-map path) have none.
        const noSkirt = chunkGeo(0, 128, 0, 128, 1, 2049, false);
        expect(noSkirt.skirtSrc.length).toBe(0);
        expect(noSkirt.positions.length / 3).toBe(noSkirt.gridVerts);
    });

    it('indices stay 16-bit while a chunk fits, and cover grid + skirt quads', () => {
        const geo = chunkGeo(0, 128, 0, 128, 1);           // 129² + skirt < 65535
        expect(geo.indices).toBeInstanceOf(Uint16Array);
        const gridQuads = (geo.gw - 1) * (geo.gh - 1);
        const skirtQuads = 2 * (geo.gw - 1) + 2 * (geo.gh - 1);
        expect(geo.indices.length).toBe((gridQuads + skirtQuads) * 6);
        // Plain-JS scan, asserted once — 100k+ expect() calls is too slow.
        const numVerts = geo.positions.length / 3;
        let maxIdx = -1;
        for (const i of geo.indices) if (i > maxIdx) maxIdx = i;
        expect(maxIdx).toBeLessThan(numVerts);
        expect(maxIdx).toBeGreaterThanOrEqual(geo.gridVerts); // skirt is indexed
    });
});

describe('computeSurfaceNormals', () => {
    it('produces up-facing unit normals, flat ground → +Y', () => {
        const flat = buildSurfaceGeometry({
            x0: 0, z0: 0, x1: 16, z1: 16, step: 1, hmW: 17, hmH: 17,
            sampleY: () => 42, skirt: true,
        });
        const n = computeSurfaceNormals(flat, () => 42, 17, 17);
        for (let v = 0; v < n.length / 3; v++) {
            expect(n[v * 3 + 1]).toBeCloseTo(1, 6);
            expect(Math.hypot(n[v * 3], n[v * 3 + 1], n[v * 3 + 2])).toBeCloseTo(1, 6);
        }
    });

    it('is continuous across a chunk border (both chunks see the same slope)', () => {
        const left = chunkGeo(0, 128, 0, 128, 1);
        const right = chunkGeo(128, 256, 0, 128, 1);
        const nl = computeSurfaceNormals(left, ridgeY, 2049, 2049);
        const nr = computeSurfaceNormals(right, ridgeY, 2049, 2049);
        for (let iz = 0; iz < left.gh; iz++) {
            const l = (iz * left.gw + (left.gw - 1)) * 3;
            const r = (iz * right.gw) * 3;
            for (let c = 0; c < 3; c++) expect(nl[l + c]).toBeCloseTo(nr[r + c], 6);
        }
    });

    it('slopes tilt the normal away from the uphill direction', () => {
        // Height rising with X → normal leans towards -X.
        const geo = buildSurfaceGeometry({
            x0: 0, z0: 0, x1: 8, z1: 8, step: 1, hmW: 9, hmH: 9,
            sampleY: (sx) => sx * SQUARE_SIZE, skirt: false,
        });
        const n = computeSurfaceNormals(geo, (sx) => sx * SQUARE_SIZE, 9, 9);
        const mid = (4 * geo.gw + 4) * 3;
        expect(n[mid]).toBeCloseTo(-Math.SQRT1_2, 5); // 45° slope
        expect(n[mid + 1]).toBeCloseTo(Math.SQRT1_2, 5);
    });
});

/** A small but chunked map: 641² corners → 5×5 chunks of 128 quads. */
function makeChunkedTerrain() {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const mapx = 640, mapy = 640;
    const dims: MapDimensions = {
        mapx, mapy, minHeight: 0, maxHeight: 655.35, tilesX: 160, tilesZ: 160,
    };
    const hmW = mapx + 1;
    const heights = new Uint16Array(hmW * (mapy + 1));
    for (let z = 0; z <= mapy; z++) {
        for (let x = 0; x <= mapx; x++) heights[z * hmW + x] = (x * 37 + z * 11) % 65535;
    }
    // Force chunking (the plan's small-map cutoff is 513²; 641² is above it).
    const group = buildTerrainMesh(scene, dims, heights, { chunkQuads: 128 });
    const worldY = (sx: number, sz: number) =>
        (heights[sz * hmW + sx] / 65535) * (dims.maxHeight - dims.minHeight);
    return { scene, dims, group, heights, hmW, worldY };
}

describe('buildTerrainMesh (chunk grid)', () => {
    it('builds one shared-material chunk mesh per grid cell, each with a LOD1', () => {
        const { group } = makeChunkedTerrain();
        expect(group.plan.chunksX).toBe(5);
        expect(group.plan.chunksZ).toBe(5);
        expect(group.chunks).toHaveLength(25);
        expect(group.meshes).toHaveLength(25);

        const mat = group.material;
        expect(mat).toBeTruthy();
        // Shared material instance: plugins bind per material, so one attach
        // must cover the whole terrain.
        for (const m of group.allMeshes) expect(m.material).toBe(mat);
        expect(group.materials).toEqual([mat]);

        for (const c of group.chunks) {
            expect(c.lod0.step).toBe(1);
            expect(c.lod1).not.toBeNull();
            expect(c.lod1!.step).toBe(4);
            expect(c.lod0.mesh.getLODLevels()).toHaveLength(1);
            expect(c.lod0.mesh.getLODLevels()[0].mesh).toBe(c.lod1!.mesh);
            expect(c.lod1!.mesh.isPickable).toBe(false);
            // LOD0 has ~16x the vertices of LOD1 (step 4 in both axes).
            expect(c.lod0.geo.gridVerts).toBe(129 * 129);
            expect(c.lod1!.geo.gridVerts).toBe(33 * 33);
        }
    });

    it('shares one index buffer between same-shaped chunks', () => {
        const { group } = makeChunkedTerrain();
        // 5x5 chunks of 128 quads over 640 quads: every chunk is full size, so
        // all 25 LOD0 surfaces (and all 25 LOD1 surfaces) share topology.
        const idx0 = group.chunks[0].lod0.geo.indices;
        const idx1 = group.chunks[0].lod1!.geo.indices;
        for (const c of group.chunks) {
            expect(c.lod0.geo.indices).toBe(idx0);
            expect(c.lod1!.geo.indices).toBe(idx1);
        }
        expect(idx0).not.toBe(idx1); // different grid shapes → different buffers
    });

    it('only the LOD0 chunk meshes answer the terrain pick predicate', () => {
        const { group } = makeChunkedTerrain();
        for (const c of group.chunks) {
            expect(isTerrainMesh(c.lod0.mesh)).toBe(true);
            expect(isTerrainMesh(c.lod1!.mesh)).toBe(false);
        }
        expect(isTerrainMesh({ name: 'terrain' })).toBe(true);   // single-mesh path
        expect(isTerrainMesh({ name: 'terrainFog' })).toBe(false);
        expect(isTerrainMesh({ name: 'water' })).toBe(false);
    });

    it('gives every chunk its own bounding box (per-chunk frustum culling)', () => {
        const { group } = makeChunkedTerrain();
        for (const c of group.chunks) {
            const bb = c.lod0.mesh.getBoundingInfo().boundingBox;
            expect(bb.minimum.x).toBeCloseTo(c.x0 * SQUARE_SIZE, 3);
            expect(bb.maximum.x).toBeCloseTo(c.x1 * SQUARE_SIZE, 3);
            expect(bb.minimum.z).toBeCloseTo(c.z0 * SQUARE_SIZE, 3);
            expect(bb.maximum.z).toBeCloseTo(c.z1 * SQUARE_SIZE, 3);
        }
    });

    it('samples the heightmap at full resolution, chunk-boundary corners included', () => {
        const { group, worldY } = makeChunkedTerrain();
        for (const [sx, sz] of [[0, 0], [1, 1], [127, 3], [128, 128], [129, 128],
                                [255, 256], [640, 640], [317, 512]]) {
            expect(group.heightAt(sx, sz)).toBeCloseTo(worldY(sx, sz), 3);
        }
    });

    it('keeps small maps on one un-LODded mesh named "terrain"', () => {
        const engine = new NullEngine();
        const scene = new Scene(engine);
        const dims: MapDimensions = {
            mapx: 512, mapy: 512, minHeight: 0, maxHeight: 100, tilesX: 128, tilesZ: 128,
        };
        const group = buildTerrainMesh(scene, dims, new Uint16Array(513 * 513));
        expect(group.plan.single).toBe(true);
        expect(group.chunks).toHaveLength(1);
        expect(group.meshes[0].name).toBe('terrain');
        expect(group.meshes[0].getLODLevels()).toHaveLength(0);
        expect(group.chunks[0].lod0.geo.skirtSrc.length).toBe(0);
        // Full resolution, as the old ≤512-step-1 path already was.
        expect(group.chunks[0].lod0.geo.gw).toBe(513);
    });
});

describe('DeformableTerrain (per-chunk patches)', () => {
    it('applies a patch straddling a chunk border to both chunks and both LODs', () => {
        const { group } = makeChunkedTerrain();
        const deform = new DeformableTerrain(group);
        const x1 = 124, x2 = 132, z1 = 8, z2 = 12;
        const pw = x2 - x1 + 1;
        const heights = new Float32Array(pw * (z2 - z1 + 1)).fill(500);
        deform.applyPatch({ x1, z1, x2, z2, heights });
        expect(deform.appliedPatches).toBe(1);

        // Border column 128 is owned by chunk (0,0) and chunk (1,0) — both
        // vertex buffers must carry the new height or a crack opens.
        expect(group.heightAt(128, 10)).toBe(500);
        const left = group.chunks[0], right = group.chunks[1];
        expect(left.x1).toBe(128);
        expect(right.x0).toBe(128);
        const lg = left.lod0.geo, rg = right.lod0.geo;
        expect(lg.positions[((10 - left.z0) * lg.gw + (128 - left.x0)) * 3 + 1]).toBe(500);
        expect(rg.positions[((10 - right.z0) * rg.gw + (128 - right.x0)) * 3 + 1]).toBe(500);

        // LOD1 samples every 4th corner: (128, 8) and (128, 12) are on its grid.
        const r1 = right.lod1!.geo;
        expect(r1.positions[((12 - right.z0) / 4 * r1.gw + 0) * 3 + 1]).toBe(500);

        // Normals were recomputed over the patch (flat top → +Y up).
        const vi = (10 - right.z0) * rg.gw + (130 - right.x0);
        expect(right.lod0.normals[vi * 3 + 1]).toBeCloseTo(1, 6);

        // Skirts follow the deformed edge so the LOD seam stays covered.
        for (let k = 0; k < rg.skirtSrc.length; k++) {
            const d = rg.gridVerts + k, s = rg.skirtSrc[k];
            expect(rg.positions[d * 3 + 1])
                .toBeCloseTo(rg.positions[s * 3 + 1] - rg.skirtDepth, 3);
        }
    });

    it('uploads only the touched chunks and leaves the rest alone', () => {
        const { group } = makeChunkedTerrain();
        const deform = new DeformableTerrain(group);
        const before = group.chunks.map((c) => {
            const p = c.lod0.mesh.getVerticesData(VertexBuffer.PositionKind)!;
            return Array.from(p.slice(0, 12));
        });
        const heights = new Float32Array(9).fill(300);
        deform.applyPatch({ x1: 300, z1: 300, x2: 302, z2: 302, heights });

        expect(group.heightAt(301, 301)).toBe(300);
        // Chunk (0,0) is nowhere near the patch — untouched.
        const after0 = group.chunks[0].lod0.mesh
            .getVerticesData(VertexBuffer.PositionKind)!;
        expect(Array.from(after0.slice(0, 12))).toEqual(before[0]);
    });

    it('ignores patches that fall outside the heightmap', () => {
        const { group } = makeChunkedTerrain();
        const deform = new DeformableTerrain(group);
        deform.applyPatch({
            x1: 900, z1: 900, x2: 902, z2: 902, heights: new Float32Array(9).fill(7),
        });
        expect(deform.appliedPatches).toBe(0);
    });
});

// PLAN-terrain-detailtex.md §2.1/§2.3: a map declares the splat pair or the
// plain `detailTex`, never both — the shader has one `#ifdef`/`#ifndef` pair,
// so the client must pick with the same precedence. The guard that enforces it
// is "one detail plugin per material": whichever attaches first wins.
describe('terrain near-field detail attach', () => {
    const BASE = 'http://localhost:1/api/maps/m/data';
    const pluginOf = (mat: unknown): TerrainSplatPlugin | undefined =>
        ((mat as { pluginManager?: { _plugins?: unknown[] } }).pluginManager?._plugins
            ?.find((p): p is TerrainSplatPlugin => p instanceof TerrainSplatPlugin));

    it('attaches plain mode from decals.detailTex, resolved against the map URL', () => {
        const { scene, group } = makeChunkedTerrain();
        expect(attachTerrainDetailPlainFromDecals(
            scene, group, { detailTex: 'detail.ktx2' }, BASE)).toBe(true);
        for (const mat of group.materials) {
            const p = pluginOf(mat);
            expect(p?.mode).toBe('plain');
            expect(p?.isEnabled).toBe(true);
            expect(p?.plainDetailTexture?.name).toBe(`${BASE}/detail.ktx2`);
        }
    });

    it('is a no-op for a map that ships no detailTex', () => {
        const { scene, group } = makeChunkedTerrain();
        expect(attachTerrainDetailPlainFromDecals(
            scene, group, { detailTex: '' }, BASE)).toBe(false);
        expect(pluginOf(group.materials[0])).toBeUndefined();
    });

    it('leaves an absolute detail URL alone', () => {
        const { scene, group } = makeChunkedTerrain();
        attachTerrainDetailPlainFromDecals(
            scene, group, { detailTex: 'https://cdn/x/detail.ktx2' }, BASE);
        expect(pluginOf(group.materials[0])?.plainDetailTexture?.name)
            .toBe('https://cdn/x/detail.ktx2');
    });

    it('gives the splat pair precedence over the plain path', () => {
        const { scene, group, dims } = makeChunkedTerrain();
        expect(attachTerrainSplatFromDecals(scene, group, {
            splatDistrTex: 'splat_distr.ktx2', splatDetailTex: 'splat_detail.ktx2',
            splatScales: [0.02, 0.02, 0.02, 0.02], splatMults: [1, 1, 1, 1],
        }, BASE, dims)).toBe(true);
        // A map declaring both must not end up double-adding signed detail.
        expect(attachTerrainDetailPlainFromDecals(
            scene, group, { detailTex: 'detail.ktx2' }, BASE)).toBe(false);
        for (const mat of group.materials) {
            expect(pluginOf(mat)?.mode).toBe('splat');
        }
    });

    // --- endtoend D48: the third branch, and the precedence that hid it ---

    // scorched_crossing_v2.4's actual resources block: all three forms
    // declared at once. Recoil resolves that to the splat-NORMAL branch and
    // never samples splatDetailTex — whose alpha on that map is a constant
    // 1.0, i.e. a flat +0.93 on the ground albedo if it ever is sampled.
    const SCORCHED = {
        detailTex: 'detail.ktx2',
        splatDetailTex: 'splat_detail.ktx2',
        splatDistrTex: 'splat_distr.ktx2',
        splatNormal: ['splat_normal_0.ktx2', 'splat_normal_1.ktx2',
            'splat_normal_2.ktx2', 'splat_normal_3.ktx2'] as
            [string, string, string, string],
        splatScales: [0.018, 0.005, 0.02, 0.02] as [number, number, number, number],
        splatMults: [1, 1, 1, 1] as [number, number, number, number],
        splatDetailNormalDiffuseAlpha: true,
    };

    it('gives the splat-normal branch precedence over BOTH other paths', () => {
        const { scene, group, dims } = makeChunkedTerrain();
        expect(attachTerrainDetailFromDecals(scene, group, SCORCHED, BASE, dims))
            .toBe('splatNormal');
        for (const mat of group.materials) {
            const p = pluginOf(mat);
            expect(p?.mode).toBe('splatNormal');
            expect(p?.diffuseAlpha).toBe(true);
            // The texture that whitewashed the map must not be loaded at all.
            expect(p?.detailTexture).toBeNull();
            expect(p?.plainDetailTexture).toBeNull();
            expect(p?.normalTextures.map(t => t?.name)).toEqual([
                `${BASE}/splat_normal_0.ktx2`, `${BASE}/splat_normal_1.ktx2`,
                `${BASE}/splat_normal_2.ktx2`, `${BASE}/splat_normal_3.ktx2`]);
        }
        // ...and nothing may attach a second branch on top.
        expect(attachTerrainSplatFromDecals(scene, group, SCORCHED, BASE, dims))
            .toBe(false);
        expect(attachTerrainDetailPlainFromDecals(scene, group, SCORCHED, BASE))
            .toBe(false);
    });

    it('falls through to splat, then plain, as the normal set empties', () => {
        const noNormals = {
            ...SCORCHED,
            splatNormal: ['', '', '', ''] as [string, string, string, string],
        };
        {
            const { scene, group, dims } = makeChunkedTerrain();
            expect(attachTerrainDetailFromDecals(scene, group, noNormals, BASE, dims))
                .toBe('splat');
        }
        {
            const { scene, group, dims } = makeChunkedTerrain();
            expect(attachTerrainDetailFromDecals(scene, group,
                { ...noNormals, splatDetailTex: '' }, BASE, dims)).toBe('plain');
        }
        {
            const { scene, group, dims } = makeChunkedTerrain();
            expect(attachTerrainDetailFromDecals(scene, group,
                { ...noNormals, splatDetailTex: '', detailTex: '' }, BASE, dims))
                .toBeNull();
        }
    });

    it('takes the splat-normal branch on a single declared normal channel', () => {
        const { scene, group, dims } = makeChunkedTerrain();
        const oneNormal = {
            ...SCORCHED,
            splatNormal: ['', 'splat_normal_1.ktx2', '', ''] as
                [string, string, string, string],
        };
        expect(attachTerrainDetailFromDecals(scene, group, oneNormal, BASE, dims))
            .toBe('splatNormal');
        // Absent channels get a neutral mid-grey stand-in, which the shader's
        // `tex * 2 - 1` turns into exactly zero contribution.
        const p = pluginOf(group.materials[0])!;
        expect(p.normalTextures[1]?.name).toBe(`${BASE}/splat_normal_1.ktx2`);
        for (const i of [0, 2, 3]) expect(p.normalTextures[i]).not.toBeNull();
        expect(p.normalTextures[0]).toBe(p.normalTextures[2]);
    });

    it('needs a distribution map before any splat branch can run', () => {
        const { scene, group, dims } = makeChunkedTerrain();
        expect(attachTerrainSplatNormalFromDecals(
            scene, group, { ...SCORCHED, splatDistrTex: '' }, BASE, dims))
            .toBe(false);
        expect(attachTerrainDetailFromDecals(
            scene, group, { ...SCORCHED, splatDistrTex: '' }, BASE, dims))
            .toBe('plain');
    });

    it('carries splatNormal mode across a material swap', () => {
        const { scene, group, dims } = makeChunkedTerrain();
        attachTerrainDetailFromDecals(scene, group, SCORCHED, BASE, dims);
        const before = pluginOf(group.materials[0])!;
        // The atlas load swaps in a fresh terrainTexMat later; the reattach
        // must carry the mode, or the map comes back on the wrong branch.
        applyWebGLTexture(scene, group, {} as WebGLTexture, 64, 64, 1);
        const after = pluginOf(group.materials[0])!;
        expect(after).not.toBe(before);
        expect(after.mode).toBe('splatNormal');
        expect(after.diffuseAlpha).toBe(true);
        expect(after.normalTextures.map(t => t?.name))
            .toEqual(before.normalTextures.map(t => t?.name));
    });

    it('toggles either mode through the A/B hook', () => {
        const { scene, group } = makeChunkedTerrain();
        expect(setTerrainDetailPluginEnabled(group, false)).toBe(false);
        attachTerrainDetailPlainFromDecals(
            scene, group, { detailTex: 'detail.ktx2' }, BASE);
        expect(setTerrainDetailPluginEnabled(group, false)).toBe(true);
        expect(pluginOf(group.materials[0])?.isEnabled).toBe(false);
        expect(setTerrainDetailPluginEnabled(group, true)).toBe(true);
        expect(pluginOf(group.materials[0])?.isEnabled).toBe(true);
    });
});

// PLAN-maps.md §2n ruling 1 (M7f option A): a map may deliver its whole ground
// albedo as ONE map-space texture instead of the SMT tile dictionary. The
// dictionary's 32-elmo seam grid is the defect this removes; the client half
// is a preference, and the thing that would silently undo it is the atlas path
// running anyway (on a map whose `tiles.ktx2` the server never wrote).
describe('map-space ground texture (PLAN-maps §2n)', () => {
    const GROUND = '/api/maps/data/skerry_reach/ground.ktx2';
    const BASE = 'http://localhost:1/api/maps/m/data';
    const pluginOf = (mat: unknown): TerrainSplatPlugin | undefined =>
        ((mat as { pluginManager?: { _plugins?: unknown[] } }).pluginManager?._plugins
            ?.find((p): p is TerrainSplatPlugin => p instanceof TerrainSplatPlugin));
    const SCORCHED = {
        detailTex: 'detail.ktx2',
        splatDetailTex: 'splat_detail.ktx2',
        splatDistrTex: 'splat_distr.ktx2',
        splatNormal: ['splat_normal_0.ktx2', 'splat_normal_1.ktx2',
            'splat_normal_2.ktx2', 'splat_normal_3.ktx2'] as
            [string, string, string, string],
        splatScales: [0.018, 0.005, 0.02, 0.02] as [number, number, number, number],
        splatMults: [1, 1, 1, 1] as [number, number, number, number],
        splatDetailNormalDiffuseAlpha: true,
    };

    it('textures the terrain from the map-space albedo', () => {
        const { scene, group } = makeChunkedTerrain();
        applyGroundTexture(scene, group, GROUND);
        const mat = group.materials[0] as StandardMaterial;
        expect(mat.diffuseTexture?.name).toBe(GROUND);
        // it IS the map: a bilinear tap at the edge must not wrap around
        expect(mat.diffuseTexture!.wrapU).toBe(Texture.CLAMP_ADDRESSMODE);
        expect(mat.diffuseTexture!.wrapV).toBe(Texture.CLAMP_ADDRESSMODE);
        expect(mat.diffuseTexture!.anisotropicFilteringLevel).toBe(8);
    });

    it('carries the near-field detail plugin across the swap, like the atlas does', () => {
        const { scene, group, dims } = makeChunkedTerrain();
        attachTerrainDetailFromDecals(scene, group, SCORCHED, BASE, dims);
        const before = pluginOf(group.materials[0])!;
        applyGroundTexture(scene, group, GROUND);
        const after = pluginOf(group.materials[0])!;
        expect(after).not.toBe(before);
        expect(after.mode).toBe('splatNormal');
    });

    it('takes the ground texture INSTEAD of the tile atlas, never both', async () => {
        const { scene, group, dims } = makeChunkedTerrain();
        // NullEngine has no WebGL context, so the atlas path bails at
        // getEngineGl() and leaves the material untextured. Reaching the
        // ground texture at all therefore proves the short-circuit — and the
        // fetch that path would make (tiles.ktx2 does not exist for such a
        // map) is never issued.
        const fetches: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = ((u: string) => {
            fetches.push(String(u));
            return Promise.reject(new Error('404'));
        }) as typeof fetch;
        try {
            await loadTerrainTextures(scene, group, BASE, dims, GROUND);
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(fetches).toEqual([]);
        expect((group.materials[0] as StandardMaterial).diffuseTexture?.name)
            .toBe(GROUND);
    });

    it('falls back to the atlas when the map ships no ground texture', async () => {
        const { scene, group, dims } = makeChunkedTerrain();
        const before = group.materials[0];
        await loadTerrainTextures(scene, group, BASE, dims, '');
        // no WebGL context under NullEngine: the atlas path bails, so the
        // material is untouched — what matters is that it did NOT take the
        // ground-texture branch with an empty URL.
        expect(group.materials[0]).toBe(before);
        expect((group.materials[0] as StandardMaterial).diffuseTexture?.name)
            .not.toBe(GROUND);
    });
});
