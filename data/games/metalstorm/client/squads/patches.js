// patches.js — animated ground-contact patches (PLAN-metalstorm-flow.md task 2).
//
// Derives the patch set (feet / track strips) for big units from their
// footprint profile (gamedata/footprints.lua, exported to the client — flow
// F1, NOT YET LANDED) + gait phase, with planted/lifted windows so smaller
// units can flow around/UNDER the footprint. Gait phase is meant to be
// shared with the fx-offload animation path (PLAN-fx-offload.md §4) once
// that lands (X4, currently un-started) — until then this module accumulates
// its own phase locally from (dt, speed) using the same formula member.js
// already uses for its own gait, so the two stay visually consistent without
// a real shared-state wire. Flagging this explicitly per AGENTS.md: this is
// a deliberate, temporary divergence, not a silent one.
//
// footprint_profile shape (PLAN-metalstorm-flow.md §1 — mocked by callers
// until F1 lands; see squads/squads-flow.test.js and the acceptance scene
// for the fixtures used):
//   {
//     hull: { x, z },              // outer sim footprint, elmos
//     clearance,                   // ground clearance of the hull, elmos
//     underpass: ["INFANTRY"],     // move classes permitted underneath
//     contacts: [
//       { kind: 'foot', x, z, r, gait: { phase, duty } },
//       { kind: 'track', x, z, halfWidth, halfLength },  // always planted
//     ],
//   }
//
// Pure logic; the render backend draws the patches (thin instances). No
// allocation in update() beyond what's returned — callers own the patches
// array (same instances reused every frame, planted flag flipped in place).

// Distance-accumulated phase-per-speed constant, kept in lockstep with
// member.js's `gait = (gait + speed * dt * GAIT_SPEED_SCALE) % 1`.
const GAIT_SPEED_SCALE = 0.1;

/**
 * @param {object} footprintProfile see module header
 */
export function createPatchSet(footprintProfile) {
  const contacts = footprintProfile.contacts;
  const patches = contacts.map((c) => ({
    kind: c.kind,
    x: c.x,
    z: c.z,
    r: c.r,
    halfWidth: c.halfWidth,
    halfLength: c.halfLength,
    planted: c.kind === 'track', // track strips are always in contact
  }));
  let phase = 0;

  return {
    /** Advance gait phase by (dt, speed); updates planted/lifted state in place. */
    update(dt, speed) {
      phase = (phase + speed * dt * GAIT_SPEED_SCALE) % 1;
      for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        if (c.kind === 'track') continue; // constant, set at construction
        patches[i].planted = isPlanted(phase, c.gait);
      }
      return patches;
    },

    get phase() { return phase; },
    get patches() { return patches; },
  };
}

/** Is a `foot` contact planted at the given big-unit gait phase? */
function isPlanted(phase, gait) {
  const local = (phase + gait.phase) % 1;
  return local < gait.duty;
}

/**
 * Rotate a local-space patch into world space around a big unit's pose.
 * headingY in radians; the unit's forward is local −Z (RH, glTF-native —
 * same convention as formation.js's slotToWorld and the renderer's
 * writeYawMatrix; see the heading-convention note in steering.js).
 *
 * NOTE (2026-08-29): the big-unit PATCH TEMPLATES themselves are still
 * authored +z-forward and were NOT re-signed with the formation slots — a
 * separate, unfixed instance of the same convention error. It biases hull
 * repulsion toward a big unit's rear instead of its bow; cosmetically
 * invisible, so it is left for a flow-tuning pass that can re-verify the
 * repulsor behaviour rather than just the geometry.
 */
export function patchToWorld(patch, cx, cz, headingY, out) {
  const s = Math.sin(headingY), c = Math.cos(headingY);
  out.x = cx + (patch.x * c + patch.z * s);
  out.z = cz + (-patch.x * s + patch.z * c);
  return out;
}
