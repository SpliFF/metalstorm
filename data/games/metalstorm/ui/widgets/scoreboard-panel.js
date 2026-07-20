// scoreboard-panel.js — Metalstorm native JS widget.
//
// Per-player contribution scoreboard (PLAN-metalstorm-teams.md §6): lifetime
// authority earned/spent + objectives completed, read from the
// score_<playerID>_* rulesParams game_teams.lua publishes on a 30s cadence.
// Social recognition only — the *team* wins or loses (§6); nothing here
// drives rewards, and this same live table is what a game-over screen would
// show (the plan's "game-over overlay reads the params" — there's no
// separate end-game-only code path, it's the same subscription-driven read).
//
// Contract mirrors authority-bar.js/objectives-panel.js exactly:
//   init(ctx)/dispose(), ctx.store.gameRulesParam(key) singular getter,
//   ctx.identity = { playerId, teamId }.
//
// NOT wired here (blocked on infrastructure this widget doesn't own — same
// pre-loader state as every other native-ui widget, see authority-bar.js):
//   - live rulesParams data at all: the server->client wire producer for
//     Set{Game,Team,Player,Unit}RulesParam doesn't exist yet (dead consumer
//     in client/src/core/lua-ui-host.ts) — this widget is correct against
//     the documented rulesParams contract but unverifiable live until that
//     lands (PLAN-metalstorm-authority.md field notes has the full writeup).
//   - a player roster: "which playerIDs exist" / "who's on my team" has no
//     working accessor yet. The manifest (metalstorm.ui.json) already
//     declares a `playerRoster` subscription topic — authority-bar.js lists
//     it too but doesn't consume it either — so this widget subscribes to
//     the SAME anticipated topic rather than inventing a new one, and reads
//     it via the documented-but-not-yet-implemented `ctx.store.playerRoster()`
//     getter (mirrors `gameRulesParam`/`teamRulesParam`'s singular-getter
//     shape). Until that store method exists, this can only show the LOCAL
//     player's own row for certain; it warns once (not silently) when the
//     getter is absent — same documented-stand-in convention as
//     ctx.sendCommand/ctx.strategicMap in objectives-panel.js.

import { readScoreboard } from '../lib/scoreboard.js';

let warnedNoRoster = false;

export default {
  id: 'scoreboard-panel',

  init(ctx) {
    this.ctx = ctx;
    this.el = document.createElement('div');
    this.el.className = 'ms-scoreboard-panel';
    this.el.innerHTML =
      '<h3>Scoreboard</h3>' +
      '<table class="ms-score-table">' +
      '<thead><tr><th>Player</th><th>Earned</th><th>Spent</th><th>Objectives</th></tr></thead>' +
      '<tbody></tbody>' +
      '</table>';
    ctx.mount.appendChild(this.el);

    this.unsub = ctx.store.subscribe(['gameRulesParams', 'playerRoster'], () => this._render());
    this._render();
  },

  /** Every playerId this widget can currently show a row for — see the
   *  header note on why this is usually just the local player. */
  _rosterIds() {
    const identity = this.ctx.identity ?? {};
    const ids = new Set();
    if (identity.playerId !== undefined) ids.add(identity.playerId);

    const getRoster = this.ctx.store && this.ctx.store.playerRoster;
    if (typeof getRoster === 'function') {
      for (const p of getRoster() ?? []) {
        if (p && p.teamId === identity.teamId && p.playerId !== undefined) ids.add(p.playerId);
      }
    } else if (!warnedNoRoster) {
      warnedNoRoster = true;
      console.warn(
        '[scoreboard-panel] ctx.store.playerRoster is not wired yet — showing only the local ' +
        "player's own row (FIDELITY-STANDIN: the manifest declares this subscription topic but no " +
        'store getter implements it yet, see file header).'
      );
    }
    return Array.from(ids);
  },

  _render() {
    const identity = this.ctx.identity ?? {};
    const rows = readScoreboard((key) => this.ctx.store.gameRulesParam(key), this._rosterIds());
    const body = this.el.querySelector('tbody');
    const items = rows.map((r) => (
      `<tr class="ms-score-row${r.playerId === identity.playerId ? ' ms-score-row-self' : ''}">` +
      `<td class="ms-score-player">${r.playerId === identity.playerId ? 'You' : 'Player ' + r.playerId}</td>` +
      `<td class="ms-score-earned">⬡ ${r.earned}</td>` +
      `<td class="ms-score-spent">⬡ ${r.spent}</td>` +
      `<td class="ms-score-objectives">${r.objectives}</td>` +
      `</tr>`
    ));
    body.innerHTML = items.join('') || '<tr class="ms-score-none"><td colspan="4">No scoreboard data yet</td></tr>';
  },

  dispose() {
    this.unsub?.();
    this.el?.remove();
  },
};
