// tools.js — the spring-debug MCP tool catalogue (schemas + descriptions).
//
// Split out of server.js so the schemas can be imported WITHOUT booting a stdio
// MCP server: gen-docs.mjs renders docs/mcp-tools.md from this array, and
// self-check.mjs diffs every inputSchema against what its handler actually
// reads. server.js imports TOOLS from here; the tool names and argument names
// are a public contract used by the spring-debug / spring-test skills.

import { CLEANABLE_KINDS } from './stack-census.js';
import { MAX_STEP_FRAMES } from './capture-sequence.js';
import { WORLD_TOOLS } from './world-tools.js';
import { AI_TOOLS } from './ai-tools.js';
import { NL_TOOLS } from './nl-tools.js';
import { PATTERNS } from './drive-pattern.js';
import { RUNGS } from './tranche.js';

// --- Tool definitions ---
// Shared tail for every tool that goes over the P7 browser-eval relay —
// documented once so each description stays honest about the three gates.
export const RELAY = 'Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario\'s default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand.';

export const TOOLS = [
    {
        name: 'get_logs',
        description: 'Get recent log entries from the log server. Returns structured log entries with level, section, scope, process, frame, room_id, game_id, and message. Pass roomId to scope to a single game/room (each game server tags its logs with its room).',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID — scope to one game instance (0 for all)', default: 0 },
                game: { type: 'string', description: 'Filter by game content id (e.g. "metalstorm")' },
                level: { type: 'number', description: 'Minimum log level (0=DEBUG, 2=NOTICE, 4=ERROR)', default: 0 },
                section: { type: 'string', description: 'Filter by section (e.g. "lua", "sim", "server")' },
                scope: { type: 'string', description: 'Filter by scope (e.g. "LuaRules", "LuaGaia")' },
                sinceMinutes: { type: 'number', description: 'Only entries from the last N minutes (recency window)' },
                limit: { type: 'number', description: 'Max entries to return', default: 50 },
            },
        },
    },
    {
        name: 'search_logs',
        description: 'Full-text search across log entries. Scope a search to a single room/game and/or a recent time window to avoid a flood of historical logs — e.g. search_logs(query:"error", roomId:5, sinceMinutes:10).',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search text (substring match on message). Optional if a roomId/game filter is given.' },
                roomId: { type: 'number', description: 'Scope to one room/game instance (0 or omit for all)' },
                game: { type: 'string', description: 'Filter by game content id (e.g. "metalstorm")' },
                section: { type: 'string', description: 'Filter by section (e.g. "lua", "sim")' },
                level: { type: 'number', description: 'Minimum log level' },
                sinceMinutes: { type: 'number', description: 'Only entries from the last N minutes (recency window)' },
                limit: { type: 'number', description: 'Max entries', default: 50 },
            },
        },
    },
    {
        name: 'exec_lua',
        description: 'Execute Lua code in a specific scope on the game server. Use scope "LuaRules" for game-wide gadgets, "LuaGaia" for map gadgets, "server" for server commands.',
        inputSchema: {
            type: 'object',
            properties: {
                scope: { type: 'string', description: 'Execution scope', enum: ['LuaRules', 'LuaGaia', 'server'] },
                code: { type: 'string', description: 'Lua code or server command to execute' },
                roomId: { type: 'number', description: 'Room/game server ID (auto-detected if omitted)' },
            },
            required: ['scope', 'code'],
        },
    },
    {
        name: 'get_game_state',
        description: 'Get current game state summary from the game server. Returns a JSON object {frame, paused, speed, teams, units, luaHeapKb} (luaHeapKb is 0 when LuaRules is not loaded). Against a game server that predates the `json ` exec prefix it falls back to the legacy one-line text "frame=N teams=N units=N".',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room/game server ID (auto-detected if omitted)' },
            },
        },
    },
    {
        name: 'list_units',
        description: 'List units in the game, optionally filtered by team. Returns a JSON object {total, returned, units:[{id, def, team, hp, maxHp, x, y, z}]} — `total` counts every match of the team filter, `units` is capped at 100 rows (`returned`). Falls back to legacy text against a pre-`json ` game server.',
        inputSchema: {
            type: 'object',
            properties: {
                team: { type: 'number', description: 'Team ID (-1 for all)', default: -1 },
                roomId: { type: 'number', description: 'Room/game server ID (auto-detected if omitted)' },
            },
        },
    },
    {
        name: 'list_processes',
        description: 'List game server processes as JSON: {servers:[{roomId, port, pid, state, gameId, mapId, ready, clientCount, heartbeatAgeSec, heartbeatStale, identity}], count}. Discovery is the lobby /api/processes with a SQLite fallback; `ready`/`clientCount`/heartbeat come from the game_status table and `identity` ({stamp, engineHash, pid}) from each server\'s /api/metrics (null on a server built before P8). For strays, zombie ports and binary drift use list_stack instead.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'list_stack',
        description: 'Full dev-stack census in one call — replaces ad-hoc pgrep/lsof hunts. Returns {findings, processes, ports, authority, gameStatus, binaries, mprocs, summary}. `findings[]` classifies everything it sees: managed (lobby/logserver/vite/game servers the lobby owns), stray-server (a spring-server the lobby does not know about — e.g. a hand-launched headless run), zombie-port (a listener on 9100-10099 that is not a managed game server; blocks the next room, since room routing is by port), duplicate-lobby, orphan-vite (a vite on a fallback port — a browser pointed at it silently drives the wrong stack), stale-status-row (report-only), binary-drift (the lobby forks build/release/spring-server when it exists, so a debug-only rebuild is invisible) and stale-binary-running. Each finding carries a severity and a suggestedAction. Read-only: it never connects to the mprocs control port (a bare connect can crash mprocs) and never kills anything — that is cleanup_stack.',
        inputSchema: {
            type: 'object',
            properties: {
                probeHashes: { type: 'boolean', description: 'Also run `spring-server --print-engine-hash` on each on-disk binary and read `identity` from every running server, enabling stale-binary-running detection ("the process you are testing is not the binary you just built"). Adds ~1s. Default false.', default: false },
            },
        },
    },
    {
        name: 'cleanup_stack',
        description: 'Kill the non-managed processes list_stack found. CALL WITH dryRun:true FIRST (the default) — it returns the exact plan (pid, kind, signal sequence) and touches nothing. Acts only on stray-server, zombie-port, orphan-vite and duplicate-lobby; `managed` processes are never touched (to stop a real game use end_game({roomId}), which drains gracefully), and stale game_status rows are report-only. Hard invariants: the pid holding :8011 is never killed whatever its classification; ONE LIVE STACK PER MACHINE — a pid is refused unless it was started by stack_start (this session\'s or a prior one), because the dev stack you are most likely looking at belongs to the user\'s own interactive mprocs and killing it out from under them is the one outcome that costs a whole session; stray-server is refused entirely when the lobby is unreachable (with no authority, "stray" cannot be established); a zombie-port pid whose command is not spring-server needs force:true. `force:true` overrides BOTH the ownership refusal and the zombie-port command check — pass it only once you have actually looked at what you are about to kill (e.g. via list_stack). Kill discipline is SIGTERM → poll 5s → SIGKILL, because spring-server turns SIGTERM into a clean exit checkpoint.',
        inputSchema: {
            type: 'object',
            properties: {
                dryRun: { type: 'boolean', description: 'Report the plan without killing anything. Default TRUE.', default: true },
                kinds: { type: 'array', items: { type: 'string', enum: CLEANABLE_KINDS }, description: `Restrict to these classifications (default: all of ${CLEANABLE_KINDS.join(', ')}).` },
                force: { type: 'boolean', description: 'Allow killing a pid that stack_start did not start, AND a zombie-port pid whose command line is not spring-server. Both checks exist because the 9100-10099 range can catch unrelated dev tools, and because most running processes are the user\'s own mprocs stack, not this tool\'s. Default false.', default: false },
            },
        },
    },
    {
        name: 'stack_start',
        description: 'Launch logserver/lobby/vite from mprocs.yaml\'s own `shell:` lines — nohup, detached, cwd = the main checkout (PROJECT_ROOT or TASKHERD_REPO), logging to .tasks/logs/stack-<service>.log. Refuses outright if ANY requested port (:8010/:8011/:8012) is already held — one live stack per machine: that is very likely the user\'s own mprocs session, and starting a second lobby on the same db races SO_REUSEPORT accepts between them (see list_stack\'s duplicate-lobby finding). NOT a substitute for mprocs: no TUI, no restart-proc, no log-tail panes — prefer the user\'s own mprocs when one might already be running (check with list_stack first); this exists for when nothing is up at all (CI, a fresh box, a headless session). Every pid it starts is recorded so cleanup_stack will later kill it without needing force:true.',
        inputSchema: {
            type: 'object',
            properties: {
                services: { type: 'array', items: { type: 'string', enum: ['logserver', 'lobby', 'vite'] }, description: 'Subset to start. Default: all three, in logserver, lobby, vite order.' },
            },
        },
    },
    {
        name: 'lobby_log',
        description: 'Tail the lobby process\'s own stdout/stderr. NOT covered by get_logs/search_logs — those read the log server, which the lobby never posts its own startup/crash output to; this is the only MCP-side view of it. Reads .tasks/logs/stack-lobby.log, which only exists once the lobby has been started with stack_start — a lobby started from the user\'s own interactive mprocs TUI keeps its output in the mprocs pane only, nothing on disk. When the file is missing this says so and points at the mprocs pane / `spring-services.sh status` instead of erroring.',
        inputSchema: {
            type: 'object',
            properties: {
                lines: { type: 'number', description: 'Tail this many lines from the end of the log. Default 200.', default: 200 },
            },
        },
    },
    {
        name: 'get_lua_source',
        description: 'Read a Lua source file from the game content via HTTP. Path relative to game root.',
        inputSchema: {
            type: 'object',
            properties: {
                gameId: { type: 'string', description: 'Game ID (e.g. "metalstorm")' },
                filePath: { type: 'string', description: 'File path relative to game root (e.g. "LuaRules/Gadgets/unit_spawner.lua")' },
            },
            required: ['gameId', 'filePath'],
        },
    },
    {
        name: 'list_gadgets',
        description: 'List loaded Lua gadgets and their status on the game server.',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room/game server ID (auto-detected if omitted)' },
            },
        },
    },
    {
        name: 'query_db',
        description: 'Execute a read-only SQL query against the lobby database. The file opened is detected from the RUNNING lobby\'s own `--db` argument (falling back to PROJECT_ROOT/TASKHERD_REPO + data/spring-server.db, or SPRING_DB if set) — never assumed — because this is the one tool that reads the filesystem directly rather than the live lobby\'s HTTP API, so a stale assumption here is invisible everywhere else. Every answer is prefixed with `-- db: <path> (<source>)` naming exactly which file and how it was chosen.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'SQL query — only row-returning statements are allowed (SELECT, WITH … SELECT, EXPLAIN, PRAGMA reads)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'list_sessions',
        description: 'List recent game sessions from the log server.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'restart_lobby',
        description: 'Restart the lobby server in-place (re-exec with same args, same pid — mprocs stays authoritative). Running game servers are preserved. Use after rebuilding spring-lobby.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'restart_logserver',
        description: 'Restart the log server (:8010) in-place (re-exec with same args, same pid — mprocs stays authoritative). Use after rebuilding spring-logserver, or to recover the log pipeline if it stops responding.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'restart_game',
        description: 'Restart a running game server in-place (re-exec with same args). Clients are notified and will reconnect. Use after rebuilding spring-server.',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID (0 or omit for first active game)' },
            },
        },
    },
    {
        name: 'restart_client',
        description: 'Restart the Vite client dev server (:8012) via the mprocs control channel (select-proc + restart-proc — the pane stays authoritative, no dead pane / duplicate listener). Use after editing a worker-imported client file (entity-renderer.ts, game-processor.ts, …): Vite serves a stale `?worker` bundle until the pane is restarted. Unlike the C++ servers, Vite has no in-place re-exec. Requires mprocs started with the `server:` key (mprocs.yaml); otherwise it falls back to kill+relaunch.',
        inputSchema: {
            type: 'object',
            properties: {
                clearCache: { type: 'boolean', description: 'Also clear client/node_modules/.vite before restarting (use if a plain restart still serves stale worker code). Default false.' },
            },
        },
    },
    {
        name: 'get_unit_def',
        description: 'Read a single UnitDef from the on-disk defs cache without needing a running game. Decodes the FlatBuffer baked by spring-server. Returns full Tier 4 fields including customParams, transportSize, repairSpeed, yardmap, etc.',
        inputSchema: {
            type: 'object',
            properties: {
                gameId: { type: 'string', description: 'Game ID (e.g. "metalstorm")' },
                name: { type: 'string', description: 'Unit def name (e.g. "fable_tank") OR omit and pass defId' },
                defId: { type: 'number', description: 'Numeric def ID. Either name or defId is required.' },
            },
            required: ['gameId'],
        },
    },
    {
        name: 'list_unit_defs',
        description: 'List all UnitDefs from the cache, optionally filtered by name pattern. Use this to scan customParams, find units with a particular field set, etc. Returns names + summary fields by default; pass full=true for complete records.',
        inputSchema: {
            type: 'object',
            properties: {
                gameId: { type: 'string', description: 'Game ID (e.g. "metalstorm")' },
                pattern: { type: 'string', description: 'Substring filter on def name (case-insensitive). Omit for all.' },
                full: { type: 'boolean', description: 'If true, return full def records. Default: name + key fields only.', default: false },
                limit: { type: 'number', description: 'Max results', default: 50 },
            },
            required: ['gameId'],
        },
    },
    {
        name: 'get_weapon_def',
        description: 'Read a single WeaponDef from the on-disk defs cache. Decodes the FlatBuffer baked by spring-server.',
        inputSchema: {
            type: 'object',
            properties: {
                gameId: { type: 'string', description: 'Game ID (e.g. "metalstorm")' },
                name: { type: 'string', description: 'Weapon def name OR omit and pass defId' },
                defId: { type: 'number', description: 'Numeric weapon def ID. Either name or defId is required.' },
            },
            required: ['gameId'],
        },
    },
    {
        name: 'clear_defs_cache',
        description: 'Delete the baked defs cache (unitdefs/weapondefs/cegdefs/featuredefs .lua.br + power.json, plus legacy .bin orphans) for a game, or all games. Forces the next game session to re-bake from source. Required after schema changes that did NOT bump the cache key. Cheaper than killing the running game.',
        inputSchema: {
            type: 'object',
            properties: {
                gameId: { type: 'string', description: 'Game ID to clear. Omit to clear all games.' },
            },
        },
    },
    {
        name: 'kill_game',
        description: 'DEPRECATED — alias for end_game(graceful:false). Force-kills the spring-server process for a room (SIGKILL, no exit checkpoint). Prefer end_game. roomId is required.',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID (required — omitting it now refuses with a candidate list)' },
            },
        },
    },
    {
        name: 'end_game',
        description: "Gracefully stop ONE room's game server. Prefers the lobby's POST /api/admin/rooms/end, which returns a drain-quality report: the exit checkpoint verified against the snapshot store (outcome, frame, lossy) plus resume eligibility. A route-level 404 means a lobby binary older than P4 — falls back to a direct SIGTERM/poll/SIGKILL from the MCP process (source:'sigterm-fallback'); an auth/validation failure is reported, never silently downgraded. NOTE: the room flips to \"ended\" asynchronously via the lobby health loop, not in this response — poll /api/rooms or probe_game if you need to observe it. To stop a room cleanly WITH a report use this, not a same-name launch_direct relaunch (that SIGTERMs, deletes and respawns). kill_game is the deprecated graceful:false alias.",
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID (required — omitting it refuses with a candidate list).' },
                graceful: { type: 'boolean', default: true, description: 'false → SIGKILL immediately from the MCP process (same as deprecated kill_game); no server report, no exit checkpoint.' },
                timeoutMs: { type: 'number', default: 10000, description: 'How long to wait for the exit checkpoint before escalating to SIGKILL. The server caps this at 30000.' },
                escalate: { type: 'boolean', default: true, description: 'SIGKILL if the server has not exited within timeoutMs. false leaves a stuck server alive and reports outcome "still_alive".' },
            },
            required: ['roomId'],
        },
    },
    {
        name: 'get_frame',
        description: 'Current sim frame + simFps via the public /api/metrics endpoint (no exec, no auth, works while paused).',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room/game server ID (auto-detected if omitted)' },
            },
        },
    },
    {
        name: 'probe_game',
        description: "One-shot readiness probe for a game server. Composes the lobby process row, pid liveness, the game_status heartbeat and /api/metrics into a single phase: spawning (process up, nothing published yet) | loading (heartbeat present, ready=0 or stale) | ready (accepting connections) | ticking (sim advancing) | dead (no process row, or the pid is gone). Use wait_for_game to poll until a phase is reached.",
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID. Omit to auto-pick the newest non-ended game.' },
            },
        },
    },
    {
        name: 'wait_for_game',
        description: "Poll a game server (via probe_game) until it reaches a readiness phase (ready = accepting connections, ticking = sim advancing) or a target frame. Fails FAST on server death: returns phase 'dead' immediately with the last room-scoped log lines instead of waiting out the timeout. A timeout returns timedOut:true plus the honest last probe rather than throwing.",
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID. Omit to auto-pick the newest non-ended game (resolved once, then pinned).' },
                until: { type: 'string', enum: ['ready', 'ticking', 'frame'], default: 'ready', description: "until='ready' is satisfied by ready OR ticking." },
                frame: { type: 'number', description: "Target sim frame (required when until='frame')." },
                timeoutMs: { type: 'number', default: 120000 },
                pollMs: { type: 'number', default: 500 },
            },
        },
    },
    {
        name: 'revive_team',
        description: 'Flip a dead team (or all dead teams) back to alive so units can be spawned onto it. Pairs with set_cheats to stop the game-over check re-killing it.',
        inputSchema: {
            type: 'object',
            properties: {
                team: { type: 'number', description: 'Team ID. Omit to revive all dead teams.' },
                roomId: { type: 'number', description: 'Room/game server ID (auto-detected if omitted)' },
            },
        },
    },
    {
        name: 'set_stockpile',
        description: "Insta-fill a unit's stockpile weapon (missiles etc.) — skips the build cycle. Wraps the server `stockpile` verb.",
        inputSchema: {
            type: 'object',
            properties: {
                unitId: { type: 'number' },
                count: { type: 'number', description: 'Stockpiled shots to set.' },
                queued: { type: 'number', default: 0 },
                roomId: { type: 'number', description: 'Room/game server ID (auto-detected if omitted)' },
            },
            required: ['unitId', 'count'],
        },
    },
    {
        name: 'profile',
        description: 'Server-side profilers. target=lua → per-callin synced Lua wall-time; target=sim → SimFrame phase split (native sim / unit scripts / Lua call-ins, also surfaced under /api/metrics simFrame). action: on|off|reset|status|report.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', enum: ['lua', 'sim'] },
                action: { type: 'string', enum: ['on', 'off', 'reset', 'status', 'report'], default: 'report' },
                topN: { type: 'number', description: 'Row cap for target=lua report (default 25).' },
                roomId: { type: 'number', description: 'Room/game server ID (auto-detected if omitted)' },
            },
            required: ['target'],
        },
    },
    {
        name: 'launch_game',
        description: 'Launch a fresh game directly via the lobby HTTP API — bypasses the lobby UI. Creates a room (or reuses existing one for the user), adds an AI slot, marks the host ready, and starts the game. Waits (via probe_game) until the server is accepting connections, failing fast if it dies during boot. Returns the new room ID, gameServerPort, the readiness `phase`, and — on failure only — `lastLogs`.',
        inputSchema: {
            type: 'object',
            properties: {
                gameId: { type: 'string', description: 'Game ID (default "metalstorm"; BAR/ZK are archived)', default: 'metalstorm' },
                mapId: { type: 'string', description: 'Map ID (e.g. "meridian_basin")' },
                roomName: { type: 'string', description: 'Room name', default: 'debug' },
                ai: { type: 'string', description: 'AI to add for the opposing team. Set to "" to skip AI. Default: "null" (Null AI engine bot).', default: 'null' },
                username: { type: 'string', description: 'Username to launch as. Defaults to admin / SPRING_USER.' },
                password: { type: 'string', description: 'Password. Defaults to SPRING_PASS.' },
                clearCache: { type: 'boolean', description: 'Delete the defs cache before launching to force a fresh bake.', default: false },
                testStartupSelector: { type: 'boolean', description: 'Legacy (ZK-only, archived): keep the "Startup Info and Selector" overlay enabled in the suggested browserUrl. A no-op for Metalstorm; kept because the name is a public argument.', default: false },
            },
            required: ['mapId'],
        },
    },
    {
        name: 'launch_scenario',
        description: 'Launch a scenario game directly (no lobby UI, no manifest files): resolves the scenario via GET /api/games/<gameId>/scenarios, builds the /api/rooms/direct manifest in memory with the scenario as the TOP-LEVEL field (modoptions.scenario alone gets overwritten by the map default), POSTs it, and waits for the sim to tick. Re-launching the same scenario replaces the previous room (same room name → teardown + recreate). Returns {roomId, port, sessions, browserUrl} — browserUrl attaches to THIS room (?play= + room + token in the URL hash) and never re-launches; the token is in the hash fragment, so it stays out of server logs but does land in browser history (dev feature). Requires the lobby to run with --dev-direct-start. A players[] entry naming an unknown username creates an is_dev account; the defaults never do.',
        inputSchema: {
            type: 'object',
            properties: {
                scenarioId: { type: 'string', description: 'Scenario id — the file stem of data/games/<gameId>/scenarios/<id>.lua (e.g. "crossing_standoff").' },
                gameId: { type: 'string', default: 'metalstorm', description: 'Game the scenario belongs to.' },
                openBrowser: { type: 'boolean', default: false, description: 'Open a browser client on browserUrl and wait for it to connect, then re-probe. The default roster seats a HUMAN, so without this the sim holds at frame -1 and every relay tool answers "no connected admin client" — with it, wait:"ticking" is reachable in one call. The browser is tracked and end_game closes it. Returns its report under `browser`.' },
                browserHeadless: { type: 'boolean', default: true, description: 'Headless browser for openBrowser (renders identically; opens no window). false to watch the run.' },
                mapId: { type: 'string', description: 'Map override. Default: the scenario\'s declared world.map.' },
                ai: { type: 'string', default: 'null', description: 'AI id seated on every non-host playable side ("null", "strategos"). "" = no AI slots (the lobby\'s solo-team safety net may still add a Null AI).' },
                players: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            username: { type: 'string' },
                            team: { type: 'number' },
                            side: { type: 'string', description: 'Playable faction key; resolved to that side\'s team.' },
                            spectator: { type: 'boolean' },
                        },
                        required: ['username'],
                    },
                    description: 'Default [{username:"admin"}] seated on the scenario\'s first playable side. players[0] is the room host; extras default to spectators.',
                },
                side: { type: 'string', description: 'Shorthand: seat players[0] on this faction\'s side.' },
                modoptions: { type: 'object', description: 'Extra modoptions. A "scenario" key here is hoisted to the manifest top level (it does NOT work as a modoption).' },
                roomName: { type: 'string', description: 'Room name. Default "mcp:<scenarioId>". Re-POSTing a name replaces that room.' },
                headless: { type: 'boolean', default: false, description: 'No browser will connect: omit browserUrl and warn about the idle-grace self-exit (workaround: lobby env SPRING_IDLE_STARTUP_GRACE_SECONDS).' },
                wait: { type: 'string', enum: ['none', 'ready', 'ticking'], default: 'ticking', description: 'Return immediately, when the game server answers /api/metrics, or when the sim frame advances.' },
                waitTimeoutMs: { type: 'number', default: 120000 },
                idleGraceSeconds: { type: 'number', description: 'Written to the manifest as idleStartupGraceSeconds: how long the server waits for its first client before self-exiting (default 120s, which kills a browserless run at frame -1). Silently inert on lobby binaries older than P3 — fallback there is the lobby env SPRING_IDLE_STARTUP_GRACE_SECONDS.' },
                skipBriefing: { type: 'boolean', default: true, description: 'Append &skipBriefing=1 to browserUrl (S2 splash bypass).' },
                revealTokens: { type: 'boolean', default: false, description: 'Return the raw `sessions` bearer tokens. Default false: values are redacted (browserUrl still carries the host token in its hash — that is the attach mechanism).' },
                force: { type: 'boolean', default: false, description: 'Launch even if the scenario is not in the lobby\'s (startup-snapshot) list — the direct path reads the VFS fresh. Requires mapId; sides default to the legacy two-team shape.' },
            },
            required: ['scenarioId'],
        },
    },
    {
        name: 'launch_direct',
        description: 'Launch a game from a RAW /api/rooms/direct manifest — the manual sibling of launch_scenario (which builds its manifest in memory from a scenarioId; prefer that for scenario tests, and this one for full control: custom rosters, modoptions, sessionKind, idle timers). Takes a manifest by name from manifests/, inline, or both merged, POSTs it, and waits for the sim to tick. Merge order: file manifest → `manifest` deep-merged on top (objects recurse; arrays and scalars replace) → `overrides` shallow-merged last (top-level keys replaced wholesale). Manifest shape: {name, map (required), game, sessionKind, scenario (TOP-LEVEL — modoptions.scenario alone is overwritten by the map default), modoptions{}, players[] (>=1; players[0] is the host; {username, team, startPos, spectator}), aiSlots[] ({aiId, team, startPos, profile}), autoStart, idleStartupGraceSeconds, idleExitSeconds}. `name` is IDEMPOTENT BY REPLACEMENT: re-POSTing a name SIGTERMs that room\'s server and recreates the room (a clean restart, not an error), and a manifest with no name defaults to "dev:direct", so two unnamed launches silently clobber each other — concurrent lanes must set distinct names. Declared players are force-left from any prior room. Requires the lobby to run with --dev-direct-start. Returns {roomId, port, sessions, players, aiSlots, browserUrl, phase, frame, notes}.',
        inputSchema: {
            type: 'object',
            properties: {
                manifestName: { type: 'string', description: 'File stem under manifests/ (e.g. "crossing_standoff_direct"). A miss lists the available names.' },
                manifest: { type: 'object', description: 'Inline manifest, deep-merged OVER the file one. Use alone for a fully inline launch.' },
                overrides: { type: 'object', description: 'Shallow merge applied last — top-level keys replace wholesale. The escape hatch when deep-merge is wrong (e.g. swapping the whole players[] array).' },
                wait: { type: 'string', enum: ['none', 'ready', 'ticking'], default: 'ticking', description: 'Return after the POST, when the game server answers /api/metrics, or when the sim frame advances. NOTE: a skirmish holds GameStart until its rostered humans connect — an exec-only test with human players must use "ready" (or an AI-only/spectator roster, or sessionKind:"persistent", neither of which waits).' },
                timeoutMs: { type: 'number', default: 120000, description: 'Wait budget in ms.' },
                clearCache: { type: 'boolean', default: false, description: 'Delete the defs cache for the manifest\'s game before launching.' },
                revealTokens: { type: 'boolean', default: false, description: 'Return the raw `sessions` bearer tokens (default: redacted).' },
                idleGraceSeconds: { type: 'number', description: 'Sugar for manifest.idleStartupGraceSeconds — how long the server waits for its first client before self-exiting (default 120s, which kills exec-driven tests at frame -1). Ignored without error by lobby binaries older than P3; fallback there is to start the LOBBY with SPRING_IDLE_STARTUP_GRACE_SECONDS in its env (applies to every room it spawns, so pair it with end_game teardown).' },
            },
        },
    },
    {
        name: 'api_request',
        description: 'Make an authenticated HTTP request to the lobby, log server, or a specific game server. Tokens are obtained automatically (admin/admin by default — override via SPRING_USER/SPRING_PASS env). Prefer this over running curl + setting Authorization headers manually.',
        inputSchema: {
            type: 'object',
            properties: {
                target: {
                    type: 'string',
                    description: 'Which server to hit. "lobby" → :8011, "log" → :8010, "game" → dynamic game server (uses roomId or first running), "url" → use the absolute `url` arg verbatim.',
                    enum: ['lobby', 'log', 'game', 'url'],
                    default: 'lobby',
                },
                path: { type: 'string', description: 'Path beginning with "/", e.g. "/api/rooms". Ignored when target="url".' },
                url: { type: 'string', description: 'Absolute URL (only when target="url").' },
                method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], default: 'GET' },
                body: { description: 'Request body. Plain object/array → JSON, string → sent verbatim.' },
                headers: { type: 'object', description: 'Extra request headers as a {name: value} map.' },
                roomId: { type: 'number', description: 'Game server room ID (when target="game"). Omit to pick the first active game.' },
                auth: { type: 'boolean', default: true, description: 'Attach Bearer auth header. Set false for unauthenticated probes.' },
                expectJson: { type: 'boolean', default: true, description: 'Parse the response as JSON when true; otherwise return raw text.' },
                timeoutMs: { type: 'number', default: 30000, description: 'Abort the request after this long (500–300000). Every MCP network call has a deadline; this is the one you can raise for a slow admin route.' },
            },
        },
    },
    {
        name: 'spawn_unit',
        description: 'Spawn one or more units of a given def at a world XZ position on a team. Wraps the LuaExecEngine `server spawn` verb (which delegates to Spring.CreateUnit on the LuaRules synced state, so Allow* veto rules apply). Y is auto-resolved via Spring.GetGroundHeight. When count > 1 the server lays them out in a square grid 48 elmos apart. Returns a JSON object {spawned, ids:[...]}; falls back to the legacy "spawned N unit(s): ..." text against a pre-`json ` game server.',
        inputSchema: {
            type: 'object',
            properties: {
                defName: { type: 'string', description: 'Unit def name (e.g. "fable_tank").' },
                x: { type: 'number', description: 'World X coordinate (elmos).' },
                z: { type: 'number', description: 'World Z coordinate (elmos).' },
                team: { type: 'number', description: 'Owning team ID', default: 0 },
                count: { type: 'number', description: 'How many to spawn (max 256)', default: 1 },
                roomId: { type: 'number', description: 'Room/game server ID (auto-detected if omitted)' },
            },
            required: ['defName', 'x', 'z'],
        },
    },
    {
        name: 'kill_unit',
        description: 'Destroy a unit by ID via Spring.DestroyUnit. Optional self-destruct flag (plays the unit\'s death animation/explosion) and reclaim flag (drops a wreckage feature instead of nothing).',
        inputSchema: {
            type: 'object',
            properties: {
                unitId: { type: 'number', description: 'Sim unit ID to destroy.' },
                selfDestruct: { type: 'boolean', default: false },
                reclaimed: { type: 'boolean', default: false },
                roomId: { type: 'number' },
            },
            required: ['unitId'],
        },
    },
    {
        name: 'damage_unit',
        description: 'Apply damage to a unit via Spring.AddUnitDamage. Returns the post-damage health.',
        inputSchema: {
            type: 'object',
            properties: {
                unitId: { type: 'number' },
                amount: { type: 'number', description: 'HP of damage to apply.' },
                paralyze: { type: 'boolean', default: false },
                roomId: { type: 'number' },
            },
            required: ['unitId', 'amount'],
        },
    },
    {
        name: 'give_order',
        description: 'Issue a single command to a unit via Spring.GiveOrderToUnit. Use the standard CMD.* numeric IDs (10=MOVE, 20=ATTACK, 0=STOP, 90=RECLAIM, 25=GUARD, 15=PATROL, 16=FIGHT, etc. — see client/src/core/command-buffer.ts for the full table).',
        inputSchema: {
            type: 'object',
            properties: {
                unitId: { type: 'number' },
                cmdId: { type: 'number', description: 'Spring command ID, e.g. 10=MOVE, 20=ATTACK.' },
                params: { type: 'array', items: { type: 'number' }, description: 'Up to 4 numeric params (e.g. [x,y,z] for MOVE, [targetUnitId] for ATTACK).', default: [] },
                opts: { type: 'number', description: 'Spring command-options bitfield (32=SHIFT/queue).', default: 0 },
                roomId: { type: 'number' },
            },
            required: ['unitId', 'cmdId'],
        },
    },
    {
        name: 'clear_units',
        description: 'Wipe every unit (or every unit on a team) via Spring.DestroyUnit on each. Useful between test cases.',
        inputSchema: {
            type: 'object',
            properties: {
                team: { type: 'number', description: 'Team ID. Omit to clear ALL units on every team.' },
                roomId: { type: 'number' },
            },
        },
    },
    {
        name: 'get_unit_state',
        description: 'Dump health, position, team, weapons, and per-weapon target/range/reload state for a single unit. Reads sim state directly (no Lua round-trip). Returns a JSON object {id, def, team, hp, maxHp, pos:{x,y,z}, heading, weapons:[{index, def, range, reloadFrame, hasTarget}]} — `index` is the unit\'s own weapon slot (null slots are skipped, so the array can be shorter). Falls back to legacy text against a pre-`json ` game server.',
        inputSchema: {
            type: 'object',
            properties: {
                unitId: { type: 'number' },
                roomId: { type: 'number' },
            },
            required: ['unitId'],
        },
    },
    {
        name: 'set_debug_logging',
        description: 'Toggle one or more debug-log subsystems on the game server. Logged lines surface via get_logs / search_logs (section= the subsystem name). Subsystems: combat (damage/hit/kill events), sound (every SoundEvent push), weapon (every CWeapon::Fire), explosion (planned), order (planned), unit (planned), script (planned). Returns the post-call status string.',
        inputSchema: {
            type: 'object',
            properties: {
                combat:    { type: 'boolean' },
                sound:     { type: 'boolean' },
                weapon:    { type: 'boolean' },
                explosion: { type: 'boolean' },
                order:     { type: 'boolean' },
                unit:      { type: 'boolean' },
                script:    { type: 'boolean' },
                roomId:    { type: 'number' },
            },
        },
    },
    {
        name: 'get_combat_summary',
        description: 'Quick-look queue depths for combat events and sound events still pending broadcast. Useful for sanity-checking that combat is actually happening. Returns a JSON object {combat, sounds}; falls back to legacy text against a pre-`json ` game server.',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number' },
            },
        },
    },
    {
        name: 'pause_sim',
        description: 'Pause / unpause the server simulation tick (gs->paused). Sim freezes; the client keeps rendering. Pair with `set_render_paused` (browser-side) when you want a fully-frozen scene for a screenshot.',
        inputSchema: {
            type: 'object',
            properties: {
                paused: { type: 'boolean' },
                roomId: { type: 'number' },
            },
            required: ['paused'],
        },
    },
    {
        name: 'set_sim_speed',
        description: 'Set the sim speed multiplier (range 0.05 – 100). 1 = normal, 2 = double, 0.1 = ten-times slower. Useful for slow-mo combat inspection or fast-forwarding past dead time in long tests.',
        inputSchema: {
            type: 'object',
            properties: {
                multiplier: { type: 'number' },
                roomId:     { type: 'number' },
            },
            required: ['multiplier'],
        },
    },
    {
        name: 'set_los',
        description: 'Toggle global line-of-sight for every ally team (reveals the whole map for spectators and players alike). Wraps the `los on|off|status` server verb, which calls losHandler->SetGlobalLOS for each active ally team. Useful for debugging: with LOS off you can\'t see enemy units; with global LOS on the whole map streams to every viewport.',
        inputSchema: {
            type: 'object',
            properties: {
                enable: { type: 'boolean', description: 'true → reveal map; false → restore normal LOS; omit → return current state.' },
                roomId: { type: 'number' },
            },
        },
    },
    {
        name: 'set_cheats',
        description: 'Toggle cheat mode on the game server (gs->cheatEnabled + gs->godMode). When on, Lua paths gated by `if gs->cheatEnabled` (Spring.SetUnitHealth above max, Spring.CreateUnit on any team, etc.) start working from any caller. Pairs with `set_unit_invulnerable` for sustained combat-FX testing.',
        inputSchema: {
            type: 'object',
            properties: {
                enable: { type: 'boolean', description: 'true → enable cheats; false → disable; omit → return current state.' },
                roomId: { type: 'number' },
            },
        },
    },
    {
        name: 'set_unit_invulnerable',
        description: 'Make a specific unit immune to damage (toggles a CUnit::invulnerable flag that short-circuits DoDamage on the very first line). Survives weapon hits, AddUnitDamage, water damage, self-destruct attempts — everything funnels through DoDamage. Useful for keeping a damage target alive while you study impact CEGs or beam-hit FX.',
        inputSchema: {
            type: 'object',
            properties: {
                unitId: { type: 'number' },
                invulnerable: { type: 'boolean', description: 'true → immune; false → restore normal damage; omit → return current state.' },
                roomId: { type: 'number' },
            },
            required: ['unitId'],
        },
    },
    {
        name: 'spawn_at_camera',
        description: 'Spawn one or more units at the current browser camera\'s look-at position. Reads `window.test.cameraPose().lookAt` in the browser and forwards to `window.test.spawn(...)`, returning {x, z, response}. ' + RELAY,
        inputSchema: {
            type: 'object',
            properties: {
                defName: { type: 'string', description: 'Unit def name (e.g. "fable_tank").' },
                team: { type: 'number', description: 'Owning team ID', default: 0 },
                count: { type: 'number', description: 'How many to spawn (max 256)', default: 1 },
                offset: { type: 'object', description: 'Optional XZ offset from camera look-at, e.g. {x:200, z:0} to spawn 200 elmos east.' },
                roomId: { type: 'number', description: 'Room to target (default: the single active game).' },
                clientId: { type: 'number', description: 'Address a specific admin client id.' },
            },
            required: ['defName'],
        },
    },
    {
        name: 'browser_test',
        description: 'Call a TestHarness method on `window.test` in the browser and return its result. ' + RELAY + ' Methods: focus(unitId), focusOn(x,z), pause(), resume(), screenshot(), saveScreenshot(name), select([ids]), spawnAndFocus(def,x,z,team), stageCombat(atk,tgt,x,z), state(), units(team), unitState(id), highResScreenshot(w,h), simPause(), simResume(), simSpeed(n). Performance profiling (see docs/debugging-performance.md): perfDump(windowMs?) / perfReset() — permanent per-phase (camera/entity/fx/render/ui/total) frame-time distribution; uiProfileStart() / uiProfileDump(topN?) / uiProfileStop() — per-widget LuaUI Fengari cost breakdown (call dump BEFORE stop, not after — stop clears the data); netSim({delayMs,jitterMs,lossProb}) / netSimOff() / netSimPreset("lan"|"wan"|"intercont") / netStats() — simulate WAN conditions and tally bandwidth per message type.',
        inputSchema: {
            type: 'object',
            properties: {
                method: { type: 'string', description: 'TestHarness method name.' },
                args:   { type: 'array', description: 'JSON-serialisable args. Strings become quoted, numbers/bools/arrays passed through.', default: [] },
                roomId: { type: 'number', description: 'Room to target (default: the single active game).' },
                clientId: { type: 'number', description: 'Address a specific admin client id.' },
            },
            required: ['method'],
        },
    },
    {
        name: 'evaluate_widget_lua',
        description: 'Run a Lua snippet in the LuaUI widget runtime (browser-side render worker) and return its result string. Use when you need to inspect WG, widgetHandler, _widgetErrors, or call any Spring.* function as the player would see it. ' + RELAY,
        inputSchema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'Lua code. Last expression returned via "return …".' },
                roomId: { type: 'number', description: 'Room to target (default: the single active game).' },
                clientId: { type: 'number', description: 'Address a specific admin client id.' },
            },
            required: ['code'],
        },
    },

    {
        name: 'client_eval',
        description: 'Execute arbitrary code inside a connected browser client and return the result. ' + RELAY + ' Targets: "js" (main-thread global scope — document, window.test, window.widgets), "worker" (render-worker global scope — the __entityRenderer / __csm / __renderPipeline / __fxLightPool debug hooks the render-core move stranded there), "widgets" (Lua source run in the in-worker LuaUI runtime), "test" (an expression with the `test` harness already bound, e.g. `readyState()` or `captureFrame({maxDim:640})`). `output` is JSON-parsed when it parses. Keep results well under 4 MB — that is the wire control-message cap.',
        inputSchema: {
            type: 'object',
            properties: {
                code:      { type: 'string', description: 'Code to run (JS, or Lua for target "widgets").' },
                target:    { type: 'string', enum: ['js', 'worker', 'widgets', 'test'], description: 'Which executor runs it.', default: 'js' },
                roomId:    { type: 'number', description: 'Room to target (default: the single active game).' },
                clientId:  { type: 'number', description: 'Address a specific connected client id; it must still be an admin session. Default: the lowest-id admin client.' },
                timeoutMs: { type: 'number', description: 'Server-side wait, 500–60000. Default 10000.', default: 10000 },
            },
            required: ['code'],
        },
    },
    {
        name: 'client_ready',
        description: 'Client-side readiness: relays `window.test.readyState()` to the connected browser and returns its report (renderer up, defs ingested, LuaUI booted, newest game frame, feed age). ' + RELAY + ' This is the BROWSER\'s view — for server-side readiness (sim ticking, players seated) use `wait_for_game` instead; the two answer different questions and a game can be server-ready while the tab is still ingesting defs.',
        inputSchema: {
            type: 'object',
            properties: {
                roomId:   { type: 'number', description: 'Room to target (default: the single active game).' },
                clientId: { type: 'number', description: 'Address a specific admin client id.' },
            },
        },
    },
    {
        name: 'client_screenshot',
        description: 'Capture the browser client\'s rendered frame and return it as an image you can actually look at, plus a text block of capture metadata (width/height, frameId, gameFrame, per-phase stats, byte size). Relays `window.test.captureFrame({maxDim, stats:true})`, which waits for a real presented frame rather than grabbing a stale backbuffer. ' + RELAY + ' maxDim is clamped to 2048 to stay well inside the 4 MB wire cap.',
        inputSchema: {
            type: 'object',
            properties: {
                maxDim:   { type: 'number', description: 'Longest edge in pixels, 64–2048.', default: 1280 },
                quality:  { type: 'number', description: 'JPEG quality 0–1 (passed through to captureFrame).' },
                roomId:   { type: 'number', description: 'Room to target (default: the single active game).' },
                clientId: { type: 'number', description: 'Address a specific admin client id.' },
            },
        },
    },

    {
        name: 'capture_subject',
        description: '**Subject → usable image, in ONE call.** The tool to reach for whenever you want to LOOK at something in a running game; do not hand-roll camera math out of `browser_test focus` + `client_screenshot` again. '
            + 'Pass ONE subject — `unitId`, `unitIds` (framed together), `def` (the newest live instance this client actually has, optionally spawned first), `position {x,z}` or `area {x1,z1,x2,z2}` — and it resolves the subject, frames it FROM ITS OWN MODEL BOUNDS (a 4 m rifleman and a 65 m submarine both fill the frame; `angle` presets front/rear/side/top/three-quarter/low), holds the world still, captures a presented frame, and checks the pixels before handing them back. '
            + 'It exists because the two-call version does not work: each relay round trip costs seconds and the sim does not wait — a guided run on 2026-08-29 advanced 1,000+ sim frames between the camera call and the screenshot call and lost the engagement it was aiming at. Framing and capture therefore happen inside ONE relay evaluation. '
            + 'Ordering is handled for you, including the trap that a PAUSED SIM STREAMS NO FRESH SPAWNS OR REVEALS: spawn/reveal → let the stream settle → pause → capture → restore. Restores are conditional — a sim that was already paused stays paused, global LOS that was already on stays on. '
            + 'A black frame is a DIAGNOSIS, not a deliverable: mean luminance is checked, the camera re-frames up and out and retries, and a frame that is still black comes back `ok:false` with the candidate causes named (fog of war, night, subject never rendered). '
            + RELAY,
        inputSchema: {
            type: 'object',
            properties: {
                unitId:   { type: 'number', description: 'Frame this unit.' },
                unitIds:  { type: 'array', items: { type: 'number' }, description: 'Frame these units together (merged bounding sphere, static anchor).' },
                def:      { type: 'string', description: 'Frame the newest live instance of this unit def known to the browser. With `spawn`, spawn it first.' },
                position: { type: 'object', description: 'Frame a world point: {x, z, y?, radius?}. y defaults to the terrain height; radius defaults to 120 elmos.' },
                area:     { type: 'object', description: 'Frame a ground rectangle: {x1, z1, x2, z2}. Framed from its centroid + half-diagonal.' },

                spawn:    { type: 'object', description: 'Spawn `def` first, then frame it: {x, z, team?, count?}. Enables cheats if needed and turns them back off. Ordered spawn → stream settles → pause, because a paused sim never streams the new unit.' },

                angle:    { type: 'string', enum: ['three-quarter', 'front', 'rear', 'side', 'top', 'low'], description: 'Viewpoint preset (default three-quarter). WORLD-relative, named for a unit at heading 0, which faces −Z. `low` frames loose and near-horizon — the shot for judging a model against the terrain it stands on.' },
                yawDeg:   { type: 'number', description: 'Override the preset bearing (degrees around +Y from +X toward +Z).' },
                pitchDeg: { type: 'number', description: 'Override the preset elevation (clamped 5–85).' },
                fill:     { type: 'number', description: 'Fraction of the shorter viewport axis the subject should fill (0.25–0.95). Lower = more terrain context.' },

                pause:    { type: 'boolean', default: true, description: 'Freeze the sim across the capture so the subject is still there when the shutter falls. A sim that was already paused is left paused.' },
                simSpeed: { type: 'number', description: 'Slow (or speed) the sim across the capture, 0.05–100, restored afterwards. Asking for this DROPS the default pause — slow motion and a freeze are alternatives, not a pair — so it is how you photograph something that only exists while moving (a turret mid-slew, a tracer in flight). Pass pause:true as well to override. Applied AFTER the spawn/reveal settle, because the settle is measured in wall ms and 0.1× would shrink it to nothing.' },
                reveal:   { description: 'true / "auto" (default) reveals global LOS when it is off and restores it after; false never touches LOS (a fogged subject then comes back as a black-frame diagnosis).' },

                maxDim:   { type: 'number', description: 'Longest edge in pixels, 64–2048. Default 1280.' },
                quality:  { type: 'number', description: 'JPEG quality 0–1.' },
                retries:  { type: 'number', description: 'Extra framings to try when the frame comes back black. Default 2, max 5.' },
                luminanceFloor: { type: 'number', description: 'Mean luminance (0–255) at or below which the frame is called black. Default 8.' },
                streamSettleMs: { type: 'number', description: 'Dwell between a spawn/reveal and the pause, so the entity snapshot carrying it reaches the browser. Default 600.' },
                syncPresentation: { type: 'boolean', description: 'Force the presentation cursor onto the newest snapshot before the shutter. Defaults to true whenever this call paused the sim (a paused clock has no rate to close the gap with); rarely needed by hand.' },

                roomId:   { type: 'number', description: 'Room to target (default: the single active game).' },
                clientId: { type: 'number', description: 'Address a specific admin client id.' },
            },
        },
    },

    {
        name: 'step_sim',
        description: '**Advance the sim by an EXACT number of frames, from a stop.** The primitive that makes frame-by-frame filming possible: pause freezes the thing you are trying to watch, and speed 1 moves it an unknown distance across a multi-second relay round trip — stepping moves it by the number of frames you asked for and by nothing else, however long your camera call took. '
            + 'Pauses first if the sim was running (stepping from a moving sim is not a thing a caller can mean) and returns {from, to, landed}. It POLLS until the frame actually lands, so a successful reply means the sim really is at `to` — stepping is paced by the current speed factor, so 30 frames at 0.1× takes ~10 s of wall time. '
            + 'The step-capture-step-capture loop is what `capture_sequence` mode:"step" does for you; reach for this directly when you want to interleave something else (an order, a Lua probe, a damage event) between frames.',
        inputSchema: {
            type: 'object',
            properties: {
                frames: { type: 'number', description: `Sim frames to advance (1–${MAX_STEP_FRAMES}). Default 1. 30 frames = 1 game-second.`, default: 1 },
                roomId: { type: 'number' },
            },
        },
    },
    {
        name: 'capture_sequence',
        description: '**Film a manoeuvre → N images on disk, in one call.** The tool for anything that only exists WHILE MOVING: a tank\'s turn arc, a turret slew mid-motion, a walk clip mid-stride, a tracer in flight beside a hull. `capture_subject` gets you a pose; this gets you the motion. '
            + 'Same subject selectors as `capture_subject` (`unitId` / `unitIds` / `def` / `position` / `area`, with the same auto-framing from the subject\'s own model bounds, re-framed before EVERY shot so a moving subject stays in frame). '
            + 'TWO MODES, and the difference is what the frames are worth: '
            + '**step** (default) stops the sim and advances it by `everyNthSimFrame` between shots (`sim_step`), so the spacing is EXACT however long each capture took — this is the mode to use when the frames are evidence. '
            + '**realtime** slows the sim (`simSpeed`, default 0.1) and takes the whole burst browser-side inside ONE relay evaluation, so the spacing is wall-clock-nominal — use it when the thing you want to see is the client\'s own animation rather than sim state. '
            + 'Frames are WRITTEN TO DISK and the reply carries paths plus per-frame numbers; the relay\'s 4 MB cap is per message, so returning a dozen images inline is a reply nobody receives. `inlineFrames` inlines the first few for a glance. '
            + 'The failure it refuses to hide: N well-exposed, well-framed shots of the SAME sim frame — a still life wearing a film\'s clothes. That comes back `ok:false` with the causes named.'
            + RELAY,
        inputSchema: {
            type: 'object',
            properties: {
                unitId:   { type: 'number', description: 'Film this unit.' },
                unitIds:  { type: 'array', items: { type: 'number' }, description: 'Film these units together (merged bounds, static anchor — a subject that moves may leave frame).' },
                def:      { type: 'string', description: 'Film the newest live instance of this def known to the browser.' },
                position: { type: 'object', description: 'Film a world point: {x, z, y?, radius?}.' },
                area:     { type: 'object', description: 'Film a ground rectangle: {x1, z1, x2, z2}.' },
                spawn:    { type: 'object', description: 'Spawn `def` first, then film it: {x, z, team?, count?}.' },

                frames:           { type: 'number', description: 'Shots to take (2–60). Default 6.', default: 6 },
                everyNthSimFrame: { type: 'number', description: 'Sim frames between shots. Default 3 (=0.1 game-seconds). 30 = one second apart.', default: 3 },
                mode:             { type: 'string', enum: ['step', 'realtime'], description: 'step = exact spacing on a stepped sim (default). realtime = wall-clock burst on a slowed sim.', default: 'step' },
                simSpeed:         { type: 'number', description: 'Sim-speed multiplier to apply across the sequence (0.05–100). Defaults to 0.1 in realtime mode; in step mode it only matters if you also want the CLIENT\'s wall-clock animation to crawl. Restored afterwards.' },

                name:     { type: 'string', description: 'Label for the output directory. Sanitised. Default "sequence".' },
                outDir:   { type: 'string', description: 'Where to write the frames. Default <project>/data/captures/<name>/.' },
                inlineFrames: { type: 'number', description: 'How many frames to also return as inline MCP images (0–4). Default 1 — the first shot, so you can see it worked without opening a file.', default: 1 },

                angle:    { type: 'string', enum: ['three-quarter', 'front', 'rear', 'side', 'top', 'low'], description: 'Viewpoint preset (default three-quarter). WORLD-relative — see capture_subject.' },
                yawDeg:   { type: 'number' },
                pitchDeg: { type: 'number' },
                fill:     { type: 'number' },
                maxDim:   { type: 'number', description: 'Longest edge in pixels. Defaults DOWN with the frame count in realtime mode (the whole burst shares one 4 MB reply); step mode defaults to 1280.' },
                quality:  { type: 'number', description: 'JPEG quality 0–1.' },

                reveal:   { description: 'true / "auto" (default) reveals global LOS when off and restores it; false never touches LOS.' },
                trackSubject: { type: 'boolean', description: 'Re-frame on the subject before every shot (default true).', default: true },
                streamSettleMs: { type: 'number', description: 'Dwell after a spawn/reveal before the sequence starts. Default 600.' },
                settleMs: { type: 'number', description: 'realtime mode only: wall-ms dwell between shots that the burst budget check assumes (default 250).' },
                format:   { type: 'string', enum: ['jpeg', 'png'], description: 'Image format for the frames on disk (default jpeg).' },

                roomId:   { type: 'number' },
                clientId: { type: 'number' },
            },
        },
    },
    {
        name: 'order_and_film',
        description: '**Give an order, wait for the motion to actually START, then film it — one call.** The composite the unit-motion work needs: the gap between "order acknowledged" and "the unit is moving" is real (pathing, spin-up, the command queue), and it is exactly where hand-driven tooling loses the subject. Start the burst on the ack and you photograph a stationary hull; start it after a fixed sleep and the interesting part is over. '
            + 'So: issue the order, poll `unit_state` until the unit is genuinely moving, then hand off to `capture_sequence` with the same arguments. '
            + 'ONSET COUNTS ROTATION, NOT JUST TRANSLATION — a tank executing a 180° course change barely translates, and heading is the only channel that shows the turn. Thresholds are `speedThreshold` (elmos/game-second) and `turnThreshold` (degrees/game-second); either one trips it. '
            + 'A unit that never starts moving is filmed anyway, with `motion onset: … NEVER started moving` in the metadata — a still hull IS the finding when the order was supposed to move it.'
            + RELAY,
        inputSchema: {
            type: 'object',
            properties: {
                unitId: { type: 'number', description: 'The unit to order and film. Required.' },
                order:  { type: 'object', description: 'What to do: {cmdId, params:[…], opts?} — the same shape as give_order (10=MOVE, 20=ATTACK, 15=PATROL, 16=FIGHT). Or use the shorthands below.' },
                move:   { type: 'object', description: 'Shorthand for a MOVE order: {x, z, y?}. y defaults to the terrain height.' },
                attack: { type: 'number', description: 'Shorthand for an ATTACK order on this target unit id.' },

                frames:           { type: 'number', description: 'Shots to take. Default 8.', default: 8 },
                everyNthSimFrame: { type: 'number', description: 'Sim frames between shots. Default 6.', default: 6 },
                mode:             { type: 'string', enum: ['step', 'realtime'], default: 'step' },
                simSpeed:         { type: 'number' },

                speedThreshold: { type: 'number', description: 'Onset: elmos per game-second. Default 2.' },
                turnThreshold:  { type: 'number', description: 'Onset: degrees per game-second. Default 5.' },
                onsetTimeoutMs: { type: 'number', description: 'Give up waiting for motion after this long and film anyway. Default 8000.', default: 8000 },
                onsetPollFrames: { type: 'number', description: 'Sim frames between onset samples. Default 3.', default: 3 },

                name:     { type: 'string' },
                outDir:   { type: 'string' },
                inlineFrames: { type: 'number', default: 1 },
                angle:    { type: 'string', enum: ['three-quarter', 'front', 'rear', 'side', 'top', 'low'] },
                yawDeg:   { type: 'number' },
                pitchDeg: { type: 'number' },
                fill:     { type: 'number' },
                maxDim:   { type: 'number' },
                quality:  { type: 'number' },
                reveal:   { },
                settleMs: { type: 'number' },
                format:   { type: 'string', enum: ['jpeg', 'png'] },
                trackSubject: { type: 'boolean', default: true },
                streamSettleMs: { type: 'number' },
                spawn:    { type: 'object', description: 'Spawn `def` first: {x, z, team?, count?} (needs `def`).' },
                def:      { type: 'string' },
                roomId:   { type: 'number' },
                clientId: { type: 'number' },
            },
            required: ['unitId'],
        },
    },
    {
        name: 'drive_pattern',
        description: '**Drive a unit through a scripted waypoint loop and (optionally) film it — one call.** '
            + 'Closes a TOOLING GAP found while chasing the missing-tread-decals defect (docs/reviews/beta/README.md): '
            + 'there was no dedicated figure-8/waypoint-loop routine, so that fire hand-built one from 7-8 individual `give_order` MOVE calls. '
            + `Computes a waypoint loop (pattern: ${PATTERNS.join('|')}) around the unit's CURRENT position, issues it as queued MOVE orders `
            + '(cmdId 10, first waypoint opts 0, the rest opts 32 to queue — same `give_order` plumbing), waits until the unit has visited every '
            + 'waypoint IN ORDER (or `timeoutMs`), and reports the waypoints, how many were reached, sim frames elapsed, and final position. '
            + 'A closed loop ends where it began, so arrival is never declared until the unit has first moved more than `arriveRadius` from its '
            + 'start (`departed`) — a figure-8 that "arrives" in 11 frames was the first live call\'s defect. '
            + 'Give `unitId` for an existing unit, or `spawn:{defName,x,z,team?}` to create one first — spawning waits a short settle before the '
            + 'first order goes in, because a unit ordered immediately after `spawn_unit` can silently drop that first order (empty queue, never moves). '
            + 'With `capture:true`, shoots `capture_subject` top + low at the final position once the loop finishes (or times out).',
        inputSchema: {
            type: 'object',
            properties: {
                unitId: { type: 'number', description: 'Drive this existing unit. Required unless `spawn` is given.' },
                spawn:  { type: 'object', description: 'Spawn a unit first, then drive it: {defName, x, z, team?}. Ignored if `unitId` is given.' },

                pattern: { type: 'string', enum: PATTERNS, description: 'Waypoint loop shape.' },
                radius:  { type: 'number', description: 'Loop radius in elmos, for figure8/circle/zigzag. Default 300.' },
                length:  { type: 'number', description: 'End-to-end span in elmos, for line/zigzag. Default 300.' },
                laps:    { type: 'number', default: 1, description: 'Repeats of the loop (line/zigzag: round trips). Default 1.' },
                segmentsPerLap: { type: 'number', description: 'Waypoints per lap for figure8/circle/zigzag. Default 12, minimum 3.' },

                arriveRadius: { type: 'number', default: 64, description: 'Distance (elmos) within which a waypoint counts as visited; waypoints are credited in order. Default 64. Must be smaller than the pattern\'s radius (line/zigzag: half its length).' },
                passive:      { type: 'boolean', default: true, description: 'Put the unit on hold-fire + hold-position before driving it (default true). An idling unit that sees an enemy is given an internal attack order by the engine, which replaces the move queue mid-loop. false leaves its states alone.' },
                clearance:    { type: 'number', default: 48, description: 'No waypoint is left closer than this (elmos) to the unit\'s start: the engine drops a MOVE targeting within ~16-32 elmos of where the unit already is, so a figure-8\'s centre crossings would otherwise vanish from the queue. Default 48; 0 disables.' },
                timeoutMs:    { type: 'number', default: 180000, description: 'Give up waiting for arrival after this long (still returns the last known position). Default 180000 — a tank averages ~20 elmos/s through a loop\'s turns, and the default figure-8 is ~1900 elmos.' },
                pollMs:       { type: 'number', default: 500, description: 'Wait between arrival polls. Default 500.' },

                capture:  { type: 'boolean', default: false, description: 'Shoot capture_subject top + low at the final position once the loop ends.' },
                maxDim:   { type: 'number', description: 'Passed through to the capture (longest edge in pixels). Only used when capture:true.' },

                roomId:   { type: 'number' },
                clientId: { type: 'number', description: 'Admin client id to use for the optional capture. Only used when capture:true.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'populate_tranche',
        description: '**Spawn PLAN-perf.md §M19\'s XL-battle population in one batch.** '
            + 'Closes a TOOLING GAP (docs/reviews/beta/README.md / PLAN-perf.md "Not done"): no committed script reproduced the ~900-unit XL900 '
            + `population \`profile\`/\`browser_test perfDump\` need to measure p95 reproducibly. Rungs (cumulative): ${RUNGS.join(' → ')} — `
            + 'each rung is S plus every increment up to it, exactly as PLAN-perf.md §M19\'s tranche table records it (same map centre, same grid '
            + 'shape, `perRow` widening with the tranche). Runs the S-battle `grid()` Lua helper (bulk `Spring.CreateUnit` + `Spring.SetUnitArmored` '
            + 'in ONE `exec_lua` LuaRules call — confirmed crash-free at this scale across M6/M9/M19-M26) rather than one `spawn_unit` round trip '
            + 'per unit. Map is meridian_basin\'s contested-core ford, centre (8192, 8192); teams default to 0 (north) and 4 (south) per '
            + '`modOptions.war_sides = "compact:0,union:4"` — pass `teamNorth`/`teamSouth` if a room\'s side mapping differs. '
            + 'Spawned ids are kept server-side in `GG.perfTranche[team]`, not returned inline (900 ids is a lot of tokens for no benefit) — '
            + 'read them back with `exec_lua` if needed. Does NOT clear any existing population first unless `clearFirst:true`.',
        inputSchema: {
            type: 'object',
            properties: {
                rung: { type: 'string', enum: RUNGS, default: 'XL900', description: 'Cumulative population size to reach.' },

                teamNorth: { type: 'number', default: 0, description: 'North-bank team id.' },
                teamSouth: { type: 'number', default: 4, description: 'South-bank team id.' },
                center:    { type: 'object', description: 'Override the grid centre: {x, z}. Default the meridian_basin ford (8192, 8192).' },

                soldierDef: { type: 'string', description: 'Override the infantry def (default "ms_soldiers_s1"). Must be a bare token — no spaces or quotes.' },
                tankDef:    { type: 'string', description: 'Override the armour def (default "ms_tanks_s2"). Must be a bare token — no spaces or quotes.' },
                armored:    { type: 'boolean', default: true, description: 'Apply Spring.SetUnitArmored(u, true, 0.00003) so the population sustains rather than dying to stray fire.' },

                clearFirst:       { type: 'boolean', default: false, description: 'Clear teamNorth and teamSouth (`clear_units` per team) before spawning, for a clean population.' },
                suppressGameOver: { type: 'boolean', default: false, description: 'Patch Spring.GameOver to a no-op first — meridian_basin\'s ford is scenario objective 1 ("control"); capturing it ends the game and freezes the sim mid-measurement (PLAN-perf.md M10).' },

                roomId: { type: 'number' },
            },
            required: [],
        },
    },

    // --- Browser lifecycle ---------------------------------------------
    // The relay tools above need a CONNECTED admin client. These three make
    // one, without a human at a keyboard and without chrome-devtools MCP
    // (a second browser stack, launched for a CDP session we do not want).
    {
        name: 'open_client',
        description: 'Open a browser client and connect it to a room — the missing half of the relay tools, which all need a CONNECTED admin client and could not previously make one. Pass `roomId` to attach to a room this server launched (its browserUrl, including the host session token, is remembered from launch_scenario/launch_direct), or pass an explicit `url` for anything else. HEADLESS BY DEFAULT: verified to render this Babylon client identically (same mesh counts, working client_screenshot) while opening no window on the user\'s machine — pass headless:false to watch a run live. With `waitReady` (the default) it returns only once the relay actually answers, reporting {connected:true, clientId, readyState}; "the process started" is a much weaker claim than "a client is connected". The browser is tracked, so end_game closes it and list_clients can see it. Chrome is found automatically (override with SPRING_BROWSER).',
        inputSchema: {
            type: 'object',
            properties: {
                roomId:   { type: 'number', description: 'Attach to this room using the browserUrl remembered from its launch. Required unless `url` is given.' },
                url:      { type: 'string', description: 'Explicit URL. Overrides the remembered browserUrl; use for a room this server did not launch, or a non-game page.' },
                headless: { type: 'boolean', default: true, description: 'false opens a visible window (useful to watch a run, or to debug a client that will not connect).' },
                width:    { type: 'number', default: 1280 },
                height:   { type: 'number', default: 800 },
                waitReady:   { type: 'boolean', default: true, description: 'Wait until the relay reaches the new client before returning.' },
                waitReadyMs: { type: 'number', default: 60000, description: 'How long to wait for that first relay answer.' },
            },
        },
    },
    {
        name: 'close_client',
        description: 'Close a browser this server opened. `{pid}` closes one, `{roomId}` closes every client attached to that room, `{all:true}` closes all of them. SIGTERM to the process GROUP → poll → SIGKILL, because Chrome is a process tree and signalling the bare parent leaves GPU-holding renderers behind (an abandoned renderer has corrupted whole perf sessions here). Returns a per-browser report — read the `outcome`, not just the count: `exited` is clean, `killed_after_timeout` means SIGTERM was ignored, `kill_failed` needs a human. Refuses to signal a pid this server did not launch.',
        inputSchema: {
            type: 'object',
            properties: {
                pid:       { type: 'number', description: 'A pid returned by open_client.' },
                roomId:    { type: 'number', description: 'Close every client attached to this room.' },
                all:       { type: 'boolean', description: 'Close every tracked client.' },
                timeoutMs: { type: 'number', default: 5000, description: 'Grace before SIGKILL.' },
            },
        },
    },
    {
        name: 'list_clients',
        description: 'The browsers this server launched: {pid, roomId, url, headless, profileDir, startedAt, alive}. Liveness is re-probed on every call, never cached, so a browser that died or was killed by hand shows alive:false instead of a stale yes. Only ever lists this server\'s own browsers — a browser you opened yourself is invisible here (and is never signalled by close_client).',
        inputSchema: { type: 'object', properties: {} },
    },

    // --- Scenario authoring (S3) ---------------------------------------
    // The loop these four close: list what exists → validate offline until
    // clean → write (with the resync the lobby needs to SEE the file) →
    // launch with launch_scenario. Only validate_scenario works with the
    // stack down; the other three talk to the lobby.
    {
        name: 'list_scenarios',
        description: 'List the scenarios a game ships, merging the lobby\'s discovery view (id, displayName, '
            + 'map, tutorial/retired flags, terminal = has a victory objective, playable sides, briefing) with '
            + 'the admin provenance view for generated wars (seed, generator params/version, createdBy/At). '
            + 'Rows are tagged source: "authored" (a hand-written scenarios/*.lua) or "generated" (gen_*, owned '
            + 'by the scenario DB — regenerate rather than edit those). Needs a running lobby; degrades to the '
            + 'public view alone if the admin call is refused.',
        inputSchema: {
            type: 'object',
            properties: { gameId: { type: 'string', default: 'metalstorm' } },
        },
    },
    {
        name: 'validate_scenario',
        description: 'Offline structured validation of a scenario file — replicates BOTH parsers (the lobby\'s '
            + 'bare lua_State discovery pass AND game_scenario.lua\'s GameStart validate()) without booting '
            + 'anything, and without a running lobby. Returns findings[] of {severity, rule, path, message} with '
            + 'severity error|warning|info|skipped. A scenario with zero error findings will be offered by the '
            + 'lobby and will pass the in-game validator, modulo the live-only checks reported as "skipped". '
            + 'Note "skipped" means NOT CHECKED, never "fine". Rule ids and what each mirrors: docs/scenarios.md §11.',
        inputSchema: {
            type: 'object',
            properties: {
                gameId: { type: 'string', default: 'metalstorm' },
                scenarioId: { type: 'string', description: 'Reads data/games/<gameId>/scenarios/<scenarioId>.lua. Either this or luaSource.' },
                luaSource: { type: 'string', description: 'Validate source text directly — the pre-write check. Either this or scenarioId.' },
                passability: { type: 'boolean', default: false, description: 'Also run regions_from_map.py --verify on world.map (read-only; needs the processed map + python3; slow).' },
            },
        },
    },
    {
        name: 'write_scenario',
        description: 'Validate, then write data/games/<gameId>/scenarios/<scenarioId>.lua, then resync the lobby '
            + 'so the file is actually OFFERED (lobby scenario lists are a startup snapshot — a new file is '
            + 'invisible to the picker and to launch_scenario until a resync). Error findings always block the '
            + 'write; warnings block unless force:true. Refuses the gen_ prefix: those ids belong to the scenario '
            + 'DB and its orphan sweep DELETES any gen_*.lua no row claims. Reports offered:true|false by '
            + 're-reading the lobby list afterwards, because a file the lobby then silently declines to offer is '
            + 'exactly the failure this tool exists to catch.',
        inputSchema: {
            type: 'object',
            properties: {
                gameId: { type: 'string', default: 'metalstorm' },
                scenarioId: { type: 'string', description: 'Grammar: ^[a-z0-9_]+$, max 64 chars, must not start with gen_.' },
                luaSource: { type: 'string', description: 'The whole file. Must be a PURE Lua table literal returning a table — no VFS/Spring/GG/require at file scope.' },
                resync: { type: 'boolean', default: true },
                overwrite: { type: 'boolean', default: false, description: 'Required to replace an existing file.' },
                force: { type: 'boolean', default: false, description: 'Write despite warning findings. Error findings always block.' },
            },
            required: ['scenarioId', 'luaSource'],
        },
    },
    {
        name: 'generate_scenario',
        description: 'Generate a war for a map with scenariogen.py via the lobby admin route, store it in the '
            + 'scenario DB, materialise it to scenarios/gen_*.lua and re-discover it — returning the entry '
            + 'exactly as the Create Game picker now sees it. The seed defaults server-side to sum(ord(c) for c '
            + 'in mapId), so re-running with no seed is an idempotent upsert of the same war rather than a new '
            + 'one. On a map that cannot host a war the route answers 422 with the generator\'s own REJECTED '
            + 'line naming the violated invariant — surfaced verbatim. Needs a running lobby + admin auth.',
        inputSchema: {
            type: 'object',
            properties: {
                gameId: { type: 'string', default: 'metalstorm' },
                mapId: { type: 'string', description: 'Processed map id, e.g. "meridian_basin".' },
                seed: { type: 'integer', description: 'Defaults to sum of mapId char codes (reproducible).' },
                sides: { type: 'integer', description: '2-8' },
                towns: { type: 'integer', description: '0-32' },
                outposts: { type: 'integer', description: '0-32' },
                bases: { type: 'integer', description: '0-32' },
                mines: { type: 'integer', description: '0-32' },
                sites: { type: 'integer', description: '0-32' },
                relics: { type: 'integer', description: '0-32' },
                wrecks: { type: 'integer', description: '0-32' },
                bridges: { type: 'integer', description: '0-32' },
                works: { type: 'integer', description: '0-32' },
                harbour: { type: 'integer', description: '0-32' },
                shanty: { type: 'integer', description: '0-32' },
                hostility: { type: 'string', description: 'Generator enum (see scenariogen.py --hostility).' },
                roster: { type: 'string', description: 'Generator enum (see scenariogen.py --roster).' },
                coverage: {
                    type: 'boolean',
                    description: 'Full-coverage war: force the preset that can reach every def ms_defs knows, '
                        + 'then REFUSE unless the staged war really contains one of each. Explicit knobs still '
                        + 'win, so coverage+towns:5 means five towns.',
                },
                player: {
                    type: 'boolean',
                    description: 'Generate for a HUMAN: drop the mutual-ground-reachability gate, so islands, '
                        + 'rivers and straits produce a scenario instead of a refusal.',
                },
            },
            required: ['mapId'],
        },
    },
    ...WORLD_TOOLS,
    ...AI_TOOLS,
    ...NL_TOOLS,
];
