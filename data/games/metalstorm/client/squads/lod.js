// lod.js — the squad LOD tier state machine
// (PLAN-metalstorm-squad-performance.md §5 tier table, §12a thresholds).
//
// This is the primary scaling lever: the OO steering loop costs ~1 µs per
// member per frame regardless of where the camera is (§0c), so the only way
// to bound per-frame work is to stop stepping members nobody can see. Tiering
// is the decision of WHICH squads are worth stepping.
//
// Deliberately pure — no camera, no Squad, no render backend. The adapter
// (game-processor.ts gpComputeSquadLod) measures apparent screen size and
// visibility from the real camera; SquadManager.updateLod walks the squads;
// this file only decides. That split is what makes the hysteresis testable
// headlessly (§14 S1 acceptance: "extract it as computeTier(...) so it's
// testable without a camera").

export const LOD_FULL = 'full';
export const LOD_CENTROID = 'centroid';
export const LOD_ICON = 'icon';

/** Per-squad tier state. `tier` is the SETTLED (applied) tier; `want`/`dwell`
 *  track a transition that hasn't served its dwell yet, and `offscreenSec`
 *  accumulates the off-screen grace window. One of these per squad, mutated
 *  in place — `computeTier` must not allocate (it runs per squad per frame). */
export function createLodState(tier = LOD_FULL) {
  return { tier, want: tier, dwell: 0, offscreenSec: 0 };
}

/** Apparent on-screen size, in pixels, of something `radius` elmos across at
 *  `dist` elmos from the camera. `pxScale` = renderHeight / (2·tan(fov/2)) is
 *  pure camera state, so the adapter computes it once per frame rather than
 *  per squad. A camera sitting inside the squad reports Infinity (→ `full`),
 *  which is both correct and divide-by-zero-safe. */
export function screenPxFor(radius, dist, pxScale) {
  return dist > 1e-3 ? (radius * pxScale) / dist : Infinity;
}

/** The tier this squad WOULD be in right now, before hysteresis — §12a's
 *  table, with the ±20% band applied asymmetrically: a tier is entered at its
 *  threshold and left only below `lodDemoteBand`× it, so a squad parked
 *  exactly at a boundary has no reason to move (§14 S1's flicker acceptance).
 *  Off-screen keeps the current tier for `lodOffscreenGraceSec` first, so a
 *  camera pan across a battle doesn't release/rebuild every squad it sweeps. */
function desiredTier(state, screenPx, onScreen, dt, cfg) {
  if (!onScreen) {
    state.offscreenSec += dt;
    return state.offscreenSec > cfg.lodOffscreenGraceSec ? LOD_ICON : state.tier;
  }
  state.offscreenSec = 0;
  const band = cfg.lodDemoteBand;
  const fullIn = cfg.steerMinScreenPx;
  const centroidIn = cfg.iconScreenPx;
  if (state.tier === LOD_FULL) {
    if (screenPx >= fullIn * band) return LOD_FULL;
    return screenPx >= centroidIn * band ? LOD_CENTROID : LOD_ICON;
  }
  if (state.tier === LOD_CENTROID) {
    if (screenPx >= fullIn) return LOD_FULL;
    return screenPx >= centroidIn * band ? LOD_CENTROID : LOD_ICON;
  }
  if (screenPx >= fullIn) return LOD_FULL;
  return screenPx >= centroidIn ? LOD_CENTROID : LOD_ICON;
}

/** Advance one squad's tier state by one frame and return the settled tier.
 *  A change is applied only after `cfg.lodDwellFrames` CONSECUTIVE frames
 *  wanting the same new tier; wanting something else resets the dwell. Both
 *  guards matter: the band stops boundary jitter, the dwell stops a genuinely
 *  moving camera from paying release/rebuild churn for a brief pass. */
export function computeTier(state, screenPx, onScreen, dt, cfg) {
  const want = desiredTier(state, screenPx, onScreen, dt, cfg);
  if (want === state.tier) {
    state.want = want;
    state.dwell = 0;
    return state.tier;
  }
  if (want !== state.want) {
    state.want = want;
    state.dwell = 0;
  }
  if (++state.dwell >= cfg.lodDwellFrames) {
    state.tier = want;
    state.dwell = 0;
  }
  return state.tier;
}
