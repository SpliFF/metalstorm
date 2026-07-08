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

```bash
curl -X POST http://localhost:8011/api/auth/register \
  -d '{"username":"newplayer","password":"secret"}'
```

**Response (201):**
```json
{"token":"...","user_id":6,"username":"newplayer","role":"player"}
```

**Errors:** 400 (invalid username length), 409 (username taken)

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
# 1. register the operator account (if it doesn't exist yet)
curl -X POST http://localhost:8011/api/auth/register \
  -d '{"username":"admin","password":"<password>"}'

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
| `/api/rooms/ai/add` | POST | `{ai_id, name?, team?}` | Add AI slot |
| `/api/rooms/ai/remove` | POST | `{slot_index}` | Remove AI slot |
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
  "aiSlots": [ { "aiId": "null", "team": 1, "startPos": 1 } ],
  "players": [ { "username": "test1", "team": 0, "startPos": 0, "spectator": false } ],
  "autoStart": true
}
```

- `players[0]` becomes the room host. A declared username with no existing account is created on the fly and flagged `is_dev` — it gets an unusable random password (never logs in via `/api/auth/login`), only the session token minted here. A username already in a different room is force-left first.
- Re-POSTing the same `name` (or restarting the lobby with `--direct <manifest.json>` pointing at an unchanged manifest) tears down the old room and recreates it — idempotent, not additive.
- `autoStart` (default `true`) drives the room through the same path `/api/rooms/start` uses, including its solo-team Null AI safety net. Set `false` to stop at a bound-but-unstarted room.

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
{"engine":"springweb","stamp":"5ca1489766-20260414143333","no_cache":false}
```

The `stamp` field is the build stamp for cache-busting asset URLs. See [caching.md](caching.md).

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

```json
// Response: {"port":9100,"certHash":"<base64 SHA-256 of the dev cert>","transport":"webtransport"}
```

The client opens `https://<host>:<port>/` via `new WebTransport(url, {
serverCertificateHashes:[{algorithm:"sha-256", value:<certHash>}] })` (dev pins
the ephemeral self-signed cert; prod uses a CA cert and omits the hash), then
authenticates with an `AuthRequest` FlatBuffer over the control stream.

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
