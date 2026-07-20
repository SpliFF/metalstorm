// ui/lib/objectives.test.js — client objective-index tests.
// Run: cd client && npx vitest run --config ../data/games/metalstorm/ui/vitest.config.js --root ../data/games/metalstorm/ui

import { describe, it, expect } from 'vitest';
import { createObjectiveIndex } from './objectives.js';

describe('applyParams ingestion', () => {
  it('parses type/scope/state/reward/team/progress off the wire', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({
      objective_count: 1,
      objective_1_type: 'control',
      objective_1_scope: 'strategic',
      objective_1_state: 'active',
      objective_1_reward: 50,
      objective_1_team: 3,
      objective_1_progress: 0.25,
    });
    const o = idx.get(1);
    expect(o).toEqual({
      id: 1, type: 'control', scope: 'strategic', state: 'active',
      reward: 50, team: 3, progress: 0.25,
    });
  });

  it('coerces numeric fields even when the batch carries them as strings', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({ objective_count: 1, objective_1_reward: '75', objective_1_team: '-1' });
    expect(idx.get(1).reward).toBe(75);
    expect(idx.get(1).team).toBe(-1);
  });

  it('leaves non-numeric fields (type, region) as-is', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({ objective_count: 1, objective_1_type: 'control', objective_1_region: 'r1' });
    expect(idx.get(1).type).toBe('control');
    expect(idx.get(1).region).toBe('r1');
  });

  it('ignores keys that do not match the objective_<id>_<field> shape', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({ authority_pool: 100, regions_rev: 2, objective_count: 0 });
    expect(idx.list()).toEqual([]);
  });

  it('returns false (no change) for a no-op repeat batch', () => {
    const idx = createObjectiveIndex();
    const batch = { objective_count: 1, objective_1_type: 'kill', objective_1_state: 'active' };
    expect(idx.applyParams(batch)).toBe(true);
    expect(idx.applyParams(batch)).toBe(false);
  });
});

describe('resolve-retention clearing (§1 "params cleared by setting nil")', () => {
  it('deletes a field when the batch carries an explicit null', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({ objective_count: 1, objective_1_type: 'kill', objective_1_state: 'complete' });
    expect(idx.get(1).state).toBe('complete');
    idx.applyParams({ objective_1_state: null, objective_1_type: null });
    expect(idx.get(1).type).toBeUndefined();
    expect(idx.get(1).state).toBeUndefined();
  });

  it('drops a fully-cleared objective from list()', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({ objective_count: 1, objective_1_type: 'kill', objective_1_state: 'complete' });
    expect(idx.list()).toHaveLength(1);
    idx.applyParams({
      objective_1_type: null, objective_1_scope: null, objective_1_state: null,
      objective_1_reward: null, objective_1_team: null, objective_1_progress: null,
    });
    expect(idx.list()).toEqual([]);
  });

  it('never decrements objective_count on clear (high-water mark, §1)', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({ objective_count: 3, objective_1_type: 'kill' });
    idx.applyParams({ objective_1_type: null });
    expect(idx.count).toBe(3);
  });
});

describe('pull() — poll-style ingestion against a singular getParam(key)', () => {
  function storeFrom(map) {
    return (key) => map[key];
  }

  it('reads objective_count then every published field per id', () => {
    const idx = createObjectiveIndex();
    const changed = idx.pull(storeFrom({
      objective_count: 1,
      objective_1_type: 'kill',
      objective_1_state: 'active',
      objective_1_reward: 25,
    }));
    expect(changed).toBe(true);
    expect(idx.get(1)).toMatchObject({ type: 'kill', state: 'active', reward: 25 });
  });

  it('treats a getter returning undefined as cleared (no distinct "unchanged" state in a poll)', () => {
    const idx = createObjectiveIndex();
    const store = { objective_count: 1, objective_1_type: 'kill', objective_1_state: 'complete' };
    idx.pull(storeFrom(store));
    expect(idx.get(1).state).toBe('complete');

    delete store.objective_1_state;
    delete store.objective_1_type;
    const changed = idx.pull(storeFrom(store));
    expect(changed).toBe(true);
    expect(idx.get(1).state).toBeUndefined();
    expect(idx.list()).toEqual([]);
  });

  it('returns false on a stable repeat poll', () => {
    const idx = createObjectiveIndex();
    const store = { objective_count: 1, objective_1_type: 'kill', objective_1_state: 'active' };
    idx.pull(storeFrom(store));
    expect(idx.pull(storeFrom(store))).toBe(false);
  });

  it('picks up growth in objective_count and new ids on the next poll', () => {
    const idx = createObjectiveIndex();
    const store = { objective_count: 1, objective_1_type: 'kill' };
    idx.pull(storeFrom(store));
    store.objective_count = 2;
    store.objective_2_type = 'control';
    idx.pull(storeFrom(store));
    expect(idx.list().map((o) => o.id)).toEqual([1, 2]);
  });
});

describe('list() and objective_count gaps', () => {
  it('skips ids with no live params (a rejected Create burned the id, §1)', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({
      objective_count: 3,
      objective_1_type: 'kill',
      // id 2 deliberately absent (Create validated and rejected it)
      objective_3_type: 'control',
    });
    expect(idx.list().map((o) => o.id)).toEqual([1, 3]);
  });
});

describe('forTeam filtering', () => {
  it('includes open-race objectives (team -1) for any team', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({
      objective_count: 2,
      objective_1_type: 'control', objective_1_state: 'active', objective_1_team: -1,
      objective_2_type: 'kill', objective_2_state: 'active', objective_2_team: 4,
    });
    const forTeam3 = idx.forTeam(3, 'active').map((o) => o.id);
    expect(forTeam3).toEqual([1]);
    expect(idx.forTeam(4, 'active').map((o) => o.id)).toEqual([1, 2]);
  });

  it('filters by state when given', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({
      objective_count: 2,
      objective_1_type: 'control', objective_1_state: 'active', objective_1_team: -1,
      objective_2_type: 'kill', objective_2_state: 'complete', objective_2_team: -1,
    });
    expect(idx.forTeam(1, 'active').map((o) => o.id)).toEqual([1]);
    expect(idx.forTeam(1).map((o) => o.id)).toEqual([1, 2]);   // no state filter -> both
  });
});

describe('markerPosition', () => {
  it('returns raw x/z/r when present', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({ objective_count: 1, objective_1_x: 100, objective_1_z: 200, objective_1_r: 50 });
    expect(idx.markerPosition(idx.get(1))).toEqual({ x: 100, z: 200, r: 50 });
  });

  it('resolves a region hint via a supplied regionIndex.centroid', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({ objective_count: 1, objective_1_region: 'r1' });
    const regionIndex = { centroid: (key) => (key === 'r1' ? { x: 10, z: 20 } : null) };
    expect(idx.markerPosition(idx.get(1), regionIndex)).toEqual({ x: 10, z: 20 });
  });

  it('returns null for a region hint with no regionIndex.centroid available', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({ objective_count: 1, objective_1_region: 'r1' });
    expect(idx.markerPosition(idx.get(1))).toBeNull();
  });

  it('returns null when neither hint is present', () => {
    const idx = createObjectiveIndex();
    idx.applyParams({ objective_count: 1, objective_1_type: 'kill' });
    expect(idx.markerPosition(idx.get(1))).toBeNull();
  });
});
