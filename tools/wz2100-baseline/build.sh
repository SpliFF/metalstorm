#!/usr/bin/env bash
# build.sh — convert the WZ2100 baseline .pie parts to engine-ready native
# models and place them where the engine serves them
# (PLAN-metalstorm-beta-units.md §1/§6).
#
# Pipeline (all pure-Python, no Blender — see pie_to_glb.py's header for why):
#   pie/*.pie  --pie_to_glb.py-->  models/<name>.gltf (+ .bin)  [engine-served]
#                                  objects3d/<name>.glb          [authored artifact]
#   unittextures/atlas_palette.ktx2 --copy--> models/wz_palette.ktx2  [diffuse]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/tools/wz2100-baseline"
GAME="$ROOT/data/games/metalstorm"

# The shared palette atlas is the diffuse texture every baseline model samples
# (per-piece swatch via UVs). Copy it beside the .gltf so the relative texture
# URI (wz_palette.ktx2) resolves; keeping the copy fresh from the canonical
# source means it never goes stale.
mkdir -p "$GAME/models"
cp "$GAME/unittextures/atlas_palette.ktx2" "$GAME/models/wz_palette.ktx2"

python3 "$ROOT/tools/scripts/pie_to_glb.py" \
  --spec "$HERE/assemblies.json" \
  --pie-dir "$HERE/pie" \
  --models-dir "$GAME/models" \
  --objects3d-dir "$GAME/objects3d"

echo
echo "baseline models built. Showcase in the harness:"
echo "  ?scenario=model-viewer&game=metalstorm&def=wz_tank&capture=turntable"
echo "  (also: wz_wheeled, wz_cyborg, wz_building)"
