# Spring RTS Web

A fork of the [Spring RTS](https://springrts.com/) game engine redesigned around a client-server architecture. The server runs the full game simulation; the browser client sends player commands and receives game state filtered by fog-of-war and viewport. This replaces the original peer-to-peer model to support an MMORTS (Massively-Multiplayer Online Real-Time Strategy) playable entirely in a web browser.

## Current Status

The game is technically playable end-to-end: lobby &rarr; create room &rarr; start game &rarr; fight &rarr; game-over &rarr; return to lobby.

However the bundled demo game doesn't have any units yet and the AI doesn't do much anyway

Porting existing Spring (Recoil) games like Zero-K and BAR is a work in progress.

As a result this is pre-alpha code, interesting to play with but not actually a game yet.

**Working features:**

- Server sim at 30 Hz, entity state streaming with delta compression
- Real `.glb` unit models loaded via FlatBuffer defs + thin instances (fallback: procedural shapes)
- Map feature rendering (glb models, thin-instanced)
- Full lobby flow (rooms, AI slots, start positions, team assignment, game-over)
- Minimap (detachable window), HUD, quit-to-lobby, game-over overlay
- Combat events, projectile streaming, weapon def delivery
- Lua gadget scripting system (LuaRules + LuaGaia)
- Server-side AI runtime pool
- Debug console, log server with SSE streaming, network inspector

## Architecture

```
┌─────────────────┐    WebRTC (→ WebTransport)     ┌──────────────────────┐
│  Browser Client  │◄─────────────────────────────►│    spring-server     │
│  TypeScript +    │   FlatBuffers + custom binary  │  Headless C++ sim    │
│  Babylon.js      │                                │  30 Hz tick rate     │
└─────────────────┘                                └──────────────────────┘
        │                                                    ▲
        │  HTTP (lobby, assets, auth)                        │ spawned per room
        ▼                                                    │
┌─────────────────┐                                ┌──────────────────────┐
│  spring-lobby    │────────────────────────────────│  spring-logserver    │
│  HTTP/2 + SSE    │         log ingest             │  SQLite + SSE        │
│  Room management  │                               │  Log collection      │
└─────────────────┘                                └──────────────────────┘
```

**Server (C++):** Three executables &mdash; `spring-lobby` (HTTP lobby, map/game preprocessing, spawns game servers), `spring-server` (headless game sim, one per active room), and `spring-logserver` (centralized log collection and query).

**Client (TypeScript):** Babylon.js on WebGL 2 for rendering. HTML/CSS UI layered over the canvas. Fengari Lua runtime for map widgets. Web Audio for sound.

**Protocol:** Binary frames with a `u8` envelope byte: `0x01` FlatBuffers messages, `0x02`/`0x03` entity state (full/delta), `0x05` piece state, `0x06` build activity, `0x07` LOS bitmap, `0x08` decals, `0x09` heightmap. All custom binary uses struct-of-arrays layout. Carried over WebRTC data channels today; migrating to WebTransport-only in the game-processor worker (PLAN-game-worker.md).

## Building

### Prerequisites

- CMake 3.25+, Ninja
- C++20 compiler (Clang 15+ or GCC 13+)
- Node.js 18+ and npm
- ImageMagick (for map texture conversion)

### Quick Start

```bash
make setup        # cmake --preset debug + npm install + generate protocol bindings
make build        # build spring-server + spring-lobby + spring-logserver
make dev-client   # Vite dev server on :5173
```

### Import games and maps

Use the converters in tools/ to import existing spring content or the demo in content/games/papertanks/ . Games and maps need to be extracted to a directory for import (converter doesn't read archives yet)

```bash
# Import a map
 ./build/debug/mapconverter /path/to/your/map
 # import a game
 ./build/debug/gameconverter content/games/papertanks
```

### Running

Start the lobby server:

```bash
./build/debug/spring-lobby --port 8011 --maps content/maps --games-dir content/games
```

In another terminal, start the client dev server:

```bash
cd client && npm run dev
```

Or both at once with reasonable presets:

```
mprocs
```

Open `http://localhost:8012` in a browser. Log in, create a room, add AI players, and start the game.

### Protocol Bindings

After editing `schemas/protocol.fbs`, regenerate bindings:

```bash
# TypeScript
build/debug/_deps/flatbuffers-build/flatc --ts --gen-object-api \
  -o client/src/protocol/ schemas/protocol.fbs

# C++
build/debug/_deps/flatbuffers-build/flatc --cpp -o rts/ schemas/protocol.fbs
```

## Repository Layout

```
rts/                        C++ server source
  lobby_main.cpp            Lobby server entry point
  server_main.cpp           Game server entry point
  logserver_main.cpp        Log server entry point
  Server/                   Networking, serialization, room management, content processing
  Sim/                      Simulation: units, weapons, movement, pathfinding, features
  Lua/                      Lua scripting (LuaRules, LuaGaia, synced API)
  System/                   Logging (libspringlog), scripting framework, utilities

client/src/                 TypeScript browser client
  main.ts                   App entry point
  core/                     Connection, rendering, input, camera, audio, entity management
  lobby/                    Lobby UI (login, rooms, game setup)
  ui/                       HTML/CSS UI components (HUD, overlays, debug console)
  protocol/                 Generated FlatBuffers bindings

schemas/protocol.fbs        FlatBuffers protocol definition
content/games/              Game source content (Lua defs, models, textures)
content/maps/               Map source content (SMF heightmaps, configs, widgets)
data/                       Preprocessed runtime data (generated at startup)
tools/modelimporter/        S3O/FBX/OBJ to glb model converter (Assimp-based)
libspringapi/               Standalone C++ client library (HTTP + WebRTC + FlatBuffers)
docs/                       Developer documentation (API reference, debugging, caching)
```

## Game Development

Spring RTS Web is a game _engine_. Gameplay is defined by _games_ &mdash; bundles of Lua scripts and assets. The bundled demo game is **Paper Tanks** (`content/games/papertanks/`).

Game authors write Lua gadgets that run server-side in response to engine events (unit creation, damage, game start, etc.). The full synced API (`Spring.*` functions) is available for creating units, issuing commands, modifying terrain, and more. See [ARCHITECTURE.md](ARCHITECTURE.md) for the gadget writing guide and API reference.

## Engine Development

Building the new engine from the Spring RTS base has been greatly accelerated using Claude Code. This project is open to developers but AI coding is part of the process. The engine includes useful MCP servers and Claude skills to improve AI debugging.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** &mdash; File map, data flow, build commands, HTTP routes, scripting system
- **[docs/api.md](docs/api.md)** &mdash; HTTP API reference (auth, rooms, exec, logs, WebRTC signaling)
- **[docs/api-spec.yaml](docs/api-spec.yaml)** &mdash; OpenAPI 3.1 machine-readable spec
- **[docs/debugging.md](docs/debugging.md)** &mdash; Logging, debug console, Lua debugger, network inspector
- **[docs/caching.md](docs/caching.md)** &mdash; Build stamps, asset versioning, cache tiers

## License

Spring RTS Web is open source. See [LICENSE](LICENSE) for details.

## Contact

- **SpliFF** &lt;spliff@warriorhut.org&gt;
- Discord: spliff9999
