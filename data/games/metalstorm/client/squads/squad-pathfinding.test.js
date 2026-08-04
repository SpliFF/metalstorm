// squad-pathfinding.test.js — headless coverage for PLAN-metalstorm-squad-
// pathfinding.md tasks 1-7: the passability grid (slope+water, negative-
// coordinate cell indexing), nearestPassable slot projection, member mode
// FORMATION<->COLUMN hysteresis, the potential-field steering term, building
// footprint stamping + deform invalidation, and stuck detection/recovery.

import { describe, it, expect } from 'vitest';
import { Squad } from './squad.js';
import { NullRenderBackend } from './render-backend.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';
import { createPassability } from './passability.js';

function makeCfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, countCurve: linearCount, ...overrides };
}

function makeDef(overrides = {}) {
  return {
    defId: 'unit_test',
    squadSize: 6,
    formationType: 'line',
    formationRadius: 20,
    maxSpeed: 5,
    customParams: { ms_class: 'tanks' }, // moveClass VEH
    ...overrides,
  };
}

// Flat land everywhere by default; callers override per-test.
function flatSampler(overrides = {}) {
  return {
    bounds: { minX: -256, minZ: -256, maxX: 256, maxZ: 256 },
    waterLevel: 0,
    heightAt: () => 10,
    ...overrides,
  };
}

describe('passability grid (§2)', () => {
  it('flat land is passable to all land classes; deep water is not', () => {
    const p = createPassability(flatSampler(), makeCfg());
    expect(p.passable(0, 0, 'INFANTRY')).toBe(true);
    expect(p.passable(0, 0, 'VEH')).toBe(true);
    const wet = createPassability(flatSampler({ heightAt: () => -100 }), makeCfg());
    expect(wet.passable(0, 0, 'INFANTRY')).toBe(false); // too deep to wade
    expect(wet.passable(0, 0, 'SHIP')).toBe(true);       // naval: deep water is fine
  });

  it('a steep cliff is impassable to VEH but not necessarily INFANTRY (maxSlope per class, moveinfo.tdf-mirrored)', () => {
    // A sharp step: one side low, the other high, within a single map so the
    // gradient across a cell is steep.
    const sampler = flatSampler({ heightAt: (x) => (x < 0 ? 0 : 2000) });
    const p = createPassability(sampler, makeCfg());
    // Sample well away from the step so slope is locally flat (both sides).
    expect(p.passable(-100, 0, 'VEH')).toBe(true);
    expect(p.passable(100, 0, 'VEH')).toBe(true);
    // Right at the step, the slope between neighbouring cells is near-vertical.
    expect(p.passable(-12, 0, 'HEAVY')).toBe(false);
  });

  it('cell indexing uses Math.floor consistently, so a world origin that sits mid-map (negative coords on one side) resolves correctly', () => {
    // The grid is built origin-relative (world coords are offset by
    // bounds.minX/minZ before flooring into a cell index), which is the
    // Math.floor-consistent design called out alongside the collision
    // spatial hash's `(x/cell)|0` bug (PLAN-metalstorm-squad-collision.md
    // §1/§10) — a negative-world-coordinate query must land in the same
    // cell a query at the equivalent positive-offset coordinate would, not
    // alias into cell 0 the way truncate-toward-zero indexing would for a
    // hash keyed directly off raw (non-origin-relative) world coordinates.
    const sampler = flatSampler({
      bounds: { minX: -64, minZ: -64, maxX: 64, maxZ: 64 },
      heightAt: (x) => (x < -0.5 ? -100 : 10), // deep water strictly left of centre
    });
    const p = createPassability(sampler, makeCfg({ passabilityCellSize: 8 }));
    // Sampled a few cells in from the boundary each side so the 3x3 smoothing
    // blur (§2 pitfall) doesn't bleed the two regions into each other.
    expect(p.passable(-20, 0, 'INFANTRY')).toBe(false); // negative coord, well into water
    expect(p.passable(20, 0, 'INFANTRY')).toBe(true);   // positive coord, well into land
  });
});

describe('nearestPassable — slot projection off a cliff edge (§3)', () => {
  it('projects an impassable point to the nearest passable cell within the cap', () => {
    const sampler = flatSampler({ heightAt: (x, z) => (Math.hypot(x, z) < 30 ? 2000 : 10) });
    const p = createPassability(sampler, makeCfg());
    expect(p.passable(0, 0, 'VEH')).toBe(false);
    const proj = p.nearestPassable(0, 0, 'VEH', 4);
    expect(proj.x !== 0 || proj.z !== 0).toBe(true);
    expect(p.passable(proj.x, proj.z, 'VEH')).toBe(true);
  });

  it('falls back to the input point unchanged if nothing passable is within the cap', () => {
    const p = createPassability(flatSampler({ heightAt: () => 2000 }), makeCfg());
    const proj = p.nearestPassable(0, 0, 'VEH', 2);
    expect(proj).toEqual({ x: 0, z: 0 });
  });
});

describe('member mode FORMATION <-> COLUMN with hysteresis (§4)', () => {
  it('a member whose slot is blocked switches to COLUMN after K consecutive frames, and back after re-opening', () => {
    // A single ~24-elmo-wide passable gap at x in [-12,12); everywhere else
    // (where the outer squad slots sit) is deep water — impassable to VEH
    // regardless of distance from the gap (a water-depth block, unlike a
    // slope block, applies uniformly per-cell rather than only at a boundary).
    const sampler = flatSampler({ heightAt: (x) => (Math.abs(x) < 12 ? 10 : -100) });
    const cfg = makeCfg();
    const passability = createPassability(sampler, cfg);
    const backend = new NullRenderBackend();
    const def = makeDef({ squadSize: 5, formationType: 'line', formationRadius: 60 });
    const sq = new Squad(1, def, backend, cfg);
    sq.setPose(0, 0, 0, 0);

    const outer = sq.members[0]; // line's first slot is at x=-radius (the widest offset)
    let nowSec = 0;
    for (let i = 0; i < cfg.modeHysteresisFrames + 5; i++) {
      nowSec += 1 / 30;
      sq.update(1 / 30, nowSec, () => [], passability);
    }
    expect(outer.mode).toBe('COLUMN');

    // Re-open the whole map (no more chokepoint) and let the member close the
    // small remaining distance so it stops registering as constrained.
    const openPassability = createPassability(flatSampler(), cfg);
    for (let i = 0; i < cfg.modeHysteresisFrames + 60; i++) {
      nowSec += 1 / 30;
      sq.update(1 / 30, nowSec, () => [], openPassability);
    }
    expect(outer.mode).toBe('FORMATION');
  });
});

describe('potential-field steering term (§5)', () => {
  it('pushes laterally toward the cheaper (lower-cost) side of a forward lookahead point', () => {
    const cfg = makeCfg();
    const sq = new Squad(2, makeDef(), new NullRenderBackend(), cfg);
    sq.setPose(0, 0, 0, 0);
    const m = sq.members[0];
    m.x = 0; m.z = 0; m.vx = 0; m.vz = 1; // travelling +Z

    const mockPassability = {
      cost(x) { return x < 0 ? 3 : 1; }, // left of centre is expensive
    };
    const out = { x: 0, z: 0 };
    sq._potentialField(m, mockPassability, out);
    expect(out.x).toBeGreaterThan(0); // steers right (+x), away from the costly left side
  });
});

describe('building footprint stamping + heightmap-deform invalidation (§7)', () => {
  it('stamping blocks the footprint; clearing restores terrain-derived passability', () => {
    const p = createPassability(flatSampler(), makeCfg());
    expect(p.passable(0, 0, 'INFANTRY')).toBe(true);
    p.stampBuildingFootprint(0, 0, 40, 40);
    expect(p.passable(0, 0, 'INFANTRY')).toBe(false);
    expect(p.passable(200, 200, 'INFANTRY')).toBe(true); // outside the footprint, untouched
    p.clearBuildingFootprint(0, 0, 40, 40);
    expect(p.passable(0, 0, 'INFANTRY')).toBe(true);
  });

  it('overlapping footprints stay blocked until every stamp is cleared', () => {
    const p = createPassability(flatSampler(), makeCfg());
    p.stampBuildingFootprint(0, 0, 40, 40);
    p.stampBuildingFootprint(10, 10, 40, 40); // overlaps the first
    p.clearBuildingFootprint(0, 0, 40, 40);
    expect(p.passable(10, 10, 'INFANTRY')).toBe(false); // still covered by the second stamp
    p.clearBuildingFootprint(10, 10, 40, 40);
    expect(p.passable(10, 10, 'INFANTRY')).toBe(true);
  });

  it('a deform invalidation flips a cell only after the dirty rect is flushed (lazy recompute)', () => {
    let waterLeft = false;
    const sampler = flatSampler({ heightAt: (x) => (waterLeft && x < -0.5 ? -100 : 10) });
    const p = createPassability(sampler, makeCfg());
    expect(p.passable(-5, 0, 'INFANTRY')).toBe(true); // cached as land, grid now built

    waterLeft = true; // simulate a server heightmap-deform broadcast (0x09)
    expect(p.passable(-5, 0, 'INFANTRY')).toBe(true); // stale cache — not yet invalidated

    p.invalidate(-20, -20, 20, 20);
    expect(p.passable(-5, 0, 'INFANTRY')).toBe(false); // recomputed on the next touching query
  });
});

describe('stuck detection + recovery ladder (§8)', () => {
  it('escalates through trail-boost -> ignore-separation -> off-screen teleport as distance-to-target stalls', () => {
    class OffscreenBackend extends NullRenderBackend {
      isOnScreen() { return false; }
    }
    const cfg = makeCfg({
      stuckFramesTrailBoost: 3, stuckFramesIgnoreSeparation: 6, stuckFramesTeleport: 9,
    });
    const sq = new Squad(3, makeDef(), new OffscreenBackend(), cfg);
    sq.setPose(0, 0, 0, 0);
    // Seed a trail point away from the member so teleport recovery has
    // somewhere concrete to snap to.
    sq._trail = [{ x: 500, z: 500 }];

    const m = sq.members[0];
    m.x = 1000; m.z = 1000; // far from any target, and never gets closer below
    const stuckTarget = { x: 2000, z: 2000 }; // distance never decreases frame to frame

    let sawLevel1 = false, sawLevel2 = false, teleported = false, stuckFramesAtTeleport = -1;
    for (let i = 0; i < 15; i++) {
      sq._trackStuck(m, stuckTarget);
      if (m.recoveryLevel === 1) sawLevel1 = true;
      if (m.recoveryLevel === 2) sawLevel2 = true;
      if (!teleported && m.x === 500 && m.z === 500) {
        teleported = true;
        stuckFramesAtTeleport = m._stuckFrames; // reset in the same call that snaps position
      }
    }
    expect(sawLevel1).toBe(true);
    expect(sawLevel2).toBe(true);
    expect(teleported).toBe(true);
    expect(stuckFramesAtTeleport).toBe(0); // reset in the recovery call itself
  });

  it('never teleports a member the backend reports as on-screen', () => {
    class VisibleBackend extends NullRenderBackend {
      isOnScreen() { return true; }
    }
    const cfg = makeCfg({ stuckFramesTeleport: 3 });
    const sq = new Squad(4, makeDef(), new VisibleBackend(), cfg);
    sq.setPose(0, 0, 0, 0);
    sq._trail = [{ x: 500, z: 500 }];
    const m = sq.members[0];
    m.x = 1000; m.z = 1000;
    const stuckTarget = { x: 2000, z: 2000 };
    for (let i = 0; i < 20; i++) sq._trackStuck(m, stuckTarget);
    expect(m.x).toBe(1000); // stayed put — soft recovery only, never a visible teleport
    expect(m.z).toBe(1000);
  });
});

describe('breadcrumb trail (§4/§9)', () => {
  it('samples by travel distance and caps at trailMaxPoints', () => {
    const cfg = makeCfg({ trailSampleDist: 10, trailMaxPoints: 5 });
    const sq = new Squad(5, makeDef(), new NullRenderBackend(), cfg);
    sq.setPose(0, 0, 0, 0); // seeds trail[0]
    for (let i = 1; i <= 20; i++) sq.setPose(i * 10, 0, 0, 0); // 10 elmos/step
    expect(sq._trail.length).toBe(5);
    expect(sq._trail[sq._trail.length - 1].x).toBe(200);
  });

  it('trailPointAhead returns the trail sample nearest the member, stepped toward the current centroid', () => {
    const cfg = makeCfg({ trailSampleDist: 10, trailMaxPoints: 64 });
    const sq = new Squad(6, makeDef(), new NullRenderBackend(), cfg);
    sq.setPose(0, 0, 0, 0);
    for (let i = 1; i <= 5; i++) sq.setPose(i * 10, 0, 0, 0);
    const m = sq.members[0];
    m.x = 20; m.z = 0; // nearest recorded sample is {x:20,z:0}
    const ahead = sq.trailPointAhead(m, 1);
    expect(ahead.x).toBeGreaterThan(20); // stepped toward the newer end of the trail
  });
});
