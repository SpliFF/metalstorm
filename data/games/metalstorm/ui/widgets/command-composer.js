// command-composer.js — Metalstorm native JS widget. STUB.
//
// Accessible order composer (PLAN-metalstorm-scripting.md): closed-vocabulary
// slot-filling sentences ("attack the city at <coords>, priority high, when
// contested") with autocomplete over named entities, priority slider,
// map-click targets. 100% client: compiles to EXISTING directives / standing
// orders / AI guidance (subject = "the AI" → game_ai_guidance store) — no
// new sim code, no new wire.
//
// Contract: same widget shape as authority-bar.js (init(ctx)/dispose()).
// Cost preview via ui/lib/authority-cost.js; named entities from regions
// (ui/lib/regions.js), objectives rulesParams, org-group names, scenario
// landmarks (PLAN-persistence §5).
//
// Internal modules to grow IN THIS FILE first, split only when real
// (per PLAN-metalstorm-scripting tasks 2–3, decision recorded in
// PLAN-metalstorm-structure.md): entity-index, compile-table, presets store.

export default {
  id: 'command-composer',

  init(ctx) {
    this.el = document.createElement('div');
    this.el.className = 'ms-command-composer';
    this.el.textContent = 'Composer (stub)';
    ctx.mount.appendChild(this.el);
    // TODO (scripting tasks 1–6): chip sentence UI → intent → compile →
    // validated submission with cost preview.
  },

  dispose() {
    this.el?.remove();
  },
};
