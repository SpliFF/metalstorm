# mcp-control — review report (lane 7, 2026-09-10)

## STATUS

complete. Landed in the first session: all server.js review fixes (findings
1–11), the TOOLS split, and the tested building blocks (guidance wire encoder,
SSE parser, fengari-tested Lua snippets). Landed in the 2026-09-17 session: the
whole not-done queue below — the `world_*` / `ai_*` / `nl_command` handler
bodies, `self-check.mjs`, `gen-docs.mjs` + `tool-meta.js` → `docs/mcp-tools.md`,
and the `docs/debugging-tools.md` MCP-section refresh.

### Not done (CLOSED 2026-09-17 — kept for the record of what each item was)

1. ✅ `world-tools.js`: 9 tools — `world_status` (clock / pois / stats /
   factions / all), `world_pois`, `world_factions` (list / me / found / join /
   leave), `world_claims` (list / file / withdraw), **`world_commit`** and
   `world_commit_cancel` (staging commit/cancel — the out-of-lane ask from
   world-design, "drive the world loop without curl", is this pair),
   `world_seasons`, `world_pause`, `world_notifications` (chat ticket → SSE for
   a bounded `listenMs`, `world-staging`/`world-poi`/`world-season`; the ticket
   is a credential and is never echoed back). Every documented error code is
   mapped to a sentence in `WORLD_ERROR_HELP`, including the codes the
   2026-09-16 build added (`window_closed`, `no_side`, `same_side`,
   `too_much_force`) and `claims/file`'s now-403 `insufficient_authority`.
   25 tests against a fake `io`.
2. ✅ `ai-tools.js`: `ai_list` / `ai_health` / `ai_directives` / `ai_context`
   (reads, via the fengari-tested snippets) and `ai_guidance` (the one write,
   encoded with `encodeGuidance` and delivered through
   `gadgetHandler:RecvLuaMsg`; `applied:false` reports a gadget REJECTION
   rather than reading as success). 11 tests, driven by `fakeExecLua()` so the
   snippets really run.
3. ✅ `nl-tools.js`: `nl_command` → `POST <game>/api/nl/command`, context built
   from `nlContextLua(team)` when not supplied, the server's own caps (500-char
   utterance, 4 history entries, 16 KB body) mirrored locally so a refusal names
   the field, every documented refusal code explained. Envelope only —
   execution stays client-side. 13 tests. **The out-of-lane ask stands:** there
   is still no `window.test.nl(utterance)` hook, so an utterance cannot be
   executed in a live client from here.
4. ✅ `self-check.mjs` (`npm run check`, and `self-check.test.js` so
   `make test-debug-mcp` enforces it): diffs each tool's `inputSchema` against
   the `args.<name>` reads in its `case` block or module handler, plus the
   helper modules that receive `args` whole. Both directions. Three subtleties
   it had to grow: a shared `case 'a': case 'b':` body reads the UNION of its
   labels' schemas; a schema-derived forward (`args[k]`) is unfollowable by a
   text scan and suppresses the declared-but-unread warning; and the block
   scanner must skip REGEX LITERALS, because `evaluate_widget_lua` contains a
   `replace()` whose regex holds a BACKTICK — read naively that opens a
   template literal and runs the scan on into the next tool, charging it with
   the neighbour's arguments. 9 tests.
   Current state: 77 tools, 0 errors, 0 warnings.
5. ✅ `gen-docs.mjs` + `tool-meta.js` → `docs/mcp-tools.md` (generated, 13
   sections, banner-marked do-not-edit; `npm run docs`, `--check` verifies
   freshness and a test asserts it). `tool-meta.js` is asserted to be a TOTAL
   PARTITION of `TOOLS`, so a new tool cannot be added without deciding where it
   belongs. `docs/debugging-tools.md`'s MCP section gained the four
   cross-cutting rules (deadlines, `roomId`-is-not-a-port, token redaction,
   schema/handler drift) and rows for all 15 new tools; `docs/debugging.md`
   lists the new page.

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

- `guidance-wire.js` + test: the RecvLuaMsg codec in JS, pinned byte-for-byte
  against `parley/tests/wire-fixtures.tsv` (the same fixture the TS and Lua
  suites use), plus `encodeGuidance` (op → gadget field names).
- `sse.js` + test: incremental SSE parser for the chat-channel notifications.
- `lua-snippets.js` + `lua-fake-env.js` + test: the synced-Lua programs for
  ai_list / ai_health / ai_directives / ai_guidance / nl context, each
  returning JSON via an in-snippet encoder, run under fengari against a fake
  `Spring` (roster, rulesParams, GetDirectives/GetOrgGroups, gadgetHandler).
  Documents the rulesParam names ai_health feature-detects; there is no
  `ai_health` param in the tree.


### 2026-09-17 session

- `world-tools.js` (9 tools), `ai-tools.js` (5), `nl-tools.js` (1) — handler
  bodies, thin over the real routes, `(args, io)` throughout so every one is
  driven in test by a fake.
- `tool-io-fake.js` (NEW): the test-side twin of server.js's `toolIo` — routes
  keyed `METHOD /path`, calls recorded, a fixed bearer so a test can assert the
  Authorization header, and an SSE-shaped streaming response.
- `world-tools.test.js` (25), `ai-tools.test.js` (11), `nl-tools.test.js` (13),
  `self-check.test.js` (9), `gen-docs.test.js` (7).
- `self-check.mjs` + `tool-meta.js` + `gen-docs.mjs`; `npm run check`,
  `npm run docs`, `npm test` added to package.json.
- `docs/mcp-tools.md` (NEW, generated), `docs/debugging-tools.md` MCP section,
  `docs/debugging.md` sub-page index.

## Proposed C++ patches (UNCOMPILED)

None.

## Out-of-lane findings

- client/src/native-widgets/command-console.js: no programmatic entry to run
  an utterance through the live console (`runUtteranceText` is file-local),
  so an MCP `nl_command` can only fetch the envelope, never execute it in the
  client. Suggest exposing `window.test.nl(utterance)` in the TestHarness
  (lane 10 / lane 9).
- The 7 baseline-failing debug-mcp tests depend on uncommitted bake output
  (`cache/defs/*/unitdefs.lua.br`, `green_flat_x34_v3` region graph); they
  should `t.skip` when the artefacts are absent (scenario-validate.test.js).

## Assumptions / decisions

- Session-token redaction is a behaviour change on a documented return field;
  `revealTokens:true` restores the old output. `browserUrl` deliberately keeps
  its `#token=` fragment.

## Next milestones

None in this lane. Two open threads, both belonging to other lanes:

- **`window.test.nl(utterance)`** — no programmatic entry to run an utterance
  through the live console (`runUtteranceText` in
  `client/src/native-widgets/command-console.js` is file-local), so `nl_command`
  can only ever fetch the envelope. Lane 10 / lane 9.
- **The 7 baseline-failing tests** (`scenario-validate.test.js`) still depend on
  uncommitted bake output (`cache/defs/*/unitdefs.lua.br`, the
  `green_flat_x34_v3` region graph) and should `t.skip` when the artefacts are
  absent. Unchanged by this lane: 248 tests / 241 pass before, 313 tests / 306
  pass after — the same 7, for the same reason.
