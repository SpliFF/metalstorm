import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeExecLua } from './lua-fake-env.js';
import { fakeIo } from './tool-io-fake.js';
import { AI_TOOLS, aiHandlers, runSnippet } from './ai-tools.js';

/** An io whose execLua really runs the snippet against the fake Spring. */
function luaIo(extra = {}) {
    const { execLua, calls } = fakeExecLua();
    const { io } = fakeIo({}, { execLua, ...extra });
    return { io, calls };
}

test('ai_list: the roster, with AI virtual players annotated — and it runs in LuaRules', async () => {
    const { io, calls } = luaIo();
    const out = await aiHandlers.ai_list({ roomId: 5 }, io);
    assert.equal(calls[0].scope, 'LuaRules');
    assert.equal(calls[0].roomId, 5);
    assert.equal(out.teams.length, 2);
    const t1 = out.teams.find((t) => t.team === 1);
    assert.equal(t1.ais[0].name, 'strategos');
    assert.equal(t1.ais[0].profile, 'caretaker');
    assert.equal((await aiHandlers.ai_list({ team: 2 }, io)).teams.length, 1);
});

test('ai_health: summarises missing params by team; an AI-less room says so instead of answering {}', async () => {
    const { io } = luaIo();
    const out = await aiHandlers.ai_health({}, io);
    assert.match(out.summary, /team 1: \d+ param\(s\) missing/);
    assert.match(out.summary, /guidance balanced\/free/);

    // A room where nothing seats an AI: the snippet returns teams:[] and the
    // tool must NAME that, because "no AI" and "AI crashed" look identical in
    // an empty object.
    const { io: empty } = fakeIo({}, { execLua: async () => ({ success: true, output: '{"frame":1,"teams":[]}' }) });
    assert.match((await aiHandlers.ai_health({}, empty)).summary, /no team seats an AI/);
});

test('ai_directives: groups by default, suppressed by includeGroups:false', async () => {
    const { io } = luaIo();
    assert.equal((await aiHandlers.ai_directives({ team: 1 }, io)).teams[0].groups[0].name, '3rd Tanks');
    assert.equal((await aiHandlers.ai_directives({ team: 1, includeGroups: false }, io)).teams[0].groups, undefined);
});

test('ai_context: the sim-built NL context, and a missing team is refused locally', async () => {
    const { io, calls } = luaIo();
    const out = await aiHandlers.ai_context({ team: 1 }, io);
    assert.deepEqual(out.places.map((p) => p.n), ['Basin A', 'North Gate']);
    assert.equal(out.self.authority, 640);
    assert.match(await aiHandlers.ai_context({}, io), /needs a numeric `team`/);
    assert.equal(calls.length, 1, 'the refusal must not run Lua');
});

test('ai_guidance: encodes the wire, delivers through RecvLuaMsg, and reports applied', async () => {
    const { io, calls } = luaIo();
    const out = await aiHandlers.ai_guidance({ op: 'stance', value: 'aggressive', team: 1 }, io);
    assert.equal(out.wire, 'cmd=guidance.stance&value=aggressive');
    assert.equal(out.applied, true);
    assert.equal(out.playerId, 0, 'delivered as the human on team 1');
    assert.match(out.summary, /AI stance is now aggressive \(delivered as player 0 on team 1\)/);
    assert.ok(calls[0].code.includes('gadgetHandler:RecvLuaMsg'), 'must go through the gadget, not the store');
});

test('ai_guidance: a bad op or a missing field is refused by the encoder, before any exec', async () => {
    const { io, calls } = luaIo();
    assert.match(await aiHandlers.ai_guidance({ op: 'stance', value: 'sideways', team: 1 }, io), /stance value must be one of/);
    assert.match(await aiHandlers.ai_guidance({ op: 'paint', value: 'priority', team: 1 }, io), /paint needs `regionKey`/);
    assert.match(await aiHandlers.ai_guidance({ op: 'fly', team: 1 }, io), /unknown op "fly"/);
    assert.match(await aiHandlers.ai_guidance({ op: 'veto' }, io), /needs `goalId`/);
    assert.equal(calls.length, 0);
});

test('ai_guidance: neither team nor playerId is refused with the reason (the gadget reads the SENDER)', async () => {
    const { io, calls } = luaIo();
    assert.match(await aiHandlers.ai_guidance({ op: 'stance', value: 'balanced' }, io), /derives the target team from the SENDER/);
    assert.equal(calls.length, 0);
});

test('ai_guidance: a gadget that swallowed the message reports NOT APPLIED rather than success', async () => {
    const { io } = fakeIo({}, {
        execLua: async () => ({ success: true, output: JSON.stringify({ playerId: 0, team: 1, changeSeqBefore: 3, changeSeqAfter: 3, applied: false }) }),
    });
    const out = await aiHandlers.ai_guidance({ op: 'roe', value: 'free', team: 1 }, io);
    assert.match(out.summary, /NOT APPLIED/);
    assert.match(out.summary, /the gadget rejected it/);
});

test('snippet failures are named, not turned into a JSON parser message', async () => {
    const bad = fakeIo({}, { execLua: async () => ({ success: false, output: 'LuaRules: attempt to index a nil value' }) }).io;
    assert.match(await aiHandlers.ai_list({}, bad), /ai_list exec failed: LuaRules: attempt to index/);

    const empty = fakeIo({}, { execLua: async () => ({ success: true, output: '   ' }) }).io;
    assert.match(await aiHandlers.ai_list({}, empty), /returned nothing — is LuaRules running/);

    const junk = fakeIo({}, { execLua: async () => ({ success: true, output: 'error: nope' }) }).io;
    assert.match(await aiHandlers.ai_list({}, junk), /did not return JSON \(the snippet errored\): error: nope/);

    const nothing = fakeIo({}, { execLua: async () => undefined }).io;
    assert.match((await runSnippet(nothing, 'return "x"', 1, 'probe')).error, /probe exec failed/);
});

test('a snippet that refuses itself ({error}) surfaces as the tool error', async () => {
    const io = fakeIo({}, { execLua: async () => ({ success: true, output: '{"error":"this engine has no Spring.GetDirectives"}' }) }).io;
    assert.match(await aiHandlers.ai_directives({}, io), /Error: this engine has no Spring.GetDirectives/);
});

test('every AI_TOOL has a handler, and every handler has a schema', () => {
    for (const t of AI_TOOLS) assert.ok(aiHandlers[t.name], `${t.name} has no handler`);
    for (const name of Object.keys(aiHandlers))
        assert.ok(AI_TOOLS.some((t) => t.name === name), `${name} has no schema`);
});
