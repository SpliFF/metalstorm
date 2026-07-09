// parley-panel.js — Metalstorm native JS widget. STUB.
//
// Parley board + proposal composer + map picks (PLAN-metalstorm-interaction
// §1–5): incoming/outgoing proposals as cards, pact list with enforcement
// state, trust indicators, compose flow (ceasefire / tribute / demand /
// safe passage) with map-click region/route targets.
//
// Contract: same widget shape as authority-bar.js (init(ctx)/dispose();
// PLAN-native-ui.md §3 loader — Stage 7A-4, not built yet). Reads
// parley_<id>_* and trust_<a>_<b> rulesParams via ctx.store; submits
// proposals through the validated command API (never raw messages).

export default {
  id: 'parley-panel',

  init(ctx) {
    this.el = document.createElement('div');
    this.el.className = 'ms-parley-panel';
    this.el.textContent = 'Parley (stub)';
    ctx.mount.appendChild(this.el);
    // TODO (interaction §5): board render from parley rulesParams;
    // composer; map-pick integration shared with the region overlay layer.
  },

  dispose() {
    this.el?.remove();
  },
};
