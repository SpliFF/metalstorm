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
import { resolve, join } from 'path';
import { readFileSync, existsSync, readdirSync, unlinkSync, rmdirSync, statSync } from 'fs';
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
const AUTH_USER = process.env.SPRING_USER || 'admin';
const AUTH_PASS = process.env.SPRING_PASS || 'admin';

// --- Auth token cache ---
let authToken = process.env.SPRING_TOKEN || '';

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
    try {
        const resp = await fetch(`${LOBBY_URL}/api/auth/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: AUTH_USER, password: AUTH_PASS }),
        });
        if (resp.ok) {
            const data = await resp.json();
            if (data.token) { authToken = data.token; return authToken; }
        }
    } catch { /* fall through */ }
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

// --- HTTP helpers ---
async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    return resp.json();
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
        description: 'Get current game state summary (frame, teams, unit count) from the game server.',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room/game server ID (auto-detected if omitted)' },
            },
        },
    },
    {
        name: 'list_units',
        description: 'List units in the game, optionally filtered by team.',
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
        description: 'List all game server processes (from SQLite database).',
        inputSchema: {
            type: 'object',
            properties: {},
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
                query: { type: 'string', description: 'SQL query (read-only — INSERT/UPDATE/DELETE rejected)' },
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
        description: 'Force-kill the spring-server process for a room (SIGKILL). Use when restart_game cannot reach the server (e.g. stuck in "starting" state). The lobby will mark the room ended on its next health-check cycle.',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID (0 or omit for first non-ended game)' },
            },
        },
    },
    {
        name: 'launch_game',
        description: 'Launch a fresh game directly via the lobby HTTP API — bypasses the lobby UI. Creates a room (or reuses existing one for the user), adds an AI slot, marks the host ready, and starts the game. Returns the new room ID and gameServerPort once the spring-server has spawned.',
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
        description: 'Spawn one or more units of a given def at a world XZ position on a team. Wraps the LuaExecEngine `server spawn` verb (which delegates to Spring.CreateUnit on the LuaRules synced state, so Allow* veto rules apply). Y is auto-resolved via Spring.GetGroundHeight. When count > 1 the server lays them out in a square grid 48 elmos apart.',
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
        description: 'Dump health, position, team, weapons, and per-weapon target/range/reload state for a single unit. Reads sim state directly (no Lua round-trip).',
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
        description: 'Quick-look queue depths for combat events, sound events, and unit deaths still pending broadcast. Useful for sanity-checking that combat is actually happening.',
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
        description: 'Spawn one or more units at the current browser camera\'s look-at position. The camera lives in the browser, so this tool emits a `mcp__chrome-devtools__evaluate_script` snippet that reads `window.test.cameraPose().lookAt` and forwards to the server `spawn` verb via `window.test.spawn(...)`. Pattern matches `browser_test` — feed the returned snippet into chrome-devtools eval. Requires a game tab in focus with `startGame()` complete.',
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
        description: 'Generate the chrome-devtools `evaluate_script` snippet for a TestHarness method on `window.test`. The harness lives only in the browser; this MCP tool returns the JS string for you to feed into mcp__chrome-devtools__evaluate_script. Methods: focus(unitId), focusOn(x,z), pause(), resume(), screenshot(), saveScreenshot(name), select([ids]), spawnAndFocus(def,x,z,team), stageCombat(atk,tgt,x,z), state(), units(team), unitState(id), highResScreenshot(w,h), simPause(), simResume(), simSpeed(n). Performance profiling (see docs/debugging-performance.md): perfDump(windowMs?) / perfReset() — permanent per-phase (camera/entity/fx/render/ui/total) frame-time distribution; uiProfileStart() / uiProfileDump(topN?) / uiProfileStop() — per-widget LuaUI Fengari cost breakdown (call dump BEFORE stop, not after — stop clears the data); netSim({delayMs,jitterMs,lossProb}) / netSimOff() / netSimPreset("lan"|"wan"|"intercont") / netStats() — simulate WAN conditions and tally bandwidth per message type.',
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
        description: 'Run a Lua snippet in the LuaUI widget worker (browser-side) via the chrome-devtools bridge. Use when you need to inspect WG, widgetHandler, _widgetErrors, or call any Spring.* function as the player would see it. Requires a connected browser tab; if none, returns an error and you should fall back to chrome-devtools eval directly.',
        inputSchema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'Lua code. Last expression returned via "return …".' },
            },
            required: ['code'],
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
            const result = await execOnGameServer('server', 'state', args.roomId);
            return result.output || '(no state)';
        }

        case 'list_units': {
            const cmd = args.team !== undefined && args.team >= 0
                ? `units ${args.team}` : 'units';
            const result = await execOnGameServer('server', cmd, args.roomId);
            return result.output || '(no units)';
        }

        case 'list_processes': {
            const servers = await getGameServers();
            if (!servers.length) return 'No game server processes found.';
            return servers.map(s =>
                `Room ${s.room_id}: port=${s.port}, pid=${s.pid}, state=${s.state}, game=${s.game_id || '?'}, map=${s.map_id || '?'}`
            ).join('\n');
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
            // Read-only query directly against SQLite
            const queryLower = args.query.trim().toLowerCase();
            if (queryLower.startsWith('insert') || queryLower.startsWith('update') ||
                queryLower.startsWith('delete') || queryLower.startsWith('drop') ||
                queryLower.startsWith('alter') || queryLower.startsWith('create')) {
                return 'Error: only read-only queries are allowed';
            }
            try {
                const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
                const rows = db.prepare(args.query).all();
                db.close();
                if (!rows.length) return '(empty result)';
                return JSON.stringify(rows, null, 2);
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
            const servers = await getGameServers();
            let target;
            if (args.roomId !== undefined && args.roomId > 0) {
                target = servers.find(s => s.room_id === args.roomId);
            } else {
                target = servers.find(s => s.state !== 'ended');
            }
            if (!target) {
                return `No matching game server. Available: ${servers.map(s => `room ${s.room_id} (state=${s.state}, pid=${s.pid})`).join(', ') || '(none)'}`;
            }
            const ok = killProcess(target.pid);
            return ok
                ? `Killed spring-server pid=${target.pid} for room ${target.room_id}. Lobby will mark it ended on next health check.`
                : `Failed to send SIGKILL to pid=${target.pid} (process may be gone, or owned by another user).`;
        }

        case 'launch_game': {
            // Bypass the lobby UI: create a room, optionally add an AI,
            // mark host ready, fire start. Mirrors what the browser does
            // but doesn't require a real user clicking buttons.
            const username = args.username || AUTH_USER;
            const password = args.password || AUTH_PASS;

            // Authenticate as the requested user (separate from MCP's
            // long-lived admin session — startGame requires the host).
            let userToken = '';
            for (const path of ['/api/auth/login', '/api/auth/register']) {
                try {
                    const r = await fetch(`${LOBBY_URL}${path}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password }),
                    });
                    if (r.ok) {
                        const j = await r.json();
                        if (j.token) { userToken = j.token; break; }
                    }
                } catch { /* try next */ }
            }
            if (!userToken) return `Auth failed for user "${username}".`;

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
            // before returning. The lobby flips the room Loading→Active (state 4)
            // once spring-server publishes ready=1 (game_status table). Without
            // this, callers drove the browser into a not-yet-listening QUIC port
            // and hit the connect-race / 90s defs timeout. ZK cold-start is slow,
            // so poll up to ~120s.
            const targetRoomId = started.id || room.id;
            let ready = false;
            let finalState = started.state;
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 1000));
                const lr = await fetch(`${LOBBY_URL}/api/rooms`, { headers: authHdr });
                if (!lr.ok) continue;
                let list;
                try { list = await lr.json(); } catch { continue; }
                const me = (Array.isArray(list) ? list : []).find((r) => r.id === targetRoomId);
                if (!me) continue;               // room gone (server died on boot)
                finalState = me.state;
                if (me.state >= 4) { ready = true; break; }   // 4 = Active = ready
            }

            // Suggested browser URL. Unless the caller is specifically
            // testing the startup commander-chooser, disable it so the view
            // is clear on launch (the client reads ?disableWidgets=).
            const disable = args.testStartupSelector ? '' :
                `?disableWidgets=${encodeURIComponent(STARTUP_SELECTOR_WIDGET)}`;
            const browserUrl = `${CLIENT_URL}/${disable}`;

            return JSON.stringify({
                roomId: targetRoomId,
                gameServerPort: started.gameServerPort,
                gameId: args.gameId || 'zk',
                mapId: args.mapId,
                state: finalState,
                ready,
                hint: ready
                    ? 'Game server is accepting connections (room Active). Open browserUrl to view — it disables the ZK commander-selector overlay (pass testStartupSelector=true to keep it).'
                    : 'WARNING: game server did not report ready within 120s (still warming or failed to boot). Check list_processes / get_logs before connecting a browser.',
                browserUrl,
            }, null, 2);
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
            return [
                `Spawn-at-camera: paste this into mcp__chrome-devtools__evaluate_script:`,
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
            return [
                `Browser-side TestHarness call. Feed this into mcp__chrome-devtools__evaluate_script:`,
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
            return [
                '`evaluate_widget_lua` is a stub: the LuaUI worker runs in the browser, not on the game server.',
                'Use `mcp__chrome-devtools__evaluate_script` instead with the snippet:',
                '',
                '  () => window.widgets.eval(`' + args.code.replace(/`/g, '\\`') + '`)',
                '',
                'When CDP is added to spring-debug a real implementation will replace this.',
            ].join('\n');
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
