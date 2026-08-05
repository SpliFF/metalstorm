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
  separationWeight: 1.4,         // overall separation gain vs arrival/leash
  arrivalWeight: 1.0,

  // --- Collision (PLAN-metalstorm-squad-collision.md) ---------------------

  // Two separation regimes (§2): same-squad members pack moderately tight
  // (over-strong separation fights slot arrival and makes the squad "boil");
  // other-squad/obstacle (repulsor, wreck, dense-cell aggregate) separation
  // is strong so crossing squads visibly part instead of interpenetrating.
  separationWeightSameSquad: 0.6,
  separationWeightOtherSquad: 1.6,

  // Deadband (§7): ignore a neighbour's separation contribution when its
  // overlap (radius - distance) is below this — ungates the boundary case
  // that otherwise causes boiling/jitter right at separationRadius.
  separationDeadband: 1.5,        // elmos

  // Spatial-hash cell size (§1): max(separationRadius, maxMemberFootprint) *
  // 1.5. maxMemberFootprint is the largest pseudo-member repulsor radius
  // expected to be registered (single units / scale-4 super-heavies, §5) —
  // keep it comfortably >= the biggest footprint an adapter will pass to
  // SquadManager.setRepulsor so the 3x3 neighbour query reliably reaches it.
  maxMemberFootprint: 48,         // elmos

  // Neighbour cap + dense-cell handling (§4) — the broad-phase performance
  // lever. K neighbours max per member; a bucket denser than
  // denseCellOccupancy collapses into one enlarged-radius aggregate repulsor
  // instead of N individual checks ("crowd -> fluid").
  neighbourCap: 8,
  denseCellOccupancy: 16,
  denseCellRadiusMul: 1.5,        // aggregate radius = cellSize * this

  // Fast neighbour broad-phase (PLAN-perf M10): numeric spatial-hash keys and
  // a reusable neighbour buffer, instead of "gx:gz" string keys and a
  // generator. Selects exactly the same neighbours — it is an allocation and
  // dispatch change, not a behaviour change — so this exists only as the
  // reversible in-session A/B switch Track P requires. Set false to restore
  // the original path.
  fastNeighbours: true,

  // Wrecks (§5): brief post-spawn presence in the avoidance hash so members
  // don't visibly clip through debris the instant it lands, then
  // permanently non-colliding (members may walk over old wreckage) — keeps
  // battlefields from becoming impassable client-only debris mazes.
  wreckCollisionRadius: 16,       // elmos
  wreckCollisionGraceSec: 2,

  // Casualty alignment (§8). A reported impact is a valid victim-selection hint
  // for this many seconds after it lands.
  impactHintWindowSec: 0.6,

  // Impact hint ring size (squad-casualties §4): keep the last N reported
  // impacts, not just one, so overlapping blasts within the hint window
  // both stay selectable instead of the newest silently evicting the last.
  impactHintRingSize: 4,

  // Attrition death stagger (squad-casualties §2): a batch of casualties
  // with no impact hint drips out over this per-death interval instead of
  // popping together, so it reads as a firefight rather than a bomb.
  staggerIntervalMinSec: 0.05,
  staggerIntervalMaxSec: 0.12,

  // Threat-bearing smoothing (squad-casualties §5): blend factor per
  // damage-bearing event toward the new source direction (0 = never move,
  // 1 = snap instantly) — keeps simultaneous multi-attacker fire from
  // whipping the bearing frame to frame.
  threatDirSmoothing: 0.5,

  // Re-pack surviving members toward central slots after losses (§9). Off by
  // default — gaps are acceptable and cheaper.
  repackOnCasualty: false,
  repackRatePerSec: 0.5,

  // Wreck budget (§11.5, squad-casualties §9). Cosmetic debris only: TTL +
  // fade window before despawn, capped per-squad and globally (a manager-
  // level pool, not per-squad state) so a long persistent game's memory
  // doesn't grow unbounded.
  wreckTtlSec: 25,
  wreckFadeSec: 3,
  maxWrecksPerSquad: 24,
  maxWrecksGlobal: 400,

  // LOD: below this on-screen size (px, supplied by adapter) skip steering and
  // render members at the centroid; far beyond, the adapter drops to an icon
  // (PLAN-macro-map.md tiers).
  steerMinScreenPx: 8,

  // Big-unit threading (PLAN-metalstorm-flow.md §4, task 3/4). Weight applied
  // to the accumulated big-unit push term alongside arrival/separation.
  bigUnitWeight: 1.6,
  // Hull repulsor influence zone as a multiple of the hull's circumscribed
  // radius (squad-collision.md §5's "one large repulsor circle").
  hullRepulseRadiusMul: 2.0,
  // Extra push strength directly ahead of a moving big unit's heading (the
  // bow-wave bias, flow.md §4).
  bowWaveBias: 1.5,
  // Contact-patch influence zone as a multiple of the patch's own radius,
  // for the soft steer-away while threading under a hull.
  patchRepulseRadiusMul: 2.5,
  // Speed multiplier applied to members while under a permeable hull —
  // mirrors the sim's ×2 traversal cost for underpass classes (flow.md §3)
  // so visuals and sim agree on how reluctant under-threading is.
  underHullSpeedPenalty: 0.5,
  // --- Cohesion (PLAN-metalstorm-squad-cohesion.md) -----------------------

  // Soft-leash gain: extra centripetal accel (world units/sec) per elmo a
  // member sits beyond its profile's softLeash*formationRadius (§1 layer 2).
  softLeashGain: 3.0,

  // Centroid teleport-guard threshold (elmos). MUST match
  // client/src/core/entity-interpolator.ts's TELEPORT_THRESHOLD_SQ (200) —
  // the two live in separate build trees (this module ships as native JS
  // inside data/games/metalstorm, the interpolator is bundled TS) so the
  // value is kept in sync by convention, not a shared import (§3).
  teleportThreshold: 200,

  // Turn handling (§5): cap how fast a slot's implied world position may
  // move frame-to-frame, and how sharp a heading swing before members bias
  // toward the trail instead of the raw (sweeping) slot.
  slotSpeedCapMul: 1.5,           // multiples of member maxSpeed
  turnTrailBiasRateThreshold: 1.0, // rad/s of squad heading change

  // Re-pack (§4, off by default — see repackOnCasualty above).
  repackSlotEpsilon: 0.5,          // elmos; snap when within this of target

  // --- Pathfinding (PLAN-metalstorm-squad-pathfinding.md) -----------------

  passabilityCellSize: 24,        // elmos per grid cell
  slotProjectionCap: 4,           // cells; spiral-search radius for nearestPassable

  // Breadcrumb trail: ring buffer of centroid samples, resampled by travel
  // distance (§4).
  trailMaxPoints: 64,
  trailSampleDist: 8,             // elmos between recorded samples

  // Member mode FORMATION<->COLUMN hysteresis (§4): consecutive
  // constrained/open frames required before switching.
  modeHysteresisFrames: 6,

  // Potential-field steering term (§5): lookahead + gradient sample distance,
  // and the weight it contributes to `_desired`.
  potentialFieldLookahead: 8,     // elmos
  potentialFieldSampleDist: 4,    // elmos
  potentialFieldWeight: 0.6,

  // Stuck detection + recovery ladder (§8), in consecutive frames.
  stuckFramesTrailBoost: 30,      // level 1: bias harder toward the trail
  stuckFramesIgnoreSeparation: 60,// level 2: also drop separation this member
  stuckFramesTeleport: 120,       // level 3: teleport-snap IF off-screen

  // --- Transport (PLAN-metalstorm-squad-transport.md) ---------------------

  // Boarding: cap how long members chase a (possibly moving) transport
  // before hard-hiding regardless of remaining distance (§7 pitfall — never
  // chase forever).
  transportBoardTimeSec: 4,

  // Unload settle window (§2): how long UNLOADING holds before flipping back
  // to FREE. Normal steering re-forms the spill during this window.
  transportUnloadSettleSec: 3,

  // Unload spill (§2): local-slot offset multiplier for the initial scatter
  // around the drop point; normal steering tightens it back to formation.
  transportSpillMul: 2.2,

  // Paradrop descent rate (§5), elmos/sec.
  paradropDescentRatePerSec: 40,

  // Heuristic fallback (§6, wire dependency): a hidden squad within this
  // radius of a known transport-capable unit is inferred LOADED. Replace
  // with explicit UnitLoaded/UnitUnloaded callins once streamed — fragile by
  // design.
  transportHeuristicRadius: 40,
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
