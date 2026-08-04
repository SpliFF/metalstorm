// big-unit-repulsor.js — client threading around/under big units (scale-4
// super-heavies + buildings with an authored footprint_profile).
// PLAN-metalstorm-flow.md task 3 (collision integration) + task 4 (Y-clamp /
// speed penalty under hulls).
//
// Sim vs client split (flow.md §5, restated hard): this is 100% cosmetic
// threading. It never touches the sim's footprint permeability / yield rules
// (flow engine asks F1-F5, Stage-7-gated, NOT built) — it only tries to look
// plausible against the *rules* (the `underpass` list on the mocked
// footprint profile), matching squad-collision.md §5's pseudo-member-repulsor
// idea. squad-collision.md's own base infrastructure (spatial-hash pseudo-
// member insertion, dual same/other-squad weights, neighbour caps) belongs to
// the still-blocked metalstorm-squads lane and is NOT reused here — big units
// are rare (scale-4 only), so this queries them by plain iteration instead of
// through that hash.
//
// Two repulsor modes, chosen per (member squad, big unit) pair each frame:
//  - hull (default): one large circular repulsor (radius from the hull's
//    circumscribed circle), biased by the big unit's velocity so members part
//    in a bow-wave ahead of its motion (flow.md §4 "Around").
//  - patches (underpass classes only, permitting def, full LOD): the hull
//    repulsor is replaced by the big unit's planted contact patches — members
//    thread between feet/tracks via ordinary separation-style steering, plus
//    a hard "panic" clamp if a foot plants on top of them (flow.md §4
//    "Under" + "Panic clause").
//
// Pure logic; no render/backend imports. Reused scratch objects — the
// per-frame loops must not allocate.

import { patchToWorld } from './patches.js';

const _local = { x: 0, z: 0 };
const _patchWorld = { x: 0, z: 0 };

export class BigUnitRepulsor {
  /**
   * @param {number} id
   * @param {object} footprintProfile  see patches.js header (mocked until flow F1 lands)
   * @param {ReturnType<import('./patches.js').createPatchSet>} patchSet
   */
  constructor(id, footprintProfile, patchSet) {
    this.id = id;
    this.footprint = footprintProfile;
    this.patchSet = patchSet;
    this.hullRadius = Math.hypot(footprintProfile.hull.x, footprintProfile.hull.z) / 2;

    this.x = 0; this.z = 0; this.heading = 0;
    this.vx = 0; this.vz = 0;
    this.lod = 'full'; // 'full' | 'centroid' | 'icon' — set by the adapter (camera range), not computed here
  }

  /** Mirror the big unit's interpolated pose + velocity (cosmetic input only). */
  setPose(x, z, heading, vx, vz, lod) {
    this.x = x; this.z = z; this.heading = heading;
    this.vx = vx; this.vz = vz;
    if (lod) this.lod = lod;
  }

  /** Advance the gait-driven patch set. Call once per big unit per frame. */
  update(dt) {
    this.patchSet.update(dt, Math.hypot(this.vx, this.vz));
  }

  /** World point (wx,wz) rotated into this big unit's local frame. */
  toLocal(wx, wz, out) {
    const dx = wx - this.x, dz = wz - this.z;
    const s = Math.sin(-this.heading), c = Math.cos(-this.heading);
    out.x = dx * c + dz * s;
    out.z = -dx * s + dz * c;
    return out;
  }

  /** Is (wx,wz) inside the hull's axis-aligned footprint rectangle? */
  insideHull(wx, wz) {
    this.toLocal(wx, wz, _local);
    return Math.abs(_local.x) <= this.footprint.hull.x / 2 &&
           Math.abs(_local.z) <= this.footprint.hull.z / 2;
  }

  /** Does `moveClass` (moveinfo.tdf name) pass under this profile? */
  permitsUnderpass(moveClass) {
    return !!moveClass && this.footprint.underpass.includes(moveClass);
  }
}

/**
 * Does this member currently qualify for the "under" repulsor-set swap
 * (flow.md §4 matrix: underpass class × permitting def × full LOD × inside
 * the hull rectangle — all four must hold)?
 */
export function isUnderHull(member, repulsor, moveClass) {
  return repulsor.lod === 'full' &&
    repulsor.permitsUnderpass(moveClass) &&
    repulsor.insideHull(member.x, member.z);
}

/**
 * Velocity-biased hull repulsor (flow.md §4 "Around"). Accumulates a push
 * into `out` {x,z}; does not clamp magnitude (caller weights + clamps the
 * combined desired velocity, same as steering.separate).
 */
export function hullPush(member, repulsor, cfg, out) {
  const dx = member.x - repulsor.x, dz = member.z - repulsor.z;
  const dist = Math.hypot(dx, dz);
  const influence = repulsor.hullRadius * cfg.hullRepulseRadiusMul;
  if (dist < 1e-4 || dist >= influence) return;

  const nx = dx / dist, nz = dz / dist;
  let bias = 1;
  const speed = Math.hypot(repulsor.vx, repulsor.vz);
  if (speed > 1e-3) {
    const vnx = repulsor.vx / speed, vnz = repulsor.vz / speed;
    const dot = nx * vnx + nz * vnz; // one dot product per member-repulsor pair
    bias = 1 + Math.max(0, dot) * cfg.bowWaveBias;
  }
  const strength = (1 - dist / influence) * bias;
  out.x += nx * strength;
  out.z += nz * strength;
}

/**
 * Soft steer-away from planted patches while threading under (flow.md §4
 * "Under"). Accumulates into `out`, same convention as hullPush.
 */
export function patchPush(member, repulsor, cfg, out) {
  for (const patch of repulsor.patchSet.patches) {
    if (!patch.planted) continue;
    patchToWorld(patch, repulsor.x, repulsor.z, repulsor.heading, _patchWorld);
    const dx = member.x - _patchWorld.x, dz = member.z - _patchWorld.z;
    const d2 = dx * dx + dz * dz;
    const r = patchRadius(patch);
    const influence = r * cfg.patchRepulseRadiusMul;
    if (d2 < 1e-8 || d2 >= influence * influence) continue;
    const d = Math.sqrt(d2);
    out.x += dx / d / d;
    out.z += dz / d / d;
  }
}

/**
 * Panic clause (flow.md §4): a patch about to plant on a member hard-pushes
 * it clear, same mechanism as the cohesion leash clamp. Call AFTER
 * integration, once per (member, big unit) pair where isUnderHull() held.
 * Mutates member.x/z in place; returns true if it clamped anything.
 */
export function panicClamp(member, repulsor) {
  let clamped = false;
  for (const patch of repulsor.patchSet.patches) {
    if (!patch.planted) continue;
    patchToWorld(patch, repulsor.x, repulsor.z, repulsor.heading, _patchWorld);
    const dx = member.x - _patchWorld.x, dz = member.z - _patchWorld.z;
    const d2 = dx * dx + dz * dz;
    const r = patchRadius(patch);
    if (d2 >= r * r) continue;
    const d = Math.sqrt(d2) || 1e-4;
    const s = r / d;
    member.x = _patchWorld.x + dx * s;
    member.z = _patchWorld.z + dz * s;
    clamped = true;
  }
  return clamped;
}

function patchRadius(patch) {
  return patch.kind === 'track' ? Math.max(patch.halfWidth, patch.halfLength) : patch.r;
}
