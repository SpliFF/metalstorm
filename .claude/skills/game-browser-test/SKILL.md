---
name: game-browser-test
description: Test the Spring RTS Web game client in Chrome. Use when verifying the lobby UI, game rendering, network traffic, debug console, or WebRTC connections in the browser.
when_to_use: Use when testing the browser client, verifying login flow, checking network requests, inspecting game state in Chrome, taking screenshots, or running Lighthouse audits.
user-invocable: false
---

# Browser Testing for Spring RTS Web

## IMPORTANT: Use chrome-devtools only

**Always use `mcp__chrome-devtools__*` tools for browser automation. NEVER use `mcp__claude-in-chrome__*` tools.**

The two MCP servers use different browser backends. Mixing them in a single session spawns a separate browser window, losing all page context. Even if claude-in-chrome tools are available, do not use them — use chrome-devtools exclusively.

## chrome-devtools (Chrome DevTools MCP)

Full Chrome DevTools Protocol access via Puppeteer. Handles all browser testing needs.

Key tools for game testing:

| Tool | Use for |
|------|---------|
| `list_pages` / `new_page` / `select_page` | Manage browser tabs |
| `navigate_page` | Load `http://localhost:5173` (Vite dev) or `http://localhost:8012` |
| `fill` / `click` | Fill login form, click buttons (use `uid` from `take_snapshot`) |
| `take_screenshot` | Capture visual state at each test step |
| `take_snapshot` | Get page DOM/accessibility tree with clickable `uid` refs |
| `list_network_requests` | Verify HTTP/2 vs HTTP/1.1, check CORS headers, find SSE connections |
| `get_network_request` | Inspect specific request/response (headers, status, body) |
| `evaluate_script` | Run JS in page context — check game state, connection status |
| `list_console_messages` | Find errors, warnings, game log output |
| `performance_start_trace` / `performance_stop_trace` | Profile render performance during gameplay |
| `lighthouse_audit` | Run Lighthouse for performance/accessibility checks |

## Lobby JS API (`window.lobby`)

The `LobbyUI` instance is exposed on `window.lobby`. All lobby actions can be called directly from JS (via `evaluate_script` or browser console):

```js
// Room lifecycle
await lobby.createRoom('test', 'pools_of_ilys_1.0.0')  // name, mapId
await lobby.joinRoom(1)                                  // roomId
await lobby.leave()
await lobby.closeRoom()

// Game setup
await lobby.addAI('null', 1)        // aiId, team (0-indexed)
await lobby.removeAI(0)             // slotIndex
await lobby.setAITeam(0, 1)         // slotIndex, team
await lobby.teamSelect(0)           // team for self
await lobby.ready(true)             // toggle ready state
await lobby.startGame()             // host only, requires ready + 2 teams
await lobby.endGame()

// Low-level
await lobby.lobbyPost('/api/rooms/start')
await lobby.lobbyGet('/api/rooms')
```

### Quick-start a game (scripted)

To start a game from scratch in one script block:

```js
await lobby.createRoom('test', 'pools_of_ilys_1.0.0');
await lobby.addAI('null', 1);   // AI on team 2 (index 1) — game needs 2 teams
await lobby.ready(true);         // host must ready up
await lobby.startGame();         // launches the game server
```

### Important: starting a game requires

1. **At least 2 teams** — add an AI to team 2 (`lobby.addAI('null', 1)`)
2. **Host must be Ready** — call `lobby.ready(true)` before `lobby.startGame()`
3. Then call `lobby.startGame()`

## Test flow: Login and room creation

```
1. Navigate to http://localhost:8012 (Vite dev server)
2. Fill #login-user with username, #login-pass with password
3. Optionally fill #login-pass2 for registration
4. Submit the login form
5. Verify "Game Rooms" heading appears (browser screen)
6. Use lobby JS API to create room, add AI, ready up, and start
```

## Test flow: Network verification (HTTP/2)

```
1. Navigate to the game client
2. list_network_requests → find /api/version, /api/maps
3. get_network_request → verify response headers:
   - Access-Control-Allow-Origin: *
   - X-Build-Stamp: <hash>
   - Cache-Control: appropriate value
4. After login, verify /api/rooms polling starts (2s interval)
5. After game start, verify /api/rtc/offer WebRTC signaling request
```

## Test flow: Debug console + SSE

```
1. Press backtick (`) to open debug console
2. Verify console panel appears
3. list_network_requests → find /api/logs/stream (SSE)
4. get_network_request → content-type: text/event-stream
5. evaluate_script → check EventSource readyState === 1 (OPEN)
```

## Prerequisites

- Vite dev server running: `cd client && npx vite`
- Lobby server running: `./build/debug/spring-lobby --port 8011 ...`
- Log server running (for SSE): `./build/debug/spring-logserver --port 8010`
