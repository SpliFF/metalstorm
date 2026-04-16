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
import { resolve } from 'path';

const LOG_SERVER_URL = process.env.LOG_SERVER_URL || 'http://localhost:8010';
const LOBBY_URL = process.env.LOBBY_URL || 'http://localhost:8011';
const DB_PATH = process.env.SPRING_DB || resolve(process.env.PROJECT_ROOT || '.', 'data/spring-server.db');
const AUTH_USER = process.env.SPRING_USER || 'admin';
const AUTH_PASS = process.env.SPRING_PASS || 'admin';

// --- Auth token cache ---
let authToken = process.env.SPRING_TOKEN || '';

async function ensureAuth() {
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

// --- SQLite game server discovery ---
function getGameServers() {
    try {
        const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
        const rows = db.prepare('SELECT room_id, port, pid, map_id, game_id, state FROM game_servers').all();
        db.close();
        return rows;
    } catch {
        return [];
    }
}

function getGameServerUrl(roomId) {
    const servers = getGameServers();
    let server;
    if (roomId !== undefined && roomId > 0) {
        server = servers.find(s => s.room_id === roomId);
    } else {
        // Pick the first active (starting/running) server
        server = servers.find(s => s.state === 'starting' || s.state === 'running');
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

async function execOnServer(serverUrl, scope, code) {
    const token = await ensureAuth();
    if (!token) throw new Error('Not authenticated — set SPRING_TOKEN or SPRING_USER/SPRING_PASS');
    const resp = await fetch(`${serverUrl}/api/exec`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ scope, code }),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`exec failed (${resp.status}): ${text}`);
    }
    return resp.json();
}

async function execOnGameServer(scope, code, roomId) {
    const server = getGameServerUrl(roomId);
    if (!server) {
        const servers = getGameServers();
        if (servers.length === 0) {
            throw new Error('No game servers found in database. Is a game running?');
        }
        throw new Error(`No active game server found. Available: ${servers.map(s => `room ${s.room_id} (${s.state})`).join(', ')}`);
    }
    return execOnServer(server.url, scope, code);
}

// --- Tool definitions ---
const TOOLS = [
    {
        name: 'get_logs',
        description: 'Get recent log entries from the log server. Returns structured log entries with level, section, scope, process, frame, and message.',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID (0 for all)', default: 0 },
                level: { type: 'number', description: 'Minimum log level (0=DEBUG, 2=NOTICE, 4=ERROR)', default: 0 },
                section: { type: 'string', description: 'Filter by section (e.g. "lua", "sim", "server")' },
                scope: { type: 'string', description: 'Filter by scope (e.g. "LuaRules", "LuaGaia")' },
                limit: { type: 'number', description: 'Max entries to return', default: 50 },
            },
        },
    },
    {
        name: 'search_logs',
        description: 'Full-text search across all log entries. Use this to find specific errors, warnings, or patterns in game/sim logs.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search text (matches against message content)' },
                roomId: { type: 'number', description: 'Room ID (0 for all)' },
                level: { type: 'number', description: 'Minimum log level' },
                limit: { type: 'number', description: 'Max entries', default: 50 },
            },
            required: ['query'],
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
        description: 'Restart the lobby server in-place (re-exec with same args). Running game servers are preserved. Use after rebuilding spring-lobby.',
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
];

// --- Tool execution ---
async function executeTool(name, args) {
    switch (name) {
        case 'get_logs': {
            const params = new URLSearchParams();
            if (args.level) params.set('level', String(args.level));
            if (args.section) params.set('section', args.section);
            if (args.scope) params.set('scope', args.scope);
            if (args.limit) params.set('limit', String(args.limit));
            const roomId = args.roomId || 0;
            const url = `${LOG_SERVER_URL}/api/logs/${roomId}?${params}`;
            const data = await fetchJson(url);
            return formatLogEntries(data);
        }

        case 'search_logs': {
            const params = new URLSearchParams();
            params.set('q', args.query);
            if (args.level) params.set('level', String(args.level));
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
            const servers = getGameServers();
            if (!servers.length) return 'No game server processes found in database.';
            return servers.map(s =>
                `Room ${s.room_id}: port=${s.port}, pid=${s.pid}, state=${s.state}, game=${s.game_id || '?'}, map=${s.map_id || '?'}`
            ).join('\n');
        }

        case 'get_lua_source': {
            const url = `${LOBBY_URL}/api/games/data/${args.gameId}/${args.filePath}`;
            const resp = await fetch(url);
            if (!resp.ok) return `Error: HTTP ${resp.status} fetching ${args.filePath}`;
            return await resp.text();
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

        case 'restart_game': {
            const server = getGameServerUrl(args.roomId);
            if (!server) {
                const servers = getGameServers();
                if (servers.length === 0)
                    return 'No game servers found in database. Is a game running?';
                return `No active game server found. Available: ${servers.map(s => `room ${s.room_id} (${s.state})`).join(', ')}`;
            }
            const token = await ensureAuth();
            const resp = await fetch(`${server.url}/api/restart`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
                },
            });
            if (!resp.ok) {
                const text = await resp.text();
                return `Restart failed (${resp.status}): ${text}`;
            }
            return `Restart command sent to game server on port ${server.port} (room ${server.room_id}).`;
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
        return `${frame}[${level}] [${e.process}:${e.section}${scope}] ${e.message}`;
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
