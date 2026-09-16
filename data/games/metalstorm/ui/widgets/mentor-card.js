// mentor-card.js — Metalstorm native JS widget.
//
// The mentorship relationship, made visible (PLAN-beta.md "Mentorship"):
// who is watching this player, what they have ordered, and the one toggle that
// lifts the chatter filter. A first-time player whose squads start moving on
// someone else's orders has to be able to see WHO, or the game reads as broken.
//
// Contract with the sim is BY NAME ONLY — game-scope `mentor_<playerId>`
// (a playerNum, -1 for the AI mentor), `callsign_<playerId>`, `rank_<playerId>`,
// and team-scope `assign_<unitID>` / `assign_<unitID>_by`. Every read goes
// through the ui-store helpers so the HUD and the sim can never disagree about
// what a tier is called.
//
// Nothing is rendered while there is no mentorship, with one exception: after
// AI_OFFER_MS without one, the card offers an AI mentor (the fallback in
// PLAN-beta-journey.md §(d)). The offer is a question, never an imposition —
// declining it is a first-class answer and keeps the player independent within
// their rank limits.

/** How long a new player is left to find a human mentor before the AI offers.
 *  Long enough that an offer already in flight can land first. */
export const AI_OFFER_MS = 30_000;

/** The accounts lane's route (PLAN-beta.md §(d)). Relative: resolved against
 *  `ctx.api.lobbyBase` by `ctx.api.fetch`, which also attaches the bearer the
 *  lobby actually checks — the lobby has no cookie auth, so the plain
 *  `fetch(..., {credentials:'include'})` this used to be always 401s
 *  (journey-lobby-routes fire 2). */
const AI_MENTOR_ROUTE = '/api/mentor/ai';

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Everything the card renders, read off the store — pure, so the wording is
 * testable without a DOM or a live stack.
 *
 * `kind` is 'none' | 'ai' | 'human'. `orders` is at most one line per squad a
 * superior has ordered over the player's head; `squads` is how many they are
 * responsible for.
 */
export function mentorCardModel(store, playerId) {
  const mentor = store.mentorOf(playerId);
  const assignments = store.getMyAssignments();
  const orders = [];
  for (const unitId of assignments) {
    const by = store.assignedBy(unitId);
    if (by) orders.push(by.line);
  }
  return {
    kind: mentor === undefined ? 'none' : mentor < 0 ? 'ai' : 'human',
    headline: mentor === undefined
      ? null
      : mentor < 0
        ? 'Under mentorship: an AI mentor'
        : `Under mentorship: ${store.callsignOf(mentor)}`,
    squads: assignments.length,
    // Distinct lines only: one superior re-ordering four squads is one fact,
    // not four, and four identical rows read as a bug.
    orders: [...new Set(orders)],
    showEverything: store.getShowEverything(),
  };
}

export default {
  id: 'mentor-card',

  init(ctx) {
    this.ctx = ctx;
    this.el = document.createElement('div');
    this.el.className = 'ms-mentor-card';
    ctx.mount.appendChild(this.el);

    // Offered once per session. A player who declines is not asked again —
    // being nagged into a mentor is the opposite of the point.
    this.offerAi = false;
    this.declined = false;
    this.timer = setTimeout(() => {
      this.offerAi = true;
      this._render();
    }, AI_OFFER_MS);

    this.onClick = (e) => this._onClick(e);
    this.el.addEventListener('click', this.onClick);
    this.unsub = ctx.store.subscribe(
      ['gameRulesParams', 'teamRulesParams', 'playerRoster'],
      () => this._render(),
    );
    this._render();
  },

  _render() {
    const { store, identity } = this.ctx;
    const model = mentorCardModel(store, identity?.playerId ?? -1);
    const parts = [];

    if (model.headline) {
      parts.push(`<div class="ms-mentor-card__who">${esc(model.headline)}</div>`);
      if (model.squads > 0) {
        parts.push(`<div class="ms-mentor-card__scope">${model.squads} ` +
          `squad${model.squads === 1 ? '' : 's'} under your command</div>`);
      }
      for (const line of model.orders) {
        parts.push(`<div class="ms-mentor-card__order">${esc(line)}</div>`);
      }
      // The filter is ON while a mentorship is active; this is how a player
      // gets the whole battle back without ending the mentorship.
      parts.push('<button type="button" class="nui-btn" data-act="show-everything">' +
        (model.showEverything ? 'Focus on my mentor' : 'Show everything') + '</button>');
    } else if (this.offerAi && !this.declined) {
      parts.push('<div class="ms-mentor-card__who">No mentor yet</div>');
      parts.push('<div class="ms-mentor-card__scope">An AI mentor can assign you tasks ' +
        'and answer for your squads.</div>');
      parts.push('<button type="button" class="nui-btn" data-act="accept-ai">Accept an AI mentor</button>' +
        '<button type="button" class="nui-btn" data-act="decline-ai">No thanks</button>');
    }
    if (this.error) parts.push(`<div class="ms-mentor-card__note">${esc(this.error)}</div>`);

    this.el.innerHTML = parts.join('');
    // An empty card is no card: the loader's panel frame stays, but a titled
    // panel with nothing in it reads as a HUD that failed to load.
    const frame = this.el.closest('.nui-panel');
    if (frame) frame.hidden = parts.length === 0;
  },

  _onClick(e) {
    const act = e.target?.dataset?.act;
    if (!act) return;
    if (act === 'show-everything') {
      this.ctx.store.setShowEverything(!this.ctx.store.getShowEverything());
      this._render();
    } else if (act === 'decline-ai') {
      this.declined = true;
      this._render();
    } else if (act === 'accept-ai') {
      this._acceptAi();
    }
  },

  /** Opt into the AI mentor. The route is the accounts lane's (A2); until it
   *  lands every build answers 404, which must read as "not available yet" and
   *  not as a silent no-op the player can click forever. */
  async _acceptAi() {
    this.error = 'Asking for an AI mentor…';
    this._render();
    try {
      const res = await this.ctx.api.fetch(AI_MENTOR_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.status === 404) {
        this.error = 'AI mentors are not available on this server yet.';
      } else if (!res.ok) {
        this.error = `Could not get an AI mentor (${res.status}).`;
      } else {
        // The sim publishes `mentor_<me>` when the mentorship takes effect;
        // the subscription above is what actually swaps the card over.
        this.error = null;
        this.declined = true;
      }
    } catch {
      this.error = 'Could not reach the server.';
    }
    this._render();
  },

  dispose() {
    clearTimeout(this.timer);
    this.el?.removeEventListener('click', this.onClick);
    this.unsub?.();
    this.el?.remove();
    this.el = null;
  },
};
