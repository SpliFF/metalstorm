import { describe, expect, it } from 'vitest';
import {
    type CosmeticFlight,
    evalCosmeticFlight,
    nextCosmeticProjectileId,
    solveCosmeticFlight,
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
