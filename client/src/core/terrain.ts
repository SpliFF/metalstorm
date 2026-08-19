/**
 * Terrain — chunked heightmap mesh + DXT1 tile texture compositing.
 *
 * Builds a terrain mesh from uint16 heightmap data and textures it
 * by compositing 32x32 DXT1 tiles into larger WebGL textures using
 * compressedTexSubImage2D. No intermediate format conversion — raw
 * DXT1 bytes go straight from the server to the GPU.
 *
 * PLAN-maps.md M4: the mesh is a **grid of chunk meshes** at full heightmap
 * resolution (one vertex per map square), not a single 512²-subsampled mesh.
 * Every chunk shares one material instance (so material plugins bind once and
 * the draw count stays bounded), keeps GLOBAL 0..1 map UVs (so the atlas
 * paging + splat/decal plugins are unaffected), and carries a step-4 LOD1
 * variant registered via `Mesh.addLODLevel` plus one-vertex downward skirts
 * that hide the T-junction cracks between neighbouring chunks at different
 * LODs. Small maps (≤513² heightmaps) keep the single-mesh, no-LOD path.
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
    RawTexture,
    Color3,
    Vector3,
    VertexBuffer,
} from '@babylonjs/core';
import type { Material } from '@babylonjs/core';
import { getEngineGl } from './engine-gl.js';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import type { LosBitmap } from './los-bitmap.js';
import { DecalOverlayPlugin, attachDecalOverlay } from './decal-overlay-plugin.js';
import type { FineWindowState } from './decal-overlay.js';
import { WaterAbsorptionPlugin, attachWaterAbsorption } from './water-absorption-plugin.js';
import {
    TerrainSplatPlugin, attachTerrainSplat, attachTerrainDetailPlain,
    attachTerrainSplatNormal,
} from './terrain-splat-plugin.js';
import type { TerrainDetailMode } from './terrain-splat-plugin.js';
import type { MapWaterAbsorption } from './map-lighting.js';
import {
    TerrainPageSamplePlugin, attachTerrainPageSample,
} from './terrain-page-plugin.js';
import type { PageSampleGeometry } from './terrain-page-plugin.js';
import type { BaseTexture } from '@babylonjs/core';

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

// ---------------------------------------------------------------------------
// Chunked terrain mesh (PLAN-maps.md M4)
// ---------------------------------------------------------------------------

/** Target quads-per-axis in one chunk at full heightmap resolution. */
const DEFAULT_CHUNK_QUADS = 128;
/** Hard cap on chunks per axis. 8 → ≤64 terrain draw calls at whole-map zoom,
 *  the PLAN-maps.md §3 guardrail. Bigger maps get bigger chunks, not more. */
const MAX_CHUNKS_PER_AXIS = 8;
/** Decimation step of the LOD1 (far) chunk geometry — one vertex per 4 map
 *  squares, i.e. the density the old 512-cap mesh used on a 2049² map. */
const LOD1_STEP = 4;
/** Heightmaps this size or smaller keep the single-mesh, no-LOD path (they
 *  already rendered at full resolution under the old 512 cap). */
const SINGLE_MESH_MAX_HM = 513;
/** Chunk-border skirt depth bounds (elmos). The skirt is a 1-vertex apron
 *  dropped straight down from each chunk edge; it only becomes visible where
 *  a crack would otherwise open between chunks at different LODs. */
const MIN_SKIRT_DEPTH = 12;
const MAX_SKIRT_DEPTH = 400;

/** How `buildTerrainMesh` split (or didn't split) the heightmap into chunks. */
export interface TerrainChunkPlan {
    /** Quads per axis in a full chunk (the last row/column may be smaller). */
    chunkQuads: number;
    chunksX: number;
    chunksZ: number;
    /** Heightmap step of the LOD1 geometry; 0 = no LOD level at all. */
    lodStep: number;
    /** Camera distance (elmos) beyond which a chunk swaps to LOD1. */
    lodDistance: number;
    /** True for the single-mesh small-map path (no chunk seams, no skirts). */
    single: boolean;
}

export interface TerrainChunkOptions {
    chunkQuads?: number;
    maxChunksPerAxis?: number;
    lodStep?: number;
}

/**
 * Plan the chunk grid for a `hmW × hmH` corner heightmap. Pure (no Babylon)
 * so the sizing + LOD policy is unit-tested.
 *
 * - ≤513² heightmaps → one chunk, no LOD, no skirts (unchanged from the old
 *   single-mesh path, which was already full-resolution at that size).
 * - larger → `chunkQuads`-sized chunks, doubling the chunk size until the grid
 *   fits `maxChunksPerAxis` so the draw count stays bounded. A 2049² map
 *   (2048 quads) lands on 8×8 chunks of 256 quads = 64 draws.
 */
export function planTerrainChunks(
    hmW: number, hmH: number, opts: TerrainChunkOptions = {},
): TerrainChunkPlan {
    const quadsX = Math.max(1, hmW - 1);
    const quadsZ = Math.max(1, hmH - 1);

    if (hmW <= SINGLE_MESH_MAX_HM && hmH <= SINGLE_MESH_MAX_HM) {
        return {
            chunkQuads: Math.max(quadsX, quadsZ),
            chunksX: 1, chunksZ: 1,
            lodStep: 0, lodDistance: Infinity, single: true,
        };
    }

    const maxPerAxis = Math.max(1, opts.maxChunksPerAxis ?? MAX_CHUNKS_PER_AXIS);
    let chunkQuads = Math.max(1, opts.chunkQuads ?? DEFAULT_CHUNK_QUADS);
    while (Math.ceil(quadsX / chunkQuads) > maxPerAxis
        || Math.ceil(quadsZ / chunkQuads) > maxPerAxis) {
        chunkQuads *= 2;
    }
    const chunkWorld = chunkQuads * SQUARE_SIZE;
    return {
        chunkQuads,
        chunksX: Math.ceil(quadsX / chunkQuads),
        chunksZ: Math.ceil(quadsZ / chunkQuads),
        lodStep: opts.lodStep ?? LOD1_STEP,
        // Babylon measures LOD distance from the camera to the chunk's
        // bounding-sphere CENTRE, so the switch has to clear a chunk's own
        // half-diagonal (~0.7·chunkWorld) before the ground under the camera
        // would drop to LOD1. 2× chunk width with a 3000-elmo floor keeps the
        // camera's own chunk + its immediate ring at full resolution at
        // gameplay zoom, while whole-map zoom (camera thousands of elmos up)
        // puts everything on LOD1.
        lodDistance: Math.max(3000, chunkWorld * 2),
        single: false,
    };
}

/** CPU-side geometry of one terrain surface (a chunk at one LOD). */
export interface SurfaceGeometry {
    positions: Float32Array;
    uvs: Float32Array;
    indices: Uint16Array | Uint32Array;
    /** Source heightmap column sampled by each grid column (length gw). */
    srcXs: Int32Array;
    /** Source heightmap row sampled by each grid row (length gh). */
    srcZs: Int32Array;
    gw: number;
    gh: number;
    /** Vertex count of the regular grid; skirt vertices follow it. */
    gridVerts: number;
    /** Grid vertex each skirt vertex hangs from (skirt vertex k lives at
     *  index `gridVerts + k`). Empty when the surface has no skirt. */
    skirtSrc: Int32Array;
    skirtDepth: number;
}

/** Heightmap columns/rows sampled by a surface spanning [a0..a1] at `step`.
 *  The last entry always lands exactly on `a1` so neighbouring chunks share
 *  their border vertices even when the span isn't a multiple of `step`. */
function axisSamples(a0: number, a1: number, step: number): Int32Array {
    const span = Math.max(0, a1 - a0);
    const n = Math.floor(span / step) + 1 + (span % step ? 1 : 0);
    const out = new Int32Array(Math.max(1, n));
    for (let i = 0; i < out.length; i++) out[i] = Math.min(a0 + i * step, a1);
    return out;
}

/**
 * Build the positions/UVs/indices of one terrain surface covering heightmap
 * corners [x0..x1] × [z0..z1] at `step`, optionally with a border skirt.
 *
 * UVs are GLOBAL map UVs (`srcX / (hmW-1)`, `srcZ / (hmH-1)`) — the atlas
 * paging (`applyPagedTextures`) and the splat/decal plugins all sample in
 * whole-map space, so a chunk must not renormalise them.
 *
 * Triangle winding is tl→bl→tr / tr→bl→br, unchanged from the pre-chunk mesh
 * (PLAN-coordinate-system Phase 2d RH scene). Terrain materials run with
 * `backFaceCulling = false`, which is also what makes the vertical skirt
 * quads visible from either side.
 */
export function buildSurfaceGeometry(p: {
    x0: number; z0: number; x1: number; z1: number;
    step: number; hmW: number; hmH: number;
    sampleY: (sx: number, sz: number) => number;
    skirt: boolean;
    /** Optional cache of index buffers keyed by grid shape. Every same-shaped
     *  chunk has byte-identical topology, so a 2049² map's 64 chunks share ~2
     *  index arrays instead of allocating 64 (~100 MB of CPU heap saved).
     *  Safe because nothing mutates a surface's indices in place — the paged
     *  atlas path builds a fresh permuted array per surface. */
    indexCache?: Map<string, Uint16Array | Uint32Array>;
}): SurfaceGeometry {
    const { x0, z0, x1, z1, step, hmW, hmH, sampleY, skirt } = p;
    const srcXs = axisSamples(x0, x1, step);
    const srcZs = axisSamples(z0, z1, step);
    const gw = srcXs.length, gh = srcZs.length;
    const gridVerts = gw * gh;
    const skirtCount = skirt ? 2 * gw + 2 * gh : 0;
    const total = gridVerts + skirtCount;

    const positions = new Float32Array(total * 3);
    const uvs = new Float32Array(total * 2);
    const invW = 1 / Math.max(1, hmW - 1);
    const invH = 1 / Math.max(1, hmH - 1);

    let minY = Infinity, maxY = -Infinity;
    for (let iz = 0; iz < gh; iz++) {
        const sz = srcZs[iz];
        for (let ix = 0; ix < gw; ix++) {
            const sx = srcXs[ix];
            const v = iz * gw + ix;
            const y = sampleY(sx, sz);
            positions[v * 3 + 0] = sx * SQUARE_SIZE;
            positions[v * 3 + 1] = y;
            positions[v * 3 + 2] = sz * SQUARE_SIZE;
            uvs[v * 2 + 0] = sx * invW;
            uvs[v * 2 + 1] = sz * invH;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }

    // The crack a LOD mismatch can open is bounded by the local height
    // variation, so scale the apron with it (clamped) instead of picking one
    // global constant that is either visible on flat maps or too short on
    // cliffs.
    const skirtDepth = skirt
        ? Math.min(MAX_SKIRT_DEPTH, Math.max(MIN_SKIRT_DEPTH, (maxY - minY) * 0.35))
        : 0;

    const strips: Int32Array[] = [];
    if (skirt) {
        const top = new Int32Array(gw), bottom = new Int32Array(gw);
        for (let ix = 0; ix < gw; ix++) {
            top[ix] = ix;
            bottom[ix] = (gh - 1) * gw + ix;
        }
        const left = new Int32Array(gh), right = new Int32Array(gh);
        for (let iz = 0; iz < gh; iz++) {
            left[iz] = iz * gw;
            right[iz] = iz * gw + (gw - 1);
        }
        strips.push(top, bottom, left, right);
    }

    const skirtSrc = new Int32Array(skirtCount);
    let k = 0;
    for (const strip of strips) {
        for (let i = 0; i < strip.length; i++) {
            const src = strip[i];
            const v = gridVerts + k;
            positions[v * 3 + 0] = positions[src * 3 + 0];
            positions[v * 3 + 1] = positions[src * 3 + 1] - skirtDepth;
            positions[v * 3 + 2] = positions[src * 3 + 2];
            uvs[v * 2 + 0] = uvs[src * 2 + 0];
            uvs[v * 2 + 1] = uvs[src * 2 + 1];
            skirtSrc[k++] = src;
        }
    }

    const gridQuads = Math.max(0, gw - 1) * Math.max(0, gh - 1);
    let skirtQuads = 0;
    for (const strip of strips) skirtQuads += Math.max(0, strip.length - 1);

    // Topology depends only on the grid shape, so same-shaped chunks reuse it.
    const shapeKey = `${gw}x${gh}${skirt ? 's' : ''}`;
    const cached = p.indexCache?.get(shapeKey);
    if (cached) {
        return {
            positions, uvs, indices: cached, srcXs, srcZs, gw, gh,
            gridVerts, skirtSrc, skirtDepth,
        };
    }

    const indices = total <= 65535
        ? new Uint16Array((gridQuads + skirtQuads) * 6)
        : new Uint32Array((gridQuads + skirtQuads) * 6);

    let ti = 0;
    for (let iz = 0; iz < gh - 1; iz++) {
        for (let ix = 0; ix < gw - 1; ix++) {
            const tl = iz * gw + ix;
            const tr = tl + 1;
            const bl = (iz + 1) * gw + ix;
            const br = bl + 1;
            indices[ti++] = tl; indices[ti++] = bl; indices[ti++] = tr;
            indices[ti++] = tr; indices[ti++] = bl; indices[ti++] = br;
        }
    }
    let base = gridVerts;
    for (const strip of strips) {
        for (let i = 0; i < strip.length - 1; i++) {
            const a = strip[i], b = strip[i + 1];
            const as = base + i, bs = base + i + 1;
            indices[ti++] = a; indices[ti++] = as; indices[ti++] = b;
            indices[ti++] = b; indices[ti++] = as; indices[ti++] = bs;
        }
        base += strip.length;
    }
    p.indexCache?.set(shapeKey, indices);

    return {
        positions, uvs, indices, srcXs, srcZs, gw, gh,
        gridVerts, skirtSrc, skirtDepth,
    };
}

/**
 * Central-difference heightfield normal at corner (sx, sz), written into
 * `normals[vi]`. Exact for a regular grid and, crucially, computed from the
 * *global* heightfield sampler — so a chunk-border vertex gets the same normal
 * in both chunks that own it and the seam stays invisible.
 *
 * Up-facing: normalize(-dH/dx, 1, -dH/dz). (The pre-chunk mesh got the same
 * orientation by negating `VertexData.ComputeNormals` output; deriving it
 * analytically here means static and deformed terrain agree exactly.)
 */
function writeHeightfieldNormal(
    normals: Float32Array, vi: number, sx: number, sz: number,
    sampleY: (x: number, z: number) => number,
    hmW: number, hmH: number, step: number,
): void {
    const xm = Math.max(0, sx - step), xp = Math.min(hmW - 1, sx + step);
    const zm = Math.max(0, sz - step), zp = Math.min(hmH - 1, sz + step);
    const dx = (xp - xm) * SQUARE_SIZE;
    const dz = (zp - zm) * SQUARE_SIZE;
    const dHdx = dx > 0 ? (sampleY(xp, sz) - sampleY(xm, sz)) / dx : 0;
    const dHdz = dz > 0 ? (sampleY(sx, zp) - sampleY(sx, zm)) / dz : 0;
    const nx = -dHdx, ny = 1, nz = -dHdz;
    const inv = 1 / Math.hypot(nx, ny, nz);
    normals[vi * 3 + 0] = nx * inv;
    normals[vi * 3 + 1] = ny * inv;
    normals[vi * 3 + 2] = nz * inv;
}

/** Normals for a whole surface. Always sampled at heightmap step 1 (even for
 *  LOD1 geometry) so shading detail — and therefore the perceived relief —
 *  doesn't pop when a chunk swaps LOD. */
export function computeSurfaceNormals(
    geo: SurfaceGeometry,
    sampleY: (sx: number, sz: number) => number,
    hmW: number, hmH: number,
    out?: Float32Array,
): Float32Array {
    const normals = out ?? new Float32Array(geo.positions.length);
    for (let iz = 0; iz < geo.gh; iz++) {
        for (let ix = 0; ix < geo.gw; ix++) {
            writeHeightfieldNormal(normals, iz * geo.gw + ix,
                geo.srcXs[ix], geo.srcZs[iz], sampleY, hmW, hmH, 1);
        }
    }
    copySkirtNormals(geo, normals);
    return normals;
}

/** Skirt vertices inherit their source vertex's normal (they're an apron of
 *  the same surface, not a separate wall). */
function copySkirtNormals(geo: SurfaceGeometry, normals: Float32Array): void {
    for (let k = 0; k < geo.skirtSrc.length; k++) {
        const d = (geo.gridVerts + k) * 3, s = geo.skirtSrc[k] * 3;
        normals[d + 0] = normals[s + 0];
        normals[d + 1] = normals[s + 1];
        normals[d + 2] = normals[s + 2];
    }
}

/** One drawable terrain surface: a chunk at a single level of detail. */
export interface TerrainSurface {
    mesh: Mesh;
    /** Heightmap step this surface samples (1 = full resolution). */
    step: number;
    geo: SurfaceGeometry;
    normals: Float32Array;
}

/** One terrain chunk: full-res LOD0 mesh + optional decimated LOD1. */
export interface TerrainChunk {
    cx: number;
    cz: number;
    /** Heightmap corner range this chunk covers, inclusive on both ends —
     *  neighbouring chunks share their border column/row. */
    x0: number; z0: number; x1: number; z1: number;
    lod0: TerrainSurface;
    lod1: TerrainSurface | null;
}

/** Name prefix of a pickable (LOD0) terrain chunk mesh. LOD meshes use a
 *  different prefix so pick predicates never hit them — Babylon's
 *  `scene.pick` skips its own `isPickable` check when a predicate is given. */
const TERRAIN_CHUNK_PREFIX = 'terrain_';
const TERRAIN_LOD_PREFIX = 'terrainLod';

/** Pick/ray predicate: is this mesh part of the drawn terrain surface?
 *  Replaces the `m.name === 'terrain'` checks scattered through the camera,
 *  selection, command and build-placement pick paths. */
export function isTerrainMesh(mesh: { name: string }): boolean {
    return mesh.name === 'terrain' || mesh.name.startsWith(TERRAIN_CHUNK_PREFIX);
}

/**
 * The terrain as a set of chunk meshes sharing one material.
 *
 * Everything that used to take the single `Mesh` takes this instead:
 * materials are applied to every chunk (and every LOD level), plugin
 * attach/reattach walks `materials`, and `heightAt`/`setHeightAt` give
 * DeformableTerrain a chunk-agnostic view of the live heightfield (which is
 * also how chunk-border normals stay continuous — the neighbour's heights are
 * readable through the group).
 */
export class TerrainMeshGroup {
    private _material: Material | null = null;

    constructor(
        readonly dims: MapDimensions,
        readonly plan: TerrainChunkPlan,
        readonly chunks: TerrainChunk[],
    ) {}

    /** Corner heightmap width/height (= map squares + 1). */
    get hmW(): number { return this.dims.mapx + 1; }
    get hmH(): number { return this.dims.mapy + 1; }

    /** LOD0 chunk meshes — the pickable, frustum-culled draw set. */
    get meshes(): Mesh[] { return this.chunks.map((c) => c.lod0.mesh); }

    /** Every surface, LOD levels included. */
    get surfaces(): TerrainSurface[] {
        const out: TerrainSurface[] = [];
        for (const c of this.chunks) {
            out.push(c.lod0);
            if (c.lod1) out.push(c.lod1);
        }
        return out;
    }

    /** Every mesh, LOD levels included (material/shadow/dispose operations). */
    get allMeshes(): Mesh[] { return this.surfaces.map((s) => s.mesh); }

    /** A representative mesh — for code that just needs *a* terrain mesh
     *  handle (scene-graph parenting, debug hooks). */
    get primaryMesh(): Mesh { return this.chunks[0].lod0.mesh; }

    /** The shared material instance (single StandardMaterial, or the paged
     *  MultiMaterial). Every chunk carries the same one. */
    get material(): Material | null { return this._material; }

    setMaterial(mat: Material | null): void {
        this._material = mat;
        for (const m of this.allMeshes) m.material = mat;
    }

    /** The StandardMaterials behind the terrain — the MultiMaterial's
     *  sub-materials when paged, otherwise the single material. This is the
     *  list material plugins attach to. */
    get materials(): Material[] {
        const m = this._material;
        if (!m) return [];
        if (m instanceof MultiMaterial) {
            return m.subMaterials.filter((s): s is Material => !!s);
        }
        return [m];
    }

    setReceiveShadows(v: boolean): void {
        for (const m of this.allMeshes) m.receiveShadows = v;
    }

    /** Chunk owning corner (sx, sz) — the one whose [x0..x1] range starts at
     *  or before it. Border corners are owned by up to 4 chunks; this returns
     *  the "primary" (higher-index) owner, which `setHeightAt` complements. */
    private primaryChunk(sx: number, sz: number): TerrainChunk {
        const q = this.plan.chunkQuads;
        const cx = Math.min(Math.floor(sx / q), this.plan.chunksX - 1);
        const cz = Math.min(Math.floor(sz / q), this.plan.chunksZ - 1);
        return this.chunks[cz * this.plan.chunksX + cx];
    }

    /** World-Y of heightmap corner (sx, sz), read straight out of the LOD0
     *  vertex buffers (which are full-resolution, so no interpolation). */
    heightAt(sx: number, sz: number): number {
        const x = sx < 0 ? 0 : sx > this.hmW - 1 ? this.hmW - 1 : sx;
        const z = sz < 0 ? 0 : sz > this.hmH - 1 ? this.hmH - 1 : sz;
        const c = this.primaryChunk(x, z);
        const g = c.lod0.geo;
        return g.positions[((z - c.z0) * g.gw + (x - c.x0)) * 3 + 1];
    }

    /** Write world-Y into every LOD0 chunk that owns corner (sx, sz) — up to
     *  four at a chunk corner — so the shared border vertices stay identical
     *  and `heightAt` is single-valued. */
    setHeightAt(sx: number, sz: number, y: number): void {
        const q = this.plan.chunkQuads;
        const cxBase = Math.min(Math.floor(sx / q), this.plan.chunksX - 1);
        const czBase = Math.min(Math.floor(sz / q), this.plan.chunksZ - 1);
        for (let dz = 0; dz <= 1; dz++) {
            const cz = czBase - dz;
            if (cz < 0 || (dz === 1 && sz % q !== 0)) continue;
            for (let dx = 0; dx <= 1; dx++) {
                const cx = cxBase - dx;
                if (cx < 0 || (dx === 1 && sx % q !== 0)) continue;
                const c = this.chunks[cz * this.plan.chunksX + cx];
                if (sx < c.x0 || sx > c.x1 || sz < c.z0 || sz > c.z1) continue;
                const g = c.lod0.geo;
                g.positions[((sz - c.z0) * g.gw + (sx - c.x0)) * 3 + 1] = y;
            }
        }
    }

    dispose(): void {
        for (const m of this.allMeshes) m.dispose();
        this._material?.dispose();
        this._material = null;
    }
}

/** Wrap one surface's CPU geometry in a Babylon mesh. `updatable = true`
 *  keeps the position + normal buffers CPU-backed so DeformableTerrain can
 *  rewrite affected vertices in place. */
function createSurfaceMesh(
    scene: Scene, name: string, geo: SurfaceGeometry, normals: Float32Array,
): Mesh {
    const mesh = new Mesh(name, scene);
    const vd = new VertexData();
    vd.positions = geo.positions;
    vd.indices = geo.indices;
    vd.normals = normals;
    vd.uvs = geo.uvs;
    vd.applyToMesh(mesh, true);
    return mesh;
}

/**
 * Build the terrain from uint16 heightmap data.
 * Heights are scaled from uint16 (0-65535) to world units using min/max height.
 *
 * Returns a `TerrainMeshGroup`: one chunk for small maps, an N×N grid of
 * full-resolution chunk meshes (each with a step-4 LOD1 and border skirts)
 * for larger ones. All chunks share one material instance.
 */
export function buildTerrainMesh(
    scene: Scene,
    dims: MapDimensions,
    heightData: Uint16Array,
    opts: TerrainChunkOptions = {},
): TerrainMeshGroup {
    const hmW = dims.mapx + 1; // vertices = squares + 1
    const hmH = dims.mapy + 1;
    const plan = planTerrainChunks(hmW, hmH, opts);
    const hRange = dims.maxHeight - dims.minHeight;
    const rawY = (sx: number, sz: number): number =>
        dims.minHeight + (heightData[sz * hmW + sx] / 65535) * hRange;

    // Pass 1 — LOD0 geometry for every chunk (positions/UVs/indices). Normals
    // come after, because a chunk-border normal needs the NEIGHBOUR chunk's
    // heights and those only exist once every chunk's positions are filled.
    const q = plan.chunkQuads;
    const indexCache = new Map<string, Uint16Array | Uint32Array>();
    const lod0Geo: SurfaceGeometry[] = [];
    const bounds: { x0: number; z0: number; x1: number; z1: number }[] = [];
    for (let cz = 0; cz < plan.chunksZ; cz++) {
        for (let cx = 0; cx < plan.chunksX; cx++) {
            const x0 = cx * q, z0 = cz * q;
            const x1 = Math.min(x0 + q, hmW - 1);
            const z1 = Math.min(z0 + q, hmH - 1);
            bounds.push({ x0, z0, x1, z1 });
            lod0Geo.push(buildSurfaceGeometry({
                x0, z0, x1, z1, step: 1, hmW, hmH,
                sampleY: rawY, skirt: !plan.single, indexCache,
            }));
        }
    }

    // Global heightfield sampler backed by the LOD0 buffers — identical to
    // `TerrainMeshGroup.heightAt`, but usable before the group exists.
    const heightAt = (sx: number, sz: number): number => {
        const x = sx < 0 ? 0 : sx > hmW - 1 ? hmW - 1 : sx;
        const z = sz < 0 ? 0 : sz > hmH - 1 ? hmH - 1 : sz;
        const cx = Math.min(Math.floor(x / q), plan.chunksX - 1);
        const cz = Math.min(Math.floor(z / q), plan.chunksZ - 1);
        const i = cz * plan.chunksX + cx;
        const g = lod0Geo[i], b = bounds[i];
        return g.positions[((z - b.z0) * g.gw + (x - b.x0)) * 3 + 1];
    };

    // Pass 2 — normals, meshes, LOD levels.
    const chunks: TerrainChunk[] = [];
    let lod0Verts = 0, lod1Verts = 0;
    for (let cz = 0; cz < plan.chunksZ; cz++) {
        for (let cx = 0; cx < plan.chunksX; cx++) {
            const i = cz * plan.chunksX + cx;
            const b = bounds[i];
            const geo = lod0Geo[i];
            const normals = computeSurfaceNormals(geo, heightAt, hmW, hmH);
            const name = plan.single ? 'terrain' : `${TERRAIN_CHUNK_PREFIX}${cx}_${cz}`;
            const mesh = createSurfaceMesh(scene, name, geo, normals);
            lod0Verts += geo.positions.length / 3;

            let lod1: TerrainSurface | null = null;
            if (plan.lodStep > 1) {
                const g1 = buildSurfaceGeometry({
                    x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1,
                    step: plan.lodStep, hmW, hmH, sampleY: heightAt, skirt: true,
                    indexCache,
                });
                const n1 = computeSurfaceNormals(g1, heightAt, hmW, hmH);
                const m1 = createSurfaceMesh(
                    scene, `${TERRAIN_LOD_PREFIX}1_${cx}_${cz}`, g1, n1);
                // Babylon renders a LOD mesh only in place of its master
                // (Mesh.isBlocked hides it from the normal active-mesh pass);
                // it must also stay out of ray picks, which use the LOD0
                // geometry for every chunk regardless of what's drawn.
                m1.isPickable = false;
                mesh.addLODLevel(plan.lodDistance, m1);
                lod1 = { mesh: m1, step: plan.lodStep, geo: g1, normals: n1 };
                lod1Verts += g1.positions.length / 3;
            }

            chunks.push({ cx, cz, ...b, lod0: { mesh, step: 1, geo, normals }, lod1 });
        }
    }

    const group = new TerrainMeshGroup(dims, plan, chunks);

    // Default material (replaced when textures load). ONE instance shared by
    // every chunk + LOD mesh: material plugins bind per material, and the
    // paged-atlas path relies on a single MultiMaterial across the whole map.
    const mat = new StandardMaterial('terrainMat', scene);
    mat.diffuseColor = new Color3(0.3, 0.35, 0.2);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    mat.backFaceCulling = false;
    group.setMaterial(mat);

    console.log(`[terrain] ${plan.chunksX}x${plan.chunksZ} chunk(s) of ` +
        `${plan.chunkQuads} quads @ full heightmap res (${hmW}x${hmH} corners); ` +
        `LOD0 ${Math.round(lod0Verts / 1000)}k verts` +
        (plan.lodStep > 1
            ? `, LOD1 step ${plan.lodStep} ${Math.round(lod1Verts / 1000)}k verts ` +
              `@ ${plan.lodDistance} elmos`
            : ' (single-mesh path, no LOD)'));
    return group;
}

/**
 * DeformableTerrain — applies live server heightmap patches (envelope 0x09,
 * PLAN-deformable-terrain T3) to the chunked terrain built by
 * `buildTerrainMesh`.
 *
 * Since M4 the LOD0 chunks carry one vertex per heightmap corner, so a patch
 * lands exactly — the old "patch narrower than one grid step disappears"
 * subsample limitation is gone. A patch arrives in corner coordinates
 * [x1..x2]×[z1..z2] with actual world-Y heights; we
 *
 *   1. write them into every LOD0 chunk that owns those corners (border
 *      corners belong to up to four chunks),
 *   2. recompute normals over the patch plus a one-corner ring (central
 *      differences over the *global* heightfield via `group.heightAt`, so
 *      chunk-border normals stay continuous),
 *   3. re-derive the affected chunks' skirt vertices, and
 *   4. re-upload the position + normal buffers of ONLY the touched chunks —
 *      at both LOD levels. On a 2049² map that's ≤ a few hundred kB per patch
 *      instead of the whole-map buffer the pre-M4 code re-uploaded.
 */
export class DeformableTerrain {
    private patchCount = 0;

    constructor(private group: TerrainMeshGroup) {}

    /** Apply one heightmap patch (corner coords, actual world-Y heights). */
    applyPatch(p: { x1: number; z1: number; x2: number; z2: number; heights: Float32Array }): void {
        const { x1, z1, x2, z2, heights } = p;
        const g = this.group;
        const pw = x2 - x1 + 1;
        const sx0 = Math.max(0, x1), sx1 = Math.min(g.hmW - 1, x2);
        const sz0 = Math.max(0, z1), sz1 = Math.min(g.hmH - 1, z2);
        if (sx0 > sx1 || sz0 > sz1) return;

        for (let sz = sz0; sz <= sz1; sz++) {
            for (let sx = sx0; sx <= sx1; sx++) {
                g.setHeightAt(sx, sz, heights[(sz - z1) * pw + (sx - x1)]);
            }
        }

        // Normals one corner outside the patch also change (central
        // differences), so the refresh region is the patch grown by 1.
        const nx0 = Math.max(0, sx0 - 1), nx1 = Math.min(g.hmW - 1, sx1 + 1);
        const nz0 = Math.max(0, sz0 - 1), nz1 = Math.min(g.hmH - 1, sz1 + 1);
        for (const chunk of g.chunks) {
            if (chunk.x1 < nx0 || chunk.x0 > nx1
                || chunk.z1 < nz0 || chunk.z0 > nz1) continue;
            this.refreshSurface(chunk.lod0, nx0, nz0, nx1, nz1);
            if (chunk.lod1) this.refreshSurface(chunk.lod1, nx0, nz0, nx1, nz1);
        }
        this.patchCount++;
    }

    /** Number of patches applied so far (debug / verification handle). */
    get appliedPatches(): number { return this.patchCount; }

    /** Re-sample + re-normal the part of one surface covering heightmap
     *  corners [sx0..sx1]×[sz0..sz1], then re-upload that surface's buffers. */
    private refreshSurface(
        s: TerrainSurface, sx0: number, sz0: number, sx1: number, sz1: number,
    ): void {
        const g = this.group;
        const geo = s.geo;
        const [ix0, ix1] = gridRange(geo.srcXs, sx0, sx1);
        const [iz0, iz1] = gridRange(geo.srcZs, sz0, sz1);
        if (ix0 < 0 || iz0 < 0) return;

        const sample = (x: number, z: number): number => g.heightAt(x, z);
        for (let iz = iz0; iz <= iz1; iz++) {
            const sz = geo.srcZs[iz];
            for (let ix = ix0; ix <= ix1; ix++) {
                const sx = geo.srcXs[ix];
                const vi = iz * geo.gw + ix;
                geo.positions[vi * 3 + 1] = sample(sx, sz);
                writeHeightfieldNormal(
                    s.normals, vi, sx, sz, sample, g.hmW, g.hmH, 1);
            }
        }
        // The border apron is small (≤ 2·(gw+gh) verts) — just re-derive all
        // of it rather than working out which strip the patch touched.
        for (let k = 0; k < geo.skirtSrc.length; k++) {
            const d = geo.gridVerts + k, src = geo.skirtSrc[k];
            geo.positions[d * 3 + 1] = geo.positions[src * 3 + 1] - geo.skirtDepth;
        }
        copySkirtNormals(geo, s.normals);

        s.mesh.updateVerticesData(VertexBuffer.PositionKind, geo.positions, true);
        s.mesh.updateVerticesData(VertexBuffer.NormalKind, s.normals, false);
    }
}

/** Inclusive grid-index range of the samples in `srcs` (monotonic) that fall
 *  in [lo..hi]; [-1,-2] when none do. */
function gridRange(srcs: Int32Array, lo: number, hi: number): [number, number] {
    let first = -1, last = -2;
    for (let i = 0; i < srcs.length; i++) {
        const v = srcs[i];
        if (v >= lo && v <= hi) {
            if (first < 0) first = i;
            last = i;
        }
    }
    return [first, last];
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

/** Empty the GL error queue so a following `getError()` can only report a call
 *  made after this point. WebGL keeps one error per category, so the queue is
 *  short and bounded; the guard is only there to keep a broken context (which
 *  returns CONTEXT_LOST_WEBGL forever) from spinning. Returns what it drained,
 *  so a caller can report pre-existing damage instead of swallowing it. */
export function drainGlErrors(gl: WebGL2RenderingContext, limit = 16): number[] {
    const drained: number[] = [];
    for (let i = 0; i < limit; i++) {
        const e = gl.getError();
        if (e === gl.NO_ERROR) break;
        drained.push(e);
    }
    return drained;
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
    // `getError` reports the OLDEST error queued anywhere in this context since
    // it was last called, so a single check after the loop attributes an
    // unrelated upstream failure (feature/decal texture work, LuaUI GL) to the
    // atlas. Drain first, then check per level, so the warning names the call
    // that actually failed — pools_of_ilys reported a 0x501 here that survived
    // an exact-dimension replay of all four uploads (PLAN-maps M8g).
    const preExisting = drainGlErrors(gl);
    if (preExisting.length > 0) {
        console.warn(`[terrain] gl error(s) already queued BEFORE the atlas `
            + `upload (not caused by it): `
            + preExisting.map(e => `0x${e.toString(16)}`).join(', '));
    }
    for (let lvl = 0; lvl < numLevels; lvl++) {
        const r = compositeAtlasLevel(
            dims, tileIndex, tilesLevels[lvl],
            TILE_MIP_TEXELS[lvl], TILE_MIP_BYTES[lvl],
            tileX0, tileZ0, tileCountX, tileCountZ);
        gl.compressedTexImage2D(
            gl.TEXTURE_2D, lvl, ext.COMPRESSED_RGB_S3TC_DXT1_EXT,
            r.pageW, r.pageH, 0, r.page);
        const lvlErr = gl.getError();
        if (lvlErr !== gl.NO_ERROR) {
            console.warn(`[terrain] gl error 0x${lvlErr.toString(16)} uploading `
                + `mip ${lvl} of page @(${tileX0},${tileZ0}): `
                + `${r.pageW}x${r.pageH}, ${r.page.length} bytes`);
        }
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
        console.warn(`[terrain] gl error after page sampler state: `
            + `0x${glErr.toString(16)}`);
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
 * Apply the map's ground albedo as ONE map-space texture — PLAN-maps.md §2n
 * ruling 1 (M7f option A), the path a map opts into by declaring
 * `resources.groundtex`.
 *
 * FIDELITY-STANDIN / DEVIATION from Recoil, and the reason it is worth one:
 * Recoil delivers the ground albedo only through the SMF's tile dictionary,
 * and the dictionary terragen writes is a lossy vector quantizer rather than
 * Spring's exact dedup (see `dxt1.cluster_tiles`). M7d measured its seam jump
 * across the 32-elmo tile grid at 15.7x the interior gradient — a visible
 * checkerboard on smooth ground — and M7f measured the replacement: at 2048²
 * a map-space texture reads 1.95 mean levels of error against 2.51, 7.5 % of
 * texels badly wrong against 12.5 %, seam ratio 1.20 against 15.74, in a third
 * of the bytes. Per-texel grain stays the runtime splat layer's job either
 * way. A map that ships an exactly-deduped SMT (every real Spring map) never
 * declares this and keeps the faithful path.
 *
 * The mesh already carries GLOBAL 0..1 map UVs, so the texture needs no
 * remapping: the same UVs that indexed the atlas index this.
 */
export function applyGroundTexture(
    scene: Scene,
    terrain: TerrainMeshGroup,
    groundTexUrl: string,
): void {
    const tex = new Texture(groundTexUrl, scene, false,
        false /* invertY: KTX2 path ignores, raster stays top-down */);
    // Clamp, not wrap: this texture IS the map, and a bilinear tap at the very
    // edge must not fetch the far side of the world.
    tex.wrapU = Texture.CLAMP_ADDRESSMODE;
    tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    applyTerrainDiffuseTexture(scene, terrain, tex);
}

/**
 * Composite DXT1 tiles into per-page atlas textures and apply to terrain.
 * One page for the common case; a MultiMaterial grid for over-cap maps.
 *
 * `groundTexUrl` (PLAN-maps §2n) short-circuits the whole atlas path: a map
 * that ships a map-space ground albedo has no `tiles.ktx2` on the server at
 * all, because MapProcessor stops extracting the tile dictionary for it.
 */
export async function loadTerrainTextures(
    scene: Scene,
    terrain: TerrainMeshGroup,
    mapBaseUrl: string,
    dims: MapDimensions,
    groundTexUrl = '',
): Promise<void> {
    if (groundTexUrl) {
        console.log(`[terrain] map-space ground albedo: ${groundTexUrl} ` +
            `(SMT tile dictionary not delivered for this map)`);
        applyGroundTexture(scene, terrain, groundTexUrl);
        return;
    }

    let gl: WebGL2RenderingContext;
    try { gl = getEngineGl(scene.getEngine() as Engine); } catch { console.warn('[terrain] no WebGL context'); return; }

    const atlas = await buildMapAtlasPages(gl, mapBaseUrl, dims);
    if (!atlas) return;

    if (atlas.pages.length === 1) {
        const p = atlas.pages[0];
        applyWebGLTexture(scene, terrain, p.webglTex, p.width, p.height, p.mipLevels);
    } else {
        applyPagedTextures(scene, terrain, atlas, dims);
    }
}

/**
 * Wrap a raw WebGL texture in a Babylon.js material and apply to mesh.
 * Uses Engine.wrapWebGLTexture() — the supported path for adopting an
 * externally-created GL texture into Babylon's material system.
 */
export function applyWebGLTexture(
    scene: Scene, terrain: TerrainMeshGroup,
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

    applyTerrainDiffuseTexture(scene, terrain, texture);
}

/**
 * Swap the terrain onto a StandardMaterial carrying `texture` as its ground
 * albedo, preserving the material plugins attached to whatever was there
 * before. Shared by the DXT1 atlas path and the map-space ground texture —
 * the two differ only in where the pixels come from, and the plugin-reattach
 * dance below is exactly the part that is easy to get wrong twice.
 */
function applyTerrainDiffuseTexture(
    scene: Scene, terrain: TerrainMeshGroup, texture: Texture,
): void {
    // Remove vertex colours if present (they'd multiply with the sampled
    // diffuse colour and darken the terrain)
    for (const mesh of terrain.allMeshes) {
        if (mesh.isVerticesDataPresent(VertexBuffer.ColorKind)) {
            mesh.removeVerticesData(VertexBuffer.ColorKind);
        }
        mesh.hasVertexAlpha = false;
    }

    const mat = new StandardMaterial('terrainTexMat', scene);
    mat.diffuseTexture = texture;
    mat.diffuseColor = new Color3(1, 1, 1);
    mat.specularColor = new Color3(0.05, 0.05, 0.05);
    mat.backFaceCulling = false;

    // Carry the ground-decal overlay (PLAN-decals.md) onto the new material.
    // The overlay plugin is attached to the *initial* terrain material in
    // main.ts; this textured material is built later (once the ground texture
    // or the map atlas finishes loading) and swapped in here. Without
    // re-attaching, the textured terrain samples no overlay and scars/tracks
    // never render.
    // Anisotropic filtering: the oblique RTS camera samples the ground at
    // grazing angles where trilinear alone blurs badly. 8x per PLAN-maps.md
    // (4x default elsewhere).
    texture.anisotropicFilteringLevel = 8;

    // Chunks share ONE material, so the previous plugin state lives on that
    // one material regardless of how many chunk meshes reference it.
    const prev = terrain.material;
    const prevPlugin = findDecalOverlayPlugin(prev);
    const prevWater = findWaterAbsorptionPlugin(prev);
    const prevSplat = findTerrainSplatPlugin(prev);
    const prevPages = findTerrainPagePlugin(prev);
    terrain.setMaterial(mat);
    prev?.dispose();
    reattachDecalOverlay(mat, prevPlugin);
    reattachWaterAbsorption(mat, prevWater);
    reattachTerrainSplat(mat, prevSplat);
    reattachTerrainPageSample(mat, prevPages);
}

/** Locate the DecalOverlayPlugin attached to a material, if any (first
 *  sub-material for a MultiMaterial — all pages carry the same overlay). */
function findDecalOverlayPlugin(
    mat: Material | null,
): DecalOverlayPlugin | undefined {
    let m: Material | null = mat;
    if (m instanceof MultiMaterial) m = m.subMaterials.find((s) => !!s) ?? null;
    return m && m.pluginManager
        ? (m.pluginManager as unknown as { _plugins?: unknown[] })._plugins
            ?.find((p): p is DecalOverlayPlugin => p instanceof DecalOverlayPlugin)
        : undefined;
}

/** Enable/disable the terrain decal-overlay shader plugin — the PLAN-perf P0
 *  hazard-#1 isolation toggle (the ~10-tap per-fragment decal block). Applies
 *  to every terrain material (all pages). Returns whether any plugin was
 *  found + toggled. */
export function setTerrainDecalPluginEnabled(
    terrain: TerrainMeshGroup | null, on: boolean,
): boolean {
    let found = false;
    for (const mat of terrain?.materials ?? []) {
        const plugin = findDecalOverlayPlugin(mat);
        if (!plugin) continue;
        plugin.isEnabled = on;
        found = true;
    }
    return found;
}

/** Attach the ground-decal overlay (PLAN-decals.md) to every terrain
 *  material. Idempotent — materials that already carry the plugin are left
 *  alone, so the async map-load path can call it more than once. */
export function attachTerrainDecalOverlay(
    terrain: TerrainMeshGroup,
    decals: {
        coarseTexture: Texture; fineTexture: Texture;
        fineState: FineWindowState;
        coarseTexel: number; fineTexel: number;
    },
    worldW: number, worldH: number,
): boolean {
    let attached = false;
    for (const mat of terrain.materials) {
        if (findDecalOverlayPlugin(mat)) continue;
        attachDecalOverlay(mat,
            decals.coarseTexture, decals.fineTexture, decals.fineState,
            decals.coarseTexel, decals.fineTexel, worldW, worldH);
        attached = true;
    }
    return attached;
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
    mat: Material | null,
): WaterAbsorptionPlugin | undefined {
    let m: Material | null = mat;
    if (m instanceof MultiMaterial) m = m.subMaterials.find((s) => !!s) ?? null;
    return m && m.pluginManager
        ? (m.pluginManager as unknown as { _plugins?: unknown[] })._plugins
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

/** Locate the TerrainSplatPlugin on a material (first sub-material for a
 *  MultiMaterial — all pages share the same splat textures). */
function findTerrainSplatPlugin(
    mat: Material | null,
): TerrainSplatPlugin | undefined {
    let m: Material | null = mat;
    if (m instanceof MultiMaterial) m = m.subMaterials.find((s) => !!s) ?? null;
    return m && m.pluginManager
        ? (m.pluginManager as unknown as { _plugins?: unknown[] })._plugins
            ?.find((p): p is TerrainSplatPlugin => p instanceof TerrainSplatPlugin)
        : undefined;
}

/** Re-attach the near-field detail plugin after a material swap (shares
 *  textures). Carries the mode: a plain-detail map must not come back as a
 *  splat map with no textures to sample. */
function reattachTerrainSplat(
    mat: StandardMaterial, prev: TerrainSplatPlugin | undefined,
): void {
    if (!prev) return;
    if (prev.mode === 'plain') {
        if (prev.plainDetailTexture)
            attachTerrainDetailPlain(mat, prev.plainDetailTexture);
        return;
    }
    if (prev.mode === 'splatNormal') {
        if (prev.distrTexture) {
            attachTerrainSplatNormal(
                mat, prev.distrTexture, prev.normalTextures,
                prev.texScales, prev.texMults, prev.diffuseAlpha,
                prev.worldW, prev.worldH);
        }
        return;
    }
    if (prev.distrTexture && prev.detailTexture) {
        attachTerrainSplat(
            mat, prev.distrTexture, prev.detailTexture,
            prev.texScales, prev.texMults, prev.worldW, prev.worldH);
    }
}

/** The decals subset the near-field detail attach needs. */
export interface TerrainDetailDecals {
    detailTex: string;
    splatDetailTex: string;
    splatDistrTex: string;
    splatNormal: [string, string, string, string];
    splatScales: [number, number, number, number];
    splatMults: [number, number, number, number];
    splatDetailNormalDiffuseAlpha: boolean;
}

/**
 * Attach the one near-field detail branch this map's `resources` select, in
 * SMFFragProg.glsl's own precedence. Returns the mode attached, or null when
 * the map declares no detail shading at all.
 *
 * The order is not a preference — it is the shader's `#ifdef` nesting.
 * `SMF_DETAIL_NORMAL_TEXTURE_SPLATTING` wraps the *whole* detail section
 * (SMFFragProg.glsl:311), so on a map that has splat normals,
 * `GetDetailTextureColor` is never called and neither `splatDetailTex` nor
 * `detailTex` is ever sampled. Reproducing only the inner two branches is
 * what caused endtoend **D48**: scorched_crossing declares all three, the
 * client took the splat pair, and that map's `splatDetailTex` alpha is a
 * constant 1.0 — a flat +0.93 added to the ground albedo, i.e. a white void.
 *
 * Keep this the single decision point. Three `if`s at a call site is exactly
 * how the branches drifted apart the first time.
 */
export function attachTerrainDetailFromDecals(
    scene: Scene,
    terrain: TerrainMeshGroup,
    decals: TerrainDetailDecals,
    mapBaseUrl: string,
    dims: MapDimensions,
): TerrainDetailMode | null {
    if (attachTerrainSplatNormalFromDecals(scene, terrain, decals, mapBaseUrl, dims))
        return 'splatNormal';
    if (attachTerrainSplatFromDecals(scene, terrain, decals, mapBaseUrl, dims))
        return 'splat';
    if (attachTerrainDetailPlainFromDecals(scene, terrain, decals, mapBaseUrl))
        return 'plain';
    return null;
}

/** Attach Recoil's splat detail-*normal* shading
 *  (`SMF_DETAIL_NORMAL_TEXTURE_SPLATTING`) — the branch that WINS over
 *  `attachTerrainSplatFromDecals` where a map ships both, because in
 *  SMFFragProg.glsl it wraps the whole detail section and
 *  `GetDetailTextureColor` is then never called. Callers must try this FIRST
 *  (see endtoend D48: taking the splat branch on scorched_crossing sampled a
 *  `splatDetailTex` whose alpha is a constant 1.0 and whitewashed the map).
 *  Returns false when the map ships no distribution map or no normal set. */
export function attachTerrainSplatNormalFromDecals(
    scene: Scene,
    terrain: TerrainMeshGroup,
    decals: {
        splatDistrTex: string;
        splatNormal: [string, string, string, string];
        splatScales: [number, number, number, number];
        splatMults: [number, number, number, number];
        splatDetailNormalDiffuseAlpha: boolean;
    },
    mapBaseUrl: string,
    dims: MapDimensions,
): boolean {
    if (!decals.splatDistrTex) return false;
    if (!decals.splatNormal.some(u => !!u)) return false;
    const resolve = (u: string): string =>
        /^(https?:)?\/\//.test(u) || u.startsWith('/') ? u : `${mapBaseUrl}/${u}`;

    const distr = new Texture(resolve(decals.splatDistrTex), scene,
        false, false /* invertY: KTX2 path ignores, raster stays top-down */);
    distr.wrapU = Texture.CLAMP_ADDRESSMODE;
    distr.wrapV = Texture.CLAMP_ADDRESSMODE;
    distr.anisotropicFilteringLevel = 4;

    // A channel the map does not declare must contribute nothing. Mid-grey
    // (128) is the neutral value for the shader's `tex * 2 - 1`, so one
    // shared 1x1 texel stands in for every absent slot. Recoil leaves the
    // sampler unbound instead, which reads black and drives the channel to
    // -1; that is a Recoil bug, not a behaviour to reproduce.
    let neutral: RawTexture | null = null;
    const normals = decals.splatNormal.map((u) => {
        if (!u) {
            neutral ??= RawTexture.CreateRGBATexture(
                new Uint8Array([128, 128, 128, 128]), 1, 1, scene, false, false,
                Texture.NEAREST_SAMPLINGMODE);
            return neutral;
        }
        const t = new Texture(resolve(u), scene, false, false);
        t.wrapU = Texture.WRAP_ADDRESSMODE;
        t.wrapV = Texture.WRAP_ADDRESSMODE;
        t.anisotropicFilteringLevel = 4;
        return t;
    });

    const worldW = dims.mapx * SQUARE_SIZE;
    const worldH = dims.mapy * SQUARE_SIZE;
    let attached = false;
    for (const m of terrain.materials) {
        if (m instanceof StandardMaterial && !findTerrainSplatPlugin(m)) {
            attachTerrainSplatNormal(m, distr, normals,
                decals.splatScales, decals.splatMults,
                decals.splatDetailNormalDiffuseAlpha, worldW, worldH);
            attached = true;
        }
    }
    return attached;
}

/** Attach Recoil splat-detail shading (PLAN-maps.md §1.2) to a terrain mesh
 *  from the map's decals metadata. Loads splat_distr + splat_detail textures
 *  and attaches the plugin to every material (single or paged); idempotent,
 *  and survives later material swaps via the reattach calls above.
 *  **Try `attachTerrainSplatNormalFromDecals` first** — see its note. */
export function attachTerrainSplatFromDecals(
    scene: Scene,
    terrain: TerrainMeshGroup,
    decals: {
        splatDistrTex: string; splatDetailTex: string;
        splatScales: [number, number, number, number];
        splatMults: [number, number, number, number];
    },
    mapBaseUrl: string,
    dims: MapDimensions,
): boolean {
    if (!decals.splatDistrTex || !decals.splatDetailTex) return false;
    const resolve = (u: string): string =>
        /^(https?:)?\/\//.test(u) || u.startsWith('/') ? u : `${mapBaseUrl}/${u}`;

    const distr = new Texture(resolve(decals.splatDistrTex), scene,
        false, false /* invertY: KTX2 path ignores, raster stays top-down */);
    distr.wrapU = Texture.CLAMP_ADDRESSMODE;
    distr.wrapV = Texture.CLAMP_ADDRESSMODE;
    distr.anisotropicFilteringLevel = 4;
    const detail = new Texture(resolve(decals.splatDetailTex), scene, false, false);
    detail.wrapU = Texture.WRAP_ADDRESSMODE;
    detail.wrapV = Texture.WRAP_ADDRESSMODE;
    detail.anisotropicFilteringLevel = 4;

    const worldW = dims.mapx * SQUARE_SIZE;
    const worldH = dims.mapy * SQUARE_SIZE;
    let attached = false;
    for (const m of terrain.materials) {
        if (m instanceof StandardMaterial && !findTerrainSplatPlugin(m)) {
            attachTerrainSplat(m, distr, detail,
                decals.splatScales, decals.splatMults, worldW, worldH);
            attached = true;
        }
    }
    return attached;
}

/** Attach Recoil's plain-detail shading (`resources.detailTex`) — the other,
 *  mutually exclusive half of `GetDetailTextureColor`
 *  (PLAN-terrain-detailtex.md §2.3). Callers must try
 *  `attachTerrainSplatFromDecals` FIRST and only fall back here: the splat pair
 *  wins where a map declares both, exactly as the shader's `#ifndef` does.
 *  Idempotent, and survives material swaps via `reattachTerrainSplat` (which
 *  carries the mode). Returns false when the map ships no `detailTex`. */
export function attachTerrainDetailPlainFromDecals(
    scene: Scene,
    terrain: TerrainMeshGroup,
    decals: { detailTex: string },
    mapBaseUrl: string,
): boolean {
    if (!decals.detailTex) return false;
    const url = /^(https?:)?\/\//.test(decals.detailTex) || decals.detailTex.startsWith('/')
        ? decals.detailTex : `${mapBaseUrl}/${decals.detailTex}`;

    const detail = new Texture(url, scene,
        false, false /* invertY: KTX2 path ignores, raster stays top-down */);
    detail.wrapU = Texture.WRAP_ADDRESSMODE;
    detail.wrapV = Texture.WRAP_ADDRESSMODE;
    detail.anisotropicFilteringLevel = 4;

    let attached = false;
    for (const m of terrain.materials) {
        if (m instanceof StandardMaterial && !findTerrainSplatPlugin(m)) {
            attachTerrainDetailPlain(m, detail);
            attached = true;
        }
    }
    return attached;
}

/** Enable/disable the near-field terrain detail plugin (either mode) on every
 *  terrain material — the A/B hook the acceptance shots in
 *  PLAN-terrain-detailtex.md §4 need, since CDP screenshots cannot see the
 *  WebGL2 canvas. Returns whether any plugin was found + toggled. */
export function setTerrainDetailPluginEnabled(
    terrain: TerrainMeshGroup | null, on: boolean,
): boolean {
    let found = false;
    for (const mat of terrain?.materials ?? []) {
        const plugin = findTerrainSplatPlugin(mat);
        if (!plugin) continue;
        plugin.isEnabled = on;
        found = true;
    }
    return found;
}

/** Locate the TerrainPageSamplePlugin on a material (first sub-material for a
 *  MultiMaterial — all pages share one page cache). */
function findTerrainPagePlugin(
    mat: Material | null,
): TerrainPageSamplePlugin | undefined {
    let m: Material | null = mat;
    if (m instanceof MultiMaterial) m = m.subMaterials.find((s) => !!s) ?? null;
    return m && m.pluginManager
        ? (m.pluginManager as unknown as { _plugins?: unknown[] })._plugins
            ?.find((p): p is TerrainPageSamplePlugin =>
                p instanceof TerrainPageSamplePlugin)
        : undefined;
}

/** Re-attach the page-sample plugin after a material swap (shares the page
 *  array + table textures — the cache behind them is untouched). Carries the
 *  enabled state so a disabled A/B arm does not come back on. */
function reattachTerrainPageSample(
    mat: StandardMaterial, prev: TerrainPageSamplePlugin | undefined,
): void {
    if (!prev || !prev.atlasTexture || !prev.tableTexture) return;
    const plugin = attachTerrainPageSample(
        mat, prev.atlasTexture, prev.tableTexture, prev.geometry);
    plugin.isEnabled = prev.isEnabled;
}

/** Attach the streaming page-sample plugin (PLAN-maps.md §1.2.1) to every
 *  StandardMaterial the terrain currently carries. Survives later material
 *  swaps via the reattach calls in applyTerrainDiffuseTexture /
 *  applyPagedTextures. Idempotent. */
export function attachTerrainPageSampleToTerrain(
    terrain: TerrainMeshGroup,
    atlas: BaseTexture, table: BaseTexture, geometry: PageSampleGeometry,
): boolean {
    let attached = false;
    for (const m of terrain.materials) {
        if (m instanceof StandardMaterial && !findTerrainPagePlugin(m)) {
            attachTerrainPageSample(m, atlas, table, geometry);
            attached = true;
        }
    }
    return attached;
}

/** Enable/disable the streaming page-sample plugin on every terrain material
 *  — the streaming A/B arm. ⚠ The property is `isEnabled`, not `enabled`;
 *  returns whether any plugin was found + toggled so a zero-delta reading
 *  can be distinguished from a toggle that never took (M8i). */
export function setTerrainPagePluginEnabled(
    terrain: TerrainMeshGroup | null, on: boolean,
): boolean {
    let found = false;
    for (const mat of terrain?.materials ?? []) {
        const plugin = findTerrainPagePlugin(mat);
        if (!plugin) continue;
        plugin.isEnabled = on;
        found = true;
    }
    return found;
}

/** Attach the underwater terrain-absorption tint (Recoil SMF
 *  `SMF_WATER_ABSORPTION`) to a terrain mesh's material(s) — handles both the
 *  single-material and paged MultiMaterial forms, and survives later material
 *  swaps via the reattach calls in applyTexture / applyPagedTextures. No-op if
 *  already attached (idempotent for the async mapinfo-parse → attach path). */
export function attachTerrainWaterAbsorption(
    terrain: TerrainMeshGroup, colors: MapWaterAbsorption,
): void {
    for (const m of terrain.materials) {
        if (m instanceof StandardMaterial && !findWaterAbsorptionPlugin(m)) {
            attachWaterAbsorption(m, colors);
        }
    }
}

/**
 * Apply a paged DXT1 atlas (over-cap maps) as a MultiMaterial shared by every
 * terrain chunk. Chunks keep their global 0..1 map UVs; each page
 * sub-material remaps that range onto its texture via Texture
 * `uScale/uOffset`, and each chunk's triangles are regrouped into one SubMesh
 * per page it overlaps (a chunk usually falls entirely inside one page, in
 * which case it ends up with exactly one SubMesh; chunks straddling a page
 * boundary get one SubMesh per page they touch).
 *
 * One MultiMaterial for the whole terrain means lighting, CSM shadows, the
 * decal overlay, the splat plugin, picking and DeformableTerrain all keep
 * working unchanged — only the draw is split by texture page.
 */
function applyPagedTextures(
    scene: Scene, terrain: TerrainMeshGroup, atlas: MapAtlasPages, dims: MapDimensions,
): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const engine = scene.getEngine() as any;

    for (const mesh of terrain.allMeshes) {
        if (mesh.isVerticesDataPresent(VertexBuffer.ColorKind)) {
            mesh.removeVerticesData(VertexBuffer.ColorKind);
        }
        mesh.hasVertexAlpha = false;
    }

    const prevMat = terrain.material;
    const prevPlugin = findDecalOverlayPlugin(prevMat);
    const prevWater = findWaterAbsorptionPlugin(prevMat);
    const prevSplat = findTerrainSplatPlugin(prevMat);
    const prevPages = findTerrainPagePlugin(prevMat);

    const numPages = atlas.pagesX * atlas.pagesZ;
    const pageOf = (cu: number, cv: number): number => {
        let px = Math.floor((cu * dims.tilesX) / atlas.pageTilesX);
        let pz = Math.floor((cv * dims.tilesZ) / atlas.pageTilesZ);
        px = Math.min(Math.max(px, 0), atlas.pagesX - 1);
        pz = Math.min(Math.max(pz, 0), atlas.pagesZ - 1);
        return pz * atlas.pagesX + px;
    };

    // Regroup each surface's triangles by which page their UV centroid falls
    // in, so every page becomes a contiguous SubMesh index range on that mesh.
    let submeshCount = 0;
    for (const s of terrain.surfaces) {
        const geo = s.geo;
        const uvs = geo.uvs;
        const numVerts = uvs.length / 2;
        const oldIdx = geo.indices;
        const buckets: number[][] = Array.from({ length: numPages }, () => []);
        for (let t = 0; t < oldIdx.length; t += 3) {
            const a = oldIdx[t], b = oldIdx[t + 1], c = oldIdx[t + 2];
            const cu = (uvs[a * 2] + uvs[b * 2] + uvs[c * 2]) / 3;
            const cv = (uvs[a * 2 + 1] + uvs[b * 2 + 1] + uvs[c * 2 + 1]) / 3;
            buckets[pageOf(cu, cv)].push(a, b, c);
        }

        const newIdx = oldIdx instanceof Uint16Array
            ? new Uint16Array(oldIdx.length) : new Uint32Array(oldIdx.length);
        const ranges: { page: number; start: number; count: number }[] = [];
        let cursor = 0;
        for (let p = 0; p < numPages; p++) {
            const b = buckets[p];
            if (b.length > 0) ranges.push({ page: p, start: cursor, count: b.length });
            newIdx.set(b, cursor);
            cursor += b.length;
        }
        geo.indices = newIdx;
        s.mesh.setIndices(newIdx, numVerts);
        s.mesh.subMeshes = [];
        for (const r of ranges) {
            new SubMesh(r.page, 0, numVerts, r.start, r.count, s.mesh);
        }
        submeshCount += ranges.length;
    }

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
        texture.anisotropicFilteringLevel = 8;

        const mat = new StandardMaterial(`terrainTexMat_${p}`, scene);
        mat.diffuseTexture = texture;
        mat.diffuseColor = new Color3(1, 1, 1);
        mat.specularColor = new Color3(0.05, 0.05, 0.05);
        mat.backFaceCulling = false;
        reattachDecalOverlay(mat, prevPlugin);
        reattachWaterAbsorption(mat, prevWater);
        reattachTerrainSplat(mat, prevSplat);
        reattachTerrainPageSample(mat, prevPages);
        multi.subMaterials[p] = mat;
    }
    terrain.setMaterial(multi);
    prevMat?.dispose();

    console.log(`[terrain] applied ${submeshCount} page submesh(es) across ` +
        `${terrain.surfaces.length} surface(s) (${atlas.pagesX}x${atlas.pagesZ} grid)`);
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
        // The world-space FOG_Y_OFFSET alone cannot beat z-buffer precision
        // at strategic zoom: with minZ=1 the resolvable depth delta at a
        // fitMap camera (~20k elmos up) is ~25 elmos, so an 8-elmo lift
        // z-fights and the overlay renders as horizontal streak bands
        // (visible in the pre-2026-07-27 Meridian Basin goldens). A
        // polygon-offset depth bias scales with depth quantization, so it
        // holds at every zoom; the overlay is the last blended draw of its
        // rendering group and writes no depth, so pulling it toward the
        // camera cannot occlude anything else.
        mat.zOffset = -16;
        mat.zOffsetUnits = -128;
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
