/**
 * TurretAimController — client-side COSMETIC turret aim for native models
 * (DESIGN-MODEL-BUILDING.md §16c v1, multi-turret extension §16c/§19).
 *
 * Natives are script-less: the sim never turns a piece for them, so a
 * turreted native's gun stays welded forward even as it shoots. This
 * controller closes that gap CLIENT-SIDE, off events we already receive —
 * no new wire, no sim change (same philosophy as §16b walk/idle playback
 * and squad fan-out). It engages off projectile `Fired` events, and — for
 * statistical-resolution weapons (Metalstorm Model 1 MGs/autocannons/
 * mortars, which spawn no projectile at all) — off `VolleyOutcome` events
 * via `onVolley`, an adapter onto the same engage path (PLAN-metalstorm-
 * combat-fixes §B):
 *
 *   - A template may carry more than one turret piece — `turret`, `turret2`,
 *     `turret3`, … — one per weapon slot, per the authoring convention set
 *     by fable_heavy (§19): `turret` maps to unitdef weapon slot 1,
 *     `turretN` to slot N. Each is an independent engagement (own target,
 *     own slew state) — a Fired event engages ONLY the slot whose weapon
 *     fired, not every turret on the unit.
 *   - On a Fired event whose `ownerId` names a unit with at least one turret
 *     piece (and that the sim is NOT already piece-driving, see below), the
 *     controller resolves which slot fired (see `resolveSlot`) and ENGAGES
 *     it toward the shot's target: the live target entity position while it
 *     is known, else the event's frozen `targetPos`.
 *   - Each tick it slews the turret's model-space yaw toward
 *     `bearing(target − unit) − unitHeading`, capped at a turn rate
 *     (~120°/s default, or a per-unit override). An optional barrel piece
 *     pitches from the target's elevation.
 *   - After ~4 s without a fresh Fired event on that slot it DISENGAGES:
 *     slews the turret (and barrel) back to rest, then releases the slot.
 *
 * SLOT RESOLUTION. The wire's Fired event carries `weaponDefId` + muzzle
 * `pos`, but never a weapon-slot number — there's no server change for a
 * cosmetic feature. `resolveSlot` narrows via `weaponDefIds(unitId)` (the
 * unit def's per-slot weapon list) first; if that still leaves multiple
 * candidates (two slots sharing a weaponDefId, e.g. twin roof howitzers),
 * it breaks the tie against the shot's actual muzzle position — each
 * turret's mount point is physically distinct even when its weapon type
 * isn't. A single-turret unit always resolves to its one slot without
 * consulting weaponDefId/pos at all, so its behaviour is unchanged.
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

import { RecoilDriver } from './recoil-driver.js';

/** Default turret slew cap when a def carries no override (deg/s). */
export const DEFAULT_SLEW_DEG_PER_SEC = 120;

/** Milliseconds of no fresh Fired event before a unit disengages. */
export const DISENGAGE_MS = 4000;

/** Below this |angle| (radians) a releasing turret is treated as at rest. */
const REST_EPS = 1e-3;

/** Ratio of the yaw slew's angular-acceleration cap to its rate cap (1/s):
 *  how fast the turret ramps up to (or brakes from) `slewRate` — reaches it
 *  from rest in ~1/RATIO seconds. This is what reads as mechanical "turret
 *  lag" instead of an instant velocity change, and it scales with any
 *  per-unit rate override so a faster turret still spins up proportionally
 *  faster. */
const SLEW_ACCEL_RATIO = 5;

/** Damping ratio of the accel-limited slew's spring-damper law (< 1 =
 *  underdamped). Tuned so a large retarget — a target swinging past, or the
 *  return to rest on disengage — overshoots by roughly a degree before
 *  settling, instead of clamping dead-on the instant the barrel lines up. */
const SLEW_DAMPING_RATIO = 0.75;

/** Below this angle (rad) and rate (rad/s) together, snap the slew exactly
 *  onto the target rather than let the spring's exponential tail creep
 *  toward it forever — the same finite-settle guarantee the old constant-
 *  rate slew had by construction. */
const SLEW_SNAP_ANGLE = 0.3 * (Math.PI / 180);
const SLEW_SNAP_RATE = 3 * (Math.PI / 180);

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

/** One turretN piece (+ optional barrel) mapped to its 1-based weapon slot. */
export interface AimTurretSlot {
    /** Weapon slot this turret drives: `turret`→1, `turret2`→2, … — matches
     *  the unitdef's Lua `weapons[N]` order (DESIGN-MODEL-BUILDING §16c/§19),
     *  i.e. index N-1 of `TurretAimDeps.weaponDefIds`. */
    slot: number;
    turret: AimPiece;
    /** Optional barrel/sleeve child that pitches with target elevation. */
    barrel?: AimPiece;
}

export interface UnitAimPieces {
    /** One entry per turretN piece found on the template, ordered by slot
     *  ascending. `aimPieces()` returns null (not an empty array) for a
     *  model with no turret piece at all — a unit never engages then. */
    slots: AimTurretSlot[];
}

/** The minimal piece shape `matchAimSlots` needs — name + parent index.
 *  EntityRenderer's `PieceInfo` structurally satisfies this. */
export interface AimPieceDescriptor {
    name: string;
    parentIndex: number;
}

/** Turret/barrel piece indices matched from a template's piece list, before
 *  the Babylon-specific rest-offset lookup (that part stays in
 *  EntityRenderer, which owns `localMatrix`). Pure name/hierarchy matching —
 *  no Babylon dependency, so this is unit-testable without a model rig. */
export interface AimSlotMatch {
    slot: number;
    turretIdx: number;
    barrelIdx?: number;
}

/**
 * Match turretN / barrelN piece pairs per the DESIGN-MODEL-BUILDING §16c/§19
 * convention: a piece named exactly `turret` is weapon slot 1, `turret2` is
 * slot 2, etc. Each turretN's barrel is found by walking its DESCENDANTS
 * (not by name suffix) for a piece named `barrel`/`sleeve`/`gun` or
 * containing `barrel`/`sleeve` — the model's own hierarchy already isolates
 * `turret2 → barrel2` from `turret → barrel`, so no suffix pattern is needed
 * there. Returns one entry per turretN found, ordered by slot ascending
 * (empty when the template has no turret piece at all). A duplicate name
 * (e.g. two pieces both literally `turret2`) keeps the first occurrence,
 * matching the pre-existing single-turret behaviour of "first match wins".
 */
export function matchAimSlots(pieces: readonly AimPieceDescriptor[]): AimSlotMatch[] {
    const bySlot = new Map<number, AimSlotMatch>();
    for (let i = 0; i < pieces.length; i++) {
        const m = /^turret(\d*)$/.exec(pieces[i].name.toLowerCase());
        if (!m) continue;
        const slot = m[1] ? parseInt(m[1], 10) : 1;
        if (slot < 1 || bySlot.has(slot)) continue;
        bySlot.set(slot, { slot, turretIdx: i });
    }
    for (const match of bySlot.values()) {
        for (let i = 0; i < pieces.length; i++) {
            if (i === match.turretIdx) continue;
            let anc = pieces[i].parentIndex;
            let underTurret = false;
            while (anc >= 0) {
                if (anc === match.turretIdx) { underTurret = true; break; }
                anc = pieces[anc].parentIndex;
            }
            if (!underTurret) continue;
            const n = pieces[i].name.toLowerCase();
            if (n.includes('barrel') || n.includes('sleeve') || n === 'gun') {
                match.barrelIdx = i;
                break;
            }
        }
    }
    return [...bySlot.values()].sort((a, b) => a.slot - b.slot);
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
    /** Turret (+ optional barrel) pieces for a unit, one per weapon slot, or
     *  null when the model has no turret piece at all — such a unit never
     *  engages. */
    aimPieces(unitId: number): UnitAimPieces | null;
    /** True once the sim streams 0x05 piece state for this unit: it owns the
     *  turret, so the cosmetic controller must not touch it (ZK, BAR, and a
     *  future s4 sim-aim model). */
    simDrivesPieces(unitId: number): boolean;
    /** Per-unit slew-rate override (deg/s), e.g. derived from a def's turn
     *  rate or a `turret_slew_deg_per_sec` customparam. undefined → default. */
    slewRateDegPerSec?(unitId: number): number | undefined;
    /** The unit def's per-slot weapon list — index N-1 is weapon slot N's
     *  `weaponDefId` (UnitDefInfo.weaponDefIds order). Used by `resolveSlot`
     *  to narrow which turret a Fired event belongs to on a multi-turret
     *  unit; unused (and safely omittable) for single-turret units. null /
     *  omitted when the def isn't known yet — resolution falls back to
     *  muzzle-position matching. */
    weaponDefIds?(unitId: number): readonly number[] | null;
    /** `aoe` (elmos) + `projectileSpeed` (elmos/sim-frame) for a weaponDefId,
     *  or undefined when unknown — feeds the recoil kick (see
     *  `recoil-driver.ts`). Omitted/undefined means no recoil is applied,
     *  so existing callers/tests need not supply it. */
    weaponAoeVelocity?(weaponDefId: number): { aoe: number; projectileSpeed: number } | undefined;
}

/** Where poses go — EntityRenderer.setAimPose. Returns false when the unit
 *  no longer exists so the controller can drop it. */
export interface AimPoseSink {
    setAimPose(unitId: number, pose: ReadonlyMap<number, AimPiecePose> | null): boolean;
}

/** Minimal Fired-event shape the controller consumes (ProjectileFiredInfo).
 *  `weaponDefId` / `pos` are optional in the type (existing single-turret
 *  call sites / tests need not supply them) but are always present on the
 *  real wire event; they only matter for multi-turret slot resolution. */
export interface AimFiredEvent {
    ownerId: number;
    targetId: number;
    targetPos: AimVec;
    weaponDefId?: number;
    /** Muzzle launch position — the tie-breaker when multiple turret slots
     *  share a weaponDefId (see `resolveSlot`). */
    pos?: AimVec;
}

/** Minimal Volley-outcome event shape the controller consumes
 *  (VolleyOutcomeInfo). Statistical-resolution weapons spawn no projectile —
 *  VolleyOutcome is their only per-shot wire event — so `onVolley` adapts it
 *  onto the same fields `onFired` expects: `attackerId` → `ownerId`, and the
 *  event's impact position (its only position field — there is no separate
 *  frozen targetPos on this event, since fire and resolution are the same
 *  wire message) doubles as the fallback target position. `attackerId` is 0
 *  when the firer is hidden (already visibility-filtered server-side); such
 *  a volley never engages, same as a Fired event simply never arriving for
 *  a hidden shooter. */
export interface AimVolleyEvent {
    attackerId: number;
    targetId: number;
    weaponDefId: number;
    x: number;
    y: number;
    z: number;
}

interface Engagement {
    slot: number;
    turret: AimPiece;
    barrel?: AimPiece;
    targetId: number;
    /** The Fired event's frozen target position (fallback when the live
     *  target is unknown / out of LOS). */
    fallbackPos: AimVec;
    lastFireMs: number;
    /** Current slewed model-space turret yaw / barrel pitch (radians). */
    yaw: number;
    /** Current yaw angular rate (rad/s) — accel-limited slew state. */
    yawRate: number;
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

/** Angle + angular rate a `stepSlew` call advances by one tick. */
export interface SlewState {
    yaw: number;
    rate: number;
}

/**
 * Accel-limited step of an angular spring-damper toward `target`: turret lag
 * (a ramp-up to `rateCap` instead of an instant velocity change) plus a
 * small settle overshoot (see `SLEW_DAMPING_RATIO`). Pure and NaN-safe at
 * `dtSec` = 0 (the integration step only ever scales by `dtSec`, never
 * divides by it), and the acceleration is hard-clamped to
 * `rateCap * SLEW_ACCEL_RATIO` regardless of how large the error is — a
 * 180° retarget never produces an unbounded jolt.
 */
export function stepSlew(state: SlewState, target: number, dtSec: number, rateCap: number): SlewState {
    const omega = SLEW_ACCEL_RATIO;
    const accelCap = rateCap * SLEW_ACCEL_RATIO;
    const error = wrapPi(target - state.yaw);
    let accel = omega * omega * error - 2 * SLEW_DAMPING_RATIO * omega * state.rate;
    accel = accel > accelCap ? accelCap : accel < -accelCap ? -accelCap : accel;

    let rate = state.rate + accel * dtSec;
    rate = rate > rateCap ? rateCap : rate < -rateCap ? -rateCap : rate;

    let yaw = wrapPi(state.yaw + rate * dtSec);

    if (Math.abs(wrapPi(target - yaw)) < SLEW_SNAP_ANGLE && Math.abs(rate) < SLEW_SNAP_RATE) {
        yaw = wrapPi(target);
        rate = 0;
    }
    return { yaw, rate };
}

export class TurretAimController {
    private deps: TurretAimDeps;
    private sink: AimPoseSink;
    /** unitId → (weapon slot → Engagement). A unit with N turret pieces can
     *  have up to N independent engagements, each tracking its own target. */
    private engaged = new Map<number, Map<number, Engagement>>();
    /** Wall clock of the previous tick, for the per-tick slew budget. */
    private lastTickMs: number | null = null;
    /** Per-slot recoil kick, keyed by `recoilKey` — see recoil-driver.ts. */
    private recoil = new RecoilDriver();

    constructor(deps: TurretAimDeps, sink: AimPoseSink) {
        this.deps = deps;
        this.sink = sink;
    }

    /**
     * Register / refresh an engagement from a projectile Fired event. A unit
     * with no turret piece, or one the sim already piece-drives, is ignored.
     * Resolves which turret slot the shot belongs to (single-turret units
     * always resolve to their one slot); re-firing an already-engaged slot
     * preserves its current slewed yaw/pitch so tracking is smooth.
     */
    onFired(ev: AimFiredEvent, nowMs: number): void {
        const unitId = ev.ownerId;
        if (unitId <= 0) return;
        if (this.deps.simDrivesPieces(unitId)) return;
        const pieces = this.deps.aimPieces(unitId);
        if (!pieces || pieces.slots.length === 0) return;

        const unitSlots = this.engaged.get(unitId);
        const target = this.resolveSlot(unitId, pieces, ev, unitSlots);
        if (!target) return;

        // Every real shot kicks, whether it refreshes an existing engagement
        // or starts a new one — a Fired/VolleyOutcome event IS one shot.
        if (ev.weaponDefId !== undefined) {
            const wd = this.deps.weaponAoeVelocity?.(ev.weaponDefId);
            if (wd) this.recoil.kick(this.recoilKey(unitId, target.slot), wd.aoe, wd.projectileSpeed);
        }

        const existing = unitSlots?.get(target.slot);
        if (existing) {
            existing.targetId = ev.targetId;
            existing.fallbackPos = ev.targetPos;
            existing.lastFireMs = nowMs;
            existing.releasing = false;
            return;
        }
        const slots = unitSlots ?? new Map<number, Engagement>();
        slots.set(target.slot, {
            slot: target.slot,
            turret: target.turret,
            barrel: target.barrel,
            targetId: ev.targetId,
            fallbackPos: ev.targetPos,
            lastFireMs: nowMs,
            yaw: 0,
            yawRate: 0,
            pitch: 0,
            releasing: false,
        });
        if (!unitSlots) this.engaged.set(unitId, slots);
    }

    private recoilKey(unitId: number, slot: number): string {
        return `${unitId}:${slot}`;
    }

    /**
     * Register / refresh an engagement from a statistical-combat
     * `VolleyOutcome` event — the counterpart to `onFired` for weapons that
     * never spawn a projectile. Adapts the event onto `onFired`'s shape and
     * reuses the identical engage + `resolveSlot` machinery: `ownerId` is
     * the volley's `attackerId`, `targetPos` falls back to the volley's
     * impact position, and the muzzle-position tiebreak (only relevant for a
     * multi-turret unit whose slots share a weaponDefId) uses the attacker's
     * live world position — the closest approximation available, since a
     * volley carries no per-shot muzzle position on the wire the way a Fired
     * event does. A unit that receives both Fired and Volley events (e.g. a
     * multi-weapon unit mixing resolution models) keeps one engagement per
     * slot either way, keyed the same as `onFired`.
     */
    onVolley(ev: AimVolleyEvent, nowMs: number): void {
        const attackerPos = this.deps.unitPose(ev.attackerId);
        this.onFired({
            ownerId: ev.attackerId,
            targetId: ev.targetId,
            targetPos: { x: ev.x, y: ev.y, z: ev.z },
            weaponDefId: ev.weaponDefId,
            pos: attackerPos ? { x: attackerPos.x, y: attackerPos.y, z: attackerPos.z } : undefined,
        }, nowMs);
    }

    /**
     * Which turret slot a Fired event belongs to. A single-turret unit
     * always returns its one slot — weaponDefId/pos are never consulted, so
     * single-turret behaviour is byte-identical to the pre-multi-turret
     * controller. Multi-turret units narrow by weaponDefId first; if slots
     * still tie (shared weapon type, e.g. twin roof howitzers) the shot's
     * actual muzzle position breaks the tie against each candidate's
     * approximate world mount point; with neither weaponDefId nor pos
     * available the least-recently-fired tied candidate is picked, so shots
     * still distribute across every matching turret over time.
     */
    private resolveSlot(
        unitId: number,
        pieces: UnitAimPieces,
        ev: AimFiredEvent,
        unitSlots: ReadonlyMap<number, Engagement> | undefined,
    ): AimTurretSlot | null {
        if (pieces.slots.length === 1) return pieces.slots[0];

        let candidates = pieces.slots;
        const weaponDefIds = ev.weaponDefId !== undefined
            ? this.deps.weaponDefIds?.(unitId) : null;
        if (weaponDefIds) {
            const matched = pieces.slots.filter((s) => weaponDefIds[s.slot - 1] === ev.weaponDefId);
            if (matched.length > 0) candidates = matched;
        }
        if (candidates.length === 1) return candidates[0];

        if (ev.pos) {
            const pose = this.deps.unitPose(unitId);
            if (pose) {
                const heading = (pose.heading / 65535) * TWO_PI;
                const cos = Math.cos(heading);
                const sin = Math.sin(heading);
                let best = candidates[0];
                let bestDist = Infinity;
                for (const c of candidates) {
                    // Approximate world mount point: rotate the turret's
                    // hull-local offset by heading (same convention as the
                    // tick-time bearing math below).
                    const wx = pose.x + (c.turret.px * cos + c.turret.pz * sin);
                    const wz = pose.z + (-c.turret.px * sin + c.turret.pz * cos);
                    const dx = wx - ev.pos.x;
                    const dz = wz - ev.pos.z;
                    const dist = dx * dx + dz * dz;
                    if (dist < bestDist) { bestDist = dist; best = c; }
                }
                return best;
            }
        }

        let best = candidates[0];
        let bestMs = unitSlots?.get(best.slot)?.lastFireMs ?? -Infinity;
        for (const c of candidates) {
            const ms = unitSlots?.get(c.slot)?.lastFireMs ?? -Infinity;
            if (ms < bestMs) { bestMs = ms; best = c; }
        }
        return best;
    }

    /**
     * Advance every engagement: recompute the desired aim, slew toward it
     * under the turn-rate cap, and push the merged per-turret pose (or
     * release a unit that has finished slewing back to rest / gone
     * sim-driven / disappeared).
     */
    tick(nowMs: number): void {
        const dtSec = this.lastTickMs === null ? 0 : Math.max(0, (nowMs - this.lastTickMs) / 1000);
        this.lastTickMs = nowMs;
        this.recoil.tick(dtSec);
        if (this.engaged.size === 0) return;

        for (const [unitId, slots] of this.engaged) {
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
                if (!this.sink.setAimPose(unitId, this.buildPose(unitId, slots))) {
                    this.engaged.delete(unitId);
                }
                continue;
            }

            const rateCap = this.slewRate(unitId);
            const pitchStep = rateCap * dtSec;
            for (const [slot, e] of slots) {
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
                    if (e.barrel) {
                        // Elevation angle from the muzzle to the target. Barrel
                        // pitch about Spring X is negated (RotateX(+) pitches the
                        // nose DOWN in Spring's LH frame), so a target above the
                        // unit gets a negative rx that lifts the barrel. Best-
                        // effort cosmetic: exact muzzle height is noise at zoom.
                        const horiz = Math.hypot(dx, dz) || 1e-6;
                        desiredPitch = -Math.atan2(target.y - pose.y, horiz);
                    }
                }

                const slewed = stepSlew({ yaw: e.yaw, rate: e.yawRate }, desiredYaw, dtSec, rateCap);
                e.yaw = slewed.yaw;
                e.yawRate = slewed.rate;
                if (e.barrel) e.pitch = slewAngle(e.pitch, desiredPitch, pitchStep);

                if (e.releasing && Math.abs(e.yaw) < REST_EPS
                    && (!e.barrel || Math.abs(e.pitch) < REST_EPS)) {
                    slots.delete(slot);
                }
            }

            if (slots.size === 0) {
                this.sink.setAimPose(unitId, null);
                this.engaged.delete(unitId);
                continue;
            }

            if (!this.sink.setAimPose(unitId, this.buildPose(unitId, slots))) {
                this.engaged.delete(unitId);
            }
        }
    }

    /** Merged turret (+ barrel) Spring-euler poses for every engaged slot on
     *  a unit, from each slot's current slewed angles plus its recoil kick
     *  (see recoil-driver.ts) along the barrel's — or, absent a barrel, the
     *  turret's, at 30% weight — local Z (the muzzle's forward axis, so a
     *  kick along +Z is straight backward regardless of aim angle). */
    private buildPose(unitId: number, slots: ReadonlyMap<number, Engagement>): Map<number, AimPiecePose> {
        const pose = new Map<number, AimPiecePose>();
        for (const e of slots.values()) {
            const kick = this.recoil.offset(this.recoilKey(unitId, e.slot));
            // Preserve the rest mount offset (px,py,pz); yaw about Spring Y.
            pose.set(e.turret.idx, {
                px: e.turret.px, py: e.turret.py, pz: e.turret.pz + (e.barrel ? 0 : kick * 0.3),
                rx: 0, ry: e.yaw, rz: 0,
            });
            if (e.barrel) {
                // Barrel inherits the turret's yaw through the parent chain; it
                // only adds pitch about Spring X (plus the recoil kick on Z).
                pose.set(e.barrel.idx, {
                    px: e.barrel.px, py: e.barrel.py, pz: e.barrel.pz + kick,
                    rx: e.pitch, ry: 0, rz: 0,
                });
            }
        }
        return pose;
    }

    private slewRate(unitId: number): number {
        const override = this.deps.slewRateDegPerSec?.(unitId);
        const deg = override && override > 0 ? override : DEFAULT_SLEW_DEG_PER_SEC;
        return deg * DEG2RAD;
    }

    /** Drop a unit's engagements, all slots (death / LOS eviction). */
    remove(unitId: number): void {
        this.engaged.delete(unitId);
    }

    reset(): void {
        this.engaged.clear();
        this.lastTickMs = null;
        this.recoil.reset();
    }

    /** Debug/test view: a unit's per-slot state (default slot 1 — the sole
     *  turret on a single-turret unit, preserving the old call shape). */
    stateOf(unitId: number, slot = 1): { yaw: number; pitch: number; releasing: boolean } | null {
        const e = this.engaged.get(unitId)?.get(slot);
        return e ? { yaw: e.yaw, pitch: e.pitch, releasing: e.releasing } : null;
    }

    /** Slot numbers currently engaged on a unit, ascending (empty if none). */
    engagedSlots(unitId: number): number[] {
        return [...(this.engaged.get(unitId)?.keys() ?? [])].sort((a, b) => a - b);
    }

    /** Number of units with at least one engaged turret (not total slots). */
    get count(): number {
        return this.engaged.size;
    }
}
