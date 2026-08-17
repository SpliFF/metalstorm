#!/usr/bin/env bash
#
# def-reconcile-resume.sh — the war-path resume across TWO def loads.
#
# PLAN-def-reconciliation task 5. Tasks 1-4 (snapshot def vocabulary, the remap
# pass, the scalar pass, the DefsReconciled call-in) are each doctested inside
# one process against a hand-built payload. What no doctest can reach is the
# thing the whole plan is about: a world captured under one set of defs and
# restored, in a DIFFERENT PROCESS, under another. That needs two def loads,
# and every other harness in the tree has exactly one —
#   * `--snapshot-roundtrip` captures and restores inside one process, so its
#     live defs ARE the captured defs by construction; and
#   * `--headless-run` deliberately writes no exit checkpoint (Hibernation.h
#     rule 5: "its world is a fixture, not a war"), so it cannot hand a world
#     to a second process at all.
#
# So this harness builds the vehicle out of the two exits that DO carry a world
# across a process boundary — the deploy drain's own SIGTERM (ExitReason::Signal
# → exit checkpoint) and `--resume` — with a balance patch applied to the game
# tree in between. That is a deploy drain "with def changes", which is the
# variant §5 task 5 asks the persistence integration suite to grow.
#
#   run A   scratch game tree (pristine)  --headless-run --session-kind persistent
#           tick ~$TICK_SECS, SIGTERM     → hibernate:signal checkpoint in the DB
#   patch   the arm rewrites the scratch tree's unit defs
#   run B   same DB, same room, same game id, PATCHED tree, --resume
#           → the reconcile pass runs on a real world, with real gadgets up
#
# ── The two traps this harness is shaped around ─────────────────────────────
#
#  1. THE GAME ID IS NOT JUST A PATH. `data/games/<id>` is the content root, but
#     the id ALSO selects engine behaviour: GameOverState.h's elimination
#     fallback is gated off for the literal string "metalstorm" and for nothing
#     else. A scratch copy under any other id therefore plays a DIFFERENT game —
#     the fallback woke up at frame 60, declared team 0 the winner, and a
#     finished match takes no exit checkpoint (Hibernation.h rule 4), so the
#     harness silently had no world to resume. The scenario below (`roundtrip_static`,
#     which stages both team 0 and team 1) keeps both fallback teams alive, so
#     the fallback never fires whatever the id is. Do not "simplify" this to a
#     one-sided scenario.
#  2. THE CONTENT ROOT DOES NOT FOLLOW SYMLINKS. A symlink farm over the 239 MB
#     game tree looks like it works — models resolve, defs load, the sim runs —
#     and `LuaRules/main.lua` is not found, so synced Lua never comes up and the
#     snapshot serializer refuses to attach. No checkpoint, no error anybody
#     would connect to the farm. The tree is CLONED instead (`cp -Rc`, APFS
#     clonefile: 239 MB in ~0.2 s and no extra disk).
#
# Usage:
#   tools/scripts/def-reconcile-resume.sh [--arm NAME]... [--keep] [--build DIR]
#
#   --arm NAME   run only these arms (repeatable). Default: all four.
#   --keep       leave the scratch game tree, DBs and logs behind for inspection.
#   --build DIR  build directory holding spring-server (default build/debug).
#
# Exit status is the gate: 0 = every arm passed.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BUILD_DIR="build/debug"
KEEP=0
ARMS_REQUESTED=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --arm)   ARMS_REQUESTED+=("$2"); shift 2 ;;
        --keep)  KEEP=1; shift ;;
        --build) BUILD_DIR="$2"; shift 2 ;;
        -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

SERVER="$BUILD_DIR/spring-server"
# A scratch id, never "metalstorm": the harness rewrites unit defs in this tree
# and must not be able to touch the shipped game even if it dies mid-run. See
# trap 1 above for what that costs and how the scenario pays it.
SCRATCH_ID="_scratch-defrecon"
SCRATCH_GAME="data/games/$SCRATCH_ID"
PRISTINE="/tmp/defrecon-pristine-$$"
WORK="/tmp/defrecon-$$"
PORT="${DEFRECON_PORT:-9411}"
ROOM=7701
MAP="green_flat_x34_v3"
SCENARIO="roundtrip_static"
# How long run A ticks before the drain. Uncapped, so this is tens of thousands
# of frames; the exact number is read back off the checkpoint line rather than
# assumed.
TICK_SECS="${DEFRECON_TICK_SECS:-12}"
BOOT_TIMEOUT_SECS=180

fail_count=0
declare -a RESULTS=()

log()  { printf '\033[1m[defrecon]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[defrecon]\033[0m %s\n' "$*"; }

cleanup() {
    pkill -f "spring-server --port $PORT" >/dev/null 2>&1
    if [[ $KEEP -eq 1 ]]; then
        warn "--keep: left $SCRATCH_GAME, $WORK and $PRISTINE in place"
        return
    fi
    rm -rf "$SCRATCH_GAME" "$PRISTINE" "$WORK"
}
trap cleanup EXIT INT TERM

# ─────────────────────────── preflight ───────────────────────────

[[ -x "$SERVER" ]] || { echo "no server binary at $SERVER — build it first" >&2; exit 2; }
[[ -d data/games/metalstorm ]] || { echo "data/games/metalstorm is missing" >&2; exit 2; }
if pgrep -f "spring-server --port $PORT" >/dev/null 2>&1; then
    echo "something is already on port $PORT — kill it or set DEFRECON_PORT" >&2
    exit 2
fi
if [[ -e "$SCRATCH_GAME" ]]; then
    echo "$SCRATCH_GAME already exists (a previous run died with --keep?)" >&2
    exit 2
fi

mkdir -p "$WORK"

# One pristine clone, kept outside the repo. Every arm re-clones the scratch
# tree from THIS rather than from data/games/metalstorm, so a bug in a patch
# function can never reach the shipped game.
log "cloning data/games/metalstorm → pristine ($PRISTINE)"
cp -Rc data/games/metalstorm "$PRISTINE" 2>/dev/null || cp -R data/games/metalstorm "$PRISTINE"

stage_pristine() {
    rm -rf "$SCRATCH_GAME"
    cp -Rc "$PRISTINE" "$SCRATCH_GAME" 2>/dev/null || cp -R "$PRISTINE" "$SCRATCH_GAME"
}

write_fixture() {   # $1 = path, $2 = stopAt frame
    cat > "$1" <<EOF
{
  "map": "$MAP",
  "game": "$SCRATCH_ID",
  "modOptions": { "scenario": "$SCENARIO", "objective_density": "normal", "build_time_scale": "1.0" },
  "headless": { "tickMode": "uncapped", "stopAt": { "frame": $2 }, "stateHashEvery": 300 }
}
EOF
}

wait_for_line() {   # $1 = logfile, $2 = grep -E pattern, $3 = seconds
    local waited=0
    while (( waited < $3 )); do
        grep -Eq "$2" "$1" 2>/dev/null && return 0
        sleep 1; waited=$((waited + 1))
    done
    return 1
}

# ─────────────────────────── the patches ───────────────────────────
#
# Each arm is a function that rewrites the staged scratch tree. They are written
# against the shipped def sources on purpose: a patch that stops applying because
# the game was re-authored must FAIL LOUDLY here rather than quietly reconcile
# nothing and let every arm pass.

patch_control() { :; }   # the null control — same defs, second process

# Tuning only: no name and no id moves, every NUMBER does. §3 calls this the
# common balance-patch case and routes it through steps 3-4 alone.
patch_tuning() {
    local f="$SCRATCH_GAME/units/tanks.lua"
    grep -q 'baseHp = 1400' "$f" || { echo "tanks.lua no longer says baseHp = 1400" >&2; return 1; }
    sed -i '' 's/baseHp = 1400/baseHp = 2100/' "$f"
}

# A rename with a migration: `ms_tanks_s*` → `ms_panzers_s*`, aliased. The world
# holds 8 live ms_tanks_s2 (4 per side in roundtrip_static), so this is the
# renumber-and-rewrite path with units that must SURVIVE it.
patch_rename_alias() {
    local f="$SCRATCH_GAME/units/tanks.lua"
    grep -q "class = 'tanks'" "$f" || { echo "tanks.lua no longer says class = 'tanks'" >&2; return 1; }
    sed -i '' "s/class = 'tanks'/class = 'panzers'/" "$f"
    cat > "$SCRATCH_GAME/gamedata/migrations.lua" <<'EOF'
-- Written by tools/scripts/def-reconcile-resume.sh (arm: rename-alias).
return {
    units = {
        ms_tanks_s1 = 'ms_panzers_s1',
        ms_tanks_s2 = 'ms_panzers_s2',
        ms_tanks_s3 = 'ms_panzers_s3',
        ms_tanks_s4 = 'ms_panzers_s4',
    },
}
EOF
}

# The same rename with NO migration — which is what a removal looks like from
# the snapshot's side, and the arm that proves the drop path costs the war
# something it can name.
patch_rename_drop() {
    local f="$SCRATCH_GAME/units/tanks.lua"
    grep -q "class = 'tanks'" "$f" || { echo "tanks.lua no longer says class = 'tanks'" >&2; return 1; }
    sed -i '' "s/class = 'tanks'/class = 'panzers'/" "$f"
}

# ─────────────────────────── run A: capture ───────────────────────────

CAPTURE_DB="$WORK/captured.sqlite"
CAPTURE_LOG="$WORK/capture.log"

stage_pristine
write_fixture "$WORK/capture.json" 100000000

log "run A: booting the war (port $PORT, room $ROOM)"
"$SERVER" --port "$PORT" --room "$ROOM" --db "$CAPTURE_DB" \
          --session-kind persistent --headless-run "$WORK/capture.json" \
          --log-level notice > "$CAPTURE_LOG" 2>&1 &
CAPTURE_PID=$!

if ! wait_for_line "$CAPTURE_LOG" 'entering sim loop' "$BOOT_TIMEOUT_SECS"; then
    echo "run A never entered the sim loop — see $CAPTURE_LOG" >&2
    exit 1
fi
if grep -q 'sim snapshots: DISABLED' "$CAPTURE_LOG"; then
    echo "run A came up with the serializer detached — no world can be captured." >&2
    echo "(see trap 2 in this script's header: this is what a symlinked tree looks like)" >&2
    exit 1
fi
if grep -q 'GAME OVER' "$CAPTURE_LOG"; then
    echo "run A ended its own match — a finished war takes no exit checkpoint." >&2
    echo "(see trap 1 in this script's header)" >&2
    exit 1
fi

log "run A: ticking for ${TICK_SECS}s, then the drain's own SIGTERM"
sleep "$TICK_SECS"
kill -TERM "$CAPTURE_PID" 2>/dev/null
# The exit status is deliberately NOT the gate: this binary aborts in
# ~CWeaponDefHandler during static destruction (PLAN-replay T2-b/T5-c, unowned,
# routed to the crash-forensics lane). That abort happens after the checkpoint
# is flushed and after the process has said so, so the checkpoint line is the
# honest signal and the exit code is not.
wait "$CAPTURE_PID" 2>/dev/null
CAPTURE_FRAME="$(grep -oE 'checkpointed at frame [0-9]+' "$CAPTURE_LOG" | tail -1 | grep -oE '[0-9]+')"
if [[ -z "${CAPTURE_FRAME:-}" ]]; then
    echo "run A left no exit checkpoint — see $CAPTURE_LOG" >&2
    grep -E 'hibernate:' "$CAPTURE_LOG" >&2 || true
    exit 1
fi
CAPTURE_DEFS_HASH="$(grep -oE 'defsHash [0-9a-f]+' "$CAPTURE_LOG" | tail -1 | awk '{print $2}')"
CAPTURE_UNITS="$(sqlite3 "$CAPTURE_DB" \
    "select count(*) from game_snapshots where room_id=$ROOM;" 2>/dev/null)"
log "run A: checkpointed at frame $CAPTURE_FRAME (defsHash $CAPTURE_DEFS_HASH, $CAPTURE_UNITS snapshot row(s))"

# ─────────────────────────── run B: resume per arm ───────────────────────────

# Each arm: expected-present patterns, expected-absent patterns. The absences
# carry as much as the presences — an arm that reconciles MORE than it should
# (a tuning patch that renumbers, a control that reconciles at all) is exactly
# the failure a presence-only check reads as success.
run_arm() {   # $1 = arm name, $2 = patch fn
    local arm="$1" patch="$2"
    local db="$WORK/$arm.sqlite" logf="$WORK/$arm.log" fixture="$WORK/$arm.json"
    local stop=$((CAPTURE_FRAME + 300))

    stage_pristine
    if ! "$patch"; then
        RESULTS+=("FAIL  $arm — the patch did not apply (the game was re-authored under it)")
        fail_count=$((fail_count + 1))
        return
    fi
    cp "$CAPTURE_DB" "$db"
    write_fixture "$fixture" "$stop"

    # `info`, not `notice`, and only on run B. Two of the reconcile pass's four
    # report lines are INFO — "defs moved under this snapshot" (the vocabulary
    # diff) and "no def reference needed rewriting" (the tuning-only fast path)
    # — so at the server's own default level a RENAME is reported by its
    # consequences alone. That is a real gap for an operator reading a live
    # war's log and it is filed in PLAN-def-reconciliation task 5; here it just
    # means the harness has to ask for the lines it wants to check.
    log "arm $arm: resuming frame $CAPTURE_FRAME → $stop under patched defs"
    "$SERVER" --port "$PORT" --room "$ROOM" --db "$db" --resume \
              --session-kind persistent --headless-run "$fixture" \
              --log-level info > "$logf" 2>&1 &
    local pid=$!
    if ! wait_for_line "$logf" 'headless run: stopping|resume: |sim loop' $((BOOT_TIMEOUT_SECS + 120)); then
        kill -TERM $pid 2>/dev/null; wait $pid 2>/dev/null
        RESULTS+=("FAIL  $arm — run B never got as far as the resume (see $logf)")
        fail_count=$((fail_count + 1))
        return
    fi
    # Let it finish its own 300 ticks: "the world came back" is not the claim,
    # "the world came back and kept simulating" is.
    local waited=0
    while kill -0 $pid 2>/dev/null && (( waited < 240 )); do sleep 2; waited=$((waited + 2)); done
    kill -TERM $pid 2>/dev/null
    wait $pid 2>/dev/null

    # Each arm asserts the whole chain it is supposed to drive — the engine's
    # three report lines, the call-in reaching a gadget, and the durable row the
    # game wrote — and the SHAPE of the numbers, not just their presence. The
    # absences carry as much as the presences: an arm that reconciles MORE than
    # it should (a tuning patch that renumbers, a control that reconciles at
    # all) is exactly the failure a presence-only check reads as success.
    local -a want=() nope=()
    local want_summary=""
    case "$arm" in
        control)
            # A second process over the same defs must be indistinguishable from
            # no patch at all — including the NOTICE tripwire line, whose
            # "authored" counts are the only production check that
            # CaptureDefScalars still mirrors CUnit::PreInit.
            want=('snapshot restore: .*authored by the game')
            nope=('snapshot restore: defs moved' 'reconciling def references'
                  'reconciling def scalars' 'defs reconciled: digest')
            ;;
        tuning)
            # Names and ids hold still; every number moves. §3's common case.
            want=('snapshot restore: reconciling def scalars - [0-9]+ unit .*retuned.*ms_tanks'
                  '[0-9]+ unit health fractions preserved'
                  'defs reconciled: digest carries 0 of 0 removed unit def')
            nope=('snapshot restore: defs moved' 'reconciling def references'
                  'units lost' 'units removed with their def')
            want_summary='units retuned'
            ;;
        rename-alias)
            # The renumber-and-rewrite path with units that must SURVIVE it.
            want=('snapshot restore: defs moved under this snapshot - units: [0-9]+ renumbered'
                  'snapshot restore: reconciling def references - [0-9]+ units renamed'
                  'defs reconciled: digest carries 0 of 0 removed unit def')
            nope=('units lost' 'units removed with their def')
            # And this is what the player is told: an aliased rename costs the
            # war nothing it can see, which is the whole point of shipping a
            # migration. The digest still fires — "a patch landed and touched
            # nothing you can see" is the answer to "why did the game restart".
            want_summary='no visible change'
            ;;
        rename-drop)
            # The same rename with no migration: the units go, and the war is
            # told which defs took them.
            want=('snapshot restore: defs moved under this snapshot - units: [0-9]+ renumbered'
                  'snapshot restore: reconciling def references - [0-9]+ units removed with their def'
                  'defs reconciled: digest carries [1-9][0-9]* of [1-9][0-9]* removed unit def')
            nope=('units renamed')
            want_summary='units lost'
            ;;
    esac

    local ok=1 detail=""
    for p in "${want[@]}"; do
        if ! grep -Eq "$p" "$logf"; then ok=0; detail="$detail; missing /$p/"; fi
    done
    for p in "${nope[@]:-}"; do
        [[ -z "$p" ]] && continue
        if grep -Eq "$p" "$logf"; then ok=0; detail="$detail; unexpected /$p/"; fi
    done
    # The resume must not have been fatal, and the sim must have moved past the
    # frame it was restored at.
    if grep -Eq 'resume FAILED|hibernate: room .* resume: .*refus' "$logf"; then
        ok=0; detail="$detail; the resume itself refused"
    fi
    local last_frame
    last_frame="$(grep -oE 'shutting down \(frame [0-9]+\)' "$logf" | tail -1 | grep -oE '[0-9]+')"
    if [[ -z "${last_frame:-}" ]] || (( last_frame <= CAPTURE_FRAME )); then
        ok=0; detail="$detail; the resumed world did not simulate past frame $CAPTURE_FRAME (last=${last_frame:-none})"
    fi
    # The game's own half: the digest reaches the durable war log, not just a
    # log line. `patch` rows are what a returning player is shown.
    local patch_rows
    patch_rows="$(sqlite3 "$db" "select count(*) from game_events where kind='patch';" 2>/dev/null)"
    patch_rows="${patch_rows:-0}"
    if [[ "$arm" == "control" ]]; then
        (( patch_rows == 0 )) || { ok=0; detail="$detail; the control wrote $patch_rows patch event(s)"; }
    else
        (( patch_rows > 0 )) || { ok=0; detail="$detail; no patch row reached game_events"; }
        local summary
        summary="$(sqlite3 "$db" \
            "select subject from game_events where kind='patch' and detail='summary' limit 1;" 2>/dev/null)"
        if [[ "$summary" != *"$want_summary"* ]]; then
            ok=0; detail="$detail; the war log's patch summary reads '${summary:-<none>}', wanted '*$want_summary*'"
        fi
    fi
    if [[ "$arm" == "rename-drop" ]]; then
        # The per-def lines, not just the summary: a returning player is shown
        # WHICH defs took their army.
        local named
        named="$(sqlite3 "$db" \
            "select count(*) from game_events where kind='patch' and detail='removed' and subject like 'ms_tanks_%';" 2>/dev/null)"
        (( ${named:-0} > 0 )) || { ok=0; detail="$detail; no removed-def line named ms_tanks_* in the war log"; }
    fi

    if (( ok )); then
        RESULTS+=("PASS  $arm — resumed at $CAPTURE_FRAME, ran to ${last_frame}, $patch_rows patch event(s)")
    else
        RESULTS+=("FAIL  $arm —${detail} (log: $logf)")
        fail_count=$((fail_count + 1))
    fi
}

ALL_ARMS=(control tuning rename-alias rename-drop)
if [[ ${#ARMS_REQUESTED[@]} -gt 0 ]]; then
    ALL_ARMS=("${ARMS_REQUESTED[@]}")
fi

for arm in "${ALL_ARMS[@]}"; do
    case "$arm" in
        control)      run_arm control      patch_control ;;
        tuning)       run_arm tuning       patch_tuning ;;
        rename-alias) run_arm rename-alias patch_rename_alias ;;
        rename-drop)  run_arm rename-drop  patch_rename_drop ;;
        *) echo "unknown arm: $arm" >&2; exit 2 ;;
    esac
done

echo
log "─────────── def-reconciliation task 5: resume across two def loads ───────────"
printf '      capture: frame %s, defsHash %s\n' "$CAPTURE_FRAME" "$CAPTURE_DEFS_HASH"
for r in "${RESULTS[@]}"; do printf '      %s\n' "$r"; done
echo

if (( fail_count > 0 )); then
    log "$fail_count arm(s) FAILED"
    exit 1
fi
log "all ${#ALL_ARMS[@]} arm(s) passed"
