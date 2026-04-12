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
| `spring-lobby` | `rts/lobby_main.cpp` | HTTP + WebSocket lobby server. Manages rooms, spawns game servers, preprocesses maps/games at startup. |
| `spring-server` | `rts/server_main.cpp` | Headless game sim. One per active room, spawned by lobby as a child process. Runs sim at 30Hz, streams entity state. |

### spring-lobby CLI

```
./spring-lobby --port 8080 --maps content/maps --games-dir content/games
```

### spring-server CLI

```
./spring-server --port 9001 --game content/games/papertanks --map content/maps/wanderlust2.1 \
  --player "alice:0:0" --player "bob:1:1" --ai "basic_ai:2:-1" --event-fd 5
```

## Directory Map

### Server C++ (`rts/`)

| File | Purpose |
|------|---------|
| `server_main.cpp` | Game server entry. Auth, message dispatch, sim loop, entity streaming, win detection. |
| `lobby_main.cpp` | Lobby entry. Room management, game/map preprocessing, child process spawning, HTTP routes. |
| `Server/Simulation.h/.cpp` | Initialises Spring subsystems, ticks physics/units/weapons/features each frame. |
| `Server/NetworkServer.h/.cpp` | uWebSockets server. WebSocket + HTTP on same port. Send/broadcast helpers. |
| `Server/Protocol.h` | FlatBuffers message builders (BuildAuthResponse, BuildMapData, BuildGameUnitDefs, etc.). |
| `Server/EntityStateSerializer.h/.cpp` | Serialises unit state to Tier 2 binary (struct-of-arrays, field-masked). |
| `Server/EntityDeltaCache.h/.cpp` | Per-client delta tracking to reduce bandwidth. |
| `Server/ContentServer.h/.cpp` | Scans content roots, serves assets at `/api/content/assets/*`. |
| `Server/Database.h/.cpp` | SQLite wrapper (accounts, sessions). |
| `Server/RoomManager.h/.cpp` | Room lifecycle (create/join/leave/start/end), player rosters. |
| `Server/MapProcessor.h/.cpp` | SMF parsing, heightmap/minimap/feature extraction, model conversion. |
| `Server/GameProcessor.h/.cpp` | Scans `objects3d/`, converts S3O→glb via modelimporter, converts textures. |
| `Server/CombatEventCollector.h/.cpp` | Hooks DoDamage, collects hit/miss/kill events for broadcast. |
| `Server/ClientSession.h` | Per-client auth state, team, viewport. |
| `Server/LobbyIpc.h/.cpp` | Sim→lobby pipe: sends GameStarted when sim boots. |
| `Server/AI/AIRuntimePool.h/.cpp` | Pool of Lua AI runtimes, one per AI player. |
| `Server/AI/AIDiscovery.h/.cpp` | Scans `content/engine/ai/` + game ai dirs for plugins. |

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
| `main.ts` | App entry. Lobby init, `startGame()`, render loop, HUD wiring. |
| `config.ts` | Server URL, API base paths. |
| `core/connection.ts` | WebSocket to server. FlatBuffers dispatch. Events: `onMapData`, `onUnitDefs`, `onEntityState`, `onCombatEvents`, etc. |
| `core/entity-renderer.ts` | Renders units. Preloads .glb models via `setUnitDefs()`, thin-instances by (defId, team). Fallback: procedural shapes. |
| `core/entity-state.ts` | Parses Tier 2 binary snapshots (struct-of-arrays with field mask). |
| `core/entity-interpolator.ts` | Smooths entity positions between server ticks. |
| `core/feature-renderer.ts` | Loads map feature .glb models, thin-instances by type. Pattern reference for entity-renderer. |
| `core/terrain.ts` | Builds terrain mesh from heightmap uint16 array. |
| `core/rts-camera.ts` | Orbital pan/zoom/rotate camera with viewport updates. |
| `core/input-manager.ts` | Click-to-select (ray cast), right-click-to-command, drag-box select, keyboard shortcuts. |
| `core/minimap.ts` | Minimap canvas with entity dots, click-to-pan, detachable popup window. |
| `core/combat-fx.ts` | Explosion/impact VFX on combat events. |
| `core/audio.ts` | Web Audio: synth sounds for combat, background music. |
| `core/map-data.ts` | Parses MapData FlatBuffer into `ParsedMapData` (heightmap, features, tiles, URLs). |
| `core/lua-widget-host.ts` | Fengari Lua runtime for map widgets (lava, water shaders). |
| `lobby/lobby-ui.ts` | Full lobby UI: login, room browser, room setup, AI slots, start positions. |
| `ui/hud/hud.html+css` | In-game HUD (entity count, selection, quit button). |
| `ui/quit-confirm/` | Quit confirmation overlay. |
| `ui/game-over/` | Game over results overlay. |

### Protocol (`schemas/protocol.fbs`)

**Wire format:** Every WebSocket frame starts with `u8 envelope`:
- `0x01` = FlatBuffers (root: ServerMessage or ClientMessage)
- `0x02` = Entity state full snapshot (custom binary)
- `0x03` = Entity state delta (custom binary)

**Key server→client messages:** AuthResponse, MapData, GameUnitDefs, EntityCreate, EntityDestroy, GameEventBatch (contains CombatEvents), GameInfo, RoomStateUpdate, RoomListUpdate.

**Key client→server messages:** AuthRequest, PlayerCommand, ViewportUpdate, RoomCreate/Join/Leave/Ready/StartGame/EndGame, RoomAddAI/RemoveAI.

**IPC (sim→lobby pipe):** GameStarted (triggers Loading→Active room transition).

Generated bindings:
- C++: `rts/protocol_generated.h`
- TypeScript: `client/src/protocol/spring-web/*.ts`

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

### Game server (`spring-server`)

| Route | Serves |
|-------|--------|
| `/api/map/info` | JSON map dimensions |
| `/api/map/heightmap` | Binary heightmap |
| `/api/maps` | JSON available maps |
| `/api/metrics` | JSON performance stats |
| `/api/content/manifest` | JSON index of all servable assets |
| `/api/content/assets/*` | Individual asset files from content roots |

## Data Flow

### Auth + Game Start
```
Client → lobby WS: AuthRequest (login)
Client ← lobby WS: AuthResponse + RoomListUpdate
Client → lobby WS: RoomCreate / RoomJoin
Client → lobby WS: RoomReady / RoomStartGame
  Lobby spawns spring-server subprocess
  Sim boots → IPC pipe → GameStarted
Client ← lobby WS: RoomStateUpdate (state=Active, game_server_port=N)
Client → game WS:  AuthRequest (token reconnect)
Client ← game WS:  AuthResponse + MapData + GameUnitDefs
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

### Model Loading
```
Lobby startup: GameProcessor converts <game>/objects3d/*.s3o → data/games/<id>/models/*.glb
Game auth: server sends GameUnitDefs (defId → /api/games/data/<id>/models/<stem>.glb)
Client: EntityRenderer.setUnitDefs() → SceneLoader.ImportMeshAsync per defId → thin instances
Fallback: procedural shapes (box/cylinder/cone/sphere) when no .glb exists
```

## Current Status (2026-04-12)

Playable end-to-end: lobby → create room → start game → fight → game-over → return to lobby.

**Next tasks (PLAN-next-steps.md follow-ups):**
1. Server-side "player left mid-game" — PlayerLeave protocol message + handler
2. Projectile asset pipeline (unit models done, projectiles remain)
3. Runtime game-override UI templates
