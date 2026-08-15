/**
 * Pure pixel statistics for captured frames (P5).
 *
 * Lives in its own module rather than inside game-processor.ts so a unit test
 * can reach it without importing the whole 4.8 k-line render worker (which
 * pulls in Babylon, the LuaUI host and the connection stack).
 */

/** Min / max / mean luminance over an RGBA pixel buffer.
 *
 *  Uses the Rec.601 weights (0.299 / 0.587 / 0.114) that
 *  `scenarios/render-sanity.ts` samples with, so a
 *  `test.captureFrame({stats: true})` reading is directly comparable with a
 *  render-sanity sample. An empty buffer reports zeroes (not `min: 255`) —
 *  "nothing measured" must not read as "measured black". */
export function luminanceStats(px: Uint8ClampedArray | Uint8Array): {
    min: number; max: number; mean: number;
} {
    let min = 255, max = 0, sum = 0, n = 0;
    for (let i = 0; i + 3 < px.length; i += 4) {
        const l = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
        if (l < min) min = l;
        if (l > max) max = l;
        sum += l;
        n++;
    }
    return n === 0 ? { min: 0, max: 0, mean: 0 } : { min, max, mean: sum / n };
}
