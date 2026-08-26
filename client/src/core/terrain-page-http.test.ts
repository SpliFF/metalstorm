/**
 * HTTP `PageSource` over `ground_pages.bin` — the client half of the format
 * v19 contract. The byte offsets pinned here are the SAME numbers
 * tests/test_terrain_pages.cpp pins on the producing side
 * (`TerrainPages::PageByteOffset`, 16 384-elmo map, 2048² source): a change
 * that moves one suite and not the other is a broken on-disk contract.
 */
import { describe, it, expect } from 'vitest';
import { PAGE_BYTES, planPageGrid } from './terrain-page-grid.js';
import {
    HttpPageSource, fetchGroundPagesIndex, groundPageByteOffset,
    validateGroundPagesIndex, type GroundPagesIndex,
} from './terrain-page-http.js';

/** The index Server/TerrainPages.h IndexJson emits for the shipped maps. */
function shippedIndex(): GroundPagesIndex {
    return {
        version: 1, pageBytes: 135200, payloadTexels: 512, borderTexels: 4,
        mapElmosX: 16384, mapElmosZ: 16384, sourceW: 2048, sourceH: 2048,
        finestLevel: 3, rootLevel: 5, totalPages: 21, stamp: 1234567,
        levels: [
            { level: 3, pagesX: 4, pagesZ: 4, firstPage: 0 },
            { level: 4, pagesX: 2, pagesZ: 2, firstPage: 16 },
            { level: 5, pagesX: 1, pagesZ: 1, firstPage: 20 },
        ],
    };
}

const grid16k = () => planPageGrid(16384, 16384);

function fetchStub(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
    return ((url: string, init?: RequestInit) =>
        Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

const abort = () => new AbortController().signal;

describe('validateGroundPagesIndex', () => {
    it('accepts the shipped 16k/2048 shape against the client grid', () => {
        expect(validateGroundPagesIndex(shippedIndex(), grid16k())).toBeNull();
    });

    it('refuses every mismatch the two sides could disagree on', () => {
        const g = grid16k();
        expect(validateGroundPagesIndex(
            { ...shippedIndex(), version: 2 }, g)).toMatch(/version/);
        expect(validateGroundPagesIndex(
            { ...shippedIndex(), pageBytes: 12345 }, g)).toMatch(/pageBytes/);
        expect(validateGroundPagesIndex(
            { ...shippedIndex(), mapElmosX: 8192 }, g)).toMatch(/extent/);
        expect(validateGroundPagesIndex(
            { ...shippedIndex(), rootLevel: 4 }, g)).toMatch(/rootLevel/);
        const badCount = shippedIndex();
        badCount.levels[0].pagesX = 8;
        expect(validateGroundPagesIndex(badCount, g)).toMatch(/level 3/);
        const badOffset = shippedIndex();
        badOffset.levels[1].firstPage = 17;
        expect(validateGroundPagesIndex(badOffset, g)).toMatch(/firstPage/);
        expect(validateGroundPagesIndex(
            { ...shippedIndex(), totalPages: 22 }, g)).toMatch(/totalPages/);
        expect(validateGroundPagesIndex(
            { ...shippedIndex(), finestLevel: 2 }, g)).toMatch(/finestLevel/);
    });
});

describe('groundPageByteOffset — the mirror of TerrainPages::PageByteOffset', () => {
    const idx = shippedIndex();

    it('reproduces the doctest-pinned offsets exactly', () => {
        expect(groundPageByteOffset(idx, { level: 3, x: 0, z: 0 })).toBe(0);
        expect(groundPageByteOffset(idx, { level: 3, x: 1, z: 2 }))
            .toBe((2 * 4 + 1) * PAGE_BYTES);
        expect(groundPageByteOffset(idx, { level: 4, x: 1, z: 1 }))
            .toBe((16 + 3) * PAGE_BYTES);
        expect(groundPageByteOffset(idx, { level: 5, x: 0, z: 0 }))
            .toBe(20 * PAGE_BYTES);
    });

    it('returns null outside the produced pyramid', () => {
        expect(groundPageByteOffset(idx, { level: 2, x: 0, z: 0 })).toBeNull();
        expect(groundPageByteOffset(idx, { level: 3, x: 4, z: 0 })).toBeNull();
        expect(groundPageByteOffset(idx, { level: 6, x: 0, z: 0 })).toBeNull();
    });
});

describe('fetchGroundPagesIndex', () => {
    it('resolves the parsed index from <mapDataUrl>/ground_pages.json', async () => {
        let seen = '';
        const idx = await fetchGroundPagesIndex('/api/maps/data/m', fetchStub(
            (url) => {
                seen = url;
                return new Response(JSON.stringify(shippedIndex()));
            }));
        expect(seen).toBe('/api/maps/data/m/ground_pages.json');
        expect(idx?.finestLevel).toBe(3);
    });

    it('resolves null on 404 and on a network refusal — no pages, not an error',
        async () => {
            expect(await fetchGroundPagesIndex('/m', fetchStub(
                () => new Response('', { status: 404 })))).toBeNull();
            expect(await fetchGroundPagesIndex('/m', fetchStub(
                () => { throw new TypeError('refused'); }))).toBeNull();
        });
});

describe('HttpPageSource', () => {
    it('fetches one page as one Range request and returns its bytes', async () => {
        const wanted = (16 + 3) * PAGE_BYTES;
        let gotRange = '';
        const src = new HttpPageSource('/api/maps/data/m', shippedIndex(),
            fetchStub((url, init) => {
                expect(url).toBe('/api/maps/data/m/ground_pages.bin');
                gotRange = (init?.headers as Record<string, string>).Range;
                return new Response(new Uint8Array(PAGE_BYTES).fill(7),
                    { status: 206 });
            }));
        const bytes = await src.load({ level: 4, x: 1, z: 1 }, abort());
        expect(gotRange).toBe(`bytes=${wanted}-${wanted + PAGE_BYTES - 1}`);
        expect(bytes.byteLength).toBe(PAGE_BYTES);
        expect(bytes[0]).toBe(7);
    });

    it('degrades to whole-file slicing when the server ignores Range', async () => {
        const whole = new Uint8Array(21 * PAGE_BYTES);
        whole.fill(9, 20 * PAGE_BYTES);  // mark the root page's bytes
        let fetches = 0;
        const src = new HttpPageSource('/m', shippedIndex(), fetchStub(() => {
            fetches++;
            return new Response(whole, { status: 200 });
        }));
        const root = await src.load({ level: 5, x: 0, z: 0 }, abort());
        expect(root[0]).toBe(9);
        const first = await src.load({ level: 3, x: 0, z: 0 }, abort());
        expect(first[0]).toBe(0);
        expect(fetches).toBe(1);  // the whole file is fetched exactly once
    });

    it('rejects a short Range answer instead of uploading garbage', async () => {
        const src = new HttpPageSource('/m', shippedIndex(), fetchStub(
            () => new Response(new Uint8Array(100), { status: 206 })));
        await expect(src.load({ level: 3, x: 0, z: 0 }, abort()))
            .rejects.toThrow(/100 bytes/);
    });

    it('rejects pages outside the produced pyramid as a wiring bug', async () => {
        const src = new HttpPageSource('/m', shippedIndex(), fetchStub(
            () => new Response('', { status: 500 })));
        await expect(src.load({ level: 2, x: 0, z: 0 }, abort()))
            .rejects.toThrow(/outside the produced pyramid/);
    });

    it('calls the global fetch unbound — the worker "Illegal invocation" regression',
        async () => {
            // Found live (2026-08-20): storing the bare `fetch` reference and
            // calling it as `this.fetchFn(...)` rebinds the receiver to the
            // source object, and the native fetch throws "Illegal invocation"
            // in a Worker. Every page load failed. This stub is that check.
            const orig = globalThis.fetch;
            globalThis.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
                if (this !== undefined && this !== globalThis) {
                    throw new TypeError('Illegal invocation');
                }
                void args;
                return Promise.resolve(new Response(
                    new Uint8Array(PAGE_BYTES), { status: 206 }));
            } as typeof fetch;
            try {
                const src = new HttpPageSource('/m', shippedIndex());
                const bytes = await src.load({ level: 3, x: 0, z: 0 }, abort());
                expect(bytes.byteLength).toBe(PAGE_BYTES);
            } finally {
                globalThis.fetch = orig;
            }
        });

    it('carries the producer stamp in sourceId so the disk tier busts on reprocess',
        () => {
            const a = new HttpPageSource('/m', shippedIndex(), fetchStub(
                () => new Response('')));
            const b = new HttpPageSource('/m',
                { ...shippedIndex(), stamp: 7654321 },
                fetchStub(() => new Response('')));
            expect(a.sourceId).not.toBe(b.sourceId);
            expect(a.sourceId).toContain('/m/ground_pages.bin');
        });
});
