// objectives-panel.js — Metalstorm native JS widget. STUB.
//
// Lists active objectives (strategic + tactical) with type, reward, state
// (PLAN-metalstorm.md §3). Reads the rulesParams mirror published by
// game_objectives.lua (objective_<id>_*) until a proper objective stream
// exists. Click → camera focus (via sendPrompt-style command API, TBD).
//
// Same contract as authority-bar.js (PLAN-native-ui.md §3).

const TYPE_ICONS = {
  control: '⬢', kill: '✕', escort: '➜', protect: '🛡', extract: '⤴', infra: '⚙',
};

export default {
  id: 'objectives-panel',

  init(ctx) {
    this.el = document.createElement('div');
    this.el.className = 'ms-objectives-panel';
    this.el.innerHTML = '<h3>Objectives</h3><ul class="ms-obj-list"></ul>';
    ctx.mount.appendChild(this.el);

    this.unsub = ctx.store.subscribe(['gameRulesParams'], () => {
      const count = ctx.store.gameRulesParam('objective_count') || 0;
      const list = this.el.querySelector('.ms-obj-list');
      const items = [];
      for (let id = 1; id <= count; id++) {
        const p = (k) => ctx.store.gameRulesParam(`objective_${id}_${k}`);
        const state = p('state');
        if (state !== 'active') continue;        // v0: active only
        const team = p('team');
        if (team !== -1 && team !== ctx.identity.teamId) continue;
        items.push(
          `<li class="ms-obj ms-obj-${p('scope')}">` +
          `<span class="ms-obj-icon">${TYPE_ICONS[p('type')] ?? '•'}</span>` +
          `<span class="ms-obj-type">${p('type')}</span>` +
          `<span class="ms-obj-reward">⬡ ${p('reward') ?? 0}</span></li>`
        );
      }
      list.innerHTML = items.join('') || '<li class="ms-obj-none">No active objectives</li>';
    });
  },

  dispose() {
    this.unsub?.();
    this.el?.remove();
  },
};
