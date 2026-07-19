// squad.js — one squad: the bridge between the single authoritative sim unit
// and its many cosmetic members. See PLAN-metalstorm-squads.md §8, §9,
// PLAN-metalstorm-squad-cohesion.md, PLAN-metalstorm-squad-pathfinding.md.

import { Member } from './member.js';
import { buildSlots, slotToWorld } from './formation.js';
import { arrive, separate, clampLen, wrapAngle, softLeashPull } from './steering.js';
import { profileFor } from './movement-profiles.js';
import { steerMember as airSteer } from './air-cohesion.js';
import { steerMember as navalSteer } from './naval-cohesion.js';

// Reused scratch objects — the per-frame loops must not allocate (§7 perf).
// New passability-aware terms (projection/potential-field results, air/naval
// ctx objects) DO allocate small short-lived objects; that's an accepted
// trade for this milestone — PLAN-metalstorm-squad-performance.md is
// explicitly gated to run only after this (and collision) are visually
// correct and profiled, not before.
const _slotW = { x: 0, z: 0 };
const _arr = { x: 0, z: 0 };
const _sep = { x: 0, z: 0 };
const _leash = { x: 0, z: 0 };
const _potential = { x: 0, z: 0 };
const _desired = { x: 0, z: 0 };

export class Squad {
  /**
   * @param {number} id             sim unit id (authoritative)
   * @param {object} def            { defId, squadSize, formationType, formationRadius, maxSpeed,
   *                                   customParams? } — customParams.ms_class selects the
   *                                   movement profile (movement-profiles.js).
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

    // Casualty-alignment hint: a recent impact near this squad (§8).
    this._impact = null;                // { x, z, t } or null
    this._lastThreatDir = { x: 0, z: 1 };

    this._lod = 'full';                 // 'full' | 'centroid' | 'icon' (see setter below)
    this._spawned = false;

    // Breadcrumb trail (pathfinding §4): ring buffer of recent centroid
    // positions, distance-sampled. Reseeded on a centroid teleport (§3).
    this._trail = [];

    // Centroid kinematics, recomputed once per update() call (turn handling
    // §5, "is the squad holding" for air loiter/naval column bias §6/§7).
    this._prevUpdateCx = null; this._prevUpdateCz = null; this._prevUpdateHeading = 0;
    this._centroidSpeed = 0;
    this._headingRate = 0;
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
    } else {
      this._recordTrail();
    }
  }

  /** Strength on snapshot change only — runs casualty reconciliation.
   *  `applyAtFrame` is a stub for scheduling on the presentation timeline
   *  once PLAN-latency L1 (foreknown resolve_frame) lands (§7); until then
   *  it is accepted but ignored and the reconcile always applies immediately. */
  setStrength(health, maxHealth, nowSec, applyAtFrame) {
    this.health = health; this.maxHealth = maxHealth || 1;
    // Reconciling before the roster exists would read an empty `members`
    // array and incorrectly zero aliveCount; `_spawnInitial` itself sizes
    // the initial roster from current health (§6), so skip here.
    if (this._spawned) this._reconcileCount(nowSec);
  }

  /** Record an impact as a casualty-alignment hint (§8). */
  reportImpact(x, z, nowSec) { this._impact = { x, z, t: nowSec }; }

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
    if (!this._spawned) return;
    if (prev !== 'icon' && value === 'icon') this._releaseInstances();
    else if (prev === 'icon' && value !== 'icon') this._rebuildInstances();
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
        m.handle = this.backend.createMember(this.id, i, m.visual);
      } else {
        m.alive = false;    // absent from the start, no death animation (§6)
      }
      this.members.push(m);
    }
    this.aliveCount = initialAlive;
    this._spawned = true;
  }

  /** Strength → target alive count, clamped monotonic-down (no resurrection). */
  _reconcileCount(nowSec) {
    const f = this.health / this.maxHealth;
    const computed = this.cfg.countCurve(f, this.size);
    const target = Math.min(this.aliveCount, computed);   // never increases
    while (this.aliveCount > target) this._killOne(nowSec);
  }

  /** Select and kill one member, aligned to the blast/threat where possible. */
  _killOne(nowSec) {
    const living = this.members.filter((m) => m.alive);
    if (living.length === 0) { this.aliveCount = 0; return; }

    let victim, dirX, dirZ;
    const hint = this._validImpact(nowSec);
    if (hint) {
      // (a) nearest living member to the impact point.
      victim = nearest(living, hint.x, hint.z);
      dirX = victim.x - hint.x; dirZ = victim.z - hint.z;
    } else {
      // (b) members on the last threat bearing, else (c) arbitrary.
      const d = this._lastThreatDir;
      victim = extreme(living, d.x, d.z);
      dirX = d.x; dirZ = d.z;
    }

    victim.alive = false;
    this.aliveCount--;
    // A released (LOD-icon) member has no live instance — nothing to play
    // death FX on or drop a wreck from; the count still drops silently.
    if (!victim.released) {
      const len = Math.hypot(dirX, dirZ) || 1;
      this.backend.destroyMember(victim.handle, {
        x: victim.x, y: victim.y, z: victim.z,
        dirX: dirX / len, dirZ: dirZ / len,
      });
      this.backend.spawnWreck(victim.x, victim.y, victim.z, victim.headingY, victim.visual);
    }
    this._repackIfEnabled();
  }

  _validImpact(nowSec) {
    if (!this._impact) return null;
    if (nowSec != null && nowSec - this._impact.t > this.cfg.impactHintWindowSec) {
      this._impact = null; return null;
    }
    return this._impact;
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

  // --- per-frame update ---------------------------------------------------

  /** Steer + integrate living members. `neighbourQuery` yields nearby members
   *  (this squad + others) for separation; supplied by the manager.
   *  `passability` (optional — the manager may not have one built yet) is
   *  the shared grid from passability.js; ground/naval steerers query it,
   *  air ignores it entirely (pathfinding §6). */
  update(dt, nowSec, neighbourQuery, passability) {
    if (this.lod !== 'full') return this._updateCentroid();

    if (this._prevUpdateCx != null && dt > 1e-6) {
      this._centroidSpeed = Math.hypot(this.cx - this._prevUpdateCx, this.cz - this._prevUpdateCz) / dt;
      this._headingRate = Math.abs(wrapAngle(this.heading - this._prevUpdateHeading)) / dt;
    }
    this._prevUpdateCx = this.cx; this._prevUpdateCz = this.cz; this._prevUpdateHeading = this.heading;

    const maxSpeed = this.def.maxSpeed * this.cfg.memberSpeedMultiplier;
    const leash = this.def.formationRadius * this.cfg.maxMemberDistance;
    const softLeashDist = this.def.formationRadius * (this.profile.softLeash ?? 1.2);
    const inTurn = this._headingRate > this.cfg.turnTrailBiasRateThreshold;
    const moveClass = this.profile.moveClass;

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
        this._navalStep(m, dt, target, trailPt, maxSpeed, softLeashDist, leash, neighbourQuery);
      } else {
        this._groundStep(m, dt, target, maxSpeed, softLeashDist, leash, passability, moveClass, neighbourQuery);
      }
    }
  }

  // --- ground steerer (default) -------------------------------------------

  _groundStep(m, dt, target, maxSpeed, softLeashDist, leash, passability, moveClass, neighbourQuery) {
    arrive(m.x, m.z, target.x, target.z, maxSpeed, this.cfg.arrivalRadius, _arr);

    if (m.recoveryLevel >= 2) { _sep.x = 0; _sep.z = 0; }
    else separate(m.x, m.z, neighbourQuery(m), this.cfg.separationRadius, _sep);

    softLeashPull(m.x, m.z, this.cx, this.cz, softLeashDist, this.cfg.softLeashGain, _leash);

    _potential.x = 0; _potential.z = 0;
    if (passability && moveClass) this._potentialField(m, passability, _potential);

    _desired.x = _arr.x * this.cfg.arrivalWeight + _sep.x * this.cfg.separationWeight * maxSpeed
               + _leash.x + _potential.x * this.cfg.potentialFieldWeight;
    _desired.z = _arr.z * this.cfg.arrivalWeight + _sep.z * this.cfg.separationWeight * maxSpeed
               + _leash.z + _potential.z * this.cfg.potentialFieldWeight;
    clampLen(_desired, maxSpeed);

    m.integrate(_desired.x, _desired.z, dt, this.backend);
    this._applyHardLeash(m, leash);
    this._trackStuck(m, target);
    this.backend.updateMember(m.handle, m.x, m.y, m.z, m.headingY, m.gait);
  }

  // --- naval steerer -------------------------------------------------------

  _navalStep(m, dt, target, trailPt, maxSpeed, softLeashDist, leash, neighbourQuery) {
    const desired = navalSteer(this, m, dt, {
      profile: this.profile, slotWorld: target, columnTarget: trailPt,
      centroidSpeed: this._centroidSpeed,
    });

    if (m.recoveryLevel >= 2) { _sep.x = 0; _sep.z = 0; }
    else separate(m.x, m.z, neighbourQuery(m), this.cfg.separationRadius, _sep);
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

  /** LOD fallback: park living members at the centroid (no steering cost).
   *  Released (icon-tier) members have no instance and are skipped. */
  _updateCentroid() {
    for (const m of this.members) {
      if (!m.alive || m.released) continue;
      m.x = this.cx; m.y = this.cy; m.z = this.cz; m.headingY = this.heading;
      this.backend.updateMember(m.handle, m.x, m.y, m.z, m.headingY, 0);
    }
  }

  /** Squad destroyed: cascade-kill remaining members (§8.5). */
  destroy(nowSec) {
    for (const m of this.members) {
      if (!m.alive) continue;
      m.alive = false;
      if (!m.released) {
        const d = this._lastThreatDir;
        this.backend.destroyMember(m.handle, { x: m.x, y: m.y, z: m.z, dirX: d.x, dirZ: d.z });
        this.backend.spawnWreck(m.x, m.y, m.z, m.headingY, m.visual);
      }
    }
    this.aliveCount = 0;
  }

  *memberPositions() { for (const m of this.members) if (m.alive && !m.released) yield m; }
}

// --- helpers (no allocation in the hot path) ------------------------------

function nearest(list, x, z) {
  let best = list[0], bd = Infinity;
  for (const m of list) {
    const d = (m.x - x) ** 2 + (m.z - z) ** 2;
    if (d < bd) { bd = d; best = m; }
  }
  return best;
}

// Member furthest along direction (dx,dz) — i.e. on that flank.
function extreme(list, dx, dz) {
  let best = list[0], bp = -Infinity;
  for (const m of list) {
    const p = m.x * dx + m.z * dz;
    if (p > bp) { bp = p; best = m; }
  }
  return best;
}

function slotDist2(slot) { return slot.x * slot.x + slot.z * slot.z; }
