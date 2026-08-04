/**
 * MotionLeanRegistry — the bounded positional lean (PLAN-latency §5a,
 * PLAN-latency-impl.md §L4.3). The last piece of the control timeline.
 *
 * L4.1/L4.2 made the *order* appear on the click — the waypoint line, the
 * marker, the production chip. The unit itself still stood still until the
 * server's pose caught up, which is a round trip plus however far the
 * presentation cursor `P` trails the leading edge `E`. This module gives the
 * body the same treatment: on a move order it starts creeping and turning
 * toward the waypoint immediately, by a few elmos, and hands back off to the
 * authoritative pose without a snap.
 *
 * ## The lean is a *lead*, and it shrinks by what the server delivers
 *
 * The naive version — offset by a decaying constant — fights the interpolator:
 * the offset decays on wall time while the real motion arrives on the
 * presentation timeline, so the two are unrelated and the unit stutters
 * backwards when they cross. What is modelled here instead is a **lead**:
 *
 *     offset = max(0, lead(t) - progress(t)) * decay(t)
 *
 * `lead` ramps to the cap; `progress` is how far the *authoritative* pose has
 * itself advanced along the order direction since the click. So the instant
 * real motion starts, the lean gives way one-for-one and the drawn position
 * keeps moving forward the whole time — there is never a frame where the unit
 * goes backwards, and the lean self-cancels to exactly zero with no residual.
 * That is the property that makes this safe to layer on L0's interpolator.
 *
 * `decay` exists only for the other outcome. Refusal is observed as silence
 * (there is no veto message — see pending-actions.ts), so an order that never
 * happens leaves `progress` at 0 forever. After a hold window sized like the
 * confirmation window, the lean eases out. *That* is a real correction the
 * player can see, it is what §7's correction-budget alarm is about, and it is
 * bounded to `MAX_LEAN_ELMOS` by construction — see `stats().maxOffsetElmos`.
 *
 * ## What this is not
 *
 * Never a write into `EntityInterpolator`'s sample buffer. The lean is a
 * render-space offset the renderer adds on top of the interpolated pose, and
 * every query API (`getEntityPosition`, `getEntityPose`, `getPieceWorldPosition`)
 * deliberately reads *through* it — aim, beam origins and target sampling stay
 * on authoritative data. Only the drawn body and its selection ring lean.
 */

/** Cap on the positional lead, in elmos. §5a's "a few elmos" — deliberately
 *  well under a unit length, so a lean that has to be walked back is a nudge
 *  and not a teleport. */
const MAX_LEAN_ELMOS = 6;

/** Cap on the heading lead, in wire u16 units (30°). Turning reads as
 *  responsiveness far more cheaply than translating does, so this is the half
 *  of the lean that actually sells the click. */
const MAX_LEAN_HEADING = Math.round((30 / 360) * 65536);

/** Time to reach full lead. Ramps **linearly**, not eased: the point of the
 *  phase is that something moves on the click, and an ease-in starts at zero
 *  velocity, which is exactly the stall being fixed. 6 elmos over 250 ms is
 *  ~24 elmos/s — below any real unit's speed, so it reads as the unit starting
 *  off rather than as a jump. */
const RAMP_MS = 250;

/** Ease-out duration once the hold expires (the refused/lost-order path). */
const DECAY_MS = 400;

/** Hold window bounds, mirroring pending-actions' confirmation window so a
 *  refuted order's lean and its waypoint marker disappear together instead of
 *  the body snapping back while the line is still drawn.
 *
 *  The window is a window of **silence**, not a deadline from the click — see
 *  `PROGRESS_EPSILON`. Sizing it from the click was the first cut and it was
 *  measurably wrong: a tank that has to turn 180° before it translates takes
 *  well over a second to make its first few elmos, so the hold expired while
 *  the order was being obeyed and the body decayed backwards. Measured on
 *  meridian_basin 2026-08-04: 14 backwards frames on one order. */
const MIN_HOLD_MS = 700;
const MAX_HOLD_MS = 3000;
const HOLD_SLACK_MS = 300;

/** Movement (elmos) / rotation (u16) below which the authoritative pose counts
 *  as *not responding* to the order. Any more than this and the server is
 *  visibly acting on it, so the lean is earned and the hold restarts —
 *  translation and rotation both count, because turning in place is most of
 *  what a unit does in the window this phase covers. */
const PROGRESS_EPSILON = 0.05;
const TURN_EPSILON = 64;

/** Below this the order is "where you already are" — leaning toward it would
 *  be noise. */
const MIN_TARGET_DIST = 8;

/** The lead never exceeds this fraction of the remaining distance, so a short
 *  nudge order cannot lean past its own target and the lean tapers over the
 *  last few elmos instead of cutting off at `MIN_TARGET_DIST`.
 *
 *  This only binds below `MAX_LEAN_ELMOS / LEAD_DIST_FRACTION` = 12 elmos, so
 *  `MIN_TARGET_DIST` has to sit *under* that or the clamp is unreachable —
 *  which it was, at a first-cut 12/12, and a unit test caught it. */
const LEAD_DIST_FRACTION = 0.5;

/// Mirrors command-buffer.ts; duplicated (not imported) to keep this module
/// free of runtime imports, as pending-actions.ts does.
const CMD_STOP = 0;
const CMD_REMOVE = 2;
const CMD_MOVE = 10;
const CMD_PATROL = 15;
const CMD_FIGHT = 16;
const CMD_ATTACK = 20;

/** Only orders that mean "go there". A build order (`cmdId < 0`) places a
 *  structure and does not move the builder toward it in any predictable way;
 *  an ATTACK on a target id has no position at all. */
function isLeanCommand(cmdId: number, params: readonly number[]): boolean {
    if (params.length < 3) return false;
    return cmdId === CMD_MOVE || cmdId === CMD_PATROL ||
           cmdId === CMD_FIGHT || cmdId === CMD_ATTACK;
}

function isClearingCommand(cmdId: number): boolean {
    return cmdId === CMD_STOP || cmdId === CMD_REMOVE;
}

/** One command as it went on the wire — same shape the pending-action sink
 *  receives, so both subscribe to `Connection.setCommandSink` unchanged. */
export interface SentCommand {
    readonly commandId: number;
    readonly unitIds: readonly number[];
    readonly params: readonly number[];
    readonly options?: number;
}

/** Render-space offset to add to an interpolated pose. */
export interface LeanOffset {
    dx: number;
    dz: number;
    /** Signed wire-u16 heading delta; the caller wraps. */
    dHeading: number;
}

export interface MotionLeanStats {
    /** Leans currently contributing a non-zero offset. */
    active: number;
    startedTotal: number;
    /** Ended because the authoritative pose caught up — the good outcome. */
    absorbedTotal: number;
    /** Ended by the hold/decay path, i.e. the order never visibly happened.
     *  Each of these is a correction the player may have seen. */
    decayedTotal: number;
    /** Largest positional offset ever applied, elmos. The correction-budget
     *  measurement: must stay <= MAX_LEAN_ELMOS. */
    maxOffsetElmos: number;
    /** Times the bound was breached. Must be 0; non-zero is a bug, and the
     *  first one warns. */
    boundExceededTotal: number;
    /** Cap in force, so a measurement can be read without the source. */
    maxLeanElmos: number;
}

interface Lean {
    readonly unitId: number;
    /** Waypoint, world x/z. */
    readonly tx: number;
    readonly tz: number;
    readonly startMs: number;
    /** Wall time after which the lean eases out. Pushed forward on every frame
     *  the authoritative pose is observed responding to the order, so it is a
     *  silence timeout rather than a deadline. */
    holdUntilMs: number;
    /** Progress/turn as of the last frame, for the silence test. */
    lastProgress: number;
    lastTurned: number;
    /** Authoritative pose at the click — `progress` is measured from here. */
    ox: number;
    oz: number;
    oHeading: number;
    /** True once we have seen a real pose for this unit and latched the
     *  origin. A lean registered for a unit the renderer has no sample for yet
     *  latches on the first frame it does. */
    originLatched: boolean;
}

/** Shortest signed delta between two wire-u16 headings, in (-32768, 32768]. */
function headingDelta(from: number, to: number): number {
    let d = ((to - from) % 65536 + 65536) % 65536;
    if (d > 32768) d -= 65536;
    return d;
}

/**
 * Wire-u16 heading that faces (dx, dz).
 *
 * The renderer builds yaw as `(heading / 65535) * 2π` and feeds it to
 * `RotationYawPitchRoll` in an RH scene, where the model's forward is local
 * -Z. Rotating (0,0,-1) by yaw θ about +Y gives (-sinθ, -cosθ) — the same
 * convention `getEntityBounds` rotates its centre offset with — so facing
 * (dx, dz) means θ = atan2(-dx, -dz).
 */
function headingToward(dx: number, dz: number): number {
    const yaw = Math.atan2(-dx, -dz);
    return ((yaw / (Math.PI * 2)) * 65536 % 65536 + 65536) % 65536;
}

function smoothstep(t: number): number {
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    return c * c * (3 - 2 * c);
}

export class MotionLeanRegistry {
    /** One lean per unit — a newer order replaces the older one outright,
     *  which is what the sim will do too for a non-shift order and is the
     *  honest approximation for a shift-queued one (you lean toward the thing
     *  you just clicked). */
    private leans = new Map<number, Lean>();
    /** Per-frame memo, cleared by `beginFrame` — see `offsetFor`. */
    private frameMemo = new Map<number, LeanOffset | null>();
    private readonly now: () => number;
    private readonly getRttMs: () => number;
    private readonly warn: (msg: string) => void;

    private startedTotal = 0;
    private absorbedTotal = 0;
    private decayedTotal = 0;
    private maxOffsetElmos = 0;
    private boundExceededTotal = 0;
    private warnedBound = false;
    /** Offsets applied on the most recent render pass — `active` is reported
     *  from the last full pass rather than from map size, because an entry
     *  whose offset has reached 0 is not leaning even though it is still held. */
    private activeThisPass = 0;
    private activeLastPass = 0;

    constructor(opts: {
        getRttMs: () => number;
        now?: () => number;
        warn?: (msg: string) => void;
    }) {
        this.getRttMs = opts.getRttMs;
        this.now = opts.now ?? (() => performance.now());
        this.warn = opts.warn ?? (() => {});
    }

    private holdMs(): number {
        const rtt = this.getRttMs();
        const w = (Number.isFinite(rtt) && rtt > 0 ? rtt * 2 : 0) + HOLD_SLACK_MS;
        return Math.min(MAX_HOLD_MS, Math.max(MIN_HOLD_MS, w));
    }

    /**
     * Record a command that has just been sent. Wired to the same
     * `Connection.setCommandSink` as the pending-action registry, so it sees
     * widget-rewritten and widget-issued orders in their final form.
     */
    onCommandSent(cmd: SentCommand): void {
        if (isClearingCommand(cmd.commandId)) {
            for (const unitId of cmd.unitIds) this.drop(unitId);
            return;
        }
        if (!isLeanCommand(cmd.commandId, cmd.params)) return;

        const t = this.now();
        const holdUntilMs = t + this.holdMs();
        for (const unitId of cmd.unitIds) {
            this.leans.set(unitId, {
                unitId,
                tx: cmd.params[0],
                tz: cmd.params[2],
                startMs: t,
                holdUntilMs,
                lastProgress: 0,
                lastTurned: 0,
                ox: 0,
                oz: 0,
                oHeading: 0,
                originLatched: false,
            });
            this.startedTotal++;
        }
    }

    /**
     * The offset to add to `(x, z, heading)` for this unit, or null.
     *
     * Called from the render path once per drawn entity per frame, so it
     * allocates only when a lean is actually in force. The authoritative pose
     * is passed in rather than looked up: this module stays free of renderer
     * imports, and the caller already has the interpolated pose in hand.
     */
    offsetFor(unitId: number, x: number, z: number, heading: number): LeanOffset | null {
        // The renderer asks twice per frame for a selected unit — once for the
        // body, once for the selection ring — and this method has side effects
        // (it latches the origin, counts, and retires). Memoise per frame so
        // the second ask is a lookup, not a second evaluation that would
        // double-count `active` and could retire the lean between the two.
        const memo = this.frameMemo.get(unitId);
        if (memo !== undefined) return memo;
        const value = this.computeOffset(unitId, x, z, heading);
        this.frameMemo.set(unitId, value);
        return value;
    }

    private computeOffset(unitId: number, x: number, z: number, heading: number)
        : LeanOffset | null {
        const lean = this.leans.get(unitId);
        if (!lean) return null;

        if (!lean.originLatched) {
            lean.ox = x;
            lean.oz = z;
            lean.oHeading = heading;
            lean.originLatched = true;
        }

        const t = this.now();

        // Direction is recomputed from the *current* pose, so a unit that
        // rounds a corner leans along its remaining path rather than along the
        // straight line it started on.
        const dirX = lean.tx - x;
        const dirZ = lean.tz - z;
        const dist = Math.hypot(dirX, dirZ);
        if (dist < MIN_TARGET_DIST) {
            // Arrived (or the order was for where we already stood).
            this.leans.delete(unitId);
            this.absorbedTotal++;
            return null;
        }
        const ux = dirX / dist;
        const uz = dirZ / dist;

        const ramp = Math.min(1, (t - lean.startMs) / RAMP_MS);

        // How far the authoritative pose has already carried the unit along
        // the order direction. Clamped at 0 so a unit shoved backwards by a
        // collision does not inflate the lean.
        const progress = Math.max(0, (x - lean.ox) * ux + (z - lean.oz) * uz);
        // Heading leans on the same lead-minus-progress shape: the amount we
        // are willing to pre-turn, less the amount the server has turned.
        const wantTurn = headingDelta(heading, headingToward(ux, uz));
        const turned = Math.abs(headingDelta(lean.oHeading, heading));

        // The unit is visibly obeying: restart the silence timeout. A tank
        // spends its first second turning, which is progress the positional
        // term alone cannot see.
        if (progress > lean.lastProgress + PROGRESS_EPSILON ||
            turned > lean.lastTurned + TURN_EPSILON) {
            lean.holdUntilMs = t + this.holdMs();
        }
        lean.lastProgress = Math.max(lean.lastProgress, progress);
        lean.lastTurned = Math.max(lean.lastTurned, turned);

        const decay = t <= lean.holdUntilMs
            ? 1
            : 1 - smoothstep((t - lean.holdUntilMs) / DECAY_MS);

        const lead = Math.min(MAX_LEAN_ELMOS, dist * LEAD_DIST_FRACTION) * ramp;
        const mag = Math.max(0, lead - progress) * decay;

        const headLead = Math.min(MAX_LEAN_HEADING, Math.abs(wantTurn)) * ramp;
        const headMag = Math.max(0, headLead - turned) * decay;
        const dHeading = Math.round(Math.sign(wantTurn) * headMag);

        if (mag <= 0 && dHeading === 0) {
            // Zero offset is only *terminal* once the ramp is done — on the
            // frame a lean is registered `ramp` is 0 and so is everything
            // derived from it, and retiring there would delete every lean on
            // its first query.
            if (ramp < 1) return null;
            // Fully absorbed, or decayed away. Which one it was decides the
            // stat: decay only ever runs after the hold expires.
            this.leans.delete(unitId);
            if (t > lean.holdUntilMs && progress < lead) this.decayedTotal++;
            else this.absorbedTotal++;
            return null;
        }

        if (mag > this.maxOffsetElmos) this.maxOffsetElmos = mag;
        if (mag > MAX_LEAN_ELMOS + 1e-6) {
            // §7's correction-budget alarm. Unreachable by construction — the
            // lead is clamped — so if it ever fires the model above is wrong,
            // and it is worth one loud line rather than a silent drift.
            this.boundExceededTotal++;
            if (!this.warnedBound) {
                this.warnedBound = true;
                this.warn(
                    `[L4.3] positional lean exceeded its bound: ` +
                    `${mag.toFixed(1)} > ${MAX_LEAN_ELMOS} elmos on unit ${unitId}`);
            }
        }
        this.activeThisPass++;
        return { dx: ux * mag, dz: uz * mag, dHeading };
    }

    /** Call once per render frame, before the entity pass. Rolls the active
     *  counter over and expires leans for units that stopped being drawn (a
     *  unit that dies mid-lean is never queried again). */
    beginFrame(): void {
        this.activeLastPass = this.activeThisPass;
        this.activeThisPass = 0;
        this.frameMemo.clear();
        if (this.leans.size === 0) return;
        const t = this.now();
        for (const [unitId, lean] of this.leans) {
            if (t > lean.holdUntilMs + DECAY_MS) {
                this.leans.delete(unitId);
                this.decayedTotal++;
            }
        }
    }

    /** Drop this unit's lean (queue cleared, unit died, selection reset). */
    drop(unitId: number): void {
        if (this.leans.delete(unitId)) this.decayedTotal++;
    }

    stats(): MotionLeanStats {
        return {
            active: this.activeLastPass,
            startedTotal: this.startedTotal,
            absorbedTotal: this.absorbedTotal,
            decayedTotal: this.decayedTotal,
            maxOffsetElmos: this.maxOffsetElmos,
            boundExceededTotal: this.boundExceededTotal,
            maxLeanElmos: MAX_LEAN_ELMOS,
        };
    }

    /** Reset cumulative counters, keeping live leans — L3.2's finding that
     *  counters spanning the boot transient are worthless applies here too. */
    resetStats(): void {
        this.startedTotal = 0;
        this.absorbedTotal = 0;
        this.decayedTotal = 0;
        this.maxOffsetElmos = 0;
        this.boundExceededTotal = 0;
        this.warnedBound = false;
    }

    clear(): void {
        this.leans.clear();
        this.frameMemo.clear();
        this.activeThisPass = 0;
        this.activeLastPass = 0;
    }

    /** Live lean count, including ones whose offset has reached zero. */
    get size(): number { return this.leans.size; }
}
