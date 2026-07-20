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
//   - the intent report (§6.3 "what my AI is doing"): the AI-side writer is
//     EXPLICITLY gated on engine ask I1 (ai/strategos/actuators.lua's
//     `_publishIntent` stays a documented no-op until then) — this panel
//     reads the same guidance_<team>_intent_* convention the writer WOULD
//     populate, so wiring is a pure no-op-removal once I1 lands, but shows
//     an honest "no intent data yet" state today rather than fabricating one.

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

function splitList(v) {
  if (v === undefined || v === null || v === '') return [];
  return String(v).split(',').filter(Boolean);
}

export default {
  id: 'ai-command-panel',

  init(ctx) {
    this.ctx = ctx;
    this.el = document.createElement('div');
    this.el.className = 'ms-ai-command-panel';
    this.el.innerHTML =
      '<h3>AI Command</h3>' +
      '<label>Stance<select class="ms-ai-stance">' +
      STANCES.map((s) => `<option value="${s}">${s}</option>`).join('') +
      '</select></label>' +
      '<label>ROE<select class="ms-ai-roe">' +
      ROES.map((r) => `<option value="${r}">${r}</option>`).join('') +
      '</select></label>' +
      '<fieldset class="ms-ai-paint">' +
      '<legend>Region paint</legend>' +
      '<input class="ms-ai-paint-region" type="text" placeholder="region key">' +
      '<select class="ms-ai-paint-value">' + PAINTS.map((p) => `<option value="${p}">${p}</option>`).join('') + '</select>' +
      '<button type="button" class="ms-ai-paint-apply">Apply</button>' +
      '<ul class="ms-ai-paint-list"></ul>' +
      '</fieldset>' +
      '<fieldset class="ms-ai-locks">' +
      '<legend>Asset locks (AI hands off)</legend>' +
      '<input class="ms-ai-lock-group" type="text" placeholder="group id">' +
      '<button type="button" class="ms-ai-lock-apply">Lock</button>' +
      '<button type="button" class="ms-ai-lock-clear">Unlock</button>' +
      '<ul class="ms-ai-lock-list"></ul>' +
      '</fieldset>' +
      '<fieldset class="ms-ai-funding">' +
      '<legend>Funding</legend>' +
      '<label>One-shot amount<input class="ms-ai-fund-amount" type="number" min="0"></label>' +
      '<label>Rate cap (per min)<input class="ms-ai-fund-ratecap" type="number" min="0"></label>' +
      '<button type="button" class="ms-ai-fund-apply">Send</button>' +
      '</fieldset>' +
      '<fieldset class="ms-ai-intent">' +
      '<legend>Intent report</legend>' +
      '<ul class="ms-ai-intent-list"></ul>' +
      '</fieldset>' +
      '<fieldset class="ms-ai-changes">' +
      '<legend>Recent changes</legend>' +
      '<ul class="ms-ai-change-list"></ul>' +
      '</fieldset>';
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
      if (veto) this._send('guidance.veto', { goalId: Number(veto.dataset.goal) });
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
      paintKeys.map((k) => `<li>${k}: ${get('paint_' + k)}</li>`).join('') || '<li class="ms-ai-none">No painted regions</li>';

    const lockKeys = splitList(get('lock_keys'));
    this.el.querySelector('.ms-ai-lock-list').innerHTML =
      lockKeys.map((k) => `<li>group ${k}</li>`).join('') || '<li class="ms-ai-none">No locked groups</li>';

    // §6.3: the intent-report WRITER is gated on engine ask I1 (see file
    // header) — this list is honestly empty until that lands, never faked.
    const intentCount = Number(get('intent_count')) || 0;
    const intentItems = [];
    for (let i = 0; i < intentCount; i++) {
      const goal = get(`intent_${i}_goal`);
      const group = get(`intent_${i}_group`);
      const spend = get(`intent_${i}_spend`);
      intentItems.push(
        `<li>${goal} -&gt; ${group} (~${spend} auth) ` +
        `<button type="button" class="ms-ai-intent-veto" data-goal="${goal}">Veto</button></li>`
      );
    }
    this.el.querySelector('.ms-ai-intent-list').innerHTML =
      intentItems.join('') || '<li class="ms-ai-none">No intent data yet (requires engine ask I1)</li>';

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
      items.push(`<li>player ${player} set ${field} = ${value}</li>`);
    }
    list.innerHTML = items.reverse().join('') || '<li class="ms-ai-none">No changes yet</li>';
    this.lastSeenChangeSeq = seq;
  },

  dispose() {
    this.unsub?.();
    this.el?.remove();
  },
};
