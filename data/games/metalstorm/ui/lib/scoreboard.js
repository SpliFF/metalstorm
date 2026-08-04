// ui/lib/scoreboard.js — client parser for the per-player contribution
// scoreboard (PLAN-metalstorm-teams.md §6). Pure logic, no DOM.
//
// Reads `score_<playerID>_{earned,spent,objectives}` gameRulesParams
// game_teams.lua publishes on a 30s cadence. Unlike ui/lib/objectives.js
// there's no `_count`/high-water-mark field here — gameRulesParams don't
// expose a player roster at all — so callers must supply the playerIDs they
// want rows for. `ctx.store.playerRoster()` is where those come from; the
// `<playerID>` in the key is Spring's sim playerNum, which is exactly what a
// roster entry's `playerId` holds (PLAN-native-ui.md §3.3).

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

/** Which roster entries the scoreboard shows, and in what order.
 *
 *  EVERY player is listed, not just the local team — naming the opposition
 *  (and the AI) is the point of a scoreboard, and the underlying score_* keys
 *  are gameRulesParams, global by construction, so there is nothing to leak.
 *  Ordered by team then playerNum so allies read as a block.
 *
 *  Spectators are dropped: they earn and spend nothing, so a row of zeroes for
 *  each would only crowd out the players.
 *
 *  `identity` is the local `ctx.identity` — its `playerId` is the sim
 *  playerNum, the same space roster `playerId`s live in (PLAN-native-ui §3.3).
 */
export function scoreboardRoster(roster, identity = {}) {
  return (roster ?? [])
    .filter((p) => p && p.playerId !== undefined && !p.isSpectator)
    .map((p) => ({
      playerId: p.playerId,
      teamId: p.teamId,
      // A nameless entry still gets a stable handle rather than a blank cell.
      name: p.name || `P${p.playerId}`,
      isAI: Boolean(p.isAI),
      isSelf: p.playerId === identity.playerId,
      isOwnTeam: p.teamId === identity.teamId,
    }))
    .sort((a, b) => (a.teamId ?? -1) - (b.teamId ?? -1) || a.playerId - b.playerId);
}
