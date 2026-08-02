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
