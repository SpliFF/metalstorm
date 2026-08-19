// ai-command-panel.js — Metalstorm native JS widget.
//
// Cooperative-AI guiding surface (PLAN-metalstorm-interaction.md §6, which
// OWNS this design — ai §5.1 defers to it, review A14): stance selector,
// region paint, asset locks, objective delegation ("Assign to AI" —
// objectives-panel.js's button posts here), funding, ROE, the change feed
// (§6.2 "who set what"), and the veto blacklist.
//
// Reads TEAM-scoped rulesParams (`ctx.store.teamRulesParam(teamId, key)` —
// same singular-getter contract as authority-bar.js's pool reads) published
// by game_ai_guidance.lua under the `guidance_<teamId>_*` prefix. Privacy
// (engine ask I2) is a property of that gadget's publish() — see its header
// for the sim-side-verified / streaming-wire-pending breakdown; this widget
// just reads whatever the store contract hands it.
//
// NOT wired here (same pre-loader state as every other native-ui widget):
//   - live rulesParams data / the command-send API (`ctx.sendCommand`
//     stand-in, warn-once-if-absent) — see parley-panel.js's header for the
//     shared rationale.
//
// The intent report (§6.3 "what my AI is doing") IS wired: engine ask I1
// landed 2026-08-14 (PLAN-ai-synced-write.md), so `game_ai_guidance.lua`
// publishes `guidance_<team>_intent_<i>_{goal,group,spend,goal_id}` from the
// authority charge path and the strategos actuator tags each directive with
// its planner goal id. `goal_id` is the loop-closing field: it is what the
// Veto button sends back, so a line WITHOUT one (a scripted-slate directive
// carries no planner goal) still renders — it just carries no Veto button,
// because there would be nothing for the planner to blacklist.

import { formatAuthority } from '../lib/authority-format.js';

const STANCES = ['defensive', 'balanced', 'aggressive'];
const PAINTS = ['normal', 'priority', 'forbidden'];
const ROES = ['free', 'observed_only', 'deny_area'];
const CHANGE_RING_SIZE = 8;

let warnedNoSendCommand = false;
function warnNoSendCommand(action) {
  if (warnedNoSendCommand) return;
  warnedNoSendCommand = true;
  console.warn(
    `[ai-command-panel] ctx.sendCommand is not wired yet — ${action} is a no-op ` +
    '(FIDELITY-STANDIN: no validated command-send API for native-ui widgets yet, see file header).'
  );
}

/** Quote-safe interpolation for an HTML attribute value. The goal id is the one
 * value here that has to survive a round trip *out of* the DOM (`dataset.goal`
 * is read back and sent on the wire), and it originates in AI-authored planner
 * data rather than in this file — a bare `"` in it would otherwise end the
 * attribute and lose the id. */
function attrValue(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function splitList(v) {
  if (v === undefined || v === null || v === '') return [];
  return String(v).split(',').filter(Boolean);
}

export default {
  id: 'ai-command-panel',

  init(ctx) {
    this.ctx = ctx;
    // No <h3> — the loader's panel chrome supplies the "AI Command" header.
    // <fieldset>/<legend> replaced by .nui-group: fieldsets carry a browser
    // default border/legend notch that can't be styled consistently, and the
    // grouping here is visual, not form semantics (these controls belong to
    // no single form).
    this.el = document.createElement('div');
    this.el.className = 'ms-ai-command-panel';
    this.el.innerHTML =
      '<div class="nui-group">' +
      '<label class="nui-field nui-field--inline"><span>Stance</span><select class="ms-ai-stance">' +
      STANCES.map((s) => `<option value="${s}">${s}</option>`).join('') +
      '</select></label>' +
      '<label class="nui-field nui-field--inline"><span>ROE</span><select class="ms-ai-roe">' +
      ROES.map((r) => `<option value="${r}">${r}</option>`).join('') +
      '</select></label>' +
      '</div>' +
      '<div class="nui-group ms-ai-paint">' +
      '<h4 class="nui-group__title">Region paint</h4>' +
      '<div class="nui-row">' +
      '<input class="ms-ai-paint-region" type="text" placeholder="region key">' +
      '<select class="ms-ai-paint-value">' + PAINTS.map((p) => `<option value="${p}">${p}</option>`).join('') + '</select>' +
      '<button type="button" class="nui-btn nui-btn--sm ms-ai-paint-apply">Apply</button>' +
      '</div>' +
      '<ul class="nui-list ms-ai-paint-list"></ul>' +
      '</div>' +
      '<div class="nui-group ms-ai-locks">' +
      '<h4 class="nui-group__title">Asset locks (AI hands off)</h4>' +
      '<div class="nui-row">' +
      '<input class="ms-ai-lock-group" type="text" placeholder="group id">' +
      '<button type="button" class="nui-btn nui-btn--sm ms-ai-lock-apply">Lock</button>' +
      '<button type="button" class="nui-btn nui-btn--sm ms-ai-lock-clear">Unlock</button>' +
      '</div>' +
      '<ul class="nui-list ms-ai-lock-list"></ul>' +
      '</div>' +
      '<div class="nui-group ms-ai-funding">' +
      '<h4 class="nui-group__title">Funding</h4>' +
      '<div class="nui-row">' +
      '<label class="nui-field"><span>One-shot</span>' +
      '<input class="ms-ai-fund-amount" type="number" min="0"></label>' +
      '<label class="nui-field"><span>Rate cap /min</span>' +
      '<input class="ms-ai-fund-ratecap" type="number" min="0"></label>' +
      '</div>' +
      '<button type="button" class="nui-btn nui-btn--block ms-ai-fund-apply">Send</button>' +
      '</div>' +
      '<div class="nui-group ms-ai-intent">' +
      '<h4 class="nui-group__title">Intent report</h4>' +
      '<ul class="nui-list ms-ai-intent-list"></ul>' +
      '</div>' +
      '<div class="nui-group ms-ai-changes">' +
      '<h4 class="nui-group__title">Recent changes</h4>' +
      '<ul class="nui-list ms-ai-change-list"></ul>' +
      '</div>';
    ctx.mount.appendChild(this.el);

    this.lastSeenChangeSeq = null;
    this._wireControls();

    this.unsub = ctx.store.subscribe(['teamRulesParams'], () => this._render());
    this._render();
  },

  _wireControls() {
    this.el.querySelector('.ms-ai-stance').addEventListener('change', (ev) => {
      this._send('guidance.stance', { value: ev.target.value });
    });
    this.el.querySelector('.ms-ai-roe').addEventListener('change', (ev) => {
      this._send('guidance.roe', { value: ev.target.value });
    });
    this.el.querySelector('.ms-ai-paint-apply').addEventListener('click', () => {
      const regionKey = this.el.querySelector('.ms-ai-paint-region').value.trim();
      const value = this.el.querySelector('.ms-ai-paint-value').value;
      if (!regionKey) return;
      this._send('guidance.paint', { regionKey, value });
    });
    this.el.querySelector('.ms-ai-lock-apply').addEventListener('click', () => {
      const groupId = Number(this.el.querySelector('.ms-ai-lock-group').value);
      if (!Number.isFinite(groupId)) return;
      this._send('guidance.lock', { groupId, locked: '1' });
    });
    this.el.querySelector('.ms-ai-lock-clear').addEventListener('click', () => {
      const groupId = Number(this.el.querySelector('.ms-ai-lock-group').value);
      if (!Number.isFinite(groupId)) return;
      this._send('guidance.lock', { groupId, locked: '0' });
    });
    this.el.querySelector('.ms-ai-fund-apply').addEventListener('click', () => {
      const amount = Number(this.el.querySelector('.ms-ai-fund-amount').value) || undefined;
      const rateCap = Number(this.el.querySelector('.ms-ai-fund-ratecap').value) || undefined;
      this._send('guidance.fund', { amount, rateCap });
    });
    this.el.addEventListener('click', (ev) => {
      const veto = ev.target.closest('.ms-ai-intent-veto');
      // The goal id is sent as the RAW STRING the gadget published. Planner goal
      // ids are strings ('def:basin_a', 'obj:12' — ai/strategos/slate.lua), so
      // the old `Number(...)` produced NaN for every real one and the wire
      // dropped the field — the same coercion that made `guidance.veto` refuse
      // every real goal on the gadget side (PLAN-ai-synced-write §6, task 2).
      // A numeric id survives this unchanged: the gadget's handler still does
      // `Wire.num(fields.goalId) or fields.goalId`.
      if (veto) this._send('guidance.veto', { goalId: veto.dataset.goal });
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
    const get = (key) => this.ctx.store.teamRulesParam(teamId, `guidance_${teamId}_${key}`);

    const stance = get('stance');
    if (stance) this.el.querySelector('.ms-ai-stance').value = stance;
    const roe = get('roe');
    if (roe) this.el.querySelector('.ms-ai-roe').value = roe;

    const paintKeys = splitList(get('paint_keys'));
    this.el.querySelector('.ms-ai-paint-list').innerHTML =
      paintKeys.map((k) => `<li><span class="ms-ai-key">${k}</span><span class="nui-badge">${get('paint_' + k)}</span></li>`).join('') ||
      '<li class="nui-empty">No painted regions</li>';

    const lockKeys = splitList(get('lock_keys'));
    this.el.querySelector('.ms-ai-lock-list').innerHTML =
      lockKeys.map((k) => `<li><span class="ms-ai-key">group ${k}</span></li>`).join('') ||
      '<li class="nui-empty">No locked groups</li>';

    // §6.3: one line per directive the AI actually paid for (the gadget drives
    // the report off the charge path, so there are no phantom lines). The LABEL
    // stays `goal → group` — a human-readable verb like 'Assault', which is what
    // the panel has always shown; the VETO carries `goal_id`, the planner's own
    // id, which is the only value the planner can blacklist.
    const intentCount = Number(get('intent_count')) || 0;
    const intentItems = [];
    for (let i = 0; i < intentCount; i++) {
      const goal = get(`intent_${i}_goal`);
      const group = get(`intent_${i}_group`);
      const spend = get(`intent_${i}_spend`);
      // Published as '' rather than omitted when the entry has no tag (see the
      // gadget's publishIntent comment), so absent and empty both mean "no
      // planner goal": render the line, render no Veto button.
      const goalId = get(`intent_${i}_goal_id`);
      const vetoable = goalId !== undefined && goalId !== null && String(goalId) !== '';
      intentItems.push(
        `<li><span class="ms-ai-key">${goal} → ${group}</span>` +
        // An intent's spend is an authority amount like any other, so it wears
        // the shared format (D49). (The change feed below is deliberately NOT
        // formatted: its `value` is whatever field changed — a stance string as
        // often as a number.)
        `<span class="nui-badge nui-badge--gold">⬡ ${formatAuthority(spend)}</span>` +
        (vetoable
          ? '<button type="button" class="nui-btn nui-btn--sm nui-btn--danger ms-ai-intent-veto"' +
            ` data-goal="${attrValue(goalId)}">Veto</button>`
          : '') +
        '</li>'
      );
    }
    this.el.querySelector('.ms-ai-intent-list').innerHTML =
      intentItems.join('') || '<li class="nui-empty">No intent data yet</li>';
    // Stance is the one thing worth reading off a collapsed header.
    this.ctx.setBadge?.(stance || null);

    this._renderChanges(get);
  },

  /** Change feed (§6.2 "who set what") — same ring-consumption pattern as
   * authority-bar.js's award/charge event ring. */
  _renderChanges(get) {
    const seq = Number(get('change'));
    if (!Number.isFinite(seq)) return;
    if (this.lastSeenChangeSeq === null) {
      this.lastSeenChangeSeq = seq;
    }
    const list = this.el.querySelector('.ms-ai-change-list');
    const items = [];
    const missed = Math.min(seq, CHANGE_RING_SIZE);
    for (let s = seq - missed + 1; s <= seq; s++) {
      const slot = ((s % CHANGE_RING_SIZE) + CHANGE_RING_SIZE) % CHANGE_RING_SIZE;
      const field = get(`change_${slot}_field`);
      const value = get(`change_${slot}_value`);
      const player = get(`change_${slot}_player`);
      if (Number(get(`change_${slot}_seq`)) !== s) continue;
      items.push(
        `<li><span class="ms-ai-key">P${player} · ${field}</span>` +
        `<span class="nui-badge">${value}</span></li>`
      );
    }
    list.innerHTML = items.reverse().join('') || '<li class="nui-empty">No changes yet</li>';
    this.lastSeenChangeSeq = seq;
  },

  dispose() {
    this.unsub?.();
    this.el?.remove();
  },
};
