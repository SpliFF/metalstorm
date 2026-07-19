// air-cohesion.js — air steerer strategy (PLAN-metalstorm-squad-cohesion.md §6).
//
// Fixed-wing aircraft can't stop or hover: constant forward motion at cruise
// speed, heading adjusted under a turn-rate cap (pursuit toward the slot),
// loiter/orbit when the squad's centroid is effectively stationary, a
// banking visual channel, and altitude bands so members don't stack in the
// same air column (a Y term separation/collision picks up separately).
// Selected per-squad via movement-profiles.js (steerer: 'air').
//
// Contract: steerMember(squad, member, dt, ctx) -> desired velocity {x,y,z}.
// `ctx = { profile, slotWorld, nowSec, centroidSpeed }` — profile is this
// class's movement-profiles.js entry; slotWorld is the member's formation
// slot already rotated to world space (squad.js computes it once per
// member/frame). Pure math, no allocation beyond the returned literal.

import { capTurnRate, wrapAngle } from './steering.js';

const TWO_PI = Math.PI * 2;

export function steerMember(squad, member, dt, ctx) {
  const { profile, slotWorld, nowSec, centroidSpeed } = ctx;
  const cruiseSpeed = squad.def.maxSpeed * (profile.cruiseSpeedMul ?? 1);
  const radius = squad.def.formationRadius;

  let targetX, targetZ;
  if (centroidSpeed <= profile.loiterSpeedEpsilon) {
    // Loiter: a racetrack/orbit around the (near-stationary) centroid at
    // formation_radius, phase-offset per member so they string out evenly.
    // Linear speed along the orbit == cruise speed, so members never stall.
    const angularSpeed = radius > 1e-3 ? cruiseSpeed / radius : 0;
    const phase = (member.slot / Math.max(1, squad.size)) * TWO_PI;
    const ang = nowSec * angularSpeed + phase;
    targetX = squad.cx + Math.cos(ang) * radius;
    targetZ = squad.cz + Math.sin(ang) * radius;
  } else {
    targetX = slotWorld.x;
    targetZ = slotWorld.z;
  }

  const dx = targetX - member.x, dz = targetZ - member.z;
  const desiredHeading = Math.hypot(dx, dz) > 1e-4 ? Math.atan2(dx, dz) : member.headingY;
  const prevHeading = member.headingY;
  const newHeading = capTurnRate(prevHeading, desiredHeading, profile.turnRateCap, dt);

  const turnDelta = wrapAngle(newHeading - prevHeading);
  const maxDelta = profile.turnRateCap * dt;
  member.bank = maxDelta > 1e-6 ? clamp(turnDelta / maxDelta, -1, 1) * profile.bankMax : 0;

  // Altitude band: assign once per member (stable by slot index), banded
  // around the class cruise altitude so a squad's aircraft don't co-locate
  // vertically. Absolute Y — air ignores ground height entirely (§6).
  if (member.altitudeOffset == null) {
    const band = member.slot - (squad.size - 1) / 2;
    member.altitudeOffset = band * profile.altitudeBandStep;
  }
  const targetY = squad.cy + profile.cruiseAltitude + member.altitudeOffset;
  const vy = (targetY - member.y) * profile.altitudeCatchUpRate;

  return {
    x: Math.sin(newHeading) * cruiseSpeed,
    y: vy,
    z: Math.cos(newHeading) * cruiseSpeed,
  };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
