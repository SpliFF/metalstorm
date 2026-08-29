// naval-cohesion.js — naval steerer strategy (PLAN-metalstorm-squad-cohesion.md §7).
//
// Ships/subs: capped-turn arrival (no pivot-in-place, unlike ground — but
// unlike air they CAN slow/stop so this still uses an arrival speed
// profile), a column-formation bias blending the slot target toward the
// breadcrumb trail while in transit (line-astern reads better for big
// bodies than raw slot-chasing), and a cosmetic depth channel for subs.
// Selected per-squad via movement-profiles.js (steerer: 'naval').
//
// Contract: steerMember(squad, member, dt, ctx) -> desired velocity {x,y,z}.
// `ctx = { profile, slotWorld, columnTarget, centroidSpeed }` — columnTarget
// is the breadcrumb trail-ahead point (pathfinding §4), or null if the squad
// has no trail yet (e.g. just spawned).

import {
  capTurnRate, headingFromVelocity, velocityFromHeading,
} from './steering.js';

/** Out-param form (PLAN-metalstorm-squad-performance.md §11b) — see
 *  air-cohesion.js's twin for why: the SoA kernel needs an allocation-free
 *  call, `steerMember` stays the allocating parity oracle. */
export function steerMemberInto(squad, member, dt, ctx, out) {
  const { profile, slotWorld, columnTarget, centroidSpeed } = ctx;
  const maxSpeed = squad.def.maxSpeed * (profile.cruiseSpeedMul ?? 1);
  const arrivalRadius = squad.cfg.arrivalRadius * (profile.arrivalRadiusMul ?? 1);

  // In transit, bias the target toward the trail (column/line-astern);
  // at rest (no meaningful centroid speed) go straight to the slot.
  let targetX = slotWorld.x, targetZ = slotWorld.z;
  if (columnTarget && centroidSpeed > 1e-3) {
    const bias = profile.columnBias ?? 0;
    targetX = slotWorld.x + (columnTarget.x - slotWorld.x) * bias;
    targetZ = slotWorld.z + (columnTarget.z - slotWorld.z) * bias;
  }

  const dx = targetX - member.x, dz = targetZ - member.z;
  const dist = Math.hypot(dx, dz);
  const desiredHeading = dist > 1e-4
    ? headingFromVelocity(dx, dz) : member.headingY;
  const newHeading = capTurnRate(member.headingY, desiredHeading, profile.turnRateCap, dt);

  const speed = dist < arrivalRadius ? maxSpeed * (dist / arrivalRadius) : maxSpeed;

  if (profile.subDepth != null) member.depth = profile.subDepth; // cosmetic; dive/surface trigger is a future hook (needs sim submerge state, not yet streamed)

  velocityFromHeading(newHeading, speed, out);
  out.y = 0;
  return out;
}

export function steerMember(squad, member, dt, ctx) {
  return steerMemberInto(squad, member, dt, ctx, { x: 0, y: 0, z: 0 });
}
