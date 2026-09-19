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
| D11 | INFO | The broadcast on `scorched_crossing_v2.4` renders near-black under the spectator camera (roads and rock silhouettes only). Uniform, **not** the hard-edged wedge pres-atmos AT2 fixed, and the same map is lit normally in the tutorial — so this reads as night lighting + unexplored FOW rather than the AT2 defect. Still worth a look: it is a new player's first sight of the game. Root cause **not** determined this pass. | `e2e/06-watcher-initial.png` | pres-atmos |
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
