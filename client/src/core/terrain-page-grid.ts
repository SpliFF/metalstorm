/**
 * Terrain page grid — the address space of PLAN-maps.md §1.2 v2 streaming.
 *
 * The map's ground albedo is one virtual texture at 1 texel/elmo (a 16 384-elmo
 * map is a 16 384² virtual image; §2n ruling 1 ships the *whole* thing as a
 * single 2048² map-space texture today, which is the same image at level 5 of
 * the pyramid this module describes). Streaming v2 stops materialising that
 * image and instead cuts it into **pages**, of which only a bounded working set
 * is ever resident.
 *
 * Conventions, all of which the rest of the streaming code depends on:
 *
 * - **Level 0 is the finest** (1 texel/elmo); level `L` has texels `2^L` elmos
 *   wide, so a page at level `L` covers `PAGE_PAYLOAD_TEXELS << L` elmos. The
 *   coarsest level is the one whose grid is 1×1 — the whole map in one page.
 * - **The pyramid IS the mip chain.** Pages carry no internal mip levels.
 *   The shader picks the pyramid level from the same screen-space derivative it
 *   would have used to pick a mip, and blends between a page and its parent —
 *   which is the *identical* machinery as the parent-UV fallback for a page
 *   that has not arrived yet. One mechanism, two jobs; see
 *   `terrain-page-cache.ts`.
 * - A page therefore over-minifies by at most one level between pyramid steps,
 *   which a **4-texel (1 BC1 block) border** covers, along with the bilinear tap
 *   at the payload edge. Payload 512² + 4 on every side = a 520² physical page.
 *   520 = 4×130, so every dimension and offset stays BC1-block-aligned, which
 *   `compressedTexSubImage3D` requires.
 *
 * Nothing here touches GL or Babylon: the whole address space is arithmetic, so
 * the paging, the fallback chain and the residency policy are unit-testable
 * without a GPU. The GL layer is a thin consumer (see the DIVERGENCE note in
 * `terrain-page-cache.ts`).
 */

/** Unique texels one page owns per axis. */
export const PAGE_PAYLOAD_TEXELS = 512;
/** Border texels replicated on every side (1 BC1 block: bilinear + 1 mip). */
export const PAGE_BORDER_TEXELS = 4;
/** Stored page size per axis, border included. Must be a multiple of 4. */
export const PAGE_PHYSICAL_TEXELS = PAGE_PAYLOAD_TEXELS + 2 * PAGE_BORDER_TEXELS;
/** BC1 (DXT1) is 8 bytes per 4×4 block = 0.5 bytes/texel. */
export const BC1_BLOCK_BYTES = 8;
/** Bytes one stored page occupies, in the cache and on the wire. */
export const PAGE_BYTES =
    (PAGE_PHYSICAL_TEXELS / 4) * (PAGE_PHYSICAL_TEXELS / 4) * BC1_BLOCK_BYTES;

/** Resident-cache byte budget (PLAN-maps.md §1.2 v2: "~96 MB resident"). */
export const DEFAULT_CACHE_BYTES = 96 * 1024 * 1024;

/** A page address. `level` 0 is the finest; `x`/`z` index that level's grid. */
export interface PageId {
    readonly level: number;
    readonly x: number;
    readonly z: number;
}

/** One pyramid level's grid dimensions. */
export interface PageLevel {
    readonly level: number;
    readonly pagesX: number;
    readonly pagesZ: number;
    /** World extent (elmos) one page covers per axis at this level. */
    readonly pageElmos: number;
    /** World extent (elmos) one texel covers at this level. */
    readonly texelElmos: number;
}

/** The full page pyramid for one map. */
export interface PageGrid {
    /** Map extent in elmos (X, Z). */
    readonly mapElmosX: number;
    readonly mapElmosZ: number;
    /** Virtual texture extent in texels at level 0. */
    readonly texelsX: number;
    readonly texelsZ: number;
    /** Elmos per level-0 texel (1.0 for the §1.2 "1 texel/elmo" target). */
    readonly elmosPerTexel: number;
    /** Index `i` is level `i`; the last entry is the 1×1 root. */
    readonly levels: readonly PageLevel[];
    /** Level index of the 1×1 root page. */
    readonly rootLevel: number;
    /** Total pages across every level. */
    readonly totalPages: number;
}

/**
 * Build the page pyramid for a map `mapElmosX × mapElmosZ` elmos wide, at
 * `texelsPerElmo` texels per elmo (1 = the §1.2 target residency).
 *
 * Levels are generated until one page covers the map. A degenerate map (zero
 * or negative extent) still yields a single 1×1 root level, so callers never
 * have to special-case an empty pyramid.
 */
export function planPageGrid(
    mapElmosX: number, mapElmosZ: number, texelsPerElmo = 1,
): PageGrid {
    const ex = Math.max(1, Math.floor(mapElmosX));
    const ez = Math.max(1, Math.floor(mapElmosZ));
    const tpe = texelsPerElmo > 0 ? texelsPerElmo : 1;
    const texelsX = Math.max(1, Math.ceil(ex * tpe));
    const texelsZ = Math.max(1, Math.ceil(ez * tpe));
    const elmosPerTexel = 1 / tpe;

    const levels: PageLevel[] = [];
    let total = 0;
    for (let level = 0; ; level++) {
        const texelsPerPage = PAGE_PAYLOAD_TEXELS * Math.pow(2, level);
        const pagesX = Math.max(1, Math.ceil(texelsX / texelsPerPage));
        const pagesZ = Math.max(1, Math.ceil(texelsZ / texelsPerPage));
        levels.push({
            level, pagesX, pagesZ,
            pageElmos: texelsPerPage * elmosPerTexel,
            texelElmos: Math.pow(2, level) * elmosPerTexel,
        });
        total += pagesX * pagesZ;
        if (pagesX === 1 && pagesZ === 1) break;
        // Guard against a pathological texelsPerElmo producing an endless
        // pyramid; 24 levels is 512 * 2^24 texels, far past any real map.
        if (level > 24) break;
    }
    return {
        mapElmosX: ex, mapElmosZ: ez, texelsX, texelsZ, elmosPerTexel,
        levels, rootLevel: levels.length - 1, totalPages: total,
    };
}

/**
 * Pack a page address into one integer, so the cache can key Maps/Sets on a
 * primitive rather than an object identity. Layout: `level` in bits 28-31,
 * `z` in 14-27, `x` in 0-13 — 16 384 pages per axis is 8.4 M elmos, well past
 * any map, and the whole key stays inside a 32-bit signed int.
 */
export function pageKey(level: number, x: number, z: number): number {
    return (level << 28) | (z << 14) | x;
}

/** Inverse of `pageKey`. */
export function decodePageKey(key: number): PageId {
    return { level: (key >>> 28) & 0xf, z: (key >>> 14) & 0x3fff, x: key & 0x3fff };
}

/** `pageKey` for a `PageId`. */
export function keyOf(id: PageId): number { return pageKey(id.level, id.x, id.z); }

/** True if `id` addresses a page that exists in `grid`. */
export function isValidPage(grid: PageGrid, id: PageId): boolean {
    if (id.level < 0 || id.level >= grid.levels.length) return false;
    const L = grid.levels[id.level];
    return id.x >= 0 && id.z >= 0 && id.x < L.pagesX && id.z < L.pagesZ;
}

/**
 * The page one level coarser covering the same ground, or `null` at the root.
 * This is the single step of the fallback chain: a page that is not resident
 * defers to its parent, recursively, and the root is always kept resident so
 * the chain can never run dry (see `TerrainPageCache`).
 */
export function parentPage(grid: PageGrid, id: PageId): PageId | null {
    if (id.level >= grid.rootLevel) return null;
    return { level: id.level + 1, x: id.x >> 1, z: id.z >> 1 };
}

/** Walk `parentPage` from `id` (exclusive) up to the root (inclusive). */
export function ancestorsOf(grid: PageGrid, id: PageId): PageId[] {
    const out: PageId[] = [];
    let p = parentPage(grid, id);
    while (p) { out.push(p); p = parentPage(grid, p); }
    return out;
}

/** World-space XZ rectangle (elmos) a page covers, clipped to the map. */
export interface PageRect { x0: number; x1: number; z0: number; z1: number; }

/**
 * World rectangle of a page. Edge pages are clipped to the map, so the rect is
 * what the *terrain* occupies; the stored page is always a full
 * `PAGE_PHYSICAL_TEXELS²` regardless (the surplus is padding, and the sample
 * transform below deliberately ignores the clip so UVs stay a pure power-of-two
 * subdivision).
 */
export function pageWorldRect(grid: PageGrid, id: PageId): PageRect {
    const L = grid.levels[id.level];
    const x0 = id.x * L.pageElmos;
    const z0 = id.z * L.pageElmos;
    return {
        x0, z0,
        x1: Math.min(x0 + L.pageElmos, grid.mapElmosX),
        z1: Math.min(z0 + L.pageElmos, grid.mapElmosZ),
    };
}

/**
 * How the shader turns a global 0..1 map UV into a UV inside a page's payload:
 * `payloadU = mapU * scaleU - offU`, likewise V. Physical (border-inclusive)
 * UV is then `(PAGE_BORDER_TEXELS + payloadU * PAGE_PAYLOAD_TEXELS) /
 * PAGE_PHYSICAL_TEXELS`, which `physicalUvOfPayload` applies.
 *
 * The terrain mesh already carries global 0..1 map UVs (see `terrain.ts`
 * `buildTerrainMesh`), so this is the *only* remapping streaming needs — the
 * same property that let §2n's single map-space ground texture drop in without
 * touching the mesh.
 */
export interface PageSampleTransform {
    scaleU: number; scaleV: number; offU: number; offV: number;
}

export function pageSampleTransform(grid: PageGrid, id: PageId): PageSampleTransform {
    const L = grid.levels[id.level];
    return {
        scaleU: grid.mapElmosX / L.pageElmos,
        scaleV: grid.mapElmosZ / L.pageElmos,
        offU: id.x,
        offV: id.z,
    };
}

/** Payload UV (0..1 within a page's unique texels) → physical page UV. */
export function physicalUvOfPayload(uv: number): number {
    return (PAGE_BORDER_TEXELS + uv * PAGE_PAYLOAD_TEXELS) / PAGE_PHYSICAL_TEXELS;
}

/** The page at `level` containing world point (x, z), clamped to the grid. */
export function pageAt(grid: PageGrid, level: number, x: number, z: number): PageId {
    const li = Math.min(Math.max(level, 0), grid.rootLevel);
    const L = grid.levels[li];
    return {
        level: li,
        x: Math.min(L.pagesX - 1, Math.max(0, Math.floor(x / L.pageElmos))),
        z: Math.min(L.pagesZ - 1, Math.max(0, Math.floor(z / L.pageElmos))),
    };
}

/**
 * How many `TEXTURE_2D_ARRAY` layers the physical cache gets: the byte budget
 * divided by the page size, clamped by the driver's `MAX_ARRAY_TEXTURE_LAYERS`.
 *
 * ⚠ The clamp is not theoretical. WebGL2's *guaranteed* minimum for
 * `MAX_ARRAY_TEXTURE_LAYERS` is **256**, and 256 layers is only 33 MB of the
 * 96 MB budget §1.2 asks for. On such a device the cache is a third the size
 * and the fallback chain does more of the work — it degrades, it does not fail,
 * which is exactly why the parent-UV fallback is not optional.
 */
export function residentLayerBudget(
    byteBudget = DEFAULT_CACHE_BYTES, maxArrayLayers = 2048,
): number {
    const byBytes = Math.floor(byteBudget / PAGE_BYTES);
    return Math.max(1, Math.min(byBytes, Math.max(1, Math.floor(maxArrayLayers))));
}
