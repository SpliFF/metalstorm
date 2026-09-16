// ai-tools.js — read and steer the in-game AI players.
//
// WHY THIS EXISTS. Everything these tools report already exists in the sim, in
// synced Lua: the roster (who is an AI), the rulesParams the AI brain writes
// its vitals into, Spring.GetDirectives / Spring.GetOrgGroups, and the
// guidance store. Getting at it meant hand-writing a Lua one-liner into
// exec_lua per question and eyeballing whatever `print` produced. These tools
// run the SAME programs every time (lua-snippets.js — fengari-tested against a
// fake Spring, so a snippet cannot rot silently) and answer JSON.
//
// The one WRITE here is ai_guidance, and it deliberately takes the long way
// round: it encodes the guidance into the gadget's own RecvLuaMsg wire format
// (guidance-wire.js, byte-pinned against the shared fixture the TS and Lua
// sides use) and delivers it THROUGH gadgetHandler:RecvLuaMsg as a player
// seated on the team. It therefore exercises the same path a browser does —
// including the gadget's validation — instead of poking the store directly and
// producing a state the real path could never reach.

import {
    aiListLua, aiHealthLua, aiDirectivesLua, guidanceSendLua, nlContextLua,
    AI_HEALTH_TEAM_PARAMS, AI_HEALTH_PLAYER_PARAMS,
} from './lua-snippets.js';
import { encodeGuidance, GUIDANCE_OPS, GUIDANCE_VALUES } from './guidance-wire.js';

/**
 * Run one snippet in LuaRules and parse its JSON. Every snippet in
 * lua-snippets.js returns a JSON string, so a non-JSON answer means the Lua
 * itself failed (a runtime error comes back as `output`) — surface that text
 * rather than a parser message about position 0.
 */
export async function runSnippet(io, code, roomId, label) {
    const result = await io.execLua('LuaRules', code, roomId);
    if (!result || !result.success)
        return { error: `Error: ${label} exec failed: ${(result && result.output) || 'no output'}` };
    const output = String(result.output ?? '');
    if (!output.trim()) return { error: `Error: ${label} returned nothing — is LuaRules running in this room?` };
    try {
        return { json: JSON.parse(output) };
    } catch {
        return { error: `Error: ${label} did not return JSON (the snippet errored): ${output.slice(0, 500)}` };
    }
}

/** Snippets report their own refusals as `{error}`; hoist those to the tool. */
function unwrap(r) {
    if (r.error) return r.error;
    if (r.json && typeof r.json === 'object' && r.json.error) return `Error: ${r.json.error}`;
    return null;
}

const teamArg = { type: 'number', description: 'Restrict to one team id. Omit for every team.' };
const roomArg = { type: 'number', description: 'Room id (game instance). Omit to auto-pick the single live room.' };

export const AI_TOOLS = [
    {
        name: 'ai_list',
        description: 'Who is playing, and which of them are AIs. Per team: the full player roster with AI virtual players flagged, each AI\'s profile and authority pool, the team\'s active-human count, leader, team profile and pool, plus allyTeam/side/dead. This is the first call for "is an AI actually seated on team 2" — an AI that failed to spawn shows up as a team with no AI rows, not as an error.',
        inputSchema: { type: 'object', properties: { team: teamArg, roomId: roomArg } },
    },
    {
        name: 'ai_health',
        description: 'Vitals for every team that seats an AI: which rulesParams the brain has written and which are MISSING BY NAME (a brain that never started leaves the whole list missing — that absence is the diagnosis), a summary of the guidance in force, and directive/org-group counts. Feature-detected against these team params: '
            + AI_HEALTH_TEAM_PARAMS.join(', ') + '; and per AI: ' + AI_HEALTH_PLAYER_PARAMS.join(', ')
            + '. There is no single "ai_health" param in the tree — this tool composes the answer.',
        inputSchema: { type: 'object', properties: { team: teamArg, roomId: roomArg } },
    },
    {
        name: 'ai_directives',
        description: 'The engine directives in flight per team (type, params, conditions) and, unless includeGroups:false, the org groups with their members and current directive. Answers a clear error on an engine built without macro-orders (no Spring.GetDirectives) rather than an empty list, because "no directives" and "this engine cannot have directives" are different bugs.',
        inputSchema: {
            type: 'object',
            properties: {
                team: teamArg,
                includeGroups: { type: 'boolean', description: 'Include org groups', default: true },
                roomId: roomArg,
            },
        },
    },
    {
        name: 'ai_guidance',
        description: 'Send ONE guidance order to a team\'s AI, exactly as the browser would: the order is encoded into game_ai_guidance.lua\'s RecvLuaMsg wire format and delivered through gadgetHandler as a player seated on the team (a human is preferred; pass playerId to choose). Ops — '
            + GUIDANCE_OPS.join(', ') + '. `stance` (' + GUIDANCE_VALUES.stance.join('/') + '), `roe` (' + GUIDANCE_VALUES.roe.join('/')
            + '), `paint` (regionKey + ' + GUIDANCE_VALUES.paint.join('/') + '), `lock` (groupId, value on/off), `delegate` (objectiveId, value on/off), `fund` (amount — a one-shot gift from the SENDER\'s own pool — and/or rateCap, a standing per-minute team allowance), `veto` (goalId, holds 5 minutes). Reports whether the gadget\'s change sequence actually moved: applied:false means the gadget REJECTED it, which is the answer you want.',
        inputSchema: {
            type: 'object',
            properties: {
                op: { type: 'string', description: 'Which guidance op', enum: GUIDANCE_OPS },
                value: { type: 'string', description: 'The enum value for stance/roe/paint, or on/off for lock/delegate' },
                regionKey: { type: 'string', description: 'paint: the region KEY (not its display name — nl/ai_directives print keys)' },
                groupId: { type: 'number', description: 'lock: which org group' },
                objectiveId: { type: 'number', description: 'delegate: which objective' },
                amount: { type: 'number', description: 'fund: one-shot authority transferred from the sender\'s own pool' },
                rateCap: { type: 'number', description: 'fund: standing per-minute allowance for the team\'s AIs' },
                goalId: { type: 'string', description: 'veto: a planner goal id such as "def:basin_a" or "obj:12"' },
                team: { type: 'number', description: 'Which team\'s AI to steer. Required unless playerId is given (the gadget derives the team from the SENDER).' },
                playerId: { type: 'number', description: 'Send as this player instead of auto-picking a human on the team' },
                roomId: roomArg,
            },
            required: ['op'],
        },
    },
    {
        name: 'ai_context',
        description: 'The natural-language context payload (places, org groups, enemies, objectives, class counts, authority) built from the SIM rather than from a browser. This is what nl_command sends when you do not supply a `context` — call it on its own to see what the parser will be told, which is usually why an utterance resolved to the wrong place.',
        inputSchema: {
            type: 'object',
            properties: {
                team: { type: 'number', description: 'Which team the context is for (required)' },
                roomId: roomArg,
            },
            required: ['team'],
        },
    },
];

export const aiHandlers = {
    async ai_list(args, io) {
        const r = await runSnippet(io, aiListLua(args.team), args.roomId, 'ai_list');
        return unwrap(r) || r.json;
    },

    async ai_health(args, io) {
        const r = await runSnippet(io, aiHealthLua(args.team), args.roomId, 'ai_health');
        const err = unwrap(r);
        if (err) return err;
        const teams = Array.isArray(r.json.teams) ? r.json.teams : [];
        if (!teams.length)
            return {
                summary: 'no team seats an AI in this room (pass `team` to inspect a specific team anyway)',
                ...r.json,
            };
        return {
            summary: teams.map((t) => `team ${t.team}: ${(t.params?.missing || []).length} param(s) missing`
                + `, guidance ${t.guidance?.stance || '—'}/${t.guidance?.roe || '—'}`
                + `, ${t.directives?.active ?? 0} active directive(s)`).join(' · '),
            ...r.json,
        };
    },

    async ai_directives(args, io) {
        const include = args.includeGroups !== false;
        const r = await runSnippet(io, aiDirectivesLua(args.team, include), args.roomId, 'ai_directives');
        return unwrap(r) || r.json;
    },

    async ai_guidance(args, io) {
        const encoded = encodeGuidance(args);
        if (encoded.error) return `Error: ${encoded.error}`;
        if (args.team === undefined && args.playerId === undefined)
            return 'Error: ai_guidance needs `team` (or `playerId`) — the gadget derives the target team from the SENDER, so the message has to come from somebody seated on it.';
        const code = guidanceSendLua(encoded.wire, { playerId: args.playerId, team: args.team });
        const r = await runSnippet(io, code, args.roomId, 'ai_guidance');
        const err = unwrap(r);
        if (err) return err;
        const out = r.json;
        return {
            summary: out.applied
                ? `${encoded.describe} (delivered as player ${out.playerId} on team ${out.team})`
                : `NOT APPLIED — the gadget accepted the message but its change sequence did not move `
                  + `(still ${out.changeSeqAfter}). The op was well-formed (${encoded.wire}); the gadget rejected it, `
                  + `or no guidance gadget is loaded in this room.`,
            op: args.op,
            wire: encoded.wire,
            ...out,
        };
    },

    async ai_context(args, io) {
        if (!Number.isFinite(Number(args.team))) return 'Error: ai_context needs a numeric `team`.';
        const r = await runSnippet(io, nlContextLua(Number(args.team)), args.roomId, 'ai_context');
        return unwrap(r) || r.json;
    },
};
