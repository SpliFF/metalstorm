# Authoring Native Maps

How to build a purpose-built Metalstorm map from scratch — heightmap, region
graph, civilian/convoy data, scenario, and package — without hand-sculpting
terrain in an external editor. Written from the "Meridian Basin" build
(PLAN-metalstorm-beta-map.md tasks 2-7); read this before starting the
second map so the process isn't archaeology.

The pipeline is **procedural-first, hand-tuned**: a small layout graph (JSON)
drives a generator script that produces the heightmap, splat tiles, and
region graph together — so the map and its region data can never disagree,
because they share one source. You then hand-tune generator parameters
against a validator until it's green, the same loop a level designer would
run against a WYSIWYG editor, just with a deterministic script instead of a
mouse.

## Pipeline overview

```
tools/mapgen/<id>_layout.json      hand-authored: regions, bboxes, tags,
                                    values, slope/water bands, chokepoints,
                                    civilian districts, convoy routes,
                                    start positions, scenario ownership

        │  (tools/mapgen/<id>.py)
        ▼

content/maps/<id>/                 generated + hand-authored source tree
  maps/<id>.smf, <id>.smt          generated: heightmap, typemap, tile
                                    index, minimap, metalmap (binary SMF)
  mapdata/regions.lua              generated: region graph (from the same
                                    layout JSON, so it can't drift)
  mapdata/civilians.lua            hand-authored: civilian sites + convoys
  mapinfo.lua                      hand-authored: name, water, teams, etc.

        │  (mapconverter, or spring-lobby at boot)
        ▼

data/maps/<id>/                    processed output (heightmap.bin,
                                    tiles.ktx2, minimap.ktx2, ...) +
                                    a maps row in spring-server.db

data/games/metalstorm/scenarios/<id>.lua   hand-authored: default opening
                                            (region ownership, starting
                                            squads, objectives)

manifests/<id>_direct.json         hand-authored: one-call direct-start
```

## 1. The layout graph (single source of truth)

`tools/mapgen/<id>_layout.json` is the only place map geometry is designed.
Everything downstream — heightmap, `regions.lua`, `civilians.lua`,
`mapinfo.lua`'s start positions, the scenario's ownership seed — traces back
to this file. Top-level fields (see `meridian_layout.json` for the worked
example):

- `map`: name/key/size/square_size/sides/symmetry.
- `slope_bands` / `water_bands`: the moveinfo.tdf-derived thresholds
  (`data/games/metalstorm/gamedata/moveinfo.tdf`) the generator must band
  terrain to. Copy these from moveinfo.tdf verbatim — don't invent new
  thresholds; the whole point is that the generator's bands and the sim's
  passability grid agree by construction.
- `chokepoints`: corridor width sizing brief (narrower than a deployed
  formation, wider than a column — see the formula in the layout JSON's
  `chokepoints.note`).
- `regions`: array of `{key, name, side, row, centroid, bbox, value, tags,
  terrain_profile, neighbors}`. `terrain_profile.slope_band`/`water_band` is
  the generator's *authoring intent* for that region — not the same field
  `mapdata/regions.lua` ships (that file only has `polygon`/`value`/`tags`/
  `neighbors`, per PLAN-metalstorm-regions.md §1.1); the generator reads
  `terrain_profile` to build the heightmap, and the E1 validator re-derives
  the expected band from `tags` alone (see §3) so the two independently
  agree without a shared field.
- `civilian_districts`, `convoy_routes`, `start_positions`,
  `scenario_ownership`: consumed by the generator (civilians/start
  positions) and by the scenario file (ownership) — write these once here,
  not separately per consumer.
- `invariants`: the validator contract in prose (full coverage, symmetric
  adjacency, the E1 rule) — keep this in sync with what the generator's
  self-check and MapProcessor's `ExtractRegions` actually enforce.

## 2. The generator script

`tools/mapgen/<id>.py` (see `meridian.py`) is a pure function of the layout
JSON plus a small set of hand-tuned constants — no OS randomness, so two
runs produce byte-identical output (`--selftest` runs generation twice and
hashes the SMF/SMT/regions.lua to prove it).

### Heightmap composition

Height is a **weighted blend of per-region target elevations**, not a
hand-sculpted surface: each region gets one `ELEVATION[key]` constant; at
any world point, every region contributes a weight based on distance to its
own bbox (1.0 deep inside, 0.0 beyond a margin, linear in between — see
`bbox_weight`), and the point's height is the weighted average. This is
computed on a coarse control grid (32-elmo spacing) and bilinearly upsampled
to full heightmap resolution, both for speed (pure Python, no numpy — a
full-resolution 16k² pass would take minutes; the control-grid approach
takes ~7s) and because it doesn't need per-vertex precision to produce
smooth, correctly-banded terrain.

**The margin — not the elevation delta — controls where a region's slope
lands, and it's the harder of the two to reason about by hand.** A region's
own flat "plateau" core is bounded by how far its *neighbours'* margins
reach into it, not by its own margin (a point is only shared between two
regions' influence — and thus only slopes — within both regions' combined
reach; deep inside one region's territory, wherever only that region has
nonzero weight, the result is flat, exactly its target elevation, regardless
of that region's own margin value). Concretely, to shrink a ridge region's
flat crest (make more of its area count as ramp), widen its *neighbours'*
margins, not its own. This was the single biggest source of iteration time
building Meridian Basin — see `MARGIN_OVERRIDE` in `meridian.py` and its
comments for the resolved per-region values; expect to spend real time on
this loop for the second map too, it does not solve itself analytically in
one pass.

A cubic smoothstep blend was tried first and discarded: its derivative
tapers to zero at both ends of a transition, so only the transition's
midpoint reaches the target slope and most of the ramp reads as
sub-target — bad for "dominant band by area" checks. A **linear** blend
(clamped, with a corner kink at each end) holds close to the target slope
across nearly the whole transition, which is what the validator needs.

### Splat/tile palette

The generator classifies each 32-elmo tile by its sampled slope/water band
and picks one of 8 fixed flat-color tiles (4 dry slope bands + 4 water
depth bands). **The 4 dry bands sample the shared unit/building palette
atlas verbatim** (`data/games/metalstorm/unittextures/atlas_palette.ktx2`,
row 3 — concrete grey / worn steel / civilian tan / ground-contact dark —
see `tools/scripts/make_palette_atlas.py` and `art/STYLE.md`), so terrain
reads as the same material language as buildings and civilian props. Water
has no atlas swatch (it's a unit-material sheet, not a terrain one) — the 4
water-band colours are this map's own addition; that's a deliberate,
called-out deviation, not a silent one.

Tiles are DXT1, encoded as **solid color per 4×4 block** (`color0 = color1
- 1` forces 4-color opaque mode deterministically, indices all zero select
`color0`) — trivial to encode correctly and matches the flat-shaded,
no-baked-gradient art direction. `solid_tile_record()` also fills mip1-3
with the same solid block (cheap since a constant-color image downsamples
to the same constant color) — **but MapProcessor's `ExtractBinaryData`
currently only extracts mip0** from each SMT record (`TILE_MIP0_SIZE=512`
bytes, the rest is skipped) into `tiles.ktx2`. See §6 "Known limitation".

### Determinism

`--selftest` generates into two temp dirs and hashes the SMF/SMT/regions.lua
outputs. There is no PRNG seed threaded through the height/regions/typemap
logic — everything is deterministic by construction. If you add stochastic
variation (e.g. metal-spot jitter) later, seed it explicitly and re-run
`--selftest`.

## 3. The region validator (E1 slope-consistency)

`rts/Server/MapProcessor.cpp`'s `ExtractRegions` (called from `ProcessMap`
right after `ExtractBinaryData`, since it needs the decoded heightmap) is
the C++-side equivalent of the generator's own `selfcheck_slope_bands` — the
two independently apply the *same* rule so a hand-edit that breaks one
should break the other too:

- Basic graph validation: unique keys, polygons within map bounds,
  neighbour adjacency symmetric, non-negative values. (No prior C++
  implementation of even this existed on this branch — see §7.)
- **E1**: for a region tagged `infantry_only` / `heavy_restricted` /
  `corridor` / `choke`, sample its polygon interior on a 64-elmo grid,
  classify each sample's slope band, and require the *dominant* band match
  what the tag implies (`infantry_only`→infantry, `heavy_restricted`→veh,
  `corridor`/`choke`→flat). **`corridor`/`choke` sampling must NOT exclude
  underwater points** — a ford deck is *supposed* to be shallow water over
  flat ground (see `meridian_layout.json`'s `chokepoints`); excluding wet
  samples there throws away the flat crossing itself and leaves only the
  steep dry banks climbing to the flanking ridges, which will never read as
  "flat" no matter how the heightmap is tuned. `infantry_only`/
  `heavy_restricted` (dry ridge terrain) is the opposite — exclude wet
  samples there. Getting this backwards was the actual root cause behind an
  early, very confusing round of margin-tuning that made results *worse*
  the more the fix seemed to help (`tools/mapgen/meridian.py`'s
  `TAGS_DRY_ONLY` and `MapProcessor.cpp`'s matching comment covers this in
  detail — read it before re-deriving the same trap).

A **build-blocking** failure (`ProcessMap` returns false, no metadata
stored) on drift — verified with both a positive run (map processes clean,
8/8 regions OK) and a negative one (hand-corrupting one region's tag flips
its expected band and the build correctly aborts with "1 failures").

This validator is intentionally **validation-only**: it writes no
`regions.json` and touches no DB schema/column. A separate, more complete
region-control rewrite (commit `0838b8066b`, "implement region control" —
named-graph partition/control/ownership modules + a real `regions.json`
export + `MAP_FORMAT_VERSION` bump to 16) exists but is **not merged into
this branch** as of this writing. Don't assume it's present — `git log
--oneline -- rts/Server/MapProcessor.cpp` and `git merge-base --is-ancestor
0838b8066b HEAD` are the way to check before building on top of either
piece. When that lane merges, reconcile the two `ExtractRegions`
implementations rather than keeping both.

## 4. Civilian placement + convoys

`mapdata/civilians.lua` (schema documented at the top of the file, and
mirrored in `data/games/metalstorm/LuaRules/Gadgets/civilians/spawn.lua`'s
`spawn.seed` docstring, since no prior map had authored one): a `sites`
list (habitat/depot, position, population, unit-def pool) and a `convoys`
list (route between two districts, via regions, waypoints, schedule).
`spawn.seed` itself is **still a no-op stub** — authoring this data doesn't
make civilians spawn yet; that's separate gadget work, out of scope for a
map-packaging task. Don't be surprised the population doesn't appear
in-game; the file is real, correct, forward-compatible content waiting on a
consumer.

## 5. mapinfo.lua

New native maps set `legacycoordsystem = false` (the default is `true`,
for legacy Spring map imports authored in the LH `+Z` convention — a native
map authored directly against the engine's RH positive-quadrant frame must
opt out, or `MapProcessor::ProcessMap` will Z-reflect its start positions).
`smf.minheight`/`smf.maxheight` can be omitted if the generator already
baked the correct range into the SMF header (`ReadSMFHeader` fills
`meta.minHeight`/`maxHeight` from there when there's no mapinfo override) —
simpler than keeping two copies of the height range in sync.

## 6. Known limitation: terrain texture aliasing (mip chain)

Golden screenshots (`docs/maps/screenshots/meridian_basin_*.png`, captured
via `window.test.cameraFitMap()`/`cameraSnapToGround()` +
`window.test.screenshot()` against a real running direct-start session — not
synthetic) show pronounced horizontal-band aliasing on the terrain at any
distance beyond point-blank. Root cause, diagnosed while building this map:
`MapProcessor::ExtractBinaryData` extracts only `TILE_MIP0_SIZE` (512 bytes,
the 32×32-texel mip0) from each SMT tile record into `tiles.ktx2` and
explicitly skips the remaining mip1-3 data the SMT format carries. WebGL2
cannot runtime-generate mipmaps for compressed (DXT1/BC1) textures —
`gl.generateMipmap()` only works on uncompressed formats — so a compressed
terrain tile atlas with no precomputed mip chain has no mipmapping at all,
and severe minification aliasing is the expected result at any viewing
distance. This is a **pipeline-wide issue** (affects every map using this
tile-extraction path, not just this one — existing maps likely mask it with
higher-frequency painted textures that alias less visibly than solid flat
color blocks do), not something to fix inside a map-authoring task; flagged
here and forked to its own lane rather than patched under this task's diff.
The generator already computes real mip1-3 data per tile
(`solid_tile_record`) — the fix is entirely on the extraction/KTX2-packing
side.

## 7. Verifying a map end-to-end

1. `python3 tools/mapgen/<id>.py` — check the E1 self-check prints all-OK;
   iterate `ELEVATION`/`MARGIN_OVERRIDE` per §2 until it does.
2. `./build/debug/tools/mapconverter/mapconverter --force content/maps/<id>`
   — confirms the C++ pipeline (including `ExtractRegions`) agrees.
3. Direct-start it for real: launch an isolated `spring-lobby`
   (`--dev-direct-start`, a fresh port) + client (`GAME_SERVER_PORT=<port>
   npx vite dev`), POST `manifests/<id>_direct.json` to
   `/api/rooms/direct`, `attachSession`+`setCurrentRoomFromJson` in the
   browser, and watch `data/logs/game-<id>.log` for `[game_scenario]
   staged "<name>"` with no Lua tracebacks in between. This is the only way
   to catch scenario-file bugs (unknown unit defs, bad CMD names, region-key
   typos) — static Lua parsing and the E1 validator don't exercise
   `game_scenario.lua`'s `validate()`/staging path at all.
4. Kill zombie `spring-server` processes on whatever port you used before
   relaunching (`lsof -i :<port>`) — a stale process from an earlier attempt
   silently breaks the next one's WebTransport bind and crashes it.
5. `window.test.cameraFitMap()` for the strategic-zoom golden,
   `window.test.cameraSnapToGround(x, z, {height, pitchDeg})` for the
   gameplay-zoom golden, `window.test.screenshot()` (not chrome-devtools'
   own `take_screenshot` — it can't see the WebGL2 canvas,
   `preserveDrawingBuffer:false`) for the capture itself.
