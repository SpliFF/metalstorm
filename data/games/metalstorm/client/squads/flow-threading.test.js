// flow-threading.test.js — PLAN-metalstorm-flow.md task 4 acceptance scene
// ("infantry squad threading a walking quad walker — this scene IS the
// acceptance test for the whole feature") + §9's headless threading spec:
// 16 members cross a moving 4-contact walker; zero members inside any
// planted patch beyond the frame they're clamped in; all members exit the
// far side; Y stays clamped. Same scene with a non-underpass class: no
// member ever enters the hull.
//
// Headless (NullRenderBackend) — this codebase's rendering pipeline is
// Stage-7-gated and not yet live; the plan's own §9 test spec is written as
// a headless scene for exactly this reason. footprintProfile is mocked
// (task 1 / flow F1 haven't landed).

import { describe, it, expect } from 'vitest';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';

const GROUND_Y = 42; // arbitrary non-zero constant — proves Y is always the
// ground sample, never some other (e.g. hull-mesh) height source.

class FlatGroundBackend extends NullRenderBackend {
  groundHeight() { return GROUND_Y; }
}

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

const SQUAD_DEF = {
  defId: 'metalstorm_soldiers_l',
  squadSize: 16,
  formationType: 'blob',
  formationRadius: 40,
  maxSpeed: 40,
};

const DT = 1 / 30;
const CROSS_SPEED = 50;   // squad centroid world speed, elmos/s
const WALKER_SPEED = 15;  // big unit world speed, elmos/s
const START_X = -260, END_X = 260;
const STEPS = Math.ceil((END_X - START_X) / CROSS_SPEED / DT) + 30; // a little slack past the far edge

/**
 * Drive the crossing scene; `moveClass` selects underpass eligibility.
 * `crossZ` is the squad centroid's constant Z during the crossing: 0 drives
 * it dead through the hull centre (the "under" scenario — realistic once the
 * gated sim-side F5 swept-footprint corridor exists, since only underpass
 * classes are ever routed through a hull); a non-zero offset grazes the
 * hull's edge instead, for classes F5 would route *around* — client
 * repulsion alone is what's under test there, not sim routing this codebase
 * doesn't have yet.
 */
function runCrossingScene(moveClass, crossZ = 0) {
  const backend = new FlatGroundBackend();
  const manager = new SquadManager(backend);
  const def = { ...SQUAD_DEF, moveClass };

  manager.registerBigUnit(100, QUAD_WALKER_L);

  let cx = START_X, buZ = -80;
  manager.syncSquad(1, { x: cx, z: crossZ, heading: Math.PI / 2, health: 1, maxHealth: 1, lod: 'full' }, def);
  manager.syncBigUnit(100, 0, buZ, 0, 0, WALKER_SPEED, 'full');

  let everUnderHull = false;
  let everInsideHullRect = false;
  const yValues = new Set();

  for (let i = 0; i < STEPS; i++) {
    cx += CROSS_SPEED * DT;
    buZ += WALKER_SPEED * DT;
    manager.syncSquad(1, { x: cx, z: crossZ, heading: Math.PI / 2, health: 1, maxHealth: 1, lod: 'full' }, def);
    manager.syncBigUnit(100, 0, buZ, 0, 0, WALKER_SPEED, 'full');

    manager.update(DT);

    const bu = manager.getBigUnit(100);
    const squad = manager.squads.get(1);
    for (const m of squad.memberPositions()) {
      yValues.add(m.y);

      if (bu.insideHull(m.x, m.z)) everInsideHullRect = true;

      // isUnderHull requires (permitted class, full LOD, inside hull) — the
      // exact condition squad.js used this frame to swap to patch repulsors.
      const underThisFrame = bu.lod === 'full' && bu.permitsUnderpass(moveClass) && bu.insideHull(m.x, m.z);
      if (underThisFrame) {
        everUnderHull = true;
        for (const patch of bu.patchSet.patches) {
          if (!patch.planted) continue;
          const s = Math.sin(bu.heading), c = Math.cos(bu.heading);
          const px = bu.x + (patch.x * c + patch.z * s);
          const pz = bu.z + (-patch.x * s + patch.z * c);
          const r = patch.kind === 'track' ? Math.max(patch.halfWidth, patch.halfLength) : patch.r;
          const dist = Math.hypot(m.x - px, m.z - pz);
          expect(dist).toBeGreaterThanOrEqual(r - 1e-6);
        }
      }
    }
  }

  return { manager, everUnderHull, everInsideHullRect, yValues };
}

describe('flow threading acceptance scene — infantry squad crossing a walking quad walker', () => {
  it('INFANTRY (underpass-permitted): threads under, never caught inside a planted patch, Y stays clamped, exits the far side', () => {
    const { manager, everUnderHull, yValues } = runCrossingScene('INFANTRY');

    expect(everUnderHull).toBe(true); // the scene actually exercised the under-hull path
    expect(yValues.size).toBe(1);
    expect([...yValues][0]).toBe(GROUND_Y);

    const squad = manager.squads.get(1);
    for (const m of squad.memberPositions()) {
      expect(m.x).toBeGreaterThan(END_X - 60); // reached the far side, not stuck mid-crossing
    }
    expect(squad.aliveCount).toBe(SQUAD_DEF.squadSize); // no casualties in a pure-threading scene
  });

  it('VEH (non-underpass class): never enters the hull rectangle at all', () => {
    // Grazes the hull's edge rather than driving through its centre — see
    // runCrossingScene's doc comment for why (F5 sim routing isn't built).
    const { everInsideHullRect, everUnderHull } = runCrossingScene('VEH', 75);

    expect(everUnderHull).toBe(false);
    expect(everInsideHullRect).toBe(false);
  });
});
