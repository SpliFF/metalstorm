#!/usr/bin/env bash
#
# test-gadget-lua.sh — run every Metalstorm gadget busted spec from the cwd
# its family needs, in one shot.
#
# Census (2026-09-17): every `*_spec.lua` under data/games/metalstorm/, minus
# ai/ (already covered by `make test-ai-lua` — same cwd-per-plugin-root
# pattern, left alone here). What's left splits into cwd families because
# `package.path`/`require`/`dofile` in these specs is relative to wherever the
# gadget itself expects to be loaded from — see docs/debugging-tools.md for
# the map and why. This script is a census runner, not a fixer: it reports
# each family's busted summary line and does not touch any spec.
#
# Two families carry KNOWN pre-existing red (do not chase these here):
#   - gadgets-mock: 149 errors — the scenario-cwd specs living in
#     LuaRules/Gadgets/tests/ fail when that whole directory is run from the
#     plugin root, which is the cwd every other spec in it needs.
#   - scenario: 3 failures / 1 error — needs baked unit-def caches from a game
#     that has booted at least once in this tree (same precondition as
#     test-debug-mcp's scenario-validate cases).
#
# Exit status: non-zero if the aggregate failures+errors across all families
# is nonzero (which currently means always, because of the known red above —
# this is a report, not a strict gate; see docs/debugging-tools.md).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GADGETS="data/games/metalstorm/LuaRules/Gadgets"

# name : cwd (relative to repo root) : busted args
FAMILIES=(
    "authority   | $GADGETS/authority  | ."
    "civilians   | $GADGETS/civilians  | tests/"
    "objectives  | $GADGETS/objectives | tests/"
    "parley      | $GADGETS/parley     | tests/"
    "regions     | $GADGETS/regions    | tests/"
    "gadgets-mock| $GADGETS            | tests/"
)
# The scenario family dofile()s content by a game-root-relative path, so it
# must run from data/games/metalstorm and cannot use `tests/` (that would pick
# up the plugin-root specs above too, under the wrong cwd). Listed by name
# because it is exactly the specs whose own header comments say "GAME root".
# Paths here are relative to data/games/metalstorm (the scenario family's cwd),
# not to the repo root like $GADGETS is.
GADGETS_FROM_GAME_ROOT="LuaRules/Gadgets"
SCENARIO_SPECS=(
    "$GADGETS_FROM_GAME_ROOT/tests/crossing_standoff_scenario_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/game_landmarks_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/game_scenario_ai_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/game_scenario_briefing_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/game_scenario_neutral_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/game_scenario_objectives_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/game_scenario_population_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/game_scenario_towns_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/game_tutorial_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/meridian_basin_scenario_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/meridian_basin_soak_scenario_spec.lua"
)

cd "$REPO_ROOT"

log() { printf '\033[1m[test-gadget-lua]\033[0m %s\n' "$*"; }

total_s=0 total_f=0 total_e=0
declare -a RESULTS=()

run_family() {   # $1 = name, $2 = cwd (relative to repo root), $3.. = busted args
    local name="$1" dir="$2"; shift 2
    local out
    out="$(cd "$REPO_ROOT/$dir" && busted "$@" 2>&1)"
    local summary
    summary="$(printf '%s\n' "$out" | grep -E '^[0-9]+ successes' | tail -1)"
    if [[ -z "$summary" ]]; then
        RESULTS+=("ERROR $name — busted produced no summary line (see below)")
        printf '%s\n' "$out" | tail -20
        total_e=$((total_e + 1))
        return
    fi
    local s f e
    # busted pluralizes ("1 error", "2 errors"), so match the stem loosely.
    s="$(printf '%s' "$summary" | grep -oE '^[0-9]+')"
    f="$(printf '%s' "$summary" | grep -oE '[0-9]+ failures?' | grep -oE '^[0-9]+')"
    e="$(printf '%s' "$summary" | grep -oE '[0-9]+ errors?' | grep -oE '^[0-9]+')"
    total_s=$((total_s + s)); total_f=$((total_f + f)); total_e=$((total_e + e))
    RESULTS+=("$(printf '%-14s %s' "$name" "$summary")")
}

for entry in "${FAMILIES[@]}"; do
    IFS='|' read -r name dir args <<<"$entry"
    name="$(echo "$name" | xargs)"; dir="$(echo "$dir" | xargs)"; args="$(echo "$args" | xargs)"
    run_family "$name" "$dir" $args
done
run_family "scenario" "data/games/metalstorm" "${SCENARIO_SPECS[@]}"

echo
log "─────────── gadget lua census ───────────"
for r in "${RESULTS[@]}"; do printf '  %s\n' "$r"; done
printf '  %-14s %d successes / %d failures / %d errors\n' "TOTAL" "$total_s" "$total_f" "$total_e"
echo

if (( total_f + total_e > 0 )); then
    log "$((total_f + total_e)) failure(s)/error(s) across all families (some are known — see this script's header)"
    exit 1
fi
log "all families green"
