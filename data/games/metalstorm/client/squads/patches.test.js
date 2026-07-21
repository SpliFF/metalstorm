// patches.test.js — PLAN-metalstorm-flow.md §9 "Vitest, patches.js" coverage.
// Fixtures use footprint_profile shapes matching the plan's §1 schema
// (mocked — task 1 / F1 export haven't landed yet).

import { describe, it, expect } from 'vitest';
import { createPatchSet, patchToWorld } from './patches.js';

const QUAD_WALKER_L = {
  hull: { x: 96, z: 128 },
  clearance: 18,
  underpass: ['INFANTRY'],
  contacts: [
    { kind: 'foot', x: -40, z: 48, r: 12, gait: { phase: 0.00, duty: 0.62 } },
    { kind: 'foot', x: 40, z: 48, r: 12, gait: { phase: 0.50, duty: 0.62 } },
    { kind: 'foot', x: -40, z: -48, r: 12, gait: { phase: 0.25, duty: 0.62 } },
    { kind: 'foot', x: 40, z: -48, r: 12, gait: { phase: 0.75, duty: 0.62 } },
  ],
};

const TRACKED = {
  hull: { x: 80, z: 140 },
  clearance: 10,
  underpass: ['INFANTRY'],
  contacts: [
    { kind: 'track', x: -30, z: 0, halfWidth: 10, halfLength: 60 },
    { kind: 'track', x: 30, z: 0, halfWidth: 10, halfLength: 60 },
  ],
};

describe('createPatchSet — gait phase / duty windows', () => {
  it('at phase 0, planted state matches each foot\'s own duty window exactly', () => {
    const ps = createPatchSet(QUAD_WALKER_L);
    const patches = ps.update(0, 0); // speed 0 → phase stays at 0
    expect(patches.map((p) => p.planted)).toEqual([true, true, true, false]);
  });

  it('at a known non-zero phase, feet interleave (not lockstep)', () => {
    const ps = createPatchSet(QUAD_WALKER_L);
    // speed * dt * 0.1 = 0.3 in one step
    const patches = ps.update(3, 1);
    expect(ps.phase).toBeCloseTo(0.3, 10);
    expect(patches.map((p) => p.planted)).toEqual([true, false, true, true]);
  });

  it('each foot plants exactly its duty fraction over one full gait cycle', () => {
    const ps = createPatchSet(QUAD_WALKER_L);
    const steps = 1000;
    const dt = 0.01, speed = 1; // total phase advance over the run: steps * dt * speed * 0.1 = 1.0 (one cycle)
    const plantedFrames = [0, 0, 0, 0];
    for (let i = 0; i < steps; i++) {
      const patches = ps.update(dt, speed);
      for (let f = 0; f < 4; f++) if (patches[f].planted) plantedFrames[f]++;
    }
    for (let f = 0; f < 4; f++) {
      expect(plantedFrames[f] / steps).toBeCloseTo(QUAD_WALKER_L.contacts[f].gait.duty, 2);
    }
  });

  it('phases interleave: the planted set changes over the cycle rather than all feet moving together', () => {
    const ps = createPatchSet(QUAD_WALKER_L);
    const seen = new Set();
    for (let i = 0; i < 20; i++) {
      const patches = ps.update(0.5, 1); // phase step 0.05 each call
      seen.add(patches.map((p) => (p.planted ? 1 : 0)).join(''));
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('createPatchSet — track strips', () => {
  it('track patches are always planted regardless of speed/phase', () => {
    const ps = createPatchSet(TRACKED);
    for (const speed of [0, 1, 5, 20]) {
      const patches = ps.update(0.2, speed);
      expect(patches.every((p) => p.planted)).toBe(true);
    }
  });

  it('track patches carry halfWidth/halfLength, not r', () => {
    const ps = createPatchSet(TRACKED);
    const patches = ps.update(0, 0);
    for (const p of patches) {
      expect(p.kind).toBe('track');
      expect(p.halfWidth).toBeGreaterThan(0);
      expect(p.halfLength).toBeGreaterThan(0);
    }
  });
});

describe('patchToWorld', () => {
  it('identity heading (0) maps local x/z directly onto the pose offset', () => {
    const out = { x: 0, z: 0 };
    patchToWorld({ x: 10, z: 5 }, 100, 200, 0, out);
    expect(out.x).toBeCloseTo(110, 10);
    expect(out.z).toBeCloseTo(205, 10);
  });

  it('a 180-degree heading negates both local axes relative to the pose', () => {
    const out = { x: 0, z: 0 };
    patchToWorld({ x: 10, z: 5 }, 100, 200, Math.PI, out);
    expect(out.x).toBeCloseTo(90, 6);
    expect(out.z).toBeCloseTo(195, 6);
  });

  it('a 90-degree heading rotates local +Z (forward) onto world +X', () => {
    const out = { x: 0, z: 0 };
    patchToWorld({ x: 0, z: 10 }, 0, 0, Math.PI / 2, out);
    expect(out.x).toBeCloseTo(10, 6);
    expect(out.z).toBeCloseTo(0, 6);
  });
});
