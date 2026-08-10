// authority-bar.js — Metalstorm native JS widget.
//
// Shows the player's authority pool + the team pool (PLAN-metalstorm.md §4),
// and renders the award/charge event ring (task 4) + refusal toasts
// (task 6 "veto toast") as a small stacked toast queue.
//
// Contract (PLAN-native-ui.md §3):
//   init(ctx)  — ctx.store    read API over the streamed state mirrors
//                ctx.mount    DOM element inside #ui-root (pointer-events:auto)
//                ctx.identity { playerId, teamId, accountId }
//   dispose()  — remove subscriptions/DOM.
//
// `ctx.identity.playerId` is Spring's SIM playerNum, which is what the
// `authority_player_<playerID>` rulesParam key below is scoped by — NOT the DB
// account id (`ctx.identity.accountId`). Reading the account id here is what
// made this pill display `YOU 0` against a server pool of 100 for every real
// account (PLAN-endtoend.md D3); see PLAN-native-ui.md §3.3.
// Updates are EVENT-DRIVEN (store subscriptions), never per-frame
// (PLAN-native-ui.md "no per-frame DOM mutation").
//
// NOT wired here (blocked on infrastructure this widget doesn't own):
//   - hover cost / red-cursor refusal prediction (task 6): the pure
//     formula/canAfford math lives in ui/lib/authority-cost.js, ready to
//     call, but there is no order-cursor integration point yet — the
//     engine-level cursor system (client/src/core/worker-command-modes.ts)
//     is shared across all games (ZK/BAR/Metalstorm) and has no
//     game-specific cost-override hook; wiring it in is its own task once
//     that hook (or the native-ui loader) exists.
// (The old note here said live rulesParams had no producer anywhere and this
// widget was unverifiable end-to-end. That is obsolete: the wire landed, and
// the bar has been read against `Spring.GetTeamRulesParam` server truth on the
// player path in several PLAN-endtoend fires.)

import { formatAuthority } from '../lib/authority-format.js';

const EVENT_RING_SIZE = 8;
const TOAST_TTL_MS = 4000;

// Every amount here is a float32 rulesParam read, so it goes through
// formatAuthority — see ui/lib/authority-format.js (PLAN-endtoend.md D49).
const EVENT_LABEL = {
  award: (amount, reason) => `+${formatAuthority(amount)} authority (${reason || 'award'})`,
  refund: (amount, reason) => `+${formatAuthority(amount)} authority returned (${reason || 'refund'})`,
  refusal: (amount) => `Insufficient authority (needed ${formatAuthority(amount)})`,
};

export default {
  id: 'authority-bar',

  init(ctx) {
    // Mounted bare (no loader panel chrome — see metalstorm.ui.json): a
    // two-number readout doesn't earn a title bar, so it wears the panel
    // frame directly and stays one row tall.
    this.el = document.createElement('div');
    this.el.className = 'nui-panel ms-authority-bar';
    this.el.innerHTML =
      '<span class="nui-stat" title="Your authority">' +
      '<span class="nui-stat__label">⬡ YOU</span>' +
      '<span class="nui-stat__value ms-auth-player">—</span></span>' +
      '<span class="ms-auth-sep"></span>' +
      '<span class="nui-stat" title="Team authority pool">' +
      '<span class="nui-stat__label">⬡⬡ TEAM</span>' +
      '<span class="nui-stat__value ms-auth-team">—</span></span>' +
      '<div class="nui-toasts ms-auth-toasts"></div>';
    ctx.mount.appendChild(this.el);

    this.lastSeenEventSeq = null;

    // Authority pools are published as rulesParams by game_authority.lua,
    // BOTH team-scoped (allied-visibility, §1 — never gameRulesParam, which
    // would leak to enemy clients):
    //   team:   teamRulesParams[teamId].authority_pool
    //   player: teamRulesParams[teamId]['authority_player_<playerId>']
    // The award/charge event ring (task 4) is gameRulesParams
    // (authority_event counter + authority_event_<slot>_* — §2).
    this.unsub = ctx.store.subscribe(['teamRulesParams', 'gameRulesParams'], () => {
      this._paint(ctx);
    });

    // Paint once from whatever the store already holds. A subscription only
    // fires on the NEXT update, so a widget that mounts into an already-
    // populated store would otherwise sit on its '—' placeholder until the
    // server happened to publish again. That is not hypothetical: re-entering
    // a finished war mounts the bar after the broadcast pipeline has stopped
    // (game over freezes it), so the bar read '—/—' forever against a store
    // holding 92/620 (PLAN-endtoend D44).
    this._paint(ctx);
  },

  /** Render the two pools from the store, then drain the event ring. */
  _paint(ctx) {
    const team = ctx.store.teamRulesParam(ctx.identity.teamId, 'authority_pool');
    const mine = ctx.store.teamRulesParam(ctx.identity.teamId, 'authority_player_' + ctx.identity.playerId);
    this.el.querySelector('.ms-auth-player').textContent = formatAuthority(mine);
    this.el.querySelector('.ms-auth-team').textContent = formatAuthority(team);

    this._consumeEventRing(ctx);
  },

  /** Read new slots off the authority_event ring since last seen, toast each. */
  _consumeEventRing(ctx) {
    const seq = ctx.store.gameRulesParam('authority_event');
    if (seq === undefined || seq === null) return;
    if (this.lastSeenEventSeq === null) {
      // First read: don't replay pre-existing history as toasts, just sync up.
      this.lastSeenEventSeq = seq;
      return;
    }
    if (seq <= this.lastSeenEventSeq) return;

    // A ring holds only the last EVENT_RING_SIZE events — if more than that
    // fired since our last read, the earliest ones are already overwritten;
    // only walk back as far as the ring actually holds.
    const missed = Math.min(seq - this.lastSeenEventSeq, EVENT_RING_SIZE);
    for (let s = seq - missed + 1; s <= seq; s++) {
      const slot = ((s % EVENT_RING_SIZE) + EVENT_RING_SIZE) % EVENT_RING_SIZE;
      const p = (k) => ctx.store.gameRulesParam(`authority_event_${slot}_${k}`);
      if (p('seq') !== s) continue;   // slot since overwritten by a newer event
      const kind = p('kind');
      const amount = p('amount');
      const reason = p('reason');
      const player = p('player');
      const team = p('team');
      // Only toast events relevant to this player/team (their own award, or
      // a refusal that names them) — a global event stream shouldn't spam
      // toasts for every other team's income.
      const mine = player === ctx.identity.playerId || team === ctx.identity.teamId;
      if (!mine) continue;
      this._pushToast(kind, amount, reason);
    }
    this.lastSeenEventSeq = seq;
  },

  _pushToast(kind, amount, reason) {
    const label = EVENT_LABEL[kind];
    if (!label) return;
    this._renderToast(label(amount, reason), kind);
  },

  /**
   * Render a refusal ("veto") toast directly — the entry point for the
   * order-cursor integration once it exists (task 6): a caller that
   * predicted+sent a command anyway and saw the server bounce it (§4 "the
   * client shows an 'insufficient authority' toast") calls this instead of
   * waiting on the event ring.
   */
  showRefusalToast(cost) {
    this._renderToast(EVENT_LABEL.refusal(cost), 'refusal');
  },

  _renderToast(text, kind) {
    const list = this.el?.querySelector('.ms-auth-toasts');
    if (!list) return;
    const toast = document.createElement('div');
    toast.className = 'nui-toast nui-toast--' + kind;
    toast.textContent = text;
    list.appendChild(toast);
    setTimeout(() => toast.remove(), TOAST_TTL_MS);
  },

  dispose() {
    this.unsub?.();
    this.el?.remove();
  },
};
