// naval-cohesion.js — naval steerer strategy (PLAN-metalstorm-squad-cohesion.md). STUB.
//
// Ships: capped-turn arrival (no pivot-in-place), column-formation bias in
// transit, wake-friendly spacing. Subs: the same plus a depth channel
// (submerged Y band; surfacing is cosmetic state, not sim).
// Selected per-squad via movement-profiles.js (steerer: 'naval').
//
// Contract: steerMember(squad, member, dt) → desired velocity {x, y, z};
// pure math, stateless beyond the member's own kinematic fields.

export function steerMember(squad, member, dt) {
  // TODO (cohesion plan): capped-turn arrival + column bias (+ sub depth).
  return { x: 0, y: 0, z: 0 };
}
