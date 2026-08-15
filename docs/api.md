# HTTP API Reference

Spring RTS Web exposes HTTP APIs on three server types. All endpoints return JSON with `Access-Control-Allow-Origin: *` and an `X-Build-Stamp` header identifying the server build.

For programmatic access from C++, Python, or CLI, see [libspringapi](../libspringapi/README.md).

Machine-readable schema: [api-spec.yaml](api-spec.yaml) (OpenAPI 3.1).

---

## HTTP/2 Support

All servers support both **HTTP/2 (h2c cleartext)** and **HTTP/1.1** on the same port. The protocol is auto-detected from the connection preface — no configuration needed.

- **Browsers** connect via HTTP/1.1 by default (browsers only use HTTP/2 over TLS). Use a reverse proxy (e.g. nginx, Caddy) to terminate TLS and provide h2 to browser clients.
- **C++ clients** (`libspringapi`, `springcli`) use h2c directly for multiplexed requests over a single connection.
- **curl**: use the `--http2-prior-knowledge` flag for h2c:
  ```bash
  curl --http2-prior-knowledge http://localhost:8011/api/version
  ```

The HTTP layer is built on nghttp2.

---

## Authentication

All servers share the same auth endpoints. Tokens are stored in SQLite, survive restarts, and expire after 24 hours.

### POST /api/auth/login

Authenticate with username and password.

```bash
curl -X POST http://localhost:8011/api/auth/login \
  -d '{"username":"test1","password":"test"}'
```

**Response (200):**
```json
{"token":"6411d75bcec17f69...","user_id":5,"username":"test1","role":"player"}
```

**Errors:** 400 (missing fields), 401 (bad credentials), 403 (banned)

### POST /api/auth/register

Create a new account. Auto-logs in on success.

`faction` is **required** and permanent: it is the account's allegiance and there is no
player-facing route that changes it afterwards (only the admin override below). It must be
one of the keys from [`GET /api/factions/<gameId>`](#get-apifactionsgameid) — free text is
rejected. The accepted set is Metalstorm's declared factions specifically, not a union over
every game the lobby serves, so a key that is valid for another game (ZK's `robots`, say) is
still rejected here.

```bash
curl -X POST http://localhost:8011/api/auth/register \
  -d '{"username":"newplayer","password":"secret","faction":"compact"}'
```

**Response (201):**
```json
{"token":"...","user_id":6,"username":"newplayer","role":"player","faction":"compact"}
```

**Errors:** 400 (invalid username length), 400 `{"error":"faction is required"}` (field
missing or empty), 400 `{"error":"unknown faction"}` (not a declared faction key), 409
(username taken)

### POST /api/auth/logout

Revoke the session token in the request's own `Authorization: Bearer` header. Clearing the
browser's `localStorage` is **not** a logout — the session row lives in SQLite until it ages
out, so the token stays usable for its full 24 hours in anything that copied it.

```bash
curl -X POST http://localhost:8011/api/auth/logout \
  -H "Authorization: Bearer $TOKEN"
```

**Response (200):**
```json
{"ok":true,"revoked":true}
```

Always 200, never 401 — a logout has to be completable with a token the server no longer
recognises, or an expired session becomes one you cannot leave. `revoked` reports what
actually happened: `false` for an unknown or expired token, an empty `Bearer`, a missing
header, or Basic auth (which mints no session row to revoke). Only the holder of a token can
name it, so there is nothing further to authorise.

Clients in a room should `POST /api/rooms/leave` **first**, while the token still
authenticates: a host who revokes first leaves their seat — and their room — occupied until
the lobby reaps it.

### Using Authentication

Two methods are supported on all authenticated endpoints:

**Basic auth** (simplest — works with `curl -u`):

```bash
curl -u test1:test -X POST http://localhost:8011/api/exec \
  -d '{"scope":"lobby","code":"rooms"}'
```

**Bearer token** (from login, for session reuse):

```bash
curl -X POST http://localhost:8011/api/exec \
  -H "Authorization: Bearer 6411d75bcec17f69..." \
  -d '{"scope":"lobby","code":"rooms"}'
```

Basic auth validates credentials directly on every request — no login step needed. Bearer tokens are validated against the session table (24h expiry). Both work on all endpoints that require authentication.

Passwords are hashed with scrypt (OpenSSL) and never stored in plaintext. Legacy plaintext rows are transparently re-hashed on the next successful login. Session tokens are generated with a CSPRNG (`RAND_bytes`).

### Roles and admin access

Accounts have a role: `player` (default for all registrations), `spectator`, or `admin`. Privileged endpoints — `/api/exec` (lobby and game server) and the game server's `/api/restart` — require the **admin** role. A non-admin token gets `403 forbidden`.

Nothing auto-elevates. Grant the role with a one-shot CLI command on the lobby binary (it promotes an already-registered account and exits — it does not start the server, and it never creates accounts):

```bash
# 1. register the operator account (if it doesn't exist yet).
#    `faction` is required — any declared key works, an operator account's
#    faction has no gameplay meaning. List the valid keys with:
#      curl http://localhost:8011/api/factions/metalstorm
curl -X POST http://localhost:8011/api/auth/register \
  -d '{"username":"admin","password":"<password>","faction":"compact"}'

# 2. promote it (run once; safe to run directly, not via mprocs)
./build/debug/spring-lobby --promote-admin admin
# → "granted admin role to 'admin'"  (exit 0; exit 1 if the account doesn't exist)
```

A fresh or wiped `data/spring-server.db` needs step 2 re-run. The debug MCP tooling defaults to `admin`/`admin` (override via `SPRING_USER` / `SPRING_PASS`).

---

## Lobby Server (default :8011)

### Maps

| Endpoint | Description | Cache |
|----------|-------------|-------|
| `GET /api/maps` | Map list with metadata, dimensions, start positions | 5 min |
| `GET /api/maps/source/{mapId}/*` | Raw map source files (Lua, images) | 5 min |
| `GET /api/maps/data/{mapId}/*` | Preprocessed assets (heightmap, tiles, feature .glb) | immutable |
| `GET /api/maps/thumb/{mapId}` | Map thumbnail (WebP/PNG) | immutable |

### Games

| Endpoint | Description | Cache |
|----------|-------------|-------|
| `GET /api/vfs/game/{gameId}/*` | Game source files (Lua, images, JSON) | 5 min |
| `GET /api/games/data/{gameId}/*` | Preprocessed game assets (unit .glb models) | immutable |

#### GET /api/games/{gameId}/scenarios

Public. Every scenario the game ships under `scenarios/*.lua`, plus any
generated ones materialised there. This is what the Create Game dialog's War
row, the room screen's "War:" label, and the client's briefing splash all read.

```json
[
  {
    "id": "crossing_standoff",
    "displayName": "Scorched Crossing — The Standoff",
    "map": "scorched_crossing_v2.4",
    "tutorial": false,
    "retired": false,
    "terminal": true,
    "sides": [ {"faction": "compact", "team": 0, "staged": true},
               {"faction": "union",   "team": 1, "staged": true} ],
    "briefing": {
      "title": "The Standoff",
      "subtitle": "Scorched Crossing",
      "story": "The armistice died at dawn…\n\nBetween them lies Raven Basin…",
      "tips": ["Hold the middle.", "Artillery outranges tanks."],
      "image": "scenarios/img/crossing_standoff.jpg",
      "parTimeSec": 900
    }
  }
]
```

- `terminal` is whether any objective carries `victory = true`. A war without
  one can never end — surfaced here rather than discovered 40 minutes in.
- `retired` wars are listed but never offered; the room screen still needs to
  resolve their names.
- `briefing` is **display-only** splash content and the whole key is **absent**
  when the scenario ships none (clients test `"briefing" in entry`). Every
  field inside it is optional too. Authoring format and traps:
  [javascript.md](javascript.md#scenario-briefings). `image` is relative to the
  game root — serve it from `GET /api/games/data/{gameId}/{image}`; paths
  containing `..` or starting with `/` are dropped server-side.
- The list is a **startup snapshot**: a new or edited `scenarios/*.lua` needs
  `POST /api/admin/scenarios/resync` (or a lobby restart) to appear here.
  `POST /api/admin/scenarios/list` (admin) mirrors the same `briefing` object
  for stored/generated scenarios.

The file format itself — every key, the two parsers that read it, and the
offline validator — is [scenarios.md](scenarios.md).

#### Admin scenario routes

All four require the **admin** role. The MCP tools `generate_scenario`,
`list_scenarios` and `write_scenario` wrap them (see
[debugging-tools.md](debugging-tools.md)).

**POST /api/admin/scenarios/generate**

```jsonc
{ "gameId": "metalstorm", "mapId": "meridian_basin",
  "seed": 1234,                                   // optional
  "sides": 2, "towns": 6, "outposts": 4, "bases": 2, "mines": 3,
  "sites": 3, "relics": 1, "wrecks": 5, "bridges": 1,
  "hostility": "…", "roster": "…" }               // generator enums
```

Runs `tools/mapgen/scenariogen.py`, stores the result in the scenario DB,
materialises it to `scenarios/gen_*.lua` and re-discovers it. Responds `200`
with `{ok, created, scenario}` where `scenario` is the picker view plus
provenance.

- **`seed` defaults to `sum(ord(c) for c in mapId)`**, not to a clock — a
  generated war is reproducible from `(map, seed, version)` or it is not
  reproducible at all. So re-running with no seed is an **idempotent upsert**
  (`created: false` the second time), not a new war.
- Integer knobs are **range-clamped and silently dropped** when out of range:
  `sides` 2-8, every other int 0-32. String knobs are allowlisted.
  `sites`/`relics`/`wrecks`/`bridges` — the prop and landmark layer — were
  CLI-only before this route forwarded them.
- **`422`** with `{ok: false, error, exitCode}` when the generator rejects the
  map; `error` is the generator's own `REJECTED` line, which names the violated
  invariant (and, for the reachability gate, which components the armies were
  stranded in). Not a `500`: the map is the problem, not the server.

**POST /api/admin/scenarios/list** `{gameId?}` → `{ok, scenarios[]}` — the
stored rows with provenance (`seed`, `params`, `generatorVersion`, `createdBy`,
`createdAt`, `bytes`) *and* the discovered view of each (`discovered`,
`terminal`, `sides`, `briefing`). The two halves come from different places on
purpose: a materialised file that failed to parse reads `discovered: false`
instead of echoing the row back and looking healthy.

**POST /api/admin/scenarios/resync** `{gameId?}` → `{ok, games[{gameId, written,
orphansRemoved, failed}]}` — rebuilds every generated `.lua` from its row,
sweeps orphans, and re-Discovers the whole directory. This is the de-facto hot
reload: **authored** files appear in the picker without a lobby restart, and the
sweep only ever touches `gen_*`, so it is safe to run after hand-writing a file.

**POST /api/admin/scenarios/delete** `{id}` → drops the row **and** the file.

### Factions

#### GET /api/factions/{gameId}

Public. The factions a game declares in its `gamedata/sidedata.lua`, in declaration order.
Read at lobby startup, so the response is stable for the process lifetime. The sign-up form
calls this to render the required faction picker.

```bash
curl http://localhost:8011/api/factions/metalstorm
```

```json
[{"key":"compact","name":"Compact","fullName":"The Compact","description":"..."},
 {"key":"union","name":"Union","fullName":"The Free Union","description":"..."}]
```

`key` is `name` lowercased — the same derivation the engine's `SideParser` uses — and is the
value stored on the account and accepted by `POST /api/auth/register`. A game that declares
no factions returns `[]`; that is a valid state, not an error.

**Errors:** 400 (missing game id), 404 `{"error":"game not found"}` (no such game on this
lobby)

#### POST /api/admin/set-faction

**Admin only.** Override a user's permanent faction. This is the only route that can change
a faction after sign-up — deliberately support/admin-only, and audited (`set_faction` in the
audit log). `faction` is validated against the same registry registration uses.

```bash
curl -u admin:<password> -X POST http://localhost:8011/api/admin/set-faction \
  -d '{"username":"newplayer","faction":"union"}'
# → {"ok":true}
```

**Errors:** 400 (`username` or `faction` missing), 400 `{"ok":false,"error":"unknown faction"}`,
401 (no/invalid token), 403 (not an admin), 404 `{"ok":false,"error":"no such user"}`

#### POST /api/admin/drain

**Admin only.** The deploy drain (PLAN-persistence task 3c). SIGTERMs **every** game server
this lobby owns — wars included, unlike a lobby shutdown, because the binary those processes
are running is about to be replaced — waits for each to checkpoint and exit, and reports what
survived. Audited as `deploy_drain`. Synchronous: the lobby's HTTP surface is unresponsive
until the slowest server has exited, which is accepted because a drain is the last thing done
before stopping the lobby.

```bash
curl -X POST http://localhost:8011/api/admin/drain \
  -H "Authorization: Bearer <token>" -d '{"timeout_ms":10000,"escalate":true}'
```

`timeout_ms` (default 10000, clamped to [100, 120000]) is how long a server may take to
checkpoint; `escalate` (default true) SIGKILLs whatever is left after it.

```json
{"ok":true,"drained":true,"servers":2,"checkpointed":2,"lossy":0,"killed":0,
 "still_alive":0,"engine_hash":"2d18454847f02919",
 "summary":"drain: 2 server(s) signalled, 2 checkpointed",
 "detail":[{"roomId":1,"pid":41895,"kind":"persistent_war","outcome":"checkpointed",
            "frame":1553,"label":"hibernate:signal","waited_ms":251,"lossy":false,
            "resume_eligibility":"resumable",
            "describe":"war room 1: checkpointed at frame 1553 (hibernate:signal) and exited after 251 ms"}]}
```

**The two fields that decide whether it is safe to upgrade:** `drained` is false while any
server is still running, and `lossy` counts *resumable worlds that were lost* — a war that
exited without a fresh exit checkpoint, or was SIGKILLed. A skirmish or a replay server
exiting with no snapshot is not a loss (`outcome: "exited_without_checkpoint"`,
`lossy: false`). `outcome` is one of `not_running` / `checkpointed` /
`exited_without_checkpoint` / `killed_after_timeout` / `still_alive`. `engine_hash` is the
identity of the binary that was running, i.e. the one these snapshots are bound to.

Room states are **not** changed by this route: the lobby's health loop classifies the exits
it causes exactly as it classifies an idle hibernation, a fraction of a second later.

**Errors:** 401 (no/invalid token), 403 (not an admin)

#### POST /api/admin/rooms/end

**Admin only.** `/api/admin/drain` specialized to **one** room: SIGTERM that room's game
server, wait for the exit checkpoint, verify it against the snapshot store, and return the
same per-room drain report. Audited as `room_end`. This is an operator / test-harness verb
("this room is wedged", "tear this test room down cleanly") — it is *not* a revival of the
removed player-facing `/api/rooms/end`: player room lifecycle stays entirely
`/api/rooms/leave`-driven.

```bash
curl -X POST http://localhost:8011/api/admin/rooms/end \
  -H "Authorization: Bearer <token>" -d '{"roomId":7,"timeout_ms":10000,"escalate":true}'
```

`roomId` is required and must be a positive integer. `timeout_ms` (default 10000) is clamped
to **[100, 30000]** — a tighter ceiling than drain's 120 s on purpose: this is a routine
per-test teardown, and like drain it blocks the lobby's HTTP thread while it waits.
`escalate` (default true) SIGKILLs a server that has not exited by then.

```json
{"ok":true,"roomId":7,"pid":55703,"kind":"persistent_war","exited":true,"escalated":false,
 "waitedMs":117,"outcome":"checkpointed","frame":9238,"label":"hibernate:signal",
 "lossy":false,"resume_eligibility":"resumable","engine_hash":"88499c90ffab2e37",
 "describe":"war room 7: checkpointed at frame 9238 (hibernate:signal) and exited after 117 ms"}
```

`outcome`, `lossy`, `resume_eligibility` and `engine_hash` mean exactly what they mean in the
drain report above. A **known room whose process is already gone** is a 200 with
`outcome:"not_running"`, not an error — the caller wanted it stopped and it is.

Room states are **not** changed by this route either: the room flips to ended asynchronously,
when the health loop observes the exit. Poll `/api/rooms` (or the MCP `probe_game`) if you
need to see it.

**Errors:** 400 `{"error":"roomId (positive integer) is required"}`, 401 (no/invalid token),
403 (not an admin), 404 `{"error":"unknown roomId"}` (the lobby has no such room). Note the
404 body: a *route-level* 404 (a lobby binary predating this endpoint) has no JSON body, which
is how the MCP `end_game` tool decides whether to fall back to a local SIGTERM.

#### Resume states on a war's room card

A war's room JSON carries `war.state` — `live` / `resuming` / `hibernated` / `crashed` /
`fresh` / **`unresumable`** — plus `frozen_frame` and `frozen_at` whenever the store holds
anything, and (task 3c) `war.resume_eligibility`: `resumable`, `no_history`,
`engine_changed`, `map_changed` or `unknown_binary`. When the eligibility refuses a resume,
`war.resume_blocked_reason` carries the sentence a player is shown, e.g.

```json
{"state":"unresumable","frozen_frame":1793,"resume_eligibility":"engine_changed",
 "resume_blocked_reason":"E1: the frozen world at frame 1793 was taken by engine 2d18454847f02919 and this server binary is 13c8413facfcb281 — snapshots do not cross a rebuild, so this war restarts at frame 0"}
```

The frozen frame is published **beside** the refusal, never instead of it: "hibernated at
1793" and "1793 is gone" are different sentences and the card must not tell the first one.
Such a war is still joinable — it comes back at frame 0. `unknown_binary` means the lobby
could not probe `spring-server --print-engine-hash` (a binary older than that flag), in
which case `--resume` is passed anyway and the game server's own E1 check refuses if it must.

### Rooms

All room endpoints require authentication.

| Endpoint | Method | Body | Description |
|----------|--------|------|-------------|
| `/api/rooms` | GET | | List all rooms |
| `/api/rooms` | POST | `{name, map, game}` | Create a room |
| `/api/rooms/join` | POST | `{room_id, password?}` | Join a room |
| `/api/rooms/leave` | POST | | Leave current room |
| `/api/rooms/ready` | POST | `{ready: true/false}` | Toggle ready state |
| `/api/rooms/team` | POST | `{team: 0-N}` | Set team |
| `/api/rooms/startpos` | POST | `{pos: 0-N, target_player_id?}` | Set start position |
| `/api/rooms/kick` | POST | `{target_player_id}` | Kick player (host only) |
| `/api/rooms/close` | POST | | Close room (host only) |
| `/api/rooms/ai/add` | POST | `{ai_id, name?, team?, profile?}` | Add AI slot |
| `/api/rooms/ai/remove` | POST | `{slot_index}` | Remove AI slot |
| `/api/rooms/ai/team` | POST | `{slot_index, team}` | Set AI slot's team (host only) |
| `/api/rooms/ai/profile` | POST | `{slot_index, profile}` | Set (or, with `profile:""`, clear) an AI slot's personality/difficulty profile — host only. `profile` is opaque, game-specific text (e.g. Metalstorm strategos's `"aggressive"`/`"caretaker"`); see PLAN-metalstorm-ai.md §10 task 6. |
| `/api/rooms/start` | POST | | Start game (spawns server) |

**Room object:**
```json
{
  "id": 1,
  "name": "My Game",
  "map": "scorched_crossing_v2.4",
  "game": "papertanks",
  "state": 1,
  "players": [
    {"player_id":5, "username":"test1", "team":0, "ready":true, "is_host":true, "start_pos":0}
  ],
  "ai_slots": [
    {"ai_id":"basic_ai", "name":"Basic AI", "team":1, "start_pos":-1}
  ]
}
```

Room states: 0=Configuring, 1=Filling, 2=ReadyCheck, 3=Loading, 4=Active, 5=Ended.

### Direct start (dev/test only)

**POST /api/rooms/direct** collapses the whole room dance (create → add AI → join → ready → start) into one call. It exists only when the lobby is launched with `--dev-direct-start` (default off; never set in a production config), and even then requires the caller to be on localhost *or* hold the **admin** role — two independent guardrails.

| Precondition | Response |
|---|---|
| `--dev-direct-start` not passed | `404` |
| Enabled, caller neither localhost nor admin | `403` |
| Bad/missing `map`, empty `players[]` | `400` |

Request — a manifest describing everything the three lobby screens collect:

```json
{
  "name": "dev:metalstorm-bench",
  "map": "green_flat_x34_v3",
  "game": "metalstorm",
  "modoptions": { "authority_cost_scale": "0" },
  "scenario": "scenario_smoke_test",
  "aiSlots": [ { "aiId": "null", "team": 1, "startPos": 1 } ],
  "players": [ { "username": "test1", "team": 0, "startPos": 0, "spectator": false } ],
  "autoStart": true
}
```

- `players[0]` becomes the room host. A declared username with no existing account is created on the fly and flagged `is_dev` — it gets an unusable random password (never logs in via `/api/auth/login`), only the session token minted here. A username already in a different room is force-left first.
- Re-POSTing the same `name` (or restarting the lobby with `--direct <manifest.json>` pointing at an unchanged manifest) tears down the old room and recreates it — idempotent, not additive.
- `idleStartupGraceSeconds` / `idleExitSeconds` (optional, non-negative integers) tune the spawned `spring-server`'s self-termination timers, forwarded as `--idle-startup-grace-seconds` / `--idle-exit-seconds`. Absent or `0` leaves the server's own defaults alone (startup grace **120 s**); a non-integer or negative value is a `400`, so a typo cannot silently keep the default. **Why it matters:** a server exits when no client has connected within the startup grace, so an exec-driven test that never opens a browser dies ~120 s in — for a skirmish that is at **frame −1**, because `GameStart` waits for the rostered humans. Raise the grace (or roster AI-only / `sessionKind: "persistent"`) for browserless runs. These fields exist on this dev route only; player-created rooms cannot reach the knob. Precedence in the server is flag > env > default, so the manifest field overrides a lobby-wide `SPRING_IDLE_STARTUP_GRACE_SECONDS` for that room. On a lobby binary predating this field the keys are ignored **without error** — the fallback there is to put `SPRING_IDLE_STARTUP_GRACE_SECONDS` in the lobby's environment, which every room it spawns then inherits (so pair it with teardown, or abandoned dev servers linger).
- `autoStart` (default `true`) drives the room through the same path `/api/rooms/start` uses, including its solo-team Null AI safety net. Set `false` to stop at a bound-but-unstarted room.
- `scenario` (optional) names a `scenarios/<name>.lua` world file (PLAN-persistence.md §5) for the game's `game_scenario.lua` gadget to stage at `GameStart` — pre-set units, region ownership, civilians, and objectives instead of the game's default start force. It must be this **top-level** manifest field. It is routed through the same default-resolution the Create Game dialog uses (`applyRoomScenario`), which runs *after* the manifest's `modoptions` are applied — so a `"modoptions": {"scenario": "..."}` entry on its own is silently **overwritten by the map's default scenario**. The room's final choice lands in the response `modoptions`, so a mismatch is visible there.

Response — the same room object `/api/rooms/start` already returns, plus a `sessions` map:

```json
{
  "id": 7, "name": "dev:metalstorm-bench", "map": "green_flat_x34_v3", "game": "metalstorm",
  "state": 3,
  "players": [ {"player_id":42, "username":"test1", "team":0, "ready":true, "is_host":true, "start_pos":0} ],
  "ai_slots": [ {"ai_id":"null", "name":"null", "team":1, "start_pos":1} ],
  "modoptions": { "authority_cost_scale": "0" },
  "game_server_port": 9103,
  "sessions": { "test1": "a1b2c3…" }
}
```

`game_server_port` is already valid in the response (`state` is `3`/Loading — the room flips to `4`/Active asynchronously once the spawned game server publishes ready, same as a normal `/api/rooms/start` call). There is deliberately no `wtInfo` field: the lobby process links neither a WebTransport server nor an outbound HTTP client, so it has no way to fetch the spawned game server's own `/api/wt/info` without either a new dependency or blocking this single-threaded HTTP loop for the game server's full cold-boot time (observed up to 90s+ for a heavy game). The caller does its own `/api/wt/info` discovery against `game_server_port` instead — exactly what the client already does after a normal lobby-walk start.

`--direct <manifest.json>` (lobby CLI flag) creates one standing room from a manifest file at lobby startup, driven through the same code path as the endpoint above. It is **not** gated by `--dev-direct-start` — it's supplied by whoever launches the process, not reachable remotely.

### Command Execution

**POST /api/exec** (requires admin)

Execute commands in lobby scopes. Admin role required (see [Roles and admin access](#roles-and-admin-access)).

| Scope | Commands | Description |
|-------|----------|-------------|
| `lobby` | `rooms` | List all rooms |
| `lobby` | `process list` | List game server processes |
| `sql` | any SELECT | Read-only SQL against the game database |

```bash
curl -X POST http://localhost:8011/api/exec \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"scope":"sql","code":"SELECT id, username FROM users LIMIT 5"}'
```

**Response:** `{"success":true,"output":"id=1 | username=alice"}`

SQL mutations (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE) are rejected.

### Processes

**GET /api/processes**

```json
[{"room_id":1,"port":9101,"pid":12345,"state":"running","map":"content/maps/...","game":"content/games/..."}]
```

States: `starting`, `running`, `ended`, `crashed`.

### Version

**GET /api/version**

```json
{"engine":"springweb","stamp":"5ca1489766-20260414143333","no_cache":false,"errorReportingEnabled":true}
```

The `stamp` field is the build stamp for cache-busting asset URLs. See [caching.md](caching.md).
`errorReportingEnabled` is the operator opt-out for [client error reports](#client-error-reports)
below (`--disable-client-error-reports`).

### Client Error Reports

**POST /api/client-errors** (requires auth — any valid session token)

See [PLAN-client-resilience.md](../PLAN-client-resilience.md) — the client-side watchdog/context-
loss/fatal-error detection hooks POST a crash report here for later triage. Size-capped at 40KB,
rate-limited to 20/hour per user (the client's own advisory cap is 5/hour per session), 400 on
malformed JSON. Reading the stored reports is the admin-only crash view below; how to interpret
one is in [debugging.md](debugging.md#client-crash-recovery--error-reports).

```bash
curl -X POST http://localhost:8011/api/client-errors \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"reason":"fatal","error_class":"TypeError","message":"boom","stack":"...","stack_hash":"...",
       "recovery_rung":"none","phase":"fx","frame":12345,"entity_count":200,
       "game_id":"zk","map_id":"green_flat","build_stamp":"...","gpu_renderer":"...",
       "log_ring":["[INFO] ...","[WARN] ..."],"count":1}'
```

**Response:** `{"ok":true,"id":42}`

Disable server-side with `--disable-client-error-reports` (self-hosted deployments only —
default is enabled). Stored reports are pruned after `--client-error-retention-days N`
(default 30; `0` disables pruning rather than deleting everything).

### Client Crash View (admin)

**POST /api/admin/client-errors** — `client_errors` grouped by stack hash, most-recently-seen
first. Admin role required (reports carry account ids, stacks and log-ring lines).

Request: `{"sinceDays":7,"limit":100}` — `sinceDays` 0 means all retained; `limit` is clamped to
1–200.

```json
{"ok":true,"retention_days":30,
 "groups":[{"stack_hash":"9f3a11cc","error_class":"TypeError","message":"latest sighting",
            "recovery_rung":"R3","reports":2,"occurrences":9,"users":1,
            "first_seen":"2026-08-04 01:01:40","last_seen":"2026-08-04 01:01:40",
            "first_build":"b100","last_build":"b200","games":"metalstorm,papertanks"}]}
```

`occurrences` is `SUM(count)` — it includes repeats the client deduped away before sending, so it
exceeds `reports` for a crash loop. `error_class`/`message`/`recovery_rung` come from the group's
**newest** report. Empty build stamps and game ids are left out of the range and the list.

**POST /api/admin/client-errors/detail** — every stored report for one stack hash, newest first.
This response is also the dashboard's export-to-JSON payload, so it carries full stacks and log
rings.

Request: `{"stack_hash":"9f3a11cc","limit":200}` (`limit` clamped 1–500). 400 if `stack_hash` is
missing.

```json
{"ok":true,"stack_hash":"9f3a11cc",
 "reports":[{"id":2,"created_at":"2026-08-04 01:01:40","user_id":2,"reason":"fatal",
             "error_class":"TypeError","message":"latest sighting","stack":"...","stack_hash":"9f3a11cc",
             "recovery_rung":"R3","phase":"render","frame":1800,"entity_count":80,
             "game_id":"papertanks","map_id":"green_flat","build_stamp":"b200",
             "gpu_renderer":"ANGLE (Apple M3)","log_ring":"[ERR] again","count":8}]}
```

Stacks are **minified** — there is no source-map upload pipeline. See
[debugging.md](debugging.md#reading-the-dashboard-crash-view).

---

## Game Server (dynamic port)

The lobby spawns a game server per room. Port is in the `RoomStateUpdate` message and `/api/processes`.

### Map Data

| Endpoint | Description |
|----------|-------------|
| `GET /api/map/info` | `{mapx, mapy, squareSize, widthElmos, heightElmos}` |
| `GET /api/map/heightmap` | Binary: u32 width, u32 height, float32[w*h] |
| `GET /api/metrics` | Performance stats JSON |

### Command Execution

**POST /api/exec** (requires admin)

Admin role required (see [Roles and admin access](#roles-and-admin-access)). The same gate applies to **POST /api/restart** (re-execs the game server in place).

| Scope | What it runs |
|-------|-------------|
| `LuaRules` | Lua code in the game-wide synced gadget state |
| `LuaGaia` | Lua code in the map/environment gadget state |
| `server` | Built-in server commands (see below) |

Lua expressions are auto-wrapped in `return` — `"return 1+1"` and `"1+1"` both work.

```bash
curl -X POST http://localhost:<game-port>/api/exec \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"scope":"LuaRules","code":"return Spring.GetAllUnits()"}'
# → {"success":true,"output":"{1, 2, 3}"}
```

#### Server Commands

| Command | Output |
|---------|--------|
| `frame` | Current sim frame number |
| `state` | `frame=N teams=N units=N` |
| `units` | List all units (id, def, team, hp) |
| `units <teamId>` | Units filtered by team |
| `defs` | `unit defs: N, weapon defs: N` |
| `pause` | Pause the simulation |
| `unpause` | Resume the simulation |
| `speed <N>` | Set game speed (0-100) |
| `break <file>:<line>` | Set a Lua breakpoint |
| `break list` | List all breakpoints |
| `break clear` | Remove all breakpoints |
| `continue` / `c` | Resume from breakpoint |
| `step` / `s` | Step one Lua line |
| `step_over` / `n` | Step over |
| `step_out` / `o` | Step out |

### WebTransport Endpoint Discovery

WebRTC and its `/api/rtc/*` SDP/ICE signaling endpoints were **removed** (GW7,
PLAN-game-worker.md / PLAN.md Stage 0). The realtime game stream now runs over
**WebTransport (QUIC/HTTP-3)** — no signaling handshake. The client fetches the
endpoint, then opens a WebTransport session straight to it.

**GET /api/wt/info** (no auth)

Dual cert-provisioning mode (PLAN-security-hardening.md task 5), selected by
whether the game server was launched with `--wt-cert`/`--wt-key`:

```json
// hashes mode (default — no --wt-cert/--wt-key): self-signed rolling cert pair
{"port":9100,"transport":"webtransport","certMode":"hashes",
 "certHashes":["<hex SHA-256, active cert>","<hex SHA-256, next cert>"],
 "certHash":"<hex SHA-256, active cert — back-compat single-hash field>"}

// webpki mode (--wt-cert/--wt-key given): CA cert, no hash published
{"port":9100,"transport":"webtransport","certMode":"webpki"}
```

The client opens `https://<host>:<port>/` via `new WebTransport(url, {
serverCertificateHashes:[{algorithm:"sha-256", value:<hash>}, ...] })` in
`hashes` mode (pinning both the active and the already-generated "next" hash
so a client holding a stale `/api/wt/info` answer still connects across a
rotation), or with no `serverCertificateHashes` option at all in `webpki`
mode (the browser validates the CA cert normally). It then authenticates with
an `AuthRequest` FlatBuffer over the control stream.

Production cert provisioning (loading, hourly auto-reload, certbot
integration) is documented in [docs/deployment.md](deployment.md).

Transport classes / priority tiers (PLAN-game-worker.md GW2):
- `control` — reliable, ordered bidi stream (FlatBuffer messages, commands, ACKs)
- `state` — newest-wins uni streams (entity/piece snapshots)
- `vision` / `bulk` — reliable uni streams at lower RFC 9218 urgency

---

## Log Server (default :8010)

### Log Queries

**GET /api/logs/{roomId}**

| Parameter | Default | Description |
|-----------|---------|-------------|
| `roomId` (path) | required | Room ID, or `0` for all sources |
| `limit` | 200 | Max entries |
| `level` | 0 | Min level (0=DEBUG, 2=NOTICE, 4=ERROR) |
| `section` | | Filter by section |
| `scope` | | Filter by scope |

```json
[{"id":42,"timestamp":1713024000000,"level":4,"section":"lua","scope":"LuaRules","process":"spring-server","frame":1234,"message":"runtime error..."}]
```

**GET /api/logs/stream** (SSE)

Real-time log streaming via Server-Sent Events. Connect with `EventSource` for continuous delivery:

```js
const es = new EventSource("http://localhost:8010/api/logs/stream");
es.addEventListener("log", (e) => {
  const entry = JSON.parse(e.data);
  // {level: 4, section: "lua", message: "runtime error..."}
});
```

Each event has type `log` with JSON data containing `level`, `section`, and `message` fields. Replaces the previous 2-second polling approach for real-time log viewing.

**GET /api/logs/search**

| Parameter | Description |
|-----------|-------------|
| `q` | Search text (substring match on message) |
| `limit` | Max results (default 200) |
| `level` | Min log level |

### Sessions

**GET /api/sessions**

```json
[{"session_id":"abc","room_id":1,"game_name":"papertanks","map_name":"wanderlust","started_at":1713024000,"ended_at":1713025000,"end_reason":"normal","exit_code":0}]
```

### Health

**GET /api/logs/sources** — returns `{"status":"ok"}`

---

## springcli

Command-line interface built on [libspringapi](../libspringapi/README.md). Binary at `build/debug/tools/springcli/springcli`.

### Quick Reference

```bash
# Auth (set once, reuse via SPRING_TOKEN)
export SPRING_TOKEN=$(springcli login --user test1 --pass test --server http://localhost:8011)

# Game server commands
springcli state
springcli frame
springcli defs
springcli units --team 0
springcli pause
springcli speed 2.0

# Lua execution
springcli lua "return Spring.GetAllUnits()"
springcli exec LuaRules "return Spring.GetUnitHealth(1)"

# Lobby queries
springcli sql "SELECT id, username FROM users"
springcli processes

# Log queries
springcli logs --level 4 --limit 10
springcli logs --search "runtime error"

# Raw HTTP
springcli get http://localhost:8010/api/logs/sources
springcli post http://localhost:8011/api/exec '{"scope":"lobby","code":"rooms"}'
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SPRING_SERVER` | (none) | Game server URL (dynamic — discover via `GET /api/processes` on lobby) |
| `SPRING_LOBBY` | `http://localhost:8011` | Lobby URL |
| `SPRING_LOG_SERVER` | `http://localhost:8010` | Log server URL |
| `SPRING_TOKEN` | | Auth token (from `springcli login`) |
| `SPRING_USER` | | Auto-login username |
| `SPRING_PASS` | | Auto-login password |

### Exit Codes

`0` = success, `1` = command failed, `2` = usage error.

---

## FlatBuffers Protocol (over WebTransport)

Binary messages use an envelope byte prefix:

| Byte | Format | Channel |
|------|--------|---------|
| `0x01` | FlatBuffers (`ServerMessage` / `ClientMessage`) | control (reliable) |
| `0x02` | Entity state full snapshot (struct-of-arrays) | state (unreliable) |
| `0x03` | Entity state delta (struct-of-arrays) | state (unreliable) |
| `0x04` | Projectile state (struct-of-arrays) | state (unreliable) |

Key message types in the `ClientPayload` union: AuthRequest, PlayerCommand, ViewportUpdate, Ping, ConsoleCommand, LogIngest, LogSubscribe, all Room* messages.

Key message types in the `ServerPayload` union: AuthResponse, MapData, GameUnitDefs, GameWeaponDefs, EntityCreate, EntityDestroy, GameEventBatch, ConsoleResponse, LogBatch, GameStarted, all Room* updates.

Schema source: `schemas/protocol.fbs`. Regenerate bindings: `make client-protocol`.

---

## HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created (registration) |
| 400 | Bad request (missing/invalid fields) |
| 401 | Unauthorized (missing or expired token) |
| 403 | Forbidden (banned, not host) |
| 404 | Not found (room, file, player) |
| 409 | Conflict (username taken) |
| 500 | Server error |
