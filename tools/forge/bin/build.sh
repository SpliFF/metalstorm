#!/bin/bash
# build.sh <workspace> <stem> <tri_budget> <piece,piece,...> [--no-team]
#
# The whole build loop in ONE call: gen -> paint -> validate -> encode ->
# impostor bake, with a compact summary. Quiet on success (few lines); on any
# failure prints that step's full output and exits non-zero. Agents: use this
# instead of running the five steps as separate shell calls.
set -u
FORGE="$(cd "$(dirname "$0")/.." && pwd)"
TOOLKIT="$(cd "$FORGE/../fable-model-forge" && pwd)"
PY="$FORGE/venv/bin/python"
export PYTHONPATH="$TOOLKIT:$FORGE/prefabs${PYTHONPATH:+:$PYTHONPATH}"

WS="${1:?usage: build.sh <workspace> <stem> <tri_budget> <pieces> [--no-team]}"
STEM="${2:?need stem}"
BUDGET="${3:?need tri budget}"
PIECES="${4:?need piece list (comma-separated)}"
NOTEAM="${5:-}"

cd "$WS"
LOG="$(mktemp -t forge-build)"
trap 'rm -f "$LOG"' EXIT

step() {  # step <label> <cmd...>
    local label="$1"; shift
    if "$@" >"$LOG" 2>&1; then
        echo "ok  $label"
    else
        echo "FAIL $label — full output:"
        cat "$LOG"
        exit 1
    fi
}

step "gen      " "$PY" "gen_${STEM}.py"
TRIS="$(grep -Eo '[0-9]+ tris|tris[: ]+[0-9]+' "$LOG" | grep -Eo '[0-9]+' | tail -1) tris"
step "paint    " "$PY" "paint_${STEM}.py"
if [ "$NOTEAM" = "--no-team" ]; then
    step "validate " "$PY" "$TOOLKIT/validate.py" "out/${STEM}.gltf" "$BUDGET" "$PIECES" --no-team
else
    step "validate " "$PY" "$TOOLKIT/validate.py" "out/${STEM}.gltf" "$BUDGET" "$PIECES"
fi
VERDICT=$(grep -Eo 'ALL CHECKS PASSED' "$LOG" || true)
step "encode   " node "$TOOLKIT/encode.mjs" "$STEM"
step "bake     " "$PY" "$TOOLKIT/bake_impostors.py" "out/${STEM}_png.gltf" \
    --diffuse "out/${STEM}_diffuse.png" --out bake --cell 256

echo "---"
echo "$STEM: ${TRIS:-tris?} (budget $BUDGET) — ${VERDICT:-VALIDATOR OUTPUT MISSING}"
ls out/*.ktx2 2>/dev/null | wc -l | awk '{print "ktx2 files: " $1}'
echo "impostor: $WS/bake/${STEM}_png_impostor.png"
