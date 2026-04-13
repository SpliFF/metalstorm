#!/usr/bin/env node
/**
 * Spring RTS Debug MCP Server
 *
 * Provides Claude with tools to query logs, execute Lua/commands,
 * inspect game state, and manage processes — all via the log server
 * HTTP API and lobby WebSocket.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const LOG_SERVER_URL = process.env.LOG_SERVER_URL || 'http://localhost:8010';
const LOBBY_URL = process.env.LOBBY_URL || 'http://localhost:8011';

// --- HTTP helpers ---
async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    return resp.json();
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
        description: 'Execute Lua code in a specific scope on the game server. Use scope "LuaRules" for game-wide gadgets, "LuaGaia" for map gadgets. Expressions are auto-wrapped in "return" for convenience.',
        inputSchema: {
            type: 'object',
            properties: {
                scope: { type: 'string', description: 'Lua scope', enum: ['LuaRules', 'LuaGaia', 'server'] },
                code: { type: 'string', description: 'Lua code or server command to execute' },
                roomId: { type: 'number', description: 'Room ID (for future multi-game support)' },
            },
            required: ['scope', 'code'],
        },
    },
    {
        name: 'get_game_state',
        description: 'Get current game state summary (frame, teams, unit count).',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID' },
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
                roomId: { type: 'number', description: 'Room ID' },
            },
        },
    },
    {
        name: 'list_processes',
        description: 'List all game server processes managed by the lobby.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'get_lua_source',
        description: 'Read a Lua source file from the game content directory. Useful for reading gadget source when debugging Lua errors.',
        inputSchema: {
            type: 'object',
            properties: {
                gamePath: { type: 'string', description: 'Game path (e.g. "content/games/papertanks")' },
                filePath: { type: 'string', description: 'File path relative to game root (e.g. "LuaRules/Gadgets/unit_spawner.lua")' },
            },
            required: ['gamePath', 'filePath'],
        },
    },
    {
        name: 'list_gadgets',
        description: 'List loaded Lua gadgets and their status.',
        inputSchema: {
            type: 'object',
            properties: {
                roomId: { type: 'number', description: 'Room ID' },
            },
        },
    },
    {
        name: 'query_db',
        description: 'Execute a read-only SQL query against the game database (via lobby) or debug database (via log server).',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'SQL query (read-only)' },
                db: { type: 'string', description: 'Database: "game" or "debug"', enum: ['game', 'debug'], default: 'game' },
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
            if (args.roomId) params.set('roomId', String(args.roomId));
            if (args.level) params.set('level', String(args.level));
            if (args.limit) params.set('limit', String(args.limit));
            const url = `${LOG_SERVER_URL}/api/logs/search?${params}`;
            const data = await fetchJson(url);
            return formatLogEntries(data);
        }

        case 'exec_lua': {
            // For now, use the lobby HTTP as a proxy
            // In the future this could go direct to game server WS
            return `exec_lua: scope=${args.scope}, code="${args.code}" — requires WebSocket connection (not yet implemented in MCP server)`;
        }

        case 'get_game_state': {
            return `get_game_state — requires WebSocket exec of "state" in server scope`;
        }

        case 'list_units': {
            const cmd = args.team >= 0 ? `units ${args.team}` : 'units';
            return `list_units: would exec "${cmd}" in server scope`;
        }

        case 'list_processes': {
            const url = `${LOBBY_URL}/api/processes`;
            const data = await fetchJson(url);
            if (!data.length) return 'No game server processes running.';
            return data.map(p =>
                `Room ${p.room_id}: pid=${p.pid}, port=${p.port}, state=${p.state}, game=${p.game}, map=${p.map}`
            ).join('\n');
        }

        case 'get_lua_source': {
            const fs = await import('fs');
            const path = await import('path');
            const fullPath = path.join(args.gamePath, args.filePath);
            try {
                const content = fs.readFileSync(fullPath, 'utf-8');
                return content;
            } catch (e) {
                return `Error reading ${fullPath}: ${e.message}`;
            }
        }

        case 'list_gadgets': {
            return `list_gadgets — requires WebSocket exec of "show gadgets" in LuaRules scope`;
        }

        case 'query_db': {
            if (args.db === 'debug') {
                // Query debug.db via log server search
                return `query_db(debug): would search debug logs — use search_logs instead`;
            }
            // Query game DB via lobby sql scope — requires WS
            return `query_db(game): query="${args.query}" — requires WebSocket exec in sql scope`;
        }

        case 'list_sessions': {
            const url = `${LOG_SERVER_URL}/api/sessions`;
            const data = await fetchJson(url);
            if (!data.length) return 'No game sessions found.';
            return data.map(s =>
                `${s.session_id}: room=${s.room_id} game=${s.game_name} map=${s.map_name} ` +
                `reason=${s.end_reason || 'running'} exit=${s.exit_code || '-'}`
            ).join('\n');
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
