// squad-transport.test.js — headless coverage for PLAN-metalstorm-squad-
// transport.md tasks 1-7: the FREE->BOARDING->LOADED->UNLOADING->FREE state
// machine, instance release-not-kill on board, aliveCount-honouring re-spawn
// on unload, teleport-guard suppression while LOADED, paradrop descent +
// passable drop-point projection, and the manager-level heuristic fallback
// (§6 wire dependency). No Babylon/DOM — pure logic against
// NullRenderBackend, matching squad-sync/-cohesion/-collision/-casualties'
// headless pattern.

import { describe, it, expect } from 'vitest';
import { Squad } from './squad.js';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';
import { createPassability } from './passability.js';
import { projectDropPoint, descendStep, scatterSlot } from './squad-transport.js';

function makeCfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, countCurve: linearCount, ...overrides };
}

function makeDef(overrides = {}) {
  return {
    defId: 'unit_test',
    squadSize: 6,
    formationType: 'line',
    formationRadius: 5, // small so members start within arrivalRadius of the centroid
    maxSpeed: 5,
    customParams: { ms_class: 'tanks' }, // moveClass: 'VEH' (movement-profiles.js)
    ...overrides,
  };
}

function livingReleased(sq) {
  return sq.members.filter((m) => m.alive && m.released);
}
function livingVisible(sq) {
  // NullRenderBackend.createMember() always returns -1, so `released` (not
  // the handle value) is the live/hidden signal in headless tests.
  return sq.members.filter((m) => m.alive && !m.released);
}

describe('BOARDING -> LOADED: release not kill, steering suppressed (§2 tasks 1-2)', () => {
  it('releases (not kills) every living member once boarding completes, aliveCount untouched', () => {
    const backend = new NullRenderBackend();
    const sq = new Squad(1, makeDef(), backend, makeCfg());
    sq.setPose(0, 0, 0, 0);
    sq.setStrength(600, 600, 0);
    const aliveBefore = sq.aliveCount;
    expect(livingVisible(sq).length).toBe(aliveBefore);

    // Target == the squad's own centroid: every member's formation slot (radius 5)
    // is already within the default arrivalRadius (12), so boarding completes on
    // the very first update() call.
    sq.onUnitLoaded(99, 0, 0, 0);
    expect(sq.transportState).toBe('BOARDING');
    sq.update(0.05, 0, () => []);

    expect(sq.transportState).toBe('LOADED');
    expect(sq.aliveCount).toBe(aliveBefore); // no deaths — a release, not a kill
    expect(livingReleased(sq).length).toBe(aliveBefore);
    for (const m of sq.members) {
      if (!m.alive) continue;
      expect(m.handle).toBe(-1);
      expect(m.alive).toBe(true); // released != dead
    }
  });

  it('caps board time and hard-hides even if members never arrive (§7 pitfall)', () => {
    const backend = new NullRenderBackend();
    const cfg = makeCfg({ transportBoardTimeSec: 0.2 });
    const sq = new Squad(2, makeDef(), backend, cfg);
    sq.setPose(0, 0, 0, 0);
    sq.setStrength(600, 600, 0);

    sq.onUnitLoaded(99, 5000, 0, 5000); // far away — never reachable in one frame
    sq.update(0.05, 0, () => []); // elapsed 0.05 < 0.2s cap: still boarding
    expect(sq.transportState).toBe('BOARDING');
    expect(livingReleased(sq).length).toBe(0);

    sq.update(0.2, 0.05, () => []); // elapsed now >= 0.2s cap
    expect(sq.transportState).toBe('LOADED');
    expect(livingReleased(sq).length).toBe(sq.aliveCount);
  });

  it('suppresses normal steering while LOADED — no positional drift from update()', () => {
    const backend = new NullRenderBackend();
    const sq = new Squad(3, makeDef(), backend, makeCfg());
    sq.setPose(0, 0, 0, 0);
    sq.setStrength(600, 600, 0);
    sq.onUnitLoaded(99, 0, 0, 0);
    sq.update(0.05, 0, () => []); // -> LOADED
    const before = sq.members.map((m) => ({ x: m.x, z: m.z }));

    for (let i = 0; i < 20; i++) sq.update(0.05, 0.05 * (i + 1), () => []);

    const after = sq.members.map((m) => ({ x: m.x, z: m.z }));
    expect(after).toEqual(before);
  });
});

describe('UNLOADING re-spawn honours aliveCount (§2, §4 tasks 3, 7)', () => {
  it('recreates exactly aliveCount members at the drop point; dead members stay dead', () => {
    const backend = new NullRenderBackend();
    const sq = new Squad(4, makeDef(), backend, makeCfg());
    sq.setPose(0, 0, 0, 0);
    sq.setStrength(600, 600, 0);

    // Attrition down to a partial squad before boarding.
    sq.setStrength(200, 600, 1); // f=1/3 -> linearCount(6, 1/3) = round(2) = 2
    const aliveAfterAttrition = sq.aliveCount;
    expect(aliveAfterAttrition).toBeLessThan(6);
    const deadIds = new Set(sq.members.filter((m) => !m.alive).map((m) => m.id));

    sq.onUnitLoaded(99, 0, 0, 0);
    sq.update(0.05, 1, () => []); // -> LOADED, all living released

    sq.onUnitUnloaded(300, 12, 400, false, null);
    expect(sq.transportState).toBe('UNLOADING');
    expect(sq.aliveCount).toBe(aliveAfterAttrition);
    expect(livingVisible(sq).length).toBe(aliveAfterAttrition);
    for (const m of sq.members) {
      if (deadIds.has(m.id)) expect(m.alive).toBe(false); // never resurrected
    }
  });

  it('settles back to FREE after the unload window, having re-formed via normal steering', () => {
    const backend = new NullRenderBackend();
    const cfg = makeCfg({ transportUnloadSettleSec: 0.3 });
    const sq = new Squad(5, makeDef(), backend, cfg);
    sq.setPose(0, 0, 0, 0);
    sq.setStrength(600, 600, 0);
    sq.onUnitLoaded(99, 0, 0, 0);
    sq.update(0.05, 0, () => []); // -> LOADED

    sq.onUnitUnloaded(50, 0, 50, false, null);
    expect(sq.transportState).toBe('UNLOADING');

    let steps = 0;
    while (sq.transportState === 'UNLOADING' && steps < 100) {
      sq.update(0.05, steps * 0.05, () => []);
      steps++;
    }
    expect(sq.transportState).toBe('FREE');
    // Re-formed around the drop point (spill tightened back toward formation).
    for (const m of sq.members) {
      if (!m.alive) continue;
      expect(Math.hypot(m.x - 50, m.z - 50)).toBeLessThan(cfg.transportSpillMul * sq.def.formationRadius + 5);
    }
  });
});

describe('teleport-guard + stale-update suppression while LOADED (§6 task 4)', () => {
  it('does not reseed the trail or move members on a huge pose jump while LOADED', () => {
    const backend = new NullRenderBackend();
    const sq = new Squad(6, makeDef(), backend, makeCfg());
    sq.setPose(0, 0, 0, 0);
    sq.setStrength(600, 600, 0);
    sq.onUnitLoaded(99, 0, 0, 0);
    sq.update(0.05, 0, () => []); // -> LOADED
    const trailBefore = sq._trail.map((p) => ({ ...p }));
    const positionsBefore = sq.members.map((m) => ({ x: m.x, z: m.z }));

    sq.setPose(9000, 0, 9000, 0); // would be a teleport if FREE

    expect(sq.cx).toBe(9000); // pose is still tracked...
    expect(sq.cz).toBe(9000);
    expect(sq._trail).toEqual(trailBefore); // ...but the trail is untouched
    const positionsAfter = sq.members.map((m) => ({ x: m.x, z: m.z }));
    expect(positionsAfter).toEqual(positionsBefore); // members (released) didn't shift
  });

  it('unload repositions the squad straight to the drop point, ignoring any stale LOADED-era pose', () => {
    const backend = new NullRenderBackend();
    const sq = new Squad(7, makeDef(), backend, makeCfg());
    sq.setPose(0, 0, 0, 0);
    sq.setStrength(600, 600, 0);
    sq.onUnitLoaded(99, 0, 0, 0);
    sq.update(0.05, 0, () => []); // -> LOADED
    sq.setPose(9000, 0, 9000, 0); // stale/irrelevant pose while loaded

    sq.onUnitUnloaded(100, 0, 100, false, null); // drop point unrelated to the 9000 jump

    expect(sq.cx).toBe(100);
    expect(sq.cz).toBe(100);
    for (const m of sq.members) {
      if (!m.alive) continue;
      expect(Math.hypot(m.x - 100, m.z - 100)).toBeLessThan(50); // near the drop, not near 9000
    }
  });
});

describe('paradrop descent + passable drop-point projection (§5 task 5)', () => {
  it('descendStep lowers a member to groundY over time without overshooting below it', () => {
    const m = { y: 500 };
    let landed = false;
    for (let i = 0; i < 50 && !landed; i++) landed = descendStep(m, 10, 40, 0.25);
    expect(landed).toBe(true);
    expect(m.y).toBe(10);
  });

  it('projects an impassable drop point onto the nearest passable cell for the squad move class', () => {
    const sampler = {
      bounds: { minX: -200, minZ: -200, maxX: 200, maxZ: 200 },
      heightAt(x, z) {
        // A deep-water pit around the origin; flat land elsewhere.
        return (Math.abs(x) < 30 && Math.abs(z) < 30) ? -100 : 0;
      },
      waterLevel: 0,
    };
    const cfg = makeCfg();
    const passability = createPassability(sampler, cfg);
    expect(passability.passable(0, 0, 'VEH')).toBe(false); // too deep to wade

    const projected = projectDropPoint(0, 0, passability, 'VEH', cfg.slotProjectionCap);
    expect(projected).not.toEqual({ x: 0, z: 0 });
    expect(passability.passable(projected.x, projected.z, 'VEH')).toBe(true);
  });

  it('is a no-op without a passability grid or move class (air squads, §6)', () => {
    expect(projectDropPoint(12, 34, null, 'VEH', 4)).toEqual({ x: 12, z: 34 });
    expect(projectDropPoint(12, 34, {}, null, 4)).toEqual({ x: 12, z: 34 });
  });

  it('an airborne unload spawns members at altitude and they descend to ground over successive frames', () => {
    const backend = new NullRenderBackend();
    const sq = new Squad(8, makeDef(), backend, makeCfg({ paradropDescentRatePerSec: 200 }));
    sq.setPose(0, 0, 0, 0);
    sq.setStrength(600, 600, 0);
    sq.onUnitLoaded(99, 0, 90, 0);
    sq.update(0.05, 0, () => []); // -> LOADED

    sq.onUnitUnloaded(0, 400, 0, /* airborne */ true, null);
    for (const m of sq.members) if (m.alive) expect(m.y).toBe(400);

    let steps = 0;
    while (sq.transportState === 'UNLOADING' && steps < 200) {
      sq.update(0.05, steps * 0.05, () => []);
      steps++;
    }
    for (const m of sq.members) if (m.alive) expect(m.y).toBeCloseTo(backend.groundHeight(m.x, m.z), 1);
  });
});

describe('scatterSlot (§2 unload spill helper)', () => {
  it('inflates a non-zero slot outward by the scatter multiplier', () => {
    const s = scatterSlot({ x: 10, z: 0 }, 2, 0);
    expect(s).toEqual({ x: 20, z: 0 });
  });

  it('gives a zero-offset slot a deterministic non-zero fallback direction, distinct per member id', () => {
    const a = scatterSlot({ x: 0, z: 0 }, 5, 0);
    const b = scatterSlot({ x: 0, z: 0 }, 5, 1);
    expect(Math.hypot(a.x, a.z)).toBeCloseTo(5, 5);
    expect(Math.hypot(b.x, b.z)).toBeCloseTo(5, 5);
    expect(a).not.toEqual(b);
  });
});

describe('manager-level heuristic fallback (§6 task 6, wire dependency)', () => {
  it('infers BOARDING from a hidden squad co-located with a known transport-capable unit', () => {
    const mgr = new SquadManager(new NullRenderBackend());
    const sq = mgr._activate(10, makeDef(), { x: 0, y: 0, z: 0, heading: 0, health: 600, maxHealth: 600 });

    mgr.inferTransportState(10, /* hidden */ true, [{ id: 42, x: 5, z: 5 }]);
    expect(sq.transportState).toBe('BOARDING');
    expect(sq._transportHeuristic).toBe(true);

    // Re-calling while still hidden must not restart the timer/state.
    sq._transportElapsed = 999;
    mgr.inferTransportState(10, true, [{ id: 42, x: 5, z: 5 }]);
    expect(sq._transportElapsed).toBe(999);
  });

  it('does not infer LOADED when hidden but no carrier is within range', () => {
    const mgr = new SquadManager(new NullRenderBackend());
    const sq = mgr._activate(11, makeDef(), { x: 0, y: 0, z: 0, heading: 0, health: 600, maxHealth: 600 });
    mgr.inferTransportState(11, true, [{ id: 42, x: 5000, z: 5000 }]);
    expect(sq.transportState).toBe('FREE');
  });

  it('infers UNLOADING once a heuristically-loaded squad becomes visible again', () => {
    const mgr = new SquadManager(new NullRenderBackend());
    const sq = mgr._activate(12, makeDef(), { x: 0, y: 0, z: 0, heading: 0, health: 600, maxHealth: 600 });
    mgr.inferTransportState(12, true, [{ id: 42, x: 0, z: 0 }]);
    mgr.update(0.05); // BOARDING -> LOADED (target co-located)
    expect(sq.transportState).toBe('LOADED');

    mgr.inferTransportState(12, /* hidden */ false, []);
    expect(sq.transportState).toBe('UNLOADING');
    expect(sq._transportHeuristic).toBe(false);
  });
});
