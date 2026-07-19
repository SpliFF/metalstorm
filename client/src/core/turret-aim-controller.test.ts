import { describe, it, expect } from 'vitest';
import {
    TurretAimController,
    slewAngle,
    DEFAULT_SLEW_DEG_PER_SEC,
    DISENGAGE_MS,
    type TurretAimDeps,
    type AimPoseSink,
    type AimPiecePose,
    type UnitAimPieces,
    type AimVec,
} from './turret-aim-controller.js';

const DEG2RAD = Math.PI / 180;
const RATE = DEFAULT_SLEW_DEG_PER_SEC * DEG2RAD; // rad/s

/** Recording sink: last pose pushed per unit (null once cleared). */
class FakeSink implements AimPoseSink {
    poses = new Map<number, ReadonlyMap<number, AimPiecePose> | null>();
    known = new Set<number>();
    setAimPose(id: number, pose: ReadonlyMap<number, AimPiecePose> | null): boolean {
        if (pose !== null && !this.known.has(id)) { this.poses.delete(id); return false; }
        this.poses.set(id, pose);
        return true;
    }
    turretYaw(id: number): number | null {
        const p = this.poses.get(id);
        if (!p) return null;
        // turret is the piece with rx===0 (barrel carries pitch, ry 0).
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
}

function makeDeps(cfg: Cfg): { deps: TurretAimDeps; cfg: Cfg } {
    // `in` checks, not `??`, so an explicit `pieces: null` (no-turret model)
    // is honoured rather than replaced by the default.
    const state: Cfg = {
        unit: 'unit' in cfg ? cfg.unit : { x: 0, y: 0, z: 0, heading: 0 },
        target: 'target' in cfg ? cfg.target : null,
        pieces: 'pieces' in cfg ? cfg.pieces : { turret: { idx: 1, px: 0, py: 10, pz: 0 } },
        simDriven: cfg.simDriven ?? false,
        rate: cfg.rate,
    };
    const deps: TurretAimDeps = {
        unitPose: () => state.unit ?? null,
        targetPos: () => state.target ?? null,
        aimPieces: () => state.pieces ?? null,
        simDrivesPieces: () => state.simDriven ?? false,
        slewRateDegPerSec: () => state.rate,
    };
    return { deps, cfg: state };
}

const OWNER = 42;
const TARGET = 7;
/** Standard fired event: shot from OWNER at entity TARGET, frozen fallback. */
const fired = (targetPos: AimVec = { x: 100, y: 0, z: 0 }) => ({
    ownerId: OWNER, targetId: TARGET, targetPos,
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

describe('TurretAimController — slew clamp', () => {
    it('never turns faster than the rate cap in one tick', () => {
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 } });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        c.tick(0);            // prime: dt = 0, yaw stays 0
        expect(sink.turretYaw(OWNER)).toBeCloseTo(0, 6);
        c.tick(100);          // dt = 100 ms → exactly one rate step
        expect(sink.turretYaw(OWNER)).toBeCloseTo(RATE * 0.1, 5);
        const afterOne = sink.turretYaw(OWNER)!;
        c.tick(200);
        // Second step advances by the same clamped amount, not to target.
        expect(sink.turretYaw(OWNER)! - afterOne).toBeCloseTo(RATE * 0.1, 5);
    });

    it('honours a per-unit slew-rate override', () => {
        const { deps } = makeDeps({ target: { x: 100, y: 0, z: 0 }, rate: 60 });
        const sink = new FakeSink();
        sink.known.add(OWNER);
        const c = new TurretAimController(deps, sink);
        c.onFired(fired(), 0);
        c.tick(0);
        c.tick(100);
        expect(sink.turretYaw(OWNER)).toBeCloseTo(60 * DEG2RAD * 0.1, 5);
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
            turret: { idx: 1, px: 0, py: 10, pz: 0 },
            barrel: { idx: 2, px: 0, py: 0, pz: 5 },
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
