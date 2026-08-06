/**
 * WheelSpinDriver — movement-driven axle spin for wheeled natives
 * (PLAN-metalstorm-model-integration §M1).
 *
 * The generic sibling of `TrainPresentation`'s T6 wheel spin: that one is
 * hard-wired to train cars (`customparams.train_role`, `axle1..axleN`), this
 * one drives the forge convention — `axle_f` / `axle_m` / `axle_r` (and
 * `wheel1`/`wheel2` on trailers) — for any native whose model carries them.
 * Both push through the SAME `EntityRenderer.setWheelPose` channel, so the
 * §16c precedence holds unchanged: streamed 0x05 > aim > wheel spin > clips.
 * Trains stay with TrainPresentation (`excluded()` below) so one unit never
 * has two writers of that channel.
 *
 * Speed comes from consecutive WIRE positions, exactly as in
 * clip-auto-policy.ts and for the same reason: the render pose is
 * camera-lerped, so integrating spin from it would lag and jitter with the
 * interpolator instead of with the unit. `observe()` therefore runs at the
 * wire cadence (~10 Hz delta / 1 Hz full) and `tick()` at render rate reads
 * the speed it left behind.
 *
 * Natives are script-less (see clip-auto-policy.ts's header): the sim never
 * turns a piece for them, so a wheel that is not spun here does not spin at
 * all. Nothing about this file reaches the sim.
 *
 * ## Why the spin rate is not physical
 *
 * The honest rate is `omega = groundSpeed / wheelRadius`. Today it cannot be
 * computed: models draw at 1 model-unit = 1 elmo while defs move at tens of
 * elmos per second (the §12 metre→elmo render-scale gap, see
 * `ClipAutoPolicyDeps.nominalSpeed`), so a 0.37-unit wheel on a 90 elmo/s
 * truck would turn at ~240 rad/s — 39 revolutions a second, which an 8-gon
 * wheel renders as a backwards strobe (it aliases above 22.5°/frame).
 *
 * So the default reference radius is derived from the def's OWN top speed:
 * top speed maps to `MAX_SPIN_RAD_PER_SEC` and everything below scales
 * linearly, which is the part that actually reads at gameplay zoom — wheels
 * visibly wind up and slow down with the unit. `customparams.wheel_radius`
 * (elmos) overrides with a real radius for a def that wants one, and the
 * clamp still applies. Revisit once §12 lands.
 */

/** Spring-euler per-piece pose, the shape `setWheelPose` takes. */
export interface WheelPiecePose {
    px: number; py: number; pz: number;
    rx: number; ry: number; rz: number;
}

/** The pose sink (structural, so tests need no Babylon scene). */
export interface WheelPoseSink {
    setWheelPose(id: number, pose: ReadonlyMap<number, WheelPiecePose> | null): boolean;
}

/** The minimal piece shape `matchWheelPieces` needs — mirrors
 *  `AimPieceDescriptor` in turret-aim-controller.ts. */
export interface WheelPieceDescriptor {
    name: string;
}

export interface WheelSpinDeps {
    /**
     * Indices of the unit model's spinnable wheel pieces. null = unknown unit
     * or model still loading (retried on the next snapshot); [] = model
     * loaded and carries none, which retires the unit for good — otherwise
     * every mover of a wheel-less game would re-probe here all match.
     */
    wheelPieces(unitId: number): number[] | null;
    /** Def top speed (elmos/s) — the reference the default spin scales to. */
    topSpeed(unitId: number): number;
    /** `customparams.wheel_radius` in elmos, or undefined to derive it. */
    wheelRadius(unitId: number): number | undefined;
    /** True once the sim streams 0x05 piece state for this unit: it owns the
     *  pieces, so decline it (same guard as TurretAimController). */
    simDrivesPieces(unitId: number): boolean;
    /** True for units another presentation system already spins — trains. */
    excluded(unitId: number): boolean;
}

/** Sim frames per game second — the timebase of `baseFrame` (SIM_HZ in
 *  clip-auto-policy.ts, redeclared here by the same module-local convention). */
const SIM_HZ = 30;

const LOS_INLOS = 1 << 0;
const STATE_BIT_ALWAYS_VISIBLE = 1 << 7;

/** Server position deadband (`EntityDeltaCache::POS_THRESHOLD`, elmos): a unit
 *  that moved less than this is omitted from deltas entirely, so absence is
 *  the stop signal and this bounds an absent unit's speed. Same trick, same
 *  constant, as clip-auto-policy.ts's `effectiveSpeed`. */
const POS_DEADBAND = 0.5;

/** Below this planar speed (elmos/s) the wheels hold their phase. Matches the
 *  clip policy's STOP_SPEED so wheels and walk cycles agree on "stopped". */
const STOP_SPEED = 0.2;

/** Spin clamp (rad/s). 12 rad/s is ~1.9 rev/s: well inside the aliasing
 *  threshold of an 8-gon wheel (22.5°/frame = 23.5 rad/s at 60 fps, half that
 *  at 30) so the spin never reads backwards. */
const MAX_SPIN_RAD_PER_SEC = 12;

/** Fallback reference speed (elmos/s) for a def with wheels and no usable top
 *  speed — only reachable for something that cannot move anyway. */
const NOMINAL_FALLBACK = 30;

/**
 * Wheel-piece naming convention (forge; see tools/forge/docs/FORGE-GUIDE.md
 * and the ASSETS.md rows for the batch-01/02 vehicles):
 *   `axle_f` / `axle_m` / `axle_r` — an axle bar along piece-local X with the
 *      pivot at the wheel centre, wheels resting at Y=0;
 *   `wheel1` / `wheel2` — the same solid, one per side (trailers).
 * Train `axle1..axleN` is deliberately NOT matched: TrainPresentation owns
 * those and the two would fight over one pose channel.
 */
const WHEEL_PIECE_RE = /^(?:axle_[a-z0-9]+|wheel\d+)$/i;

/** Indices of the pieces this driver will spin, in piece order. */
export function matchWheelPieces(pieces: readonly WheelPieceDescriptor[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < pieces.length; i++) {
        if (WHEEL_PIECE_RE.test(pieces[i].name)) out.push(i);
    }
    return out;
}

/** The slice of `EntityStateSnapshot` this driver reads (structural, so the
 *  tests can hand it a literal). */
export interface WheelSpinSnapshot {
    baseFrame: number;
    count: number;
    // Nullable, not just optional: a wire snapshot carries `null` for every
    // field its fieldMask omitted (entity-state.ts).
    entityIds?: Uint32Array | null;
    positionsX?: Float32Array | null;
    positionsZ?: Float32Array | null;
    losStates?: Uint8Array | null;
    stateBits?: Uint8Array | null;
}

interface Motion {
    /** Frame + planar position of the last accepted wire sample. */
    frame: number;
    x: number;
    z: number;
    /** Planar speed (elmos/s) across the last consecutive pair. */
    speed: number;
    /** Accumulated axle rotation (radians), normalised to (-π, π]. */
    rotation: number;
    /** Resolved wheel piece indices, or null until the model has loaded. */
    pieces: number[] | null;
    /** Model loaded and carries no wheel piece — retired from evaluation. */
    ineligible: boolean;
    /** True once a pose has been pushed, so a unit that goes sim-driven can
     *  have its stale cosmetic pose cleared exactly once. */
    posed: boolean;
}

export class WheelSpinDriver {
    private deps: WheelSpinDeps;
    private sink: WheelPoseSink;
    private motion = new Map<number, Motion>();
    /** Leading edge of the wire clock (advances on every snapshot). */
    private latestFrame = -1;

    constructor(deps: WheelSpinDeps, sink: WheelPoseSink) {
        this.deps = deps;
        this.sink = sink;
    }

    /**
     * Ingest one wire snapshot: refresh planar speed from consecutive
     * positions. Mirrors `ClipAutoPolicy.observe` — including the radar-only
     * skip (a deceived position would jitter into fake movement) and the
     * full-snapshot prune (a FULL snapshot lists everything visible, so
     * anything missing from one is gone for good).
     */
    observe(snapshot: WheelSpinSnapshot, isDelta = false): void {
        if (snapshot.baseFrame > this.latestFrame) this.latestFrame = snapshot.baseFrame;
        const { count, entityIds, positionsX, positionsZ, losStates, stateBits } = snapshot;
        if (entityIds && positionsX && positionsZ) {
            for (let i = 0; i < count; i++) {
                const inLos = losStates ? (losStates[i] & LOS_INLOS) !== 0 : true;
                const alwaysVisible = stateBits
                    ? (stateBits[i] & STATE_BIT_ALWAYS_VISIBLE) !== 0 : false;
                if (!inLos && !alwaysVisible) continue;
                this.sample(entityIds[i], snapshot.baseFrame, positionsX[i], positionsZ[i]);
            }
        }
        if (!isDelta && entityIds) this.pruneTo(entityIds, count);
    }

    /**
     * Advance every tracked unit's spin by `deltaMs` of render time and push
     * the pose. Called from the render loop: the phase has to move at frame
     * rate, not at the ~10 Hz wire cadence, or the wheels would visibly step.
     */
    tick(deltaMs: number): void {
        const deltaSec = deltaMs / 1000;
        if (deltaSec <= 0) return;
        for (const [id, m] of this.motion) {
            if (m.ineligible) continue;
            if (this.deps.excluded(id)) { m.ineligible = true; continue; }
            // The sim took the pieces over (ZK/BAR, future s4 sim aim): drop
            // the cosmetic pose so nothing of ours lingers under it.
            if (this.deps.simDrivesPieces(id)) {
                if (m.posed) { this.sink.setWheelPose(id, null); m.posed = false; }
                continue;
            }
            if (m.pieces === null) {
                const resolved = this.deps.wheelPieces(id);
                if (resolved === null) continue;          // still loading — retry
                if (resolved.length === 0) { m.ineligible = true; continue; }
                m.pieces = resolved;
            }

            const speed = this.effectiveSpeed(m);
            if (speed <= STOP_SPEED) continue;   // hold the phase where it is

            m.rotation += this.spinRate(id, speed) * deltaSec;
            // Normalise so long runs don't lose float precision.
            if (m.rotation > Math.PI) m.rotation -= 2 * Math.PI;
            else if (m.rotation < -Math.PI) m.rotation += 2 * Math.PI;

            const pose = new Map<number, WheelPiecePose>();
            for (const idx of m.pieces) {
                // Rotate about the piece's local X — the axle bar's own axis
                // in the forge convention. No translation off the rest pose.
                pose.set(idx, { px: 0, py: 0, pz: 0, rx: m.rotation, ry: 0, rz: 0 });
            }
            // false = the renderer no longer knows this unit (died mid-frame);
            // it has already dropped our channel, so just stop tracking.
            m.posed = this.sink.setWheelPose(id, pose);
            if (!m.posed) this.motion.delete(id);
        }
    }

    /** Angular velocity (rad/s) for a unit at `speed` elmos/s — see the file
     *  header for why the default reference radius is speed-derived. */
    private spinRate(id: number, speed: number): number {
        const explicit = this.deps.wheelRadius(id);
        const radius = explicit !== undefined && Number.isFinite(explicit) && explicit > 0
            ? explicit
            : (this.deps.topSpeed(id) || NOMINAL_FALLBACK) / MAX_SPIN_RAD_PER_SEC;
        return Math.min(MAX_SPIN_RAD_PER_SEC, speed / radius);
    }

    /** Speed to judge a unit by right now — a unit that stopped reporting has
     *  moved less than the server deadband since its last sample, which bounds
     *  it from above and decays a stale roller to rest. */
    private effectiveSpeed(m: Motion): number {
        const staleSec = (this.latestFrame - m.frame) / SIM_HZ;
        if (staleSec <= 0) return m.speed;
        return Math.min(m.speed, POS_DEADBAND / staleSec);
    }

    private sample(id: number, frame: number, x: number, z: number): void {
        const prev = this.motion.get(id);
        if (!prev) {
            this.motion.set(id, {
                frame, x, z, speed: 0, rotation: 0,
                pieces: null, ineligible: false, posed: false,
            });
            return;
        }
        if (frame <= prev.frame) return;   // duplicate / out-of-order packet
        const dtSec = (frame - prev.frame) / SIM_HZ;
        prev.speed = Math.hypot(x - prev.x, z - prev.z) / dtSec;
        prev.frame = frame;
        prev.x = x;
        prev.z = z;
    }

    private pruneTo(entityIds: Uint32Array, count: number): void {
        if (this.motion.size === 0) return;
        const seen = new Set<number>();
        for (let i = 0; i < count; i++) seen.add(entityIds[i]);
        for (const id of this.motion.keys()) if (!seen.has(id)) this.motion.delete(id);
    }

    /** Drop per-unit bookkeeping (death / LOS eviction). The renderer clears
     *  its own pose map in `removeEntity`, so no sink call is needed. */
    remove(id: number): void {
        this.motion.delete(id);
    }

    reset(): void {
        this.motion.clear();
        this.latestFrame = -1;
    }

    /** Debug view, mirroring ClipAutoPolicy.stats(). */
    stats(): { tracked: number; spinning: number; ineligible: number } {
        let spinning = 0;
        let ineligible = 0;
        for (const m of this.motion.values()) {
            if (m.posed) spinning++;
            if (m.ineligible) ineligible++;
        }
        return { tracked: this.motion.size, spinning, ineligible };
    }
}

/** `customparams.wheel_radius` (elmos) for a def, or undefined when unset or
 *  unusable — the driver then derives a reference radius from top speed. */
export function wheelRadiusFor(
    def: { customParams?: Record<string, string> } | undefined,
): number | undefined {
    const raw = Number(def?.customParams?.wheel_radius);
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** Spin knobs, exported for the tests + tuning. */
export const WHEEL_SPIN_TUNING = {
    STOP_SPEED, MAX_SPIN_RAD_PER_SEC, POS_DEADBAND, NOMINAL_FALLBACK, SIM_HZ,
} as const;
