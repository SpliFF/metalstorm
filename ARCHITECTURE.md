# Architecture Reference

Quick-reference for navigating the codebase. Read this before searching.

## Build Commands

```
make setup              # cmake --preset debug + npm install + generate protocol
make build              # cmake --build build/debug (spring-server + spring-lobby)
make dev-client         # npm run dev (Vite dev server on :5173)
npx vite build          # production client bundle → client/dist/
npx vite preview        # serve the built bundle (local prod-shape stand-in — see below)
npx tsc --noEmit        # TypeScript type-check (no emit)
```

Regenerate FlatBuffers bindings after editing `schemas/protocol.fbs`:
```
build/debug/_deps/flatbuffers-build/flatc --ts --gen-object-api -o client/src/protocol/ schemas/protocol.fbs
build/debug/_deps/flatbuffers-build/flatc --cpp -o rts/ schemas/protocol.fbs
```

## Executables

| Binary | Entry point | Role |
|--------|------------|------|
| `spring-lobby` | `rts/lobby_main.cpp` | HTTP/2 + HTTP/1.1 lobby server. Manages rooms, spawns game servers, preprocesses maps/games at startup. |
| `spring-server` | `rts/server_main.cpp` | Headless game sim. One per active room, spawned by lobby as a child process. Runs sim at 30Hz, streams entity state. |
| `spring-logserver` | `rts/logserver_main.cpp` | Dedicated log collection server. Receives LogIngest via WS, stores in SQLite (debug.db), streams to subscribers, serves HTTP query API. SSE endpoint for live log streaming. |

### spring-lobby CLI

```
./spring-lobby --port 8011 --maps content/maps --games-dir content/games
```

### spring-server CLI

Game servers are spawned by the lobby with dynamically assigned ports. To discover running game server ports, use the lobby's process list API (`GET /api/processes`) or the `list_processes` MCP tool.

```
# Example (ports are assigned dynamically — do not hardcode):
./spring-server --port <dynamic> --game content/games/papertanks --map content/maps/wanderlust2.1 \
  --db data/spring-server.db --log-server ws://localhost:8010 --log-level info \
  --player "alice:0:0" --player "bob:1:1" --ai "basic_ai:2:-1"
```

Full CLI flag list (from `rts/server_main.cpp`):
`--port`, `--game`, `--game-version`, `--map`, `--db`, `--log-file`, `--log-level`, `--log-server`, `--log-sqlite`, `--debug`, `--no-cache`, `--log-messages`, `--wt-cert <path>`, `--wt-key <path>` (WebTransport prod cert — see below), `--player username:team:pos` (repeatable), `--ai id:team:pos` (repeatable). The IPC pipe and `--event-fd` are gone; a game→lobby backchannel (PLAN-lobby-game-connection.md) is **not yet implemented** (TODO — targets WebTransport when built).

## Directory Map

### Server C++ (`rts/`)

| File | Purpose |
|------|---------|
| `server_main.cpp` | Game server entry. After WP1 it owns only boot + wiring + the tick-loop skeleton: arg parsing, signal/logging init, content roots, DB/map open, sim init, def-cache bake, AI slot resolution, tick timing, idle-exit `game_status` heartbeat, shutdown. Per-tick broadcasts, the client-message switch, the HTTP routes, and the game-start lambdas are delegated to the four units below (all sharing a `GameServerContext`). |
| `Server/GameServerContext.h` | **WP1**: header-only aggregation of references/pointers (net, rtcServer, sim, db, sessions, rooms, aiPool, luaExecEngine, identity/config, roster maps) that the extracted units share. No ownership, no logic. Also holds `RequestedPlayer`/`RequestedAI`. |
| `Server/GameStartCoordinator.h/.cpp` | **WP1**: `PushStandingOrdersTo` / `BuildTeamStartInfoMsg` / `CheckAndFireGameStart` (formerly main()-scope lambdas). Drives the roster-complete → FireGameStart rendezvous. |
| `Server/ClientMessageHandler.h/.cpp` | **WP1**: the inbound client-message dispatch switch (auth, player commands, viewport, room ops, Lua msgs, console, selection, path requests, standing orders) — one `Handle<Payload>` method per case. `main()`'s loop just calls `HandleMessage` per drained message. |
| `Server/StateStreamer.h/.cpp` | **WP1**: the per-tick broadcast pipeline. `Tick(frameNum)` runs CheckWinCondition → resources → command queues → game-info → entity/piece state → build activity → standing-orders → AI → combat/deaths/sensors/decals/heightmap/sendToUnsynced/playerTeam/teamStats/luaRulesMsg/unit+feature lifecycle/unit commands → LOS bitmaps, in the exact original order (order is behaviour). |
| `Server/RulesParamKeyDict.h/.cpp` | The pure half of the rulesParams key-dictionary compaction (PLAN-long-uptime S1): `ShouldCompact` (is enough of the interned id space dead to be worth a full re-broadcast?) and `Rebuild` (re-issue ids from the live key set, in **sorted** key order so the result is a function of the live set and not of insertion history). Split out of `StateStreamer` so it is testable without an RTC server; `StateStreamer::CompactKeyDictionary` owns the impure half. |
| `Server/GameHttpRoutes.h/.cpp` | **WP1**: `RegisterGameHttpRoutes(ctx, content, …, restartRequested&, keepRunning&)` — heightmap/map-info/maps/metrics/`/api/restart`/`/api/exec`/`/api/wt/info` registrations moved out of `main()`. |
| `lobby_main.cpp` | Lobby entry. Room management, game/map preprocessing, child process spawning, HTTP routes. |
| `Server/Simulation.h/.cpp` | Initialises Spring subsystems, ticks physics/units/weapons/features each frame. |
| `Server/NetworkServer.h/.cpp` | HTTP/2 (h2c via nghttp2) + HTTP/1.1 server (REST/SSE/assets only). Realtime game traffic now runs over WebTransport (`WebTransportServer`), not WebRTC. Send/broadcast helpers. |
| `Server/WebTransport/WebTransportServer.h/.cpp` | **WebTransport (QUIC/HTTP-3) game transport** — Stage 0 replacement for WebRTC (PLAN-game-worker.md). ngtcp2 + nghttp3 + OpenSSL 3.5 QUIC TLS. Full stack landed + Chrome-verified (GW1-H3): QUIC handshake, hand-rolled HTTP/3 framing + nghttp3 standalone QPACK, WebTransport draft-02 extended-CONNECT + stream/datagram demux (`0x54` uni / `0x41` bidi / quarter-stream-id). Mirrors the WebRTCServer seam + adds `StreamClass` priority tiers. QUIC stack is a **hard build dependency** (no WebRTC fallback). Echo-test it with `spring-quic-derisk serve <port>`. **Dual-mode cert provisioning** (PLAN-security-hardening.md task 5): no `--wt-cert`/`--wt-key` → `Hashes` mode (self-generated ECDSA-P256, ≤14-day rolling pair, `CertHashes()` publishes active+next for `serverCertificateHashes`); `--wt-cert <pem> --wt-key <pem>` → `Webpki` mode (CA cert, browsers validate normally, no hash published). Hourly mtime poll reloads a changed on-disk cert without dropping connections (TLS 1.3 doesn't renegotiate mid-session). `ReloadCert()` exists for a forced immediate check but is deliberately **not** wired to an OS signal — signal delivery to this process while a Webpki-mode cert is loaded was found to corrupt OpenSSL's heap state at exit, reproducibly, regardless of whether the reload logic itself ran; `SIGHUP`/`POST /api/restart` (full restart, which re-reads the cert fresh) remains the manual-immediate fallback — see `docs/deployment.md`. |
| `Server/Protocol.h` | FlatBuffers message builders (BuildAuthResponse, BuildMapData, BuildGameUnitDefs, etc.). |
| `Server/EntityStateSerializer.h/.cpp` | Serialises unit state to Tier 2 binary (struct-of-arrays, field-masked). |
| `Server/ProjectileStateSerializer.h/.cpp` | Serialises synced weapon projectiles to envelope 0x04 binary. |
| `Server/EntityDeltaCache.h/.cpp` | Per-client delta tracking to reduce bandwidth. |
| `Server/ContentServer.h/.cpp` | Scans content roots, serves assets at `/api/content/assets/*`. |
| `Server/AuthTokens.h/.cpp` | **Task 8a**: the two credentials that outlive the 24 h access session — `refresh_tokens` (rotating, single-use, family-scoped revocation on reuse) and `war_reconnect_tokens` (per-(account, war), 7-day). Both store **sha256 of the token, never the token**: a read of the db file is otherwise a month of impersonation. sha256 rather than scrypt because these are 32 bytes of CSPRNG — there is no dictionary — and the cost would land on the validate path the game server hits on every reconnect. `ValidateWarReconnect` takes the roomId as an **argument** so a caller cannot forget to check it. |
| `Server/Totp.h/.cpp` | **Task 8d**: the optional second factor — RFC 6238 (HMAC-SHA1, 30 s steps, 6 digits, ±1 step of drift) plus `user_totp` / `user_totp_recovery`. **Both the arithmetic and the table live here on purpose**: the replay rule is a comparison in `VerifyCode` and a column (`last_step`), and splitting them would let a caller do the check and forget the write — so `VerifyCode` takes the last accepted step and RETURNS the step it matched, and the caller has something it must store. An enrolment has **three** states: unconfirmed (gates nothing), confirmed (gates login AND Basic auth), absent. Recovery codes are sha256 at rest and spent by the DELETE itself. |
| `Server/GuestAccounts.h/.cpp` | **Task 8c**: provisional (guest) accounts and the upgrade. A guest is a real `users` row with `is_provisional=1`, **an empty `password_hash`** and a device token (`guest_devices`, sha256 at rest via `AuthTokens::HashToken`). The empty hash is load-bearing rather than lazy: `Crypto::VerifyPassword` compares any non-`scrypt$` stored value as legacy plaintext, so a sentinel like `"!guest"` would be a working password for every guest in the deployment — the empty string is the one value that path refuses unconditionally, which is what makes a guest unreachable by `/api/auth/login` AND by Basic auth without either knowing guests exist. **The upgrade does not move the account** — everything durable is keyed on `users.id` (`war_player_bindings`, `war_reconnect_tokens`, `command_presets`, `admin_audit`), so `ConfirmProvisionalUpgrade` is one guarded UPDATE on the row that already exists and a future table keyed on the id inherits the property for free. The device token does **not** rotate (a lost race between two tabs would delete an account with no password to recover with) and **is** revoked by the upgrade. `DecideUpgrade` is the pure policy: a provisional faction is mutable and a confirmed one is not, so an upgrade that CHANGES the faction inherits §1b and clears the account's bindings + war tokens — "upgrade without losing progress" is true when the faction is kept and deliberately false when it is switched. |
| `Server/Database.h/.cpp` | SQLite wrapper (accounts, sessions, `admin_audit`). Ban primitives (`SetBanned`/`SetBannedByUsername`/`RevokeUserSessions`/`GetBannedUsers`, PLAN-gm-tools task 4). |
| `Server/GameMetrics.h/.cpp` | **PLAN-gm-tools task 1**: `GameMetricsWriter` — per-game sim-health rows (tick p95, frames-behind, entity count, uptime, db size) into the shared `game_metrics` table on a wall-clock cadence; 7-day-raw / hourly-tail downsampling (E5). Driven from `server_main.cpp`'s loop. |
| `Server/GmVerbs.h/.cpp` + `GmRollback.cpp` | **PLAN-gm-tools task 2**: the GM verb set — `RegisterGmVerbs` installs `POST /api/gm/{pause,resume,grant,broadcast,inspect,kick,rollback,checkpoint,hibernate,snapshots}` (all `RouteAuth::AdminOnly` + in-handler role recheck + `LogAudit`; compiled into prod, unlike `/api/exec`). Rollback rides the `ISnapshotStore` seam, now backed by `GameStateStore` (see below). The pure `DoRollback` sequence lives in `GmRollback.cpp` (dependency-light, unit-tested). |
| `Server/GameStateStore.h/.cpp` | **PLAN-persistence task 1**: the durable half of game-state snapshots, and the live `ISnapshotStore` implementation. Owns the `game_snapshots` table, a 112-byte self-describing blob frame (magic/version/engineHash/layoutHash/mapDigest/sha256), zlib compression, one-snapshot-per-transaction atomicity, last-K retention, and the two refusal ladders: **E1** hash mismatch (refuse loudly, never half-load — checked before decompression) and **E2** corruption (sha256 per rung, fall back through the retained K, `unresumable` when all fail). Writes are double-buffered: the sim thread only pays for `ISimSerializer::Serialize`, a worker compresses and commits. A restore reports through `syncedinput::Journal().RecordSnapshotRestore()`. **What produces the payload is `Server/SimSnapshot.h/.cpp`** (below); until that walk covers every declared section it is not attached, `Available()` stays false, and the GM verbs refuse with a reason naming the gap. **Rows are partitioned by the pair (`game_id`, `room_id`)**, and retention is last-K *per room*: `game_id` is the content id (`--game`), the lobby launches every room's game-server against the same `--db`, and scoping on `game_id` alone let one room prune another's history away and then restore that room's world (E1 cannot catch it — identical stamps). `roomId` stays a per-call argument rather than a `StoreConfig` field so there is only one source of truth for it; see the header's "ROOM SCOPING". Pure w.r.t. the sim (sqlite3 + zlib + libcrypto only), so it is doctested in `tests/test_game_state_store.cpp` against a synthetic serializer. |
| `Server/SimSnapshot.h/.cpp` | **PLAN-persistence task 1b**: the `ISimSerializer` implementation — a purpose-written walk over the server's own synced state (Q-P1 **option B**; creg is a stub in this tree and is not coming back). The payload is a list of self-describing **sections** (`u16 id`, `u16 version`, `u32 len`), and **every part of the synced state the walk must cover has a `SectionSpec` — including the parts that are not written yet**. Landed: `globals` (sim frame, `paused`, synced-RNG position+stream), `standingOrders`, `orgGroups`, `directives`. Declared gaps: `teams`/`units` (task 1c), `syncedLua` (task 1d). `Serialize()` **refuses by name** while any declared section is unimplemented, so no configuration produces a payload known to be partial; `SerializeImplemented()` is the ungated body, for tests and for 1c/1d to extend. `LayoutHash()` is **derived from the section table** (FNV-1a over the envelope version plus each implemented section's id+version), so E1's refusal moves mechanically on a shape change rather than by an author remembering. `Deserialize()` stages every section into locals and swaps only after the whole payload reads clean (§2's "never half-load"); an unknown section id, a version the codec does not speak, or trailing bytes inside a section are all **refusals, not skips** — E1 already rejects foreign blobs, so anything unrecognised means the bytes are not what the header claims. The completeness tripwire (Q-P1 constraint 4) is a **field census**: `census::*` destructures every member of each serialized struct, so adding a field to `StandingOrder`/`Directive`/`OrgGroup`/`StandingOrderConditions` is a **build failure**, not a field that silently stops being snapshotted. State deliberately left out because the sim rebuilds it (LOS maps, quad-field membership, path caches) is enumerated in `DerivedNotCaptured()` with what rebuilds it — in-flight projectiles are listed there as a **deliberate loss**, not a rebuild. `tests/test_sim_snapshot.cpp`. |
| `Server/GrowthCounters.h/.cpp` | **PLAN-long-uptime task 3**: the growth-counter set + static alarm thresholds (`Evaluate`/`ToJson`/`ParseAlarms`/`ThresholdsFromEnv`). Pure — no sim, no sqlite — so both binaries link it: `server_main.cpp` gathers the engine-coupled readings (RSS, synced Lua heap, interned key dictionary, unit-id occupancy + spawn generations, standing orders, player rows) on the metric cadence and writes them into `game_metrics.extra_json`; `lobby_main.cpp` parses the same blob back for fleet badges and the drill-down charts, and its maintenance loop turns alarm *transitions* into `admin_audit` rows. Thresholds documented in `docs/gm-tools.md`. |
| `Server/GmVerbs.h/.cpp` + `GmRollback.cpp` | **PLAN-gm-tools task 2**: the GM verb set — `RegisterGmVerbs` installs `POST /api/gm/{pause,resume,grant,broadcast,inspect,kick,rollback,checkpoint,hibernate,snapshots}` (all `RouteAuth::AdminOnly` + in-handler role recheck + `LogAudit`; compiled into prod, unlike `/api/exec`). Rollback rides the `ISnapshotStore` seam (`NullSnapshotStore` until PLAN-persistence's `GameStateStore` lands → refuses cleanly, audited). The pure `DoRollback` sequence lives in `GmRollback.cpp` (dependency-light, unit-tested). |
| `Server/GmDashboardPage.h` | **PLAN-gm-tools task 3**: the self-contained GM ops dashboard HTML/JS, served by the lobby at `GET /admin`. |
| `Server/RoomManager.h/.cpp` | Room lifecycle (create/join/leave/start/end), player rosters. **Seating rule (PLAN-endtoend D19 + D40):** a room's `war_sides` modoption (`"compact:0,union:1"`, written once by the lobby from the scenario) is the only side↔team mapping; `GameRoom::SideTeams()` reads the pairs, `SlotTeams()` is its integer projection (with the legacy `{0,1}` fallback), and `TeamForFaction()` is the lookup that makes `users.faction_id` mean something. An account's faction **outranks the auto-balancer** in `JoinRoom` and in `EnlistSpectator`'s auto-assign — a permanent allegiance is not a balancing input — while an *explicit* team (`SetTeam`, `AddAISlot`, a 255-free `EnlistSpectator`) stays permissive, because `/api/rooms/direct` manifests legitimately seat NPCs and fixture accounts on teams no side declares. Faction rides in as a caller-supplied parameter; RoomManager never touches the database. |
| `Server/MapProcessor.h/.cpp` | SMF parsing, heightmap/minimap/feature extraction, model conversion. Only linked by `tools/mapconverter`. |
| `Server/MapMetadataDb.cpp` | Read-only SQLite access for map metadata. Used by lobby and game server. |
| `Server/GameProcessor.h/.cpp` | Scans `objects3d/`, converts S3O→glb via modelimporter, converts textures. |
| `Server/CombatEventCollector.h/.cpp` | Hooks DoDamage, collects hit/miss/kill events for broadcast. |
| `Server/SoundEventCollector.h/.cpp` | Per-tick collector for `SoundEventData` (sound id, source def + kind, position, channel, priority). Drained into `GameEventBatch.sounds`. |
| `Server/MusicStateTracker.h/.cpp` | Combat-intensity state machine (peace / tension / battle / victory / defeat). Sampled per tick by `BuildCombatEventBatch`; emits a `MusicEvent` on each state transition. |
| `Server/ClientSession.h` | Per-client auth state, team, viewport. |
| `Server/LuaExecEngine.h/.cpp` | Thread-safe console command queue + Lua/server scope execution. The `server` scope handles low-level commands (`frame`, `state`, `units`, `pause`, `unpause`, `speed`, debugger ops) plus the test-harness verbs (`spawn`, `kill`, `damage`, `order`, `clear`, `log`, `unit_state`, `combat_summary`). |
| `Server/DebugFlags.h/.cpp` | Runtime-toggleable verbose-logging switches (`combat`, `sound`, `weapon`, `explosion`, `order`, `unit`, `script`). Toggled via `server log <subsystem> on\|off`; read by `Push()` in CombatEventCollector / SoundEventCollector and by `CWeapon::Fire`. |
| `Server/LuaDebugger.h/.cpp` | Lua breakpoints, stack inspection, step/continue, sim pause. |
| `Server/AI/AIRuntimePool.h/.cpp` | Pool of Lua AI runtimes, one per AI player. |
| `Server/AI/AIDiscovery.h/.cpp` | Scans `content/engine/ai/` + game ai dirs for plugins. |
| `Server/FactionData.h/.cpp` | Reads a game's `gamedata/sidedata.lua` into `FactionInfo{key,name,fullName,description,startUnit}`. Bare-`lua_State` reader like `ConfigReader`/`AIDiscovery`, plus a minimal `VFS.Include` shim (BAR's sidedata includes `sides_enum.lua`). `key` is `name` lowercased, matching `SideParser`'s side-key derivation, so it stays in parity with the value stored in `users.faction_id`. Feeds `/api/factions/<gameId>` and the registration/admin faction validation. Missing or broken data yields an empty list, never an error. |
| `Server/WarPlayerBindings.h/.cpp` | `war_player_bindings`: one row per (war room, account) — the side the account holds, first/last seen, and its per-player war state (authority pool + `score_*` participation credit). Written by the game server, read by the lobby, deleted by the audited faction override and by room deletion (room ids are reused). Pure sqlite, no sim. Migrated additively, never probe-and-dropped: it is the only copy of the state. `username` is a **denormalised copy** for operator reads and log lines — every functional reader keys on `account_id` — and `RenameAccount` is its only maintainer, added by task 8c because the guest upgrade is the first path in the system that can rename an account at all. |
| `Server/WarRejoinPolicy.h` | Pure decision for a returning player: seat restored / superseded / none, and pool-restore vs onboarding stipend. Two horizons — `WAR_SEAT_HOLD_SEC` (a week, capacity bypass only) and `WAR_BRIEF_ABSENCE_SEC` (5 min, pool staleness). No db, no sim. |
| `Server/WarStateSim.h/.cpp` | The two directions between the sim and that row: `CaptureWarPlayerState` reads the rules params; the restores call `GG.Authority.RestorePool` / `GG.Teams.RestoreScore` in synced Lua (top-ups, not deposits) through `ExecuteInLuaState`. Never over `RecvLuaMsg` — a client can forge those. Also holds the two impure gatherers for the war digest (`GatherWarSummaryPlayers`, `GatherWarSummaryRegions` — the latter scans the gameRulesParams map for `region_<key>_team`, so it needs no call into synced Lua on a wall-clock heartbeat). |
| `Server/WarSummary.h` | The per-war digest the war browser reads, encoder and decoder in one file across a process boundary: `BuildWarSummary` (pure) → `EncodeWarSummary` → `war_summary` row (spring-server is the only writer, on the 2 s `game_status` heartbeat) → `DecodeWarSummary` in the lobby. Carries only what the sim alone knows — per-side connected humans/AIs, spectators, region control, frame, server uptime. A row older than `kWarSummaryStaleSec` (30 s) is treated as absent, because nothing clears it when a server is SIGKILLed. |
| `Server/RoomWatchIntent.h` | `AccountWantsToWatch(db, roomId, accountId)` — the one reader of `room_members.spectate_only`, the "I came to watch this war" flag the lobby records on join and the game server honours on auth (§3). Defaults false for every uncertain case: missing the intent seats a watcher who can leave, inventing one benches a fighter silently. |
| `System/SpringLog/SpringLog.h/.cpp` | Unified logging library (libspringlog). C/C++ API, console + file sinks, pluggable custom sinks. |
| `System/SpringLog/SpringLogNet.h/.cpp` | Optional WS+FlatBuffers network sink for pushing logs to log server. |
| `System/SpringLog/SpringLogSqlite.h/.cpp` | Optional SQLite persistence sink for local log storage. |
| `System/SpringLogBridge.h/.cpp` | Routes legacy Spring LOG() macros through springlog. |

### Simulation (`rts/Sim/`)

| Subsystem | Key files | Notes |
|-----------|-----------|-------|
| Units | `Units/Unit.h`, `UnitDef.h`, `UnitDefHandler.h`, `UnitHandler.h` | `unitDefHandler` is the global; `GetUnitDefsVec()` returns all defs. |
| Commands | `Units/CommandAI/CommandAI.h`, `Command.h`, `MobileCAI.cpp` | Player commands route through `CCommandAI::GiveCommand()`. |
| Weapons | `Weapons/Weapon.h`, `WeaponDef.h`, `WeaponDefHandler.h` | Weapon types: Cannon, LaserCannon, MissileLauncher, etc. |
| Movement | `MoveTypes/GroundMoveType.cpp`, `MoveDefHandler.h` | Pathfinding via `Path/Default/PathManager.cpp`. |
| Features | `Features/Feature.h`, `FeatureDefHandler.h` | Static map objects (rocks, trees, wrecks). |
| Misc | `Misc/QuadField.h`, `Misc/LosHandler.h`, `Misc/TeamHandler.h` | Spatial queries, fog of war, team resources. |

### Client TypeScript (`client/src/`)

| File | Purpose |
|------|---------|
| `main.ts` | App entry. Lobby init, `startGame()`, HUD wiring. **GW4-c1**: `startGame()` now transfers `#game-canvas` to the game-processor worker (`gp:init`) and spawns it; the Babylon Engine + render loop + game connection live in the worker, not here (PLAN-game-worker.md). |
| `config.ts` | Server URL, API base paths. |
| `core/connection.ts` | WebTransport game-stream connection to server (over `WebTransportAdapter`). FlatBuffers dispatch. Events: `onMapData`, `onUnitDefs`, `onEntityState`, `onCombatEvents`, etc. GW4 relocates it into the game-processor worker (PLAN-game-worker.md). |
| `core/transport.ts` | Transport abstraction over the game connection. `WebTransportAdapter` (QUIC/HTTP-3) — class-based send (`control`/`state`/`vision`/`bulk`/`datagram`), newest-wins state. WebRTC removed (PLAN-game-worker.md). |
| `core/game-worker-protocol.ts` | **Frozen GW4 message contract** (PLAN-game-worker.md): the game-processor worker ⇄ main-thread interfaces (`Gp*ToWorker` init/input/config, `Gp*ToMain` sceneState/audio/config/gameOver). Also (WP2c) `LegacyWorkerMessage` (all legacy `type` strings) + `WorkerInbound` union used to type `self.onmessage`. |
| `core/entity-renderer.ts` | Per-piece thin-instanced unit renderer. Loads `.glb` via `setUnitDefs()`, groups by (defId, team, pieceIdx). Fallback: procedural shapes. Also publishes `getMemberModel(defId, team)` — a member-sized mesh + team material for the squad fan-out. Those meshes live in a **separate** `memberModelMeshes` map, not `renderMeshes`: `tick()`'s hide-pass zeroes every `renderMeshes` entry it didn't write this frame, which would fight a caller driving its own thin instances. |
| `core/squad-render-backend.ts` | Babylon implementation of the Metalstorm squad `RenderBackend` (`data/games/metalstorm/client/squads/`): draws the cosmetic members one sim squad fans out into. Three visual classes, chosen **per member per frame by camera distance** (impostors M4) — **model** (a def with a 3D body, closer than its `impostorDistance`: the real low-poly body with real `headingY` facing, one thin-instance pool per model piece), **impostor sprite** (the same member beyond `impostorDistance`, or any atlas def whose model has not streamed yet: baked 8-yaw × 3-pitch directional card), **proxy capsule** — the **last resort**, held only when a member's def offers neither tier this frame (no atlas *and* no loadable body; the server names those defs at defs-bake time, see below). The two art tiers gate independently: a def with a body but **no** atlas has no sprite tier to hand over to, so its effective `impostorDistance` is `Infinity` and it holds the model tier at every range. The model↔sprite boundary crossfades via a screen-door dither band just inside `impostorDistance` (M5), so neither tier pops. **A pool slot index is not stable for the life of the member** (PLAN-perf M24): pools compact — live slots move down into freed holes so `highWater` can fall — so a slot must always be addressed through the `MemberSlot` object the pool holds a back-reference to, never through a copied-out index. |
| `core/feature-renderer.ts` | Thin-instanced map feature renderer. Types with no baked impostor atlas keep the single whole-map mesh (pattern reference for entity-renderer); types listed in a `models/impostors.json` manifest are handed to `FeatureLodController` instead. Also hosts `DynamicFeatureRenderer` (runtime wrecks/debris). |
| `core/feature-lod.ts` | PLAN-maps.md M6 — pure spatial-chunking + tier math for the map-feature LOD (tile partition, point→AABB distance, `assignTier` with hysteresis, `farDensity` prefix thinning). No Babylon imports; unit-tested. |
| `core/feature-lod-renderer.ts` | PLAN-maps.md M6 — Babylon side of the feature LOD: per (type, tile) NEAR (full mesh, casts CSM) / FAR (impostor card, no shadows) / CULLED meshes with static matrix buffers, dither crossfade, per-tile frustum culling. Debug: `window.__gp('__featureLod.get()/.set()/.force()')`. **Clones must `makeGeometryUnique()`** — thin-instance buffers live on the Geometry, which `Mesh.clone()` shares. |
| `core/impostor-atlas.ts` | Runtime half of the sprite-atlas convention (yaw × pitch × frame grid, cell index, cell→UV, card-tilt rule). Shared by the feature LOD and the unit/squad impostor path. Pure + unit-tested. Each atlas **declares** its elevation arc (`pitchDegrees`) and azimuth phase (`azimuthPhaseDegrees` on the wire → `azimuthPhase` radians) rather than assuming a global one — phase 0 means column 0 is the instance's **back** (relative yaw 0 puts the camera behind it). Baker half is `tools/fable-model-forge/impostor_convention.py`; a vitest cross-check executes it, round-trips every cell of every shipped convention, AND checks each cell's UV rect back into pixels against the baker's own `cell_origin`. **V runs top-down** (row 0 → `ov = 0`, no flip): every atlas ships as KTX2, and Babylon's KTX2 loader cannot honour `invertY` (compressed data can't use `UNPACK_FLIP_Y`, and that path sets no `_invertVScale` compensation as the KTX1 one does), so a KTX2 always lands with its TOP image row at v = 0 — the same convention glTF UVs already use. Impostor cards are built to match by `createImpostorCard()` (impostor-renderer.ts), which is where the flip is owned; assuming Babylon's bottom-up procedural-mesh UVs instead rendered every impostor mirrored AND on pitch row `pitchBins-1-row` (2026-08-03). |
| `core/impostor-uv-plugin.ts` | Material plugin: per-instance atlas-cell UV remap (`impostorCell` attribute) + shared screen-aligned billboard rotation, both vertex-stage, so impostor matrix buffers stay static. Its GLSL is a hand copy of `atlasCellUv`; a vitest extracts both `_impOffV` expressions from the emitted shader and evaluates them against the TS function, so neither half can be changed alone. |
| `core/dither-fade-plugin.ts` | Material plugin: screen-door (4×4 Bayer) crossfade for LOD swaps. Fade from a uniform or a per-thin-instance `ditherFade` attribute; `invertPattern` gives the outgoing/incoming tiers complementary halves. |
| `core/projectile-renderer.ts` | Renders in-flight projectiles (thin instances, per-weapon-type shapes). |
| `core/build-beam-renderer.ts` | Translucent build-beam shader (procedural cross-section) for nano-spray VFX. |
| `core/build-activity.ts` | Per-tick build progress wiring; nanoframe state. |
| `core/build-menu.ts` | In-game build menu UI (unit selection panel). |
| `core/economy-bar.ts` | Resource bar HUD (metal/energy income/storage). |
| `core/combat-fx.ts` | Explosion/impact VFX on combat events. |
| `core/perf-overlay.ts` | Frame-rate / draw-call overlay (toggleable, F11; `?perfprobe` adds Babylon SceneInstrumentation). |
| `core/frame-profiler.ts` | Permanent per-phase frame-time accumulator (camera/entity/fx/decals+lights/render/ui/total) with rolling-window mean/p50/p95/p99/max; zero hot-path allocation. Driven by the game-processor render loop (`beginFrame`/`gpMark`/`endFrame`); dump via `window.test.perfDump()` / `window.__gp('__frameProfiler.dump()')`. PLAN-perf P0 attribution instrumentation. |
| `core/widget-profiler.ts` | On-demand per-widget LuaUI cost profiler (PLAN-perf N1). Wraps every widget callin in the Fengari runtime with a `performance.now()` timing closure (same hook site as BAR's tracy zones — handler dispatch is dynamic `w:Callin(...)` lookup in both cawidgets and barwidgets), plus per-block timers inside the runFrame chunk and a JS-side fixed-tax split of `gpRunUiPass` (GL-state save / Fengari / restore / wipeCaches). `window.test.uiProfileStart()` / `uiProfileDump()` / `uiProfileStop()`. Off by default; ~3 ms/frame overhead while active. |
| `core/fx-bindings.ts` | PLAN-fx-offload X4: declarative per-def FX binding interpreter (uvScroll/pieceSpin/loopSound/emitter/onEvent) replacing per-frame entity `onUpdate` scripts with data (`client/units/<def>/bindings.json`) + a condition vocabulary (`evalWhen`: anim-state, health/velocity threshold, `pieceRotating:<piece>`). Engine-agnostic (no Babylon/Audio imports) so it's unit-testable without a renderer; sinks are injected. |
| `core/fx-bindings-sinks.ts` | Real `FxSinks` for `pieceSpin` (→ `EntityRenderer.setClipPose`) and `loopSound` (→ `AudioManager` loop control). `uvScroll`/`emitter` stay on `fx-bindings.ts`'s `createStubSinks()` (FIDELITY-STANDIN, warns once) until X2/X3 land. |
| `core/entity-fx-fence.ts` | PLAN-fx-offload X5: the compatibility-path fence for legacy per-frame entity FX scripts — LOD gate (faithful to PLAN-client-entity.md's distance tiers), per-frame budget cap (PLAN-scripting.md's 3-5ms combined Lua+JS budget), warn-once per def. Per-def cost/skip rows via `window.test.entityFxFenceDump()`/`entityFxFenceReset()`, same ranked convention as `uiProfileDump()`. Wired live into the game-processor render loop (`beginFrame()` every frame); no live caller of `run()` exists yet (no game ships per-frame entity-script content through a dispatch this engine drives) — ready for whichever module becomes that caller. |
| `core/def-cache.ts` | Accumulates incrementally streamed unit + weapon defs; notifies renderers. |
| `core/defs-fetch.ts` | HTTP fallback fetch of game/map defs (used during early load and recovery). |
| `core/entity-state.ts` | Parses Tier 2 binary snapshots (struct-of-arrays with field mask). |
| `core/entity-interpolator.ts` | Smooths entity positions between server ticks. |
| `core/projectile-state.ts` | Parses envelope `0x04` binary projectile snapshots. |
| `core/piece-state.ts` | Parses streamed piece transforms (turret rotation, walk cycles, etc.). |
| `core/clock.ts` | Sim-tick clock + interpolation timing. (`clock.test.ts` covers it.) |
| `core/presentation-clock.ts` | **PLAN-latency L0.** Turns the frame-stamped snapshot stream into a smooth presentation cursor `P = E − D` (E = estimated leading edge, D = auto-adapted display delay). Owns loss/reorder/jitter stats for the F10 timing overlay. (`presentation-clock.test.ts`.) |
| `core/event-scheduler.ts` | **PLAN-latency L1.** Presentation-timeline for discrete events (explosions, deaths, impact CEGs, sounds): a per-frame binary-heap keyed by sim frame. `game-processor` queues each server event on its stamped frame and `drain(P)`s it when the cursor arrives, so effects present in lockstep with the interpolated units instead of ~D frames early. `window(P,E)` peeks the future window for pre-roll. (`event-scheduler.test.ts`.) |
| `core/terrain.ts` | Builds terrain mesh from heightmap uint16 array. DXT1 tile atlas is paged into a MultiMaterial grid (`planAtlasPages`) when a map exceeds WebGL2 `MAX_TEXTURE_SIZE`. Carries the material plugins (decal overlay + `water-absorption-plugin.ts`, the Recoil SMF underwater terrain tint from mapinfo `water.absorb/baseColor/minColor`, parsed client-side by `map-lighting.ts`) across its material swaps. |
| `core/terrain-splat-plugin.ts` | Recoil's near-field terrain detail (`GetDetailTextureColor`, SMFFragProg.glsl) — one plugin, two mutually exclusive modes selected per map exactly as the shader's `#ifdef`/`#ifndef` does: `splat` (`splatDetailTex` × `splatDistrTex`, per-channel `texScales`/`texMults`) and `plain` (a single `detailTex` tiled at the fixed `SMF_DETAILTEX_RES` 0.02). Both add *signed* (`tex*2-1`) detail to `baseColor` before the light loop, so mid-grey contributes nothing and **the mip chain is the distance falloff** — there is no fade uniform, which is why `MapProcessor` must convert every decal texture with `--mipmaps`. Attach precedence lives in `game-processor.ts` (splat pair first, else plain); `terrain.ts`'s reattach carries the mode across material swaps. A/B hook: `window.__gp('__perfToggles.terrainDetail(false)')`. |
| `core/terrain-texture.ts` | Streams the KTX2 terrain texture(s) and binds them onto the terrain mesh. |
| `core/rts-camera.ts` | Orbital pan/zoom/rotate camera with viewport updates. **GW4-c5b**: now DOM-free and runs **inside** the game-processor worker (one per view, keyed by viewId); input arrives via intent methods, not DOM events. |
| `core/camera-input.ts` | **GW4-c5b**: thin main-thread DOM-input owner. Captures pointer/wheel/key on `#game-canvas` and forwards canvas-relative CSS-pixel intents to the worker camera as `gp:*` messages tagged with `viewId` (multi-view). |
| `core/input-manager.ts` | Click-to-select (ray cast), right-click-to-command, drag-box select, keyboard shortcuts. **GW4**: the *full-feature* main-thread input manager (build placement, waypoint/area-attack drag, modal hotkeys, animated cursors). Its **selection/pick/order core** was ported DOM-free into the worker as `worker-selection.ts` (c5b-2); the rich placement/modal features still await a worker port. |
| `core/worker-selection.ts` | **GW4-c5b-2**: DOM-free selection / pick / order core in the game-processor worker. Left-button single-click + drag-box select (screen-space projection of entity positions), right-click move/attack/guard (team-aware), hover tracking. Sends orders over the worker's own WebTransport connection (no main hop); posts the drag-box rectangle to main (`gp:dragBox`) for the overlay div. Per-view picking via `getCamera(viewId)`; selection set shared. |
| `core/selection-core.ts` | **WP3a**: shared selection/pick/order constants (`SELECT_PIXEL_RADIUS`, `SELECT_RADIUS`, `DRAG_THRESHOLD_PX`) — single source of truth imported by both `input-manager.ts` (legacy main-thread) and `worker-selection.ts`. |
| `core/engine-gl.ts` | **WP5.2**: `getEngineGl(engine)` — the single upgrade point for reaching Babylon's internal `_gl` WebGL2 context. Used by `terrain.ts` and `game-processor.ts` (`gpBootLuaUI`). If a Babylon upgrade breaks `_gl`, fix it here only. |
| `core/minimap.ts` | Minimap canvas with entity dots, click-to-pan, detachable popup window. **GW4-c5c-3**: `entityRenderer` is now optional — in the game-processor split the minimap runs on main (own Babylon Engine) but the entity set lives in the worker, so it renders from the `gp:minimapFeed` blips via `applyFeed` (the in-process path, e.g. the detached viewport, is unchanged). Click-to-pan posts `gp:focusWorld` → worker camera. |
| `core/audio.ts` | `AudioManager`: 96-voice HRTF pool, five Recoil-parity channel buses (General / Battle / UnitReply / UserInterface / BGMusic) with strict-greater-priority per-channel eviction, master `ConvolverNode` for map reverb, dual-HTMLAudioElement music crossfader, SoundItem ingest + resolution, persisted channel/master volume. `playLoop`/`updateLoopPosition`/`stopLoop` (PLAN-fx-offload X4): a key-addressable looping voice on top of the same pool/eviction rules, for `fx-bindings.ts`'s `loopSound` binding. |
| `core/sound-events.ts` | `SoundEventPlayer`: resolves server `SoundEvent` → `SoundRef.name` → SoundItem → URL chain, applies per-play gain/pitch random offsets, routes to AudioManager on the channel the server tagged. |
| `core/music-director.ts` | Subscribes to `MusicEvent`s, picks a random track from the per-state playlist (built from `music_<state>_<n>` SoundItems), crossfades via AudioManager. Gates start on a single `arm()` call from main.ts. |
| `core/synth-sounds.ts` | Procedural fallback for combat-fx when no real asset is reachable. |
| `core/map-data.ts` | Parses MapData FlatBuffer into `ParsedMapData` (heightmap, features, tiles, URLs). |
| `core/lua-runtime.ts` + `core/fengari.d.ts` | Shared Fengari Lua 5.1 runtime. Type definitions. |
| `core/lua-spring-api.ts` | Client-side `Spring.*` API surface (read-only sim queries, draw helpers). |
| `core/lua-gl-bridge.ts` + `lua-gl-immediate.ts` + `lua-gl-font.ts` | Lua `gl.*` bridge: command buffer, immediate-mode primitives, font/text rendering. |
| `core/lua-widget.ts` | Lua widget definition + lifecycle wrapper. |
| `core/lua-widget-host.ts` | Fengari host for map-side widgets (lava, water shaders). |
| `core/lua-widget-worker.ts` | **Worker entry point** (must stay at this path — `main.ts` and `lua-widget-manager.ts` both `?worker`-import it by name). After WP2c this file is thin: imports from `game-processor.ts` + `lua-ui-host.ts` + `gp-context.ts` and the typed `self.onmessage` dispatcher. All logic lives in the sub-modules. |
| `core/game-processor.ts` | **GP half** (WP2c). All `gp*` state + functions: Babylon `Engine`/`Scene`, interactive `RTSCamera`, `EntityRenderer`, `DefCache`, `PresentationClock`, `EventScheduler` (L1 discrete-event timeline), FX renderers (projectile, CEG, CombatFX, build-beam, decal, feature), `Connection`, order overlays, `gpInit`/`gpConnect`/`gpLoadMap`/`gpShutdown`, scene-state + minimap feed, LuaUI `gpRunUiPass`/`gpBootLuaUI`, input-dispatch helpers, GW8 test harness. Imports from `lua-ui-host.ts` (one-way). |
| `core/lua-ui-host.ts` | **LuaUI half** (WP2b). All Fengari runtime state: `liveState`, `unitDefMap`/`weaponDefMap`, `init()`/`runFrame()`/`shutdown()`, `install*` helpers, all `dispatch*` callins, `applyEntityStateToLiveState`/`removeUnitFromLiveState`, Lua source constants (`LUA_COMPAT_SHIM`, `CMD_GLOBALS_LUA`, `GADGET_HANDLER_LUA`…), and (WP2c) `handle*` delegation helpers (`handleStateUpdate`, `handleRosterUpdate`, `handleRulesParamUpdate`, `handleSendToUnsynced`, `handleIntelTransitions`, `handleStandingOrders`, `handleUnitCommandQueues`). |
| `core/gp-context.ts` | **Shared seam refs** (WP2b). Single `gpCtx` object holding `connection`, `selection`, `entityRenderer`, `fxLightPool`, `projectileRenderer`, `sceneLighting`, `mapLighting`, `uiGl`, `luaUiActive`. Imported by both halves; written by GP, read by LuaUI. No value imports beyond `defaultMapLighting()`. |
| `core/worker-vfs.ts` | **VFS layer** (WP2a). `vfsFiles`/`vfsPathMap`/`vfsDirCache`/`vfsSubdirCache` Maps, `vfsRegister`/`vfsLookup`/`vfsExists`/`prefetchAllGameFiles`, `resetVfs()`, `VFS_IMPLEMENTATION_LUA` constant. |
| `core/lua-widget-manager.ts` | Main-thread owner of the worker: lifecycle, message routing, input forwarding, VFS proxy. |
| `core/widget-manager.ts` | Higher-level widget orchestration (load order, enable/disable, debug toggles). |
| `core/command-buffer.ts` | Serialised `gl.*` command buffer transferred from worker to main-thread renderer. |
| `core/script-api.ts` | JavaScript scripting API surface (alongside Lua). |
| `core/log-ingest.ts` | Forwards client logs to the log server. |
| `core/renderer-backend.ts` | Backend abstraction (currently WebGL via Babylon.js; placeholder for future WebGPU). |
| `core/debug-console.ts` | Debug console: log viewer, scope-aware command input, log server WS, Babylon.js inspector toggle. |
| `core/test-harness.ts` | `window.test` runtime API: spawn/kill/damage/order verbs through `/api/exec`, camera focus on a unit, render-loop pause, screenshot capture, debug-flag toggles. Paired with `.claude/skills/spring-test`. **GW8**: split for the worker — server-bound verbs run on main over HTTP; client-bound (camera/selection/netSim/pause/screenshot) forward to the worker via `workerCall()` (`gp:test`/`gp:testResult`); `selection`/`cameraPose` read the cached `gp:sceneState` feed synchronously. `window.widgets.eval` (Lua) + `window.__gp` (JS into the worker global scope, for `__entityRenderer`/`__fxLightPool`/`__frameProfiler`/`__perfToggles`/… debug hooks) are re-exposed in `main.ts`. **P0**: `perfDump()`/`perfReset()` (per-phase frame-time distribution) + the `__perfToggles` isolation handles (`terrainPlugin`/`decalFade`/`lightPool`/`renderScale`/`luaUi`). **N1**: `uiProfileStart()`/`uiProfileDump()`/`uiProfileStop()` (per-widget LuaUI cost profile — `core/widget-profiler.ts`). **PLAN-fx-offload X5**: `entityFxFenceDump()`/`entityFxFenceReset()` (per-def legacy entity-FX script cost — `core/entity-fx-fence.ts`). The spring-debug MCP browser tools (`browser_test`/`spawn_at_camera`/`evaluate_widget_lua`) all route through these. |
| `core/net-inspector.ts` | Network message inspector: decodes the envelope byte + FlatBuffer payload type for the debug console, and keeps an always-on per-envelope bandwidth tally (feeds PLAN-performance PC-2). **GW8**: runs **inside the game-processor worker** (the connection lives there) — `recordInbound` at `connection.routeIncoming`, `recordOutbound` at `sendOnControl`; surfaced to main via `window.test.netStats()`. Worker-safe: the per-frame debug-console log goes through a registered sink (`setNetLogSink`, set by debug-console on main) instead of importing the DOM-constructing console singleton. |
| `lobby/lobby-ui.ts` | Full lobby UI: login, room browser, room setup, AI slots, start positions. |
| `ui/ui.ts` | Shared helpers: `injectStyle()`, `renderTemplate()`. |
| `ui/game/loader.ts` | In-game template loader: `GameTemplates` interface, bundled defaults, `loadGameTemplates()` fetcher. |
| `ui/lobby/loader.ts` | Lobby template loader: `LobbyTemplates` interface, bundled defaults, `loadGameLobbyTemplates()` fetcher. |
| `ui/hud/hud.html+css` | In-game HUD (entity count, selection, quit button). Owns the `.hud-*` class prefix — **not** the native-UI design system, which is `.nui-*` (see below). |
| `ui/quit-confirm/` | Quit confirmation overlay. |
| `ui/game-over/` | Game over results overlay. |
| `ui/native-ui/ui-store.ts` | Native-UI state store (PLAN-native-ui.md §2): mirrors of game/team rulesParams, roster, selection, economy, queues; `subscribe(paths, cb)`. Creates the `#ui-root` overlay (`pointer-events: none`, z-index 100). |
| `ui/native-ui/widget-loader.ts` | Loads a game's `<game>.ui.json` manifest, imports its `widgets/*.js`, and **owns all HUD chrome**: injects the design system + the game's `styles[]`, creates the dock mounts, and builds the collapsible panel frame around every `title`d widget (`ctx.mount` is the panel *body*, and its header is a real `<button>` with `aria-expanded` so collapsed panels are keyboard-reachable). Collapse state is sticky per game via `clientSettings` (`hud.collapsed.<game>.<widget>`), so it also reads/writes through `Spring.Get/SetConfigInt`. |
| `ui/native-ui/native-ui.css` | **The native-UI design system** — `--nui-*` tokens, dock/rail geometry (`.ui-mount-*`), panel chrome (`.nui-panel__head/__body/__badge`, `.is-collapsed`), and control primitives (`.nui-btn/-field/-row/-list/-table/-meter/-badge/-chip/-menu/-toast`). Injected once by the widget-loader. |
| `ui/native-ui/compile-table.ts`, `named-entity-index.ts` | Command-intent → wire-payload compiler and the searchable region/objective/landmark index behind the composer's target slot. |
| `native-widgets/command-composer.{js,css}` | Engine-bundled widget (mounted via the loader's `BUILTIN_WIDGETS` because it statically imports the two modules above). Compact bottom-centre command bar: slot chips → live echo → `compileIntent` → `ctx.sendCommand`. |

#### Client porting gotchas (hard-won — check before writing new client code)

- **Dead-producer trap (post-GW4, recurring):** the old main-thread `stateUpdate` path is DEAD — every `liveState` field a widget reads needs its own **worker-side producer**. This class of bug has recurred at least four times (camera pose/`viewMatrix` → `gpSyncCameraToLiveState` U1; `onResourceUpdate` → team resources U3; `onUnitCmdDescs`/`sendSelectionState` G3a; `minimapGeometry`/`minimapEvents` G4). When a widget sees stale/zero data that "used to work", suspect a main-thread producer that no longer feeds the worker before suspecting the widget. Similarly, the worker roster is **seeded once at init** (players via `gp:init`, teams via `TeamStartInfo`) — the `setRoster` path is dead; empty-roster crashes are fixed at the seed, not the widget.
- **Two UI class namespaces, don't cross them:** the engine HUD overlay (`ui/hud/hud.css`) owns `.hud-*` (`#game-hud .hud-panel` etc.); the native-UI design system (`ui/native-ui/native-ui.css`) owns `.nui-*`. They style unrelated elements with equal specificity, so reusing `.hud-panel` for a native panel silently restyles the minimap/selection/help chrome (and vice versa). The design system's bare-element control rules are wrapped in `:where(#ui-root)` so they contribute **zero specificity** — widgets get styled inputs without a class, and a plain class rule in a game stylesheet still overrides them. Keep it that way; an unwrapped `#ui-root` prefix forces every future exception back into the engine sheet as an escape-hatch class.
- **A `transform` on an overlay container breaks `position: fixed` inside it.** A transformed element becomes the containing block for fixed-position *descendants*, so a widget popover positioned in viewport coordinates lands relative to the container instead — off-screen, with no error. This is why the centred `.ui-mount-*` docks centre with flexbox (`left: 0; right: 0; align-items: center`) rather than `left: 50%; transform: translateX(-50%)`. Applies to any overlay that hosts menus/tooltips.
- **Panel chrome clips.** `.nui-panel` is `overflow: hidden` and `.nui-panel__body` is `overflow-y: auto`, so anything a widget draws outside its own box (dropdowns, toasts) is clipped unless it escapes: `position: fixed` + JS-set coordinates for menus (see `command-composer.js openMenu()`), or an `overflow: visible` opt-out on the panel for toasts (see `.ms-authority-bar`).
- **A rulesParam number is float32; format it before it reaches the DOM.** Sim values cross the wire as float32, so an honest `114.55` arrives as `114.55000305175781` and a bare `String(v)` puts 18 significant figures on screen (PLAN-endtoend.md D49: the authority bar, the objectives panel, the scoreboard, the award toast). Metalstorm's authority amounts have one spelling — `data/games/metalstorm/ui/lib/authority-format.js` `formatAuthority()`, one decimal with a trailing `.0` stripped — and every widget that displays one calls it, so two panels cannot disagree about the same number. Format by class of **value**, not class of widget: a generic "last change" feed carries strings as often as numbers. Where a derived quantity is *computed* client-side (the composer's shortfall = cost − pools), quantize at the source instead of at each display, and mind the direction — a shortfall rounds **up**, because it is shown as what the player still needs.
- **Babylon is right-handed — porting Recoil math:** form a third basis axis as `right × up` (RH). `RotationQuaternionFromAxisToRef` collapses to a reflection if handed an LH basis.
- **`ShaderMaterial` alpha:** `alphaMode` is IGNORED unless `needAlphaBlending: true` is passed in the constructor options — without it, transparent materials draw opaque black.
- **`StandardMaterial.emissiveTexture` is ADDITIVE, not multiplicative:** the compiled stage is `vec3 emissiveColor = vEmissiveColor; emissiveColor += texture(emissiveSampler, uv).rgb * vEmissiveInfos.y;`. So `emissiveColor = (1,1,1)` is **not** a neutral multiplicand — it saturates the output white whatever the texture holds, and a texture whose RGB is 0 contributes nothing at all. This painted the whole minimap white for the life of the fog overlay (PLAN-endtoend D48, minimap half): the LOS bitmap was a correct all-black RGB + per-texel alpha, bound as *both* `emissiveTexture` and `opacityTexture` with a white `emissiveColor` to "multiply" it. Measured live: an all-0 RGB, an all-255 RGB and a pure-red bitmap all rendered 255. For a tint-only overlay set every colour input to black and let the bitmap in through `opacityTexture` alone. **PBRMaterial's emissive is multiplicative — the two do not agree, so don't carry an idiom across.**
- **…and in the SAME reduction, the emissive term is MULTIPLIED by the diffuse base:** `vec3 finalDiffuse = clamp(diffuseBase*diffuseColor + emissiveColor + vAmbientColor, 0.0, 1.0) * baseColor.rgb;`. So the natural "unlit textured quad" idiom — bind one texture as *both* `diffuseTexture` and `emissiveTexture`, `disableLighting = true` — renders **texel², not texel**. It cost the minimap backdrop a 2.6× darkening for the life of the file (PLAN-maps M8e: 26.76 mean luminance against an asset that decodes to 69.94). **x² is close enough in shape to an sRGB decode (x^2.2) that it was written up twice as a missing gamma encode** — check the material's own reduction before blaming a colour space. Correct idiom: bind the texture **once** as `diffuseTexture` with `emissiveColor = (1,1,1)`, or once as `emissiveTexture` with no diffuse texture (then `baseColor` is (1,1,1)). That second form is why every solid-colour material in the minimap scene renders its authored `emissiveColor` literally.
- **The minimap is the only rendered surface outside the worker**, with its own `Engine` + `Scene` + main-thread canvas (`core/minimap.ts`). Consequences that have each cost a session: neither `window.test.screenshot()` (reads the worker's OffscreenCanvas) nor CDP `take_screenshot` (cannot read a WebGL2 canvas) can see it — use `window.test.minimapScreenshot()` / `minimapStats()`, which render and read back in **one synchronous block** because the engine is `preserveDrawingBuffer: false` (a `toDataURL` from a later event-loop turn returns alpha-0 everywhere, which reads exactly like a canvas that was never drawn to). Its scene also has **no post-process chain**, where the main scene's ends in `imageProcessing` — so anything the main scene gets from that chain (tone mapping, bloom, FXAA), the minimap does not. **That difference is not a brightness/colour-space one, and reading it as one cost a fire:** with `applyByPostProcess` false and every image-processing knob neutral, Babylon compiles `IMAGEPROCESSING` **off**, and the shader then does no space conversion in either direction — measured, a solid `emissiveColor` of 0.5 renders as exactly 128 in the minimap scene. Adding an `imageProcessing` pass there would not have been neutral: it would shift every authored blip/ping/metal-spot RGB literal.
- **GLSL-in-template-literal comment rules:** no backticks in `//` comments (closes the JS template literal → Vite PARSE_ERROR) and no semicolons in `//` comments in raw `ShaderMaterial` source (splits the GLSL → material silently draws nothing).
- **Lua bridge array marshalling:** a plain JS array returned to Lua spreads as N return values, NOT a table — `ipairs()` on the "return" sees nil. Wrap in `luaTable()` **even when the array is empty** (an empty array marshals as zero return values). Known still-unwrapped: `ordersToLuaArray` (`GetUnitCommands`/`GetFactoryCommands`/`GetCommandQueue`) — see PLAN-bar.md.
- **Model radius is midpos-relative:** `(maxs − midpos).Length()` (AABB half-diagonal, Recoil-faithful) — origin-relative over-estimates tall models.
- **glTF clips autoplay and poison the captured rest pose (units with animations):** Babylon's glTF loader **plays the first animation group the instant a model parses**. `EntityRenderer.ensureModelLoaded` captures each piece's `restWorldMatrix` from `node.getWorldMatrix()` immediately after `ImportMeshAsync`, so any piece the first clip animates (e.g. a walker's legs under a `walk` clip) is captured **mid-animation** → garbage thin-instance bounding boxes (world Y in the thousands) and those pieces don't render, while un-animated pieces (torso) are fine. Presents as "few pieces / extra foot / view-dependent" (the corrupt bounds also throw off orbit-rig framing). Models with **no** clips never trip it — which is why a legless or clip-stripped model "fixes" it and misleads the search toward geometry/textures. Fix (in place): an always-on `SceneLoader.OnPluginActivatedObservable` hook sets the glTF loader's `animationStartMode = NONE` (0) so nothing autoplays; the groups are still parsed and handed to `extractClips` for the "Play clip" path. **Never assume `node.getWorldMatrix()` is the bind pose while animation groups exist.**
- **Debugging worker model loads:** the render scene lives in the game-processor worker (OffscreenCanvas), so Babylon's DOM Inspector can't reach it. Use the worker-safe hooks: `window.__gp('globalThis.__MODEL_DEBUG = true')` before spawning enables per-load parse logging + the bundled Khronos glTF-Validator; `window.__gp('__entityRenderer.dumpGeometry("<defName>")')` lists every piece's vert count + local AABB; a stall watchdog logs if `ImportMeshAsync` hangs (usually a stuck KTX2 transcode). To read a piece's *actual* rendered world position/bounds, query the render mesh `unit_<defId>_t<team>_p<i>_<name>`: `thinInstanceGetWorldMatrices()[0]` (correct transform) vs `getBoundingInfo().boundingBox.*World` (the value culling/CSM/framing use — the one that goes garbage above).
- **"Model doesn't render in the model-viewer scenario" is usually the connection, not the model.** The worker's WebTransport game connection comes up asynchronously after `startGame`; a spawn before it authenticates loses the first viewport update and the entity never streams — which used to surface as a bogus `model-load-timeout`. Check `window.test.gameConnected()` (`{authenticated, authFailed, receivedState}`) first. The scenario runner now **gates setup on the connection being authenticated** (`waitForGameConnection`), and the model-viewer retries the viewport focus + reports the *real* cause (`diagnoseNoStream`) — including auth failures like a **stale game server on `:9100` from a prior run rejecting the new room's token** (kill leftover `spring-server` between runs). A manual **Respawn** click works around a lost initial stream because by then the connection is live.
- **Model glTF authoring gotchas** (native forge / `tools/fable-model-forge`): accessor `min`/`max` must be the **exact float32 vertex extremes**, not rounded — rounding narrows the declared range *inside* the real data and the Khronos validator flags every out-of-range element (742 on one colossus). The `image/ktx2` mime-type + KHR_texture_basisu + custom `SPRINGRTS_*` extension warnings from Babylon's bundled validator are **benign** (its validator predates KTX2). A normal map without a `TANGENT` attribute warns about non-portable tangents but renders fine here (derivative-based TBN). Unit `.ktx2` textures load via the glTF's own `images[].uri` — **not** through any `bitmaps/`/`models/` `manifest.json` (those only gate `.config.lua` sidecar probes).

### Protocol (`schemas/protocol.fbs`)

**Wire format:** Every binary frame (over WebTransport — PLAN-game-worker.md) starts with `u8 envelope`:
- `0x01` = FlatBuffers (root: ServerMessage or ClientMessage)
- `0x02` = Entity state full snapshot (custom binary)
- `0x03` = Entity state delta (custom binary)
- `0x04` = Projectile state snapshot (custom binary)

**Two player ids, never interchangeable.** `AuthResponse.player_id` is the **DB account id** (stable across games); `AuthResponse.player_num` is Spring's **sim playerNum** (allocated per game server, in connect order, with AI virtual players taking the low numbers). Everything synced keys on `player_num`: rulesParam keys like `authority_player_<id>`, `gadget:PlayerAdded(playerID)`, `Spring.GetPlayerList()`, `UnitCommandEvent.player_id`, `LuaUIMsgRelay.player_id`. The client carries them as `Connection.accountId` / `Connection.playerNum` and hands widgets both as `ctx.identity.accountId` / `ctx.identity.playerId` (the latter being the playerNum). They coincide only by accident on low-id dev accounts — which is why using one for the other went unnoticed for so long; see PLAN-native-ui.md §3.3 and PLAN-endtoend.md D3. **Verify player-scoped behaviour with a fresh, high-id account.**

**A playerNum belongs to an account, not to a connection.** An authenticating username that already has a `CPlayer` reuses that row and that number (`CPlayerHandler::HumanPlayer`); only a first-time account consumes `nextPlayerNum`. So a tab reload resumes the player's score, authority pool, standing orders and org groups instead of orphaning them — everything synced keys on `player_num`, which would otherwise change under the player. `playerHandler.players` is capacity-pinned to `MAX_PLAYERS` (251) and **nothing ever erases from it** (a disconnect only sets `active = false`), so appending per authentication was a hard ceiling reached in reconnects; the reuse makes it a ceiling on *distinct accounts* instead, and that ceiling is still unenforced. A re-auth also releases the previous connection's `clientPlayerNum` mapping, because the old transport is usually not reaped yet. AI virtual players are excluded from the reuse by `isAI`. Replay re-execution derives the number through the same rule, so a recorded reconnect replays as one.

**Key server→client messages:** AuthResponse, PlayerRoster (complete player roster — humans, spectators and AI virtual players, with names, teams and ally teams; sent reliably on auth and re-broadcast in full on every change: join, reconnect, leave, and once after GameStart when ally teams become known. Never a delta. The only source of player *names* on the client — the lobby room roster is not a substitute, it keys by account id and has no AI entries), MapData, GameUnitDefs, GameWeaponDefs, EntityCreate, EntityDestroy, GameEventBatch (CombatEvents, projectile fired/impacts/trajectories, SoundEvents, SeismicPings, MusicEvents), GameInfo, TeamStartInfo (team start positions + ally start boxes; sent on auth + re-broadcast after GameStart → Spring.GetTeamStartPosition/GetAllyTeamStartBox), PlayerTeamEventBatch (reliable per-tick player/team status changes → widget:PlayerChanged/PlayerAdded/PlayerRemoved/TeamDied; pushed from CTeam::Died + CPlayer::StartSpectating/JoinTeam + the disconnect handler), LuaUIMsgRelay (relayed Spring.SendLuaUIMsg → widget:RecvLuaMsg(msg, playerID); server applies the per-receiver audience filter by mode 0=all/'a'=allies/'s'=specs, faithful to Recoil CLuaHandle::HandleLuaMsg; sender gets its own message back), TeamStatsHistoryBatch (reliable per-game-second incremental team stats-history deltas from CTeam::statHistory → Spring.GetTeamStatsHistory; per-team finalised-entry cursor resends the live tail each cadence and rewinds on client join so late joiners get full history), GameModOptions (reliable one-shot on auth — the game's modoptions from CGameSetup::GetModOptions() → worker liveState.modOptions → unsynced Spring.GetModOptions(); values stay strings, faithful to Recoil PushAllOptions; immutable per game server so no re-broadcast), RoomStateUpdate, RoomListUpdate, LogBatch, ConsoleResponse, GameStarted, UnitCommandQueuesUpdate (own + allied team order queues, ~1 Hz), UnitCmdDescsUpdate (selection-scoped command panel data — name/action/texture/tooltip/type/params/hidden per cmd, ~1 Hz).

**Key client→server messages:** AuthRequest, PlayerCommand, PlayerCommandBatch (schema only, no emitter yet — for atomic build-row / INSERT+REMOVE pairs), SelectionState (debounced 50ms; scopes server's cmd-desc broadcast), ViewportUpdate, RoomCreate/Join/Leave/Ready/StartGame/EndGame, RoomAddAI/RemoveAI, LuaRulesMsg, LuaUIMsg (Spring.SendLuaUIMsg, data + mode), LogIngest, LogSubscribe, LogUnsubscribe, ConsoleCommand.

**Order plumbing (PLAN-orders.md):** Selection mirroring is one of two budget controls — `SelectionState` scopes the per-tick `UnitCmdDescsUpdate` to the player's current selection rather than every own-team unit, and the same set will eventually scope future selection-only streams. `UnitCmdDesc` carries the full Spring `SCommandDescription` surface so ZK's integral menu and `cmd_*.lua` widgets see real button names, icons, tooltips, and current-state-index params. `PlayerCommandBatch` exists in the schema for atomic multi-command sequences (waypoint drag, build-row drag) — neither client emitter nor server handler is wired yet.

**IPC:** Pipe-based IPC removed. The lobby↔game backchannel (e.g. GameStarted) is **not yet implemented** — `Simulation.cpp` carries a `TODO(Tier 2)` for it; when built it targets WebTransport (PLAN-game-worker.md), not WebSocket/WebRTC.

**Transport:** All HTTP endpoints support both HTTP/2 (h2c, cleartext) and HTTP/1.1. Game state streaming runs over **WebTransport (QUIC/HTTP-3)** via `WebTransportServer` (PLAN-game-worker.md, PLAN.md Stage 0). The client discovers the endpoint via `GET /api/wt/info`. WebRTC is **fully removed** (GW7): `WebRTCServer.{h,cpp}`, libdatachannel, and the `/api/rtc/*` signaling are gone; `libspringapi` no longer links libdatachannel (`connectRtc` is an inert stub pending a WebTransport port). The migration relocated the connection + 3D render core + LuaUI into the **game-processor worker** (GW4: c1–c4 + c5a + c5b camera/selection/orders/overlays + c5c sceneState→HUD/audio/minimap/gfx + c6 in-worker LuaUI screen + world passes incl. bound custom shaders). **✅ Stage 0 COMPLETE (GW1–GW8):** GW5 bridges folded into c5; GW6 caching (build stamp into the worker; assets stay on HTTP, zero asset bytes over WebTransport); GW8 tooling re-plumb (`window.test`/`window.widgets`/`window.__gp` + net-inspector + spring-debug MCP across the worker boundary). The game runs entirely over WebTransport with network + render + LuaUI in one worker; the main thread has no game render loop. Rigorous perf profiling is sequenced at the PLAN-performance PC checkpoints.

Generated bindings:
- C++: `rts/protocol_generated.h`
- TypeScript: `client/src/protocol/spring-web/*.ts`

**⚠ There are TWO copies of `protocol_generated.h` and the include order picks
between them per translation unit.** CMake regenerates into
`build/<preset>/generated/`, but `rts/protocol_generated.h` is *also* tracked in
git, and `-I rts` precedes `-I build/<preset>/generated` — so after a
`schemas/protocol.fbs` change some files see the new header and some see the
stale committed one. It surfaces as `no member named 'add_<your_new_field>'` in
a *subset* of targets while others link clean (spring-lobby built, spring-server
did not). After editing the schema, refresh the tracked copy —
`cp build/debug/generated/protocol_generated.h rts/protocol_generated.h` — and
commit it with the schema. `make generate-protocol` only emits the TypeScript
side and does not do this.

### Lua Scripting System

The Lua scripting system is the primary extension point for game logic. Game authors write Lua gadgets that run inside the server's simulation loop and respond to engine events. **All gameplay behavior** — win conditions, unit spawning, player-leave handling, resource rules, etc. — should be defined in Lua, not hardcoded in C++.

#### Architecture Overview

```
C++ Engine Subsystems (units taking damage, dying, moving, etc.)
        │
        ▼
CEventHandler  ─────────────────────────────►  CLuaHandle (direct, legacy)
        │
        ▼
ScriptEventDispatcher (CEventClient)
        │  converts C++ pointer-based events → entity-ID ScriptEvent structs
        ▼
IScriptContext instances (priority-ordered)
        │
        ├── LuaScriptContext (adapter) ──► CLuaHandle ──► LuaRules gadgets
        └── LuaScriptContext (adapter) ──► CLuaHandle ──► LuaGaia gadgets
```

**Dual dispatch (transitional):** CLuaHandle still registers directly with CEventHandler in addition to receiving events through the ScriptEventDispatcher. This means Lua gadgets receive most events via the direct path. The ScriptEventDispatcher bridges a subset of events (see below). Over time, all events should route exclusively through the dispatcher so non-Lua contexts (future JS, AI thread pool) receive them too.

#### Key Files

| File | Purpose |
|------|---------|
| `rts/System/Scripting/ScriptEventDispatcher.h/.cpp` | CEventClient that bridges C++ events → ScriptEvent → IScriptContext instances |
| `rts/System/Scripting/ScriptEvent.h` | Typed event payloads with entity IDs (not pointers). ~60 event types defined in `ScriptEventType` namespace |
| `rts/System/Scripting/IScriptContext.h` | Language-agnostic interface. `HandleEvent()` for notifications, `HandleControlEvent()` for events that can block/modify sim state |
| `rts/System/Scripting/ScriptPermissions.h` | Per-context permission model (synced, fullCtrl, fullRead, team access) |
| `rts/Lua/LuaScriptContext.h/.cpp` | Adapter: wraps CLuaHandle as an IScriptContext. Converts ScriptEvent entity IDs back to C++ pointers for CLuaHandle methods |
| `rts/Lua/LuaHandle.h/.cpp` | Base class for all Lua contexts. `HasCallIn(L, name)` checks if a Lua function exists; `RunCallIn()` executes it |
| `rts/Lua/LuaHandleSynced.h` | Split synced/unsynced Lua states. CSyncedLuaHandle for sim-affecting code |
| `rts/Lua/LuaRules.h/.cpp` | Game-wide gadget system. Loads `LuaRules/main.lua` (synced) and `LuaRules/draw.lua` (unsynced). Full access permissions |
| `rts/Lua/LuaGaia.h/.cpp` | Map/environment gadgets. Same structure as LuaRules but for map-specific logic |
| `rts/Lua/LuaSyncedCtrl.cpp` | C++ functions exposed to Lua as `Spring.*` — the synced API (150+ functions) |
| `rts/Lua/LuaSyncedRead.cpp` | Read-only Lua API for querying game state (`Spring.GetUnitHealth()`, etc.) |
| `rts/System/EventHandler.h/.cpp` | Engine event dispatcher. All CEventClient instances register here |

#### Initialization Sequence

In `CSimulation::InitScripting()` (called from `Simulation::Init()`):

1. Create `ScriptEventDispatcher` singleton, register with `eventHandler`
2. `CLuaRules::LoadHandler(true)` — loads `LuaRules/main.lua` from game content root
3. Wrap in `LuaScriptContext`, add to dispatcher
4. `CLuaGaia::LoadHandler(true)` — loads `LuaGaia/main.lua` from map content root
5. Wrap in `LuaScriptContext`, add to dispatcher

GameStart does **not** fire during Init. It fires later via `CSimulation::FireGameStart()`, called by `server_main.cpp` once all `--player` roster entries have authenticated. This ensures CPlayers are registered in `playerHandler` before gadgets query them (e.g. `start_unit_setup.lua` uses `GetPlayerList()` to spawn commanders).

LuaRules looks for `LuaRules/main.lua` in the game's content root (e.g. `content/games/papertanks/LuaRules/main.lua`). LuaGaia looks in the map's content root. Engine-level base content is at `cont/base/springcontent/`.

#### Event Types

**Notification events** (engine → Lua, no return value):

| Category | Events |
|----------|--------|
| Game lifecycle | `GamePreload`, `GameStart`, `GameOver`, `GameFrame` |
| Team/Player | `TeamDied`, `TeamChanged`, `PlayerChanged`, `PlayerAdded`, `PlayerRemoved` |
| Unit lifecycle | `UnitCreated`, `UnitFinished`, `UnitFromFactory`, `UnitDestroyed`, `UnitTaken`, `UnitGiven` |
| Unit state | `UnitIdle`, `UnitCommand`, `UnitCmdDone`, `UnitDamaged`, `UnitStunned`, `UnitExperience`, `UnitMoved`, `UnitMoveFailed` |
| Unit visibility | `UnitEnteredRadar`, `UnitEnteredLos`, `UnitLeftRadar`, `UnitLeftLos`, `UnitSeismicPing` |
| Unit physics | `UnitEnteredWater`, `UnitEnteredAir`, `UnitLeftWater`, `UnitLeftAir`, `UnitLoaded`, `UnitUnloaded` |
| Unit stealth | `UnitCloaked`, `UnitDecloaked` |
| Features | `FeatureCreated`, `FeatureDestroyed`, `FeatureDamaged`, `FeatureMoved` |
| Projectiles | `ProjectileCreated`, `ProjectileDestroyed` |
| Misc | `StockpileChanged`, `Explosion` |

**Control events** (engine → Lua, return value alters sim behavior):

| Event | Effect |
|-------|--------|
| `AllowCommand` | Return `false` to veto a player command |
| `AllowUnitCreation` | Return `false` to prevent unit construction |
| `AllowUnitTransfer` | Return `false` to prevent unit transfer between teams |
| `AllowUnitBuildStep` | Return `false` to block a build step |
| `CommandFallback` | Handle custom command types |
| `UnitPreDamaged` | Modify damage amount before application |

#### ScriptEvent Dispatch Bridge Status

Events currently bridged through `LuaScriptContext::HandleEvent()` (ScriptEventDispatcher → CLuaHandle):

- `GameFrame`, `GameStart`, `GamePreload`, `GameOver`
- `UnitCreated`, `UnitFinished`, `UnitDestroyed`, `UnitIdle`, `UnitDamaged`, `UnitMoved`
- `TeamDied`, `PlayerChanged`, `PlayerAdded`, `PlayerRemoved` (⚠ the three
  player events are `UNSYNCED_BIT`, so this bridge reaches *unsynced* handles
  only — synced gadgets are served by `Server/PlayerOnboarding.h`'s explicit
  delivery instead; see the persistent-war section below)

Events **not yet bridged** (Lua still receives these via CLuaHandle's direct CEventHandler registration):

- `UnitFromFactory`, `UnitTaken`, `UnitGiven`, `UnitCommand`, `UnitCmdDone`
- `UnitStunned`, `UnitExperience`, `UnitMoveFailed`, `UnitSeismicPing`
- All visibility events (`UnitEnteredRadar`, etc.)
- All feature/projectile events (though the dispatcher has C++ overrides, the context switch skips them)
- Most control events (only `Explosion` is bridged; `AllowCommand` dispatcher override exists but isn't bridged at context level)

This means these events work for Lua but would NOT reach a future non-Lua IScriptContext.

#### Lua API (Spring.* functions)

Game scripts call engine functions via the `Spring` table. Key categories:

| Category | Functions | Notes |
|----------|-----------|-------|
| **Game control** | `GameOver({winningAllyTeams})`, `KillTeam(teamId)`, `AssignPlayerToTeam(playerId, teamId)` | `GameOver` fires the synced `GameOver` callin AND relays the winners (`GameOverState`) to the per-tick broadcast: `GameInfo{game_over=true, winning_ally_teams}` → client game-over overlay (names the winner) + unsynced `widget:GameOver(winners)`. Client keys the overlay on `game_over`, never on `paused`. StateStreamer's last-team-standing fallback uses the same broadcast (mapping the winning team → its allyteam). |
| **Unit create/destroy** | `CreateUnit(defName, x, y, z, facing, team)`, `DestroyUnit(unitId, selfDestr, reclaimed)`, `TransferUnit(unitId, newTeam)` | |
| **Unit commands** | `GiveOrderToUnit(unitId, cmdId, params, options)`, `GiveOrderToUnitArray(unitIds, cmdId, params, options)` | |
| **Unit state** | `SetUnitHealth(unitId, health)`, `SetUnitMaxHealth(unitId, maxHealth)`, `SetUnitExperience(unitId, exp)`, `SetUnitPosition(unitId, x, y, z)`, `AddUnitDamage(unitId, damage)` | 50+ unit state setters |
| **Unit queries** | `GetUnitHealth(unitId)`, `GetUnitTeam(unitId)`, `GetUnitPosition(unitId)`, `GetTeamUnits(teamId)`, `GetAllUnits()` | In LuaSyncedRead.cpp |
| **Resources** | `AddTeamResource(teamId, type, amount)`, `SetTeamResource(teamId, type, amount)`, `ShareTeamResource(fromTeam, toTeam, type, amount)` | |
| **Game rules** | `SetGameRulesParam(name, value)`, `SetTeamRulesParam(teamId, name, value)`, `SetUnitRulesParam(unitId, name, value)` | Key-value store readable by all contexts |
| **Features** | `CreateFeature(defName, x, y, z, heading)`, `DestroyFeature(featureId)`, `SetFeatureHealth(featureId, health)` | |
| **Projectiles** | `SpawnProjectile(ownerId, params)`, `DeleteProjectile(projId)`, `SpawnExplosion(params)` | |
| **Terrain** | `SetHeightMap(x, z, height)`, `AdjustHeightMap(x, z, delta)`, `SetMapSquareTerrainType(x, z, type)` | |

Full API is defined in `LuaSyncedCtrl.cpp` (mutating) and `LuaSyncedRead.cpp` (queries). Functions are registered into the `Spring` global table via `REGISTER_LUA_CFUNC()` macros.

#### Writing a Gadget

A LuaRules gadget is a Lua file loaded by `LuaRules/main.lua`. The standard pattern:

```lua
function gadget:GetInfo()
    return {
        name    = "My Gadget",
        desc    = "Does something",
        author  = "Author",
        layer   = 0,       -- execution priority (lower = earlier)
        enabled = true,
    }
end

-- Callins: define any of the event handler functions
function gadget:GameStart()
    -- runs once when the game starts
end

function gadget:GameFrame(frame)
    -- runs every sim tick (30 Hz)
end

function gadget:UnitDestroyed(unitId, unitDefId, unitTeam, attackerId, attackerDefId, attackerTeam)
    -- a unit died
end

function gadget:PlayerRemoved(playerId, reason)
    -- a player disconnected — game decides what to do
    -- reason: 0 = left, 1 = kicked, 2 = timeout
end
```

Engine base gadgets live in `cont/base/springcontent/LuaRules/`. Game-specific gadgets live in `content/games/<game>/LuaRules/`. The engine base gadgets load first, providing default behaviors that games can override.

#### Periodic gadget work: never gate on `frame % PERIOD`

**Binding rule for any gadget that does something on a cadence.** When the
server logs `sim fell behind, skipped N ticks`, `gadget:GameFrame` is *not
called* for the skipped frames — they do not arrive late, they never arrive. A
`if frame % PERIOD == 0` gate therefore drops that tick permanently, and this
was silently unsound across the whole Metalstorm gadget set
(PLAN-endtoend.md **D15**): a control objective banked zero hold progress over
40 000 frames at 8× sim, and a diagnostic probe on the same gate emitted 11
samples in a 24 378-frame war.

Use `data/games/metalstorm/LuaRules/Gadgets/tick.lua` — one shared definition of
the rule, `VFS.Include`d like any other shared module:

- `Tick.due(gate, frame)` — **observation** policy, at most one fire per call.
  For anything that samples current state (evaluate objectives, sample region
  ownership, publish a scoreboard, recompute HP): the world is observable once,
  so a multi-period stall must not invent duplicate samples.
- `Tick.count(gate, frame)` — **accrual** policy, one fire per elapsed period.
  For anything that pays out per period (authority stipend, overflow decay, AI
  allowance drip): the amount was earned by the passage of frames, so
  collapsing it lets a team lose income to machine load.

Both preserve the phase grid across a skip, so on an unloaded machine they fire
on exactly the frames the old modulo gate did. Caveat, documented in the
module's header: `due()` restores the *tick*, not the samples, so subsystems
that count ticks to measure duration (`regions/ownership.lua`'s
FLIP_TICKS/DECAY_TICKS) still stretch in frame terms under sustained overload.

### Audio System

End-to-end pipeline from server sim emissions to browser playback. Single source of truth: [PLAN-audio.md](PLAN-audio.md).

```
Server (sim thread)                              Client (main thread)
─────────────────────────────────                ───────────────────────────────
CWeapon::Fire / CWeaponProjectile::Collision /   ConnectionManager.onSoundEvents
CUnit::DoDamage  ─► AllowSound (Lua veto)        SoundEventPlayer.handleBatch
        │                                                │
        ▼                                                │  resolve SoundRef.name → SoundItem
SoundEventCollector.Push(SoundEventData)                 │  resolve SoundItem.file → URL (.webm)
        │   { soundId, sourceDefId, sourceKind,          │
        │     position, volume, pitch, priority,         ▼
        │     team, channel }                       AudioManager.loadSound (fetch+decode once)
        ▼  per-tick drain                                │
Protocol::BuildCombatEventBatch ─► SoundEvent[]          ▼
        + MusicStateTracker.Tick(combat count)      AudioManager.play({
        + drain pending transition → MusicEvent       buffer, x,y,z, volume, pitch, priority,
        in GameEventBatch                             channel, spatial, rolloff, maxDist })
                                                         │
GameUnitDef / GameWeaponDef carry SoundRef[]             ▼
sounds (path, name, category, vol, pitch)           96-voice pool → PannerNode →
                                                    channel bus (1 of 5) → master gain →
                                                    ConvolverNode (map reverb, passthrough
                                                    unless mapinfo sets a preset) →
                                                    DynamicsCompressor → destination

                                                    Music path (BGMusic channel):
ConnectionManager.onMusicEvent ───────────────► MusicDirector.handleMusicEvent
                                                    pick track from per-state playlist
                                                    AudioManager.playMusic(url, vol, fadeMs)
                                                    └─ HTMLAudioElement + MediaElementSource
                                                       crossfade A/B slots over `fade_ms`
```

#### Channels (Recoil parity)

Five named buses, each with independent volume + enable state persisted to `localStorage` under `audio.channel.<name>`. The mix channel is **caller-determined**, not a SoundItem field:

| Channel | Typical callers |
|---------|-----------------|
| `General` | `Spring.PlaySoundFile` with no channel arg, ambient SFX |
| `Battle` | `CWeapon::Fire`, projectile impacts, `CUnit::DoDamage` |
| `UnitReply` | Selection / order-ack barks |
| `UserInterface` | Widget UI clicks, build menu feedback |
| `BGMusic` | Music streaming (state-machine and `Spring.PlaySoundStream`) |

Voice acquisition applies Recoil's per-channel cap with strict-greater-priority eviction (`AudioChannel.cpp:100-126` parity).

#### Content prep (`tools/audioconverter`)

Standalone ffmpeg-driven CLI. `gameconverter` walks a game's `sounds/**` and `LuaUI/Sounds/**`, re-encodes every `.wav/.ogg/.mp3/.flac/.m4a` to a sibling `.webm` (Opus) at category-specific bitrates (sfx 64 kbps mono, ui 48 kbps mono, music 96 kbps stereo), then prunes the source. The runtime never sees a non-`.webm` audio file. ffmpeg is located at CMake configure time; `-DSPRING_SKIP_AUDIOCONVERTER=ON` opts the target out for hosts that don't run content prep.

#### SoundItem resolution (`gamedata/sounds.lua`)

The widget worker runs `VFS.Include("gamedata/sounds.lua")` immediately after VFS prefetch and posts the resulting `SoundItems` map to the main thread. AudioManager.ingestSoundItems holds a `Map<name, SoundItem>` keyed by lower-cased logical name; resolution order is:

1. `SoundItems[name]` (authoritative for `gain` / `pitch` / `priority` / `maxconcurrent` / `maxdist` / `rolloff` / `in3d`).
2. Server's `SoundRef.path` (already `.webm` after `NormalizeSoundPath`).
3. `normalizeSoundPath(name)` heuristic (last resort).

The same map drives both server-emitted SoundEvents (resolved via `SoundRef.name`) and widget `Spring.PlaySoundFile` calls.

#### Lua audio API

Eight functions on the worker's Spring table, matching Recoil's `LuaUnsyncedCtrl.cpp` signatures verbatim so upstream games port without source patches:

`Spring.PlaySoundFile(file, vol, x,y,z, sx,sy,sz, channel)`, `PlaySoundStream(file, vol, enqueue)`, `StopSoundStream()`, `PauseSoundStream()`, `SetSoundStreamVolume(v)`, `GetSoundStreamTime()`, `SetSoundEffectParams(preset | table)`, `LoadSoundDef(file)`, `PreloadSoundItem(name)`.

`Spring.GetConfigInt`/`SetConfigInt` + a `SendCommands{"set <key> <value>"}` verb persist to `springConfig.<key>` in localStorage and apply audio-key side-effects (`snd_volmaster` → master volume, `snd_volgeneral`/`battle`/`unitreply`/`ui`/`music` → channel volume), so chili epicmenu trackbars work end-to-end without source patches.

#### Map reverb

`mapinfo.lua → sound = { preset = "..." }` is extracted by `MapProcessor`, persisted in the maps table as a `sound_preset` column, and surfaced in metadata.json. `main.ts:onMapData` calls `AudioManager.setReverbPreset(preset, mapBaseUrl)`; the manager fetches `sounds/efx/<preset>.webm` and ramps the master ConvolverNode's wet/dry to 50/50. Missing IRs stay in passthrough — map authors can name a preset without shipping the IR and the effect matches `"default"`.

#### Music state machine

`MusicStateTracker` samples per-tick combat-event counts into a 30-second ring buffer and derives state from sliding windows:

| State | Entry condition |
|-------|-----------------|
| `peace` | Zero combat events in the last 30 s |
| `tension` | ≥ 1 event in the last 5 s, below battle threshold |
| `battle` | > 15 events in the last 3 s (~ > 5/sec sustained) |
| `victory` / `defeat` | Externally forced via `ForceState(..., sticky=true)` (GameOver hook — not yet wired) |

`BuildCombatEventBatch` ticks the tracker and drains at most one transition per batch into a `MusicEvent`. The client's `MusicDirector` picks a random track from the matching playlist (`music_<state>_<n>` SoundItems from `gamedata/sounds.lua`) and crossfades over the event's `fade_ms` (default 2 s, 500 ms for victory/defeat stings).

Music start is gated on terrain-mesh build via `MusicDirector.arm()` — `MusicEvent`s before the gate stash their target state and apply the latest once opened, without replaying intermediate transitions.

### Content & Data

```
content/
  games/papertanks/         Source game (units/*.lua, weapons/*.lua, modinfo.lua, ai/)
  maps/wanderlust2.1/       Source map (.smf, mapconfig/, LuaUI/Widgets/)
  engine/ai/                Engine-level AI plugins

data/
  spring-server.db          SQLite: accounts, sessions, maps; rooms/room_members/
                            room_ai_slots (lobby-written); game_servers (lobby-written
                            pid/port); game_status (spring-server-written ready/clients
                            heartbeat — the lobby↔game readiness rendezvous);
                            war_summary (spring-server-written per-war digest for the
                            war browser — populations/spectators/region control);
                            game_metrics (spring-server-written sim-health rows for the
                            GM dashboard, PLAN-gm-tools); admin_audit (append-only)
  maps/<mapId>/             Preprocessed: heightmap.bin, minimap.dxt1, tiles.dxt1, features/*.glb
  games/<gameId>/models/    Preprocessed: <unit>.glb, <unit>.config.json, <texture>.png
  games/<gameId>/sounds/    Preprocessed: *.webm (Opus, audioconverter output)
```

**Everything under `data/` is a derived artifact and gitignored** — the only
tracked binary content is `content/maps/*/` (source `.smf`/`.smt`) and
`data/games/metalstorm/models/` (forge output, first-party). Regenerating
`data/` therefore moves no tracked bytes: `mapconverter --force --all
content/maps` and `gameconverter --force <game-dir>` are safe to re-run.

**KTX2 orientation metadata.** Every `.ktx2` `textureconverter` writes carries
`KTXorientation` = `rd` (`rts/System/FileSystem/Ktx2Orientation.h`) — the bare
per-dimension letters of KTX2 §3.11.4, *not* libktx's KTX1 `KTX_ORIENTATION2_FMT`
spelling `S=r,T=d`. The KTX1 form compiles and renders fine — neither Babylon's
KTX2 loader nor `basisu` reads the key — but it makes the file invalid, and the
Khronos `ktx` CLI (`validate` / `info` / `extract`) then refuses to open our own
assets, which costs asset investigations their standard tool. `data/games/{bar,zk}/models/`
still carries the old value; those are archived third-party games and closing
them needs a full `gameconverter --force` model re-import (PLAN-maps M8f).

**KTX2 `bytesPlane0` must be sized on supercompressed output.** KTX2 ≤ 2.0.3
required a supercompressed file's `bytesPlane0..7` to read *unsized* (all
zero); spec 2.0.4 reversed it, because the DFD describes the **inflated** texel
block, whose size a reader needs before it has inflated anything. Both encoders
we control still implement the old rule and must be corrected on the way out:
`textureconverter` goes through `DeflateZstdKeepingBytesPlanes`, which
save/restores the two DFD words around libktx 4.3.2's
`ktxTexture2_DeflateZstd`, and forge's four `encode*.mjs` run their output
through `fixupEncoded` (`tools/fable-model-forge/ktx2_dfd.mjs`), which derives
the size from the DFD's own sample descriptions. Offsets and the spec predicate
live in `rts/System/FileSystem/Ktx2BytesPlane.h` so `spring-tests` — which does
not link libktx — can pin them. `ktx validate` reports the defect as
`warning-6030` and still exits 0, so **no gate catches a regression here except
that test**; the same module also runs as a CLI (`node ktx2_dfd.mjs
--check|--fix <files>`) to audit or repair files already on disk, one byte per
file, no pixel data touched (PLAN-maps M9i).

**KTX2 provenance metadata.** Three encoders write `.ktx2` into this tree —
`textureconverter`, forge's `Basis Universal`, and `toktx` — so every one of
our outputs stamps `KTXwriter` = `springrts-web textureconverter / libktx v4.0`
(PLAN-maps M8j). Without it libktx's fallback `Unidentified app` made ours the
only anonymous files, and "which of these did *we* write, and therefore which
carry the defect we just fixed?" had to be inferred from mtimes and the
orientation spelling. One census over the key now answers it:
`data/games/{bar,zk}` are the untouched archived files, everything else on the
Metalstorm path is forge/`toktx` output or freshly regenerated.

**Mip generation must not move a texture's DC.** `textureconverter` builds its
own 2x2 box chain for encoded (non-DDS) sources, and that filter rounds
half-to-even (`detailtex::MipBoxAvg4`, `rts/System/FileSystem/DetailTexDc.h`).
Integer truncation — what it did until PLAN-maps M8i — loses up to 0.75 of a
level per step and compounds: measured **-3 levels** from level 0 to the 1x1 on
every shipped map. For ordinary art that is an invisible darkening with
distance; for a map's **`detailTex` it is not**, because SMFFragProg adds the
sample *signed* (`baseColor += tex*2-1`) with no fade uniform, so the top mip's
mean is a flat tint applied at **every** viewing distance. Two rules follow:
the filter is shared, tested code and stays unbiased; and a plain `detailTex`
must be authored with its mean on **127.5** (not 128 — `x*2-1` is zero at
`x=0.5`, which no single texel can hold). `mapconverter` measures the mean via
`textureconverter --signed-dc-report` and warns past ±2 levels, but only when
the map's `resources` actually select the plain branch — the splat and
splat-normal branches suppress it, mirroring `attachTerrainDetailFromDecals`.

**`?direct=` manifests live in two places.** A direct-boot manifest is authored
in `manifests/` (the tracked source of truth) and **must also be copied to
`client/public/`** — that, not `manifests/`, is what the browser fetches. The
failure is silent-shaped: an uncopied manifest is not a 404, because the static
server's SPA history fallback answers any unmatched path with `index.html` at
HTTP 200, so only the JSON parse fails. `parseDirectManifest`
(`client/src/core/direct-manifest.ts`) detects the HTML body and says which copy
is missing; `direct-manifest.test.ts` asserts every `manifests/*.json` has a
byte-identical served copy.

## HTTP Routes

> **Handler gotcha:** `NetworkServer` strips query strings before matching/handing
> the path to handlers — a handler that parses params out of its `path` argument
> silently gets none. Use `CurrentQueryString()` to read query parameters.

### Lobby (`spring-lobby`)

| Route | Serves |
|-------|--------|
| `/api/maps` | JSON list of all maps (metadata from DB) |
| `/api/maps/source/<mapId>/*` | Raw map source files (Lua, images) |
| `/api/maps/data/<mapId>/*` | Preprocessed map assets (heightmap, tiles, feature models) |
| `/api/maps/thumb/<mapId>` | Map thumbnail (WebP/PNG) |
| `/api/games` | JSON list of discovered games (`id`, `displayName`, `shortName`, `description`, `version`, `lighting`, `modelMaterialPort`, `archived`/`archivedReason`, `resourceEconomy` — from each game's modinfo via GameDiscovery). Drives the lobby dropdown and the worker's `Game` table (modName/modShortName/…) + lighting style. Client-side capability gates read this payload, never the game id: `archived` disables the create-room option, `resourceEconomy: false` (Metalstorm) suppresses the metal/energy HUD. Both default to the legacy behaviour when absent. |
| `/api/vfs/game/<gameId>/*` | Game source files (Lua scripts, images) |
| `/api/games/data/<gameId>/*` | Preprocessed game assets (unit models, textures) |
| `/api/factions/<gameId>` | Public. JSON list of the factions a game declares in `gamedata/sidedata.lua` (`key`, `name`, `fullName`, `description`), discovered once at startup via `FactionData::Discover`. Drives the sign-up form's required faction picker. `[]` for a game that declares none; 404 for an unknown game. |
| `/api/processes` | JSON list of game server instances (pid, port, state, map, game) |
| `GET /admin` | GM operations dashboard (server-rendered HTML; own admin login). PLAN-gm-tools §2. |
| `POST /api/admin/fleet` | AdminOnly. Every game server + latest `game_metrics` (join `game_servers`⟕`game_status`⟕`game_metrics`) + alarm badges (lobby-derived: lag/db/crashed; plus the game server's growth alarms parsed out of `extra_json`) + the raw `growth` counters. |
| `POST /api/admin/game` | AdminOnly. Per-game metric timeline (each row carrying its `growth` counters when present) + audit tail (`{roomId}`). |
| `POST /api/admin/ban` / `unban` / `banned` | AdminOnly. Account ban (+ immediate session revoke) / unban / ban list. PLAN-gm-tools task 4. |
| `POST /api/admin/set-faction` | AdminOnly, audited. Override an account's permanent faction (`{username, faction}`). The only writer of `users.faction_id` after sign-up — faction is immutable in the normal flow, so there is deliberately no player-facing equivalent. PLAN-metalstorm-lobby §1b. |
| `POST /api/auth/{login,register,validate}` | All three echo the account's `faction` when it has one (omitted, never empty, for dev/manifest accounts) — login and validate are the only ways a returning session can learn it. PLAN-endtoend D40. |
| `POST /api/auth/logout` | Public. Deletes the session row named by the request's own `Bearer` token, and answers **200 either way** (`{"ok":true,"revoked":<bool>}`). Public rather than TokenRequired on purpose: `DispatchPost` would 401 a dead token before the handler ran, and an expired session you cannot leave is the defect. `revoked:false` for an unknown token, an empty `Bearer`, no header, or Basic auth (which holds no session row at all). Client side, `LobbyUI.logout()` leaves the room *before* revoking — see [Logout](#logout). PLAN-endtoend D45. |
| `POST /api/auth/refresh` | Public (a caller whose access session has aged out cannot present one). Rotates `{refresh_token}` into a fresh access session, returning the **same JSON shape as login** so the client has one code path. Single-use: the presented token is marked spent and a successor is minted in the same **family**. Presenting a spent token is a replay — the whole family is revoked and every failure answers one `401`, because telling a caller *which* failure it was tells a thief they hold a live lineage. A ban revokes every family. Failed refreshes (only) consume a global token bucket. PLAN-metalstorm-lobby §7.2, task 8a. |
| `POST /api/auth/logout-all` | TokenRequired. §7.2's "log out everywhere": every `sessions` row **and** every refresh family the account holds (`{"ok":true,"sessions_revoked":n,"refresh_revoked":n}`). Deliberately a **separate control** from the header's Log out — one browser signing out must not evict the player's phone from a war they are standing in. Client: `LobbyUI.logoutEverywhere()`, `#logout-all-btn`. |
| `POST /api/wars/reconnect-token` | TokenRequired. Mints this account's long-TTL (7-day) key back into ONE war (`{room_id}` → `{room_id, token, expires_in}`). The **binding is the authority**, not `room->players` — a war's fighters are seated by the game server and never appear in the room's player list. 404 unknown room / 400 not a persistent war (a skirmish dies with its lobby, so a week-long key into one opens nothing) / 403 no seat held. PLAN-metalstorm-lobby §7.3, task 8a. |
| `POST /api/rooms/team` | A player's own side choice. **403 `{"error":"you fight for <faction>","team":<n>}`** when the room declares a side for their faction and the request names a different team — the seating rule has to hold against the dropdown too, or it is undone by the next click. Enforced at the route (where a human chooses), not in `RoomManager::SetTeam`, which stays permissive for the manifest paths. |

### Game server (`spring-server`)


| Route | Serves |
|-------|--------|
| `/api/map/info` | JSON map dimensions |
| `/api/map/heightmap` | Binary heightmap |
| `/api/maps` | JSON available maps |
| `/api/metrics` | JSON performance stats — `simFrame` field adds the PLAN-server-cpp-optimisation.md P0 SimFrame-profiler phase breakdown (native-sim/unit-script/lua-gameframe) once `server sim profile on` has samples; see [docs/debugging-performance.md](docs/debugging-performance.md#server-side-simframe-profiler--lua-call-in-profiler) |
| `/api/content/manifest` | JSON index of all servable assets |
| `/api/content/assets/*` | Individual asset files from content roots |
| `POST /api/gm/*` | GM verbs (`pause`/`resume`/`grant`/`broadcast`/`inspect`/`kick`/`rollback`/`checkpoint`/`hibernate`/`snapshots`). AdminOnly + audited; the dashboard POSTs here directly (browser→game port). PLAN-gm-tools task 2 (`GmVerbs.cpp`). |
| `/api/journal` | JSON synced-input cause-stream tallies (`seen`/`recorded`/`appended`/`skipped` + per-kind). Loopback-only. With `--journal-audit [N]` also reports the in-memory ring's head/tail. See [Synced-input funnel](#synced-input-funnel-the-cause-stream). |
| `/api/wt/info` | JSON `{port, transport, certMode}` — WebTransport (QUIC) endpoint discovery. `certMode:"hashes"` (dev/self-hosted default) adds `certHashes:[current,next]` (+ back-compat `certHash`) for `serverCertificateHashes` pinning; `certMode:"webpki"` (`--wt-cert`/`--wt-key` configured) publishes no hash — the browser validates the CA cert normally. Replaces the removed `/api/rtc/offer` + `/api/rtc/candidate` WebRTC signaling. |

### Log server (`spring-logserver`)

| Route | Serves |
|-------|--------|
| `/api/logs/<roomId>` | Recent log entries (params: level, section, scope, limit) |
| `/api/logs/search` | Full-text log search (params: q, level, section, scope, limit) |
| `/api/logs/sources` | Connected log source status |
| `/api/logs/stream` | SSE live log stream (params: level, section, scope) |
| `/api/sessions` | Recent game sessions (from game_sessions table) |

## Data Flow

### Auth + Game Start
```
Client → lobby HTTP: POST /api/auth/login → token
Client → lobby HTTP: POST /api/rooms (create) / /api/rooms/join
Client → lobby HTTP: POST /api/rooms/ready / /api/rooms/start
  Lobby forks+execs spring-server (--player roster, --ai, --map, --db)
  → room state = Loading, game_server_port = N
  Sim boots: loads defs + map + gadgets, binds QUIC, waits for roster auth
  spring-server publishes game_status.ready=1 (shared SQLite) once accepting
  Lobby health-check reads ready=1 → room state = Active
    (the only honest Loading→Active driver — there is NO sim→lobby
     socket/pipe; SQLite game_status is the rendezvous)
Client (SSE room-state updates) sees state≥Loading + port>0 → connects:
  Client → GET /api/wt/info (cert hash + WebTransport port)
  Client → game WebTransport: AuthRequest (token); server checks roster
  Client ← game: AuthResponse, then def stream (HTTP) + MapData
  All roster players connected → FireGameStart()
    → gadgets spawn starting units (start_unit_setup.lua)
```
**Session kind (skirmish vs persistent war).** A room carries a
`SessionKind` (`RoomManager.h`), stored in `rooms.session_kind`, offered as
`sessionKind` on `POST /api/rooms` and `/api/rooms/direct`, echoed as
`session_kind` on every room JSON, and forwarded to the game server as
`--session-kind`. It decides **the roster gate above**: a `skirmish` holds
GameStart until every rostered human has connected (the flow as drawn); a
`persistent` war fires GameStart during set-up and joins its roster as it
arrives (PLAN-metalstorm-lobby.md §1/§2.1). The two expressions that decision
is made from — `SessionWaitsForRoster` / `SessionStartsGameAtSetup` — live in
`GameStartCoordinator.h` and have four readers, including the replay
prologue-feed branch, which must agree with the live one exactly.

It is **not** the same field as `GameRoom::persistent`, which is a *reaping*
policy and is also set on ordinary AI-testing skirmishes. The implication runs
one way and `CreateRoom` enforces it: a persistent war is always persistent; a
persistent room is not always a war. An unknown spelling is refused at both
API entry points (a war silently downgraded to a skirmish waits forever for a
roster and logs it exactly like a slow browser) but downgraded-with-a-warning
on the db load path, where the row already exists and losing it is worse.

**Dynamic join (a war's *join* gate).** The kind also decides who may take a
*playing* seat. An authenticated account that is not in the game server's
`--player` launch roster has always been admitted — as a **spectator**, which
is what the "spectate a running game" flow depends on — so the gap a
persistent war left was that it could start without its roster and then never
gain anyone. `DynamicJoin.h` promotes that spectator to a player when, and
only when, all of: this is a `persistent` war; the account carries a faction
(`users.faction_id`); the war fields a side for that faction; and that side is
under capacity. Every decline falls through to the spectator seat — none of
them refuses the connection — and each names its reason in the operator log.

The seat follows the **faction**, never a balancer (PLAN-metalstorm-lobby.md
§2.3): a player is never moved off their own side. The faction→team map is the
`war_sides` modoption the lobby wrote at room-create time, decoded by
`ParseWarSides` (`WarSides.h`) — the *same* function `GameRoom::SideTeams()`
uses, because the lobby and the game server are separate processes and two
hand-rolled parsers is the shape that admits a faction on team 0 in one and
refuses it in the other. The count-then-bind sequence is atomic
by thread confinement, not by a lock: both halves run inside the single
`AuthRequest` case on the message-pump thread, and nothing else seats a human.

**Per-side capacity, seeding and Deploy (structural balance).** A player always
fights for their own faction, so balance cannot be done by moving anyone onto a
weaker side — it is decided at the only two moments that remain: when a war is
*seeded*, and when a player picks *which war* to join (PLAN-metalstorm-lobby.md
§6). So capacity is per side, not per war: `war_side_capacities`
(`"compact:6,union:2"`) is a **second, additive modoption** written beside
`war_sides` at room-create time and decoded by `ParseWarSideCapacities`
(`WarSides.h`) in both processes. It is a separate option and not a third field
on `war_sides` because every reader of that string rejects a non-numeric team
outright, so a cached client bundle would silently fall back to the legacy
two-team room — the exact D19 defect `war_sides` exists to fix. Any side a war
leaves unsized falls back to `--war-side-capacity` (default 8, `0` = unlimited),
which is what every pre-task-7 war has.

The value comes from two places, merged in this order: `WarSeeding.h` sizes each
side as `clamp(ceil(registered(faction) / (warsFieldingIt + 1)), 2, 32)` from
`Database::CountAccountsByFaction()`, and the scenario's own per-side
`capacity` (`ScenarioDiscovery::AuthoredSideCapacities`) overrides it. The `+ 1`
is self-limiting: a second war for a faction halves the size of every side that
faction fields, so a surplus faction gets *more wars* rather than one enormous
one. Only a persistent war gets capacities at all — a skirmish's cast is its
roster.

`POST /api/wars/deploy` is the one-click "which war should I fight in", decided
by `WarDeploy.h`: a war this account is already bound to wins outright, else the
war with a free seat where its side is **most outnumbered** (§6's underdog
incentive expressed as routing — the only lever that reduces a deficit when
nobody can change faction), tie-broken on live population then on the lowest
room id. It never refuses: a faction that is full in every war gets `seed`, and
§6's queue is deliberately **not built** — a queue is a promise to seat someone
later, and seeding a new war is an answer now. §6's other named incentive,
*bonus onboarding authority* for the outnumbered side, is not implemented; see
the note in `WarDeploy.h`'s header and PLAN-metalstorm-lobby.md task 7.

**Rejoin (a war's memory of a player).** Dynamic join is stateless: it seats a
joiner by faction every time they connect and cannot tell a veteran of this war
from a stranger. `war_player_bindings` (`Server/WarPlayerBindings.h/.cpp`) is
the account↔war record that fixes that — one row per (room, account) holding the
side they hold, when they first fought here, and their per-player war state
(authority pool + participation credit). The **game server writes it** (it is
the process that seats players and the only one that can read the sim); the
lobby reads it, and the audited faction override deletes from it, because a
binding records the team the *old* faction sat on. It is the one table in the
shared db that is **migrated, never probe-and-dropped**: `rooms`/`game_servers`/
`game_status` are mirrors of live in-memory state, and this is the only copy of
the thing.

`WarRejoinPolicy.h` is the pure decision, and it carries **two horizons** rather
than one because the two things being restored have different natures. The SEAT
is an identity: held for `WAR_SEAT_HOLD_SEC` (a week) against the *capacity*
check only — so a full side cannot turn away a player who has been holding it
since Tuesday — while which team they get always follows the immutable faction,
so a war whose sides are re-authored supersedes the binding rather than the
reverse. The POOL is a conserved resource and goes stale in
`WAR_BRIEF_ABSENCE_SEC` (5 min); past that §2.5's rule applies and the player
gets the onboarding stipend instead.

State moves between the sim and the row through `Server/WarStateSim.h/.cpp`.
Capture is a plain rules-param read, run on disconnect **before** the
PlayerRemoved delivery (the gadget merges a leaver's pool into the team pool, so
capturing after it would record zero for everyone) plus a
60 s sweep, which is what survives a `kill -9`. Restore is deliberately NOT the
mirror image: it calls `GG.Authority.RestorePool` / `GG.Teams.RestoreScore` in
synced Lua, both **top-ups to a remembered level** rather than deposits, so they
are idempotent, un-farmable and a no-op when the sim never lost the value. They
are called directly into the synced state, never over `RecvLuaMsg` — any client
can forge one of those, which would hand every player a "restore my pool to N"
verb. Replays skip the whole path (a replay has no db to ask, and a dynamically
joined session already cannot replay — its team is not in the recorded roster).

**The three player callins do NOT reach synced gadgets through `eventHandler` —
the server delivers them by hand.** `PlayerChanged`/`PlayerAdded`/`PlayerRemoved`
are declared `MANAGED_BIT | UNSYNCED_BIT` in `System/Events.def` (verbatim
upstream), and `CEventHandler::InsertEvent` refuses the registration outright for
any client that reports itself synced. So `eventHandler.PlayerRemoved(...)`
iterates a list the synced LuaRules handle is not and cannot be in — which is why
`game_authority.lua`'s leaver merge had never once run, and why a mid-war dynamic
joiner arrived with no authority pool at all. Nothing was forgotten; the event is
unsynced *by classification*.

`Server/PlayerOnboarding.h/.cpp` is the deliberate, named deviation
(FIDELITY-STANDIN — allowed by the client-server carve-out, and confined to two
call sites): `FireSyncedPlayerAdded` / `FireSyncedPlayerRemoved` invoke the
callin on `luaRules->syncedLuaHandle` directly. Safe here and not upstream
because this engine is server-authoritative, there is exactly one synced Lua
state, and the seat change is already in the synced input journal
(`RecordAuthIdentity` / `RecordDisconnect`) — so a replay re-executes the same
delivery. `PlayerAdded` fires from `bindPlayer` in ClientMessageHandler (the
seat installer shared by the token, password and replay paths, which is what
makes it deterministic) gated by `DecideOnboardingHook`: a seated non-spectator
human, and only **after** GameStart — before it, `gadget:GameStart`'s own roster
loop onboards them, and a grant issued earlier would land on team pools
GameStart is about to reset. `PlayerRemoved` fires from the disconnect drain and
from the replay feed, in both cases immediately after `eventHandler.PlayerRemoved`
(which still serves any unsynced client) and after the war-state capture.

**Pre-join legibility:** `POST /api/wars/join-preview` (lobby, authed) answers
"what happens to ME if I join this war" for every persistent war at once — side,
seat count, and the authority the player arrives with. It composes
`DecideDynamicJoin` and `DecideRejoin`, the same pure functions the game server
seats with (`Server/JoinPreview.h`), so the promise cannot drift from the rule;
per-side population comes from `war_player_bindings`, not the room's player list,
because a war's fighters are seated by the game server and never appear in the
room roster at all.

**The war browser** (`client/src/lobby/war-browser.ts`, rendered by `renderWarList`
from `browser/war-entry.html`) lists persistent wars in their own section above the
room list, filtered by default to *wars my faction fields a side in*. Every field it
shows is either durable or live, and which is which is load-bearing: seats held
(`bound`) and seats left (`open`) come from `war_player_bindings` and are therefore
correct for a war whose server is not running (an offline veteran's seat is not
free); connected populations, spectator count, region control and uptime come from
the `war_summary` digest and are simply absent otherwise, with `live` saying which
half is on screen. The lobby re-broadcasts the room list every ~5 s while any war
exists — every other broadcast in `lobby_main.cpp` fires on a room mutation, which is
right for a room and wrong for a war, whose populations and front move without anyone
touching the row.

**Spectating a war by choice:** a `POST /api/rooms/join` with `as_spectator` on a
persistent war records `room_members.spectate_only`, and the game server's auth
`resolveSeat` checks it *before* every seating rule (`Server/RoomWatchIntent.h`) —
after them is too late, because dynamic join would already have promoted the account
to its faction's side. Re-joining the other way converts, in either direction, and
takes effect on the next connect: the seat is taken at auth, and a role change inside
a running sim would need a protocol message that does not exist.

**Game-server lifetime:** a non-persistent game server self-terminates after
5 min with zero connected clients (120 s startup grace); persistent rooms run
forever. The lobby reaps abandoned non-persistent rooms (no live game, idle
>30 min) and, on startup, resets orphaned Loading/Active rooms (no adopted
server) back to Filling. See PLAN-lobby-game-connection.md.

### Logout
```
Client: header "Log out" (browser + room screens) → LobbyUI.logout()
  → runLogout() (client/src/lobby/logout.ts) — order is the whole point:
  1. POST /api/rooms/leave   (only while in a room; needs the live token)
  2. POST /api/auth/logout   (deletes the session row; carries the refresh
                              token in its body so the FAMILY dies too)
  3. clear LOGOUT_CLEARED_KEYS + reset LobbyUI state → showLogin()
```
Steps 1 and 2 are best-effort and step 3 is unconditional: a player who asked
to leave an account must not stay signed in to it because the network was
down. Step 1 comes first because a host who revokes first strands their own
seat — and their room — until the lobby reaps it. `LOGOUT_CLEARED_KEYS`
includes `springrts-game-room`/`-game-port`, which are the *rejoin* keys, not
auth keys: leaving them behind drops the **next** account on that browser into
the previous account's room. PLAN-endtoend D45.

Task 8a added `springrts-refresh-token` to that key list, and it is the worst
of the three to miss: a 30-day credential left in localStorage rotates itself
into a fresh session on the next page load, so the logout silently undoes
itself. Clearing it locally is only half — `/api/auth/logout` is also given
the token so the server revokes the family, because a copy taken off the
machine is still live. **`logout-all` is a different verb** (§7.2): it ends
every session and every family the account holds, which evicts the player's
other devices, and is therefore its own button rather than a modifier.

### Token lifetimes (task 8a, TTL shortened by 8a-follow-on)
```
access session  (`sessions`)                 1 h   account-wide bearer
refresh token   (`refresh_tokens`)          30 d   rotating, single-use, hashed
war reconnect   (`war_reconnect_tokens`)     7 d   ONE room, hashed
```
All three constants live in `AuthTokens.h`. The access TTL moved there from
`HttpAuth.h` because it had **two** definitions and only one of them was named:
the lobby passed `kAccessTtlSeconds` explicitly, while the game server's
`AuthRequest` path took `Database::ValidateSession`'s `86400` **default
argument**. They agreed by coincidence — shortening the named one alone would
have left every game server honouring a day-old bearer token.
Task 8d adds a credential that is not a token and does not appear above: a TOTP
code, valid for one 30 s step and **once**. It gates `/api/auth/login` — and
`ValidateAuth`'s **Basic** branch, which is the non-obvious half. Basic auth is
accepted on every TokenRequired route, carries no code and has nowhere to put
one, so an enrolled account authenticating by password alone there would make
the login gate decoration. An enrolled account therefore gets 0 from Basic; the
Bearer session it already holds is untouched (enrolling is not a logout).

#### Who holds the access token, and how it stays live (8a-follow-on)

Task 8a left the TTL at 24 h because every holder of `springrts-token`
snapshotted it at construction, so a shorter window would have expired it
mid-session with nobody re-reading. The census found **seven** holders, not the
six that note listed: four `localStorage.getItem` reads in `main.ts`, the game
worker's `gp:init` credential, the LuaUI worker's telemetry channel, and
`LobbyUI.authToken` — a private field read by ~20 methods that no note had
named. (The `viewport.ts` / `minimap.ts` / `connection.ts` sites the 8a note
lists do not read the key at all; they are handed a token by their caller.)

`client/src/lobby/auth-tokens.ts` now owns the token's lifetime:

- **An expiry stored next to it** (`springrts-token-expires`), derived from the
  `expires_in` every auth response already carried and nobody read. The token
  is opaque, not a JWT, so this record is the only way the client can answer
  "is it stale?". **Missing means unknown, and unknown means not expired** — a
  session adopted by an older build degrades to the pre-8a-follow-on world.
- **`getAccessToken()`, read at use.** Main-thread holders call it; the two
  Worker realms cannot (no `localStorage` there) and are pushed a `gp:token`
  message instead. `LobbyUI.authToken` became an accessor over the same store.
- **`AccessTokenRenewer`**, a timer at half the *remaining* life. Proactive
  rather than 8a's on-401 path, because the 401 only exists on the lobby's HTTP
  surface: the **game server authenticates once at `AuthRequest`** over a
  connection that then lives for the whole match, so a session ageing out
  mid-match is observed by nothing until the reconnect asks for a password.
- **A cross-tab lock plus a post-lock re-read of the expiry.** Refresh tokens
  are single-use with family-wide reuse detection, so two tabs rotating the
  same token is indistinguishable from a replayed theft and signs the player
  out everywhere. That race existed on the 401 path; a timer would make it a
  scheduled event. The re-read is what actually closes it — it checks the
  outcome, not the intent. Peers learn via the `storage` event; the tab that
  logged in learns via an `onTokensStored` hook, because `storage` fires only
  in *other* tabs.

`gameAuthToken()` now skips an **expired** access token rather than presenting
it. The game server tries the war reconnect token only when the session lookup
fails, and the client sends exactly one credential — so a stale string in
localStorage is what *prevents* the 7-day war token ever being offered.

`/api/auth/validate` reports `expires_in` as the session's **remaining** life,
not the TTL: it is the only auth route reporting on a session it did not mint,
and it is the reload path.

The game server tries the access session **first** and the war token second, so
nothing about the ordinary path changed. When it authenticates via the war
token it echoes an **empty** token in AuthResponse: the client stores whatever
comes back as its session token, and a war token would 401 everywhere else.

### Gameplay Loop
```
Server: sim ticks at 30Hz
Server → client (10Hz): Tier 2 binary entity state (envelope 0x02/0x03)
Server → client: FlatBuffers GameEventBatch (combat events)
Client → server: PlayerCommand (move, attack, stop)
Client → server: ViewportUpdate (camera position/zoom)
Client: interpolates entities between ticks, renders via Babylon.js
```

### Synced-input funnel (the cause stream)

Everything that changes the synced sim from **outside** it passes through
`syncedinput::Journal()` (`rts/Server/SyncedInputJournal.{h,cpp}`) before it is
applied. There are exactly five such places, and they are the server tick's own
source order — `TickPhase` names them:

```
server tick (server_main.cpp)
  BeginTick(frame)
  1 Inbound     DrainInbound  → ClientMessageHandler::HandleMessage   ← records ALL 45 wire verbs
  2 Disconnect  DrainDisconnects → PlayerLeft / PlayerRemoved
    sim.SimFrame()
  3 LuaExec     luaExecEngine drain (admin console + POST /api/exec)
  4 Stream      streamer.Tick → StateStreamer::TickAI (AI command drain)
  + anchor      CSimulation::FireGameStart (roster/leaders)
```

Records are ordered by `(frame, phase, seq)`. Frame alone is insufficient: while
`gs->paused` is set or before GameStart the frame does not advance while inbound
messages keep arriving, so `seq` (process-monotonic) is the real total order.

The inbound site records the **raw wire bytes before dispatch**, not a decoded
form — a replay re-feeds them through the same `HandleMessage`, and messages the
live run rejected (rate limit, stale sequence, authority veto) are in the stream
so a replay rejects them identically. Which verbs are kept is decided by one
exhaustive classifier (`ClassifyClientPayload`, four-way: Synced / Setup /
Unsynced / Ignored), never by the individual handlers;
`tests/test_synced_input_journal.cpp` walks the generated
`EnumValuesClientPayload()` so a verb added to `protocol.fbs` without a
classification fails a test.

**Not recorded, deliberately:** commands the sim gives itself — factory exit
rally, `StatisticalCombat` retaliation, `WaitCommandsAI`, `LuaSyncedCtrl`
`GiveCommand` from a gadget callin. Those are *consequences*; re-execution
reproduces them, and recording them would double-apply. AI output *is* recorded:
the AI VM runs on its own threads and which tick its commands land on is not part
of the synced state.

Storage is pluggable (`IJournal`). The default is `NullJournal` — the funnel still
classifies and counts, and `GET /api/journal` (loopback) reports the tallies.
`--journal-audit [N]` attaches a bounded in-memory journal; `--journal-file <path>`
attaches `replay::Writer`, which is the durable/shareable form. PLAN-persistence's
journal implements the same `IJournal` seam. The lobby's `--replay-dir <dir>`
gives every game server it spawns a `--journal-file <dir>/room-<id>-p<port>.msr`,
so a deployment records whole matches without per-room configuration; it is off
by default.

### Replay re-execution

`--replay <file>` runs the tick above with the funnel **inverted**: at each of the
five phases the server asks `replay::Feed()` what was due and re-enters the same
code paths with the recorded input. `rts/Server/ReplayFile.{h,cpp}` owns the
container (magic + version + codec byte + JSON header + marker-framed blocks +
trailer, where the block kinds are records, state-hash points, checkpoint-index
entries, the embedded start checkpoint and the game's outcome — an unknown marker
is a named hard error, which is the seam future sections attach to, and the
outcome block is what that seam is for: adding it left every `.msr` already on
disk readable, because a reader that knows a marker and does not find it is
simply looking at an older file); `rts/Server/ReplayPlayer.{h,cpp}`
owns the cursor, seek state and hash verification, both engine-free and
doctest-covered. A live recording is always uncompressed so a torn tail stays
salvageable; `--replay-export` repacks a finished segment through zlib (the
format reserves a zstd codec value that this tree does not link). The checkpoint
sections are format-complete but carry no bytes: the blobs are PLAN-persistence's
`ISimSerializer` output, which is unbuilt. `server_main.cpp` feeds phases 1–3 and the anchor;
`StateStreamer::TickAI` feeds phase 4 itself, because its position relative to
standing-order evaluation inside the streamer tick is load-bearing.

Three invariants the implementation depends on, each of which was a real bug first:

- **Feed at the journal's tick stamp, never a fresh `sim.GetFrameNum()`.**
  `SimFrame()` runs mid-tick, so by the LuaExec and Stream phases the sim's counter
  has already passed the frame this tick's records were stamped with.
- **The pre-game prologue is fed where the recording's own GameStart fired**, and
  only its pre-`SimFrame` phases. With no human roster that is during start-up:
  the frame counter starts at −1 and the first `SimFrame()` makes it 0, so a
  recording that started the game during set-up entered its loop one sim-step
  ahead of a replay that did not. With a roster it is on the first loop tick,
  because the live run fired GameStart from `CheckAndFireGameStart` once the last
  human authenticated — which is *after* AI slot resolution. Feeding such a
  prologue during start-up authenticates the humans before the AI virtual players
  exist and lands the team leaders on different players.
- **Streaming suppression (seek) cuts the transport, not the streamer.**
  `StateStreamer::Tick` issues commands as well as bytes, so muting it would change
  the simulation.

Replayed wire messages re-enter under their recorded connection id offset into a
reserved range (`replay::VirtualClientId`) so they cannot collide with a live
spectator's transport id.

**Identity during a re-execution comes from the stream, not the database.** An
`AuthRequest` is the one recorded verb whose effect depends on state the replay
does not have: turning a session token or a password into (account id, username,
role) is a query against `users`/`sessions`, and a replica DB need not carry
either — a campaign replayed later is asking about a token that has expired by
construction. So every successful auth also records an `InputKind::AuthIdentity`
entry (`syncedinput::AuthIdentity`, keyed on the connection id), and a replayed
`AuthRequest` reads that instead of touching `db`. `Player::Load` indexes the
entries up front rather than consuming them in stream order — the answer
necessarily *follows* the question in the stream but is needed *while* the
question is re-asked — and feeding one is a documented no-op. The DB-derived half
(account id, username, role) is authoritative; the launch-spec-derived half (team,
player number) is re-derived and compared, and a mismatch stops the replay the
same way the GameStart roster check does. `Handshake` is journaled for the same
reason: it is the C1 gate that decides whether an `AuthRequest` is admissible at
all, so a stream without it cannot re-enter its own authentications.

**A live client on a replay server is a spectator, enforced three ways.** The
inbound gate refuses every recordable verb from a non-virtual client, exempting
only `Handshake` and `AuthRequest` — without those two nothing could authenticate
and nothing could watch. On top of that the auth path forces `team = -1` and
`role = spectator` regardless of the account, ignores the client's `--player`
roster membership for GameStart (the recorded GameStart record is the only thing
allowed to start a replayed game), and takes the player number from a reserved
constant range (`replay::kSpectatorPlayerNumBase`) rather than `nextPlayerNum`,
which the recorded auths cross-check against. Third and least obvious: a replay
spectator is **not registered in `playerHandler`**, so it never appears in
`Spring.GetPlayerList()`. A disjoint player number keeps the replay's own
bookkeeping consistent but says nothing about synced Lua, and gadgets do not
agree about spectators — Metalstorm's `game_authority.lua` grants an authority
pool per player in its GameStart roster loop *without* filtering them, while
`game_teams.lua` filters. The consequence is that a spectator has no roster row
and no `clientPlayerNum` entry, so the `LuaUIMsg` relay (which resolves both ends
through those) drops its messages on a replay server.

**Playback controls are their own wire class, not a console verb.** Pause,
speed, seek and POV change the *playback* — which frame the recorded feed is
at, how fast it advances, whose fog is rendered — and none of that is an input
to the simulation. Routing them through `ConsoleCommand`, which is what "ride
the existing debug-console verbs" would have meant, was not possible: that verb
is classified `Synced`, the class the replay gate refuses from live clients by
construction, and widening the gate would have admitted arbitrary Lua to a
re-executing sim. So `ClientPayload::ReplayControl` is classified **`Ignored`**
— never journaled (a recorded "pause" would replay at whoever watched next) and
dropped outright on a live server — and is handled only while
`replay::IsReplaying()`. The policy behind it is pure and lives in
`replay::ControlDeck` (`rts/Server/ReplayControlDeck.h`): **the first spectator
to attach drives, and control passes to the longest-attached survivor when the
driver leaves**, so a cast whose host closes their tab does not freeze for
everyone else. POV is deliberately outside that rule — it is per-client state
(`ClientSession::spectatorVisibilityMode/Team`, read by `StateStreamer` at five
sites and, until this landed, written by nothing at all).

Applying an accepted decision is a three-line translation: pause is `gs->paused`
(the sim-loop gate already skips `SimFrame` on it, and with the frame frozen the
feed's cursor pops nothing), speed is `gs->wantedSpeedFactor` — a replay in
`Mode::Play` paces from `computeTickInterval()` rather than the headless run
config for exactly this reason — and seek is `Feed().SetSeekTarget()`. Neither
pause nor speed can fork the re-execution: the state hash folds unit digests and
the RNG, not pacing. **A backward seek is refused, not served**: seek is "load
the nearest checkpoint ≤ target and fast-forward", nothing writes checkpoint
blobs until PLAN-persistence's sim serializer lands, and the record cursor is
monotonic — so there is no way back, and the refusal says so rather than
no-op'ing. The server broadcasts `ServerPayload::ReplayState` per client (POV
and controller are per-client answers) on every landed control and on a 1 s
wall-clock heartbeat; **a live game never sends one, and that absence is the
client's entire mode signal** — the playback bar mounts on the first one it
receives.

### Replay browsing

The lobby serves what it recorded. `POST /api/replays/list` returns a row per
`.msr` in `--replay-dir` and `POST /api/replays/watch {file}` spawns a
`spring-server --replay` for one; both 404 when the flag is unset. (POSTs for a
read because `HttpGetHandler` never receives an Authorization header, so
NetworkServer degrades every non-Public GET to loopback-only.) Listing goes
through `replay::LoadSummary`, which walks the block framing and **skips**
payloads rather than materialising every `Record` the way `Load` does, and
counts blocks itself instead of trusting the trailer — which is what lets it
report a duration for a *truncated* recording, i.e. for exactly the crashed
servers an operator most wants to watch. A requested filename is resolved by
matching it against the directory listing rather than by concatenation, so
there is no path string to defeat, and an unreadable file is refused before the
fork (a replay server handed one exits immediately, and the room it left behind
would read as a crashed game).

**A replay is served as an ordinary room**, and that is the load-bearing
decision rather than an implementation shortcut: a room is already the only
thing that carries a `game_server_port` to a browser and the only thing whose
lifecycle kills a server when the last person leaves. `roomToJson` gains one
field (`replay_file`); everything else about entering a game is the path a
player already takes. Three behaviours follow without being written — casting
is `JoinRoom` (a second caller for a file already being watched joins the
existing room instead of spawning a rival server, which is how the control
deck's driver/succession rule became reachable from the lobby), a cast ends on
the existing `Abandoned` branch, and the health loop **deletes** a replay room
whose server exited instead of calling `ResetRoomForNextGame` on it, because a
recording has no next game.

**A start frame is a control, never a launch option.** `--replay-seek` exists
and the lobby does not use it: with no checkpoints the launch-time seek is an
uncapped fast-forward from frame 0 during which the server does not service its
QUIC connections, so a watcher's handshake goes unanswered long enough for the
transport to time out, and it reconnects as a client the control deck no longer
recognises as the driver. The `?watch=<file>&frame=N` deep link therefore sends
an ordinary `ReplayControl::Seek` once attached. The same stall is still
reachable from the playback bar on a long recording; checkpoints are the fix.

### Def + Model Loading
```
Lobby startup: GameProcessor converts <game>/objects3d/*.s3o → data/games/<id>/models/*.glb
Entity streaming: server sends GameUnitDefs (incremental, per-client, only new defIds)
Projectile streaming: server sends GameWeaponDefs (incremental, per-client, only new defIds)
Client: DefCache accumulates defs → EntityRenderer.setUnitDefs() (additive batches)
Client: DefCache → ProjectileRenderer.setWeaponDefs() (per-type mesh + material)
Model loading: SceneLoader.ImportMeshAsync per defId → thin instances
Squad defs:   the sim body is not drawn; SquadRenderBackend draws the members
              (near: real model → far: impostor sprite; no atlas: model at all
               ranges; neither model nor atlas: proxy capsule)
Fallback: procedural shapes (box/cylinder/cone/sphere) when no .glb exists
```

Defs are streamed on-demand: the server tracks `knownUnitDefs` and `knownWeaponDefs`
per ClientSession and sends each def exactly once per game session, just before the
first entity/projectile state update that references it.

**Missing models degrade silently by design, so the server names them loudly.**
`LuaDefsSerializer::SerializeOneUnitDef` emits `model_url` only when
`models/<objectname>.gltf` exists; otherwise it emits `""` and the client falls
back to a procedural shape (or, for a squad def with no impostor atlas either,
the proxy capsule). Nothing in
that chain is an error, which is how a scenario can be mostly placeholders with
a clean log. `FindDefsWithMissingModels` closes the hole: once per defs bake the
server logs a WARNING naming every def whose `objectname` resolves to no `.gltf`
and which is not `impostor_only` (that flag means "the billboard IS the model" —
infantry/civilians per PLAN-metalstorm-beta-units.md §2.1, so a missing file is
correct for them). Covered by `tests/test_defs_missing_models.cpp`.

## Weapon / Projectile Rendering Strategies (target model)

> **Status:** design/target. Today the engine is effectively **Sim** for every
> weapon (the server owns projectile state; Fired/Impact/Trajectory events drive
> the client). **Mixed** and **Client** are not implemented yet, and the exact
> wire format depends on the in-progress *client-server over-sharing reduction*
> plan (another workstream) — **do not implement concretely until that lands.**
> This section records the intended architecture so weapon-FX work plans toward it.

**Goal:** offload most projectile/beam *rendering* decisions to the client so the
server need not stream per-frame projectile positions/velocities. The server sends
only the *unknowable* events a client can't predict — shield deflections,
nuke/anti-nuke interception, chaff / re-targeting, and other game-rules outcomes —
while the client predicts the deterministic trajectory itself. This cuts the
dominant per-frame bandwidth (thousands of projectiles) to event-only traffic.

**A per-weapon `weaponDef` field selects the strategy** (three values):

1. **`sim`** (legacy / most faithful). The server simulates the projectile fully
   and the client renders from server-authoritative state. Recoil's projectile
   Lua queries (`Spring.GetProjectilePosition` / `GetProjectileVelocity` / etc.)
   resolve against **server** state. Highest fidelity, highest bandwidth (per-frame
   streaming). **Opt-in for heavy-hitters** where the exact authoritative path
   matters and is worth the cost: artillery, ballistic missiles, nukes.

2. **`mixed`** (new — **default for most weapons**). The server sends the **Fired**
   event (weapon def, start pos, target/dir) plus the *unknowable* events above.
   The client **computes the trajectory locally** from the weapon def (speed,
   gravity, tracking, beamTTL…) — the same deterministic math Recoil's sim runs —
   and renders from its own prediction, correcting on server events (hit here,
   deflected there). Recoil's projectile Lua queries resolve against the
   **client's** predicted projectile state (no server round-trip). For beams the
   Fired event already carries `from`/`to`, so the client has both endpoints
   immediately. Balanced: faithful-enough (client replicates Recoil's projectile
   integration) while eliminating per-frame streaming. Would not change visible
   behaviour for ZK/BAR-style trajectory combat.

3. **`client`** (new — future games only). No server-synced projectile state; the
   client owns the entire weapon path from assumptions/RNG. Reserved for future
   games where combat *outcomes* are decided by RNG rather than a real assessment
   of projectile trajectories/collisions. **Breaks** trajectory-based games like
   Zero-K and BAR, so it is never their default.

**How the projectile Lua API behaves per strategy.** Recoil's unsynced projectile
queries are the seam. The client maintains projectile representations for rendering
in every mode; the engine routes `Spring.GetProjectilePosition` /
`GetProjectileVelocity` (note: for **beam**-type projectiles `GetProjectileVelocity`
is overloaded to return the beam **endpoint delta**, not a velocity) / `GetProjectileDefID`
to either server-streamed state (`sim`) or client-predicted state (`mixed`/`client`).
This lets ZK's own projectile-FX widgets/gadgets (e.g. `gfx_projectile_lights.lua`,
LUPS emitters) run **unchanged in the LuaUI worker** against whichever state the
weapon's strategy provides — the faithful path for projectile lighting, trails, and
particle FX, rather than hardcoded client stand-ins.

**Allowance (called out):** ZK's projectile lights feed a **GL4 deferred** renderer
that WebGL2 can't run; the *data and behaviour* (per-weapon `customParams.light_*`,
beam-length segment lights, `beamTTL` fade) stay faithful, but the *rendering tech*
is substituted with the forward-light pool (`fx-light-pool.ts`) — a GL4→WebGL2
substitution, not a behavioural change.

## Current Status (2026-05-04)

**Stable end-to-end loop:** lobby → create room → start game → fight → game-over → return to lobby. Player disconnect handling: server detects the peer/data-channel close, fires `PlayerRemoved` Lua callin, broadcasts `PlayerLeft` to remaining clients, cleans up session. Default engine gadget ends the game when no humans remain.

**Transport:** HTTP/2 (h2c via nghttp2) + HTTP/1.1 on the same port (REST/SSE/assets); game-state streaming runs over **WebTransport (QUIC/HTTP-3)** on UDP at the same port number (GW1–GW3 landed; PLAN-game-worker.md, PLAN.md Stage 0). WebRTC removed from the game path. The IPC pipe and `--event-fd` are gone; a game→lobby backchannel (PLAN-lobby-game-connection.md) is **not yet implemented** (TODO) — when built it targets WebTransport.

**Active work areas (April–May 2026):**
- **KTX2 / Basis Universal texture pipeline** (PLAN-textures.md): every GPU texture (units, features, terrain, minimap) is now `.ktx2` (UASTC + Zstd). KTX2 transcoder URLs are pinned in `client/src/main.ts` lines 8–35 against intermittent CDN fallbacks.
- **Build animation** (PLAN-build-anim.md): translucent build beams via `core/build-beam-renderer.ts` + per-tick build progress in `core/build-activity.ts`. Most subsystems landed; nano-spray polish ongoing.
- **LuaUI Web Worker** (PLAN-widgets.md): `core/lua-widget-worker.ts` hosts Fengari Lua + OffscreenCanvas; `core/lua-widget-manager.ts` owns lifecycle on the main thread; `core/command-buffer.ts` transfers `gl.*` calls back to the renderer.
- **Chili UI integration** (memory: `project_chili_rendering.md`): ortho/font/dlist fixes done, render test widget (`?widgetTest`) confirms gl bridge primitives. Post-DrawScreen still draws invisible — under investigation.
- **Zero-K conversion** (PLAN-convert-zk.md): Phase A done — 197/236 gadgets boot, sim ticks at 30 Hz, commanders spawn from `start_unit_setup.lua`. Open: model multi-mesh polish, minimap orientation, full LuaUI parity.
- **Coordinate system** (PLAN-coordinate-system.md, surface in [docs/coordinate-system.md](docs/coordinate-system.md)): Phases 1–3 complete. Pipeline + engine + wire + Babylon client all speak glTF-native RH (+X right, +Y up, −Z forward); games shipping LH-authored Lua content opt in via `legacyCoordSystem = true` in `modinfo.lua`, which routes every coord-touching Lua callout through `rts/Lua/LuaCoordAdapt.h` (server) and a closure-captured `flipZ` / `gl.*` matrix flip in `lua-spring-api.ts` / `lua-gl-bridge.ts` (client). One mechanical `grep` retires the bridge once no game needs it.
- **Order system Phase 0** (PLAN-orders.md, 2026-05-12): expanded `UnitCmdDesc` to carry the full Spring command-description surface (name/action/texture/tooltip/type/params/hidden), added `SelectionState` (client→server) so the server scopes per-tick cmd-desc broadcasts to the player's selection, added `PlayerCommandBatch` schema (no emitter yet). Widget worker now dispatches `SelectionChanged`/`UnitCreated`/`UnitDestroyed`/`CommandNotify` (widget-issued orders only). New `Spring.*` helpers: `GetHeadingFromVector`, `GiveOrderArrayToUnitArray`, `Get/SetBuildSpacing`. **Next:** `LayoutButtons` callback, client-side `Spring.TestBuildOrder`, animated cursor pipeline, mouse-issued `CommandNotify` route-through-worker, server-emitted `UnitFinished`/`UnitFromFactory`/transport/selfd/stockpile/armored events.

**Debugging infrastructure (complete; surface documented in [docs/debugging.md](docs/debugging.md)):**
- Unified logging (`libspringlog`) with console/file/network/SQLite sinks
- Dedicated `spring-logserver` (ring buffer + SQLite + HTTP query API + SSE live stream)
- Browser debug console with log streaming, scope-aware command input, network inspector
- Lua execution engine (LuaRules/LuaGaia/server scopes via ConsoleCommand)
- Lua debugger with breakpoints, stack/locals inspection, step/continue
- `Spring.Debug` / `Warn` / `Assert` / `DumpTable` / `Inspect` Lua API
- SQL query proxy, process management API, game session tracking
- MCP server for Claude integration (`tools/debug-mcp`)
- Performance profiling: per-phase FrameProfiler (`window.test.perfDump()`), per-widget LuaUI cost profiler (`uiProfileStart/Dump/Stop`), network-condition simulator (`netSim*`/`netStats`), and server-side sim-thread profiling (`server sim profile`/`server lua profile` console verbs, `rts/Server/SimFrameProfiler.h` + `rts/Lua/LuaCallInProfiler.h`) — see [docs/debugging-performance.md](docs/debugging-performance.md)
- **Test framework** (`window.test` + `.claude/skills/spring-test`): instant game launch (`launch_game` MCP tool), scripted spawn/kill/damage/order verbs, camera focus on a unit, render-loop pause + screenshot, runtime debug-flag toggles for combat/sound/weapon emission. See `client/src/core/test-harness.ts` and `rts/Server/DebugFlags.h`.

**Not yet wired:** server-side AI plugin runtime (skeleton in `Server/AI/` exists but plugins don't boot reliably), spectator mode, Glicko-2 ratings, persistent world layer. GameOver → `MusicStateTracker::ForceState(victory|defeat)` hook is the only audio gap — the rest of the pipeline (state machine, MusicEvent broadcast, client crossfader) is live.
