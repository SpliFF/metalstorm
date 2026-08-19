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
//   ctx.identity = { playerId, teamId, accountId }.
//
// `ctx.identity.playerId` and every `playerId` on a roster entry are Spring's
// SIM playerNum — the same number the `score_<playerID>_*` keys are scoped by.
// Not the DB account id; see PLAN-native-ui.md §3.3. Reading the account id
// here is what made this panel show one anonymous `You 0 0 0` row forever
// (PLAN-endtoend.md D3).
//
// Every player is listed, not just the local team: naming the opposition (and
// the AI) is the point of a scoreboard, and the underlying rulesParams are
// gameRulesParams — global by construction, so there is nothing to leak by
// showing them. Rows are grouped by team so allies read as a block.

import { readScoreboard, scoreboardRoster } from '../lib/scoreboard.js';
import { formatAuthority } from '../lib/authority-format.js';

let warnedNoRoster = false;

/** Escape text destined for innerHTML. Player names are user-chosen strings
 *  that arrive over the wire, so they are never interpolated raw. */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export default {
  id: 'scoreboard-panel',

  init(ctx) {
    this.ctx = ctx;
    this.el = document.createElement('div');
    this.el.className = 'ms-scoreboard-panel';
    // No <h3> — the loader's panel chrome supplies the "Scoreboard" header.
    // Column heads abbreviated to fit the 236px rail without wrapping; the
    // title attributes carry the full names.
    this.el.innerHTML =
      '<table class="nui-table ms-score-table">' +
      '<thead><tr><th>Player</th>' +
      '<th title="Authority earned">Earn</th>' +
      '<th title="Authority spent">Spend</th>' +
      '<th title="Objectives completed">Obj</th></tr></thead>' +
      '<tbody></tbody>' +
      '</table>';
    ctx.mount.appendChild(this.el);

    this.unsub = ctx.store.subscribe(['gameRulesParams', 'playerRoster'], () => this._render());
    this._render();
  },

  /** Roster entries to show — ordering and filtering live in ui/lib so they
   *  are testable without a DOM. */
  _rosterEntries() {
    const identity = this.ctx.identity ?? {};
    const getRoster = this.ctx.store && this.ctx.store.playerRoster;

    if (typeof getRoster !== 'function') {
      // Should not happen — ui-store has implemented playerRoster() since the
      // native-UI loader shipped — but a missing getter must read as a
      // diagnosable warning, not a silently empty panel.
      if (!warnedNoRoster) {
        warnedNoRoster = true;
        console.warn('[scoreboard-panel] ctx.store.playerRoster is not a function — ' +
          "falling back to the local player's own row");
      }
      return identity.playerId === undefined ? []
        : scoreboardRoster([{ playerId: identity.playerId, teamId: identity.teamId }], identity);
    }

    return scoreboardRoster(getRoster(), identity);
  },

  /** Display markup for a roster entry: the player's own name, marked up for
   *  "you" and for AI opponents. */
  _label(entry) {
    if (entry.isSelf) return `${esc(entry.name)} (You)`;
    if (entry.isAI) return `${esc(entry.name)} <span class="ms-score-ai">AI</span>`;
    return esc(entry.name);
  },

  _render() {
    const entries = this._rosterEntries();
    const rows = readScoreboard(
      (key) => this.ctx.store.gameRulesParam(key),
      entries.map((e) => e.playerId),
    );
    const body = this.el.querySelector('tbody');

    let lastTeam;
    const items = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const e = entries[i];
      // One separator row per team, so allies read as a block and the
      // opposition is visibly the opposition.
      if (e.teamId !== lastTeam) {
        lastTeam = e.teamId;
        const own = e.isOwnTeam ? ' is-own-team' : '';
        items.push(
          `<tr class="ms-score-teamhead${own}"><td colspan="4">Team ${esc(e.teamId)}` +
          `${own ? ' <span class="ms-score-ours">(yours)</span>' : ''}</td></tr>`,
        );
      }
      const self = e.isSelf ? ' is-self' : '';
      items.push(
        `<tr class="ms-score-row${self}">` +
        `<td class="ms-score-player">${this._label(e)}</td>` +
        // Earn/Spend are accumulated authority, so they carry the same float32
        // debris the bar did — and a 12-character cell in a 4-column table is
        // where it is least survivable (D49).
        `<td class="ms-score-earned">${formatAuthority(r.earned)}</td>` +
        `<td class="ms-score-spent">${formatAuthority(r.spent)}</td>` +
        `<td class="ms-score-objectives">${r.objectives}</td>` +
        `</tr>`,
      );
    }

    body.innerHTML = items.join('') ||
      '<tr><td colspan="4" class="nui-empty">No scoreboard data yet</td></tr>';
  },

  dispose() {
    this.unsub?.();
    this.el?.remove();
  },
};
