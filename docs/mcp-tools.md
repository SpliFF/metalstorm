<!-- GENERATED FILE — do not edit by hand.
     Source: tools/debug-mcp/tools.js (schemas) + tool-meta.js (sections and prose).
     Regenerate: cd tools/debug-mcp && npm run docs -->

# spring-debug MCP tool reference

Every tool the `spring-debug` MCP server (`tools/debug-mcp/server.js`) exposes, generated from
the schemas themselves so the names, types, defaults and required fields cannot drift from what
a caller actually gets. For setup, the SQLite/`SPRING_DB` rules and the hand-written narrative
sections, see [debugging-tools.md § Claude / MCP Integration](debugging-tools.md#claude--mcp-integration).

81 tools in 13 groups.

## Rules that apply to everything

**Every network call has a deadline.** A lobby that accepts the connection and never answers used to hang a tool for ever. The MCP stamps a 15 s default on any fetch that does not bring its own (`SPRING_MCP_HTTP_TIMEOUT_MS`); `/api/exec` gets 60 s (`SPRING_MCP_EXEC_TIMEOUT_MS`); the browser relay gets its `timeoutMs` + 5 s; `api_request` takes a `timeoutMs` (default 30 s, clamped 0.5–300 s); and `world_notifications` sets its own from `listenMs`. A tool that hangs is a bug in this rule, not a slow server.

**`roomId` is a room id, not a port.** An ENDED room's row keeps its port, and ports get reused: `roomId:7` on a dead room used to answer from whichever live server had since bound `:9100`. An explicit `roomId` is now refused when the row is ended, hibernated or its pid is gone — naming the room that squats the port — and a value that looks like a port is told so. Omitting `roomId` auto-picks the single live room and never a dead one.

**Session tokens are redacted.** `launch_scenario` and `launch_direct` return a `sessions` map of live bearer tokens. The values are replaced unless you pass `revealTokens:true`. `browserUrl` deliberately keeps its `#token=` fragment — that fragment IS the attach mechanism. `world_notifications` never returns its stream ticket at all.

**The game server's HTTP loop is single-threaded.** Code relayed into the browser must never call back into the game server that is waiting for its answer — the server is blocked on the relay response, so the callback cannot be served and both sides wait out the timeout. Fetch what you need first, then evaluate.

**The three gates on every relayed tool.** The relay route is compiled out under `SPRING_PROD`; only an admin-role session is addressed (a `/api/rooms/direct` dev account is role "player" and is NEVER eligible — `launch_scenario`'s default player IS admin); and the browser refuses unless it is a DEV build or was booted with `?allowClientEval=1`. When a gate refuses, the tool prints the chrome-devtools snippet to paste by hand instead of erroring.

**Arguments are enforced.** A missing `required` field is refused by name, and an unknown property within a small edit distance of a real one is treated as a TYPO rather than an ignored extra — `set_los {enabled:true}` (the field is `enable`) used to read as "no arguments" and answer as if you had asked a question. `npm run check` diffs every schema against what its handler actually reads, so neither list can drift from the other.

**One live stack per machine.** The lobby/logserver/vite you see running almost always belong to the USER's own interactive mprocs — this MCP is a guest on that box, not its owner. `stack_start` refuses outright if any of :8010/:8011/:8012 is already held, rather than racing a second lobby onto the same db (SO_REUSEPORT round-robins accepts between them — see `list_stack`'s duplicate-lobby finding). `cleanup_stack` refuses to kill ANY pid it did not itself start via `stack_start`, for the same reason, in both cases only overridable with `force:true` — and even then, only after actually looking (`list_stack`) at what you are about to kill.

## Index

- **Logs** — `get_logs`, `search_logs`, `lobby_log`
- **Reading the sim** — `get_game_state`, `list_units`, `get_unit_state`, `get_frame`, `get_combat_summary`, `list_gadgets`, `profile`
- **Executing code** — `exec_lua`, `api_request`
- **Driving the sim** — `spawn_unit`, `kill_unit`, `damage_unit`, `give_order`, `clear_units`, `revive_team`, `set_stockpile`, `set_debug_logging`, `pause_sim`, `set_sim_speed`, `step_sim`, `set_los`, `set_cheats`, `set_unit_invulnerable`, `drive_pattern`, `populate_tranche`
- **Unit and weapon defs** — `get_unit_def`, `list_unit_defs`, `get_weapon_def`, `clear_defs_cache`, `get_lua_source`
- **Processes, rooms and readiness** — `list_processes`, `list_stack`, `cleanup_stack`, `probe_game`, `wait_for_game`, `query_db`, `list_sessions`
- **Starting and stopping** — `launch_scenario`, `launch_direct`, `launch_game`, `end_game`, `kill_game`, `restart_lobby`, `restart_logserver`, `restart_game`, `restart_client`, `stack_start`
- **Scenarios** — `list_scenarios`, `validate_scenario`, `write_scenario`, `generate_scenario`
- **The browser client** — `open_client`, `close_client`, `list_clients`, `client_eval`, `client_ready`, `client_screenshot`, `browser_test`, `evaluate_widget_lua`, `spawn_at_camera`
- **Looking at things** — `capture_subject`, `capture_sequence`, `order_and_film`
- **The world layer** — `world_status`, `world_pois`, `world_factions`, `world_claims`, `world_commit`, `world_commit_cancel`, `world_seasons`, `world_pause`, `world_notifications`
- **AI players** — `ai_list`, `ai_health`, `ai_directives`, `ai_guidance`, `ai_context`
- **Natural language** — `nl_command`

## Logs

The log server is the only source that survives a server's death. Scope every query — an unscoped search is "the whole log", and the limit is clamped to 1000 for that reason. Exception: the lobby's own stdout/stderr is never posted to the log server at all — use `lobby_log` for that.

#### `get_logs`

Get recent log entries from the log server. Returns structured log entries with level, section, scope, process, frame, room_id, game_id, and message. Pass roomId to scope to a single game/room (each game server tags its logs with its room).

| Argument | Meaning |
|---|---|
| `roomId` (number, default `0`) | Room ID — scope to one game instance (0 for all) |
| `game` (string) | Filter by game content id (e.g. "metalstorm") |
| `level` (number, default `0`) | Minimum log level (0=DEBUG, 2=NOTICE, 4=ERROR) |
| `section` (string) | Filter by section (e.g. "lua", "sim", "server") |
| `scope` (string) | Filter by scope (e.g. "LuaRules", "LuaGaia") |
| `sinceMinutes` (number) | Only entries from the last N minutes (recency window) |
| `limit` (number, default `50`) | Max entries to return |

#### `search_logs`

Full-text search across log entries. Scope a search to a single room/game and/or a recent time window to avoid a flood of historical logs — e.g. search_logs(query:"error", roomId:5, sinceMinutes:10).

| Argument | Meaning |
|---|---|
| `query` (string) | Search text (substring match on message). Optional if a roomId/game filter is given. |
| `roomId` (number) | Scope to one room/game instance (0 or omit for all) |
| `game` (string) | Filter by game content id (e.g. "metalstorm") |
| `section` (string) | Filter by section (e.g. "lua", "sim") |
| `level` (number) | Minimum log level |
| `sinceMinutes` (number) | Only entries from the last N minutes (recency window) |
| `limit` (number, default `50`) | Max entries |

#### `lobby_log`

Tail the lobby process's own stdout/stderr. NOT covered by get_logs/search_logs — those read the log server, which the lobby never posts its own startup/crash output to; this is the only MCP-side view of it. Reads .tasks/logs/stack-lobby.log, which only exists once the lobby has been started with stack_start — a lobby started from the user's own interactive mprocs TUI keeps its output in the mprocs pane only, nothing on disk. When the file is missing this says so and points at the mprocs pane / `spring-services.sh status` instead of erroring.

| Argument | Meaning |
|---|---|
| `lines` (number, default `200`) | Tail this many lines from the end of the log. Default 200. |

## Reading the sim

Read-only views of a running game. The `json ` verb prefix is a capability probe: a server predating it answers `unknown command: json <verb>` and these tools fall back to the legacy text.

#### `get_game_state`

Get current game state summary from the game server. Returns a JSON object {frame, paused, speed, teams, units, luaHeapKb} (luaHeapKb is 0 when LuaRules is not loaded). Against a game server that predates the `json ` exec prefix it falls back to the legacy one-line text "frame=N teams=N units=N".

| Argument | Meaning |
|---|---|
| `roomId` (number) | Room/game server ID (auto-detected if omitted) |

#### `list_units`

List units in the game, optionally filtered by team. Returns a JSON object {total, returned, units:[{id, def, team, hp, maxHp, x, y, z}]} — `total` counts every match of the team filter, `units` is capped at 100 rows (`returned`). Falls back to legacy text against a pre-`json ` game server.

| Argument | Meaning |
|---|---|
| `team` (number, default `-1`) | Team ID (-1 for all) |
| `roomId` (number) | Room/game server ID (auto-detected if omitted) |

#### `get_unit_state`

Dump health, position, team, weapons, and per-weapon target/range/reload state for a single unit. Reads sim state directly (no Lua round-trip). Returns a JSON object {id, def, team, hp, maxHp, pos:{x,y,z}, heading, weapons:[{index, def, range, reloadFrame, hasTarget}]} — `index` is the unit's own weapon slot (null slots are skipped, so the array can be shorter). Falls back to legacy text against a pre-`json ` game server.

| Argument | Meaning |
|---|---|
| `unitId` (number, **required**) |  |
| `roomId` (number) |  |

#### `get_frame`

Current sim frame + simFps via the public /api/metrics endpoint (no exec, no auth, works while paused).

| Argument | Meaning |
|---|---|
| `roomId` (number) | Room/game server ID (auto-detected if omitted) |

#### `get_combat_summary`

Quick-look queue depths for combat events and sound events still pending broadcast. Useful for sanity-checking that combat is actually happening. Returns a JSON object {combat, sounds}; falls back to legacy text against a pre-`json ` game server.

| Argument | Meaning |
|---|---|
| `roomId` (number) |  |

#### `list_gadgets`

List loaded Lua gadgets and their status on the game server.

| Argument | Meaning |
|---|---|
| `roomId` (number) | Room/game server ID (auto-detected if omitted) |

#### `profile`

Server-side profilers. target=lua → per-callin synced Lua wall-time; target=sim → SimFrame phase split (native sim / unit scripts / Lua call-ins, also surfaced under /api/metrics simFrame). action: on\|off\|reset\|status\|report.

| Argument | Meaning |
|---|---|
| `target` (string, `lua`\|`sim`, **required**) |  |
| `action` (string, `on`\|`off`\|`reset`\|`status`\|`report`, default `"report"`) |  |
| `topN` (number) | Row cap for target=lua report (default 25). |
| `roomId` (number) | Room/game server ID (auto-detected if omitted) |

## Executing code

Arbitrary-code channels into the sim. Both are compiled out under `SPRING_PROD`; a 404 from either means you are talking to a production binary.

#### `exec_lua`

Execute Lua code in a specific scope on the game server. Use scope "LuaRules" for game-wide gadgets, "LuaGaia" for map gadgets, "server" for server commands.

| Argument | Meaning |
|---|---|
| `scope` (string, `LuaRules`\|`LuaGaia`\|`server`, **required**) | Execution scope |
| `code` (string, **required**) | Lua code or server command to execute |
| `roomId` (number) | Room/game server ID (auto-detected if omitted) |

#### `api_request`

Make an authenticated HTTP request to the lobby, log server, or a specific game server. Tokens are obtained automatically (admin/admin by default — override via SPRING_USER/SPRING_PASS env). Prefer this over running curl + setting Authorization headers manually.

| Argument | Meaning |
|---|---|
| `target` (string, `lobby`\|`log`\|`game`\|`url`, default `"lobby"`) | Which server to hit. "lobby" → :8011, "log" → :8010, "game" → dynamic game server (uses roomId or first running), "url" → use the absolute `url` arg verbatim. |
| `path` (string) | Path beginning with "/", e.g. "/api/rooms". Ignored when target="url". |
| `url` (string) | Absolute URL (only when target="url"). |
| `method` (string, `GET`\|`POST`\|`PUT`\|`DELETE`\|`PATCH`, default `"GET"`) |  |
| `body` | Request body. Plain object/array → JSON, string → sent verbatim. |
| `headers` (object) | Extra request headers as a {name: value} map. |
| `roomId` (number) | Game server room ID (when target="game"). Omit to pick the first active game. |
| `auth` (boolean, default `true`) | Attach Bearer auth header. Set false for unauthenticated probes. |
| `expectJson` (boolean, default `true`) | Parse the response as JSON when true; otherwise return raw text. |
| `timeoutMs` (number, default `30000`) | Abort the request after this long (500–300000). Every MCP network call has a deadline; this is the one you can raise for a slow admin route. |

## Driving the sim

The scripted test verbs. Every argument is validated by name before the verb string is built (`verb-args.js`) — an extra token would shift every positional field of the verb, which is a silent wrong-unit bug rather than an error.

#### `spawn_unit`

Spawn one or more units of a given def at a world XZ position on a team. Wraps the LuaExecEngine `server spawn` verb (which delegates to Spring.CreateUnit on the LuaRules synced state, so Allow* veto rules apply). Y is auto-resolved via Spring.GetGroundHeight. When count > 1 the server lays them out in a square grid 48 elmos apart. Returns a JSON object {spawned, ids:[...]}; falls back to the legacy "spawned N unit(s): ..." text against a pre-`json ` game server.

| Argument | Meaning |
|---|---|
| `defName` (string, **required**) | Unit def name (e.g. "fable_tank"). |
| `x` (number, **required**) | World X coordinate (elmos). |
| `z` (number, **required**) | World Z coordinate (elmos). |
| `team` (number, default `0`) | Owning team ID |
| `count` (number, default `1`) | How many to spawn (max 256) |
| `roomId` (number) | Room/game server ID (auto-detected if omitted) |

#### `kill_unit`

Destroy a unit by ID via Spring.DestroyUnit. Optional self-destruct flag (plays the unit's death animation/explosion) and reclaim flag (drops a wreckage feature instead of nothing).

| Argument | Meaning |
|---|---|
| `unitId` (number, **required**) | Sim unit ID to destroy. |
| `selfDestruct` (boolean, default `false`) |  |
| `reclaimed` (boolean, default `false`) |  |
| `roomId` (number) |  |

#### `damage_unit`

Apply damage to a unit via Spring.AddUnitDamage. Returns the post-damage health.

| Argument | Meaning |
|---|---|
| `unitId` (number, **required**) |  |
| `amount` (number, **required**) | HP of damage to apply. |
| `paralyze` (boolean, default `false`) |  |
| `roomId` (number) |  |

#### `give_order`

Issue a single command to a unit via Spring.GiveOrderToUnit. Use the standard CMD.* numeric IDs (10=MOVE, 20=ATTACK, 0=STOP, 90=RECLAIM, 25=GUARD, 15=PATROL, 16=FIGHT, etc. — see client/src/core/command-buffer.ts for the full table).

| Argument | Meaning |
|---|---|
| `unitId` (number, **required**) |  |
| `cmdId` (number, **required**) | Spring command ID, e.g. 10=MOVE, 20=ATTACK. |
| `params` (array, default `[]`) | Up to 4 numeric params (e.g. [x,y,z] for MOVE, [targetUnitId] for ATTACK). |
| `opts` (number, default `0`) | Spring command-options bitfield (32=SHIFT/queue). |
| `roomId` (number) |  |

#### `clear_units`

Wipe every unit (or every unit on a team) via Spring.DestroyUnit on each. Useful between test cases.

| Argument | Meaning |
|---|---|
| `team` (number) | Team ID. Omit to clear ALL units on every team. |
| `roomId` (number) |  |

#### `revive_team`

Flip a dead team (or all dead teams) back to alive so units can be spawned onto it. Pairs with set_cheats to stop the game-over check re-killing it.

| Argument | Meaning |
|---|---|
| `team` (number) | Team ID. Omit to revive all dead teams. |
| `roomId` (number) | Room/game server ID (auto-detected if omitted) |

#### `set_stockpile`

Insta-fill a unit's stockpile weapon (missiles etc.) — skips the build cycle. Wraps the server `stockpile` verb.

| Argument | Meaning |
|---|---|
| `unitId` (number, **required**) |  |
| `count` (number, **required**) | Stockpiled shots to set. |
| `queued` (number, default `0`) |  |
| `roomId` (number) | Room/game server ID (auto-detected if omitted) |

#### `set_debug_logging`

Toggle one or more debug-log subsystems on the game server. Logged lines surface via get_logs / search_logs (section= the subsystem name). Subsystems: combat (damage/hit/kill events), sound (every SoundEvent push), weapon (every CWeapon::Fire), explosion (planned), order (planned), unit (planned), script (planned). Returns the post-call status string.

| Argument | Meaning |
|---|---|
| `combat` (boolean) |  |
| `sound` (boolean) |  |
| `weapon` (boolean) |  |
| `explosion` (boolean) |  |
| `order` (boolean) |  |
| `unit` (boolean) |  |
| `script` (boolean) |  |
| `roomId` (number) |  |

#### `pause_sim`

Pause / unpause the server simulation tick (gs->paused). Sim freezes; the client keeps rendering. Pair with `set_render_paused` (browser-side) when you want a fully-frozen scene for a screenshot.

| Argument | Meaning |
|---|---|
| `paused` (boolean, **required**) |  |
| `roomId` (number) |  |

#### `set_sim_speed`

Set the sim speed multiplier (range 0.05 – 100). 1 = normal, 2 = double, 0.1 = ten-times slower. Useful for slow-mo combat inspection or fast-forwarding past dead time in long tests.

| Argument | Meaning |
|---|---|
| `multiplier` (number, **required**) |  |
| `roomId` (number) |  |

#### `step_sim`

**Advance the sim by an EXACT number of frames, from a stop.** The primitive that makes frame-by-frame filming possible: pause freezes the thing you are trying to watch, and speed 1 moves it an unknown distance across a multi-second relay round trip — stepping moves it by the number of frames you asked for and by nothing else, however long your camera call took. Pauses first if the sim was running (stepping from a moving sim is not a thing a caller can mean) and returns {from, to, landed}. It POLLS until the frame actually lands, so a successful reply means the sim really is at `to` — stepping is paced by the current speed factor, so 30 frames at 0.1× takes ~10 s of wall time. The step-capture-step-capture loop is what `capture_sequence` mode:"step" does for you; reach for this directly when you want to interleave something else (an order, a Lua probe, a damage event) between frames.

| Argument | Meaning |
|---|---|
| `frames` (number, default `1`) | Sim frames to advance (1–3000). Default 1. 30 frames = 1 game-second. |
| `roomId` (number) |  |

#### `set_los`

Toggle global line-of-sight for every ally team (reveals the whole map for spectators and players alike). Wraps the `los on\|off\|status` server verb, which calls losHandler->SetGlobalLOS for each active ally team. Useful for debugging: with LOS off you can't see enemy units; with global LOS on the whole map streams to every viewport.

| Argument | Meaning |
|---|---|
| `enable` (boolean) | true → reveal map; false → restore normal LOS; omit → return current state. |
| `roomId` (number) |  |

#### `set_cheats`

Toggle cheat mode on the game server (gs->cheatEnabled + gs->godMode). When on, Lua paths gated by `if gs->cheatEnabled` (Spring.SetUnitHealth above max, Spring.CreateUnit on any team, etc.) start working from any caller. Pairs with `set_unit_invulnerable` for sustained combat-FX testing.

| Argument | Meaning |
|---|---|
| `enable` (boolean) | true → enable cheats; false → disable; omit → return current state. |
| `roomId` (number) |  |

#### `set_unit_invulnerable`

Make a specific unit immune to damage (toggles a CUnit::invulnerable flag that short-circuits DoDamage on the very first line). Survives weapon hits, AddUnitDamage, water damage, self-destruct attempts — everything funnels through DoDamage. Useful for keeping a damage target alive while you study impact CEGs or beam-hit FX.

| Argument | Meaning |
|---|---|
| `unitId` (number, **required**) |  |
| `invulnerable` (boolean) | true → immune; false → restore normal damage; omit → return current state. |
| `roomId` (number) |  |

#### `drive_pattern`

**Drive a unit through a scripted waypoint loop and (optionally) film it — one call.** Closes a TOOLING GAP found while chasing the missing-tread-decals defect (docs/reviews/beta/README.md): there was no dedicated figure-8/waypoint-loop routine, so that fire hand-built one from 7-8 individual `give_order` MOVE calls. Computes a waypoint loop (pattern: figure8\|circle\|line\|zigzag) around the unit's CURRENT position, issues it as queued MOVE orders (cmdId 10, first waypoint opts 0, the rest opts 32 to queue — same `give_order` plumbing), waits until the unit has visited every waypoint IN ORDER (or `timeoutMs`), and reports the waypoints, how many were reached, sim frames elapsed, and final position. A closed loop ends where it began, so arrival is never declared until the unit has first moved more than `arriveRadius` from its start (`departed`) — a figure-8 that "arrives" in 11 frames was the first live call's defect. Give `unitId` for an existing unit, or `spawn:{defName,x,z,team?}` to create one first — spawning waits a short settle before the first order goes in, because a unit ordered immediately after `spawn_unit` can silently drop that first order (empty queue, never moves). With `capture:true`, shoots `capture_subject` top + low at the final position once the loop finishes (or times out).

| Argument | Meaning |
|---|---|
| `unitId` (number) | Drive this existing unit. Required unless `spawn` is given. |
| `spawn` (object) | Spawn a unit first, then drive it: {defName, x, z, team?}. Ignored if `unitId` is given. |
| `pattern` (string, `figure8`\|`circle`\|`line`\|`zigzag`, **required**) | Waypoint loop shape. |
| `radius` (number) | Loop radius in elmos, for figure8/circle/zigzag. Default 300. |
| `length` (number) | End-to-end span in elmos, for line/zigzag. Default 300. |
| `laps` (number, default `1`) | Repeats of the loop (line/zigzag: round trips). Default 1. |
| `segmentsPerLap` (number) | Waypoints per lap for figure8/circle/zigzag. Default 12, minimum 3. |
| `arriveRadius` (number, default `64`) | Distance (elmos) within which a waypoint counts as visited; waypoints are credited in order. Default 64. Must be smaller than the pattern's radius (line/zigzag: half its length). |
| `passive` (boolean, default `true`) | Put the unit on hold-fire + hold-position before driving it (default true). An idling unit that sees an enemy is given an internal attack order by the engine, which replaces the move queue mid-loop. false leaves its states alone. |
| `clearance` (number, default `48`) | No waypoint is left closer than this (elmos) to the unit's start: the engine drops a MOVE targeting within ~16-32 elmos of where the unit already is, so a figure-8's centre crossings would otherwise vanish from the queue. Default 48; 0 disables. |
| `timeoutMs` (number, default `180000`) | Give up waiting for arrival after this long (still returns the last known position). Default 180000 — a tank averages ~20 elmos/s through a loop's turns, and the default figure-8 is ~1900 elmos. |
| `pollMs` (number, default `500`) | Wait between arrival polls. Default 500. |
| `capture` (boolean, default `false`) | Shoot capture_subject top + low at the final position once the loop ends. |
| `maxDim` (number) | Passed through to the capture (longest edge in pixels). Only used when capture:true. |
| `roomId` (number) |  |
| `clientId` (number) | Admin client id to use for the optional capture. Only used when capture:true. |

#### `populate_tranche`

**Spawn PLAN-perf.md §M19's XL-battle population in one batch.** Closes a TOOLING GAP (docs/reviews/beta/README.md / PLAN-perf.md "Not done"): no committed script reproduced the ~900-unit XL900 population `profile`/`browser_test perfDump` need to measure p95 reproducibly. Rungs (cumulative): S → M → L → XL750 → XL900 → XL1200 — each rung is S plus every increment up to it, exactly as PLAN-perf.md §M19's tranche table records it (same map centre, same grid shape, `perRow` widening with the tranche). Runs the S-battle `grid()` Lua helper (bulk `Spring.CreateUnit` + `Spring.SetUnitArmored` in ONE `exec_lua` LuaRules call — confirmed crash-free at this scale across M6/M9/M19-M26) rather than one `spawn_unit` round trip per unit. Map is meridian_basin's contested-core ford, centre (8192, 8192); teams default to 0 (north) and 4 (south) per `modOptions.war_sides = "compact:0,union:4"` — pass `teamNorth`/`teamSouth` if a room's side mapping differs. Spawned ids are kept server-side in `GG.perfTranche[team]`, not returned inline (900 ids is a lot of tokens for no benefit) — read them back with `exec_lua` if needed. Does NOT clear any existing population first unless `clearFirst:true`.

| Argument | Meaning |
|---|---|
| `rung` (string, `S`\|`M`\|`L`\|`XL750`\|`XL900`\|`XL1200`, default `"XL900"`) | Cumulative population size to reach. |
| `teamNorth` (number, default `0`) | North-bank team id. |
| `teamSouth` (number, default `4`) | South-bank team id. |
| `center` (object) | Override the grid centre: {x, z}. Default the meridian_basin ford (8192, 8192). |
| `soldierDef` (string) | Override the infantry def (default "ms_soldiers_s1"). Must be a bare token — no spaces or quotes. |
| `tankDef` (string) | Override the armour def (default "ms_tanks_s2"). Must be a bare token — no spaces or quotes. |
| `armored` (boolean, default `true`) | Apply Spring.SetUnitArmored(u, true, 0.00003) so the population sustains rather than dying to stray fire. |
| `clearFirst` (boolean, default `false`) | Clear teamNorth and teamSouth (`clear_units` per team) before spawning, for a clean population. |
| `suppressGameOver` (boolean, default `false`) | Patch Spring.GameOver to a no-op first — meridian_basin's ford is scenario objective 1 ("control"); capturing it ends the game and freezes the sim mid-measurement (PLAN-perf.md M10). |
| `roomId` (number) |  |

## Unit and weapon defs

Def lookups read the baked def cache, not the running game — they answer with no server up, and go stale when the content changes under them.

#### `get_unit_def`

Read a single UnitDef from the on-disk defs cache without needing a running game. Decodes the FlatBuffer baked by spring-server. Returns full Tier 4 fields including customParams, transportSize, repairSpeed, yardmap, etc.

| Argument | Meaning |
|---|---|
| `gameId` (string, **required**) | Game ID (e.g. "metalstorm") |
| `name` (string) | Unit def name (e.g. "fable_tank") OR omit and pass defId |
| `defId` (number) | Numeric def ID. Either name or defId is required. |

#### `list_unit_defs`

List all UnitDefs from the cache, optionally filtered by name pattern. Use this to scan customParams, find units with a particular field set, etc. Returns names + summary fields by default; pass full=true for complete records.

| Argument | Meaning |
|---|---|
| `gameId` (string, **required**) | Game ID (e.g. "metalstorm") |
| `pattern` (string) | Substring filter on def name (case-insensitive). Omit for all. |
| `full` (boolean, default `false`) | If true, return full def records. Default: name + key fields only. |
| `limit` (number, default `50`) | Max results |

#### `get_weapon_def`

Read a single WeaponDef from the on-disk defs cache. Decodes the FlatBuffer baked by spring-server.

| Argument | Meaning |
|---|---|
| `gameId` (string, **required**) | Game ID (e.g. "metalstorm") |
| `name` (string) | Weapon def name OR omit and pass defId |
| `defId` (number) | Numeric weapon def ID. Either name or defId is required. |

#### `clear_defs_cache`

Delete the baked defs cache (unitdefs/weapondefs/cegdefs/featuredefs .lua.br + power.json, plus legacy .bin orphans) for a game, or all games. Forces the next game session to re-bake from source. Required after schema changes that did NOT bump the cache key. Cheaper than killing the running game.

| Argument | Meaning |
|---|---|
| `gameId` (string) | Game ID to clear. Omit to clear all games. |

#### `get_lua_source`

Read a Lua source file from the game content via HTTP. Path relative to game root.

| Argument | Meaning |
|---|---|
| `gameId` (string, **required**) | Game ID (e.g. "metalstorm") |
| `filePath` (string, **required**) | File path relative to game root (e.g. "LuaRules/Gadgets/unit_spawner.lua") |

## Processes, rooms and readiness

What is running, and whether it is ready. `probe_game` checks pid liveness BEFORE the heartbeat row, because nothing deletes that row when a server dies by SIGKILL. `list_stack` classifies by the EXECUTABLE actually invoked (basename, following an interpreter like `node`), never by a substring anywhere in the full command line — an agent process merely talking about "spring-lobby" is not the lobby.

#### `list_processes`

List game server processes as JSON: {servers:[{roomId, port, pid, state, gameId, mapId, ready, clientCount, heartbeatAgeSec, heartbeatStale, identity}], count}. Discovery is the lobby /api/processes with a SQLite fallback; `ready`/`clientCount`/heartbeat come from the game_status table and `identity` ({stamp, engineHash, pid}) from each server's /api/metrics (null on a server built before P8). For strays, zombie ports and binary drift use list_stack instead.

*No arguments.*

#### `list_stack`

Full dev-stack census in one call — replaces ad-hoc pgrep/lsof hunts. Returns {findings, processes, ports, authority, gameStatus, binaries, mprocs, summary}. `findings[]` classifies everything it sees: managed (lobby/logserver/vite/game servers the lobby owns), stray-server (a spring-server the lobby does not know about — e.g. a hand-launched headless run), zombie-port (a listener on 9100-10099 that is not a managed game server; blocks the next room, since room routing is by port), duplicate-lobby, orphan-vite (a vite on a fallback port — a browser pointed at it silently drives the wrong stack), stale-status-row (report-only), binary-drift (the lobby forks build/release/spring-server when it exists, so a debug-only rebuild is invisible) and stale-binary-running. Each finding carries a severity and a suggestedAction. Read-only: it never connects to the mprocs control port (a bare connect can crash mprocs) and never kills anything — that is cleanup_stack.

| Argument | Meaning |
|---|---|
| `probeHashes` (boolean, default `false`) | Also run `spring-server --print-engine-hash` on each on-disk binary and read `identity` from every running server, enabling stale-binary-running detection ("the process you are testing is not the binary you just built"). Adds ~1s. Default false. |

#### `cleanup_stack`

Kill the non-managed processes list_stack found. CALL WITH dryRun:true FIRST (the default) — it returns the exact plan (pid, kind, signal sequence) and touches nothing. Acts only on stray-server, zombie-port, orphan-vite and duplicate-lobby; `managed` processes are never touched (to stop a real game use end_game({roomId}), which drains gracefully), and stale game_status rows are report-only. Hard invariants: the pid holding :8011 is never killed whatever its classification; ONE LIVE STACK PER MACHINE — a pid is refused unless it was started by stack_start (this session's or a prior one), because the dev stack you are most likely looking at belongs to the user's own interactive mprocs and killing it out from under them is the one outcome that costs a whole session; stray-server is refused entirely when the lobby is unreachable (with no authority, "stray" cannot be established); a zombie-port pid whose command is not spring-server needs force:true. `force:true` overrides BOTH the ownership refusal and the zombie-port command check — pass it only once you have actually looked at what you are about to kill (e.g. via list_stack). Kill discipline is SIGTERM → poll 5s → SIGKILL, because spring-server turns SIGTERM into a clean exit checkpoint.

| Argument | Meaning |
|---|---|
| `dryRun` (boolean, default `true`) | Report the plan without killing anything. Default TRUE. |
| `kinds` (array) | Restrict to these classifications (default: all of stray-server, zombie-port, orphan-vite, duplicate-lobby). |
| `force` (boolean, default `false`) | Allow killing a pid that stack_start did not start, AND a zombie-port pid whose command line is not spring-server. Both checks exist because the 9100-10099 range can catch unrelated dev tools, and because most running processes are the user's own mprocs stack, not this tool's. Default false. |

#### `probe_game`

One-shot readiness probe for a game server. Composes the lobby process row, pid liveness, the game_status heartbeat and /api/metrics into a single phase: spawning (process up, nothing published yet) \| loading (heartbeat present, ready=0 or stale) \| ready (accepting connections) \| ticking (sim advancing) \| dead (no process row, or the pid is gone). Use wait_for_game to poll until a phase is reached.

| Argument | Meaning |
|---|---|
| `roomId` (number) | Room ID. Omit to auto-pick the newest non-ended game. |

#### `wait_for_game`

Poll a game server (via probe_game) until it reaches a readiness phase (ready = accepting connections, ticking = sim advancing) or a target frame. Fails FAST on server death: returns phase 'dead' immediately with the last room-scoped log lines instead of waiting out the timeout. A timeout returns timedOut:true plus the honest last probe rather than throwing.

| Argument | Meaning |
|---|---|
| `roomId` (number) | Room ID. Omit to auto-pick the newest non-ended game (resolved once, then pinned). |
| `until` (string, `ready`\|`ticking`\|`frame`, default `"ready"`) | until='ready' is satisfied by ready OR ticking. |
| `frame` (number) | Target sim frame (required when until='frame'). |
| `timeoutMs` (number, default `120000`) |  |
| `pollMs` (number, default `500`) |  |

#### `query_db`

Execute a read-only SQL query against the lobby database. The file opened is detected from the RUNNING lobby's own `--db` argument (falling back to PROJECT_ROOT/TASKHERD_REPO + data/spring-server.db, or SPRING_DB if set) — never assumed — because this is the one tool that reads the filesystem directly rather than the live lobby's HTTP API, so a stale assumption here is invisible everywhere else. Every answer is prefixed with `-- db: <path> (<source>)` naming exactly which file and how it was chosen.

| Argument | Meaning |
|---|---|
| `query` (string, **required**) | SQL query — only row-returning statements are allowed (SELECT, WITH … SELECT, EXPLAIN, PRAGMA reads) |

#### `list_sessions`

List recent game sessions from the log server.

*No arguments.*

## Starting and stopping

Launch and teardown. `end_game` prefers the lobby's admin route because SIGTERM is what produces the exit checkpoint; `kill_game` is a deprecated alias for the ungraceful path. `stack_start` is a different kind of tool in this section — it launches the dev stack itself (logserver/lobby/vite), and only belongs here when `list_stack`'s `stack-down` finding says nothing is up yet; prefer the user's own mprocs whenever one might already be running.

#### `launch_scenario`

Launch a scenario game directly (no lobby UI, no manifest files): resolves the scenario via GET /api/games/<gameId>/scenarios, builds the /api/rooms/direct manifest in memory with the scenario as the TOP-LEVEL field (modoptions.scenario alone gets overwritten by the map default), POSTs it, and waits for the sim to tick. Re-launching the same scenario replaces the previous room (same room name → teardown + recreate). Returns {roomId, port, sessions, browserUrl} — browserUrl attaches to THIS room (?play= + room + token in the URL hash) and never re-launches; the token is in the hash fragment, so it stays out of server logs but does land in browser history (dev feature). Requires the lobby to run with --dev-direct-start. A players[] entry naming an unknown username creates an is_dev account; the defaults never do.

| Argument | Meaning |
|---|---|
| `scenarioId` (string, **required**) | Scenario id — the file stem of data/games/<gameId>/scenarios/<id>.lua (e.g. "crossing_standoff"). |
| `gameId` (string, default `"metalstorm"`) | Game the scenario belongs to. |
| `openBrowser` (boolean, default `false`) | Open a browser client on browserUrl and wait for it to connect, then re-probe. The default roster seats a HUMAN, so without this the sim holds at frame -1 and every relay tool answers "no connected admin client" — with it, wait:"ticking" is reachable in one call. The browser is tracked and end_game closes it. Returns its report under `browser`. |
| `browserHeadless` (boolean, default `true`) | Headless browser for openBrowser (renders identically; opens no window). false to watch the run. |
| `mapId` (string) | Map override. Default: the scenario's declared world.map. |
| `ai` (string, default `"null"`) | AI id seated on every non-host playable side ("null", "strategos"). "" = no AI slots (the lobby's solo-team safety net may still add a Null AI). |
| `players` (array) | Default [{username:"admin"}] seated on the scenario's first playable side. players[0] is the room host; extras default to spectators. |
| `side` (string) | Shorthand: seat players[0] on this faction's side. |
| `modoptions` (object) | Extra modoptions. A "scenario" key here is hoisted to the manifest top level (it does NOT work as a modoption). |
| `roomName` (string) | Room name. Default "mcp:<scenarioId>". Re-POSTing a name replaces that room. |
| `headless` (boolean, default `false`) | No browser will connect: omit browserUrl and warn about the idle-grace self-exit (workaround: lobby env SPRING_IDLE_STARTUP_GRACE_SECONDS). |
| `wait` (string, `none`\|`ready`\|`ticking`, default `"ticking"`) | Return immediately, when the game server answers /api/metrics, or when the sim frame advances. |
| `waitTimeoutMs` (number, default `120000`) |  |
| `idleGraceSeconds` (number) | Written to the manifest as idleStartupGraceSeconds: how long the server waits for its first client before self-exiting (default 120s, which kills a browserless run at frame -1). Silently inert on lobby binaries older than P3 — fallback there is the lobby env SPRING_IDLE_STARTUP_GRACE_SECONDS. |
| `skipBriefing` (boolean, default `true`) | Append &skipBriefing=1 to browserUrl (S2 splash bypass). |
| `revealTokens` (boolean, default `false`) | Return the raw `sessions` bearer tokens. Default false: values are redacted (browserUrl still carries the host token in its hash — that is the attach mechanism). |
| `force` (boolean, default `false`) | Launch even if the scenario is not in the lobby's (startup-snapshot) list — the direct path reads the VFS fresh. Requires mapId; sides default to the legacy two-team shape. |

#### `launch_direct`

Launch a game from a RAW /api/rooms/direct manifest — the manual sibling of launch_scenario (which builds its manifest in memory from a scenarioId; prefer that for scenario tests, and this one for full control: custom rosters, modoptions, sessionKind, idle timers). Takes a manifest by name from manifests/, inline, or both merged, POSTs it, and waits for the sim to tick. Merge order: file manifest → `manifest` deep-merged on top (objects recurse; arrays and scalars replace) → `overrides` shallow-merged last (top-level keys replaced wholesale). Manifest shape: {name, map (required), game, sessionKind, scenario (TOP-LEVEL — modoptions.scenario alone is overwritten by the map default), modoptions{}, players[] (>=1; players[0] is the host; {username, team, startPos, spectator}), aiSlots[] ({aiId, team, startPos, profile}), autoStart, idleStartupGraceSeconds, idleExitSeconds}. `name` is IDEMPOTENT BY REPLACEMENT: re-POSTing a name SIGTERMs that room's server and recreates the room (a clean restart, not an error), and a manifest with no name defaults to "dev:direct", so two unnamed launches silently clobber each other — concurrent lanes must set distinct names. Declared players are force-left from any prior room. Requires the lobby to run with --dev-direct-start. Returns {roomId, port, sessions, players, aiSlots, browserUrl, phase, frame, notes}.

| Argument | Meaning |
|---|---|
| `manifestName` (string) | File stem under manifests/ (e.g. "crossing_standoff_direct"). A miss lists the available names. |
| `manifest` (object) | Inline manifest, deep-merged OVER the file one. Use alone for a fully inline launch. |
| `overrides` (object) | Shallow merge applied last — top-level keys replace wholesale. The escape hatch when deep-merge is wrong (e.g. swapping the whole players[] array). |
| `wait` (string, `none`\|`ready`\|`ticking`, default `"ticking"`) | Return after the POST, when the game server answers /api/metrics, or when the sim frame advances. NOTE: a skirmish holds GameStart until its rostered humans connect — an exec-only test with human players must use "ready" (or an AI-only/spectator roster, or sessionKind:"persistent", neither of which waits). |
| `timeoutMs` (number, default `120000`) | Wait budget in ms. |
| `clearCache` (boolean, default `false`) | Delete the defs cache for the manifest's game before launching. |
| `revealTokens` (boolean, default `false`) | Return the raw `sessions` bearer tokens (default: redacted). |
| `idleGraceSeconds` (number) | Sugar for manifest.idleStartupGraceSeconds — how long the server waits for its first client before self-exiting (default 120s, which kills exec-driven tests at frame -1). Ignored without error by lobby binaries older than P3; fallback there is to start the LOBBY with SPRING_IDLE_STARTUP_GRACE_SECONDS in its env (applies to every room it spawns, so pair it with end_game teardown). |

#### `launch_game`

Launch a fresh game directly via the lobby HTTP API — bypasses the lobby UI. Creates a room (or reuses existing one for the user), adds an AI slot, marks the host ready, and starts the game. Waits (via probe_game) until the server is accepting connections, failing fast if it dies during boot. Returns the new room ID, gameServerPort, the readiness `phase`, and — on failure only — `lastLogs`.

| Argument | Meaning |
|---|---|
| `gameId` (string, default `"metalstorm"`) | Game ID (default "metalstorm"; BAR/ZK are archived) |
| `mapId` (string, **required**) | Map ID (e.g. "meridian_basin") |
| `roomName` (string, default `"debug"`) | Room name |
| `ai` (string, default `"null"`) | AI to add for the opposing team. Set to "" to skip AI. Default: "null" (Null AI engine bot). |
| `username` (string) | Username to launch as. Defaults to admin / SPRING_USER. |
| `password` (string) | Password. Defaults to SPRING_PASS. |
| `clearCache` (boolean, default `false`) | Delete the defs cache before launching to force a fresh bake. |
| `testStartupSelector` (boolean, default `false`) | Legacy (ZK-only, archived): keep the "Startup Info and Selector" overlay enabled in the suggested browserUrl. A no-op for Metalstorm; kept because the name is a public argument. |

#### `end_game`

Gracefully stop ONE room's game server. Prefers the lobby's POST /api/admin/rooms/end, which returns a drain-quality report: the exit checkpoint verified against the snapshot store (outcome, frame, lossy) plus resume eligibility. A route-level 404 means a lobby binary older than P4 — falls back to a direct SIGTERM/poll/SIGKILL from the MCP process (source:'sigterm-fallback'); an auth/validation failure is reported, never silently downgraded. NOTE: the room flips to "ended" asynchronously via the lobby health loop, not in this response — poll /api/rooms or probe_game if you need to observe it. To stop a room cleanly WITH a report use this, not a same-name launch_direct relaunch (that SIGTERMs, deletes and respawns). kill_game is the deprecated graceful:false alias.

| Argument | Meaning |
|---|---|
| `roomId` (number, **required**) | Room ID (required — omitting it refuses with a candidate list). |
| `graceful` (boolean, default `true`) | false → SIGKILL immediately from the MCP process (same as deprecated kill_game); no server report, no exit checkpoint. |
| `timeoutMs` (number, default `10000`) | How long to wait for the exit checkpoint before escalating to SIGKILL. The server caps this at 30000. |
| `escalate` (boolean, default `true`) | SIGKILL if the server has not exited within timeoutMs. false leaves a stuck server alive and reports outcome "still_alive". |

#### `kill_game`

DEPRECATED — alias for end_game(graceful:false). Force-kills the spring-server process for a room (SIGKILL, no exit checkpoint). Prefer end_game. roomId is required.

| Argument | Meaning |
|---|---|
| `roomId` (number) | Room ID (required — omitting it now refuses with a candidate list) |

#### `restart_lobby`

Restart the lobby server in-place (re-exec with same args, same pid — mprocs stays authoritative). Running game servers are preserved. Use after rebuilding spring-lobby.

*No arguments.*

#### `restart_logserver`

Restart the log server (:8010) in-place (re-exec with same args, same pid — mprocs stays authoritative). Use after rebuilding spring-logserver, or to recover the log pipeline if it stops responding.

*No arguments.*

#### `restart_game`

Restart a running game server in-place (re-exec with same args). Clients are notified and will reconnect. Use after rebuilding spring-server.

| Argument | Meaning |
|---|---|
| `roomId` (number) | Room ID (0 or omit for first active game) |

#### `restart_client`

Restart the Vite client dev server (:8012) via the mprocs control channel (select-proc + restart-proc — the pane stays authoritative, no dead pane / duplicate listener). Use after editing a worker-imported client file (entity-renderer.ts, game-processor.ts, …): Vite serves a stale `?worker` bundle until the pane is restarted. Unlike the C++ servers, Vite has no in-place re-exec. Requires mprocs started with the `server:` key (mprocs.yaml); otherwise it falls back to kill+relaunch.

| Argument | Meaning |
|---|---|
| `clearCache` (boolean) | Also clear client/node_modules/.vite before restarting (use if a plain restart still serves stale worker code). Default false. |

#### `stack_start`

Launch logserver/lobby/vite from mprocs.yaml's own `shell:` lines — nohup, detached, cwd = the main checkout (PROJECT_ROOT or TASKHERD_REPO), logging to .tasks/logs/stack-<service>.log. Refuses outright if ANY requested port (:8010/:8011/:8012) is already held — one live stack per machine: that is very likely the user's own mprocs session, and starting a second lobby on the same db races SO_REUSEPORT accepts between them (see list_stack's duplicate-lobby finding). NOT a substitute for mprocs: no TUI, no restart-proc, no log-tail panes — prefer the user's own mprocs when one might already be running (check with list_stack first); this exists for when nothing is up at all (CI, a fresh box, a headless session). Every pid it starts is recorded so cleanup_stack will later kill it without needing force:true.

| Argument | Meaning |
|---|---|
| `services` (array) | Subset to start. Default: all three, in logserver, lobby, vite order. |

## Scenarios

Authoring and generating wars. `validate_scenario` runs BOTH parsers offline; a `skipped` finding means NOT CHECKED, never "fine".

#### `list_scenarios`

List the scenarios a game ships, merging the lobby's discovery view (id, displayName, map, tutorial/retired flags, terminal = has a victory objective, playable sides, briefing) with the admin provenance view for generated wars (seed, generator params/version, createdBy/At). Rows are tagged source: "authored" (a hand-written scenarios/*.lua) or "generated" (gen_*, owned by the scenario DB — regenerate rather than edit those). Needs a running lobby; degrades to the public view alone if the admin call is refused.

| Argument | Meaning |
|---|---|
| `gameId` (string, default `"metalstorm"`) |  |

#### `validate_scenario`

Offline structured validation of a scenario file — replicates BOTH parsers (the lobby's bare lua_State discovery pass AND game_scenario.lua's GameStart validate()) without booting anything, and without a running lobby. Returns findings[] of {severity, rule, path, message} with severity error\|warning\|info\|skipped. A scenario with zero error findings will be offered by the lobby and will pass the in-game validator, modulo the live-only checks reported as "skipped". Note "skipped" means NOT CHECKED, never "fine". Rule ids and what each mirrors: docs/scenarios.md §11.

| Argument | Meaning |
|---|---|
| `gameId` (string, default `"metalstorm"`) |  |
| `scenarioId` (string) | Reads data/games/<gameId>/scenarios/<scenarioId>.lua. Either this or luaSource. |
| `luaSource` (string) | Validate source text directly — the pre-write check. Either this or scenarioId. |
| `passability` (boolean, default `false`) | Also run regions_from_map.py --verify on world.map (read-only; needs the processed map + python3; slow). |

#### `write_scenario`

Validate, then write data/games/<gameId>/scenarios/<scenarioId>.lua, then resync the lobby so the file is actually OFFERED (lobby scenario lists are a startup snapshot — a new file is invisible to the picker and to launch_scenario until a resync). Error findings always block the write; warnings block unless force:true. Refuses the gen_ prefix: those ids belong to the scenario DB and its orphan sweep DELETES any gen_*.lua no row claims. Reports offered:true\|false by re-reading the lobby list afterwards, because a file the lobby then silently declines to offer is exactly the failure this tool exists to catch.

| Argument | Meaning |
|---|---|
| `gameId` (string, default `"metalstorm"`) |  |
| `scenarioId` (string, **required**) | Grammar: ^[a-z0-9_]+$, max 64 chars, must not start with gen_. |
| `luaSource` (string, **required**) | The whole file. Must be a PURE Lua table literal returning a table — no VFS/Spring/GG/require at file scope. |
| `resync` (boolean, default `true`) |  |
| `overwrite` (boolean, default `false`) | Required to replace an existing file. |
| `force` (boolean, default `false`) | Write despite warning findings. Error findings always block. |

#### `generate_scenario`

Generate a war for a map with scenariogen.py via the lobby admin route, store it in the scenario DB, materialise it to scenarios/gen_*.lua and re-discover it — returning the entry exactly as the Create Game picker now sees it. The seed defaults server-side to sum(ord(c) for c in mapId), so re-running with no seed is an idempotent upsert of the same war rather than a new one. On a map that cannot host a war the route answers 422 with the generator's own REJECTED line naming the violated invariant — surfaced verbatim. Needs a running lobby + admin auth.

| Argument | Meaning |
|---|---|
| `gameId` (string, default `"metalstorm"`) |  |
| `mapId` (string, **required**) | Processed map id, e.g. "meridian_basin". |
| `seed` (integer) | Defaults to sum of mapId char codes (reproducible). |
| `sides` (integer) | 2-8 |
| `towns` (integer) | 0-32 |
| `outposts` (integer) | 0-32 |
| `bases` (integer) | 0-32 |
| `mines` (integer) | 0-32 |
| `sites` (integer) | 0-32 |
| `relics` (integer) | 0-32 |
| `wrecks` (integer) | 0-32 |
| `bridges` (integer) | 0-32 |
| `works` (integer) | 0-32 |
| `harbour` (integer) | 0-32 |
| `shanty` (integer) | 0-32 |
| `hostility` (string) | Generator enum (see scenariogen.py --hostility). |
| `roster` (string) | Generator enum (see scenariogen.py --roster). |
| `coverage` (boolean) | Full-coverage war: force the preset that can reach every def ms_defs knows, then REFUSE unless the staged war really contains one of each. Explicit knobs still win, so coverage+towns:5 means five towns. |
| `player` (boolean) | Generate for a HUMAN: drop the mutual-ground-reachability gate, so islands, rivers and straits produce a scenario instead of a refusal. |

## The browser client

Everything here runs code in a CONNECTED browser over the P7 relay and is subject to its three gates (see below). The client is where rendering, LuaUI and the NL executor live — none of it is visible from the server. Note: chrome-devtools' own `resize_page` is a no-op against an `--isolated` launch here (the viewport stays pinned at its initial size) — set the size up front instead, either via chrome-devtools' `emulate` (viewport override) or by passing `--window-size=<W>,<H>` on the isolated launch itself.

#### `open_client`

Open a browser client and connect it to a room — the missing half of the relay tools, which all need a CONNECTED admin client and could not previously make one. Pass `roomId` to attach to a room this server launched (its browserUrl, including the host session token, is remembered from launch_scenario/launch_direct), or pass an explicit `url` for anything else. HEADLESS BY DEFAULT: verified to render this Babylon client identically (same mesh counts, working client_screenshot) while opening no window on the user's machine — pass headless:false to watch a run live. With `waitReady` (the default) it returns only once the relay actually answers, reporting {connected:true, clientId, readyState}; "the process started" is a much weaker claim than "a client is connected". The browser is tracked, so end_game closes it and list_clients can see it. Chrome is found automatically (override with SPRING_BROWSER).

| Argument | Meaning |
|---|---|
| `roomId` (number) | Attach to this room using the browserUrl remembered from its launch. Required unless `url` is given. |
| `url` (string) | Explicit URL. Overrides the remembered browserUrl; use for a room this server did not launch, or a non-game page. |
| `headless` (boolean, default `true`) | false opens a visible window (useful to watch a run, or to debug a client that will not connect). |
| `width` (number, default `1280`) |  |
| `height` (number, default `800`) |  |
| `waitReady` (boolean, default `true`) | Wait until the relay reaches the new client before returning. |
| `waitReadyMs` (number, default `60000`) | How long to wait for that first relay answer. |

#### `close_client`

Close a browser this server opened. `{pid}` closes one, `{roomId}` closes every client attached to that room, `{all:true}` closes all of them. SIGTERM to the process GROUP → poll → SIGKILL, because Chrome is a process tree and signalling the bare parent leaves GPU-holding renderers behind (an abandoned renderer has corrupted whole perf sessions here). Returns a per-browser report — read the `outcome`, not just the count: `exited` is clean, `killed_after_timeout` means SIGTERM was ignored, `kill_failed` needs a human. Refuses to signal a pid this server did not launch.

| Argument | Meaning |
|---|---|
| `pid` (number) | A pid returned by open_client. |
| `roomId` (number) | Close every client attached to this room. |
| `all` (boolean) | Close every tracked client. |
| `timeoutMs` (number, default `5000`) | Grace before SIGKILL. |

#### `list_clients`

The browsers this server launched: {pid, roomId, url, headless, profileDir, startedAt, alive}. Liveness is re-probed on every call, never cached, so a browser that died or was killed by hand shows alive:false instead of a stale yes. Only ever lists this server's own browsers — a browser you opened yourself is invisible here (and is never signalled by close_client).

*No arguments.*

#### `client_eval`

Execute arbitrary code inside a connected browser client and return the result. Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario's default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand. Targets: "js" (main-thread global scope — document, window.test, window.widgets), "worker" (render-worker global scope — the __entityRenderer / __csm / __renderPipeline / __fxLightPool debug hooks the render-core move stranded there), "widgets" (Lua source run in the in-worker LuaUI runtime), "test" (an expression with the `test` harness already bound, e.g. `readyState()` or `captureFrame({maxDim:640})`). `output` is JSON-parsed when it parses. Keep results well under 4 MB — that is the wire control-message cap.

| Argument | Meaning |
|---|---|
| `code` (string, **required**) | Code to run (JS, or Lua for target "widgets"). |
| `target` (string, `js`\|`worker`\|`widgets`\|`test`, default `"js"`) | Which executor runs it. |
| `roomId` (number) | Room to target (default: the single active game). |
| `clientId` (number) | Address a specific connected client id; it must still be an admin session. Default: the lowest-id admin client. |
| `timeoutMs` (number, default `10000`) | Server-side wait, 500–60000. Default 10000. |

#### `client_ready`

Client-side readiness: relays `window.test.readyState()` to the connected browser and returns its report (renderer up, defs ingested, LuaUI booted, newest game frame, feed age). Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario's default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand. This is the BROWSER's view — for server-side readiness (sim ticking, players seated) use `wait_for_game` instead; the two answer different questions and a game can be server-ready while the tab is still ingesting defs.

| Argument | Meaning |
|---|---|
| `roomId` (number) | Room to target (default: the single active game). |
| `clientId` (number) | Address a specific admin client id. |

#### `client_screenshot`

Capture the browser client's rendered frame and return it as an image you can actually look at, plus a text block of capture metadata (width/height, frameId, gameFrame, per-phase stats, byte size). Relays `window.test.captureFrame({maxDim, stats:true})`, which waits for a real presented frame rather than grabbing a stale backbuffer. Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario's default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand. maxDim is clamped to 2048 to stay well inside the 4 MB wire cap.

| Argument | Meaning |
|---|---|
| `maxDim` (number, default `1280`) | Longest edge in pixels, 64–2048. |
| `quality` (number) | JPEG quality 0–1 (passed through to captureFrame). |
| `roomId` (number) | Room to target (default: the single active game). |
| `clientId` (number) | Address a specific admin client id. |

#### `browser_test`

Call a TestHarness method on `window.test` in the browser and return its result. Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario's default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand. Methods: focus(unitId), focusOn(x,z), pause(), resume(), screenshot(), saveScreenshot(name), select([ids]), spawnAndFocus(def,x,z,team), stageCombat(atk,tgt,x,z), state(), units(team), unitState(id), highResScreenshot(w,h), simPause(), simResume(), simSpeed(n). Performance profiling (see docs/debugging-performance.md): perfDump(windowMs?) / perfReset() — permanent per-phase (camera/entity/fx/render/ui/total) frame-time distribution; uiProfileStart() / uiProfileDump(topN?) / uiProfileStop() — per-widget LuaUI Fengari cost breakdown (call dump BEFORE stop, not after — stop clears the data); netSim({delayMs,jitterMs,lossProb}) / netSimOff() / netSimPreset("lan"\|"wan"\|"intercont") / netStats() — simulate WAN conditions and tally bandwidth per message type.

| Argument | Meaning |
|---|---|
| `method` (string, **required**) | TestHarness method name. |
| `args` (array, default `[]`) | JSON-serialisable args. Strings become quoted, numbers/bools/arrays passed through. |
| `roomId` (number) | Room to target (default: the single active game). |
| `clientId` (number) | Address a specific admin client id. |

#### `evaluate_widget_lua`

Run a Lua snippet in the LuaUI widget runtime (browser-side render worker) and return its result string. Use when you need to inspect WG, widgetHandler, _widgetErrors, or call any Spring.* function as the player would see it. Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario's default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand.

| Argument | Meaning |
|---|---|
| `code` (string, **required**) | Lua code. Last expression returned via "return …". |
| `roomId` (number) | Room to target (default: the single active game). |
| `clientId` (number) | Address a specific admin client id. |

#### `spawn_at_camera`

Spawn one or more units at the current browser camera's look-at position. Reads `window.test.cameraPose().lookAt` in the browser and forwards to `window.test.spawn(...)`, returning {x, z, response}. Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario's default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand.

| Argument | Meaning |
|---|---|
| `defName` (string, **required**) | Unit def name (e.g. "fable_tank"). |
| `team` (number, default `0`) | Owning team ID |
| `count` (number, default `1`) | How many to spawn (max 256) |
| `offset` (object) | Optional XZ offset from camera look-at, e.g. {x:200, z:0} to spawn 200 elmos east. |
| `roomId` (number) | Room to target (default: the single active game). |
| `clientId` (number) | Address a specific admin client id. |

## Looking at things

Subject → image, and manoeuvre → film. These hold the world still, frame from the model's own bounds and CHECK THE PIXELS; the verdict on the first line of the metadata is the point of them.

#### `capture_subject`

**Subject → usable image, in ONE call.** The tool to reach for whenever you want to LOOK at something in a running game; do not hand-roll camera math out of `browser_test focus` + `client_screenshot` again. Pass ONE subject — `unitId`, `unitIds` (framed together), `def` (the newest live instance this client actually has, optionally spawned first), `position {x,z}` or `area {x1,z1,x2,z2}` — and it resolves the subject, frames it FROM ITS OWN MODEL BOUNDS (a 4 m rifleman and a 65 m submarine both fill the frame; `angle` presets front/rear/side/top/three-quarter/low), holds the world still, captures a presented frame, and checks the pixels before handing them back. It exists because the two-call version does not work: each relay round trip costs seconds and the sim does not wait — a guided run on 2026-08-29 advanced 1,000+ sim frames between the camera call and the screenshot call and lost the engagement it was aiming at. Framing and capture therefore happen inside ONE relay evaluation. Ordering is handled for you, including the trap that a PAUSED SIM STREAMS NO FRESH SPAWNS OR REVEALS: spawn/reveal → let the stream settle → pause → capture → restore. Restores are conditional — a sim that was already paused stays paused, global LOS that was already on stays on. A black frame is a DIAGNOSIS, not a deliverable: mean luminance is checked, the camera re-frames up and out and retries, and a frame that is still black comes back `ok:false` with the candidate causes named (fog of war, night, subject never rendered). Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario's default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand.

| Argument | Meaning |
|---|---|
| `unitId` (number) | Frame this unit. |
| `unitIds` (array) | Frame these units together (merged bounding sphere, static anchor). |
| `def` (string) | Frame the newest live instance of this unit def known to the browser. With `spawn`, spawn it first. |
| `position` (object) | Frame a world point: {x, z, y?, radius?}. y defaults to the terrain height; radius defaults to 120 elmos. |
| `area` (object) | Frame a ground rectangle: {x1, z1, x2, z2}. Framed from its centroid + half-diagonal. |
| `spawn` (object) | Spawn `def` first, then frame it: {x, z, team?, count?}. Enables cheats if needed and turns them back off. Ordered spawn → stream settles → pause, because a paused sim never streams the new unit. |
| `angle` (string, `three-quarter`\|`front`\|`rear`\|`side`\|`top`\|`low`) | Viewpoint preset (default three-quarter). WORLD-relative, named for a unit at heading 0, which faces −Z. `low` frames loose and near-horizon — the shot for judging a model against the terrain it stands on. |
| `yawDeg` (number) | Override the preset bearing (degrees around +Y from +X toward +Z). |
| `pitchDeg` (number) | Override the preset elevation (clamped 5–85). |
| `fill` (number) | Fraction of the shorter viewport axis the subject should fill (0.25–0.95). Lower = more terrain context. |
| `pause` (boolean, default `true`) | Freeze the sim across the capture so the subject is still there when the shutter falls. A sim that was already paused is left paused. |
| `simSpeed` (number) | Slow (or speed) the sim across the capture, 0.05–100, restored afterwards. Asking for this DROPS the default pause — slow motion and a freeze are alternatives, not a pair — so it is how you photograph something that only exists while moving (a turret mid-slew, a tracer in flight). Pass pause:true as well to override. Applied AFTER the spawn/reveal settle, because the settle is measured in wall ms and 0.1× would shrink it to nothing. |
| `reveal` | true / "auto" (default) reveals global LOS when it is off and restores it after; false never touches LOS (a fogged subject then comes back as a black-frame diagnosis). |
| `maxDim` (number) | Longest edge in pixels, 64–2048. Default 1280. |
| `quality` (number) | JPEG quality 0–1. |
| `retries` (number) | Extra framings to try when the frame comes back black. Default 2, max 5. |
| `luminanceFloor` (number) | Mean luminance (0–255) at or below which the frame is called black. Default 8. |
| `streamSettleMs` (number) | Dwell between a spawn/reveal and the pause, so the entity snapshot carrying it reaches the browser. Default 600. |
| `syncPresentation` (boolean) | Force the presentation cursor onto the newest snapshot before the shutter. Defaults to true whenever this call paused the sim (a paused clock has no rate to close the gap with); rarely needed by hand. |
| `roomId` (number) | Room to target (default: the single active game). |
| `clientId` (number) | Address a specific admin client id. |

#### `capture_sequence`

**Film a manoeuvre → N images on disk, in one call.** The tool for anything that only exists WHILE MOVING: a tank's turn arc, a turret slew mid-motion, a walk clip mid-stride, a tracer in flight beside a hull. `capture_subject` gets you a pose; this gets you the motion. Same subject selectors as `capture_subject` (`unitId` / `unitIds` / `def` / `position` / `area`, with the same auto-framing from the subject's own model bounds, re-framed before EVERY shot so a moving subject stays in frame). TWO MODES, and the difference is what the frames are worth: **step** (default) stops the sim and advances it by `everyNthSimFrame` between shots (`sim_step`), so the spacing is EXACT however long each capture took — this is the mode to use when the frames are evidence. **realtime** slows the sim (`simSpeed`, default 0.1) and takes the whole burst browser-side inside ONE relay evaluation, so the spacing is wall-clock-nominal — use it when the thing you want to see is the client's own animation rather than sim state. Frames are WRITTEN TO DISK and the reply carries paths plus per-frame numbers; the relay's 4 MB cap is per message, so returning a dozen images inline is a reply nobody receives. `inlineFrames` inlines the first few for a glance. The failure it refuses to hide: N well-exposed, well-framed shots of the SAME sim frame — a still life wearing a film's clothes. That comes back `ok:false` with the causes named.Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario's default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand.

| Argument | Meaning |
|---|---|
| `unitId` (number) | Film this unit. |
| `unitIds` (array) | Film these units together (merged bounds, static anchor — a subject that moves may leave frame). |
| `def` (string) | Film the newest live instance of this def known to the browser. |
| `position` (object) | Film a world point: {x, z, y?, radius?}. |
| `area` (object) | Film a ground rectangle: {x1, z1, x2, z2}. |
| `spawn` (object) | Spawn `def` first, then film it: {x, z, team?, count?}. |
| `frames` (number, default `6`) | Shots to take (2–60). Default 6. |
| `everyNthSimFrame` (number, default `3`) | Sim frames between shots. Default 3 (=0.1 game-seconds). 30 = one second apart. |
| `mode` (string, `step`\|`realtime`, default `"step"`) | step = exact spacing on a stepped sim (default). realtime = wall-clock burst on a slowed sim. |
| `simSpeed` (number) | Sim-speed multiplier to apply across the sequence (0.05–100). Defaults to 0.1 in realtime mode; in step mode it only matters if you also want the CLIENT's wall-clock animation to crawl. Restored afterwards. |
| `name` (string) | Label for the output directory. Sanitised. Default "sequence". |
| `outDir` (string) | Where to write the frames. Default <project>/data/captures/<name>/. |
| `inlineFrames` (number, default `1`) | How many frames to also return as inline MCP images (0–4). Default 1 — the first shot, so you can see it worked without opening a file. |
| `angle` (string, `three-quarter`\|`front`\|`rear`\|`side`\|`top`\|`low`) | Viewpoint preset (default three-quarter). WORLD-relative — see capture_subject. |
| `yawDeg` (number) |  |
| `pitchDeg` (number) |  |
| `fill` (number) |  |
| `maxDim` (number) | Longest edge in pixels. Defaults DOWN with the frame count in realtime mode (the whole burst shares one 4 MB reply); step mode defaults to 1280. |
| `quality` (number) | JPEG quality 0–1. |
| `reveal` | true / "auto" (default) reveals global LOS when off and restores it; false never touches LOS. |
| `trackSubject` (boolean, default `true`) | Re-frame on the subject before every shot (default true). |
| `streamSettleMs` (number) | Dwell after a spawn/reveal before the sequence starts. Default 600. |
| `settleMs` (number) | realtime mode only: wall-ms dwell between shots that the burst budget check assumes (default 250). |
| `format` (string, `jpeg`\|`png`) | Image format for the frames on disk (default jpeg). |
| `roomId` (number) |  |
| `clientId` (number) |  |

#### `order_and_film`

**Give an order, wait for the motion to actually START, then film it — one call.** The composite the unit-motion work needs: the gap between "order acknowledged" and "the unit is moving" is real (pathing, spin-up, the command queue), and it is exactly where hand-driven tooling loses the subject. Start the burst on the ack and you photograph a stationary hull; start it after a fixed sleep and the interesting part is over. So: issue the order, poll `unit_state` until the unit is genuinely moving, then hand off to `capture_sequence` with the same arguments. ONSET COUNTS ROTATION, NOT JUST TRANSLATION — a tank executing a 180° course change barely translates, and heading is the only channel that shows the turn. Thresholds are `speedThreshold` (elmos/game-second) and `turnThreshold` (degrees/game-second); either one trips it. A unit that never starts moving is filmed anyway, with `motion onset: … NEVER started moving` in the metadata — a still hull IS the finding when the order was supposed to move it.Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario's default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand.

| Argument | Meaning |
|---|---|
| `unitId` (number, **required**) | The unit to order and film. Required. |
| `order` (object) | What to do: {cmdId, params:[…], opts?} — the same shape as give_order (10=MOVE, 20=ATTACK, 15=PATROL, 16=FIGHT). Or use the shorthands below. |
| `move` (object) | Shorthand for a MOVE order: {x, z, y?}. y defaults to the terrain height. |
| `attack` (number) | Shorthand for an ATTACK order on this target unit id. |
| `frames` (number, default `8`) | Shots to take. Default 8. |
| `everyNthSimFrame` (number, default `6`) | Sim frames between shots. Default 6. |
| `mode` (string, `step`\|`realtime`, default `"step"`) |  |
| `simSpeed` (number) |  |
| `speedThreshold` (number) | Onset: elmos per game-second. Default 2. |
| `turnThreshold` (number) | Onset: degrees per game-second. Default 5. |
| `onsetTimeoutMs` (number, default `8000`) | Give up waiting for motion after this long and film anyway. Default 8000. |
| `onsetPollFrames` (number, default `3`) | Sim frames between onset samples. Default 3. |
| `name` (string) |  |
| `outDir` (string) |  |
| `inlineFrames` (number, default `1`) |  |
| `angle` (string, `three-quarter`\|`front`\|`rear`\|`side`\|`top`\|`low`) |  |
| `yawDeg` (number) |  |
| `pitchDeg` (number) |  |
| `fill` (number) |  |
| `maxDim` (number) |  |
| `quality` (number) |  |
| `reveal` |  |
| `settleMs` (number) |  |
| `format` (string, `jpeg`\|`png`) |  |
| `trackSubject` (boolean, default `true`) |  |
| `streamSettleMs` (number) |  |
| `spawn` (object) | Spawn `def` first: {x, z, team?, count?} (needs `def`). |
| `def` (string) |  |
| `roomId` (number) |  |
| `clientId` (number) |  |

## The world layer

The persistent metagame above individual battles (docs/world-layer.md). `world_status` reads, `world_commit` writes — between them they drive the whole loop without curl. Every tool takes an optional `world` selector and defaults to the lobby's primary world.

#### `world_status`

The world clock, season and config — plus, on request, the POI graph, the authority/economy stats or the faction roster. This is the read half of the world loop (world_commit is the write half): start here to see whether the clock is running, which season it is, and what is staging. `detail` picks how much comes back: "clock" (default, GET /api/world), "pois", "stats" (NOTE: settles commander authority accrual on the way past — idempotent, but it is a write), "factions", or "all".

| Argument | Meaning |
|---|---|
| `detail` (string, `clock`\|`pois`\|`stats`\|`factions`\|`all`, default `"clock"`) | How much to return |
| `world` (string) | World id (`?world=`). Omit for the lobby's primary world (the oldest active one) — that is what you want unless this lobby hosts several. |

#### `world_pois`

The POI graph: nodes (with owner, battleStatus, open staging windows and the war room id) and edges. Filter with `poi` (one node, with its edges), `kind` or `battleStatus`. A young world answers with empty arrays — that is a 200, not an error.

| Argument | Meaning |
|---|---|
| `poi` (string) | Return just this POI id (and the edges touching it) |
| `kind` (string) | Filter by POI kind |
| `battleStatus` (string, `quiet`\|`staging`\|`active`) | Filter by battle status |
| `world` (string) | World id (`?world=`). Omit for the lobby's primary world (the oldest active one) — that is what you want unless this lobby hosts several. |

#### `world_factions`

Read the faction roster and archetype catalogue, or act on membership. `action`: "list" (default, public), "me" (POST /api/world/me — this account's authority, membership and founding gate; GRANTS the starter commander the first time it clears the threshold), "found" (needs `name` + `archetype`), "join" (needs `factionId`), "leave". Joining adopts the faction's battle side when the account has none; if both are set and differ it is refused with side_mismatch rather than silently reseating you.

| Argument | Meaning |
|---|---|
| `action` (string, `list`\|`me`\|`found`\|`join`\|`leave`, default `"list"`) | What to do |
| `name` (string) | found: the faction name |
| `archetype` (string) | found: archetype key (action:"list" prints the catalogue) |
| `governance` (string) | found: governance key (optional) |
| `colour` (string) | found: colour (optional) |
| `seatPoi` (string) | found: the POI to seat at (optional) |
| `factionId` (number) | join: which faction |
| `world` (string) | World id (`?world=`). Omit for the lobby's primary world (the oldest active one) — that is what you want unless this lobby hosts several. |

#### `world_claims`

Conquest claims. `action`: "list" (default, public — every claim newest-first plus the rates), "file" (needs `poi`; charges claimPoiCost from YOUR world authority, 403 insufficient_authority with have/need when short), "withdraw" (needs `claimId`; any member of the claiming faction may withdraw, and an already-resolved claim answers withdrawn:false rather than erroring). POI ownership only ever changes through a filed, paid claim that wins — taking the map is not enough.

| Argument | Meaning |
|---|---|
| `action` (string, `list`\|`file`\|`withdraw`, default `"list"`) | What to do |
| `poi` (string) | file: the POI to claim |
| `claimId` (number) | withdraw: which claim |
| `state` (string, `open`\|`won`\|`lost`\|`expired`\|`withdrawn`) | list: filter by claim state |
| `world` (string) | World id (`?world=`). Omit for the lobby's primary world (the oldest active one) — that is what you want unless this lobby hosts several. |

#### `world_commit`

Commit force at a POI — the write half of the world loop. Opens a staging window, or joins one already open; the war room is created when the window ENDS, not now. The committed force leaves your faction's pool into a WorldEscrow row immediately (world_commit_cancel refunds it before contact; a war that ends with no verdict settles the escrow as `voided`). Your faction comes from your membership, never from the body. Common refusals: already_held (you hold it), same_side / no_side (side keys), no_battle_map (the POI has no map to fight on), window_closed (the window ended between your read and this write — re-read world_pois).

| Argument | Meaning |
|---|---|
| `poi` (string, **required**) | The POI to commit force at |
| `transports` (number, default `1`) | Transports committed |
| `squads` (number, default `1`) | Squads committed |
| `origin` (string) | Origin POI the force moves from (optional) |
| `world` (string) | World id (`?world=`). Omit for the lobby's primary world (the oldest active one) — that is what you want unless this lobby hosts several. |

#### `world_commit_cancel`

Withdraw a staging commitment before contact and refund its escrow (POST /api/world/staging/cancel). Answers cancelled:false — not an error — when the window had already closed, because by then the force is in a war. 403 not_your_commitment when the row belongs to another faction.

| Argument | Meaning |
|---|---|
| `stagingId` (number, **required**) | The stagingId from world_pois → pois[].staging[] or world_commit's answer |
| `world` (string) | World id (`?world=`). Omit for the lobby's primary world (the oldest active one) — that is what you want unless this lobby hosts several. |

#### `world_seasons`

Season archive. With no `number`, the index (newest first; the active season has endedWorldMs 0). With `number`, that season plus its archived digest rows (settlements won, POI income, decay, treasury at rollover; factionId null is the unclaimed bucket). An ACTIVE season answers 200 with empty digests — digests are written at rollover. `number` is digits only; there is no /latest.

| Argument | Meaning |
|---|---|
| `number` (number) | Season number — omit for the index |
| `world` (string) | World id (`?world=`). Omit for the lobby's primary world (the oldest active one) — that is what you want unless this lobby hosts several. |

#### `world_pause`

Pause or resume the global world clock (admin). Freezes world-clock progression ONLY — running battles keep going, so this is not a way to freeze a war (use set_speed / sim controls for that). Already-paused is a no-op answering changed:false.

| Argument | Meaning |
|---|---|
| `action` (string, `pause`\|`resume`, default `"pause"`) | pause or resume |
| `reason` (string) | Recorded with the pause |
| `world` (string) | World id (`?world=`). Omit for the lobby's primary world (the oldest active one) — that is what you want unless this lobby hosts several. |

#### `world_notifications`

Listen for world events for a bounded window and return what arrived. There is no REST route for these: the lobby pushes them down the identified chat SSE stream, so this trades the token for a stream ticket (POST /api/chat/ticket) and reads GET /api/chat/stream for `listenMs`. Events: world-staging (opened/materialised/cancelled/failed — a LATE commit joining an open window fires nothing, so silence does not mean your commit failed), world-poi (ownership changed) and world-season. Addressed to the attacking and defending factions' members and to accounts with a commander at the POI — you will see nothing about a war you have no stake in. The ticket is a credential and is never echoed back.

| Argument | Meaning |
|---|---|
| `listenMs` (number, default `10000`) | How long to listen, 100–120000 ms |
| `kinds` (array) | SSE event names to keep (default the three world events) |
| `includeOther` (boolean, default `false`) | Also return non-world events (chat) seen on the stream |
| `world` (string) | World id (`?world=`). Omit for the lobby's primary world (the oldest active one) — that is what you want unless this lobby hosts several. |

## AI players

Read and steer the AI brains. The reads run fixed, fengari-tested Lua programs (`lua-snippets.js`); the one write, `ai_guidance`, goes through the gadget's own RecvLuaMsg wire format so it exercises the same path the browser does — including the gadget's validation.

#### `ai_list`

Who is playing, and which of them are AIs. Per team: the full player roster with AI virtual players flagged, each AI's profile and authority pool, the team's active-human count, leader, team profile and pool, plus allyTeam/side/dead. This is the first call for "is an AI actually seated on team 2" — an AI that failed to spawn shows up as a team with no AI rows, not as an error.

| Argument | Meaning |
|---|---|
| `team` (number) | Restrict to one team id. Omit for every team. |
| `roomId` (number) | Room id (game instance). Omit to auto-pick the single live room. |

#### `ai_health`

Vitals for every team that seats an AI: which rulesParams the brain has written and which are MISSING BY NAME (a brain that never started leaves the whole list missing — that absence is the diagnosis), a summary of the guidance in force, and directive/org-group counts. Feature-detected against these team params: ai_profile, team_active_humans, team_leader, authority_pool, ai_slate_kinds, ai_slate_home, ai_slate_targets, ai_slate_route, ai_slate_reach; and per AI: ai_profile_<pid>, authority_player_<pid>, authority_player_<pid>_own_pool_only. There is no single "ai_health" param in the tree — this tool composes the answer.

| Argument | Meaning |
|---|---|
| `team` (number) | Restrict to one team id. Omit for every team. |
| `roomId` (number) | Room id (game instance). Omit to auto-pick the single live room. |

#### `ai_directives`

The engine directives in flight per team (type, params, conditions) and, unless includeGroups:false, the org groups with their members and current directive. Answers a clear error on an engine built without macro-orders (no Spring.GetDirectives) rather than an empty list, because "no directives" and "this engine cannot have directives" are different bugs.

| Argument | Meaning |
|---|---|
| `team` (number) | Restrict to one team id. Omit for every team. |
| `includeGroups` (boolean, default `true`) | Include org groups |
| `roomId` (number) | Room id (game instance). Omit to auto-pick the single live room. |

#### `ai_guidance`

Send ONE guidance order to a team's AI, exactly as the browser would: the order is encoded into game_ai_guidance.lua's RecvLuaMsg wire format and delivered through gadgetHandler as a player seated on the team (a human is preferred; pass playerId to choose). Ops — stance, paint, lock, delegate, fund, roe, veto. `stance` (defensive/balanced/aggressive), `roe` (free/observed_only/deny_area), `paint` (regionKey + priority/normal/forbidden), `lock` (groupId, value on/off), `delegate` (objectiveId, value on/off), `fund` (amount — a one-shot gift from the SENDER's own pool — and/or rateCap, a standing per-minute team allowance), `veto` (goalId, holds 5 minutes). Reports whether the gadget's change sequence actually moved: applied:false means the gadget REJECTED it, which is the answer you want.

| Argument | Meaning |
|---|---|
| `op` (string, `stance`\|`paint`\|`lock`\|`delegate`\|`fund`\|`roe`\|`veto`, **required**) | Which guidance op |
| `value` (string) | The enum value for stance/roe/paint, or on/off for lock/delegate |
| `regionKey` (string) | paint: the region KEY (not its display name — nl/ai_directives print keys) |
| `groupId` (number) | lock: which org group |
| `objectiveId` (number) | delegate: which objective |
| `amount` (number) | fund: one-shot authority transferred from the sender's own pool |
| `rateCap` (number) | fund: standing per-minute allowance for the team's AIs |
| `goalId` (string) | veto: a planner goal id such as "def:basin_a" or "obj:12" |
| `team` (number) | Which team's AI to steer. Required unless playerId is given (the gadget derives the team from the SENDER). |
| `playerId` (number) | Send as this player instead of auto-picking a human on the team |
| `roomId` (number) | Room id (game instance). Omit to auto-pick the single live room. |

#### `ai_context`

The natural-language context payload (places, org groups, enemies, objectives, class counts, authority) built from the SIM rather than from a browser. This is what nl_command sends when you do not supply a `context` — call it on its own to see what the parser will be told, which is usually why an utterance resolved to the wrong place.

| Argument | Meaning |
|---|---|
| `team` (number, **required**) | Which team the context is for (required) |
| `roomId` (number) | Room id (game instance). Omit to auto-pick the single live room. |

## Natural language

The NL command proxy parses an utterance into an intent envelope. Parsing is server-side; EXECUTION is client-side, so these tools answer "what did the parser make of that" and never move a unit.

#### `nl_command`

Parse a natural-language order through the game's NL command proxy and return the intent envelope. This is a PARSE, not an execution: the envelope is what a client would then run (nl-executor.ts), and nothing in the sim changes. Use it to see how an utterance resolves — which place, which group, which verb — and pass `focus`/`context` to reproduce what a specific player would have sent. With no `context`, one is built from the sim for `team` (the same payload ai_context returns), so a parse that picks the wrong region is usually a context problem, not a model problem. Refuses with nl-disabled (503) when that game server has no API key configured.

| Argument | Meaning |
|---|---|
| `utterance` (string, **required**) | What the player said, up to 500 characters |
| `team` (number) | Whose point of view to parse from — used to build the context. Required unless you pass `context`. |
| `roomId` (number) | Room id (game instance). Omit to auto-pick the single live room. |
| `context` (object) | A context payload to send verbatim instead of building one from the sim (the §2 shape: places, groups, enemies, objectives, classes, panels, self) |
| `focus` (object) | Merged into the context as `focus` — what the player is looking at. A browser sends its camera/selection focus; there is none without one. |
| `history` (array) | Prior turns for follow-ups like "now send them north" (at most 4 strings) |
| `revealContext` (boolean, default `false`) | Also return the context that was sent (large) |
