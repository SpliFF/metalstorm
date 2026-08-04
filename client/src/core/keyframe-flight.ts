/**
 * keyframe-flight — the rendered path of a Tier-S projectile (PLAN-latency
 * L3.2). Server half and emission policy in rts/Sim/Projectiles/
 * TrajectoryKeyframes.h; design rationale in PLAN-latency-impl.md §"Phase L3"
 * and PLAN-latency-projectiles.md §4.
 *
 * A Tier-S shot stays in the simulation — its outcome is genuinely contingent
 * (shieldable, interceptable, it can hit something that wandered into the
 * path), so unlike a Tier-C shot the client cannot be told the whole flight up
 * front. What L3 changes is the *contract* for the motion in between.
 *
 * The old contract (`ProjectileTrajectoryEvent`) was "rewrite your pos/vel to
 * these and keep integrating". It carries no frame, so the client applied the
 * correction on packet arrival — `D` frames ahead of what the presentation
 * cursor was showing — and the projectile jumped. The extrapolate-and-snap
 * loop and `TRAIL_RESET_DELTA_SQ` in projectile-renderer.ts exist purely to
 * make that jump less visible.
 *
 * A keyframe is a *knot*: a position and velocity stamped with the sim frame
 * they hold at. Knots are interpolated at the presentation cursor `P`, which
 * buys the same two properties L2.2 established for Tier-C, by a different
 * route:
 *
 *   1. Motion is a pure function of `P`. Nothing is integrated, so nothing
 *      accumulates error and a cursor that steps *backwards* (measured on
 *      ~0.9 % of render ticks, PLAN-latency-impl.md L2 gate finding 3) rewinds
 *      a Tier-S bolt exactly as it rewinds the units it is flying between.
 *   2. The terminal knot and the `OutcomeKnownEvent` carry the same frame and
 *      the same position, so the bolt is standing on its explosion when the
 *      explosion is scheduled.
 *
 * ## Why the cursor is nearly always bracketed
 *
 * The client applies a knot stamped frame `f` when the batch for `f` arrives,
 * i.e. at the leading edge `E`; the cursor trails at `P = E − D`. So **every
 * knot stamped at a frame ≤ P has already arrived** — the cursor can never be
 * short of a knot on its left. It is bracketed on the right whenever a knot
 * exists in `(P, E]`.
 *
 * When it is not, `evalKeyframeTrack` continues the last knot along the
 * closed-form ballistic arc rather than refusing to draw. For an **unguided**
 * projectile that continuation is not an approximation but the sim's own
 * recurrence in closed form (see `ballisticAt`), so those shots are exact
 * everywhere and no bracketing is needed at all — which is precisely why the
 * server sends them Launch/Bounce/Terminal and no heartbeat.
 *
 * For a **guided** projectile the continuation is a genuine guess at steering
 * the client cannot reproduce, bounded by the heartbeat interval: the last
 * knot is at worst `KEYFRAME_HEARTBEAT_INTERVAL` frames behind `E`, so the
 * unbracketed span is at most `interval − D` frames. Landing a knot inside that
 * span moves the rendered path, which is the one correction L3 does not
 * eliminate. `keyframeResidual` measures it so the L3 gate can quote it
 * against the heartbeat cadence rather than assert it away.
 */

/// Sim ticks per game-second. Matches projectile-renderer's own constant; the
/// wire carries velocities per *frame* and the renderer's consumers want them
/// per second.
const SIM_TICKS_PER_SEC = 30;

/// Wire values — must match schemas/protocol.fbs `TrajectoryKeyframeKind` and
/// rts/Sim/Projectiles/TrajectoryKeyframes.h.
export const KEYFRAME_LAUNCH = 0;
export const KEYFRAME_HEARTBEAT = 1;
export const KEYFRAME_STAGE_CHANGE = 2;
export const KEYFRAME_RETARGET = 3;
export const KEYFRAME_BOUNCE = 4;
export const KEYFRAME_TERMINAL = 5;

/**
 * Knots older than this many frames behind the cursor are dropped.
 *
 * The cursor only ever moves forward on average, so a knot more than a
 * presentation delay behind it can never bracket anything again. The bound is
 * generous against `D` (which the L0 clock has been measured pinning as high as
 * 30 frames on a cold room) because the cost of keeping one is a few dozen
 * bytes and the cost of dropping one too early is a projectile that falls back
 * to extrapolation for the rest of its flight.
 */
const KNOT_RETENTION_FRAMES = 90;

/** One knot on a Tier-S projectile's flight path. Positions in elmos,
 *  velocities in elmos per *sim frame* — the wire's unit, kept as-is so the
 *  spline's frame parametrisation and its tangents share a time base. */
export interface Keyframe {
    frame: number;
    x: number; y: number; z: number;
    vx: number; vy: number; vz: number;
    kind: number;
}

/** The knots received so far for one projectile, in increasing frame order. */
export interface KeyframeTrack {
    knots: Keyframe[];
    /// Frame of the `Launch` knot — the frame the bolt becomes visible. The
    /// renderer draws nothing before it, so a Tier-S shot appears when the
    /// cursor says it was fired rather than `D` frames early.
    launchFrame: number;
    /// Frame of the `Terminal` knot, or -1 while the shot is still in flight.
    /// Past it the bolt holds the terminal position: the explosion is
    /// scheduled for that frame and the two must not disagree.
    terminalFrame: number;
    /// Per-frame² gravity from the projectile's `ProjectileFiredEvent`, signed
    /// in Recoil's `mygravity` convention (**negative pulls down**). Only the
    /// unbracketed continuation reads it; between knots the spline owns the
    /// arc.
    gravity: number;
    /// Index of the segment used last eval, as a search hint. The cursor is
    /// monotonic in the common case, so lookup is O(1) amortised.
    hint: number;
}

/**
 * Position of a ballistic projectile `t` frames after a knot, in the sim's own
 * recurrence rather than the textbook one.
 *
 * `CProjectile::Update` does `speed += g` *before* `pos += speed`, so after `n`
 * ticks the accumulated drop is `g·(1+2+…+n) = ½·g·n·(n+1)`, not `½·g·n²`. The
 * half-step is not a rounding detail: it is a one-directional bias that
 * compounds over a flight, and on the server the same error was worth a 3.1×
 * damage shortfall before L2.2 corrected it. Recoil's own aiming code carries
 * the identical term — see `CCannon::GetRange2D`'s `(gravity * 0.5f)`, commented
 * there as "factor due to discrete acceleration steps".
 *
 * `g` is signed: negative pulls down, matching `mygravity` on the wire.
 */
export function ballisticAt(
    k: Keyframe, t: number, g: number,
    pos: { x: number; y: number; z: number },
    vel: { x: number; y: number; z: number },
): void {
    pos.x = k.x + k.vx * t;
    pos.y = k.y + k.vy * t + 0.5 * g * t * (t + 1);
    pos.z = k.z + k.vz * t;
    vel.x = k.vx;
    vel.y = k.vy + g * t;
    vel.z = k.vz;
}

/**
 * Tangent correction that makes a cubic through two knots reproduce the sim's
 * ballistic arc *exactly*, expressed as half the per-frame acceleration across
 * the segment.
 *
 * The knot's `vel` is the sim's discrete `speed` at that frame, not the
 * derivative of the closed form through it. With `q(t) = p₀ + s₀·t + ½·g·t·(t+1)`
 * the true tangent is `q'(t) = s_t + g/2` — the same half-step as `ballisticAt`,
 * one derivative up. Feeding the raw `speed` to a Hermite basis therefore fits a
 * cubic whose endpoints are right and whose middle sags: with both tangents off
 * by `δ` the error peaks at `0.096·δ·F` over an `F`-frame segment, which for a
 * 90-frame artillery shot under map gravity is around half an elmo of bow.
 *
 * `g` is not on the keyframe wire, but it does not need to be: across a segment
 * where acceleration is constant it is exactly `(s₁ − s₀)/F`, so the correction
 * is `(s₁ − s₀)/(2F)` and is recovered from the knot pair itself. A cubic
 * Hermite through `(p₀, s₀+g/2)` and `(p₁, s₁+g/2)` then agrees with the
 * quadratic `q` at both value and derivative at both ends — and since `q` is
 * degree ≤ 3 and Hermite interpolation is unique in that space, the two are the
 * same polynomial. **The spline is not an approximation of an unguided flight;
 * it is that flight.**
 *
 * Where acceleration is *not* constant — a guidance stage change, a bounce —
 * the estimate is per-segment, so the tangent at a shared knot differs either
 * side of it. That is faithful rather than a defect: the sim's motion genuinely
 * has a corner there, and smoothing it would round off the bounce.
 */
function halfStep(k0: Keyframe, k1: Keyframe, frames: number): {
    hx: number; hy: number; hz: number;
} {
    const inv = 0.5 / frames;
    return {
        hx: (k1.vx - k0.vx) * inv,
        hy: (k1.vy - k0.vy) * inv,
        hz: (k1.vz - k0.vz) * inv,
    };
}

/**
 * Start a track from a projectile's `Launch` knot.
 *
 * `gravity` comes from the paired `ProjectileFiredEvent` (the schema promises
 * the pairing) in the wire's per-frame², negative-is-down convention. Passing a
 * non-finite value is treated as zero: a NaN here would propagate into a render
 * matrix, which is a black frame rather than a missing bolt.
 */
export function createKeyframeTrack(first: Keyframe, gravity: number): KeyframeTrack {
    return {
        knots: [first],
        launchFrame: first.frame,
        terminalFrame: first.kind === KEYFRAME_TERMINAL ? first.frame : -1,
        gravity: Number.isFinite(gravity) ? gravity : 0,
        hint: 0,
    };
}

/**
 * PLAN-latency L3.3 — the `Launch` knot the server no longer sends, rebuilt
 * from the `ProjectileFiredEvent` that used to be paired with it.
 *
 * Not an approximation of that knot: the server wrote it from the same `evPos`
 * and the same `speed` in the same `{}` block as the Fired event, so the two
 * agreed field-for-field, and its `frame` was the frame the batch carrying
 * them both is stamped with. Everything a `Launch` knot ever carried is
 * therefore already here — which is what makes dropping it a pure saving
 * rather than a trade. See `ProjectileFiredEvent.keyframed`, the one bit that
 * is genuinely new: whether the server is speaking this contract at all.
 */
export function launchKeyframe(
    frame: number,
    pos: { x: number; y: number; z: number },
    vel: { x: number; y: number; z: number },
): Keyframe {
    return {
        frame,
        x: pos.x, y: pos.y, z: pos.z,
        vx: vel.x, vy: vel.y, vz: vel.z,
        kind: KEYFRAME_LAUNCH,
    };
}

/**
 * PLAN-latency L3.3 — likewise the `Terminal` knot, rebuilt from the
 * `OutcomeKnownEvent` that was always emitted beside it.
 *
 * `outcome_pos` and `outcome_frame` are the knot's position and frame verbatim
 * — the schema already promised they were the same values — so convergence
 * stays exact by the same construction it had before: the bolt is *given* the
 * explosion's position, not integrated toward it.
 *
 * Only the velocity has to be derived, and only for the closed-form classes
 * this is used on, where deriving it is exact up to the last tick: the sim's
 * own recurrence continued from the previous knot. It is used for the CEG emit
 * direction and the laser shaft basis, never for the position.
 *
 * The final tick is where the derivation is *not* exact — a shot that hits the
 * ground mid-tick detonates at the tick boundary, so the terminal speed is the
 * speed it had entering that tick rather than at the crossing. That is the same
 * tick-quantisation L2.2 measured on the Tier-C path, it is a direction rather
 * than a position, and it is bounded by one frame of gravity.
 */
export function terminalKeyframe(
    track: KeyframeTrack, frame: number,
    pos: { x: number; y: number; z: number },
): Keyframe {
    const last = track.knots[track.knots.length - 1];
    const p = { x: 0, y: 0, z: 0 }, v = { x: 0, y: 0, z: 0 };
    ballisticAt(last, frame - last.frame, track.gravity, p, v);
    return {
        frame,
        x: pos.x, y: pos.y, z: pos.z,
        vx: v.x, vy: v.y, vz: v.z,
        kind: KEYFRAME_TERMINAL,
    };
}

/**
 * Add a knot, keeping `knots` sorted by frame.
 *
 * Two knots can share a frame: `DecideKeyframe` suppresses a second *sampled*
 * knot on a frame that already has one, but event knots (Bounce, Terminal)
 * bypass that policy and are pushed after it. schemas/protocol.fbs pins the
 * tie-break — **the later of two knots sharing a frame wins** — because the
 * event knot carries the post-event state and the sampled one carries the pre-
 * event state, and the client must render the projectile as having bounced.
 *
 * Arrival is in frame order in the normal case, so the insert is a push. The
 * search handles out-of-order arrival anyway rather than assuming a property of
 * the transport that the reliable-stream reshaping in PLAN-state-change could
 * quietly change.
 */
export function pushKeyframe(track: KeyframeTrack, kf: Keyframe): void {
    const knots = track.knots;
    let i = knots.length;
    while (i > 0 && knots[i - 1].frame > kf.frame) i--;
    // `>` above, not `>=`: scanning stops at the first knot with a frame <=
    // this one, so an equal-framed knot lands immediately after it. That is the
    // later-wins rule, and it is why eval below searches for the *last* segment
    // whose start frame brackets the cursor.
    if (i === knots.length) knots.push(kf);
    else knots.splice(i, 0, kf);

    if (kf.kind === KEYFRAME_LAUNCH) track.launchFrame = kf.frame;
    if (kf.kind === KEYFRAME_TERMINAL) track.terminalFrame = kf.frame;
    track.hint = 0;
}

/**
 * Drop knots that can no longer bracket the cursor. Called from the renderer's
 * per-tick sweep so a long-lived guided projectile's knot list stays bounded by
 * the retention window rather than by its flight time.
 *
 * The launch *knot* is not special and ages out like any other. `launchFrame`
 * is a field on the track rather than a lookup into `knots`, precisely so that
 * a projectile whose whole knot history has aged out still cannot be drawn
 * before it was fired.
 */
export function pruneKeyframes(track: KeyframeTrack, cursorFrame: number): void {
    const cutoff = cursorFrame - KNOT_RETENTION_FRAMES;
    const knots = track.knots;
    let drop = 0;
    // Stop one short of the end so a track always keeps a knot to extrapolate
    // from, however far the cursor has run past its last one.
    while (drop < knots.length - 1 && knots[drop + 1].frame <= cutoff) drop++;
    if (drop > 0) {
        knots.splice(0, drop);
        track.hint = 0;
    }
}

/**
 * Cubic Hermite between two knots, parametrised by frame.
 *
 * This is the Catmull-Rom spline PLAN-latency L3 specifies, with the tangents
 * *supplied* rather than estimated. Catmull-Rom is exactly a cubic Hermite
 * whose tangent at each knot is `(p_{i+1} − p_{i−1})/2` — a finite-difference
 * stand-in for a derivative nobody recorded. Here the sim recorded it: `vel` on
 * the wire is the projectile's own velocity at that knot, so using it is the
 * same spline family with the authoritative tangent instead of the estimated
 * one. It also needs no neighbours, which matters at the ends — a Catmull-Rom
 * segment adjacent to the launch or terminal knot would have to invent a
 * phantom control point, and the terminal knot is the one place the path must
 * not be invented at all.
 */
function hermite(
    k0: Keyframe, k1: Keyframe, frame: number,
    pos: { x: number; y: number; z: number },
    vel: { x: number; y: number; z: number },
): void {
    const F = k1.frame - k0.frame;
    if (F <= 0) {
        // Coincident knots: the later one wins outright. Dividing by zero here
        // would put NaN in a render matrix.
        pos.x = k1.x; pos.y = k1.y; pos.z = k1.z;
        vel.x = k1.vx; vel.y = k1.vy; vel.z = k1.vz;
        return;
    }
    const u = (frame - k0.frame) / F;
    const h = halfStep(k0, k1, F);
    // Tangents in elmos per unit-u (i.e. per segment), which is what the
    // Hermite basis below is written against.
    const m0x = (k0.vx + h.hx) * F, m0y = (k0.vy + h.hy) * F, m0z = (k0.vz + h.hz) * F;
    const m1x = (k1.vx + h.hx) * F, m1y = (k1.vy + h.hy) * F, m1z = (k1.vz + h.hz) * F;

    const u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    pos.x = h00 * k0.x + h10 * m0x + h01 * k1.x + h11 * m1x;
    pos.y = h00 * k0.y + h10 * m0y + h01 * k1.y + h11 * m1y;
    pos.z = h00 * k0.z + h10 * m0z + h01 * k1.z + h11 * m1z;

    // d/dframe = (d/du)/F.
    const d00 = 6 * u2 - 6 * u;
    const d10 = 3 * u2 - 4 * u + 1;
    const d01 = -6 * u2 + 6 * u;
    const d11 = 3 * u2 - 2 * u;
    vel.x = (d00 * k0.x + d10 * m0x + d01 * k1.x + d11 * m1x) / F;
    vel.y = (d00 * k0.y + d10 * m0y + d01 * k1.y + d11 * m1y) / F;
    vel.z = (d00 * k0.z + d10 * m0z + d01 * k1.z + d11 * m1z) / F;
}

/**
 * Where the projectile is at presentation frame `frame`, written into the
 * caller's vectors (this runs per projectile per render frame — no allocation).
 *
 * Velocity comes back in elmos/**second**, which is what the renderer's
 * downstream consumers (CEG emit direction, laser shaft basis, trail puffs)
 * expect; positions and the spline parameter stay in frames.
 *
 * Three regimes, in the order they are reached over a flight:
 *
 *   * **Before the launch knot** — clamped to the muzzle. The renderer does not
 *     draw the bolt at all here (see `launchFrame`); the clamp is so that a
 *     caller which does anyway gets the muzzle rather than a backwards
 *     extrapolation into the firing unit.
 *   * **Bracketed by two knots** — the Hermite above. Exact for any span the
 *     sim flew at constant acceleration, which is every unguided segment.
 *   * **Past the last knot** — `ballisticAt` from it. Exact for an unguided
 *     projectile; a bounded guess for a guided one, replaced by interpolation
 *     as soon as a knot lands beyond the cursor.
 *
 * Past the *terminal* knot the position is held rather than continued: the
 * explosion is scheduled for `terminalFrame` and a bolt that flew on through it
 * would separate from its own burst.
 */
export function evalKeyframeTrack(
    track: KeyframeTrack, frame: number,
    pos: { x: number; y: number; z: number },
    vel: { x: number; y: number; z: number },
): void {
    const knots = track.knots;
    const last = knots[knots.length - 1];

    if (frame <= knots[0].frame) {
        const k = knots[0];
        pos.x = k.x; pos.y = k.y; pos.z = k.z;
        vel.x = k.vx * SIM_TICKS_PER_SEC;
        vel.y = k.vy * SIM_TICKS_PER_SEC;
        vel.z = k.vz * SIM_TICKS_PER_SEC;
        return;
    }

    if (frame >= last.frame) {
        if (track.terminalFrame >= 0 && frame >= track.terminalFrame) {
            // Hold on the terminal knot. Taken verbatim rather than
            // re-evaluated so "the bolt is standing on its explosion" is exact
            // instead of within a float rounding — the same reason
            // evalCosmeticFlight lands on the wire's impact point.
            pos.x = last.x; pos.y = last.y; pos.z = last.z;
            vel.x = last.vx * SIM_TICKS_PER_SEC;
            vel.y = last.vy * SIM_TICKS_PER_SEC;
            vel.z = last.vz * SIM_TICKS_PER_SEC;
            return;
        }
        ballisticAt(last, frame - last.frame, track.gravity, pos, vel);
        vel.x *= SIM_TICKS_PER_SEC; vel.y *= SIM_TICKS_PER_SEC; vel.z *= SIM_TICKS_PER_SEC;
        return;
    }

    // Locate the last segment whose start bracket is <= frame. Scanning from
    // the hint keeps this O(1) while the cursor advances monotonically and
    // correct when it does not — the cursor genuinely steps backwards on ~0.9 %
    // of ticks, so the hint is an optimisation and never an assumption.
    let i = track.hint;
    if (i >= knots.length - 1) i = knots.length - 2;
    if (i < 0) i = 0;
    while (i > 0 && knots[i].frame > frame) i--;
    while (i < knots.length - 2 && knots[i + 1].frame <= frame) i++;
    track.hint = i;

    hermite(knots[i], knots[i + 1], frame, pos, vel);
    vel.x *= SIM_TICKS_PER_SEC; vel.y *= SIM_TICKS_PER_SEC; vel.z *= SIM_TICKS_PER_SEC;
}

/**
 * How far the rendered path at `frame` moves when `kf` is added to `track` —
 * the one correction L3 does not design away, isolated so the gate can put a
 * number on it.
 *
 * Zero for an unguided projectile at any cadence, because the continuation it
 * replaces was already exact. Non-zero only for guided steering the client
 * cannot reproduce, and bounded by how long the cursor spent unbracketed, i.e.
 * by the heartbeat interval. Quote it against the projectile's own per-frame
 * travel, not in absolute elmos: a correction smaller than the distance the
 * bolt was already covering in a frame cannot read as a snap — the criterion
 * L2.3 derived its tracking cap from.
 *
 * Call *before* `pushKeyframe`; it does not mutate the track.
 */
export function keyframeResidual(
    track: KeyframeTrack, kf: Keyframe, frame: number,
): number {
    const before = { x: 0, y: 0, z: 0 }, v = { x: 0, y: 0, z: 0 };
    evalKeyframeTrack(track, frame, before, v);
    const hint = track.hint;

    const probe: KeyframeTrack = {
        knots: track.knots.slice(),
        launchFrame: track.launchFrame,
        terminalFrame: track.terminalFrame,
        gravity: track.gravity,
        hint: 0,
    };
    pushKeyframe(probe, kf);
    const after = { x: 0, y: 0, z: 0 };
    evalKeyframeTrack(probe, frame, after, v);
    track.hint = hint;

    return Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z);
}
