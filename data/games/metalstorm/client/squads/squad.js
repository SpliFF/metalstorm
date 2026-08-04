// squad.js — one squad: the bridge between the single authoritative sim unit
// and its many cosmetic members. See PLAN-metalstorm-squads.md §8, §9,
// PLAN-metalstorm-squad-cohesion.md, PLAN-metalstorm-squad-pathfinding.md.

import { Member } from './member.js';
import { buildSlots, slotToWorld } from './formation.js';
import { arrive, separate, clampLen, wrapAngle, softLeashPull } from './steering.js';
import { isUnderHull, hullPush, patchPush, panicClamp } from './big-unit-repulsor.js';
import { profileFor } from './movement-profiles.js';
import { steerMember as airSteer } from './air-cohesion.js';
import { steerMember as navalSteer } from './naval-cohesion.js';
import { projectDropPoint, descendStep, scatterSlot } from './squad-transport.js';
import { LOD_ICON, LOD_FULL, createLodState } from './lod.js';

// Reused scratch objects — the per-frame loops must not allocate (§7 perf).
// New passability-aware terms (projection/potential-field results, air/naval
// ctx objects) DO allocate small short-lived objects; that's an accepted
// trade for this milestone — PLAN-metalstorm-squad-performance.md is
// explicitly gated to run only after this (and collision) are visually
// correct and profiled, not before.
const _slotW = { x: 0, z: 0 };
const _arr = { x: 0, z: 0 };
const _sep = { x: 0, z: 0 };
const _big = { x: 0, z: 0 };
const _leash = { x: 0, z: 0 };
const _potential = { x: 0, z: 0 };
const _desired = { x: 0, z: 0 };
const NO_BIG_UNITS = [];

export class Squad {
  /**
   * @param {number} id             sim unit id (authoritative)
   * @param {object} def            { defId, squadSize, formationType, formationRadius, maxSpeed,
   *                                   customParams?, moveClass? } —
   *                                   customParams.ms_class selects the movement profile
   *                                   (movement-profiles.js). moveClass is a moveinfo.tdf
   *                                   name (e.g. 'INFANTRY') checked against a footprint
   *                                   profile's `underpass` list (PLAN-metalstorm-flow.md
   *                                   §3/§4); when absent the profile's own moveClass is
   *                                   used, so def-level moveClass stays a mock/override
   *                                   hook until flow F1 lands.
   * @param {RenderBackend} backend
   * @param {object} cfg            DEFAULT_CONFIG (merged)
   */
  constructor(id, def, backend, cfg) {
    this.id = id;
    this.def = def;
    this.backend = backend;
    this.cfg = cfg;
    this.profile = profileFor(def?.customParams?.ms_class);

    // Authoritative state (mirrored from the entity stream each sync).
    this.cx = 0; this.cy = 0; this.cz = 0;
    this.heading = 0;
    this.health = 1; this.maxHealth = 1;

    // Cosmetic roster.
    this.size = Math.max(1, def.squadSize | 0);
    this.slots = buildSlots(def.formationType, this.size, def.formationRadius);
    this.members = [];
    this.aliveCount = this.size;        // monotonic non-increasing (§4)

    // Casualty-alignment hints (squad-casualties §4): ring of recent impacts
    // (most-recent last), not a single slot — overlapping blasts within the
    // same hint window must both stay selectable.
    this._impacts = [];                 // { x, z, t }[]
    this._lastThreatDir = { x: 0, z: 1 };
    // True once a real damage-bearing event has told us a bearing (§5).
    // Distinct from _lastThreatDir's default value so the fog-of-war case
    // (§6) can tell "never learned a bearing" from "bearing is due north".
    this._threatDirKnown = false;

    // Attrition death queue (squad-casualties §2): victims already resolved
    // (aliveCount already reflects their death) but whose destroy-FX/wreck
    // is deferred and drip-fed via update() so simultaneous losses don't
    // pop as one synchronized bomb.
    this._deathQueue = [];              // { member, dirX, dirZ }[]
    this._nextStaggerAt = 0;

    this._lod = LOD_FULL;               // 'full' | 'centroid' | 'icon' (see setter below)
    // Hysteresis state for the camera-driven tiering (§12a, lod.js). Owned by
    // SquadManager.updateLod; lives here so the tier and its dwell counter
    // can't drift apart when something writes `lod` out of band.
    this._lodState = createLodState(this._lod);
    this._spawned = false;

    // Transport (PLAN-metalstorm-squad-transport.md §2): a client-only
    // visual state machine layered on the sim-authoritative cargo unit — the
    // sim carries ONE unit per squad (§1); this only controls whether/where
    // the COSMETIC members are drawn. FREE -> BOARDING -> LOADED ->
    // UNLOADING -> FREE, driven by onUnitLoaded/onUnitUnloaded (§6, the real
    // event path once streamed, and the manager-level heuristic fallback).
    this.transportState = 'FREE';
    this._transportTargetX = 0; this._transportTargetY = 0; this._transportTargetZ = 0;
    this._transportElapsed = 0;
    this._transportParadrop = false;
    // Heuristic-fallback bookkeeping only (squad-manager.js inferTransportState,
    // §6) — untouched by the explicit event path.
    this._transportHeuristic = false;

    // Collision (PLAN-metalstorm-squad-collision.md §5): optional hook the
    // manager installs to register a dropped wreck for brief avoidance-hash
    // presence. No-op if unset (e.g. a bare Squad in a test).
    this.onWreck = null;

    // Breadcrumb trail (pathfinding §4): ring buffer of recent centroid
    // positions, distance-sampled. Reseeded on a centroid teleport (§3).
    this._trail = [];

    // Centroid kinematics, recomputed once per update() call (turn handling
    // §5, "is the squad holding" for air loiter/naval column bias §6/§7).
    this._prevUpdateCx = null; this._prevUpdateCz = null; this._prevUpdateHeading = 0;
    this._centroidSpeed = 0;
    this._headingRate = 0;

    // Frame-time governor time-slicing (§12c/§12d, §14 S2). `_lastAppliedCx/
    // Cz` is "the centroid members are currently positioned consistent
    // with" — advanced on every real step AND on setPose's teleport shift
    // (which already rigid-moves every member, so a subsequent coast() must
    // not shift them again by the same delta). `coast()` reads the gap
    // between that and the live centroid to rigid-shift a squad skipped this
    // frame's time-slicing round. `_lastSteppedAt` lets a stepped squad
    // integrate the REAL elapsed time since it last actually stepped (half-
    // rate squads see double dt, so motion speed is preserved). `_lastScreenPx`
    // is cached by SquadManager.updateLod so ladder L6's "demote the farthest
    // third" can rank squads without a second camera pass.
    this._lastAppliedCx = 0; this._lastAppliedCz = 0;
    this._lastSteppedAt = null;
    this._lastScreenPx = Infinity;
  }

  // --- ingest (squad-sync §1: pose and strength are separate clocks) ------

  /** Per-frame pose (interpolated centroid + heading) — cheap, no casualty
   *  logic. Triggers the initial member spawn on first call (H4: members
   *  must spawn at their slots around the first KNOWN centroid, never at the
   *  origin then fan out).
   *
   *  Teleport-guard (cohesion §3): a discontinuous centroid jump (LOS regain,
   *  server replan, snapshot correction) rigid-translates every member by
   *  the same delta instead of letting them steer/chase — otherwise the
   *  whole formation visibly fans in from the old position. Threshold
   *  mirrors client/src/core/entity-interpolator.ts's TELEPORT_THRESHOLD_SQ
   *  (kept in sync by convention — see cfg.teleportThreshold's comment). */
  setPose(x, y, z, heading) {
    if (!this._spawned) {
      this.cx = x; this.cy = y; this.cz = z; this.heading = heading;
      this._spawnInitial();
      this._trail.push({ x: this.cx, z: this.cz });
      return;
    }

    // Transport §6: while LOADED the sim may keep streaming the carrier's
    // pose, stop streaming entirely, or resume after an arbitrary gap — none
    // of that is a teleport (there are no visible members to shift anyway,
    // every member is released) and running the teleport-guard here would
    // reseed the trail right before the unload un-hide reads it. Track the
    // raw pose and stop; onUnitUnloaded (or the UNLOADING transition) resets
    // cx/cz to the drop point directly, deliberately bypassing this path.
    if (this.transportState === 'LOADED') {
      this.cx = x; this.cy = y; this.cz = z; this.heading = heading;
      return;
    }

    const dx = x - this.cx, dz = z - this.cz;
    const teleportSq = this.cfg.teleportThreshold * this.cfg.teleportThreshold;
    const teleport = (dx * dx + dz * dz) > teleportSq;

    this.cx = x; this.cy = y; this.cz = z; this.heading = heading;

    if (teleport) {
      for (const m of this.members) {
        if (!m.alive || m.released) continue;
        m.x += dx; m.z += dz;
        // Air never ground-snaps (§6) — its altitude catch-up (air-cohesion.js)
        // re-settles Y toward the (possibly also-jumped) cruise band next frame.
        if (this.profile.steerer !== 'air') m.y = this.backend.groundHeight(m.x, m.z);
      }
      // Reseed the trail so members don't try to follow a stale corridor
      // across the map (pathfinding §9 pitfall — "trail starvation").
      this._trail.length = 0;
      this._trail.push({ x: this.cx, z: this.cz });
      // The shift above already moved every member to match the new
      // centroid — advance the governor's baseline too, or a later coast()
      // would read this same jump as an unapplied delta and shift again.
      this._lastAppliedCx = this.cx; this._lastAppliedCz = this.cz;
    } else {
      this._recordTrail();
    }
  }

  /** Strength on snapshot change only — runs casualty reconciliation.
   *  LATENCY-STANDIN: `applyAtFrame` is a stub for scheduling the reconcile
   *  on the presentation timeline once PLAN-latency L1 (foreknown
   *  resolve_frame) lands (§8) — accepted but ignored, applied immediately,
   *  same stub shape as PLAN-metalstorm-squad-sync.md task 6's
   *  `syncStrength`/`setPose` split. Revisit both together when L1 lands. */
  setStrength(health, maxHealth, nowSec, applyAtFrame) {
    if (applyAtFrame != null) warnLatencyStandin();
    this.health = health; this.maxHealth = maxHealth || 1;
    // Reconciling before the roster exists would read an empty `members`
    // array and incorrectly zero aliveCount; `_spawnInitial` itself sizes
    // the initial roster from current health (§6), so skip here.
    if (this._spawned) this._reconcileCount(nowSec);
  }

  /** Record an impact as a casualty-alignment hint (§4): a small ring, not a
   *  single slot, so overlapping blasts inside the same window both stay
   *  selectable — `_validImpact` resolves which one to use at kill time. */
  reportImpact(x, z, nowSec) {
    this._impacts.push({ x, z, t: nowSec });
    if (this._impacts.length > this.cfg.impactHintRingSize) this._impacts.shift();
  }

  /** Update the flank-selection bearing (§5) from the best available source
   *  for a damage-bearing event: a visible attacker's position, or (weaker)
   *  a visible projectile's origin — the caller resolves which and passes
   *  its world position. Callers must simply NOT call this for a fully-fog
   *  event (no visible attacker/projectile): §6 forbids inferring a bearing
   *  from bare damage, so leaving `_lastThreatDir` alone and letting the
   *  fallback ladder (§3.3) handle it is the correct behaviour, not a gap.
   *  Smoothed (blend + renormalise) so simultaneous multi-attacker fire
   *  doesn't snap the bearing frame to frame. */
  reportThreat(x, z) {
    const dx = x - this.cx, dz = z - this.cz;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return; // attacker reported on top of the centroid — no usable bearing
    const nx = dx / len, nz = dz / len;
    if (!this._threatDirKnown) {
      this._lastThreatDir.x = nx; this._lastThreatDir.z = nz;
      this._threatDirKnown = true;
      return;
    }
    const g = this.cfg.threatDirSmoothing;
    const bx = this._lastThreatDir.x + (nx - this._lastThreatDir.x) * g;
    const bz = this._lastThreatDir.z + (nz - this._lastThreatDir.z) * g;
    const blen = Math.hypot(bx, bz) || 1;
    this._lastThreatDir.x = bx / blen; this._lastThreatDir.z = bz / blen;
  }

  // --- breadcrumb trail (pathfinding §4) ----------------------------------

  _recordTrail() {
    const last = this._trail[this._trail.length - 1];
    if (!last || Math.hypot(this.cx - last.x, this.cz - last.z) >= this.cfg.trailSampleDist) {
      this._trail.push({ x: this.cx, z: this.cz });
      if (this._trail.length > this.cfg.trailMaxPoints) this._trail.shift();
    }
  }

  /** Nearest trail point to `member`, stepped `lookahead` samples toward the
   *  squad's current position (higher index = more recent). Null if the
   *  squad has no trail yet (e.g. hasn't moved since spawn). */
  trailPointAhead(member, lookahead = 1) {
    const trail = this._trail;
    if (trail.length === 0) return null;
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < trail.length; i++) {
      const d = (trail[i].x - member.x) ** 2 + (trail[i].z - member.z) ** 2;
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return trail[Math.min(trail.length - 1, bestI + lookahead)];
  }

  // --- LOD ↔ instance lifecycle (§5) --------------------------------------

  get lod() { return this._lod; }

  /** full ↔ centroid keeps instances (just stops/starts steering, §9);
   *  full ↔ icon releases/rebuilds them (Pitfall #2) — aliveCount is
   *  untouched either way (Pitfall #3), only visual instances come and go. */
  set lod(value) {
    if (value === this._lod) return;
    const prev = this._lod;
    this._lod = value;
    // Re-base the §12a hysteresis on whatever just happened, so an out-of-band
    // write (a test, syncSquad's `state.lod`, SquadManager.setLod) doesn't get
    // undone by a stale pending transition on the next camera frame.
    this._lodState.tier = value;
    this._lodState.want = value;
    this._lodState.dwell = 0;
    if (!this._spawned) return;
    if (prev !== LOD_ICON && value === LOD_ICON) this._releaseInstances();
    else if (prev === LOD_ICON && value !== LOD_ICON) this._rebuildInstances();
  }

  _releaseInstances() {
    for (const m of this.members) {
      if (!m.alive || m.released) continue;
      this.backend.releaseMember(m.handle);
      m.handle = -1;
      m.released = true;
    }
  }

  /** Re-entering `full`/`centroid` rebuilds exactly the still-alive members
   *  at their slots (dead members stay dead — Pitfall #3, no resurrection). */
  _rebuildInstances() {
    for (const m of this.members) {
      if (!m.alive || !m.released) continue;
      slotToWorld(this.slots[m.slot], this.cx, this.cz, this.heading, _slotW);
      m.x = _slotW.x; m.z = _slotW.z;
      m.y = this.backend.groundHeight(m.x, m.z);
      m.handle = this.backend.createMember(this.id, m.slot, m.visual);
      m.released = false;
    }
    // Members now sit at slots relative to the CURRENT centroid — re-base the
    // governor's coast() baseline (§14 S2) or a coast on the next full-tier
    // frame would re-apply however far the centroid drifted while icon,
    // double-shifting members that `slotToWorld` already placed correctly.
    this._lastAppliedCx = this.cx; this._lastAppliedCz = this.cz;
  }

  // --- spawning / casualties ---------------------------------------------

  /** First spawn (H4/§6): sizes the roster straight from current strength —
   *  only `curve(health/maxHealth)` members are ever brought alive/rendered.
   *  A late-join/reconnect squad therefore reconstructs at the right count
   *  with the rest simply absent, never "replayed" dying via destroyMember. */
  _spawnInitial() {
    const f = this.maxHealth > 0 ? this.health / this.maxHealth : 1;
    const initialAlive = this.cfg.countCurve(f, this.size);
    for (let i = 0; i < this.size; i++) {
      const m = new Member(i, { defId: this.def.defId, variant: i % 4 });
      // Owning squad id (collision §2): compared against a neighbour's
      // squadId to pick the same-/other-squad separation weight. Real ids
      // are always defined, so a pseudo-member (repulsor/wreck/dense-cell
      // aggregate, which carries no squadId) can never false-match.
      m.squadId = this.id;
      // Seed at its slot so the squad doesn't fan out from a point on spawn.
      slotToWorld(this.slots[i], this.cx, this.cz, this.heading, _slotW);
      m.x = _slotW.x; m.z = _slotW.z;
      if (this.profile.steerer === 'air') {
        // Air never ground-snaps (§6) — seed directly at its cruise-altitude
        // band so it doesn't visibly rise from the ground on first spawn.
        const band = i - (this.size - 1) / 2;
        m.altitudeOffset = band * this.profile.altitudeBandStep;
        m.y = this.cy + this.profile.cruiseAltitude + m.altitudeOffset;
      } else {
        m.y = this.backend.groundHeight(m.x, m.z);
      }
      if (i < initialAlive) {
        // A squad can first appear already at icon tier (spawned off-screen or
        // far away — §12a). Skip straight to `released` rather than creating an
        // instance the very next `lod` write would release; _rebuildInstances
        // creates it if the camera ever comes close.
        if (this._lod === LOD_ICON) m.released = true;
        else m.handle = this.backend.createMember(this.id, i, m.visual);
      } else {
        m.alive = false;    // absent from the start, no death animation (§6)
      }
      this.members.push(m);
    }
    this.aliveCount = initialAlive;
    this._spawned = true;
    // Members are already positioned consistent with the spawn centroid.
    this._lastAppliedCx = this.cx; this._lastAppliedCz = this.cz;
  }

  /** Strength → target alive count, clamped monotonic-down (no resurrection).
   *  Two presentation regimes (§2): a valid impact hint means an AoE just
   *  landed here → kill the whole batch together, clustered at the blast
   *  (burst). No hint means attrition (statistical fire, damage fields) →
   *  spread the same batch out over a short window instead (stagger) so it
   *  reads as a firefight, not a synchronized pop. */
  _reconcileCount(nowSec) {
    const f = this.health / this.maxHealth;
    const computed = this.cfg.countCurve(f, this.size);
    const target = Math.min(this.aliveCount, computed);   // never increases
    const killCount = this.aliveCount - target;
    if (killCount <= 0) return;

    const hint = this._validImpact(nowSec);
    const victims = this._selectVictims(killCount, hint);
    this.aliveCount = target;   // bookkeeping is authoritative now; FX may lag (stagger)

    if (hint) {
      for (const v of victims) {
        const d = this._deathDirFor(v, hint);
        this._killMember(v, d.x, d.z);
      }
    } else {
      this._enqueueStaggeredDeaths(victims, nowSec);
    }
    this._repackIfEnabled();
  }

  /** Scored victim selection (§3), living && non-released members only.
   *  Priority ladder: impact-aligned (nearest to a valid hint) → threat-
   *  directional (furthest along the known bearing — the exposed flank
   *  takes it) → fallback (no hint, no bearing — §6 fog of war: never
   *  back-infer the attacker from bare damage; stable pseudo-random over
   *  member id, preferring outermost members so the formation core
   *  persists). Partial-select (`selectTopN`) rather than a full sort —
   *  `count` is small in the common case. */
  _selectVictims(count, hint) {
    const living = this.members.filter((m) => m.alive);
    if (living.length === 0) return [];
    const n = Math.min(count, living.length);

    if (hint) {
      return selectTopN(living, n, (m) => (m.x - hint.x) ** 2 + (m.z - hint.z) ** 2);
    }
    if (this._threatDirKnown) {
      const d = this._lastThreatDir;
      return selectTopN(living, n, (m) => -(m.x * d.x + m.z * d.z));
    }
    return selectTopN(living, n, (m) => this._fallbackScore(m));
  }

  _fallbackScore(m) {
    const slot = this.slots[m.slot];
    return -slotDist2(slot) * 1e6 + pseudoRandom(m.id);
  }

  /** Death-FX direction for a victim under the same priority ladder as
   *  selection (§3): radiating from the impact point, along the known
   *  threat bearing, or (fallback/fog, §6) radiating outward from the
   *  squad centroid — never derived from a hidden attacker's position. */
  _deathDirFor(victim, hint) {
    if (hint) return { x: victim.x - hint.x, z: victim.z - hint.z };
    if (this._threatDirKnown) return this._lastThreatDir;
    return { x: victim.x - this.cx, z: victim.z - this.cz };
  }

  /** Kill one member right now: bookkeeping + destroy-FX/wreck together
   *  (burst mode, or the final undeferred cascade in `destroy`). */
  _killMember(victim, dirX, dirZ) {
    victim.alive = false;
    this._playDeathFx(victim, dirX, dirZ);
  }

  /** Play a victim's destroy-FX + wreck. A released (LOD-icon) member has
   *  no live instance — nothing to play death FX on or drop a wreck from;
   *  the count still drops silently. Split out from `_killMember` so the
   *  stagger queue can defer *only* this part while `alive`/`aliveCount`
   *  update immediately (§2). */
  _playDeathFx(victim, dirX, dirZ) {
    if (victim.released) return;
    const len = Math.hypot(dirX, dirZ) || 1;
    this.backend.destroyMember(victim.handle, {
      x: victim.x, y: victim.y, z: victim.z,
      dirX: dirX / len, dirZ: dirZ / len,
    });
    const handle = this.backend.spawnWreck(victim.x, victim.y, victim.z, victim.headingY, victim.visual);
    // Manager-level wreck pool (§9): TTL/fade/global cap live there, keyed
    // off the handle spawnWreck returns.
    this.onWreck?.(victim.x, victim.z, {
      y: victim.y, headingY: victim.headingY, visual: victim.visual,
      handle, squadId: this.id,
    });
  }

  /** Queue victims for staggered death (§2): resolved now (bookkeeping-wise)
   *  but their FX drips out via `_drainDeathQueue` over ≈50-120ms/each so
   *  attrition doesn't read as a single synchronized bomb. */
  _enqueueStaggeredDeaths(victims, nowSec) {
    if (victims.length === 0) return;
    if (this._deathQueue.length === 0) this._nextStaggerAt = nowSec + this._staggerInterval();
    for (const v of victims) {
      const d = this._deathDirFor(v, null);
      v.alive = false;
      this._deathQueue.push({ member: v, dirX: d.x, dirZ: d.z });
    }
  }

  _staggerInterval() {
    const { staggerIntervalMinSec: lo, staggerIntervalMaxSec: hi } = this.cfg;
    return lo + this.cfg.random() * (hi - lo);
  }

  /** Drain the stagger queue at its own pace, independent of reconcile
   *  timing — called once per render frame from `update`. */
  _drainDeathQueue(nowSec) {
    while (this._deathQueue.length && nowSec >= this._nextStaggerAt) {
      const { member, dirX, dirZ } = this._deathQueue.shift();
      this._playDeathFx(member, dirX, dirZ);
      if (this._deathQueue.length) this._nextStaggerAt = nowSec + this._staggerInterval();
    }
  }

  /** Multiple impacts can be valid at once (§4 — overlapping blasts must
   *  both register, not just the most recent). Prunes expired entries off
   *  the front of the ring (chronological order), then picks the one
   *  nearest this squad's centroid; a tie favours the more recent entry. */
  _validImpact(nowSec) {
    const ring = this._impacts;
    if (nowSec != null) {
      while (ring.length && nowSec - ring[0].t > this.cfg.impactHintWindowSec) ring.shift();
    }
    if (ring.length === 0) return null;
    let best = ring[0], bd = Infinity;
    for (const imp of ring) {
      const d = (imp.x - this.cx) ** 2 + (imp.z - this.cz) ** 2;
      if (d <= bd) { bd = d; best = imp; }   // <= : later (more recent) wins ties
    }
    return best;
  }

  // --- re-pack on casualty (cohesion §4, off by default) -------------------

  /** Reassign surviving members from outermost occupied slots to innermost
   *  empty ones. Event-triggered only (never runs continuously), so it can't
   *  oscillate frame-to-frame; the actual move is a gradual glide (§10 —
   *  `_repackT`/`repackRatePerSec` interpolate the local slot offset), not a
   *  snap. */
  _repackIfEnabled() {
    if (!this.cfg.repackOnCasualty) return;
    const living = this.members.filter((m) => m.alive);
    if (living.length === 0) return;

    const occupied = new Set(living.map((m) => m.slot));
    const empties = [];
    for (let i = 0; i < this.size; i++) if (!occupied.has(i)) empties.push(i);
    if (empties.length === 0) return;

    empties.sort((a, b) => slotDist2(this.slots[a]) - slotDist2(this.slots[b]));
    const outward = living.slice().sort(
      (a, b) => slotDist2(this.slots[b.slot]) - slotDist2(this.slots[a.slot]),
    );

    const n = Math.min(empties.length, outward.length);
    for (let i = 0; i < n; i++) {
      const m = outward[i];
      const newSlot = empties[i];
      if (slotDist2(this.slots[newSlot]) < slotDist2(this.slots[m.slot])) {
        m._repackFromSlot = m.slot;
        m._repackT = 0;
        m.slot = newSlot;
      }
    }
  }

  // --- transport (squad-transport.md §2, §5, §6) --------------------------

  /** Sim `UnitLoaded(squadUnit, transportUnit)` callin (§6 — the real event
   *  path once streamed, or the manager-level heuristic fallback). Begins
   *  BOARDING: members path to the transport, then release (§2) once
   *  arrived or the board-time cap expires (§7 pitfall — never chase a
   *  moving transport forever). No-op if already boarding/loaded so a
   *  duplicate/replayed event can't restart the timer. */
  onUnitLoaded(carrierId, tx, ty, tz) {
    if (this.transportState === 'BOARDING' || this.transportState === 'LOADED') return;
    this.transportState = 'BOARDING';
    this._transportTargetX = tx; this._transportTargetY = ty; this._transportTargetZ = tz;
    this._transportElapsed = 0;
  }

  /** Sim `UnitUnloaded(squadUnit, pos)` callin (§6). Drops at `(x,y,z)`
   *  (sim-authoritative), projected onto the nearest passable cell for this
   *  squad's move class if a passability grid is available (§5 pitfall —
   *  paradrop onto impassable terrain). `airborne` (§5) spawns members at
   *  the carrier's altitude and lets them parachute down instead of landing
   *  immediately. Re-forms exactly `aliveCount` members (§4) — dead members
   *  stay dead. No-op if the squad wasn't boarding/loaded (stray/duplicate
   *  event). */
  onUnitUnloaded(x, y, z, airborne = false, passability = null) {
    if (this.transportState !== 'BOARDING' && this.transportState !== 'LOADED') return;
    const drop = projectDropPoint(x, z, passability, this.profile.moveClass, this.cfg.slotProjectionCap);
    this.cx = drop.x; this.cz = drop.z; this.cy = y;
    this.transportState = 'UNLOADING';
    this._transportElapsed = 0;
    this._transportParadrop = airborne;
    // Fresh corridor from the drop point — the old trail belongs to wherever
    // the squad was before boarding and would bias re-form steering toward a
    // stale path across the map (pathfinding §9 "trail starvation").
    this._trail.length = 0;
    this._trail.push({ x: this.cx, z: this.cz });
    this._spawnAtDropPoint(airborne);
  }

  /** UNLOADING re-spawn (§2, §4): rebuild every still-alive member at the
   *  drop point, scattered (§2 "spill") rather than snapped straight to
   *  formation — the normal steering path (update()) then re-forms them
   *  exactly like any other slot arrival. Dead members are never recreated
   *  (Pitfall #3, the monotonic aliveCount invariant — no resurrection).
   *  Releases any instance a member still holds first (idempotent even if
   *  called from mid-BOARDING, not just from LOADED). */
  _spawnAtDropPoint(airborne) {
    for (const m of this.members) {
      if (!m.alive) continue;
      if (!m.released && m.handle !== -1) this.backend.releaseMember(m.handle);
      const local = scatterSlot(this.slots[m.slot], this.cfg.transportSpillMul, m.id);
      slotToWorld(local, this.cx, this.cz, this.heading, _slotW);
      m.x = _slotW.x; m.z = _slotW.z;
      m.y = airborne ? this.cy : this.backend.groundHeight(m.x, m.z);
      m.handle = this.backend.createMember(this.id, m.slot, m.visual);
      m.released = false;
    }
    // Members now match the drop-point centroid — same governor-baseline
    // reasoning as the teleport-guard shift in setPose.
    this._lastAppliedCx = this.cx; this._lastAppliedCz = this.cz;
  }

  /** Per-frame transport driver, called from update() before the normal
   *  steering branch. Returns true if the squad is fully under transport
   *  control this frame (caller must skip normal FREE steering — §2
   *  "suppress steering while LOADED"); UNLOADING returns false once its
   *  paradrop (if any) has landed so the normal ground/naval/air stepper
   *  re-forms the spill via ordinary slot arrival. */
  _updateTransport(dt) {
    if (this.transportState === 'FREE') return false;
    this._transportElapsed += dt;

    if (this.transportState === 'BOARDING') {
      const maxSpeed = this.def.maxSpeed * this.cfg.memberSpeedMultiplier;
      let allArrived = true;
      for (const m of this.members) {
        if (!m.alive || m.released) continue;
        const d2 = (this._transportTargetX - m.x) ** 2 + (this._transportTargetZ - m.z) ** 2;
        if (d2 > this.cfg.arrivalRadius ** 2) allArrived = false;
        arrive(m.x, m.z, this._transportTargetX, this._transportTargetZ, maxSpeed, this.cfg.arrivalRadius, _arr);
        m.integrate(_arr.x, _arr.z, dt, this.backend);
        this.backend.updateMember(m.handle, m.x, m.y, m.z, m.headingY, m.gait);
      }
      if (allArrived || this._transportElapsed >= this.cfg.transportBoardTimeSec) {
        this._releaseInstances();
        this.transportState = 'LOADED';
      }
      return true;
    }

    if (this.transportState === 'LOADED') return true; // members released — nothing to steer

    // UNLOADING: a paradrop falls straight down first (no horizontal drift
    // while airborne — a deliberate cosmetic simplification); once landed
    // (or immediately, for a ground/naval unload) fall through to normal
    // steering so the spill re-forms via ordinary slot arrival.
    if (this._transportParadrop) {
      let allLanded = true;
      for (const m of this.members) {
        if (!m.alive || m.released) continue;
        const groundY = this.backend.groundHeight(m.x, m.z);
        if (!descendStep(m, groundY, this.cfg.paradropDescentRatePerSec, dt)) allLanded = false;
      }
      if (!allLanded) return true;
    }
    if (this._transportElapsed >= this.cfg.transportUnloadSettleSec) this.transportState = 'FREE';
    return false;
  }

  // --- per-frame update ---------------------------------------------------

  /** Steer + integrate living members. `neighbourQuery` yields nearby members
   *  (this squad + others) for separation; supplied by the manager.
   *  `passability` (optional — the manager may not have one built yet) is
   *  the shared grid from passability.js; ground/naval steerers query it,
   *  air ignores it entirely (pathfinding §6).
   *  `bigUnits` (PLAN-metalstorm-flow.md §4, task 3/4) is an array of
   *  BigUnitRepulsor instances (scale-4 super-heavies / footprint-profile
   *  buildings) to thread around/under; supplied by the manager.
   *  `ladderLevel` (§12c, §14 S2, default 0) is the frame-time governor's
   *  degrade level — L1 drops inter-squad separation, L2 drops separation
   *  entirely, L3 additionally drops the potential field. `forceCentroidStep`
   *  (L6's "demote farthest third", chosen by the manager from cached
   *  screenPx — see SquadManager.update) runs this step as a cheap centroid
   *  park WITHOUT touching `lod` — same reasoning as the tier-based branch
   *  just below, so the release/rebuild GPU churn stays camera-owned. */
  update(dt, nowSec, neighbourQuery, passability, bigUnits = NO_BIG_UNITS, ladderLevel = 0, forceCentroidStep = false) {
    this._drainDeathQueue(nowSec);
    if (this._updateTransport(dt)) return; // BOARDING/LOADED: transport owns the frame
    // Icon tier costs nothing per member BY CONSTRUCTION (§5's table): every
    // member is released, so there is no instance to move and no steering to
    // run — the backend draws one marker at the centroid instead (§12b).
    // Casualties still land: _drainDeathQueue above and setStrength/_reconcileCount
    // are event-time, not part of this loop (squad-sync §5 pitfall 3).
    if (this._lod === LOD_ICON) return;
    if (this._lod !== LOD_FULL) return this._updateCentroid();
    if (forceCentroidStep) return this._updateCentroid();

    const skipInterSquadSeparation = ladderLevel >= 1;
    const skipSeparation = ladderLevel >= 2;
    const skipPotentialField = ladderLevel >= 3;

    if (this._prevUpdateCx != null && dt > 1e-6) {
      this._centroidSpeed = Math.hypot(this.cx - this._prevUpdateCx, this.cz - this._prevUpdateCz) / dt;
      this._headingRate = Math.abs(wrapAngle(this.heading - this._prevUpdateHeading)) / dt;
    }
    this._prevUpdateCx = this.cx; this._prevUpdateCz = this.cz; this._prevUpdateHeading = this.heading;

    const maxSpeed = this.def.maxSpeed * this.cfg.memberSpeedMultiplier;
    const leash = this.def.formationRadius * this.cfg.maxMemberDistance;
    const softLeashDist = this.def.formationRadius * (this.profile.softLeash ?? 1.2);
    const inTurn = this._headingRate > this.cfg.turnTrailBiasRateThreshold;
    // moveinfo.tdf CLASS.name, shared by BOTH consumers: passability queries
    // (pathfinding §2) and footprint-underpass checks (flow §3/§4). A def-
    // level moveClass (main's flow-test mock / future F1 wiring) overrides
    // the profile-derived one; the vocabularies are identical by design —
    // see movement-profiles.js's header.
    const moveClass = this.def.moveClass ?? this.profile.moveClass;

    for (const m of this.members) {
      if (!m.alive) continue;

      // Slot target, with a gradual repack glide if one is in flight (§4).
      let localSlot = this.slots[m.slot];
      if (m._repackT < 1) {
        m._repackT = Math.min(1, m._repackT + this.cfg.repackRatePerSec * dt);
        const from = this.slots[m._repackFromSlot];
        localSlot = {
          x: from.x + (localSlot.x - from.x) * m._repackT,
          z: from.z + (localSlot.z - from.z) * m._repackT,
        };
      }
      slotToWorld(localSlot, this.cx, this.cz, this.heading, _slotW);

      if (this.profile.steerer === 'air') {
        this._airStep(m, dt, nowSec, maxSpeed);
        continue;
      }

      // Ground/naval share passability-aware target selection: project the
      // slot to the nearest passable cell (cliff-edge tuck, §3), detect
      // chokepoint constraint, and bias toward the breadcrumb trail in
      // COLUMN mode, mid-turn, or while recovering from being stuck.
      let target = _slotW;
      if (passability && moveClass) {
        target = passability.nearestPassable(_slotW.x, _slotW.z, moveClass, this.cfg.slotProjectionCap);
      }
      const constrained = passability && moveClass
        ? this._isConstrained(m, _slotW, target, passability, moveClass)
        : false;
      this._updateMode(m, constrained);

      const trailPt = this.trailPointAhead(m);
      if (trailPt && (m.mode === 'COLUMN' || m.recoveryLevel >= 1 || inTurn)) {
        target = trailPt;
      }

      if (this.profile.steerer === 'naval') {
        this._navalStep(m, dt, target, trailPt, maxSpeed, softLeashDist, leash, neighbourQuery,
          skipSeparation, skipInterSquadSeparation);
      } else {
        // Big-unit threading (flow §4) lives inside the ground steerer —
        // air members overfly hulls and naval members never share terrain
        // with a land walker (documented divergence from the pre-steerer
        // loop, which applied it to every member unconditionally).
        this._groundStep(m, dt, target, maxSpeed, softLeashDist, leash, passability, moveClass, neighbourQuery, bigUnits,
          skipSeparation, skipInterSquadSeparation, skipPotentialField);
      }
    }
  }

  // --- ground steerer (default) -------------------------------------------

  _groundStep(m, dt, target, maxSpeed, softLeashDist, leash, passability, moveClass, neighbourQuery, bigUnits = NO_BIG_UNITS,
    skipSeparation = false, skipInterSquadSeparation = false, skipPotentialField = false) {
    arrive(m.x, m.z, target.x, target.z, maxSpeed, this.cfg.arrivalRadius, _arr);

    if (m.recoveryLevel >= 2 || skipSeparation) { _sep.x = 0; _sep.z = 0; }
    else {
      separate(m.x, m.z, m.squadId, neighbourQuery(m), this.cfg.separationRadius,
        this.cfg.separationWeightSameSquad, this.cfg.separationWeightOtherSquad,
        this.cfg.separationDeadband, _sep, !skipInterSquadSeparation);
    }

    softLeashPull(m.x, m.z, this.cx, this.cz, softLeashDist, this.cfg.softLeashGain, _leash);

    _potential.x = 0; _potential.z = 0;
    if (!skipPotentialField && passability && moveClass) this._potentialField(m, passability, _potential);

    // Big-unit threading (PLAN-metalstorm-flow.md §4): hull bow-wave by
    // default; swap to the animated contact-patch repulsor set while
    // legitimately threading under a hull (underpass-eligible moveClass).
    _big.x = 0; _big.z = 0;
    let underHull = false;
    for (const bu of bigUnits) {
      if (isUnderHull(m, bu, moveClass)) {
        underHull = true;
        patchPush(m, bu, this.cfg, _big);
      } else {
        hullPush(m, bu, this.cfg, _big);
      }
    }

    _desired.x = _arr.x * this.cfg.arrivalWeight + _sep.x * this.cfg.separationWeight * maxSpeed
               + _leash.x + _potential.x * this.cfg.potentialFieldWeight
               + _big.x * this.cfg.bigUnitWeight * maxSpeed;
    _desired.z = _arr.z * this.cfg.arrivalWeight + _sep.z * this.cfg.separationWeight * maxSpeed
               + _leash.z + _potential.z * this.cfg.potentialFieldWeight
               + _big.z * this.cfg.bigUnitWeight * maxSpeed;
    // Speed penalty while under a permeable hull — mirrors the sim's ×2
    // traversal cost for underpass classes (flow.md §3).
    clampLen(_desired, underHull ? maxSpeed * this.cfg.underHullSpeedPenalty : maxSpeed);

    m.integrate(_desired.x, _desired.z, dt, this.backend);
    this._applyHardLeash(m, leash);

    if (bigUnits.length > 0) {
      // Panic clause (flow §4): a foot about to plant on a member hard-pushes
      // it clear — final authority over position this frame, so cohesion can
      // never drag a member back under a planted foot. Re-checks isUnderHull
      // per big unit rather than trusting the pre-integration flag above: the
      // leash clamp can change a member's hull status by moving it.
      for (const bu of bigUnits) {
        if (isUnderHull(m, bu, moveClass)) panicClamp(m, bu);
      }
      // Y-clamp (flow §4): no climbing the hull — always the ground sample,
      // never a stale value from before the leash/panic clamps moved the member.
      m.y = this.backend.groundHeight(m.x, m.z);
    }

    this._trackStuck(m, target);
    this.backend.updateMember(m.handle, m.x, m.y, m.z, m.headingY, m.gait);
  }

  // --- naval steerer -------------------------------------------------------

  _navalStep(m, dt, target, trailPt, maxSpeed, softLeashDist, leash, neighbourQuery,
    skipSeparation = false, skipInterSquadSeparation = false) {
    const desired = navalSteer(this, m, dt, {
      profile: this.profile, slotWorld: target, columnTarget: trailPt,
      centroidSpeed: this._centroidSpeed,
    });

    if (m.recoveryLevel >= 2 || skipSeparation) { _sep.x = 0; _sep.z = 0; }
    else {
      separate(m.x, m.z, m.squadId, neighbourQuery(m), this.cfg.separationRadius,
        this.cfg.separationWeightSameSquad, this.cfg.separationWeightOtherSquad,
        this.cfg.separationDeadband, _sep, !skipInterSquadSeparation);
    }
    softLeashPull(m.x, m.z, this.cx, this.cz, softLeashDist, this.cfg.softLeashGain, _leash);

    _desired.x = desired.x + _sep.x * this.cfg.separationWeight * maxSpeed + _leash.x;
    _desired.z = desired.z + _sep.z * this.cfg.separationWeight * maxSpeed + _leash.z;
    clampLen(_desired, maxSpeed);

    // blend=1: naval-cohesion already turn-rate-capped the heading; the
    // generic damped blend in Member.integrate would smooth it a second time.
    m.integrate(_desired.x, _desired.z, dt, this.backend, 1);
    this._applyHardLeash(m, leash);
    // Cosmetic sub dive offset. NOTE (deviation flagged): this sinks the
    // member below `backend.groundHeight`, i.e. below the seabed reading,
    // not below a true water-surface plane — the RenderBackend contract has
    // no water-surface sampler yet, only ground height. Acceptable for a
    // cosmetic depth cue at this stage; revisit if/when a water-plane Y
    // source is wired for ship surface rendering too.
    if (this.profile.moveClass === 'SUB') m.y += m.depth;
    this._trackStuck(m, target);
    this.backend.updateMember(m.handle, m.x, m.y, m.z, m.headingY, m.gait);
  }

  // --- air steerer -----------------------------------------------------------

  _airStep(m, dt, nowSec, maxSpeed) {
    const desired = airSteer(this, m, dt, {
      profile: this.profile, slotWorld: _slotW, nowSec, centroidSpeed: this._centroidSpeed,
    });
    m.integrateAir(desired.x, desired.y, desired.z, dt);
    // Air has no hard-leash ground-height dependency; still guarantee
    // "squad stays together" via the same world-space clamp (§1 layer 3).
    const leash = this.def.formationRadius * this.cfg.maxMemberDistance;
    const dx = m.x - this.cx, dz = m.z - this.cz;
    const d = Math.hypot(dx, dz);
    if (d > leash) { const s = leash / d; m.x = this.cx + dx * s; m.z = this.cz + dz * s; }
    this.backend.updateMember(m.handle, m.x, m.y, m.z, m.headingY, m.gait);
  }

  // --- pathfinding helpers (ground/naval) -----------------------------------

  /** True if the member's slot is projected away from its raw position
   *  (slot itself impassable) or the direct line to the raw slot crosses
   *  impassable cells (a chokepoint narrower than the formation, §4). */
  _isConstrained(m, rawSlot, projected, passability, moveClass) {
    if (projected.x !== rawSlot.x || projected.z !== rawSlot.z) return true;
    const steps = 4;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = m.x + (rawSlot.x - m.x) * t, z = m.z + (rawSlot.z - m.z) * t;
      if (!passability.passable(x, z, moveClass)) return true;
    }
    return false;
  }

  /** Mode hysteresis (§4 pitfall — no oscillation at a gap mouth): requires
   *  K consecutive frames of the new state before switching. */
  _updateMode(m, constrained) {
    const want = constrained ? 'COLUMN' : 'FORMATION';
    if (m.mode === want) { m._modeStreak = 0; return; }
    if (++m._modeStreak >= this.cfg.modeHysteresisFrames) { m.mode = want; m._modeStreak = 0; }
  }

  /** Negative-gradient lateral steer around costly terrain (§5): sample cost
   *  either side of a forward-lookahead point and push toward the cheaper
   *  side. Cheap (2 grid lookups), composes additively with arrival. */
  _potentialField(m, passability, out) {
    const speed = Math.hypot(m.vx, m.vz);
    const dirX = speed > 1e-3 ? m.vx / speed : 0;
    const dirZ = speed > 1e-3 ? m.vz / speed : 1;
    const ahead = this.cfg.potentialFieldLookahead, d = this.cfg.potentialFieldSampleDist;
    const fx = m.x + dirX * ahead, fz = m.z + dirZ * ahead;
    const cLeft = passability.cost(fx - dirZ * d, fz + dirX * d);
    const cRight = passability.cost(fx + dirZ * d, fz - dirX * d);
    const lateral = cLeft - cRight; // positive => right is cheaper
    out.x = dirZ * lateral;
    out.z = -dirX * lateral;
  }

  /** Stuck detection + recovery ladder (§8): distance-to-target hasn't
   *  decreased over N frames while beyond arrivalRadius. Escalates through
   *  (1) heavier trail-follow bias, (2) also drop separation, (3) teleport-
   *  snap toward the trail — but ONLY if the backend reports the member is
   *  not on-screen (never teleport a visible member). */
  _trackStuck(m, target) {
    const distSq = (target.x - m.x) ** 2 + (target.z - m.z) ** 2;
    const arrivalR2 = this.cfg.arrivalRadius ** 2;
    if (distSq > arrivalR2 && distSq >= m._lastTargetDistSq - 1e-3) m._stuckFrames++;
    else m._stuckFrames = 0;
    m._lastTargetDistSq = distSq;

    let level = 0;
    if (m._stuckFrames > this.cfg.stuckFramesTrailBoost) level = 1;
    if (m._stuckFrames > this.cfg.stuckFramesIgnoreSeparation) level = 2;
    if (m._stuckFrames > this.cfg.stuckFramesTeleport) {
      const onScreen = this.backend.isOnScreen ? this.backend.isOnScreen(m.x, m.y, m.z) : false;
      if (!onScreen) {
        const pt = this.trailPointAhead(m) || target;
        m.x = pt.x; m.z = pt.z; m.y = this.backend.groundHeight(m.x, m.z);
        m._stuckFrames = 0; m._lastTargetDistSq = Infinity;
        level = 0;
      }
    }
    m.recoveryLevel = level;
  }

  _applyHardLeash(m, leash) {
    const dx = m.x - this.cx, dz = m.z - this.cz;
    const d = Math.hypot(dx, dz);
    if (d > leash) {
      const s = leash / d;
      m.x = this.cx + dx * s; m.z = this.cz + dz * s;
      m.y = this.backend.groundHeight(m.x, m.z);
    }
  }

  /** Governor time-slicing (§12c/§12d, §14 S2): this `full`-tier squad's
   *  turn to skip its real steer step this frame. Rigid-shift every
   *  alive+unreleased member by the centroid delta accumulated since it
   *  last actually stepped (or last coasted), preserving formation shape —
   *  a coasting squad still visibly tracks the battle instead of freezing
   *  (§12d: "a frozen squad would be instantly visible", which is what would
   *  make ½/¼-rate stepping look wrong instead of merely cheaper). No matrix
   *  writes when the centroid hasn't moved. Death-queue drain still runs
   *  here (event-time, §14 S1's squad-sync §5 pitfall 3 — casualties must
   *  land on every frame, stepped or coasted); transport is NOT handled
   *  here because a non-FREE squad bypasses time-slicing entirely (the
   *  manager always calls `update()`, never `coast()`, while boarding/
   *  loaded/unloading — see SquadManager.update). */
  coast(nowSec) {
    this._drainDeathQueue(nowSec);
    const dx = this.cx - this._lastAppliedCx, dz = this.cz - this._lastAppliedCz;
    this._lastAppliedCx = this.cx; this._lastAppliedCz = this.cz;
    if (dx === 0 && dz === 0) return;
    for (const m of this.members) {
      if (!m.alive || m.released) continue;
      m.x += dx; m.z += dz;
      m.y = this.backend.groundHeight(m.x, m.z);
      this.backend.updateMember(m.handle, m.x, m.y, m.z, m.headingY, m.gait);
    }
  }

  /** LOD fallback: park living members at the centroid (no steering cost).
   *  Released (icon-tier) members have no instance and are skipped. Also
   *  serves ladder L6's forced centroid step on an otherwise-full squad
   *  (§14 S2) — either way, members end up exactly at the centroid, so
   *  re-basing `_lastAppliedCx/Cz` here keeps coast()'s delta correct
   *  whenever this squad later resumes normal full-tier stepping. */
  _updateCentroid() {
    for (const m of this.members) {
      if (!m.alive || m.released) continue;
      m.x = this.cx; m.y = this.cy; m.z = this.cz; m.headingY = this.heading;
      this.backend.updateMember(m.handle, m.x, m.y, m.z, m.headingY, 0);
    }
    this._lastAppliedCx = this.cx; this._lastAppliedCz = this.cz;
  }

  /** Squad destroyed: cascade-kill remaining members (§7). Aligns to the
   *  killing blast if a recent impact hint exists, else the known threat
   *  bearing, else blows outward from the centroid (never reveals a hidden
   *  attacker — §6). Any still-queued staggered deaths are folded into the
   *  cascade immediately (played now, not at their scheduled pace) — a wipe
   *  must not leave those instances' FX/wreck never played. */
  destroy(nowSec) {
    const hint = this._validImpact(nowSec);

    for (const { member, dirX, dirZ } of this._deathQueue) this._playDeathFx(member, dirX, dirZ);
    this._deathQueue.length = 0;

    for (const m of this.members) {
      if (!m.alive) continue;
      m.alive = false;
      const d = this._deathDirFor(m, hint);
      this._playDeathFx(m, d.x, d.z);
    }
    this.aliveCount = 0;
  }

  *memberPositions() { for (const m of this.members) if (m.alive && !m.released) yield m; }
}

// --- helpers ---------------------------------------------------------------

function slotDist2(slot) { return slot.x * slot.x + slot.z * slot.z; }

// Deterministic per-id pseudo-random in [0,1) (squad-casualties §3.3):
// stable across repeated calls (no reshuffling frame-to-frame) but not
// synced across clients/spectators — cosmetic tie-break only.
function pseudoRandom(id) {
  const x = Math.sin(id * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// Partial top-N selection via repeated min-scan (§3 pitfall: "partial-select
// for small counts beats a full sort"). O(n*k); killCount is small in the
// common case, so this beats an O(n log n) sort of the whole living roster.
function selectTopN(list, n, scoreFn) {
  const pool = list.slice();
  const out = [];
  for (let k = 0; k < n; k++) {
    let bestI = 0, bestScore = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const s = scoreFn(pool[i]);
      if (s < bestScore) { bestScore = s; bestI = i; }
    }
    out.push(pool[bestI]);
    pool.splice(bestI, 1);
  }
  return out;
}

// One-time LATENCY-STANDIN warn for the applyAtFrame stub (setStrength).
let _warnedLatencyStandin = false;
function warnLatencyStandin() {
  if (_warnedLatencyStandin) return;
  _warnedLatencyStandin = true;
  console.warn('[LATENCY-STANDIN] Squad.setStrength: applyAtFrame is accepted but ignored ' +
    '(reconcile applies immediately) until PLAN-latency.md L1 lands.');
}
