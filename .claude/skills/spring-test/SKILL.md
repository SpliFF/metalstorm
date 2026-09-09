---
name: spring-test
description: Test framework for Spring RTS Web. Instant game-launch (skip the lobby), spawn units, give orders, focus the camera on a unit, pause for screenshots, and toggle verbose combat / sound / weapon / explosion / order / unit / script logging. Use when verifying unit scripts, models, sounds, weapons, or combat behaviour without driving the lobby UI by hand.
when_to_use: Use when the user wants to test a unit script, weapon, model, sound, or combat scenario; reproduce a bug deterministically; capture before/after screenshots; or sweep a debug-logging subsystem. Prefer these MCP tools (and the matching `window.test` browser API) over hand-typing commands into the debug console or clicking through the lobby.
user-invocable: false
---

# Spring RTS Web Test Framework

**The default loop** — every recipe below is a variation of this:

```
launch_scenario({ scenarioId: "crossing_standoff", wait: "ticking", openBrowser: true })
# → {roomId, port, sessions, browserUrl, phase:"ticking", frame, browser:{pid, connected:true, clientId}}
spawn_unit / give_order / get_unit_state / …        # structured JSON returns
capture_subject({ unitId }) / client_screenshot({ maxDim: 640 })   # look at it (relay, no CDP)
end_game({ roomId })                                # graceful teardown — closes that browser too
```

Browserless (exec-only sweeps): `launch_scenario({scenarioId, wait: "ready", idleGraceSeconds: 600})` —
`ready` is as far as a human roster gets without a client (frame −1; spawns and
orders still execute, nothing moves). Roster AI-only via `launch_direct` for a
ticking sim with no browser.

Three coordinated layers underneath:

1. **Server-side verbs** — extensions to `LuaExecEngine`'s `server` exec scope (`spawn`, `kill`, `damage`, `order`, `clear`, `log`, `unit_state`, `combat_summary`). A leading `json ` token on a read verb (`json state`, `json units 0`, `json unit_state <id>`, `json spawn …`) returns a JSON object instead of free text — never regex-scrape these; shapes in [docs/debugging-tools.md](../../../docs/debugging-tools.md#structured-server-verbs-json-prefix). The MCP tools use the `json ` form for you and return objects.
2. **Browser-side `window.test` (TestHarness)** — camera focus, render-loop pause, deterministic frame capture, selection control, and composite helpers (`spawnAndFocus`, `stageCombat`).
3. **MCP tools** — wrappers over both layers, including a relay that runs browser-side calls in a connected client **without a CDP session**.

The browser API and the MCP tools call the same server verbs underneath — pick whichever fits the workflow. Either changes the same sim state in the same way.

## Getting a test game: `launch_scenario`

**`launch_scenario` is THE way to get a test game.** One call resolves a scenario, builds the `/api/rooms/direct` manifest in memory (scenario as the **top-level** field), POSTs it, and waits — no lobby UI, no login, no roster dance. It returns `{roomId, port, sessions, browserUrl, phase, frame}`.

```
launch_scenario({ scenarioId: "crossing_standoff", wait: "ticking", openBrowser: true })
```

- **`openBrowser:true` is what makes `wait:'ticking'` reachable.** The default roster seats a human (`admin`), and the sim holds `GameStart` at frame −1 until that client connects. The MCP launches a headless Chrome (`browserHeadless:false` to watch), tracks it (`list_clients`), and `end_game` closes it. Without it, `wait:'ready'` is the only reachable target and `wait:'ticking'` (the schema default) times out **by design**.
- **Attaching a browser later:** `open_client({roomId})` reuses the attach URL remembered from the launch. Only for a browser the MCP must not own do you navigate by hand to the returned `browserUrl` — `?play=…&room=<id>&skipBriefing=1#token=…` auto-auths as the host's own direct-minted session and **attaches** to that exact room (drop `skipBriefing` to test the splash itself). No login step, no roster mismatch possible.
- **Browserless runs** (exec-driven sweeps): pass `idleGraceSeconds` — the default 120 s startup grace self-exits an unattended server at frame −1. Roster AI-only (`launch_direct`) if you need ticking without a browser. (`headless:true` omits the `browserUrl` and warns about the idle clock.)
- **Teardown:** `end_game({roomId})` — graceful SIGTERM with a drain-quality report. Always finish here.

`launch_direct({manifest})` is the raw-manifest sibling for custom rosters/modoptions/`sessionKind`/idle timers. `launch_game` exists for **lobby-flow regression testing only** (create room → add AI → ready → start under one auth token) — it re-introduces the browser-user-vs-roster coupling that `launch_scenario` makes impossible; that discipline lives in the **game-browser-test** skill.

## MCP tools added by this skill

| Tool | Purpose |
|------|---------|
| `spawn_unit({defName, x, z, team?, count?})` | Spawn one or more units. Y is auto-resolved from the heightmap. `count > 1` lays them out in a grid. Returns `{spawned, ids:[…]}` — feed `ids` straight into `give_order`/`get_unit_state`. |
| `kill_unit({unitId, selfDestruct?, reclaimed?})` | Destroy a unit (optionally with self-destruct VFX or wreckage drop). |
| `damage_unit({unitId, amount, paralyze?})` | Apply damage. Returns the new HP. |
| `give_order({unitId, cmdId, params?, opts?})` | Issue any CMD.* order. Numeric cmdId — see the table below. |
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

## Browser work without CDP: the relay tools

These run code **in the connected browser** over the game server's wire and return the answer — no chrome-devtools session needed (they work against any attached client, including a headless one):

| Tool | Purpose |
|------|---------|
| `capture_subject({unitId\|unitIds\|def\|position\|area, spawn?, angle?, pause?, reveal?, …})` | **Subject → usable image, in one call** — resolves the subject, frames it from its own model bounds, orders spawn/reveal → settle → pause correctly, captures a presented frame and checks the luminance before returning. Use this instead of assembling `pause_sim` + `browser_test focus` + `client_screenshot`; that version costs one relay hop each (seconds, during which the sim moves) and guesses the zoom. See the spring-debug skill. |
| `capture_sequence({subject, frames?, everyNthSimFrame?, mode?, simSpeed?, name?, outDir?, …})` | **Film a manoeuvre → N images on disk, in one call.** Same subject selectors and auto-framing as `capture_subject`, re-framed before every shot. `mode:"step"` (default) advances the sim by `sim_step` between shots so the spacing is EXACT however long each capture took; `mode:"realtime"` slows the sim and bursts browser-side (hard ~6.5 s ceiling — the relay abandons an evaluation at 8 s). N shots of the same instant comes back `UNUSABLE`, not as a film. |
| `order_and_film({unitId, move\|attack\|order, …})` | Give an order, poll until the unit is **genuinely moving** (rotation counts — a tank reversing course barely translates), then film it. The gap between order-acknowledged and unit-moving is where hand-driven tooling loses the subject. |
| `step_sim({frames?, roomId?})` | Advance the sim by exactly N frames from a stop, and wait for it to land. Pauses first if it was running. Use it to interleave an order or a probe between filmed frames. |
| `client_screenshot({maxDim?, quality?, roomId?, clientId?})` | A real image you can **see** — relays `captureFrame({maxDim, stats:true})` and returns an MCP image block plus the capture metadata. `maxDim` clamped to 2048. The raw shutter under `capture_subject`: use it when the camera is already where you want it. |
| `client_ready({roomId?, clientId?})` | The **browser's** readiness (`readyState()`): renderer, defs, LuaUI, newest frame, feed age. `wait_for_game` is the server-side question — a game can be server-ready while the tab still ingests defs. |
| `client_eval({code, target?, roomId?, clientId?, timeoutMs?})` | Arbitrary code in the browser. `target`: `js` (main globals) · `worker` (render-worker globals — `__entityRenderer`, `__csm`, `__renderPipeline`, `__fxLightPool`) · `widgets` (Lua in the LuaUI runtime) · `test` (an expression with the harness's members in scope, no `test.` prefix). |
| `browser_test({method, args?})` | Call any `window.test.<method>(args…)` and return its result. Falls back to printing the chrome-devtools snippet when a gate refuses. **Refuses the server-bound methods by name** (`spawn`, `kill`, `damage`, `order`, `clear`, `state`, `units`, `unitState`, `frame`, `lua`, `server`, `simPause`, `simSpeed`, …) and names the server-side tool instead — see the deadlock note below. |

**The relay's three gates.** Every browser-bound tool answers for real when all
three pass, and otherwise prints its old snippet with the reason on the first
line: (1) the route is compiled out under `SPRING_PROD`; (2) only an
**admin-role** session is addressed — a `/api/rooms/direct` dev account is role
`player` and is **never** eligible, while `launch_scenario`'s default player *is*
`admin`; (3) the page must be a DEV build or booted `?allowClientEval=1`.

> **Never relay code that calls back into the game server.** The game server
> serves HTTP on one thread and that thread is parked waiting for the browser,
> so `window.test.spawn/lua/state/…` deadlock until the timeout (`/api/metrics`
> stops answering meanwhile). Use `spawn_unit` / `exec_lua` / `get_game_state`.
> `spawn_at_camera` already does the right thing: it relays only the camera read
> and spawns server-side.

## Browser-side `window.test` (TestHarness)

Exposed after `startGame()` finishes, removed by `quitToLobby()`. The method
table (capture, readiness, camera, selection, sim time, worker queries,
`serverJson`, composite helpers) and the three profiling families
(`perfDump`/`perfCapture`, `uiProfile*`, `netSim*`/`netStats`) are in
**[window-test-reference.md](window-test-reference.md)**. Drive any of them
with `browser_test({method, args})` or `client_eval({target:'test', code})`.
Never relay a server-bound method (`spawn`, `lua`, `state`, …) — see the
deadlock note above.


## Recipes

### From scratch: launch a session, spawn a tank, look at it

```
launch_scenario({ scenarioId: "crossing_standoff", wait: "ticking", openBrowser: true })
# → returns with phase:"ticking" and a connected headless client (~3 s); no "wait a beat" guesswork.
spawn_unit({ defName: "ms_tanks_s1", x: 4096, z: 4096, team: 0, count: 1 })
capture_subject({ unitId: <id from spawn_unit>, angle: "three-quarter" })   # framed, held, luminance-checked
end_game({ roomId: <id> })              # graceful teardown — closes the browser too; always finish here
```

### Verify weapon firing logs (browserless)

```
launch_scenario({ scenarioId: "crossing_standoff", wait: "ready", headless: true, idleGraceSeconds: 600 })
set_debug_logging({ combat: true, sound: true, weapon: true })
spawn_unit({ defName: "ms_tanks_s1", x: 4000, z: 4000, team: 0, count: 1 })
spawn_unit({ defName: "ms_tanks_s1", x: 4200, z: 4000, team: 1, count: 1 })
give_order({ unitId: <atk>, cmdId: 20, params: [<tgt>] })  # CMD.ATTACK = 20
get_logs({ section: "weapon", limit: 20, roomId: <id> })
get_logs({ section: "combat", limit: 20, roomId: <id> })
end_game({ roomId: <id> })
```

(A human-roster sim stays at frame −1 without a browser; spawns and orders still execute pre-GameStart, but nothing moves. Roster AI-only via `launch_direct` if the test needs a ticking sim with no client.)

### Take a deterministic screenshot

**Default to `capture_subject` (spring-debug MCP).** One call does the whole
sequence below — and does it in ONE relay round trip, which the four-call
version cannot: each hop costs seconds and the sim keeps running between them
(a 2026-08-29 run lost 1,000+ frames between the camera call and the shot).
It also frames from the subject's own model bounds instead of a guessed
`height`, and refuses to hand back a black frame.

```
capture_subject({ def: "ms_subs_s4", angle: "side" })
capture_subject({ def: "fable_tank", spawn: { x: 8704, z: 15360 }, angle: "low" })
```

⚠ If you do drive it by hand: **spawn BEFORE you pause.** A paused sim streams
no fresh spawns, so `spawn → pause → capture` photographs empty ground.

The manual sequence, for when you need a step `capture_subject` does not do:

```
spawn_unit(...)
# let the spawn stream to the browser BEFORE freezing the sim
pause_sim({ paused: true })             # freeze sim state
browser_test({ method: "pause" })       # freeze rendering
browser_test({ method: "focus", args: [<id>, { durationMs: 0 }] })
client_screenshot({ maxDim: 1280 })     # returns an image block, not a dataURL
```

`client_screenshot` is the quick path — one call, and the picture comes back as
something you can actually look at. Reach for `browser_test({method:"captureFrame"})`
when you want the raw `{dataUrl, width, height, frameId, gameFrame, stats}`
object (e.g. to diff two captures, or to pass `{render:false}`).

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

**Dev accounts:** `admin` / `admin` and `test1` / `test` (note: `test1` now has the **admin** role too — don't rely on it as a non-admin control; register a fresh user for role-gating tests). Def names: there is no `ms_scout` — real defs are `ms_scout_buggy` and the squad families `ms_tanks_s1..s4`, `ms_soldiers_s1..`, etc.; `list_unit_defs` is the authority. The `window.test` table above is the core set, not exhaustive — the harness also exposes orbit/sun/clip playback, `listUnitDefs`/`unitDefByName`, `entityBounds`, LOD/wireframe toggles, minimap capture, `squadPerf`, camera slots, `stockpile`/`cheats`/`reviveTeam` (see client/src/core/test-harness.ts). `meridian_basin.lua` (the scenario) is retired; `crossing_standoff` on `scorched_crossing_v2.4` is the live showcase war.

On the `launch_scenario` path none of the browser-login machinery applies — the `browserUrl` carries the host's own session. The **roster coupling** trap (a game server only admits browser users in its launch-time roster, so `launch_game` must run as the same user the browser is logged in as) only exists on the `launch_game` lobby-flow path; that discipline, and the isolated-profile login recipe for concurrent sessions, live in the **game-browser-test** skill ("Isolated mode + session discipline").

## When to prefer this over alternatives

- **Over the debug console**: scripted reproducible test cases beat hand-typed verbs.
- **Over `exec_lua`**: the verbs are shorter, validate parameters, and return structured JSON (`{spawned, ids}`, `{id, hp, weapons[]}`) instead of text to scrape.
- **Over clicking through the lobby**: `launch_scenario` + the relay tools skip the auth/room dance entirely.
- **Over CDP for browser work**: `client_eval`/`client_screenshot`/`browser_test` answer without a devtools session when a client is connected. When you do need real CDP (DOM, network, clicks), use `mcp__chrome-devtools__*` only — **never** `mcp__claude-in-chrome__*` (loses page context).
