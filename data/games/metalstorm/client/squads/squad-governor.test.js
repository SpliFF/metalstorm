// squad-governor.test.js — the frame-time governor (PLAN-metalstorm-squad-
// performance.md §12c, milestone S14 S2). Two halves, same split as
// squad-lod.test.js:
//   1. the pure `updateGovernor` state machine — fake-clock (no
//      performance.now()), driven frame-by-frame with scripted samples.
//      Proves the hysteresis never oscillates and that the SAME cfg
//      constants settle at different ladder levels purely from measured
//      inputs (hardware adaptivity — no squad/member counts anywhere).
//   2. the SquadManager delivery path: stride/time-slicing schedule
//      partitioning, dt compensation for skipped frames, and coasting
//      (rigid centroid-delta shift) actually moving members.

import { describe, it, expect, vi } from 'vitest';
import { createGovernorState, updateGovernor, strideForLevel } from './governor.js';
import { SquadManager } from './squad-manager.js';
import { Squad } from './squad.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';
import { NullRenderBackend } from './render-backend.js';

function makeCfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, countCurve: linearCount, ...overrides };
}

const cfg = makeCfg();

// --- pure state machine -----------------------------------------------------

describe('updateGovernor — escalate/relax hysteresis (§12c)', () => {
  it('stays at level 0 when cost never approaches budget', () => {
    const g = createGovernorState();
    for (let i = 0; i < 500; i++) updateGovernor(g, 0.1, 16.7, cfg);
    expect(g.ladderLevel).toBe(0);
  });

  it('does not escalate before governorEscalateFrames consecutive over-budget frames', () => {
    const g = createGovernorState();
    // Force a small, known budget quickly, then hammer it just short of the streak.
    for (let i = 0; i < cfg.governorEscalateFrames - 1; i++) updateGovernor(g, 1000, 16.7, cfg);
    expect(g.ladderLevel).toBe(0);
  });

  it('escalates exactly one level after governorEscalateFrames consecutive over-budget frames', () => {
    const g = createGovernorState();
    for (let i = 0; i < cfg.governorEscalateFrames; i++) updateGovernor(g, 1000, 16.7, cfg);
    expect(g.ladderLevel).toBe(1);
    expect(g.escalateStreak).toBe(0); // streak resets on the level change
  });

  it('the escalate streak resets once the smoothed cost actually drops back under budget', () => {
    // Seeded directly rather than ramped: a real ramp from a high costEma
    // decays slowly (it's an EMA — one cheap frame barely moves it), so a
    // naive "run N over-budget frames then one cheap frame" test would
    // still read as over-budget that very frame and keep escalating,
    // which is correct governor behaviour, not a broken reset. What this
    // test actually needs to isolate is simpler: given a near-trigger
    // streak, a frame whose SMOOTHED cost genuinely reads under budget
    // must reset the streak without escalating.
    const g = createGovernorState();
    g.escalateStreak = cfg.governorEscalateFrames - 1; // one frame from triggering
    g.costEma = 0; // already-low smoothed cost (as if it had genuinely recovered)
    updateGovernor(g, 0, 16.7, cfg);
    expect(g.escalateStreak).toBe(0);
    expect(g.ladderLevel).toBe(0);
  });

  it('relaxes one level after governorRelaxFrames consecutive comfortably-under-budget frames', () => {
    const g = createGovernorState();
    g.ladderLevel = 1; // seeded directly — the escalate transition is covered above
    for (let i = 0; i < cfg.governorRelaxFrames; i++) updateGovernor(g, 0, 16.7, cfg);
    expect(g.ladderLevel).toBe(0);
  });

  it('never oscillates under noise that stays inside the dead zone (asymmetric hysteresis earning its keep)', () => {
    // The dead zone is (0.6x, 1.0x) budget — samples alternating strictly
    // inside it never make the SMOOTHED cost cross either boundary (the EMA
    // is bounded within the range of its recent inputs), so the streak
    // counters can never reach their trigger no matter how long this runs.
    // budgetMs is deterministic here: frameIntervalMs is constant, so it
    // settles to squadFrameShare * min(16.7, frameBudgetCapMs) from frame 1.
    const budget = cfg.squadFrameShare * Math.min(16.7, cfg.frameBudgetCapMs);
    const g = createGovernorState();
    for (let i = 0; i < cfg.governorEscalateFrames * 20; i++) {
      updateGovernor(g, i % 2 === 0 ? budget * 0.95 : budget * 0.65, 16.7, cfg);
    }
    expect(g.ladderLevel).toBe(0);
  });

  it('a sustained average load ABOVE budget escalates even while nominally "alternating" — hysteresis smooths noise, it does not mask real overload', () => {
    // Contrast case for the dead-zone test above: alternating between two
    // values whose average is clearly over budget must still escalate.
    // This is what proves the governor isn't just "never moves" — it
    // reacts to sustained load, only immune to boundary-straddling noise.
    const g = createGovernorState();
    for (let i = 0; i < cfg.governorEscalateFrames * 6; i++) {
      updateGovernor(g, i % 2 === 0 ? 2000 : 0, 16.7, cfg);
    }
    expect(g.ladderLevel).toBeGreaterThan(0);
  });

  it('never oscillates once escalated: alternating load around the new budget holds the level', () => {
    const g = createGovernorState();
    for (let i = 0; i < cfg.governorEscalateFrames; i++) updateGovernor(g, 1000, 16.7, cfg);
    expect(g.ladderLevel).toBe(1);
    // Let the cost EMA settle out of the 1000ms transient before measuring
    // flips — otherwise the still-decaying EMA legitimately reads as
    // over-budget for a stretch, and a further escalation there would be
    // correct governor behaviour, not oscillation. Once bounded within the
    // alternating samples' own range the EMA can't re-cross either boundary
    // by more than the ripple, so 200 frames is comfortably past settling
    // (EMA time constant 1/0.05 = 20 frames) before the 600-frame count
    // starts.
    for (let i = 0; i < 200; i++) updateGovernor(g, i % 2 === 0 ? g.budgetMs * 1.1 : g.budgetMs * 0.7, 16.7, cfg);
    let flips = 0;
    let last = g.ladderLevel;
    for (let i = 0; i < cfg.governorEscalateFrames * 20; i++) {
      updateGovernor(g, i % 2 === 0 ? g.budgetMs * 1.1 : g.budgetMs * 0.7, 16.7, cfg);
      if (g.ladderLevel !== last) { flips++; last = g.ladderLevel; }
    }
    expect(flips).toBe(0);
  });

  it('caps at the top of the 7-level ladder (0..6) under sustained extreme overload', () => {
    const g = createGovernorState();
    for (let i = 0; i < cfg.governorEscalateFrames * 10; i++) updateGovernor(g, 100000, 16.7, cfg);
    expect(g.ladderLevel).toBe(6);
  });

  it('floors at 0 under sustained extreme underload', () => {
    const g = createGovernorState();
    for (let i = 0; i < cfg.governorEscalateFrames; i++) updateGovernor(g, 1000, 16.7, cfg);
    for (let i = 0; i < cfg.governorRelaxFrames * 10; i++) updateGovernor(g, 0, 16.7, cfg);
    expect(g.ladderLevel).toBe(0);
  });

  it('hardware-adaptive: the SAME measured cost settles at different levels for different frame intervals', () => {
    // A "fast machine" frame interval (8ms, ~120Hz) is clamped by
    // frameBudgetCapMs same as a 16.7ms one in this cfg (cap 33.3), so use a
    // genuinely slow machine (50ms, 20fps) vs a fast one (8ms) to separate
    // the two budgets: slow -> budget capped at frameBudgetCapMs; fast ->
    // budget scaled off the smaller interval.
    const slow = createGovernorState();
    const fast = createGovernorState();
    const sampleMs = 10; // fixed, "hardware-independent" squad cost
    for (let i = 0; i < 300; i++) {
      updateGovernor(slow, sampleMs, 50, cfg);  // 20 fps machine
      updateGovernor(fast, sampleMs, 4, cfg);   // 250 fps machine
    }
    // Same cost, same cfg constants — only the measured cadence differs.
    expect(slow.budgetMs).toBeGreaterThan(fast.budgetMs);
    expect(slow.ladderLevel).toBeLessThan(fast.ladderLevel);
  });
});

describe('strideForLevel — §12c/§12d time-slicing table', () => {
  it('steps every full squad every frame below L4', () => {
    expect(strideForLevel(0)).toBe(1);
    expect(strideForLevel(1)).toBe(1);
    expect(strideForLevel(2)).toBe(1);
    expect(strideForLevel(3)).toBe(1);
  });
  it('halves at L4, thirds at L5, quarters at L6', () => {
    expect(strideForLevel(4)).toBe(2);
    expect(strideForLevel(5)).toBe(3);
    expect(strideForLevel(6)).toBe(4);
  });
});

// --- SquadManager delivery ---------------------------------------------------

function makeDef(overrides = {}) {
  return {
    defId: 'unit_test', squadSize: 4, formationType: 'blob', formationRadius: 15,
    maxSpeed: 5, customParams: {}, ...overrides,
  };
}

function managerWithSquads(n, backend = new NullRenderBackend(), overrides = {}) {
  const mgr = new SquadManager(backend, overrides);
  for (let i = 0; i < n; i++) {
    mgr.syncSquad(i, { x: i * 200, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef());
  }
  return mgr;
}

describe('SquadManager time-slicing schedule (§12d, §14 S2)', () => {
  it('every full squad is stepped exactly once per stride window, none stepped twice', () => {
    const mgr = managerWithSquads(6);
    mgr._governor.ladderLevel = 4; // stride 2, forced directly (fake-clock — see governor tests above)
    const updateSpy = vi.spyOn(Squad.prototype, 'update');

    const stepCounts = new Map();
    for (let f = 0; f < 2; f++) {
      updateSpy.mockClear();
      mgr.update(1 / 30);
      for (const inst of updateSpy.mock.instances) {
        stepCounts.set(inst.id, (stepCounts.get(inst.id) || 0) + 1);
      }
    }
    expect(stepCounts.size).toBe(6);
    for (const count of stepCounts.values()) expect(count).toBe(1);
  });

  it('partitions correctly at stride 3 (L5) over a 3-frame window', () => {
    const mgr = managerWithSquads(9);
    mgr._governor.ladderLevel = 5; // stride 3
    const updateSpy = vi.spyOn(Squad.prototype, 'update');

    const stepCounts = new Map();
    for (let f = 0; f < 3; f++) {
      updateSpy.mockClear();
      mgr.update(1 / 30);
      for (const inst of updateSpy.mock.instances) {
        stepCounts.set(inst.id, (stepCounts.get(inst.id) || 0) + 1);
      }
    }
    expect(stepCounts.size).toBe(9);
    for (const count of stepCounts.values()) expect(count).toBe(1);
  });

  it('a squad skipped for one frame gets ~2x dt on its next real step (motion speed preserved)', () => {
    const mgr = managerWithSquads(2); // id 0 -> fullIndex 0 (steps on even frameNo), id 1 -> fullIndex 1 (odd)
    mgr._governor.ladderLevel = 4; // stride 2
    const dt = 1 / 30;
    const updateSpy = vi.spyOn(Squad.prototype, 'update'); // default: calls through, just records

    mgr.update(dt); // frameNo 1 (odd): id 1 steps, id 0 coasts
    mgr.update(dt); // frameNo 2 (even): id 0 steps (first ever), id 1 coasts
    mgr.update(dt); // frameNo 3 (odd): id 1 steps again — one skipped frame in between

    const dtForId1 = updateSpy.mock.calls
      .filter((args, i) => updateSpy.mock.instances[i].id === 1)
      .map((args) => args[0]);
    expect(dtForId1.length).toBe(2);
    expect(dtForId1[0]).toBeCloseTo(dt, 5);      // first-ever step: no prior baseline
    expect(dtForId1[1]).toBeCloseTo(2 * dt, 5);  // steady state: stride*dt
  });

  it('coast() rigid-shifts a skipped squad\'s members so it never visibly freezes', () => {
    const b = new NullRenderBackend();
    const writes = [];
    b.updateMember = (h, x, y, z, hy, gait) => writes.push({ h, x, y, z });
    const mgr = managerWithSquads(2, b);
    mgr._governor.ladderLevel = 4; // stride 2 — one of the two squads coasts each frame

    const sq0 = mgr.squads.get(0);
    const before = { x: sq0.members[0].x, z: sq0.members[0].z };

    // Move squad 0's centroid via the normal ingest path — below the
    // teleport-guard threshold (200 elmos, config.js's teleportThreshold),
    // so setPose does NOT itself shift members; only coast() should. Then
    // run one frame where — by construction at stride 2, frame 1 — squad 0
    // is the one NOT stepped (index 0 wants frameNo%2===0, frame 1's
    // frameNo is 1).
    mgr.syncPose(0, { x: 50, y: 0, z: 0, heading: 0 });
    writes.length = 0;
    mgr.update(1 / 30);

    expect(mgr.perfDump().coasted.full).toBeGreaterThan(0);
    const after = { x: sq0.members[0].x, z: sq0.members[0].z };
    expect(after.x).not.toBe(before.x); // rigid-shifted, not frozen
    expect(writes.length).toBeGreaterThan(0); // and actually re-uploaded
  });

  it('at ladder level 0 (stride 1) every full squad steps every frame — pre-S2 behaviour preserved', () => {
    const mgr = managerWithSquads(5);
    const updateSpy = vi.spyOn(Squad.prototype, 'update');
    updateSpy.mockClear();
    mgr.update(1 / 30);
    expect(updateSpy.mock.instances.length).toBe(5);
    expect(mgr.perfDump().coasted.full).toBe(0);
    expect(mgr.perfDump().stepped.full).toBe(5);
  });

  it('a boarding/loaded transport squad always gets a real step, bypassing the schedule', () => {
    const mgr = managerWithSquads(2);
    mgr._governor.ladderLevel = 6; // stride 4 — would otherwise coast 3 of every 4 frames
    const sq1 = mgr.squads.get(1);
    sq1.onUnitLoaded(999, 300, 0, 0);
    expect(sq1.transportState).toBe('BOARDING');

    const updateSpy = vi.spyOn(Squad.prototype, 'update');
    for (let f = 0; f < 4; f++) {
      updateSpy.mockClear();
      mgr.update(1 / 30);
      const steppedIds = updateSpy.mock.instances.map((inst) => inst.id);
      expect(steppedIds).toContain(1); // every single frame, never skipped
    }
  });

  it('perfDump exposes squadCostMs/squadBudgetMs and a ladderLevel that mirrors the governor', () => {
    const mgr = managerWithSquads(3);
    mgr.update(1 / 30);
    const dump = mgr.perfDump();
    expect(dump.ladderLevel).toBe(mgr._governor.ladderLevel);
    expect(typeof dump.squadCostMs).toBe('number');
    expect(typeof dump.squadBudgetMs).toBe('number');
  });
});
