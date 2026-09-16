# spring-test reference — the browser-side `window.test` harness

Split out of [SKILL.md](SKILL.md) (2026-09-10). Source of truth:
`client/src/core/test-harness.ts`; shapes in
[docs/javascript.md](../../../docs/javascript.md#windowtest--test-harness).

## Browser-side `window.test` (TestHarness)

Exposed after `startGame()` finishes. Removed by `quitToLobby()`. Full shapes: [docs/javascript.md](../../../docs/javascript.md#windowtest--test-harness).

| Method | Purpose |
|--------|---------|
| `test.captureFrame({format?, quality?, maxDim?, region?, stats?, render?})` | **Deterministic capture** — the worker renders and reads pixels in ONE task, so it can never return a between-frames black frame. Returns `{dataUrl, width, height, frameId, gameFrame, stats?}`; `stats:true` adds worker-side `{min,max,mean}` luminance. The canonical screenshot. |
| `test.captureSubject({unitId\|unitIds\|def\|position\|area, angle?, fill?, …})` | The browser half of `capture_subject`: resolve the subject → frame it from its own bounds through the orbit rig → dwell → hold the render loop → capture → judge the luminance → retry up and out if black → restore. Returns the capture plus `{subject:{sphere, metresAcross, hasModel}, framing, attempts, warnings, diagnosis, ok}`. Server-side work (spawn, sim pause, `set_los`) is NOT its job — from the browser those deadlock the game server's single HTTP thread; the MCP tool does them around this call. |
| `test.captureSequence({subject, frames?, everyNthSimFrame?, simSpeed?, …})` | The browser half of `capture_sequence`'s **realtime** mode: one burst of N framed shots paced by the wall clock, all inside a single relay evaluation, re-framing on the subject between shots. Self-limits to ~6.5 s (the relay abandons a `test` evaluation at 8 s and the whole reply is lost). Step mode does NOT go through here — stepping the sim from the browser would deadlock the game server's single HTTP thread. |
| `test.presentationSnap()` | Put the presentation cursor on the newest entity-snapshot frame this client holds. Needed after a `sim_step`: a paused clock has no rate for the PLL to close the gap with, so a shot would photograph the *previous* pose, silently. Capture-time escape hatch only — in a running game the display delay IS the jitter buffer. |
| `test.entitiesByDef(defName)` | Live entity ids for a def name, newest first, as the **client mirror** knows them. `[]` means this client cannot show you that def — a different (and more useful) statement than the server's unit list. |
| `test.readyState()` | One round-trip, **zero HTTP** readiness: `{worker:{alive,sceneStateAgeMs}, connection:{authenticated,authFailed,receivedState}, frame:{gameFrame,anchored,newestBaseFrame}, render:{frameId,meshCount,terrainMeshCount}}`. Never throws. Use this instead of polling room state. |
| `test.lockInput(on)` / `test.cameraSettle()` / `test.withStableCamera(fn, {toleranceElmos?})` | Camera input lock (drops held keys — a CDP keydown never gets its keyup), transition-settle await, and a run-with-drift-report wrapper that always unlocks. Wrap every A/B and perf window in `withStableCamera`. |
| `test.perfCapture(windowMs?, {squad?})` | Reset → wait a REAL window → dump. Closes the reset-then-dump-immediately trap. |
| `test.census()`, `test.factoryQueue()`, `test.pendingBuilds()`, `test.buildChips()`, `test.snapshotStats()`, `test.directives()`, `test.overlayOrders(id)`, `test.markerCount()`, `test.orderAckStats(reset?)`, `test.selectUnits(ids)` | Worker state queries (bindings for cases the worker always had). |
| `test.serverJson(verb, ...args)` | Any converted `server` verb in **structured** form: `serverJson('state')`, `serverJson('units', 0)`, `serverJson('unit_state', 42)`, `serverJson('spawn', def, x, z, team, count)`, `serverJson('cheats','status')`. Returns a parsed object; throws on an unconverted verb or a game server predating the `json ` prefix. |
| `test.spawn(def, x, z, team?, count?)` | Same as `spawn_unit` MCP tool. |
| `test.kill(id, selfDestruct?, reclaimed?)`, `test.damage(id, amount, paralyze?)` | Same as MCP. |
| `test.order(id, cmdId, params?, opts?)` | Issue a single command (via `/api/exec`, bypassing the client). |
| `test.clientOrder(ids, cmdId, params?, opts?)` | Order down the **real client path** (optimistic overlay + wire encode). |
| `test.clear(team?)` | Wipe all units (or one team). |
| `test.log(subsystem, on)` / `test.setLogging({...})` / `test.logStatus()` | Debug-flag toggles. |
| `test.state()` / `test.frame()` / `test.units(team?)` / `test.unitState(id)` / `test.combatSummary()` | Read-only sim queries (free-text; prefer `serverJson`). |
| `test.simPause()` / `test.simResume()` / `test.simSpeed(n)` | Server-side time control. |
| `test.focus(id, {durationMs?, height?})` / `test.focusOn(x, z, durationMs?)` / `test.setCameraHeight(h)` | Camera animation (see the spring-debug skill's Camera control section for the snap/fit family and the pitfalls). |
| `test.pause()` / `test.resume()` / `test.paused` | Freeze / resume the render loop (sim keeps running). |
| `test.screenshot()` | Legacy: canvas → `image/png` data URL, read whenever the message is processed (can catch a between-render moment). Prefer `captureFrame`. |
| `test.saveScreenshot(name?)` | Triggers a browser download of the canvas as PNG. |
| `test.highResScreenshot(w, h)` | Off-screen RTT render at that exact resolution (it honours its args now — it used to void them). |
| `test.clientFrame()` | Synchronous latest sim frame from the ~10 Hz feed (-1 before it starts). |
| `test.widgets()` / `test.setWidget(name, on)` | LuaUI widget list / toggle. `[]` until the Lua runtime boots. URL param `?disableWidgets=a,b` does it at startup. |
| `test.select([ids])` / `test.selection` | Replace / read the current selection. |
| `test.spawnAndFocus(def, x, z, team?, opts?)` | Spawn one unit and animate the camera onto it. Returns the new unit ID. |
| `test.stageCombat(atkDef, tgtDef, x, z, atkTeam?, tgtTeam?, sep?)` | Spawn an attacker + target, issue an attack order. Returns `{attackerId, targetId}`. |
| `test.lua(code)` | Drop down to the LuaRules synced state for anything the verbs don't cover. |
| `test.perfDump()`, `test.uiProfileStart/Dump/Stop()`, `test.netSim*()`, `test.netStats()` | Performance profiling — see below. |

## Performance Profiling

Three permanent, independent profiling tools also live on `window.test` — drive them via `browser_test` or `client_eval({target:'test'})`. Full reference (output shapes, methodology, budgets, pitfalls): **[docs/debugging-performance.md](../../../docs/debugging-performance.md)**.

| Method | Purpose |
|--------|---------|
| `test.perfDump(windowMs?)` / `test.perfReset()` | Always-on per-phase (camera/entity/fx/decals/render/ui/total) frame-time distribution (mean/p50/p95/p99/max) from the permanent FrameProfiler. `perfCapture(windowMs)` wraps reset → real wait → dump. |
| `test.uiProfileStart()` / `test.uiProfileDump(topN?)` / `test.uiProfileStop()` | Per-widget LuaUI (Fengari) cost breakdown — which widget/callin is expensive inside the `ui` phase. **Off by default**; brackets a measurement session. Call `uiProfileDump` before `uiProfileStop`, not after — stop clears the data first. |
| `test.netSim({delayMs, jitterMs, lossProb})` / `test.netSimOff()` / `test.netSimPreset("lan"\|"wan"\|"intercont")` | Inject artificial latency/jitter/loss on the state channel — reproduce WAN conditions on localhost. |
| `test.netStats()` | Cumulative inbound/outbound bandwidth tally, per decoded message type. |

```
browser_test({ method: "perfDump" })
browser_test({ method: "uiProfileStart" })
browser_test({ method: "uiProfileDump", args: [20] })
browser_test({ method: "uiProfileStop" })
```
