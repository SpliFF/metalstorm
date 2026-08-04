# WZ2100 conversion baseline

Four representative Warzone 2100 models converted to engine-ready native `.gltf`,
wired as spawnable Metalstorm defs so the model-viewer harness can showcase them
(PLAN-metalstorm-beta-units.md §1/§5). They double as the **PoC comparison
baseline** — Fable's generated tank/mech get judged against these side by side.

Conversion goes through the **`.pie` Assimp importer plugin** in
`tools/modelimporter/` (`PIEImporter.{h,cpp}`), the same custom-plugin approach as
the S3O importer — so `.pie` files flow through the standard `modelimporter →
glTF/KTX2/SPRINGRTS_geometry` pipeline as everything else. This keeps the real WZ
per-vertex UVs and the real WZ texture pages (the old `pie_to_glb.py` discarded
both and flat-coloured every piece with a grey palette swatch, which is why the
baseline used to render "untextured").

## Licensing

Warzone 2100 **source *and* artwork** are **GPL-2.0-or-later** (project
relicensing, 2008 — only the FMV movies were ever under separate terms). GPL art
is usable in this open-source game but is copyleft: these converted derivatives
stay GPL, and every one carries a row in `data/games/metalstorm/ASSETS.md`.

## What's here

| File | Role |
|---|---|
| `pie/*.pie` | GPL source component parts, checked in (tiny; GPL wants the source available) |
| `texpages/*.png` | texture pages: GPL upstream diffuse + `_tcmask` masks (fetched from `data-texpages`), plus the authored `*_ms_tcmask` masks |
| `*.wzasm` | one assembly manifest per unit — component `.pie` files, mount points, scale, dominant axis, team-mask overrides (replaces the old `assemblies.json`; read directly by the `.pie` importer) |
| `make_tcmask.py` | author the vehicle team-colour masks from the `.pie` geometry (see below) |
| `fetch_pie.sh` | re-download the `.pie` parts + texture pages from pinned upstream refs (provenance) |
| `build.sh` | run the full pipeline → `data/games/metalstorm/models/` (`.gltf`+`.bin` + `page-*.ktx2`) |

## The four models

| Def | WZ parts | Pieces | Pages |
|---|---|---|---|
| `wz_tank` | `drhbod09` hull + `prhltrk3`/`prhrtrk3` tracks + `trhcan` cannon | body, tracks_l, tracks_r, turret, muzzle | 14, 16, 17 |
| `wz_wheeled` | `drlbod01` Viper hull + `prllwhl1`/`prlrwhl1` wheels + `trlcan` cannon | body, wheels_l, wheels_r, turret, muzzle | 14, 16, 17 |
| `wz_cyborg` | `cybd_std` body + `cy_can` cannon | body, gun, muzzle | 33, 17 |
| `wz_building` | `blhq` command HQ (PIE4, has `TCMASK`) | body | 34 (+ `page-34_tcmask`) |

## Team colour

All four models team-tint, but they get their mask from three different places
(most specific wins — see `PIEImporter.h`):

| Model | Mask source |
|---|---|
| `wz_building` | PIE4 `TCMASK` directive → `page-34_tcmask` |
| `wz_cyborg` | PIE3 `TYPE & 0x10000` flag → `page-33_tcmask` / `page-17_tcmask` by WZ's `page-<N>_tcmask` naming convention |
| `wz_tank`, `wz_wheeled` | **authored** hull/turret mask on pages 14/17, wired through the `.wzasm` `tcmask` map; tracks/wheels fall through to the stock `page-16_tcmask` |

The vehicles need authored art because upstream has none that fits them. The
Viper and heavy hulls (`drlbod01` / `drhbod09`) are `TYPE 200` — not flagged
team-coloured at all — and the stock `page-14_tcmask` has **zero** coverage over
the UV islands they use; `page-17_tcmask` (weapons) is **entirely black**
upstream. Left alone they import untinted grey, which is worse team
identification than the proxy capsule they replaced.

`make_tcmask.py` authors the mask from geometry the `.pie` parts already carry:
for the `body` and `turret` of each vehicle it rasterises the UV footprint of
every triangle whose face normal points up (`n.y > 0.1` — deck, glacis and
sloped upper flanks, never the underside or the vertical sides) at blend
strength 0.8, into a 1024² page in the diffuse page's own UV space. Re-run it
after touching the `.pie` parts or the selection rule:

```sh
python3 tools/wz2100-baseline/make_tcmask.py --report   # coverage, writes nothing
python3 tools/wz2100-baseline/make_tcmask.py            # → texpages/*_ms_tcmask.png
./tools/wz2100-baseline/build.sh                        # bake + re-import
```

Earlier note, still true: the importer carries whichever mask page wins through
Assimp on a spare texture slot, and modelimporter's post-fix injects it as the
`SPRINGRTS_team_color` material extension.

## Reproduce

```sh
cmake --build build/release --target modelimporter   # needs the .pie plugin built
./tools/wz2100-baseline/fetch_pie.sh                 # optional: re-pull sources (committed)
./tools/wz2100-baseline/build.sh                     # convert → models/
```

Then in the browser:

```
http://localhost:8012/?scenario=model-viewer&game=metalstorm&def=wz_tank
```

(`wz_wheeled`, `wz_cyborg`, `wz_building` too). Each renders as a real, WZ-textured
mesh (not the procedural fallback, and not the old flat-grey palette).

## Pipeline notes

- **Assimp plugin, not a one-off script.** `.pie` (and `.wzasm`) parsing lives in
  `tools/modelimporter/PIEImporter.{h,cpp}`, mirroring `S3OImporter`. Any `.pie`
  is now convertible through `modelimporter`, and the assembled scene gets
  `SPRINGRTS_geometry` (piece tree, bounds, radius) for free from the shared
  `GeometryExtractor`.
- **Coordinates** pass through verbatim (WZ Y-up/+Z-forward); modelimporter's
  export `aiProcess_MakeLeftHanded | aiProcess_FlipWindingOrder` lands them in
  glTF RH. UVs are PIE2-pixel-normalised (÷ declared page dims) and V-flipped for
  our KTX2 + Babylon `invertY` sampling (`kFlipV` in the importer).
- **Per-page materials.** A WZ unit spans several texture pages (body/tracks/
  turret differ), so the importer emits one material per page; the renderer binds
  each piece's own material (`entity-renderer.ts`, per-piece materials). This also
  fixed multi-material `.dae` ZK units that previously only got `materials[0]`.
- **Plain-diffuse, not S3O channel-split.** WZ pages are ordinary sRGB diffuse
  (no packed team-mask/glow), so `GeometryExtractor` skips the S3O `tex1`/`tex2`
  split for `.pie`/`.wzasm` sources; each page is referenced directly as a
  KTX2 `baseColorTexture` via `KHR_texture_basisu`.
