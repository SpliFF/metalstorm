#!/usr/bin/env node
/**
 * Spring RTS Debug MCP Server
 *
 * Provides Claude with tools to query logs, execute Lua/commands,
 * inspect game state, and manage processes — all via HTTP REST API.
 *
 * Game server ports are discovered from the SQLite database (game_servers table)
 * rather than a hardcoded URL, since the lobby assigns ports dynamically and
 * games persist across lobby restarts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Database from 'better-sqlite3';
import { buildScenarioManifest } from './scenario-manifest.js';
import { runScenarioValidation, scenarioPath } from './scenario-validate.js';
import { buildDirectManifest, listManifestNames, loadManifestByName } from './direct-manifest.js';
import { classifyEndResponse } from './room-end.js';
import {
    STACK_PATTERNS, STACK_PORTS, STATUS_STALE_SEC,
    parsePsOutput, parseLsofF, resolveMprocsAddr, classifyBinaries, classifyStack,
    planCleanup, summarize, isStackPort, CLEANABLE_KINDS,
} from './stack-census.js';
import { resolve, join, dirname } from 'path';
import {
    readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync,
    rmdirSync, statSync,
} from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const LOG_SERVER_URL = process.env.LOG_SERVER_URL || 'http://localhost:8010';
const LOBBY_URL = process.env.LOBBY_URL || 'http://localhost:8011';
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:8012';

// ZK's "Startup Info and Selector" widget pops a commander-chooser overlay
// at game start. It blocks the view and needs a click to dismiss, which is
// noise for automated/debug launches. The client honours a
// `?disableWidgets=<name,name>` URL param (see lua-widget-manager.ts) to
// switch named widgets off once the worker is ready. launch_game suggests a
// browser URL with this widget disabled unless `testStartupSelector` is set.
const STARTUP_SELECTOR_WIDGET = 'Startup Info and Selector';
const DB_PATH = process.env.SPRING_DB || resolve(process.env.PROJECT_ROOT || '.', 'data/spring-server.db');

/** Repo root for the tools with direct fs access (defs cache, scenarios). */
const projectRoot = () => process.env.PROJECT_ROOT || resolve('.');
const AUTH_USER = process.env.SPRING_USER || 'admin';
const AUTH_PASS = process.env.SPRING_PASS || 'admin';

// --- Auth token cache ---
let authToken = process.env.SPRING_TOKEN || '';

// --- Registration ---
//
// POST /api/auth/register requires a `faction` key (PLAN-metalstorm-lobby
// task 0) and validates it against a registry the lobby builds from
// *Metalstorm's* gamedata/sidedata.lua only — deliberately not a union across
// every game the lobby serves (rts/lobby_main.cpp, `factionRegistry`). So the
// valid keys are exactly what GET /api/factions/metalstorm returns, and asking
// the server beats hardcoding a key that a sidedata.lua edit can invalidate.
//
// This matters more than it looks: every register call here is a *fallback*
// that only fires when login failed, so on the shared dev DB — where the usual
// accounts already exist — it never runs. It runs on a fresh DB or a
// never-before-seen username, which is exactly what the spring-test and
// game-browser-test skills do.
let cachedFactionKey; // undefined = not looked up yet; '' = server wants none
async function resolveFaction() {
    if (cachedFactionKey !== undefined) return cachedFactionKey;
    if (process.env.SPRING_FACTION) {
        cachedFactionKey = process.env.SPRING_FACTION;
        return cachedFactionKey;
    }
    try {
        const r = await fetch(`${LOBBY_URL}/api/factions/metalstorm`);
        if (r.ok) {
            const list = await r.json();
            // A lobby that doesn't serve Metalstorm has an empty registration
            // registry, in which case there is no faction it would accept and
            // sending one would 400 "unknown faction". Send nothing.
            cachedFactionKey = (Array.isArray(list) && list[0]?.key) || '';
        } else {
            cachedFactionKey = '';
        }
    } catch {
        cachedFactionKey = '';
    }
    return cachedFactionKey;
}

// Register an account. Returns { ok, token, error } — `error` carries the
// server's own message ("faction is required", "username already taken", ...)
// so callers can report why instead of an opaque "auth failed".
async function registerAccount(username, password) {
    const faction = await resolveFaction();
    const body = { username, password };
    if (faction) body.faction = faction;
    try {
        const resp = await fetch(`${LOBBY_URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await resp.text();
        if (resp.ok) {
            let token = '';
            try { token = JSON.parse(text).token || ''; } catch { /* not JSON */ }
            if (token) return { ok: true, token, error: '' };
            return { ok: false, token: '', error: `register ${resp.status} returned no token: ${text}` };
        }
        return { ok: false, token: '', error: `register ${resp.status}: ${text}` };
    } catch (e) {
        return { ok: false, token: '', error: `register request failed: ${e.message}` };
    }
}

// `force` clears any cached token first. Game/lobby session rows live in
// data/spring-server.db and are wiped on a DB reset/migration or expire after
// 24h; a long-lived MCP process otherwise keeps serving a dead token and every
// authed call 401s until the MCP restarts. Callers retry once with force=true
// on a 401 (see authedFetch) so the MCP self-heals.
async function ensureAuth(force = false) {
    if (force) authToken = '';
    if (authToken) return authToken;
    try {
        const resp = await fetch(`${LOBBY_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
        });
        if (resp.ok) {
            const data = await resp.json();
            if (data.token) { authToken = data.token; return authToken; }
        }
    } catch { /* fall through */ }
    // Try register if login failed
    const reg = await registerAccount(AUTH_USER, AUTH_PASS);
    if (reg.ok) { authToken = reg.token; return authToken; }
    // Callers of ensureAuth() only get a token or '' — surface the reason on
    // stderr so a failed bootstrap isn't silent.
    console.error(`[spring-debug] auth failed for "${AUTH_USER}": ${reg.error}`);
    return '';
}

// Fetch with a Bearer token, transparently re-authing once on a 401. `makeReq`
// receives the current token and returns the fetch Promise. This is the single
// choke point that makes every authed MCP call (exec, api_request, restart)
// recover from a stale cached token without a manual MCP restart.
async function authedFetch(makeReq) {
    let token = await ensureAuth();
    if (!token) throw new Error('Not authenticated — set SPRING_TOKEN or SPRING_USER/SPRING_PASS');
    let resp = await makeReq(token);
    if (resp.status === 401) {
        token = await ensureAuth(true);   // force a fresh login, drop the dead token
        if (token) resp = await makeReq(token);
    }
    return resp;
}

// --- Game server discovery ---
//
// The lobby keeps the live process list in memory and exposes it at
// /api/processes; the game_servers SQLite table only holds entries when
// a lobby restart has staged hand-off info. Query the lobby first and
// fall back to SQLite for offline/post-mortem use.
async function getGameServers() {
    try {
        const resp = await fetch(`${LOBBY_URL}/api/processes`);
        if (resp.ok) {
            const rows = await resp.json();
            // Normalise to the SQLite shape so callers don't care.
            return rows.map(r => ({
                room_id: r.room_id, port: r.port, pid: r.pid,
                map_id: r.map, game_id: r.game, state: r.state,
            }));
        }
    } catch { /* fall through */ }
    try {
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        const rows = db.prepare('SELECT room_id, port, pid, map_id, game_id, state FROM game_servers').all();
        db.close();
        return rows;
    } catch {
        return [];
    }
}

async function getGameServerUrl(roomId) {
    const servers = await getGameServers();
    let server;
    if (roomId !== undefined && roomId > 0) {
        server = servers.find(s => s.room_id === roomId);
    } else {
        // Prefer running, fall back to starting, fall back to anything not ended.
        server = servers.find(s => s.state === 'running')
            || servers.find(s => s.state === 'starting')
            || servers.find(s => s.state !== 'ended');
    }
    if (!server) return null;
    return { url: `http://127.0.0.1:${server.port}`, ...server };
}

// --- Readiness probing ---
//
// probeGame() composes four independent signals into one honest phase. The
// ORDER IS LOAD-BEARING: pid liveness is checked *before* the game_status row,
// because nothing deletes that row when a server dies by SIGKILL
// (GameServersDb::DeleteForRoom only runs on the lobby's cleanup path), so a
// fresh-looking row must never be able to resurrect a dead server.

// 5 missed 2s heartbeats — defined once in stack-census.js, because the
// P8 census applies the same threshold to the same rows and two copies of a
// staleness rule drift. The heartbeat is published from inside the sim loop
// (server_main.cpp:2559-2562); if that cadence changes, that constant follows.

const PHASE_ORDER = { dead: -1, spawning: 0, loading: 1, ready: 2, ticking: 3 };

function probeResult(phase, fields) {
    return {
        phase,
        roomId: null, pid: null, port: null,
        ready: null, clientCount: null, statusAgeSec: null,
        frame: null, simFps: null, detail: '',
        ...fields,
    };
}

async function probeGame(roomId) {
    const servers = await getGameServers();
    const row = servers.find(s => s.room_id === roomId);
    if (!row) {
        return probeResult('dead', { roomId, detail: `no process row for room ${roomId}` });
    }
    if (!pidAlive(row.pid)) {
        return probeResult('dead', {
            roomId, pid: row.pid, port: row.port,
            detail: `pid ${row.pid} not running (row state='${row.state}')`,
        });
    }

    // Readonly, opened and closed per probe: a cached handle would hold a WAL
    // snapshot and read ever-staler heartbeats.
    let st = null;
    try {
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        try {
            st = db.prepare(
                'SELECT ready, client_count, pid, port, updated_at FROM game_status WHERE room_id = ?',
            ).get(roomId) ?? null;
        } finally { db.close(); }
    } catch { /* no DB / no table yet → treat as no status row */ }

    const base = { roomId, pid: row.pid, port: st?.port || row.port };
    if (!st) {
        return probeResult('spawning', { ...base, detail: 'process up, no game_status row yet' });
    }
    if (st.pid !== row.pid) {
        // A corpse's row describing a *new* incarnation of the same room.
        return probeResult('spawning', {
            ...base, port: row.port,
            detail: `game_status row is stale (previous pid ${st.pid})`,
        });
    }

    const statusAgeSec = Math.max(0, Math.floor(Date.now() / 1000) - st.updated_at);
    const withStatus = { ...base, ready: st.ready, clientCount: st.client_count, statusAgeSec };
    if (statusAgeSec > STATUS_STALE_SEC) {
        // The heartbeat only runs inside the sim loop; a live pid deep in
        // map/defs precache is busy, not dead.
        return probeResult('loading', {
            ...withStatus,
            detail: `status heartbeat stale ${statusAgeSec}s — server busy loading or wedged`,
        });
    }
    if (!st.ready) return probeResult('loading', { ...withStatus, detail: 'ready=0' });

    let m = null, mErr = '';
    try { m = await fetchMetrics(`http://127.0.0.1:${withStatus.port}`, 1500); }
    catch (e) { mErr = e.message; }
    if (!m) {
        return probeResult('ready', {
            ...withStatus, detail: `ready=1 but /api/metrics unreachable: ${mErr}`,
        });
    }
    const withMetrics = { ...withStatus, frame: m.frame, simFps: m.simFps };
    // writeGameStatus(true, 0) fires before the sim loop starts, and a Skirmish
    // holds GameStart until humans connect — ready=1/frame=0 is a real, stable,
    // connectable state.
    if (!(m.frame > 0)) {
        // frame is -1 before GameStart, 0 on the first tick boundary.
        return probeResult('ready', { ...withMetrics, detail: `accepting, sim not ticking (frame ${m.frame})` });
    }
    return probeResult('ticking', withMetrics);
}

// Resolve the room a probe/wait targets. An explicit roomId is taken verbatim
// (probing a room that has already gone is a legitimate post-mortem question);
// omitting it uses getGameServerUrl's prefer-running pick, ONCE.
async function resolveWaitRoom(roomId) {
    if (roomId !== undefined && roomId > 0) return { roomId };
    const server = await getGameServerUrl(undefined);
    if (server) return { roomId: server.room_id };
    const servers = await getGameServers();
    const list = servers.map(s => `  room ${s.room_id} (state=${s.state}, pid=${s.pid})`).join('\n') || '  (none)';
    return { error: `Error: no game server to probe. Candidates:\n${list}\nPass an explicit roomId.` };
}

// Last N formatted room-scoped log lines, for inlining into a failed wait.
// Never throws and never hangs: a failure to fetch logs must not turn a fast
// failure into a slow one. Returns {lines, note} — the note names the reason
// the lines are missing so an empty array is never mistaken for a quiet server.
async function roomLogTail(roomId, limit = 15) {
    try {
        const data = await fetchJson(`${LOG_SERVER_URL}/api/logs/${roomId}?limit=${limit}`, 1500);
        if (!Array.isArray(data) || !data.length) return { lines: [], note: '' };
        return { lines: formatLogEntries(data).split('\n'), note: '' };
    } catch (e) {
        return { lines: [], note: `log server ${LOG_SERVER_URL} unreachable: ${e.message}` };
    }
}

// --- Direct-start manifests (PLAN-test-automation/P3) ---
//
// Loading and merge rules live in direct-manifest.js so they stay unit-testable
// without starting an MCP stdio server.
//
// The single POST/parse choke point for /api/rooms/direct, shared by
// launch_scenario and launch_direct so the two never drift on error wording.
// Returns {ok:true, room} or {ok:false, error} with a caller-facing message.
async function postDirectManifest(manifest) {
    let resp;
    try {
        resp = await authedFetch(token => fetch(`${LOBBY_URL}/api/rooms/direct`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify(manifest),
        }));
    } catch (e) {
        return { ok: false, error: `POST ${LOBBY_URL}/api/rooms/direct failed: ${e.message}` };
    }
    if (resp.status === 404) {
        return {
            ok: false,
            error: 'POST /api/rooms/direct answered 404 — the lobby needs --dev-direct-start '
                 + '(or this lobby binary predates the route). Restart the lobby with the flag '
                 + '(the mprocs dev stack passes it already), or use launch_game for the lobby-flow path.',
        };
    }
    const bodyText = await resp.text();
    let room = {};
    try { room = JSON.parse(bodyText); } catch { /* non-JSON error body */ }
    if (!resp.ok) {
        if (resp.status === 403) {
            return {
                ok: false,
                error: `direct start refused (403): ${room.error ?? bodyText}. `
                     + 'The route is LocalhostOrAdmin — run the MCP on the lobby host, or as an admin account.',
            };
        }
        return { ok: false, error: `direct start failed (${resp.status}): ${room.error ?? (bodyText || '?')}` };
    }
    return { ok: true, room };
}

// Poll probeGame until `want` ('ready' accepts 'ticking' too) or the deadline.
// A 'dead' phase short-circuits: a server that died during boot never recovers,
// and waiting the full budget on it turns a fast failure into a slow one.
async function waitForPhase(roomId, want, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let probe = await probeGame(roomId);
    const reached = p => (want === 'ready' ? (p === 'ready' || p === 'ticking') : p === 'ticking');
    while (probe.phase !== 'dead' && !reached(probe.phase)) {
        if (Date.now() >= deadline) return { ...probe, timedOut: true };
        await new Promise(r => setTimeout(r, 500));
        probe = await probeGame(roomId);
    }
    return { ...probe, timedOut: false };
}

// --- HTTP helpers ---
async function fetchJson(url, timeoutMs) {
    const opts = timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {};
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    return resp.json();
}

// GET :port/api/metrics — RouteAuth::Public, served off the HTTP thread, so it
// answers while the sim is paused or the exec queue is wedged, and it survives
// SPRING_PROD (where /api/exec is compiled out). Base payload is
// PerfMetrics::ToJSON(): {frame, tickUs, simFps, entities, clients, ais,
// combatEvents} plus a `simFrame` block.
async function fetchMetrics(serverUrl, timeoutMs) {
    return fetchJson(`${serverUrl}/api/metrics`, timeoutMs);
}

/// Resolve `rel` against `base`, falling back to case-insensitive
/// component matching. Mirrors the behaviour the lobby's static
/// handler used to provide for ZK-style mixed-case filenames
/// referenced as lowercase. Returns the absolute path if resolved,
/// or null if no candidate exists.
function resolveCaseInsensitive(base, rel) {
    if (rel.includes('..')) return null;
    const direct = join(base, rel);
    if (existsSync(direct)) return direct;
    const wanted = rel.split('/').filter(Boolean);
    let cur = base;
    for (const seg of wanted) {
        const candidate = join(cur, seg);
        if (existsSync(candidate)) { cur = candidate; continue; }
        if (!existsSync(cur)) return null;
        let entries;
        try { entries = readdirSync(cur); } catch { return null; }
        const want = seg.toLowerCase();
        const match = entries.find(e => e.toLowerCase() === want);
        if (!match) return null;
        cur = join(cur, match);
    }
    return existsSync(cur) ? cur : null;
}

async function execOnServer(serverUrl, scope, code) {
    const resp = await authedFetch(token => fetch(`${serverUrl}/api/exec`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ scope, code }),
    }));
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`exec failed (${resp.status}): ${text}`);
    }
    return resp.json();
}

async function execOnGameServer(scope, code, roomId) {
    const server = await getGameServerUrl(roomId);
    if (!server) {
        const servers = await getGameServers();
        if (servers.length === 0) {
            throw new Error('No game servers found. Is the lobby running and is a game in progress?');
        }
        throw new Error(`No active game server found. Available: ${servers.map(s => `room ${s.room_id} (${s.state})`).join(', ')}`);
    }
    return execOnServer(server.url, scope, code);
}

/// Try the structured form of a server verb (`json <verb>`), falling back to
/// legacy free text when the binary predates the prefix — such a binary answers
/// `unknown command: json <verb>`, and that reply IS the capability probe.
///
/// Returns `{json}` when the reply parsed, `{legacy: null}` when the server is
/// old (caller re-issues the plain verb), and `{legacy: <text>}` when the reply
/// is real output that simply isn't JSON (an unconverted verb — the `json `
/// prefix is a request, not a guarantee — or a Lua `error:`/`runtime error:`
/// string from a verb that routes through LuaRules). Throws on real errors.
///
/// Note converted-verb errors come back `success:true` with an `{"error":...}`
/// body (the server derives success solely from `unknown command:`), so callers
/// must check `.error` on the parsed object.
async function execJsonVerb(verb, roomId) {
    const r = await execOnGameServer('server', `json ${verb}`, roomId);
    const output = r.output ?? '';
    if (!r.success) {
        if (output.startsWith('unknown command: json')) return { legacy: null };
        throw new Error(output || 'exec failed');
    }
    try { return { json: JSON.parse(output) }; }
    catch { return { legacy: output }; }
}

/// PLAN-test-automation P7: run code inside a CONNECTED browser client and get
/// the result back, via the game server's `POST /api/client/eval` relay.
///
/// Three gates stand between this call and an eval: the route is compiled out
/// under SPRING_PROD, only an **admin-role** session is ever addressed, and the
/// browser itself refuses unless it is a DEV build or was booted with
/// `?allowClientEval=1`. Each of those answers with a distinct string, and this
/// helper turns all three into `{fallback: <reason>}` so a caller can print the
/// paste-into-devtools snippet instead. A real transport/auth failure throws.
///
/// `target` is one of:
///   'js'      — main thread global scope
///   'worker'  — render worker global scope (the __entityRenderer/__csm hooks)
///   'widgets' — the in-worker LuaUI runtime (Lua source, via window.widgets.eval)
///   'test'    — a `window.test` harness expression, e.g. `readyState()`
async function clientEval(target, code, roomId, clientId, timeoutMs) {
    const server = await getGameServerUrl(roomId);
    if (!server) return { fallback: 'no active game server found' };
    let resp;
    try {
        resp = await authedFetch(token => fetch(`${server.url}/api/client/eval`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
                target, code,
                ...(clientId ? { clientId } : {}),
                ...(timeoutMs ? { timeoutMs } : {}),
            }),
        }));
    } catch (e) {
        return { fallback: `game server unreachable: ${e.message}` };
    }
    // 404 = the route does not exist = a production binary (SPRING_PROD).
    if (resp.status === 404) return { fallback: 'server built without the relay (SPRING_PROD)' };
    if (!resp.ok) throw new Error(`client eval failed (${resp.status}): ${await resp.text()}`);
    const r = await resp.json();
    if (!r.success && (r.output === 'no connected admin client'
                    || r.output === 'client eval disabled in this build'
                    || String(r.output || '').startsWith('timeout:'))) {
        return { fallback: r.output };
    }
    return r;   // {success, clientId, output}
}

/// TestHarness methods that round-trip to the game server's OWN HTTP API
/// (`/api/exec`). Relaying one DEADLOCKS: the game server serves HTTP on a
/// single thread, and that thread is parked inside `/api/client/eval` waiting
/// for the very browser whose request it would have to answer. Verified — with
/// a relay call in flight, `/api/metrics` on the same server does not respond
/// until the waiter gives up. Each of these has a server-side MCP tool that
/// does the same job without a browser in the loop.
const SERVER_BOUND_HARNESS_METHODS = new Map([
    ['spawn', 'spawn_unit'], ['spawnAndFocus', 'spawn_unit + browser_test focus'],
    ['stageCombat', 'spawn_unit + give_order'],
    ['kill', 'kill_unit'], ['damage', 'damage_unit'], ['clear', 'clear_units'],
    ['order', 'give_order'], ['state', 'get_game_state'], ['units', 'list_units'],
    ['unitState', 'get_unit_state'], ['frame', 'get_frame'],
    ['combatSummary', 'get_combat_summary'], ['cheats', 'set_cheats'],
    ['log', 'set_debug_logging'], ['logStatus', 'set_debug_logging'],
    ['setLogging', 'set_debug_logging'], ['lua', 'exec_lua'], ['server', 'exec_lua'],
    ['serverJson', 'exec_lua'], ['simPause', 'pause_sim'], ['simResume', 'pause_sim'],
    ['simSpeed', 'set_sim_speed'], ['stockpile', 'set_stockpile'],
    ['reviveTeam', 'revive_team'],
]);

/// Parse a relay `output` as JSON when it is JSON, else hand back the string.
function clientEvalValue(output) {
    try { return JSON.parse(output); } catch { return output; }
}

// --- Minimal FlatBuffer decoder for cached UnitDefs/WeaponDefs ---
// The server bakes defs to data/games/{gameId}/cache/defs/{key}/unitdefs.bin
// (and weapondefs.bin) framed as: 1-byte envelope + ServerMessage root.
// We decode by hand to avoid pulling the generated TS bindings into node.
class FBReader {
    constructor(buf, pos) { this.buf = buf; this.pos = pos; }
    u8 (off) { return this.buf[this.pos + off]; }
    u16(off) { return this.buf[this.pos + off] | (this.buf[this.pos + off + 1] << 8); }
    u32(off) {
        const v = this.buf[this.pos + off]
            | (this.buf[this.pos + off + 1] << 8)
            | (this.buf[this.pos + off + 2] << 16)
            | (this.buf[this.pos + off + 3] << 24);
        return v >>> 0;
    }
    i32(off) {
        return this.buf[this.pos + off]
            | (this.buf[this.pos + off + 1] << 8)
            | (this.buf[this.pos + off + 2] << 16)
            | (this.buf[this.pos + off + 3] << 24);
    }
    f32(off) {
        const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos + off, 4);
        return dv.getFloat32(0, true);
    }
    str(off) {
        // Field at this.pos+off contains a u32 offset to the string;
        // the string layout is u32 length followed by utf-8 bytes.
        const fieldOff = this.u32(off);
        const strPos = this.pos + off + fieldOff;
        const len = this.buf[strPos] | (this.buf[strPos+1] << 8) | (this.buf[strPos+2] << 16) | (this.buf[strPos+3] << 24);
        return new TextDecoder('utf-8').decode(this.buf.slice(strPos + 4, strPos + 4 + len));
    }
    // Resolve table at fieldOff (u32 indirect at this.pos+fieldOff).
    table(fieldOff) {
        const off = this.u32(fieldOff);
        return new FBReader(this.buf, this.pos + fieldOff + off);
    }
    // Vector header at this.pos+fieldOff (u32 indirect → u32 count).
    vectorMeta(fieldOff) {
        const off = this.u32(fieldOff);
        const start = this.pos + fieldOff + off;
        const count = this.buf[start] | (this.buf[start+1] << 8) | (this.buf[start+2] << 16) | (this.buf[start+3] << 24);
        return { start, count };
    }
    // Get vtable size, return zero if vt entry missing.
    field(vtField) {
        const vtOff = this.i32(0);
        const vtPos = this.pos - vtOff;
        const vtSize = this.buf[vtPos] | (this.buf[vtPos+1] << 8);
        if (vtField >= vtSize) return 0;
        return this.buf[vtPos + vtField] | (this.buf[vtPos + vtField + 1] << 8);
    }
}

function decodeCustomParams(parent, vtField) {
    const fieldOff = parent.field(vtField);
    if (!fieldOff) return {};
    const meta = parent.vectorMeta(fieldOff);
    const result = {};
    for (let i = 0; i < meta.count; i++) {
        const entryFieldPos = meta.start + 4 + i * 4;
        const entryOff = parent.buf[entryFieldPos] | (parent.buf[entryFieldPos+1] << 8)
            | (parent.buf[entryFieldPos+2] << 16) | (parent.buf[entryFieldPos+3] << 24);
        const cp = new FBReader(parent.buf, entryFieldPos + entryOff);
        const keyOff = cp.field(4);
        const valOff = cp.field(6);
        if (!keyOff) continue;
        result[cp.str(keyOff)] = valOff ? cp.str(valOff) : '';
    }
    return result;
}

function decodeUnitDef(buf, defReaderPos) {
    const r = new FBReader(buf, defReaderPos);
    const fieldStr = (vt) => { const o = r.field(vt); return o ? r.str(o) : ''; };
    const fieldF32 = (vt, dflt = 0) => { const o = r.field(vt); return o ? r.f32(o) : dflt; };
    const fieldI32 = (vt, dflt = 0) => { const o = r.field(vt); return o ? r.i32(o) : dflt; };
    const fieldU16 = (vt, dflt = 0) => { const o = r.field(vt); return o ? r.u16(o) : dflt; };
    const fieldU8  = (vt, dflt = 0) => { const o = r.field(vt); return o ? r.u8(o)  : dflt; };
    return {
        defId: fieldU16(4),
        name: fieldStr(6),
        modelUrl: fieldStr(8),
        textureUrl: fieldStr(10),
        humanName: fieldStr(12),
        tooltip: fieldStr(14),
        wreckName: fieldStr(16),
        metalCost: fieldF32(18),
        energyCost: fieldF32(20),
        buildTime: fieldF32(22),
        metalMake: fieldF32(24),
        energyMake: fieldF32(26),
        health: fieldF32(38),
        mass: fieldF32(40),
        radius: fieldF32(42),
        xsize: fieldI32(44),
        zsize: fieldI32(46),
        speed: fieldF32(48),
        turnRate: fieldF32(50),
        losRadius: fieldF32(56),
        flags: fieldI32(68),
        buildDistance: fieldF32(70),
        buildSpeed: fieldF32(72),
        customParams: decodeCustomParams(r, 78),
        repairSpeed: fieldF32(80),
        transportSize: fieldI32(82),
        transportMass: fieldF32(84),
        transportCapacity: fieldI32(86),
        yardmap: fieldStr(88),
        script: fieldStr(90),
        buildPic: fieldStr(92),
        maxVelocity: fieldF32(94),
        cost: fieldF32(96),
        maxWeaponRange: fieldF32(98),
        maxThisUnit: fieldI32(100),
        canBeAssisted: fieldU8(102, 1) === 1,
        canSelfDestruct: fieldU8(104, 1) === 1,
        selfDCountdown: fieldI32(106),
        categoryBits: fieldI32(108),
    };
}

function decodeWeaponDef(buf, defReaderPos) {
    const r = new FBReader(buf, defReaderPos);
    const fieldStr = (vt) => { const o = r.field(vt); return o ? r.str(o) : ''; };
    const fieldF32 = (vt, dflt = 0) => { const o = r.field(vt); return o ? r.f32(o) : dflt; };
    const fieldI32 = (vt, dflt = 0) => { const o = r.field(vt); return o ? r.i32(o) : dflt; };
    const fieldU16 = (vt, dflt = 0) => { const o = r.field(vt); return o ? r.u16(o) : dflt; };
    return {
        defId: fieldU16(4),
        name: fieldStr(6),
        range: fieldF32(12),
        aoe: fieldF32(14),
        size: fieldF32(16),
        typeName: fieldStr(28),
        description: fieldStr(30),
        defaultDamage: fieldF32(32),
        reloadTime: fieldF32(36),
        flags: fieldI32(82),
        customParams: decodeCustomParams(r, 86),
    };
}

// Find the most-recent cache directory for a game and load its bin.
function loadDefsCache(gameId, kind /* 'unitdefs' | 'weapondefs' */) {
    const projectRoot = process.env.PROJECT_ROOT || resolve('.');
    const dir = join(projectRoot, 'data', 'games', gameId, 'cache', 'defs');
    if (!existsSync(dir)) return null;
    const keys = readdirSync(dir);
    if (!keys.length) return null;
    // Pick most-recently modified .bin (cache key changes when schema
    // version bumps, so multiple key dirs may coexist; the freshest is
    // the one the running server just baked).
    let best = null;
    let bestMtime = 0;
    for (const k of keys) {
        const file = join(dir, k, `${kind}.bin`);
        if (!existsSync(file)) continue;
        const m = statSync(file).mtimeMs;
        if (m > bestMtime) { best = file; bestMtime = m; }
    }
    if (!best) return null;
    const data = readFileSync(best);
    // Skip envelope byte then resolve ServerMessage root.
    const buf = new Uint8Array(data.buffer, data.byteOffset + 1, data.byteLength - 1);
    const rootOff = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
    const msg = new FBReader(buf, rootOff);
    // ServerMessage.payload is at vt offset 6.
    const payloadFieldOff = msg.field(6);
    if (!payloadFieldOff) return null;
    const payload = msg.table(payloadFieldOff);
    // GameUnitDefs / GameWeaponDefs both have `defs:[*]` at vt offset 4.
    const defsFieldOff = payload.field(4);
    if (!defsFieldOff) return null;
    const meta = payload.vectorMeta(defsFieldOff);
    return { buf, defsStart: meta.start, defsCount: meta.count, sourceFile: best };
}

function listDefsFromCache(gameId, kind, decoder, filter) {
    const cache = loadDefsCache(gameId, kind);
    if (!cache) return null;
    const out = [];
    for (let i = 0; i < cache.defsCount; i++) {
        const entryFieldPos = cache.defsStart + 4 + i * 4;
        const entryOff = cache.buf[entryFieldPos] | (cache.buf[entryFieldPos+1] << 8)
            | (cache.buf[entryFieldPos+2] << 16) | (cache.buf[entryFieldPos+3] << 24);
        const def = decoder(cache.buf, entryFieldPos + entryOff);
        if (!filter || filter(def)) out.push(def);
    }
    return { defs: out, sourceFile: cache.sourceFile };
}

// --- Process management helpers ---
function killProcess(pid, signal = 'SIGKILL') {
    try { process.kill(pid, signal); return true; }
    catch { return false; }
}

// EPERM means the process exists but isn't ours — still alive. ESRCH is the
// only "gone" answer signal 0 gives us.
function pidAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
}

// SIGTERM → poll → SIGKILL, mirroring tools/scripts/spring-services.sh
// stop_pattern but per-pid and with a longer window: spring-server's signal
// handler turns SIGTERM into a clean loop exit that drains the war log and
// writes the exit checkpoint (server_main.cpp) — the one site where a world
// becomes resumable. A server deep in map/defs precache won't poll keepRunning
// until the load finishes, hence the escalation.
async function endProcess(pid, { graceful = true, timeoutMs = 10000, pollMs = 250, escalate = true } = {}) {
    const t0 = Date.now();
    let escalatedToKill = false;
    if (graceful) {
        try { process.kill(pid, 'SIGTERM'); }
        catch { return { exited: !pidAlive(pid), escalatedToKill, waitedMs: 0 }; }
        while (Date.now() - t0 < timeoutMs) {
            if (!pidAlive(pid)) return { exited: true, escalatedToKill, waitedMs: Date.now() - t0 };
            await new Promise(r => setTimeout(r, pollMs));
        }
        // The caller can decline the escalation — a stuck server left alive is
        // sometimes the point (it is still attachable to a debugger).
        if (!escalate) return { exited: false, escalatedToKill, waitedMs: Date.now() - t0 };
        escalatedToKill = true;
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    // SIGKILL can't be blocked, but the kernel (and the lobby, which reaps its
    // spring-server children) needs a beat.
    const killDeadline = Date.now() + 2000;
    while (Date.now() < killDeadline) {
        if (!pidAlive(pid)) break;
        await new Promise(r => setTimeout(r, 100));
    }
    return { exited: !pidAlive(pid), escalatedToKill, waitedMs: Date.now() - t0 };
}

// --- Stack census (P8) ------------------------------------------------------
//
// The IO half of list_stack / cleanup_stack; the classification lives in
// stack-census.js (pure, tested). Every shell-out goes through execFileAsync
// (argument arrays, no shell), mirroring the restart_client precedent.

/** pgrep -f for one pattern. Exit 1 (no match) is not an error. */
async function pgrepPids(pattern) {
    try {
        const { stdout } = await execFileAsync('pgrep', ['-f', '--', pattern]);
        return stdout.split('\n').map(s => Number(s.trim())).filter(Boolean)
            // pgrep spawns no shell here (execFile), so the known "matches its
            // own zsh wrapper" trap doesn't apply — but a loosened pattern
            // could still match this node process. Never report ourselves.
            .filter(pid => pid !== process.pid);
    } catch { return []; }
}

async function psRows(pids) {
    if (!pids.length) return [];
    try {
        const { stdout } = await execFileAsync('ps', ['-o', 'pid=,ppid=,lstart=,args=', '-p', pids.join(',')]);
        return parsePsOutput(stdout);
    } catch { return []; }
}

/** One lsof for every listener on the box; the census filters from there. */
async function listListeners() {
    try {
        const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
        return { available: true, listeners: parseLsofF(stdout) };
    } catch (err) {
        // lsof exits 1 with empty output when nothing matches — that is an
        // empty census, not a missing tool. ENOENT is the missing tool.
        if (err && err.code === 'ENOENT') return { available: false, listeners: [] };
        return { available: true, listeners: parseLsofF(err?.stdout || '') };
    }
}

/**
 * `spring-server --print-engine-hash` prints 16 hex digits and exits before
 * logging/SQLite/anything (server_main.cpp:162-176). An older binary without
 * the flag would BOOT instead — hence the timeout, and the "only under
 * build/{debug,release}" restriction on what we ever exec.
 */
async function probeEngineHash(binPath) {
    try {
        const { stdout } = await execFileAsync(binPath, ['--print-engine-hash'], { timeout: 5000 });
        const hash = stdout.trim();
        return /^[0-9a-f]{16}$/.test(hash) ? hash : null;
    } catch { return null; }
}

async function collectBinaries(probeHashes) {
    const root = projectRoot();
    const out = {};
    for (const flavour of ['release', 'debug']) {
        const p = resolve(root, `build/${flavour}/spring-server`);
        try {
            const st = statSync(p);
            out[flavour] = {
                path: p, mtimeMs: st.mtimeMs, mtime: new Date(st.mtimeMs).toISOString(),
                size: st.size, engineHash: probeHashes ? await probeEngineHash(p) : null,
            };
        } catch { /* not built */ }
    }
    return classifyBinaries(out);
}

function readGameStatusRows() {
    try {
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        try {
            const now = Math.floor(Date.now() / 1000);
            const rows = db.prepare(
                'SELECT room_id, ready, client_count, pid, port, updated_at FROM game_status',
            ).all();
            return {
                available: true,
                rows: rows.map(r => ({
                    ...r,
                    heartbeatAgeSec: r.updated_at ? now - r.updated_at : null,
                    stale: r.updated_at ? (now - r.updated_at) > STATUS_STALE_SEC : true,
                    alive: pidAlive(r.pid),
                })),
            };
        } finally { db.close(); }
    } catch {
        return { available: false, rows: [] };
    }
}

/** Best-effort `identity` from a running server's /api/metrics. */
async function fetchIdentity(port) {
    try {
        const j = await fetchJson(`http://127.0.0.1:${port}/api/metrics`, 1500);
        return j?.identity ?? null;
    } catch { return null; }
}

/**
 * Whether the mprocs control server is listening — an lsof LISTEN check ONLY.
 *
 * IMPORTANT: never open a socket to it. mprocs deserializes whatever an
 * accepted connection carries, so a bare connect+close fails it with
 * `invalid type: … expected internally tagged enum AppEvent` and can take
 * mprocs down (tools/scripts/spring-services.sh:103-120). A health ping here
 * would be a regression, not an improvement.
 */
function mprocsStatus(listeners) {
    let yamlText = '';
    try { yamlText = readFileSync(resolve(projectRoot(), 'mprocs.yaml'), 'utf-8'); } catch { /* none */ }
    const addr = resolveMprocsAddr({ env: process.env.MPROCS_SERVER || '', yamlText });
    const ctlPort = Number(addr.split(':').pop());
    return { ctlPort, reachable: listeners.some(l => l.port === ctlPort) };
}

/** The whole census, shared verbatim by list_stack and cleanup_stack. */
async function collectStackFindings({ probeHashes = false } = {}) {
    const [lobbyPids, serverPids, logserverPids, vitePids] = await Promise.all(
        [STACK_PATTERNS.lobby, STACK_PATTERNS.server, STACK_PATTERNS.logserver, STACK_PATTERNS.vite]
            .map(pgrepPids),
    );
    const [lobby, server, logserver, vite] = await Promise.all(
        [lobbyPids, serverPids, logserverPids, vitePids].map(psRows),
    );
    const ports = await listListeners();
    const rows = await getGameServers();
    // getGameServers() silently folds two sources into one shape; which one
    // answered changes what "unmanaged" means, so ask separately.
    let source = 'none';
    try {
        const resp = await fetch(`${LOBBY_URL}/api/processes`, { signal: AbortSignal.timeout(2000) });
        if (resp.ok) source = 'lobby';
    } catch { /* lobby down */ }
    if (source === 'none' && rows.length) source = 'sqlite';

    const binaries = await collectBinaries(probeHashes);
    const gameStatus = readGameStatusRows();

    // Identity probes only when we have something to compare against.
    let identities = [];
    if (probeHashes) {
        const targets = [];
        for (const r of rows) if (r.port && pidAlive(r.pid)) targets.push({ pid: r.pid, port: r.port });
        for (const p of server) {
            if (targets.some(t => t.pid === p.pid)) continue;
            const port = (ports.listeners || []).find(l => l.pid === p.pid)?.port;
            if (port) targets.push({ pid: p.pid, port });
        }
        const settled = await Promise.allSettled(targets.map(t => fetchIdentity(t.port)));
        identities = targets.map((t, i) => ({
            ...t, identity: settled[i].status === 'fulfilled' ? settled[i].value : null,
        }));
    }

    const census = {
        processes: { lobby, server, logserver, vite },
        ports, authority: { source, rows }, gameStatus, binaries, identities,
    };
    const findings = classifyStack(census);
    const lobbyPid = (ports.listeners || []).find(l => l.port === STACK_PORTS.lobby)?.pid ?? null;
    return { census, findings, lobbyPid };
}

/**
 * The kill helper. The :8011 refusal lives HERE rather than only in the
 * planner, so no future call path can route around it.
 */
async function cleanupKill(action, lobbyPid) {
    if (lobbyPid && action.pid === lobbyPid) {
        return { ...action, outcome: 'refused', reason: 'pid holds :8011 (the live lobby)' };
    }
    if (!pidAlive(action.pid)) return { ...action, outcome: 'exited', signal: null };
    // SIGTERM first: spring-server turns it into a clean loop exit that drains
    // the war log and writes the exit checkpoint (server_main.cpp).
    const r = await endProcess(action.pid, { graceful: true, timeoutMs: 5000, pollMs: 500, escalate: true });
    return {
        ...action,
        signal: r.escalatedToKill ? 'SIGKILL' : 'SIGTERM',
        outcome: r.exited ? (r.escalatedToKill ? 'killed' : 'exited') : 'error',
        waitedMs: r.waitedMs,
    };
}

// Destructive verbs never guess which game they mean: without an explicit
// roomId they refuse and enumerate. (Read-oriented tools keep getGameServerUrl's
// permissive auto-pick — that's a feature there.)
function resolveRoomTargetStrict(servers, roomId) {
    const candidates = servers.filter(s => s.state !== 'ended');
    const list = (candidates.length ? candidates : servers)
        .map(s => `  room ${s.room_id} (state=${s.state}, pid=${s.pid}, map=${s.map_id})`)
        .join('\n') || '  (none)';
    if (roomId === undefined || roomId <= 0) {
        return { error: `Error: roomId is required. Candidates:\n${list}\nRe-run with the roomId you mean.` };
    }
    const target = servers.find(s => s.room_id === roomId);
    if (!target) {
        return { error: `Error: no game server for room ${roomId}. Candidates:\n${list}` };
    }
    return { target };
}

// Every payload spring-server writes under cache/defs/<key>/. The `.bin`
// entries are the pre-v14 FlatBuffer format; since 63287c0e4e the bake emits
// brotli-compressed Lua source (`.lua.br`) plus `power.json`. Listing only the
// `.bin` names made this a silent no-op on every current checkout — the tool
// reported "Removed 0 cache file(s)" and callers read that as "cache cleared",
// which is the worst possible failure mode for a post-serializer-change verify.
// See rts/Server/DefsCache.h.
const DEFS_CACHE_FILES = [
    'unitdefs.lua.br', 'weapondefs.lua.br', 'cegdefs.lua.br', 'featuredefs.lua.br',
    'power.json',
    'unitdefs.bin', 'weapondefs.bin',   // legacy pre-v14 orphans
];

function clearDefsCache(gameId) {
    const projectRoot = process.env.PROJECT_ROOT || resolve('.');
    const baseDir = join(projectRoot, 'data', 'games');
    if (!existsSync(baseDir)) return { removed: 0 };
    let removed = 0;
    const games = gameId ? [gameId] : readdirSync(baseDir);
    for (const g of games) {
        const cacheDir = join(baseDir, g, 'cache', 'defs');
        if (!existsSync(cacheDir)) continue;
        const keys = readdirSync(cacheDir);
        for (const k of keys) {
            for (const f of DEFS_CACHE_FILES) {
                const p = join(cacheDir, k, f);
                if (existsSync(p)) {
                    try { unlinkSync(p); removed++; } catch { /* ignore */ }
                }
            }
            // Drop the now-empty key dir so `ls cache/defs` reflects reality.
            try { if (readdirSync(join(cacheDir, k)).length === 0) rmdirSync(join(cacheDir, k)); }
            catch { /* ignore */ }
        }
    }
    return { removed };
}

// --- Tool definitions ---
// Shared tail for every tool that goes over the P7 browser-eval relay —
// documented once so each description stays honest about the three gates.
const RELAY = 'Runs over the P7 browser-eval relay (POST /api/client/eval on the game server): the code executes in a CONNECTED browser and the result comes back here. Three gates — the route is compiled out under SPRING_PROD, only an admin-role session is addressed (a /api/rooms/direct dev account is role "player" and is NEVER eligible; launch_scenario\'s default player IS admin), and the browser refuses unless it is a DEV build or was booted with ?allowClientEval=1. When any gate refuses, this tool falls back to printing the chrome-devtools snippet to paste by hand.';

const TOOLS = [
    {
        name: 'get_logs',
        description: 'Get recent log entries from the log server. Returns structured log entries with level, section, scope, process, frame, room_id, game_id, and message. Pass roomId to scope to a single game/room (each game server tags its logs with its room).',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID — scope to one game instance (0 for all)', default: 0 },
                game: { type: 'string', description: 'Filter by game content id (e.g. "zk", "papertanks")' },
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
                game: { type: 'string', description: 'Filter by game content id (e.g. "zk")' },
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
        description: 'Kill the non-managed processes list_stack found. CALL WITH dryRun:true FIRST (the default) — it returns the exact plan (pid, kind, signal sequence) and touches nothing. Acts only on stray-server, zombie-port, orphan-vite and duplicate-lobby; `managed` processes are never touched (to stop a real game use end_game({roomId}), which drains gracefully), and stale game_status rows are report-only. Hard invariants: the pid holding :8011 is never killed whatever its classification; stray-server is refused entirely when the lobby is unreachable (with no authority, "stray" cannot be established); a zombie-port pid whose command is not spring-server needs force:true. Kill discipline is SIGTERM → poll 5s → SIGKILL, because spring-server turns SIGTERM into a clean exit checkpoint.',
        inputSchema: {
            type: 'object',
            properties: {
                dryRun: { type: 'boolean', description: 'Report the plan without killing anything. Default TRUE.', default: true },
                kinds: { type: 'array', items: { type: 'string', enum: CLEANABLE_KINDS }, description: `Restrict to these classifications (default: all of ${CLEANABLE_KINDS.join(', ')}).` },
                force: { type: 'boolean', description: 'Allow killing a zombie-port pid whose command line is not spring-server (the 9100-10099 range can catch unrelated dev tools). Default false.', default: false },
            },
        },
    },
    {
        name: 'get_lua_source',
        description: 'Read a Lua source file from the game content via HTTP. Path relative to game root.',
        inputSchema: {
            type: 'object',
            properties: {
                gameId: { type: 'string', description: 'Game ID (e.g. "papertanks")' },
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
        description: 'Execute a read-only SQL query against the lobby database.',
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
                gameId: { type: 'string', description: 'Game ID (e.g. "zk")' },
                name: { type: 'string', description: 'Unit def name (e.g. "armcom1") OR omit and pass defId' },
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
                gameId: { type: 'string', description: 'Game ID (e.g. "zk")' },
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
                gameId: { type: 'string', description: 'Game ID (e.g. "zk")' },
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
                gameId: { type: 'string', description: 'Game ID (e.g. "zk")', default: 'zk' },
                mapId: { type: 'string', description: 'Map ID (e.g. "pools_of_ilys_1.0.0")' },
                roomName: { type: 'string', description: 'Room name', default: 'debug' },
                ai: { type: 'string', description: 'AI to add for the opposing team. Set to "" to skip AI. Default: "null" (Null AI engine bot).', default: 'null' },
                username: { type: 'string', description: 'Username to launch as. Defaults to admin / SPRING_USER.' },
                password: { type: 'string', description: 'Password. Defaults to SPRING_PASS.' },
                clearCache: { type: 'boolean', description: 'Delete the defs cache before launching to force a fresh bake.', default: false },
                testStartupSelector: { type: 'boolean', description: 'Keep ZK\'s "Startup Info and Selector" commander-chooser overlay enabled. Default false — the suggested browserUrl disables it so the view is clear on launch. Set true only when specifically testing that overlay.', default: false },
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
            },
            required: ['path'],
        },
    },
    {
        name: 'spawn_unit',
        description: 'Spawn one or more units of a given def at a world XZ position on a team. Wraps the LuaExecEngine `server spawn` verb (which delegates to Spring.CreateUnit on the LuaRules synced state, so Allow* veto rules apply). Y is auto-resolved via Spring.GetGroundHeight. When count > 1 the server lays them out in a square grid 48 elmos apart. Returns a JSON object {spawned, ids:[...]}; falls back to the legacy "spawned N unit(s): ..." text against a pre-`json ` game server.',
        inputSchema: {
            type: 'object',
            properties: {
                defName: { type: 'string', description: 'Unit def name (e.g. "armcom1", "papertank").' },
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
                defName: { type: 'string', description: 'Unit def name (e.g. "armcom1", "cloakraid").' },
                team: { type: 'number', description: 'Owning team ID', default: 0 },
                count: { type: 'number', description: 'How many to spawn (max 256)', default: 1 },
                offset: { type: 'object', description: 'Optional XZ offset from camera look-at, e.g. {x:200, z:0} to spawn 200 elmos east.' },
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
                hostility: { type: 'string', description: 'Generator enum (see scenariogen.py --hostility).' },
                roster: { type: 'string', description: 'Generator enum (see scenariogen.py --roster).' },
            },
            required: ['mapId'],
        },
    },
];

// --- Tool execution ---
async function executeTool(name, args) {
    switch (name) {
        case 'get_logs': {
            const params = new URLSearchParams();
            if (args.level) params.set('level', String(args.level));
            if (args.section) params.set('section', args.section);
            if (args.scope) params.set('scope', args.scope);
            if (args.game) params.set('game', args.game);
            if (args.sinceMinutes) params.set('since', String(Date.now() - args.sinceMinutes * 60000));
            if (args.limit) params.set('limit', String(args.limit));
            const roomId = args.roomId || 0;
            const url = `${LOG_SERVER_URL}/api/logs/${roomId}?${params}`;
            const data = await fetchJson(url);
            return formatLogEntries(data);
        }

        case 'search_logs': {
            const params = new URLSearchParams();
            if (args.query) params.set('q', args.query);
            // roomId scopes the search to a single game instance; the
            // logserver tags each entry with the owning room/game.
            if (args.roomId) params.set('room', String(args.roomId));
            if (args.game) params.set('game', args.game);
            if (args.section) params.set('section', args.section);
            if (args.level) params.set('level', String(args.level));
            if (args.sinceMinutes) params.set('since', String(Date.now() - args.sinceMinutes * 60000));
            if (args.limit) params.set('limit', String(args.limit));
            const url = `${LOG_SERVER_URL}/api/logs/search?${params}`;
            const data = await fetchJson(url);
            return formatLogEntries(data);
        }

        case 'exec_lua': {
            const result = await execOnGameServer(args.scope, args.code, args.roomId);
            if (!result.success) return `Error: ${result.output || 'execution failed'}`;
            return result.output || '(no output)';
        }

        case 'get_game_state': {
            const r = await execJsonVerb('state', args.roomId);
            if (r.json) {
                if (r.json.error) return `Error: ${r.json.error}`;
                return r.json;
            }
            if (r.legacy) return r.legacy;
            const result = await execOnGameServer('server', 'state', args.roomId);
            return result.output || '(no state)';
        }

        case 'list_units': {
            const cmd = args.team !== undefined && args.team >= 0
                ? `units ${args.team}` : 'units';
            const r = await execJsonVerb(cmd, args.roomId);
            if (r.json) {
                if (r.json.error) return `Error: ${r.json.error}`;
                return r.json;
            }
            if (r.legacy) return r.legacy;
            const result = await execOnGameServer('server', cmd, args.roomId);
            return result.output || '(no units)';
        }

        case 'list_processes': {
            const servers = await getGameServers();
            // Kept as prose: callers (and skill docs) read this exact string as
            // "nothing is running", and JSON `{count:0}` would break them.
            if (!servers.length) return 'No game server processes found.';

            const status = readGameStatusRows();
            const byRoom = new Map(status.rows.map(r => [r.room_id, r]));
            // allSettled: one hung server must not stall the whole listing.
            const ids = await Promise.allSettled(
                servers.map(s => (s.port ? fetchIdentity(s.port) : Promise.resolve(null))),
            );
            return JSON.stringify({
                servers: servers.map((s, i) => {
                    const st = byRoom.get(s.room_id);
                    return {
                        roomId: s.room_id, port: s.port, pid: s.pid, state: s.state,
                        gameId: s.game_id || null, mapId: s.map_id || null,
                        ready: st ? !!st.ready : null,
                        clientCount: st ? st.client_count : null,
                        heartbeatAgeSec: st ? st.heartbeatAgeSec : null,
                        heartbeatStale: st ? st.stale : null,
                        identity: ids[i].status === 'fulfilled' ? ids[i].value : null,
                    };
                }),
                count: servers.length,
            }, null, 2);
        }

        case 'list_stack': {
            const { census, findings } = await collectStackFindings({ probeHashes: !!args.probeHashes });
            return JSON.stringify({
                findings,
                processes: census.processes,
                ports: census.ports.available
                    ? census.ports.listeners.filter(l => isStackPort(l.port))
                    : { available: false },
                authority: { source: census.authority.source, rows: census.authority.rows },
                gameStatus: census.gameStatus.available ? census.gameStatus.rows : { available: false },
                binaries: census.binaries,
                mprocs: mprocsStatus(census.ports.listeners || []),
                summary: summarize(findings),
            }, null, 2);
        }

        case 'cleanup_stack': {
            const dryRun = args.dryRun !== false;   // default TRUE
            const { census, findings, lobbyPid } = await collectStackFindings({ probeHashes: false });
            const { actions, refusals } = planCleanup(findings, {
                kinds: args.kinds, force: !!args.force, lobbyPid,
                authoritySource: census.authority.source,
            });

            if (!actions.length && !refusals.length) {
                const managed = findings.filter(f => f.kind === 'managed').length;
                return JSON.stringify({
                    dryRun, actions: [], refusals: [],
                    note: managed
                        ? `Nothing to clean — all ${managed} processes are managed. To stop a running game use end_game({roomId}), which drains gracefully.`
                        : 'Nothing to clean — no matching findings.',
                    summary: summarize(findings),
                }, null, 2);
            }
            if (dryRun) {
                return JSON.stringify({
                    dryRun: true, plan: actions, refusals,
                    note: 'Dry run — nothing was killed. Re-run with dryRun:false to execute this exact plan.',
                    summary: summarize(findings),
                }, null, 2);
            }
            const results = [];
            for (const a of actions) results.push(await cleanupKill(a, lobbyPid));
            return JSON.stringify({
                dryRun: false, results, refusals, summary: summarize(findings),
            }, null, 2);
        }

        case 'get_lua_source': {
            // Read from filesystem directly — the lobby no longer serves
            // static game data (Vite plugin handles it in dev, nginx/CDN
            // in prod). Tools run on the same host as the data tree so
            // they have direct fs access via PROJECT_ROOT.
            const repoRoot = process.env.PROJECT_ROOT || '.';
            const baseDir = resolve(repoRoot, 'data/games', args.gameId);
            const resolved = resolveCaseInsensitive(baseDir, args.filePath);
            if (!resolved || !existsSync(resolved)) {
                return `Error: file not found: data/games/${args.gameId}/${args.filePath}`;
            }
            try {
                return readFileSync(resolved, 'utf-8');
            } catch (err) {
                return `Error: reading ${args.filePath}: ${err.message}`;
            }
        }

        case 'list_gadgets': {
            const result = await execOnGameServer('LuaRules', 'return table.concat(Spring.GetGadgetList(), "\\n")', args.roomId);
            return result.output || '(no gadgets or game not running)';
        }

        case 'query_db': {
            // Read-only query directly against SQLite. better-sqlite3 sets
            // stmt.reader exactly when the prepared statement returns rows —
            // a parser-level test, unlike the old prefix blacklist which let
            // `WITH t AS (…) INSERT …`, a leading comment, or `REPLACE INTO`
            // straight through. The readonly handle stays as defence in depth.
            try {
                const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
                try {
                    const stmt = db.prepare(args.query);
                    if (!stmt.reader)
                        return 'Error: only row-returning statements are allowed (SELECT, WITH … SELECT, EXPLAIN, PRAGMA reads).';
                    const rows = stmt.all();
                    if (!rows.length) return '(empty result)';
                    return JSON.stringify(rows, null, 2);
                } finally { db.close(); }
            } catch (err) {
                return `Error: ${err.message}`;
            }
        }

        case 'list_sessions': {
            const url = `${LOG_SERVER_URL}/api/sessions`;
            const data = await fetchJson(url);
            if (!data.length) return 'No game sessions found.';
            return data.map(s =>
                `${s.session_id}: room=${s.room_id} game=${s.game_id} map=${s.map_id} ` +
                `reason=${s.end_reason || 'running'} exit=${s.exit_code || '-'}`
            ).join('\n');
        }

        case 'restart_lobby': {
            const result = await execOnServer(LOBBY_URL, 'lobby', 'restart');
            return result.output || 'Restart command sent.';
        }

        case 'restart_logserver': {
            // The log server re-execs itself in place (same pid) on this
            // POST — mirrors the lobby's restart so mprocs keeps tracking
            // the same process. No auth (the log server is unauthenticated).
            let resp;
            try {
                resp = await fetch(`${LOG_SERVER_URL}/api/logs/restart`, { method: 'POST' });
            } catch (e) {
                return `Could not reach the log server at ${LOG_SERVER_URL}: ${e.message}. ` +
                    `Is it running? (mprocs "logserver" pane)`;
            }
            if (!resp.ok)
                return `Log server restart failed: HTTP ${resp.status}`;
            const body = await resp.json().catch(() => ({}));
            return body.message || 'Log server restart command sent (re-exec in place).';
        }

        case 'restart_client': {
            // Vite is a node process with no in-place re-exec, so we restart
            // its mprocs pane through the control channel. spring-services.sh
            // owns all the logic (ctl availability probe, name->index mapping,
            // kill+relaunch fallback) — shell out to it rather than duplicate.
            const repoRoot = process.env.PROJECT_ROOT || resolve('.');
            const script = resolve(repoRoot, 'tools/scripts/spring-services.sh');
            if (!existsSync(script))
                return `spring-services.sh not found at ${script} (set PROJECT_ROOT for the MCP).`;
            try {
                if (args.clearCache) {
                    const viteCache = resolve(repoRoot, 'client/node_modules/.vite');
                    await execFileAsync('rm', ['-rf', viteCache]);
                }
                const { stdout, stderr } = await execFileAsync(
                    script, ['restart', 'client'], { cwd: repoRoot });
                const out = `${stdout || ''}${stderr || ''}`.trim();
                // The script prints a "not reachable — using kill+relaunch
                // fallback" notice on stderr when mprocs lacks the server key;
                // surface it so the caller knows to restart mprocs once.
                return out || 'Client (Vite) pane restart command sent via mprocs.';
            } catch (e) {
                return `Client restart failed: ${e.message}. ` +
                    `Is mprocs running with the 'server:' key? Check \`spring-services.sh status\`.`;
            }
        }

        case 'restart_game': {
            const server = await getGameServerUrl(args.roomId);
            if (!server) {
                const servers = await getGameServers();
                if (servers.length === 0)
                    return 'No game servers found. Is the lobby running and is a game in progress?';
                return `No active game server found. Available: ${servers.map(s => `room ${s.room_id} (${s.state})`).join(', ')}`;
            }
            const resp = await authedFetch(token => fetch(`${server.url}/api/restart`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                },
            }));
            if (!resp.ok) {
                const text = await resp.text();
                return `Restart failed (${resp.status}): ${text}`;
            }
            return `Restart command sent to game server on port ${server.port} (room ${server.room_id}).`;
        }

        case 'get_unit_def': {
            const result = listDefsFromCache(args.gameId, 'unitdefs', decodeUnitDef,
                d => (args.defId !== undefined ? d.defId === args.defId
                    : args.name !== undefined ? d.name === args.name
                    : false));
            if (!result) return `No defs cache found for game "${args.gameId}". Run a game session at least once to bake one.`;
            if (!result.defs.length) return `Unit def not found in cache (gameId=${args.gameId}, name=${args.name || '?'}, defId=${args.defId || '?'}).`;
            return JSON.stringify(result.defs[0], null, 2);
        }

        case 'list_unit_defs': {
            const pattern = (args.pattern || '').toLowerCase();
            const limit = args.limit || 50;
            const result = listDefsFromCache(args.gameId, 'unitdefs', decodeUnitDef,
                d => !pattern || d.name.toLowerCase().includes(pattern));
            if (!result) return `No defs cache found for game "${args.gameId}".`;
            const truncated = result.defs.slice(0, limit);
            if (args.full) return JSON.stringify(truncated, null, 2);
            const summary = truncated.map(d => ({
                defId: d.defId, name: d.name, humanName: d.humanName,
                metalCost: d.metalCost, energyCost: d.energyCost, health: d.health,
                isFactory: !!(d.flags & (1 << 11)),
                isBuilder: !!(d.flags & (1 << 0)),
                hasWeapons: !!(d.flags & (1 << 15)),
                customParamsKeys: Object.keys(d.customParams).length,
            }));
            return JSON.stringify({
                total: result.defs.length, returned: summary.length,
                defs: summary, sourceFile: result.sourceFile,
            }, null, 2);
        }

        case 'get_weapon_def': {
            const result = listDefsFromCache(args.gameId, 'weapondefs', decodeWeaponDef,
                d => (args.defId !== undefined ? d.defId === args.defId
                    : args.name !== undefined ? d.name === args.name
                    : false));
            if (!result) return `No weapondefs cache found for game "${args.gameId}".`;
            if (!result.defs.length) return `Weapon def not found (gameId=${args.gameId}, name=${args.name || '?'}, defId=${args.defId || '?'}).`;
            return JSON.stringify(result.defs[0], null, 2);
        }

        case 'clear_defs_cache': {
            const r = clearDefsCache(args.gameId);
            return `Removed ${r.removed} cache file(s)${args.gameId ? ` for game "${args.gameId}"` : ' across all games'}. The next game session will re-bake from source.`;
        }

        case 'kill_game': {
            // Deprecated alias. The old no-roomId branch SIGKILLed the first
            // non-ended server, which on a two-game box kills the wrong one.
            const out = await executeTool('end_game', { roomId: args.roomId, graceful: false });
            return typeof out === 'string' && out.startsWith('Error:')
                ? `${out}\n(Prefer end_game for a graceful stop.)`
                : out;
        }

        case 'end_game': {
            const timeoutMs = args.timeoutMs ?? 10000;
            const escalate = args.escalate !== false;

            // The MCP-local signal path: used for graceful:false (the kill_game
            // alias) and as the pre-P4-lobby fallback. It needs a local pid, so
            // it resolves strictly — a destructive verb never guesses a target.
            const bySignal = async (graceful) => {
                const servers = await getGameServers();
                const { target, error } = resolveRoomTargetStrict(servers, args.roomId);
                if (error) return { error };
                const r = await endProcess(target.pid, { graceful, timeoutMs, escalate });
                return { result: { roomId: target.room_id, pid: target.pid, ...r } };
            };

            if (args.graceful === false) {
                const { error, result } = await bySignal(false);
                if (error) return error;
                return JSON.stringify({
                    source: 'sigkill', ...result,
                    note: 'Lobby marks the room ended on its next health check.',
                }, null, 2);
            }

            if (!(args.roomId > 0)) {
                // Refuse-with-candidates before touching the network.
                const { error } = await bySignal(true);
                return error || 'Error: roomId is required.';
            }

            const resp = await authedFetch(token => fetch(`${LOBBY_URL}/api/admin/rooms/end`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ roomId: args.roomId, timeout_ms: timeoutMs, escalate }),
            }));
            const decision = classifyEndResponse(resp.status, await resp.text());
            if (decision.action === 'error') return `Error: ${decision.error}`;
            if (decision.action === 'report') {
                return JSON.stringify({
                    source: '/api/admin/rooms/end', ...decision.report,
                    note: 'The room flips to "ended" asynchronously via the lobby health loop, not in this response — poll /api/rooms or probe_game to observe it.',
                }, null, 2);
            }
            // Route-level 404 ⇒ a lobby binary older than P4 (this route has no
            // feature latch, unlike /api/rooms/direct).
            const { error, result } = await bySignal(true);
            if (error) return error;
            return JSON.stringify({
                source: 'sigterm-fallback',
                note: 'This lobby predates POST /api/admin/rooms/end — signalled locally, so no checkpoint verification or resume eligibility is available. The room flips to "ended" on the lobby\'s next health check.',
                ...result,
            }, null, 2);
        }

        case 'get_frame': {
            const server = await getGameServerUrl(args.roomId);
            if (!server) {
                const servers = await getGameServers();
                if (!servers.length) return 'No game servers found. Is the lobby running and is a game in progress?';
                return `No active game server found. Available: ${servers.map(s => `room ${s.room_id} (${s.state})`).join(', ')}`;
            }
            const m = await fetchMetrics(server.url);
            return JSON.stringify({
                roomId: server.room_id,
                frame: m.frame,
                simFps: m.simFps,
                clients: m.clients,
            }, null, 2);
        }

        case 'probe_game': {
            const roomId = await resolveWaitRoom(args.roomId);
            if (roomId.error) return roomId.error;
            return JSON.stringify(await probeGame(roomId.roomId), null, 2);
        }

        case 'wait_for_game': {
            const resolved = await resolveWaitRoom(args.roomId);
            if (resolved.error) return resolved.error;
            // Pinned for the whole wait: a died-and-relaunched *different* room
            // must never satisfy this wait.
            const roomId = resolved.roomId;
            const until = args.until || 'ready';
            if (until === 'frame' && !(args.frame > 0)) {
                return "Error: until='frame' requires a positive `frame` target.";
            }
            const timeoutMs = args.timeoutMs ?? 120000;
            const pollMs = args.pollMs ?? 500;
            const t0 = Date.now();
            const deadline = t0 + timeoutMs;
            let polls = 0;

            const finish = async (extra) => {
                const out = { roomId, until, waitedMs: Date.now() - t0, polls, ...extra };
                if (until === 'frame') out.targetFrame = args.frame;
                if (out.met === false) {
                    const tail = await roomLogTail(roomId);
                    out.lastLogs = tail.lines;
                    if (tail.note) out.logsNote = tail.note;
                }
                return JSON.stringify(out, null, 2);
            };

            for (;;) {
                const probe = await probeGame(roomId);
                polls++;
                if (probe.phase === 'dead') return finish({ met: false, probe });
                const met = until === 'frame'
                    ? (probe.frame != null && probe.frame >= args.frame)
                    : PHASE_ORDER[probe.phase] >= PHASE_ORDER[until];
                if (met) {
                    const out = { met: true, probe };
                    if (probe.clientCount === 0) {
                        out.warning = 'target reached with 0 clients — idle self-exit will kill this '
                            + 'server after the idle window unless a client connects or '
                            + 'idleStartupGraceSeconds was raised (server_main.cpp:2189-2198; '
                            + 'workaround: lobby env SPRING_IDLE_STARTUP_GRACE_SECONDS)';
                    }
                    return finish(out);
                }
                if (Date.now() >= deadline) return finish({ met: false, timedOut: true, probe });
                await new Promise(r => setTimeout(r, pollMs));
            }
        }

        case 'revive_team': {
            const cmd = args.team !== undefined ? `revive_team ${args.team}` : 'revive_team all';
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'set_stockpile': {
            const cmd = `stockpile ${args.unitId} ${args.count} ${args.queued ?? 0}`;
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'profile': {
            const action = args.action || 'report';
            // Both C++ parsers slice at offset 12 ("lua profile "/"sim profile "),
            // so the verb strings below are exactly what they expect.
            let cmd = `${args.target} profile`;
            if (action === 'report') {
                if (args.target === 'lua' && args.topN !== undefined) cmd += ` ${args.topN}`;
            } else {
                cmd += ` ${action}`;
            }
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'launch_game': {
            // Bypass the lobby UI: create a room, optionally add an AI,
            // mark host ready, fire start. Mirrors what the browser does
            // but doesn't require a real user clicking buttons.
            const username = args.username || AUTH_USER;
            const password = args.password || AUTH_PASS;

            // Authenticate as the requested user (separate from MCP's
            // long-lived admin session — startGame requires the host).
            // Login first, register as the fallback for a username that
            // doesn't exist yet (fresh DB, or a caller-supplied `username`).
            let userToken = '';
            let authError = '';
            try {
                const r = await fetch(`${LOBBY_URL}/api/auth/login`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password }),
                });
                const text = await r.text();
                if (r.ok) {
                    try { userToken = JSON.parse(text).token || ''; } catch { /* not JSON */ }
                }
                if (!userToken) authError = `login ${r.status}: ${text}`;
            } catch (e) {
                authError = `login request failed: ${e.message}`;
            }
            if (!userToken) {
                const reg = await registerAccount(username, password);
                if (reg.ok) userToken = reg.token;
                else authError += `; ${reg.error}`;
            }
            // Report the server's own message — a bare "auth failed" hid a
            // 400 "faction is required" for the whole of task 0.
            if (!userToken) return `Auth failed for user "${username}" — ${authError}`;

            const authHdr = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userToken}` };

            if (args.clearCache) clearDefsCache(args.gameId || 'zk');

            // Leave any existing room so /api/rooms succeeds (the user
            // can only be in one at a time).
            await fetch(`${LOBBY_URL}/api/rooms/leave`, { method: 'POST', headers: authHdr, body: '{}' }).catch(() => {});

            // Create the room.
            const createResp = await fetch(`${LOBBY_URL}/api/rooms`, {
                method: 'POST', headers: authHdr,
                body: JSON.stringify({
                    name: args.roomName || 'debug',
                    map: args.mapId,
                    game: args.gameId || 'zk',
                }),
            });
            if (!createResp.ok) return `Create room failed (${createResp.status}): ${await createResp.text()}`;
            const room = await createResp.json();

            // Add AI on team 1 (host is on team 0). The lobby reads
            // `ai_id` (snake_case) — sending `aiId` was a silent no-op
            // and the host ended up alone, which trips ZK's "no opposing
            // ally" check inside the first 1.5s of game time.
            if (args.ai !== '' && args.ai !== undefined) {
                const aiId = args.ai || 'null';
                const r = await fetch(`${LOBBY_URL}/api/rooms/ai/add`, {
                    method: 'POST', headers: authHdr,
                    body: JSON.stringify({ ai_id: aiId, team: 1, name: aiId }),
                });
                if (!r.ok) {
                    const txt = await r.text().catch(() => '');
                    return `AI add failed (${r.status}): ${txt}`;
                }
            }

            // Mark host ready then start.
            await fetch(`${LOBBY_URL}/api/rooms/ready`, {
                method: 'POST', headers: authHdr,
                body: JSON.stringify({ roomId: room.id, ready: true }),
            });
            const startResp = await fetch(`${LOBBY_URL}/api/rooms/start`, {
                method: 'POST', headers: authHdr,
                body: JSON.stringify({ roomId: room.id }),
            });
            if (!startResp.ok) return `Start game failed (${startResp.status}): ${await startResp.text()}`;
            const started = await startResp.json();

            // Wait for the game server to actually be accepting connections
            // before returning. Without this, callers drove the browser into a
            // not-yet-listening QUIC port and hit the connect-race / 90s defs
            // timeout. ZK cold-start is slow, so poll up to ~120s.
            //
            // probeGame rather than the lobby's room list: the room's
            // Loading→Active flip is *derived from* game_status.ready, so
            // probing the source drops a lag hop — and the old loop treated a
            // vanished room (server died on boot) as "keep waiting" for the
            // full 120s, where probeGame reports 'dead' on the first poll.
            const targetRoomId = started.id || room.id;
            let probe = await probeGame(targetRoomId);
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline && probe.phase !== 'dead'
                   && probe.phase !== 'ready' && probe.phase !== 'ticking') {
                await new Promise((r) => setTimeout(r, 500));
                probe = await probeGame(targetRoomId);
            }
            const ready = probe.phase === 'ready' || probe.phase === 'ticking';
            // `state` keeps its old meaning for existing callers (4 = Active);
            // `phase` is the honest value.
            const finalState = ready ? 4 : started.state;

            // Suggested browser URL. Unless the caller is specifically
            // testing the startup commander-chooser, disable it so the view
            // is clear on launch (the client reads ?disableWidgets=).
            const disable = args.testStartupSelector ? '' :
                `?disableWidgets=${encodeURIComponent(STARTUP_SELECTOR_WIDGET)}`;
            const browserUrl = `${CLIENT_URL}/${disable}`;

            const out = {
                roomId: targetRoomId,
                gameServerPort: started.gameServerPort,
                gameId: args.gameId || 'zk',
                mapId: args.mapId,
                state: finalState,
                ready,
                phase: probe.phase,
                hint: ready
                    ? 'Game server is accepting connections (room Active). Open browserUrl to view — it disables the ZK commander-selector overlay (pass testStartupSelector=true to keep it).'
                    : probe.phase === 'dead'
                        ? `ERROR: the game server died during boot (${probe.detail}) — see lastLogs.`
                        : `WARNING: game server was still in phase '${probe.phase}' after 120s (${probe.detail}) — still warming or wedged. See lastLogs / probe_game.`,
                browserUrl,
            };
            if (!ready) {
                const tail = await roomLogTail(targetRoomId);
                out.lastLogs = tail.lines;
                if (tail.note) out.logsNote = tail.note;
            }
            return JSON.stringify(out, null, 2);
        }

        case 'launch_scenario': {
            // One call from nothing to a running scenario: resolve → build the
            // manifest in memory → POST /api/rooms/direct → wait on probeGame.
            // No lobby UI, no manifest file on disk, no login.
            const gameId = args.gameId || 'metalstorm';
            const notes = [];

            // 1. Resolve against the lobby's scenario list (public route).
            //    The list is the lobby's *startup snapshot*, so a freshly
            //    authored file is invisible here until a resync — hence the
            //    two escapes named in the failure text.
            let scenario = null;
            let list = [];
            try {
                const lr = await fetch(`${LOBBY_URL}/api/games/${encodeURIComponent(gameId)}/scenarios`);
                if (lr.ok) list = await lr.json();
            } catch { /* lobby down — reported by the direct POST below */ }
            if (Array.isArray(list)) scenario = list.find(s => s.id === args.scenarioId) ?? null;
            if (!scenario && !args.force) {
                const avail = (Array.isArray(list) ? list : []).map(s =>
                    s.id + (s.retired ? ' (retired)' : s.tutorial ? ' (tutorial)' : '')).join(', ');
                return `Scenario "${args.scenarioId}" is not in the lobby's list for game "${gameId}". `
                     + `Available: ${avail || '(none — is the lobby up?)'}. `
                     + 'New files need POST /api/admin/scenarios/resync (lobby scenario lists are a '
                     + 'startup snapshot; the direct-boot path itself reads the VFS fresh), '
                     + 'or pass force:true (+ mapId) to launch blind.';
            }
            if (scenario?.retired) notes.push(`scenario "${scenario.id}" is retired — loadable, but the lobby will not offer it in room lists.`);
            if (scenario?.tutorial) notes.push(`scenario "${scenario.id}" is a tutorial — loadable, but not offered as a normal war.`);

            // 2. Build the manifest (pure; throws with a caller-facing message).
            let manifest;
            try {
                const built = buildScenarioManifest({
                    scenario,
                    scenarioId: args.scenarioId,
                    gameId,
                    mapId: args.mapId,
                    players: args.players || [{ username: AUTH_USER }],
                    side: args.side,
                    ai: args.ai === undefined ? 'null' : args.ai,
                    modoptions: args.modoptions,
                    roomName: args.roomName || `mcp:${args.scenarioId}`,
                    idleGraceSeconds: args.idleGraceSeconds,
                });
                manifest = built.manifest;
                notes.push(...built.notes);
            } catch (e) {
                return `Error: ${e.message}`;
            }
            if (args.headless || args.wait === 'none') {
                notes.push('no browser will attach: the game server self-exits after its startup idle grace '
                         + `(default 120s)${typeof args.idleGraceSeconds === 'number' ? '' : ' — pass idleGraceSeconds to extend it'}. `
                         + 'A lobby binary older than P3 ignores the manifest field silently; there, run the '
                         + 'lobby with SPRING_IDLE_STARTUP_GRACE_SECONDS=3600 in its env instead.');
            }
            if (LOBBY_URL !== 'http://localhost:8011') {
                notes.push(`LOBBY_URL is ${LOBBY_URL} but the client at ${CLIENT_URL} bakes its lobby port at BUILD time `
                         + '— browserUrl may drive a different stack than the one just launched.');
            }

            // 3. POST authed even on loopback (the route skips token checks for
            //    a loopback caller): it costs nothing, names the caller in the
            //    lobby audit row, and keeps the tool working against a remote
            //    lobby where an admin Bearer token is mandatory.
            const posted = await postDirectManifest(manifest);
            if (!posted.ok) return `Error: ${posted.error}`;
            const room = posted.room;

            // 4. Wait on probeGame (never the room-state loop: state>=4 is
            //    known-unreliable, and a dead server must fail fast).
            const roomId = room.id;
            let probe = { phase: 'unknown', frame: null, detail: 'wait:none' };
            let timedOut = false;
            if (args.wait !== 'none') {
                const want = args.wait || 'ticking';
                probe = await waitForPhase(roomId, want, args.waitTimeoutMs ?? 120000);
                timedOut = probe.timedOut;
                if (probe.phase === 'dead') {
                    notes.push(`ERROR: the game server died during boot (${probe.detail}) — see lastLogs.`);
                } else if (timedOut) {
                    notes.push(`WARNING: still in phase '${probe.phase}' after the wait timeout (${probe.detail}).`);
                    if (want === 'ticking' && probe.phase === 'ready' && probe.clientCount === 0) {
                        notes.push('the sim holds at frame -1 until a client connects — with no browser attached, '
                                 + "wait:'ready' is the reachable target (open browserUrl, then wait_for_game until:'ticking').");
                    }
                }
            }

            // 5. Attach-form browser URL (never a bare ?play=, which would
            //    re-POST the same room name and tear down the server we just
            //    launched and waited on). Token rides the hash fragment.
            const host = manifest.players[0].username;
            const hostToken = room.sessions?.[host] ?? '';
            const browserUrl = args.headless ? undefined
                : `${CLIENT_URL}/?play=${encodeURIComponent(args.scenarioId)}&game=${encodeURIComponent(gameId)}`
                  + `&room=${roomId}&user=${encodeURIComponent(host)}`
                  + (args.skipBriefing === false ? '' : '&skipBriefing=1')
                  + `#token=${encodeURIComponent(hostToken)}`;

            const out = {
                roomId,
                port: room.game_server_port,
                roomName: manifest.name,
                sessions: room.sessions,
                browserUrl,
                scenario: scenario && {
                    id: scenario.id, map: scenario.map,
                    sides: scenario.sides, terminal: scenario.terminal,
                },
                phase: probe.phase,
                frame: probe.frame,
                notes,
            };
            if (probe.phase === 'dead' || timedOut) {
                const tail = await roomLogTail(roomId);
                out.lastLogs = tail.lines;
                if (tail.note) out.logsNote = tail.note;
            }
            return out;
        }

        case 'launch_direct': {
            // The raw-manifest sibling of launch_scenario: no scenario
            // resolution, no manifest synthesis — the caller owns every field.
            if (!args.manifestName && !args.manifest) {
                const avail = listManifestNames().join(', ');
                return 'Error: pass manifestName and/or manifest. Available manifestName values: '
                     + (avail || '(none — is PROJECT_ROOT set?)');
            }
            let fileManifest = null;
            try {
                if (args.manifestName) fileManifest = loadManifestByName(args.manifestName);
            } catch (e) {
                return `Error: ${e.message}`;
            }
            const built = buildDirectManifest({
                fileManifest,
                manifest: args.manifest,
                overrides: args.overrides,
                idleGraceSeconds: args.idleGraceSeconds,
            });
            if (built.error) return `Error: ${built.error}`;
            const manifest = built.manifest;
            const notes = [...built.notes];
            if (args.clearCache) clearDefsCache(manifest.game || 'metalstorm');

            const posted = await postDirectManifest(manifest);
            if (!posted.ok) return `Error: ${posted.error}`;
            const room = posted.room;
            const roomId = room.id;

            let probe = { phase: 'unknown', frame: null, detail: 'wait:none', timedOut: false };
            const wait = args.wait || 'ticking';
            if (wait !== 'none') {
                probe = await waitForPhase(roomId, wait, args.timeoutMs ?? 120000);
                if (probe.phase === 'dead') {
                    notes.push(`ERROR: the game server died during boot (${probe.detail}) — see lastLogs.`);
                } else if (probe.timedOut) {
                    notes.push(`WARNING: still in phase '${probe.phase}' after the wait timeout (${probe.detail}).`);
                    if (wait === 'ticking' && probe.phase === 'ready' && probe.clientCount === 0) {
                        notes.push('a skirmish holds the sim at frame -1 until its rostered humans connect — '
                                 + "with no browser attached, wait:'ready' is the reachable target.");
                    }
                }
            }

            const out = {
                roomId,
                port: room.game_server_port,
                roomName: manifest.name || 'dev:direct',
                sessions: room.sessions,
                players: room.players,
                aiSlots: room.ai_slots,
                // Deliberately NOT the ?direct=<name> form: that boot re-POSTs
                // the manifest from client/public/ and would tear down the very
                // room this call just launched. Log in as any `sessions` user.
                browserUrl: `${CLIENT_URL}/`,
                browserHint: 'log in as any username in `sessions` (these are live dev session tokens), '
                           + 'or use launch_scenario for a one-URL ?play= attach.',
                phase: probe.phase,
                frame: probe.frame,
                notes,
            };
            if (probe.phase === 'dead' || probe.timedOut) {
                const tail = await roomLogTail(roomId);
                out.lastLogs = tail.lines;
                if (tail.note) out.logsNote = tail.note;
            }
            return out;
        }

        case 'api_request': {
            const target = args.target || 'lobby';
            let url;
            if (target === 'url') {
                if (!args.url) return 'Error: target="url" requires `url`.';
                url = args.url;
            } else if (target === 'lobby') {
                url = `${LOBBY_URL}${args.path}`;
            } else if (target === 'log') {
                url = `${LOG_SERVER_URL}${args.path}`;
            } else if (target === 'game') {
                const server = await getGameServerUrl(args.roomId);
                if (!server) {
                    const servers = await getGameServers();
                    if (!servers.length) return 'Error: no game servers found. Is a game running?';
                    return `Error: no active game server. Available: ${servers.map(s => `room ${s.room_id} (${s.state})`).join(', ')}`;
                }
                url = `${server.url}${args.path}`;
            } else {
                return `Error: unknown target "${target}".`;
            }

            const method = (args.method || 'GET').toUpperCase();
            const headers = { ...(args.headers || {}) };
            const wantAuth = args.auth !== false;

            let body;
            if (args.body !== undefined && method !== 'GET' && method !== 'DELETE') {
                if (typeof args.body === 'string') {
                    body = args.body;
                } else {
                    body = JSON.stringify(args.body);
                    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
                }
            }

            // Authed requests re-auth once on a 401 via authedFetch; unauthed
            // probes go straight through.
            const doFetch = token => fetch(url, {
                method,
                headers: token ? { ...headers, 'Authorization': `Bearer ${token}` } : headers,
                body,
            });
            const resp = wantAuth ? await authedFetch(doFetch) : await doFetch('');
            const text = await resp.text();
            const expectJson = args.expectJson !== false;
            let parsed = text;
            if (expectJson && text) {
                try { parsed = JSON.parse(text); } catch { /* keep as text */ }
            }
            return JSON.stringify({
                status: resp.status,
                ok: resp.ok,
                url,
                body: parsed,
            }, null, 2);
        }

        case 'spawn_unit': {
            const cmd = `spawn ${args.defName} ${args.x} ${args.z} ${args.team ?? 0} ${args.count ?? 1}`;
            const j = await execJsonVerb(cmd, args.roomId);
            if (j.json) {
                if (j.json.error) return `Error: ${j.json.error}`;
                return j.json;
            }
            // spawn runs through LuaRules, so a non-JSON reply from the json
            // path is an error string ("error: LuaRules not loaded", a Lua
            // syntax/runtime error), NOT old-binary fallback.
            if (j.legacy) return `Error: ${j.legacy}`;
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'kill_unit': {
            const cmd = `kill ${args.unitId} ${args.selfDestruct ? 1 : 0} ${args.reclaimed ? 1 : 0}`;
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'damage_unit': {
            const cmd = `damage ${args.unitId} ${args.amount} ${args.paralyze ? 1 : 0}`;
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'give_order': {
            const params = (args.params || []).join(' ');
            const cmd = `order ${args.unitId} ${args.cmdId} ${params} ${args.opts ?? 0}`.replace(/\s+/g, ' ').trim();
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'clear_units': {
            const cmd = args.team !== undefined ? `clear ${args.team}` : 'clear';
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'get_unit_state': {
            const j = await execJsonVerb(`unit_state ${args.unitId}`, args.roomId);
            if (j.json) {
                if (j.json.error) return `Error: ${j.json.error}`;
                return j.json;
            }
            if (j.legacy) return j.legacy;
            const r = await execOnGameServer('server', `unit_state ${args.unitId}`, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'set_debug_logging': {
            const subsystems = ['combat', 'sound', 'weapon', 'explosion', 'order', 'unit', 'script'];
            for (const s of subsystems) {
                if (args[s] === undefined) continue;
                await execOnGameServer('server', `log ${s} ${args[s] ? 'on' : 'off'}`, args.roomId);
            }
            const r = await execOnGameServer('server', 'log status', args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'get_combat_summary': {
            const j = await execJsonVerb('combat_summary', args.roomId);
            if (j.json) {
                if (j.json.error) return `Error: ${j.json.error}`;
                return j.json;
            }
            if (j.legacy) return j.legacy;
            const r = await execOnGameServer('server', 'combat_summary', args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'pause_sim': {
            const r = await execOnGameServer('server', args.paused ? 'pause' : 'unpause', args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'set_sim_speed': {
            const r = await execOnGameServer('server', `speed ${args.multiplier}`, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'set_los': {
            const verb = args.enable === undefined ? 'los status'
                       : args.enable ? 'los on' : 'los off';
            const r = await execOnGameServer('server', verb, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'set_cheats': {
            const verb = args.enable === undefined ? 'cheats status'
                       : args.enable ? 'cheats on' : 'cheats off';
            const r = await execOnGameServer('server', verb, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'set_unit_invulnerable': {
            if (!args.unitId) return 'Error: unitId is required';
            const tail = args.invulnerable === undefined ? 'status'
                       : args.invulnerable ? 'on' : 'off';
            const r = await execOnGameServer('server', `invulnerable ${args.unitId} ${tail}`, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'spawn_at_camera': {
            // The camera lives in the browser; emit the chrome-devtools
            // snippet the caller pastes into mcp__chrome-devtools__evaluate_script.
            // The harness `window.test.cameraPose()` returns {pos, lookAt} of {x,y,z}.
            const defName = JSON.stringify(args.defName);
            const team    = Number(args.team ?? 0);
            const count   = Math.max(1, Math.min(256, Number(args.count ?? 1)));
            const ox      = Number(args.offset?.x ?? 0);
            const oz      = Number(args.offset?.z ?? 0);
            const snippet =
                `(async () => {`
                + ` const p = window.test.cameraPose().lookAt;`
                + ` const x = p.x + ${ox}, z = p.z + ${oz};`
                + ` const out = await window.test.spawn(${defName}, x, z, ${team}, ${count});`
                + ` return { x, z, response: out };`
                + ` })()`;
            // P7: relay ONLY the camera read, then spawn from here over
            // /api/exec. Relaying the whole snippet would deadlock — the
            // browser's `window.test.spawn` posts back to the same game
            // server whose single HTTP thread is parked on this very request
            // (see SERVER_BOUND_HARNESS_METHODS). Reading the pose touches
            // nothing but the browser's cached scene state.
            const relayed = await clientEval('test', 'cameraPose()', args.roomId, args.clientId);
            if (!relayed.fallback) {
                if (!relayed.success) return `Error (client ${relayed.clientId}): ${relayed.output}`;
                const pose = clientEvalValue(relayed.output);
                if (!pose || !pose.lookAt) return `Unexpected cameraPose reply: ${String(relayed.output).slice(0, 200)}`;
                const x = pose.lookAt.x + ox, z = pose.lookAt.z + oz;
                const spawned = await execOnGameServer(
                    'server', `spawn ${args.defName} ${x} ${z} ${team} ${count}`, args.roomId);
                return { x, z, clientId: relayed.clientId,
                         response: spawned.success ? spawned.output : `Error: ${spawned.output}` };
            }
            return [
                `Relay unavailable (${relayed.fallback}) — paste this into mcp__chrome-devtools__evaluate_script:`,
                ``,
                `  ${snippet}`,
                ``,
                `Requires a game tab open at the client URL with a game in progress.`,
                `Returns the camera lookAt (x, z) it used and the spawn response.`,
            ].join('\n');
        }

        case 'browser_test': {
            // The TestHarness lives in the browser. Build the eval string
            // for the user (or Claude) to feed into chrome-devtools.
            const fmt = (v) => {
                if (typeof v === 'string') return JSON.stringify(v);
                if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return JSON.stringify(v);
                return String(v);
            };
            const argList = (args.args || []).map(fmt).join(', ');
            const snippet = `(async () => { const r = await window.test.${args.method}(${argList}); return r === undefined ? 'ok' : r; })()`;
            // P7: refuse the server-bound methods rather than eating a 10s
            // deadlock (see SERVER_BOUND_HARNESS_METHODS).
            const serverSide = SERVER_BOUND_HARNESS_METHODS.get(args.method);
            if (serverSide) {
                return `\`window.test.${args.method}()\` calls back into the game server's own HTTP API. `
                    + `Relaying it would deadlock: the server serves HTTP on one thread, and that thread `
                    + `is parked waiting for this browser. Use the \`${serverSide}\` MCP tool instead `
                    + `(no browser needed), or paste this into mcp__chrome-devtools__evaluate_script:\n\n  ${snippet}`;
            }
            // Relay the harness call to the connected admin browser. The
            // 'test' target evaluates an expression with the harness's members
            // in scope, so it takes the method call without the window.* wrapper.
            const relayed = await clientEval(
                'test', `${args.method}(${argList})`, args.roomId, args.clientId);
            if (!relayed.fallback) {
                if (!relayed.success) return `Error (client ${relayed.clientId}): ${relayed.output}`;
                const v = clientEvalValue(relayed.output);
                return v === undefined || v === null ? 'ok' : v;
            }
            return [
                `Relay unavailable (${relayed.fallback}) — feed this into mcp__chrome-devtools__evaluate_script:`,
                ``,
                `  ${snippet}`,
                ``,
                `Requires a game tab open at the client URL with a game in progress (window.test only exists after startGame()).`,
            ].join('\n');
        }

        case 'evaluate_widget_lua': {
            // The widget worker lives in the browser, not the game
            // server. Speak to it through the chrome-devtools-mcp's CDP
            // bridge by spawning a one-shot evaluator. We assume the
            // user already has a tab open at the client URL — if not,
            // they should use chrome-devtools-mcp directly.
            //
            // Implementation note: this is best-effort. The proper
            // alternative is launching our own CDP client and managing
            // the lifecycle, but for the common case (a Claude session
            // already has chrome-devtools attached) we just emit a
            // helpful instruction telling the caller to use it.
            // P7: the LuaUI runtime lives in the browser's render worker, so
            // this goes over the relay (`widgets` target → window.widgets.eval).
            // The printed snippet below is the fallback for when no admin
            // browser is connected or the relay is compiled out.
            const relayed = await clientEval('widgets', args.code, args.roomId, args.clientId);
            if (!relayed.fallback) {
                return relayed.success
                    ? relayed.output
                    : `Error (client ${relayed.clientId}): ${relayed.output}`;
            }
            return [
                `Relay unavailable (${relayed.fallback}): the LuaUI runtime is in the browser, not on the game server.`,
                'Use `mcp__chrome-devtools__evaluate_script` instead with the snippet:',
                '',
                '  () => window.widgets.eval(`' + args.code.replace(/`/g, '\\`') + '`)',
                '',
                'A DEV client connected as the `admin` account is relayed automatically;',
                'a /api/rooms/direct dev session is role "player" and is never eligible.',
            ].join('\n');
        }

        // --- Browser-eval relay (P7) -----------------------------------

        case 'client_eval': {
            if (!args.code) return 'Error: client_eval needs `code`.';
            const target = args.target || 'js';
            if (!['js', 'worker', 'widgets', 'test'].includes(target))
                return `Error: target must be js | worker | widgets | test (got ${target}).`;
            const r = await clientEval(target, args.code, args.roomId, args.clientId, args.timeoutMs);
            if (r.fallback) return `Relay unavailable: ${r.fallback}`;
            return { success: r.success, clientId: r.clientId, output: clientEvalValue(r.output) };
        }

        case 'client_ready': {
            const r = await clientEval('test', 'readyState()', args.roomId, args.clientId);
            if (r.fallback)
                return `Relay unavailable: ${r.fallback}. For SERVER-side readiness use \`wait_for_game\` instead.`;
            if (!r.success) return `Error (client ${r.clientId}): ${r.output}`;
            return { clientId: r.clientId, ...(clientEvalValue(r.output) ?? {}) };
        }

        case 'client_screenshot': {
            const maxDim = Math.max(64, Math.min(2048, Number(args.maxDim ?? 1280)));
            const opts = { maxDim, stats: true };
            if (args.quality !== undefined) opts.quality = Number(args.quality);
            const r = await clientEval(
                'test', `captureFrame(${JSON.stringify(opts)})`,
                args.roomId, args.clientId, /*timeoutMs=*/20000);
            if (r.fallback) return `Relay unavailable: ${r.fallback}`;
            if (!r.success) return `Error (client ${r.clientId}): ${r.output}`;
            const shot = clientEvalValue(r.output);
            if (!shot || typeof shot !== 'object' || !shot.dataUrl)
                return `Unexpected captureFrame reply: ${String(r.output).slice(0, 400)}`;
            // `data:image/jpeg;base64,AAAA…` → mime + payload. MCP image blocks
            // carry the base64 WITHOUT the data: prefix.
            const m = /^data:([^;]+);base64,(.*)$/s.exec(shot.dataUrl);
            if (!m) return `captureFrame returned a non-data-URL image (${shot.dataUrl.slice(0, 60)}…)`;
            const meta = {
                clientId: r.clientId,
                width: shot.width, height: shot.height,
                frameId: shot.frameId, gameFrame: shot.gameFrame,
                stats: shot.stats,
                bytes: Math.round(m[2].length * 3 / 4),
            };
            return {
                content: [
                    { type: 'image', data: m[2], mimeType: m[1] },
                    { type: 'text', text: JSON.stringify(meta, null, 2) },
                ],
            };
        }

        // --- Scenario authoring (S3) -----------------------------------

        case 'validate_scenario': {
            if (!args.scenarioId && args.luaSource === undefined)
                return 'Error: validate_scenario needs either scenarioId (read from disk) or luaSource (validate text directly).';
            const result = await runScenarioValidation({
                projectRoot: projectRoot(),
                gameId: args.gameId || 'metalstorm',
                scenarioId: args.scenarioId,
                luaSource: args.luaSource,
                passability: args.passability === true,
            });
            return JSON.stringify(result, null, 2);
        }

        case 'list_scenarios': {
            const gameId = args.gameId || 'metalstorm';
            const notes = [];

            let discovered = [];
            try {
                const r = await fetch(`${LOBBY_URL}/api/games/${encodeURIComponent(gameId)}/scenarios`);
                if (!r.ok) return `Error: lobby answered ${r.status} for /api/games/${gameId}/scenarios.`;
                discovered = await r.json();
            } catch (e) {
                return `Error: lobby at ${LOBBY_URL} unreachable (${e.message}). `
                     + 'validate_scenario works offline; this tool does not.';
            }

            // Provenance half. A non-admin token loses it and nothing else —
            // the discovery view is the part an author actually needs.
            let stored = [];
            try {
                const r = await authedFetch(token => fetch(`${LOBBY_URL}/api/admin/scenarios/list`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ gameId }),
                }));
                if (r.ok) stored = (await r.json()).scenarios || [];
                else notes.push(`admin list refused (${r.status}) — generated rows carry no provenance below.`);
            } catch (e) {
                notes.push(`admin list unavailable (${e.message}) — generated rows carry no provenance below.`);
            }

            const byId = new Map(stored.map(s => [s.id, s]));
            const rows = discovered.map(s => {
                const row = { ...s, source: byId.has(s.id) || s.id.startsWith('gen_') ? 'generated' : 'authored' };
                const p = byId.get(s.id);
                if (p) row.provenance = {
                    seed: p.seed, params: p.params, generatorVersion: p.generatorVersion,
                    createdBy: p.createdBy, createdAt: p.createdAt, bytes: p.bytes,
                };
                return row;
            });
            // A stored row the lobby did NOT discover is the interesting case:
            // the file failed to parse, or the sweep removed it.
            for (const p of stored) {
                if (discovered.some(d => d.id === p.id)) continue;
                rows.push({ id: p.id, source: 'generated', discovered: false, provenance: p });
                notes.push(`"${p.id}" has a DB row but the lobby did not discover it — the materialised file `
                         + 'failed to parse or is missing. Try resync (write_scenario does one) and validate_scenario.');
            }

            return JSON.stringify({ gameId, count: rows.length, scenarios: rows, notes }, null, 2);
        }

        case 'write_scenario': {
            const gameId = args.gameId || 'metalstorm';
            const id = String(args.scenarioId || '');
            const notes = [];

            // Two guards on the same trap, on purpose: ScenarioDb owns the
            // gen_ namespace and SyncToDisk's orphan sweep deletes any
            // gen_*.lua no row claims, so an authored file with that name is
            // deleted on the next resync — including the one this tool does.
            if (id.startsWith('gen_'))
                return `Error: "${id}" — the gen_ prefix is reserved for DB-owned generated wars. `
                     + 'The scenario DB\'s orphan sweep deletes any gen_*.lua no row claims, so this file '
                     + 'would be silently removed on the next resync. Use generate_scenario to make one, or '
                     + 'pick a name without the prefix.';
            if (!/^[a-z0-9_]+$/.test(id) || id.length > 64)
                return `Error: "${id}" is not a valid scenario id. Grammar: ^[a-z0-9_]+$ (lowercase, digits, `
                     + 'underscore), max 64 chars — it becomes both a filename and the `scenario` modoption.';

            const root = projectRoot();
            const file = scenarioPath(root, gameId, id);
            const dir = dirname(file);
            if (!existsSync(dir))
                return `Error: ${dir} does not exist — is "${gameId}" a game this checkout ships?`;
            if (existsSync(file) && !args.overwrite)
                return `Error: ${file} already exists. Pass overwrite:true to replace it.`;

            const validation = await runScenarioValidation({
                projectRoot: root, gameId, scenarioId: id, luaSource: args.luaSource,
            });
            const blocking = validation.findings.filter(f =>
                f.severity === 'error' || (f.severity === 'warning' && !args.force));
            if (blocking.length)
                return JSON.stringify({
                    written: false,
                    reason: validation.counts.error > 0
                        ? 'validation errors — fix them (errors are never bypassable)'
                        : 'validation warnings — pass force:true to write anyway',
                    counts: validation.counts,
                    findings: validation.findings,
                }, null, 2);

            // Temp-file + rename, same rationale as ScenarioDb::Materialise:
            // the lobby may be mid-Discover, and a half-written file reads as
            // a parse failure and drops the scenario from the picker.
            const tmp = `${file}.tmp-${process.pid}`;
            try {
                writeFileSync(tmp, args.luaSource, 'utf8');
                renameSync(tmp, file);
            } catch (e) {
                try { unlinkSync(tmp); } catch { /* nothing to clean */ }
                return `Error writing ${file}: ${e.message}`;
            }

            const out = {
                written: true, file, scenarioId: id, gameId,
                counts: validation.counts, findings: validation.findings,
            };

            if (args.resync === false) {
                notes.push('resync skipped — the lobby picker and launch_scenario will not see this file until '
                         + 'a POST /api/admin/scenarios/resync or a lobby restart. Direct and headless boots '
                         + 'read the VFS fresh, so those work now.');
                out.notes = notes;
                return JSON.stringify(out, null, 2);
            }

            try {
                const r = await authedFetch(token => fetch(`${LOBBY_URL}/api/admin/scenarios/resync`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ gameId }),
                }));
                out.resync = r.ok ? await r.json() : `refused (${r.status})`;
            } catch (e) {
                out.resync = `unreachable — ${e.message}`;
                notes.push('the lobby is down, so the file is written but not discovered. Direct/headless boots '
                         + 'read the VFS fresh; the picker sees it on the next lobby start or manual resync.');
            }

            // Confirm rather than assume: writing a file the lobby then
            // declines to offer is exactly the silent failure this tool is for.
            try {
                const r = await fetch(`${LOBBY_URL}/api/games/${encodeURIComponent(gameId)}/scenarios`);
                if (r.ok) {
                    const list = await r.json();
                    out.offered = Array.isArray(list) && list.some(s => s.id === id);
                    if (!out.offered)
                        notes.push('the resync ran but the lobby still does not offer this scenario — run '
                                 + 'validate_scenario and check the lobby log for its "not offered" warning.');
                }
            } catch { /* already reported by the resync branch */ }

            if (notes.length) out.notes = notes;
            return JSON.stringify(out, null, 2);
        }

        case 'generate_scenario': {
            const gameId = args.gameId || 'metalstorm';
            if (!args.mapId) return 'Error: generate_scenario needs a mapId.';
            const body = { gameId, mapId: args.mapId };
            for (const k of ['seed', 'sides', 'towns', 'outposts', 'bases', 'mines',
                             'sites', 'relics', 'wrecks', 'bridges', 'hostility', 'roster'])
                if (args[k] !== undefined) body[k] = args[k];

            let r;
            try {
                r = await authedFetch(token => fetch(`${LOBBY_URL}/api/admin/scenarios/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify(body),
                }));
            } catch (e) {
                return `Error: lobby at ${LOBBY_URL} unreachable (${e.message}).`;
            }
            const text = await r.text();
            let payload;
            try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
            if (!r.ok)
                // 422 carries the generator's own REJECTED line, which names
                // the violated invariant — strictly more useful than a summary.
                return JSON.stringify({ ok: false, status: r.status, ...payload }, null, 2);
            return JSON.stringify(payload, null, 2);
        }

        default:
            return `Unknown tool: ${name}`;
    }
}

function formatLogEntries(entries) {
    if (!entries.length) return 'No log entries found.';
    const LEVELS = ['DEBUG', 'INFO', 'NOTICE', 'WARN', 'ERROR', 'FATAL'];
    return entries.map(e => {
        const level = LEVELS[e.level] || '???';
        const frame = e.frame > 0 ? `[${e.frame}] ` : '';
        const scope = e.scope ? `:${e.scope}` : '';
        const room = e.room_id ? `[room ${e.room_id}] ` : '';
        return `${room}${frame}[${level}] [${e.process}:${e.section}${scope}] ${e.message}`;
    }).join('\n');
}

// --- MCP server setup ---
const server = new Server(
    { name: 'spring-debug', version: '1.0.0' },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        const result = await executeTool(name, args || {});
        // A tool that builds its own MCP content blocks (image + text —
        // `client_screenshot`, P7) hands them back whole; everything else is
        // still wrapped as a single text block.
        if (result && typeof result === 'object' && Array.isArray(result.content)) return result;
        return {
            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
        };
    } catch (error) {
        return {
            content: [{ type: 'text', text: `Error: ${error.message}` }],
            isError: true,
        };
    }
});

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
