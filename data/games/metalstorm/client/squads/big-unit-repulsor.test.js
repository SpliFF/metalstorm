// big-unit-repulsor.test.js — PLAN-metalstorm-flow.md task 3 coverage:
// repulsor-set swap matrix, velocity-biased bow wave, panic clamp.

import { describe, it, expect } from 'vitest';
import { createPatchSet } from './patches.js';
import { BigUnitRepulsor, isUnderHull, hullPush, panicClamp } from './big-unit-repulsor.js';
import { DEFAULT_CONFIG } from './config.js';

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

const BUILDING_NO_UNDERPASS = { ...QUAD_WALKER_L, underpass: [] };

function makeRepulsor(footprint) {
  return new BigUnitRepulsor(1, footprint, createPatchSet(footprint));
}

describe('isUnderHull — repulsor-set swap matrix (underpass class × permitting def)', () => {
  // All four cases share the same geometry: member sits at the repulsor's
  // centre (always "inside the hull") and full LOD, isolating the class ×
  // permission dimension per the plan's §9 test spec ("only 1 swaps").
  const member = { x: 0, z: 0 };

  it('permitted class + permitting def → swaps to patches (the 1-of-4 true case)', () => {
    const bu = makeRepulsor(QUAD_WALKER_L);
    bu.setPose(0, 0, 0, 0, 0, 'full');
    expect(isUnderHull(member, bu, 'INFANTRY')).toBe(true);
  });

  it('permitted class + non-permitting def → stays hull', () => {
    const bu = makeRepulsor(BUILDING_NO_UNDERPASS);
    bu.setPose(0, 0, 0, 0, 0, 'full');
    expect(isUnderHull(member, bu, 'INFANTRY')).toBe(false);
  });

  it('non-permitted class + permitting def → stays hull', () => {
    const bu = makeRepulsor(QUAD_WALKER_L);
    bu.setPose(0, 0, 0, 0, 0, 'full');
    expect(isUnderHull(member, bu, 'VEH')).toBe(false);
  });

  it('non-permitted class + non-permitting def → stays hull', () => {
    const bu = makeRepulsor(BUILDING_NO_UNDERPASS);
    bu.setPose(0, 0, 0, 0, 0, 'full');
    expect(isUnderHull(member, bu, 'VEH')).toBe(false);
  });

  it('LOD gate: even a permitted pair stays hull-mode outside full LOD', () => {
    const bu = makeRepulsor(QUAD_WALKER_L);
    bu.setPose(0, 0, 0, 0, 0, 'centroid');
    expect(isUnderHull(member, bu, 'INFANTRY')).toBe(false);
  });

  it('outside the hull rectangle, a permitted pair still stays hull-mode', () => {
    const bu = makeRepulsor(QUAD_WALKER_L);
    bu.setPose(0, 0, 0, 0, 0, 'full');
    expect(isUnderHull({ x: 1000, z: 1000 }, bu, 'INFANTRY')).toBe(false);
  });
});

describe('hullPush — velocity-biased bow wave', () => {
  it('pushes harder on a member ahead of the big unit\'s motion than one behind, at equal distance', () => {
    const bu = makeRepulsor(QUAD_WALKER_L);
    bu.setPose(0, 0, 0, 0, 40, 'full'); // walking along +Z
    const ahead = { x: 0, z: 100 };  // +Z from the repulsor: directly ahead
    const behind = { x: 0, z: -100 }; // -Z: directly behind

    const outAhead = { x: 0, z: 0 };
    hullPush(ahead, bu, DEFAULT_CONFIG, outAhead);
    const outBehind = { x: 0, z: 0 };
    hullPush(behind, bu, DEFAULT_CONFIG, outBehind);

    expect(Math.hypot(outAhead.x, outAhead.z)).toBeGreaterThan(Math.hypot(outBehind.x, outBehind.z));
  });

  it('is a no-op beyond the influence radius', () => {
    const bu = makeRepulsor(QUAD_WALKER_L);
    bu.setPose(0, 0, 0, 0, 0, 'full');
    const far = { x: 0, z: bu.hullRadius * DEFAULT_CONFIG.hullRepulseRadiusMul + 500 };
    const out = { x: 0, z: 0 };
    hullPush(far, bu, DEFAULT_CONFIG, out);
    expect(out.x).toBe(0);
    expect(out.z).toBe(0);
  });
});

describe('panicClamp', () => {
  it('pushes a member that lands inside a planted patch out to exactly the patch radius', () => {
    const bu = makeRepulsor(QUAD_WALKER_L);
    bu.setPose(0, 0, 0, 0, 0, 'full');
    bu.update(0); // phase 0 → contacts 0,1,2 planted (see patches.test.js)
    const plantedPatch = bu.patchSet.patches[0]; // x:-40, z:48, r:12

    const member = { x: plantedPatch.x + 3, z: plantedPatch.z }; // 3 elmos inside the foot
    const clamped = panicClamp(member, bu);

    expect(clamped).toBe(true);
    const dist = Math.hypot(member.x - plantedPatch.x, member.z - plantedPatch.z);
    expect(dist).toBeCloseTo(plantedPatch.r, 6);
  });

  it('does nothing when the member is outside every planted patch', () => {
    const bu = makeRepulsor(QUAD_WALKER_L);
    bu.setPose(0, 0, 0, 0, 0, 'full');
    bu.update(0);
    const member = { x: 5000, z: 5000 };
    const clamped = panicClamp(member, bu);
    expect(clamped).toBe(false);
    expect(member.x).toBe(5000);
    expect(member.z).toBe(5000);
  });
});
