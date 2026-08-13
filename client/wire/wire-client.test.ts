import { describe, it, expect } from 'vitest';
import * as flatbuffers from 'flatbuffers';
import { WireClient, type WireSession } from './wire-client';
import { ControlFrameDeframer, frameControlMessage } from '../src/core/transport';
import { PROTOCOL_VERSION, ENVELOPE_FLATBUFFERS } from '../src/core/protocol-version';
import { ClientMessage } from '../src/protocol/spring-web/client-message';
import { ClientPayload } from '../src/protocol/spring-web/client-payload';
import { Handshake } from '../src/protocol/spring-web/handshake';
import { AuthRequest } from '../src/protocol/spring-web/auth-request';
import { PlayerCommand } from '../src/protocol/spring-web/player-command';
import { ServerMessage } from '../src/protocol/spring-web/server-message';
import { ServerPayload } from '../src/protocol/spring-web/server-payload';
import { AuthResponse } from '../src/protocol/spring-web/auth-response';
import { AuthStatus } from '../src/protocol/spring-web/auth-status';

// These tests cover everything about the scripted wire client that does not
// need QUIC: what it puts on the control stream, in what order, and what it
// makes of what comes back. The live arms (a real handshake against a real
// server, and the cert-pinning refusal) are `run-wire-client.mjs`'s, because
// node has no WebTransport to fake at that layer.

/** A WebTransport stand-in that records outbound frames and can inject inbound
 *  ones. Deliberately the same shape the node client and the browser both
 *  present — the harness must not care which it was handed. */
class FakeSession implements WireSession {
    readonly sent: Uint8Array[] = [];
    /** Reject every write, the way a closing session does. */
    failWrites = false;
    ready = Promise.resolve();
    closed = new Promise<unknown>(() => { /* never settles: the session stays up */ });
    closeCalls = 0;
    private inject: ((chunk: Uint8Array) => void) | null = null;

    async createBidirectionalStream() {
        const self = this;
        return {
            readable: new ReadableStream<Uint8Array>({
                start(controller) {
                    self.inject = (chunk) => controller.enqueue(chunk);
                },
            }),
            writable: new WritableStream<Uint8Array>({
                write(chunk) {
                    if (self.failWrites) throw new Error('the stream is broken');
                    self.sent.push(chunk.slice());
                },
            }),
        };
    }

    close(): void { this.closeCalls++; }

    /** Deliver one whole application message, framed as the server frames it. */
    deliver(msg: Uint8Array): void { this.inject?.(frameControlMessage(msg)); }
}

/** Decode the outbound frames the harness wrote back into ClientMessages. */
function decodeSent(session: FakeSession): Array<{ type: ClientPayload; msg: ClientMessage }> {
    const out: Array<{ type: ClientPayload; msg: ClientMessage }> = [];
    const deframer = new ControlFrameDeframer();
    for (const frame of session.sent) {
        deframer.push(frame, (m) => {
            expect(m[0]).toBe(ENVELOPE_FLATBUFFERS);
            const bb = new flatbuffers.ByteBuffer(m.subarray(1));
            const cm = ClientMessage.getRootAsClientMessage(bb);
            out.push({ type: cm.payloadType(), msg: cm });
        });
    }
    return out;
}

function authResponseMessage(fields: {
    status: AuthStatus; playerId: number; playerNum: number; team: number;
    role: string; message?: string;
}): Uint8Array {
    const b = new flatbuffers.Builder(256);
    const token = b.createString('tok');
    const message = b.createString(fields.message ?? '');
    const role = b.createString(fields.role);
    const defs = b.createString('');
    const ar = AuthResponse.createAuthResponse(
        b, fields.status, token, fields.playerId, message, fields.team, role, defs,
        fields.playerNum);
    ServerMessage.startServerMessage(b);
    ServerMessage.addPayloadType(b, ServerPayload.AuthResponse);
    ServerMessage.addPayload(b, ar);
    b.finish(ServerMessage.endServerMessage(b));
    const buf = b.asUint8Array();
    const msg = new Uint8Array(1 + buf.length);
    msg[0] = ENVELOPE_FLATBUFFERS;
    msg.set(buf, 1);
    return msg;
}

function makeClient(session: FakeSession, overrides: Record<string, unknown> = {}) {
    const info = {
        port: 9001, transport: 'webtransport', certMode: 'hashes',
        certHashes: ['AA'.repeat(32)],
    };
    const fetchImpl = (async () => ({
        ok: true, json: async () => info,
    })) as unknown as typeof fetch;
    return new WireClient({
        httpBase: 'http://127.0.0.1:9001', username: 'wire_probe', password: 'devpass',
        // A constructor that hands back the prepared fake — the harness calls
        // `new`, so a plain factory function will not do.
        WebTransportCtor: class { constructor() { return session; } } as unknown as never,
        fetchImpl, ...overrides,
    });
}

describe('scripted wire client — outbound', () => {
    it('sends Handshake before AuthRequest, at the app protocol version', async () => {
        const session = new FakeSession();
        const client = makeClient(session);
        await client.connect();

        const sent = decodeSent(session);
        // The server refuses an AuthRequest that arrives without a matching
        // Handshake (C1), so the ORDER is the assertion, not just the presence.
        expect(sent.map((s) => s.type)).toEqual([
            ClientPayload.Handshake, ClientPayload.AuthRequest,
        ]);

        const hs = sent[0].msg.payload(new Handshake()) as Handshake;
        expect(hs.protocolVersion()).toBe(PROTOCOL_VERSION);
        const auth = sent[1].msg.payload(new AuthRequest()) as AuthRequest;
        expect(auth.username()).toBe('wire_probe');
        expect(auth.passwordHash()).toBe('devpass');
    });

    it('sends a token instead of a password when one is supplied', async () => {
        const session = new FakeSession();
        const client = makeClient(session, { password: '', token: 'jwt-abc' });
        await client.connect();
        const auth = decodeSent(session)[1].msg.payload(new AuthRequest()) as AuthRequest;
        expect(auth.token()).toBe('jwt-abc');
        expect(auth.passwordHash()).toBe(null);
    });

    it('encodes a PlayerCommand with monotonic sequence numbers', async () => {
        const session = new FakeSession();
        const client = makeClient(session);
        await client.connect();
        expect(client.sendPlayerCommand({ commandId: 10, squadIds: [7, 9], params: [4000, 0, 4000] }))
            .toBe(1);
        expect(client.sendPlayerCommand({ commandId: 20 })).toBe(2);

        // `send` returns before the stream write lands (as it does in the app —
        // connection.ts's send path is fire-and-forget too), so wait for the
        // bytes rather than assuming the write was synchronous.
        await client.waitFor(() => session.sent.length === 4, 2_000, 1);
        const sent = decodeSent(session);
        expect(sent.slice(2).map((s) => s.type)).toEqual([
            ClientPayload.PlayerCommand, ClientPayload.PlayerCommand,
        ]);
        const pc = sent[2].msg.payload(new PlayerCommand()) as PlayerCommand;
        expect(pc.sequence()).toBe(1);
        expect(pc.commandId()).toBe(10);
        expect([pc.squadIds(0), pc.squadIds(1)]).toEqual([7, 9]);
        expect(pc.paramsLength()).toBe(3);
        const pc2 = sent[3].msg.payload(new PlayerCommand()) as PlayerCommand;
        expect(pc2.sequence()).toBe(2);
        expect(pc2.squadIdsLength()).toBe(0);
    });

    it('tallies what it sent by ClientPayload tag, so a gate need not hardcode one', async () => {
        // The replay spectate gate (PLAN-replay §7.11 T2-a-1) asserts "the
        // server refused the verb I sent" and has to name that verb with the
        // number the generated schema gave it. A constant copied into the gate
        // would keep passing across a schema renumber.
        const session = new FakeSession();
        const client = makeClient(session);
        await client.connect();
        client.sendPlayerCommand({ commandId: 10, squadIds: [1] });
        await client.flush();

        expect(Object.fromEntries(client.sentByPayload)).toEqual({
            [ClientPayload.Handshake]: 1,
            [ClientPayload.AuthRequest]: 1,
            [ClientPayload.PlayerCommand]: 1,
        });
        expect(client.writeErrors).toEqual([]);
    });

    it('reports a rejected write instead of losing it', async () => {
        // A send whose bytes never left was voided until 2026-08-14, which
        // reads as "sent": an arm asserting on the server's answer would blame
        // the server for a message the harness never delivered.
        const session = new FakeSession();
        session.failWrites = true;
        const client = makeClient(session);
        await client.connect();
        await client.flush();

        expect(client.writeErrors.length).toBeGreaterThan(0);
        expect(client.writeErrors[0]).toMatch(/stream is broken/);
    });
});

describe('scripted wire client — inbound', () => {
    it('resolves awaitAuth from a real AuthResponse, keeping playerId and playerNum apart', async () => {
        const session = new FakeSession();
        const client = makeClient(session);
        await client.connect();
        const pending = client.awaitAuth(5_000);
        session.deliver(authResponseMessage({
            status: AuthStatus.OK, playerId: 162, playerNum: 0, team: 3, role: 'player',
        }));
        const auth = await pending;
        expect(auth.ok).toBe(true);
        // PLAN-endtoend D3: the account id and the sim player number are
        // different numbers that coincide only by accident on dev accounts.
        expect(auth.playerId).toBe(162);
        expect(auth.playerNum).toBe(0);
        expect(auth.team).toBe(3);
        expect(auth.role).toBe('player');
    });

    it('reports a refusal as a refusal rather than throwing', async () => {
        const session = new FakeSession();
        const client = makeClient(session);
        await client.connect();
        const pending = client.awaitAuth(5_000);
        session.deliver(authResponseMessage({
            status: AuthStatus.VersionMismatch, playerId: 0, playerNum: -1, team: -1,
            role: '', message: 'Protocol handshake required — reload the client',
        }));
        const auth = await pending;
        expect(auth.ok).toBe(false);
        expect(auth.status).toBe(AuthStatus.VersionMismatch);
        expect(auth.message).toMatch(/handshake required/);
    });

    it('tallies inbound envelopes and payload types, including non-flatbuffers ones', async () => {
        const session = new FakeSession();
        const client = makeClient(session);
        await client.connect();
        const pending = client.awaitAuth(5_000);
        session.deliver(authResponseMessage({
            status: AuthStatus.OK, playerId: 1, playerNum: 0, team: 0, role: 'player',
        }));
        await pending;
        // An entity-state envelope (0x02) must be counted but not decoded — the
        // harness is not a second game client.
        session.deliver(new Uint8Array([0x02, 0xde, 0xad, 0xbe, 0xef]));
        await client.waitFor(() => client.inboundByEnvelope.get(0x02) === 1, 2_000, 5);
        expect(client.inboundByEnvelope.get(ENVELOPE_FLATBUFFERS)).toBe(1);
        expect(client.inboundByPayload.get(ServerPayload.AuthResponse)).toBe(1);
    });

    it('times out rather than hanging when no AuthResponse arrives', async () => {
        const session = new FakeSession();
        const client = makeClient(session);
        await client.connect();
        await expect(client.awaitAuth(50)).rejects.toThrow(/no AuthResponse/);
    });
});

describe('scripted wire client — endpoint discovery', () => {
    it('accepts the single-hash back-compat field', async () => {
        const session = new FakeSession();
        const fetchImpl = (async () => ({
            ok: true,
            json: async () => ({ port: 9100, certMode: 'hashes', certHash: 'BB'.repeat(32) }),
        })) as unknown as typeof fetch;
        const client = makeClient(session, { fetchImpl });
        const info = await client.discover();
        expect(info.port).toBe(9100);
        expect(info.certHashes).toEqual(['bb'.repeat(32)]);
    });

    it('refuses to connect to a hashes-mode server that published no hashes', async () => {
        const session = new FakeSession();
        const fetchImpl = (async () => ({
            ok: true, json: async () => ({ port: 9100, certMode: 'hashes' }),
        })) as unknown as typeof fetch;
        const client = makeClient(session, { fetchImpl });
        await expect(client.discover()).rejects.toThrow(/missing certHashes/);
    });

    it('expects no hashes in webpki mode', async () => {
        const session = new FakeSession();
        const fetchImpl = (async () => ({
            ok: true, json: async () => ({ port: 443, certMode: 'webpki' }),
        })) as unknown as typeof fetch;
        const client = makeClient(session, { fetchImpl });
        const info = await client.discover();
        expect(info.certMode).toBe('webpki');
        expect(info.certHashes).toEqual([]);
    });
});
