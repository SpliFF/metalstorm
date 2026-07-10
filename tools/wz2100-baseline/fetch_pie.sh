#!/usr/bin/env bash
# fetch_pie.sh — download the exact Warzone 2100 .pie source parts used by the
# Metalstorm conversion baseline (PLAN-metalstorm-beta-units.md §1).
#
# WZ2100 source + artwork are GPL-2.0-or-later (project relicensing, 2008). The
# .pie parts are checked into tools/wz2100-baseline/pie/ already (they are tiny
# and GPL requires the source stay available); this script just re-fetches them
# from a pinned upstream ref so the provenance is reproducible.
set -euo pipefail

REF="${1:-master}"   # pin a tag/commit for reproducibility; default master
BASE="https://raw.githubusercontent.com/Warzone2100/warzone2100/${REF}/data/base"
DEST="$(cd "$(dirname "$0")" && pwd)/pie"
mkdir -p "$DEST"

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
echo "done."
