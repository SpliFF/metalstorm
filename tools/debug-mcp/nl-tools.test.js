import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeExecLua } from './lua-fake-env.js';
import { fakeIo } from './tool-io-fake.js';
import { NL_TOOLS, nlHandlers, NL_MAX_UTTERANCE_CHARS, NL_MAX_HISTORY, NL_MAX_BODY_BYTES } from './nl-tools.js';

const ENVELOPE = { intent: 'move', target: { kind: 'region', key: 'basin_a' }, confidence: 0.9 };

function nlIo(route = { body: ENVELOPE }, opts = {}) {
    const { execLua } = fakeExecLua();
    return fakeIo({ 'POST /api/nl/command': route }, { execLua, ...opts });
}

test('nl_command: builds the context from the sim, posts to the GAME server, returns the envelope only', async () => {
    const { io, calls } = nlIo();
    const out = await nlHandlers.nl_command({ utterance: 'take the basin', team: 1, roomId: 5 }, io);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://game.test:9100/api/nl/command');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer TOKEN-abc');
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.utterance, 'take the basin');
    assert.deepEqual(sent.context.places.map((p) => p.n), ['Basin A', 'North Gate']);
    assert.deepEqual(out.envelope, ENVELOPE);
    assert.match(out.summary, /envelope only; nothing in the sim changed/);
    assert.equal(out.context, undefined, 'the context is large — only returned on request');
});

test('nl_command: an explicit context is sent verbatim and no Lua runs', async () => {
    const { execLua, calls: lua } = fakeExecLua();
    const { io, calls } = fakeIo({ 'POST /api/nl/command': { body: ENVELOPE } }, { execLua });
    const context = { places: [{ n: 'Elsewhere', t: 'region', key: 'x' }], self: {} };
    const out = await nlHandlers.nl_command({ utterance: 'go', context, revealContext: true }, io);
    assert.equal(lua.length, 0, 'an explicit context must not build one from the sim');
    assert.deepEqual(JSON.parse(calls[0].init.body).context, context);
    assert.deepEqual(out.context, context);
});

test('nl_command: focus is merged onto the context (a browser has one; we do not)', async () => {
    const { io, calls } = nlIo();
    await nlHandlers.nl_command({ utterance: 'attack that', team: 1, focus: { unitId: 100 } }, io);
    assert.deepEqual(JSON.parse(calls[0].init.body).context.focus, { unitId: 100 });
});

test('nl_command: no context and no team is refused before any call', async () => {
    const { io, calls } = nlIo();
    assert.match(await nlHandlers.nl_command({ utterance: 'go' }, io), /needs `team`.*or an explicit `context`/s);
    assert.equal(calls.length, 0);
});

test('nl_command mirrors the server caps locally, so a refusal names the field', async () => {
    const { io, calls } = nlIo();
    assert.match(await nlHandlers.nl_command({ utterance: '   ' }, io), /non-empty `utterance`/);
    assert.match(await nlHandlers.nl_command({ utterance: 'x'.repeat(NL_MAX_UTTERANCE_CHARS + 1), team: 1 }, io),
        new RegExp(`caps it at ${NL_MAX_UTTERANCE_CHARS}`));
    assert.match(await nlHandlers.nl_command({ utterance: 'go', team: 1, history: 'nope' }, io), /must be an array of strings/);
    assert.match(await nlHandlers.nl_command({ utterance: 'go', team: 1, history: [1] }, io), /must be an array of strings/);
    assert.match(await nlHandlers.nl_command({ utterance: 'go', team: 1, history: Array(NL_MAX_HISTORY + 1).fill('a') }, io),
        new RegExp(`at most ${NL_MAX_HISTORY} entries`));
    assert.match(await nlHandlers.nl_command({ utterance: 'go', context: [] }, io), /`context` must be an object/);
    assert.equal(calls.length, 0, 'every one of those must be refused before the round trip');
});

test('nl_command: an oversized body is refused rather than sent to be 413d', async () => {
    const { io, calls } = nlIo();
    const context = { blob: 'x'.repeat(NL_MAX_BODY_BYTES) };
    const out = await nlHandlers.nl_command({ utterance: 'go', context }, io);
    assert.match(out, new RegExp(`caps it at ${NL_MAX_BODY_BYTES}`));
    assert.equal(calls.length, 0);
});

test('nl_command: history rides along when it is legal', async () => {
    const { io, calls } = nlIo();
    await nlHandlers.nl_command({ utterance: 'now send them north', team: 1, history: ['take the basin'] }, io);
    assert.deepEqual(JSON.parse(calls[0].init.body).history, ['take the basin']);
});

test('nl_command: nl-disabled is explained as "no key on that game server", not as a crash', async () => {
    const { io } = nlIo({ status: 503, body: { error: 'nl-disabled' } });
    const out = await nlHandlers.nl_command({ utterance: 'go', team: 1 }, io);
    assert.match(out, /503 nl-disabled/);
    assert.match(out, /SPRING_NL_API_KEY/);
    assert.match(out, /NOT compiled out/);
});

test('nl_command: the other documented refusals each get their sentence', async () => {
    for (const [status, code, expect] of [
        [429, 'nl-rate-limited', /rate limit/],
        [503, 'nl-busy', /already in flight/],
        [400, 'missing-context', /pass `team`/],
        [413, 'body-too-large', /KB cap/],
    ]) {
        const { io } = nlIo({ status, body: { error: code } });
        assert.match(await nlHandlers.nl_command({ utterance: 'go', team: 1 }, io), expect, code);
    }
});

test('nl_command: an unmapped failure still shows the body', async () => {
    const { io } = nlIo({ status: 500, body: 'internal error' });
    assert.match(await nlHandlers.nl_command({ utterance: 'go', team: 1 }, io), /500 — internal error/);
});

test('nl_command: an unresolvable room is reported as such (the route is on the game server)', async () => {
    const { execLua } = fakeExecLua();
    const { io } = fakeIo({}, { execLua, resolveServer: async () => ({ error: 'room 7 has ended' }) });
    assert.match(await nlHandlers.nl_command({ utterance: 'go', team: 1, roomId: 7 }, io), /Error: room 7 has ended/);
});

test('nl_command: a sim that cannot build a context says why', async () => {
    const io = fakeIo({}, { execLua: async () => ({ success: true, output: '{"error":"need team"}' }) }).io;
    assert.match(await nlHandlers.nl_command({ utterance: 'go', team: 1 }, io), /could not build NL context: need team/);
});

test('the schema documents that this parses and does not execute', () => {
    const tool = NL_TOOLS.find((t) => t.name === 'nl_command');
    assert.match(tool.description, /PARSE, not an execution/);
    assert.ok(nlHandlers.nl_command);
});
