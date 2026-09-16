#!/usr/bin/env bash
#
# test-gadget-lua.sh — run every Metalstorm gadget busted spec from the cwd
# its family needs, in one shot, and gate on REGRESSIONS against a recorded
# baseline (not on the raw pass/fail/error counts).
#
# Census (2026-09-17): every `*_spec.lua` under data/games/metalstorm/, minus
# ai/ (already covered by `make test-ai-lua` — same cwd-per-plugin-root
# pattern, left alone here). What's left splits into cwd families because
# `package.path`/`require`/`dofile` in these specs is relative to wherever the
# gadget itself expects to be loaded from — see docs/debugging-tools.md for
# the map and why. This script is a census runner, not a fixer: it reports
# each family's busted summary line and does not touch any spec.
#
# Two families carry KNOWN pre-existing red, recorded in gadget-baseline.json:
#   - gadgets-mock: 149 errors — the scenario-cwd specs living in
#     LuaRules/Gadgets/tests/ fail when that whole directory is run from the
#     plugin root, which is the cwd every other spec in it needs.
#   - scenario: 3 failures / 1 error — needs baked unit-def caches from a game
#     that has booted at least once in this tree (same precondition as
#     test-debug-mcp's scenario-validate cases).
#
# Baseline gate: each family's fail/error counts are compared against
# tools/scripts/gadget-baseline.json. A family only fails the gate if its
# fail or error count EXCEEDS its baseline (a regression) or the family is
# missing from the baseline entirely. Baseline red that hasn't gotten worse
# is reported as "ok", not a failure — see docs/debugging-tools.md. Rewrite
# the baseline (a deliberate act, never done implicitly) with:
#   make test-gadget-lua-baseline
#
# Usage:
#   tools/scripts/test-gadget-lua.sh                 # every family
#   FAMILY=<name> tools/scripts/test-gadget-lua.sh   # one family only
#   WRITE_BASELINE=1 tools/scripts/test-gadget-lua.sh  # rewrite the baseline

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GADGETS="data/games/metalstorm/LuaRules/Gadgets"
BASELINE_FILE="$REPO_ROOT/tools/scripts/gadget-baseline.json"

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
    "$GADGETS_FROM_GAME_ROOT/tests/tutorial_scenarios_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/meridian_basin_scenario_spec.lua"
    "$GADGETS_FROM_GAME_ROOT/tests/meridian_basin_soak_scenario_spec.lua"
)

cd "$REPO_ROOT"

log() { printf '\033[1m[test-gadget-lua]\033[0m %s\n' "$*"; }

if ! command -v jq >/dev/null 2>&1; then
    log "jq is required (used to read/write gadget-baseline.json) but was not found on PATH"
    exit 1
fi

FAMILY_FILTER="${FAMILY:-}"
WRITE_BASELINE="${WRITE_BASELINE:-0}"

total_s=0 total_f=0 total_e=0
declare -a RESULTS=()
declare -A FAMILY_S=() FAMILY_F=() FAMILY_E=()
declare -a FAMILY_ORDER=()
any_ran=0

run_family() {   # $1 = name, $2 = cwd (relative to repo root), $3.. = busted args
    local name="$1" dir="$2"; shift 2
    if [[ -n "$FAMILY_FILTER" && "$name" != "$FAMILY_FILTER" ]]; then
        return
    fi
    any_ran=1
    local out
    out="$(cd "$REPO_ROOT/$dir" && busted "$@" 2>&1)"
    local summary
    summary="$(printf '%s\n' "$out" | grep -E '^[0-9]+ successes' | tail -1)"
    if [[ -z "$summary" ]]; then
        RESULTS+=("ERROR $name — busted produced no summary line (see below)")
        printf '%s\n' "$out" | tail -20
        FAMILY_ORDER+=("$name")
        FAMILY_S[$name]=0; FAMILY_F[$name]=0; FAMILY_E[$name]=999999
        total_e=$((total_e + 1))
        return
    fi
    local s f e
    # busted pluralizes ("1 error", "2 errors"), so match the stem loosely.
    s="$(printf '%s' "$summary" | grep -oE '^[0-9]+')"
    f="$(printf '%s' "$summary" | grep -oE '[0-9]+ failures?' | grep -oE '^[0-9]+')"
    e="$(printf '%s' "$summary" | grep -oE '[0-9]+ errors?' | grep -oE '^[0-9]+')"
    total_s=$((total_s + s)); total_f=$((total_f + f)); total_e=$((total_e + e))
    FAMILY_ORDER+=("$name")
    FAMILY_S[$name]=$s; FAMILY_F[$name]=$f; FAMILY_E[$name]=$e
    RESULTS+=("$(printf '%-14s %s' "$name" "$summary")")
}

for entry in "${FAMILIES[@]}"; do
    IFS='|' read -r name dir args <<<"$entry"
    name="$(echo "$name" | xargs)"; dir="$(echo "$dir" | xargs)"; args="$(echo "$args" | xargs)"
    run_family "$name" "$dir" $args
done
run_family "scenario" "data/games/metalstorm" "${SCENARIO_SPECS[@]}"

if [[ -n "$FAMILY_FILTER" && "$any_ran" -eq 0 ]]; then
    log "unknown FAMILY '$FAMILY_FILTER' — valid families: authority civilians objectives parley regions gadgets-mock scenario"
    exit 1
fi

if [[ "$WRITE_BASELINE" == "1" ]]; then
    if [[ -n "$FAMILY_FILTER" ]]; then
        log "WRITE_BASELINE requires running every family — do not combine with FAMILY="
        exit 1
    fi
    tmp="$(mktemp)"
    jq -n \
        --arg comment "Known-good baseline for \`make test-gadget-lua\`, per family. A family fails the gate only when its fail or errors count EXCEEDS these numbers (a regression), not merely because they are nonzero. Rewrite with \`make test-gadget-lua-baseline\` — a deliberate act, not something the test target does itself." \
        '{"_comment": $comment}' >"$tmp"
    for name in "${FAMILY_ORDER[@]}"; do
        tmp2="$(mktemp)"
        jq --arg name "$name" \
           --argjson pass "${FAMILY_S[$name]}" \
           --argjson fail "${FAMILY_F[$name]}" \
           --argjson errors "${FAMILY_E[$name]}" \
           '. + {($name): {pass: $pass, fail: $fail, errors: $errors}}' \
           "$tmp" >"$tmp2"
        mv "$tmp2" "$tmp"
    done
    mv "$tmp" "$BASELINE_FILE"
    log "baseline rewritten: $BASELINE_FILE"
    for name in "${FAMILY_ORDER[@]}"; do
        printf '  %-14s %d successes / %d failures / %d errors\n' "$name" "${FAMILY_S[$name]}" "${FAMILY_F[$name]}" "${FAMILY_E[$name]}"
    done
    exit 0
fi

echo
log "─────────── gadget lua census ───────────"
for r in "${RESULTS[@]}"; do printf '  %s\n' "$r"; done
printf '  %-14s %d successes / %d failures / %d errors\n' "TOTAL" "$total_s" "$total_f" "$total_e"
echo

regressed=0
for name in "${FAMILY_ORDER[@]}"; do
    f="${FAMILY_F[$name]}"; e="${FAMILY_E[$name]}"
    baseline="$(jq -c --arg name "$name" '.[$name] // empty' "$BASELINE_FILE")"
    if [[ -z "$baseline" ]]; then
        printf '  %-14s MISSING FROM BASELINE (fail=%d errors=%d) — run make test-gadget-lua-baseline once this is expected\n' "$name" "$f" "$e"
        regressed=1
        continue
    fi
    bf="$(printf '%s' "$baseline" | jq -r '.fail')"
    be="$(printf '%s' "$baseline" | jq -r '.errors')"
    df=$(( f > bf ? f - bf : 0 ))
    de=$(( e > be ? e - be : 0 ))
    if (( df + de > 0 )); then
        printf '  %-14s regressed (+%d)  [baseline fail=%d errors=%d, now fail=%d errors=%d]\n' "$name" "$((df + de))" "$bf" "$be" "$f" "$e"
        regressed=1
    else
        printf '  %-14s ok  [baseline fail=%d errors=%d, now fail=%d errors=%d]\n' "$name" "$bf" "$be" "$f" "$e"
    fi
done
echo

if (( regressed )); then
    log "regression(s) found relative to tools/scripts/gadget-baseline.json — see above"
    exit 1
fi
log "no regressions relative to baseline (known pre-existing red in gadgets-mock/scenario is expected — see docs/debugging-tools.md)"
