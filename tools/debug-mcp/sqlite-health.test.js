import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    classifyBindingError, bindingMismatchReason, bindingMismatchBanner,
    dbDivergenceWarning, probeSqliteAnnotations,
} from './sqlite-health.js';

// The exact shape node 24 produces for a module built under node 22 —
// captured from a live repro against this repo's installed better-sqlite3.
function dlopenError() {
    const e = new Error(
        "The module '/x/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n"
        + 'was compiled against a different Node.js version using\n'
        + 'NODE_MODULE_VERSION 127. This version of Node.js requires\n'
        + "NODE_MODULE_VERSION 137. Please try re-compiling or re-installing\n"
        + 'the module (for instance, using `npm rebuild` or `npm install`).',
    );
    e.code = 'ERR_DLOPEN_FAILED';
    return e;
}

// --- classifyBindingError ---------------------------------------------------

test('classifyBindingError extracts both ABI versions from a DLOPEN error', () => {
    assert.deepEqual(classifyBindingError(dlopenError()), { builtFor: 127, requires: 137 });
});

test('classifyBindingError matches on message alone when the code is missing', () => {
    const e = new Error('was compiled against a different Node.js version using NODE_MODULE_VERSION 127.');
    assert.deepEqual(classifyBindingError(e), { builtFor: 127, requires: null });
});

test('classifyBindingError accepts a version-less DLOPEN failure (e.g. wrong arch)', () => {
    const e = new Error('dlopen(...): mach-o file, but is an incompatible architecture');
    e.code = 'ERR_DLOPEN_FAILED';
    assert.deepEqual(classifyBindingError(e), { builtFor: null, requires: null });
});

test('classifyBindingError rejects ordinary SQLite errors — a missing DB file is NOT this condition', () => {
    const cantOpen = new Error('unable to open database file');
    cantOpen.code = 'SQLITE_CANTOPEN';
    assert.equal(classifyBindingError(cantOpen), null);
    assert.equal(classifyBindingError(new Error('database is locked')), null);
    assert.equal(classifyBindingError(null), null);
});

// --- reason / banner --------------------------------------------------------

test('the reason names the running node, the built-for ABI, and the rebuild command', () => {
    const r = bindingMismatchReason({ builtFor: 127, requires: 137, nodeVersion: 'v24.14.1' });
    assert.match(r, /NODE_MODULE_VERSION 127/);
    assert.match(r, /NODE_MODULE_VERSION 137/);
    assert.match(r, /v24\.14\.1/);
    assert.match(r, /cd tools\/debug-mcp && npm rebuild better-sqlite3/);
});

test('the stderr banner is ONE line and carries the whole reason', () => {
    const b = bindingMismatchBanner({ builtFor: 127, requires: 137, nodeVersion: 'v24.14.1' });
    assert.ok(!b.includes('\n'), 'banner must be a single stderr line');
    assert.match(b, /SQLITE DISABLED/);
    assert.match(b, /npm rebuild better-sqlite3/);
    assert.match(b, /sqliteUnavailable/);
});

// --- probeSqliteAnnotations -------------------------------------------------

test('a binding mismatch propagates as sqliteUnavailable on the probe', () => {
    const reason = bindingMismatchReason({ builtFor: 127, requires: 137, nodeVersion: 'v24.14.1' });
    const a = probeSqliteAnnotations({
        processSource: 'lobby', bindingReason: reason,
        sqliteOpened: false, statusRow: null, port: 9100,
    });
    assert.deepEqual(a, { sqliteUnavailable: reason });
});

test('the mismatch flag suppresses the divergence warning — broken SQLite is not "available"', () => {
    const a = probeSqliteAnnotations({
        processSource: 'lobby', bindingReason: 'broken',
        sqliteOpened: false, statusRow: null, port: 9100,
    });
    assert.equal(a.warning, undefined);
    assert.equal(a.sqliteUnavailable, 'broken');
});

test('lobby says running + SQLite readable + no game_status row → the SPRING_DB divergence warning', () => {
    // The (b) mock: the lobby reports the server, gameStatus returns null.
    const a = probeSqliteAnnotations({
        processSource: 'lobby', bindingReason: null,
        sqliteOpened: true, statusRow: null, port: 9100,
    });
    assert.deepEqual(a, { warning: dbDivergenceWarning(9100) });
    assert.match(a.warning, /lobby --db and MCP SPRING_DB may differ/);
    assert.match(a.warning, /curl :9100\/api\/metrics/);
});

test('no warning when the status row exists, when SQLite did not open, or when the process row came from the SQLite fallback', () => {
    const base = { bindingReason: null, sqliteOpened: true, port: 9100 };
    assert.deepEqual(probeSqliteAnnotations({
        ...base, processSource: 'lobby', statusRow: { ready: 1 },
    }), {});
    assert.deepEqual(probeSqliteAnnotations({
        ...base, processSource: 'lobby', sqliteOpened: false, statusRow: null,
    }), {});
    // The fallback and the game_status read are the same file — a missing row
    // there is a real absence, not a divergence.
    assert.deepEqual(probeSqliteAnnotations({
        ...base, processSource: 'sqlite', statusRow: null,
    }), {});
    assert.deepEqual(probeSqliteAnnotations({
        ...base, processSource: 'none', statusRow: null,
    }), {});
});
