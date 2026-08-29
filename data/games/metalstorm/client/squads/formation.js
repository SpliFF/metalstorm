// formation.js — local-space slot templates + assignment. Pure functions.
// Slots are offsets in the squad's LOCAL frame, scaled by formation_radius and
// rotated to the streamed heading at use time.
// See PLAN-metalstorm-squads.md §9.
//
// CONVENTION (settled 2026-08-29). `slotToWorld` applies exactly the rotation
// `SquadRenderBackend.writeYawMatrix` applies to the mesh, and in that frame
// the unit's forward is local −Z (glTF-native; see the heading-convention note
// in steering.js). So in these templates −Z is AHEAD of the squad centre and
// +Z is behind it: `column`'s member 0 and `wedge`'s lead carry the most
// negative z, and the trailing ranks count up toward +z.
//
// This was wrong until now. The templates were authored against the older
// +Z-forward reading — the same mistake that made every squad member render
// 180° reversed (fixed in steering.js/member.js/soa-kernel.js) — so a column's
// lead sat at the REAR. That facing fix deliberately left the slot geometry
// alone, because re-signing the z offsets moves every member and the resulting
// trajectories shift `squad-soa-parity.test.js`'s hand-tuned f32 OO-vs-SoA
// residual bars. Done here as its own change, with the parity harness
// re-baselined against a re-measured residual (see that file's re-baseline
// note) rather than by widening a tolerance.
//
// The change was exactly a mirror: `column` and `wedge` slot z negated,
// nothing else. `line` sits at z 0 and `blob` is a disc with no forward
// semantics, so neither moves — pinned by `heading-convention.test.js`.

/**
 * Generate `count` local slot offsets for a formation type.
 * @returns {{x:number, z:number}[]}
 */
export function buildSlots(type, count, radius) {
  switch (type) {
    case 'column': return column(count, radius);
    case 'wedge':  return wedge(count, radius);
    case 'blob':   return blob(count, radius);
    case 'line':
    default:       return line(count, radius);
  }
}

// Side-by-side across local X, centered on 0.
function line(n, r) {
  const out = [];
  const span = Math.max(1, n - 1);
  const spacing = (2 * r) / Math.max(1, span);
  for (let i = 0; i < n; i++) out.push({ x: -r + i * spacing, z: 0 });
  return out;
}

// Single file down local Z (depth), lead member FIRST: member 0 takes the most
// forward slot (−r) and each subsequent member falls in behind it toward +z.
function column(n, r) {
  const out = [];
  const spacing = (2 * r) / Math.max(1, n);
  for (let i = 0; i < n; i++) out.push({ x: 0, z: -r + i * spacing });
  return out;
}

// V / arrowhead: lead member forward (−z), wings trailing back toward +z.
function wedge(n, r) {
  const out = [{ x: 0, z: -r }];
  let i = 1, depth = 1;
  while (i < n) {
    const off = depth * (r / Math.max(1, n / 2));
    out.push({ x: -off, z: off - r });
    if (i + 1 < n) out.push({ x: off, z: off - r });
    i += 2; depth++;
  }
  return out.slice(0, n);
}

// Jittered concentric rings filling a disc (deterministic by index so a member
// keeps its slot frame to frame).
function blob(n, r) {
  const out = [{ x: 0, z: 0 }];
  let placed = 1, ring = 1;
  while (placed < n) {
    const perRing = Math.min(n - placed, Math.max(4, Math.floor(ring * 5)));
    const rr = (ring / Math.ceil(Math.sqrt(n))) * r;
    for (let k = 0; k < perRing; k++) {
      const a = (k / perRing) * Math.PI * 2 + ring * 0.6;
      out.push({ x: Math.cos(a) * rr, z: Math.sin(a) * rr });
    }
    placed += perRing; ring++;
  }
  return out.slice(0, n);
}

/**
 * Rotate a local slot into world space around a centroid. This is the SAME
 * rotation the renderer applies to the mesh, so a slot and the hull drawn on
 * it always agree. headingY in radians; forward is local −Z (RH, glTF-native),
 * matching the templates above.
 */
export function slotToWorld(slot, cx, cz, headingY, out) {
  const s = Math.sin(headingY), c = Math.cos(headingY);
  out.x = cx + (slot.x * c + slot.z * s);
  out.z = cz + (-slot.x * s + slot.z * c);
  return out;
}
