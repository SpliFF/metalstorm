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

import { DEFAULT_CONFIG } from './config.js';

export const MOVEMENT_PROFILES = {
  // key: ms_class from unit customparams (units/_builder.lua)
  soldiers:  { steerer: 'ground', softLeash: 1.0 },
  engineers: { steerer: 'ground', softLeash: 1.0 },
  mechs:     { steerer: 'ground', softLeash: 1.1 },
  tanks:     { steerer: 'ground', softLeash: 1.2 },
  artillery: { steerer: 'ground', softLeash: 1.2 },
  fighters:  { steerer: 'air',    softLeash: 2.5 },   // air-cohesion.js
  bombers:   { steerer: 'air',    softLeash: 2.5 },   // air-cohesion.js
  ships:     { steerer: 'naval',  softLeash: 1.8 },   // naval-cohesion.js
  subs:      { steerer: 'naval',  softLeash: 1.8 },   // naval-cohesion.js
  civilians: { steerer: 'ground', softLeash: 1.4 },
  // staticdefense / radar / buildings don't move.
};

export function profileFor(msClass) {
  return MOVEMENT_PROFILES[msClass] ?? MOVEMENT_PROFILES.soldiers;
}
