---
name: spring-debug
description: Debug and inspect running Spring RTS Web servers. Use when querying logs, executing Lua or SQL, inspecting game state, listing processes or sessions, or diagnosing server issues.
when_to_use: Use when the user asks about server logs, game state, Lua errors, running processes, SQL queries, or needs to execute commands on the lobby or game server. Prefer these MCP tools over raw curl when the servers are running.
user-invocable: false
---

# Spring Debug MCP Server

The `spring-debug` MCP server (declared in `.mcp.json`) connects to the running lobby, game server, and log server via HTTP. It provides these tools:

## Tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `get_logs` | Fetch recent log entries (filter by level, section, scope, room) | Checking server output, finding errors |
| `search_logs` | Full-text search across all logs | Finding specific errors or patterns |
| `exec_lua` | Execute Lua code in LuaRules, LuaGaia, or server scope | Testing gadgets, inspecting game state |
| `query_db` | Run read-only SQL against the lobby database | Checking users, sessions, room state |
| `list_processes` | List game server subprocesses managed by the lobby | Checking if a game is running |
| `list_sessions` | List recent game sessions from the log server | Post-mortem, history |
| `get_game_state` | Get sim frame, teams, unit count from game server | Checking if sim is ticking |
| `list_units` | List units, optionally by team | Debugging combat, spawning |
| `list_gadgets` | List loaded Lua gadgets | Checking which gadgets are active |
| `get_lua_source` | Read a Lua file via the lobby's VFS HTTP endpoint | Reading gadget source when debugging errors |
| `restart_lobby` | Restart the lobby server in-place (re-exec, preserves game servers) | After rebuilding spring-lobby binary |
| `restart_game` | Restart a game server in-place (re-exec with same args, same PID) | After rebuilding spring-server binary |

## Server URLs

- Lobby: `http://127.0.0.1:8011` (fixed)
- Log server: `http://127.0.0.1:8010` (fixed)
- Game server: **dynamic port** — discovered at runtime, never hardcoded

### Discovering game server ports

Game servers are spawned by the lobby with dynamically assigned ports. There may be multiple running simultaneously. Always discover ports before interacting with a game server:

1. **MCP tool**: `list_processes` — returns all running game servers with their ports
2. **HTTP API**: `GET http://localhost:8011/api/processes` — JSON array of `{room_id, port, pid, state, ...}`
3. **MCP tool**: `get_game_state` with optional `roomId` — auto-discovers if only one game is running

The MCP server's `GAME_SERVER_URL` env var sets a default for single-server development but should not be relied upon. Override via `LOBBY_URL`, `GAME_SERVER_URL`, `LOG_SERVER_URL` env vars in `.mcp.json`.

## Auth

The MCP server auto-authenticates via `SPRING_TOKEN` env var, or falls back to `SPRING_USER`/`SPRING_PASS` (defaults to admin/admin). Set `SPRING_TOKEN` in `.mcp.json` env if needed.

## When to prefer these tools over alternatives

- **Over curl**: Use MCP tools for structured queries (logs, SQL, exec). Use curl for testing raw HTTP endpoints or verifying headers/status codes.
- **Over springcli**: MCP tools run in-process with Claude — no shell overhead. Use springcli for standalone CLI testing.
- **Over browser console**: MCP tools work without a browser. Use browser console for client-side JS debugging.

## Restarting Servers In-Place

After rebuilding binaries, restart servers without disrupting the lobby room lifecycle:

**Lobby** (`restart_lobby`):
- Re-execs the process with the same CLI arguments (PID is preserved)
- Persists running game server PIDs/ports to SQLite so active games survive the restart
- Also triggered via `SIGHUP` signal or `POST /api/exec` with `{"scope":"lobby","code":"restart"}`

**Game server** (`restart_game`):
- Re-execs with the same CLI arguments (same PID, same port, fresh binary)
- Broadcasts a `GameRestarting` FlatBuffer message to connected clients before re-exec
- Clients receive the message and reload the page to reconnect
- Also triggered via `SIGHUP` signal or `POST /api/restart` on the game server port
- Use this instead of going through the lobby end→close→create→start cycle when iterating on server code

## Browser automation

When testing the game in the browser, **always use `mcp__chrome-devtools__*` tools**. Never use `mcp__claude-in-chrome__*` tools — mixing the two spawns a separate browser window and breaks page context.

## Troubleshooting

If tools return connection errors, the servers aren't running. Start them:
```
./build/debug/spring-logserver --port 8010 &
./build/debug/spring-lobby --port 8011 --maps content/maps --games-dir content/games &
```
