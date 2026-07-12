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

## Final state (v6, shipped 2026-07-11)

1212 tris, all repo validator checks green, KTX2 render path verified.
Shipped: `data/games/metalstorm/models/fable_tank.{gltf,bin}` + 4 `.ktx2`,
`units/fable_tank.lua`, ASSETS.md rows. Iteration history in `shots/`
(v1 blockout → v6 final; `*_aim` shots prove turret/barrel pivots).
`out/*.png` are the texture sources — re-encode with `node encode.mjs`
after editing `paint.py`. Full conventions + lessons:
`DESIGN-MODEL-BUILDING.md` at the repo root.
