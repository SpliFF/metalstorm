# unittextures/ — native textures

Authored **`.ktx2`** (UASTC + Zstd, via `toktx`) only — no PNG/DDS sources
here (PLAN-metalstorm.md §9). The shared palette atlas (beta-units §5 style
bible — also used by the Meridian Basin terrain pass) lives here once
authored.

- Naming: match the model file (`ms_<class>_s<n>_*.ktx2`); shared atlases
  prefixed `atlas_`
- Team colour via the engine mask convention (engine-default material — no
  Metalstorm material designed yet, no `modelMaterialPort`)
- **Every asset needs a row in `../ASSETS.md` first**
