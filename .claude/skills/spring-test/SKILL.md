---
name: spring-test
description: Test framework for Spring RTS Web. Instant game-launch (skip the lobby), spawn units, give orders, focus the camera on a unit, pause for screenshots, and toggle verbose combat / sound / weapon / explosion / order / unit / script logging. Use when verifying unit scripts, models, sounds, weapons, or combat behaviour without driving the lobby UI by hand.
when_to_use: Use when the user wants to test a unit script, weapon, model, sound, or combat scenario; reproduce a bug deterministically; capture before/after screenshots; or sweep a debug-logging subsystem. Prefer these MCP tools (and the matching `window.test` browser API) over hand-typing commands into the debug console or clicking through the lobby.
user-invocable: false
---

# Spring RTS Web Test Framework

Three coordinated layers:

1. **Server-side verbs** — extensions to `LuaExecEngine`'s `server` exec scope (`spawn`, `kill`, `damage`, `order`, `clear`, `log`, `unit_state`, `combat_summary`).
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
| `spawn_unit({defName, x, z, team?, count?})` | Spawn one or more units. Y is auto-resolved from the heightmap. `count > 1` lays them out in a grid. |
| `kill_unit({unitId, selfDestruct?, reclaimed?})` | Destroy a unit (optionally with self-destruct VFX or wreckage drop). |
| `damage_unit({unitId, amount, paralyze?})` | Apply damage. Returns the new HP. |
| `give_order({unitId, cmdId, params?, opts?})` | Issue any CMD.* order. Numeric cmdId — see `client/src/core/command-buffer.ts` for the table. |
| `clear_units({team?})` | Wipe everything (or one team's units). |
| `get_unit_state({unitId})` | Health, position, weapons, per-weapon target/range/reload. |
| `set_debug_logging({combat?, sound?, weapon?, explosion?, order?, unit?, script?})` | Flip subsystem flags. Returns post-call status. |
| `get_combat_summary` | Pending combat / sound / death queue depths. |
| `pause_sim({paused})` | Pause / unpause the server tick. |
| `set_sim_speed({multiplier})` | Adjust sim speed (0.05 – 100). |
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
| `test.state()` / `test.frame()` / `test.units(team?)` / `test.unitState(id)` / `test.combatSummary()` | Read-only sim queries. |
| `test.simPause()` / `test.simResume()` / `test.simSpeed(n)` | Server-side time control. |
| `test.focus(id, {durationMs?, height?})` | Animate the camera over a unit. |
| `test.focusOn(x, z, durationMs?)` | Animate the camera to an XZ point. |
| `test.setCameraHeight(h)` | Force the camera to height `h` over the current target. |
| `test.pause()` / `test.resume()` / `test.paused` | Freeze / resume the render loop (sim keeps running). |
| `test.screenshot()` | Returns the canvas as a `image/png` data URL. |
| `test.saveScreenshot(name?)` | Triggers a browser download of the canvas as PNG. |
| `test.highResScreenshot(w, h)` | Off-screen render at arbitrary resolution. |
| `test.select([ids])` / `test.selection` | Replace / read the current selection. |
| `test.spawnAndFocus(def, x, z, team?, opts?)` | Spawn one unit and animate the camera onto it. Returns the new unit ID. |
| `test.stageCombat(atkDef, tgtDef, x, z, atkTeam?, tgtTeam?, sep?)` | Spawn an attacker + target, issue an attack order. Returns `{attackerId, targetId}`. |
| `test.lua(code)` | Drop down to the LuaRules synced state for anything the verbs don't cover. |

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
browser_test({ method: "saveScreenshot", args: ["combat-step-1.png"] })
```

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

## When to prefer this over alternatives

- **Over the debug console**: scripted reproducible test cases beat hand-typed verbs.
- **Over `exec_lua`**: the new verbs are shorter, validate parameters, and emit consistent "spawned N unit(s): ID,ID,ID" output that's easy to parse.
- **Over clicking through the lobby**: `launch_game` + `window.test` skips the auth/room dance entirely.

Browser automation: when you need to drive `window.test`, use `mcp__chrome-devtools__evaluate_script` only. **Never** use `mcp__claude-in-chrome__*` (loses page context).
