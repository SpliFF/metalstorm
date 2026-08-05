#!/usr/bin/env bash
# Manage local spring-{lobby,server,logserver} processes and the client
# vite dev server. Useful when iterating on the engine without keeping
# mprocs open: `spring-services.sh stop` after a session, restart from
# mprocs as usual.
#
# Usage:
#   spring-services.sh status         # list running services + mprocs-ctl reachability
#   spring-services.sh stop [name]    # graceful stop (SIGTERM, then SIGKILL)
#   spring-services.sh start          # start via mprocs (foreground)
#   spring-services.sh start-bg       # start each service detached in background
#   spring-services.sh restart [name] # restart a pane via mprocs control (clean,
#                                     #   keeps the pane alive); falls back to
#                                     #   kill+start-bg if the control server is down
#   spring-services.sh ctl '<yaml>'   # send a raw command to the running mprocs,
#                                     #   e.g. ctl '{c: restart-all}'
#
# `name` filters by service: lobby | server | logserver | client | all (default).
# For `restart`, `name` may also be an mprocs-only pane: game-logs | lua-errors.
#
# Per-pane restart drives the mprocs remote-control server (mprocs.yaml `server:`
# key). The C++ servers can ALSO self-re-exec in place (restart_lobby /
# restart_logserver / restart_game MCP tools, or SIGHUP) — prefer those when you
# only need to bounce a rebuilt C++ binary. Use `restart client` for the Vite dev
# server, which has no in-place re-exec and otherwise serves a stale `?worker`
# bundle after a worker-file edit.

set -euo pipefail

# Resolve repo root via this script's location so the command works
# from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Patterns match the path tail so both absolute (`/abs/build/debug/...`)
# and relative (`./build/debug/...`) invocations are caught. Picking a
# repo-internal subpath keeps unrelated `vite`/`node` processes
# (the user's other projects) out of the match.
#
# Both build dirs, spelled out. These used to name `build/debug/` only, so a
# service launched from `build/release/` — which is what the lobby spawns game
# servers from when it exists, and how the stack is often started by hand —
# was invisible to `stop` and `status`: both reported "nothing to stop" with a
# live process still holding :8011/:8010/:9100. The next launch then either
# raced it or silently tested the old binary.
#
# The alternation is deliberate; a `.` wildcard here is NOT safe. `build/.*/
# spring-server` also matches the LOBBY, whose command line carries
# `--db data/spring-server.db` — `.*` happily spans the gap, so a "kill the
# game servers" call takes the lobby down with it.
PAT_LOBBY="build/(debug|release)/spring-lobby"
PAT_SERVER="build/(debug|release)/spring-server"
PAT_LOGSERVER="build/(debug|release)/spring-logserver"
PAT_CLIENT="client/node_modules/.bin/vite"

# Find PIDs whose full command line contains $1. Returns nothing if
# none match. We use -f (full command line) and -- to defang any user
# string that might start with a dash.
pids_for() {
    pgrep -f -- "$1" 2>/dev/null || true
}

# --- mprocs remote control -------------------------------------------------
# The mprocs.yaml `server:` key makes the running mprocs listen for ctl
# commands (`mprocs --ctl '{c: ...}'`). Restarting a pane THROUGH mprocs —
# rather than pattern-killing it — keeps mprocs authoritative: no dead pane,
# no duplicate listener racing the port. This is the clean way to bounce the
# Vite `client` (no in-place re-exec) and the log-tail panes. Falls back to
# kill+start-bg when the control server is unreachable (e.g. mprocs was
# started before `server:` was configured, or isn't running at all).
MPROCS_CONFIG="$REPO_ROOT/mprocs.yaml"

# Control server address: env override > mprocs.yaml `server:` > default.
mprocs_server_addr() {
    local addr=""
    [[ -f "$MPROCS_CONFIG" ]] && addr=$(awk '/^server:[[:space:]]/{print $2; exit}' "$MPROCS_CONFIG")
    echo "${MPROCS_SERVER:-${addr:-127.0.0.1:4050}}"
}

# Proc names in mprocs.yaml declaration order (index 0 = first). mprocs
# `select-proc` addresses panes by index, so we translate name -> index from
# the config to stay correct if panes are reordered.
mprocs_proc_names() {
    [[ -f "$MPROCS_CONFIG" ]] || return 0
    awk '
        /^procs:[[:space:]]*$/            { inprocs=1; next }
        inprocs && /^[^[:space:]#]/       { inprocs=0 }
        inprocs && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ {
            name=$1; sub(/:.*/, "", name); print name
        }
    ' "$MPROCS_CONFIG"
}

mprocs_proc_index() {
    local want="$1" i=0 name
    while IFS= read -r name; do
        [[ "$name" == "$want" ]] && { echo "$i"; return 0; }
        i=$((i + 1))
    done < <(mprocs_proc_names)
    return 1
}

# True when the mprocs remote-control server is listening on its port.
#
# IMPORTANT: this is a NON-connecting check (lsof LISTEN). Do NOT probe by
# opening a raw socket: mprocs' control server tries to deserialize whatever
# arrives on an accepted connection, so an empty connect+close makes it fail
# with `invalid type: … expected internally tagged enum AppEvent` — which can
# take mprocs down. Only ever hand the server complete `--ctl` commands
# (mprocs_ctl below); never a bare connection. `mprocs --ctl`'s own exit code
# is useless here too (it prints "Connection refused" but still exits 0), so
# a listen check is both safer and more reliable. Requires lsof; if absent we
# report "not reachable" and callers take the kill+relaunch fallback.
mprocs_ctl_available() {
    command -v mprocs >/dev/null 2>&1 || return 1
    command -v lsof   >/dev/null 2>&1 || return 1
    local addr port
    addr=$(mprocs_server_addr); port=${addr##*:}
    [[ -n "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null)" ]]
}

# A pane's `shell:` command from mprocs.yaml, so the kill+start-bg fallback
# launches the exact command mprocs would. start-bg/restart used to hardcode
# a parallel arg list that drifted (dropped --dev-direct-start and the
# --game/--maps/--games-dir set), breaking /api/rooms/direct after a fallback
# lobby restart.
mprocs_proc_shell() {
    grep -A3 "^  $1:" "$MPROCS_CONFIG" | grep -m1 'shell:' \
        | sed -e 's/^[^"]*"//' -e 's/"[[:space:]]*$//'
}

# Send a raw ctl command to the running mprocs. Runs from REPO_ROOT so mprocs
# reads this repo's mprocs.yaml (and thus the right `server:` address).
mprocs_ctl() {
    command -v mprocs >/dev/null 2>&1 || { echo "mprocs not on PATH" >&2; return 1; }
    ( cd "$REPO_ROOT" && mprocs --ctl "$1" )
}

list_service() {
    local label="$1" pattern="$2"
    local pids
    pids=$(pids_for "$pattern")
    if [[ -z "$pids" ]]; then
        printf '  %-10s  (not running)\n' "$label"
        return
    fi
    while read -r pid; do
        local args
        args=$(ps -p "$pid" -o args= 2>/dev/null | sed 's/^ *//')
        # Strip the absolute path prefix to keep the line readable.
        args=${args//${REPO_ROOT}\/}
        printf '  %-10s  pid=%-7s %s\n' "$label" "$pid" "$args"
    done <<<"$pids"
}

cmd_status() {
    echo "Spring services in $REPO_ROOT:"
    list_service lobby     "$PAT_LOBBY"
    list_service server    "$PAT_SERVER"
    list_service logserver "$PAT_LOGSERVER"
    list_service client    "$PAT_CLIENT"
    if mprocs_ctl_available; then
        printf '  %-10s  reachable at %s (per-pane restart available)\n' \
            "mprocs-ctl" "$(mprocs_server_addr)"
    else
        printf '  %-10s  not reachable at %s (restart mprocs to enable per-pane control)\n' \
            "mprocs-ctl" "$(mprocs_server_addr)"
    fi
}

# Send SIGTERM to all PIDs matching the pattern, wait up to 5 seconds
# for them to exit, then SIGKILL anything still alive. Doesn't error
# if no matches.
stop_pattern() {
    local label="$1" pattern="$2"
    local pids
    pids=$(pids_for "$pattern")
    if [[ -z "$pids" ]]; then
        echo "  $label: nothing to stop"
        return
    fi

    local pid_list
    pid_list=$(echo "$pids" | tr '\n' ' ')
    echo "  $label: SIGTERM -> $pid_list"
    # shellcheck disable=SC2086
    kill $pid_list 2>/dev/null || true

    # Poll for exit (up to ~5s)
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        local remaining
        remaining=$(pids_for "$pattern")
        [[ -z "$remaining" ]] && return
        sleep 0.5
    done

    local still
    still=$(pids_for "$pattern" | tr '\n' ' ')
    if [[ -n "$still" ]]; then
        echo "  $label: SIGKILL -> $still"
        # shellcheck disable=SC2086
        kill -9 $still 2>/dev/null || true
    fi
}

cmd_stop() {
    local target="${1:-all}"
    case "$target" in
        all)
            # Order: client first (cheap), then game servers (children
            # of lobby), then lobby, then logserver. Stops cascading
            # writes to debug.db before the consumer goes away.
            stop_pattern client    "$PAT_CLIENT"
            stop_pattern server    "$PAT_SERVER"
            stop_pattern lobby     "$PAT_LOBBY"
            stop_pattern logserver "$PAT_LOGSERVER"
            ;;
        lobby)     stop_pattern lobby     "$PAT_LOBBY" ;;
        server)    stop_pattern server    "$PAT_SERVER" ;;
        logserver) stop_pattern logserver "$PAT_LOGSERVER" ;;
        client)    stop_pattern client    "$PAT_CLIENT" ;;
        *)
            echo "unknown service: $target (expected: all|lobby|server|logserver|client)" >&2
            exit 2
            ;;
    esac
}

# Foreground start: defer to mprocs so the user gets the same TUI
# they're used to. The script doesn't try to reimplement what mprocs
# already does well.
cmd_start() {
    if ! command -v mprocs >/dev/null 2>&1; then
        echo "mprocs not on PATH — install it (cargo install mprocs) or use 'start-bg'." >&2
        exit 1
    fi
    cd "$REPO_ROOT"
    exec mprocs
}

# Detached start: launch each service in the background with logs in
# data/logs/. Useful for CI/automation where mprocs doesn't apply.
cmd_start_bg() {
    cd "$REPO_ROOT"
    mkdir -p data/logs

    if [[ ! -x build/debug/spring-logserver ]]; then
        echo "build/debug/spring-logserver not found — run 'make build' first." >&2
        exit 1
    fi

    if [[ -z "$(pids_for "$PAT_LOGSERVER")" ]]; then
        echo "  logserver: starting"
        nohup ./build/debug/spring-logserver --port 8010 --db data/debug.db \
            --i-understand-this-is-a-dev-build \
            >data/logs/logserver.out 2>&1 &
    else
        echo "  logserver: already running"
    fi

    if [[ -z "$(pids_for "$PAT_LOBBY")" ]]; then
        echo "  lobby: starting"
        # Launch with the mprocs.yaml pane command so the fallback path can
        # never drift from what mprocs runs (--dev-direct-start etc.).
        local lobby_cmd
        lobby_cmd="$(mprocs_proc_shell lobby)"
        [[ -n "$lobby_cmd" ]] || lobby_cmd="./build/debug/spring-lobby --no-cache --port 8011 --db data/spring-server.db --i-understand-this-is-a-dev-build"
        nohup bash -c "$lobby_cmd" >data/logs/lobby.out 2>&1 &
    else
        echo "  lobby: already running"
    fi

    if [[ -z "$(pids_for "$PAT_CLIENT")" ]]; then
        echo "  client: starting"
        ( cd client && GAME_SERVER_PORT=8011 \
            nohup npx vite dev --port 8012 \
            >../data/logs/client.out 2>&1 & )
    else
        echo "  client: already running"
    fi

    sleep 1
    cmd_status
}

# Restart one pane (or all) through mprocs when the control server is up,
# else fall back to kill+start-bg. Going through mprocs keeps the pane alive
# and authoritative — the only clean way to bounce the Vite `client` after a
# worker-file edit (its `?worker` bundle is otherwise served stale) without
# leaving a dead pane behind.
cmd_restart() {
    local target="${1:-all}"

    if mprocs_ctl_available; then
        if [[ "$target" == "all" ]]; then
            echo "  mprocs: restart-all"
            mprocs_ctl '{c: restart-all}'
        else
            local idx
            if ! idx=$(mprocs_proc_index "$target"); then
                echo "unknown mprocs pane: $target (known: $(mprocs_proc_names | tr '\n' ' '))" >&2
                exit 2
            fi
            echo "  mprocs: restart pane '$target' (index $idx)"
            # select the pane, then soft-kill+restart it. batch runs in order.
            mprocs_ctl "{c: batch, cmds: [{c: select-proc, index: $idx}, {c: restart-proc}]}"
        fi
        return
    fi

    # Fallback: no control server. kill+start-bg only knows the long-running
    # services (not the mprocs-only log-tail panes).
    echo "  mprocs control server not reachable ($(mprocs_server_addr)) — using kill+relaunch fallback." >&2
    echo "  (restart mprocs with the updated mprocs.yaml to enable clean per-pane restarts.)" >&2
    case "$target" in
        all)
            cmd_stop all
            cmd_start_bg
            ;;
        lobby|server|logserver|client)
            cmd_stop "$target"
            cmd_start_bg
            ;;
        game-logs|lua-errors)
            echo "  '$target' is an mprocs-only pane — needs the control server (no kill+relaunch fallback)." >&2
            exit 1
            ;;
        *)
            echo "unknown service for restart: $target (expected: all|lobby|server|logserver|client|game-logs|lua-errors)" >&2
            exit 2
            ;;
    esac
}

# Pass a raw ctl command straight through to the running mprocs.
cmd_ctl() {
    if [[ $# -eq 0 || -z "${1:-}" ]]; then
        echo "usage: $0 ctl '<yaml command>'   e.g. ctl '{c: restart-all}'" >&2
        exit 2
    fi
    if ! mprocs_ctl_available; then
        echo "mprocs control server not reachable ($(mprocs_server_addr))." >&2
        echo "Is mprocs running with the 'server:' key in mprocs.yaml? (restart mprocs to pick it up)" >&2
        exit 1
    fi
    mprocs_ctl "$1"
}

main() {
    local cmd="${1:-status}"
    shift || true
    case "$cmd" in
        status)   cmd_status ;;
        stop)     cmd_stop "${1:-all}" ;;
        start)    cmd_start ;;
        start-bg) cmd_start_bg ;;
        restart)  cmd_restart "${1:-all}" ;;
        ctl)      cmd_ctl "$@" ;;
        -h|--help|help)
            sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            ;;
        *)
            echo "unknown command: $cmd" >&2
            echo "try: $0 help" >&2
            exit 2
            ;;
    esac
}

main "$@"
