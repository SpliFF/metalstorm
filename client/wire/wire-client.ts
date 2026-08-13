/**
 * Scripted wire client — the harness PLAN-replay.md §7.11 **T2-a-1** and
 * PLAN-long-uptime.md **T4-1** both wait on.
 *
 * A headless run has no clients, so everything on the client side of the wire
 * (the Handshake/AuthRequest admission path, a human's PlayerCommand, the
 * per-client churn ladder 2 needs) is reachable only from a browser today — a
 * regression there reaches a player before it reaches CI. This module speaks the
 * real wire: the real QUIC/WebTransport transport, the real control framing, and
 * the **same generated FlatBuffers** the browser client uses. Nothing about the
 * protocol is restated here, which is the point — a schema change that would
 * break a player breaks this harness in the same commit.
 *
 * What it deliberately does NOT do: render, simulate, or interpret game state.
 * It counts inbound envelopes by type and exposes the ones a test asserts on
 * (AuthResponse today). A harness that decoded the world would be a second
 * client, and would rot.
 *
 * The WebTransport implementation is injected (`WebTransportCtor`) because node
 * has none: `run-wire-client.mjs` supplies the `@fails-components/webtransport`
 * client and its cert-pinning hook, and the unit tests supply a fake. Neither
 * this file nor anything it imports may depend on node or the DOM.
 */

import * as flatbuffers from 'flatbuffers';
import { PROTOCOL_VERSION, ENVELOPE_FLATBUFFERS } from '../src/core/protocol-version.js';
import { frameControlMessage, ControlFrameDeframer } from '../src/core/transport.js';
import { ClientMessage } from '../src/protocol/spring-web/client-message.js';
import { ClientPayload } from '../src/protocol/spring-web/client-payload.js';
import { Handshake } from '../src/protocol/spring-web/handshake.js';
import { AuthRequest } from '../src/protocol/spring-web/auth-request.js';
import { PlayerCommand } from '../src/protocol/spring-web/player-command.js';
import { ServerMessage } from '../src/protocol/spring-web/server-message.js';
import { ServerPayload } from '../src/protocol/spring-web/server-payload.js';
import { AuthResponse } from '../src/protocol/spring-web/auth-response.js';
import { AuthStatus } from '../src/protocol/spring-web/auth-status.js';

/** The subset of the WebTransport API the harness uses. Structural, so both the
 *  browser type and the node package satisfy it without either being imported
 *  as a type dependency. */
export interface WireSession {
    readonly ready: Promise<void>;
    readonly closed: Promise<unknown>;
    createBidirectionalStream(): Promise<{
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
    }>;
    close(info?: { closeCode?: number; reason?: string }): void;
}

export type WireSessionCtor = new (url: string, opts?: unknown) => WireSession;

export interface WireClientOptions {
    /** HTTP base of the game server, e.g. `http://127.0.0.1:9001`. */
    httpBase: string;
    username: string;
    password: string;
    /** WebTransport implementation (browser global, or the node package). */
    WebTransportCtor: WireSessionCtor;
    /**
     * Extra options handed verbatim to the WebTransport constructor. The
     * browser needs `serverCertificateHashes` here; the node client ignores it
     * and pins through its own global hook instead (see run-wire-client.mjs) —
     * which is why the hashes are ALSO returned by `discover()` rather than
     * being consumed privately.
     */
    sessionOptions?: (info: WtInfo) => unknown;
    /** Optional session token, sent instead of relying on password auth. */
    token?: string;
    log?: (msg: string) => void;
    /** Injected fetch, so the harness is testable without a network. */
    fetchImpl?: typeof fetch;
}

/** `GET /api/wt/info` — the QUIC endpoint plus its pinning material. */
export interface WtInfo {
    port: number;
    certMode: 'hashes' | 'webpki';
    certHashes: string[];
}

export interface AuthOutcome {
    status: AuthStatus;
    /** `true` only for AuthStatus.OK — the one thing a caller should branch on. */
    ok: boolean;
    message: string;
    /** DB account id. NOT the sim player number (PLAN-endtoend.md D3). */
    playerId: number;
    /** Sim playerNum — what every synced surface keys on. -1 when unseated. */
    playerNum: number;
    team: number;
    role: string;
}

export class WireClient {
    private readonly opts: WireClientOptions;
    private readonly fetchImpl: typeof fetch;
    private readonly log: (msg: string) => void;
    private session: WireSession | null = null;
    private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private readonly deframer = new ControlFrameDeframer();
    private sequence = 0;

    /** Inbound envelope tally, keyed by the envelope byte, then by
     *  ServerPayload for FlatBuffers messages. What a churn arm reports. */
    readonly inboundByEnvelope = new Map<number, number>();
    readonly inboundByPayload = new Map<ServerPayload, number>();

    /** Outbound tally by ClientPayload tag. A gate arm asserting that the
     *  server refused a verb has to name the verb by the SAME number the
     *  generated schema gave it, not by a constant copied into the test. */
    readonly sentByPayload = new Map<ClientPayload, number>();

    private pendingWrites: Array<Promise<void>> = [];
    /** Every write rejection seen, in order. Non-empty means bytes this harness
     *  claims to have sent did not leave. */
    readonly writeErrors: string[] = [];

    private authWaiters: Array<(o: AuthOutcome) => void> = [];
    private lastAuth: AuthOutcome | null = null;

    constructor(opts: WireClientOptions) {
        this.opts = opts;
        this.fetchImpl = opts.fetchImpl ?? fetch;
        this.log = opts.log ?? (() => {});
    }

    /** Discover the QUIC endpoint over the trusted HTTP plane, exactly as
     *  connection.ts does (PLAN-security-hardening task 5). */
    async discover(): Promise<WtInfo> {
        const resp = await this.fetchImpl(`${this.opts.httpBase}/api/wt/info`);
        if (!resp.ok) throw new Error(`wt/info failed: HTTP ${resp.status}`);
        const info = await resp.json() as {
            port?: number; certMode?: string; certHashes?: string[]; certHash?: string;
        };
        if (!info.port) throw new Error('wt/info missing port');
        const webpki = info.certMode === 'webpki';
        const certHashes = webpki
            ? []
            : (info.certHashes ?? (info.certHash ? [info.certHash] : []));
        if (!webpki && certHashes.length === 0) {
            throw new Error('wt/info missing certHashes for hashes cert mode');
        }
        return {
            port: info.port,
            certMode: webpki ? 'webpki' : 'hashes',
            certHashes: certHashes.map((h) => h.toLowerCase()),
        };
    }

    /**
     * Open the session and send Handshake then AuthRequest on the control
     * stream, in that order — the server refuses an AuthRequest that arrives
     * without a matching Handshake (C1), and the harness must not paper over
     * that ordering.
     */
    async connect(): Promise<WtInfo> {
        const info = await this.discover();
        const host = new URL(this.opts.httpBase).hostname;
        const url = `https://${host}:${info.port}/`;

        const session = new this.opts.WebTransportCtor(
            url, this.opts.sessionOptions?.(info));
        this.session = session;
        // `ready` alone is not enough: a refused QUIC handshake (a cert the
        // client will not accept, a server that went away) settles `closed` and
        // leaves `ready` pending forever, so awaiting only `ready` hangs until
        // the caller's timeout and reports nothing about why. Race the two.
        const closedFirst = session.closed.then(
            (info) => { throw new Error(`session closed before ready: ${JSON.stringify(info ?? {})}`); },
            (e: unknown) => { throw new Error(`session failed before ready: ${String(e)}`); },
        );
        await Promise.race([session.ready, closedFirst]);
        void session.closed
            .then(() => this.log('[wire] session closed'))
            .catch((e: unknown) => this.log(`[wire] session closed with error: ${String(e)}`));
        this.log(`[wire] session open to ${url}`);

        const control = await session.createBidirectionalStream();
        this.writer = control.writable.getWriter();
        void this.readControl(control.readable);

        this.sendHandshake();
        this.sendAuthRequest();
        return info;
    }

    private sendHandshake(): void {
        const b = new flatbuffers.Builder(64);
        const ver = b.createString(`springweb-wire/${PROTOCOL_VERSION}`);
        const hs = Handshake.createHandshake(b, PROTOCOL_VERSION, ver);
        this.sendClientMessage(b, ClientPayload.Handshake, hs);
        this.log(`[wire] sent Handshake (protocol v${PROTOCOL_VERSION})`);
    }

    private sendAuthRequest(): void {
        const b = new flatbuffers.Builder(256);
        const user = b.createString(this.opts.username);
        const pass = this.opts.password ? b.createString(this.opts.password) : 0;
        const token = this.opts.token ? b.createString(this.opts.token) : 0;
        const auth = AuthRequest.createAuthRequest(b, user, pass, token, b.createString(''));
        this.sendClientMessage(b, ClientPayload.AuthRequest, auth);
        this.log(`[wire] sent AuthRequest (${this.opts.username})`);
    }

    /**
     * Issue a player command — the verb T2-a-2 has no coverage for. `squadIds`
     * and `params` carry whatever the caller means by the command; this harness
     * does not validate them, because the server's validation is the thing
     * under test.
     */
    sendPlayerCommand(cmd: {
        commandId: number;
        squadIds?: number[];
        params?: number[];
        options?: number;
        timeoutFrames?: number;
    }): number {
        const b = new flatbuffers.Builder(256);
        const squads = PlayerCommand.createSquadIdsVector(b, cmd.squadIds ?? []);
        const params = PlayerCommand.createParamsVector(b, cmd.params ?? []);
        const seq = ++this.sequence;
        const pc = PlayerCommand.createPlayerCommand(
            b, seq, cmd.commandId, squads, params,
            cmd.options ?? 0, cmd.timeoutFrames ?? 0);
        this.sendClientMessage(b, ClientPayload.PlayerCommand, pc);
        this.log(`[wire] sent PlayerCommand seq=${seq} cmd=${cmd.commandId} `
            + `squads=[${(cmd.squadIds ?? []).join(',')}]`);
        return seq;
    }

    private sendClientMessage(
        b: flatbuffers.Builder, payloadType: ClientPayload, payload: number,
    ): void {
        ClientMessage.startClientMessage(b);
        ClientMessage.addPayloadType(b, payloadType);
        ClientMessage.addPayload(b, payload);
        b.finish(ClientMessage.endClientMessage(b));

        this.sentByPayload.set(payloadType, (this.sentByPayload.get(payloadType) ?? 0) + 1);
        const buf = b.asUint8Array();
        const msg = new Uint8Array(1 + buf.length);
        msg[0] = ENVELOPE_FLATBUFFERS;
        msg.set(buf, 1);
        // A rejected write must be SAID. It was voided here until 2026-08-14,
        // which is a silent send failure: the harness would report "sent" for
        // bytes that never left, and an arm asserting on the server's answer
        // would blame the server.
        this.pendingWrites.push(
            (this.writer?.write(frameControlMessage(msg)) ?? Promise.resolve())
                .catch((e: unknown) => {
                    this.writeErrors.push(String(e));
                    this.log(`[wire] WRITE FAILED (payload ${payloadType}): ${String(e)}`);
                }));
    }

    /** Settle every write issued so far, so a caller can assert the bytes
     *  actually left before it asserts on what came back. */
    async flush(): Promise<void> {
        const pending = this.pendingWrites;
        this.pendingWrites = [];
        await Promise.all(pending);
    }

    /** Resolve with the server's AuthResponse, or reject on timeout. */
    awaitAuth(timeoutMs = 15_000): Promise<AuthOutcome> {
        if (this.lastAuth) return Promise.resolve(this.lastAuth);
        return new Promise<AuthOutcome>((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`no AuthResponse within ${timeoutMs} ms`)), timeoutMs);
            this.authWaiters.push((o) => { clearTimeout(timer); resolve(o); });
        });
    }

    /** Wait until `predicate` holds over the inbound tallies, or time out. Used
     *  by an arm that asserts the server kept talking after a command. */
    async waitFor(predicate: () => boolean, timeoutMs = 15_000, pollMs = 50): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error('waitFor timed out');
            await new Promise((r) => setTimeout(r, pollMs));
        }
    }

    private async readControl(readable: ReadableStream<Uint8Array>): Promise<void> {
        const reader = readable.getReader();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) this.deframer.push(value, (m) => this.handleMessage(m));
            }
        } catch {
            /* session closing — the exit status is decided by the caller's asserts */
        }
    }

    /** One inbound message off the control stream. */
    handleMessage(msg: Uint8Array): void {
        if (msg.length < 1) return;
        const envelope = msg[0];
        this.inboundByEnvelope.set(envelope, (this.inboundByEnvelope.get(envelope) ?? 0) + 1);
        if (envelope !== ENVELOPE_FLATBUFFERS) return;

        const bb = new flatbuffers.ByteBuffer(msg.subarray(1));
        const sm = ServerMessage.getRootAsServerMessage(bb);
        const type = sm.payloadType();
        this.inboundByPayload.set(type, (this.inboundByPayload.get(type) ?? 0) + 1);

        if (type === ServerPayload.AuthResponse) {
            const ar = sm.payload(new AuthResponse()) as AuthResponse | null;
            if (!ar) return;
            const outcome: AuthOutcome = {
                status: ar.status(),
                ok: ar.status() === AuthStatus.OK,
                message: ar.message() ?? '',
                playerId: ar.playerId(),
                playerNum: ar.playerNum(),
                team: ar.team(),
                role: ar.role() ?? '',
            };
            this.lastAuth = outcome;
            this.log(`[wire] AuthResponse status=${AuthStatus[outcome.status]} `
                + `playerId=${outcome.playerId} playerNum=${outcome.playerNum} `
                + `team=${outcome.team} role=${outcome.role || '(none)'}`
                + (outcome.message ? ` message=${outcome.message}` : ''));
            const waiters = this.authWaiters;
            this.authWaiters = [];
            for (const w of waiters) w(outcome);
        }
    }

    close(): void {
        try { this.writer?.close(); } catch { /* already closing */ }
        try { this.session?.close(); } catch { /* already closing */ }
        this.writer = null;
        this.session = null;
    }
}
