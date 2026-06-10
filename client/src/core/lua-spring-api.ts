/**
 * Spring compatibility API for client-side Lua widgets.
 *
 * These are thin JS implementations of the Spring Lua API that widgets
 * expect. We implement only the subset actually used by the widgets we
 * currently support — each widget we add may require more functions.
 *
 * Design:
 *   - SpringAPIContext holds per-game state (map dims, heightmap, game time)
 *     that the API functions need to answer queries.
 *   - buildSpringGlobals(ctx) returns a flat {Spring, Game, GL, VFS} object
 *     that can be installed into a LuaRuntime via setGlobal in one pass.
 *   - VFS is pre-populated with fetched .lua sources keyed by path so
 *     VFS.Include can be synchronous.
 */
import { LuaRuntime, type LuaValue, luaTable, isLuaTable } from './lua-runtime.js';
import { lua, to_luastring } from 'fengari-web';

/** One-time console.warn de-dupe for FIDELITY-STANDIN paths (per the
 *  no-silent-GL-failures principle in PLAN.md — every stand-in must warn
 *  once so it stays re-visitable). */
const _warnedStandins = new Set<string>();
function warnStandinOnce(key: string, message: string): void {
    if (_warnedStandins.has(key)) return;
    _warnedStandins.add(key);
    console.warn(`[FIDELITY-STANDIN] ${message}`);
}

/** Context passed in when constructing the Spring shim. */
export interface SpringAPIContext {
    /** Map width in elmos (world units). */
    mapSizeX: number;
    /** Map depth in elmos. */
    mapSizeZ: number;
    /** Heightmap — square grid of (mapx+1)*(mapy+1) corner heights in world units. */
    heightmap: Uint16Array;
    /** Heightmap grid width (mapx+1). */
    heightmapWidth: number;
    /** Heightmap grid height (mapy+1). */
    heightmapHeight: number;
    /** Height value → world Y conversion. */
    minHeight: number;
    maxHeight: number;
    /** Square size in elmos (typically 8). */
    squareSize: number;
    /**
     * Pre-fetched source files, keyed by forward-slash path. Populated
     * from the map's own `LuaUI/` tree and the currently-loaded game's
     * VFS. `VFS.Include()` looks up sources here — the widget host is
     * responsible for pre-fetching anything a widget may reference
     * synchronously.
     */
    vfsFiles: Map<string, string>;
    /**
     * Game identity from the lobby's `/api/games` discovery (which reads
     * the game's modinfo). Used to populate the `Game` table's
     * modName/modShortName/modVersion/modDesc/gameName so widgets see the
     * real game (e.g. "Beyond All Reason") instead of a hardcoded default.
     * All optional — fall back to gameId when absent.
     */
    gameId?: string;
    modName?: string;
    modShortName?: string;
    modVersion?: string;
    modDesc?: string;
    /** Optional game rules params (stubbed lookup). */
    gameRulesParams?: Map<string, number>;
    /** getGameSeconds callback — usually `() => Date.now()/1000 - startTime`. */
    getGameSeconds(): number;
    /**
     * Submit a unit order for delivery to the server. Receives the raw
     * Spring command id, the affected unit ids, the parameter list, and
     * the bitfield options (SHIFT/ALT/CTRL/META). The host wires this to
     * `Connection.sendPlayerCommand`. Optional — if absent, the
     * `Spring.GiveOrder*` calls become no-ops (used by tests).
     */
    giveOrder?(cmdId: number, unitIds: number[], params: number[], options: number): void;
    /**
     * Forward a `Spring.SendLuaRulesMsg(msg)` call to the server. The
     * host wires this to `Connection.sendLuaRulesMsg`. Optional — if
     * absent, the call becomes a no-op.
     */
    sendLuaRulesMsg?(data: string): void;
    /**
     * Forward a `Spring.SendLuaUIMsg(msg, mode)` call to the server, which
     * relays it (filtered by `mode`) to every eligible player's LuaUI as
     * `widget:RecvLuaMsg(msg, playerID)`. `mode`: 0 = all, 97 (`'a'`) =
     * allies, 115 (`'s'`) = spectators. Host wires this to
     * `Connection.sendLuaUIMsg`. Optional — absent ⇒ no-op.
     */
    sendLuaUIMsg?(data: string, mode: number): void;
    /**
     * Replace the player's current unit selection. Called by
     * `Spring.SelectUnit` / `SelectUnitArray` / `SelectUnitMap` /
     * `DeselectUnit`. The host wires this to InputManager so the
     * highlight, minimap, and build menu all update. Optional — if
     * absent, those Lua calls update only the worker-local
     * `selectedUnitIds` and have no visible effect.
     */
    setSelection?(unitIds: number[]): void;
    /**
     * Move the player's camera to look at a world point. Called by
     * `Spring.SetCameraTarget` and the position-only path of
     * `Spring.SetCameraState`. `smoothness` is Spring's seconds-ish
     * pacing hint; 0 (or undefined) means teleport. Y is ignored — the
     * RTS camera maintains its own height. Optional.
     */
    setCameraTarget?(x: number, z: number, smoothness?: number): void;

    /**
     * Apply a full Spring-shape camera state. `state` is the same table
     * Lua's `Spring.SetCameraState(state, transitionTime)` expects:
     * `{px, py, pz}` set the camera position, `{tx, ty, tz}` (or `{rx,
     * ry}`-derived direction) set the look-at, `dist`/`height` adjust
     * orbit distance, `fov` sets vertical FOV in degrees. Fields the
     * host can't honour are silently ignored. `smoothness` is the same
     * seconds-ish hint as `setCameraTarget`. Optional.
     */
    setCameraState?(state: Record<string, unknown>, smoothness?: number): void;

    /**
     * Read the host's current camera pose. Used by `Spring.GetCameraState`
     * so widgets see live coordinates regardless of when the host last
     * pushed a synced snapshot via the lua-state bridge. Returns the
     * structural `{pos, lookAt}` shape RTSCamera publishes; optional —
     * absent hosts fall back to the cached `ls.camera` values.
     */
    getCameraPose?(): {
        pos: { x: number; y: number; z: number };
        lookAt: { x: number; y: number; z: number };
    } | null;
    /**
     * Resolve a unit-def id to its internal name (e.g. 549 →
     * "staticmex"). Used by GetUnitCmdDescs to fill in cmd.name and
     * cmd.action so chili widgets can look up the def via
     * UnitDefNames[name] the same way they would against a real Spring
     * client. Optional — falls back to the numeric id as a string.
     */
    getUnitDefName?(defId: number): string | undefined;
    /**
     * Look up a sensor-range field on a cached UnitDef. `type` matches
     * the Spring API: "los" | "airLos" | "radar" | "sonar" | "radarJammer"
     * | "sonarJammer" | "seismic". Returns `undefined` if the def is
     * unknown to the worker yet (it streams in on demand). Optional —
     * if absent, `Spring.GetUnitSensorRadius` returns `nil`.
     */
    getUnitDefSensorRadius?(defId: number, type: string): number | undefined;
    /**
     * Look up a unit-def's footprint dimensions in build squares (8 elmos
     * per square). Used by `Spring.TestBuildOrder` and `Spring.Pos2BuildPos`
     * for client-side placement checks. Also reports whether the def is
     * mobile (has movement type) — TestBuildOrder distinguishes mobile-
     * blocking from terrain-blocking. Returns `undefined` if the def
     * isn't cached yet.
     */
    getUnitDefFootprint?(defId: number): { xsize: number; zsize: number; isMobile: boolean } | undefined;
    /**
     * Look up a unit-def's collision/model radius (elmos). Backs
     * `Spring.GetUnitRadius` — Recoil returns the live `unit->radius`,
     * which for our streamed units equals the def radius (we don't model
     * per-unit radius scaling). Returns `undefined` if the def isn't
     * cached yet.
     */
    getUnitDefRadius?(defId: number): number | undefined;
    /**
     * Ordered weapon-def ids that make up a unit-def's weapon slots
     * (Recoil's `unit->weapons`, built from the def's weapon list).
     * Index 0 is weapon 1 (Lua's `weaponNum` is 1-based). Backs the
     * static fields of `Spring.GetUnitWeaponState`. Returns `undefined`
     * if the unit def isn't cached yet.
     */
    getUnitDefWeaponDefIds?(defId: number): number[] | undefined;
    /**
     * Static (def-derived) state of a weapon def, in the units
     * `Spring.GetUnitWeaponState` reports them: reload/burst times in
     * seconds, ranges in elmos, projectile speed in elmos/frame. Per-unit
     * *dynamic* state (reload frame, salvo progress, stockpile) is NOT
     * included — it isn't streamed; see `GetUnitWeaponState`. Returns
     * `undefined` if the weapon def isn't cached yet.
     */
    getWeaponDefStats?(weaponDefId: number): WeaponDefStats | undefined;
    /**
     * Active drag-select rectangle for `Spring.GetSelectionBox`, as
     * `[left, top, right, bottom]` in Spring screen coords (device px,
     * Y-up bottom-left origin), or `null` when no box is being drawn.
     * Backed by the worker's `WorkerSelection`. Optional — if absent the
     * API always reports no box.
     */
    getSelectionBox?(): [number, number, number, number] | null;
    /**
     * Per-allyteam radar position-error magnitude (in elmos). Matches
     * `Spring.GetAllyTeamRadarErrorSize`. Server-side this is the
     * baseline `radarErrorSize` multiplied by per-team modifiers; we
     * don't stream the live value yet, so the host returns a constant
     * approximation. Optional — defaults to a hard-coded baseline.
     */
    getAllyTeamRadarErrorSize?(allyTeam: number): number;
    /**
     * Activate a command from the chili integral menu (or any widget
     * calling `Spring.SetActiveCommand`). Build commands (cmdId<0) tell
     * InputManager to enter ground placement for the unit-def `-cmdId`,
     * or — if every selected unit is a factory — to push the build order
     * directly with the queue / count multiplier modifiers. For positive
     * cmdIds that need a world target (move/attack/patrol/guard/…), the
     * host arms a modal command resolved by the next world click; `type`
     * is the Spring `CMDTYPE_*` constant so the host knows whether the
     * target is a ground point, a unit, or either. Instant + state-toggle
     * commands are issued directly via `giveOrder` before reaching here.
     * Optional.
     */
    setActiveCommand?(cmdId: number, mods: { left: boolean; right: boolean; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }, type: number): void;
    /**
     * Play a sound effect. `path` is a VFS-relative game path (e.g.
     * "sounds/weapon/laser/pulse_laser_start.wav"). `pos` is optional —
     * if provided, the sound plays positional through the AudioManager's
     * panner; otherwise it plays as a 2D UI sound. The host resolves the
     * URL against the game's data root.
     *
     * `channel` matches Recoil's `Spring.PlaySoundFile` last-arg
     * convention: `"battle"` / `"sfx"`, `"unitreply"` / `"voice"`,
     * `"userinterface"` / `"ui"`, `"general"` (default), or numeric 1/2/3.
     * Path is also looked up in the SoundItem map for per-item gain /
     * pitch / priority / etc. defaults.
     */
    playSound?(path: string, volume: number,
               pos?: { x: number; y: number; z: number },
               channel?: string | number): void;
    /** Music streaming controls — back PlaySoundStream / StopSoundStream
     *  / PauseSoundStream / SetSoundStreamVolume / GetSoundStreamTime. */
    playMusicStream?(file: string, volume: number, enqueue: boolean): void;
    stopMusicStream?(fadeMs?: number): void;
    pauseMusicStream?(): void;
    setMusicStreamVolume?(v: number): void;
    /** Returns [played, total] in seconds for the BGMusic element. */
    getMusicStreamTime?(): [number, number];
    /** Map reverb — `Spring.SetSoundEffectParams(preset | table)`. */
    setSoundEffectParams?(preset: string | Record<string, unknown>): void;
    /** Per-channel volume bridge — chili epicmenu writes
     *  `snd_volgeneral` etc. via Spring.SendCommands("set ..."). */
    setChannelVolume?(channel: string, volume: number): void;
    /** Master volume bridge — same plumbing for `snd_volmaster`. */
    setMasterVolume?(volume: number): void;
    /**
     * Config store bridge. `Spring.GetConfigInt` / `SetConfigInt` etc.
     * delegate here so the host decides where settings live. The worker
     * routes these through its `storageCache` + `storage:set` bridge to
     * the main-thread `ClientSettings` store (see PLAN-settings.md §2);
     * keys are bare (no `springConfig.` prefix — the host adds it).
     * Reads are synchronous against the worker's local cache. If absent,
     * the API falls back to direct `localStorage` access.
     */
    configGet?(key: string): string | null;
    configSet?(key: string, value: string): void;
    /**
     * Forward a `Spring.SetMiniMapGeometry(x, y, w, h)` call to the host.
     * Coords are in Spring screen-space (Y-up, origin bottom-left, pixels).
     * The host converts to DOM-space and applies it to the native Minimap
     * canvas. Optional — if absent, the API call updates `liveState`
     * only and produces no visible effect.
     */
    setMinimapGeometry?(x: number, y: number, w: number, h: number): void;
    /**
     * Forward a `Spring.MarkerAddPoint` / `Spring.MarkerAddLine`
     * placement to the host so the minimap events layer can pulse a
     * cyan ring at the drop location. The host (lua-widget-manager on
     * the main thread) translates this into `minimap.pushMarkerPing`.
     * Lines emit two pings — one per endpoint — so the bracket dots
     * frame the line on the minimap. Coords are world-space elmos. */
    addMinimapMarker?(x: number, z: number): void;
    /**
     * Forward a `Spring.RequestPath` / `Spring.PathRequest` call to the
     * server. The host hands the request to the connection layer; the
     * server's IPathManager computes the path and replies with a
     * PathResponse routed back through `ingestPathResponse` on the
     * worker. Optional — if absent the API returns nil.
     */
    requestPath?(requestId: number,
                 startX: number, startY: number, startZ: number,
                 endX: number, endY: number, endZ: number,
                 moveType: number, goalRadius: number): void;
    /** Cancel a pending path request (no-op until QTPFS multi-tick
     *  search lands server-side). Optional. */
    cancelPathRequest?(requestId: number): void;
}

/** Static, def-derived weapon state surfaced by `Spring.GetUnitWeaponState`.
 *  Mirrors the subset of Recoil's `CWeapon` fields that are constant for a
 *  given weapon def (the rest — reload frame, salvo progress, stockpile —
 *  are per-unit dynamic state the client doesn't stream). Units match the
 *  Lua API: seconds for times, elmos for ranges, elmos/frame for speed. */
export interface WeaponDefStats {
    /** `range` — max weapon range in elmos. */
    range: number;
    /** `reloadTime` — seconds between shots (Recoil `reload`). */
    reloadTime: number;
    /** `projectileSpeed` — elmos per sim frame. */
    projectileSpeed: number;
    /** `burst` — shots per salvo (Recoil `salvoSize`). */
    salvoSize: number;
    /** `burstRate` — seconds between shots within a salvo (Recoil `salvoDelay`). */
    salvoDelay: number;
    /** `accuracy` — base inaccuracy (no XP bonus modelled). */
    accuracy: number;
    /** `sprayAngle` — base spray angle. */
    sprayAngle: number;
    /** `targetMoveError` — extra inaccuracy against movers. */
    targetMoveError: number;
    /** `ttl` — projectile time-to-live in seconds (Recoil `flighttime`/GAME_SPEED). 0 if none. */
    ttl: number;
}

/** Per-unit entry in the worker's unit store. */
export interface UnitEntry {
    x: number; y: number; z: number;
    heading: number;
    healthRatio: number;
    defId: number;
    team: number;
    /** Build progress 0..1. 1 means the unit has finished construction.
     *  Streamed via FIELD_BUILD_PROGRESS as a u8 (255 = 1.0); the
     *  buildProgress < 1 → >= 1 transition fires UnitFinished. Defaults
     *  to 1 for the rare case where the field is missing from a delta
     *  (the unit was already done at first sight, so no transition to
     *  fire). */
    buildProgress: number;
    /** World-space velocity in elmos/second. Updated by the entityState
     *  handler from frame-to-frame position deltas. Zero on first frame. */
    vx: number; vy: number; vz: number;
    /** Packed state bits from the server (FIELD_STATE_BITS).
     *    bits 0-1: fireState (0=hold, 1=return, 2=at-will)
     *    bits 2-3: moveState (0=hold, 1=maneuver, 2=roam)
     *    bit  4:   repeatOrders
     *    bit  5:   isCloaked
     *    bit  6:   isStunned
     *    bit  7:   alwaysVisible (force-render even with losState=0) */
    stateBits: number;
    /** Spring losStatus low nibble for the local ally team:
     *    bit 0: LOS_INLOS  bit 1: LOS_INRADAR
     *    bit 2: LOS_PREVLOS  bit 3: LOS_CONTRADAR
     *  Own-allyteam units always read 0x0F. */
    losState: number;
}

/** A single live projectile, mirrored from the main-thread
 *  ProjectileRenderer (`live` + `liveBeams`) each render frame. Exposed
 *  to Lua via the `Spring.GetProjectile*` family so ZK's authored
 *  projectile-FX widgets (gfx_projectile_lights.lua, LUPS emitters) run
 *  faithfully against client projectile state — the `mixed`-strategy read
 *  seam from PLAN-weapon-rendering-strategies.md (also the latency-L2
 *  seam). Coords use the same convention as `UnitEntry`; the getters
 *  apply `flipPosZ`/`flipDirZ` exactly like the GetUnit* family. */
export interface ProjectileEntry {
    /** Weapon def id (Recoil's GetProjectileDefID). */
    defId: number;
    x: number; y: number; z: number;
    /** Point projectiles: velocity in elmos/sim-frame (Recoil units).
     *  Beam projectiles: the beam **endpoint delta** (to − from) — what
     *  Recoil's GetProjectileVelocity returns for beam-type projectiles. */
    vx: number; vy: number; vz: number;
    /** Remaining time-to-live in sim frames (Recoil's
     *  GetProjectileTimeToLive). -1 = no fixed lifetime. */
    ttl: number;
    /** True for hit-scan beam projectiles (BeamLaser / LightningCannon). */
    isBeam: boolean;
}

/** Per-team resource entry. All `*Pull/Expense/Share/Sent/Received/Excess`
 *  fields are per-second rates derived from the previous-second
 *  accumulators on the server. They default to 0 when the server hasn't
 *  populated them yet (older servers / first tick). */
export interface ResourceEntry {
    metal: number; maxMetal: number;
    energy: number; maxEnergy: number;
    metalIncome: number; energyIncome: number;
    metalPull: number; energyPull: number;
    metalExpense: number; energyExpense: number;
    metalShare: number; energyShare: number;
    metalSent: number; energySent: number;
    metalReceived: number; energyReceived: number;
    metalExcess: number; energyExcess: number;
}

/** Spring rules-param values are numbers or strings. */
export type RulesParamValue = number | string;

/** Player roster entry. Matches the tuple Spring.GetPlayerInfo returns. */
export interface PlayerInfo {
    name: string;
    active: boolean;
    spectator: boolean;
    team: number;
    allyTeam: number;
    pingMs: number;
    cpuUsage: number;
    country: string;
    rank: number;
    hasController: boolean;
    customKeys: Record<string, string>;
}

/** Team roster entry. Matches Spring.GetTeamInfo. */
export interface TeamInfo {
    teamId: number;
    leader: number;          // playerID of team leader, or -1 for AI/none
    isDead: boolean;
    isAiTeam: boolean;
    side: string;
    allyTeam: number;
    customKeys: Record<string, string>;
}

/** Player/team status event kinds — mirrors PlayerTeamEventItem.kind on the
 *  wire and selects which Recoil LuaUI callin the worker fires. */
export const enum PlayerTeamEventKind {
    PlayerChanged = 0,
    PlayerAdded   = 1,
    PlayerRemoved = 2,
    TeamDied      = 3,
}

/** Apply the roster side-effects of a player/team status event — only the
 *  fields the event lets us derive with certainty, so a widget re-reading
 *  Spring.GetPlayerInfo/GetTeamInfo after the callin sees the change.
 *  Mutates the maps in place. PlayerChanged carries no certain field change
 *  (the new spec/team isn't on the wire — see the worker's KNOWN GAP note),
 *  so it's a no-op here; the callin still fires. */
export function applyPlayerTeamRosterEffect(
    players: Map<number, PlayerInfo>,
    teams: Map<number, TeamInfo>,
    event: { kind: number; id: number },
): void {
    switch (event.kind) {
        case PlayerTeamEventKind.PlayerAdded: {
            const p = players.get(event.id);
            if (p) p.active = true;
            break;
        }
        case PlayerTeamEventKind.PlayerRemoved: {
            const p = players.get(event.id);
            if (p) p.active = false;
            break;
        }
        case PlayerTeamEventKind.TeamDied: {
            const t = teams.get(event.id);
            if (t) t.isDead = true;
            break;
        }
    }
}

/** RGBA in 0..1. */
export type TeamColor = [number, number, number, number];

/** Live game state pushed from the main thread to the worker. */
export interface LiveState {
    camera: { px: number; py: number; pz: number; tx: number; ty: number; tz: number; fov: number; near: number; far: number };
    /** View and projection matrices (column-major Float32Array[16]) for WorldToScreenCoords */
    viewMatrix: Float32Array | null;
    projMatrix: Float32Array | null;
    viewport: { width: number; height: number };
    identity: { myTeam: number; myAllyTeam: number; myPlayerId: number };
    gameFrame: number;
    gameSpeed: number;
    gamePaused: boolean;
    gameOver: boolean;
    /** True when the active game opted into the legacy-LH coord bridge
     *  (PLAN-coordinate-system.md Phase 3). When set, every coord-
     *  touching `Spring.*` / `gl.*` callout mirrors Z (and equivalent
     *  matrix entries) so legacy LH-authored widgets keep working
     *  against the now-RH-native client state. Sourced from the
     *  server's `GameInfo.legacy_coord_system` flag on first arrival. */
    legacyCoordSystem: boolean;
    units: Map<number, UnitEntry>;
    /** Live projectiles + beams, mirrored each frame from the main-thread
     *  ProjectileRenderer. Keyed by projectile id. Drives the
     *  Spring.GetProjectile* read family (A3 / mixed-strategy seam). */
    projectiles: Map<number, ProjectileEntry>;
    resources: Map<number, ResourceEntry>;
    selectedUnitIds: number[];
    /** Modifier key state */
    modKeys: { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean };
    /** Build facing direction (0-3, NESW) */
    buildFacing: number;
    /** Persistent-build spacing in build squares. Q/E in ZK; widget-local
     *  setting persisted across the session. Spring's default is 0
     *  (touching). */
    buildSpacing: number;
    /** Features on the map (static, set once from MapData) */
    features: Map<number, FeatureEntry>;
    /** Game-scoped rules params (Spring.GetGameRulesParam). */
    gameRulesParams: Map<string, RulesParamValue>;
    /** Per-team rules params (Spring.GetTeamRulesParam). */
    teamRulesParams: Map<number, Map<string, RulesParamValue>>;
    /** Per-unit rules params (Spring.GetUnitRulesParam). */
    unitRulesParams: Map<number, Map<string, RulesParamValue>>;
    /** Per-player rules params (Spring.GetPlayerRulesParam). */
    playerRulesParams: Map<number, Map<string, RulesParamValue>>;
    /** Mouse pointer state (canvas pixels, Y-up). outsideSpring is true
     *  when the cursor is over a non-game UI element / off the canvas. */
    mouse: { x: number; y: number; lmb: boolean; mmb: boolean; rmb: boolean; outsideSpring: boolean };
    /** Currently armed command (e.g. cursor in build placement mode).
     *  index is 1-based per Spring (-1 = none); cmdId is the int CMD_*
     *  constant; cmdName is the human-readable name. */
    activeCommand: { index: number; cmdId: number; cmdName: string };
    /** Roster: keyed by playerId. Includes spectators. */
    players: Map<number, PlayerInfo>;
    /** Roster: keyed by teamId. Gaia (id=1 by default) is included. */
    teams: Map<number, TeamInfo>;
    /** Per-team colour. Falls back to a deterministic palette when missing. */
    teamColors: Map<number, TeamColor>;
    /** Mod options dict, free-form key-value. */
    modOptions: Record<string, RulesParamValue>;
    /** Selection groups: Spring numbers them 0..9. Each entry is the
     *  set of unit IDs assigned to that group. Purely client-side state
     *  managed by widgets and the local user. */
    groups: Map<number, Set<number>>;
    /** Map markers (point + line). Local-only for now; broadcasting
     *  needs a server message we don't have yet. */
    markers: Array<{ kind: 'point' | 'line'; x: number; y: number; z: number;
        x2?: number; y2?: number; z2?: number; label: string; teamId: number }>;
    /** Current wind vector (elmos/sec) + magnitude + tidal multiplier.
     *  Refreshed every GameInfo broadcast (~1 Hz). */
    wind: { x: number; y: number; z: number; strength: number; tidal: number };
    /** Per-unit order queue, keyed by unit id. Server broadcasts a full
     *  snapshot at ~1 Hz; absence of a unit means an empty queue. */
    unitCommands: Map<number, UnitOrder[]>;
    /** Per-unit available command descriptors, keyed by unit id.
     *  Server streams the build (cmdId<0) entries at ~1 Hz; standing-
     *  order toggles are derived client-side from the CMD_* enum and
     *  added by Spring.GetUnitCmdDescs at read time. Absence of a
     *  unit means empty / unknown. */
    unitCmdDescs: Map<number, UnitCmdDescStored[]>;
    /** Action bindings keyed by canonical keyset string ("any+x",
     *  "c+s+f1", "x"). Populated by Spring.SendCommands("bind ...")
     *  calls — ZK's epic-menu loads zk_keys.lua at startup and pushes
     *  every default through that path. Spring.GetKeyBindings reads
     *  this table during action dispatch (cawidgets actionHandler
     *  falls back to it when the engine doesn't ship an `actions`
     *  list with the keypress). Each entry is an array because a
     *  keyset can fire multiple actions in registration order. */
    keyBinds: Map<string, Array<{ cmd: string; extra: string }>>;
    /** Per-allyteam fog-of-war bitmap. Three bit-packed planes
     *  (in-LOS / in-radar+air / explored), arriving ~1 Hz from the
     *  server. `Spring.IsPosInLos / IsPosInRadar / IsPosInAirLos`
     *  sample this; the renderer / minimap use it for fog overlay.
     *  Indexed by ally team id. */
    losBitmaps: Map<number, LosBitmapState>;
    /** Minimap rect in **Spring screen-space** (Y-up, origin at the
     *  bottom-left of the viewport, pixels). Set by widget calls to
     *  `gl.ConfigMiniMap` / `Spring.SetMiniMapGeometry`. `visible`
     *  tracks whether the widget left the canvas drawable this frame
     *  — a chili minimap collapsing the frame issues a `(0,0,0,0)`
     *  config to suppress hit-testing. `undefined` means no widget
     *  has claimed the minimap yet (the native fixed-corner default
     *  applies). */
    minimapGeometry: { x: number; y: number; width: number; height: number; visible: boolean } | undefined;
    /** Per-unit sensor radius override. Populated when an
     *  `EntitySensorUpdate` envelope arrives from the server (emitted by
     *  `Spring.SetUnitSensorRadius` server-side). Outer key is unitID,
     *  inner key is the sensor type string ("los"/"airLos"/"radar"/
     *  "sonar"/"seismic"/"radarJammer"/"sonarJammer"). When present,
     *  `Spring.GetUnitSensorRadius` returns this value in preference to
     *  the UnitDef baseline so widgets such as `unit_stealth.lua` see
     *  the change immediately. */
    sensorOverrides: Map<number, Map<string, number>>;
    /** Default-command snapshot for the unit/feature currently under the
     *  cursor. Main thread runs the hover hit-test and pushes the (target,
     *  engineCmd) pair to the worker; the worker dispatches
     *  widget:DefaultCommand and stores any override here. Read by
     *  `Spring.GetDefaultCommand`. `cmdId == 0` means "no override —
     *  engineCmd applies"; `cmdId < 0` is the same negative-builds-as-IDs
     *  convention used elsewhere. */
    defaultCommand: {
        targetType: 'unit' | 'feature' | null;
        targetId: number;
        /** What Spring would issue absent a widget override (MOVE / GUARD /
         *  ATTACK / RECLAIM). Server-equivalent of CGuiHandler::GetDefaultCommand. */
        engineCmd: number;
        /** Final cmdId after widget DefaultCommand callins ran. Equals
         *  engineCmd when no widget overrode. */
        cmdId: number;
    };
    /** Per-transporter cargo list. Keyed by transporter unit id, value
     *  is an ordered list of cargo unit ids. Read by Spring.GetUnitIsTransporting.
     *  Absence means "no cargo" (or "unit isn't a transporter at all"). */
    transportCargo: Map<number, number[]>;
    /** Reverse index: cargo unit id → its current transporter id. Read
     *  by Spring.GetUnitTransporter. Absence means "not being transported". */
    transportCarrier: Map<number, number>;
    /** Self-destruct countdown in game-seconds, keyed by unit id.
     *  Absence means "no active countdown". Read by Spring.GetUnitSelfDTime. */
    selfDCountdown: Map<number, number>;
    /** Stockpile weapon state keyed by unit id. Absence means
     *  "no stockpile weapon, or zero state". Read by Spring.GetUnitStockpile. */
    stockpileState: Map<number, { ready: number; queued: number; buildPercent: number }>;
    /** Armored toggle state keyed by unit id. Absence means the default
     *  non-armored state (armored=false, armoredMultiple=1.0). Read by
     *  Spring.GetUnitArmored. */
    armoredState: Map<number, { armored: boolean; armoredMultiple: number }>;
    /** In-flight `Spring.RequestPath` results, keyed by client-assigned
     *  request id. Each entry is the full waypoint list returned by the
     *  server (empty if the path manager couldn't find a route) plus
     *  the total path length in elmos. Entries arrive asynchronously
     *  via the `pathResponse` postMessage; the path proxy returned by
     *  `Spring.RequestPath` reads from here on every method call. The
     *  proxy's `__gc` (and the explicit `Spring.DeletePath`) clears
     *  the entry. */
    pathResponses: Map<number, { waypoints: Array<[number, number, number]>; length: number }>;
    /** Monotonic counter for client-assigned path request ids. Starts at
     *  1 because a `tag = 0` reservation sentinel is used elsewhere in
     *  the protocol; we keep request ids in the same positive-only
     *  space for consistency. */
    nextPathRequestId: number;
    /** Most recent standing-order snapshot from the server, keyed by
     *  order id. Updated wholesale on every `StandingOrderState` push —
     *  no merging is needed because the server sends the full visible
     *  set on every state change. Read by `Spring.GetStandingOrders`. */
    standingOrders: Map<number, StandingOrderEntry>;
    /** Set of unit ids for which the server has already fired
     *  `UnitLifecycleKind.Created` this game. The entity-stream
     *  first-visibility synthesis path checks this set to avoid double
     *  firing `widgetHandler:UnitCreated` for own + allied units. Once
     *  added an id is never removed (`UnitDestroyed` clears it). */
    serverFiredUnitCreated: Set<number>;
    /** Allied-team entity-stream appearances waiting one tick for a
     *  server-side `UnitLifecycleKind.Created` event. Maps unit id to
     *  the synthesised event payload; flushed on the next entity-state
     *  tick if the server event still hasn't arrived. Enemy units
     *  bypass this map and fire immediately. */
    pendingSynthCreated: Map<number, { defId: number; team: number }>;
    /** Team start positions keyed by teamId (RH-canonical elmos). Sent by
     *  the server on auth and re-broadcast after GameStart. Read by
     *  `Spring.GetTeamStartPosition`. Absence means "unknown team". */
    teamStartPositions: Map<number, { x: number; y: number; z: number; valid: boolean; allyTeam: number }>;
    /** Ally team start boxes keyed by allyTeamId (elmos). Defaults to the
     *  full map when the game sets no boxes. Read by
     *  `Spring.GetAllyTeamStartBox`. */
    allyStartBoxes: Map<number, { xmin: number; zmin: number; xmax: number; zmax: number }>;
    /** Per-team statistics history keyed by teamId, mirroring the server's
     *  `CTeam::statHistory` (a new entry every 15 game-seconds; the final
     *  element is the live, still-accumulating tail). Streamed incrementally
     *  via TeamStatsHistoryBatch and read by `Spring.GetTeamStatsHistory`. */
    teamStatsHistory: Map<number, TeamStatsHistoryEntry[]>;
}

/** One team-statistics history entry. Field names/units match the Lua table
 *  `Spring.GetTeamStatsHistory` returns (sans the derived `time`/`frame`
 *  overrides the read applies). Mirrors Recoil's `TeamStatistics`. */
export interface TeamStatsHistoryEntry {
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

/** Per-order entry mirrored into LiveState.standingOrders. Mirrors
 *  `StandingOrderInfoMsg` in connection.ts. */
export interface StandingOrderConditionsEntry {
    idleOnly: boolean;
    squadTypes: number[];
    withinCenter: readonly [number, number, number];
    withinRadius: number;
    outsideCenter: readonly [number, number, number];
    outsideRadius: number;
    minStrength: number;
    hasCapabilities: string[];
}

export interface StandingOrderEntry {
    orderId: number;
    ownerTeam: number;
    type: string;
    priority: number;
    params: number[];
    conditions: StandingOrderConditionsEntry;
    assignedSquadCount: number;
    active: boolean;
    createdAtFrame: number;
    expiresAtFrame: number;
}

/** Stored LOS bitmap snapshot inside `LiveState`. Mirrors `LosBitmap`
 *  on the main thread but lives in worker memory. Bit-packed planes,
 *  MSB-first per byte. */
export interface LosBitmapState {
    width: number;
    height: number;
    frame: number;
    inLos: Uint8Array;
    inRadar: Uint8Array;
    explored: Uint8Array;
}

/** One entry from a unit's command panel as streamed by the server. */
export interface UnitCmdDescStored {
    /** Spring command id. Negative = build command (-cmdId is the unit-def id). */
    cmdId: number;
    /** Greyed-out flag (insufficient resources, tech, etc.). */
    disabled: boolean;
    /** Display name shown on the button ("Move", "Attack", or build name). */
    name: string;
    /** Action binding name ("move", "areaattack", "buildunit_armcom"). */
    action: string;
    /** Texture / icon path. May be a #-prefixed atlas key. */
    texture: string;
    /** Tooltip body (may contain Spring markup). */
    tooltip: string;
    /** CMDTYPE_* constant. 0=ICON, 5=ICON_MODE, 10=ICON_MAP, etc. */
    type: number;
    /** Mode-specific param strings. For CMDTYPE_ICON_MODE, params[0] is
     *  the current state index ("0"/"1"/"2"), params[1..n] are the
     *  human labels ("Hold fire"/"Return fire"/"Fire at will"). */
    params: string[];
    /** True if hidden from the command panel. */
    hidden: boolean;
}

/** One queued order — mirrors Spring's Command struct. */
export interface UnitOrder {
    cmdId: number;
    params: number[];
    options: number;
    tag: number;
    timeout: number;
}

/** Per-feature entry. */
export interface FeatureEntry {
    x: number; y: number; z: number;
    defId: number;
    team: number;
    healthRatio: number;
}

/**
 * Convert Spring-style asset paths (":a:LuaUI\Images\foo.png") into
 * clean forward-slash paths ("LuaUI/Images/foo.png"). Also handles
 * plain backslash paths.
 */
// ────────────────────────────────────────────────────────────────────
// Config store + audio-key side-effects
// ────────────────────────────────────────────────────────────────────
//
// Spring.GetConfigInt / SetConfigInt persist across sessions. The store
// itself lives on the main thread (ClientSettings, see PLAN-settings.md);
// this code runs in the widget worker, which has no localStorage, so it
// delegates through `ctx.configGet/configSet` — wired by the worker host
// to its `storageCache` + `storage:set` bridge. The host owns the
// `springConfig.` key prefix. The direct-localStorage path is only a
// fallback for hosts that don't supply the hooks.
//
// The `snd_vol*` family additionally fires a side-effect that pushes the
// value into AudioManager via the host context, so chili's epicmenu
// trackbars work end-to-end without source patches.

function readConfigStore(ctx: SpringAPIContext, key: string): string | null {
    if (ctx.configGet) return ctx.configGet(key);
    try { return localStorage.getItem('springConfig.' + key); }
    catch { return null; }
}

function writeConfigStore(ctx: SpringAPIContext, key: string, value: string): void {
    if (ctx.configSet) { ctx.configSet(key, value); return; }
    try { localStorage.setItem('springConfig.' + key, value); }
    catch { /* silent */ }
}

// Engine graphics console verbs → ClientSettings config keys. ZK's
// epicmenu fires the verb (e.g. `grounddecals 0`) in lockstep with the
// `springsetting` write; we map it to the same config key the menu's
// springsetting uses, so either path lands in the same store. The native
// effect is applied by a main-thread subscriber (PLAN-settings.md §4).
const ENGINE_GRAPHICS_VERBS: Record<string, string> = {
    'grounddecals':    'GroundDecals',
    'maxparticles':    'MaxParticles',
    'distdraw':        'UnitLodDist',
    'disticon':        'UnitIconDist',
    'advmodelshading': 'AdvUnitShading',
};

const VOLUME_CONFIG_KEYS: Record<string, string> = {
    'snd_volmaster':     'master',
    'snd_volgeneral':    'General',
    'snd_volbattle':     'Battle',
    'snd_volunitreply':  'UnitReply',
    'snd_volui':         'UserInterface',
    'snd_volmusic':      'BGMusic',
};

function applyConfigSideEffect(ctx: SpringAPIContext,
                                key: string, value: number): void {
    const target = VOLUME_CONFIG_KEYS[key.toLowerCase()];
    if (!target) return;
    // Range: chili stores integers 0..100; AudioManager takes 0..1.
    const normalised = Math.max(0, Math.min(1, value / 100));
    if (target === 'master') {
        ctx.setMasterVolume?.(normalised);
    } else {
        ctx.setChannelVolume?.(target, normalised);
    }
}

export function normaliseSpringPath(path: string): string {
    let p = path;
    // Strip VFS mode prefix: `:a:`, `:r:`, `:s:` etc.
    if (p.startsWith(':') && p.length >= 3 && p[2] === ':') {
        p = p.substring(3);
    }
    // Spring uses backslashes in source even on Linux.
    p = p.replace(/\\/g, '/');
    // Strip any leading slash.
    if (p.startsWith('/')) p = p.substring(1);
    return p;
}

/** Spring command-option bit flags. Widgets pass options either as a
 *  number (raw bitfield) or as a table — sometimes a sequence of
 *  strings (`{"shift", "alt"}`) and sometimes a map (`{shift=true}`).
 *  We accept all three. */
const ORDER_OPT_META  = 4;
const ORDER_OPT_RIGHT = 16;
const ORDER_OPT_SHIFT = 32;
const ORDER_OPT_CTRL  = 64;
const ORDER_OPT_ALT   = 128;

function orderOptionsToBits(opts: LuaValue): number {
    if (opts == null) return 0;
    if (typeof opts === 'number') return opts | 0;
    if (typeof opts !== 'object') return 0;
    const apply = (key: string): number => {
        switch (key.toLowerCase()) {
            case 'shift': return ORDER_OPT_SHIFT;
            case 'alt':   return ORDER_OPT_ALT;
            case 'ctrl':  return ORDER_OPT_CTRL;
            case 'meta':  return ORDER_OPT_META;
            case 'right': return ORDER_OPT_RIGHT;
            default:      return 0;
        }
    };
    let bits = 0;
    if (Array.isArray(opts)) {
        for (const v of opts) {
            if (typeof v === 'string') bits |= apply(v);
        }
    } else {
        for (const [k, v] of Object.entries(opts as Record<string, LuaValue>)) {
            if (v) bits |= apply(k);
        }
    }
    return bits;
}

/** Coerce the params arg to a flat number[]. Spring widgets pass a
 *  sequence (`{x, y, z}`) — we tolerate single numbers and missing
 *  values too. */
function orderParamsToArray(params: LuaValue): number[] {
    if (params == null) return [];
    if (typeof params === 'number') return [params];
    if (Array.isArray(params)) {
        const out: number[] = [];
        for (const v of params) {
            const n = Number(v);
            if (Number.isFinite(n)) out.push(n);
        }
        return out;
    }
    return [];
}

/** Coerce a Lua array of unit ids to number[]. */
function orderUnitIdsToArray(ids: LuaValue): number[] {
    if (ids == null) return [];
    if (typeof ids === 'number') return [ids | 0];
    if (Array.isArray(ids)) {
        const out: number[] = [];
        for (const v of ids) {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) out.push(n | 0);
        }
        return out;
    }
    return [];
}

/** Extract numeric unit ids from the keys of a Spring unit map (the
 *  `{[unitID] = anything}` shape used by Spring.SelectUnitMap and
 *  similar). Drops keys that aren't positive integers. */
function mapKeysToUnitIds(unitMap: LuaValue): number[] {
    if (unitMap == null || typeof unitMap !== 'object') return [];
    const out: number[] = [];
    // Lua sequences round-trip to JS arrays; treat their indexes as
    // unit ids the same as orderUnitIdsToArray would.
    if (Array.isArray(unitMap)) {
        for (let i = 0; i < unitMap.length; i++) {
            // Only include slots whose value is truthy — Spring's
            // unitMap convention is `{[unitID] = true}`. A nil value
            // means "not selected".
            if (unitMap[i]) {
                const id = i + 1; // sequence is 1-based in Lua
                if (id > 0) out.push(id | 0);
            }
        }
        return out;
    }
    for (const k of Object.keys(unitMap)) {
        const v = (unitMap as Record<string, LuaValue>)[k];
        if (!v) continue;
        const n = Number(k);
        if (Number.isFinite(n) && n > 0) out.push(n | 0);
    }
    return out;
}

/** Compute the new selection list for a Spring.Select* call and push it
 *  to both the local LiveState mirror and the host (InputManager).
 *  When `append` is true, ids are merged into the existing selection;
 *  otherwise they replace it. Duplicates are stripped while preserving
 *  insertion order (Spring's selection is order-stable). */
function applySelection(ls: LiveState, ctx: SpringAPIContext, ids: number[], append: boolean): void {
    const seen = new Set<number>();
    const next: number[] = [];
    if (append) {
        for (const id of ls.selectedUnitIds) {
            if (id > 0 && !seen.has(id)) { seen.add(id); next.push(id); }
        }
    }
    for (const id of ids) {
        if (id > 0 && !seen.has(id)) { seen.add(id); next.push(id); }
    }
    ls.selectedUnitIds = next;
    ctx.setSelection?.(next.slice());
}

/** Convert a worker-side order queue into the array Spring widgets
 *  expect: each entry is a keyed table with id/params/options/tag/timeout.
 *  `count` optionally caps the number of orders returned (default: all). */
function ordersToLuaArray(orders: UnitOrder[] | undefined, count?: LuaValue): LuaValue {
    if (!orders) return luaTable();
    const cap = count != null ? Number(count) : orders.length;
    const limit = Math.max(0, Math.min(orders.length, cap));
    const result: Array<Record<string, LuaValue>> = [];
    for (let i = 0; i < limit; i++) {
        const o = orders[i];
        result.push({
            id: o.cmdId,
            params: [...o.params],
            options: o.options,
            tag: o.tag,
            timeout: o.timeout,
        });
    }
    return result;
}

/** Canonicalise a Spring keyset string for storage / lookup. Accepts
 *  "any+x", "Any+X", "ctrl+shift+f1", "C+S+f1", "S+x" and produces a
 *  lowercase form with single-letter modifiers in `acms` order, or
 *  `any+<key>` for the special "any modifier" form ZK uses heavily.
 *  An empty / nameless input returns `""`. */
function canonicalKeySet(input: string): string {
    const parts = input.toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return '';
    const key = parts.pop() as string;
    const mods = new Set<string>();
    for (const p of parts) {
        if (p === 'a' || p === 'alt') mods.add('a');
        else if (p === 'c' || p === 'ctrl' || p === 'control') mods.add('c');
        else if (p === 'm' || p === 'meta') mods.add('m');
        else if (p === 's' || p === 'shift') mods.add('s');
        else if (p === 'any') mods.add('any');
    }
    if (mods.has('any')) return `any+${key}`;
    let prefix = '';
    if (mods.has('a')) prefix += 'a+';
    if (mods.has('c')) prefix += 'c+';
    if (mods.has('m')) prefix += 'm+';
    if (mods.has('s')) prefix += 's+';
    return prefix + key;
}

/** Map a Spring/SDL keycode (as produced by `springKeyCode` in
 *  lua-widget-manager) back to its canonical lowercase symbol name —
 *  the inverse of GetKeyCode. Letters fall through `String.fromCharCode`
 *  since springKeyCode emits `e.key.toLowerCase().charCodeAt(0)` for
 *  printable ASCII, so the round-trip is symmetric. */
function keyCodeToSymbol(code: number): string {
    const named: Record<number, string> = {
        8: 'backspace', 9: 'tab', 13: 'enter', 27: 'escape', 32: 'space',
        127: 'delete',
        273: 'up', 274: 'down', 275: 'right', 276: 'left',
        277: 'insert', 278: 'home', 279: 'end',
        280: 'pageup', 281: 'pagedown',
        282: 'f1', 283: 'f2', 284: 'f3', 285: 'f4', 286: 'f5',
        287: 'f6', 288: 'f7', 289: 'f8', 290: 'f9', 291: 'f10',
        292: 'f11', 293: 'f12',
        303: 'right_shift', 304: 'shift',
        305: 'right_ctrl',  306: 'ctrl',
        307: 'right_alt',   308: 'alt',
        309: 'right_meta',  310: 'meta',
    };
    if (named[code]) return named[code];
    if (code >= 32 && code <= 126) return String.fromCharCode(code);
    return '';
}

/** Deterministic fallback palette when no per-team colour is known.
 *  Cycles through eight distinct hues so widgets don't render every
 *  team blue when roster data hasn't arrived yet. */
function defaultTeamColor(teamId: number): TeamColor {
    const palette: TeamColor[] = [
        [0.20, 0.40, 1.00, 1], // blue
        [1.00, 0.30, 0.30, 1], // red
        [0.30, 0.85, 0.30, 1], // green
        [1.00, 0.85, 0.20, 1], // yellow
        [0.85, 0.40, 0.95, 1], // purple
        [0.20, 0.85, 0.85, 1], // cyan
        [1.00, 0.55, 0.20, 1], // orange
        [0.55, 0.55, 0.55, 1], // grey (gaia by convention)
    ];
    return palette[((teamId % palette.length) + palette.length) % palette.length];
}

/**
 * Convert a rules-params Map into a Lua table. Spring's plural getters
 * (GetGameRulesParams, GetUnitRulesParams, …) return a single table
 * keyed by param name. An undefined input (e.g. unit/team has no entry)
 * still returns an empty table — widgets iterate the result with pairs()
 * and would throw if it were nil.
 */
function rulesParamsToTable(params: Map<string, RulesParamValue> | undefined): Record<string, RulesParamValue> {
    const out: Record<string, RulesParamValue> = {};
    if (params) {
        for (const [k, v] of params) out[k] = v;
    }
    return out;
}

/**
 * Faithful port of Recoil's `Spring.DiffTimers` (LuaUnsyncedRead::DiffTimers).
 *
 * Recoil's timers are opaque light-userdata wrapping an integer time-point in
 * either milliseconds (`GetTimer`) or microseconds (`GetTimerMicros`). We can't
 * push light userdata through Fengari cheaply, so the timer *handle* is a plain
 * number carrying the same raw count — `GetTimer()` → ms, `GetTimerMicros()` →
 * µs. This helper reproduces the engine's unit conversion exactly:
 *   - `fromMicroSecs` selects how the raw `t1 - t2` delta is interpreted.
 *   - `returnMs` selects the result unit (milliseconds vs seconds).
 * Default (both false) returns the elapsed time in **seconds**, matching Recoil.
 */
export function diffTimers(t1: number, t2: number, returnMs: boolean, fromMicroSecs: boolean): number {
    const raw = t1 - t2; // most-recent minus start
    if (fromMicroSecs) {
        // delta is in microseconds
        return returnMs ? raw / 1e3 : raw / 1e6;
    }
    // delta is in milliseconds
    return returnMs ? raw : raw / 1e3;
}

/** Create a default LiveState with zeroed values. */
export function createDefaultLiveState(): LiveState {
    return {
        camera: { px: 0, py: 500, pz: 0, tx: 0, ty: 0, tz: 0, fov: 0.8, near: 1, far: 50000 },
        viewMatrix: null,
        projMatrix: null,
        viewport: { width: 1920, height: 1080 },
        identity: { myTeam: 0, myAllyTeam: 0, myPlayerId: 0 },
        gameFrame: 0,
        gameSpeed: 1,
        gamePaused: false,
        gameOver: false,
        legacyCoordSystem: false,
        units: new Map(),
        projectiles: new Map(),
        resources: new Map(),
        selectedUnitIds: [],
        modKeys: { alt: false, ctrl: false, meta: false, shift: false },
        buildFacing: 0,
        buildSpacing: 0,
        features: new Map(),
        gameRulesParams: new Map(),
        teamRulesParams: new Map(),
        unitRulesParams: new Map(),
        playerRulesParams: new Map(),
        mouse: { x: 0, y: 0, lmb: false, mmb: false, rmb: false, outsideSpring: true },
        activeCommand: { index: -1, cmdId: 0, cmdName: '' },
        players: new Map(),
        teams: new Map(),
        teamColors: new Map(),
        modOptions: {},
        groups: new Map(),
        markers: [],
        wind: { x: 0, y: 0, z: 0, strength: 0, tidal: 0 },
        unitCommands: new Map(),
        unitCmdDescs: new Map(),
        keyBinds: new Map(),
        losBitmaps: new Map(),
        minimapGeometry: undefined,
        sensorOverrides: new Map(),
        defaultCommand: { targetType: null, targetId: 0, engineCmd: 10 /* CMD_MOVE */, cmdId: 10 },
        transportCargo: new Map(),
        transportCarrier: new Map(),
        selfDCountdown: new Map(),
        stockpileState: new Map(),
        armoredState: new Map(),
        pathResponses: new Map(),
        nextPathRequestId: 1,
        standingOrders: new Map(),
        serverFiredUnitCreated: new Set(),
        pendingSynthCreated: new Map(),
        teamStartPositions: new Map(),
        allyStartBoxes: new Map(),
        teamStatsHistory: new Map(),
    };
}

/** Build the global-table set a Lua widget needs. */
export function buildSpringGlobals(ctx: SpringAPIContext, liveState?: LiveState): Record<string, LuaValue> {
    const ls = liveState ?? createDefaultLiveState();
    // PLAN-coordinate-system Option A legacy-LH bridge. Direction-vector
    // Z components mirror at every callout that exchanges them with
    // legacy widgets (`flipDirZ`). World *positions* stay in [0, mapZ]
    // in both LH and RH frames — Spring's spatial bins index that range
    // regardless of handedness, and the camera "up" vector is what makes
    // "+Z = north = screen-top" visually consistent. `flipPosZ` is a
    // no-op kept at every position-scalar callsite for explicit
    // intent (position vs direction classification) and zero-cost.
    // The closure reads `ls.legacyCoordSystem` on every call, so the
    // flag can flip in (delivered via the first GameInfo broadcast)
    // without rebuilding the globals table.
    const flipDirZ = (z: number): number => (ls.legacyCoordSystem ? -z : z);
    const flipPosZ = (z: number): number => z;
    // --- GL constants table. Only the values lava_layer touches. ---
    const GL: Record<string, LuaValue> = {
        // Draw primitives
        TRIANGLES: 0x0004,
        TRIANGLE_STRIP: 0x0005,
        TRIANGLE_FAN: 0x0006,
        QUADS: 0x0007,
        LINES: 0x0001,
        LINE_LOOP: 0x0002,
        LINE_STRIP: 0x0003,
        POINTS: 0x0000,
        // Blend factors
        ZERO: 0x0000,
        ONE: 0x0001,
        SRC_ALPHA: 0x0302,
        ONE_MINUS_SRC_ALPHA: 0x0303,
        DST_ALPHA: 0x0304,
        ONE_MINUS_DST_ALPHA: 0x0305,
        SRC_COLOR: 0x0300,
        ONE_MINUS_SRC_COLOR: 0x0301,
        DST_COLOR: 0x0306,
        ONE_MINUS_DST_COLOR: 0x0307,
        // Clear bits
        COLOR_BUFFER_BIT: 0x00004000,
        DEPTH_BUFFER_BIT: 0x00000100,
        STENCIL_BUFFER_BIT: 0x00000400,
        // Attrib bits (Spring passes these to gl.PushAttrib — we mostly ignore)
        ALL_ATTRIB_BITS: 0xFFFFFFFF,
        CURRENT_BIT: 0x00000001,
        ENABLE_BIT: 0x00002000,
        COLOR_BUFFER_BIT_A: 0x00004000,
        // Matrix modes
        PROJECTION: 0x1701,
        MODELVIEW: 0x1700,
        TEXTURE_MATRIX: 0x1702,
        // Texture formats
        RGBA: 0x1908,
        RGB: 0x1907,
        LUMINANCE: 0x1909,
        ALPHA: 0x1906,
        // Texture filters
        NEAREST: 0x2600,
        LINEAR: 0x2601,
        NEAREST_MIPMAP_NEAREST: 0x2700,
        LINEAR_MIPMAP_NEAREST: 0x2701,
        LINEAR_MIPMAP_LINEAR: 0x2703,
        // Wrap modes
        CLAMP_TO_EDGE: 0x812F,
        CLAMP: 0x2900,
        REPEAT: 0x2901,
        MIRRORED_REPEAT: 0x8370,
        // Comparison functions (stencil, depth, alpha)
        NEVER: 0x0200,
        LESS: 0x0201,
        EQUAL: 0x0202,
        LEQUAL: 0x0203,
        GREATER: 0x0204,
        NOTEQUAL: 0x0205,
        GEQUAL: 0x0206,
        ALWAYS: 0x0207,
        // Stencil operations
        KEEP: 0x1E00,
        REPLACE: 0x1E01,
        INCR: 0x1E02,
        DECR: 0x1E03,
        INVERT: 0x150A,
        INCR_WRAP: 0x8507,
        DECR_WRAP: 0x8508,
        // Polygon mode (not supported in WebGL but needed as constants)
        POINT: 0x1B00,
        LINE: 0x1B01,
        FILL: 0x1B02,
        FRONT: 0x0404,
        BACK: 0x0405,
        FRONT_AND_BACK: 0x0408,
        // Internal formats for RBO
        DEPTH24_STENCIL8: 0x88F0,
        DEPTH_COMPONENT16: 0x81A5,
        DEPTH_COMPONENT24: 0x81A6,
        DEPTH_COMPONENT32F: 0x8CAC,
    };

    // --- Game table: static map/game constants. ---
    //
    // Spring exposes two flavours of map size:
    //   mapSizeX / mapSizeZ — world coordinates in elmos (1 square = 8 elmos)
    //   mapX    / mapY     — heightmap grid squares (mapSizeX/8)
    // Widgets use either depending on purpose; provide both so neither
    // tries to arithmetic on nil.
    const squareSize = ctx.squareSize || 8;
    const Game: Record<string, LuaValue> = {
        mapSizeX: ctx.mapSizeX,
        mapSizeZ: ctx.mapSizeZ,
        mapSizeY: ctx.mapSizeZ, // Spring uses Z for depth; some scripts use Y
        mapX: Math.floor(ctx.mapSizeX / squareSize),
        mapY: Math.floor(ctx.mapSizeZ / squareSize),
        squareSize: squareSize,
        gameSpeed: 30,
        // Map physics — from mapdefaults.lua; epicmenu reads these
        gravity: 130 * 900,     // 130 elmo/s² × (30 frames/s)²
        waterDamage: 0,
        tidal: 0,
        mapDescription: '',
        extractorRadius: 0,
        maxUnits: 5000,
        // Game metadata — populated from the lobby's /api/games discovery
        // (which reads the game's modinfo). Falls back to gameId, never a
        // hardcoded game name (see PLAN-bar.md A3).
        modName: ctx.modName || ctx.gameId || '',
        modShortName: ctx.modShortName || (ctx.gameId ? ctx.gameId.toUpperCase() : ''),
        modDesc: ctx.modDesc || '',
        modVersion: ctx.modVersion || '',
        gameName: ctx.modName || ctx.gameId || '',
        gameVersion: ctx.modVersion || '',
        mapName: '',
        mapHumanName: '',
        // Armor types — indexed array; widgets use this to build damage tables
        armorTypes: { 0: 'default' },
    };

    // --- VFS mode constants ---
    //
    // Spring's VFS functions take an optional mode argument that picks
    // which archive layer(s) to search. Real Spring uses bitmasks; we
    // just export distinct sentinel numbers because our VFS is a flat
    // pre-fetched map that doesn't honour layering yet. Widgets that
    // pass these as an argument get back whatever we have.
    const VFS_MODES: Record<string, number> = {
        RAW_ONLY:  1,
        ZIP_ONLY:  2,
        RAW_FIRST: 3,
        ZIP_FIRST: 4,
        ZIP:       5,
        RAW:       6,
        MAP:       7,
        GAME:      8,
        BASE:      9,
        MENU:      10,
        DEF_MODE:  5,
    };

    // --- VFS table. Synchronous Include backed by pre-fetched cache. ---
    // Spring's VFS.Include returns the chunk's return value. Many mapinfo.lua
    // files end with `return mapinfo` so we have to execute and capture the
    // final return. We do that by loading the source into the *same* Lua
    // state that called Include — but since we only have access to the JS
    // layer here, we use a fresh sub-runtime. For mapinfo.lua specifically,
    // that's fine: it's side-effect free and returns a pure table.
    //
    // NOTE: circular includes are possible if a file includes itself via a
    // different path. We don't guard against this yet.
    const VFS: Record<string, LuaValue> = {
        ...VFS_MODES,
        Include: (path: LuaValue) => {
            const normalised = normaliseSpringPath(String(path));
            const source = ctx.vfsFiles.get(normalised);
            if (!source) {
                console.warn(`[VFS] Include missing: ${normalised}`);
                return null;
            }
            // Execute the chunk in a fresh sub-runtime to capture return value.
            // This is inefficient for frequent calls but acceptable for the
            // one-time mapinfo.lua include in widget init.
            return includeLuaFile(source, normalised, ctx);
        },
        FileExists: (path: LuaValue) => {
            return ctx.vfsFiles.has(normaliseSpringPath(String(path)));
        },
        LoadFile: (path: LuaValue) => {
            return ctx.vfsFiles.get(normaliseSpringPath(String(path))) ?? null;
        },
        DirList: (_path: LuaValue, _pattern: LuaValue, _mode: LuaValue) => {
            // Stub — returns empty table
            return [];
        },
    };

    // --- Spring table: per-call query functions. ---
    const Spring: Record<string, LuaValue> = {
        GetGameSeconds: () => ls.gameFrame / 30,
        GetGameFrame: () => ls.gameFrame,
        GetWind: () => {
            // Spring returns 7 values: wx, wy, wz, wStrength, dx, dy, dz
            // where (wx,wy,wz) is the wind vector and (dx,dy,dz) is its
            // unit-length direction.
            const w = ls.wind;
            const inv = w.strength > 1e-6 ? 1 / w.strength : 0;
            return [w.x, w.y, w.z, w.strength, w.x * inv, w.y * inv, w.z * inv];
        },
        GetTidal: () => ls.wind.tidal,
        GetGroundHeight: (x: LuaValue, z: LuaValue) => {
            return sampleHeight(ctx, Number(x), flipPosZ(Number(z)));
        },
        GetGroundOrigHeight: (x: LuaValue, z: LuaValue) => {
            return sampleHeight(ctx, Number(x), flipPosZ(Number(z)));
        },
        GetGameRulesParam: (key: LuaValue) => {
            const k = String(key);
            const v = ls.gameRulesParams.get(k);
            if (v !== undefined) return v;
            return ctx.gameRulesParams?.get(k) ?? null;
        },
        GetGameRulesParams: () => rulesParamsToTable(ls.gameRulesParams),
        Echo: (...args: LuaValue[]) => {
            console.log('[Spring.Echo]', ...args.map(a => String(a)));
        },
        // Spring.SendCommands(line[, line, ...]) — Spring's batch console
        // entrypoint. The only forms we currently care about are the
        // bind / unbind / unbindaction triplet; ZK's epic-menu pushes
        // every default keybind through here at startup. Other console
        // verbs (e.g. "togglecammode") are dropped — they have no
        // browser-side equivalent.
        SendCommands: (...args: LuaValue[]) => {
            const apply = (raw: string) => {
                const line = raw.trim();
                if (!line) return;
                const space = line.indexOf(' ');
                if (space < 0) return;
                const verb = line.slice(0, space).toLowerCase();
                const rest = line.slice(space + 1).trim();
                if (verb === 'bind') {
                    const sp = rest.indexOf(' ');
                    if (sp < 0) return;
                    const keyset = canonicalKeySet(rest.slice(0, sp));
                    if (!keyset) return;
                    const tail = rest.slice(sp + 1).trim();
                    const sp2 = tail.indexOf(' ');
                    const cmd = (sp2 < 0 ? tail : tail.slice(0, sp2)).toLowerCase();
                    const extra = sp2 < 0 ? '' : tail.slice(sp2 + 1).trim();
                    if (!cmd) return;
                    const arr = ls.keyBinds.get(keyset) ?? [];
                    if (!arr.some(b => b.cmd === cmd && b.extra === extra)) {
                        arr.push({ cmd, extra });
                        ls.keyBinds.set(keyset, arr);
                    }
                } else if (verb === 'unbind') {
                    const sp = rest.indexOf(' ');
                    if (sp < 0) return;
                    const keyset = canonicalKeySet(rest.slice(0, sp));
                    if (!keyset) return;
                    const cmd = rest.slice(sp + 1).trim().toLowerCase();
                    const arr = ls.keyBinds.get(keyset);
                    if (!arr) return;
                    const next = arr.filter(b => b.cmd !== cmd);
                    if (next.length === 0) ls.keyBinds.delete(keyset);
                    else ls.keyBinds.set(keyset, next);
                } else if (verb === 'unbindaction') {
                    const cmd = rest.trim().toLowerCase();
                    if (!cmd) return;
                    for (const [k, arr] of ls.keyBinds) {
                        const next = arr.filter(b => b.cmd !== cmd);
                        if (next.length === 0) ls.keyBinds.delete(k);
                        else ls.keyBinds.set(k, next);
                    }
                } else if (verb === 'set') {
                    // `set <key> <value>` — chili's epicmenu trackbar
                    // OnChange handler emits this for every volume
                    // slider. We funnel it through the same config
                    // store + side-effect path as SetConfigInt.
                    const sp = rest.indexOf(' ');
                    if (sp < 0) return;
                    const k = rest.slice(0, sp).trim();
                    const v = rest.slice(sp + 1).trim();
                    if (!k) return;
                    writeConfigStore(ctx, k, v);
                    const n = parseFloat(v);
                    if (Number.isFinite(n)) {
                        applyConfigSideEffect(ctx, k, n);
                    }
                } else if (ENGINE_GRAPHICS_VERBS[verb]) {
                    // Engine graphics console verbs (grounddecals N,
                    // maxparticles N, distdraw N, …). ZK's epicmenu fires
                    // these alongside the springsetting write. Map the verb
                    // to its config key and persist it — the native effect
                    // fires on the main thread via a ClientSettings
                    // subscriber (PLAN-settings.md §4).
                    const configKey = ENGINE_GRAPHICS_VERBS[verb];
                    const v = rest.split(/\s+/)[0] ?? '';
                    if (v !== '') writeConfigStore(ctx, configKey, v);
                }
            };
            for (const a of args) {
                if (typeof a === 'string') apply(a);
            }
        },
        GetConfigInt: (key: LuaValue, def: LuaValue) => {
            const k = typeof key === 'string' ? key : '';
            if (!k) return Number(def ?? 0);
            const raw = readConfigStore(ctx, k);
            if (raw == null) return Number(def ?? 0);
            const n = parseInt(raw, 10);
            return Number.isFinite(n) ? n : Number(def ?? 0);
        },
        GetConfigFloat: (key: LuaValue, def: LuaValue) => {
            const k = typeof key === 'string' ? key : '';
            if (!k) return Number(def ?? 0);
            const raw = readConfigStore(ctx, k);
            if (raw == null) return Number(def ?? 0);
            const n = parseFloat(raw);
            return Number.isFinite(n) ? n : Number(def ?? 0);
        },
        GetConfigString: (key: LuaValue, def: LuaValue) => {
            const k = typeof key === 'string' ? key : '';
            if (!k) return String(def ?? '');
            const raw = readConfigStore(ctx, k);
            return raw ?? String(def ?? '');
        },
        GetModOptions: () => ({ ...ls.modOptions }),
        GetViewGeometry: () => {
            return [ls.viewport.width, ls.viewport.height, 0, 0];
        },
        GetViewSizes: () => {
            return [ls.viewport.width, ls.viewport.height];
        },
        GetWindowGeometry: () => {
            return [ls.viewport.width, ls.viewport.height, 0, 0];
        },
        // Recoil: screenSizeX, screenSizeY, screenPosX, screenPosY (the
        // whole display). In a single-canvas browser client the screen and
        // the view coincide, so we report the canvas size at origin. The
        // optional displayIndex / queryUsable args are accepted but ignored
        // (we have one logical display). When queryUsable is truthy Recoil
        // returns 8 values; mirror that shape so callers indexing [5..8]
        // don't read nil.
        GetScreenGeometry: (_displayIndex?: LuaValue, queryUsable?: LuaValue) => {
            const base = [ls.viewport.width, ls.viewport.height, 0, 0];
            return queryUsable ? [...base, ...base] : base;
        },
        GetNumDisplays: () => 1,
        // PLAN-bar.md §3b: team start positions + ally start boxes, streamed
        // by the server (TeamStartInfo) on auth and re-broadcast after
        // GameStart. Faithful to Recoil's Spring.GetTeamStartPosition /
        // GetAllyTeamStartBox return shapes. DEVIATION: no alliance gate
        // (Recoil's synced reader gates on IsAlliedTeam) — the server streams
        // every team's start position to every client, so the data is already
        // shared and gating here would only hide data the client already holds.
        GetTeamStartPosition: (teamId: LuaValue) => {
            const sp = ls.teamStartPositions.get(Number(teamId));
            if (!sp) return null;
            return [sp.x, sp.y, flipPosZ(sp.z), sp.valid];
        },
        GetAllyTeamStartBox: (allyTeamId: LuaValue) => {
            const box = ls.allyStartBoxes.get(Number(allyTeamId));
            if (!box) return null;
            return [box.xmin, box.zmin, box.xmax, box.zmax];
        },
        // PLAN-bar Spring.GetTeamStatsHistory. The server accumulates each
        // team's TeamStatistics in CTeam::statHistory and streams it
        // incrementally (TeamStatsHistoryBatch, once per game-second). Faithful
        // 1:1 port of LuaSyncedRead::GetTeamStatsHistory: 1-arg form returns the
        // entry count; the (start,end) form returns the 1-indexed slice of stats
        // tables, and the live tail (last index) reports the *current* frame/time
        // rather than its future finalisation frame (exactly as Recoil does).
        // Alliance gate matches Recoil — a non-allied team's stats are hidden
        // until the game is over (full-view spectators see all).
        GetTeamStatsHistory: (teamId: LuaValue, startIndex?: LuaValue, endIndex?: LuaValue) => {
            const tid = Number(teamId);
            const history = ls.teamStatsHistory.get(tid);
            if (!history) return null;            // unknown team → nil (Recoil ParseTeam fail)

            // Recoil: IsAlliedTeam(teamID) || game->IsGameOver(). Resolve the
            // team's allyTeam from the roster if present, else from the
            // TeamStartInfo stream (ls.teams is often unpopulated in the worker,
            // but teamStartPositions carries each team's allyTeam).
            const me = ls.players.get(ls.identity.myPlayerId);
            const isSpectator = me?.spectator ?? false;
            const teamAlly = ls.teams.get(tid)?.allyTeam
                ?? ls.teamStartPositions.get(tid)?.allyTeam;
            const allied = isSpectator
                || (teamAlly !== undefined && teamAlly === ls.identity.myAllyTeam);
            if (!allied && !ls.gameOver) return null;

            const count = history.length;
            if (startIndex === undefined || startIndex === null) return count;  // 1-arg form

            const clamp = (v: number) => Math.max(0, Math.min(count - 1, v));
            const start = clamp(Number(startIndex) - 1);
            const end = (endIndex === undefined || endIndex === null)
                ? start : clamp(Number(endIndex) - 1);

            const GAME_SPEED = 30;
            const out: LuaValue[] = [];
            for (let i = start; i <= end; i++) {
                const s = history[i];
                // For the live tail Recoil substitutes the current sim frame for
                // the (future) finalisation frame the entry carries.
                const isLive = (i + 1 === count);
                const frame = isLive ? ls.gameFrame : s.frame;
                out.push({
                    time: frame / GAME_SPEED, frame,
                    metalUsed: s.metalUsed, metalProduced: s.metalProduced,
                    metalExcess: s.metalExcess, metalReceived: s.metalReceived,
                    metalSent: s.metalSent,
                    energyUsed: s.energyUsed, energyProduced: s.energyProduced,
                    energyExcess: s.energyExcess, energyReceived: s.energyReceived,
                    energySent: s.energySent,
                    damageDealt: s.damageDealt, damageReceived: s.damageReceived,
                    unitsProduced: s.unitsProduced, unitsDied: s.unitsDied,
                    unitsReceived: s.unitsReceived, unitsSent: s.unitsSent,
                    unitsCaptured: s.unitsCaptured, unitsOutCaptured: s.unitsOutCaptured,
                    unitsKilled: s.unitsKilled,
                });
            }
            return luaTable(...out);
        },
        GetSpectatingState: () => {
            // Spring returns: spec, fullView, fullSelect.
            // We don't model fullView/fullSelect so always emit false for those.
            const me = ls.players.get(ls.identity.myPlayerId);
            return [me?.spectator ?? false, false, false];
        },
        IsReplay: () => false,
        GetLocalPlayerID: () => ls.identity.myPlayerId,
        GetMyPlayerID: () => ls.identity.myPlayerId,
        GetGaiaTeamID: () => 1,
        CreateDir: (_path: LuaValue) => true,
        // LOS view colours — arrays of 3 floats each. los_brightness_modifier
        // reads these at init. Defaults mirror Spring's hard-coded baselines.
        GetLosViewColors: () => [
            [0.2, 0.2, 0.2],   // always
            [0.3, 0.3, 0.3],   // LOS
            [0.3, 0.3, 0.3],   // radar
            [0.15, 0.15, 0.15],// jammer
            [0.3, 0.3, 0.3],   // radar2
        ],
        SetLosViewColors: (..._args: LuaValue[]) => {
            // No-op: the client renders its own LOS overlay out-of-band.
        },

        // --- Config set ---
        // Backed by a localStorage-persisted Map<string,string> on the
        // worker side. Writes also trigger per-key side-effects: the
        // `snd_vol*` keys push their values into the AudioManager
        // (channel / master volume) on the main thread.
        SetConfigInt: (key: LuaValue, val: LuaValue) => {
            const k = typeof key === 'string' ? key : '';
            if (!k) return;
            const n = Number(val ?? 0) | 0;
            writeConfigStore(ctx, k, String(n));
            applyConfigSideEffect(ctx, k, n);
        },
        SetConfigFloat: (key: LuaValue, val: LuaValue) => {
            const k = typeof key === 'string' ? key : '';
            if (!k) return;
            const n = Number(val ?? 0);
            writeConfigStore(ctx, k, String(n));
            applyConfigSideEffect(ctx, k, n);
        },
        SetConfigString: (key: LuaValue, val: LuaValue) => {
            const k = typeof key === 'string' ? key : '';
            if (!k) return;
            writeConfigStore(ctx, k, String(val ?? ''));
        },

        // --- Logging ---
        Log: (_section: LuaValue, _level: LuaValue, ...args: LuaValue[]) => {
            console.log('[Spring.Log]', ...args.map(a => String(a ?? '')));
        },

        // --- Player/Team API ---
        // NOTE: Functions returning Lua tables use luaTable() wrapper.
        // Plain JS arrays become multiple return values; luaTable() → single table.
        GetPlayerList: (teamId?: LuaValue, activeOnly?: LuaValue) => {
            const ids: number[] = [];
            const filterTeam = teamId == null ? null : Number(teamId);
            const onlyActive = Boolean(activeOnly);
            for (const [id, p] of ls.players) {
                if (filterTeam !== null && p.team !== filterTeam) continue;
                if (onlyActive && !p.active) continue;
                ids.push(id);
            }
            return luaTable(...ids);
        },
        GetPlayerInfo: (_playerId: LuaValue, _withKeys: LuaValue) => {
            const id = Number(_playerId ?? -1);
            const p = ls.players.get(id);
            if (!p) {
                return [null];
            }
            return [
                p.name, p.active, p.spectator, p.team, p.allyTeam,
                p.pingMs, p.cpuUsage, p.country, p.rank, p.hasController,
                p.customKeys,
            ];
        },
        GetAllyTeamList: () => {
            const set = new Set<number>();
            for (const t of ls.teams.values()) set.add(t.allyTeam);
            return luaTable(...[...set].sort((a, b) => a - b));
        },
        GetTeamList: (_allyTeamId?: LuaValue) => {
            const filter = _allyTeamId == null ? null : Number(_allyTeamId);
            const ids: number[] = [];
            for (const [id, t] of ls.teams) {
                if (filter !== null && t.allyTeam !== filter) continue;
                ids.push(id);
            }
            ids.sort((a, b) => a - b);
            return luaTable(...ids);
        },
        GetTeamInfo: (_teamId: LuaValue) => {
            const tid = Number(_teamId ?? 0);
            const t = ls.teams.get(tid);
            if (!t) return [null];
            return [t.teamId, t.leader, t.isDead, t.isAiTeam, t.side, t.allyTeam, t.customKeys];
        },
        GetPlayerRulesParam: (playerId: LuaValue, key: LuaValue) => {
            const params = ls.playerRulesParams.get(Number(playerId));
            return params?.get(String(key)) ?? null;
        },
        GetPlayerRulesParams: (playerId: LuaValue) => {
            return rulesParamsToTable(ls.playerRulesParams.get(Number(playerId)));
        },
        GetTeamColor: (_teamId: LuaValue) => {
            const id = Number(_teamId ?? 0);
            return ls.teamColors.get(id) ?? defaultTeamColor(id);
        },
        GetMyTeamID: () => ls.identity.myTeam,
        GetMyAllyTeamID: () => ls.identity.myAllyTeam,
        GetTeamUnitCount: (_teamId: LuaValue) => {
            const tid = Number(_teamId ?? ls.identity.myTeam);
            let count = 0;
            for (const u of ls.units.values()) {
                if (u.team === tid) count++;
            }
            return count;
        },

        // --- Map draw mode ---
        GetMapDrawMode: () => 'normal',

        // --- Shock front (camera shake) ---
        SetShockFrontFactors: () => {},

        // --- Selection ---
        GetSelectedUnits: () => luaTable(...ls.selectedUnitIds),
        GetSelectedUnitsCount: () => ls.selectedUnitIds.length,
        // Spring.GetSelectionBox() — the active drag-select rectangle in
        // screen coords (left, top, right, bottom), or nil when no box is
        // being drawn. Faithful to LuaUnsyncedRead::GetSelectionBox; backed
        // by the worker's WorkerSelection (device px, Y-up bottom-left).
        GetSelectionBox: () => {
            const box = ctx.getSelectionBox?.();
            return box ?? null; // [left, top, right, bottom] → 4 returns, else nil
        },
        GetSelectedUnitsSorted: () => {
            const sorted: Record<number, number[]> = {};
            for (const id of ls.selectedUnitIds) {
                const u = ls.units.get(id);
                const defId = u?.defId ?? 0;
                if (!sorted[defId]) sorted[defId] = [];
                sorted[defId].push(id);
            }
            return sorted;
        },
        GetSelectedUnitsCounts: () => {
            const counts: Record<number, number> = {};
            for (const id of ls.selectedUnitIds) {
                const u = ls.units.get(id);
                const defId = u?.defId ?? 0;
                counts[defId] = (counts[defId] ?? 0) + 1;
            }
            return counts;
        },

        // --- Unit queries ---
        GetUnitDefID: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            return u ? u.defId : null;
        },
        GetUnitTeam: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            return u ? u.team : null;
        },
        GetUnitPosition: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            return u ? [u.x, u.y, flipPosZ(u.z)] : null;
        },
        // Recoil's GetUnitBasePosition is literally `return GetUnitPosition(L)`
        // (LuaSyncedRead.cpp:4453) — the same point, just without the optional
        // midpoint return args. Our streamed unit position already IS the base
        // (ground-anchored) point, so it's an exact alias.
        GetUnitBasePosition: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            return u ? [u.x, u.y, flipPosZ(u.z)] : null;
        },
        // ── Projectile reads (A3 / mixed-strategy seam) ──────────────
        // Backed by `ls.projectiles`, mirrored each frame from the
        // main-thread ProjectileRenderer (live + beams). These let ZK's
        // authored projectile-FX widgets (gfx_projectile_lights.lua, LUPS
        // emitters) run unchanged against client projectile state.
        // Recoil parity: LuaSyncedRead.cpp / LuaUnsyncedRead.cpp.
        GetVisibleProjectiles: () => {
            // Recoil filters by viewer vision; the client only holds
            // projectiles the server told it about (already LOS-filtered),
            // so every live id is "visible". MUST return a single Lua table —
            // a plain JS array is unpacked into multiple return values, so
            // ZK's `local p = spGetVisibleProjectiles(); #p` would capture only
            // the first id (a number) and the collector loop never runs.
            const out: number[] = [];
            for (const id of ls.projectiles.keys()) out.push(id);
            return luaTable(...out);
        },
        // Recoil's quad-field rectangle query (LuaSyncedRead.cpp:GetProjectilesInRectangle).
        // Args: (xmin, zmin, xmax, zmax, excludeWeaponProjectiles?, excludePieceProjectiles?).
        // We only mirror weapon projectiles (piece projectiles — debris gibs —
        // aren't streamed), so `excludeWeaponProjectiles` yields an empty set and
        // `excludePieceProjectiles` is a no-op. Positions are compared in the
        // Lua-facing frame (flipPosZ — identity for positions).
        GetProjectilesInRectangle: (
            xmin: LuaValue, zmin: LuaValue, xmax: LuaValue, zmax: LuaValue,
            excludeWeaponProjectiles?: LuaValue, _excludePieceProjectiles?: LuaValue,
        ) => {
            const out: number[] = [];
            if (!excludeWeaponProjectiles) {
                const x0 = Number(xmin), z0 = Number(zmin), x1 = Number(xmax), z1 = Number(zmax);
                for (const [id, p] of ls.projectiles) {
                    const pz = flipPosZ(p.z);
                    if (p.x >= x0 && p.x <= x1 && pz >= z0 && pz <= z1) out.push(id);
                }
            }
            return luaTable(...out);
        },
        GetProjectilePosition: (id: LuaValue) => {
            const p = ls.projectiles.get(Number(id));
            return p ? [p.x, p.y, flipPosZ(p.z)] : null;
        },
        GetProjectileVelocity: (id: LuaValue) => {
            // For beam-type projectiles Recoil overloads this to return the
            // beam **endpoint delta** (to − from), not a velocity; the
            // ProjectileEntry already stores the right vector per type.
            const p = ls.projectiles.get(Number(id));
            return p ? [p.vx, p.vy, flipDirZ(p.vz)] : null;
        },
        GetProjectileDefID: (id: LuaValue) => {
            const p = ls.projectiles.get(Number(id));
            return p ? p.defId : null;
        },
        GetProjectileType: (id: LuaValue) => {
            // Returns (weapon, piece) booleans. The client mirrors only
            // weapon projectiles (incl. beams); piece projectiles (debris
            // gibs) are not streamed, so `piece` is always false. Matches
            // Recoil's GetProjectileType signature.
            const p = ls.projectiles.get(Number(id));
            if (!p) return null;
            return [true, false];
        },
        GetProjectileTimeToLive: (id: LuaValue) => {
            // Remaining time-to-live in sim frames (Recoil units). -1 for
            // projectiles with no fixed lifetime.
            const p = ls.projectiles.get(Number(id));
            return p ? p.ttl : null;
        },
        GetPieceProjectileParams: (_id: LuaValue) => {
            // Piece projectiles (unit-death debris) aren't streamed to the
            // client, so this always returns nil. gfx_projectile_lights.lua
            // only calls it inside its `if piece then` branch, which our
            // GetProjectileType never enters.
            return null;
        },
        GetProjectileTeamID: (id: LuaValue) => {
            const p = ls.projectiles.get(Number(id));
            // Team isn't carried on the client projectile representation
            // yet; -1 (Gaia/none) is a Recoil-valid sentinel. Widgets that
            // branch on team treat it as neutral.
            return p ? -1 : null;
        },
        GetUnitHealth: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            // Spring returns (hp, maxHp, paralyzeDamage, captureProgress,
            // buildProgress). hp / maxHp are best-effort without def data
            // (we approximate maxHp = 1000); buildProgress is now real
            // from FIELD_BUILD_PROGRESS.
            const maxHp = 1000;
            const hp = u.healthRatio * maxHp;
            return [hp, maxHp, 0, 0, u.buildProgress];
        },
        GetUnitStates: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const bits = u.stateBits;
            const fireState = bits & 0x03;
            const moveState = (bits >> 2) & 0x03;
            const repeat    = (bits & (1 << 4)) !== 0;
            const cloak     = (bits & (1 << 5)) !== 0;
            // Spring's GetUnitStates returns a keyed table. We provide
            // the subset the wire format carries; engine-only fields
            // (autoLand, trajectory, autoRepairLevel) default to safe
            // values rather than nil so widget reads don't crash.
            return {
                firestate:        fireState,
                movestate:        moveState,
                repeat:           repeat,
                cloak:            cloak,
                active:           true,
                trajectory:       false,
                autoLand:         false,
                autoRepairLevel:  0,
                loopbackAttack:   false,
            };
        },
        GetUnitRulesParam: (id: LuaValue, key: LuaValue) => {
            const params = ls.unitRulesParams.get(Number(id));
            return params?.get(String(key)) ?? null;
        },
        GetUnitRulesParams: (id: LuaValue) => {
            return rulesParamsToTable(ls.unitRulesParams.get(Number(id)));
        },
        GetUnitIsStunned: (id: LuaValue) => {
            // Spring returns 3 booleans: stunnedOrInBuild, stunned, beingBuilt.
            // We only model "stunned" via the wire bits — beingBuilt derives
            // from health < 1. Combined first return is stunned || beingBuilt.
            const u = ls.units.get(Number(id));
            if (!u) return [false, false, false];
            const stunned    = (u.stateBits & (1 << 6)) !== 0;
            const beingBuilt = u.healthRatio < 1;
            return [stunned || beingBuilt, stunned, beingBuilt];
        },
        GetUnitIsCloaked: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            return (u.stateBits & (1 << 5)) !== 0;
        },
        ValidUnitID: (id: LuaValue) => ls.units.has(Number(id)),
        GetUnitIsDead: (id: LuaValue) => !ls.units.has(Number(id)),

        // --- Transport state (Spring.GetUnitIsTransporting / GetUnitTransporter) ---
        // Spring's GetUnitIsTransporting returns a sequence of cargo
        // unit ids; nil if the unit isn't a transporter at all. We
        // return an empty Lua table when the unit exists but isn't
        // carrying anything — matches the Spring contract.
        GetUnitIsTransporting: (id: LuaValue) => {
            const uid = Number(id);
            if (!ls.units.has(uid)) return null;
            const cargo = ls.transportCargo.get(uid);
            return luaTable(cargo ?? []);
        },
        // GetUnitTransporter returns the carrier unit id, or nil if the
        // unit isn't being carried.
        GetUnitTransporter: (id: LuaValue) => {
            const carrier = ls.transportCarrier.get(Number(id));
            return carrier === undefined ? null : carrier;
        },

        // --- Self-destruct countdown ---
        // Returns game-seconds remaining on the active self-destruct.
        // Spring returns 0 when the unit isn't self-destructing — match
        // that even though Spring's docs call the return optional.
        GetUnitSelfDTime: (id: LuaValue) => {
            const uid = Number(id);
            if (!ls.units.has(uid)) return null;
            return ls.selfDCountdown.get(uid) ?? 0;
        },

        // --- Stockpile weapon state ---
        // Spring returns (numStockpiled, numStockpileQued, buildPercent).
        // We return nil when the unit has no stockpile weapon at all
        // (snapshot omitted the unit) — matches Spring's behaviour of
        // returning nothing when stockpileWeapon is null.
        GetUnitStockpile: (id: LuaValue) => {
            const s = ls.stockpileState.get(Number(id));
            if (!s) return null;
            return [s.ready, s.queued, s.buildPercent];
        },

        // Spring.GetUnitWeaponState(unitID, weaponNum, stateName?) — faithful
        // port of LuaSyncedRead::GetUnitWeaponState. Most callers in BAR/ZK are
        // synced gadgets (they run server-side where the real CWeapon state is
        // available); the worker only needs this for a couple of display widgets
        // (gui_info, gui_unit_stats) that read "range" / "reloadTime" /
        // "reloadTimeXP". Those are STATIC weapon-def values the client already
        // holds, so they're returned faithfully from the streamed weapon defs.
        //
        // Per-unit DYNAMIC state (reloadState/reloadFrame, salvoLeft, nextSalvo,
        // numStockpiled, angleGood) is NOT streamed — the server doesn't put
        // per-weapon reload progress on the wire. Those keys return a documented
        // FIDELITY-STANDIN (weapon-ready) with a one-time warn; closing the gap
        // needs a protocol extension (per-unit-weapon reload frame). See
        // PLAN-bar.md §3b / PLAN.md drift principle.
        GetUnitWeaponState: (id: LuaValue, weaponNum?: LuaValue, stateName?: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            // LUA_WEAPON_BASE_INDEX == 1 → Lua weaponNum is 1-based.
            const wIdx = Math.floor(Number(weaponNum ?? 1)) - 1;
            const weaponIds = ctx.getUnitDefWeaponDefIds?.(u.defId);
            if (!weaponIds || wIdx < 0 || wIdx >= weaponIds.length) return null;
            const w = ctx.getWeaponDefStats?.(weaponIds[wIdx]);
            if (!w) return null;

            const key = stateName != null ? String(stateName) : '';

            // Backwards-compatible no-key form returns 5 values:
            //   angleGood, reloaded, reloadStatus(frame), salvoLeft, numStockpiled
            // Dynamic — all FIDELITY-STANDIN (weapon-ready, no salvo, no stockpile).
            if (key === '') {
                warnStandinOnce('GetUnitWeaponState:dynamic',
                    'Spring.GetUnitWeaponState dynamic fields (reload/salvo/stockpile) ' +
                    'are not streamed — returning weapon-ready defaults. Static def ' +
                    'fields (range/reloadTime/burst/…) are faithful.');
                return [true, true, 0, 0, 0];
            }

            switch (key) {
                // ── Static, faithful from the streamed weapon def ──
                case 'range':                return w.range;
                case 'reloadTime':           return w.reloadTime;
                // reloadSpeed (XP) isn't streamed → unit->reloadSpeed == 1, so
                // reloadTimeXP == reloadTime. Faithful for un-veteran units.
                case 'reloadTimeXP':         return w.reloadTime;
                case 'projectileSpeed':      return w.projectileSpeed;
                case 'burst':                return w.salvoSize;
                case 'burstRate':            return w.salvoDelay;
                case 'projectiles':          return 1; // projectilesPerShot not on wire (default 1)
                case 'accuracy':             return w.accuracy;
                case 'sprayAngle':           return w.sprayAngle;
                case 'targetMoveError':      return w.targetMoveError;
                case 'ttl':                  return w.ttl;

                // ── Dynamic per-unit state — NOT streamed (FIDELITY-STANDIN) ──
                case 'reloadState':
                case 'reloadFrame': {
                    warnStandinOnce('GetUnitWeaponState:reload',
                        'Spring.GetUnitWeaponState("reloadFrame"/"reloadState") is not ' +
                        'streamed — returning 0 (weapon ready). Reload bars will not ' +
                        'animate. Needs a per-unit-weapon reload-frame protocol field.');
                    return 0;
                }
                case 'salvoLeft':
                case 'nextSalvo': {
                    warnStandinOnce('GetUnitWeaponState:salvo',
                        'Spring.GetUnitWeaponState("salvoLeft"/"nextSalvo") is not ' +
                        'streamed — returning 0.');
                    return 0;
                }
                case 'salvoError': {
                    // {x,y,z} inaccuracy of the ongoing burst — not streamed.
                    warnStandinOnce('GetUnitWeaponState:salvoError',
                        'Spring.GetUnitWeaponState("salvoError") is not streamed — ' +
                        'returning zero vector.');
                    return luaTable(0, 0, 0);
                }

                default:
                    // Recoil returns 0 values (→ nil) for unknown keys.
                    return null;
            }
        },

        // --- Armored toggle ---
        // Spring returns (armoredState, armoredMultiple). We return the
        // default (false, 1.0) for units that haven't been streamed —
        // matches the server's omission rule (only non-default state is
        // streamed) so absence == default.
        GetUnitArmored: (id: LuaValue) => {
            const uid = Number(id);
            if (!ls.units.has(uid)) return null;
            const s = ls.armoredState.get(uid);
            if (!s) return [false, 1.0];
            return [s.armored, s.armoredMultiple];
        },

        GetUnitAllyTeam: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const t = ls.teams.get(u.team);
            return t ? t.allyTeam : u.team;
        },
        IsUnitAllied: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return false;
            const t = ls.teams.get(u.team);
            const ally = t ? t.allyTeam : u.team;
            return ally === ls.identity.myAllyTeam;
        },
        IsUnitSelected: (id: LuaValue) => {
            return ls.selectedUnitIds.includes(Number(id));
        },
        // ── LOS / radar visibility ─────────────────────────────────
        // The server stamps every entity with its losStatus byte for
        // the receiving session's ally team. Own-allyteam units are
        // always 0x0F (fully visible). Spring widgets read these via
        // GetUnitLosState / IsUnitInLos / IsUnitInRadar / IsUnitInJammer.
        GetUnitLosState: (id: LuaValue, _allyTeam?: LuaValue, raw?: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const bits = u.losState & 0x0F;
            // Spring's optional 3rd arg returns the raw bitfield.
            // Otherwise: a keyed table of booleans { los=, radar=, typed= }.
            if (raw) return bits;
            return {
                los:    (bits & 0x01) !== 0,
                radar:  (bits & 0x02) !== 0,
                typed:  (bits & 0x04) !== 0,  // PREVLOS — "ghost" / type known
            };
        },
        IsUnitInLos: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return false;
            return (u.losState & 0x01) !== 0;
        },
        IsUnitInAirLos: (id: LuaValue) => {
            // We don't track air-LOS separately yet; widgets fall back
            // on regular LOS (same behaviour as games without air-only
            // sensors). Air-only contacts can be wired in once the
            // server-side losStatus exposes the air bit.
            const u = ls.units.get(Number(id));
            if (!u) return false;
            return (u.losState & 0x01) !== 0;
        },
        IsUnitInRadar: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return false;
            return (u.losState & 0x02) !== 0;
        },
        IsUnitInJammer: () => {
            // Jamming state isn't streamed yet — placeholder so widgets
            // that call this don't crash.
            return false;
        },
        // Per-unit sensor range, read from the cached UnitDef. The wire
        // Per-unit sensor radius. Server emits `EntitySensorUpdate`
        // (envelope `ServerPayload.EntitySensorUpdate`) whenever
        // `Spring.SetUnitSensorRadius` mutates a sensor at runtime —
        // those overrides land in `ls.sensorOverrides` and take
        // priority over the UnitDef baseline so widgets like
        // `unit_stealth.lua` see the change without waiting on a
        // snapshot.
        GetUnitSensorRadius: (id: LuaValue, type: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const sensor = String(type ?? 'los');
            const override = ls.sensorOverrides.get(Number(id))?.get(sensor);
            if (override !== undefined) return override;
            const r = ctx.getUnitDefSensorRadius?.(u.defId, sensor);
            return r ?? 0;
        },
        // Collision/model radius (elmos). Recoil returns the live
        // `unit->radius`; our streamed units carry no per-unit radius
        // scaling, so the def radius is the faithful value. nil for an
        // unknown unit or a def that hasn't streamed in yet.
        GetUnitRadius: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            return ctx.getUnitDefRadius?.(u.defId) ?? null;
        },
        // Per-unit position-error parameters (the wandering vector that
        // produces radar drift). Server-only state today — the client
        // never sees the raw vector, only the deceived position. Return
        // nil so sniper-style widgets that try to undo the deception
        // fail closed instead of silently succeeding.
        GetUnitPosErrorParams: () => null,
        // Per-allyteam radar position-error magnitude. We don't stream
        // the live value yet (TODO: extend GameInfo with radar_error_size
        // — Phase 5/6); host falls back to Spring's compiled-in baseline.
        GetAllyTeamRadarErrorSize: (allyTeam: LuaValue) => {
            const at = allyTeam !== undefined ? Number(allyTeam) : ls.identity.myAllyTeam;
            return ctx.getAllyTeamRadarErrorSize?.(at) ?? 96;
        },

        IsUnitInView: (id: LuaValue) => {
            // All units in the store are server-sent and thus in view
            return ls.units.has(Number(id));
        },
        GetUnitVelocity: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const speed = Math.sqrt(u.vx * u.vx + u.vy * u.vy + u.vz * u.vz);
            return [u.vx, u.vy, flipDirZ(u.vz), speed];
        },
        GetUnitShieldState: () => null,

        // Experience isn't streamed yet — return zeros so widgets like
        // unit_rank_icons render the lowest rank instead of crashing on a
        // nil-method call.
        GetUnitExperience: (id: LuaValue) => {
            if (!ls.units.has(Number(id))) return null;
            return [0, 0];
        },

        GetUnitHeading: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            // heading is u16 (0-65535) → Spring heading (-32768 to 32767)
            return u.heading > 32767 ? u.heading - 65536 : u.heading;
        },

        // Spring's heading is a 16-bit signed integer. After
        // PLAN-coordinate-system Phase 2 the engine + wire format are
        // RH-native (heading=0 → -Z); the legacy-LH bridge flips the
        // input Z so widgets authored against the older convention
        // (heading=0 → +Z) keep getting the expected integer back.
        // Computing atan2(x, -zRH) reads "angle from -Z toward +X" =
        // RH heading; with the flip applied first, a legacy widget's
        // (0, +1) input becomes the RH "facing -Z" sample → heading 0.
        GetHeadingFromVector: (x: LuaValue, z: LuaValue) => {
            const xn = Number(x ?? 0);
            const zn = flipDirZ(Number(z ?? 0));
            const angle = Math.atan2(xn, -zn);
            let h = Math.floor((angle * 32768) / Math.PI);
            // Clamp into Spring's signed-short range
            if (h > 32767) h = 32767;
            else if (h < -32768) h = -32768;
            return h;
        },

        // Spring.RequestPath / Spring.PathRequest — submit an async path
        // query to the server's IPathManager. Spring's native API returns
        // a userdata object with `:Next()` and `:GetPathWayPoints()`
        // methods; we return an equivalent Lua table proxy keyed by a
        // client-assigned request id. Methods read from
        // `ls.pathResponses` on each call — empty until the server's
        // `PathResponse` arrives, then populated for as long as the
        // proxy lives.
        //
        // Caller form (matches Spring): RequestPath(moveType, sx, sy, sz,
        // ex, ey, ez, [radius=8.0]). `moveType` is the move-def index
        // (the field ZK reads as `UnitDefs[id].moveDef.id`). Returns nil
        // when the host doesn't have a connection layer (test harness)
        // or when no valid move type was given.
        //
        // Behaviour quirk vs Spring: the first call after issuing the
        // request returns an empty waypoints list (the server reply
        // hasn't arrived yet). The proxy keeps polling — subsequent
        // GetPathWayPoints calls return the real result once the
        // PathResponse lands. Widgets that fail-open on empty
        // waypoints (ZK's IsTargetReachable does) handle this
        // gracefully; widgets that don't will get one false-negative
        // frame and converge on the next tick.
        RequestPath: (moveType: LuaValue, sx: LuaValue, sy: LuaValue, sz: LuaValue,
                      ex: LuaValue, ey: LuaValue, ez: LuaValue, radius: LuaValue) => {
            // Air / sea-only / invalid: bail with nil so widgets fall
            // through to their "no pathing" branch (Spring's documented
            // behaviour for unknown movedef ids). Treat nil/undefined
            // and the UINT32_MAX sentinel (UnitDefs[id].moveDef.id for
            // air units) the same — both mean "no movedef".
            if (moveType == null) return null;
            const mtNum = Number(moveType);
            if (!Number.isFinite(mtNum)) return null;
            const mt = mtNum | 0;
            // UINT32_MAX coerced through `| 0` is -1; reject both forms.
            if (mt < 0 || mtNum >= 0xFFFFFFFF) return null;
            const startX = Number(sx), startY = Number(sy), startZ = Number(sz);
            const endX   = Number(ex), endY   = Number(ey), endZ   = Number(ez);
            const r = Number(radius);
            const goalRadius = Number.isFinite(r) && r > 0 ? r : 8.0;

            const requestId = ls.nextPathRequestId++;
            // Seed an empty entry so GetPathWayPoints can read it before
            // the server replies (returns []).
            ls.pathResponses.set(requestId, { waypoints: [], length: 0 });

            if (ctx.requestPath) {
                ctx.requestPath(
                    requestId, startX, startY, startZ,
                    endX, endY, endZ, mt, goalRadius);
            } else {
                // No host wired — drop the stub and return nil so the
                // widget treats it as "no path" rather than caching a
                // never-resolving proxy.
                ls.pathResponses.delete(requestId);
                return null;
            }

            // Proxy: a table that mimics Spring's path userdata.
            // ZK widgets call `path:GetPathWayPoints()` and `path:Next(x,y,z,minDist)`;
            // both read from the live `pathResponses` map so the result
            // updates in place once the server reply arrives.
            const proxy: Record<string, LuaValue> = {};
            const lookup = () => ls.pathResponses.get(requestId);

            proxy.id = requestId;
            // Both 1-arg (self) and 0-arg styles in case fengari calls
            // method-form vs function-form.
            proxy.GetPathWayPoints = (_self?: LuaValue) => {
                void _self;
                const entry = lookup();
                if (!entry || entry.waypoints.length === 0) return luaTable();
                // Return a 1-indexed Lua sequence of {x,y,z} triples,
                // matching Spring's native shape.
                const items: LuaValue[] = entry.waypoints.map(wp => {
                    const t: Record<number, number> = {};
                    t[1] = wp[0]; t[2] = wp[1]; t[3] = wp[2];
                    return t as LuaValue;
                });
                return luaTable(...items);
            };
            // path:Next(callerX, callerY, callerZ, minDist) — returns the
            // next waypoint past `minDist` from `callerPos`. Spring's
            // native impl returns (x,y,z) tuple; nil tuple if no more
            // waypoints. We walk the cached list forward from a stored
            // cursor — there's no server round-trip here, all bookkeeping
            // is client-side.
            const cursor = { idx: 0 };
            proxy.Next = (_self: LuaValue, callerX: LuaValue, callerY: LuaValue,
                          callerZ: LuaValue, minDist: LuaValue) => {
                void _self;
                const entry = lookup();
                if (!entry || entry.waypoints.length === 0) return null;
                const cx = Number(callerX ?? 0);
                const cy = Number(callerY ?? 0);
                const cz = Number(callerZ ?? 0);
                const md = Math.max(0, Number(minDist ?? 0));
                const md2 = md * md;
                while (cursor.idx < entry.waypoints.length) {
                    const wp = entry.waypoints[cursor.idx];
                    cursor.idx++;
                    const dx = wp[0] - cx, dy = wp[1] - cy, dz = wp[2] - cz;
                    if ((dx*dx + dy*dy + dz*dz) >= md2) {
                        return [wp[0], wp[1], wp[2]];
                    }
                }
                return null;
            };
            return proxy;
        },
        // `Spring.PathRequest` is bound after the Spring object closes —
        // it shares the same closure as `RequestPath`.
        // Release a path proxy. Spring's userdata calls this via `__gc`
        // when the proxy is collected; widgets sometimes call it
        // explicitly. We drop the cached waypoints + send the cancel
        // hint to the server (currently a no-op, will matter once
        // QTPFS multi-tick is wired).
        DeletePath: (path: LuaValue) => {
            const id = (path && typeof path === 'object' && (path as Record<string, LuaValue>).id != null)
                ? Number((path as Record<string, LuaValue>).id)
                : Number(path);
            if (!Number.isFinite(id) || id <= 0) return;
            ls.pathResponses.delete(id);
            ctx.cancelPathRequest?.(id);
        },
        // Spring.GetStandingOrders(teamId?) — read-only list of standing
        // orders visible to this client (own team + allied teams).
        // Returns a Lua sequence of order tables matching the same
        // shape as the server-side `Spring.GetStandingOrders` (id,
        // type, priority, params, conditions, assigned, active,
        // createdAtFrame, expiresAtFrame). With no argument, returns
        // every visible order; with a `teamId` filters to that team.
        // Widgets cannot create / update / remove standing orders
        // client-side — they're server-authoritative; client must
        // round-trip through `Spring.SendLuaRulesMsg` to a gadget if
        // they need to mutate.
        GetStandingOrders: (teamId: LuaValue) => {
            const filter = (teamId === undefined || teamId === null)
                ? null : (Number(teamId) | 0);
            const out: Record<string, LuaValue>[] = [];
            for (const o of ls.standingOrders.values()) {
                if (filter != null && o.ownerTeam !== filter) continue;
                const conds: Record<string, LuaValue> = {
                    idleOnly: o.conditions.idleOnly,
                    minStrength: o.conditions.minStrength,
                };
                if (o.conditions.squadTypes.length > 0)
                    conds.squadTypes = [...o.conditions.squadTypes];
                if (o.conditions.withinRadius > 0)
                    conds.withinRadius = [
                        o.conditions.withinCenter[0], o.conditions.withinCenter[1],
                        o.conditions.withinCenter[2], o.conditions.withinRadius,
                    ];
                if (o.conditions.outsideRadius > 0)
                    conds.outsideRadius = [
                        o.conditions.outsideCenter[0], o.conditions.outsideCenter[1],
                        o.conditions.outsideCenter[2], o.conditions.outsideRadius,
                    ];
                if (o.conditions.hasCapabilities.length > 0)
                    conds.hasCapabilities = [...o.conditions.hasCapabilities];
                out.push({
                    id: o.orderId,
                    ownerTeam: o.ownerTeam,
                    type: o.type,
                    priority: o.priority,
                    params: [...o.params],
                    conditions: conds,
                    assigned: o.assignedSquadCount,
                    active: o.active,
                    createdAtFrame: o.createdAtFrame,
                    expiresAtFrame: o.expiresAtFrame,
                });
            }
            // Stable ordering: priority desc, then id asc, matches the
            // server's GetTeamOrders.
            out.sort((a, b) => {
                const pa = a.priority as number, pb = b.priority as number;
                if (pa !== pb) return pb - pa;
                return (a.id as number) - (b.id as number);
            });
            return out;
        },
        // Spring.GetPathPosition(pathId, idx) — index-based reader used
        // by widgets that don't want to hold the proxy. 1-indexed.
        GetPathPosition: (path: LuaValue, idx: LuaValue) => {
            const id = (path && typeof path === 'object' && (path as Record<string, LuaValue>).id != null)
                ? Number((path as Record<string, LuaValue>).id)
                : Number(path);
            const i = Number(idx) | 0;
            if (!Number.isFinite(id) || id <= 0 || i < 1) return null;
            const entry = ls.pathResponses.get(id);
            if (!entry) return null;
            const wp = entry.waypoints[i - 1];
            if (!wp) return null;
            return [wp[0], wp[1], wp[2]];
        },

        // --- Team resources ---
        // Spring returns: current, storage, pull, income, expense, share,
        // sent, received. The Spring engine also pads with `excess` and
        // `received` in some forks, but the canonical 8-tuple is widely
        // assumed by Spring widgets — keep it.
        GetTeamResources: (teamId: LuaValue, resType: LuaValue) => {
            const tid = Number(teamId ?? ls.identity.myTeam);
            const r = ls.resources.get(tid);
            if (!r) return [0, 0, 0, 0, 0, 0, 0, 0];
            const t = String(resType ?? 'metal');
            if (t === 'metal') {
                return [r.metal, r.maxMetal, r.metalPull, r.metalIncome,
                        r.metalExpense, r.metalShare, r.metalSent, r.metalReceived];
            } else {
                return [r.energy, r.maxEnergy, r.energyPull, r.energyIncome,
                        r.energyExpense, r.energyShare, r.energySent, r.energyReceived];
            }
        },
        GetTeamAllyTeamID: (teamId: LuaValue) => {
            const t = ls.teams.get(Number(teamId));
            return t ? t.allyTeam : Number(teamId ?? 0);
        },
        AreTeamsAllied: (t1: LuaValue, t2: LuaValue) => {
            const a = ls.teams.get(Number(t1));
            const b = ls.teams.get(Number(t2));
            if (a && b) return a.allyTeam === b.allyTeam;
            return Number(t1) === Number(t2);
        },

        // --- Feature queries ---
        GetAllFeatures: () => luaTable(...ls.features.keys()),
        GetFeaturesInRectangle: (x1: LuaValue, z1: LuaValue, x2: LuaValue, z2: LuaValue) => {
            const rx1 = Number(x1), rz1 = Number(z1), rx2 = Number(x2), rz2 = Number(z2);
            const ids: number[] = [];
            for (const [id, f] of ls.features) {
                if (f.x >= rx1 && f.x <= rx2 && f.z >= rz1 && f.z <= rz2) ids.push(id);
            }
            return luaTable(...ids);
        },
        // Recoil signature: (x, z, radius) — a 2D (x/z-plane) cylinder.
        // Matches the no-Z-flip convention of GetFeaturesInRectangle above
        // (the feature family stays internally consistent regardless of the
        // legacy-coord bridge; reconcile both together if a feature query
        // ever shows a mirrored result on a legacy game).
        GetFeaturesInCylinder: (x: LuaValue, z: LuaValue, r: LuaValue) => {
            const cx = Number(x), cz = Number(z), rad = Number(r);
            const r2 = rad * rad;
            const ids: number[] = [];
            for (const [id, f] of ls.features) {
                const dx = f.x - cx, dz = f.z - cz;
                if (dx * dx + dz * dz <= r2) ids.push(id);
            }
            return luaTable(...ids);
        },
        GetFeatureDefID: (id: LuaValue) => {
            const f = ls.features.get(Number(id));
            return f ? f.defId : null;
        },
        GetFeaturePosition: (id: LuaValue) => {
            const f = ls.features.get(Number(id));
            return f ? [f.x, f.y, f.z] : null;
        },
        GetFeatureHealth: (id: LuaValue) => {
            const f = ls.features.get(Number(id));
            if (!f) return null;
            const maxHp = 1000;
            return [f.healthRatio * maxHp, maxHp, 0];
        },
        GetFeatureTeam: (id: LuaValue) => {
            const f = ls.features.get(Number(id));
            return f ? f.team : null;
        },
        GetFeatureResources: (id: LuaValue) => {
            return ls.features.has(Number(id)) ? [0, 0] : null; // metal, energy reclaim value
        },
        ValidFeatureID: (id: LuaValue) => ls.features.has(Number(id)),

        // --- Misc ---
        // Recoil timer handles: a raw integer time-point since page epoch.
        // GetTimer → milliseconds, GetTimerMicros → microseconds (faithful to
        // PushTimer in LuaUnsyncedRead.cpp). performance.now() is already ms
        // with sub-ms resolution, so *1000 yields the micros count.
        GetTimer: () => performance.now(),
        GetTimerMicros: () => performance.now() * 1000,
        // DiffTimers(endTimer, startTimer, returnMs?, fromMicroSecs?)
        DiffTimers: (t1: LuaValue, t2: LuaValue, returnMs?: LuaValue, fromMicroSecs?: LuaValue) =>
            diffTimers(Number(t1 ?? 0), Number(t2 ?? 0), !!returnMs, !!fromMicroSecs),
        GetDrawFrame: () => ls.gameFrame,
        GetFPS: () => 60,
        WorldToScreenCoords: (_x: LuaValue, _y: LuaValue, _z: LuaValue) => {
            const wx = Number(_x), wy = Number(_y), wz = Number(_z);
            if (ls.viewMatrix && ls.projMatrix) {
                const sx = projectToScreen(wx, wy, wz, ls.viewMatrix, ls.projMatrix, ls.viewport.width, ls.viewport.height);
                if (sx) return sx;
            }
            return [ls.viewport.width / 2, ls.viewport.height / 2, 0];
        },
        ScreenToWorldCoords: (_x: LuaValue, _y: LuaValue) => {
            if (!ls.viewMatrix || !ls.projMatrix) return [0, 0, 0];
            const hit = screenPointToGround(
                Number(_x), Number(_y),
                ls.viewMatrix, ls.projMatrix,
                ls.viewport.width, ls.viewport.height,
                ctx,
            );
            return hit ?? [0, 0, 0];
        },
        TraceScreenRay: (_x: LuaValue, _y: LuaValue, _onlyCoords: LuaValue) => {
            if (!ls.viewMatrix || !ls.projMatrix) return null;
            const hit = screenPointToGround(
                Number(_x), Number(_y),
                ls.viewMatrix, ls.projMatrix,
                ls.viewport.width, ls.viewport.height,
                ctx,
            );
            if (!hit) return null;
            // Spring's contract returns (description, params). With
            // onlyCoords=true, params is the {x,y,z} position table.
            // ZK widgets pattern is `local _, pos = TraceScreenRay(...)`
            // — pos must be the table (2nd return), not a coord scalar.
            return ['ground', luaTable(hit[0], hit[1], hit[2])];
        },
        GetCameraPosition: () => {
            const live = ctx.getCameraPose?.();
            if (live) return [live.pos.x, live.pos.y, live.pos.z];
            return [ls.camera.px, ls.camera.py, ls.camera.pz];
        },
        GetCameraDirection: () => {
            const live = ctx.getCameraPose?.();
            const px = live ? live.pos.x : ls.camera.px;
            const py = live ? live.pos.y : ls.camera.py;
            const pz = live ? live.pos.z : ls.camera.pz;
            const tx = live ? live.lookAt.x : ls.camera.tx;
            const ty = live ? live.lookAt.y : ls.camera.ty;
            const tz = live ? live.lookAt.z : ls.camera.tz;
            const dx = tx - px;
            const dy = ty - py;
            const dz = tz - pz;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            return [dx / len, dy / len, dz / len];
        },
        GetCameraState: () => {
            const live = ctx.getCameraPose?.();
            const px = live ? live.pos.x : ls.camera.px;
            const py = live ? live.pos.y : ls.camera.py;
            const pz = live ? live.pos.z : ls.camera.pz;
            const tx = live ? live.lookAt.x : ls.camera.tx;
            const ty = live ? live.lookAt.y : ls.camera.ty;
            const tz = live ? live.lookAt.z : ls.camera.tz;
            const dx = tx - px;
            const dy = ty - py;
            const dz = tz - pz;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            return {
                // Position (Spring's "px/py/pz" are camera coords, not the
                // look-at — confusingly named but matches the engine).
                px, py, pz,
                // Look-at point. Not part of Spring's classic state shape
                // but useful and matches Recoil's `target` extension —
                // widgets that don't read these keys still work.
                tx, ty, tz,
                rx: Math.asin(-dy / len),
                // RH (Phase 2): ry=0 means looking toward -Z.
                ry: Math.atan2(dx, -dz),
                rz: 0,
                // Orbit distance — Spring's `dist` field.
                dist: len,
                // Camera height — same as py minus look-at.y; commonly
                // queried separately by widgets.
                height: py - ty,
                // ZK's COFC camera tools (TraceCursorToGround,
                // api_preselection) read cs.fov directly. Provide a
                // sensible default in degrees.
                fov: ls.camera.fov ? ls.camera.fov * (180 / Math.PI) : 45,
                name: 'free',
                mode: 0,
            };
        },
        // Spring.SetCameraState(state, smoothness) — full state push.
        // Mirrors Recoil/Spring's contract: any subset of the canonical
        // fields may be supplied and the host applies what it can.
        //   {px,py,pz}        camera position
        //   {tx,ty,tz}        look-at point (Recoil extension; widgets
        //                     also commonly use {rx,ry} for direction)
        //   dist / height     orbit distance (if no explicit position)
        //   fov               vertical FOV in degrees
        //   mode / name       camera mode hint — currently a no-op
        //                     since this fork ships one RTS camera mode
        // Falls back to the (px,pz) move-target shape when the caller
        // only supplied the partial state ZK's SetCameraTargetBox /
        // WG.COFC_SetCameraTarget historically used.
        SetCameraState: (state: LuaValue, smoothness: LuaValue) => {
            if (state == null || typeof state !== 'object' || Array.isArray(state)) return;
            if (!ctx.setCameraState) {
                // Host doesn't expose the full path; degrade to the
                // historical px/pz-only target move.
                const s = state as Record<string, LuaValue>;
                const px = Number(s.px);
                const pz = flipPosZ(Number(s.pz));
                if (!Number.isFinite(px) || !Number.isFinite(pz)) return;
                ctx.setCameraTarget?.(px, pz, Number(smoothness) || 0);
                return;
            }
            // Stringify keys + coerce values so the host doesn't have to
            // re-parse the Lua-typed table. Empty / nil fields stay
            // unset so the host can detect "no override for this field".
            // Z-bearing fields (pz, tz) flip when the legacy bridge is
            // active so the host sees RH coords end-to-end.
            const s = state as Record<string, LuaValue>;
            const Z_FIELDS = new Set(['pz', 'tz']);
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(s)) {
                const v = s[k];
                if (typeof v === 'number') {
                    out[k] = Z_FIELDS.has(k) ? flipPosZ(v) : v;
                } else if (typeof v === 'boolean') {
                    out[k] = v;
                } else if (typeof v === 'string') {
                    out[k] = v;
                }
            }
            ctx.setCameraState(out, Number(smoothness) || 0);
        },
        // Spring.SetCameraTarget(x, y, z, smoothness) — focus the RTS
        // camera on the (x,z) ground point. Y is ignored (the camera
        // keeps its current height). smoothness <= 0 teleports; otherwise
        // it's interpreted as a duration-seconds hint. ZK's core selector
        // calls this with no smoothness for instant snap-to-commander.
        SetCameraTarget: (x: LuaValue, _y: LuaValue, z: LuaValue, smoothness: LuaValue) => {
            const cx = Number(x);
            const cz = flipPosZ(Number(z));
            if (!Number.isFinite(cx) || !Number.isFinite(cz)) return;
            ctx.setCameraTarget?.(cx, cz, Number(smoothness) || 0);
        },
        GetCameraFOV: () => ls.camera.fov * (180 / Math.PI),
        GetCameraVectors: () => {
            const dx = ls.camera.tx - ls.camera.px;
            const dy = ls.camera.ty - ls.camera.py;
            const dz = ls.camera.tz - ls.camera.pz;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            const fx = dx / len, fy = dy / len, fz = dz / len;
            // Right = forward × up (world up = 0,1,0)
            const rx = fz, rz = -fx; // cross(forward, up) simplified
            const rlen = Math.sqrt(rx * rx + rz * rz) || 1;
            const rnx = rx / rlen, rnz = rz / rlen;
            // Up = right × forward
            const ux = rnz * fy - 0 * fz;
            const uy = 0 * fx - rnx * fz; // simplified cross product with ry=0
            const uz = rnx * fy - rnz * fx;
            return {
                forward: luaTable(fx, fy, fz),
                up: luaTable(ux, uy, uz),
                right: luaTable(rnx, 0, rnz),
            };
        },
        GetGroundInfo: (x: LuaValue, z: LuaValue) => {
            // Real Spring returns: ix, iz, type, hardness, tankSpeed, kbotSpeed,
            // hovSpeed, shipSpeed, ground-name, depth. Without per-tile ground
            // metadata we fill the spatial coords + plausible defaults.
            const wx = Number(x), wz = Number(z);
            const sq = ctx.squareSize || 8;
            const ix = Math.floor(wx / sq);
            const iz = Math.floor(wz / sq);
            const elev = sampleHeight(ctx, wx, wz);
            return [ix, iz, 0, 1.0, 1.0, 1.0, 1.0, 1.0, 'default', Math.max(0, -elev)];
        },
        GetGroundNormal: (x: LuaValue, z: LuaValue) => {
            // Legacy widgets call with LH coords; sample against the
            // RH-internal heightmap, then mirror the returned normal's
            // Z back to the caller's frame.
            const n = computeGroundNormal(ctx, Number(x), flipPosZ(Number(z)));
            if (Array.isArray(n) && n.length >= 3) {
                return [n[0], n[1], flipDirZ(Number(n[2])), n[3]];
            }
            return n;
        },
        GetSmoothMeshHeight: (x: LuaValue, z: LuaValue) => {
            return sampleHeight(ctx, Number(x), flipPosZ(Number(z)));
        },
        // Point-LOS queries sample the per-allyteam fog-of-war bitmap
        // streamed by the server (envelope 0x07, ~1 Hz). Coordinates
        // are world-space elmos; the bitmap is downsampled to
        // <= 64×64 squares. `allyTeam` defaults to the viewer's own.
        // Returns false when the bitmap hasn't arrived yet (first
        // second of the game) or when the caller asks about an ally
        // team we don't have a bitmap for (non-spectator querying
        // someone else's vision). IsPosInAirLos folds into the
        // in-radar plane on the wire — air-spotted squares are
        // server-marked as visible — Phase 7 will split them out.
        IsPosInLos: (x: LuaValue, _y: LuaValue, z: LuaValue, allyTeam?: LuaValue) => {
            return sampleLosPlane(ctx, ls, 'los', Number(x), flipPosZ(Number(z)),
                allyTeam !== undefined ? Number(allyTeam) : undefined);
        },
        IsPosInAirLos: (x: LuaValue, _y: LuaValue, z: LuaValue, allyTeam?: LuaValue) => {
            // Air-LOS is folded into the in-radar plane on the wire.
            return sampleLosPlane(ctx, ls, 'radar', Number(x), flipPosZ(Number(z)),
                allyTeam !== undefined ? Number(allyTeam) : undefined);
        },
        IsPosInRadar: (x: LuaValue, _y: LuaValue, z: LuaValue, allyTeam?: LuaValue) => {
            return sampleLosPlane(ctx, ls, 'radar', Number(x), flipPosZ(Number(z)),
                allyTeam !== undefined ? Number(allyTeam) : undefined);
        },
        // Recoil returns 4 booleans: (inLos||inRadar), inLos, inRadar,
        // inJammer. We sample the per-allyteam LOS bitmap for the first
        // three; jammer state isn't streamed yet so inJammer is always
        // false (DEVIATION — flagged; needs a server-side jammer plane).
        GetPositionLosState: (x: LuaValue, _y: LuaValue, z: LuaValue, allyTeam?: LuaValue) => {
            const at = allyTeam !== undefined ? Number(allyTeam) : undefined;
            const fz = flipPosZ(Number(z));
            const inLos = sampleLosPlane(ctx, ls, 'los', Number(x), fz, at);
            const inRadar = sampleLosPlane(ctx, ls, 'radar', Number(x), fz, at);
            return [inLos || inRadar, inLos, inRadar, false];
        },
        // Area unit queries: legacy widgets pass LH Z bounds; mirror to
        // RH before comparing against the unit store, which holds wire
        // (= RH) coords.
        GetUnitsInRectangle: (x1: LuaValue, z1: LuaValue, x2: LuaValue, z2: LuaValue) => {
            const rx1 = Number(x1), rx2 = Number(x2);
            let rz1 = flipPosZ(Number(z1));
            let rz2 = flipPosZ(Number(z2));
            if (rz1 > rz2) [rz1, rz2] = [rz2, rz1];
            const ids: number[] = [];
            for (const [id, u] of ls.units) {
                if (u.x >= rx1 && u.x <= rx2 && u.z >= rz1 && u.z <= rz2) ids.push(id);
            }
            return luaTable(...ids);
        },
        GetUnitsInCylinder: (x: LuaValue, z: LuaValue, r: LuaValue) => {
            const cx = Number(x), cz = flipPosZ(Number(z)), rad = Number(r);
            const r2 = rad * rad;
            const ids: number[] = [];
            for (const [id, u] of ls.units) {
                const dx = u.x - cx, dz = u.z - cz;
                if (dx * dx + dz * dz <= r2) ids.push(id);
            }
            return luaTable(...ids);
        },
        GetUnitsInSphere: (x: LuaValue, y: LuaValue, z: LuaValue, r: LuaValue) => {
            const cx = Number(x), cy = Number(y), cz = flipPosZ(Number(z)), rad = Number(r);
            const r2 = rad * rad;
            const ids: number[] = [];
            for (const [id, u] of ls.units) {
                const dx = u.x - cx, dy = u.y - cy, dz = u.z - cz;
                if (dx * dx + dy * dy + dz * dz <= r2) ids.push(id);
            }
            return luaTable(...ids);
        },
        IsSphereInView: () => true, // conservative — server already LOS-filters
        GetVisibleUnits: () => luaTable(...ls.units.keys()),
        GetAllUnits: () => luaTable(...ls.units.keys()),
        GetTeamUnits: (_teamId: LuaValue) => {
            const tid = Number(_teamId ?? ls.identity.myTeam);
            const ids: number[] = [];
            for (const [id, u] of ls.units) {
                if (u.team === tid) ids.push(id);
            }
            return luaTable(...ids);
        },
        GetTeamUnitsSorted: (_teamId: LuaValue) => {
            const tid = Number(_teamId ?? ls.identity.myTeam);
            const sorted: Record<number, number[]> = {};
            for (const [id, u] of ls.units) {
                if (u.team !== tid) continue;
                if (!sorted[u.defId]) sorted[u.defId] = [];
                sorted[u.defId].push(id);
            }
            return sorted;
        },
        // Recoil: (teamID, unitDefID | {unitDefID,...}) → array of the
        // team's units matching any of the given defs. We hold full
        // per-unit team+def, so this is a direct filter.
        GetTeamUnitsByDefs: (_teamId: LuaValue, defs: LuaValue) => {
            const tid = Number(_teamId ?? ls.identity.myTeam);
            const wanted = new Set<number>();
            if (typeof defs === 'number') {
                wanted.add(defs);
            } else if (isLuaTable(defs)) {
                for (const v of defs.items) if (typeof v === 'number') wanted.add(v);
            } else if (Array.isArray(defs)) {
                for (const v of defs) if (typeof v === 'number') wanted.add(v);
            }
            const ids: number[] = [];
            for (const [id, u] of ls.units) {
                if (u.team === tid && wanted.has(u.defId)) ids.push(id);
            }
            return luaTable(...ids);
        },
        GetTeamUnitDefCount: (_teamId: LuaValue, _defId: LuaValue) => {
            const tid = Number(_teamId ?? ls.identity.myTeam);
            const did = Number(_defId ?? 0);
            let count = 0;
            for (const u of ls.units.values()) {
                if (u.team === tid && u.defId === did) count++;
            }
            return count;
        },

        // --- Local team ---
        GetLocalTeamID: () => ls.identity.myTeam,
        GetLocalAllyTeamID: () => ls.identity.myAllyTeam,

        // --- Game speed ---
        GetGameSpeed: () => [ls.gameSpeed, ls.gameSpeed, ls.gamePaused],
        // Recoil: isDoneLoading, isSavedGame, isClientPaused, isSimLagging.
        // In-game the client has finished loading; we don't support saved
        // games and don't surface a sim-lag signal here, so the latter two
        // are false. The local pause flag mirrors GetGameSpeed's 3rd value.
        GetGameState: (_maxLatency?: LuaValue) => {
            return [true, false, ls.gamePaused, false];
        },
        IsGameOver: () => ls.gameOver,

        // --- GUI state ---
        IsGUIHidden: () => false,
        GetModKeyState: () => [ls.modKeys.alt, ls.modKeys.ctrl, ls.modKeys.meta, ls.modKeys.shift],
        GetKeyState: (_keyCode: LuaValue) => false, // would need per-key tracking
        ScaledGetMouseState: () => {
            const m = ls.mouse;
            return [m.x, m.y, m.lmb, m.mmb, m.rmb, m.outsideSpring];
        },
        GetMouseCursor: () => ['', 1.0], // name, scale
        SetMouseCursor: (_name: LuaValue) => {
            // The worker overrides this with a postMessage to main; the
            // bare lua-spring-api context (no worker bridge) is a no-op.
        },
        IsAboveMiniMap: (x?: LuaValue, y?: LuaValue) => {
            // Spring's API takes optional screen coords; if omitted, the
            // engine substitutes the current mouse position. Coords are
            // in Spring screen-space (Y-up). Without a widget-claimed
            // minimap we have no rect to hit-test against — return
            // false, matching Spring's behaviour when no minimap exists.
            const g = ls.minimapGeometry;
            if (!g || !g.visible || g.width <= 0 || g.height <= 0) return false;
            const sx = Number(x ?? ls.mouse.x);
            const sy = Number(y ?? ls.mouse.y);
            return sx >= g.x && sx < g.x + g.width
                && sy >= g.y && sy < g.y + g.height;
        },
        GetMiniMapGeometry: () => {
            const g = ls.minimapGeometry;
            if (!g) return [0, 0, 200, 200];
            return [g.x, g.y, g.width, g.height];
        },
        SetMiniMapGeometry: (x: LuaValue, y: LuaValue, w: LuaValue, h: LuaValue) => {
            const gx = Number(x ?? 0);
            const gy = Number(y ?? 0);
            const gw = Number(w ?? 0);
            const gh = Number(h ?? 0);
            ls.minimapGeometry = {
                x: gx, y: gy, width: gw, height: gh,
                visible: gw > 0 && gh > 0,
            };
            ctx.setMinimapGeometry?.(gx, gy, gw, gh);
        },
        GetBuildFacing: () => ls.buildFacing,
        SetBuildFacing: (_facing: LuaValue) => {
            ls.buildFacing = Number(_facing ?? 0) % 4;
        },
        GetBuildSpacing: () => ls.buildSpacing,
        SetBuildSpacing: (n: LuaValue) => {
            const v = Number(n ?? 0) | 0;
            ls.buildSpacing = Math.max(0, v);
        },
        GetInvertQueueKey: () => false,

        // Spring.TestBuildOrder(unitDefId, x, y, z, facing) → (status, featureId?)
        // Client-side replica — see Spring's LuaSyncedRead::TestBuildOrder.
        // Returns Lua's collapsed surface (Spring maps internal OPEN=3 →
        // RECLAIMABLE=2 for backwards compat):
        //   0 = blocked         (out of bounds or static building/feature in the way)
        //   1 = occupied        (mobile unit footprint overlaps — could move out)
        //   2 = buildable       (default; second return = featureID if a feature is overlapping)
        // ZK widgets check either `~= 0` (any non-blocked) or `== 2`
        // (fully buildable). Per-mouse-frame use means a server round-trip
        // is unworkable; we approximate using `GameUnitDef` footprints +
        // `ls.units` / `ls.features` AABB overlap.
        TestBuildOrder: (defIdArg: LuaValue, xArg: LuaValue, _yArg: LuaValue, zArg: LuaValue, facingArg: LuaValue) => {
            const defId = Number(defIdArg ?? 0) | 0;
            if (defId <= 0) return 0;
            const fp = ctx.getUnitDefFootprint?.(defId);
            if (!fp || fp.xsize <= 0 || fp.zsize <= 0) {
                // Def not yet cached — treat as buildable so the placement
                // UI doesn't flash red on first hover before defs stream
                // in. Worst case the server rejects the actual build order.
                return 2;
            }
            const facing = (Number(facingArg ?? ls.buildFacing) | 0) & 3;
            // facing 1 (east) and 3 (west) rotate the footprint 90°.
            const xsize = (facing & 1) === 0 ? fp.xsize : fp.zsize;
            const zsize = (facing & 1) === 0 ? fp.zsize : fp.xsize;

            // Snap to build grid (matches Spring's Pos2BuildPos: even-
            // footprint dims snap to the grid centre, odd dims snap to
            // the grid corner). SQUARE_SIZE = 8 elmos; build squares are
            // SQUARE_SIZE wide.
            const SQ = ctx.squareSize || 8;
            const halfX = xsize * SQ * 0.5;
            const halfZ = zsize * SQ * 0.5;
            const bx = snapBuildCoord(Number(xArg ?? 0), xsize, SQ);
            const bz = snapBuildCoord(Number(zArg ?? 0), zsize, SQ);

            // Out-of-map: any part of the footprint outside the world AABB
            // is BUILDSQUARE_BLOCKED (matches Spring's mapDims check).
            if (bx - halfX < 0 || bx + halfX > ctx.mapSizeX ||
                bz - halfZ < 0 || bz + halfZ > ctx.mapSizeZ) {
                return 0;
            }

            // Unit overlap check — distinguish mobile (OCCUPIED=1) from
            // static (BLOCKED=0). Air units (isMobile=true with no ground
            // footprint) would be treated as mobile-blocking by the
            // approximation below; for now this is close enough — Spring
            // itself filters air units out of the ground block map, so
            // false-positives are rare in practice.
            for (const u of ls.units.values()) {
                if (u.defId === 0) continue;
                const otherFp = ctx.getUnitDefFootprint?.(u.defId);
                if (!otherFp) continue;
                const oHalfX = otherFp.xsize * SQ * 0.5;
                const oHalfZ = otherFp.zsize * SQ * 0.5;
                if (Math.abs(u.x - bx) < halfX + oHalfX &&
                    Math.abs(u.z - bz) < halfZ + oHalfZ) {
                    return otherFp.isMobile ? 1 : 0;
                }
            }

            // Feature overlap — Spring distinguishes reclaimable features
            // (return 2 with featureID) from non-reclaimable. We don't
            // stream feature-def blocking flags to the worker yet, so
            // we treat every overlapping feature as reclaimable and
            // surface its ID. Most map features are wrecks/rocks which
            // *are* reclaimable in ZK, so the approximation is reasonable.
            // The 8-elmo half-extent is a rough placeholder — proper
            // footprint plumbing for features needs FeatureDef.xsize/zsize
            // on the wire.
            for (const f of ls.features.values()) {
                const FH = SQ; // half-extent in elmos for a 1x1 feature
                if (Math.abs(f.x - bx) < halfX + FH &&
                    Math.abs(f.z - bz) < halfZ + FH) {
                    return [2, f.defId];
                }
            }

            return 2;
        },

        // Spring.Pos2BuildPos(unitDefId, x, y, z, facing?) — snaps a
        // position to the build grid using the def's footprint. Returns
        // the snapped (x, y, z).
        Pos2BuildPos: (defIdArg: LuaValue, xArg: LuaValue, _yArg: LuaValue, zArg: LuaValue, facingArg: LuaValue) => {
            const defId = Number(defIdArg ?? 0) | 0;
            const fp = defId > 0 ? ctx.getUnitDefFootprint?.(defId) : undefined;
            const facing = (Number(facingArg ?? 0) | 0) & 3;
            const xsize = !fp ? 1 : ((facing & 1) === 0 ? fp.xsize : fp.zsize);
            const zsize = !fp ? 1 : ((facing & 1) === 0 ? fp.zsize : fp.xsize);
            const SQ = ctx.squareSize || 8;
            const bx = snapBuildCoord(Number(xArg ?? 0), xsize, SQ);
            const bz = snapBuildCoord(Number(zArg ?? 0), zsize, SQ);
            const by = sampleHeight(ctx, bx, bz);
            return [bx, by, bz];
        },

        // --- Ground extremes ---
        GetGroundExtremes: () => [ctx.minHeight, ctx.maxHeight],

        // --- Custom command draw data ---
        SetCustomCommandDrawData: () => {},

        // --- Map markers ---
        // Local-only: appended to ls.markers (no server broadcast — the
        // engine doesn't yet forward Lua marker calls to other clients).
        // We also push a minimap event-layer ping so the player sees a
        // cyan ring pulse where they dropped the marker. Real Spring
        // drops/erases markers within Spring.SQUARE_SIZE * 2.
        MarkerAddPoint: (x: LuaValue, y: LuaValue, z: LuaValue, label: LuaValue, _localOnly?: LuaValue) => {
            const px = Number(x), pz = flipPosZ(Number(z));
            ls.markers.push({
                kind: 'point',
                x: px, y: Number(y), z: pz,
                label: String(label ?? ''),
                teamId: ls.identity.myTeam,
            });
            ctx.addMinimapMarker?.(px, pz);
        },
        MarkerAddLine: (x1: LuaValue, y1: LuaValue, z1: LuaValue,
                        x2: LuaValue, y2: LuaValue, z2: LuaValue, _localOnly?: LuaValue) => {
            const ax = Number(x1), az = flipPosZ(Number(z1));
            const bx = Number(x2), bz = flipPosZ(Number(z2));
            ls.markers.push({
                kind: 'line',
                x: ax, y: Number(y1), z: az,
                x2: bx, y2: Number(y2), z2: bz,
                label: '',
                teamId: ls.identity.myTeam,
            });
            // Bracket the line with one ping per endpoint so the
            // minimap shows where the line was drawn even though the
            // line geometry itself isn't rendered on the minimap.
            ctx.addMinimapMarker?.(ax, az);
            ctx.addMinimapMarker?.(bx, bz);
        },
        MarkerErasePosition: (x: LuaValue, _y: LuaValue, z: LuaValue) => {
            const radius = (ctx.squareSize || 8) * 2;
            const cx = Number(x), cz = flipPosZ(Number(z));
            ls.markers = ls.markers.filter(m => {
                const dx = m.x - cx, dz = m.z - cz;
                return Math.sqrt(dx * dx + dz * dz) > radius;
            });
        },
        // Spring overloads: SetActiveCommand(idx [, btn, lc, rc, alt, ctrl, meta, shift])
        //                 | SetActiveCommand(cmdName)
        //
        // The chili integral menu calls the index form after looking up
        // a build cmdId via GetCmdDescIndex. We resolve the index back to
        // a cmdId against the first selected unit's stored cmd-descs and,
        // for build commands (cmdId<0), forward to the host so it can
        // enter ground placement (or queue the build on a pure factory
        // selection). Without this hop the click is silently dropped —
        // chili's own state update runs but no order ever reaches the
        // server.
        SetActiveCommand: (a: LuaValue, _btn?: LuaValue, leftArg?: LuaValue, rightArg?: LuaValue,
                          altArg?: LuaValue, ctrlArg?: LuaValue, metaArg?: LuaValue, shiftArg?: LuaValue) => {
            if (typeof a === 'number') {
                const idx = a | 0;
                const sel = ls.selectedUnitIds[0];
                const stored = sel ? ls.unitCmdDescs.get(sel) : undefined;
                const desc = stored?.[idx - 1]; // chili passes 1-based indices
                const cmdId = desc?.cmdId ?? 0;
                const cmdType = desc?.type ?? 0; // Spring CMDTYPE_*
                ls.activeCommand = { index: idx, cmdId, cmdName: '' };
                if (cmdId === 0) return true;

                // Replicate CGuiHandler::SetActiveCommand: state toggles and
                // no-target commands fire immediately; build + world-target
                // commands are handed to the host to arm placement/targeting.
                const right = !!rightArg;
                // CMDTYPE_ICON_MODE (5): cycle to the next state index and
                // issue right away. params[0] is the current index, params[1..]
                // the human labels — so the option count is params.length-1.
                if (cmdId >= 0 && cmdType === 5 && ctx.giveOrder) {
                    const params = desc?.params ?? [];
                    const count = Math.max(1, params.length - 1);
                    const cur = parseInt(params[0] ?? '0', 10) || 0;
                    const next = (((cur + (right ? -1 : 1)) % count) + count) % count;
                    ctx.giveOrder(cmdId, ls.selectedUnitIds.slice(), [next], 0);
                    return true;
                }
                // CMDTYPE_ICON (0): instant order with no target (Stop,
                // Self-D, Stockpile, …).
                if (cmdId >= 0 && cmdType === 0 && ctx.giveOrder) {
                    ctx.giveOrder(cmdId, ls.selectedUnitIds.slice(), [], 0);
                    return true;
                }
                // Build (cmdId < 0) and all world-target types → host.
                if (ctx.setActiveCommand) {
                    ctx.setActiveCommand(cmdId, {
                        left:  !!leftArg,
                        right,
                        alt:   !!altArg,
                        ctrl:  !!ctrlArg,
                        meta:  !!metaArg,
                        shift: !!shiftArg,
                    }, cmdType);
                }
            } else if (typeof a === 'string') {
                ls.activeCommand = { index: -1, cmdId: 0, cmdName: a };
            } else {
                ls.activeCommand = { index: -1, cmdId: 0, cmdName: '' };
            }
            return true;
        },
        GiveOrderToUnit: (unitId: LuaValue, cmdId: LuaValue, params: LuaValue, options: LuaValue) => {
            if (!ctx.giveOrder) return false;
            const id = Number(unitId) | 0;
            if (id <= 0) return false;
            const cid = Number(cmdId) | 0;
            ctx.giveOrder(cid, [id], orderParamsToArray(params), orderOptionsToBits(options));
            return true;
        },
        GiveOrderToUnitArray: (unitIds: LuaValue, cmdId: LuaValue, params: LuaValue, options: LuaValue) => {
            if (!ctx.giveOrder) return false;
            const ids = orderUnitIdsToArray(unitIds);
            if (ids.length === 0) return false;
            const cid = Number(cmdId) | 0;
            ctx.giveOrder(cid, ids, orderParamsToArray(params), orderOptionsToBits(options));
            return true;
        },
        GiveOrder: (cmdId: LuaValue, params: LuaValue, options: LuaValue) => {
            if (!ctx.giveOrder) return false;
            const ids = ls.selectedUnitIds.slice();
            if (ids.length === 0) return false;
            const cid = Number(cmdId) | 0;
            ctx.giveOrder(cid, ids, orderParamsToArray(params), orderOptionsToBits(options));
            return true;
        },
        // Spring.GiveOrderArrayToUnitArray(unitIds, [orders]) issues every
        // order in the list to every unit in the list. Each order entry is
        // { cmdId, params, options } (sequence form). Widgets use this for
        // batch state-change scripts (cmd_keep_target, cmd_select_load).
        // We currently loop and send one PlayerCommand per order — atomic
        // batching will arrive with PlayerCommandBatch (Phase 0a).
        GiveOrderArrayToUnitArray: (unitIds: LuaValue, orders: LuaValue) => {
            if (!ctx.giveOrder) return false;
            const ids = orderUnitIdsToArray(unitIds);
            if (ids.length === 0) return false;
            if (!Array.isArray(orders) || orders.length === 0) return false;
            for (const entry of orders) {
                if (!entry || typeof entry !== 'object') continue;
                const seq = entry as Record<string | number, LuaValue>;
                // Accept both 1-indexed Lua sequences ({[1]=cmdId, [2]=params,
                // [3]=options}) — which Fengari surfaces as Arrays — and
                // keyed tables ({cmdId=..., params=..., options=...}).
                const cmdId = Number(
                    Array.isArray(entry) ? entry[0] : (seq.cmdId ?? seq[1])
                ) | 0;
                const params = Array.isArray(entry) ? entry[1] : (seq.params ?? seq[2]);
                const options = Array.isArray(entry) ? entry[2] : (seq.options ?? seq[3]);
                ctx.giveOrder(cmdId, ids,
                              orderParamsToArray(params as LuaValue),
                              orderOptionsToBits(options as LuaValue));
            }
            return true;
        },
        // Order queue readers — all backed by ls.unitCommands. Spring
        // returns an array of {id, params, options, tag} tables; we
        // include `timeout` too (zero-cost extra info).
        GetUnitCommands: (unitId: LuaValue, count: LuaValue) => {
            return ordersToLuaArray(ls.unitCommands.get(Number(unitId)), count);
        },
        // Factory commands are stored in the same queue as regular
        // orders for our wire format; the engine separates them
        // internally but widgets read them through the same shape.
        GetFactoryCommands: (unitId: LuaValue, count: LuaValue) => {
            return ordersToLuaArray(ls.unitCommands.get(Number(unitId)), count);
        },
        GetCommandQueue: (unitId: LuaValue, count: LuaValue) => {
            return ordersToLuaArray(ls.unitCommands.get(Number(unitId)), count);
        },
        // Spring.GetFullBuildQueue returns a 1-indexed sequence of
        // single-pair tables: { [1]={[defA]=count}, [2]={[defB]=count}, ... }
        // ZK widgets iterate via `for _,buildPair in ipairs(queue) do
        // local udef,count = next(buildPair,nil) end` so the shape must
        // be a sequence — a flat map breaks ipairs(). We collapse same
        // defs since unit_commands is already a per-tick snapshot.
        GetFullBuildQueue: (unitId: LuaValue) => {
            const orders = ls.unitCommands.get(Number(unitId));
            if (!orders || orders.length === 0) return luaTable();
            const counts = new Map<number, number>();
            for (const o of orders) {
                if (o.cmdId < 0) {
                    const defId = -o.cmdId;
                    counts.set(defId, (counts.get(defId) ?? 0) + 1);
                }
            }
            const items: LuaValue[] = [];
            for (const [defId, count] of counts) {
                items.push({ [defId]: count } as Record<string, LuaValue>);
            }
            return luaTable(...items);
        },
        // Spring.GetRealBuildQueue: same shape as GetFullBuildQueue but
        // preserves consecutive-same-def runs (e.g. queueing 3 of A then
        // 1 of B then 2 of A → 3 entries). The chili integral menu uses
        // this to render the queue strip; #buildQueue must be > 0 and
        // each buildQueue[i] must be a single-pair table.
        GetRealBuildQueue: (unitId: LuaValue) => {
            const orders = ls.unitCommands.get(Number(unitId));
            if (!orders || orders.length === 0) return luaTable();
            const items: LuaValue[] = [];
            let runDef = 0;
            let runCount = 0;
            for (const o of orders) {
                if (o.cmdId >= 0) continue;
                const defId = -o.cmdId;
                if (defId === runDef) {
                    runCount++;
                } else {
                    if (runDef !== 0) {
                        items.push({ [runDef]: runCount } as Record<string, LuaValue>);
                    }
                    runDef = defId;
                    runCount = 1;
                }
            }
            if (runDef !== 0) {
                items.push({ [runDef]: runCount } as Record<string, LuaValue>);
            }
            return luaTable(...items);
        },
        // Spring.SelectUnitArray(unitArray[, append]) — replace the player's
        // selection with `unitArray`, or merge into it when append=true.
        // An empty array clears the selection. Updates the worker-local
        // mirror immediately so widgets observing GetSelectedUnits within
        // the same call see the new state.
        SelectUnitArray: (unitArray: LuaValue, append: LuaValue) => {
            const ids = orderUnitIdsToArray(unitArray);
            applySelection(ls, ctx, ids, !!append);
        },
        // Spring.SelectUnitMap(unitMap[, append]) — selects every unit whose
        // id is a key in `unitMap`. ZK's gui_selection_hierarchy.lua calls
        // this on every Core-Selector button click. The map values are
        // ignored — keys carry the unit ids.
        SelectUnitMap: (unitMap: LuaValue, append: LuaValue) => {
            applySelection(ls, ctx, mapKeysToUnitIds(unitMap), !!append);
        },
        SetUnitGroup: (unitId: LuaValue, groupId: LuaValue) => {
            const uid = Number(unitId);
            const gid = Number(groupId);
            // Drop the unit from any group it was already in.
            for (const g of ls.groups.values()) g.delete(uid);
            // Group -1 / nil clears assignment.
            if (gid < 0 || !Number.isFinite(gid)) return true;
            let bucket = ls.groups.get(gid);
            if (!bucket) { bucket = new Set(); ls.groups.set(gid, bucket); }
            bucket.add(uid);
            return true;
        },
        GetGroupList: () => {
            // Spring returns a table of {[groupId] = unitCount}.
            const out: Record<number, number> = {};
            for (const [gid, units] of ls.groups) {
                if (units.size > 0) out[gid] = units.size;
            }
            return out;
        },
        GetGroupUnits: (groupId: LuaValue) => {
            const bucket = ls.groups.get(Number(groupId));
            return bucket ? luaTable(...bucket) : luaTable();
        },
        GetGroupUnitsSorted: (groupId: LuaValue) => {
            const bucket = ls.groups.get(Number(groupId));
            const out: Record<number, number[]> = {};
            if (bucket) {
                for (const uid of bucket) {
                    const u = ls.units.get(uid);
                    const did = u?.defId ?? 0;
                    (out[did] ??= []).push(uid);
                }
            }
            return out;
        },
        GetGroupUnitsCounts: (groupId: LuaValue) => {
            const bucket = ls.groups.get(Number(groupId));
            const out: Record<number, number> = {};
            if (bucket) {
                for (const uid of bucket) {
                    const u = ls.units.get(uid);
                    const did = u?.defId ?? 0;
                    out[did] = (out[did] ?? 0) + 1;
                }
            }
            return out;
        },

        // --- Extension queries ---
        HasExtension: () => true,

        // --- Active command ---
        GetActiveCommand: () => {
            const ac = ls.activeCommand;
            return [ac.index, ac.cmdId, ac.cmdName];
        },

        // --- Sun ---
        GetSun: (_param: LuaValue) => {
            const p = String(_param ?? '');
            if (p === 'pos') return [500, 1000, 500];
            if (p === 'dir') return [0.5, -0.7, 0.5];
            if (p === 'specular') return [1, 1, 1];
            if (p === 'diffuse') return [1, 1, 1];
            if (p === 'ambient') return [0.3, 0.3, 0.3];
            return [1, 1, 1];
        },

        // --- Team rules params ---
        GetTeamRulesParam: (teamId: LuaValue, key: LuaValue) => {
            const params = ls.teamRulesParams.get(Number(teamId));
            return params?.get(String(key)) ?? null;
        },
        GetTeamRulesParams: (teamId: LuaValue) => {
            return rulesParamsToTable(ls.teamRulesParams.get(Number(teamId)));
        },

        // --- Keyboard ---
        GetKeyCode: (keyName: LuaValue) => {
            // Map Spring key names to key codes (DOM KeyboardEvent.keyCode compatible)
            const name = String(keyName ?? '').toLowerCase();
            const map: Record<string, number> = {
                'backspace': 8, 'tab': 9, 'return': 13, 'enter': 13,
                'esc': 27, 'escape': 27, 'space': 32,
                'delete': 127, 'del': 127,
                'left': 276, 'right': 275, 'up': 273, 'down': 274,
                'home': 278, 'end': 279,
                'pageup': 280, 'pagedown': 281,
                'insert': 277,
                'shift': 304, 'ctrl': 306, 'alt': 308, 'meta': 310,
                'a': 97, 'b': 98, 'c': 99, 'd': 100, 'e': 101,
                'f': 102, 'g': 103, 'h': 104, 'i': 105, 'j': 106,
                'k': 107, 'l': 108, 'm': 109, 'n': 110, 'o': 111,
                'p': 112, 'q': 113, 'r': 114, 's': 115, 't': 116,
                'u': 117, 'v': 118, 'w': 119, 'x': 120, 'y': 121, 'z': 122,
                '0': 48, '1': 49, '2': 50, '3': 51, '4': 52,
                '5': 53, '6': 54, '7': 55, '8': 56, '9': 57,
            };
            return map[name] ?? 0;
        },
        // Spring.GetKeySymbol(keyCode) → (name, defaultName). cawidgets
        // builds a keyset string from this when actionHandler.KeyAction
        // has to look up bindings itself (we never ship an `actions`
        // payload with KeyPress).
        GetKeySymbol: (keyCode: LuaValue) => {
            const sym = keyCodeToSymbol(Number(keyCode) | 0);
            return [sym, sym];
        },
        // Spring.GetKeyBindings(keyset) — array of {[cmd]=opts} entries
        // bound to `keyset`. Matching is two-step: exact (e.g. "s+x")
        // and the special `any+<key>` form ZK relies on for hotkeys
        // that should fire regardless of modifier state. Without this,
        // chili integral menu's tab hotkeys (any+x/c/v/b/n) would never
        // resolve and the actionHandler would fall through to the
        // widget's own KeyPress (which only handles the build grid).
        GetKeyBindings: (keyset: LuaValue) => {
            const ks = canonicalKeySet(String(keyset ?? ''));
            if (!ks) return luaTable();
            const baseKey = ks.includes('+') ? ks.slice(ks.lastIndexOf('+') + 1) : ks;
            const matches: Array<Record<string, string>> = [];
            const pushAll = (entries: Array<{ cmd: string; extra: string }> | undefined) => {
                if (!entries) return;
                for (const b of entries) matches.push({ [b.cmd]: b.extra });
            };
            pushAll(ls.keyBinds.get(ks));
            const anyKey = `any+${baseKey}`;
            if (anyKey !== ks) pushAll(ls.keyBinds.get(anyKey));
            return luaTable(...matches);
        },
        GetActionHotKeys: () => luaTable(),

        // --- Clipboard ---
        GetClipboard: () => '',
        SetClipboard: () => {},

        // --- SDL text input (no-op in browser) ---
        SDLStartTextInput: () => {},
        SDLStopTextInput: () => {},
        SDLSetTextInputRect: () => {},

        // --- Mouse ---
        GetMouseState: () => {
            const m = ls.mouse;
            return [m.x, m.y, m.lmb, m.mmb, m.rmb];
        },
        WarpMouse: () => {},

        // --- Team AI ---
        GetTeamLuaAI: () => '',

        // --- Engine info for camain/cawidgets bootstrap ---
        Ping: () => {},
        GetActivePage: () => 0,
        ForceLayoutUpdate: () => {},
        GetLastUpdateSeconds: () => 0.016,
        MakeFont: () => {},
        Yield: null as LuaValue,  // nil = no yielding

        // --- Game info ---
        IsCheatingEnabled: () => false,
        FixedAllies: () => true,
        GetMenuName: () => '',

        // --- Minimap ---
        GetMiniMapDualScreen: () => false,
        GetMiniMapRotation: () => 0,
        GetMouseMiniMapState: () => {
            // Returns [lmb, mmb, rmb] but only when the mouse is over the
            // minimap rect. Outside it everything reads false even if a
            // button is held — matches Spring's engine-side filter.
            const g = ls.minimapGeometry;
            const m = ls.mouse;
            if (!g || !g.visible || g.width <= 0 || g.height <= 0) {
                return [false, false, false];
            }
            const inside = m.x >= g.x && m.x < g.x + g.width
                && m.y >= g.y && m.y < g.y + g.height;
            if (!inside) return [false, false, false];
            return [m.lmb, m.mmb, m.rmb];
        },

        // --- Team color ---
        SetTeamColor: () => {},
        GetTeamOrigColor: (_teamId: LuaValue) => {
            const id = Number(_teamId ?? 0);
            const colors = [
                [0, 0, 1, 1], [1, 0, 0, 1], [0, 1, 0, 1], [1, 1, 0, 1],
            ];
            return colors[id % colors.length];
        },
        ArePlayersAllied: (p1: LuaValue, p2: LuaValue) => {
            const a = ls.players.get(Number(p1));
            const b = ls.players.get(Number(p2));
            if (a && b) return a.allyTeam === b.allyTeam;
            return Number(p1) === Number(p2);
        },

        // --- Debug / profiler ---
        GetLuaMemUsage: () => [0, 0, 0, 0, 0, 0], // luaUI, luaRules, luaGaia mem usage
        LoadCmdColorsConfig: () => {},

        // --- Command descriptions ---
        GetActiveCmdDescs: () => luaTable(),
        // Return an empty table (NOT null) so widgets that index the
        // result without nil-checking — e.g. gui_easyFacing.lua reads
        // `cmdDesc["type"]` directly — get nil for missing fields
        // instead of erroring on nil-indexing.
        GetActiveCmdDesc: () => luaTable(),
        // Spring contract: returns (cmdIndex, cmdID, cmdType, cmdName).
        // We don't (yet) keep an index into the active cmd-desc list, so
        // return -1 for the index slot — ZK widgets that read just the
        // 2nd return (cmdID) work; the chili tooltip widget will use the
        // name and live without the index. cmdType is 0 (ICON) for all
        // resolved engine cmds. The defaultCommand state is updated each
        // hover-target change by the main thread; the worker dispatches
        // widget:DefaultCommand before storing the final cmdId.
        GetDefaultCommand: () => {
            const dc = ls.defaultCommand;
            const name =
                dc.cmdId === 10  ? 'Move' :
                dc.cmdId === 16  ? 'Fight' :
                dc.cmdId === 20  ? 'Attack' :
                dc.cmdId === 25  ? 'Guard' :
                dc.cmdId === 40  ? 'Repair' :
                dc.cmdId === 90  ? 'Reclaim' :
                dc.cmdId === 125 ? 'Resurrect' :
                dc.cmdId === 130 ? 'Capture' :
                '';
            return [-1, dc.cmdId, 0, name];
        },
        // Spring.GetCmdDescIndex(cmdID) — return the 1-based position of
        // a cmd in the active selection's command desc list. The chili
        // integral menu uses the result to drive SetActiveCommand, so a
        // null/0 return short-circuits the build click entirely. We look
        // up against the first selected unit, mirroring what
        // dispatchCommandsChanged hands to widgetHandler.commands.
        GetCmdDescIndex: (cmdId: LuaValue) => {
            const id = Number(cmdId) | 0;
            const sel = ls.selectedUnitIds[0];
            if (!sel) return null;
            const stored = ls.unitCmdDescs.get(sel);
            if (!stored) return null;
            const idx = stored.findIndex(d => d.cmdId === id);
            return idx >= 0 ? idx + 1 : null;
        },
        // Spring.FindUnitCmdDesc(unitID, cmdID) — same idea, but scoped
        // to a specific unit. Used by the integral menu to look up build
        // entries on a clicked factory regardless of current selection.
        FindUnitCmdDesc: (unitId: LuaValue, cmdId: LuaValue) => {
            const uid = Number(unitId) | 0;
            const id = Number(cmdId) | 0;
            const stored = ls.unitCmdDescs.get(uid);
            if (!stored) return null;
            const idx = stored.findIndex(d => d.cmdId === id);
            return idx >= 0 ? idx + 1 : null;
        },

        // --- Selection commands ---
        // Spring.SelectUnit(unitID[, append]) — replace the selection with
        // a single unit, or add it to the current selection. A nil/zero
        // unitID clears the selection.
        SelectUnit: (unitId: LuaValue, append: LuaValue) => {
            const id = Number(unitId) | 0;
            const ids = id > 0 ? [id] : [];
            applySelection(ls, ctx, ids, !!append);
        },
        // Spring.DeselectUnit(unitID) — remove a single unit from the
        // selection. No-op if it wasn't selected.
        DeselectUnit: (unitId: LuaValue) => {
            const id = Number(unitId) | 0;
            if (id <= 0 || !ls.selectedUnitIds.includes(id)) return;
            const next = ls.selectedUnitIds.filter(u => u !== id);
            ls.selectedUnitIds = next;
            ctx.setSelection?.(next.slice());
        },

        // --- Unit queries that some widgets need ---
        GetUnitIsBuilding: () => null,
        GetUnitIsBeingBuilt: (_id: LuaValue) => {
            const u = ls.units.get(Number(_id));
            // Spring returns (isBeingBuilt: bool, buildProgress: number).
            // Real buildProgress now flows over the wire (FIELD_BUILD_PROGRESS);
            // we no longer have to approximate from health.
            return u ? [u.buildProgress < 1, u.buildProgress] : null;
        },
        // Spring.GetUnitCmdDescs(unitID) — return the unit's command
        // descriptors as a 1-indexed Lua array. Server streams the build
        // entries (cmdId<0) at ~1 Hz; we publish the minimum surface
        // chili / ZK widgets read on the cmd-descs side: id, name,
        // action, type, params, disabled. The widget then looks up the
        // human name and tooltip from UnitDefs[-cmd.id] itself, exactly
        // as it would against a real Spring client. Standing-order
        // toggles (move/stop/attack/patrol/...) are not streamed —
        // chili's command panel reads them off the CMD_* enum on its
        // own, so an empty list for textureless units is fine.
        GetUnitCmdDescs: (unitId: LuaValue) => {
            const uid = Number(unitId);
            const stored = ls.unitCmdDescs.get(uid);
            if (!stored || stored.length === 0) return luaTable();
            const arr: LuaValue[] = stored.map(d => {
                // Server now streams the full descriptor. For build
                // commands we still fall back to the UnitDef name when
                // the server payload's `name` field is empty — this
                // covers older servers (pre-expanded schema) and lets
                // pure-build entries inherit nicer human names.
                let name = d.name;
                let action = d.action;
                let type = d.type;
                if (d.cmdId < 0) {
                    const defId = -d.cmdId;
                    const defName = ctx.getUnitDefName?.(defId) ?? String(defId);
                    if (!name) name = defName;
                    if (!action) action = `buildunit_${defName.toLowerCase()}`;
                    if (!type) type = 20; // CMDTYPE_ICON_BUILDING
                }
                return {
                    id:       d.cmdId,
                    disabled: d.disabled,
                    hidden:   d.hidden,
                    name,
                    action,
                    texture:  d.texture,
                    tooltip:  d.tooltip,
                    type,
                    queueing: true,
                    params:   d.params.length > 0 ? luaTable(...d.params) : luaTable(),
                };
            });
            return luaTable(...arr);
        },
        GetUnitCommandCount: (unitId: LuaValue) => {
            return ls.unitCommands.get(Number(unitId))?.length ?? 0;
        },
        GetUnitCurrentCommand: (unitId: LuaValue) => {
            // Spring returns id, options, tag, params... as multiple values.
            // The current command is the front of the queue.
            const orders = ls.unitCommands.get(Number(unitId));
            const o = orders?.[0];
            if (!o) return null;
            return [o.cmdId, o.options, o.tag, ...o.params];
        },
        GetUnitGroup: (unitId: LuaValue) => {
            const uid = Number(unitId);
            for (const [gid, bucket] of ls.groups) {
                if (bucket.has(uid)) return gid;
            }
            return -1;
        },
        GetUnitDirection: (id: LuaValue) => {
            const u = ls.units.get(Number(id));
            if (!u) return null;
            const h = u.heading / 65535 * Math.PI * 2;
            // RH (Phase 2): heading=0 → -Z. Mirror server's
            // GetVectorFromHeading which negates the LH table entry
            // componentwise. Legacy-LH bridge mirrors Z back to +Z
            // so widgets reading frontdir see the LH convention.
            return [-Math.sin(h), 0, flipDirZ(-Math.cos(h))];
        },
        GetUnitResources: () => [0, 0, 0, 0, 0, 0], // metalMake, metalUse, energyMake, energyUse
        IsUnitVisible: (id: LuaValue) => ls.units.has(Number(id)),
        IsUnitIcon: () => false,

        // --- Camera rotation ---
        GetCameraRotation: () => {
            const dx = ls.camera.tx - ls.camera.px;
            const dy = ls.camera.ty - ls.camera.py;
            const dz = ls.camera.tz - ls.camera.pz;
            const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
            // RH (Phase 2): ry=0 means looking toward -Z. The `-dz`
            // flip aligns with RTSCamera.currentYawDeg and the server
            // heading convention.
            return [Math.asin(-dy / len), Math.atan2(dx, -dz), 0];
        },

        // --- View range ---
        GetViewRange: () => ls.camera.far,

        // --- Audio (post to main thread via worker message) ---
        // Spring.PlaySoundFile(soundFile, volume, posX, posY, posZ,
        //                      speedX, speedY, speedZ, channel)
        // Mirrors Recoil's bind (LuaUnsyncedCtrl.cpp:804-863). The
        // last arg is the mix channel — `"battle"` / `"sfx"`,
        // `"unitreply"` / `"voice"`, `"userinterface"` / `"ui"`,
        // `"general"`, or numeric 1/2/3. speedX/Y/Z are ignored
        // (Web Audio has no Doppler).
        PlaySoundFile: (...args: LuaValue[]) => {
            const soundFile = args[0];
            const volume = args[1];
            const posX = args[2];
            const posY = args[3];
            const posZ = args[4];
            const channelArg = args[8];  // skip speed{X,Y,Z}
            const path = typeof soundFile === 'string' ? soundFile : '';
            if (!path) return false;
            const vol = typeof volume === 'number' ? volume : 1;
            const x = typeof posX === 'number' ? posX : null;
            const y = typeof posY === 'number' ? posY : 0;
            const z = typeof posZ === 'number' ? posZ : null;
            const pos = (x !== null && z !== null)
                ? { x, y, z } : undefined;
            const ch = (typeof channelArg === 'string' ||
                        typeof channelArg === 'number')
                ? channelArg : undefined;
            ctx.playSound?.(path, vol, pos, ch);
            return true;
        },
        PlaySoundStream: (file: LuaValue, volume: LuaValue,
                          _enqueue: LuaValue) => {
            const f = typeof file === 'string' ? file : '';
            if (!f) return;
            const v = typeof volume === 'number' ? volume : 1;
            // The enqueue=true semantic (wait for the current track to
            // end before swapping) isn't honoured yet — we always
            // interrupt with a short crossfade. Recoil callers
            // typically use enqueue for playlist chaining, which the
            // music state machine handles separately.
            ctx.playMusicStream?.(f, v, _enqueue === true);
        },
        StopSoundStream: () => {
            ctx.stopMusicStream?.(250);  // short fade to avoid click
        },
        PauseSoundStream: () => {
            ctx.pauseMusicStream?.();
        },
        SetSoundStreamVolume: (v: LuaValue) => {
            const vol = typeof v === 'number' ? v : 1;
            ctx.setMusicStreamVolume?.(Math.max(0, Math.min(1, vol)));
        },
        GetSoundStreamTime: () => {
            const t = ctx.getMusicStreamTime?.();
            return t ? [t[0], t[1]] : [0, 0];
        },
        SetSoundEffectParams: (...args: LuaValue[]) => {
            const first = args[0];
            if (typeof first === 'string') {
                ctx.setSoundEffectParams?.(first);
            } else if (first && typeof first === 'object') {
                ctx.setSoundEffectParams?.(first as Record<string, unknown>);
            }
        },
        LoadSoundDef: (_file: LuaValue) => {
            // Runtime sound-def merge isn't supported yet — the
            // SoundItem map is loaded once from gamedata/sounds.lua
            // post-VFS-prefetch. Games that ship additional
            // sound-def libraries will need this filled in.
            return false;
        },
        PreloadSoundItem: (_name: LuaValue) => {
            // No-op: AudioManager.loadSound caches on first play and
            // SoundItem.preload=true items are pre-decoded at ingest.
            return false;
        },

        // --- Lua message passing ---
        // SendLuaRulesMsg forwards a binary-safe payload to the server's
        // synced LuaRules state, where it surfaces as
        // `gadget:RecvLuaMsg(msg, playerID)`. ZK widgets (e.g.
        // gui_contextmenu) call this to reach commands gated to the
        // authoritative side. SendLuaUIMsg broadcasts to peer clients' LuaUI
        // via the server (LuaUIMsg → LuaUIMsgRelay → widget:RecvLuaMsg);
        // SendLuaGaiaMsg is still unwired (needs LuaGaia loaded).
        SendLuaUIMsg: (msg: LuaValue, mode?: LuaValue) => {
            if (msg == null) return;
            // Recoil only inspects mode[0]; "" = all, 'a'/'allies', 's'/'specs'.
            let modeByte = 0;
            if (typeof mode === 'string' && mode.length > 0) {
                const c = mode.charCodeAt(0);
                if (c === 97 /* a */ || c === 115 /* s */) modeByte = c;
            }
            ctx.sendLuaUIMsg?.(String(msg), modeByte);
        },
        SendLuaRulesMsg: (msg: LuaValue) => {
            if (msg == null) return;
            ctx.sendLuaRulesMsg?.(String(msg));
        },
        SendLuaGaiaMsg: () => {},
    };

    // `Spring.PathRequest` is an alias for `Spring.RequestPath` — some
    // upstream forks use the former name. Bound here so both refer to
    // the same closure (and same `cursor` / liveState references).
    Spring.PathRequest = Spring.RequestPath;

    // --- io stub ---
    //
    // Some widgets (e.g. scorched_crossing's export_metalmap.lua) use
    // `io.open` to dump debugging data to disk. That's impossible in a
    // browser — we provide a stub so the widget errors cleanly at call
    // time rather than NPE'ing on module access. Returning nil + error
    // mirrors Lua's standard `io.open` on permission failure.
    const io: Record<string, LuaValue> = {
        open: (_path: LuaValue, _mode: LuaValue) => {
            return [null, 'io disabled in browser widget runtime'];
        },
        read:  () => null,
        write: () => null,
        close: () => null,
    };

    // --- LuaUI globals ---
    //
    // Path-like constants and the version string the base widgets.lua
    // might expect. Paper Tanks' game-level widgets.lua (fetched from
    // /api/games/data/papertanks/LuaUI/widgets.lua) also sets these, but
    // providing them here means widgets that run before the game base
    // is prefetched still see sane values.
    const LUAUI_DIRNAME = 'LuaUI/';
    const LUAUI_VERSION = 'spring-web LuaUI v0.1';

    return {
        GL, Game, VFS, Spring,
        io,
        LUAUI_DIRNAME,
        LUAUI_VERSION,
    };
}

/**
 * Project a world-space point to screen coordinates using view+projection matrices.
 * Returns [screenX, screenY, depth] or null if behind camera.
 */
function projectToScreen(
    wx: number, wy: number, wz: number,
    view: Float32Array, proj: Float32Array,
    vpW: number, vpH: number,
): [number, number, number] | null {
    // view * worldPos (column-major 4x4)
    const vx = view[0] * wx + view[4] * wy + view[8] * wz + view[12];
    const vy = view[1] * wx + view[5] * wy + view[9] * wz + view[13];
    const vz = view[2] * wx + view[6] * wy + view[10] * wz + view[14];
    const vw = view[3] * wx + view[7] * wy + view[11] * wz + view[15];
    // proj * viewPos
    const cx = proj[0] * vx + proj[4] * vy + proj[8] * vz + proj[12] * vw;
    const cy = proj[1] * vx + proj[5] * vy + proj[9] * vz + proj[13] * vw;
    const cz = proj[2] * vx + proj[6] * vy + proj[10] * vz + proj[14] * vw;
    const cw = proj[3] * vx + proj[7] * vy + proj[11] * vz + proj[15] * vw;
    if (cw <= 0) return null; // behind camera
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    // NDC [-1,1] → screen coords. Spring Y is bottom-up.
    const sx = (ndcX * 0.5 + 0.5) * vpW;
    const sy = (1 - (ndcY * 0.5 + 0.5)) * vpH;
    return [sx, sy, cz / cw];
}

/**
 * Invert a column-major 4×4 matrix in-place into `out`. Returns false (and
 * leaves out untouched) when the matrix is singular. Adapted from the
 * standard cofactor expansion used by gluInvertMatrix.
 */
function mat4Inverse(m: ArrayLike<number>, out: Float32Array): boolean {
    const m00 = m[0],  m01 = m[1],  m02 = m[2],  m03 = m[3];
    const m10 = m[4],  m11 = m[5],  m12 = m[6],  m13 = m[7];
    const m20 = m[8],  m21 = m[9],  m22 = m[10], m23 = m[11];
    const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

    const c00 =  m11 * (m22 * m33 - m23 * m32) - m12 * (m21 * m33 - m23 * m31) + m13 * (m21 * m32 - m22 * m31);
    const c01 = -m10 * (m22 * m33 - m23 * m32) + m12 * (m20 * m33 - m23 * m30) - m13 * (m20 * m32 - m22 * m30);
    const c02 =  m10 * (m21 * m33 - m23 * m31) - m11 * (m20 * m33 - m23 * m30) + m13 * (m20 * m31 - m21 * m30);
    const c03 = -m10 * (m21 * m32 - m22 * m31) + m11 * (m20 * m32 - m22 * m30) - m12 * (m20 * m31 - m21 * m30);

    const det = m00 * c00 + m01 * c01 + m02 * c02 + m03 * c03;
    if (Math.abs(det) < 1e-12) return false;
    const invDet = 1 / det;

    const c10 = -m01 * (m22 * m33 - m23 * m32) + m02 * (m21 * m33 - m23 * m31) - m03 * (m21 * m32 - m22 * m31);
    const c11 =  m00 * (m22 * m33 - m23 * m32) - m02 * (m20 * m33 - m23 * m30) + m03 * (m20 * m32 - m22 * m30);
    const c12 = -m00 * (m21 * m33 - m23 * m31) + m01 * (m20 * m33 - m23 * m30) - m03 * (m20 * m31 - m21 * m30);
    const c13 =  m00 * (m21 * m32 - m22 * m31) - m01 * (m20 * m32 - m22 * m30) + m02 * (m20 * m31 - m21 * m30);
    const c20 =  m01 * (m12 * m33 - m13 * m32) - m02 * (m11 * m33 - m13 * m31) + m03 * (m11 * m32 - m12 * m31);
    const c21 = -m00 * (m12 * m33 - m13 * m32) + m02 * (m10 * m33 - m13 * m30) - m03 * (m10 * m32 - m12 * m30);
    const c22 =  m00 * (m11 * m33 - m13 * m31) - m01 * (m10 * m33 - m13 * m30) + m03 * (m10 * m31 - m11 * m30);
    const c23 = -m00 * (m11 * m32 - m12 * m31) + m01 * (m10 * m32 - m12 * m30) - m02 * (m10 * m31 - m11 * m30);
    const c30 = -m01 * (m12 * m23 - m13 * m22) + m02 * (m11 * m23 - m13 * m21) - m03 * (m11 * m22 - m12 * m21);
    const c31 =  m00 * (m12 * m23 - m13 * m22) - m02 * (m10 * m23 - m13 * m20) + m03 * (m10 * m22 - m12 * m20);
    const c32 = -m00 * (m11 * m23 - m13 * m21) + m01 * (m10 * m23 - m13 * m20) - m03 * (m10 * m21 - m11 * m20);
    const c33 =  m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20);

    // Adjugate / det, column-major: out[col*4 + row] = cof[row][col] * invDet
    out[0]  = c00 * invDet; out[1]  = c10 * invDet; out[2]  = c20 * invDet; out[3]  = c30 * invDet;
    out[4]  = c01 * invDet; out[5]  = c11 * invDet; out[6]  = c21 * invDet; out[7]  = c31 * invDet;
    out[8]  = c02 * invDet; out[9]  = c12 * invDet; out[10] = c22 * invDet; out[11] = c32 * invDet;
    out[12] = c03 * invDet; out[13] = c13 * invDet; out[14] = c23 * invDet; out[15] = c33 * invDet;
    return true;
}

/** Multiply two column-major 4×4 matrices: out = a * b. */
function mat4Mul(a: ArrayLike<number>, b: ArrayLike<number>, out: Float32Array): void {
    for (let col = 0; col < 4; col++) {
        const b0 = b[col * 4], b1 = b[col * 4 + 1], b2 = b[col * 4 + 2], b3 = b[col * 4 + 3];
        out[col * 4]     = a[0] * b0 + a[4] * b1 + a[8]  * b2 + a[12] * b3;
        out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9]  * b2 + a[13] * b3;
        out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
}

const _invVP = new Float32Array(16);
const _mvp   = new Float32Array(16);

/**
 * Cast a ray from a screen pixel through the world and return where it
 * meets the heightmap, or null if the screen point is invalid (no VP
 * matrices yet, ray parallel to ground, hit behind camera).
 *
 * sx/sy are Spring screen coords: pixels with Y-up (y=0 at bottom).
 */
function screenPointToGround(
    sx: number, sy: number,
    view: Float32Array, proj: Float32Array,
    vpW: number, vpH: number,
    ctx: SpringAPIContext,
): [number, number, number] | null {
    mat4Mul(proj, view, _mvp);
    if (!mat4Inverse(_mvp, _invVP)) return null;

    const ndcX = (sx / vpW) * 2 - 1;
    const ndcY = (sy / vpH) * 2 - 1;

    // Unproject near (ndcZ=-1) and far (ndcZ=+1) NDC points.
    const unproject = (nz: number): [number, number, number] | null => {
        const x = _invVP[0] * ndcX + _invVP[4] * ndcY + _invVP[8]  * nz + _invVP[12];
        const y = _invVP[1] * ndcX + _invVP[5] * ndcY + _invVP[9]  * nz + _invVP[13];
        const z = _invVP[2] * ndcX + _invVP[6] * ndcY + _invVP[10] * nz + _invVP[14];
        const w = _invVP[3] * ndcX + _invVP[7] * ndcY + _invVP[11] * nz + _invVP[15];
        if (Math.abs(w) < 1e-9) return null;
        return [x / w, y / w, z / w];
    };
    const near = unproject(-1);
    const far  = unproject(+1);
    if (!near || !far) return null;

    const dx = far[0] - near[0];
    const dy = far[1] - near[1];
    const dz = far[2] - near[2];

    // Intersect with horizontal plane y=0 first (cheap), then refine the
    // y by sampling the heightmap. This is good enough for mostly-flat
    // terrain; ray-marching the heightmap would be more accurate on cliffs
    // but adds complexity we don't yet need.
    if (Math.abs(dy) < 1e-6) return null;
    const t = -near[1] / dy;
    if (t < 0) return null;
    const wx = near[0] + dx * t;
    const wz = near[2] + dz * t;
    const wy = sampleHeight(ctx, wx, wz);
    return [wx, wy, wz];
}

/**
 * Sample the per-allyteam LOS bitmap at world (x, z). Backs
 * `Spring.IsPosInLos / IsPosInRadar / IsPosInAirLos`. Returns false
 * when:
 *   - the bitmap hasn't streamed yet (first second of the game);
 *   - the caller asks about an ally team we have no bitmap for
 *     (non-spectator querying a foreign ally team's vision).
 * Air-LOS folds into the `radar` plane on the wire (see
 * `IntelEventCollector::BuildLosBitmap`); Phase 7 will split it out.
 */
function sampleLosPlane(ctx: SpringAPIContext, ls: LiveState,
                        plane: 'los' | 'radar',
                        x: number, z: number,
                        allyTeam?: number): boolean {
    const at = allyTeam ?? ls.identity.myAllyTeam;
    const bitmap = ls.losBitmaps.get(at);
    if (!bitmap) return false;
    const mapW = ctx.mapSizeX || 1;
    const mapH = ctx.mapSizeZ || 1;
    const col = Math.floor((x / mapW) * bitmap.width);
    const row = Math.floor((z / mapH) * bitmap.height);
    if (col < 0 || col >= bitmap.width || row < 0 || row >= bitmap.height) return false;
    const idx = row * bitmap.width + col;
    const byte = idx >> 3;
    const bit = 7 - (idx & 7);
    const arr = plane === 'los' ? bitmap.inLos : bitmap.inRadar;
    return (arr[byte] & (1 << bit)) !== 0;
}

/**
 * Approximate the ground normal at world position (x, z) from the
 * heightmap gradient. Cross product of the local east/south vectors
 * including their height differences produces an outward-facing
 * normal; we normalise it before returning. Mirrors Spring's
 * Spring.GetGroundNormal output shape (returns x, y, z, slope).
 */
function computeGroundNormal(ctx: SpringAPIContext, x: number, z: number): [number, number, number, number] {
    const sq = ctx.squareSize || 8;
    const hL = sampleHeight(ctx, x - sq, z);
    const hR = sampleHeight(ctx, x + sq, z);
    const hD = sampleHeight(ctx, x, z - sq);
    const hU = sampleHeight(ctx, x, z + sq);
    // dx/dz are local tangents; cross(dz, dx) yields a +Y normal.
    const nx = (hL - hR);
    const nz = (hD - hU);
    const ny = 2 * sq;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    const ix = nx / len, iy = ny / len, iz = nz / len;
    // Slope = 1 - dot(normal, up) — a flat surface returns 0.
    return [ix, iy, iz, 1 - iy];
}

/**
 * Snap a world-space coordinate to the build grid for a unit with the
 * given footprint size (in build squares). Mirrors Spring's
 * `Pos2BuildPos`: even-footprint dims align to the SQ-grid corners
 * (multiples of SQ), odd dims align to the SQ-grid centres (multiples
 * of SQ offset by SQ/2). This guarantees the rendered footprint covers
 * an integral number of build squares regardless of cursor pixel jitter.
 */
function snapBuildCoord(coord: number, footprint: number, sq: number): number {
    if (footprint <= 0) return coord;
    // Spring's actual formula (BuildInfo::Pos2BuildPos):
    //   if (footprint & 1) coord = floor(coord / sq) * sq + sq/2;  // odd → centre
    //   else               coord = floor((coord + sq/2) / sq) * sq; // even → corner
    if ((footprint & 1) !== 0) {
        return Math.floor(coord / sq) * sq + sq * 0.5;
    }
    return Math.floor((coord + sq * 0.5) / sq) * sq;
}

/**
 * Sample the heightmap at world position (x, z). Uses bilinear interpolation
 * over the 4 nearest corner heights. Mirrors Spring's Spring.GetGroundHeight.
 */
function sampleHeight(ctx: SpringAPIContext, x: number, z: number): number {
    const squareSize = ctx.squareSize;
    const gx = Math.max(0, Math.min(ctx.heightmapWidth - 2, x / squareSize));
    const gz = Math.max(0, Math.min(ctx.heightmapHeight - 2, z / squareSize));
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const stride = ctx.heightmapWidth;
    const h00 = ctx.heightmap[iz * stride + ix];
    const h10 = ctx.heightmap[iz * stride + ix + 1];
    const h01 = ctx.heightmap[(iz + 1) * stride + ix];
    const h11 = ctx.heightmap[(iz + 1) * stride + ix + 1];
    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    const raw = h0 * (1 - fz) + h1 * fz;
    // Heightmap stores uint16 in the range [0, 65535] mapped linearly
    // to [minHeight, maxHeight].
    return ctx.minHeight + (raw / 65535) * (ctx.maxHeight - ctx.minHeight);
}

/**
 * Load a Lua source string in a *sub-runtime* and return the value the
 * chunk returns. Used by VFS.Include. We can't use the caller's runtime
 * because loading source into it would pollute globals; executing in a
 * fresh state captures the return cleanly.
 */
function includeLuaFile(source: string, chunkName: string, ctx: SpringAPIContext): LuaValue {
    const sub = new LuaRuntime(`include:${chunkName}`);
    // Install the same stub surface the caller had. mapinfo.lua uses
    // VFS.Include("maphelper/mapinfo.lua"), Spring.*, Game.*, so we need
    // to recursively provide these.
    const subGlobals = buildSpringGlobals(ctx);
    for (const [k, v] of Object.entries(subGlobals)) sub.setGlobal(k, v);
    // Patch the source: many mapinfo.lua files end with `return mapinfo`
    // but some just define the global. If there's no explicit return,
    // append one so the chunk yields a value.
    const patched = /\breturn\s+\w+\s*$/m.test(source)
        ? source
        : source + '\nreturn mapinfo';
    const err = sub.doString(patched, chunkName);
    if (err) {
        console.warn(`[VFS.Include] ${chunkName}: ${err}`);
        sub.dispose();
        return null;
    }
    // Read the return value at the top of the stack. doString uses pcall
    // with LUA_MULTRET so the chunk's return value (if any) is there.
    let result: LuaValue = null;
    if (lua.lua_gettop(sub.L) > 0) {
        result = sub.readValue(-1);
    }
    if (result === null) {
        // Fallback: grab the `mapinfo` global directly.
        lua.lua_getglobal(sub.L, to_luastring('mapinfo'));
        result = sub.readValue(-1);
    }
    sub.dispose();
    return result;
}
