import { describe, it, expect } from 'vitest';
import { buildShoreDepthData, SHORE_DEPTH_RANGE_ELMOS, type HeightmapSource } from './water-surface.js';

/** A 3x3-corner heightmap: dry land (row 0), a shoreline (row 1, y=0), and
 *  progressively deeper water (row 2). minHeight/maxHeight span [-100, 50]
 *  so the uint16 encoding below is exact at these sample points. */
function makeSource(): HeightmapSource {
    const minHeight = -100;
    const maxHeight = 50;
    const range = maxHeight - minHeight;
    const encode = (worldY: number): number => Math.round(((worldY - minHeight) / range) * 65535);
    // rows: y=+20 (land), y=0 (shore), y=-40 (deep water)
    const heightmap = new Uint16Array([
        encode(20), encode(20), encode(20),
        encode(0), encode(0), encode(0),
        encode(-40), encode(-40), encode(-40),
    ]);
    return { heightmap, mapx: 2, mapy: 2, minHeight, maxHeight };
}

describe('buildShoreDepthData', () => {
    it('encodes dry land and the waterline as zero depth', () => {
        const size = 3;
        const data = buildShoreDepthData(makeSource(), size);
        expect(data[0]).toBe(0);       // land row
        expect(data[size]).toBe(0);    // shoreline row (y=0)
    });

    it('encodes deep water proportional to depth-below-zero', () => {
        const size = 3;
        const data = buildShoreDepthData(makeSource(), size);
        const expected = Math.round((40 / SHORE_DEPTH_RANGE_ELMOS) * 255);
        expect(data[size * 2]).toBe(expected);
    });

    it('clamps depth beyond the encoding range to 255', () => {
        const minHeight = -500;
        const maxHeight = 0;
        const src: HeightmapSource = {
            heightmap: new Uint16Array([0, 0, 0, 0]),  // all at minHeight = -500
            mapx: 1, mapy: 1, minHeight, maxHeight,
        };
        const data = buildShoreDepthData(src, 2);
        expect(data[0]).toBe(255);
    });

    it('produces a size*size buffer', () => {
        const data = buildShoreDepthData(makeSource(), 8);
        expect(data.length).toBe(64);
    });
});
