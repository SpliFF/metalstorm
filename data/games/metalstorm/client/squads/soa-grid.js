// soa-grid.js — dense CSR spatial grid for the SoA squad engine.
// PLAN-metalstorm-squad-performance.md §11c. Replaces squad-manager.js's
// `Map<string, Member[]>` broad-phase with a two-pass counting sort into
// preallocated typed arrays. Milestone S3: the grid itself, built/queried
// standalone against a store's position views — no kernel wires it up yet
// (S4 does that).
//
// Entry encoding (per §11c): an entry `e < store.capacity` is a member slot
// index (read `store.mx/mz[e]` for its position); `e >= store.capacity` is a
// pseudo-member (repulsor/wreck) at index `e - store.capacity` into the
// grid's own `pseudoX/pseudoZ/pseudoR` arrays.

/** A grid instance. `cfg` supplies `separationRadius`/`maxMemberFootprint`
 *  (cell size, mirrors squad-manager.js's `_cell`) and `denseCellOccupancy`/
 *  `denseCellRadiusMul` (dense-cell aggregation). */
export function createGrid(cfg) {
  return {
    cfg,
    cell: Math.max(cfg.separationRadius, cfg.maxMemberFootprint) * 1.5,
    gx0: 0, gz0: 0, gw: 0, gh: 0, nCells: 0,
    cellCount: new Uint32Array(1),
    cellEntries: new Int32Array(0),
    _cursor: new Uint32Array(0),
    // Dense-cell aggregates (§11c "one aggregate per dense cell per frame"):
    // computed once per rebuild for every cell whose bucket exceeds
    // `denseCellOccupancy`, keyed by cell index.
    isDense: new Uint8Array(0),
    aggX: new Float32Array(0),
    aggZ: new Float32Array(0),
    pseudoX: new Float32Array(0), pseudoZ: new Float32Array(0), pseudoR: new Float32Array(0),
    pseudoCount: 0,
    capacitySplit: 0,
  };
}

function ensureCellCapacity(grid, nCells) {
  if (grid.cellCount.length < nCells + 1) grid.cellCount = new Uint32Array(nCells + 1);
  if (grid._cursor.length < nCells) grid._cursor = new Uint32Array(nCells);
  if (grid.isDense.length < nCells) grid.isDense = new Uint8Array(nCells);
  if (grid.aggX.length < nCells) { grid.aggX = new Float32Array(nCells); grid.aggZ = new Float32Array(nCells); }
}

/** Exported for tests only — pins the Math.floor cell-index math directly,
 *  the same way squad-manager.js's own `_key`/`_cellKey` are pinned by
 *  squad-collision.test.js (the truncate-toward-zero regression: `| 0`
 *  collapses e.g. x=-5 and x=+5 into a shared double-width origin cell). */
export function cellIndexOf(grid, x, z) { return cellIndex(grid, x, z); }

function cellIndex(grid, x, z) {
  // Math.floor, not `| 0` (the latter truncates toward zero and collapses
  // the origin-straddling cell — squad-collision.md §1's floor-bug regression
  // this grid must not reintroduce). Clamp into grid bounds afterward so a
  // point outside the map's rect still lands in a valid cell instead of
  // being dropped or wrapping.
  let gx = Math.floor(x / grid.cell), gz = Math.floor(z / grid.cell);
  if (gx < grid.gx0) gx = grid.gx0; else if (gx > grid.gx0 + grid.gw - 1) gx = grid.gx0 + grid.gw - 1;
  if (gz < grid.gz0) gz = grid.gz0; else if (gz > grid.gz0 + grid.gh - 1) gz = grid.gz0 + grid.gh - 1;
  return (gx - grid.gx0) * grid.gh + (gz - grid.gz0);
}

/**
 * Rebuild the grid for one frame.
 * @param grid            a createGrid() instance
 * @param store           soa-store.js store (read mx/mz, provides capacitySplit)
 * @param memberSlots     Int32Array-like of member slot indices to insert (already
 *                         filtered to alive+non-released members of `lod===full` squads)
 * @param memberCount     number of valid entries in memberSlots
 * @param bounds          { minX, minZ, maxX, maxZ } map bounds (world elmos)
 * @param pseudoX/Z/R     parallel arrays of repulsor/wreck positions+radii
 * @param pseudoCount     number of valid entries in the pseudo arrays
 */
export function rebuildGrid(grid, store, memberSlots, memberCount, bounds, pseudoX, pseudoZ, pseudoR, pseudoCount) {
  const cell = grid.cell;
  const gx0 = Math.floor(bounds.minX / cell), gz0 = Math.floor(bounds.minZ / cell);
  const gx1 = Math.floor(bounds.maxX / cell), gz1 = Math.floor(bounds.maxZ / cell);
  grid.gx0 = gx0; grid.gz0 = gz0;
  grid.gw = Math.max(1, gx1 - gx0 + 1);
  grid.gh = Math.max(1, gz1 - gz0 + 1);
  const nCells = grid.gw * grid.gh;
  grid.nCells = nCells;
  ensureCellCapacity(grid, nCells);
  grid.cellCount.fill(0, 0, nCells + 1);
  grid.isDense.fill(0, 0, nCells);

  grid.pseudoX = pseudoX; grid.pseudoZ = pseudoZ; grid.pseudoR = pseudoR;
  grid.pseudoCount = pseudoCount;
  grid.capacitySplit = store.capacity;

  const total = memberCount + pseudoCount;
  if (grid.cellEntries.length < total) grid.cellEntries = new Int32Array(Math.max(total, 16));

  // Pass 1: count.
  for (let i = 0; i < memberCount; i++) {
    const s = memberSlots[i];
    grid.cellCount[cellIndex(grid, store.mx[s], store.mz[s]) + 1]++;
  }
  for (let i = 0; i < pseudoCount; i++) {
    grid.cellCount[cellIndex(grid, pseudoX[i], pseudoZ[i]) + 1]++;
  }
  for (let c = 0; c < nCells; c++) grid.cellCount[c + 1] += grid.cellCount[c];

  // Pass 2: fill, using a cursor copy of the prefix sums.
  grid._cursor.set(grid.cellCount.subarray(0, nCells));
  for (let i = 0; i < memberCount; i++) {
    const s = memberSlots[i];
    const c = cellIndex(grid, store.mx[s], store.mz[s]);
    grid.cellEntries[grid._cursor[c]++] = s;
  }
  for (let i = 0; i < pseudoCount; i++) {
    const c = cellIndex(grid, pseudoX[i], pseudoZ[i]);
    grid.cellEntries[grid._cursor[c]++] = store.capacity + i;
  }

  // Dense-cell aggregates: once per cell, this rebuild (§11c).
  const dense = grid.cfg.denseCellOccupancy;
  for (let c = 0; c < nCells; c++) {
    const lo = grid.cellCount[c], hi = grid.cellCount[c + 1];
    if (hi - lo <= dense) continue;
    let sx = 0, sz = 0;
    for (let k = lo; k < hi; k++) {
      const e = grid.cellEntries[k];
      if (e < store.capacity) { sx += store.mx[e]; sz += store.mz[e]; }
      else { const p = e - store.capacity; sx += pseudoX[p]; sz += pseudoZ[p]; }
    }
    const n = hi - lo;
    grid.isDense[c] = 1;
    grid.aggX[c] = sx / n;
    grid.aggZ[c] = sz / n;
  }
}

/**
 * Query up to `cap` neighbours of (x,z) into the parallel output arrays,
 * mirroring squad-manager.js's `_neighboursInto` selection rule (3x3 cell
 * scan, dense-cell collapse, cap/stride sampling, self-exclusion) — except
 * the stride-sampled overflow rotates its start index by `frameNo` (§11c /
 * §9's dense-grid-overflow pitfall, fixed at design time: a fixed start would
 * silently drop the same tail members from every dense bucket, every frame).
 *
 * Writes `outSlot[i]` for each filled entry: a real member slot index (>=0),
 * or -1 if the entry is a dense aggregate/pseudo-member, in which case
 * `outX[i]/outZ[i]/outR[i]` hold its resolved position/radius.
 * Returns the number of entries filled.
 */
export function queryInto(grid, store, x, z, excludeSlot, cap, outSlot, outX, outZ, outR, frameNo = 0) {
  if (cap <= 0) return 0;
  const cell = grid.cell;
  const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
  let filled = 0;
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    if (gx < grid.gx0 || gx > grid.gx0 + grid.gw - 1) continue;
    for (let gz = cz - 1; gz <= cz + 1; gz++) {
      if (filled >= cap) return filled;
      if (gz < grid.gz0 || gz > grid.gz0 + grid.gh - 1) continue;
      const c = (gx - grid.gx0) * grid.gh + (gz - grid.gz0);
      const lo = grid.cellCount[c], hi = grid.cellCount[c + 1];
      const bucketLen = hi - lo;
      if (bucketLen === 0) continue;

      if (grid.isDense[c]) {
        outSlot[filled] = -1;
        outX[filled] = grid.aggX[c]; outZ[filled] = grid.aggZ[c];
        outR[filled] = grid.cell * grid.cfg.denseCellRadiusMul;
        filled++;
        continue;
      }

      const remaining = cap - filled;
      if (bucketLen <= remaining) {
        for (let k = lo; k < hi; k++) {
          const e = grid.cellEntries[k];
          if (e === excludeSlot) continue;
          filled = writeEntry(grid, store, e, outSlot, outX, outZ, outR, filled);
        }
      } else {
        const stride = bucketLen / remaining;
        const jitter = frameNo % Math.max(1, Math.round(stride));
        for (let i = 0, idx = jitter; i < remaining; i++, idx += stride) {
          const k = lo + (Math.floor(idx) % bucketLen);
          const e = grid.cellEntries[k];
          if (e === excludeSlot) continue;
          filled = writeEntry(grid, store, e, outSlot, outX, outZ, outR, filled);
        }
      }
    }
  }
  return filled;
}

function writeEntry(grid, store, e, outSlot, outX, outZ, outR, filled) {
  if (e < store.capacity) {
    outSlot[filled] = e;
    outX[filled] = store.mx[e]; outZ[filled] = store.mz[e];
    outR[filled] = 0;
  } else {
    const p = e - store.capacity;
    outSlot[filled] = -1;
    outX[filled] = grid.pseudoX[p]; outZ[filled] = grid.pseudoZ[p]; outR[filled] = grid.pseudoR[p];
  }
  return filled + 1;
}
