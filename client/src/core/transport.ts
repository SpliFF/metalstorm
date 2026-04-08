/**
 * GameTransport — abstract transport layer for server communication.
 *
 * Per PLAN-network.md, the protocol uses a transport abstraction that
 * decouples message framing from the underlying protocol. WebSocket
 * is the current transport; WebTransport (QUIC) is a future upgrade.
 *
 * On WebSocket, the `reliable` flag is ignored (TCP is always reliable).
 * On WebTransport, unreliable messages use QUIC datagrams, reliable
 * messages use QUIC streams.
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
    readonly type: 'websocket' | 'webtransport';
}

/**
 * WebSocket implementation of GameTransport.
 * This is the current default transport.
 */
export class WebSocketTransport implements GameTransport {
    private ws: WebSocket | null = null;
    private events: TransportEvents;

    constructor(events: TransportEvents) {
        this.events = events;
    }

    get connected(): boolean {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    get type(): 'websocket' {
        return 'websocket';
    }

    connect(url: string): void {
        if (this.ws) this.disconnect();

        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => this.events.onOpen?.();
        this.ws.onclose = (e) => this.events.onClose?.(e.code, e.reason);
        this.ws.onerror = () => this.events.onError?.('WebSocket error');
        this.ws.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
                this.events.onMessage?.(new Uint8Array(e.data));
            }
        };
    }

    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }

    send(data: Uint8Array, _reliable?: boolean): void {
        // WebSocket is always reliable (TCP)
        this.ws?.send(data as unknown as ArrayBuffer);
    }
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
        // Stub — falls back to WebSocket for now
        console.warn('[transport] WebTransport not yet implemented, use WebSocketTransport');
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

/**
 * Create the best available transport.
 * Currently always returns WebSocket; will auto-detect WebTransport
 * support in the future.
 */
export function createTransport(events: TransportEvents): GameTransport {
    // Future: check for WebTransport API availability
    // if ('WebTransport' in globalThis) return new WebTransportAdapter(events);
    return new WebSocketTransport(events);
}
