// tutorial-guide.js — the coach card (PLAN-beta.md "Entry"; game_tutorial.lua
// is the other half). Renders ONE card from the `tutorial_*` gameRulesParams
// the Tutorial Director publishes, verifies the client-side checks the sim
// cannot see (selection / drill-down / menu), and answers over the wire:
//   cmd=tutorial.ack|skip|restart|stop  as {type:'LuaRulesMsg', data}
// "Show me" feature-detects a camera (`ctx.camera.travelTo`, then
// `globalThis.__nativeUi.travelTo`) and otherwise dispatches
// CustomEvent('ms-tutorial:show', {detail:{x,z,panel}}) for whoever listens.
// Nothing is rendered outside a tutorial Mission.

export const SHOW_EVENT = 'ms-tutorial:show';
export const STORAGE_PREFIX = 'ms.tutorial.';
const CHECK_MS = 400;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** parley/wire.lua's codec: `cmd=name&k=v…`, [%&=,] percent-escaped, lists comma-joined. */
export function encodeWire(cmd, fields = {}) {
  const enc = (v) => String(v).replace(/[%&=,]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
  const parts = ['cmd=' + enc(cmd)];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    parts.push(enc(k) + '=' + (Array.isArray(v) ? v.map(enc).join(',') : enc(v)));
  }
  return parts.join('&');
}

/** The client-side facts a `client` beat waits on. `null` = no hook exists
 *  yet (the card falls back to a Done button). */
export const CLIENT_CHECKS = {
  selection: (ctx) => (ctx.store?.getSelection?.()?.unitIds?.length ?? 0) > 0,
  drilldown: () => !!document.querySelector('.nui-dd.is-open'),
  menu: () => { const p = document.querySelector('.nui-global'); return !!p && !p.hidden; },
  console: null,
  none: () => true,
};

/** Everything the card renders, read off the params map — pure and testable. */
export function tutorialModel(params) {
  const get = (k) => params.get(k);
  const num = (k) => { const v = Number(get(k)); return Number.isFinite(v) ? v : null; };
  if (Number(get('tutorial_active')) !== 1) return { visible: false };
  const state = String(get('tutorial_state') ?? '');
  if (state !== 'running') return { visible: state === 'done', state };
  const wait = String(get('tutorial_wait') ?? 'ack');
  const regions = get('tutorial_parley_regions');
  return {
    visible: true,
    state,
    id: String(get('tutorial_beat_id') ?? ''),
    index: num('tutorial_beat') ?? 0,
    count: num('tutorial_beat_count') ?? 0,
    title: String(get('tutorial_title') ?? ''),
    text: String(get('tutorial_text') ?? ''),
    wait,
    check: wait === 'client' ? String(get('tutorial_check') ?? 'none') : null,
    stuck: get('tutorial_hint') === 'stuck',
    show: (num('tutorial_show_x') !== null || get('tutorial_show_panel') != null)
      ? { x: num('tutorial_show_x'), z: num('tutorial_show_z'), panel: get('tutorial_show_panel') ?? null }
      : null,
    parley: get('tutorial_parley_kind')
      ? { kind: String(get('tutorial_parley_kind')), toTeam: num('tutorial_parley_to'),
          regionKeys: regions ? String(regions).split(',').filter(Boolean) : undefined }
      : null,
  };
}

/** Point the player at a place or a panel with whatever this build offers. */
export function showTarget(ctx, show) {
  const nui = globalThis.__nativeUi;
  if (show.panel != null) {
    if (typeof ctx?.ui?.open === 'function') return ctx.ui.open(show.panel), 'ui';
    if (typeof nui?.open === 'function') return nui.open(show.panel), 'nativeUi';
  } else if (show.x != null && show.z != null) {
    if (typeof ctx?.camera?.travelTo === 'function') return ctx.camera.travelTo(show.x, show.z), 'camera';
    if (typeof nui?.travelTo === 'function') return nui.travelTo(show.x, show.z), 'nativeUi';
  }
  document.dispatchEvent(new CustomEvent(SHOW_EVENT, { detail: { x: show.x, z: show.z, panel: show.panel } }));
  return 'event';
}

const STYLE = `
.ms-tutorial{font:13px/1.45 var(--nui-font,system-ui,sans-serif);color:var(--nui-fg,#e6e2da);max-width:300px}
.ms-tutorial__step{font-size:10px;letter-spacing:.14em;text-transform:uppercase;opacity:.65;margin-bottom:4px}
.ms-tutorial__title{font-weight:700;font-size:15px;margin-bottom:6px}
.ms-tutorial__text{margin-bottom:10px}
.ms-tutorial__note{font-size:12px;opacity:.75;margin-bottom:8px}
.ms-tutorial__actions{display:flex;flex-wrap:wrap;gap:6px}
.ms-tutorial__actions .nui-btn[data-act=skip],.ms-tutorial__actions .nui-btn[data-act=stop]{opacity:.7}
.ms-tutorial--stuck .nui-btn[data-act=skip]{opacity:1;outline:1px solid currentColor}`;

export default {
  id: 'tutorial-guide',

  init(ctx) {
    this.ctx = ctx;
    if (!document.getElementById('ms-tutorial-style')) {
      const st = document.createElement('style');
      st.id = 'ms-tutorial-style';
      st.textContent = STYLE;
      document.head.append(st);
    }
    this.el = document.createElement('div');
    this.el.className = 'ms-tutorial';
    ctx.mount.appendChild(this.el);
    this.acked = null;            // beat id already acked (never ack twice)
    this.onClick = (e) => this._onClick(e);
    this.el.addEventListener('click', this.onClick);
    this.unsub = ctx.store.subscribe(['gameRulesParams', 'selection'], () => this._update());
    this.timer = setInterval(() => this._verify(), CHECK_MS);
    this._update();
  },

  _model() {
    return tutorialModel(this.ctx.store.getGameRulesParams());
  },

  _update() {
    const m = this._model();
    this._remember(m);
    this._render(m);
    this._verify(m);
  },

  /** A `client` beat is finished by the widget the moment its check holds. */
  _verify(m = this._model()) {
    if (!m.visible || m.state !== 'running' || m.wait !== 'client') return;
    const check = CLIENT_CHECKS[m.check];
    if (typeof check !== 'function' || this.acked === m.id) return;
    if (check(this.ctx)) this._send('tutorial.ack', { beat: m.id });
  },

  _remember(m) {
    if (m.state !== 'done' && m.state !== 'stopped') return;
    try {
      const scenario = this.ctx.store.getGameRulesParams().get('scenario_name') ?? 'default';
      localStorage.setItem(STORAGE_PREFIX + scenario, m.state);
    } catch { /* storage may be unavailable; the sim is the source of truth */ }
  },

  _render(m) {
    const parts = [];
    if (m.visible && m.state === 'done') {
      parts.push('<div class="ms-tutorial__title">Training complete</div>');
      parts.push('<div class="ms-tutorial__text">You have finished every step of this Mission\'s coaching.</div>');
      parts.push('<div class="ms-tutorial__actions"><button type="button" class="nui-btn" data-act="restart">Restart</button>' +
        '<button type="button" class="nui-btn" data-act="stop">Hide</button></div>');
    } else if (m.visible) {
      parts.push(`<div class="ms-tutorial__step">Step ${m.index} of ${m.count}</div>`);
      parts.push(`<div class="ms-tutorial__title">${esc(m.title)}</div>`);
      parts.push(`<div class="ms-tutorial__text">${esc(m.text)}</div>`);
      if (m.stuck) parts.push('<div class="ms-tutorial__note">Stuck? Show me points the way; Skip moves on.</div>');
      const btns = [];
      const needsButton = m.wait === 'ack' || (m.wait === 'client' && typeof CLIENT_CHECKS[m.check] !== 'function');
      if (needsButton) btns.push(`<button type="button" class="nui-btn" data-act="ack">${m.wait === 'ack' ? 'Next' : 'Done'}</button>`);
      if (m.parley) btns.push(`<button type="button" class="nui-btn" data-act="parley">Propose ${esc(m.parley.kind.replace(/_/g, ' '))}</button>`);
      if (m.show) btns.push('<button type="button" class="nui-btn" data-act="show">Show me</button>');
      btns.push('<button type="button" class="nui-btn" data-act="skip">Skip</button>');
      btns.push('<button type="button" class="nui-btn" data-act="stop">Hide</button>');
      parts.push(`<div class="ms-tutorial__actions">${btns.join('')}</div>`);
    }
    this.el.classList.toggle('ms-tutorial--stuck', !!m.stuck);
    this.el.innerHTML = parts.join('');
    const frame = this.el.closest('.nui-panel');
    if (frame) frame.hidden = parts.length === 0;
  },

  _onClick(e) {
    const act = e.target?.closest?.('[data-act]')?.dataset?.act;
    if (!act) return;
    const m = this._model();
    if (act === 'ack') this._send('tutorial.ack', { beat: m.id });
    else if (act === 'skip') this._send('tutorial.skip', { beat: m.id });
    else if (act === 'restart') this._send('tutorial.restart');
    else if (act === 'stop') this._send('tutorial.stop');
    else if (act === 'show' && m.show) showTarget(this.ctx, m.show);
    else if (act === 'parley' && m.parley) {
      // The verb form: `parley.` is a wire prefix integration.ts forwards.
      this.ctx.sendCommand?.('parley.propose', {
        kind: m.parley.kind, toTeam: m.parley.toTeam, regionKeys: m.parley.regionKeys,
      });
    }
  },

  _send(cmd, fields = {}) {
    if (cmd === 'tutorial.ack') this.acked = fields.beat;
    this.ctx.sendCommand?.({ type: 'LuaRulesMsg', data: encodeWire(cmd, fields) });
  },

  dispose() {
    clearInterval(this.timer);
    this.el?.removeEventListener('click', this.onClick);
    this.unsub?.();
    this.el?.remove();
    this.el = null;
  },
};
