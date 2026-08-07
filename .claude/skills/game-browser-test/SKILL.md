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
- **⚠️ These browsers outlive the session that spawned them, and a forgotten
  one keeps rendering at full tilt.** An abandoned client page holds the GPU
  indefinitely — one left on the game client was measured at **80 % GPU / 60 %
  CPU nine hours later**, and it silently corrupted five consecutive
  performance-measurement sessions, which blamed the user's browsers. **Sweep
  for leftovers before any timing work, and close your own browser when you
  are done:**
  ```sh
  # live agent Chromes (one entry per running instance)
  ps -Ao pid,etime,args | grep -o 'puppeteer_dev_chrome_profile-[A-Za-z0-9]*' | sort | uniq -c
  # confirm one is stale, not another live session's, before killing:
  ps -o pid,ppid,etime,args= -p <browser-pid>     # ancestry -> chrome-devtools-mcp -> which claude
  ioreg -r -d 1 -w 0 -c IOAccelerator | grep -o '"Device Utilization %"=[0-9]*'
  ```
  Attribute *reversibly* first — `kill -STOP <pid>`, re-read the GPU counter,
  `kill -CONT <pid>` — before killing anything. That is what proved the load
  was ours and not the user's.

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

**`highResScreenshot()` does NOT preserve the buffer either — it is
`screenshot()`, which is a bare `canvas.convertToBlob()` in the worker.**
(Read it: `test-harness.ts` `highResScreenshot` voids its args and calls
`screenshot()`; `game-processor.ts`'s `screenshot` case converts the live
canvas.) So it races the compositor exactly like CDP does, just less often —
and `test.pause()` does not help, because the buffer is already gone by the time
the async blob is read. For any **A/B comparison** (toggle a plugin, shoot,
toggle back, shoot) that race is fatal: one arm silently returns a fully black
PNG and you "measure" a 100 % effect. Do the render, the capture *and* the pixel
reduction inside **one** `window.__gp(...)` expression so nothing can present in
between — `evalJs` awaits promises, so:

```js
await window.__gp('(async()=>{ const s=self.__entityRenderer.scene; s.render();' +
  ' const b=await s.getEngine().getRenderingCanvas().convertToBlob({type:"image/png"});' +
  ' const bmp=await createImageBitmap(b); /* draw to OffscreenCanvas, getImageData, reduce */' +
  ' return {mean, hf}; })()');
```

Two useful reductions: *mean luminance* (does the change shift overall
brightness?) and *hf* = mean |ΔL| between horizontally adjacent pixels (is there
grain?). Both are objective and survive being quoted in a plan file.

**Corollary, learned the hard way: a black frame is not always the capture.**
On `scorched_crossing_v2.4` the terrain really does render black once the splat
detail is removed (PLAN-endtoend **D48**: the tile albedo is empty, so the
signed splat detail is the only thing painting the ground). The standing "a
black capture proves nothing" rule cuts both ways — before blaming the harness,
check `scene.getActiveMeshes().length`, `material.isReady(mesh)`, the effect's
`getCompilationError()` and `engine.getFps()`; if the loop is healthy and the
pixels are 0, the pixels are the truth.

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

**It is worse than one-way — it compounds.** PLAN-perf **M4** measured
`setHardwareScalingLevel` scaling the *current* backing store rather than
re-deriving it from a CSS size, so each call shrinks the buffer again:
960×600 → `setHardwareScalingLevel(1.333)` → 720×450 → `(1)` → 720×450 → `(1.333)`
→ 540×337. Asking for the level you want does not get you the buffer you want.

To restore, set the scaling level back to **1** *and* trigger a **real** page
resize — a genuinely different size, then the one you want. The 1280→1281→1280
nudge this file previously recommended does **not** work; M4 tried it and the
buffer stayed at 960×600. What works:

```js
await window.__gp('__entityRenderer.scene.getEngine().setHardwareScalingLevel(1)');
// then resize_page 1100×700, wait ~4 s, resize_page 1280×800, wait ~5 s
// then read the buffer back — only believe getRenderWidth(), never the level
```

**⚠️ A toggle that recompiles a shader makes the frame look fast — it isn't.**
Babylon skips drawing any mesh whose effect is not ready, so for several seconds
after you flip a material plugin, re-enable a mesh, or detach a post pipeline,
the frame is cheap *because half the scene is missing*. M4 hit this three times;
the worst case reported a −11.7 ms "win" for disabling post-processing that a
properly settled window showed to be **0.0 ms**. Two tells, both cheap:

- the distribution goes **bimodal** — `p50` far below `p95` (e.g. p50 9.0 / p95 23.8)
  where a settled window has p95 ≈ p50 + 2 ms;
- **draw calls per frame** drop below what the scene should be issuing.

So after any such toggle, settle **12–20 s**, and gate the window on a draw-call
count in the expected range, not on elapsed time alone. Draw calls are not
per-frame anywhere obvious — `engine._drawCalls.current` is cumulative, so
sample it twice against `engine.frameId` and divide.

**⚠️ `mesh.isVisible = false` does not stick if something re-asserts it — use
`setEnabled(false)`.** Per-frame flush code commonly re-derives visibility, so an
A/B that hides meshes that way measures **nothing while looking like it worked**.
`SquadRenderBackend.flushPool` does exactly this
(`client/src/core/squad-render-backend.ts:823`,
`pool.mesh.isVisible = pool.highWater > 0`), and PLAN-perf **M11** lost a window
to it. `setEnabled(false)` is not touched by that path. The tell that caught it
was **draws/frame going UP** in the window that was supposed to remove geometry —
so **carry draws/frame as the gate on any "I removed geometry" arm**, and treat a
draw count that moves the wrong way as proof the lever never engaged, not noise.

**⚠️ A CDP async measurement job only advances while an `evaluate_script` is
actively awaiting.** Kick a timing window off as a floating promise, then poll it
by reading a result global, and it reports `state: 'running'` for **minutes**
after it has actually finished; the identical read taken from a call that first
`await`s something returns `'done'` immediately. PLAN-perf M11 nearly restarted a
good capture over this. Poll with an awaited call — e.g.
`async () => { await window.test.perfDump(500); return window.__winResult; }` —
or the window looks hung.

**⚠️ No CPU phase timer sees GPU fragment cost — on a fillrate A/B, quote frame
time, not the `render` phase.** Before M8 the `render` phase contained the CSM
depth-bounds readback, a GPU sync point that made all backpressure land inside
that timer; M8 removed the sync, and with it the lane's only accidental view of
GPU cost. PLAN-maps M7b measured a terrain-splat toggle worth **≈1.8 ms of frame
time** whose `render`-phase mean moved **0.077 ms** — 4% of the real effect —
while `ui` (+0.030), `entity` (+0.016) and `decals` (+0.009) moved too. That
pattern *is* the tell: when a lever moves several unrelated CPU phases by a
little, you are reading **backpressure**, and the true cost is in frame time.
A pre-M8 `render`-phase number for anything fillrate-bound is not comparable to
a post-M8 one — the instrument changed, not the cost.

**⚠️ A vsync cap silently truncates the cheap arm, turning a delta into a lower
bound.** On this 120 Hz display the splat-off arm returned **exactly 2400 frames
per 20 s window (120.0 fps) every time** — a clamp, not a measurement, so the
bracket only proved Δ ≥ 0.93 ms against a real ≈1.8 ms. Exact-integer frame
counts and an fps pinned to the refresh rate are the tells. To escape it, scale
the render buffer in the worker until **both** arms sit below the cap:

```js
await window.__gp(`(()=>{const e=self.__entityRenderer.scene.getEngine();
  e.setHardwareScalingLevel(LEVEL); return e.getRenderWidth()+'x'+e.getRenderHeight();})()`)
```

Two traps in that call. It is applied **relative to the current buffer** on the
worker's OffscreenCanvas (there is no `clientWidth`), so it **compounds** across
calls — compute `level = currentWidth / targetWidth` and always read
`getRenderWidth()` back rather than assuming. And Δ is **not** linear in
megapixels over a wide range (0.79 ms/MP at 4.3 MP vs 0.38 ms/MP at 25.6 MP on
the same pose), so normalise back to the reference buffer only from the nearest
uncapped rung, never from the biggest one.

**⚠️ `EXT_disjoint_timer_query_webgl2` is available here and is not trustworthy
as an absolute.** Bracketing a frame with `TIME_ELAPSED_EXT` reported **13.3 ms
of "GPU time" inside a 9.29 ms wall-clock frame** on the saturated arm while the
unsaturated arm read a plausible 6.6 ms — it is charging pipeline wait, not busy
time, so the ratio between arms is inflated beyond use. Query overhead itself is
negligible (frame times matched the uninstrumented bracket to 0.09 ms), so it is
safe to leave installed; just don't quote it.

**Game choice for UI testing: use `metalstorm`, not `papertanks`.** PaperTanks
ships no configured LuaUI/minimap/sounds, so UI/HUD tests against it prove
nothing — widgets simply don't exist there. (This line used to say "use `zk`";
ZK and BAR were archived 2026-08-02 and are no longer the test vehicle — see
PLAN.md Code-session contract.)

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
