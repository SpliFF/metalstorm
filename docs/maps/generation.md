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

Pure numpy, no GPL dependencies (`numpy`/`scipy`/`scikit-image`/`Pillow` in
`tools/mapgen/.venv`). All stages are data-in/data-out on `(H, W)` float64
grids; no file I/O inside the library. Everything is deterministic: seeded
`PCG64` permutation tables for noise, splitmix-style integer hashing for
scatter (never Python's process-salted `hash()`), no OS randomness anywhere.

| Module | Contents |
|---|---|
| `noise.py` | Seeded 2D simplex noise (vectorized), fBm, ridged multifractal (Musgrave weighting), billow, two-channel domain warping. |
| `hydrology.py` | Priority-flood depression filling (via `skimage` morphological reconstruction), flat resolution (vectorized wavefront BFS), D8 steepest-descent receivers, **level-order** flow-tree processing, flow accumulation, river-network extraction, flow-path lengths. |
| `erosion.py` | Fluvial erosion: the **implicit Braun & Willett (2013) stream-power solver** (`h' = (h + dt·U + F·h_recv') / (1+F)`, `F = K·A^m·dt/dx`), unconditionally stable, plus talus-angle **thermal erosion** (vectorized 8-neighbour transfers). Accepts a per-cell erodibility field (lithology variation). |
| `biomes.py` | Temperature (latitude gradient + altitude lapse + noise), moisture (noise + water-proximity + directional rain shadow), Whittaker-ish classification into 8 ids (grassland/forest/desert/tundra/snow/rock/wetland/water), soft blend weights. |
| `roads.py` | Least-cost road planning: 8-connected Dijkstra on a decimated grid with slope² cost, water/bridge penalties and max-grade cutoffs; MST topology over settlements (+ optional loops); Chaikin smoothing; full-res rasterization to mask + distance field; **cut-and-fill grading** of terrain under roads. |
| `settle.py` | Settlement-site scoring (windowed flatness × water proximity × biome desirability × edge falloff) and greedy separated site selection. |
| `vegetation.py` | Per-species density fields (biome base × moisture bonus × clump noise, minus exclusion zones) and **stratified-jitter scatter** — one hashed candidate per grid stratum, accepted with probability = local density. Blue-noise-like, order-independent, deterministic. |
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
(~11 min at 2049²), and contract/packaging iteration shouldn't re-pay it.
Delete the cache after changing anything upstream of stage 3 (base synthesis,
erosion parameters, seed).

Timings (M2 Pro, 2049²): erosion ~11 min (dominant; a numba port measured at
~20× is queued — PLAN-maps.md §2b), bake+cluster ~5 min, everything else
seconds. `--fast --preview-only` iterates in ~20 s.

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
   *Unlit* — material colour only (biome palettes + macro/grain tonal noise,
   slope rock exposure, wetness/shore darkening, riverbed tint by depth, sharp
   road decks with worn shoulders). Relief shading comes from the real-time
   sun + full-resolution mesh normals + CSM, and an unlit bake also clusters
   far better: `dxt1.cluster_tiles` vector-quantizes the 262,144 tiles of a
   16k map to a ~12k-tile budget (~8 MB SMT instead of ~178 MB). The SMT
   format *is* a deduplicated megatexture — this uses it as designed.
2. **Recoil's signed splat detail** up close: `splat_distr.png` (RGBA layer
   weights from biomes/slope) + `splat_detail.png` (4 tileable greyscale
   layers: grass/rock/sand/snow, procedurally synthesized, centred on 0.5).
   The client's `TerrainSplatPlugin` implements the exact SMF shader formula —
   `detail = dot(2·tex−1, distr·texMults)` **added before lighting** — so the
   signed detail self-fades through the mip chain with no distance threshold.
   Per-channel `texScales` at widely different rates provide multi-scale
   anti-tiling for free.

The minimap *does* bake hillshade (legibility beats physical correctness on a
2D map). `typemap` value 1 marks road surfaces; `mapinfo.lua` `terrainTypes`
gives them a speed multiplier.

## 6. Vegetation

The generator emits `mapconfig/featureplacer/config.lua` placements for the
species in `vegetation.TEMPERATE_SPECIES` (`tree_conifer`, `tree_broadleaf`,
`bush_scrub`, `rock_boulder`). The models are **procedurally forged**
(`tools/mapgen/gen_vegetation_models.py` → glTF + KTX2 into the map's
`objects3d/`, deterministic, licence-free), with 8-yaw × 3-pitch impostor
atlases baked by `tools/fable-model-forge/bake_impostors.py`.

Placement rules: per-biome densities with moisture bonuses and clump noise;
exclusion zones for roads, water, start pads, and `corridor`/`choke` regions
(chokepoints stay passable). Trees and boulders are `blocking`; scrub is not.

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

# process into data/maps (build-blocking E1 validation runs here)
build/release/tools/mapconverter/mapconverter --force content/maps/meridian_basin

# then: restart the Vite client if worker code changed, create a room on the
# map in the browser, and eyeball at strategic/gameplay/close zoom
# (docs/debugging.md + the run-springrts-web skill for the drive recipe)
```

The self-check output (`E1 <region> expected=… dominant=…`) must be all-OK
before processing; the C++ validator rejects the map otherwise.

## 8. Adding a new map

1. Author a layout skeleton (regions, tags, elevations, districts, start
   rows) or generate free-form: settlements from `settle.pick_sites`, starts
   from the same scoring with land-guarantee masks.
2. Write a generator script composing the §3 stages — copy meridian2.py and
   replace the structural-surface + contract sections. Pick a
   `bio.ClimateParams` (an ice or desert map is a parameter set: `lat_hot`,
   `altitude_lapse`, `base_moisture`, `wind_dir`, plus species tables).
3. Add `mapdata/regions.lua` (hand-authored or emitted from the layout) if
   the game uses the region system; keep the E1 self-check wired.
4. Run `--fast --preview-only` until the preview reads well, then full-res,
   then mapconverter, then the in-game pass.

## 9. Goldens

Reference captures of the shipped Meridian Basin (regenerate after visual
changes and eyeball against these):

![strategic zoom](screenshots/meridian_basin_strategic_zoom.jpeg)
![gameplay zoom](screenshots/meridian_basin_gameplay_zoom.jpeg)

## 10. Known limits & queued improvements

Tracked with citations and measurements in **PLAN-maps.md §2b**: numba port of
the hot kernels (~20× generation speedup), monotone-water-surface river
carving with `min`-combine and meander offsets, mapgen4-style rain-shadow
sweep, Galin-style road segment masks (kills 8-connected staircase) + trunk
reuse discount, v2 streamed texture pages (TEXTURE_2D_ARRAY cache, CPU-side
residency), client river-ribbon water surfaces, hemi-octahedral impostors.
Real-world DEM was evaluated and rejected as shipping terrain (30 m Nyquist,
DSM canopy cliffs) but is the calibration source for slope/drainage-density
statistics.
