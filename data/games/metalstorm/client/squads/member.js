// member.js — one visual squad member. Cosmetic kinematic state only.
// See PLAN-metalstorm-squads.md §8, §9.

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

    // Assigned formation slot index (stable so a member keeps its place).
    this.slot = id;
  }

  /**
   * Integrate one step toward a desired velocity (already steered/clamped).
   * Pure kinematics — never reads the wire. groundHeight via backend.
   */
  integrate(desiredVx, desiredVz, dt, backend) {
    // Critically-damped-ish blend toward desired velocity (no spring overshoot).
    const blend = Math.min(1, dt * 8);
    this.vx += (desiredVx - this.vx) * blend;
    this.vz += (desiredVz - this.vz) * blend;

    this.x += this.vx * dt;
    this.z += this.vz * dt;
    this.y = backend.groundHeight(this.x, this.z);

    const speed = Math.hypot(this.vx, this.vz);
    if (speed > 0.05) {
      this.headingY = Math.atan2(this.vx, this.vz); // face travel (RH, +Z fwd)
      this.gait = (this.gait + speed * dt * 0.1) % 1;
    }
  }
}
