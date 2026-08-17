---
name: spring-debug
description: Debug and inspect running Spring RTS Web servers. Use when querying logs, executing Lua or SQL, inspecting game state, listing processes or sessions, or diagnosing server issues.
when_to_use: Use when the user asks about server logs, game state, Lua errors, running processes, SQL queries, or needs to execute commands on the lobby or game server. Prefer these MCP tools over raw curl when the servers are running.
user-invocable: false
---

# Spring Debug MCP Server

The `spring-debug` MCP server (declared in `.mcp.json`) connects to the running lobby, game server, and log server via HTTP.

**Canonical loop (default):** `launch_scenario({scenarioId, wait:'ticking', openBrowser:true})` → note the `roomId` → drive every room-scoped tool with that one `roomId` → `end_game({roomId})` when done, which also closes the browser it opened.

That is the whole loop, and it is **one call up, one call down** (~3 s to a ticking sim). `openBrowser` matters more than it looks: the default roster seats a **human**, so without a client the sim holds at frame −1 forever and every relay tool answers "no connected admin client". Browserless (`openBrowser` omitted) `wait:'ready'` is the reachable target — see the idle-grace note in Room hygiene.

Five habits this surface replaces — do not fall back to the old folklore:

- **Getting a client**: `openBrowser:true`, or `open_client` — never "navigate a browser to browserUrl" by hand, and never spin up chrome-devtools MCP just to have a page that connects. The browser is **headless by default** (it renders this Babylon client identically — same mesh counts, working `client_screenshot` — and opens no window on the user's machine); pass `headless:false` / `browserHeadless:false` to watch a run.

- **Waiting**: `wait_for_game` / `probe_game`, never a hand-rolled `/api/rooms` poll. `wait_for_game` reads `game_status` (the signal room state is *derived* from, so it is a hop earlier) and **fails fast** — a server that died on boot returns `phase:'dead'` with the last 15 room log lines within one poll period, where a room-state poll waits out the full timeout. Two phases people misread: `ready` means *accepting connections* (`frame` still −1 pre-GameStart — the normal, connectable state a skirmish sits in until its humans attach), and `loading` covers both "still precaching" and "wedged" — the `detail` string says which.
- **Stopping**: `end_game({roomId})`, never `kill`/SIGKILL by hand. It also closes any browser it opened for that room (reported under `browsers`). SIGTERM lets the server drain its war log and write the **exit checkpoint** (the only site where a world becomes resumable); escalation to SIGKILL is automatic after `timeoutMs`. It goes through the lobby's `POST /api/admin/rooms/end` and returns a drain-quality report — read it, don't just check `exited`: `outcome:"checkpointed"` + `frame` means the world was saved; `exited_without_checkpoint` is benign for a skirmish and **data loss for a war** (`lossy:true`); `killed_after_timeout` means SIGTERM was ignored; `not_running` is an honest 200. The room flips to "ended" asynchronously via the lobby health loop — poll `probe_game` to observe it, don't treat the immediate room state as failure.
- **Process hunting**: `list_stack` / `cleanup_stack`, never `pgrep`/`lsof`. `list_stack` classifies everything running (`stray-server`, `zombie-port`, `duplicate-lobby`, `orphan-vite`, `binary-drift`, `stale-binary-running`); `cleanup_stack` (dry-run by default) removes what is not managed.
- **Launching**: `launch_scenario` / `launch_direct`, never the login → create → addAI → ready → start dance (that path exists only for lobby-UI regression testing — see game-browser-test).

## Tools

| Tool | What it does | When to use |
|------|-------------|-------------|
| `launch_scenario` | **Scenario-first launch, no lobby UI and no login.** `{scenarioId, gameId='metalstorm', ai='null', side?, mapId?, players?, roomName='mcp:<id>', wait='ticking', headless?, idleGraceSeconds?, force?}` → `{roomId, port, sessions, browserUrl, scenario, phase, frame, notes}`. Resolves the scenario, builds the `/api/rooms/direct` manifest in memory (scenario as the **top-level** field — as a modoption it is silently overwritten by the map default), POSTs it, waits on `probe_game`. Add **`openBrowser:true`** (+ `browserHeadless`, default true) to launch a client too and reach `wait:'ticking'` in this one call — the browser is tracked and `end_game` closes it, and its report lands under `browser`. Browserless, pass `wait:'ready'` — `'ticking'` is unreachable on the default human roster | **The default way to start a metalstorm game.** One call, host seated on the scenario's first side, AIs on the rest, and (with `openBrowser`) a connected client |
| `launch_direct` | **Raw-manifest launch** — the manual sibling of `launch_scenario`. `{manifestName? and/or manifest?, overrides?, wait='ticking', timeoutMs=120000, clearCache?, idleGraceSeconds?}` → `{roomId, port, roomName, sessions, players, aiSlots, browserUrl, phase, frame, notes}`. Merge order: file → `manifest` deep-merged (objects recurse, **arrays/scalars replace**) → `overrides` shallow-merged last. A bad `manifestName` lists the real ones. `name` is **idempotent by replacement**; unnamed ⇒ the shared `"dev:direct"`, so concurrent lanes must set distinct names | Custom rosters, modoptions, `sessionKind`, or idle timers — anything `launch_scenario` doesn't synthesise |
| `open_client` | **Open a browser and connect it to a room** — the missing half of the relay tools, which all need a connected admin client. `{roomId? \| url?, headless=true, width=1280, height=800, waitReady=true, waitReadyMs=60000}` → `{pid, roomId, url, headless, profileDir, connected, clientId, readyState}`. `{roomId}` reuses the attach URL **remembered from that room's launch** (the host session token is issued once by `/api/rooms/direct` and cannot be rebuilt, so a room this server did not launch needs an explicit `url` — the refusal says so). Returns only once the relay actually answers: `connected:true` is a real client, not just a started process | Attaching a client to a room you launched earlier, or to any URL |
| `close_client` | Close browsers this server opened: `{pid}` \| `{roomId}` \| `{all:true}`, `timeoutMs=5000`. SIGTERM to the process **group** → poll → SIGKILL. Read the `outcome`: `exited` clean, `killed_after_timeout` = SIGTERM ignored, `kill_failed` = needs a human. **Refuses any pid it did not launch** | Closing a client without ending the game |
| `list_clients` | The browsers this server launched — `{pid, roomId, url, headless, profileDir, startedAt, alive}`, liveness re-probed every call (never cached). Only ever its own; a browser you opened by hand is invisible here and is never signalled | "Is a client attached, and is it still alive?" |
| `wait_for_game` | Poll `probe_game` until a phase or frame is reached. `{roomId?, until=ready\|ticking\|frame, frame?, timeoutMs=120000, pollMs=500}`. **Returns immediately with `phase:'dead'` + `lastLogs` if the server dies**; a timeout returns `timedOut:true` plus the last probe. `until:'ready'` is satisfied by ready OR ticking | The one wait. Never hand-roll a readiness poll |
| `probe_game` | One-shot readiness phase for a room: `spawning` → `loading` → `ready` → `ticking`, or `dead`. `{roomId?}` → `{phase, pid, port, ready, clientCount, statusAgeSec, frame, simFps, detail}` | "Is this game up, still booting, or gone?" — the honest answer in one call |
| `end_game` | Gracefully stop a room's spring-server: SIGTERM (clean exit + war-log drain + exit checkpoint) → poll → SIGKILL on timeout. `{roomId, graceful=true, timeoutMs=10000, escalate=true}`. Returns the drain-quality report — `{source, outcome, frame, label, lossy, resume_eligibility, exited, escalated, waitedMs, describe}`. `roomId` is **required** — called bare it refuses with a candidate list. `source:'sigterm-fallback'` means the lobby predates `POST /api/admin/rooms/end` and there is no checkpoint verification. `kill_game` is the **deprecated** `graceful:false` alias (immediate SIGKILL — only when a graceful stop is pointless, e.g. wedged in precache) | **The default teardown verb** for every game you launched |
| `list_stack` | **Everything running, classified, in one call** — `{findings, processes, ports, authority, gameStatus, binaries, mprocs, summary}`. Finds what `list_processes` structurally cannot: `stray-server` (hand-launched server the lobby doesn't know), `zombie-port` (a squatter on 9100-10099 — room routing is by port, so it blocks the next room), `duplicate-lobby`, `orphan-vite` (a vite on a fallback port silently drives the wrong stack), `stale-status-row`, `binary-drift` (**the lobby forks `build/release/spring-server` when it exists — a debug-only rebuild is invisible**) and, with `probeHashes:true`, `stale-binary-running`. Read-only; never connects to the mprocs port | **First move when anything is weird**: a launch that won't come up, auth failing on a fresh room, a fix that "didn't take" |
| `cleanup_stack` | Kill the non-managed findings. **`dryRun` defaults to `true`** — it returns the plan (pid, kind, signal sequence) and touches nothing; re-run with `dryRun:false`. SIGTERM → poll 5 s → SIGKILL. Never kills the `:8011` lobby; never touches `managed` (use `end_game({roomId})` for a real game); refuses `stray-server` when the lobby is unreachable (no authority ⇒ "stray" is unprovable); `zombie-port` on a non-`spring-server` command needs `force:true` | Clearing strays and port squatters before a clean run |
| `list_processes` | Game servers the lobby manages, as **JSON**: `{servers:[{roomId, port, pid, state, gameId, mapId, ready, clientCount, heartbeatAgeSec, heartbeatStale, identity}], count}`. `identity` is `{stamp, engineHash, pid}` from the server's `/api/metrics` (`null` on a pre-P8 binary) | Checking if a game is running, and which build is serving it |
| `get_logs` | Fetch recent log entries (filter by level, section, scope, room). **Always pass your own `roomId`** — the default is all rooms | Checking server output, finding errors |
| `search_logs` | Full-text search across all logs (same filters) | Finding specific errors or patterns |
| `exec_lua` | Execute Lua code in LuaRules, LuaGaia, or server scope. In `server` scope a leading `json ` token (`json state`, `json units 0`, `json unit_state 42`) returns a JSON object instead of free text — see [structured server verbs](../../../docs/debugging-tools.md#structured-server-verbs-json-prefix) | Testing gadgets, inspecting game state |
| `query_db` | Run read-only SQL against the lobby database (only row-returning statements: SELECT, `WITH … SELECT`, EXPLAIN, PRAGMA reads) | Checking users, sessions, room state |
| `get_frame` | Sim `frame`/`simFps`/`clients` via the public `/api/metrics` — no exec, no auth | Cheap liveness poll; works paused, pre-GameStart, and under `SPRING_PROD` |
| `get_game_state` | Sim state as an **object**: `{frame, paused, speed, teams, units, luaHeapKb}` | Checking if sim is ticking; reading paused/speed without a second call |
| `list_units` | Units as an **object**: `{total, returned, units:[{id, def, team, hp, maxHp, x, y, z}]}` — `total` counts every match of the team filter, `units` caps at 100 rows | Debugging combat, spawning; positions without a Lua round-trip |
| `list_gadgets` | Loaded synced gadgets as an **object**: `{count, gadgets:[{name, basename, layer, author?}]}`, read from the gadget handler's own registry in call order | Checking which gadgets are active, and their layer order |
| `get_lua_source` | Read a Lua file straight off disk — `{gameId, filePath}` → `data/games/<gameId>/<filePath>` (case-insensitive resolve). No HTTP, no running lobby needed | Reading gadget source when debugging errors |
| `list_sessions` | List recent game sessions from the log server | Post-mortem, history |
| `validate_scenario` | **Offline** — replicates BOTH scenario parsers (lobby bare-`lua_State` discovery + `game_scenario.lua`'s GameStart `validate()`) with no stack running. `{scenarioId \| luaSource, gameId='metalstorm', passability?}` → `{ok, findings[{severity, rule, path, message}], counts, defsSource}` | Before writing or launching any scenario. `skipped` findings mean **not checked**, never "fine" |
| `write_scenario` | Validate → write `scenarios/<id>.lua` → resync the lobby → **confirm** it is offered. `{scenarioId, luaSource, gameId?, overwrite?, force?, resync=true}` → `{written, file, findings, resync, offered}`. Errors always block; warnings block unless `force`. Refuses the `gen_` prefix | Authoring a scenario. Without the resync the picker and `launch_scenario` cannot see the file at all |
| `list_scenarios` | Discovery view + generated-war provenance (seed, params, createdBy), rows tagged `source: authored\|generated`. `{gameId?}` | "What wars exist, and where did this one come from?" |
| `generate_scenario` | Wraps the admin generator route. `{mapId, seed?, sides?, towns?, outposts?, bases?, mines?, sites?, relics?, wrecks?, bridges?, hostility?, roster?}`. Seed defaults to `sum(ord(c) for c in mapId)`, so a re-run is an **idempotent upsert**; a 422 carries the generator's own `REJECTED` line | Making a new war for a map without hand-authoring one |
| `restart_lobby` | Restart the lobby server in-place (re-exec, same PID, preserves game servers) | After rebuilding spring-lobby binary |
| `restart_logserver` | Restart the log server (:8010) in-place (re-exec, same PID) | After rebuilding spring-logserver, or if the log pipeline stops responding |
| `restart_game` | Restart a game server in-place (re-exec with same args, same PID) | After rebuilding spring-server binary |
| `restart_client` | Restart the Vite client pane (:8012) via the mprocs control channel; `{clearCache?}` also wipes `client/node_modules/.vite` | After editing a worker-imported client file (`entity-renderer.ts`, `game-processor.ts`) that Vite serves stale |
| `api_request` | Authenticated HTTP request to lobby/log/game server (auto-manages token) | Hitting endpoints without curl + manual token plumbing |

This server also exposes the browser relay tools (`client_eval`, `client_ready`, `client_screenshot`, `browser_test`, `evaluate_widget_lua`, `spawn_at_camera` — these **run code in a connected browser and return the answer**, falling back to printing a chrome-devtools snippet when one of the relay's three gates refuses) and the server-side test verbs (`spawn_unit`, `give_order`, `set_los`, `set_cheats`, `set_unit_invulnerable`, `get_unit_def`, `list_unit_defs`, `get_weapon_def`, `clear_defs_cache`, etc.) — documented in the **`spring-test`** skill and [docs/debugging-tools.md](../../../docs/debugging-tools.md#available-tools), plus performance profiling in [docs/debugging-performance.md](../../../docs/debugging-performance.md).

## Self-diagnosis: SQLite binding & SPRING_DB (read this when probes look wrong)

Two formerly-silent degradations now announce themselves — believe the message, don't debug around it:

- **`sqliteUnavailable`**: the better-sqlite3 native binding was built for a different node (NODE_MODULE_VERSION mismatch — the MCP must run under **node v22**, the `.mcp.json` default). The server prints one `SQLITE DISABLED:` stderr line at boot with the exact rebuild command, and the flag rides every affected result: `query_db` errors with it, `probe_game` reports `game_status unreadable`, `list_processes`/`list_stack`/`launch_*` carry it top-level.
- **SPRING_DB divergence `warning`**: the lobby vouches for a *running* server (pid > 0) but `game_status` has no row → the MCP is reading a different database than the lobby's `--db`. `probe_game` stays `spawning` forever but carries a `warning` naming the mismatch (the launch tools push it into `notes`). **This should now be rare**: with no `SPRING_DB` set, the MCP reads the running lobby's own `--db` off its command line and follows it (one `SPRING_DB: following …` line on stderr at boot), which is why `.mcp.json` no longer pins one — scratch dbs are routine here and a pinned path rots. Setting `SPRING_DB` explicitly still wins over detection, so an *explicit* value is now the likeliest cause of a divergence. A hibernated room (pid 0, port 0) has no row and is not a divergence; it no longer warns.

Details: [docs/debugging-tools.md](../../../docs/debugging-tools.md#mcp-server-setup) (setup + the "Readiness phases, and the one way they lie" section).

## Arguments are checked before the call runs

A missing **required** argument, or a near-miss field name, is refused up front
by name — it no longer reaches the handler to fail as a driver error or a raw
verb usage line. The one worth knowing about is the typo case: `set_los
{enabled:true}` (the field is `enable`) used to be read as *no arguments*, so
the tool took its documented "omit ⇒ report current state" branch and answered
`ally0=off …`, which reads like confirmation it turned LOS off. Now it says
`no argument "enabled" — did you mean "enable"?`. Unrelated extra properties
are still passed through untouched.

## Server URLs & port discovery

- Lobby: `http://127.0.0.1:8011` (fixed) · Log server: `http://127.0.0.1:8010` (fixed) · Game servers: **dynamic ports** (9100+), possibly several at once.
- Never hardcode a game port — `list_processes` (or `probe_game {roomId}`) discovers them; every room-scoped tool takes `roomId` and routes itself. Override endpoints via `LOBBY_URL`, `GAME_SERVER_URL`, `LOG_SERVER_URL` env in `.mcp.json`.

## Auth

The MCP server auto-authenticates via `SPRING_TOKEN` env var, or falls back to `SPRING_USER`/`SPRING_PASS` (defaults to admin/admin). All tools that hit the lobby or game server reuse the cached token — you do not need to log in or pass a token from the tool side.

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
```

Prefer `exec_lua` for Lua snippets and `query_db` for SQL — `api_request` is the escape hatch.

## Room hygiene

1. **Track the `roomId` your launch returned and pass it explicitly everywhere** (`get_game_state`, `exec_lua`, `spawn_unit`, `get_logs`, …). Do **not** rely on the "first active game" auto-detect — with concurrent sessions it picks up a stale or someone else's room. Only `end_game` rooms you launched.
2. **Let the launch open the browser (`openBrowser:true`), or `open_client({roomId})` after the fact** — both use the `browserUrl` below, so the rules about it still apply. Doing it by hand is only for a browser this server should not own. `browserUrl` is `?play=<scenarioId>&room=<id>#token=…` — `?play=<scenarioId>&room=<id>#token=…` auto-auths with the host's own direct-minted session and attaches to that exact room; saved-room state never gets a say. Only `?play=` gives `?room=` any meaning; bare `?room=` / `autojoin` / `hidestartup` are read nowhere. Two facts that read as bugs otherwise: re-launching the same scenario **replaces** the previous room by name (the direct route's contract), and the lobby's scenario list is a **startup snapshot** — a file authored after lobby boot needs `write_scenario`'s resync (or `api_request POST /api/admin/scenarios/resync`, or `force:true` + `mapId`). Requires the lobby run with `--dev-direct-start` (mprocs does; a 404 from the tool says exactly this).
3. **Browserless runs self-exit** — `openBrowser:true` sidesteps this entirely, since the client attaches within seconds and the sim starts. It still applies to any deliberately browserless run. With no client attached, the default **120 s** startup grace kills the server at frame −1. Pass `idleGraceSeconds` to `launch_scenario`/`launch_direct` (lands in the manifest as `idleStartupGraceSeconds`, forwarded as `--idle-startup-grace-seconds`; confirm with `ps -o args= -p <pid>`). It does **not** make a human-roster sim tick — GameStart still holds until the rostered humans connect, so `wait:'ready'` is the reachable target unless you roster AI-only or use `sessionKind:'persistent'`. A lobby binary older than P3 ignores the field **without error**; the fallback is `SPRING_IDLE_STARTUP_GRACE_SECONDS` in the *lobby's* environment (inherited by every room it spawns, so pair it with `end_game`).
4. **Restarting a room cleanly:** `end_game` it first and *then* launch. A same-name `launch_direct` also SIGTERMs, but it immediately deletes the room and respawns, so you get no drain report.
5. **Lobby-UI testing only:** the player-facing room lifecycle is **leave-only** (`/api/rooms/end` and `/api/rooms/close` no longer exist) — `await window.lobby.leave()` when finished; when the last member leaves, the lobby deletes the room and reaps the server. The browser auto-reconnects to `localStorage['springrts-game-room']`, so `leave()` (or remove that key) before `joinRoom(<id>)`. The roster/login discipline for this path lives in the **game-browser-test** skill.

## Authoring scenarios

**Validate before you write, and never trust a silent success.** Read `counts.skipped` and the warnings, not just `ok` — a war with no `world.map` is a `warning`, not an error (the lobby stores it with an empty map affinity rather than rejecting it), and it means every map-dependent pass was skipped. A scenario file is read by two different parsers with two different silent failures, and `validate_scenario` is the only thing that sees both without a boot. The loop: `validate_scenario({luaSource})` until zero errors → `write_scenario` (re-validates, writes, resyncs, **confirms `offered:true`**) → `launch_scenario`. Three traps it exists for: (a) a file that touches `VFS`/`Spring.*`/`GG` **at file scope** loads fine in-game and is *invisible in the lobby forever* — the lobby's discovery pass is a bare `lua_State`; (b) `skipped` findings mean **not checked** (no baked def cache ⇒ every unknown-def rule was skipped — run a game once to bake); (c) never write a `gen_*` file — the scenario DB owns that namespace and its orphan sweep deletes any it does not claim.

**Sequencing a war (multi-stage objectives): `phases`, not `parentId`.** An objective can carry `phases = { {childDefs…}, {childDefs…} }` — phase 2's children are created only once every phase-1 child completes, and any child that fails or expires fails the whole chain. Two traps: the **parent is itself a real objective** and must validate for its declared type, or `Create` rejects it and *the entire chain silently does not exist*; and `parentId`/`linkedId` take **runtime ids the engine mints at stage time**, so a file can never fill them in. `validate_scenario` catches every mis-shape (`objective-phases`, `objective-chain-id`).

Format reference and every rule id: **[docs/scenarios.md](../../../docs/scenarios.md)**. A war's authored briefing is visible without launching anything: `api_request GET /api/games/metalstorm/scenarios` returns a `briefing` object per scenario that has one.

## Restarting servers in-place

After rebuilding binaries, restart servers without disrupting the lobby room lifecycle.

The three **C++** restart tools (`restart_lobby`/`restart_logserver`/`restart_game`) **re-exec the process in place — the PID is preserved**, so mprocs stays authoritative and never sees a crash + respawn. **Prefer these over `kill` + relaunch**: hand-launching outside mprocs leaves the mprocs-managed pane dead and can spawn duplicate listeners on the same port (SO_REUSEPORT round-robin), so requests hit a stale pre-rebuild binary. If you end up with duplicates, `list_stack` names them (`duplicate-lobby`) — kill the extras and restart the survivor via these tools.

`restart_client` is the equivalent for the **Vite** dev server (no in-place re-exec): it restarts the `client` pane through the mprocs remote-control channel (`mprocs.yaml` `server:` key → `select-proc` + `restart-proc`). Use it after editing a worker-imported client file (`entity-renderer.ts`, `game-processor.ts`, …) — Vite serves a stale `?worker` bundle otherwise. It requires mprocs started with the `server:` key; if not, it falls back to kill+relaunch and says so. See [docs/debugging-tools.md](../../../docs/debugging-tools.md) "mprocs Development Environment → Remote control".

- **Lobby** (`restart_lobby`): persists running game-server PIDs/ports to SQLite so active games survive. Also via `SIGHUP` or `POST /api/exec {"scope":"lobby","code":"restart"}`. Re-runs the same startup recovery as a cold start (adopt-or-reset); a fresh-launched game's roster handoff is not broken by it.
- **Log server** (`restart_logserver`): use if `get_logs`/`search_logs` start failing with `fetch failed`. Also via `SIGHUP` or `POST /api/logs/restart`.
- **Game server** (`restart_game`): broadcasts `GameRestarting` to clients, which reload and reconnect. Also via `SIGHUP` or `POST /api/restart` on the game port. Use instead of end→relaunch when iterating on server code.

## Camera control

The camera lives **only in the browser** (the `RTSCamera` instance, `client/src/core/rts-camera.ts`). There are no camera MCP tools — drive it through the relay (`browser_test` / `client_eval({target:'test'})`) or a chrome-devtools `evaluate_script`. `window.test.*` is **the** surface — there is no `window.camera`; it was documented for years but never installed. Read the live pose with `window.test.cameraPose()` → `{pos:{x,y,z}, lookAt:{x,y,z}}`. Camera calls settle before they resolve, so a screenshot straight after one is safe; for framing that must not drift use `test.withStableCamera(fn)` (locks input, re-checks the pose afterwards and reports drift) or `test.lockInput(true)`.

### Coordinate system (read this first)
World positions are **positive** in `[0, mapX] × [0, mapZ]` (Option A — handedness is a *direction/basis* convention, not positional; see `PLAN-coordinate-system-option-a.md`). The camera shares the server's world coordinates — **no flip**. So a value from `Spring.GetUnitPosition(id)` feeds straight into the camera. `heading = 0` faces −Z; the map grows in +X/+Z.

### Canonical methods (all on `window.test`)
- **World point:** `cameraSnapToGround(x, z, {height, pitchDeg, durationMs})` — look-at lands on `(x, groundY, z)` with explicit framing. **Preferred** for precise, deterministic control.
- `focusOn(x, z, durationMs)` — pans to world `(x, z)` but **keeps the current camera→look-at offset/distance**, so a far/zoomed-out camera stays far. Takes **two** world coords.
- **A unit:** `cameraSnapToUnit(unitId, …)` / `focus(unitId)` — but see the viewport caveat below.
- **A group:** `cameraFitUnits([id,…], {pitchDeg, padding, durationMs})` — frames the bounding box. The player-facing tracking camera (`setTrackingCamera(true)`, `T` key) re-fits the live **selection** every tick via the same path.

### Pitfalls (all hit in practice)
1. `focusOn(x, z)` takes **two world coords**. `focusOn(unitId)` is a bug — the id is read as `x`, `z` is `undefined`, and the camera flies off-map. To target a unit use `cameraSnapToUnit(id)` / `focus(id)`.
2. **Never** set `scene.activeCamera.position` / `.setTarget(...)` directly. `RTSCamera` keeps its own `lookAt`; bypassing it desyncs that state, and the *next* animated `focusOn` computes `offset = camera.position − lookAt` from the stale value and hurls the camera thousands of elmos off-map (e.g. `x = −13197`). Always go through `window.test`.
3. Animated moves (`durationMs > 0`) preserve the current offset/distance. For a tight, deterministic frame use `cameraSnapToGround` / `cameraSnapToUnit` with explicit `height` + `pitchDeg` and `durationMs: 0`.
4. The game camera controller does **not** fight a programmatic pose **unless tracking is on** (`window.test.setTrackingCamera(false)` to be sure) — tracking re-fits the selection every tick and will override your pose.

### Unit/group targeting is viewport-bound — use server positions
`cameraSnapToUnit` / `cameraFitUnits` / `focus(unitId)` resolve positions via the client's `getEntityPosition` — an **internal** renderer method (interpolated, viewport-streamed state), **not** a Spring API. The server **viewport-filters unit state**: it streams only units near the registered viewport. (Projectiles are *broadcast* to every client, so FX appear even where units don't.) So an off-screen unit — or a `spawn_unit`-spawned test unit the viewport never covered — has no client position, and these methods fail with `no client-side position for unit N`.

Reliable recipe — get the authoritative position from the server, then point the camera:
```js
const r = await window.test.lua('local x,y,z=Spring.GetUnitPosition(ID) return x..","..z');
const [x, z] = r.split(',').map(Number);
await window.test.cameraSnapToGround(x, z, { height: 700, pitchDeg: 60, durationMs: 0 });
```
From the MCP side the same position comes from `list_units` or `exec_lua` (scope `LuaRules`, `return Spring.GetUnitPosition(ID)`) — server-authoritative and viewport-independent.

### FX visibility
The forward FX light pool culls emissions **> 7000 elmos** from the camera. To see projectile / weapon-FX lights (and faithful deferred projectile lights), the camera must be near the action — frame the combat first, then observe.

## Browser automation

**This server manages its own browsers.** `launch_scenario({openBrowser:true})` / `open_client` launch one, `list_clients` shows them, `close_client` and `end_game` take them down. Headless by default, one throwaway profile per launch, and the whole process **group** is signalled on close — Chrome is a process tree, and killing the bare parent leaves GPU-holding renderers behind (that has cost real perf sessions here). If this process dies, it takes its browsers with it, so nothing is orphaned.

Two limits worth knowing: the registry is **in-memory**, so browsers do not survive an MCP restart (they are killed, not adopted); and `close_client` **refuses any pid it did not launch** — a browser you opened by hand stays yours to close.

With a client connected, prefer the relay tools (`client_eval`, `browser_test`, `client_screenshot`) — they need no devtools session. When you do need CDP (DOM inspection, network, clicks), **always use `mcp__chrome-devtools__*` tools**. Never use `mcp__claude-in-chrome__*` tools — mixing the two spawns a separate browser window and breaks page context.

## Troubleshooting

If tools return connection errors, the servers aren't running. **Don't hand-launch
them** — they are mprocs-managed, and a second lobby on `:8011` causes port races
that read as protocol bugs. Bring the stack up through its manager:

```bash
.claude/skills/run-springrts-web/smoke.sh --start   # start-bg if down, then verify
tools/scripts/spring-services.sh status            # or restart <client|lobby|logserver|all>
```

If something is up but wrong — a stray server, a squatted port, a live process
running a binary you already rebuilt — `list_stack` names it (`stray-server`,
`zombie-port`, `stale-binary-running`, `binary-drift`) and `cleanup_stack`
(dry-run by default) removes what is not managed. Neither ever connects to
mprocs' control port, and `cleanup_stack` refuses to kill the lobby.

If probes look wrong while the game demonstrably runs, re-read
"Self-diagnosis: SQLite binding & SPRING_DB" above.
