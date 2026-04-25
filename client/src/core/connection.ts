/**
 * Connection — manages HTTP auth + WebRTC data channels to the game server.
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
 */

import * as flatbuffers from 'flatbuffers';
import { ClientMessage } from '../protocol/spring-web/client-message.js';
import { ClientPayload } from '../protocol/spring-web/client-payload.js';
import { ServerMessage } from '../protocol/spring-web/server-message.js';
import { ServerPayload } from '../protocol/spring-web/server-payload.js';
import { Ping } from '../protocol/spring-web/ping.js';
import { ViewportUpdate } from '../protocol/spring-web/viewport-update.js';
import { Pong } from '../protocol/spring-web/pong.js';
import { ServerError } from '../protocol/spring-web/server-error.js';
import { GameEventBatch } from '../protocol/spring-web/game-event-batch.js';
import { CombatEvent } from '../protocol/spring-web/combat-event.js';
import { EntityDestroy } from '../protocol/spring-web/entity-destroy.js';
import { GameInfo } from '../protocol/spring-web/game-info.js';
import { ResourceUpdate } from '../protocol/spring-web/resource-update.js';
import { MapData } from '../protocol/spring-web/map-data.js';
import { GameUnitDefs } from '../protocol/spring-web/game-unit-defs.js';
import { GameUnitDef } from '../protocol/spring-web/game-unit-def.js';
import { PlayerLeft } from '../protocol/spring-web/player-left.js';
import { GameWeaponDefs } from '../protocol/spring-web/game-weapon-defs.js';
import { GameWeaponDef } from '../protocol/spring-web/game-weapon-def.js';
import { AuthRequest } from '../protocol/spring-web/auth-request.js';
import { AuthResponse } from '../protocol/spring-web/auth-response.js';
import { AuthStatus } from '../protocol/spring-web/auth-status.js';
import { ServerClock } from './clock.js';
import { parseEntityState, type EntityStateSnapshot } from './entity-state.js';
import { parseProjectileState, type ProjectileStateSnapshot } from './projectile-state.js';
import { parseMapData, type ParsedMapData } from './map-data.js';

const ENVELOPE_FLATBUFFERS = 0x01;
const ENVELOPE_ENTITY_STATE_FULL = 0x02;
const ENVELOPE_ENTITY_STATE_DELTA = 0x03;
const ENVELOPE_PROJECTILE_STATE = 0x04;
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
    onResourceUpdate?: (team: number, metal: number, maxMetal: number, energy: number, maxEnergy: number, metalIncome: number, energyIncome: number) => void;
    onGameInfo?: (frame: number, speed: number, paused: boolean,
                  wind?: { x: number; y: number; z: number; strength: number; tidal: number }) => void;
    onServerMessage?: (msg: ServerMessage) => void;
}

export class Connection {
    // Transport — WebRTC only
    private pc: RTCPeerConnection | null = null;
    private controlChannel: RTCDataChannel | null = null;
    private stateChannel: RTCDataChannel | null = null;

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
     * `url` is the HTTP base URL (http://host:port) for auth and
     * WebRTC signaling.
     */
    connect(url: string, username: string, password: string, token?: string): void {
        if (this.pc) this.disconnect();

        if (token) this.sessionToken = token;

        this.httpBase = url;
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

        // Step 1: HTTP auth (token or password)
        try {
            await this.httpAuth(this.pendingUsername, this.pendingPassword);
        } catch (err) {
            if (this.connectAttempts < Connection.MAX_CONNECT_ATTEMPTS) {
                console.log(`[connection] auth attempt ${this.connectAttempts} failed (${err}), retrying...`);
                setTimeout(() => this.tryConnect(), Connection.CONNECT_RETRY_DELAY_MS);
                return;
            }
            console.error(`[connection] giving up after ${this.connectAttempts} attempts`);
            this.events.onAuthFailed?.(`${err}`);
            this.setState('disconnected');
            return;
        }

        // Step 2: WebRTC data channels
        this.setState('handshake');
        try {
            await this.connectWebRTC();
        } catch (err) {
            if (this.connectAttempts < Connection.MAX_CONNECT_ATTEMPTS) {
                console.log(`[connection] WebRTC attempt ${this.connectAttempts} failed (${err}), retrying...`);
                setTimeout(() => this.tryConnect(), Connection.CONNECT_RETRY_DELAY_MS);
                return;
            }
            console.error(`[connection] giving up after ${this.connectAttempts} attempts`);
            this.events.onAuthFailed?.(`WebRTC connection failed: ${err}`);
            this.setState('disconnected');
        }
    }

    // ─── HTTP Auth ───

    private async httpAuth(username: string, password: string): Promise<void> {
        this.setState('authenticating');

        // Try token reconnection first
        if (this.sessionToken) {
            const resp = await fetch(`${this.httpBase}/api/auth/validate`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.sessionToken}`,
                    'Content-Type': 'application/json',
                },
                body: '{}',
            });

            if (resp.ok) {
                const data = await resp.json();
                if (data.valid) {
                    this.playerId = data.user_id ?? this.playerId;
                    this.myTeam = data.team ?? this.myTeam;
                    console.log(`[connection] token valid for user '${data.username}'`);
                    return;
                }
            }
            // Token rejected — clear it and try password
            console.log('[connection] token expired or invalid');
            this.sessionToken = null;
        }

        // Password login
        if (!password) {
            throw new Error('no valid token and no password');
        }

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

        // Connected via WebRTC — send auth over the data channel so the
        // game server creates a ClientSession for us. Don't fire
        // onAuthenticated yet — wait for the server's AuthResponse
        // which carries the correct team assignment.
        console.log(`[connection] WebRTC connected (clientId=${this.rtcClientId})`);
        this.sendAuthRequest();

        this.pingInterval = setInterval(() => this.sendPing(), 30000);
        this.sendPing();
    }

    // ─── Send ───

    disconnect(): void {
        if (this.controlChannel) { try { this.controlChannel.close(); } catch {} }
        if (this.stateChannel) { try { this.stateChannel.close(); } catch {} }
        if (this.pc) { try { this.pc.close(); } catch {} }
        this.controlChannel = null;
        this.stateChannel = null;
        this.pc = null;
        this.cleanup();
        this.setState('disconnected');
    }

    private sendAuthRequest(): void {
        const builder = new flatbuffers.Builder(256);
        const usernameOff = builder.createString(this.pendingUsername);
        const tokenOff = this.sessionToken
            ? builder.createString(this.sessionToken) : 0;
        const passwordOff = this.pendingPassword
            ? builder.createString(this.pendingPassword) : 0;
        const auth = AuthRequest.createAuthRequest(
            builder, usernameOff, passwordOff, tokenOff);
        this.sendClientMessage(builder, ClientPayload.AuthRequest, auth);
        console.log(`[connection] sent AuthRequest for '${this.pendingUsername}'`);
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
            case ServerPayload.AuthResponse: {
                const ar = msg.payload(new AuthResponse()) as AuthResponse;
                if (ar.status() === AuthStatus.OK) {
                    this.playerId = ar.playerId();
                    this.myTeam = ar.team();
                    if (ar.token()) this.sessionToken = ar.token();
                    console.log(`[connection] AuthResponse OK: playerId=${this.playerId}, team=${this.myTeam}`);
                    this.setState('connected');
                    this.events.onAuthenticated?.(this.playerId, this.sessionToken ?? '', this.myTeam);
                } else {
                    const errMsg = ar.message() ?? 'auth failed';
                    console.error(`[connection] AuthResponse rejected: ${errMsg}`);
                    this.events.onAuthFailed?.(errMsg);
                    this.disconnect();
                }
                break;
            }
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
                this.events.onGameInfo?.(info.frame(), info.gameSpeed(), info.paused(), {
                    x: info.windX(), y: info.windY(), z: info.windZ(),
                    strength: info.windStrength(),
                    tidal: info.tidalStrength(),
                });
                if (info.paused()) {
                    this.events.onGameOver?.(info.frame());
                }
                break;
            }
            case ServerPayload.ResourceUpdate: {
                const ru = msg.payload(new ResourceUpdate()) as ResourceUpdate;
                this.events.onResourceUpdate?.(
                    ru.team(), ru.metal(), ru.maxMetal(),
                    ru.energy(), ru.maxEnergy(),
                    ru.metalIncome(), ru.energyIncome());
                break;
            }
            case ServerPayload.MapData: {
                // Legacy: MapData is now fetched via HTTP from the lobby
                // server (metadata.json + binary .bin files). The game
                // server no longer sends this message. Kept for backwards
                // compatibility in case an older server is encountered.
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
            case ServerPayload.GameRestarting:
                console.log('[connection] server restarting — reloading page');
                window.location.reload();
                break;
            default:
                this.events.onServerMessage?.(msg);
                break;
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
