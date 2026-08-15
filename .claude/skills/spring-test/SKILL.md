---
name: spring-test
description: Test framework for Spring RTS Web. Instant game-launch (skip the lobby), spawn units, give orders, focus the camera on a unit, pause for screenshots, and toggle verbose combat / sound / weapon / explosion / order / unit / script logging. Use when verifying unit scripts, models, sounds, weapons, or combat behaviour without driving the lobby UI by hand.
when_to_use: Use when the user wants to test a unit script, weapon, model, sound, or combat scenario; reproduce a bug deterministically; capture before/after screenshots; or sweep a debug-logging subsystem. Prefer these MCP tools (and the matching `window.test` browser API) over hand-typing commands into the debug console or clicking through the lobby.
user-invocable: false
---

# Spring RTS Web Test Framework

Three coordinated layers:

1. **Server-side verbs** — extensions to `LuaExecEngine`'s `server` exec scope (`spawn`, `kill`, `damage`, `order`, `clear`, `log`, `unit_state`, `combat_summary`). A leading `json ` token on a read verb (`json state`, `json units 0`, `json unit_state <id>`, `json spawn …`) returns a JSON object instead of free text — never regex-scrape these; shapes in [docs/debugging-tools.md](../../../docs/debugging-tools.md#structured-server-verbs-json-prefix).
2. **Browser-side `window.test` (TestHarness)** — exposes camera focus, render-loop pause, screenshot, selection control, and composite helpers (`spawnAndFocus`, `stageCombat`).
3. **MCP tools** — thin wrappers over both layers so Claude can drive a session without a tab open.

The browser API and the MCP tools call the same server verbs underneath — pick whichever fits the workflow. Either changes the same sim state in the same way.

## Quick reference

### Instant game launch (no lobby UI)

The existing `launch_game` MCP tool already bypasses the lobby UI entirely. It POSTs to `/api/rooms/*` to create a room, add an AI, mark ready, and start — all under one auth token.

```
launch_game({ gameId: "papertanks", mapId: "wanderlust2.1", ai: "null" })
```

Returns `{ roomId, gameServerPort, ... }`. Pair it with `list_processes` to confirm the spring-server PID.

### MCP tools added by this skill

| Tool | Purpose |
|------|---------|
| `spawn_unit({defName, x, z, team?, count?})` | Spawn one or more units. Y is auto-resolved from the heightmap. `count > 1` lays them out in a grid. Returns `{spawned, ids:[…]}` — feed `ids` straight into `give_order`/`get_unit_state`. |
| `kill_unit({unitId, selfDestruct?, reclaimed?})` | Destroy a unit (optionally with self-destruct VFX or wreckage drop). |
| `damage_unit({unitId, amount, paralyze?})` | Apply damage. Returns the new HP. |
| `give_order({unitId, cmdId, params?, opts?})` | Issue any CMD.* order. Numeric cmdId — see `client/src/core/command-buffer.ts` for the table. |
| `clear_units({team?})` | Wipe everything (or one team's units). |
| `get_unit_state({unitId})` | Health, position, weapons, per-weapon target/range/reload — as an **object**: `{id, def, team, hp, maxHp, pos:{x,y,z}, heading, weapons:[{index, def, range, reloadFrame, hasTarget}]}`. `weapons[].index` is the unit's own slot (null slots are skipped). |
| `set_debug_logging({combat?, sound?, weapon?, explosion?, order?, unit?, script?})` | Flip subsystem flags. Returns post-call status. |
| `get_combat_summary` | Pending combat / sound queue depths, as `{combat, sounds}`. |
| `pause_sim({paused})` | Pause / unpause the server tick. |
| `set_sim_speed({multiplier})` | Adjust sim speed (0.05 – 100). |
| `revive_team({team?})` | Flip a dead team (or all dead teams, when `team` is omitted) back to alive so units can be spawned onto it. Pair with `set_cheats` so the game-over check doesn't re-kill it. Returns `revived N team(s)`. |
| `set_stockpile({unitId, count, queued?})` | Insta-fill a unit's stockpile weapon (missiles etc.), skipping the whole build cycle — sets `numStockpiled` directly, so it works where `Spring.SetUnitStockpile` silently no-ops on a null stockpile weapon. |
| `profile({target, action?, topN?})` | Server-side profilers. `target:"lua"` → per-callin synced-Lua wall time (`topN` caps the report, default 25); `target:"sim"` → SimFrame phase split (native sim / unit scripts / Lua call-ins), which also appears under `/api/metrics` → `simFrame` once enabled. `action`: `on\|off\|reset\|status\|report` (default `report`). |
| `get_frame({roomId?})` | Sim `frame` + `simFps` + `clients` straight off the public `/api/metrics` route — no exec round-trip, so it answers while the sim is paused or still pre-`GameStart` (`frame: -1`). |
| `browser_test({method, args?})` | Print the chrome-devtools eval string for any `window.test.<method>(args…)` call. The harness lives in the browser; this tool does **not** make the call itself — feed the printed snippet into `mcp__chrome-devtools__evaluate_script`. |

### Browser-side `window.test` (TestHarness)

Exposed after `startGame()` finishes. Removed by `quitToLobby()`.

| Method | Purpose |
|--------|---------|
| `test.spawn(def, x, z, team?, count?)` | Same as `spawn_unit` MCP tool. |
| `test.kill(id, selfDestruct?, reclaimed?)`, `test.damage(id, amount, paralyze?)` | Same as MCP. |
| `test.order(id, cmdId, params?, opts?)` | Issue a single command. |
| `test.clear(team?)` | Wipe all units (or one team). |
| `test.log(subsystem, on)` / `test.setLogging({...})` / `test.logStatus()` | Debug-flag toggles. |
| `test.serverJson(verb, ...args)` | Any converted `server` verb in **structured** form: `serverJson('state')`, `serverJson('units', 0)`, `serverJson('unit_state', 42)`, `serverJson('spawn', def, x, z, team, count)`, `serverJson('cheats','status')`. Returns a parsed object; throws on an unconverted verb or a game server predating the `json ` prefix. |
| `test.state()` / `test.frame()` / `test.units(team?)` / `test.unitState(id)` / `test.combatSummary()` | Read-only sim queries. |
| `test.simPause()` / `test.simResume()` / `test.simSpeed(n)` | Server-side time control. |
| `test.focus(id, {durationMs?, height?})` | Animate the camera over a unit. |
| `test.focusOn(x, z, durationMs?)` | Animate the camera to an XZ point. |
| `test.setCameraHeight(h)` | Force the camera to height `h` over the current target. |
| `test.pause()` / `test.resume()` / `test.paused` | Freeze / resume the render loop (sim keeps running). |
| `test.captureFrame({format?, quality?, maxDim?, region?, stats?, render?})` | **Deterministic capture** — the worker renders and reads pixels in ONE task, so it can never return a between-frames black frame. Returns `{dataUrl, width, height, frameId, gameFrame, stats?}`; `stats:true` adds worker-side `{min,max,mean}` luminance. Prefer this over `screenshot()`. |
| `test.screenshot()` | Legacy: canvas → `image/png` data URL, read whenever the message is processed (can catch a between-render moment). |
| `test.saveScreenshot(name?)` | Triggers a browser download of the canvas as PNG. |
| `test.highResScreenshot(w, h)` | Off-screen RTT render at that exact resolution (it honours its args now — it used to void them). |
| `test.readyState()` | One round-trip, **zero HTTP** readiness: `{worker:{alive,sceneStateAgeMs}, connection:{authenticated,authFailed,receivedState}, frame:{gameFrame,anchored,newestBaseFrame}, render:{frameId,meshCount,terrainMeshCount}}`. Never throws. Use this instead of polling room state. |
| `test.clientFrame()` | Synchronous latest sim frame from the ~10 Hz feed (-1 before it starts). |
| `test.lockInput(on)` / `test.cameraSettle()` / `test.withStableCamera(fn, {toleranceElmos?})` | Camera input lock (drops held keys — a CDP keydown never gets its keyup), transition-settle await, and a run-with-drift-report wrapper that always unlocks. |
| `test.perfCapture(windowMs?, {squad?})` | Reset → wait a REAL window → dump. Closes the reset-then-dump-immediately trap. |
| `test.census()`, `test.factoryQueue()`, `test.pendingBuilds()`, `test.buildChips()`, `test.snapshotStats()`, `test.directives()`, `test.overlayOrders(id)`, `test.markerCount()`, `test.orderAckStats(reset?)`, `test.selectUnits(ids)` | Worker state queries (bindings for cases the worker always had). |
| `test.clientOrder(ids, cmdId, params?, opts?)` | Order down the **real client path** (optimistic overlay + wire encode). `test.order()` bypasses the client entirely via `/api/exec`. |
| `test.widgets()` / `test.setWidget(name, on)` | LuaUI widget list / toggle. `[]` until the Lua runtime boots. URL param `?disableWidgets=a,b` does it at startup. |
| `test.select([ids])` / `test.selection` | Replace / read the current selection. |
| `test.spawnAndFocus(def, x, z, team?, opts?)` | Spawn one unit and animate the camera onto it. Returns the new unit ID. |
| `test.stageCombat(atkDef, tgtDef, x, z, atkTeam?, tgtTeam?, sep?)` | Spawn an attacker + target, issue an attack order. Returns `{attackerId, targetId}`. |
| `test.lua(code)` | Drop down to the LuaRules synced state for anything the verbs don't cover. |
| `test.perfDump()`, `test.uiProfileStart/Dump/Stop()`, `test.netSim*()`, `test.netStats()` | Performance profiling — see the [Performance Profiling](#performance-profiling) section below. |

## Performance Profiling

Three permanent, independent profiling tools also live on `window.test` — drive them the same way as any other method, via `browser_test`. Full reference (output shapes, methodology, budgets, pitfalls): **[docs/debugging-performance.md](../../../docs/debugging-performance.md)**.

| Method | Purpose |
|--------|---------|
| `test.perfDump(windowMs?)` / `test.perfReset()` | Always-on per-phase (camera/entity/fx/decals/render/ui/total) frame-time distribution (mean/p50/p95/p99/max) from the permanent FrameProfiler. |
| `test.uiProfileStart()` / `test.uiProfileDump(topN?)` / `test.uiProfileStop()` | Per-widget LuaUI (Fengari) cost breakdown — which widget/callin is expensive inside the `ui` phase. **Off by default**; brackets a measurement session. Call `uiProfileDump` before `uiProfileStop`, not after — stop clears the data first. |
| `test.netSim({delayMs, jitterMs, lossProb})` / `test.netSimOff()` / `test.netSimPreset("lan"\|"wan"\|"intercont")` | Inject artificial latency/jitter/loss on the state channel — reproduce WAN conditions on localhost. |
| `test.netStats()` | Cumulative inbound/outbound bandwidth tally, per decoded message type. |

```
browser_test({ method: "perfDump" })
browser_test({ method: "uiProfileStart" })
browser_test({ method: "uiProfileDump", args: [20] })
browser_test({ method: "uiProfileStop" })
```

## Recipes

### From scratch: launch a session, spawn a tank, focus on it

```
launch_game({ gameId: "papertanks", mapId: "wanderlust2.1", ai: "null" })
# → wait a beat for spring-server to come up
spawn_unit({ defName: "papertank", x: 4096, z: 4096, team: 0, count: 1 })
# Now in the browser tab:
browser_test({ method: "focus", args: [<id from spawn_unit>] })
# → feed the printed snippet into mcp__chrome-devtools__evaluate_script
```

### Verify weapon firing logs

```
set_debug_logging({ combat: true, sound: true, weapon: true })
# stage two units
api_request({ target: "game", path: "/api/exec", method: "POST",
              body: { scope: "server", code: "spawn papertank 4000 4000 0 1" } })
api_request({ target: "game", path: "/api/exec", method: "POST",
              body: { scope: "server", code: "spawn papertank 4200 4000 1 1" } })
give_order({ unitId: <atk>, cmdId: 20, params: [<tgt>] })  # CMD.ATTACK = 20
# Tail the firing logs
get_logs({ section: "weapon", limit: 20 })
get_logs({ section: "combat", limit: 20 })
get_logs({ section: "sound",  limit: 20 })
```

### Take a deterministic screenshot

```
spawn_unit(...)
pause_sim({ paused: true })             # freeze sim state
browser_test({ method: "pause" })       # freeze rendering
browser_test({ method: "focus", args: [<id>, { durationMs: 0 }] })
browser_test({ method: "captureFrame", args: [{ stats: true }] })
```

`captureFrame` renders and reads in one worker task, so it needs neither the
pause nor a retry loop to avoid a black frame. A paused capture still renders
by default (so pause → focus → capture shows the new view); for two
byte-identical captures of ONE frame, pause and pass `{render: false}`.
For an A/B (toggle → capture → toggle → capture) wrap each arm in
`withStableCamera` so a stray held key cannot pan between the arms.

### Reset between cases

```
clear_units({})
set_debug_logging({ combat: false, sound: false, weapon: false })
```

## CMD.* numeric IDs (most-used)

| ID | Meaning |
|----|---------|
| 0  | STOP |
| 5  | WAIT |
| 10 | MOVE (params: x, y, z) |
| 15 | PATROL (params: x, y, z) |
| 16 | FIGHT (params: x, y, z) |
| 20 | ATTACK (params: targetUnitId — or x, y, z for ground attack) |
| 25 | GUARD (params: targetUnitId) |
| 40 | REPAIR (params: targetUnitId) |
| 65 | SELFD |
| 90 | RECLAIM |

Full table: `client/src/core/command-buffer.ts`. `opts` is a Spring command-options bitfield: 32 = SHIFT (queue), 16 = CTRL, 64 = ALT, 4 = RIGHT.

## Debug logging subsystems

| Subsystem | Source of log lines | Status |
|-----------|---------------------|--------|
| `combat`  | `CombatEventCollector::Push` — every hit/miss/blocked/kill event before broadcast. | live |
| `sound`   | `SoundEventCollector::Push` — every SoundEvent (kind, defId, channel, position). | live |
| `weapon`  | `CWeapon::Fire` — frame, owner, weapon def, type, muzzle/target positions. | live |
| `explosion` | flag exists, hooks not yet wired (placeholder for explosion-projectile creation). | flag-only |
| `order`   | `CCommandAI::GiveCommand` (planned). | flag-only |
| `unit`    | unit lifecycle (planned). | flag-only |
| `script`  | Lua callin entry/exit (planned — very chatty). | flag-only |

Toggle individually via `test.log("combat", true)` / `set_debug_logging({...})`. Tail via `get_logs({ section: "<subsystem>" })` — every line is emitted with that section name.

## Auth & ports

The MCP tools auto-authenticate as `admin/admin` (override via `SPRING_USER`/`SPRING_PASS` env). All `server` exec calls go through the lobby's `/api/exec` route, which proxies to the active game server — no need to discover the dynamic game-server port yourself when using these tools.

**Dev accounts:** `admin` / `admin` and `test1` / `test`.

**Browser ↔ game roster gotcha:** the game server builds a fixed player roster at launch from the room's host + AI slots. A browser session can only connect (WebRTC auth) if it is logged in as a user **in that roster** — otherwise the game logs `auth failed: Not in this room's roster` and the connection is rejected. So `launch_game` must run under the **same username the browser is logged in as**. The browser auto-logs in as `test1`; pass `username: "test1"` to `launch_game` (or re-login the browser as `admin` before launching with the default). After `launch_game` creates+starts the room, drive the browser with `window.lobby.joinRoom(<roomId>)` to connect and render.

**Isolated browser sessions (concurrent Claude sessions):** the chrome-devtools MCP runs with `--isolated`, so each session gets its own fresh browser and several ZK games may be running at once. Always **track the `roomId` your own `launch_game` returned and only `joinRoom` that exact id** — never assume the only/first game in `list_processes` is yours, and only `end_game` rooms you launched. The fresh profile also has no saved login: do a credential login + `lobby.attachSession(token, user_id, username)` **before** the first `joinRoom`, then launch + join immediately (no `leave()`/rejoin churn) or you get `no valid token` / `Not in this room's roster`. Full checklist in the **game-browser-test** skill ("Isolated mode + session discipline").

## When to prefer this over alternatives

- **Over the debug console**: scripted reproducible test cases beat hand-typed verbs.
- **Over `exec_lua`**: the new verbs are shorter, validate parameters, and emit consistent "spawned N unit(s): ID,ID,ID" output that's easy to parse.
- **Over clicking through the lobby**: `launch_game` + `window.test` skips the auth/room dance entirely.

Browser automation: when you need to drive `window.test`, use `mcp__chrome-devtools__evaluate_script` only. **Never** use `mcp__claude-in-chrome__*` (loses page context).
