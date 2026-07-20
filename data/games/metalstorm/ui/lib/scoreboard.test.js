// ui/lib/scoreboard.test.js
// Run: cd client && npx vitest run --config ../data/games/metalstorm/ui/vitest.config.js --root ../data/games/metalstorm/ui

import { describe, it, expect } from 'vitest';
import { readScoreboardRow, readScoreboard } from './scoreboard.js';

describe('readScoreboardRow', () => {
  it('reads earned/spent/objectives for a playerId', () => {
    const store = { score_7_earned: 125, score_7_spent: 40, score_7_objectives: 3 };
    const row = readScoreboardRow((k) => store[k], 7);
    expect(row).toEqual({ playerId: 7, earned: 125, spent: 40, objectives: 3 });
  });

  it('coerces string values off the wire', () => {
    const store = { score_7_earned: '125', score_7_spent: '40', score_7_objectives: '3' };
    const row = readScoreboardRow((k) => store[k], 7);
    expect(row).toEqual({ playerId: 7, earned: 125, spent: 40, objectives: 3 });
  });

  it('defaults missing fields to 0 rather than NaN/undefined', () => {
    const row = readScoreboardRow(() => undefined, 7);
    expect(row).toEqual({ playerId: 7, earned: 0, spent: 0, objectives: 0 });
  });
});

describe('readScoreboard', () => {
  it('returns one row per requested playerId, in order', () => {
    const store = { score_1_earned: 10, score_2_earned: 20 };
    const rows = readScoreboard((k) => store[k], [2, 1]);
    expect(rows.map((r) => r.playerId)).toEqual([2, 1]);
    expect(rows[0].earned).toBe(20);
    expect(rows[1].earned).toBe(10);
  });
});
