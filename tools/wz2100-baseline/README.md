# WZ2100 conversion baseline

The first `.pie` → native `.gltf` conversion wave (PLAN-metalstorm-beta-units.md
§1/§5, the `model-poc` lane's Opus step). Four representative Warzone 2100 models
converted to engine-ready native models, wired as spawnable Metalstorm defs so
the model-viewer harness can showcase them. They double as the **PoC comparison
baseline** — Fable's generated tank/mech get judged against these side by side —
and remain shippable if kept.

## Licensing

Warzone 2100 **source *and* artwork** are **GPL-2.0-or-later** (project
relicensing, 2008 — only the FMV movies were ever under separate terms). GPL art
is usable in this open-source game but is copyleft: these converted derivatives
stay GPL, and every one carries a row in `data/games/metalstorm/ASSETS.md`.

## What's here

| File | Role |
|---|---|
| `pie/*.pie` | the GPL source parts, checked in (tiny; GPL wants the source available) |
| `assemblies.json` | the assembly spec — which parts compose each model, piece names, scale, colour roles |
| `fetch_pie.sh` | re-download the parts from a pinned upstream ref (provenance) |
| `build.sh` | run the full pipeline → `data/games/metalstorm/models/` + `objects3d/` |
| `../scripts/pie_to_glb.py` | the converter/normaliser (parser + RH orient + scale + piece naming + budget check + palette texture) |

## The four models

| Def | WZ parts | Pieces |
|---|---|---|
| `wz_tank` | `drhbod09` hull + `prhltrk3`/`prhrtrk3` tracks + `trhcan` cannon | body, tracks_l, tracks_r, turret, muzzle |
| `wz_wheeled` | `drlbod01` Viper hull + `prllwhl1`/`prlrwhl1` wheels + `trlcan` cannon | body, wheels_l, wheels_r, turret, muzzle |
| `wz_cyborg` | `cybd_std` body + `cy_can` cannon | body, gun, muzzle |
| `wz_building` | `blhq` command HQ | body |

## Reproduce

```sh
./tools/wz2100-baseline/fetch_pie.sh          # optional: re-pull sources (they're committed)
./tools/wz2100-baseline/build.sh              # convert → models/ + objects3d/
```

Then in the browser:

```
http://localhost:8012/?scenario=model-viewer&game=metalstorm&def=wz_tank&capture=turntable
```

(`wz_wheeled`, `wz_cyborg`, `wz_building` too). Exit gate: each passes the
turntable capture (`window.modelViewer.state.badge !== 'fallback-model'` — renders
as a real mesh, not the procedural fallback). All four verified 2026-07-10.

## Pipeline notes / deliberate divergences

See `../scripts/pie_to_glb.py`'s module docstring for the full rationale. In short:

- **Pure-Python, not Blender.** `.pie` isn't a format Blender imports, so a parser
  is needed regardless; Blender isn't installed here, and direct glTF authoring
  from the stdlib is the least-fragile path (the task's "whichever proves less
  fragile" call). The Blender `normalize_model.py` remains the path for
  glTF/FBX/OBJ sources (Option A/B assets).
- **Flat palette colour, no WZ textures.** WZ's atlas pages live in a separate
  upstream submodule, and the house style is flat-shaded low-poly anyway. Each
  piece UVs onto a swatch of the shared `atlas_palette.ktx2`. This makes the
  baseline apples-to-apples with the generated PoC models (same render style,
  differ only in geometry — the thing being judged).
- **No `SPRINGRTS_geometry` / sim piece tree (follow-up).** The direct `.gltf`
  renders + animates client-side (pieces from node names) and passes the harness,
  but has no server-side piece tree. `tools/modelimporter` *can* embed
  `SPRINGRTS_geometry` v8 (smoke-tested: all 5 pieces preserved) — but it also
  re-applies LH→RH + an S3O-oriented texture channel split that conflicts with the
  already-RH, palette-textured input. Wiring it in for full sim integration
  (feed it raw-WZ-orientation geometry, reconcile the texture path) is a
  documented follow-up; not needed for the showcase/baseline purpose.
- **No team-colour mask.** Baseline ships no `SPRINGRTS_team_color` mask, so it
  doesn't team-tint. Fine for a comparison baseline; add a mask if kept as a
  shipping unit.
