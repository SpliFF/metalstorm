/**
 * Connection — manages HTTP auth + the WebTransport game stream.
 *
 * Auth flow:
 *   1. HTTP POST /api/auth/login → token
 *   2. GET /api/wt/info → { port, certHash } for the QUIC endpoint
 *   3. Open a WebTransport session (pinning certHash) via WebTransportAdapter
 *   4. AuthRequest over the control stream → game begins
 *
 * Transport classes (see transport.ts / PLAN-game-worker.md GW2):
 *   "control" — reliable, ordered bidi stream (FlatBuffer messages)
 *   "state"   — newest-wins uni streams (entity/piece state)
 *   "vision" / "bulk" — reliable uni streams at lower priority
 */

import * as flatbuffers from 'flatbuffers';
import { WebTransportAdapter, type GameTransport } from './transport.js';
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
import { ProjectileFiredEvent } from '../protocol/spring-web/projectile-fired-event.js';
import { ProjectileImpactEvent } from '../protocol/spring-web/projectile-impact-event.js';
import { ProjectileTrajectoryEvent } from '../protocol/spring-web/projectile-trajectory-event.js';
import { EntityDestroy } from '../protocol/spring-web/entity-destroy.js';
import { EntitySensorUpdate } from '../protocol/spring-web/entity-sensor-update.js';
import { SendToUnsyncedEvent } from '../protocol/spring-web/send-to-unsynced-event.js';
import { SendToUnsyncedArg } from '../protocol/spring-web/send-to-unsynced-arg.js';
import { SendToUnsyncedArgKind } from '../protocol/spring-web/send-to-unsynced-arg-kind.js';
import { GameInfo } from '../protocol/spring-web/game-info.js';
import { TeamStartInfo } from '../protocol/spring-web/team-start-info.js';
import { PlayerTeamEventBatch } from '../protocol/spring-web/player-team-event-batch.js';
import { TeamStatsHistoryBatch } from '../protocol/spring-web/team-stats-history-batch.js';
import { GameModOptions } from '../protocol/spring-web/game-mod-options.js';
import { ResourceUpdate } from '../protocol/spring-web/resource-update.js';
import { MapData } from '../protocol/spring-web/map-data.js';
import { PlayerLeft } from '../protocol/spring-web/player-left.js';
import { SoundEvent } from '../protocol/spring-web/sound-event.js';
import { SeismicPing } from '../protocol/spring-web/seismic-ping.js';
import { MusicEvent } from '../protocol/spring-web/music-event.js';
import { FeatureLifecycleBatch } from '../protocol/spring-web/feature-lifecycle-batch.js';
import { FeatureSpawn as FeatureSpawnFb } from '../protocol/spring-web/feature-spawn.js';
import { UnitCommandQueuesUpdate } from '../protocol/spring-web/unit-command-queues-update.js';
import { UnitCmdDescsUpdate } from '../protocol/spring-web/unit-cmd-descs-update.js';
import { UnitCmdDescs } from '../protocol/spring-web/unit-cmd-descs.js';
import { UnitCmdDesc } from '../protocol/spring-web/unit-cmd-desc.js';
import { UnitCommandQueue } from '../protocol/spring-web/unit-command-queue.js';
import { UnitOrder } from '../protocol/spring-web/unit-order.js';
import { UnitTransportUpdate } from '../protocol/spring-web/unit-transport-update.js';
import { UnitTransportInfo } from '../protocol/spring-web/unit-transport-info.js';
import { UnitSelfDUpdate } from '../protocol/spring-web/unit-self-dupdate.js';
import { UnitSelfDInfo } from '../protocol/spring-web/unit-self-dinfo.js';
import { UnitStockpileUpdate } from '../protocol/spring-web/unit-stockpile-update.js';
import { UnitStockpileInfo } from '../protocol/spring-web/unit-stockpile-info.js';
import { UnitArmoredUpdate } from '../protocol/spring-web/unit-armored-update.js';
import { UnitArmoredInfo } from '../protocol/spring-web/unit-armored-info.js';
import { UnitLifecycleBatch } from '../protocol/spring-web/unit-lifecycle-batch.js';
import { UnitLifecycleEvent } from '../protocol/spring-web/unit-lifecycle-event.js';
import { UnitLifecycleKind } from '../protocol/spring-web/unit-lifecycle-kind.js';
import { UnitCommandBatch } from '../protocol/spring-web/unit-command-batch.js';
import { UnitCommandEvent } from '../protocol/spring-web/unit-command-event.js';
import { UnitCommandKind } from '../protocol/spring-web/unit-command-kind.js';
import { AuthRequest } from '../protocol/spring-web/auth-request.js';
import { Handshake } from '../protocol/spring-web/handshake.js';
import { PlayerCommand } from '../protocol/spring-web/player-command.js';
import { PlayerCommandBatch } from '../protocol/spring-web/player-command-batch.js';
import { LuaRulesMsg } from '../protocol/spring-web/lua-rules-msg.js';
import { LuaUIMsg } from '../protocol/spring-web/lua-uimsg.js';
import { LuaUIMsgRelay } from '../protocol/spring-web/lua-uimsg-relay.js';
import { ConsoleCommand } from '../protocol/spring-web/console-command.js';
import { SelectionState } from '../protocol/spring-web/selection-state.js';
import { PathRequest } from '../protocol/spring-web/path-request.js';
import { PathRequestCancel } from '../protocol/spring-web/path-request-cancel.js';
import { PlayerLeaveIntent } from '../protocol/spring-web/player-leave-intent.js';
import { PathResponse } from '../protocol/spring-web/path-response.js';
import { StandingOrderState } from '../protocol/spring-web/standing-order-state.js';
import { StandingOrderType } from '../protocol/spring-web/standing-order-type.js';
import { OrgGroupState } from '../protocol/spring-web/org-group-state.js';
import { OrgGroupInfo } from '../protocol/spring-web/org-group-info.js';
import { OrgGroupCreate } from '../protocol/spring-web/org-group-create.js';
import { OrgGroupUpdate } from '../protocol/spring-web/org-group-update.js';
import { OrgGroupDisband } from '../protocol/spring-web/org-group-disband.js';
import { Echelon } from '../protocol/spring-web/echelon.js';
import { DirectiveState } from '../protocol/spring-web/directive-state.js';
import { DirectiveInfo } from '../protocol/spring-web/directive-info.js';
import { DirectiveType } from '../protocol/spring-web/directive-type.js';
import { OrderShape } from '../protocol/spring-web/order-shape.js';
import { GroupDirective } from '../protocol/spring-web/group-directive.js';
import { GroupDirectiveRemove } from '../protocol/spring-web/group-directive-remove.js';
import { GroupPosture } from '../protocol/spring-web/group-posture.js';
import { Vec3 } from '../protocol/spring-web/vec3.js';
import { AuthResponse } from '../protocol/spring-web/auth-response.js';
import { AuthStatus } from '../protocol/spring-web/auth-status.js';
import { ServerClock } from './clock.js';
import { parseEntityState, type EntityStateSnapshot } from './entity-state.js';
import { parseProjectileState, type ProjectileStateSnapshot } from './projectile-state.js';
import { parsePieceState, type PieceStateSnapshot } from './piece-state.js';
import { parseBuildActivity, type BuildActivitySnapshot } from './build-activity.js';
import { parseMapData, type ParsedMapData } from './map-data.js';
import { parseLosBitmap, type LosBitmap } from './los-bitmap.js';
import { parseDecals, type DecalSnapshot } from './decal-events.js';
import { parseHeightmapPatch, type HeightmapPatch } from './heightmap-events.js';
import { recordInbound, recordOutbound } from './net-inspector.js';

const ENVELOPE_FLATBUFFERS = 0x01;
const ENVELOPE_ENTITY_STATE_FULL = 0x02;
const ENVELOPE_ENTITY_STATE_DELTA = 0x03;
const ENVELOPE_PROJECTILE_STATE = 0x04;
const ENVELOPE_PIECE_STATE = 0x05;
const ENVELOPE_BUILD_ACTIVITY = 0x06;
const ENVELOPE_LOS_BITMAP = 0x07;
const ENVELOPE_DECALS = 0x08;
const ENVELOPE_HEIGHTMAP = 0x09;

/** Wire-protocol version sent in the Handshake (C1). The game server rejects a
 *  mismatch with AuthStatus.VersionMismatch — bump this in lockstep with
 *  Protocol::CURRENT_PROTOCOL_VERSION (rts/Server/Protocol.h) on any breaking
 *  schema / envelope change. */
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

/// Per-tick sound emission decoded from a `GameEventBatch.sounds` entry.
/// The renderer's audio layer resolves `(sourceKind, sourceDefId, soundId)`
/// against `DefCache` to get a SoundRef, decodes the buffer once, then
/// plays through the 96-voice pool with HRTF panning at `(x,y,z)`.
export interface SoundEventInfo {
    soundId: number;
    sourceDefId: number;
    /// 0 = Unit, 1 = Weapon, 2 = Feature, 3 = Global. Matches
    /// SoundSourceKind in protocol.fbs.
    sourceKind: number;
    x: number;
    y: number;
    z: number;
    volume: number;
    pitch: number;
    priority: number;
    /// Owner team. 255 = no team / global.
    team: number;
    /// Mix channel: 0=General, 1=Battle, 2=UnitReply, 3=UserInterface,
    /// 4=BGMusic. Matches the SoundChannel enum in protocol.fbs.
    channel: number;
}

/// Per-tick seismic ping decoded from a `GameEventBatch.seismic_pings`
/// entry. The position is already deceived by the server's radar-error
/// vector — clients never see the source unit's true position. ZK's
/// minimap_events / unit_attack_warning widgets fire on these to flash
/// a blip and play the warning siren.
export interface SeismicPingInfo {
    x: number;
    y: number;
    z: number;
    strength: number;
    /// Listener ally team. Server filters per-session so this always
    /// matches the local viewer's ally team (or any team for spectators).
    allyTeam: number;
}

/// One team's start position (RH-canonical elmos). Feeds the LuaUI worker's
/// Spring.GetTeamStartPosition. See protocol.fbs TeamStartPos.
export interface TeamStartPositionInfo {
    team: number;
    allyTeam: number;
    x: number;
    y: number;
    z: number;
    valid: boolean;
}

/// One ally team's start box in elmos. Feeds Spring.GetAllyTeamStartBox.
/// Defaults to the full map when the game sets no boxes. See protocol.fbs
/// AllyStartBox.
export interface AllyStartBoxInfo {
    allyTeam: number;
    xmin: number;
    zmin: number;
    xmax: number;
    zmax: number;
}

/// Team start positions + ally start boxes — decoded from TeamStartInfo,
/// sent on auth and re-broadcast after GameStart.
export interface TeamStartInfoData {
    teams: TeamStartPositionInfo[];
    boxes: AllyStartBoxInfo[];
}

/// One decoded player/team status change. `kind`: 0=PlayerChanged,
/// 1=PlayerAdded, 2=PlayerRemoved, 3=TeamDied. `id` is a playerID (kinds 0-2)
/// or teamID (kind 3); `reason` carries the PlayerRemoved reason (0 otherwise).
export interface PlayerTeamEventInfo {
    kind: number;
    id: number;
    reason: number;
}

/// One team-statistics history entry (mirrors Recoil's TeamStatistics). Keys
/// match the table Spring.GetTeamStatsHistory returns; `frame` is the entry's
/// finalisation frame (future for the live tail — the worker overrides it).
export interface TeamStatsEntryInfo {
    frame: number;
    metalUsed: number; energyUsed: number;
    metalProduced: number; energyProduced: number;
    metalExcess: number; energyExcess: number;
    metalReceived: number; energyReceived: number;
    metalSent: number; energySent: number;
    damageDealt: number; damageReceived: number;
    unitsProduced: number; unitsDied: number;
    unitsReceived: number; unitsSent: number;
    unitsCaptured: number; unitsOutCaptured: number; unitsKilled: number;
}

/// One team's incremental stats-history delta. The worker overwrites its
/// per-team history array starting at `baseIndex`.
export interface TeamStatsHistoryInfo {
    teamId: number;
    baseIndex: number;
    entries: TeamStatsEntryInfo[];
}

/// Projectile lifecycle event info — decoded from the FlatBuffer batch and
/// passed to ProjectileRenderer. Velocity values come straight from the
/// server in elmos / sim-frame; the renderer converts to elmos / second
/// for its render-tick integration.
export interface ProjectileFiredInfo {
    projId: number;
    weaponDefId: number;
    ownerId: number;
    team: number;
    pos: { x: number; y: number; z: number };
    vel: { x: number; y: number; z: number };
    targetPos: { x: number; y: number; z: number };
    targetId: number;
    ttl: number;
    gravity: number;
    hitscan: boolean;
}

export interface ProjectileImpactInfo {
    projId: number;
    pos: { x: number; y: number; z: number };
    impactKind: number;
    targetId: number;
    /// Weapon def id for the explosion. Populated for both projectile
    /// impacts (matches the projId's weapon) and free-floating death /
    /// self-destruct explosions. 0 means "not set — look up via projId."
    weaponDefId: number;
}

export interface ProjectileTrajectoryInfo {
    projId: number;
    pos: { x: number; y: number; z: number };
    vel: { x: number; y: number; z: number };
    reason: number;
}

/// One sound asset attached to a unit or weapon def. The `id` field
/// is what a SoundEvent's `sound_id` selects.
export interface SoundRefInfo {
    id: number;
    path: string;
    /// SoundCategory enum value — see protocol.fbs.
    category: number;
    /// Default gain (0–4). Multiplied with SoundEvent.volume.
    volume: number;
    /// Default playback rate. Multiplied with SoundEvent.pitch.
    pitch: number;
    /// Unresolved logical name (e.g. `"weapon/laser1"`, `"bot_select"`).
    /// Used to look up SoundItem metadata in gamedata/sounds.lua —
    /// per-item gain / pitch / priority / maxconcurrent etc. defaults
    /// the server doesn't know about. Empty string when no logical
    /// name is available.
    name: string;
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
    /** MoveDef::pathType. UINT32_MAX (4294967295) when the unit has no
     *  movedef (air, immobile buildings). ZK widgets resolve this via
     *  `UnitDefs[id].moveDef.id` to route `Spring.RequestPath` through
     *  the correct mobility class. */
    moveDefPathType: number;
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
    /// Vehicle tread-track type name (lowercased), e.g. "stdtank". Empty for
    /// units that don't leave tracks. Used to resolve the wire trackTypeId
    /// (envelope 0x08) to a track texture — see decal-renderer.ts.
    trackType: string;
    /// Building ground-decal (PLAN-decals.md D5): authored AO/scorch plate
    /// texture stem (lowercased, no extension), resolved to `<stem>.ktx2`
    /// under the game's `unittextures/`. Empty when the building authors none.
    groundDecal: string;
    /// Building ground-decal size in map squares. World half-extent is
    /// `groundDecalSize * SQUARE_SIZE` (Recoil), so the full quad is
    /// `2 * size * SQUARE_SIZE` elmos. 0 when there's no decal.
    groundDecalSizeX: number;
    groundDecalSizeY: number;
    maxVelocity: number;
    cost: number;
    maxWeaponRange: number;
    maxThisUnit: number;
    canBeAssisted: boolean;
    canSelfDestruct: boolean;
    selfDCountdown: number;
    categoryBits: number;
    /// Per-unit sounds (select/order_ack/build/working/...). Empty when
    /// the unit's def has no sound assets.
    sounds: SoundRefInfo[];
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
    name: string;
    action: string;
    texture: string;
    tooltip: string;
    type: number;
    params: string[];
    hidden: boolean;
}

export interface UnitCmdDescsInfo {
    unitId: number;
    cmds: UnitCmdDescInfo[];
}

/** One transport relationship — a transporter and its current cargo. */
export interface UnitTransportInfoMsg {
    transporterId: number;
    cargo: number[];
}

/** One unit's self-destruct countdown state. */
export interface UnitSelfDInfoMsg {
    unitId: number;
    /** Game-seconds remaining; matches Spring's `selfDCountdown`. */
    secondsRemaining: number;
}

/** One unit's stockpile-weapon state. */
export interface UnitStockpileInfoMsg {
    unitId: number;
    ready: number;
    queued: number;
    /** 0.0..1.0 build progress on the in-flight missile. */
    buildPercent: number;
}

/** One unit's armored toggle state. */
export interface UnitArmoredInfoMsg {
    unitId: number;
    armored: boolean;
    armoredMultiple: number;
}

/** Discriminator on UnitLifecycleEventMsg.kind — matches the FlatBuffers enum. */
export type UnitLifecycleKindStr = 'fromFactory' | 'taken' | 'given' | 'created';

/** Decoded conditions from a `StandingOrderInfo`. Mirrors the
 *  FlatBuffers table, with empty arrays and zero-radius filters
 *  treated as absent (they're not gating the assignment). */
export interface StandingOrderConditionsInfo {
    idleOnly: boolean;
    squadTypes: number[];
    withinCenter: readonly [number, number, number];
    withinRadius: number;
    outsideCenter: readonly [number, number, number];
    outsideRadius: number;
    minStrength: number;
    hasCapabilities: string[];
}

/** One standing-order entry as broadcast in `StandingOrderState`.
 *  Same data shape the worker's `Spring.GetStandingOrders` returns. */
export interface StandingOrderInfoMsg {
    orderId: number;
    ownerTeam: number;
    /** String name of the StandingOrderType enum value (e.g. "DefendArea"). */
    type: string;
    priority: number;
    params: number[];
    conditions: StandingOrderConditionsInfo;
    assignedSquadCount: number;
    active: boolean;
    createdAtFrame: number;
    /** Absolute sim frame the order auto-removes at. 0 = no expiry. */
    expiresAtFrame: number;
}

/** One org group (PLAN-macro-orders v0: `echelon` is always `'Platoon'` in
 *  practice — `'Army'` is schema-reserved but rejected server-side). Same
 *  data shape `Spring.GetOrgGroups` returns. */
export interface OrgGroupInfoMsg {
    groupId: number;
    echelon: 'Squad' | 'Platoon' | 'Army';
    ownerTeam: number;
    parentId: number;
    name: string;
    memberIds: number[];
    currentDirectiveId: number;
    postureJson: string;
    createdAtFrame: number;
}

/** One macro directive (PLAN-macro-directives §1). `fulfillment =
 *  assignedStrength / requestedStrength` — callers should guard
 *  `requestedStrength === 0` (demand model: 0 = "take what idles",
 *  fulfillment is meaningless). */
export interface DirectiveInfoMsg {
    directiveId: number;
    ownerTeam: number;
    groupId: number;
    type: string;
    priority: number;
    shape: 'Point' | 'Circle' | 'Polygon' | 'Polyline';
    params: number[];
    requestedStrength: number;
    assignedStrength: number;
    assignedSquadCount: number;
    active: boolean;
    createdAtFrame: number;
    expiresAtFrame: number;
}

/** Decoded server reply to a `Spring.PathRequest`. `waypoints` is the
 *  full path as `[x, y, z]` triples in elmo coordinates; empty array
 *  means the path manager couldn't find a route. */
export interface PathResponseInfo {
    requestId: number;
    waypoints: ReadonlyArray<readonly [number, number, number]>;
    length: number;
}

/** One unit lifecycle event. `fromFactory` carries `factoryId` /
 *  `factoryDefId` / `userOrders`; `taken` / `given` carry `oldTeam` /
 *  `newTeam`; `created` carries `builderId` (0 = no builder). The
 *  unused fields for each kind are present but zeroed. */
export interface UnitLifecycleEventMsg {
    kind: UnitLifecycleKindStr;
    unitId: number;
    unitDefId: number;
    unitTeam: number;
    /** FromFactory only. */
    factoryId: number;
    factoryDefId: number;
    userOrders: boolean;
    /** Taken/Given only. */
    oldTeam: number;
    newTeam: number;
    /** Created only. 0 = no builder. */
    builderId: number;
}

/** Discriminator on UnitCommandEventMsg.kind — matches the FlatBuffers
 *  enum. `issued` fires after a command lands on a unit's queue;
 *  `done` fires when the queued command completes or is cleared. */
export type UnitCommandKindStr = 'issued' | 'done';

/** One synced command event mirrored from the server. Shape matches
 *  the LuaUI `widgetHandler:UnitCommand` / `UnitCmdDone` callin
 *  argument lists so the worker can forward directly. */
export interface UnitCommandEventMsg {
    kind: UnitCommandKindStr;
    unitId: number;
    unitDefId: number;
    unitTeam: number;
    cmdId: number;
    params: number[];
    options: number;
    tag: number;
    /** Spring `playerNum`. `-1` for system / Lua / AI sources. */
    playerId: number;
    fromSynced: boolean;
    fromLua: boolean;
}

export interface WeaponDefInfo {
    defId: number;
    name: string;
    projectileType: number;
    projectileSpeed: number;
    range: number;
    aoe: number;
    size: number;
    intensity: number;
    colorR: number;
    colorG: number;
    colorB: number;
    /** Inner-core colour for LaserCannon / BeamLaser bolts. Recoil
     *  draws the bolt twice — outer at `color` × `thickness`, inner at
     *  `color2` × `thickness * coreThickness`. */
    color2R: number;
    color2G: number;
    color2B: number;
    /** Outer half-width of laser bolts / beams, in elmos. */
    thickness: number;
    /** Inner-core width as a fraction of `thickness` (0..1). */
    coreThickness: number;
    /** BeamLaser muzzle-flare size multiplier: flare edge =
     *  `thickness * laserFlareSize` (`visuals.laserflaresize`). */
    laserFlareSize: number;
    /** BeamLaser per-Update colour decay (`visuals.beamdecay`); the beam
     *  dims by this factor each sim tick over its TTL. */
    beamDecay: number;
    /** BeamLaser / LightningCannon visual-sprite linger time in sim
     *  frames (Recoil's `beamLaserTTL`, Lua field `beamTTL`). ZK's
     *  gfx_projectile_lights.lua reads it to fade beam lights. 0 = no
     *  linger. */
    beamTtl: number;
    /** LaserCannon: stop and contract at max-range instead of fading. */
    laserHardStop: boolean;
    /** Per-frame intensity falloff multiplier (non-hardstop lasers). */
    falloffRate: number;
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
    /** Lobby URL of the projectile's `.glb`, or empty when the def
     *  doesn't reference a model — the renderer uses procedural shapes
     *  in that case. */
    modelUrl: string;
    /** texture1 basename (Spring's `texNames[0]`), empty when unset. */
    texture1: string;
    /** texture2 basename (Spring's `texNames[1]`) — beam end-cap /
     *  smoketrail. Empty when unset. */
    texture2: string;
    /** texture3 basename (Spring's `texNames[2]`) — flare / muzzle
     *  exhaust. Empty when unset. */
    texture3: string;
    /** elmos/sec at which the tiled middle beam texture shifts along
     *  the beam axis. Renderer treats non-largeBeamLaser weapons as 0
     *  per Recoil semantics. Defaults to Spring's 5.0. */
    scrollSpeed: number;
    /** CEG tag emitted every frame in flight (Spring's `cegTag`).
     *  Empty when not set. Looked up against the streamed CEG table. */
    cegTag: string;
    /** CEG tag emitted on impact (Spring's `explosionGenerator`).
     *  Bare tag — server strips any `custom:` prefix. */
    explosionGenerator: string;
    /** CEG tag emitted on bounce (Spring's `bounceExplosionGenerator`). */
    bounceExplosionGenerator: string;
    /// Per-weapon sounds — typically `[fire, hitDry, hitWet]`. The
    /// SoundEvent for this weapon's fire is sound_id 0; the hitDry/
    /// hitWet emissions follow contiguously when defined.
    sounds: SoundRefInfo[];
}

/// One key/value pair inside a CEG spawn's `properties` block.
/// Both values arrive as raw Lua-source strings (numbers stringified,
/// list-vector tables comma-joined). The CegRuntime parses them
/// per-spawn-class.
export interface CegPropertyInfo {
    key: string;
    value: string;
}

/// One sub-emitter of a CEG. `flags` packs the visibility-context
/// booleans (ground/air/water/unit/underwater) — see GameCegSpawn in
/// protocol.fbs. `flags === 0` means "always emit".
export interface CegSpawnInfo {
    spawnName: string;
    className: string;
    count: number;
    flags: number;
    properties: CegPropertyInfo[];
}

/// `CStandardGroundFlash` parameters. Authored as a top-level
/// `groundflash = {…}` subtable on the CEG def (not a spawn entry).
/// Recoil renders this on every CEG fire alongside the regular
/// spawns; we treat it as a separate channel in CegRuntime.
export interface GroundFlashInfo {
    ttl: number;
    circleAlpha: number;
    flashSize: number;
    flashAlpha: number;
    circleGrowth: number;
    colorR: number;
    colorG: number;
    colorB: number;
    flags: number;
}

/// One feature spawned this tick. Resolves to a renderable model via
/// `FeatureDefInfo[defId]`. Heading is Spring's 16-bit fixed-point yaw
/// (16384 = 90°). team=-1 means gaia/neutral (most wrecks). The
/// feature_id is the server's `CFeature::id` — stable for the feature's
/// lifetime, recycled after destroy.
export interface FeatureSpawnInfo {
    featureId: number;
    defId: number;
    x: number;
    y: number;
    z: number;
    heading: number;
    buildFacing: number;
    team: number;
    allyTeam: number;
}

/// One streamed feature def — wrecks, debris, trees, geothermals. Sent
/// once at game start via the baked `featuredefs.bin` cache. Lookup by
/// `defId`. `modelUrl` may be empty when the def has no model (a Spring
/// "tree" entry with drawType > 0, or a decal-only feature) — the
/// renderer falls back to a placeholder cube.
export interface FeatureDefInfo {
    defId: number;
    name: string;
    modelUrl: string;
    textureUrl: string;
    /// Spring's FeatureDef.drawType: 0=model, >=1=tree variants, -1=none.
    drawType: number;
    footprintX: number;
    footprintZ: number;
    height: number;
    radius: number;
    mass: number;
    health: number;
    blocking: boolean;
    reclaimable: boolean;
    destructable: boolean;
    burnable: boolean;
    floating: boolean;
    geoThermal: boolean;
    metal: number;
    energy: number;
    /// Chained death feature (wreck → heap → ash); 0 when the chain ends.
    deathFeatureDefId: number;
    smokeTime: number;
    reclaimTime: number;
    scriptName: string;
    customParams: Record<string, string>;
}

/// One streamed CEG def. `tag` is the lookup key on weapon defs
/// (`cegTag`, `explosionGenerator`, `bounceExplosionGenerator`).
/// All names are lowercased on the server before serialisation so
/// matching is case-stable.
export interface CegDefInfo {
    tag: string;
    spawns: CegSpawnInfo[];
    useDefaultExplosions: boolean;
    /// Optional `CStandardGroundFlash` subtable — present when the
    /// CEG authored `groundflash = { ttl = N, … }`. Absent (null)
    /// for the majority of CEGs that have no ground flash.
    groundFlash: GroundFlashInfo | null;
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

/** One decoded `Spring.SendToUnsynced(...)` argument forwarded from the
 *  server. The server validated types to nil/bool/number/string before
 *  putting the value on the wire, so consumers don't need to defend
 *  against other JS types. `kind` mirrors `SendToUnsyncedArgKind` from
 *  the FlatBuffers schema. */
export type SendToUnsyncedArgInfo =
    | { kind: 'nil' }
    | { kind: 'bool'; value: boolean }
    | { kind: 'number'; value: number }
    | { kind: 'string'; value: string };

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
    onSoundEvents?: (events: SoundEventInfo[], frame: number) => void;
    onSeismicPings?: (events: SeismicPingInfo[], frame: number) => void;
    /** Music-state transition broadcast — fires once per state change.
     *  The client looks up a track from its per-state playlist (built
     *  from gamedata/sounds.lua music_* entries by the worker) and
     *  hands it to AudioManager.playMusic for crossfade. */
    onMusicEvent?: (state: number, fadeMs: number, frame: number) => void;
    onProjectileFired?: (events: ProjectileFiredInfo[], frame: number) => void;
    onProjectileImpacts?: (events: ProjectileImpactInfo[], frame: number) => void;
    onProjectileTrajectories?: (events: ProjectileTrajectoryInfo[], frame: number) => void;
    /** `frame` is the client's best lower bound on the death's sim frame:
     *  max(last GameEventBatch frame, newest entity-state base_frame). When a
     *  same-tick combat batch preceded the destroy (kill visible to this
     *  viewer) that batch's frame wins and the death lands on the same
     *  presentation frame as its explosion; otherwise (Lua DestroyUnit /
     *  self-d, or the kill event LOS-filtered away — the server sends no
     *  batch on event-less ticks and filters batches per viewer) the newest
     *  observed state frame keeps the stamp fresh so the mesh isn't removed
     *  up to ~D early. Proper L2 fix: a real frame field on the EntityDestroy
     *  wire message. */
    onEntityDestroy?: (entityId: number, x: number, y: number, z: number, frame: number) => void;
    /** Per-unit sensor radius override. Emitted by
     *  Spring.SetUnitSensorRadius on the server. `sensorType` matches
     *  the SpringWeb::SensorType enum (0=los, 1=airLos, 2=radar,
     *  3=sonar, 4=seismic, 5=radarJammer, 6=sonarJammer). `radius`
     *  is in elmos; 0 means the sensor was disabled. */
    onEntitySensorUpdate?: (entityId: number, sensorType: number, radius: number) => void;
    /** Forwarded `Spring.SendToUnsynced(...)` from a synced LuaRules
     *  gadget. The first arg is conventionally the topic string the
     *  unsynced-side gadget registered via `gadgetHandler:AddSyncAction`;
     *  consumers (the widget worker) peel it off and dispatch. The
     *  server validated arg types so the variant covers
     *  nil/bool/number/string only. */
    onSendToUnsynced?: (args: SendToUnsyncedArgInfo[]) => void;
    /** Fired on the server's game-over broadcast. `winningAllyTeams` is the
     *  winners list from `Spring.GameOver(...)` (empty = undecided). */
    onGameOver?: (frame: number, winningAllyTeams: number[]) => void;
    onPlayerLeft?: (playerId: number, username: string, team: number, reason: number) => void;
    onMapData?: (map: ParsedMapData) => void;
    /** Per-tick batch of feature lifecycle events. `spawns` is a list of
     *  new features (wrecks, debris, gadget-spawned); `removed` is feature
     *  IDs that despawned (reclaimed, destroyed). Both lists are typically
     *  empty on quiet ticks. */
    onFeatureLifecycle?: (spawns: FeatureSpawnInfo[], removed: number[]) => void;
    onUnitCommandQueues?: (queues: UnitCommandQueueInfo[]) => void;
    onUnitCmdDescs?: (units: UnitCmdDescsInfo[]) => void;
    onUnitTransports?: (transports: UnitTransportInfoMsg[]) => void;
    onUnitSelfD?: (units: UnitSelfDInfoMsg[]) => void;
    onUnitStockpile?: (units: UnitStockpileInfoMsg[]) => void;
    onUnitArmored?: (units: UnitArmoredInfoMsg[]) => void;
    onUnitLifecycle?: (events: UnitLifecycleEventMsg[]) => void;
    /** Synced `UnitCommand` / `UnitCmdDone` events filtered to allied
     *  teams. Forwarded to the widget worker so ZK widgets that
     *  register the matching callins (`unit_state_icons`,
     *  `cmd_stop_selfd`, `cmd_keep_target`, etc.) see commands as
     *  they're issued and completed. */
    onUnitCommand?: (events: UnitCommandEventMsg[]) => void;
    /** Async `Spring.PathRequest` reply from the server. `waypoints` is
     *  the full path from `start` to a point within `goal_radius` of
     *  `end`; empty if no path was found. `length` is the total path
     *  length in elmos. Fires exactly once per request_id. */
    onPathResponse?: (info: PathResponseInfo) => void;
    /** Snapshot of all standing orders visible to this client (own
     *  team + allied teams). Server pushes on any state change — never
     *  per-tick — so widget code can treat the most-recent payload as
     *  authoritative. Reading `Spring.GetStandingOrders` walks the
     *  same data. */
    onStandingOrders?: (orders: StandingOrderInfoMsg[]) => void;
    /** Snapshot of all org groups visible to this client (own team only —
     *  org groups, unlike standing orders, aren't shared with allies).
     *  Pushed on any create/update/disband, never per-tick. PLAN-macro-ui.md
     *  org panel + `Spring.GetOrgGroups` read the same data. */
    onOrgGroupState?: (groups: OrgGroupInfoMsg[]) => void;
    /** Snapshot of all macro directives visible to this client (own team +
     *  allies, same visibility rule as standing orders). Pushed on any
     *  create/update/remove/fulfillment change, never per-tick. */
    onDirectiveState?: (directives: DirectiveInfoMsg[]) => void;
    onProjectileState?: (snapshot: ProjectileStateSnapshot) => void;
    onPieceState?: (snapshot: PieceStateSnapshot) => void;
    onBuildActivity?: (snapshot: BuildActivitySnapshot) => void;
    /** Per-allyteam fog-of-war snapshot. Arrives ~1 Hz; one envelope
     *  per ally team. Each player session normally receives only their
     *  own ally team; spectators get round-robin coverage of all
     *  teams. Consumed by `LosBitmapStore`, the minimap fog overlay,
     *  and `Spring.IsPosInLos / IsPosInRadar / IsPosInAirLos`. */
    onLosBitmap?: (bitmap: LosBitmap) => void;
    /** Per-tick ground-decal batch (envelope 0x08): scorch scars from
     *  weapon explosions + vehicle track segments. Write-once events;
     *  consumed by `DecalRenderer`. */
    onDecals?: (snapshot: DecalSnapshot) => void;
    onHeightmapPatch?: (patch: HeightmapPatch) => void;
    onResourceUpdate?: (info: ResourceUpdateInfo) => void;
    onGameInfo?: (frame: number, speed: number, paused: boolean,
                  wind?: { x: number; y: number; z: number; strength: number; tidal: number },
                  legacyCoordSystem?: boolean,
                  /// The engine's global unit-ID ceiling (unitHandler.MaxUnits()).
                  /// Immutable; the worker's `Game.maxUnits` ID-space boundary.
                  /// 0 until the first GameInfo arrives. See PLAN-bar.md.
                  maxUnits?: number) => void;
    /// Team start positions + ally start boxes (TeamStartInfo). Sent on auth
    /// and re-broadcast after GameStart with the final post-spawn values.
    onTeamStartInfo?: (data: TeamStartInfoData) => void;
    /// Player/team status changes (PlayerTeamEventBatch) — drives
    /// widget:PlayerChanged / PlayerAdded / PlayerRemoved / TeamDied.
    onPlayerTeamEvents?: (events: PlayerTeamEventInfo[]) => void;
    /// Per-second team stats-history deltas (TeamStatsHistoryBatch) — feeds
    /// the worker's per-team history for Spring.GetTeamStatsHistory.
    onTeamStatsHistory?: (teams: TeamStatsHistoryInfo[]) => void;

    /// The game's modoptions (GameModOptions). Sent reliably, once, on auth.
    /// Feeds the worker's liveState.modOptions so Spring.GetModOptions()
    /// matches the synced set. Values arrive as strings (engine convention).
    onGameModOptions?: (options: Record<string, string>) => void;
    /// A relayed `Spring.SendLuaUIMsg` (LuaUIMsgRelay). The server already
    /// applied the audience filter; deliver unconditionally to
    /// `widget:RecvLuaMsg(data, playerId)`. `data` preserves embedded NULs.
    onLuaUIMsg?: (data: Uint8Array, playerId: number) => void;
    onServerMessage?: (msg: ServerMessage) => void;
    /// Server signalled a restart (ServerPayload.GameRestarting). The host
    /// decides how to react — on the main thread this reloads the page; from
    /// the game-processor worker (GW4) `window` is unreachable, so the worker
    /// posts a `gp:reload` to main. Keeping this a callback makes Connection
    /// host-agnostic (no DOM reference), which is what lets it run in the
    /// worker (PLAN-game-worker.md GW4-c2).
    onServerRestart?: () => void;
}

export class Connection {
    // Transport — WebTransport (QUIC/HTTP-3) only (PLAN-game-worker.md Stage 0).
    private transport: GameTransport | null = null;

    private _state: ConnectionState = 'disconnected';
    private events: ConnectionEvents;
    private sessionToken: string | null = null;
    public playerId: number = 0;
    public myTeam: number = -1;
    private clock = new ServerClock();
    /** Sim frame of the most recent GameEventBatch. When a combat batch for
     *  the same tick precedes an EntityDestroy (same reliable, in-order lane,
     *  StateStreamer::Tick) this is the death's own frame, letting L1 present
     *  the death with its explosion. NOT guaranteed per destroy — see
     *  handleEntityDestroy. */
    private lastEventFrame = 0;
    /** Newest entity-state base_frame delivered (post-netsim) — the same
     *  leading edge PresentationClock.newestObservedFrame tracks, kept here so
     *  the destroy stamp needs no reach into the worker's clock. */
    private newestStateFrame = 0;
    private pingInterval: ReturnType<typeof setInterval> | null = null;
    private httpBase = '';  // e.g. "http://localhost:9100"

    /** Public read-only accessor for the game server HTTP base URL.
     *  Used by TestHarness to POST `/api/exec` directly to the game
     *  server (the lobby's /api/exec only handles sql/lobby scopes;
     *  server / LuaRules / LuaGaia / LuaAI:* live on the game server). */
    get gameHttpUrl(): string { return this.httpBase; }
    private commandSequence = 0;

    /** Whether the control channel is currently usable. */
    get controlOpen(): boolean { return this.transport?.connected ?? false; }

    /** Send a pre-framed binary message on the reliable control channel.
     *  Used by the debug console (which builds its own ConsoleCommand frame). */
    sendControlRaw(data: Uint8Array): void { this.sendOnControl(data); }

    /** Observer for raw control-tier messages (envelope + payload), used by the
     *  debug console to resolve ConsoleResponse. WebTransport delivers a single
     *  onMessage for the whole session, so consumers that need the raw control
     *  bytes tap them here instead of reading the stream directly. */
    private controlObserver: ((data: Uint8Array) => void) | null = null;
    onControlMessage(fn: ((data: Uint8Array) => void) | null): void { this.controlObserver = fn; }

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
     * the /api/wt/info WebTransport discovery.
     */
    connect(url: string, username: string, password: string, token?: string): void {
        if (this.transport) this.disconnect();

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
    /// The lobby fires onGameStart as soon as it sets `room.gameServerPort`,
    /// which is *before* the forked spring-server has run `net.Start(port)`.
    /// That bind happens after main() opens the SQLite DB, parses CLI args,
    /// initialises HttpAuth, and constructs WebTransportServer — typically 1–3 s
    /// on a cold boot, longer on macOS under heavy lobby load. A cold ZK game
    /// server (defs bake + 200+ gadgets) has been observed taking 90 s+ before
    /// it answers, so budget 150 s at 500 ms per retry — the browser connect can
    /// fire while the room is still Loading (before the server is accepting), and
    /// this must outlast that warm-up. (The launch_game tool gates on the
    /// game_status ready flag instead, so automation doesn't rely on this.)
    private static readonly MAX_CONNECT_ATTEMPTS = 300;
    private static readonly CONNECT_RETRY_DELAY_MS = 500;
    /// Quiet threshold: don't log per-attempt failures until this many
    /// attempts have failed. Below this we expect transient
    /// ERR_CONNECTION_REFUSED during the spawn race and stay silent so the
    /// console doesn't read like a bug. Above this we surface a single
    /// "still trying" message so the user knows we're not stuck.
    private static readonly RETRY_QUIET_ATTEMPTS = 8;

    /// Distinguish "game server isn't up yet" (network-layer error, expected
    /// during spawn race) from "auth genuinely failed" (HTTP error response,
    /// needs immediate surfacing). Network errors throw a plain TypeError
    /// "Failed to fetch" in Chromium and a "Load failed" in Safari; either
    /// way we retry quietly. Auth errors come back via the httpAuth path's
    /// thrown Error with a status code in the message.
    private isTransientNetworkError(err: unknown): boolean {
        const msg = String(err);
        return msg.includes('Failed to fetch')
            || msg.includes('Load failed')
            || msg.includes('NetworkError')
            || msg.includes('ERR_CONNECTION_REFUSED')
            || msg.includes('connection failed')
            // WebTransport during the spawn race: HTTP is up but QUIC isn't
            // bound yet, or the session drops mid-boot — retry quietly.
            || msg.includes('Opening handshake failed')
            || msg.includes('WebTransport')
            || msg.includes('Connection lost');
    }

    private async tryConnect(): Promise<void> {
        this.connectAttempts++;
        this.setState('connecting');

        // Step 1: HTTP auth (token or password)
        try {
            await this.httpAuth(this.pendingUsername, this.pendingPassword);
        } catch (err) {
            const transient = this.isTransientNetworkError(err);
            // Real auth errors (bad password, expired session, banned)
            // come back as Error("Wrong password") etc. — surface those
            // immediately rather than retrying 120× with bad creds.
            if (!transient) {
                console.error(`[connection] auth failed: ${err}`);
                this.events.onAuthFailed?.(`${err}`);
                this.setState('disconnected');
                return;
            }
            if (this.connectAttempts < Connection.MAX_CONNECT_ATTEMPTS) {
                // Only log when retries have crossed the quiet threshold,
                // and even then only once per cycle of 8 to keep the
                // console readable during a slow boot.
                if (this.connectAttempts === Connection.RETRY_QUIET_ATTEMPTS
                    || (this.connectAttempts > Connection.RETRY_QUIET_ATTEMPTS
                        && this.connectAttempts % 8 === 0)) {
                    console.log(`[connection] still waiting for game server (attempt ${this.connectAttempts}): ${err}`);
                }
                setTimeout(() => this.tryConnect(), Connection.CONNECT_RETRY_DELAY_MS);
                return;
            }
            console.error(`[connection] giving up after ${this.connectAttempts} attempts`);
            this.events.onAuthFailed?.(`${err}`);
            this.setState('disconnected');
            return;
        }

        // Step 2: WebTransport (QUIC) session
        this.setState('handshake');
        try {
            await this.connectWebTransport();
        } catch (err) {
            // Network-level failures during boot are usually fixed by retrying
            // the whole tryConnect cycle (the next iteration re-fetches
            // /api/wt/info once the server has bound its QUIC socket).
            const transient = this.isTransientNetworkError(err);
            if (this.connectAttempts < Connection.MAX_CONNECT_ATTEMPTS && transient) {
                if (this.connectAttempts === Connection.RETRY_QUIET_ATTEMPTS
                    || (this.connectAttempts > Connection.RETRY_QUIET_ATTEMPTS
                        && this.connectAttempts % 8 === 0)) {
                    console.log(`[connection] still waiting for WebTransport (attempt ${this.connectAttempts}): ${err}`);
                }
                setTimeout(() => this.tryConnect(), Connection.CONNECT_RETRY_DELAY_MS);
                return;
            }
            console.error(`[connection] giving up after ${this.connectAttempts} attempts: ${err}`);
            this.events.onAuthFailed?.(`WebTransport connection failed: ${err}`);
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

    // ─── WebTransport (QUIC) ───

    private async connectWebTransport(): Promise<void> {
        // Discover the QUIC endpoint (+ cert pinning info in `hashes` mode)
        // over the trusted HTTP plane. See PLAN-security-hardening.md task 5.
        const infoResp = await fetch(`${this.httpBase}/api/wt/info`);
        if (!infoResp.ok) throw new Error(`wt/info failed: HTTP ${infoResp.status}`);
        const info = await infoResp.json();
        if (!info.port) throw new Error('wt/info missing port');

        // `webpki` mode (CA cert): no hashes to pin, the browser validates
        // normally. `hashes` mode (self-signed): pin via certHashes, falling
        // back to the singular certHash for servers built before this change.
        const certHashes: string[] | undefined =
            info.certMode === 'webpki' ? undefined
                : info.certHashes ?? (info.certHash ? [info.certHash] : undefined);
        if (info.certMode !== 'webpki' && !certHashes?.length) {
            throw new Error('wt/info missing certHashes for hashes cert mode');
        }

        // QUIC runs on the same host as the HTTP server, UDP on info.port.
        const host = new URL(this.httpBase).hostname;
        const wtUrl = `https://${host}:${info.port}/`;

        const adapter = new WebTransportAdapter({
            onMessage: (data) => this.routeIncoming(data),
            onClose: (code, reason) => {
                console.log(`[connection] WebTransport closed (${code}): ${reason}`);
            },
            onError: (e) => console.warn(`[connection] WebTransport error: ${e}`),
        });
        this.transport = adapter;
        await adapter.connect(wtUrl, { certHashes });

        // Connected — send auth over the control stream so the game server
        // creates a ClientSession. Don't fire onAuthenticated yet — wait for the
        // server's AuthResponse which carries the correct team assignment.
        console.log(`[connection] WebTransport connected to ${wtUrl}`);
        // C1: the server gates auth on a protocol-compatible Handshake. Send it
        // on the same ordered control stream, ahead of AuthRequest.
        this.sendHandshake();
        this.sendAuthRequest();

        this.pingInterval = setInterval(() => this.sendPing(), 30000);
        this.sendPing();
    }

    /** Route an inbound WebTransport message by envelope byte. Entity-state
     *  frames pass through the artificial-latency sim (netsim); everything else
     *  (FlatBuffers control, projectile/piece/decals/los/heightmap) dispatches
     *  directly. The transport delivers each whole message regardless of which
     *  QUIC stream/tier it arrived on. */
    private routeIncoming(data: Uint8Array): void {
        if (data.length < 1) return;
        // GW8: per-envelope bandwidth tally (PLAN-performance PC-2). The single
        // inbound dispatch — captures every stream/tier byte before netsim.
        recordInbound(data);
        const env = data[0];
        if (env === ENVELOPE_ENTITY_STATE_FULL || env === ENVELOPE_ENTITY_STATE_DELTA) {
            this.receiveStateFrame(data);
        } else {
            this.handleBinaryMessage(data);
            if (env === ENVELOPE_FLATBUFFERS) this.controlObserver?.(data);
        }
    }

    // ─── Send ───

    disconnect(): void {
        if (this.transport) { try { this.transport.disconnect(); } catch {} }
        this.transport = null;
        this.cleanup();
        this.setState('disconnected');
    }

    private sendHandshake(): void {
        const builder = new flatbuffers.Builder(64);
        const clientVerOff = builder.createString(`springweb/${PROTOCOL_VERSION}`);
        const hs = Handshake.createHandshake(builder, PROTOCOL_VERSION, clientVerOff);
        this.sendClientMessage(builder, ClientPayload.Handshake, hs);
        console.log(`[connection] sent Handshake (protocol v${PROTOCOL_VERSION})`);
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

    /** Forward a `Spring.SendLuaUIMsg(msg, mode)` from a client widget. The
     *  server relays it (filtered by `mode`) to every eligible client where
     *  it surfaces as `widget:RecvLuaMsg(msg, playerID)` — the sending player
     *  included (faithful loopback). `mode`: 0 = all, 97 (`'a'`) = allies,
     *  115 (`'s'`) = spectators. Embedded NULs are preserved. */
    sendLuaUIMsg(data: Uint8Array | string, mode: number): void {
        if (!this.authenticated) return;
        const bytes = typeof data === 'string'
            ? new TextEncoder().encode(data)
            : data;
        const builder = new flatbuffers.Builder(64 + bytes.length);
        const dataOff = LuaUIMsg.createDataVector(builder, bytes);
        const msg = LuaUIMsg.createLuaUIMsg(builder, dataOff, mode & 0xff);
        this.sendClientMessage(builder, ClientPayload.LuaUIMsg, msg);
    }

    /** Send a ConsoleCommand to the game server's exec engine (same
     *  pathway debug-console.ts uses). `scope` picks the runtime —
     *  `"server"` for built-in verbs (`pause`, `unpause`, `speed N`),
     *  or `"LuaRules"` / `"LuaGaia"` / `"LuaAI:<id>"` for Lua. Fire-and-
     *  forget: server's `ConsoleResponse` is ignored. Callers that need
     *  the response should go through DebugConsole's request-tracking
     *  path instead. */
    sendConsoleCommand(scope: string, command: string): void {
        if (!this.authenticated) return;
        if (!this.transport?.connected) return;
        const builder = new flatbuffers.Builder(64 + command.length);
        const scopeOff = builder.createString(scope);
        const cmdOff = builder.createString(command);
        // requestId=0 — we don't track the response.
        const cc = ConsoleCommand.createConsoleCommand(builder, scopeOff, cmdOff, 0);
        this.sendClientMessage(builder, ClientPayload.ConsoleCommand, cc);
    }

    /** Send the local player's current selection. The server uses this
     *  to scope per-tick UnitCmdDescsUpdate broadcasts to only the
     *  selected units. Caller is expected to debounce. */
    sendSelectionState(unitIds: readonly number[]): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(64 + unitIds.length * 4);
        const idsOff = SelectionState.createUnitIdsVector(
            builder, unitIds as number[]);
        this.commandSequence++;
        const sel = SelectionState.createSelectionState(
            builder, this.commandSequence, idsOff);
        this.sendClientMessage(builder, ClientPayload.SelectionState, sel);
    }

    /** Send a `Spring.PathRequest` to the server. The server replies
     *  asynchronously with a `PathResponse` (delivered via
     *  `onPathResponse`); the caller is responsible for matching by
     *  `requestId`. */
    sendPathRequest(
        requestId: number,
        startX: number, startY: number, startZ: number,
        endX: number, endY: number, endZ: number,
        moveType: number,
        goalRadius: number,
    ): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(96);
        PathRequest.startPathRequest(builder);
        PathRequest.addRequestId(builder, requestId);
        PathRequest.addStart(builder,
            Vec3.createVec3(builder, startX, startY, startZ));
        PathRequest.addEnd(builder,
            Vec3.createVec3(builder, endX, endY, endZ));
        PathRequest.addMoveType(builder, moveType);
        PathRequest.addGoalRadius(builder, goalRadius);
        const off = PathRequest.endPathRequest(builder);
        this.sendClientMessage(builder, ClientPayload.PathRequest, off);
    }

    /** Cancel a previously-sent `PathRequest`. Currently a hint — the
     *  server processes paths inline and releases them immediately, so
     *  cancel is a no-op in practice. Send it on `widget:Shutdown` for
     *  forward compat with future async path scheduling. */
    sendPathRequestCancel(requestId: number): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(32);
        PathRequestCancel.startPathRequestCancel(builder);
        PathRequestCancel.addRequestId(builder, requestId);
        const off = PathRequestCancel.endPathRequestCancel(builder);
        this.sendClientMessage(builder, ClientPayload.PathRequestCancel, off);
    }

    /** PLAN-quickstart.md §3.3: tell the server *why* a disconnect that is
     *  about to happen is happening — e.g. reason=3 (detach) so the resulting
     *  PlayerRemoved lets sim gadgets tell a parked/reconnecting player apart
     *  from one who actually quit. Send this before `disconnect()`, not
     *  after — `close()` on the underlying writer flushes queued writes
     *  before the stream actually closes, so ordering is preserved. */
    sendPlayerLeaveIntent(reason: number): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(16);
        const off = PlayerLeaveIntent.createPlayerLeaveIntent(builder, reason);
        this.sendClientMessage(builder, ClientPayload.PlayerLeaveIntent, off);
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

    /** Send a PlayerCommandBatch — atomic execution of N PlayerCommand
     *  entries on the same sim tick. Used by waypoint-drag (an
     *  INSERT+REMOVE pair against the same unit) and building drag-row
     *  / drag-rectangle placement. Consumes one sequence-number slot
     *  for the whole batch; the inner commands don't carry their own. */
    sendPlayerCommandBatch(
        commands: ReadonlyArray<{
            commandId: number;
            unitIds: number[];
            params: number[];
            options?: number;
            timeoutFrames?: number;
        }>,
    ): void {
        if (!this.authenticated) return;
        if (commands.length === 0) return;
        // Build each inner PlayerCommand into the same builder; flatbuffers
        // requires nested objects to be finished before the table that
        // references them, so we accumulate offsets first and only start
        // the outer batch afterwards.
        let totalUnits = 0;
        let totalParams = 0;
        for (const c of commands) {
            totalUnits += c.unitIds.length;
            totalParams += c.params.length;
        }
        const builder = new flatbuffers.Builder(
            256 + commands.length * 32 + totalUnits * 4 + totalParams * 4,
        );
        const cmdOffsets: flatbuffers.Offset[] = [];
        for (const c of commands) {
            const squadIdsOff = PlayerCommand.createSquadIdsVector(builder, c.unitIds);
            const paramsOff = PlayerCommand.createParamsVector(builder, c.params);
            // Inner sequence numbers are ignored by the server (the
            // batch's sequence number is the authoritative one) but the
            // schema requires the field to be present — write 0.
            const off = PlayerCommand.createPlayerCommand(
                builder,
                0,
                c.commandId,
                squadIdsOff,
                paramsOff,
                c.options ?? 0,
                c.timeoutFrames ?? 0,
            );
            cmdOffsets.push(off);
        }
        const cmdsVec = PlayerCommandBatch.createCommandsVector(builder, cmdOffsets);
        this.commandSequence++;
        const batch = PlayerCommandBatch.createPlayerCommandBatch(
            builder,
            this.commandSequence,
            cmdsVec,
        );
        this.sendClientMessage(builder, ClientPayload.PlayerCommandBatch, batch);
    }

    // ---- Macro command & control (PLAN-macro-orders / PLAN-macro-directives) ----

    /** Create a server-side org group (v0: always `echelon = Platoon`, the
     *  only tier the server accepts — `parentId` stays 0, the army tier is
     *  schema-reserved but rejected). Seeds the roster from `memberIds`
     *  (squad entity ids); a squad already in another group is pulled out
     *  of it first (server-side, single-membership rule). */
    sendOrgGroupCreate(name: string, memberIds: number[]): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(128 + memberIds.length * 4);
        const nameOff = builder.createString(name);
        const memberIdsOff = OrgGroupCreate.createMemberIdsVector(builder, memberIds);
        this.commandSequence++;
        const off = OrgGroupCreate.createOrgGroupCreate(
            builder, this.commandSequence, Echelon.Platoon, nameOff, memberIdsOff, 0);
        this.sendClientMessage(builder, ClientPayload.OrgGroupCreate, off);
    }

    /** Mutate a group's roster / name. Empty `name` leaves it unchanged. */
    sendOrgGroupUpdate(groupId: number, addIds: number[], removeIds: number[], name: string = ''): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(128 + (addIds.length + removeIds.length) * 4);
        const addOff = OrgGroupUpdate.createAddIdsVector(builder, addIds);
        const removeOff = OrgGroupUpdate.createRemoveIdsVector(builder, removeIds);
        const nameOff = builder.createString(name);
        this.commandSequence++;
        const off = OrgGroupUpdate.createOrgGroupUpdate(
            builder, this.commandSequence, groupId, addOff, removeOff, nameOff);
        this.sendClientMessage(builder, ClientPayload.OrgGroupUpdate, off);
    }

    /** Disband a group. Members become unassigned; its active directive
     *  (if any) is removed server-side. */
    sendOrgGroupDisband(groupId: number): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(32);
        this.commandSequence++;
        const off = OrgGroupDisband.createOrgGroupDisband(builder, this.commandSequence, groupId);
        this.sendClientMessage(builder, ClientPayload.OrgGroupDisband, off);
    }

    /** Create (`directiveId = 0`) or update (non-zero) a macro directive.
     *  `groupId = 0` = condition-scoped (classic area/standing directive);
     *  non-zero scopes it to that group's roster (the A+C fusion — the
     *  server derives `conditions.orgGroup` from `groupId`, so the client
     *  never fills `conditions` itself for a group-scoped directive).
     *  `shape`/`params` follow the `OrderShape` layout (macro-directives §1):
     *  Point [x,y,z] · Circle [x,y,z,radius] · Polygon [x1,y1,z1,...] (ring) ·
     *  Polyline [frontage,x1,y1,z1,...] (the front line). */
    sendGroupDirective(
        directiveId: number,
        groupId: number,
        type: number,
        shape: number,
        params: number[],
        opts: { priority?: number; requestedStrength?: number; active?: boolean } = {},
    ): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(128 + params.length * 4);
        const paramsOff = GroupDirective.createParamsVector(builder, params);
        this.commandSequence++;
        GroupDirective.startGroupDirective(builder);
        GroupDirective.addSequence(builder, this.commandSequence);
        GroupDirective.addDirectiveId(builder, directiveId);
        GroupDirective.addGroupId(builder, groupId);
        GroupDirective.addType(builder, type);
        GroupDirective.addPriority(builder, opts.priority ?? 0);
        GroupDirective.addShape(builder, shape);
        GroupDirective.addParams(builder, paramsOff);
        GroupDirective.addRequestedStrength(builder, opts.requestedStrength ?? 0);
        GroupDirective.addActive(builder, opts.active ?? true);
        const off = GroupDirective.endGroupDirective(builder);
        this.sendClientMessage(builder, ClientPayload.GroupDirective, off);
    }

    /** Remove a macro directive. Releases its assigned squads back to idle. */
    sendGroupDirectiveRemove(directiveId: number): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(32);
        this.commandSequence++;
        const off = GroupDirectiveRemove.createGroupDirectiveRemove(builder, this.commandSequence, directiveId);
        this.sendClientMessage(builder, ClientPayload.GroupDirectiveRemove, off);
    }

    /** Set a group's posture bundle (engagement / casualty tolerance /
     *  reinforcement policy / area-weapon ROE — macro-orders §3). Stored
     *  verbatim and echoed back in `OrgGroupInfo.postureJson`. */
    sendGroupPosture(groupId: number, postureJson: string): void {
        if (!this.authenticated) return;
        const builder = new flatbuffers.Builder(64 + postureJson.length * 2);
        const jsonOff = builder.createString(postureJson);
        this.commandSequence++;
        const off = GroupPosture.createGroupPosture(builder, this.commandSequence, groupId, jsonOff);
        this.sendClientMessage(builder, ClientPayload.GroupPosture, off);
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

    /** Send data on the control (reliable, ordered) tier. */
    private sendOnControl(data: Uint8Array): void {
        recordOutbound(data);  // GW8: outbound bandwidth tally (control tier)
        this.transport?.send(data, 'control');
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
     *  into the same dispatch path used for WebTransport frames. Used by the
     *  HTTP def-fetch path, which downloads the same bytes the server
     *  would otherwise stream and pumps them through here. */
    public ingestFramedMessage(data: Uint8Array): void {
        this.handleBinaryMessage(data);
    }

    /**
     * Artificial-latency injection for the unreliable state channel
     * (PLAN-latency.md L0 — "THE validation tool for the whole stage").
     * Reproduces intercontinental conditions on localhost so every L0/L1/L2
     * mitigation can be A/B'd against "does it still look right at 200 ms ±
     * jitter, 2 % loss?". Applied ONLY to the state channel (0x02/0x03 entity
     * state etc.) — the reliable control channel is left untouched, matching
     * reality (TCP-like reliability vs. lossy datagrams). Per-packet random
     * jitter naturally produces reordering; the PresentationClock's base_frame
     * sequence tracking detects the reorder/loss. */
    private netSim = { enabled: false, delayMs: 0, jitterMs: 0, lossProb: 0 };

    /** Configure (or disable) artificial latency on the state channel.
     *  `{ delayMs, jitterMs, lossProb }` — lossProb in [0,1]. Enabled
     *  whenever delay/jitter/loss is non-zero. */
    setNetSim(cfg: { delayMs?: number; jitterMs?: number; lossProb?: number }): void {
        if (cfg.delayMs != null) this.netSim.delayMs = Math.max(0, cfg.delayMs);
        if (cfg.jitterMs != null) this.netSim.jitterMs = Math.max(0, cfg.jitterMs);
        if (cfg.lossProb != null) this.netSim.lossProb = Math.min(1, Math.max(0, cfg.lossProb));
        this.netSim.enabled =
            this.netSim.delayMs > 0 || this.netSim.jitterMs > 0 || this.netSim.lossProb > 0;
        console.log(`[netsim] ${this.netSim.enabled ? 'ON' : 'off'} delay=${this.netSim.delayMs}ms jitter=±${this.netSim.jitterMs}ms loss=${(this.netSim.lossProb * 100).toFixed(1)}%`);
    }

    /** Get the current artificial-latency config (for overlays / tooling). */
    getNetSim(): Readonly<{ enabled: boolean; delayMs: number; jitterMs: number; lossProb: number }> {
        return this.netSim;
    }

    /** Inbound state-channel frame — passes through the artificial-latency
     *  simulator (when armed) before normal dispatch. */
    private receiveStateFrame(data: Uint8Array): void {
        if (!this.netSim.enabled) {
            this.handleBinaryMessage(data);
            return;
        }
        if (this.netSim.lossProb > 0 && Math.random() < this.netSim.lossProb) {
            return; // dropped packet
        }
        const jitter = this.netSim.jitterMs > 0
            ? (Math.random() * 2 - 1) * this.netSim.jitterMs
            : 0;
        const delay = Math.max(0, this.netSim.delayMs + jitter);
        if (delay <= 0) {
            this.handleBinaryMessage(data);
        } else {
            setTimeout(() => this.handleBinaryMessage(data), delay);
        }
    }

    private handleBinaryMessage(data: Uint8Array): void {
        if (data.length < 2) return;

        const envelope = data[0];
        if (envelope === ENVELOPE_ENTITY_STATE_FULL || envelope === ENVELOPE_ENTITY_STATE_DELTA) {
            const snapshot = parseEntityState(data.subarray(1));
            if (snapshot) {
                if (snapshot.baseFrame > this.newestStateFrame) {
                    this.newestStateFrame = snapshot.baseFrame;
                }
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
        if (envelope === ENVELOPE_LOS_BITMAP) {
            const bitmap = parseLosBitmap(data.subarray(1));
            if (bitmap) {
                this.events.onLosBitmap?.(bitmap);
            }
            return;
        }
        if (envelope === ENVELOPE_DECALS) {
            const snapshot = parseDecals(data.subarray(1));
            if (snapshot) {
                this.events.onDecals?.(snapshot);
            }
            return;
        }
        if (envelope === ENVELOPE_HEIGHTMAP) {
            const patch = parseHeightmapPatch(data.subarray(1));
            if (patch) {
                this.events.onHeightmapPatch?.(patch);
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
            case ServerPayload.EntitySensorUpdate:
                this.handleEntitySensorUpdate(msg);
                break;
            case ServerPayload.SendToUnsyncedEvent:
                this.handleSendToUnsynced(msg);
                break;
            case ServerPayload.GameInfo: {
                const info = msg.payload(new GameInfo()) as GameInfo;
                this.events.onGameInfo?.(info.frame(), info.gameSpeed(), info.paused(), {
                    x: info.windX(), y: info.windY(), z: info.windZ(),
                    strength: info.windStrength(),
                    tidal: info.tidalStrength(),
                }, info.legacyCoordSystem(), info.maxUnits());
                // Game over is signalled by the explicit game_over flag, NOT by
                // paused — a normal in-game pause reuses this GameInfo message and
                // must not trigger the end-game overlay (the prior `info.paused()`
                // check did, a latent bug; G2). winning_ally_teams carries the
                // Spring.GameOver winners (empty = undecided).
                if (info.gameOver()) {
                    const winners: number[] = [];
                    for (let i = 0; i < info.winningAllyTeamsLength(); i++) {
                        winners.push(info.winningAllyTeams(i) ?? 0);
                    }
                    this.events.onGameOver?.(info.frame(), winners);
                }
                break;
            }
            case ServerPayload.TeamStartInfo: {
                const tsi = msg.payload(new TeamStartInfo()) as TeamStartInfo;
                const teams: TeamStartPositionInfo[] = [];
                for (let i = 0; i < tsi.teamsLength(); i++) {
                    const t = tsi.teams(i);
                    if (!t) continue;
                    teams.push({
                        team: t.team(), allyTeam: t.allyTeam(),
                        x: t.x(), y: t.y(), z: t.z(), valid: t.valid(),
                    });
                }
                const boxes: AllyStartBoxInfo[] = [];
                for (let i = 0; i < tsi.boxesLength(); i++) {
                    const b = tsi.boxes(i);
                    if (!b) continue;
                    boxes.push({
                        allyTeam: b.allyTeam(),
                        xmin: b.xmin(), zmin: b.zmin(), xmax: b.xmax(), zmax: b.zmax(),
                    });
                }
                this.events.onTeamStartInfo?.({ teams, boxes });
                break;
            }
            case ServerPayload.PlayerTeamEventBatch: {
                const batch = msg.payload(new PlayerTeamEventBatch()) as PlayerTeamEventBatch;
                const events: PlayerTeamEventInfo[] = [];
                for (let i = 0; i < batch.eventsLength(); i++) {
                    const e = batch.events(i);
                    if (!e) continue;
                    events.push({ kind: e.kind(), id: e.id(), reason: e.reason() });
                }
                if (events.length > 0) this.events.onPlayerTeamEvents?.(events);
                break;
            }
            case ServerPayload.GameModOptions: {
                const mo = msg.payload(new GameModOptions()) as GameModOptions;
                const options: Record<string, string> = {};
                for (let i = 0; i < mo.optionsLength(); i++) {
                    const o = mo.options(i);
                    if (!o) continue;
                    const key = o.key();
                    if (key) options[key] = o.value() ?? '';
                }
                this.events.onGameModOptions?.(options);
                break;
            }
            case ServerPayload.TeamStatsHistoryBatch: {
                const batch = msg.payload(new TeamStatsHistoryBatch()) as TeamStatsHistoryBatch;
                const teams: TeamStatsHistoryInfo[] = [];
                for (let i = 0; i < batch.teamsLength(); i++) {
                    const t = batch.teams(i);
                    if (!t) continue;
                    const entries: TeamStatsEntryInfo[] = [];
                    for (let j = 0; j < t.entriesLength(); j++) {
                        const e = t.entries(j);
                        if (!e) continue;
                        entries.push({
                            frame: e.frame(),
                            metalUsed: e.metalUsed(),         energyUsed: e.energyUsed(),
                            metalProduced: e.metalProduced(), energyProduced: e.energyProduced(),
                            metalExcess: e.metalExcess(),     energyExcess: e.energyExcess(),
                            metalReceived: e.metalReceived(), energyReceived: e.energyReceived(),
                            metalSent: e.metalSent(),         energySent: e.energySent(),
                            damageDealt: e.damageDealt(),     damageReceived: e.damageReceived(),
                            unitsProduced: e.unitsProduced(), unitsDied: e.unitsDied(),
                            unitsReceived: e.unitsReceived(), unitsSent: e.unitsSent(),
                            unitsCaptured: e.unitsCaptured(), unitsOutCaptured: e.unitsOutCaptured(),
                            unitsKilled: e.unitsKilled(),
                        });
                    }
                    teams.push({ teamId: t.teamId(), baseIndex: t.baseIndex(), entries });
                }
                if (teams.length > 0) this.events.onTeamStatsHistory?.(teams);
                break;
            }
            case ServerPayload.LuaUIMsgRelay: {
                const r = msg.payload(new LuaUIMsgRelay()) as LuaUIMsgRelay;
                const arr = r.dataArray();
                // Copy out of the FlatBuffer view (it aliases the receive
                // buffer, reused next frame) before handing to the worker.
                const data = arr ? arr.slice() : new Uint8Array(0);
                this.events.onLuaUIMsg?.(data, r.playerId());
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
            case ServerPayload.PlayerLeft: {
                const pl = msg.payload(new PlayerLeft()) as PlayerLeft;
                console.log(`[connection] player left: ${pl.username()} (team ${pl.team()}, reason ${pl.reason()})`);
                this.events.onPlayerLeft?.(pl.playerId(), pl.username() ?? '', pl.team(), pl.reason());
                break;
            }
            case ServerPayload.FeatureLifecycleBatch: {
                const fb = msg.payload(new FeatureLifecycleBatch()) as FeatureLifecycleBatch;
                const spawns: FeatureSpawnInfo[] = [];
                for (let i = 0; i < fb.spawnsLength(); i++) {
                    const s = fb.spawns(i, new FeatureSpawnFb());
                    if (!s) continue;
                    spawns.push({
                        featureId: s.featureId(),
                        defId: s.defId(),
                        x: s.x(),
                        y: s.y(),
                        z: s.z(),
                        heading: s.heading(),
                        buildFacing: s.buildFacing(),
                        team: s.team(),
                        allyTeam: s.allyTeam(),
                    });
                }
                const removed: number[] = [];
                for (let i = 0; i < fb.removedLength(); i++) {
                    removed.push(fb.removed(i) ?? 0);
                }
                if (spawns.length || removed.length) {
                    this.events.onFeatureLifecycle?.(spawns, removed);
                }
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
                        const params: string[] = [];
                        for (let pi = 0; pi < c.paramsLength(); pi++) {
                            params.push(c.params(pi) ?? '');
                        }
                        cmds.push({
                            cmdId: c.cmdId(),
                            disabled: !!c.disabled(),
                            name:    c.name()    ?? '',
                            action:  c.action()  ?? '',
                            texture: c.texture() ?? '',
                            tooltip: c.tooltip() ?? '',
                            type:    c.type(),
                            params,
                            hidden:  !!c.hidden(),
                        });
                    }
                    units.push({ unitId: u.unitId(), cmds });
                }
                this.events.onUnitCmdDescs?.(units);
                break;
            }
            case ServerPayload.UnitTransportUpdate: {
                const fbUpd = msg.payload(new UnitTransportUpdate()) as UnitTransportUpdate;
                const transports: UnitTransportInfoMsg[] = [];
                for (let i = 0; i < fbUpd.transportsLength(); i++) {
                    const t = fbUpd.transports(i, new UnitTransportInfo());
                    if (!t) continue;
                    const cargo: number[] = [];
                    for (let ci = 0; ci < t.cargoLength(); ci++) cargo.push(t.cargo(ci) ?? 0);
                    transports.push({ transporterId: t.transporterId(), cargo });
                }
                this.events.onUnitTransports?.(transports);
                break;
            }
            case ServerPayload.UnitSelfDUpdate: {
                const fbUpd = msg.payload(new UnitSelfDUpdate()) as UnitSelfDUpdate;
                const units: UnitSelfDInfoMsg[] = [];
                for (let i = 0; i < fbUpd.unitsLength(); i++) {
                    const u = fbUpd.units(i, new UnitSelfDInfo());
                    if (!u) continue;
                    units.push({ unitId: u.unitId(), secondsRemaining: u.secondsRemaining() });
                }
                this.events.onUnitSelfD?.(units);
                break;
            }
            case ServerPayload.UnitStockpileUpdate: {
                const fbUpd = msg.payload(new UnitStockpileUpdate()) as UnitStockpileUpdate;
                const units: UnitStockpileInfoMsg[] = [];
                for (let i = 0; i < fbUpd.unitsLength(); i++) {
                    const u = fbUpd.units(i, new UnitStockpileInfo());
                    if (!u) continue;
                    units.push({
                        unitId: u.unitId(),
                        ready: u.ready(),
                        queued: u.queued(),
                        buildPercent: u.buildPercent(),
                    });
                }
                this.events.onUnitStockpile?.(units);
                break;
            }
            case ServerPayload.UnitLifecycleBatch: {
                const fbBatch = msg.payload(new UnitLifecycleBatch()) as UnitLifecycleBatch;
                const events: UnitLifecycleEventMsg[] = [];
                for (let i = 0; i < fbBatch.eventsLength(); i++) {
                    const e = fbBatch.events(i, new UnitLifecycleEvent());
                    if (!e) continue;
                    const k = e.kind();
                    const kind: UnitLifecycleKindStr =
                        k === UnitLifecycleKind.FromFactory ? 'fromFactory'
                      : k === UnitLifecycleKind.Taken       ? 'taken'
                      : k === UnitLifecycleKind.Given       ? 'given'
                      : 'created';
                    events.push({
                        kind,
                        unitId:       e.unitId(),
                        unitDefId:    e.unitDefId(),
                        unitTeam:     e.unitTeam(),
                        factoryId:    e.factoryId(),
                        factoryDefId: e.factoryDefId(),
                        userOrders:   !!e.userOrders(),
                        oldTeam:      e.oldTeam(),
                        newTeam:      e.newTeam(),
                        builderId:    e.builderId(),
                    });
                }
                this.events.onUnitLifecycle?.(events);
                break;
            }
            case ServerPayload.UnitCommandBatch: {
                const fbBatch = msg.payload(new UnitCommandBatch()) as UnitCommandBatch;
                const events: UnitCommandEventMsg[] = [];
                for (let i = 0; i < fbBatch.eventsLength(); i++) {
                    const e = fbBatch.events(i, new UnitCommandEvent());
                    if (!e) continue;
                    const kind: UnitCommandKindStr =
                        e.kind() === UnitCommandKind.Issued ? 'issued' : 'done';
                    const params: number[] = [];
                    for (let p = 0; p < e.paramsLength(); p++) {
                        params.push(e.params(p) ?? 0);
                    }
                    events.push({
                        kind,
                        unitId:     e.unitId(),
                        unitDefId:  e.unitDefId(),
                        unitTeam:   e.unitTeam(),
                        cmdId:      e.cmdId(),
                        params,
                        options:    e.options(),
                        tag:        e.tag(),
                        playerId:   e.playerId(),
                        fromSynced: !!e.fromSynced(),
                        fromLua:    !!e.fromLua(),
                    });
                }
                this.events.onUnitCommand?.(events);
                break;
            }
            case ServerPayload.UnitArmoredUpdate: {
                const fbUpd = msg.payload(new UnitArmoredUpdate()) as UnitArmoredUpdate;
                const units: UnitArmoredInfoMsg[] = [];
                for (let i = 0; i < fbUpd.unitsLength(); i++) {
                    const u = fbUpd.units(i, new UnitArmoredInfo());
                    if (!u) continue;
                    units.push({
                        unitId: u.unitId(),
                        armored: !!u.armored(),
                        armoredMultiple: u.armoredMultiple(),
                    });
                }
                this.events.onUnitArmored?.(units);
                break;
            }
            case ServerPayload.PathResponse: {
                const fbResp = msg.payload(new PathResponse()) as PathResponse;
                const waypoints: Array<readonly [number, number, number]> = [];
                for (let i = 0; i < fbResp.waypointsLength(); i++) {
                    const v = fbResp.waypoints(i);
                    if (!v) continue;
                    waypoints.push([v.x(), v.y(), v.z()]);
                }
                this.events.onPathResponse?.({
                    requestId: fbResp.requestId(),
                    waypoints,
                    length: fbResp.length(),
                });
                break;
            }
            case ServerPayload.StandingOrderState: {
                const fbState = msg.payload(new StandingOrderState()) as StandingOrderState;
                const out: StandingOrderInfoMsg[] = [];
                for (let i = 0; i < fbState.ordersLength(); i++) {
                    const o = fbState.orders(i);
                    if (!o) continue;
                    const params: number[] = [];
                    for (let j = 0; j < o.paramsLength(); j++) {
                        params.push(o.params(j) ?? 0);
                    }
                    const condsFb = o.conditions();
                    const withinCenter = condsFb?.withinRadiusCenter();
                    const outsideCenter = condsFb?.outsideRadiusCenter();
                    const squadTypes: number[] = [];
                    if (condsFb) {
                        for (let j = 0; j < condsFb.squadTypesLength(); j++) {
                            squadTypes.push(condsFb.squadTypes(j) ?? 0);
                        }
                    }
                    const caps: string[] = [];
                    if (condsFb) {
                        for (let j = 0; j < condsFb.hasCapabilitiesLength(); j++) {
                            const s = condsFb.hasCapabilities(j);
                            if (s != null) caps.push(s);
                        }
                    }
                    out.push({
                        orderId: o.orderId(),
                        ownerTeam: o.ownerTeam(),
                        type: StandingOrderType[o.type()] ?? 'DefendArea',
                        priority: o.priority(),
                        params,
                        conditions: {
                            idleOnly: condsFb ? condsFb.idleOnly() : true,
                            squadTypes,
                            withinCenter: withinCenter
                                ? [withinCenter.x(), withinCenter.y(), withinCenter.z()]
                                : [0, 0, 0],
                            withinRadius: condsFb?.withinRadiusRadius() ?? 0,
                            outsideCenter: outsideCenter
                                ? [outsideCenter.x(), outsideCenter.y(), outsideCenter.z()]
                                : [0, 0, 0],
                            outsideRadius: condsFb?.outsideRadiusRadius() ?? 0,
                            minStrength: condsFb?.minStrength() ?? 0,
                            hasCapabilities: caps,
                        },
                        assignedSquadCount: o.assignedSquadCount(),
                        active: o.active(),
                        createdAtFrame: o.createdAtFrame(),
                        expiresAtFrame: o.expiresAtFrame(),
                    });
                }
                this.events.onStandingOrders?.(out);
                break;
            }
            case ServerPayload.OrgGroupState: {
                const fbState = msg.payload(new OrgGroupState()) as OrgGroupState;
                const out: OrgGroupInfoMsg[] = [];
                for (let i = 0; i < fbState.groupsLength(); i++) {
                    const g = fbState.groups(i);
                    if (!g) continue;
                    const memberIds: number[] = [];
                    for (let j = 0; j < g.memberIdsLength(); j++) {
                        memberIds.push(g.memberIds(j) ?? 0);
                    }
                    out.push({
                        groupId: g.groupId(),
                        echelon: Echelon[g.echelon()] as OrgGroupInfoMsg['echelon'] ?? 'Platoon',
                        ownerTeam: g.ownerTeam(),
                        parentId: g.parentId(),
                        name: g.name() ?? '',
                        memberIds,
                        currentDirectiveId: g.currentDirectiveId(),
                        postureJson: g.postureJson() ?? '',
                        createdAtFrame: g.createdAtFrame(),
                    });
                }
                this.events.onOrgGroupState?.(out);
                break;
            }
            case ServerPayload.DirectiveState: {
                const fbState = msg.payload(new DirectiveState()) as DirectiveState;
                const out: DirectiveInfoMsg[] = [];
                for (let i = 0; i < fbState.directivesLength(); i++) {
                    const d = fbState.directives(i);
                    if (!d) continue;
                    const params: number[] = [];
                    for (let j = 0; j < d.paramsLength(); j++) {
                        params.push(d.params(j) ?? 0);
                    }
                    out.push({
                        directiveId: d.directiveId(),
                        ownerTeam: d.ownerTeam(),
                        groupId: d.groupId(),
                        type: DirectiveType[d.type()] ?? 'DefendArea',
                        priority: d.priority(),
                        shape: OrderShape[d.shape()] as DirectiveInfoMsg['shape'] ?? 'Point',
                        params,
                        requestedStrength: d.requestedStrength(),
                        assignedStrength: d.assignedStrength(),
                        assignedSquadCount: d.assignedSquadCount(),
                        active: d.active(),
                        createdAtFrame: d.createdAtFrame(),
                        expiresAtFrame: d.expiresAtFrame(),
                    });
                }
                this.events.onDirectiveState?.(out);
                break;
            }
            case ServerPayload.GameRestarting:
                console.log('[connection] server restarting — host will reload');
                this.events.onServerRestart?.();
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
        this.lastEventFrame = frame;

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

        // Projectile lifecycle events. The renderer integrates motion
        // locally between server updates, so each batch typically carries
        // only Fired/Impact/Trajectory transitions — not per-tick state.
        const firedCount = batch.projectileFiredLength();
        if (firedCount > 0 && this.events.onProjectileFired) {
            const out: ProjectileFiredInfo[] = [];
            for (let i = 0; i < firedCount; i++) {
                const e = batch.projectileFired(i, new ProjectileFiredEvent());
                if (!e) continue;
                const p = e.pos();
                const v = e.vel();
                const t = e.targetPos();
                out.push({
                    projId: e.projId(),
                    weaponDefId: e.weaponDefId(),
                    ownerId: e.ownerId(),
                    team: e.team(),
                    pos: { x: p?.x() ?? 0, y: p?.y() ?? 0, z: p?.z() ?? 0 },
                    vel: { x: v?.x() ?? 0, y: v?.y() ?? 0, z: v?.z() ?? 0 },
                    targetPos: { x: t?.x() ?? 0, y: t?.y() ?? 0, z: t?.z() ?? 0 },
                    targetId: e.targetId(),
                    ttl: e.ttl(),
                    gravity: e.gravity(),
                    hitscan: e.hitscan(),
                });
            }
            this.events.onProjectileFired(out, frame);
        }

        const impactCount = batch.projectileImpactsLength();
        if (impactCount > 0 && this.events.onProjectileImpacts) {
            const out: ProjectileImpactInfo[] = [];
            for (let i = 0; i < impactCount; i++) {
                const e = batch.projectileImpacts(i, new ProjectileImpactEvent());
                if (!e) continue;
                const p = e.pos();
                out.push({
                    projId: e.projId(),
                    pos: { x: p?.x() ?? 0, y: p?.y() ?? 0, z: p?.z() ?? 0 },
                    impactKind: e.impactKind(),
                    targetId: e.targetId(),
                    weaponDefId: e.weaponDefId(),
                });
            }
            this.events.onProjectileImpacts(out, frame);
        }

        const trajCount = batch.projectileTrajectoriesLength();
        if (trajCount > 0 && this.events.onProjectileTrajectories) {
            const out: ProjectileTrajectoryInfo[] = [];
            for (let i = 0; i < trajCount; i++) {
                const e = batch.projectileTrajectories(i, new ProjectileTrajectoryEvent());
                if (!e) continue;
                const p = e.pos();
                const v = e.vel();
                out.push({
                    projId: e.projId(),
                    pos: { x: p?.x() ?? 0, y: p?.y() ?? 0, z: p?.z() ?? 0 },
                    vel: { x: v?.x() ?? 0, y: v?.y() ?? 0, z: v?.z() ?? 0 },
                    reason: e.reason(),
                });
            }
            this.events.onProjectileTrajectories(out, frame);
        }

        const soundCount = batch.soundsLength();
        if (soundCount > 0 && this.events.onSoundEvents) {
            const out: SoundEventInfo[] = [];
            for (let i = 0; i < soundCount; i++) {
                const e = batch.sounds(i, new SoundEvent());
                if (!e) continue;
                const p = e.position();
                out.push({
                    soundId: e.soundId(),
                    sourceDefId: e.sourceDefId(),
                    sourceKind: e.sourceKind(),
                    x: p?.x() ?? 0,
                    y: p?.y() ?? 0,
                    z: p?.z() ?? 0,
                    volume: e.volume(),
                    pitch: e.pitch(),
                    priority: e.priority(),
                    team: e.team(),
                    channel: e.channel(),
                });
            }
            this.events.onSoundEvents(out, frame);
        }

        const pingCount = batch.seismicPingsLength();
        if (pingCount > 0 && this.events.onSeismicPings) {
            const out: SeismicPingInfo[] = [];
            for (let i = 0; i < pingCount; i++) {
                const e = batch.seismicPings(i, new SeismicPing());
                if (!e) continue;
                const p = e.pos();
                out.push({
                    x: p?.x() ?? 0,
                    y: p?.y() ?? 0,
                    z: p?.z() ?? 0,
                    strength: e.strength(),
                    allyTeam: e.allyTeam(),
                });
            }
            this.events.onSeismicPings(out, frame);
        }

        const musicCount = batch.musicEventsLength();
        if (musicCount > 0 && this.events.onMusicEvent) {
            // Music state machine emits at most one transition per
            // batch — take the last one in case the server ever sends
            // multiple (e.g. peace→tension→battle within a single tick).
            for (let i = 0; i < musicCount; i++) {
                const e = batch.musicEvents(i, new MusicEvent());
                if (!e) continue;
                this.events.onMusicEvent(e.state(), e.fadeMs(), frame);
            }
        }
    }

    private handleEntityDestroy(msg: ServerMessage): void {
        const destroy = msg.payload(new EntityDestroy()) as EntityDestroy;
        const pos = destroy.position();
        // The destroy message carries no frame of its own (proper L2 fix: a
        // real frame field on the EntityDestroy wire message). lastEventFrame
        // is only the death's frame when a same-tick combat batch preceded it;
        // the server sends no batch on event-less ticks and LOS-filters batch
        // contents per viewer while destroys use a different losMask — so a
        // Lua DestroyUnit / self-d / filtered kill would otherwise inherit an
        // unrelated, possibly stale batch frame and present the removal up to
        // ~D (0.13–1 s) early. Fall back to the newest observed entity-state
        // frame: both are lower bounds on the true death frame, so take the max.
        this.events.onEntityDestroy?.(
            destroy.entityId(),
            pos ? pos.x() : 0,
            pos ? pos.y() : 0,
            pos ? pos.z() : 0,
            Math.max(this.lastEventFrame, this.newestStateFrame),
        );
    }

    private handleEntitySensorUpdate(msg: ServerMessage): void {
        const upd = msg.payload(new EntitySensorUpdate()) as EntitySensorUpdate;
        this.events.onEntitySensorUpdate?.(
            upd.entityId(),
            upd.sensorType(),
            upd.radius(),
        );
    }

    private handleSendToUnsynced(msg: ServerMessage): void {
        if (!this.events.onSendToUnsynced) return;
        const ev = msg.payload(new SendToUnsyncedEvent()) as SendToUnsyncedEvent;
        const n = ev.argsLength();
        if (n === 0) return;
        const args: SendToUnsyncedArgInfo[] = new Array(n);
        const tmp = new SendToUnsyncedArg();
        for (let i = 0; i < n; i++) {
            const a = ev.args(i, tmp);
            if (!a) {
                args[i] = { kind: 'nil' };
                continue;
            }
            const k = a.kind();
            switch (k) {
                case SendToUnsyncedArgKind.Bool:
                    args[i] = { kind: 'bool', value: a.boolVal() };
                    break;
                case SendToUnsyncedArgKind.Number:
                    args[i] = { kind: 'number', value: a.numVal() };
                    break;
                case SendToUnsyncedArgKind.String:
                    args[i] = { kind: 'string', value: (a.strVal() ?? '') as string };
                    break;
                case SendToUnsyncedArgKind.Nil:
                default:
                    args[i] = { kind: 'nil' };
                    break;
            }
        }
        this.events.onSendToUnsynced(args);
    }
}
