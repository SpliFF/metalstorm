// ui/lib/scoreboard.test.js
// Run: cd client && npx vitest run --config ../data/games/metalstorm/ui/vitest.config.js --root ../data/games/metalstorm/ui

import { describe, it, expect } from 'vitest';
import { readScoreboardRow, readScoreboard, scoreboardRoster } from './scoreboard.js';

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

describe('scoreboardRoster', () => {
  // The roster as ui-store holds it: `playerId` is Spring's SIM playerNum.
  // The AI is playerNum 0 because AI virtual players are registered before any
  // client connects (PLAN-metalstorm-ai.md §1) — so a human's playerNum never
  // matches their DB account id, which is the whole of PLAN-endtoend.md D3.
  const ROSTER = [
    { playerId: 0, name: 'AI:strategos@t1', teamId: 1, isAI: true, isSpectator: false },
    { playerId: 1, name: 'e2e_north', teamId: 0, isAI: false, isSpectator: false },
    { playerId: 2, name: 'watcher', teamId: -1, isAI: false, isSpectator: true },
    { playerId: 3, name: 'ally', teamId: 0, isAI: false, isSpectator: false },
  ];
  const ME = { playerId: 1, teamId: 0 };

  it('names every player, including the AI opponent on the other team', () => {
    const rows = scoreboardRoster(ROSTER, ME);
    expect(rows.map((r) => r.name)).toEqual(['e2e_north', 'ally', 'AI:strategos@t1']);
  });

  it('orders by team then playerNum so allies read as a block', () => {
    const rows = scoreboardRoster(ROSTER, ME);
    expect(rows.map((r) => [r.teamId, r.playerId])).toEqual([[0, 1], [0, 3], [1, 0]]);
  });

  it('marks the local player and their team', () => {
    const rows = scoreboardRoster(ROSTER, ME);
    expect(rows.find((r) => r.playerId === 1)).toMatchObject({ isSelf: true, isOwnTeam: true });
    expect(rows.find((r) => r.playerId === 3)).toMatchObject({ isSelf: false, isOwnTeam: true });
    expect(rows.find((r) => r.playerId === 0)).toMatchObject({ isSelf: false, isOwnTeam: false, isAI: true });
  });

  it('drops spectators — they never earn or spend', () => {
    expect(scoreboardRoster(ROSTER, ME).some((r) => r.playerId === 2)).toBe(false);
  });

  it('falls back to P<playerNum> for a nameless entry rather than a blank cell', () => {
    const [row] = scoreboardRoster([{ playerId: 4, name: '', teamId: 0 }], ME);
    expect(row.name).toBe('P4');
  });

  it('is empty, not throwing, for a missing roster', () => {
    expect(scoreboardRoster(undefined, ME)).toEqual([]);
    expect(scoreboardRoster([], {})).toEqual([]);
  });

  it('keys rows by sim playerNum so score_<playerNum>_* reads line up', () => {
    // The regression: reading the DB account id here produced score_59_* for a
    // player the server publishes as score_1_*, so every row read 0.
    const params = { score_1_earned: 100, score_1_spent: 2, score_1_objectives: 1 };
    const rows = readScoreboard(
      (k) => params[k],
      scoreboardRoster(ROSTER, ME).map((r) => r.playerId),
    );
    expect(rows[0]).toEqual({ playerId: 1, earned: 100, spent: 2, objectives: 1 });
  });
});
