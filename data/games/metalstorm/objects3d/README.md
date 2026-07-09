# objects3d/ — native models

Authored **`.glb`** (glTF-binary, RH coordinates — `legacyCoordSystem = false`)
with a **`.meta.lua`** sidecar per model (footprint profile key for big units
— `gamedata/footprints.lua` — plus the piece map). Impostor atlases for the
smallest units also land here as `.ktx2` (8 headings × flipbook frames).

Conventions (PLAN-metalstorm-beta-units.md, PLAN-metalstorm.md §9):

- File per def family: `ms_<class>_s<n>.glb` + `ms_<class>_s<n>.meta.lua`
- Piece names: `turret`, `barrel`, `tracks`, `muzzle`, exhaust; scale-4 named
  attachment points for independent cosmetic turrets
- Animation clips: `walk`, `idle`, `death`
- Budgets: see beta-units §2 (scale-4 hero ≤8k tri — under review, C-item)
- **Every asset needs a row in `../ASSETS.md` first** (licensing manifest)
- Produced only by the normalisation pipeline (beta-units §6) — never
  hand-dropped exports; **no gameconverter, ever**
