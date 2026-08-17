// soa-squad.test.js — SquadRec (soa-squad.js) headless coverage, mirroring
// squad-sync.test.js's scenarios one-for-one against `engine: 'soa'`
// (PLAN-metalstorm-squad-performance.md §14 S3 acceptance: "SquadRec —
// death retains slots, release/rebuild flag rules — mirror the squad-sync
// test cases against the SoA engine"). Same RecordingBackend, same def
// shape; assertions read store flags (isAlive/isReleased) via the squad's
// [base, base+size) run instead of `sq.members`.

import { describe, it, expect } from 'vitest';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';
import { isAlive, isReleased } from './soa-store.js';

class RecordingBackend extends NullRenderBackend {
  constructor() {
    super();
    this._next = 1;
    this.created = [];
    this.destroyed = [];
    this.released = [];
    this.wrecks = 0;
  }
  createMember(squadId, memberId, visual) {
    const handle = this._next++;
    this.created.push({ handle, squadId, memberId });
    return handle;
  }
  destroyMember(handle, death) { this.destroyed.push({ handle, death }); }
  releaseMember(handle) { this.released.push(handle); }
  spawnWreck() { this.wrecks++; }
}

function makeDef(overrides = {}) {
  return {
    defId: 'unit_test',
    squadSize: 10,
    formationType: 'line',
    formationRadius: 20,
    maxSpeed: 5,
    ...overrides,
  };
}

function makeMgr(backend, overrides = {}) {
  return new SquadManager(backend, { engine: 'soa', ...overrides });
}

// Count slots in `sq`'s run matching a predicate over (store, slotIndex).
function countSlots(mgr, sq, pred) {
  let n = 0;
  for (let i = sq.base; i < sq.base + sq.size; i++) if (pred(mgr.store, i)) n++;
  return n;
}
const aliveCount = (mgr, sq) => countSlots(mgr, sq, isAlive);
const aliveNotReleasedCount = (mgr, sq) => countSlots(mgr, sq, (s, i) => isAlive(s, i) && !isReleased(s, i));
const deadCount = (mgr, sq) => countSlots(mgr, sq, (s, i) => !isAlive(s, i));

describe('engine: soa — construction uses the store, not Squad/Member', () => {
  it('SquadManager with engine:"soa" builds SquadRec instances backed by mgr.store', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr(backend);
    mgr.syncSquad(1, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef({ squadSize: 4 }));
    const sq = mgr.squads.get(1);
    expect(mgr.store).toBeTruthy();
    expect(sq.base).toBeGreaterThanOrEqual(0);
    expect(sq.size).toBe(4);
  });
});

describe('def-after-state ordering (H1) — soa', () => {
  it('buffers pose+strength arriving before the def, then flushes on noteDef', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr(backend);

    mgr.syncPose(1, { x: 100, y: 0, z: 200, heading: 0 });
    mgr.syncStrength(1, 80, 100);

    expect(mgr.squads.has(1)).toBe(false);
    expect(backend.created.length).toBe(0);

    mgr.noteDef(1, makeDef({ squadSize: 10 }));

    expect(mgr.squads.has(1)).toBe(true);
    const sq = mgr.squads.get(1);
    expect(sq.cx).toBe(100);
    expect(sq.cz).toBe(200);
    expect(sq.aliveCount).toBe(8); // curve(0.8, 10) = 8
    expect(backend.created.length).toBe(8);
    expect(backend.destroyed.length).toBe(0);
  });

  it('is a no-op when a def arrives with nothing pending', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr(backend);
    mgr.noteDef(42, makeDef());
    expect(mgr.squads.has(42)).toBe(false);
  });

  it('does not drop a squad already constructed via the def-carrying path', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr(backend);
    mgr.syncSquad(7, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef());
    expect(mgr.squads.has(7)).toBe(true);
    expect(() => mgr.noteDef(7, makeDef())).not.toThrow();
    expect(mgr.squads.get(7).aliveCount).toBe(10);
  });
});

describe('id reuse (H2) — soa', () => {
  it('EntityDestroy clears buffered pending state so a reused id starts clean', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr(backend);

    mgr.syncPose(3, { x: 500, y: 0, z: 500, heading: 0 });
    mgr.syncStrength(3, 50, 100);
    mgr.removeSquad(3);

    mgr.noteDef(3, makeDef());
    expect(mgr.squads.has(3)).toBe(false);
    expect(backend.created.length).toBe(0);

    mgr.syncSquad(3, { x: 1, y: 0, z: 1, heading: 0, health: 100, maxHealth: 100 }, makeDef());
    expect(mgr.squads.has(3)).toBe(true);
    const sq = mgr.squads.get(3);
    expect(sq.cx).toBe(1);
    expect(sq.cz).toBe(1);
    expect(sq.aliveCount).toBe(10);
  });

  it('destroying a live squad also cascades member deaths and frees the run', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr(backend);
    mgr.syncSquad(9, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef({ squadSize: 4 }));
    const sq = mgr.squads.get(9);
    const base = sq.base;
    expect(backend.created.length).toBe(4);
    mgr.removeSquad(9);
    expect(backend.destroyed.length).toBe(4);
    expect(mgr.squads.has(9)).toBe(false);

    // Squad granularity free (§10d): the freed run is reused by the NEXT
    // same-size allocation, proving the store's free-list actually ran.
    mgr.syncSquad(10, { x: 1, y: 1, z: 1, heading: 0, health: 100, maxHealth: 100 }, makeDef({ squadSize: 4 }));
    expect(mgr.squads.get(10).base).toBe(base);
  });
});

describe('LOD release/rebuild preserves aliveCount (Pitfalls #2, #3) — soa', () => {
  it('full → icon releases instances without touching aliveCount; icon → full rebuilds exactly aliveCount', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr(backend);
    mgr.syncSquad(11, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef({ squadSize: 6 }));
    const sq = mgr.squads.get(11);
    expect(backend.created.length).toBe(6);

    // Attrition kill (no impact hint) — aliveCount drops synchronously, FX
    // drains on the next update() tick.
    mgr.syncStrength(11, 80, 100); // curve(0.8, 6) = round(4.8) = 5
    expect(sq.aliveCount).toBe(5);
    mgr.update(0.2); // > staggerIntervalMaxSec — drains the one queued death
    expect(backend.destroyed.length).toBe(1);

    // full → icon: thin to iconMemberCount, aliveCount unchanged, no death FX.
    const keep = mgr.cfg.iconMemberCount;
    mgr.syncSquad(11, { x: 0, y: 0, z: 0, heading: 0, health: 80, maxHealth: 100, lod: 'icon' }, undefined);
    expect(sq.lod).toBe('icon');
    expect(sq.aliveCount).toBe(5);
    expect(backend.released.length).toBe(5 - keep);
    expect(backend.destroyed.length).toBe(1);
    expect(aliveNotReleasedCount(mgr, sq)).toBe(keep);

    // A strength drop while at icon LOD still lowers the count with no FX.
    mgr.syncStrength(11, 60, 100); // curve(0.6, 6) = round(3.6) = 4
    expect(sq.aliveCount).toBe(4);
    expect(backend.destroyed.length).toBe(1);
    expect(backend.wrecks).toBe(1);

    // icon → full: every still-alive member (4) ends up instanced again,
    // dead stay dead (no resurrection).
    mgr.syncSquad(11, { x: 0, y: 0, z: 0, heading: 0, health: 60, maxHealth: 100, lod: 'full' }, undefined);
    expect(sq.lod).toBe('full');
    expect(sq.aliveCount).toBe(4);
    expect(aliveNotReleasedCount(mgr, sq)).toBe(4);
    expect(aliveCount(mgr, sq)).toBe(4);
    expect(deadCount(mgr, sq)).toBe(2);
  });
});

describe('reconnect reconstructs count without resurrection (§6) — soa', () => {
  it('a fresh squad at partial strength spawns exactly curve(strength) members with zero destroyMember calls', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr(backend);

    mgr.syncSquad(21, { x: 10, y: 0, z: 10, heading: 0, health: 60, maxHealth: 100 }, makeDef({ squadSize: 10 }));
    const sq = mgr.squads.get(21);

    expect(sq.aliveCount).toBe(6);
    expect(backend.created.length).toBe(6);
    expect(backend.destroyed.length).toBe(0);
    expect(backend.wrecks).toBe(0);
    expect(aliveCount(mgr, sq)).toBe(6);
    expect(deadCount(mgr, sq)).toBe(4);
  });

  it('buffered def-after-state reconnect path is equally replay-free', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr(backend);
    mgr.syncStrength(22, 30, 100);
    mgr.syncPose(22, { x: 0, y: 0, z: 0, heading: 0 });
    mgr.noteDef(22, makeDef({ squadSize: 10 }));

    const sq = mgr.squads.get(22);
    expect(sq.aliveCount).toBe(3);
    expect(backend.created.length).toBe(3);
    expect(backend.destroyed.length).toBe(0);
  });
});

describe('applyAtFrame stub (§7, no-op until PLAN-latency L1) — soa', () => {
  it('accepts the parameter and applies immediately regardless of its value', () => {
    const backend = new RecordingBackend();
    const mgr = makeMgr(backend);
    mgr.syncSquad(30, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef({ squadSize: 4 }));
    const sq = mgr.squads.get(30);
    mgr.syncStrength(30, 25, 100, /* applyAtFrame */ 99999);
    expect(sq.aliveCount).toBe(1);
  });
});

describe('SoA is the default engine (§14 S7); OO is still selectable', () => {
  it('a plain SquadManager (no engine override) now builds store-backed SquadRec instances', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend);
    expect(mgr.engine).toBe('soa');
    expect(mgr.store).not.toBeNull();
    mgr.syncSquad(1, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef({ squadSize: 3 }));
    const sq = mgr.squads.get(1);
    expect(Array.isArray(sq.members)).toBe(false);
    expect(countSlots(mgr, sq, (store, i) => isAlive(store, i))).toBe(3);
  });

  it('engine: "oo" still builds real Squad instances (escape hatch, §10a)', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend, { engine: 'oo' });
    expect(mgr.engine).toBe('oo');
    expect(mgr.store).toBeNull();
    mgr.syncSquad(1, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef({ squadSize: 3 }));
    const sq = mgr.squads.get(1);
    expect(Array.isArray(sq.members)).toBe(true);
    expect(sq.members.length).toBe(3);
  });
});
