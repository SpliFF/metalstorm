---
name: game-browser-test
description: Test the Spring RTS Web game client in Chrome. Use when verifying the lobby UI, game rendering, network traffic, debug console, or WebRTC connections in the browser.
when_to_use: Use when testing the browser client, verifying login flow, checking network requests, inspecting game state in Chrome, taking screenshots, or running Lighthouse audits.
user-invocable: false
---

# Browser Testing for Spring RTS Web

## The canonical entry: `launch_scenario` → `browserUrl`

**If all you need is a connected client, you do not need this skill's browser at
all**: `launch_scenario({scenarioId:'crossing_standoff', wait:'ticking', openBrowser:true})`
launches the game *and* a headless client and returns once it is connected
(~3 s), and `end_game` closes it. `open_client` / `close_client` / `list_clients`
manage one on their own. Use chrome-devtools below when you need what only CDP
has — DOM snapshots, clicks, network inspection, console logs — or when you are
testing the **lobby UI**, which the attach path deliberately skips.

**Getting a browser into a game by hand is one navigate.**
`launch_scenario({scenarioId:'crossing_standoff', wait:'ready'})` returns a `browserUrl` of
the form `http://localhost:8012/?play=<id>&room=<id>&user=<host>&skipBriefing=1#token=…`.
Navigate a fresh isolated profile straight to it: the page **attaches** to that
exact room with the host's own direct-minted session, so there is no login
step, no roster mismatch and no `joinRoom` call to get wrong. Login and lobby
never render. Then confirm the client came up with **one** call —
`await test.readyState()` reports worker / connection / frame / render together
(wait on `window.test`/`__gp` + the HUD — **not** `lobby.currentRoom.state >= 4`,
which never fires on this path). Tear down with `end_game({roomId})`.

- A bare `?play=<id>` (no `room`/token) works too: it mints a guest and launches
  its own room named `play:<id>:<username>`. Append `&skipBriefing=1` for automation.
- Boot failures paint a `#boot-error` overlay instead of a blank page — read its
  text before debugging anything else.
- **Once a client is connected, prefer the relay tools** (`client_eval`,
  `browser_test`, `client_ready`, `client_screenshot` — see the spring-test
  skill): they drive `window.test` over the game wire with no CDP session at
  all. Reach for chrome-devtools when you need what only CDP has — DOM
  snapshots/clicks, network inspection, console logs, page navigation.

**The briefing splash (S2) — why `skipBriefing=1` is in that URL.** A scenario
that authors a `briefing` block mounts a full-screen DOM overlay
(`#briefing-overlay`) over the loading canvas, with a **Begin** button that
stays disabled until the first rendered frame. `launch_scenario`'s `browserUrl`
sets `skipBriefing=1` so it never mounts. A **bare** `?play=<id>` or a
`?direct=` boot of a briefing-bearing scenario **does** show it — the game runs
underneath, so canvas captures and `window.test` are unaffected, but anything
that drives DOM or clicks should either append `&skipBriefing=1` or click
`#briefing-begin-btn` once it is enabled. To screenshot the splash itself, use
a browser-level page screenshot: `test.captureFrame()` captures the canvas
only, never DOM overlays.

## IMPORTANT: Use chrome-devtools only

**When you need CDP, always use `mcp__chrome-devtools__*` tools. NEVER use `mcp__claude-in-chrome__*` tools.**

The two MCP servers use different browser backends. Mixing them in a single session spawns a separate browser window, losing all page context. Even if claude-in-chrome tools are available, do not use them — use chrome-devtools exclusively.

## Isolated mode + browser hygiene (READ FIRST)

The chrome-devtools MCP is configured with `--isolated` in `.mcp.json`. Each
MCP server launches its **own** browser on a throwaway profile that is
discarded on exit. This lets several Claude sessions run browsers at once
without fighting over the single shared `chrome-profile` lock. It also means:

- **The profile is fresh every launch — no saved login.** On the
  `launch_scenario` path this costs nothing (the `browserUrl` carries the
  session); only the lobby-flow path below needs a credential login.
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

**Suppress the startup commander overlay (games that have one).** The client
reads a `?disableWidgets=<name,name>` URL param (comma-separated widget GetInfo
names) and switches those widgets off once the LuaUI worker is ready — set it on
the initial navigate unless you are specifically testing that overlay (re-wired
in P5 — `main.ts:1903-1922`; it is live). The programmatic equivalent, once a
game is up, is `await test.widgets()` / `await test.setWidget(name, false)`.

Worker-side Lua eval is `await window.widgets.eval("...lua...")` (the LuaUI
widget worker), or the MCP tool `evaluate_widget_lua`. `window.test.lua(...)`
is a **different** context (server LuaExec scope) and lacks
`Spring.GetConfigInt` etc.

**Game choice for UI testing: use `metalstorm`, not `papertanks`.** PaperTanks
ships no configured LuaUI/minimap/sounds, so UI/HUD tests against it prove
nothing — widgets simply don't exist there. (ZK and BAR were archived
2026-08-02 and are no longer test vehicles.)

## The two capture surfaces — pick by what you are looking at

| Looking at | Use |
|---|---|
| terrain, units, projectiles, lighting (the game canvas) | `window.test.captureFrame({stats:true})` — or `client_screenshot` via the relay, which wraps it and returns a viewable image |
| any overlay / HUD / panel / dialog (DOM) | CDP `take_screenshot`, or query it: `document.getElementById('game-over-overlay')?.innerText` |

**CDP `take_screenshot` captures the game canvas BLACK.** The canvas is an
OffscreenCanvas transferred to the render worker, so the compositor is all CDP
sees. A black/empty game area in a CDP screenshot does NOT mean nothing
rendered. (The worker engine *is* created with `preserveDrawingBuffer: true` —
`game-processor.ts` engine construction — which is why a worker-side read can be made
deterministic and a CDP one cannot.)

**`test.captureFrame()` closes the black-capture race by construction.** The
worker renders and reads pixels in ONE task, so nothing can present in between;
`stats: true` computes min/max/mean luminance worker-side over the downsampled
pixels (Rec.601 — the same weights `render-sanity` uses):

```js
await window.test.captureFrame({ maxDim: 64, stats: true });
// → {dataUrl, width, height, frameId, gameFrame, stats:{min, max, mean}}
```

`screenshot()` (the old verb) is still a bare `canvas.convertToBlob()` read
whenever the message happens to be processed, so it can still catch a
between-render moment. For any **A/B comparison** (toggle a plugin, shoot,
toggle back, shoot) that race is fatal: one arm silently returns a fully black
PNG and you "measure" a 100 % effect. Use `captureFrame` for both arms; under
`test.pause()` + `{render:false}` two consecutive captures return the same
`frameId`. `highResScreenshot(w, h)` renders an offscreen RTT at that exact
size (it honours its arguments now; it used to void them).

Beyond mean luminance, *hf* = mean |ΔL| between horizontally adjacent pixels
(is there grain?) is worth computing from the returned `dataUrl` when the
question is detail rather than brightness. Both are objective and survive being
quoted in a plan file.

**Corollary, learned the hard way: a black frame is not always the capture.**
On `scorched_crossing_v2.4` the terrain really does render black once the splat
detail is removed (PLAN-endtoend **D48**: the tile albedo is empty, so the
signed splat detail is the only thing painting the ground). The standing "a
black capture proves nothing" rule cuts both ways — before blaming the harness,
check `scene.getActiveMeshes().length`, `material.isReady(mesh)`, the effect's
`getCompilationError()` and `engine.getFps()`; if the loop is healthy and the
pixels are 0, the pixels are the truth.

**…and the exact converse — a canvas capture cannot see the DOM.** It renders
the *canvas*, so no HTML overlay is in it: not the game-over overlay, not the
quit confirm, not the HUD panels, not a toast. Reaching for it out of habit
gives you a picture of a live-looking game with the overlay you were checking
for cropped out of existence — that is how PLAN-endtoend's D17 was filed as
"the finish never reaches a connected client" against a build where it did.
When in doubt, assert on the DOM — it is cheaper and unambiguous.

**A modal `window.alert()` blocks CDP as well as the page.** While one is open
`evaluate_script` cannot run against that tab at all, so the only reading left
is a screenshot. Combined with the trap above, that is a good way to conclude
something false about a page. Dismiss the dialog (`handle_dialog`), or read the
other client, before drawing conclusions.

## Camera stability under CDP — SOLVED by `lockInput` / `withStableCamera`

A CDP-driven session hands the worker `RTSCamera` held keys and/or a pointer
parked at the canvas corner, and its pan loop then walks the view across the
map with no event, no log line and no visual glitch (PLAN-perf M6 lost five
perf windows to it). **The fix is `test.lockInput(true)`** — it clears the
worker camera's held keys and drags and ignores every further user intent,
while leaving programmatic camera calls working. `withStableCamera` wraps the
whole pattern (lock → settle → pose snapshot → run → pose recheck → unlock in
`finally`) and hands back the drift measurement:

```js
const { result, drift } = await window.test.withStableCamera(
    () => window.test.perfCapture(30000), { toleranceElmos: 1 });
if (!drift.withinTolerance) throw new Error(`camera drifted ${drift.posDriftElmos} elmos`);
```

Residue worth remembering: `setCameraPose` itself is exact, so a pose check
taken right after setting always passes and proves nothing — only the
post-run drift report does; and a synthetic pointer re-centre or a one-shot
`blur` event does **not** fix it (held keys are the dominant term, and only
the lock drops them). Wrap **both** perf captures and screenshot A/Bs.

## Measurement traps (perf work in the browser)

Full methodology: [docs/debugging-performance.md](../../../docs/debugging-performance.md). The traps below were each paid for:

**⚠️ Changing the render resolution is one-way — read the buffer back.**
`setHardwareScalingLevel` scales the *current* backing store rather than
re-deriving it from a CSS size (the renderer runs on an OffscreenCanvas in the
worker, which has no CSS size), so it does not round-trip **and it compounds**:
960×600 → `(1.333)` → 720×450 → `(1)` → 720×450 → `(1.333)` → 540×337 (PLAN-perf
M3/M4). To restore, set the level back to **1** *and* trigger a **real** page
resize — a genuinely different size, then the one you want (the 1280→1281→1280
nudge does not work). After ANY resolution change, confirm what you are
actually measuring — only believe `getRenderWidth()`, never the level:

```js
await window.__gp(`(()=>{const e=__entityRenderer.scene.getEngine();
  return [e.getRenderWidth(), e.getRenderHeight()];})()`);
```

Note `setHardwareScalingLevel` also **does not take effect within the same
call** — re-read after a frame (~1.5 s) and loop until it matches the target.

**⚠️ A toggle that recompiles a shader makes the frame look fast — it isn't.**
Babylon skips drawing any mesh whose effect is not ready, so for several seconds
after you flip a material plugin, re-enable a mesh, or detach a post pipeline,
the frame is cheap *because half the scene is missing*. M4 hit this three times;
the worst case reported a −11.7 ms "win" that a settled window showed to be
**0.0 ms**. Two tells, both cheap: the distribution goes **bimodal** (`p50` far
below `p95` where a settled window has p95 ≈ p50 + 2 ms), and **draw calls per
frame** drop below what the scene should be issuing. After any such toggle,
settle **12–20 s**, and gate the window on a draw-call count in the expected
range. Draw calls are not per-frame anywhere obvious — `engine._drawCalls.current`
is cumulative, so sample it twice against `engine.frameId` and divide.

**⚠️ `mesh.isVisible = false` does not stick if something re-asserts it — use
`setEnabled(false)`.** Per-frame flush code commonly re-derives visibility
(`SquadRenderBackend.flushPool` does exactly this —
`pool.mesh.isVisible = pool.highWater > 0` in
`client/src/core/squad-render-backend.ts`), so an A/B that hides meshes that
way measures **nothing while looking like it worked** (PLAN-perf M11). The tell
was **draws/frame going UP** in the window that was supposed to remove geometry —
carry draws/frame as the gate on any "I removed geometry" arm, and treat a draw
count that moves the wrong way as proof the lever never engaged, not noise.

**⚠️ A CDP async measurement job only advances while an `evaluate_script` is
actively awaiting.** Kick a timing window off as a floating promise, then poll it
by reading a result global, and it reports `state: 'running'` for **minutes**
after it has actually finished. Poll with an awaited call — e.g.
`async () => { await window.test.perfDump(500); return window.__winResult; }` —
or the window looks hung.

**⚠️ No CPU phase timer sees GPU fragment cost — on a fillrate A/B, quote frame
time, not the `render` phase.** M8 removed the CSM depth-bounds readback (a GPU
sync point), and with it the lane's only accidental view of GPU cost. When a
lever moves several unrelated CPU phases by a little, you are reading
**backpressure**, and the true cost is in frame time. A pre-M8 `render`-phase
number for anything fillrate-bound is not comparable to a post-M8 one — the
instrument changed, not the cost.

**⚠️ A GPU cost measured on an idle scene is not that cost under load.** Load
moves the bottleneck: PLAN-maps **M7c** took a terrain-splat toggle worth
**≈1.8 ms idle** and measured **0.484 ms** under a real battle at the strategic
pose (73 % absorbed) and **nothing** at the gameplay pose. Absorption falls as
the buffer grows, so quote *both* the load and the buffer with any fillrate
number.

**⚠️ `window.test.perfDump(ms)` reads the ring buffer and returns immediately —
it does not wait `ms`.** `perfReset()` followed straight by `await perfDump(20000)`
returns a fully-populated table of **zeros**, which reads like a broken profiler
rather than a missing sleep. **`test.perfCapture(windowMs)` exists precisely to
close this trap** — it resets, waits a REAL window, then dumps. Use it.

**⚠️ A vsync cap silently truncates the cheap arm, turning a delta into a lower
bound.** On a 120 Hz display the cheap arm returned **exactly 2400 frames per
20 s window (120.0 fps) every time** — a clamp, not a measurement. Exact-integer
frame counts and an fps pinned to the refresh rate are the tells. Escape it by
scaling the render buffer in the worker until **both** arms sit below the cap —
subject to the one-way/compounding trap above (compute
`level = currentWidth / targetWidth` and read `getRenderWidth()` back). And Δ is
**not** linear in megapixels over a wide range, so normalise back to the
reference buffer only from the nearest uncapped rung, never the biggest one.

**⚠️ `EXT_disjoint_timer_query_webgl2` is available here and is not trustworthy
as an absolute.** It charged **13.3 ms of "GPU time" inside a 9.29 ms wall-clock
frame** on a saturated arm — it counts pipeline wait, not busy time, so the
ratio between arms is inflated beyond use. Query overhead itself is negligible,
so it is safe to leave installed; just don't quote it.

## Lobby-flow path (testing the lobby UI itself)

> Everything from here down is for testing **the lobby UI** — login form, room
> browser, `launch_game` regressions. For scenario/game testing,
> `launch_scenario` + its `browserUrl` skips all of it.

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
   `admin`/`admin` (plaintext in the `users` table:
   `query_db "SELECT username,password_hash FROM users"`).
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
   clean instead. Pick one identity and one room-creation path and stick with
   it — the most reliable browser flow is to create the room **in-browser as
   the already-logged-in user** (`createRoom` → `addAI` → `ready(true)` →
   `startGame`), where the host is always in the roster. Confirm the client
   came up with `await test.readyState()`.
5. **Clean up only your rooms.** `end_game(yourRoomId)` when done. Never kill
   or restart a room you didn't launch — the verb *requires* the roomId and
   refuses with a candidate list without one. In-browser,
   `await window.lobby.leave()` — the player-facing lifecycle is leave-only.
6. **Scope log reads to your room.** `get_logs` and `search_logs` default
   to all rooms — with concurrent sessions that buries your entries. Always
   pass `roomId: <yourRoomId>`.

### Lobby JS API (`window.lobby`)

The `LobbyUI` instance is exposed on `window.lobby`. All lobby actions can be called directly from JS (via `evaluate_script` or browser console) — full reference: [docs/javascript.md](../../../docs/javascript.md#windowlobby--lobby-ui):

```js
// Room lifecycle
await lobby.createRoom('test', 'pools_of_ilys_1.0.0')  // name, mapId
await lobby.joinRoom(1)                                  // roomId
await lobby.leave()

// Game setup
await lobby.addAI('null', 1)        // aiId, team (0-indexed)
await lobby.teamSelect(0)           // team for self
await lobby.ready(true)             // toggle ready state
await lobby.startGame()             // host only, requires ready + 2 teams

// Low-level
await lobby.lobbyPost('/api/rooms/start')
await lobby.lobbyGet('/api/rooms')
```

Quick-start a game from scratch in one script block:

```js
await lobby.createRoom('test', 'pools_of_ilys_1.0.0');
await lobby.addAI('null', 1);   // AI on team 2 (index 1) — game needs 2 teams
await lobby.ready(true);         // host must ready up
await lobby.startGame();         // launches the game server
```

### Test flow: Login and room creation

```
1. Navigate to http://localhost:8012 (Vite dev server)
2. Fill #login-user with username, #login-pass with password
3. Optionally fill #login-pass2 (and #login-faction — required) for registration
4. Submit the login form
5. Verify "Game Rooms" heading appears (browser screen)
6. Use lobby JS API to create room, add AI, ready up, and start
```

### Test flow: Network verification (HTTP/2)

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

### Test flow: Debug console + SSE

```
1. Press backtick (`) to open debug console
2. Verify console panel appears
3. list_network_requests → find /api/logs/stream (SSE)
4. get_network_request → content-type: text/event-stream
5. evaluate_script → check EventSource readyState === 1 (OPEN)
```

## Prerequisites

The stack is mprocs-managed — do not hand-launch services. Bring it up and
verify with `.claude/skills/run-springrts-web/smoke.sh --start` (see the
run-springrts-web skill). Ports: client `8012` (Vite), lobby `8011`,
logserver `8010`, game servers dynamic (`9100`+).
