# objects3d/ — native models

Authored **`.glb`** (glTF-binary, RH coordinates — `legacyCoordSystem = false`).
Piece tree, bounding sphere/box and attachment points live **inside the `.glb`
itself** via the document-level `SPRINGRTS_geometry` extension that
`tools/modelimporter` embeds on export — there is no separate per-model
sidecar file (`ModelConfigLoader::Load` reads it straight off the `.gltf`;
the old `.config.json`/`.config.lua` sidecar convention some earlier docs
call `.meta.lua` was retired when `SPRINGRTS_geometry` landed — see
`rts/Sim/Objects/ModelConfigLoader.h`). A footprint profile is *unit-def*
data, not a model sidecar: big units opt in via
`customparams.footprint_profile = '<key>'` pointing at a profile authored in
`../gamedata/footprints.lua`. Impostor atlases for the smallest units also
land here as `.ktx2` (8 headings × flipbook frames).

Conventions (PLAN-metalstorm-beta-units.md, PLAN-metalstorm.md §9):

- File per def family: `ms_<class>_s<n>.glb` (modelimporter is the last step
  of the normalisation pipeline, §6 — it both re-exports the `.glb` and
  embeds `SPRINGRTS_geometry`, so a bare `.glb` is a complete, engine-loadable
  model)
- Piece names: `turret`, `barrel`, `tracks`, `muzzle`, exhaust; scale-4 named
  attachment points for independent cosmetic turrets
- Animation clips: `walk`, `idle`, `death`
- Budgets: see beta-units §2 (scale-4 hero ≤8k tri — under review, C-item)
- **Every asset needs a row in `../ASSETS.md` first** (licensing manifest)
- Produced only by the normalisation pipeline (beta-units §6) — never
  hand-dropped exports; **no gameconverter, ever**
