# Terrain Generation — the terragen pipeline

How Spring RTS Web maps are procedurally generated: the `tools/mapgen/terragen/`
library, the per-map generator scripts that compose it (`meridian2.py` is the
reference), what the package contains, and how the result is rendered. For the
*gameplay design* of Meridian Basin itself (regions, rows, chokepoints) see
[meridian-basin.md](meridian-basin.md); for authoring workflow around mapinfo /
regions / processing see [maps-native.md](../maps-native.md).

Goals (user directive 2026-07-27, PLAN-maps.md): large maps that are
**realistic first** — rivers/lakes, believable mountains and valleys, roads,
towns, earth-like biomes — with deterministic regeneration from a seed.
Balance/symmetry is not a requirement; gameplay contracts (slope bands, fords,
start pads) are enforced as *constraints on* realistic terrain, not by
sculpting shapes directly.

---

## 1. Why not just noise

Fractal noise (fBm/ridged) cannot produce valley structure: valleys are carved
by an *integrated global process* (water flowing downhill, accumulating, and
incising), while noise is local by construction. Pure-noise terrain reads as
"blobby". The realism in this pipeline comes from simulating that process —
**stream-power erosion over a noise-seeded base** — which produces dendritic
drainage networks, consistent watersheds, ridge spurs and valley spacing that
match how real terrain forms. Noise supplies only the initial condition and
the fine detail layer.

## 2. Library layout (`tools/mapgen/terragen/`)

Pure numpy, no GPL dependencies (`numpy`/`scipy`/`scikit-image`/`Pillow`/
`numba` in `tools/mapgen/.venv`; numba is BSD-licensed, validated against the
rejected GPL-3 alternatives — PLAN-maps.md §2b). All stages are data-in/
data-out on `(H, W)` float64 grids; no file I/O inside the library. Everything
is deterministic: seeded `PCG64` permutation tables for noise, splitmix-style
integer hashing for scatter (never Python's process-salted `hash()`), no OS
randomness anywhere. The numba `@njit` kernels (noise, `resolve_flats`,
`d8_receivers`, the LEM solve, thermal erosion) are additionally
**thread-count-independent** — every parallel (`prange`) loop writes one
output element per iteration with no cross-thread accumulation, so results
don't depend on `NUMBA_NUM_THREADS` (verified: `terragen/_selftest_numba.py`).

| Module | Contents |
|---|---|
| `noise.py` | Seeded 2D simplex noise, fBm, ridged multifractal (Musgrave weighting), billow, two-channel domain warping — fused `@njit` kernels (PLAN-maps.md §2b item 1: ~70-80× measured on fBm). |
| `hydrology.py` | Priority-flood depression filling (via `skimage` morphological reconstruction, not ported — see below), D8 steepest-descent receivers and flat resolution (both `@njit`; `resolve_flats` walks an explicit frontier queue instead of re-scanning the whole grid every BFS ring — ~100-700× measured), **level-order** flow-tree processing, flow accumulation, river-network extraction, flow-path lengths. |
| `erosion.py` | Fluvial erosion: the **implicit Braun & Willett (2013) stream-power solver** (`h' = (h + dt·U + F·h_recv') / (1+F)`, `F = K·A^m·dt/dx`), unconditionally stable, plus talus-angle **thermal erosion** (8-neighbour transfers) — both `@njit`. Accepts a per-cell erodibility field (lithology variation). |
| `biomes.py` | Temperature (latitude gradient + altitude lapse + noise), moisture (noise + water-proximity + directional rain shadow), Whittaker-ish classification into 8 ids (grassland/forest/desert/tundra/snow/rock/wetland/water), soft blend weights. |
| `roads.py` | Least-cost road planning: 8-connected Dijkstra on a decimated grid with slope² cost, water/bridge penalties and max-grade cutoffs; MST topology over settlements (+ optional loops); Chaikin smoothing; full-res rasterization to mask + distance field; **cut-and-fill grading** of terrain under roads. |
| `settle.py` | Settlement-site scoring (windowed flatness × water proximity × biome desirability × edge falloff) and greedy separated site selection. |
| `vegetation.py` | Per-species density fields (biome base × moisture bonus × clump noise, minus exclusion zones) and the **stratified-jitter hash engine** — one hashed candidate per grid stratum, accepted with probability = local density. Blue-noise-like, order-independent, deterministic. |
| `placement.py` | The **prop & ground-stamp placement subsystem** (§6): declarative `Layer`s = suitability field × sampler (`scatter`/`clusters`) × emit target (`FeatureEmit` → featureplacer entries, `StampEmit` → ground fields the bake composites). Composable suitability helpers (`biome_suitability`, `slope_window`, `below_cliffs`). |
| `dxt1.py` | Vectorized BC1/DXT1 range-fit encoder and **SMT tile clustering**: seeded minibatch k-means over 8×8 downsampled tile features, representatives chosen as *real source tiles* (never averages). |
| `smf.py` | SMF/SMT container writer (heightmap quantization, tile index, typemap/metalmap, the 9-level minimap DXT1 chain). Layout matches `rts/Server/MapProcessor.cpp` exactly. |
| `bake.py` | The albedo bake + splat textures (§5). |
| `package.py` | Map-package assembly: SMF/SMT, splat PNGs, `mapinfo.lua` emission (water, atmosphere, splat scales/mults, road `terrainTypes`, start positions), regions/feature files passthrough. |

### The level-order trick (why this is fast in pure numpy)

Downstream accumulation and the implicit erosion solve are inherently
sequential (a cell depends on its receiver). Instead of per-cell Python loops,
`hydrology.topo_levels()` groups cells by **depth in the receiver forest**:
level 0 = outlets, level *k* = cells whose receiver is in level *k−1*.
Processing levels in order guarantees every dependency is ready, and each
level is one vectorized numpy operation. Tree depth on a 2049² map is a few
thousand, so the per-level overhead is negligible. The same structure serves
accumulation (reverse order, `np.add.at` scatter) and the erosion solve
(forward order).

## 3. Pipeline stages (what a generator script composes)

```
seed + config (+ optional layout skeleton)
  1. base synthesis   structural surface + wildness-masked ridged/fBm detail
  2. erosion          N iterations of { fill → route → implicit stream-power
                      solve } + thermal talus, on the full grid
  3. contracts        re-enforce gameplay geometry (§4)
  4. hydrology        final fill/route/accumulate → river network, lakes;
                      minor stream beds carved by log-discharge
  5. roads            settlement/waypoint endpoints → least-cost network →
                      rasterize → grade terrain under decks
  6. climate/biomes   temperature + moisture (+ rain shadow) → biome ids
  7. vegetation       per-species scatter, exclusions (roads, water, start
                      pads, corridor/choke regions) → featureplacer config
  8. self-check       E1 slope-band audit (mirrors the C++ validator)
  9. package          bake + cluster + SMF/SMT + mapinfo + splats + minimap
```

`tools/mapgen/meridian2.py` is the reference composition. Useful flags:

```
.venv/bin/python meridian2.py [--out DIR] [--seed N]
    --fast           513² grid (32 elmo/cell) — E1/preview iteration only;
                     the SMF it writes claims a 4096-elmo map, do NOT ship it
    --preview-only   skip packaging, write preview.png (hillshaded albedo)
    --with-features  emit vegetation placements (requires the map to carry
                     the tree/rock models — see §6)
```

The **eroded heightfield is cached** at
`$TMPDIR/meridian2_eroded_<seed>_<res>.npy` — erosion is the long pole
(~75 s/iter at 2049² post-numba-port, down from ~11 min for the full 30-iter
run pre-port), and contract/packaging iteration shouldn't re-pay it. Delete
the cache after changing anything upstream of stage 3 (base synthesis,
erosion parameters, seed).

Timings (M2 Pro, real layout terrain, numba-ported — PLAN-maps.md §2b item 1):
erosion per-iteration ~0.15 s @513², ~2.5 s @2049² (was ~0.4 s / ~22-40 s
pre-port — `resolve_flats` alone went from seconds-to-tens-of-seconds down to
tens of milliseconds), ~17.5 s @4097². `fill_depressions` (skimage, not
ported — reimplementing morphological reconstruction bit-exact was judged too
risky) and `topo_levels` (plain numpy, not ported) are now the dominant
remaining per-iteration cost at 4097² (~7.6 s and ~4.2 s respectively) — the
next lever if 4097² needs to get faster still. bake+cluster ~5 min,
everything else seconds. `--fast --preview-only` iterates in ~20 s.

## 4. Gameplay contracts on realistic terrain

Realism must not break the map's playability contracts. The pattern
(meridian2.py, stages 1 + 3):

- **Structural surface**: the region layout's target elevations are blended
  bbox-margin-weighted (as the original plateau generator did) but only as the
  *low-frequency* base. A per-region **wildness** multiplier scales how much
  mountain detail each region receives — ridge rows get full relief, ford
  decks/start rows stay calm.
- **Post-erosion re-enforcement**: ford decks and island pads blend back to
  their target elevations (feathered `smoothstep`); the row-D river is carved
  as a **meandering channel with a capped half-width** (so wide regions keep
  dry banks instead of becoming region-wide slabs — the basin's structural
  floor is *dry* at +16 elmos, the carved channel provides the ≤12-deep
  crossing); start pads flatten to their local median.
- **Slope-band enforcement (E1)**: regions tagged `infantry_only` /
  `heavy_restricted` must be *dominated* by their slope band (32–45° /
  24–32°). Enforced by **convergent per-region thermal erosion**: relax the
  region at a talus angle inside its band, re-measure, repeat until dominant
  (bounded attempts). This is checked twice — the generator's self-check and
  the build-blocking validator in `MapProcessor::ExtractRegions`.
- **Water**: the engine has a **single water plane at y=0** (Recoil-faithful,
  and the sim's move-depth model depends on it). Principal rivers/lakes are
  carved below 0; *elevated* stream beds render as dry gullies/wetland splat.
  Client-side "river ribbon" surfaces are a documented future divergence
  (PLAN-maps.md).

If the layout changes (`meridian_layout.json`), `mapdata/regions.lua` and
`mapdata/civilians.lua` must be regenerated with it — meridian2.py deliberately
does **not** touch them because the current skeleton is unchanged from the
original generator.

## 5. Texturing model

Two layers, matching what Spring/Recoil (and SupCom/Frostbite/Unity) converge
on — see the research record in PLAN-maps.md §1.2:

1. **Baked whole-map albedo at 1 texel/elmo** in the SMT tile layer.
   *Unlit* — material colour only (biome palettes + macro/mid tonal noise,
   slope rock exposure, ground stamps (§6), wetness/shore darkening, riverbed
   tint by depth, sharp road decks with worn shoulders). Relief shading comes
   from the real-time sun + full-resolution mesh normals + CSM, and an unlit
   bake also clusters far better: `dxt1.cluster_tiles` vector-quantizes the
   262,144 tiles of a 16k map to a ~12k-tile budget (~8 MB SMT instead of
   ~178 MB). The SMT format *is* a deduplicated megatexture — this uses it
   as designed.

   Two hard-won rules keep the bake artefact-free:
   - **The bake stays low-frequency** (nothing under ~50-elmo wavelength).
     Tile dedup collapses uniform areas onto a handful of representative
     tiles, so any baked per-texel grain becomes the *same* 32-elmo noise
     pattern repeating with visible grid seams. Per-texel grain is the
     runtime splat layer's job.
   - **Biome colours blend through smoothed weight fields sampled via a
     fractally warped domain** (per-biome Gaussian one-hots, ±22-elmo warp
     at two scales, noise-perturbed in the mixed zone, then sharpened and
     renormalized). Nearest-id lookup at heightmap res produces 8-elmo
     axis-aligned staircases at every biome edge; the warped blend gives
     irregular, patchy transitions (snow↔rock, grass↔forest) instead.
2. **Recoil's signed splat detail** up close: `splat_distr.png` (RGBA layer
   weights from biomes/slope + ground stamps) + `splat_detail.png` (4 tileable
   greyscale layers: grass/rock/sand/snow, procedurally synthesized). The
   client's `TerrainSplatPlugin` implements the exact SMF shader formula —
   `detail = dot(2·tex−1, distr·texMults)` **added before lighting** — so the
   signed detail self-fades through the mip chain with no distance threshold.
   Per-channel `texScales` at widely different rates provide multi-scale
   anti-tiling for free.

   Detail-texture synthesis rules: the seamless-tiling wrapper's 4-corner
   blend weights must come from the **raw** tile coordinates — domain offsets
   and anisotropic frequencies apply inside the noise sample only (offset
   blend coords extrapolate instead of blending and render as structured
   banding repeating at the texscale period). Directional components (the
   sand ripple) use an integer number of cycles per tile. Every channel is
   **zero-meaned** before encoding, so the mip-faded far field carries no
   brightness offset relative to the near field.

The minimap *does* bake hillshade (legibility beats physical correctness on a
2D map). `typemap` value 1 marks road surfaces; `mapinfo.lua` `terrainTypes`
gives them a speed multiplier.

## 6. Placement (vegetation, boulders, ground stamps)

`terragen/placement.py` is the placement subsystem: everything the generator
drops onto the finished heightfield goes through one declarative model.

A **`Layer`** is one placement rule:

- **WHERE** — a `suitability(ctx) -> (H,W) [0,1]` field, composed from
  helpers (`biome_suitability`, `slope_window`, `below_cliffs`, `combine`)
  or any custom closure over the `PlacementContext`
  (height/slope/biomes/moisture/exclusion).
- **HOW** — a sampler: `scatter` (stratified-jitter blue noise, one hashed
  candidate per stratum cell), `clusters` (sparse hashed seeds accepted by
  suitability, then a hashed ring of members — talus fans, boulder fields),
  or `along_paths` (stations along `ctx.paths` polylines — the road network
  today, rail later — with hashed dropout, lateral offset, and rotation set
  to the local path heading: fences, roadside debris, sleepers, poles).
  `TemplateEmit` turns any sampler's placements into composed *sites*: a
  template of (name, dx, dz, keep) elements rotated by the site's hashed
  rotation with per-element jitter and dropout — ruin colonnades lose
  different pillars at every site; dwelling compounds use the same shape.
- **WHAT** — an emit target: `FeatureEmit` (weighted feature-def names →
  featureplacer `objectlist` entries, i.e. real sim features) or `StampEmit`
  (soft smoothstep discs rasterized into named grid-res fields — **baked
  decals**: `bake.py` composites them into the albedo with warped ragged
  edges, and `make_splat_distr` routes each stamp to its detail channel via
  `STAMP_STYLE`, so scree gets rock granulation and sand gets ripple grain
  at zero runtime cost).

All randomness is `_hash01` integer hashing keyed on `(seed, layer name)` —
fully deterministic, no RNG order dependence. Future placement families
(wreckage, dwellings, rail lines, bridges) are new layers/targets on this
model, not new mechanisms.

Meridian's layer set: the four `vegetation.TEMPERATE_SPECIES` scatter layers
(species density fields become layer suitabilities), `boulder_field` clusters
(`rock_boulder_large` + `rock_boulder` mixed, favouring rocky biomes and the
scree aprons), `erratic` lone outcrops, `deadwood` (fallen logs + stumps in
the `forest_edge` band, sparse inside), `road_fences` (broken split-rail
segments along the road polylines), `ruin_colonnade` template sites (7-pillar
ring + 3 wall fragments + optional centre monolith, on flat open ground
within sight of a road), `ridge_stones` (lone monoliths on high ground),
`talus_scree` stamps below cliffs (>34° dilated), and `sand_flats` stamps
(desert + low flat shores). Roads additionally get **junction plazas**
(`roads.carve_plazas`): circular worn decks merged into the road distance
field at district centres and convoy waypoints, so grading and the bake
treat them exactly like the ways that meet them. All models are
**procedurally forged** (`tools/mapgen/gen_vegetation_models.py` → glTF +
KTX2 into the map's `objects3d/`, deterministic, licence-free), with 8-yaw ×
3-pitch impostor atlases baked by `tools/fable-model-forge/bake_impostors.py`.

Exclusion zones (roads, water, start pads, `corridor`/`choke` regions) gate
feature layers so chokepoints stay passable; stamps ignore them (the road
deck is painted over stamps in the bake). Trees and boulders are `blocking`;
scrub is not. Per-placement scale is recorded but the Spring featureplacer
format doesn't carry it — size variety comes from multiple feature defs
(`rock_boulder` vs `rock_boulder_large`).

Rendering: `feature-lod-renderer.ts` splits each species into 2048-elmo tiles
with three tiers — full mesh (≤2500 elmos), impostor card (≤10000), culled
(beyond, and at whole-map camera height, where the albedo bake carries the
forest read). Vegetation casts CSM shadows only within `shadowDistance`
(1200 elmos) — Babylon submits every caster to every cascade, so ungated
casting cost ~18 ms/frame at close zoom on the 54k-feature Meridian.

## 7. Processing & verification loop

```
# regenerate (full res, with vegetation)
cd tools/mapgen && .venv/bin/python meridian2.py --with-features

# process into data/maps (build-blocking E1 validation runs here).
# Regenerated sources are auto-detected: processing writes a
# .processed-stamp, and any source file newer than it triggers a reprocess —
# --force is only needed to rebuild an UNCHANGED map (e.g. after C++
# processing changes).
build/release/tools/mapconverter/mapconverter content/maps/meridian_basin

# then: RESTART THE LOBBY (its maps-table handle goes stale after the
# converter writes the DB — symptoms: /api/maps returns [], metadata.json
# 404s, blank canvas behind the HUD), restart the Vite client if worker code
# changed, create a room on the map in the browser, and eyeball at
# strategic/gameplay/close zoom (docs/debugging.md + the run-springrts-web
# skill for the drive recipe)
```

The self-check output (`E1 <region> expected=… dominant=…`) must be all-OK
before processing; the C++ validator rejects the map otherwise.

## 8. Adding a new map

Two shipped generator styles to copy from:

- **Layout-driven** (`meridian2.py`): a hand-authored region skeleton with
  gameplay contracts re-enforced after erosion. Copy it when the map's
  strategic layout is designed first (regions.lua + E1 validation).
- **Free-form parameterized** (`archipelago.py` → Skerry Reach): everything
  derived from CLI parameters — `--seed`, `--landmass` (fraction of area
  above the waterline, enforced by quantile calibration before AND after
  erosion), `--islands`. Same parameters ⇒ byte-identical map (verified:
  independent cold runs hash equal). Island centres via deterministic
  dart-throwing; starts round-robin across the largest islands via
  `settle` scoring (its own contract: 8 dry, separated, flattened pads);
  per-island road networks (roads never island-hop); the full placement
  layer set (§6) including `tools/mapgen/vegetation_defs.lua`, the shared
  prop-def file generated maps install as `features/vegetation.lua`.

Recipe:
1. Copy the closer generator; replace the surface-synthesis section. Pick a
   `bio.ClimateParams` (an ice or desert map is a parameter set: `lat_hot`,
   `altitude_lapse`, `base_moisture`, `wind_dir`, plus species tables).
2. Add `mapdata/regions.lua` + the E1 self-check if the game uses the
   region system; free-form maps assert their own generated contracts
   (land fraction, dry starts) instead.
3. Iterate: `--fast --preview-only` for composition (30-60 s),
   `--no-package` for placement-layer tuning (~70 s full-res with cached
   erosion — watch the per-layer `suit %` coverage in the output), then
   full-res, `gen_vegetation_models.py --out <map dir>`, mapconverter,
   in-game pass. If you change the synthesis code, bump the generator's
   `SYNTH_REV` so the erosion cache re-keys.

## 9. Goldens

Reference captures of the shipped Meridian Basin (regenerate after visual
changes and eyeball against these):

![strategic zoom](screenshots/meridian_basin_strategic_zoom.jpeg)
![gameplay zoom](screenshots/meridian_basin_gameplay_zoom.jpeg)

## 10. Known limits & queued improvements

Tracked with citations and measurements in **PLAN-maps.md §2b**: numba port of
the hot kernels — **done** (item 1: ~9-80× depending on stage, `resolve_flats`
alone ~100-700×; `fill_depressions`/`topo_levels` are now the dominant
remaining per-iteration cost and are the next lever if needed) —
monotone-water-surface river carving with `min`-combine and meander offsets,
mapgen4-style rain-shadow sweep, Galin-style road segment masks (kills
8-connected staircase) + trunk
reuse discount, v2 streamed texture pages (TEXTURE_2D_ARRAY cache, CPU-side
residency), client river-ribbon water surfaces, hemi-octahedral impostors.
Real-world DEM was evaluated and rejected as shipping terrain (30 m Nyquist,
DSM canopy cliffs) but is the calibration source for slope/drainage-density
statistics.
