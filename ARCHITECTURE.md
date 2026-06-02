# Architecture Reference

Quick-reference for navigating the codebase. Read this before searching.

## Build Commands

```
make setup              # cmake --preset debug + npm install + generate protocol
make build              # cmake --build build/debug (spring-server + spring-lobby)
make dev-client         # npm run dev (Vite dev server on :5173)
npx vite build          # production client bundle → client/dist/
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
`--port`, `--game`, `--game-version`, `--map`, `--db`, `--log-file`, `--log-level`, `--log-server`, `--log-sqlite`, `--debug`, `--no-cache`, `--log-messages`, `--player username:team:pos` (repeatable), `--ai id:team:pos` (repeatable). The IPC pipe and `--event-fd` are gone; a game→lobby backchannel (PLAN-lobby-game-connection.md) is **not yet implemented** (TODO — targets WebTransport when built).

## Directory Map

### Server C++ (`rts/`)

| File | Purpose |
|------|---------|
| `server_main.cpp` | Game server entry. Auth (registers CPlayer), message dispatch, disconnect handling (fires PlayerRemoved callin), sim loop, entity streaming, win detection. |
| `lobby_main.cpp` | Lobby entry. Room management, game/map preprocessing, child process spawning, HTTP routes. |
| `Server/Simulation.h/.cpp` | Initialises Spring subsystems, ticks physics/units/weapons/features each frame. |
| `Server/NetworkServer.h/.cpp` | HTTP/2 (h2c via nghttp2) + HTTP/1.1 server (REST/SSE/assets only). Realtime game traffic now runs over WebTransport (`WebTransportServer`), not WebRTC. Send/broadcast helpers. |
| `Server/WebTransport/WebTransportServer.h/.cpp` | **WebTransport (QUIC/HTTP-3) game transport** — Stage 0 replacement for WebRTC (PLAN-game-worker.md). ngtcp2 + nghttp3 + OpenSSL 3.5 QUIC TLS. Full stack landed + Chrome-verified (GW1-H3): QUIC handshake (ephemeral ECDSA-P256 self-signed cert, `CertHash()` for `serverCertificateHashes`), hand-rolled HTTP/3 framing + nghttp3 standalone QPACK, WebTransport draft-02 extended-CONNECT + stream/datagram demux (`0x54` uni / `0x41` bidi / quarter-stream-id). Mirrors the WebRTCServer seam + adds `StreamClass` priority tiers. QUIC stack is a **hard build dependency** (no WebRTC fallback). Echo-test it with `spring-quic-derisk serve <port>`. |
| `Server/Protocol.h` | FlatBuffers message builders (BuildAuthResponse, BuildMapData, BuildGameUnitDefs, etc.). |
| `Server/EntityStateSerializer.h/.cpp` | Serialises unit state to Tier 2 binary (struct-of-arrays, field-masked). |
| `Server/ProjectileStateSerializer.h/.cpp` | Serialises synced weapon projectiles to envelope 0x04 binary. |
| `Server/EntityDeltaCache.h/.cpp` | Per-client delta tracking to reduce bandwidth. |
| `Server/ContentServer.h/.cpp` | Scans content roots, serves assets at `/api/content/assets/*`. |
| `Server/Database.h/.cpp` | SQLite wrapper (accounts, sessions). |
| `Server/RoomManager.h/.cpp` | Room lifecycle (create/join/leave/start/end), player rosters. |
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
| `core/game-worker-protocol.ts` | **Frozen GW4 message contract** (PLAN-game-worker.md): the game-processor worker ⇄ main-thread interfaces (`Gp*ToWorker` init/input/config, `Gp*ToMain` sceneState/audio/config/gameOver). Source of truth the worker-consolidation cut (GW4-c1…c6) builds against. No runtime behaviour yet. |
| `core/entity-renderer.ts` | Per-piece thin-instanced unit renderer. Loads `.glb` via `setUnitDefs()`, groups by (defId, team, pieceIdx). Fallback: procedural shapes. |
| `core/feature-renderer.ts` | Single-mesh thin-instanced map feature renderer. Pattern reference for entity-renderer. |
| `core/projectile-renderer.ts` | Renders in-flight projectiles (thin instances, per-weapon-type shapes). |
| `core/build-beam-renderer.ts` | Translucent build-beam shader (procedural cross-section) for nano-spray VFX. |
| `core/build-activity.ts` | Per-tick build progress wiring; nanoframe state. |
| `core/build-menu.ts` | In-game build menu UI (unit selection panel). |
| `core/economy-bar.ts` | Resource bar HUD (metal/energy income/storage). |
| `core/combat-fx.ts` | Explosion/impact VFX on combat events. |
| `core/perf-overlay.ts` | Frame-rate / draw-call overlay (toggleable). |
| `core/def-cache.ts` | Accumulates incrementally streamed unit + weapon defs; notifies renderers. |
| `core/defs-fetch.ts` | HTTP fallback fetch of game/map defs (used during early load and recovery). |
| `core/entity-state.ts` | Parses Tier 2 binary snapshots (struct-of-arrays with field mask). |
| `core/entity-interpolator.ts` | Smooths entity positions between server ticks. |
| `core/projectile-state.ts` | Parses envelope `0x04` binary projectile snapshots. |
| `core/piece-state.ts` | Parses streamed piece transforms (turret rotation, walk cycles, etc.). |
| `core/clock.ts` | Sim-tick clock + interpolation timing. (`clock.test.ts` covers it.) |
| `core/terrain.ts` | Builds terrain mesh from heightmap uint16 array. |
| `core/terrain-texture.ts` | Streams the KTX2 terrain texture(s) and binds them onto the terrain mesh. |
| `core/rts-camera.ts` | Orbital pan/zoom/rotate camera with viewport updates. **GW4-c5b**: now DOM-free and runs **inside** the game-processor worker (one per view, keyed by viewId); input arrives via intent methods, not DOM events. |
| `core/camera-input.ts` | **GW4-c5b**: thin main-thread DOM-input owner. Captures pointer/wheel/key on `#game-canvas` and forwards canvas-relative CSS-pixel intents to the worker camera as `gp:*` messages tagged with `viewId` (multi-view). |
| `core/input-manager.ts` | Click-to-select (ray cast), right-click-to-command, drag-box select, keyboard shortcuts. **GW4**: the *full-feature* main-thread input manager (build placement, waypoint/area-attack drag, modal hotkeys, animated cursors). Its **selection/pick/order core** was ported DOM-free into the worker as `worker-selection.ts` (c5b-2); the rich placement/modal features still await a worker port. |
| `core/worker-selection.ts` | **GW4-c5b-2**: DOM-free selection / pick / order core in the game-processor worker. Left-button single-click + drag-box select (screen-space projection of entity positions), right-click move/attack/guard (team-aware), hover tracking. Sends orders over the worker's own WebTransport connection (no main hop); posts the drag-box rectangle to main (`gp:dragBox`) for the overlay div. Per-view picking via `getCamera(viewId)`; selection set shared. |
| `core/minimap.ts` | Minimap canvas with entity dots, click-to-pan, detachable popup window. **GW4-c5c-3**: `entityRenderer` is now optional — in the game-processor split the minimap runs on main (own Babylon Engine) but the entity set lives in the worker, so it renders from the `gp:minimapFeed` blips via `applyFeed` (the in-process path, e.g. the detached viewport, is unchanged). Click-to-pan posts `gp:focusWorld` → worker camera. |
| `core/audio.ts` | `AudioManager`: 96-voice HRTF pool, five Recoil-parity channel buses (General / Battle / UnitReply / UserInterface / BGMusic) with strict-greater-priority per-channel eviction, master `ConvolverNode` for map reverb, dual-HTMLAudioElement music crossfader, SoundItem ingest + resolution, persisted channel/master volume. |
| `core/sound-events.ts` | `SoundEventPlayer`: resolves server `SoundEvent` → `SoundRef.name` → SoundItem → URL chain, applies per-play gain/pitch random offsets, routes to AudioManager on the channel the server tagged. |
| `core/music-director.ts` | Subscribes to `MusicEvent`s, picks a random track from the per-state playlist (built from `music_<state>_<n>` SoundItems), crossfades via AudioManager. Gates start on a single `arm()` call from main.ts. |
| `core/synth-sounds.ts` | Procedural fallback for combat-fx when no real asset is reachable. |
| `core/map-data.ts` | Parses MapData FlatBuffer into `ParsedMapData` (heightmap, features, tiles, URLs). |
| `core/lua-runtime.ts` + `core/fengari.d.ts` | Shared Fengari Lua 5.1 runtime. Type definitions. |
| `core/lua-spring-api.ts` | Client-side `Spring.*` API surface (read-only sim queries, draw helpers). |
| `core/lua-gl-bridge.ts` + `lua-gl-immediate.ts` + `lua-gl-font.ts` | Lua `gl.*` bridge: command buffer, immediate-mode primitives, font/text rendering. |
| `core/lua-widget.ts` | Lua widget definition + lifecycle wrapper. |
| `core/lua-widget-host.ts` | Fengari host for map-side widgets (lava, water shaders). |
| `core/lua-widget-worker.ts` | LuaUI Web Worker entry: Fengari + OffscreenCanvas, runs widgets off the main thread (PLAN-widgets.md). **GW4 (c1–c4 + c5a landed)**: also the game-processor worker — on `gp:init` owns the Babylon `Engine` on the transferred `#game-canvas`, the WebTransport `Connection` + decoders, the terrain + lighting, the entity-renderer + def-cache + presentation-clock (units stream → interpolate → render from the worker), and (c5a) the weapon-FX / projectile / decal / build render modules (projectile + ceg runtime, fx-light-pool, distortion, muzzle-flare, combat-fx, build-beam, decal-overlay, feature-renderer) aged in the render loop at the sim-scaled FX delta. **c5b-1** adds the interactive RTS camera per view (DOM-free `rts-camera.ts` driven by `gp:*` input from the main-thread `camera-input.ts`; `gpViewCameras` map keyed by viewId for multi-view). **c5b-2** adds worker-side selection/pick/orders (`worker-selection.ts`): left-button click + drag-box select, right-click move/attack/guard sent over the worker's own connection, drag-box overlay posted to main. **c5b-3** adds the selection-driven order overlays (command-path / waypoint-marker / standing-order renderers) fed by `onUnitCommandQueues` + `onStandingOrders` + the worker selection set; shift-gated, with the standing-order show-allies localStorage pref lifted to main via `gp:config`. **c5c-1** adds the `gp:sceneState` feed (~10 Hz) → the HTML HUD (entity count / frame / selection / speed-pause). **c5c-2** adds the audio bridge: the worker resolves each SoundEvent's SoundRef against its def cache and posts `gp:audioSoundEvents` (+ `gp:audioMusic`) → main's AudioManager/SoundEventPlayer/MusicDirector (listener pose from the sceneState camera). **c5c-3** adds the minimap feed (`gpPostMinimapFeed` ~6 Hz → `gp:minimapFeed`: struct-of-arrays unit blips with fog filtered producer-side, the LOS bitmap when fresh, map dims + backdrop URL on the first feed → main-thread `Minimap`) + the `gfx.*` config push (worker seeds clientSettings from the `gp:init` snapshot before lighting builds, restores the FX-gating block, and applies live `gp:config` via `clientSettings.set` → notify) + `gp:focusWorld` (minimap click → worker camera). **c6-1a** boots the Fengari/chili LuaUI host on the **same** Babylon GL context (`init()` takes an optional `sharedGl` = `(gpEngine as any)._gl`; `gpBootLuaUI` at the end of `gpLoadMap` runs the full bootstrap; `gpRunUiPass` runs the screen-space `DrawScreen` pass after `scene.render()` with GL state save/restore + `wipeCaches`, no color-clear) — chili screen-space UI composites over the world. Remaining: c6-1b (feed the Lua runtime from the worker's own defs/selection/lifecycle/gameFrame/input) + c6-2 (world-space `DrawWorld` pass, delete `worldGLCommands`) — pending (PLAN-game-worker.md). |
| `core/lua-widget-manager.ts` | Main-thread owner of the worker: lifecycle, message routing, input forwarding, VFS proxy. |
| `core/widget-manager.ts` | Higher-level widget orchestration (load order, enable/disable, debug toggles). |
| `core/command-buffer.ts` | Serialised `gl.*` command buffer transferred from worker to main-thread renderer. |
| `core/script-api.ts` | JavaScript scripting API surface (alongside Lua). |
| `core/log-ingest.ts` | Forwards client logs to the log server. |
| `core/renderer-backend.ts` | Backend abstraction (currently WebGL via Babylon.js; placeholder for future WebGPU). |
| `core/debug-console.ts` | Debug console: log viewer, scope-aware command input, log server WS, Babylon.js inspector toggle. |
| `core/test-harness.ts` | `window.test` runtime API: spawn/kill/damage/order verbs through `/api/exec`, camera focus on a unit, render-loop pause, screenshot capture, debug-flag toggles. Paired with `.claude/skills/spring-test`. |
| `core/net-inspector.ts` | Network message inspector: decodes WS envelope + FlatBuffer types for debug console. |
| `lobby/lobby-ui.ts` | Full lobby UI: login, room browser, room setup, AI slots, start positions. |
| `ui/ui.ts` | Shared helpers: `injectStyle()`, `renderTemplate()`. |
| `ui/game/loader.ts` | In-game template loader: `GameTemplates` interface, bundled defaults, `loadGameTemplates()` fetcher. |
| `ui/lobby/loader.ts` | Lobby template loader: `LobbyTemplates` interface, bundled defaults, `loadGameLobbyTemplates()` fetcher. |
| `ui/hud/hud.html+css` | In-game HUD (entity count, selection, quit button). |
| `ui/quit-confirm/` | Quit confirmation overlay. |
| `ui/game-over/` | Game over results overlay. |

### Protocol (`schemas/protocol.fbs`)

**Wire format:** Every binary frame (over WebTransport — PLAN-game-worker.md) starts with `u8 envelope`:
- `0x01` = FlatBuffers (root: ServerMessage or ClientMessage)
- `0x02` = Entity state full snapshot (custom binary)
- `0x03` = Entity state delta (custom binary)
- `0x04` = Projectile state snapshot (custom binary)

**Key server→client messages:** AuthResponse, MapData, GameUnitDefs, GameWeaponDefs, EntityCreate, EntityDestroy, GameEventBatch (CombatEvents, projectile fired/impacts/trajectories, SoundEvents, SeismicPings, MusicEvents), GameInfo, RoomStateUpdate, RoomListUpdate, LogBatch, ConsoleResponse, GameStarted, UnitCommandQueuesUpdate (own + allied team order queues, ~1 Hz), UnitCmdDescsUpdate (selection-scoped command panel data — name/action/texture/tooltip/type/params/hidden per cmd, ~1 Hz).

**Key client→server messages:** AuthRequest, PlayerCommand, PlayerCommandBatch (schema only, no emitter yet — for atomic build-row / INSERT+REMOVE pairs), SelectionState (debounced 50ms; scopes server's cmd-desc broadcast), ViewportUpdate, RoomCreate/Join/Leave/Ready/StartGame/EndGame, RoomAddAI/RemoveAI, LuaRulesMsg, LogIngest, LogSubscribe, LogUnsubscribe, ConsoleCommand.

**Order plumbing (PLAN-orders.md):** Selection mirroring is one of two budget controls — `SelectionState` scopes the per-tick `UnitCmdDescsUpdate` to the player's current selection rather than every own-team unit, and the same set will eventually scope future selection-only streams. `UnitCmdDesc` carries the full Spring `SCommandDescription` surface so ZK's integral menu and `cmd_*.lua` widgets see real button names, icons, tooltips, and current-state-index params. `PlayerCommandBatch` exists in the schema for atomic multi-command sequences (waypoint drag, build-row drag) — neither client emitter nor server handler is wired yet.

**IPC:** Pipe-based IPC removed. The lobby↔game backchannel (e.g. GameStarted) is **not yet implemented** — `Simulation.cpp` carries a `TODO(Tier 2)` for it; when built it targets WebTransport (PLAN-game-worker.md), not WebSocket/WebRTC.

**Transport:** All HTTP endpoints support both HTTP/2 (h2c, cleartext) and HTTP/1.1. Game state streaming runs over **WebTransport (QUIC/HTTP-3)** via `WebTransportServer` (GW1–GW3 landed; PLAN-game-worker.md, PLAN.md Stage 0). The client discovers the endpoint via `GET /api/wt/info`. WebRTC is **fully removed** (GW7): `WebRTCServer.{h,cpp}`, libdatachannel, and the `/api/rtc/*` signaling are gone; `libspringapi` no longer links libdatachannel (`connectRtc` is an inert stub pending a WebTransport port). The remaining migration (GW4) relocates the connection + render core into the game-processor worker — c1–c4 + c5a + c5b (camera/selection/orders/overlays) + c5c (c5c-1 sceneState→HUD, c5c-2 audio bridge, c5c-3 minimap feed + gfx config push) + c6-1a (LuaUI boots on the shared GL context, screen-space chili over the world) landed; c6-1b (feed the Lua runtime from the worker's own sources) + c6-2 (world-space DrawWorld pass) pending.

Generated bindings:
- C++: `rts/protocol_generated.h`
- TypeScript: `client/src/protocol/spring-web/*.ts`

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
- `TeamDied`, `PlayerChanged`, `PlayerAdded`, `PlayerRemoved`

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
| **Game control** | `GameOver({winningAllyTeams})`, `KillTeam(teamId)`, `AssignPlayerToTeam(playerId, teamId)` | `GameOver` fires the `GameOver` callin then signals game end |
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
  spring-server.db          SQLite (accounts, sessions, maps table)
  maps/<mapId>/             Preprocessed: heightmap.bin, minimap.dxt1, tiles.dxt1, features/*.glb
  games/<gameId>/models/    Preprocessed: <unit>.glb, <unit>.config.json, <texture>.png
  games/<gameId>/sounds/    Preprocessed: *.webm (Opus, audioconverter output)
```

## HTTP Routes

### Lobby (`spring-lobby`)

| Route | Serves |
|-------|--------|
| `/api/maps` | JSON list of all maps (metadata from DB) |
| `/api/maps/source/<mapId>/*` | Raw map source files (Lua, images) |
| `/api/maps/data/<mapId>/*` | Preprocessed map assets (heightmap, tiles, feature models) |
| `/api/maps/thumb/<mapId>` | Map thumbnail (WebP/PNG) |
| `/api/vfs/game/<gameId>/*` | Game source files (Lua scripts, images) |
| `/api/games/data/<gameId>/*` | Preprocessed game assets (unit models, textures) |
| `/api/processes` | JSON list of game server instances (pid, port, state, map, game) |

### Game server (`spring-server`)


| Route | Serves |
|-------|--------|
| `/api/map/info` | JSON map dimensions |
| `/api/map/heightmap` | Binary heightmap |
| `/api/maps` | JSON available maps |
| `/api/metrics` | JSON performance stats |
| `/api/content/manifest` | JSON index of all servable assets |
| `/api/content/assets/*` | Individual asset files from content roots |
| `/api/wt/info` | JSON `{port, certHash, transport}` — WebTransport (QUIC) endpoint discovery; the client pins the dev cert via `serverCertificateHashes`. Replaces the removed `/api/rtc/offer` + `/api/rtc/candidate` WebRTC signaling. |

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
Client → lobby WS: AuthRequest (login)
Client ← lobby WS: AuthResponse + RoomListUpdate
Client → lobby WS: RoomCreate / RoomJoin
Client → lobby WS: RoomReady / RoomStartGame
  Lobby spawns spring-server subprocess
  Sim boots, loads defs + map + gadgets (GameStart NOT yet fired)
  Server waits for all --player roster entries to authenticate
Client ← lobby WS: RoomStateUpdate (state=Loading, game_server_port=N)
Client → game WS:  AuthRequest (token reconnect)
Client ← game WS:  AuthResponse + MapData
  (repeat for each player in roster)
  All roster players connected → FireGameStart()
    → gadgets spawn starting units (start_unit_setup.lua)
    → IPC pipe → GameStarted
Client ← lobby WS: RoomStateUpdate (state=Active)
```

### Gameplay Loop
```
Server: sim ticks at 30Hz
Server → client (10Hz): Tier 2 binary entity state (envelope 0x02/0x03)
Server → client: FlatBuffers GameEventBatch (combat events)
Client → server: PlayerCommand (move, attack, stop)
Client → server: ViewportUpdate (camera position/zoom)
Client: interpolates entities between ticks, renders via Babylon.js
```

### Def + Model Loading
```
Lobby startup: GameProcessor converts <game>/objects3d/*.s3o → data/games/<id>/models/*.glb
Entity streaming: server sends GameUnitDefs (incremental, per-client, only new defIds)
Projectile streaming: server sends GameWeaponDefs (incremental, per-client, only new defIds)
Client: DefCache accumulates defs → EntityRenderer.setUnitDefs() (additive batches)
Client: DefCache → ProjectileRenderer.setWeaponDefs() (per-type mesh + material)
Model loading: SceneLoader.ImportMeshAsync per defId → thin instances
Fallback: procedural shapes (box/cylinder/cone/sphere) when no .glb exists
```

Defs are streamed on-demand: the server tracks `knownUnitDefs` and `knownWeaponDefs`
per ClientSession and sends each def exactly once per game session, just before the
first entity/projectile state update that references it.

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
- **Test framework** (`window.test` + `.claude/skills/spring-test`): instant game launch (`launch_game` MCP tool), scripted spawn/kill/damage/order verbs, camera focus on a unit, render-loop pause + screenshot, runtime debug-flag toggles for combat/sound/weapon emission. See `client/src/core/test-harness.ts` and `rts/Server/DebugFlags.h`.

**Not yet wired:** server-side AI plugin runtime (skeleton in `Server/AI/` exists but plugins don't boot reliably), spectator mode, Glicko-2 ratings, persistent world layer. GameOver → `MusicStateTracker::ForceState(victory|defeat)` hook is the only audio gap — the rest of the pipeline (state machine, MusicEvent broadcast, client crossfader) is live.
