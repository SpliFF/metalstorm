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
  function mount(store, { api } = {}) {
    const el = document.createElement('div');
    document.body.append(el);
    mentorCard.init({
      mount: el, store, identity: { playerId: 7, teamId: 1 },
      api: api ?? { lobbyBase: '', fetch: vi.fn().mockResolvedValue({ ok: true, status: 200 }) },
    });
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

  it('accepts an AI mentor through the authenticated api port, carrying the bearer', async () => {
    // A stand-in for the real `createWidgetApiPort` (widget-loader.test.ts):
    // it attaches the Authorization header the same way, so this test proves
    // the widget goes through `ctx.api.fetch` for it rather than a raw,
    // cookie-based `fetch` — which is exactly what always 401s against the
    // lobby (journey-lobby-routes fire 2: no cookie auth, bearer only).
    const netFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const api = {
      lobbyBase: 'http://lobby.test',
      fetch: (path, init = {}) => netFetch(`${api.lobbyBase}${path}`, {
        ...init,
        headers: { ...init.headers, Authorization: 'Bearer test-access-token' },
      }),
    };
    const el = mount(fakeStore(), { api });

    await mentorCard._acceptAi();

    expect(netFetch).toHaveBeenCalledWith('http://lobby.test/api/mentor/ai', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        Authorization: 'Bearer test-access-token',
      }),
    }));
    expect(netFetch.mock.calls[0][1]).not.toHaveProperty('credentials');
    expect(el.textContent).not.toContain('401');
    mentorCard.dispose();
  });
});

describe('accepting an AI mentor (E2E2 D19)', () => {
  function mount(store, { api } = {}) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    mentorCard.init({ mount: el, store, identity: { playerId: 7 }, api });
    return el;
  }

  it('renders the AI mentor immediately, rather than going blank', async () => {
    // `mentor_7` stays absent for the whole session — the sim mirrors it at
    // AuthRequest only — so the card has to carry the acknowledgement itself.
    const store = fakeStore();
    const el = mount(store, {
      api: { lobbyBase: '', fetch: () => Promise.resolve({ ok: true, status: 200 }) },
    });
    mentorCard.offerAi = true;
    await mentorCard._acceptAi();

    expect(el.textContent).toContain('Under mentorship: an AI mentor');
    expect(el.textContent).toContain('next mission');
    expect(el.textContent).not.toBe('');
    mentorCard.dispose();
  });

  it('does not claim a mentorship when the route refused', async () => {
    const el = mount(fakeStore(), {
      api: { lobbyBase: '', fetch: () => Promise.resolve({ ok: false, status: 404 }) },
    });
    mentorCard.offerAi = true;
    await mentorCard._acceptAi();

    expect(el.textContent).not.toContain('Under mentorship');
    expect(el.textContent).toContain('not available');
    mentorCard.dispose();
  });

  it('lets the sim override the local acknowledgement once it publishes one', () => {
    const m = mentorCardModel(fakeStore({ game: { mentor_7: 2, callsign_2: 'Vega' } }), 7,
      { acceptedAi: true });
    expect(m.kind).toBe('human');
    expect(m.pendingAi).toBe(false);
  });
});
