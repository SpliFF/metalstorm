/**
 * cosmetic-flight — the invented trajectory of a Tier-C shot (PLAN-latency
 * L2.2). Design rationale in PLAN-latency-impl.md §"Phase L2" and
 * PLAN-latency-projectiles.md §3.
 *
 * A weapon def classified `FX_TIER_COSMETIC` (L2.0) gets no sim projectile at
 * all: the server resolves the whole shot at fire time (rts/Sim/Weapons/
 * CosmeticFire.cpp) and sends one `FireOutcomeEvent` carrying the muzzle
 * position, the terminal position, and the two sim frames that bracket the
 * flight. Nothing streams in between.
 *
 * That absence is the feature. Every other projectile the client draws is
 * chasing a truth it only learns about late — it extrapolates from the last
 * server sample and snaps when a correction arrives (see the extrapolate-and-
 * snap loop and `TRAIL_RESET_DELTA_SQ` in projectile-renderer.ts, which exist
 * solely to make that snap less visible). A Tier-C shot knows both ends up
 * front, so the client can pick the arc through them and be *provably* on the
 * explosion when the explosion happens. No correction exists to be smoothed.
 *
 * Two properties hold by construction:
 *
 *   1. `pos(fireFrame) === origin` and `pos(impactFrame) === impactPos`, exact.
 *      The L1 timeline detonates on `impactFrame`, so bolt and burst coincide.
 *   2. Motion is a function of the presentation cursor `P`, not of wall time.
 *      Pause, speed changes and frame-rate hitches move a Tier-C bolt exactly
 *      as they move the interpolated units it is flying between — both are
 *      parametrised by the same frame.
 *
 * L2.3 adds moving-target tracking on top without giving either of them up: a
 * guided Tier-C shot bends toward where the client now expects its target to
 * be, under a weight that is zero at both ends of the flight and a correction
 * that is a function of the cursor and the current pose sample only. See
 * `applyCosmeticTracking`.
 */

/// Sim ticks per game-second. Matches projectile-renderer's own constant; the
/// wire carries velocities per *frame* and the renderer's consumers want them
/// per second.
const SIM_TICKS_PER_SEC = 30;

/// First id handed to an invented Tier-C projectile.
const COSMETIC_ID_BASE = 0x4000_0000;
let cosmeticIdSeq = COSMETIC_ID_BASE;

/**
 * Mint an id for an invented projectile.
 *
 * Tier-C shots have no sim projectile and therefore no server id, but they
 * share the renderer's `live` map — and the A3 mirror's id space — with ones
 * that do, so the ranges must not overlap. Recoil allocates projectile ids
 * densely from 0, so starting at 2^30 leaves a billion real ids before any
 * chance of a collision.
 *
 * Minted by the *scheduler*, not by the spawn, so the `projDetonate` closure
 * has a real id even in the window where the spawn was skipped for want of a
 * renderer. Handing the detonation a placeholder `0` instead would send it
 * into `onImpact` against projectile id 0 — a perfectly ordinary *real* id —
 * and evict someone else's bolt.
 */
export function nextCosmeticProjectileId(): number {
    const id = cosmeticIdSeq;
    cosmeticIdSeq = id + 1 >= 0x7fff_ffff ? COSMETIC_ID_BASE : id + 1;
    return id;
}

/** A solved Tier-C flight: the polynomial, plus the frames it spans. */
export interface CosmeticFlight {
    /// Sim frame the shot leaves the muzzle (= the `projSpawn` schedule frame).
    fireFrame: number;
    /// Sim frame the shot must be on `impactPos` (= the `projDetonate` frame).
    impactFrame: number;
    /// `impactFrame - fireFrame`, always >= 1.
    frames: number;
    ox: number; oy: number; oz: number;
    /// Solved launch velocity, elmos per *sim frame* (the wire's unit).
    vx: number; vy: number; vz: number;
    /// Per-frame² gravity as the server resolved it — signed, negative pulls
    /// down (Recoil's `mygravity` convention, not a magnitude).
    gravity: number;
    ix: number; iy: number; iz: number;
}

/**
 * Solve the launch velocity that carries a shot from `origin` to `impact` in
 * exactly `impactFrame - fireFrame` sim frames under per-frame gravity `g`.
 *
 * Mirrors the server's `CosmeticFlightPos`: p(t) = origin + v·t, with p.y
 * additionally offset by ½·g·t·(t+1). That is the closed form of the sim's own
 * recurrence — `CProjectile::Update` does `speed += g` *before* `pos += speed`,
 * so after n ticks the accumulated drop is g·(1+2+…+n), not the textbook
 * ½·g·t². Gravity does not touch x/z, so the horizontal components are a plain
 * lerp and the vertical one absorbs the whole arc:
 *
 *     v.y = (impact.y − origin.y − ½·g·frames·(frames+1)) / frames
 *
 * The half-step matters: it is a one-directional bias that compounds over the
 * flight, and on the server it was worth a 3.1× damage shortfall before it was
 * corrected (PLAN-latency-impl.md Phase L2.2). Here the endpoints are pinned
 * either way, so getting it wrong would not break convergence — it would just
 * draw a bolt on a subtly different arc from the one the damage was resolved
 * against.
 *
 * This is why the event has to carry `gravity`: the arc through two points in
 * a fixed time is only unique once g is pinned, and `mygravity` is a
 * per-projectile resolution of the def default against the map's gravity that
 * the client cannot reconstruct from weaponDefs.
 *
 * A straight shot is the same formula with g = 0 — no separate solver, and no
 * branch on weapon kind at evaluation time.
 */
export function solveCosmeticFlight(
    origin: { x: number; y: number; z: number },
    impact: { x: number; y: number; z: number },
    fireFrame: number,
    impactFrame: number,
    gravity: number,
): CosmeticFlight {
    // The server guarantees >= 1 frame, but a corrupt or absent field must not
    // divide by zero here: NaN in a flight becomes NaN in a render matrix,
    // which is a black frame rather than a missing bolt.
    const frames = Math.max(1, impactFrame - fireFrame);
    const g = Number.isFinite(gravity) ? gravity : 0;
    return {
        fireFrame,
        impactFrame: fireFrame + frames,
        frames,
        ox: origin.x, oy: origin.y, oz: origin.z,
        ix: impact.x, iy: impact.y, iz: impact.z,
        vx: (impact.x - origin.x) / frames,
        vy: (impact.y - origin.y - 0.5 * g * frames * (frames + 1)) / frames,
        vz: (impact.z - origin.z) / frames,
        gravity: g,
    };
}

/**
 * Position and velocity of a flight `t` frames after launch, written into the
 * caller's vectors (this runs per projectile per render frame — no allocation).
 *
 * `t` is clamped to `[0, frames]`: the flight is never integrated past its own
 * end, so a bolt cannot overshoot its explosion even if the timeline drain and
 * the render tick disagree by a sub-frame, and cannot appear ahead of its
 * muzzle if the cursor is momentarily behind `fireFrame`.
 *
 * Velocity comes back in elmos/second, which is what the renderer's downstream
 * consumers (CEG emit direction, laser shaft basis, trail puffs) expect.
 */
export function evalCosmeticFlight(
    c: CosmeticFlight, t: number,
    pos: { x: number; y: number; z: number },
    vel: { x: number; y: number; z: number },
): void {
    const u = t <= 0 ? 0 : (t >= c.frames ? c.frames : t);
    if (u === c.frames) {
        // Land on the wire's impact point rather than on the polynomial's
        // re-evaluation of it. Algebraically identical; taking it verbatim
        // makes the convergence invariant exact instead of within-epsilon,
        // which is the difference between "lands on the explosion" and "lands
        // on the explosion to within a float rounding".
        pos.x = c.ix; pos.y = c.iy; pos.z = c.iz;
    } else {
        pos.x = c.ox + c.vx * u;
        pos.y = c.oy + c.vy * u + 0.5 * c.gravity * u * (u + 1);
        pos.z = c.oz + c.vz * u;
    }
    vel.x = c.vx * SIM_TICKS_PER_SEC;
    vel.y = (c.vy + c.gravity * u) * SIM_TICKS_PER_SEC;
    vel.z = c.vz * SIM_TICKS_PER_SEC;
}

/* ------------------------------------------------------------------------ *
 * L2.3 — moving-target tracking
 * ------------------------------------------------------------------------ */

/**
 * Fraction of the flight after which the tracking offset is blended back out.
 * PLAN-latency-impl.md's L2.3 line names 10 %.
 */
const TRACK_BLEND_START = 0.9;

/**
 * Peak slope of `smoothstep(x) = x²(3−2x)` on [0,1]. Used to bound the
 * displacement the blend can introduce in a single frame.
 */
const SMOOTHSTEP_MAX_SLOPE = 1.5;

function smoothstep(x: number): number {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return x * x * (3 - 2 * x);
}

function smoothstepSlope(x: number): number {
    if (x <= 0 || x >= 1) return 0;
    return 6 * x * (1 - x);
}

/**
 * How much of the tracking correction applies `u01` of the way through a
 * flight. Ramps in over `[0, 0.9]`, then back out to zero over the last 10 %.
 *
 *   w(0) = 0    — the bolt leaves the muzzle the server reported, exactly.
 *   w(1) = 0    — the bolt is on `impactPos`, exactly, on `impactFrame`.
 *
 * Both endpoints are pinned, so tracking cannot weaken L2.2's convergence
 * invariant — it only bends the middle. The two branches meet at
 * `TRACK_BLEND_START` with value 1 and slope 0, so `w` is C¹ across the whole
 * flight including the join: a kink there would read as the missile flinching.
 */
export function trackingWeight(u01: number): number {
    if (u01 <= 0 || u01 >= 1) return 0;
    return u01 <= TRACK_BLEND_START
        ? smoothstep(u01 / TRACK_BLEND_START)
        : 1 - smoothstep((u01 - TRACK_BLEND_START) / (1 - TRACK_BLEND_START));
}

/** `dw/du01`. Feeds the velocity the CEG trail and follow-light steer by. */
export function trackingWeightSlope(u01: number): number {
    if (u01 <= 0 || u01 >= 1) return 0;
    return u01 <= TRACK_BLEND_START
        ? smoothstepSlope(u01 / TRACK_BLEND_START) / TRACK_BLEND_START
        : -smoothstepSlope((u01 - TRACK_BLEND_START) / (1 - TRACK_BLEND_START))
            / (1 - TRACK_BLEND_START);
}

/**
 * Largest tracking correction a flight may carry, in elmos.
 *
 * Derived from the artifact it exists to prevent rather than picked. The blend
 * moves the bolt by `|C| · w(u01)`; `u01` advances `1/frames` per sim frame, so
 * the extra displacement in a frame peaks at
 *
 *     |C| · max|dw/du01| / frames   =   |C| · 1.5/(1 − 0.9) / frames
 *
 * during the blend-out. Requiring that to stay inside the bolt's own per-frame
 * travel `L/frames` (L = straight-line flight length) gives
 *
 *     |C| <= L · (1 − TRACK_BLEND_START) / SMOOTHSTEP_MAX_SLOPE   =   L/15
 *
 * i.e. **the blend-back can never move the bolt further in a frame than it was
 * already moving**. That is the same criterion the L2 gate measured convergence
 * against ("the final approach step is 0.60× a normal render step"), so a
 * tracked bolt cannot reintroduce the snap L2 exists to remove. A target whose
 * drift exceeds the cap is followed as far as the cap allows and no further —
 * the correction saturates rather than the bolt lurching.
 */
export function maxTrackingOffset(c: CosmeticFlight): number {
    const dx = c.ix - c.ox, dy = c.iy - c.oy, dz = c.iz - c.oz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return len * (1 - TRACK_BLEND_START) / SMOOTHSTEP_MAX_SLOPE;
}

/**
 * How far back of `fireFrame` the second pose sample is taken to estimate the
 * target's velocity. Long enough to be robust to a single jittery sample,
 * short enough to still be inside the interpolator's buffer and to describe
 * the course the target is *currently* on.
 */
export const TRACK_VEL_SAMPLE_LAG = 5;

/**
 * L2.3 tracking state for one invented flight. Non-null only for a Tier-C
 * shot at a unit (`targetId != 0`) fired by a weapon the sim would itself have
 * guided (`weaponDef.tracks`) — a cannon shell that bent toward a dodging
 * target would be less faithful, not more.
 */
export interface CosmeticTracking {
    /// Unit the shot was resolved against.
    targetId: number;
    /// The target's pose at `fireFrame`, and the per-frame velocity the
    /// server's lead assumed for it. Together they are the straight line the
    /// shot was resolved against.
    ax: number; ay: number; az: number;
    vx: number; vy: number; vz: number;
    /// Current correction (clamped). Held at its last value if the target
    /// stops being addressable — decision 2 says a Tier-C shot flies through
    /// to its precomputed impact even when the target dies mid-flight, and
    /// freezing the correction is the version of that which does not jerk.
    cx: number; cy: number; cz: number;
    /// `maxTrackingOffset` of the flight this belongs to.
    maxOffset: number;
}

/**
 * Start tracking a flight by reconstructing the course the *server* assumed
 * for the target when it resolved the shot.
 *
 * `CosmeticFire.cpp` leads its collision walk with `CosmeticPredictedPose` —
 * the target's pose advanced by its own velocity over the flight time, the
 * same constant-velocity assumption `CWeapon` makes when it aims. Rebuilding
 * that line client-side from two past interpolator samples gives a baseline in
 * exactly the same terms, so the correction measures one thing and one thing
 * only: **how far the target has departed from the course the shot was aimed
 * at.** A target that holds its course gives a zero correction and a
 * bit-identical L2.2 flight.
 *
 * Both samples are *past* frames, which is the point. The obvious anchor —
 * "the target's pose at `impactFrame`" — cannot be read at spawn for any flight
 * longer than the presentation delay `D`: entity state only ever reaches the
 * leading edge `E = P + D`, so a query at `impactFrame` falls off the end of the
 * buffer and comes back as the interpolator's bounded extrapolate-then-hold.
 * That was measured, not reasoned about: on a 93-frame ZK missile the resulting
 * correction was the target's *entire* travel during the flight and saturated
 * the offset cap on 836 of 836 samples.
 *
 * Returns null when either sample is missing — with no baseline there is no
 * defined correction, and guessing one would move the bolt off an arc that is
 * otherwise provably right.
 */
export function beginCosmeticTracking(
    c: CosmeticFlight, targetId: number,
    poseAtFire: { x: number; y: number; z: number } | null,
    poseBefore: { x: number; y: number; z: number } | null,
): CosmeticTracking | null {
    if (!targetId || poseAtFire == null || poseBefore == null) return null;
    const vx = (poseAtFire.x - poseBefore.x) / TRACK_VEL_SAMPLE_LAG;
    const vy = (poseAtFire.y - poseBefore.y) / TRACK_VEL_SAMPLE_LAG;
    const vz = (poseAtFire.z - poseBefore.z) / TRACK_VEL_SAMPLE_LAG;
    if (!Number.isFinite(poseAtFire.x + poseAtFire.y + poseAtFire.z + vx + vy + vz))
        return null;
    return {
        targetId,
        ax: poseAtFire.x, ay: poseAtFire.y, az: poseAtFire.z,
        vx, vy, vz,
        cx: 0, cy: 0, cz: 0,
        maxOffset: maxTrackingOffset(c),
    };
}

/**
 * Fold the tracking offset into a position/velocity already written by
 * `evalCosmeticFlight`.
 *
 * `live` is the target's interpolated pose **at the presentation cursor** for
 * this render frame, or null if it can no longer be resolved (dead, out of LOS,
 * evicted). Passing null holds the last correction rather than dropping it, so
 * losing sight of the target does not snap the bolt back onto the base arc.
 *
 * The cursor is the right frame to ask about because it is the only one the
 * client actually *knows*: a real homing missile also steers at where its
 * target is now, not at where it will be. The correction therefore lags a
 * manoeuvre by design, which is what pursuit looks like.
 *
 * Like `evalCosmeticFlight` this stays a pure function of the presentation
 * cursor and the current pose sample — nothing is integrated and no state
 * accumulates, so a cursor that steps *backwards* (measured on ~0.9 % of render
 * ticks, PLAN-latency-impl.md L2 gate finding 2) rewinds a tracked bolt exactly
 * as it rewinds an untracked one.
 */
export function applyCosmeticTracking(
    c: CosmeticFlight, tr: CosmeticTracking, t: number,
    live: { x: number; y: number; z: number } | null,
    pos: { x: number; y: number; z: number },
    vel: { x: number; y: number; z: number },
): void {
    if (live != null) {
        // Where the shot was aimed as if the target had held its course.
        const ex = tr.ax + tr.vx * t, ey = tr.ay + tr.vy * t, ez = tr.az + tr.vz * t;
        let dx = live.x - ex, dy = live.y - ey, dz = live.z - ez;
        const d2 = dx * dx + dy * dy + dz * dz;
        const max = tr.maxOffset;
        if (d2 > max * max && d2 > 0) {
            const k = max / Math.sqrt(d2);
            dx *= k; dy *= k; dz *= k;
        }
        if (Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz)) {
            tr.cx = dx; tr.cy = dy; tr.cz = dz;
        }
    }

    const u = t <= 0 ? 0 : (t >= c.frames ? c.frames : t);
    const u01 = u / c.frames;
    const w = trackingWeight(u01);
    pos.x += tr.cx * w;
    pos.y += tr.cy * w;
    pos.z += tr.cz * w;

    // dw/dframe = (dw/du01)/frames; velocities are per second on the way out.
    const dwdf = trackingWeightSlope(u01) / c.frames * SIM_TICKS_PER_SEC;
    vel.x += tr.cx * dwdf;
    vel.y += tr.cy * dwdf;
    vel.z += tr.cz * dwdf;
}
