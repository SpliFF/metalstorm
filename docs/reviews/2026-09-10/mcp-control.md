# mcp-control — review report (lane 7, 2026-09-10)

## STATUS
in-progress: review fixes in server.js committed; next = new world/ai/nl tool modules, self-check, docs/mcp-tools.md generator.

Scope: `tools/debug-mcp/**`, `docs/mcp-tools.md` (new), the MCP section of
`docs/debugging-tools.md`. Branch `worktree-agent-a342a8e190187a5d5`.

Baseline (before any edit): `cd tools/debug-mcp && node --test` → 217 tests,
210 pass / 7 fail. All 7 failures are environmental in this worktree — they
need a baked `data/games/metalstorm/cache/defs/*/unitdefs.lua.br` and the
`green_flat_x34_v3` region graph, neither of which is committed (scenario-
validate.test.js: "no unitdefs.lua.br — bake defs by running a game once").
Same 7 fail on `main`'s tip in a fresh worktree; not touched by this lane.

## Findings (ranked)

1. **HIGH — `end_game`/`kill_game` on a hibernated room signalled pid 0 = the
   MCP's own process group.** `resolveRoomTargetStrict` accepted a row with
   `pid: 0` (a hibernated room) and `endProcess(0)` ran `process.kill(0,
   'SIGTERM')`, which signals every process in the caller's group — under
   mprocs that is the whole dev pane. FIXED: `endProcess` refuses `pid <= 1`,
   `resolveRoomTargetStrict` refuses rows without a process (server.js).
2. **HIGH — "roomId is a port": an ENDED room's row routed queries to whichever
   live server now held its port.** `getGameServerUrl(7)` returned the stale
   row's `:9100`; room 8 had since bound 9100, so `exec_lua({roomId:7})`
   answered from room 8 with no error (memory: project_springdebug_roomid_is_a_port).
   FIXED: new pure `room-target.js` (`pickServer`) refuses ended / hibernated /
   dead-pid rows for an explicit `roomId`, names the squatter room, and tells a
   caller who passed a port number that it passed a port. Auto-pick (no
   roomId) skips dead rows. 8 tests.
3. **HIGH — no network call had a deadline.** login/register/faction lookup,
   `/api/processes`, `/api/exec`, the log server, `/api/rooms/direct`,
   `/api/client/eval`, `launch_game`'s five POSTs — none carried an
   `AbortSignal`; a lobby that accepts and never answers hung the MCP handler
   for ever. FIXED: module-level `fetch` wrapper stamps a 15 s default
   (`SPRING_MCP_HTTP_TIMEOUT_MS`), exec gets 60 s (`SPRING_MCP_EXEC_TIMEOUT_MS`),
   the relay gets `timeoutMs + 5 s`, `api_request` gains `timeoutMs` (default
   30 s, clamp 0.5–300 s).
4. **MEDIUM — `generate_scenario` silently dropped five schema-declared knobs.**
   The handler forwarded a hand-kept list (`seed … roster`) that predated
   `works`, `harbour`, `shanty`, `coverage`, `player`; those validated fine and
   never reached the POST (the "whitelist emitter drops new keys" trap).
   FIXED: the forwarded set is derived from the schema.
5. **MEDIUM — schema/handler drift on the relay tools.** `spawn_at_camera`,
   `browser_test`, `evaluate_widget_lua` read `args.roomId`/`args.clientId`
   that their schemas did not declare (so a caller could not target a room, and
   `tool-args.js`'s near-miss check could not protect the names). `capture_subject`
   reads `syncPresentation`, `capture_sequence`/`order_and_film` read `settleMs`
   and `format` — undeclared. FIXED in `tools.js`; guarded by `self-check.mjs`.
6. **MEDIUM — `api_request` required `path` even for `target:"url"`** (whose
   description says path is ignored), so an absolute-URL request was refused by
   validation. FIXED: `path` is required by the handler for lobby/log/game only
   and must start with `/`.
7. **MEDIUM — session tokens echoed into the transcript.** `launch_scenario` and
   `launch_direct` returned the raw `sessions: {user: <bearer>}` map. FIXED:
   redacted unless `revealTokens:true` (`redact.js`); `browserUrl` keeps its
   hash token because it is the attach mechanism (documented).
8. **MEDIUM — `/api/rooms/direct` session-row loss went unreported.** Memory
   trap: the route can answer with tokens it then drops, and the browser
   attach fails auth 40 minutes later. FIXED: both launchers verify each token
   against the `sessions` table (read-only, feature-detected) and push a
   WARNING note naming the users whose rows are missing.
9. **LOW — unbounded log reads.** `get_logs`/`search_logs` deferred to the log
   server's default when `limit` was omitted and accepted any size; a
   `search_logs` with no query and no scope was "the whole log". FIXED: limit
   clamped to [1, 1000] (default 50), scope-less search refused.
10. **LOW — verb strings built by template.** `spawn ${defName} …` etc. forwarded
    whitespace/NaN straight into the exec verb (not a shell, but an extra token
    shifts every positional field). FIXED: `verb-args.js` validates each token
    by name (5 tests) for spawn/kill/damage/order/clear/unit_state/revive/
    stockpile/speed/invulnerable.
11. **LOW — stale ZK defaults.** `launch_game` defaulted `gameId` to `zk`
    (archived); examples named `armcom1`/`papertanks`. FIXED: default
    `metalstorm`, examples updated; `testStartupSelector` kept (public arg
    name) but documented as ZK-only/no-op for Metalstorm.
12. **INFO — `list_gadgets` builds Lua by string; `pgrep -f` patterns.** Both
    reviewed: `pgrepPids` filters `process.pid` and uses `execFile` (no shell,
    so the "matches its own zsh wrapper" trap does not apply); every shell-out
    is an argument array. No `pkill -f`. No WebRTC/BAR references remain in
    server.js beyond the one ZK widget comment.

## Changes

- `tools/debug-mcp/tools.js` (NEW): the `TOOLS` catalogue moved out of
  server.js so scripts can import schemas without booting a stdio server.
- `tools/debug-mcp/room-target.js` + test, `verb-args.js` + test,
  `redact.js` + test (all pure).
- `tools/debug-mcp/server.js`: findings 1–11; dispatch to module-hosted
  handlers with an injected `toolIo` (fetch/authedFetch/execLua/resolveServer).

## Proposed C++ patches (UNCOMPILED)

(none yet)

## Out-of-lane findings

(see below as they accrue)

## Assumptions / decisions

- Session-token redaction is a behaviour change on a documented return field;
  `revealTokens:true` restores the old output. `browserUrl` deliberately keeps
  its `#token=` fragment.

## Next milestones

(filled in at the end)
