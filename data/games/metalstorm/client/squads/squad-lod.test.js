// squad-lod.test.js — the reduced-detail member budget (PLAN-perf M20).
//
// Two things are pinned here, and they are different in kind.
//
// 1. The `centroid` TIER ITSELF. M19 found the tier fully implemented, cheap,
//    and never driven — which meant nobody had ever looked at it on screen.
//    It wrote every member to the squad centroid *point*, so a demoted squad
//    would have collapsed into one stacked blob the instant a producer existed.
//    M20 wires that producer, so the tier now has to actually hold formation.
//    These tests are what stops that defect coming back.
//
// 2. The POLICY: nearest-first ranking under a cumulative member budget, with
//    hysteresis, an off switch that really restores the pre-M20 frame, and no
//    effect whatsoever on the sim-facing bookkeeping (aliveCount, instances) —
//    a perf tier that quietly killed members would measure wonderfully.

import { describe, it, expect } from 'vitest';
import { Squad } from './squad.js';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';

function makeCfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, countCurve: linearCount, ...overrides };
}

function makeDef(overrides = {}) {
  return {
    defId: 'lod_test',
    squadSize: 8,
    formationType: 'blob',
    formationRadius: 20,
    maxSpeed: 5,
    moveClass: 'INFANTRY',
    customParams: { squad_size: 8, ms_class: 'soldiers' },
    ...overrides,
  };
}

/** Backend with a real (non-flat) terrain sample, so "did the tier ground-snap
 *  its members?" is an observable question and not a tautology at y = 0. */
function makeBackend() {
  const writes = [];
  const backend = new NullRenderBackend();
  backend.groundHeight = (x, z) => x * 0.01 + z * 0.02;
  backend.updateMember = (handle, x, y, z, headingY, gait) =>
    writes.push({ handle, x, y, z, headingY, gait });
  backend.createMember = (() => { let h = 0; return () => ++h; })();
  return { backend, writes };
}

const NO_NEIGHBOURS = Object.assign(() => 0, { buf: [] });

describe('centroid tier — holds the formation, does not collapse it', () => {
  it('places members at their rotated slot offsets, not all at the centroid', () => {
    const { backend, writes } = makeBackend();
    const sq = new Squad(1, makeDef(), backend, makeCfg());
    sq.setPose(500, 0, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);   // spawns at `full`

    sq.lod = 'centroid';
    writes.length = 0;
    sq.update(1 / 30, 1 / 30, NO_NEIGHBOURS, null);

    expect(writes.length).toBe(sq.aliveCount);
    // THE regression this file exists for: distinct positions, spread over the
    // formation, never all stacked on the centroid.
    const unique = new Set(writes.map(w => `${w.x.toFixed(3)},${w.z.toFixed(3)}`));
    expect(unique.size).toBe(writes.length);
    const spread = Math.max(...writes.map(w => Math.hypot(w.x - 500, w.z - 500)));
    expect(spread).toBeGreaterThan(5);

    // And each member is at ITS OWN slot, to the elmo.
    for (const m of sq.members) {
      if (!m.alive || m.released) continue;
      const slot = sq.slots[m.slot];
      expect(m.x).toBeCloseTo(500 + slot.x, 6);
      expect(m.z).toBeCloseTo(500 + slot.z, 6);
    }
  });

  it('rotates the held formation with the squad heading', () => {
    const { backend } = makeBackend();
    const sq = new Squad(1, makeDef(), backend, makeCfg());
    sq.setPose(500, 0, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    sq.lod = 'centroid';

    sq.setPose(500, 0, 500, Math.PI / 2);
    sq.update(1 / 30, 1 / 30, NO_NEIGHBOURS, null);
    for (const m of sq.members) {
      if (!m.alive || m.released) continue;
      const slot = sq.slots[m.slot];
      // heading +90 deg: (x, z) -> (z, -x)
      expect(m.x).toBeCloseTo(500 + slot.z, 5);
      expect(m.z).toBeCloseTo(500 - slot.x, 5);
      expect(m.headingY).toBeCloseTo(Math.PI / 2, 6);
    }
  });

  it('ground-snaps held members instead of flattening them to the centroid Y', () => {
    const { backend } = makeBackend();
    const sq = new Squad(1, makeDef(), backend, makeCfg());
    sq.setPose(500, 999, 500, 0);   // deliberately absurd centroid Y
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    sq.lod = 'centroid';
    sq.update(1 / 30, 1 / 30, NO_NEIGHBOURS, null);

    for (const m of sq.members) {
      if (!m.alive || m.released) continue;
      expect(m.y).toBeCloseTo(backend.groundHeight(m.x, m.z), 6);
    }
    // Not one flat plane, because the terrain sample is not flat.
    const ys = new Set(sq.members.filter(m => m.alive).map(m => m.y.toFixed(4)));
    expect(ys.size).toBeGreaterThan(1);
  });

  it('keeps the walk cycle advancing while the squad is moving', () => {
    const { backend } = makeBackend();
    const sq = new Squad(1, makeDef(), backend, makeCfg());
    sq.setPose(500, 0, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    sq.lod = 'centroid';
    sq.update(1 / 30, 1 / 30, NO_NEIGHBOURS, null);

    const before = sq.members.filter(m => m.alive).map(m => m.gait);
    sq.setPose(503, 0, 500, 0);                       // 3 elmos of travel
    sq.update(1 / 30, 2 / 30, NO_NEIGHBOURS, null);
    const after = sq.members.filter(m => m.alive).map(m => m.gait);
    expect(after.some((g, i) => g !== before[i])).toBe(true);
  });

  it('holds an air squad at its snapshotted cruise offset, not on the ground', () => {
    const { backend } = makeBackend();
    const def = makeDef({ customParams: { squad_size: 8, ms_class: 'fighters' } });
    const sq = new Squad(1, def, backend, makeCfg());
    expect(sq.profile.steerer).toBe('air');
    sq.setPose(500, 100, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    for (const m of sq.members) m.y = 190;             // parked at cruise

    sq.lod = 'centroid';                               // snapshots dy = 90
    sq.setPose(500, 120, 500, 0);
    sq.update(1 / 30, 1 / 30, NO_NEIGHBOURS, null);
    for (const m of sq.members) {
      if (!m.alive || m.released) continue;
      expect(m.y).toBeCloseTo(210, 6);                 // 120 + 90, NOT ground
    }
  });

  it('leaves aliveCount and the render instances untouched across full<->centroid', () => {
    const { backend } = makeBackend();
    const sq = new Squad(1, makeDef(), backend, makeCfg());
    sq.setPose(500, 0, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    const alive = sq.aliveCount;
    const handles = sq.members.map(m => m.handle);

    sq.lod = 'centroid';
    sq.update(1 / 30, 1 / 30, NO_NEIGHBOURS, null);
    expect(sq.aliveCount).toBe(alive);
    expect(sq.members.map(m => m.handle)).toEqual(handles);
    expect(sq.members.every(m => !m.released)).toBe(true);

    sq.lod = 'full';
    sq.update(1 / 30, 2 / 30, NO_NEIGHBOURS, null);
    expect(sq.aliveCount).toBe(alive);
    expect(sq.members.map(m => m.handle)).toEqual(handles);
  });
});

/** N squads in a line receding from the origin, one per 100 elmos. */
function makeManager(count, cfgOverrides = {}) {
  const { backend } = makeBackend();
  const mgr = new SquadManager(backend, cfgOverrides);
  for (let i = 0; i < count; i++) {
    mgr.syncSquad(i + 1, { x: 0, y: 0, z: 100 * (i + 1), heading: 0, health: 65535, maxHealth: 65535 },
      makeDef());
  }
  return mgr;
}

describe('member budget — the producer M19 found missing', () => {
  it('is inert until the camera is fed, even with a budget set', () => {
    const mgr = makeManager(10, { lodFullMemberBudget: 8 });
    mgr.update(1 / 30);
    expect(mgr.lodStats.armed).toBe(false);
    expect([...mgr.squads.values()].every(sq => sq.lod === 'full')).toBe(true);
  });

  it('keeps the nearest squads at full and demotes the rest', () => {
    // 10 squads x 8 members = 80; a 24-member budget is the nearest 3.
    const mgr = makeManager(10, { lodFullMemberBudget: 24, lodMemberBudgetHysteresis: 0 });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);

    const tiers = [...mgr.squads.values()].map(sq => sq.lod);
    expect(tiers.slice(0, 3)).toEqual(['full', 'full', 'full']);
    expect(tiers.slice(3).every(t => t === 'centroid')).toBe(true);
    expect(mgr.lodStats).toMatchObject({
      armed: true, fullSquads: 3, fullMembers: 24, centroidSquads: 7, centroidMembers: 56,
    });
  });

  it('follows the camera: moving the view moves which squads are steered', () => {
    const mgr = makeManager(10, { lodFullMemberBudget: 16, lodMemberBudgetHysteresis: 0 });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    expect(mgr.squads.get(1).lod).toBe('full');
    expect(mgr.squads.get(10).lod).toBe('centroid');

    mgr.setViewPos(0, 0, 1000);              // now sitting on the far end
    mgr._lodNextAt = 0;                      // skip the cadence for the test
    mgr.update(1 / 30);
    expect(mgr.squads.get(10).lod).toBe('full');
    expect(mgr.squads.get(1).lod).toBe('centroid');
  });

  it('never demotes more than the budget requires', () => {
    const mgr = makeManager(10, { lodFullMemberBudget: 10_000 });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    expect(mgr.lodStats.centroidSquads).toBe(0);
    expect([...mgr.squads.values()].every(sq => sq.lod === 'full')).toBe(true);
  });

  it('setLodBudget(0) restores the pre-M20 frame — every squad steered again', () => {
    const mgr = makeManager(10, { lodFullMemberBudget: 24, lodMemberBudgetHysteresis: 0 });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    expect(mgr.lodStats.centroidSquads).toBe(7);

    expect(mgr.setLodBudget(0)).toBe(0);
    mgr.update(1 / 30);
    expect([...mgr.squads.values()].every(sq => sq.lod === 'full')).toBe(true);
    expect(mgr.lodStats.armed).toBe(false);
  });

  it('re-ranks only on its own cadence', () => {
    const mgr = makeManager(10, { lodFullMemberBudget: 16, lodMemberBudgetIntervalSec: 1 });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    const before = [...mgr.squads.values()].map(sq => sq.lod);

    mgr.setViewPos(0, 0, 1000);
    mgr.update(1 / 30);                       // 0.067 s total: inside the interval
    expect([...mgr.squads.values()].map(sq => sq.lod)).toEqual(before);
    for (let i = 0; i < 40; i++) mgr.update(1 / 30);   // past 1 s
    expect([...mgr.squads.values()].map(sq => sq.lod)).not.toEqual(before);
  });

  it('never steers more than the budget, from either direction', () => {
    // The bug this pins was measured live, not reasoned about: with the slack
    // on the HOLD side (budget*(1+h)) every squad starts `full`, so the first
    // pass fills straight past the cap and stays there — the config value
    // silently understating the real cap by h. Approach the steady state from
    // both sides and require the cap to hold on both.
    for (const seed of ['full', 'centroid']) {
      const mgr = makeManager(20, { lodFullMemberBudget: 50, lodMemberBudgetHysteresis: 0.1 });
      for (const sq of mgr.squads.values()) sq.lod = seed;
      mgr.setViewPos(0, 0, 0);
      for (let i = 0; i < 5; i++) { mgr._lodNextAt = 0; mgr.update(1 / 30); }
      expect(mgr.lodStats.fullMembers).toBeLessThanOrEqual(50);      // the cap, both directions
      // Squads are indivisible, so the steady state lands within one squad
      // below whichever limit applied: budget*(1-h) = 45, minus 8.
      expect(mgr.lodStats.fullMembers).toBeGreaterThan(45 - 8);
    }
  });

  it('hysteresis holds a boundary squad instead of flapping it', () => {
    // Budget 24 with h=0.25: `full` holds to 24, `centroid` promotes below 18.
    // Squad 3 (cumulative 24) therefore keeps `full` once it has it...
    const mgr = makeManager(10, { lodFullMemberBudget: 24, lodMemberBudgetHysteresis: 0.25 });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    expect(mgr.squads.get(3).lod).toBe('full');

    // ...and a squad that arrives at that same rank while `centroid` does NOT
    // get promoted into it, because 24 > the 18-member promote limit.
    mgr.squads.get(3).lod = 'centroid';
    mgr._lodNextAt = 0;
    mgr.update(1 / 30);
    expect(mgr.squads.get(3).lod).toBe('centroid');
  });

  it('does not steal the icon tier from whoever owns it', () => {
    const mgr = makeManager(10, { lodFullMemberBudget: 24, lodMemberBudgetHysteresis: 0 });
    mgr.squads.get(1).lod = 'icon';
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    expect(mgr.squads.get(1).lod).toBe('icon');
    // ...and its members do not consume the budget either: squads 2-4 fit.
    expect(mgr.squads.get(4).lod).toBe('full');
    expect(mgr.squads.get(5).lod).toBe('centroid');
  });

  it('demoted squads leave the separation grid, so steering cost really falls', () => {
    const mgr = makeManager(10, { lodFullMemberBudget: 24, lodMemberBudgetHysteresis: 0 });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    let gridMembers = 0;
    for (const bucket of mgr._grid.values()) gridMembers += bucket.length;
    expect(gridMembers).toBe(24);
  });
});

// --- the `icon` tier and the drawn-member budget (PLAN-perf M23) ------------
//
// M20 capped how many members are STEERED. This caps how many are DRAWN, which
// is the term the per-member floor is paid on. The tier existed before M23 but
// released every instance, so the whole point of these tests is that the squad
// is still ON SCREEN afterwards — a "perf tier" that deletes the units would
// measure wonderfully and ship nothing.

function drawnMembers(mgr) {
  let n = 0;
  for (const sq of mgr.squads.values()) {
    for (const m of sq.members) if (m.alive && !m.released) n++;
  }
  return n;
}

describe('icon tier — an art tier, not a disappearance', () => {
  it('keeps iconMemberCount members drawn, not zero', () => {
    const { backend } = makeBackend();
    const sq = new Squad(1, makeDef(), backend, makeCfg({ iconMemberCount: 3 }));
    sq.setPose(500, 0, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    expect(sq.members.filter(m => !m.released).length).toBe(8);

    sq.lod = 'icon';
    expect(sq.members.filter(m => m.alive && !m.released).length).toBe(3);
    expect(sq.aliveCount).toBe(8);            // Pitfall #3 — no member was killed
  });

  it('draws its mark at real slot offsets that track the squad, not a frozen point', () => {
    const { backend, writes } = makeBackend();
    const sq = new Squad(1, makeDef(), backend, makeCfg({ iconMemberCount: 3 }));
    sq.setPose(500, 0, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    sq.lod = 'icon';

    writes.length = 0;
    sq.setPose(900, 0, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    expect(writes.length).toBe(3);                      // exactly the mark
    expect(new Set(writes.map(w => `${w.x},${w.z}`)).size).toBe(3);  // not stacked
    for (const w of writes) {
      expect(Math.abs(w.x - 900)).toBeLessThanOrEqual(makeDef().formationRadius * 2);
      expect(w.y).toBeCloseTo(backend.groundHeight(w.x, w.z), 6);    // ground-snapped
    }
  });

  it('re-elects the mark when a mark member is killed', () => {
    const { backend } = makeBackend();
    const sq = new Squad(1, makeDef(), backend, makeCfg({ iconMemberCount: 3 }));
    sq.setPose(500, 0, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    sq.lod = 'icon';

    // Kill the mark itself — the case that makes a naive implementation blink
    // the squad off screen while it is still very much alive.
    const mark = sq.members.filter(m => m.alive && !m.released);
    expect(mark.length).toBe(3);
    for (const m of mark) { m.alive = false; sq.aliveCount--; }

    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    expect(sq.aliveCount).toBe(5);
    expect(sq.members.filter(m => m.alive && !m.released).length).toBe(3);
  });

  it('falls back to whatever is left when fewer than iconMemberCount survive', () => {
    const { backend } = makeBackend();
    const sq = new Squad(1, makeDef({ squadSize: 2 }), backend, makeCfg({ iconMemberCount: 3 }));
    sq.setPose(500, 0, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    sq.lod = 'icon';
    expect(sq.members.filter(m => m.alive && !m.released).length).toBe(2);
  });

  it('icon → full restores every still-alive member', () => {
    const { backend } = makeBackend();
    const sq = new Squad(1, makeDef(), backend, makeCfg({ iconMemberCount: 3 }));
    sq.setPose(500, 0, 500, 0);
    sq.update(1 / 30, 0, NO_NEIGHBOURS, null);
    sq.lod = 'icon';
    sq.lod = 'full';
    expect(sq.members.filter(m => m.alive && !m.released).length).toBe(8);
    for (const m of sq.members) if (m.alive) expect(m.handle).not.toBe(-1);
  });
});

describe('drawn-member budget — the second threshold', () => {
  it('is off by default, so the shipped frame is the post-M20 frame', () => {
    const mgr = makeManager(10, { lodFullMemberBudget: 24, lodMemberBudgetHysteresis: 0 });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    expect(mgr.lodStats.iconArmed).toBe(false);
    expect([...mgr.squads.values()].some(sq => sq.lod === 'icon')).toBe(false);
    expect(drawnMembers(mgr)).toBe(80);
  });

  it('drops the far squads to icon once cumulative members pass the drawn budget', () => {
    // 10 x 8 = 80 members. full 24 (3 squads), drawn 48 (3 more at centroid),
    // the remaining 4 squads go to icon at 3 members each.
    const mgr = makeManager(10, {
      lodFullMemberBudget: 24, lodDrawnMemberBudget: 48,
      lodMemberBudgetHysteresis: 0, iconMemberCount: 3,
    });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);

    const tiers = [...mgr.squads.values()].map(sq => sq.lod);
    expect(tiers.slice(0, 3)).toEqual(['full', 'full', 'full']);
    expect(tiers.slice(3, 6)).toEqual(['centroid', 'centroid', 'centroid']);
    expect(tiers.slice(6).every(t => t === 'icon')).toBe(true);
    expect(mgr.lodStats).toMatchObject({
      iconArmed: true, fullMembers: 24, centroidMembers: 24,
      iconSquads: 4, iconMembers: 12, fullDetailMembers: 48, drawnMembers: 60,
    });
    expect(drawnMembers(mgr)).toBe(60);     // the stat is not lying about the frame
  });

  it('a drawn budget below the full budget is ignored, not honoured half-way', () => {
    const mgr = makeManager(10, {
      lodFullMemberBudget: 24, lodDrawnMemberBudget: 8, lodMemberBudgetHysteresis: 0,
    });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    expect(mgr.lodStats.iconArmed).toBe(false);
    expect([...mgr.squads.values()].some(sq => sq.lod === 'icon')).toBe(false);
  });

  it('setLodDrawnBudget(0) restores the pre-M23 frame without a reload', () => {
    const mgr = makeManager(10, {
      lodFullMemberBudget: 24, lodDrawnMemberBudget: 48, lodMemberBudgetHysteresis: 0,
    });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    expect(mgr.lodStats.iconSquads).toBe(4);

    mgr.setLodDrawnBudget(0);
    mgr.update(1 / 30);
    expect([...mgr.squads.values()].some(sq => sq.lod === 'icon')).toBe(false);
    expect(drawnMembers(mgr)).toBe(80);
  });

  it('setLodBudget(0) restores the pre-M20 frame even from the icon tier', () => {
    const mgr = makeManager(10, {
      lodFullMemberBudget: 24, lodDrawnMemberBudget: 48, lodMemberBudgetHysteresis: 0,
    });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    mgr.setLodBudget(0);
    mgr.update(1 / 30);
    expect([...mgr.squads.values()].every(sq => sq.lod === 'full')).toBe(true);
    expect(drawnMembers(mgr)).toBe(80);
  });

  it('hysteresis keeps the full-detail cap a hard cap from both directions', () => {
    for (const seed of ['full', 'icon']) {
      const mgr = makeManager(20, {
        lodFullMemberBudget: 24, lodDrawnMemberBudget: 80,
        lodMemberBudgetHysteresis: 0.1, iconMemberCount: 3,
      });
      for (const sq of mgr.squads.values()) sq.lod = seed;
      mgr.setViewPos(0, 0, 0);
      for (let i = 0; i < 5; i++) { mgr._lodNextAt = 0; mgr.update(1 / 30); }
      expect(mgr.lodStats.fullDetailMembers).toBeLessThanOrEqual(80);
      // Steady state lands in [budget*(1-h), budget] depending on which side it
      // converged from — 72 exactly when it converged up from `icon`.
      expect(mgr.lodStats.fullDetailMembers).toBeGreaterThanOrEqual(80 * 0.9);
      // The marks are the residue on top of the cap, and are bounded by
      // squads x iconMemberCount rather than by the budget.
      expect(mgr.lodStats.iconMembers).toBe(mgr.lodStats.iconSquads * 3);
      expect(drawnMembers(mgr)).toBe(mgr.lodStats.drawnMembers);
    }
  });

  it('never kills a member: aliveCount across the whole herd is untouched', () => {
    const mgr = makeManager(10, {
      lodFullMemberBudget: 24, lodDrawnMemberBudget: 48, lodMemberBudgetHysteresis: 0,
    });
    mgr.setViewPos(0, 0, 0);
    mgr.update(1 / 30);
    let alive = 0;
    for (const sq of mgr.squads.values()) alive += sq.aliveCount;
    expect(alive).toBe(80);
  });
});
