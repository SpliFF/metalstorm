# SQL Proxy, Process Management, Claude/MCP, springcli & mprocs

Part of the [Debugging & Logging Guide](debugging.md) family. This page covers the lobby's read-only SQL proxy, process management, the Claude/MCP integration (`tools/debug-mcp`), the standalone `springcli` CLI, and the `mprocs` development environment.

## Table of Contents

- [SQL Query Proxy](#sql-query-proxy)
- [Process Management](#process-management)
  - [Stack census (`list_stack` / `cleanup_stack`)](#stack-census-list_stack--cleanup_stack)
- [Claude / MCP Integration](#claude--mcp-integration)
  - [MCP Server Setup](#mcp-server-setup)
  - [Available Tools](#available-tools)
  - [Reliable live game-drive verification](#reliable-live-game-drive-verification)
- [Headless Run Mode](#headless-run-mode)
  - [`--headless-run` config](#--headless-run-config)
  - [Stats dump + determinism hash](#stats-dump--determinism-hash)
  - [Batch driver (`tools/headless-batch`)](#batch-driver-toolsheadless-batch)
  - [Soak ladders + growth report](#soak-ladders--growth-report-growth-reportmjs)
  - [Determinism CI hook](#determinism-ci-hook)
  - [Fixture-replay verify CI hook](#fixture-replay-verify-ci-hook)
- [Scripted wire client (`client/wire`)](#scripted-wire-client-clientwire)
- [Replay record / playback](#replay-record--playback)
  - [Recording](#recording)
  - [Exporting a shareable `.msr` (`--replay-export`)](#exporting-a-shareable-msr---replay-export)
  - [Playing back](#playing-back)
  - [Verifying (`--verify`)](#verifying---verify)
  - [Seeking](#seeking)
  - [What a replay does and does not carry](#what-a-replay-does-and-does-not-carry)
- [Snapshot round-trip (`--snapshot-roundtrip`)](#snapshot-round-trip---snapshot-roundtrip)
  - [Resuming across a balance patch](#resuming-across-a-balance-patch-gamedatamigrationslua)
  - [The two-def-load harness](#the-two-def-load-harness-toolsscriptsdef-reconcile-resumesh)
- [springcli — Command-Line Tool](#springcli--command-line-tool)
  - [Building](#building)
  - [Commands](#commands)
  - [Environment Variables](#environment-variables)
  - [Flags](#flags)
  - [Exit Codes](#exit-codes)
  - [HTTP Exec API](#http-exec-api)
  - [libspringapi](#libspringapi)
- [mprocs Development Environment](#mprocs-development-environment)

---

## SQL Query Proxy

The lobby handles `ConsoleCommand` messages with scope `"sql"`, executing read-only SQL queries against the game database (`spring-server.db`).

From the debug console (scope `sql`):

```
sql> SELECT id, username, role FROM users
  id=1 | username=alice | role=admin
  id=2 | username=bob | role=player

sql> SELECT COUNT(*) FROM maps
  COUNT(*)=5
```

**Safety:** The proxy rejects queries containing `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, or `CREATE` (case-insensitive keyword check). Only `SELECT` and other read-only statements are allowed.

---

## Process Management

**HTTP API** (served by the lobby):

```
GET /api/processes
```

Returns a JSON array of all game server instances:

```json
[
  {
    "room_id": 1,
    "port": 9101,
    "pid": 12345,
    "state": "running",
    "map": "content/maps/wanderlust2.1",
    "game": "content/games/papertanks"
  }
]
```

States: `starting`, `running`, `ended`, `crashed`, `hibernated`
(`GameServerInstance::State` — `rts/lobby_main.cpp:1915-1931`; same list as
[api.md](api.md#processes)). `hibernated` is a war frozen to disk, not a failure.

**Two authorities, and they disagree on purpose.** The lobby's process row above
is *what the lobby spawned*; `game_status` (SQLite, `rts/Server/GameServersDb.cpp`)
is *what the server itself last reported* — `room_id, ready, client_count, pid,
port, updated_at` (`GameServersDb.cpp:61-68`), rewritten on a heartbeat; the
game server is its only writer. A row whose `updated_at` has
gone stale means the server stopped reporting, whatever the process row says; a
room with no row at all (hibernated, never-started) reads as `null`, not `0`.
`probe_game` composes both plus `/api/metrics` — prefer it over reading either.

**Console commands** (scope `lobby`):

```
lobby> process list
  Room 1: pid=12345 port=9101
```

**Restart resilience:** The lobby writes spawned game server info to a `game_servers` SQLite table. On startup, stale entries from a previous run are cleaned up. This table is the foundation for re-adopting orphaned game servers after a lobby restart (not yet fully wired).

### Stack census (`list_stack` / `cleanup_stack`)

`GET /api/processes` only knows about servers the **lobby** launched. Everything
else — a hand-launched headless run, a leftover listener squatting a game port,
a second lobby, a Vite that fell back to `:8013` — is invisible to it, and used
to be hunted by hand with `pgrep`/`lsof`. The two MCP tools answer that in one
call.

**`list_stack {probeHashes?}`** → `{findings, processes, ports, authority,
gameStatus, binaries, mprocs, summary}`. Read-only. Each finding is
`{kind, severity, pid?, port?, roomId?, cmd?, detail, suggestedAction}`:

| kind | meaning | severity |
|---|---|---|
| `managed` | the lobby owns it, or it is the `:8011` lobby / `:8010` logserver / `:8012` vite | info |
| `stray-server` | a `spring-server` pid the lobby does not list — e.g. a hand-launched `--headless-run` | warning |
| `zombie-port` | a listener on 9100–10099 that is not a managed game server. Room routing is **by port**, so a squatter makes the lobby's next room unreachable | error |
| `duplicate-lobby` | more than one `spring-lobby`; `SO_REUSEPORT` round-robins accepts, so the extras answer real requests | error |
| `orphan-vite` | a vite not on `:8012`. The client bakes the lobby port at **build** time, so a browser pointed at the fallback silently drives the wrong stack | warning |
| `stale-status-row` | a `game_status` row naming a dead pid — **report-only**, never deleted (spring-server owns that row) | warning |
| `binary-drift` | the lobby forks `build/release/spring-server` when it exists, so a **debug-only rebuild is invisible** in a lobby-driven arm | warning |
| `stale-binary-running` | a running server's `/api/metrics` → `identity.engineHash` ≠ the on-disk binary's (`probeHashes` only). "The process you are testing is not the binary you just built" | warning / info |

`authority.source` is `lobby` \| `sqlite` \| `none`. **When it is `none`, every
game server looks unmanaged** — so `stray-server` findings drop to `info` and
`cleanup_stack` refuses them outright.

`binaries` reports `picked` (release if present, else debug — the rule from
`lobby_main.cpp`), `drift`, and per-flavour `{mtime, size, engineHash}`.
`probeHashes:true` fills `engineHash` via `spring-server --print-engine-hash`
and reads `identity` from every live server (adds ~1 s).

`mprocs` is `{ctlPort, reachable}` from an **lsof LISTEN check only** — never a
connection. mprocs deserializes whatever an accepted connection carries, so a
bare connect+close can take it down (see `tools/scripts/spring-services.sh`).

**`cleanup_stack {dryRun=true, kinds?, force?}`** kills only
`stray-server` / `zombie-port` / `orphan-vite` / `duplicate-lobby`, SIGTERM →
poll 5 s → SIGKILL (SIGTERM is what gives spring-server its exit checkpoint).
`dryRun` defaults to **true** and returns the exact plan. Invariants:

- the pid holding `:8011` is **never** killed, whatever its classification;
- `managed` is never touched — to stop a real game use `end_game({roomId})`,
  which drains gracefully;
- `stale-status-row` is report-only (a third writer on that table is a race,
  and the row deliberately outlives the process for kill-and-resume);
- a `zombie-port` pid whose command is not `spring-server` needs `force:true`
  (the 9100–10099 range can catch unrelated dev tools).

```
list_stack {probeHashes:true}   → "1 stray-server, 1 binary-drift"
cleanup_stack {}                → plan: pid 14932 stray-server, SIGTERM → poll 5s → SIGKILL
cleanup_stack {dryRun:false}    → {outcome:"killed", signal:"SIGKILL", waitedMs:5122}
```

**Engine identity.** The game server's public `GET :port/api/metrics` carries
`identity: {stamp, engineHash, pid}` — `engineHash` is the same 16-hex value
`spring-server --print-engine-hash` prints for the binary on disk, so the two
are directly comparable. It is **not** compiled out under `SPRING_PROD`: the
stamp is already public via the lobby's `/api/version` and the hash is a pure
function of it.

---

## Claude / MCP Integration

The MCP server (`tools/debug-mcp/server.js`) lets Claude query logs, execute commands, read source files, and manage game servers.

### MCP Server Setup

```bash
cd tools/debug-mcp
npm install
```

Configure in `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "spring-debug": {
      "command": "node",
      "args": ["tools/debug-mcp/server.js"],
      "env": {
        "LOG_SERVER_URL": "http://localhost:8010",
        "LOBBY_URL": "http://localhost:8011"
      }
    }
  }
}
```

**Node-version mismatch is self-diagnosing.** `better-sqlite3`'s native binding
is built for ONE node ABI (`npm rebuild better-sqlite3` under the node that runs
the MCP — plain `node` here, i.e. the nvm default alias). Run under a different
node major, the binding fails to load *lazily* — the import succeeds, every
`new Database(...)` throws — which used to degrade silently (empty process
lists, `gameStatus {available:false}`, `probe_game` stuck at `spawning`,
`query_db` errors that read as code bugs). The server now probes the binding
once at boot: on a `NODE_MODULE_VERSION`/`ERR_DLOPEN_FAILED`-class failure it
writes one `[spring-debug-mcp] SQLITE DISABLED: …` line to stderr naming the
running node, the module's built-for ABI and the rebuild command, and every
SQLite-backed tool result carries `sqliteUnavailable: "<reason>"` instead of
pretending tables are empty. A *missing DB file* is deliberately not this
condition and keeps the ordinary per-tool error paths.

### Available Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_logs` | `roomId`, `game`, `level`, `section`, `scope`, `sinceMinutes`, `limit` | Fetch recent log entries; `roomId` scopes to one game instance |
| `search_logs` | `query`, `roomId`, `game`, `section`, `level`, `sinceMinutes`, `limit` | Search logs; scope with `roomId`/`game`/`sinceMinutes` to avoid a flood of history |
| `exec_lua` | `scope`, `code`, `roomId` | Execute Lua code in a specific scope. With `scope:"server"`, a leading `json ` token asks the converted verbs for a JSON object instead of free text — see [structured server verbs](#structured-server-verbs-json-prefix) |
| `get_game_state` | `roomId` | Sim state as an object: `{frame, paused, speed, teams, units, luaHeapKb}` (`luaHeapKb` is 0 when LuaRules is not loaded). Falls back to the legacy `frame=N teams=N units=N` text on a pre-`json ` game server |
| `list_units` | `team`, `roomId` | Units as `{total, returned, units:[{id, def, team, hp, maxHp, x, y, z}]}`. `total` counts every match of the team filter (the legacy text reports the *unfiltered* active count); `units` is capped at 100 rows. Falls back to legacy text on a pre-`json ` game server |
| `list_processes` | | Game servers as JSON: `{servers:[{roomId, port, pid, state, gameId, mapId, ready, clientCount, heartbeatAgeSec, heartbeatStale, identity}], count}`. Discovery is the lobby `/api/processes` with a SQLite fallback; `ready`/`clientCount`/heartbeat are left-joined from `game_status` (`null` when the room has no row — e.g. hibernated) and `identity` is `{stamp, engineHash, pid}` read from each server's `/api/metrics` (`null` on a server built before P8, or one that didn't answer in 1.5 s). Still returns the literal string `No game server processes found.` when there are none |
| `list_stack` | `probeHashes` (default `false`) | **Full-stack census in one call** — replaces ad-hoc `pgrep`/`lsof` hunts. Returns `{findings, processes, ports, authority, gameStatus, binaries, mprocs, summary}`. See [stack census](#stack-census-list_stack--cleanup_stack) |
| `cleanup_stack` | `dryRun` (default **`true`**), `kinds`, `force` (default `false`) | Kill what `list_stack` classified as *not* managed. Dry-run first by default; see [stack census](#stack-census-list_stack--cleanup_stack) |
| `get_lua_source` | `gameId`, `filePath` | Read a Lua source file from disk (`data/games/<gameId>/<filePath>`) |
| `list_gadgets` | `roomId` | List loaded Lua gadgets |
| `query_db` | `query` (the only param — the database is fixed by the server's `SPRING_DB`) | SQL query against the lobby database — only **row-returning** statements are accepted (SELECT, `WITH … SELECT`, EXPLAIN, PRAGMA reads); the check is better-sqlite3's `stmt.reader`, so a write hidden behind a CTE or a comment is rejected too. Answers `Error: sqliteUnavailable: …` (with the rebuild command) when the native binding failed the boot self-check |
| `list_sessions` | | List recent game sessions |
| `get_frame` | `roomId` | Current sim `frame` + `simFps` + `clients` via the public `GET :port/api/metrics`. No exec, no auth — answers while the sim is paused, pre-`GameStart`, or the exec queue is wedged, and survives `SPRING_PROD` (where `/api/exec` is compiled out) |
| `end_game` | `roomId` (required), `graceful` (default `true`), `timeoutMs` (default `10000`), `escalate` (default `true`) | Graceful teardown of **one** room. SIGTERM is what gives the server a clean loop exit, war-log drain and **exit checkpoint** (the only site where a world becomes resumable); SIGKILL skips all of it. Prefers the lobby's [`POST /api/admin/rooms/end`](api.md#post-apiadminroomsend), which returns a drain-quality report — the exit checkpoint verified against the snapshot store — as `{source:'/api/admin/rooms/end', roomId, pid, kind, exited, escalated, waitedMs, outcome, frame, label, lossy, resume_eligibility, engine_hash, describe}`. `timeoutMs` is clamped server-side to [100, 30000]. A **route-level 404** (a lobby binary predating that endpoint) falls back to SIGTERM/poll/SIGKILL from the MCP process, reported as `source:'sigterm-fallback'` with no checkpoint verification; a 400/401/403 is reported as an error and **never** downgraded to a local kill, and the route's own `unknown roomId` 404 is reported as-is rather than guessing a pid. **The room does not read "ended" in the response** — the lobby health loop flips it a moment later (poll `/api/rooms` or `probe_game`). To stop a room cleanly *with* a report use this, not a same-name `launch_direct` relaunch (that SIGTERMs, deletes and respawns) |
| `probe_game` | `roomId` (auto-picks the newest non-ended game if omitted) | One-shot readiness probe. Composes the lobby process row, pid liveness, the `game_status` heartbeat and `/api/metrics` into one phase: `spawning` (process up, nothing published) → `loading` (heartbeat present but `ready=0` or >10 s stale) → `ready` (accepting connections) → `ticking` (sim advancing), or `dead`. Returns `{phase, roomId, pid, port, ready, clientCount, statusAgeSec, frame, simFps, detail}` — every key always present, `null` when unknown. Pid liveness is checked **before** the status row, so a leftover row from a SIGKILLed server can never report a dead game as ready. Two loud-failure annotations (never phase changes): `sqliteUnavailable` when the better-sqlite3 binding failed the boot self-check, `warning` when the lobby reports the server but a readable `game_status` has no row (`SPRING_DB` ≠ lobby `--db` signature — see [readiness phases](#reliable-live-game-drive-verification) above) |
| `wait_for_game` | `roomId`, `until` (`ready`\|`ticking`\|`frame`, default `ready`), `frame`, `timeoutMs` (default `120000`), `pollMs` (default `500`) | Poll `probe_game` until the target phase/frame. **Fails fast on death**: a `dead` probe returns immediately with `lastLogs` (last 15 room-scoped lines) instead of burning the timeout. A timeout returns `{timedOut: true, probe, lastLogs}` rather than throwing, so you can see *how far* the server got. `until:'ready'` is satisfied by `ready` or `ticking`. Warns when the target is met with `clientCount === 0` (the server idle-exits unless a client connects). `roomId` is resolved once and pinned — a relaunched different room can never satisfy the wait |
| `launch_scenario` | `scenarioId` (required), `gameId` (default `metalstorm`), `mapId`, `ai` (default `null`), `players`, `side`, `modoptions`, `roomName` (default `mcp:<scenarioId>`), `headless`, `wait` (`none`\|`ready`\|`ticking`, default `ticking`), `waitTimeoutMs`, `idleGraceSeconds`, `skipBriefing`, `force` | **Scenario-first launch — no lobby UI, no manifest file, no login.** Resolves the scenario via `GET /api/games/<gameId>/scenarios`, builds the `/api/rooms/direct` manifest in memory with the scenario as the **top-level** field (a `modoptions.scenario` is hoisted out — as a modoption it is silently overwritten by the map default), POSTs it, then waits on `probe_game`. Host takes the scenario's first playable side; every other playable side gets an AI slot on its own team (`ai:''` = none). Returns `{roomId, port, roomName, sessions, browserUrl, scenario, phase, frame, notes}` (+ `lastLogs` on death/timeout). `browserUrl` **attaches** to the room just launched (`?play=…&room=<id>#token=…`) and never re-launches it. Re-POSTing the same `roomName` tears down the previous room — two calls on one scenario replace, they do not accumulate. Needs the lobby run with `--dev-direct-start`; a not-yet-listed scenario file needs `POST /api/admin/scenarios/resync` or `force:true` (+ `mapId`) |
| `launch_direct` | `manifestName` and/or `manifest` (one required), `overrides`, `wait` (`none`\|`ready`\|`ticking`, default `ticking`), `timeoutMs` (default `120000`), `clearCache`, `idleGraceSeconds` | **Raw-manifest launch** — the manual sibling of `launch_scenario` (which synthesises its manifest from a `scenarioId`; prefer that for anything scenario-shaped, and this one for full control: custom rosters, modoptions, `sessionKind`, idle timers). Loads `manifests/<manifestName>.json`, applies `manifest` **deep-merged** on top (objects recurse; **arrays and scalars replace wholesale**), then `overrides` **shallow-merged** last (top-level keys replaced entirely — the escape hatch for swapping a whole `players[]`), POSTs to `/api/rooms/direct`, waits on `probe_game`. A `manifestName` miss lists every available name. Returns `{roomId, port, roomName, sessions, players, aiSlots, browserUrl, browserHint, phase, frame, notes}` (+ `lastLogs` on death/timeout). `browserUrl` is the bare client — attach by logging in as a `sessions` username; it is deliberately **not** the `?direct=<name>` form, which re-POSTs from `client/public/` and would tear down the room just launched. `name` is **idempotent by replacement**: re-POSTing a name SIGTERMs that room's server and recreates it (a clean restart, not an error), and a manifest with no `name` launches as the shared `"dev:direct"`, so two unnamed launches clobber each other — concurrent lanes must set distinct names (`dev:<lane>-<purpose>`). `idleGraceSeconds` is sugar for `manifest.idleStartupGraceSeconds` (see [api.md](api.md#direct-start-devtest-only)) — raise it for browserless runs or the server self-exits at 120 s. **Trap:** a skirmish holds `GameStart` until its rostered humans connect, so `wait:'ticking'` on a human roster with no browser times out by design — use `wait:'ready'`, an AI-only/spectator roster, or `sessionKind:'persistent'`. Needs the lobby run with `--dev-direct-start` (a 404 from the tool says exactly this) |
| `validate_scenario` | `gameId` (default `metalstorm`), `scenarioId` **or** `luaSource`, `passability` (default `false`) | **Offline** structured validation — replicates BOTH parsers (the lobby's bare-`lua_State` discovery pass *and* `game_scenario.lua`'s GameStart `validate()`) without booting anything and **without a running lobby**. Returns `{ok, file, map, defsSource, findings[], counts}`; each finding is `{severity, rule, path, message}` with severity `error`\|`warning`\|`info`\|`skipped` and `path` a schema pointer (`units[3].orders[1]`). Zero errors ⇒ the lobby will offer it and the in-game validator will pass it, modulo the live-only checks reported as `skipped`. **`skipped` means NOT CHECKED, never "fine"** — no baked def cache ⇒ every unknown-def rule was skipped. `passability:true` additionally runs `regions_from_map.py --verify` (read-only, slow). Rule ids: [scenarios.md §11](scenarios.md#11-validation-rule-reference) |
| `write_scenario` | `gameId`, `scenarioId` (required), `luaSource` (required), `resync` (default `true`), `overwrite` (default `false`), `force` (default `false`) | Validate → write `data/games/<gameId>/scenarios/<id>.lua` (temp-file + rename) → resync the lobby → **confirm** the scenario is now offered. Error findings always block; warnings block unless `force:true`. Refuses the `gen_` prefix in two places: the scenario DB owns that namespace and its orphan sweep **deletes** any `gen_*.lua` no row claims, so such a file would vanish on the next resync. Returns `{written, file, counts, findings, resync, offered, notes}` — believe `offered:false`, it is the lobby saying it declined the file. Without the resync the lobby picker and `launch_scenario` cannot see the file at all (scenario lists are a startup snapshot); direct/headless boots read the VFS fresh and work immediately |
| `list_scenarios` | `gameId` (default `metalstorm`) | Merges the public discovery view (id, displayName, map, tutorial/retired, `terminal`, playable sides, briefing) with the admin provenance view for generated wars (seed, params, generatorVersion, createdBy/At). Rows are tagged `source: "authored"\|"generated"`. A stored row the lobby did **not** discover is surfaced explicitly — that means the materialised file failed to parse. Degrades to the public view alone (with a note) when the admin call is refused |
| `generate_scenario` | `gameId`, `mapId` (required), `seed`, `sides`, `towns`, `outposts`, `bases`, `mines`, `sites`, `relics`, `wrecks`, `bridges`, `hostility`, `roster` | Generate a war with `scenariogen.py` via the lobby admin route, store it, materialise it to `gen_*.lua` and re-discover it. `seed` defaults **server-side** to `sum(ord(c) for c in mapId)`, so re-running with no seed is an idempotent upsert of the same war rather than a new one. A map that cannot host a war answers 422 with the generator's own `REJECTED` line naming the violated invariant — surfaced verbatim. Int knobs are range-clamped by the lobby (`sides` 2-8, the rest 0-32) |
| `launch_game`, `kill_game`, `restart_lobby`, `restart_logserver`, `restart_game`, `restart_client` | see `.claude/skills/spring-debug` | Service lifecycle management (`restart_client` = Vite pane via mprocs control channel). `launch_game` waits on `probe_game` (not the lobby's room state) and returns the readiness `phase`; on failure it adds `lastLogs` and returns as soon as the server dies instead of waiting out 120 s. **`kill_game` is deprecated** — it is now an alias for `end_game(graceful:false)` and, like `end_game`, **requires `roomId`**: called bare it refuses and lists candidate rooms instead of SIGKILLing whichever game it found first |
| `spawn_unit`, `kill_unit`, `damage_unit`, `give_order`, `clear_units`, `get_unit_state`, `set_debug_logging`, `get_combat_summary`, `pause_sim`, `set_sim_speed`, `revive_team`, `set_stockpile`, `profile` | see `.claude/skills/spring-test` | Scripted test verbs (server-side). `revive_team {team?}` flips dead teams alive again (pair with `set_cheats`); `set_stockpile {unitId, count, queued?}` insta-fills a stockpile weapon; `profile {target: lua\|sim, action: on\|off\|reset\|status\|report, topN?}` drives the two server-side profilers (`sim` results also surface under `/api/metrics` → `simFrame`). Three of these return **objects**, not text: `spawn_unit` → `{spawned, ids[]}`, `get_unit_state` → `{id, def, team, hp, maxHp, pos:{x,y,z}, heading, weapons[]}`, `get_combat_summary` → `{combat, sounds}` — see [structured server verbs](#structured-server-verbs-json-prefix) |
| `client_eval` | `code` (required), `target` (`js`\|`worker`\|`widgets`\|`test`, default `js`), `roomId`, `clientId`, `timeoutMs` (default `10000`, clamped 500–60000) | Run code **inside a connected browser** and get the result back, over [`POST /api/client/eval`](api.md#browser-eval-relay). Targets: `js` = main-thread globals (`document`, `window.test`, `window.lobby`); `worker` = render-worker globals (`__entityRenderer`, `__csm`, `__renderPipeline`, `__fxLightPool` — the hooks the render-core move stranded there); `widgets` = Lua in the in-worker LuaUI runtime; `test` = an expression with the `window.test` harness's members in scope (`readyState()`, `captureFrame({maxDim:640})`). `output` is JSON-parsed when it parses. See the three gates + the deadlock warning below |
| `client_ready` | `roomId`, `clientId` | The **browser's** readiness (`window.test.readyState()`): renderer up, defs ingested, LuaUI booted, newest game frame, feed age. Different question from `wait_for_game`, which is server-side — a game can be server-ready while the tab is still ingesting defs |
| `client_screenshot` | `maxDim` (default `1280`, clamped 64–2048), `quality`, `roomId`, `clientId` | Relays `window.test.captureFrame({maxDim, stats:true})` and returns a real **MCP image content block** (a Claude session can see it) plus a text block of `{clientId, width, height, frameId, gameFrame, stats, bytes}`. `captureFrame` waits for a presented frame rather than grabbing a stale backbuffer. A 640px capture is ~600 KB — the wire cap is 4 MB |
| `browser_test`, `evaluate_widget_lua`, `spawn_at_camera` | see `.claude/skills/spring-test` | Bridges to browser-side `window.test`/`window.widgets` — includes the [performance-profiling tools](debugging-performance.md). Since P7 these **relay for real** over `/api/client/eval` and return the answer; the paste-into-chrome-devtools snippet is now only the fallback when a gate refuses |

**The three gates on every relayed tool.** All of them fall back to printing a
snippet rather than erroring, and the fallback line names which gate refused:

1. The route is compiled out under `SPRING_PROD` → a 404 reads as
   `server built without the relay (SPRING_PROD)`.
2. Only an **admin-role** session is ever addressed → `no connected admin client`.
   **Trap:** a `/api/rooms/direct` dev account is role `player` and is never
   eligible; `launch_scenario`'s default player *is* `admin`, so the happy path
   works. Among live admin sessions the newest wins (a reloaded tab arrives as a
   new client id beside the old one's corpse).
3. The browser refuses unless it is a DEV build or the page was booted with
   **`?allowClientEval=1`** → `client eval disabled in this build`.

> **Relayed code must not call back into the game server's HTTP API.** The game
> server serves HTTP on one thread, and that thread is parked inside
> `/api/client/eval` waiting for the very browser whose request it would have to
> answer — so `window.test.spawn/lua/state/…` deadlock until the timeout (and
> `/api/metrics` on that server stops answering meanwhile). `browser_test`
> refuses those harness methods by name and names the server-side tool to use
> instead (`spawn_unit`, `exec_lua`, `get_game_state`, …); `spawn_at_camera`
> relays only the camera read and does the spawn server-side.

**Readiness phases, and the one way they lie.** `probe_game` (and therefore
`wait_for_game`, `launch_game`, `launch_scenario`, `launch_direct`) derives its
phase from four signals: the lobby's process row, pid liveness, the `game_status`
heartbeat, and `/api/metrics`. `spawning` means *the process is up but nothing
has been published yet* — which is also exactly what you get when the MCP is
reading a **different SQLite file** from the one the lobby was started with. The
MCP's DB is `SPRING_DB` (`.mcp.json`); the lobby's is its `--db` flag; `mprocs.yaml`
keeps both on `data/spring-server.db`, but a hand-started lobby on another `--db`
silently strips every heartbeat-derived field (`ready`/`clientCount`/`statusAgeSec`
go `null` and the phase sticks at `spawning` for a server that is perfectly ready).
**This condition now self-diagnoses**: when the lobby vouches for the process,
SQLite reads fine, and `game_status` has no row for the room, the probe carries
`warning: "lobby --db and MCP SPRING_DB may differ; lobby reports the server but
game_status has no row — diagnose with curl :<port>/api/metrics"` (the phase
itself is unchanged). The warning rides `probe_game` and `wait_for_game`'s
`probe`, the `notes` of `launch_scenario`/`launch_direct`, `launch_game`'s
`warning`, and `list_processes`/`list_stack` when a live lobby-reported server
has no status row. `curl :<port>/api/metrics` (no DB, no auth) remains the
independent confirmation. A binding failure instead marks results with
`sqliteUnavailable` — see [MCP Server Setup](#mcp-server-setup).

`ready` is *accepting connections*, not *playing*: a roster with a human seat holds
`GameStart` (and `frame` at `-1`) until that browser attaches, so `wait:'ticking'`
on a browserless run times out **by design** — wait for `ready`, or open the
returned `browserUrl`.

The full, current tool list (with input schemas) lives in `tools/debug-mcp/server.js`; the skills in `.claude/skills/` document the recipes and pitfalls for using them. This table is a map, not the source of truth — it can drift from the server as tools are added.

**Example Claude interaction:**

```
User: Check if there are any Lua errors in the last game

Claude: [uses get_logs with level=4 (ERROR), section="lua"]
Found 3 Lua errors:
  [142] [ERROR] [spring-server:lua:LuaRules] runtime error in 'GameFrame': ...
```

### Reliable live game-drive verification

The sim does **not** advance until a real client connects — the server logs
`waiting for N player(s) to connect before starting game...` and idle-exits after
~300s if none does (`game-<room>.log` ends with `shutting down idle game server`
→ `exited cleanly`). So driving a game for verification needs an actual browser
session, not just `launch_game`. Three recurring traps:

1. **User mismatch.** `launch_game` (and the MCP tools) host as `admin`, but the
   browser tab is often logged in as someone else (`test1`). A non-host username
   is rejected by the game-server roster, so the browser never connects and the
   server idle-exits. **Fix:** don't host with `launch_game` when you need a
   browser in the loop — drive `createRoom → addAI → ready → startGame` *from the
   already-logged-in browser* so that user is the host and auto-connects.
2. **Stale game/lobby after a rebuild.** Replacing a binary on disk does not touch
   a running process. After `ninja … spring-server`, kill the running game
   (`end_game(roomId)`, or `pkill -f build/debug/spring-server`) before launching, or
   you'll test the old binary. After rebuilding the lobby, `restart_lobby`.
3. **Port/process leftovers.** All game servers bind `:9100`; a half-dead server
   keeps the UDP/QUIC socket and the next launch exits immediately. Confirm it's
   free (`lsof -nP -iUDP:9100`) and that no `spring-server` lingers before
   relaunching. Ended rooms are auto-reaped by the lobby health check.

Proven flow (browser already logged in, lobby + client + log server up):

```js
// In the browser tab (chrome-devtools evaluate_script), as the logged-in user:
const L = window.lobby;
L.selectedGameId = 'bar';
await L.createRoom('verify', 'pools_of_ilys_1.0.0');  // small map — green_flat
await L.addAI('null', 1);                              // is huge: slow QTPFS init
await L.ready(true);
await L.startGame();                                   // browser becomes host + connects
```

Then watch `game_status` flip to `ready=1, clients=1` (the server writes it to
`data/spring-server.db` once a client is connected):

```bash
sqlite3 data/spring-server.db \
  "SELECT ready, client_count, port FROM game_status WHERE room_id=<id>"
```

Once `clients=1`, the sim runs (`get_game_state` → `frame=` climbing) and you can
drive it: `set_cheats`, `spawn_unit`, `give_order`, `exec_lua`. Inspect the
client-side LuaUI worker (the `Spring.*`/`gl.*` API the player sees) with
`window.widgets.eval('<lua>')` via chrome-devtools.

> The MCP's authed tools cache the lobby token; if the session DB was reset they
> used to 401 forever. The MCP now re-auths once on a 401 (`authedFetch` in
> `tools/debug-mcp/server.js`) — but that self-heal only applies after the MCP
> process restarts. If you still see `401 … use POST /api/auth/login first` from a
> long-running MCP, restart the MCP server, or drive exec via a fresh
> `curl`-obtained token directly against `:9100/api/exec`.

---

## Headless Run Mode

`--headless-run <config.json>` runs `spring-server` to completion **with no browser
client attached at all** — no rendering, no LuaUI, no WebTransport clients. It
unblocks AI-vs-AI soak testing, balance-sweep batches, and sim-determinism CI (the
"does the synced simulation actually reproduce" question that was previously
untestable). Full design: [PLAN-headless.md](../PLAN-headless.md).

Everything else in the server is headless by construction (rendering was deleted in
Phase 0) — the only engine change is the tick-gate: idle-exit and the roster-wait are
force-disabled under `--headless-run`, so the sim starts and ticks with zero clients.

### `--headless-run` config

```jsonc
// A self-contained manifest — same shape as the quickstart --direct manifest
// (PLAN-quickstart.md), plus a `headless` block.
{
  "map": "green_flat_x34_v3",
  "game": "papertanks",
  "aiSlots": [
    { "aiId": "basic_ai", "team": 0, "startPos": 0, "profile": "aggressive" },
    { "aiId": "basic_ai", "team": 1, "startPos": 1, "profile": "default" }
  ],
  "scenario": "crossing_standoff",    // TOP-LEVEL, same spelling as the direct
                                      // manifest — folded onto the `scenario`
                                      // modoption, and it wins over a
                                      // modOptions.scenario in the same file.
                                      // "" = explicitly none; omit = map default.
                                      // `--modoption scenario=` still beats both.
  "modOptions": {                     // same key=value pairs as --modoption
    "startunits": "skirmish",         // values are strings; bools/numbers are coerced
    "combatwatch": "0"
  },
  "headless": {
    "tickMode": "uncapped",           // "uncapped" | "realtime" | "xN" (e.g. "x5")
    "stopAt": { "frame": 9000 },      // and/or "gameOver": true, "luaCondition": "GG.Some.Predicate"
    "statsDump": "out/run.json",      // written at termination
    "stateHashEvery": 300             // determinism-hash cadence, 0 = off
  }
}
```

Launch directly (no lobby needed — this bypasses the room state machine entirely):

```bash
build/debug/spring-server \
  --headless-run path/to/config.json \
  --port 19100 --db /tmp/run.sqlite \
  --max-wall-min 5   # hard wall-clock ceiling (E4), default 60
```

Run from the **repo root** — the server resolves `map`/`game` against
`data/maps/<id>` / `data/games/<id>` relative to its cwd. Each concurrent instance
needs a **distinct `--port`** (binds both TCP and the QUIC/UDP WebTransport listener —
no port-0 auto-assign) and a **distinct `--db`** (SQLite; a shared file races two
writers). The process self-terminates with exit code `0` once a stop condition fires
— no separate "wait for the dump to appear" polling is needed, just wait for the
child process to exit.

`stopAt` precedence: `luaCondition`-errored > `gameOver` > `frame` > `luaCondition` >
`--max-wall-min` (always active as the outermost runaway guard).

`luaCondition` runs in the **synced LuaRules state** (full `Spring.*`/`GG` access)
and is polled **once per game-second** (every 30 frames, first poll at frame 30) —
so a stop lands within a game-second of the condition becoming true, and even a
short run evaluates it. Both spellings work: a bare expression
(`"GG.Balance.Done"`) or a full chunk (`"Spring.Echo('probe'); return
Spring.GetGameFrame() > 100"` — a chunk that returns nothing reads as false). A
predicate that fails to compile or raises stops the run with `lua-error` rather
than hanging it; a satisfied one stops with `lua-condition` (the stats dump's
`status` field uses the same names).

`modOptions` fills the same role for a manifest that `--modoption key=value` fills on
the command line — synced gadgets read them via `Spring.GetModOptions()` and the
defs-cache key includes them. Precedence is **per key**: an explicit `--modoption`
wins over the manifest's entry for that key, and the manifest supplies the rest (same
rule as `map`/`game`/`aiSlots`). Values reach Lua as **strings** whatever their JSON
type, so `true` arrives as `"1"` and `3` as `"3"`. A malformed entry (object/array
value, empty key) is skipped rather than aborting the run.

### Stats dump + determinism hash

The JSON written to `headless.statsDump` at termination (`rts/Server/StatsDump.{h,cpp}`):

```jsonc
{
  "status": "frame-limit",           // headless::StopReasonName() value
  "frame": 9000, "gameSeconds": 300.0, "wallSeconds": 4,
  "snapshots": [
    {
      "frame": 300, "gameSeconds": 10.0, "wallSeconds": 0,
      "stateHash": "a1b2c3d4e5f60708",  // fixed-width hex string, NOT a JSON number
      "simFps": 0.0, "rssKb": 41232, "luaHeapKb": 128,
      "dbBytes": 1052672,               // main + `-wal` + `-shm`, see below
      "growth": {                       // every PLAN-long-uptime §1 surface
        "rss_kb": 41232, "lua_heap_kb": 128,
        "param_keys": 175, "param_keys_rev": 176, "rules_params": 237,
        "unit_ids_used": 100, "unit_ids_max": 32000, "unit_spawns": 412,
        "standing_orders": 0, "players": 2, "players_max": 251
      },
      "teams": [ { "teamId": 0, "numUnits": 3, "metal": 940.0, "damageDealt": 0.0, "unitsKilled": 0, /* ... */ } ],
      "weapons": [ { "weaponDefId": 4, "volleys": 12, "kills": 1, "damage": 340.5 } ]
    }
    // ... one row per `stateHashEvery` frames, plus a final row at the stop frame
  ]
}
```

**`stateHash` is a hex string, not a number** — a real hash exceeds 2^53 and would
lose precision through a double-based JSON parser (Node/Python). Parse it as an
opaque string; compare with plain `===`/`==`, never cast to a number.

`stateHash` is an FNV-1a xor-fold over every active unit's id/team/pos/health plus the
synced RNG's generator state, folded in engine iteration order (order-sensitive by
design — reproducing the same order every run *is* the sync claim). Two runs of the
same config must produce byte-identical `stateHash` sequences; any divergence is a
real synced-state bug, not test flake.

**Known gap:** the engine has no `seed` config field yet — `gsRNG` is hard-seeded to a
fixed constant (`CGlobalSynced::ResetState()`), so there is currently no way to make
two headless runs diverge on purpose via a seed. The batch driver (below) still
carries a `seed` matrix axis through to each generated config for bookkeeping/
reproducibility labelling, but the engine does not yet consume it — noted here per
the no-silent-deviation rule rather than left to be discovered later.

The `growth` object is written by the same module the live GM dashboard reads
(`rts/Server/GrowthCounters.{h,cpp}`), so a slope fitted off a soak dump and a
badge rendered off `game_metrics.extra_json` are the same number by
construction. Key names are snake_case there and camelCase everywhere else in
the dump for exactly that reason — they are GrowthCounters' names, not
StatsDump's. `rssKb`/`luaHeapKb` are duplicated at the top level because the
determinism harness already reads them there.

**`dbBytes` sums the main SQLite file, its `-wal` and its `-shm`.** Stat'ing
the main file alone measures how recently sqlite checkpointed, not how much the
game is storing: in WAL mode it can sit at 4096 bytes for twenty minutes while
half a megabyte accumulates in the sidecar. The first soak run caught exactly
that, and a retention policy verified against the un-summed number would have
"passed" on a database with no retention at all.

### Batch driver (`tools/headless-batch`)

`tools/headless-batch/batch.mjs` — a dependency-free Node ESM CLI — expands a
parameter matrix (profiles × maps × seeds, or any other axes) against a config
template, spawns one `spring-server --headless-run` per combination (concurrently —
they're cheap; task 2's field notes measured an uncapped 3-simulated-hour run
completing in 8 wall-seconds), and collates every run's stats dump into one JSONL
file (one line per run) for downstream analysis: balance sweeps, economy tuning
grids, AI profile round-robins, long-uptime soak ladders.

```bash
node tools/headless-batch/batch.mjs \
  --template tools/headless-batch/fixtures/balance-template.json \
  --matrix   tools/headless-batch/fixtures/balance-matrix.json \
  --out-dir  out/balance-01 \
  --server-bin build/debug/spring-server \
  --concurrency 4 --max-wall-min 5
```

The matrix spec is a list of dot-path axes (`aiSlots.0.profile`, `map`, `seed`, or any
other field in the template) cross-producted into one config per combination:

```jsonc
// tools/headless-batch/fixtures/balance-matrix.json
{
  "axes": [
    { "path": "aiSlots.0.profile", "values": ["aggressive", "default"] },
    { "path": "map", "values": ["green_flat_x34_v3", "pools_of_ilys_1.0.0"] },
    { "path": "seed", "values": [1, 2] }
  ]
}
```

2×2×2 axes → 8 runs. Each JSONL line is
`{ index, params, port, configPath, dumpPath, exitCode, ok, dump, stderrTail? }` —
`params` is the flat `{axisPath: value}` combination for that row, `dump` is the
parsed `FinalDump` JSON (or `null` if the run failed before writing one — never
faked with zeros). Per-run configs/dumps/db files land under `--out-dir` so nothing
overwrites between rows.

**Every arm's server output is kept**, passing runs included, at
`<out-dir>/logs/run-<i>.log` (stdout, then a `--- stderr ---` divider). A dump
records counters, not warnings, and the warnings are where an arm says it staged
nothing: three of the four soak-fixture defects below (no scenario, AI slots on
an empty team, a war that ends) announce themselves in the log and in **no
counter**, and keeping only a *failed* run's `stderrTail` meant the whole ladder
was green and silent while measuring an empty world. Budget the disk: a
Metalstorm arm logs ~3 MB per 4 wall-minutes (≈45 MB/wall-hour), dominated by
`strategos` re-announcing the same directive — 1 686 copies of one
`Scouting Meridian Basin` line in 2.7 simulated hours.

The matrix-expansion core (`lib/matrix.mjs`) is pure — no `child_process`/`fs` — and
covered by `node tools/headless-batch/test/matrix.test.mjs` / `make
test-headless-batch`, which asserts the PLAN-headless.md §6 "meta" requirement
directly: a 2×2×2 spec produces 8 rows with distinct seed values and no duplicate
combinations.

### Determinism CI hook

`tools/headless-batch/determinism-pair-run.mjs` runs one config **twice, back to
back**, and diffs the two dumps' `stateHash` sequences frame-for-frame — the actual
regression test for the "synced" claim. Wired into
[`.github/workflows/headless-determinism.yml`](../.github/workflows/headless-determinism.yml)
(macOS runner — same QUIC/Homebrew constraint as `security-prod-gate.yml`, see that
workflow's platform note) and `make test-headless-determinism`:

```bash
make test-headless-determinism
# builds spring-server, then:
node tools/headless-batch/determinism-pair-run.mjs \
  --server-bin build/debug/spring-server \
  --out-dir build/headless-determinism
```

The CI fixture (`tools/headless-batch/fixtures/papertanks-determinism.json`) is
PaperTanks-scale — a 2-AI, 5-game-minute (`stopAt.frame: 9000`) uncapped run against
`green_flat_x34_v3` with `stateHashEvery: 300` (30 snapshots) — chosen small enough
that the actual sim run costs single-digit wall-seconds; the workflow's ~2-minute
wall time is almost entirely the `cmake`/`ninja` build, not the run itself. A
mismatch prints every diverging snapshot (frame + both hashes) and exits non-zero.

#### The fixture must not be vacuous

> **This gate ran green for weeks while testing almost nothing** (found 2026-08-03,
> fixed 2026-08-04). Paper Tanks ships no side data and no start-unit gadget, so a
> `--headless-run` of it produced a game with **zero units** — every one of the 30
> snapshots reported `numUnits: 0`, and the state hash folded an empty unit list plus
> the synced RNG state. Two runs of an empty world agree perfectly. What the gate
> actually regression-tested was "the RNG stream is stable"; it could not have caught
> a movement, collision, damage or command-ordering divergence, because none of those
> ever executed.

The fix has two halves, and the second is the one that keeps it fixed:

1. **The fixture stages a real army.** `modOptions.startunits: "skirmish"` turns on
   `data/games/papertanks/LuaRules/Gadgets/game_start_units.lua`, which stages 12
   units a side (heavy/light tanks, scouts, artillery, an HQ) on opposite sides of the
   map centre and walks the mobile ones into the middle. Deterministic by
   construction: no RNG, no wall clock, sorted team ids, positions a pure function of
   (map size, team slot, unit index). It is **off unless the modoption is set**, so
   every other Paper Tanks invocation is unaffected. The fixture also sets
   `combatwatch: "0"` — `combat_watch.lua` logs one line per shot, which buries the
   verdict once there is real combat.
2. **Both drivers reject a vacuous run before comparing anything**
   (`tools/headless-batch/lib/fixture-checks.mjs`). A dump must show peak units,
   damage dealt *and* units died above zero. Deaths are required specifically because
   units that exist and shoot but never die leave the destruction/removal path — a
   classic source of iteration-order nondeterminism — untested. A hash comparison
   cannot tell you it compared two empty worlds, so the content is asserted
   separately and up front.

Measured on the fixed fixture: `peakUnits=23 peakDamage=18788 peakDeaths=19`, and the
recording went from **1 journal record** (the GameStart anchor, nothing else ever
happened) to **1799**.

### Fixture-replay verify CI hook

`tools/headless-batch/replay-verify-run.mjs` is the second gate over the same fixture,
and a strictly harder question than the pair-run. The pair-run asks *"does the same
input produce the same output twice?"*; this asks *"does re-feeding the recorded
**cause stream** reproduce the run?"* — which additionally covers journal completeness
(an unrecorded synced input surfaces as a divergence), record ordering, and the `.msr`
container round-trip.

```bash
make test-replay-verify
# builds spring-server, then:
node tools/headless-batch/replay-verify-run.mjs \
  --server-bin build/debug/spring-server \
  --out-dir build/replay-verify --pack
```

Three passes: record the fixture with `--journal-file` + `--journal-hash-every`,
re-execute it with `--replay … --verify`, then (with `--pack`) repack via
`--replay-export` and verify the packed copy too.

> **Gate on the log line AND the exit code** (changed 2026-08-27). `spring-server`
> used to abort during static destruction (`CWeaponDefHandler` →
> `~DynDamageArray`'s `assert(refCount == 1)`, inside `__cxa_finalize`, *after*
> `main` returned and after `exited cleanly` was logged) in any run that exercised
> weapon defs — PLAN-replay T2-b — which made the process status pure noise and
> forced both drivers to parse log lines only. That defect is fixed: the weapon-def
> handler is placement-new'd into static storage and never destroyed
> (`rts/Sim/Weapons/WeaponDefHandler.cpp`), so a completed run now exits 0 and both
> drivers require **both** the engine's own verdict (`replay verify: PASS/FAIL` /
> `headless run complete:`) **and** a zero exit — either alone can lie (an early
> death can exit 0; a logged verdict used to be followed by an abort). A run that
> produces **no** verdict is its own failure mode (`absent`), never "no FAIL seen".

Live results on the fixed fixture (debug build): 1799 records / 30 hash points
recorded, `PASS — 30/30 state hashes matched` on both the raw recording and the packed
copy (178 887 → 9 350 bytes). Negative control: flipping one bit of the frame-4800
reference reports `FAIL … firstDivergence=4800`, located exactly.

### The determinism gate (one entry point for CI)

`tools/headless-batch/determinism-gate.sh` (also `make determinism-gate`) runs the
whole determinism story in one call — the thing a CI job should invoke:

```bash
make determinism-gate
# or, against a binary you already built:
tools/headless-batch/determinism-gate.sh build/debug/spring-server
```

Four arms, all of which must pass: the pair-run and the replay-verify (`--pack`)
over the PaperTanks fixture, then the same two over
`fixtures/metalstorm-determinism.json` — Metalstorm's own content
(`crossing_standoff` on `scorched_crossing_v2.4`, `strategos` AI on both sides,
5 game-minutes, `stateHashEvery: 300`). The Metalstorm arms exist because one
fixture on flat terrain is narrow coverage (PLAN-replay T5-b): the pathfinding,
economy and AI content the demo actually ships was otherwise untested by the
determinism gate. Note the Metalstorm arms need `data/maps/scorched_crossing_v2.4`
present (map packages are not tracked in git).

> **What the Metalstorm arm caught on its first run (2026-08-27): Lua's
> per-process string-hash seed.** Two runs of the identical fixture diverged
> (first hash mismatch ~frame 2400; the strategos allocator assigned the same
> force packages to DIFFERENT goals at its first score tie). Root cause: stock
> Lua 5.4 seeds its string hash from wall time + ASLR (`luai_makeseed`), so
> `pairs()` iteration order over string-keyed tables differs per process — and
> the AI planner builds its goal/package arrays out of `pairs()`, so the rng
> tie-break values were paired with different candidates in each run.
> PaperTanks never caught this because its start-unit gadget deliberately
> avoids `pairs()`-order dependence. Fixed by pinning the seed in
> `rts/lib/lua/src/luaconf.h` (note: the `src/` copy is the one the Lua core
> compiles against — `include/luaconf.h` is the external consumers' copy and
> carries the same define; keep both in sync). With the pin, the Metalstorm
> pair-run and replay-verify both pass 30/30.

### Replay spectate CI hook (a client watching a re-execution)

`replay-verify-run.mjs` proves a recording re-executes with **nobody watching**.
`tools/headless-batch/replay-spectate-run.mjs` covers the other half: a real
client, on the real wire, admitted to that same re-execution as a spectator. It
is the only gate that exercises the live `Handshake`/`AuthRequest` admission path
on a replay server — a headless run has no clients — and the only one that can
observe the sim-affecting-verb refusal.

```bash
make test-replay-spectate                    # ~60 s on a debug build
# or, spectating a recording you already have:
node tools/headless-batch/replay-spectate-run.mjs \
  --server-bin build/debug/spring-server \
  --replay-file build/replay-verify/run.msr --out-dir build/replay-spectate
```

Two arms over one recording, both `--replay … --verify`: **spectator** (the
scripted wire client attached, issuing a MOVE order) and **control** (nobody
watching). Both must PASS with the *same* `(checked, matched, fed)` triple — the
pair is what says the spectator was the only difference and made none. The
spectator arm additionally asserts `role=spectator team=-1`, a player number from
the reserved 200+ range, the server's own admit/attach lines naming that same
number, and the refusal of the verb the client sent.

- **Why `--verify` and not playback.** Playback ticks in realtime (300 s for this
  fixture, against ~10) and checks no hashes. The cost is a race — `--verify` is
  a batch job, so the attach window is the length of the re-execution — which is
  why the harness is started FIRST with `--wait-for-server`, paying node + vite +
  the native addon before the server exists. An arm whose spectator never got in
  is reported **VACUOUS**, never as a pass.
- **The refusal is asserted from the log, independently of the verdict, and that
  is the load-bearing part.** From 2026-08-05 to 2026-08-14 the gate in
  `server_main.cpp` was inert (its peek handed the FlatBuffers verifier the frame
  with the envelope byte still attached, so every verb read as `NONE`) — and
  `--verify` still reported **30/30** with a live client's `PlayerCommand`
  reaching the re-execution. A hash folds units and the RNG; it cannot see this.
  Both the fix and the assertion are in `wireframe::` (`rts/Server/ClientFrame.h`).
- Rules only, no server: `node --test test/replay-spectate.test.mjs`
  (`make test-headless-batch`).

### Soak ladders + growth report (`growth-report.mjs`)

The soak ladder is an ordinary batch run whose template is a long uncapped
Metalstorm game and whose matrix is the churn knobs
(PLAN-long-uptime.md §2, task 4):

```bash
make soak-growth                      # both steps, gated, into build/soak/
make soak-growth SOAK_WALL_MIN=10     # shorter arms while iterating
make soak-growth SOAK_CONCURRENCY=1   # one arm at a time on a contended machine

# or by hand:
node tools/headless-batch/batch.mjs \
  --template tools/headless-batch/fixtures/soak-ladder.json \
  --matrix   tools/headless-batch/fixtures/soak-matrix.json \
  --out-dir  build/soak --server-bin build/release/spring-server \
  --concurrency 4 --max-wall-min 45

node tools/headless-batch/growth-report.mjs --jsonl build/soak/results.jsonl \
  [--budgets tools/headless-batch/fixtures/soak-budgets.json] \
  [--emit-budgets new-budgets.json]
```

`soak-matrix.json` crosses `objective_density` × `build_time_scale`, so the four
arms run **ladder 1 (baseline) plus the three knob combinations that attribute
any slope to one knob or the other**. (§2's *ladder 2*, the churn amplifier, is
join/leave and parley traffic — neither of which a knob can produce; it needs a
scripted wire client and is not what this matrix runs. See PLAN-long-uptime §11.)
Use a **release** binary: the debug build ticks this content ~30× slower, which
is the difference between a simulated day costing hours and costing days.

**Four things the ladder fixture has to get right, each of which produced a
clean-looking and worthless report first (measured 2026-08-12, task 4):**

- **A scenario is required** (top-level `"scenario"`, or `modOptions.scenario` —
  the top-level spelling wins and is the one that also works as a room
  manifest). Without one `game_scenario.lua` stages
  nothing, so a Metalstorm war is 8 units a side with no economy and no contact:
  the report's vacuity check fails the arm with `peak damage 0 / deaths 0`, and
  every slope in it is a slope through an empty world.
- **The AI slots must sit on the teams the *scenario* stages, not 0 and 1.**
  `meridian_basin` stages teams **0**, **4** and NPC **8** (its `sides` block
  declares 0–3 Compact, 4–7 Union, 8 Reavers). A slot on team 1 gets a side with
  no units — the loader says so (`team(s) 1 are in this war with NO units`) and
  the war is then one AI shooting civilians.
- **`stateHashEvery` is the growth sample cadence.** It was 86 400 frames, which
  on real content is ~20 wall-minutes per sample, so a 25-minute arm produced
  **one** snapshot and every metric ruled `too-short`. It is 3 600 now (2
  simulated minutes).
- **`stopAt.gameOver` must be set.** `meridian_basin`'s victory objective is
  terminal and its war is winnable at frame **12 180** (~6.8 simulated minutes);
  after `Spring.GameOver` the sim freezes, so the frame stops advancing, the
  `frame % stateHashEvery` cadence never fires again and the arm burns the rest
  of its wall ceiling in silence — measured at **24 of 25 wall-minutes**, with
  the dump still reporting `status=wall-ceiling` as though the window had been
  the wall's fault.

**And then the war itself has to not end** (task 4b, T4-3). Fixing the four
items above only revealed that the fixture's whole premise was wrong: a growth
ladder wants a window bounded by *wall clock*, and `meridian_basin` is a
showcase war designed to be won inside one session. The template now stages
**`meridian_basin_soak`** — the same content (same regions, staging, Reavers,
sites, civilians, convoy schedule; a spec asserts the parity field by field)
with **no `victory = true` objective**, which `game_gameover.lua` treats as a
supported shape: it publishes `war_can_end = 0`, warns once at frame 60, and
never winds the war down. The engine's last-team-standing fallback is already
gated off for Metalstorm, so the arm does not end even if a side is wiped;
the convoy respawn schedule and the Reaver raid slate keep the churn running with
zero clients attached — **but `objectives/generator.lua` does not.** Measured over
four 9-simulated-hour arms (§12): **zero** systemic objectives were issued in any
of them, on `objective_density` normal *and* dense. Three Strategos AIs with no
player produce a stalemate, no region changes hands, and the generator's rules
are all contest-driven, so the density axis of this matrix cannot move a growth
surface — it scales a cap nothing reaches.
`stopAt.gameOver` stays set — on this scenario it is a **canary**, not a stop
condition: an arm that reports `status=game-over` means something re-introduced
a terminal objective, which is exactly the failure the four items above hid.

**Two counters a client-less ladder can never rule**, so they read `no-signal`
by construction rather than by ladder length: `StateStreamer::BroadcastRulesParams`
returns at `rtcServer.GetClientCount() == 0` (StateStreamer.cpp:1552) *before*
the interning block, so **both** S1's key dictionary and its compaction are
client-gated (`param_keys` sits at 0); and standing orders arrive from client
macro-order calls, so `standing_orders` does too. Those two are what
[`make soak-churn`](#churn-arm-ladder-2-soak-churn-runmjs) below exists for.

`growth-report.mjs` fits `base + slope×days` to every growth surface and rules
each slope:

| verdict | meaning |
|---|---|
| `flat` | slope within 2σ of zero, or under the 1 %-of-base floor, or falling (reclamation) |
| `explained` | sloping, and a budget entry with a `why` accounts for it |
| `saturated` | the whole-window slope would have failed, but the surface **stopped moving inside the arm**: the last half of the window fits flat (and a watermark did not rise at all there). A bounded step, not a rate. Printed `STEP`; passes |
| `over-budget` | sloping past its budgeted rate — **fails** |
| `unexplained` | sloping with no budget entry — **fails**, this is §2's gate |
| `no-signal` | sampled, and read **0 every time**: the ladder never exercised the surface. Cannot rule. **Not a pass** |
| `too-short` / `no-samples` | cannot rule. **Not a pass** |

**Which clock a slope is quoted against is part of the reading.** Sim-owned
surfaces (params, ids, orders, Lua heap) are fitted per **simulated** day — that
is what an uncapped ladder buys. `db_bytes` is fitted per **wall** day, because
`GameMetricsWriter::DueForWrite` is `steady_clock`-based (one row per 60 wall
seconds) and so are task 2b's retention sweeps: on a ladder running ~130
simulated days per wall day, a per-simulated-day fit would report a database
growing 130× slower than it will in production. Every report line names its axis
(`/sim-day`, `/wall-day`).

Four things the ruling does deliberately, each of which was a bug first:

- **A two-sample series is `too-short`, not a clean fit.** Two points always fit
  a line exactly — `r2` is 1 and the residual error is zero — so a
  two-snapshot dump would otherwise produce the most confident-looking and
  least justified line in the report.
- **A noisy counter does not manufacture a slope.** The synced Lua heap swings
  4–11 MB on a live Metalstorm game, so a slope is only believed when it clears
  2σ of its own standard error *and* an absolute floor.
- **A budget without a `why` explains nothing.** §2's gate is "slope explained
  by design"; a bare number is merely permission. `--emit-budgets` seeds a
  skeleton from the observed slopes with every `why` set to `null`, so the file
  cannot pass the gate until a human has written the reasons in.
- **A metric with a period declares `minSpanDays`, and a shorter arm cannot rule
  it.** `db_bytes` sawtooths: the `-wal` sidecar grows 4 kB every 2 wall-seconds
  (the `game_status` liveness commit) until `wal_autocheckpoint` folds it back,
  measured at 31 wall-minutes. A 25-minute arm fits the ramp at r2 = 1.00 and
  reports 195 MB/wall-day; 55 minutes across 1.8 cycles reports **37.8**. Half a
  period is still no periods, so the floor has to be absolute rather than a
  fraction of some other arm.
- **A short arm cannot raise a budget over a long one.** `--emit-budgets` takes
  the largest observed slope per metric, because the churn arm is the one that
  stresses these surfaces — but only among arms whose window is at least 25 % of
  the longest arm's window for *that metric*. The first real ladder had three
  arms whose wars ended inside the opening ramp and which reported
  `rules_params` at 45 864/sim-day against the long arm's 25/sim-day; largest-wins
  across that set would have issued a licence ×1800 looser than the steady state.
  Every arm refused is printed by name.
- **A step is not a rate, and a long arm makes them look identical.** A surface
  that grows during the war's opening ramp and then stops — `rss_kb` rose 34 MB
  and 80 MB in the first ~1.5 simulated hours of the first endless ladder's
  normal-density arms and then did not move for seven more — fits a line whose
  slope is the step divided by however long the arm ran. Halve the window and the
  reported "rate" doubles, so no budget entry can honestly license it. Ruled by
  asking the same flat test on the **last 50 %** of the window: still rising
  there → the failure stands; flat there → `saturated`, with the whole-window
  number still printed. A watermark additionally must not have risen in raw
  values in the tail, because `ru_maxrss` cannot fall and one late allocation the
  process never gave back is real (a 2σ test on a mostly-flat tail would absorb
  it). This only ever DOWNGRADES a failure: a budgeted surface keeps reporting
  `explained` and keeps being compared to its number.
- **A counter that read zero all run is `no-signal`, not clean.** A headless
  ladder has no client sessions, so `StateStreamer` interns no keys and
  `param_keys` sits at 0 for the whole run — the flattest line in the report,
  and no evidence at all about the surface PLAN-long-uptime §1 S1 bounds. Zero
  forever means unexercised.

`make test-headless-batch` covers the ruling (`lib/growth-fit.mjs` is pure).

### Churn arm, ladder 2 (soak-churn-run.mjs)

The ladder above measures a world with **no clients**, and two of §1's rows are
unreachable that way (see the `no-signal` note above). This is the arm that
reaches them: N scripted wire sessions connecting, issuing a move order and a
standing order, disconnecting, and doing it again for the length of the window.

```bash
make soak-churn                                   # 2 sessions, 3-minute arms
make soak-churn CHURN_WINDOW_MIN=6 CHURN_SESSIONS=3
node tools/headless-batch/soak-churn-run.mjs \
  --server-bin build/release/spring-server --out-dir build/soak-churn \
  --window-min 3 --sessions 2 [--skip-control]
```

It runs the **same fixture twice** — once with the churn driver, once with
nobody connecting — and the pair is the evidence: the churn arm alone would show
two counters with numbers in them and could not say the clients put them there.
A control that moves on its own **fails** the gate.

First live pair (2026-08-14, release binary, `churn-ladder.json`, 3-wall-minute
arms, 66 cycles over 2 seated accounts):

| surface | control | churn |
|---|---|---|
| `param_keys` (S1) | 0 over 211 samples | **0 → 695** |
| `standing_orders` (S6) | 0 over 211 samples | **0 → 60 peak, 50 final** |

Four things it has to get right, three of which are the reason the arm did not
exist earlier:

- **The sessions must be SEATED, not merely authenticated.** A standing order is
  refused with a **401** when `session->team < 0` (ClientMessageHandler.cpp), and
  a server with no `--player` roster admits every client as a spectator — which
  authenticates perfectly. The runner passes `--player <user>:<team>:<pos>` and
  the verdict asserts on the *team* in each cycle's AuthResponse, never on the
  auth status alone.
- **Both arms run `--session-kind persistent`.** A skirmish with a `--player`
  roster holds GameStart until every rostered human connects
  (`GameStartCoordinator.h`), which the control arm never does; the two arms
  would then not be the same run and the control would measure a server sitting
  in set-up.
- **The churn accounts sit beside the AI, not on top of it.** `churn-ladder.json`
  puts the two Strategos on teams 0 and 4 and the churn accounts on **1 and 5** —
  the second seat of each faction's team block in `meridian_basin_soak`.
- **Refusals only ever arrive as a `ServerError`** (401 unseated, 402 no
  authority, 429 rate limit or per-team cap), so the driver counts them by code.
  A harness that counted only what it *sent* would report a window in which every
  order was refused as healthy.
- **The driver `await`s its own last write.** `console.log` + `process.exit()`
  truncates on a pipe: the verdict carries a seat record per cycle, and at 142
  cycles the caller got exactly 8 192 bytes of JSON **and a zero exit status**
  while the 66-cycle arm fitted and passed. Both wire entry points now wait for
  the write to leave.

**Window length changed the S1 answer, so read this before believing a short
arm.** At 3 minutes `param_keys` looked like a bounded step — but the driver
stops 25 s before the server by design, so a short arm always ends with a quiet
tail. At **6 minutes** (2.2 simulated hours, 144 cycles) the dictionary climbs at
**8.1 assigned ids per churn cycle** while live `rules_params` moves only 292 →
533 — each session mints keys that die with it — and then **S1's compaction fires
for the first time on record**: `rulesParams key dictionary compacted: 1050
interned -> 512 live (538 dead ids reclaimed), rev 1052`, on the 512-dead
absolute floor. S1 is bounded by that compaction, not by the vocabulary, and the
`param_keys` / `param_keys_rev` pair is what makes it visible (falling keys,
climbing rev).

**`standing_orders` is the shape the S6 fix predicts:** it climbs ~1 per churn cycle, peaks, and then **falls** as the
default TTL (`defaultTtlFrames` = 108 000 = one simulated hour) retires the
earliest orders — 60 at simulated minute 66, 50 by minute 79. The live count is
therefore ≈ *churn rate × TTL*, well under the per-team cap of 64, and a
disconnect does **not** retire a departed player's orders; the deadline does.
⚠ Consequently `growth-report.mjs` rules **both** client surfaces `unexplained`
on these windows (S6 897–1 189 orders/sim-day; S1 1 938 keys/sim-day at r² 0.14,
a line through a sawtooth). Neither is a steady state — one decays on the TTL,
the other is reclaimed by the compaction — and the `saturated` rule's last-50 %
test straddles both turning points. **Quote the series, not the slope**
(PLAN-long-uptime T4-1a). The gate itself rules by peak-vs-control, not by slope.

---

## Scripted wire client (`client/wire`)

A headless run has **no clients**, so everything on the client side of the wire —
the `Handshake`/`AuthRequest` admission path, a human's `PlayerCommand`, the
per-client churn a soak ladder wants — could until now be exercised only by hand
in a browser. This is a client that speaks the real wire from a script: real
QUIC/WebTransport, real control framing, and the **same generated FlatBuffers the
browser client uses** (nothing about the protocol is restated in it, so a schema
change breaks the harness in the same commit it would break a player).

```bash
cd client
# authenticate against a running game server and report what came back
npm run wire -- --url http://127.0.0.1:9001 --user wire_probe --pass devpass

# issue a command (CMD_MOVE = 10) and hold the session open to see the answer
npm run wire -- --url http://127.0.0.1:9001 --user wire_probe --pass devpass \
    --command 10 --squads 7 --params 4000,0,4000 --hold-ms 3000

# machine-readable, for a CI arm
npm run wire -- --url http://127.0.0.1:9001 --user wire_probe --quiet --json

# the harness's own self-test: pin a hash the server cannot present, and the
# QUIC handshake MUST fail (exit 0 means it was refused)
npm run wire -- --url http://127.0.0.1:9001 --user wire_probe --pin-mismatch

# wait for a server that is not up yet — for a CI arm racing a batch job, the
# node/vite/addon start-up is paid BEFORE the server exists
npm run wire -- --url http://127.0.0.1:19218 --user probe --pass devpass \
    --wait-for-server 90000 --quiet --json
```

Exit status: **0** every assertion held · **1** an assertion failed
(`--expect-auth`, `--expect-player-num`, a session that opened and never sent an
AuthResponse, bytes that did not leave) · **2** the harness could not run (no
server on the port at all, missing addon, bad arguments). The 1/2 split is what
tells a CI reader whether to look at the server or at their own environment.

`--json` reports `auth`, the inbound tallies, **`sentByPayload`** and
**`commandPayloadType`** (tags off the generated `ClientPayload` enum, so a gate
asserting "the server refused the verb I sent" never hardcodes a number) and
**`writeErrors`** (non-empty means bytes the harness claims to have sent did not
leave — they were voided until 2026-08-14, which read as "sent").

Three things about it are worth knowing before changing it:

- **Node has no WebTransport**, in any release or behind any flag, so the client
  is `@fails-components/webtransport` (libquiche native addon, a client
  devDependency). The off-QUIC half of the harness is in the ordinary client
  vitest gate; the QUIC half needs a server and is run by hand or by CI.
- **That package does not implement `serverCertificateHashes`.** It verifies a
  chain through `globalThis.FAILSVerifyProof` and would reject our self-signed
  rolling cert, so pinning is implemented in `run-wire-client.mjs` by repointing
  that hook at the hashes `/api/wt/info` publishes — SHA-256 of the leaf DER,
  the same material and the same check the browser applies. `--pin-mismatch`
  exists because a hook that returned `true` unconditionally would pass every
  other arm identically.
- **The hook must be installed *after* importing the package**, which installs
  its own at import time. Get that order wrong and the connection fails in the
  QUIC handshake with a bare `Opening handshake failed.` and no hint of why.

A dev-mode server auto-registers the account named by `--user`, so no sign-up
step is needed. A session that the server does not seat comes back
`team=-1 role=player`: authenticated, but holding no team, which is the right
answer for a server started with no `--player` roster and NOT a defect.

`wire/run-wire-churn.mjs` is the **many-sessions** entry point (the soak churn
arm above drives it). It holds every session in ONE node process deliberately:
spawning `run-wire-client.mjs` per cycle would pay vite plus the native addon on
every connect, and the measured churn rate would be node's start-up cost rather
than the server's. It shares the cert-pinning hook and its install-order trap
verbatim, and adds `sendStandingOrderCreate` — the verb S6 counts.

---

## Replay record / playback

A replay is the recorded **cause stream** — every input that entered the server from
outside the deterministic sim — re-executed against the same content. Because the sim
is deterministic, re-running the inputs reproduces the game; there is no per-frame
state in the file. See [PLAN-replay.md](../PLAN-replay.md) for the design.

### Recording

```bash
spring-server --headless-run config.json --journal-file game.msr
```

`--journal-file` attaches the synced-input funnel's durable writer. It works on any
server, not just headless ones — a normal lobby-launched game records the same way.
The file carries its own launch spec (map, game, modoptions, roster, AI slots), so
playback needs no other argument.

`--journal-file` and `--journal-audit` are mutually exclusive in effect: the file
writer wins, since a run asked to produce a shareable artefact should not have its
records land in a diagnostic in-memory ring instead.

The recording also embeds a **state-hash track** — a determinism reference point every
`--journal-hash-every N` sim frames (default **300**, i.e. every 10 s; `0` disables it).
That track is what `--verify` checks against, so a file recorded with `0` can never be
verified afterwards; the recorder warns about it at open *and* at close rather than
letting it be discovered by a CI run weeks later.

```bash
spring-server --headless-run config.json --journal-file game.msr --journal-hash-every 300
```

### Exporting a shareable `.msr` (`--replay-export`)

```bash
spring-server --replay game.msr --replay-export shared.msr
spring-server --replay shared.msr --replay-export plain.msr --replay-export-codec none
```

Repacks a recording and exits — no sim, no content, no port. The default codec is
`deflate` (~3× on a real papertanks stream); `none` is the unpack/import direction.
Importing needs no flag at all: `--replay` decompresses transparently.

Two properties worth relying on:

- **A truncated segment stays truncated.** Packing a `kill -9`'d recording re-emits it
  without a trailer, so the copy still reads `[TRUNCATED SEGMENT]`. Laundering a crashed
  recording into a clean-looking artefact is the one thing the packer must never do.
- **A live recorder never compresses.** Compression is an export step precisely because
  a torn deflate stream is unrecoverable, and salvaging a torn *recording* is the whole
  point of the truncation handling.

> The format reserves a `zstd` codec value (PLAN-replay §1 specifies zstd) but does not
> implement it: this tree links zlib and not libzstd. `--replay-export-codec zstd` is a
> spoken error, never a silent substitution.

### Playing back

```bash
spring-server --replay game.msr --port 9101 --db /tmp/replay.sqlite
```

The replay server is an ordinary game server whose inputs are prerecorded, so clients
connect over the standard wire and spectate with no replay-format knowledge. Two
behaviours differ from a live server, both deliberate and both logged:

- **Sim-affecting verbs from live clients are refused.** A client attached to a
  replay is a spectator by construction. View-state verbs (viewport, selection, path
  preview) pass through untouched. (This gate was **inert** from 2026-08-05 to
  2026-08-14 — one decoder off by the envelope byte — and `--verify` could not
  see it. `make test-replay-spectate` now observes the refusal itself.)
- **`/api/exec` is refused**, with a reply rather than silence — injecting Lua into a
  re-execution would fork it.

A spectator is admitted as `role=spectator`, `team=-1` and a player number from a
reserved range (200+), and is **not** registered in the sim's player list at all — so
it never appears in `Spring.GetPlayerList()` and cannot mint synced rules params the
recording never had. The trade is stated rather than hidden: with no roster row, the
`LuaUIMsg` relay drops a replay spectator's chat.

#### Playback controls

A spectator gets a playback bar in the browser: play/pause, a speed cycle
(0.5/1/2/4/8×), a click-to-seek track, and a global ⇄ team POV toggle. It rides
`ClientPayload::ReplayControl`, a verb classified `Ignored` — never journaled, and
dropped by a live server, which is why the bar only ever appears on a replay (the
server's `ReplayState` message is the mode signal; a live game never sends one).

Two refusals are expected and both come back with a reason the bar shows:

- **Backward seek.** Seek is "load the nearest checkpoint ≤ target, then fast-forward",
  and nothing writes checkpoint blobs yet (PLAN-persistence's sim serializer owns that),
  so the record cursor cannot be rewound. Forward seek works and is frame-exact; it
  fast-forwards uncapped with the wire muted, so the watcher does not see the skipped
  frames.
- **Not the controller.** With several spectators on one replay ("casting"), the first
  to attach drives; control passes to the longest-attached survivor when the driver
  leaves. POV is exempt — it is a per-client view choice, so every watcher sets their
  own.

Server-side, each landed control logs a line:

```
replay: spectator playerNum 200 attached to the playback controls (1 watching, controller is 200)
replay: playerNum 200 set playback paused=0 speed=2.00 seek=5217 (frame 4299)
replay: seek complete at frame 5217 — resuming streaming
replay: refused a playback control from playerNum 201: another spectator is driving this replay (player 200)
```

### Verifying (`--verify`)

```bash
spring-server --replay game.msr --verify                        # embedded track
spring-server --replay game.msr --verify reference-stats.json   # explicit override
```

Re-executes headless (uncapped) and compares the state hash at exactly the frames the
reference track recorded one at.

**The argument is optional.** With none, the recording's own embedded hash track is the
reference — one file, one command, nothing to point at the wrong run. Passing a
[stats dump](#stats-dump--determinism-hash) *overrides* the embedded track, which is how
the negative control is run (verify one game's stream against another game's hashes; it
must fail). A `--verify` with neither is refused up front rather than three minutes later
with `checked=0`.

Recording and verification compute the hash at the **same statement** in the tick, not
merely at the same frame — they share one call site in `server_main.cpp`, because a
reference taken a few statements earlier in the tick than the check is a false divergence
indistinguishable from a real one.

A divergence is reported with its **frame**, which is the bisection point a desync
investigation starts from:

```
replay verify: PASS — 30/30 state hashes matched, 8 records fed
replay verify: FAIL — checked=30 matched=6 missing=0 firstDivergence=1400 expected=… actual=…
```

Verification never passes vacuously: a run that checked nothing, or that ended before
reaching every reference point (`missing > 0`), fails.

> **`stateHash` is a hex STRING in the dump, not a number** — see the stats-dump
> section's note. `--verify` parses it with `strtoull(…, 16)`.

> **Exit-code caveat.** The verdict is also the process exit code (0 pass / 2 fail),
> but `spring-server` has a **pre-existing** static-destruction crash
> (`CWeaponDefHandler` destructor, during `__cxa_finalize` *after* `main` returns and
> after `exited cleanly` is logged) that fires in any run where weapon defs were
> exercised — it reproduces with no replay flags at all. Until that is fixed, gate CI
> on the `replay verify:` log line, not on the exit status. See
> [Fixture-replay verify CI hook](#fixture-replay-verify-ci-hook) for the driver that
> does this.

### Seeking

```bash
spring-server --replay game.msr --replay-seek 3000
```

Fast-forwards to frame 3000 uncapped with **outbound streaming muted**, then resumes
normal pacing and streaming. Verified state-neutral: the same replay verifies
hash-exact with and without a seek.

Suppression is applied at the transport (`WebTransportServer::SetOutboundSuppressed`),
never by skipping the streamer tick — `StateStreamer::Tick` also evaluates standing
orders and macro directives, which *issue commands*, so skipping it would change the
simulation and land the seek on a different world.

Seek is currently a full fast-forward from the start rather than a jump: the algorithm
is "nearest checkpoint ≤ target, then fast-forward", and the checkpoint index is empty
until PLAN-persistence's sim serializer lands. It is frame-exact either way, just
slower for late targets.

### What a replay does and does not carry

Recorded (the five funnel chokepoints): raw client wire messages, player disconnects,
`/api/exec` Lua, AI commands, the GameStart anchor, and GM snapshot-restore markers.

**Not** recorded: anything the sim causes itself (factory rally orders, retaliation,
gadget-issued commands) — re-execution reproduces those, and recording them would
double-apply.

Two gaps to know about:

- **Games with human players do not replay end-to-end yet.** The wire bytes are
  re-fed under their recorded connection id, but a recorded `AuthRequest` re-enters
  `db.ValidateSession` against a session row a replica database need not have. A
  replay of an AI/operator-driven game is complete; a replay of a human game will
  diverge at the point authentication decides team ownership.
- **A snapshot-restore record ends the segment.** Honouring it needs a mid-stream
  checkpoint restore, which does not exist yet. Per PLAN-replay §6 E2 a rollback
  starts a new segment anyway, so the next segment is a separate replay.

---

## Snapshot round-trip (`--snapshot-roundtrip`)

The populated-fixture assertion for the sim serializer (PLAN-persistence §8). The
codec tests prove the bytes survive; this proves a world **restored** from them goes
on behaving the same way, which needs a map, a def handler, real units and live
gadgets — so it runs on the real binary over real content, on the headless substrate
(uncapped, no client, like `--replay`).

```bash
build/debug/spring-server \
  --headless-run tools/headless-batch/fixtures/soak-ladder.json \
  --port 19133 --db /tmp/rt.sqlite --max-wall-min 10 \
  --snapshot-roundtrip 300:100        # checkpoint at frame 300, 100 ticks per arm
```

It checkpoints at the first frame at or past `<frame>`, runs `<ticks>` ticks recording
a determinism hash every tick, restores the checkpoint (the frame counter rewinds),
runs the same ticks again, and compares. `<ticks>` defaults to 100. Frame 0 is refused:
it is before GameStart, so the comparison would be two empty worlds agreeing.

**What must hold (the default `world` bar):**

- the restore is **byte-exact** — the checkpoint re-captured immediately after being
  applied is identical to the one applied (capture → apply → capture idempotence);
- the two continuations hold the **same roster** (no unit appears or vanishes);
- no unit differs in **vitals** (health / experience / recent damage).

**What is measured rather than asserted:** how far the two continuations' unit
transforms drift apart. A resumed world is *world*-identical, not *track*-identical —
`inCommand` is forced false, so every unit under a move order re-enters its front
command and re-plans (PLAN-persistence §7.1c, decision Q-P2 option D). `AMoveType`
state *is* captured as of option A (2026-08-12) and it made no difference to this
number: the re-entry is what re-plans, not the lost move state. The verdict
line carries the number on a pass as well as a failure:

```
snapshot round-trip: PASS [world bar] frames 300..400 - 100 state hashes DIVERGED,
checkpoint 64659 bytes, re-capture identical, terminal payload (64731 bytes) DIFFERS.
Continuation: 64/100 units differ in transform (max pos delta 116.119 elmos,
max heading delta 65.7 deg), 0 in vitals, roster identical
```

`--roundtrip-strict` adds the pre-decision bar: the two hash tracks and the two
terminal payloads must be identical as well. That bar is only meaningful on a fixture
with **nothing under a move order**, and the fixture for it is `roundtrip-static` —
26 staged units, no orders, no civilians, no convoys, no AI
(`scenarios/roundtrip_static.lua`). This pair is the standing regression check for
the snapshot walk:

```bash
build/debug/spring-server \
  --headless-run tools/headless-batch/fixtures/roundtrip-static.json \
  --port 19133 --db /tmp/rt.sqlite --max-wall-min 5 \
  --snapshot-roundtrip 60:20 --roundtrip-strict     # must PASS
```

Run it at `440:30` as well (same command, same fixture): that window crosses a wind
update and is the one that found Q-P6 — see below. Both windows must PASS.

It is not inert: neutralise Q-P4's `(activeIndex, id)` restore ordering and the same
run FAILS with that defect's own signature — `globals` (the RNG position) and `units`
disagree, and the re-capture stops being idempotent. Verified 2026-08-14.

⚠ **Do not run the strict bar on `soak-ladder`, and do not read an older claim that
it passes there.** It does not and has not: that war's civilians and convoys are
already under move orders at frame 2, so the declared re-planning drift (Q-P2
decision D — `inCommand` is forced false, the front command is re-entered) shows up
in every window. Measured 2026-08-14 at `60:20`: 30 of 134 units differ in transform,
max 30.213 elmos, first divergence at frame 61 — and the **2026-08-12 binary produces
byte-identical numbers**, so nothing regressed; the recipe was recorded against a
world it could not hold. A moving fixture is what the **default** (`world`) bar is
for.

**Pick the window with what you are testing in mind.** Some synced state has a period
longer than any default window, so a passing `60:20` says nothing about it. The wind
(`EnvResourceHandler`) is the worked example: its cycle is **450 frames**, and the frame
where the phase counter wraps draws two floats from the synced RNG. `--snapshot-roundtrip
440:30` is the window that crosses one, and it is the only run that can see a wind defect:

```bash
build/debug/spring-server --headless-run tools/headless-batch/fixtures/soak-ladder.json \
  --port 19133 --db /tmp/rt.sqlite --max-wall-min 8 \
  --snapshot-roundtrip 440:30     # crosses a wind update; world bar (movement re-derives)
```

With the wind section applied, both arms hold the same wind at frame 470 and
`envResources` is absent from the "sections that disagree" line. With the apply removed
(the matched control), the re-capture DIFFERS, the arms sit 30 frames apart in the cycle,
and `globals` byte 4 — the RNG position — diverges.

The same window on the **static** fixture is the one that found **Q-P6** (2026-08-14),
and it is now the second standing regression bar — `440:30 --roundtrip-strict` on
`roundtrip-static` **must PASS**. It found the defect by holding all 30 hashes and every
unit identical and still failing, on `gameRules` alone: the restored arm re-published its
rules params under differently spelled keys (`warlog_1_kind` → `warlog_1.0_kind`,
`objective_3_state` → `objective_3.0_state`), because the synced-Lua walk restored
every number with `lua_pushnumber` and Lua 5.4 then stringifies an integer-valued
float as `1.0`. Fixed the same day by carrying Lua 5.4's integer subtype through the
codec (`syncedLua` v2). When a rules-params section disagrees, the verdict names the keys —
this is the failure it printed:

```
snapshot round-trip: gameRules — 63 vs 79 params; 0 differ in value,
12 only in arm A, 28 only in arm B. only A: warlog_1_detail, … only B:
objective_3.0_progress, …
```

Before Q-P4 (2026-08-12) that run failed on the *first* tick with every unit
byte-identical, because the restore rebuilt `activeUnits` in ascending-id order rather
than the captured insertion order and `CWeapon::SlowUpdate` — reached through the
staggered `SlowUpdateUnits` slice — draws from the synced RNG. If it ever fails that
way again, the fastest diagnosis is to count synced draws per frame per arm rather
than to read the sections: a `globals` byte-4 difference is the RNG *position*, which
means only one thing, that the two arms drew a different number of times.

Read the **verdict line, not the exit code**: `spring-server` aborts during static
destruction in any run that exercised weapon defs (PLAN-replay T2-b), so every
headless run exits 134 whatever the verdict was. The same constraint applies to
`--verify`.

### Resuming across a balance patch (`gamedata/migrations.lua`)

A snapshot records the def vocabulary it was taken under (the `defNames` section),
and the restore path reconciles every def reference in the payload against the live
def tables before it touches the world (PLAN-def-reconciliation tasks 1-2). Names are
the identity: a def that kept its name but moved id is **remapped**, a def that is gone
takes its units, features, build orders and order filters with it, and both are counted
in one WARNING line on restore:

```
snapshot restore: reconciling def references - 12 units removed with their def
(ms_scout_s1, …), 3 units renamed, 2 build orders dropped, 1 orders deactivated
(def filter emptied)
```

A game declares its own **renames** so a rename is not a removal. The file is optional
and its absence is the normal case:

```lua
-- data/games/<game>/gamedata/migrations.lua
return {
    units    = { ms_scout_s1 = "ms_recon_s1" },
    weapons  = { MS_AUTOCANNON_S1 = "MS_AUTOCANNON_MK2" },
    features = { wreck_scout = "wreck_recon" },
}
```

An alias whose target is ambiguous **refuses the resume** (`E1`): `a = "b"` while the
game still defines both, or two old names aliased onto one new one. Both are authoring
bugs with no correct answer, so they are loud rather than silently resolved — the
refusal happens in the staging phase, so the running world is untouched:

```
snapshot round-trip: FAILED - the restore failed: gamedata/migrations.lua aliases unit
def 'ms_artillery_s1' to 'ms_artillery_s2', but this game defines both - a rename whose
source still exists is ambiguous
```

Two things a game author should know about the removal side. **An order's def filter is
a whitelist whose empty state means "any squad"**, so an order that loses every def in
`squadTypes` is *deactivated* rather than left as a wildcard. And **per-weapon state
(reload, stockpile) follows the weapon def by name, not by slot number**, so inserting a
weapon into an existing def is safe: the new slot starts fresh and fully loaded, the old
slots keep their state.

### The two-def-load harness (`tools/scripts/def-reconcile-resume.sh`)

Everything above is exercised **inside one process** by the doctests and by
`--snapshot-roundtrip`, which cannot reach the case the reconcile pass exists for: a
world captured under one set of defs and restored under **another**, in a second
process, with the game's gadgets up. `tools/scripts/def-reconcile-resume.sh` is that
vehicle (PLAN-def-reconciliation task 5):

```
tools/scripts/def-reconcile-resume.sh            # all four arms, ~2m20s
tools/scripts/def-reconcile-resume.sh --arm tuning --keep
```

It clones `data/games/metalstorm` to a scratch game id, boots a **persistent war**
headless, ticks it, and stops it with **SIGTERM** — the deploy drain's own exit, and the
only exit that writes a resumable checkpoint (`--headless-run` reaching its stop
condition deliberately writes none: "its world is a fixture, not a war"). It then
patches the scratch tree's unit defs and boots a second server with `--resume` against
the same DB. Four arms, each asserting the engine's report lines, the `DefsReconciled`
call-in reaching a gadget, and the durable `game_events` row the game wrote:

| arm | patch | what must happen |
|---|---|---|
| `control` | none | indistinguishable from no patch: no reconcile lines, no `patch` events |
| `tuning` | `baseHp` 1400 → 2100 | scalars reconciled, health **fractions preserved**, war log says *N units retuned* |
| `rename-alias` | `ms_tanks_*` → `ms_panzers_*` **+ migrations.lua** | references rewritten, units survive, war log says *no visible change* |
| `rename-drop` | the same rename, no migration | units removed with their def, war log names the lost defs |

Two traps are baked into the script's shape and are worth knowing before editing it.
**The game id is not just a path:** `GameOverState.h`'s last-team-standing fallback is
gated off for the literal string `"metalstorm"` and nothing else, so a scratch copy under
any other id plays a *different* game — the fallback declared a winner at frame 60, and a
finished match takes no exit checkpoint. The `roundtrip_static` scenario keeps both
fallback teams alive, which is why it is the fixture. **The content root does not follow
symlinks:** a symlink farm over the 239 MB tree loads defs and models fine but does not
find `LuaRules/main.lua`, so synced Lua never comes up and the serializer silently
refuses to attach. The tree is cloned instead (`cp -Rc`, ~0.2 s on APFS).

Read the arm table the script prints, not the exit code of any single server: every
headless run exits 134 in the static-destruction abort (PLAN-replay T2-b).

---

## springcli — Command-Line Tool

`springcli` is a standalone CLI for interacting with Spring servers from bash, scripts, and Claude automation. It uses HTTP (not WebSocket/FlatBuffers) so it works with plain `curl`-like simplicity.

### Building

```bash
cmake --build build/debug --target springcli
# Binary: build/debug/tools/springcli/springcli
```

### Commands

```bash
# Game server port is dynamic — discover it first:
#   springcli processes --lobby http://localhost:8011
#   or: GET http://localhost:8011/api/processes
# Then use the port from the response (shown as $PORT below).

# Game server commands (scope: server)
springcli state --server http://localhost:$PORT
springcli frame --server http://localhost:$PORT
springcli defs  --server http://localhost:$PORT
springcli units --server http://localhost:$PORT --team 0
springcli pause --server http://localhost:$PORT
springcli unpause --server http://localhost:$PORT
springcli speed 2.0 --server http://localhost:$PORT

# Lua execution
springcli lua "return Spring.GetAllUnits()" --server http://localhost:$PORT
springcli lua "return Spring.GetUnitHealth(1)" --server http://localhost:$PORT
springcli exec LuaRules "return 1+1" --server http://localhost:$PORT
springcli exec LuaGaia "return Spring.GetGameFrame()" --server http://localhost:$PORT

# Multi-line Lua (quotes handle newlines)
springcli lua 'local t = {} for i=1,5 do t[i]=i*i end return t' --server http://localhost:$PORT

# Lobby commands
springcli sql "SELECT id, username FROM users" --lobby http://localhost:8011
springcli exec lobby "process list" --server http://localhost:8011
springcli processes --lobby http://localhost:8011

# Log server queries
springcli logs --log-server http://localhost:8010 --level 4 --limit 10
springcli logs --log-server http://localhost:8010 --search "runtime error"

# Raw HTTP (escape hatch)
springcli get http://localhost:8010/api/logs/sources
springcli post http://localhost:8011/api/exec '{"scope":"sql","code":"SELECT 1"}'
```

### Environment Variables

Set these to avoid repeating `--server` / `--lobby` / `--log-server`:

```bash
export SPRING_SERVER=http://localhost:$PORT  # dynamic — discover via springcli processes
export SPRING_LOBBY=http://localhost:8011
export SPRING_LOG_SERVER=http://localhost:8010

# Now just:
springcli state
springcli lua "return 42"
springcli sql "SELECT count(*) FROM users"
```

### Flags

| Flag | Description |
|------|-------------|
| `--server URL` | Game server (dynamic port — discover via `springcli processes` or `GET /api/processes` on lobby) |
| `--lobby URL` | Lobby server (default: `$SPRING_LOBBY` or `localhost:8011`) |
| `--log-server URL` | Log server (default: `$SPRING_LOG_SERVER` or `localhost:8010`) |
| `--scope SCOPE` | Lua scope for `lua` command (default: LuaRules) |
| `--level N` | Min log level for `logs` command |
| `--section S` | Filter logs by section |
| `--search Q` | Search log messages |
| `--limit N` | Max results (default: 50) |
| `--team N` | Filter units by team |
| `--json` | Output raw JSON |
| `-q` | Quiet: output only the result value, no "error:" prefix |

### Exit Codes

- `0` — success
- `1` — command failed (Lua error, connection failed, etc.)
- `2` — usage error (missing arguments)

### HTTP Exec API

`springcli` uses `POST /api/exec` endpoints added to both servers:

```bash
# Equivalent to: springcli exec server state
curl -s -X POST http://localhost:<game-port>/api/exec \
  -H "Content-Type: application/json" \
  -d '{"scope":"server","code":"state"}'
# → {"success":true,"output":"frame=1234 teams=3 units=5"}

# Equivalent to: springcli sql "SELECT 1"
curl -s -X POST http://localhost:8011/api/exec \
  -H "Content-Type: application/json" \
  -d '{"scope":"sql","code":"SELECT 1"}'
# → {"success":true,"output":"1=1"}
```

### Structured server verbs (json prefix)

A leading `json ` token on a `scope:"server"` exec command switches the
converted verbs from free text to a serialized JSON object. Nothing else
changes: same route, same envelope, same `success` derivation.

```bash
curl -s -X POST http://localhost:<game-port>/api/exec \
  -d '{"scope":"server","code":"json state"}'
# → {"success":true,"output":"{\"frame\":798,\"luaHeapKb\":3692,\"paused\":false,
#      \"speed\":1.0,\"teams\":3,\"units\":100}"}
```

The reply travels as a **string** inside `output`, so a caller parses twice
(envelope, then `output`). The same prefix works from the browser via
`window.test.server('json state')` and from `debugConsole.exec`.

| Verb | JSON shape |
|------|-----------|
| `json frame` | `{frame}` |
| `json state` | `{frame, paused, speed, teams, units, luaHeapKb}` — `speed` is the *applied* `speedFactor`; `luaHeapKb` is 0 when LuaRules is not loaded |
| `json units [team]` | `{total, returned, units:[{id, def, team, hp, maxHp, x, y, z}]}` — `total` counts every match of the filter, `units` caps at 100 |
| `json unit_state <id>` | `{id, def, team, hp, maxHp, pos:{x,y,z}, heading, weapons:[{index, def, range, reloadFrame, hasTarget}]}` — `index` is the unit's own weapon slot; null slots are skipped, so the array can be shorter than the slot count |
| `json combat_summary` | `{combat, sounds}` |
| `json log status` | `{combat, sound, weapon, explosion, order, unit, script}` (booleans) |
| `json los status` | `{globalLos:[bool]}`, indexed by ally team |
| `json cheats status` | `{cheatEnabled, godMode}` |
| `json spawn <def> <x> <z> [team] [count]` | `{spawned, ids:[int]}` |

Rules worth knowing before you rely on it:

- **The prefix is a request, not a guarantee.** An *unconverted* verb (e.g.
  `json pause`, `lua profile`, the debugger verbs, every mutation ack) runs
  normally and answers its legacy text. Parse defensively.
- **Errors inside a converted verb come back `success:true`** with an
  `{"error":"..."}` body — the server derives `success` solely from a leading
  `unknown command:`. Check the `error` key, not just the flag.
- **Capability probe:** a game server predating this prefix does not strip the
  token, so it answers `unknown command: json <verb>` with `success:false`.
  That exact string is what the MCP's `execJsonVerb` helper keys its legacy
  fallback off — no version negotiation, no new endpoint.
- **`json spawn` runs through LuaRules**, so its non-JSON failure modes
  (`error: LuaRules not loaded`, a Lua `syntax error:` from a quote in the def
  name) are error strings, not old-binary fallbacks.
- **Legacy output is byte-identical**, deliberately — including `units`'
  `... (N total)` line reporting the *unfiltered* active count. Only the JSON
  arm reports an honest filtered `total`.

### libspringapi

The CLI is built on `libspringapi`, a static C++ library with a simple HTTP-based API:

```cpp
#include "springapi.h"

auto r = springapi::exec("http://localhost:<game-port>", "LuaRules", "return 42");
// r.success == true, r.output == "42"

auto logs = springapi::getLogs("http://localhost:8010", 0, 4, 10);
auto procs = springapi::getProcesses("http://localhost:8011");
```

Zero external dependencies — uses raw POSIX sockets for HTTP.

---

## mprocs Development Environment

The `mprocs.yaml` file defines the development process group:

| Process | Command | Purpose |
|---------|---------|---------|
| `logserver` | `./build/debug/spring-logserver --port 8010 --db data/debug.db` | Log collection |
| `lobby` | `./build/debug/spring-lobby --port 8011 ...` | Game lobby |
| `client` | `cd client && npx vite dev --port 8012` | Browser client |
| `game-logs` | `tail -F data/logs/game-*.log` | Raw log file tail |
| `lua-errors` | `tail ... \| grep -iE '(error\|warning\|FATAL)'` | Filtered error view |

Start with `mprocs` from the project root. Each process runs in its own pane.

### Remote control (restart a single pane)

`mprocs.yaml` sets `server: 127.0.0.1:4050`, which makes the running mprocs
listen for control commands. This lets scripts/MCP restart **one** pane without
killing it out from under mprocs (a bare `kill` leaves a dead pane and risks a
duplicate listener that round-robins the port via `SO_REUSEPORT`, so requests
hit a stale binary).

`tools/scripts/spring-services.sh` drives it:

```bash
spring-services.sh status          # lists services + whether mprocs-ctl is reachable
spring-services.sh restart client  # restart just the Vite pane (select-proc + restart-proc)
spring-services.sh restart all     # restart-all
spring-services.sh ctl '{c: restart-all}'   # send a raw mprocs command
```

Panes: `logserver | lobby | server | client | game-logs | lua-errors | all`.
The script maps a pane **name** to the index mprocs `select-proc` expects by
parsing `mprocs.yaml`, so it stays correct if panes are reordered.

**The control server only exists if mprocs was started with the `server:` key.**
If you started mprocs before this was configured, `status` shows `mprocs-ctl not
reachable` and `restart` falls back to kill+relaunch (which can't touch the
mprocs-only `game-logs`/`lua-errors` tails) — restart mprocs once to open the
port.

**When to use which restart.** The C++ servers self-re-exec in place — prefer
`restart_lobby` / `restart_logserver` / `restart_game` (spring-debug MCP) or
`SIGHUP` after rebuilding a C++ binary: same PID, mprocs stays authoritative, and
running game servers are preserved (see the [spring-debug](../.claude/skills/spring-debug/SKILL.md)
skill). Use `spring-services.sh restart client` for the **Vite** pane
specifically — it's a node process with no in-place re-exec, and Vite otherwise
serves a stale `?worker` bundle after you edit a worker-imported file
(`entity-renderer.ts`, `game-processor.ts`, …). The raw `mprocs --ctl '{c: …}'`
vocabulary (`restart-proc`, `restart-all`, `select-proc`, `add-proc`, `start-proc`,
`term-proc`, `send-key`, `batch`, …) is documented in the mprocs README.
