// ui/lib/regions.js — client mirror of the region graph. STUB.
//
// Pure logic, no DOM — shared by the strategic-map overlay
// (shaders/region-overlay.frag.glsl tint texture), order cost prediction
// (ui/lib/authority-cost.js regionMod input), the command composer's named
// places, and the parley pact map layer. See PLAN-metalstorm-regions.md §5.
//
// Data flow: static geometry from the map export (data/maps/<id>/regions.json,
// engine ask R1) + live ownership/contested state from rulesParams
// (region_<key>_team / region_<key>_contested, batched under regions_rev).

/**
 * Build the client region index.
 * @param {object} geometryJson parsed regions.json (polygons, adjacency, tags)
 */
export function createRegionIndex(geometryJson) {
  return {
    /** region at world position → key, or null. TODO lookup grid. */
    at(x, z) { return null; },
    /** live owner team for a region key (from the rulesParams mirror). */
    owner(key) { return null; },
    /** cost modifier at position for prediction (authority §4). */
    costModifierAt(x, z, teamId) { return 1.0; },
    /** ingest a rulesParams batch (regions_rev-guarded). */
    applyParams(params) {},
  };
}
