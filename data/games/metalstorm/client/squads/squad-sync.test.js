// squad-sync.test.js — headless coverage for PLAN-metalstorm-squad-sync.md
// tasks 1-7: pose/strength split, def-before-state buffering (H1), id reuse
// (H2), LOD instance lifecycle (§5), and the no-replay reconnect path (§6).
// No Babylon/DOM — pure logic against NullRenderBackend + a call-recording
// subclass, matching the "headless tests (NullRenderBackend)" requirement.

import { describe, it, expect } from 'vitest';
import { SquadManager } from './squad-manager.js';
import { NullRenderBackend } from './render-backend.js';
import { isSquadDef } from './config.js';

// Records backend calls so tests can assert on the visual-effect sequence
// (e.g. "no destroyMember calls" proves no death-FX replay on reconnect).
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

describe('isSquadDef routing predicate (H3)', () => {
  it('routes squad_size > 1 through the squad system', () => {
    expect(isSquadDef({ customParams: { squad_size: 10 } })).toBe(true);
  });
  it('excludes squad_size 1 (scale-4 super-heavies, buildings)', () => {
    expect(isSquadDef({ customParams: { squad_size: 1 } })).toBe(false);
    expect(isSquadDef({ customParams: {} })).toBe(false);
    expect(isSquadDef({})).toBe(false);
  });
});

describe('def-after-state ordering (H1)', () => {
  it('buffers pose+strength arriving before the def, then flushes on noteDef', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend);

    // State arrives first — def not yet known (on-demand def streaming).
    mgr.syncPose(1, { x: 100, y: 0, z: 200, heading: 0 });
    mgr.syncStrength(1, 80, 100);

    expect(mgr.squads.has(1)).toBe(false);
    expect(backend.created.length).toBe(0);

    // DefCache resolves the def — the manager constructs and flushes.
    mgr.noteDef(1, makeDef({ squadSize: 10 }));

    expect(mgr.squads.has(1)).toBe(true);
    const sq = mgr.squads.get(1);
    expect(sq.cx).toBe(100);
    expect(sq.cz).toBe(200);
    // 80% strength of a 10-member squad → 8 alive, spawned directly (no kills).
    expect(sq.aliveCount).toBe(8);
    expect(backend.created.length).toBe(8);
    expect(backend.destroyed.length).toBe(0);
  });

  it('is a no-op when a def arrives with nothing pending (the common order)', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend);
    mgr.noteDef(42, makeDef());
    expect(mgr.squads.has(42)).toBe(false);
  });

  it('does not drop a squad already constructed via the def-carrying path', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend);
    mgr.syncSquad(7, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef());
    expect(mgr.squads.has(7)).toBe(true);
    // A late/duplicate def notification must not reconstruct or throw.
    expect(() => mgr.noteDef(7, makeDef())).not.toThrow();
    expect(mgr.squads.get(7).aliveCount).toBe(10);
  });
});

describe('id reuse (H2)', () => {
  it('EntityDestroy clears buffered pending state so a reused id starts clean', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend);

    // Old entity: state arrives, def never resolves before destroy.
    mgr.syncPose(3, { x: 500, y: 0, z: 500, heading: 0 });
    mgr.syncStrength(3, 50, 100);
    mgr.removeSquad(3);

    // A def resolving for the old (now-destroyed) id must not resurrect it.
    mgr.noteDef(3, makeDef());
    expect(mgr.squads.has(3)).toBe(false);
    expect(backend.created.length).toBe(0);

    // Id 3 is reused for a brand-new entity at a different position/health.
    mgr.syncSquad(3, { x: 1, y: 0, z: 1, heading: 0, health: 100, maxHealth: 100 }, makeDef());
    expect(mgr.squads.has(3)).toBe(true);
    const sq = mgr.squads.get(3);
    expect(sq.cx).toBe(1);
    expect(sq.cz).toBe(1);
    expect(sq.aliveCount).toBe(10); // fresh squad, full strength — no leakage from the old one
  });

  it('destroying a live squad also cascades member deaths', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend);
    mgr.syncSquad(9, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef({ squadSize: 4 }));
    expect(backend.created.length).toBe(4);
    mgr.removeSquad(9);
    expect(backend.destroyed.length).toBe(4);
    expect(mgr.squads.has(9)).toBe(false);
  });
});

describe('LOD release/rebuild preserves aliveCount (Pitfalls #2, #3)', () => {
  it('full → icon releases instances without touching aliveCount; icon → full rebuilds exactly aliveCount', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend);
    mgr.syncSquad(11, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef({ squadSize: 6 }));
    const sq = mgr.squads.get(11);
    expect(backend.created.length).toBe(6);

    // Take one casualty before going to icon LOD, so aliveCount < size.
    mgr.syncStrength(11, 80, 100); // curve(0.8, 6) = round(4.8) = 5
    expect(sq.aliveCount).toBe(5);
    expect(backend.destroyed.length).toBe(1);

    // full → icon: release the 5 living instances, no death FX, count unchanged.
    mgr.syncSquad(11, { x: 0, y: 0, z: 0, heading: 0, health: 80, maxHealth: 100, lod: 'icon' }, undefined);
    expect(sq.lod).toBe('icon');
    expect(sq.aliveCount).toBe(5);
    expect(backend.released.length).toBe(5);
    expect(backend.destroyed.length).toBe(1); // unchanged — releases are not deaths
    for (const m of sq.members) if (m.alive) expect(m.released).toBe(true);

    // A strength drop while at icon LOD still lowers the count with no FX
    // (the member has no live instance to animate).
    mgr.syncStrength(11, 60, 100); // curve(0.6, 6) = round(3.6) = 4
    expect(sq.aliveCount).toBe(4);
    expect(backend.destroyed.length).toBe(1); // still just the one real (pre-icon) kill
    expect(backend.wrecks).toBe(1); // ditto — the icon-tier kill drops no wreck

    // icon → full: rebuild exactly the still-alive members (4), dead stay dead.
    mgr.syncSquad(11, { x: 0, y: 0, z: 0, heading: 0, health: 60, maxHealth: 100, lod: 'full' }, undefined);
    expect(sq.lod).toBe('full');
    expect(sq.aliveCount).toBe(4);
    const rebuiltCount = backend.created.length - 6; // instances created after the initial spawn batch
    expect(rebuiltCount).toBe(4);
    expect(sq.members.filter((m) => m.alive).length).toBe(4);
    expect(sq.members.filter((m) => !m.alive).length).toBe(2);
  });
});

describe('reconnect reconstructs count without resurrection (§6)', () => {
  it('a fresh squad at partial strength spawns exactly curve(strength) members with zero destroyMember calls', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend);

    // Full snapshot on reconnect: pose + strength arrive together, as one
    // syncSquad call, at 60% health — simulating a squad damaged before the
    // client ever saw it.
    mgr.syncSquad(21, { x: 10, y: 0, z: 10, heading: 0, health: 60, maxHealth: 100 }, makeDef({ squadSize: 10 }));
    const sq = mgr.squads.get(21);

    expect(sq.aliveCount).toBe(6); // curve(0.6, 10) = 6
    expect(backend.created.length).toBe(6); // only the alive roster was ever created
    expect(backend.destroyed.length).toBe(0); // no casualty animation was replayed
    expect(backend.wrecks).toBe(0);
    expect(sq.members.filter((m) => m.alive).length).toBe(6);
    expect(sq.members.filter((m) => !m.alive).length).toBe(4);
  });

  it('buffered def-after-state reconnect path is equally replay-free', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend);
    mgr.syncStrength(22, 30, 100);
    mgr.syncPose(22, { x: 0, y: 0, z: 0, heading: 0 });
    mgr.noteDef(22, makeDef({ squadSize: 10 }));

    const sq = mgr.squads.get(22);
    expect(sq.aliveCount).toBe(3); // curve(0.3, 10) = 3
    expect(backend.created.length).toBe(3);
    expect(backend.destroyed.length).toBe(0);
  });
});

describe('applyAtFrame stub (§7, no-op until PLAN-latency L1)', () => {
  it('accepts the parameter and applies immediately regardless of its value', () => {
    const backend = new RecordingBackend();
    const mgr = new SquadManager(backend);
    mgr.syncSquad(30, { x: 0, y: 0, z: 0, heading: 0, health: 100, maxHealth: 100 }, makeDef({ squadSize: 4 }));
    const sq = mgr.squads.get(30);
    mgr.syncStrength(30, 25, 100, /* applyAtFrame */ 99999);
    expect(sq.aliveCount).toBe(1); // curve(0.25, 4) = 1, applied immediately
  });
});
