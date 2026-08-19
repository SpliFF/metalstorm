// soa-kernel.test.js — the SoA stepping kernel (soa-kernel.js), milestone S4.
// PLAN-metalstorm-squad-performance.md §11/§14.
//
// Everything here drives the PUBLIC SquadManager API with `engine: 'soa'` — the
// kernel has no other entry point in a running client, and a test that reached
// past the manager would not exercise the schedule, the CSR grid rebuild or the
// governor's time-slicing, which is where the port's real risk sits.
//
// The OO engine is the oracle (§14 S4: "keep the old allocating forms as a
// parity oracle"), so the first block runs the same frames through both engines
// and compares. S6 owns the full seeded parity suite; this is the smoke version
// that fails loudly if the port drifts.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';
import { createPassability } from './passability.js';
import { isAlive, isReleased } from './soa-store.js';

class RecordingBackend extends NullRenderBackend {
  constructor(groundY = 0) {
    super();
    this._next = 1;
    this._groundY = groundY;
    this.updates = 0;
    this.released = [];
    this.onScreen = false;
  }
  createMember() { return this._next++; }
  updateMember() { this.updates++; }
  releaseMember(handle) { this.released.push(handle); }
  groundHeight() { return this._groundY; }
  isOnScreen() { return this.onScreen; }
}

function makeDef(overrides = {}) {
  return {
    defId: 'unit_test',
    squadSize: 8,
    formationType: 'line',
    formationRadius: 20,
    maxSpeed: 30,
    ...overrides,
  };
}

function makeMgr(engine, backend, cfg = {}) {
  return new SquadManager(backend, { engine, ...cfg });
}

/** Member world positions of a squad, in run/roster order, for either engine. */
function memberPositions(mgr, sq) {
  const out = [];
  if (mgr.engine === 'soa') {
    const store = mgr.store;
    for (let i = sq.base; i < sq.base + sq.size; i++) {
      if (!isAlive(store, i) || isReleased(store, i)) continue;
      out.push({ x: store.mx[i], y: store.my[i], z: store.mz[i], heading: store.mHeading[i] });
    }
  } else {
    for (const m of sq.members) {
      if (!m.alive || m.released) continue;
      out.push({ x: m.x, y: m.y, z: m.z, heading: m.headingY });
    }
  }
  return out;
}

/** Drive `frames` frames, walking the squad centroid by (stepX, stepZ) each. */
function driveSquad(mgr, id, def, frames, dt, stepX, stepZ, startX = 0, startZ = 0) {
  mgr.syncSquad(id, { x: startX, y: 0, z: startZ, heading: 0, health: 100, maxHealth: 100 }, def);
  for (let f = 1; f <= frames; f++) {
    mgr.syncPose(id, { x: startX + stepX * f, y: 0, z: startZ + stepZ * f, heading: 0 });
    mgr.update(dt);
  }
  return mgr.squads.get(id);
}

describe('S4 kernel: parity with the OO steering path (the oracle)', () => {
  it('ground members land in the same places as engine:"oo" over 30 frames', () => {
    const def = makeDef();
    const oo = makeMgr('oo', new RecordingBackend());
    const soa = makeMgr('soa', new RecordingBackend());
    const a = driveSquad(oo, 1, def, 30, 1 / 60, 3, 0);
    const b = driveSquad(soa, 1, def, 30, 1 / 60, 3, 0);

    const pa = memberPositions(oo, a), pb = memberPositions(soa, b);
    expect(pb.length).toBe(pa.length);
    expect(pa.length).toBe(8);
    for (let i = 0; i < pa.length; i++) {
      // Tolerance, not equality: the kernel uses Math.sqrt where squad.js uses
      // Math.hypot (§11d rule 6), which can differ in the last ulp.
      expect(pb[i].x).toBeCloseTo(pa[i].x, 4);
      expect(pb[i].z).toBeCloseTo(pa[i].z, 4);
      expect(pb[i].heading).toBeCloseTo(pa[i].heading, 4);
    }
    // The squad really moved — otherwise this passes on two frozen formations.
    expect(Math.abs(pa[0].x)).toBeGreaterThan(1);
  });

  it('air members match the OO air steerer (altitude bands, no ground snap)', () => {
    const def = makeDef({ customParams: { ms_class: 'fighters' }, squadSize: 5 });
    const oo = makeMgr('oo', new RecordingBackend(7));
    const soa = makeMgr('soa', new RecordingBackend(7));
    const a = driveSquad(oo, 2, def, 25, 1 / 60, 4, 0);
    const b = driveSquad(soa, 2, def, 25, 1 / 60, 4, 0);
    const pa = memberPositions(oo, a), pb = memberPositions(soa, b);
    for (let i = 0; i < pa.length; i++) {
      expect(pb[i].x).toBeCloseTo(pa[i].x, 4);
      expect(pb[i].z).toBeCloseTo(pa[i].z, 4);
      expect(pb[i].y).toBeCloseTo(pa[i].y, 4);
    }
    // Air never ground-snaps: nothing sits at the backend's ground height.
    for (const p of pb) expect(p.y).toBeGreaterThan(50);
  });

  it('naval members match the OO naval steerer and subs carry their dive offset', () => {
    const def = makeDef({ customParams: { ms_class: 'subs' }, squadSize: 4 });
    const oo = makeMgr('oo', new RecordingBackend());
    const soa = makeMgr('soa', new RecordingBackend());
    const a = driveSquad(oo, 3, def, 25, 1 / 60, 3, 0);
    const b = driveSquad(soa, 3, def, 25, 1 / 60, 3, 0);
    const pa = memberPositions(oo, a), pb = memberPositions(soa, b);
    for (let i = 0; i < pa.length; i++) {
      expect(pb[i].x).toBeCloseTo(pa[i].x, 4);
      expect(pb[i].z).toBeCloseTo(pa[i].z, 4);
      expect(pb[i].y).toBeCloseTo(pa[i].y, 4);
    }
    for (const p of pb) expect(p.y).toBe(-8);   // profile.subDepth, ground 0
  });
});

describe('S4 kernel: the stages the parity run cannot distinguish', () => {
  it('the hard leash clamps a member dragged beyond maxMemberDistance', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr('soa', backend);
    const def = makeDef({ squadSize: 4 });
    const sq = driveSquad(mgr, 1, def, 2, 1 / 60, 0, 0);
    // Shove one member far away, then step: the clamp is the last authority.
    mgr.store.mx[sq.base] = 5000;
    mgr.syncPose(1, { x: 0, y: 0, z: 0, heading: 0 });
    mgr.update(1 / 60);
    const leash = def.formationRadius * mgr.cfg.maxMemberDistance;
    const d = Math.hypot(mgr.store.mx[sq.base] - sq.cx, mgr.store.mz[sq.base] - sq.cz);
    expect(d).toBeLessThanOrEqual(leash + 1e-3);
  });

  it('separation pushes two overlapping squads apart, and the CSR grid is what feeds it', () => {
    function spreadAfter(neighbourCap) {
      const mgr = makeMgr('soa', new RecordingBackend(), { neighbourCap });
      const def = makeDef({ squadSize: 6, formationRadius: 4 });
      for (const id of [1, 2]) {
        mgr.syncSquad(id, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, def);
      }
      for (let f = 0; f < 20; f++) {
        mgr.syncPose(1, { x: 0, y: 0, z: 0, heading: 0 });
        mgr.syncPose(2, { x: 0, y: 0, z: 0, heading: 0 });
        mgr.update(1 / 60);
      }
      const store = mgr.store;
      let sum = 0, n = 0;
      for (const sq of mgr.squads.values()) {
        for (let i = sq.base; i < sq.base + sq.size; i++) {
          sum += Math.hypot(store.mx[i] - sq.cx, store.mz[i] - sq.cz); n++;
        }
      }
      return sum / n;
    }
    // Neutralised arm: cap 0 means the grid is never queried, so the only term
    // left is arrival onto the (identical) slots — a tighter pile.
    expect(spreadAfter(8)).toBeGreaterThan(spreadAfter(0));
  });

  it('an impassable slot projects the target and drives COLUMN mode after hysteresis', () => {
    // A cliff wall at x > 40: too steep for VEH (32 deg) at a 24-elmo cell.
    function run(withGrid) {
      const mgr = makeMgr('soa', new RecordingBackend());
      if (withGrid) {
        mgr.setPassability(createPassability({
          bounds: { minX: -200, minZ: -200, maxX: 200, maxZ: 200 },
          heightAt: (x) => (x > 40 ? 400 : 0),
        }));
      }
      const def = makeDef({ customParams: { ms_class: 'tanks' }, squadSize: 6, formationRadius: 60 });
      const sq = driveSquad(mgr, 1, def, 40, 1 / 60, 0, 0, 20, 0);
      let column = 0, sumX = 0;
      for (let i = sq.base; i < sq.base + sq.size; i++) {
        if (mgr.store.mFlags[i] & 4) column++;
        sumX += mgr.store.mx[i];
      }
      return { column, meanX: sumX / sq.size };
    }
    const withGrid = run(true), noGrid = run(false);
    // Members of a formation straddling the wall go COLUMN; without a grid
    // nothing is ever constrained, so nobody does.
    expect(withGrid.column).toBeGreaterThan(0);
    expect(noGrid.column).toBe(0);
    // And the grid pulls the formation back off the cliff face.
    expect(withGrid.meanX).toBeLessThan(noGrid.meanX);
  });

  it('the stuck ladder teleports only while the member is off screen', () => {
    function stuckRun(onScreen) {
      const backend = new RecordingBackend();
      backend.onScreen = onScreen;
      // maxSpeed 0 with no leash pull and no neighbours: nothing moves the
      // member at all, so its distance to target is constant and the stuck
      // counter is the only thing that changes. (With the soft leash live the
      // member creeps toward the centroid every frame, which RESETS the
      // counter — the ladder is a "not getting closer" test, not a timer.)
      const mgr = makeMgr('soa', backend, { softLeashGain: 0, neighbourCap: 0 });
      // A wide formation so the HARD leash does not drag the member instead:
      // with a 20-elmo radius its 32-elmo clamp lands the member exactly one
      // arrivalRadius from its slot, i.e. "arrived", and nothing is ever stuck.
      const def = makeDef({ squadSize: 2, formationRadius: 200, maxSpeed: 0 });
      const sq = driveSquad(mgr, 1, def, 2, 1 / 60, 0, 0);
      // A centroid offset past arrivalRadius but under teleportThreshold (200 —
      // beyond it setPose rigid-shifts everyone and there is no gap left to be
      // stuck about).
      for (let f = 0; f < 200; f++) {
        mgr.syncPose(1, { x: 100, y: 0, z: 0, heading: 0 });
        mgr.update(1 / 60);
      }
      let maxStuck = 0, maxRecovery = 0;
      for (let i = sq.base; i < sq.base + sq.size; i++) {
        maxStuck = Math.max(maxStuck, mgr.store.mStuck[i]);
        maxRecovery = Math.max(maxRecovery, mgr.store.mRecovery[i]);
      }
      return { maxStuck, maxRecovery };
    }
    const off = stuckRun(false);
    const on = stuckRun(true);
    // On screen: never teleported, so the counter keeps climbing past the
    // teleport rung and the recovery level pins at the top non-teleport one.
    expect(on.maxStuck).toBeGreaterThan(120);
    expect(on.maxRecovery).toBe(2);
    // Off screen: the teleport rung fires and resets the counter.
    expect(off.maxStuck).toBeLessThan(on.maxStuck);
  });
});

describe('S4 kernel: tiers, time-slicing and the governor ladder', () => {
  it('a centroid-tier squad parks members on their slots and still advances gait', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr('soa', backend);
    const def = makeDef({ squadSize: 4 });
    const sq = driveSquad(mgr, 1, def, 2, 1 / 60, 0, 0);
    sq.lod = 'centroid';
    // 55, not a round 100: the gait accumulator is `(gait + displacement*0.1) %
    // 1`, and a displacement of exactly 100 advances it by exactly 10 — i.e.
    // back to where it started, which reads as "gait never moved".
    mgr.syncPose(1, { x: 55, y: 0, z: 0, heading: 0 });
    mgr.update(1 / 60);
    const store = mgr.store;
    for (let i = sq.base; i < sq.base + sq.size; i++) {
      const localSlot = store.mSlot[i];
      // Float32 storage — 4 decimals is the precision the pool actually has.
      expect(store.mx[i]).toBeCloseTo(55 + sq.slotsX[localSlot], 4);
      expect(store.mz[i]).toBeCloseTo(sq.slotsZ[localSlot], 4);
    }
    expect(store.mGait[sq.base]).toBeGreaterThan(0);
  });

  it('a coasted squad rigid-shifts by the centroid delta and never double-applies it', () => {
    const backend = new RecordingBackend();
    // Ladder L4+ halves the step rate; force it by hand rather than by loading
    // the machine — the governor is S2's and is tested there.
    const mgr = makeMgr('soa', backend);
    const def = makeDef({ squadSize: 4 });
    const sq = driveSquad(mgr, 1, def, 2, 1 / 60, 0, 0);
    const store = mgr.store;
    const before = store.mx[sq.base];
    mgr._governor.ladderLevel = 4;              // stride 2 → half the squads coast
    // fullIndex 0 vs frameNo parity decides whose turn it is; run two frames so
    // this squad both steps and coasts exactly once.
    let stepped = 0, coasted = 0;
    for (const x of [50, 100]) {
      mgr.syncPose(1, { x, y: 0, z: 0, heading: 0 });
      mgr.update(1 / 60);            // the counters are per frame — accumulate
      stepped += mgr._stepped.full;
      coasted += mgr._coasted.full;
    }
    expect(stepped + coasted).toBe(2);
    expect(coasted).toBe(1);         // stride 2 with one squad: every other frame
    // Whatever the phase, the member tracked the centroid rather than freezing
    // at its old position or jumping twice the delta.
    const moved = store.mx[sq.base] - before;
    expect(moved).toBeGreaterThan(10);
    expect(moved).toBeLessThan(150);
  });

  it('ladder L2 drops separation entirely and the frame still steps', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr('soa', backend);
    const def = makeDef({ squadSize: 4 });
    driveSquad(mgr, 1, def, 2, 1 / 60, 0, 0);
    mgr._governor.ladderLevel = 2;
    backend.updates = 0;
    mgr.syncPose(1, { x: 40, y: 0, z: 0, heading: 0 });
    expect(() => mgr.update(1 / 60)).not.toThrow();
    expect(backend.updates).toBe(4);            // every member still written
  });
});

describe('S4 kernel: transport, the gap S3 left open', () => {
  it('BOARDING steers members to the carrier and releases on ARRIVAL, not on the timer', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr('soa', backend);
    const def = makeDef({ squadSize: 4, maxSpeed: 60 });
    const sq = driveSquad(mgr, 1, def, 2, 1 / 60, 0, 0);
    mgr.unitLoaded(1, 99, 10, 0, 0);            // carrier right next door
    const store = mgr.store;
    const startD = Math.hypot(store.mx[sq.base] - 10, store.mz[sq.base]);
    let frames = 0;
    while (sq.transportState === 'BOARDING' && frames < 60) { mgr.update(1 / 60); frames++; }
    expect(sq.transportState).toBe('LOADED');
    // Released on arrival: far sooner than transportBoardTimeSec (4 s = 240
    // frames), which is exactly what S3's timer-only driver could not do.
    expect(frames).toBeLessThan(120);
    expect(frames * (1 / 60)).toBeLessThan(mgr.cfg.transportBoardTimeSec);
    expect(backend.released.length).toBe(4);
    expect(startD).toBeGreaterThan(0);
  });

  it('an airborne unload descends the spill to the ground before normal steering resumes', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr('soa', backend);
    const def = makeDef({ squadSize: 4 });
    const sq = driveSquad(mgr, 1, def, 2, 1 / 60, 0, 0);
    mgr.unitLoaded(1, 99, 0, 0, 0);
    for (let f = 0; f < 300; f++) mgr.update(1 / 60);   // reach LOADED
    expect(sq.transportState).toBe('LOADED');
    mgr.unitUnloaded(1, 0, 300, 0, true);               // paradrop from 300
    expect(sq.transportState).toBe('UNLOADING');
    expect(mgr.store.my[sq.base]).toBe(300);
    let frames = 0;
    while (mgr.store.my[sq.base] > 0.05 && frames < 600) { mgr.update(1 / 60); frames++; }
    expect(mgr.store.my[sq.base]).toBeLessThanOrEqual(0.05);
    // ~300 elmos at 40 elmos/s ≈ 7.5 s — a descent, not an instant settle.
    expect(frames).toBeGreaterThan(300);
  });
});

describe('S4 kernel: §11d allocation-free lint (the checklist, mechanised)', () => {
  // §11d ends "reviewers lint by grepping the three soa-*.js files". A grep a
  // human has to remember to run is not a gate, so this runs it: every function
  // reachable per member per frame is extracted from the source and checked for
  // the banned constructs. Growth/setup functions are excluded BY NAME — they
  // allocate on purpose, once, and are listed here so the exclusion is visible
  // rather than implied by a clever regex.
  const KERNEL_SRC = readFileSync(fileURLToPath(new URL('./soa-kernel.js', import.meta.url)), 'utf8');
  const ALLOCATING_BY_DESIGN = new Set(['createSchedule', 'scheduleReset', 'ensureNeighbourCapacity']);

  /** Source text of a top-level `function name(...) {...}`, braces matched. */
  function functionBody(src, name) {
    const re = new RegExp(`function ${name}\\s*\\(`);
    const at = src.search(re);
    if (at < 0) return null;
    let i = src.indexOf('{', at), depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}' && --depth === 0) return src.slice(i, j + 1);
    }
    return null;
  }

  function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  const PER_FRAME_FUNCTIONS = [
    'stepMembers', 'stepSquad', 'stepGroundSquad', 'stepNavalSquad', 'stepAirSquad',
    'centroidStep', 'coastSquad', 'stepTransport', 'separateFromGrid', 'potentialField',
    'slotTargetInto', 'isConstrained', 'updateMode', 'trailIndexAhead', 'trackStuck',
    'applyHardLeash', 'integrateGround', 'writeMember', 'schedulePush',
  ];

  const BANNED = [
    [/\bnew\s+[A-Z]/, 'no `new` (§11d.1)'],
    [/=>\s*/, 'no closures (§11d.2)'],
    [/function\s*\*/, 'no generators (§11d.3)'],
    [/\.(map|filter|slice|concat|splice|from)\s*\(/, 'no array-copying methods (§11d.1)'],
    [/\.\.\./, 'no spread (§11d.1)'],
    [/Math\.hypot/, 'Math.sqrt over Math.hypot (§11d.6)'],
    [/\bnew Map\b|\.get\(|\.set\(|\.has\(/, 'no Map/Set per member (§11d.4)'],
    [/`/, 'no template strings (§11d.1)'],
  ];

  it('every per-frame kernel function is free of the banned constructs', () => {
    const offences = [];
    for (const name of PER_FRAME_FUNCTIONS) {
      if (ALLOCATING_BY_DESIGN.has(name)) continue;
      const body = functionBody(KERNEL_SRC, name);
      expect(body, `${name} not found — did it get renamed?`).toBeTruthy();
      const code = stripComments(body);
      for (const [re, why] of BANNED) {
        if (re.test(code)) offences.push(`${name}: ${why}`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('the lint can actually fail (mutation check — a suite that cannot fail is worthless)', () => {
    const poisoned = 'function poison(a) { const out = a.map((v) => v); return out; }';
    const body = functionBody(poisoned, 'poison');
    const hits = BANNED.filter(([re]) => re.test(stripComments(body)));
    expect(hits.length).toBeGreaterThanOrEqual(2);   // the closure AND the .map
  });

  it('object/array literals appear in no per-frame function body', () => {
    for (const name of PER_FRAME_FUNCTIONS) {
      if (ALLOCATING_BY_DESIGN.has(name)) continue;
      const code = stripComments(functionBody(KERNEL_SRC, name));
      // `{` after `=` or `(` or `,` or `return` is a literal; block braces are
      // preceded by `)` or `else` or `do`.
      expect(code, name).not.toMatch(/(?:=|\(|,|return)\s*\{[^}]/);
      expect(code, name).not.toMatch(/(?:=|\(|,|return)\s*\[/);
    }
  });
});
