// movement-profiles.js — per-movement-class steering profiles. STUB.
//
// DECISION (recorded in PLAN-metalstorm-structure.md): the cohesion plan
// left profiles "in config.js (or a movement-profiles.js)" — this file is
// the canonical home, keyed by ms_class, so config.js stays global tunables
// only. Ground uses the default steering.js path; air/naval delegate to
// their strategy modules (air-cohesion.js / naval-cohesion.js).
//
// See PLAN-metalstorm-squad-cohesion.md §(profiles), PLAN-metalstorm.md §5
// (11 classes × 4 scales).
//
// `moveClass` mirrors gamedata/moveinfo.tdf's CLASS.name (INFANTRY/VEH/HEAVY/
// SHIP/SUB) for passability queries (PLAN-metalstorm-squad-pathfinding.md
// §2). INTERIM BRIDGE: the sim's `movementclass` UnitDef field isn't
// currently streamed to the client (only customparams are); this table
// hand-maps ms_class -> moveClass to match units/*.lua's actual
// `movementclass = ...` assignments. Revisit if movementclass is ever wired
// onto the wire — this mapping would then be redundant with the real value.
// `null` moveClass (air) means "ignore the passability grid entirely" (§6).

// ── Turn rates (unit-motion M1, USER-REPORTED 2026-08-29) ──────────────────
//
// `turnRateCap` (rad/s) and `arcCoupling` (0..1) are read by the GROUND path
// (soa-kernel `stepGroundSquad` / squad.js `_groundStep`, both through
// steering.js `turnToward`) as well as by air/naval, which have capped since
// cohesion §6/§7. Before M1 the ground path had no cap at all: every member
// wrote `headingFromVelocity(vx, vz)` straight into its heading each frame, so
// hulls were a read-out of the steering vector and "spun on the spot and
// flipped direction in milliseconds".
//
// `arcCoupling` is the non-holonomic dial, applied only while a member is
// actually rate-limited: 1 means the hull can only travel where it points, so
// a course change traces a circle of radius `speed / turnRateCap` instead of a
// pivot. 0 leaves the path untouched and only lags the hull — correct for
// people, who really do sidestep, and wrong for tracked vehicles, which do not.
//
// The radii below are MEASURED, not asserted: member speed is
// `def.maxSpeed × cfg.memberSpeedMultiplier` (1.25) in elmos/s, R = v / cap in
// elmos, and 8 elmos = 1 m since the 2026-08-27 world-scale re-import. Hull
// lengths are the shipped models' glTF Z extents.
//
//   soldiers  s1  v 52.5   cap 3.0   R   17.5 e =  2.2 m   (body 0.66 m)
//   tanks     s2  v 93.75  cap 1.0   R   93.8 e = 11.7 m   (hull 9.0 m, 1.3 L)
//   artillery s2  v 44.6   cap 0.7   R   63.7 e =  8.0 m
//   ships     s3  v 75     cap 0.16  R  469   e = 58.6 m   (hull 55 m, 1.07 L)
//   subs      s3  v 82.5   cap 0.18  R  458   e = 57.3 m   (hull 45 m, 1.27 L)
//
// KNOWN LIMIT, stated rather than hidden: this table is keyed by ms_class, so
// all four SCALES of a class share one cap while their speeds and hull lengths
// differ by ~4x. The cap is chosen for the class's heavy end, which leaves the
// s1 hulls of a class turning a little wider than their length wants. Per-scale
// caps need a per-scale key (or a cap derived from `def.formationRadius`, the
// only size-correlated field on the wire) and are deliberately NOT done here.
//
// `Infinity` is the null control the bench arm leans on (turn-slew.bench.ts):
// `turnToward` with an infinite cap returns the uncapped heading and copies the
// velocity through, i.e. bit-for-bit pre-M1 behaviour with the call compiled in.

import { DEFAULT_CONFIG } from './config.js';

export const MOVEMENT_PROFILES = {
  // key: ms_class from unit customparams (units/_builder.lua)
  soldiers:  { steerer: 'ground', softLeash: 1.0, moveClass: 'INFANTRY',
                turnRateCap: 3.0, arcCoupling: 0 },
  engineers: { steerer: 'ground', softLeash: 1.0, moveClass: 'INFANTRY',
                turnRateCap: 3.0, arcCoupling: 0 },
  mechs:     { steerer: 'ground', softLeash: 1.1, moveClass: 'HEAVY',
                turnRateCap: 1.4, arcCoupling: 0.35 },
  tanks:     { steerer: 'ground', softLeash: 1.2, moveClass: 'VEH',
                turnRateCap: 1.0, arcCoupling: 1 },
  artillery: { steerer: 'ground', softLeash: 1.2, moveClass: 'VEH',
                turnRateCap: 0.7, arcCoupling: 1 },
  civilians: { steerer: 'ground', softLeash: 1.4, moveClass: 'INFANTRY',
                turnRateCap: 2.4, arcCoupling: 0 },

  // air-cohesion.js: constant forward flight, turn-rate-capped pursuit,
  // loiter/orbit when the squad holds, banking + altitude bands (§6).
  fighters:  {
    steerer: 'air', softLeash: 2.5, moveClass: null,
    turnRateCap: 1.4,        // rad/s
    cruiseSpeedMul: 1.0,
    loiterSpeedEpsilon: 0.3, // squad ground-speed below which the squad "holds"
    bankMax: 0.6,            // radians, visual roll channel
    cruiseAltitude: 90,      // elmos above squad centroid Y
    altitudeBandStep: 12,    // elmos between member altitude bands
    altitudeCatchUpRate: 1.5,
  },
  bombers:   {
    steerer: 'air', softLeash: 2.5, moveClass: null,
    turnRateCap: 0.9,
    cruiseSpeedMul: 0.9,
    loiterSpeedEpsilon: 0.3,
    bankMax: 0.35,
    cruiseAltitude: 120,
    altitudeBandStep: 14,
    altitudeCatchUpRate: 1.2,
  },

  // naval-cohesion.js: capped-turn arrival (can slow/stop, unlike air),
  // column-formation bias in transit, sub depth channel (§7).
  ships: {
    steerer: 'naval', softLeash: 1.8, moveClass: 'SHIP',
    // 0.5 was a pirouette after the world-scale re-import: at s3's 75 e/s it
    // put a 55 m cruiser on a 18.75 m radius, 0.34 of its own length. 0.16
    // buys 1.07 hull lengths. See the turn-rate note above.
    turnRateCap: 0.16, arcCoupling: 1,
    cruiseSpeedMul: 1.0,
    arrivalRadiusMul: 4,     // × cfg.arrivalRadius — ships ease in over a wide radius
    columnBias: 0.6,         // 0..1 blend toward the trail-ahead point in transit
  },
  subs: {
    steerer: 'naval', softLeash: 1.8, moveClass: 'SUB',
    turnRateCap: 0.18, arcCoupling: 1,   // 1.27 hull lengths at s3
    cruiseSpeedMul: 1.0,
    arrivalRadiusMul: 4,
    columnBias: 0.6,
    subDepth: -8,            // cosmetic dive offset (elmos); surfacing is a future hook
  },
  // staticdefense / radar / buildings don't move.
};

export function profileFor(msClass) {
  return MOVEMENT_PROFILES[msClass] ?? MOVEMENT_PROFILES.soldiers;
}
