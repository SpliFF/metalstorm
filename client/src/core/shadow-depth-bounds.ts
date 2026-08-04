/**
 * PLAN-perf.md **M8** — analytic CSM depth bounds.
 *
 * Babylon fits its four cascades to the visible depth slab by *measuring* it:
 * `CascadedShadowGenerator.autoCalcDepthBounds` renders a second full-resolution
 * scene depth pass, reduces it to 1×1 through a 12-step min/max pyramid, and
 * reads the result back to the CPU every frame. PLAN-perf M4 measured that
 * machinery at **27.7 ms of a 31.1 ms render phase** on the Metalstorm
 * S-battle — not because the passes are expensive, but because the readback is
 * a pipeline sync, so it costs whatever the GPU still owes.
 *
 * For an RTS the slab does not need measuring. The camera pose is known, and
 * every mesh that can cast or receive a sun shadow lives inside one box: the
 * map's XZ extent by its height range (plus headroom for units, trees and
 * buildings standing on it). The visible slab is therefore the range of view
 * depth over `frustum ∩ worldBox`, which is exact convex geometry — the two
 * polytopes' vertices and edge/face crossings, ~24 segment clips per frame.
 *
 * The result is *conservative*: the box spans the map's full height range
 * everywhere, so where the reducer would measure the actual terrain under the
 * camera we take the whole slab. That costs some cascade texel density; it does
 * not cost correctness, because a slab that is too wide still contains every
 * caster. A slab that is too *narrow* would drop shadows, which is why every
 * margin here errs outward.
 *
 * The consumer is `csm.setMinMaxDistance(min, max)` — the manual half of the
 * same knob the reducer drives, in the same units: fractions of the camera's
 * `minZ..maxZ` range (`cascadedShadowGenerator.js` `_splitFrustum`, which
 * inverts them as `near + distance * (far - near)`).
 */

import { Vector3, type Camera, type CascadedShadowGenerator } from '@babylonjs/core';

/** Minimal xyz view — lets the geometry core be tested without a Babylon scene. */
export interface Vec3Like { readonly x: number; readonly y: number; readonly z: number; }

/** World-space axis-aligned box. */
export interface WorldBox {
    minX: number; minY: number; minZ: number;
    maxX: number; maxY: number; maxZ: number;
}

/**
 * A perspective frustum in world space, in the form the depth-range solver
 * wants: an orthonormal camera basis plus the projection's NDC scales.
 * At view depth `d` the frustum's half-extents are `d / xScale` across
 * `right` and `d / yScale` across `up` (that is what `m[0]` / `m[5]` of a
 * Babylon perspective matrix mean, both handednesses).
 */
export interface ViewFrustum {
    pos: Vec3Like;
    right: Vec3Like;
    up: Vec3Like;
    /** Unit vector the camera actually looks along. */
    forward: Vec3Like;
    xScale: number;
    yScale: number;
    near: number;
    far: number;
}

/**
 * What the frustum/box intersection yields: the depth slab (world units along
 * the camera's forward axis) and the XZ footprint it covers. The footprint is
 * what lets the height grid tighten the box — see `ShadowDepthBounds.update`.
 */
export interface FrustumBoxHit {
    minDepth: number; maxDepth: number;
    minX: number; maxX: number;
    minZ: number; maxZ: number;
}

// ── Geometry core ──────────────────────────────────────────────────────

/** Frustum corner ring order, so `j → (j+1) % 4` walks a face. */
const RING_SX = [-1, 1, 1, -1];
const RING_SY = [-1, -1, 1, 1];

/** 12 frustum edges: near ring, far ring, then the four connecting struts. */
const FRUSTUM_EDGES = [
    0, 1, 1, 2, 2, 3, 3, 0,
    4, 5, 5, 6, 6, 7, 7, 4,
    0, 4, 1, 5, 2, 6, 3, 7,
];

/** 12 box edges: corner index is `bx | by<<1 | bz<<2`, so an edge is a bit flip. */
const BOX_EDGES = (() => {
    const e: number[] = [];
    for (let i = 0; i < 8; i++) {
        for (let bit = 0; bit < 3; bit++) {
            const j = i | (1 << bit);
            if (j !== i) e.push(i, j);
        }
    }
    return e;
})();

// Scratch — this runs once per frame from one call site, so the buffers are
// module-level rather than re-allocated.
const FC = new Float64Array(24);   // frustum corners, world xyz
const FD = new Float64Array(8);    // frustum corner view depths
const BC = new Float64Array(24);   // box corners, world xyz
const BV = new Float64Array(24);   // box corners, view-space (vx, vy, vz)

/**
 * View-depth range and XZ footprint of `frustum ∩ box`, or `null` when they do
 * not intersect (the camera is looking away from the world, or past its edge).
 *
 * Exact, not sampled: the extremes of a linear function over the intersection
 * of two convex polytopes are attained at a vertex of the intersection, and
 * every such vertex is either a vertex of one polytope inside the other or a
 * point where an edge of one crosses a face of the other. Clipping all 12
 * frustum edges against the box and all 12 box edges against the frustum
 * enumerates exactly that set — so depth, x and z (all linear) are all bounded
 * exactly by the same sweep.
 */
export function viewDepthRangeOfBox(view: ViewFrustum, box: WorldBox): FrustumBoxHit | null {
    const { pos, right, up, forward, xScale, yScale, near, far } = view;
    if (!(xScale > 0) || !(yScale > 0) || !(far > near)) return null;
    if (box.maxX < box.minX || box.maxY < box.minY || box.maxZ < box.minZ) return null;

    // Frustum corners: near ring then far ring.
    for (let di = 0; di < 2; di++) {
        const d = di === 0 ? near : far;
        const ex = d / xScale, ey = d / yScale;
        for (let j = 0; j < 4; j++) {
            const ax = RING_SX[j] * ex, ay = RING_SY[j] * ey;
            const k = (di * 4 + j) * 3;
            FC[k] = pos.x + right.x * ax + up.x * ay + forward.x * d;
            FC[k + 1] = pos.y + right.y * ax + up.y * ay + forward.y * d;
            FC[k + 2] = pos.z + right.z * ax + up.z * ay + forward.z * d;
            FD[di * 4 + j] = d;
        }
    }

    // Box corners, in world and in the camera's basis.
    for (let i = 0; i < 8; i++) {
        const k = i * 3;
        const cx = (i & 1) ? box.maxX : box.minX;
        const cy = (i & 2) ? box.maxY : box.minY;
        const cz = (i & 4) ? box.maxZ : box.minZ;
        BC[k] = cx; BC[k + 1] = cy; BC[k + 2] = cz;
        const dx = cx - pos.x, dy = cy - pos.y, dz = cz - pos.z;
        BV[k] = dx * right.x + dy * right.y + dz * right.z;
        BV[k + 1] = dx * up.x + dy * up.y + dz * up.z;
        BV[k + 2] = dx * forward.x + dy * forward.y + dz * forward.z;
    }

    let lo = Infinity, hi = -Infinity;
    let xLo = Infinity, xHi = -Infinity, zLo = Infinity, zHi = -Infinity;

    /** Record one vertex of the intersection, given the edge endpoints + `t`. */
    const hit = (ax: number, az: number, bx: number, bz: number,
                 da: number, db: number, t: number): void => {
        const d = da + (db - da) * t;
        if (d < lo) lo = d; if (d > hi) hi = d;
        const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        if (x < xLo) xLo = x; if (x > xHi) xHi = x;
        if (z < zLo) zLo = z; if (z > zHi) zHi = z;
    };

    // (a) frustum vertices inside the box + (b) frustum edges crossing box faces
    for (let e = 0; e < FRUSTUM_EDGES.length; e += 2) {
        const ia = FRUSTUM_EDGES[e], ib = FRUSTUM_EDGES[e + 1];
        const ka = ia * 3, kb = ib * 3;
        const ax = FC[ka], ay = FC[ka + 1], az = FC[ka + 2];
        const bx = FC[kb], by = FC[kb + 1], bz = FC[kb + 2];
        clipReset();
        if (!clipBy(ax - box.maxX, bx - box.maxX)) continue;
        if (!clipBy(box.minX - ax, box.minX - bx)) continue;
        if (!clipBy(ay - box.maxY, by - box.maxY)) continue;
        if (!clipBy(box.minY - ay, box.minY - by)) continue;
        if (!clipBy(az - box.maxZ, bz - box.maxZ)) continue;
        if (!clipBy(box.minZ - az, box.minZ - bz)) continue;
        hit(ax, az, bx, bz, FD[ia], FD[ib], clipLo);
        hit(ax, az, bx, bz, FD[ia], FD[ib], clipHi);
    }

    // (c) box vertices inside the frustum + (d) box edges crossing frustum faces
    for (let e = 0; e < BOX_EDGES.length; e += 2) {
        const ia = BOX_EDGES[e], ib = BOX_EDGES[e + 1];
        const ka = ia * 3, kb = ib * 3;
        const vxa = BV[ka], vya = BV[ka + 1], vza = BV[ka + 2];
        const vxb = BV[kb], vyb = BV[kb + 1], vzb = BV[kb + 2];
        clipReset();
        if (!clipBy(near - vza, near - vzb)) continue;
        if (!clipBy(vza - far, vzb - far)) continue;
        if (!clipBy(xScale * vxa - vza, xScale * vxb - vzb)) continue;
        if (!clipBy(-xScale * vxa - vza, -xScale * vxb - vzb)) continue;
        if (!clipBy(yScale * vya - vza, yScale * vyb - vzb)) continue;
        if (!clipBy(-yScale * vya - vza, -yScale * vyb - vzb)) continue;
        hit(BC[ka], BC[ka + 2], BC[kb], BC[kb + 2], vza, vzb, clipLo);
        hit(BC[ka], BC[ka + 2], BC[kb], BC[kb + 2], vza, vzb, clipHi);
    }

    if (lo > hi) return null;
    return { minDepth: lo, maxDepth: hi, minX: xLo, maxX: xHi, minZ: zLo, maxZ: zHi };
}

/** Live parameter range of the segment being clipped (see `clipBy`). */
let clipLo = 0, clipHi = 1;

function clipReset(): void { clipLo = 0; clipHi = 1; }

/**
 * Narrow `[clipLo, clipHi]` to the part of the segment satisfying an affine
 * constraint `f <= 0`, given `f` at both endpoints. Returns false once the
 * segment is entirely outside, so the caller can stop early.
 */
function clipBy(fa: number, fb: number): boolean {
    const d = fb - fa;
    if (d === 0) return fa <= 0;
    const t = -fa / d;
    if (d > 0) { if (t < clipHi) clipHi = t; }   // f increases: t is the exit
    else if (t > clipLo) clipLo = t;             // f decreases: t is the entry
    return clipLo <= clipHi;
}

// ── Terrain height range over a footprint ──────────────────────────────

/** Heightmap samples per cell at the finest grid level. */
const HEIGHT_CELL_SAMPLES = 16;

/**
 * Min/max mip pyramid over the map heightmap. Each cell holds the exact height
 * range of the terrain over its own footprint — including the shared boundary
 * with its neighbours, so the interpolated surface between two cells is inside
 * at least one of them.
 *
 * This is what lets the slab follow the terrain instead of the map. A single
 * box spanning the map's whole height range is useless at RTS poses: the
 * camera sits *inside* it (620 elmos up, under a box whose lid is above the
 * tallest mountain on the map), so the near bound collapses to the near plane
 * and a whole cascade is spent on empty air. Per cell, the terrain under the
 * camera is 600 elmos below it and the bound is tight.
 */
export class HeightRangeGrid {
    private readonly levels: { min: Float32Array; max: Float32Array; w: number; h: number; cell: number }[] = [];

    constructor(heightmap: Uint16Array, hmW: number, hmH: number,
                minHeight: number, maxHeight: number, squareSize: number) {
        const scale = (maxHeight - minHeight) / 65535;
        const cell0 = HEIGHT_CELL_SAMPLES;
        const w0 = Math.max(1, Math.ceil((hmW - 1) / cell0));
        const h0 = Math.max(1, Math.ceil((hmH - 1) / cell0));
        const min0 = new Float32Array(w0 * h0).fill(Infinity);
        const max0 = new Float32Array(w0 * h0).fill(-Infinity);
        const add = (cx: number, cz: number, v: number): void => {
            if (cx < 0 || cz < 0 || cx >= w0 || cz >= h0) return;
            const i = cz * w0 + cx;
            if (v < min0[i]) min0[i] = v;
            if (v > max0[i]) max0[i] = v;
        };
        for (let z = 0; z < hmH; z++) {
            const cz = Math.min(h0 - 1, (z / cell0) | 0);
            // A sample sitting exactly on a cell boundary also bounds the
            // terrain inside the previous cell, which interpolates up to it.
            const czPrev = (z % cell0 === 0) ? cz - 1 : cz;
            for (let x = 0; x < hmW; x++) {
                const v = minHeight + heightmap[z * hmW + x] * scale;
                const cx = Math.min(w0 - 1, (x / cell0) | 0);
                const cxPrev = (x % cell0 === 0) ? cx - 1 : cx;
                add(cx, cz, v);
                if (cxPrev !== cx) add(cxPrev, cz, v);
                if (czPrev !== cz) {
                    add(cx, czPrev, v);
                    if (cxPrev !== cx) add(cxPrev, czPrev, v);
                }
            }
        }
        this.levels.push({ min: min0, max: max0, w: w0, h: h0, cell: cell0 * squareSize });
        let prev = this.levels[0];
        while (prev.w > 1 || prev.h > 1) {
            const w = Math.max(1, prev.w >> 1), h = Math.max(1, prev.h >> 1);
            const mn = new Float32Array(w * h).fill(Infinity);
            const mx = new Float32Array(w * h).fill(-Infinity);
            for (let z = 0; z < prev.h; z++) {
                const dz = Math.min(h - 1, z >> 1);
                for (let x = 0; x < prev.w; x++) {
                    const dx = Math.min(w - 1, x >> 1);
                    const s = z * prev.w + x, d = dz * w + dx;
                    if (prev.min[s] < mn[d]) mn[d] = prev.min[s];
                    if (prev.max[s] > mx[d]) mx[d] = prev.max[s];
                }
            }
            const lvl = { min: mn, max: mx, w, h, cell: prev.cell * 2 };
            this.levels.push(lvl);
            prev = lvl;
        }
    }

    /**
     * Visit the cells covering a world-space XZ rectangle, coarsening to
     * whichever pyramid level keeps the scan under `maxCellsPerAxis` per axis.
     * The callback gets the cell's world footprint and its terrain height
     * range. Empty cells (all-`Infinity`, only possible on a degenerate map)
     * are skipped.
     */
    forEachCellInRect(x0: number, x1: number, z0: number, z1: number,
                      maxCellsPerAxis: number,
                      cb: (minX: number, maxX: number, minZ: number, maxZ: number,
                           minH: number, maxH: number) => void): void {
        let li = 0;
        const span = Math.max(x1 - x0, z1 - z0);
        while (li < this.levels.length - 1
               && span / this.levels[li].cell > maxCellsPerAxis) li++;
        const L = this.levels[li];
        const cx0 = clampInt(Math.floor(x0 / L.cell), 0, L.w - 1);
        const cx1 = clampInt(Math.floor(x1 / L.cell), 0, L.w - 1);
        const cz0 = clampInt(Math.floor(z0 / L.cell), 0, L.h - 1);
        const cz1 = clampInt(Math.floor(z1 / L.cell), 0, L.h - 1);
        for (let cz = cz0; cz <= cz1; cz++) {
            for (let cx = cx0; cx <= cx1; cx++) {
                const i = cz * L.w + cx;
                if (!(L.min[i] <= L.max[i])) continue;
                cb(cx * L.cell, (cx + 1) * L.cell, cz * L.cell, (cz + 1) * L.cell,
                   L.min[i], L.max[i]);
            }
        }
    }

    /** Conservative terrain height range over a world-space XZ rectangle. */
    rangeOverRect(x0: number, x1: number, z0: number, z1: number,
                  maxCellsPerAxis = 8): DepthRange {
        let mn = Infinity, mx = -Infinity;
        this.forEachCellInRect(x0, x1, z0, z1, maxCellsPerAxis, (_a, _b, _c, _d, lo, hi) => {
            if (lo < mn) mn = lo;
            if (hi > mx) mx = hi;
        });
        return mn <= mx ? { min: mn, max: mx } : { min: 0, max: 0 };
    }
}

/** Plain numeric range (terrain heights, in world units). */
export interface DepthRange { min: number; max: number; }

function clampInt(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

// ── The per-frame controller ───────────────────────────────────────────

export type ShadowDepthBoundsMode =
    /** M8: derive the slab from camera + map bounds on the CPU (shipped). */
    | 'analytic'
    /** Babylon's depth-reduction pass + GPU→CPU readback (the M4 stall). */
    | 'reduce'
    /** No fitting at all: cascades spread over `minZ..shadowMaxZ`. */
    | 'off';

/**
 * Headroom above each cell's terrain maximum, for everything standing on or
 * flying over it. Erring inward drops a caster out of every cascade and it
 * loses its shadow; erring outward is not free either, so this is sized to the
 * tallest thing in the game and no further — see the warning below.
 *
 * The binding constraint is **aircraft**: map features top out ~60 elmos and
 * structures ~100, but `cruisealtitude` runs to **220**
 * (`data/games/metalstorm/units/fable_bomber.lua`). Since the margin is applied
 * above the cell's terrain *maximum* and cruise altitude is measured above
 * ground level, an aircraft over any point of the cell is at most
 * `cellMax + 220` — so 250 covers the whole air layer, not just most of it.
 *
 * ⚠️ **Do not raise this "to be safe".** The near bound survives only while the
 * box lid stays below the camera; once a nearby cell's `max + margin` rises
 * above the camera the camera is *inside* the box and the near bound collapses
 * to the near plane, which spends three of four cascades on empty air. Measured
 * at the S-battle pose: margin 250 → slab 262..2174 and 8 % of the shadow signal
 * deviating from Babylon's reducer; margin 500 → slab 1..2177 and **31 %**, no
 * better than no fitting at all. If something genuinely flies higher than this,
 * bound the box off the live unit set rather than inflating the constant.
 */
const TERRAIN_Y_MARGIN = 250;

/** Slack below the terrain, for craters the deformable terrain digs. */
const TERRAIN_FLOOR_MARGIN = 60;

/**
 * Height-grid cells scanned per axis when unioning the per-cell slabs. 16
 * bounds the work at 256 `viewDepthRangeOfBox` calls in the worst case (a
 * whole-map zoom-out), which is ~6 k segment clips — microseconds against the
 * 27.7 ms the readback it replaces was costing.
 */
const MAX_CELLS_PER_AXIS = 16;

/** Fraction of the slab added at each end against float error + late movement. */
const SLAB_PAD_FRAC = 0.01;

const LOCAL_RIGHT = Object.freeze(new Vector3(1, 0, 0)) as Vector3;
const LOCAL_UP = Object.freeze(new Vector3(0, 1, 0)) as Vector3;
const LOCAL_FORWARD_RH = Object.freeze(new Vector3(0, 0, -1)) as Vector3;
const LOCAL_FORWARD_LH = Object.freeze(new Vector3(0, 0, 1)) as Vector3;

export class ShadowDepthBounds {
    private mode: ShadowDepthBoundsMode = 'analytic';
    private box: WorldBox | null = null;
    private heights: HeightRangeGrid | null = null;
    private readonly right = new Vector3();
    private readonly up = new Vector3();
    private readonly forward = new Vector3();
    /** Last applied slab, for the `__shadowDepthBounds` debug + A/B hook. */
    private last: { min: number; max: number; nearElmos: number; farElmos: number } | null = null;

    constructor(private readonly csm: CascadedShadowGenerator) {
        this.applyMode();
    }

    /**
     * The world box every shadow-relevant mesh lives in. XZ is the map itself
     * (the terrain is exactly map-sized; the water plane matches it and casts
     * no shadows anyway); Y is the heightmap's range plus headroom. The
     * heightmap, when given, lets `update` cut Y down to the terrain actually
     * under the view instead of the map's global range.
     */
    setMapBounds(widthElmos: number, heightElmos: number,
                 minHeight: number, maxHeight: number,
                 heightmap?: { data: Uint16Array; mapx: number; mapy: number; squareSize: number }): void {
        this.box = {
            minX: 0, maxX: widthElmos,
            minZ: 0, maxZ: heightElmos,
            minY: minHeight - TERRAIN_FLOOR_MARGIN, maxY: maxHeight + TERRAIN_Y_MARGIN,
        };
        this.heights = heightmap
            ? new HeightRangeGrid(heightmap.data, heightmap.mapx + 1, heightmap.mapy + 1,
                                  minHeight, maxHeight, heightmap.squareSize)
            : null;
    }

    setMode(mode: ShadowDepthBoundsMode): ShadowDepthBoundsMode {
        this.mode = mode;
        this.applyMode();
        return mode;
    }

    getMode(): ShadowDepthBoundsMode { return this.mode; }

    /** What the last `update()` applied — the A/B and drift-check handle. */
    getLast(): Readonly<{ min: number; max: number; nearElmos: number; farElmos: number }> | null {
        return this.last;
    }

    private applyMode(): void {
        this.csm.autoCalcDepthBounds = this.mode === 'reduce';
        if (this.mode === 'off') {
            this.csm.setMinMaxDistance(0, 1);
            this.last = null;
        }
    }

    /**
     * Recompute and apply the slab. Call once per frame before `scene.render()`.
     * A no-op unless the mode is `analytic` and the map bounds have landed.
     */
    update(camera: Camera): void {
        if (this.mode !== 'analytic' || !this.box) return;

        // m[0] / m[5] are the NDC scales; on the first frame (or before the
        // camera has ever projected) the matrix is not yet meaningful.
        const pm = camera.getProjectionMatrix().m;
        const xScale = pm[0], yScale = pm[5];
        const near = camera.minZ, far = camera.maxZ;
        if (!(xScale > 0) || !(yScale > 0) || !(far > near)) return;

        // Right-handed scene: the camera looks down local -Z. Vector3.Forward
        // honours the scene's handedness, so read it off the scene rather than
        // hardcoding a sign (game-processor sets useRightHandedSystem = true).
        camera.getDirectionToRef(LOCAL_RIGHT, this.right);
        camera.getDirectionToRef(LOCAL_UP, this.up);
        camera.getDirectionToRef(
            camera.getScene().useRightHandedSystem ? LOCAL_FORWARD_RH : LOCAL_FORWARD_LH,
            this.forward);

        const view: ViewFrustum = {
            pos: camera.globalPosition,
            right: this.right, up: this.up, forward: this.forward,
            xScale, yScale, near, far,
        };

        // Pass 1: the map-wide box, which gives the XZ footprint to refine over.
        const coarse = viewDepthRangeOfBox(view, this.box);

        // Nothing of the world in view (map edge, camera pointed at sky). Leave
        // the previous slab in place rather than collapsing the cascades — an
        // empty frame has nothing to shadow either way, and the next frame that
        // does see the world re-fits immediately.
        if (!coarse) return;

        // Pass 2: union the slab over the terrain cells under that footprint.
        // Each cell is its own little box — cell footprint by cell height range
        // — so the bound follows the ground instead of spanning every mountain
        // on the map. Cells the frustum misses drop out for free.
        let minDepth = coarse.minDepth, maxDepth = coarse.maxDepth;
        if (this.heights) {
            let lo = Infinity, hi = -Infinity;
            const cellBox: WorldBox = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
            this.heights.forEachCellInRect(
                coarse.minX, coarse.maxX, coarse.minZ, coarse.maxZ, MAX_CELLS_PER_AXIS,
                (x0, x1, z0, z1, minH, maxH) => {
                    cellBox.minX = x0; cellBox.maxX = x1;
                    cellBox.minZ = z0; cellBox.maxZ = z1;
                    cellBox.minY = minH - TERRAIN_FLOOR_MARGIN;
                    cellBox.maxY = maxH + TERRAIN_Y_MARGIN;
                    const r = viewDepthRangeOfBox(view, cellBox);
                    if (!r) return;
                    if (r.minDepth < lo) lo = r.minDepth;
                    if (r.maxDepth > hi) hi = r.maxDepth;
                });
            // A refined miss means the coarse box only intersected through air
            // above the terrain; keep the coarse slab rather than nothing.
            if (lo <= hi) { minDepth = lo; maxDepth = hi; }
        }

        const pad = (maxDepth - minDepth) * SLAB_PAD_FRAC;
        const lo = Math.max(near, minDepth - pad);
        const hi = Math.min(far, maxDepth + pad);
        const span = far - near;
        const minDistance = clamp01((lo - near) / span);
        const maxDistance = clamp01((hi - near) / span);
        if (maxDistance <= minDistance) return;

        this.csm.setMinMaxDistance(minDistance, maxDistance);
        this.last = { min: minDistance, max: maxDistance, nearElmos: lo, farElmos: hi };
    }
}

function clamp01(v: number): number {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
