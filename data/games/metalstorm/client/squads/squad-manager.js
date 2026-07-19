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

    // Spatial hash for inter-squad/member separation (§7). Rebuilt each frame.
    this._cell = this.cfg.separationRadius * 1.5;
    this._grid = new Map();         // cellKey → Member[]
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
    for (const sq of this.squads.values()) sq.update(dt, this._now, query);
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
