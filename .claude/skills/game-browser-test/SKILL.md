---
name: game-browser-test
description: Test the Spring RTS Web game client in Chrome via the chrome-devtools MCP (never claude-in-chrome). Use when verifying the lobby UI, DOM overlays/HUD, network requests, the debug console, or the WebTransport connection in the browser — for a plain connected client use launch_scenario({openBrowser:true}) instead.
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
in P5 — `main.ts`, grep `disableWidgets`; it is live). The programmatic equivalent, once a
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
During the D48 investigation (2026-08, since fixed — the map renders normally now)
on `scorched_crossing_v2.4` the terrain really did render black once the splat
detail was removed (PLAN-endtoend **D48**: the tile albedo was empty, so the
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

Eight paid-for traps — one-way render-resolution scaling, shader-recompile
"wins", `isVisible` that does not stick, CDP async jobs that only advance
while awaited, GPU cost invisible to CPU phase timers, idle-vs-load fillrate,
`perfDump` returning immediately, the vsync cap, and the untrustworthy
`EXT_disjoint_timer_query_webgl2` — live in
**[perf-measurement-traps.md](perf-measurement-traps.md)**. Read it before
quoting any frame-time number. Methodology:
[docs/debugging-performance.md](../../../docs/debugging-performance.md).


## Lobby-flow path (testing the lobby UI itself)

Everything about driving the login form, `window.lobby`, room creation, the
roster/credential discipline and the network/console test flows lives in
**[lobby-flow.md](lobby-flow.md)**. The six rules that matter most: own the
`roomId` your launch returned; match the browser's login to the roster
(`test1`/`test` vs `admin`/`admin` — both are admin-role now, the *account*
is the discriminator); fresh credential login + `lobby.attachSession(token,
user_id, username)` before the first join; launch then join immediately;
`end_game` only your rooms (`await window.lobby.leave()` in-browser — the
player lifecycle is leave-only); scope `get_logs`/`search_logs` with `roomId`.


## Prerequisites

The stack is mprocs-managed — do not hand-launch services. Bring it up and
verify with `.claude/skills/run-springrts-web/smoke.sh --start` (see the
run-springrts-web skill). **The client bakes the lobby port at build time**:
`__GAME_SERVER_PORT__` is a Vite `define` fed from `GAME_SERVER_PORT`
(client/vite.config.ts → client/src/config.ts), set by the mprocs `client`
proc. A hand-started `npx vite dev` (or an `npm run build`) without
`GAME_SERVER_PORT=8011` talks to the wrong lobby and fails in ways that look
like auth bugs. Ports: client `8012` (Vite), lobby `8011`,
logserver `8010`, game servers dynamic (`9100`+).
