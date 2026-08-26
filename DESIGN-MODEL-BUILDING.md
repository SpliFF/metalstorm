# DESIGN-MODEL-BUILDING.md — Authoring native models for springrts-web

Final write-up of the Fable model-PoC session (2026-07-11), which designed,
built, textured, validated and shipped `fable_tank` (FV-9 "Vanguard") into
`data/games/metalstorm/models/` from a clean context. Everything here was
read out of the tree or discovered by building — sources cited per section
so future sessions can re-verify quickly. Companion artifacts: the complete
reproducible pipeline in `tools/fable-model-forge/` and the iteration
screenshots in `tools/fable-model-forge/shots/` (v1 blockout → v6 shipped).

---

## Part I — The engine contract

### 1. Where models live, what the engine actually reads

- Metalstorm native/baseline models: `data/games/metalstorm/models/<stem>.gltf`
  + `<stem>.bin` + sibling `.ktx2` textures (the wz_* set and now fable_tank).
  ZK conversions: `data/games/zk/models/` — same shape plus a `manifest.json`.
- **The server reads `<basePath>.gltf` (JSON glTF), not `.glb`** —
  `rts/Sim/Objects/ModelConfigLoader.cpp` does `basePath + ".gltf"` and parses
  with nlohmann. (objects3d/README.md describes an authored-`.glb` future
  pipeline, but everything actually shipping in `models/` today is `.gltf` +
  external `.bin`.)
- Client model URL comes from `rts/Server/LuaDefsSerializer.cpp`:
  `/api/games/data/<gameId>/models/<objectname-stem>.gltf`. Texture URIs
  resolve as sibling files relative to the `.gltf`. Never use `..` in URIs
  (Babylon rejects them); never append `?v=` to a model URL (breaks sibling
  resolution — HTTP caching rides on Last-Modified/ETag instead).
- `manifest.json` (`{"version":1,"files":[...]}`) is **optional** — it only
  gates speculative sidecar fetches like `.config.lua`
  (`client/src/core/dir-manifest.ts`); a missing manifest just logs a warning.
  Metalstorm's models/ ships none.

### 2. SPRINGRTS_geometry — embedded engine metadata (no sidecars)

Document-level glTF extension; the old `.meta.lua`/`.config.json` sidecars are
retired (objects3d/README.md). `ModelConfigLoader::LoadInto` reads:

- `configVersion` — **must be ≥ 8**; older is refused, newer logs a notice.
- `radius`, `height`, `midpos`, `mins`, `maxs` — model-space bounds. Verified
  derivations (they reproduce wz_tank's numbers exactly):
  - `height = max Y` over all pieces including offsets;
  - `midpos = [(minx+maxx)/2, height/2, (minz+maxz)/2]`;
  - `radius = |maxs − midpos|` (distance to the bounds corner).
- `pieces[]`: `{name, parent, offset, mins, maxs, rot?}` where
  - `parent` = 0-based index into this same array, `-1` = root;
  - `offset` = translation **relative to the parent piece's frame**;
  - `mins`/`maxs` = **piece-local** mesh AABB (zeros for empty pieces);
  - `rot` (optional, G5b 2026-07-10) = row-major 3×3 rest rotation applied
    between translation and script turns. **Avoid needing it**: bake geometry
    so every piece's rest rotation is identity — it dodges the whole
    rotated-parent-frame class of bug (the BeamLaser muzzle regression).

### 3. glTF document structure (the exact recipe that loads everywhere)

- Node tree: importer-prefixed root (`PIE_wz_tank`, `S3O_corraid.s3o`,
  `MS_fable_tank`) → first piece (`body`) → children. **Node names must equal
  piece names** — the client correlates Babylon nodes to
  `SPRINGRTS_geometry.pieces` by name; the piece-transform stream (envelope
  `0x05`) and the clip player retarget by the same names.
- **Mesh vertices are authored in the piece's local frame**; the node carries
  the offset. Emit a full column-major `matrix` with the translation in
  elements 12–14 (what modelimporter emits; omit for identity).
- One mesh per piece; primitives use POSITION / NORMAL / TEXCOORD_0 (+ u32
  indices, componentType 5125). Separate bufferView per accessor, each
  4-byte aligned in one `.bin`. **POSITION accessors need `min`/`max`**
  (glTF spec; Babylon tolerates their absence, the validator doesn't).
- Empty attachment pieces (`muzzle`, `exhaust`, ZK's `firepoint`) are
  mesh-less named nodes with a translation.
- Textures via `KHR_texture_basisu`: each texture is
  `{sampler: 0, extensions: {KHR_texture_basisu: {source: i}}}`, images are
  `{mimeType: "image/ktx2", uri: "<stem>_<kind>.ktx2"}`.
  `extensionsUsed = [KHR_texture_basisu, SPRINGRTS_geometry,
  SPRINGRTS_team_color]`, `extensionsRequired = [KHR_texture_basisu]` only —
  keeping SPRINGRTS_* out of `extensionsRequired` lets vanilla loaders
  (three.js, gltf-validator) open the file.
- A parallel PNG-URI variant (same `.bin`) is handy for local preview
  iteration; it must drop `extensionsRequired` entirely.

### 4. Orientation, scale, ground

- **Forward = −Z, up = +Y, left = +X** (RH / Babylon basis). Verified
  empirically: corraid's barrel/firepoint extend −Z and its `lwheel*` sit at
  +X; wz_tank's muzzle offsets are −Z of the turret.
- **1 glTF unit = 1 metre.** `PIEImporter.cpp:363` scales assemblies so
  `target_metres` equals the dominant extent in glTF units (wz_tank = 8.5).
- Ground plane at Y = 0.
- Class-scale table (art/STYLE.md): tanks by length — s1 4.5 m, s2 8.5 m,
  s3 12 m, s4 26 m. Footprint metres = footprintx × 2; overhang is fine.
  That rule encodes the metre→elmo constant: `SPRING_FOOTPRINT_SCALE = 2` and
  `SQUARE_SIZE = 8` make one `footprintx` unit **16 elmos**, so 16 elmos = 2 m
  ⇒ **8 elmos = 1 metre**. The constant is **applied at the write site**
  (§12, decided 2026-08-27): authoring stays 1 unit = 1 m, and the forge's
  `gltf_export.py` (`ELMOS_PER_METRE`, default `units='m'`) — or
  `modelimporter --metres` for foreign metre-authored sources
  (`GeometryExtractor.h kElmosPerMetre`) — converts geometry, piece offsets,
  translation animation channels and every `SPRINGRTS_geometry` extent to
  **elmos** on export. Emitted files carry `units: "elmos"`. Elmo-authored
  sources (S3O/BAR, the map-feature corpus) pass through unscaled
  (`units='elmo'` / no flag).

### 5. Piece naming — the turret-rotation contract

- Convention set (objects3d/README.md): `turret`, `barrel`, `tracks`,
  `muzzle`, `exhaust`. wz_tank: body → tracks_l/tracks_r/turret → muzzle.
  ZK: base → body → turret → sleeve → barrel → firepoint.
- **Turret yaw happens sim-side** (PLAN-playable G5, live-verified
  2026-07-10): the unit script turns the piece, the server streams piece
  transforms, the client applies them. A piece rotates about **its own node
  origin** — model the turret with its pivot at the ring centre, the barrel
  with its pivot at the trunnion, and put the empty `muzzle` at the bore tip.
- Scriptless units (NullUnitScript — every current Metalstorm def):
  `QueryWeapon`/`AimFromWeapon` return −1 → the weapon fires from unit centre
  (Weapon.cpp logs "unbound muzzle/aim piece"; a ground-clearance guard keeps
  beams above terrain). Sim-side aiming for scriptless natives is Track-G
  work — **the model contract above is stable regardless**, and the
  model-viewer's `aim` showcase (Spring.SetUnitTarget + far-future
  reloadState) is the visual test once a script/gadget lands.

### 6. Materials & textures

- **The client's canonical texture set comes from `materials[0]`**
  (`entity-renderer.ts fetchModelConfig`): `baseColorTexture` → diffuse,
  `emissiveTexture`, `metallicRoughnessTexture` → ORM (point
  `occlusionTexture` at the same image), optional `normalTexture`, and
  `extensions.SPRINGRTS_team_color.maskTexture` (+ `invertMask`) → team mask.
  Multi-material works (keyed by material *name*) but single-material is the
  native convention.
- Team colour: **R channel** of the mask; shader does
  `mix(base.rgb, teamColor, mask)` — at mask = 1 the diffuse is fully
  replaced, so decals meant to survive team paint are *holes* in the mask,
  not diffuse art. Never bake team colour into diffuse (STYLE.md).
- ORM channels: R = AO, G = roughness, B = metallic;
  `metallicFactor`/`roughnessFactor` stay 1.0 and the texture modulates.
- KTX2 (UASTC + Zstd + mips) with sRGB transfer on diffuse/emissive and
  linear on ORM/team — this reproduces the repo's historical toktx flags
  (`--encode uastc --zcmp 19 --genmipmap --assign_oetf srgb|linear`).
- Naming: `<stem>_diffuse.ktx2`, `<stem>_orm.ktx2`, `<stem>_emissive.ktx2`,
  `<stem>_team.ktx2` (ZK convention, adopted for fable_tank).
- Validation gate (`client/src/core/model-validate.ts`, used by
  `tools/scripts/validate_model.mjs`): tri budget; required piece names
  (case-insensitive node check); **team mask on materials[0]**; clip names ∈
  {walk, idle, death}; SPRINGRTS_geometry present + listed in extensionsUsed.
  Budgets (art/STYLE.md): vehicles ≤ 2 000 tris, infantry ≤ 800, s4 ≤ 8 000.

### 7. Art style constraints (art/STYLE.md, binding)

Silhouette-first flat-shaded low-poly; no baked lighting/grime gradients;
every hard edge gets a small bevel (~2–4 % of the piece's smallest
dimension) or none at all; greebles functional-only and ≥ 0.3 m; kinetic
sci-fi (exposed mechanical gun forms; emissive allowed as *energy plumbing*,
not beam weaponry). The shared palette atlas exists for pipeline-normalised
models; hand-authored showcase textures may be richer (the wz baseline uses
real WZ texture pages).

### 8. Wiring a def so the harness can spawn it

- Every `units/*.lua` returning `{ defname = {…} }` is auto-loaded
  (`cont/base/springcontent/gamedata/unitdefs.lua`, RecursiveFileSearch) —
  underscore-prefixed files included. (`_builder.lua` returns a *function*,
  which triggers the pre-existing harmless "Bad return table" log line.)
- Def → model via `objectname = '<stem>'`. Defs whose model isn't under
  objects3d/ log a NOTICE and are **kept** (spring-web fork behaviour) —
  that NOTICE doubles as proof your def loaded.
- Showcase-def pattern (`units/_wz_baseline.lua`, `units/fable_tank.lua`):
  `customparams.squad_size = '1'` so the harness frames one model; one real
  weapon from `weapons/weapons.lua`. Weapon names like `MS_RAILGUN_S2` are
  *constructed* by the `family()` helper — grep for the prefix, not the name.
- Harness: `?scenario=model-viewer&game=metalstorm&def=<defname>`
  (+ `&capture=turntable|clips|sun&views=N`). Every asset needs an ASSETS.md
  row **before** landing; generated assets use `Generated (…)` and record
  generator + prompt/seed in Modifications.

---

## Part II — The build pipeline that worked (sandboxed, no toktx)

### 9. Toolchain

| Stage | Tool | Notes |
|---|---|---|
| Geometry + glTF | hand-rolled Python/numpy (`gen.py`, `meshlib.py`) | no exporter dependency; emits .gltf+.bin directly |
| Textures | PIL (`paint.py`) | 4 maps painted in lockstep |
| KTX2 encode | `babylonpress-ktx2-encoder` (npm) + pngjs | Basis Universal WASM; works where KTX-Software/basisu binaries are unobtainable |
| Visual verify | three.js GLTFLoader + KTX2Loader under Playwright Chromium | transcoder ships inside the three package |
| Engine checks | reimplementation of model-validate.ts checks | plus piece/parent + bounds sanity |

Encoder option mapping (== the repo's toktx usage):
`isUASTC:true, generateMipmap:true, needSupercompression:true` (Zstd),
`isPerceptual` + `isSetKTX2SRGBTransferFunc` true for diffuse/emissive and
false for ORM/team, `uastcLDRQualityLevel:2, enableRDO:true`. Node requires
an `imageDecoder` callback (pngjs). Result sizes at 1024²: diffuse ~98 KiB,
ORM ~60 KiB, emissive ~9 KiB, team ~6 KiB.

Preview rig specifics:
- Serve the work dir with `python3 -m http.server` (it dies with its shell —
  restart before re-shooting) and load three via an importmap pointing into
  `node_modules`; `KTX2Loader.setTranscoderPath()` at
  `three/examples/jsm/libs/basis/`.
- Playwright must launch the **pre-installed** browser:
  `chromium.launch({executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-angle=swiftshader']})` — the npm playwright's own browser
  revision is not downloadable in the sandbox.
- The page sets `window.__done`/`__error`/`__stats`; the shooter awaits
  `__done`. Standard shot list: front-3q, rear-3q, side, front, top, close,
  **and a `yaw=55&pitch=-10` shot** — the single most valuable frame, since
  it proves both pivots rotate about the right origins.
- Render the PNG-URI variant while iterating on look, then re-shoot the real
  KTX2 `.gltf` once before shipping (verifies the KHR_texture_basisu path).

### 10. Geometry construction kit (winding + primitive rules)

Flat-shaded triangle soup: duplicate vertices per face, one Newell normal
per polygon — this *is* the low-poly style and sidesteps smoothing groups.
glTF front faces are **CCW**; the rules that kept windings honest:

- Polygon fan in a plane: CCW order in (x,y) → normal +Z; CCW in (y,z) → +X;
  CCW in (x,z) → **−Y** (mind this one). Check profile polygons with the
  shoelace signed area instead of eyeballing (the track-pod side faces were
  CCW in (z,y) → normal −X → both sides culled invisible in v1).
- Ring/loft quads: pick one ordering, then verify the first render with
  backface culling ON — a DoubleSide diff render localises every bad face.
- Convex parts can self-heal: orient each face by
  `dot(normal, centroid_face − centroid_part) > 0` (used for track wrap and
  hub/drum tubes).
- `mirror_x` for the second track: negate X in positions *and normals*, and
  reverse triangle winding.
- Primitive costs (8-gon everywhere): chamfered box ≈ 44 tris (6 inset faces,
  12 edge bevels, 8 corner tris — bevel rule satisfied by construction);
  extruded 8-pt profile ≈ 28 + caps; 8-gon tube ≈ 16/segment + 6/cap;
  8-vert loft ring pair ≈ 16. fable_tank totals: body 344, tracks 158×2,
  turret 272, barrel 280 = **1 212 tris** — comfortable inside the 2 000
  vehicle budget with ~35 % headroom for a richer variant.
- Loft cross-section scheme that reads "armoured vehicle": 8-vert rings
  parameterised as (y_bottom, y_waist, y_shoulder, y_deck) × half-widths
  (w_bottom, w_waist, w_deck, w_top) — five or six stations give a chiselled
  hull/turret with zero hand-modelling.
- Embed, don't kiss: pieces resting on other pieces (turret on deck, mantlet
  into turret nose) should sink ~5 cm into the parent surface. Coplanar or
  1–4 cm gaps read as floating at render time.
- Pivots first: fix `turret`/`barrel`/`muzzle` origins before hanging
  geometry; never recentre a piece for artistic convenience (see §5).

### 11. UV zones + painter architecture

One shared table (`layout.py`) is the single source of truth for **both**
the mesh generator and the painter:

- A `Zone` = atlas pixel rect + two world axes + a world window; faces are
  planar-projected into it. Loft faces auto-classify by flat normal
  (`n.y < −0.5` → dark underside; `|n.x| > 0.62` → side; `n.z < −0.55` →
  front; `n.z > 0.55` → rear; else top). Parametric UVs only where planar
  projection fails: track wrap by arc-length, gun tube / drums / hubs by
  (station, facet) — for an 8-gon with phase π/8, facet j spans v-band
  [j/8,(j+1)/8] and the ±X facets are bands 7 and 3 (where the rail glow
  lives).
- Greebles get dedicated detail cells (hatch, intake, exhaust, sensor, pod,
  sight, bustle, smoke, breech, brake, hub, fender) — painted once, sampled
  by every instance; deck paint never smears across them.
- The painter draws **all four maps in lockstep** — every helper (panel
  seam, bolt, vent slot, wear chip) writes diffuse + AO/rough/metal together,
  optionally emissive — otherwise the ORM drifts out of sync with the art.
  Deterministic RNG seed so rebuilds are reproducible.
- Values that worked (linear 0-255): AO base 232 / seams 150 / recesses 95;
  roughness: armour 168, steel 128, rubber/track 205, glass 60; metallic:
  armour paint 28, bare steel/rails 195-215, track metal 170, glass 0.
- Hard-won texture lessons:
  - **Anisotropic zones bite** — a zone can have 4× different m/px on u vs v
    (hull top: 3.5 m/512 px vs 9.1 m/232 px). Map *each radius of anything
    circular* through its own axis scale or it smears across the deck (the
    v4 turret-ring bug).
  - **Shared L/R zones mirror decals** — text on a zone sampled by both ±X
    faces reads backwards on one side. Numerals go on single-projection
    zones (roof, rear); shared side zones get symmetric emblems (chevrons).
  - **Roof numerals orient for the player camera**: with v-down = +z (rear),
    normally-drawn text reads correctly from behind the tank — the RTS
    default view. Don't "fix" it.
  - Degenerate projections are a feature: a face whose verts collapse to one
    v-row samples a single texel row — used deliberately to give the rail
    blades' top/bottom edges a pure cyan emissive strip.
  - Blur the emissive map ~0.6 px before encode so glow edges survive mips.
  - Team-mask decals: cut the numeral *out of the mask* so the base diffuse
    shows through the team panel (survives any team colour).
  - Fonts in this sandbox: DejaVuSansCondensed-Bold is the best stencil
    stand-in; add manual bridge cuts for the military-stencil look.
- **Weathering system** (`weathering.py`, added 2026-07-11 — "gritty and
  realistic" pass, applied to both shipped units): runs AFTER base zone
  painting, deposits four layers where physics puts them, and keeps all
  four maps consistent. (1) *Crevice grime* is auto-detected — any pixel
  darker than its blurred neighbourhood (seams, slots, vents) collects a
  soft halo; zero per-seam bookkeeping. (2) *Mud* is height-graded per
  zone (heavy at rect-bottom for zones whose v maps world height, or along
  the limb-wrap u toward the foot) with noise-broken edges + spatter — the
  strengths are art-directed per zone (running gear/feet ≈ 0.85–1.0, hull
  sides ≈ 0.55–0.75, roofs ≈ 0.15 dust film). (3) *Rust* goes where water
  sits: the `bolts()` helper logs every bolt position and a subset grows
  rust rings with gravity streaks — streaks only inside zones where
  image-down == world-down (`vertical_rects_of(layout)`); plus blotch
  lines along plate bottom edges (aim them at the VISIBLE plate edge —
  the first attempt put them at the zone bottom, which was the hidden
  wheel well). (4) *Oil* on joints is SHINY (roughness down), unlike
  everything else; *soot* at muzzles/exhausts also dims emissive beneath.
  Map consistency rules: dirt/rust/soot raise roughness, kill metallic,
  darken AO, and **punch holes in the team mask** — otherwise
  `mix(base, teamColor, mask)` paints pristine team colour over the dirt.
  Value contrast matters more than hue: on dark armor, mud must be
  several stops lighter (dusty tan) or it vanishes.
- **Bump/normal maps** (`normals.py`, same session): author a HEIGHT map in
  atlas space, Sobel it into a tangent-space normal map (OpenGL green;
  `G_SIGN` constant to flip if a renderer disagrees), encode linear with the
  encoder's `isNormalMap` flag (UASTC normal maps are the biggest textures
  in the set — ~2-4× diffuse). Structure: explicit heights for the reads
  that matter (recessed wheel wells with road wheels standing proud,
  DISCRETE track links with gap grooves + raised grousers, tread-plate
  diamonds, joint gasket ribs, sole tread blocks) + automatic detail
  derived from the other maps — painted seams/slots become grooves
  (same darker-than-neighbourhood trick as grime), logged bolts become
  domes, mud becomes lumps, rust becomes pitting. Keep it soft (strength
  ~2.4 at 1024²): the engine comment targets "soft normal maps on
  low-poly RTS units", and the flat-shaded style carries the big forms —
  the normal map only carries surface story. Findings from the in-engine
  debugging round (2026-07-11, verified with temp shader probes):
  - **The engine shader samples ORM `.gb` only** — the AO channel is
    preview-rig-only today. Darkness that matters in-game must be painted
    into the DIFFUSE.
  - **The deep-void cheat** (wheel wells, any "empty space" between
    running gear): near-black diffuse (~12,12,14) + dead reflectance in
    the gaps, redraw the wheels on top so only they catch light, and give
    the height map a cliff-deep recess (−3.2 vs +0.5 wheels) so the
    boundary normals go near-silhouette. Normal map sells the rims,
    diffuse sells the depth. Mud passes must not repaint the void —
    re-void after weathering.
  - **Lighting compresses normal detail hard**: the default half-Lambert
    maps N·L to [0.5..1] × 0.55 sun weight over a 0.45 ambient floor, so
    a "correct-looking" bake moves final brightness only a few percent.
    Bake strengths ~5.0 (hard-surface) survive it; 2.4 vanishes. The
    debug method that settled it: temp fragment-shader override rendering
    (a) `N*0.5+0.5` post-perturbation, then (b) the raw normal texel —
    (a) shows whether perturbation runs, (b) whether decode is linear
    (flat armour must be lavender 0.5/0.5/1, dark blue = sRGB decode bug).
    Advisory for the code session: applying the bump before half-Lambert
    compression (or widening the sun term) would let subtler bakes read.

### 12. World scale — DECIDED 2026-08-27: 8 elmos = 1 metre, applied at import

**The contract (PLAN-world-scale.md §5, Option A, USER-DECIDED
2026-08-27):** authoring stays **1 glTF unit = 1 metre** (§4 — that half
was never in doubt); the **write site converts to elmos** so the sim and
renderer only ever see elmos. Executed 2026-08-27:

- **The constant is 8 elmos = 1 m** — from §4's footprint rule via
  `SPRING_FOOTPRINT_SCALE = 2` × `SQUARE_SIZE = 8`, corroborated by the
  buildings (`ms_habitat` 24 m footprint vs 25.5 m model), the elmo-native
  feature corpus (`tree_conifer` 104.62 = 13.1 m) and the gameplay tables
  (PLAN-world-scale.md §2). It is named at every write site:
  `ELMOS_PER_METRE` in `tools/fable-model-forge/gltf_export.py` (forge
  exports scale unless called with `units='elmo'`), `kElmosPerMetre` in
  `tools/modelimporter/GeometryExtractor.h` (applied by
  `modelimporter --metres`), and `ELMOS_TO_METERS` in
  `Sim/Misc/GlobalConstants.h` is its documented inverse.
- **The shipped corpus was re-scaled ×8 in place** (all 110 unit/building
  models: vertices, node translations, animation translation channels and
  every `SPRINGRTS_geometry` extent) by
  `tools/scripts/rescale_models_to_elmos.py` — exact in float32 (×8 only
  shifts the exponent) and idempotent via the `units: "elmos"` marker every
  converted file now carries. The **71-model map-feature corpus is
  untouched** (already elmos — a blanket scale over it is a defect).
- **The scale is sim-real, not render-only**: `ModelConfigLoader.cpp` feeds
  model `radius`/`height` into the def and `Unit.cpp` builds the collision
  and selection volumes from them — which is exactly why it landed at
  import, never in `entity-renderer.ts`.
- **The impostor constants moved with it** (all four infantry classes:
  `impostor_size`/`impostor_centre_y`/`impostor_distance` ×8 — the sheets
  themselves are unchanged since the baker frames on the model bbox, and
  distance ×8 preserves the subtended angle, keeping the ≲20 px swap rule).
- **Checked, not eyeballed**: `tools/scripts/check_model_scale.py` asserts
  units ×8 against the pre-scale baseline
  (`world_scale_baseline.json`), features ×1, bin-geometry⇄metadata
  agreement, and the impostor swap/framing rules. Run it after any corpus
  or def-scale change.

Still open after the decision: the by-eye constants tuned against the old
scale (squad formation spacing, LOD ladders, camera/zoom limits) and the
live browser A/B verify on the player path (PLAN-world-scale.md §6 step 4).

---

## Part III — Designing the model itself

### 13. How the design was derived (method, reusable)

**Anchor on the game's own tables first, invent second.**
1. *Class + scale*: STYLE.md's class-scale table fixes the dominant dimension
   before aesthetics (tank s2 = 8.5 m, s3 = 12 m). fable_tank pitched at
   ~9.9 m — deliberately a half-class above the wz_tank it's judged against,
   so it reads "heavier" side by side without leaving the MBT family.
2. *Faction/tech flavour*: "kinetic sci-fi — explosive/projectile weapons
   dominate" (PLAN-metalstorm §6) → a railgun with visible rails, capacitor
   ring and muzzle brake, not a smooth laser tube; emissive restricted to
   energy plumbing (rails, capacitors, sensors, exhaust heat).
3. *The engine contract dictates the skeleton before art does*: pieces and
   pivots (§5) are gameplay requirements — model the origins first.

**Silhouette-first blocking order** (STYLE.md is right): hull loft → track
pods (the extruded side profile IS the track silhouette; road wheels are
painted, not modelled — saves ~500 tris) → turret wedge → barrel assembly.
Greebles only after the flat-colour three-quarter render already reads as
"futuristic MBT". Parametrise everything in one constants file so critique
rounds are number edits, not remodelling.

**Greeble policy** (functional-only, ≥ 0.3 m): every greeble must be
nameable — hatches, glacis sensor bar, engine intake, exhaust housings,
commander sight, sensor pod, smoke launchers, bustle rack, sprocket/idler
hubs. Antennas failed the 0.3 m rule → painted mounting bosses instead.

**The critique loop is the quality mechanism.** Render turntables headlessly
and *look at them*, every round: v1 blockout with a zone-tinted UV checker
(caught: miswound track sides, floating fenders, nose droop, turret float);
v2–v3 geometry fixes; v4 first paint (caught: smeared turret ring, mirrored
numeral, blocky heat tint, too-dark palette); v5–v6 texture fixes. Six
rounds from blockout to shipped; budget for that, not for one-shot output.

### 14. Runbook — adding the next native model

1. Read §1–§8. Pick class + scale from STYLE.md; sketch piece tree + pivots.
2. Copy `tools/fable-model-forge/`; rewrite `layout.py` (dimensions + zones)
   and the part builders in `gen.py`. Keep meshlib/preview/encode as-is.
3. `python3 gen.py` → blockout with the debug UV-checker; shoot turntables;
   fix winding/silhouette until clean (expect 2–3 rounds).
4. Write the painter zone by zone; repaint + reshoot until it reads (2–3
   rounds). Then `node encode.mjs`; reshoot once against the KTX2 `.gltf`.
5. Run the §6 validation checks (script in forge README).
6. Ship: model files → `models/`; def → `units/<stem>.lua` (squad_size '1'
   for showcase); ASSETS.md rows FIRST (`Generated (…)` + generator/prompt);
   restart game rooms (§15); test in the model-viewer with `&def=<stem>`.
7. For animated models: clips must be named `walk`/`idle`/`death` only.

### 15. Troubleshooting

- **"spawn parse failed … spawned 0 unit(s)" for a new def**: the sim parses
  `units/*.lua` once, at room boot, and the model-viewer client happily
  *reconnects to an existing room* (game-NN.log shows
  `client N reconnected as 'test1'`). A def added after that room booted
  doesn't exist in it. Diagnose: grep the newest `data/logs/game-*.log` for
  the def name — a loaded native def always leaves the "no model file under
  objects3d/ … keeping the def" NOTICE. Fix:
  `tools/scripts/spring-services.sh stop server` (lobby + client stay up),
  reload the scenario URL; the fresh room re-scans units/.
- Def cache is *not* the culprit in dev: the lobby runs `--no-cache`, and
  the cache (`cache/defs/<xxh3 of schema+gameId+version+modoptions>`) is
  written *after* sim.Init parses defs — it serves the wire, not the sim.
- `Bad return table from: units/_builder.lua` — pre-existing, harmless (it
  returns the builder function; the def loader tries it as a def file).
- Model loads as "fallback-model" badge: check the browser console for the
  `.gltf` fetch, then texture 404s (URIs are sibling-relative), then
  `extensionsRequired` (only KHR_texture_basisu belongs there).
- Preview rig: blank shots usually mean the `http.server` died with its
  shell — restart it; `playwright install` errors mean the launch isn't
  using `executablePath: '/opt/pw-browsers/chromium'`.

---

## 16. Authoring animation clips (learned building fable_mech)

**The client contract** (`client/src/core/clip-player.ts`): clips are glTF
`animations` extracted from Babylon AnimationGroups and retargeted onto
pieces **by node** — only channels targeting piece nodes survive; paths
`translation` / `rotation` (quaternion) / `scale`, LINEAR interpolation.
There is **no vertex skinning** — rigid FK piece animation is the native
format, so rig walkers as articulated pieces (thigh/shin/foot nodes), not
skinned meshes. Unanimated properties of an animated piece fall back to its
rest TRS; untouched pieces keep rest pose. One clip plays at a time (harness
button / `h.playClip`); non-looping clips hold their final frame — design
`death` to end in a settled wreck pose. **Live-verified 2026-07-11**: clip
buttons play correctly in the model-viewer, and walk is NOT triggered by
movement — the ClipPlayer exists only behind the dev/test `playClip` verb
(`game-processor.ts` ~310); nothing links entity motion to clips. ZK
walkers animate on move via a different path entirely (sim-side unit-script
piece turns → 0x05 stream). Bridging spec: §16b.

Hard rules discovered:
- **Animated nodes must use TRS, not `matrix`** (glTF spec). The exporter
  now always emits `translation` — and translation channels are ABSOLUTE
  node translations (rest offset + delta), not deltas.
- Clip names exactly `walk` / `idle` / `death` (validator).
- Looping wraps in `[from, to)` — duplicate the first key at the end for a
  seamless loop.
- Animation-data bufferViews carry **no `target`**; time accessors need
  min/max. Verify in three.js (AnimationMixer + `setTime`) via the preview
  rig's `&clip=<name>&t=<sec>` params — pose screenshots ARE the review.

**Walk-cycle doctrine that worked** (standard references: Rusty Animator /
AnimSchool key-pose method): 4 poses per half-cycle — contact, down
(body lowest), passing, up (body highest) — mirrored for the second half;
keys every 12.5 % of the cycle; double body-bob per cycle; torso
counter-yaw ±4°; gun counter-pitch ±2°. For the reverse-joint leg: thigh
swings ±27°, the shin's *positive* fold during recovery gives the
characteristic chicken-walker knee-back silhouette, and the foot channel is
computed, not hand-keyed: `foot = −(thigh + shin) × 0.75`, clamped ±25° —
keeps soles near-level and kills most FK foot-slide at RTS zoom. Right leg
= left tables phase-shifted half a cycle (loop-aware modular shift).
1.2 s cycle reads "military walker"; 3.6 s idle (breathing bob + sensor
scan); 1.8 s death designed as a *deliberate backward sit-down collapse* —
first attempt mixed forward legs with backward torso and read as ragdoll
noise; committing every channel to one fall direction fixed it.

**Mech-specific modelling lessons**: pivots are the joints — hip/knee/ankle
node origins define the rig, geometry hangs off them with identity rest
rotations (the `limb()` primitive bakes the slant into vertices). Torso
named `turret` + gun named `barrel` keeps walkers compatible with the same
sim-side aim path as vehicles. Embed the torso ~7 cm into the pelvis
(the float-gap tell again). Proportion trap: a torso narrower than the
pelvis reads pear-shaped — widen shoulders past hips, and move shoulder
mounts outboard when you widen the chest, or the gun embeds.

## 16b. Spec — movement-driven clip playback ("task 6b", for the code session)

Goal: natives with authored clips animate in-world — walk while moving,
idle when stopped — without touching the sim (pure client cosmetics, same
philosophy as squad fan-out). ~150–250 LOC + tests.

1. **ClipPlayer → multi-unit** (`client/src/core/clip-player.ts`): replace
   the single `active` slot with `Map<unitId, Playback>`. `play(unitId, …)`
   replaces that unit's entry; `stop(unitId?)` (no arg = clear all, keeps
   harness semantics); `tick()` iterates; `state(unitId?)`. `sampleClipPose`
   is pure and the sink (`EntityRenderer.setClipPose`) is already per-unit
   and already auto-stops on unit disappearance — the extension is
   mechanical. Keep the play/stop API shape: fx-offload replaces internals,
   not callers.
2. **Auto policy** (in `game-processor.ts`, alongside the existing entity
   update handling + the `gpClipPlayer?.tick()` call ~1423): for entities
   whose template ships a `walk` clip —
   - Planar speed from consecutive *wire* entity states (not camera-lerped
     positions). Hysteresis: start walk above ~0.5 elmos/s sustained 2
     ticks; drop to `idle` (if present, else rest pose) below ~0.2 for
     ~300 ms. Turn-in-place: also trigger on heading rate if heading is in
     the wire state (verify; skip in v1 if not).
   - Playback `speed` = clamp(unitSpeed / nominalSpeed, 0.6, 1.6) — the
     `ClipPlayOpts.speed` knob exists. nominalSpeed is one modeled stride
     (~1.1 m for fable_mech) per cycle (1.2 s), converted per the
     world-scale convention (§12, decided: ×8 — 8.8 elmos per 1.2 s cycle)
     (or `customparams.walk_speed_ref`).
   - Manual override: a unit driven by the harness `playClip` verb is
     flagged; the auto policy skips it until `stopClip` — F8 buttons keep
     working on stationary units.
   - Precedence note (assert in a comment): clip pose overrides streamed
     piece state; natives have no piece stream and ZK has no clips, so no
     conflict in practice today.
   - Perf guard: cap concurrent auto playbacks (e.g. 64, nearest-first).
     When squad fan-out lands, offset each member's clip phase by member
     index so squads don't march in lockstep.
3. **Death clip**: only wire once the client receives an explicit
   unit-death event distinct from LOS eviction, and only if a corpse
   entity persists long enough to show it — today the synced entity
   despawns and the wreck feature replaces it, so `death` stays
   button/showcase-facing. Revisit with damage-states work.
4. **Tests**: extend `clip-player.test.ts` for multi-unit; new policy test
   with synthetic position streams (start/stop hysteresis, speed scaling,
   manual-override skip). Harness verification: fable_mech `circuit` →
   legs cycle while driving, settle to idle at the stop; `aim` unaffected;
   wz_tank (clipless) unaffected; zk cloakraid unchanged (server path).

## 16c. Spec — client-side cosmetic turret aim (for the code session)

Diagnosis (live-confirmed 2026-07-11): metalstorm natives never rotate
turrets because piece rotation in Spring/Recoil is a UNIT-SCRIPT concern —
the sim aims weapons internally (`turret=true` weapondefs, range/arc
checks pass, firing works from unit centre via the ground-clearance
guard), but with NullUnitScript no piece ever turns and nothing enters the
0x05 stream. ZK turrets turn because their LUS scripts run sim-side.
Architecture decision (matches the squad philosophy): regular units get
CLIENT-SIDE cosmetic aim; only very large units (s4, `multi_piece='1'`,
where hit geometry matters) should ever get real sim-side aiming later.

**v1 — fire-reactive tracking, zero new wire.** The projectile Fired
event already carries `ownerId`, `pos`, `vel`, `targetPos`, `targetId`
(`rts/Server/ProjectileEventCollector.h`). Client-side controller per
unit whose template has a `turret` piece:
- On Fired with ownerId == unit: enter engaged(targetId | targetPos).
- While engaged: desired turret yaw = bearing(targetPos − unitPos) −
  unitHeading (target entity position refreshed from the entity table
  while in LOS; else last targetPos). Slew at a capped rate (~90–180°/s,
  or derive from def turnrate); optional barrel pitch from elevation.
- Disengage after ~4 s without Fired events → slew back to rest.
- Output: turret/barrel local rotations through the SAME per-piece pose
  override path as the clip player (task 6b's multi-unit composer).
  Merge policy: legs/body channels from clips, turret/barrel from the
  aim controller; **streamed 0x05 piece state wins over both** — that
  precedence automatically accommodates ZK and any future s4 sim-side
  aiming without special cases.
- The first shot still leaves the unit centre sim-side (unchanged
  gameplay); weapon-fx muzzle flashes can anchor to the client-computed
  muzzle piece position for coherence.

**v2 — optional engine ask, only if pre-fire tracking matters**: stream a
quantized aim heading (1 byte) or targetId in entity state for units with
an active weapon target, so turrets track before the first shot and
during reload lulls. Defer until v1 is judged in the harness `aim` /
`volley` showcases (note: the harness `aim` showcase blocks firing via
far-future reloadState, so **v1 will not slew during `aim`** — judge v1
with `volley`/`sustained`; `aim` only lights up with v2).

### 16c-i. Authoring rule — muzzle piece rest orientation

**A muzzle piece's rest orientation must leave its local −Z horizontal, and
pointing the way the barrel it hangs off visually points.**

Why it matters: for a scriptless metalstorm native, `CWeapon` binds the
muzzle by name convention (`muzzle`, `muzzle2`, …) and reads the emit
direction straight off the piece — it is the piece's local **−Z**
(glTF-native forward) pushed through the accumulated model-space transform
(`LocalModelPiece::GetEmitDirPos`), then rotated into the unit's frame by
`CSolidObject::GetObjectSpaceVec`, which maps model −Z onto the owner's
`frontdir`. Everything downstream reads that vector: muzzle flashes, beam
visuals, and the launch vectors of the `sim`/`mixed` railgun and howitzer
families. There is no aim-correction step to save a mis-oriented rest pose.

In practice the rule costs nothing, because **the emit direction ignores
mesh geometry entirely — only the rest rotation matters.** Author the
muzzle as an empty node with a pure translation to the barrel tip and no
rotation, and it is horizontal-forward for free. That is what every shipped
metalstorm rig does today: no model in `data/games/metalstorm/models/`
carries a rest rotation on any piece (re-censused 2026-08-14 across all
**102** `.gltf`), so every glTF node matrix in the game is
identity-rotation-plus-translation and no `SPRINGRTS_geometry.pieces[].rot`
field is emitted at all.

Two traps this rule is written against:

- **Barrel-up rigs.** Re-exporting from a Z-up tool (or parenting the
  muzzle under a node that carries the up-axis conversion) bakes a rotation
  mapping −Z onto +Y. The muzzle then fires at the sky while the client —
  which applies the same rotation to the mesh — still draws the barrel
  horizontal. `CWeapon::UpdateWeaponVectors` has a near-vertical safety net
  (substitute the owner's `frontdir` when `|dir·up| > 0.99`), but it is a
  net for unwritten content, not a licence to ship a barrel-up rig.
- **Rear-facing turrets built by translation alone.** Mirroring a turret to
  the back of a hull by only negating its offsets leaves the muzzle's −Z
  pointing forward while the barrel points backward. `fable_train_gun`'s
  slot-2 chain (`turret2`/`barrel2`/`muzzle2`, translated toward +Z) is in
  exactly this state today — a known, unfixed inconsistency. A rear-facing
  turret needs a genuine 180° rest rotation on the turret piece (or a
  mirrored rig), not just flipped offsets.

Guarded by `tests/test_muzzle_emit_dir.cpp`, which loads the shipped
`.gltf` files through the real `ModelConfigLoader` and fails at content
build time if any muzzle stops being horizontal. Add new rigs to the sweep
there when they grow a muzzle piece.

Diagnostic note, since it has cost a debugging session already:
`Spring.GetUnitWeaponVectors` is **not** a way to check this.  For every
projectile type except missile/torpedo/starburst it returns `wantedDir`,
not `weaponDir`, and `wantedDir` is constructor-initialised to `UpVector`
and only overwritten once the weapon has a target. An idle weapon reports
`(0, 1, 0)` no matter how its muzzle is authored.

## 17. Case study — fable_mech (shipped)

MW-3 "Strider" reverse-joint recon walker: **3.18 m tall — exactly
fable_tank's height** (the judging constraint), 854 tris. Pieces:
`body`(pelvis root) → `turret`(torso yaw) → `barrel`(arm railgun) →
`muzzle`(empty); `turret` → `exhaust`(empty); `body` → thigh/shin/foot ×2
(reverse-joint: knee back at thigh-local (0,−0.62,+0.30), ankle at
shin-local (0,−0.63,−0.42), sole on ground). Authored clips walk (1.2 s) /
idle (3.6 s) / death (1.8 s) per §16. Same faction language as the tank:
blue-grey armor, cyan rail/visor emissive, orange vents, hazard tips, team
mask on chest chevron / pauldron / roof wedge, roof numeral "07". All
validator checks green (incl. clip names), KTX2 render-verified, walk-pose
screenshots in `tools/fable-model-forge/shots/mech*`. Def
`units/fable_mech.lua` → `?scenario=model-viewer&game=metalstorm&
def=fable_mech` (clip buttons appear once the model loads).

## 18. Case study — fable_tank (shipped)

FV-9 "Vanguard" railgun MBT: 9.87 m long × 5.06 m wide × 3.18 m tall,
**1 212 tris** (body 344, tracks 158×2, turret 272, barrel 280). Piece tree:
`body`(root) → `tracks_l`, `tracks_r`, `turret`, `exhaust`(empty);
`turret` → `barrel` → `muzzle`(empty at (0,0,−4.62) barrel-local). Turret
pivot at ring centre (0,1.80,0.30); barrel pivot at trunnion
(0,0.66,−1.15 turret-local); forward −Z; 1 u = 1 m. Single material, 1024²
PBR set (`fable_tank_{diffuse,orm,emissive,team}.ktx2`), SPRINGRTS_geometry
v8, team mask on materials[0] (glacis chevron, turret cheek panels with
mask-cutout emblems, skirt flash, rear ID square). All §6 validator checks
green; KTX2 path render-verified; yaw+pitch screenshot proves the pivots.
Shipped to `data/games/metalstorm/models/`, def `units/fable_tank.lua` →
`?scenario=model-viewer&game=metalstorm&def=fable_tank`. Licensing:
`Generated (Claude Fable 5)` rows in ASSETS.md. Sources, pipeline and the
v1→v6 iteration record: `tools/fable-model-forge/`.

## 19. Case study — fable_heavy (shipped)

FV-20 "Bastion", the extra-heavy follow-up to fable_tank: **2× the
length** (20.3 m vs 9.87), 8.3 m wide, 5.28 m tall, 2394 tris (s4 budget
8000), twin-tube main railgun and an **independent secondary turret on
the front-left sponson**. `?scenario=model-viewer&game=metalstorm&def=fable_heavy`.

Piece tree: `body → tracks_l/tracks_r/turret/turret2/exhaust`;
`turret → barrel → muzzle + muzzle_l + muzzle_r`;
`turret2 → barrel2 → muzzle2`. The twin tubes live on ONE `barrel`
piece (they elevate together); `muzzle` sits centred between the bores
so sim projectiles spawn sensibly today, with `muzzle_l/_r` empties
pre-named for a future alternating-fire script. `turret2` gets the full
`turret/barrel/muzzle`-suffixed chain so the §16c cosmetic-aim work can
drive it independently (unitdef weapon [2] = MS_AC_S2; weapon [1] =
MS_RAILGUN_S4).

What was new versus §18, and what it taught:

- **Texel-density parity, not texture scaling.** "Physically larger, not
  scaled up" = keep px/m equal to the smaller vehicle, so the atlas grew
  to 2048². Everything resolution-dependent in the forge was a module
  constant (`meshlib.ATLAS`, `paint.W`, `weathering.W`, `normals.W`);
  since Python resolves module globals at CALL time, `heavy_layout.py`
  does `meshlib.ATLAS = 2048` before any `Zone.uv()` and
  `paint_heavy.py` patches the other three before instantiating
  `Maps()/Weather()/HeightMap()`. No copies of the helper layer; same
  seams/bolts/wear px sizes now read at identical world scale on both
  hulls. (`meshlib.limb`'s hard-coded 1024 was fixed to ATLAS; `tube()`
  grew an `xoff` for the twin bores.)
- **Zone windows must cover the geometry that projects into them.**
  Three near-misses found by checking every box half-extent against its
  zone window before painting: the sponson top overflowed Z_HULL_TOP's
  x-window (u>1 bleeds into the NEIGHBOURING rect — glacis pixels on the
  sponson), the tow cable overflowed Z_TRIM, the engine deck overflowed
  Z_INTAKE. Fix: dedicated Z_SPONSON_TOP zone + widened windows. Rule:
  `Zone.uv` extrapolates, it does not clamp — an oversized greeble
  silently steals paint from the rect next door.
- **Crevice grime turns dense micro-patterns beige.** The auto-grime
  detector (darker-than-neighbourhood) sees EVERY line of a tread-plate
  grid or cable braid, so large finely-patterned areas collected a
  uniform tan wash. On a 20 m hull those areas are big enough to read as
  a colour scheme change. Fix: lower the pattern contrast (shade 1.13,
  1 px lines), drop grime strength 0.68→0.52, and cut uniform mud on the
  fenders to 0.22 with spatter off. Big flat aprons also need tonal
  patches + panel joints or they read as one bright slab from altitude.
- **Independent turret on a pedestal.** The sponson is a body greeble
  (chamfer box) whose top carries a painted turret-2 ring; `turret2`
  embeds into it, same trick as the main turret ring. The pedestal is a
  LOW casemate step (top 2.73 m): drum roof 3.34 + roof sensor 3.50
  stay below the main tubes' underside (3.60), so the twin gun
  traverses across the bow without clipping the secondary — check that
  clearance whenever a hull carries stacked turrets. Front-LEFT =
  +X, −Z in model frame — worth restating because it is easy to flip.
- **drum() helper** (vertical n-gon with parametric wrap + capped top)
  covered the secondary turret (n=10), fuel drums and the commander
  sight — the third reusable rotationalprimitive after tube/limb.
- Preview rig's warm key light + strength-5 normals exaggerate
  bump-speckle into a tan cast on up-facing tread plate; judge grime
  levels against the diffuse crop, not the preview render (§11 lighting
  compression applies in-engine).

Pipeline was otherwise §14 verbatim: layout → gen_heavy → blockout
shots → paint_heavy (weathering → void wells → height→normals 5.0) →
`encode.mjs fable_heavy` → validate (8000-tri budget, required pieces
incl. turret2/barrel2/muzzle2) → ship. Sources:
`tools/fable-model-forge/{heavy_layout,gen_heavy,paint_heavy}.py`,
`preview/shoot_heavy.mjs`.

## 20. Case study — fable_colossus (shipped)

FW-15 "Fenrir": 15 m hunched bipedal assault walker, 5768 tris, 21
pieces, clips walk/idle/death.
`?scenario=model-viewer&game=metalstorm&def=fable_colossus`.

Piece tree: `body(pelvis) → turret(torso) → head / arm_r → barrel
(rotary cannon, missile box) → muzzle / arm_l → flamer → muzzle2 /
pack → stack_r / pauldron_l` plus `thigh → shin → foot → toes` per leg.
`turret` is the torso (yaw-aim convention from fable_mech), `barrel` the
right weapon arm. `pauldron_l` and `stack_r` exist ONLY to break off
during the death clip.

What was new, and what it taught:

- **Per-key FK ground solve (`solve_ground.py`).** Hand-tuned body-bob
  tables float or sink the feet — leg FK is too nonlinear to eyeball on
  a 7.6 m hip height. The fix: run the leg chain (hip→knee→ankle→foot
  corners) for every walk key and solve the body-Y that puts the lowest
  stance-foot corner exactly at ground. Contact keys plant instead of
  hovering. Do this for ANY legged unit; eyeballing wastes rounds.
- **Foot compensation flips sign at toe-off.** The `-(thigh+shin)*0.75`
  sole-leveller is right through stance but WRONG at toe-off: there the
  foot must plantarflex PAST level (world pitch ≈ −40°) so the toe
  stays down as the heel rises. Encode as a per-key additive table on
  top of comp (FOOT_ADD −13/−30 at keys 3/4), not by weakening comp.
- **Articulated toes are cheap and sell everything.** A toe piece per
  foot (pivot at the ball, ~24 tris) + one flex table (0→34° through
  terminal stance/toe-off, relaxed in swing) turns "sliding skates"
  into a creature that pushes off the ground. Same channel doubles for
  the kneel in death (toes fold under).
- **Direction-change feel without a turn clip.** The validator allows
  walk/idle/death only, so banking is baked into walk: pelvis yaw ±5 +
  roll ±4, torso counter-yaw ∓9, and the head counter-yawed to hold
  gaze forward (predator lock). When the engine yaws the unit
  mid-stride, the layered counter-rotations read as leaning into the
  turn. Idle scans head-first, torso following, for the same reason.
- **Death with debris.** Knees-then-topple in three beats (buckle 0–1.05 s
  → kneel hold → forward topple 1.7–2.45 s, settle by 3.1 s). Body pitch
  +82° with thigh counter ≈ −70° keeps shins near the ground through the
  fall. Breakoffs are ordinary pieces whose ABSOLUTE translation channels
  hold their rest offset until the impact key, then follow a short flight
  path with a spin channel (pauldron at the knee impact, stack at the
  chest slam). No engine support needed — it is just keyframes.
- **Titan-level detail vocabulary** (after reference feedback that flat
  chamfer boxes read too blocky): armor plates get a near-black RIM slab
  behind them (`plate()` helper) + painted rivet rows just inside every
  border; joints get drum bearings with collar rings and radial bolt-
  circle caps; hydraulics get chrome-rod/dark-housing pistons (two per
  knee/ankle); corrugated hoses (`hose()`: polyline limbs + fat collars)
  run pelvis→pack and along weapon arms; weapons get multi-tube clusters,
  ammo drum, door-grid missile racks with red status lamps. Geometry
  carries the silhouette; rivets/grooves ride the normal map (bake 4.6).
- 2048² atlas, texel parity with the vehicles; same module-W patching as
  §19. Mean factor comes from posture (deep carapace hunch, head slung
  low and forward under a cowl), red visor slit + teeth grille, horns,
  claws, heel spurs — not from custom palettes: armor family stays
  faction blue-grey with cyan confined to one reactor slit.

Sources: `tools/fable-model-forge/{colossus_layout,gen_colossus,
paint_colossus,solve_ground}.py`. The preview rig gained `window.__root`
for headless FK probing (world positions of nodes at a clip time —
faster than screenshot archaeology when the mixer disagrees with you).

### 20b. Colossus revision — weight, wreckage, and building-scale (learned)

- **`+qx` on the body pitches BACKWARD** (top toward +Z). The forward
  topple needs NEGATIVE pitch. The first death shipped with the sign
  flipped and the solver disguised it — always sanity-check a rotation's
  direction with one probe frame before tuning tables around it.
- **Death needs its own contact solver** (`solve_death.py`): FK over
  every candidate contact (foot corners, toes, knee-bearing bottoms,
  pelvis, chest, jaw, muzzles, elbows) per key; yaw is height-invariant
  so only pitch matters. Findings: the kneel was 1.6 m too low, and a
  pancake-flat prone is IMPOSSIBLE with x-axis-only arm joints — the
  forearm guns would spear 4–5 m underground. Solution: the wreck props
  forward onto braced weapon clusters + knees (pitch −62°, arms +28
  bracing) — grounded everywhere and more dramatic than lying flat.
- **Weighted gait = timing asymmetry on a uniform key grid.** 17 keys
  (6.25% steps) keep the right leg an exact index-shift of 8 while the
  VALUES carry the asymmetry: swing rises over four keys (slow deliberate
  lift, knee held folded), then drops in the last two (fast heavy plant).
  Impact reaction: shin flexes −19 at the loading key (geometric knee
  compression), body gets an extra −0.14 dip + 0.03 rebound on top of
  the FK ground solve, torso nods −7, head whips −6, forearms jolt ±10 —
  all half-period tables so both footfalls thump. WALK_T 2.3 s.
- **Building-scale cues beat more armor**: human-scale access hatches
  with labels + corner bolts, painted cable runs with clamp dots,
  a maintenance ladder (rails + 6 rungs, ~150 tris), comms mast + dish,
  service-port boxes, gauge dials, formation marker lights. Struts and
  bracketed pipe runs (hose() with collars) along thighs/calves fill the
  machinery gaps between armor plates. 5768 → 7182 tris, still under the
  8000 budget.

## 21. Case study — fable_factory (shipped)

"Plant 07", the first BUILDING from the forge: sawtooth-roof assembly
hall (ridge 13.2 m — deliberately colossus-height), twin stacks to
17.8 m, office block, silo pair with transfer pipes, horizontal tank,
rooftop crane over the gate, transformer yard, crates/bollards, all on
a 30×24 m concrete pad (footprint 15×12).
`?scenario=model-viewer&game=metalstorm&def=fable_factory`.

Buildings differ from units in ways worth recording:

- **Pieces**: almost everything lives on `body` (buildings don't need
  the turret/barrel chain — pass a custom required-piece list to the
  validator). Animated garnish is cheap and sells "alive": `dish` and
  `fan` pieces rotate in a 12 s looping `idle` clip (90°-step quaternion
  keys — slerp interpolates each quarter turn; a single 0→360 key pair
  would collapse to nothing).
- **One-sided faces bite on buildings.** The sawtooth glazing was a
  single quad per tooth; from behind, backface culling let you see
  through the roof into the hall's interior faces. Any thin
  architectural plane that is visible from both sides needs a
  reversed duplicate (2 tris — cheaper than debugging).
- **Front-facing zones must run u opposite to +x.** A wall viewed from
  -Z shows +x on the LEFT, so a ('x','y') zone whose window ascends in
  x renders text mirrored ("10 YAB"). Flip the window ((6.4,-10.4)) for
  -z-facing walls — and remember Zone windows also flip the DRAWING
  math: uv() of the left world edge now returns the larger u (a
  rectangle's corners swap). Shared ±x side zones stay text-free (tank
  doctrine); the plant code lives on the rear wall and a single roof
  slope band (the RTS camera's billboard — size roof text to ONE tooth).
- **Buildings are texture-led, not silhouette-led**: corrugation ribs
  (paint + normal lines every ~0.45 m), wainscot bands, expansion
  joints in the pad, lane markings and tire tracks, lit window panes,
  and rust streaks off every sill do more than geometry. Geometry spends
  where the skyline reads: stacks with collars and crowns, crane,
  railings, ladders (reused verbatim from the colossus vocabulary).
- Scale anchor: match the HEIGHT of the units it serves (colossus
  15 m ↔ ridge 13.2 + stacks 17.8) and let the FOOTPRINT carry the
  mass — repo buildings run footprints up to 16×20, so 15×12 sits
  between depot and foundry.

Sources: `tools/fable-model-forge/{factory_layout,gen_factory,
paint_factory}.py`.

## 22. Case study — fable_battleship (shipped)

FNS "Sovereign": s4 capital ship at the STYLE.md ship scale (80 m hull,
beam 12, footprint 14), mast radar 19.4 m — deliberately in the same
height family as the colossus and factory stacks. 6498 tris.
`?scenario=model-viewer&game=metalstorm&def=fable_battleship`.

New lessons, mostly about BIG single-piece models:

- **World-anchored zone windows.** On units, greeble cells assume
  piece-local coords near the origin. A ship puts almost everything on
  `body` in WORLD coords — any small cell whose window doesn't cover
  the world positions of the geometry that samples it sends UVs outside
  [0,1], and GL_REPEAT wraps them into pseudo-random atlas bands (the
  "maroon stripe" bug). Three fixes: (a) per-structure Zone variants
  sharing one rect with world-anchored windows (superstructure levels
  each get their own y-window onto the same porthole art); (b) dynamic
  per-instance Zones for repeated fittings (drum caps already did
  this); (c) for flat-colour greebles (railings, davits, PDCs), one
  cell with a HUGE window covering the whole ship — every world point
  maps inside, art compresses to invisibility, colour survives.
- **Direction-baked mirror pieces**: the aft turret's geometry is built
  facing +Z (rest rotation identity, §2 doctrine) via a z-sign helper.
  Get the sign right the FIRST time by probing one tube station — the
  first cut had both fore and aft tubes pointing inboard, invisible
  inside the gunhouses, and the model "looked fine" at a glance.
- **Nav lights survive shared ±z faces** when placed by WORLD x: port
  (+x) red / starboard green sample the same pixels from either face,
  so both faces read correctly without splitting zones.
- Ship dressing vocabulary: strake seams + frame lines (paint + normal),
  boot-top/anti-foul bands, scupper rust streaks every ~6 m, waterline
  scum band, draft marks, anchor chain runs, helipad with dashed ring,
  breakwater hazard, blast bags at the tube roots. Deck plank relief and
  railings do the "crewed vessel" work; the cyan capacitor rings keep
  the railgun family identity.

Sources: `tools/fable-model-forge/{battleship_layout,gen_battleship,
paint_battleship}.py`.

## 23. Case study — fable_airship (shipped)

FT-2 "Pelican", the sixth showcase: a 65 m rigid dirigible transport
with two ventral cradle bays sized for MBTs. 2222 tris, 2048² atlas,
pieces `body` + `prop1`–`prop4` (spinning in the 6 s idle clip via
90°-step quaternion keys, §21's lesson) + empty `link1`/`link2`
attach pieces + `exhaust`.

**The transport attachment contract (BAR/ZK pattern).** Researched
in-repo before modelling. `data/games/zk/scripts/gunshipheavytrans.lua`
(Hercules) is the canonical script: it declares `local link = piece
'link'`, `script.QueryTransport(passengerID)` returns that piece, and
`TransportPickup` calls `Move(link, y_axis, -Spring.GetUnitHeight(
passengerID) - 15)` **before** `AttachUnit(link, passengerID)` — the
link empty is the socket, and the script drops it by the passenger's
own height so the passenger's roof, not its origin, meets the socket.
The model side of the contract is just: ship empty pieces where cargo
should hang. Engine gates (rts/Sim/Units/Unit.cpp `CanTransport`):
`canload`, `transportCapacity`, `transportMass`, and per-passenger
`xsize <= transportSize * SPRING_FOOTPRINT_SCALE(=2)` — so
`transportsize = 3` admits footprint-3 (s2) tanks and below. The
airship ships two links at the bay centres (y 1.05, the cradle rail
line) and `transportcapacity = 2`; the unitdef documents the whole
contract in its header for whoever writes the unit script.

**Envelope as a faceted loft.** Ten (z, cy, r) sections, 12 facets per
ring — same loft discipline as the battleship hull but radially
symmetric. The zone classifier splits faces by normal (|ny| > 0.55 →
top/belly, else side), giving three world-anchored bands that tile the
whole envelope: panel grids and ring-frame seams drawn once per band
line up across the top/side/belly boundaries because all three windows
share the same z mapping. Loft **caps** are the trap: mapping a cap to
a tiny dedicated window stretches the entire band texture onto a 1 m
disc (first attempt), and small `('x','z')` windows like the old
A_DARK ((−1,1),(−1,1)) wrap into pseudo-random atlas rows for geometry
sitting at world z ≈ ±30 (§22's maroon-stripe bug, cap edition). Both
fixed the same way: caps and greeble cells get HUGE windows
(((−45,45),(−45,45))) so everything compresses to flat colour.

**Fins must bury, not butt.** First blockout placed the horizontal
tail fins' inner edge at |x| = 2.6 where the faceted envelope's
half-width was ~2.5 — they read as floating planks (a facet chord is
always inside the ideal radius; anything tangent to the ideal surface
floats). Fix: a tapered-fin builder (root chord 7.0 → tip 3.8, swept
tip, thickness taper) whose root section sits at |x| = 2.2, ~0.8 m
INSIDE the surface. Rule of thumb for faceted bodies: bury appendage
roots by at least one facet sagitta. The builder winds each quad by
checking its normal against a known outward direction (`quad_out`) —
no hand-winding, no inverted faces, works for all four fins including
the downward-pointing ventral one.

**Painter notes.** (a) The gondola's ('z','y') zone is shared by its
±y faces, which sample single v-rows — keep the roof/floor sample rows
(v(3.8), v(0.5)) free of window band and emissive, same discipline as
the factory sawtooth. (b) The flipped front window (A_GONDOLA_F,
x 3.3 → −3.3) makes u() DECREASE with x: PIL rectangles need swapped
corner order (§21 again — it will bite every front face). (c) Cradle
rail TOPS sample one v-row of the ('z','y') cradle zone; drawing the
hazard chevrons as a band across that row makes the stripes land on
the rail tops for free, alternating along z. (d) Nav beacons got
dedicated 128px cells with huge windows — the whole housing compresses
to ~1 px, so filling the cell red (port, +x) / green (starboard) makes
the entire box glow with zero UV work. (e) Insignia placement on a
body of revolution: keep roundels on the cylindrical mid-section — at
z −27 the nose taper wrapped the roundel across converging facets into
a smeared blob; moving it to z −22.5 (r ≈ 5.8, near-cylindrical) fixed
it. Match ellipse px radii to the zone's per-axis px/m (30.6 × 20.5
here) or the "circle" is an egg in world space.

**Unitdef.** Gunship-style flyer: `canfly` + `hoverattack` +
`airstrafe 0` + `upright`, `cruisealtitude 220` (engine maps it to
wantedHeight), unarmed — the model has no turret chain, and a weapon
with no aim piece fires from the model centre. Transport tags as
above, `releaseheld = true`.

## 24. Case study — fable_fighter (shipped)

FA-6 "Shrike", the seventh showcase: an s3 air-superiority fighter
(12 m wingspan per STYLE.md, ~15 m nose-to-nozzle) at a lean 1255
tris. Pieces: `body` + landing gear `gear_n`/`gear_l`/`gear_r` +
`muzzle`/`muzzle2` weapon empties + `exhaust`. No clips — a fixedwing
has nothing that visibly rotates; the gear ships as separate pieces
purely so a future unit script can `Hide()` them once airborne (the
same forward-compat contract as the airship's link pieces, declared
in the unitdef's customparams).

**Aircraft assembly rules.** (a) The §23 bury rule applies to every
appendage: the first blockout had the intake ducts' inner walls at
|x| ≈ 1.0 where the chined fuselage surface undercuts to ~0.8 — they
floated. Inner walls now sit at |x| 0.55, deep inside. (b) Watch for
member-through-member intersections the silhouette hides: the wings at
y 1.4 passed straight THROUGH the intake boxes (y 0.94–1.98). Raised
to shoulder mount (y 2.02) riding over the intake trunks, F/A-18
style, with the duct roofs tucked 0.01 m under the wing skin — reads
as a deliberate blend. (c) One `blade()` builder (stations of span-x,
y, z_le, z_te, thickness; quad_out winding) covers wings, stabs AND
canted fins — thickness axis 'y' for horizontal surfaces, 'x' for
fins, root open, tip capped.

**Zone plan for a small aircraft.** Three world-anchored body bands at
uniform chord-wise density (F_SIDE 128×128 px/m, F_TOP 128×60,
F_BOT 128×40) — wings, stabs and fuselage top all share F_TOP, which
makes spanwise seams, hinge lines and codes continuous across the
wing-root joint for free. The nose cone caps and greeble cells are
flat huge-window cells (§23). Canted fins are near-vertical, so a
plain ('z','y') zone projects them cleanly.

**Painter notes.** (a) Tone breaks that wrap a body of revolution must
be painted in EVERY band the body samples: the radome break drawn only
in F_SIDE left the nose top/bottom pale — one rectangle each in
F_TOP/F_BOT fixes it. (b) Rotated text: PIL `rotate(±90, expand=True)`
for spanwise wing codes; rotate(-90) reads correctly in the
nose-up blueprint orientation here. Position codes clear of roundels
and hinge lines — they collide fast on a 4 m chord. (c) Symmetric ±s
geometry painted in a loop needs `sorted()` on rectangle corners —
`vx(s·a ± b)` swaps order with the sign of s (the airship's flipped
window lesson in mirrored form). (d) Dark-looking canted fins in top
views are just Lambert shading, not a zone bug — flood-fill the zone
magenta and reshoot before "fixing" UVs (2-minute debug that saved a
wild goose chase). (e) Cheatlines along the chine, intake warning
rings, formation-light emissive strips and live-round missile bands
carry the detail at this scale; all mirror-safe since the flanks share
one zone.

**Unitdef.** Fixedwing: `canfly` WITHOUT `hoverattack` (strafing runs),
`cruisealtitude 180`, fast/agile numbers per the fighters class table,
weapons MS_AC_S2 + MS_MISSILE_AA_S2 (the s3 fighter loadout).

## 25. Case study — fable_carrier (shipped)

FCV-8 "Bastion", the eighth showcase: a ~102 m fleet carrier at 2038
tris. The brief fixed three functional requirements — a clear runway,
deck parking, and an elevator to a hangar — and each one turned into a
contract, not just a picture.

**The flight deck is a loft with a notch.** Two lofts stack: the hull
(6-pt chined rings, stern transom cap) and a separate flight-deck slab
(6-pt rings with chamfered edges) whose sections carry INDEPENDENT
port/starboard half-widths. The port elevator bay is just two
near-duplicate sections 0.02 m apart ((11.99, wl 14.9) → (12.01,
wl 8.8)) — the loft renders a clean vertical notch wall, no CSG
needed. First attempt tapered the deck smoothly and read as a
surfboard; carriers need STRAIGHT edge segments, so the section list
is short and angular (flat 5.5 m-wide runway bow, hard breaks).
Angular > smooth for anything that must read "engineered" at RTS zoom.

**The elevator is a translating piece.** Piece `elevator` (platform +
underframe + a ~130-tri deck-park fighter riding it) rests flush in
the deck notch and cycles to the hangar deck and back via an absolute
translation channel in the 16 s idle clip — same channel type §20's
break-off debris used, keys dwelling at top (0–3 s), descending
(−4.5 m by 6 s), dwelling below (to 10 s), rising. The hull side gets
a recessed hangar-mouth box (skip the buried face) with girders, warm
emissive interior and parked silhouettes painted deep in the bay, plus
guide-rail boxes the platform visually rides. Piece-local zones matter
here: C_ELEV and C_PLANE windows are in ELEVATOR-LOCAL coords, not
world — a translating piece must carry its texture with it.

**The air-base contract.** Modern engine has no isAirBase tag; landing
pads are game-Lua (ZK unit_air_pads): the unit script's
QueryLandingPad returns pad pieces, customparams.pad_count advertises
capacity. So the model ships pad1–pad7 empties AT the painted spots —
4 helo spads (port bow column), 2 herringbone fighter spots
(starboard, between the islands), 1 bomber spot (starboard aft) — and
the unitdef declares pad_count = 7. Third instance of the pattern:
airship links, fighter gear, carrier pads — geometry pieces ARE the
script API.

**Deck markings carry the model.** At 20 px/m the deck is a painting:
EM catapult lanes with emissive rail pairs, JBD chevron plates
(geometry, angled quads behind each cat), the ~2° angled recovery
strip drawn with numpy vector math (unit direction d + normal n, so
borders/dashed centreline/threshold bars/arrestor wires/red foul lines
all derive from one parametric line), deck-edge dashes traced along
the plan polyline, bow number 08 and CAT 1/2 in rotated text (§24
convention: reads nose-up). Parking uses distinct grammars per class:
circles+H for helos, white corner brackets at 40° for fighters,
yellow brackets at 45° for the bomber — silhouette-free markings stay
readable under any parked unit.

**Assorted.** Twin starboard islands (navigation fwd, flyco aft) break
the empty-deck monotony and read unmistakably sci-fi-carrier; the
flipped C_STERN window bit AGAIN (fusion-vent rects needed swapped
corners — that's three models running; check every ('x','y') window
with reversed x before painting). Preview server dies between long
sessions — restart `python3 -m http.server 8899` before shooting.

**Unitdef.** SHIP movedef, footprint 16, lightly armed (PDC flak +
AA missiles — the wing is the weapon), airsightdistance boosted.

## 26. Case study — fable_bomber (shipped)

FB-9 "Petrel", the ninth showcase: the s2 compact strike bomber the
carrier's bomber spot was sized for (12 m wingspan, ~11 m, 945 tris).
Same aircraft grammar as §24 with the deltas that make it read
"bomber" not "fighter": a WIDE flattened fuselage (chine w up to 1.8
vs the fighter's 1.15) with a low 3-bow side-by-side canopy, dorsal
intake humps instead of flank ducts, over-tail stealth nozzles,
cranked delta wings, a closed belly bomb-bay box with painted doors +
red ARM outline (and the `muzzle` release empty at its centre), and
two chunky yellow-banded pylon bombs. Silhouette carries class
identity; the loadout details confirm it.

**Bury-rule, third strike.** The first fin placement (x 1.55 beside
the aft fuselage) floated — the tail narrows to w 0.7 exactly where a
tail fin wants to live. On a blended delta there IS no aft fuselage to
root into, so the fins moved ONTO the wings (YF-23 style): root
station y 1.35 punches THROUGH the wing skin (surface ≈1.48), tip
canted outboard. Wing-mounted fins are the standard fix when the tail
has no shoulder — and remember to re-anchor the fin zone window to the
new z-range before painting.

**Splinter camo is cheap identity.** Four angular polygons per topside
in a second grey (mirror-safe — B_TOP is single-sampled), plus wedges
reaching down the shared flank band, distinguish the strike variant
from the fighter's clean air-superiority scheme at zero geometry cost.
Faction reads from the shared cheatline/roundel/team grammar; role
reads from the camo.

**Recurring gotchas, confirmed again:** ±s loops need sorted()
rectangle corners (dorsal intake warnings, wingtip bands); the spine
mud_band tints brown — keep strength ≤0.2 on topsides or it reads as
gold streaking; preview server needs restarting between long turns
(use `setsid nohup` or the parent bash kills it).

**Unitdef.** bombers-class numbers (speed 6.5), MS_BOMB_S2 only —
compact bay, no defensive turret; gear_pieces customparam as §24.

## 27. Case study — the civilian kit (shipped)

Five models in one pass — ms_habitat, ms_transit_hub, ms_depot,
ms_civtruck, ms_civbus — filling the civilian unitdefs that had
shipped without models (check `units/*.lua` objectnames against
`models/` before inventing new defs; the best showcase is one that
makes existing content work).

**One atlas, five models.** All zones live in one `civkit_layout.py`
partitioning a single 2048² set (stem `fable_civkit`); after each
export the glTF's image URIs are rewritten to the shared filenames
(~15 lines of JSON patching in gen_civkit). Five models cost one
model's texture memory and ONE encode run. Background props never
deserve five texture sets — partition an atlas whenever assets ship
as a family. Buildings get world-anchored side/front/roof bands per
model; vehicles get side/front/roof + shared wheel/hub/trim/glow
cells; `body`-only pieces for buildings, `axle_f`/`axle_r` for the
vehicles (the spin-script API).

**Civilian ≠ military palette.** Warm concrete, light panel, muted
teal and safety orange — no ARMOR grey, no team channel (gaia units).
Scattered lit windows (seeded RNG, ~30%) do more for a habitat block
than any geometry; the L-plan + balconies + roof furniture break the
box at 684 tris.

**Prop-kit gotchas.** (a) Yard items must clear the walls they decorate:
the depot's fuel tank and crates spawned half-inside the hall (blocked
by nothing — intersections don't error, they just look wrong from the
right angle; orbit EVERY prop cluster). (b) Zero-thickness roof slabs
drawn as two coincident faces z-fight — offset the underside 0.04.
(c) Anything coplanar with a roof plane (the transit sign's top at
exactly slab height) shimmers — bury or drop by 0.1. (d) A shared
('z','y') wall zone means hazard rows painted for a platform also
wrap every wall base sampling those rows — give ground-furniture its
own flat cell instead. (e) mud_band over a livery skirt at 0.45
swallows the paint — 0.2 for vehicles.

**No unitdefs shipped** — the five civilian defs already existed;
the kit just gives them bodies. Spawn via the usual model-viewer with
def=ms_habitat etc.
