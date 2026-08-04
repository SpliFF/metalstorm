// ui/lib/authority-cost.test.js — client cost-mirror tests.
// Run: cd client && npx vitest run --config ../data/games/metalstorm/ui/vitest.config.js --root ../data/games/metalstorm/ui

import { describe, it, expect } from 'vitest';
import { createCostModel, classifyOrder, isFreeCommand } from './authority-cost.js';

const SPEC = {
  version: 1,
  base_k: 1.0,
  order_class: {
    micro: 2.0,
    posture: 0.25,
    build: 3.0,
    directive: 1.0,
  },
};

describe('isFreeCommand', () => {
  it('marks STOP and SELFD free', () => {
    expect(isFreeCommand(0)).toBe(true);
    expect(isFreeCommand(65)).toBe(true);
  });

  it('does not mark MOVE/ATTACK free', () => {
    expect(isFreeCommand(10)).toBe(false);
    expect(isFreeCommand(20)).toBe(false);
  });
});

describe('classifyOrder', () => {
  it('classifies negative cmdIDs as build orders', () => {
    expect(classifyOrder(-1)).toBe('build');
  });

  it('classifies posture/state toggles', () => {
    expect(classifyOrder(45)).toBe('posture');   // FIRE_STATE
    expect(classifyOrder(95)).toBe('posture');   // CLOAK
  });

  it('classifies everything else as micro', () => {
    expect(classifyOrder(10)).toBe('micro');     // MOVE
    expect(classifyOrder(20)).toBe('micro');     // ATTACK
  });
});

describe('createCostModel().predict', () => {
  it('mirrors the Lua formula: ceil(base_k * baseCost * regionMod * classMod * costScale)', () => {
    const model = createCostModel(SPEC);
    // 1.0 * 10 * 0.5 * 2.0 * 1.0 = 10 (exact)
    expect(model.predict({ baseCost: 10, orderClassKey: 'micro', regionMod: 0.5, costScale: 1.0 })).toBe(10);
    // 1.0 * 3 * 1.0 * 0.25 * 1.0 = 0.75 -> ceil 1
    expect(model.predict({ baseCost: 3, orderClassKey: 'posture', regionMod: 1.0, costScale: 1.0 })).toBe(1);
  });

  it('short-circuits to 0 when costScale <= 0 (free-orders test path)', () => {
    const model = createCostModel(SPEC);
    expect(model.predict({ baseCost: 100, orderClassKey: 'micro', regionMod: 2.0, costScale: 0 })).toBe(0);
  });

  it('returns null for an unrecognised order class (fail-safe, never under-predicts)', () => {
    const model = createCostModel(SPEC);
    expect(model.predict({ baseCost: 10, orderClassKey: 'not_a_real_class', regionMod: 1.0, costScale: 1.0 })).toBeNull();
  });

  it('returns null when no spec is loaded (version 0)', () => {
    const model = createCostModel(null);
    expect(model.predict({ baseCost: 10, orderClassKey: 'micro', regionMod: 1.0, costScale: 1.0 })).toBeNull();
  });

  it('defaults costScale to 1.0 when omitted', () => {
    const model = createCostModel(SPEC);
    expect(model.predict({ baseCost: 10, orderClassKey: 'micro', regionMod: 1.0 })).toBe(20);
  });
});

describe('createCostModel().canAfford', () => {
  it('is true when player+team pools cover the cost', () => {
    const model = createCostModel(SPEC);
    expect(model.canAfford(40, 10, 30)).toBe(true);
    expect(model.canAfford(41, 10, 30)).toBe(false);
  });

  it('treats missing pools as 0', () => {
    const model = createCostModel(SPEC);
    expect(model.canAfford(0, undefined, undefined)).toBe(true);
    expect(model.canAfford(1, undefined, undefined)).toBe(false);
  });
});
