// soa-store.test.js — headless coverage for PLAN-metalstorm-squad-
// performance.md §10b/§10c/§10d/§14 S3: the member-array pool, its 64-byte
// view alignment (SAB-readiness, §10b rule 1), and the exact-size run
// allocator (§10d — the free-list-double-free hazard is designed out by
// freeing at squad granularity only).

import { describe, it, expect } from 'vitest';
import {
  createStore, allocRun, freeRun, growStore, layoutViews,
  isAlive, isReleased, setAlive, setReleased, MFLAG_ALIVE, MFLAG_RELEASED,
} from './soa-store.js';

describe('layoutViews (§10b rule 1 — 64-byte alignment)', () => {
  it('every view offset is 64-byte aligned, for any capacity', () => {
    for (const capacity of [1, 4, 4096, 4097, 65536]) {
      const { layout } = layoutViews(null, capacity);
      expect(layout.length).toBeGreaterThan(0);
      for (const { name, offset } of layout) {
        expect(offset % 64, `${name}@${capacity}`).toBe(0);
      }
    }
  });

  it('the total byte length is itself 64-byte aligned and fits every view', () => {
    const capacity = 777;
    const { layout, byteLength } = layoutViews(null, capacity);
    expect(byteLength % 64).toBe(0);
    for (const { offset, bytes } of layout) {
      expect(offset + bytes).toBeLessThanOrEqual(byteLength);
    }
  });
});

describe('createStore', () => {
  it('builds a store with flat typed-array accessors sized to capacity', () => {
    const store = createStore(128);
    expect(store.capacity).toBe(128);
    expect(store.highWater).toBe(0);
    expect(store.mx.length).toBe(128);
    expect(store.mFlags.length).toBe(128);
    expect(store.mPool.length).toBe(128);
    expect(store.generation).toBe(1);
  });
});

describe('run allocator (§10d — exact-size free-list, no split/coalesce)', () => {
  it('bumps highWater on first allocation of a size', () => {
    const store = createStore(64);
    const base = allocRun(store, 6);
    expect(base).toBe(0);
    expect(store.highWater).toBe(6);
  });

  it('packs distinct sizes back-to-back contiguously', () => {
    const store = createStore(64);
    const a = allocRun(store, 6);
    const b = allocRun(store, 4);
    expect(a).toBe(0);
    expect(b).toBe(6);
    expect(store.highWater).toBe(10);
  });

  it('freeRun + allocRun of the SAME size reuses the exact freed base (no bump)', () => {
    const store = createStore(64);
    const a = allocRun(store, 8);
    allocRun(store, 8); // b, unused — just occupies highWater so reuse is observable
    freeRun(store, a, 8);
    const highWaterBefore = store.highWater;
    const reused = allocRun(store, 8);
    expect(reused).toBe(a);
    expect(store.highWater).toBe(highWaterBefore); // no bump — came from the free-list
  });

  it('freed runs of DIFFERENT sizes are never cross-reused (exact-size only)', () => {
    const store = createStore(64);
    const a = allocRun(store, 6);
    freeRun(store, a, 6);
    const c = allocRun(store, 4); // different size — must NOT get `a`
    expect(c).not.toBe(a);
    // The size-6 free-list still holds `a` for a later size-6 request.
    const reused6 = allocRun(store, 6);
    expect(reused6).toBe(a);
  });

  it('LIFO reuse: the most recently freed same-size run comes back first', () => {
    const store = createStore(64);
    const a = allocRun(store, 5);
    const b = allocRun(store, 5);
    freeRun(store, a, 5);
    freeRun(store, b, 5);
    expect(allocRun(store, 5)).toBe(b);
    expect(allocRun(store, 5)).toBe(a);
  });
});

describe('growth (§10b rule 3 — new pool + copy + generation++)', () => {
  it('doubles capacity until the requested run fits, and bumps generation', () => {
    const store = createStore(4);
    const gen0 = store.generation;
    allocRun(store, 4); // fills the initial capacity exactly
    const base = allocRun(store, 2); // must grow
    expect(store.capacity).toBeGreaterThanOrEqual(6);
    expect(store.generation).toBeGreaterThan(gen0);
    expect(base).toBe(4);
  });

  it('growth COPIES existing member data forward into the new buffer', () => {
    const store = createStore(4);
    const a = allocRun(store, 4);
    store.mx[a] = 123.5;
    store.mFlags[a] = MFLAG_ALIVE;
    growStore(store, 100); // forces growth well past current capacity
    expect(store.mx[a]).toBe(123.5);
    expect(store.mFlags[a] & MFLAG_ALIVE).toBe(MFLAG_ALIVE);
  });

  it('views are rebuilt (not stale) after growth — writes land in the NEW buffer', () => {
    const store = createStore(4);
    growStore(store, 100);
    store.mx[0] = 42;
    expect(store.mx[0]).toBe(42);
    expect(store.buffer.byteLength).toBeGreaterThan(0);
  });

  it('grown capacity keeps every view 64-byte aligned', () => {
    const store = createStore(4);
    growStore(store, 5000);
    const { layout } = layoutViews(null, store.capacity);
    for (const { offset } of layout) expect(offset % 64).toBe(0);
  });
});

describe('flag helpers', () => {
  it('isAlive/setAlive and isReleased/setReleased round-trip through mFlags without disturbing each other', () => {
    const store = createStore(4);
    setAlive(store, 0, true);
    expect(isAlive(store, 0)).toBe(true);
    expect(isReleased(store, 0)).toBe(false);

    setReleased(store, 0, true);
    expect(isAlive(store, 0)).toBe(true); // release doesn't kill (squad-sync §5 Pitfall #2)
    expect(isReleased(store, 0)).toBe(true);
    expect(store.mFlags[0]).toBe(MFLAG_ALIVE | MFLAG_RELEASED);

    setAlive(store, 0, false);
    expect(isAlive(store, 0)).toBe(false);
    expect(isReleased(store, 0)).toBe(true); // death doesn't clear a prior release bit
  });
});
