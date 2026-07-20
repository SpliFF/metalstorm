// ui/lib/scoreboard.js — client parser for the per-player contribution
// scoreboard (PLAN-metalstorm-teams.md §6). Pure logic, no DOM.
//
// Reads `score_<playerID>_{earned,spent,objectives}` gameRulesParams
// game_teams.lua publishes on a 30s cadence. Unlike ui/lib/objectives.js
// there's no `_count`/high-water-mark field here — gameRulesParams don't
// expose a player roster at all (that's PLAN-lobby.md territory, not this
// file's) — so callers must supply the playerIDs they want rows for. See
// ui/widgets/scoreboard-panel.js's header for how (and how little) of a
// roster it can currently source.

const FIELDS = ['earned', 'spent', 'objectives'];

/** One player's scoreboard row, defaulting missing/unparseable fields to 0
 *  (a player who hasn't triggered a publish yet — e.g. joined since the
 *  last 30s tick — simply hasn't been counted, not an error state). */
export function readScoreboardRow(getParam, playerId) {
  const row = { playerId };
  for (const field of FIELDS) {
    const raw = getParam(`score_${playerId}_${field}`);
    const n = Number(raw);
    row[field] = Number.isFinite(n) ? n : 0;
  }
  return row;
}

/** Rows for a caller-supplied list of playerIDs, in the order given. */
export function readScoreboard(getParam, playerIds) {
  return playerIds.map((id) => readScoreboardRow(getParam, id));
}
