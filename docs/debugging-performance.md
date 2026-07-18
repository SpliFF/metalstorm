# Performance Testing & Profiling

Part of the [Debugging & Logging Guide](debugging.md) family. This page covers the permanent, client-side performance-measurement tools: the per-phase **FrameProfiler**, the per-widget **LuaUI cost profiler**, the **entity-FX compatibility fence**, and the **network simulator**. All four live on `window.test` (see [debugging-console.md](debugging-console.md) for the harness generally, [`.claude/skills/spring-test`](../.claude/skills/spring-test/SKILL.md) for the paired MCP tools) and are permanent instrumentation — cheap enough to leave running, not scaffolding to rip out after a session.

## Table of Contents

- [Overview: which tool for which question](#overview-which-tool-for-which-question)
- [FrameProfiler — per-phase frame time](#frameprofiler--per-phase-frame-time)
- [LuaUI widget profiler — per-widget Fengari cost](#luaui-widget-profiler--per-widget-fengari-cost)
- [Entity-FX compatibility fence — per-def legacy script cost](#entity-fx-compatibility-fence--per-def-legacy-script-cost)
- [Network simulator — WAN conditions on localhost](#network-simulator--wan-conditions-on-localhost)
- [Driving these from Claude (MCP)](#driving-these-from-claude-mcp)
- [Recipes](#recipes)
- [Methodology notes](#methodology-notes)

---

## Overview: which tool for which question

| Question | Tool |
|---|---|
| "Is the frame budget being blown, and in which phase (camera/entity/fx/decals/render/ui)?" | `perfDump()` — [FrameProfiler](#frameprofiler--per-phase-frame-time) |
| "Which specific widget/callin inside the `ui` phase is expensive?" | `uiProfileStart()`/`uiProfileDump()` — [LuaUI widget profiler](#luaui-widget-profiler--per-widget-fengari-cost) |
| "Which unit def's legacy per-frame FX script is costing the most, and is the LOD/budget fence actually catching it?" | `entityFxFenceDump()` — [Entity-FX compatibility fence](#entity-fx-compatibility-fence--per-def-legacy-script-cost) |
| "Does this latency-mitigation feature still look right at 200ms ping + loss?" | `netSim()`/`netSimPreset()` — [Network simulator](#network-simulator--wan-conditions-on-localhost) |
| "How much bandwidth is this scenario using, per message type?" | `netStats()` — [Network simulator](#network-simulator--wan-conditions-on-localhost) |

All four are independent — profiling the UI pass doesn't touch net-sim state and vice versa. Run them together freely.

---

## FrameProfiler — per-phase frame time

**Source:** `client/src/core/frame-profiler.ts` (class `FrameProfiler`), owned by the game-processor worker as `gpFrameProfiler`. **Always on** — a fixed-size ring buffer (8192 frames, ~zero per-frame allocation) accumulates every frame's phase timings for as long as the game runs; `dump()` is a read, not a start/stop toggle.

### Phases

Marked once per `requestAnimationFrame` callback, in this order:

| Phase | What it covers |
|---|---|
| `camera` | Camera pose sync + input |
| `entity` | Entity/unit renderer update (thin-instance matrix writes, interpolation) |
| `fx` | Combat FX, particles, projectile rendering |
| `decals+lights` | Decal overlay + FxLightPool |
| `render` | `scene.render()` — the Babylon draw call |
| `ui` | The LuaUI pass (`gpRunUiPass` — see the [widget profiler](#luaui-widget-profiler--per-widget-fengari-cost) to break this one down further) |
| `total` | The whole rAF callback, including the small post-`ui` scene-state/minimap posts |

### Usage

```js
// mcp__chrome-devtools__evaluate_script
const r = await window.test.perfDump();       // default 30s window
console.log(r.table);
```

```
frames=1742 fps=58.1 window=30.0s
phase           mean    p50    p95    p99    max
camera           0.12   0.10   0.30   0.45   1.20
entity           0.31   0.28   0.55   0.80   2.10
fx               0.28   0.25   0.60   0.90   3.40
decals+lights    0.05   0.04   0.10   0.15   0.50
render          14.20  13.80  18.50  22.00  35.00
ui              53.10  52.00  62.00  75.00 110.00
total           68.40  67.00  82.00  98.00 145.00
```

`perfDump(windowMs?)` returns the structured object (not just the table):

```ts
{
  windowMs: number;   // actual window covered (≤ requested)
  frames: number;
  fps: number;
  phases: Record<'camera'|'entity'|'fx'|'decals+lights'|'render'|'ui'|'total',
                  { mean: number; p50: number; p95: number; p99: number; max: number }>;
  table: string;      // the pre-formatted text above
}
```

`perfReset()` clears the ring buffer — call it right before a measurement window you want isolated from whatever ran before (map load, a previous scenario, idle time waiting for a screenshot).

### Budget reference

PLAN-perf's standing target (release builds, `renderScale 1.5`, this project's dev machine): **`total` p95 ≤ 16.7 ms** (60fps). As of the last full pass the `ui` phase alone dominates the frame at ~2-3× that budget on its own — see [debugging-performance.md's methodology notes](#methodology-notes) and the internal `PLAN-perf.md` for the current attribution and fix history. Any change that regresses a budget scenario by >10% should say so explicitly wherever the change is described (commit message, PR, hand-off).

---

## LuaUI widget profiler — per-widget Fengari cost

**Source:** `client/src/core/widget-profiler.ts` (Lua-side timing wrapper) + `gpRunUiPass`'s fixed-tax accumulator in `game-processor.ts` (JS-side). **Off by default** — each wrapped callin costs ~2 Lua↔JS clock crossings (negligible against the ms-scale costs measured, but not free), so it's installed only for a measurement session: `uiProfileStart()` → `uiProfileDump()` (repeatable) → `uiProfileStop()`.

This breaks down the `ui` phase from the FrameProfiler above into: the fixed JS-side GL-state tax around the pass, and — while the Lua-side wrapper is installed — a per-widget-per-callin cost ranking.

### Usage

```js
// mcp__chrome-devtools__evaluate_script
await window.test.uiProfileStart();
// ... let the game run for the window you want measured ...
const r = await window.test.uiProfileDump();   // safe to call repeatedly; profiler keeps running
console.log(r.table);
await window.test.uiProfileStop();             // uninstalls the Lua wrappers when you're done
```

```
LuaUI pass split — 843 JS frames, 840 profiled Lua frames
  gpRunUiPass total   53.10 ms/frame
    GL-state save     0.00  (P5: getParameter round-trips)
    Fengari runFrame  51.90  (N-track)
    GL-state restore  0.00
    wipeCaches(true)  0.01  (P5)
    rmlFlush          0.03
  runFrame blocks (ms/frame):
    chunkExec      51.20
    chunkOverhead  0.70
    update         0.40
    gameFrame      0.10
    drawScreen     49.80
  widget-attributed 48.10 ms/frame; handler/other 3.10 ms/frame
  top widget callins (ms/frame over 840 frames):
      42.300  Chili Framework  [DrawScreen]  (840 calls)
       2.100  gui_top_bar  [DrawScreen]  (840 calls)
       ...
```

`uiProfileDump(topN?)` (default `topN=40`) returns:

```ts
{
  tax: { frames, save, lua, restore, wipe, rml, total };  // ms/frame means, always populated
  blocks: Record<string, number> | null;                  // per-block ms/frame — null if the Lua-side wrapper never observed a frame (see pitfall below)
  widgets: Array<{ widget, callin, msPerFrame, ms, calls }> | null;  // sorted descending, same null condition
  attribution: { widgetMsPerFrame, chunkExecMsPerFrame, unattributedMsPerFrame } | null;
  table: string;
}
```

- **`tax`** is always populated (JS-side, independent of the Lua wrapper) — it's the fixed cost of `gpRunUiPass` itself: saving/restoring GL state around the pass, the `wipeCaches(true)` call, and the batched RML DOM-op flush. See `docs/debugging-performance.md`'s [methodology notes](#methodology-notes) for why `save`/`restore` read ~0.00 today.
- **`blocks`/`widgets`/`attribution`** need the Lua-side wrapper to have actually seen at least one `runFrame` execution while installed — see the pitfall immediately below if these come back `null`.

### Pitfall: call order matters

**`uiProfileDump()` must run *before* `uiProfileStop()`, not after.** `uiProfileStop()` clears the Lua-side `__wprof` table entirely; if you stop first, the next dump only has the always-on JS `tax` numbers and `blocks`/`widgets`/`attribution` come back `null` — this looks like "the profiler isn't capturing per-widget data" but is actually just querying after the data was already thrown away. The profiler is safe to leave running across multiple `uiProfileDump()` calls (it doesn't reset between dumps), so the normal flow is: **start once, dump as many times as you want, stop once at the end.**

If `blocks`/`widgets`/`attribution` are `null` even with the correct order, check that widgets are actually loaded and drawing (`gadgetHandler`/`widgetHandler.widgets` non-empty — see [debugging-console.md](debugging-console.md#lua-debug-api) or `evaluate_widget_lua`) — the wrapper only accumulates while the `runFrame` chunk in `lua-ui-host.ts` actually executes.

---

## Entity-FX compatibility fence — per-def legacy script cost

**Source:** `client/src/core/entity-fx-fence.ts` (PLAN-fx-offload X5). **Always on** — unlike the LuaUI profiler above, this isn't a start/stop measurement session; `EntityFxFence.beginFrame()` runs every frame from `game-processor.ts`'s render loop, so `entityFxFenceDump()` is safe to call any time.

PLAN-fx-offload's declarative bindings (`core/fx-bindings.ts`, X4) replace per-frame entity `onUpdate` scripts with data. A def that still ships an actual per-frame script FX callback goes through this fence instead of running unbounded: LOD-gated (full <500 elmos from camera, half-rate 500–2000, none ≥2000 — the same tiers PLAN-client-entity.md's design specifies), budget-capped (a shared per-frame ms budget across all legacy calls — PLAN-scripting.md's combined Lua+JS 3-5ms/frame budget), and console-warned once per def.

### Usage

```js
// mcp__chrome-devtools__evaluate_script
const r = await window.test.entityFxFenceDump();
console.log(r);
// { frames: 1204, perDef: [ { def, ms, calls, avgMs, skippedLod, skippedBudget }, ... ] }  — ranked most-expensive-first

await window.test.entityFxFenceReset();   // clear stats before a fresh measurement window
```

**As of this writing `perDef` is always `[]`.** No shipped game currently routes a per-def script through `EntityFxFence.run()` — the fence is wired into the live render loop (so `frames` is real) ahead of having a caller, because PLAN-fx-offload sequences the fence (X5) before the JS animation system (task 3) that's expected to become that caller. An empty dump here means "nothing has called `run()` yet," not "the fence is broken."

---

## Network simulator — WAN conditions on localhost

**Source:** `Connection.setNetSim()` (`client/src/core/connection.ts`) + `client/src/core/net-inspector.ts`'s bandwidth tally. Built for PLAN-latency's L0 validation ("does the latency mitigation still look right at 200ms ± jitter, 2% loss?") but generally useful any time you need to reproduce WAN conditions without an actual WAN. Applies to the unreliable state channel only (entity state, etc.) — reliable/control traffic is unaffected.

### Usage

```js
// mcp__chrome-devtools__evaluate_script

// Named presets (recommended — matches the project's standard test conditions):
await window.test.netSimPreset('wan');         // 80ms ± 15ms jitter, 0.5% loss
await window.test.netSimPreset('intercont');   // 200ms ± 40ms jitter, 2% loss — the L0 exit-gate condition
await window.test.netSimPreset('lan');         // 5ms ± 2ms — ~localhost baseline

// Or a custom profile:
await window.test.netSim({ delayMs: 150, jitterMs: 30, lossProb: 0.01 });

// Disable when done:
await window.test.netSimOff();
```

Watch the client's timing overlay (**F10** → presentation-clock block) while net-sim is active to see the presentation cursor `P = E − D` react.

### Bandwidth tally

```js
const stats = await window.test.netStats();
```

Cumulative since the game started (or since `resetNetStats()` internally — there's no `window.test` reset call yet; restart the game to zero it):

```ts
{
  inbound:  Record<envelopeName, { count: number; bytes: number }>;
  outbound: Record<envelopeName, { count: number; bytes: number }>;
  inboundTotalBytes: number;
  outboundTotalBytes: number;
}
```

`envelopeName` is the decoded message type (e.g. `EntityState`, `ProjectileState`, or a FlatBuffers payload name like `AuthResponse`) — the same decoding the [Network Inspector](debugging-console.md#network-inspector) uses for its live log.

---

## Driving these from Claude (MCP)

There is no dedicated `spring-debug` MCP tool for these — they're plain `window.test` methods, so drive them the same way as every other TestHarness call: **`browser_test`** generates the `evaluate_script` snippet.

```
browser_test({ method: "perfDump" })
browser_test({ method: "uiProfileStart" })
browser_test({ method: "uiProfileDump", args: [40] })
browser_test({ method: "uiProfileStop" })
browser_test({ method: "entityFxFenceDump" })
browser_test({ method: "netSimPreset", args: ["wan"] })
browser_test({ method: "netStats" })
```

Feed the printed snippet into `mcp__chrome-devtools__evaluate_script`. Requires a connected browser tab with a game in progress (`window.test` only exists after `startGame()` — see [debugging-console.md](debugging-console.md) and the `spring-test`/`game-browser-test` skills for getting a session up).

---

## Recipes

### Baseline a scenario, then measure a change

```js
await window.test.perfReset();
// ... drive the scenario for the window you care about ...
const before = await window.test.perfDump();
console.log(before.table);
// ... apply the change, reload/rejoin ...
await window.test.perfReset();
// ... drive the same scenario again ...
const after = await window.test.perfDump();
console.log(after.table);
```

### Find the top N slow widgets

```js
await window.test.uiProfileStart();
// let it run 10-30s of representative gameplay
const r = await window.test.uiProfileDump(10);   // top 10
console.log(r.table);
await window.test.uiProfileStop();
```

### Confirm a latency mitigation under simulated WAN

```js
await window.test.netSimPreset('intercont');
// drive the feature under test, take screenshots / observe behaviour
await window.test.netSimOff();
```

### Check GL-state-tax specifically (the fixed cost around the LuaUI pass)

```js
await window.test.uiProfileStart();
const r = await window.test.uiProfileDump();
console.log(r.tax);   // { frames, save, lua, restore, wipe, rml, total }
await window.test.uiProfileStop();
```

---

## Methodology notes

- **Release builds only for numbers that matter.** Dev builds (unminified, no Vite prod bundling) run measurably slower and skew every phase — especially `ui` (Fengari-heavy). Any number destined for a decision or a written record should come from a release client + release server. See the internal `PLAN-performance.md` (profiling methodology handbook — scenario ladder, tooling checklist; gitignored working memory, present only in this checkout) for the full protocol.
- **`ui`-phase save/restore reading ~0.00ms is expected, not broken.** As of the last GL-state-tax pass, Babylon's own `engine.wipeCaches(true)` (called at the end of every LuaUI pass) already resets the JS-side caches backing 9 of the 10 raw GL values the pass used to save/restore by hand via `gl.getParameter` — so that save/restore work was removed. If you see this regress back to ~0.5ms, something reintroduced a `gl.getParameter` round-trip in `gpRunUiPass` (`client/src/core/game-processor.ts`).
- **The dominant `ui`-phase cost today is Fengari `runFrame` itself** (Chili Framework `DrawScreen`), not the fixed JS-side tax — GL-call-volume batching (text-glyph batching + a per-pass GL-state shadow) was the fix that actually moved this number; see the internal `PLAN-perf.md` N-track for the running record if you have this checkout.
- **These tools are independent of the FrameProfiler's `ui` phase measurement mechanism** — `perfDump()` always works (it's a permanent accumulator), while the widget profiler needs an explicit start/stop bracket. Don't conflate "FrameProfiler says `ui` is slow" with "the widget profiler shows nothing" — the second one just wasn't running yet.
