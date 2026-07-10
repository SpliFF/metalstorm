/**
 * GameTransport — transport layer for the realtime game stream.
 *
 * Stage 0 (PLAN-game-worker.md, PLAN.md Stage 0) moves the game stream onto
 * **WebTransport-only** (HTTP/3 / QUIC), dropping WebRTC. The connection runs
 * inside the game-processor worker (RTCPeerConnection is main-thread-only;
 * WebTransport runs in workers) and uses QUIC's independent streams + priority
 * so low-priority bulk (decals, heightmap) can't head-of-line-block per-frame
 * entity state.
 *
 * The old `send(data, reliable)` boolean is replaced by a **class** taxonomy
 * matching the server's StreamClass tiers (GW2) — see
 * rts/Server/WebTransport/WebTransportServer.h:
 *
 *   class     server tier   carrier                  semantics
 *   control   0 Control     reliable bidi stream     ordered, reliable, never dropped
 *   state     1 Per-frame   newest-wins uni stream   skip-stale (RESET prior on new)
 *   vision    2 Vision      reliable uni stream      reliable, lower priority
 *   bulk      3 Bulk        reliable uni stream      reliable, must not block 0/1
 *   datagram  —             unreliable datagram      fire-and-forget (<~1200 B)
 *
 * **Framing contract** (must match the server):
 *   - control (bidi): a byte stream of length-delimited frames `[u32 LE len][payload]`.
 *   - state/vision/bulk (uni): exactly one payload per stream, terminated by FIN
 *     (read-to-end = one message). No length prefix.
 *   - datagram: one payload per datagram.
 */

export type TransportClass = 'control' | 'state' | 'vision' | 'bulk' | 'datagram';

export interface TransportEvents {
    onOpen?: () => void;
    onClose?: (code: number, reason: string) => void;
    onMessage?: (data: Uint8Array) => void;
    onError?: (error: string) => void;
}

export interface TransportConnectOptions {
    /**
     * Lower-case hex SHA-256 hashes of the server's DER cert(s), for
     * serverCertificateHashes pinning. Only set in `hashes` cert mode
     * (self-signed dev/self-hosted cert) — 1 or 2 entries (active + the
     * already-generated "next" cert, so a stale /api/wt/info answer still
     * connects across a rotation). Omit entirely in `webpki` mode (a CA
     * cert): the browser validates it normally, and pinning a rotating CA
     * cert would break clients on every renewal.
     */
    certHashes?: string[];
}

export interface GameTransport {
    /** Connect to a WebTransport URL. Resolves once the session is established. */
    connect(url: string, opts?: TransportConnectOptions): Promise<void>;

    /** Close the session. */
    disconnect(): void;

    /** Send a binary message on the given class (default 'control'). */
    send(data: Uint8Array, cls?: TransportClass): void;

    /** Whether the session is currently open. */
    readonly connected: boolean;

    /** Transport type identifier. */
    readonly type: 'webtransport';
}

/**
 * Browser `sendOrder` priority per class — higher is sent first, mapping the
 * server's RFC 9218 urgency (lower urgency = higher priority) onto the
 * WebTransport API's `sendOrder` (higher = higher priority).
 */
const CLASS_SEND_ORDER: Record<TransportClass, number> = {
    control: 1_000_000,
    state: 100_000,
    vision: 1_000,
    bulk: 0,
    datagram: 0,
};

/**
 * Frame a payload for the multiplexed control stream: `[u32 LE len][payload]`.
 * The server's Control-tier writer must produce the identical framing.
 */
export function frameControlMessage(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(4 + data.length);
    new DataView(out.buffer).setUint32(0, data.length, true);
    out.set(data, 4);
    return out;
}

/**
 * Incremental deframer for the control stream. WebTransport streams are
 * byte-oriented, so control messages are length-delimited and may split or
 * coalesce across reads. Feed raw chunks; receive whole messages via the
 * callback. This is the exact inverse of {@link frameControlMessage} — keeping
 * the two together is what locks the wire contract.
 */
export class ControlFrameDeframer {
    private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

    /** Push a chunk; invoke `onMessage` once per complete frame drained. */
    push(chunk: Uint8Array, onMessage: (msg: Uint8Array) => void): void {
        this.buf = concat(this.buf, chunk);
        for (;;) {
            if (this.buf.length < 4) break;
            const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(0, true);
            if (this.buf.length < 4 + len) break;
            onMessage(this.buf.slice(4, 4 + len));
            this.buf = this.buf.slice(4 + len);
        }
    }
}

function hexToBytes(hex: string): Uint8Array {
    const clean = hex.trim().toLowerCase().replace(/^0x/, '');
    const out = new Uint8Array(clean.length >> 1);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    return out;
}

/**
 * Real WebTransport adapter (PLAN-game-worker.md GW3).
 *
 * Designed to run in the game-processor worker, but has no worker/DOM
 * dependencies of its own — it speaks only the WebTransport API, so it is
 * unit-testable and host-agnostic. Wiring it into connection.ts + relocating
 * the decoders into the worker is the rest of GW3/GW4.
 */
export class WebTransportAdapter implements GameTransport {
    private events: TransportEvents;
    private wt: WebTransport | null = null;
    private controlWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
    private _connected = false;
    private closing = false;

    // newest-wins outbound state stream: aborted when a newer state send arrives.
    private stateWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;

    constructor(events: TransportEvents) {
        this.events = events;
    }

    get connected(): boolean { return this._connected; }
    get type(): 'webtransport' { return 'webtransport'; }

    async connect(url: string, opts?: TransportConnectOptions): Promise<void> {
        if (typeof WebTransport === 'undefined') {
            const msg = 'WebTransport unsupported by this browser';
            this.events.onError?.(msg);
            throw new Error(msg);
        }
        const wtOpts: WebTransportOptions = {};
        if (opts?.certHashes?.length) {
            wtOpts.serverCertificateHashes = opts.certHashes.map((hash) => ({
                algorithm: 'sha-256' as const,
                value: hexToBytes(hash).buffer as ArrayBuffer,
            }));
        }
        const wt = new WebTransport(url, wtOpts);
        this.wt = wt;

        // Surface session close/error.
        wt.closed
            .then((info) => this.handleClosed(info.closeCode ?? 0, info.reason ?? ''))
            .catch((err) => {
                // GW4-c2 diagnostic: WebTransportError carries source +
                // streamErrorCode that the bare message hides. Log it so a
                // session-vs-stream close (and the QUIC app error code) is visible.
                try {
                    console.warn('[transport] wt.closed rejected:',
                        'name=', err?.name,
                        'source=', (err as { source?: string })?.source,
                        'streamErrorCode=', (err as { streamErrorCode?: number })?.streamErrorCode,
                        'message=', err?.message);
                } catch { /* ignore */ }
                this.handleClosed(-1, String(err?.message ?? err));
            });

        await wt.ready;

        // Control: one bidirectional stream carrying length-delimited frames.
        const control = await wt.createBidirectionalStream({ sendOrder: CLASS_SEND_ORDER.control });
        this.controlWriter = control.writable.getWriter();
        void this.readControlFrames(control.readable);

        // Datagrams: one payload per datagram.
        this.datagramWriter = wt.datagrams.writable.getWriter();
        void this.readDatagrams(wt.datagrams.readable);

        // Incoming server→client uni streams (state/vision/bulk): one msg per stream.
        void this.acceptUniStreams(wt.incomingUnidirectionalStreams);

        this._connected = true;
        this.events.onOpen?.();
    }

    disconnect(): void {
        this.closing = true;
        this._connected = false;
        try { this.controlWriter?.close(); } catch { /* ignore */ }
        try { this.stateWriter?.abort(); } catch { /* ignore */ }
        try { this.wt?.close(); } catch { /* ignore */ }
        this.wt = null;
        this.controlWriter = null;
        this.datagramWriter = null;
        this.stateWriter = null;
    }

    send(data: Uint8Array, cls: TransportClass = 'control'): void {
        if (!this._connected || !this.wt) return;
        switch (cls) {
            case 'control':
                this.controlWriter?.write(frameControlMessage(data)).catch(() => {});
                break;
            case 'datagram':
                this.datagramWriter?.write(data).catch(() => {});
                break;
            case 'state':
                void this.sendStateNewestWins(data);
                break;
            case 'vision':
            case 'bulk':
                void this.sendUni(data, cls);
                break;
        }
    }

    // --- framing ---

    private async sendUni(data: Uint8Array, cls: TransportClass): Promise<void> {
        if (!this.wt) return;
        try {
            const stream = await this.wt.createUnidirectionalStream({ sendOrder: CLASS_SEND_ORDER[cls] });
            const w = stream.getWriter();
            await w.write(data);
            await w.close();
        } catch { /* session closing */ }
    }

    /** State is newest-wins: abort any in-flight prior state stream, send fresh. */
    private async sendStateNewestWins(data: Uint8Array): Promise<void> {
        if (!this.wt) return;
        if (this.stateWriter) {
            try { await this.stateWriter.abort(); } catch { /* ignore */ }
            this.stateWriter = null;
        }
        try {
            const stream = await this.wt.createUnidirectionalStream({ sendOrder: CLASS_SEND_ORDER.state });
            const w = stream.getWriter();
            this.stateWriter = w;
            await w.write(data);
            await w.close();
            if (this.stateWriter === w) this.stateWriter = null;
        } catch { /* aborted by a newer send, or session closing */ }
    }

    // --- readers ---

    /** Read length-delimited `[u32 len][payload]` frames off the control stream. */
    private async readControlFrames(readable: ReadableStream<Uint8Array>): Promise<void> {
        const reader = readable.getReader();
        const deframer = new ControlFrameDeframer();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) deframer.push(value, (msg) => this.events.onMessage?.(msg));
            }
        } catch { /* stream closed */ }
    }

    /** Each incoming uni stream is exactly one message (read to FIN). */
    private async acceptUniStreams(streams: ReadableStream<ReadableStream<Uint8Array>>): Promise<void> {
        const reader = streams.getReader();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) void this.readWholeStream(value);
            }
        } catch { /* session closed */ }
    }

    private async readWholeStream(stream: ReadableStream<Uint8Array>): Promise<void> {
        const reader = stream.getReader();
        let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value) buf = concat(buf, value);
            }
            if (buf.length > 0) this.events.onMessage?.(buf);
        } catch { /* stream reset (newest-wins) — drop */ }
    }

    private async readDatagrams(readable: ReadableStream<Uint8Array>): Promise<void> {
        const reader = readable.getReader();
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                if (value && value.length > 0) this.events.onMessage?.(value);
            }
        } catch { /* session closed */ }
    }

    private handleClosed(code: number, reason: string): void {
        if (!this.closing) {
            this._connected = false;
            this.events.onClose?.(code, reason);
        }
    }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length === 0) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}
