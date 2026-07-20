// client/squads — Metalstorm squad rendering system (public entry).
//
// One sim unit → many cosmetic on-screen members. Pure logic; the worker
// adapter supplies a RenderBackend. See PLAN-metalstorm-squads.md.
//
// Wiring (engine ask, Stage 7 — PLAN-metalstorm-squads.md §6):
//   import { createSquadSystem } from '.../client/squads/index.js';
//   const squads = createSquadSystem(workerRenderBackend);
//   // on entity-stream squad update:  squads.syncSquad(id, state, defOnce);
//   // on entity destroy (squad unit): squads.removeSquad(id);
//   // on impact/combat FX event:      squads.reportImpact({x,z,radius,squadId?});
//   // each render frame:              squads.update(dtSeconds);
//
// Big-unit threading (PLAN-metalstorm-flow.md §4, task 3 — client-only,
// cosmetic; footprintProfile is mocked until flow F1 lands):
//   // on a footprint-profile unit appearing: squads.registerBigUnit(id, footprintProfile);
//   // each render frame (interpolated pose): squads.syncBigUnit(id, x, z, heading, vx, vz, lod?);
//   // on entity destroy:                     squads.removeBigUnit(id);

import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';

export { SquadManager } from './squad-manager.js';
export { Squad } from './squad.js';
export { Member } from './member.js';
export { NullRenderBackend } from './render-backend.js';
export { DEFAULT_CONFIG, linearCount, collapseCount } from './config.js';
export { buildSlots, slotToWorld } from './formation.js';
export { createPatchSet, patchToWorld } from './patches.js';
export { BigUnitRepulsor, isUnderHull, hullPush, patchPush, panicClamp } from './big-unit-repulsor.js';

/**
 * Create a squad system.
 * @param {import('./render-backend.js').RenderBackend} [backend]
 * @param {object} [config] overrides merged over DEFAULT_CONFIG (e.g. countCurve)
 */
export function createSquadSystem(backend = new NullRenderBackend(), config = {}) {
  return new SquadManager(backend, config);
}
