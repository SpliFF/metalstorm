---
name: spring-debug
description: Debug and inspect running Spring RTS Web servers. Use when querying logs, executing Lua or SQL, inspecting game state, listing processes or sessions, or diagnosing server issues.
when_to_use: Use when the user asks about server logs, game state, Lua errors, running processes, SQL queries, or needs to execute commands on the lobby or game server. Prefer these MCP tools over raw curl when the servers are running.
user-invocable: false
---

# Spring Debug MCP Server

The `spring-debug` MCP server (declared in `.mcp.json`) connects to the running lobby, game server, and log server via HTTP. It provides these tools:

## Tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `get_logs` | Fetch recent log entries (filter by level, section, scope, room) | Checking server output, finding errors |
| `search_logs` | Full-text search across all logs | Finding specific errors or patterns |
| `exec_lua` | Execute Lua code in LuaRules, LuaGaia, or server scope. In `server` scope a leading `json ` token (`json state`, `json units 0`, `json unit_state 42`) returns a JSON object instead of free text — see [structured server verbs](../../../docs/debugging-tools.md#structured-server-verbs-json-prefix) | Testing gadgets, inspecting game state |
| `query_db` | Run read-only SQL against the lobby database (only row-returning statements: SELECT, `WITH … SELECT`, EXPLAIN, PRAGMA reads) | Checking users, sessions, room state |
| `end_game` | Gracefully stop a room's spring-server: SIGTERM (clean exit + war-log drain + exit checkpoint) → poll → SIGKILL on timeout. `{roomId, graceful=true, timeoutMs=10000, escalate=true}`. Goes through the lobby's `POST /api/admin/rooms/end` and returns its **drain-quality report** — `{source, outcome, frame, label, lossy, resume_eligibility, exited, escalated, waitedMs, describe}` — i.e. it tells you whether the world actually checkpointed, not just that the pid died. `source:'sigterm-fallback'` means the lobby predates that route and there is no checkpoint verification | Ending a game you launched — **the default teardown verb** |
| `kill_game` | **DEPRECATED** alias for `end_game(graceful:false)` (immediate SIGKILL, no checkpoint) | Only when a graceful stop is pointless (server wedged in precache) |
| `get_frame` | Sim `frame`/`simFps`/`clients` via the public `/api/metrics` — no exec, no auth | Cheap liveness poll; works paused, pre-GameStart, and under `SPRING_PROD` |
| `probe_game` | One-shot readiness phase for a room: `spawning` → `loading` → `ready` → `ticking`, or `dead`. `{roomId?}` → `{phase, pid, port, ready, clientCount, statusAgeSec, frame, simFps, detail}` | "Is this game up, still booting, or gone?" — the honest answer in one call |
| `wait_for_game` | Poll `probe_game` until a phase or frame is reached. `{roomId?, until=ready\|ticking\|frame, frame?, timeoutMs=120000, pollMs=500}`. **Returns immediately with `phase:'dead'` + `lastLogs` if the server dies**; a timeout returns `timedOut:true` plus the last probe | Waiting on a launch/restart without burning 120 s on a server that already crashed |
| `launch_scenario` | **Scenario-first launch, no lobby UI and no login.** `{scenarioId, gameId='metalstorm', ai='null', side?, mapId?, players?, roomName='mcp:<id>', wait='ticking', headless?, force?}` → `{roomId, port, sessions, browserUrl, scenario, phase, frame, notes}`. Resolves the scenario, builds the `/api/rooms/direct` manifest in memory (scenario as the **top-level** field — as a modoption it is silently overwritten by the map default), POSTs it, waits on `probe_game` | **The default way to start a metalstorm game.** Prefer over `launch_game` for anything scenario-shaped: one call, host seated on the scenario's first side, AIs on the rest, and a `browserUrl` that attaches |
| `launch_direct` | **Raw-manifest launch** — the manual sibling of `launch_scenario`. `{manifestName? and/or manifest?, overrides?, wait='ticking', timeoutMs=120000, clearCache?, idleGraceSeconds?}` → `{roomId, port, roomName, sessions, players, aiSlots, browserUrl, phase, frame, notes}`. Merge order: file → `manifest` deep-merged (objects recurse, **arrays/scalars replace**) → `overrides` shallow-merged last. A bad `manifestName` lists the real ones. `name` is **idempotent by replacement**; unnamed ⇒ the shared `"dev:direct"` | Custom rosters, modoptions, `sessionKind`, or idle timers — anything `launch_scenario` doesn't synthesise. Reach for `launch_scenario` first for anything scenario-shaped |
| `validate_scenario` | **Offline** — replicates BOTH scenario parsers (lobby bare-`lua_State` discovery + `game_scenario.lua`'s GameStart `validate()`) with no stack running. `{scenarioId \| luaSource, gameId='metalstorm', passability?}` → `{ok, findings[{severity, rule, path, message}], counts, defsSource}` | Before writing or launching any scenario. `skipped` findings mean **not checked**, never "fine" |
| `write_scenario` | Validate → write `scenarios/<id>.lua` → resync the lobby → **confirm** it is offered. `{scenarioId, luaSource, gameId?, overwrite?, force?, resync=true}` → `{written, file, findings, resync, offered}`. Errors always block; warnings block unless `force`. Refuses the `gen_` prefix | Authoring a scenario. Without the resync the picker and `launch_scenario` cannot see the file at all |
| `list_scenarios` | Discovery view + generated-war provenance (seed, params, createdBy), rows tagged `source: authored\|generated`. `{gameId?}` | "What wars exist, and where did this one come from?" |
| `generate_scenario` | Wraps the admin generator route. `{mapId, seed?, sides?, towns?, outposts?, bases?, mines?, sites?, relics?, wrecks?, bridges?, hostility?, roster?}`. Seed defaults to `sum(ord(c) for c in mapId)`, so a re-run is an **idempotent upsert**; a 422 carries the generator's own `REJECTED` line | Making a new war for a map without hand-authoring one |
| `list_processes` | Game servers the lobby manages, as **JSON**: `{servers:[{roomId, port, pid, state, gameId, mapId, ready, clientCount, heartbeatAgeSec, heartbeatStale, identity}], count}`. `ready`/`clientCount`/heartbeat come from `game_status`; `identity` is `{stamp, engineHash, pid}` from the server's `/api/metrics` (`null` on a pre-P8 binary). Empty case is still the literal `No game server processes found.` | Checking if a game is running, and which build is serving it |
| `list_stack` | **Everything running, classified, in one call** — `{findings, processes, ports, authority, gameStatus, binaries, mprocs, summary}`. Finds what `list_processes` structurally cannot: `stray-server` (hand-launched server the lobby doesn't know), `zombie-port` (a squatter on 9100-10099 — room routing is by port, so it blocks the next room), `duplicate-lobby`, `orphan-vite` (a vite on a fallback port silently drives the wrong stack), `stale-status-row`, `binary-drift` (**the lobby forks `build/release/spring-server` when it exists — a debug-only rebuild is invisible**) and, with `probeHashes:true`, `stale-binary-running`. Read-only; never connects to the mprocs port | **First move when anything is weird**: a launch that won't come up, auth failing on a fresh room, a fix that "didn't take". Replaces hand `pgrep`/`lsof` |
| `cleanup_stack` | Kill the non-managed findings. **`dryRun` defaults to `true`** — it returns the plan (pid, kind, signal sequence) and touches nothing; re-run with `dryRun:false`. SIGTERM → poll 5 s → SIGKILL. Never kills the `:8011` lobby; never touches `managed` (use `end_game({roomId})` for a real game); refuses `stray-server` when the lobby is unreachable (no authority ⇒ "stray" is unprovable); `zombie-port` on a non-`spring-server` command needs `force:true` | Clearing strays and port squatters before a clean run |
| `list_sessions` | List recent game sessions from the log server | Post-mortem, history |
| `get_game_state` | Sim state as an **object**: `{frame, paused, speed, teams, units, luaHeapKb}` (falls back to legacy text on a pre-`json ` game server) | Checking if sim is ticking; reading paused/speed without a second call |
| `list_units` | Units as an **object**: `{total, returned, units:[{id, def, team, hp, maxHp, x, y, z}]}` — `total` counts every match of the team filter, `units` caps at 100 rows | Debugging combat, spawning; positions without a Lua round-trip |
| `list_gadgets` | List loaded Lua gadgets | Checking which gadgets are active |
| `get_lua_source` | Read a Lua file via the lobby's VFS HTTP endpoint | Reading gadget source when debugging errors |
| `restart_lobby` | Restart the lobby server in-place (re-exec, same PID, preserves game servers) | After rebuilding spring-lobby binary |
| `restart_logserver` | Restart the log server (:8010) in-place (re-exec, same PID) | After rebuilding spring-logserver, or if the log pipeline stops responding |
| `restart_game` | Restart a game server in-place (re-exec with same args, same PID) | After rebuilding spring-server binary |
| `restart_client` | Restart the Vite client pane (:8012) via the mprocs control channel | After editing a worker-imported client file (`entity-renderer.ts`, `game-processor.ts`) that Vite serves stale |
| `api_request` | Authenticated HTTP request to lobby/log/game server (auto-manages token) | Hitting endpoints without curl + manual token plumbing |

This server also exposes browser-bridging tools (`client_eval`, `client_ready`, `client_screenshot`, `browser_test`, `evaluate_widget_lua`, `spawn_at_camera` — these **run code in a connected browser and return the answer**, via the P7 relay, falling back to printing a chrome-devtools snippet when one of its three gates refuses) and the server-side test verbs (`spawn_unit`, `give_order`, etc.) — those, plus the performance-profiling tools (`perfDump`, `uiProfileStart/Dump/Stop`, `netSim*`), are documented in the **`spring-test`** skill and [docs/debugging-performance.md](../../../docs/debugging-performance.md), since they're really one `window.test` API surface rather than server-log/DB tooling.

## Server URLs

- Lobby: `http://127.0.0.1:8011` (fixed)
- Log server: `http://127.0.0.1:8010` (fixed)
- Game server: **dynamic port** — discovered at runtime, never hardcoded

### Discovering game server ports

Game servers are spawned by the lobby with dynamically assigned ports. There may be multiple running simultaneously. Always discover ports before interacting with a game server:

1. **MCP tool**: `list_processes` — returns all running game servers with their ports
2. **HTTP API**: `GET http://localhost:8011/api/processes` — JSON array of `{room_id, port, pid, state, ...}`
3. **MCP tool**: `get_game_state` with optional `roomId` — auto-discovers if only one game is running

The MCP server's `GAME_SERVER_URL` env var sets a default for single-server development but should not be relied upon. Override via `LOBBY_URL`, `GAME_SERVER_URL`, `LOG_SERVER_URL` env vars in `.mcp.json`.

## Auth

The MCP server auto-authenticates via `SPRING_TOKEN` env var, or falls back to `SPRING_USER`/`SPRING_PASS` (defaults to admin/admin). Set `SPRING_TOKEN` in `.mcp.json` env if needed. All tools that hit the lobby or game server reuse the cached token — you do not need to log in or pass a token from the tool side.

## Generic HTTP via `api_request`

Use `api_request` when the dedicated tools above don't cover the endpoint you need (e.g. `/api/rooms`, `/api/processes`, custom debug endpoints). It:
- attaches a Bearer token automatically (override with `auth: false` for unauthenticated probes),
- routes by `target`: `"lobby"` → `:8011`, `"log"` → `:8010`, `"game"` → dynamic game-server port (uses `roomId` or first active game), `"url"` → an absolute `url`,
- JSON-encodes object bodies and parses JSON responses (set `expectJson: false` for raw text).

Examples:
```
api_request({ target: "lobby", path: "/api/processes" })
api_request({ target: "game", path: "/api/exec", method: "POST",
              body: { scope: "LuaRules", code: "return #Spring.GetAllUnits()" } })
api_request({ target: "lobby", path: "/api/rooms/leave", method: "POST", body: {} })
```

Prefer `exec_lua` for Lua snippets and `query_db` for SQL — `api_request` is the escape hatch.

## When to prefer these tools over alternatives

- **Over curl**: Use MCP tools for structured queries (logs, SQL, exec). Use curl for testing raw HTTP endpoints or verifying headers/status codes.
- **Over springcli**: MCP tools run in-process with Claude — no shell overhead. Use springcli for standalone CLI testing.
- **Over browser console**: MCP tools work without a browser. Use browser console for client-side JS debugging.

## Restarting Servers In-Place

After rebuilding binaries, restart servers without disrupting the lobby room lifecycle.

The three **C++** restart tools (`restart_lobby`/`restart_logserver`/`restart_game`) **re-exec the process in place — the PID is preserved**, so an external process manager (mprocs) stays authoritative and never sees a crash + respawn. **Prefer these over `kill` + relaunch**: hand-launching outside mprocs leaves the mprocs-managed pane dead and can spawn duplicate listeners on the same port (SO_REUSEPORT round-robin), so requests hit a stale pre-rebuild binary. If you ever do end up with duplicate `spring-lobby`/`spring-logserver` processes, kill the extras and restart the surviving one via these tools (or the mprocs pane).

`restart_client` is the equivalent for the **Vite** dev server, which is a node process with no in-place re-exec: it restarts the `client` pane through the mprocs remote-control channel (`mprocs.yaml` `server:` key → `select-proc` + `restart-proc`), which is likewise authoritative and pane-preserving. Use it after editing a worker-imported client file (`entity-renderer.ts`, `game-processor.ts`, …) — Vite serves a stale `?worker` bundle otherwise. It requires mprocs to have been started with the `server:` key; if not, it falls back to kill+relaunch and says so (restart mprocs once to enable the clean path). See [docs/debugging-tools.md](../../docs/debugging-tools.md) "mprocs Development Environment → Remote control".

**Lobby** (`restart_lobby`):
- Re-execs the process with the same CLI arguments (PID is preserved)
- Persists running game server PIDs/ports to SQLite so active games survive the restart
- Also triggered via `SIGHUP` signal or `POST /api/exec` with `{"scope":"lobby","code":"restart"}`

**Log server** (`restart_logserver`):
- Re-execs the process with the same CLI arguments (PID is preserved)
- Use after rebuilding `spring-logserver`, or to recover the log pipeline if `get_logs`/`search_logs` start failing with `fetch failed` (the log server on :8010 went down)
- Also triggered via `SIGHUP` signal or `POST /api/logs/restart`

**Game server** (`restart_game`):
- Re-execs with the same CLI arguments (same PID, same port, fresh binary)
- Broadcasts a `GameRestarting` FlatBuffer message to connected clients before re-exec
- Clients receive the message and reload the page to reconnect
- Also triggered via `SIGHUP` signal or `POST /api/restart` on the game server port
- Use this instead of going through the lobby end→close→create→start cycle when iterating on server code

## Browser automation

When testing the game in the browser, **always use `mcp__chrome-devtools__*` tools**. Never use `mcp__claude-in-chrome__*` tools — mixing the two spawns a separate browser window and breaks page context.

## Room & session hygiene when testing

Stale rooms are the single biggest time-sink in a test session. `list_processes` accumulates dozens of `ended`/`starting` rows, the browser silently rejoins a *dead* room, and MCP tools auto-target the *wrong* game. **Track the exact `roomId` you launched and pass it explicitly everywhere.**

1. **Treat the `roomId` from `launch_game` as the single source of truth.** Pass it to *every* room-scoped MCP call (`get_game_state`, `exec_lua`, `spawn_unit`, `give_order`, `set_los`, `set_cheats`, `get_logs`, …). Do **not** rely on the "first active game" auto-detect — it will pick up a stale or someone else's room. When in doubt, `get_game_state(roomId)` and confirm `frame >= 0` (a live, ticking game) before driving it.

2. **`?room=N` / `autojoin` / `hidestartup` URL params do NOTHING** — they are read **nowhere** in the client (a long-standing misconception; don't rely on them). The browser instead **auto-reconnects** to `localStorage['springrts-game-room']` (the last room you were in, written on join/start). That's why you keep landing in a stale/dead room. To put the browser in a *specific* room, call `await window.lobby.joinRoom(<roomId>)` (this also updates the saved room). To avoid a stale reconnect, `await window.lobby.leave()` first, or clear `localStorage.removeItem('springrts-game-room')`. After connecting, **verify** `window.lobby.currentRoom?.id === <your roomId>`. (Self-heal landed: a failed auto-reconnect now clears the stale saved room, so a *dead* room no longer re-attaches on every reload — but an already-attached stale room in the current tab still needs an explicit `leave()`.)

3. **Match the browser user to the room host (roster check).** A game server only admits clients in its **launch-time roster**. `launch_game` hosts as **admin** by default, but the browser auto-logs-in from a saved token that is often a *different* user (e.g. `test1`) → auth rejects with **"Not in this room's roster"**. Either launch as the browser's user, or log the browser in as the host. Dev creds are plaintext in the `users` table (`query_db "SELECT username,password_hash FROM users"`; typically `admin`/`admin`, `test1`/`test`). To switch the browser to admin:
   ```js
   const r = await fetch('/api/auth/login', {method:'POST', headers:{'Content-Type':'application/json'},
     body: JSON.stringify({username:'admin', password:'admin'})}).then(x=>x.json());
   localStorage.setItem('springrts-username','admin');
   localStorage.setItem('springrts-token', r.token);
   ```
   (then navigate/join). Joining mid-game as a non-roster spectator will fail.

4. **Connect promptly — a fresh server exits at frame -1 if no player connects in time.** A just-launched `spring-server` logs `waiting for N player(s) to connect` and **shuts down cleanly** if the browser doesn't attach within its timeout. Don't burn that window polling the *stale* room: launch → immediately `leave()` + `joinRoom(newId)` → *then* poll for boot. If `list_processes` shows your room `ended` right after launch and the log says `exited cleanly … (frame -1)`, you were too slow / joined the wrong room — relaunch and connect faster.

   **For a run that never opens a browser at all** (exec-driven tests, `spawn_unit`/`give_order` sweeps), no amount of speed helps — `clientCount` stays 0 forever and the default **120 s** startup grace kills the server at frame −1. Pass `idleGraceSeconds` to `launch_direct` or `launch_scenario`: it lands in the manifest as `idleStartupGraceSeconds` and is forwarded to the child as `--idle-startup-grace-seconds` (confirm with `ps -o args= -p <pid>`; the spawn log line reads `idle self-termination: exit after 300s with no clients (600s startup grace)`). Two things this does *not* fix: a **skirmish still holds `GameStart` until its rostered humans connect**, so the sim sits at frame −1 regardless — `wait:'ready'` is the reachable target unless you roster AI-only or use `sessionKind:'persistent'`; and a lobby binary older than P3 ignores the field **without error**, where the fallback is `SPRING_IDLE_STARTUP_GRACE_SECONDS` in the *lobby's* environment (inherited by every room it spawns, so pair it with `end_game`).

5. **Don't churn sessions mid-test.** Repeatedly re-`POST /api/auth/login` for the same user, or mixing an MCP-`launch_game` (admin-hosted) room with an in-browser join *as a different user*, produces token / saved-room / roster confusion that looks like a lobby bug but isn't. Pick one identity and one room-creation path and stick with it. The most reliable browser flow is to create the room **in-browser as the already-logged-in user** (`createRoom` → `addAI` → `ready(true)` → `startGame`) — the host is always in the roster, so no "not in this room's roster". `restart_lobby` re-runs the same startup recovery as a cold start (adopt-or-reset); a fresh-launched game's roster handoff is *not* broken by it.

6. **Clean up games you're done with.** Stale rooms are the main time-sink — don't leave them behind:
   - In the browser, `await window.lobby.leave()` when finished. Room lifecycle is **leave-only** by design (there is no force-end/close endpoint); when the last member leaves, the lobby `DeleteRoom`s it and reaps the game server.
   - For a server stuck in `starting` (no client ever attached), use `end_game(roomId)` — the lobby marks the room ended on its next health check. `end_game` **requires the roomId** (as does its deprecated alias `kill_game`): called bare it refuses with a candidate list rather than killing whichever game it found first, which on a two-game box was the wrong one.
   - A just-launched server self-reaps at frame -1 if no one connects, so abandoned launches don't linger forever — but `leave()`/`end_game` is immediate and keeps `list_processes` readable.
   - Prefer `end_game` over `kill_game`: SIGTERM lets the server drain its war log and write the **exit checkpoint** (the only site where a world becomes resumable); SIGKILL skips it and leaves a stale `game_status` row. Escalation to SIGKILL is automatic after `timeoutMs` (default 10s, capped at 30s server-side) — pass `escalate:false` to leave a wedged server alive instead.
   - **Read the report, don't just check `exited`.** `end_game` now returns the lobby's per-room drain report: `outcome:"checkpointed"` with a `frame` means the world was actually saved; `exited_without_checkpoint` is benign for a skirmish and **data loss for a war** (`lossy:true`); `killed_after_timeout` means SIGTERM was ignored; `not_running` means the room was already dead (an honest 200, not an error). `source:'sigterm-fallback'` means the lobby binary predates `POST /api/admin/rooms/end`, so none of that verification happened.
   - **The room does not read "ended" in the response** — the lobby's health loop classifies the exit a moment later, exactly as it does an idle hibernation. Poll `/api/rooms` or `probe_game` if you need to observe the flip; do not treat the immediate room state as a failure.
   - To restart a room cleanly, `end_game` it first and *then* launch: a same-name `launch_direct` also SIGTERMs, but it immediately deletes the room and respawns, so you get no report.

7. **Never hand-roll a readiness poll.** `wait_for_game(roomId)` is the one wait: it reads `game_status` (the signal the lobby's room state is *derived* from, so it is a hop earlier) and, crucially, **fails fast** — a room-state poll treats a server that died on boot as "keep waiting" for the full timeout, where `wait_for_game` returns `phase:'dead'` with the last 15 room log lines within a poll period. `probe_game` is the single-shot version for "what is this room doing right now?". Two phases people misread: `ready` means *accepting connections* (`frame` is still -1 pre-GameStart — that is the normal, connectable state a Skirmish sits in until humans join), and `loading` covers both "still precaching" and "wedged" — the `detail` string says which.

8. **Scenario games: `launch_scenario`, not the room dance** (and `launch_direct` when you need to hand-write the manifest — same endpoint, same `name`-replacement contract, but nothing is synthesised for you)**.** `launch_scenario({scenarioId:'crossing_standoff'})` replaces login → create → addAI → ready → start *and* the wait. Its `browserUrl` (`?play=…&room=<id>#token=…`) **attaches** to that exact room, so the roster question in rule 3 answers itself — the URL carries the host's own direct-minted session. Two facts that read as bugs otherwise: re-launching the same scenario **replaces** the previous room by name (that is the direct route's contract), and the lobby's scenario list is a **startup snapshot**, so a scenario file authored after lobby boot needs `api_request POST /api/admin/scenarios/resync` or `force:true` (+ `mapId`). Needs the lobby run with `--dev-direct-start` (mprocs does; a hand-started lobby may not — a 404 from the tool says exactly this). The generated `browserUrl` also carries `skipBriefing=1`, which suppresses the scenario **briefing splash** — a DOM overlay a briefing-bearing scenario mounts over the loading canvas (see the game-browser-test skill). A war's authored briefing is visible without launching anything: `api_request GET /api/games/metalstorm/scenarios` returns a `briefing` object per scenario that has one, and the key is absent for those that don't.

9. **Authoring a scenario: validate before you write, and never trust a silent success.** A scenario file is read by two different parsers with two different silent failures, and `validate_scenario` is the only thing that sees both without a boot. The loop is `validate_scenario({luaSource})` until zero errors → `write_scenario` (which re-validates, writes, resyncs and **confirms `offered:true`**) → `launch_scenario`. Three traps it exists for: (a) a file that touches `VFS`/`Spring.*`/`GG` **at file scope** loads fine in-game and is *invisible in the lobby forever* — the lobby's discovery pass is a bare `lua_State`; (b) `skipped` findings mean **not checked**, so a run whose only findings are `skipped` has proved much less than it looks (no baked def cache ⇒ every unknown-def rule was skipped — run a game once to bake); (c) never write a `gen_*` file — the scenario DB owns that namespace and its orphan sweep deletes any it does not claim. Format reference and every rule id: **[docs/scenarios.md](../../../docs/scenarios.md)**.

10. **Sequencing a war (tutorial beats, multi-stage objectives): `phases`, not `parentId`.** An objective can carry `phases = { {childDefs…}, {childDefs…} }` — phase 2's children are created only once every phase-1 child completes, and any child that fails or expires fails the whole chain. Children are authored in the same flat dialect as top-level objectives (`region`, `holdFrames`, …). Two traps: the **parent is itself a real objective** and must validate for its declared type, or `Create` rejects it and *the entire chain silently does not exist*; and `parentId`/`linkedId` take **runtime ids the engine mints at stage time**, so a file can never fill them in — they exist for gadgets, not authors. `validate_scenario` catches every mis-shape (`objective-phases`, `objective-chain-id`), which is worth doing because a bad chain is not an error in-game, just a parent that quietly never advances.

**Canonical browser-test loop:** in-browser as the logged-in user → `createRoom` → `addAI` → `ready(true)` → `startGame` → poll `window.test.deps.connection.authenticated` → drive with `window.test.*`; `leave()` when done. **MCP-only loop (no browser):** `launch_game` (already waits, and returns `phase`) → note `roomId` → `wait_for_game(roomId, until:'ticking')` once a client is attached → drive every room-scoped tool with that one `roomId` → `end_game(roomId)` when done.

## Camera control

The camera lives **only in the browser** (the `RTSCamera` instance, `client/src/core/rts-camera.ts`). There are no camera MCP tools — drive it by feeding JS into `mcp__chrome-devtools__evaluate_script`. Two equivalent surfaces back the same camera: `window.test.*` (the test harness) and `window.camera.*` (pose primitives). Read the live pose with `window.test.cameraPose()` → `{pos:{x,y,z}, lookAt:{x,y,z}}`; check `window.camera.animating` before a screenshot (a transition is mid-flight when `true`).

### Coordinate system (read this first)
World positions are **positive** in `[0, mapX] × [0, mapZ]` (Option A — handedness is a *direction/basis* convention, not positional; see `PLAN-coordinate-system-option-a.md`). The camera shares the server's world coordinates — **no flip**. So a value from `Spring.GetUnitPosition(id)` feeds straight into the camera. `heading = 0` faces −Z; the map grows in +X/+Z.

### Canonical methods (all on `window.test`)
- **World point:** `cameraSnapToGround(x, z, {height, pitchDeg, durationMs})` — look-at lands on `(x, groundY, z)` with explicit framing. **Preferred** for precise, deterministic control.
- `focusOn(x, z, durationMs)` — pans to world `(x, z)` but **keeps the current camera→look-at offset/distance**, so a far/zoomed-out camera stays far. Takes **two** world coords.
- **A unit:** `cameraSnapToUnit(unitId, …)` / `focus(unitId)` — but see the viewport caveat below.
- **A group:** `cameraFitUnits([id,…], {pitchDeg, padding, durationMs})` — frames the bounding box. The player-facing tracking camera (`setTrackingCamera(true)`, `T` key) re-fits the live **selection** every tick via the same path.

### Pitfalls (all hit in practice)
1. `focusOn(x, z)` takes **two world coords**. `focusOn(unitId)` is a bug — the id is read as `x`, `z` is `undefined`, and the camera flies off-map. To target a unit use `cameraSnapToUnit(id)` / `focus(id)`.
2. **Never** set `scene.activeCamera.position` / `.setTarget(...)` directly. `RTSCamera` keeps its own `lookAt`; bypassing it desyncs that state, and the *next* animated `focusOn` computes `offset = camera.position − lookAt` from the stale value and hurls the camera thousands of elmos off-map (e.g. `x = −13197`). Always go through `window.test` / `window.camera`.
3. Animated moves (`durationMs > 0`) preserve the current offset/distance. For a tight, deterministic frame use `cameraSnapToGround` / `cameraSnapToUnit` with explicit `height` + `pitchDeg` and `durationMs: 0`.
4. The game camera controller does **not** fight a programmatic pose **unless tracking is on** (`window.test.setTrackingCamera(false)` to be sure) — tracking re-fits the selection every tick and will override your pose.

### Unit/group targeting is viewport-bound — use server positions
`cameraSnapToUnit` / `cameraFitUnits` / `focus(unitId)` resolve positions via the client's `getEntityPosition` — an **internal** renderer method (interpolated, viewport-streamed state), **not** a Spring API. The server **viewport-filters unit state**: it streams only units near the registered viewport. (Projectiles are *broadcast* to every client, so FX appear even where units don't — a unit can be invisible to the client while its shots are not.) So an off-screen unit — or a cheat/`spawn_unit`-spawned test unit the viewport never covered — has no client position, and these methods fail with `no client-side position for unit N` (observed: `entityMeta.size === 0`, zero units streamed).

Reliable recipe — get the authoritative position from the server, then point the camera:
```js
// mcp__chrome-devtools__evaluate_script
const r = await window.test.lua('local x,y,z=Spring.GetUnitPosition(ID) return x..","..z');
const [x, z] = r.split(',').map(Number);
await window.test.cameraSnapToGround(x, z, { height: 700, pitchDeg: 60, durationMs: 0 });
```
From the MCP side the same position comes from `exec_lua` (scope `LuaRules`, `return Spring.GetUnitPosition(ID)`). `Spring.GetUnitPosition` is server-authoritative and viewport-independent — prefer it over the client lookup for scripted camera framing.

### FX visibility
The forward FX light pool culls emissions **> 7000 elmos** from the camera. To see projectile / weapon-FX lights (and faithful deferred projectile lights), the camera must be near the action — frame the combat first, then observe.

## Troubleshooting

If tools return connection errors, the servers aren't running. Start them:
```
./build/debug/spring-logserver --port 8010 &
./build/debug/spring-lobby --port 8011 --maps content/maps --games-dir content/games &
```
