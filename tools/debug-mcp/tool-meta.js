// tool-meta.js — the editorial layer over the tool catalogue.
//
// tools.js says what each tool TAKES. This file says how the set is organised
// and what a reader needs to know before using any of it: the section a tool
// belongs to, the cross-cutting rules (deadlines, redaction, roomId
// semantics), and the one-line orientation per section. gen-docs.mjs joins the
// two into docs/mcp-tools.md.
//
// It is kept separate from tools.js so the schemas stay free of prose that is
// about the SET rather than about a tool, and separate from the generator so
// the generator has no editorial opinions of its own. `SECTIONS` is asserted
// to be a total partition of TOOLS by the test — a new tool cannot be added
// without deciding where it belongs.

export const SECTIONS = [
    {
        key: 'logs',
        title: 'Logs',
        blurb: 'The log server is the only source that survives a server\'s death. Scope every query — an unscoped search is "the whole log", and the limit is clamped to 1000 for that reason.',
        tools: ['get_logs', 'search_logs'],
    },
    {
        key: 'sim',
        title: 'Reading the sim',
        blurb: 'Read-only views of a running game. The `json ` verb prefix is a capability probe: a server predating it answers `unknown command: json <verb>` and these tools fall back to the legacy text.',
        tools: ['get_game_state', 'list_units', 'get_unit_state', 'get_frame', 'get_combat_summary', 'list_gadgets', 'profile'],
    },
    {
        key: 'exec',
        title: 'Executing code',
        blurb: 'Arbitrary-code channels into the sim. Both are compiled out under `SPRING_PROD`; a 404 from either means you are talking to a production binary.',
        tools: ['exec_lua', 'api_request'],
    },
    {
        key: 'testverbs',
        title: 'Driving the sim',
        blurb: 'The scripted test verbs. Every argument is validated by name before the verb string is built (`verb-args.js`) — an extra token would shift every positional field of the verb, which is a silent wrong-unit bug rather than an error.',
        tools: [
            'spawn_unit', 'kill_unit', 'damage_unit', 'give_order', 'clear_units', 'revive_team',
            'set_stockpile', 'set_debug_logging', 'pause_sim', 'set_sim_speed', 'step_sim',
            'set_los', 'set_cheats', 'set_unit_invulnerable',
        ],
    },
    {
        key: 'defs',
        title: 'Unit and weapon defs',
        blurb: 'Def lookups read the baked def cache, not the running game — they answer with no server up, and go stale when the content changes under them.',
        tools: ['get_unit_def', 'list_unit_defs', 'get_weapon_def', 'clear_defs_cache', 'get_lua_source'],
    },
    {
        key: 'processes',
        title: 'Processes, rooms and readiness',
        blurb: 'What is running, and whether it is ready. `probe_game` checks pid liveness BEFORE the heartbeat row, because nothing deletes that row when a server dies by SIGKILL.',
        tools: [
            'list_processes', 'list_stack', 'cleanup_stack', 'probe_game', 'wait_for_game',
            'query_db', 'list_sessions',
        ],
    },
    {
        key: 'lifecycle',
        title: 'Starting and stopping',
        blurb: 'Launch and teardown. `end_game` prefers the lobby\'s admin route because SIGTERM is what produces the exit checkpoint; `kill_game` is a deprecated alias for the ungraceful path.',
        tools: [
            'launch_scenario', 'launch_direct', 'launch_game', 'end_game', 'kill_game',
            'restart_lobby', 'restart_logserver', 'restart_game', 'restart_client',
        ],
    },
    {
        key: 'scenarios',
        title: 'Scenarios',
        blurb: 'Authoring and generating wars. `validate_scenario` runs BOTH parsers offline; a `skipped` finding means NOT CHECKED, never "fine".',
        tools: ['list_scenarios', 'validate_scenario', 'write_scenario', 'generate_scenario'],
    },
    {
        key: 'browser',
        title: 'The browser client',
        blurb: 'Everything here runs code in a CONNECTED browser over the P7 relay and is subject to its three gates (see below). The client is where rendering, LuaUI and the NL executor live — none of it is visible from the server.',
        tools: [
            'open_client', 'close_client', 'list_clients', 'client_eval', 'client_ready',
            'client_screenshot', 'browser_test', 'evaluate_widget_lua', 'spawn_at_camera',
        ],
    },
    {
        key: 'capture',
        title: 'Looking at things',
        blurb: 'Subject → image, and manoeuvre → film. These hold the world still, frame from the model\'s own bounds and CHECK THE PIXELS; the verdict on the first line of the metadata is the point of them.',
        tools: ['capture_subject', 'capture_sequence', 'order_and_film'],
    },
    {
        key: 'world',
        title: 'The world layer',
        blurb: 'The persistent metagame above individual battles (docs/world-layer.md). `world_status` reads, `world_commit` writes — between them they drive the whole loop without curl. Every tool takes an optional `world` selector and defaults to the lobby\'s primary world.',
        tools: [
            'world_status', 'world_pois', 'world_factions', 'world_claims',
            'world_commit', 'world_commit_cancel', 'world_seasons', 'world_pause', 'world_notifications',
        ],
    },
    {
        key: 'ai',
        title: 'AI players',
        blurb: 'Read and steer the AI brains. The reads run fixed, fengari-tested Lua programs (`lua-snippets.js`); the one write, `ai_guidance`, goes through the gadget\'s own RecvLuaMsg wire format so it exercises the same path the browser does — including the gadget\'s validation.',
        tools: ['ai_list', 'ai_health', 'ai_directives', 'ai_guidance', 'ai_context'],
    },
    {
        key: 'nl',
        title: 'Natural language',
        blurb: 'The NL command proxy parses an utterance into an intent envelope. Parsing is server-side; EXECUTION is client-side, so these tools answer "what did the parser make of that" and never move a unit.',
        tools: ['nl_command'],
    },
];

/**
 * Rules that apply across the whole surface. Each one is a thing that has
 * actually bitten, and each is enforced in code — the doc exists so a caller
 * knows the rule before it bites rather than after.
 */
export const CROSS_CUTTING = [
    {
        title: 'Every network call has a deadline',
        body: 'A lobby that accepts the connection and never answers used to hang a tool for ever. The MCP stamps a 15 s default on any fetch that does not bring its own '
            + '(`SPRING_MCP_HTTP_TIMEOUT_MS`); `/api/exec` gets 60 s (`SPRING_MCP_EXEC_TIMEOUT_MS`); the browser relay gets its `timeoutMs` + 5 s; `api_request` takes a `timeoutMs` '
            + '(default 30 s, clamped 0.5–300 s); and `world_notifications` sets its own from `listenMs`. A tool that hangs is a bug in this rule, not a slow server.',
    },
    {
        title: '`roomId` is a room id, not a port',
        body: 'An ENDED room\'s row keeps its port, and ports get reused: `roomId:7` on a dead room used to answer from whichever live server had since bound `:9100`. '
            + 'An explicit `roomId` is now refused when the row is ended, hibernated or its pid is gone — naming the room that squats the port — and a value that looks like '
            + 'a port is told so. Omitting `roomId` auto-picks the single live room and never a dead one.',
    },
    {
        title: 'Session tokens are redacted',
        body: '`launch_scenario` and `launch_direct` return a `sessions` map of live bearer tokens. The values are replaced unless you pass `revealTokens:true`. '
            + '`browserUrl` deliberately keeps its `#token=` fragment — that fragment IS the attach mechanism. `world_notifications` never returns its stream ticket at all.',
    },
    {
        title: 'The game server\'s HTTP loop is single-threaded',
        body: 'Code relayed into the browser must never call back into the game server that is waiting for its answer — the server is blocked on the relay response, so the '
            + 'callback cannot be served and both sides wait out the timeout. Fetch what you need first, then evaluate.',
    },
    {
        title: 'The three gates on every relayed tool',
        body: 'The relay route is compiled out under `SPRING_PROD`; only an admin-role session is addressed (a `/api/rooms/direct` dev account is role "player" and is NEVER '
            + 'eligible — `launch_scenario`\'s default player IS admin); and the browser refuses unless it is a DEV build or was booted with `?allowClientEval=1`. '
            + 'When a gate refuses, the tool prints the chrome-devtools snippet to paste by hand instead of erroring.',
    },
    {
        title: 'Arguments are enforced',
        body: 'A missing `required` field is refused by name, and an unknown property within a small edit distance of a real one is treated as a TYPO rather than an '
            + 'ignored extra — `set_los {enabled:true}` (the field is `enable`) used to read as "no arguments" and answer as if you had asked a question. '
            + '`npm run check` diffs every schema against what its handler actually reads, so neither list can drift from the other.',
    },
];
