/**
 * HTTP `PageSource` — the real page producer's client half (PLAN-maps.md
 * §1.2.1 streaming v2, format v19).
 *
 * The server (Server/TerrainPages.h, invoked by MapProcessor through
 * `textureconverter --terrain-pages`) cuts a map's ground albedo into the
 * 520² BC1 page pyramid and ships two files in the processed map dir:
 *
 *   ground_pages.json   the self-describing index (this module validates it
 *                       against the client's own `planPageGrid` — a mismatch
 *                       refuses to stream rather than sampling garbage)
 *   ground_pages.bin    pages back to back, `PAGE_BYTES` each, levels
 *                       ascending from `finestLevel`, rows z-major / x-minor
 *
 * Discovery is a file convention, not a protocol field: fetch
 * `<mapDataUrl>/ground_pages.json`, and a 404 means the map ships no pages
 * (real Spring maps, which deliver ground colour through the SMT tile
 * dictionary — §2n option B's compositor would slot in here instead).
 *
 * One page is one HTTP **Range** request (135 200 bytes). The dev static
 * server and any production CDN answer 206; a server that ignores Range and
 * answers 200 with the whole file degrades gracefully — the body is fetched
 * once, kept, and sliced locally. Byte offsets mirror
 * `TerrainPages::PageByteOffset` exactly; tests/test_terrain_pages.cpp pins
 * the same numbers from the producing side.
 *
 * ⚠ The index's `finestLevel` is ALSO the visible-set clamp
 * (`VisiblePagesOptions.minLevel`): the source resolution is still 2048²
 * (§2n option A), so a 16 k map's levels 0-2 do not exist on disk — pages
 * finer than the source are not fabricated as upsampled blur, the descent
 * just stops at the level that carries real texels. Raising the source
 * resolution (lane queue item 3) shrinks `finestLevel` with no format change.
 */

import { PAGE_BYTES, type PageGrid, type PageId } from './terrain-page-grid.js';
import type { PageSource } from './terrain-page-cache.js';

/** One level of the on-disk pyramid, as `ground_pages.json` declares it. */
export interface GroundPagesLevel {
    level: number;
    pagesX: number;
    pagesZ: number;
    firstPage: number;
}

/** The parsed `ground_pages.json` index (Server/TerrainPages.h IndexJson). */
export interface GroundPagesIndex {
    version: number;
    pageBytes: number;
    payloadTexels: number;
    borderTexels: number;
    mapElmosX: number;
    mapElmosZ: number;
    sourceW: number;
    sourceH: number;
    finestLevel: number;
    rootLevel: number;
    totalPages: number;
    /** Producer timestamp — busts the Cache-API disk tier on reprocess. */
    stamp: number;
    levels: GroundPagesLevel[];
}

/**
 * Validate a fetched index against the client's own pyramid plan for the
 * same map. Returns an error string (for the debug handle to surface) or
 * null when the index is usable. A failed validation means the on-disk
 * format and this client disagree — streaming must refuse, not guess.
 */
export function validateGroundPagesIndex(
    idx: GroundPagesIndex, grid: PageGrid,
): string | null {
    if (idx.version !== 1) return `index version ${idx.version} (want 1)`;
    if (idx.pageBytes !== PAGE_BYTES) {
        return `pageBytes ${idx.pageBytes} (client expects ${PAGE_BYTES})`;
    }
    if (idx.mapElmosX !== grid.mapElmosX || idx.mapElmosZ !== grid.mapElmosZ) {
        return `map extent ${idx.mapElmosX}x${idx.mapElmosZ} `
            + `(grid says ${grid.mapElmosX}x${grid.mapElmosZ})`;
    }
    if (idx.rootLevel !== grid.rootLevel) {
        return `rootLevel ${idx.rootLevel} (grid says ${grid.rootLevel})`;
    }
    if (!Array.isArray(idx.levels) || idx.levels.length === 0) {
        return 'no levels';
    }
    let expectFirst = 0;
    for (const lv of idx.levels) {
        const g = grid.levels[lv.level];
        if (!g) return `level ${lv.level} outside the grid`;
        if (g.pagesX !== lv.pagesX || g.pagesZ !== lv.pagesZ) {
            return `level ${lv.level} is ${lv.pagesX}x${lv.pagesZ} `
                + `(grid says ${g.pagesX}x${g.pagesZ})`;
        }
        if (lv.firstPage !== expectFirst) {
            return `level ${lv.level} firstPage ${lv.firstPage} `
                + `(expected ${expectFirst})`;
        }
        expectFirst += lv.pagesX * lv.pagesZ;
    }
    if (idx.totalPages !== expectFirst) {
        return `totalPages ${idx.totalPages} (levels sum to ${expectFirst})`;
    }
    if (idx.levels[0].level !== idx.finestLevel) {
        return `finestLevel ${idx.finestLevel} but first level is `
            + `${idx.levels[0].level}`;
    }
    return null;
}

/**
 * Fetch and parse `<mapDataUrl>/ground_pages.json`. Resolves null when the
 * map ships no pages (404 / network refusal) — that is the normal case for
 * every real Spring map, not an error.
 */
export async function fetchGroundPagesIndex(
    mapDataUrl: string, fetchFn: typeof fetch = fetch,
): Promise<GroundPagesIndex | null> {
    try {
        const res = await fetchFn(`${mapDataUrl}/ground_pages.json`);
        if (!res.ok) return null;
        return await res.json() as GroundPagesIndex;
    } catch {
        return null;
    }
}

/** Byte offset of one page inside ground_pages.bin — the mirror of
 *  `TerrainPages::PageByteOffset`, or null when the page is not on disk. */
export function groundPageByteOffset(
    idx: GroundPagesIndex, id: PageId,
): number | null {
    if (id.level < idx.finestLevel || id.level > idx.rootLevel) return null;
    const lv = idx.levels[id.level - idx.finestLevel];
    if (!lv || id.x < 0 || id.z < 0 || id.x >= lv.pagesX || id.z >= lv.pagesZ) {
        return null;
    }
    return (lv.firstPage + id.z * lv.pagesX + id.x) * idx.pageBytes;
}

/**
 * The Range-request `PageSource` over `ground_pages.bin`. Wrap it in
 * `withPageDiskCache` at the call site — the disk tier is policy the caller
 * owns, and `sourceId` already carries the producer stamp so a reprocessed
 * map does not serve stale cached pages.
 */
export class HttpPageSource implements PageSource {
    readonly sourceId: string;
    private readonly binUrl: string;
    /** Set after the first 200-instead-of-206 answer: the whole file, fetched
     *  once and sliced locally (a static server without Range support). */
    private wholeFile: Promise<ArrayBuffer> | null = null;

    private readonly fetchFn: typeof fetch;

    constructor(
        mapDataUrl: string,
        private readonly index: GroundPagesIndex,
        fetchFn?: typeof fetch,
    ) {
        this.binUrl = `${mapDataUrl}/ground_pages.bin`;
        this.sourceId = `${this.binUrl}@${index.stamp}`;
        // Wrapped, not stored bare: calling a bare `fetch` reference through
        // `this.fetchFn(...)` rebinds its receiver to this object, which the
        // native fetch rejects with "Illegal invocation".
        this.fetchFn = fetchFn ?? ((...a) => fetch(...a));
    }

    async load(id: PageId, signal: AbortSignal): Promise<Uint8Array> {
        const off = groundPageByteOffset(this.index, id);
        if (off === null) {
            // The visible set is clamped to finestLevel, so a request outside
            // the produced pyramid is a wiring bug, not a soft miss.
            throw new Error(`terrain page L${id.level} (${id.x},${id.z}) `
                + `is outside the produced pyramid `
                + `(levels ${this.index.finestLevel}..${this.index.rootLevel})`);
        }
        if (this.wholeFile) return this.slice(await this.wholeFile, off, id);

        const res = await this.fetchFn(this.binUrl, {
            signal,
            headers: { Range: `bytes=${off}-${off + PAGE_BYTES - 1}` },
        });
        if (res.status === 206) {
            const buf = await res.arrayBuffer();
            if (buf.byteLength !== PAGE_BYTES) {
                throw new Error(`terrain page range answer is `
                    + `${buf.byteLength} bytes (want ${PAGE_BYTES})`);
            }
            return new Uint8Array(buf);
        }
        if (res.ok) {
            // Range ignored: take the whole file once, slice locally from
            // then on. Kept as a promise so concurrent loads share the fetch.
            this.wholeFile ??= Promise.resolve(res.arrayBuffer());
            return this.slice(await this.wholeFile, off, id);
        }
        throw new Error(`terrain page fetch failed: HTTP ${res.status}`);
    }

    private slice(buf: ArrayBuffer, off: number, id: PageId): Uint8Array {
        if (buf.byteLength < off + PAGE_BYTES) {
            throw new Error(`ground_pages.bin is ${buf.byteLength} bytes — `
                + `too short for page L${id.level} (${id.x},${id.z}) `
                + `at offset ${off}`);
        }
        return new Uint8Array(buf.slice(off, off + PAGE_BYTES));
    }
}
