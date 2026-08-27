#!/usr/bin/env bash
# determinism-gate.sh — the one entry point CI (or a human) calls to answer
# "is the sim deterministic, and does a recording re-execute to the same run?"
#
# Four arms, strictly ordered from cheapest to most content:
#
#   1. pair-run, PaperTanks fixture      — same manifest run twice, the two
#      stats dumps' stateHash tracks diffed frame-for-frame.
#   2. replay-verify --pack, PaperTanks  — the run RECORDED to a .msr, the
#      recorded cause stream re-executed against its own embedded hash track,
#      then the same check through the .msr export packer.
#   3. pair-run, Metalstorm fixture      — the actual game's content
#      (crossing_standoff scenario, strategos AI both sides) under the same
#      two-run diff.
#   4. replay-verify, Metalstorm fixture — the recorded Metalstorm cause
#      stream re-executed to its own track.
#
# Every arm gates on the engine's own verdict/completion log line AND a zero
# exit code (T2-b is fixed — see WeaponDefHandler.cpp; a completed run that
# exits non-zero is a defect, not noise). A vacuous run (no units / no damage /
# no deaths) is rejected before any hash is compared.
#
# Usage:
#   tools/headless-batch/determinism-gate.sh [path-to-spring-server]
# Defaults to build/debug/spring-server relative to the repo root. Exits 0
# only if every arm passed. Artefacts land under build/determinism-gate/.
set -u -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
SERVER_BIN="${1:-$REPO_ROOT/build/debug/spring-server}"
OUT_ROOT="$REPO_ROOT/build/determinism-gate"

if [ ! -x "$SERVER_BIN" ]; then
    echo "determinism-gate: no spring-server binary at $SERVER_BIN" >&2
    echo "  build one first: cmake --build build/debug --target spring-server" >&2
    exit 2
fi

fails=0
run_arm() {
    local name="$1"; shift
    echo ""
    echo "=== determinism-gate arm: $name ==="
    if "$@"; then
        echo "=== arm PASS: $name ==="
    else
        local code=$?
        echo "=== arm FAIL: $name (exit $code) ===" >&2
        fails=$((fails + 1))
    fi
}

run_arm "pair-run papertanks" \
    node "$HERE/determinism-pair-run.mjs" \
        --server-bin "$SERVER_BIN" \
        --config "$HERE/fixtures/papertanks-determinism.json" \
        --out-dir "$OUT_ROOT/pair-papertanks" \
        --port 19199

run_arm "replay-verify papertanks (packed)" \
    node "$HERE/replay-verify-run.mjs" \
        --server-bin "$SERVER_BIN" \
        --config "$HERE/fixtures/papertanks-determinism.json" \
        --out-dir "$OUT_ROOT/replay-papertanks" \
        --port 19207 \
        --pack

run_arm "pair-run metalstorm" \
    node "$HERE/determinism-pair-run.mjs" \
        --server-bin "$SERVER_BIN" \
        --config "$HERE/fixtures/metalstorm-determinism.json" \
        --out-dir "$OUT_ROOT/pair-metalstorm" \
        --port 19213

run_arm "replay-verify metalstorm" \
    node "$HERE/replay-verify-run.mjs" \
        --server-bin "$SERVER_BIN" \
        --config "$HERE/fixtures/metalstorm-determinism.json" \
        --out-dir "$OUT_ROOT/replay-metalstorm" \
        --port 19217

echo ""
if [ "$fails" -ne 0 ]; then
    echo "determinism-gate: $fails arm(s) FAILED — artefacts under $OUT_ROOT" >&2
    exit 1
fi
echo "determinism-gate: all 4 arms passed."
