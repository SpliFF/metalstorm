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

## Server URLs (defaults)

- Lobby: `http://127.0.0.1:8011`
- Game server: `http://127.0.0.1:9100`
- Log server: `http://127.0.0.1:8010`

Override via `LOBBY_URL`, `GAME_SERVER_URL`, `LOG_SERVER_URL` env vars in `.mcp.json`.

## Auth

The MCP server auto-authenticates via `SPRING_TOKEN` env var, or falls back to `SPRING_USER`/`SPRING_PASS` (defaults to admin/admin). Set `SPRING_TOKEN` in `.mcp.json` env if needed.

## When to prefer these tools over alternatives

- **Over curl**: Use MCP tools for structured queries (logs, SQL, exec). Use curl for testing raw HTTP endpoints or verifying headers/status codes.
- **Over springcli**: MCP tools run in-process with Claude — no shell overhead. Use springcli for standalone CLI testing.
- **Over browser console**: MCP tools work without a browser. Use browser console for client-side JS debugging.

## Troubleshooting

If tools return connection errors, the servers aren't running. Start them:
```
./build/debug/spring-logserver --port 8010 &
./build/debug/spring-lobby --port 8011 --maps content/maps --games-dir content/games &
```
