import { describe, it, expect } from 'vitest';
import {
    TurretAimController,
    slewAngle,
    stepSlew,
    matchAimSlots,
    DEFAULT_SLEW_DEG_PER_SEC,
    DISENGAGE_MS,
    type TurretAimDeps,
    type AimPoseSink,
    type AimPiecePose,
    type UnitAimPieces,
    type AimVec,
    type AimPieceDescriptor,
    type SlewState,
} from './turret-aim-controller.js';

const DEG2RAD = Math.PI / 180;

/** Recording sink: last pose pushed per unit (null once cleared). */
class FakeSink implements AimPoseSink {
    poses = new Map<number, ReadonlyMap<number, AimPiecePose> | null>();
    known = new Set<number>();
    setAimPose(id: number, pose: ReadonlyMap<number, AimPiecePose> | null): boolean {
        if (pose !== null && !this.known.has(id)) { this.poses.delete(id); return false; }
        this.poses.set(id, pose);
        return true;
    }
    /** Yaw of the piece at `idx` (undefined if that piece has no pose this tick). */
    yawAt(id: number, idx: number): number | undefined {
        return this.poses.get(id)?.get(idx)?.ry;
    }
    /** Pitch of the piece at `idx`. */
    pitchAt(id: number, idx: number): number | undefined {
        return this.poses.get(id)?.get(idx)?.rx;
    }
    // Single-turret convenience: the lone turret's yaw is the sole rx===0,
    // ry!==undefined entry; the barrel's pitch is the sole ry===0 entry.
    turretYaw(id: number): number | null {
        const p = this.poses.get(id);
        if (!p) return null;
        for (const pose of p.values()) if (pose.rx === 0 && pose.ry !== undefined) return pose.ry;
        return null;
    }
    barrelPitch(id: number): number | null {
        const p = this.poses.get(id);
        if (!p) return null;
        for (const pose of p.values()) if (pose.ry === 0 && pose.rx !== 0) return pose.rx;
        return null;
    }
}

interface Cfg {
    unit?: { x: number; y: number; z: number; heading: number } | null;
    target?: AimVec | null;
    pieces?: UnitAimPieces | null;
    simDriven?: boolean;
    rate?: number;
    weaponDefIds?: readonly number[] | null;
    weaponAoeVelocity?: (weaponDefId: number) => { aoe: number; projectileSpeed: number } | undefined;
}

const SINGLE_TURRET_PIECES: UnitAimPieces = {
    slots: [{ slot: 1, turret: { idx: 1, px: 0, py: 10, pz: 0 } }],
};

function makeDeps(cfg: Cfg): { deps: TurretAimDeps; cfg: Cfg } {
    // `in` checks, not `??`, so an explicit `pieces: null` (no-turret model)
    // is honoured rather than replaced by the default.
    const state: Cfg = {
        unit: 'unit' in cfg ? cfg.unit : { x: 0, y: 0, z: 0, heading: 0 },
        target: 'target' in cfg ? cfg.target : null,
        pieces: 'pieces' in cfg ? cfg.pieces : SINGLE_TURRET_PIECES,
        simDriven: cfg.simDriven ?? false,
        rate: cfg.rate,
        weaponDefIds: 'weaponDefIds' in cfg ? cfg.weaponDefIds : null,
        weaponAoeVelocity: cfg.weaponAoeVelocity,
    };
    const deps: TurretAimDeps = {
        unitPose: () => state.unit ?? null,
        targetPos: () => state.target ?? null,
        aimPieces: () => state.pieces ?? null,
        simDrivesPieces: () => state.simDriven ?? false,
        slewRateDegPerSec: () => state.rate,
        weaponDefIds: () => state.weaponDefIds ?? null,
        weaponAoeVelocity: state.weaponAoeVelocity,
    };
    return { deps, cfg: state };
}

const OWNER = 42;
const TARGET = 7;
/** Standard fired event: shot from OWNER at entity TARGET, frozen fallback. */
const fired = (targetPos: AimVec = { x: 100, y: 0, z: 0 }, extra: { weaponDefId?: number; pos?: AimVec } = {}) => ({
    ownerId: OWNER, targetId: TARGET, targetPos, ...extra,
});
/** Standard volley outcome: statistical-combat shot from OWNER at TARGET,
 *  impact position doubling as the frozen fallback (VolleyOutcome carries no
 *  separate targetPos field). */
const volley = (impactPos: AimVec = { x: 100, y: 0, z: 0 }, weaponDefId = 1) => ({
    attackerId: OWNER, targetId: TARGET, weaponDefId, x: impactPos.x, y: impactPos.y, z: impactPos.z,
});

describe('slewAngle', () => {
    it('clamps the step and takes the shortest arc', () => {
        expect(slewAngle(0, Math.PI / 2, 0.1)).toBeCloseTo(0.1, 6);
        expect(slewAngle(0, -Math.PI / 2, 0.1)).toBeCloseTo(-0.1, 6);
        // Shortest arc across the ±π seam: from +3.0 to -3.0 goes forward.
        const near = slewAngle(3.0, -3.0, 0.1);
        expect(near).toBeCloseTo(3.1, 6);
    });
    it('snaps when within one step', () => {
        expect(slewAngle(1.0, 1.05, 0.2)).toBeCloseTo(1.05, 6);
    });
});

describe('matchAimSlots — piece matching', () => {
    const desc = (name: string, parentIndex: number): AimPieceDescriptor => ({ name, parentIndex });

    it('finds no slots on a model with no turret piece', () => {
        const pieces = [desc('body', -1), desc('tracks_l', 0), desc('tracks_r', 0)];
        expect(matchAimSlots(pieces)).toEqual([]);
    });

    it('matches a single bare "turret" as slot 1, case-insensitively', () => {
        const pieces = [desc('body', -1), desc('Turret', 0), desc('barrel', 1), desc('muzzle', 2)];
        const m = matchAimSlots(pieces);
        expect(m).toEqual([{ slot: 1, turretIdx: 1, barrelIdx: 2 }]);
    });

    it('does not match "turret" as a substring of another piece name', () => {
        const pieces = [desc('body', -1), desc('turret_mount', 0)];
        expect(matchAimSlots(pieces)).toEqual([]);
    });

    it('matches turret/turret2/turret3 as slots 1/2/3, each with its own barrel', () => {
        // fable_train_gun's real piece order: body, turret, barrel, muzzle,
        // turret2, barrel2, muzzle2, turret3, barrel3, muzzle3, axles, links.
        const pieces = [
            desc('MS_fable_train_gun', -1), desc('body', 0),
            desc('turret', 1), desc('barrel', 2), desc('muzzle', 3),
            desc('turret2', 1), desc('barrel2', 5), desc('muzzle2', 6),
            desc('turret3', 1), desc('barrel3', 8), desc('muzzle3', 9),
        ];
        const m = matchAimSlots(pieces);
        expect(m).toEqual([
            { slot: 1, turretIdx: 2, barrelIdx: 3 },
            { slot: 2, turretIdx: 5, barrelIdx: 6 },
            { slot: 3, turretIdx: 8, barrelIdx: 9 },
        ]);
    });

    it('is unaffected by piece-array order — slots come back sorted ascending', () => {
        const pieces = [
            desc('body', -1),
            desc('turret3', 0), desc('barrel3', 1),
            desc('turret', 0), desc('barrel', 3),
            desc('turret2', 0), desc('barrel2', 5),
        ];
        const m = matchAimSlots(pieces);
        expect(m.map((s) => s.slot)).toEqual([1, 2, 3]);
    });

    it('a turret with no barrel descendant yields slot with no barrelIdx', () => {
        const pieces = [desc('body', -1), desc('turret', 0)];
        expect(matchAimSlots(pieces)).toEqual([{ slot: 1, turretIdx: 1 }]);
    });

    it('only matches a barrel-like piece that hangs under its own turret', () => {
        // barrel2 is a SIBLING of turret2 (parent 0), not its descendant —
        // must not be picked up as turret2's barrel.
        const pieces = [
            desc('body', -1), desc('turret', 0), desc('barrel', 1),
            desc('turret2', 0), desc('barrel2', 0),
        ];
        const m = matchAimSlots(pieces);
        expect(m.find((s) => s.slot === 2)).toEqual({ slot: 2, turretIdx: 3 });
    });

    it('keeps the first occurrence on a duplicate turret name', () => {
        const pieces = [desc('body', -1), desc('turret', 0), desc('decoy', 0), desc('turret', 0)];
        const m = matchAimSlots(pieces);
        expect(m).toEqual([{ slot: 1, turretIdx: 1 }]);
    });
});

describe('TurretAimController — engage', () => {
    it('engages on a Fired event and slews the turret toward the bearing', () => {
        // Unit at origin facing +Z (heading 0); target at +X → bearing +π/2.
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        expect(c.count).toBe(1);
        // Prime + ~2 s of 100 ms ticks; yaw converges to +π/2.
        for (let t = 0; t <= 2000; t += 100) c.tick(t);
        expect(sink.turretYaw(OWNER)).toBeCloseTo(Math.PI / 2, 3);
    });

    it('uses the frozen event targetPos when no live target position exists', () => {
        // targetPos dep returns null (out of LOS) → falls back to event pos.
        const { deps } = makeDeps({ target: null });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired({ x: 0, y: 0, z: -100 }), 0); // due -Z → bearing π
        for (let t = 0; t <= 3000; t += 100) c.tick(t);
        expect(Math.abs(sink.turretYaw(OWNER)!)).toBeCloseTo(Math.PI, 3);
    });

    it('subtracts the hull heading so the turret lands at the world bearing', () => {
        // Hull already faces +X (heading = quarter turn); target at +X → the
        // turret's model-space yaw should be ~0 (gun already points there).
        const heading = Math.round(65535 * 0.25);
        const { deps } = makeDeps({
            unit: { x: 0, y: 0, z: 0, heading }, target: { x: 100, y: 0, z: 0 },
        });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        for (let t = 0; t <= 2000; t += 100) c.tick(t);
        expect(Math.abs(sink.turretYaw(OWNER)!)).toBeLessThan(0.01);
    });
});

describe('TurretAimController — track', () => {
    it('re-aims as the target moves', () => {
        const { deps, cfg } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        for (let t = 0; t <= 2000; t += 100) c.tick(t);
        expect(sink.turretYaw(OWNER)).toBeCloseTo(Math.PI / 2, 2);
        // Target swings to -X → bearing -π/2. Keep firing so it stays engaged.
        cfg.target = { x: -100, y: 0, z: 0 };
        for (let t = 2100; t <= 5000; t += 100) { c.onFired(fired(), t); c.tick(t); }
        expect(sink.turretYaw(OWNER)).toBeCloseTo(-Math.PI / 2, 2);
    });
});

describe('stepSlew — accel-limited turret lag', () => {
    const RATE_CAP = DEFAULT_SLEW_DEG_PER_SEC * DEG2RAD;

    it('ramps up rather than snapping straight to the rate cap', () => {
        // A 180° retarget: the first tick must move LESS than a constant-rate
        // slew would (rate*dt) — acceleration is ramping, not instant.
        let s: SlewState = { yaw: 0, rate: 0 };
        s = stepSlew(s, Math.PI, 1 / 60, RATE_CAP);
        expect(Math.abs(s.yaw)).toBeLessThan(RATE_CAP / 60);
        expect(Math.abs(s.rate)).toBeLessThan(RATE_CAP);
    });

    it('never exceeds the acceleration cap regardless of how large the error is', () => {
        const accelCap = RATE_CAP * 5; // SLEW_ACCEL_RATIO, mirrored here
        let s: SlewState = { yaw: 0, rate: 0 };
        const dt = 1 / 60;
        for (let i = 0; i < 300; i++) {
            const prevRate = s.rate;
            s = stepSlew(s, Math.PI, dt, RATE_CAP); // a full-range retarget every tick
            const accel = Math.abs(s.rate - prevRate) / dt;
            expect(accel).toBeLessThanOrEqual(accelCap + 1e-6);
        }
    });

    it('is a no-op with no NaN at dt=0', () => {
        const s0: SlewState = { yaw: 0.4, rate: 0.2 };
        const s1 = stepSlew(s0, Math.PI, 0, RATE_CAP);
        expect(s1.yaw).toBeCloseTo(s0.yaw, 10);
        expect(s1.rate).toBeCloseTo(s0.rate, 10);
        expect(s1.yaw).not.toBeNaN();
        expect(s1.rate).not.toBeNaN();
    });

    it('eventually converges and snaps exactly onto a stationary target', () => {
        let s: SlewState = { yaw: 0, rate: 0 };
        for (let i = 0; i < 300; i++) s = stepSlew(s, Math.PI / 2, 1 / 60, RATE_CAP);
        expect(s.yaw).toBe(Math.PI / 2);
        expect(s.rate).toBe(0);
    });

    it('honours a per-unit slew-rate override as the eventual rate/angle cap', () => {
        const override = 60 * DEG2RAD;
        let s: SlewState = { yaw: 0, rate: 0 };
        let maxRate = 0;
        for (let i = 0; i < 300; i++) {
            s = stepSlew(s, Math.PI / 2, 1 / 60, override);
            maxRate = Math.max(maxRate, Math.abs(s.rate));
        }
        expect(maxRate).toBeLessThanOrEqual(override + 1e-9);
        expect(s.yaw).toBeCloseTo(Math.PI / 2, 5);
    });
});

describe('TurretAimController — recoil kick', () => {
    it('kicks the barrel along its local Z axis on a fired shot with a known weapon', () => {
        const pieces: UnitAimPieces = {
            slots: [{
                slot: 1,
                turret: { idx: 1, px: 0, py: 10, pz: 0 },
                barrel: { idx: 2, px: 0, py: 0, pz: 5 },
            }],
        };
        const { deps } = makeDeps({
            pieces, target: { x: 100, y: 0, z: 0 },
            weaponAoeVelocity: () => ({ aoe: 24, projectileSpeed: 650 / 30 }),
        });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(undefined, { weaponDefId: 1 }), 0);
        c.tick(0);  // prime: dt=0
        c.tick(1);  // dt=1ms — recoil is fresh, barrel pushed back
        const barrelPose = sink.poses.get(OWNER)?.get(2);
        expect(barrelPose).toBeDefined();
        expect(barrelPose!.pz).toBeGreaterThan(5); // rest pz=5, kicked backward (+Z)
    });

    it('kicks the turret at reduced weight when the slot has no barrel', () => {
        const pieces: UnitAimPieces = { slots: [{ slot: 1, turret: { idx: 1, px: 0, py: 3, pz: 2 } }] };
        const { deps } = makeDeps({
            pieces, target: { x: 100, y: 0, z: 0 },
            weaponAoeVelocity: () => ({ aoe: 24, projectileSpeed: 650 / 30 }),
        });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(undefined, { weaponDefId: 1 }), 0);
        c.tick(0);  // prime: dt=0
        c.tick(1);  // dt=1ms
        const turretPose = sink.poses.get(OWNER)?.get(1);
        expect(turretPose!.pz).toBeGreaterThan(2);
    });

    it('applies no kick when the dep is not supplied (existing behaviour unchanged)', () => {
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(undefined, { weaponDefId: 1 }), 0);
        c.tick(0);
        c.tick(1);
        expect(sink.poses.get(OWNER)?.get(1)?.pz).toBe(0);
    });
});

describe('TurretAimController — disengage decay', () => {
    it('slews back to rest ~4 s after the last shot, then releases', () => {
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        // Converge to +π/2 well within the disengage window.
        for (let t = 0; t <= 2000; t += 100) c.tick(t);
        expect(sink.turretYaw(OWNER)).toBeCloseTo(Math.PI / 2, 2);
        // Still engaged just before the timeout.
        c.tick(DISENGAGE_MS - 100);
        expect(c.stateOf(OWNER)?.releasing).toBe(false);
        // Past the timeout: enters releasing and the yaw starts decaying.
        c.tick(DISENGAGE_MS + 100);
        expect(c.stateOf(OWNER)?.releasing).toBe(true);
        const decaying = sink.turretYaw(OWNER)!;
        expect(decaying).toBeLessThan(Math.PI / 2);
        // Keep ticking (no new shots) until it fully releases.
        for (let t = DISENGAGE_MS + 200; t <= DISENGAGE_MS + 2000; t += 100) c.tick(t);
        expect(c.count).toBe(0);
        expect(sink.poses.get(OWNER)).toBeNull();
    });

    it('a fresh shot mid-decay re-engages instead of releasing', () => {
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        // Tick continuously (render-rate dt) so the decay is gradual, not a
        // single huge-dt snap: the unit is still present, just releasing.
        for (let t = 0; t <= DISENGAGE_MS + 100; t += 100) c.tick(t);
        expect(c.stateOf(OWNER)?.releasing).toBe(true);
        expect(c.stateOf(OWNER)!.yaw).toBeGreaterThan(0.1); // not fully rested yet
        c.onFired(fired(), DISENGAGE_MS + 150); // re-fire
        expect(c.stateOf(OWNER)?.releasing).toBe(false);
    });
});

describe('TurretAimController — onVolley (statistical combat)', () => {
    it('engages the correct slot on a volley event, same as a Fired event', () => {
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onVolley(volley(), 0);
        expect(c.count).toBe(1);
        expect(c.engagedSlots(OWNER)).toEqual([1]);
        for (let t = 0; t <= 2000; t += 100) c.tick(t);
        expect(sink.turretYaw(OWNER)).toBeCloseTo(Math.PI / 2, 3);
    });

    it('falls back to the volley impact position when no live target exists', () => {
        const { deps } = makeDeps({ target: null });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onVolley(volley({ x: 0, y: 0, z: -100 }), 0); // due -Z -> bearing pi
        for (let t = 0; t <= 3000; t += 100) c.tick(t);
        expect(Math.abs(sink.turretYaw(OWNER)!)).toBeCloseTo(Math.PI, 3);
    });

    it('a hidden attacker (attackerId 0, visibility-filtered) never engages', () => {
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        const c = new TurretAimController(deps, sink);
        c.onVolley({ attackerId: 0, targetId: TARGET, weaponDefId: 1, x: 100, y: 0, z: 0 }, 0);
        expect(c.count).toBe(0);
    });

    it('a unit receiving both Fired and Volley events keeps one engagement per slot', () => {
        // A unit mixing resolution models (or the same weapon reported both
        // ways across a transition) must not double-engage the same slot.
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        expect(c.count).toBe(1);
        c.onVolley(volley(), 100);
        expect(c.count).toBe(1);
        expect(c.engagedSlots(OWNER)).toEqual([1]);
        for (let t = 0; t <= 2000; t += 100) c.tick(t);
        expect(sink.turretYaw(OWNER)).toBeCloseTo(Math.PI / 2, 3);
        // Keep alternating event kinds well past the disengage window — the
        // slot must stay engaged as long as EITHER kind keeps refreshing it.
        c.onFired(fired(), 2000);
        c.tick(2100);
        expect(c.stateOf(OWNER)?.releasing).toBe(false);
        c.onVolley(volley(), DISENGAGE_MS + 1900);
        c.tick(DISENGAGE_MS + 2000);
        expect(c.stateOf(OWNER)?.releasing).toBe(false);
    });

    it('disengages to rest after the quiet window when only volleys fired', () => {
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onVolley(volley(), 0);
        for (let t = 0; t <= 2000; t += 100) c.tick(t);
        expect(sink.turretYaw(OWNER)).toBeCloseTo(Math.PI / 2, 2);
        // Still engaged just before the timeout.
        c.tick(DISENGAGE_MS - 100);
        expect(c.stateOf(OWNER)?.releasing).toBe(false);
        // Past the timeout: enters releasing and the yaw starts decaying.
        c.tick(DISENGAGE_MS + 100);
        expect(c.stateOf(OWNER)?.releasing).toBe(true);
        const decaying = sink.turretYaw(OWNER)!;
        expect(decaying).toBeLessThan(Math.PI / 2);
        // Keep ticking (no new volleys) until it fully releases.
        for (let t = DISENGAGE_MS + 200; t <= DISENGAGE_MS + 2000; t += 100) c.tick(t);
        expect(c.count).toBe(0);
        expect(sink.poses.get(OWNER)).toBeNull();
    });
});

describe('TurretAimController — 0x05 precedence / gating', () => {
    it('never engages a unit the sim already piece-drives', () => {
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 }, simDriven: true });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        expect(c.count).toBe(0);
        c.tick(100);
        expect(sink.poses.get(OWNER) ?? null).toBeNull();
    });

    it('releases mid-engagement the moment the sim takes over the pieces', () => {
        const { deps, cfg } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        for (let t = 0; t <= 1000; t += 100) c.tick(t);
        expect(c.count).toBe(1);
        cfg.simDriven = true;             // 0x05 arrives → sim owns the turret
        c.tick(1100);
        expect(c.count).toBe(0);
        expect(sink.poses.get(OWNER)).toBeNull(); // cosmetic pose cleared
    });

    it('never engages a model without a turret piece', () => {
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 }, pieces: null });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        expect(c.count).toBe(0);
    });
});

describe('TurretAimController — barrel pitch', () => {
    it('pitches the barrel toward an elevated target', () => {
        const pieces: UnitAimPieces = {
            slots: [{
                slot: 1,
                turret: { idx: 1, px: 0, py: 10, pz: 0 },
                barrel: { idx: 2, px: 0, py: 0, pz: 5 },
            }],
        };
        // Target above and ahead (+Z, +Y) → non-zero pitch, ~0 yaw.
        const { deps } = makeDeps({ pieces, target: { x: 0, y: 80, z: 100 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired({ ownerId: OWNER, targetId: TARGET, targetPos: { x: 0, y: 80, z: 100 } }, 0);
        for (let t = 0; t <= 3000; t += 100) c.tick(t);
        const pitch = sink.barrelPitch(OWNER);
        expect(pitch).not.toBeNull();
        // Elevated target → barrel lifts (negative rx in Spring's LH frame).
        expect(pitch!).toBeLessThan(0);
        expect(Math.abs(sink.turretYaw(OWNER)!)).toBeLessThan(0.01);
    });
});

describe('TurretAimController — multi-turret', () => {
    // fable_train_gun-shaped rig: turret (fore, +Z), turret2 (aft, -Z),
    // turret3 (MG cupola, no barrel). Slots 1 and 2 share a weaponDefId
    // (twin howitzers) — the interesting disambiguation case.
    const HOWITZER = 100, MG = 200;
    const GUN_CAR_PIECES: UnitAimPieces = {
        slots: [
            { slot: 1, turret: { idx: 2, px: 0, py: 3, pz: 4 }, barrel: { idx: 3, px: 0, py: 0, pz: 1 } },
            { slot: 2, turret: { idx: 5, px: 0, py: 3, pz: -4 }, barrel: { idx: 6, px: 0, py: 0, pz: 1 } },
            { slot: 3, turret: { idx: 8, px: 2, py: 3, pz: 0 } },
        ],
    };
    const WEAPON_DEF_IDS = [HOWITZER, HOWITZER, MG];

    it('each turret slot tracks its own target independently', () => {
        const { deps } = makeDeps({ pieces: GUN_CAR_PIECES, weaponDefIds: WEAPON_DEF_IDS });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        // Slot 1 (fore, weapon 100) fires at +X; slot 2 (aft, weapon 100)
        // fires at -X; slot 3 (MG, weapon 200) fires at +Z — three distinct
        // bearings, disambiguated purely from muzzle pos + weaponDefId.
        c.onFired({ ownerId: OWNER, targetId: 1, targetPos: { x: 1000, y: 0, z: 0 }, weaponDefId: HOWITZER, pos: { x: 0, y: 3, z: 4 } }, 0);
        c.onFired({ ownerId: OWNER, targetId: 2, targetPos: { x: -1000, y: 0, z: 0 }, weaponDefId: HOWITZER, pos: { x: 0, y: 3, z: -4 } }, 0);
        c.onFired({ ownerId: OWNER, targetId: 3, targetPos: { x: 0, y: 0, z: 1000 }, weaponDefId: MG, pos: { x: 2, y: 3, z: 0 } }, 0);
        expect(c.engagedSlots(OWNER)).toEqual([1, 2, 3]);

        for (let t = 0; t <= 3000; t += 100) c.tick(t);

        expect(sink.yawAt(OWNER, 2)).toBeCloseTo(Math.PI / 2, 2);   // slot 1 → +X
        expect(sink.yawAt(OWNER, 5)).toBeCloseTo(-Math.PI / 2, 2);  // slot 2 → -X
        expect(sink.yawAt(OWNER, 8)).toBeCloseTo(0, 2);             // slot 3 → +Z
    });

    it('resolves ties on a shared weaponDefId by nearest muzzle position', () => {
        const { deps } = makeDeps({ pieces: GUN_CAR_PIECES, weaponDefIds: WEAPON_DEF_IDS });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        // Muzzle pos (0,3,4) sits at the fore turret's mount — must resolve
        // to slot 1 even though both slot 1 and 2 share weaponDefId HOWITZER.
        c.onFired({ ownerId: OWNER, targetId: 1, targetPos: { x: 1000, y: 0, z: 0 }, weaponDefId: HOWITZER, pos: { x: 0, y: 3, z: 4 } }, 0);
        expect(c.engagedSlots(OWNER)).toEqual([1]);
        // A second shot from the aft mount goes to slot 2.
        c.onFired({ ownerId: OWNER, targetId: 2, targetPos: { x: -1000, y: 0, z: 0 }, weaponDefId: HOWITZER, pos: { x: 0, y: 3, z: -4 } }, 0);
        expect(c.engagedSlots(OWNER)).toEqual([1, 2]);
    });

    it('falls back to least-recently-fired tied candidate with no weaponDefId/pos hint', () => {
        const { deps } = makeDeps({ pieces: GUN_CAR_PIECES, weaponDefIds: null });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        // No weaponDefId/pos on either event: first shot picks slot 1 (both
        // idle, arbitrary tiebreak on order); second shot — now slot 1 is
        // "more recently fired" than idle slot 2 — must land on slot 2 so
        // both turrets end up engaged rather than both hammering slot 1.
        c.onFired({ ownerId: OWNER, targetId: 1, targetPos: { x: 1000, y: 0, z: 0 } }, 0);
        expect(c.engagedSlots(OWNER)).toEqual([1]);
        c.onFired({ ownerId: OWNER, targetId: 2, targetPos: { x: -1000, y: 0, z: 0 } }, 10);
        expect(c.engagedSlots(OWNER)).toEqual([1, 2]);
    });

    it('a single-turret unit ignores weaponDefId/pos entirely (byte-identical path)', () => {
        // Sanity: SINGLE_TURRET_PIECES has one slot — resolveSlot must take
        // the length===1 fast path regardless of what the event carries.
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 }, weaponDefIds: [999] });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(undefined, { weaponDefId: 12345, pos: { x: 9999, y: 9999, z: 9999 } }), 0);
        expect(c.count).toBe(1);
        for (let t = 0; t <= 2000; t += 100) c.tick(t);
        expect(sink.turretYaw(OWNER)).toBeCloseTo(Math.PI / 2, 3);
    });

    it('each slot disengages independently after its own 4 s of silence', () => {
        const { deps } = makeDeps({ pieces: GUN_CAR_PIECES, weaponDefIds: WEAPON_DEF_IDS });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired({ ownerId: OWNER, targetId: 1, targetPos: { x: 1000, y: 0, z: 0 }, weaponDefId: HOWITZER, pos: { x: 0, y: 3, z: 4 } }, 0);
        for (let t = 0; t <= 2000; t += 100) c.tick(t);
        // Slot 2 fires only now, well after slot 1's engagement started.
        c.onFired({ ownerId: OWNER, targetId: 2, targetPos: { x: -1000, y: 0, z: 0 }, weaponDefId: HOWITZER, pos: { x: 0, y: 3, z: -4 } }, 2000);
        expect(c.engagedSlots(OWNER)).toEqual([1, 2]);
        // Advance until slot 1 (last fired at 0) has been silent 4s+, but
        // slot 2 (last fired at 2000) has not yet.
        for (let t = 2100; t <= DISENGAGE_MS + 100; t += 100) c.tick(t);
        expect(c.stateOf(OWNER, 1)?.releasing).toBe(true);
        expect(c.stateOf(OWNER, 2)?.releasing).toBe(false);
        expect(c.engagedSlots(OWNER)).toContain(2);
    });
});
