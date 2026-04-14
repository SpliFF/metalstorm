/**
 * GameTransport — abstract transport layer for server communication.
 *
 * Per PLAN-network.md, the protocol uses a transport abstraction that
 * decouples message framing from the underlying protocol. WebRTC data
 * channels are the current transport; WebTransport (QUIC) is a future
 * upgrade.
 *
 * On WebRTC, the `reliable` flag maps to ordered vs. unordered data
 * channels. On WebTransport, unreliable messages use QUIC datagrams,
 * reliable messages use QUIC streams.
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
 * WebTransport implementation (stub for future QUIC support).
 *
 * When browser support is stable (estimated 2027+), this will use
 * the WebTransport API for unreliable datagrams (entity state) and
 * reliable streams (commands, chat).
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
