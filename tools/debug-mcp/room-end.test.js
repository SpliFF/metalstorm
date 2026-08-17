/**
 * `node --test tools/debug-mcp/` — the 404 disambiguation behind `end_game`'s
 * graceful path (P4).
 *
 * The whole reason this logic is a module: getting it wrong in either direction
 * is dangerous. Falling back on the P4 route's own "unknown roomId" would kill
 * a pid nobody asked for; falling back on a 403 would turn an auth
 * misconfiguration into an unaudited kill.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyEndResponse } from './room-end.js';

test('200 with a report → report it verbatim', () => {
    const body = JSON.stringify({ ok: true, roomId: 7, outcome: 'checkpointed', frame: 9120 });
    const r = classifyEndResponse(200, body);
    assert.equal(r.action, 'report');
    assert.equal(r.report.roomId, 7);
    assert.equal(r.report.outcome, 'checkpointed');
});

test('route-level 404 (no JSON body) → fall back to local SIGTERM', () => {
    assert.equal(classifyEndResponse(404, 'Not Found').action, 'fallback');
    assert.equal(classifyEndResponse(404, '').action, 'fallback');
    assert.equal(classifyEndResponse(404, '<html>404</html>').action, 'fallback');
});

test('a 404 whose JSON is not the P4 shape is still route-level', () => {
    // Some other handler's JSON 404 must not be mistaken for "unknown roomId".
    assert.equal(classifyEndResponse(404, JSON.stringify({ error: 'no such map' })).action, 'fallback');
    assert.equal(classifyEndResponse(404, JSON.stringify({ ok: false })).action, 'fallback');
});

test('the P4 route\'s own "unknown roomId" 404 → error, never a fallback kill', () => {
    const r = classifyEndResponse(404, JSON.stringify({ error: 'unknown roomId' }));
    assert.equal(r.action, 'error');
    assert.match(r.error, /unknown roomId/);
    assert.match(r.error, /No fallback kill/);
});

test('auth and validation failures are errors, never fallbacks', () => {
    for (const status of [400, 401, 403, 500, 502]) {
        const r = classifyEndResponse(status, JSON.stringify({ error: 'nope' }));
        assert.equal(r.action, 'error', `status ${status} must not fall back`);
        assert.match(r.error, new RegExp(String(status)));
    }
});

test('a 2xx with a non-JSON body is an error, not a silent empty report', () => {
    const r = classifyEndResponse(200, 'OK');
    assert.equal(r.action, 'error');
    assert.match(r.error, /non-JSON/);
});

test('an empty error body still names the status', () => {
    const r = classifyEndResponse(403, '');
    assert.equal(r.action, 'error');
    assert.match(r.error, /403/);
    assert.match(r.error, /empty body/);
});
