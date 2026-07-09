// air-cohesion.js — air steerer strategy (PLAN-metalstorm-squad-cohesion.md). STUB.
//
// Air members don't do ground arrival: pursuit steering with a turn-rate
// cap, loiter/orbit around the squad anchor when idle, banking visual,
// altitude bands (a Y separation term added to the collision push).
// Selected per-squad via movement-profiles.js (steerer: 'air').
//
// Contract: steerMember(squad, member, dt) → desired velocity {x, y, z};
// pure math, stateless beyond the member's own kinematic fields.

export function steerMember(squad, member, dt) {
  // TODO (cohesion plan): pursuit + turn cap + loiter orbit + altitude band.
  return { x: 0, y: 0, z: 0 };
}
