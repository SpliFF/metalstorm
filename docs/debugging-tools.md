# SQL Proxy, Process Management, Claude/MCP, springcli & mprocs

Part of the [Debugging & Logging Guide](debugging.md) family. This page covers the lobby's read-only SQL proxy, process management, the Claude/MCP integration (`tools/debug-mcp`), the standalone `springcli` CLI, and the `mprocs` development environment.

## Table of Contents

- [SQL Query Proxy](#sql-query-proxy)
- [Process Management](#process-management)
- [Claude / MCP Integration](#claude--mcp-integration)
  - [MCP Server Setup](#mcp-server-setup)
  - [Available Tools](#available-tools)
  - [Reliable live game-drive verification](#reliable-live-game-drive-verification)
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

States: `starting`, `running`, `ended`, `crashed`.

**Console commands** (scope `lobby`):

```
lobby> process list
  Room 1: pid=12345 port=9101
```

**Restart resilience:** The lobby writes spawned game server info to a `game_servers` SQLite table. On startup, stale entries from a previous run are cleaned up. This table is the foundation for re-adopting orphaned game servers after a lobby restart (not yet fully wired).

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
| `launch_game`, `kill_game`, `restart_lobby`, `restart_logserver`, `restart_game` | see `.claude/skills/spring-debug` | Game-server lifecycle management |
| `spawn_unit`, `kill_unit`, `damage_unit`, `give_order`, `clear_units`, `get_unit_state`, `set_debug_logging`, `get_combat_summary`, `pause_sim`, `set_sim_speed` | see `.claude/skills/spring-test` | Scripted test verbs (server-side) |
| `browser_test`, `evaluate_widget_lua` | see `.claude/skills/spring-test` | Bridges to browser-side `window.test`/`window.widgets` — includes the [performance-profiling tools](debugging-performance.md) |

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
