# SQL Proxy, Process Management, Claude/MCP, springcli & mprocs

Part of the [Debugging & Logging Guide](debugging.md) family. This page covers the lobby's read-only SQL proxy, process management, the Claude/MCP integration (`tools/debug-mcp`), the standalone `springcli` CLI, and the `mprocs` development environment.

## Table of Contents

- [SQL Query Proxy](#sql-query-proxy)
- [Process Management](#process-management)
- [Claude / MCP Integration](#claude--mcp-integration)
  - [MCP Server Setup](#mcp-server-setup)
  - [Available Tools](#available-tools)
  - [Reliable live game-drive verification](#reliable-live-game-drive-verification)
- [Headless Run Mode](#headless-run-mode)
  - [`--headless-run` config](#--headless-run-config)
  - [Stats dump + determinism hash](#stats-dump--determinism-hash)
  - [Batch driver (`tools/headless-batch`)](#batch-driver-toolsheadless-batch)
  - [Determinism CI hook](#determinism-ci-hook)
  - [Fixture-replay verify CI hook](#fixture-replay-verify-ci-hook)
- [Replay record / playback](#replay-record--playback)
  - [Recording](#recording)
  - [Exporting a shareable `.msr` (`--replay-export`)](#exporting-a-shareable-msr---replay-export)
  - [Playing back](#playing-back)
  - [Verifying (`--verify`)](#verifying---verify)
  - [Seeking](#seeking)
  - [What a replay does and does not carry](#what-a-replay-does-and-does-not-carry)
- [springcli — Command-Line Tool](#springcli--command-line-tool)
  - [Building](#building)
  - [Commands](#commands)
  - [Environment Variables](#environment-variables)
  - [Flags](#flags)
  - [Exit Codes](#exit-codes)
  - [HTTP Exec API](#http-exec-api)
  - [libspringapi](#libspringapi)
- [mprocs Development Environment](#mprocs-development-environment)

---

## SQL Query Proxy

The lobby handles `ConsoleCommand` messages with scope `"sql"`, executing read-only SQL queries against the game database (`spring-server.db`).

From the debug console (scope `sql`):

```
sql> SELECT id, username, role FROM users
  id=1 | username=alice | role=admin
  id=2 | username=bob | role=player

sql> SELECT COUNT(*) FROM maps
  COUNT(*)=5
```

**Safety:** The proxy rejects queries containing `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, or `CREATE` (case-insensitive keyword check). Only `SELECT` and other read-only statements are allowed.

---

## Process Management

**HTTP API** (served by the lobby):

```
GET /api/processes
```

Returns a JSON array of all game server instances:

```json
[
  {
    "room_id": 1,
    "port": 9101,
    "pid": 12345,
    "state": "running",
    "map": "content/maps/wanderlust2.1",
    "game": "content/games/papertanks"
  }
]
```

States: `starting`, `running`, `ended`, `crashed`.

**Console commands** (scope `lobby`):

```
lobby> process list
  Room 1: pid=12345 port=9101
```

**Restart resilience:** The lobby writes spawned game server info to a `game_servers` SQLite table. On startup, stale entries from a previous run are cleaned up. This table is the foundation for re-adopting orphaned game servers after a lobby restart (not yet fully wired).

---

## Claude / MCP Integration

The MCP server (`tools/debug-mcp/server.js`) lets Claude query logs, execute commands, read source files, and manage game servers.

### MCP Server Setup

```bash
cd tools/debug-mcp
npm install
```

Configure in `.claude/settings.local.json`:

```json
{
  "mcpServers": {
    "spring-debug": {
      "command": "node",
      "args": ["tools/debug-mcp/server.js"],
      "env": {
        "LOG_SERVER_URL": "http://localhost:8010",
        "LOBBY_URL": "http://localhost:8011"
      }
    }
  }
}
```

### Available Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_logs` | `roomId`, `game`, `level`, `section`, `scope`, `sinceMinutes`, `limit` | Fetch recent log entries; `roomId` scopes to one game instance |
| `search_logs` | `query`, `roomId`, `game`, `section`, `level`, `sinceMinutes`, `limit` | Search logs; scope with `roomId`/`game`/`sinceMinutes` to avoid a flood of history |
| `exec_lua` | `scope`, `code`, `roomId` | Execute Lua code in a specific scope |
| `get_game_state` | `roomId` | Get sim state summary |
| `list_units` | `team`, `roomId` | List units, optionally by team |
| `list_processes` | | List game server processes (via lobby HTTP) |
| `get_lua_source` | `gamePath`, `filePath` | Read a Lua source file from disk |
| `list_gadgets` | `roomId` | List loaded Lua gadgets |
| `query_db` | `query`, `db` | SQL query against game or debug database |
| `list_sessions` | | List recent game sessions |
| `launch_game`, `kill_game`, `restart_lobby`, `restart_logserver`, `restart_game`, `restart_client` | see `.claude/skills/spring-debug` | Service lifecycle management (`restart_client` = Vite pane via mprocs control channel) |
| `spawn_unit`, `kill_unit`, `damage_unit`, `give_order`, `clear_units`, `get_unit_state`, `set_debug_logging`, `get_combat_summary`, `pause_sim`, `set_sim_speed` | see `.claude/skills/spring-test` | Scripted test verbs (server-side) |
| `browser_test`, `evaluate_widget_lua` | see `.claude/skills/spring-test` | Bridges to browser-side `window.test`/`window.widgets` — includes the [performance-profiling tools](debugging-performance.md) |

The full, current tool list (with input schemas) lives in `tools/debug-mcp/server.js`; the skills in `.claude/skills/` document the recipes and pitfalls for using them. This table is a map, not the source of truth — it can drift from the server as tools are added.

**Example Claude interaction:**

```
User: Check if there are any Lua errors in the last game

Claude: [uses get_logs with level=4 (ERROR), section="lua"]
Found 3 Lua errors:
  [142] [ERROR] [spring-server:lua:LuaRules] runtime error in 'GameFrame': ...
```

### Reliable live game-drive verification

The sim does **not** advance until a real client connects — the server logs
`waiting for N player(s) to connect before starting game...` and idle-exits after
~300s if none does (`game-<room>.log` ends with `shutting down idle game server`
→ `exited cleanly`). So driving a game for verification needs an actual browser
session, not just `launch_game`. Three recurring traps:

1. **User mismatch.** `launch_game` (and the MCP tools) host as `admin`, but the
   browser tab is often logged in as someone else (`test1`). A non-host username
   is rejected by the game-server roster, so the browser never connects and the
   server idle-exits. **Fix:** don't host with `launch_game` when you need a
   browser in the loop — drive `createRoom → addAI → ready → startGame` *from the
   already-logged-in browser* so that user is the host and auto-connects.
2. **Stale game/lobby after a rebuild.** Replacing a binary on disk does not touch
   a running process. After `ninja … spring-server`, kill the running game
   (`kill_game`, or `pkill -f build/debug/spring-server`) before launching, or
   you'll test the old binary. After rebuilding the lobby, `restart_lobby`.
3. **Port/process leftovers.** All game servers bind `:9100`; a half-dead server
   keeps the UDP/QUIC socket and the next launch exits immediately. Confirm it's
   free (`lsof -nP -iUDP:9100`) and that no `spring-server` lingers before
   relaunching. Ended rooms are auto-reaped by the lobby health check.

Proven flow (browser already logged in, lobby + client + log server up):

```js
// In the browser tab (chrome-devtools evaluate_script), as the logged-in user:
const L = window.lobby;
L.selectedGameId = 'bar';
await L.createRoom('verify', 'pools_of_ilys_1.0.0');  // small map — green_flat
await L.addAI('null', 1);                              // is huge: slow QTPFS init
await L.ready(true);
await L.startGame();                                   // browser becomes host + connects
```

Then watch `game_status` flip to `ready=1, clients=1` (the server writes it to
`data/spring-server.db` once a client is connected):

```bash
sqlite3 data/spring-server.db \
  "SELECT ready, client_count, port FROM game_status WHERE room_id=<id>"
```

Once `clients=1`, the sim runs (`get_game_state` → `frame=` climbing) and you can
drive it: `set_cheats`, `spawn_unit`, `give_order`, `exec_lua`. Inspect the
client-side LuaUI worker (the `Spring.*`/`gl.*` API the player sees) with
`window.widgets.eval('<lua>')` via chrome-devtools.

> The MCP's authed tools cache the lobby token; if the session DB was reset they
> used to 401 forever. The MCP now re-auths once on a 401 (`authedFetch` in
> `tools/debug-mcp/server.js`) — but that self-heal only applies after the MCP
> process restarts. If you still see `401 … use POST /api/auth/login first` from a
> long-running MCP, restart the MCP server, or drive exec via a fresh
> `curl`-obtained token directly against `:9100/api/exec`.

---

## Headless Run Mode

`--headless-run <config.json>` runs `spring-server` to completion **with no browser
client attached at all** — no rendering, no LuaUI, no WebTransport clients. It
unblocks AI-vs-AI soak testing, balance-sweep batches, and sim-determinism CI (the
"does the synced simulation actually reproduce" question that was previously
untestable). Full design: [PLAN-headless.md](../PLAN-headless.md).

Everything else in the server is headless by construction (rendering was deleted in
Phase 0) — the only engine change is the tick-gate: idle-exit and the roster-wait are
force-disabled under `--headless-run`, so the sim starts and ticks with zero clients.

### `--headless-run` config

```jsonc
// A self-contained manifest — same shape as the quickstart --direct manifest
// (PLAN-quickstart.md), plus a `headless` block.
{
  "map": "green_flat_x34_v3",
  "game": "papertanks",
  "aiSlots": [
    { "aiId": "basic_ai", "team": 0, "startPos": 0, "profile": "aggressive" },
    { "aiId": "basic_ai", "team": 1, "startPos": 1, "profile": "default" }
  ],
  "modOptions": {                     // same key=value pairs as --modoption
    "startunits": "skirmish",         // values are strings; bools/numbers are coerced
    "combatwatch": "0"
  },
  "headless": {
    "tickMode": "uncapped",           // "uncapped" | "realtime" | "xN" (e.g. "x5")
    "stopAt": { "frame": 9000 },      // and/or "gameOver": true, "luaCondition": "GG.Some.Predicate"
    "statsDump": "out/run.json",      // written at termination
    "stateHashEvery": 300             // determinism-hash cadence, 0 = off
  }
}
```

Launch directly (no lobby needed — this bypasses the room state machine entirely):

```bash
build/debug/spring-server \
  --headless-run path/to/config.json \
  --port 19100 --db /tmp/run.sqlite \
  --max-wall-min 5   # hard wall-clock ceiling (E4), default 60
```

Run from the **repo root** — the server resolves `map`/`game` against
`data/maps/<id>` / `data/games/<id>` relative to its cwd. Each concurrent instance
needs a **distinct `--port`** (binds both TCP and the QUIC/UDP WebTransport listener —
no port-0 auto-assign) and a **distinct `--db`** (SQLite; a shared file races two
writers). The process self-terminates with exit code `0` once a stop condition fires
— no separate "wait for the dump to appear" polling is needed, just wait for the
child process to exit.

`stopAt` precedence: `luaCondition`-errored > `gameOver` > `frame` > `luaCondition` >
`--max-wall-min` (always active as the outermost runaway guard).

`modOptions` fills the same role for a manifest that `--modoption key=value` fills on
the command line — synced gadgets read them via `Spring.GetModOptions()` and the
defs-cache key includes them. Precedence is **per key**: an explicit `--modoption`
wins over the manifest's entry for that key, and the manifest supplies the rest (same
rule as `map`/`game`/`aiSlots`). Values reach Lua as **strings** whatever their JSON
type, so `true` arrives as `"1"` and `3` as `"3"`. A malformed entry (object/array
value, empty key) is skipped rather than aborting the run.

### Stats dump + determinism hash

The JSON written to `headless.statsDump` at termination (`rts/Server/StatsDump.{h,cpp}`):

```jsonc
{
  "status": "frame-limit",           // headless::StopReasonName() value
  "frame": 9000, "gameSeconds": 300.0, "wallSeconds": 4,
  "snapshots": [
    {
      "frame": 300, "gameSeconds": 10.0, "wallSeconds": 0,
      "stateHash": "a1b2c3d4e5f60708",  // fixed-width hex string, NOT a JSON number
      "simFps": 0.0, "rssKb": 41232, "luaHeapKb": 128,
      "teams": [ { "teamId": 0, "numUnits": 3, "metal": 940.0, "damageDealt": 0.0, "unitsKilled": 0, /* ... */ } ],
      "weapons": [ { "weaponDefId": 4, "volleys": 12, "kills": 1, "damage": 340.5 } ]
    }
    // ... one row per `stateHashEvery` frames, plus a final row at the stop frame
  ]
}
```

**`stateHash` is a hex string, not a number** — a real hash exceeds 2^53 and would
lose precision through a double-based JSON parser (Node/Python). Parse it as an
opaque string; compare with plain `===`/`==`, never cast to a number.

`stateHash` is an FNV-1a xor-fold over every active unit's id/team/pos/health plus the
synced RNG's generator state, folded in engine iteration order (order-sensitive by
design — reproducing the same order every run *is* the sync claim). Two runs of the
same config must produce byte-identical `stateHash` sequences; any divergence is a
real synced-state bug, not test flake.

**Known gap:** the engine has no `seed` config field yet — `gsRNG` is hard-seeded to a
fixed constant (`CGlobalSynced::ResetState()`), so there is currently no way to make
two headless runs diverge on purpose via a seed. The batch driver (below) still
carries a `seed` matrix axis through to each generated config for bookkeeping/
reproducibility labelling, but the engine does not yet consume it — noted here per
the no-silent-deviation rule rather than left to be discovered later.

### Batch driver (`tools/headless-batch`)

`tools/headless-batch/batch.mjs` — a dependency-free Node ESM CLI — expands a
parameter matrix (profiles × maps × seeds, or any other axes) against a config
template, spawns one `spring-server --headless-run` per combination (concurrently —
they're cheap; task 2's field notes measured an uncapped 3-simulated-hour run
completing in 8 wall-seconds), and collates every run's stats dump into one JSONL
file (one line per run) for downstream analysis: balance sweeps, economy tuning
grids, AI profile round-robins, long-uptime soak ladders.

```bash
node tools/headless-batch/batch.mjs \
  --template tools/headless-batch/fixtures/balance-template.json \
  --matrix   tools/headless-batch/fixtures/balance-matrix.json \
  --out-dir  out/balance-01 \
  --server-bin build/debug/spring-server \
  --concurrency 4 --max-wall-min 5
```

The matrix spec is a list of dot-path axes (`aiSlots.0.profile`, `map`, `seed`, or any
other field in the template) cross-producted into one config per combination:

```jsonc
// tools/headless-batch/fixtures/balance-matrix.json
{
  "axes": [
    { "path": "aiSlots.0.profile", "values": ["aggressive", "default"] },
    { "path": "map", "values": ["green_flat_x34_v3", "pools_of_ilys_1.0.0"] },
    { "path": "seed", "values": [1, 2] }
  ]
}
```

2×2×2 axes → 8 runs. Each JSONL line is
`{ index, params, port, configPath, dumpPath, exitCode, ok, dump, stderrTail? }` —
`params` is the flat `{axisPath: value}` combination for that row, `dump` is the
parsed `FinalDump` JSON (or `null` if the run failed before writing one — never
faked with zeros). Per-run configs/dumps/db files land under `--out-dir` so nothing
overwrites between rows.

The matrix-expansion core (`lib/matrix.mjs`) is pure — no `child_process`/`fs` — and
covered by `node tools/headless-batch/test/matrix.test.mjs` / `make
test-headless-batch`, which asserts the PLAN-headless.md §6 "meta" requirement
directly: a 2×2×2 spec produces 8 rows with distinct seed values and no duplicate
combinations.

### Determinism CI hook

`tools/headless-batch/determinism-pair-run.mjs` runs one config **twice, back to
back**, and diffs the two dumps' `stateHash` sequences frame-for-frame — the actual
regression test for the "synced" claim. Wired into
[`.github/workflows/headless-determinism.yml`](../.github/workflows/headless-determinism.yml)
(macOS runner — same QUIC/Homebrew constraint as `security-prod-gate.yml`, see that
workflow's platform note) and `make test-headless-determinism`:

```bash
make test-headless-determinism
# builds spring-server, then:
node tools/headless-batch/determinism-pair-run.mjs \
  --server-bin build/debug/spring-server \
  --out-dir build/headless-determinism
```

The CI fixture (`tools/headless-batch/fixtures/papertanks-determinism.json`) is
PaperTanks-scale — a 2-AI, 5-game-minute (`stopAt.frame: 9000`) uncapped run against
`green_flat_x34_v3` with `stateHashEvery: 300` (30 snapshots) — chosen small enough
that the actual sim run costs single-digit wall-seconds; the workflow's ~2-minute
wall time is almost entirely the `cmake`/`ninja` build, not the run itself. A
mismatch prints every diverging snapshot (frame + both hashes) and exits non-zero.

#### The fixture must not be vacuous

> **This gate ran green for weeks while testing almost nothing** (found 2026-08-03,
> fixed 2026-08-04). Paper Tanks ships no side data and no start-unit gadget, so a
> `--headless-run` of it produced a game with **zero units** — every one of the 30
> snapshots reported `numUnits: 0`, and the state hash folded an empty unit list plus
> the synced RNG state. Two runs of an empty world agree perfectly. What the gate
> actually regression-tested was "the RNG stream is stable"; it could not have caught
> a movement, collision, damage or command-ordering divergence, because none of those
> ever executed.

The fix has two halves, and the second is the one that keeps it fixed:

1. **The fixture stages a real army.** `modOptions.startunits: "skirmish"` turns on
   `data/games/papertanks/LuaRules/Gadgets/game_start_units.lua`, which stages 12
   units a side (heavy/light tanks, scouts, artillery, an HQ) on opposite sides of the
   map centre and walks the mobile ones into the middle. Deterministic by
   construction: no RNG, no wall clock, sorted team ids, positions a pure function of
   (map size, team slot, unit index). It is **off unless the modoption is set**, so
   every other Paper Tanks invocation is unaffected. The fixture also sets
   `combatwatch: "0"` — `combat_watch.lua` logs one line per shot, which buries the
   verdict once there is real combat.
2. **Both drivers reject a vacuous run before comparing anything**
   (`tools/headless-batch/lib/fixture-checks.mjs`). A dump must show peak units,
   damage dealt *and* units died above zero. Deaths are required specifically because
   units that exist and shoot but never die leave the destruction/removal path — a
   classic source of iteration-order nondeterminism — untested. A hash comparison
   cannot tell you it compared two empty worlds, so the content is asserted
   separately and up front.

Measured on the fixed fixture: `peakUnits=23 peakDamage=18788 peakDeaths=19`, and the
recording went from **1 journal record** (the GameStart anchor, nothing else ever
happened) to **1799**.

### Fixture-replay verify CI hook

`tools/headless-batch/replay-verify-run.mjs` is the second gate over the same fixture,
and a strictly harder question than the pair-run. The pair-run asks *"does the same
input produce the same output twice?"*; this asks *"does re-feeding the recorded
**cause stream** reproduce the run?"* — which additionally covers journal completeness
(an unrecorded synced input surfaces as a divergence), record ordering, and the `.msr`
container round-trip.

```bash
make test-replay-verify
# builds spring-server, then:
node tools/headless-batch/replay-verify-run.mjs \
  --server-bin build/debug/spring-server \
  --out-dir build/replay-verify --pack
```

Three passes: record the fixture with `--journal-file` + `--journal-hash-every`,
re-execute it with `--replay … --verify`, then (with `--pack`) repack via
`--replay-export` and verify the packed copy too.

> **Gate on the log line, never the exit code.** `spring-server` aborts during static
> destruction (`CWeaponDefHandler`, inside `__cxa_finalize`, *after* `main` returns and
> after `exited cleanly` is logged) in any run that exercised weapon defs. That is a
> pre-existing defect unrelated to replay, and it means the process status is noise
> here. Both drivers parse the engine's own verdict instead — `replay verify: PASS/FAIL`
> for the replay gate, `headless run complete:` for the pair-run. A run that produces
> **no** verdict is its own failure mode (`absent`), never "no FAIL seen".

Live results on the fixed fixture (debug build): 1799 records / 30 hash points
recorded, `PASS — 30/30 state hashes matched` on both the raw recording and the packed
copy (178 887 → 9 350 bytes). Negative control: flipping one bit of the frame-4800
reference reports `FAIL … firstDivergence=4800`, located exactly.

---

## Replay record / playback

A replay is the recorded **cause stream** — every input that entered the server from
outside the deterministic sim — re-executed against the same content. Because the sim
is deterministic, re-running the inputs reproduces the game; there is no per-frame
state in the file. See [PLAN-replay.md](../PLAN-replay.md) for the design.

### Recording

```bash
spring-server --headless-run config.json --journal-file game.msr
```

`--journal-file` attaches the synced-input funnel's durable writer. It works on any
server, not just headless ones — a normal lobby-launched game records the same way.
The file carries its own launch spec (map, game, modoptions, roster, AI slots), so
playback needs no other argument.

`--journal-file` and `--journal-audit` are mutually exclusive in effect: the file
writer wins, since a run asked to produce a shareable artefact should not have its
records land in a diagnostic in-memory ring instead.

The recording also embeds a **state-hash track** — a determinism reference point every
`--journal-hash-every N` sim frames (default **300**, i.e. every 10 s; `0` disables it).
That track is what `--verify` checks against, so a file recorded with `0` can never be
verified afterwards; the recorder warns about it at open *and* at close rather than
letting it be discovered by a CI run weeks later.

```bash
spring-server --headless-run config.json --journal-file game.msr --journal-hash-every 300
```

### Exporting a shareable `.msr` (`--replay-export`)

```bash
spring-server --replay game.msr --replay-export shared.msr
spring-server --replay shared.msr --replay-export plain.msr --replay-export-codec none
```

Repacks a recording and exits — no sim, no content, no port. The default codec is
`deflate` (~3× on a real papertanks stream); `none` is the unpack/import direction.
Importing needs no flag at all: `--replay` decompresses transparently.

Two properties worth relying on:

- **A truncated segment stays truncated.** Packing a `kill -9`'d recording re-emits it
  without a trailer, so the copy still reads `[TRUNCATED SEGMENT]`. Laundering a crashed
  recording into a clean-looking artefact is the one thing the packer must never do.
- **A live recorder never compresses.** Compression is an export step precisely because
  a torn deflate stream is unrecoverable, and salvaging a torn *recording* is the whole
  point of the truncation handling.

> The format reserves a `zstd` codec value (PLAN-replay §1 specifies zstd) but does not
> implement it: this tree links zlib and not libzstd. `--replay-export-codec zstd` is a
> spoken error, never a silent substitution.

### Playing back

```bash
spring-server --replay game.msr --port 9101 --db /tmp/replay.sqlite
```

The replay server is an ordinary game server whose inputs are prerecorded, so clients
connect over the standard wire and spectate with no replay-format knowledge. Two
behaviours differ from a live server, both deliberate and both logged:

- **Sim-affecting verbs from live clients are refused.** A client attached to a
  replay is a spectator by construction. View-state verbs (viewport, selection, path
  preview) pass through untouched.
- **`/api/exec` is refused**, with a reply rather than silence — injecting Lua into a
  re-execution would fork it.

### Verifying (`--verify`)

```bash
spring-server --replay game.msr --verify                        # embedded track
spring-server --replay game.msr --verify reference-stats.json   # explicit override
```

Re-executes headless (uncapped) and compares the state hash at exactly the frames the
reference track recorded one at.

**The argument is optional.** With none, the recording's own embedded hash track is the
reference — one file, one command, nothing to point at the wrong run. Passing a
[stats dump](#stats-dump--determinism-hash) *overrides* the embedded track, which is how
the negative control is run (verify one game's stream against another game's hashes; it
must fail). A `--verify` with neither is refused up front rather than three minutes later
with `checked=0`.

Recording and verification compute the hash at the **same statement** in the tick, not
merely at the same frame — they share one call site in `server_main.cpp`, because a
reference taken a few statements earlier in the tick than the check is a false divergence
indistinguishable from a real one.

A divergence is reported with its **frame**, which is the bisection point a desync
investigation starts from:

```
replay verify: PASS — 30/30 state hashes matched, 8 records fed
replay verify: FAIL — checked=30 matched=6 missing=0 firstDivergence=1400 expected=… actual=…
```

Verification never passes vacuously: a run that checked nothing, or that ended before
reaching every reference point (`missing > 0`), fails.

> **`stateHash` is a hex STRING in the dump, not a number** — see the stats-dump
> section's note. `--verify` parses it with `strtoull(…, 16)`.

> **Exit-code caveat.** The verdict is also the process exit code (0 pass / 2 fail),
> but `spring-server` has a **pre-existing** static-destruction crash
> (`CWeaponDefHandler` destructor, during `__cxa_finalize` *after* `main` returns and
> after `exited cleanly` is logged) that fires in any run where weapon defs were
> exercised — it reproduces with no replay flags at all. Until that is fixed, gate CI
> on the `replay verify:` log line, not on the exit status. See
> [Fixture-replay verify CI hook](#fixture-replay-verify-ci-hook) for the driver that
> does this.

### Seeking

```bash
spring-server --replay game.msr --replay-seek 3000
```

Fast-forwards to frame 3000 uncapped with **outbound streaming muted**, then resumes
normal pacing and streaming. Verified state-neutral: the same replay verifies
hash-exact with and without a seek.

Suppression is applied at the transport (`WebTransportServer::SetOutboundSuppressed`),
never by skipping the streamer tick — `StateStreamer::Tick` also evaluates standing
orders and macro directives, which *issue commands*, so skipping it would change the
simulation and land the seek on a different world.

Seek is currently a full fast-forward from the start rather than a jump: the algorithm
is "nearest checkpoint ≤ target, then fast-forward", and the checkpoint index is empty
until PLAN-persistence's sim serializer lands. It is frame-exact either way, just
slower for late targets.

### What a replay does and does not carry

Recorded (the five funnel chokepoints): raw client wire messages, player disconnects,
`/api/exec` Lua, AI commands, the GameStart anchor, and GM snapshot-restore markers.

**Not** recorded: anything the sim causes itself (factory rally orders, retaliation,
gadget-issued commands) — re-execution reproduces those, and recording them would
double-apply.

Two gaps to know about:

- **Games with human players do not replay end-to-end yet.** The wire bytes are
  re-fed under their recorded connection id, but a recorded `AuthRequest` re-enters
  `db.ValidateSession` against a session row a replica database need not have. A
  replay of an AI/operator-driven game is complete; a replay of a human game will
  diverge at the point authentication decides team ownership.
- **A snapshot-restore record ends the segment.** Honouring it needs a mid-stream
  checkpoint restore, which does not exist yet. Per PLAN-replay §6 E2 a rollback
  starts a new segment anyway, so the next segment is a separate replay.

---

## springcli — Command-Line Tool

`springcli` is a standalone CLI for interacting with Spring servers from bash, scripts, and Claude automation. It uses HTTP (not WebSocket/FlatBuffers) so it works with plain `curl`-like simplicity.

### Building

```bash
cmake --build build/debug --target springcli
# Binary: build/debug/tools/springcli/springcli
```

### Commands

```bash
# Game server port is dynamic — discover it first:
#   springcli processes --lobby http://localhost:8011
#   or: GET http://localhost:8011/api/processes
# Then use the port from the response (shown as $PORT below).

# Game server commands (scope: server)
springcli state --server http://localhost:$PORT
springcli frame --server http://localhost:$PORT
springcli defs  --server http://localhost:$PORT
springcli units --server http://localhost:$PORT --team 0
springcli pause --server http://localhost:$PORT
springcli unpause --server http://localhost:$PORT
springcli speed 2.0 --server http://localhost:$PORT

# Lua execution
springcli lua "return Spring.GetAllUnits()" --server http://localhost:$PORT
springcli lua "return Spring.GetUnitHealth(1)" --server http://localhost:$PORT
springcli exec LuaRules "return 1+1" --server http://localhost:$PORT
springcli exec LuaGaia "return Spring.GetGameFrame()" --server http://localhost:$PORT

# Multi-line Lua (quotes handle newlines)
springcli lua 'local t = {} for i=1,5 do t[i]=i*i end return t' --server http://localhost:$PORT

# Lobby commands
springcli sql "SELECT id, username FROM users" --lobby http://localhost:8011
springcli exec lobby "process list" --server http://localhost:8011
springcli processes --lobby http://localhost:8011

# Log server queries
springcli logs --log-server http://localhost:8010 --level 4 --limit 10
springcli logs --log-server http://localhost:8010 --search "runtime error"

# Raw HTTP (escape hatch)
springcli get http://localhost:8010/api/logs/sources
springcli post http://localhost:8011/api/exec '{"scope":"sql","code":"SELECT 1"}'
```

### Environment Variables

Set these to avoid repeating `--server` / `--lobby` / `--log-server`:

```bash
export SPRING_SERVER=http://localhost:$PORT  # dynamic — discover via springcli processes
export SPRING_LOBBY=http://localhost:8011
export SPRING_LOG_SERVER=http://localhost:8010

# Now just:
springcli state
springcli lua "return 42"
springcli sql "SELECT count(*) FROM users"
```

### Flags

| Flag | Description |
|------|-------------|
| `--server URL` | Game server (dynamic port — discover via `springcli processes` or `GET /api/processes` on lobby) |
| `--lobby URL` | Lobby server (default: `$SPRING_LOBBY` or `localhost:8011`) |
| `--log-server URL` | Log server (default: `$SPRING_LOG_SERVER` or `localhost:8010`) |
| `--scope SCOPE` | Lua scope for `lua` command (default: LuaRules) |
| `--level N` | Min log level for `logs` command |
| `--section S` | Filter logs by section |
| `--search Q` | Search log messages |
| `--limit N` | Max results (default: 50) |
| `--team N` | Filter units by team |
| `--json` | Output raw JSON |
| `-q` | Quiet: output only the result value, no "error:" prefix |

### Exit Codes

- `0` — success
- `1` — command failed (Lua error, connection failed, etc.)
- `2` — usage error (missing arguments)

### HTTP Exec API

`springcli` uses `POST /api/exec` endpoints added to both servers:

```bash
# Equivalent to: springcli exec server state
curl -s -X POST http://localhost:<game-port>/api/exec \
  -H "Content-Type: application/json" \
  -d '{"scope":"server","code":"state"}'
# → {"success":true,"output":"frame=1234 teams=3 units=5"}

# Equivalent to: springcli sql "SELECT 1"
curl -s -X POST http://localhost:8011/api/exec \
  -H "Content-Type: application/json" \
  -d '{"scope":"sql","code":"SELECT 1"}'
# → {"success":true,"output":"1=1"}
```

### libspringapi

The CLI is built on `libspringapi`, a static C++ library with a simple HTTP-based API:

```cpp
#include "springapi.h"

auto r = springapi::exec("http://localhost:<game-port>", "LuaRules", "return 42");
// r.success == true, r.output == "42"

auto logs = springapi::getLogs("http://localhost:8010", 0, 4, 10);
auto procs = springapi::getProcesses("http://localhost:8011");
```

Zero external dependencies — uses raw POSIX sockets for HTTP.

---

## mprocs Development Environment

The `mprocs.yaml` file defines the development process group:

| Process | Command | Purpose |
|---------|---------|---------|
| `logserver` | `./build/debug/spring-logserver --port 8010 --db data/debug.db` | Log collection |
| `lobby` | `./build/debug/spring-lobby --port 8011 ...` | Game lobby |
| `client` | `cd client && npx vite dev --port 8012` | Browser client |
| `game-logs` | `tail -F data/logs/game-*.log` | Raw log file tail |
| `lua-errors` | `tail ... \| grep -iE '(error\|warning\|FATAL)'` | Filtered error view |

Start with `mprocs` from the project root. Each process runs in its own pane.

### Remote control (restart a single pane)

`mprocs.yaml` sets `server: 127.0.0.1:4050`, which makes the running mprocs
listen for control commands. This lets scripts/MCP restart **one** pane without
killing it out from under mprocs (a bare `kill` leaves a dead pane and risks a
duplicate listener that round-robins the port via `SO_REUSEPORT`, so requests
hit a stale binary).

`tools/scripts/spring-services.sh` drives it:

```bash
spring-services.sh status          # lists services + whether mprocs-ctl is reachable
spring-services.sh restart client  # restart just the Vite pane (select-proc + restart-proc)
spring-services.sh restart all     # restart-all
spring-services.sh ctl '{c: restart-all}'   # send a raw mprocs command
```

Panes: `logserver | lobby | server | client | game-logs | lua-errors | all`.
The script maps a pane **name** to the index mprocs `select-proc` expects by
parsing `mprocs.yaml`, so it stays correct if panes are reordered.

**The control server only exists if mprocs was started with the `server:` key.**
If you started mprocs before this was configured, `status` shows `mprocs-ctl not
reachable` and `restart` falls back to kill+relaunch (which can't touch the
mprocs-only `game-logs`/`lua-errors` tails) — restart mprocs once to open the
port.

**When to use which restart.** The C++ servers self-re-exec in place — prefer
`restart_lobby` / `restart_logserver` / `restart_game` (spring-debug MCP) or
`SIGHUP` after rebuilding a C++ binary: same PID, mprocs stays authoritative, and
running game servers are preserved (see the [spring-debug](../.claude/skills/spring-debug/SKILL.md)
skill). Use `spring-services.sh restart client` for the **Vite** pane
specifically — it's a node process with no in-place re-exec, and Vite otherwise
serves a stale `?worker` bundle after you edit a worker-imported file
(`entity-renderer.ts`, `game-processor.ts`, …). The raw `mprocs --ctl '{c: …}'`
vocabulary (`restart-proc`, `restart-all`, `select-proc`, `add-proc`, `start-proc`,
`term-proc`, `send-key`, `batch`, …) is documented in the mprocs README.
