// squad.js — one squad: the bridge between the single authoritative sim unit
// and its many cosmetic members. See PLAN-metalstorm-squads.md §8, §9.

import { Member } from './member.js';
import { buildSlots, slotToWorld } from './formation.js';
import { arrive, separate, clampLen } from './steering.js';

// Reused scratch objects — the per-frame loops must not allocate (§7 perf).
const _slotW = { x: 0, z: 0 };
const _arr = { x: 0, z: 0 };
const _sep = { x: 0, z: 0 };
const _desired = { x: 0, z: 0 };

export class Squad {
  /**
   * @param {number} id             sim unit id (authoritative)
   * @param {object} def            { defId, squadSize, formationType, formationRadius, maxSpeed }
   * @param {RenderBackend} backend
   * @param {object} cfg            DEFAULT_CONFIG (merged)
   */
  constructor(id, def, backend, cfg) {
    this.id = id;
    this.def = def;
    this.backend = backend;
    this.cfg = cfg;

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

    this.lod = 'full';                  // 'full' | 'centroid' | 'icon'
    this._spawned = false;
  }

  // --- ingest -------------------------------------------------------------

  /** Mirror authoritative state from an entity-stream update. */
  sync(state) {
    this.cx = state.x; this.cy = state.y; this.cz = state.z;
    this.heading = state.heading;
    this.health = state.health; this.maxHealth = state.maxHealth || 1;
    if (!this._spawned) this._spawnInitial();
    this._reconcileCount();
  }

  /** Record an impact as a casualty-alignment hint (§8). */
  reportImpact(x, z, nowSec) { this._impact = { x, z, t: nowSec }; }

  // --- spawning / casualties ---------------------------------------------

  _spawnInitial() {
    for (let i = 0; i < this.size; i++) {
      const m = new Member(i, { defId: this.def.defId, variant: i % 4 });
      // Seed at its slot so the squad doesn't fan out from a point on spawn.
      slotToWorld(this.slots[i], this.cx, this.cz, this.heading, _slotW);
      m.x = _slotW.x; m.z = _slotW.z;
      m.y = this.backend.groundHeight(m.x, m.z);
      m.handle = this.backend.createMember(this.id, i, m.visual);
      this.members.push(m);
    }
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
    const len = Math.hypot(dirX, dirZ) || 1;
    this.backend.destroyMember(victim.handle, {
      x: victim.x, y: victim.y, z: victim.z,
      dirX: dirX / len, dirZ: dirZ / len,
    });
    this.backend.spawnWreck(victim.x, victim.y, victim.z, victim.headingY, victim.visual);
  }

  _validImpact(nowSec) {
    if (!this._impact) return null;
    if (nowSec != null && nowSec - this._impact.t > this.cfg.impactHintWindowSec) {
      this._impact = null; return null;
    }
    return this._impact;
  }

  // --- per-frame update ---------------------------------------------------

  /** Steer + integrate living members. `neighbourQuery` yields nearby members
   *  (this squad + others) for separation; supplied by the manager. */
  update(dt, nowSec, neighbourQuery) {
    if (this.lod !== 'full') return this._updateCentroid();

    const maxSpeed = this.def.maxSpeed * this.cfg.memberSpeedMultiplier;
    const leash = this.def.formationRadius * this.cfg.maxMemberDistance;

    for (const m of this.members) {
      if (!m.alive) continue;

      slotToWorld(this.slots[m.slot], this.cx, this.cz, this.heading, _slotW);
      arrive(m.x, m.z, _slotW.x, _slotW.z, maxSpeed, this.cfg.arrivalRadius, _arr);
      separate(m.x, m.z, neighbourQuery(m), this.cfg.separationRadius, _sep);

      _desired.x = _arr.x * this.cfg.arrivalWeight + _sep.x * this.cfg.separationWeight * maxSpeed;
      _desired.z = _arr.z * this.cfg.arrivalWeight + _sep.z * this.cfg.separationWeight * maxSpeed;
      clampLen(_desired, maxSpeed);

      m.integrate(_desired.x, _desired.z, dt, this.backend);

      // Hard cohesion leash (§9): never let a member stray off the squad body.
      const dx = m.x - this.cx, dz = m.z - this.cz;
      const d = Math.hypot(dx, dz);
      if (d > leash) {
        const s = leash / d;
        m.x = this.cx + dx * s; m.z = this.cz + dz * s;
        m.y = this.backend.groundHeight(m.x, m.z);
      }

      this.backend.updateMember(m.handle, m.x, m.y, m.z, m.headingY, m.gait);
    }
  }

  /** LOD fallback: park living members at the centroid (no steering cost). */
  _updateCentroid() {
    for (const m of this.members) {
      if (!m.alive) continue;
      m.x = this.cx; m.y = this.cy; m.z = this.cz; m.headingY = this.heading;
      this.backend.updateMember(m.handle, m.x, m.y, m.z, m.headingY, 0);
    }
  }

  /** Squad destroyed: cascade-kill remaining members (§8.5). */
  destroy(nowSec) {
    for (const m of this.members) {
      if (!m.alive) continue;
      m.alive = false;
      const d = this._lastThreatDir;
      this.backend.destroyMember(m.handle, { x: m.x, y: m.y, z: m.z, dirX: d.x, dirZ: d.z });
      this.backend.spawnWreck(m.x, m.y, m.z, m.headingY, m.visual);
    }
    this.aliveCount = 0;
  }

  *memberPositions() { for (const m of this.members) if (m.alive) yield m; }
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
