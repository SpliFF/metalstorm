/**
 * Connection — manages WebSocket lifecycle to the game server.
 *
 * Handles connect/disconnect, envelope framing, FlatBuffers
 * serialisation, and dispatches parsed messages to handlers.
 */

import * as flatbuffers from 'flatbuffers';
import { ClientMessage } from '../protocol/spring-web/client-message.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';
import { ServerMessage } from '../protocol/spring-web/server-message.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';
import { Handshake } from '../protocol/spring-web/handshake.js';
import { AuthRequest } from '../protocol/spring-web/auth-request.js';
import { AuthResponse } from '../protocol/spring-web/auth-response.js';
import { Ping } from '../protocol/spring-web/ping.js';
import { Pong } from '../protocol/spring-web/pong.js';
import { ServerError } from '../protocol/spring-web/server-error.js';
import { AuthStatus } from '../protocol/spring-web/auth-status.js';
import { ServerClock } from './clock.js';
import { parseEntityState, type EntityStateSnapshot } from './entity-state.js';

const ENVELOPE_FLATBUFFERS = 0x01;
const ENVELOPE_ENTITY_STATE = 0x02;
const PROTOCOL_VERSION = 1;

export type ConnectionState = 'disconnected' | 'connecting' | 'handshake' | 'authenticating' | 'connected';

export interface ConnectionEvents {
    onStateChange?: (state: ConnectionState) => void;
    onAuthenticated?: (playerId: number, token: string) => void;
    onAuthFailed?: (message: string) => void;
    onServerError?: (code: number, message: string) => void;
    onEntityState?: (snapshot: EntityStateSnapshot) => void;
    onServerMessage?: (msg: ServerMessage) => void;
}

export class Connection {
    private ws: WebSocket | null = null;
    private _state: ConnectionState = 'disconnected';
    private events: ConnectionEvents;
    private sessionToken: string | null = null;
    private playerId: number = 0;
    private clock = new ServerClock();
    private pingInterval: ReturnType<typeof setInterval> | null = null;

    constructor(events: ConnectionEvents = {}) {
        this.events = events;
    }

    get state(): ConnectionState { return this._state; }
    get authenticated(): boolean { return this._state === 'connected'; }
    get serverClock(): ServerClock { return this.clock; }

    /** Connect to the server and authenticate. */
    connect(url: string, username: string, password: string): void {
        if (this.ws) this.disconnect();

        this.setState('connecting');
        this.ws = new WebSocket(url);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            this.setState('handshake');
            this.sendHandshake();
            this.setState('authenticating');
            this.sendAuthRequest(username, password);
        };

        this.ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this.handleBinaryMessage(new Uint8Array(event.data));
            }
        };

        this.ws.onclose = () => {
            this.cleanup();
            this.setState('disconnected');
        };

        this.ws.onerror = () => {
            this.cleanup();
            this.setState('disconnected');
        };
    }

    /** Disconnect from the server. */
    disconnect(): void {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.cleanup();
        this.setState('disconnected');
    }

    /** Send a raw FlatBuffers ClientMessage. */
    sendClientMessage(builder: flatbuffers.Builder, payloadType: ClientPayload, payloadOffset: number): void {
        ClientMessage.startClientMessage(builder);
        ClientMessage.addPayloadType(builder, payloadType);
        ClientMessage.addPayload(builder, payloadOffset);
        const msg = ClientMessage.endClientMessage(builder);
        builder.finish(msg);

        const buf = builder.asUint8Array();
        const frame = new Uint8Array(1 + buf.length);
        frame[0] = ENVELOPE_FLATBUFFERS;
        frame.set(buf, 1);

        this.ws?.send(frame);
    }

    private setState(state: ConnectionState): void {
        this._state = state;
        this.events.onStateChange?.(state);
    }

    private cleanup(): void {
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }

    private sendHandshake(): void {
        const builder = new flatbuffers.Builder(128);
        const clientVersion = builder.createString('spring-web-client 0.1');
        Handshake.startHandshake(builder);
        Handshake.addProtocolVersion(builder, PROTOCOL_VERSION);
        Handshake.addClientVersion(builder, clientVersion);
        const hs = Handshake.endHandshake(builder);
        this.sendClientMessage(builder, ClientPayload.Handshake, hs);
    }

    private sendAuthRequest(username: string, password: string): void {
        const builder = new flatbuffers.Builder(256);
        const uOffset = builder.createString(username);
        const pOffset = builder.createString(password);

        // If we have a session token, try reconnecting with it
        const tOffset = this.sessionToken
            ? builder.createString(this.sessionToken)
            : 0;

        AuthRequest.startAuthRequest(builder);
        AuthRequest.addUsername(builder, uOffset);
        AuthRequest.addPasswordHash(builder, pOffset);
        if (tOffset) AuthRequest.addToken(builder, tOffset);
        const auth = AuthRequest.endAuthRequest(builder);
        this.sendClientMessage(builder, ClientPayload.AuthRequest, auth);
    }

    private sendPing(): void {
        const builder = new flatbuffers.Builder(64);
        Ping.startPing(builder);
        Ping.addClientTime(builder, BigInt(Math.floor(performance.now())));
        const ping = Ping.endPing(builder);
        this.sendClientMessage(builder, ClientPayload.Ping, ping);
    }

    private handleBinaryMessage(data: Uint8Array): void {
        if (data.length < 2) return;

        const envelope = data[0];
        if (envelope === ENVELOPE_ENTITY_STATE) {
            const snapshot = parseEntityState(data.subarray(1));
            if (snapshot) this.events.onEntityState?.(snapshot);
            return;
        }
        if (envelope !== ENVELOPE_FLATBUFFERS) {
            return;
        }

        const buf = new flatbuffers.ByteBuffer(data.slice(1));
        const msg = ServerMessage.getRootAsServerMessage(buf);

        switch (msg.payloadType()) {
            case ServerPayload.AuthResponse:
                this.handleAuthResponse(msg);
                break;
            case ServerPayload.Pong:
                this.handlePong(msg);
                break;
            case ServerPayload.ServerError:
                this.handleServerError(msg);
                break;
            default:
                this.events.onServerMessage?.(msg);
                break;
        }
    }

    private handleAuthResponse(msg: ServerMessage): void {
        const auth = msg.payload(new AuthResponse()) as AuthResponse;
        if (auth.status() === AuthStatus.OK) {
            this.sessionToken = auth.token() ?? null;
            this.playerId = auth.playerId();
            this.setState('connected');
            this.events.onAuthenticated?.(this.playerId, this.sessionToken ?? '');

            // Start periodic pings for clock sync
            this.pingInterval = setInterval(() => this.sendPing(), 30000);
            this.sendPing(); // Immediate first ping
        } else {
            const message = auth.message() ?? 'Authentication failed';
            this.events.onAuthFailed?.(message);
            this.disconnect();
        }
    }

    private handlePong(msg: ServerMessage): void {
        const pong = msg.payload(new Pong()) as Pong;
        const now = performance.now();
        this.clock.addSample(
            Number(pong.clientTime()),
            Number(pong.serverTime()),
            now
        );
    }

    private handleServerError(msg: ServerMessage): void {
        const err = msg.payload(new ServerError()) as ServerError;
        this.events.onServerError?.(err.code(), err.message() ?? 'Unknown error');
    }
}
