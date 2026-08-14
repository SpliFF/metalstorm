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
import { StandingOrderCreate } from '../src/protocol/spring-web/standing-order-create.js';
import { ServerMessage } from '../src/protocol/spring-web/server-message.js';
import { ServerPayload } from '../src/protocol/spring-web/server-payload.js';
import { AuthResponse } from '../src/protocol/spring-web/auth-response.js';
import { AuthStatus } from '../src/protocol/spring-web/auth-status.js';
import { ServerError } from '../src/protocol/spring-web/server-error.js';
import { RulesParamKeyDictionary } from '../src/protocol/spring-web/rules-param-key-dictionary.js';

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

/** One `ServerError` the server sent back. The churn arm (PLAN-long-uptime
 *  T4-1) exists to make S6 non-zero, and every way that fails — 401 unseated,
 *  402 out of authority, 429 rate-limited or at the per-team cap — arrives as
 *  one of these and as nothing else. A harness that counted only what it SENT
 *  would report a churn window as healthy while the server refused every
 *  order in it. */
export interface ServerErrorReport {
    code: number;
    message: string;
}

/**
 * One `RulesParamKeyDictionary` the server sent — the whole dictionary, not a
 * delta (`StateStreamer::SendKeyDictionary` re-sends every key on any rev bump,
 * which is cost 1 of the two PLAN-long-uptime S1 exists to bound).
 *
 * This is the ONE game-state-adjacent thing this harness reads, and the header's
 * "does not interpret game state" rule survives it: the keys are transported
 * verbatim, nothing is parsed out of them and no value is decoded. It is here
 * because S1's census (PLAN-long-uptime **T4-1e**) needs to know *which* keys a
 * session mints, and a client is the only thing the server ever tells.
 */
export interface KeyDictionarySnapshot {
    /** `dictionary_rev` — bumped on every mint and on compaction. */
    rev: number;
    /** Every interned key, in id order starting at id 1 (0 is reserved). */
    keys: string[];
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

    /** Every ServerError received, in order. */
    readonly serverErrors: ServerErrorReport[] = [];

    /** Every key dictionary received, in order. A session normally gets exactly
     *  one (the join resync) and then one more per rev bump it is behind for. */
    readonly keyDictionaries: KeyDictionarySnapshot[] = [];

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

    /**
     * Create a standing order — the verb PLAN-long-uptime **S6** counts, and
     * the reason a churn arm needs a SEATED session: the server refuses this
     * with a 401 when `session->team < 0` (ClientMessageHandler.cpp), which is
     * every client on a headless run with no `--player` roster. `conditions`
     * are omitted deliberately (offset 0 = the field is absent): the server
     * reads them through `ReadStandingOrderConditions`, which handles a null
     * table, and a harness that invented conditions would be asserting on its
     * own guesses rather than on the container's growth.
     */
    sendStandingOrderCreate(order: {
        type: number;
        priority?: number;
        params?: number[];
        expiresInFrames?: number;
    }): number {
        const b = new flatbuffers.Builder(256);
        const params = StandingOrderCreate.createParamsVector(b, order.params ?? []);
        const seq = ++this.sequence;
        StandingOrderCreate.startStandingOrderCreate(b);
        StandingOrderCreate.addSequence(b, seq);
        StandingOrderCreate.addType(b, order.type);
        StandingOrderCreate.addPriority(b, order.priority ?? 50);
        StandingOrderCreate.addParams(b, params);
        StandingOrderCreate.addExpiresInFrames(b, order.expiresInFrames ?? 0);
        const so = StandingOrderCreate.endStandingOrderCreate(b);
        this.sendClientMessage(b, ClientPayload.StandingOrderCreate, so);
        this.log(`[wire] sent StandingOrderCreate seq=${seq} type=${order.type} `
            + `priority=${order.priority ?? 50}`);
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
        } else if (type === ServerPayload.ServerError) {
            const se = sm.payload(new ServerError()) as ServerError | null;
            if (!se) return;
            const report = { code: se.code(), message: se.message() ?? '' };
            this.serverErrors.push(report);
            this.log(`[wire] ServerError ${report.code}: ${report.message}`);
        } else if (type === ServerPayload.RulesParamKeyDictionary) {
            const kd = sm.payload(new RulesParamKeyDictionary()) as RulesParamKeyDictionary | null;
            if (!kd) return;
            const keys: string[] = [];
            for (let i = 0; i < kd.keysLength(); i++) keys.push(kd.keys(i) ?? '');
            this.keyDictionaries.push({ rev: kd.dictionaryRev(), keys });
            this.log(`[wire] RulesParamKeyDictionary rev=${kd.dictionaryRev()} keys=${keys.length}`);
        }
    }

    /** The most recent dictionary this session was told about, or null if it was
     *  never told one (which is itself a reading — see T4-2's client-count gate:
     *  a server that interns nothing sends nothing). */
    latestKeyDictionary(): KeyDictionarySnapshot | null {
        return this.keyDictionaries.length
            ? this.keyDictionaries[this.keyDictionaries.length - 1]
            : null;
    }

    close(): void {
        try { this.writer?.close(); } catch { /* already closing */ }
        try { this.session?.close(); } catch { /* already closing */ }
        this.writer = null;
        this.session = null;
    }
}
