#!/usr/bin/env bash
# fetch_pie.sh — download the exact Warzone 2100 .pie source parts (and the
# texture pages they reference) used by the Metalstorm conversion baseline
# (PLAN-metalstorm-beta-units.md §1).
#
# WZ2100 source + artwork are GPL-2.0-or-later (project relicensing, 2008). The
# .pie parts are checked into tools/wz2100-baseline/pie/ already (they are tiny
# and GPL requires the source stay available); this script re-fetches them from
# upstream. Pass a tag/commit for BOTH repos to make the fetch reproducible —
# with no arguments it tracks `master`, which is NOT pinned and may drift from
# the checked-in copies (a loud warning is printed in that case).
#
# The texture pages the .pie parts reference live in a *separate* upstream
# submodule repo (Warzone2100/data-texpages), so they get their own base URL.
# Both the diffuse pages and the PIE4 team-colour (`_tcmask`) pages are pulled
# into tools/wz2100-baseline/texpages/ for the importer + toktx step.
set -euo pipefail

REF="${1:-master}"      # engine repo ref (.pie parts) — pass a tag/commit to pin
TEXREF="${2:-master}"   # data-texpages repo ref — pass a tag/commit to pin
if [[ "$REF" == "master" || "$TEXREF" == "master" ]]; then
  echo "WARNING: fetching from an unpinned ref (REF=${REF} TEXREF=${TEXREF})." >&2
  echo "         upstream 'master' moves — this run is NOT reproducible and may" >&2
  echo "         not match the checked-in pie/ + texpages/ copies." >&2
  echo "         Pin both: $0 <engine-tag-or-commit> <texpages-tag-or-commit>" >&2
fi
BASE="https://raw.githubusercontent.com/Warzone2100/warzone2100/${REF}/data/base"
TEXBASE="https://raw.githubusercontent.com/Warzone2100/data-texpages/${TEXREF}"
DEST="$(cd "$(dirname "$0")" && pwd)/pie"
TEXDEST="$(cd "$(dirname "$0")" && pwd)/texpages"
mkdir -p "$DEST" "$TEXDEST"

# part path (under data/base) — grouped by the model that uses it
PARTS=(
  # wz_tank  = heavy tracked tank
  "components/bodies/drhbod09.pie"
  "components/prop/prhltrk3.pie"
  "components/prop/prhrtrk3.pie"
  "components/weapons/trhcan.pie"
  # wz_wheeled = light wheeled vehicle (Viper hull)
  "components/bodies/drlbod01.pie"
  "components/prop/prllwhl1.pie"
  "components/prop/prlrwhl1.pie"
  "components/weapons/trlcan.pie"
  # wz_cyborg = cyborg walker
  "components/bodies/cybd_std.pie"
  "components/weapons/cy_can.pie"
  # wz_building = command HQ
  "structs/blhq.pie"
)

echo "fetching ${#PARTS[@]} .pie parts from Warzone2100@${REF} -> $DEST"
for p in "${PARTS[@]}"; do
  curl -fsSL --max-time 30 "$BASE/$p" -o "$DEST/$(basename "$p")"
  echo "  $(basename "$p")"
done

# Texture pages the parts reference (TEXTURE / TCMASK directives). Diffuse pages
# are hi-res redraws of the 256-space the .pie UVs are authored in; `_tcmask`
# pages are the greyscale team-colour masks (PIE4 TCMASK). Both are plain RGBA.
TEXPAGES=(
  # diffuse pages
  "page-14-droid-hubs.png"      # tank/wheeled bodies
  "page-16-droid-drives.png"    # tracks/wheels
  "page-17-droid-weapons.png"   # cannons
  "page-33-cyborgs.png"         # cyborg body
  "page-34-buildings.png"       # command HQ
  # team-colour masks (PIE4 TCMASK)
  "page-34_tcmask.png"          # blhq (command HQ) team regions
)

echo "fetching ${#TEXPAGES[@]} texture pages from data-texpages@${TEXREF} -> $TEXDEST"
for t in "${TEXPAGES[@]}"; do
  curl -fsSL --max-time 60 "$TEXBASE/$t" -o "$TEXDEST/$t"
  echo "  $t"
done
echo "done."
