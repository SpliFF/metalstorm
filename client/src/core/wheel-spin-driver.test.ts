/**
 * Wheel-spin driver tests (PLAN-metalstorm-model-integration §M1): the
 * movement→axle-spin bridge, driven by synthetic WIRE entity-state streams.
 *
 * Same cadence as clip-auto-policy.test.ts and for the same reason: the
 * server's delta cache omits a unit whose position moved less than
 * POS_THRESHOLD, so a stopped unit goes SILENT rather than reporting zero
 * speed. Wheels have to notice that and stop.
 */

import { describe, expect, it } from 'vitest';
import {
    WheelSpinDriver,
    matchWheelPieces,
    wheelRadiusFor,
    WHEEL_SPIN_TUNING,
    type WheelSpinDeps,
    type WheelPoseSink,
    type WheelPiecePose,
    type WheelSpinSnapshot,
} from './wheel-spin-driver.js';

const { SIM_HZ, MAX_SPIN_RAD_PER_SEC } = WHEEL_SPIN_TUNING;
const LOS_INLOS = 1 << 0;

// ── Fixtures ─────────────────────────────────────────────────────────────

interface Unit { x: number; z: number; los?: number }

function snapshot(baseFrame: number, units: Map<number, Unit>): WheelSpinSnapshot {
    const ids = [...units.keys()];
    return {
        baseFrame,
        count: ids.length,
        entityIds: Uint32Array.from(ids),
        positionsX: Float32Array.from(ids.map((i) => units.get(i)!.x)),
        positionsZ: Float32Array.from(ids.map((i) => units.get(i)!.z)),
        losStates: Uint8Array.from(ids.map((i) => units.get(i)!.los ?? LOS_INLOS)),
    };
}

/** Records the last pose pushed per unit, like the aim controller's FakeSink. */
class FakeSink implements WheelPoseSink {
    poses = new Map<number, ReadonlyMap<number, WheelPiecePose> | null>();
    /** Units the renderer still knows — setWheelPose returns false otherwise. */
    known = new Set<number>([1, 2, 3]);
    calls = 0;
    setWheelPose(id: number, pose: ReadonlyMap<number, WheelPiecePose> | null): boolean {
        this.calls++;
        if (pose !== null && !this.known.has(id)) return false;
        this.poses.set(id, pose);
        return true;
    }
    /** Roll angle of the first posed piece, or null if nothing is posed. */
    rollOf(id: number): number | null {
        const p = this.poses.get(id);
        if (!p) return null;
        for (const pose of p.values()) return pose.rx;
        return null;
    }
    piecesOf(id: number): number[] {
        return [...(this.poses.get(id)?.keys() ?? [])];
    }
}

interface RigOpts {
    pieces?: number[] | null;
    topSpeed?: number;
    wheelRadius?: number;
    simDriven?: boolean;
    excluded?: boolean;
}

function makeRig(opts: RigOpts = {}) {
    const state = {
        pieces: 'pieces' in opts ? opts.pieces : [4, 5],
        topSpeed: opts.topSpeed ?? MAX_SPIN_RAD_PER_SEC, // → reference radius 1
        wheelRadius: opts.wheelRadius,
        simDriven: opts.simDriven ?? false,
        excluded: opts.excluded ?? false,
    };
    const probes: number[] = [];
    const sink = new FakeSink();
    const deps: WheelSpinDeps = {
        wheelPieces: (id) => { probes.push(id); return state.pieces ?? null; },
        topSpeed: () => state.topSpeed,
        wheelRadius: () => state.wheelRadius,
        simDrivesPieces: () => state.simDriven,
        excluded: () => state.excluded,
    };
    return { driver: new WheelSpinDriver(deps, sink), sink, state, probes };
}

/** Drive a unit at a constant planar speed (elmos/s), a delta every 3 frames
 *  like the server, ticking the render loop between wire samples. */
function drive(
    driver: WheelSpinDriver,
    id: number,
    speed: number,
    seconds: number,
    start: { frame: number; x: number },
): { frame: number; x: number } {
    let { frame, x } = start;
    const steps = Math.round((seconds * SIM_HZ) / 3);
    for (let i = 0; i < steps; i++) {
        frame += 3;
        x += (speed * 3) / SIM_HZ;
        driver.observe(snapshot(frame, new Map([[id, { x, z: 0 }]])), true);
        driver.tick((3 / SIM_HZ) * 1000);
    }
    return { frame, x };
}

// ── Piece matching ───────────────────────────────────────────────────────

describe('matchWheelPieces', () => {
    it('matches the forge axle/wheel convention', () => {
        const pieces = [
            { name: 'body' }, { name: 'axle_f' }, { name: 'axle_m' },
            { name: 'axle_r' }, { name: 'wheel1' }, { name: 'wheel2' },
        ];
        expect(matchWheelPieces(pieces)).toEqual([1, 2, 3, 4, 5]);
    });

    it('leaves train axles (axle1..axleN) to TrainPresentation', () => {
        const pieces = [{ name: 'body' }, { name: 'axle1' }, { name: 'axle2' }];
        expect(matchWheelPieces(pieces)).toEqual([]);
    });

    it('does not match turret chains, tracks or mission modules', () => {
        const pieces = [
            { name: 'body' }, { name: 'turret' }, { name: 'barrel' },
            { name: 'tracks_l' }, { name: 'tracks_r' }, { name: 'mod_mast' },
            { name: 'wheelhouse' },
        ];
        expect(matchWheelPieces(pieces)).toEqual([]);
    });
});

// ── Spin ─────────────────────────────────────────────────────────────────

describe('WheelSpinDriver', () => {
    it('spins the model axle pieces while the unit moves', () => {
        const { driver, sink } = makeRig();
        drive(driver, 1, 6, 0.3, { frame: 0, x: 0 });
        expect(sink.piecesOf(1)).toEqual([4, 5]);
        const roll = sink.rollOf(1);
        expect(roll).not.toBeNull();
        expect(Math.abs(roll!)).toBeGreaterThan(0);
        // Both axles share one phase — they are the same wheel.
        const poses = [...sink.poses.get(1)!.values()];
        expect(poses[0].rx).toBe(poses[1].rx);
        // Roll only: no translation off the rest pose, no yaw/pitch.
        expect(poses[0]).toMatchObject({ px: 0, py: 0, pz: 0, ry: 0, rz: 0 });
    });

    it('spins proportionally to speed, and faster is faster', () => {
        const slow = makeRig();
        const fast = makeRig();
        // One tick each so the phase is a single integration step.
        slow.driver.observe(snapshot(0, new Map([[1, { x: 0, z: 0 }]])), true);
        fast.driver.observe(snapshot(0, new Map([[1, { x: 0, z: 0 }]])), true);
        slow.driver.observe(snapshot(3, new Map([[1, { x: 0.3, z: 0 }]])), true);
        fast.driver.observe(snapshot(3, new Map([[1, { x: 0.6, z: 0 }]])), true);
        slow.driver.tick(100);
        fast.driver.tick(100);
        expect(fast.sink.rollOf(1)!).toBeCloseTo(2 * slow.sink.rollOf(1)!, 6);
    });

    it('clamps the spin rate so an n-gon wheel cannot alias backwards', () => {
        // topSpeed → reference radius 1, so 10x top speed would be 10x MAX.
        const { driver, sink } = makeRig({ topSpeed: MAX_SPIN_RAD_PER_SEC });
        driver.observe(snapshot(0, new Map([[1, { x: 0, z: 0 }]])), true);
        driver.observe(snapshot(3, new Map([[1, { x: 100, z: 0 }]])), true);
        driver.tick(100);   // 0.1 s
        expect(sink.rollOf(1)!).toBeCloseTo(MAX_SPIN_RAD_PER_SEC * 0.1, 6);
    });

    it('honours an explicit customparams.wheel_radius', () => {
        // radius 2 halves the rate the speed-derived radius 1 would give.
        const derived = makeRig({ topSpeed: MAX_SPIN_RAD_PER_SEC });
        const explicit = makeRig({ topSpeed: MAX_SPIN_RAD_PER_SEC, wheelRadius: 2 });
        for (const rig of [derived, explicit]) {
            rig.driver.observe(snapshot(0, new Map([[1, { x: 0, z: 0 }]])), true);
            rig.driver.observe(snapshot(3, new Map([[1, { x: 0.3, z: 0 }]])), true);
            rig.driver.tick(100);
        }
        expect(explicit.sink.rollOf(1)!).toBeCloseTo(derived.sink.rollOf(1)! / 2, 6);
    });

    it('holds the phase when the unit stops reporting (server deadband)', () => {
        const { driver, sink } = makeRig();
        const at = drive(driver, 1, 6, 0.5, { frame: 0, x: 0 });
        const stopped = sink.rollOf(1)!;
        // Silent for a second — only the 1 Hz full snapshot mentions it, at
        // the same position — then several render frames.
        driver.observe(snapshot(at.frame + 30, new Map([[1, { x: at.x, z: 0 }]])), false);
        for (let i = 0; i < 10; i++) driver.tick(16);
        expect(sink.rollOf(1)!).toBe(stopped);
    });

    it('resumes from the held phase when the unit moves again', () => {
        const { driver, sink } = makeRig();
        const at = drive(driver, 1, 6, 0.5, { frame: 0, x: 0 });
        const held = sink.rollOf(1)!;
        driver.observe(snapshot(at.frame + 30, new Map([[1, { x: at.x, z: 0 }]])), false);
        driver.tick(16);
        drive(driver, 1, 6, 0.2, { frame: at.frame + 30, x: at.x });
        expect(sink.rollOf(1)!).not.toBe(held);
    });

    it('declines a unit whose pieces the sim drives, clearing its pose once', () => {
        const rig = makeRig();
        drive(rig.driver, 1, 6, 0.3, { frame: 0, x: 0 });
        expect(rig.sink.poses.get(1)).toBeTruthy();
        rig.state.simDriven = true;
        const before = rig.sink.calls;
        rig.driver.tick(16);
        expect(rig.sink.poses.get(1)).toBeNull();
        expect(rig.sink.calls).toBe(before + 1);
        rig.driver.tick(16);                       // and not again
        expect(rig.sink.calls).toBe(before + 1);
    });

    it('declines train cars — TrainPresentation owns that pose channel', () => {
        const { driver, sink } = makeRig({ excluded: true });
        drive(driver, 1, 6, 0.5, { frame: 0, x: 0 });
        expect(sink.poses.get(1)).toBeUndefined();
    });

    it('retires a model that carries no wheel pieces, but keeps probing one that is still loading', () => {
        const loading = makeRig({ pieces: null });
        drive(loading.driver, 1, 6, 0.3, { frame: 0, x: 0 });
        expect(loading.sink.poses.get(1)).toBeUndefined();
        const probesWhileLoading = loading.probes.length;
        expect(probesWhileLoading).toBeGreaterThan(1);      // retried
        // The model resolves with wheels — the same unit engages.
        loading.state.pieces = [2];
        loading.driver.tick(16);
        expect(loading.sink.piecesOf(1)).toEqual([2]);

        const wheelless = makeRig({ pieces: [] });
        drive(wheelless.driver, 1, 6, 0.3, { frame: 0, x: 0 });
        expect(wheelless.sink.poses.get(1)).toBeUndefined();
        expect(wheelless.probes.length).toBe(1);            // retired after one probe
        expect(wheelless.driver.stats().ineligible).toBe(1);
    });

    it('ignores radar-only contacts (deceived positions would fake movement)', () => {
        const { driver, sink } = makeRig();
        let frame = 0;
        let x = 0;
        for (let i = 0; i < 10; i++) {
            frame += 3;
            x += 2;
            driver.observe(snapshot(frame, new Map([[1, { x, z: 0, los: 0 }]])), true);
            driver.tick(100);
        }
        expect(sink.poses.get(1)).toBeUndefined();
    });

    it('drops a unit the renderer no longer knows', () => {
        const { driver, sink } = makeRig();
        drive(driver, 1, 6, 0.3, { frame: 0, x: 0 });
        expect(driver.stats().tracked).toBe(1);
        sink.known.delete(1);        // died between the wire sample and this frame
        driver.tick(16);
        expect(driver.stats().tracked).toBe(0);
    });

    it('prunes units missing from a full snapshot, and remove() drops one', () => {
        const { driver } = makeRig();
        driver.observe(snapshot(0, new Map([[1, { x: 0, z: 0 }], [2, { x: 5, z: 0 }]])), true);
        expect(driver.stats().tracked).toBe(2);
        driver.observe(snapshot(3, new Map([[1, { x: 1, z: 0 }]])), false);
        expect(driver.stats().tracked).toBe(1);
        driver.remove(1);
        expect(driver.stats().tracked).toBe(0);
    });

    it('ignores duplicate / out-of-order packets', () => {
        const { driver, sink } = makeRig();
        driver.observe(snapshot(6, new Map([[1, { x: 0, z: 0 }]])), true);
        driver.observe(snapshot(9, new Map([[1, { x: 1, z: 0 }]])), true);
        driver.tick(100);
        const roll = sink.rollOf(1)!;
        driver.observe(snapshot(3, new Map([[1, { x: 99, z: 0 }]])), true);  // stale
        driver.tick(0);
        expect(sink.rollOf(1)!).toBe(roll);
    });
});

describe('wheelRadiusFor', () => {
    it('reads a usable customparam and rejects everything else', () => {
        expect(wheelRadiusFor({ customParams: { wheel_radius: '2.5' } })).toBe(2.5);
        expect(wheelRadiusFor({ customParams: { wheel_radius: '0' } })).toBeUndefined();
        expect(wheelRadiusFor({ customParams: { wheel_radius: 'wide' } })).toBeUndefined();
        expect(wheelRadiusFor({ customParams: {} })).toBeUndefined();
        expect(wheelRadiusFor(undefined)).toBeUndefined();
    });
});
