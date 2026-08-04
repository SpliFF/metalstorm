// ui/lib/parley.test.js — client parley-index + trust-key tests.
// Run: cd client && npx vitest run --config ../data/games/metalstorm/ui/vitest.config.js --root ../data/games/metalstorm/ui

import { describe, it, expect } from 'vitest';
import { createParleyIndex, trustKey, trustBetween } from './parley.js';

function storeFrom(map) {
  return (key) => map[key];
}

describe('trustKey / trustBetween — canonical (lo, hi) ordering', () => {
  it('produces the same key regardless of argument order', () => {
    expect(trustKey(1, 2)).toBe('trust_1_2');
    expect(trustKey(2, 1)).toBe('trust_1_2');
  });

  it('reads the same trust value from either argument order', () => {
    const store = { trust_1_2: -3 };
    expect(trustBetween(storeFrom(store), 1, 2)).toBe(-3);
    expect(trustBetween(storeFrom(store), 2, 1)).toBe(-3);
  });

  it('defaults to neutral (0) when unset', () => {
    expect(trustBetween(storeFrom({}), 1, 2)).toBe(0);
  });
});

describe('pull() — poll-style ingestion', () => {
  it('reads parley_count then every published field per id', () => {
    const idx = createParleyIndex();
    const changed = idx.pull(storeFrom({
      parley_count: 1,
      parley_1_kind: 'ceasefire',
      parley_1_from: 10,
      parley_1_to: 20,
      parley_1_state: 'offered',
    }));
    expect(changed).toBe(true);
    expect(idx.get(1)).toMatchObject({ kind: 'ceasefire', from: 10, to: 20, state: 'offered' });
  });

  it('coerces numeric fields even when carried as strings', () => {
    const idx = createParleyIndex();
    idx.pull(storeFrom({ parley_count: 1, parley_1_from: '10', parley_1_amount: '500' }));
    expect(idx.get(1).from).toBe(10);
    expect(idx.get(1).amount).toBe(500);
  });

  it('treats a missing field as cleared (resolve-retention expiry)', () => {
    const idx = createParleyIndex();
    const store = { parley_count: 1, parley_1_kind: 'tribute', parley_1_state: 'fulfilled' };
    idx.pull(storeFrom(store));
    expect(idx.get(1).state).toBe('fulfilled');

    delete store.parley_1_state;
    delete store.parley_1_kind;
    const changed = idx.pull(storeFrom(store));
    expect(changed).toBe(true);
    expect(idx.get(1).kind).toBeUndefined();
    expect(idx.list()).toEqual([]);
  });

  it('returns false on a stable repeat poll', () => {
    const idx = createParleyIndex();
    const store = { parley_count: 1, parley_1_kind: 'ceasefire', parley_1_state: 'offered' };
    idx.pull(storeFrom(store));
    expect(idx.pull(storeFrom(store))).toBe(false);
  });

  it('skips gaps (a rejected propose burned the id, or retention expired)', () => {
    const idx = createParleyIndex();
    idx.pull(storeFrom({ parley_count: 3, parley_1_kind: 'ceasefire', parley_3_kind: 'tribute' }));
    expect(idx.list().map((p) => p.id)).toEqual([1, 3]);
  });
});

describe('incoming / outgoing / active filtering', () => {
  function baseIndex() {
    const idx = createParleyIndex();
    idx.pull(storeFrom({
      parley_count: 3,
      parley_1_kind: 'ceasefire', parley_1_from: 10, parley_1_to: 20, parley_1_state: 'offered',
      parley_2_kind: 'tribute', parley_2_from: 20, parley_2_to: 10, parley_2_state: 'countered',
      parley_3_kind: 'ceasefire', parley_3_from: 10, parley_3_to: 20, parley_3_state: 'active',
    }));
    return idx;
  }

  it('incoming(teamId) returns pending proposals addressed to us', () => {
    const idx = baseIndex();
    expect(idx.incoming(20).map((p) => p.id)).toEqual([1]);
    expect(idx.incoming(10).map((p) => p.id)).toEqual([2]);
  });

  it('outgoing(teamId) returns pending proposals we originated', () => {
    const idx = baseIndex();
    expect(idx.outgoing(10).map((p) => p.id)).toEqual([1]);
    expect(idx.outgoing(20).map((p) => p.id)).toEqual([2]);
  });

  it('active(teamId) returns live pacts involving us, either direction', () => {
    const idx = baseIndex();
    expect(idx.active(10).map((p) => p.id)).toEqual([3]);
    expect(idx.active(20).map((p) => p.id)).toEqual([3]);
    expect(idx.active(99)).toEqual([]);
  });
});
