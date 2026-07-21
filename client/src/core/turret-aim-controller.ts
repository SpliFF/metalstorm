/**
 * TurretAimController — client-side COSMETIC turret aim for native models
 * (DESIGN-MODEL-BUILDING.md §16c v1).
 *
 * Natives are script-less: the sim never turns a piece for them, so a
 * turreted native's gun stays welded forward even as it shoots. This
 * controller closes that gap CLIENT-SIDE, off events we already receive —
 * no new wire, no sim change (same philosophy as §16b walk/idle playback
 * and squad fan-out). It engages purely off projectile `Fired` events:
 *
 *   - On a Fired event whose `ownerId` names a unit with a `turret` piece
 *     (and that the sim is NOT already piece-driving, see below), the
 *     controller ENGAGES toward the shot's target: the live target entity
 *     position while it is known, else the event's frozen `targetPos`.
 *   - Each tick it slews the turret's model-space yaw toward
 *     `bearing(target − unit) − unitHeading`, capped at a turn rate
 *     (~120°/s default, or a per-unit override). An optional barrel piece
 *     pitches from the target's elevation.
 *   - After ~4 s without a fresh Fired event it DISENGAGES: it slews the
 *     turret (and barrel) back to rest, then releases the unit.
 *
 * OUTPUT + MERGE POLICY. Poses are emitted in the SAME Spring-euler form the
 * server's 0x05 piece stream uses (px,py,pz,rx,ry,rz), so the renderer runs
 * them through the identical `springToBabylonLocal` path. The per-piece merge
 * (EntityRenderer.computePieceWorldMatrices) resolves:
 *
 *     streamed 0x05  >  aim controller  >  authored clip  >  rest pose
 *
 * so clips own the body/legs channels, this controller owns turret/barrel,
 * and a sim-streamed piece always wins. That single ordering covers ZK/BAR
 * (sim scripts drive their turrets over 0x05) and a future s4 sim-aim model
 * with NO special cases.
 *
 * The merge alone is not quite enough, though: a ZK turret that the sim
 * slews back to rest drops out of the 0x05 snapshot (rest pieces are
 * omitted), and this controller's own 4 s decay could then paint a cosmetic
 * pose over it. So engagement is ALSO gated on `simDrivesPieces(unitId)` —
 * the moment a unit is seen in the piece stream the controller declines it
 * (and releases it mid-engagement if it starts streaming). That is the clean
 * native / sim-driven split; the merge ordering is the belt-and-suspenders
 * fallback for any frame where both ever coexist.
 */

/** Default turret slew cap when a def carries no override (deg/s). */
export const DEFAULT_SLEW_DEG_PER_SEC = 120;

/** Milliseconds of no fresh Fired event before a unit disengages. */
export const DISENGAGE_MS = 4000;

/** Below this |angle| (radians) a releasing turret is treated as at rest. */
const REST_EPS = 1e-3;

export interface AimVec { x: number; y: number; z: number; }

/** A turret or barrel piece: its index plus its rest-pose offset from its
 *  parent (Spring space — the translation the emitted pose must preserve so
 *  the piece stays mounted while it rotates). */
export interface AimPiece {
    idx: number;
    px: number;
    py: number;
    pz: number;
}

export interface UnitAimPieces {
    turret: AimPiece;
    /** Optional barrel/sleeve child that pitches with target elevation. */
    barrel?: AimPiece;
}

/** Spring-euler piece pose — the exact shape EntityRenderer.applyPieceState
 *  stores for a 0x05 override, so the aim path and the sim path converge. */
export interface AimPiecePose {
    px: number; py: number; pz: number;
    rx: number; ry: number; rz: number;
}

export interface TurretAimDeps {
    /** Live unit pose: world position + heading as the wire u16 [0, 65535]
     *  spanning a full turn. null when the unit is unknown (hold the last
     *  pose). `y` is only used for the optional barrel-pitch elevation. */
    unitPose(unitId: number): { x: number; y: number; z: number; heading: number } | null;
    /** Live world position of the shot's target while it is known, else null
     *  (the controller falls back to the Fired event's frozen targetPos). */
    targetPos(targetId: number): AimVec | null;
    /** Turret (+ optional barrel) pieces for a unit, or null when the model
     *  has no `turret` piece — such a unit never engages. */
    aimPieces(unitId: number): UnitAimPieces | null;
    /** True once the sim streams 0x05 piece state for this unit: it owns the
     *  turret, so the cosmetic controller must not touch it (ZK, BAR, and a
     *  future s4 sim-aim model). */
    simDrivesPieces(unitId: number): boolean;
    /** Per-unit slew-rate override (deg/s), e.g. derived from a def's turn
     *  rate or a `turret_slew_deg_per_sec` customparam. undefined → default. */
    slewRateDegPerSec?(unitId: number): number | undefined;
}

/** Where poses go — EntityRenderer.setAimPose. Returns false when the unit
 *  no longer exists so the controller can drop it. */
export interface AimPoseSink {
    setAimPose(unitId: number, pose: ReadonlyMap<number, AimPiecePose> | null): boolean;
}

/** Minimal Fired-event shape the controller consumes (ProjectileFiredInfo). */
export interface AimFiredEvent {
    ownerId: number;
    targetId: number;
    targetPos: AimVec;
}

interface Engagement {
    pieces: UnitAimPieces;
    targetId: number;
    /** The Fired event's frozen target position (fallback when the live
     *  target is unknown / out of LOS). */
    fallbackPos: AimVec;
    lastFireMs: number;
    /** Current slewed model-space turret yaw / barrel pitch (radians). */
    yaw: number;
    pitch: number;
    /** True once disengaged and slewing back to rest. */
    releasing: boolean;
}

const TWO_PI = Math.PI * 2;
const DEG2RAD = Math.PI / 180;

/** Wrap an angle into (−π, π]. */
function wrapPi(a: number): number {
    a = ((a + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
    return a;
}

/** Step `cur` toward `target` by at most `maxStep`, along the shortest arc. */
export function slewAngle(cur: number, target: number, maxStep: number): number {
    const delta = wrapPi(target - cur);
    if (Math.abs(delta) <= maxStep) return wrapPi(target);
    return wrapPi(cur + Math.sign(delta) * maxStep);
}

export class TurretAimController {
    private deps: TurretAimDeps;
    private sink: AimPoseSink;
    private engaged = new Map<number, Engagement>();
    /** Wall clock of the previous tick, for the per-tick slew budget. */
    private lastTickMs: number | null = null;

    constructor(deps: TurretAimDeps, sink: AimPoseSink) {
        this.deps = deps;
        this.sink = sink;
    }

    /**
     * Register / refresh an engagement from a projectile Fired event. A unit
     * with no `turret` piece, or one the sim already piece-drives, is ignored.
     * Re-firing preserves the current slewed yaw/pitch so tracking is smooth.
     */
    onFired(ev: AimFiredEvent, nowMs: number): void {
        const unitId = ev.ownerId;
        if (unitId <= 0) return;
        if (this.deps.simDrivesPieces(unitId)) return;
        const existing = this.engaged.get(unitId);
        const pieces = existing?.pieces ?? this.deps.aimPieces(unitId);
        if (!pieces) return;
        if (existing) {
            existing.targetId = ev.targetId;
            existing.fallbackPos = ev.targetPos;
            existing.lastFireMs = nowMs;
            existing.releasing = false;
        } else {
            this.engaged.set(unitId, {
                pieces,
                targetId: ev.targetId,
                fallbackPos: ev.targetPos,
                lastFireMs: nowMs,
                yaw: 0,
                pitch: 0,
                releasing: false,
            });
        }
    }

    /**
     * Advance every engagement: recompute the desired aim, slew toward it
     * under the turn-rate cap, and push the pose (or release a unit that has
     * finished slewing back to rest / gone sim-driven / disappeared).
     */
    tick(nowMs: number): void {
        if (this.engaged.size === 0) { this.lastTickMs = nowMs; return; }
        const dtSec = this.lastTickMs === null ? 0 : Math.max(0, (nowMs - this.lastTickMs) / 1000);
        this.lastTickMs = nowMs;

        for (const [unitId, e] of this.engaged) {
            // The sim took over this unit's pieces (ZK/BAR turret, future
            // sim-aim): drop the cosmetic pose immediately — 0x05 wins.
            if (this.deps.simDrivesPieces(unitId)) {
                this.sink.setAimPose(unitId, null);
                this.engaged.delete(unitId);
                continue;
            }

            const pose = this.deps.unitPose(unitId);
            if (!pose) {
                // Unit vanished from the render set — release its bookkeeping;
                // setAimPose reports the unknown id so we can also clean up.
                if (!this.sink.setAimPose(unitId, this.buildPose(e))) {
                    this.engaged.delete(unitId);
                }
                continue;
            }

            const disengaged = nowMs - e.lastFireMs > DISENGAGE_MS;
            if (disengaged) e.releasing = true;

            let desiredYaw = 0;
            let desiredPitch = 0;
            if (!e.releasing) {
                const target = this.deps.targetPos(e.targetId) ?? e.fallbackPos;
                const dx = target.x - pose.x;
                const dz = target.z - pose.z;
                // Spring bearing: heading 0 faces +Z, +90° faces +X, so the
                // world bearing to (dx,dz) is atan2(dx, dz). The hull already
                // carries `heading`; the turret's MODEL-space yaw is the
                // remainder, so it lands at the world bearing once the entity
                // matrix re-applies the hull heading.
                const bearing = Math.atan2(dx, dz);
                const heading = (pose.heading / 65535) * TWO_PI;
                desiredYaw = wrapPi(bearing - heading);
                if (e.pieces.barrel) {
                    // Elevation angle from the muzzle to the target. Barrel
                    // pitch about Spring X is negated (RotateX(+) pitches the
                    // nose DOWN in Spring's LH frame), so a target above the
                    // unit gets a negative rx that lifts the barrel. Best-
                    // effort cosmetic: exact muzzle height is noise at zoom.
                    const horiz = Math.hypot(dx, dz) || 1e-6;
                    desiredPitch = -Math.atan2(target.y - pose.y, horiz);
                }
            }

            const rate = this.slewRate(unitId) * dtSec;
            e.yaw = slewAngle(e.yaw, desiredYaw, rate);
            if (e.pieces.barrel) e.pitch = slewAngle(e.pitch, desiredPitch, rate);

            if (e.releasing && Math.abs(e.yaw) < REST_EPS
                && (!e.pieces.barrel || Math.abs(e.pitch) < REST_EPS)) {
                this.sink.setAimPose(unitId, null);
                this.engaged.delete(unitId);
                continue;
            }

            if (!this.sink.setAimPose(unitId, this.buildPose(e))) {
                this.engaged.delete(unitId);
            }
        }
    }

    /** Turret (+ barrel) Spring-euler pose from the current slewed angles. */
    private buildPose(e: Engagement): Map<number, AimPiecePose> {
        const pose = new Map<number, AimPiecePose>();
        const t = e.pieces.turret;
        // Preserve the rest mount offset (px,py,pz); yaw about Spring Y.
        pose.set(t.idx, { px: t.px, py: t.py, pz: t.pz, rx: 0, ry: e.yaw, rz: 0 });
        if (e.pieces.barrel) {
            const b = e.pieces.barrel;
            // Barrel inherits the turret's yaw through the parent chain; it
            // only adds pitch about Spring X.
            pose.set(b.idx, { px: b.px, py: b.py, pz: b.pz, rx: e.pitch, ry: 0, rz: 0 });
        }
        return pose;
    }

    private slewRate(unitId: number): number {
        const override = this.deps.slewRateDegPerSec?.(unitId);
        const deg = override && override > 0 ? override : DEFAULT_SLEW_DEG_PER_SEC;
        return deg * DEG2RAD;
    }

    /** Drop a unit's engagement (death / LOS eviction). */
    remove(unitId: number): void {
        this.engaged.delete(unitId);
    }

    reset(): void {
        this.engaged.clear();
        this.lastTickMs = null;
    }

    /** Debug/test view: is a unit currently engaged, and its slewed yaw. */
    stateOf(unitId: number): { yaw: number; pitch: number; releasing: boolean } | null {
        const e = this.engaged.get(unitId);
        return e ? { yaw: e.yaw, pitch: e.pitch, releasing: e.releasing } : null;
    }

    get count(): number {
        return this.engaged.size;
    }
}
