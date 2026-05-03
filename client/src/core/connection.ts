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
import { CustomParam } from '../protocol/spring-web/custom-param.js';
import { UnitCommandQueuesUpdate } from '../protocol/spring-web/unit-command-queues-update.js';
import { UnitCmdDescsUpdate } from '../protocol/spring-web/unit-cmd-descs-update.js';
import { UnitCmdDescs } from '../protocol/spring-web/unit-cmd-descs.js';
import { UnitCmdDesc } from '../protocol/spring-web/unit-cmd-desc.js';
import { UnitCommandQueue } from '../protocol/spring-web/unit-command-queue.js';
import { UnitOrder } from '../protocol/spring-web/unit-order.js';
import { AuthRequest } from '../protocol/spring-web/auth-request.js';
import { PlayerCommand } from '../protocol/spring-web/player-command.js';
import { LuaRulesMsg } from '../protocol/spring-web/lua-rules-msg.js';
import { AuthResponse } from '../protocol/spring-web/auth-response.js';
import { AuthStatus } from '../protocol/spring-web/auth-status.js';
import { ServerClock } from './clock.js';
import { parseEntityState, type EntityStateSnapshot } from './entity-state.js';
import { parseProjectileState, type ProjectileStateSnapshot } from './projectile-state.js';
import { parsePieceState, type PieceStateSnapshot } from './piece-state.js';
import { parseBuildActivity, type BuildActivitySnapshot } from './build-activity.js';
import { parseMapData, type ParsedMapData } from './map-data.js';

const ENVELOPE_FLATBUFFERS = 0x01;
const ENVELOPE_ENTITY_STATE_FULL = 0x02;
const ENVELOPE_ENTITY_STATE_DELTA = 0x03;
const ENVELOPE_PROJECTILE_STATE = 0x04;
const ENVELOPE_PIECE_STATE = 0x05;
const ENVELOPE_BUILD_ACTIVITY = 0x06;
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
    humanName: string;
    tooltip: string;
    wreckName: string;
    metalCost: number;
    energyCost: number;
    buildTime: number;
    metalMake: number;
    energyMake: number;
    metalUpkeep: number;
    energyUpkeep: number;
    metalStorage: number;
    energyStorage: number;
    extractsMetal: number;
    health: number;
    mass: number;
    radius: number;
    xsize: number;
    zsize: number;
    speed: number;
    turnRate: number;
    maxAcc: number;
    maxDec: number;
    losRadius: number;
    airLosRadius: number;
    radarRadius: number;
    sonarRadius: number;
    jammerRadius: number;
    seismicRadius: number;
    /** Behaviour bitfield. See `GameUnitDef.flags` in protocol.fbs. */
    flags: number;
    buildDistance: number;
    buildSpeed: number;
    buildOptions: number[];
    weaponDefIds: number[];
    /** Game-specific extension data, e.g. ZK's level/commtype/dynamic_comm. */
    customParams: Record<string, string>;
    repairSpeed: number;
    transportSize: number;
    transportMass: number;
    transportCapacity: number;
    yardmap: string;
    script: string;
    buildPic: string;
    maxVelocity: number;
    cost: number;
    maxWeaponRange: number;
    maxThisUnit: number;
    canBeAssisted: boolean;
    canSelfDestruct: boolean;
    selfDCountdown: number;
    categoryBits: number;
}

export interface UnitOrderInfo {
    cmdId: number;
    params: number[];
    options: number;
    tag: number;
    timeout: number;
}

export interface UnitCommandQueueInfo {
    unitId: number;
    orders: UnitOrderInfo[];
}

/** A single available command on a unit's command panel. */
export interface UnitCmdDescInfo {
    /** Spring command id. Negative = build (-cmdId is the unit-def id). */
    cmdId: number;
    disabled: boolean;
}

export interface UnitCmdDescsInfo {
    unitId: number;
    cmds: UnitCmdDescInfo[];
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
    typeName: string;
    description: string;
    defaultDamage: number;
    /** Per-armor-class damage table. Empty = uniform `defaultDamage`. */
    damages: number[];
    reloadTime: number;
    salvoSize: number;
    salvoDelay: number;
    accuracy: number;
    sprayAngle: number;
    movingAccuracy: number;
    targetMoveError: number;
    leadLimit: number;
    edgeEffectiveness: number;
    impulseFactor: number;
    impulseBoost: number;
    craterMult: number;
    craterBoost: number;
    craterAoe: number;
    fireStarter: number;
    flightTime: number;
    weaponAcceleration: number;
    turnRate: number;
    uptime: number;
    coverageRange: number;
    stockpileTime: number;
    metalCost: number;
    energyCost: number;
    /** Behaviour bitfield. See `GameWeaponDef.flags` in protocol.fbs. */
    flags: number;
    customParams: Record<string, string>;
}

export interface ResourceUpdateInfo {
    team: number;
    metal: number;
    maxMetal: number;
    energy: number;
    maxEnergy: number;
    /** Per-second income (extraction + reclaim + share-received). */
    metalIncome: number;
    energyIncome: number;
    /** Per-second pull — what builders/weapons want to spend, including
     *  unmet demand. Pull > income means the team is stalling. */
    metalPull: number;
    energyPull: number;
    /** Per-second expense actually drawn from storage. expense ≤ pull. */
    metalExpense: number;
    energyExpense: number;
    /** Storage headroom before share-threshold spillage kicks in. */
    metalShare: number;
    energyShare: number;
    /** Per-second resource transfer to allies. */
    metalSent: number;
    energySent: number;
    /** Per-second resource transfer from allies. */
    metalReceived: number;
    energyReceived: number;
    /** Per-second resources lost because storage was full. */
    metalExcess: number;
    energyExcess: number;
}

export interface ConnectionEvents {
    onStateChange?: (state: ConnectionState) => void;
    /** Fires when the server accepts auth. `defsCacheKey` is the
     *  content-addressed key for fetching the game's UnitDefs/WeaponDefs
     *  via HTTP — empty if the lobby (no defs) or a server that didn't
     *  bake them. Construct URLs as
     *    /api/games/data/{gameId}/cache/defs/{key}/unitdefs.bin
     *    /api/games/data/{gameId}/cache/defs/{key}/weapondefs.bin */
    onAuthenticated?: (playerId: number, token: string, team: number, defsCacheKey: string) => void;
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
    onUnitCommandQueues?: (queues: UnitCommandQueueInfo[]) => void;
    onUnitCmdDescs?: (units: UnitCmdDescsInfo[]) => void;
    onProjectileState?: (snapshot: ProjectileStateSnapshot) => void;
    onPieceState?: (snapshot: PieceStateSnapshot) => void;
    onBuildActivity?: (snapshot: BuildActivitySnapshot) => void;
    onResourceUpdate?: (info: ResourceUpdateInfo) => void;
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
    public playerId: number = 0;
    public myTeam: number = -1;
    private clock = new ServerClock();
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private httpBase = '';  // e.g. "http://localhost:9100"
    private rtcClientId = 0;
    private commandSequence = 0;

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

    /** Forward a `Spring.SendLuaRulesMsg(msg)` from a client widget to
     *  the server's synced LuaRules state. The bytes arrive at
     *  `gadget:RecvLuaMsg(msg, playerID)` verbatim — embedded NULs are
     *  preserved (ZK widgets like gui_contextmenu sometimes pack
     *  binary fields). PlayerID is resolved server-side from the
     *  authenticated session. */
    sendLuaRulesMsg(data: Uint8Array | string): void {
        if (!this.authenticated) return;
        const bytes = typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data;
        const builder = new flatbuffers.Builder(64 + bytes.length);
        const dataOff = LuaRulesMsg.createDataVector(builder, bytes);
        const msg = LuaRulesMsg.createLuaRulesMsg(builder, dataOff);
        this.sendClientMessage(builder, ClientPayload.LuaRulesMsg, msg);
    }

    /** Send a PlayerCommand (unit order) to the server. */
    sendPlayerCommand(
        commandId: number,
        unitIds: number[],
        params: number[],
        options: number = 0,
        timeoutFrames: number = 0,
    ): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(128 + unitIds.length * 4 + params.length * 4);
        const squadIdsOff = PlayerCommand.createSquadIdsVector(builder, unitIds);
        const paramsOff = PlayerCommand.createParamsVector(builder, params);
        this.commandSequence++;
        const cmd = PlayerCommand.createPlayerCommand(
            builder,
            this.commandSequence,
            commandId,
            squadIdsOff,
            paramsOff,
            options,
            timeoutFrames,
        );
        this.sendClientMessage(builder, ClientPayload.PlayerCommand, cmd);
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

    /** Feed a framed binary message (envelope byte + FlatBuffer payload)
     *  into the same dispatch path used for WebRTC frames. Used by the
     *  HTTP def-fetch path, which downloads the same bytes the server
     *  would otherwise stream and pumps them through here. */
    public ingestFramedMessage(data: Uint8Array): void {
        this.handleBinaryMessage(data);
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
        if (envelope === ENVELOPE_PROJECTILE_STATE) {
            const snapshot = parseProjectileState(data.subarray(1));
            if (snapshot) {
                this.events.onProjectileState?.(snapshot);
            }
            return;
        }
        if (envelope === ENVELOPE_PIECE_STATE) {
            const snapshot = parsePieceState(data.subarray(1));
            if (snapshot) {
                this.events.onPieceState?.(snapshot);
            }
            return;
        }
        if (envelope === ENVELOPE_BUILD_ACTIVITY) {
            const snapshot = parseBuildActivity(data.subarray(1));
            if (snapshot) {
                this.events.onBuildActivity?.(snapshot);
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
                    const defsCacheKey = ar.defsCacheKey() ?? '';
                    console.log(`[connection] AuthResponse OK: playerId=${this.playerId}, team=${this.myTeam}, defsKey=${defsCacheKey || '(none)'}`);
                    this.setState('connected');
                    this.events.onAuthenticated?.(this.playerId, this.sessionToken ?? '', this.myTeam, defsCacheKey);
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
                this.events.onResourceUpdate?.({
                    team: ru.team(),
                    metal: ru.metal(),         maxMetal: ru.maxMetal(),
                    energy: ru.energy(),       maxEnergy: ru.maxEnergy(),
                    metalIncome: ru.metalIncome(),     energyIncome: ru.energyIncome(),
                    metalPull: ru.metalPull(),         energyPull: ru.energyPull(),
                    metalExpense: ru.metalExpense(),   energyExpense: ru.energyExpense(),
                    metalShare: ru.metalShare(),       energyShare: ru.energyShare(),
                    metalSent: ru.metalSent(),         energySent: ru.energySent(),
                    metalReceived: ru.metalReceived(), energyReceived: ru.energyReceived(),
                    metalExcess: ru.metalExcess(),     energyExcess: ru.energyExcess(),
                });
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
                    const buildOptions: number[] = [];
                    for (let bi = 0; bi < d.buildOptionsLength(); bi++) {
                        buildOptions.push(d.buildOptions(bi) ?? 0);
                    }
                    const weaponDefIds: number[] = [];
                    for (let wi = 0; wi < d.weaponDefIdsLength(); wi++) {
                        weaponDefIds.push(d.weaponDefIds(wi) ?? 0);
                    }
                    const customParams: Record<string, string> = {};
                    const cpLen = d.customParamsLength();
                    for (let ci = 0; ci < cpLen; ci++) {
                        const cp = d.customParams(ci, new CustomParam());
                        if (!cp) continue;
                        const key = cp.key();
                        if (key) customParams[key] = cp.value() ?? '';
                    }
                    if (i < 3) {
                        console.log(`[connection] DEBUG def[${i}] name=${d.name()} cpLen=${cpLen} cp=`, customParams,
                            'transportSize=', d.transportSize(), 'repairSpeed=', d.repairSpeed());
                    }
                    defs.push({
                        defId: d.defId(),
                        name: d.name() ?? '',
                        modelUrl: d.modelUrl() ?? '',
                        textureUrl: d.textureUrl() ?? '',
                        humanName: d.humanName() ?? '',
                        tooltip: d.tooltip() ?? '',
                        wreckName: d.wreckName() ?? '',
                        metalCost: d.metalCost(),
                        energyCost: d.energyCost(),
                        buildTime: d.buildTime(),
                        metalMake: d.metalMake(),
                        energyMake: d.energyMake(),
                        metalUpkeep: d.metalUpkeep(),
                        energyUpkeep: d.energyUpkeep(),
                        metalStorage: d.metalStorage(),
                        energyStorage: d.energyStorage(),
                        extractsMetal: d.extractsMetal(),
                        health: d.health(),
                        mass: d.mass(),
                        radius: d.radius(),
                        xsize: d.xsize(),
                        zsize: d.zsize(),
                        speed: d.speed(),
                        turnRate: d.turnRate(),
                        maxAcc: d.maxAcc(),
                        maxDec: d.maxDec(),
                        losRadius: d.losRadius(),
                        airLosRadius: d.airLosRadius(),
                        radarRadius: d.radarRadius(),
                        sonarRadius: d.sonarRadius(),
                        jammerRadius: d.jammerRadius(),
                        seismicRadius: d.seismicRadius(),
                        flags: d.flags(),
                        buildDistance: d.buildDistance(),
                        buildSpeed: d.buildSpeed(),
                        buildOptions,
                        weaponDefIds,
                        customParams,
                        repairSpeed: d.repairSpeed(),
                        transportSize: d.transportSize(),
                        transportMass: d.transportMass(),
                        transportCapacity: d.transportCapacity(),
                        yardmap: d.yardmap() ?? '',
                        script: d.script() ?? '',
                        buildPic: d.buildPic() ?? '',
                        maxVelocity: d.maxVelocity(),
                        cost: d.cost(),
                        maxWeaponRange: d.maxWeaponRange(),
                        maxThisUnit: d.maxThisUnit(),
                        canBeAssisted: d.canBeAssisted(),
                        canSelfDestruct: d.canSelfDestruct(),
                        selfDCountdown: d.selfDCountdown(),
                        categoryBits: d.categoryBits(),
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
                    const damages: number[] = [];
                    for (let di = 0; di < d.damagesLength(); di++) {
                        damages.push(d.damages(di) ?? 0);
                    }
                    const wdCustomParams: Record<string, string> = {};
                    for (let ci = 0; ci < d.customParamsLength(); ci++) {
                        const cp = d.customParams(ci, new CustomParam());
                        if (!cp) continue;
                        const key = cp.key();
                        if (key) wdCustomParams[key] = cp.value() ?? '';
                    }
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
                        typeName: d.typeName() ?? '',
                        description: d.description() ?? '',
                        defaultDamage: d.defaultDamage(),
                        damages,
                        reloadTime: d.reloadTime(),
                        salvoSize: d.salvoSize(),
                        salvoDelay: d.salvoDelay(),
                        accuracy: d.accuracy(),
                        sprayAngle: d.sprayAngle(),
                        movingAccuracy: d.movingAccuracy(),
                        targetMoveError: d.targetMoveError(),
                        leadLimit: d.leadLimit(),
                        edgeEffectiveness: d.edgeEffectiveness(),
                        impulseFactor: d.impulseFactor(),
                        impulseBoost: d.impulseBoost(),
                        craterMult: d.craterMult(),
                        craterBoost: d.craterBoost(),
                        craterAoe: d.craterAoe(),
                        fireStarter: d.fireStarter(),
                        flightTime: d.flightTime(),
                        weaponAcceleration: d.weaponAcceleration(),
                        turnRate: d.turnRate(),
                        uptime: d.uptime(),
                        coverageRange: d.coverageRange(),
                        stockpileTime: d.stockpileTime(),
                        metalCost: d.metalCost(),
                        energyCost: d.energyCost(),
                        flags: d.flags(),
                        customParams: wdCustomParams,
                    });
                }
                console.log(`[connection] received ${defs.length} weapon def(s)`);
                this.events.onWeaponDefs?.(defs);
                break;
            }
            case ServerPayload.UnitCommandQueuesUpdate: {
                const fbUpd = msg.payload(new UnitCommandQueuesUpdate()) as UnitCommandQueuesUpdate;
                const queues: UnitCommandQueueInfo[] = [];
                for (let qi = 0; qi < fbUpd.queuesLength(); qi++) {
                    const q = fbUpd.queues(qi, new UnitCommandQueue());
                    if (!q) continue;
                    const orders: UnitOrderInfo[] = [];
                    for (let oi = 0; oi < q.ordersLength(); oi++) {
                        const o = q.orders(oi, new UnitOrder());
                        if (!o) continue;
                        const params: number[] = [];
                        for (let pi = 0; pi < o.paramsLength(); pi++) params.push(o.params(pi) ?? 0);
                        orders.push({
                            cmdId: o.cmdId(),
                            params,
                            options: o.options(),
                            tag: o.tag(),
                            timeout: o.timeout(),
                        });
                    }
                    queues.push({ unitId: q.unitId(), orders });
                }
                this.events.onUnitCommandQueues?.(queues);
                break;
            }
            case ServerPayload.UnitCmdDescsUpdate: {
                const fbUpd = msg.payload(new UnitCmdDescsUpdate()) as UnitCmdDescsUpdate;
                const units: UnitCmdDescsInfo[] = [];
                for (let ui = 0; ui < fbUpd.unitsLength(); ui++) {
                    const u = fbUpd.units(ui, new UnitCmdDescs());
                    if (!u) continue;
                    const cmds: UnitCmdDescInfo[] = [];
                    for (let ci = 0; ci < u.cmdsLength(); ci++) {
                        const c = u.cmds(ci, new UnitCmdDesc());
                        if (!c) continue;
                        cmds.push({ cmdId: c.cmdId(), disabled: !!c.disabled() });
                    }
                    units.push({ unitId: u.unitId(), cmds });
                }
                this.events.onUnitCmdDescs?.(units);
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
