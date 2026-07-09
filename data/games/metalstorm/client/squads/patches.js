// patches.js — animated ground-contact patches (PLAN-metalstorm-flow.md task 2). STUB.
//
// Derives the patch set (feet / track strips) for big units from their
// footprint profile (gamedata/footprints.lua, exported to the client — flow
// F1) + gait phase, with planted/lifted windows so feet visually plant while
// smaller units flow around/UNDER the footprint. Gait phase is shared with
// the fx-offload animation path (PLAN-fx-offload.md §4) and the decal system
// (footprint patches drive PLAN-decal-tracks.md stamps).
//
// Pure logic; the render backend draws the patches (thin instances).

export function createPatchSet(footprintProfile) {
  return {
    /** advance gait phase; returns patches with planted/lifted state. */
    update(dt, speed) { return []; },
  };
}
