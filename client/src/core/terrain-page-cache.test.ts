import { describe, it, expect, vi } from 'vitest';
import {
    planPageGrid, keyOf, PAGE_BYTES
} from './terrain-page-grid.js';
import {
    TerrainPageCache, PAGE_TABLE_ENTRY_BYTES, withPageDiskCache, pageCacheKey,
    type PageSource, type PageUploader,
} from './terrain-page-cache.js';
import type { DesiredPage } from './terrain-page-visibility.js';
import type { PageId } from './terrain-page-grid.js';

const GRID = planPageGrid(16384, 16384);   // 6 levels, 32x32 at level 0

function want(id: PageId, depth = 100,
              w: DesiredPage['want'] = 'visible'): DesiredPage {
    return { id, key: keyOf(id), want: w, depth, texelsPerPixel: 1 };
}

/** A source whose every load is resolved by hand, so scheduling is exact. */
class ManualSource implements PageSource {
    readonly sourceId = 'test';
    readonly pending = new Map<number, {
        id: PageId; signal: AbortSignal;
        resolve: (b: Uint8Array) => void; reject: (e: unknown) => void;
    }>();
    loads = 0;
    load(id: PageId, signal: AbortSignal): Promise<Uint8Array> {
        this.loads++;
        return new Promise((resolve, reject) => {
            this.pending.set(keyOf(id), { id, signal, resolve, reject });
            signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
    }
    /** Complete a queued load with a well-formed page. */
    deliver(id: PageId): Promise<void> {
        const p = this.pending.get(keyOf(id));
        if (!p) throw new Error(`no pending load for ${id.level}/${id.x}/${id.z}`);
        this.pending.delete(keyOf(id));
        p.resolve(new Uint8Array(PAGE_BYTES));
        return Promise.resolve();
    }
    deliverBadSize(id: PageId): void {
        const p = this.pending.get(keyOf(id))!;
        this.pending.delete(keyOf(id));
        p.resolve(new Uint8Array(17));
    }
}

const ROOT: PageId = { level: 5, x: 0, z: 0 };

/** Let the promise chain inside `admit` run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function makeCache(maxLayers = 4, maxConcurrent = 4) {
    const source = new ManualSource();
    const uploaded: number[] = [];
    const uploader: PageUploader = { uploadLayer: (l) => uploaded.push(l) };
    const cache = new TerrainPageCache(GRID, {
        maxLayers, source, uploader, maxConcurrent, fadeMs: 100,
    });
    return { cache, source, uploaded };
}

describe('TerrainPageCache residency', () => {
    it('requests the root page up front so the fallback chain terminates', async () => {
        const { cache, source } = makeCache();
        expect(source.pending.has(keyOf(ROOT))).toBe(true);
        await source.deliver(ROOT); await settle();
        expect(cache.layerOf(ROOT)).toBeGreaterThanOrEqual(0);
    });

    it('never evicts the pinned root, even when every layer is contested', async () => {
        const { cache, source } = makeCache(2, 8);
        await source.deliver(ROOT); await settle();
        const rootLayer = cache.layerOf(ROOT);
        for (let i = 0; i < 4; i++) {
            const id = { level: 0, x: i, z: 0 };
            cache.update([want(id, 100 + i)], 0);
            if (source.pending.has(keyOf(id))) { await source.deliver(id); await settle(); }
        }
        expect(cache.layerOf(ROOT)).toBe(rootLayer);
    });

    it('evicts LRU and reuses the freed layer', async () => {
        const { cache, source } = makeCache(3, 8);
        await source.deliver(ROOT); await settle();
        const a = { level: 0, x: 0, z: 0 }, b = { level: 0, x: 1, z: 0 };
        const c = { level: 0, x: 2, z: 0 };
        // a and b resident (root pinned takes the third layer).
        cache.update([want(a), want(b)], 0);
        await source.deliver(a); await source.deliver(b); await settle();
        expect(cache.layerOf(a)).toBeGreaterThanOrEqual(0);
        const bLayer = cache.layerOf(b);
        // Now only b is wanted; a is the LRU victim for c.
        cache.update([want(b)], 1);
        cache.update([want(b), want(c)], 2);
        await source.deliver(c); await settle();
        expect(cache.layerOf(a)).toBe(-1);
        expect(cache.layerOf(b)).toBe(bLayer);          // still wanted, untouched
        expect(cache.layerOf(c)).toBeGreaterThanOrEqual(0);
        expect(cache.getStats().evicted).toBe(1);
    });

    it('refuses to evict a page the current frame is sampling', async () => {
        const { cache, source } = makeCache(2, 8);
        await source.deliver(ROOT); await settle();
        const a = { level: 0, x: 0, z: 0 }, b = { level: 0, x: 1, z: 0 };
        cache.update([want(a), want(b)], 0);
        await source.deliver(a); await settle();
        expect(cache.layerOf(a)).toBeGreaterThanOrEqual(0);
        // Only one non-pinned layer exists and `a` holds it while still wanted,
        // so `b` is dropped rather than popping `a` off the screen.
        await source.deliver(b); await settle();
        expect(cache.layerOf(b)).toBe(-1);
        expect(cache.layerOf(a)).toBeGreaterThanOrEqual(0);
    });

    it('rejects a page whose byte count is not the page format', async () => {
        const { cache, source } = makeCache();
        await source.deliver(ROOT); await settle();
        const a = { level: 0, x: 0, z: 0 };
        cache.update([want(a)], 0);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        source.deliverBadSize(a); await settle();
        warn.mockRestore();
        expect(cache.layerOf(a)).toBe(-1);
        expect(cache.getStats().failed).toBe(1);
    });

    it('uploads each admitted page exactly once, into its own layer', async () => {
        const { cache, source, uploaded } = makeCache(4, 8);
        await source.deliver(ROOT); await settle();
        const ids = [0, 1, 2].map((x) => ({ level: 0, x, z: 0 }));
        cache.update(ids.map((i) => want(i)), 0);
        for (const i of ids) { await source.deliver(i); }
        await settle();
        expect(uploaded.length).toBe(4);                      // root + three
        expect(new Set(uploaded).size).toBe(4);
        expect(uploaded).toContain(cache.layerOf(ids[2]));
    });
});

describe('TerrainPageCache scheduling', () => {
    it('groups by urgency: a hole outranks a refinement outranks a prediction',
       async () => {
        const { cache, source } = makeCache(8, 1);
        await source.deliver(ROOT); await settle();
        // level-4 page: its only resident ancestor is the root, so it is a
        // *refinement*. A level-0 page under a resident level-4 page would be
        // a refinement too; with nothing but the root resident, both are
        // covered, so use the predicted flag to separate the tail.
        const refine = { level: 4, x: 0, z: 0 };
        const predict = { level: 4, x: 1, z: 1 };
        cache.update([want(predict, 10, 'predicted'), want(refine, 900)], 0);
        expect(source.pending.has(keyOf(refine))).toBe(true);
        expect(source.pending.has(keyOf(predict))).toBe(false);
    });

    it('counts a page with no resident ancestor as a hole', () => {
        const { cache, source } = makeCache(8, 1);
        // Root has not landed yet, so nothing covers this page.
        cache.update([want({ level: 0, x: 3, z: 3 })], 0);
        expect(cache.getStats().holes).toBe(1);
        expect(source.loads).toBeGreaterThan(0);
    });

    it('caps concurrency and queues the rest', async () => {
        const { cache, source } = makeCache(16, 2);
        await source.deliver(ROOT); await settle();
        const ids = [0, 1, 2, 3, 4].map((x) => ({ level: 0, x, z: 0 }));
        cache.update(ids.map((i, n) => want(i, 100 + n)), 0);
        expect(cache.getStats().inflight).toBe(2);
        expect(cache.getStats().queued).toBe(3);
        // Nearest first: x=0 and x=1 are the two in flight.
        expect(source.pending.has(keyOf(ids[0]))).toBe(true);
        expect(source.pending.has(keyOf(ids[1]))).toBe(true);
        expect(source.pending.has(keyOf(ids[4]))).toBe(false);
    });

    it('aborts a request the camera has moved past', async () => {
        const { cache, source } = makeCache(16, 4);
        await source.deliver(ROOT); await settle();
        const stale = { level: 0, x: 0, z: 0 }, fresh = { level: 0, x: 20, z: 20 };
        cache.update([want(stale)], 0);
        const req = source.pending.get(keyOf(stale))!;
        expect(req.signal.aborted).toBe(false);
        cache.update([want(fresh)], 1);
        expect(req.signal.aborted).toBe(true);
        expect(cache.getStats().aborted).toBe(1);
        await settle();
        expect(cache.getStats().failed).toBe(0);   // an abort is not a failure
    });

    it('aborts everything still in flight on dispose', async () => {
        const { cache, source } = makeCache(16, 4);
        const req = source.pending.get(keyOf(ROOT))!;
        cache.dispose();
        expect(req.signal.aborted).toBe(true);
        await settle();
    });
});

describe('page table (the fallback chain)', () => {
    const L0 = GRID.levels[0];
    const entry = (x: number, z: number, table: Uint8Array) => {
        const o = (z * L0.pagesX + x) * PAGE_TABLE_ENTRY_BYTES;
        return {
            layer: table[o] | (table[o + 1] << 8),
            level: table[o + 2],
            fade: table[o + 3],
            fbLayer: table[o + 4] | (table[o + 5] << 8),
            fbLevel: table[o + 6],
        };
    };

    it('is sized one entry per finest-level page', () => {
        const { cache } = makeCache();
        expect(cache.pageTable.length)
            .toBe(L0.pagesX * L0.pagesZ * PAGE_TABLE_ENTRY_BYTES);
        expect(cache.pageTableWidth).toBe(L0.pagesX * 2);
        expect(cache.pageTableHeight).toBe(L0.pagesZ);
    });

    it('points every entry at the root while only the root is resident',
       async () => {
        const { cache, source } = makeCache();
        await source.deliver(ROOT); await settle();
        cache.update([], 0);
        for (const [x, z] of [[0, 0], [31, 31], [17, 3]]) {
            expect(entry(x, z, cache.pageTable).level).toBe(GRID.rootLevel);
        }
    });

    it('promotes to the finest resident page and keeps the parent as fallback',
       async () => {
        const { cache, source } = makeCache(8, 8);
        await source.deliver(ROOT); await settle();
        const mid = { level: 2, x: 0, z: 0 };      // covers level-0 pages 0..3
        const fine = { level: 0, x: 1, z: 1 };
        cache.update([want(mid), want(fine)], 0);
        await source.deliver(mid); await source.deliver(fine); await settle();
        cache.update([want(mid), want(fine)], 0);

        const e = entry(1, 1, cache.pageTable);
        expect(e.level).toBe(0);
        expect(e.layer).toBe(cache.layerOf(fine));
        expect(e.fbLevel).toBe(2);                          // the parent-UV tap
        expect(e.fbLayer).toBe(cache.layerOf(mid));

        // A sibling with no fine page of its own falls back one step further.
        const s = entry(2, 2, cache.pageTable);
        expect(s.level).toBe(2);
        expect(s.fbLevel).toBe(GRID.rootLevel);
    });

    it('cross-fades a newly arrived page in over fadeMs', async () => {
        const { cache, source } = makeCache(8, 8);
        await source.deliver(ROOT); await settle();
        const fine = { level: 0, x: 4, z: 4 };
        cache.update([want(fine)], 1000);
        await source.deliver(fine); await settle();

        cache.update([want(fine)], 1000);
        expect(entry(4, 4, cache.pageTable).fade).toBe(0);
        cache.update([want(fine)], 1050);
        expect(entry(4, 4, cache.pageTable).fade).toBeCloseTo(128, -1);
        cache.update([want(fine)], 1100);
        expect(entry(4, 4, cache.pageTable).fade).toBe(255);
        cache.update([want(fine)], 5000);
        expect(entry(4, 4, cache.pageTable).fade).toBe(255);   // clamped
    });

    it('bumps the revision only when the table actually changed', async () => {
        const { cache, source } = makeCache(8, 8);
        await source.deliver(ROOT); await settle();
        cache.update([], 5000);
        const r0 = cache.revision;
        cache.update([], 5000);
        expect(cache.revision).toBe(r0);              // a still camera uploads nothing
        const fine = { level: 0, x: 9, z: 9 };
        cache.update([want(fine)], 5000);
        await source.deliver(fine); await settle();
        cache.update([want(fine)], 5000);
        expect(cache.revision).toBeGreaterThan(r0);
    });
});

describe('the Cache API disk tier', () => {
    const id: PageId = { level: 2, x: 3, z: 4 };

    it('builds a same-origin key that names the source', () => {
        expect(pageCacheKey('ground-a', id)).toBe('/__terrain-pages/ground-a/2/3/4.bc1');
        expect(pageCacheKey('a/b', id)).toContain('a%2Fb');
    });

    it('serves a hit without touching the network', async () => {
        const inner: PageSource = {
            sourceId: 'g', load: vi.fn(async () => new Uint8Array(PAGE_BYTES)),
        };
        const cached = {
            match: vi.fn(async () => new Response(new Uint8Array(PAGE_BYTES))),
            put: vi.fn(async () => {}),
        };
        const src = withPageDiskCache(inner, 'n',
            { open: async () => cached } as unknown as CacheStorage);
        const bytes = await src.load(id, new AbortController().signal);
        expect(bytes.length).toBe(PAGE_BYTES);
        expect(inner.load).not.toHaveBeenCalled();
    });

    it('fetches and persists a miss', async () => {
        const inner: PageSource = {
            sourceId: 'g', load: vi.fn(async () => new Uint8Array(PAGE_BYTES)),
        };
        const cached = {
            match: vi.fn(async () => undefined),
            put: vi.fn(async () => {}),
        };
        const src = withPageDiskCache(inner, 'n',
            { open: async () => cached } as unknown as CacheStorage);
        await src.load(id, new AbortController().signal);
        expect(inner.load).toHaveBeenCalledOnce();
        await settle();
        expect(cached.put).toHaveBeenCalledOnce();
    });

    it('degrades to the network when there is no Cache API at all', async () => {
        const inner: PageSource = {
            sourceId: 'g', load: vi.fn(async () => new Uint8Array(PAGE_BYTES)),
        };
        expect(withPageDiskCache(inner, 'n', undefined)).toBe(inner);
    });

    it('degrades when the cache itself throws', async () => {
        const inner: PageSource = {
            sourceId: 'g', load: vi.fn(async () => new Uint8Array(PAGE_BYTES)),
        };
        const src = withPageDiskCache(inner, 'n',
            { open: async () => { throw new Error('no quota'); } } as unknown as CacheStorage);
        const bytes = await src.load(id, new AbortController().signal);
        expect(bytes.length).toBe(PAGE_BYTES);
        expect(inner.load).toHaveBeenCalledOnce();
    });
});
