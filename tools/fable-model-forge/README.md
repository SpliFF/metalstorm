# fable-model-forge — procedural native-model forge for springrts-web

Built in the Cowork cloud sandbox (Claude Fable 5, 2026-07-11) to produce
`fable_tank`; structured so the next unit is a drop-in. Reusability split:

- **Unit-agnostic, use as-is**: `meshlib.py` (primitives + zone UVs),
  `gltf_export.py` (.gltf/.bin writer + SPRINGRTS_geometry derivation —
  takes any pieces list), `encode.mjs [stem]`, `validate.py <gltf> [budget]
  [pieces]`, `preview/` (model path is a URL param; yaw/pitch shot no-ops
  without turret/barrel nodes), and paint.py's helper layer (Maps, seams,
  bolts, vents, wear, stencil).
- **Per-model, by design**: layout + builders + painters. Two worked
  examples now: fable_tank (`layout.py` / `gen.py` / `paint.py`) and
  fable_mech (`mech_layout.py` / `gen_mech.py` / `paint_mech.py` — adds
  authored walk/idle/death clips via `gltf_export.py`'s `clips=` param and
  the `limb()` primitive for angled leg segments; animation-pose
  screenshots via `preview/shoot_mech.mjs` and the `&clip=&t=` preview
  params). New unit = new copies of those three files, per the runbook in
  `DESIGN-MODEL-BUILDING.md` §14; animation authoring contract in §16.

## Pipeline

1. `python3 gen.py` — builds all pieces (flat-shaded, piece-local frames,
   SPRINGRTS_geometry v8) → `out/fable_tank.gltf` (KTX2 URIs) and
   `out/fable_tank_png.gltf` (PNG URIs, local preview only) + `fable_tank.bin`.
2. `python3 paint.py` — paints the 1024² atlas set → `out/fable_tank_{diffuse,
   orm,emissive,team}.png` (WIP: currently a zone-tinted UV-checker stub
   inlined in the session; real painter next).
3. `node encode.mjs` — PNG → `.ktx2` (UASTC + Zstd + mips; sRGB/linear split).
4. `python3 -m http.server 8899 &` then
   `node preview/shoot.mjs /out/fable_tank_png.gltf v1` — headless three.js
   turntable screenshots into `shots/` (incl. a `yaw`/`pitch` shot proving the
   turret/barrel pivots).

Files: `meshlib.py` (flat-shaded mesh kit: chamfer boxes, lofts, n-gon tubes,
zone-projected UVs), `layout.py` (single source of truth: atlas zones + every
design dimension), `gen.py` (tank assembly + glTF/bin export), `preview/`
(three.js + Playwright rig; launch Chromium with
`executablePath:'/opt/pw-browsers/chromium'`), `encode.mjs`, and
`validate.py` (engine-readiness checks mirroring
client/src/core/model-validate.ts — run
`python3 validate.py out/<stem>.gltf 2000 body,turret,barrel,muzzle`).

npm deps: `three`, `playwright`, `pngjs`, `babylonpress-ktx2-encoder`.

## Current state

The forge pipeline itself is what has landed here: mesh kit, layouts,
generators, painters, glTF/bin writer, KTX2 encoder, preview rig, and
`validate.py`. Generated artifacts stay local under `out/` and `shots/`
(fable_tank reached v6 — 1212 tris, validator-green, KTX2 render path
verified; `*_aim` shots prove the turret/barrel pivots).

**Not yet landed at this revision**: the shipped game assets
(`data/games/metalstorm/models/fable_tank.{gltf,bin}` + 4 `.ktx2`),
`units/fable_tank.lua`, the matching ASSETS.md licence rows, and the
`DESIGN-MODEL-BUILDING.md` design doc referenced above — those exist only
on an unmerged branch. When they merge, models land in
`data/games/metalstorm/models/`, the def in `data/games/metalstorm/units/`,
and the licence rows in `data/games/metalstorm/ASSETS.md` (the
assets-manifest gate requires them before any model merges).

`out/*.png` are the texture sources — re-encode with `node encode.mjs`
after editing `paint.py`.

## Impostor sprites (beta-units task 4b)

`gen_impostor_sprites.py` paints the billboard sprite atlases for the
impostor-only infantry/civilian defs (no 3D model at all — §2.1
impostor-first): `ms_soldiers_s1`, `ms_engineers_s1`, `ms_civilians`,
`ms_militia`. Single-frame 256² sprites (walk/idle flipbook rows wait on
fx-offload X2), fable palette, flat 3-tone facets + outline, plus R8 team
masks for the team-coloured defs. `node encode_sprites.mjs` encodes them
(diffuse sRGB + alpha cutout, mask linear); shipped files are
`data/games/metalstorm/models/<stem>_impostor{,_team}.ktx2`.
