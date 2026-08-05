// perf-fix.test.js — the M13 steering fixes must be observationally inert
// (PLAN-perf M13).
//
// M13 ships three plumbing cuts that are supposed to cost nothing in fidelity:
// `trailGuard` stops computing a trail point for the ~95 % of members that
// never consult it, `passScratch` projects the slot into a shared scratch
// object instead of a fresh one, and passability resolves its move-class record
// once per ring search instead of once per cell tested. Each keeps its pre-fix
// path behind a switch so the win can be A/B'd in-session — which only means
// anything if the two arms produce the SAME sim. These tests pin that: drive
// the same squad both ways and require bit-identical member state and
// bit-identical backend writes.
//
// A fix that quietly changed steering would still measure faster, so "it got
// faster" is not evidence on its own. This is the evidence.

import { describe, it, expect, afterEach } from 'vitest';
import { Squad, setPerfFix, getPerfFixes } from './squad.js';
import { NullRenderBackend } from './render-backend.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';
import { createPassability } from './passability.js';

function makeCfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, countCurve: linearCount, ...overrides };
}

function makeDef(overrides = {}) {
  return {
    defId: 'fix_test',
    squadSize: 8,
    formationType: 'blob',
    formationRadius: 20,
    maxSpeed: 5,
    moveClass: 'INFANTRY',
    customParams: {},
    ...overrides,
  };
}

// Same ramp the M12 probe tests use: real impassable cells to project away
// from and a non-uniform cost field, so the pathfinding terms are not no-ops.
function makePassability() {
  return createPassability({
    bounds: { minX: 0, minZ: 0, maxX: 1024, maxZ: 1024 },
    // 3 elmos of rise per elmo of z past 500 is ~72 elmos per 24-elmo cell,
    // i.e. a ~72 degree slope: impassable to every land class, so a squad
    // walking north gets its slots projected and its members pushed into
    // COLUMN. A gentler ramp reads as passable and the guard's other branch
    // never runs.
    heightAt: (x, z) => (z > 500 ? (z - 500) * 3 : 0) + Math.sin(x / 60) * 3,
    waterLevel: 0,
  }, makeCfg());
}

/** Drive a squad `frames` steps under a given set of M13 switches and return a
 *  deep snapshot of every member's observable state, the transforms pushed at
 *  the render backend, and which steering modes were actually visited. */
function run(frames, fixes = {}, defOverrides = {}) {
  const cfg = makeCfg();
  const writes = [];
  const backend = new NullRenderBackend();
  backend.updateMember = (handle, x, y, z, headingY, gait) =>
    writes.push([handle, x, y, z, headingY, gait]);

  const squad = new Squad(1, makeDef(defOverrides), backend, cfg);
  squad.setPose(200, 0, 300, 0);
  const passability = makePassability();

  const others = squad.members.map(m => ({ x: m.x + 3, z: m.z + 3, squadId: 99, radius: 8 }));
  const query = () => others;

  setPerfFix();                                       // all fixes ON
  for (const [name, on] of Object.entries(fixes)) setPerfFix(name, on);

  const modesSeen = new Set();
  for (let f = 0; f < frames; f++) {
    // Heading is held still, then swung hard for ten frames, then held again:
    // 0.05 rad per 1/30 s step is 1.5 rad/s, over the 1.0 rad/s
    // turnTrailBiasRateThreshold, so `inTurn` is true only inside that window.
    const heading = f < 20 ? 0 : f < 30 ? (f - 20) * 0.05 : 0.5;
    squad.setPose(200 + f * 6, 0, 300 + f * 5, heading);
    squad.update(1 / 30, f / 30, query, passability);
    for (const m of squad.members) modesSeen.add(m.mode);
  }
  setPerfFix();

  return {
    members: squad.members.map(m => ({
      x: m.x, y: m.y, z: m.z, vx: m.vx, vz: m.vz,
      headingY: m.headingY, gait: m.gait, mode: m.mode,
      recoveryLevel: m.recoveryLevel, stuck: m._stuckFrames,
      lastDist: m._lastTargetDistSq, modeStreak: m._modeStreak,
    })),
    writes,
    modesSeen,
    trailLen: squad._trail.length,
  };
}

afterEach(() => setPerfFix());

describe('M13 fix switches (PLAN-perf M13)', () => {
  it('are all ON by default, so a shipping frame gets the fixes', () => {
    expect(getPerfFixes()).toEqual({ trailGuard: true, passScratch: true });
  });

  it('rejects an unknown fix name rather than silently doing nothing', () => {
    expect(() => setPerfFix('nosuchfix', false)).toThrow(/unknown perf fix/);
    expect(getPerfFixes().trailGuard).toBe(true);
  });

  it('restores every fix when called with no arguments (the A/B reset)', () => {
    setPerfFix('trailGuard', false);
    setPerfFix('passScratch', false);
    expect(setPerfFix()).toEqual({ trailGuard: true, passScratch: true });
  });
});

describe('M13 fix 1 — trailPointAhead guard', () => {
  // The scenario has to visit BOTH branches or the guard is untested: members
  // that consult the trail (COLUMN / recovering / mid-turn) and members that
  // do not. The drive turns the squad through impassable ground, which is what
  // pushes members into COLUMN in the first place.
  it('exercises both sides of the guard in this scenario', () => {
    const { modesSeen, trailLen } = run(60);
    expect(modesSeen.has('COLUMN')).toBe(true);
    expect(modesSeen.has('FORMATION')).toBe(true);
    expect(trailLen).toBeGreaterThan(1);   // there IS a trail to scan
  });

  it('leaves member state bit-identical to the pre-fix path', () => {
    const guarded = run(60, { trailGuard: true });
    const legacy = run(60, { trailGuard: false });
    expect(guarded.members).toEqual(legacy.members);
  });

  it('leaves the backend transform writes bit-identical', () => {
    const guarded = run(60, { trailGuard: true });
    const legacy = run(60, { trailGuard: false });
    expect(guarded.writes).toEqual(legacy.writes);
  });

  it('is inert for the naval steerer, which takes the trail point directly', () => {
    const naval = { customParams: { ms_class: 'ship' }, moveClass: 'SHIP' };
    const guarded = run(40, { trailGuard: true }, naval);
    const legacy = run(40, { trailGuard: false }, naval);
    expect(guarded.members).toEqual(legacy.members);
    expect(guarded.writes).toEqual(legacy.writes);
  });
});

describe('M13 fix 3 — alloc-free slot projection', () => {
  it('leaves member state and backend writes bit-identical', () => {
    const scratch = run(60, { passScratch: true });
    const legacy = run(60, { passScratch: false });
    expect(scratch.members).toEqual(legacy.members);
    expect(scratch.writes).toEqual(legacy.writes);
  });

  it('is inert when combined with the trail guard', () => {
    const both = run(60, { trailGuard: true, passScratch: true });
    const neither = run(60, { trailGuard: false, passScratch: false });
    expect(both.members).toEqual(neither.members);
    expect(both.writes).toEqual(neither.writes);
  });
});

describe('passability.nearestPassableInto (M13)', () => {
  const p = makePassability();

  it('agrees with the allocating form everywhere, passable or not', () => {
    const out = { x: 0, z: 0 };
    for (let x = 20; x < 1000; x += 37) {
      for (let z = 20; z < 1000; z += 41) {
        const alloc = p.nearestPassable(x, z, 'INFANTRY', 4);
        const into = p.nearestPassableInto(x, z, 'INFANTRY', 4, out);
        expect(into).toBe(out);                       // wrote into the caller's object
        expect({ x: into.x, z: into.z }).toEqual(alloc);
      }
    }
  });

  it('agrees for a naval class, whose passability test is the other branch', () => {
    const out = { x: 0, z: 0 };
    for (let z = 20; z < 1000; z += 53) {
      const alloc = p.nearestPassable(400, z, 'SHIP', 4);
      const into = p.nearestPassableInto(400, z, 'SHIP', 4, out);
      expect({ x: into.x, z: into.z }).toEqual(alloc);
    }
  });

  it('allocates nothing per call — the same object comes back every time', () => {
    const out = { x: 0, z: 0 };
    const a = p.nearestPassableInto(100, 100, 'INFANTRY', 4, out);
    const b = p.nearestPassableInto(900, 900, 'INFANTRY', 4, out);
    expect(a).toBe(b);
    // …whereas the legacy arm hands back a fresh object each time, which is
    // exactly the 7 200-allocations-per-frame this fix removes.
    expect(p.nearestPassable(100, 100, 'INFANTRY', 4))
      .not.toBe(p.nearestPassable(100, 100, 'INFANTRY', 4));
  });

  it('still resolves the class correctly after hoisting it out of the cell loop', () => {
    // An unknown/air class means "the grid does not apply" (§6): every cell
    // reads passable, so the query returns its input untouched.
    const out = { x: 0, z: 0 };
    expect(p.nearestPassableInto(700, 900, undefined, 4, out)).toEqual({ x: 700, z: 900 });
    // …and a class that IS in the table still projects off impassable ground.
    const steep = p.nearestPassableInto(400, 950, 'HEAVY', 4, out);
    expect(p.passable(steep.x, steep.z, 'HEAVY') || (steep.x === 400 && steep.z === 950)).toBe(true);
  });
});
