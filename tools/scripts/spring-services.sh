#!/usr/bin/env bash
# Manage local spring-{lobby,server,logserver} processes and the client
# vite dev server. Useful when iterating on the engine without keeping
# mprocs open: `spring-services.sh stop` after a session, restart from
# mprocs as usual.
#
# Usage:
#   spring-services.sh status        # list running services
#   spring-services.sh stop [name]   # graceful stop (SIGTERM, then SIGKILL)
#   spring-services.sh start         # start via mprocs (foreground)
#   spring-services.sh start-bg      # start each service detached in background
#   spring-services.sh restart       # stop + start-bg
#
# `name` filters by service: lobby | server | logserver | client | all (default).

set -euo pipefail

# Resolve repo root via this script's location so the command works
# from any cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Patterns match the path tail so both absolute (`/abs/build/debug/...`)
# and relative (`./build/debug/...`) invocations are caught. Picking a
# repo-internal subpath keeps unrelated `vite`/`node` processes
# (the user's other projects) out of the match.
PAT_LOBBY="build/debug/spring-lobby"
PAT_SERVER="build/debug/spring-server"
PAT_LOGSERVER="build/debug/spring-logserver"
PAT_CLIENT="client/node_modules/.bin/vite"

# Find PIDs whose full command line contains $1. Returns nothing if
# none match. We use -f (full command line) and -- to defang any user
# string that might start with a dash.
pids_for() {
    pgrep -f -- "$1" 2>/dev/null || true
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
            >data/logs/logserver.out 2>&1 &
    else
        echo "  logserver: already running"
    fi

    if [[ -z "$(pids_for "$PAT_LOBBY")" ]]; then
        echo "  lobby: starting"
        # The lobby + game server read ONLY from data/ (converted output).
        # content/ is the unconverted source drop, relevant only to the
        # offline conversion tools (gameconverter / mapconverter). The
        # lobby defaults to --games-dir data/games and resolves maps under
        # data/maps, so no content/ paths are passed here.
        nohup ./build/debug/spring-lobby --no-cache --port 8011 \
            --db data/spring-server.db \
            >data/logs/lobby.out 2>&1 &
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

cmd_restart() {
    cmd_stop all
    cmd_start_bg
}

main() {
    local cmd="${1:-status}"
    shift || true
    case "$cmd" in
        status)   cmd_status ;;
        stop)     cmd_stop "${1:-all}" ;;
        start)    cmd_start ;;
        start-bg) cmd_start_bg ;;
        restart)  cmd_restart ;;
        -h|--help|help)
            sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            ;;
        *)
            echo "unknown command: $cmd" >&2
            echo "try: $0 help" >&2
            exit 2
            ;;
    esac
}

main "$@"
