// squad-scale4.test.js — headless coverage for PLAN-metalstorm-squad-
// scale4.md task 6, covering ONLY what isn't already pinned down elsewhere:
//   - task 1 (isSquadDef routing) is already tested generically in
//     squad-sync.test.js (H3) — this file adds the builder's ACTUAL shape
//     (units/_builder.lua emits string '1'/'2', not numbers) as a targeted
//     regression case.
//   - task 4 (repulsor insertion) already has its own dedicated coverage in
//     squad-collision.test.js ("single-unit/scale-4 pseudo-member repulsor
//     (§5, shared insertion point with squad-scale4 task 4)") — not
//     duplicated here, just cross-referenced.
//   - task 5 (builder always emits squad_size=1 + multi_piece=1 for scale 4)
//     is verification-only against units/_builder.lua; confirmed by
//     inspection (no per-scale override ever replaces the `customparams`
//     table wholesale, so the scale-4 block at builder lines 74-77 always
//     wins) — not unit-testable from this JS-only test tree.
//   - task 2 (author/validate a scale-4 .glb) is an art-pipeline task, not
//     code — out of scope here; see the plan file's task list.

import { describe, it, expect } from 'vitest';
import { isSquadDef } from './config.js';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';

describe('isSquadDef against the builder\'s actual scale-4 shape (§8 task 1, cross-ref squad-sync H3)', () => {
  it('excludes a scale-4 def (squad_size stringified "1" by units/_builder.lua)', () => {
    expect(isSquadDef({ customParams: { squad_size: '1', multi_piece: '1' } })).toBe(false);
  });

  it('still routes a scale-3 def (squad_size "2", NOT multi-piece) through the squad system', () => {
    expect(isSquadDef({ customParams: { squad_size: '2' } })).toBe(true);
  });

  it('a lone non-multi-piece size-1 unit (e.g. a civilian vehicle) is also excluded — multi_piece only gates cosmetics', () => {
    expect(isSquadDef({ customParams: { squad_size: '1' } })).toBe(false);
  });
});

describe('a size-1 def never instantiates a Squad through the manager (§8 task 6)', () => {
  it('is the caller\'s responsibility per isSquadDef, not an internal SquadManager guard', () => {
    // SquadManager itself is routing-agnostic (index.js: "Only entities routed
    // by isSquadDef(def) ... go through this system at all" — enforced at the
    // call site, Stage 7). Document that explicitly: a manager asked to
    // activate a size-1 def still would construct a Squad (roster of 1) —
    // it's isSquadDef at the call site that must gate it, confirmed above.
    const mgr = new SquadManager(new NullRenderBackend());
    const scale4Def = {
      defId: 'ms_tanks_s4', squadSize: 1, formationType: 'line', formationRadius: 10,
      maxSpeed: 3, customParams: { squad_size: '1', multi_piece: '1' },
    };
    expect(isSquadDef(scale4Def)).toBe(false); // the real gate a caller must check
    const sq = mgr._activate(500, scale4Def, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 });
    expect(sq.size).toBe(1); // if a caller ever DID route it here by mistake, it'd be a no-op roster of 1
  });
});
