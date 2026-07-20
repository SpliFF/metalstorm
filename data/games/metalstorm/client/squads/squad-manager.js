// squad-manager.js — owns every squad; the integration surface the worker
// adapter drives. See PLAN-metalstorm-squads.md §7.

import { Squad } from './squad.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';

export class SquadManager {
  constructor(backend, config = {}) {
    this.backend = backend;
    this.cfg = { ...DEFAULT_CONFIG, countCurve: linearCount, ...config };
    this.squads = new Map();        // sim unit id → Squad
    // Last known pose/strength for an id whose def hasn't arrived yet
    // (squad-sync H1: state can arrive before the on-demand def). Flushed by
    // noteDef(); cleared on removeSquad() so a reused id never resurrects a
    // stale Squad from leftover buffered state (H2).
    this._pendingById = new Map();  // id → { pose?, strength? }
    this._now = 0;

    // Spatial hash for inter-squad/member separation (PLAN-metalstorm-squad-
    // collision.md §1). Rebuilt each frame. Cell size accounts for the
    // largest pseudo-member repulsor an adapter is expected to register
    // (§1/§5), not just member separationRadius, so the 3x3 neighbour query
    // reliably reaches a big single-unit/scale-4 repulsor's footprint.
    this._cell = Math.max(this.cfg.separationRadius, this.cfg.maxMemberFootprint) * 1.5;
    this._grid = new Map();         // cellKey → (Member | pseudo-member)[]
    this._denseAgg = new Map();     // cellKey → cached aggregate repulsor, rebuilt each frame (§4)

    // Dynamic obstacles that aren't squad members (collision §5): single
    // units / super-heavies / scale-4 register as repulsors (upserted by id,
    // shared insertion point with PLAN-metalstorm-squad-scale4.md task 4);
    // wrecks get a brief post-spawn collision grace via Squad.onWreck, then
    // are pruned from the array in _rebuildGrid and never re-inserted.
    this._repulsors = new Map();    // id → { x, z, radius }
    this._wrecks = [];              // { x, z, radius, until }

    // Shared passability grid (PLAN-metalstorm-squad-pathfinding.md §2) — one
    // per map, injected once the worker adapter has a heightmap sampler
    // (Stage 7). Optional: squads steer fine without it (ground behaviour
    // falls back to plain slot arrival, matching pre-pathfinding behaviour).
    this.passability = null;
  }

  /** Install the shared passability grid once the map's heightmap sampler is
   *  available (worker adapter, Stage 7 — see passability.js's createPassability). */
  setPassability(passability) { this.passability = passability; }

  // --- building footprints / heightmap deform (pathfinding §7) -----------

  /** A building finished construction / was placed: stamp its footprint
   *  impassable. No-op if no passability grid is installed yet. */
  stampBuildingFootprint(cx, cz, footprintXElmos, footprintZElmos) {
    this.passability?.stampBuildingFootprint(cx, cz, footprintXElmos, footprintZElmos);
  }

  /** A building was destroyed: clear its footprint stamp. */
  clearBuildingFootprint(cx, cz, footprintXElmos, footprintZElmos) {
    this.passability?.clearBuildingFootprint(cx, cz, footprintXElmos, footprintZElmos);
  }

  /** Heightmap deformation broadcast (envelope 0x09) touched a world-space
   *  rect: invalidate the passability grid there (recompute is lazy, on the
   *  next query that touches it). */
  invalidateTerrain(x0, z0, x1, z1) {
    this.passability?.invalidate(x0, z0, x1, z1);
  }

  // --- dynamic obstacles: pseudo-member repulsors (collision §5) ---------

  /** Register/update a single unit, super-heavy, or scale-4 as a pseudo-
   *  member repulsor so nearby squad members separate around it. `radius`
   *  is caller-supplied (footprint-derived) — this module has no unit-def
   *  knowledge of its own. Upsert: safe to call every frame with a fresh
   *  position; this is the single shared insertion point for both this
   *  plan's task 4 and PLAN-metalstorm-squad-scale4.md task 4 — do not
   *  duplicate it in the scale-4 adapter. */
  setRepulsor(id, x, z, radius) {
    let r = this._repulsors.get(id);
    if (!r) this._repulsors.set(id, (r = {}));
    r.x = x; r.z = z; r.radius = radius;
  }

  /** The repulsor's sim unit left range, died, or is no longer tracked. */
  removeRepulsor(id) {
    this._repulsors.delete(id);
  }

  // --- ingest from the worker adapter ------------------------------------

  /** Strength + first-sight path (squad-sync §1): `state` carries
   *  authoritative pose+health; `def` (first time only) carries static
   *  squad metadata. Buffers into pendingById if the def isn't known yet
   *  (H1) rather than dropping the update. */
  syncSquad(id, state, def) {
    let sq = this.squads.get(id);
    if (!sq) {
      if (!def) { this._buffer(id, state); return; }
      this._activate(id, def, state);
      return;
    }
    if (state.x != null) sq.setPose(state.x, state.y, state.z, state.heading);
    sq.setStrength(state.health, state.maxHealth, this._now);
    if (state.lod) sq.lod = state.lod;
  }

  /** Per-frame pose from the interpolator feed (§1) — render-rate, cheap.
   *  Buffers if the squad hasn't been constructed yet (H1) so a later
   *  def/strength flush doesn't spawn at the origin. */
  syncPose(id, pose) {
    const sq = this.squads.get(id);
    if (!sq) { this._buffer(id, pose); return; }
    sq.setPose(pose.x, pose.y, pose.z, pose.heading);
  }

  /** Strength on snapshot change only (§1). `applyAtFrame` is a stub for the
   *  scheduled-event timeline (§7) — no-op/ignored until PLAN-latency L1. */
  syncStrength(id, health, maxHealth, applyAtFrame) {
    const sq = this.squads.get(id);
    if (!sq) { this._buffer(id, { health, maxHealth }); return; }
    sq.setStrength(health, maxHealth, this._now, applyAtFrame);
  }

  /** DefCache resolved a def for an id seen before it (H1 flush). No-op if
   *  nothing is pending — the expected/common order is def-before-state. */
  noteDef(id, def) {
    if (this.squads.has(id)) return;
    const pending = this._pendingById.get(id);
    if (!pending) return;
    this._activate(id, def, pending);
  }

  /** A squad-class unit was destroyed (sim). Cascade its members, and drop
   *  any buffered pending state so a reused id never lazily resurrects a
   *  stale Squad (H2). */
  removeSquad(id) {
    this._pendingById.delete(id);
    const sq = this.squads.get(id);
    if (!sq) return;
    sq.destroy(this._now);
    this.squads.delete(id);
  }

  /** An impact/combat event landed; route to nearby squads as a casualty hint.
   *  If `squadId` is known, target it directly; else spatial-match by radius. */
  reportImpact(hint) {
    if (hint.squadId != null) {
      this.squads.get(hint.squadId)?.reportImpact(hint.x, hint.z, this._now);
      return;
    }
    const r2 = (hint.radius || 64) ** 2;
    for (const sq of this.squads.values()) {
      const d = (sq.cx - hint.x) ** 2 + (sq.cz - hint.z) ** 2;
      if (d <= r2) sq.reportImpact(hint.x, hint.z, this._now);
    }
  }

  /** Squad.onWreck hook: a member died and dropped cosmetic wreckage
   *  (collision §5). Brief collision presence so a wreck isn't walked
   *  straight through the instant it lands; _rebuildGrid prunes it once its
   *  grace window ends, after which it is never re-inserted. */
  _registerWreck(x, z) {
    this._wrecks.push({
      x, z,
      radius: this.cfg.wreckCollisionRadius,
      until: this._now + this.cfg.wreckCollisionGraceSec,
    });
  }

  // --- def-before-state buffering (H1) ------------------------------------

  /** Merge a partial pose/strength update into the id's pending entry. Keeps
   *  only the LAST of each — no history, just what to flush once def arrives. */
  _buffer(id, partial) {
    let entry = this._pendingById.get(id);
    if (!entry) this._pendingById.set(id, (entry = {}));
    if (partial.x != null) {
      entry.pose = { x: partial.x, y: partial.y, z: partial.z, heading: partial.heading };
    }
    if (partial.health != null) {
      entry.strength = { health: partial.health, maxHealth: partial.maxHealth };
    }
  }

  /** Construct a Squad and apply known/buffered state. Strength is applied
   *  BEFORE pose: `setPose` triggers the initial spawn, and `_spawnInitial`
   *  sizes the roster from current health (§6 late-join) — applying strength
   *  first is what makes that come out right instead of spawning full-size
   *  and then killing down with death FX. */
  _activate(id, def, state) {
    // Supersedes any buffered fragment for `id` — whichever path constructs
    // the squad (direct def-carrying syncSquad, or a noteDef flush) is
    // authoritative for it now; a stale leftover would only matter if this
    // id were later destroyed and reused (H2), so clear it here too.
    this._pendingById.delete(id);
    const sq = new Squad(id, def, this.backend, this.cfg);
    sq.onWreck = (x, z) => this._registerWreck(x, z);
    this.squads.set(id, sq);
    const strength = state.strength || state;
    const pose = state.pose || state;
    if (strength.health != null) sq.setStrength(strength.health, strength.maxHealth, this._now);
    if (pose.x != null) sq.setPose(pose.x, pose.y, pose.z, pose.heading);
    if (state.lod) sq.lod = state.lod;
    return sq;
  }

  // --- per-frame ----------------------------------------------------------

  /** Drive all squads one render step. `dt` seconds. */
  update(dt) {
    this._now += dt;
    this._rebuildGrid();
    const query = (m) => this._neighbours(m);
    for (const sq of this.squads.values()) sq.update(dt, this._now, query, this.passability);
  }

  // --- spatial hash (PLAN-metalstorm-squad-collision.md §1) ---------------
  // Single broad-phase shared by member↔member separation (this file),
  // pathfinding's own passability grid, and the perf dense-grid work — cell
  // indexing here MUST use Math.floor, not `(x / cell) | 0`: `| 0` truncates
  // toward zero, so x=-5 and x=+5 collapse into the same cell and the cell
  // straddling the origin is double-width. See squad-collision.test.js's
  // negative-coordinate case.

  _rebuildGrid() {
    this._grid.clear();
    this._denseAgg.clear();
    for (const sq of this.squads.values()) {
      if (sq.lod !== 'full') continue;
      for (const m of sq.memberPositions()) this._insert(m.x, m.z, m);
    }
    for (const r of this._repulsors.values()) this._insert(r.x, r.z, r);

    // Wrecks: collision-active only within their post-spawn grace window
    // (§5). Compact the array in place as we go, so an expired wreck is
    // dropped — not merely skipped — and can never be re-inserted later.
    let keep = 0;
    for (let i = 0; i < this._wrecks.length; i++) {
      const w = this._wrecks[i];
      if (w.until <= this._now) continue;
      this._wrecks[keep++] = w;
      this._insert(w.x, w.z, w);
    }
    this._wrecks.length = keep;
  }

  _insert(x, z, obj) {
    const k = this._key(x, z);
    let bucket = this._grid.get(k);
    if (!bucket) this._grid.set(k, (bucket = []));
    bucket.push(obj);
  }

  _key(x, z) {
    return Math.floor(x / this._cell) + ':' + Math.floor(z / this._cell);
  }

  // Yields up to `neighbourCap` members/pseudo-members from the 3×3 cell
  // neighbourhood (excludes self), tagged implicitly via `.squadId` (real
  // members carry their owning squad's id; repulsors/wrecks/dense-cell
  // aggregates carry none, so steering.separate's same-/other-squad compare
  // always falls to "other" for them — collision §2). Generator so
  // separate() can iterate without the manager building an array.
  //
  // Performance lever (§4): a bucket denser than `denseCellOccupancy`
  // collapses into a single enlarged-radius aggregate repulsor instead of
  // yielding every member in it ("crowd -> fluid", cost-bounded regardless
  // of local density); a bucket under that threshold but still bigger than
  // the remaining cap budget is stride-sampled rather than just taking
  // whichever members happen to be first in the array.
  //
  // ORCA seam (§3 — decision recorded, NOT implemented): a future ORCA
  // avoidance term would query neighbours through this exact generator and
  // replace only steering.separate's body; ORCA needs velocities too, which
  // this can add to the yielded objects later without changing the query
  // shape callers see.
  *_neighbours(self) {
    const cap = this.cfg.neighbourCap;
    if (cap <= 0) return;
    const cx = Math.floor(self.x / this._cell), cz = Math.floor(self.z / this._cell);
    let yielded = 0;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        if (yielded >= cap) return;
        const bucket = this._grid.get(gx + ':' + gz);
        if (!bucket || bucket.length === 0) continue;

        if (bucket.length > this.cfg.denseCellOccupancy) {
          const agg = this._denseAggregate(gx, gz, bucket);
          yield agg; yielded++;
          continue;
        }

        const remaining = cap - yielded;
        if (bucket.length <= remaining) {
          for (const m of bucket) {
            if (m === self) continue;
            yield m; yielded++;
          }
        } else {
          const stride = bucket.length / remaining;
          for (let i = 0, idx = 0; i < remaining; i++, idx += stride) {
            const m = bucket[Math.floor(idx)];
            if (m === self) continue;
            yield m; yielded++;
          }
        }
      }
    }
  }

  // One aggregate per dense cell per frame (cached — computed at most once
  // per cell regardless of how many members query it, not once per query).
  _denseAggregate(gx, gz, bucket) {
    const key = gx + ':' + gz;
    let agg = this._denseAgg.get(key);
    if (agg) return agg;
    let sx = 0, sz = 0;
    for (const m of bucket) { sx += m.x; sz += m.z; }
    agg = {
      x: sx / bucket.length, z: sz / bucket.length,
      radius: this._cell * this.cfg.denseCellRadiusMul,
    };
    this._denseAgg.set(key, agg);
    return agg;
  }
}
