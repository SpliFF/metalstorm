// client/squads — Metalstorm squad rendering system (public entry).
//
// One sim unit → many cosmetic on-screen members. Pure logic; the worker
// adapter supplies a RenderBackend. See PLAN-metalstorm-squads.md.
//
// Wiring (engine ask, Stage 7 — PLAN-metalstorm-squads.md §6). Only entities
// routed by isSquadDef(def) (squad_size > 1, squad-sync §4 H3) go through
// this system at all — everything else (buildings, scale-4 super-heavies)
// renders via entity-renderer.ts instead.
//   import { createSquadSystem, isSquadDef, createPassability } from '.../client/squads/index.js';
//   const squads = createSquadSystem(workerRenderBackend);
//   // once a heightmap sampler is available (PLAN-metalstorm-squad-pathfinding.md
//   // §2): squads.setPassability(createPassability(heightmapSampler, squads.cfg));
//   // on building create/destroy:    squads.stampBuildingFootprint(...) /
//   //                                 squads.clearBuildingFootprint(...);
//   // on heightmap deform (0x09):    squads.invalidateTerrain(x0,z0,x1,z1);
//   // on entity-create with a known def: squads.syncSquad(id, state, def);
//   // on entity-create with an unknown def (H1 — def-before-state is NOT
//   //   guaranteed): squads.syncSquad(id, state) [buffers], then once
//   //   DefCache resolves it: squads.noteDef(id, def) [flushes];
//   // each interpolator frame (pose only, render rate):
//   //                                    squads.syncPose(id, {x,y,z,heading});
//   // on entity-stream snapshot apply (strength only, ~10 Hz):
//   //                                    squads.syncStrength(id, health, maxHealth);
//   // on entity destroy (squad unit):    squads.removeSquad(id); // H2: also
//   //   clears any buffered pending state so a reused id can't resurrect
//   // on impact/combat FX event:         squads.reportImpact({x,z,radius,squadId?});
//   // on the same event, IF the attacker/projectile is visible (omit
//   //   entirely for a fog event — squad-casualties §6):
//   //                                    squads.reportThreat({x,z,radius,squadId?});
//   // each render frame:                 squads.update(dtSeconds);
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
export { DEFAULT_CONFIG, linearCount, collapseCount, isSquadDef } from './config.js';
export { buildSlots, slotToWorld } from './formation.js';
export { createPatchSet, patchToWorld } from './patches.js';
export { BigUnitRepulsor, isUnderHull, hullPush, patchPush, panicClamp } from './big-unit-repulsor.js';
export { createPassability } from './passability.js';
export { computeTier, screenPxFor, createLodState, LOD_FULL, LOD_CENTROID, LOD_ICON } from './lod.js';
export { MOVEMENT_PROFILES, profileFor } from './movement-profiles.js';

// SoA engine (PLAN-metalstorm-squad-performance.md §10) — `config.engine:
// 'soa'` on createSquadSystem/SquadManager routes through these instead of
// Squad/Member; exported so tests and (later) the kernel can reach the store
// and grid directly without an ad-hoc relative import.
export { createStore, allocPool, layoutViews, allocRun, freeRun, growStore, isAlive, isReleased, MFLAG_ALIVE, MFLAG_RELEASED, MFLAG_COLUMN } from './soa-store.js';
export { createGrid, rebuildGrid, queryInto } from './soa-grid.js';
export { SquadRec, createSquadRec } from './soa-squad.js';
export {
  stepMembers, createSchedule, scheduleReset, schedulePush,
  centroidStep, coastSquad, stepTransport,
  STEP_FULL, STEP_CENTROID, STEP_COAST,
} from './soa-kernel.js';

/**
 * Create a squad system.
 * @param {import('./render-backend.js').RenderBackend} [backend]
 * @param {object} [config] overrides merged over DEFAULT_CONFIG (e.g. countCurve)
 */
export function createSquadSystem(backend = new NullRenderBackend(), config = {}) {
  return new SquadManager(backend, config);
}
