/**
 * Synthetic terrain page source — the de-risking half of the streaming v2
 * vertical slice (PLAN-maps.md §1.2.1, lane queue item 1).
 *
 * Generates procedurally coloured 520² BC1 pages with **one hue per pyramid
 * level**, so the whole GPU path — the `TEXTURE_2D_ARRAY` upload, the page
 * table, the shader's two-tap fallback chain and the cross-fade — is visible
 * on screen before any real map bytes exist. When the fallback chain works,
 * zooming in shows the coarse hue being progressively replaced by finer hues,
 * blending rather than popping; when the UV transform is wrong, the per-page
 * brightness gradient tears at page boundaries.
 *
 * Three deliberate visual features, each a debugging instrument:
 * - **Hue = pyramid level.** A frame's colour composition IS its residency
 *   state; a screenshot of the degradation is a screenshot of the chain.
 * - **Brightness gradient along U within each page.** A UV-transform bug
 *   (wrong scale, wrong offset, border mishandled) shows as a sawtooth
 *   discontinuity at page seams instead of a smooth repeating ramp.
 * - **A dark 1-block ring at the physical edge.** The ring sits exactly on
 *   the 4-texel border, so it *should never be visible*: payload UVs stop
 *   4 texels short of the edge. Seeing dark grid lines means the payload →
 *   physical UV remap is sampling into the border.
 *
 * BC1 encoding is the trivial subset: every 4×4 block is a solid colour
 * (`color0 == color1`, all indices 0), which every S3TC decoder resolves to
 * `color0`. No interpolation codes are needed for flat-colour diagnostics.
 */

import type { PageId } from './terrain-page-grid.js';
import {
    PAGE_PHYSICAL_TEXELS, PAGE_BYTES, BC1_BLOCK_BYTES,
} from './terrain-page-grid.js';
import type { PageSource } from './terrain-page-cache.js';

/** Blocks per page axis (130 for the 520² page). */
const BLOCKS_PER_AXIS = PAGE_PHYSICAL_TEXELS / 4;

/** Hue (degrees) for a pyramid level. Spaced so adjacent levels contrast
 *  strongly: 0=red, 1=yellow-green edge, 2=cyan-ish, ... wraps past 6. */
export function hueForLevel(level: number): number {
    return (level * 137) % 360;
}

/** Minimal HSV→RGB, returning 0-255 channels. */
export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const c = v * s;
    const hp = ((h % 360) + 360) % 360 / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    const m = v - c;
    return [
        Math.round((r + m) * 255),
        Math.round((g + m) * 255),
        Math.round((b + m) * 255),
    ];
}

/** Pack 0-255 RGB into RGB565. */
export function rgb565(r: number, g: number, b: number): number {
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

/**
 * Encode one synthetic physical page. Deterministic in `id`, so the disk
 * tier (if ever enabled over this source) and re-requests are stable.
 */
export function synthesizePageBytes(id: PageId): Uint8Array {
    const out = new Uint8Array(PAGE_BYTES);
    const hue = hueForLevel(id.level);
    // Page-parity saturation split so neighbouring pages of one level differ.
    const sat = ((id.x + id.z) & 1) === 0 ? 0.85 : 0.55;
    const last = BLOCKS_PER_AXIS - 1;
    for (let bz = 0; bz < BLOCKS_PER_AXIS; bz++) {
        for (let bx = 0; bx < BLOCKS_PER_AXIS; bx++) {
            const border = bx === 0 || bz === 0 || bx === last || bz === last;
            // Brightness ramps along U; the border ring is near-black.
            let v = 0.5 + 0.45 * (bx / last);
            if (border) v *= 0.15;
            const [r, g, b] = hsvToRgb(hue, sat, v);
            const c = rgb565(r, g, b);
            const o = (bz * BLOCKS_PER_AXIS + bx) * BC1_BLOCK_BYTES;
            out[o] = c & 0xff;
            out[o + 1] = (c >> 8) & 0xff;
            out[o + 2] = c & 0xff;
            out[o + 3] = (c >> 8) & 0xff;
            // Index bytes stay 0: every texel selects color0.
        }
    }
    return out;
}

/**
 * A `PageSource` over `synthesizePageBytes`, with an optional artificial
 * latency window so page arrival is staggered — without it every page lands
 * in one frame and the cross-fade has nothing visible to do.
 */
export class SyntheticPageSource implements PageSource {
    readonly sourceId = 'synthetic-v1';

    constructor(
        private readonly minDelayMs = 0,
        private readonly maxDelayMs = 0,
    ) {}

    load(id: PageId, signal: AbortSignal): Promise<Uint8Array> {
        const span = Math.max(0, this.maxDelayMs - this.minDelayMs);
        const delay = this.minDelayMs + Math.random() * span;
        if (delay <= 0) {
            return signal.aborted
                ? Promise.reject(new DOMException('aborted', 'AbortError'))
                : Promise.resolve(synthesizePageBytes(id));
        }
        return new Promise<Uint8Array>((resolve, reject) => {
            if (signal.aborted) {
                reject(new DOMException('aborted', 'AbortError'));
                return;
            }
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve(synthesizePageBytes(id));
            }, delay);
            const onAbort = (): void => {
                clearTimeout(timer);
                reject(new DOMException('aborted', 'AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }
}
