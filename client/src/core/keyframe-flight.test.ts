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
    launchKeyframe,
    pruneKeyframes,
    pushKeyframe,
    terminalKeyframe,
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

// ---------------------------------------------------------------------------
// PLAN-latency L3.3 — the knots the server stopped sending.
//
// The L3 gate accepted a measured +35.6 % of `GameEventBatch` per shot. L3.3
// takes it back by not sending the two knots the client can already derive:
// the Launch knot restates the `ProjectileFiredEvent` (every keyframed class),
// and for a closed-form class the Terminal knot restates the
// `OutcomeKnownEvent`.
//
// "Can derive" is the whole claim, so it is tested as an *equality against the
// knots themselves*, not as a tolerance on the rendered path. If the derived
// track ever diverges from the sent one, the saving stops being free and these
// tests are where that shows up.
// ---------------------------------------------------------------------------

describe('L3.3 — Launch and Terminal knots derived rather than sent', () => {
    // A closed-form flight: launch at frame 100 from (0, 200, 0), moving +x
    // at 12 elmos/frame with map gravity. This is the sim's own recurrence
    // (speed += g before pos += speed), which is what `ballisticAt` models.
    const G = -0.11;
    const SPAWN = 100;
    const POS = { x: 0, y: 200, z: 0 };
    const VEL = { x: 12, y: 3, z: 0 };

    /** The track as a pre-L3.3 server built it: an actual Launch knot. */
    const sentLaunch = () => createKeyframeTrack(
        knot(SPAWN, POS.x, POS.y, POS.z, VEL.x, VEL.y, VEL.z, KEYFRAME_LAUNCH), G);

    /** The track as L3.3 builds it: from the Fired event and the batch frame. */
    const derivedLaunch = () => createKeyframeTrack(
        launchKeyframe(SPAWN, POS, VEL), G);

    it('the derived Launch knot is field-for-field the one the server sent', () => {
        // The server wrote its knot from the same `evPos` and `speed` as the
        // Fired event, in the same block, stamped with the same frame. Not
        // "close enough" — identical, which is why dropping it costs nothing.
        expect(derivedLaunch().knots[0]).toEqual(sentLaunch().knots[0]);
    });

    it('the launch-frame gate survives losing the knot', () => {
        // `launchFrame` is what holds a Tier-S bolt at the muzzle until the
        // cursor reaches its spawn frame — the L3.2 finding that bolts stopped
        // appearing `D` frames early. It is derived from the knot, so it has to
        // come out of the reconstruction too or that win silently regresses.
        expect(derivedLaunch().launchFrame).toBe(SPAWN);
    });

    it('renders identically to the sent-knot track across the whole flight', () => {
        const sent = sentLaunch(), derived = derivedLaunch();
        for (let f = SPAWN - 5; f <= SPAWN + 60; f++) {
            expect(at(derived, f)).toEqual(at(sent, f));
        }
    });

    it('the derived Terminal knot lands the bolt exactly on the explosion', () => {
        // The position is taken from `outcome_pos` verbatim rather than
        // integrated toward, which is what keeps convergence exact by
        // construction — the same property the sent knot had, and the one the
        // L3 gate measured at 0.000 elmos.
        const track = derivedLaunch();
        const impact = { x: 137.9, y: 61.25, z: 0 };
        pushKeyframe(track, terminalKeyframe(track, SPAWN + 24, impact));

        const { pos } = at(track, SPAWN + 24);
        expect(pos.x).toBe(impact.x);
        expect(pos.y).toBe(impact.y);
        expect(pos.z).toBe(impact.z);
    });

    it('the derived Terminal velocity is the sim arc continued, not a guess', () => {
        // Only the velocity has to be derived at all. For a closed-form class
        // the continuation IS the sim's arc, so it agrees with what the server
        // would have measured — up to the last tick, where a ground burst
        // detonates at the tick boundary rather than at the crossing.
        const track = derivedLaunch();
        const t = 24;
        const expected = { x: 0, y: 0, z: 0 }, ev = { x: 0, y: 0, z: 0 };
        ballisticAt(track.knots[0], t, G, expected, ev);

        const term = terminalKeyframe(track, SPAWN + t, { x: 1, y: 2, z: 3 });
        expect(term.vx).toBeCloseTo(ev.x, 10);
        expect(term.vy).toBeCloseTo(ev.y, 10);
        expect(term.vz).toBeCloseTo(ev.z, 10);
        expect(term.kind).toBe(KEYFRAME_TERMINAL);
    });

    it('holds the terminal position past the outcome frame', () => {
        // `terminalFrame` has to be set by the derived knot too, or the bolt
        // flies on through its own burst.
        const track = derivedLaunch();
        const impact = { x: 137.9, y: 61.25, z: 0 };
        pushKeyframe(track, terminalKeyframe(track, SPAWN + 24, impact));
        expect(track.terminalFrame).toBe(SPAWN + 24);
        expect(at(track, SPAWN + 40).pos).toEqual(impact);
    });

    it('derives the Terminal velocity from the LAST knot, not the launch', () => {
        // A closed-form class can still bounce, and a Bounce knot is still
        // sent. Continuing from the launch knot across a bounce would put the
        // terminal tangent under the ground and point the impact CEG the wrong
        // way — subtle enough to survive a visual check.
        const track = derivedLaunch();
        pushKeyframe(track, knot(SPAWN + 10, 120, 8, 0, 12, 2.2, 0, KEYFRAME_BOUNCE));

        const term = terminalKeyframe(track, SPAWN + 14, { x: 168, y: 12, z: 0 });
        const expected = { x: 0, y: 0, z: 0 }, ev = { x: 0, y: 0, z: 0 };
        ballisticAt(track.knots[track.knots.length - 1], 4, G, expected, ev);
        expect(term.vy).toBeCloseTo(ev.y, 10);
        expect(term.vy).toBeGreaterThan(0);   // still rising out of the bounce
    });
});
