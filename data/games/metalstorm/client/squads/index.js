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

import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';

export { SquadManager } from './squad-manager.js';
export { Squad } from './squad.js';
export { Member } from './member.js';
export { NullRenderBackend } from './render-backend.js';
export { DEFAULT_CONFIG, linearCount, collapseCount } from './config.js';
export { buildSlots, slotToWorld } from './formation.js';

/**
 * Create a squad system.
 * @param {import('./render-backend.js').RenderBackend} [backend]
 * @param {object} [config] overrides merged over DEFAULT_CONFIG (e.g. countCurve)
 */
export function createSquadSystem(backend = new NullRenderBackend(), config = {}) {
  return new SquadManager(backend, config);
}
