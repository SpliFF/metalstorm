// turn-slew.test.js — the M1 regression the suite was missing.
//
// USER-REPORTED 2026-08-29 watching `crossing_standoff`: ground members "spin
// on the spot and flip direction in milliseconds ... that's not how vehicles or
// even people turn." Nothing in the suite asserted a BOUND on how fast a member
// may rotate, which is how it shipped — `heading-convention.test.js` (T1) pins
// which way a member faces, and this file pins how fast it may get there.
//
// The two properties that matter are separable and tested separately:
//   * the RATE bound (no member turns faster than its class cap), and
//   * the ARC (a fully-coupled hull traces a circle of radius speed/cap rather
//     than pivoting on the spot).

import { describe, it, expect } from 'vitest';
import { turnToward, headingFromVelocity, wrapAngle } from './steering.js';
import { Member } from './member.js';
import { MOVEMENT_PROFILES, profileFor } from './movement-profiles.js';

const out = { x: 0, z: 0 };
const flatGround = { groundHeight: () => 0 };

describe('turnToward — the primitive', () => {
  it('is the identity at an infinite cap (the bench null control)', () => {
    // This is load-bearing: turn-slew.bench.ts subtracts a cap=Infinity arm to
    // separate the slew's cost from the cost of calling anything at all, and
    // movement-profiles.js documents Infinity as "pre-M1 behaviour". If this
    // ever stops being bit-exact, both of those claims are wrong.
    for (const [vx, vz] of [[1, 0], [0, 1], [-3, 4], [-0.001, -7], [5, -5]]) {
      const speed = Math.hypot(vx, vz);
      const h = turnToward(0.7, vx, vz, speed, Infinity, 1, out);
      expect(h).toBe(headingFromVelocity(vx, vz));
      expect(out.x).toBe(vx);
      expect(out.z).toBe(vz);
    }
  });

  it('never moves the heading further than maxDelta in one call', () => {
    const maxDelta = 0.05;
    let h = 0;
    // Desired heading is a full 180° away — the exact case the user reported.
    for (let i = 0; i < 100; i++) {
      const prev = h;
      h = turnToward(h, 0, 1, 1, maxDelta, 1, out); // faces -Z; wants +Z
      expect(Math.abs(wrapAngle(h - prev))).toBeLessThanOrEqual(maxDelta + 1e-12);
    }
  });

  it('takes the short way round the +/-PI wrap', () => {
    // Just below +PI wanting just above -PI: the long way is ~2PI of travel.
    const h = turnToward(3.10, ...velFor(-3.10), 1, 0.05, 1, out);
    expect(wrapAngle(h - 3.10)).toBeCloseTo(0.05, 12); // forwards, not backwards
  });

  it('converges on the wire/steering truth and then holds it', () => {
    let h = 0;
    for (let i = 0; i < 500; i++) h = turnToward(h, ...velFor(2.0), 1, 0.05, 1, out);
    expect(wrapAngle(h - 2.0)).toBeCloseTo(0, 12);
    // ...and does not overshoot once arrived.
    const settled = turnToward(h, ...velFor(2.0), 1, 0.05, 1, out);
    expect(settled).toBeCloseTo(2.0, 12);
  });

  it('re-points velocity onto the capped heading at coupling 1, preserving speed', () => {
    const speed = 7;
    // Steering wants heading +2.0; we are at 0 and may move 0.2 this step.
    const h = turnToward(0, ...velFor(2.0).map(c => c * speed), speed, 0.2, 1, out);
    expect(h).toBeCloseTo(0.2, 12);
    expect(Math.hypot(out.x, out.z)).toBeCloseTo(speed, 10);
    expect(headingFromVelocity(out.x, out.z)).toBeCloseTo(0.2, 10);
  });

  it('turns SOME way through an exact 180, and only by maxDelta', () => {
    // Facing -Z, steering hard +Z: both directions are equally short, so the
    // sign is arbitrary (wrapAngle maps +PI to -PI, so this file's convention
    // is "to port"). What is NOT arbitrary is the magnitude.
    const h = turnToward(0, 0, 7, 7, 0.2, 1, out);
    expect(Math.abs(wrapAngle(h))).toBeCloseTo(0.2, 12);
  });

  it('leaves velocity alone at coupling 0 — infantry sidestep, tanks do not', () => {
    const h = turnToward(0, 3, 4, 5, 0.2, 0, out);
    // atan2(-3, -4) is negative, so the short way round is to starboard.
    expect(h).toBeCloseTo(-0.2, 12);
    expect(out.x).toBe(3);
    expect(out.z).toBe(4);
  });

  it('traces a circle of radius speed/rate at full coupling', () => {
    // The user asked for a turn RADIUS, which only exists if the path curves.
    // Pure kinematics at constant speed, steering always hard left.
    const speed = 90, rate = 1.0, dt = 1 / 60;   // ~ tanks s2
    let x = 0, z = 0, vx = 0, vz = -speed, h = 0;
    const pts = [];
    for (let i = 0; i < 400; i++) {
      // Desired: 90 degrees to port of the current velocity — a hard, held turn.
      const h2 = turnToward(h, -vz, vx, speed, rate * dt, 1, out);
      h = h2; vx = out.x; vz = out.z;
      x += vx * dt; z += vz * dt;
      pts.push([x, z]);
    }
    // A circle's centre is equidistant from every point on it. Fit by centroid
    // of a full revolution, then check the radius is tight and correct.
    const rev = Math.ceil((2 * Math.PI / rate) / dt);
    const ring = pts.slice(0, rev);
    const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const cz = ring.reduce((a, p) => a + p[1], 0) / ring.length;
    const radii = ring.map(p => Math.hypot(p[0] - cx, p[1] - cz));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    expect(mean).toBeCloseTo(speed / rate, -1);            // 90 elmos = 11.2 m
    for (const r of radii) expect(Math.abs(r - mean)).toBeLessThan(mean * 0.02);
  });
});

describe('Member.integrate — the defect, end to end', () => {
  it('does not flip a tank 180 degrees between frames', () => {
    const { turnRateCap, arcCoupling } = MOVEMENT_PROFILES.tanks;
    const dt = 1 / 60, maxDelta = turnRateCap * dt;
    const m = new Member(0, null);
    m.vx = 0; m.vz = -90; m.headingY = headingFromVelocity(m.vx, m.vz);
    const start = m.headingY;

    let frames = 0, worst = 0;
    // Order the exact reversal the user watched: drive hard the other way.
    while (Math.abs(wrapAngle(m.headingY - wrapAngle(start + Math.PI))) > 0.02) {
      const prev = m.headingY;
      m.integrate(0, 90, dt, flatGround, Math.min(1, dt * 8), maxDelta, arcCoupling);
      worst = Math.max(worst, Math.abs(wrapAngle(m.headingY - prev)));
      if (++frames > 600) break;
    }
    // Rate bound honoured every single frame...
    expect(worst).toBeLessThanOrEqual(maxDelta + 1e-12);
    // ...so a 180 costs at least PI/rate seconds of real time, not one frame.
    expect(frames * dt).toBeGreaterThanOrEqual(Math.PI / turnRateCap);
    expect(frames * dt).toBeLessThan(2 * Math.PI / turnRateCap);   // and it DOES get there
  });

  it('carries the hull through an arc, not a pivot, while reversing', () => {
    const { turnRateCap, arcCoupling } = MOVEMENT_PROFILES.tanks;
    const dt = 1 / 60, maxDelta = turnRateCap * dt;
    const m = new Member(0, null);
    m.vx = 0; m.vz = -90; m.headingY = headingFromVelocity(m.vx, m.vz);
    for (let i = 0; i < Math.ceil(Math.PI / turnRateCap / dt); i++) {
      m.integrate(0, 90, dt, flatGround, Math.min(1, dt * 8), maxDelta, arcCoupling);
    }
    // A pivot-in-place would leave |x| ~ 0. An arc sweeps sideways by about a
    // diameter. Loose bound — the damped blend makes the speed vary through the
    // turn, so this asserts the SHAPE, not a number.
    expect(Math.abs(m.x)).toBeGreaterThan(50);
  });

  it('holds heading at rest instead of spinning on steering noise', () => {
    const m = new Member(0, null);
    m.headingY = 1.234;
    m.vx = 0; m.vz = 0;
    // Sub-threshold jitter from separation between packed, stationary members.
    for (let i = 0; i < 200; i++) {
      const j = (i % 2 ? 1 : -1) * 0.01;
      m.integrate(j, -j, 1 / 60, flatGround, Math.min(1, 8 / 60), 1.0 / 60, 1);
    }
    expect(m.headingY).toBe(1.234);
  });
});

describe('the per-class table', () => {
  it('caps every steerable class — an uncapped class is the shipped defect', () => {
    for (const [key, p] of Object.entries(MOVEMENT_PROFILES)) {
      expect(Number.isFinite(p.turnRateCap), `${key} has no turnRateCap`).toBe(true);
      expect(p.turnRateCap).toBeGreaterThan(0);
    }
  });

  it('orders the classes the way physics does: people > vehicles > ships', () => {
    const P = MOVEMENT_PROFILES;
    expect(P.soldiers.turnRateCap).toBeGreaterThan(P.mechs.turnRateCap);
    expect(P.mechs.turnRateCap).toBeGreaterThan(P.tanks.turnRateCap);
    expect(P.tanks.turnRateCap).toBeGreaterThan(P.artillery.turnRateCap);
    expect(P.artillery.turnRateCap).toBeGreaterThan(P.ships.turnRateCap);
  });

  it('keeps a 55 m cruiser off a pirouette', () => {
    // ms_ships_s3: maxvelocity 2.0 e/f -> 60 e/s, x1.25 memberSpeedMultiplier.
    // Hull is the shipped ms_ships_s3.gltf Z extent, 440 elmos (55 m at the
    // 8-elmos-per-metre world scale adopted 2026-08-27).
    const memberSpeed = 2.0 * 30 * 1.25;
    const hullLength = 440;
    const radius = memberSpeed / profileFor('ships').turnRateCap;
    expect(radius / hullLength).toBeGreaterThan(1.0);
  });

  it('lets infantry pivot fast but not instantly', () => {
    const cap = profileFor('soldiers').turnRateCap;
    expect(Math.PI / cap).toBeGreaterThan(0.5);   // a 180 takes over half a second
    expect(Math.PI / cap).toBeLessThan(2.0);      // but they are not vehicles
  });

  it('couples vehicle hulls to their path and leaves people free to sidestep', () => {
    expect(profileFor('tanks').arcCoupling).toBe(1);
    expect(profileFor('artillery').arcCoupling).toBe(1);
    expect(profileFor('soldiers').arcCoupling).toBe(0);
    expect(profileFor('civilians').arcCoupling).toBe(0);
  });
});

/** The (vx, vz) of unit speed that `headingFromVelocity` reads back as `h`. */
function velFor(h) { return [-Math.sin(h), -Math.cos(h)]; }
