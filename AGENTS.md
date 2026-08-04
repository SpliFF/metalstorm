# Spring RTS Web

A fork of the Spring RTS game engine redesigned around a client-server split. The server runs the full game simulation; the browser client sends player events and receives game state updates filtered to what each player is allowed to see and do. This replaces the original peer-to-peer architecture to support an MMORTS (Massively-Multiplayer Online Real-Time Strategy) playable and spectatable entirely via a web browser.

## Core Goal — Faithful Recoil Reproduction (read this first)

The goal of this development is to create an engine in **C++ and TypeScript that faithfully runs the Lua code for games written for the Recoil Engine** (a Spring RTS fork). We _do_ want to make allowances where a faithful reproduction wouldn't work due to the client-server model or browser limitations (e.g. WebGL2 vs. GL4).

When implementing a feature:

- **Avoid custom implementations.** Respect the intentions of the game authors — reproduce what Recoil's engine + the game's Lua/widgets/gadgets actually do, driven by the game's own data (weapon defs, `customParams`, CEGs, LUPS, widget configs), not by hardcoded approximations.
- **If a faithful reproduction is impractical** (i.e. because it would generate excessive network overhead or exceed WebGL2 capabilities), **stop and discuss — provide options.** Don't silently substitute a custom version.
- **Never deviate from Recoil silently.** If a custom implementation is unavoidable or chosen, **call it out explicitly** (in the response, the code comments, and the relevant PLAN/memory) so the divergence is visible and revisitable.

The reference Recoil source is checked out read-only at `/Users/shannon/WarriorHut/Projects/RecoilEngine/` — consult it to confirm the faithful behaviour before writing a substitute.

## Claude Instructions

- **Read [ARCHITECTURE.md](ARCHITECTURE.md) at the start of every new context session** before searching the codebase. It contains the file map, data flow, build commands, HTTP routes, and current status — enough to navigate without exploratory searches.
- Use cheaper / faster models and parallel agents for larger cleanup and search tasks
- **Browser automation: use `mcp__chrome-devtools__*` tools only.** Never use `mcp__claude-in-chrome__*` — mixing them spawns a separate browser window and breaks page context.
- **Wakeup/poll intervals: cap `ScheduleWakeup` at 120 s.** Chain shorter polls rather than scheduling one long sleep.
- **PLAN-\*.md and AGENTS.md exist only in the main checkout** — they're gitignored, so git worktrees don't have them. Always read/edit them at the main repo path.
- There are no existing games for this engine. Backwards compatibility is not important. Some capacity to use existing Spring engine assets is kept but not at the expense of extra complexity or hacks.
- Don't try to commit PLAN-\*.md or AGENTS.md updates. They are ignored globally in Git. ARCHITECTURE.md _is_ committed — update it when making structural changes.
- Active work is ordered by **[PLAN.md](PLAN.md)** (rev 2026-07-02: goal hierarchy, binding Work pattern + Code-session contract, Current queue with per-milestone model tags). Three active tracks: [PLAN-perf.md](PLAN-perf.md) (performance recovery + the Lua→native porting queue), [PLAN-bar.md](PLAN-bar.md) §7 (BAR LuaUI HUD repair — Track U queue at the top of §7), [PLAN-playable.md](PLAN-playable.md) (playable full games for BAR + ZK, the gate for all Stage-7/Metalstorm work). Completed/superseded plans live in `PLAN-archive/` (incl. the previous master as `PLAN-rendering-drive.md`).
- Detailed learnings about implemented subsystems live in the relevant **PLAN-\*.md** files (content pipeline → PLAN-content.md, LuaUI worker → PLAN-archive/PLAN-widgets.md + ARCHITECTURE.md, etc.). Only the stable architecture lives in this file. Completed tactical plans are moved under `PLAN-archive/`.
- **Developer documentation** lives in `docs/`:
  - **[docs/api.md](docs/api.md)** — HTTP API reference: auth, rooms, exec, logs, WebTransport discovery (`/api/wt/info`), springcli usage. The primary API documentation.
  - **[docs/api-spec.yaml](docs/api-spec.yaml)** — OpenAPI 3.1 machine-readable spec for all HTTP endpoints
  - **[docs/debugging.md](docs/debugging.md)** — Hub page (quick start, architecture). Split into: **[debugging-logging.md](docs/debugging-logging.md)** (libspringlog, log server, sessions), **[debugging-console.md](docs/debugging-console.md)** (browser debug console, Lua debug API, interactive debugger, Babylon inspector), **[debugging-tools.md](docs/debugging-tools.md)** (SQL proxy, process management, Claude/MCP, springcli, mprocs), **[debugging-performance.md](docs/debugging-performance.md)** (FrameProfiler `perfDump`, LuaUI widget profiler `uiProfileStart/Dump/Stop`, network simulator `netSim*`/`netStats`)
  - **[docs/maps/generation.md](docs/maps/generation.md)** — The terragen procedural map pipeline (erosion/rivers/biomes/roads/vegetation), gameplay-contract enforcement, texturing model, new-map recipe. Companion: [docs/maps/meridian-basin.md](docs/maps/meridian-basin.md) (layout design).
  - **[docs/caching.md](docs/caching.md)** — Build stamps, `--no-cache` flag, asset URL versioning, cache tiers, troubleshooting
  - **[docs/javascript.md](docs/javascript.md)** — Browser JS API (`window.lobby`, `window.debugConsole`): lobby actions, game setup, state inspection, automation recipes
  - **[docs/lighting.md](docs/lighting.md)** — Sun + ambient + HDR + cascaded shadows: pipeline, caster registration, the thin-instance-matrix-packing trap, live-tuning hooks
  - **[docs/deployment.md](docs/deployment.md)** — Production deployment checklist: SPRING_PROD build, reverse proxy, WebTransport/QUIC cert provisioning (`--wt-cert`/`--wt-key`, hourly auto-reload, `SIGHUP` full-restart fallback), SQLite backup, content-loader hardening (G11/G21)
- **[libspringapi/](libspringapi/)** — Standalone client library for tools/lobbies. HTTP + FlatBuffers (WebRTC game-connect removed in GW7; `connectRtc` is an inert stub pending a WebTransport port). Own CMake, builds independently. Python bindings with `-DSPRINGAPI_PYTHON=ON`.
- **Upstream reference: RecoilEngine** — the ZK-flavoured Spring fork our codebase derives from is checked out at `/Users/shannon/WarriorHut/Projects/RecoilEngine/`. Use it to look up behaviour we deleted in Phase-0 cleanup (rendering, audio, AI ABI), reference Lua post-processors (`cont/base/springcontent/gamedata/*.lua`), or compare WeaponDef/UnitDef parsing. **Read-only** — never edit it; just consult.

## Current Status (2026-07-02)

The Phase 0–2 cleanup/foundation work is complete. Phase 3 (combat) and Phase 4 (scripting/AI) are partly in place: server combat works end-to-end, server-side LuaRules/LuaGaia and a client-side LuaUI runtime are running, the audio pipeline streams server SoundEvents through a 96-voice HRTF pool. The whole client game path (network + 3D render + LuaUI) runs in one game-processor worker over WebTransport (Stage 0, merged 2026-06-03). Both ZK and BAR boot and run; **neither is yet a playable full game** — the BAR LuaUI HUD is partly broken and rendering performance has regressed. Active focus ([PLAN.md](PLAN.md) rev 2026-07-02): performance recovery (PLAN-perf.md), BAR HUD repair (PLAN-bar.md §7), and the playable-full-game gate (PLAN-playable.md).

**What works (stable):**

- Server sim at 30 Hz, entity state streaming, projectile streaming (envelope `0x04`), combat events, fog-of-war
- Real `.glb` unit models loaded via on-demand `GameUnitDefs` + per-piece thin instances (fallback: procedural shapes)
- Map feature rendering (`.glb`, thin-instanced)
- Full lobby flow (rooms, AI slots, start positions, team assignment, end-game, player disconnect → `PlayerRemoved` Lua callin)
- Minimap (with detachable window), HUD, build menu, economy bar, quit-to-lobby, game-over overlay
- HTTP/2 (h2c via nghttp2) + HTTP/1.1 on the same port. Game traffic over WebTransport (QUIC/HTTP-3); WebRTC removed (GW7).
- Unified logging (libspringlog) + dedicated `spring-logserver` + browser debug console + Lua execution engine + Lua debugger + MCP server (`tools/debug-mcp`)

**Active work (July 2026 — [PLAN.md](PLAN.md) owns the queue):**

- **Track P — performance recovery** ([PLAN-perf.md](PLAN-perf.md)): measured baseline first, then ranked fixes (terrain decal-plugin fragment cost, DecalOverlay RTT re-bakes, FxLightPool StandardMaterial tax, per-draw uniform churn, LuaUI GL-state tax, deformable-terrain uploads). Hosts the Lua→native porting queue (N-track).
- **Track U — BAR LuaUI HUD repair** ([PLAN-bar.md](PLAN-bar.md) §7): worker camera-pose/viewMatrix producer gap, magenta icon root-cause, remaining widget crashers, def `.sounds` shape.
- **Track G — playable full games** ([PLAN-playable.md](PLAN-playable.md)): seven-step playable definition; ZK regression sweep, GameOver winners on the wire, worker build-placement/input port, ZK Phase D UI completeness, piece-transform/turret aim; ends in the G6 full-game verification gates.
- **Deferred by directive (2026-07-02):** non-immersion-breaking shader/lighting/FX-fidelity work (weapon-fx gaps, GL4 substitutions, BAR light routing), latency Stage 6, all Stage-7 platform + Metalstorm work — see the PLAN.md Deferred ledger. The Stage-7 gate is now concrete: PLAN-playable G6a + G6b + PLAN-perf P7 green.

## Repository layout (quick reference)

- `rts/` — C++ server code. Two executables:
  - **`spring-lobby`** — lobby/HTTP server, map preprocessing, spawns game servers. Entry: `rts/lobby_main.cpp`. Sources listed explicitly in `CMakeLists.txt` (not globbed).
  - **`spring-server`** — headless game sim. Entry: `rts/server_main.cpp`. Sources globbed from `rts/Server/*.cpp`, `rts/Sim/*.cpp`, etc.
- `client/src/` — TypeScript/Babylon.js browser client. Entry: `main.ts`. Two WebSocket connections per session: lobby (persistent) + game (per-room, module-level `gameConn`).
- `client/src/ui/<component>/` — UI templates as `.html` + `.css` files, imported via Vite `?raw`. See [ARCHITECTURE.md](ARCHITECTURE.md) "Client TypeScript" section for the full layout.
- `tools/modelimporter/` — standalone CLI built on upstream Assimp v6.0.4 with custom importer plugins for S3O and Warzone 2100 `.pie` (`S3OImporter.{h,cpp}`, `PIEImporter.{h,cpp}`). Supports all Assimp-readable 3D formats (OBJ, FBX, COLLADA, BLEND, 3DS, LWO, STL, PLY, glTF, etc.) plus S3O and PIE. Called by `FeatureProcessor` via `popen()`. Path plumbed through CMake as `MODELIMPORTER_BINARY_PATH`. Synced sim never links Assimp — it reads a sibling `<model>.meta.lua` file the tool emits alongside the `.glb`.
- `schemas/protocol.fbs` — FlatBuffers schema. Regenerate TS bindings via `Makefile`'s `make client-protocol` or `build/debug/_deps/flatbuffers-build/flatc --ts --gen-object-api -o client/src/protocol/ schemas/protocol.fbs`.
- `content/maps/*` — source map directories. Preprocessed outputs land in `data/maps/<id>/` (heightmap, minimap, features, etc.). Schema version bumps (`MAP_FORMAT_VERSION` in `MapProcessor.h`) trigger full reprocessing on next lobby start.
- `data/spring-server.db` — SQLite db (accounts, sessions, maps table). Schema probe in `MapProcessor::EnsureTable` queries the newest-added column to detect stale schemas.

## Architecture

Spring RTS is a game _engine_. The actual mechanics and design of gameplay is handled by _games_. Games are a bundle of Lua scripts and assets. They are typically managed seperately from the engine. Other external content includes _maps_, _widgets_ (gameplay or UI changing scripts) and _AI_ which are game addons that can also be shipped with a game or seperately.

The goal is to separate rendering, animation, and player scripting ("unsynced" Lua code) from the engine, leaving only the game simulation ("synced" code) on the server. Synced and unsynced parts communicate over WebSocket.

Some cleanup should be done if legacy model loading paths remain in the engine. Everything should load via Assimp. The loaded models should be passed "as needed" to clients over the network ("as needed" meaning when a unit is first encountered. Use WebGL model/texture loading on the frontend)

The server only needs to run headless. Anything related to rendering should be removed. Anything to do with game setup or in-game UI happens via the network but as it's now a client-server model anything that does direct render to screen (like loading screens, menus) should be removed entirely and replaced. Logging should be done via file logs, sqlite table and a websocket stream. An admin interface and in-game console are needed.

The game supports some privileged actions like "console commands". These should be exposed over the network but gated behind a permissions system. Roles are server admin, game admin, player and spectator. Server should use SQLlite for storage of accounts and configuration.

AI is supported as two distinct types:

- Server-side acts as a player or performs game-related automation (ie, NPC factions, environment)
- Client-side acts as a player assistant.

Both types access the game via the "unsynced" code and are limited to actions a player can perform and data a player is allowed to see. There is no "synced" AI. The Spring Engine supports synced AI but this code needs to be removed and/or converted to unsynced.

The engine should consider options for multi-host setups where units can move from one server to another via map borders or portals. This is a future aspiration but should be allowed for in the design. Server should be heavily threaded for performance.

**Default behaviour:** Except where this document specifies otherwise, or where an opportunity for cleanup/simplifcation exists, the engine should preserve standard Spring RTS behaviour. These docs describe only the deltas. However the engine does not need backwards-compatibility with any game, it is being build to run new games written from scratch.

### Client (Browser)

- **Rendering:** WebGL
- **Audio:** Web Audio API with a voice pool (64-128 voices) and distance-based priority culling. `PannerNode` for 3D positional audio tied to camera. Pre-decoded `AudioBuffer` cache for SFX; streamed `MediaElementAudioSourceNode` for music. Opus/WebM preferred, AAC/MP4 fallback for Safari. Must resume `AudioContext` on first user interaction (autoplay policy)
- **Scripting:** Fengari Lua 5.1 running in a Web Worker with OffscreenCanvas for unsynced widgets/LuaUI (see [PLAN-widgets.md](PLAN-archive/PLAN-widgets.md)). Server-side LuaRules/LuaGaia run in the C++ Lua **5.4** interpreter (vendored 5.4.7 — `rts/lib/lua/include/lua.h`) on the simulation thread; note this is a different VM and version from the client's Fengari Lua 5.1. A native JS scripting interface runs alongside Lua on the client.
- **Lobby:** Built-in matchmaking and game setup lobby

### Viewports

Clients register one or more **viewports** with the server. Viewports drive what data the server streams to each client.

- **Shape:** 2D top-down rectangles, rotatable around the vertical axis only, any dimensions. May overlap. Must fit within map boundaries — anything outside is cropped by the server.
- **Visibility filtering:** The server returns terrain, squads, events, and sounds within each viewport only if the player is allowed to see them. Visibility rules are game-defined (friendly units in area, stealth, cloaking, jamming, etc.).
- **Zoom-based LOD:** Viewports support zoom. When zoomed far out the server may reduce the data stream — showing only the largest squads or squad icons, and filtering sounds by intensity (e.g. only the loudest explosions). This prevents bandwidth spikes at extreme zoom levels.

### Server

- Runs the full synced game simulation
- Filters and streams game state per-player per-viewport over WebSocket

## Metalstorm

The primary game for this engine is **Metalstorm**, bundled with the engine for ease of packaging and testing. Other games may be supported in the future.

**Design source of truth: [PLAN-metalstorm.md](PLAN-metalstorm.md)** (rev 2026-06-13). Core pillars:

- **Strategy over CPS.** Larger scale than existing Spring games; army planning and missions, not precise unit control. The best strategy wins, never the fastest clicker.
- **Teams own everything.** The game is between teams; players drop in/out mid-game; units and orders belong to the team, not the player — any team player commands any team unit.
- **Objectives are the game.** Strategic AND tactical missions: area/resource control plus story-based types (kill, escort, protection, extraction). Objectives are the only primary income.
- **One resource: authority.** Earned by completing objectives (allocatable to players directly or staked on objectives); spent issuing orders. Order costs are dynamic — unit strength, region control (cheap in friendly territory), order type.
- **Units: 11 classes × 4 scales** (engineers, soldiers, mechs, tanks, artillery, fighters, bombers, ships, subs, static defenses, radar — plus civilians/civilian vehicles). Squad size shrinks as scale grows; scale 4 = single multi-piece super-heavy.
- **Slow, persistent building** — factories take 1+ hour real time, buildings correctly scaled (much larger than Spring's); civilian and military building families.
- **Kinetic sci-fi** — explosive/projectile weapons (autocannons, railguns, howitzers, missiles, torpedoes); minimal lasers.
- **Native game**: lives at `data/games/metalstorm/`, never goes through gameconverter. RH coordinates, JavaScript UI (PLAN-native-ui.md), custom WebGL2 shaders, native asset formats (.glb/.ktx2/.webm).

### Squad-Based Design

The engine focuses on squad and army tactics. The squad is the atomic unit of the simulation:

- **Server (synced):** The simulation only knows squads — not individual troops. A squad has a combined strength, behaviour, and receives orders as a single entity. Combat is resolved at squad level: the whole squad fires together, even when engaging multiple targets. Damage reduces the squad's aggregate strength; Spring RTS supports the concept of larger units with attachment points for weapons. This behaviour should be preserved for squad transport and larger multi-part single units (ie, larger vehicles with independent turrets).
- **Client (unsynced):** May render a squad as multiple individual soldiers for visual fidelity. Individual troop movement, death animations, and physics within the squad are purely cosmetic client-side effects. A damaged squad may show wounded or fallen troops, but this is presentation only — it has no bearing on game state.
- **Orders:** Players can only issue commands to whole squads, never to individual troops within one.

## Project Values

- The engine and Metalstorm are both **open-source**.

## Development Practices

- Commits and PRs may be generated automatically. **Do not** include "Co-Authored-By" or "Made with Claude" tags in commit messages. Just write normal, clean commit messages.
- **Build working features, not scaffolding.** A task lands as connected, functional, verified behaviour — not interfaces, stubs, or wiring that "will be hooked up later".
- **A narrow target is a test vector, not the default.** When a task names one concrete case (one unit, one widget, one game), build the _general mechanism_ and use the named case only to prove it. Before landing, ask: "did this task force a special case into the code?" — if yes, generalise.
- **Client porting gotchas** (Babylon RH basis, `needAlphaBlending`, GLSL comment rules, `luaTable()` marshalling, dead-producer trap) are catalogued in ARCHITECTURE.md § "Client porting gotchas" — read them before writing client rendering or Lua-bridge code.

## Resolved Design Decisions

Decisions that affect multiple plans and must be consistent everywhere:

| Decision                              | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Rationale                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Entity IDs**                        | `u32` everywhere (4 billion IDs). Network protocol, FlatBuffers schemas, and internal data structures all use 32-bit entity IDs. For multi-host, the upper 8 bits encode server-origin (256 servers × 16M entities each).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | u16 (65K) is too small for an MMORTS with projectiles. u32 gives headroom without u64 overhead.                                                                   |
| **Standing order IDs**                | `u32` (same reasoning as entity IDs).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Persistent worlds create/delete orders continuously.                                                                                                              |
| **Build target name**                 | `spring-server` (the executable), built from a CMake target also named `spring-server`. The old name `engine-authority` is retired.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `spring-server` is clearer for developers and documentation.                                                                                                      |
| **Logging**                           | Use **spdlog** as the logging backend. The custom MPSC ring buffer + multi-sink architecture described in PLAN-server.md is built _on top of_ spdlog (spdlog supports custom sinks, async mode with queue). Do not write a logging framework from scratch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | spdlog already has async mode, custom sinks, structured formatting. The server plans describe _what sinks to write to_, not a new logging library.                |
| **streflop**                          | **Remove.** Standard IEEE floating-point is sufficient. The server is authoritative — there is no P2P sync requirement for bitwise-identical FP results. Simplicity wins over theoretical reproducibility.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | streflop restricts the compiler to SSE1-only, prevents optimisations, and adds complexity. Not worth it for a server-authoritative model.                         |
| **creg**                              | **Kept (revised 2026-05-04).** `rts/System/creg/` is retained for sim state save/load and Lua state serialisation. The original Phase 0 plan to remove it was reversed — it's still load-bearing for snapshot serialisation. New code should not depend on creg without good reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Spring's save/load relies on creg metadata across the sim. Replacing it would require reimplementing serialisation for every Sim/\* type.                         |
| **Filesystem code**                   | **Kept (VFS restored, revised 2026-05-04).** `rts/System/FileSystem/` (VFS, archive loaders, scanners) is retained. Mode-aware file resolution is critical infra for layered content roots (engine base + game + map). The Phase 0 removal was reverted; see memory note `feedback_vfs_restore.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                  | Spring games rely on layered VFS lookup (game can override engine base files). Standard `<filesystem>` alone can't express this.                                  |
| **headlessStubs**                     | **Remove.** With rendering code fully deleted (not stubbed), there is nothing to stub. If any sim code still references GL symbols, fix the dependency rather than stubbing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Stubs are a crutch for incomplete separation. Phase 0 should achieve complete separation.                                                                         |
| **Game definitions format**           | **Lua source, parsed by the server at startup.** The server loads `unitdefs.lua`, `weapondefs.lua`, etc. using its embedded Lua 5.4 interpreter (vendored 5.4.7) and builds internal data structures. A JSON export is generated for the client (served via HTTP). Game authors write Lua; clients receive JSON.                                                                                                                                                                                                                                                                                                                                                                                                                     | Lua is the natural authoring format for Spring games. JSON is the natural transport format for browsers. Parse once at startup, serve the result.                 |
| **Protocol versioning**               | Every WebSocket connection begins with a `Handshake` message containing `protocol_version: u16`. Server rejects clients with incompatible versions. FlatBuffers schema evolution (additive fields with defaults) handles minor version differences. Breaking changes increment the version number.                                                                                                                                                                                                                                                                                                                                                                                                                                   | Client may be cached (old JS). Server must reject incompatible clients cleanly.                                                                                   |
| **Message framing**                   | Every WebSocket binary frame starts with a `u8 envelope_type` byte: `0x01` = FlatBuffers message (remaining bytes are a FlatBuffers buffer with the `MessageType` union), `0x02` = Entity state update (remaining bytes are the custom binary struct-of-arrays format). The client dispatches on this first byte.                                                                                                                                                                                                                                                                                                                                                                                                                    | Without an envelope, the client cannot distinguish FlatBuffers from custom binary. One byte of overhead is negligible.                                            |
| **Game speed and tick rate**          | Sim always ticks at a fixed wall-clock rate. `GAME_SPEED` (30) defines sim frames per _game second_. At 1x speed, sim ticks every 33ms. At 2x speed, sim ticks every 16.5ms (two game seconds per wall second). The server adjusts the tick interval, not the tick count per frame. All timing budgets (AI, viewport filtering) are expressed as percentages of the tick interval, not absolute milliseconds.                                                                                                                                                                                                                                                                                                                        | Fixed-tick-per-frame with variable interval is simpler and avoids the complexity of running multiple sim frames per wall tick.                                    |
| **Voice pool size**                   | **96 voices** (canonical number).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Compromise between 64 and 128. Sufficient for RTS; tune later based on profiling.                                                                                 |
| **HTTP/2 + HTTP/1.1 server**          | The server uses **nghttp2** for HTTP/2 (h2c cleartext) with automatic HTTP/1.1 fallback on the same port. Protocol auto-detected from connection preface. HTTP serves REST API endpoints, static assets. WebRTC data channels handle real-time game traffic. SSE (Server-Sent Events) replaces polling for log streaming. Browsers use HTTP/1.1 (h2 requires TLS; use a reverse proxy for browser HTTP/2). C++ clients (libspringapi) use h2c for multiplexed requests.                                                                                                                                                                                                                                                              | nghttp2 is the reference HTTP/2 implementation. Same port, auto-detection. SSE eliminates polling overhead.                                                       |
| **Game transport: WebTransport-only** | Real-time game traffic runs over **WebTransport** (HTTP/3 / QUIC via ngtcp2 + nghttp3); the client discovers the endpoint via `GET /api/wt/info`. **WebRTC is fully removed** (GW7: libdatachannel, `WebRTCServer.{h,cpp}`, STUN, `/api/rtc/*` signaling all deleted; libspringapi's `connectRtc` is an inert stub). The reliable/unreliable channel pair is replaced with **QUIC stream priority tiers** (GW2). GW1–GW3 + GW7 landed; the remaining migration (GW4) runs the connection **inside the game-processor worker** alongside render + Lua. Hard-requires a modern browser. Static assets stay on the HTTP plane (Vite dev / Caddy·nginx·CDN prod); the C++ QUIC endpoint is WebTransport-only, not an HTTP/3 file server. | WebTransport is Baseline 2026 and runs in workers (RTCPeerConnection can't); the client-server model makes WebRTC's P2P/ICE/STUN machinery pure overhead.         |
| **Def delivery (unit + weapon)**      | Defs stream **incrementally on demand**, not eagerly on auth. Server tracks `knownUnitDefs` / `knownWeaponDefs` per ClientSession; before sending entity/projectile state referencing an unknown defId, it sends the def first via `GameUnitDefs` or `GameWeaponDefs` (same FlatBuffer tables, just populated with only the new defs). Each def is sent **exactly once** per game session. Client `DefCache` accumulates defs and notifies `EntityRenderer` (model loading) and `ProjectileRenderer` (per-type visuals). Lobby-served `.glb` URLs at `/api/games/data/{gameId}/models/{stem}.glb`. Thin instances group by `(defId, team)`. Fallback: procedural shapes.                                                             | On-demand streaming avoids sending defs the player may never encounter (fog of war, large unit rosters). Each def sent once — no duplicates, no wasted bandwidth. |
| **Projectile state streaming**        | Synced weapon projectiles stream via envelope `0x04` (custom binary, struct-of-arrays: projectile_id, weapon_def_id, position xyz, direction xyz, team). Full snapshots at ~10 Hz (every 3 ticks), broadcast to all clients. No delta compression — projectiles are short-lived. `ProjectileRenderer` groups by weapon def, renders per-type shapes (sphere/cylinder/cone) with weapon-def colors via thin instances.                                                                                                                                                                                                                                                                                                                | Projectiles move fast and die quickly — deltas would add complexity for little gain. Struct-of-arrays matches entity state format for consistency.                |

## Implementation Plans

Detailed architecture and subsystem plans are documented in PLAN-\*.md files. Below is a summary of each and the recommended implementation order.

### Plan Summary

#### Architecture & foundations (stable references)

| Plan                                         | Scope                                                                                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PLAN-architecture.md](PLAN-architecture.md) | High-level system diagram, technology stack, client-server split boundary, build targets, phase roadmap                                                                                   |
| [PLAN-development.md](PLAN-development.md)   | Build system (CMake 3.25+, presets, Ninja), dependencies (FetchContent), IDE setup (VS Code, Rider, Xcode), testing (doctest, Vitest, busted), debugging, developer onboarding            |
| [PLAN-server.md](PLAN-server.md)             | Headless `spring-server` build target, threading model (single-threaded sim + worker pools), simulation loop, SQLite schema, logging, permissions system, code to keep/remove from Spring |
| [PLAN-network.md](PLAN-network.md)           | WebSocket/WebRTC protocol layering, FlatBuffers + custom binary serialisation, delta compression, viewport filtering pipeline, snapshot interpolation, reconnection                       |
| [PLAN-client.md](PLAN-client.md)             | TypeScript project structure, core services layer, connection lifecycle, render loop, input handling, asset loading, entity rendering pipeline                                            |
| [PLAN-content.md](PLAN-content.md)           | Plain directory content storage (no Spring archives), web-ready formats, HTTP delivery, browser Cache API, legacy import tool                                                             |

#### Subsystems

| Plan                                                                        | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [PLAN-graphics.md](PLAN-graphics.md)                                        | Babylon.js on WebGL 2, CDLOD terrain, thin instances for units, animation textures, GPU particles, CSM shadows, S3O-to-glTF asset pipeline                                                                                                                                                                                                                                                                                                                                                 |
| [PLAN-audio.md](PLAN-audio.md)                                              | Web Audio API, 96-voice pool with priority culling, 3D PannerNode spatial audio, music streaming, zoom-aware attenuation                                                                                                                                                                                                                                                                                                                                                                   |
| [PLAN-scripting.md](PLAN-scripting.md)                                      | Dual Lua/JS scripting model. Server-side: native Lua 5.4 (vendored 5.4.7). Client-side: Fengari Lua in a Web Worker. Command buffer architecture for `gl.*` calls. Core Engine API in TypeScript                                                                                                                                                                                                                                                                                           |
| [PLAN-ai.md](PLAN-ai.md)                                                    | Server-side NPC AI (Lua VMs in thread pool), client-side Web Worker assistant, unified AI API, LOD system, migration from Spring's ExternalAI                                                                                                                                                                                                                                                                                                                                              |
| [PLAN-lobby.md](PLAN-lobby.md)                                              | JWT authentication, Svelte lobby UI, room state machine, Glicko-2 ratings, spectator mode, persistent world roadmap                                                                                                                                                                                                                                                                                                                                                                        |
| [PLAN-lobby-game-connection.md](PLAN-archive/PLAN-lobby-game-connection.md) | Lobby ↔ running game server backchannel. WebSocket + FlatBuffers (replaced the IPC pipe), SQLite persistence so lobby restarts don't kill in-progress games                                                                                                                                                                                                                                                                                                                                |
| [PLAN-weapons.md](PLAN-archive/PLAN-weapons.md)                             | Dual combat model: simplified (LOS+range) for small arms, ballistic simulation for heavy weapons, visibility-filtered combat events                                                                                                                                                                                                                                                                                                                                                        |
| [PLAN-orders.md](PLAN-archive/PLAN-orders.md)                               | Command system redesign: client-side debouncing, grouped multi-squad commands, server-side rate limiting, standing orders (condition-based strategic directives)                                                                                                                                                                                                                                                                                                                           |
| [PLAN-messages.md](PLAN-messages.md)                                        | Pub-sub event messaging between server and client. Topic-based subscriptions with server-side filters (spatial, entity type, team). Replaces SendLuaMsg/RecvLuaMsg, eventHandler unsynced dispatch, and AI message channels                                                                                                                                                                                                                                                                |
| [PLAN-client-entity.md](PLAN-client-entity.md)                              | Client-side entity scripts for visual behaviour: animations, rendering, sound, particles in response to game events. Covers units, features, and map objects. Dual Lua/JS runtime. Piece transform streaming from server                                                                                                                                                                                                                                                                   |
| [PLAN-latency.md](PLAN-latency.md)                                          | Client/server drift & latency compensation. Central timing model (presentation cursor `P = E − D`, future window, scheduled-event timeline, two timelines: interpolate-past observation + optimistic control) + Part 2 survey of latency-sensitive subsystems. Sub-plans: [PLAN-latency-projectiles.md](PLAN-latency-projectiles.md) (two-tier cosmetic/synced projectiles, foreknown outcomes), [PLAN-latency-squads.md](PLAN-latency-squads.md) (squad-as-atom, client soldier fan-out). |
| [PLAN-demo.md](PLAN-archive/PLAN-demo.md)                                   | Paper Tanks — minimalist demo game with cardboard cutout aesthetic for testing at scale (thousands of squads)                                                                                                                                                                                                                                                                                                                                                                              |

#### Active work (July 2026)

| Plan                                       | Scope                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [PLAN.md](PLAN.md)                         | **Master (rev 2026-07-02).** Goal hierarchy, binding Work pattern + Code-session contract for /work sessions, cross-track Current queue with per-milestone model tags, Deferred ledger, plan index                                                                             |
| [PLAN-perf.md](PLAN-perf.md)               | Track P: performance recovery + scaling budget. Measured baseline → ranked fixes (terrain decal plugin, decal RTT re-bakes, light-pool tax, per-draw uniforms, LuaUI GL-state tax, terrain patch uploads) → standing frame budget. Hosts the Lua→native porting queue (goal A) |
| [PLAN-bar.md](PLAN-bar.md)                 | BAR port; §7 = Track U (BAR LuaUI HUD repair, milestone queue at top of §7). §6 worklist mostly done; lighting/light-routing deferred                                                                                                                                          |
| [PLAN-playable.md](PLAN-playable.md)       | Track G: playable full games. Seven-step playable definition, ZK regression sweep, GameOver winners, worker input port, ZK Phase D, piece transforms; G6 full-game gates for BAR + ZK                                                                                          |
| [PLAN-convert-zk.md](PLAN-convert-zk.md)   | Zero-K gap catalogue (feeds Track G): Phase A complete (197/236 gadgets boot + combat verified); Phase C/D items flow into PLAN-playable G4/G5                                                                                                                                 |
| [PLAN-performance.md](PLAN-performance.md) | Profiling methodology handbook (release-build guardrail, scenario ladder, tooling); actionable milestones live in PLAN-perf.md                                                                                                                                                 |

#### Archived

`PLAN-archive/` (gitignored) holds completed tactical plans, superseded drafts, and the previous master plan (`PLAN-rendering-drive.md`, the 2026-05/06 AAA rendering drive: game-worker+WebTransport Stage 0, lighting, weapon-FX boot, decals, deformable terrain). See the PLAN.md plan index for the full archived list. The user-facing surface for debugging is documented in [docs/debugging.md](docs/debugging.md).

### Implementation Order

Development is organised into phases. Each phase produces a testable milestone.

**Status (2026-05-11):** Phases 0–2 are complete. Phase 3 is mostly complete (combat works, audio pipeline runs end-to-end). Phase 4 is partly complete (server-side LuaRules/LuaGaia + client LuaUI Web Worker run; server-side AI not yet wired). Phase 5 lobby is functional; spectator mode and Glicko-2 ratings not yet implemented. Phase 6 is untouched.

#### Phase 0: Legacy Cleanup & Build Modernisation — DONE (with revisions)

_Goal: A clean, minimal, buildable C++ codebase with modern tooling._

**Note:** The original Phase 0 plan to delete `rts/System/FileSystem/` and `rts/System/creg/` was reversed. Both subsystems are kept (see Resolved Design Decisions table above).

1. **Set up new build system** (PLAN-development.md) — CMake 3.25+, CMakePresets.json, Ninja, FetchContent for deps. Get `make setup && make build` working on a stripped codebase.
2. **Delete rendering** — remove `rts/Rendering/`, `rts/aGui/`, `rts/Menu/`, all GL/SDL dependencies, DevIL, FreeType. Remove rendering-related code from `Game/` (Camera, UI, LoadScreen, InMapDraw, etc.).
3. **Delete legacy networking** — remove the P2P relay model, `NETMSG_*` protocol, client-side netcode. Keep `GameServer.cpp` logic as reference only.
4. **Delete content/archive system** — remove `rts/System/FileSystem/` VFS, archive loaders, ArchiveScanner, RapidHandler. Remove `pr-downloader`, `unitsync`, the `AI/` directory, and `tools/` (except as reference).
5. **Delete legacy AI** — remove `rts/ExternalAI/` (the entire C ABI, library loading, SkirmishAIWrapper, AICheats, SSkirmishAICallbackImpl). Move `EngineOutHandler.cpp` to a `reference/` directory before deletion — Phase 4 AI migration reuses its event-filtering patterns.
6. **Delete audio** — remove `rts/System/Sound/` (server has no audio).
7. **Strip simulation** — remove creg serialisation, remove streflop, remove AVI capturing, remove features only needed for P2P sync (sync debugging, sync checksums). Use standard IEEE floating-point.
8. **Verify build** — the result should compile as a headless executable that can load a map, initialise the simulation, and run empty ticks. Write basic doctest tests for core sim types (Vec3, Matrix, CommandQueue, QuadField).
9. **Set up client project** — `npm create vite@latest client`, install TypeScript, Babylon.js, Svelte. Verify `npm run dev` serves a blank page. Set up Vitest.
10. **IDE configs** — check in `.code-workspace`, `.vscode/`, `CMakePresets.json`. Verify debugging works in VS Code (C++ server) and browser (client).

#### Phase 1: Server Foundation — DONE

_Goal: A headless server that accepts WebSocket connections and runs the sim._

1. Integrate uWebSockets — connection lifecycle state machine (PLAN-server.md, PLAN-network.md)
2. Basic authentication — JWT + SQLite accounts (PLAN-lobby.md)
3. Simulation loop running at 30 Hz with command ingestion (PLAN-server.md)
4. FlatBuffers protocol — define core message schemas (PLAN-network.md)
5. Player command submission and validation (PLAN-orders.md)

#### Phase 2: State Streaming & Rendering — DONE

_Goal: A browser client that connects and renders the game world._

1. Viewport registration and spatial filtering via QuadField + LOS (PLAN-network.md)
2. Entity state serialisation with delta compression (PLAN-network.md)
3. Babylon.js renderer — terrain heightmap, basic unit rendering with thin instances (PLAN-graphics.md)
4. Asset pipeline — model conversion, HTTP delivery, browser caching (PLAN-content.md, PLAN-graphics.md)
5. Snapshot interpolation on the client (PLAN-client.md)
6. Paper Tanks demo game for visual testing (PLAN-demo.md)
7. Client-side projectile rendering — `core/projectile-renderer.ts` (per-weapon-type meshes via thin instances)

#### Phase 3: Combat & Gameplay — IN PROGRESS

_Goal: Playable combat with the demo game._

1. ✅ Weapon system — simplified combat + ballistic projectiles (PLAN-weapons.md)
2. ✅ Command system — debouncing, grouped commands (PLAN-orders.md)
3. ⏳ Standing orders — server-side evaluation, Lua API (PLAN-orders.md)
4. ✅ Web Audio — 96-voice HRTF pool, server SoundEvent → buffer cache → spatial play, zoom attenuation, master limiter (PLAN-audio.md). Music streaming wired but no sim-side trigger logic yet.
5. ✅ Combat event visualisation on client — tracers, explosions, muzzle flashes via `combat-fx.ts` (PLAN-weapons.md)
6. ✅ Build animation — translucent build beams, per-tick build progress (PLAN-build-anim.md)

#### Phase 4: Scripting & AI — IN PROGRESS

_Goal: Game logic runs in Lua, AI factions work._

1. ✅ Server-side Lua — LuaRules/LuaGaia running game logic (preserved from Spring); ScriptEventDispatcher bridges C++ events to language-agnostic IScriptContext instances
2. ✅ Fengari Lua client runtime in a Web Worker with command buffer (PLAN-widgets.md)
3. ✅ Widget system — `lua-widget-manager.ts` + worker host (PLAN-widgets.md). Chili UI integration in progress.
4. ⏳ JS scripting API alongside Lua — `script-api.ts` exists; surface area still being filled out
5. ⏳ Server-side AI runtime — `Server/AI/AIRuntimePool` and `AIDiscovery` exist but AI plugins are not yet booting reliably (PLAN-ai.md)
6. ❌ Client-side AI assistant — not yet started
7. ⏳ Restore removed Lua API functions — most Spring.\* functions are wired; gaps tracked per ZK gadget needs (PLAN-convert-zk.md)

#### Phase 5: Lobby & Social — IN PROGRESS

_Goal: Players can find and start games through the browser._

1. ✅ Lobby UI — login, room browser, room setup (`client/src/lobby/lobby-ui.ts`). Note: implemented in plain TS rather than Svelte as originally planned.
2. ✅ Room state machine — configuring → filling → ready → loading → active → ended
3. ❌ Spectator mode (PLAN-lobby.md)
4. ❌ Game history and rating system (PLAN-lobby.md)
5. ⏳ Reconnection and state recovery (PLAN-network.md)
6. ✅ Admin interface and console — debug console + LuaExecEngine + console commands (see [docs/debugging.md](docs/debugging.md))

#### Phase 6: Scale & Polish — NOT STARTED

_Goal: Production readiness._

1. Multi-host entity handoff design (PLAN-architecture.md)
2. ~~WebTransport as progressive enhancement~~ — **promoted to a foundational change that lands first**, no longer a Phase-6 enhancement (PLAN-game-worker.md, PLAN.md Stage 0)
3. WebGPU renderer backend (PLAN-graphics.md)
4. Queue-based matchmaking (PLAN-lobby.md)
5. Persistent world metagame layer (PLAN-lobby.md)
6. Performance profiling and optimisation at scale (thousands of squads)
