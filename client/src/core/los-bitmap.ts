/**
 * LOS bitmap stream — parses envelope 0x07 frames into a per-allyteam
 * fog-of-war snapshot. Three bit-packed planes:
 *
 *   - inLos:    squares the ally team currently sees via ground LOS
 *   - inRadar:  squares in radar or air-LOS (folded together)
 *   - explored: sticky bit — once any square was in LOS it stays set
 *
 * Wire format (matches `IntelEventCollector::BuildLosBitmap`):
 *
 *   u8  envelope = 0x07
 *   u8  ally_team
 *   u8  width    (1..64)
 *   u8  height   (1..64)
 *   u32 frame    (little-endian)
 *   N bytes: in-LOS    (ceil(w*h/8))
 *   N bytes: in-radar  (ceil(w*h/8))
 *   N bytes: explored  (ceil(w*h/8))
 *
 * The bitmap is sampled by `lua-spring-api.ts` (`IsPosInLos / InRadar /
 * InAirLos`) and `minimap.ts` (fog overlay). The store is updated when
 * a new envelope arrives — subscribers fire once per ally team per
 * snapshot.
 *
 * Snapshots arrive at ~1 Hz so this is cheap to keep in plain
 * `Uint8Array`s without offscreen-canvas pre-rendering at this layer.
 */

export interface LosBitmap {
    /** Ally team this snapshot describes. */
    allyTeam: number;
    /** Bitmap width in squares (1..64). */
    width: number;
    /** Bitmap height in squares (1..64). */
    height: number;
    /** Sim frame the snapshot was captured at. */
    frame: number;
    /** Bit-packed in-LOS plane (MSB-first per byte). */
    inLos: Uint8Array;
    /** Bit-packed in-radar plane (MSB-first per byte). Includes air-LOS. */
    inRadar: Uint8Array;
    /** Bit-packed sticky-explored plane (MSB-first per byte). */
    explored: Uint8Array;
}

/** Parse envelope-stripped LOS bitmap payload (the leading 0x07 byte
 *  has already been consumed by the connection dispatcher).
 *  Returns null on malformed input. */
export function parseLosBitmap(data: Uint8Array): LosBitmap | null {
    if (data.length < 7) return null;
    const allyTeam = data[0];
    const width = data[1];
    const height = data[2];
    if (width === 0 || height === 0 || width > 64 || height > 64) return null;
    const frame = data[3]
        | (data[4] << 8)
        | (data[5] << 16)
        | (data[6] << 24);
    const planeBytes = (width * height + 7) >> 3;
    const expected = 7 + planeBytes * 3;
    if (data.length < expected) return null;
    return {
        allyTeam,
        width,
        height,
        frame,
        inLos:    data.slice(7,                 7 + planeBytes),
        inRadar:  data.slice(7 + planeBytes,    7 + planeBytes * 2),
        explored: data.slice(7 + planeBytes * 2, 7 + planeBytes * 3),
    };
}

/** Test a single bit (col, row). MSB-first per byte. Returns false
 *  for out-of-bounds coordinates. */
export function sampleBit(plane: Uint8Array, col: number, row: number,
                          width: number, height: number): boolean {
    if (col < 0 || col >= width || row < 0 || row >= height) return false;
    const idx = row * width + col;
    const byte = idx >> 3;
    const bit = 7 - (idx & 7);
    return (plane[byte] & (1 << bit)) !== 0;
}

/** Convert world (elmo) coords to bitmap (col, row). Clamped to the
 *  bitmap edge; callers usually want `sampleBit` which range-checks. */
export function worldToSquare(x: number, z: number,
                              mapWidthElmos: number, mapHeightElmos: number,
                              bitmapWidth: number, bitmapHeight: number)
    : { col: number; row: number }
{
    const colF = (x / mapWidthElmos) * bitmapWidth;
    const rowF = (z / mapHeightElmos) * bitmapHeight;
    let col = Math.floor(colF);
    let row = Math.floor(rowF);
    if (col < 0) col = 0;
    else if (col >= bitmapWidth) col = bitmapWidth - 1;
    if (row < 0) row = 0;
    else if (row >= bitmapHeight) row = bitmapHeight - 1;
    return { col, row };
}

type Listener = (bitmap: LosBitmap) => void;

/** Per-allyteam bitmap store. Singleton instance in `main.ts`.
 *  Holds the latest snapshot per ally team; renderers / lua APIs
 *  poll `getMostRecent(allyTeam)` each frame. Subscribers fire once
 *  per envelope arrival (slow — ~1 Hz). */
export class LosBitmapStore {
    private bitmaps = new Map<number, LosBitmap>();
    private listeners = new Set<Listener>();

    /** Replace the snapshot for one ally team. Fires all subscribers. */
    set(bitmap: LosBitmap): void {
        this.bitmaps.set(bitmap.allyTeam, bitmap);
        for (const l of this.listeners) l(bitmap);
    }

    /** Last-seen bitmap for `allyTeam`, or undefined if none yet. */
    get(allyTeam: number): LosBitmap | undefined {
        return this.bitmaps.get(allyTeam);
    }

    /** Iterate every ally team we have a bitmap for. */
    forEach(fn: (bitmap: LosBitmap) => void): void {
        this.bitmaps.forEach(fn);
    }

    /** Drop all cached bitmaps (e.g. on game restart). */
    clear(): void {
        this.bitmaps.clear();
    }

    subscribe(l: Listener): () => void {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    }
}
