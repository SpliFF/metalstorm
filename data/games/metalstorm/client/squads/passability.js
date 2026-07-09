// passability.js — client-side passability grid (PLAN-metalstorm-squad-pathfinding.md). STUB.
//
// "The one piece of new infrastructure" in the pathfinding plan: a coarse
// grid built from the smoothed heightmap (slope bands per move class +
// water), queried by member steering so cosmetic members never walk through
// cliffs/water their sim unit couldn't.
//
// Per-class maxSlope MIRRORS gamedata/moveinfo.tdf (INFANTRY/VEH/HEAVY/
// SHIP/SUB) — keep in lockstep. Cell indexing uses Math.floor (NOT |0 —
// negative coords; same fix recorded for the collision spatial hash and the
// performance dense grid, see PLAN-metalstorm-structure.md).
//
// Pure logic, no imports beyond squads config. Consumed by squad.js /
// member steering; invalidated by building-footprint stamps and heightmap
// deform broadcasts (envelope 0x09).

export function createPassability(heightmapSampler, config) {
  return {
    /** @returns {boolean} can moveClass stand at (x, z)? TODO slope+water bands. */
    passable(x, z, moveClass) { return true; },
    /** traversal cost multiplier at (x, z). TODO. */
    cost(x, z) { return 1.0; },
    /** spiral search for the nearest passable cell (drop points, unstick). */
    nearestPassable(x, z, moveClass, cap) { return { x, z }; },
    /** dirty-rect invalidation (building stamped / terrain deformed). */
    invalidate(x0, z0, x1, z1) {},
  };
}
