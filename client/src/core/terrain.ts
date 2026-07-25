/**
 * Terrain — heightmap mesh + DXT1 tile texture compositing.
 *
 * Builds a terrain mesh from uint16 heightmap data and textures it
 * by compositing 32x32 DXT1 tiles into larger WebGL textures using
 * compressedTexSubImage2D. No intermediate format conversion — raw
 * DXT1 bytes go straight from the server to the GPU.
 *
 * Spring coordinate system: X = east, Y = up, Z = south.
 * Each map square is SQUARE_SIZE (8) elmos wide.
 * Each tile covers 4x4 map squares = 32x32 texels.
 */

import {
    Engine,
    Scene,
    Mesh,
    SubMesh,
    MultiMaterial,
    VertexData,
    StandardMaterial,
    Texture,
    Color3,
    Vector3,
    VertexBuffer,
} from '@babylonjs/core';
import { getEngineGl } from './engine-gl.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { LosBitmap } from './los-bitmap.js';
import { DecalOverlayPlugin, attachDecalOverlay } from './decal-overlay-plugin.js';
import { WaterAbsorptionPlugin, attachWaterAbsorption } from './water-absorption-plugin.js';
import type { MapWaterAbsorption } from './map-lighting.js';

const SQUARE_SIZE = 8;
const TILE_PIXELS = 32;
const TILE_DXT1_SIZE = 512; // (32/4)*(32/4)*8 bytes per tile mip0
const SQUARES_PER_TILE = 4; // each tile covers 4x4 squares

// DXT1 block size
const DXT1_BLOCK_BYTES = 8;

// Per-tile mip chain: 32x32 mip0, 16x16 mip1, 8x8 mip2, 4x4 mip3 texels —
// matches the SMT tile record layout mapconverter reads (rts/Server/
// MapProcessor.cpp TILE_MIP_SIZE). WebGL2 cannot runtime-generate mipmaps
// for a compressed-format texture (gl.generateMipmap() only supports
// uncompressed formats), so all shipped levels get uploaded explicitly.
const TILE_MIP_TEXELS = [32, 16, 8, 4];
const TILE_MIP_BYTES = [512, 128, 32, 8];

export interface MapDimensions {
    mapx: number;
    mapy: number;
    minHeight: number;
    maxHeight: number;
    tilesX: number;
    tilesZ: number;
}

/**
 * Build a terrain mesh from uint16 heightmap data.
 * Heights are scaled from uint16 (0-65535) to world units using min/max height.
 */
export function buildTerrainMesh(
    scene: Scene,
    dims: MapDimensions,
    heightData: Uint16Array,
): Mesh {
    const hmW = dims.mapx + 1; // vertices = squares + 1
    const hmH = dims.mapy + 1;

    // Subsample for performance (target ~512 vertices per axis max)
    const MAX_VERTS = 512;
    const stepX = Math.max(1, Math.floor(hmW / MAX_VERTS));
    const stepZ = Math.max(1, Math.floor(hmH / MAX_VERTS));
    const gridW = Math.floor((hmW - 1) / stepX) + 1;
    const gridH = Math.floor((hmH - 1) / stepZ) + 1;

    const numVerts = gridW * gridH;
    const positions = new Float32Array(numVerts * 3);
    const normals = new Float32Array(numVerts * 3);
    const uvs = new Float32Array(numVerts * 2);

    const hRange = dims.maxHeight - dims.minHeight;

    for (let gz = 0; gz < gridH; gz++) {
        const srcZ = Math.min(gz * stepZ, hmH - 1);
        for (let gx = 0; gx < gridW; gx++) {
            const srcX = Math.min(gx * stepX, hmW - 1);
            const idx = gz * gridW + gx;

            const raw = heightData[srcZ * hmW + srcX];
            const worldY = dims.minHeight + (raw / 65535) * hRange;

            positions[idx * 3 + 0] = srcX * SQUARE_SIZE;
            positions[idx * 3 + 1] = worldY;
            positions[idx * 3 + 2] = srcZ * SQUARE_SIZE;

            // UV maps to full map extent (0..1)
            uvs[idx * 2 + 0] = gx / (gridW - 1);
            uvs[idx * 2 + 1] = gz / (gridH - 1);
        }
    }

    // Triangle indices. PLAN-coordinate-system Phase 2d switched the
    // scene to RH (`useRightHandedSystem = true`) so CCW-from-camera is
    // now the front face. Per-quad winding is tl→bl→tr / tr→bl→br;
    // that matches Babylon's default backface rule for terrain viewed
    // from above. The `terrainTexMat` material has backface culling off
    // anyway, but keeping the winding aligned avoids hidden ordering
    // bugs if culling is ever turned on.
    const numQuads = (gridW - 1) * (gridH - 1);
    const indices = new Uint32Array(numQuads * 6);
    let ti = 0;
    for (let gz = 0; gz < gridH - 1; gz++) {
        for (let gx = 0; gx < gridW - 1; gx++) {
            const tl = gz * gridW + gx;
            const tr = tl + 1;
            const bl = (gz + 1) * gridW + gx;
            const br = bl + 1;
            indices[ti++] = tl; indices[ti++] = bl; indices[ti++] = tr;
            indices[ti++] = tr; indices[ti++] = bl; indices[ti++] = br;
        }
    }

    // Babylon's VertexData.ComputeNormals uses (p2-p0) × (p1-p0) — the
    // opposite of standard (p1-p0) × (p2-p0) — so feeding the indices
    // above produces -Y face normals. Negate every component so terrain
    // light contributions (HemisphericLight up-vector, DirectionalLight
    // sun) hit the upward-facing side. Without this, hemispheric ambient
    // grounds out near (0.21, 0.175, 0.14) (the groundColor term) and
    // the sun's N·L collapses to ~0; map renders nearly black.
    VertexData.ComputeNormals(positions, indices, normals);
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];

    const mesh = new Mesh('terrain', scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.uvs = uvs;
    // `updatable = true` keeps the position + normal buffers CPU-backed so
    // DeformableTerrain (PLAN-deformable-terrain T3) can rewrite affected
    // vertices in place on each heightmap patch without recreating the mesh.
    vd.applyToMesh(mesh, true);

    // Default material (replaced when textures load)
    const mat = new StandardMaterial('terrainMat', scene);
    mat.diffuseColor = new Color3(0.3, 0.35, 0.2);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    mat.backFaceCulling = false;
    mesh.material = mat;

    console.log(`[terrain] mesh: ${gridW}x${gridH} vertices (step ${stepX})`);
    return mesh;
}

/**
 * DeformableTerrain — applies live server heightmap patches (envelope 0x09,
 * PLAN-deformable-terrain T3) to the terrain mesh built by `buildTerrainMesh`.
 *
 * The mesh is subsampled to ≤512 vertices per axis (see `buildTerrainMesh`):
 * grid vertex (gx, gz) samples corner-heightmap cell (gx·stepX, gz·stepZ).
 * A patch arrives in corner coordinates [x1..x2]×[z1..z2] with actual world-Y
 * heights. For each grid vertex whose sampled corner falls inside the patch
 * rect, we rewrite its Y, then recompute vertex normals over the affected
 * region plus a one-vertex skirt using central differences over the
 * heightfield (exact for a regular grid; matches the +Y-up orientation
 * `buildTerrainMesh` produces by negating ComputeNormals output), and push
 * just the position + normal buffers back to the GPU.
 *
 * **Subsample limitation (documented):** on large maps stepX/stepZ > 1, so a
 * patch narrower than one grid step may contain no sampled corner and produce
 * no visible change. This is the same subsampling the static mesh already
 * accepts; full-resolution maps (the common test maps) deform exactly. A
 * CDLOD / per-corner mesh is the v2 upgrade (PLAN-deformable-terrain T3 note).
 */
export class DeformableTerrain {
    private positions: Float32Array;
    private normals: Float32Array;
    private readonly gridW: number;
    private readonly gridH: number;
    private readonly stepX: number;
    private readonly stepZ: number;
    private readonly hmW: number; // corner heightmap width  = mapx + 1
    private readonly hmH: number; // corner heightmap height = mapy + 1
    private patchCount = 0;

    constructor(private mesh: Mesh, dims: MapDimensions) {
        this.hmW = dims.mapx + 1;
        this.hmH = dims.mapy + 1;
        const MAX_VERTS = 512;
        this.stepX = Math.max(1, Math.floor(this.hmW / MAX_VERTS));
        this.stepZ = Math.max(1, Math.floor(this.hmH / MAX_VERTS));
        this.gridW = Math.floor((this.hmW - 1) / this.stepX) + 1;
        this.gridH = Math.floor((this.hmH - 1) / this.stepZ) + 1;

        const pos = mesh.getVerticesData(VertexBuffer.PositionKind);
        const nrm = mesh.getVerticesData(VertexBuffer.NormalKind);
        if (!pos || !nrm) {
            throw new Error('[terrain] DeformableTerrain: mesh has no position/normal data');
        }
        // getVerticesData may return a plain number[] depending on Babylon's
        // backing store; normalise to Float32Array we own and write through.
        this.positions = pos instanceof Float32Array ? pos : new Float32Array(pos);
        this.normals = nrm instanceof Float32Array ? nrm : new Float32Array(nrm);
    }

    /** Apply one heightmap patch (corner coords, actual world-Y heights). */
    applyPatch(p: { x1: number; z1: number; x2: number; z2: number; heights: Float32Array }): void {
        const { x1, z1, x2, z2, heights } = p;
        const pw = x2 - x1 + 1;

        // Grid-vertex range whose sampled corner can fall inside the rect.
        let gx0 = Math.ceil(x1 / this.stepX);
        let gx1 = Math.floor(x2 / this.stepX);
        let gz0 = Math.ceil(z1 / this.stepZ);
        let gz1 = Math.floor(z2 / this.stepZ);
        // Clamp to the last grid vertex (which clamps its source to hmW/H-1).
        gx0 = Math.max(0, gx0); gx1 = Math.min(this.gridW - 1, gx1);
        gz0 = Math.max(0, gz0); gz1 = Math.min(this.gridH - 1, gz1);
        if (gx0 > gx1 || gz0 > gz1) return; // patch fell between grid samples

        for (let gz = gz0; gz <= gz1; gz++) {
            const srcZ = Math.min(gz * this.stepZ, this.hmH - 1);
            if (srcZ < z1 || srcZ > z2) continue;
            for (let gx = gx0; gx <= gx1; gx++) {
                const srcX = Math.min(gx * this.stepX, this.hmW - 1);
                if (srcX < x1 || srcX > x2) continue;
                const worldY = heights[(srcZ - z1) * pw + (srcX - x1)];
                this.positions[(gz * this.gridW + gx) * 3 + 1] = worldY;
            }
        }

        // Recompute normals over the affected grid region + a 1-vertex skirt so
        // the seam to undisturbed terrain stays smooth.
        const nx0 = Math.max(0, gx0 - 1), nx1 = Math.min(this.gridW - 1, gx1 + 1);
        const nz0 = Math.max(0, gz0 - 1), nz1 = Math.min(this.gridH - 1, gz1 + 1);
        for (let gz = nz0; gz <= nz1; gz++) {
            for (let gx = nx0; gx <= nx1; gx++) {
                this.recomputeNormal(gx, gz);
            }
        }

        this.mesh.updateVerticesData(VertexBuffer.PositionKind, this.positions, true);
        this.mesh.updateVerticesData(VertexBuffer.NormalKind, this.normals, false);
        this.patchCount++;
    }

    /** Number of patches applied so far (debug / verification handle). */
    get appliedPatches(): number { return this.patchCount; }

    /** Central-difference heightfield normal at grid vertex (gx, gz). The
     *  world spacing between grid samples is stepX·SQUARE_SIZE (X) and
     *  stepZ·SQUARE_SIZE (Z); forward/backward difference at the borders. */
    private recomputeNormal(gx: number, gz: number): void {
        const W = this.gridW, H = this.gridH;
        const yAt = (x: number, z: number) => this.positions[(z * W + x) * 3 + 1];

        const xm = gx > 0 ? gx - 1 : gx;
        const xp = gx < W - 1 ? gx + 1 : gx;
        const zm = gz > 0 ? gz - 1 : gz;
        const zp = gz < H - 1 ? gz + 1 : gz;

        const dx = (xp - xm) * this.stepX * SQUARE_SIZE;
        const dz = (zp - zm) * this.stepZ * SQUARE_SIZE;
        const dHdx = dx > 0 ? (yAt(xp, gz) - yAt(xm, gz)) / dx : 0;
        const dHdz = dz > 0 ? (yAt(gx, zp) - yAt(gx, zm)) / dz : 0;

        // Up-facing heightfield normal: normalize(-dHdx, 1, -dHdz).
        let nx = -dHdx, ny = 1, nz = -dHdz;
        const inv = 1 / Math.hypot(nx, ny, nz);
        nx *= inv; ny *= inv; nz *= inv;

        const o = (gz * W + gx) * 3;
        this.normals[o] = nx; this.normals[o + 1] = ny; this.normals[o + 2] = nz;
    }
}

/**
 * Pull the raw DXT1 block stream for every mip level out of a `tiles.ktx2`
 * file, level 0 (largest) first.
 *
 * `tiles.ktx2` is produced by mapconverter via `textureconverter
 * --raw-dxt1 ... --mip-levels N --no-zstd`, so it's a KTX2 wrapper around
 * N uncompressed BC1_RGB levels (N=1 for older map packages built before
 * the mip-chain fix — those are handled by the caller falling back to
 * single-level, unfiltered sampling).
 *
 * KTX2 layout we walk:
 *   bytes  0..11   identifier
 *   bytes 12..15   vkFormat
 *   bytes 16..19   typeSize
 *   bytes 20..23   pixelWidth
 *   bytes 24..27   pixelHeight
 *   bytes 28..31   pixelDepth
 *   bytes 32..35   layerCount
 *   bytes 36..39   faceCount
 *   bytes 40..43   levelCount
 *   bytes 44..47   supercompressionScheme
 *   bytes 48..79   index entries (DFD/KVD/SGD offsets+lengths)
 *   bytes 80..     levelIndex[levelCount]: each is 24 bytes
 *                  (uint64 byteOffset, uint64 byteLength,
 *                   uint64 uncompressedByteLength)
 */
export function extractKtx2Levels(buf: ArrayBuffer): Uint8Array[] {
    const dv = new DataView(buf);
    // Magic bytes: «KTX 20»\r\n\x1a\n
    const magic = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb,
                   0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < magic.length; i++) {
        if (dv.getUint8(i) !== magic[i]) {
            throw new Error('not a KTX2 file');
        }
    }
    const levelCount = dv.getUint32(40, true);
    const supercompression = dv.getUint32(44, true);
    if (supercompression !== 0) {
        throw new Error(
            `tiles.ktx2 has supercompression=${supercompression}; ` +
            `mapconverter must emit it with --no-zstd`,
        );
    }
    // levelIndex starts at offset 80 — the 4 trailing index pointers
    // (DFD/KVD offset+length pairs, then the SGD offset+length uint64s)
    // occupy bytes 48..79 for every file this tool produces (no DFD/KVD/
    // SGD blocks of interest).
    const lvlIdxBase = 80;
    const levels: Uint8Array[] = [];
    for (let lvl = 0; lvl < levelCount; lvl++) {
        const entryBase = lvlIdxBase + lvl * 24;
        const byteOffset = Number(dv.getBigUint64(entryBase + 0, true));
        const byteLength = Number(dv.getBigUint64(entryBase + 8, true));
        levels.push(new Uint8Array(buf, byteOffset, byteLength));
    }
    return levels;
}

/**
 * Cached tile data so multiple consumers (terrain, minimap) don't
 * refetch the same bytes.
 */
const tileDataCache = new Map<string, Promise<{
    tileIndex: Int32Array;
    tilesLevels: Uint8Array[];
}>>();

async function fetchTileData(mapBaseUrl: string): Promise<{
    tileIndex: Int32Array;
    tilesLevels: Uint8Array[];
}> {
    let entry = tileDataCache.get(mapBaseUrl);
    if (!entry) {
        entry = (async () => {
            const [tileIndexResp, tilesResp] = await Promise.all([
                fetch(`${mapBaseUrl}/tileindex.bin`),
                fetch(`${mapBaseUrl}/tiles.ktx2`),
            ]);
            if (!tileIndexResp.ok || !tilesResp.ok) {
                throw new Error('failed to fetch tile data');
            }
            const tileIndex = new Int32Array(await tileIndexResp.arrayBuffer());
            const tilesLevels = extractKtx2Levels(await tilesResp.arrayBuffer());
            console.log(`[terrain] tile index: ${tileIndex.length} entries, ` +
                `tiles: ${tilesLevels[0].length} bytes mip0 ` +
                `(${tilesLevels[0].length / TILE_DXT1_SIZE} tiles), ` +
                `${tilesLevels.length} mip level(s)`);
            return { tileIndex, tilesLevels };
        })();
        tileDataCache.set(mapBaseUrl, entry);
    }
    return entry;
}

/**
 * Atlas texture covering a tile sub-rectangle of the map, built from DXT1
 * tiles. For maps that fit within MAX_TEXTURE_SIZE this is the whole map
 * (one page); larger maps are split into a grid of pages (see
 * `buildMapAtlasPages`) so no single texture exceeds the WebGL2 cap.
 */
export interface MapAtlasTexture {
    webglTex: WebGLTexture;
    width: number;
    height: number;
    /** Tile-space origin of this page within the full map. */
    tileX0: number;
    tileZ0: number;
    /** Tile-space extent of this page. */
    tileCountX: number;
    tileCountZ: number;
    /** Mip levels uploaded to `webglTex` (1 for pre-mip-chain-fix map packages). */
    mipLevels: number;
}

/** A paged DXT1 atlas: a `pagesX × pagesZ` grid of `MapAtlasTexture` pages. */
interface MapAtlasPages {
    pages: MapAtlasTexture[];
    pagesX: number;
    pagesZ: number;
    pageTilesX: number;
    pageTilesZ: number;
}

/** Tile-space rectangle of one atlas page within the full map. */
export interface AtlasPageRect {
    tileX0: number;
    tileZ0: number;
    tileCountX: number;
    tileCountZ: number;
}

/** The page grid + per-page tile rectangles for a map of `tilesX × tilesZ`. */
export interface AtlasPagePlan {
    pagesX: number;
    pagesZ: number;
    pageTilesX: number;
    pageTilesZ: number;
    rects: AtlasPageRect[];
}

/**
 * Plan the smallest `pagesX × pagesZ` grid of atlas pages whose pages each fit
 * within `maxTex` pixels. Pure (no GL) so the split + UV math is unit-tested.
 *
 * The common case (`tilesX*32 ≤ maxTex`) returns a single full-map page.
 */
export function planAtlasPages(
    tilesX: number, tilesZ: number, maxTex: number,
): AtlasPagePlan {
    const maxPageTiles = Math.max(1, Math.floor(maxTex / TILE_PIXELS));
    const pagesX = Math.max(1, Math.ceil(tilesX / maxPageTiles));
    const pagesZ = Math.max(1, Math.ceil(tilesZ / maxPageTiles));
    // Balance the split evenly across pages (avoid one full + one sliver).
    const pageTilesX = Math.ceil(tilesX / pagesX);
    const pageTilesZ = Math.ceil(tilesZ / pagesZ);

    const rects: AtlasPageRect[] = [];
    for (let pz = 0; pz < pagesZ; pz++) {
        for (let px = 0; px < pagesX; px++) {
            const tileX0 = px * pageTilesX;
            const tileZ0 = pz * pageTilesZ;
            rects.push({
                tileX0, tileZ0,
                tileCountX: Math.min(pageTilesX, tilesX - tileX0),
                tileCountZ: Math.min(pageTilesZ, tilesZ - tileZ0),
            });
        }
    }
    return { pagesX, pagesZ, pageTilesX, pageTilesZ, rects };
}

/**
 * Build one DXT1 atlas page covering tiles
 * `[tileX0, tileX0+tileCountX) × [tileZ0, tileZ0+tileCountZ)`.
 *
 * Each Spring tile is 32×32 px, so the page is `tileCountX*32 × tileCountZ*32`.
 */
/**
 * Composite one mip level's worth of tiles into a page-sized DXT1 buffer.
 * Same block-copy approach as level 0: each tile's block-rows land
 * contiguously in the destination, so placing a tile is `tileBlocks` row
 * copies (down to a single 8-byte copy at the 4x4 mip3 level).
 */
export function compositeAtlasLevel(
    dims: MapDimensions,
    tileIndex: Int32Array,
    levelData: Uint8Array,
    tileTexels: number, tileBytes: number,
    tileX0: number, tileZ0: number,
    tileCountX: number, tileCountZ: number,
): { page: Uint8Array; pageW: number; pageH: number; placed: number; skipped: number } {
    const pageW = tileCountX * tileTexels;
    const pageH = tileCountZ * tileTexels;
    const atlasBlocksPerRow = pageW / 4;
    const tileBlocks = tileTexels / 4;
    const tileRowBytes = tileBlocks * DXT1_BLOCK_BYTES;
    const pageDxt1Size = atlasBlocksPerRow * (pageH / 4) * DXT1_BLOCK_BYTES;
    const page = new Uint8Array(pageDxt1Size); // zero-filled = blank blocks

    let placed = 0, skipped = 0;
    for (let tz = 0; tz < tileCountZ; tz++) {
        const blockZ = tz * tileBlocks;
        for (let tx = 0; tx < tileCountX; tx++) {
            const tileIdx = tileIndex[(tileZ0 + tz) * dims.tilesX + (tileX0 + tx)];
            if (tileIdx < 0) { skipped++; continue; }

            const tileOffset = tileIdx * tileBytes;
            if (tileOffset + tileBytes > levelData.length) { skipped++; continue; }

            const blockX = tx * tileBlocks;
            for (let r = 0; r < tileBlocks; r++) {
                const srcOff = tileOffset + r * tileRowBytes;
                const dstOff = ((blockZ + r) * atlasBlocksPerRow + blockX) * DXT1_BLOCK_BYTES;
                page.set(levelData.subarray(srcOff, srcOff + tileRowBytes), dstOff);
            }
            placed++;
        }
    }
    return { page, pageW, pageH, placed, skipped };
}

function buildAtlasPage(
    gl: WebGL2RenderingContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ext: any,
    dims: MapDimensions,
    tileIndex: Int32Array,
    tilesLevels: Uint8Array[],
    tileX0: number, tileZ0: number,
    tileCountX: number, tileCountZ: number,
): MapAtlasTexture {
    const pageW = tileCountX * TILE_PIXELS;
    const pageH = tileCountZ * TILE_PIXELS;

    const atlasTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);

    // Upload every mip level the KTX2 shipped (level 0 always; levels 1-3
    // only present for map packages rebuilt after the mip-chain fix — see
    // rts/Server/MapProcessor.cpp). Each level is composited from that
    // level's own per-tile blocks (precomputed independently by Spring's
    // SMT format), NOT by downsampling the level-0 atlas as one image —
    // that would bleed unrelated adjacent tiles into each other.
    const numLevels = Math.min(tilesLevels.length, TILE_MIP_TEXELS.length);
    let placed = 0, skipped = 0;
    for (let lvl = 0; lvl < numLevels; lvl++) {
        const r = compositeAtlasLevel(
            dims, tileIndex, tilesLevels[lvl],
            TILE_MIP_TEXELS[lvl], TILE_MIP_BYTES[lvl],
            tileX0, tileZ0, tileCountX, tileCountZ);
        gl.compressedTexImage2D(
            gl.TEXTURE_2D, lvl, ext.COMPRESSED_RGB_S3TC_DXT1_EXT,
            r.pageW, r.pageH, 0, r.page);
        if (lvl === 0) { placed = r.placed; skipped = r.skipped; }
    }

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, numLevels - 1);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
        numLevels > 1 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const glErr = gl.getError();
    if (glErr !== gl.NO_ERROR) {
        console.warn(`[terrain] gl error after page upload: 0x${glErr.toString(16)}`);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);

    console.log(`[terrain] page @(${tileX0},${tileZ0}) ${pageW}x${pageH}, ` +
        `${numLevels} mip level(s): ${placed} tiles placed, ${skipped} skipped`);
    return {
        webglTex: atlasTex, width: pageW, height: pageH,
        tileX0, tileZ0, tileCountX, tileCountZ, mipLevels: numLevels,
    };
}

/**
 * Build the DXT1 atlas as a grid of pages, each ≤ MAX_TEXTURE_SIZE.
 *
 * Spring maps are typically 896×896 squares → 224×224 tiles → 7168×7168 px,
 * one page well under the 16384 cap. Larger maps (e.g. a 544×544-tile map →
 * 17408 px) exceed the WebGL2 `MAX_TEXTURE_SIZE`, so they are split into the
 * smallest `pagesX × pagesZ` grid whose pages each fit. The terrain mesh is
 * then drawn as a MultiMaterial, one sub-material per page (see
 * `applyPagedTextures`).
 */
async function buildMapAtlasPages(
    gl: WebGL2RenderingContext,
    mapBaseUrl: string,
    dims: MapDimensions,
): Promise<MapAtlasPages | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ext = gl.getExtension('WEBGL_compressed_texture_s3tc') as any;
    if (!ext) { console.warn('[terrain] S3TC not supported'); return null; }

    const { tileIndex, tilesLevels } = await fetchTileData(mapBaseUrl);

    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const plan = planAtlasPages(dims.tilesX, dims.tilesZ, maxTex);

    if (plan.pagesX > 1 || plan.pagesZ > 1) {
        console.log(`[terrain] map ${dims.tilesX * TILE_PIXELS}x${dims.tilesZ * TILE_PIXELS} ` +
            `exceeds MAX_TEXTURE_SIZE ${maxTex}; paging into ${plan.pagesX}x${plan.pagesZ} ` +
            `(${plan.pageTilesX * TILE_PIXELS}px tiles/page)`);
    } else {
        console.log(`[terrain] building atlas: ${dims.tilesX * TILE_PIXELS}x` +
            `${dims.tilesZ * TILE_PIXELS} (${dims.tilesX}x${dims.tilesZ} tiles)`);
    }

    const pages: MapAtlasTexture[] = plan.rects.map((r) => buildAtlasPage(
        gl, ext, dims, tileIndex, tilesLevels,
        r.tileX0, r.tileZ0, r.tileCountX, r.tileCountZ));

    return {
        pages,
        pagesX: plan.pagesX, pagesZ: plan.pagesZ,
        pageTilesX: plan.pageTilesX, pageTilesZ: plan.pageTilesZ,
    };
}

/**
 * Composite DXT1 tiles into per-page atlas textures and apply to terrain.
 * One page for the common case; a MultiMaterial grid for over-cap maps.
 */
export async function loadTerrainTextures(
    scene: Scene,
    terrainMesh: Mesh,
    mapBaseUrl: string,
    dims: MapDimensions,
): Promise<void> {
    let gl: WebGL2RenderingContext;
    try { gl = getEngineGl(scene.getEngine() as Engine); } catch { console.warn('[terrain] no WebGL context'); return; }

    const atlas = await buildMapAtlasPages(gl, mapBaseUrl, dims);
    if (!atlas) return;

    if (atlas.pages.length === 1) {
        const p = atlas.pages[0];
        applyWebGLTexture(scene, terrainMesh, p.webglTex, p.width, p.height, p.mipLevels);
    } else {
        applyPagedTextures(scene, terrainMesh, atlas, dims);
    }
}

/**
 * Wrap a raw WebGL texture in a Babylon.js material and apply to mesh.
 * Uses Engine.wrapWebGLTexture() — the supported path for adopting an
 * externally-created GL texture into Babylon's material system.
 */
export function applyWebGLTexture(
    scene: Scene, mesh: Mesh,
    webglTex: WebGLTexture, width: number, height: number,
    mipLevels = 1,
): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = scene.getEngine() as any;
    // hasMipMaps=true + TRILINEAR routes Babylon's updateTextureSamplingMode
    // to LINEAR_MIPMAP_LINEAR (matching the MIN_FILTER buildAtlasPage already
    // set on the raw GL texture) instead of clobbering it back to plain
    // LINEAR — wrapWebGLTexture always re-applies TEXTURE_MIN_FILTER from
    // (samplingMode, hasMipMaps), it doesn't just trust what's already bound.
    const hasMips = mipLevels > 1;
    const internalTex = engine.wrapWebGLTexture(
        webglTex, hasMips, hasMips ? 3 /* trilinear */ : 2 /* bilinear */,
        width, height);

    const texture = new Texture(null, scene);
    texture._texture = internalTex;

    // Remove vertex colours if present (they'd multiply with the sampled
    // diffuse colour and darken the terrain)
    if (mesh.isVerticesDataPresent(VertexBuffer.ColorKind)) {
        mesh.removeVerticesData(VertexBuffer.ColorKind);
    }
    mesh.hasVertexAlpha = false;

    const mat = new StandardMaterial('terrainTexMat', scene);
    mat.diffuseTexture = texture;
    mat.diffuseColor = new Color3(1, 1, 1);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    mat.backFaceCulling = false;

    // Carry the ground-decal overlay (PLAN-decals.md) onto the new material.
    // The overlay plugin is attached to the *initial* terrain material in
    // main.ts; this textured material is built later (once the map atlas
    // finishes loading) and swapped in here. Without re-attaching, the
    // textured terrain samples no overlay and scars/tracks never render.
    const prevPlugin = findDecalOverlayPlugin(mesh.material);
    const prevWater = findWaterAbsorptionPlugin(mesh.material);
    mesh.material = mat;
    reattachDecalOverlay(mat, prevPlugin);
    reattachWaterAbsorption(mat, prevWater);
}

/** Locate the DecalOverlayPlugin attached to a material, if any. */
function findDecalOverlayPlugin(
    mat: Mesh['material'],
): DecalOverlayPlugin | undefined {
    return mat && mat.pluginManager
        ? (mat.pluginManager as unknown as { _plugins?: unknown[] })._plugins
            ?.find((p): p is DecalOverlayPlugin => p instanceof DecalOverlayPlugin)
        : undefined;
}

/** Enable/disable the terrain decal-overlay shader plugin on a terrain mesh —
 *  the PLAN-perf P0 hazard-#1 isolation toggle (the ~10-tap per-fragment decal
 *  block). Returns whether a plugin was found + toggled. */
export function setTerrainDecalPluginEnabled(
    mesh: Mesh | null, on: boolean,
): boolean {
    const plugin = mesh ? findDecalOverlayPlugin(mesh.material) : undefined;
    if (!plugin) return false;
    plugin.isEnabled = on;
    return true;
}

/** Re-attach the ground-decal overlay (preserving live-tuned strengths). */
function reattachDecalOverlay(
    mat: StandardMaterial, prevPlugin: DecalOverlayPlugin | undefined,
): void {
    if (prevPlugin && prevPlugin.coarseTexture && prevPlugin.fineTexture && prevPlugin.fineState) {
        const next = attachDecalOverlay(
            mat, prevPlugin.coarseTexture, prevPlugin.fineTexture, prevPlugin.fineState,
            prevPlugin.coarseTexel, prevPlugin.fineTexel,
            prevPlugin.worldW, prevPlugin.worldH);
        next.normalScale = prevPlugin.normalScale;
        next.darken = prevPlugin.darken;
        next.detailScale = prevPlugin.detailScale;
        next.rubbleScale = prevPlugin.rubbleScale;
    }
}

/** Locate the WaterAbsorptionPlugin on a material (first sub-material for a
 *  MultiMaterial — all pages carry identical colours). */
function findWaterAbsorptionPlugin(
    mat: Mesh['material'],
): WaterAbsorptionPlugin | undefined {
    if (mat instanceof MultiMaterial) mat = mat.subMaterials.find(m => !!m) ?? null;
    return mat && mat.pluginManager
        ? (mat.pluginManager as unknown as { _plugins?: unknown[] })._plugins
            ?.find((p): p is WaterAbsorptionPlugin => p instanceof WaterAbsorptionPlugin)
        : undefined;
}

/** Re-attach the underwater-absorption tint (carrying the map's colours). */
function reattachWaterAbsorption(
    mat: StandardMaterial, prevPlugin: WaterAbsorptionPlugin | undefined,
): void {
    if (prevPlugin) {
        attachWaterAbsorption(mat, {
            absorb: prevPlugin.absorb,
            baseColor: prevPlugin.baseColor,
            minColor: prevPlugin.minColor,
        });
    }
}

/** Attach the underwater terrain-absorption tint (Recoil SMF
 *  `SMF_WATER_ABSORPTION`) to a terrain mesh's material(s) — handles both the
 *  single-material and paged MultiMaterial forms, and survives later material
 *  swaps via the reattach calls in applyTexture / applyPagedTextures. No-op if
 *  already attached (idempotent for the async mapinfo-parse → attach path). */
export function attachTerrainWaterAbsorption(
    mesh: Mesh, colors: MapWaterAbsorption,
): void {
    const mats = mesh.material instanceof MultiMaterial
        ? mesh.material.subMaterials
        : [mesh.material];
    for (const m of mats) {
        if (m instanceof StandardMaterial && !findWaterAbsorptionPlugin(m)) {
            attachWaterAbsorption(m, colors);
        }
    }
}

/**
 * Apply a paged DXT1 atlas (over-cap maps) as a MultiMaterial on a single
 * terrain mesh. The mesh keeps its global 0..1 UVs; each page sub-material
 * remaps that range onto its texture via Texture `uScale/uOffset` and the
 * mesh triangles are regrouped into one SubMesh per page.
 *
 * Keeping a single mesh + StandardMaterial-per-page means lighting, CSM
 * shadows, the decal overlay, picking and DeformableTerrain all keep working
 * unchanged — only the draw is split by texture page.
 */
function applyPagedTextures(
    scene: Scene, mesh: Mesh, atlas: MapAtlasPages, dims: MapDimensions,
): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = scene.getEngine() as any;

    if (mesh.isVerticesDataPresent(VertexBuffer.ColorKind)) {
        mesh.removeVerticesData(VertexBuffer.ColorKind);
    }
    mesh.hasVertexAlpha = false;

    const prevPlugin = findDecalOverlayPlugin(mesh.material);
    const prevWater = findWaterAbsorptionPlugin(mesh.material);

    // Regroup triangles by which page their UV centroid falls in, so each
    // page becomes a contiguous SubMesh index range.
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind)!;
    const numVerts = uvs.length / 2;
    const oldIdx = mesh.getIndices()!;
    const numPages = atlas.pagesX * atlas.pagesZ;
    const buckets: number[][] = Array.from({ length: numPages }, () => []);
    const pageOf = (cu: number, cv: number): number => {
        let px = Math.floor((cu * dims.tilesX) / atlas.pageTilesX);
        let pz = Math.floor((cv * dims.tilesZ) / atlas.pageTilesZ);
        px = Math.min(Math.max(px, 0), atlas.pagesX - 1);
        pz = Math.min(Math.max(pz, 0), atlas.pagesZ - 1);
        return pz * atlas.pagesX + px;
    };
    for (let t = 0; t < oldIdx.length; t += 3) {
        const a = oldIdx[t], b = oldIdx[t + 1], c = oldIdx[t + 2];
        const cu = (uvs[a * 2] + uvs[b * 2] + uvs[c * 2]) / 3;
        const cv = (uvs[a * 2 + 1] + uvs[b * 2 + 1] + uvs[c * 2 + 1]) / 3;
        buckets[pageOf(cu, cv)].push(a, b, c);
    }

    const newIdx = new Uint32Array(oldIdx.length);
    const ranges: { page: number; start: number; count: number }[] = [];
    let cursor = 0;
    for (let p = 0; p < numPages; p++) {
        const b = buckets[p];
        if (b.length > 0) ranges.push({ page: p, start: cursor, count: b.length });
        newIdx.set(b, cursor);
        cursor += b.length;
    }
    mesh.setIndices(newIdx, numVerts);

    // One StandardMaterial per page, remapping global UV onto the page.
    const multi = new MultiMaterial('terrainMulti', scene);
    for (let p = 0; p < numPages; p++) {
        const page = atlas.pages[p];
        const hasMips = page.mipLevels > 1;
        const internalTex = engine.wrapWebGLTexture(
            page.webglTex, hasMips, hasMips ? 3 /* trilinear */ : 2 /* bilinear */,
            page.width, page.height);
        const texture = new Texture(null, scene);
        texture._texture = internalTex;
        // Global UV u maps to page coord u*uScale + uOffset, landing in [0,1]
        // across exactly this page's tile span (CLAMP so the boundary row,
        // drawn by the neighbouring page, samples the edge, not the next page).
        texture.uScale = dims.tilesX / page.tileCountX;
        texture.vScale = dims.tilesZ / page.tileCountZ;
        texture.uOffset = -page.tileX0 / page.tileCountX;
        texture.vOffset = -page.tileZ0 / page.tileCountZ;
        texture.wrapU = Texture.CLAMP_ADDRESSMODE;
        texture.wrapV = Texture.CLAMP_ADDRESSMODE;

        const mat = new StandardMaterial(`terrainTexMat_${p}`, scene);
        mat.diffuseTexture = texture;
        mat.diffuseColor = new Color3(1, 1, 1);
        mat.specularColor = new Color3(0.05, 0.05, 0.05);
        mat.backFaceCulling = false;
        reattachDecalOverlay(mat, prevPlugin);
        reattachWaterAbsorption(mat, prevWater);
        multi.subMaterials[p] = mat;
    }
    mesh.material = multi;

    // Replace the default full-mesh submesh with one per non-empty page.
    mesh.subMeshes = [];
    for (const r of ranges) {
        new SubMesh(r.page, 0, numVerts, r.start, r.count, mesh);
    }
    console.log(`[terrain] applied ${ranges.length} page submesh(es) ` +
        `(${atlas.pagesX}x${atlas.pagesZ} grid)`);
}

/**
 * Load heightmap from HTTP (raw uint16 binary with 8-byte header).
 * This is the game server's /api/map/heightmap format.
 */
export async function fetchHeightmap(url: string): Promise<{
    width: number; height: number; data: Uint16Array;
    minH: number; maxH: number;
} | null> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const buf = await resp.arrayBuffer();
        const view = new DataView(buf);
        const width = view.getUint32(0, true);
        const height = view.getUint32(4, true);
        // The game server sends float32 heights; for raw uint16 from processed data,
        // we need the min/max from map info to scale.
        // Check if this is the game server format (float32) or processed format (uint16)
        if (buf.byteLength === 8 + width * height * 4) {
            // Float32 format from game server
            const floats = new Float32Array(buf, 8, width * height);
            // Convert to uint16 for the mesh builder
            let minH = Infinity, maxH = -Infinity;
            for (let i = 0; i < floats.length; i++) {
                if (floats[i] < minH) minH = floats[i];
                if (floats[i] > maxH) maxH = floats[i];
            }
            const range = maxH - minH || 1;
            const uint16 = new Uint16Array(floats.length);
            for (let i = 0; i < floats.length; i++) {
                uint16[i] = Math.round(((floats[i] - minH) / range) * 65535);
            }
            return { width, height, data: uint16, minH, maxH };
        }
        // Raw uint16 format from processed map data (no header)
        const uint16 = new Uint16Array(buf);
        return { width: 0, height: 0, data: uint16, minH: 0, maxH: 0 };
    } catch {
        return null;
    }
}

/**
 * Fog-of-war overlay for the main 3D view.
 *
 * Re-uses the terrain's heightmap to build a mesh that hugs the surface
 * a few elmos above it, then paints it with a tiny RGBA dynamic texture
 * (≤64×64) sampled from the per-allyteam LOS bitmap stream (envelope
 * 0x07, ~1 Hz). The three-plane fog tint (PLAN-intel.md Phase 5) is a
 * *darkening* of the (static, client-side) terrain — never a full black-
 * out, so unseen ground stays recognisable while units/features stay
 * hidden (their visibility is filtered server-side and unaffected here):
 *
 *   inLos                → no overlay             (0%)
 *   inRadar && !inLos    → light dim   (DARKEN.radar,     ~30%)
 *   explored & !inRadar  → medium dim  (DARKEN.explored,  ~50%)
 *   !explored            → strong dim  (DARKEN.unscouted, ~72%)
 *
 * The unscouted tier is deliberately < 100%: pure black hides the map
 * shape and reads as a rendering bug (see metalstorm-demo-verify lane
 * notes, 2026-07-25). Levels are live-tunable via
 * `window.__gp('__fowDarkening.set({unscouted:0.8})')` — see
 * docs/lighting.md. Before the first LOS bitmap arrives the overlay
 * falls back to a uniform DARKEN.unscouted dim (material alpha), so a
 * not-yet-scouted / pre-frame-0 map is dark-but-readable, not opaque.
 *
 * The overlay renders in renderingGroupId 1 with a high alphaIndex so
 * it composites after the opaque terrain and before unit meshes (which
 * live in renderingGroupId 2). Unit thin-instances rendered at higher
 * Y than the terrain fail depth-test against the fog where they sit,
 * so units in LOS aren't tinted by the radar overlay layer. The
 * heightmap-following geometry keeps the overlay anchored to the
 * surface so the tint follows cliffs and craters correctly — a flat
 * quad at Y=0 would only darken the lowest parts of the map.
 */
/** Per-visibility-tier terrain darkening (0 = fully lit, 1 = opaque black).
 *  The unscouted tier is capped well below 1 so out-of-vision ground reads
 *  as a dimmed version of the real (static, client-side) terrain rather than
 *  a black hole — see the TerrainFog class doc. Live-tunable at runtime. */
export interface FogDarkening {
    /** In radar / air-LOS but not ground LOS — the lightest dim. */
    radar: number;
    /** Explored earlier, not currently in radar or LOS. */
    explored: number;
    /** Never scouted (also the pre-first-bitmap fallback). Kept < 1. */
    unscouted: number;
}

export const DEFAULT_FOG_DARKENING: FogDarkening = {
    radar: 0.30,
    explored: 0.50,
    unscouted: 0.72,
};

/** Clamp a darkening factor into the renderable [0,1] alpha range. */
function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Overlay alpha byte (0..255) for one map square given its LOS bits and the
 *  darkening levels. Visible (inLos) → 0 (no overlay); otherwise the tier
 *  darkening, clamped. Pure — shared by `TerrainFog.apply` and its tests. */
export function fogTierAlpha255(
    losBit: boolean, radarBit: boolean, expBit: boolean,
    darken: FogDarkening,
): number {
    if (losBit)   return 0;
    if (radarBit) return Math.round(clamp01(darken.radar) * 255);
    if (expBit)   return Math.round(clamp01(darken.explored) * 255);
    return Math.round(clamp01(darken.unscouted) * 255);
}

export class TerrainFog {
    private mesh: Mesh | null = null;
    private texture: DynamicTexture | null = null;
    private bitmapSize: { w: number; h: number } = { w: 0, h: 0 };
    private mat: StandardMaterial | null = null;
    /** Live-tunable darkening levels (see FogDarkening). */
    private darken: FogDarkening = { ...DEFAULT_FOG_DARKENING };
    /** Last painted bitmap, kept so a live darkening change can repaint
     *  without waiting for the next ~1 Hz LOS snapshot. */
    private lastBitmap: LosBitmap | null = null;

    /** Build the overlay mesh + material. Idempotent — calling again
     *  disposes the previous mesh first so the caller can rebuild when
     *  MapData changes (e.g. game restart). */
    build(scene: Scene, dims: MapDimensions, heightData: Uint16Array): void {
        this.dispose();

        const hmW = dims.mapx + 1;
        const hmH = dims.mapy + 1;

        // Subsample identically to `buildTerrainMesh` so fog vertices
        // line up with terrain vertices (no z-fighting at edges).
        const MAX_VERTS = 512;
        const stepX = Math.max(1, Math.floor(hmW / MAX_VERTS));
        const stepZ = Math.max(1, Math.floor(hmH / MAX_VERTS));
        const gridW = Math.floor((hmW - 1) / stepX) + 1;
        const gridH = Math.floor((hmH - 1) / stepZ) + 1;

        const numVerts = gridW * gridH;
        const positions = new Float32Array(numVerts * 3);
        const uvs = new Float32Array(numVerts * 2);

        const hRange = dims.maxHeight - dims.minHeight;
        // One heightmap-square's worth of separation from terrain.
        // 3 elmos was below the z-buffer's resolvable delta at far zoom
        // (camera ~6000 elmos high) and produced visible stippling where
        // the LOS overlay fought the terrain. 8 elmos sits below the
        // shortest unit silhouette so the overlay still reads as glued
        // to the ground at close zoom.
        const FOG_Y_OFFSET = 8;

        for (let gz = 0; gz < gridH; gz++) {
            const srcZ = Math.min(gz * stepZ, hmH - 1);
            for (let gx = 0; gx < gridW; gx++) {
                const srcX = Math.min(gx * stepX, hmW - 1);
                const idx = gz * gridW + gx;
                const raw = heightData[srcZ * hmW + srcX];
                const worldY = dims.minHeight + (raw / 65535) * hRange;

                positions[idx * 3 + 0] = srcX * SQUARE_SIZE;
                positions[idx * 3 + 1] = worldY + FOG_Y_OFFSET;
                positions[idx * 3 + 2] = srcZ * SQUARE_SIZE;

                uvs[idx * 2 + 0] = gx / (gridW - 1);
                uvs[idx * 2 + 1] = gz / (gridH - 1);
            }
        }

        const numQuads = (gridW - 1) * (gridH - 1);
        const indices = new Uint32Array(numQuads * 6);
        let ti = 0;
        for (let gz = 0; gz < gridH - 1; gz++) {
            for (let gx = 0; gx < gridW - 1; gx++) {
                const tl = gz * gridW + gx;
                const tr = tl + 1;
                const bl = (gz + 1) * gridW + gx;
                const br = bl + 1;
                indices[ti++] = tl; indices[ti++] = tr; indices[ti++] = bl;
                indices[ti++] = tr; indices[ti++] = br; indices[ti++] = bl;
            }
        }

        const mesh = new Mesh('terrainFog', scene);
        const vd = new VertexData();
        vd.positions = positions;
        vd.indices = indices;
        vd.uvs = uvs;
        vd.applyToMesh(mesh);

        mesh.isPickable = false;
        // After water (group 1, alphaIndex 0) and before unit meshes
        // (renderingGroupId 2). The high alphaIndex pushes us to the
        // tail of the transparent queue within the group so opaque
        // terrain/water are already in the framebuffer.
        mesh.renderingGroupId = 1;
        mesh.alphaIndex = 100;
        // PLAN-lighting L3: this is a pure visibility overlay — it must
        // not receive sun shadows (they'd darken the LOS grid into a
        // confusing checkerboard) and must not appear in any caster
        // pass. The caller is also expected to never `addShadowCaster`
        // on this mesh; setting the flag here documents the contract.
        mesh.receiveShadows = false;

        const mat = new StandardMaterial('terrainFogMat', scene);
        mat.disableLighting = true;
        // We never sample the diffuse path; the overlay is pure
        // alpha-blended black driven by `opacityTexture`. Setting
        // emissive to black keeps the colour channel at zero.
        mat.diffuseColor = new Color3(0, 0, 0);
        mat.emissiveColor = new Color3(0, 0, 0);
        mat.specularColor = new Color3(0, 0, 0);
        mat.backFaceCulling = false;
        // Pre-bitmap fallback: a uniform "unscouted" dim (not opaque black).
        // Until the first LOS snapshot arrives there is no opacityTexture, so
        // the material's flat alpha is the whole overlay — cap it at the
        // unscouted darkening so a not-yet-scouted / pre-frame-0 map is dark-
        // but-readable. `apply()` sets alpha back to 1 once the per-square
        // opacity texture (which bakes the darkening in) takes over.
        mat.alpha = this.darken.unscouted;
        // Force alpha-blended even before an opacity texture exists (a
        // StandardMaterial with no alpha source would otherwise render opaque).
        mat.transparencyMode = StandardMaterial.MATERIAL_ALPHABLEND;
        // Don't write to depth — units behind fog still need to read
        // the terrain's depth value, not the fog's slightly-raised one.
        mat.disableDepthWrite = true;

        mesh.material = mat;
        this.mesh = mesh;
        this.mat = mat;
    }

    /** Paint a new LOS snapshot into the fog texture. Called from the
     *  connection event handler whenever an `ENVELOPE_LOS_BITMAP` frame
     *  arrives (~1 Hz, server-paced). Spectators may see multiple
     *  ally teams round-robin — we just take the latest, matching the
     *  minimap's behaviour. */
    apply(bitmap: LosBitmap): void {
        if (!this.mesh || !this.mat) return;
        const { width, height, inLos, inRadar, explored } = bitmap;
        if (width === 0 || height === 0) return;
        this.lastBitmap = bitmap;

        if (!this.texture
            || this.bitmapSize.w !== width
            || this.bitmapSize.h !== height)
        {
            this.texture?.dispose();
            const scene = this.mesh.getScene();
            this.texture = new DynamicTexture(
                'terrainFogTex',
                { width, height },
                scene,
                false,
            );
            this.texture.hasAlpha = true;
            this.texture.wrapU = Texture.CLAMP_ADDRESSMODE;
            this.texture.wrapV = Texture.CLAMP_ADDRESSMODE;
            // Bilinear sampling smooths the 64×64 source across the
            // ~7000-elmo-wide terrain mesh — chunky pixel edges would
            // be very obvious at that scale.
            this.texture.updateSamplingMode(Texture.BILINEAR_SAMPLINGMODE);
            this.bitmapSize = { w: width, h: height };
            this.mat.opacityTexture = this.texture;
            // The per-square texture now carries the darkening in its alpha;
            // the flat material alpha (the pre-bitmap fallback) would double-
            // attenuate it, so hand authority to the texture.
            this.mat.alpha = 1;
        }

        // getContext() can transiently return null if the underlying
        // offscreen canvas creation failed (Safari/Firefox edge cases) or
        // if the scene's engine context was lost mid-frame. Skip this
        // bitmap — the next LOS snapshot (~1 Hz) will retry.
        const ctx = this.texture.getContext() as CanvasRenderingContext2D | null;
        if (!ctx) return;
        const img = ctx.createImageData(width, height);
        const data = img.data;
        for (let row = 0; row < height; ++row) {
            for (let col = 0; col < width; ++col) {
                const idx = row * width + col;
                const byte = idx >> 3;
                const bit = 7 - (idx & 7);
                const mask = 1 << bit;
                const losBit   = (inLos[byte]    & mask) !== 0;
                const radarBit = (inRadar[byte]  & mask) !== 0;
                const expBit   = (explored[byte] & mask) !== 0;
                const alpha255 = fogTierAlpha255(losBit, radarBit, expBit, this.darken);
                const o = idx * 4;
                data[o    ] = 0;
                data[o + 1] = 0;
                data[o + 2] = 0;
                data[o + 3] = alpha255;
            }
        }
        ctx.putImageData(img, 0, 0);
        this.texture.update(false);
    }

    /** Current darkening levels (a copy — mutate via `setDarkening`). */
    getDarkening(): FogDarkening {
        return { ...this.darken };
    }

    /** Live-tune the per-tier darkening. Merges a partial update, clamps to
     *  [0,1], and repaints immediately (from the last LOS bitmap, or the
     *  material-alpha fallback if none has arrived). Reached from DevTools
     *  via `window.__gp('__fowDarkening.set({unscouted:0.8})')`. */
    setDarkening(levels: Partial<FogDarkening>): FogDarkening {
        if (levels.radar     !== undefined) this.darken.radar     = clamp01(levels.radar);
        if (levels.explored  !== undefined) this.darken.explored  = clamp01(levels.explored);
        if (levels.unscouted !== undefined) this.darken.unscouted = clamp01(levels.unscouted);
        // Keep the pre-bitmap fallback alpha in sync when no texture is live.
        if (this.mat && !this.texture) this.mat.alpha = this.darken.unscouted;
        if (this.lastBitmap) this.apply(this.lastBitmap);
        return { ...this.darken };
    }

    /** Toggle visibility — `window.__toggleTerrain` reaches in via the
     *  global handle exposed in main.ts for debug. */
    setVisible(v: boolean): void {
        if (this.mesh) this.mesh.isVisible = v;
    }

    /** Underlying overlay mesh (or null if not built yet). Exposed so
     *  the bootstrap can call `csm.removeShadowCaster(fog.getMesh())`
     *  as a belt-and-suspenders against any future code path that
     *  accidentally enrols overlay surfaces as shadow casters. */
    getMesh(): Mesh | null {
        return this.mesh;
    }

    dispose(): void {
        this.texture?.dispose();
        this.mat?.dispose();
        this.mesh?.dispose();
        this.texture = null;
        this.mat = null;
        this.mesh = null;
        this.bitmapSize = { w: 0, h: 0 };
        this.lastBitmap = null;
    }
}
