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

## Isolated mode + session discipline (READ FIRST)

The chrome-devtools MCP is configured with `--isolated` in `.mcp.json`. Each
MCP server launches its **own** browser on a throwaway profile that is
discarded on exit. This lets several Claude sessions run browsers at once
without fighting over the single shared `chrome-profile` lock (the
`browser already running ... use --isolated` error). It also means:

- **The profile is fresh every launch — no saved login.** You must
  authenticate from scratch before connecting to a game (see below).
- **Multiple games may be running at once** (yours + other sessions').
  You are responsible for not crossing wires.

**Discipline — track your own game, every time:**

1. **Own the roomId.** Capture the `roomId` that *your* `launch_game`
   returns and only ever `joinRoom(thatId)`. Never `joinRoom` a room you
   didn't create, and never assume "the first/only game" is yours —
   `list_processes` may show several. Joining another session's room fails
   the roster check (`Not in this room's roster`) and, worse, could attach
   you to the wrong game.
2. **Match credentials to the roster.** The browser auto-logs in as
   `test1`; `launch_game` must run as the **same** user (`username:'test1',
   password:'test'`). Don't mix an `admin` browser with a `test1` game or
   vice-versa — the roster is per-account. Dev accounts: `test1`/`test`,
   `admin`/`admin`.
3. **Fresh-login before the first join.** The stale auto-login token in a
   fresh isolated profile causes `[connection] auth failed: no valid
   token`. Do a credential login and attach it *before* joining:
   ```js
   const r = await fetch(`${location.origin}/api/auth/login`, {
     method:'POST', headers:{'Content-Type':'application/json'},
     body: JSON.stringify({ username:'test1', password:'test' }) });
   const d = await r.json();                 // note: snake_case user_id
   lobby.attachSession(d.token, d.user_id, d.username);
   ```
4. **Launch, then join immediately — no churn.** `launch_game({...})` →
   grab `roomId` → `lobby.joinRoom(roomId)` right away. A `leave()`/rejoin
   dance after a failed attempt yields `Not in this room's roster`; start
   clean instead. Poll for `window.widgets && window.test` to confirm the
   session (and LuaUI worker) came up.
5. **Clean up only your rooms.** `kill_game(yourRoomId)` when done. Never
   kill or restart a room you didn't launch.
6. **Scope log reads to your room.** `get_logs` and `search_logs` default
   to `roomId: 0` (all rooms) — with concurrent sessions that returns
   other games' entries and buries yours. Always pass your own
   `roomId: <yourRoomId>` so you only see your game's logs.

**Suppress the startup commander overlay.** ZK's "Startup Info and
Selector" widget pops a commander-chooser window over the field on game
start — noise for most tests and it needs a click to dismiss. The client
reads a `?disableWidgets=<name,name>` URL param (comma-separated widget
GetInfo names) and switches those widgets off once the LuaUI worker is
ready. So navigate to the client **with the param** unless you are
specifically testing that overlay:

```js
// clear view on launch (default for debug/test):
navigate_page("http://localhost:8012/?disableWidgets=Startup%20Info%20and%20Selector")
// keep the overlay (only when testing the commander chooser itself):
navigate_page("http://localhost:8012/")
```

`launch_game` returns a ready-made `browserUrl` with this applied (pass
`testStartupSelector: true` to get the plain URL instead). The param
persists across the in-page login/join, so set it on the initial navigate.

Worker-side Lua eval is `await window.widgets.eval("...lua...")` (the LuaUI
widget worker). `window.test.lua(...)` is a **different** context (server
LuaExec scope) and lacks `Spring.GetConfigInt` etc.

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

**`take_screenshot` caveat — WebGL canvases capture BLACK.** CDP screenshots
cannot see a WebGL2 canvas created with `preserveDrawingBuffer:false` (ours).
A black/empty game area in a screenshot does NOT mean nothing rendered. Use
`window.test.highResScreenshot()` (renders with the buffer preserved), a real
human-viewed browser, or data-level checks (`window.__gp` mesh/texture counts)
instead of trusting the pixel capture.

**…and the exact converse — `highResScreenshot()` cannot see the DOM.** It
renders the *canvas*, so no HTML overlay is in it: not the game-over overlay,
not the quit confirm, not the HUD panels, not a toast. Reaching for it out of
habit gives you a picture of a live-looking game with the overlay you were
checking for cropped out of existence — that is how PLAN-endtoend's D17 was
filed as "the finish never reaches a connected client" against a build where it
did. Pick by what you are looking at:

| Looking at | Use |
|---|---|
| terrain, units, projectiles, lighting | `window.test.highResScreenshot()` |
| any overlay / HUD / panel / dialog | CDP `take_screenshot`, or query it: `document.getElementById('game-over-overlay')?.innerText` |

When in doubt, assert on the DOM — it is cheaper and unambiguous.

**A modal `window.alert()` blocks CDP as well as the page.** While one is open
`evaluate_script` cannot run against that tab at all, so the only reading left
is a screenshot. Combined with the trap above, that is a good way to conclude
something false about a page. Dismiss the dialog (`handle_dialog`), or read the
other client, before drawing conclusions.

**⚠️ The camera silently drifts under CDP — anything that needs a fixed view
must re-verify it.** A CDP-driven session hands the worker `RTSCamera` held keys
and/or a pointer parked at the canvas corner, and its pan loop
(`client/src/core/rts-camera.ts:405-434`) then walks the view across the map
over the next few minutes **with no event, no log line and no visual glitch**.
`setCameraPose` itself is exact, so a check taken right after setting always
passes and proves nothing. PLAN-perf **M6** lost five 30 s perf windows to this
and the numbers looked like a perfectly ordinary warm-up curve (38.0 → 43.6 →
39.0 → 43.9 → 43.5 ms p95) while the camera travelled from (8192, 620, 7480) to
(6583, 398, 951). Before pinning:

```js
const cv = document.querySelector('canvas');
cv.dispatchEvent(new PointerEvent('pointerleave',
  {clientX: 640, clientY: 400, bubbles: true, pointerId: 1, pointerType: 'mouse'}));
window.dispatchEvent(new Event('blur'));   // RTSCamera.blur(): keys + drag + mouseInCanvas
await window.test.deps.workerCall('setCameraPose', [pose, 0]);
```

Then re-read `await window.test.cameraPose()` **at the end** of every
measurement / comparison window and discard the window if it moved. A synthetic
pointer re-centre alone does **not** fix it — the held keys are the dominant
term. This bites screenshot A/Bs exactly as hard as it bites perf captures.

**⚠️ Changing the render resolution is one-way — read the buffer back.**
`window.__gp('__perfToggles.renderScale(s)')` calls
`Engine.setHardwareScalingLevel(1/s)`, and it does not round-trip: after
`renderScale(0.5)` then `renderScale(1)`, `getHardwareScalingLevel()` reports 1
while `getRenderWidth()/getRenderHeight()` still report the *reduced* buffer, and
`engine.resize(true)` will not fix it — the renderer runs on an OffscreenCanvas
in the worker, which has no CSS size to re-derive the real backing store from.
PLAN-perf **M3** captured a window at the wrong buffer this way. So:

```js
// after ANY resolution change, confirm what you are actually measuring
await window.__gp(`(()=>{const e=__entityRenderer.scene.getEngine();
  return [e.getRenderWidth(), e.getRenderHeight()];})()`);
```

To restore, don't call `renderScale` again — nudge the page size
(`resize_page` 1280→1281→1280) so the client's own resize path re-applies the
DPR cap, then read the buffer back to confirm.

**Game choice for UI testing: use `zk`, not `papertanks`.** PaperTanks ships no
configured LuaUI/minimap/sounds, so UI/HUD tests against it prove nothing —
widgets simply don't exist there. ZK (and BAR) have full HUDs.

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
