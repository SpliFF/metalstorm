// steering.js — pure steering math. No state, no allocation (writes into `out`).
// See PLAN-metalstorm-squads.md §9.

/**
 * Arrival: accelerate toward target, easing within arrivalRadius.
 * Writes a desired-velocity contribution into out {x,z}.
 */
export function arrive(px, pz, tx, tz, maxSpeed, arrivalRadius, out) {
  const dx = tx - px, dz = tz - pz;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-4) { out.x = 0; out.z = 0; return out; }
  const speed = dist < arrivalRadius ? maxSpeed * (dist / arrivalRadius) : maxSpeed;
  const inv = speed / dist;
  out.x = dx * inv; out.z = dz * inv;
  return out;
}

/**
 * Separation: push away from neighbours closer than each neighbour's radius
 * (defaults to `separationRadius`; pseudo-member repulsors/wrecks/dense-cell
 * aggregates carry their own `radius`, PLAN-metalstorm-squad-collision.md
 * §4/§5). Same-squad vs other-squad neighbours get different weights (§2):
 * compared via `selfSquadId` against each neighbour's `squadId` — pseudo-
 * members carry no `squadId`, so they always fall to `otherWeight` (the
 * "part around obstacles strongly" case). `deadband` ignores contributions
 * whose overlap (radius - distance) is below it, so members resting right at
 * each other's separation-radius boundary don't jitter (§7 "boiling").
 * `neighbours` is an iterator of {x,z,squadId?,radius?}; accumulates into
 * out {x,z}.
 *
 * `includeOther` (PLAN-metalstorm-squad-performance.md §12c ladder L1 "drop
 * inter-squad separation"): when false, a neighbour that isn't same-squad
 * (another squad's member, a repulsor, a wreck, a dense-cell aggregate) is
 * skipped outright rather than weighted — NOT zero-weighted, which would
 * still dilute the average via `n`. Default true preserves every existing
 * caller's behaviour unchanged.
 *
 * ORCA seam (§3 — decision recorded, NOT implemented): a future velocity-
 * obstacle avoidance term would query neighbours through the same
 * SquadManager._neighbours generator and replace only this function's body,
 * so it can drop in without touching call sites.
 */
export function separate(px, pz, selfSquadId, neighbours, separationRadius, sameWeight, otherWeight, deadband, out, includeOther = true) {
  out.x = 0; out.z = 0;
  let n = 0;
  for (const nb of neighbours) {
    const same = nb.squadId === selfSquadId;
    if (!same && !includeOther) continue;
    const dx = px - nb.x, dz = pz - nb.z;
    const d2 = dx * dx + dz * dz;
    const r = nb.radius ?? separationRadius;
    if (d2 > 1e-6 && d2 < r * r) {
      const d = Math.sqrt(d2);
      if (r - d < deadband) continue; // §7: weak overlap near the boundary — ignore
      const w = same ? sameWeight : otherWeight;
      out.x += (dx / d / d) * w;   // weight by inverse distance, then pair-type
      out.z += (dz / d / d) * w;
      n++;
    }
  }
  if (n > 0) { out.x /= n; out.z /= n; }
  return out;
}

/** Clamp a vector's magnitude to max, in place. */
export function clampLen(v, max) {
  const m = Math.hypot(v.x, v.z);
  if (m > max && m > 1e-6) { const s = max / m; v.x *= s; v.z *= s; }
  return v;
}

const TWO_PI = Math.PI * 2;

/** Wrap an angle (radians) into (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - Math.PI;
}

/**
 * Turn `currentHeading` toward `desiredHeading` by at most `maxRate` rad/s,
 * over `dt` seconds (PLAN-metalstorm-squad-cohesion.md §6/§7 — aircraft and
 * ships steer heading under a turn-rate cap rather than snapping velocity).
 * Returns the new heading (radians, atan2(x,z) convention — +Z forward).
 */
export function capTurnRate(currentHeading, desiredHeading, maxRate, dt) {
  const delta = wrapAngle(desiredHeading - currentHeading);
  const maxDelta = maxRate * dt;
  if (delta > maxDelta) return currentHeading + maxDelta;
  if (delta < -maxDelta) return currentHeading - maxDelta;
  return currentHeading + delta;
}

/**
 * Soft-leash centripetal term (cohesion §1 layer 2): zero within `softRadius`
 * of the centroid, ramping linearly beyond it. Composes additively with
 * arrival/separation in `_desired`; the hard clamp in `Squad.update` remains
 * the last-resort guarantee.
 */
export function softLeashPull(px, pz, cx, cz, softRadius, gain, out) {
  const dx = cx - px, dz = cz - pz;
  const dist = Math.hypot(dx, dz);
  const over = dist - softRadius;
  if (over <= 0 || dist < 1e-4) { out.x = 0; out.z = 0; return out; }
  const s = (over * gain) / dist;
  out.x = dx * s; out.z = dz * s;
  return out;
}
