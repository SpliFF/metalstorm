/**
 * feature-lod.ts — pure spatial-chunking + tier-assignment logic for the
 * map-feature LOD system (PLAN-maps.md M6 / §1.4).
 *
 * Why chunking at all: thin instances are an ALL-OR-NOTHING draw. One mesh
 * holding every tree on the map is either fully drawn or fully culled, so a
 * 30k-tree forest costs full vertex throughput even when 95% of it is behind
 * the camera. Partitioning the placements into world-space tiles gives Babylon
 * a per-tile bounding box to frustum-cull, and gives us a unit at which to
 * swap representation (full mesh <-> impostor card <-> nothing).
 *
 * Why per-TILE and not per-INSTANCE tiers: per-instance distance sorting means
 * rebuilding thin-instance matrix buffers every time the camera moves
 * (measured at 2.5-4 ms + 2.4 MiB of garbage per frame at 100k instances,
 * versus ~0.002 ms for tile-level culling). Per-tile tiers let every matrix
 * buffer be built ONCE, uploaded as a static buffer, and never touched again —
 * tier changes are `setEnabled()` plus a 1-float-per-instance fade attribute.
 *
 * Everything here is pure (no Babylon imports) so it is unit-testable;
 * `feature-lod-renderer.ts` owns the mesh/material side.
 */

/** Which representation a tile is currently drawing. */
export enum FeatureTier {
    /** Full .glb mesh, thin-instanced (today's behaviour). Casts shadows. */
    Near = 'near',
    /** Baked impostor card, thin-instanced. Does NOT cast shadows. */
    Far = 'far',
    /** Nothing drawn — the terrain far-field bake carries the read at this
     *  zoom (impostors are sub-pixel past ~10k elmos). */
    Culled = 'culled',
}

export interface FeatureLodConfig {
    /** Master switch. Off = every tile pinned to Near (today's behaviour). */
    enabled: boolean;
    /** World-space tile edge, elmos. Larger = fewer draw calls, coarser cull. */
    tileSize: number;
    /** Tile distance beyond which the tile swaps to impostor cards. */
    impostorDistance: number;
    /** Tile distance beyond which NEAR tiles stop CSM shadow-casting. Babylon
     *  submits every caster to every cascade (no per-cascade culling), so
     *  vegetation casting is ~4x its main-pass vertex cost — measured 2026-07-27
     *  on Meridian: full near-tier casting cost ~18 ms/frame at close zoom.
     *  Shadows only read at close range anyway. */
    shadowDistance: number;
    /** Tile distance beyond which the tile draws nothing. */
    cullDistance: number;
    /** Camera height above the map at which ALL feature tiles stop drawing
     *  (whole-map strategic zoom — the terrain bake carries the forest read). */
    cullCameraHeight: number;
    /** Half-width of the dead band around each threshold, elmos. A tile must
     *  travel this far past a boundary before it switches back. */
    hysteresis: number;
    /** Dither crossfade duration when a tile changes tier, ms. */
    crossfadeMs: number;
    /** Minimum wall-clock gap between re-partition passes, ms. */
    updateIntervalMs: number;
    /** Camera must move this far (elmos) before a re-partition pass runs. */
    cameraMoveEpsilon: number;
    /** Fraction of each far tile's instances actually drawn (1 = all). The
     *  matrix buffer is distance-sorted from the tile centre at build time, so
     *  thinning is a pure `thinInstanceCount` write — zero uploads. */
    farDensity: number;
    /** Per-type HEAD probe for `<stem>_impostor.ktx2` when a map ships no
     *  `impostors.json` manifest. Off by default: it costs one 404 per feature
     *  type on every legacy map. */
    probePerType: boolean;
}

export const DEFAULT_FEATURE_LOD_CONFIG: FeatureLodConfig = {
    enabled: true,
    tileSize: 2048,
    impostorDistance: 2500,
    shadowDistance: 1200,
    cullDistance: 10000,
    cullCameraHeight: 10000,
    hysteresis: 256,
    crossfadeMs: 400,
    updateIntervalMs: 250,
    cameraMoveEpsilon: 128,
    farDensity: 1,
    // One HEAD per feature type on maps with no impostors.json manifest —
    // cheap (a handful of 404s on legacy maps), and it's what activates the
    // tiled impostor path for maps that ship per-model atlas sidecars but no
    // map-level manifest (the mapconverter path today). Without it a 54k-tree
    // map falls back to whole-map full-mesh batches (~17M tris/frame — the
    // measured 6 fps failure on Meridian, 2026-07-27).
    probePerType: true,
};

/** One feature placement, stripped to what the LOD math needs. */
export interface LodPlacement {
    x: number;
    y: number;
    z: number;
    /** Yaw, radians (Babylon RH, 0 = +Z) — drives the impostor atlas column. */
    rotation: number;
    /** Uniform scale applied to the model / card. */
    scale: number;
}

/** Model extents used to inflate a tile's bounding box so a tree standing at
 *  the tile edge doesn't get culled by its own trunk position. */
export interface LodModelExtent {
    /** Horizontal radius at scale 1, elmos. */
    radius: number;
    /** Height at scale 1, elmos. */
    height: number;
}

export interface FeatureTile {
    /** Grid coordinates (floor(x / tileSize), floor(z / tileSize)). */
    ix: number;
    iz: number;
    /** `${ix}:${iz}` — stable identity across re-partitions. */
    key: string;
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
    centerX: number; centerY: number; centerZ: number;
    /** Placements in this tile, sorted by distance from the tile centre so a
     *  `thinInstanceCount` prefix is a spatially-even thinning. */
    placements: LodPlacement[];
}

/**
 * Bucket placements into world-space tiles. Tile AABBs are the TIGHT bounds of
 * the placements they hold (inflated by the model extent), not the grid cell —
 * a sparse tile gets a small box and culls better.
 *
 * Placements inside a tile are sorted by distance from the tile centre, which
 * makes `thinInstanceCount = n` a spatially-uniform density reduction (the
 * far-tier `farDensity` lever) instead of lopping off one corner.
 */
export function partitionIntoTiles(
    placements: readonly LodPlacement[],
    tileSize: number,
    model: LodModelExtent = { radius: 0, height: 0 },
): FeatureTile[] {
    const size = tileSize > 0 ? tileSize : 1;
    const byKey = new Map<string, FeatureTile>();

    for (const p of placements) {
        const ix = Math.floor(p.x / size);
        const iz = Math.floor(p.z / size);
        const key = `${ix}:${iz}`;
        const r = model.radius * p.scale;
        const h = model.height * p.scale;
        let tile = byKey.get(key);
        if (!tile) {
            tile = {
                ix, iz, key,
                minX: p.x - r, maxX: p.x + r,
                minY: p.y, maxY: p.y + h,
                minZ: p.z - r, maxZ: p.z + r,
                centerX: 0, centerY: 0, centerZ: 0,
                placements: [],
            };
            byKey.set(key, tile);
        } else {
            if (p.x - r < tile.minX) tile.minX = p.x - r;
            if (p.x + r > tile.maxX) tile.maxX = p.x + r;
            if (p.y < tile.minY) tile.minY = p.y;
            if (p.y + h > tile.maxY) tile.maxY = p.y + h;
            if (p.z - r < tile.minZ) tile.minZ = p.z - r;
            if (p.z + r > tile.maxZ) tile.maxZ = p.z + r;
        }
        tile.placements.push(p);
    }

    const tiles = [...byKey.values()];
    for (const t of tiles) {
        t.centerX = (t.minX + t.maxX) * 0.5;
        t.centerY = (t.minY + t.maxY) * 0.5;
        t.centerZ = (t.minZ + t.maxZ) * 0.5;
        t.placements.sort((a, b) => {
            const da = (a.x - t.centerX) ** 2 + (a.z - t.centerZ) ** 2;
            const db = (b.x - t.centerX) ** 2 + (b.z - t.centerZ) ** 2;
            return da - db;
        });
    }
    // Deterministic order so tile mesh names / stats are stable run to run.
    tiles.sort((a, b) => (a.ix - b.ix) || (a.iz - b.iz));
    return tiles;
}

/** Shortest distance from a point to a tile's AABB (0 when inside). */
export function distanceToTile(tile: FeatureTile, x: number, y: number, z: number): number {
    const dx = x < tile.minX ? tile.minX - x : (x > tile.maxX ? x - tile.maxX : 0);
    const dy = y < tile.minY ? tile.minY - y : (y > tile.maxY ? y - tile.maxY : 0);
    const dz = z < tile.minZ ? tile.minZ - z : (z > tile.maxZ ? z - tile.maxZ : 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Tier for a tile at `distance`, given the tier it is already in.
 *
 * Hysteresis is a symmetric dead band around each threshold: a tile only
 * promotes once it is `hysteresis` INSIDE the boundary and only demotes once
 * it is `hysteresis` OUTSIDE it, so a camera parked on a threshold cannot
 * ping-pong (which would restart the crossfade every frame).
 */
export function assignTier(
    distance: number, current: FeatureTier, cfg: FeatureLodConfig,
): FeatureTier {
    if (!cfg.enabled) return FeatureTier.Near;
    const h = Math.max(0, cfg.hysteresis);
    const nearOut = cfg.impostorDistance + h;   // past this, Near must leave
    const nearIn = cfg.impostorDistance - h;    // inside this, may become Near
    const farOut = cfg.cullDistance + h;        // past this, Far must leave
    const farIn = cfg.cullDistance - h;         // inside this, may become Far

    switch (current) {
        case FeatureTier.Near:
            if (distance <= nearOut) return FeatureTier.Near;
            return distance > farOut ? FeatureTier.Culled : FeatureTier.Far;
        case FeatureTier.Far:
            if (distance < nearIn) return FeatureTier.Near;
            return distance > farOut ? FeatureTier.Culled : FeatureTier.Far;
        default: // Culled
            if (distance >= farIn) return FeatureTier.Culled;
            return distance < nearIn ? FeatureTier.Near : FeatureTier.Far;
    }
}

/** True when the camera has moved far enough to justify a re-partition pass.
 *  `prev` null (first pass) always returns true. */
export function cameraMovedEnough(
    prev: { x: number; y: number; z: number } | null,
    cur: { x: number; y: number; z: number },
    epsilon: number,
): boolean {
    if (!prev) return true;
    const dx = cur.x - prev.x;
    const dy = cur.y - prev.y;
    const dz = cur.z - prev.z;
    return dx * dx + dy * dy + dz * dz >= epsilon * epsilon;
}

/**
 * Whole-tier decision for one tile in one pass. Wraps the camera-height kill
 * switch (strategic zoom drops everything) around `assignTier`.
 */
export function tierForTile(
    tile: FeatureTile,
    camera: { x: number; y: number; z: number },
    current: FeatureTier,
    cfg: FeatureLodConfig,
): FeatureTier {
    if (!cfg.enabled) return FeatureTier.Near;
    if (camera.y >= cfg.cullCameraHeight) return FeatureTier.Culled;
    return assignTier(distanceToTile(tile, camera.x, camera.y, camera.z), current, cfg);
}

/** How many of a far tile's instances to draw at the configured density. At
 *  least one instance survives so a thinned tile never silently vanishes. */
export function farInstanceCount(total: number, farDensity: number): number {
    if (total <= 0) return 0;
    const d = Math.min(1, Math.max(0, farDensity));
    return Math.max(1, Math.round(total * d));
}

/** Tally tiers for the `__featureLod` debug readout. */
export function countTiers(tiers: Iterable<FeatureTier>): {
    near: number; far: number; culled: number;
} {
    let near = 0, far = 0, culled = 0;
    for (const t of tiers) {
        if (t === FeatureTier.Near) near++;
        else if (t === FeatureTier.Far) far++;
        else culled++;
    }
    return { near, far, culled };
}
