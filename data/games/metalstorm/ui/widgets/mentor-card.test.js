// @vitest-environment happy-dom
// mentor-card.test.js — the mentorship card renders from fixture rulesParams
// (PLAN-beta.md "Mentorship"). Fake store, no live stack.

import { describe, it, expect, vi } from 'vitest';
import mentorCard, { mentorCardModel } from './mentor-card.js';

/** The ui-store surface the card reads, fed from a flat fixture of params. */
function fakeStore({ game = {}, team = {}, me = 7, showEverything = false } = {}) {
  const tierName = (t) => ['Recruit', 'Regular', 'Veteran', 'Officer', 'Commander'][t] ?? 'Recruit';
  return {
    mentorOf: (pid) => (game[`mentor_${pid}`] === undefined ? undefined : Number(game[`mentor_${pid}`])),
    callsignOf: (pid) => String(game[`callsign_${pid}`] ?? `player ${pid}`),
    rankOf: (pid) => Number(game[`rank_${pid}`] ?? 0),
    getMyAssignments: () => Object.entries(team)
      .filter(([k, v]) => /^assign_\d+$/.test(k) && Number(v) === me)
      .map(([k]) => Number(k.slice('assign_'.length))).sort((a, b) => a - b),
    assignedBy(unitId) {
      const raw = team[`assign_${unitId}_by`];
      if (raw === undefined) return null;
      const pid = Number(raw);
      return { playerId: pid, callsign: this.callsignOf(pid), tier: this.rankOf(pid),
        line: `order from ${this.callsignOf(pid)} (${tierName(this.rankOf(pid))})` };
    },
    getShowEverything: () => showEverything,
    setShowEverything: vi.fn(),
    subscribe: () => () => {},
  };
}

const MENTORED = {
  game: { mentor_7: 2, callsign_2: 'Vega', rank_2: 3 },
  team: { assign_11: 7, assign_12: 7, assign_13: 4, assign_11_by: 2 },
};

describe('mentorCardModel', () => {
  it('names the human mentor and the order they issued', () => {
    const m = mentorCardModel(fakeStore(MENTORED), 7);
    expect(m.kind).toBe('human');
    expect(m.headline).toBe('Under mentorship: Vega');
    expect(m.squads).toBe(2);                       // 13 belongs to someone else
    expect(m.orders).toEqual(['order from Vega (Officer)']);
  });

  it('reads -1 as the AI mentor', () => {
    const m = mentorCardModel(fakeStore({ game: { mentor_7: -1 } }), 7);
    expect(m.kind).toBe('ai');
    expect(m.headline).toBe('Under mentorship: an AI mentor');
  });

  it('is empty with no mentorship', () => {
    const m = mentorCardModel(fakeStore(), 7);
    expect(m.kind).toBe('none');
    expect(m.headline).toBeNull();
  });
});

describe('mentor-card widget', () => {
  function mount(store) {
    const el = document.createElement('div');
    document.body.append(el);
    mentorCard.init({ mount: el, store, identity: { playerId: 7, teamId: 1 } });
    return el;
  }

  it('renders the relationship, the scope and the toggle', () => {
    const store = fakeStore(MENTORED);
    const el = mount(store);
    expect(el.textContent).toContain('Under mentorship: Vega');
    expect(el.textContent).toContain('2 squads under your command');
    expect(el.textContent).toContain('order from Vega (Officer)');

    el.querySelector('[data-act="show-everything"]').click();
    expect(store.setShowEverything).toHaveBeenCalledWith(true);
    mentorCard.dispose();
  });

  it('offers an AI mentor once nobody has taken the player on', () => {
    vi.useFakeTimers();
    const el = mount(fakeStore());
    expect(el.textContent).toBe('');
    vi.advanceTimersByTime(30_000);
    expect(el.textContent).toContain('No mentor yet');

    el.querySelector('[data-act="decline-ai"]').click();
    expect(el.textContent).toBe('');               // declining is a real answer
    mentorCard.dispose();
    vi.useRealTimers();
  });
});
