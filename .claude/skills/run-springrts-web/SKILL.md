---
name: run-springrts-web
description: Build, launch, smoke-test, and drive the Spring RTS Web client-server game engine. Use when asked to run / start / build / launch / screenshot / drive / smoke-test the game, bring up the lobby+server+client stack, or verify the browser client renders a game.
---

Spring RTS Web is a client-server RTS engine: C++ servers (`spring-lobby`,
`spring-server`, `spring-logserver`) + a TypeScript/Babylon.js browser client
(Vite, port 8012) that renders the game in a Web Worker over WebTransport.
There is **no single binary** — it's a stack of long-running services plus a
browser.

## Quick start (the default path)

```
.claude/skills/run-springrts-web/smoke.sh --start        # stack up + verified
launch_scenario {"scenarioId": "crossing_standoff", "wait": "ready"}
# → {roomId, port, sessions, browserUrl: "http://localhost:8012/?play=…&room=<id>#token=…",
#    phase: "ready", frame: -1}
# navigate a browser to browserUrl (it ATTACHES to that room — no login, no lobby UI),
# then:
wait_for_game {"roomId": <id>, "until": "ticking"}
# drive (spawn_unit / client_screenshot / …), then ALWAYS:
end_game {"roomId": <id>}
```

- `wait:"ready"` is the reachable target at launch — the default roster seats a
  human, so the sim holds at frame −1 until the browser attaches; `"ticking"`
  completes only after that. For a **browserless** run (exec-driven tests,
  headless probes) the server also self-exits on its startup idle clock: raise
  it with `idleGraceSeconds` on `launch_scenario`/`launch_direct` (sugar for the
  manifest's `idleStartupGraceSeconds`), or start the lobby with
  `SPRING_IDLE_STARTUP_GRACE_SECONDS=3600` for a no-rebuild blanket workaround
  (it applies to every room the lobby spawns, so pair it with `end_game`).
- `launch_direct` takes a raw manifest when you need a custom roster;
  `wait_for_game` is the one readiness wait (fails fast on a dead server);
  `end_game` is graceful SIGTERM with a drain report. Full parameter tables:
  [docs/debugging-tools.md](../../../docs/debugging-tools.md#available-tools),
  scenario authoring: [docs/scenarios.md](../../../docs/scenarios.md).
- Once the browser is attached, the **relay tools** drive it with no CDP
  session: `client_ready` (readiness), `client_screenshot` (a viewable image of
  the rendered frame), `client_eval` / `browser_test` (any `window.test`
  method). chrome-devtools MCP is the fallback for DOM/network/clicks — see the
  `game-browser-test`, `spring-test`, and `spring-debug` skills.

Paths are relative to the repo root. Environment here is a **macOS dev machine**
(darwin) with the toolchain installed via Homebrew + CMake `FetchContent`; this
is not a clean-Linux-container recipe.

## Build

```bash
# First-time only (configures CMake preset + installs client deps): make setup
# Build/refresh the C++ servers + tools (fast when up-to-date):
cmake --build build/debug
```

`make build` wraps `cmake --build build/debug`. Client has no build step in dev
(Vite serves on demand). Re-build a single tool, e.g.:
`cmake --build build/debug --target modelimporter gameconverter`.
A clean machine needs: CMake 3.25+, Ninja, a C++ toolchain, Node, and `mprocs`
(`brew install mprocs`).

## Stack lifecycle

The services are **mprocs-managed** (procs: `logserver` 8010, `lobby` 8011,
`client` 8012 Vite, plus `game-logs`/`lua-errors` tails) — do **not**
hand-launch them (see Gotchas).

```bash
.claude/skills/run-springrts-web/smoke.sh          # verify only
.claude/skills/run-springrts-web/smoke.sh --start  # start-bg if down, then verify
./tools/scripts/spring-services.sh status          # per-pane status + control channel
```

Verified `smoke.sh` output: lists services, lobby version, the games (with
`modelMaterialPort`/`lighting`), map count, client up/down, active rooms; exits 0
when the lobby HTTP plane responds. If something is up but *wrong* — a stray
server, a squatted port, a stale binary — `list_stack` classifies it and
`cleanup_stack` (dry-run by default) clears it; see the spring-debug skill.

## Framing a screenshot

Camera is client-side; no admin needed. Via the relay (`client_eval
{target:'test'}`) or chrome-devtools `evaluate_script`:

```js
// angled, HUD-clear 3/4 view — aim a ground point offset from the unit
await test.cameraSnapToGround(829, 1298, {height:150, pitchDeg:28, durationMs:0});
```

Then `client_screenshot {maxDim: 1280}` for a viewable image, or
`await test.captureFrame({stats:true})` for the raw
`{dataUrl, width, height, frameId, gameFrame, stats}` — deterministic, never a
between-frames black. Use CDP `take_screenshot` only for DOM/HUD overlays (the
canvas captures black under CDP — see game-browser-test). Inspect the render
worker with:

```js
await window.__gp(`(()=>{const er=self.__entityRenderer; return er.scene.meshes.length;})()`);
```

`window.__gp(expr)` evaluates JS **inside the render worker** (where the Babylon
scene / `__entityRenderer` / materials live) — the main introspection handle.
Other worker hooks: `__frameProfiler.dump()`, `__uiTextures.dump()` (the LuaUI
HUD texture cache — resolvedUrl/loadedUrl/loaded/lastError per entry).
Example screenshot of a working drive: `.claude/skills/run-springrts-web/example-cuspbr-corcom.jpg`.

## Lobby-flow verification path

Only when testing the lobby UI itself (login/register form, room browser,
create/join). The self-contained browser flow that yields a **ticking** sim
(run via chrome-devtools `evaluate_script` after navigating to
`http://localhost:8012/`):

```js
// register/login a non-admin user, then CREATE+START your own room
// (a ticking sim needs the registered host to connect — see Gotchas).
const set=(id,v)=>{const el=document.getElementById(id);const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
if (document.getElementById('login-user') && lobby.currentScreen==='login') {
  set('login-user','texdebug'); set('login-pass','texdebug123'); set('login-pass2','texdebug123');
  // Registration REQUIRES a faction (immutable sign-up choice). Leave the
  // select on its placeholder and the button refuses with "Choose a faction"
  // and you sit on the login screen — verified 2026-08-10.
  const f=document.getElementById('login-faction');
  const d=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
  d.set.call(f,[...f.options].find(o=>o.value).value);
  f.dispatchEvent(new Event('change',{bubbles:true}));
  document.getElementById('login-btn').click();
}
// ...wait for lobby.currentScreen==='browser', then:
const map=lobby.availableMaps[0].id;
await lobby.createRoom('drive', map);
await lobby.addAI('null',1); await lobby.ready(true); await lobby.startGame();
// ...wait for window.test && window.__gp, then for the client's own readiness:
//   (await test.readyState()).render.terrainMeshCount > 0
// NOT lobby.currentRoom.state>=4 — an in-game client's cached room state never
// reaches Active (it has left the lobby SSE feed).
```

When the drive is done, stop the room you started: `end_game {"roomId": <id>}`.

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

- **The lobby caches the games list at startup** (`availableGames` in
  `lobby_main.cpp`, discovered once and served by reference). Edits to a game's `modinfo.lua` (`modelMaterialPort`,
  `lighting`, `legacyCoordSystem`) **only surface after a lobby restart**.
  `smoke.sh` prints each game's `modelMaterialPort` so you can confirm.
  (The scenario list is likewise a startup snapshot — `write_scenario` resyncs
  it for you.)
- **The sim only ticks with a connected registered player.** A fresh game shows
  `frame=-1` + `waiting for 1 player(s) to connect` until the room's host client
  connects. On the `launch_scenario` path this is exactly what the `browserUrl`
  satisfies. Joining a room as a *different* browser user (spectator) does
  **not** satisfy it. For a browserless run, see `idleGraceSeconds` in Quick
  start — and note it raises the idle clock only; a human-roster sim still
  holds at frame −1.
- **Vite dev `?worker` serves stale worker code.** Page reloads (even
  cache-bypassing) keep running the *old* worker module after you edit a
  worker-imported file (`entity-renderer.ts`, `game-processor.ts`, …).
  Byte-identical behaviour after an edit = stale bundle → **`tools/scripts/spring-services.sh
  restart client`** (or the MCP `restart_client`) — restarts just the Vite pane
  through the mprocs control channel, pane stays authoritative. Clear
  `client/node_modules/.vite` first if a restart alone doesn't take
  (`restart_client {clearCache:true}` does both).
- **Per-pane restart via the mprocs control channel.** mprocs runs a remote-control
  server (`mprocs.yaml` `server: 127.0.0.1:4050`); `spring-services.sh restart <pane>`
  (`client` | `lobby` | `server` | `logserver` | `game-logs` | `lua-errors` | `all`)
  drives it, and `spring-services.sh ctl '{c: …}'` sends a raw command. **This
  requires mprocs to have been started with the `server:` key** — if you started
  mprocs before it was configured, restart mprocs once so it opens the port
  (else `restart` falls back to kill+relaunch, which can't touch the mprocs-only
  log-tail panes). For a rebuilt **C++** binary prefer the in-place re-exec
  instead (spring-debug MCP `restart_lobby`/`restart_logserver`/`restart_game`,
  or `SIGHUP`) — same PID, mprocs stays authoritative; `restart client` is for
  the Vite pane, which has no re-exec.
- **Don't hand-launch services.** They're mprocs-managed; the lobby caches state
  and duplicate processes cause port races (two lobbies on 8011 / two logservers
  on 8010). Restart via the control channel above (or the mprocs TUI).
  `spring-services.sh stop` pattern-kills all repo `spring-*` + the client Vite
  (graceful TERM→KILL, handles duplicates) when you need a clean slate.
- **RTS camera ignores free `setCameraPose`** (the rig overrides it). Use
  `test.cameraSnapToGround(x, z±offset, {height, pitchDeg})` for an angled,
  HUD-clear 3/4 view; `test.cameraSnapToUnit(id)` defaults to top-down.
- **`window.test.lua` / `spawn` need admin role.** A fresh-registered browser
  user can drive camera + screenshots but server actions return
  `403 forbidden — admin role required`. Use the `spring-debug` MCP
  (`spawn_unit`, `exec_lua`, `pause_sim`) for admin server actions —
  `launch_scenario`'s default host *is* admin, so its session clears the
  relay's gate too.
- **Ports:** client `8012`, lobby `8011`, logserver `8010`; game servers are
  dynamic (`9100`+). Game content (`data/games/*`, `content/games/*`) is
  gitignored; the `data/` copy is runtime-authoritative.
- **defs cache** lives at `data/games/<id>/cache/defs/<hash>/`, keyed on game
  content (not the server binary). After changing the C++ defs serializer, clear
  it (`spring-debug` `clear_defs_cache`, or `rm -rf`) before a fresh room.
- **Zombie `spring-server` on `:9100` blocks auth.** A leftover game server from
  a crashed/killed earlier session holds the port; new rooms route to it and
  login/auth fails or hangs mysteriously (this burned most of the U8 session).
  `spring-debug` `list_stack` classifies exactly this as `zombie-port` (error);
  `cleanup_stack` clears it (dry-run first, and it will never kill the `:8011`
  lobby). Do that before hand-hunting with `pgrep`/`lsof`.
- **A rebuilt server binary does not affect a live process.** After
  `cmake --build`, restart any running game server (and the lobby proc if lobby
  code changed) — otherwise you're testing the old binary.
  `list_stack {probeHashes:true}` proves it either way: it compares each running
  server's `/api/metrics` → `identity.engineHash` against the on-disk binary
  (`stale-binary-running`) and flags `binary-drift` when the lobby is forking
  `build/release/spring-server` while your rebuild went into `build/debug/`.
- **CMake globs are stale for NEW server `.cpp` files.** Adding a file under
  `rts/Server|Sim|Map|Lua` needs a `cmake build/debug` re-configure before the
  incremental build, else the link fails with undefined symbols.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `smoke.sh` FAIL: lobby `/api/version` not responding | Lobby down — start the `lobby` proc in mprocs (or `smoke.sh --start`). |
| Game stuck `frame=-1`, `list_units` empty | `probe_game`/`wait_for_game` names the phase. Usually no connected registered player — attach a browser via the `browserUrl` (or, lobby-flow, create+start your own room as the logged-in browser user). |
| `probe_game` stuck `spawning` while the game demonstrably runs | SPRING_DB ≠ the lobby's `--db` — the probe carries a `warning` naming it; see spring-debug "Self-diagnosis". |
| `modinfo.lua` edit not reflected in `/api/games` | Restart the `lobby` proc (games list is startup-cached). |
| Worker code edit not taking after reload | `restart_client` / `spring-services.sh restart client`; the `?worker` bundle is stale. |
| `restart` says "control server not reachable" | mprocs was started before the `server:` key existed — restart mprocs once so it opens `:4050` (check with `spring-services.sh status`). |
| Two lobbies / logservers, port races | `tools/scripts/spring-services.sh stop`, then restart mprocs. |
| `403 forbidden — admin role required` | Browser user isn't admin — use the `spring-debug` MCP for server actions. |
| Login/auth hangs or fails after a crashed session | Zombie `spring-server` holding `:9100` — `list_stack` classifies it (`zombie-port`), `cleanup_stack {dryRun:false}` clears it; `lsof -i :9100` is the manual fallback. |
| Server self-exited before the browser attached | Startup idle clock — relaunch with `idleGraceSeconds`, or `SPRING_IDLE_STARTUP_GRACE_SECONDS` on the lobby. |
| Testing the wrong binary after `cmake --build` | `list_stack {probeHashes:true}` → `stale-binary-running` / `binary-drift`; restart the server (or lobby). |
| Undefined-symbol link error after adding a server `.cpp` | Stale CMake glob — re-configure (`cmake build/debug`), then rebuild. |
