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
import { ViewportUpdate } from '../protocol/spring-web/viewport-update.js';
import { Pong } from '../protocol/spring-web/pong.js';
import { ServerError } from '../protocol/spring-web/server-error.js';
import { AuthStatus } from '../protocol/spring-web/auth-status.js';
import { GameEventBatch } from '../protocol/spring-web/game-event-batch.js';
import { CombatEvent } from '../protocol/spring-web/combat-event.js';
import { EntityDestroy } from '../protocol/spring-web/entity-destroy.js';
import { GameInfo } from '../protocol/spring-web/game-info.js';
import { MapData } from '../protocol/spring-web/map-data.js';
import { ServerClock } from './clock.js';
import { parseEntityState, type EntityStateSnapshot } from './entity-state.js';
import { parseMapData, type ParsedMapData } from './map-data.js';

const ENVELOPE_FLATBUFFERS = 0x01;
const ENVELOPE_ENTITY_STATE_FULL = 0x02;
const ENVELOPE_ENTITY_STATE_DELTA = 0x03;
const PROTOCOL_VERSION = 1;

export type ConnectionState = 'disconnected' | 'connecting' | 'handshake' | 'authenticating' | 'connected';

/** Parsed combat event for client consumption. */
export interface CombatEventInfo {
    attackerId: number;
    targetId: number;
    weaponDefId: number;
    result: number;     // 0=hit, 1=miss, 2=blocked, 3=kill
    damage: number;
    x: number;
    y: number;
    z: number;
}

/// Lobby vs game-server session roles. The game server stamps a
/// real team id on the session during AuthRequest; the lobby
/// leaves it at -1. Code outside Connection reads this via
/// `Connection.myTeam` to scope unit rendering, selection, and
/// command validation.
export interface ConnectionEvents {
    onStateChange?: (state: ConnectionState) => void;
    onAuthenticated?: (playerId: number, token: string, team: number) => void;
    onAuthFailed?: (message: string) => void;
    onServerError?: (code: number, message: string) => void;
    onEntityState?: (snapshot: EntityStateSnapshot, isDelta: boolean) => void;
    onCombatEvents?: (events: CombatEventInfo[], frame: number) => void;
    onEntityDestroy?: (entityId: number, x: number, y: number, z: number) => void;
    onGameOver?: (frame: number) => void;
    onMapData?: (map: ParsedMapData) => void;
    onServerMessage?: (msg: ServerMessage) => void;
}

export class Connection {
    private ws: WebSocket | null = null;
    private _state: ConnectionState = 'disconnected';
    private events: ConnectionEvents;
    private sessionToken: string | null = null;
    private playerId: number = 0;
    /// Team id assigned by the game server at auth time. -1 when
    /// connected to the lobby (which doesn't track teams on a
    /// per-connection basis) or when no roster applies.
    public myTeam: number = -1;
    private clock = new ServerClock();
    private pingInterval: ReturnType<typeof setInterval> | null = null;

    constructor(events: ConnectionEvents = {}) {
        this.events = events;
    }

    get state(): ConnectionState { return this._state; }
    get authenticated(): boolean { return this._state === 'connected'; }
    get serverClock(): ServerClock { return this.clock; }

    /** Update event callbacks (merges with existing). */
    setEvents(overrides: Partial<ConnectionEvents>): void {
        Object.assign(this.events, overrides);
    }

    /** Connect to the server and authenticate.
     *  Pass token (instead of password) for session reconnection.
     *
     *  Retries a few times if the initial connection fails — the target
     *  server may still be starting (common when the lobby spawns a game
     *  server and immediately tells the client to connect to it).
     */
    connect(url: string, username: string, password: string, token?: string): void {
        if (this.ws) this.disconnect();

        // Store token for reconnection auth
        if (token) this.sessionToken = token;

        this.pendingUrl = url;
        this.pendingUsername = username;
        this.pendingPassword = password;
        this.connectAttempts = 0;
        this.tryConnect();
    }

    private pendingUrl = '';
    private pendingUsername = '';
    private pendingPassword = '';
    private connectAttempts = 0;
    private static readonly MAX_CONNECT_ATTEMPTS = 10;
    private static readonly CONNECT_RETRY_DELAY_MS = 500;

    private tryConnect(): void {
        this.connectAttempts++;
        this.setState('connecting');

        const ws = new WebSocket(this.pendingUrl);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        // If the connect doesn't settle within the retry window, treat it
        // as a failure so we can retry. Otherwise Chrome hangs in CONNECTING.
        const connectTimer = setTimeout(() => {
            if (ws.readyState === WebSocket.CONNECTING) {
                try { ws.close(); } catch { /* ignore */ }
            }
        }, Connection.CONNECT_RETRY_DELAY_MS * 4);

        let opened = false;
        // A failed WebSocket fires BOTH `error` and `close` (in that
        // order). Without this guard we'd retry twice per failed
        // attempt, and each retry would itself double on its next
        // failure — a single lobby restart would surface as an
        // exponential burst of 2, 4, 8, 16 concurrent reconnect
        // attempts hitting the server at once, all authing with the
        // same token. One-shot the failure handler per attempt.
        let failed = false;

        ws.onopen = () => {
            opened = true;
            clearTimeout(connectTimer);
            this.setState('handshake');
            this.sendHandshake();
            this.setState('authenticating');
            this.sendAuthRequest(this.pendingUsername, this.pendingPassword);
        };

        ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this.handleBinaryMessage(new Uint8Array(event.data));
            }
        };

        const handleFailure = () => {
            if (failed) return;
            failed = true;

            if (opened && this._state === 'connected') {
                // Real disconnect after a successful connection
                this.cleanup();
                this.setState('disconnected');
                return;
            }
            clearTimeout(connectTimer);
            if (this.ws !== ws) return; // superseded by a new attempt
            // Initial connection failed — retry a few times
            if (this.connectAttempts < Connection.MAX_CONNECT_ATTEMPTS) {
                console.log(`[connection] connect attempt ${this.connectAttempts} failed, retrying...`);
                setTimeout(() => this.tryConnect(), Connection.CONNECT_RETRY_DELAY_MS);
            } else {
                console.error(`[connection] giving up after ${this.connectAttempts} attempts`);
                this.cleanup();
                this.setState('disconnected');
            }
        };

        ws.onclose = handleFailure;
        ws.onerror = handleFailure;
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

    /** Send a viewport update to the server. */
    sendViewportUpdate(
        viewportId: number,
        centerX: number, centerZ: number,
        width: number, height: number,
        rotation: number, zoomLevel: number
    ): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(128);
        const vp = ViewportUpdate.createViewportUpdate(
            builder, viewportId, centerX, centerZ, width, height, rotation, zoomLevel);
        this.sendClientMessage(builder, ClientPayload.ViewportUpdate, vp);
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
        if (envelope === ENVELOPE_ENTITY_STATE_FULL || envelope === ENVELOPE_ENTITY_STATE_DELTA) {
            const snapshot = parseEntityState(data.subarray(1));
            if (snapshot) {
                this.events.onEntityState?.(snapshot, envelope === ENVELOPE_ENTITY_STATE_DELTA);
            }
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
            case ServerPayload.GameEventBatch:
                this.handleGameEventBatch(msg);
                break;
            case ServerPayload.EntityDestroy:
                this.handleEntityDestroy(msg);
                break;
            case ServerPayload.GameInfo: {
                const info = msg.payload(new GameInfo()) as GameInfo;
                if (info.paused()) {
                    this.events.onGameOver?.(info.frame());
                }
                break;
            }
            case ServerPayload.MapData: {
                const fbMap = msg.payload(new MapData()) as MapData;
                try {
                    const parsed = parseMapData(fbMap);
                    this.events.onMapData?.(parsed);
                } catch (err) {
                    console.error('[connection] failed to parse MapData:', err);
                }
                break;
            }
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
            // Game server stamps a real team id (0..N); lobby leaves
            // the field at -1. Consumers (entity renderer, selection,
            // minimap colouring) read this via `myTeam`.
            this.myTeam = auth.team();
            this.setState('connected');
            this.events.onAuthenticated?.(this.playerId, this.sessionToken ?? '', this.myTeam);

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

    private handleGameEventBatch(msg: ServerMessage): void {
        const batch = msg.payload(new GameEventBatch()) as GameEventBatch;
        const frame = batch.frame();

        const combatCount = batch.combatEventsLength();
        if (combatCount > 0 && this.events.onCombatEvents) {
            const events: CombatEventInfo[] = [];
            for (let i = 0; i < combatCount; i++) {
                const ce = batch.combatEvents(i);
                if (!ce) continue;
                const pos = ce.position();
                events.push({
                    attackerId: ce.attackerId(),
                    targetId: ce.targetId(),
                    weaponDefId: ce.weaponDefId(),
                    result: ce.result(),
                    damage: ce.damage(),
                    x: pos ? pos.x() : 0,
                    y: pos ? pos.y() : 0,
                    z: pos ? pos.z() : 0,
                });
            }
            this.events.onCombatEvents(events, frame);
        }
    }

    private handleEntityDestroy(msg: ServerMessage): void {
        const destroy = msg.payload(new EntityDestroy()) as EntityDestroy;
        const pos = destroy.position();
        this.events.onEntityDestroy?.(
            destroy.entityId(),
            pos ? pos.x() : 0,
            pos ? pos.y() : 0,
            pos ? pos.z() : 0,
        );
    }
}
