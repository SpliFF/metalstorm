// passability.js — client-side passability grid (PLAN-metalstorm-squad-pathfinding.md).
//
// "The one piece of new infrastructure" in the pathfinding plan: a coarse
// grid built from the smoothed heightmap (slope bands per move class +
// water), queried by member steering so cosmetic members never walk through
// cliffs/water their sim unit couldn't.
//
// Per-class maxSlope/waterdepth MIRROR gamedata/moveinfo.tdf (INFANTRY/VEH/
// HEAVY/SHIP/SUB) — keep in lockstep if that file's tuning changes. Cell
// indexing uses Math.floor (NOT |0 — negative coords truncate toward zero
// and double-width the origin cell; same fix recorded for the collision
// spatial hash and the performance dense grid, PLAN-metalstorm-squad-
// collision.md §1/§10).
//
// Pure logic, no imports beyond squads config. Consumed by squad.js /
// member steering; invalidated by building-footprint stamps and heightmap
// deform broadcasts (envelope 0x09). Air ignores this module entirely
// (PLAN-metalstorm-squad-cohesion.md §6) — only ground/naval steerers query it.
//
// `sampler` contract (supplied by the future worker adapter; kept abstract
// here so this module has zero Babylon/DOM/terrain.ts coupling):
//   sampler.bounds: { minX, minZ, maxX, maxZ }   world extents, elmos
//   sampler.heightAt(x, z): number                world height (elmos)
//   sampler.waterLevel: number (optional, default 0)

// Mirrors gamedata/moveinfo.tdf. maxSlope in degrees (converted to radians
// below); maxWaterDepth = land classes may wade up to this depth;
// minWaterDepth = naval classes need at least this depth to float.
const MOVE_CLASSES = {
  INFANTRY: { maxSlopeDeg: 45, maxWaterDepth: 12 },
  VEH:      { maxSlopeDeg: 32, maxWaterDepth: 20 },
  HEAVY:    { maxSlopeDeg: 24, maxWaterDepth: 30 },
  SHIP:     { naval: true, minWaterDepth: 12 },
  SUB:      { naval: true, minWaterDepth: 20 },
};

export function createPassability(sampler, config = {}) {
  const cellSize = config.passabilityCellSize ?? 24;
  const waterLevel = config.waterLevel ?? sampler.waterLevel ?? 0;

  let originX = 0, originZ = 0, W = 0, H = 0;
  let heightCells = null;   // Float32Array, smoothed world height per cell
  let slopeCells = null;    // Float32Array, radians per cell
  let buildingCells = null; // Uint16Array, overlap-safe stamp counter
  let built = false;
  let dirty = null;         // {gx0,gz0,gx1,gz1} inclusive cell rect, or null

  function build() {
    const b = sampler.bounds || { minX: 0, minZ: 0, maxX: 1024, maxZ: 1024 };
    originX = b.minX; originZ = b.minZ;
    W = Math.max(1, Math.ceil((b.maxX - b.minX) / cellSize));
    H = Math.max(1, Math.ceil((b.maxZ - b.minZ) / cellSize));
    heightCells = new Float32Array(W * H);
    for (let gz = 0; gz < H; gz++) {
      for (let gx = 0; gx < W; gx++) {
        heightCells[gz * W + gx] = sampler.heightAt(cellCenterX(gx), cellCenterZ(gz));
      }
    }
    smoothHeights(0, 0, W - 1, H - 1);
    slopeCells = new Float32Array(W * H);
    buildingCells = new Uint16Array(W * H);
    recomputeSlopes(0, 0, W - 1, H - 1);
    built = true;
  }

  function ensureBuilt() { if (!built) build(); }

  function cellCenterX(gx) { return originX + (gx + 0.5) * cellSize; }
  function cellCenterZ(gz) { return originZ + (gz + 0.5) * cellSize; }

  function toCellX(x) { return Math.floor((x - originX) / cellSize); }
  function toCellZ(z) { return Math.floor((z - originZ) / cellSize); }

  function inBounds(gx, gz) { return gx >= 0 && gz >= 0 && gx < W && gz < H; }

  // Pitfall — gradient noise (§2): raw heightmap deltas are noisy; pre-smooth
  // (3x3 box blur) before computing slope, or members jitter on flat-bumpy
  // ground. Smooths in place over a rect (dirty-region-scoped on invalidate).
  function smoothHeights(gx0, gz0, gx1, gz1) {
    const src = heightCells.slice();
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        let sum = 0, n = 0;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = gx + dx, nz = gz + dz;
            if (!inBounds(nx, nz)) continue;
            sum += src[nz * W + nx]; n++;
          }
        }
        heightCells[gz * W + gx] = sum / n;
      }
    }
  }

  function recomputeSlopes(gx0, gz0, gx1, gz1) {
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const h = heightCells[gz * W + gx];
        const hx = gx + 1 < W ? heightCells[gz * W + gx + 1] : h;
        const hz = gz + 1 < H ? heightCells[(gz + 1) * W + gx] : h;
        const maxDelta = Math.max(Math.abs(hx - h), Math.abs(hz - h));
        slopeCells[gz * W + gx] = Math.atan2(maxDelta, cellSize);
      }
    }
  }

  // Dirty-rect invalidation (§7): building stamp / heightmap deform mark a
  // world-space rect dirty; recompute is deferred to the next query that
  // touches it (lazy — a deform storm doesn't cost more than the cells
  // actually queried afterward).
  function markDirty(gx0, gz0, gx1, gz1) {
    gx0 = Math.max(0, gx0); gz0 = Math.max(0, gz0);
    gx1 = Math.min(W - 1, gx1); gz1 = Math.min(H - 1, gz1);
    if (gx0 > gx1 || gz0 > gz1) return;
    if (!dirty) { dirty = { gx0, gz0, gx1, gz1 }; return; }
    dirty.gx0 = Math.min(dirty.gx0, gx0); dirty.gz0 = Math.min(dirty.gz0, gz0);
    dirty.gx1 = Math.max(dirty.gx1, gx1); dirty.gz1 = Math.max(dirty.gz1, gz1);
  }

  function flushDirty() {
    if (!dirty) return;
    // Re-sample raw heights for the dirty rect (+1 cell halo so the smooth
    // blur at the rect's edge reads correct neighbours), then re-smooth and
    // re-slope just that region. Building overlay cells are untouched — a
    // heightmap deform doesn't move buildings.
    const { gx0, gz0, gx1, gz1 } = dirty;
    const hgx0 = Math.max(0, gx0 - 1), hgz0 = Math.max(0, gz0 - 1);
    const hgx1 = Math.min(W - 1, gx1 + 1), hgz1 = Math.min(H - 1, gz1 + 1);
    for (let gz = hgz0; gz <= hgz1; gz++) {
      for (let gx = hgx0; gx <= hgx1; gx++) {
        heightCells[gz * W + gx] = sampler.heightAt(cellCenterX(gx), cellCenterZ(gz));
      }
    }
    smoothHeights(hgx0, hgz0, hgx1, hgz1);
    recomputeSlopes(gx0, gz0, gx1, gz1);
    dirty = null;
  }

  function classInfo(moveClass) {
    return moveClass == null ? null : MOVE_CLASSES[moveClass];
  }

  function passableAtCell(gx, gz, moveClass) {
    if (!inBounds(gx, gz)) return false;
    const info = classInfo(moveClass);
    if (!info) return true; // unknown/air class: grid doesn't apply (§6)
    const idx = gz * W + gx;
    const h = heightCells[idx];
    const depth = waterLevel - h; // >0 means underwater
    if (info.naval) {
      return depth >= info.minWaterDepth;
    }
    if (depth > 0 && depth > info.maxWaterDepth) return false; // too deep to wade
    if (buildingCells[idx] > 0) return false;
    const maxSlopeRad = (info.maxSlopeDeg * Math.PI) / 180;
    return slopeCells[idx] <= maxSlopeRad;
  }

  function costAtCell(gx, gz) {
    if (!inBounds(gx, gz)) return Infinity;
    // Slope-derived traversal cost multiplier: flat ground = 1, ramps up
    // toward steep-but-still-passable terrain (§5, for the potential field).
    const slopeDeg = (slopeCells[gz * W + gx] * 180) / Math.PI;
    return 1 + Math.max(0, slopeDeg) / 20;
  }

  return {
    /** @returns {boolean} can moveClass stand at (x, z)? */
    passable(x, z, moveClass) {
      ensureBuilt(); flushDirty();
      return passableAtCell(toCellX(x), toCellZ(z), moveClass);
    },

    /** Traversal cost multiplier at (x, z) — always finite/passable-agnostic;
     *  callers combine with passable() separately. */
    cost(x, z) {
      ensureBuilt(); flushDirty();
      return costAtCell(toCellX(x), toCellZ(z));
    },

    /** Spiral search outward (capped) for the nearest passable cell centre.
     *  Falls back to {x,z} unchanged if nothing passable is found in range —
     *  callers (Squad) then fall back to the breadcrumb trail (§4). */
    nearestPassable(x, z, moveClass, cap = 4) {
      ensureBuilt(); flushDirty();
      const gx0 = toCellX(x), gz0 = toCellZ(z);
      if (passableAtCell(gx0, gz0, moveClass)) return { x, z };
      for (let r = 1; r <= cap; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
            const gx = gx0 + dx, gz = gz0 + dz;
            if (passableAtCell(gx, gz, moveClass)) {
              return { x: cellCenterX(gx), z: cellCenterZ(gz) };
            }
          }
        }
      }
      return { x, z };
    },

    /** Dirty-rect invalidation (building stamped/cleared, heightmap deformed,
     *  envelope 0x09). World-space rect; recompute is deferred to the next
     *  touching query. */
    invalidate(x0, z0, x1, z1) {
      ensureBuilt();
      markDirty(toCellX(Math.min(x0, x1)), toCellZ(Math.min(z0, z1)),
                toCellX(Math.max(x0, x1)), toCellZ(Math.max(z0, z1)));
    },

    /** Stamp a building footprint impassable (§7). Axis-aligned — Spring-
     *  style placement snaps buildings to cardinal facings, so an AABB in
     *  footprint-local space is exact for 0/90/180/270 headings. Counter-
     *  based so overlapping footprints (rare, but possible at shared edges)
     *  clear correctly independently. footprintXElmos/ZElmos are full
     *  width/depth in world units (already footprint-units * SQUARE_SIZE). */
    stampBuildingFootprint(cx, cz, footprintXElmos, footprintZElmos) {
      ensureBuilt();
      const hx = footprintXElmos / 2, hz = footprintZElmos / 2;
      const gx0 = toCellX(cx - hx), gz0 = toCellZ(cz - hz);
      const gx1 = toCellX(cx + hx), gz1 = toCellZ(cz + hz);
      for (let gz = Math.max(0, gz0); gz <= Math.min(H - 1, gz1); gz++) {
        for (let gx = Math.max(0, gx0); gx <= Math.min(W - 1, gx1); gx++) {
          buildingCells[gz * W + gx]++;
        }
      }
    },

    /** Clear a previously-stamped footprint (destroy) — decrements so a
     *  still-overlapping neighbour footprint stays blocked. */
    clearBuildingFootprint(cx, cz, footprintXElmos, footprintZElmos) {
      ensureBuilt();
      const hx = footprintXElmos / 2, hz = footprintZElmos / 2;
      const gx0 = toCellX(cx - hx), gz0 = toCellZ(cz - hz);
      const gx1 = toCellX(cx + hx), gz1 = toCellZ(cz + hz);
      for (let gz = Math.max(0, gz0); gz <= Math.min(H - 1, gz1); gz++) {
        for (let gx = Math.max(0, gx0); gx <= Math.min(W - 1, gx1); gx++) {
          const idx = gz * W + gx;
          if (buildingCells[idx] > 0) buildingCells[idx]--;
        }
      }
    },

    // Test/debug introspection — not part of the steering-facing contract.
    _debugDims() { ensureBuilt(); return { W, H, cellSize, originX, originZ }; },
  };
}
