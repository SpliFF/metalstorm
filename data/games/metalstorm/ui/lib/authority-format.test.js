// ui/lib/authority-format.test.js
// Run: cd client && npx vitest run --config ../data/games/metalstorm/ui/vitest.config.js --root ../data/games/metalstorm/ui
//
// PLAN-endtoend.md D49. The values below are the ones measured live on the
// player path, not invented: `YOU 202.5500030517578`, `TEAM 614.5499877929688`
// and a reward of `114.55000305175781` all came off the wire as float32 and
// went to the DOM verbatim.

import { describe, it, expect } from 'vitest';
import { formatAuthority } from './authority-format.js';

describe('formatAuthority', () => {
  it('strips float32 debris off the amounts measured live (D49)', () => {
    expect(formatAuthority(202.5500030517578)).toBe('202.6');
    expect(formatAuthority(614.5499877929688)).toBe('614.5');
    expect(formatAuthority(114.55000305175781)).toBe('114.6');
  });

  it('leaves a whole amount whole — no gratuitous .0', () => {
    expect(formatAuthority(620)).toBe('620');
    expect(formatAuthority(100)).toBe('100');
    expect(formatAuthority(0)).toBe('0');
  });

  it('keeps a genuinely fractional amount visible instead of rounding it away', () => {
    // The reason this is not Math.round(): a paid award must never read as
    // nothing. Reward normalisation scales by 1/velocity, so sub-1 amounts are
    // reachable.
    expect(formatAuthority(0.5)).toBe('0.5');
    expect(formatAuthority(0.4499999)).toBe('0.4');
  });

  it('coerces the string form the rulesParam mirror can hand back', () => {
    expect(formatAuthority('114.55000305175781')).toBe('114.6');
    expect(formatAuthority('620')).toBe('620');
  });

  it('formats a missing / unparseable amount as 0, never NaN or undefined', () => {
    // Every caller is reading an optional mirror where "not published yet" and
    // "zero" are the same thing to a player.
    expect(formatAuthority(undefined)).toBe('0');
    expect(formatAuthority(null)).toBe('0');
    expect(formatAuthority('')).toBe('0');
    expect(formatAuthority('n/a')).toBe('0');
    expect(formatAuthority(NaN)).toBe('0');
    expect(formatAuthority(Infinity)).toBe('0');
  });

  it('never prints a signed zero', () => {
    expect(formatAuthority(-0)).toBe('0');
    expect(formatAuthority(-0.0001)).toBe('0');
  });

  it('keeps a real debt signed', () => {
    // An overdrawn pool is not a display bug — the sign is the information.
    expect(formatAuthority(-12.449996948242188)).toBe('-12.4');
  });
});
