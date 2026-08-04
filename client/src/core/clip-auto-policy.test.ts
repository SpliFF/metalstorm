/**
 * Clip auto-policy tests (DESIGN-MODEL-BUILDING.md §16b task 4): the
 * movement→walk/idle bridge, driven by synthetic WIRE entity-state streams.
 *
 * The streams here mimic the real server cadence (StateStreamer.cpp): a
 * delta every 3 sim frames, a full snapshot every 30. That cadence is
 * load-bearing for the stop path — the server's delta cache omits units
 * whose position moved less than POS_THRESHOLD, so a stopped unit goes
 * SILENT rather than reporting zero speed, and only the 1 Hz full snapshot
 * (or the staleness bound) settles it.
 */

import { describe, expect, it } from 'vitest';
import { Matrix } from '@babylonjs/core';
import {
    ClipAutoPolicy,
    CLIP_AUTO_TUNING,
    nominalSpeedFor,
    type ClipAutoPolicyDeps,
    type ClipPlaybackSink,
    type ResolvedClip,
} from './clip-auto-policy.js';
import type { ModelClip } from './clip-player.js';
import {
    FIELD_ENTITY_IDS, FIELD_POSITION_X, FIELD_POSITION_Y, FIELD_POSITION_Z,
    FIELD_LOS_STATE,
    type EntityStateSnapshot,
} from './entity-state.js';

const { SIM_HZ, START_SPEED, STOP_HOLD_SEC } = CLIP_AUTO_TUNING;
const LOS_INLOS = 1 << 0;

// ── Fixtures ─────────────────────────────────────────────────────────────

function clip(name: string): ModelClip {
    return { name, from: 0, to: 30, fps: 60, channels: [{ pieceIdx: 0 }] };
}

const WALK: ResolvedClip = { clip: clip('walk'), restLocals: [Matrix.Identity()] };
const IDLE: ResolvedClip = { clip: clip('idle'), restLocals: [Matrix.Identity()] };

interface Unit { x: number; z: number; los?: number }

/** Build a wire snapshot the way the parser would hand it over. */
function snapshot(baseFrame: number, units: Map<number, Unit>): EntityStateSnapshot {
    const ids = [...units.keys()];
    return {
        baseFrame,
        count: ids.length,
        fieldMask: FIELD_ENTITY_IDS | FIELD_POSITION_X | FIELD_POSITION_Y
            | FIELD_POSITION_Z | FIELD_LOS_STATE,
        entityIds: Uint32Array.from(ids),
        positionsX: Float32Array.from(ids.map((i) => units.get(i)!.x)),
        positionsY: Float32Array.from(ids.map(() => 0)),
        positionsZ: Float32Array.from(ids.map((i) => units.get(i)!.z)),
        headings: null,
        health: null,
        defIds: null,
        teams: null,
        stateBits: null,
        losStates: Uint8Array.from(ids.map((i) => units.get(i)!.los ?? LOS_INLOS)),
        buildProgress: null,
        pitch: null,
        roll: null,
    };
}

/** Records what the policy asked the ClipPlayer to do. */
function makePlayer(): ClipPlaybackSink & {
    log: string[];
    playing: Map<number, string>;
    speeds: Map<number, number>;
} {
    const playing = new Map<number, string>();
    const speeds = new Map<number, number>();
    const log: string[] = [];
    return {
        log, playing, speeds,
        play(unitId, c, _rest, opts) {
            playing.set(unitId, c.name);
            speeds.set(unitId, opts?.speed ?? 1);
            log.push(`play ${unitId} ${c.name}`);
        },
        stop(unitId) {
            if (unitId === undefined) { playing.clear(); log.push('stop *'); return; }
            playing.delete(unitId);
            log.push(`stop ${unitId}`);
        },
        setSpeed(unitId, speed) { speeds.set(unitId, speed); },
        playingClip: (unitId) => playing.get(unitId) ?? null,
    };
}

interface RigOpts {
    clips?: Partial<Record<'walk' | 'idle', ResolvedClip>>;
    nominal?: number;
    maxAuto?: number;
    cameraXZ?: () => { x: number; z: number } | null;
    /** false = model still streaming, so a missing clip means "not yet". */
    clipsLoaded?: () => boolean;
}

function makeRig(opts: RigOpts = {}) {
    const clips = opts.clips ?? { walk: WALK, idle: IDLE };
    const probes: string[] = [];
    const player = makePlayer();
    const deps: ClipAutoPolicyDeps = {
        getClip: (id, name) => {
            probes.push(`${id}:${name}`);
            return clips[name as 'walk' | 'idle'] ?? null;
        },
        nominalSpeed: () => opts.nominal ?? 10,
        clipsLoaded: opts.clipsLoaded ?? (() => true),
        cameraXZ: opts.cameraXZ,
    };
    const policy = new ClipAutoPolicy(deps, player, opts.maxAuto);
    return { policy, player, probes };
}

/**
 * Drive a unit at a constant planar speed (elmos/s) for `seconds`, emitting
 * a delta every 3 frames like the server does. Returns the end frame/x.
 */
function drive(
    policy: ClipAutoPolicy,
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
        policy.observe(snapshot(frame, new Map([[id, { x, z: 0 }]])), true);
    }
    return { frame, x };
}

/** Go silent, as a stopped unit does (its position no longer clears the
 *  server's delta deadband), emitting only the 1 Hz full snapshots. */
function idleSilently(
    policy: ClipAutoPolicy,
    id: number,
    seconds: number,
    at: { frame: number; x: number },
): { frame: number; x: number } {
    let frame = at.frame;
    const end = frame + seconds * SIM_HZ;
    while (frame < end) {
        frame += 30;
        policy.observe(snapshot(frame, new Map([[id, { x: at.x, z: 0 }]])), false);
    }
    return { frame, x: at.x };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('nominalSpeedFor', () => {
    it('prefers an explicit walk_speed_ref customparam', () => {
        expect(nominalSpeedFor({ speed: 78, customParams: { walk_speed_ref: '12.5' } }))
            .toBe(12.5);
    });

    it('falls back to the def top speed, then to 0 (unknown)', () => {
        expect(nominalSpeedFor({ speed: 78, customParams: {} })).toBe(78);
        expect(nominalSpeedFor({ speed: 78 })).toBe(78);
        expect(nominalSpeedFor({ speed: 0 })).toBe(0);
        expect(nominalSpeedFor(undefined)).toBe(0);
    });

    it('ignores a non-numeric or non-positive walk_speed_ref', () => {
        expect(nominalSpeedFor({ speed: 78, customParams: { walk_speed_ref: 'fast' } }))
            .toBe(78);
        expect(nominalSpeedFor({ speed: 78, customParams: { walk_speed_ref: '0' } }))
            .toBe(78);
    });
});

describe('ClipAutoPolicy — start/stop hysteresis', () => {
    it('starts walking once movement is sustained, not on the first sample', () => {
        const { policy, player } = makeRig();
        // Two samples are needed just to derive a speed, then START_TICKS
        // evaluations above the threshold.
        policy.observe(snapshot(0, new Map([[1, { x: 0, z: 0 }]])), true);
        expect(player.playingClip(1)).toBeNull();
        policy.observe(snapshot(3, new Map([[1, { x: 1, z: 0 }]])), true);
        expect(player.playingClip(1)).toBeNull();   // 1 tick above → not yet
        policy.observe(snapshot(6, new Map([[1, { x: 2, z: 0 }]])), true);
        expect(player.playingClip(1)).toBe('walk');
    });

    it('does not start on a crawl below the start threshold', () => {
        const { policy, player } = makeRig();
        // 0.3 elmos/s — under START_SPEED (0.5), sustained for 3 s.
        drive(policy, 1, 0.3, 3, { frame: 0, x: 0 });
        expect(player.playingClip(1)).toBeNull();
    });

    it('a stationary unit never animates (absence is not movement)', () => {
        const { policy, player } = makeRig();
        idleSilently(policy, 1, 5, { frame: 0, x: 100 });
        expect(player.log).toEqual([]);
    });

    it('settles to idle after the unit stops and goes silent', () => {
        const { policy, player } = makeRig();
        const end = drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        expect(player.playingClip(1)).toBe('walk');

        // A stopped unit stops appearing in deltas; the 1 Hz full snapshot
        // reports it unmoved, which is what drops it out of walk.
        idleSilently(policy, 1, 2, end);
        expect(player.playingClip(1)).toBe('idle');
        expect(policy.stats()).toMatchObject({ walking: 0, idle: 1 });
    });

    it('holds the walk through a brief dip rather than flickering to idle', () => {
        const { policy, player } = makeRig();
        let at = drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        expect(player.playingClip(1)).toBe('walk');

        // Go quiet for less than STOP_HOLD_SEC, then move again.
        at = { frame: at.frame + Math.floor(STOP_HOLD_SEC * SIM_HZ) - 3, x: at.x };
        policy.observe(snapshot(at.frame, new Map([[1, { x: at.x, z: 0 }]])), true);
        expect(player.playingClip(1)).toBe('walk');

        drive(policy, 1, 20, 1, at);
        expect(player.playingClip(1)).toBe('walk');
        expect(player.log.filter((l) => l.includes('idle'))).toEqual([]);
    });

    it('falls back to the rest pose when the model ships no idle clip', () => {
        const { policy, player } = makeRig({ clips: { walk: WALK } });
        const end = drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        expect(player.playingClip(1)).toBe('walk');
        idleSilently(policy, 1, 2, end);
        expect(player.playingClip(1)).toBeNull();
        expect(player.log).toContain('stop 1');
    });

    it('decays a walker toward rest when full snapshots stop arriving', () => {
        // Deltas alone can never say "stopped" — the staleness bound
        // (POS_DEADBAND / elapsed) has to carry it. 3 s of pure silence puts
        // the bound at 0.5/3 = 0.17 elmos/s, under STOP_SPEED.
        const { policy, player } = makeRig();
        const end = drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        expect(player.playingClip(1)).toBe('walk');
        // Other units keep the wire clock advancing; unit 1 says nothing.
        for (let f = end.frame + 3; f <= end.frame + 3 * SIM_HZ; f += 3) {
            policy.observe(snapshot(f, new Map([[2, { x: f, z: 0 }]])), true);
        }
        expect(player.playingClip(1)).toBe('idle');
    });
});

describe('ClipAutoPolicy — playback speed scaling', () => {
    it('scales playback by unitSpeed / nominal', () => {
        const { policy, player } = makeRig({ nominal: 20 });
        drive(policy, 1, 20, 2, { frame: 0, x: 0 });   // at nominal → 1.0
        expect(player.speeds.get(1)).toBeCloseTo(1, 3);

        const { policy: p2, player: pl2 } = makeRig({ nominal: 20 });
        drive(p2, 1, 24, 2, { frame: 0, x: 0 });       // 1.2× nominal
        expect(pl2.speeds.get(1)).toBeCloseTo(1.2, 3);
    });

    it('clamps the rate to [0.6, 1.6] at the extremes', () => {
        // Far below nominal: a crawl must not play in extreme slow motion.
        const { policy, player } = makeRig({ nominal: 100 });
        drive(policy, 1, 5, 2, { frame: 0, x: 0 });
        expect(player.speeds.get(1)).toBe(CLIP_AUTO_TUNING.SPEED_MIN);

        // Far above nominal: the cycle must not become a blur.
        const { policy: p2, player: pl2 } = makeRig({ nominal: 2 });
        drive(p2, 1, 60, 2, { frame: 0, x: 0 });
        expect(pl2.speeds.get(1)).toBe(CLIP_AUTO_TUNING.SPEED_MAX);
    });

    it('tracks a speed change through setSpeed, without replaying the clip', () => {
        const { policy, player } = makeRig({ nominal: 20 });
        const at = drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        expect(player.speeds.get(1)).toBeCloseTo(1, 3);
        const playsBefore = player.log.filter((l) => l.startsWith('play')).length;

        drive(policy, 1, 12, 2, at);   // slow down → 0.6
        expect(player.speeds.get(1)).toBeCloseTo(0.6, 3);
        // Re-play would restart the cycle every snapshot — the whole reason
        // ClipPlayer.setSpeed is phase-preserving.
        expect(player.log.filter((l) => l.startsWith('play')).length).toBe(playsBefore);
    });

    it('uses the fallback nominal when the def reports no usable speed', () => {
        const { policy, player } = makeRig({ nominal: 0 });
        drive(policy, 1, 30, 2, { frame: 0, x: 0 });   // 30 / fallback 30 → 1.0
        expect(player.speeds.get(1)).toBeCloseTo(1, 3);
    });
});

describe('ClipAutoPolicy — manual override', () => {
    it('skips a unit the harness has taken over, and resumes on release', () => {
        const { policy, player } = makeRig();
        policy.markManual(1);
        player.play(1, clip('death'), [], { loop: false });
        player.log.length = 0;

        const at = drive(policy, 1, 20, 3, { frame: 0, x: 0 });
        expect(player.log).toEqual([]);            // policy never touched it
        expect(player.playingClip(1)).toBe('death');

        policy.clearManual();                       // no-arg stopClip
        drive(policy, 1, 20, 1, at);
        expect(player.playingClip(1)).toBe('walk');
    });

    it('clearManual(id) releases only that unit', () => {
        const { policy, player } = makeRig();
        policy.markManual(1);
        policy.markManual(2);
        policy.clearManual(2);

        let at1 = { frame: 0, x: 0 };
        let at2 = { frame: 0, x: 0 };
        for (let i = 0; i < 20; i++) {
            at1 = { frame: at1.frame + 3, x: at1.x + 2 };
            at2 = { frame: at2.frame + 3, x: at2.x + 2 };
            policy.observe(snapshot(at1.frame, new Map([
                [1, { x: at1.x, z: 0 }],
                [2, { x: at2.x, z: 0 }],
            ])), true);
        }
        expect(player.playingClip(1)).toBeNull();
        expect(player.playingClip(2)).toBe('walk');
    });
});

describe('ClipAutoPolicy — clipless units and other games', () => {
    it('never animates a unit whose model has no walk clip (wz_*, ZK, BAR)', () => {
        const { policy, player } = makeRig({ clips: {} });
        drive(policy, 1, 40, 4, { frame: 0, x: 0 });
        expect(player.log).toEqual([]);
        expect(policy.stats()).toMatchObject({ walking: 0, idle: 0 });
    });

    it('retires a clipless unit after ONE probe instead of re-probing forever', () => {
        // The ZK/BAR case: hundreds of movers, none of which can ever animate.
        const { policy, probes } = makeRig({ clips: {} });
        drive(policy, 1, 40, 6, { frame: 0, x: 0 });
        expect(probes).toEqual(['1:walk']);
        expect(policy.stats()).toMatchObject({ ineligible: 1 });
    });

    it('keeps probing while the model is still streaming, then engages', () => {
        // A missing clip during load must NOT retire the unit for the match.
        let loaded = false;
        const clips: Partial<Record<'walk' | 'idle', ResolvedClip>> = {};
        const player = makePlayer();
        const policy = new ClipAutoPolicy({
            getClip: (_id, name) => clips[name as 'walk' | 'idle'] ?? null,
            nominalSpeed: () => 20,
            clipsLoaded: () => loaded,
        }, player);

        let at = drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        expect(player.playingClip(1)).toBeNull();
        expect(policy.stats()).toMatchObject({ ineligible: 0 });   // not retired

        clips.walk = WALK;                 // model finishes loading
        loaded = true;
        at = drive(policy, 1, 20, 1, at);
        expect(player.playingClip(1)).toBe('walk');
    });

    it('ignores radar-only contacts (their streamed position is deceived)', () => {
        const { policy, player } = makeRig();
        const LOS_INRADAR = 1 << 1;
        for (let f = 0, x = 0; f < 60; f += 3, x += 2) {
            policy.observe(snapshot(f, new Map([[1, { x, z: 0, los: LOS_INRADAR }]])), true);
        }
        expect(player.log).toEqual([]);
    });
});

describe('ClipAutoPolicy — bookkeeping and the concurrency cap', () => {
    it('caps concurrent auto playbacks, preferring units nearest the camera', () => {
        const { policy, player } = makeRig({
            maxAuto: 2,
            cameraXZ: () => ({ x: 0, z: 0 }),
        });
        // Units 1..4 all march; 4 is nearest the camera, 1 is furthest.
        const pos = new Map([[1, 400], [2, 300], [3, 200], [4, 100]]);
        for (let f = 0; f <= 9; f += 3) {
            const units = new Map(
                [...pos].map(([id, x]) => [id, { x: x + (f / 3) * 2, z: 0 }]));
            policy.observe(snapshot(f, units), true);
        }
        expect(policy.stats().walking).toBe(2);
        expect(player.playingClip(4)).toBe('walk');
        expect(player.playingClip(3)).toBe('walk');
        expect(player.playingClip(1)).toBeNull();
        expect(player.playingClip(2)).toBeNull();
    });

    it('walk→idle reuses the slot rather than consuming a second one', () => {
        const { policy } = makeRig({ maxAuto: 1 });
        const end = drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        expect(policy.stats()).toMatchObject({ walking: 1, idle: 0 });
        idleSilently(policy, 1, 2, end);
        expect(policy.stats()).toMatchObject({ walking: 0, idle: 1 });
    });

    it('a full snapshot prunes units that are gone', () => {
        const { policy } = makeRig();
        drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        expect(policy.stats().tracked).toBe(1);
        policy.observe(snapshot(300, new Map([[9, { x: 0, z: 0 }]])), false);
        expect(policy.stats().tracked).toBe(1);      // only unit 9 survives
        expect(policy.stats().walking).toBe(0);
    });

    it('remove() and reset() drop bookkeeping', () => {
        const { policy } = makeRig();
        drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        policy.markManual(1);
        policy.remove(1);
        expect(policy.stats()).toMatchObject({ tracked: 0, manual: 0 });

        drive(policy, 2, 20, 2, { frame: 0, x: 0 });
        policy.reset();
        expect(policy.stats()).toMatchObject({ tracked: 0, walking: 0 });
    });

    it('releases its slot when the player drops a playback underneath it', () => {
        const { policy, player } = makeRig();
        const at = drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        expect(policy.stats().walking).toBe(1);
        // What ClipPlayer's auto-stop does when the unit disappears.
        player.playing.delete(1);
        drive(policy, 1, 20, 1, at);
        // Reconciled, then restarted from scratch — not left claiming a slot.
        expect(policy.stats().walking).toBe(1);
        expect(player.playingClip(1)).toBe('walk');
    });

    it('ignores out-of-order and duplicate packets', () => {
        const { policy, player } = makeRig();
        policy.observe(snapshot(30, new Map([[1, { x: 100, z: 0 }]])), true);
        policy.observe(snapshot(30, new Map([[1, { x: 100, z: 0 }]])), true);
        // A stale packet must not read as a huge backwards jump.
        policy.observe(snapshot(3, new Map([[1, { x: 0, z: 0 }]])), true);
        expect(player.log).toEqual([]);
        expect(policy.stats().tracked).toBe(1);
    });

    it('advances the clock on an entity-less snapshot', () => {
        // The stop hysteresis is measured against the wire clock, so an
        // empty delta still has to age it.
        const { policy, player } = makeRig();
        const end = drive(policy, 1, 20, 2, { frame: 0, x: 0 });
        expect(player.playingClip(1)).toBe('walk');
        for (let f = end.frame + 3; f <= end.frame + 3 * SIM_HZ; f += 3) {
            policy.observe(snapshot(f, new Map()), true);
        }
        expect(player.playingClip(1)).toBe('idle');
    });

    it('starts on diagonal movement (planar speed, not axis-aligned)', () => {
        const { policy, player } = makeRig({ nominal: 10 });
        // 3-4-5: 6 elmos/s on x and 8 on z → 10 elmos/s planar → rate 1.0.
        for (let f = 0, i = 0; f <= 12; f += 3, i++) {
            policy.observe(snapshot(f, new Map([
                [1, { x: 0.6 * i, z: 0.8 * i }],
            ])), true);
        }
        expect(player.playingClip(1)).toBe('walk');
        expect(player.speeds.get(1)).toBeCloseTo(1, 3);
    });

    it('exposes the tuning the spec fixes', () => {
        expect(START_SPEED).toBe(0.5);
        expect(CLIP_AUTO_TUNING.STOP_SPEED).toBe(0.2);
        expect(CLIP_AUTO_TUNING.START_TICKS).toBe(2);
        expect(STOP_HOLD_SEC).toBeCloseTo(0.3);
        expect(CLIP_AUTO_TUNING.MAX_AUTO_PLAYBACKS).toBe(64);
    });
});
