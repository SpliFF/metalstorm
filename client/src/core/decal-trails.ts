/**
 * DecalTrails — PLAN-decal-tracks §2: per-unit track trails as polyline
 * ribbons, replacing the chained-quad mark path for continuous (tread/wheel)
 * categories.
 *
 * Pure data + geometry, no Babylon: the store ingests track segments (one
 * point per unit per arrival, thresholded on distance), and the bake
 * tessellates each trail into ONE triangle-strip ribbon through a centripetal
 * Catmull-Rom spline.
 *
 * What that buys over chained quads (§1 defects):
 *  - Q1 joint double-stamp: interior joints don't exist — a strip shares its
 *    edge vertices, so additive blend never sums the same ground twice within
 *    one trail.
 *  - Q2 polygonal curves: the spline is tessellated adaptively by turn angle,
 *    so arcs are smooth and the extruded edges neither gap nor overlap.
 *  - Q3 pattern phase reset: every vertex carries world-space cumulative arc
 *    length `s` (elmos), so the blit's pattern functions key on a continuous,
 *    world-constant parameter instead of a per-quad 0..1.
 *  - P-c eviction pops: fade is per-POINT (the tail dissolves oldest-first) and
 *    the global budget evicts points, not whole marks.
 *
 * Edge cases per §8: E1 LOS gap/teleport closes the trail and starts a new one
 * (never a giant bridge ribbon); E2 EntityDestroy closes the trail so a reused
 * id starts fresh; E5 points append on arc-length threshold, so a creeping unit
 * doesn't spam near-zero-length points.
 */

/** One sample along a unit's path. */
export interface TrailPoint {
    x: number;
    z: number;
    /** Cumulative arc length from the trail's first point, elmos. Monotonic. */
    s: number;
    /** Store clock (seconds) when the point was laid — drives per-point fade. */
    birth: number;
}

/** A contiguous run of one unit's travel. A unit has at most one OPEN trail;
 *  gaps and death close it and later travel starts a new one. */
export interface Trail {
    unitId: number;
    trackTypeId: number;
    /** Track width in elmos (the ribbon's full width). */
    width: number;
    points: TrailPoint[];
    /** False once the trail can never gain points again (gap split / destroy). */
    open: boolean;
}

/** One ribbon station: two vertices (across = ∓1) share this position. */
export interface RibbonStation {
    /** Centreline position (elmos). */
    x: number;
    z: number;
    /** Unit normal ⟂ travel; ribbon verts sit at centre ± normal·halfWidth. */
    nx: number;
    nz: number;
    /** Cumulative arc length along the TESSELLATED curve, elmos (monotonic). */
    s: number;
    /** Age coverage 0..1 at this station (tail tapers out point-by-point). */
    fade: number;
}

export interface TrailStoreOptions {
    /** Minimum travel between points, elmos (E5). Default 6. */
    minStep?: number;
    /** A jump longer than width × this closes the trail (E1). Default 8. */
    gapWidths?: number;
    /** Per-trail point cap. Default 256. */
    perTrailPoints?: number;
    /** Global live-point budget across all trails. Default 24576. */
    pointBudget?: number;
    /** Points stay full strength this long, seconds. Default 300. */
    fadeHoldS?: number;
    /** Then fade linearly to 0 over this long, seconds. Default 300. */
    fadeOutS?: number;
}

export interface TessellateOptions {
    /** Max turn per tessellated sub-segment, radians. Default 0.22 (~13°). */
    maxTurnRad?: number;
    /** Max sub-segments per polyline segment. Default 8. */
    maxSubdiv?: number;
    /** Hard cap on stations for one trail. Default 1024. */
    maxStations?: number;
}

const DEF: Required<TrailStoreOptions> = {
    minStep: 6,
    gapWidths: 8,
    perTrailPoints: 256,
    pointBudget: 24576,
    fadeHoldS: 300,
    fadeOutS: 300,
};

const TESS: Required<TessellateOptions> = {
    maxTurnRad: 0.22,
    maxSubdiv: 8,
    maxStations: 1024,
};

export class TrailStore {
    private opt: Required<TrailStoreOptions>;
    /** unitId → its currently open trail. */
    private openTrails = new Map<number, Trail>();
    /** Every live trail (open and closed), oldest-first by creation. */
    private live: Trail[] = [];
    private points = 0;
    /** Seconds since construction; advanced by {@link tick}. */
    private clock = 0;

    constructor(options: TrailStoreOptions = {}) {
        this.opt = { ...DEF, ...options };
    }

    get elapsed(): number { return this.clock; }
    get pointCount(): number { return this.points; }
    get trailCount(): number { return this.live.length; }

    tick(dt: number): void { this.clock += dt; }

    /** Feed one track segment. Returns true if a point was laid (false when
     *  the unit hasn't travelled far enough yet — E5). */
    append(unitId: number, x: number, z: number, trackTypeId: number, width: number): boolean {
        const w = width > 0 ? width : 24;
        let t = this.openTrails.get(unitId);

        if (t) {
            const last = t.points[t.points.length - 1];
            const d = Math.hypot(x - last.x, z - last.z);
            if (d > w * this.opt.gapWidths) {
                // E1: out of LOS / teleport / id reuse. Close, don't bridge.
                this.close(unitId);
                t = undefined;
            } else if (d < this.opt.minStep) {
                return false; // E5
            } else {
                this.push(t, { x, z, s: last.s + d, birth: this.clock });
                return true;
            }
        }

        t = { unitId, trackTypeId, width: w, points: [], open: true };
        this.push(t, { x, z, s: 0, birth: this.clock });
        this.openTrails.set(unitId, t);
        this.live.push(t);
        return true;
    }

    /** Close a unit's open trail (EntityDestroy — E2 / P-d). Its points stay
     *  live and fade out normally; a reused id starts a fresh trail. */
    close(unitId: number): void {
        const t = this.openTrails.get(unitId);
        if (!t) return;
        t.open = false;
        this.openTrails.delete(unitId);
    }

    /** Drop faded-out points from trail tails, evict oldest points over the
     *  global budget, and reap empty trails. Call once per bake tick. */
    retire(): void {
        const cutoff = this.clock - (this.opt.fadeHoldS + this.opt.fadeOutS);
        for (const t of this.live) {
            let drop = 0;
            while (drop < t.points.length && t.points[drop].birth <= cutoff) drop++;
            if (drop) { t.points.splice(0, drop); this.points -= drop; }
        }
        // Global budget: shed the oldest tail point anywhere, one at a time, so
        // history recedes evenly instead of whole trails popping (P-c).
        while (this.points > this.opt.pointBudget) {
            let oldest: Trail | null = null;
            for (const t of this.live) {
                if (!t.points.length) continue;
                if (!oldest || t.points[0].birth < oldest.points[0].birth) oldest = t;
            }
            if (!oldest) break;
            oldest.points.shift();
            this.points--;
        }
        this.reap();
    }

    /** Every live trail, oldest-first (includes single-point ones). */
    trails(): readonly Trail[] { return this.live; }

    /** Live trails with enough points to draw a ribbon. */
    drawable(): Trail[] {
        return this.live.filter((t) => t.points.length >= 2);
    }

    /** Forget everything (map change / reconnect). */
    clear(): void {
        this.openTrails.clear();
        this.live.length = 0;
        this.points = 0;
    }

    /** Age → coverage, matching the mark path's hold-then-linear curve. */
    fadeAt(birth: number): number {
        const age = this.clock - birth;
        if (age <= this.opt.fadeHoldS) return 1;
        const out = this.opt.fadeHoldS + this.opt.fadeOutS;
        if (age >= out) return 0;
        return 1 - (age - this.opt.fadeHoldS) / this.opt.fadeOutS;
    }

    private push(t: Trail, p: TrailPoint): void {
        t.points.push(p);
        this.points++;
        if (t.points.length > this.opt.perTrailPoints) {
            t.points.shift();
            this.points--;
        }
    }

    private reap(): void {
        if (this.live.every((t) => t.points.length)) return;
        for (const t of this.live) {
            if (!t.points.length && t.open) this.openTrails.delete(t.unitId);
        }
        this.live = this.live.filter((t) => t.points.length > 0);
    }
}

/**
 * Tessellate a trail into ribbon stations along a centripetal Catmull-Rom
 * spline through its points. Centripetal (α=0.5) is the variant that cannot
 * overshoot or cusp on sharp input, which is exactly the failure mode of the
 * old straight-quad chain on a turn (Q2).
 *
 * Stations are emitted in order and are strictly increasing in `s`; the bake
 * turns each into two vertices (across = ∓1) and consecutive stations into one
 * quad of the strip, so adjacent quads share their edge vertices exactly.
 */
export function tessellateTrail(
    trail: Trail,
    fade: (birth: number) => number,
    options: TessellateOptions = {},
): RibbonStation[] {
    const o = { ...TESS, ...options };
    const p = trail.points;
    if (p.length < 2) return [];

    // Sample positions (plus the source point's fade, lerped along the segment).
    const xs: number[] = [];
    const zs: number[] = [];
    const fs: number[] = [];
    const budget = Math.max(2, o.maxStations);

    for (let i = 0; i < p.length - 1 && xs.length < budget; i++) {
        const p0 = p[i - 1] ?? p[i];
        const p1 = p[i];
        const p2 = p[i + 1];
        const p3 = p[i + 2] ?? p[i + 1];
        const n = subdivisions(p0, p1, p2, p3, o);
        const f1 = fade(p1.birth);
        const f2 = fade(p2.birth);
        for (let k = 0; k < n && xs.length < budget; k++) {
            const u = k / n;
            const q = catmullRom(p0, p1, p2, p3, u);
            xs.push(q.x); zs.push(q.z); fs.push(f1 + (f2 - f1) * u);
        }
    }
    if (xs.length < budget) {
        const last = p[p.length - 1];
        xs.push(last.x); zs.push(last.z); fs.push(fade(last.birth));
    }
    if (xs.length < 2) return [];

    // Tangents by central difference on the sampled curve → smoothed normals
    // (no per-segment kink); s accumulates along the tessellated curve so the
    // pattern parameter matches what is actually drawn.
    const out: RibbonStation[] = new Array(xs.length);
    let s = p[0].s;
    for (let i = 0; i < xs.length; i++) {
        const a = Math.max(0, i - 1);
        const b = Math.min(xs.length - 1, i + 1);
        let tx = xs[b] - xs[a];
        let tz = zs[b] - zs[a];
        const tl = Math.hypot(tx, tz);
        if (tl > 1e-6) { tx /= tl; tz /= tl; } else { tx = 0; tz = 1; }
        if (i > 0) s += Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
        // Normal ⟂ travel, matching the mark path's across-axis convention.
        out[i] = { x: xs[i], z: zs[i], nx: tz, nz: -tx, s, fade: fs[i] };
    }
    return out;
}

/** Sub-segments for one polyline segment: straights stay at 1 (2 verts per
 *  point, §2), turns subdivide until each step bends less than maxTurnRad. */
function subdivisions(
    p0: TrailPoint, p1: TrailPoint, p2: TrailPoint, p3: TrailPoint,
    o: Required<TessellateOptions>,
): number {
    const turn = Math.max(angleBetween(p0, p1, p2), angleBetween(p1, p2, p3));
    if (!(turn > 0)) return 1;
    return Math.min(o.maxSubdiv, Math.max(1, Math.ceil(turn / o.maxTurnRad)));
}

function angleBetween(a: TrailPoint, b: TrailPoint, c: TrailPoint): number {
    const ux = b.x - a.x, uz = b.z - a.z;
    const vx = c.x - b.x, vz = c.z - b.z;
    const ul = Math.hypot(ux, uz), vl = Math.hypot(vx, vz);
    if (ul < 1e-6 || vl < 1e-6) return 0;
    const dot = (ux * vx + uz * vz) / (ul * vl);
    return Math.acos(Math.min(1, Math.max(-1, dot)));
}

/** Centripetal (α=0.5) Catmull-Rom at u∈[0,1) on the p1→p2 span. */
function catmullRom(
    p0: TrailPoint, p1: TrailPoint, p2: TrailPoint, p3: TrailPoint, u: number,
): { x: number; z: number } {
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    if (!(t2 > t1)) return { x: p1.x, z: p1.z };
    const t = t1 + (t2 - t1) * u;

    const a1 = lerpT(p0, p1, t0, t1, t);
    const a2 = lerpT(p1, p2, t1, t2, t);
    const a3 = lerpT(p2, p3, t2, t3, t);
    const b1 = blend(a1, a2, t0, t2, t);
    const b2 = blend(a2, a3, t1, t3, t);
    return blend(b1, b2, t1, t2, t);
}

function knot(a: { x: number; z: number }, b: { x: number; z: number }): number {
    // Centripetal exponent 0.5; a floor keeps coincident points non-degenerate.
    return Math.max(1e-4, Math.sqrt(Math.hypot(b.x - a.x, b.z - a.z)));
}

function lerpT(
    a: { x: number; z: number }, b: { x: number; z: number },
    ta: number, tb: number, t: number,
): { x: number; z: number } {
    return blend(a, b, ta, tb, t);
}

function blend(
    a: { x: number; z: number }, b: { x: number; z: number },
    ta: number, tb: number, t: number,
): { x: number; z: number } {
    if (!(tb > ta)) return { x: a.x, z: a.z };
    const w = (t - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * w, z: a.z + (b.z - a.z) * w };
}

/**
 * Write the triangle indices for one ribbon strip of `stationCount` stations
 * whose vertices start at `base` (two per station: across = −1 then +1).
 *
 * Quad k is (base+2k, base+2k+1, base+2k+2, base+2k+3) — so quad k and quad k+1
 * SHARE the two vertices base+2k+2 / base+2k+3 exactly. That is what makes the
 * ribbon joint-free under additive blend (§1 Q1): there is no second surface at
 * a joint to sum a second time.
 *
 * Returns the next free index slot.
 */
export function writeRibbonIndices(
    stationCount: number, base: number, out: Uint32Array, at: number,
): number {
    for (let k = 0; k < stationCount - 1; k++) {
        const q = base + k * 2;
        out[at++] = q; out[at++] = q + 1; out[at++] = q + 2;
        out[at++] = q + 1; out[at++] = q + 3; out[at++] = q + 2;
    }
    return at;
}
