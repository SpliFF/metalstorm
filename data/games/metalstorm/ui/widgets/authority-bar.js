// authority-bar.js — Metalstorm native JS widget. STUB.
//
// Shows the player's authority pool + the team pool (PLAN-metalstorm.md §4).
// Replaces the engine economy bar (no metal/energy in Metalstorm).
//
// Contract (proposed; PLAN-native-ui.md §3 — loader not built yet):
//   init(ctx)  — ctx.store    read API over the streamed state mirrors
//                ctx.mount    DOM element inside #ui-root (pointer-events:auto)
//                ctx.identity { playerId, teamId }
//   dispose()  — remove subscriptions/DOM.
// Updates are EVENT-DRIVEN (store subscriptions), never per-frame
// (PLAN-native-ui.md "no per-frame DOM mutation").

export default {
  id: 'authority-bar',

  init(ctx) {
    this.el = document.createElement('div');
    this.el.className = 'ms-authority-bar';
    this.el.innerHTML =
      '<span class="ms-auth-player" title="Your authority">⬡ —</span>' +
      '<span class="ms-auth-team" title="Team authority pool">⬡⬡ —</span>';
    ctx.mount.appendChild(this.el);

    // Authority pools are published as rulesParams by game_authority.lua:
    //   team:   teamRulesParams[teamId].authority_pool
    //   player: gameRulesParams['authority_player_<playerId>']
    this.unsub = ctx.store.subscribe(['teamRulesParams', 'gameRulesParams'], () => {
      const team = ctx.store.teamRulesParam(ctx.identity.teamId, 'authority_pool');
      const mine = ctx.store.gameRulesParam('authority_player_' + ctx.identity.playerId);
      this.el.querySelector('.ms-auth-player').textContent = '⬡ ' + (mine ?? 0);
      this.el.querySelector('.ms-auth-team').textContent = '⬡⬡ ' + (team ?? 0);
    });
  },

  dispose() {
    this.unsub?.();
    this.el?.remove();
  },
};
