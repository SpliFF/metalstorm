// config.js — squad-system tunables + the strength→count curve.
// Pure data/functions, no imports. See PLAN-metalstorm-squads.md §7, §11.

export const DEFAULT_CONFIG = {
  // Cohesion: a member further than this from the squad centroid is hard-pulled
  // back (guarantees the squad reads as one body / "transports together", §9).
  maxMemberDistance: 1.6,        // multiples of formation_radius

  // Steering (§9). Member top speed is a touch above squad speed so stragglers
  // catch up; values are in world units/sec, scaled by squad speed at runtime.
  memberSpeedMultiplier: 1.25,
  arrivalRadius: 12,             // elmos: ease-in distance to a slot
  separationRadius: 14,          // elmos: push apart below this member spacing
  separationWeight: 1.4,
  arrivalWeight: 1.0,

  // Casualty alignment (§8). A reported impact is a valid victim-selection hint
  // for this many seconds after it lands.
  impactHintWindowSec: 0.6,

  // Re-pack surviving members toward central slots after losses (§9). Off by
  // default — gaps are acceptable and cheaper.
  repackOnCasualty: false,
  repackRatePerSec: 0.5,

  // Wreck budget (§11.5). Cosmetic debris only.
  wreckTtlSec: 25,
  maxWrecksPerSquad: 24,

  // LOD: below this on-screen size (px, supplied by adapter) skip steering and
  // render members at the centroid; far beyond, the adapter drops to an icon
  // (PLAN-macro-map.md tiers).
  steerMinScreenPx: 8,
};

// THE routing predicate — canonical single home (PLAN-metalstorm-structure.md
// D8; demanded by squads routing, squad-sync §4 H3, squad-scale4 §8). A def
// renders via squad fan-out iff squad_size > 1; squad_size 1 (incl. scale-4
// multi-piece and civilian vehicles) renders as a single unit. Universal —
// no civilian/military special case (PLAN-metalstorm.md §7).
export function isSquadDef(def) {
  return (Number(def?.customParams?.squad_size) || 1) > 1;
}

// Strength → live member count.
// f = health / maxHealth in [0,1]; size = nominal roster. Returns an integer in
// [0, size]; callers clamp monotonic-down so it never resurrects (no heal, §4).
// Default is linear-with-floor: a living squad keeps at least one member until
// the sim unit itself dies (f reaches 0 only on death).
export function linearCount(f, size) {
  if (f <= 0) return 0;
  return Math.max(1, Math.round(size * f));
}

// Alternative dramatic curve: fight near-full, then collapse (§11.1). Unused by
// default; swap via config.countCurve.
export function collapseCount(f, size) {
  if (f <= 0) return 0;
  const shaped = f * f * (3 - 2 * f); // smoothstep
  return Math.max(1, Math.round(size * shaped));
}
