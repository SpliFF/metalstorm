# pres-verify — browser verification pass

Screenshots and defects for every presentation/UI lane, captured against a live
stack (`spring-lobby` :8011, vite :8012). Three fires: the first did the
2026-09-10 sweep's queue item 9 (screenshot plans for world-map/world-screen/
hud-drilldown/war-surfaces); the second was the first pair of eyes on pres-fx,
pres-atmos, pres-ui-ds, pres-audio and pres-decals after they landed on `main`
(at the time, pres-decals/pres-ui-ds were still gated, unmerged); the third
(this one) is the pres-decals/pres-ui-ds follow-up now that both have landed.

## Lane land status (checked via `tasks_status` after capturing)

`pres-decals` is now **`[4/4] idle, done`** — fully landed on `main`. `pres-ui-ds`
is **`[4/5] idle, done`** — steps 0-3 landed (art direction/tokens/steel-plate
base; the lobby/world/briefing/game-over token pass + the `var(--nui-bg)`
invalid-CSS fix, commit `b97d08cc62`, landed 2026-09-17 05:32; and the UI3
mentor-card styling, landed via `69af5299dc`); a 5th step (UI4, "closing the
rgba/hsla colour-register gap") is queued but hasn't run yet (parallel-lane
slot contention with this lane and `rename-war`). `pres-fx`, `pres-atmos`,
`pres-audio`, `pres-anim` remain fully landed (`idle`/`done`).

**Clone-staleness note**: this pres-verify worktree's `main` fork point was
104 commits behind the true `main` tip at the start of this fire (it predates
`b97d08cc62`). The live stack this fire tested against runs from
`TASKHERD_REPO` (`/Users/shannon/WarriorHut/Projects/springrts-web`), which
*is* current — all screenshots and live-server findings below are accurate.
Only this clone's own checked-out source tree was stale; a plain `grep` in
this worktree can give a wrong answer about what's actually live — always
cross-check against `TASKHERD_REPO` or a live `exec_lua`/`client_eval` query
before trusting a static grep in this clone.

## Defect table

| Lane | Screenshot | Defect | Severity |
|---|---|---|---|
| pres-fx | `pres-fx/f001-frame825.jpg` .. `f007-frame855.jpg` (weapon-showcase SAM-vs-fighter sequence) | `gfx.nativeFx` client setting does not exist anywhere in `client-settings.ts` or `game-processor.ts` (grepped clean) — only an internal `globalThis.__nativeFx` bench-count hook exists. PLAN-beta.md's own acceptance criterion ("`gfx.nativeFx=false` must restore the old path") cannot be tested because there is no toggle at all; the old combat-fx/projectile-renderer fallback path may be unreachable in production. | RESOLVED on main — `gfx.nativeFx` exists in client-settings.ts (default true, Low preset false) and gates the FX block in game-processor.ts; the grep ran in a stale clone (2026-09-17 orchestrator) |
| pres-audio | n/a (log/grep evidence, no screenshot) | `AudioManager.setReverbPreset()` (`client/src/core/audio.ts:610`) is never called from anywhere in `client/src` — grepped every non-test file. Its own doc-comment at `audio.ts:216` claims "Map-load wiring calls `setReverbPreset(name)`…" but no such call site exists in `game-processor.ts`/`map-lighting.ts`/`connection.ts`. Reverb preset genuinely never fires on map load. | RESOLVED on main — main.ts handles the worker `gp:soundPreset` message and calls setReverbPreset; the grep ran in a stale clone (2026-09-17 orchestrator) |
| pres-atmos / hud-drilldown | `hud-drilldown/00-rest.png`, `pres-atmos/01-low-angle-crossing-standoff.png` | `crossing_standoff` (map `scorched_crossing_v2.4`) renders a large, hard-edged **black wedge** across a big fraction of the screen — a straight diagonal cutoff, not a natural shadow. Reproduced in two independent captures (different fires, different camera angles). Not reproduced on `meridian_basin` (see `03-meridian-basin-medium.png` / `02-meridian-basin-high.png`, both clean). Looks like a CSM/shadow-frustum or fog-density edge case specific to this map's geometry/lighting — needs the pres-atmos or lighting owner, not a quick fix. | HIGH |
| pres-atmos | `pres-atmos/00-fitmap-crossing-standoff.png` | `window.test.cameraFitMap()` is broken: renders a single flat solid-colour frame (a dark-blue map-silhouette shape with UI bleeding through) instead of an actual top-down view. Reproduced independently this fire against `meridian_basin` (identical solid-fill symptom) before switching to `capture_subject({area})` as the workaround. Blocks any screenshot automation that relies on it. | MEDIUM |
| pres-audio | n/a (code read, `gamedata/sounds.lua:16-26`) | `_far` distance-swap dispatch (silence-to-quiet-far-clip past 900 elmos) is not wired — **already self-documented as an open TOOLING GAP by pres-audio's own handoff comment**, naming the exact fix location (`client/src/core/sound-events.ts`, a file pres-audio doesn't own). Re-confirmed still true on `main`; not a new finding, just verified honest. | MEDIUM (known) |
| pres-ui-ds | `world-map/02-intro-role.png` | Intro slide 3/3 ("Your Role") shows a flat empty dark rectangle where the role/faction image goes — PLAN-beta.md says this should be a gradient placeholder until L-IMAGEGEN delivers real art; it reads as a broken/missing image, not a placeholder. | LOW |
| pres-fx | `bench/weapon-fx` un-tested this fire | The exact scenario the orchestrator named, `?scenario=weapon-fx`, is a single shooter-vs-target pair (not a mixed roster). Used `?scenario=weapon-showcase` instead — it tours mechs/tanks/artillery/SAM/aircraft/bombers in one run, which is what "mixed roster" actually needs. No orange-cube fallback seen in any archetype; muzzle/impact effects render as soft glow shapes (native FX pass confirmed live via console: `[gp] native FX pass up`). "Dust before fire" not rigorously confirmed frame-by-frame. | INFO (substitution, not a defect) |
| pres-atmos | n/a | `dune_reach` / `frost_reach` (named in the old brief) do not exist among shipped maps. Used `meridian_basin` (per this fire's explicit instruction) plus the already-committed `crossing_standoff` shots from the prior fire as the second map. | INFO |
| pres-decals | `pres-decals/00-figure8-top-no-trail.jpg`, `01-figure8-low-no-trail.jpg` (top + low, figure-8 on `green_flat_x34_v3`) | **No shipped unit def sets `leaveTracks`/`trackType`** — `grep -rn "leaveTracks\|trackType" data/games/metalstorm/` returns nothing, and a live `exec_lua` sweep of all 118 loaded `UnitDefs` (`ms_tanks_s2` included: `leaveTracks=false, trackType=nil`) confirms it at runtime too. `decal-overlay.ts`'s `addTrack`/`TRACK_WHEEL`/`TRACK_TREAD` pattern-shader work (tasks 1-4: ribbon trails, float RTT, pattern shader) is fully implemented and unit-tested per the lane's own notes, but the server-side event that would ever call it is never emitted for any unit in the actual game — the whole feature is dead in production. Reproduced by driving `ms_tanks_s2` (unit 17312, spawned on team 1 to dodge the co-commander AI re-routing team-0 units mid-order — see TOOLING GAP) through a full figure-8 via 8 queued `give_order` MOVE waypoints (~3000 elmos, 7 legs); top-down and low-angle `capture_subject` shots taken both mid-route and after the tank finished the whole loop show **zero tread/ribbon marks anywhere** along the path. | HIGH |
| pres-ui-ds | `pres-ui-ds/03-intro-role.png` vs `world-map/02-intro-role.png` | **FIXED, confirmed this fire.** The intro slide 3/3 ("Your Role") placeholder that previously rendered as a flat empty dark rectangle (LOW defect above, from step 0) now renders the intended gold-to-dark gradient with a "YOUR ROLE" label chip, matching PLAN-beta.md's spec. Landed in `b97d08cc62` ("ui: stencilled-steel-plate applied to lobby/world/briefing/game-over (L-UI-DS 4-6)", 2026-09-17). | INFO (fixed) |
| pres-ui-ds | `pres-ui-ds/00-welcome.png`, `04-hub.png`, `05-hud-rest.png` vs `world-map/00-welcome.png`, `03-hub.png`, `hud-drilldown/00-rest.png` | No visible regression from the `var(--nui-bg)` invalid-CSS fix (commit `b97d08cc62`, which split every `background: var(--nui-bg)` into separate `background-color`/`background-image` declarations in `native-ui.css` and `command-console.css`). Login card, hub cards, and every in-game HUD panel (authority pill, AI chip, objective bar, MENTOR/GUIDE panels, minimap) still paint the same opaque steel plate before and after — expected for a value-preserving refactor, and now visually confirmed rather than resting on the grep-only "mechanical proof" the UI2 land-review fire had to settle for (no live-server mutex that fire). Branding copy differs between the two screenshot sets (`SPRING RTS WEB` → `METALSTORM`) — that's the unrelated `rename-war` lane, not pres-ui-ds. | INFO (no regression) |

## Not done this fire (stated plainly)

- **pres-fx XL900 perf number** (`profile` render p95 ≤ 8.5 ms on Medium): NOT reproduced. `manifests/xl900_fill.json` only boots `meridian_basin` with a bare 2-player/1-AI roster — the actual 900-unit population from PLAN-perf.md's M19 tranche table has no committed spawn script anywhere in the repo (grepped for `perRow`, `xl900`, `grid-helper` — nothing). Reconstructing it by hand means ~12 `spawn_unit` calls building ~10,600 members, which is exactly the kind of memory/GPU load this machine crashed under earlier this session (see RESUME NOTE). Skipped as a resource-risk call, not an oversight. `browser_test.perfDump()` **does** exist and works (verified) — a future fire with headroom should use it against a real XL900 population.
- **pres-atmos water Fresnel/foam close-up**: inconclusive. Every visible water body on `meridian_basin` from an admin/spectator camera sat under fog-of-war "never explored" shading (a crosshatch dither + blue desaturation, present identically at Medium and High, so it's FOW rendering, not a quality-preset artifact) — couldn't get a clean, LOS-lit shot of water in the time available. `water-surface.ts`'s own log line (`water plane: procedural scroll-bump + Fresnel + shore foam`) confirms it's wired, just not visually confirmed here.
- **hud-drilldown screenshot plan items 2-5** (ledger open, enemy-force chip, squad drill actions, Battle▾ tab focus): only item 1 (rest state) has a shot. Plan lives at `docs/reviews/2026-09-10/hud-drilldown.md` §Screenshot plan.
- **pres-ui-ds UI4** ("closing the rgba/hsla colour-register gap"): not landed yet — `tasks_status` shows it queued behind this lane and `rename-war` for a parallel-lane slot (max 2 running). Nothing to verify until it lands; re-run this check then.

## Fixed this fire (≤10 lines, already committed)

From an earlier fire (kept for the record):
- `client/src/lobby/world-map.ts`: collapsed a bidirectional world-graph edge seeded as one row per direction (was doubling every POI's transit list and the map's drawn lines). Test added in `world-map.test.ts`.
- `client/src/lobby/world-screen.css`: `.world-tab` buttons get `appearance:none` + a `:focus-visible` ring (native button chrome leaking through, no keyboard focus cue).

This fire: **none.** The pres-decals finding (missing `leaveTracks`/`trackType` gamedata) needs per-unit content authoring across ~118 unit defs — a design decision about which track-type name/width each vehicle gets, not a mechanical fix, and well outside a ≤10-line patch. The pres-ui-ds `var(--nui-bg)` fix was already landed upstream (`b97d08cc62`) before this fire started; nothing left to fix there.

## check_unit_defs.py (main, this fire)

`0 FAIL, 41 WARN` — no failures. Warnings are the pre-existing categories (footprint-vs-model-extent, member-clearance interpenetration risk, one uncarried weapon def, 30 unreferenced shipped models, and 22 ASSETS.md duplicate-line notes for already-covered `_far`/close pairs). Nothing new; not re-litigated here.

## Screenshots

- `world-map/00`–`10` — welcome → login → intro (3 slides) → hub → world open → POI click → a real bug found (doubled edges) and its fix verified.
- `world-screen/00`–`03` — ledger tabs, a keyboard-focus bug found (`.world-tab` native chrome) and its fix verified.
- `hud-drilldown/00`–`01` — rest-state HUD (authority bar, objectives, mentor card, canvas). Plan items 2-5 not done (see above).
- `war-surfaces/00` — smoke-check only; per `docs/reviews/2026-09-10/war-surfaces.md` the DOM/CSS work for this lane was never started, so there was nothing new to screenshot.
- `pres-atmos/00`–`01` — `crossing_standoff`, from the prior fire; `01` is the black-wedge defect above. `02`–`03` — `meridian_basin` High/Medium, this fire: sky dome + desaturated-horizon fog confirmed clean on both presets.
- `pres-fx/f000`–`f007` — `weapon-showcase` SAM-vs-fighter engagement, 8-frame sequence: native FX visible (soft glow muzzle/impact), no orange-cube fallback.
- `pres-decals/00`–`01` — `ms_tanks_s2` after driving a full figure-8 (7 legs, ~1700-3000 elmos depending on run) on `green_flat_x34_v3`: top-down over the whole path and a low-angle close-up at the final position, both showing no tread/ribbon marks anywhere (see defect table).
- `pres-ui-ds/00`–`05` — welcome → sign-up → intro (3 slides, incl. the now-fixed "Your Role" gradient) → hub → in-game HUD rest state, re-shot at 1440×900 against the landed UI2 (`b97d08cc62`) + UI3 (`69af5299dc`) steps. Diffed against `world-map/00`/`02`/`03` and `hud-drilldown/00` (see defect table): no regression, one confirmed fix.

## TOOLING GAP

- `window.test.cameraFitMap()` renders a broken solid-colour frame (see defect table). Workaround used: `capture_subject`/`capture_sequence` with an explicit `area`.
- No committed script reproduces PLAN-perf.md's XL900 (900-unit) population — `browser_test.perfDump()` is the right tool once one exists, but nothing builds the roster today.
- **No dedicated figure-8/waypoint-loop routine exists** for driving a unit through a scripted path — this fire hand-built one from 7-8 individual `give_order` MOVE calls (opts 0 then 32 to queue). Two gotchas worth recording for whoever builds the real tool: (1) a unit ordered *immediately* after `spawn_unit` can silently drop its first order (queue comes back empty, unit never moves) — a short poll/retry after spawn before the first order fixes it; (2) on `scenario_smoke_test` specifically, team 0 has a `strategos` co-commander AI that will re-route team-0 units toward its own objectives mid-figure-8 — spawn the test unit on team 1 (`Null AI`, does nothing) instead to keep exclusive manual control. Also note: unit defs flagged as squad defs (`ms_tanks_s2` is one, via `entityRenderer.squadDefIds`) render as a small platoon of cosmetic member meshes, not a single hull — expected behaviour, not a duplicate-render bug, but worth knowing before mis-reading a screenshot.

---

# pres-atmos — AT2 follow-up: the "black wedge" on scorched_crossing_v2.4

Follow-up to pres-verify's beta review (`docs/reviews/beta/README.md` in the
`pres-verify` worktree), defect row:

> pres-atmos / hud-drilldown — `hud-drilldown/00-rest.png`,
> `pres-atmos/01-low-angle-crossing-standoff.png` — `crossing_standoff` (map
> `scorched_crossing_v2.4`) renders a large, hard-edged black wedge across a
> big fraction of the screen — a straight diagonal cutoff, not a natural
> shadow. Not reproduced on `meridian_basin`. HIGH.

## Method

Live-repro'd `crossing_standoff` via `launch_scenario` + `open_client`
against this machine's one running stack (`spring-lobby`:8011, `vite`:8012,
started from `TASKHERD_REPO`), then drove the connected admin browser with
`client_eval`/`client_screenshot` over the P7 relay. (The project's
`spring-debug` MCP server failed to connect for this worktree — its
`tools/debug-mcp/node_modules` had never been installed here, unlike the main
checkout. Ran `npm install` under `tools/debug-mcp/` in this clone only, then
drove the same JSON-RPC protocol directly over the server's stdio instead of
through the harness's MCP client. No zombie game-server was found on the
9100–10099 range at any point — the two idle `debug-mcp/server.js` processes
seen on the box belong to other concurrent sessions and were left alone.)

Reproduced the wedge on the first shot, pixel-identical to the review's
screenshots (`00-baseline-wedge.png`).

## Hypothesis 1: fog of war / visibility — ruled out

Per-project pattern (black terrain repeatedly turning out to be FOW/LOS, not
lighting) says check this first:

- `set_los(enable: true)` — global LOS on for every ally team (server-side
  `los on`). **No change** (`01-fow-zero-los-on-wedge-unchanged.png`, taken
  with LOS on).
- `__fowDarkening.set({unscouted:0, explored:0, radar:0})` — client-side FOW
  terrain-darkening overlay (`terrain.ts` `TerrainFog`) fully disabled, its
  alpha forced to 0 everywhere. **No change**, same screenshot.
- Sampled raw pixels inside the wedge: literal `(0,0,0)`, not the FOW
  overlay's `~72%`-capped `unscouted` darken (which by design — see
  `terrain.ts`'s `DEFAULT_FOG_DARKENING` doc comment, "pure black hides the
  map shape and reads as a rendering bug" — can never reach full black; it
  maxes out well short of it).

Conclusion: not FOW, not a LOS mask. Both server-side LOS and the client-side
FOW overlay were fully neutralized and the wedge didn't move a pixel.

## Bisected renderer toggles

- **CSM shadow frustum**: `__csm.getLight().shadowEnabled = false` (sun
  light's shadow casting off entirely). **No change**
  (`02-csm-shadow-off-wedge-unchanged.png`).
- **Atmosphere fog** (`atmosphere.ts`): queried live `scene.fogColor` —
  `[0.26, 0.33, 0.61]` (blue), `fogDensity` ≈ 0.00027 (a gentle EXP2 haze,
  ~50% transmittance at ~3100 elmos). Not black, not remotely hard-edged.
  Disabled (`scene.fogEnabled = false`) for all further shots anyway. No
  effect on the wedge.
- **Terrain streaming tiles**: `__terrainPages.stats()` → `null` — the page-
  streaming system is an opt-in dev feature and isn't active for a normal
  session at all. Not in play.
- **SSAO**: not active at the default preset used to repro (`__ssao` is
  `undefined` in the worker — only built on the `high` preset).

## Root cause, part 1 (confirmed, fixed): `TerrainSplatPlugin` diffuse-alpha term

`scorched_crossing_v2.4`'s `mapinfo.lua` declares
`splatDetailNormalDiffuseAlpha = 1`, which the client's `TerrainSplatPlugin`
(`client/src/core/terrain-splat-plugin.ts`, `splatNormal` mode) honours
faithfully to Recoil's `GetSplatDetailTextureNormal`:

```glsl
vec4 _snN = sum_i (texture(splatNormalTex_i, uv_i) * 2.0 - 1.0) * cofac_i;
#ifdef TERRAIN_SPLAT_NORMAL_DIFFUSE_ALPHA
    baseColor.rgb += vec3(clamp(_snN.a, -1.0, 1.0));   // was unbounded ±1.0
#endif
```

`cofac` are the map's per-channel splat-distribution weights
(`splatDistrTex`) — a low-frequency, blocky map, which is exactly why the
resulting defect is a big flat region with a hard geometric edge rather than
fine noise. Wherever one detail-normal channel's `cofac` weight saturates to
~1.0 in this corner of the map, `_snN.a` collapses to whatever that single
channel's `splat_normal_N.ktx2` alpha channel holds at that UV. If that
texture's alpha is nearly constant there (plausible — DNTS/tangent-space
detail-normal textures often don't author a meaningful alpha channel), the
`+= clamp(_snN.a, -1.0, 1.0)` term becomes a flat, maxed-out **-1** added to
every RGB channel across the whole region — crushing `baseColor` to pure
black post-lighting, with a hard edge wherever the distribution weight
crosses its threshold.

Verified live: forcing this plugin's `diffuseAlpha` flag to `false` (and,
separately, disabling the whole `TerrainSplat` plugin — same result either
way) visibly shrinks the wedge and lifts the mean frame luminance from ~65-68
to ~70-71 with no visible regression elsewhere in frame
(`03-splat-diffusealpha-off-wedge-shrunk.png`).

**Fix applied** (`client/src/core/terrain-splat-plugin.ts`, ~8 lines): bounded
the contribution to `clamp(_snN.a, -0.4, 0.4)` instead of the raw `±1.0`, so a
degenerate/near-constant detail-normal alpha channel can never crush albedo
to literal black — the same "never pure black" rule this codebase already
applies to FOW's `DEFAULT_FOG_DARKENING` and `DecalOverlayPlugin`'s `darken`
cap. This still lets the feature contribute real, Recoil-authored detail for
well-behaved alpha content; it only clips the pathological case. Test
`terrain-splat-plugin.test.ts` updated to match (`npx vitest run
src/core/terrain-splat-plugin.test.ts` — 15/15 pass).

Not verified against the live stack directly — the running stack serves
`TASKHERD_REPO`'s (main checkout's) client bundle, not this worktree's, per
this lane's constraints — but verified by the equivalent live runtime toggle
above (a strictly *stronger* version of the same fix: `diffuseAlpha=false`
zeroes the term entirely; the committed fix only bounds its magnitude) and by
reasoning about the shader change, plus the unit test.

## Root cause, part 2 (not fixed — content/pipeline, not renderer): residual wedge

Even with the diffuse-alpha term fully disabled (both via the flag and by
disabling the whole plugin) **and** with FOW, LOS, CSM shadow, and
atmosphere fog all neutralized, and `DecalOverlayPlugin` also disabled, a
smaller but still hard-edged, still-literal-`(0,0,0)`-black triangular
patch remains in the same corner of the map (compare
`03-splat-diffusealpha-off-wedge-shrunk.png` to `00-baseline-wedge.png` — the
top-left ~40% of the original wedge clears; the bottom-right chunk does not).

Every renderer-side system this fire could find and toggle is now ruled out
for this residual. It picks consistently to `terrain_0_5`/`terrain_0_6` (the
same shared `terrainTexMat` every other, correctly-lit terrain tile uses),
in the map corner around world `X≈0-1000, Z≈6000-7168` — i.e. near two map
edges at once. That, plus every asset under
`data/maps/scorched_crossing_v2.4/` that could plausibly feed this defect
(`tiles.ktx2`, `tileindex.bin`, `splat_normal_0..3.ktx2`, `heightmap.bin`,
`metalmap.bin`, `typemap.bin`, `regions.json`) having a **today's-date**
`.processed-stamp`/mtime distinct from the much older (April) hand-authored
`.png`/`.dds`/`.tga` sources they're built from, points at the map's
asset-build/KTX2-conversion step (not present in this `client/`-scoped
worktree — it runs server-side, invoked by `spring-lobby`) rather than
anything in `pres-atmos`'s renderer.

Recommend: whoever owns the map-processing pipeline compares
`splat_normal_0..3.ktx2`'s alpha channel against its `.tga` source
(`bgnoise_dnts.tga`, `rock_46_highpass_dnts.tga`, `dirt_280_highpass_dnts.tga`,
`bgnoise_dnts_deeper.tga`) for this map, and/or diffs a fresh reprocess of
`scorched_crossing_v2.4` against its April-era assets — this smells like the
same class of hazard this file's own `terrain-splat-plugin.ts` doc comment
already flags for `splatDetailTex`'s alpha on this exact map ("a constant
1.0 ... renders the whole map as a white void", endtoend D48), just on the
detail-*normal* set instead, and just short of full-black instead of full-
white.

## Screenshots

- `pres-atmos-at2/00-baseline-wedge.png` — unmodified repro, matches
  pres-verify's original screenshots.
- `pres-atmos-at2/01-fow-zero-los-on-wedge-unchanged.png` — global LOS on +
  FOW darkening zeroed; wedge unchanged (rules out FOW/LOS).
- `pres-atmos-at2/02-csm-shadow-off-wedge-unchanged.png` — sun shadow casting
  off; wedge unchanged (rules out CSM).
- `pres-atmos-at2/03-splat-diffusealpha-off-wedge-shrunk.png` —
  `TerrainSplatPlugin` diffuse-alpha term disabled; wedge visibly shrinks
  (confirms the fixed contributor + isolates the residual).
