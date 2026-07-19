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

import { DEFAULT_CONFIG } from './config.js';

export const MOVEMENT_PROFILES = {
  // key: ms_class from unit customparams (units/_builder.lua)
  soldiers:  { steerer: 'ground', softLeash: 1.0, moveClass: 'INFANTRY' },
  engineers: { steerer: 'ground', softLeash: 1.0, moveClass: 'INFANTRY' },
  mechs:     { steerer: 'ground', softLeash: 1.1, moveClass: 'HEAVY' },
  tanks:     { steerer: 'ground', softLeash: 1.2, moveClass: 'VEH' },
  artillery: { steerer: 'ground', softLeash: 1.2, moveClass: 'VEH' },
  civilians: { steerer: 'ground', softLeash: 1.4, moveClass: 'INFANTRY' },

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
    turnRateCap: 0.5,
    cruiseSpeedMul: 1.0,
    arrivalRadiusMul: 4,     // × cfg.arrivalRadius — ships ease in over a wide radius
    columnBias: 0.6,         // 0..1 blend toward the trail-ahead point in transit
  },
  subs: {
    steerer: 'naval', softLeash: 1.8, moveClass: 'SUB',
    turnRateCap: 0.5,
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
