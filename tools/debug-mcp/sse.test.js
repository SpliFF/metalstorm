import test from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, parseSse } from './sse.js';

test('named events, multi-line data, comments and CRLF', () => {
    const ev = parseSse(': keepalive\r\nevent: world-staging\r\ndata: {"a":1,\r\ndata:  "b":2}\r\nid: 7\r\n\r\ndata: plain\n\n');
    assert.deepEqual(ev, [
        { event: 'world-staging', data: '{"a":1,\n "b":2}', id: '7' },
        { event: 'message', data: 'plain', id: null },
    ]);
});

test('incremental chunks split mid-line still yield one event', () => {
    const p = new SseParser();
    assert.deepEqual(p.push('event: wor'), []);
    assert.deepEqual(p.push('ld-staging\ndata: {"x"'), []);
    const out = p.push(':1}\n\n');
    assert.deepEqual(out, [{ event: 'world-staging', data: '{"x":1}', id: null }]);
});

test('a blank line with no data dispatches nothing', () => {
    assert.deepEqual(parseSse('\n\n\n'), []);
});
