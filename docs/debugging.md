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

## Related Claude skills

- **`spring-debug`** — logs, Lua/SQL execution, process management (`.claude/skills/spring-debug/SKILL.md`)
- **`spring-test`** — the `window.test` harness, scripted spawn/order/damage verbs, camera control, and performance profiling (`.claude/skills/spring-test/SKILL.md`)
- **`game-browser-test`** — driving the full client in a real browser via chrome-devtools MCP (`.claude/skills/game-browser-test/SKILL.md`)
