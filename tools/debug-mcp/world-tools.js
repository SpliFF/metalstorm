// world-tools.js — the MCP's view of the persistent world layer.
//
// WHY THIS EXISTS. Driving the world loop (found a faction → file a claim →
// commit force at a POI → watch the staging window materialise into a war)
// was a curl exercise: eight routes, a token, a `?world=` selector and a set
// of error codes that only mean something next to docs/api.md §World layer.
// World-design asked for a `world_status` / `world_commit` pair so an agent
// can drive that loop without shelling out; these tools are that pair plus the
// rest of the surface it needs to be useful.
//
// DESIGN. Every tool here is THIN over one documented route — no caching, no
// derived state, no retries. What the module adds is exactly three things a
// raw curl does not give you:
//
//   1. the `?world=` selector threaded onto GET *and* POST (the dispatcher
//      stashes the query string for POSTs too — see docs/api.md),
//   2. an error mapper that turns the route's machine code into the sentence
//      that says what to do about it (`insufficient_authority` carries
//      have/need; `side_mismatch` carries both side keys; `window_closed`
//      means the staging window ended between read and write), and
//   3. a summary line, so a tool call answers "what is the world doing" in
//      one glance instead of 200 lines of POI JSON.
//
// The handlers take `(args, io)` and touch nothing but `io` — that is what
// makes every one of them testable against a fake fetch.

import { SseParser } from './sse.js';

// --- route plumbing --------------------------------------------------------

/** `/api/world/x` + the optional world selector. Never double-slashes. */
export function worldUrl(lobbyUrl, path, world) {
    const base = `${String(lobbyUrl).replace(/\/+$/, '')}${path}`;
    return world ? `${base}?world=${encodeURIComponent(String(world))}` : base;
}

// The documented error codes, and what a caller should DO about each. Keys are
// the `error` string the route answers with (docs/api.md §World layer); the
// 2026-09-16 build landed `window_closed`/`no_side`/`same_side`/
// `too_much_force` on staging/commit and moved claims/file's
// `insufficient_authority` to 403, so the three staging codes below are not
// speculative — they are in WorldStaging.cpp.
export const WORLD_ERROR_HELP = {
    world_database_unavailable: 'the lobby\'s world DB handle has faulted — this is never "no world yet"; check the lobby log',
    no_world: 'no world at all, or the `world` you named does not exist (try world_status with no `world`)',
    unauthorized: 'this route needs a token — the MCP\'s account failed to authenticate',
    not_in_a_faction: 'the acting account is in no faction; the route reads the faction from MEMBERSHIP, never from the body — join or found one first (world_factions)',
    insufficient_authority: 'not enough world authority — `have`/`need` are in the body; authority accrues over world time (world_status detail:"stats" settles it)',
    bad_name: 'faction name failed the length/charset rules in world_factions → rules',
    bad_archetype: 'unknown archetype — world_factions lists the catalogue',
    bad_seat: 'seatPoi is not a POI id this world knows (world_pois)',
    name_taken: 'another faction already holds that name',
    already_member: 'this account is already in a faction — leave first',
    seat_taken: 'another faction already seats at that POI',
    no_such_faction: 'no faction with that id (world_factions)',
    side_mismatch: 'the account already has a battle side that differs from the faction\'s; `accountSideKey`/`factionSideKey` are in the body',
    bad_request: 'the body was missing a required field',
    already_owner: 'your faction already owns that POI',
    already_claimed: 'an open claim on that POI exists already (world_claims)',
    no_poi: 'no POI with that id (world_pois)',
    no_faction: 'the acting account has no faction',
    no_claim: 'no claim with that id (world_claims)',
    not_your_claim: 'that claim belongs to another faction',
    not_your_commitment: 'that staging row belongs to another faction',
    no_staging: 'no staging row with that id — it may already have materialised into a war (world_pois → staging)',
    already_held: 'your faction already holds that POI, so there is nothing to take',
    no_transport: 'transports must be a positive integer',
    no_squads: 'squads must be a positive integer',
    no_battle_map: 'that POI has no mapId, so no war can be fought over it',
    window_closed: 'the staging window ended between reading it and committing — re-read world_pois and join the war instead',
    no_side: 'your faction has no sideKey, so it cannot field a force',
    same_side: 'the POI\'s holder is on your own side — you cannot stage against yourself',
    too_much_force: 'the committed force exceeds what this staging window accepts',
    bad_action: 'world_pause action must be "pause" or "resume"',
    bad_subscription: 'the push subscription failed validation',
    db_error: 'the world DB rejected the write — check the lobby log',
    no_such_season: 'no season with that number (world_seasons with no `number` lists them)',
};

/**
 * One world request. Public GETs go over plain `io.fetch`; token routes go
 * over `io.authedFetch`. Returns `{ok, status, body}` — it NEVER throws on an
 * HTTP error, because every world error code is information the caller wants.
 */
export async function worldRequest(io, { path, method = 'GET', body, world, token = false }) {
    const url = worldUrl(io.lobbyUrl, path, world);
    const init = { method };
    if (body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
    }
    // No explicit signal: server.js's module-level fetch stamps the default
    // deadline on anything that does not bring one, and these are all short
    // lobby calls. The one long-lived call in this file (the SSE listen) sets
    // its own.
    const resp = token
        ? await io.authedFetch((t) => io.fetch(url, {
            ...init,
            headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` },
        }))
        : await io.fetch(url, init);
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    return { ok: resp.ok, status: resp.status, body: parsed, url };
}

/** Turn a failed worldRequest into the error string a tool returns. */
export function explainWorldError(route, { status, body }) {
    const code = body && typeof body === 'object' ? body.error : undefined;
    const help = code && WORLD_ERROR_HELP[code];
    const extras = [];
    if (body && typeof body === 'object') {
        for (const k of ['have', 'need', 'accountSideKey', 'factionSideKey', 'detail'])
            if (body[k] !== undefined && body[k] !== null) extras.push(`${k}=${JSON.stringify(body[k])}`);
    }
    return `Error: ${route} ${status}`
        + (code ? ` ${code}` : '')
        + (extras.length ? ` (${extras.join(', ')})` : '')
        + (help ? ` — ${help}` : '')
        + (!code ? ` — ${JSON.stringify(body)}` : '');
}

/** Run a request and either explain the failure or hand the body to `shape`. */
async function call(io, route, req, shape) {
    const r = await worldRequest(io, req);
    if (!r.ok) return explainWorldError(route, r);
    return shape ? shape(r.body) : r.body;
}

// --- summaries -------------------------------------------------------------
//
// One line that answers "what is the world doing" before the JSON. Pure, and
// tested directly, because every one of these reads a field whose absence is
// normal on a young world (`season` is null before the first tick; `pois` is
// an empty array) and a summariser that throws on a young world is worse than
// no summariser.

export function summariseClock(world) {
    const c = (world && world.clock) || {};
    const season = world && world.season;
    return [
        `world ${world?.worldId ?? '?'} (${world?.name ?? '?'}) state=${world?.state ?? '?'}`,
        c.label ? `clock ${c.label}` : null,
        c.paused ? 'PAUSED' : 'running',
        season ? `season ${season.number} (${Math.round((season.remainingWorldMs || 0) / 3600000)}h of world time left)` : 'no season yet',
        `${world?.poiCount ?? 0} POIs`,
    ].filter(Boolean).join(' · ');
}

export function summarisePois(pois) {
    const rows = (pois && pois.pois) || [];
    const byStatus = { quiet: 0, staging: 0, active: 0 };
    let owned = 0, staging = 0;
    for (const p of rows) {
        if (byStatus[p.battleStatus] !== undefined) byStatus[p.battleStatus]++;
        if (p.owner) owned++;
        staging += (p.staging || []).length;
    }
    return `${rows.length} POIs · ${owned} owned · ${byStatus.staging} staging / ${byStatus.active} at war `
        + `· ${staging} open commitments · ${((pois && pois.edges) || []).length} edges`;
}

// --- tool schemas ----------------------------------------------------------

const worldArg = {
    world: {
        type: 'string',
        description: 'World id (`?world=`). Omit for the lobby\'s primary world (the oldest active one) — that is what you want unless this lobby hosts several.',
    },
};

export const WORLD_TOOLS = [
    {
        name: 'world_status',
        description: 'The world clock, season and config — plus, on request, the POI graph, the authority/economy stats or the faction roster. This is the read half of the world loop (world_commit is the write half): start here to see whether the clock is running, which season it is, and what is staging. `detail` picks how much comes back: "clock" (default, GET /api/world), "pois", "stats" (NOTE: settles commander authority accrual on the way past — idempotent, but it is a write), "factions", or "all".',
        inputSchema: {
            type: 'object',
            properties: {
                detail: {
                    type: 'string',
                    description: 'How much to return',
                    enum: ['clock', 'pois', 'stats', 'factions', 'all'],
                    default: 'clock',
                },
                ...worldArg,
            },
        },
    },
    {
        name: 'world_pois',
        description: 'The POI graph: nodes (with owner, battleStatus, open staging windows and the war room id) and edges. Filter with `poi` (one node, with its edges), `kind` or `battleStatus`. A young world answers with empty arrays — that is a 200, not an error.',
        inputSchema: {
            type: 'object',
            properties: {
                poi: { type: 'string', description: 'Return just this POI id (and the edges touching it)' },
                kind: { type: 'string', description: 'Filter by POI kind' },
                battleStatus: { type: 'string', description: 'Filter by battle status', enum: ['quiet', 'staging', 'active'] },
                ...worldArg,
            },
        },
    },
    {
        name: 'world_factions',
        description: 'Read the faction roster and archetype catalogue, or act on membership. `action`: "list" (default, public), "me" (POST /api/world/me — this account\'s authority, membership and founding gate; GRANTS the starter commander the first time it clears the threshold), "found" (needs `name` + `archetype`), "join" (needs `factionId`), "leave". Joining adopts the faction\'s battle side when the account has none; if both are set and differ it is refused with side_mismatch rather than silently reseating you.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', description: 'What to do', enum: ['list', 'me', 'found', 'join', 'leave'], default: 'list' },
                name: { type: 'string', description: 'found: the faction name' },
                archetype: { type: 'string', description: 'found: archetype key (action:"list" prints the catalogue)' },
                governance: { type: 'string', description: 'found: governance key (optional)' },
                colour: { type: 'string', description: 'found: colour (optional)' },
                seatPoi: { type: 'string', description: 'found: the POI to seat at (optional)' },
                factionId: { type: 'number', description: 'join: which faction' },
                ...worldArg,
            },
        },
    },
    {
        name: 'world_claims',
        description: 'Conquest claims. `action`: "list" (default, public — every claim newest-first plus the rates), "file" (needs `poi`; charges claimPoiCost from YOUR world authority, 403 insufficient_authority with have/need when short), "withdraw" (needs `claimId`; any member of the claiming faction may withdraw, and an already-resolved claim answers withdrawn:false rather than erroring). POI ownership only ever changes through a filed, paid claim that wins — taking the map is not enough.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', description: 'What to do', enum: ['list', 'file', 'withdraw'], default: 'list' },
                poi: { type: 'string', description: 'file: the POI to claim' },
                claimId: { type: 'number', description: 'withdraw: which claim' },
                state: { type: 'string', description: 'list: filter by claim state', enum: ['open', 'won', 'lost', 'expired', 'withdrawn'] },
                ...worldArg,
            },
        },
    },
    {
        name: 'world_commit',
        description: 'Commit force at a POI — the write half of the world loop. Opens a staging window, or joins one already open; the war room is created when the window ENDS, not now. The committed force leaves your faction\'s pool into a WorldEscrow row immediately (world_commit_cancel refunds it before contact; a war that ends with no verdict settles the escrow as `voided`). Your faction comes from your membership, never from the body. Common refusals: already_held (you hold it), same_side / no_side (side keys), no_battle_map (the POI has no map to fight on), window_closed (the window ended between your read and this write — re-read world_pois).',
        inputSchema: {
            type: 'object',
            properties: {
                poi: { type: 'string', description: 'The POI to commit force at' },
                transports: { type: 'number', description: 'Transports committed', default: 1 },
                squads: { type: 'number', description: 'Squads committed', default: 1 },
                origin: { type: 'string', description: 'Origin POI the force moves from (optional)' },
                ...worldArg,
            },
            required: ['poi'],
        },
    },
    {
        name: 'world_commit_cancel',
        description: 'Withdraw a staging commitment before contact and refund its escrow (POST /api/world/staging/cancel). Answers cancelled:false — not an error — when the window had already closed, because by then the force is in a war. 403 not_your_commitment when the row belongs to another faction.',
        inputSchema: {
            type: 'object',
            properties: {
                stagingId: { type: 'number', description: 'The stagingId from world_pois → pois[].staging[] or world_commit\'s answer' },
                ...worldArg,
            },
            required: ['stagingId'],
        },
    },
    {
        name: 'world_seasons',
        description: 'Season archive. With no `number`, the index (newest first; the active season has endedWorldMs 0). With `number`, that season plus its archived digest rows (settlements won, POI income, decay, treasury at rollover; factionId null is the unclaimed bucket). An ACTIVE season answers 200 with empty digests — digests are written at rollover. `number` is digits only; there is no /latest.',
        inputSchema: {
            type: 'object',
            properties: {
                number: { type: 'number', description: 'Season number — omit for the index' },
                ...worldArg,
            },
        },
    },
    {
        name: 'world_pause',
        description: 'Pause or resume the global world clock (admin). Freezes world-clock progression ONLY — running battles keep going, so this is not a way to freeze a war (use set_speed / sim controls for that). Already-paused is a no-op answering changed:false.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', description: 'pause or resume', enum: ['pause', 'resume'], default: 'pause' },
                reason: { type: 'string', description: 'Recorded with the pause' },
                ...worldArg,
            },
        },
    },
    {
        name: 'world_notifications',
        description: 'Listen for world events for a bounded window and return what arrived. There is no REST route for these: the lobby pushes them down the identified chat SSE stream, so this trades the token for a stream ticket (POST /api/chat/ticket) and reads GET /api/chat/stream for `listenMs`. Events: world-staging (opened/materialised/cancelled/failed — a LATE commit joining an open window fires nothing, so silence does not mean your commit failed), world-poi (ownership changed) and world-season. Addressed to the attacking and defending factions\' members and to accounts with a commander at the POI — you will see nothing about a war you have no stake in. The ticket is a credential and is never echoed back.',
        inputSchema: {
            type: 'object',
            properties: {
                listenMs: { type: 'number', description: 'How long to listen, 100–120000 ms', default: 10000 },
                kinds: {
                    type: 'array',
                    description: 'SSE event names to keep (default the three world events)',
                    items: { type: 'string' },
                },
                includeOther: { type: 'boolean', description: 'Also return non-world events (chat) seen on the stream', default: false },
                ...worldArg,
            },
        },
    },
];

// --- handlers --------------------------------------------------------------

const LISTEN_MIN_MS = 100;
const LISTEN_MAX_MS = 120000;
export const WORLD_EVENT_KINDS = ['world-staging', 'world-poi', 'world-season'];

/** A positive integer, or null. Counts are unbounded server-side but a NaN
 *  forwarded as `null` would read as "use the default" — refuse it here. */
function posInt(value, fallback) {
    if (value === undefined || value === null) return fallback;
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : null;
}

export const worldHandlers = {
    async world_status(args, io) {
        const want = args.detail || 'clock';
        const all = want === 'all';
        const out = {};
        if (all || want === 'clock') {
            const r = await worldRequest(io, { path: '/api/world', world: args.world });
            if (!r.ok) return explainWorldError('GET /api/world', r);
            out.summary = summariseClock(r.body);
            out.world = r.body;
        }
        if (all || want === 'pois') {
            const r = await worldRequest(io, { path: '/api/world/pois', world: args.world });
            if (!r.ok) return explainWorldError('GET /api/world/pois', r);
            out.poiSummary = summarisePois(r.body);
            out.pois = r.body;
        }
        if (all || want === 'stats') {
            const r = await worldRequest(io, { path: '/api/world/stats', world: args.world });
            if (!r.ok) return explainWorldError('GET /api/world/stats', r);
            out.stats = r.body;
        }
        if (all || want === 'factions') {
            const r = await worldRequest(io, { path: '/api/world/factions', world: args.world });
            if (!r.ok) return explainWorldError('GET /api/world/factions', r);
            out.factions = r.body;
        }
        return out;
    },

    async world_pois(args, io) {
        const r = await worldRequest(io, { path: '/api/world/pois', world: args.world });
        if (!r.ok) return explainWorldError('GET /api/world/pois', r);
        const body = r.body || {};
        let pois = Array.isArray(body.pois) ? body.pois : [];
        let edges = Array.isArray(body.edges) ? body.edges : [];
        if (args.kind) pois = pois.filter((p) => p.kind === args.kind);
        if (args.battleStatus) pois = pois.filter((p) => p.battleStatus === args.battleStatus);
        if (args.poi) {
            pois = pois.filter((p) => String(p.id) === String(args.poi));
            edges = edges.filter((e) => String(e.from) === String(args.poi) || String(e.to) === String(args.poi));
            if (!pois.length)
                return `Error: no POI "${args.poi}" in world ${body.worldId ?? '?'} — call world_pois with no filter to list them.`;
        }
        return {
            summary: summarisePois({ pois, edges }),
            worldId: body.worldId,
            pois,
            edges,
            factions: body.factions,
        };
    },

    async world_factions(args, io) {
        const action = args.action || 'list';
        switch (action) {
            case 'list':
                return call(io, 'GET /api/world/factions', { path: '/api/world/factions', world: args.world });
            case 'me':
                return call(io, 'POST /api/world/me', { path: '/api/world/me', method: 'POST', body: {}, world: args.world, token: true });
            case 'found': {
                if (!args.name || !args.archetype)
                    return 'Error: world_factions action:"found" needs `name` and `archetype` (action:"list" prints the archetype catalogue and the naming rules).';
                const body = { name: args.name, archetype: args.archetype };
                for (const k of ['governance', 'colour', 'seatPoi']) if (args[k] !== undefined) body[k] = args[k];
                return call(io, 'POST /api/world/factions/found', { path: '/api/world/factions/found', method: 'POST', body, world: args.world, token: true });
            }
            case 'join': {
                if (!Number.isFinite(Number(args.factionId)))
                    return 'Error: world_factions action:"join" needs a numeric `factionId` (action:"list" prints them).';
                return call(io, 'POST /api/world/factions/join', { path: '/api/world/factions/join', method: 'POST', body: { factionId: Number(args.factionId) }, world: args.world, token: true });
            }
            case 'leave':
                return call(io, 'POST /api/world/factions/leave', { path: '/api/world/factions/leave', method: 'POST', body: {}, world: args.world, token: true });
            default:
                return `Error: world_factions action must be one of list, me, found, join, leave (got ${JSON.stringify(action)}).`;
        }
    },

    async world_claims(args, io) {
        const action = args.action || 'list';
        if (action === 'list') {
            const r = await worldRequest(io, { path: '/api/world/claims', world: args.world });
            if (!r.ok) return explainWorldError('GET /api/world/claims', r);
            const body = r.body || {};
            const claims = args.state
                ? (body.claims || []).filter((c) => c.state === args.state)
                : (body.claims || []);
            return { ...body, claims, summary: `${claims.length} claim(s)${args.state ? ` in state ${args.state}` : ''}` };
        }
        if (action === 'file') {
            if (!args.poi) return 'Error: world_claims action:"file" needs `poi`.';
            return call(io, 'POST /api/world/claims/file', { path: '/api/world/claims/file', method: 'POST', body: { poi: args.poi }, world: args.world, token: true });
        }
        if (action === 'withdraw') {
            if (!Number.isFinite(Number(args.claimId)))
                return 'Error: world_claims action:"withdraw" needs a numeric `claimId` (action:"list" prints them).';
            return call(io, 'POST /api/world/claims/withdraw', { path: '/api/world/claims/withdraw', method: 'POST', body: { claimId: Number(args.claimId) }, world: args.world, token: true });
        }
        return `Error: world_claims action must be one of list, file, withdraw (got ${JSON.stringify(action)}).`;
    },

    async world_commit(args, io) {
        if (!args.poi) return 'Error: world_commit needs `poi`.';
        const transports = posInt(args.transports, 1);
        const squads = posInt(args.squads, 1);
        if (transports === null) return 'Error: world_commit `transports` must be a positive integer.';
        if (squads === null) return 'Error: world_commit `squads` must be a positive integer.';
        const body = { poi: args.poi, transports, squads };
        if (args.origin) body.origin = args.origin;
        const r = await worldRequest(io, { path: '/api/world/staging/commit', method: 'POST', body, world: args.world, token: true });
        if (!r.ok) return explainWorldError('POST /api/world/staging/commit', r);
        const staging = (r.body && r.body.staging) || {};
        return {
            summary: `${r.body?.joined ? 'joined an open' : 'opened a'} staging window at ${args.poi} `
                + `with ${transports} transport(s) / ${squads} squad(s)`
                + (staging.remainingWorldMs !== undefined ? ` — ${staging.remainingWorldMs}ms of world time until it materialises` : '')
                + `. Escrow is held; world_commit_cancel({stagingId:${staging.stagingId ?? '?'}}) refunds it before contact.`,
            ...r.body,
        };
    },

    async world_commit_cancel(args, io) {
        if (!Number.isFinite(Number(args.stagingId)))
            return 'Error: world_commit_cancel needs a numeric `stagingId` (world_pois → pois[].staging[]).';
        const r = await worldRequest(io, {
            path: '/api/world/staging/cancel', method: 'POST',
            body: { stagingId: Number(args.stagingId) }, world: args.world, token: true,
        });
        if (!r.ok) return explainWorldError('POST /api/world/staging/cancel', r);
        return {
            summary: r.body?.cancelled
                ? `staging ${args.stagingId} cancelled — escrow refunded`
                : `staging ${args.stagingId} was NOT cancelled: the window had already closed, so the force is committed to the war`,
            ...r.body,
        };
    },

    async world_seasons(args, io) {
        if (args.number === undefined || args.number === null)
            return call(io, 'GET /api/world/seasons', { path: '/api/world/seasons', world: args.world });
        const n = Number(args.number);
        // `{n}` is digits only server-side; a float or a negative would 404
        // with no_such_season, which reads as "that season was archived away".
        if (!Number.isInteger(n) || n < 0)
            return 'Error: world_seasons `number` must be a non-negative integer (the route matches digits only; there is no /latest).';
        return call(io, `GET /api/world/seasons/${n}`, { path: `/api/world/seasons/${n}`, world: args.world });
    },

    async world_pause(args, io) {
        const action = args.action || 'pause';
        if (action !== 'pause' && action !== 'resume')
            return `Error: world_pause action must be "pause" or "resume" (got ${JSON.stringify(action)}).`;
        const body = { action };
        if (args.reason) body.reason = args.reason;
        const r = await worldRequest(io, { path: '/api/world/pause', method: 'POST', body, world: args.world, token: true });
        if (!r.ok) return explainWorldError('POST /api/world/pause', r);
        return {
            summary: r.body?.changed
                ? `world clock ${action}d${args.reason ? ` (${args.reason})` : ''} — running battles are UNAFFECTED`
                : `world clock was already ${action === 'pause' ? 'paused' : 'running'} — no change`,
            ...r.body,
        };
    },

    async world_notifications(args, io) {
        const raw = Number(args.listenMs ?? 10000);
        if (!Number.isFinite(raw)) return 'Error: world_notifications `listenMs` must be a number.';
        const listenMs = Math.min(LISTEN_MAX_MS, Math.max(LISTEN_MIN_MS, Math.round(raw)));
        const kinds = Array.isArray(args.kinds) && args.kinds.length ? args.kinds.map(String) : WORLD_EVENT_KINDS;

        // EventSource cannot carry an Authorization header, so the stream is
        // reached through a short-lived ticket. The ticket IS a credential:
        // it goes into the URL and never into the answer.
        const ticketResp = await io.authedFetch((t) => io.fetch(`${String(io.lobbyUrl).replace(/\/+$/, '')}/api/chat/ticket`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
            body: '{}',
        }));
        const ticketText = await ticketResp.text();
        if (!ticketResp.ok)
            return `Error: POST /api/chat/ticket ${ticketResp.status} — no stream ticket, so there is nothing to listen on. ${ticketText.slice(0, 200)}`;
        let ticket;
        try { ticket = JSON.parse(ticketText).ticket; } catch { ticket = null; }
        if (!ticket) return 'Error: POST /api/chat/ticket answered without a ticket.';

        const url = worldUrl(io.lobbyUrl, '/api/chat/stream', args.world)
            + `${args.world ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`;
        // The one long call in this module, so it brings its own deadline:
        // listenMs plus slack for the response headers. Without it the
        // module-level 15 s default would cut a 60 s listen short.
        const resp = await io.fetch(url, {
            headers: { Accept: 'text/event-stream' },
            signal: AbortSignal.timeout(listenMs + 5000),
        });
        if (!resp.ok) return `Error: GET /api/chat/stream ${resp.status} — ticket rejected or the stream is not served.`;

        const parser = new SseParser();
        const events = [];
        const other = [];
        const stop = Date.now() + listenMs;
        try {
            for await (const chunk of resp.body) {
                for (const ev of parser.push(Buffer.from(chunk).toString('utf8'))) {
                    let data;
                    try { data = JSON.parse(ev.data); } catch { data = ev.data; }
                    if (kinds.includes(ev.event)) events.push({ event: ev.event, data });
                    else if (args.includeOther) other.push({ event: ev.event, data });
                }
                if (Date.now() >= stop) break;
            }
        } catch (e) {
            // A timeout here is the EXPECTED end of a quiet listen, not a
            // failure: the stream never closes on its own.
            if (e.name !== 'TimeoutError' && e.name !== 'AbortError')
                return `Error: world notification stream failed: ${e.message}`;
        }
        return {
            summary: events.length
                ? `${events.length} world event(s) in ${listenMs}ms: ${events.map((e) => e.event).join(', ')}`
                : `no world events in ${listenMs}ms (a late commit joining an OPEN window fires nothing, and you only receive events for wars you have a stake in)`,
            listenMs,
            kinds,
            events,
            ...(args.includeOther ? { other } : {}),
        };
    },
};
