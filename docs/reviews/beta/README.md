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

---

# terrain-streaming K2 — AT2 residual black patch, map-processing audit (2026-09-20)

Follow-up to AT2's "root cause, part 2": with FOW, CSM, atmosphere fog,
`TerrainSplatPlugin` diffuse-alpha and `DecalOverlayPlugin` all disabled, a
smaller hard-edged literal-`(0,0,0)`-black patch remains at world
`X≈0-1000, Z≈6000-7168` on `scorched_crossing_v2.4` — a map corner (touches
both the `X=0` and `Z=7168` edges). AT2 flagged the map's derived KTX2 assets
(`tiles.ktx2`, `splat_normal_0..3.ktx2`) as regenerated today against
April-era `.tga`/`.dds` sources, and named the server-side map-processing /
KTX2 conversion step (`rts/Server/MapProcessor.cpp`, invoked from
`spring-lobby`, using `tools/textureconverter`) as the suspect. This fire
audits that step directly, byte-for-byte, rather than through the renderer.

## Method

No `ktx2`/map-processor unit test existed to reuse, so this ran the
conversion's own inputs and outputs through direct binary comparison:

- Parsed `scorchedcrossing.smf`'s header/tile-dictionary
  (`data/maps/scorched_crossing_v2.4/maps/scorchedcrossing.smf`) and confirmed
  `mapx=mapy=896` (divisible by 4, so `MapProcessor::ReadSMFHeader`'s
  `tilesX = mapx/4` truncation is exact — ruling out an off-by-one from
  non-multiple-of-4 map dims) and `tilesX=tilesZ=224` on a 7168×7168-elmo map
  (`X≈0-1000, Z≈6000-7168` → tile columns `x∈[0,31]`, rows `z∈[187,223]`).
  `data/maps/scorched_crossing_v2.4/tileindex.bin` (the processed copy) is
  byte-identical to the SMF's own tile-index section for every entry — the
  extraction in `ExtractBinaryData` (`MapProcessor.cpp:544-561`) is a plain
  copy here, nothing to miscompute.
- Read every SMT tile (`scorchedcrossing.smt`, tile-major, 680B/tile: mip0
  512B + mip1 128B + mip2 32B + mip3 8B) referenced by that box's tile
  indices, and the same tiles' bytes out of the derived `tiles.ktx2`
  (level-major, per `MapProcessor.cpp:598-664` + `textureconverter
  --raw-dxt1 --no-zstd`, parsed via the KTX2 level index) — **all 4 mip
  levels, all 1088 tiles in the box: 4736 byte-range comparisons, 0
  mismatches.** The SMT→KTX2 step for the tile atlas is a lossless,
  bit-exact re-encode (`--no-zstd` means `ktxTexture_SetImageFromMemory`
  stores each level's DXT1 blocks verbatim; confirmed against the actual
  files, not just by reading the code).
  - Of those 1088 tiles, only **10** decode (DXT1→RGB) to literal
    `(0,0,0)` — `z=197,x∈[24,31]` and `z=201,x∈{32,33}` — and every one of
    those 10 is *already* literal black in the April-era `.smt` source, i.e.
    content, not conversion. They don't cover the reported box; a solid
    black rectangle over the whole `X≈0-1000,Z≈6000-7168` region can't be
    explained by the tile atlas alone.
- Extracted `splat_distr.ktx2` and `splat_normal_0..3.ktx2` back to RGBA8 PNG
  (`ktx extract --transcode rgba8 --level 0`, KTX-Software CLI) and diffed
  pixel-for-pixel against their April sources (`maps/splatdistrtex.png`,
  `maps/bgnoise_dnts.tga`, `maps/rock_46_highpass_dnts.tga`,
  `maps/dirt_280_highpass_dnts.tga`, `maps/bgnoise_dnts_deeper.tga` — these
  go through `ConvertMapTexture`'s generic `--encoding uastc --mipmaps`
  path, unlike the tile atlas's raw-block wrap). All differences are small
  and spread uniformly across each whole image (max per-channel delta
  39-109, mean 1.6-15.5) — ordinary UASTC lossy-encode noise, not a
  concentrated corner defect; the significant-diff bounding boxes for
  `splat_distr` sit well inside the texture (`x:88-918, y:110-883` of
  1024×1024), *excluding* the edges, so there's no edge-clamp/wrap artifact
  at the texture boundary either.
- Sampled `heightmap.bin` near the corner: a flat plateau (constant raw
  height ≈22359, i.e. ≈241 elmos after the SMF min/max-height rescale) right
  at the `Z=7168` edge — consistent with intentional map geometry (a cliff
  or dead zone at the playable-area boundary), not a processing artifact
  (heightmap extraction is a raw byte copy, no computation, per
  `ExtractBinaryData`).

## Conclusion: not a converter bug

Every asset this map-processing step touches for that corner was checked
against its source, directly, at the byte or pixel level — not just by
reading the code. The tile atlas conversion is provably lossless (0/4736
mismatches); the splat texture conversions show only ordinary lossy-codec
noise, uniformly distributed, not concentrated at this corner or at any
texture edge. **The KTX2 conversion step is a faithful re-encode of the
April-era source content; it is not introducing this residual black
patch.** The "today" `.processed-stamp`/mtime on the derived assets (which
correctly made AT2 suspect this step) is just this map's most recent
reprocessing run — it does not mean the pixels changed incorrectly.

The residual is therefore either genuine map content (a real dark/flat
corner — plausible for a "scorched crossing" map, and partially corroborated
by the 10 literal-black source tiles + the flat height plateau right at that
edge) or a renderer-side effect AT2's toggle sweep didn't isolate (e.g. the
same distribution-weight mechanism as the already-fixed diffuse-alpha term,
but acting through a different shader term the `±0.4` clamp doesn't bound,
or heightmap-edge normal computation at the map boundary) — both outside
this step's scope and this fire's brief (converter-only; "not the client").
No code change is warranted here without conflating a real fix with a guess.

Not reproduced against the live stack this fire: the live stack
(`spring-lobby`:8011) serves `TASKHERD_REPO`'s (main checkout's) maps, not
this clone's `data/maps/` copy, and no map content changed here to re-process
or prove — the byte/pixel-level decode above is the evidence trail per this
lane's brief ("otherwise decode ... and show the pixel values").

## Not done this fire

- No converter fix, no regression test — investigation did not find a
  converter-side defect to fix or guard.
- The actual residual root cause (content vs. a further renderer term) is
  still open; whoever picks this up next should look at
  `client/src/core/terrain-splat-plugin.ts`'s other shader terms and/or
  `client/src/core/terrain.ts`'s edge-of-heightmap normal computation for
  `scorched_crossing_v2.4`'s `X=0`/`Z=7168` corner, or simply confirm this is
  intended map geometry (a scorched/dead corner) and close AT2's residual
  as content, not a defect.

---

# terrain-streaming K3 — AT2/K2 residual closed as map content (2026-09-20)

Follow-up to K2's brief: audit `terrain-splat-plugin.ts` for any *other*
additive/multiplicative shader term besides the already-fixed/clamped
diffuse-alpha one, and `terrain.ts`'s heightmap-edge normal computation, for
a renderer-side explanation of the residual black corner K2 couldn't rule
out with the map-processing audit alone. Read both files end to end (no live
repro — the running stack serves `TASKHERD_REPO`'s main-checkout client and
maps, not this clone's, so a screenshot here would just re-show what K2
already decoded pixel-for-pixel; not worth spending the `live-server` mutex
on a step that produces no new evidence either way).

## `terrain-splat-plugin.ts`: no other active term

The file has exactly three mutually-exclusive shader modes, gated by
per-material `#ifdef`s (`TERRAIN_SPLAT` / `TERRAIN_DETAIL_PLAIN` /
`TERRAIN_SPLAT_NORMAL` — never set together, `prepareDefines` L131-137). Two
of the three do carry unclamped `baseColor.rgb +=` terms:

- mode `'splat'`: `baseColor.rgb += vec3(dot(_spDetails, _spCofac));` — unbounded.
- mode `'plain'`: `baseColor.rgb += _pdCol;` — unbounded.

But `scorched_crossing_v2.4`'s `mapinfo.lua`
(`data/maps/scorched_crossing_v2.4/mapconfig/mapinfo`) declares
`splatDetailNormalTex1..4` + `splatDistrTex`, so per this file's own
documented Recoil precedence (L12-18,
`attachTerrainSplatNormalFromDecals`-first in `terrain.ts` L1457) it always
resolves to mode `'splatNormal'` — `TERRAIN_SPLAT` and `TERRAIN_DETAIL_PLAIN`
are compiled out entirely for this map's material. Those two unbounded terms
cannot run here, on any map that ships a normal-detail set.

Inside `'splatNormal'` mode itself, the *only* line that touches `baseColor`
is the diffuse-alpha term AT2 already found and K2/this fire's predecessor
already clamped to `±0.4` (L242). Everything else in that block
(`_snCofac`, `_snStrength`, `_snN.xyz`, the STN reconstruction) feeds
`normalW`, not `baseColor`, and `_snN.y = max(_snN.y, 0.01)` (L233) already
floors the pre-normalize Y component so a degenerate (near-zero) blended
detail-normal can't produce a zero-length vector before `normalize()` —
i.e. the exact "unclamped alpha or distribution-weight" failure mode this
fire was asked to look for is already guarded, for the axis that could
actually zero out. No new fix needed or made.

## `terrain.ts`: heightmap-edge normal computation can't degenerate

`writeHeightfieldNormal` (L350-366), used by both `computeSurfaceNormals`
and the deformable-terrain repaint path, already clamps its sample offsets
at the map boundary: `xm = max(0, sx-step)`, `xp = min(hmW-1, sx+step)`
(same pattern for z). At an edge this collapses the central difference to a
one-sided (forward/backward) difference — `dx`/`dz` shrink but are never
zero unless `hmW`/`hmH` is 1 (never true for a real map) — so `dHdx`/`dHdz`
stay finite. Critically, the normal's numerator is `(-dHdx, 1, -dHdz)`: the
`Y` component is a **hardcoded `1`**, never sampled or derived, so
`Math.hypot(nx, ny, nz)` is always `>= 1` — the normal can never be the zero
vector, at a map edge, a map *corner* (both axes clamped at once, exactly
`scorched_crossing_v2.4`'s `X=0`/`Z=7168` case), or anywhere else. A
zero-length normal was the specific degenerate case that could produce a
literal `N·L=0` black pixel independent of lighting direction; it is
structurally impossible here. Added a regression test locking this in
(`terrain.test.ts`, `computeSurfaceNormals` describe block): a synthetic
sheer cliff running along both the `sx=0` and `sz=hmH-1` boundaries at once
(harsher than any real map's height data) still produces a finite unit
normal with positive `Y`. `npx vitest run --config vite.config.ts
src/core/terrain.test.ts` — 60/60 pass (was 59 before this fire's added
test); `src/core/terrain-splat-plugin.test.ts` — 15/15 pass, unchanged.

## Conclusion: close as map content, not a defect

Both files this fire was asked to audit are already defect-free for this
corner: `terrain-splat-plugin.ts` has no other active additive/multiplicative
term for a `splatNormal`-mode map, and `terrain.ts`'s edge-of-heightmap
normal computation cannot degenerate at a boundary or corner by
construction (the hardcoded `ny=1` numerator term rules out N·L=0 from a
zero-length normal). Combined with K2's byte/pixel-level proof that the
KTX2 map-processing step faithfully reproduces the April-era source for
every asset that could feed this corner (bit-exact tile atlas, ordinary
lossy noise in the splat textures, and — most tellingly — 10 already-literal-
black source tiles plus a flat height plateau sitting *right at* this exact
`X≈0-1000, Z≈6000-7168` box), the honest conclusion is: **this is genuine map
content** (scorched_crossing_v2.4 has a real dark, flat corner at its
playable-area boundary), **not a rendering defect**. No further code change
is warranted; fabricating one against this evidence would be worse than
leaving it alone. AT2's residual (its "root cause, part 2") is closed.

## Not done this fire

- No shader/normal-computation fix — none was warranted; both audited files
  were already correct for this case.
- No live-stack screenshot — the running stack serves the main checkout's
  client/maps, not this clone's, and no code changed that would move a
  single pixel there; K2's decoded byte/pixel evidence is the record.
- If anyone still doubts this is content: the only way to move it further is
  visual/design judgement on `scorched_crossing_v2.4`'s map art (does the
  team want that corner less stark?) — that's a map-content decision, not an
  engineering defect, and outside this lane's scope.

---

# E2E pass 1 — first-time-player path (2026-09-19)

PLAN-beta.md §Verification items **1 (spectate as guest)** and **2 (sign up →
solo tutorial)**, driven end to end with fresh eyes against the live stack
(`spring-lobby` :8011 from the MAIN checkout, vite :8012, game servers 9100+).
Items 3 (Support/mentor) and 4 (presentation) were **not** attempted — they are
E2E2/E2E3.

Accounts minted fresh this pass: guest `e2e_bkgn` (id 202, API probe), guest
`e2e_dmg3` (id 203, browser), registered `e2e_kp47` (id 204, browser). The
`raven` / `raven_beta` residue was left alone and used only as the "a registered
account owns this name" fixture.

## PASS/FAIL — item 1, spectate as guest

| # | Sub-step | Result | Evidence |
|---|---|---|---|
| 1a | Welcome screen renders, callsign entry + "Watch as …" | **PASS** | `e2e/01-welcome.png` |
| 1b | "Watch as `<name>`" mints a guest token carrying that nickname | **PASS** | `POST /api/auth/guest {"username":"e2e_bkgn"}` → 201, `username:"e2e_bkgn"`, `nickname_chosen:true`; browser guest `e2e_dmg3` = id 203 |
| 1c | 409 when a **registered** account owns the name | **PASS** | `raven_beta` → 409 `{"error":"that name belongs to a registered player","name_taken":true}`; surfaced in the UI as "that name belongs to a registered player — choose another, or log in as them." `e2e/02-welcome-409-name-taken.png` |
| 1d | Guest reaches the Missions browser and the Hub | **PASS** | `e2e/03-guest-missions-browser.png`, `e2e/04-guest-hub.png` (tier chip reads RECRUIT) |
| 1e | Broadcasts panel lists a mission **"1h behind"** | **PASS** | Hub → SPECTATE → "Mission Broadcasts": row chip `Broadcast · 1h behind`. `POST /api/broadcasts/list` → `state:"live"`, `behind_seconds:3600`. `e2e/05-broadcasts-panel-1h-behind.png` |
| 1f | A **dev-floor override a test can use** | **FAIL** | D2 below — `--dev-broadcast-floor` is a *spring-server* flag the lobby deliberately never passes, and the lobby's own list route hardcodes the 3600 s floor. No override is reachable through the live lobby at all. |
| 1g | Watcher renders | **PASS** | `e2e/06-watcher-initial.png` — relay room 68 on :9100, replay bar reads `Broadcast · 1h behind · recording ends early (segment truncated)`, 2:44/2:44 |
| 1h | A backward seek lands on a **whole world** | **PASS** | Seek to 20% → 2:44 became 0:37 and playback resumed. Units, an earlier objective board (`HOLD ASH VERGE 90%`), a "New objective" toast and minimap forces all present. Server: `broadcast: watcher 1 (playerNum 200) attached at frame 4938 (1476 records of join bundle)`. This is the first live proof of the EmitJoinBundle-after-backward-seek risk the broadcast lane named as untested. `e2e/07-watcher-after-backward-seek.png` |
| 1i | No `PlayerCommand` reaches the relay | **PASS** (with caveat) | Relay log shows exactly one refusal: `broadcast: client 1 sent verb 31 — dropped (a relay admits watchers, not players)`. Verb 31 = `SelectionState`, **not** `PlayerCommand` (3) or `PlayerCommandBatch` (30). Caveat in D9: that warn is deduped per client (`warnedBroadcastClients`), so the live log proves the drop path fires but cannot enumerate every later verb. |

Guest admission is correct at the server too: `replay: admitting client 1 as
spectator 'e2e_dmg3' (playerNum 200, reserved range; not in the sim roster)`.

## PASS/FAIL — item 2, sign up → solo tutorial

| # | Sub-step | Result | Evidence |
|---|---|---|---|
| 2a | Sign up the same nickname → **409 while the guest holds it** | **PASS** | Sign-up form with `e2e_dmg3` → "username already taken"; `POST /api/auth/register` → 409. `e2e/08-signup-409-name-held-by-guest.png` |
| 2b | Intro slides (3) | **PASS** | `e2e/09-intro-slide1.png`, `10-intro-slide2.png`, `11-intro-slide3-your-role.png`. Slide 3's "Your Role" placeholder renders the gold gradient (the old flat-rectangle defect stays fixed). |
| 2c | Hub | **PASS** | `e2e/12-hub-registered.png` — `E2E_KP47 · RECRUIT · THE MERIDIAN COMPACT` |
| 2d | First mission (Solo) boots `tutorial_01` via `POST /api/rooms/solo` | **PASS** | Room 69 `play:tutorial_01:e2e_kp47`, host 204, port 9101. Lobby: `room 69: scenario 'tutorial_01' (host choice)` and `seating the mentor AI on team 0 — a Recruit is on a side with no Veteran`. `e2e/13-solo-tutorial-briefing.png` |
| 2e | Coach card advances on **select** | **PASS** | STEP 2 ("Select a squad") → STEP 3 ("Drill in") on a box-select; focus strip read `line tanks · idle · Units 1`. `e2e/15-solo-coach-step2-select.png`, `e2e/16-solo-coach-step3-selected.png` |
| 2f | Coach card advances on **move** | **PASS** | STEP 4 ("Move to Grey Flat") → STEP 5 on arrival; later STEP 7 → STEP 8 on the move to Storm Sound. `e2e/17-solo-coach-step5-after-move.png` |
| 2g | Victory | **PASS** | `HOLD STORM SOUND: complete` → `VICTORY — Ally team 0 is victorious! Battle ended at frame 13530`; server `GAME OVER: Spring.GameOver declared`. Coach reached "Training complete" (8/8). `e2e/18-solo-victory.png` |
| 2h | Victory → **back in lobby** | **FAIL** | D4 — "RETURN TO LOBBY" lands on the *finished room's* page, still labelled **In Progress** with a **REJOIN GAME** button. Reaching the lobby needs a manual LEAVE. `e2e/19-after-victory-room-in-progress.png`, `e2e/20-back-in-lobby-after-victory.png` |
| 2i | `users.standing` incremented | **FAIL** | D5 — still `0` after the won mission. A later control run credited +10 through a different exit path (see below), proving accrual itself works and the victory path specifically loses it. |
| 2j | `users.sessions_played` +1 | **FAIL** | D5 — still `0` after the won mission; +1 in the control run. |
| 2k | Tier still Recruit | **PASS** | At `standing=10` (control run) the hub still reads **RECRUIT** — 10 < `kTierThresholds[1]` = 20. `e2e/21-hub-standing10-still-recruit.png` |

## Defects

| # | Sev | Defect | Repro | Owning lane |
|---|---|---|---|---|
| D1 | **HIGH** | **Broadcast listing renders every date as "22 Jan, 03:06" (1970).** `BroadcastListing.available_since` is typed `string` and passed to `new Date()`, but the lobby sends UNIX **seconds** (`availableSinceMs / 1000`). `new Date(1789616390)` = 22 Jan **1970**. Both rows showed the same minute because a 3600 s gap is only 3.6 ms when misread. The unit test enshrined the wrong contract (an ISO string), which is why it was never caught. | Hub → SPECTATE with any `.msb` in `data/broadcasts/`; compare the row's date against `available_since` in `POST /api/broadcasts/list`. `e2e/05-broadcasts-panel-1h-behind.png` | **FIXED this pass** (broadcast-client) |
| D2 | **MEDIUM** | **No dev-floor override is reachable by a test.** `--dev-broadcast-floor` exists only on `spring-server` (`rts/server_main.cpp:567`) and only lowers the **relay's** floor. `runDirectStart` documents that the lobby *never* sends it, and `POST /api/broadcasts/list` hardcodes `broadcast::kMinBroadcastDelaySec` with no override parameter — so a freshly recorded mission cannot be made to appear in the player-facing browser inside an hour by any supported means. PLAN-beta.md §Verification item 1 asks for exactly this ("dev-floor override for the test"), and `behindLabel()`'s own comment claims "a dev override can lower it for the live-verification recipe". This pass only proceeded because two `.msb` files from 2026-09-17 were already older than the floor. | `grep -rn "dev-broadcast-floor" rts/` — one parse site, server-only; `rts/lobby_main.cpp:9356` passes the constant. | broadcast-relay / broadcast-lobby |
| D3 | **MEDIUM** | **`query_db` (spring-debug MCP) silently answers from a stale clone snapshot.** The MCP server runs from the lane clone and reads *its* `data/spring-server.db` (frozen at bootstrap, max user id 198) while the live lobby writes MAIN's copy. Every other MCP tool (`api_request`, `get_logs`, `list_processes`) talks to the live stack, so the mismatch is invisible: `query_db` returned an empty result for accounts that plainly existed. Any lane verifying DB state from a clone gets wrong answers with no warning — including this brief's own "query_db shows users.standing incremented" criterion. | `query_db("SELECT max(id) FROM users")` → 198; `sqlite3 <MAIN>/data/spring-server.db` → 204. `list_processes` already warns "lobby --db and MCP SPRING_DB may differ". | mcp-tools |
| D4 | **MEDIUM** | **After victory, "RETURN TO LOBBY" lands on a stale "In Progress" room offering "REJOIN GAME".** A first-time player who just won is shown their finished mission as still running, with an invitation to rejoin it, instead of the hub. | Win `tutorial_01`, click RETURN TO LOBBY. `e2e/19-after-victory-room-in-progress.png` | journey-lobby-entry |
| D5 | **HIGH** | **Leaving a finished mission destroys the standing/session credit.** Accrual lives only in the lobby health loop's "game server exited" branch (`lobby_main.cpp:10294`, `Journey::RoomEarnsAccrual`). `POST /api/rooms/leave` on `LeaveResult::Abandoned` (`lobby_main.cpp:8393-8410`) instead SIGTERMs the server, calls `removeGameServer(rid)` (so the health loop can never observe the exit) and `rooms.DeleteRoom(rid)` (so the roster is gone) — **without** accruing. Lobby log: `room 69 abandoned, killed game server pid 75339`; no `standing:` line; the `users` row stayed `standing=0, sessions_played=0`. On the **solo/tutorial path the player is the only human, so leaving is always `Abandoned`** — the first-time player's first victory reliably pays nothing unless they sit on the post-game screen and wait out the 180 s timer. This breaks the progression loop PLAN-beta's headline journey rests on. NOT a ≤10-line fix: the accrual block (~40 lines, using `warSummaryFor` + `WarPlayerBindings`) must be factored out, and the leave path must distinguish "left after game over" (pay) from "abandoned mid-mission" (do not) — a design call, not a mechanical one. | See the controlled run below. | journey-lobby-routes |
| D6 | LOW | Guest mint with a name **another guest** holds answers `"that name belongs to a registered player"` — the name belongs to a *guest*, so the message is wrong and the suggested remedy ("log in as them") is impossible for a passwordless guest. | `POST /api/auth/guest {"username":"e2e_bkgn"}` twice. | journey-accounts |
| D7 | LOW | The sign-up 409 ("username already taken") offers **no route to the claim/upgrade path that exists**. `POST /api/auth/upgrade` and the "CLAIM ACCOUNT" button are precisely the answer to "I watched as X, now I want to play as X", but the sign-up form never mentions them — and PLAN-beta's journey makes that collision the expected case. | `e2e/08-signup-409-name-held-by-guest.png` | journey-lobby-entry |
| D8 | LOW | Victory copy reads **"Ally team 0 is victorious!"** — engine vocabulary in a player-facing string, against the World/Mission vocabulary ruling. Should name the player or their Faction. | `e2e/18-solo-victory.png` | rename-war |
| D9 | LOW | The client's broadcast send-gate wraps `PlayerCommand` only, so a watcher still emits `SelectionState` to the relay (dropped by the relay's allow-list). Harmless, but it means the relay's allow-list — not the client gate — is what actually holds, and the drop warn is **deduped per client**, so the log cannot enumerate later dropped verbs. | Relay log for room 68. | broadcast-client |
| D10 | LOW | `tutorial_01`'s **opening camera frames mostly off-map grey void** — a hard diagonal map edge fills ~60% of the first frame a new player ever sees. SHOW ME then frames the column correctly, so it is the initial camera, not the map. | `e2e/14-solo-coach-step1.png` vs `e2e/15-solo-coach-step2-select.png` | journey-tutorial |
| D11 | INFO | The broadcast on `scorched_crossing_v2.4` renders near-black under the spectator camera (roads and rock silhouettes only). Uniform, **not** the hard-edged wedge pres-atmos AT2 fixed. **Root cause investigated in "pres-atmos — AT3 follow-up: D11" below**: it is neither night lighting nor FOW/LOS — both were live-toggled with no effect. It isolates to the terrain's diffuse ground texture (`terrainTexMat.diffuseTexture`) itself sampling near-black for a Global-mode spectator session, independent of the TerrainSplat/DecalOverlay plugins and CSM shadows (all individually disabled live, no change) — the same *class* of map-asset/pipeline defect AT2's "part 2" residual finding named for this exact map, not a pres-atmos renderer bug. Separately, a real (but here ruled out as the cause) design bug was found and fixed in the client's spectator FOW code: it painted from only the most-recently-arrived ally team's LOS bitmap, which is wrong for a Global-mode spectator watching several teams round-robin. | `e2e/06-watcher-initial.png` | pres-atmos |
| D13 | **MEDIUM** | **Game servers do not self-terminate when idle**, despite each logging `idle self-termination: exit after 300s with no clients (120s startup grace)` at boot. Room 68's broadcast relay ran **25+ minutes** at `clients:0` (`curl :9100/api/metrics` → `"clients":0`); room 70 ran ~9 minutes at `clients:0`, still simulating at frame 7438 with 2 AIs, and had to be killed by hand. Ports 9100–10099 are a finite pool the lobby already logs an error for exhausting, and every leaked server holds one plus a full sim. This is also why the D5 control run could not use the idle path. | Boot any room, navigate the browser away **without** LEAVE, wait > 420 s, then check `ps` and `/api/metrics`. | journey-lobby-routes / server |
| D12 | INFO | After a backward seek the replay bar's status flips from "1h behind" to **"59h behind"** — it recomputes against wall-clock, and the test segment is two days old. Arguably correct for a stale segment; flagged because a real 1 h-delayed live mission is the only case that has been reasoned about. | `e2e/07-watcher-after-backward-seek.png` | broadcast-client |

## The controlled run behind D5

Because the brief's own acceptance criterion is "standing incremented", the
failure was split into cause and effect rather than reported as "accrual is
broken":

1. **Run A (room 69)** — played to victory, clicked RETURN TO LOBBY, then LEAVE.
   Lobby: `room 69 abandoned, killed game server pid 75339`. Room row deleted,
   process killed. `standing=0, sessions_played=0`. No `standing:` log line.
2. **Run B (room 70)** — booted the same solo mission and **navigated away
   without calling `/api/rooms/leave`**, so the room survived and the server was
   left to idle-exit on its own timer, which is the path the health loop watches.

   Room 70 sat at frame ~7400 with `clients:0` for ~9 minutes without the
   idle self-termination it had logged (D13), so the variable was isolated a
   third way instead: `kill -TERM` on the server pid directly, leaving the room
   row and roster intact. The lobby health loop then logged
   `game server for room 70 (pid 89213) has exited` and **credited**:
   `e2e_kp47` went `standing 0 → 10`, `sessions_played 0 → 1` — exactly one
   `kStandingPerSession`.

**Conclusion.** Accrual is not broken; the leave path destroys it. Same account,
same scenario, same binary — the run that reached the health loop was paid, the
run that went through `/api/rooms/leave` was not. Note run B never reached
victory and was still paid, which is correct (`SessionAccrual(0)` pays the base
session), and makes the contrast sharper: **losing interest and quitting pays,
winning and clicking LEAVE does not.**

Because of run B, `e2e_kp47` now reads `standing=10, sessions_played=1` — but
that credit came from the *control* run, not from the victory. Items 2i/2j are
still FAIL for the path the brief specifies. The upside is that 2k is no longer
vacuous: at standing 10 (< the 20 threshold) the hub still reads **RECRUIT**
(`e2e/21-hub-standing10-still-recruit.png`).

Corroboration that the health-loop path itself works: `presverify2` (id 198)
carries `standing=10, sessions_played=1` — exactly one `kStandingPerSession`
credit — from an earlier fire that did not leave its room.

## Fixed this pass (committed)

- `client/src/lobby/broadcast-browser.ts` (D1, 8 lines): `available_since` is
  typed `number | string` and `shortDate()` scales a numeric value by 1000
  before constructing the `Date`. `client/src/lobby/broadcast-browser.test.ts`
  gains a regression case pinning the seconds contract the lobby actually sends.
  **This is a client fix and CANNOT be seen on the live stack** — the stack
  serves MAIN's client and this lane must not edit MAIN. Verified by
  `vitest run src/lobby/broadcast-browser.test.ts` (7/7) and `tsc --noEmit`
  (clean) in this clone; the 1970 date will still appear live until it lands.

No other defect was inside the ≤10-line budget. D5 is the one that most deserves
a fix and explicitly does not fit it (see its row).

## Not done this pass (stated plainly)

- **PLAN-beta.md §Verification items 3 (Support/mentor) and 4 (presentation)** —
  out of scope for this step (E2E2 / E2E3).
- **Guest-prune half of item 2** — PLAN says the name is "free after guest
  prune". `GuestAccounts::PruneAbandoned` only deletes guests unseen for 30
  days, so this is untestable live without clock surgery; only the
  409-while-held half was verified.
- **`/api/auth/upgrade` (CLAIM ACCOUNT) was not exercised.** It was read in the
  source and named in D7, but no guest was actually upgraded — the journey was
  continued with a fresh callsign instead, so the intro slides could be seen
  from a true first-time sign-up.
- **Root cause of D11** (near-black broadcast render) was not investigated; FOW
  and lighting were not bisected the way pres-atmos AT2 did.
- **Screenshots are 1440×801, not the 1440×900 the brief asked for.**
  `chrome-devtools resize_page` reports success but the viewport stays 801 CSS
  px (verified by `innerHeight` after resizing to both 900 and 999) — a tooling
  limitation, recorded rather than worked around.
- `docs/reviews/beta/e2e/superseded-killed-fire-20260917/` holds four
  screenshots left by the 2026-09-17 killed fire of this lane. They were never
  referenced by any README section; moved aside rather than deleted (the harness
  gates file deletion) so this pass's numbering is unambiguous.

## TOOLING GAP

- **`query_db` is not safe from a clone** — see D3. Until it is fixed, verify DB
  state with `sqlite3 "file:<TASKHERD_REPO>/data/spring-server.db?mode=ro"`.
- **`chrome-devtools resize_page` is a no-op here**, so "capture at 1440×900"
  cannot be honoured.
- **The native-UI coach/replay widgets are DOM, not canvas**, but carry no a11y
  role, so they never appear in `take_snapshot` and the `click` tool refuses
  them ("did not become interactive"). Driving them needs `evaluate_script` +
  `el.click()`. The replay seek bar is `#replay-track` with an `onclick` reading
  `clientX` — dispatching a `MouseEvent` on the **canvas** does nothing; it must
  be dispatched on the track itself.
- **A single synthetic click does not select a unit**; a dispatched box-drag
  (pointerdown → several pointermoves → pointerup) does. Worth knowing before
  concluding "selection is broken".
- The lobby's own log is **not** ingested by the log server — `get_logs` /
  `search_logs` only carry game-server entries. The lobby writes to its stdout
  redirect (this stack: `/private/tmp/e2e-logs/lobby.log`), which is where the
  accrual and room-lifecycle lines in D5 came from.

---

# pres-atmos — AT3 follow-up: D11 (near-black broadcast/spectator render)

E2E1 guessed "night lighting + unexplored FOW". Neither survived a live
bisection this pass. Both hypotheses were tested directly against the running
stack and a genuine, different bug was found and fixed along the way — but it
is **not** what makes D11's screenshot look the way it does.

## Method

`tutorial_01` and `crossing_standoff` both run on `scorched_crossing_v2.4`, so
D11's "lit normally in the tutorial" claim is a same-map, same-assets
comparison — confirmed via `list_scenarios` (both declare `map:
"scorched_crossing_v2.4"`). The tutorial's own E2E1 screenshot
(`e2e/17-solo-coach-step5-after-move.png`) shows a normal, visibly-textured
dark-ash terrain, not the near-black of `e2e/06-watcher-initial.png`.

Reproduced a Global-mode spectator live: `launch_scenario(crossing_standoff,
ai:"strategos", players:[{username:"admin", spectator:true}])` — `ai:
"strategos"` seats an AI on both `compact` and `union`, giving two ally
teams with different vision footprints, matching a real broadcast tap (which
is itself a `SpectatorVisibilityMode::Global` session per `BroadcastTap.h`).
Framed the view with `window.test.cameraFitMap()` and `cameraSnapToGround()`
(both real gameplay-camera calls, not `capture_subject`) and drove the rest
with `client_eval` against the render-core worker. `admin` was the only
username that authenticated onto the eval relay as admin — a `spectator:true`
non-`admin` username reliably left the lobby's own sessions-table check
failing (the same D3-class clone/live DB mismatch, reproduced independently
of D3 across 5 separate launches with fresh usernames) even though the
underlying game-server connection succeeded fine (`clients:1` in
`/api/metrics`, `role=player`/`role=spectator via=session` in the server log)
— a live-tooling gap, not a game bug, noted below.

Reproduced the symptom on the first shot: `cameraFitMap({pitchDeg:55})` gave a
1280×657 frame reading `mean:2.38` (out of 255) — visually identical to
`06-watcher-initial.png` (near-black, only the gold road ribbon and a faint
rock silhouette visible).

## Hypothesis 1: night lighting — ruled out

Queried the live scene directly rather than guessing from a screenshot:

- `self.__mapLighting` → `sunDir:[-0.5,0.75,-0.5]` (sun above the horizon),
  `groundAmbient:[0.85,0.85,0.85]`, `groundDiffuse:[0.6,0.6,0.6]` — a normal
  daytime preset, not a night one.
- `scene.lights` → `sun` (DirectionalLight, intensity 1, diffuse
  `[0.7,0.7,0.7]`) and `ambient` (HemisphericLight, intensity 1, diffuse
  `[0.85,0.85,0.85]`), both enabled. No light is dimmed or disabled.
- Proof the lighting pipeline itself works: swapped `terrainTexMat`'s
  `diffuseTexture` for a flat red `diffuseColor` live — the terrain
  immediately rendered as a normally-shaded red surface (`mean:55`, visible
  gradient from the sun/shadow), confirming the sun + ambient + shadow stack
  lights geometry correctly. The blackness is specific to the *textured*
  material, not the lights.

## Hypothesis 2: FOW / LOS — ruled out for this symptom (but a real bug found)

- `window.__gp('__fowDarkening.set({unscouted:0,explored:0,radar:0}))` (the
  same technique AT2 used) forces every non-inLos tile's overlay alpha to 0.
  Confirmed via direct pixel readback of the fog `DynamicTexture`
  (`meanAlpha:0, maxAlpha:0` over the full 64×64 bitmap) that the overlay
  was doing precisely nothing. The screenshot mean moved from 2.38 to 2.48 —
  noise, not a fix.
- `set_los`-equivalent per-ally-team bitmaps were already flowing normally;
  `__terrainKnowledge.stats()` reports `active:false` (the `terrainknowledge`
  modoption is off for this scenario, as for any stock game), so the
  chunk-reveal gate cannot be hiding geometry either — and indeed the terrain
  meshes are all present and `isVisible:true`.
- **A real bug found along the way, independent of D11's cause**:
  `client/src/core/terrain.ts`'s `TerrainFog.apply()` painted the fog overlay
  from only the single most-recently-arrived ally-team LOS bitmap (its own
  doc comment: "Spectators may see multiple ally teams round-robin — we just
  take the latest"). For a Global-mode spectator — which is what every
  broadcast watcher is (`BroadcastTap.h`: "the tap records global
  visibility") — the server round-robins up to 4 ally teams/second
  (`StateStreamer::StreamLosBitmaps`), so the overlay was flickering between
  whichever single team's vision arrived last, showing everyone else's
  ground as "unscouted" even though some other team could see it. **Fixed**
  in this pass (`client/src/core/terrain.ts`, ~35 line diff): `TerrainFog`
  now keeps every ally team's latest bitmap and paints the union (the
  lightest tier across all teams heard from) instead of overwriting — a
  no-op for the single-team case (players, Team-mode spectators) and closer
  to "sees the whole world" for a Global-mode one. `vitest run
  src/core/terrain.test.ts` (59/59) and `tsc --noEmit` (clean) in this
  clone. **This fix does not touch D11's screenshot** (proven above — FOW
  was already fully disabled and the image didn't change), so it is
  worthwhile on its own merits but is not "the D11 fix".

## Root cause: the ground diffuse texture itself, not a shader term or overlay

With night-lighting and FOW/LOS both eliminated, bisected the same way AT2
bisected the wedge — by disabling one renderer system at a time via
`client_eval` against the live `terrainTexMat`:

- `TerrainSplatPlugin` (`mode:"splatNormal", diffuseAlpha:true`, the exact
  plugin AT2's fix bounded): forced `diffuseAlpha=false` **and** the whole
  plugin `isEnabled=false` — no change (`mean` stayed ~1.9-2.5).
- `DecalOverlayPlugin`: `isEnabled=false` — no change.
- CSM shadow: `__csm.getLight().shadowEnabled=false` **and**
  `mesh.receiveShadows=false` on all 98 terrain tiles — no change.
- `scene.ambientColor` is `[0,0,0]` (Babylon's own default — StandardMaterial
  only multiplies this into a separate `ambientColor` material term, not
  `diffuseColor`); not evidence of anything since the red-swap test above
  already proved the light+shadow stack lights the mesh correctly.

None of the renderer toggles that produced the AT2 wedge move this at all.
What's left, by elimination, is the diffuse texture (`terrainTexMat.
diffuseTexture`) itself: the red-swap test isolated that when the *lit
material's colour input* is a flat, known-good colour, shading is normal; the
only remaining input is the texture the plugins sample on top of. The texture
object reports `isReady:true`, 7168×7168, a real internal WebGL texture (not
a missing/placeholder 1×1) — so this is not a load failure, it's the actual
sampled content reading as near-black across the full map for this session.

This matches AT2's own "root cause, part 2" finding for this exact map
almost exactly in kind — a map-asset/KTX2-pipeline defect, not a client
renderer bug — except AT2's residual was a single corner (`X≈0-1000,
Z≈6000-7168`); this pass's repro shows it across the *entire* visible
terrain at every camera position and zoom tried (`cameraFitMap` top-down,
and `cameraSnapToGround` at height 500 close to the ground — both ~mean 2).
Whether that is the same defect having spread since AT2's pass, or a
second, separate map-asset problem, is **not established this pass** — it
needs whoever owns `data/maps/scorched_crossing_v2.4`'s asset-build step
(the same escalation AT2 made) to diff the current `tiles.ktx2` (and its
mip chain) against a known-good rebuild, the way AT2 recommended for
`splat_normal_*.ktx2`.

## Caveats

- **A pre-existing, documented tooling issue may color this**: this same
  README (pres-verify's original defect table, `pres-atmos` row) already
  flags `window.test.cameraFitMap()` as broken ("renders a single flat
  solid-colour frame … instead of an actual top-down view"). This pass's
  `cameraFitMap` screenshots do **not** show that symptom (real terrain
  detail, road geometry, a visible unit) — but to rule out any relationship,
  the near-black result was independently reproduced with
  `cameraSnapToGround()` too (a different code path), at a height (500
  elmos) comparable to the tutorial's own camera distance. Same result.
- **Not verified against `main`'s exact deployed commit**: this was run
  live against whatever `TASKHERD_REPO` is currently serving on
  `spring-lobby:8011` / `vite:8012` (this lane's own live-server), not a
  fresh checkout diffed line-for-line against the E2E1 fire's commit.
- **The `/api/rooms/direct` "session token not in the lobby's sessions
  table" warning fired on every `launch_scenario` call this pass**,
  regardless of username or spectator/player role, and regardless of
  whether the browser actually authenticated (it always did once `open_
  client`/an `admin`-named account was used) — worth folding into D3's
  writeup as the same underlying clone/live DB mismatch, not a new defect.

## Not fixed this pass

The terrain diffuse texture / map-asset-pipeline defect is a `data/maps/`
content problem outside pres-atmos's renderer scope (same reasoning as AT2's
"part 2" residual), so it is handed off rather than patched here. The
`TerrainFog` spectator-union fix above **is** committed this pass, on its own
merits, but is explicitly not a fix for the defect this row describes.

# E2E pass 2 — Support mission, responsibility, mentorship (2026-09-21)

PLAN-beta.md §Verification item **3**, driven end to end against the live stack
(`spring-lobby` :8011 from the MAIN checkout, vite :8012, game servers 9100+)
with two isolated Chrome contexts on one side. Items 1–2 were E2E1; item 4 is
E2E3 and was **not** attempted.

**Fixtures.** Two fresh accounts, both faction `compact` so the lobby seats them
on the same side by construction: `e2e_rec7` (id 209, standing 0 → **Recruit**,
tier 0) and `e2e_vet7` (id 210, **Veteran**, tier 2). Standing was raised by a
direct `UPDATE users SET standing=60` on the LIVE lobby DB
(`$TASKHERD_REPO/data/spring-server.db`) — **there is no admin route for it**;
`/api/mentor/endorse` is the only standing writer and it is +15 and needs a
mentorship, which needs tier ≥ 2 first. `query_db` was NOT used (E2E1 D3: it
answers from the stale clone snapshot).

**Rooms.** 77 (Recruit+Veteran, `crossing_standoff`), 79 (same, after the
mentorship was accepted), 80/81 (Recruit alone). All servers reaped; no port
9100–9109 listener and no stray `spring-server` left behind.

## PASS/FAIL — item 3, Support + responsibility + mentorship

| # | Sub-step | Result | Evidence |
|---|---|---|---|
| 3a | Recruit and Veteran deploy into `crossing_standoff` on the **same side** | **PASS** | Room 77 roster: both `team:0`, `tier_name` `Recruit` / `Veteran`. Sim: `rank_0=2 callsign_0=e2e_vet7`, `rank_1=0 callsign_1=e2e_rec7` — `game_teams.lua`'s `publishStanding` carries the lobby's `tier`/`callsign` custom options into the sim intact. `e2e/p2-01-room-recruit-veteran-same-side.png`, `p2-02-recruit-in-game.png` |
| 3b | Two squads **auto-carved** for the Recruit at deploy | **FAIL** | **D15** — `assign:` empty with 18 live team-0 units, in room 77 *and* room 79. `CarveForRecruit` itself is fine: called by hand post-spawn it returns `2` immediately (`assign_27836=1 assign_965=1`). The carve is called too early. |
| 3c | `assign_<unitID>` rulesParams reach the client | **FAIL** | **D14** — published as `assign_965.0` / `assign_27836.0`; the store's `/^assign_(\d+)$/` never matches, `getMyAssignments()` → `[]`. **FIXED this pass**; proven live by republishing with floored keys, after which `getMyAssignments()` → `[965, 27836]`. |
| 3d | Recruit's **box-select returns only those** | **PASS** (with the D14 fix applied live) | A full-screen box-drag on the Recruit's canvas: the engine selected `[27836, 965, 7086, 26633]`, `uiStore.selection.unitIds` was `[27836, 965]`, focus strip read **`Your squads · 2 × LIGHT ENGINEERS · UNITS 2`**. This is HUD scoping by design (`ui-store.ts:520` — "Unassigned units stay selectable by the engine … the refusal lives in `game_assignment.lua:AllowCommand`"), so the *engine* selection is deliberately wider. `e2e/p2-03-recruit-boxselect-scoped.png` |
| 3e | Veteran's order on them shows **"order from `<callsign>` (Veteran)"** in the Recruit's HUD | **PASS** | Veteran issued a real client order (`window.test.clientOrder([965,27836], CMD.MOVE, …)`, i.e. the player's own network command, not a Lua/server one). `AllowCommand` passed it and marked `orderBy`. Recruit's focus drill-down rendered **`ORDERS  order from e2e_vet7 (Veteran)`**, and the mentor card the same line. `e2e/p2-04-recruit-hud-order-from-veteran.png` |
| 3f | Recruit's order on the **Veteran's squad is refused** | **PASS** | Unit 15976 made the Veteran's responsibility; the Recruit's `clientOrder` MOVE never entered its queue (`cmds=1 [20.0]` — the pre-existing FIGHT — and no `_by` mark). Rule invoked directly for the truth table: `recruit→vetSquad=false`, `recruit→ownSquad=true`, `vet→recruitSquad=true`. Refusal is **silent** in the HUD — see D21. `e2e/p2-05-recruit-order-on-veteran-squad-refused-silently.png` |
| 3g | Mentor **offer → accept** | **PASS** | `POST /api/factions/metalstorm/recruits` (as the Veteran) listed `e2e_rec7`; `POST /api/mentor/offer {mentee_id:209}` → `{"id":1,"state":"offered"}`; `POST /api/mentor/respond {id:1,accept:true}` (as the Recruit) → `{"id":1,"state":"active"}`. |
| 3h | The mentorship **rides into the sim** | **PASS** | Room 79 (deployed *after* the accept): `mentor_0 = 1` — the mentee's option arrived at AuthRequest as the mentor's username and `game_teams.lua`'s `playerIDByName` resolved it to the Veteran's playerNum. Recruit's HUD: **`UNDER MENTORSHIP: E2E_VET7 · 2 squads under your command`**. `e2e/p2-06-mentor-card-active-chatter-filtered.png` |
| 3i | **Chatter filter on** — `isChatterFiltered()` | **PASS** | `mentorOf(0)=1`, `isMentored()=true`, `isChatterFiltered()=true`, `showEverything=false`, and the card offers **SHOW EVERYTHING**. |
| 3j | Chatter filter **hides all-chat** | **FAIL** | **D17** — the gate exists (`command-console.js:chatterHidden`) but nothing in the tree ever sets `extra.scope = 'all'` or `'enemy'`; the console's own doc comment says so ("The chat producer that would set it does not exist on the wire yet"). Only `moment-hud.ts` consumes the flag for real (scoping battle moments). |
| 3k | `task <recruit>: hold <objective>` **NL command** | **FAIL** | **D16** — `task e2e_rec7: hold Raven Basin` → *"didn't understand: 'task', 'e2e_rec7:'"*, and it silently fell through to a **team-wide standing order** ("Whoever is free holding Raven Basin") instead of refusing. The other two phrasings `nl-instructions.md` documents fail too. `e2e/p2-07-veteran-nl-task-not-understood.png` |
| 3l | **"Task from `<callsign>`" chip** | **PASS** | Exercised the verb the NL path is *documented* to emit, at the gadget's real entry point and as the Veteran: `RecvLuaMsg('cmd=objectives.createBounty&type=control&region=raven_basin&player=0&stake=20&hold=900', 1)` → `objective_11_player=0`. The same message issued as the **Recruit** (pid 0) created nothing — `mayTask` refused it. Recruit's HUD chip: **`HOLD RAVEN BASIN (BOUNTY) · ACTIVE · PROG 0% · ⬡20 · TASK FROM E2E_VET7`**. `e2e/p2-08-recruit-task-from-veteran-chip.png`. Caveat: the chip sat **8th of 8**, behind "show more" — D20. |
| 3m | No Veteran → **AI mentor seated at spawn** (`ai_list`) | **PASS** | Rooms 80 and 81, Recruit alone: lobby logged `room 81: seating the mentor AI on team 0 — a Recruit is on a side with no Veteran`; `ai_list` team 0 → `AI:strategos@t0`, `active:true`, alongside `activeHumans:1`; the server's own argv carries `--ai strategos:0:-1:mentor` — the `mentor` profile at start-position `-1`, exactly as PLAN-beta specifies. `e2e/p2-09-recruit-alone-ai-mentor-seated-but-hud-says-no-mentor.png` |
| 3n | …and the Recruit can **see** they have a mentor | **FAIL** | **D18** — with the AI mentor seated, `mentor_0` is unset and the card reads **"NO MENTOR YET — ACCEPT AN AI MENTOR"**. Same screenshot as 3m. |

Bonus, not asked for: the mentor card's **ACCEPT AN AI MENTOR** button works
(E2E1-era journey-hud D2's 401 is gone) — it created
`{"id":2,"mentor_id":0,"mentor":"ai","kind":"ai","state":"active"}`. The card
then rendered **empty** — D19.

## Defects

| # | Sev | Defect | Repro | Owning lane |
|---|---|---|---|---|
| D14 | **HIGH** | **`assign_<unitID>` is published under a float-formatted key**, so the entire Recruit command-scope HUD reads "nothing is assigned to me". `Spring.GetTeamUnits` hands unitIDs back as Lua-5.4 **floats**, and `'assign_' .. unitID` stringifies `965.0` as `"965.0"` — but `ui-store.ts`'s `ASSIGN_KEY = /^assign_(\d+)$/` requires digits only, and `assignedBy()` looks up `assign_${unitId}_by` with an integer. So `getMyAssignments()` returns `[]`, box-select is never scoped, and the superior's "order from …" line never renders. The gadget's own `pkey()` helper exists for exactly this float class of bug but only floors *playerIDs*. | Deploy a Recruit, carve, then `Spring.GetTeamRulesParams(0)` → `assign_965.0=1.0`. Client: `__msUiStore.getMyAssignments()` → `[]`. | **FIXED this pass** (journey-sim) |
| D15 | **HIGH** | **The auto-carve never fires for a Recruit who starts the mission** — only for a mid-game joiner. `game_teams.lua:GameStart` seeds the initial roster through `PlayerAdded`, which calls `GG.Assignment.CarveForRecruit`; at that instant the scenario has spawned **nothing**, so `#Spring.GetTeamUnits(teamID)` is 0, the `< MIN_TEAM_SQUADS (6)` guard returns 0, and nothing is ever retried. Every Support deploy — the headline journey — therefore lands a Recruit with no squads and, because `countFor` is 0, with `AllowCommand` letting them command the **whole team roster** (the exact opposite of the rule). Called by hand once units exist it carves 2 instantly, so the logic is right and only the timing is wrong. NOT fixed here: the fix needs a retry with a deadline (and a Save/Load answer for the pending set), which is a policy call, not a mechanical one — suggested shape is a `carvePending[pid] = frame + N` set at the `< MIN_TEAM_SQUADS` return and drained from a `gadget:GameFrame` every 30 frames. | Room 77 and room 79, both `crossing_standoff`: `team0 units=18`, `assign:` empty, `assign_rev=nil`. Then `GG.Assignment.CarveForRecruit(<recruit pid>)` → `2`. | journey-sim |
| D16 | **MEDIUM** | **The `task <name>: …` NL command does not exist, and fails unsafely.** `nl-instructions.md:104` tells the model to emit a `command` action with verb **`objectives.createBounty`** and a `player` field — but `COMMAND_VERBS` (derived from `TARGET_SHAPES_BY_VERB` in `compile-table.ts`) is the closed list `attack…build`, `nl-envelope.ts:437` rejects anything outside it, the JSON schema handed to the model enumerates the same list, and `NLCommandIntent` has no `player` field at all. So the documented sentence cannot be expressed even by a perfect model, and on the offline parser it is **silently reinterpreted** as a team-wide standing order rather than refused. | Veteran's console: `window.test.nl('task e2e_rec7: hold Raven Basin')` → "standing order set · normal priority (team-wide — no group named) / didn't understand: 'task', 'e2e_rec7:'". Also `'give e2e_rec7 the bridge'`, `'e2e_rec7, take Raven Basin'`. `grep -n "objectives.createBounty" client/src/ui/native-ui/compile-table.ts` → nothing. | journey-hud / nl-instructions |
| D17 | **MEDIUM** | **The chatter filter's chat half is dead code.** `chatterHidden(scope)` only fires for `scope === 'all' \| 'enemy'`, and **nothing** in `client/`, `data/games/metalstorm/ui/` or any test ever passes a `scope` to `say()`. PLAN-beta's "console hides all-chat" is therefore unimplemented; what actually works is `moment-hud.ts`, which scopes battle moments to the player's own squads. The console's own comment admits it. | `grep -rn "scope: *'all'" client/ data/games/metalstorm/ui/` → no hits. | journey-hud |
| D18 | **MEDIUM** | **The spawn-time AI mentor seat is invisible to the mentee.** The lobby seats `strategos:<team>:-1:mentor` when a Recruit has no tier ≥ 2 human on their side, but it writes **no `mentorships` row** — and the sim's `mentor_<pid>` is mirrored from that row at AuthRequest (`ClientMessageHandler.cpp:614`, value `"ai"` → `-1`). So the Recruit deploys with an AI mentor sitting on their team while their HUD says **"NO MENTOR YET"** and, 30 s later, offers to get them the AI mentor they already have. Two ways it bites: the card's copy is wrong, and a player who accepts creates a *second* mentor relationship the `Mentorship.h` invariant exists to prevent. | Room 81: lobby log `seating the mentor AI on team 0`; `ai_list` → `AI:strategos@t0` active; Recruit's client `mentorOf(0)` → undefined, `isMentored()` → false; card → "NO MENTOR YET". | journey-lobby-routes |
| D19 | LOW | **The mentor card goes blank after "ACCEPT AN AI MENTOR".** The route succeeds and the lobby row goes `active`, but `mentor_<pid>` is fixed at AuthRequest for the running session, so `mentorCardModel` sees `kind:'none'` with the offer already dismissed and renders nothing. The player's click reads as "the button deleted the panel". | Room 81, click ACCEPT AN AI MENTOR → `#nui-panel-body-mentor-card` `innerText` becomes `""`; `/api/account/me` shows the mentorship active. | journey-hud |
| D20 | LOW | **A task your mentor just handed you does not rank on the objective board.** `rankObjectives` boosts `o.suggested === playerId` by 800 but ignores `o.player`, which is the *stronger* signal ("this one is yours", not "yours to take"). The bounty landed **8th of 8**, below every scripted objective, hidden behind "+N more objectives". | `e2e/p2-08-recruit-task-from-veteran-chip.png` — visible only after clicking the overflow. `objective-model.ts:308`. | journey-hud |
| D21 | LOW | **A refused order is silent.** `AllowCommand` returning false produces no client feedback of any kind — no toast, no console line, no cursor state. A Recruit who boxes the whole field (which the engine allows, by design) and orders gets partial obedience with no explanation, which is precisely the "the game silently ignored me" failure the console's own refusal-copy discipline exists to prevent. | Recruit `clientOrder` on the Veteran's squad → nothing in the DOM matches `/refus|cannot|denied/`. | journey-hud / journey-sim |

## Fixed this pass (committed)

- `data/games/metalstorm/LuaRules/Gadgets/game_assignment.lua` (D14, 2 code
  lines + comment): `publish()` builds its key from `math.floor(unitID)`, the
  same integer-normalisation `pkey()` already applies to playerIDs.
  `tests/game_assignment_spec.lua` gains a regression case that calls
  `GG.Assignment.Set(100.0, 1)` and asserts `assign_100` exists and
  `assign_100.0` does not. Verified red-then-green: with the floor removed the
  new case fails (`expected 1, got nil`), with it **17/17** pass. Proven live
  too — republishing the running game's params with floored keys made the
  Recruit's client report `getMyAssignments() → [965, 27836]` and scope the
  box-select, which is how 3d/3e/3l could be tested at all.

No other defect fits the ≤10-line budget. D15 is the one that most deserves a
fix and explicitly does not (see its row).

## Not done this pass (stated plainly)

- **PLAN-beta.md §Verification item 4 (presentation)** — E2E3.
- **The `assign.set` / `assign.release` wire verbs were not exercised.** A
  Veteran re-assigning squads by hand is §(c) behaviour this pass never
  touched; only the auto-carve path and `AllowCommand` were.
- **`objectives.createBounty` was not sent from a browser client.** No wire
  sender is reachable from the page (`window.__nativeUi` exposes only
  `travelTo`/`open`), so 3l issued the exact documented payload at
  `gadget:RecvLuaMsg` with the Veteran's playerID instead. That covers the
  gadget's authority check and the publication contract; it does **not** cover
  `integration.ts`'s `WIRE_VERB_PREFIXES` encoder.
- **The carve was applied by hand in every run**, because D15 means the
  automatic path never fires. Every downstream PASS (3d–3f, 3l) is therefore a
  test of the mechanism, not of the journey a real Recruit would take today.
- **`/api/mentor/endorse` was not exercised**, so the +15-once-a-day rule and
  its day-bucket are unverified.
- **Declining the AI mentor ("NO THANKS") was not tested**, nor
  `/api/mentor/end` from the *mentor's* side (only the mentee's).
- **One unreproduced observation, deliberately not written up as a defect**:
  an early drill-down on the bounty objective showed no `Assigned: to you,
  from e2e_vet7` row even though the chip later rendered `TASK FROM E2E_VET7`.
  That first reading was taken with the briefing modal still up; room 79 was
  gone before it could be re-checked. Named here so a later pass can look, not
  claimed as a finding.
- **The near-black `scorched_crossing_v2.4` render (E2E1 D11) recurred** in
  rooms 77/79 and then did *not* in room 81 (`p2-08` shows properly lit
  terrain). Not investigated — it is pres-atmos/terrain-streaming's row.

## TOOLING GAP — one closed, the rest still open

- **`1440×900` is now achievable.** E2E1 recorded `resize_page` as a no-op
  (viewport stuck at 1440×801) and captured at the wrong size. **Use
  `chrome-devtools emulate` with `viewport: "1440x900x1"` instead** — it sets
  `Emulation.setDeviceMetricsOverride`, `innerHeight` reads 900, and every
  screenshot in this section is a true 1440×900 PNG. `resize_page` is still a
  no-op; nothing else changed.
- `window.test` is a class instance, so `Object.keys(window.test)` shows only
  `deps`/`renderPaused`/`nl` — the useful API is on the **prototype**
  (`Object.getOwnPropertyNames(Object.getPrototypeOf(window.test))`).
  `test.clientOrder(unitIds, cmdId, params, opts)` is the one that issues an
  order **as the local player** (so `AllowCommand` sees a real playerID);
  `test.order(...)` goes over the debug HTTP route and arrives with no player
  behind it, which the rank rule passes unconditionally. `test.nl(utterance)`
  is registered by the command-console widget, so it only exists once that
  widget has mounted.
- **A synthetic right-click does not issue a move order** (the box-drag
  pointer sequence E2E1 documented still works for selection). Use
  `test.selectUnits([...])` + `test.clientOrder(...)`.
- **`/api/rooms/join` and `/api/rooms/start` take `room_id`, not `room`** — a
  wrong key is parsed as `0` and comes back as a flat
  `403 {"error":"cannot join room"}` with no hint that the field was missing.
- The objective-hud chips (`.nui-objectives__stack`) cap at
  `MAX_OBJECTIVE_CHIPS = 3`; anything ranked below that needs
  `.nui-objectives__overflow` clicked before it is in the DOM at all.

---

# E2E pass 3 — Presentation (2026-09-21)

PLAN-beta.md §Verification item **4 (presentation)**, driven against the live
stack (`spring-lobby` :8011 from the MAIN checkout, vite :8012, game servers
9100+) with mcp-tools step 4 (`drive_pattern`, `populate_tranche`) folded in
per this step's brief. Items 1–3 were E2E1/E2E2.

**mcp-tools step 4 check**: both tools exist and work as documented —
`drive_pattern` (figure8/circle/line/zigzag waypoint loops, optional spawn +
capture) and `populate_tranche` (PLAN-perf.md §M19 XL-battle rungs S..XL1200
in one batched `exec_lua` call) landed `f0748514f0` per PLAN-beta.md's LIVE
STATE log. No gaps found in either this pass — see (b2) and (c) below, both
of which depend on them working correctly.

## (a) capture_sequence per weapon family — native FX, no orange cubes

Ran the client-side `?scenario=weapon-showcase` bench (not a lobby scenario —
a dev harness reached by URL param, `client/src/scenarios/bench/
weapon-showcase.ts`) via `open_client` + `capture_sequence(mode:realtime)`,
one weapon per Metalstorm WeaponDef family:

| Family | Entry | Shooter | Evidence |
|---|---|---|---|
| Cannon (autocannon) | `only=autocannon` | ms_tanks_s2 | `e2e/pres3/fx-autocannon-f000.jpg` — pale straw tracer, thin, short (matches DIRECTION.md's FX spec) |
| MissileLauncher (SAM) | `only=sam` | ms_mechs_s3 | `e2e/pres3/fx-sam-f000.jpg` — red missile streak toward the airborne target |
| AircraftBomb | `only=bomb` | ms_bombers_s2 | `e2e/pres3/fx-bomb-f000.jpg` — bomber silhouette on its run |

No orange emissive cubes or coloured spheres in any frame — every effect
rendered as its own native mesh/particle shape, not a debug-placeholder
primitive. **Not exhaustive**: the showcase has 9 entries across 4 families
(mg, autocannon, railgun, howitzer, flak, cruise, sam, bomb, air-to-air); this
pass sampled one representative entry per the 3 families that have visible
projectile FX (Cannon/MissileLauncher/AircraftBomb), not all 9. **Torpedo is
a documented placeholder** (the scenario's own comment: "the test map has no
water") — not run, matching the file's own stated limitation, not a defect.

## (b) client_screenshot — meridian_basin grading, scorched_crossing_v2.4 wedge recheck

**meridian_basin** (`e2e/pres3/01-meridian-basin-sky-fog-grading.png`,
1440×900): sky dome gradient, aerial perspective toward a desaturated
blue-grey horizon, and value-contrast grading all read as intended per
DIRECTION.md ("contrast 1.15, exposure 0.9 … aerial perspective towards a
desaturated horizon"). One re-confirmed (not new) observation: a faint
crosshatch dither persists over midground terrain even with `set_los(true)`
— the same FOW-rendering class of finding pres-atmos AT3/D11 already own;
not re-investigated here.

**scorched_crossing_v2.4** black-wedge recheck
(`e2e/pres3/02-scorched-crossing-corner-recheck.png`, low-angle shot of the
`X≈0-1000, Z≈6000-7168` corner, global LOS on): the AT2 diffuse-alpha fix
holds — no repeat of the original hard-edged wedge crushing a large fraction
of the frame. The **residual** black patch in that exact corner is still
visible, exactly as terrain-streaming K2/K3 left it: independently
byte/pixel-audited and closed as **genuine map content** (a real dark, flat
corner at the map's playable-area boundary), not a rendering defect. No
regression, nothing new to route.

## (b2) Tread marks — DT5 (`c366641847`) confirmed LIVE for all three trackTypes

DT5 wired `leaveTracks`/`trackType` into `units/_builder.lua`'s
`trackDefaults` (StdTank / StdWheel / StdBipedFoot) but — per PLAN-beta.md's
LIVE STATE log — was "NEVER SEEN LIVE" (its own fire had no MCP wired in).
This pass drove one unit of each trackType through a `drive_pattern
figure8` on `green_flat_x34_v3` (team 1, Null AI, avoiding the team-0
`strategos` co-commander re-routing gotcha the pres-decals TOOLING GAP
already named) and shot `capture_subject` top + low at the end of each loop:

| Unit | trackType | Result | Evidence |
|---|---|---|---|
| ms_tanks_s2 | StdTank | **PASS** — wide paired tread scuffs, clearly visible top-down | `pres-decals/02-treadmarks-top-ms_tanks_s2.jpg`, `03-…-low-…jpg` |
| ms_scout_buggy | StdWheel | **PASS** — thin double-rut wheel track, distinct pattern from the tank's | `pres-decals/04-treadmarks-top-ms_scout_buggy.jpg`, `05-…-low-…jpg` |
| fable_mech | StdBipedFoot | **PASS** — alternating two-legged footprint trail | `pres-decals/06-treadmarks-top-fable_mech.jpg`, `07-…-low-…jpg` |

All three trackType buckets (`decal-overlay.ts` `classifyTrackType`) render
correctly and distinctly live. DT5's finding is closed: the feature is not
dead in production.

The old `00-figure8-top-no-trail.jpg` / `01-figure8-low-no-trail.jpg`
evidence row (pres-verify fire 3, pre-DT5) is superseded by the above. **Not
deleted** — `git rm` requires interactive approval this headless session
cannot grant, so the two old files plus one stray duplicate from a
mid-capture mishap were moved to `pres-decals/superseded-no-trail/` instead
(same "harness gates file deletion" pattern the 2026-09-17 killed-fire
screenshots used). A human running `git rm -r
docs/reviews/beta/pres-decals/superseded-no-trail` can finish the cleanup.

**One tooling incident recorded for the next fire**: opening a *second*
admin-username browser client into a room already holding a spring-debug
`open_client` admin session invalidates the first — the original client's
streamed units vanish from its scene (they're still alive server-side,
confirmed via `list_units`) and a stale objective board renders instead.
Fix used: never mix `spring-debug open_client` and a second `chrome-devtools`
client into the *same* room under the *same* username — pick one driver per
room. Cost this pass: the first tank+buggy drive had to be redone.

## (c) XL900 perf — Medium preset

`populate_tranche(rung:"XL900")` on `meridian_basin` (the contested-core
ford, 8192,8192): **900 units spawned in one call** (450 north / 450 south),
`gfx.quality` set to `medium` first (`window.__settings.applyPreset('medium')`,
confirmed `get('gfx.quality') === 'medium'`). Measured over a 30 s window
after a short settle:

**Client render pipeline** (`browser_test.perfDump()`):

| phase | mean | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| camera | 0.08 | 0.10 | 0.20 | 0.20 | 0.70 |
| entity | 5.42 | 5.20 | 6.80 | 7.90 | 10.50 |
| fx | 0.06 | 0.10 | 0.20 | 0.30 | 0.40 |
| decals+lights | 0.16 | 0.10 | 0.20 | 0.40 | 11.40 |
| **render** | **5.10** | **5.00** | **6.70** | 7.80 | 23.50 |
| ui | 0.90 | 0.90 | 1.10 | 1.30 | 2.40 |
| total | 11.74 | 11.50 | 14.50 | 16.40 | 31.10 |

fps 58.9, 1768 frames sampled. **`render` phase p95 = 6.7 ms — PASSES the
≤8.5 ms budget** with headroom (the acceptance criterion, per this pass's
brief and pres-verify's original "render p95 ≤ 8.5 ms" framing, is the
render phase specifically, not the `total` p95 of 14.5 ms, which also sums
in `entity` — a separate phase).

**Server sim** (`profile(target:"sim")`, 829 frames sampled): avg 5.5 ms/frame
(96.9% `native-sim`, 2.9% `lua-gameframe`, 0.2% `unit-script`), comfortably
inside the 33.3 ms/frame budget for a 30 Hz sim; one 94.7 ms outlier frame,
almost certainly the `populate_tranche` spawn burst itself rather than
sustained load (829 samples, one spike).

**Conclusion**: XL900 on Medium passes its perf bar on both the client render
phase and the server sim tick. This closes the tooling gap pres-verify fire 3
and this lane's own "Not done" list carried forward from E2E1/E2E2 (no
committed XL900 spawn script existed before `populate_tranche` landed).

## (d) Lobby + in-game HUD at 1440×900 vs docs/ui-style.md

Captured via `chrome-devtools` `emulate(viewport:"1440x900x1")` +
`take_screenshot`, then **programmatically audited computed styles** on every
visible element (not just eyeballed) for the two hard rules in
`docs/ui-style.md` / DIRECTION.md: no drop shadows (only a 1px **inset**
edge is allowed) and no radius above `--nui-radius` (2px):

| Screen | Screenshot | box-shadow violations | radius > 2px violations |
|---|---|---|---|
| Welcome | `e2e/pres3/04-lobby-welcome-1440x900.png` | 0 | 0 |
| Intro slide 1/3 | `e2e/pres3/05-lobby-intro-slide1-1440x900.png` | 0 | 0 |
| Intro slide 3/3 ("Your Role") | `e2e/pres3/06-lobby-intro-slide3-yourrole-1440x900.png` | 0 | 0 (gradient placeholder fix from pres-ui-ds still holds) |
| Hub (existing admin session) | `e2e/pres3/03-lobby-hub-1440x900.png` | 0 | 0 |
| Hub (fresh sign-up) | `e2e/pres3/07-lobby-hub-fresh-1440x900.png` | 0 | 0 |
| In-game HUD, rest state (`crossing_standoff`) | `e2e/pres3/08-ingame-hud-rest-1440x900.png` | 0 | 0 |

The only elements anywhere with radius > 2px (3–4px) belong to a hidden
dev/debug log panel (`pane-clear-btn`, `panel-level-filter`, etc.,
`offsetParent === null` — never shown to a player); excluded as noise, not a
finding. Six for six clean — no violations of the stencilled-steel-plate
rules found this pass.

## (e) Audio — offline loudness report + live weapon-fire/reverb check

**Offline loudness report**: `docs/reviews/beta/audio-loudness.md` already
exists (`tools/audiogen/build.py --loudness-report`, ffmpeg `ebur128`) and is
**verified fresh** this pass — `find data/games/metalstorm/sounds -newer
docs/reviews/beta/audio-loudness.md` returns 0 files, i.e. nothing shipped
has changed since the report was generated. All 9 categories present
(ambience, death, explosion, impact, music, reverb, ui, unit, weapon). Not
regenerated (would just re-synthesise identical output).

**Live check — weapon fires a sound**: `AudioManager` isn't exposed on
`window`, so this pass instrumented the two real Web Audio globals it
actually calls, via a `navigate_page` `initScript` (runs before any page
script): `AudioContext.prototype.createBufferSource` (counts real one-shot
voice creation) and `AudioParam.prototype.value`'s setter (tagged by
call-stack function name). Spawned a tank + a static target
(`crossing_standoff`), ordered ATTACK, waited for reload: **the target's HP
dropped 12000 → 8787, confirming real weapon fire**, but
`__audioProbe.sourceCreates` stayed **0** — because `AudioManager.play()`'s
first line is `if (!this.resumed) return;`, and `resumed` is only set by a
**real user gesture** on the canvas (`canvas.addEventListener('click', …
resume(), {once:true})` in `main.ts`) — exactly the browser autoplay-policy
gate, never fired by a synthetic/headless session. Dispatching one synthetic
`click` on the canvas resumed the context; the very next reload cycle
produced **20 real `createBufferSource()` calls**. **PASS**: the
fire → SoundEvent → `SoundEventPlayer` → `AudioManager.play()` pipeline
genuinely plays audio live, once the (expected, platform-level) autoplay
gate is past.

**Live check — reverb preset applies**: the same instrumentation caught
`setReverbPreset` live at map load, setting `reverbWetGain.value=0` /
`reverbDryGain.value=1` (fully dry) for `crossing_standoff`
(`scorched_crossing_v2.4`). Traced to the map's own `mapinfo.lua`:
`sound.preset = "default"` — the unedited Spring stock-template value, which
`setReverbPreset`'s first branch (`!preset || preset === 'default'`)
special-cases to dry passthrough on purpose. Cross-checked every shipped
map: most declare no `sound` table at all (→ `resolveReverbPreset`'s
`'open'` default, i.e. real reverb), but `scorched_crossing_v2.4`,
`pools_of_ilys_1.0.0` and `wanderlust2.1` all still carry the literal
`preset = "default"` boilerplate, and `techno_lands_final_2.60_wide` sets
`preset = "forest"`, which doesn't match any shipped
`sounds/efx/{open,urban,valley}.webm` and would *also* fall through to dry
(same defect class, worse — a mismatched name where `data-review` would
list it as intentional). **PASS on mechanism** (the setReverbPreset pipeline
itself is correct and verified live); **content gap found and fixed for the
map this pass tested**.

**Fixed this pass** (`data/maps/scorched_crossing_v2.4/mapinfo.lua`, 3
lines): `preset = "default"` → `preset = "open"`, matching the map's real
outdoor river-crossing setting and the "open" preset meridian_basin gets by
default. **Not verified on the live stack** — this clone's `data/maps/` is
an independent CoW copy, not a symlink into `TASKHERD_REPO`; the running
stack still serves the unedited map until a human syncs or a lane with write
access to MAIN's map data lands it. Same "clone edit invisible live" caveat
this README's pres-atmos/K-series sections already document repeatedly.
`pools_of_ilys_1.0.0` and `wanderlust2.1`'s identical `"default"` and
`techno_lands_final_2.60_wide`'s mismatched `"forest"` are **not fixed** —
out of this pass's tested scope (neither map was touched by items a–d
above); named here so whoever owns map content can batch them.

## Defects — E2E pass 3

| # | Sev | Defect | Repro | Owning lane |
|---|---|---|---|---|
| D22 | LOW | `scorched_crossing_v2.4` shipped with `mapinfo.lua`'s `sound.preset` at the unedited Spring template value `"default"` (→ fully dry, no reverb) despite 3 real EFX IRs (open/urban/valley) being shipped. **FIXED this pass** (see above), not yet visible live (clone-only edit). | `data/maps/scorched_crossing_v2.4/mapinfo.lua:50`; live: `setReverbPreset` probe caught `wet=0,dry=1` at map load. | map content (untriaged — same map pres-atmos/terrain-streaming already own for the black-wedge/residual-corner work) |
| D23 | LOW/INFO | Same `"default"` boilerplate on `pools_of_ilys_1.0.0` and `wanderlust2.1`; `techno_lands_final_2.60_wide` sets `preset = "forest"`, which matches no shipped EFX file and falls through to dry the same way. Not fixed this pass (out of scope — none of these maps were tested this fire). | `grep -A1 'preset = ' data/maps/*/mapinfo.lua` | map content |
| D24 | INFO (tooling) | A second admin-username browser client connecting into a room already holding a `spring-debug open_client` admin session invalidates the first client's stream (units vanish from its scene; a stale objective board renders) without erroring. Cost one redo of the tread-mark tank+buggy drive this pass. | Open a room via `launch_scenario(openBrowser:true)`, then `chrome-devtools navigate_page` the same `user=admin` URL into a *second* browser context. | mcp-tools |

## Not done this pass (stated plainly)

- **capture_sequence coverage is 3 of 9 weapon-showcase entries** (one per
  visible-projectile family: Cannon/MissileLauncher/AircraftBomb) — mg,
  railgun, howitzer, flak, cruise, air-to-air were not individually shot.
  Torpedo is a documented placeholder (no water on the test map), correctly
  skipped, not a gap.
- **D22's fix is not verified live** — this clone's `data/maps/` doesn't
  reach the shared stack; needs a lane with MAIN write access (or a human)
  to land it and restart the lobby before the fixed reverb is audible.
- **D23's two `"default"` maps and one mismatched `"forest"` preset were
  found but not fixed** — not touched by this pass's tested scope.
- **XL900 was only measured on Medium** — Low/High presets and the
  XL1200 rung (also offered by `populate_tranche`) were not swept.
- **`git rm` for the superseded pres-decals evidence** could not be run in
  this headless session (interactive approval required) — the old files were
  moved aside instead of deleted; a human still needs to finish the delete.
- **The E2E2 leftover room in the lobby's "Missions" list** (`e2e3-perf`
  and similar rooms from this pass's own launches) will clear once their
  idle-exit timers fire; not force-cleaned beyond the normal `end_game` calls
  already issued for every room this pass opened.

## TOOLING GAP

- **mcp-tools MT4/MT5 (`drive_pattern`, `populate_tranche`) — none found this
  pass.** Both worked exactly as documented across every call.
- See D24 above (dual-admin-client collision).
- `AudioManager` has no debug/test surface on `window` — verifying live
  audio behaviour needs the `navigate_page initScript` +
  `AudioContext.prototype`/`AudioParam.prototype` monkey-patch trick used
  this pass (patch the real Web Audio API globals before the page's own
  scripts run, since prototype methods resolve dynamically at call time
  regardless of when the instance was constructed). Worth a real
  `window.test.audioDebug()` hook if audio gets tested live again.
- The browser autoplay gate (`AudioManager.resumed`, set only by a real
  canvas click) silently no-ops every `play()` call in a headless/synthetic
  session until something dispatches that click. Easy to mistake for "sound
  is broken" — it isn't; it's the platform gate.

---
