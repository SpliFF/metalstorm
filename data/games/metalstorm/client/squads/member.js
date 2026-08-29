// member.js — one visual squad member. Cosmetic kinematic state only.
// See PLAN-metalstorm-squads.md §8, §9.

import { headingFromVelocity, turnToward } from './steering.js';

/** Reusable {x,z} for `turnToward`'s re-pointed velocity — module scope so
 *  `integrate` allocates nothing (PLAN-perf M10). */
const _turned = { x: 0, z: 0 };

export class Member {
  constructor(id, visual) {
    this.id = id;
    this.visual = visual;     // MemberVisual
    this.handle = -1;         // render-backend handle (-1 while released/unspawned)
    this.alive = true;
    // Released for LOD (icon tier): instance freed, no wreck, still alive —
    // distinct from `alive=false` (permanently killed). See squad.js §5.
    this.released = false;

    // Kinematic state (world space).
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vz = 0;
    this.headingY = 0;
    this.gait = 0;            // 0..1 animation phase (distance-accumulated)
    // Altitude above the squad centroid, snapshotted when an AIR squad drops
    // to the `centroid` tier (PLAN-perf M20) — that tier has no ground sample
    // to rebuild a flyer's cruise height from. Unused by ground/naval.
    this.centroidDy = 0;

    // Assigned formation slot index (stable so a member keeps its place).
    this.slot = id;

    // Pathfinding (PLAN-metalstorm-squad-pathfinding.md §4): FORMATION
    // (slot-relative, default) vs COLUMN (trail-follow through chokepoints).
    // Hysteresis counter is private to Squad.update's mode-switch logic.
    this.mode = 'FORMATION';
    this._modeStreak = 0;

    // Stuck detection + recovery ladder (§8).
    this._stuckFrames = 0;
    this._lastTargetDistSq = Infinity;
    this.recoveryLevel = 0; // 0 normal, 1 trail-boost, 2 +ignore-separation, 3 teleport-eligible

    // Air/naval cosmetic channels (PLAN-metalstorm-squad-cohesion.md §6/§7).
    this.bank = 0;             // radians, visual roll (air)
    this.altitudeOffset = null; // elmos, banded per-member air separation; lazily assigned
    this.depth = 0;             // elmos, cosmetic sub dive offset

    // Re-pack glide (§4, cohesion): when a slot reassignment happens, blend
    // from the old slot's local offset to the new one over repackRatePerSec
    // instead of snapping.
    this._repackFromSlot = null;
    this._repackT = 1; // 1 = no in-flight repack
  }

  /**
   * Integrate one step toward a desired velocity (already steered/clamped).
   * Pure kinematics — never reads the wire. groundHeight via backend.
   * `blend` overrides the default damped approach (air/naval steerers
   * pre-apply their own turn-rate cap and pass blend=1 so the heading isn't
   * smoothed twice).
   *
   * `maxDelta`/`coupling` are the M1 bounded visual turn (see steering.js
   * `turnToward` and the turn-rate note in movement-profiles.js). The defaults
   * — an infinite cap — are exactly the pre-M1 behaviour, which is what the
   * naval and transport callers want: naval already capped its own heading
   * upstream and must not be capped twice, for the same reason it passes
   * blend=1. The SoA twin of this method is soa-kernel's `integrateGround`.
   */
  integrate(desiredVx, desiredVz, dt, backend, blend = Math.min(1, dt * 8),
            maxDelta = Infinity, coupling = 0) {
    this.vx += (desiredVx - this.vx) * blend;
    this.vz += (desiredVz - this.vz) * blend;

    const speed = Math.hypot(this.vx, this.vz);
    if (speed > 0.05) {
      // Turn FIRST, then travel: the arc-coupled velocity is what displaces
      // the member this step, which is what makes the path an arc rather than
      // a straight line with a lagging hull bolted on.
      this.headingY = turnToward(this.headingY, this.vx, this.vz, speed,
        maxDelta, coupling, _turned);
      this.vx = _turned.x; this.vz = _turned.z;
      this.gait = (this.gait + speed * dt * 0.1) % 1;
    }

    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y = backend.groundHeight(this.x, this.z);
  }

  /**
   * Air-specific integration (PLAN-metalstorm-squad-cohesion.md §6): Y is a
   * fixed cruise altitude, never ground-snapped, so this bypasses
   * `backend.groundHeight` entirely. `vx`/`vz` arrive already turn-rate-
   * capped at cruise speed (air-cohesion.js); `vy` is a proportional
   * altitude catch-up rate, not a physical vertical speed.
   */
  integrateAir(vx, vy, vz, dt) {
    this.vx = vx; this.vz = vz;
    this.x += vx * dt;
    this.z += vz * dt;
    this.y += vy * dt;

    const speed = Math.hypot(vx, vz);
    if (speed > 0.05) {
      this.headingY = headingFromVelocity(vx, vz);
      this.gait = (this.gait + speed * dt * 0.1) % 1;
    }
  }
}
