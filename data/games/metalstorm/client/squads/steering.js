// steering.js — pure steering math. No state, no allocation (writes into `out`).
// See PLAN-metalstorm-squads.md §9.

// ── Heading convention ─────────────────────────────────────────────────────
//
// A member's `headingY` names the SAME rotation the engine's `heading` names
// and the renderer draws: model space is glTF-native, so a member at heading
// θ has its forward (model −Z) pointing at
//
//     frontdir = (−sin θ, 0, −cos θ)
//
// That is the engine's `GetVectorFromHeading` (rts/System/SpringMath.inl) and
// exactly what `SquadRenderBackend.writeYawMatrix` draws — model −Z rotated by
// θ about +Y lands on (−sin θ, −cos θ). It is also the frame `sq.heading`
// arrives in off the wire, and the one `selectAtlasCell` measures impostor
// columns against.
//
// So the heading that FACES a velocity is `atan2(−vx, −vz)`, not
// `atan2(vx, vz)`. The plain form is the legacy left-handed (+Z-forward)
// reading; using it made every velocity-steered squad member render exactly
// 180° reversed — tanks driving rear-first (measured 2026-08-29: engine
// velocity·frontdir = +0.9995 while the member's rendered forward was −1×
// its travel direction). These two helpers are a matched pair — the engine
// negates symmetrically in `GetHeadingFromVector`/`GetVectorFromHeading` for
// the same reason — so change them together or not at all.

/** Heading (radians) whose forward faces the velocity/offset (vx, vz). */
export function headingFromVelocity(vx, vz) {
  return Math.atan2(-vx, -vz);
}

/** Inverse of {@link headingFromVelocity}: the velocity of magnitude `speed`
 *  that a member at `heading` is travelling forward along. Writes x/z into
 *  `out` and returns it (y is left untouched — air owns its own vy). */
export function velocityFromHeading(heading, speed, out) {
  out.x = -Math.sin(heading) * speed;
  out.z = -Math.cos(heading) * speed;
  return out;
}

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
 * `neighbours` is an array (or any iterable) of {x,z,squadId?,radius?};
 * accumulates into out {x,z}.
 *
 * `count` (optional) is how many leading entries of `neighbours` are live.
 * The hot path passes SquadManager's reusable neighbour buffer plus its fill
 * count, so this runs an indexed loop with no iterator and no allocation
 * (PLAN-perf M10). Omit it and any iterable works, which is what the tests and
 * the legacy generator path do.
 *
 * `sameSquadOnly` (optional) drops every neighbour that is not a member of the
 * asking squad, which is governor ladder L1 (PLAN-metalstorm-squad-
 * performance.md §12c: "separation stage skips other-squad/pseudo neighbours
 * (grid still built)"). Pseudo-members carry no `squadId`, so they are dropped
 * with the foreign members — big-unit hulls keep applying because they come
 * through _groundStep's own bow-wave term, not through this one. A distinct
 * PARAMETER rather than `otherWeight: 0` because a caller that zeroed the
 * weight would still pay the distance test and the divide for every foreign
 * member in the 3x3 neighbourhood, which is the cost L1 exists to shed.
 * NOTE the argument order: the S2 lane's own copy of this function put this
 * flag where `count` now sits, so re-applying that patch verbatim passes a
 * boolean as the fill count — `len = true` makes the loop run zero iterations
 * and silently disables ALL separation. Keep the flag last.
 *
 * ORCA seam (§3 — decision recorded, NOT implemented): a future velocity-
 * obstacle avoidance term would query neighbours through the same
 * SquadManager neighbour query and replace only this function's body, so it
 * can drop in without touching call sites.
 */
export function separate(px, pz, selfSquadId, neighbours, separationRadius, sameWeight, otherWeight, deadband, out, count, sameSquadOnly = false) {
  out.x = 0; out.z = 0;
  let list = neighbours, len = count;
  if (len === undefined) {
    if (!Array.isArray(list)) list = Array.from(list);
    len = list.length;
  }
  let n = 0;
  for (let i = 0; i < len; i++) {
    const nb = list[i];
    if (sameSquadOnly && nb.squadId !== selfSquadId) continue;
    const dx = px - nb.x, dz = pz - nb.z;
    const d2 = dx * dx + dz * dz;
    const r = nb.radius ?? separationRadius;
    if (d2 > 1e-6 && d2 < r * r) {
      const d = Math.sqrt(d2);
      if (r - d < deadband) continue; // §7: weak overlap near the boundary — ignore
      const w = nb.squadId === selfSquadId ? sameWeight : otherWeight;
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
 * Returns the new heading (radians, `headingFromVelocity` convention — model
 * −Z is forward; see the heading-convention note at the top of this file).
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
