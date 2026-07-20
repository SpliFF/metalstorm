// damage-states.test.js — headless coverage for PLAN-metalstorm-squad-
// scale4.md task 3: health-threshold cosmetic damage tiers for multi-piece
// units/buildings, monotonic clamp-down (review §B), independent per-entity
// tracking, and release-on-despawn so a reused entity id starts fresh.

import { describe, it, expect } from 'vitest';
import { createDamageStates, DAMAGE_TIERS } from './damage-states.js';

describe('health-threshold tiers (§4)', () => {
  it('starts intact at full health and escalates as health fraction drops', () => {
    const ds = createDamageStates();
    expect(ds.stateFor(1, 1.0)).toBe('intact');
    expect(ds.stateFor(1, 0.9)).toBe('intact');
    expect(ds.stateFor(1, 0.5)).toBe('scarred');
    expect(ds.stateFor(1, 0.2)).toBe('burning');
    expect(ds.stateFor(1, 0.05)).toBe('crippled');
  });

  it('supports custom thresholds', () => {
    const ds = createDamageStates({ thresholds: { scarred: 0.9, burning: 0.5, crippled: 0.1 } });
    expect(ds.stateFor(1, 0.8)).toBe('scarred'); // below the tighter 0.9 bound
  });
});

describe('monotonic clamp-down (review §B — never un-smoke)', () => {
  it('never reverts to a better tier after a health-snapshot wobble upward', () => {
    const ds = createDamageStates();
    expect(ds.stateFor(1, 0.2)).toBe('burning');
    expect(ds.stateFor(1, 0.9)).toBe('burning'); // wobble back up — clamped
    expect(ds.stateFor(1, 1.0)).toBe('burning'); // even to full health
  });

  it('still advances further if health drops below the currently-held tier', () => {
    const ds = createDamageStates();
    expect(ds.stateFor(1, 0.5)).toBe('scarred');
    expect(ds.stateFor(1, 0.05)).toBe('crippled'); // real further damage still registers
  });
});

describe('per-entity independence + release (§4)', () => {
  it('tracks separate entities independently', () => {
    const ds = createDamageStates();
    expect(ds.stateFor(1, 0.05)).toBe('crippled');
    expect(ds.stateFor(2, 1.0)).toBe('intact'); // unaffected by entity 1's tier
  });

  it('release() clears tracking so a reused id starts fresh', () => {
    const ds = createDamageStates();
    ds.stateFor(1, 0.05); // crippled
    ds.release(1);
    expect(ds.stateFor(1, 1.0)).toBe('intact'); // pool-reused id, not inherited damage
  });
});

describe('DAMAGE_TIERS ordering', () => {
  it('is ordered worst-last, matching the clamp-down max() comparison', () => {
    expect(DAMAGE_TIERS).toEqual(['intact', 'scarred', 'burning', 'crippled']);
  });
});
