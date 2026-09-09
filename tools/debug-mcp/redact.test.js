import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSessions, redactUrlToken, REDACTED } from './redact.js';

test('sessions values are replaced, usernames kept', () => {
    assert.deepEqual(redactSessions({ admin: 'abc123', bob: 'def' }), { admin: REDACTED, bob: REDACTED });
});
test('revealTokens passes the map through untouched', () => {
    const m = { admin: 'abc123' };
    assert.equal(redactSessions(m, true), m);
});
test('non-objects pass through', () => {
    assert.equal(redactSessions(undefined), undefined);
});
test('url token fragment is masked', () => {
    assert.equal(redactUrlToken('http://x/?play=a&room=1#token=SECRET'), 'http://x/?play=a&room=1#token=<redacted>');
    assert.equal(redactUrlToken(undefined), undefined);
});
