// soa-kernel.js — the allocation-free per-frame stepping kernel for the SoA
// squad engine. PLAN-metalstorm-squad-performance.md §11 (milestone S4).
//
// Every function here is a free function over (store, SquadRec, ...) — nothing
// closes over a typed-array view (§10b: the pool is one ArrayBuffer that can be
// swapped for a SharedArrayBuffer, and a closure over a view would pin the old
// one), and nothing allocates per frame (§11d, the reviewer's lint checklist:
// no `new`, no `{}`/`[]` literals, no spread, no `.map/.filter/.slice`, no
// closures, no generators, no per-member Map access, `Math.sqrt` over
// `Math.hypot`). The only allocations are capacity growth of module-scope
// scratch typed arrays, which happens when the neighbour cap or the squad
// count grows — not per frame.
//
// The math is squad.js's, line for line (§11b's port checklist). squad.js
// stays the oracle: S6's parity suite drives both engines and compares, so a
// "simplification" here is a divergence, not a cleanup.
//
// What is NOT here: casualty selection, LOD release/rebuild, repack election,
// pose ingest — that is event-time code and lives in soa-squad.js. The kernel
// runs once per frame and touches only what moving members need.

import { arrive, clampLen, wrapAngle, softLeashPull, headingFromVelocity } from './steering.js';
import { isUnderHull, hullPush, patchPush, panicClamp } from './big-unit-repulsor.js';
import { steerMemberInto as airSteerInto } from './air-cohesion.js';
import { steerMemberInto as navalSteerInto } from './naval-cohesion.js';
import { queryInto } from './soa-grid.js';
import { MFLAG_ALIVE, MFLAG_RELEASED, MFLAG_COLUMN } from './soa-store.js';
import { drainDeaths, releaseAllMemberInstances, maintainIconRoster } from './soa-squad.js';
import { descendStep } from './squad-transport.js';

// --- the per-frame work list (§12d's schedule) -----------------------------
//
// DEVIATION from §11a, stated rather than silently taken: §11a sketches two
// lists (`stepList` + `coastList`). There are three kinds of frame a squad can
// get, not two — a real step, the REDUCED (centroid) step that the member
// budget's `centroid`/`icon` tiers and ladder L6's forced demotion both land
// on, and the coast — so this is one list plus a per-entry mode. Two lists
// would have had no home for the reduced tier except a third list, which is
// the same thing with more state to keep consistent.
export const STEP_FULL = 0;
export const STEP_CENTROID = 1;
export const STEP_COAST = 2;

export function createSchedule() {
  return {
    count: 0,
    idx: new Int32Array(0),      // index into the caller's dense squad array
    mode: new Uint8Array(0),     // STEP_FULL | STEP_CENTROID | STEP_COAST
    dt: new Float32Array(0),     // per-squad elapsed time (time-slicing, §12d)
    level: 0,                    // governor ladder level (§12c)
    frameNo: 0,                  // drives the grid's stride jitter (§11c)
  };
}

/** Empty the schedule and make room for `n` entries. Growth reallocates (once,
 *  when the squad count grows past the high-water mark) — never per frame. */
export function scheduleReset(schedule, n) {
  if (schedule.idx.length < n) {
    let cap = Math.max(16, schedule.idx.length);
    while (cap < n) cap *= 2;
    schedule.idx = new Int32Array(cap);
    schedule.mode = new Uint8Array(cap);
    schedule.dt = new Float32Array(cap);
  }
  schedule.count = 0;
  return schedule;
}

export function schedulePush(schedule, squadIndex, mode, dt) {
  const k = schedule.count++;
  schedule.idx[k] = squadIndex;
  schedule.mode[k] = mode;
  schedule.dt[k] = dt;
}

// --- module-scope scratch (§11d rule 5) ------------------------------------

// The two sanctioned reused objects (§11b): `_cursor` bridges the array-backed
// member into big-unit-repulsor.js / air-cohesion.js / naval-cohesion.js /
// squad-transport.js, which take a member-shaped object; `_ctx` is the steerer
// context those two cohesion modules read. Loading/storing five scalars beats
// duplicating (and then having to keep in sync) four modules of math.
const _cursor = {
  x: 0, y: 0, z: 0, vx: 0, vz: 0,
  headingY: 0, gait: 0, slot: 0, bank: 0, altitudeOffset: 0, depth: 0,
};
const _ctx = { profile: null, slotWorld: null, columnTarget: null, nowSec: 0, centroidSpeed: 0 };

const _slotW = { x: 0, z: 0 };       // slot target / steerer `slotWorld`
const _trailPt = { x: 0, z: 0 };     // steerer `columnTarget`
const _proj = { x: 0, z: 0 };        // passability projection
const _arr = { x: 0, z: 0 };
const _sep = { x: 0, z: 0 };
const _leash = { x: 0, z: 0 };
const _potential = { x: 0, z: 0 };
const _big = { x: 0, z: 0 };
const _desired = { x: 0, z: 0 };
const _steer = { x: 0, y: 0, z: 0 };

_ctx.slotWorld = _slotW;             // stable identity; only its fields change

// Neighbour query output (soa-grid.js `queryInto` fills these in parallel).
let _nSlot = new Int32Array(0);
let _nX = new Float32Array(0);
let _nZ = new Float32Array(0);
let _nR = new Float32Array(0);

function ensureNeighbourCapacity(cap) {
  if (_nSlot.length >= cap) return;
  _nSlot = new Int32Array(cap);
  _nX = new Float32Array(cap);
  _nZ = new Float32Array(cap);
  _nR = new Float32Array(cap);
}

const ALIVE_MASK = MFLAG_ALIVE | MFLAG_RELEASED;

// --- entry point -----------------------------------------------------------

/**
 * The ONLY per-frame entry (§11a). Drives every squad the schedule names.
 *
 * @param store        soa-store.js store
 * @param squads       dense array of SquadRec (schedule indices point into it)
 * @param grid         soa-grid.js grid, already rebuilt this frame (or null at
 *                     ladder L2+, where separation is dropped for everyone)
 * @param passability  passability.js grid or null
 * @param bigUnits     BigUnitRepulsor[] (already pose-updated this frame)
 * @param backend      RenderBackend — transform writes, groundHeight,
 *                     isOnScreen. S5 replaces the per-member `updateMember`
 *                     call with a direct pool write (§13); everything else the
 *                     kernel asks of it stays.
 * @param dt           frame dt (seconds) — per-squad elapsed time comes from
 *                     the schedule, this is the fallback/repack clock
 * @param nowSec       manager clock
 * @param schedule     createSchedule() work list
 */
export function stepMembers(store, squads, grid, passability, bigUnits, backend, dt, nowSec, schedule) {
  const n = schedule.count;
  if (n === 0) return;
  ensureNeighbourCapacity(Math.max(1, squads[schedule.idx[0]].cfg.neighbourCap | 0));

  for (let k = 0; k < n; k++) {
    const sq = squads[schedule.idx[k]];
    if (sq === undefined) continue;
    const stepDt = schedule.dt[k];

    // S5: a pool that grew or compacted moved the slots this squad's pinned
    // members hold. One integer compare per squad per frame; the re-read runs
    // only when it fires.
    if (sq.directGen !== backend.poolGeneration) resyncDirect(store, sq, backend);

    // Event-time, every frame, stepped or coasted (squad-sync §5 pitfall 3:
    // casualties must land on a coasted frame too).
    drainDeaths(store, sq, backend, nowSec);

    const mode = schedule.mode[k];
    if (mode === STEP_COAST) { coastSquad(store, sq, backend); continue; }

    // Transport owns the frame while BOARDING/LOADED — checked before the tier,
    // exactly like Squad.update, so a reduced-tier squad under a carrier does
    // not get parked at its centroid mid-boarding.
    if (sq.transportState !== 'FREE' && stepTransport(store, sq, backend, stepDt)) continue;

    if (mode === STEP_CENTROID) { centroidStep(store, sq, backend); continue; }
    stepSquad(store, sq, grid, passability, bigUnits, backend, stepDt, nowSec, schedule);
  }
  flushDirtyRanges();
}

// --- per-squad header (§11a) ------------------------------------------------

function stepSquad(store, sq, grid, passability, bigUnits, backend, dt, nowSec, schedule) {
  const cfg = sq.cfg;

  if (sq.prevUpdateCx != null && dt > 1e-6) {
    const dx = sq.cx - sq.prevUpdateCx, dz = sq.cz - sq.prevUpdateCz;
    sq.centroidSpeed = Math.sqrt(dx * dx + dz * dz) / dt;
    sq.headingRate = Math.abs(wrapAngle(sq.heading - sq.prevUpdateHeading)) / dt;
  }
  sq.prevUpdateCx = sq.cx; sq.prevUpdateCz = sq.cz; sq.prevUpdateHeading = sq.heading;

  const maxSpeed = sq.def.maxSpeed * cfg.memberSpeedMultiplier;
  const leash = sq.def.formationRadius * cfg.maxMemberDistance;
  const softLeashDist = sq.def.formationRadius * (sq.profile.softLeash ?? 1.2);
  const inTurn = sq.headingRate > cfg.turnTrailBiasRateThreshold;
  const moveClass = sq.def.moveClass ?? sq.profile.moveClass;
  // sin/cos of the heading hoisted ONCE per squad (§11b) — slotToWorld inlined
  // into each steerer's member loop rather than called per member.
  const sinH = Math.sin(sq.heading), cosH = Math.cos(sq.heading);

  // The ONLY steerer branch, per squad (§11a) — each inner loop below stays
  // monomorphic because nothing re-decides per member.
  switch (sq.steerer) {
    case 2:
      stepAirSquad(store, sq, backend, dt, nowSec, maxSpeed, leash, sinH, cosH);
      break;
    case 1:
      stepNavalSquad(store, sq, grid, backend, dt, maxSpeed, leash, softLeashDist,
        inTurn, moveClass, passability, sinH, cosH, schedule);
      break;
    default:
      stepGroundSquad(store, sq, grid, passability, bigUnits, backend, dt, maxSpeed, leash,
        softLeashDist, inTurn, moveClass, sinH, cosH, schedule);
      break;
  }

  sq.lastAppliedCx = sq.cx; sq.lastAppliedCz = sq.cz;
}

// --- shared stages ---------------------------------------------------------

/** Slot target with the repack glide (§4 cohesion), slotToWorld inlined.
 *  Writes world x/z into `out`. */
function slotTargetInto(store, sq, i, dt, sinH, cosH, out) {
  const localSlot = store.mSlot[i];
  let sx = sq.slotsX[localSlot], sz = sq.slotsZ[localSlot];
  if (store.mRepackT[i] < 1) {
    const t = Math.min(1, store.mRepackT[i] + sq.cfg.repackRatePerSec * dt);
    store.mRepackT[i] = t;
    const from = store.mRepackFrom[i];
    if (from >= 0) {
      const fx = sq.slotsX[from], fz = sq.slotsZ[from];
      sx = fx + (sx - fx) * t;
      sz = fz + (sz - fz) * t;
    }
  }
  out.x = sq.cx + (sx * cosH + sz * sinH);
  out.z = sq.cz + (-sx * sinH + sz * cosH);
  return out;
}

/** Squad._isConstrained over scalars. */
function isConstrained(store, i, rawX, rawZ, projX, projZ, passability, moveClass) {
  if (projX !== rawX || projZ !== rawZ) return true;
  const px = store.mx[i], pz = store.mz[i];
  const steps = 4;
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (!passability.passable(px + (rawX - px) * t, pz + (rawZ - pz) * t, moveClass)) return true;
  }
  return false;
}

/** Squad._updateMode: K consecutive frames before switching (mode is
 *  MFLAG_COLUMN, the streak is mModeStreak). */
function updateMode(store, i, constrained, hysteresisFrames) {
  const isColumn = (store.mFlags[i] & MFLAG_COLUMN) !== 0;
  if (isColumn === constrained) { store.mModeStreak[i] = 0; return; }
  if (++store.mModeStreak[i] >= hysteresisFrames) {
    store.mFlags[i] = constrained ? (store.mFlags[i] | MFLAG_COLUMN) : (store.mFlags[i] & ~MFLAG_COLUMN);
    store.mModeStreak[i] = 0;
  }
}

/** Squad.trailPointAhead as an INDEX into `sq.trail` (-1 = no trail), so the
 *  caller reads x/z without a point object crossing a return boundary. */
function trailIndexAhead(sq, px, pz, lookahead) {
  const trail = sq.trail;
  const n = trail.length;
  if (n === 0) return -1;
  let bestI = 0, bestD = Infinity;
  for (let i = 0; i < n; i++) {
    const p = trail[i];
    const dx = p.x - px, dz = p.z - pz;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; bestI = i; }
  }
  return Math.min(n - 1, bestI + lookahead);
}

/** steering.separate, fully inlined against the CSR grid (§11b): 3x3 cell scan
 *  through soa-grid.js's `queryInto`, then the same distance/deadband/weight
 *  rule. Same-squad test is run membership (`base <= slot < base+size`), which
 *  is what replaces the `squadId` compare — a pseudo-member/dense aggregate
 *  reports slot -1 and therefore always falls to `otherWeight`, exactly as it
 *  does through `separate()`'s `squadId === undefined` path. */
function separateFromGrid(store, sq, grid, i, cfg, sameSquadOnly, out, frameNo) {
  out.x = 0; out.z = 0;
  const cap = cfg.neighbourCap | 0;
  if (cap <= 0 || grid === null) return out;
  ensureNeighbourCapacity(cap);
  const px = store.mx[i], pz = store.mz[i];
  const found = queryInto(grid, store, px, pz, i, cap, _nSlot, _nX, _nZ, _nR, frameNo);
  const base = sq.base, end = sq.base + sq.size;
  const defaultR = cfg.separationRadius;
  const deadband = cfg.separationDeadband;
  const sameW = cfg.separationWeightSameSquad, otherW = cfg.separationWeightOtherSquad;
  let hits = 0;
  for (let k = 0; k < found; k++) {
    const slot = _nSlot[k];
    const same = slot >= base && slot < end;
    if (sameSquadOnly && !same) continue;   // ladder L1
    const dx = px - _nX[k], dz = pz - _nZ[k];
    const d2 = dx * dx + dz * dz;
    const r = _nR[k] > 0 ? _nR[k] : defaultR;
    if (d2 > 1e-6 && d2 < r * r) {
      const d = Math.sqrt(d2);
      if (r - d < deadband) continue;
      const w = same ? sameW : otherW;
      out.x += (dx / d / d) * w;
      out.z += (dz / d / d) * w;
      hits++;
    }
  }
  if (hits > 0) { out.x /= hits; out.z /= hits; }
  return out;
}

/** Squad._potentialField over arrays. */
function potentialField(store, i, passability, cfg, out) {
  const vx = store.mvx[i], vz = store.mvz[i];
  const speed = Math.sqrt(vx * vx + vz * vz);
  const dirX = speed > 1e-3 ? vx / speed : 0;
  const dirZ = speed > 1e-3 ? vz / speed : 1;
  const ahead = cfg.potentialFieldLookahead, d = cfg.potentialFieldSampleDist;
  const fx = store.mx[i] + dirX * ahead, fz = store.mz[i] + dirZ * ahead;
  const lateral = passability.cost(fx - dirZ * d, fz + dirX * d)
                - passability.cost(fx + dirZ * d, fz - dirX * d);
  out.x = dirZ * lateral;
  out.z = -dirX * lateral;
}

/** Squad._applyHardLeash over arrays (ground/naval — resamples ground height). */
function applyHardLeash(store, sq, i, leash, backend) {
  const dx = store.mx[i] - sq.cx, dz = store.mz[i] - sq.cz;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= leash) return;
  const s = leash / d;
  store.mx[i] = sq.cx + dx * s;
  store.mz[i] = sq.cz + dz * s;
  store.my[i] = backend.groundHeight(store.mx[i], store.mz[i]);
}

/** Squad._trackStuck over arrays. The teleport rung stays gated on
 *  `backend.isOnScreen` — never teleport a member the player can see. */
function trackStuck(store, sq, i, tx, tz, cfg, backend) {
  const dx = tx - store.mx[i], dz = tz - store.mz[i];
  const distSq = dx * dx + dz * dz;
  const arrivalR2 = cfg.arrivalRadius * cfg.arrivalRadius;
  if (distSq > arrivalR2 && distSq >= store.mLastDist2[i] - 1e-3) store.mStuck[i]++;
  else store.mStuck[i] = 0;
  store.mLastDist2[i] = distSq;

  const frames = store.mStuck[i];
  let level = 0;
  if (frames > cfg.stuckFramesTrailBoost) level = 1;
  if (frames > cfg.stuckFramesIgnoreSeparation) level = 2;
  if (frames > cfg.stuckFramesTeleport) {
    const onScreen = backend.isOnScreen
      ? backend.isOnScreen(store.mx[i], store.my[i], store.mz[i])
      : false;
    if (!onScreen) {
      const ti = trailIndexAhead(sq, store.mx[i], store.mz[i], 1);
      const px = ti >= 0 ? sq.trail[ti].x : tx;
      const pz = ti >= 0 ? sq.trail[ti].z : tz;
      store.mx[i] = px; store.mz[i] = pz;
      store.my[i] = backend.groundHeight(px, pz);
      store.mStuck[i] = 0;
      store.mLastDist2[i] = Infinity;
      level = 0;
    }
  }
  store.mRecovery[i] = level;
}

/** Member.integrate, inlined over arrays. `blend` 1 = the caller already
 *  turn-rate-capped its heading (naval/air) and must not be smoothed twice. */
function integrateGround(store, i, desiredVx, desiredVz, dt, backend, blend) {
  let vx = store.mvx[i], vz = store.mvz[i];
  vx += (desiredVx - vx) * blend;
  vz += (desiredVz - vz) * blend;
  store.mvx[i] = vx; store.mvz[i] = vz;
  const x = store.mx[i] + vx * dt, z = store.mz[i] + vz * dt;
  store.mx[i] = x; store.mz[i] = z;
  store.my[i] = backend.groundHeight(x, z);
  const speed = Math.sqrt(vx * vx + vz * vz);
  if (speed > 0.05) {
    store.mHeading[i] = headingFromVelocity(vx, vz);
    store.mGait[i] = (store.mGait[i] + speed * dt * 0.1) % 1;
  }
}

// --- direct-write path (S5, §13a/§13b) --------------------------------------
//
// A member whose slot the backend PINNED (`acquireSlot`, recorded in
// `mDirectPool`/`mPoolIdx`) has its transform written straight into the pool's
// typed arrays — no handle lookup, no per-frame tier decision, no Babylon
// Vector3/Quaternion/Matrix compose. A member that is not pinned keeps
// `updateMember`; that is a per-member property, not an engine mode, so both
// live side by side in the same squad without a branch per squad.
//
// The pinned index is a COPIED-OUT slot index, which PLAN-perf M24 forbids on
// its own — a pool compaction moves slots. `backend.poolGeneration` is what
// makes it safe: it moves on every growth and every compaction, and
// `resyncDirect` below re-reads the pair for a squad whose recorded generation
// is behind. Every squad with instances is in the schedule every frame, so no
// squad can write through a stale index.

const TAU = Math.PI * 2;

// Cached view for the pool the last write went to (a squad's members share one
// pool: same def, same team, same tier). Invalidated by the generation — and by
// the BACKEND, which is not optional: this cache is module scope and outlives any
// one squad system, pool ids are per-backend and dense from 0, and two systems in
// one realm (a second scene, a model preview, two tests in one file) therefore
// both have a pool 0. Without the identity compare the second system's members
// are written into the first one's buffers, which is silent and looks like
// "members are drawn in the wrong place".
let _viewBackend = null, _viewPoolId = -1, _view = null, _viewGen = -1;

// Accumulated dirty range, reported once per pool run rather than per member.
let _dirtyBackend = null, _dirtyPool = -1, _dirtyLo = 0, _dirtyHi = -1;

function viewFor(backend, poolId) {
  const gen = backend.poolGeneration;
  if (backend === _viewBackend && poolId === _viewPoolId && gen === _viewGen) return _view;
  _view = backend.getPoolView ? (backend.getPoolView(poolId) ?? null) : null;
  _viewBackend = backend;
  _viewPoolId = poolId;
  _viewGen = gen;
  return _view;
}

/** Report the accumulated range and close the run. Called at the end of every
 *  kernel entry point, so a caller that drives one exported step function
 *  directly still gets its writes uploaded. */
export function flushDirtyRanges() {
  if (_dirtyBackend !== null && _dirtyHi >= _dirtyLo) {
    _dirtyBackend.markDirty(_dirtyPool, _dirtyLo, _dirtyHi);
  }
  _dirtyBackend = null; _dirtyPool = -1; _dirtyLo = 0; _dirtyHi = -1;
}

function noteDirty(backend, poolId, idx) {
  if (poolId !== _dirtyPool) {
    flushDirtyRanges();
    _dirtyBackend = backend; _dirtyPool = poolId; _dirtyLo = idx; _dirtyHi = idx;
    return;
  }
  if (idx < _dirtyLo) _dirtyLo = idx;
  if (idx > _dirtyHi) _dirtyHi = idx;
}

/** Re-read a squad's pinned (poolId, index) pairs after a pool generation move.
 *  Runs per squad, not per frame: the generation only changes when a pool grows
 *  or compacts. */
function resyncDirect(store, sq, backend) {
  sq.directGen = backend.poolGeneration;
  if (backend.slotPoolId === undefined) return;
  const end = sq.base + sq.size;
  for (let i = sq.base; i < end; i++) {
    if (store.mDirectPool[i] < 0) continue;
    const handle = store.mPool[i];
    store.mDirectPool[i] = backend.slotPoolId(handle);
    store.mPoolIdx[i] = backend.slotIndex(handle);
  }
}

/** The one transform-write call site for every kernel stage. */
function writeMember(store, backend, i) {
  const poolId = store.mDirectPool[i];
  if (poolId >= 0) {
    const v = viewFor(backend, poolId);
    if (v !== null) {
      const idx = store.mPoolIdx[i];
      // Same bob and the same vertical bias the `updateMember` path applies —
      // both published on the view so there is exactly one copy of each.
      const my = store.my[i] + Math.sin(store.mGait[i] * TAU) * v.bobAmp;
      if (v.spritePos !== undefined) {
        // Sprite pool: record the POSE. The card matrix and the directional
        // atlas cell are camera-dependent and composed in the backend's flush.
        const b = idx * 3;
        v.spritePos[b] = store.mx[i];
        v.spritePos[b + 1] = my;
        v.spritePos[b + 2] = store.mz[i];
        v.spriteHeading[idx] = store.mHeading[i];
        v.spriteAlive[idx] = 1;
      } else {
        // §13b's layout, written by hand. The W-row is left clean — nothing is
        // ever packed into m[3]/m[7]/m[11]/m[15] (shadow-only failure mode).
        const m = v.matrices, b = idx * 16;
        const h = store.mHeading[i];
        const c = Math.cos(h), s = Math.sin(h);
        m[b] = c; m[b + 1] = 0; m[b + 2] = -s; m[b + 3] = 0;
        m[b + 4] = 0; m[b + 5] = 1; m[b + 6] = 0; m[b + 7] = 0;
        m[b + 8] = s; m[b + 9] = 0; m[b + 10] = c; m[b + 11] = 0;
        m[b + 12] = store.mx[i]; m[b + 13] = my + v.yBias; m[b + 14] = store.mz[i];
        m[b + 15] = 1;
      }
      noteDirty(backend, poolId, idx);
      return;
    }
  }
  backend.updateMember(store.mPool[i], store.mx[i], store.my[i], store.mz[i],
    store.mHeading[i], store.mGait[i]);
}

// --- ground steerer ---------------------------------------------------------

function stepGroundSquad(store, sq, grid, passability, bigUnits, backend, dt, maxSpeed, leash,
  softLeashDist, inTurn, moveClass, sinH, cosH, schedule) {
  const cfg = sq.cfg;
  const level = schedule.level;
  const skipInterSquad = level >= 1;
  const skipSeparation = level >= 2;
  const skipPotential = level >= 3;
  const projCap = cfg.slotProjectionCap;
  const usePass = !!(passability && moveClass);
  const nBig = bigUnits.length;
  const blend = Math.min(1, dt * 8);
  const end = sq.base + sq.size;
  const frameNo = schedule.frameNo;
  // Views hoisted into locals for the whole squad (the SoA idiom): `store.mx`
  // is a property load on a 20-field object, and the inner loop touches the
  // position/velocity views a dozen times per member. Locals, NOT closures —
  // §10b bans closing over a view (it would pin a stale pool across a growth
  // swap), and nothing here outlives the call.
  const mx = store.mx, my = store.my, mz = store.mz;
  const mvx = store.mvx, mvz = store.mvz;
  const mHeading = store.mHeading, mGait = store.mGait, mFlags = store.mFlags;
  const cx = sq.cx, cz = sq.cz;
  const arrivalRadius = cfg.arrivalRadius;
  const arrivalWeight = cfg.arrivalWeight, sepWeight = cfg.separationWeight;
  const potWeight = cfg.potentialFieldWeight, bigWeight = cfg.bigUnitWeight;
  const softGain = cfg.softLeashGain;
  const hysteresis = cfg.modeHysteresisFrames;

  for (let i = sq.base; i < end; i++) {
    if ((mFlags[i] & ALIVE_MASK) !== MFLAG_ALIVE) continue;

    slotTargetInto(store, sq, i, dt, sinH, cosH, _slotW);
    let tx = _slotW.x, tz = _slotW.z;

    let px = mx[i], pz = mz[i];

    let constrained = false;
    if (usePass) {
      passability.nearestPassableInto(_slotW.x, _slotW.z, moveClass, projCap, _proj);
      tx = _proj.x; tz = _proj.z;
      constrained = isConstrained(store, i, _slotW.x, _slotW.z, tx, tz, passability, moveClass);
    }
    updateMode(store, i, constrained, hysteresis);

    // M13 fix 1's trail guard, kept: the O(trail) scan runs only for the ~5 % of
    // members whose steering actually consults it.
    const recovery = store.mRecovery[i];
    if ((mFlags[i] & MFLAG_COLUMN) !== 0 || recovery >= 1 || inTurn) {
      const ti = trailIndexAhead(sq, px, pz, 1);
      if (ti >= 0) { tx = sq.trail[ti].x; tz = sq.trail[ti].z; }
    }

    arrive(px, pz, tx, tz, maxSpeed, arrivalRadius, _arr);

    if (recovery >= 2 || skipSeparation) { _sep.x = 0; _sep.z = 0; }
    else separateFromGrid(store, sq, grid, i, cfg, skipInterSquad, _sep, frameNo);

    softLeashPull(px, pz, cx, cz, softLeashDist, softGain, _leash);

    _potential.x = 0; _potential.z = 0;
    if (!skipPotential && usePass) potentialField(store, i, passability, cfg, _potential);

    // Big-unit threading (flow §4) through the `_cursor` bridge — the repulsor
    // math stays in big-unit-repulsor.js, unduplicated.
    _big.x = 0; _big.z = 0;
    let underHull = false;
    if (nBig > 0) {
      _cursor.x = px; _cursor.z = pz; _cursor.y = my[i];
      for (let b = 0; b < nBig; b++) {
        const bu = bigUnits[b];
        if (isUnderHull(_cursor, bu, moveClass)) { underHull = true; patchPush(_cursor, bu, cfg, _big); }
        else hullPush(_cursor, bu, cfg, _big);
      }
    }

    _desired.x = _arr.x * arrivalWeight + _sep.x * sepWeight * maxSpeed
               + _leash.x + _potential.x * potWeight
               + _big.x * bigWeight * maxSpeed;
    _desired.z = _arr.z * arrivalWeight + _sep.z * sepWeight * maxSpeed
               + _leash.z + _potential.z * potWeight
               + _big.z * bigWeight * maxSpeed;
    clampLen(_desired, underHull ? maxSpeed * cfg.underHullSpeedPenalty : maxSpeed);

    // Member.integrate, inlined against the hoisted views (the same math
    // `integrateGround` runs for the naval/transport paths).
    let vx = mvx[i], vz = mvz[i];
    vx += (_desired.x - vx) * blend;
    vz += (_desired.z - vz) * blend;
    mvx[i] = vx; mvz[i] = vz;
    px += vx * dt; pz += vz * dt;
    let py = backend.groundHeight(px, pz);
    const speed = Math.sqrt(vx * vx + vz * vz);
    if (speed > 0.05) {
      mHeading[i] = headingFromVelocity(vx, vz);
      mGait[i] = (mGait[i] + speed * dt * 0.1) % 1;
    }

    // Hard leash, inlined.
    const lx = px - cx, lz = pz - cz;
    const ld = Math.sqrt(lx * lx + lz * lz);
    if (ld > leash) {
      const s = leash / ld;
      px = cx + lx * s; pz = cz + lz * s;
      py = backend.groundHeight(px, pz);
    }
    mx[i] = px; mz[i] = pz; my[i] = py;

    if (nBig > 0) {
      // Panic clause (flow §4): final authority over position this frame.
      // Re-checks isUnderHull per big unit — the leash clamp can have moved the
      // member in or out of a hull since the pre-integration pass.
      _cursor.x = px; _cursor.z = pz; _cursor.y = py;
      for (let b = 0; b < nBig; b++) {
        const bu = bigUnits[b];
        if (isUnderHull(_cursor, bu, moveClass)) panicClamp(_cursor, bu);
      }
      mx[i] = _cursor.x; mz[i] = _cursor.z;
      // Y-clamp: no climbing the hull, and never a stale sample from before the
      // leash/panic clamps moved the member.
      my[i] = backend.groundHeight(_cursor.x, _cursor.z);
    }

    trackStuck(store, sq, i, tx, tz, cfg, backend);
    writeMember(store, backend, i);
  }
}

// --- naval steerer ----------------------------------------------------------

function stepNavalSquad(store, sq, grid, backend, dt, maxSpeed, leash, softLeashDist,
  inTurn, moveClass, passability, sinH, cosH, schedule) {
  const cfg = sq.cfg;
  const level = schedule.level;
  const skipInterSquad = level >= 1;
  const skipSeparation = level >= 2;
  const projCap = cfg.slotProjectionCap;
  const usePass = !!(passability && moveClass);
  const isSub = sq.profile.moveClass === 'SUB';
  const end = sq.base + sq.size;
  const frameNo = schedule.frameNo;

  _ctx.profile = sq.profile;
  _ctx.centroidSpeed = sq.centroidSpeed;
  _ctx.nowSec = 0;

  for (let i = sq.base; i < end; i++) {
    if ((store.mFlags[i] & ALIVE_MASK) !== MFLAG_ALIVE) continue;

    slotTargetInto(store, sq, i, dt, sinH, cosH, _slotW);
    const rawX = _slotW.x, rawZ = _slotW.z;
    let tx = rawX, tz = rawZ;

    let constrained = false;
    if (usePass) {
      passability.nearestPassableInto(rawX, rawZ, moveClass, projCap, _proj);
      tx = _proj.x; tz = _proj.z;
      constrained = isConstrained(store, i, rawX, rawZ, tx, tz, passability, moveClass);
    }
    updateMode(store, i, constrained, cfg.modeHysteresisFrames);

    // The naval steerer takes the trail point as a PARAMETER (columnTarget), so
    // it is the one steerer that computes it unconditionally (M13 fix 1's
    // documented exception).
    const recovery = store.mRecovery[i];
    const ti = trailIndexAhead(sq, store.mx[i], store.mz[i], 1);
    let hasTrail = false;
    if (ti >= 0) {
      _trailPt.x = sq.trail[ti].x; _trailPt.z = sq.trail[ti].z;
      hasTrail = true;
      if ((store.mFlags[i] & MFLAG_COLUMN) !== 0 || recovery >= 1 || inTurn) {
        tx = _trailPt.x; tz = _trailPt.z;
      }
    }

    _slotW.x = tx; _slotW.z = tz;          // steerer's `slotWorld` is the target
    _ctx.columnTarget = hasTrail ? _trailPt : null;

    _cursor.x = store.mx[i]; _cursor.y = store.my[i]; _cursor.z = store.mz[i];
    _cursor.headingY = store.mHeading[i];
    _cursor.slot = store.mSlot[i];
    _cursor.depth = 0;
    navalSteerInto(sq, _cursor, dt, _ctx, _steer);

    if (recovery >= 2 || skipSeparation) { _sep.x = 0; _sep.z = 0; }
    else separateFromGrid(store, sq, grid, i, cfg, skipInterSquad, _sep, frameNo);

    softLeashPull(store.mx[i], store.mz[i], sq.cx, sq.cz, softLeashDist, cfg.softLeashGain, _leash);

    _desired.x = _steer.x + _sep.x * cfg.separationWeight * maxSpeed + _leash.x;
    _desired.z = _steer.z + _sep.z * cfg.separationWeight * maxSpeed + _leash.z;
    clampLen(_desired, maxSpeed);

    // blend 1: naval-cohesion already turn-rate-capped the heading.
    integrateGround(store, i, _desired.x, _desired.z, dt, backend, 1);
    applyHardLeash(store, sq, i, leash, backend);
    // Cosmetic sub dive offset — same flagged deviation as squad.js (this sinks
    // below the seabed reading, not a true water-surface plane; the backend has
    // no water sampler).
    if (isSub) store.my[i] += _cursor.depth;

    trackStuck(store, sq, i, tx, tz, cfg, backend);
    writeMember(store, backend, i);
  }
}

// --- air steerer ------------------------------------------------------------

function stepAirSquad(store, sq, backend, dt, nowSec, maxSpeed, leash, sinH, cosH) {
  const end = sq.base + sq.size;
  _ctx.profile = sq.profile;
  _ctx.nowSec = nowSec;
  _ctx.centroidSpeed = sq.centroidSpeed;
  _ctx.columnTarget = null;

  for (let i = sq.base; i < end; i++) {
    if ((store.mFlags[i] & ALIVE_MASK) !== MFLAG_ALIVE) continue;

    // Air ignores passability, the trail and the ground entirely (§6).
    slotTargetInto(store, sq, i, dt, sinH, cosH, _slotW);

    _cursor.x = store.mx[i]; _cursor.y = store.my[i]; _cursor.z = store.mz[i];
    _cursor.headingY = store.mHeading[i];
    _cursor.slot = store.mSlot[i];
    _cursor.bank = store.mBank[i];
    _cursor.altitudeOffset = store.mAltOff[i];
    airSteerInto(sq, _cursor, dt, _ctx, _steer);
    store.mBank[i] = _cursor.bank;
    store.mAltOff[i] = _cursor.altitudeOffset;

    // Member.integrateAir, inlined: velocity arrives already turn-rate-capped
    // at cruise speed and Y is never ground-snapped.
    const vx = _steer.x, vz = _steer.z;
    store.mvx[i] = vx; store.mvz[i] = vz;
    let x = store.mx[i] + vx * dt;
    let z = store.mz[i] + vz * dt;
    store.my[i] += _steer.y * dt;
    const speed = Math.sqrt(vx * vx + vz * vz);
    if (speed > 0.05) {
      store.mHeading[i] = headingFromVelocity(vx, vz);
      store.mGait[i] = (store.mGait[i] + speed * dt * 0.1) % 1;
    }

    // Same world-space "squad stays together" clamp as ground, minus the ground
    // resample (§1 layer 3).
    const dx = x - sq.cx, dz = z - sq.cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > leash) { const s = leash / d; x = sq.cx + dx * s; z = sq.cz + dz * s; }
    store.mx[i] = x; store.mz[i] = z;

    writeMember(store, backend, i);
  }
}

// --- reduced tier + coast ---------------------------------------------------

/** The reduced tier (§5): hold the formation RIGIDLY on the squad centroid.
 *  Every member is written to its slot offset rotated by the squad heading,
 *  ground-snapped (air replays its snapshotted cruise offset), gait still
 *  advancing off the squad's own displacement. What stops is per-member
 *  steering only. Also where ladder L6's forced demotion of an otherwise-`full`
 *  squad lands — without touching `lod`, which stays the member budget's. */
export function centroidStep(store, sq, backend) {
  maintainIconRoster(store, sq, backend);
  const s = Math.sin(sq.heading), c = Math.cos(sq.heading);
  const air = sq.steerer === 2;
  const gaitStep = sq.prevUpdateCx == null ? 0
    : Math.sqrt((sq.cx - sq.prevUpdateCx) * (sq.cx - sq.prevUpdateCx)
              + (sq.cz - sq.prevUpdateCz) * (sq.cz - sq.prevUpdateCz)) * 0.1;
  sq.prevUpdateCx = sq.cx; sq.prevUpdateCz = sq.cz; sq.prevUpdateHeading = sq.heading;

  const end = sq.base + sq.size;
  for (let i = sq.base; i < end; i++) {
    if ((store.mFlags[i] & ALIVE_MASK) !== MFLAG_ALIVE) continue;
    const localSlot = store.mSlot[i];
    const sx = sq.slotsX[localSlot], sz = sq.slotsZ[localSlot];
    const x = sq.cx + (sx * c + sz * s);
    const z = sq.cz + (-sx * s + sz * c);
    store.mx[i] = x; store.mz[i] = z;
    store.my[i] = air ? sq.cy + store.mCentroidDy[i] : backend.groundHeight(x, z);
    store.mHeading[i] = sq.heading;
    store.mGait[i] = (store.mGait[i] + gaitStep) % 1;
    writeMember(store, backend, i);
  }
  flushDirtyRanges();
  sq.lastAppliedCx = sq.cx; sq.lastAppliedCz = sq.cz;
}

/** Governor time-slicing (§12d): this `full`-tier squad's turn to skip its real
 *  step. Rigid-shift by the centroid delta accumulated since it last stepped or
 *  coasted, preserving formation shape — a coasting squad still visibly tracks
 *  the battle instead of freezing. No writes at all when the centroid held. */
export function coastSquad(store, sq, backend) {
  const dx = sq.cx - sq.lastAppliedCx, dz = sq.cz - sq.lastAppliedCz;
  sq.lastAppliedCx = sq.cx; sq.lastAppliedCz = sq.cz;
  if (dx === 0 && dz === 0) return;
  const air = sq.steerer === 2;
  const end = sq.base + sq.size;
  for (let i = sq.base; i < end; i++) {
    if ((store.mFlags[i] & ALIVE_MASK) !== MFLAG_ALIVE) continue;
    const x = store.mx[i] + dx, z = store.mz[i] + dz;
    store.mx[i] = x; store.mz[i] = z;
    if (!air) store.my[i] = backend.groundHeight(x, z);
    writeMember(store, backend, i);
  }
  flushDirtyRanges();
}

// --- transport --------------------------------------------------------------

/** Per-frame transport driver — Squad._updateTransport's port, and the half S3
 *  could not have: BOARDING really steers members to the carrier and detects
 *  arrival, a paradrop really descends. Returns true when transport owns the
 *  frame (caller must skip normal steering). */
export function stepTransport(store, sq, backend, dt) {
  const cfg = sq.cfg;
  sq.transportElapsed += dt;

  if (sq.transportState === 'BOARDING') {
    const maxSpeed = sq.def.maxSpeed * cfg.memberSpeedMultiplier;
    const arrivalR2 = cfg.arrivalRadius * cfg.arrivalRadius;
    const blend = Math.min(1, dt * 8);
    const end = sq.base + sq.size;
    let allArrived = true;
    for (let i = sq.base; i < end; i++) {
      if ((store.mFlags[i] & ALIVE_MASK) !== MFLAG_ALIVE) continue;
      const dx = sq.transportTargetX - store.mx[i], dz = sq.transportTargetZ - store.mz[i];
      if (dx * dx + dz * dz > arrivalR2) allArrived = false;
      arrive(store.mx[i], store.mz[i], sq.transportTargetX, sq.transportTargetZ,
        maxSpeed, cfg.arrivalRadius, _arr);
      integrateGround(store, i, _arr.x, _arr.z, dt, backend, blend);
      writeMember(store, backend, i);
    }
    flushDirtyRanges();
    if (allArrived || sq.transportElapsed >= cfg.transportBoardTimeSec) {
      releaseAllMemberInstances(store, sq, backend);
      sq.transportState = 'LOADED';
    }
    return true;
  }

  if (sq.transportState === 'LOADED') return true;   // released — nothing to steer

  // UNLOADING: a paradrop falls straight down first (no horizontal drift while
  // airborne — a deliberate cosmetic simplification); once landed, fall through
  // so the spill re-forms via ordinary slot arrival.
  if (sq.transportParadrop) {
    const end = sq.base + sq.size;
    let allLanded = true;
    for (let i = sq.base; i < end; i++) {
      if ((store.mFlags[i] & ALIVE_MASK) !== MFLAG_ALIVE) continue;
      _cursor.y = store.my[i];
      const landed = descendStep(_cursor, backend.groundHeight(store.mx[i], store.mz[i]),
        cfg.paradropDescentRatePerSec, dt);
      store.my[i] = _cursor.y;
      if (!landed) allLanded = false;
    }
    if (!allLanded) return true;
  }
  if (sq.transportElapsed >= cfg.transportUnloadSettleSec) sq.transportState = 'FREE';
  return false;
}
