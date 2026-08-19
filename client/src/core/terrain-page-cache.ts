/**
 * Terrain page cache — residency, scheduling and the fallback chain of
 * PLAN-maps.md §1.2 v2 streaming.
 *
 * Three things live here, all of them pure bookkeeping:
 *
 * 1. **Physical residency.** A fixed set of `TEXTURE_2D_ARRAY` layers (see
 *    `residentLayerBudget`) with an LRU eviction policy. The root page is
 *    pinned, so the fallback chain can never run dry, and a page in the current
 *    desired set is never evicted — eviction of a *visible* page is the one
 *    case the cross-fade cannot hide, because the finer texels are gone by the
 *    time the entry changes.
 * 2. **Scheduling.** Cesium-style priority groups over the visible set, a
 *    bounded number of in-flight loads, and `AbortController` cancellation for
 *    every request the camera has moved past. A request that is still queued is
 *    simply dropped; one already in flight is aborted, which is what stops a
 *    fast camera sweep from spending the whole connection on ground it has
 *    already left.
 * 3. **The page table** (indirection texture). One entry per *finest-level*
 *    page holding the best resident ancestor, the next-best after that, and a
 *    cross-fade weight. A 16 384-elmo map has a 32×32 level-0 grid — 1 024
 *    entries — so the table is rebuilt whole whenever residency changes rather
 *    than patched, and the whole thing is an 8 KB upload.
 *
 * ⚠ **DIVERGENCE (recorded per AGENTS.md "never deviate from Recoil silently"),
 * and §1.2 flags it in advance: the physical cache is filled with raw
 * `gl.compressedTexSubImage3D`.** Babylon 9 has no public API for a partial
 * update of a compressed 2D-array texture — `RawTexture2DArray.CreateRGBA...`
 * takes uncompressed data and `updateTexture` has no compressed-subimage path —
 * so the upload has to reach through `engine._gl` exactly as `terrain.ts`
 * already does for `compressedTexImage2D` on the DXT1 atlas, and the resulting
 * texture is adopted with `Engine.wrapWebGLTexture`. That is the *supported*
 * seam for an externally-created texture; the sub-image call is the divergence.
 * It is deliberately not in this module: everything here is testable without a
 * GPU, and the GL layer is the `PageUploader` interface below.
 *
 * ⚠ **This is also the seam that keeps §2n's option B alive.** §2n defers exact
 * per-tile dedup (the Spring-faithful ~178 MB ground texture) rather than
 * rejecting it, on the grounds that it "becomes viable per-page once streaming
 * exists". It does so *only* if the thing that produces page bytes is an
 * interface rather than a URL slice — which is why `PageSource` exists. Option
 * A's source slices a map-space BC1 pyramid; option B's source composites the
 * 256 deduped 32² SMT tiles that fall under a 512² page. Same cache, same
 * visible set, same fallback chain. The honest limit is recorded on
 * `PageSource` itself.
 */

import {
    type PageGrid, type PageId, PAGE_BYTES, keyOf, pageKey, parentPage,
} from './terrain-page-grid.js';
import type { DesiredPage } from './terrain-page-visibility.js';

/**
 * Where page bytes come from. One `PAGE_BYTES`-long BC1 buffer for the
 * physical page (payload + border), ready for `compressedTexSubImage3D`.
 *
 * **Option B (§2n exact dedup) plugs in here and nowhere else** — its
 * implementation composites the deduped SMT tiles covering the page instead of
 * slicing a baked image. What this design does *not* yet provide for B is a
 * second residency tier for the dictionary itself: B's ~178 MB is the tile
 * dictionary, and a per-page compositor needs the 256 tiles under its page to
 * be reachable without the whole dictionary in memory. That is a
 * `PageSource`-internal problem (a ranged fetch or a chunked dictionary), not a
 * cache problem — but it is real work, and it is not done here.
 */
export interface PageSource {
    /** Stable identity for the disk tier's cache namespace. */
    readonly sourceId: string;
    load(id: PageId, signal: AbortSignal): Promise<Uint8Array>;
}

/** The GL seam — see the DIVERGENCE note above. */
export interface PageUploader {
    /** Write one physical page's BC1 bytes into array layer `layer`. */
    uploadLayer(layer: number, bytes: Uint8Array): void;
}

/**
 * Cesium-style priority groups. Lower is more urgent; requests are issued in
 * group order and aborted when they fall out of the set entirely.
 */
export const enum PageGroup {
    /** Visible, and no ancestor is resident: the frame has a hole here. */
    Hole = 0,
    /** Visible, an ancestor covers it: refinement, the frame is merely blurry. */
    Refine = 1,
    /** Only in the predicted (padded-frustum) set. */
    Predict = 2,
}

export interface TerrainPageCacheOptions {
    /** Physical layers available — `residentLayerBudget()`. */
    maxLayers: number;
    source: PageSource;
    uploader?: PageUploader;
    /** Concurrent in-flight loads. Cesium-ish default; the browser's own
     *  per-origin cap does the rest. */
    maxConcurrent?: number;
    /** Cross-fade duration (ms) from the fallback sample to a page that has
     *  just landed. */
    fadeMs?: number;
}

/** Bytes per page-table entry (two RGBA8 texels: primary, then fallback). */
export const PAGE_TABLE_ENTRY_BYTES = 8;

const DEFAULT_MAX_CONCURRENT = 6;
const DEFAULT_FADE_MS = 250;

interface ResidentEntry {
    key: number;
    id: PageId;
    layer: number;
    lastUsedFrame: number;
    /** When the page landed, for the cross-fade. */
    arrivedMs: number;
    pinned: boolean;
}

export interface PageCacheStats {
    resident: number;
    maxLayers: number;
    inflight: number;
    queued: number;
    /** Cumulative counters, for a HUD or a bench arm. */
    loaded: number;
    aborted: number;
    failed: number;
    evicted: number;
    /** Desired-but-not-resident pages in the last `update`, by group. */
    holes: number;
}

export class TerrainPageCache {
    readonly grid: PageGrid;
    private readonly opts: Required<Omit<TerrainPageCacheOptions, 'uploader'>>
        & { uploader?: PageUploader };

    private readonly resident = new Map<number, ResidentEntry>();
    private readonly freeLayers: number[] = [];
    private readonly inflight = new Map<number, AbortController>();
    /** Keys whose loads must never be camera-cancelled (the pinned root).
     *  Found live, not in a test: the root is requested at construction and
     *  is never part of any frame's desired set, so without this exemption
     *  the FIRST `update` aborts it and the fallback chain's "always
     *  terminates in something resident" invariant is never established. */
    private readonly pinnedKeys = new Set<number>();
    /** The most recent frame's desired keys. Read at *admission* time, not at
     *  request time: a load that started three frames ago must be judged
     *  against where the camera is now, or it can evict a page the current
     *  frame is sampling. */
    private lastWanted: ReadonlySet<number> = new Set();
    private frame = 0;

    /**
     * Page table, `PAGE_TABLE_ENTRY_BYTES` per level-0 page, row-major over the
     * level-0 grid. Per entry:
     * `[layerLo, layerHi, level, fade, fbLayerLo, fbLayerHi, fbLevel, 0]`.
     * `fade` is 0-255 blend from the fallback sample toward the primary.
     * Uploaded as an RGBA8 texture of `2*pagesX × pagesZ` texels.
     */
    readonly pageTable: Uint8Array;
    readonly pageTableWidth: number;
    readonly pageTableHeight: number;
    /** Bumped whenever `pageTable` content changed — the GL layer's re-upload
     *  trigger, so a still camera uploads nothing. */
    private tableRevision = 0;

    private stats: PageCacheStats = {
        resident: 0, maxLayers: 0, inflight: 0, queued: 0,
        loaded: 0, aborted: 0, failed: 0, evicted: 0, holes: 0,
    };

    constructor(grid: PageGrid, opts: TerrainPageCacheOptions) {
        this.grid = grid;
        this.opts = {
            maxLayers: Math.max(1, opts.maxLayers),
            source: opts.source,
            uploader: opts.uploader,
            maxConcurrent: opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
            fadeMs: opts.fadeMs ?? DEFAULT_FADE_MS,
        };
        for (let i = this.opts.maxLayers - 1; i >= 0; i--) this.freeLayers.push(i);
        const L0 = grid.levels[0];
        this.pageTableWidth = L0.pagesX * 2;
        this.pageTableHeight = L0.pagesZ;
        this.pageTable = new Uint8Array(
            L0.pagesX * L0.pagesZ * PAGE_TABLE_ENTRY_BYTES);
        this.stats.maxLayers = this.opts.maxLayers;
        // The root page is pinned before anything else can take its layer, so
        // the fallback chain always terminates in something resident.
        this.requestRoot();
    }

    get revision(): number { return this.tableRevision; }

    getStats(): Readonly<PageCacheStats> {
        return {
            ...this.stats,
            resident: this.resident.size,
            inflight: this.inflight.size,
        };
    }

    /** Layer holding `id`, or -1 if it is not resident. Test/debug accessor. */
    layerOf(id: PageId): number {
        return this.resident.get(keyOf(id))?.layer ?? -1;
    }

    /**
     * Fold one frame's desired set into residency: touch what is already here,
     * schedule what is not, cancel what the camera has left behind, then
     * rebuild the page table.
     */
    update(desired: readonly DesiredPage[], nowMs: number): void {
        this.frame++;
        const wanted = new Set<number>();
        const missing: { key: number; id: PageId; group: PageGroup; depth: number }[] = [];

        for (const d of desired) {
            wanted.add(d.key);
            const r = this.resident.get(d.key);
            if (r) { r.lastUsedFrame = this.frame; continue; }
            // Touch the ancestors we are going to fall back onto, so a coarse
            // page standing in for a fine one does not get evicted underneath
            // its own dependants.
            const group = d.want === 'predicted'
                ? PageGroup.Predict
                : (this.touchAncestors(d.id) ? PageGroup.Refine : PageGroup.Hole);
            missing.push({ key: d.key, id: d.id, group, depth: d.depth });
        }
        this.lastWanted = wanted;
        this.stats.holes = missing.filter((m) => m.group === PageGroup.Hole).length;

        // Cancel in-flight work for pages nobody wants any more. Cesium's own
        // rule: the request that matters is the one for where the camera is
        // now, and an abort frees a connection slot immediately.
        for (const [key, ctrl] of this.inflight) {
            if (!wanted.has(key) && !this.pinnedKeys.has(key)) {
                ctrl.abort();
                this.inflight.delete(key);
                this.stats.aborted++;
            }
        }

        missing.sort((a, b) => (a.group - b.group) || (a.depth - b.depth));
        this.stats.queued = Math.max(
            0, missing.length - (this.opts.maxConcurrent - this.inflight.size));
        for (const m of missing) {
            if (this.inflight.size >= this.opts.maxConcurrent) break;
            if (this.inflight.has(m.key)) continue;
            this.startLoad(m.id, m.key);
        }

        this.rebuildPageTable(nowMs);
    }

    /** Abort everything in flight — call on map teardown. */
    dispose(): void {
        for (const ctrl of this.inflight.values()) ctrl.abort();
        this.inflight.clear();
    }

    // ── internals ──────────────────────────────────────────────────────

    private requestRoot(): void {
        const rootId: PageId = { level: this.grid.rootLevel, x: 0, z: 0 };
        this.startLoad(rootId, keyOf(rootId), true);
    }

    private touchAncestors(id: PageId): boolean {
        let p = parentPage(this.grid, id);
        let covered = false;
        while (p) {
            const r = this.resident.get(keyOf(p));
            if (r) { r.lastUsedFrame = this.frame; covered = true; }
            p = parentPage(this.grid, p);
        }
        return covered;
    }

    private startLoad(id: PageId, key: number, pinned = false): void {
        if (pinned) this.pinnedKeys.add(key);
        const ctrl = new AbortController();
        this.inflight.set(key, ctrl);
        this.opts.source.load(id, ctrl.signal).then((bytes) => {
            if (this.inflight.get(key) !== ctrl) return;   // superseded/aborted
            this.inflight.delete(key);
            if (bytes.length !== PAGE_BYTES) {
                this.stats.failed++;
                console.warn(`[terrain-pages] page ${id.level}/${id.x}/${id.z}: `
                    + `${bytes.length} bytes, expected ${PAGE_BYTES}`);
                return;
            }
            this.admit(id, key, bytes, pinned);
        }).catch((err: unknown) => {
            if (this.inflight.get(key) === ctrl) this.inflight.delete(key);
            if (ctrl.signal.aborted) return;               // counted at abort
            this.stats.failed++;
            console.warn(`[terrain-pages] page ${id.level}/${id.x}/${id.z} failed`, err);
        });
    }

    private admit(
        id: PageId, key: number, bytes: Uint8Array, pinned: boolean,
    ): void {
        if (this.resident.has(key)) return;
        const layer = this.acquireLayer(this.lastWanted);
        if (layer < 0) return;   // every layer is pinned or wanted; drop it
        this.opts.uploader?.uploadLayer(layer, bytes);
        this.resident.set(key, {
            key, id, layer, lastUsedFrame: this.frame, arrivedMs: -1, pinned,
        });
        this.stats.loaded++;
        this.tableRevision++;
    }

    /**
     * A free layer, or the LRU victim. A pinned page and anything in the
     * current desired set are both off limits — evicting a page the frame is
     * sampling pops visibly, and the cross-fade cannot cover it because the
     * finer texels no longer exist.
     */
    private acquireLayer(wanted: ReadonlySet<number>): number {
        const free = this.freeLayers.pop();
        if (free !== undefined) return free;
        let victim: ResidentEntry | null = null;
        for (const e of this.resident.values()) {
            if (e.pinned || wanted.has(e.key)) continue;
            if (!victim || e.lastUsedFrame < victim.lastUsedFrame) victim = e;
        }
        if (!victim) return -1;
        this.resident.delete(victim.key);
        this.stats.evicted++;
        this.tableRevision++;
        return victim.layer;
    }

    /**
     * Rebuild the indirection table: for every finest-level page, the best
     * resident ancestor (or itself) and the next-best behind it.
     *
     * The pair is what makes the fallback chain a *cross-fade* rather than a
     * pop: the shader samples both layers and lerps by `fade`, so a page
     * arriving mid-flight blends in over `fadeMs` from whatever coarser page
     * was standing in for it. Because the pyramid is also the mip chain
     * (see `terrain-page-grid.ts`), the same two taps are what trilinear
     * minification wants anyway — the fallback costs nothing extra in the
     * common case.
     */
    private rebuildPageTable(nowMs: number): void {
        const L0 = this.grid.levels[0];
        const t = this.pageTable;
        let changed = false;
        for (let z = 0; z < L0.pagesZ; z++) {
            for (let x = 0; x < L0.pagesX; x++) {
                let primary: ResidentEntry | undefined;
                let fallback: ResidentEntry | undefined;
                let id: PageId | null = { level: 0, x, z };
                while (id) {
                    const e = this.resident.get(pageKey(id.level, id.x, id.z));
                    if (e) {
                        if (!primary) primary = e;
                        else { fallback = e; break; }
                    }
                    id = parentPage(this.grid, id);
                }
                if (!primary) { primary = fallback; }
                if (!fallback) { fallback = primary; }

                let fade = 255;
                if (primary && fallback && primary !== fallback) {
                    if (primary.arrivedMs < 0) primary.arrivedMs = nowMs;
                    const dt = nowMs - primary.arrivedMs;
                    fade = this.opts.fadeMs > 0
                        ? Math.max(0, Math.min(255,
                            Math.round((dt / this.opts.fadeMs) * 255)))
                        : 255;
                } else if (primary && primary.arrivedMs < 0) {
                    primary.arrivedMs = nowMs;
                }

                const o = (z * L0.pagesX + x) * PAGE_TABLE_ENTRY_BYTES;
                const pl = primary ? primary.layer : 0;
                const fl = fallback ? fallback.layer : 0;
                const bytes = [
                    pl & 0xff, (pl >> 8) & 0xff, primary ? primary.id.level : 0xff, fade,
                    fl & 0xff, (fl >> 8) & 0xff, fallback ? fallback.id.level : 0xff, 0,
                ];
                for (let i = 0; i < PAGE_TABLE_ENTRY_BYTES; i++) {
                    if (t[o + i] !== bytes[i]) { t[o + i] = bytes[i]; changed = true; }
                }
            }
        }
        if (changed) this.tableRevision++;
    }
}

/**
 * Wrap a `PageSource` in the **Cache API disk tier** §1.2 asks for: a hit
 * skips the network entirely and survives a reload, which matters most for the
 * coarse levels every session re-requests first.
 *
 * Guarded, not assumed — `caches` is absent in a non-secure context and in the
 * test environment, and the wrapper degrades to the inner source rather than
 * failing. A cache write is fire-and-forget: a page that fails to persist is a
 * page that gets fetched again, not a broken frame.
 */
export function withPageDiskCache(
    inner: PageSource, cacheName = 'terrain-pages-v1',
    cacheStorage: CacheStorage | undefined
        = typeof caches !== 'undefined' ? caches : undefined,
): PageSource {
    if (!cacheStorage) return inner;
    return {
        sourceId: inner.sourceId,
        async load(id: PageId, signal: AbortSignal): Promise<Uint8Array> {
            const url = pageCacheKey(inner.sourceId, id);
            try {
                const c = await cacheStorage.open(cacheName);
                const hit = await c.match(url);
                if (hit) return new Uint8Array(await hit.arrayBuffer());
                const bytes = await inner.load(id, signal);
                void c.put(url, new Response(bytes.slice().buffer as ArrayBuffer))
                    .catch(() => { /* quota/eviction — refetch next time */ });
                return bytes;
            } catch {
                return inner.load(id, signal);
            }
        },
    };
}

/** Disk-tier key. Same-origin URL shape so `Cache.match` accepts it. */
export function pageCacheKey(sourceId: string, id: PageId): string {
    return `/__terrain-pages/${encodeURIComponent(sourceId)}`
        + `/${id.level}/${id.x}/${id.z}.bc1`;
}
