// render-backend.js — the host interface the squad logic renders through.
//
// The squad modules are pure logic with NO Babylon/DOM imports. All visual
// effect goes through one of these, implemented by the game-processor worker
// adapter against thin-instanced meshes + the FX renderers (engine ask,
// PLAN-metalstorm-squads.md §6). Handles are opaque to the logic — typically a
// thin-instance index. Everything here is cosmetic; nothing affects the sim.

/**
 * @typedef {Object} MemberVisual
 * @property {string} defId       owning squad's unit def (selects model/skin)
 * @property {number} variant     0..N cosmetic variant for visual variety
 */

/**
 * @typedef {Object} DeathInfo
 * @property {number} x @property {number} y @property {number} z
 * @property {number} dirX @property {number} dirZ  // blast/threat direction
 * @property {number} [weaponDefId]                 // for death-style selection
 */

/**
 * @typedef {Object} RenderBackend
 * @property {(squadId:number, memberId:number, v:MemberVisual)=>number} createMember
 *   Create a member instance; returns an opaque handle.
 * @property {(handle:number, x:number, y:number, z:number, headingY:number, gait:number)=>void} updateMember
 *   Per-frame transform + animation phase (gait 0..1). Must be allocation-free.
 * @property {(handle:number, death:DeathInfo)=>void} destroyMember
 *   Play the death animation and release the instance. Permanent (member is
 *   dead, not just LOD-hidden — see releaseMember).
 * @property {(handle:number)=>void} releaseMember
 *   Free the instance for LOD (full→icon) with NO death FX/wreck — the member
 *   is still alive, just not rendered. Rebuildable via createMember.
 * @property {(x:number, y:number, z:number, headingY:number, v:MemberVisual)=>void} spawnWreck
 *   Drop cosmetic, fading debris (no game effect; TTL/cap owned by caller).
 * @property {(x:number, y:number, z:number, scale:number)=>void} [spawnImpactFx]
 *   Optional: nudge an explosion onto a killed member for alignment.
 * @property {(x:number, z:number)=>number} groundHeight
 *   Terrain height sample (client heightmap) for member Y.
 */

/** No-op backend for headless logic/tests. */
export class NullRenderBackend {
  createMember() { return -1; }
  updateMember() {}
  destroyMember() {}
  releaseMember() {}
  spawnWreck() {}
  spawnImpactFx() {}
  groundHeight() { return 0; }
}
