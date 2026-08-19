/**
 * PLAN-test-automation P7 — gate 3 and the two new wire messages.
 *
 * The gate is the one the server cannot enforce for itself (it can't see what
 * bundle the browser is running), so a regression here silently opens
 * arbitrary code execution in a production tab. The round-trip cases exist
 * because the schema edit rotates the wire hash: if a field ever moves, this
 * fails before a browser is refused at handshake with nothing but
 * `VersionMismatch` to go on.
 */
import { describe, it, expect } from 'vitest';
import * as flatbuffers from 'flatbuffers';

import {
    CLIENT_EVAL_DISABLED, CLIENT_EVAL_TARGETS,
    clientEvalAllowed, clientEvalRunsOnMain, isClientEvalTarget,
} from './client-eval-gate.js';
import { ClientEvalRequest } from '../protocol/spring-web/client-eval-request.js';
import { ClientEvalResponse } from '../protocol/spring-web/client-eval-response.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';

describe('client-eval gate 3', () => {
    it('a DEV build accepts with no URL param at all', () => {
        // Requiring ?allowClientEval in dev would make every debugging session
        // start with a reload — the param is the PROD opt-in, not the gate.
        expect(clientEvalAllowed(true, false)).toBe(true);
        expect(clientEvalAllowed(true, true)).toBe(true);
    });

    it('a production build refuses unless the page opted in', () => {
        expect(clientEvalAllowed(false, false)).toBe(false);
        expect(clientEvalAllowed(false, true)).toBe(true);
    });

    it('refuses on anything that is not literally true', () => {
        // The flag arrives over postMessage from main, so an absent field
        // reads as undefined, not false. Neither may open the gate.
        expect(clientEvalAllowed(undefined as unknown as boolean,
                                 undefined as unknown as boolean)).toBe(false);
        expect(clientEvalAllowed(0 as unknown as boolean,
                                 '1' as unknown as boolean)).toBe(false);
    });

    it('the refusal string is the exact text the MCP branches on', () => {
        // tools/debug-mcp/server.js turns this reply into {fallback} so the
        // tool prints a paste-into-devtools snippet. Reword it there too.
        expect(CLIENT_EVAL_DISABLED).toBe('client eval disabled in this build');
    });
});

describe('client-eval targets', () => {
    it('accepts exactly the four the server validates', () => {
        expect([...CLIENT_EVAL_TARGETS]).toEqual(['js', 'worker', 'widgets', 'test']);
        for (const t of CLIENT_EVAL_TARGETS) expect(isClientEvalTarget(t)).toBe(true);
    });

    it('rejects anything else', () => {
        for (const t of ['', 'JS', 'lua', 'main', 'eval']) {
            expect(isClientEvalTarget(t)).toBe(false);
        }
    });

    it('only `worker` runs in place — everything else forwards to main', () => {
        expect(clientEvalRunsOnMain('worker')).toBe(false);
        expect(clientEvalRunsOnMain('js')).toBe(true);
        expect(clientEvalRunsOnMain('widgets')).toBe(true);
        expect(clientEvalRunsOnMain('test')).toBe(true);
    });
});

describe('the P7 wire messages', () => {
    it('ClientEvalRequest round-trips request_id, target and code', () => {
        const b = new flatbuffers.Builder(256);
        const target = b.createString('worker');
        const code = b.createString('globalThis.__entityRenderer ? "up" : "down"');
        b.finish(ClientEvalRequest.createClientEvalRequest(b, 0x80000007, target, code));

        const got = ClientEvalRequest.getRootAsClientEvalRequest(
            new flatbuffers.ByteBuffer(b.asUint8Array()));
        expect(got.requestId()).toBe(0x80000007);
        expect(got.target()).toBe('worker');
        expect(got.code()).toBe('globalThis.__entityRenderer ? "up" : "down"');
    });

    it('ClientEvalRequest ids survive the broker\'s top bit', () => {
        // The server sets bit 31 so relay ids never collide with the console's
        // own request ids. request_id is uint32 — a signed read would wrap
        // these to negatives and no response would ever match its waiter.
        const b = new flatbuffers.Builder(128);
        const t = b.createString('js');
        const c = b.createString('1');
        b.finish(ClientEvalRequest.createClientEvalRequest(b, 0xfffffffe, t, c));
        const got = ClientEvalRequest.getRootAsClientEvalRequest(
            new flatbuffers.ByteBuffer(b.asUint8Array()));
        expect(got.requestId()).toBe(0xfffffffe);
    });

    it('ClientEvalResponse round-trips a failure with its message', () => {
        const b = new flatbuffers.Builder(256);
        const out = b.createString(CLIENT_EVAL_DISABLED);
        b.finish(ClientEvalResponse.createClientEvalResponse(b, 42, false, out));

        const got = ClientEvalResponse.getRootAsClientEvalResponse(
            new flatbuffers.ByteBuffer(b.asUint8Array()));
        expect(got.requestId()).toBe(42);
        expect(got.success()).toBe(false);
        expect(got.output()).toBe(CLIENT_EVAL_DISABLED);
    });

    it('the union tags are appended, not inserted', () => {
        // Tag stability is load-bearing: SyncedInputJournal keys its
        // classification off the numeric ClientPayload tag, and the C++ side
        // hand-copies the mirror. ClientEvalResponse must stay last at 46.
        expect(ClientPayload.ClientEvalResponse).toBe(46);
        expect(ClientPayload.ReplayControl).toBe(45);
        expect(ServerPayload.ClientEvalRequest).toBe(48);
    });
});
