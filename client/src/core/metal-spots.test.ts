import { describe, it, expect } from 'vitest';
import { findMetalSpots, nearestMetalSpot, metalSpotMarkerRadius } from './metal-spots.js';

describe('findMetalSpots', () => {
    it('clusters a single connected component into one spot', () => {
        // 3x3 grid, a 2x2 block of density 100 in the corner.
        const mm = new Uint8Array([
            100, 100, 0,
            100, 100, 0,
            0,   0,   0,
        ]);
        const spots = findMetalSpots(mm, 3, 3, 16);
        expect(spots).toHaveLength(1);
        expect(spots[0].totalMetal).toBe(400);
        // Centroid of a 2x2 block at cellSize=16: cells (0,0)-(1,1) → centre (16,16).
        expect(spots[0].x).toBeCloseTo(16);
        expect(spots[0].z).toBeCloseTo(16);
    });

    it('splits non-adjacent (4-connectivity) clusters into separate spots', () => {
        const mm = new Uint8Array([
            50, 0, 50,
            0,  0, 0,
            50, 0, 50,
        ]);
        const spots = findMetalSpots(mm, 3, 3, 16);
        expect(spots).toHaveLength(4);
    });

    it('returns an empty list for an all-zero map', () => {
        expect(findMetalSpots(new Uint8Array(9), 3, 3, 16)).toHaveLength(0);
    });
});

describe('nearestMetalSpot', () => {
    const spots = [
        { x: 0, z: 0, totalMetal: 100, radius: 20 },
        { x: 500, z: 500, totalMetal: 200, radius: 20 },
    ];

    it('returns the closest spot within the search radius', () => {
        expect(nearestMetalSpot(spots, 10, 10, 100)?.x).toBe(0);
    });

    it('returns null when nothing is within range', () => {
        expect(nearestMetalSpot(spots, 250, 250, 50)).toBeNull();
    });
});

describe('metalSpotMarkerRadius', () => {
    it('clamps to the minimum for zero/negative richness', () => {
        expect(metalSpotMarkerRadius(0)).toBe(20);
        expect(metalSpotMarkerRadius(-5)).toBe(20);
    });

    it('grows with the square root of richness', () => {
        const r1 = metalSpotMarkerRadius(100);
        const r2 = metalSpotMarkerRadius(400);
        // sqrt(400)/sqrt(100) == 2 → r2's excess over the floor is 2x r1's.
        expect(r2 - 20).toBeCloseTo((r1 - 20) * 2, 5);
    });

    it('clamps to the maximum for very rich spots', () => {
        expect(metalSpotMarkerRadius(1_000_000)).toBe(90);
    });
});
