/**
 * Connection — manages WebRTC + HTTP lifecycle to the game server.
 *
 * Auth flow:
 *   1. HTTP POST /api/auth/login → token
 *   2. Create RTCPeerConnection with two negotiated data channels
 *   3. HTTP POST /api/rtc/offer → SDP answer
 *   4. Data channels open → game begins
 *
 * Channels:
 *   "control" (id=0, reliable, ordered) — FlatBuffer messages
 *   "state"   (id=1, unreliable, unordered) — entity/projectile state
 *
 * Falls back to WebSocket if WebRTC signaling fails (dev/testing).
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
import { GameUnitDefs } from '../protocol/spring-web/game-unit-defs.js';
import { GameUnitDef } from '../protocol/spring-web/game-unit-def.js';
import { PlayerLeft } from '../protocol/spring-web/player-left.js';
import { GameWeaponDefs } from '../protocol/spring-web/game-weapon-defs.js';
import { GameWeaponDef } from '../protocol/spring-web/game-weapon-def.js';
import { ServerClock } from './clock.js';
import { parseEntityState, type EntityStateSnapshot } from './entity-state.js';
import { parseProjectileState, type ProjectileStateSnapshot } from './projectile-state.js';
import { parseMapData, type ParsedMapData } from './map-data.js';

const ENVELOPE_FLATBUFFERS = 0x01;
const ENVELOPE_ENTITY_STATE_FULL = 0x02;
const ENVELOPE_ENTITY_STATE_DELTA = 0x03;
const ENVELOPE_PROJECTILE_STATE = 0x04;
const PROTOCOL_VERSION = 1;

export type ConnectionState = 'disconnected' | 'connecting' | 'handshake' | 'authenticating' | 'connected';

export interface CombatEventInfo {
    attackerId: number;
    targetId: number;
    weaponDefId: number;
    result: number;
    damage: number;
    x: number;
    y: number;
    z: number;
}

export interface UnitDefInfo {
    defId: number;
    name: string;
    modelUrl: string;
    textureUrl: string;
}

export interface WeaponDefInfo {
    defId: number;
    name: string;
    visualType: number;
    projectileSpeed: number;
    range: number;
    aoe: number;
    size: number;
    intensity: number;
    colorR: number;
    colorG: number;
    colorB: number;
    duration: number;
    highTrajectory: boolean;
}

export interface ConnectionEvents {
    onStateChange?: (state: ConnectionState) => void;
    onAuthenticated?: (playerId: number, token: string, team: number) => void;
    onAuthFailed?: (message: string) => void;
    onServerError?: (code: number, message: string) => void;
    onEntityState?: (snapshot: EntityStateSnapshot, isDelta: boolean) => void;
    onCombatEvents?: (events: CombatEventInfo[], frame: number) => void;
    onEntityDestroy?: (entityId: number, x: number, y: number, z: number) => void;
    onGameOver?: (frame: number) => void;
    onPlayerLeft?: (playerId: number, username: string, team: number, reason: number) => void;
    onMapData?: (map: ParsedMapData) => void;
    onUnitDefs?: (defs: UnitDefInfo[]) => void;
    onWeaponDefs?: (defs: WeaponDefInfo[]) => void;
    onProjectileState?: (snapshot: ProjectileStateSnapshot) => void;
    onServerMessage?: (msg: ServerMessage) => void;
}

export class Connection {
    // Transport — either WebRTC or WebSocket (fallback)
    private pc: RTCPeerConnection | null = null;
    private controlChannel: RTCDataChannel | null = null;
    private stateChannel: RTCDataChannel | null = null;
    private ws: WebSocket | null = null;  // fallback only

    private _state: ConnectionState = 'disconnected';
    private events: ConnectionEvents;
    private sessionToken: string | null = null;
    private playerId: number = 0;
    public myTeam: number = -1;
    private clock = new ServerClock();
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private httpBase = '';  // e.g. "http://localhost:9100"
    private rtcClientId = 0;

    /** Expose the control data channel for debug console. */
    getWebSocket(): WebSocket | null { return this.ws; }
    getControlChannel(): RTCDataChannel | null { return this.controlChannel; }

    constructor(events: ConnectionEvents = {}) {
        this.events = events;
    }

    get state(): ConnectionState { return this._state; }
    get authenticated(): boolean { return this._state === 'connected'; }
    get serverClock(): ServerClock { return this.clock; }

    setEvents(overrides: Partial<ConnectionEvents>): void {
        Object.assign(this.events, overrides);
    }

    /**
     * Connect to the game server.
     * `url` is the WebSocket URL (ws://host:port) — the HTTP base
     * is derived from it for auth and signaling.
     */
    connect(url: string, username: string, password: string, token?: string): void {
        if (this.pc || this.ws) this.disconnect();

        if (token) this.sessionToken = token;

        // Derive HTTP base from WS URL
        this.httpBase = url.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
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

    private async tryConnect(): Promise<void> {
        this.connectAttempts++;
        this.setState('connecting');

        // Step 1: Try HTTP auth + WebRTC. If either fails, fall back
        // to WebSocket with FlatBuffer auth (the original path).
        let httpAuthOk = false;
        try {
            await this.httpAuth(this.pendingUsername, this.pendingPassword);
            httpAuthOk = true;
        } catch (err) {
            console.log(`[connection] HTTP auth failed (${err}), will use WS auth`);
        }

        if (httpAuthOk) {
            // Try WebRTC since we have an HTTP token
            this.setState('handshake');
            try {
                await this.connectWebRTC();
                return; // WebRTC connected successfully
            } catch (err) {
                console.warn(`[connection] WebRTC failed (${err}), falling back to WebSocket`);
            }
        }

        // Fall back to WebSocket with FlatBuffer auth
        this.connectWebSocket();
    }

    // ─── HTTP Auth ───

    private async httpAuth(username: string, password: string): Promise<void> {
        this.setState('authenticating');

        // Try token reconnection first
        if (this.sessionToken) {
            // Validate token by trying exec — if it fails, fall through to password
            try {
                const resp = await fetch(`${this.httpBase}/api/auth/validate`, {
                    headers: { 'Authorization': `Bearer ${this.sessionToken}` },
                });
                if (resp.ok) {
                    // Token still valid — we're authed
                    return;
                }
            } catch { /* fall through */ }
            // Token invalid, clear it
            this.sessionToken = null;
        }

        // Password login
        const resp = await fetch(`${this.httpBase}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });

        if (!resp.ok) {
            const data = await resp.json().catch(() => ({ error: 'login failed' }));
            throw new Error(data.error || `HTTP ${resp.status}`);
        }

        const data = await resp.json();
        if (!data.token) throw new Error('no token in login response');

        this.sessionToken = data.token;
        this.playerId = data.user_id ?? 0;
        this.myTeam = data.team ?? -1;
    }

    // ─── WebRTC ───

    private async connectWebRTC(): Promise<void> {
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        this.pc = pc;

        // Create negotiated data channels matching the server
        const controlChannel = pc.createDataChannel('control', {
            negotiated: true,
            id: 0,
            ordered: true,
        });
        controlChannel.binaryType = 'arraybuffer';

        const stateChannel = pc.createDataChannel('state', {
            negotiated: true,
            id: 1,
            ordered: false,
            maxRetransmits: 0,
        });
        stateChannel.binaryType = 'arraybuffer';

        this.controlChannel = controlChannel;
        this.stateChannel = stateChannel;

        // Wire message handlers
        controlChannel.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
                this.handleBinaryMessage(new Uint8Array(e.data));
            }
        };
        stateChannel.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
                this.handleBinaryMessage(new Uint8Array(e.data));
            }
        };

        // Wait for channels to open
        const channelReady = new Promise<void>((resolve, reject) => {
            let controlOpen = false;
            let stateOpen = false;
            const check = () => {
                if (controlOpen && stateOpen) resolve();
            };
            controlChannel.onopen = () => { controlOpen = true; check(); };
            stateChannel.onopen = () => { stateOpen = true; check(); };
            controlChannel.onerror = (e) => reject(new Error('control channel error'));
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'failed') reject(new Error('connection failed'));
            };
            setTimeout(() => reject(new Error('channel open timeout')), 10000);
        });

        // Create and send offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering to complete (or timeout)
        await new Promise<void>((resolve) => {
            if (pc.iceGatheringState === 'complete') { resolve(); return; }
            pc.onicegatheringstatechange = () => {
                if (pc.iceGatheringState === 'complete') resolve();
            };
            setTimeout(resolve, 3000); // don't wait forever
        });

        // Send offer to server via HTTP
        const sdpOffer = pc.localDescription?.sdp;
        if (!sdpOffer) throw new Error('no local SDP');

        const resp = await fetch(`${this.httpBase}/api/rtc/offer`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.sessionToken}`,
            },
            body: JSON.stringify({ sdp: sdpOffer }),
        });

        if (!resp.ok) {
            throw new Error(`RTC offer failed: HTTP ${resp.status}`);
        }

        const answer = await resp.json();
        if (!answer.sdp) throw new Error('no SDP in answer');

        this.rtcClientId = answer.client_id;
        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });

        // Wait for data channels to open
        await channelReady;

        // Connected via WebRTC
        console.log(`[connection] WebRTC connected (clientId=${this.rtcClientId})`);
        this.setState('connected');
        this.events.onAuthenticated?.(this.playerId, this.sessionToken ?? '', this.myTeam);

        // Send handshake on control channel
        this.sendHandshake();
        // Send auth request so the server registers our session
        this.sendAuthRequest(this.pendingUsername, this.pendingPassword);

        this.pingInterval = setInterval(() => this.sendPing(), 30000);
        this.sendPing();
    }

    // ─── WebSocket fallback ───

    private connectWebSocket(): void {
        const ws = new WebSocket(this.pendingUrl);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        let opened = false;
        let failed = false;

        ws.onopen = () => {
            opened = true;
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
                this.cleanup();
                this.setState('disconnected');
                return;
            }
            if (this.connectAttempts < Connection.MAX_CONNECT_ATTEMPTS) {
                console.log(`[connection] WS attempt ${this.connectAttempts} failed, retrying...`);
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

    // ─── Send ───

    disconnect(): void {
        if (this.controlChannel) { try { this.controlChannel.close(); } catch {} }
        if (this.stateChannel) { try { this.stateChannel.close(); } catch {} }
        if (this.pc) { try { this.pc.close(); } catch {} }
        if (this.ws) { try { this.ws.close(); } catch {} }
        this.controlChannel = null;
        this.stateChannel = null;
        this.pc = null;
        this.ws = null;
        this.cleanup();
        this.setState('disconnected');
    }

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

        this.sendOnControl(frame);
    }

    /** Send data on the control (reliable) channel. */
    private sendOnControl(data: Uint8Array): void {
        // Copy into a fresh ArrayBuffer for RTCDataChannel compatibility
        const buf = new ArrayBuffer(data.byteLength);
        new Uint8Array(buf).set(data);
        if (this.controlChannel?.readyState === 'open') {
            this.controlChannel.send(buf);
        } else if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(buf);
        }
    }

    // ─── Internal ───

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

    // ─── Message handling (transport-agnostic) ───

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
        if (envelope === ENVELOPE_PROJECTILE_STATE) {
            const snapshot = parseProjectileState(data.subarray(1));
            if (snapshot) {
                this.events.onProjectileState?.(snapshot);
            }
            return;
        }
        if (envelope !== ENVELOPE_FLATBUFFERS) return;

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
            case ServerPayload.GameUnitDefs: {
                const fbDefs = msg.payload(new GameUnitDefs()) as GameUnitDefs;
                const defs: UnitDefInfo[] = [];
                for (let i = 0; i < fbDefs.defsLength(); i++) {
                    const d = fbDefs.defs(i, new GameUnitDef());
                    if (!d) continue;
                    defs.push({
                        defId: d.defId(),
                        name: d.name() ?? '',
                        modelUrl: d.modelUrl() ?? '',
                        textureUrl: d.textureUrl() ?? '',
                    });
                }
                console.log(`[connection] received ${defs.length} unit def(s)`);
                this.events.onUnitDefs?.(defs);
                break;
            }
            case ServerPayload.PlayerLeft: {
                const pl = msg.payload(new PlayerLeft()) as PlayerLeft;
                console.log(`[connection] player left: ${pl.username()} (team ${pl.team()}, reason ${pl.reason()})`);
                this.events.onPlayerLeft?.(pl.playerId(), pl.username() ?? '', pl.team(), pl.reason());
                break;
            }
            case ServerPayload.GameWeaponDefs: {
                const fbDefs = msg.payload(new GameWeaponDefs()) as GameWeaponDefs;
                const defs: WeaponDefInfo[] = [];
                for (let i = 0; i < fbDefs.defsLength(); i++) {
                    const d = fbDefs.defs(i, new GameWeaponDef());
                    if (!d) continue;
                    defs.push({
                        defId: d.defId(),
                        name: d.name() ?? '',
                        visualType: d.visualType(),
                        projectileSpeed: d.projectileSpeed(),
                        range: d.range(),
                        aoe: d.aoe(),
                        size: d.size(),
                        intensity: d.intensity(),
                        colorR: d.colorR(),
                        colorG: d.colorG(),
                        colorB: d.colorB(),
                        duration: d.duration(),
                        highTrajectory: d.highTrajectory(),
                    });
                }
                console.log(`[connection] received ${defs.length} weapon def(s)`);
                this.events.onWeaponDefs?.(defs);
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
            this.sessionToken = auth.token() ?? this.sessionToken;
            this.playerId = auth.playerId();
            this.myTeam = auth.team();

            // For WS fallback path, this is the real auth completion.
            // For WebRTC, we already set connected in connectWebRTC().
            if (this._state !== 'connected') {
                this.setState('connected');
                this.events.onAuthenticated?.(this.playerId, this.sessionToken ?? '', this.myTeam);
                this.pingInterval = setInterval(() => this.sendPing(), 30000);
                this.sendPing();
            }
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
