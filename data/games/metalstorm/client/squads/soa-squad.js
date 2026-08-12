// soa-squad.js — SquadRec (per-squad record) for the SoA squad engine.
// PLAN-metalstorm-squad-performance.md §10e. Event-time logic only (sync,
// casualties, LOD release/rebuild, transport) ported from squad.js; the
// per-frame member STEPPING kernel is milestone S4 (§11) — `update()` here
// only drains the death-stagger queue and ticks the transport timer, so
// SquadManager can drive a SoA squad uniformly with an OO one before the
// kernel exists. Store mutation goes through soa-store.js's flag helpers;
// nothing here allocates per member per frame (member counts are small
// per-squad and this all runs at sync/casualty cadence, not per render frame).

import { allocRun, freeRun, isAlive, isReleased, setAlive, setReleased } from './soa-store.js';
import { buildSlots, slotToWorld } from './formation.js';
import { profileFor } from './movement-profiles.js';
import { projectDropPoint, scatterSlot } from './squad-transport.js';

// Formation templates are identical for every squad of a def (§10e) — split
// into Float32 pairs once per "type:size:radius" and shared.
const _slotCache = new Map();
function slotsFor(type, size, radius) {
  const key = `${type}:${size}:${radius}`;
  let cached = _slotCache.get(key);
  if (cached) return cached;
  const slots = buildSlots(type, size, radius);
  const slotsX = new Float32Array(size), slotsZ = new Float32Array(size);
  for (let i = 0; i < size; i++) { slotsX[i] = slots[i].x; slotsZ[i] = slots[i].z; }
  cached = { slotsX, slotsZ };
  _slotCache.set(key, cached);
  return cached;
}

// Deterministic per-id pseudo-random (squad-casualties §3.3) — same formula
// as squad.js so fallback victim ordering is bit-identical between engines
// (S6 parity depends on this).
function pseudoRandom(id) {
  const x = Math.sin(id * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function slotDist2(sq, localSlot) {
  const x = sq.slotsX[localSlot], z = sq.slotsZ[localSlot];
  return x * x + z * z;
}

const _slotW = { x: 0, z: 0 };

/** World position of local formation slot `localSlot` for `sq`'s current pose. */
function slotWorldFor(sq, localSlot, out) {
  return slotToWorld({ x: sq.slotsX[localSlot], z: sq.slotsZ[localSlot] }, sq.cx, sq.cz, sq.heading, out);
}

export class SquadRec {
  /** @param store soa-store.js store  @param backend RenderBackend  @param cfg merged config */
  constructor(store, id, def, backend, cfg) {
    this.store = store;
    this.backend = backend;
    this.cfg = cfg;
    this.id = id;
    this.def = def;
    this.profile = profileFor(def?.customParams?.ms_class);

    this.size = Math.max(1, def.squadSize | 0);
    this.base = allocRun(store, this.size);
    const { slotsX, slotsZ } = slotsFor(def.formationType, this.size, def.formationRadius);
    this.slotsX = slotsX; this.slotsZ = slotsZ;

    this.cx = 0; this.cy = 0; this.cz = 0;
    this.heading = 0;
    this.health = 1; this.maxHealth = 1;
    this.aliveCount = this.size;
    this.spawned = false;

    this._lod = 'full';
    this._lodD2 = 0; // manager's member-budget LOD ranking key (shared w/ OO Squad)
    this.iconAlive = -1;
    this.iconOrder = null;

    this.impacts = [];                    // { x, z, t }[]
    this.threatDir = { x: 0, z: 1 };
    this.threatDirKnown = false;

    this.deathQueue = [];                 // { slot, dirX, dirZ }[]
    this.nextStaggerAt = 0;

    this.trail = [];                      // { x, z }[]

    this.transportState = 'FREE';
    this.transportTargetX = 0; this.transportTargetY = 0; this.transportTargetZ = 0;
    this.transportElapsed = 0;
    this.transportParadrop = false;
    this.transportHeuristic = false;

    this.onWreck = null;                  // installed by SquadManager, same seam as OO Squad
  }

  get lod() { return this._lod; }

  /** full ↔ centroid keeps instances; full ↔ icon thins to `iconMemberCount`
   *  (§12b). aliveCount is untouched either way (squad-sync §5 Pitfall #3). */
  set lod(value) {
    if (value === this._lod) return;
    const prev = this._lod;
    this._lod = value;
    if (!this.spawned) return;
    if (value === 'icon') applyIconVisibility(this.store, this, this.backend);
    else if (prev === 'icon') rebuildAllInstances(this.store, this, this.backend);
  }

  setPose(x, y, z, heading) {
    if (!this.spawned) {
      this.cx = x; this.cy = y; this.cz = z; this.heading = heading;
      spawnInitial(this.store, this, this.backend);
      this.trail.push({ x: this.cx, z: this.cz });
      return;
    }
    if (this.transportState === 'LOADED') {
      this.cx = x; this.cy = y; this.cz = z; this.heading = heading;
      return;
    }
    const dx = x - this.cx, dz = z - this.cz;
    const teleportSq = this.cfg.teleportThreshold * this.cfg.teleportThreshold;
    const teleport = (dx * dx + dz * dz) > teleportSq;
    this.cx = x; this.cy = y; this.cz = z; this.heading = heading;
    if (teleport) {
      const store = this.store;
      for (let i = this.base; i < this.base + this.size; i++) {
        if (!isAlive(store, i) || isReleased(store, i)) continue;
        store.mx[i] += dx; store.mz[i] += dz;
        if (this.profile.steerer !== 'air') store.my[i] = this.backend.groundHeight(store.mx[i], store.mz[i]);
      }
      this.trail.length = 0;
      this.trail.push({ x: this.cx, z: this.cz });
    } else {
      recordTrail(this);
    }
  }

  setStrength(health, maxHealth, nowSec /* , applyAtFrame — latency stub, ignored like squad.js */) {
    this.health = health; this.maxHealth = maxHealth || 1;
    if (this.spawned) reconcileCount(this.store, this, this.backend, nowSec);
  }

  reportImpact(x, z, nowSec) {
    this.impacts.push({ x, z, t: nowSec });
    if (this.impacts.length > this.cfg.impactHintRingSize) this.impacts.shift();
  }

  reportThreat(x, z) {
    const dx = x - this.cx, dz = z - this.cz;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return;
    const nx = dx / len, nz = dz / len;
    if (!this.threatDirKnown) {
      this.threatDir.x = nx; this.threatDir.z = nz;
      this.threatDirKnown = true;
      return;
    }
    const g = this.cfg.threatDirSmoothing;
    const bx = this.threatDir.x + (nx - this.threatDir.x) * g;
    const bz = this.threatDir.z + (nz - this.threatDir.z) * g;
    const blen = Math.hypot(bx, bz) || 1;
    this.threatDir.x = bx / blen; this.threatDir.z = bz / blen;
  }

  // --- transport (squad-transport.md §2, §6) ------------------------------

  onUnitLoaded(carrierId, tx, ty, tz) {
    if (this.transportState === 'BOARDING' || this.transportState === 'LOADED') return;
    this.transportState = 'BOARDING';
    this.transportTargetX = tx; this.transportTargetY = ty; this.transportTargetZ = tz;
    this.transportElapsed = 0;
  }

  onUnitUnloaded(x, y, z, airborne = false, passability = null) {
    if (this.transportState !== 'BOARDING' && this.transportState !== 'LOADED') return;
    const drop = projectDropPoint(x, z, passability, this.profile.moveClass, this.cfg.slotProjectionCap);
    this.cx = drop.x; this.cz = drop.z; this.cy = y;
    this.transportState = 'UNLOADING';
    this.transportElapsed = 0;
    this.transportParadrop = airborne;
    this.trail.length = 0;
    this.trail.push({ x: this.cx, z: this.cz });
    spawnAtDropPoint(this.store, this, this.backend, airborne);
  }

  // --- per-frame (no kernel yet — S4 replaces the transport/steering body) -

  /** Extra args (neighbourQuery/passability/bigUnits) accepted and ignored —
   *  SquadManager drives every squad with the same call shape regardless of
   *  engine (§10a). Only the event-time pieces that don't need real stepping
   *  run here: the death-stagger drip and the transport state timer. */
  update(dt, nowSec) {
    drainDeathQueue(this.store, this, this.backend, nowSec);
    tickTransport(this, dt);
  }

  destroy(nowSec) {
    const store = this.store;
    const hint = validImpact(this, nowSec);
    for (const { slot, dirX, dirZ } of this.deathQueue) playDeathFx(store, this, this.backend, slot, dirX, dirZ);
    this.deathQueue.length = 0;
    for (let i = this.base; i < this.base + this.size; i++) {
      if (!isAlive(store, i)) continue;
      setAlive(store, i, false);
      const d = deathDirFor(store, this, i, hint);
      playDeathFx(store, this, this.backend, i, d.x, d.z);
    }
    this.aliveCount = 0;
    // Order load-bearing (§10d): cascade first (reads positions for FX),
    // slots already freed by the cascade above, THEN return the run.
    freeRun(store, this.base, this.size);
  }

  // Grid insertion for a SoA squad goes through soa-grid.js directly against
  // the store (§11c) — this generator is a harmless stub so SquadManager's
  // shared (OO-oriented) `_rebuildGrid` loop doesn't have to special-case the
  // engine when it calls `sq.memberPositions()` on every squad it owns.
  *memberPositions() {}
}

// --- construction --------------------------------------------------------

function spawnInitial(store, sq, backend) {
  const f = sq.maxHealth > 0 ? sq.health / sq.maxHealth : 1;
  const initialAlive = sq.cfg.countCurve(f, sq.size);
  const isAir = sq.profile.steerer === 'air';
  for (let i = 0; i < sq.size; i++) {
    const slot = sq.base + i;
    slotWorldFor(sq, i, _slotW);
    store.mx[slot] = _slotW.x; store.mz[slot] = _slotW.z;
    store.mHeading[slot] = sq.heading;
    store.mSlot[slot] = i;
    store.mRepackFrom[slot] = -1;
    store.mRepackT[slot] = 1;
    store.mLastDist2[slot] = Infinity;
    if (isAir) {
      const band = i - (sq.size - 1) / 2;
      store.mAltOff[slot] = band * sq.profile.altitudeBandStep;
      store.my[slot] = sq.cy + sq.profile.cruiseAltitude + store.mAltOff[slot];
    } else {
      store.my[slot] = backend.groundHeight(store.mx[slot], store.mz[slot]);
    }
    const alive = i < initialAlive;
    setAlive(store, slot, alive);
    setReleased(store, slot, false);
    if (alive) {
      store.mPool[slot] = backend.createMember(sq.id, i, visualFor(sq, i));
    } else {
      store.mPool[slot] = -1;
    }
  }
  sq.aliveCount = initialAlive;
  sq.spawned = true;
}

function visualFor(sq, localSlot) {
  return { defId: sq.def.defId, variant: localSlot % 4 };
}

// --- breadcrumb trail (pathfinding §4) -----------------------------------

function recordTrail(sq) {
  const last = sq.trail[sq.trail.length - 1];
  if (!last || Math.hypot(sq.cx - last.x, sq.cz - last.z) >= sq.cfg.trailSampleDist) {
    sq.trail.push({ x: sq.cx, z: sq.cz });
    if (sq.trail.length > sq.cfg.trailMaxPoints) sq.trail.shift();
  }
}

// --- LOD ↔ instance lifecycle (§5) ---------------------------------------

function releaseSlot(store, sq, backend, slot) {
  backend.releaseMember(store.mPool[slot]);
  store.mPool[slot] = -1;
  setReleased(store, slot, true);
}

function rebuildSlot(store, sq, backend, slot) {
  const localSlot = store.mSlot[slot];
  slotWorldFor(sq, localSlot, _slotW);
  store.mx[slot] = _slotW.x; store.mz[slot] = _slotW.z;
  store.my[slot] = backend.groundHeight(store.mx[slot], store.mz[slot]);
  store.mPool[slot] = backend.createMember(sq.id, localSlot, visualFor(sq, localSlot));
  setReleased(store, slot, false);
}

function applyIconVisibility(store, sq, backend) {
  sq.iconAlive = sq.aliveCount;
  const keep = Math.max(0, sq.cfg.iconMemberCount | 0);
  if (!sq.iconOrder) {
    sq.iconOrder = [];
    for (let i = sq.base; i < sq.base + sq.size; i++) sq.iconOrder.push(i);
    sq.iconOrder.sort((a, b) => slotDist2(sq, store.mSlot[a]) - slotDist2(sq, store.mSlot[b]));
  }
  let shown = 0;
  for (const slot of sq.iconOrder) {
    if (!isAlive(store, slot)) continue;
    if (shown < keep) {
      if (isReleased(store, slot)) rebuildSlot(store, sq, backend, slot);
      shown++;
    } else if (!isReleased(store, slot)) {
      releaseSlot(store, sq, backend, slot);
    }
  }
}

/** Release EVERY member's instance (transport LOADED) — distinct from the
 *  `icon` tier's partial release above. */
function releaseAllInstances(store, sq, backend) {
  for (let i = sq.base; i < sq.base + sq.size; i++) {
    if (!isAlive(store, i) || isReleased(store, i)) continue;
    releaseSlot(store, sq, backend, i);
  }
  sq.iconAlive = -1;
}

function rebuildAllInstances(store, sq, backend) {
  for (let i = sq.base; i < sq.base + sq.size; i++) {
    if (!isAlive(store, i) || !isReleased(store, i)) continue;
    rebuildSlot(store, sq, backend, i);
  }
}

// --- casualties (squad-casualties §2-§6) ---------------------------------

let _candidates = new Int32Array(0);
function ensureCandidates(n) { if (_candidates.length < n) _candidates = new Int32Array(n); }

function scoreVictim(store, sq, slot, hint) {
  if (hint) {
    const dx = store.mx[slot] - hint.x, dz = store.mz[slot] - hint.z;
    return dx * dx + dz * dz;
  }
  if (sq.threatDirKnown) {
    return -(store.mx[slot] * sq.threatDir.x + store.mz[slot] * sq.threatDir.z);
  }
  return -slotDist2(sq, store.mSlot[slot]) * 1e6 + pseudoRandom(slot - sq.base);
}

/** Partial top-N selection (§3), living members only, over a reused scratch
 *  candidate array (§11b) — O(n*k) min-scan + swap-remove, matching
 *  squad.js's selectTopN shape without a fresh array/slice per call. */
function selectVictimSlots(store, sq, count, hint) {
  ensureCandidates(sq.size);
  let poolLen = 0;
  for (let i = sq.base; i < sq.base + sq.size; i++) if (isAlive(store, i)) _candidates[poolLen++] = i;
  const n = Math.min(count, poolLen);
  const out = [];
  for (let k = 0; k < n; k++) {
    let bestJ = 0, bestScore = Infinity;
    for (let j = 0; j < poolLen; j++) {
      const s = scoreVictim(store, sq, _candidates[j], hint);
      if (s < bestScore) { bestScore = s; bestJ = j; }
    }
    out.push(_candidates[bestJ]);
    poolLen--;
    _candidates[bestJ] = _candidates[poolLen];
  }
  return out;
}

function deathDirFor(store, sq, slot, hint) {
  if (hint) return { x: store.mx[slot] - hint.x, z: store.mz[slot] - hint.z };
  if (sq.threatDirKnown) return sq.threatDir;
  return { x: store.mx[slot] - sq.cx, z: store.mz[slot] - sq.cz };
}

function playDeathFx(store, sq, backend, slot, dirX, dirZ) {
  if (isReleased(store, slot)) return;
  const len = Math.hypot(dirX, dirZ) || 1;
  backend.destroyMember(store.mPool[slot], {
    x: store.mx[slot], y: store.my[slot], z: store.mz[slot],
    dirX: dirX / len, dirZ: dirZ / len,
  });
  store.mPool[slot] = -1;
  const visual = visualFor(sq, store.mSlot[slot]);
  const handle = sq.backend.spawnWreck(store.mx[slot], store.my[slot], store.mz[slot], store.mHeading[slot], visual);
  sq.onWreck?.(store.mx[slot], store.mz[slot], {
    y: store.my[slot], headingY: store.mHeading[slot], visual, handle, squadId: sq.id,
  });
}

function staggerInterval(cfg) {
  const { staggerIntervalMinSec: lo, staggerIntervalMaxSec: hi } = cfg;
  return lo + Math.random() * (hi - lo);
}

function enqueueStaggeredDeaths(store, sq, victims, nowSec) {
  if (victims.length === 0) return;
  if (sq.deathQueue.length === 0) sq.nextStaggerAt = nowSec + staggerInterval(sq.cfg);
  for (const slot of victims) {
    const d = deathDirFor(store, sq, slot, null);
    setAlive(store, slot, false);
    sq.deathQueue.push({ slot, dirX: d.x, dirZ: d.z });
  }
}

function drainDeathQueue(store, sq, backend, nowSec) {
  while (sq.deathQueue.length && nowSec >= sq.nextStaggerAt) {
    const { slot, dirX, dirZ } = sq.deathQueue.shift();
    playDeathFx(store, sq, backend, slot, dirX, dirZ);
    if (sq.deathQueue.length) sq.nextStaggerAt = nowSec + staggerInterval(sq.cfg);
  }
}

function validImpact(sq, nowSec) {
  const ring = sq.impacts;
  if (nowSec != null) {
    while (ring.length && nowSec - ring[0].t > sq.cfg.impactHintWindowSec) ring.shift();
  }
  if (ring.length === 0) return null;
  let best = ring[0], bd = Infinity;
  for (const imp of ring) {
    const d = (imp.x - sq.cx) ** 2 + (imp.z - sq.cz) ** 2;
    if (d <= bd) { bd = d; best = imp; }
  }
  return best;
}

function reconcileCount(store, sq, backend, nowSec) {
  const f = sq.health / sq.maxHealth;
  const computed = sq.cfg.countCurve(f, sq.size);
  const target = Math.min(sq.aliveCount, computed);
  const killCount = sq.aliveCount - target;
  if (killCount <= 0) return;

  const hint = validImpact(sq, nowSec);
  const victims = selectVictimSlots(store, sq, killCount, hint);
  sq.aliveCount = target;

  if (hint) {
    for (const slot of victims) {
      const d = deathDirFor(store, sq, slot, hint);
      setAlive(store, slot, false);
      playDeathFx(store, sq, backend, slot, d.x, d.z);
    }
  } else {
    enqueueStaggeredDeaths(store, sq, victims, nowSec);
  }
  repackIfEnabled(store, sq);
}

/** Reassign surviving members from outermost occupied slots to innermost
 *  empty ones (cohesion §4, off by default). Event-triggered only. */
function repackIfEnabled(store, sq) {
  if (!sq.cfg.repackOnCasualty) return;
  const living = [];
  for (let i = sq.base; i < sq.base + sq.size; i++) if (isAlive(store, i)) living.push(i);
  if (living.length === 0) return;

  const occupied = new Set(living.map((i) => store.mSlot[i]));
  const empties = [];
  for (let i = 0; i < sq.size; i++) if (!occupied.has(i)) empties.push(i);
  if (empties.length === 0) return;

  empties.sort((a, b) => slotDist2(sq, a) - slotDist2(sq, b));
  const outward = living.slice().sort(
    (a, b) => slotDist2(sq, store.mSlot[b]) - slotDist2(sq, store.mSlot[a]),
  );

  const n = Math.min(empties.length, outward.length);
  for (let i = 0; i < n; i++) {
    const slot = outward[i];
    const newLocalSlot = empties[i];
    if (slotDist2(sq, newLocalSlot) < slotDist2(sq, store.mSlot[slot])) {
      store.mRepackFrom[slot] = store.mSlot[slot];
      store.mRepackT[slot] = 0;
      store.mSlot[slot] = newLocalSlot;
    }
  }
}

// --- transport (squad-transport.md §2, §6) -------------------------------

function spawnAtDropPoint(store, sq, backend, airborne) {
  for (let i = sq.base; i < sq.base + sq.size; i++) {
    if (!isAlive(store, i)) continue;
    if (!isReleased(store, i) && store.mPool[i] !== -1) backend.releaseMember(store.mPool[i]);
    const localSlot = store.mSlot[i];
    const local = scatterSlot({ x: sq.slotsX[localSlot], z: sq.slotsZ[localSlot] }, sq.cfg.transportSpillMul, i - sq.base);
    slotToWorld(local, sq.cx, sq.cz, sq.heading, _slotW);
    store.mx[i] = _slotW.x; store.mz[i] = _slotW.z;
    store.my[i] = airborne ? sq.cy : backend.groundHeight(store.mx[i], store.mz[i]);
    store.mPool[i] = backend.createMember(sq.id, localSlot, visualFor(sq, localSlot));
    setReleased(store, i, false);
  }
  sq.iconAlive = -1;
}

/** Timer-only transport driver — no real steering exists yet (S4), so
 *  BOARDING can't detect "members arrived at the carrier" the way squad.js
 *  does; it simply waits out `transportBoardTimeSec`, and a paradrop's
 *  descent is skipped (settles on `transportUnloadSettleSec` instead). Both
 *  simplifications are visual-fidelity gaps the S4 kernel port closes, not
 *  correctness gaps in the state machine itself (FREE/BOARDING/LOADED/
 *  UNLOADING transitions and their side effects — release/rebuild/aliveCount
 *  — are exact). */
function tickTransport(sq, dt) {
  if (sq.transportState === 'FREE') return;
  sq.transportElapsed += dt;
  if (sq.transportState === 'BOARDING') {
    if (sq.transportElapsed >= sq.cfg.transportBoardTimeSec) {
      releaseAllInstances(sq.store, sq, sq.backend);
      sq.transportState = 'LOADED';
    }
    return;
  }
  if (sq.transportState === 'LOADED') return;
  if (sq.transportElapsed >= sq.cfg.transportUnloadSettleSec) sq.transportState = 'FREE';
}

// --- factory --------------------------------------------------------------

export function createSquadRec(store, id, def, backend, cfg) {
  return new SquadRec(store, id, def, backend, cfg);
}
