// formation.js — local-space slot templates + assignment. Pure functions.
// Slots are offsets in the squad's LOCAL frame (x = right, z = forward), scaled
// by formation_radius and rotated to the streamed heading at use time.
// See PLAN-metalstorm-squads.md §9.

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

// Single file down local Z (depth).
function column(n, r) {
  const out = [];
  const spacing = (2 * r) / Math.max(1, n);
  for (let i = 0; i < n; i++) out.push({ x: 0, z: r - i * spacing });
  return out;
}

// V / arrowhead: lead member forward, wings trailing.
function wedge(n, r) {
  const out = [{ x: 0, z: r }];
  let i = 1, depth = 1;
  while (i < n) {
    const off = depth * (r / Math.max(1, n / 2));
    out.push({ x: -off, z: r - off });
    if (i + 1 < n) out.push({ x: off, z: r - off });
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
 * Rotate a local slot into world space around a centroid.
 * headingY in radians; +Z is the unit's forward (RH, glTF-native).
 */
export function slotToWorld(slot, cx, cz, headingY, out) {
  const s = Math.sin(headingY), c = Math.cos(headingY);
  out.x = cx + (slot.x * c + slot.z * s);
  out.z = cz + (-slot.x * s + slot.z * c);
  return out;
}
