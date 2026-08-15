# JavaScript API Reference

Runtime interfaces exposed on `window` for debugging, automation, and AI agent integration.

## `window.lobby` — Lobby UI

The `LobbyUI` instance. Available after page load completes.

### State (read-only)

| Property | Type | Description |
|----------|------|-------------|
| `lobby.screen` | `string` | Current screen: `'login'`, `'browser'`, `'room'` |
| `lobby.token` | `string` | Auth token (empty if not logged in) |
| `lobby.playerId` | `number` | Current player's ID |
| `lobby.room` | `object\|null` | Current room: `{ id, name, mapName, gameName, state, players, aiSlots, gameServerPort }` |
| `lobby.roomList` | `array` | All visible rooms: `[{ id, name, mapName, playerCount, maxPlayers, state, hostName }]` |
| `lobby.maps` | `array` | Available maps: `[{ id, name, mapx, mapy, widthElmos, heightElmos, startPositions? }]` |
| `lobby.games` | `array` | Available games: `[{ id, displayName, description, version }]` |
| `lobby.ais` | `array` | Available AIs for current game: `[{ id, displayName, description, isEngineProvided }]` |

Room state values: `1`=Waiting, `2`=Ready, `3`=Starting, `4`=Active, `5`=Ended.

### Room lifecycle

```js
await lobby.createRoom(name, mapId)   // Create and enter a room
await lobby.joinRoom(roomId)          // Join an existing room
await lobby.leave()                   // Leave current room
await lobby.closeRoom()               // Host: delete room, boot everyone
```

### Game setup

```js
await lobby.addAI(aiId, team)         // Add AI player (team is 0-indexed)
await lobby.removeAI(slotIndex)       // Remove AI by slot index
await lobby.setAITeam(slotIndex, team)
await lobby.teamSelect(team)          // Set own team
await lobby.setStartPos(target, pos)  // target: {kind:'self'} | {kind:'player',playerId} | {kind:'ai',slotIndex}
await lobby.ready(true)               // Toggle ready state
await lobby.startGame()               // Host only — launch game server
await lobby.endGame()                 // Host only — stop running game
```

### Data refresh

```js
await lobby.refreshGameList()         // Re-fetch available games
await lobby.refreshAIList()           // Re-fetch AIs for current game
```

### Low-level HTTP

```js
await lobby.lobbyPost(path, body)     // POST with auth header, returns parsed JSON
await lobby.lobbyGet(path)            // GET, returns parsed JSON or null
```

### Quick-start recipe

Create a room, add an AI opponent, and start a game in one block:

```js
// Pick game and map
const game = lobby.games[0].id;       // e.g. 'papertanks' or 'zk'
const map = lobby.maps[0].id;

await lobby.createRoom('test', map);
await lobby.addAI('null', 1);        // AI on team 2 (0-indexed = 1)
await lobby.ready(true);              // Host must ready up
await lobby.startGame();              // Launches game server
```

**Requirements for starting a game:**
1. The room must have players on at least 2 teams
2. The host must be in Ready state
3. Then `startGame()` will succeed

### Selecting a specific game

Set `lobby.selectedGameId` before calling `createRoom` if you want to override the dropdown:

```js
// Not needed if the dropdown already shows the right game — createRoom
// reads from the internal selectedGameId which defaults to the first game.
// The createRoom() call sends whatever selectedGameId is set to.
```

## `window.widgets` — Widget Manager

Available when a game is running with LuaUI widgets loaded. Controls the ZK widget system from JavaScript.

| Method / Property | Description |
|-------------------|-------------|
| `widgets.ready` | `true` after the LuaUI worker has bootstrapped |
| `widgets.vfsFileCount` | Number of Lua files in the VFS cache |
| `widgets.list()` | Toggle the F9 widget list overlay |
| `widgets.enable(name)` | Enable a widget by name (reloads source from server) |
| `widgets.disable(name)` | Disable a widget by name |
| `widgets.toggle(name)` | Toggle a widget (enable forces reload) |
| `widgets.refresh()` | Request a fresh widget list from the worker |

```js
// Examples:
widgets.toggle('Chili Framework');
widgets.disable('Map Edge Extension');
widgets.enable('Chili Framework');  // re-fetches from server
widgets.list();                     // open/close the F9 overlay
```

The widget list overlay (F9 or `widgets.list()`) shows checkboxes next to each widget for interactive enable/disable. Enabling a widget re-fetches its source from the lobby server, so toggling off→on serves as a reload action.

## `window.springrts` — Detach / Re-enter (PLAN-quickstart Part B)

Leave and re-enter a running game **without paying the full client boot**. Available after `startGame()` completes; removed by `quitToLobby()`. Wired in [client/src/main.ts](../client/src/main.ts); the parking/keying logic is [client/src/core/detach-session.ts](../client/src/core/detach-session.ts).

**Detach vs quit.** *Quit* (`quitToLobby`, the HUD "Quit" button) tears the game-processor worker down — engine, scene, loaded models, DefCache all destroyed; re-entry is a full boot. *Detach* parks the worker instead: it closes the game connection and pauses its render loop, but keeps engine/scene/models/DefCache/UI alive. Re-entry is a fast reconnect + partial resync.

```js
window.springrts.detach()    // park the running game, show the lobby (worker stays warm)
window.springrts.reenter()   // re-enter the parked game — resync if still valid, else full boot
window.springrts.parked      // → boolean: true while a session is parked
```

- **`detach()`** — no-op before the first rendered frame (you can only park a running game — edge case E3) or when a session is already parked. Suspends audio, hides the game surface, keeps the saved room/port keys (they are the reconnect creds), and starts a **~10 min TTL** after which the parked worker is disposed. **Metalstorm is the intended target**; the mechanism is game-agnostic but BAR/ZK keep plain `quitToLobby` (their Fengari unit-script boot makes warm re-entry the only viable path, and reconnect-safe Fengari state is unproven — out of scope per the plan).
- **`reenter()`** — reconnects the parked worker and flushes *dynamic* state (entities, projectiles, combat FX, interpolator) while keeping *static* state (terrain, models, DefCache, lighting, UI). A fresh server-side ClientSession re-streams a full snapshot + re-pushes defs (DefCache no-ops the duplicates); the world repopulates within a few ticks. Falls back to a **full boot** when the parked session no longer matches: TTL expired, a *different* room, or the room's game server was restarted onto a new port (edge case E5) — it never resyncs against a different game instance.
- **`parked`** — the parked-state getter, useful as a scenario-completion / assertion signal.

> The game only ticks while a client is connected (server design note): a solo dev who detaches pauses the sim until re-entry — usually *desired* for testing; multiplayer games have other clients keeping it live.

The polished lobby "return to game" card and the `PlayerRemoved(reason=detach)` sim wiring are Part B task 6; these globals are the functional/scenario-testable surface today.

## `window.test` — Test Harness

In-game scripted-testing API. Available after `startGame()` completes; removed by `quitToLobby()`. Defined in [client/src/core/test-harness.ts](../client/src/core/test-harness.ts).

The harness combines server-side actions (spawn / kill / damage / order / log toggles) with client-side controls (camera focus, render-loop pause, screenshots). Server actions go through `lobby.lobbyPost('/api/exec', …)` so they share auth + scope routing with the debug console.

### Server-bound actions

```js
await test.spawn('papertank', 4096, 4096, 0, 4)  // def, x, z, team, count
await test.kill(unitId, /*selfDestruct*/ true)
await test.damage(unitId, 250)
await test.order(unitId, 10 /*CMD.MOVE*/, [x, y, z])
await test.clear(0)                              // wipe team 0; omit for all
await test.lua('return Spring.GetTeamUnitCount(0)')
```

### Debug logging toggles

```js
await test.log('combat',  true)
await test.log('weapon',  true)
await test.setLogging({ combat: true, sound: true, weapon: false })
await test.logStatus()                           // current flag state
```

Subsystems: `combat`, `sound`, `weapon`, `explosion`, `order`, `unit`, `script`. Each logged line lands under that subsystem name in the log server (`get_logs({section: 'combat'})`).

### Read-only sim queries

```js
await test.state()        // 'frame=N teams=M units=K'
await test.frame()        // current sim frame
await test.units(0)       // 'id=… def=… team=0 hp=…/…' lines
await test.unitState(42)  // dump health/pos/weapons for a unit
await test.combatSummary()
```

### Model harness: orbit rig + sun control (PLAN-model-harness)

Dev/test camera + lighting verbs; both live worker-side (dispatch wrappers).
While the orbit rig is active the RTS camera input path is suppressed —
drag orbits (pitch clamped 5°–85°), wheel zooms (1.2×–10× of the target's
bounding-sphere radius); `orbitStop()` restores the saved RTS pose.

```js
await test.orbit(unitId)                     // start + auto-frame; follow mode tracks the unit
await test.orbit({ x, z, radius: 60 })       // static ground anchor (wreck inspection)
await test.orbitSet({ yawDeg: 90, pitchDeg: 20, follow: false })
await test.orbitFrame(0.7)                   // sphere fills 70% of the shorter viewport axis
await test.orbitState()                      // { yawDeg, pitchDeg, distance, follow, anchor }
await test.orbitStop()

await test.sun({ azimuthDeg: 200, elevationDeg: 8 })  // low golden sun — shadow-acne check
await test.sun({ elevationDeg: -20 })        // below horizon = night preset (ambient floor)
await test.sunCycle(60)                      // full day–night every 60 s (0 = freeze)
await test.sun(null)                         // restore the map's authored lighting
await test.getSun()

await test.listUnitDefs()                    // streamed defs (worker DefCache)
await test.unitDefByName('cormaw')           // full wire UnitDefInfo or null
await test.entityBounds(unitId)              // { x,y,z,radius, hasModel } — false = fallback shape
test.setWireframe(true)

// Generic clip player (task 6) — authored .glb animation clips, played
// through the client-animator wrapper (core/clip-player.ts). Converted
// S3O/DAE models have no clips; native glTF assets (Metalstorm /
// beta-units) do. Rigid node clips render; skinned clips only move joint
// nodes until fx-offload's animation textures land.
await test.listClips(unitId)                 // null = model loading; [] = no clips
await test.playClip(unitId, 'walk', { loop: true, speed: 1 })
await test.clipState()                       // { unitId, clip, frame, playing } | null
await test.stopClip()                        // back to rest / server piece pose
```

The sun override is purely client-side render state (the sim has no
time-of-day — deliberately; see PLAN-model-harness §6) and re-applies every
frame, so game Lua lighting churn can't clobber it.

### Sim time control

```js
await test.simPause()     // gs->paused = true (sim freezes)
await test.simResume()
await test.simSpeed(0.25) // slow-mo for combat inspection
```

### Camera

```js
await test.focus(unitId, { durationMs: 600, height: 800 })
await test.focusOn(x, z, 600)
test.setCameraHeight(800)
```

### Render-loop pause + screenshots

```js
test.pause()                    // freeze rendering (sim continues unless simPause())
test.resume()
test.paused                      // boolean

test.screenshot()                // canvas → 'data:image/png;base64,…'
test.saveScreenshot('shot.png')  // browser download
await test.highResScreenshot(1920, 1080)  // off-screen render
```

### Selection

```js
test.select([42, 43])
test.selection                  // readonly number[]
```

### Composite helpers

```js
const id = await test.spawnAndFocus('papertank', 4000, 4000, 0)
const { attackerId, targetId } =
    await test.stageCombat('papertank', 'papertank', 4096, 4096, /*atkTeam*/ 0, /*tgtTeam*/ 1)
```

Driven from `mcp__chrome-devtools__evaluate_script`:

```js
await window.test.spawn('papertank', 4096, 4096, 0, 4)
```

Or use the `browser_test` MCP tool (in the spring-debug server) to generate the snippet automatically.

### `?play=<scenarioId>` — one URL, straight into a game

`?play=` boots a game scenario with **no login screen and no lobby UI**. It is
the browser half of the `launch_scenario` MCP tool (see
[debugging-tools.md](debugging-tools.md)) and needs the lobby to run with
`--dev-direct-start`.

```
http://localhost:8012/?play=crossing_standoff
http://localhost:8012/?play=crossing_standoff&side=union&ai=null
http://localhost:8012/?play=crossing_standoff&game=metalstorm&room=12&user=admin&skipBriefing=1#token=…
```

| Param | Meaning |
|---|---|
| `play` | Scenario id — the file stem of `data/games/<game>/scenarios/<id>.lua`. |
| `game` | Game id, default `metalstorm`. |
| `side` | Playable faction key to seat *you* on (default: the scenario's first side). An unknown key shows the valid list. |
| `ai` | AI id for every other playable side, default `strategos`. `&ai=` (empty) requests no AI slots. |
| `map` | Map override; default is the scenario's declared map. |
| `room`, `user` + `#token=` | **Attach mode** — adopt an already-running room instead of launching one. This is the form `launch_scenario` returns. |
| `skipBriefing` | Reserved for the S2 briefing splash; parsed and threaded today, no-op until that lands. |

Two modes, both in [`main.ts`'s `bootPlay`](../client/src/main.ts), with the
pure derivation in [`client/src/lobby/play-boot.ts`](../client/src/lobby/play-boot.ts):

- **Attach** (`room`+`user`+`#token`): fetches the public `GET /api/rooms`,
  finds that room and `attachSession`s into it. It never re-POSTs — a bare
  `?play=` would replace the room *by name* and tear down the very server the
  launcher just waited on. If the room is gone or Ended it falls through to a
  fresh launch, so a play link never dangles.
- **Fresh**: runs the auto-auth ladder — stored session (`/api/auth/validate`,
  one refresh attempt) → guest resume (`/api/auth/guest/resume`) → guest mint
  (`/api/auth/guest`) → **only then** the login form. It then POSTs
  `/api/rooms/direct` with a manifest naming the room `play:<scenarioId>:<username>`
  (per-user so two browsers do not tear each other's games down; per-scenario so
  re-opening the same link replaces your own stale room instead of leaking rooms).

Traps:

- The token rides the **hash fragment**, never the query string, so it stays out
  of the lobby access log and the Vite log. Browser history still holds it.
- `/api/rooms/direct` is `LocalhostOrAdmin`. A guest is `role:'player'`, so
  `?play=` works from a browser **on the lobby host**, or from an admin session
  — a remote guest gets a 403 and an error overlay saying so.
- Guest mint is rate-limited 20/min. A loop that wipes browser storage every
  iteration will 429; the stored device token (rung 3) is what keeps a loop cheap.
- `?direct=` and `?scenario=` win if combined with `?play=` (console warning).
- Any boot failure now paints a copyable `#boot-error` overlay instead of the
  old blank page — that applies to `?direct=` too.

### Driving scenarios for iterative testing

Scenarios live in [client/src/scenarios/](../client/src/scenarios/) and are launched via `?scenario=<name>` (e.g. `?scenario=weapon-showcase&only=missile&dwellMs=60000`). The runner ([client/src/scenarios/runner.ts](../client/src/scenarios/runner.ts)) auto-logs in as `test1:test`, waits for first frame, runs `scenario.setup(h)`, then `scenario.run(h)` if defined.

> **Direct start is the default room path (PLAN-quickstart Part A).** The runner serialises its scenario into one `POST /api/rooms/direct` call (pre-authorised token, room driven straight to Active) — no login/leaveAll/create/addAI/ready/start dance. The legacy lobby-walk survives **only** behind `?via=lobby`, kept deliberately as a `lobby-flow` regression scenario that exercises the full lobby surface; it is no longer the tax every test pays. Prefer the default direct path for all new bench scenarios.

**ZK cold-boot is ~150 s** because of unit-script loading. For iterative debugging (render/material/shader fixes), reloading the page for every change is painful.

#### Pitfalls

- **`wait_for` watches DOM text, not console logs.** Scenario progress is logged to the console, not painted to the page. Polling `window.scenarioResults` via `evaluate_script` is the only reliable completion signal.
- **Editing any TypeScript file the scenario imports triggers Vite HMR → full page reload.** That kills the running game server's room association and the runner spins up a *new* room (another 150 s wait). For debug-and-verify loops, edit the source **once** to land the real fix, then drive verification via inline `evaluate_script` against `window.test`.
- **`clearArena` leaves both teams empty.** ZK's game-over check (`game_over.lua`) flips the room to "Game Over" once an ally team has no units. The render canvas goes dark and synthetic injection has no visible background. Spawn at least one unit on team 0 *and* team 1 before clearing if you want to keep the game live across iterations.

#### Polling scenario completion

```js
// In evaluate_script — returns null until runner publishes,
// then { name, startedAt, status: 'running'|'pass'|'fail'|'error', finishedAt, assertions }.
window.scenarioResults
```

Poll every 30–60 s instead of trying to time it. The `status` field is the canonical completion signal.

#### model-viewer scenario (PLAN-model-harness)

One unit centre-stage on the bench map, with derived showcase buttons, the
orbit rig, the sun control, and headless capture presets:

```
?scenario=model-viewer&game=papertanks&def=pt_lighttank      interactive (F8 panel)
?scenario=model-viewer&game=zk&def=cormaw&capture=turntable  headless capture
```

Params: `game` (default: sticky dev game id, else `zk`), `def` (optional in
interactive mode — the panel has a searchable picker), `map` (default
`green_flat_x34_v3`), `capture` = `turntable` | `clips` | `sun`, `views`
(turntable headings, default 8), `download=0` (manifest only, no file
downloads).

- **F8** toggles the dev panel (Unit / Showcases / Camera / Sun & light /
  Render groups). Buttons are **derived** from the def's capability probe
  (`client/src/scenarios/model-viewer/capability-probe.ts`) — a transport
  shows Load/carry/unload, a factory shows Produce, etc.
- Every routine ends in a stage reset (dummies cleared, sim speed restored,
  stage respawned if destroyed, camera re-framed).
- A def that spawns as a procedural fallback shape gets a loud
  `fallback-model` badge — that *is* a test outcome (E1).
- Models that ship authored .glb clips get one **Play clip: X** toggle per
  clip (task 6) — looping playback via `test.playClip`, highlighted while
  active, stopped by re-click / respawn / stage reset. Converted S3O/DAE
  models list none, so the row is empty on ZK/BAR.
- Progress + results: `window.modelViewer.state` (phase / running /
  showcases / clips / playingClip / badge), `window.modelViewer.captures`
  (data-URL manifest for MCP/CI pulls), `window.modelViewer.api`
  (`respawn(def)`, `run(id)`, `stopReset()`, `capture(preset)`,
  `playClip(name)`).

Capture presets (`&capture=`): `turntable` = N headings at noon light (the
beta-units golden / PoC judgment set), `clips` = 4-frame strip per
movement/fire/build routine, `sun` = fixed pose × 5 elevations (shadow
regression). Frames land as downloads plus the `captures` manifest.

#### Re-firing a single weapon entry without reload

After a `weapon-showcase` cycle completes the renderer state survives. Re-fire any entry by calling the harness directly — no file edit, no reload:

```js
// In evaluate_script:
const h = window.test, cx = 8704, cz = 8704;
await h.clear();
await new Promise(r => setTimeout(r, 300));
const sId = Number((await h.spawn('staticnuke', cx - 800, cz, 0, 1)).match(/:\s*(\d+)/)[1]);
const tId = Number((await h.spawn('damagesink', cx + 800, cz, 1, 1)).match(/:\s*(\d+)/)[1]);
await h.lua(`
  Spring.GiveOrderToUnit(${tId}, 50, {0}, 0)   -- hold-position
  Spring.GiveOrderToUnit(${tId}, 45, {0}, 0)   -- hold-fire
  Spring.SetUnitMaxHealth(${tId}, 1e9)
  Spring.SetUnitHealth(${tId}, 1e9)
`);
await h.stockpile(sId, 4, 0);                  // for stockpile-gated weapons
await h.cameraSnapToGround(cx, cz, { height: 1400, pitchDeg: 40, durationMs: 0 });
await h.order(sId, 20 /*CMD_ATTACK*/, [cx + 800, 0, cz]);   // ground attack
await h.simSpeed(0.1);
```

Combined with `set_sim_speed` and `pause_sim` from `mcp__spring-debug`, this gives a tight inspect → patch → re-fire loop in single-digit seconds per iteration.

#### Synthetic renderer verification

For verifying shader/material configuration without waiting for a live projectile, inject thin-instance data directly into the renderer's per-def visuals. Example for trail puffs:

```js
const pr = window.__projectileRenderer;
const v = pr.trailVisuals.get(defId);          // existing visual from a prior fire
const matrices = new Float32Array(N * 16);
const alphas = new Float32Array(N);
// ...compose camera-facing billboard matrices into `matrices`...
v.mesh.thinInstanceSetBuffer('matrix', matrices, 16, false);
v.mesh.thinInstanceSetBuffer('alpha', alphas, 1, false);
v.mesh.thinInstanceCount = N;
v.mesh.isVisible = true;
// Repin in an interval if the per-tick flush clobbers it.
```

Useful for testing material flags (`needAlphaBlending`, `alphaMode`, `renderingGroupId`) without re-staging combat.

#### Live-patching materials before source edit

Before editing the source, validate the hypothesis live:

```js
const m = pr.trailVisuals.get(defId).material;
m.needAlphaBlending = () => true;              // monkey-patch
// take screenshot, compare
m.needAlphaBlending = function() { return this.alpha < 1.0 || (this._options?.needAlphaBlending ?? false); };
// revert, compare
```

If the patch flips the visual, the source fix is the canonical equivalent (in this case, `needAlphaBlending: true` in the `ShaderMaterial` constructor options).

## `window.debugConsole` — Debug Console

The in-game debug console (opened with backtick `` ` ``). Provides:

| Method | Description |
|--------|-------------|
| `debugConsole.toggleInspector()` | Toggle the network inspector panel |

The debug console also supports tabbed scopes (LuaRules, LuaGaia, server, lobby, sql) for executing commands against the running game server.

## Using from automation tools

### Chrome DevTools MCP (`evaluate_script`)

```js
// In evaluate_script:
await lobby.createRoom('test', 'pools_of_ilys_1.0.0');
```

### Browser console

All `window.lobby` methods are available directly in the browser console (F12 → Console tab).

### Checking state

```js
// Is a game running?
lobby.room?.state === 4

// What map?
lobby.room?.mapName

// How many players?
lobby.room?.players.length

// Am I authenticated?
lobby.token !== ''
```
