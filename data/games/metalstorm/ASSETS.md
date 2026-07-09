# Metalstorm asset license manifest

**Mandatory** (PLAN-metalstorm-beta-units.md §1): every imported/derived asset
gets a row BEFORE it lands in the tree. No row, no merge. This is the legal
record for a GPL-2.0 game shipping mixed-source art.

Sourcing rules (beta-units §1):

- **CC0 preferred** (Quaternius, Kenney, OpenGameArt-CC0): unrestricted, safest.
- **WZ2100 assets are GPL-2.0+, NOT public domain** — compatible with the game
  license but attribution + source-offer obligations apply. Fallback only.
- Generated models (the tank+mech PoC gate, PLAN-model-harness.md): record the
  generator + prompt/seed in Modifications.
- Everything is normalised through the one pipeline (beta-units §6):
  RH orient → scale → piece rename (`turret`/`barrel`/`tracks`/`muzzle`;
  clips `walk`/`idle`/`death`) → palette re-texture → `.glb` + `.meta.lua`
  + `.ktx2` into `objects3d/` / `unittextures/`.

| Asset (path in tree) | Target def(s) | Origin (URL) | Author | License | Modifications |
|---|---|---|---|---|---|
| _none yet_ | | | | | |
