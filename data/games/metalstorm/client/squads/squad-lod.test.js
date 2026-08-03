// squad-lod.test.js — LOD tiering (PLAN-metalstorm-squad-performance.md §12a,
// milestone S1). Two halves:
//   1. the pure `computeTier` state machine — thresholds, band, dwell, grace.
//      No camera, no Squad, no backend (that's the point of extracting it).
//   2. the SquadManager.updateLod / setLod delivery path, including the §12b
//      icon-marker seam and the "icon tier costs nothing per member" property
//      the whole milestone exists for.

import { describe, it, expect } from 'vitest';
import { computeTier, createLodState, screenPxFor, LOD_FULL, LOD_CENTROID, LOD_ICON } from './lod.js';
import { SquadManager } from './squad-manager.js';
import { DEFAULT_CONFIG } from './config.js';
import { NullRenderBackend } from './render-backend.js';

const cfg = DEFAULT_CONFIG;
const DT = 1 / 60;

/** Run `frames` frames at a fixed apparent size / visibility. */
function settle(state, screenPx, onScreen, frames, c = cfg) {
  let tier = state.tier;
  for (let i = 0; i < frames; i++) tier = computeTier(state, screenPx, onScreen, DT, c);
  return tier;
}

describe('computeTier — thresholds (§12a table)', () => {
  it('holds full while the squad is comfortably big on screen', () => {
    const s = createLodState(LOD_FULL);
    expect(settle(s, cfg.steerMinScreenPx * 4, true, 120)).toBe(LOD_FULL);
  });

  it('demotes full -> centroid -> icon as apparent size shrinks', () => {
    const s = createLodState(LOD_FULL);
    // Between the icon and full thresholds (with band applied) => centroid.
    expect(settle(s, cfg.steerMinScreenPx * 0.5, true, cfg.lodDwellFrames + 1)).toBe(LOD_CENTROID);
    // Below the icon threshold's demote band => icon.
    expect(settle(s, cfg.iconScreenPx * 0.5, true, cfg.lodDwellFrames + 1)).toBe(LOD_ICON);
  });

  it('promotes icon -> full directly when the camera jumps in close', () => {
    const s = createLodState(LOD_ICON);
    expect(settle(s, cfg.steerMinScreenPx * 10, true, cfg.lodDwellFrames + 1)).toBe(LOD_FULL);
  });

  it('promotes icon -> centroid at the icon threshold, not straight to full', () => {
    const s = createLodState(LOD_ICON);
    expect(settle(s, cfg.iconScreenPx * 1.2, true, cfg.lodDwellFrames + 1)).toBe(LOD_CENTROID);
  });
});

describe('computeTier — hysteresis (the flicker guard)', () => {
  it('needs lodDwellFrames CONSECUTIVE frames before a change applies', () => {
    const s = createLodState(LOD_FULL);
    // One frame short: still full.
    expect(settle(s, 0, true, cfg.lodDwellFrames - 1)).toBe(LOD_FULL);
    expect(computeTier(s, 0, true, DT, cfg)).toBe(LOD_ICON);
  });

  it('resets the dwell when the wanted tier changes mid-transition', () => {
    const s = createLodState(LOD_FULL);
    settle(s, 0, true, cfg.lodDwellFrames - 1);            // almost demoted to icon
    settle(s, cfg.steerMinScreenPx * 0.5, true, 2);        // now wants centroid instead
    expect(s.tier).toBe(LOD_FULL);                         // nothing applied yet
    expect(settle(s, cfg.steerMinScreenPx * 0.5, true, cfg.lodDwellFrames)).toBe(LOD_CENTROID);
  });

  it('a squad parked EXACTLY at the full threshold never flips (§14 S1 acceptance)', () => {
    // 10 s at 60 fps sitting precisely on steerMinScreenPx, from either side.
    const held = createLodState(LOD_FULL);
    let flips = 0;
    for (let i = 0; i < 600; i++) {
      const before = held.tier;
      if (computeTier(held, cfg.steerMinScreenPx, true, DT, cfg) !== before) flips++;
    }
    expect(flips).toBe(0);

    const climbing = createLodState(LOD_CENTROID);
    flips = 0;
    for (let i = 0; i < 600; i++) {
      const before = climbing.tier;
      if (computeTier(climbing, cfg.steerMinScreenPx, true, DT, cfg) !== before) flips++;
    }
    expect(flips).toBe(1);            // one promotion, then settled
    expect(climbing.tier).toBe(LOD_FULL);
  });

  it('survives sub-threshold jitter across the boundary (the band earning its keep)', () => {
    const s = createLodState(LOD_FULL);
    let flips = 0;
    for (let i = 0; i < 600; i++) {
      // ±10% wobble around the threshold — inside the 20% demote band.
      const px = cfg.steerMinScreenPx * (i % 2 ? 1.1 : 0.9);
      const before = s.tier;
      if (computeTier(s, px, true, DT, cfg) !== before) flips++;
    }
    expect(flips).toBe(0);
  });
});

describe('computeTier — off-screen grace', () => {
  it('keeps the current tier through the grace window, then drops to icon', () => {
    const s = createLodState(LOD_FULL);
    const graceFrames = Math.floor(cfg.lodOffscreenGraceSec / DT);
    expect(settle(s, 100, false, graceFrames)).toBe(LOD_FULL);
    expect(settle(s, 100, false, cfg.lodDwellFrames + 1)).toBe(LOD_ICON);
  });

  it('coming back on screen inside the grace window costs nothing', () => {
    const s = createLodState(LOD_FULL);
    settle(s, 100, false, Math.floor(cfg.lodOffscreenGraceSec / DT) - 1);
    expect(settle(s, 100, true, 5)).toBe(LOD_FULL);
    expect(s.offscreenSec).toBe(0);
  });
});

describe('screenPxFor', () => {
  it('scales inversely with distance', () => {
    expect(screenPxFor(40, 1000, 500)).toBeCloseTo(20, 6);
    expect(screenPxFor(40, 2000, 500)).toBeCloseTo(10, 6);
  });

  it('reports Infinity (=> full) rather than dividing by zero', () => {
    expect(screenPxFor(40, 0, 500)).toBe(Infinity);
  });
});

// --- delivery path ---------------------------------------------------------

const DEF = {
  defId: 1, squadSize: 8, formationType: 'box', formationRadius: 40, maxSpeed: 30,
  customParams: { squad_size: 8 },
};

/** Backend that records the icon seam and reports a scripted visibility. */
class IconBackend extends NullRenderBackend {
  constructor() {
    super();
    this.icons = new Map();     // squadId → {x, y, z, radius}
    this.cleared = [];
    this.visible = true;
    this.memberWrites = 0;
    this.live = 0;              // outstanding member instances
    this.nextHandle = 1;
  }
  createMember() { this.live++; return this.nextHandle++; }
  updateMember() { this.memberWrites++; }
  releaseMember() { this.live--; }
  destroyMember() { this.live--; }
  isOnScreen() { return this.visible; }
  setIcon(id, x, y, z, radius) { this.icons.set(id, { x, y, z, radius }); }
  clearIcon(id) { if (this.icons.delete(id)) this.cleared.push(id); }
}

function managerWithSquad(backend, id = 7, x = 0, z = 0) {
  const mgr = new SquadManager(backend, {});
  mgr.syncSquad(id, { x, y: 0, z, heading: 0, health: 100, maxHealth: 100 }, DEF);
  return mgr;
}

describe('SquadManager LOD delivery (§12a/§12b)', () => {
  it('setLod forces a tier immediately and drives the icon seam both ways', () => {
    const b = new IconBackend();
    const mgr = managerWithSquad(b);
    expect(b.live).toBe(8);

    mgr.setLod(7, LOD_ICON);
    expect(mgr.squads.get(7).lod).toBe(LOD_ICON);
    expect(b.live).toBe(0);                     // instances released, not destroyed
    expect(b.icons.get(7)).toMatchObject({ x: 0, z: 0, radius: 40 });

    mgr.setLod(7, LOD_FULL);
    expect(b.live).toBe(8);                     // rebuilt at slots
    expect(b.icons.has(7)).toBe(false);
    expect(b.cleared).toEqual([7]);
  });

  it('updateLod tiers from real camera numbers, and the icon tracks the centroid', () => {
    const b = new IconBackend();
    const mgr = managerWithSquad(b);
    const pxScale = 600;                        // ≈ 1200px tall viewport at 90° fov
    // 400 000 elmos away: 40 * 600 / 400000 = 0.06 px — far below iconScreenPx.
    for (let i = 0; i < cfg.lodDwellFrames + 1; i++) mgr.updateLod(0, 0, 400000, pxScale, DT);
    expect(mgr.squads.get(7).lod).toBe(LOD_ICON);

    mgr.syncPose(7, { x: 500, y: 10, z: 600, heading: 0 });
    mgr.updateLod(0, 0, 400000, pxScale, DT);
    expect(b.icons.get(7)).toMatchObject({ x: 500, y: 10, z: 600 });

    // Camera drops onto the squad: 40 * 600 / 100 = 240 px — full.
    for (let i = 0; i < cfg.lodDwellFrames + 1; i++) mgr.updateLod(500, 110, 600, pxScale, DT);
    expect(mgr.squads.get(7).lod).toBe(LOD_FULL);
    expect(b.icons.has(7)).toBe(false);
  });

  it('an off-screen squad demotes to icon regardless of how big it would be', () => {
    const b = new IconBackend();
    const mgr = managerWithSquad(b);
    b.visible = false;
    const frames = Math.floor(cfg.lodOffscreenGraceSec / DT) + cfg.lodDwellFrames + 2;
    for (let i = 0; i < frames; i++) mgr.updateLod(0, 100, 0, 600, DT);
    expect(mgr.squads.get(7).lod).toBe(LOD_ICON);
  });

  it('icon-tier squads cost ZERO per-member work per frame (the scaling lever)', () => {
    const b = new IconBackend();
    const mgr = managerWithSquad(b);
    mgr.update(DT);
    const fullWrites = b.memberWrites;
    expect(fullWrites).toBe(8);                 // one matrix write per alive member

    mgr.setLod(7, LOD_ICON);
    b.memberWrites = 0;
    for (let i = 0; i < 10; i++) mgr.update(DT);
    expect(b.memberWrites).toBe(0);
    expect(mgr.perfDump().membersStepped).toBe(0);
    expect(mgr.perfDump().tierCounts.icon).toBe(1);

    // Centroid tier still parks members (cheap matrices), so it is NOT zero —
    // this is what distinguishes the two non-full tiers.
    mgr.setLod(7, LOD_CENTROID);
    b.memberWrites = 0;
    mgr.update(DT);
    expect(b.memberWrites).toBe(8);
    expect(mgr.perfDump().membersStepped).toBe(0);   // still out of the steering grid
  });

  it('casualties during icon tier land, and show up on the way back in', () => {
    const b = new IconBackend();
    const mgr = managerWithSquad(b);
    mgr.setLod(7, LOD_ICON);
    mgr.syncStrength(7, 50, 100);
    mgr.update(DT);
    expect(mgr.squads.get(7).aliveCount).toBe(4);
    mgr.setLod(7, LOD_FULL);
    expect(b.live).toBe(4);                     // rebuilt at the REDUCED count
  });

  it('removeSquad clears a live icon marker', () => {
    const b = new IconBackend();
    const mgr = managerWithSquad(b);
    mgr.setLod(7, LOD_ICON);
    expect(b.icons.has(7)).toBe(true);
    mgr.removeSquad(7);
    expect(b.icons.has(7)).toBe(false);
  });

  it('a squad first seen at icon tier never creates instances it must then release', () => {
    const b = new IconBackend();
    const mgr = new SquadManager(b, {});
    mgr.syncSquad(9, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100, lod: LOD_ICON }, DEF);
    expect(b.live).toBe(0);
    expect(mgr.squads.get(9).lod).toBe(LOD_ICON);
    mgr.setLod(9, LOD_FULL);
    expect(b.live).toBe(8);
  });
});
