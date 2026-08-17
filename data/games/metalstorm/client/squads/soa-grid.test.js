// soa-grid.test.js — headless coverage for PLAN-metalstorm-squad-
// performance.md §11c/§14 S3: the dense CSR spatial grid. Compares against a
// from-scratch reimplementation of squad-manager.js's own `_neighbours`
// selection rule (3x3 cell scan, dense-cell collapse, cap/stride sampling,
// self-exclusion) on a randomised fixture — the same "pin the math directly"
// approach squad-collision.test.js uses for the Map-based grid.

import { describe, it, expect } from 'vitest';
import { createStore, allocRun } from './soa-store.js';
import { createGrid, rebuildGrid, queryInto, cellIndexOf } from './soa-grid.js';

// Deterministic PRNG (no seed dependency on Math.random — a randomised
// fixture must be reproducible on failure).
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CFG = { separationRadius: 14, maxMemberFootprint: 48, denseCellOccupancy: 100000, denseCellRadiusMul: 1.5 };

// --- reference: squad-manager.js's `_neighbours` rule, decoupled from Member/Squad ---

function buildReferenceMap(cell, occupants) {
  const map = new Map();
  for (const o of occupants) {
    const key = Math.floor(o.x / cell) + ':' + Math.floor(o.z / cell);
    let bucket = map.get(key);
    if (!bucket) map.set(key, (bucket = []));
    bucket.push(o);
  }
  return map;
}

function referenceNeighbours(cell, map, self, cap, denseOccupancy) {
  const cx = Math.floor(self.x / cell), cz = Math.floor(self.z / cell);
  const out = [];
  let yielded = 0;
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      if (yielded >= cap) return out;
      const bucket = map.get(gx + ':' + gz);
      if (!bucket || bucket.length === 0) continue;
      if (bucket.length > denseOccupancy) {
        let sx = 0, sz = 0;
        for (const m of bucket) { sx += m.x; sz += m.z; }
        out.push({ x: sx / bucket.length, z: sz / bucket.length });
        yielded++;
        continue;
      }
      const remaining = cap - yielded;
      if (bucket.length <= remaining) {
        for (const m of bucket) {
          if (m === self) continue;
          out.push({ x: m.x, z: m.z }); yielded++;
        }
      } else {
        const stride = bucket.length / remaining;
        for (let i = 0, idx = 0; i < remaining; i++, idx += stride) {
          const m = bucket[Math.floor(idx)];
          if (m === self) continue;
          out.push({ x: m.x, z: m.z }); yielded++;
        }
      }
    }
  }
  return out;
}

function sortedPositions(arr) {
  return arr.map(([x, z]) => `${x.toFixed(4)},${z.toFixed(4)}`).sort();
}

describe('neighbour-set parity vs. the Map-based reference (§11c)', () => {
  it('selects the identical neighbour set for a randomised fixture, incl. repulsors/wrecks', () => {
    const rng = mulberry32(20260813);
    const grid = createGrid(CFG);
    const cell = grid.cell;
    const mapSize = cell * 30;
    const margin = cell * 4; // keep everyone away from the bounds-clamp edge

    const store = createStore(256);
    const memberCount = 120;
    const base = allocRun(store, memberCount);
    const memberSlots = new Int32Array(memberCount);
    const refOccupants = [];
    for (let i = 0; i < memberCount; i++) {
      const slot = base + i;
      const x = margin + rng() * (mapSize - 2 * margin);
      const z = margin + rng() * (mapSize - 2 * margin);
      store.mx[slot] = x; store.mz[slot] = z;
      memberSlots[i] = slot;
      // Read back through the Float32 view — the store's own precision, so
      // the reference doesn't diverge from a lossless double comparison.
      refOccupants.push({ x: store.mx[slot], z: store.mz[slot], slot });
    }

    const pseudoCount = 15;
    const pseudoX = new Float32Array(pseudoCount), pseudoZ = new Float32Array(pseudoCount), pseudoR = new Float32Array(pseudoCount);
    for (let i = 0; i < pseudoCount; i++) {
      pseudoX[i] = margin + rng() * (mapSize - 2 * margin);
      pseudoZ[i] = margin + rng() * (mapSize - 2 * margin);
      pseudoR[i] = 20;
      refOccupants.push({ x: pseudoX[i], z: pseudoZ[i] });
    }

    const bounds = { minX: 0, minZ: 0, maxX: mapSize, maxZ: mapSize };
    rebuildGrid(grid, store, memberSlots, memberCount, bounds, pseudoX, pseudoZ, pseudoR, pseudoCount);
    const refMap = buildReferenceMap(cell, refOccupants);

    const cap = 1000; // comfortably above any bucket size — stride sampling never triggers
    const outSlot = new Int32Array(cap), outX = new Float32Array(cap), outZ = new Float32Array(cap), outR = new Float32Array(cap);

    // Sample 25 random members as query points.
    for (let q = 0; q < 25; q++) {
      const self = refOccupants[Math.floor(rng() * memberCount)];
      const n = queryInto(grid, store, self.x, self.z, self.slot, cap, outSlot, outX, outZ, outR, 0);
      const csrPositions = [];
      for (let i = 0; i < n; i++) csrPositions.push([outX[i], outZ[i]]);

      const refPositions = referenceNeighbours(cell, refMap, self, cap, CFG.denseCellOccupancy)
        .map((o) => [o.x, o.z]);

      expect(sortedPositions(csrPositions)).toEqual(sortedPositions(refPositions));
    }
  });
});

describe('negative/clamped coordinates (Math.floor, not truncate-toward-zero)', () => {
  it('x=-5 and x=+5 land in distinct cells (the origin-double-width regression)', () => {
    const grid = createGrid(CFG);
    rebuildGrid(grid, createStore(4), new Int32Array(0), 0, { minX: -500, minZ: -500, maxX: 500, maxZ: 500 },
      new Float32Array(0), new Float32Array(0), new Float32Array(0), 0);
    expect(cellIndexOf(grid, -5, 0)).not.toBe(cellIndexOf(grid, 5, 0));
    expect(cellIndexOf(grid, 0, -5)).not.toBe(cellIndexOf(grid, 0, 5));
  });

  it('a point outside the rebuilt bounds clamps into a valid cell instead of going out of range', () => {
    const grid = createGrid(CFG);
    const bounds = { minX: -200, minZ: -200, maxX: 200, maxZ: 200 };
    rebuildGrid(grid, createStore(4), new Int32Array(0), 0, bounds,
      new Float32Array(0), new Float32Array(0), new Float32Array(0), 0);
    const idx = cellIndexOf(grid, 1e6, -1e6);
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThan(grid.nCells);
  });
});

describe('dense-cell aggregation (§11c "crowd -> fluid")', () => {
  it('a bucket denser than denseCellOccupancy collapses into one aggregate at the bucket centroid', () => {
    const cfg = { ...CFG, denseCellOccupancy: 5 };
    const grid = createGrid(cfg);
    const cell = grid.cell;
    const store = createStore(32);
    const n = 8;
    const base = allocRun(store, n);
    const memberSlots = new Int32Array(n);
    let sx = 0, sz = 0;
    for (let i = 0; i < n; i++) {
      const slot = base + i;
      // Tightly clustered near one cell centre so all 8 share a bucket.
      const x = cell * 5 + i * 0.5, z = cell * 5 + i * 0.3;
      store.mx[slot] = x; store.mz[slot] = z;
      memberSlots[i] = slot;
      sx += x; sz += z;
    }
    const bounds = { minX: 0, minZ: 0, maxX: cell * 20, maxZ: cell * 20 };
    rebuildGrid(grid, store, memberSlots, n, bounds, new Float32Array(0), new Float32Array(0), new Float32Array(0), 0);

    const cap = 10;
    const outSlot = new Int32Array(cap), outX = new Float32Array(cap), outZ = new Float32Array(cap), outR = new Float32Array(cap);
    // Query from a point elsewhere in the same cell (not one of the members) so nothing is self-excluded.
    const filled = queryInto(grid, store, cell * 5, cell * 5, -1, cap, outSlot, outX, outZ, outR, 0);

    expect(filled).toBe(1);
    expect(outSlot[0]).toBe(-1); // aggregate, not a real member slot
    expect(outX[0]).toBeCloseTo(sx / n, 3);
    expect(outZ[0]).toBeCloseTo(sz / n, 3);
    expect(outR[0]).toBeCloseTo(cell * cfg.denseCellRadiusMul, 5);
  });
});

describe('stride-jitter overflow rotation (§11c / §9 dense-grid-overflow pitfall)', () => {
  it('the same over-budget bucket yields DIFFERENT victims across frames, not a fixed head slice', () => {
    const cfg = { ...CFG, denseCellOccupancy: 100 }; // big enough that this bucket stays non-dense
    const grid = createGrid(cfg);
    const cell = grid.cell;
    const store = createStore(64);
    const n = 12;
    const base = allocRun(store, n);
    const memberSlots = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const slot = base + i;
      store.mx[slot] = cell * 5 + i * 0.7;
      store.mz[slot] = cell * 5 + i * 0.4;
      memberSlots[i] = slot;
    }
    const bounds = { minX: 0, minZ: 0, maxX: cell * 20, maxZ: cell * 20 };
    rebuildGrid(grid, store, memberSlots, n, bounds, new Float32Array(0), new Float32Array(0), new Float32Array(0), 0);

    const cap = 3; // well under the 12-member bucket -> stride sampling kicks in
    const outSlot = new Int32Array(cap), outX = new Float32Array(cap), outZ = new Float32Array(cap), outR = new Float32Array(cap);

    const seenAcrossFrames = new Set();
    for (let frameNo = 0; frameNo < 8; frameNo++) {
      const filled = queryInto(grid, store, cell * 5, cell * 5, -1, cap, outSlot, outX, outZ, outR, frameNo);
      expect(filled).toBe(cap);
      for (let i = 0; i < filled; i++) seenAcrossFrames.add(outSlot[i]);
    }
    // A fixed (non-jittered) stride start would keep re-selecting the same
    // `cap` slots every frame — the whole point of the jitter is that the
    // union over several frames exceeds one frame's cap.
    expect(seenAcrossFrames.size).toBeGreaterThan(cap);
  });
});
