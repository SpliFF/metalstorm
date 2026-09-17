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
