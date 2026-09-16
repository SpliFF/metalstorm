// nl-tools.js — put an utterance through the game's NL command parser.
//
// WHAT THIS IS AND IS NOT. `POST /api/nl/command` (on the GAME server, token
// required) turns `{utterance, context, history?}` into a validated intent
// envelope. That is ALL it does: execution is client-side, in
// client/src/ui/native-ui/nl-executor.ts. So this tool answers "what did the
// parser make of that sentence" — which is the question when a command goes to
// the wrong place — and never "make the units move". There is no programmatic
// hook to run an utterance end-to-end in a live client (command-console.js's
// `runUtteranceText` is file-local); exposing `window.test.nl()` is an
// out-of-lane ask recorded in docs/reviews/2026-09-10/mcp-control.md.
//
// The context is the other half of the answer. A browser builds it from its
// own UI state (selection, focus, panels); with no browser in the loop this
// tool builds an equivalent from the SIM via nlContextLua — which is why
// `team` is required when you do not pass a `context` of your own. `ai_context`
// returns that payload on its own, for when the parse is right but was told
// the wrong things.

import { nlContextLua } from './lua-snippets.js';
import { runSnippet } from './ai-tools.js';

// Mirrors of the server's own caps (rts/Server/NlProxy.h). Checked here so a
// too-long utterance is named as such instead of coming back as a 400 code
// after a round trip, and so the 16 KB body cap refuses a giant hand-built
// context BEFORE it is sent rather than after.
export const NL_MAX_UTTERANCE_CHARS = 500;
export const NL_MAX_HISTORY = 4;
export const NL_MAX_BODY_BYTES = 16 * 1024;

// The parse is a real model call (1–3 s, deferred to a worker server-side), so
// this fetch brings its own deadline instead of taking the module default.
const NL_TIMEOUT_MS = 30000;

/** The refusals the route can answer with, and what to do about each. */
export const NL_ERROR_HELP = {
    'nl-disabled': 'the game server has no SPRING_NL_API_KEY / ANTHROPIC_API_KEY, so the route is registered but off. Set one and restart that game server — it is NOT compiled out',
    'nl-rate-limited': 'this account is over the per-user rate limit; the response carries a retry hint',
    'nl-busy': 'too many parses already in flight on that game server — retry shortly',
    'bad-json': 'the body was not a JSON object',
    'missing-utterance': 'no `utterance` string in the body',
    'empty-utterance': 'the utterance was blank or whitespace only',
    'utterance-too-long': `the utterance exceeds ${NL_MAX_UTTERANCE_CHARS} characters`,
    'missing-context': 'no `context` object — pass `team` and this tool builds one from the sim',
    'bad-history': '`history` must be an array of strings',
    'history-too-long': `history holds at most ${NL_MAX_HISTORY} entries, each under ${NL_MAX_UTTERANCE_CHARS} characters`,
    'body-too-large': `the request body exceeds the ${NL_MAX_BODY_BYTES / 1024} KB cap — trim the context`,
};

export const NL_TOOLS = [
    {
        name: 'nl_command',
        description: 'Parse a natural-language order through the game\'s NL command proxy and return the intent envelope. This is a PARSE, not an execution: the envelope is what a client would then run (nl-executor.ts), and nothing in the sim changes. Use it to see how an utterance resolves — which place, which group, which verb — and pass `focus`/`context` to reproduce what a specific player would have sent. With no `context`, one is built from the sim for `team` (the same payload ai_context returns), so a parse that picks the wrong region is usually a context problem, not a model problem. Refuses with nl-disabled (503) when that game server has no API key configured.',
        inputSchema: {
            type: 'object',
            properties: {
                utterance: { type: 'string', description: `What the player said, up to ${NL_MAX_UTTERANCE_CHARS} characters` },
                team: { type: 'number', description: 'Whose point of view to parse from — used to build the context. Required unless you pass `context`.' },
                roomId: { type: 'number', description: 'Room id (game instance). Omit to auto-pick the single live room.' },
                context: { type: 'object', description: 'A context payload to send verbatim instead of building one from the sim (the §2 shape: places, groups, enemies, objectives, classes, panels, self)' },
                focus: { type: 'object', description: 'Merged into the context as `focus` — what the player is looking at. A browser sends its camera/selection focus; there is none without one.' },
                history: {
                    type: 'array',
                    description: `Prior turns for follow-ups like "now send them north" (at most ${NL_MAX_HISTORY} strings)`,
                    items: { type: 'string' },
                },
                revealContext: { type: 'boolean', description: 'Also return the context that was sent (large)', default: false },
            },
            required: ['utterance'],
        },
    },
];

export const nlHandlers = {
    async nl_command(args, io) {
        const utterance = typeof args.utterance === 'string' ? args.utterance.trim() : '';
        if (!utterance) return 'Error: nl_command needs a non-empty `utterance`.';
        if (utterance.length > NL_MAX_UTTERANCE_CHARS)
            return `Error: nl_command utterance is ${utterance.length} characters; the server caps it at ${NL_MAX_UTTERANCE_CHARS}.`;

        let history;
        if (args.history !== undefined) {
            if (!Array.isArray(args.history) || args.history.some((h) => typeof h !== 'string'))
                return 'Error: nl_command `history` must be an array of strings.';
            if (args.history.length > NL_MAX_HISTORY)
                return `Error: nl_command history holds at most ${NL_MAX_HISTORY} entries (got ${args.history.length}).`;
            history = args.history;
        }

        // Context: supplied verbatim, or built from the sim for `team`.
        let context = args.context;
        if (context === undefined) {
            if (!Number.isFinite(Number(args.team)))
                return 'Error: nl_command needs `team` (to build the context from the sim) or an explicit `context` object.';
            const r = await runSnippet(io, nlContextLua(Number(args.team)), args.roomId, 'nl_command context');
            if (r.error) return r.error;
            if (r.json && r.json.error) return `Error: could not build NL context: ${r.json.error}`;
            context = r.json;
        } else if (typeof context !== 'object' || Array.isArray(context)) {
            return 'Error: nl_command `context` must be an object.';
        }
        if (args.focus !== undefined) context = { ...context, focus: args.focus };

        const body = { utterance, context };
        if (history) body.history = history;
        const payload = JSON.stringify(body);
        if (Buffer.byteLength(payload) > NL_MAX_BODY_BYTES)
            return `Error: nl_command body is ${Buffer.byteLength(payload)} bytes; the server caps it at ${NL_MAX_BODY_BYTES}. Trim the context.`;

        // The route lives on the GAME server, not the lobby — the parser needs
        // the game's own key and rate-limit bucket.
        const { server, error } = await io.resolveServer(args.roomId);
        if (error) return `Error: ${error}`;

        const resp = await io.authedFetch((token) => io.fetch(`${server.url}/api/nl/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: payload,
            signal: AbortSignal.timeout(NL_TIMEOUT_MS),
        }));
        const text = await resp.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        if (!resp.ok) {
            const code = parsed && typeof parsed === 'object' ? (parsed.error || parsed.code) : undefined;
            const help = code && NL_ERROR_HELP[code];
            return `Error: POST /api/nl/command ${resp.status}${code ? ` ${code}` : ''}`
                + (help ? ` — ${help}` : ` — ${text.slice(0, 300)}`);
        }
        return {
            summary: `parsed "${utterance}" for room ${server.room_id ?? '?'}`
                + ' — this is the envelope only; nothing in the sim changed (execution is client-side, nl-executor.ts).',
            utterance,
            envelope: parsed,
            ...(args.revealContext ? { context } : {}),
        };
    },
};
