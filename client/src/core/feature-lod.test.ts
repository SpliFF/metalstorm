import { describe, it, expect } from 'vitest';
import {
    FeatureTier,
    DEFAULT_FEATURE_LOD_CONFIG,
    partitionIntoTiles,
    distanceToTile,
    assignTier,
    cameraMovedEnough,
    tierForTile,
    farInstanceCount,
    countTiers,
    type FeatureLodConfig,
    type LodPlacement,
} from './feature-lod.js';

// PLAN-maps.md M6 / §1.4 — the pure half of the map-feature impostor LOD:
// spatial chunking (so thin-instance batches can be frustum-culled per tile)
// and tier assignment with hysteresis (so a camera parked on a threshold
// cannot ping-pong and restart the crossfade every pass).

function place(x: number, z: number, y = 0, scale = 1, rotation = 0): LodPlacement {
    return { x, y, z, rotation, scale };
}

function cfg(patch: Partial<FeatureLodConfig> = {}): FeatureLodConfig {
    return { ...DEFAULT_FEATURE_LOD_CONFIG, ...patch };
}

describe('partitionIntoTiles', () => {
    it('buckets placements by world-space tile', () => {
        const tiles = partitionIntoTiles(
            [place(10, 10), place(100, 200), place(2100, 10), place(10, 2100)], 2048);
        expect(tiles.map(t => t.key)).toEqual(['0:0', '0:1', '1:0']);
        expect(tiles.find(t => t.key === '0:0')!.placements).toHaveLength(2);
    });

    it('returns no tiles for no placements', () => {
        expect(partitionIntoTiles([], 2048)).toEqual([]);
    });

    it('handles negative coordinates without collapsing tiles', () => {
        const tiles = partitionIntoTiles([place(-10, -10), place(10, 10)], 2048);
        expect(tiles.map(t => t.key)).toEqual(['-1:-1', '0:0']);
    });

    it('gives each tile the TIGHT bounds of its own placements, not the grid cell', () => {
        const [tile] = partitionIntoTiles([place(100, 200), place(300, 250)], 2048);
        expect(tile.minX).toBe(100);
        expect(tile.maxX).toBe(300);
        expect(tile.minZ).toBe(200);
        expect(tile.maxZ).toBe(250);
    });

    it('inflates bounds by the scaled model extent', () => {
        const [tile] = partitionIntoTiles(
            [place(100, 100, 5, 2)], 2048, { radius: 10, height: 30 });
        expect(tile.minX).toBe(80);   // 100 - 10*2
        expect(tile.maxX).toBe(120);
        expect(tile.minY).toBe(5);
        expect(tile.maxY).toBe(65);   // 5 + 30*2
    });

    it('sorts each tile by distance from its centre so a thinInstanceCount prefix thins evenly', () => {
        const [tile] = partitionIntoTiles(
            [place(0, 0), place(1000, 0), place(500, 0)], 2048);
        // centre is x=500; nearest first
        expect(tile.placements.map(p => p.x)).toEqual([500, 0, 1000]);
    });

    it('emits tiles in a deterministic order', () => {
        const a = partitionIntoTiles([place(5000, 100), place(100, 5000), place(10, 10)], 2048);
        const b = partitionIntoTiles([place(10, 10), place(5000, 100), place(100, 5000)], 2048);
        expect(a.map(t => t.key)).toEqual(b.map(t => t.key));
    });

    it('treats a non-positive tile size as 1 rather than dividing by zero', () => {
        const tiles = partitionIntoTiles([place(0, 0), place(3, 0)], 0);
        expect(tiles).toHaveLength(2);
        expect(tiles.every(t => Number.isFinite(t.centerX))).toBe(true);
    });
});

describe('distanceToTile', () => {
    const [tile] = partitionIntoTiles([place(0, 0), place(100, 100)], 2048);

    it('is zero inside the tile', () => {
        expect(distanceToTile(tile, 50, 0, 50)).toBe(0);
    });

    it('measures to the nearest face, not the centre', () => {
        expect(distanceToTile(tile, 300, 0, 50)).toBe(200);
    });

    it('includes the vertical axis (camera height above a flat forest)', () => {
        expect(distanceToTile(tile, 50, 400, 50)).toBe(400);
    });

    it('is the corner distance when outside on two axes', () => {
        expect(distanceToTile(tile, 200, 0, 200)).toBeCloseTo(Math.hypot(100, 100), 6);
    });
});

describe('assignTier', () => {
    const c = cfg({ impostorDistance: 2500, cullDistance: 10000, hysteresis: 250 });

    it('starts near, swaps to impostor past the outer edge of the dead band', () => {
        expect(assignTier(2600, FeatureTier.Near, c)).toBe(FeatureTier.Near);
        expect(assignTier(2800, FeatureTier.Near, c)).toBe(FeatureTier.Far);
    });

    it('does not swap back until the inner edge of the dead band', () => {
        expect(assignTier(2400, FeatureTier.Far, c)).toBe(FeatureTier.Far);
        expect(assignTier(2200, FeatureTier.Far, c)).toBe(FeatureTier.Near);
    });

    it('never oscillates across the boundary (the whole point of hysteresis)', () => {
        let tier = FeatureTier.Near;
        // Camera parked exactly on the threshold, jittering inside the band.
        for (const d of [2500, 2600, 2400, 2550, 2450, 2500]) {
            tier = assignTier(d, tier, c);
            expect(tier).toBe(FeatureTier.Near);
        }
    });

    it('culls past the far threshold and restores on the way back in', () => {
        expect(assignTier(10400, FeatureTier.Far, c)).toBe(FeatureTier.Culled);
        expect(assignTier(10100, FeatureTier.Culled, c)).toBe(FeatureTier.Culled);
        expect(assignTier(9600, FeatureTier.Culled, c)).toBe(FeatureTier.Far);
    });

    it('can promote culled straight back to near (teleporting camera)', () => {
        expect(assignTier(10, FeatureTier.Culled, c)).toBe(FeatureTier.Near);
    });

    it('can demote near straight to culled', () => {
        expect(assignTier(50000, FeatureTier.Near, c)).toBe(FeatureTier.Culled);
    });

    it('pins everything to near when the system is disabled (today behaviour)', () => {
        const off = cfg({ enabled: false });
        expect(assignTier(999999, FeatureTier.Culled, off)).toBe(FeatureTier.Near);
    });

    it('treats zero hysteresis as a hard threshold', () => {
        const hard = cfg({ impostorDistance: 1000, hysteresis: 0 });
        expect(assignTier(1000, FeatureTier.Near, hard)).toBe(FeatureTier.Near);
        expect(assignTier(1001, FeatureTier.Near, hard)).toBe(FeatureTier.Far);
        expect(assignTier(999, FeatureTier.Far, hard)).toBe(FeatureTier.Near);
    });
});

describe('tierForTile', () => {
    const [tile] = partitionIntoTiles([place(0, 0), place(100, 100)], 2048);

    it('drops everything at strategic zoom regardless of tile distance', () => {
        const c = cfg({ cullCameraHeight: 10000 });
        expect(tierForTile(tile, { x: 50, y: 12000, z: 50 }, FeatureTier.Near, c))
            .toBe(FeatureTier.Culled);
    });

    it('uses the ordinary distance rule below the strategic-zoom height', () => {
        const c = cfg({ cullCameraHeight: 10000, impostorDistance: 2500, hysteresis: 250 });
        expect(tierForTile(tile, { x: 50, y: 500, z: 50 }, FeatureTier.Culled, c))
            .toBe(FeatureTier.Near);
    });

    it('is pinned to near when disabled even at extreme height', () => {
        const c = cfg({ enabled: false, cullCameraHeight: 100 });
        expect(tierForTile(tile, { x: 0, y: 99999, z: 0 }, FeatureTier.Culled, c))
            .toBe(FeatureTier.Near);
    });
});

describe('cameraMovedEnough', () => {
    it('always runs the first pass', () => {
        expect(cameraMovedEnough(null, { x: 0, y: 0, z: 0 }, 128)).toBe(true);
    });

    it('gates on the epsilon sphere', () => {
        const prev = { x: 0, y: 0, z: 0 };
        expect(cameraMovedEnough(prev, { x: 100, y: 0, z: 0 }, 128)).toBe(false);
        expect(cameraMovedEnough(prev, { x: 200, y: 0, z: 0 }, 128)).toBe(true);
    });

    it('counts vertical movement (zooming without panning)', () => {
        expect(cameraMovedEnough({ x: 0, y: 0, z: 0 }, { x: 0, y: 300, z: 0 }, 128)).toBe(true);
    });
});

describe('farInstanceCount', () => {
    it('draws every instance at full density', () => {
        expect(farInstanceCount(1000, 1)).toBe(1000);
    });

    it('thins proportionally', () => {
        expect(farInstanceCount(1000, 0.25)).toBe(250);
    });

    it('never silently empties a non-empty tile', () => {
        expect(farInstanceCount(10, 0)).toBe(1);
    });

    it('is zero for an empty tile and clamps out-of-range density', () => {
        expect(farInstanceCount(0, 1)).toBe(0);
        expect(farInstanceCount(100, 5)).toBe(100);
        expect(farInstanceCount(100, -1)).toBe(1);
    });
});

describe('countTiers', () => {
    it('tallies the debug readout', () => {
        expect(countTiers([
            FeatureTier.Near, FeatureTier.Far, FeatureTier.Far, FeatureTier.Culled,
        ])).toEqual({ near: 1, far: 2, culled: 1 });
    });
});
