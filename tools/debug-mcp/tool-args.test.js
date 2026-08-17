import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolArgs, editDistance } from './tool-args.js';

const QUERY_DB = {
    name: 'query_db',
    inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'SQL query — only row-returning statements are allowed' } },
        required: ['query'],
    },
};

const SET_LOS = {
    name: 'set_los',
    inputSchema: {
        type: 'object',
        properties: {
            enable: { type: 'boolean', description: 'true → reveal map; omit → return current state.' },
            roomId: { type: 'number' },
        },
    },
};

const GIVE_ORDER = {
    name: 'give_order',
    inputSchema: {
        type: 'object',
        properties: {
            unitId: { type: 'number' },
            cmdId:  { type: 'number', description: 'Spring command ID, e.g. 10=MOVE.' },
            params: { type: 'array' },
            roomId: { type: 'number' },
        },
        required: ['unitId', 'cmdId'],
    },
};

// --- the three real failures this module exists for ------------------------

test('query_db with no query is refused by name, not by better-sqlite3', () => {
    const err = validateToolArgs(QUERY_DB, {});
    assert.match(err, /query_db requires the argument query/);
    // The old behaviour leaked the driver's message; never again.
    assert.doesNotMatch(err, /Expected first argument/);
});

test('give_order names BOTH missing required args at once', () => {
    const err = validateToolArgs(GIVE_ORDER, { roomId: 38 });
    assert.match(err, /requires these arguments/);
    assert.match(err, /unitId/);
    assert.match(err, /cmdId/);
});

test('set_los {enabled} is caught as a typo for {enable}', () => {
    // The silent-failure case: this used to read as "no arguments", so the
    // tool answered with a status query that looks like a confirmation.
    const err = validateToolArgs(SET_LOS, { enabled: true, roomId: 1 });
    assert.match(err, /no argument "enabled"/);
    assert.match(err, /did you mean "enable"/);
});

// --- must not over-reject --------------------------------------------------

test('a satisfied call passes', () => {
    assert.equal(validateToolArgs(QUERY_DB, { query: 'SELECT 1' }), null);
    assert.equal(validateToolArgs(GIVE_ORDER, { unitId: 1, cmdId: 10 }), null);
    assert.equal(validateToolArgs(SET_LOS, { enable: true }), null);
});

test('omitting an OPTIONAL field is not an error', () => {
    // set_los documents omit-means-query; that must keep working.
    assert.equal(validateToolArgs(SET_LOS, {}), null);
});

test('an unrelated extra property is allowed through', () => {
    // Several handlers read fields their schema does not list, and no schema
    // here sets additionalProperties:false.
    assert.equal(validateToolArgs(SET_LOS, { enable: true, somethingElse: 1 }), null);
});

test('short, genuinely different names are not called typos', () => {
    const tool = { name: 't', inputSchema: { type: 'object', properties: { pid: {}, all: {} } } };
    assert.equal(validateToolArgs(tool, { all: true }), null);
    // 'pid' vs 'all' is distance 3 on 3-char names — unrelated, not a near-miss.
    assert.equal(validateToolArgs(tool, { zzz: true }), null);
});

test('false and 0 satisfy a required field; null and undefined do not', () => {
    const tool = { name: 't', inputSchema: { type: 'object', properties: { flag: {} }, required: ['flag'] } };
    assert.equal(validateToolArgs(tool, { flag: false }), null);
    assert.equal(validateToolArgs(tool, { flag: 0 }), null);
    assert.match(validateToolArgs(tool, { flag: null }), /requires/);
    assert.match(validateToolArgs(tool, {}), /requires/);
});

test('a schema-less or property-less tool validates nothing', () => {
    assert.equal(validateToolArgs({ name: 'x' }, { anything: 1 }), null);
    assert.equal(validateToolArgs({ name: 'x', inputSchema: { type: 'object', properties: {} } }, { a: 1 }), null);
});

test('a missing-required message lists what the tool accepts', () => {
    assert.match(validateToolArgs(GIVE_ORDER, {}), /Accepted: unitId, cmdId, params, roomId/);
});

test('a description is truncated by LENGTH, never mid-abbreviation', () => {
    // Splitting on '.' cut "Spring command ID, e.g. 10=MOVE" down to
    // "Spring command ID, e" — worse than useless in an error message.
    const err = validateToolArgs(GIVE_ORDER, {});
    assert.doesNotMatch(err, /, e\)/);
    assert.match(err, /e\.g\. 10=MOVE/);
});

test('editDistance basics', () => {
    assert.equal(editDistance('enable', 'enabled'), 1);
    assert.equal(editDistance('', 'abc'), 3);
    assert.equal(editDistance('abc', 'abc'), 0);
});
