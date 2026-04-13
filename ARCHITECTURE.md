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
| `server_main.cpp` | Game server entry. Auth (registers CPlayer), message dispatch, disconnect handling (fires PlayerRemoved callin), sim loop, entity streaming, win detection. |
| `lobby_main.cpp` | Lobby entry. Room management, game/map preprocessing, child process spawning, HTTP routes. |
| `Server/Simulation.h/.cpp` | Initialises Spring subsystems, ticks physics/units/weapons/features each frame. |
| `Server/NetworkServer.h/.cpp` | uWebSockets server. WebSocket + HTTP on same port. Send/broadcast helpers. |
| `Server/Protocol.h` | FlatBuffers message builders (BuildAuthResponse, BuildMapData, BuildGameUnitDefs, etc.). |
| `Server/EntityStateSerializer.h/.cpp` | Serialises unit state to Tier 2 binary (struct-of-arrays, field-masked). |
| `Server/ProjectileStateSerializer.h/.cpp` | Serialises synced weapon projectiles to envelope 0x04 binary. |
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
| `core/def-cache.ts` | Accumulates incrementally streamed unit + weapon defs; notifies renderers. |
| `core/entity-state.ts` | Parses Tier 2 binary snapshots (struct-of-arrays with field mask). |
| `core/entity-interpolator.ts` | Smooths entity positions between server ticks. |
| `core/feature-renderer.ts` | Loads map feature .glb models, thin-instances by type. Pattern reference for entity-renderer. |
| `core/terrain.ts` | Builds terrain mesh from heightmap uint16 array. |
| `core/rts-camera.ts` | Orbital pan/zoom/rotate camera with viewport updates. |
| `core/input-manager.ts` | Click-to-select (ray cast), right-click-to-command, drag-box select, keyboard shortcuts. |
| `core/minimap.ts` | Minimap canvas with entity dots, click-to-pan, detachable popup window. |
| `core/projectile-state.ts` | Parses envelope 0x04 binary projectile snapshots. |
| `core/projectile-renderer.ts` | Renders in-flight projectiles (thin instances, per-weapon-type shapes). |
| `core/combat-fx.ts` | Explosion/impact VFX on combat events. |
| `core/audio.ts` | Web Audio: synth sounds for combat, background music. |
| `core/map-data.ts` | Parses MapData FlatBuffer into `ParsedMapData` (heightmap, features, tiles, URLs). |
| `core/lua-widget-host.ts` | Fengari Lua runtime for map widgets (lava, water shaders). |
| `lobby/lobby-ui.ts` | Full lobby UI: login, room browser, room setup, AI slots, start positions. |
| `ui/ui.ts` | Shared helpers: `injectStyle()`, `renderTemplate()`. |
| `ui/game/loader.ts` | In-game template loader: `GameTemplates` interface, bundled defaults, `loadGameTemplates()` fetcher. |
| `ui/lobby/loader.ts` | Lobby template loader: `LobbyTemplates` interface, bundled defaults, `loadGameLobbyTemplates()` fetcher. |
| `ui/hud/hud.html+css` | In-game HUD (entity count, selection, quit button). |
| `ui/quit-confirm/` | Quit confirmation overlay. |
| `ui/game-over/` | Game over results overlay. |

### Protocol (`schemas/protocol.fbs`)

**Wire format:** Every WebSocket frame starts with `u8 envelope`:
- `0x01` = FlatBuffers (root: ServerMessage or ClientMessage)
- `0x02` = Entity state full snapshot (custom binary)
- `0x03` = Entity state delta (custom binary)
- `0x04` = Projectile state snapshot (custom binary)

**Key server→client messages:** AuthResponse, MapData, GameUnitDefs, GameWeaponDefs, EntityCreate, EntityDestroy, GameEventBatch (contains CombatEvents), GameInfo, RoomStateUpdate, RoomListUpdate.

**Key client→server messages:** AuthRequest, PlayerCommand, ViewportUpdate, RoomCreate/Join/Leave/Ready/StartGame/EndGame, RoomAddAI/RemoveAI.

**IPC (sim→lobby pipe):** GameStarted (triggers Loading→Active room transition).

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

## Current Status (2026-04-12)

Playable end-to-end: lobby → create room → start game → fight → game-over → return to lobby.
Player disconnect handling: server detects WebSocket close, fires `PlayerRemoved` Lua callin, broadcasts `PlayerLeft` to remaining clients, cleans up session. Default engine gadget ends game when no humans remain.

All tasks from PLAN-next-steps.md are complete. Current work: Zero-K game support (PLAN-convert-zk.md).

**ZK Phase A complete:** 197/236 gadgets boot, sim ticks at 30Hz. GameStart deferred until all roster players connect (game gadgets handle unit spawning, not the engine). Next: runtime testing with connected clients.
