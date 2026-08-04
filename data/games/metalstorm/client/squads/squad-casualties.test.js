// squad-casualties.test.js — headless coverage for
// PLAN-metalstorm-squad-casualties.md tasks 1-7: the impact-hint ring
// (replacing the single `_impact` slot), burst-vs-stagger death timing,
// scored victim selection (impact-distance -> threat-flank -> edge/random),
// `_lastThreatDir` maintenance + the fog-of-war fallthrough, and the
// manager-level wreck pool (TTL/fade/cap). No Babylon/DOM — pure logic
// against a call-recording NullRenderBackend subclass, matching
// squad-sync/-cohesion/-collision's headless pattern.

import { describe, it, expect, vi } from 'vitest';
import { Squad } from './squad.js';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';
import { DEFAULT_CONFIG, linearCount } from './config.js';

function makeCfg(overrides = {}) {
  return { ...DEFAULT_CONFIG, countCurve: linearCount, ...overrides };
}

function makeDef(overrides = {}) {
  return {
    defId: 'unit_test',
    squadSize: 6,
    formationType: 'line',   // members lie along local x, z=0 — easy to reason about distances
    formationRadius: 30,
    maxSpeed: 5,
    customParams: {},
    ...overrides,
  };
}

// Records backend calls, including the two new wreck-pool hooks
// (despawnWreck/fadeWreck) and a handle->memberId map so tests can name
// *which* member died, not just how many.
class RecordingBackend extends NullRenderBackend {
  constructor() {
    super();
    this._next = 1;
    this.created = [];
    this.destroyed = [];
    this.released = [];
    this.wrecks = [];
    this.despawned = [];
    this.faded = [];
    this.handleToMember = new Map();
  }
  createMember(squadId, memberId) {
    const handle = this._next++;
    this.created.push({ handle, squadId, memberId });
    this.handleToMember.set(handle, memberId);
    return handle;
  }
  destroyMember(handle, death) { this.destroyed.push({ handle, death }); }
  releaseMember(handle) { this.released.push(handle); }
  spawnWreck(x, y, z, headingY, visual) {
    const handle = this._next++;
    this.wrecks.push({ handle, x, y, z, headingY, visual });
    return handle;
  }
  despawnWreck(handle) { this.despawned.push(handle); }
  fadeWreck(handle, alpha) { this.faded.push({ handle, alpha }); }
}

// A fresh, fully-alive 6-member line squad at the origin: world x positions
// -30,-18,-6,6,18,30 (z=0 throughout), member.id === array index === slot.
function spawnLineSquad(id, backend, cfg, defOverrides) {
  const def = makeDef(defOverrides);
  const sq = new Squad(id, def, backend, cfg);
  sq.setStrength(100, 100, 0);  // strength BEFORE pose (§6 — sizes the initial roster)
  sq.setPose(0, 0, 0, 0);
  return sq;
}

describe('AoE kills the near cluster (§3.1, §4)', () => {
  it('a valid impact hint kills the members nearest the blast, together, in the same reconcile', () => {
    const backend = new RecordingBackend();
    const sq = spawnLineSquad(1, backend, makeCfg());

    sq.reportImpact(20, 0, 0); // closest to members at x=18 (idx4) and x=30 (idx5)
    sq.setStrength(67, 100, 0); // curve(0.67,6)=round(4.02)=4 -> killCount=2

    expect(sq.aliveCount).toBe(4);
    expect(backend.destroyed.length).toBe(2); // both died THIS reconcile, no drain needed
    const deadIdx = backend.destroyed.map((d) => backend.handleToMember.get(d.handle)).sort((a, b) => a - b);
    expect(deadIdx).toEqual([4, 5]);
  });
});

describe('attrition staggers casualties over a short window (§2)', () => {
  it('a killCount>1 drop with no impact hint drips deaths out one at a time, not all in one frame', () => {
    const backend = new RecordingBackend();
    const sq = spawnLineSquad(1, backend, makeCfg());

    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5); // deterministic stagger interval (0.085s)
    try {
      sq.setStrength(67, 100, 0); // no impact hint -> attrition; killCount=2
      expect(sq.aliveCount).toBe(4);              // bookkeeping is immediate
      expect(backend.destroyed.length).toBe(0);   // FX deferred

      sq.update(0.05, 0.05, () => []);
      expect(backend.destroyed.length).toBe(0);   // still inside the first 0.085s interval

      sq.update(0.05, 0.10, () => []);
      expect(backend.destroyed.length).toBe(1);   // first death drains

      sq.update(0.05, 0.15, () => []);
      expect(backend.destroyed.length).toBe(1);   // second interval not yet up

      sq.update(0.05, 0.20, () => []);
      expect(backend.destroyed.length).toBe(2);   // both eventually drained
    } finally {
      randSpy.mockRestore();
    }
  });
});

describe('fog of war never reveals a hidden attacker (§6)', () => {
  it('a kill with no impact hint and no known threat bearing radiates outward from the centroid', () => {
    const backend = new RecordingBackend();
    const sq = spawnLineSquad(1, backend, makeCfg());
    expect(sq._threatDirKnown).toBe(false); // never told a bearing

    // A "hidden" attacker may exist conceptually anywhere — the squad is
    // simply never given its position (that's the wiring caller's job to
    // withhold for a fog event; see squad-manager.js's reportThreat doc).
    sq.setStrength(83, 100, 0); // curve(0.83,6)=round(4.98)=5 -> killCount=1
    sq.update(0.2, 0.2, () => []); // drain the queued attrition death

    expect(backend.destroyed.length).toBe(1);
    const { dirX } = backend.destroyed[0].death;
    const victimIdx = backend.handleToMember.get(backend.destroyed[0].handle);
    const victimSlotX = sq.slots[victimIdx].x; // world x == slot.x at centroid (0,0), heading 0
    expect(Math.sign(dirX)).toBe(Math.sign(victimSlotX)); // radiates outward from the centroid
    expect(sq._threatDirKnown).toBe(false); // still never learned a bearing
  });
});

describe('squad wipe cascades all remaining members (§7)', () => {
  it('destroy() kills everyone and flushes any still-queued staggered deaths rather than dropping them', () => {
    const backend = new RecordingBackend();
    const sq = spawnLineSquad(1, backend, makeCfg());

    // Queue one attrition death first (no hint) so it's still pending when
    // the squad is wiped — proves the cascade flushes it instead of leaving
    // its FX/wreck never played.
    sq.setStrength(83, 100, 0); // killCount=1, queued, not yet drained
    expect(sq._deathQueue.length).toBe(1);
    expect(backend.destroyed.length).toBe(0);

    sq.reportImpact(30, 0, 0); // the killing blast
    sq.destroy(0.1);

    expect(sq.aliveCount).toBe(0);
    expect(sq._deathQueue.length).toBe(0);
    expect(backend.destroyed.length).toBe(6); // all six, incl. the flushed queued one
    expect(sq.members.every((m) => !m.alive)).toBe(true);
  });
});

describe('health bounce never revives a member (monotonic clamp, §11 pitfall)', () => {
  it('strength recovering after a drop does not raise aliveCount or re-create instances', () => {
    const backend = new RecordingBackend();
    const sq = spawnLineSquad(1, backend, makeCfg());
    expect(backend.created.length).toBe(6);

    sq.reportImpact(0, 0, 0);
    sq.setStrength(50, 100, 0); // curve(0.5,6)=3 -> killCount=3
    expect(sq.aliveCount).toBe(3);
    const destroyedAfterDrop = backend.destroyed.length;
    expect(destroyedAfterDrop).toBe(3);

    sq.setStrength(90, 100, 0); // health "bounces" back up
    expect(sq.aliveCount).toBe(3);                       // never increases
    expect(backend.created.length).toBe(6);              // no new instances
    expect(backend.destroyed.length).toBe(destroyedAfterDrop); // no re-kill either
    expect(sq.members.filter((m) => m.alive).length).toBe(3);
  });
});

describe('overlapping blasts both register (§4 ring buffer)', () => {
  it('two impacts inside the hint window both stay valid; reconcile uses the one nearest the centroid', () => {
    const backend = new RecordingBackend();
    const sq = spawnLineSquad(1, backend, makeCfg());

    sq.reportImpact(40, 0, 0);   // far from the centroid
    sq.reportImpact(5, 0, 0.01); // nearer the centroid, landed just after
    // The old single-slot `_impact` would have dropped the first entry here.
    expect(sq._impacts.length).toBe(2);

    const hint = sq._validImpact(0.02);
    expect(hint.x).toBe(5); // nearest-to-centroid wins, not "most recent" alone

    sq.setStrength(67, 100, 0.02); // killCount=2, burst-killed clustered on the (5,0) hint
    expect(backend.destroyed.length).toBe(2);
    const deadIdx = backend.destroyed.map((d) => backend.handleToMember.get(d.handle)).sort((a, b) => a - b);
    expect(deadIdx).toEqual([2, 3]); // nearest to x=5: idx3 (x=6, dist 1), idx2 (x=-6, dist 11)
  });
});

describe('threat-bearing maintenance + directional selection (§3.2, §5)', () => {
  it('reportThreat sets the bearing on first contact and smooths (not snaps) on a second, different source', () => {
    const backend = new RecordingBackend();
    const sq = spawnLineSquad(1, backend, makeCfg());

    sq.reportThreat(100, 0); // attacker due +x of the centroid
    expect(sq._threatDirKnown).toBe(true);
    expect(sq._lastThreatDir.x).toBeCloseTo(1, 10);
    expect(sq._lastThreatDir.z).toBeCloseTo(0, 10);

    sq.reportThreat(0, 100); // a second source, due +z — smoothing blends, no snap to (0,1)
    expect(sq._lastThreatDir.x).toBeGreaterThan(0);
    expect(sq._lastThreatDir.x).toBeLessThan(1);
    expect(sq._lastThreatDir.z).toBeGreaterThan(0);
    expect(sq._lastThreatDir.z).toBeLessThan(1);
  });

  it('with a known bearing and no impact hint, the exposed flank facing the attacker is selected', () => {
    const backend = new RecordingBackend();
    const sq = spawnLineSquad(1, backend, makeCfg());

    sq.reportThreat(100, 0); // attacker due +x -> exposed flank is the +x side (idx5, x=30)
    sq.setStrength(83, 100, 0); // killCount=1, no impact hint -> attrition (stagger)
    sq.update(0.2, 0.2, () => []); // drain

    expect(backend.destroyed.length).toBe(1);
    const victimIdx = backend.handleToMember.get(backend.destroyed[0].handle);
    expect(victimIdx).toBe(5);
  });
});

describe('manager-level wreck pool: TTL/fade/global cap (§9)', () => {
  it('despawns a wreck once its TTL elapses, fading it during the trailing window first', () => {
    const backend = new RecordingBackend();
    const cfg = makeCfg({ wreckTtlSec: 10, wreckFadeSec: 3 });
    const mgr = new SquadManager(backend, cfg);
    const def = makeDef({ squadSize: 1 });
    mgr.syncSquad(1, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, def);
    mgr.syncSquad(1, { health: 0, maxHealth: 100 }); // wipe -> one wreck pooled
    // removeSquad drives the actual destroy(); simulate the sim telling the
    // client the squad-unit died.
    mgr.removeSquad(1);

    expect(mgr._wreckPool.length).toBe(1);

    for (let i = 0; i < 8 * 30; i++) mgr.update(1 / 30); // ~8s: past the fade start (10-3=7s), inside TTL
    expect(backend.faded.length).toBeGreaterThan(0);
    expect(mgr._wreckPool.length).toBe(1); // not despawned yet

    for (let i = 0; i < 5 * 30; i++) mgr.update(1 / 30); // ~13s total: comfortably past the 10s TTL
    expect(mgr._wreckPool.length).toBe(0);
    expect(backend.despawned.length).toBe(1);
  });

  it('evicts the oldest wreck once a squad exceeds maxWrecksPerSquad', () => {
    const backend = new RecordingBackend();
    const cfg = makeCfg({ maxWrecksPerSquad: 2, wreckTtlSec: 999 });
    const mgr = new SquadManager(backend, cfg);
    const def = makeDef({ squadSize: 6, formationType: 'line', formationRadius: 30 });
    mgr.syncSquad(1, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, def);

    // Three separate burst kills (each with its own impact hint) so each
    // reconcile pools exactly one wreck, one after another.
    mgr.reportImpact({ x: 20, z: 0, squadId: 1 });
    mgr.syncSquad(1, { health: 83, maxHealth: 100 }); // killCount=1
    mgr.reportImpact({ x: 20, z: 0, squadId: 1 });
    mgr.syncSquad(1, { health: 67, maxHealth: 100 }); // killCount=1 more
    mgr.reportImpact({ x: 20, z: 0, squadId: 1 });
    mgr.syncSquad(1, { health: 50, maxHealth: 100 }); // killCount=1 more -> 3rd wreck, cap=2

    expect(mgr._wreckPool.length).toBe(2);   // oldest evicted, only the cap remains
    expect(backend.despawned.length).toBe(1);
  });
});
