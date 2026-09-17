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
import { validateToolArgs } from './tool-args.js';
import { TOOLS } from './tools.js';
import { pickServer, listCandidates } from './room-target.js';
import { buildVerb } from './verb-args.js';
import { redactSessions } from './redact.js';
import { worldHandlers } from './world-tools.js';
import { aiHandlers } from './ai-tools.js';
import { nlHandlers } from './nl-tools.js';
import {
    BrowserRegistry, launchBrowser, closeBrowser, describeClose, defaultIsAlive,
} from './browser.js';
import {
    DEFAULT_RELAY_TIMEOUT_MS, buildHarnessCall, describePlan, formatCaptureMeta,
    parseLosStatus, parseSpawnIds, planCapture, validateCaptureArgs,
} from './capture-subject.js';
import { generateWaypoints, PATTERNS } from './drive-pattern.js';
import { buildTrancheLua, trancheUnitCount } from './tranche.js';
import {
    GAME_SPEED, MAX_STEP_FRAMES,
    buildSequenceHarnessCall, describeSequencePlan, extForMime, formatSequenceMeta,
    frameFileName, motionOnset, planSequence, realtimeBudgetError, sanitiseName,
    sequenceRelayTimeoutMs, stepTimeoutMs, summariseShots, totalTurnDegrees,
    validateSequenceArgs,
} from './capture-sequence.js';
import {
    classifyBindingError, bindingMismatchReason, bindingMismatchBanner,
    probeSqliteAnnotations, dbDivergenceWarning,
} from './sqlite-health.js';
import {
    STACK_PATTERNS, STACK_PORTS, STATUS_STALE_SEC,
    parsePsOutput, parseLsofF, resolveMprocsAddr, classifyBinaries, classifyStack,
    planCleanup, summarize, isStackPort, CLEANABLE_KINDS, parseLobbyDbFlag,
} from './stack-census.js';
import { resolve, join, dirname } from 'path';
import {
    readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync,
    rmdirSync, statSync, mkdirSync,
} from 'fs';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// --- Every network call has a deadline -------------------------------------
//
// A lobby that accepts the TCP connection and never answers (wedged HTTP loop,
// a paused debugger, a half-dead process) used to hang the MCP handler for
// ever: login, /api/processes, the log server, exec — none of them carried a
// signal. This module-level `fetch` shadows the global and stamps a default
// AbortSignal on any call that did not bring its own; a caller with a longer
// or shorter budget (exec, the browser relay) passes `signal` explicitly.
const DEFAULT_FETCH_TIMEOUT_MS = Number(process.env.SPRING_MCP_HTTP_TIMEOUT_MS) || 15000;
const EXEC_TIMEOUT_MS = Number(process.env.SPRING_MCP_EXEC_TIMEOUT_MS) || 60000;
const rawFetch = globalThis.fetch;
async function fetch(url, init) {
    const opts = init ? { ...init } : {};
    if (!opts.signal) opts.signal = AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS);
    return rawFetch(url, opts);
}
const deadline = (ms) => ({ signal: AbortSignal.timeout(ms) });

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
// --- Which SQLite file? ----------------------------------------------------
//
// This must be the file the RUNNING lobby writes, not a default. The committed
// .mcp.json said `data/spring-server.db` while the lobby ran `--db data/t9d.db`
// (scratch dbs are routine here), and the whole probe surface then reported
// `spawning` forever against a game that was demonstrably up — the SPRING_DB
// divergence warning exists precisely because this kept happening.
//
// Order: an explicit SPRING_DB always wins (it is how you point at a db by
// hand); otherwise ask the running lobby what it opened; otherwise the default.
const DB_DEFAULT = resolve(process.env.PROJECT_ROOT || '.', 'data/spring-server.db');
function detectLobbyDb() {
    try {
        const ps = execFileSync('ps', ['-eo', 'pid,ppid,lstart,args='], {
            encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 5000,
        });
        const flag = parseLobbyDbFlag(ps);
        return flag ? resolve(process.env.PROJECT_ROOT || '.', flag) : null;
    } catch { return null; }
}
const DB_EXPLICIT = !!process.env.SPRING_DB;
const DB_DETECTED = DB_EXPLICIT ? null : detectLobbyDb();
const DB_PATH = process.env.SPRING_DB
    ? resolve(process.env.PROJECT_ROOT || '.', process.env.SPRING_DB)
    : (DB_DETECTED || DB_DEFAULT);
if (DB_DETECTED && DB_DETECTED !== DB_DEFAULT) {
    // stdout is the MCP protocol channel — diagnostics go to stderr only.
    console.error(`SPRING_DB: following the running lobby's --db (${DB_DETECTED}); `
                + `set SPRING_DB to override.`);
}

// --- SQLite boot self-check (FU2) ---
//
// better-sqlite3 loads its native binding lazily, in the Database constructor,
// so a NODE_MODULE_VERSION mismatch does NOT fail the import above — it fails
// every `new Database(...)`, which the per-tool try/catches used to swallow as
// "no rows" (empty process lists, gameStatus {available:false}, probe_game
// stuck at 'spawning'). Probe ONCE at boot and fail loudly instead. A missing
// DB file is deliberately NOT this condition (fileMustExist:true throws a
// plain SqliteError, which classifyBindingError rejects) and keeps its
// existing per-tool handling.
let sqliteUnavailable = null; // the reason string, or null when SQLite works
try {
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    db.close();
} catch (err) {
    const mismatch = classifyBindingError(err);
    if (mismatch) {
        const info = { ...mismatch, nodeVersion: process.version };
        sqliteUnavailable = bindingMismatchReason(info);
        // ONE line, on stderr — stdout is the MCP protocol channel.
        console.error(bindingMismatchBanner(info));
    }
}

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
// getGameServersWithSource additionally names which source answered:
// probeGame's SPRING_DB-divergence warning only makes sense when the LOBBY
// (not the SQLite fallback) vouched for the process row.
async function getGameServersWithSource() {
    try {
        const resp = await fetch(`${LOBBY_URL}/api/processes`);
        if (resp.ok) {
            const rows = await resp.json();
            // Normalise to the SQLite shape so callers don't care.
            return {
                source: 'lobby',
                rows: rows.map(r => ({
                    room_id: r.room_id, port: r.port, pid: r.pid,
                    map_id: r.map, game_id: r.game, state: r.state,
                })),
            };
        }
    } catch { /* fall through */ }
    try {
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        const rows = db.prepare('SELECT room_id, port, pid, map_id, game_id, state FROM game_servers').all();
        db.close();
        return { source: 'sqlite', rows };
    } catch {
        return { source: 'none', rows: [] };
    }
}

async function getGameServers() {
    return (await getGameServersWithSource()).rows;
}

// Resolve a roomId to a LIVE server, or an error that says why not. The rules
// (ended rows refused, dead pids refused, "you passed a port") live in
// room-target.js — the point is that an old room's row must never route a
// query to whichever server now holds its port.
async function resolveServer(roomId) {
    const servers = await getGameServers();
    const picked = pickServer(servers, roomId, { pidAlive });
    if (picked.error) return { error: picked.error };
    return { server: { url: `http://127.0.0.1:${picked.server.port}`, ...picked.server } };
}

/** Compatibility shape for callers that only need "a server or null". */
async function getGameServerUrl(roomId) {
    const r = await resolveServer(roomId);
    return r.server ?? null;
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
    const { source, rows: servers } = await getGameServersWithSource();
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
    let st = null, sqliteOpened = false;
    try {
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        try {
            st = db.prepare(
                'SELECT ready, client_count, pid, port, updated_at FROM game_status WHERE room_id = ?',
            ).get(roomId) ?? null;
            sqliteOpened = true;
        } finally { db.close(); }
    } catch { /* no DB / no table yet → treat as no status row; a broken
                 native binding was already flagged at boot (sqliteUnavailable) */ }

    // The two ways this read can lie, made loud (sqlite-health.js): a broken
    // native binding → sqliteUnavailable rides every result; the lobby vouching
    // for a process that has no game_status row while SQLite reads fine →
    // the SPRING_DB-divergence `warning`. Neither changes the phase.
    const health = probeSqliteAnnotations({
        processSource: source, bindingReason: sqliteUnavailable,
        sqliteOpened, statusRow: st, port: row.port, pid: row.pid,
    });

    const base = { roomId, pid: row.pid, port: st?.port || row.port, ...health };
    if (!st) {
        return probeResult('spawning', {
            ...base,
            detail: sqliteUnavailable
                ? 'process up; game_status unreadable (see sqliteUnavailable)'
                : 'process up, no game_status row yet',
        });
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
        ...deadline(EXEC_TIMEOUT_MS),
    }));
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`exec failed (${resp.status}): ${text}`);
    }
    return resp.json();
}

async function execOnGameServer(scope, code, roomId) {
    const { server, error } = await resolveServer(roomId);
    if (error) throw new Error(error.replace(/^Error: /, ''));
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

// --- V2: sim control + sequence helpers -------------------------------
//
// Shared by capture_subject, capture_sequence and order_and_film. They all
// need the same three things: read the world's CURRENT pause/LOS/speed/cheat
// state before touching it, execute a plan step, and put everything back
// exactly as found — including the parts we did not change.

/** Read the sim state a capture plan is built against. Every field that
 *  cannot be read stays null, and `planCapture` then omits the restore rather
 *  than guessing — un-pausing a sim somebody else froze is the failure this
 *  whole ordering discipline exists to prevent. */
async function observeSimState(roomId, wantCheats) {
    const state = { simPaused: null, los: parseLosStatus(null), cheatsOn: null, simSpeed: null };
    try {
        const gs = await execJsonVerb('state', roomId);
        if (gs.json && typeof gs.json.paused === 'boolean') state.simPaused = gs.json.paused;
        if (gs.json && Number.isFinite(gs.json.speed)) state.simSpeed = gs.json.speed;
    } catch { /* leave null */ }
    try {
        const los = await execOnGameServer('server', 'json los status', roomId);
        state.los = parseLosStatus(los.success ? los.output : null);
    } catch { /* leave unknown — the plan then leaves LOS alone, loudly */ }
    if (wantCheats) {
        try {
            const c = await execOnGameServer('server', 'json cheats status', roomId);
            if (c.success) {
                try { state.cheatsOn = Boolean(JSON.parse(c.output).cheatEnabled); }
                catch { state.cheatsOn = /cheatEnabled=on/.test(c.output); }
            }
        } catch { /* leave null — we then do not toggle cheats at all */ }
    }
    return state;
}

/** Execute one plan step. `ctx` collects what the step tells us
 *  (`spawnedIds`, `revealed`, `notes`). */
async function runPlanStep(step, roomId, ctx) {
    switch (step.op) {
        case 'cheats':
            await execOnGameServer('server', step.enable ? 'cheats on' : 'cheats off', roomId);
            return;
        case 'spawn': {
            const cmd = `spawn ${step.def} ${step.x} ${step.z} ${step.team} ${step.count}`;
            const j = await execJsonVerb(cmd, roomId);
            const reply = j.json ?? j.legacy;
            if (j.json?.error) throw new Error(`spawn failed: ${j.json.error}`);
            ctx.spawnedIds = parseSpawnIds(reply);
            if (!ctx.spawnedIds.length) {
                ctx.notes.push(`spawn reply carried no unit id (${String(reply).slice(0, 120)})`
                    + ' — falling back to resolving the def by name');
            }
            return;
        }
        case 'los':
            await execOnGameServer('server', step.enable ? 'los on' : 'los off', roomId);
            ctx.revealed = step.enable;
            return;
        case 'settle':
            await new Promise((r) => setTimeout(r, step.ms));
            return;
        case 'speed':
            await execOnGameServer('server', `speed ${step.value}`, roomId);
            return;
        case 'pause':
            await execOnGameServer('server', step.paused ? 'pause' : 'unpause', roomId);
            return;
        default:
            return;
    }
}

/** Current sim frame, or null when it cannot be read. */
async function readSimFrame(roomId) {
    try {
        const j = await execJsonVerb('frame', roomId);
        if (j.json && Number.isFinite(j.json.frame)) return j.json.frame;
        const n = Number(String(j.legacy ?? '').trim());
        return Number.isFinite(n) ? n : null;
    } catch { return null; }
}

/**
 * Advance the sim by exactly `frames` and WAIT for it to land.
 *
 * "Land" is the whole contract. `sim_step` grants a budget the tick loop then
 * spends one frame at a time, paced by the current speed factor — so the verb
 * returns long before the world has moved, and a caller that captures on the
 * reply photographs the frame it was already on. Hence the poll.
 */
async function stepSim(frames, roomId, simSpeed = 1) {
    const before = await readSimFrame(roomId);
    let granted = frames;
    let reply;
    // The frame the STEP started from, as the verb itself saw it. Not the
    // `before` read above: on the first step of a sequence the sim is still
    // running, so the frame moves between that read and the grant landing, and
    // `before + granted` then under-counts. Waiting on a stale target returns
    // with budget still unspent — the sequence's very first interval is then
    // silently short. The verb's own `frame` is stamped inside the tick that
    // processes the grant, so `target` from it is exact.
    let target = null;
    try {
        const j = await execJsonVerb(`sim_step ${frames}`, roomId);
        if (j.json) {
            if (j.json.error) return { ok: false, reason: j.json.error };
            granted = Number(j.json.granted ?? frames);
            if (Number.isFinite(j.json.target)) target = j.json.target;
            reply = j.json;
        } else if (j.legacy != null) {
            reply = { text: j.legacy };
        } else {
            return {
                ok: false,
                reason: 'this game server has no `sim_step` verb — it predates'
                    + ' ai-visual-debug V2. Rebuild spring-server (the lobby forks'
                    + ' build/release/spring-server when it exists) and restart the room.',
            };
        }
    } catch (e) {
        return { ok: false, reason: e.message };
    }

    if (target == null) target = before == null ? null : before + granted;
    const deadline = Date.now() + stepTimeoutMs(granted, simSpeed);
    let landed = before;
    while (target != null && Date.now() < deadline) {
        landed = await readSimFrame(roomId);
        if (landed != null && landed >= target) break;
        await new Promise((r) => setTimeout(r, 25));
    }
    return {
        ok: target == null || (landed != null && landed >= target),
        from: before, to: landed, target, granted, reply,
        timedOut: target != null && !(landed != null && landed >= target),
    };
}

/** One `unit_state` read, stamped with the sim frame it was taken at. */
async function sampleUnitMotion(unitId, roomId) {
    const frame = await readSimFrame(roomId);
    const j = await execJsonVerb(`unit_state ${unitId}`, roomId);
    if (!j.json || j.json.error) return null;
    return { frame: frame ?? 0, pos: j.json.pos ?? { x: 0, z: 0 }, heading: j.json.heading ?? 0 };
}

/** Where a sequence's frames go. Under data/ by default — a burst is working
 *  material, and dropping a dozen JPEGs into a committed directory on every
 *  call is how a shots/ folder stops being readable. */
function sequenceOutDir(args) {
    if (args.outDir) return resolve(args.outDir);
    return join(projectRoot(), 'data', 'captures', sanitiseName(args.name));
}

// --- Browser lifecycle ----------------------------------------------------
//
// The relay above can only answer when a browser is CONNECTED, and nothing in
// this server could produce one — so the documented loop ended at "navigate a
// browser to browserUrl" and left the caller to do it by hand. This registry
// closes that gap: we launch clients, we track them, and we take them down with
// the same "read the report" discipline end_game uses. Policy and the process-
// group reasoning live in browser.js.
const browsers = new BrowserRegistry();

// roomId → the attach-form browserUrl its launch minted. The URL carries the
// host's session token in its hash, and that token is only ever handed out in
// the /api/rooms/direct response — so it cannot be reconstructed later, only
// remembered. This is why open_client({roomId}) works for a room THIS server
// launched, and needs an explicit `url` for any other.
const roomBrowserUrls = new Map();

/**
 * Open a client at `url` and (optionally) wait until the relay can actually
 * reach it. "The process started" is a much weaker claim than "a client is
 * connected and answering", and only the second one is useful to a caller.
 */
async function openClient({ url, roomId, headless, width, height, waitReadyMs }) {
    const launched = launchBrowser({ url, roomId, headless, width, height });
    if (launched.error) return { error: launched.error };
    const entry = browsers.add(launched.entry);

    const out = {
        pid: entry.pid, roomId: entry.roomId, url: entry.url,
        headless: entry.headless, profileDir: entry.profileDir,
        browserPath: entry.browserPath,
    };
    if (!(waitReadyMs > 0)) return { result: { ...out, connected: null } };

    const deadline = Date.now() + waitReadyMs;
    let last = null;
    while (Date.now() < deadline) {
        if (!defaultIsAlive(entry.pid)) {
            browsers.remove(entry.pid);
            return { result: { ...out, connected: false, detail: 'the browser exited during startup — see profileDir, or re-run with headless:false to watch it' } };
        }
        const relayed = await clientEval('test', 'readyState()', roomId, undefined, 5000);
        if (!relayed.fallback && relayed.success) {
            return { result: { ...out, connected: true, clientId: relayed.clientId,
                               readyState: clientEvalValue(relayed.output) } };
        }
        last = relayed.fallback ?? relayed.output;
        await new Promise(r => setTimeout(r, 500));
    }
    return { result: { ...out, connected: false, detail: `still not answering the relay after ${waitReadyMs} ms (last: ${String(last).slice(0, 160)})` } };
}

// If THIS process goes away, every browser it launched is orphaned — nothing
// else knows those pids, and an abandoned renderer holds the GPU. So take them
// down on the way out. Synchronous by necessity: 'exit' handlers cannot await,
// and a detached group signalled with SIGKILL is the only thing guaranteed to
// land. SIGTERM first for the ordinary paths (Ctrl-C, a supervisor restart).
function killAllBrowsersSync(signal = 'SIGKILL') {
    for (const entry of browsers.list()) {
        if (!entry.alive) continue;
        try { process.kill(-entry.pid, signal); } catch { /* already gone */ }
    }
}
process.on('exit', () => killAllBrowsersSync('SIGKILL'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { killAllBrowsersSync('SIGTERM'); process.exit(0); });
}

/** Close every browser this server opened for `roomId`. */
async function closeRoomBrowsers(roomId, timeoutMs = 5000) {
    const entries = browsers.forRoom(roomId);
    const reports = [];
    for (const e of entries) {
        const r = await closeBrowser(e, { timeoutMs });
        browsers.remove(e.pid);
        reports.push({ ...r, describe: describeClose(r) });
    }
    return reports;
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
    const resolved = await resolveServer(roomId);
    if (resolved.error) return { fallback: resolved.error.replace(/^Error: /, '') };
    const server = resolved.server;
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
            // The server parks this request for up to its own timeoutMs
            // (default 10 s, cap 60 s) waiting on the browser; give the HTTP
            // side that budget plus a margin, never less.
            ...deadline((timeoutMs || 10000) + 5000),
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
    // process.kill(0, sig) signals OUR OWN PROCESS GROUP (the MCP, and under
    // mprocs everything in the pane); a negative pid signals a group by id. A
    // hibernated room's row carries pid 0, so this guard is what stands
    // between `end_game` on such a room and the whole dev stack going down.
    if (!Number.isInteger(pid) || pid <= 1) {
        return { exited: false, escalatedToKill, waitedMs: 0, refused: `refusing to signal pid ${pid}` };
    }
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
        // `available:false` is honest for a missing file; a broken native
        // binding additionally names itself so the caller can't read this
        // as "no games have published status yet".
        return sqliteUnavailable
            ? { available: false, rows: [], sqliteUnavailable }
            : { available: false, rows: [] };
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
    if (!(target.pid > 1)) {
        return { error: `Error: room ${roomId} has no process to signal (pid=${target.pid}, state=${target.state}) — a hibernated or never-spawned room. Nothing to end.` };
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

// --- Tool definitions live in tools.js (imported above) ---

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
            // Always bounded: an omitted limit used to defer to the log
            // server's default, and a huge one pulled the whole table into
            // the transcript. 50 by default, 1000 at most.
            params.set('limit', String(clampLogLimit(args.limit)));
            const roomId = args.roomId || 0;
            const url = `${LOG_SERVER_URL}/api/logs/${roomId}?${params}`;
            const data = await fetchJson(url, DEFAULT_FETCH_TIMEOUT_MS);
            return formatLogEntries(data);
        }

        case 'search_logs': {
            // A search with no text and no scope is "the whole log" — refuse
            // it rather than stream history into the conversation.
            if (!args.query && !args.roomId && !args.game && !args.sinceMinutes) {
                return 'Error: search_logs needs a `query`, or at least one of roomId / game / sinceMinutes to scope the search.';
            }
            const params = new URLSearchParams();
            if (args.query) params.set('q', args.query);
            // roomId scopes the search to a single game instance; the
            // logserver tags each entry with the owning room/game.
            if (args.roomId) params.set('room', String(args.roomId));
            if (args.game) params.set('game', args.game);
            if (args.section) params.set('section', args.section);
            if (args.level) params.set('level', String(args.level));
            if (args.sinceMinutes) params.set('since', String(Date.now() - args.sinceMinutes * 60000));
            params.set('limit', String(clampLogLimit(args.limit)));
            const url = `${LOG_SERVER_URL}/api/logs/search?${params}`;
            const data = await fetchJson(url, DEFAULT_FETCH_TIMEOUT_MS);
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
            const { source, rows: servers } = await getGameServersWithSource();
            // Kept as prose: callers (and skill docs) read this exact string as
            // "nothing is running", and JSON `{count:0}` would break them. With
            // the binding broken the SQLite fallback can't be consulted, so an
            // empty list is NOT proof of nothing running — say so.
            if (!servers.length) {
                return sqliteUnavailable
                    ? `No game server processes found. sqliteUnavailable: ${sqliteUnavailable}`
                    : 'No game server processes found.';
            }

            const status = readGameStatusRows();
            const byRoom = new Map(status.rows.map(r => [r.room_id, r]));
            // allSettled: one hung server must not stall the whole listing.
            const ids = await Promise.allSettled(
                servers.map(s => (s.port ? fetchIdentity(s.port) : Promise.resolve(null))),
            );
            const out = {
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
            };
            // Loud-failure annotations (sqlite-health.js): the `null` status
            // fields above must never read as "no heartbeat published".
            if (sqliteUnavailable) out.sqliteUnavailable = sqliteUnavailable;
            // pid > 0: a hibernated room's pid-0 row is not a running server
            // (and pidAlive(0) would signal our own process group).
            const missing = (source === 'lobby' && status.available)
                ? servers.filter(s => s.pid > 0 && pidAlive(s.pid) && !byRoom.has(s.room_id))
                : [];
            if (missing.length) out.warning = dbDivergenceWarning(missing[0].port);
            return JSON.stringify(out, null, 2);
        }

        case 'list_stack': {
            const { census, findings } = await collectStackFindings({ probeHashes: !!args.probeHashes });
            const out = {
                findings,
                processes: census.processes,
                ports: census.ports.available
                    ? census.ports.listeners.filter(l => isStackPort(l.port))
                    : { available: false },
                authority: { source: census.authority.source, rows: census.authority.rows },
                gameStatus: census.gameStatus.available
                    ? census.gameStatus.rows
                    // readGameStatusRows names a broken native binding; keep it.
                    : { available: false, ...(census.gameStatus.sqliteUnavailable
                        ? { sqliteUnavailable: census.gameStatus.sqliteUnavailable } : {}) },
                binaries: census.binaries,
                mprocs: mprocsStatus(census.ports.listeners || []),
                summary: summarize(findings),
            };
            if (sqliteUnavailable) out.sqliteUnavailable = sqliteUnavailable;
            // SPRING_DB-divergence signature (sqlite-health.js): the lobby is
            // the authority for a live server the game_status table has never
            // heard of. pid > 0 skips hibernated rows.
            if (census.authority.source === 'lobby' && census.gameStatus.available) {
                const known = new Set(census.gameStatus.rows.map(r => r.room_id));
                const missing = census.authority.rows.filter(r =>
                    r.pid > 0 && pidAlive(r.pid) && !known.has(r.room_id));
                if (missing.length) out.warning = dbDivergenceWarning(missing[0].port);
            }
            return JSON.stringify(out, null, 2);
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
            // `Spring.GetGadgetList` does not exist — not in this engine, not
            // in Recoil, not anywhere in this tree. This tool could therefore
            // never have worked: every call died with "attempt to call a nil
            // value (field 'GetGadgetList')". The real registry is the gadget
            // handler's own `gadgets` array, each entry carrying a read-only
            // `ghInfo` proxy {name, basename, filename, layer, desc, author} —
            // the same source the handler's own listing command walks
            // (cont/base/springcontent/LuaGadgets/gadgets.lua).
            //
            // Tab-separated rather than JSON-from-Lua: the exec channel hands
            // back a plain string, and building JSON in Lua would need an
            // encoder this scope has no guarantee of.
            const lua = `
                if not gadgetHandler or not gadgetHandler.gadgets then
                    return 'ERR: no gadgetHandler in this LuaRules state'
                end
                local out = {}
                for i, g in ipairs(gadgetHandler.gadgets) do
                    local gi = g.ghInfo or {}
                    out[#out+1] = table.concat({
                        tostring(gi.layer or 0),
                        tostring(gi.name or '?'),
                        tostring(gi.basename or ''),
                        tostring(gi.author or ''),
                    }, '\\t')
                end
                return table.concat(out, '\\n')`;
            const result = await execOnGameServer('LuaRules', lua, args.roomId);
            const text = (result.output || '').trim();
            if (!text) return JSON.stringify({ count: 0, gadgets: [], note: 'the gadget handler reports no loaded gadgets' }, null, 2);
            if (text.startsWith('ERR: ')) return `Error: ${text.slice(5)}`;
            if (/attempt to (call|index)/.test(text)) return `Error from LuaRules: ${text}`;
            const gadgets = text.split('\n').map(line => {
                const [layer, name, basename, author] = line.split('\t');
                return { name, basename, layer: Number(layer), ...(author ? { author } : {}) };
            });
            return JSON.stringify({ count: gadgets.length, gadgets }, null, 2);
        }

        case 'query_db': {
            // Read-only query directly against SQLite. better-sqlite3 sets
            // stmt.reader exactly when the prepared statement returns rows —
            // a parser-level test, unlike the old prefix blacklist which let
            // `WITH t AS (…) INSERT …`, a leading comment, or `REPLACE INTO`
            // straight through. The readonly handle stays as defence in depth.
            if (sqliteUnavailable) return `Error: sqliteUnavailable: ${sqliteUnavailable}`;
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
            const { server, error } = await resolveServer(args.roomId);
            if (error) return error;
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

            // A browser we opened for this room outlives the server otherwise,
            // and an abandoned renderer holds the GPU. Closed on every exit
            // path below, including the SIGKILL alias.
            const withBrowsers = async (roomId, payload) => {
                const reports = roomId > 0 ? await closeRoomBrowsers(roomId) : [];
                if (reports.length) payload.browsers = reports;
                return JSON.stringify(payload, null, 2);
            };

            if (args.graceful === false) {
                const { error, result } = await bySignal(false);
                if (error) return error;
                return withBrowsers(result.roomId, {
                    source: 'sigkill', ...result,
                    note: 'Lobby marks the room ended on its next health check.',
                });
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
                return withBrowsers(args.roomId, {
                    source: '/api/admin/rooms/end', ...decision.report,
                    note: 'The room flips to "ended" asynchronously via the lobby health loop, not in this response — poll /api/rooms or probe_game to observe it.',
                });
            }
            // Route-level 404 ⇒ a lobby binary older than P4 (this route has no
            // feature latch, unlike /api/rooms/direct).
            const { error, result } = await bySignal(true);
            if (error) return error;
            return withBrowsers(result.roomId, {
                source: 'sigterm-fallback',
                note: 'This lobby predates POST /api/admin/rooms/end — signalled locally, so no checkpoint verification or resume eligibility is available. The room flips to "ended" on the lobby\'s next health check.',
                ...result,
            });
        }

        case 'get_frame': {
            const { server, error } = await resolveServer(args.roomId);
            if (error) return error;
            const m = await fetchMetrics(server.url, 5000);
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
            const cmd = buildVerb('revive_team', [[args.team ?? 'all', 'team']]);
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'set_stockpile': {
            const cmd = buildVerb('stockpile', [[args.unitId, 'unitId', 'num'], [args.count, 'count', 'num'], [args.queued ?? 0, 'queued', 'num']]);
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

            const launchGameId = args.gameId || 'metalstorm';
            if (args.clearCache) clearDefsCache(launchGameId);

            // Leave any existing room so /api/rooms succeeds (the user
            // can only be in one at a time).
            await fetch(`${LOBBY_URL}/api/rooms/leave`, { method: 'POST', headers: authHdr, body: '{}' }).catch(() => {});

            // Create the room.
            const createResp = await fetch(`${LOBBY_URL}/api/rooms`, {
                method: 'POST', headers: authHdr,
                body: JSON.stringify({
                    name: args.roomName || 'debug',
                    map: args.mapId,
                    game: launchGameId,
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
                gameId: launchGameId,
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
            // Loud-failure annotations from the probe (sqlite-health.js) —
            // a phase stuck at 'spawning' must carry its reason to the caller.
            if (probe.sqliteUnavailable) out.sqliteUnavailable = probe.sqliteUnavailable;
            if (probe.warning) out.warning = probe.warning;
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
                // With openBrowser, 'ticking' is not reachable YET: the sim
                // holds at frame -1 until a client connects, and the client is
                // ours to launch a few lines below. Waiting for it here would
                // burn the whole timeout and then report a scary (and by then
                // false) "no browser attached" warning on a run that succeeds.
                // So stop at 'ready' now, and wait for the caller's real target
                // after the browser is in.
                const deferToBrowser = args.openBrowser && want === 'ticking';
                probe = await waitForPhase(roomId, deferToBrowser ? 'ready' : want,
                                           args.waitTimeoutMs ?? 120000);
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

            const sessionCheck = verifySessionRows(room.sessions);
            if (sessionCheck.missing.length) {
                notes.push(`WARNING: session token(s) for ${sessionCheck.missing.join(', ')} are NOT in the lobby's sessions table `
                         + '(the known /api/rooms/direct trap: the row is minted and then dropped by forceLeaveCurrentRoom). '
                         + 'A browser attaching with browserUrl will fail auth — end_game this room and launch again.');
            }
            const out = {
                roomId,
                port: room.game_server_port,
                roomName: manifest.name,
                // Live bearer tokens; redacted unless asked for (redact.js).
                sessions: redactSessions(room.sessions, args.revealTokens === true),
                browserUrl,
                scenario: scenario && {
                    id: scenario.id, map: scenario.map,
                    sides: scenario.sides, terminal: scenario.terminal,
                },
                phase: probe.phase,
                frame: probe.frame,
                notes,
            };
            // Loud-failure annotations from the probe (sqlite-health.js).
            if (probe.sqliteUnavailable) out.sqliteUnavailable = probe.sqliteUnavailable;
            if (probe.warning) notes.push(probe.warning);
            if (probe.phase === 'dead' || timedOut) {
                const tail = await roomLogTail(roomId);
                out.lastLogs = tail.lines;
                if (tail.note) out.logsNote = tail.note;
            }

            // Remember the attach URL even when we are not opening a browser
            // now — open_client({roomId}) later has no other way to get the
            // host session token.
            if (browserUrl) roomBrowserUrls.set(roomId, browserUrl);

            // openBrowser closes the loop this tool used to leave open: the
            // default roster seats a human, so without a client the sim holds
            // at frame -1 forever and every relay tool answers "no connected
            // admin client".
            if (args.openBrowser && browserUrl && probe.phase !== 'dead') {
                const opened = await openClient({
                    url: browserUrl, roomId,
                    headless: args.browserHeadless !== false,
                    waitReadyMs: args.wait === 'none' ? 0 : 60000,
                });
                if (opened.error) {
                    out.browser = { error: opened.error };
                    notes.push(`openBrowser failed: ${opened.error}`);
                } else {
                    out.browser = opened.result;
                    // The sim only starts once the client is in, so the phase
                    // captured before the browser existed is already stale.
                    if (opened.result.connected && args.wait && args.wait !== 'none') {
                        const after = await waitForPhase(roomId, args.wait, 60000);
                        out.phase = after.phase;
                        out.frame = after.frame;
                        if (after.timedOut) {
                            notes.push(`WARNING: the client connected but the game is still '${after.phase}' `
                                     + `after waiting for '${args.wait}' (${after.detail}).`);
                        }
                    } else if (!opened.result.connected) {
                        notes.push(`WARNING: the browser was launched but never reached the relay (${opened.result.detail || 'no detail'}) `
                                 + '— the sim will hold at frame -1. Re-run with browserHeadless:false to watch it.');
                    }
                }
            } else if (args.openBrowser && !browserUrl) {
                notes.push('openBrowser ignored: headless:true means no browserUrl was minted.');
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

            const sessionCheck = verifySessionRows(room.sessions);
            if (sessionCheck.missing.length) {
                notes.push(`WARNING: session token(s) for ${sessionCheck.missing.join(', ')} are NOT in the lobby's sessions table `
                         + '(the known /api/rooms/direct trap) — a client logging in with them will fail auth. Relaunch.');
            }
            const out = {
                roomId,
                port: room.game_server_port,
                roomName: manifest.name || 'dev:direct',
                sessions: redactSessions(room.sessions, args.revealTokens === true),
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
            // Loud-failure annotations from the probe (sqlite-health.js).
            if (probe.sqliteUnavailable) out.sqliteUnavailable = probe.sqliteUnavailable;
            if (probe.warning) notes.push(probe.warning);
            if (probe.phase === 'dead' || probe.timedOut) {
                const tail = await roomLogTail(roomId);
                out.lastLogs = tail.lines;
                if (tail.note) out.logsNote = tail.note;
            }
            // Same reason as launch_scenario: the token in this URL is issued
            // once and cannot be rebuilt, so open_client({roomId}) needs it kept.
            if (out.browserUrl) roomBrowserUrls.set(roomId, out.browserUrl);
            return out;
        }

        case 'api_request': {
            const target = args.target || 'lobby';
            let url;
            if (target === 'url') {
                if (!args.url) return 'Error: target="url" requires `url`.';
                url = args.url;
            } else if (!args.path || !String(args.path).startsWith('/')) {
                return `Error: target="${target}" requires \`path\` beginning with "/" (got ${JSON.stringify(args.path)}).`;
            } else if (target === 'lobby') {
                url = `${LOBBY_URL}${args.path}`;
            } else if (target === 'log') {
                url = `${LOG_SERVER_URL}${args.path}`;
            } else if (target === 'game') {
                const { server, error } = await resolveServer(args.roomId);
                if (error) return error;
                url = `${server.url}${args.path}`;
            } else {
                return `Error: unknown target "${target}".`;
            }

            const method = (args.method || 'GET').toUpperCase();
            const headers = { ...(args.headers || {}) };
            const wantAuth = args.auth !== false;
            const timeoutMs = Math.max(500, Math.min(300000, Number(args.timeoutMs ?? 30000)));

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
                ...deadline(timeoutMs),
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
            const cmd = buildVerb('spawn', [
                [args.defName, 'defName'], [args.x, 'x', 'num'], [args.z, 'z', 'num'],
                [args.team ?? 0, 'team', 'num'], [args.count ?? 1, 'count', 'num'],
            ]);
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
            const cmd = buildVerb('kill', [[args.unitId, 'unitId', 'num'], [!!args.selfDestruct, 'selfDestruct'], [!!args.reclaimed, 'reclaimed']]);
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'damage_unit': {
            const cmd = buildVerb('damage', [[args.unitId, 'unitId', 'num'], [args.amount, 'amount', 'num'], [!!args.paralyze, 'paralyze']]);
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'give_order': {
            const params = Array.isArray(args.params) ? args.params : [];
            if (params.length > 4) return 'Error: give_order takes at most 4 params.';
            const cmd = buildVerb('order', [
                [args.unitId, 'unitId', 'num'], [args.cmdId, 'cmdId', 'num'],
                ...params.map((p, i) => [p, `params[${i}]`, 'num']),
                [args.opts ?? 0, 'opts', 'num'],
            ]);
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'clear_units': {
            const cmd = buildVerb('clear', [[args.team, 'team', 'num']]);
            const r = await execOnGameServer('server', cmd, args.roomId);
            return r.success ? r.output : `Error: ${r.output}`;
        }

        case 'get_unit_state': {
            const cmd = buildVerb('unit_state', [[args.unitId, 'unitId', 'num']]);
            const j = await execJsonVerb(cmd, args.roomId);
            if (j.json) {
                if (j.json.error) return `Error: ${j.json.error}`;
                return j.json;
            }
            if (j.legacy) return j.legacy;
            const r = await execOnGameServer('server', cmd, args.roomId);
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
            const r = await execOnGameServer('server', buildVerb('speed', [[args.multiplier, 'multiplier', 'num']]), args.roomId);
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
            const r = await execOnGameServer('server', buildVerb('invulnerable', [[args.unitId, 'unitId', 'num'], [tail, 'mode']]), args.roomId);
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

        case 'open_client': {
            let url = args.url;
            if (!url && args.roomId > 0) url = roomBrowserUrls.get(args.roomId);
            if (!url) {
                const known = [...roomBrowserUrls.keys()];
                return args.roomId > 0
                    ? `Error: no remembered browserUrl for room ${args.roomId}. `
                      + `This server only remembers rooms IT launched${known.length ? ` (${known.join(', ')})` : ' (none this session)'}; `
                      + 'the attach URL carries a session token that only /api/rooms/direct issues. '
                      + 'Pass an explicit `url`, or launch the room with launch_scenario.'
                    : 'Error: pass `roomId` (a room this server launched) or an explicit `url`.';
            }
            const waitReadyMs = args.waitReady === false ? 0 : (args.waitReadyMs ?? 60000);
            const { error, result } = await openClient({
                url, roomId: args.roomId ?? null,
                headless: args.headless !== false,
                width: args.width, height: args.height,
                waitReadyMs,
            });
            if (error) return `Error: ${error}`;
            return JSON.stringify(result, null, 2);
        }

        case 'close_client': {
            const timeoutMs = args.timeoutMs ?? 5000;
            let targets;
            if (args.pid > 0) {
                const e = browsers.get(args.pid);
                if (!e) {
                    const live = browsers.list().map(x => x.pid);
                    return `Error: pid ${args.pid} was not launched by this server, so it is not ours to signal. `
                         + (live.length ? `Tracked pids: ${live.join(', ')}.` : 'No browsers are tracked.');
                }
                targets = [e];
            } else if (args.roomId > 0) {
                targets = browsers.forRoom(args.roomId);
            } else if (args.all) {
                targets = browsers.list().map(e => browsers.get(e.pid)).filter(Boolean);
            } else {
                return 'Error: pass `pid`, `roomId`, or `all:true`.';
            }
            if (!targets.length) return JSON.stringify({ closed: 0, browsers: [], note: 'nothing tracked matched' }, null, 2);

            const reports = [];
            for (const e of targets) {
                const r = await closeBrowser(e, { timeoutMs });
                browsers.remove(e.pid);
                reports.push({ ...r, roomId: e.roomId, describe: describeClose(r) });
            }
            return JSON.stringify({ closed: reports.length, browsers: reports }, null, 2);
        }

        case 'list_clients': {
            const list = browsers.list();
            return JSON.stringify({
                count: list.length,
                clients: list,
                note: list.length
                    ? 'Only browsers this server launched. alive:false means it died or was killed outside close_client.'
                    : 'No tracked browsers. open_client makes one; a browser you opened by hand is never listed here.',
            }, null, 2);
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


        case 'capture_subject': {
            const argError = validateCaptureArgs(args);
            if (argError) return `Error: ${argError}`;

            // 1. OBSERVE before touching anything. Every restore step below is
            //    conditional on what we found, because "undo everything" would
            //    un-pause a sim somebody else froze and un-reveal a map that
            //    was revealed on purpose.
            const state = await observeSimState(args.roomId, Boolean(args.spawn));

            const plan = planCapture(args, state);
            const notes = [...plan.notes];
            const ctx = { spawnedIds: [], revealed: state.los.allOn === true, notes };
            const runStep = (step) => runPlanStep(step, args.roomId, ctx);

            let relayed;
            try {
                for (const s of plan.pre) await runStep(s);
                // 2. THE ONE ROUND TRIP. Resolve → frame → dwell → hold →
                //    capture → judge → retry, all browser-side. Splitting this
                //    is the bug (see the tool description).
                relayed = await clientEval(
                    'test',
                    buildHarnessCall({
                        ...args,
                        __revealed: ctx.revealed,
                        // Whenever WE stopped the world, the presentation cursor
                        // has no wall-clock rate left to close the gap to the
                        // state the server is actually holding, so the shot must
                        // be told to jump onto it.
                        syncPresentation: args.syncPresentation
                            ?? plan.pre.some((st) => st.op === 'pause'),
                    }),
                    args.roomId, args.clientId, DEFAULT_RELAY_TIMEOUT_MS);
            } finally {
                // 3. Restore even when the capture threw — a half-applied
                //    capture that leaves the sim paused poisons the session.
                for (const s of plan.post) {
                    try { await runStep(s); }
                    catch (e) { notes.push(`restore step ${s.op} failed: ${e.message}`); }
                }
            }

            if (relayed.fallback) {
                return `Relay unavailable: ${relayed.fallback}. `
                    + 'capture_subject needs a CONNECTED admin browser — open one with '
                    + '`open_client({roomId})`, or launch with `openBrowser:true`.';
            }
            if (!relayed.success) return `Error (client ${relayed.clientId}): ${relayed.output}`;
            const shot = clientEvalValue(relayed.output);
            if (!shot || typeof shot !== 'object' || !shot.dataUrl) {
                return `Unexpected captureSubject reply: ${String(relayed.output).slice(0, 400)}`;
            }
            const m = /^data:([^;]+);base64,(.*)$/s.exec(shot.dataUrl);
            if (!m) return `captureSubject returned a non-data-URL image (${shot.dataUrl.slice(0, 60)}…)`;
            if (ctx.spawnedIds.length) notes.push(`spawned unit id(s): ${ctx.spawnedIds.join(', ')}`);
            return {
                content: [
                    { type: 'image', data: m[2], mimeType: m[1] },
                    { type: 'text', text: formatCaptureMeta(shot, {
                        notes, plan: describePlan(plan), clientId: relayed.clientId,
                    }) },
                ],
            };
        }

        case 'step_sim': {
            const frames = Math.max(1, Math.min(MAX_STEP_FRAMES,
                Math.floor(Number(args.frames ?? 1))));
            const st = await observeSimState(args.roomId, false);
            const r = await stepSim(frames, args.roomId, st.simSpeed ?? 1);
            if (!r.ok && r.reason) return `Error: ${r.reason}`;
            const lines = [
                r.timedOut
                    ? `step: TIMED OUT — asked for ${r.granted} frame(s) from ${r.from},`
                      + ` reached ${r.to}. The sim is paused with a step budget possibly`
                      + ' still outstanding; pause_sim or unpause to clear it.'
                    : `step: OK — ${r.from} → ${r.to} (${r.granted} frame(s))`,
                `sim: paused${st.simPaused === false ? ' (it was running; step_sim paused it)' : ''}`
                    + `, speed ${st.simSpeed ?? '?'}×`,
                `game-seconds advanced: ${(r.granted / GAME_SPEED).toFixed(3)}`,
            ];
            return lines.join('\n');
        }

        case 'capture_sequence':
        case 'order_and_film': {
            const isOrder = name === 'order_and_film';
            if (isOrder && !Number.isFinite(args.unitId)) {
                return 'Error: order_and_film needs `unitId` — the unit to order and film.';
            }
            const seqArgs = isOrder
                ? { ...args, frames: args.frames ?? 8, everyNthSimFrame: args.everyNthSimFrame ?? 6 }
                : args;
            const argError = validateSequenceArgs(seqArgs);
            if (argError) return `Error: ${argError}`;

            const state = await observeSimState(args.roomId, Boolean(args.spawn));
            const plan = planSequence(seqArgs, state);
            if (plan.mode === 'realtime') {
                const budgetError = realtimeBudgetError(
                    plan.frames, plan.stride, plan.simSpeed ?? 1,
                    Number.isFinite(args.settleMs) ? args.settleMs : 250);
                if (budgetError) return `Error: ${budgetError}`;
            }
            const notes = [...plan.notes];
            const ctx = { spawnedIds: [], revealed: state.los.allOn === true, notes };
            const runStep = (step) => runPlanStep(step, args.roomId, ctx);
            const effSpeed = plan.simSpeed ?? state.simSpeed ?? 1;

            // ── The order, and the wait for it to BECOME MOTION ──────────
            //
            // Before any of the capture plan runs: the order has to go in
            // while the sim is still running, and the onset poll has to watch
            // a running sim. Doing this after the plan's `pause` would mean
            // waiting for motion from a stopped world — forever.
            let onset = null;
            if (isOrder) {
                let cmdId = args.order?.cmdId;
                let params = args.order?.params ?? [];
                if (args.move) {
                    cmdId = 10;
                    const y = Number.isFinite(args.move.y) ? args.move.y : 0;
                    params = [args.move.x, y, args.move.z];
                } else if (Number.isFinite(args.attack)) {
                    cmdId = 20;
                    params = [args.attack];
                }
                if (!Number.isFinite(cmdId)) {
                    return 'Error: order_and_film needs one of `move:{x,z}`, `attack:<unitId>`'
                        + ' or an explicit `order:{cmdId, params}`.';
                }
                const cmd = `order ${args.unitId} ${cmdId} ${params.join(' ')} ${args.order?.opts ?? 0}`
                    .replace(/\s+/g, ' ').trim();
                const ordered = await execOnGameServer('server', cmd, args.roomId);
                if (!ordered.success) return `Error: order refused: ${ordered.output}`;
                notes.push(`order: ${cmd} → ${String(ordered.output).slice(0, 120)}`);

                const timeoutMs = Math.max(0, Number(args.onsetTimeoutMs ?? 8000));
                const pollFrames = Math.max(1, Math.floor(Number(args.onsetPollFrames ?? 3)));
                const pollMs = Math.max(50, (pollFrames / (GAME_SPEED * effSpeed)) * 1000);
                const started = Date.now();
                let prev = await sampleUnitMotion(args.unitId, args.roomId);
                let polls = 0;
                let last = { speed: 0, turnRateDegPerSec: 0, moving: false };
                while (Date.now() - started < timeoutMs) {
                    await new Promise((r) => setTimeout(r, pollMs));
                    const cur = await sampleUnitMotion(args.unitId, args.roomId);
                    polls++;
                    if (!cur) { notes.push(`unit ${args.unitId} vanished while waiting for motion`); break; }
                    if (prev) {
                        last = motionOnset(prev, cur, {
                            speedThreshold: args.speedThreshold,
                            turnThreshold: args.turnThreshold,
                        });
                        if (last.moving) break;
                    }
                    prev = cur;
                }
                onset = {
                    waitedMs: Date.now() - started, polls,
                    moving: last.moving === true,
                    speed: last.speed ?? 0,
                    turnRateDegPerSec: last.turnRateDegPerSec ?? 0,
                };
                if (!onset.moving) {
                    notes.push('the unit never crossed the motion threshold before the'
                        + ' onset timeout — filming anyway, because a hull that did not'
                        + ' move IS the finding when the order was supposed to move it');
                }
            }

            // ── Setup: spawn / reveal / settle / speed / (pause in step mode) ──
            const shots = [];
            const headingSamples = [];
            let relayed = null;
            let subject = null;
            let framing = null;
            let sequenceWarnings = [];
            let stepReport = null;
            try {
                for (const st of plan.pre) await runStep(st);

                if (plan.mode === 'realtime') {
                    // ONE relay evaluation for the whole burst: the wall-clock
                    // interval between shots has to be paced browser-side or it
                    // is relay latency wearing a stopwatch.
                    relayed = await clientEval(
                        'test',
                        buildSequenceHarnessCall({ ...seqArgs, __revealed: ctx.revealed }, plan),
                        args.roomId, args.clientId,
                        sequenceRelayTimeoutMs(plan.frames, plan.stride, effSpeed));
                    if (relayed.fallback) {
                        return `Relay unavailable: ${relayed.fallback}. `
                            + 'capture_sequence needs a CONNECTED admin browser — open one '
                            + 'with `open_client({roomId})`.';
                    }
                    if (!relayed.success) return `Error (client ${relayed.clientId}): ${relayed.output}`;
                    const burst = clientEvalValue(relayed.output);
                    if (!burst || !Array.isArray(burst.shots)) {
                        return `Unexpected captureSequence reply: ${String(relayed.output).slice(0, 400)}`;
                    }
                    subject = burst.subject;
                    framing = burst.framing;
                    sequenceWarnings = burst.warnings ?? [];
                    if (burst.truncated) notes.push('the burst was cut short by the relay wire cap');
                    for (const sh of burst.shots) shots.push(sh);
                } else {
                    // STEP MODE. capture → sim_step → capture → …  The sim is
                    // stopped between shots, so the seconds each relay call
                    // costs buy exactly nothing of sim time: the spacing is the
                    // step size and only the step size.
                    let resolvedUnitId = Number.isFinite(seqArgs.unitId) ? seqArgs.unitId : null;
                    const steps = [];
                    const t0 = Date.now();
                    // The SERVER's frame is the spacing axis, not the client's.
                    // `captureFrame().gameFrame` comes from GameInfo, which is
                    // broadcast once a game-second, so it quantises to 30 and a
                    // 9-frame step reads as 0 or 30 — the spacing would look
                    // wrong when it was exact. We know the true frame: the step
                    // reply says where it landed.
                    let serverFrame = await readSimFrame(args.roomId);
                    for (let i = 0; i < plan.frames; i++) {
                        if (i > 0) {
                            const r = await stepSim(plan.stride, args.roomId, effSpeed);
                            steps.push(r);
                            if (Number.isFinite(r.to)) serverFrame = r.to;
                            if (!r.ok && r.reason) {
                                notes.push(`sim_step failed at shot ${i}: ${r.reason}`);
                                break;
                            }
                            if (r.timedOut) {
                                notes.push(`sim_step ${plan.stride} timed out before shot ${i}`
                                    + ` (reached ${r.to} of ${r.target})`);
                            }
                        }
                        const shotArgs = {
                            ...seqArgs,
                            // Resolve the def ONCE: after the first shot we know
                            // which entity we are filming, and re-resolving would
                            // let a newer instance steal the camera mid-sequence.
                            ...(resolvedUnitId != null
                                ? { unitId: resolvedUnitId, def: undefined, unitIds: undefined }
                                : {}),
                            // A sequence is a dozen images, not one: JPEG at a
                            // readable-not-lavish size, or ten 1.8 MB PNGs land
                            // on disk and nobody can commit the evidence.
                            maxDim: seqArgs.maxDim ?? 1000,
                            format: seqArgs.format ?? 'jpeg',
                            quality: seqArgs.quality ?? 0.72,
                            syncPresentation: true,
                            // Keep the rig alive between shots; one orbitStop at
                            // the end instead of a teardown per frame.
                            restore: false,
                            // The retry ladder re-frames up and out, which would
                            // silently change the viewpoint mid-sequence. Only
                            // the first shot is allowed to hunt for a framing.
                            retries: i === 0 ? 2 : 0,
                            __revealed: ctx.revealed,
                        };
                        const one = await clientEval('test', buildHarnessCall(shotArgs),
                            args.roomId, args.clientId, DEFAULT_RELAY_TIMEOUT_MS);
                        if (one.fallback) {
                            return `Relay unavailable: ${one.fallback}. `
                                + 'capture_sequence needs a CONNECTED admin browser.';
                        }
                        if (!one.success) {
                            notes.push(`shot ${i} failed: ${String(one.output).slice(0, 200)}`);
                            break;
                        }
                        relayed = one;
                        const shot = clientEvalValue(one.output);
                        if (!shot || !shot.dataUrl) {
                            notes.push(`shot ${i} returned no image`);
                            break;
                        }
                        if (!subject) { subject = shot.subject; framing = shot.framing; }
                        if (resolvedUnitId == null && Number.isFinite(shot.subject?.unitId)) {
                            resolvedUnitId = shot.subject.unitId;
                        }
                        for (const w of shot.warnings ?? []) {
                            if (!sequenceWarnings.includes(w)) sequenceWarnings.push(w);
                        }
                        shots.push({
                            index: i,
                            gameFrame: serverFrame ?? shot.gameFrame,
                            // What the CLIENT was actually showing: the freshest
                            // entity snapshot it holds. Judged separately, because
                            // a sim that stepped while the client stayed put is a
                            // still life with correct-looking metadata.
                            clientFrame: shot.presentation?.newestFrame,
                            frameId: shot.frameId,
                            atMs: Date.now() - t0,
                            dataUrl: shot.dataUrl,
                            width: shot.width, height: shot.height,
                            stats: shot.stats,
                            verdict: shot.attempts?.[shot.attempts.length - 1]?.verdict,
                        });
                        if (resolvedUnitId != null) {
                            const sample = await sampleUnitMotion(resolvedUnitId, args.roomId);
                            if (sample) headingSamples.push(sample);
                        }
                    }
                    stepReport = steps;
                    // The rig was left standing on purpose; put the camera back.
                    await clientEval('test', 'orbitStop()', args.roomId, args.clientId)
                        .catch(() => undefined);
                }
            } finally {
                for (const st of plan.post) {
                    try { await runStep(st); }
                    catch (e) { notes.push(`restore step ${st.op} failed: ${e.message}`); }
                }
            }

            if (ctx.spawnedIds.length) notes.push(`spawned unit id(s): ${ctx.spawnedIds.join(', ')}`);
            if (shots.length === 0) {
                return 'Error: the sequence captured no frames.\n'
                    + notes.map((n) => `note: ${n}`).join('\n');
            }

            // ── Write the frames to disk ────────────────────────────────
            const outDir = sequenceOutDir({
                ...args,
                name: args.name ?? (isOrder ? `order-${args.unitId}` : 'sequence'),
            });
            mkdirSync(outDir, { recursive: true });
            const files = [];
            for (const sh of shots) {
                const m = /^data:([^;]+);base64,(.*)$/s.exec(sh.dataUrl ?? '');
                if (!m) continue;
                const path = join(outDir, frameFileName(sh.index, sh.gameFrame, extForMime(m[1])));
                writeFileSync(path, Buffer.from(m[2], 'base64'));
                files.push({
                    index: sh.index,
                    gameFrame: sh.gameFrame,
                    deltaFrames: files.length ? sh.gameFrame - files[files.length - 1].gameFrame : 0,
                    mean: sh.stats?.mean,
                    black: sh.verdict?.black === true,
                    path,
                    mimeType: m[1],
                    data: m[2],
                });
            }

            const summary = summariseShots(shots, plan);
            const result = {
                ok: summary.ok,
                mode: plan.mode,
                requested: {
                    frames: plan.frames,
                    everyNthSimFrame: plan.stride,
                    simSpeed: plan.simSpeed,
                },
                subject, framing, shots, summary, files,
                warnings: sequenceWarnings,
                onset,
                turnDegrees: headingSamples.length > 1
                    ? totalTurnDegrees(headingSamples) : undefined,
            };
            notes.push(`frames written to ${outDir}`);
            if (stepReport?.some((r) => r.timedOut)) {
                notes.push('at least one step did not land inside its budget — the'
                    + ' spacing in `deltas` above is what actually happened');
            }

            const inline = Math.max(0, Math.min(4, Number(args.inlineFrames ?? 1)));
            const content = [];
            for (const f of files.slice(0, inline)) {
                content.push({ type: 'image', data: f.data, mimeType: f.mimeType });
            }
            content.push({ type: 'text', text: formatSequenceMeta(result, {
                notes, plan: describeSequencePlan(plan),
                clientId: relayed?.clientId,
            }) });
            return { content };
        }

        case 'drive_pattern': {
            if (!PATTERNS.includes(args.pattern)) {
                return `Error: drive_pattern needs \`pattern\` — one of ${PATTERNS.join(', ')}.`;
            }
            if (!Number.isFinite(args.unitId) && !args.spawn) {
                return 'Error: drive_pattern needs `unitId` (drive an existing unit) or `spawn` (create one first).';
            }

            const notes = [];
            let unitId = args.unitId;
            if (!Number.isFinite(unitId)) {
                const s = args.spawn;
                if (!s || !s.defName || !Number.isFinite(s.x) || !Number.isFinite(s.z)) {
                    return 'Error: `spawn` needs {defName, x, z}.';
                }
                const cmd = buildVerb('spawn', [
                    [s.defName, 'defName'], [s.x, 'x', 'num'], [s.z, 'z', 'num'],
                    [s.team ?? 0, 'team', 'num'], [1, 'count', 'num'],
                ]);
                const j = await execJsonVerb(cmd, args.roomId);
                let spawnReply;
                if (j.json) {
                    if (j.json.error) return `Error: spawn failed: ${j.json.error}`;
                    spawnReply = j.json;
                } else if (j.legacy) {
                    return `Error: spawn failed: ${j.legacy}`;
                } else {
                    const r = await execOnGameServer('server', cmd, args.roomId);
                    if (!r.success) return `Error: spawn failed: ${r.output}`;
                    spawnReply = r.output;
                }
                const ids = parseSpawnIds(spawnReply);
                if (!ids.length) return `Error: spawn did not return a unit id (${String(spawnReply).slice(0, 200)}).`;
                unitId = ids[0];
                notes.push(`spawned unit id: ${unitId}`);
                // A unit ordered IMMEDIATELY after spawn_unit can silently
                // drop its first order (empty queue, never moves) — a
                // TOOLING GAP note from the pres-decals fire (docs/reviews/
                // beta/README.md). A short settle before the first order,
                // confirmed by polling unit_state, fixes it.
                let exists = false;
                for (let i = 0; i < 5 && !exists; i++) {
                    await new Promise((r) => setTimeout(r, 200));
                    exists = !!(await sampleUnitMotion(unitId, args.roomId));
                }
                if (!exists) notes.push(`unit ${unitId} did not confirm via unit_state while settling — ordering anyway`);
            }

            const origin = await sampleUnitMotion(unitId, args.roomId);
            if (!origin) return `Error: unit ${unitId} not found (unit_state came back empty).`;

            let waypoints;
            try {
                waypoints = generateWaypoints({
                    pattern: args.pattern, center: { x: origin.pos.x, z: origin.pos.z },
                    radius: args.radius, length: args.length,
                    laps: args.laps, segmentsPerLap: args.segmentsPerLap,
                });
            } catch (e) { return `Error: ${e.message}`; }
            if (waypoints.length > 200) {
                return `Error: drive_pattern would issue ${waypoints.length} waypoints (max 200) — reduce laps or segmentsPerLap.`;
            }

            // Queued MOVE orders: reuses give_order's own verb-building (cmdId
            // 10 = MOVE), first waypoint opts 0 (replace), the rest opts 32
            // (SHIFT/queue) — the exact "opts 0 then 32" pattern the
            // hand-built pres-decals figure-8 used.
            const startFrame = await readSimFrame(args.roomId);
            for (let i = 0; i < waypoints.length; i++) {
                const wp = waypoints[i];
                const cmd = buildVerb('order', [
                    [unitId, 'unitId', 'num'], [10, 'cmdId', 'num'],
                    [wp.x, 'params[0]', 'num'], [0, 'params[1]', 'num'], [wp.z, 'params[2]', 'num'],
                    [i === 0 ? 0 : 32, 'opts', 'num'],
                ]);
                const r = await execOnGameServer('server', cmd, args.roomId);
                if (!r.success) return `Error: waypoint ${i} order refused: ${r.output}`;
            }

            // Wait for the LAST waypoint (order_and_film's own polling
            // pattern, aimed at position-arrival rather than motion onset).
            const last = waypoints[waypoints.length - 1];
            const arriveRadius = Number.isFinite(args.arriveRadius) ? args.arriveRadius : 64;
            const timeoutMs = Number.isFinite(args.timeoutMs) ? args.timeoutMs : 60000;
            const pollMs = Math.max(50, Number.isFinite(args.pollMs) ? args.pollMs : 500);
            const started = Date.now();
            let finalState = origin;
            let arrived = false;
            while (Date.now() - started < timeoutMs) {
                const cur = await sampleUnitMotion(unitId, args.roomId);
                if (!cur) { notes.push(`unit ${unitId} vanished while waiting to arrive`); break; }
                finalState = cur;
                if (Math.hypot(cur.pos.x - last.x, cur.pos.z - last.z) <= arriveRadius) { arrived = true; break; }
                await new Promise((r) => setTimeout(r, pollMs));
            }
            if (!arrived) notes.push(`did not confirm arrival within ${timeoutMs}ms — returning last known position`);
            const endFrame = await readSimFrame(args.roomId);

            const result = {
                unitId, pattern: args.pattern, waypoints,
                arrived, framesElapsed: (endFrame ?? startFrame ?? 0) - (startFrame ?? 0),
                finalPosition: finalState.pos,
                notes,
            };
            if (!args.capture) return result;

            // Optional capture: reuse the same capture_subject plumbing
            // (imported above) for a top + low pair at the final position,
            // rather than re-deriving the pause/reveal/restore dance.
            const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
            for (const angle of ['top', 'low']) {
                try {
                    const capArgs = { unitId, angle, maxDim: args.maxDim, roomId: args.roomId, clientId: args.clientId };
                    const state = await observeSimState(args.roomId, false);
                    const plan = planCapture(capArgs, state);
                    const cctx = { spawnedIds: [], revealed: state.los.allOn === true, notes: [] };
                    const runStep = (step) => runPlanStep(step, args.roomId, cctx);
                    let relayed;
                    try {
                        for (const s of plan.pre) await runStep(s);
                        relayed = await clientEval('test', buildHarnessCall({
                            ...capArgs,
                            __revealed: cctx.revealed,
                            syncPresentation: plan.pre.some((st) => st.op === 'pause'),
                        }), args.roomId, args.clientId, DEFAULT_RELAY_TIMEOUT_MS);
                    } finally {
                        for (const s of plan.post) {
                            try { await runStep(s); } catch { /* best-effort restore */ }
                        }
                    }
                    if (relayed.fallback) {
                        content.push({ type: 'text', text: `capture (${angle}) unavailable: relay ${relayed.fallback}` });
                        continue;
                    }
                    if (!relayed.success) {
                        content.push({ type: 'text', text: `capture (${angle}) error: ${relayed.output}` });
                        continue;
                    }
                    const shot = clientEvalValue(relayed.output);
                    const m = shot?.dataUrl && /^data:([^;]+);base64,(.*)$/s.exec(shot.dataUrl);
                    if (!m) {
                        content.push({ type: 'text', text: `capture (${angle}): unexpected reply` });
                        continue;
                    }
                    content.push({ type: 'image', data: m[2], mimeType: m[1] });
                    content.push({ type: 'text', text: `capture (${angle}): ${formatCaptureMeta(shot, {
                        notes: cctx.notes, plan: describePlan(plan), clientId: relayed.clientId,
                    })}` });
                } catch (e) {
                    content.push({ type: 'text', text: `capture (${angle}) threw: ${e.message}` });
                }
            }
            return { content };
        }

        case 'populate_tranche': {
            const rung = args.rung ?? 'XL900';
            let lua;
            try {
                lua = buildTrancheLua(rung, {
                    center: args.center,
                    teamNorth: args.teamNorth,
                    teamSouth: args.teamSouth,
                    armored: args.armored,
                    soldierDef: args.soldierDef,
                    tankDef: args.tankDef,
                    suppressGameOver: args.suppressGameOver,
                });
            } catch (e) { return `Error: ${e.message}`; }

            if (args.clearFirst) {
                const teamNorth = Number.isFinite(args.teamNorth) ? args.teamNorth : 0;
                const teamSouth = Number.isFinite(args.teamSouth) ? args.teamSouth : 4;
                for (const team of [teamNorth, teamSouth]) {
                    await execOnGameServer('server', buildVerb('clear', [[team, 'team', 'num']]), args.roomId);
                }
            }

            const result = await execOnGameServer('LuaRules', lua, args.roomId);
            if (!result.success) return `Error: ${result.output || 'exec failed'}`;
            let parsed;
            try { parsed = JSON.parse(result.output); }
            catch { return `Error: unexpected populate_tranche reply: ${String(result.output).slice(0, 400)}`; }
            return {
                rung,
                expectedUnits: trancheUnitCount(rung),
                ...parsed,
                note: 'ids kept server-side in GG.perfTranche[team] — read them back with exec_lua if needed.',
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
            // Forward EVERY knob the schema declares, derived from the schema
            // itself. The old hand-kept list predated `works`, `harbour`,
            // `shanty`, `coverage` and `player`, so those five were accepted
            // by validation and silently dropped before the POST — a whitelist
            // emitter drops new keys (memory). Deriving it makes that class of
            // drift impossible; self-check.mjs guards the rest.
            const knobs = Object.keys(TOOLS.find(t => t.name === 'generate_scenario').inputSchema.properties)
                .filter(k => k !== 'gameId' && k !== 'mapId');
            for (const k of knobs) if (args[k] !== undefined) body[k] = args[k];

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

        default: {
            // World / AI / NL tools live in their own modules and receive the
            // IO they need injected (world-tools.js, ai-tools.js, nl-tools.js)
            // — that is what makes them unit-testable with fakes.
            const handler = worldHandlers[name] || aiHandlers[name] || nlHandlers[name];
            if (handler) return handler(args, toolIo);
            return `Unknown tool: ${name}`;
        }
    }
}

// The IO surface handed to the module-hosted tools. Every function here is
// one the in-file tools already use; the modules never touch fetch/sqlite
// directly, so a test can drive them with plain fakes.
const toolIo = {
    lobbyUrl: LOBBY_URL,
    logServerUrl: LOG_SERVER_URL,
    fetch: (url, init) => fetch(url, init),
    authedFetch,
    resolveServer,
    getGameServers,
    execLua: (scope, code, roomId) => execOnGameServer(scope, code, roomId),
    execJsonVerb,
    authUser: AUTH_USER,
};

// After a direct launch, confirm the minted session rows actually exist —
// /api/rooms/direct is known to answer with tokens it then drops (memory:
// project_direct_room_session_loss). Read-only, feature-detected: no sqlite,
// no table, no rows to check → {checked:false}. Never throws.
function verifySessionRows(sessions) {
    const out = { checked: false, missing: [] };
    if (!sessions || typeof sessions !== 'object' || sqliteUnavailable) return out;
    try {
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        try {
            const stmt = db.prepare('SELECT 1 FROM sessions WHERE token = ?');
            for (const [user, token] of Object.entries(sessions)) {
                if (typeof token !== 'string' || !token) continue;
                out.checked = true;
                if (!stmt.get(token)) out.missing.push(user);
            }
        } finally { db.close(); }
    } catch { /* no db / no table — leave unchecked */ }
    return out;
}

const LOG_LIMIT_DEFAULT = 50;
const LOG_LIMIT_MAX = 1000;
function clampLogLimit(limit) {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) return LOG_LIMIT_DEFAULT;
    return Math.min(LOG_LIMIT_MAX, Math.floor(n));
}

function formatLogEntries(entries) {
    if (!Array.isArray(entries)) return `Unexpected log server reply: ${String(JSON.stringify(entries)).slice(0, 200)}`;
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
        // Enforce the inputSchema before dispatch. Until this existed, a
        // missing REQUIRED field reached the handler as undefined and surfaced
        // as whatever the downstream layer said about it (a better-sqlite3
        // type error, a game-server usage line), and a typo'd optional field
        // was silently indistinguishable from omitting it. See tool-args.js.
        const argError = validateToolArgs(TOOLS.find(t => t.name === name), args || {});
        if (argError) return { content: [{ type: 'text', text: `Error: ${argError}` }], isError: true };

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
