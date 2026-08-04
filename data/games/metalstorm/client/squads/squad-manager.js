// squad-manager.js — owns every squad; the integration surface the worker
// adapter drives. See PLAN-metalstorm-squads.md §7.

import { Squad } from './squad.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';
import { computeTier, screenPxFor, LOD_ICON, LOD_FULL } from './lod.js';
import { createGovernorState, updateGovernor, strideForLevel } from './governor.js';
import { BigUnitRepulsor } from './big-unit-repulsor.js';
import { createPatchSet } from './patches.js';

// Exponential moving average (α=0.1) for the perf counters' *Ms fields (§14
// S0) — smooths single-frame noise (GC pause, one dense frame) over a
// steady-state measurement window without keeping a sample buffer.
const PERF_EMA_ALPHA = 0.1;
function ema(prev, sample) {
  return prev + (sample - prev) * PERF_EMA_ALPHA;
}

// Thin counting wrapper around the RenderBackend handed to every Squad, so
// the manager can track matrixWrites (PLAN-metalstorm-squad-performance.md
// §14 S0) without instrumenting squad.js's already-tight per-member call
// sites. Fixed-arity forwarding only — no `...rest`/spread — so it doesn't
// allocate per call (squad.js's own no-allocation-in-the-loop rule, §7).
// The manager's own direct backend calls (wreck pool TTL/fade/despawn) go
// through the raw `this.backend`, not this wrapper — only Squad instances
// (created via _activate) receive it, since matrixWrites means member
// render writes specifically.
function wrapBackendForPerf(backend, perf) {
  return {
    createMember(squadId, memberId, visual) { return backend.createMember(squadId, memberId, visual); },
    updateMember(handle, x, y, z, headingY, gait) {
      perf.matrixWrites++;
      return backend.updateMember(handle, x, y, z, headingY, gait);
    },
    destroyMember(handle, death) { return backend.destroyMember(handle, death); },
    releaseMember(handle) { return backend.releaseMember(handle); },
    spawnWreck(x, y, z, headingY, visual) { return backend.spawnWreck(x, y, z, headingY, visual); },
    groundHeight(x, z) { return backend.groundHeight(x, z); },
    isOnScreen(x, y, z) { return backend.isOnScreen ? backend.isOnScreen(x, y, z) : false; },
  };
}

export class SquadManager {
  constructor(backend, config = {}) {
    this.backend = backend;
    this.cfg = { ...DEFAULT_CONFIG, countCurve: linearCount, ...config };
    this.squads = new Map();        // sim unit id → Squad

    // Permanent perf counters (PLAN-metalstorm-squad-performance.md §14 S0).
    // Frame-scoped fields (membersStepped/neighbourChecks/matrixWrites/
    // tierCounts/stepped/coasted) are snapshots of the MOST RECENT frame, not
    // running totals — with the §14 S2 governor's time-slicing live, that
    // invariant only holds at ladder level 0 (stride 1, every full squad
    // steps every frame); above that, stepped.full + coasted.full is the
    // full-tier total instead. The *Ms fields are EMA-smoothed like the
    // governor's own cost sample (governor.js) so a single noisy frame
    // doesn't skew a steady-state dump. `ladderLevel` mirrors
    // `this._governor.ladderLevel`, decided at the end of each update().
    this._perf = {
      frame: 0,
      tierCounts: { full: 0, centroid: 0, icon: 0 },
      stepped: { full: 0, centroid: 0, icon: 0 },
      coasted: { full: 0, centroid: 0, icon: 0 },
      membersStepped: 0,
      neighbourChecks: 0,
      matrixWrites: 0,
      gridRebuildMs: 0,
      stepMs: 0,
      flushMs: 0,
      ladderLevel: 0,
    };
    this._perfBackend = wrapBackendForPerf(backend, this._perf);

    // Frame-time governor (PLAN-metalstorm-squad-performance.md §12c, §14
    // S2) — hardware-adaptive degrade ladder. `_lastFlushMs` is the RAW
    // (non-EMA'd) most recent flush cost, fed into the governor's own EMA
    // alongside this frame's raw update() cost (recordFlush's `flushMs`
    // field above is a separate, longer-smoothed perf-counter EMA — see its
    // comment). Decided level lags by one frame (recordFlush/this frame's
    // update() must finish before the sample exists) — absorbed by the
    // asymmetric hysteresis like any other measurement noise.
    this._governor = createGovernorState();
    this._lastFlushMs = 0;
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
    // are pruned from the array in _pruneWrecks and never re-inserted.
    this._repulsors = new Map();    // id → { x, z, radius }
    this._wrecks = [];              // { x, z, radius, until } — brief collision-grace presence (§5)

    // Manager-level wreck pool (squad-casualties §9): TTL + fade + a
    // per-squad AND global cap, independent of the (much shorter) collision-
    // grace list above — this one lives for wreckTtlSec (~25s), that one for
    // wreckCollisionGraceSec (~2s). Oldest-first eviction (array is append-
    // ordered, so index 0 / first match is always the oldest).
    this._wreckPool = [];           // { x, y, z, headingY, visual, handle, squadId, until }

    // Shared passability grid (PLAN-metalstorm-squad-pathfinding.md §2) — one
    // per map, injected once the worker adapter has a heightmap sampler
    // (Stage 7). Optional: squads steer fine without it (ground behaviour
    // falls back to plain slot arrival, matching pre-pathfinding behaviour).
    this.passability = null;

    // Big units to thread around/under (PLAN-metalstorm-flow.md §4, task 3).
    // Rare (scale-4 super-heavies + footprint-profile buildings only) —
    // queried by plain iteration, no spatial index needed.
    this._bigUnits = new Map();     // sim unit id → BigUnitRepulsor
    this._bigUnitList = [];         // cached array view, rebuilt on mutation
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
    // Order matters: destroy() first (it reads member positions for the death
    // cascade), THEN drop any icon marker this squad was drawing (§12b).
    if (sq.lod === LOD_ICON) this.backend.clearIcon?.(id);
    this.squads.delete(id);
  }

  // --- LOD tiering (PLAN-metalstorm-squad-performance.md §12a) -------------

  /** Force a squad's tier, bypassing the hysteresis dwell. For tests, scripted
   *  scenes and the `state.lod` ingest path — the per-frame camera-driven path
   *  is `updateLod()`. Keeps the icon marker in step either way. */
  setLod(id, tier) {
    const sq = this.squads.get(id);
    if (!sq) return;
    const prev = sq.lod;
    sq.lod = tier;
    this._syncIcon(sq, prev, tier);
  }

  /** Per-frame camera-driven tiering for every squad. The adapter
   *  (game-processor.ts `gpComputeSquadLod`) supplies raw camera state only —
   *  position plus `pxScale` = renderHeight / (2·tan(fov/2)), so that
   *  screenPx = formationRadius·pxScale/dist — and the on-screen test comes
   *  from the backend's frustum (`isOnScreen`, radius-padded at the centroid).
   *
   *  DEVIATION from §12a's "the adapter is the only writer of `lod`": the walk
   *  runs here, because the manager is what holds each squad's centroid and
   *  formation radius (the adapter would need a second per-squad Map lookup
   *  per frame to get them). The rule's actual intent is preserved — the
   *  CAMERA is still the only thing that decides a tier, and the §12c governor
   *  (S2) must never call this or write `lod` at all; it may only choose how
   *  much work each tier gets in a given frame. */
  updateLod(camX, camY, camZ, pxScale, dt) {
    const b = this.backend;
    for (const sq of this.squads.values()) {
      const radius = sq.def.formationRadius || 1;
      const dx = sq.cx - camX, dy = sq.cy - camY, dz = sq.cz - camZ;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      // Frustum test at the centroid, padded by the formation radius so a
      // squad whose centroid is just off-frame but whose members are visible
      // stays in a stepping tier.
      const onScreen = b.isOnScreen ? b.isOnScreen(sq.cx, sq.cy, sq.cz, radius) : true;
      const prev = sq.lod;
      const screenPx = screenPxFor(radius, dist, pxScale);
      // Cached for the §12c governor's L6 "demote farthest third" (§14 S2):
      // ranking by apparent size without a second per-frame camera pass.
      sq._lastScreenPx = screenPx;
      const tier = computeTier(sq._lodState, screenPx, onScreen, dt, this.cfg);
      if (tier !== prev) sq.lod = tier;   // setter drives release / rebuild
      this._syncIcon(sq, prev, tier);
    }
  }

  /** Icon-tier marker upkeep (§12b — the INTERIM per-team marker quad, an
   *  explicit throwaway until PLAN-macro-map.md's strategic renderer takes
   *  over at this exact `setIcon`/`clearIcon` seam). Icon squads have no
   *  member instances, so without this they'd simply vanish from the world
   *  view. Re-issued every frame while icon so the marker tracks the
   *  interpolated centroid; `setIcon` is an upsert. */
  _syncIcon(sq, prevTier, tier) {
    if (tier === LOD_ICON) {
      this.backend.setIcon?.(sq.id, sq.cx, sq.cy, sq.cz, sq.def.formationRadius || 1);
    } else if (prevTier === LOD_ICON) {
      this.backend.clearIcon?.(sq.id);
    }
  }

  /** An impact/combat event landed; route to nearby squads as a casualty hint
   *  (squad-casualties §4). If `squadId` is known, target it directly; else
   *  spatial-match by radius (one AoE fanning to every squad in range, each
   *  independently choosing its own victims — no cross-squad coordination
   *  needed, §4). `hint = { x, z, radius?, squadId? }` — matches the
   *  `CombatEvent`/damage-field impact position on the wire (protocol.fbs). */
  reportImpact(hint) {
    this._forSquadsNear(hint, (sq) => sq.reportImpact(hint.x, hint.z, this._now));
  }

  /** A damage-bearing event revealed a threat bearing — a visible attacker's
   *  position, or (weaker) a visible projectile's origin (squad-casualties
   *  §5). Same routing as `reportImpact`. Callers must simply not call this
   *  for a fully-fog event (attacker hidden, no projectile seen) — §6's
   *  fallback ladder is what handles that, not this method inventing one. */
  reportThreat(hint) {
    this._forSquadsNear(hint, (sq) => sq.reportThreat(hint.x, hint.z));
  }

  /** Shared routing for reportImpact/reportThreat: direct squadId match, or
   *  a spatial radius match against every squad's centroid. */
  _forSquadsNear(hint, fn) {
    if (hint.squadId != null) {
      const sq = this.squads.get(hint.squadId);
      if (sq) fn(sq);
      return;
    }
    const r2 = (hint.radius || 64) ** 2;
    for (const sq of this.squads.values()) {
      const d = (sq.cx - hint.x) ** 2 + (sq.cz - hint.z) ** 2;
      if (d <= r2) fn(sq);
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

  /** Squad.onWreck hook: a member died and dropped cosmetic wreckage.
   *  Two independent lifetimes share this one call (§5 collision / §9 pool):
   *  brief collision presence so a wreck isn't walked straight through the
   *  instant it lands (`_rebuildGrid` prunes it once its grace window ends,
   *  after which it is never re-inserted), and — when `extra` is supplied —
   *  the longer-lived TTL/fade/cap-managed pool entry. `extra` is omitted
   *  by direct test calls that only care about collision-grace. */
  _registerWreck(x, z, extra) {
    this._wrecks.push({
      x, z,
      radius: this.cfg.wreckCollisionRadius,
      until: this._now + this.cfg.wreckCollisionGraceSec,
    });
    if (extra) this._poolWreck(x, z, extra);
  }

  /** Add a wreck to the manager-level pool (squad-casualties §9) and evict
   *  overflow — per-squad cap first, then the global cap — oldest first. */
  _poolWreck(x, z, { y, headingY, visual, handle, squadId }) {
    this._wreckPool.push({
      x, y, z, headingY, visual, handle, squadId,
      until: this._now + this.cfg.wreckTtlSec,
    });
    this._evictWreckOverflow(squadId);
  }

  _evictWreckOverflow(squadId) {
    if (squadId != null) {
      let count = 0;
      for (const w of this._wreckPool) if (w.squadId === squadId) count++;
      while (count > this.cfg.maxWrecksPerSquad) {
        this._despawnWreckAt(this._wreckPool.findIndex((w) => w.squadId === squadId));
        count--;
      }
    }
    while (this._wreckPool.length > this.cfg.maxWrecksGlobal) this._despawnWreckAt(0);
  }

  _despawnWreckAt(idx) {
    const [w] = this._wreckPool.splice(idx, 1);
    this.backend.despawnWreck(w.handle);
  }

  /** Per-frame TTL/fade tick for the wreck pool (§9): despawn anything past
   *  its TTL, fade anything inside its trailing `wreckFadeSec` window. */
  _tickWreckPool() {
    let i = 0;
    while (i < this._wreckPool.length) {
      const w = this._wreckPool[i];
      const remaining = w.until - this._now;
      if (remaining <= 0) {
        this._wreckPool.splice(i, 1);
        this.backend.despawnWreck(w.handle);
        continue;
      }
      if (remaining <= this.cfg.wreckFadeSec) {
        this.backend.fadeWreck?.(w.handle, Math.max(0, remaining / this.cfg.wreckFadeSec));
      }
      i++;
    }
  }

  // --- transport (squad-transport.md §2, §6) ------------------------------

  /** Sim `UnitLoaded(squadUnit, transportUnit)` callin — the real event path,
   *  once streamed to the client worker (§6 wire dependency). No-op for an
   *  untracked id (destroyed/unknown). */
  unitLoaded(id, carrierId, tx, ty, tz) {
    this.squads.get(id)?.onUnitLoaded(carrierId, tx, ty, tz);
  }

  /** Sim `UnitUnloaded(squadUnit, pos)` callin — the real event path (§6). */
  unitUnloaded(id, x, y, z, airborne = false) {
    this.squads.get(id)?.onUnitUnloaded(x, y, z, airborne, this.passability);
  }

  /** Heuristic fallback (§6): UnitLoaded/UnitUnloaded aren't streamed yet, so
   *  until they are, infer LOADED from "squad went hidden while co-located
   *  with a known transport-capable unit" and infer UNLOADING from "a
   *  heuristically-loaded squad became visible again" — fragile by design
   *  (no real drop-point precision; the squad's last-known centroid is the
   *  best available position), replaced outright by `unitLoaded`/
   *  `unitUnloaded` the moment the wire event lands. Call once per frame per
   *  candidate id; `hidden` and `carriers` (`{id,x,y,z}[]`, transport-
   *  capable units currently known) are the caller's (worker adapter's) job
   *  to compute — this module has no entity-visibility knowledge of its own. */
  inferTransportState(id, hidden, carriers) {
    const sq = this.squads.get(id);
    if (!sq) return;

    if (hidden) {
      if (sq._transportHeuristic) return; // already inferred-loaded this stretch
      const r2 = this.cfg.transportHeuristicRadius ** 2;
      for (const c of carriers) {
        const d2 = (c.x - sq.cx) ** 2 + (c.z - sq.cz) ** 2;
        if (d2 <= r2) {
          sq.onUnitLoaded(c.id, c.x, c.y, c.z);
          sq._transportHeuristic = true;
          return;
        }
      }
      return;
    }

    if (sq._transportHeuristic) {
      sq._transportHeuristic = false;
      sq.onUnitUnloaded(sq.cx, sq.cy, sq.cz, false, this.passability);
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
    const sq = new Squad(id, def, this._perfBackend, this.cfg);
    sq.onWreck = (x, z, extra) => this._registerWreck(x, z, extra);
    this.squads.set(id, sq);
    const strength = state.strength || state;
    const pose = state.pose || state;
    if (strength.health != null) sq.setStrength(strength.health, strength.maxHealth, this._now);
    if (pose.x != null) sq.setPose(pose.x, pose.y, pose.z, pose.heading);
    if (state.lod) sq.lod = state.lod;
    return sq;
  }

  // --- per-frame ----------------------------------------------------------

  /** Drive all squads one render step. `dt` seconds.
   *
   *  Frame-time governor (§12c, §14 S2): `level` is the ladder DECIDED AT
   *  THE END OF THE PREVIOUS FRAME (this frame's own cost isn't known yet —
   *  same one-frame lag as any measure-then-react controller, absorbed by
   *  the asymmetric hysteresis). It drives three independent degrades, each
   *  gated at its own threshold so a mild overload only pays for what it
   *  needs: L1/L2 alter what `_groundStep`/`_navalStep` skip per member
   *  (steering.separate), L2 additionally skips the grid rebuild itself
   *  (nothing would query it), L4-L6 time-slice WHICH full squads actually
   *  run their per-member loop this frame vs `coast()` (§12d), and L6
   *  additionally forces the farthest-screenPx third of full squads to a
   *  cheap centroid step whenever it IS their turn (never touching `lod` —
   *  that stays the camera/adapter's alone, see updateLod's docstring). */
  update(dt) {
    this._now += dt;
    this._perf.frame++;
    this._perf.neighbourChecks = 0;
    this._perf.matrixWrites = 0;
    this._tickWreckPool();

    const frameStart = performance.now();
    const level = this._governor.ladderLevel;
    const skipSeparationEntirely = level >= 2; // L2: separation dropped for every full squad
    const stride = strideForLevel(level);

    this._pruneWrecks(); // independent of the grid — must not stall while L2+ is engaged
    const gridStart = performance.now();
    if (skipSeparationEntirely) {
      this._grid.clear();
      this._denseAgg.clear();
    } else {
      this._rebuildGrid();
    }
    this._perf.gridRebuildMs = ema(this._perf.gridRebuildMs, performance.now() - gridStart);

    for (const bu of this._bigUnitList) bu.update(dt);
    const query = (m) => this._neighbours(m);

    // L6's "demote farthest third" (§12c table) ranks full squads by their
    // last camera-computed apparent size (updateLod caches `_lastScreenPx`).
    // A squad never seen by updateLod (a headless test driving update()
    // directly) defaults to Infinity — never demoted, the conservative
    // choice. Squad COUNT here, not member count — an O(squads log squads)
    // sort only at the ladder's top level, dwarfed by the steering cost it
    // replaces.
    let farthestThird = null;
    if (level >= 6) {
      const full = [];
      for (const sq of this.squads.values()) if (sq.lod === LOD_FULL) full.push(sq);
      full.sort((a, b) => a._lastScreenPx - b._lastScreenPx);
      farthestThird = new Set();
      const n = Math.floor(full.length / 3);
      for (let i = 0; i < n; i++) farthestThird.add(full[i].id);
    }

    const tierCounts = { full: 0, centroid: 0, icon: 0 };
    const steppedCounts = { full: 0, centroid: 0, icon: 0 };
    const coastedCounts = { full: 0, centroid: 0, icon: 0 };
    let membersStepped = 0;
    let fullIndex = 0;
    const frameNo = this._perf.frame;

    const stepStart = performance.now();
    for (const sq of this.squads.values()) {
      const tier = sq.lod;
      if (tierCounts[tier] != null) tierCounts[tier]++;

      if (tier !== LOD_FULL) {
        // centroid/icon already cost ~nothing per member (§14 S1) — never
        // time-sliced, always "stepped" through the cheap path.
        sq.update(dt, this._now, query, this.passability, this._bigUnitList);
        coastedCounts[tier]++;
        continue;
      }

      // Transport (BOARDING/LOADED/UNLOADING) owns its own per-member
      // stepping inside Squad._updateTransport and is rare/latency-
      // sensitive — it always gets a real frame, bypassing the schedule.
      const bypassSlicing = sq.transportState !== 'FREE';
      const myTurn = bypassSlicing || stride <= 1 || (fullIndex % stride) === (frameNo % stride);
      fullIndex++;

      if (myTurn) {
        const elapsed = sq._lastSteppedAt == null ? dt : this._now - sq._lastSteppedAt;
        const forceCentroid = !bypassSlicing && farthestThird != null && farthestThird.has(sq.id);
        sq.update(elapsed, this._now, query, this.passability, this._bigUnitList, level, forceCentroid);
        sq._lastSteppedAt = this._now;
        for (const m of sq.memberPositions()) membersStepped++;
        steppedCounts.full++;
      } else {
        sq.coast(this._now);
        coastedCounts.full++;
      }
    }
    this._perf.stepMs = ema(this._perf.stepMs, performance.now() - stepStart);
    this._perf.tierCounts = tierCounts;
    this._perf.stepped = steppedCounts;
    this._perf.coasted = coastedCounts;
    this._perf.membersStepped = membersStepped;

    // Governor decision for NEXT frame (§12c): sample this frame's own cost
    // (update() just measured above) plus the most recent flush (measured
    // by the adapter after last frame's update() returned — recordFlush).
    const sampleMs = (performance.now() - frameStart) + this._lastFlushMs;
    updateGovernor(this._governor, sampleMs, dt * 1000, this.cfg);
    this._perf.ladderLevel = this._governor.ladderLevel;
  }

  /** External timing hook: the worker adapter (game-processor.ts gpTickSquads)
   *  flushes the render backend's thin-instance buffers AFTER this manager's
   *  update() returns, so flushMs can't be measured from inside update() —
   *  the adapter times its own `backend.flush()` call and reports it here. */
  recordFlush(ms) {
    this._perf.flushMs = ema(this._perf.flushMs, ms);
    this._lastFlushMs = ms;
  }

  /** Snapshot of the permanent perf counters (§14 S0) — reachable via
   *  `window.__gp('__squadSystem.perfDump()')` / `window.test.squadPerf()`. */
  perfDump() {
    return {
      frame: this._perf.frame,
      squads: this.squads.size,
      tierCounts: { ...this._perf.tierCounts },
      stepped: { ...this._perf.stepped },
      coasted: { ...this._perf.coasted },
      membersStepped: this._perf.membersStepped,
      neighbourChecks: this._perf.neighbourChecks,
      matrixWrites: this._perf.matrixWrites,
      gridRebuildMs: this._perf.gridRebuildMs,
      stepMs: this._perf.stepMs,
      flushMs: this._perf.flushMs,
      ladderLevel: this._perf.ladderLevel,
      // Governor diagnostics (§12c, §14 S2) — a session can watch these
      // converge live (e.g. "squadCostMs EMA settles at/under squadBudgetMs
      // within N seconds, ladderLevel stabilises").
      squadCostMs: this._governor.costEma,
      squadBudgetMs: this._governor.budgetMs,
      squadCostP95Ms: this._governor.p95CostMs,
      frameIntervalP50Ms: this._governor.p50FrameIntervalMs,
    };
  }

  /** Zero the EMA-smoothed timing fields before a fresh measurement window
   *  (scenario-ladder recipe, §14 S0) — the frame-scoped count fields don't
   *  need resetting, they're overwritten every update(). */
  perfReset() {
    this._perf.gridRebuildMs = 0;
    this._perf.stepMs = 0;
    this._perf.flushMs = 0;
  }

  // --- spatial hash (PLAN-metalstorm-squad-collision.md §1) ---------------
  // Single broad-phase shared by member↔member separation (this file),
  // pathfinding's own passability grid, and the perf dense-grid work — cell
  // indexing here MUST use Math.floor, not `(x / cell) | 0`: `| 0` truncates
  // toward zero, so x=-5 and x=+5 collapse into the same cell and the cell
  // straddling the origin is double-width. See squad-collision.test.js's
  // negative-coordinate case.

  // Inserts EVERY alive+non-released member of every full-LOD squad,
  // regardless of whether that squad is stepping or coasting this frame
  // (§14 S2) — a coasting squad's members still occupy space and must still
  // repel others; only whether a squad's OWN separation query runs is
  // time-sliced (Squad.update's skipSeparation flag), not whether it's a
  // valid neighbour for someone else. Skippable in its entirety at governor
  // ladder L2+ (§12c: separation dropped for every full squad this frame,
  // so nothing would ever query it) — see SquadManager.update.
  _rebuildGrid() {
    this._grid.clear();
    this._denseAgg.clear();
    for (const sq of this.squads.values()) {
      if (sq.lod !== LOD_FULL) continue;
      for (const m of sq.memberPositions()) this._insert(m.x, m.z, m);
    }
    for (const r of this._repulsors.values()) this._insert(r.x, r.z, r);
    for (const w of this._wrecks) this._insert(w.x, w.z, w);
  }

  // Collision-grace wreck expiry (§5) — split out from _rebuildGrid so it
  // still runs every frame even when the grid rebuild itself is skipped
  // (governor L2+, §14 S2): otherwise an expired wreck would never be
  // dropped from `_wrecks` while separation stays disabled, growing the
  // array unboundedly for as long as the overload lasts. Compacts in place
  // so an expired wreck is dropped — not merely skipped — and can never be
  // re-inserted later.
  _pruneWrecks() {
    let keep = 0;
    for (let i = 0; i < this._wrecks.length; i++) {
      const w = this._wrecks[i];
      if (w.until <= this._now) continue;
      this._wrecks[keep++] = w;
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
          yield agg; yielded++; this._perf.neighbourChecks++;
          continue;
        }

        const remaining = cap - yielded;
        if (bucket.length <= remaining) {
          for (const m of bucket) {
            if (m === self) continue;
            yield m; yielded++; this._perf.neighbourChecks++;
          }
        } else {
          const stride = bucket.length / remaining;
          for (let i = 0, idx = 0; i < remaining; i++, idx += stride) {
            const m = bucket[Math.floor(idx)];
            if (m === self) continue;
            yield m; yielded++; this._perf.neighbourChecks++;
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
