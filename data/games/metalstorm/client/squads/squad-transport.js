// squad-transport.js — pure helpers for the transport visual state machine
// (PLAN-metalstorm-squad-transport.md §2, §5). Squad owns the state machine
// itself (transportState + timers, squad.js); this module holds the couple
// of pieces worth pinning down/testing in isolation: drop-point passability
// projection and paradrop descent stepping, mirroring how air-cohesion.js/
// naval-cohesion.js hold the profile-specific step math while Squad drives
// the orchestration.

/** Project a sim-authoritative unload point onto the nearest passable cell
 *  for this squad's move class (§5 pitfall — paradrop onto a cliff/water).
 *  No-op (returns {x,z} unchanged) if no passability grid or move class is
 *  available — mirrors Squad's own slot-projection fallback (cohesion §3);
 *  air squads (no moveClass) are never projected, matching cohesion §6. */
export function projectDropPoint(x, z, passability, moveClass, cap) {
  if (!passability || !moveClass) return { x, z };
  return passability.nearestPassable(x, z, moveClass, cap);
}

/** One descent step toward `groundY` at `ratePerSec` elmos/sec (§5 —
 *  paradrop/parachute cosmetic fall). Mutates `m.y` in place. Returns true
 *  once landed (within a small epsilon), clamping so a large `dt` near
 *  landing can't sink the member below ground. */
export function descendStep(m, groundY, ratePerSec, dt) {
  if (m.y - groundY <= 0.05) { m.y = groundY; return true; }
  m.y = Math.max(groundY, m.y - ratePerSec * dt);
  return m.y <= groundY + 0.05;
}

/** Inflate a formation slot outward for the unload "spill" (§2 UNLOADING —
 *  members scatter around the drop point before normal steering tightens
 *  them back to formation). A zero-offset slot (e.g. blob's centre member)
 *  gets a deterministic golden-angle fallback direction, keyed by member id,
 *  so it doesn't spill exactly on top of the drop point every time. */
export function scatterSlot(slot, scatterMul, memberId) {
  const len = Math.hypot(slot.x, slot.z);
  if (len < 1e-4) {
    const a = memberId * 2.399963; // golden angle — spreads ids apart
    return { x: Math.cos(a) * scatterMul, z: Math.sin(a) * scatterMul };
  }
  return { x: slot.x * scatterMul, z: slot.z * scatterMul };
}
