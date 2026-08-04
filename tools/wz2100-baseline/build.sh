#!/usr/bin/env bash
# build.sh — convert the WZ2100 baseline .pie parts to engine-ready native
# models and place them where the engine serves them
# (PLAN-metalstorm-beta-units.md §1/§6).
#
# Pipeline (via the modelimporter Assimp plugin — see tools/modelimporter/
# PIEImporter.{h,cpp}; the old pure-Python pie_to_glb.py is retired):
#   <unit>.wzasm  --modelimporter-->  models/<unit>.gltf (+ .bin)  [engine-served]
#                                       real per-vertex UVs + per-page materials
#                                       + SPRINGRTS_geometry piece tree
#   texpages/page-*.png  --toktx-->   models/page-*.ktx2            [diffuse + tcmask]
#
# The .gltf references its pages by bare filename (`page-*.ktx2`), resolved by
# the renderer relative to the model dir, so the KTX2 pages live in models/
# alongside the .gltf. A page shared by several units is a single file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/tools/wz2100-baseline"
GAME="$ROOT/data/games/metalstorm"
MODELS="$GAME/models"

# Locate the modelimporter binary (release preferred, then debug). Set
# MODELIMPORTER to point at another build dir — a taskherd lane, say, whose
# build/{release,debug} are inherited copies it must not reconfigure.
BIN="${MODELIMPORTER:-}"
if [ -n "$BIN" ] && [ ! -x "$BIN" ]; then
  echo "error: MODELIMPORTER=$BIN is not executable" >&2
  exit 1
fi
for cand in "$ROOT/build/release/tools/modelimporter/modelimporter" \
            "$ROOT/build/debug/tools/modelimporter/modelimporter"; do
  [ -n "$BIN" ] && break
  if [ -x "$cand" ]; then BIN="$cand"; break; fi
done
if [ -z "$BIN" ]; then
  echo "error: modelimporter not built. Run:" >&2
  echo "  cmake --build build/debug --target modelimporter" >&2
  exit 1
fi
command -v toktx >/dev/null 2>&1 || { echo "error: toktx (KTX-Software) not on PATH" >&2; exit 1; }

mkdir -p "$MODELS"

# 1) Convert every referenced texture page (diffuse + tcmask) to KTX2 once.
#    UASTC + zstd + mipmaps — matches the runtime's KTX2 loader (and the
#    shared palette atlas encode in make_palette_atlas.py). `--assign_oetf`
#    is required because some WZ pages ship an ICC profile toktx won't read;
#    diffuse pages are sRGB colour, the `_tcmask` mask is a linear blend
#    amount (the shader samples its raw `.r`).
echo "converting texture pages -> $MODELS"
for png in "$HERE"/texpages/*.png; do
  [ -e "$png" ] || continue
  stem="$(basename "$png" .png)"
  oetf="srgb"
  case "$stem" in *_tcmask) oetf="linear";; esac
  toktx --encode uastc --zcmp 19 --genmipmap --assign_oetf "$oetf" "$MODELS/$stem.ktx2" "$png"
  echo "  $stem.ktx2 ($oetf)"
done

# 2) Convert each assembly manifest to an engine-served .gltf.
echo "converting models -> $MODELS"
for wzasm in "$HERE"/*.wzasm; do
  [ -e "$wzasm" ] || continue
  name="$(basename "$wzasm" .wzasm)"
  "$BIN" "$wzasm" "$MODELS/$name.gltf"
  echo "  $name.gltf (+ .bin)"
done

echo
echo "baseline models built. Showcase in the harness:"
echo "  ?scenario=model-viewer&game=metalstorm&def=wz_tank&capture=turntable"
echo "  (also: wz_wheeled, wz_cyborg, wz_building — the HQ carries a team-colour mask)"
