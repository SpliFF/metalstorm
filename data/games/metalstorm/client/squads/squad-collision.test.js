// squad-collision.test.js — headless coverage for PLAN-metalstorm-squad-
// collision.md tasks 1-8: Math.floor spatial-hash cell indexing (the
// truncate-toward-zero bug and its negative-coordinate regression case),
// same-/other-squad separation weighting, the neighbour cap + dense-cell
// "crowd -> fluid" aggregation, single-unit/scale-4 pseudo-member repulsors
// (the insertion point shared with PLAN-metalstorm-squad-scale4.md task 4),
// wreck collision-grace, and the separation deadband. No Babylon/DOM — pure
// logic against NullRenderBackend, matching squad-sync/-cohesion/-pathfinding's
// headless pattern. Some cases reach into SquadManager's private spatial-hash
// methods (`_key`, `_insert`, `_neighbours`, `_registerWreck`) directly —
// justified the same way squad-cohesion.test.js unit-tests steering.js's
// pure functions directly: this is math the plan explicitly asks to pin down
// ("add a unit test with negative coordinates so this can't regress"), not
// integration behaviour better observed through the public API.

import { describe, it, expect } from 'vitest';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';
import { separate } from './steering.js';

function makeCfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, countCurve: linearCount, ...overrides };
}

function makeDef(overrides = {}) {
  return {
    defId: 'unit_test',
    squadSize: 5,
    formationType: 'blob',
    formationRadius: 15,
    maxSpeed: 5,
    customParams: {},
    ...overrides,
  };
}

describe('spatial hash cell indexing (§1)', () => {
  it('uses Math.floor, not truncate-toward-zero — x=-5 and x=+5 no longer collapse into the same cell', () => {
    const mgr = new SquadManager(new NullRenderBackend());
    // The `(x / cell) | 0` bug truncates toward zero, so any two points
    // symmetric around the origin land in cell "0" together. Math.floor
    // keeps them apart (floor(-5/cell) = -1 for any cell size > 5).
    expect(mgr._key(-5, 0)).not.toBe(mgr._key(5, 0));
    expect(mgr._key(0, -5)).not.toBe(mgr._key(0, 5));
  });

  it('matches Math.floor(x/cell) exactly across a symmetric negative/positive sweep — no double-width origin cell', () => {
    const cell = new SquadManager(new NullRenderBackend())._cell;
    // Asserted through _cellKey rather than by parsing the key, so this pins
    // the cell-index maths for BOTH key encodings (PLAN-perf M10) instead of
    // only the string one.
    for (const fastNeighbours of [true, false]) {
      const mgr = new SquadManager(new NullRenderBackend(), { fastNeighbours });
      for (let x = -3 * cell; x <= 3 * cell; x += cell / 4) {
        expect(mgr._key(x, 0)).toBe(mgr._cellKey(Math.floor(x / cell), 0));
      }
    }
  });

  it('the numeric and string cell keys agree on identity — same cell same key, different cell different key', () => {
    const fast = new SquadManager(new NullRenderBackend(), { fastNeighbours: true });
    const slow = new SquadManager(new NullRenderBackend(), { fastNeighbours: false });
    const cell = fast._cell;
    const pts = [];
    for (let gx = -3; gx <= 3; gx++) for (let gz = -3; gz <= 3; gz++) pts.push([gx, gz]);
    // Same partition of space: two points share a fast key iff they share a
    // slow one. That is the whole correctness requirement on the encoding.
    for (const [ax, az] of pts) {
      for (const [bx, bz] of pts) {
        const a = [ax * cell + 1, az * cell + 1], b = [bx * cell + 1, bz * cell + 1];
        expect(fast._key(...a) === fast._key(...b))
          .toBe(slow._key(...a) === slow._key(...b));
      }
    }
  });

  it('a member inserted at a negative coordinate is still found by a query from the same cell', () => {
    const mgr = new SquadManager(new NullRenderBackend());
    const cell = mgr._cell;
    const nb = { x: -cell * 2.25, z: -cell * 2.25, squadId: 7 };
    mgr._insert(nb.x, nb.z, nb);
    const self = { x: -cell * 2.1, z: -cell * 2.1, squadId: 7 };
    const found = [...mgr._neighbours(self)];
    expect(found).toContain(nb);
  });
});

describe('two separation regimes: same-squad vs other-squad weighting (§2)', () => {
  it('applies the stronger otherWeight to a different-squad neighbour and the moderate sameWeight to a same-squad one', () => {
    const outSame = { x: 0, z: 0 };
    const outOther = { x: 0, z: 0 };
    separate(0, 0, 1, [{ x: 5, z: 0, squadId: 1 }], 10, 0.6, 1.6, 0, outSame);
    separate(0, 0, 1, [{ x: 5, z: 0, squadId: 2 }], 10, 0.6, 1.6, 0, outOther);
    const magSame = Math.hypot(outSame.x, outSame.z);
    const magOther = Math.hypot(outOther.x, outOther.z);
    expect(magOther).toBeGreaterThan(magSame);
    expect(magOther / magSame).toBeCloseTo(1.6 / 0.6, 5);
  });

  it('a pseudo-member with no squadId (repulsor/wreck/dense-cell aggregate) always resolves to the other-squad weight', () => {
    const out = { x: 0, z: 0 };
    const outRef = { x: 0, z: 0 };
    separate(0, 0, 1, [{ x: 5, z: 0 }], 10, 0.6, 1.6, 0, out); // no squadId at all
    separate(0, 0, 1, [{ x: 5, z: 0, squadId: 2 }], 10, 0.6, 1.6, 0, outRef);
    expect(out.x).toBeCloseTo(outRef.x, 10);
    expect(out.z).toBeCloseTo(outRef.z, 10);
  });
});

describe('separation deadband (§7 anti-boiling)', () => {
  it('ignores a neighbour whose overlap (radius - distance) is below the deadband', () => {
    const out = { x: 1, z: 1 }; // pre-seeded to prove separate() zeroes it
    separate(0, 0, 1, [{ x: 9.8, z: 0, squadId: 2 }], 10, 0.6, 1.6, 1.5, out); // overlap 0.2 < 1.5
    expect(out.x).toBe(0); expect(out.z).toBe(0);
  });

  it('still contributes once overlap clears the deadband', () => {
    const out = { x: 0, z: 0 };
    separate(0, 0, 1, [{ x: 5, z: 0, squadId: 2 }], 10, 0.6, 1.6, 1.5, out); // overlap 5
    expect(Math.hypot(out.x, out.z)).toBeGreaterThan(0);
  });
});

describe('neighbour cap + dense-cell aggregation (§4, "crowd -> fluid")', () => {
  it('collapses a bucket over denseCellOccupancy into a single enlarged-radius aggregate', () => {
    const mgr = new SquadManager(new NullRenderBackend(), { neighbourCap: 8, denseCellOccupancy: 16 });
    for (let i = 0; i < 40; i++) mgr._insert(1, 1, { x: 1, z: 1, squadId: 99 });
    const neighbours = [...mgr._neighbours({ x: 0, z: 0, squadId: 99 })];
    expect(neighbours.length).toBe(1); // one dense bucket -> one aggregate, not 40
    expect(neighbours[0].radius).toBeGreaterThan(0);
    expect(neighbours[0].squadId).toBeUndefined(); // pseudo-member: always "other"
  });

  it('never yields more than neighbourCap even across multiple non-dense buckets', () => {
    const mgr = new SquadManager(new NullRenderBackend(), { neighbourCap: 8, denseCellOccupancy: 100 });
    const cell = mgr._cell;
    // Spread 30 members across several distinct cells inside the 3x3 window
    // around self, all under the dense threshold individually.
    for (let gx = -1; gx <= 1; gx++) {
      for (let gz = -1; gz <= 1; gz++) {
        for (let i = 0; i < 4; i++) {
          const x = gx * cell + 1, z = gz * cell + 1;
          mgr._insert(x, z, { x, z, squadId: 99 });
        }
      }
    }
    const neighbours = [...mgr._neighbours({ x: 0, z: 0, squadId: 99 })];
    expect(neighbours.length).toBe(8);
  });

  it('a bucket under the dense threshold but over the remaining cap budget is stride-sampled, not just the first K', () => {
    const mgr = new SquadManager(new NullRenderBackend(), { neighbourCap: 4, denseCellOccupancy: 100 });
    for (let i = 0; i < 12; i++) mgr._insert(1, 1, { id: i, x: 1, z: 1, squadId: 99 });
    const neighbours = [...mgr._neighbours({ x: 0, z: 0, squadId: 99 })];
    expect(neighbours.length).toBe(4);
    // Stride sampling should not just be bucket[0..3] — it should reach
    // toward the back of the bucket too.
    const ids = neighbours.map((n) => n.id);
    expect(Math.max(...ids)).toBeGreaterThan(4);
  });
});

describe('fast neighbour broad-phase (PLAN-perf M10) — an allocation change, not a behaviour change', () => {
  // The buffer path replaces a generator + string keys in the hottest call in
  // the client frame. Its licence to ship is that it selects *exactly* the
  // same neighbours, so that is what is asserted here — on a grid crowded
  // enough to exercise every branch the selection rule has: dense-cell
  // collapse, stride sampling, plain drain, self-exclusion and the cap.
  function populate(mgr, cell) {
    let id = 0;
    for (let gx = -2; gx <= 2; gx++) {
      for (let gz = -2; gz <= 2; gz++) {
        // Vary occupancy per cell so some buckets go dense, some get
        // stride-sampled, and some drain whole.
        const n = 1 + ((gx + 2) * 5 + (gz + 2)) % 22;
        for (let i = 0; i < n; i++) {
          const x = gx * cell + 1 + i * 0.01, z = gz * cell + 1 + i * 0.01;
          mgr._insert(x, z, { id: id++, x, z, squadId: (gx + gz) & 1 ? 1 : 2 });
        }
      }
    }
  }

  it('selects the identical neighbour sequence as the legacy generator, cell for cell', () => {
    const fast = new SquadManager(new NullRenderBackend(), { fastNeighbours: true });
    const slow = new SquadManager(new NullRenderBackend(), { fastNeighbours: false });
    populate(fast, fast._cell);
    populate(slow, slow._cell);

    const cell = fast._cell;
    let comparedNonEmpty = 0;
    for (let x = -2 * cell; x <= 2 * cell; x += cell / 3) {
      for (let z = -2 * cell; z <= 2 * cell; z += cell / 3) {
        const self = { x, z, squadId: 1 };
        const n = fast._neighboursInto(self);
        const got = fast._nbBuf.slice(0, n);
        const want = [...slow._neighbours(self)];
        // Compare by identity-equivalent shape: real members carry a stable
        // id, dense aggregates are positional.
        const shape = (a) => a.map((o) => (o.id !== undefined ? `m${o.id}` : `agg${o.x.toFixed(4)},${o.z.toFixed(4)},${o.radius}`));
        expect(shape(got)).toEqual(shape(want));
        if (n > 0) comparedNonEmpty++;
      }
    }
    expect(comparedNonEmpty).toBeGreaterThan(20); // the sweep actually hit populated cells
  });

  it('never overruns the buffer or exceeds neighbourCap', () => {
    const mgr = new SquadManager(new NullRenderBackend(), { neighbourCap: 8, denseCellOccupancy: 100 });
    populate(mgr, mgr._cell);
    const n = mgr._neighboursInto({ x: 1, z: 1, squadId: 1 });
    expect(n).toBeLessThanOrEqual(8);
    expect(mgr._nbBuf.length).toBe(8);
  });

  it('excludes self, exactly as the generator does', () => {
    const mgr = new SquadManager(new NullRenderBackend(), { neighbourCap: 8, denseCellOccupancy: 100 });
    const self = { id: 0, x: 1, z: 1, squadId: 1 };
    mgr._insert(self.x, self.z, self);
    mgr._insert(2, 2, { id: 1, x: 2, z: 2, squadId: 1 });
    const n = mgr._neighboursInto(self);
    expect(mgr._nbBuf.slice(0, n)).not.toContain(self);
    expect(n).toBe(1);
  });

  it('yields nothing when the cap is zero (the M9 A/B arm)', () => {
    const mgr = new SquadManager(new NullRenderBackend(), { neighbourCap: 0 });
    populate(mgr, mgr._cell);
    expect(mgr._neighboursInto({ x: 1, z: 1, squadId: 1 })).toBe(0);
  });
});

// Shared helper for the two integration tests below: drives a squad's
// centroid in a straight line through a fixed point and returns the closest
// any member ever got to (px, pz) along the way.
function minMemberApproach(mgr, squadId, fromX, toX, target, steps = 160) {
  let min = Infinity;
  for (let i = 1; i <= steps; i++) {
    const x = fromX + (toX - fromX) * (i / steps);
    mgr.syncPose(squadId, { x, y: 0, z: 0, heading: 0 });
    mgr.update(1 / 30);
    if (Math.abs(x - target.x) < 40) {
      for (const m of mgr.squads.get(squadId).members) {
        min = Math.min(min, Math.hypot(m.x - target.x, m.z - target.z));
      }
    }
  }
  return min;
}

describe('two squads cross and visibly part (§2/§3 integration)', () => {
  it('opposing-squad separation keeps members apart at closest approach vs. separation disabled', () => {
    // Single-member "squads" isolate the effect: both centroids (and their
    // sole member, blob slot 0 = the centroid itself) drive along the same
    // line and would coincide exactly at the midpoint with zero separation.
    // A multi-member blob's own spread is otherwise a confound (some
    // outer-ring members already sit close together regardless of push).
    function run(overrides) {
      const cfg = makeCfg(overrides);
      const mgr = new SquadManager(new NullRenderBackend(), cfg);
      // maxSpeed high enough that the member can actually keep pace with its
      // own fast-moving centroid (160 elmos / 5.3s ~= 30 u/s) — otherwise the
      // hard-leash catch-up lag swamps the much smaller separation effect.
      const def = makeDef({ squadSize: 1, formationRadius: 15, maxSpeed: 60 });
      mgr.syncSquad(1, { x: -80, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, def);
      mgr.syncSquad(2, { x: 80, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, def);
      let min = Infinity;
      const steps = 160;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        mgr.syncPose(1, { x: -80 + 160 * t, y: 0, z: 0, heading: 0 });
        mgr.syncPose(2, { x: 80 - 160 * t, y: 0, z: 0, heading: 0 });
        mgr.update(1 / 30);
        const a = mgr.squads.get(1), b = mgr.squads.get(2);
        if (Math.abs(a.cx - b.cx) < 30) {
          for (const ma of a.members) {
            for (const mb of b.members) {
              min = Math.min(min, Math.hypot(ma.x - mb.x, ma.z - mb.z));
            }
          }
        }
      }
      return min;
    }

    const withSeparation = run({});
    const withoutSeparation = run({ separationWeightSameSquad: 0, separationWeightOtherSquad: 0 });
    expect(withSeparation).toBeGreaterThan(withoutSeparation);
    expect(withoutSeparation).toBeLessThan(1); // control: near-total overlap with no push
  });
});

describe('single-unit/scale-4 pseudo-member repulsor (§5, shared insertion point with squad-scale4 task 4)', () => {
  it('setRepulsor makes a passing squad part around it more than with no repulsor at all', () => {
    const cfg = makeCfg();
    const def = makeDef();

    const withRepulsor = new SquadManager(new NullRenderBackend(), cfg);
    withRepulsor.syncSquad(1, { x: -80, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, def);
    withRepulsor.setRepulsor('superheavy-1', 0, 0, 30);
    const distWith = minMemberApproach(withRepulsor, 1, -80, 80, { x: 0, z: 0 });

    const withoutRepulsor = new SquadManager(new NullRenderBackend(), cfg);
    withoutRepulsor.syncSquad(1, { x: -80, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, def);
    const distWithout = minMemberApproach(withoutRepulsor, 1, -80, 80, { x: 0, z: 0 });

    expect(distWith).toBeGreaterThan(distWithout);
  });

  it('removeRepulsor clears it from tracking', () => {
    const mgr = new SquadManager(new NullRenderBackend());
    mgr.setRepulsor('a', 0, 0, 10);
    expect(mgr._repulsors.size).toBe(1);
    mgr.removeRepulsor('a');
    expect(mgr._repulsors.size).toBe(0);
  });
});

describe('wreck collision-grace then permanently non-colliding (§5)', () => {
  it('a fresh wreck briefly collides, then is pruned and never reinserted', () => {
    const cfg = makeCfg({ wreckCollisionGraceSec: 0.1 });
    const mgr = new SquadManager(new NullRenderBackend(), cfg);
    mgr._registerWreck(10, 10);
    expect(mgr._wrecks.length).toBe(1);

    mgr.update(1 / 30); // ~0.033s elapsed — still inside the 0.1s grace
    let found = [...mgr._neighbours({ x: 10, z: 10, squadId: null })];
    expect(found.some((n) => n.x === 10 && n.z === 10)).toBe(true);
    expect(mgr._wrecks.length).toBe(1);

    for (let i = 0; i < 10; i++) mgr.update(1 / 30); // well past the grace window
    expect(mgr._wrecks.length).toBe(0); // pruned — never re-added
    found = [...mgr._neighbours({ x: 10, z: 10, squadId: null })];
    expect(found.some((n) => n.x === 10 && n.z === 10)).toBe(false);
  });

  it('a real member death wires through Squad.onWreck into the manager', () => {
    const mgr = new SquadManager(new NullRenderBackend(), makeCfg());
    const def = makeDef({ squadSize: 10 });
    mgr.syncSquad(1, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, def);
    expect(mgr._wrecks.length).toBe(0);
    mgr.syncSquad(1, { health: 10, maxHealth: 100 }); // sharp strength drop -> casualties
    // No impact hint was reported, so these are attrition (stagger) kills
    // (squad-casualties §2) — FX drains on the next update() tick.
    mgr.update(0.2); // > staggerIntervalMaxSec
    expect(mgr._wrecks.length).toBeGreaterThan(0);
  });
});
