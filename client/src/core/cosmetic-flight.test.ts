import { describe, expect, it } from 'vitest';
import {
    type CosmeticFlight,
    applyCosmeticTracking,
    beginCosmeticTracking,
    evalCosmeticFlight,
    TRACK_VEL_SAMPLE_LAG,
    maxTrackingOffset,
    nextCosmeticProjectileId,
    solveCosmeticFlight,
    trackingWeight,
    trackingWeightSlope,
} from './cosmetic-flight.js';

const V = (x: number, y: number, z: number) => ({ x, y, z });

/** Evaluate a flight at `t`, returning fresh position/velocity. */
function at(c: CosmeticFlight, t: number) {
    const pos = V(NaN, NaN, NaN);
    const vel = V(NaN, NaN, NaN);
    evalCosmeticFlight(c, t, pos, vel);
    return { pos, vel };
}

/** The sim's own integration, run as the recurrence `CProjectile::Update`
 *  actually ticks: `speed += g` FIRST, then `pos += speed`. Used to check that
 *  our closed form is the same curve, not merely a curve through the same
 *  endpoints — the two differ by a half-step of gravity, which is exactly the
 *  bias that cost the server a 3.1× damage shortfall in L2.2. No correction
 *  term here: if the closed form needs one to agree, it is the wrong form. */
function integrate(c: CosmeticFlight, steps: number) {
    let px = c.ox, py = c.oy, pz = c.oz;
    let vx = c.vx, vy = c.vy, vz = c.vz;
    for (let i = 0; i < steps; i++) {
        vy += c.gravity;
        px += vx; py += vy; pz += vz;
    }
    return V(px, py, pz);
}

describe('solveCosmeticFlight', () => {
    it('lands exactly on origin at t=0 and on impactPos at t=frames (straight)', () => {
        const origin = V(100, 50, 200);
        const impact = V(400, 50, 260);
        const c = solveCosmeticFlight(origin, impact, 1000, 1020, 0);

        expect(c.frames).toBe(20);
        expect(at(c, 0).pos).toEqual(origin);
        expect(at(c, 20).pos).toEqual(impact);
    });

    it('lands exactly on impactPos at t=frames under gravity', () => {
        const origin = V(0, 100, 0);
        const impact = V(300, 20, -150);
        // -0.12 elmos/frame² is a typical `mygravity` (map gravity / 900).
        const c = solveCosmeticFlight(origin, impact, 500, 545, -0.12);

        expect(at(c, 0).pos).toEqual(origin);
        // Exact, not approximate — the endpoint is taken verbatim from the
        // wire rather than recomputed. This is the L2 convergence invariant.
        expect(at(c, c.frames).pos).toEqual(impact);
    });

    it('arcs above the straight line between the endpoints (gravity is real)', () => {
        const origin = V(0, 0, 0);
        const impact = V(600, 0, 0);
        const c = solveCosmeticFlight(origin, impact, 0, 60, -0.15);

        const mid = at(c, 30).pos;
        expect(mid.x).toBeCloseTo(300, 6);
        // Level shot, so the straight-line midpoint is y=0; the arc must peak
        // above it by ⅛·|g|·frames² = 0.125 * 0.15 * 3600.
        expect(mid.y).toBeCloseTo(67.5, 6);
    });

    it('reproduces the sim recurrence, not just its endpoints', () => {
        const origin = V(10, 80, -40);
        const impact = V(310, 25, 60);
        const c = solveCosmeticFlight(origin, impact, 0, 30, -0.1);

        for (const step of [1, 7, 15, 29, 30]) {
            const closed = at(c, step).pos;
            const stepped = integrate(c, step);
            expect(closed.x).toBeCloseTo(stepped.x, 4);
            expect(closed.y).toBeCloseTo(stepped.y, 4);
            expect(closed.z).toBeCloseTo(stepped.z, 4);
        }
    });

    it('clamps to the flight — never before the muzzle, never past the burst', () => {
        const origin = V(0, 0, 0);
        const impact = V(100, 0, 0);
        const c = solveCosmeticFlight(origin, impact, 200, 210, 0);

        // Cursor behind fireFrame (a past-due drain, or a clock correction).
        expect(at(c, -5).pos).toEqual(origin);
        // Cursor past impactFrame (drain and tick disagreeing by a sub-frame).
        expect(at(c, 11).pos).toEqual(impact);
        expect(at(c, 1e6).pos).toEqual(impact);
    });

    it('velocity comes back per second and tracks the arc', () => {
        const origin = V(0, 0, 0);
        const impact = V(300, 0, 0);
        const c = solveCosmeticFlight(origin, impact, 0, 30, -0.2);

        // 10 elmos/frame horizontally -> 300 elmos/s.
        expect(at(c, 0).vel.x).toBeCloseTo(300, 6);
        // Rising at launch, falling on arrival.
        expect(at(c, 0).vel.y).toBeGreaterThan(0);
        expect(at(c, 30).vel.y).toBeLessThan(0);
        // Vertical speed sheds exactly g per frame, all the way through.
        expect(at(c, 30).vel.y - at(c, 0).vel.y).toBeCloseTo(-0.2 * 30 * 30, 6);
        // The apex sits at 15.5 frames, not 15. That half-frame is not a
        // rounding artifact — it is the sim's own `speed += g` before
        // `pos += speed`, the same half-step the position formula carries.
        // A level shot is therefore NOT symmetric about frames/2, and
        // asserting that it is would be asserting the textbook parabola the
        // sim does not fly.
        expect(at(c, 15.5).vel.y).toBeCloseTo(0, 6);
        expect(at(c, 15).vel.y).toBeGreaterThan(0);
    });

    it('degenerate frames never divide by zero', () => {
        const origin = V(5, 5, 5);
        const impact = V(9, 9, 9);
        // Same frame both ends (a hitscan-adjacent shot, or a corrupt event).
        const c = solveCosmeticFlight(origin, impact, 700, 700, -0.1);
        expect(c.frames).toBe(1);
        expect(c.impactFrame).toBe(701);
        for (const v of Object.values(c)) expect(Number.isFinite(v)).toBe(true);
        expect(at(c, 1).pos).toEqual(impact);

        // impactFrame *behind* fireFrame is nonsense; it must still be finite.
        const back = solveCosmeticFlight(origin, impact, 700, 650, 0);
        expect(back.frames).toBe(1);
        expect(at(back, 1).pos).toEqual(impact);
    });

    it('a non-finite gravity degrades to a straight shot rather than NaN', () => {
        const origin = V(0, 0, 0);
        const impact = V(100, 100, 100);
        const c = solveCosmeticFlight(origin, impact, 0, 10, NaN);
        expect(c.gravity).toBe(0);
        const p = at(c, 5).pos;
        expect(p.x).toBeCloseTo(50, 6);
        expect(p.y).toBeCloseTo(50, 6);
        expect(p.z).toBeCloseTo(50, 6);
    });

    it('writes through to the caller-owned vectors (no per-frame allocation)', () => {
        const c = solveCosmeticFlight(V(0, 0, 0), V(60, 0, 0), 0, 6, 0);
        const pos = V(-1, -1, -1);
        const vel = V(-1, -1, -1);
        evalCosmeticFlight(c, 3, pos, vel);
        expect(pos).toEqual(V(30, 0, 0));
        evalCosmeticFlight(c, 6, pos, vel);
        expect(pos).toEqual(V(60, 0, 0));
    });
});

describe('nextCosmeticProjectileId', () => {
    it('never collides with a real (densely-allocated-from-0) projectile id', () => {
        // The invariant that lets an invented bolt share the renderer's `live`
        // map — and the A3 mirror's id space — with server-driven ones. A
        // sim-side id would have to pass 2^30 to reach this range.
        for (let i = 0; i < 100; i++) {
            expect(nextCosmeticProjectileId()).toBeGreaterThanOrEqual(0x4000_0000);
        }
    });

    it('is strictly increasing, so two shots in one frame get distinct ids', () => {
        const ids = Array.from({ length: 50 }, () => nextCosmeticProjectileId());
        expect(new Set(ids).size).toBe(ids.length);
        for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    });

    it('stays a positive int32 — it crosses the worker boundary as a plain number', () => {
        for (let i = 0; i < 20; i++) {
            const id = nextCosmeticProjectileId();
            expect(Number.isSafeInteger(id)).toBe(true);
            expect(id).toBeLessThan(0x7fff_ffff);
        }
    });
});

/* ------------------------------------------------------------------------ *
 * L2.3 — moving-target tracking
 * ------------------------------------------------------------------------ */

/** Evaluate a tracked flight at `t` against a target pose, as the renderer
 *  does: base arc first, tracking folded in second. */
function atTracked(
    c: CosmeticFlight,
    tr: ReturnType<typeof beginCosmeticTracking>,
    t: number,
    live: { x: number; y: number; z: number } | null,
) {
    const pos = V(NaN, NaN, NaN);
    const vel = V(NaN, NaN, NaN);
    evalCosmeticFlight(c, t, pos, vel);
    if (tr) applyCosmeticTracking(c, tr, t, live, pos, vel);
    return { pos, vel };
}

/** Begin tracking a target that was holding still when the shot was fired. */
function trackStill(c: CosmeticFlight, id: number, at: { x: number; y: number; z: number }) {
    return beginCosmeticTracking(c, id, at, at);
}

/** Begin tracking a target on a constant course of `v` elmos/frame. */
function trackMoving(
    c: CosmeticFlight, id: number,
    at: { x: number; y: number; z: number },
    v: { x: number; y: number; z: number },
) {
    return beginCosmeticTracking(c, id, at, V(
        at.x - v.x * TRACK_VEL_SAMPLE_LAG,
        at.y - v.y * TRACK_VEL_SAMPLE_LAG,
        at.z - v.z * TRACK_VEL_SAMPLE_LAG));
}

describe('trackingWeight', () => {
    it('is zero at both ends — the endpoints L2.2 pinned stay pinned', () => {
        expect(trackingWeight(0)).toBe(0);
        expect(trackingWeight(1)).toBe(0);
        // and outside, for a cursor that ran past or behind the flight
        expect(trackingWeight(-0.5)).toBe(0);
        expect(trackingWeight(1.5)).toBe(0);
    });

    it('reaches full correction exactly at the blend-back point', () => {
        expect(trackingWeight(0.9)).toBeCloseTo(1, 12);
    });

    it('is continuous and C^1 across the join at 0.9', () => {
        // A discontinuity in either value or slope reads as the missile
        // flinching; the join is the one place the two branches could disagree.
        // eps is small because the two sides approach zero slope at very
        // different rates: the blend-out is compressed into 10% of the flight,
        // so its slope grows 9x faster off the join than the ramp-in's does.
        // Both still reach 0 *at* the join, which is what C^1 asks for.
        const eps = 1e-8;
        expect(trackingWeight(0.9 - eps)).toBeCloseTo(trackingWeight(0.9 + eps), 9);
        expect(trackingWeightSlope(0.9 - eps)).toBeCloseTo(0, 4);
        expect(trackingWeightSlope(0.9 + eps)).toBeCloseTo(0, 4);
    });

    it('matches its own analytic slope by finite difference', () => {
        // The slope feeds the velocity the CEG trail and follow-light steer by,
        // so a wrong derivative points the exhaust the wrong way.
        const h = 1e-5;
        for (const u of [0.1, 0.35, 0.6, 0.85, 0.93, 0.97]) {
            const fd = (trackingWeight(u + h) - trackingWeight(u - h)) / (2 * h);
            expect(fd).toBeCloseTo(trackingWeightSlope(u), 3);
        }
    });

    it('never exceeds 1 anywhere in the flight', () => {
        for (let i = 0; i <= 1000; i++) {
            const w = trackingWeight(i / 1000);
            expect(w).toBeGreaterThanOrEqual(0);
            expect(w).toBeLessThanOrEqual(1 + 1e-12);
        }
    });
});

describe('maxTrackingOffset', () => {
    it('bounds the blend-out step by the bolt\'s own per-frame travel', () => {
        // The property the cap exists for: during the final 10% the tracking
        // term must never move the bolt further in one frame than the base arc
        // already does, or L2.3 reintroduces exactly the snap L2 removed.
        const c = solveCosmeticFlight(V(0, 0, 0), V(300, 0, 0), 100, 130, 0);
        const tr = trackStill(c, 7, V(0, 0, 0))!;
        const cap = maxTrackingOffset(c);
        // Drive the correction to the cap, along a fresh axis so the base arc
        // (pure +x) and the correction (pure +z) don't alias.
        const live = V(0, 0, 10_000);
        const normalStep = 300 / c.frames;
        let worst = 0;
        for (let f = 1; f <= c.frames; f++) {
            const a = atTracked(c, tr, f - 1, live).pos;
            const b = atTracked(c, tr, f, live).pos;
            const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
            worst = Math.max(worst, d);
        }
        expect(cap).toBeGreaterThan(0);
        // Worst single-frame step stays within the normal step plus the cap's
        // own budget of one — i.e. at most 2x, never an unbounded lurch.
        expect(worst).toBeLessThanOrEqual(normalStep * 2 + 1e-6);
    });

    it('scales with flight length, not with flight time', () => {
        const short = solveCosmeticFlight(V(0, 0, 0), V(150, 0, 0), 0, 10, 0);
        const long = solveCosmeticFlight(V(0, 0, 0), V(600, 0, 0), 0, 10, 0);
        expect(maxTrackingOffset(long)).toBeCloseTo(4 * maxTrackingOffset(short), 6);
    });
});

describe('beginCosmeticTracking', () => {
    it('declines without a target or without an anchor pose', () => {
        const c = solveCosmeticFlight(V(0, 0, 0), V(100, 0, 0), 0, 10, 0);
        // Ground/feature shot: no unit to track.
        expect(beginCosmeticTracking(c, 0, V(1, 2, 3))).toBeNull();
        // Target known but never seen — no anchor means no defined correction,
        // and guessing one would move a bolt off an arc that is provably right.
        expect(beginCosmeticTracking(c, 42, null)).toBeNull();
        expect(beginCosmeticTracking(c, 42, V(NaN, 0, 0))).toBeNull();
    });
});

describe('applyCosmeticTracking', () => {
    // 300 elmos over 30 frames => offset cap is 300/15 = 20 elmos.
    const flight = () => solveCosmeticFlight(V(0, 0, 0), V(300, 0, 0), 100, 130, 0);
    const CAP = 20;

    it('leaves the flight bit-identical while the target holds its course', () => {
        // The common case, and the one that must not regress L2.2's measured
        // numbers: a target doing exactly what the shot was aimed at gives a
        // zero correction at every t, moving or not.
        const c = flight();
        const v = V(0, 0, 2);                       // 2 elmos/frame sideways
        const tr = trackMoving(c, 5, V(300, 0, 0), v)!;
        for (let f = 0; f <= c.frames; f++) {
            const onCourse = V(300 + v.x * f, v.y * f, v.z * f);
            const plain = at(c, f);
            const tracked = atTracked(c, tr, f, onCourse);
            expect(tracked.pos).toEqual(plain.pos);
            expect(tracked.vel).toEqual(plain.vel);
        }
    });

    it('still terminates exactly on impactPos when the target has broken course', () => {
        // The convergence invariant, under the condition that stresses it.
        const c = flight();
        const tr = trackStill(c, 5, V(300, 0, 0))!;
        const live = V(300, 0, 12);                 // stopped dead, then slid sideways
        const end = atTracked(c, tr, c.frames, live).pos;
        expect(end.x).toBe(c.ix);
        expect(end.y).toBe(c.iy);
        expect(end.z).toBe(c.iz);
        // ... and it leaves the muzzle where the server said, too.
        const start = atTracked(c, tr, 0, live).pos;
        expect(start).toEqual(V(c.ox, c.oy, c.oz));
    });

    it('bends the middle of the arc toward the departure', () => {
        const c = flight();
        const tr = trackStill(c, 5, V(300, 0, 0))!;
        const live = V(300, 0, 12);
        const mid = atTracked(c, tr, c.frames * 0.6, live).pos;
        // Base arc is pure +x, so any z offset is the tracking term.
        expect(mid.z).toBeGreaterThan(1);
        expect(mid.z).toBeLessThanOrEqual(12);
    });

    it('measures the departure from the assumed course, not the travel', () => {
        // The distinction the first implementation got wrong: a target crossing
        // at speed is not "off course" — the shot was already led at it.
        const c = flight();
        const v = V(0, 0, 4);
        const tr = trackMoving(c, 5, V(300, 0, 0), v)!;
        const t = 15;
        const onCourse = V(300, 0, v.z * t);
        expect(atTracked(c, tr, t, onCourse).pos.z).toBeCloseTo(0, 9);
        // Same absolute position, but the shot was NOT led there: full offset.
        const still = trackStill(c, 5, V(300, 0, 0))!;
        expect(atTracked(c, still, t, onCourse).pos.z).toBeGreaterThan(1);
    });

    it('saturates at the cap rather than lurching after a huge departure', () => {
        const c = flight();
        const tr = trackStill(c, 5, V(300, 0, 0))!;
        expect(maxTrackingOffset(c)).toBeCloseTo(CAP, 9);
        atTracked(c, tr, c.frames * 0.9, V(300, 0, 100_000));
        expect(Math.hypot(tr.cx, tr.cy, tr.cz)).toBeCloseTo(CAP, 6);
    });

    it('holds the last correction when the target stops resolving', () => {
        // Decision 2: a Tier-C shot flies through to its precomputed impact even
        // when the target dies mid-flight. Dropping the correction instead would
        // snap the bolt back onto the base arc on the frame of the death.
        const c = flight();
        const tr = trackStill(c, 5, V(300, 0, 0))!;
        const live = V(300, 0, 12);
        const before = atTracked(c, tr, c.frames * 0.5, live).pos;
        const held = { cx: tr.cx, cy: tr.cy, cz: tr.cz };
        const after = atTracked(c, tr, c.frames * 0.5, null).pos;
        expect(after).toEqual(before);
        expect({ cx: tr.cx, cy: tr.cy, cz: tr.cz }).toEqual(held);
    });

    it('is a pure function of the cursor — a backwards step retraces exactly', () => {
        // The presentation cursor was measured stepping backwards on ~0.9% of
        // render ticks (L2 gate finding 2). Nothing here may integrate.
        const c = flight();
        const tr = trackStill(c, 5, V(300, 0, 0))!;
        const live = V(300, 0, 14);
        const forward = atTracked(c, tr, 20, live).pos;
        atTracked(c, tr, 27, live);
        const back = atTracked(c, tr, 20, live).pos;
        expect(back).toEqual(forward);
    });

    it('contributes the analytic derivative to velocity', () => {
        const c = flight();
        const tr = trackStill(c, 5, V(300, 0, 0))!;
        const live = V(300, 0, 14);
        const t = c.frames * 0.5;
        const h = 1e-4;
        const a = atTracked(c, tr, t - h, live).pos;
        const b = atTracked(c, tr, t + h, live).pos;
        // Finite-difference the *rendered* path in elmos/second (frames -> s).
        const fdz = (b.z - a.z) / (2 * h) * 30;
        expect(atTracked(c, tr, t, live).vel.z).toBeCloseTo(fdz, 3);
    });
});
