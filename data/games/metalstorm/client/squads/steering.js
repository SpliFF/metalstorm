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
 * Separation: push away from neighbours closer than separationRadius.
 * `neighbours` is an iterator of {x,z}; accumulates into out {x,z}.
 */
export function separate(px, pz, neighbours, separationRadius, out) {
  out.x = 0; out.z = 0;
  let n = 0;
  for (const nb of neighbours) {
    const dx = px - nb.x, dz = pz - nb.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 1e-6 && d2 < separationRadius * separationRadius) {
      const d = Math.sqrt(d2);
      out.x += dx / d / d;   // weight by inverse distance
      out.z += dz / d / d;
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
