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
| `api_request` | Authenticated HTTP request to lobby/log/game server (auto-manages token) | Hitting endpoints without curl + manual token plumbing |

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

The MCP server auto-authenticates via `SPRING_TOKEN` env var, or falls back to `SPRING_USER`/`SPRING_PASS` (defaults to admin/admin). Set `SPRING_TOKEN` in `.mcp.json` env if needed. All tools that hit the lobby or game server reuse the cached token — you do not need to log in or pass a token from the tool side.

## Generic HTTP via `api_request`

Use `api_request` when the dedicated tools above don't cover the endpoint you need (e.g. `/api/rooms`, `/api/processes`, custom debug endpoints). It:
- attaches a Bearer token automatically (override with `auth: false` for unauthenticated probes),
- routes by `target`: `"lobby"` → `:8011`, `"log"` → `:8010`, `"game"` → dynamic game-server port (uses `roomId` or first active game), `"url"` → an absolute `url`,
- JSON-encodes object bodies and parses JSON responses (set `expectJson: false` for raw text).

Examples:
```
api_request({ target: "lobby", path: "/api/processes" })
api_request({ target: "game", path: "/api/exec", method: "POST",
              body: { scope: "LuaRules", code: "return #Spring.GetAllUnits()" } })
api_request({ target: "lobby", path: "/api/rooms/leave", method: "POST", body: {} })
```

Prefer `exec_lua` for Lua snippets and `query_db` for SQL — `api_request` is the escape hatch.

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

## Camera control

The camera lives **only in the browser** (the `RTSCamera` instance, `client/src/core/rts-camera.ts`). There are no camera MCP tools — drive it by feeding JS into `mcp__chrome-devtools__evaluate_script`. Two equivalent surfaces back the same camera: `window.test.*` (the test harness) and `window.camera.*` (pose primitives). Read the live pose with `window.test.cameraPose()` → `{pos:{x,y,z}, lookAt:{x,y,z}}`; check `window.camera.animating` before a screenshot (a transition is mid-flight when `true`).

### Coordinate system (read this first)
World positions are **positive** in `[0, mapX] × [0, mapZ]` (Option A — handedness is a *direction/basis* convention, not positional; see `PLAN-coordinate-system-option-a.md`). The camera shares the server's world coordinates — **no flip**. So a value from `Spring.GetUnitPosition(id)` feeds straight into the camera. `heading = 0` faces −Z; the map grows in +X/+Z.

### Canonical methods (all on `window.test`)
- **World point:** `cameraSnapToGround(x, z, {height, pitchDeg, durationMs})` — look-at lands on `(x, groundY, z)` with explicit framing. **Preferred** for precise, deterministic control.
- `focusOn(x, z, durationMs)` — pans to world `(x, z)` but **keeps the current camera→look-at offset/distance**, so a far/zoomed-out camera stays far. Takes **two** world coords.
- **A unit:** `cameraSnapToUnit(unitId, …)` / `focus(unitId)` — but see the viewport caveat below.
- **A group:** `cameraFitUnits([id,…], {pitchDeg, padding, durationMs})` — frames the bounding box. The player-facing tracking camera (`setTrackingCamera(true)`, `T` key) re-fits the live **selection** every tick via the same path.

### Pitfalls (all hit in practice)
1. `focusOn(x, z)` takes **two world coords**. `focusOn(unitId)` is a bug — the id is read as `x`, `z` is `undefined`, and the camera flies off-map. To target a unit use `cameraSnapToUnit(id)` / `focus(id)`.
2. **Never** set `scene.activeCamera.position` / `.setTarget(...)` directly. `RTSCamera` keeps its own `lookAt`; bypassing it desyncs that state, and the *next* animated `focusOn` computes `offset = camera.position − lookAt` from the stale value and hurls the camera thousands of elmos off-map (e.g. `x = −13197`). Always go through `window.test` / `window.camera`.
3. Animated moves (`durationMs > 0`) preserve the current offset/distance. For a tight, deterministic frame use `cameraSnapToGround` / `cameraSnapToUnit` with explicit `height` + `pitchDeg` and `durationMs: 0`.
4. The game camera controller does **not** fight a programmatic pose **unless tracking is on** (`window.test.setTrackingCamera(false)` to be sure) — tracking re-fits the selection every tick and will override your pose.

### Unit/group targeting is viewport-bound — use server positions
`cameraSnapToUnit` / `cameraFitUnits` / `focus(unitId)` resolve positions via the client's `getEntityPosition` — an **internal** renderer method (interpolated, viewport-streamed state), **not** a Spring API. The server **viewport-filters unit state**: it streams only units near the registered viewport. (Projectiles are *broadcast* to every client, so FX appear even where units don't — a unit can be invisible to the client while its shots are not.) So an off-screen unit — or a cheat/`spawn_unit`-spawned test unit the viewport never covered — has no client position, and these methods fail with `no client-side position for unit N` (observed: `entityMeta.size === 0`, zero units streamed).

Reliable recipe — get the authoritative position from the server, then point the camera:
```js
// mcp__chrome-devtools__evaluate_script
const r = await window.test.lua('local x,y,z=Spring.GetUnitPosition(ID) return x..","..z');
const [x, z] = r.split(',').map(Number);
await window.test.cameraSnapToGround(x, z, { height: 700, pitchDeg: 60, durationMs: 0 });
```
From the MCP side the same position comes from `exec_lua` (scope `LuaRules`, `return Spring.GetUnitPosition(ID)`). `Spring.GetUnitPosition` is server-authoritative and viewport-independent — prefer it over the client lookup for scripted camera framing.

### FX visibility
The forward FX light pool culls emissions **> 7000 elmos** from the camera. To see projectile / weapon-FX lights (and faithful deferred projectile lights), the camera must be near the action — frame the combat first, then observe.

## Troubleshooting

If tools return connection errors, the servers aren't running. Start them:
```
./build/debug/spring-logserver --port 8010 &
./build/debug/spring-lobby --port 8011 --maps content/maps --games-dir content/games &
```
