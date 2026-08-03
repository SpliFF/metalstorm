import { describe, expect, it } from 'vitest';
import {
    type Keyframe,
    KEYFRAME_BOUNCE,
    KEYFRAME_HEARTBEAT,
    KEYFRAME_LAUNCH,
    KEYFRAME_TERMINAL,
    ballisticAt,
    createKeyframeTrack,
    evalKeyframeTrack,
    keyframeResidual,
    pruneKeyframes,
    pushKeyframe,
} from './keyframe-flight.js';

const V = () => ({ x: NaN, y: NaN, z: NaN });

const knot = (
    frame: number, x: number, y: number, z: number,
    vx: number, vy: number, vz: number, kind = KEYFRAME_HEARTBEAT,
): Keyframe => ({ frame, x, y, z, vx, vy, vz, kind });

/** Evaluate a track at `frame`, returning fresh vectors. */
function at(track: Parameters<typeof evalKeyframeTrack>[0], frame: number) {
    const pos = V(), vel = V();
    evalKeyframeTrack(track, frame, pos, vel);
    return { pos, vel };
}

/**
 * The sim's own integration, ticked exactly as `CProjectile::Update` does it:
 * `speed += g` FIRST, then `pos += speed`. Everything below checks against
 * this rather than against a textbook `½gt²`, because the half-step between
 * the two is precisely the bias L2.2 measured as a 3.1× damage shortfall on
 * the server. If a form needs a correction term to agree with this, it is the
 * wrong form.
 */
function simWalk(k: Keyframe, g: number, steps: number) {
    let px = k.x, py = k.y, pz = k.z;
    let vx = k.vx, vy = k.vy, vz = k.vz;
    for (let i = 0; i < steps; i++) {
        vy += g;
        px += vx; py += vy; pz += vz;
    }
    return { x: px, y: py, z: pz, vy };
}

/// Map gravity on a typical map, per sim frame², negative pulling down —
/// `mapInfo->map.gravity` is `-130 / 30²`.
const G = -130 / (30 * 30);

describe('ballisticAt — the sim recurrence, not the textbook arc', () => {
    it('matches CProjectile::Update tick for tick', () => {
        const k = knot(100, 500, 200, -300, 4, 6, -2, KEYFRAME_LAUNCH);
        for (const steps of [1, 2, 7, 30, 91]) {
            const want = simWalk(k, G, steps);
            const pos = V(), vel = V();
            ballisticAt(k, steps, G, pos, vel);
            expect(pos.x).toBeCloseTo(want.x, 9);
            expect(pos.y).toBeCloseTo(want.y, 9);
            expect(pos.z).toBeCloseTo(want.z, 9);
            expect(vel.y).toBeCloseTo(want.vy, 9);
        }
    });

    it('differs from ½gt² by exactly the half-step, so the two are not swappable', () => {
        const k = knot(0, 0, 0, 0, 0, 0, 0, KEYFRAME_LAUNCH);
        const pos = V(), vel = V();
        const t = 60;
        ballisticAt(k, t, G, pos, vel);
        expect(pos.y).toBeCloseTo(0.5 * G * t * (t + 1), 9);
        // The naive form is off by half a frame of gravity per elapsed frame —
        // over a 2 s artillery flight that is metres, not float noise.
        expect(Math.abs(pos.y - 0.5 * G * t * t)).toBeGreaterThan(4);
    });
});

describe('the spline through an unguided flight IS that flight', () => {
    // Two knots sampled off a real ballistic walk, 40 frames apart. This is
    // the load-bearing claim of L3: between knots the client is not
    // approximating the sim's path, it is reproducing it, which is why the
    // server sends unguided shots no heartbeat at all.
    const launch = knot(200, 1000, 120, 400, 3.5, 5.5, -1.25, KEYFRAME_LAUNCH);
    const F = 40;
    const walked = simWalk(launch, G, F);
    const second = knot(200 + F, walked.x, walked.y, walked.z,
        launch.vx, walked.vy, launch.vz);

    it('agrees with the sim at every interior frame', () => {
        const track = createKeyframeTrack(launch, G);
        pushKeyframe(track, second);
        let worst = 0;
        for (let t = 0; t <= F; t++) {
            const want = simWalk(launch, G, t);
            const { pos } = at(track, launch.frame + t);
            worst = Math.max(worst,
                Math.hypot(pos.x - want.x, pos.y - want.y, pos.z - want.z));
        }
        // Sub-millimetre over 40 frames: this is float noise on numbers of
        // order 1e3, not a fitting error.
        expect(worst).toBeLessThan(1e-3);
    });

    it('agrees at fractional frames too — the cursor is not integral', () => {
        const track = createKeyframeTrack(launch, G);
        pushKeyframe(track, second);
        // A fractional cursor has no sim tick to compare against, so compare
        // the two descriptions of the same instant instead: the Hermite
        // segment and the closed-form continuation from the launch knot.
        for (const u of [0.25, 0.5, 7.75, 21.5, 39.5]) {
            const { pos } = at(track, launch.frame + u);
            const ref = V(), refVel = V();
            ballisticAt(launch, u, G, ref, refVel);
            expect(Math.hypot(pos.x - ref.x, pos.y - ref.y, pos.z - ref.z))
                .toBeLessThan(1e-3);
        }
    });

    it('continues past the last knot on the same arc, so no knot is required', () => {
        const bracketed = createKeyframeTrack(launch, G);
        pushKeyframe(bracketed, second);
        const bare = createKeyframeTrack(launch, G);
        for (const t of [10, 25, 39]) {
            const a = at(bracketed, launch.frame + t).pos;
            const b = at(bare, launch.frame + t).pos;
            expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(1e-3);
        }
    });

    it('adding an unguided knot moves the rendered path by nothing', () => {
        const track = createKeyframeTrack(launch, G);
        // The residual is what an arriving knot costs visually. For an
        // unguided shot the continuation it replaces was already exact, so
        // the correction L3 does not design away is, here, zero.
        expect(keyframeResidual(track, second, launch.frame + 30))
            .toBeLessThan(1e-3);
    });
});

describe('a guided flight — the one place a correction survives', () => {
    const launch = knot(0, 0, 100, 0, 5, 0, 0, KEYFRAME_LAUNCH);

    it('a steered knot does move the path, and the residual reports it', () => {
        const track = createKeyframeTrack(launch, 0);
        // 15 frames on (the heartbeat cadence), the missile has turned: it is
        // 30 elmos off the straight continuation.
        const steered = knot(15, 75, 100, 30, 4, 0, 3);
        const r = keyframeResidual(track, steered, 15);
        expect(r).toBeGreaterThan(1);
        // …and the track is untouched by the measurement.
        expect(track.knots).toHaveLength(1);
        expect(at(track, 15).pos.z).toBe(0);
    });

    it('the residual is zero at the knot the cursor has already passed', () => {
        const track = createKeyframeTrack(launch, 0);
        pushKeyframe(track, knot(15, 75, 100, 30, 4, 0, 3));
        // A knot landing at frame 30 cannot change where the path was at 10 —
        // the segment covering it is already bracketed on both sides.
        expect(keyframeResidual(track, knot(30, 130, 100, 75, 3, 0, 4), 10))
            .toBeLessThan(1e-9);
    });
});

describe('motion is a pure function of the cursor', () => {
    const launch = knot(50, 0, 0, 0, 2, 3, 1, KEYFRAME_LAUNCH);

    function build() {
        const track = createKeyframeTrack(launch, G);
        for (let i = 1; i <= 6; i++) {
            const w = simWalk(launch, G, i * 15);
            pushKeyframe(track, knot(50 + i * 15, w.x, w.y, w.z,
                launch.vx, w.vy, launch.vz));
        }
        return track;
    }

    it('a cursor that steps backwards rewinds exactly', () => {
        // Measured at the L2 gate: the presentation cursor genuinely steps
        // backwards on ~0.9 % of render ticks. Anything holding integrator
        // state mis-renders when it does; this must not.
        const track = build();
        const forward: Array<{ x: number; y: number; z: number }> = [];
        for (let f = 50; f <= 140; f += 1) forward.push(at(track, f).pos);
        // Walk the same frames in a deliberately ugly order — backwards, then
        // jumping — and demand identical answers.
        for (let i = forward.length - 1; i >= 0; i--) {
            const p = at(track, 50 + i).pos;
            expect(p.x).toBe(forward[i].x);
            expect(p.y).toBe(forward[i].y);
            expect(p.z).toBe(forward[i].z);
        }
        for (const i of [80, 3, 61, 17, 44]) {
            const p = at(track, 50 + i).pos;
            expect(p.y).toBe(forward[i].y);
        }
    });

    it('the search hint is an optimisation, never an assumption', () => {
        const fresh = build();
        const hinted = build();
        // Drive `hinted` to the far end so its hint points at the last
        // segment, then ask both for an early frame.
        at(hinted, 139);
        expect(hinted.hint).toBeGreaterThan(0);
        expect(at(hinted, 57).pos.y).toBe(at(fresh, 57).pos.y);
    });
});

describe('the ends of a flight', () => {
    it('holds at the muzzle before the launch frame', () => {
        const launch = knot(300, 10, 20, 30, 5, 5, 5, KEYFRAME_LAUNCH);
        const track = createKeyframeTrack(launch, G);
        for (const f of [0, 299, 299.99]) {
            const { pos } = at(track, f);
            expect(pos.x).toBe(10);
            expect(pos.y).toBe(20);
            expect(pos.z).toBe(30);
        }
    });

    it('holds the terminal knot verbatim, so the bolt stands on its explosion', () => {
        const launch = knot(0, 0, 0, 0, 10, 5, 0, KEYFRAME_LAUNCH);
        const track = createKeyframeTrack(launch, G);
        const term = knot(20, 197.3, 61.7, 0, 10, -0.85, 0, KEYFRAME_TERMINAL);
        pushKeyframe(track, term);
        expect(track.terminalFrame).toBe(20);
        for (const f of [20, 20.5, 200]) {
            const { pos } = at(track, f);
            // Byte-identical to the wire value, not merely close: the
            // explosion is scheduled at this exact point.
            expect(pos.x).toBe(term.x);
            expect(pos.y).toBe(term.y);
            expect(pos.z).toBe(term.z);
        }
    });

    it('reports velocity in elmos per second, positions in elmos', () => {
        const launch = knot(0, 0, 0, 0, 4, 0, -3, KEYFRAME_LAUNCH);
        const track = createKeyframeTrack(launch, 0);
        // The wire is per-frame; the renderer's consumers (CEG emit
        // direction, laser shaft basis) want per-second.
        expect(at(track, 0).vel.x).toBeCloseTo(4 * 30, 9);
        expect(at(track, 10).vel.z).toBeCloseTo(-3 * 30, 9);
    });
});

describe('knot bookkeeping', () => {
    it('inserts an out-of-order knot in frame order', () => {
        const track = createKeyframeTrack(knot(0, 0, 0, 0, 1, 0, 0, KEYFRAME_LAUNCH), 0);
        pushKeyframe(track, knot(30, 30, 0, 0, 1, 0, 0));
        pushKeyframe(track, knot(15, 15, 0, 0, 1, 0, 0));
        expect(track.knots.map((k) => k.frame)).toEqual([0, 15, 30]);
    });

    it('the later of two knots sharing a frame wins', () => {
        // schemas/protocol.fbs pins this: a sampled knot carries the pre-event
        // state and an event knot (Bounce, Terminal) the post-event state, and
        // the client must render the projectile as having bounced.
        const track = createKeyframeTrack(knot(0, 0, 0, 0, 0, -5, 0, KEYFRAME_LAUNCH), 0);
        pushKeyframe(track, knot(10, 0, -50, 0, 0, -5, 0, KEYFRAME_HEARTBEAT));
        pushKeyframe(track, knot(10, 0, -50, 0, 0, +3, 0, KEYFRAME_BOUNCE));
        pushKeyframe(track, knot(20, 0, -20, 0, 0, +3, 0));
        expect(track.knots.map((k) => k.kind))
            .toEqual([KEYFRAME_LAUNCH, KEYFRAME_HEARTBEAT, KEYFRAME_BOUNCE, KEYFRAME_HEARTBEAT]);
        // Frame 10 evaluates on the post-bounce branch: rising, not falling.
        expect(at(track, 10.5).pos.y).toBeGreaterThan(-50);
    });

    it('does not produce NaN for coincident knots', () => {
        const track = createKeyframeTrack(knot(5, 1, 2, 3, 0, 0, 0, KEYFRAME_LAUNCH), 0);
        pushKeyframe(track, knot(5, 4, 5, 6, 1, 1, 1, KEYFRAME_BOUNCE));
        pushKeyframe(track, knot(9, 8, 9, 10, 1, 1, 1));
        const { pos, vel } = at(track, 5);
        expect(Number.isFinite(pos.x)).toBe(true);
        expect(Number.isFinite(vel.y)).toBe(true);
    });

    it('a non-finite gravity is neutralised rather than propagated', () => {
        // A NaN here would reach a render matrix, which is a black frame —
        // strictly worse than a bolt that flies straight.
        const track = createKeyframeTrack(
            knot(0, 0, 0, 0, 1, 0, 0, KEYFRAME_LAUNCH), Number.NaN);
        expect(track.gravity).toBe(0);
        expect(at(track, 50).pos.y).toBe(0);
    });

    it('prunes stale knots but never the last one, and keeps launchFrame', () => {
        const track = createKeyframeTrack(knot(0, 0, 0, 0, 1, 0, 0, KEYFRAME_LAUNCH), 0);
        for (let f = 15; f <= 300; f += 15) pushKeyframe(track, knot(f, f, 0, 0, 1, 0, 0));
        const before = track.knots.length;
        pruneKeyframes(track, 300);
        expect(track.knots.length).toBeLessThan(before);
        // Retention is 90 frames, so nothing older than 210 survives.
        expect(track.knots[0].frame).toBeGreaterThanOrEqual(210);
        // The launch knot itself aged out; the gate on drawing did not.
        expect(track.launchFrame).toBe(0);
    });

    it('prune leaves a knot to continue from however far the cursor has run', () => {
        const track = createKeyframeTrack(knot(0, 0, 0, 0, 2, 0, 0, KEYFRAME_LAUNCH), 0);
        pruneKeyframes(track, 100_000);
        expect(track.knots).toHaveLength(1);
        expect(at(track, 100_000).pos.x).toBe(200_000);
    });
});
