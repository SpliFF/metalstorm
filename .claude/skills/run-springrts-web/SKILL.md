---
name: run-springrts-web
description: Build, launch, smoke-test, and drive the Spring RTS Web client-server game engine. Use when asked to run / start / build / launch / screenshot / drive / smoke-test the game, bring up the lobby+server+client stack, or verify the browser client renders a game.
---

Spring RTS Web is a client-server RTS engine: C++ servers (`spring-lobby`,
`spring-server`, `spring-logserver`) + a TypeScript/Babylon.js browser client
(Vite, port 8012) that renders the game in a Web Worker over WebTransport.
There is **no single binary** — it's a stack of long-running services plus a
browser. You drive it in three layers:

- **Lifecycle + HTTP smoke** → `.claude/skills/run-springrts-web/smoke.sh` (committed here).
- **Service lifecycle** → **mprocs** (the canonical manager) / `tools/scripts/spring-services.sh`.
- **Launch + render a game + screenshot** → the **`spring-debug` / `chrome-devtools` MCP tools** driving the browser's `window.lobby` / `window.test` / `window.__gp` JS API.

Paths below are relative to the repo root (`<unit>/`). Environment here is a
**macOS dev machine** (darwin) with the toolchain already installed via Homebrew
+ CMake `FetchContent`; this is not a clean-Linux-container recipe.

## Prerequisites

Already-built tree assumed (`build/debug/` exists with the binaries). A clean
machine needs: CMake 3.25+, Ninja, a C++ toolchain, Node, and `mprocs`
(`brew install mprocs`). Most C/C++ deps (ngtcp2, nghttp3, OpenSSL, Assimp,
flatbuffers, ktx) are fetched by CMake `FetchContent` at configure time.

## Build

```bash
# First-time only (configures CMake preset + installs client deps): make setup
# Build/refresh the C++ servers + tools (verified — fast when up-to-date):
cmake --build build/debug
```

`make build` wraps `cmake --build build/debug`. Client has no build step in dev
(Vite serves on demand). Re-build a single tool, e.g.:
`cmake --build build/debug --target modelimporter gameconverter`.

## Run (agent path)

**1. Start the stack** — it's mprocs-managed; start/restart procs in mprocs
(do **not** hand-launch the lobby — see Gotchas). Procs: `logserver` (8010),
`lobby` (8011), `client` (8012, Vite), plus `game-logs`/`lua-errors` tails.

**2. Verify the stack is live** (committed driver):

```bash
.claude/skills/run-springrts-web/smoke.sh          # verify only
.claude/skills/run-springrts-web/smoke.sh --start  # start-bg if down, then verify
```

Verified output: lists services, lobby version, the 4 games (with
`modelMaterialPort`/`lighting`), map count, client up/down, active rooms; exits 0
when the lobby HTTP plane responds. Spot-check by hand:

```bash
./tools/scripts/spring-services.sh status
curl -s http://localhost:8011/api/version
curl -s http://localhost:8011/api/games | python3 -m json.tool | head
```

**3. Launch + drive a game in the browser.** The render harness is the
`chrome-devtools` MCP (navigate / `evaluate_script` / `take_screenshot`) driving
the client's JS API; admin server actions go through the `spring-debug` MCP
(`launch_game`, `spawn_unit`, `pause_sim`, `exec_lua`, `get_game_state`,
`list_units`, `get_logs`). See also the `game-browser-test`, `spring-test`, and
`spring-debug` skills.

The self-contained browser flow that yields a **ticking** sim (verified this
session — run via `chrome-devtools` `evaluate_script` after navigating to
`http://localhost:8012/?disableWidgets=Startup%20Info%20and%20Selector`):

```js
// register/login a non-admin user, then CREATE+START your own room
// (a ticking sim needs the registered host to connect — see Gotchas).
const set=(id,v)=>{const el=document.getElementById(id);const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
if (document.getElementById('login-user') && lobby.currentScreen==='login') {
  set('login-user','texdebug'); set('login-pass','texdebug123'); set('login-pass2','texdebug123');
  document.getElementById('login-btn').click();
}
// ...wait for lobby.currentScreen==='browser', then:
lobby.selectedGameId='bar';
const map=lobby.availableMaps.find(m=>m.id.includes('wanderlust'))?.id||lobby.availableMaps[0].id;
await lobby.createRoom('drive', map);
await lobby.addAI('null',1); await lobby.ready(true); await lobby.startGame();
// ...wait for window.test && window.__gp && lobby.currentRoom.state>=4 (room is Active)
```

Then frame + screenshot (camera is client-side; no admin needed):

```js
// angled, HUD-clear 3/4 view — aim a ground point offset from the unit
await test.cameraSnapToGround(829, 1298, {height:150, pitchDeg:28, durationMs:0});
// then take_screenshot (chrome-devtools MCP). Inspect the render worker with:
await window.__gp(`(()=>{const er=self.__entityRenderer; return er.scene.meshes.length;})()`);
```

`window.__gp(expr)` evaluates JS **inside the render worker** (where the Babylon
scene / `__entityRenderer` / materials live) — the main introspection handle.
Example screenshot of a working drive: `.claude/skills/run-springrts-web/example-cuspbr-corcom.jpg`.

## Run (human path)

`mprocs` from the repo root opens the TUI; `lobby`/`client`/`logserver` autostart.
Open `http://localhost:8012` in a real browser, register/login, create a room,
start. Headless this is useless — drive via the agent path above.

## Test

```bash
cmake --build build/debug --target spring-tests   # C++ (then run build/debug/spring-tests)
cd client && npx vitest run                        # client unit tests
```

## Gotchas (battle scars — non-obvious)

- **The lobby caches the games list at startup** (`lobby_main.cpp:514`,
  served by reference). Edits to a game's `modinfo.lua` (`modelMaterialPort`,
  `lighting`, `legacyCoordSystem`) **only surface after a lobby restart**.
  `smoke.sh` prints each game's `modelMaterialPort` so you can confirm.
- **The sim only ticks with a connected registered player.** A fresh game shows
  `frame=-1` + `waiting for 1 player(s) to connect` until the room's host client
  connects. Joining an MCP-`launch_game` room as a *different* browser user
  (spectator) does **not** satisfy it. To get a ticking sim from the browser,
  **create+start your own room** as the logged-in user (recipe above).
- **Vite dev `?worker` serves stale worker code.** Page reloads (even
  cache-bypassing) keep running the *old* worker module after you edit a
  worker-imported file (`entity-renderer.ts`, `game-processor.ts`, …).
  Byte-identical behaviour after an edit = stale bundle → **restart the `client`
  proc in mprocs** (the running Vite picks up later edits on reload only after a
  fresh start; clear `client/node_modules/.vite` if needed).
- **Don't hand-launch services.** They're mprocs-managed; the lobby caches state
  and duplicate processes cause port races (you can end up with two lobbies on
  8011 / two logservers on 8010). Restart via mprocs. `spring-services.sh stop`
  pattern-kills all repo `spring-*` + the client Vite (graceful TERM→KILL,
  handles duplicates) when you need a clean slate.
- **RTS camera ignores free `setCameraPose`** (the rig overrides it). Use
  `test.cameraSnapToGround(x, z±offset, {height, pitchDeg})` for an angled,
  HUD-clear 3/4 view; `test.cameraSnapToUnit(id)` defaults to top-down.
- **`window.test.lua` / `spawn` need admin role.** A fresh-registered browser
  user can drive camera + screenshots but server actions return
  `403 forbidden — admin role required`. Use the `spring-debug` MCP
  (`spawn_unit`, `exec_lua`, `pause_sim`) for admin server actions.
- **Ports:** client `8012`, lobby `8011`, logserver `8010`; game servers are
  dynamic (`9100`+). Game content (`data/games/*`, `content/games/*`) is
  gitignored; the `data/` copy is runtime-authoritative.
- **defs cache** lives at `data/games/<id>/cache/defs/<hash>/`, keyed on game
  content (not the server binary). After changing the C++ defs serializer, clear
  it (`spring-debug` `clear_defs_cache`, or `rm -rf`) before a fresh room.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `smoke.sh` FAIL: lobby `/api/version` not responding | Lobby down — start the `lobby` proc in mprocs (or `smoke.sh --start`). |
| Game stuck `frame=-1`, `list_units` empty | No connected registered player — create+start your own room as the logged-in browser user (don't just `joinRoom` an MCP room). |
| `modinfo.lua` edit not reflected in `/api/games` | Restart the `lobby` proc (games list is startup-cached). |
| Worker code edit not taking after reload | Restart the `client` (Vite) proc; the `?worker` bundle is stale. |
| Two lobbies / logservers, port races | `tools/scripts/spring-services.sh stop`, then restart mprocs. |
| `403 forbidden — admin role required` | Browser user isn't admin — use the `spring-debug` MCP for server actions. |
