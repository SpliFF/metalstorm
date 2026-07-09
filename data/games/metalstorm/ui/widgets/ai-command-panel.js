// ai-command-panel.js — Metalstorm native JS widget. STUB.
//
// Cooperative-AI guiding surface (PLAN-metalstorm-interaction §6, which OWNS
// this design — ai §5.1 defers to it, review A14): stance selector, region
// paint (attack/hold/avoid over the strategic map), asset locks, objective
// delegation, funding slider, ROE, plus the AI's intent report feed and
// per-goal veto buttons.
//
// Contract: same widget shape as authority-bar.js (init(ctx)/dispose()).
// Writes go to LuaRules/Gadgets/game_ai_guidance.lua via the validated
// command API; reads the guidance store + intent report from team-scoped
// rulesParams (privacy = engine ask I2).

export default {
  id: 'ai-command-panel',

  init(ctx) {
    this.el = document.createElement('div');
    this.el.className = 'ms-ai-command-panel';
    this.el.textContent = 'AI Command (stub)';
    ctx.mount.appendChild(this.el);
    // TODO (interaction §6): stance / paint / locks / delegation / funding /
    // roe controls; intent report list with veto.
  },

  dispose() {
    this.el?.remove();
  },
};
