// member-spacing.test.js — unit-motion M2, USER-REPORTED 2026-08-29:
// "units visually overlap each other, within squads and between them."
//
// Three things are pinned here, in the order they matter:
//
//  1. the slot-packing floor (formation.js) — the primary fix. Members stopped
//     interpenetrating because their SLOTS moved apart, not because a steering
//     term got stronger;
//  2. the separation falloff's scale-invariance (steering.js / soa-kernel.js) —
//     the reason widening a radius used to buy nothing;
//  3. that a def which declares no `member_clearance` still gets bit-for-bit
//     the pre-M2 geometry. That is the null control the bench arm leans on and
//     the guarantee that this cannot silently move a third-party def.
//
// Both engines are driven where the behaviour is per-squad: `squad-soa-parity`
// compares them against each other, but it would happily pass with BOTH of
// them wrong, so the absolute spacing claim is asserted on each.

import { describe, it, expect } from 'vitest';
import { Squad } from './squad.js';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';
import { DEFAULT_CONFIG, linearCount, memberClearance } from './config.js';
import { buildSlots, slotSpacingPerRadius, packedFormationRadius } from './formation.js';
import { separate } from './steering.js';

function makeCfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, countCurve: linearCount, engine: 'oo', ...overrides };
}

/** A tanks-s1 squad as `_builder.lua` now emits it: 8 members, wedge, the
 *  authored radius 24 that predates the world-scale re-import, and a 4.5 m
 *  hull's clearance (18 elmos) that postdates it. */
function tanksS1(overrides = {}) {
  return {
    defId: 'ms_tanks_s1',
    squadSize: 8,
    formationType: 'wedge',
    formationRadius: 24,
    maxSpeed: 60,
    customParams: { ms_class: 'tanks', member_clearance: '18' },
    ...overrides,
  };
}

function minPairDistance(points) {
  let min = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z);
      if (d < min) min = d;
    }
  }
  return min;
}

describe('slot spacing per unit radius (formation.js)', () => {
  it('is the exact analytic spacing of each template, so a radius can be solved for directly', () => {
    // line spreads n members across 2r  -> 2/(n-1) per unit radius
    expect(slotSpacingPerRadius('line', 16)).toBeCloseTo(2 / 15, 10);
    expect(slotSpacingPerRadius('line', 2)).toBeCloseTo(2, 10);
    // column files n members down 2r    -> 2/n
    expect(slotSpacingPerRadius('column', 4)).toBeCloseTo(0.5, 10);
    // wedge steps r/(n/2) in BOTH axes  -> 2*sqrt(2)/n
    expect(slotSpacingPerRadius('wedge', 8)).toBeCloseTo(2 * Math.SQRT2 / 8, 10);
  });

  it('is 0 for a formation with nothing to separate', () => {
    expect(slotSpacingPerRadius('line', 1)).toBe(0);
    expect(slotSpacingPerRadius('blob', 0)).toBe(0);
  });

  it('rebuilding at the solved radius actually delivers the requested spacing', () => {
    for (const type of ['line', 'column', 'wedge', 'blob']) {
      for (const n of [2, 4, 8, 16]) {
        const want = 37;
        const r = packedFormationRadius(type, n, 0, want);
        expect(minPairDistance(buildSlots(type, n, r))).toBeGreaterThanOrEqual(want - 1e-6);
      }
    }
  });
});

describe('the packing floor never shrinks a formation', () => {
  it('keeps an authored radius that is already generous enough', () => {
    // 8 members, wedge: spacing/radius is 0.354, so radius 400 already spaces
    // them 141 apart — far past the 41 that a 4.5 m hull asks for.
    expect(packedFormationRadius('wedge', 8, 400, 41)).toBe(400);
  });

  it('returns the authored radius UNTOUCHED when no clearance is declared (the null control)', () => {
    expect(packedFormationRadius('wedge', 8, 24, 0)).toBe(24);
    expect(packedFormationRadius('wedge', 8, 24, -5)).toBe(24);
    expect(memberClearance({ customParams: {} })).toBe(0);
    expect(memberClearance({ customParams: { member_clearance: 'nonsense' } })).toBe(0);
    expect(memberClearance({ customParams: { member_clearance: '18' } })).toBe(18);
  });
});

describe('a squad built from a def that declares its footprint does not stack its members', () => {
  // The defect, stated as a number: at the authored radius 24 a wedge of 8 puts
  // its members 8.5 elmos apart, and a tanks-s1 hull is 36 elmos long. Every
  // member was inside the next one before the squad took a step.
  it('OO: no two slots are closer than two hulls', () => {
    const cfg = makeCfg();
    const def = tanksS1();
    const sq = new Squad(1, def, new NullRenderBackend(), cfg);
    const clearance = Number(def.customParams.member_clearance);
    expect(minPairDistance(sq.slots)).toBeGreaterThanOrEqual(2 * clearance - 1e-6);
    expect(sq.formationRadius).toBeGreaterThan(def.formationRadius);
  });

  it('SoA: the same def yields the same packed radius (the two constructors must not drift)', () => {
    const backend = new NullRenderBackend();
    const def = tanksS1();
    const oo = new Squad(1, def, backend, makeCfg({ engine: 'oo' }));
    const mgr = new SquadManager(backend, { engine: 'soa', countCurve: linearCount });
    mgr.syncSquad(1, { x: 0, y: 0, z: 0, heading: 0, health: 1, maxHealth: 1 }, def);
    mgr.update(1 / 60);
    const soa = mgr.squads.get(1);
    expect(soa.formationRadius).toBeCloseTo(oo.formationRadius, 6);
    expect(soa.separationRadius).toBeCloseTo(oo.separationRadius, 6);
    const slots = [];
    for (let i = 0; i < soa.size; i++) slots.push({ x: soa.slotsX[i], z: soa.slotsZ[i] });
    expect(minPairDistance(slots)).toBeGreaterThanOrEqual(2 * 18 - 1e-6);
  });

  it('members settled on those slots really are two hulls apart at rest', () => {
    const cfg = makeCfg();
    const sq = new Squad(1, tanksS1(), new NullRenderBackend(), cfg);
    sq.setPose(1000, 0, 1000, 0);
    for (let i = 0; i < 400; i++) sq.update(1 / 30, i / 30, () => []);
    const live = sq.members.map((m) => ({ x: m.x, z: m.z }));
    expect(minPairDistance(live)).toBeGreaterThan(2 * 18 * 0.9);
  });

  it('the pre-M2 def (no clearance) still stacks them — this is the defect, kept as the control', () => {
    const cfg = makeCfg();
    const def = tanksS1({ customParams: { ms_class: 'tanks' } });
    const sq = new Squad(1, def, new NullRenderBackend(), cfg);
    expect(sq.formationRadius).toBe(24);
    expect(minPairDistance(sq.slots)).toBeLessThan(2 * 18);   // hulls interpenetrate
  });
});

describe('separation radius is sized to the hull, and clamped to what the grid can actually see', () => {
  it('scales with the declared clearance', () => {
    const cfg = makeCfg();
    const sq = new Squad(1, tanksS1(), new NullRenderBackend(), cfg);
    expect(sq.separationRadius).toBeCloseTo(18 * cfg.separationClearanceMul, 6);
  });

  it('never exceeds the spatial hash\'s guaranteed 3x3 reach', () => {
    const cfg = makeCfg();
    // A ships-s1 member is a 20 m boat: clearance 80 elmos wants a 176-elmo
    // separation radius, which the 3x3 query could never deliver.
    const sq = new Squad(1, tanksS1({ customParams: { ms_class: 'ships', member_clearance: '80' } }),
      new NullRenderBackend(), cfg);
    expect(sq.separationRadius).toBe(cfg.separationRadiusMax);
  });

  it('separationRadiusMax IS the grid cell size — pinned so the two cannot drift apart', () => {
    // squad-manager.js `_cell` and soa-grid.js `createGrid` both use this
    // formula; a neighbour further than one cell is invisible to the 3x3 scan.
    const mgr = new SquadManager(new NullRenderBackend());
    expect(DEFAULT_CONFIG.separationRadiusMax).toBe(mgr._cell);
    expect(mgr._cell).toBe(
      Math.max(DEFAULT_CONFIG.separationRadius, DEFAULT_CONFIG.maxMemberFootprint) * 1.5);
  });

  it('falls back to the flat radius for a def that declares nothing', () => {
    const cfg = makeCfg();
    const sq = new Squad(1, tanksS1({ customParams: {} }), new NullRenderBackend(), cfg);
    expect(sq.separationRadius).toBe(cfg.separationRadius);
  });
});

describe('separation falloff is scale-invariant (the reason a wider radius now buys something)', () => {
  const out = { x: 0, z: 0 };
  const at = (d, r) => {
    separate(0, 0, 1, [{ x: d, z: 0, squadId: 1, radius: r }], r, 1, 1, 0, out);
    return Math.hypot(out.x, out.z);
  };

  it('contributes exactly 1 at half the separation radius, whatever the radius is', () => {
    for (const r of [14, 40, 72, 400]) expect(at(r / 2, r)).toBeCloseTo(1, 9);
  });

  it('is 0 at the boundary and grows monotonically toward contact', () => {
    const r = 60;
    expect(at(r, r)).toBe(0);                       // outside: not a neighbour at all
    expect(at(r * 0.999, r)).toBeLessThan(0.01);
    expect(at(r * 0.25, r)).toBeGreaterThan(at(r * 0.5, r));
    expect(at(r * 0.5, r)).toBeGreaterThan(at(r * 0.75, r));
  });

  it('the old 1/d kernel was NOT scale-invariant — same geometry, 5x weaker at 5x the radius', () => {
    // Kept as an executable statement of the bug: 1/d at half-radius is 2/r, so
    // widening the radius WEAKENED the force at the equivalent relative
    // distance. That is why the shipped 14-elmo radius could never open a gap.
    const legacy = (d) => 1 / d;
    expect(legacy(14 / 2) / legacy(72 / 2)).toBeCloseTo(72 / 14, 6);
    expect(at(14 / 2, 14)).toBeCloseTo(at(72 / 2, 72), 9);
  });
});

describe('two squads crossing the same ground', () => {
  // Census question 3 for the CLIENT half: given two squads whose sim centroids
  // pass close, do their drawn members part? Pre-M2 they did not — the term was
  // worth ~0.06 of a member's top speed at contact range.
  function crossingMinDistance(cfgOverrides, defOverrides) {
    const backend = new NullRenderBackend();
    const mgr = new SquadManager(backend, { engine: 'soa', countCurve: linearCount, ...cfgOverrides });
    const def = tanksS1(defOverrides);
    mgr.syncSquad(1, { x: -200, y: 0, z: 0, heading: 0, health: 1, maxHealth: 1 }, def);
    mgr.syncSquad(2, { x: 200, y: 0, z: 0, heading: Math.PI, health: 1, maxHealth: 1 }, def);
    let worst = Infinity;
    for (let f = 0; f < 240; f++) {
      const t = f / 240;
      // Drive the two sim centroids straight through each other.
      mgr.syncPose(1, { x: -200 + 400 * t, y: 0, z: 0, heading: 0 });
      mgr.syncPose(2, { x: 200 - 400 * t, y: 0, z: 0, heading: Math.PI });
      mgr.update(1 / 30);
      const a = mgr.squads.get(1), b = mgr.squads.get(2);
      if (t < 0.35 || t > 0.65) continue;            // measure through the pass
      for (let i = a.base; i < a.base + a.size; i++) {
        for (let j = b.base; j < b.base + b.size; j++) {
          const d = Math.hypot(mgr.store.mx[i] - mgr.store.mx[j], mgr.store.mz[i] - mgr.store.mz[j]);
          if (d < worst) worst = d;
        }
      }
    }
    return worst;
  }

  it('part further than they used to — measured against the pre-M2 def as the control', () => {
    const before = crossingMinDistance({}, { customParams: { ms_class: 'tanks' } });
    const after = crossingMinDistance({}, {});
    expect(after).toBeGreaterThan(before);
  });
});

// ── The M3 golden table ────────────────────────────────────────────────────
//
// unit-motion M3, the between-squad half of the same user report. The sim
// spaces one squad from the next by `separationDistance`, which `_builder.lua`
// derives from the extent the CLIENT draws the formation at — so the sim's
// idea of how much ground a squad covers is a Lua PORT of the templates above,
// and a silent drift between the two ports would put the units back inside
// each other with every test still green.
//
// This table is the pin. The same numbers are asserted from the Lua side in
// `LuaRules/Gadgets/tests/squad_extents_spec.lua`, computed by that port; here
// they are computed by formation.js. Editing a template means editing both
// ports and re-deriving this table — which is exactly the moment somebody
// should have to think about it.
const M3_SQUAD_EXTENTS = [
  // def,               type,     count, authoredRadius, clearance, outerRadius
  ['ms_tanks_s1',       'wedge',      8, 24,  18, 135],
  ['ms_tanks_s2',       'wedge',      4, 34,  34, 145],
  ['ms_tanks_s3',       'wedge',      2, 48,  48, 126],
  ['ms_soldiers_s1',    'line',      16, 24,   3,  55],
  ['ms_soldiers_s2',    'line',       8, 34,   3,  37],
  ['ms_artillery_s1',   'line',       8, 24,  18, 163],
  ['ms_artillery_s2',   'line',       4, 34,  30, 134],
  ['ms_mechs_s1',       'wedge',      8, 24,   7,  53],
  ['ms_engineers_s1',   'line',       8, 24,   3,  27],
  ['ms_civilians',      'blob',      12, 20,   3,  17],
  ['ms_ships_s1',       'column',     4, 24,  80, 448],
  ['ms_subs_s3',        'column',     2, 48, 180, 594],
];

/** The extent `_builder.lua`'s `squadOuterRadius` computes, in formation.js
 *  terms: the outer edge of the outermost member of the packed formation,
 *  measured from the squad's own position (which is where the sim unit is). */
function outerRadius(type, count, authoredRadius, clearance) {
  if (count < 2) return clearance;
  const r = packedFormationRadius(type, count, authoredRadius,
                                  clearance * 2 * DEFAULT_CONFIG.memberSpacingMul);
  let maxR = 0;
  for (const s of buildSlots(type, count, r)) maxR = Math.max(maxR, Math.hypot(s.x, s.z));
  return maxR + clearance;
}

describe('squad ground extent — the golden table the Lua port must reproduce', () => {
  for (const [def, type, count, authored, clearance, expected] of M3_SQUAD_EXTENTS) {
    it(`${def} covers ${expected} elmos of radius`, () => {
      expect(Math.round(outerRadius(type, count, authored, clearance))).toBe(expected);
    });
  }

  it('a single hull covers exactly its own clearance — no formation to measure', () => {
    expect(outerRadius('wedge', 1, 68, 104)).toBe(104);   // ms_tanks_s4
  });

  it('memberSpacingMul is the shared input, so a change there moves BOTH ports', () => {
    // The Lua port hard-codes 1.15 as MEMBER_SPACING_MUL with a pointer back
    // here. If this ever moves, the table above stops matching and both sides
    // have to be re-derived together — which is the intent.
    expect(DEFAULT_CONFIG.memberSpacingMul).toBe(1.15);
  });
});
