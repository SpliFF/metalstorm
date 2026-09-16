# spring-debug reference — looking at things: `capture_subject`, filming motion, camera control

Reference material split out of [SKILL.md](SKILL.md) (2026-09-10). Read the
skill first; come here when you need the exact angle presets, the filming
modes, or the hand-rolled camera recipe.

## Showing yourself something: `capture_subject`

**If the goal is "look at X", this is the one call — do not hand-roll camera
math.** `capture_subject` goes from a *subject* to an *image you can trust*, in
a single relay round trip.

```
capture_subject {"def": "ms_subs_s4", "angle": "side"}
capture_subject {"unitId": 26175}
capture_subject {"unitIds": [16366, 6227, 28378, 26175], "angle": "top", "fill": 0.9}
capture_subject {"def": "fable_tank", "spawn": {"x": 8704, "z": 15360}, "angle": "low"}
capture_subject {"area": {"x1": 6000, "z1": 1200, "x2": 7000, "z2": 2000}}
```

It exists because the assemble-it-yourself version demonstrably does not work:

- **A constant `height:` cannot frame two subjects.** Framing comes from the
  subject's **own model bounds** — measured on a real run, the same call put the
  camera 43 elmos from a 2.0 m subject and 905 from a 66.9 m one.
- **Camera-then-screenshot is two round trips, and the sim does not wait.** A
  guided playthrough on 2026-08-29 advanced **1,000+ sim frames** between the
  two, and the engagement it was aiming at was over. Resolve → frame → hold →
  capture → judge all happen browser-side inside one evaluation.
- **A black frame is not a deliverable.** Mean luminance is checked; a black
  frame re-frames up and out and retries; a frame that is still black returns
  `ok:false` with the causes named.

Four things it handles that are easy to get wrong by hand:

1. **`def` resolves against the CLIENT mirror**, not the server's `units` verb
   (which caps at 100 rows and can name units the browser cannot draw). "No live
   entity of def X reached this client" is an error, not an empty-ground shot.
2. ⚠ **A paused sim streams no fresh spawns and no fresh LOS reveals.** The
   plan is therefore always `spawn → los on → wait ~600 ms → pause → capture`,
   and it is echoed back in the `plan:` line. Pausing first is the classic
   picture-of-empty-ground bug.
3. **Restores are conditional.** A sim that was already paused stays paused;
   LOS already on stays on; they run in a `finally`, so a failed capture never
   leaves the world frozen.
4. **The metadata leads with the verdict** — `capture: OK`, or
   `capture: UNUSABLE — … do not trust the image`. It also reports
   `metresAcross` (at the 8 elmos = 1 m contract) and `model=loaded|FALLBACK`,
   so "the model loaded" is a claim you can check without squinting at pixels.

Angle presets are **world**-relative, named for a unit at heading 0, which faces
−Z: `three-quarter` (default), `front` (yaw −90°), `rear`, `side` (yaw 0°),
`top` (pitch 85°), `low` (loose near-horizon — the shot for judging a model
against the terrain it stands on). Override with `yawDeg` / `pitchDeg` / `fill`.
Turn off the world-freezing with `pause:false`, the LOS reveal with
`reveal:false`.

Worked examples with committed images (both standing on-screen debts this tool
was built to close) live in
[`tools/debug-mcp/shots/README.md`](../../../tools/debug-mcp/shots/README.md);
the full contract is in
[docs/debugging-tools.md](../../../docs/debugging-tools.md#looking-at-something-capture_subject).

Reach past it only for: `client_screenshot` (raw shutter, camera left where it
is), `browser_test` + `test.orbit` (keep the rig and step around a model), or
chrome-devtools `take_screenshot` (DOM/HUD only — it cannot see the WebGL2
canvas).

## Filming motion: `step_sim`, `capture_sequence`, `order_and_film`

`capture_subject` gets you a **pose**. Anything that only exists *while moving*
— a turn arc, a turret slew, a walk cycle mid-stride, a tracer in flight beside
a hull — needs a **sequence**, and the three obvious ways to get one all fail:
speed 1 advances the sim an unknown amount between relay calls, a hard pause
deletes the thing you are looking at, and slow motion alone narrows the window
without closing it.

```
capture_sequence {"unitId": 15976, "frames": 18, "everyNthSimFrame": 12, "angle": "top"}
order_and_film   {"unitId": 15976, "move": {"x": 6525, "z": 2527}, "frames": 18}
step_sim         {"frames": 30}          # exactly one game-second, then stop again
capture_subject  {"unitId": 15976, "simSpeed": 0.1}   # slow-mo instead of a freeze
```

**Two modes, and the difference is what the frames are worth.**

- **`step` (default) — spacing is EXACT.** The sim is stopped and advanced by
  `everyNthSimFrame` frames between shots (`sim_step`, a server verb added for
  this; `rts/Server/SimStep.h`). Because the world only moves when you say so,
  the seconds each capture costs buy *no* sim time: 18 shots came back
  `deltas 12, 12, 12, …` with no exception, over 15 s of wall clock. Use this
  whenever the frames are evidence. No wall-clock ceiling.
- **`realtime` — spacing is NOMINAL.** The sim is slowed (`simSpeed`, default
  0.1) and the whole burst runs browser-side inside ONE relay evaluation, so
  the interval is wall-clock-accurate. ⚠ **Hard ceiling ~6.5 s**: the
  worker→main relay abandons an evaluation that has not answered in 8 s
  (`game-processor.ts` ~1237) and the reply — every frame with it — is lost. A
  burst that would overrun is **refused before the shoot**, with the arithmetic
  shown. Anything longer belongs in `step` mode.

Things worth knowing before you reach for these:

1. ⚠ **The client's authored-clip clock is WALL-CLOCK, not sim-linked.**
   Measured 2026-08-30 on `fable_mech`'s 1.2 s `walk` loop: 56.3 key-frames per
   wall-second at 1×, **55.6 at 0.1×** — ratio 0.99, while the unit's travel
   ratio was 0.09. So `simSpeed` slows the *world*, not the *legs*. **Pace a
   clip sequence off the clip's own timebase**, not off sim frames. (Beware
   long samples: a 1.2 s loop aliases badly — measure over ~150 ms.)
2. **`gameFrame` is not the frame you are looking at.** It comes from GameInfo,
   broadcast once a game-second, so it quantises to 30 and would report six
   genuinely different shots as one instant. The sequence tools report the
   server frame the step landed on, and separately the client's freshest
   entity-snapshot frame.
3. **A stopped sim needs the presentation cursor told to catch up.** With
   `framesPerMs` at 0 the phase-locked loop has no rate to close a 12-frame gap
   with, so a shot after a step photographs the *previous* pose — silently.
   `capture_subject` sets `syncPresentation` whenever it paused the sim itself;
   `test.presentationSnap()` is the manual hook.
4. **The verdict is "did anything MOVE", not "is it dark".** N well-exposed,
   well-framed shots of the same instant is a still life wearing a film's
   clothes; it comes back `sequence: UNUSABLE` with the causes named. A sim
   that stepped correctly while the client received nothing is caught too —
   spacing and picture-change are judged on different clocks.
5. **Frames go to disk** (`data/captures/<name>/` by default, `outDir` to
   place them), because the relay's 4 MB cap is per message. `inlineFrames`
   returns the first few inline for a glance.
6. **`order_and_film` waits for motion ONSET, and rotation counts.** A tank
   executing a 180° course change barely translates; heading is the only
   channel that shows the turn, so either `speedThreshold` (elmos/game-second,
   default 2) or `turnThreshold` (deg/game-second, default 5) trips it. A unit
   that never moves is filmed anyway and labelled — a still hull IS the finding
   when the order was supposed to move it.

Committed sequences: `tools/debug-mcp/shots/m1-tank-180-turn/` (an `ms_tanks_s2`
through a 192° course reversal, exact 12-frame spacing) and
`tools/debug-mcp/shots/mech-walk-slowmo/` (one `fable_mech` walk loop at 0.25×,
mid-stride). See
[`tools/debug-mcp/shots/README.md`](../../../tools/debug-mcp/shots/README.md).

## Camera control

The camera lives **only in the browser** (the `RTSCamera` instance, `client/src/core/rts-camera.ts`). There are no camera MCP tools — drive it through the relay (`browser_test` / `client_eval({target:'test'})`) or a chrome-devtools `evaluate_script`. `window.test.*` is **the** surface — there is no `window.camera`; it was documented for years but never installed. Read the live pose with `window.test.cameraPose()` → `{pos:{x,y,z}, lookAt:{x,y,z}}`. Camera calls settle before they resolve, so a screenshot straight after one is safe; for framing that must not drift use `test.withStableCamera(fn)` (locks input, re-checks the pose afterwards and reports drift) or `test.lockInput(true)`.

### Coordinate system (read this first)
World positions are **positive** in `[0, mapX] × [0, mapZ]` (Option A — handedness is a *direction/basis* convention, not positional; see `PLAN-coordinate-system-option-a.md`). The camera shares the server's world coordinates — **no flip**. So a value from `Spring.GetUnitPosition(id)` feeds straight into the camera. `heading = 0` faces −Z; the map grows in +X/+Z.

### Canonical methods (all on `window.test`)
- **World point:** `cameraSnapToGround(x, z, {height, pitchDeg, durationMs})` — look-at lands on `(x, groundY, z)` with explicit framing. **Preferred** for precise, deterministic control.
- `focusOn(x, z, durationMs)` — pans to world `(x, z)` but **keeps the current camera→look-at offset/distance**, so a far/zoomed-out camera stays far. Takes **two** world coords.
- **A unit:** `cameraSnapToUnit(unitId, …)` / `focus(unitId)` — but see the viewport caveat below.
- **A group:** `cameraFitUnits([id,…], {pitchDeg, padding, durationMs})` — frames the bounding box. The player-facing tracking camera (`setTrackingCamera(true)`, `T` key) re-fits the live **selection** every tick via the same path.

### Pitfalls (all hit in practice)
1. `focusOn(x, z)` takes **two world coords**. `focusOn(unitId)` is a bug — the id is read as `x`, `z` is `undefined`, and the camera flies off-map. To target a unit use `cameraSnapToUnit(id)` / `focus(id)`.
2. **Never** set `scene.activeCamera.position` / `.setTarget(...)` directly. `RTSCamera` keeps its own `lookAt`; bypassing it desyncs that state, and the *next* animated `focusOn` computes `offset = camera.position − lookAt` from the stale value and hurls the camera thousands of elmos off-map (e.g. `x = −13197`). Always go through `window.test`.
3. Animated moves (`durationMs > 0`) preserve the current offset/distance. For a tight, deterministic frame use `cameraSnapToGround` / `cameraSnapToUnit` with explicit `height` + `pitchDeg` and `durationMs: 0`.
4. The game camera controller does **not** fight a programmatic pose **unless tracking is on** (`window.test.setTrackingCamera(false)` to be sure) — tracking re-fits the selection every tick and will override your pose.

### Unit/group targeting is viewport-bound — use server positions
`cameraSnapToUnit` / `cameraFitUnits` / `focus(unitId)` resolve positions via the client's `getEntityPosition` — an **internal** renderer method (interpolated, viewport-streamed state), **not** a Spring API. The server **viewport-filters unit state**: it streams only units near the registered viewport. (Projectiles are *broadcast* to every client, so FX appear even where units don't.) So an off-screen unit — or a `spawn_unit`-spawned test unit the viewport never covered — has no client position, and these methods fail with `no client-side position for unit N`.

Reliable recipe — get the authoritative position from the server, then point the camera:
```js
const r = await window.test.lua('local x,y,z=Spring.GetUnitPosition(ID) return x..","..z');
const [x, z] = r.split(',').map(Number);
await window.test.cameraSnapToGround(x, z, { height: 700, pitchDeg: 60, durationMs: 0 });
```
From the MCP side the same position comes from `list_units` or `exec_lua` (scope `LuaRules`, `return Spring.GetUnitPosition(ID)`) — server-authoritative and viewport-independent.

### FX visibility
The forward FX light pool culls emissions **> 7000 elmos** from the camera. (Since the ×8 world-scale adoption, 8 elmos = 1 m, so 7000 elmos ≈ 875 m — camera `height` numbers from pre-scale notes are ~8× off in metres.) To see projectile / weapon-FX lights (and faithful deferred projectile lights), the camera must be near the action — frame the combat first, then observe.
