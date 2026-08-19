// governor.js — the frame-time governor (PLAN-metalstorm-squad-performance.md
// §12c): a measured, hardware-adaptive budget for how much work the squad
// system may spend per frame, with an asymmetric-hysteresis degrade ladder
// (escalate fast, relax slow — never oscillate at the boundary). This is the
// §14 S2 milestone's core: no squad/member counts anywhere in this file,
// only measured milliseconds — a 120 Hz desktop and a 25 fps laptop
// steady-state at different ladder levels from the exact same cfg constants.
//
// Deliberately pure — no performance.now(), no camera, no Squad. The caller
// (SquadManager, both engines) supplies two measured samples each frame (its
// own update+flush cost, the adapter's inter-frame dt); this module only
// decides. Same split as lod.js's computeTier, for the same reason: a
// fake-clock unit test can drive this frame-by-frame without a real render
// loop (§14 S2 acceptance: "escalates after K over-budget frames, relaxes
// after K2, never oscillates under alternating load").

const WINDOW = 240;   // frames — §12c's rolling-window size for both samples
const MAX_LEVEL = 6;  // 7-level ladder (0..6) — §12c's degrade table

function createRing() {
  return { buf: new Float32Array(WINDOW), scratch: new Float32Array(WINDOW), idx: 0, count: 0 };
}

function ringPush(ring, v) {
  ring.buf[ring.idx] = v;
  ring.idx = (ring.idx + 1) % WINDOW;
  if (ring.count < WINDOW) ring.count++;
}

// Copies into a reused scratch buffer before sorting — `ring.buf` stays in
// insertion order so the next ringPush can keep overwriting it circularly.
function ringPercentile(ring, p) {
  const n = ring.count;
  if (n === 0) return 0;
  for (let i = 0; i < n; i++) ring.scratch[i] = ring.buf[i];
  const view = ring.scratch.subarray(0, n);
  view.sort(); // numeric ascending — Float32Array.sort has no lexicographic trap
  return view[Math.min(n - 1, Math.floor(p * n))];
}

/** Per-squad-system governor state — one per SquadManager (both engines). */
export function createGovernorState() {
  return {
    ladderLevel: 0,
    costEma: 0,
    budgetMs: Infinity,
    p95CostMs: 0,
    p50FrameIntervalMs: 0,
    escalateStreak: 0,
    relaxStreak: 0,
    _costRing: createRing(),
    _intervalRing: createRing(),
  };
}

/** Time-slicing stride for a ladder level (§12c/§12d's table): L4 halves,
 *  L5 thirds, L6 quarters full-squad stepping (on top of L6's own
 *  farthest-third centroid demotion, applied by the caller). L0-L3 step
 *  every full squad every frame (stride 1) — those levels degrade PHYSICS
 *  (separation/potential-field), not scheduling. */
export function strideForLevel(level) {
  if (level >= 6) return 4;
  if (level === 5) return 3;
  if (level === 4) return 2;
  return 1;
}

/** Advance the governor by one frame. `sampleMs` is this frame's measured
 *  squad-system cost (manager update + backend flush); `frameIntervalMs` is
 *  the adapter-supplied dt in ms — the machine's actual achieved cadence,
 *  which is what makes the budget hardware-adaptive (§12c: it bakes in
 *  display refresh AND everything else the frame is doing). Mutates `state`
 *  in place (like lod.js's computeTier) and returns the settled ladder
 *  level. Pure otherwise — no Date/performance access — so a fake-clock
 *  test can drive it deterministically. */
export function updateGovernor(state, sampleMs, frameIntervalMs, cfg) {
  ringPush(state._costRing, sampleMs);
  ringPush(state._intervalRing, frameIntervalMs);

  state.costEma += (sampleMs - state.costEma) * cfg.governorCostEmaAlpha;
  state.p95CostMs = ringPercentile(state._costRing, 0.95);
  // Bootstrap: an empty/near-empty ring's p50 would read 0 and starve the
  // budget on the very first frames — fall back to this frame's own sample.
  const p50 = ringPercentile(state._intervalRing, 0.5);
  state.p50FrameIntervalMs = p50 > 0 ? p50 : frameIntervalMs;

  state.budgetMs = cfg.squadFrameShare * Math.min(state.p50FrameIntervalMs, cfg.frameBudgetCapMs);

  if (state.costEma > state.budgetMs) {
    state.escalateStreak++;
    state.relaxStreak = 0;
    if (state.escalateStreak >= cfg.governorEscalateFrames) {
      state.ladderLevel = Math.min(MAX_LEVEL, state.ladderLevel + 1);
      state.escalateStreak = 0;
    }
  } else if (state.costEma < state.budgetMs * 0.6) {
    state.relaxStreak++;
    state.escalateStreak = 0;
    if (state.relaxStreak >= cfg.governorRelaxFrames) {
      state.ladderLevel = Math.max(0, state.ladderLevel - 1);
      state.relaxStreak = 0;
    }
  } else {
    // In the dead zone between 0.6x and 1x budget: neither streak advances,
    // so brief crossings in either direction can't accumulate toward a level
    // change — this is what "never oscillates" means in practice.
    state.escalateStreak = 0;
    state.relaxStreak = 0;
  }

  return state.ladderLevel;
}
