# Debugging & Logging Guide

This is the hub page for debugging, logging, and performance tooling. It's written for both engine developers working on the C++ server and game authors writing Lua gadgets. Detailed content lives in the linked sub-pages below — this page covers the quick start and shared architecture.

## Sub-pages

| Page | Covers |
|---|---|
| [debugging-logging.md](debugging-logging.md) | `libspringlog` (levels, C API, C++ macros, sinks), `spring-logserver` (HTTP query API, WebSocket protocol, SQLite persistence), game session tracking, adding a custom sink |
| [debugging-console.md](debugging-console.md) | Browser debug console (tabs, filters, programmatic API), the `Spring.*` Lua debug API, the interactive Lua debugger (breakpoints/stepping), the Babylon.js inspector, adding a server command |
| [debugging-tools.md](debugging-tools.md) | The read-only SQL proxy, process management, Claude/MCP integration (`tools/debug-mcp`), the standalone `springcli` CLI, the `mprocs` dev environment |
| [debugging-performance.md](debugging-performance.md) | The permanent per-phase **FrameProfiler** (`perfDump`), the per-widget **LuaUI cost profiler** (`uiProfileStart/Dump/Stop`), and the **network simulator** (`netSim*`/`netStats`) — everything for measuring and characterising client performance |

---

## Quick Start

Start the full development stack with [mprocs](https://github.com/pvolok/mprocs):

```bash
make build                    # Build all C++ targets
mprocs                        # Starts logserver, lobby, client dev server, log tails
```

Or start processes individually:

```bash
# Terminal 1: Log server (start first)
./build/debug/spring-logserver --port 8010 --db data/debug.db

# Terminal 2: Lobby
./build/debug/spring-lobby --port 8011 --game content/games/papertanks \
  --maps content/maps --games-dir content/games --db data/spring-server.db

# Terminal 3: Client dev server
cd client && GAME_SERVER_PORT=8011 npx vite dev --port 8012
```

Open `http://localhost:8012` in a browser, then press **backtick (`)** to open the debug console (see [debugging-console.md](debugging-console.md)).

---

## Architecture Overview

```
                          spring-logserver (:8010)
                            SQLite (debug.db)
                            Ring buffer (2000/source)
                            HTTP query API
                                 |
          +-----------+----------+-----------+
          |           |                      |
     spring-lobby  spring-server        browser client
     (springlog)   (springlog)          debug console
          |           |                connects to
          |           |                log server WS
          +-----------+
           game servers
           spawned by lobby
```

Every process uses `libspringlog` for logging. Log entries go to stdout/stderr and optionally to the log server (via `springlog-net`) or a local SQLite database (via `springlog-sqlite`). The browser debug console connects directly to the log server for log streaming and to the game server for command execution. See [debugging-logging.md](debugging-logging.md) for the full logging pipeline.

**Key files:**

| Component | Files |
|-----------|-------|
| Core logging library | `rts/System/SpringLog/SpringLog.h`, `SpringLog.cpp` |
| Network sink | `rts/System/SpringLog/SpringLogNet.h/.cpp` |
| SQLite sink | `rts/System/SpringLog/SpringLogSqlite.h/.cpp` |
| Legacy bridge | `rts/System/SpringLogBridge.h/.cpp` |
| Log server | `rts/logserver_main.cpp` |
| Command execution | `rts/Server/LuaExecEngine.h/.cpp` |
| Lua debugger | `rts/Server/LuaDebugger.h/.cpp` |
| Lua debug API | `rts/Lua/LuaSyncedCtrl.cpp` (bottom) |
| Browser console | `client/src/core/debug-console.ts` |
| Network inspector | `client/src/core/net-inspector.ts` |
| Frame profiler | `client/src/core/frame-profiler.ts` |
| LuaUI widget profiler | `client/src/core/widget-profiler.ts` |
| Test harness (`window.test`) | `client/src/core/test-harness.ts` |
| MCP server | `tools/debug-mcp/server.js` |

## Client Crash Recovery & Error Reports

When the client's game-processor worker dies, wedges, or loses its WebGL context, the client
tries to recover itself and files a crash report. This section is how to read what comes out of
that. Design: [PLAN-client-resilience.md](../PLAN-client-resilience.md).

### The recovery ladder

The whole client game path — render, network, LuaUI — lives in one worker, so a worker fault is a
black screen unless something catches it. Three detectors feed one ladder
(`client/src/core/recovery-ladder.ts`, owned by the **main** thread so it survives worker
termination):

| Rung | Fires when | What happens | What the player sees |
|---|---|---|---|
| **R1 soft** | WebGL context restored within the grace window (5 s) | in-place subsystem reset in the live worker (Babylon `wipeCaches`, FX pool flush, state resync) | a hitch, then play continues |
| **R2 respawn** | wedged watchdog, worker fatal, context lost that never restores, or R1 failed | terminate + respawn the worker on the boot path; reconnect and re-sync from the server | a full-boot pause; sim state is intact (the server is authoritative) |
| **R3 give up** | R2 exhausted its budget | terminal error screen carrying a **report id** | an honest failure with a handle to quote in a bug report |

**Loop guard.** Escalation is monotonic inside a rolling 5-minute window: at most 2 R1s, then the
next trigger becomes R2; at most 2 R2s, then R3. R3 is terminal — later triggers are ignored.
So a crash-looping subsystem reaches R3 in at most `2+2+1 = 5` recoveries instead of ping-ponging
R1 forever. If a report shows rung `R3`, the ladder gave up on purpose; that is not a second bug.

**Detectors.** `worker.onerror`/`onmessageerror` plus a worker-side global error hook (fatals),
a 2 s heartbeat with a 3-miss threshold (wedged — a blocked event loop, which `onerror`
structurally cannot catch), and `webglcontextlost`/`restored`. The heartbeat rides its own
`setInterval`, not the frame loop, so a 90 ms frame does **not** miss a beat; it is suppressed
while the tab is hidden or `test.pause()` is active.

### Injecting a fault on purpose

The ladder is untestable without a way to break the worker deliberately. From the debug console
or any `window.test` context:

```js
await test.injectWorkerError('throw')         // synchronous fatal in the worker
await test.injectWorkerError('rejection')     // unhandled promise rejection
await test.injectWorkerError('wedge-loop')    // block the event loop → watchdog → R2
await test.injectWorkerError('context-loss')  // WEBGL_lose_context → R1 (or R2 if it never restores)
```

Each kind should produce its expected rung, a recovered (or honestly-failed) client, and exactly
one report group on the dashboard.

### Where reports land

The client POSTs to **`POST /api/client-errors`** on the lobby (see
[api.md](api.md#client-error-reports)); the lobby stores them in the `client_errors` table of its
SQLite DB. Two independent report streams share that table:

- **Per-crash reports** from the detection hooks — rich context, `recovery_rung` = `none`.
- **One rung event per recovery** from the ladder — `error_class` = `RecoveryLadder`, message
  `"<rung> recovery (<reportId>); triggers: a → b"`. This is what tells you the *path* taken.
  The `reportId` here is the same id shown on the R3 error screen.

Caps, in the order they apply: the client dedups by stack hash, caps itself at 5 sends/hour per
session and 32 KB per payload; the lobby rejects over 40 KB (413) and over 20 reports/hour per
account (429). A crash loop therefore arrives as **one row with a high `count`**, not a flood.

**Payload contents:** error class, message, stack, recovery rung, frame + phase slice, entity
count, game/map id, build stamp, GPU renderer string, and the last log-ring lines. No PII beyond
the account id.

### Reading the dashboard crash view

The GM dashboard (`GET /admin`, admin login — see [gm-tools.md](gm-tools.md)) has a **Client
crashes** card: `client_errors` grouped by stack hash, most-recently-seen first, over a
selectable window (24 h / 7 d / 30 d / all retained).

| Column | Means |
|---|---|
| **error** | class + message of the **newest** report in the group, with the stack hash under it |
| **occurrences** | `SUM(count)` — includes the repeats the client deduped away before sending |
| **reports** | rows actually stored. 1 report / 40 occurrences is one client crash-looping |
| **users** | distinct accounts hit. An unattributed report has `user_id` 0 and counts as one |
| **first/last seen** | when the crash site was first and last observed |
| **builds** | build-stamp range. A range that *starts* at the current build is a new regression |
| **rung** | the newest report's rung — how far the ladder had to go |
| **games** | distinct game ids the crash was seen in |

Clicking a row opens the drill-down: newest full stack, its log-ring tail, and every stored
occurrence. **Export JSON** downloads that response verbatim for filing an issue.

**Grouping is by stack hash, not by message** — the hash is computed client-side over error class
+ message + stack shape, so the same crash site from two accounts collapses into one row.

> **Minified-stack caveat.** Frames read like `a.b (chunk-9f.js:1:2345)`. There is no source-map
> upload pipeline — the client ships minified and the server has no map to symbolicate against
> (a documented gap, blocked on there being a `vite build` deploy pipeline to hook). Grouping is
> unaffected (it is by hash), but reading a stack means matching it against a build of the same
> stamp by hand. Quote the **build stamp** in any bug filed from these rows.

The backing routes are admin-only, because reports carry account ids, stacks and log lines:

```bash
curl -X POST http://localhost:8011/api/admin/client-errors \
  -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"sinceDays":7,"limit":100}'
curl -X POST http://localhost:8011/api/admin/client-errors/detail \
  -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"stack_hash":"9f3a11cc"}'
```

### Retention and the opt-out

- `--client-error-retention-days N` (lobby, default **30**) — reports older than `N` days are
  deleted at startup and hourly thereafter. `0` or negative disables pruning and keeps
  everything; it never means "delete everything". The dashboard shows the active retention next
  to the card title, so an empty view is distinguishable from a pruned one.
- `--disable-client-error-reports` (lobby) — turns the channel off entirely. Surfaced to the
  client as `errorReportingEnabled:false` on `GET /api/version`, so the client stops sending
  rather than posting into a 404. Default is **enabled**; a self-hosted deployment that wants no
  telemetry passes this flag.

## Related Claude skills

- **`spring-debug`** — logs, Lua/SQL execution, process management (`.claude/skills/spring-debug/SKILL.md`)
- **`spring-test`** — the `window.test` harness, scripted spawn/order/damage verbs, camera control, and performance profiling (`.claude/skills/spring-test/SKILL.md`)
- **`game-browser-test`** — driving the full client in a real browser via chrome-devtools MCP (`.claude/skills/game-browser-test/SKILL.md`)
