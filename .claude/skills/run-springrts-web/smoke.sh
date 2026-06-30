#!/usr/bin/env bash
# smoke.sh — bring up / verify the Spring RTS Web stack and prove the HTTP
# plane is live. This is the lifecycle + server-smoke half of the run harness;
# game launch + browser driving is done with the spring-debug / chrome-devtools
# MCP tools (see SKILL.md "Run (agent path)").
#
# Usage:
#   .claude/skills/run-springrts-web/smoke.sh          # verify (don't start)
#   .claude/skills/run-springrts-web/smoke.sh --start  # start stack if down, then verify
#
# Exit 0 = lobby HTTP plane responds and serves games+maps.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

LOBBY=http://localhost:8011
CLIENT=http://localhost:8012
START=0
[ "${1:-}" = "--start" ] && START=1

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# 1. Service lifecycle. The lobby/logserver/client are mprocs-managed; this
#    script never hand-launches them (the lobby caches state at startup and
#    duplicate processes cause port races — see SKILL.md Gotchas). It only
#    reports, or with --start defers to the project's own service manager.
say "== services =="
./tools/scripts/spring-services.sh status || true

if [ "$START" = 1 ] && ! curl -fsS -o /dev/null "$LOBBY/api/version" 2>/dev/null; then
  say "== lobby down; starting stack via spring-services.sh start-bg =="
  ./tools/scripts/spring-services.sh start-bg || true
  for i in $(seq 1 30); do
    curl -fsS -o /dev/null "$LOBBY/api/version" 2>/dev/null && break
    sleep 1
  done
fi

# 2. HTTP plane smoke.
say "== HTTP plane =="
VER=$(curl -fsS "$LOBBY/api/version" 2>/dev/null) || fail "lobby $LOBBY/api/version not responding (start the stack in mprocs, or rerun with --start)"
say "lobby version: $VER"

GAMES=$(curl -fsS "$LOBBY/api/games" 2>/dev/null) || fail "/api/games not responding"
NGAMES=$(printf '%s' "$GAMES" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d if isinstance(d,list) else d.get("games",[])))' 2>/dev/null || echo "?")
say "games available: $NGAMES"
printf '%s' "$GAMES" | python3 -c 'import json,sys
d=json.load(sys.stdin); g=d if isinstance(d,list) else d.get("games",[])
for x in g: print("  - %s  modelMaterialPort=%r lighting=%r" % (x.get("id"), x.get("modelMaterialPort",""), x.get("lighting","")))' 2>/dev/null || true

MAPS=$(curl -fsS "$LOBBY/api/maps" 2>/dev/null) || fail "/api/maps not responding"
NMAPS=$(printf '%s' "$MAPS" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d if isinstance(d,list) else d.get("maps",[])))' 2>/dev/null || echo "?")
say "maps available: $NMAPS"

# 3. Client dev server (Vite) reachable?
if curl -fsS -o /dev/null "$CLIENT/" 2>/dev/null; then
  say "client (Vite) at $CLIENT: up"
else
  say "client (Vite) at $CLIENT: DOWN (start the 'client' proc in mprocs to drive the browser)"
fi

# 4. Running game servers (from the SQLite the lobby/game servers share).
say "== game servers =="
GS=$(curl -fsS "$LOBBY/api/rooms" 2>/dev/null | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin); r=d if isinstance(d,list) else d.get("rooms",[])
  act=[x for x in r if str(x.get("state")) in ("4","active","Active")]
  print("rooms total=%d active=%d" % (len(r), len(act)))
except Exception as e: print("rooms: parse n/a (%s)" % e)' 2>/dev/null || echo "rooms: n/a")
say "$GS"

say ""
say "OK — HTTP plane live. Launch + drive a game with the MCP tools (SKILL.md)."
