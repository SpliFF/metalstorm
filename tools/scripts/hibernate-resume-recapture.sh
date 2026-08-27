#!/usr/bin/env bash
#
# hibernate-resume-recapture.sh — snapshot idempotence across a REAL process
# boundary (PLAN-persistence §8's re-capture bar, fresh-process arm).
#
# `--snapshot-roundtrip` asserts capture→apply→re-capture idempotence inside
# ONE process. The wind defect (§8, 2026-08-12) is the record of why that arm
# structurally understates a resume: state the capture misses is INHERITED
# live by a same-process restore, so the re-capture can agree by accident —
# only a fresh process shows the missed state re-initialised. This harness
# closes that gap with the exact cycle a real hibernate/resume runs:
#
#   run A   --headless-run, tick ~$TICK_SECS, SIGTERM
#           → hibernate:signal exit checkpoint in the DB (frame F1)
#   run B   fresh process, --resume --resume-verify
#           → boot resume applies the F1 payload, re-captures the world
#             before anything ticks, byte-compares, prints the verdict, exits
#   run C   fresh process, --resume (normal), tick on past F1, SIGTERM
#           → a SECOND exit checkpoint (frame F2 > F1) written by a process
#             that was itself resumed
#   run D   fresh process, --resume --resume-verify
#           → the F2 payload round-trips byte-identically too
#
# Two arms, both required by default:
#   static   roundtrip_static on green_flat_x34_v3 — 26 units, no orders. The
#            baseline: nothing moving, nothing planning.
#   moving   meridian_basin_soak with three strategos AIs — the world the
#            re-capture bar caught its three restore defects on. Movement
#            makes the CONTINUATION diverge by design (§7.1c re-derivation);
#            the immediate re-capture must still be byte-exact.
#
# The verdict sentinel is the gate, never the exit code: a debug build aborts
# in static destructors on every exit (PLAN-replay T5-c), so $? is a lie.
# The sentinels are printed by rts/Server/ResumeVerify.cpp — a wording change
# there must move this script in the same commit:
#     resume verify: recapture IDENTICAL
#     resume verify: recapture DIFFERS
#
# Usage:
#   tools/scripts/hibernate-resume-recapture.sh [--arm static|moving]...
#                                               [--keep] [--build DIR]
#
#   --arm NAME   run only these arms (repeatable). Default: both.
#   --keep       leave the DBs and logs behind for inspection.
#   --build DIR  build directory holding spring-server (default build/debug).
#
# Exit status: 0 = every arm passed every cycle.

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
        -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

SERVER="$BUILD_DIR/spring-server"
WORK="${TMPDIR:-/tmp}/hib-recapture-$$"
PORT="${HIBRECAP_PORT:-9421}"
ROOM=7801
# How long run A / run C tick before the SIGTERM. Uncapped tick mode, so this
# is thousands of frames; the exact frame is read back off the checkpoint line.
TICK_SECS="${HIBRECAP_TICK_SECS:-12}"
BOOT_TIMEOUT_SECS="${HIBRECAP_BOOT_TIMEOUT_SECS:-300}"

fail_count=0
declare -a RESULTS=()

log()  { printf '\033[1m[hib-recapture]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[hib-recapture]\033[0m %s\n' "$*"; }

cleanup() {
    pkill -f "spring-server --port $PORT" >/dev/null 2>&1
    if [[ $KEEP -eq 1 ]]; then
        warn "--keep: left $WORK in place"
        return
    fi
    rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

[[ -x "$SERVER" ]] || { echo "no server binary at $SERVER — build it first" >&2; exit 2; }
[[ -d data/games/metalstorm ]] || { echo "data/games/metalstorm is missing" >&2; exit 2; }
if pgrep -f "spring-server --port $PORT" >/dev/null 2>&1; then
    echo "something is already on port $PORT — kill it or set HIBRECAP_PORT" >&2
    exit 2
fi

mkdir -p "$WORK"

# The fixtures are written here rather than pointed at tools/headless-batch/
# fixtures/ because those carry their own stopAt frames — a headless stop
# takes NO exit checkpoint (Hibernation.h: "its world is a fixture, not a
# war"), so the SIGTERM must always land first. stopAt is effectively-never.
write_fixture_static() {   # $1 = path
    cat > "$1" <<'EOF'
{
  "map": "green_flat_x34_v3",
  "game": "metalstorm",
  "modOptions": { "scenario": "roundtrip_static", "objective_density": "normal", "build_time_scale": "1.0" },
  "headless": { "tickMode": "uncapped", "stopAt": { "frame": 100000000 }, "stateHashEvery": 3600 }
}
EOF
}

write_fixture_moving() {   # $1 = path
    cat > "$1" <<'EOF'
{
  "map": "meridian_basin",
  "game": "metalstorm",
  "aiSlots": [
    { "aiId": "strategos", "team": 0, "startPos": 0 },
    { "aiId": "strategos", "team": 4, "startPos": 1 },
    { "aiId": "strategos", "team": 8, "startPos": 2 }
  ],
  "modOptions": { "scenario": "meridian_basin_soak", "objective_density": "normal", "build_time_scale": "1.0" },
  "headless": { "tickMode": "uncapped", "stopAt": { "frame": 100000000 }, "stateHashEvery": 3600 }
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

# Boot a capture run, SIGTERM it after $TICK_SECS, echo the checkpoint frame.
# $1 = db, $2 = fixture, $3 = log, $4 = "" or --resume
capture_run() {
    local db="$1" fixture="$2" logf="$3" resume_flag="${4:-}"
    "$SERVER" --port "$PORT" --room "$ROOM" --db "$db" $resume_flag \
              --session-kind persistent --headless-run "$fixture" \
              --log-level notice > "$logf" 2>&1 &
    local pid=$!
    if ! wait_for_line "$logf" 'entering sim loop' "$BOOT_TIMEOUT_SECS"; then
        kill -TERM $pid 2>/dev/null; wait $pid 2>/dev/null
        echo "BOOT_TIMEOUT"; return
    fi
    if grep -q 'sim snapshots: DISABLED' "$logf"; then
        kill -TERM $pid 2>/dev/null; wait $pid 2>/dev/null
        echo "SERIALIZER_DETACHED"; return
    fi
    if [[ -n "$resume_flag" ]] && ! grep -Eq 'resumed at frame [0-9]+' "$logf"; then
        kill -TERM $pid 2>/dev/null; wait $pid 2>/dev/null
        echo "NO_RESUME_LINE"; return
    fi
    sleep "$TICK_SECS"
    if grep -q 'GAME OVER' "$logf"; then
        # A finished war takes no exit checkpoint (Hibernation.h rule 4).
        kill -TERM $pid 2>/dev/null; wait $pid 2>/dev/null
        echo "GAME_OVER"; return
    fi
    kill -TERM $pid 2>/dev/null
    # Exit status deliberately not read — see the header. The checkpoint line
    # is the honest signal.
    wait $pid 2>/dev/null
    local frame
    frame="$(grep -oE 'checkpointed at frame [0-9]+' "$logf" | tail -1 | grep -oE '[0-9]+')"
    echo "${frame:-NO_CHECKPOINT}"
}

# Boot a verify run (--resume --resume-verify): it exits by itself after the
# verdict. Echo IDENTICAL, DIFFERS, or a failure token.
# $1 = db, $2 = fixture, $3 = log
verify_run() {
    local db="$1" fixture="$2" logf="$3"
    "$SERVER" --port "$PORT" --room "$ROOM" --db "$db" --resume --resume-verify \
              --session-kind persistent --headless-run "$fixture" \
              --log-level notice > "$logf" 2>&1 &
    local pid=$!
    if ! wait_for_line "$logf" 'resume verify: recapture|resume verify: re-capture FAILED|resume REFUSED' "$BOOT_TIMEOUT_SECS"; then
        kill -TERM $pid 2>/dev/null; wait $pid 2>/dev/null
        echo "VERDICT_TIMEOUT"; return
    fi
    # Give the process a moment to finish its own exit, then make sure it is
    # gone — the verdict is already on disk either way.
    local waited=0
    while kill -0 $pid 2>/dev/null && (( waited < 30 )); do sleep 1; waited=$((waited + 1)); done
    kill -KILL $pid 2>/dev/null
    wait $pid 2>/dev/null
    if grep -q 'resume verify: recapture IDENTICAL' "$logf"; then
        echo "IDENTICAL"
    elif grep -q 'resume verify: recapture DIFFERS' "$logf"; then
        echo "DIFFERS"
    else
        echo "NO_VERDICT"
    fi
}

run_arm() {   # $1 = arm name, $2 = fixture writer fn
    local arm="$1" writer="$2"
    local db="$WORK/$arm.sqlite" fixture="$WORK/$arm.json"
    "$writer" "$fixture"

    log "arm $arm — run A: capture (tick ${TICK_SECS}s, then SIGTERM)"
    local f1
    f1="$(capture_run "$db" "$fixture" "$WORK/$arm-a.log")"
    if ! [[ "$f1" =~ ^[0-9]+$ ]]; then
        RESULTS+=("FAIL  $arm — run A: $f1 (log: $WORK/$arm-a.log)")
        fail_count=$((fail_count + 1)); return
    fi
    log "arm $arm — run A checkpointed at frame $f1"

    log "arm $arm — run B: fresh-process re-capture verify of frame $f1"
    local v1
    v1="$(verify_run "$db" "$fixture" "$WORK/$arm-b.log")"
    if [[ "$v1" != "IDENTICAL" ]]; then
        RESULTS+=("FAIL  $arm — run B verdict: $v1 (log: $WORK/$arm-b.log)")
        grep -E 'resume verify|resume REFUSED|resumed at frame' "$WORK/$arm-b.log" | tail -5 >&2 || true
        fail_count=$((fail_count + 1)); return
    fi

    log "arm $arm — run C: resume, tick on, SIGTERM again"
    local f2
    f2="$(capture_run "$db" "$fixture" "$WORK/$arm-c.log" --resume)"
    if ! [[ "$f2" =~ ^[0-9]+$ ]]; then
        RESULTS+=("FAIL  $arm — run C: $f2 (log: $WORK/$arm-c.log)")
        fail_count=$((fail_count + 1)); return
    fi
    if (( f2 <= f1 )); then
        RESULTS+=("FAIL  $arm — run C did not simulate past frame $f1 (checkpointed $f2)")
        fail_count=$((fail_count + 1)); return
    fi

    log "arm $arm — run D: re-capture verify of the RESUMED process's checkpoint (frame $f2)"
    local v2
    v2="$(verify_run "$db" "$fixture" "$WORK/$arm-d.log")"
    if [[ "$v2" != "IDENTICAL" ]]; then
        RESULTS+=("FAIL  $arm — run D verdict: $v2 (log: $WORK/$arm-d.log)")
        grep -E 'resume verify|resume REFUSED|resumed at frame' "$WORK/$arm-d.log" | tail -5 >&2 || true
        fail_count=$((fail_count + 1)); return
    fi

    local bytes
    bytes="$(grep -oE 'recapture IDENTICAL — [0-9]+ bytes' "$WORK/$arm-d.log" | grep -oE '[0-9]+' | head -1)"
    RESULTS+=("PASS  $arm — F1=$f1 verified, resumed→F2=$f2 verified (${bytes:-?} bytes)")
}

ALL_ARMS=(static moving)
if [[ ${#ARMS_REQUESTED[@]} -gt 0 ]]; then
    ALL_ARMS=("${ARMS_REQUESTED[@]}")
fi

for arm in "${ALL_ARMS[@]}"; do
    case "$arm" in
        static) run_arm static write_fixture_static ;;
        moving) run_arm moving write_fixture_moving ;;
        *) echo "unknown arm: $arm" >&2; exit 2 ;;
    esac
done

echo
log "───────── hibernate → resume → re-capture idempotence (PLAN-persistence §8) ─────────"
for r in "${RESULTS[@]}"; do printf '      %s\n' "$r"; done
echo

if (( fail_count > 0 )); then
    log "$fail_count arm(s) FAILED"
    exit 1
fi
log "all ${#ALL_ARMS[@]} arm(s) passed"
