/**
 * GameTransport — abstract transport layer for server communication.
 *
 * The protocol abstraction decouples message framing from the underlying
 * protocol. WebRTC data channels are the *current* transport; the planned
 * migration (PLAN-game-worker.md, PLAN.md Stage 0) moves to **WebTransport-only**
 * (drop WebRTC), running the connection inside the game-processor worker and
 * using QUIC stream priorities. The `'webrtc'` arm is removed at that point.
 *
 * On WebRTC, the `reliable` flag maps to ordered vs. unordered data
 * channels. On WebTransport, per-frame state uses newest-wins QUIC streams
 * (snapshots exceed the datagram MTU) and control uses prioritised streams;
 * `send()` gains a priority/class arg then.
 */

export interface TransportEvents {
    onOpen?: () => void;
    onClose?: (code: number, reason: string) => void;
    onMessage?: (data: Uint8Array) => void;
    onError?: (error: string) => void;
}

export interface GameTransport {
    /** Connect to a server URL. */
    connect(url: string): void;

    /** Disconnect from the server. */
    disconnect(): void;

    /** Send a binary message. reliable=true for ordered delivery. */
    send(data: Uint8Array, reliable?: boolean): void;

    /** Whether the transport is currently connected. */
    readonly connected: boolean;

    /** Transport type identifier. */
    readonly type: 'webrtc' | 'webtransport';
}

/**
 * WebTransport implementation (stub — real impl is PLAN-game-worker.md GW3).
 *
 * WebTransport reached Baseline (Chrome/Firefox/Safari) in March 2026, so the
 * old "estimated 2027+" wait is moot. The real adapter (per-class prioritised
 * streams + datagrams, running in the game-processor worker) lands with the
 * Stage-0 consolidation; this stub holds the seam until then.
 */
export class WebTransportAdapter implements GameTransport {
    private events: TransportEvents;
    private _connected = false;

    constructor(events: TransportEvents) {
        this.events = events;
    }

    get connected(): boolean { return this._connected; }
    get type(): 'webtransport' { return 'webtransport'; }

    connect(url: string): void {
        // Stub — WebTransport not yet implemented
        console.warn('[transport] WebTransport not yet implemented');
        this.events.onError?.('WebTransport not available');
        (void url);
    }

    disconnect(): void {
        this._connected = false;
    }

    send(_data: Uint8Array, _reliable?: boolean): void {
        // Stub
    }
}
