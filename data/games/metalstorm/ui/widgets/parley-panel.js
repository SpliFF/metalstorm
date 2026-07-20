// parley-panel.js — Metalstorm native JS widget.
//
// Parley board + proposal composer (PLAN-metalstorm-interaction.md §5):
// incoming/outgoing proposal cards, active-pact list with trust badges,
// compose flow for all six kinds, accept/reject/counter/withdraw actions.
// Reads via ui/lib/parley.js's poll-style index (same
// `ctx.store.gameRulesParam(key)` singular-getter contract every other
// native-ui widget uses, see authority-bar.js's header for the full
// rationale) — parley records are GAME-scoped/public (game_parley.lua's
// header explains why: visible to both parties + spectators/replays, unlike
// game_ai_guidance.lua's team-private store).
//
// NOT wired here (blocked on infrastructure this widget doesn't own — same
// pre-loader state as every other native-ui widget, see authority-bar.js /
// objectives-panel.js headers):
//   - live rulesParams data at all (the server->client wire producer for
//     Set{Game,Team}RulesParam doesn't exist yet — dead consumer in
//     client/src/core/lua-ui-host.ts).
//   - map-click region/corridor/target picks: PLAN-macro-map.md's
//     strategic-map overlay doesn't exist yet (confirmed absent — no
//     shaders/region-overlay.frag.glsl, no overlay component anywhere) —
//     the composer takes region keys / unit ids as typed input instead of
//     map picks, same scoped-down approach objectives-panel.js takes for
//     bounty targets.
//   - submitting a proposal: calls the documented `ctx.sendCommand`
//     stand-in (warn-once-if-absent, per CLAUDE.md's no-silent-stand-ins
//     contract) — command names ('parley.propose'/'parley.respond'/
//     'parley.withdraw') match game_parley.lua's gadget:RecvLuaMsg dispatch
//     exactly, so wiring a real sendCommand later is a pure plumbing task,
//     not a contract change here.

import { createParleyIndex, trustBetween } from '../lib/parley.js';

const KIND_LABEL = {
  ceasefire: 'Ceasefire', tribute: 'Tribute', safe_passage: 'Safe Passage',
  joint_objective: 'Joint Objective', demand: 'Demand', intel: 'Intel Share',
};

const KINDS = ['ceasefire', 'tribute', 'safe_passage', 'joint_objective', 'demand', 'intel'];

let warnedNoSendCommand = false;

function warnNoSendCommand(action) {
  if (warnedNoSendCommand) return;
  warnedNoSendCommand = true;
  console.warn(
    `[parley-panel] ctx.sendCommand is not wired yet — ${action} is a no-op ` +
    '(FIDELITY-STANDIN: no validated command-send API for native-ui widgets yet, see file header).'
  );
}

function trustBadge(trust) {
  const cls = trust > 0 ? 'ms-parley-trust-good' : trust < 0 ? 'ms-parley-trust-bad' : 'ms-parley-trust-neutral';
  return `<span class="ms-parley-trust ${cls}">trust ${trust > 0 ? '+' : ''}${trust}</span>`;
}

function renderIncoming(p, ctx) {
  const trust = trustBetween((k) => ctx.store.gameRulesParam(k), p.from, ctx.identity.teamId ?? p.to);
  return (
    `<li class="ms-parley-card ms-parley-incoming" data-id="${p.id}">` +
    `<span class="ms-parley-kind">${KIND_LABEL[p.kind] ?? p.kind}</span>` +
    `<span class="ms-parley-from">from team ${p.from}</span>` +
    trustBadge(trust) +
    `<div class="ms-parley-actions">` +
    `<button type="button" class="ms-parley-accept" data-id="${p.id}">Accept</button>` +
    `<button type="button" class="ms-parley-reject" data-id="${p.id}">Reject</button>` +
    `</div></li>`
  );
}

function renderOutgoing(p) {
  return (
    `<li class="ms-parley-card ms-parley-outgoing" data-id="${p.id}">` +
    `<span class="ms-parley-kind">${KIND_LABEL[p.kind] ?? p.kind}</span>` +
    `<span class="ms-parley-to">to team ${p.to}</span>` +
    `<span class="ms-parley-state">${p.state}</span></li>`
  );
}

function renderActive(p) {
  return (
    `<li class="ms-parley-card ms-parley-active" data-id="${p.id}">` +
    `<span class="ms-parley-kind">${KIND_LABEL[p.kind] ?? p.kind}</span>` +
    `<span class="ms-parley-parties">${p.from} &lt;-&gt; ${p.to}</span>` +
    `<button type="button" class="ms-parley-withdraw" data-id="${p.id}">Withdraw</button></li>`
  );
}

export default {
  id: 'parley-panel',

  init(ctx) {
    this.ctx = ctx;
    this.index = createParleyIndex();

    this.el = document.createElement('div');
    this.el.className = 'ms-parley-panel';
    this.el.innerHTML =
      '<h3>Parley</h3>' +
      '<div class="ms-parley-board">' +
      '<div><h4>Incoming</h4><ul class="ms-parley-incoming-list"></ul></div>' +
      '<div><h4>Outgoing</h4><ul class="ms-parley-outgoing-list"></ul></div>' +
      '<div><h4>Active pacts</h4><ul class="ms-parley-active-list"></ul></div>' +
      '</div>' +
      '<div class="ms-parley-composer">' +
      '<button type="button" class="ms-parley-toggle">+ Propose</button>' +
      '<form class="ms-parley-form" hidden>' +
      '<label>To team<input class="ms-parley-toTeam" type="number" required></label>' +
      '<label>Kind<select class="ms-parley-kindSelect">' +
      KINDS.map((k) => `<option value="${k}">${KIND_LABEL[k]}</option>`).join('') +
      '</select></label>' +
      '<label>Duration (frames)<input class="ms-parley-duration" type="number" min="0"></label>' +
      '<label>Amount<input class="ms-parley-amount" type="number" min="0"></label>' +
      '<label>Region key(s), comma-separated<input class="ms-parley-regions" type="text"></label>' +
      '<label>Objective ID<input class="ms-parley-objectiveId" type="number" min="0"></label>' +
      '<button type="submit">Send proposal</button>' +
      '</form></div>';
    ctx.mount.appendChild(this.el);

    this._wireComposer();
    this._wireActions();

    const pull = () => this.index.pull((key) => ctx.store.gameRulesParam(key));
    this.unsub = ctx.store.subscribe(['gameRulesParams'], () => {
      if (pull()) this._render();
    });
    pull();
    this._render();
  },

  _wireComposer() {
    const toggle = this.el.querySelector('.ms-parley-toggle');
    const form = this.el.querySelector('.ms-parley-form');
    toggle.addEventListener('click', () => { form.hidden = !form.hidden; });

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const kind = this.el.querySelector('.ms-parley-kindSelect').value;
      const toTeam = Number(this.el.querySelector('.ms-parley-toTeam').value);
      const duration = Number(this.el.querySelector('.ms-parley-duration').value) || undefined;
      const amount = Number(this.el.querySelector('.ms-parley-amount').value) || undefined;
      const regionsRaw = this.el.querySelector('.ms-parley-regions').value.trim();
      const regions = regionsRaw ? regionsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
      const objectiveId = Number(this.el.querySelector('.ms-parley-objectiveId').value) || undefined;
      if (!Number.isFinite(toTeam)) return;

      const terms = { duration, amount };
      if (kind === 'safe_passage') terms.corridor = regions;
      if (kind === 'ceasefire' && regions) terms.regionKey = regions[0];
      if (kind === 'intel') terms.regionKeys = regions;
      if (kind === 'joint_objective') terms.objectiveId = objectiveId;

      this._send('parley.propose', { kind, toTeam, terms });
      form.hidden = true;
      form.reset();
    });
  },

  _wireActions() {
    this.el.addEventListener('click', (ev) => {
      const accept = ev.target.closest('.ms-parley-accept');
      const reject = ev.target.closest('.ms-parley-reject');
      const withdraw = ev.target.closest('.ms-parley-withdraw');
      if (accept) this._send('parley.respond', { id: Number(accept.dataset.id), decision: 'accept' });
      else if (reject) this._send('parley.respond', { id: Number(reject.dataset.id), decision: 'reject' });
      else if (withdraw) this._send('parley.withdraw', { id: Number(withdraw.dataset.id) });
    });
  },

  _send(command, payload) {
    if (typeof this.ctx.sendCommand !== 'function') {
      warnNoSendCommand(command);
      return;
    }
    this.ctx.sendCommand(command, payload);
  },

  _render() {
    const teamId = this.ctx.identity?.teamId;
    this.el.querySelector('.ms-parley-incoming-list').innerHTML =
      this.index.incoming(teamId).map((p) => renderIncoming(p, this.ctx)).join('') || '<li class="ms-parley-none">Nothing pending</li>';
    this.el.querySelector('.ms-parley-outgoing-list').innerHTML =
      this.index.outgoing(teamId).map(renderOutgoing).join('') || '<li class="ms-parley-none">Nothing pending</li>';
    this.el.querySelector('.ms-parley-active-list').innerHTML =
      this.index.active(teamId).map(renderActive).join('') || '<li class="ms-parley-none">No active pacts</li>';
  },

  dispose() {
    this.unsub?.();
    this.el?.remove();
  },
};
