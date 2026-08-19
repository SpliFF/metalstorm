import { describe, it, expect } from 'vitest';
import {
    synthesizePageBytes, SyntheticPageSource, hueForLevel, hsvToRgb, rgb565,
} from './terrain-page-synthetic.js';
import {
    PAGE_BYTES, BC1_BLOCK_BYTES, PAGE_PHYSICAL_TEXELS,
} from './terrain-page-grid.js';

// The synthetic source exists so the GPU half of streaming v2 can be proven
// on screen before any real map bytes exist (PLAN-maps.md §1.2.1). What is
// asserted here is the contract the cache and the uploader then depend on:
// exact PAGE_BYTES-sized, valid solid-colour BC1, deterministic per id, and
// visually distinguishable per level — plus the AbortSignal behaviour the
// cache's cancellation path requires of every PageSource.

const BLOCKS = PAGE_PHYSICAL_TEXELS / 4;

/** Decode block (bx,bz)'s color0 as RGB565. */
function blockColor(bytes: Uint8Array, bx: number, bz: number): number {
    const o = (bz * BLOCKS + bx) * BC1_BLOCK_BYTES;
    return bytes[o] | (bytes[o + 1] << 8);
}

describe('synthesizePageBytes', () => {
    it('emits exactly one physical page of BC1', () => {
        const bytes = synthesizePageBytes({ level: 0, x: 0, z: 0 });
        expect(bytes.length).toBe(PAGE_BYTES);
    });

    it('is deterministic in the page id', () => {
        const a = synthesizePageBytes({ level: 2, x: 3, z: 5 });
        const b = synthesizePageBytes({ level: 2, x: 3, z: 5 });
        expect(a).toEqual(b);
    });

    it('encodes solid-colour blocks: color0 == color1, all indices zero', () => {
        const bytes = synthesizePageBytes({ level: 1, x: 1, z: 0 });
        for (const [bx, bz] of [[0, 0], [64, 64], [BLOCKS - 1, BLOCKS - 1]]) {
            const o = (bz * BLOCKS + bx) * BC1_BLOCK_BYTES;
            expect(bytes[o]).toBe(bytes[o + 2]);         // c0 lo == c1 lo
            expect(bytes[o + 1]).toBe(bytes[o + 3]);     // c0 hi == c1 hi
            expect(bytes[o + 4] | bytes[o + 5] | bytes[o + 6] | bytes[o + 7])
                .toBe(0);
        }
    });

    it('colours levels differently — the hue IS the residency diagnostic', () => {
        const l0 = synthesizePageBytes({ level: 0, x: 0, z: 0 });
        const l1 = synthesizePageBytes({ level: 1, x: 0, z: 0 });
        expect(blockColor(l0, 64, 64)).not.toBe(blockColor(l1, 64, 64));
        expect(hueForLevel(0)).not.toBe(hueForLevel(1));
    });

    it('darkens the border ring so border sampling is visible on screen', () => {
        const bytes = synthesizePageBytes({ level: 0, x: 0, z: 0 });
        // Compare a border block with its inward neighbour on the same row:
        // same hue, same U-gradient position ±1 — the ring is much darker.
        const edge = blockColor(bytes, 64, 0);
        const inner = blockColor(bytes, 64, 1);
        const lum = (c: number): number =>
            ((c >> 11) & 0x1f) + ((c >> 5) & 0x3f) + (c & 0x1f);
        expect(lum(edge)).toBeLessThan(lum(inner) * 0.5);
    });

    it('ramps brightness along U inside a page (the UV-tear diagnostic)', () => {
        const bytes = synthesizePageBytes({ level: 0, x: 0, z: 0 });
        const lum = (c: number): number =>
            ((c >> 11) & 0x1f) + ((c >> 5) & 0x3f) + (c & 0x1f);
        expect(lum(blockColor(bytes, 2, 64)))
            .toBeLessThan(lum(blockColor(bytes, BLOCKS - 3, 64)));
    });
});

describe('hsvToRgb / rgb565', () => {
    it('round-trips primaries', () => {
        expect(hsvToRgb(0, 1, 1)).toEqual([255, 0, 0]);
        expect(hsvToRgb(120, 1, 1)).toEqual([0, 255, 0]);
        expect(hsvToRgb(240, 1, 1)).toEqual([0, 0, 255]);
        expect(hsvToRgb(0, 0, 1)).toEqual([255, 255, 255]);
    });
    it('packs 565 endpoints', () => {
        expect(rgb565(255, 255, 255)).toBe(0xffff);
        expect(rgb565(0, 0, 0)).toBe(0);
        expect(rgb565(255, 0, 0)).toBe(0xf800);
    });
});

describe('SyntheticPageSource', () => {
    it('resolves with page bytes when not aborted', async () => {
        const src = new SyntheticPageSource();
        const bytes = await src.load(
            { level: 0, x: 0, z: 0 }, new AbortController().signal);
        expect(bytes.length).toBe(PAGE_BYTES);
    });

    it('rejects an already-aborted request', async () => {
        const src = new SyntheticPageSource();
        const ctrl = new AbortController();
        ctrl.abort();
        await expect(src.load({ level: 0, x: 0, z: 0 }, ctrl.signal))
            .rejects.toThrow();
    });

    it('rejects a delayed request when aborted mid-flight', async () => {
        const src = new SyntheticPageSource(5, 10);
        const ctrl = new AbortController();
        const p = src.load({ level: 0, x: 0, z: 0 }, ctrl.signal);
        ctrl.abort();
        await expect(p).rejects.toThrow();
    });
});
