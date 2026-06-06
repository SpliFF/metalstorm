# Debugging & Logging Guide

This document covers the unified logging system, browser debug console, Lua debugging API, interactive debugger, network inspector, and Claude/MCP integration. It is written for both engine developers working on the C++ server and game authors writing Lua gadgets.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Architecture Overview](#architecture-overview)
- [Unified Logging (libspringlog)](#unified-logging-libspringlog)
  - [Log Levels](#log-levels)
  - [C API](#c-api)
  - [C++ Macros](#c-macros)
  - [Output Formats](#output-formats)
  - [Optional Sinks](#optional-sinks)
  - [Environment Variables](#environment-variables)
  - [CLI Flags](#cli-flags)
- [Log Server (spring-logserver)](#log-server-spring-logserver)
  - [Running the Log Server](#running-the-log-server)
  - [HTTP Query API](#http-query-api)
  - [WebSocket Protocol](#websocket-protocol)
  - [Ring Buffer](#ring-buffer)
  - [SQLite Persistence](#sqlite-persistence)
- [Browser Debug Console](#browser-debug-console)
  - [Opening the Console](#opening-the-console)
  - [Log Viewer](#log-viewer)
  - [Command Input](#command-input)
  - [Execution Scopes](#execution-scopes)
  - [Meta-Commands](#meta-commands)
  - [Server Commands](#server-commands)
  - [Network Inspector](#network-inspector)
- [Lua Debug API](#lua-debug-api)
  - [Spring.Debug](#springdebug)
  - [Spring.Warn](#springwarn)
  - [Spring.Assert](#springassert)
  - [Spring.DumpTable](#springdumptable)
  - [Spring.Inspect](#springinspect)
  - [Spring.Log](#springlog)
  - [Spring.Echo / Spring.Error](#springecho--springerror)
- [Interactive Lua Debugger](#interactive-lua-debugger)
  - [Setting Breakpoints](#setting-breakpoints)
  - [Stepping](#stepping)
  - [Stack and Variable Inspection](#stack-and-variable-inspection)
  - [Sim Pause Behavior](#sim-pause-behavior)
- [SQL Query Proxy](#sql-query-proxy)
- [Process Management](#process-management)
- [Game Session Tracking](#game-session-tracking)
- [Babylon.js Inspector](#babylonjs-inspector)
- [Claude / MCP Integration](#claude--mcp-integration)
  - [MCP Server Setup](#mcp-server-setup)
  - [Available Tools](#available-tools)
- [mprocs Development Environment](#mprocs-development-environment)
- [Extending the System](#extending-the-system)
  - [Adding a Custom Sink](#adding-a-custom-sink)
  - [Adding a Server Command](#adding-a-server-command)

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

Open `http://localhost:8012` in a browser, then press **backtick (`)** to open the debug console.

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

Every process uses `libspringlog` for logging. Log entries go to stdout/stderr and optionally to the log server (via `springlog-net`) or a local SQLite database (via `springlog-sqlite`). The browser debug console connects directly to the log server for log streaming and to the game server for command execution.

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
| MCP server | `tools/debug-mcp/server.js` |

---

## Unified Logging (libspringlog)

`libspringlog` is a shared library with a C-compatible API. Every executable in the project links it. It provides structured log records with level, section, scope, process name, sim frame, and message.

### Log Levels

| Level | Value | Use for |
|-------|-------|---------|
| `SPRING_LOG_DEBUG` | 0 | Verbose diagnostic output, command routing details |
| `SPRING_LOG_INFO` | 1 | Normal operation (map loaded, subsystem initialized) |
| `SPRING_LOG_NOTICE` | 2 | Important state changes (player connected, game started) |
| `SPRING_LOG_WARNING` | 3 | Non-fatal issues (malformed args, missing optional files) |
| `SPRING_LOG_ERROR` | 4 | Failures (database open failed, Lua syntax error) |
| `SPRING_LOG_FATAL` | 5 | Unrecoverable errors |

The default minimum level is `NOTICE`. Messages below the minimum are silently dropped.

### C API

```c
#include "System/SpringLog/SpringLog.h"

// Initialize at process start
springlog_init("my-process", SPRING_LOG_OUTPUT_CONSOLE);

// Log a message
springlog_log(SPRING_LOG_NOTICE, "section", "scope", frame, "format %s", arg);

// Set simulation frame (call each tick)
springlog_set_frame(frameNum);

// Register a custom sink
int sinkId = springlog_add_sink(mySinkFn, myUserdata);

// Clean up
springlog_shutdown();
```

### C++ Macros

Every C++ source file that logs should define `LOG_SECTION` at the top:

```cpp
#include "System/SpringLog/SpringLog.h"
#define LOG_SECTION "sim"

// Simple log (uses LOG_SECTION, current frame)
SLOG(SPRING_LOG_NOTICE, "loaded %u unit defs", count);

// Log with explicit scope (for Lua handles, AI names)
SLOG_SCOPED(SPRING_LOG_ERROR, "LuaRules", "runtime error: %s", msg);
```

The `SLOG` macro expands to:

```cpp
springlog_log(level, LOG_SECTION, "", springlog_get_frame(), fmt, ...)
```

### Output Formats

**Console** (stdout for level < ERROR, stderr for ERROR and above):

```
[spring-server:sim] loaded 42 unit defs
[spring-server:lua:LuaRules] runtime error in callin 'GameFrame': ...
```

**File** (structured, machine-parseable):

```
@L|NOTICE|sim||1234|loaded 42 unit defs
@L|ERROR|lua|LuaRules|1234|runtime error in callin 'GameFrame': ...
```

### Optional Sinks

**Network sink** (`springlog-net`) -- intended to stream log entries to the log server over a persistent WebSocket. **Currently a collection-only stub** (`SpringLogNet.cpp`): it buffers entries but does not yet send them, and the lobby does not pass `--log-server` to spawned game servers. In practice, game-server and lobby logs reach the log server through the **shared SQLite file** (`data/debug.db`): every process enables the SQLite sink (defaulting to that path), and the log server reads the same file for its HTTP query/search endpoints. This is why room/game-scoped queries hit SQLite rather than the in-memory ring buffer (which only holds the log server's own logs plus browser logs POSTed to `/api/logs/ingest`).

```cpp
#include "System/SpringLog/SpringLogNet.h"
springlog_net_init("ws://localhost:8010", "auth-token");
// ... logging ...
springlog_net_shutdown();
```

**SQLite sink** (`springlog-sqlite`) -- writes log entries to a local SQLite database on a background thread. Batches writes in transactions (every 1 second or 100 entries). Only persists entries at NOTICE level and above.

```cpp
#include "System/SpringLog/SpringLogSqlite.h"
springlog_sqlite_init("data/debug.db");
// ... logging ...
springlog_sqlite_shutdown();
```

### Environment Variables

| Variable | Effect |
|----------|--------|
| `SPRING_LOG_LEVEL` | Set min level: `debug`, `info`, `notice`, `warning`, `error`, `fatal` |
| `SPRING_LOG_FILE` | Enable file sink at the given path |
| `SPRING_DEBUG=1` | Set min level to DEBUG |

### CLI Flags

These flags are parsed by the executable's own argument handling (not by libspringlog):

| Flag | Applies to | Effect |
|------|-----------|--------|
| `--log-file <path>` | server, lobby | Enable file sink |
| `--log-level <level>` | server, lobby, tools | Set minimum level |
| `--log-server <url>` | server, tools | Connect to log server (springlog-net) |
| `--log-sqlite <path>` | server | Enable SQLite sink |
| `--debug` | server, lobby | Set level to DEBUG |
| `--log-messages` | server | Log every dispatched WS message type + size |

---

## Log Server (spring-logserver)

A dedicated process that collects, stores, and streams log entries. It is the single source of truth for all logs in the system.

### Running the Log Server

```bash
./build/debug/spring-logserver --port 8010 --db data/debug.db
```

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 8010 | HTTP + WebSocket listen port |
| `--db` | `data/debug.db` | SQLite database path |
| `--log-level` | notice | Minimum level for the log server's own logs |

### HTTP Query API

All endpoints return JSON with `Access-Control-Allow-Origin: *`.

**GET /api/logs/:roomId**

Fetch recent log entries. A non-zero `roomId` scopes results to a single game/room: each game server is launched with `--room <id>` and tags every log entry it writes with that room id (and its game id), so logs from concurrent or past games can be filtered apart in the shared store.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `roomId` (path) | int | required | Room ID (use `0` for all sources) |
| `limit` | int | 200 | Maximum entries to return |
| `level` | int | 0 | Minimum log level |
| `section` | string | | Filter by section (exact match) |
| `scope` | string | | Filter by scope (exact match) |
| `game` | string | | Filter by game content id (e.g. `zk`) |
| `since` | int | | Only entries with `timestamp >= since` (ms epoch) |

Returned entries now include `room_id` and `game_id` fields. The `room_id` filter is backed by the `idx_debug_logs_room` index. Note: a specific `roomId`/`game`/`since` always queries the persisted SQLite store (game-server logs live only there — see the network-sink note below).

Response:

```json
[
  {
    "id": 42,
    "timestamp": 1713024000000,
    "level": 4,
    "section": "lua",
    "scope": "LuaRules",
    "process": "spring-server",
    "frame": 1234,
    "message": "runtime error in callin 'GameFrame': ..."
  }
]
```

**GET /api/logs/search**

Full-text search across log entries. Add a `room`/`game`/`section` selector and/or a `since` window to scope the search — without one, results span the entire history of every game ever run.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `q` | string | | Search text (substring match on message). Optional if `room`/`game`/`section` is given |
| `room` | int | | Scope to one room/game instance |
| `game` | string | | Filter by game content id |
| `section` | string | | Filter by section (exact match) |
| `since` | int | | Only entries with `timestamp >= since` (ms epoch) |
| `limit` | int | 200 | Maximum results |
| `level` | int | 0 | Minimum log level |

**GET /api/sessions**

List recent game sessions.

```json
[
  {
    "session_id": "abc-123",
    "room_id": 1,
    "game_name": "papertanks",
    "map_name": "wanderlust2.1",
    "started_at": 1713024000,
    "ended_at": 1713025000,
    "end_reason": "normal",
    "exit_code": 0
  }
]
```

**GET /api/logs/sources**

Returns `{"status":"ok"}` (health check).

### WebSocket Protocol

Connect to the log server's WS endpoint at `ws://localhost:8010/`. All messages use the standard Spring Web envelope: `[0x01, ...FlatBuffers data]`.

**Client -> Log Server:**

| Message | Purpose |
|---------|---------|
| `LogIngest { entries: [LogEntryMsg] }` | Push log entries for storage |
| `LogSubscribe { room_id, min_level, section_filter, scope_filter }` | Start receiving log stream |
| `LogUnsubscribe {}` | Stop receiving log stream |

**Log Server -> Client:**

| Message | Purpose |
|---------|---------|
| `LogBatch { room_id, entries: [LogEntryMsg], latest_id }` | Streamed log entries |

### Ring Buffer

The log server maintains per-source ring buffers (keyed by `room_id`) plus an aggregate buffer (source 0). Each buffer holds up to 2000 entries. When full, the oldest entry is evicted. Entries are assigned monotonically increasing IDs for cursor-based pagination.

### SQLite Persistence

The log server's SQLite sink uses the same `debug_logs` schema as `springlog-sqlite`. Additionally, it creates a `game_sessions` table:

```sql
CREATE TABLE game_sessions (
    session_id TEXT PRIMARY KEY,
    room_id INTEGER,
    game_name TEXT,
    map_name TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    end_reason TEXT,       -- "normal", "crash", "killed", "timeout"
    exit_code INTEGER,
    player_count INTEGER,
    ai_count INTEGER
);
```

---

## Browser Debug Console

A tabbed in-game overlay for log viewing and command execution. Each tab has independent scope, filters, history, and output. Tabs can be popped out to standalone windows.

### Opening the Console

- Press **backtick (`)** to toggle the console
- Or call `debugConsole.show()` from code / browser devtools

The console survives lobby restarts -- its log server connection is independent.

### Tabs

The tab bar shows all open console sessions. Each tab is an independent workspace:

- **Click** a tab label to switch to it
- **+** button creates a new tab (defaults to LuaRules scope)
- **x** closes a tab (closing the last tab hides the console)
- **arrow** button pops the tab out to its own browser window

Each tab maintains its own:
- Execution scope (LuaRules, server, sql, etc.)
- Log level/section/scope/search filters
- Command history (Up/Down arrows)
- Output buffer

### Dock / Undock

Click the arrow button on any tab to pop it out to a standalone window. The popout window contains the full panel (filters, output, command input) and works independently. Closing the popout window re-docks the tab back into the main console.

Use this to keep a Lua REPL open in one window while monitoring logs filtered to errors in another.

### Log Viewer

Each tab's output area displays log entries color-coded by level:

| Level | Color |
|-------|-------|
| DEBUG | grey |
| INFO | light grey |
| NOTICE | white |
| WARNING | yellow, tinted background |
| ERROR | red, tinted background |
| FATAL | bright red, bold |

**Filtering** (per tab, in the filter bar):

- **Level dropdown** -- minimum level (default: NOTICE)
- **Section** -- filter by section name (substring, case-insensitive)
- **Scope** -- filter by scope name (substring, case-insensitive)
- **Search** -- filter by message text (substring, case-insensitive)
- **Clear** -- clear the tab's output

Auto-scroll pauses when you scroll up and resumes when you scroll to the bottom.

### Command Input

The bottom bar has a scope selector, prompt, and a multi-line textarea.

- **Enter** -- execute the command
- **Shift+Enter** -- insert a newline (for multi-line Lua scripts)
- **Up/Down arrows** -- navigate command history (when input is empty)
- **Copy/paste** -- standard clipboard operations work in the textarea and output

Multi-line example:

```
LuaRules> local t = {}
          for i = 1, 5 do
            t[i] = i * i
          end
          return t
  {[1] = 1, [2] = 4, [3] = 9, [4] = 16, [5] = 25}
```

### Programmatic API

The debug console exposes a `debugConsole.exec()` method for automation. This is the preferred way for Claude (via chrome tools) and scripts to execute commands -- no DOM event simulation needed.

```javascript
// Available on window.debugConsole after init()

// Execute a command and get the result
const result = await debugConsole.exec('server', 'frame');
// result = { success: true, output: "1234" }

// Lua execution
const r = await debugConsole.exec('LuaRules', 'return Spring.GetAllUnits()');
// r = { success: true, output: "{1, 2, 3}" }

// Multi-line Lua
const r2 = await debugConsole.exec('LuaRules', `
local t = {}
for i = 1, 5 do t[i] = i * i end
return t
`);
// r2 = { success: true, output: "{[1] = 1, [2] = 4, ...}" }

// Error handling
const r3 = await debugConsole.exec('LuaRules', 'bad syntax');
// r3 = { success: false, output: "syntax error: ..." }
```

The `exec()` method sends a `ConsoleCommand` FlatBuffer to the game server and returns a Promise that resolves when the `ConsoleResponse` arrives (10s timeout).

### Execution Scopes

| Scope | Target | What it runs |
|-------|--------|-------------|
| `LuaRules` | Game server | Lua code in the LuaRules synced state |
| `LuaGaia` | Game server | Lua code in the LuaGaia synced state |
| `server` | Game server | Built-in server commands (see below) |
| `lobby` | Lobby server | Built-in lobby commands |
| `sql` | Lobby server | Read-only SQL against the game database |

Switch scopes with the dropdown or the `/connect` meta-command.

### Meta-Commands

These work in all scopes and start with `/`:

| Command | Description |
|---------|-------------|
| `/connect <scope>` | Switch execution scope |
| `/scopes` | List available scopes |
| `/clear` | Clear the tab's output |
| `/inspector` | Toggle Babylon.js scene inspector |
| `/help` | Show all commands and shortcuts |

### Server Commands

Available when scope is `server`:

| Command | Output |
|---------|--------|
| `frame` | Current simulation frame number |
| `state` | `frame=N teams=N units=N` |
| `units` | List all units (max 100) with id, def, team, health |
| `units <teamId>` | List units for a specific team |
| `defs` | Count of loaded unit and weapon definitions |
| `pause` | Pause the simulation |
| `unpause` | Resume the simulation |
| `speed <multiplier>` | Set game speed (0-100) |
| `break <file>:<line>` | Set a Lua breakpoint |
| `break list` | List all breakpoints |
| `break clear` | Remove all breakpoints |
| `continue` / `c` | Resume from breakpoint |
| `step` / `s` | Step one Lua line |
| `step_over` / `n` | Step over (stay at current call depth) |
| `step_out` / `o` | Step out (return to caller) |

**Lobby scope commands:**

| Command | Output |
|---------|--------|
| `rooms` | List all active rooms |
| `process list` | List game server processes (pid, port) |

### Network Inspector

Toggle the **Net** checkbox in the console header to enable the network message inspector. When enabled, all inbound and outbound game-connection messages (WebRTC data channels today; → WebTransport, PLAN-game-worker.md) are decoded and logged:

```
[INFO] [client:net] <- [FlatBuffers] AuthResponse (128 bytes)
[INFO] [client:net] -> [FlatBuffers] ViewportUpdate (64 bytes)
[INFO] [client:net] <- [EntityState] (2048 bytes)
```

The inspector decodes the envelope byte (FlatBuffers, EntityState, EntityDelta, ProjectileState) and, for FlatBuffers messages, extracts the payload type name (AuthResponse, MapData, PlayerCommand, etc.).

---

## Lua Debug API

These functions are available in all synced Lua contexts (LuaRules, LuaGaia). They route through the unified logging system with the calling handle's name as the scope.

### Spring.Debug

```lua
Spring.Debug(arg1, arg2, ...)
```

Log at **DEBUG** level. Arguments are converted to strings via `tostring()` and joined with tabs. Useful for verbose diagnostic output that should be hidden by default.

### Spring.Warn

```lua
Spring.Warn(arg1, arg2, ...)
```

Log at **WARNING** level. Same argument handling as `Debug`. Use for recoverable issues that should be visible during development.

### Spring.Assert

```lua
Spring.Assert(condition, message)
```

If `condition` is falsy, logs at **ERROR** level with an "ASSERT:" prefix and raises a Lua error (halts the current callin). If `condition` is truthy, does nothing.

```lua
local unit = Spring.GetUnitByID(unitId)
Spring.Assert(unit, "unit " .. unitId .. " not found")
-- if unit is nil, this logs "ASSERT: unit 42 not found" and errors
```

### Spring.DumpTable

```lua
Spring.DumpTable(table, label, maxDepth)
```

Pretty-print a table to the log at **NOTICE** level with recursive indentation.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `table` | table | required | The table to dump |
| `label` | string | `"table"` | Label shown before the dump |
| `maxDepth` | integer | 3 | Maximum nesting depth (deeper shows `{...}`) |

```lua
Spring.DumpTable(UnitDefs[1], "tank_def", 2)
-- Logs:
-- [lua:LuaRules] tank_def = {
--   ["name"] = "tank",
--   ["maxHealth"] = 1000,
--   ["weapons"] = {
--     [1] = {...},
--   },
-- }
```

Tables with more than 100 entries are truncated with `...`.

### Spring.Inspect

```lua
Spring.Inspect(name1, value1, name2, value2, ...)
```

Log name-value pairs at **NOTICE** level. Tables are auto-expanded to depth 2. Intended for quick variable inspection during development.

```lua
local hp = Spring.GetUnitHealth(unitId)
local pos = {Spring.GetUnitPosition(unitId)}
Spring.Inspect("hp", hp, "pos", pos)
-- Logs:
-- [lua:LuaRules] hp = 850
-- pos = {[1] = 1024.5, [2] = 100.0, [3] = 512.3}
```

### Spring.Log

```lua
Spring.Log(section, level, arg1, arg2, ...)
```

Log with an explicit section and level. The `level` parameter accepts numeric LOG constants (10=debug, 20=info, 30=notice, 40=warning, 50=error, 60=fatal) or string names (`"debug"`, `"info"`, `"notice"`, `"warning"`, `"error"`, `"fatal"`).

```lua
Spring.Log("my_gadget", "warning", "resource pool low:", amount)
```

### Spring.Echo / Spring.Error

```lua
Spring.Echo(arg1, arg2, ...)    -- logs at NOTICE level
Spring.Error(message)            -- raises a Lua error (like error())
```

`Spring.Echo` routes through springlog at NOTICE level. `Spring.Error` calls `luaL_error()` which raises a Lua exception (caught by the callin error handler in LuaHandle.cpp, which logs the traceback).

---

## Interactive Lua Debugger

The debugger lets you set breakpoints in server-side Lua code, pause the simulation, and inspect the call stack and variables.

### Setting Breakpoints

From the debug console (scope `server`):

```
server> break LuaRules/Gadgets/unit_spawner.lua:42
  breakpoint 1 set

server> break list
  #1 LuaRules/Gadgets/unit_spawner.lua:42

server> break clear
  all breakpoints cleared
```

Breakpoint file matching is substring-based -- `unit_spawner.lua:42` will match any source file whose path contains `unit_spawner.lua`.

From Lua code:

```lua
Spring.Breakpoint("checking spawn logic")
-- logs: "BREAKPOINT hit: checking spawn logic"
-- (actual pause not yet wired from Lua side)
```

### Stepping

When paused at a breakpoint, use these commands:

| Command | Shortcut | Behavior |
|---------|----------|----------|
| `continue` | `c` | Resume execution |
| `step` | `s` | Execute one line, then pause |
| `step_over` | `n` | Execute until returning to the same call depth |
| `step_out` | `o` | Execute until the current function returns |

### Stack and Variable Inspection

The debugger provides these inspection functions (callable from `LuaExecEngine` when paused):

- **Call stack** -- file, line, function name, type (Lua/C/main) for each frame (up to 50 levels)
- **Locals** -- name, type, and string value of all local variables in a given frame (up to 100 variables)
- **Upvalues** -- captured variables from enclosing scopes
- **Eval** -- evaluate an expression in the paused context

These are accessible programmatically via the `LuaDebugger` C++ API but are not yet wired to console commands.

### Sim Pause Behavior

When a breakpoint fires, the debugger sets a `paused` flag. The main simulation loop checks this flag each tick:

```cpp
if (sim.HasGameStarted() && !g_luaDebugger.IsPaused()) {
    sim.SimFrame();
}
```

While paused, the server still processes inbound network messages (including console commands) but does not advance the simulation. This means the entire game halts -- all players see a frozen game state until the breakpoint is continued.

The debug hook is installed with `LUA_MASKLINE`, which fires on every Lua line. This has a performance cost -- only attach the hook when actively debugging.

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

States: `starting`, `running`, `ended`, `crashed`.

**Console commands** (scope `lobby`):

```
lobby> process list
  Room 1: pid=12345 port=9101
```

**Restart resilience:** The lobby writes spawned game server info to a `game_servers` SQLite table. On startup, stale entries from a previous run are cleaned up. This table is the foundation for re-adopting orphaned game servers after a lobby restart (not yet fully wired).

---

## Game Session Tracking

The log server maintains a `game_sessions` table for post-mortem analysis:

```sql
CREATE TABLE game_sessions (
    session_id TEXT PRIMARY KEY,
    room_id INTEGER,
    game_name TEXT,
    map_name TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    end_reason TEXT,       -- "normal", "crash", "killed", "timeout"
    exit_code INTEGER,
    player_count INTEGER,
    ai_count INTEGER
);
```

Query via the HTTP API:

```
GET http://localhost:8010/api/sessions
```

---

## Babylon.js Inspector

The Babylon.js built-in inspector shows the scene graph, materials, textures, performance counters, and allows live material editing.

**Toggle:**

- Press **F12** (when the game is running)
- Or type `/inspector` in the debug console

The inspector renders as an embedded panel alongside the game canvas. Call `debugConsole.setScene(scene)` from `main.ts` after creating the Babylon.js scene to enable this integration.

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

### Available Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_logs` | `roomId`, `game`, `level`, `section`, `scope`, `sinceMinutes`, `limit` | Fetch recent log entries; `roomId` scopes to one game instance |
| `search_logs` | `query`, `roomId`, `game`, `section`, `level`, `sinceMinutes`, `limit` | Search logs; scope with `roomId`/`game`/`sinceMinutes` to avoid a flood of history |
| `exec_lua` | `scope`, `code`, `roomId` | Execute Lua code in a specific scope |
| `get_game_state` | `roomId` | Get sim state summary |
| `list_units` | `team`, `roomId` | List units, optionally by team |
| `list_processes` | | List game server processes (via lobby HTTP) |
| `get_lua_source` | `gamePath`, `filePath` | Read a Lua source file from disk |
| `list_gadgets` | `roomId` | List loaded Lua gadgets |
| `query_db` | `query`, `db` | SQL query against game or debug database |
| `list_sessions` | | List recent game sessions |

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
   (`kill_game`, or `pkill -f build/debug/spring-server`) before launching, or
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

---

## Extending the System

### Adding a Custom Sink

Register a function that receives every log record:

```cpp
#include "System/SpringLog/SpringLog.h"

void MyCustomSink(const SpringLogRecord* record, void* userdata) {
    // record->level, record->section, record->scope,
    // record->process, record->frame, record->message
    // are all valid for the duration of this call.
    MySystem* sys = static_cast<MySystem*>(userdata);
    sys->HandleLog(record);
}

// Register (returns an ID for later removal)
int sinkId = springlog_add_sink(MyCustomSink, mySystemPtr);

// Remove when done
springlog_remove_sink(sinkId);
```

Custom sinks are called under the global log mutex. Keep processing fast -- buffer entries and process them on another thread if needed.

### Adding a Server Command

Add a new case in `ExecuteServerCommand()` in `rts/Server/LuaExecEngine.cpp`:

```cpp
if (cmd == "my_command") {
    // Access any sim state via global objects
    return "result string";
}
```

The result is sent back to the caller as a `ConsoleResponse` FlatBuffer message. Return a string starting with `"unknown command:"` to signal failure.
