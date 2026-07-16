// squad-manager.js — owns every squad; the integration surface the worker
// adapter drives. See PLAN-metalstorm-squads.md §7.

import { Squad } from './squad.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';
import { BigUnitRepulsor } from './big-unit-repulsor.js';
import { createPatchSet } from './patches.js';

export class SquadManager {
  constructor(backend, config = {}) {
    this.backend = backend;
    this.cfg = { ...DEFAULT_CONFIG, countCurve: linearCount, ...config };
    this.squads = new Map();        // sim unit id → Squad
    this._now = 0;

    // Spatial hash for inter-squad/member separation (§7). Rebuilt each frame.
    this._cell = this.cfg.separationRadius * 1.5;
    this._grid = new Map();         // cellKey → Member[]

    // Big units to thread around/under (PLAN-metalstorm-flow.md §4, task 3).
    // Rare (scale-4 super-heavies + footprint-profile buildings only) —
    // queried by plain iteration, no spatial index needed.
    this._bigUnits = new Map();     // sim unit id → BigUnitRepulsor
    this._bigUnitList = [];         // cached array view, rebuilt on mutation
  }

  // --- ingest from the worker adapter ------------------------------------

  /** A squad-class unit appeared / updated. `state` carries authoritative
   *  pose+health; `def` (first time only) carries static squad metadata. */
  syncSquad(id, state, def) {
    let sq = this.squads.get(id);
    if (!sq) {
      if (!def) return;             // need def to size the roster on first sight
      sq = new Squad(id, def, this.backend, this.cfg);
      this.squads.set(id, sq);
    }
    if (state.lod) sq.lod = state.lod;
    sq.sync(state);
  }

  /** A squad-class unit was destroyed (sim). Cascade its members. */
  removeSquad(id) {
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

  // --- big units (PLAN-metalstorm-flow.md §4, task 3) ---------------------

  /** A big unit (scale-4 / footprint-profile building) appeared. `footprintProfile`
   *  matches patches.js's header shape (mocked until flow F1 lands). */
  registerBigUnit(id, footprintProfile) {
    if (this._bigUnits.has(id)) return;
    this._bigUnits.set(id, new BigUnitRepulsor(id, footprintProfile, createPatchSet(footprintProfile)));
    this._bigUnitList = [...this._bigUnits.values()];
  }

  /** Mirror a big unit's interpolated pose + velocity. `lod` is optional
   *  (camera-range hint computed by the adapter, flow.md §4 "LOD"). */
  syncBigUnit(id, x, z, heading, vx, vz, lod) {
    this._bigUnits.get(id)?.setPose(x, z, heading, vx, vz, lod);
  }

  removeBigUnit(id) {
    if (this._bigUnits.delete(id)) this._bigUnitList = [...this._bigUnits.values()];
  }

  /** The BigUnitRepulsor for `id`, or undefined. Read-only access for FX/decal
   *  consumers that key off the same patch set (flow.md §1) and for tests. */
  getBigUnit(id) { return this._bigUnits.get(id); }

  // --- per-frame ----------------------------------------------------------

  /** Drive all squads one render step. `dt` seconds. */
  update(dt) {
    this._now += dt;
    this._rebuildGrid();
    for (const bu of this._bigUnitList) bu.update(dt);
    const query = (m) => this._neighbours(m);
    for (const sq of this.squads.values()) sq.update(dt, this._now, query, this._bigUnitList);
  }

  // --- spatial hash (stub-grade; §7 "capped neighbour checks") ------------

  _rebuildGrid() {
    this._grid.clear();
    for (const sq of this.squads.values()) {
      if (sq.lod !== 'full') continue;
      for (const m of sq.memberPositions()) {
        const k = this._key(m.x, m.z);
        let bucket = this._grid.get(k);
        if (!bucket) this._grid.set(k, (bucket = []));
        bucket.push(m);
      }
    }
  }

  _key(x, z) {
    return ((x / this._cell) | 0) + ':' + ((z / this._cell) | 0);
  }

  // Yields members in the 3×3 cell neighbourhood (excludes self). Generator so
  // separate() can iterate without the manager building an array.
  *_neighbours(self) {
    const cx = (self.x / this._cell) | 0, cz = (self.z / this._cell) | 0;
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const bucket = this._grid.get(gx + ':' + gz);
        if (!bucket) continue;
        for (const m of bucket) if (m !== self) yield m;
      }
    }
  }
}
