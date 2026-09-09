// authority-bar.js — Metalstorm native JS widget.
//
// Shows the player's authority pool + the team pool (PLAN-metalstorm.md §4)
// as a rung-0 PILL, and — since 2026-09-10 — drills one click down into the
// LEDGER: where charges draw from, the cost scale in force, and the last few
// awards/refunds/refusals that reached this player. The award/charge event
// ring (task 4) still toasts (task 6 "veto toast") as a small stacked queue
// hanging under the pill.
//
// Contract (PLAN-native-ui.md §3):
//   init(ctx)  — ctx.store    read API over the streamed state mirrors
//                ctx.mount    DOM element inside #ui-root (pointer-events:auto)
//                ctx.identity { playerId, teamId, accountId }
//                ctx.focus    read-only focus port (ui/lib/focus.js) — the
//                             ledger records itself as an open surface so
//                             "close that" has something to bind to
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
// ── The drill (DESIGN-DRILLDOWN.md §2, rung 0 → rung 2) ──
//
// The pill is a <button aria-expanded>. Clicking it opens a context panel
// built from the design system's `.nui-dd__panel` / `.nui-dd__fact` classes
// — the same rung-2 look every drilldown has — rather than through
// `createDrilldown`, which this widget cannot import (it is fetched from the
// game dir as a standalone ES module; the bundled framework is not reachable
// from here). Esc closes it and returns focus to the pill; it is never open by
// default; nothing of the panel is in the DOM while it is closed.
//
// The ledger is the event ring's RECENT HISTORY, kept here because the ring
// only holds eight slots server-side and a toast lasts four seconds — the
// question "what did I just get paid for?" has otherwise no answer once the
// toast is gone.
//
// NOT wired here (blocked on infrastructure this widget doesn't own):
//   - hover cost / red-cursor refusal prediction (task 6): the pure
//     formula/canAfford math lives in ui/lib/authority-cost.js, ready to
//     call, but there is no order-cursor integration point yet — the
//     engine-level cursor system (client/src/core/worker-command-modes.ts)
//     is shared across all games (ZK/BAR/Metalstorm) and has no
//     game-specific cost-override hook; wiring it in is its own task once
//     that hook (or the native-ui loader) exists.
//   - predicted per-class costs in the ledger: authority_cost.json is not
//     reachable from a widget (no game-data URL in ctx), so the ledger shows
//     the SCALE the sim applies, not a price list.

import { formatAuthority } from '../lib/authority-format.js';
import { focusPortOf } from '../lib/focus.js';

const EVENT_RING_SIZE = 8;
const TOAST_TTL_MS = 4000;
/** How many ledger lines the drill keeps. The server ring holds 8; keeping
 *  more here would be inventing history the sim never sent. */
export const LEDGER_SIZE = 8;
/** The surface id the ledger records in the focus model while open. */
export const LEDGER_SURFACE_ID = 'authority-ledger';

// Every amount here is a float32 rulesParam read, so it goes through
// formatAuthority — see ui/lib/authority-format.js (PLAN-endtoend.md D49).
const EVENT_LABEL = {
  award: (amount, reason) => `+${formatAuthority(amount)} authority (${reason || 'award'})`,
  refund: (amount, reason) => `+${formatAuthority(amount)} authority returned (${reason || 'refund'})`,
  refusal: (amount) => `Insufficient authority (needed ${formatAuthority(amount)})`,
};

/** One ledger row's two cells: what happened, and the amount with its sign. */
export function ledgerRow(entry) {
  const amount = formatAuthority(entry.amount);
  switch (entry.kind) {
    case 'award': return { label: entry.reason || 'award', value: `+${amount}` };
    case 'refund': return { label: `${entry.reason || 'refund'} (returned)`, value: `+${amount}` };
    case 'refusal': return { label: 'refused — short by', value: `${amount}` };
    default: return { label: entry.reason || entry.kind || 'event', value: amount };
  }
}

export default {
  id: 'authority-bar',

  init(ctx) {
    this.ctx = ctx;
    this.focus = focusPortOf(ctx);
    this.ledger = [];
    this.open = false;

    // Mounted bare (no loader panel chrome — see metalstorm.ui.json): a
    // two-number readout doesn't earn a title bar. The wrapper is a column:
    // the pill, then (only while drilled) the ledger panel. Toasts hang off
    // the wrapper so they keep falling under the pill whether or not the
    // ledger is open.
    this.el = document.createElement('div');
    this.el.className = 'ms-authority';
    this.el.innerHTML =
      '<button type="button" class="nui-panel ms-authority-bar" aria-expanded="false" ' +
      'aria-controls="ms-auth-ledger" title="Your authority · click for the ledger">' +
      '<span class="nui-stat" title="Your authority">' +
      '<span class="nui-stat__label">⬡ YOU</span>' +
      '<span class="nui-stat__value ms-auth-player">—</span></span>' +
      '<span class="ms-auth-sep"></span>' +
      '<span class="nui-stat" title="Team authority pool">' +
      '<span class="nui-stat__label">⬡⬡ TEAM</span>' +
      '<span class="nui-stat__value ms-auth-team">—</span></span>' +
      '<span class="nui-dd__caret" aria-hidden="true">▸</span>' +
      '</button>' +
      '<div id="ms-auth-ledger" class="nui-dd__panel ms-auth-ledger" hidden></div>' +
      '<div class="nui-toasts ms-auth-toasts"></div>';
    ctx.mount.appendChild(this.el);

    this.pill = this.el.querySelector('.ms-authority-bar');
    this.panel = this.el.querySelector('.ms-auth-ledger');
    this.pill.addEventListener('click', () => this._toggle());

    // Esc closes the ledger and ONLY the ledger, consumed in the capture phase
    // so it never also reaches main.ts's quit dialog — the same rule every
    // drilldown follows (client/src/ui/native-ui/drilldown.ts rule 3). While
    // closed this listener touches nothing, so Esc still quits.
    this._onKeyDown = (ev) => {
      if (ev.key !== 'Escape' || !this.open) return;
      ev.preventDefault();
      ev.stopPropagation();
      const focusWasInside = this.el.contains(document.activeElement);
      this._setOpen(false);
      if (focusWasInside) this.pill.focus();
    };
    document.addEventListener('keydown', this._onKeyDown, true);

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
    if (this.open) this._renderLedger();
  },

  /** Read new slots off the authority_event ring since last seen, toast each. */
  _consumeEventRing(ctx) {
    const seq = ctx.store.gameRulesParam('authority_event');
    if (seq === undefined || seq === null) return;
    if (this.lastSeenEventSeq === null) {
      // First read: don't replay pre-existing history as toasts, just sync up.
      // The ledger DOES take what the ring still holds — history a player
      // opens the ledger to read is not spam the way replayed toasts are.
      this.lastSeenEventSeq = seq;
      this._walkRing(ctx, seq, (entry) => this._record(entry));
      return;
    }
    if (seq <= this.lastSeenEventSeq) return;

    this._walkRing(ctx, seq, (entry) => {
      this._record(entry);
      this._pushToast(entry.kind, entry.amount, entry.reason);
    }, this.lastSeenEventSeq);
    this.lastSeenEventSeq = seq;
  },

  /**
   * Visit the ring's live slots for this player/team, oldest first.
   * A ring holds only the last EVENT_RING_SIZE events — if more than that
   * fired since `since`, the earliest ones are already overwritten; only walk
   * back as far as the ring actually holds.
   */
  _walkRing(ctx, seq, visit, since = null) {
    const missed = since === null ? EVENT_RING_SIZE : Math.min(seq - since, EVENT_RING_SIZE);
    for (let s = seq - missed + 1; s <= seq; s++) {
      if (s < 1) continue;
      const slot = ((s % EVENT_RING_SIZE) + EVENT_RING_SIZE) % EVENT_RING_SIZE;
      const p = (k) => ctx.store.gameRulesParam(`authority_event_${slot}_${k}`);
      if (p('seq') !== s) continue;   // slot since overwritten by a newer event
      const player = p('player');
      const team = p('team');
      // Only this player's own events, or a team event that names them — a
      // global event stream shouldn't spam toasts for every other team's income.
      const mine = player === ctx.identity.playerId || team === ctx.identity.teamId;
      if (!mine) continue;
      visit({ seq: s, kind: p('kind'), amount: p('amount'), reason: p('reason') });
    }
  },

  /** Keep the newest LEDGER_SIZE entries, newest first, deduped by seq. */
  _record(entry) {
    if (this.ledger.some((e) => e.seq === entry.seq)) return;
    this.ledger.unshift(entry);
    if (this.ledger.length > LEDGER_SIZE) this.ledger.length = LEDGER_SIZE;
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

  // ── the drill ───────────────────────────────────────────────────────

  isOpen() { return this.open; },
  openLedger() { this._setOpen(true); },
  closeLedger() { this._setOpen(false); },
  _toggle() { this._setOpen(!this.open); },

  _setOpen(next) {
    if (this.open === next) return;
    this.open = next;
    this.pill.setAttribute('aria-expanded', String(next));
    this.pill.querySelector('.nui-dd__caret').textContent = next ? '▾' : '▸';
    this.el.classList.toggle('is-open', next);
    this.panel.hidden = !next;
    if (next) {
      this._renderLedger();
      this.focus.openSurface(LEDGER_SURFACE_ID);
    } else {
      this.panel.replaceChildren();     // no detail DOM while closed
      this.focus.closeSurface(LEDGER_SURFACE_ID);
    }
  },

  /** The rung-2 facts. Rebuilt on open and on every store notification while open. */
  _renderLedger() {
    const { store, identity } = this.ctx;
    const teamId = identity.teamId;
    const get = (k) => store.teamRulesParam(teamId, k);
    const mine = get('authority_player_' + identity.playerId);
    const team = get('authority_pool');
    const ownOnly = Number(get('authority_player_' + identity.playerId + '_own_pool_only') ?? 0) !== 0;
    const scale = store.gameRulesParam('authority_cost_scale');
    const version = store.gameRulesParam('authority_cost_version');

    const rows = [
      ['Your pool', formatAuthority(mine)],
      ['Team pool', formatAuthority(team)],
      ['Orders draw from', ownOnly ? 'your pool only' : 'your pool, then the team pool'],
    ];
    const scaleNum = Number(scale);
    if (scale !== undefined && scale !== null && Number.isFinite(scaleNum)) {
      rows.push(['Cost scale', scaleNum === 1 ? 'normal (×1)' : `×${scaleNum}`]);
    }
    if (version !== undefined && version !== null) rows.push(['Cost spec', `v${version}`]);

    const frag = document.createDocumentFragment();
    const body = document.createElement('div');
    body.className = 'nui-dd__body';
    for (const [label, value] of rows) body.appendChild(fact(label, value));

    const head = document.createElement('div');
    head.className = 'nui-dd__fact ms-auth-ledger__head';
    head.textContent = this.ledger.length ? 'Recent' : 'No awards or refusals yet';
    body.appendChild(head);
    for (const entry of this.ledger) {
      const row = ledgerRow(entry);
      const el = fact(row.label, row.value);
      el.classList.add('ms-auth-ledger__row', 'ms-auth-ledger__row--' + entry.kind);
      body.appendChild(el);
    }
    frag.appendChild(body);
    this.panel.replaceChildren(frag);
  },

  dispose() {
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown, true);
    if (this.open) this.focus.closeSurface(LEDGER_SURFACE_ID);
    this.open = false;
    this.unsub?.();
    this.el?.remove();
  },
};

/** A labelled fact row, in the design system's rung-2 markup. */
function fact(label, value) {
  const row = document.createElement('div');
  row.className = 'nui-dd__fact';
  const l = document.createElement('span');
  l.className = 'nui-dd__fact-label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'nui-dd__fact-value';
  v.textContent = value;
  row.append(l, v);
  return row;
}
