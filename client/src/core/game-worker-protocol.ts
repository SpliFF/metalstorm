/**
 * Game-processor worker ⇄ main-thread message contract (PLAN-game-worker.md GW4).
 *
 * Frozen contract for the worker consolidation: the game-processor worker owns
 * the WebTransport connection + decoders + Babylon render core + LuaUI on one
 * OffscreenCanvas; the main thread keeps only DOM/HTML UI, AudioContext, raw
 * input capture, and HTTP auth/lobby. These interfaces are the bounded surface
 * across that boundary — freeze them; do not grow ad hoc (PLAN-game-worker.md
 * "GW4 implementation spec" + PLAN-renderer-in-worker.md interfaces #2–#5).
 *
 * Direction is encoded in the type names: `Gp*ToWorker` is main→worker,
 * `Gp*ToMain` is worker→main. Every message carries a discriminant `type`.
 *
 * NOTE: this module is the source of truth the GW4-c1…c6 cut builds against; it
 * is intentionally landed first (spec-first) and has no runtime behaviour. The
 * worker (lua-widget-worker.ts, evolving into the game-processor worker) and the
 * manager (lua-widget-manager.ts) import these as they take on each role.
 */

import type { RmlOpsToMain, RmlEventToWorker, RmlResizeToWorker } from '../ui/rml/rml-protocol.js';
import type { ResourceUpdateInfo, OrgGroupInfoMsg, DirectiveInfoMsg, RosterPlayerInfo } from './connection.js';
import type { PresentationClockStats } from './presentation-clock.js';

// ─── main → worker ──────────────────────────────────────────────────────────

/**
 * One-shot bootstrap. The transferred `canvas` is the page's `#game-canvas`
 * (the old transparent UI-overlay canvas is retired — one canvas, one GL
 * context). The worker fetches `/api/wt/info` from `gameHttpUrl` itself to
 * discover the WebTransport endpoint + dev cert hash, then opens the session
 * and auths with `{username, token}` (token reconnect against the game server).
 */
export interface GpInitToWorker {
    type: 'gp:init';
    /** Transferred `#game-canvas` (pass in the `transfer` list of postMessage). */
    canvas: OffscreenCanvas;
    /** `http://host:gamePort` — base for `/api/wt/info` discovery + asset fetch. */
    gameHttpUrl: string;
    /** `''` → resolve `/api/*` against the page origin (dev: Vite proxy). */
    lobbyUrl: string;
    username: string;
    /** Game-server auth token (token-reconnect; shared lobby SQLite). */
    token: string;
    gameId: string;
    mapId: string;
    /**
     * Team-color shader lighting style from the game's modinfo (`lighting`
     * field), surfaced via the lobby's `/api/games`. `'gameplay'` (default)
     * or `'realistic'`. Plumbed so the worker renders each game's authored
     * style instead of a hardcoded default (PLAN-bar.md A4). Optional —
     * absent ⇒ `'gameplay'`.
     */
    lighting?: string;
    /**
     * Which client model-material *port* the game wants applied, from the
     * game's modinfo (`modelMaterialPort`) via the lobby's `/api/games`
     * (PLAN-bar.md A4). The worker applies its hand-ported material only
     * when this matches the port id that port reproduces (e.g. `'zk-939'`),
     * otherwise the engine-default material. Absent/empty ⇒ engine-default.
     */
    modelMaterialPort?: string;
    /** Content-addressed defs path the server baked at startup (`''` = none). */
    defsCacheKey: string;
    /** Build stamp for `stampUrl()` asset versioning from inside the worker. */
    buildStamp: string;
    /** Initial canvas backing-store sizing. */
    width: number;
    height: number;
    dpr: number;
    /** `clientSettings` gfx.* snapshot; later changes arrive via `gp:config`. */
    gfx: Record<string, unknown>;
    /** Lifted from `localStorage` on main (standing-order-renderer SHOW_ALLIES). */
    standingOrderShowAllies: boolean;
    // NOTE: this used to carry a lobby room roster snapshot to seed
    // `liveState.players` before the LuaUI boot. It claimed lobby `player_id`
    // was the game-server playerID; it is not — it is the DB account id, and
    // the snapshot had no AI slots (PLAN-endtoend D3). Replaced by the server's
    // `PlayerRoster` broadcast, which arrives on auth (also before the boot).
    /**
     * PLAN-client-resilience.md task 3: server-operator opt-out for the
     * `/api/client-errors` report channel (spring-lobby `--disable-client-
     * error-reports`, surfaced via `/api/version`). Absent/true ⇒ enabled —
     * the courtesy default is off only in a self-hosted "sample config"
     * deployment that explicitly disables it.
     */
    errorReportingEnabled?: boolean;
}

/**
 * Raw input forwarded from the main-thread `CameraInput` DOM listeners.
 * Coordinates are canvas-relative CSS pixels, origin **top-left, y-down** —
 * Babylon's native screen space (so `scene.pick` and the camera math consume
 * them directly; the worker scales by dpr for picking). The LuaUI widget callins
 * that want Spring's bottom-left convention get a single `canvasH - y` flip at
 * the worker boundary (GW4-c6). `mods` is a bitmask: 1=shift, 2=ctrl, 4=alt,
 * 8=meta.
 *
 * `viewId` routes the input to the matching WorkerCamera in the worker's
 * `Map<viewId, WorkerCamera>` (multi-view, PLAN-game-worker.md). Optional;
 * absent ⇒ view 0. c5b ships a single view (id 0).
 */
export type GpInputToWorker =
    | { type: 'gp:pointermove'; x: number; y: number; buttons: number; mods: number; viewId?: number }
    | { type: 'gp:pointerdown'; x: number; y: number; button: number; mods: number; viewId?: number }
    | { type: 'gp:pointerup'; x: number; y: number; button: number; mods: number; viewId?: number }
    | { type: 'gp:wheel'; x: number; y: number; delta: number; mods: number; viewId?: number }
    | { type: 'gp:keydown'; code: string; mods: number; viewId?: number }
    | { type: 'gp:keyup'; code: string; mods: number; viewId?: number }
    | { type: 'gp:pointerleave'; viewId?: number }
    | { type: 'gp:blur'; viewId?: number }
    | { type: 'gp:resize'; width: number; height: number; dpr: number; viewId?: number };

/** Live push of a single clientSettings/gfx key change (init carries the snapshot). */
export interface GpConfigToWorker {
    type: 'gp:config';
    key: string;
    value: unknown;
}

/**
 * Re-centre the worker camera on a world XZ position (GW4-c5c-3). Posted by
 * the main-thread minimap on a left click — the minimap is a DOM/own-Engine
 * element on main, but the world camera lives in the worker, so the focus
 * intent crosses the boundary. `viewId` absent ⇒ view 0.
 */
export interface GpFocusWorldToWorker {
    type: 'gp:focusWorld';
    x: number;
    z: number;
    viewId?: number;
}

/**
 * Arm build placement from the native BuildMenu's click (PLAN-playable.md G3a).
 * The build menu is DOM/on-main, but placement (ghost + snap + order emission)
 * lives in the worker's WorkerBuildPlacement, so the intent crosses the
 * boundary. `shift`/`ctrl` carry through to the Command options bitmask:
 * factories → batch multiplier (×5/×20/×100); builders → shift queues + keeps
 * placement armed for chain-building. Mirrors the GpFocusWorldToWorker pattern.
 */
export interface GpStartBuildPlacementToWorker {
    type: 'gp:startBuildPlacement';
    defId: number;
    shift: boolean;
    ctrl: boolean;
}

/** Cancel an armed build placement (ESC / selection change on main). */
export interface GpCancelBuildPlacementToWorker {
    type: 'gp:cancelBuildPlacement';
}

/**
 * Cancel queued build order(s) from the native FactoryQueuePanel
 * (PLAN-playable.md G4). `tags` are the order tags to drop — a single tag
 * pops one instance off the tail of a run; the panel's full-group button
 * sends every tag in the run. Resolves to a plain `CMD.REMOVE` (by tag, no
 * OPT.ALT) issued against `unitId` — the worker owns the connection, so the
 * intent crosses the boundary the same way `gp:startBuildPlacement` does.
 */
export interface GpRemoveFactoryOrderToWorker {
    type: 'gp:removeFactoryOrder';
    unitId: number;
    tags: number[];
}

/** Cancel an armed modal command / in-flight area-attack or waypoint drag
 *  (ESC on main, PLAN-playable.md G3b). Mirrors GpCancelBuildPlacementToWorker. */
export interface GpCancelCommandModeToWorker {
    type: 'gp:cancelCommandMode';
}

/**
 * PLAN-client-resilience.md task 1: heartbeat watchdog probe. Main posts one
 * every 2s (HeartbeatWatchdog, main.ts); the worker replies `gp:pong` with the
 * same `id` from the very top of its message dispatcher (game-processor.ts is
 * not on the fast path — a wedged Fengari loop or a stalled render loop must
 * not stop the pong). A blocked worker event loop simply never processes this
 * message at all, which is exactly the "wedged" signal the watchdog looks for
 * — no payload beyond the id is needed.
 */
export interface GpPingToWorker {
    type: 'gp:ping';
    id: number;
}

/**
 * PLAN-quickstart.md §3.1 (Part B — detach): park the game session without
 * tearing the worker down. The worker closes its game connection (a clean
 * PlayerRemoved with a `detach` reason), pauses the render loop and stops the
 * viewport pump — engine, scene, models, DefCache and JS UI state all stay
 * alive. Re-entry is a `gp:resync`, not a fresh `gp:init`. No payload: the
 * worker already holds the connect creds captured at `gp:init`.
 */
export interface GpDetachToWorker {
    type: 'gp:detach';
}

/**
 * PLAN-quickstart.md §3.2 (Part B — resync): re-enter a parked session. The
 * worker flushes *dynamic* renderer state (entity/projectile/combat-FX/
 * interpolator), keeps *static* state (terrain, models, DefCache, lighting, UI),
 * re-opens the game connection with its captured creds (a fresh server-side
 * ClientSession re-streams a full snapshot + defs; DefCache no-ops the dups) and
 * un-pauses the render loop. Optionally carries a refreshed token in case the
 * original has aged past the parked TTL.
 */
export interface GpResyncToWorker {
    type: 'gp:resync';
    /** Refreshed game-server auth token; falls back to the gp:init token. */
    token?: string;
}

/**
 * 8a-follow-on: the access token was renewed on the main thread — adopt it.
 *
 * A worker realm has no `localStorage`, so "make the holders re-read" is not
 * available here at any price: the worker's credential is whatever was handed
 * to it at `gp:init`, and at a 1 h access TTL that string dies inside a normal
 * match. It is used for two things — the game-server `AuthRequest` on every
 * (re)connect, and the error-telemetry channel — and the reconnect is the one
 * that matters, because R1/R2 recovery and `gp:resync` both re-authenticate
 * with it long after boot.
 *
 * Idempotent: the sender drops repeats of the same string.
 */
export interface GpTokenToWorker {
    type: 'gp:token';
    token: string;
}

/**
 * PLAN-client-resilience.md task 2 (R1 soft rung): main asks the worker for an
 * in-place soft reset — Babylon `wipeCaches` + transient FX-pool flush + a
 * fresh-snapshot resync — instead of a full respawn. The worker replies
 * `gp:recovered` with the same `id`. Driven by the RecoveryLadder's `softReset`
 * dep when a lost WebGL context restores; a non-ack (worker too wedged to
 * answer within the round-trip timeout) escalates the ladder to R2.
 */
export interface GpRecoverToWorker {
    type: 'gp:recover';
    id: number;
}

// ─── Macro command & control (PLAN-macro-orders / PLAN-macro-directives) ──
//
// The Connection (and therefore the wire) lives in the worker; the org
// panel (PLAN-macro-ui.md §3) is DOM/main. These cross the boundary the same
// way gp:startBuildPlacement/gp:removeFactoryOrder do for the build menu.

/** Org panel "New Platoon" — create a group from a set of squad ids
 *  (typically the current world selection). */
export interface GpOrgGroupCreateToWorker {
    type: 'gp:orgGroupCreate';
    name: string;
    memberIds: number[];
}

/** Org panel roster/name edit (rename, add/remove members). */
export interface GpOrgGroupUpdateToWorker {
    type: 'gp:orgGroupUpdate';
    groupId: number;
    addIds: number[];
    removeIds: number[];
    name?: string;
}

/** Org panel disband button. */
export interface GpOrgGroupDisbandToWorker {
    type: 'gp:orgGroupDisband';
    groupId: number;
}

/** Org panel posture-chip edit. */
export interface GpGroupPostureToWorker {
    type: 'gp:groupPosture';
    groupId: number;
    postureJson: string;
}

/** Org panel directive pause/resume/priority-bump (resend with the same
 *  `directiveId`) or cancel (`gp:groupDirectiveRemove`). Pause/resume reuses
 *  the full landed `GroupDirective` shape (the panel echoes the `DirectiveInfo`
 *  it already has, flipping only `active`). */
export interface GpGroupDirectiveUpdateToWorker {
    type: 'gp:groupDirectiveUpdate';
    directiveId: number;
    groupId: number;
    directiveType: number;
    shape: number;
    params: number[];
    priority: number;
    requestedStrength: number;
    active: boolean;
    /** Subject-slot conditions for an ungrouped (condition-scoped) directive.
     *  `unitClass` is a command-language class name, resolved to the wire's
     *  `squad_types` inside the worker — the streamed def table it needs lives
     *  there, not on the UI thread. Absent = unfiltered, the pre-D56 shape. */
    conditions?: { idleOnly?: boolean; unitClass?: string };
}

export interface GpGroupDirectiveRemoveToWorker {
    type: 'gp:groupDirectiveRemove';
    directiveId: number;
}

/** Select an org group's roster (org panel row click → world selection, so
 *  the group highlights and its cmd-descs stream — PLAN-macro-ui.md §1). */
export interface GpSelectOrgGroupToWorker {
    type: 'gp:selectOrgGroup';
    groupId: number;
}

/**
 * Arm the shared `ShapeGestureCapture`/`DirectiveShapeCapture` for a
 * click/paint gesture (PLAN-macro-ui.md §2). This is the cross-thread arm
 * surface metalstorm-scripting task 4 (map-arm integration) reuses — a
 * native JS widget (org panel's "paint directive" button, or a scripting
 * command-composer target-slot) arms the SAME worker-side capture instance
 * a directive hotkey would, rather than reimplementing gesture capture.
 */
export interface GpArmDirectiveShapeToWorker {
    type: 'gp:armDirectiveShape';
    directiveType: number;
    groupId: number;
    shape: 'Point' | 'Circle' | 'Polygon' | 'Polyline';
    priority?: number;
    requestedStrength?: number;
    /** Polyline only: freehand-drag capture instead of click-chained
     *  vertices (PLAN-macro-ui.md §7 — both are supported). */
    freehand?: boolean;
    /** Polyline only: the 2-vertex "arrow" convenience (drag start→end,
     *  wheel sets frontage) instead of a general click-chained front line. */
    arrow?: boolean;
    /** When true, a completed gesture does NOT auto-send a `GroupDirective` —
     *  `DirectiveShapeCapture.commit()` returns the raw shape/params via
     *  `gp:directiveShapeResult` instead (metalstorm-scripting task 4: the
     *  command composer's Target slot wants the drawn shape to fill the slot
     *  for review/commit through its own Commit button, not an immediate
     *  direct send — the org-panel "paint directive" button is the only
     *  caller that wants the auto-send behaviour). */
    captureOnly?: boolean;
}

/** Cancel an in-progress `gp:armDirectiveShape` capture (ESC on main, or the
 *  arming widget itself backing out). Safe when nothing is armed. */
export interface GpCancelDirectiveShapeToWorker {
    type: 'gp:cancelDirectiveShape';
}

// ─── native-widget sendCommand bridge (integration.ts → Connection) ─────────
// The native-UI widgets (command composer et al.) run on the main thread but
// the live Connection lives inside the game-processor worker, so main.ts's
// CommandConnection proxy forwards each send over this channel. Org-group /
// directive verbs reuse the gp:orgGroup* / gp:groupDirective* messages above;
// the messages below cover the verbs that had no gp:* carrier yet.

/** Command composer commit: condition-scoped standing order (groupId==0). */
export interface GpStandingOrderCreateToWorker {
    type: 'gp:standingOrderCreate';
    orderType: number;
    priority: number;
    params: number[];
    expiresInFrames: number;
}

/** Widget → synced LuaRules message (gadget:RecvLuaMsg). */
export interface GpLuaRulesMsgToWorker {
    type: 'gp:luaRulesMsg';
    data: Uint8Array | string;
}

/** Widget-issued console command (scope: 'game' | 'server'). */
export interface GpConsoleCommandToWorker {
    type: 'gp:consoleCommand';
    scope: string;
    command: string;
}

/** Widget-issued unit order (none send this yet; carried for completeness of
 *  the CommandConnection surface). */
export interface GpPlayerCommandToWorker {
    type: 'gp:playerCommand';
    commandId: number;
    unitIds: number[];
    params: number[];
    options: number;
}

/** Widget-driven selection replacement (routed to the worker's selection
 *  manager, which owns the debounced SelectionState wire send). */
export interface GpSelectionStateToWorker {
    type: 'gp:selectionState';
    unitIds: number[];
}

/** Playback control for a replay server (PLAN-replay task 4b). The bar lives
 *  on the main thread (it is DOM, and it must survive a worker recycle), the
 *  connection lives in the worker, so the intent crosses here — the same shape
 *  `gp:startBuildPlacement` uses. `action` mirrors `ReplayControlAction`. */
export interface GpReplayControlToWorker {
    type: 'gp:replayControl';
    action: number;
    speed?: number;
    frame?: number;
    povTeam?: number;
}

export type GpMessageToWorker =
    | GpInitToWorker
    | GpInputToWorker
    | GpConfigToWorker
    | GpFocusWorldToWorker
    | GpStartBuildPlacementToWorker
    | GpCancelBuildPlacementToWorker
    | GpRemoveFactoryOrderToWorker
    | GpCancelCommandModeToWorker
    | GpPingToWorker
    | GpDetachToWorker
    | GpResyncToWorker
    | GpTokenToWorker
    | GpRecoverToWorker
    | GpOrgGroupCreateToWorker
    | GpOrgGroupUpdateToWorker
    | GpOrgGroupDisbandToWorker
    | GpGroupPostureToWorker
    | GpGroupDirectiveUpdateToWorker
    | GpGroupDirectiveRemoveToWorker
    | GpSelectOrgGroupToWorker
    | GpArmDirectiveShapeToWorker
    | GpCancelDirectiveShapeToWorker
    | GpStandingOrderCreateToWorker
    | GpLuaRulesMsgToWorker
    | GpConsoleCommandToWorker
    | GpPlayerCommandToWorker
    | GpSelectionStateToWorker
    | GpReplayControlToWorker
    // PLAN-rml.md: DOM events + viewport changes routed back to the worker-side
    // RmlUi proxy (rml-bridge.ts) for Lua listener dispatch / dp-ratio recompute.
    | RmlEventToWorker
    | RmlResizeToWorker
    | { type: 'gp:shutdown' };

// ─── worker → main ──────────────────────────────────────────────────────────

/**
 * A render-ready build-menu tile (PLAN-playable.md G3a). The worker resolves
 * the buildable defId set for the current selection (union of build cmds across
 * own-team selected units) against its def cache and posts these to the native
 * BuildMenu on main via `gp:sceneState.buildOptions`. No Babylon objects cross;
 * the DOM menu resolves `buildPic` to a URL against the game's `unitpics/`.
 */
export interface BuildMenuTile {
    defId: number;
    name: string;
    humanName: string;
    buildPic: string;
    metalCost: number;
    energyCost: number;
    buildTime: number;
    tooltip: string;
}

/**
 * A production-queue row for the native FactoryQueuePanel (PLAN-playable.md
 * G4). The worker groups the selected factory's command queue into
 * consecutive same-defId runs (Spring's FactoryCAI stacks repeated identical
 * build commands one-per-slot) and posts these via
 * `gp:sceneState.factoryQueue`. `tags` carries every order tag in the run,
 * oldest→newest, so the panel can pop one (`tags.at(-1)`) or cancel the
 * whole row (`tags`) via `gp:removeFactoryOrder`.
 */
export interface FactoryQueueTile {
    /** The factory unit this row belongs to (first own-team factory in the
     *  current selection — multi-factory queue merging isn't implemented). */
    unitId: number;
    defId: number;
    name: string;
    humanName: string;
    buildPic: string;
    count: number;
    tags: number[];
}

/** Per-selected-unit facts the HTML HUD needs (no Babylon objects cross the wire). */
export interface GpSelectedUnit {
    id: number;
    defId: number;
    team: number;
    health: number;
    maxHealth: number;
    x: number;
    y: number;
    z: number;
}

/**
 * Consolidated scene-state feed for the HTML UI (~10 Hz / on change). This is
 * the *only* channel the DOM layer reads world facts from — freeze the payload.
 * Camera pose drives the main-thread audio listener + minimap.
 */
/**
 * L0 timing telemetry for the main-thread TimingOverlay (F10). The
 * PresentationClock lives in the worker (it is fed by the in-worker
 * connection and ticked by the render loop), so main can only observe it
 * through a snapshot — this is that snapshot: the clock's own stats plus the
 * arrival-deviation samples the overlay's histogram bins and the active
 * netSim condition. Absent until the worker's clock exists.
 * PLAN-latency-impl.md L-pre.3.
 */
export interface GpTimingState extends PresentationClockStats {
    /** Recent signed snapshot-arrival deviations, ms (histogram input). */
    arrivalDeviations: number[];
    /** Active artificial-latency injection (window.test.netSim*). */
    netSim: { enabled: boolean; delayMs: number; jitterMs: number; lossProb: number };
}

export interface GpSceneStateToMain {
    type: 'gp:sceneState';
    /** Source view (multi-view, PLAN-game-worker.md). Absent ⇒ view 0. */
    viewId?: number;
    selectedUnitIds: number[];
    selected: GpSelectedUnit[];
    hovered: { id: number } | null;
    /** Camera position + look target (world space). */
    camera: { x: number; y: number; z: number; tx: number; ty: number; tz: number };
    gameFrame: number;
    paused: boolean;
    simSpeed: number;
    buildGhost: { pos: [number, number, number]; defId: number; valid: boolean } | null;
    /** PLAN-playable.md G3b: a modal command / area-attack is armed → main
     *  swallows ESC to cancel it (before the build-ghost cancel + quit dialog). */
    commandModeArmed?: boolean;
    entityCount: number;
    /** Resolved build-menu tiles for the current selection (PLAN-playable.md
     *  G3a); present only when the buildable set changed since the last feed.
     *  (Was the never-populated `unitCmdDescs?: unknown` placeholder — renamed
     *  since it now carries resolved tiles, not raw cmd-descs.) */
    buildOptions?: BuildMenuTile[];
    /** Local team's latest ResourceUpdate, for the native EconomyBar
     *  (PLAN-playable.md G4); present only when a new snapshot arrived since
     *  the last feed. GW4-regression fix: onResourceUpdate previously only
     *  fed `liveState.resources` (the LuaUI Spring.GetTeamResources path) —
     *  nothing forwarded it across the worker→main boundary, so the native
     *  EconomyBar was permanently dark despite being fully built. */
    economy?: ResourceUpdateInfo;
    /** Resolved production-queue rows for the selected factory (PLAN-playable.md
     *  G4); present only when the queue changed since the last feed. Empty
     *  array (not absent) clears the panel when the factory's queue empties
     *  or the selection no longer includes an own-team factory. */
    factoryQueue?: FactoryQueueTile[];
    /** L0 presentation-clock telemetry for the F10 overlay (PLAN-latency-impl.md
     *  L-pre.3); absent before the worker's clock is created. */
    timing?: GpTimingState;
}

/**
 * Per-visible-unit minimap blips, struct-of-arrays for a cheap structured
 * clone (GW4-c5c-3). The worker projects its entity renderer's live set down
 * to the few fields the minimap dots need; fog-of-war-hidden units (los===0)
 * are dropped server-side of this so the minimap never leaks their positions.
 * `los` bit 0 = in-LOS (full dot) vs radar/ghost (dim dot). World XZ in elmos.
 */
export interface GpMinimapBlips {
    count: number;
    ids: Uint32Array;
    teams: Uint16Array;
    x: Float32Array;
    z: Float32Array;
    los: Uint8Array;
}

/** A per-allyteam LOS snapshot for the minimap fog overlay (envelope 0x07). */
export interface GpMinimapLos {
    width: number;
    height: number;
    inLos: Uint8Array;
    inRadar: Uint8Array;
    explored: Uint8Array;
}

/**
 * Metal-spot centroids for the minimap overlay (PLAN-playable.md G4, ZK Phase D
 * item 5/7 — "unit type icons at zoom, metal spot markers" / "mex spot display").
 * Static per-map data (the same `findMetalSpots` clustering G3a already computed
 * for the mex build-ghost snap), so like `map` on {@link GpMessageToMain}'s
 * `gp:minimapFeed` this ships once and the minimap caches it locally.
 */
export interface GpMinimapMetalSpots {
    count: number;
    x: Float32Array;
    z: Float32Array;
    /** Sum of metalmap density in the cluster — scales marker size by richness,
     *  same signal ZK's own `cmd_mex_placement.lua` minimap draw uses. */
    metal: Float32Array;
}

// ─── worker inbound union (typed dispatcher) ────────────────────────────────

/**
 * Legacy (pre-GW4 / LuaWidgetManager-path) inbound messages.
 * Narrow per-case as they are typed. The index-signature escape hatch lets
 * the dispatcher read arbitrary fields without individual field declarations.
 */
export interface LegacyWorkerMessage {
    type:
        | 'init' | 'keypress' | 'keyrelease' | 'mousepress' | 'mouserelease'
        | 'mousewheel' | 'mousemove' | 'defaultCommandTarget' | 'commandNotify'
        | 'getWidgetList' | 'toggleWidget' | 'enableWidget' | 'disableWidget'
        | 'resize' | 'evalLua' | 'musicStreamTime' | 'pauseFrames' | 'resumeFrames'
        | 'stateUpdate' | 'entityState' | 'entityDestroy' | 'entitySensorUpdate'
        | 'sendToUnsynced' | 'intelTransitions' | 'seismicPings' | 'losBitmap'
        | 'unitCommandQueues' | 'unitCmdDescs' | 'unitTransports' | 'unitSelfD'
        | 'unitStockpile' | 'unitLifecycle' | 'visibleUnits' | 'unitCommand'
        | 'unitArmored' | 'pathResponse' | 'standingOrders' | 'unitDefsUpdate'
        | 'projectileState' | 'weaponDefsUpdate' | 'rosterUpdate' | 'rulesParamUpdate'
        | 'resourceUpdate' | 'gameInfo' | 'mapFeatures' | 'shutdown';
    [k: string]: unknown;
}

/** All messages the worker can receive (gp:* + legacy). */
export type WorkerInbound =
    | GpMessageToWorker
    | { type: 'gp:test'; id: number; method: string; args: unknown[] }
    | LegacyWorkerMessage;

export type GpMessageToMain =
    /** Decoded SoundEvents routed to the main-thread AudioManager/SoundEventPlayer. */
    | { type: 'gp:audioSoundEvents'; events: unknown }
    /** Music state transition routed to the main-thread MusicDirector. */
    | { type: 'gp:audioMusic'; state: unknown; fadeMs: number }
    | GpSceneStateToMain
    /**
     * Minimap data (main keeps its own Engine + DOM container until a later
     * review moves it to a second OffscreenCanvas). `los: null` ⇒ unchanged
     * since the last feed (the bitmap only ships when a new snapshot arrives).
     * `map` is present only on the first feed after the worker builds the
     * terrain — it carries the dims + backdrop URL the minimap needs to size
     * its ortho frustum and load the `minimap.ktx2` thumbnail (the worker owns
     * the map fetch, so main learns the dims from here, not its own download).
     */
    | {
          type: 'gp:minimapFeed';
          blips: GpMinimapBlips;
          los: GpMinimapLos | null;
          map?: { width: number; height: number; baseUrl: string };
          metalSpots?: GpMinimapMetalSpots;
      }
    /** Worker asks main to persist a key/value to localStorage (WP3b: single
     *  persistence channel — replaces the former gp:config worker→main direction).
     *  The `springConfig.*` prefix also triggers a clientSettings.set side-effect
     *  on main. Both the game-processor worker and legacy LuaWidgetManager paths
     *  post this shape; main.ts and lua-widget-manager.ts handle it identically. */
    | { type: 'storage:set'; key: string; value: string }
    /**
     * Drag-select rectangle for the main-thread overlay div (GW4-c5b-2). The
     * worker owns selection/pick, but the box overlay is a DOM concern; main
     * draws `#drag-select-overlay`. Coords are canvas-relative CSS px (top-left).
     * `box: null` hides the overlay. `viewId` absent ⇒ view 0.
     */
    | { type: 'gp:dragBox'; box: { x0: number; y0: number; x1: number; y1: number } | null; viewId?: number }
    /** PLAN-playable.md G3b: armed-command cursor mode. `name` = canonical Spring
     *  cursor name (null → native arrow); `css` = the CSS-cursor fallback. Main
     *  drives the AnimatedCursor overlay + `#game-canvas` cursor style. */
    | { type: 'gp:cursorMode'; name: string | null; css: string }
    /** Game-over → main shows the results overlay. `winningAllyTeams` is the
     *  server's winners list (empty = undecided); `won` is the local player's
     *  result (true/false), or null for a draw/undecided/spectator. */
    | { type: 'gp:gameOver'; frame: number; winningAllyTeams: number[]; won: boolean | null }
    /** Worker reached the game server + authed (mirrors connection onAuthenticated).
     *  `accountId` is the DB account; `playerNum` is Spring's sim player id.
     *  They are different numbers — see `AuthenticatedInfo` in connection.ts. */
    | { type: 'gp:authenticated'; accountId: number; playerNum: number; team: number; role: string }
    /** Full player roster from the game server, on auth and on every change.
     *  Main mirrors it into the native-UI store so widgets can name players
     *  (including AI virtual players, which the lobby roster omits). */
    | { type: 'gp:playerRoster'; players: RosterPlayerInfo[] }
    /** Server restart detected — main reloads. */
    | { type: 'gp:reload' }
    /** Metalstorm counterbattery reveal (Q-D-c): a statistical volley from an
     *  attacker the local team can't see → a red "attack" radar blip at the
     *  firing position (x,z world elmos) on the main-thread minimap. */
    | { type: 'gp:counterbatteryPing'; x: number; z: number }
    /** Reply to a gp:test request from the main test harness. */
    | { type: 'gp:testResult'; id: number; ok: boolean; value?: unknown; error?: string }
    /** Reply to a `gp:ping` heartbeat probe (PLAN-client-resilience.md task 1). */
    | { type: 'gp:pong'; id: number }
    /**
     * WebGL context loss / restore on the worker's OffscreenCanvas
     * (PLAN-client-resilience.md task 1 detection). Babylon's render loop
     * already no-ops while the context is lost; this is purely a visibility
     * signal for the main-thread console/telemetry today — no recovery is
     * wired to it yet.
     * EXTENSION POINT (task 2, the R1/R2/R3 recovery ladder): `lost` is R1's
     * trigger ("context-restored, single recoverable fatal in a subsystem
     * with a reset path") — the ladder should listen here instead of adding
     * a second Babylon observable.
     */
    | { type: 'gp:contextLost' }
    | { type: 'gp:contextRestored' }
    /**
     * PLAN-client-resilience.md task 2: the worker's self.onerror /
     * unhandledrejection hook fired (a genuinely-uncaught worker error — the
     * render loop or a bare async, NOT a pcall-contained widget callin). Main's
     * RecoveryLadder takes R2 (respawn) on this; `injected` tags task 5's
     * fault-injection verbs so a synthetic failure doesn't drive a real
     * recovery in a way that's indistinguishable on the dashboard. This is the
     * reliable cross-boundary signal for E2 (an async loader crash raises
     * `unhandledrejection`, which — unlike an uncaught throw — never propagates
     * to the main-thread `gameWorker.onerror`). */
    | { type: 'gp:workerFatal'; reason: string; injected: boolean }
    /** PLAN-client-resilience.md task 2: reply to a `gp:recover` (R1 soft
     *  reset). `ok:false` (or no reply within the ladder's round-trip timeout)
     *  escalates to R2. */
    | { type: 'gp:recovered'; id: number; ok: boolean }
    /** PLAN-quickstart.md §3.1: the worker acks a `gp:detach` — the game
     *  connection is closed, render + viewport pump paused, worker parked. */
    | { type: 'gp:detached' }
    /** PLAN-quickstart.md §3.2: the worker acks a `gp:resync` — dynamic state
     *  flushed and reconnect started (a `gp:authenticated` follows once the
     *  fresh ClientSession completes its handshake). */
    | { type: 'gp:resynced' }
    /**
     * Org-group snapshot for the native org-panel widget (PLAN-macro-ui.md
     * §3). Forwarded on every `Connection.onOrgGroupState` push (own team
     * only — same forwarding pattern as `gp:sceneState.economy`, change-
     * driven not per-tick). `baseCostSum` is the worker's own addition (not
     * on the wire message): Σ `authority_cost_base` customparam over the
     * group's current member defIds (EntityRenderer.getEntityMeta + DefCache
     * — real per-unit data, not an estimate), for the command composer's
     * directive cost preview (metalstorm-scripting task 5 / PLAN-metalstorm-
     * authority.md §3.3). Members not currently resolved client-side (out of
     * LOS/unknown def) are skipped — best-effort, same staleness class as
     * every other client-side cost prediction input (§4).
     */
    | { type: 'gp:orgGroups'; groups: (OrgGroupInfoMsg & { baseCostSum: number })[] }
    /** Directive snapshot for the org panel (fulfillment %, directive
     *  icons) — own team + allies, mirrors `onDirectiveState`. */
    | { type: 'gp:directives'; directives: DirectiveInfoMsg[] }
    /** A `gp:armDirectiveShape` request armed (or failed to arm) — lets the
     *  requesting main-thread widget show an "drawing…" affordance and know
     *  when to re-enable its own UI. */
    | { type: 'gp:directiveShapeArmed'; armed: boolean }
    /** The armed capture finished — committed (a `GroupDirective` was sent,
     *  UNLESS the arming request set `captureOnly`, in which case nothing
     *  was sent and `shape`/`params` carry the raw drawn geometry for the
     *  caller to use itself — metalstorm-scripting task 4) or cancelled. */
    | { type: 'gp:directiveShapeResult'; committed: boolean; shape?: 'Point' | 'Circle' | 'Polygon' | 'Polyline'; params?: number[] }
    /** PLAN-rml.md: a batch of RML DOM ops for the main-thread overlay manager. */
    | RmlOpsToMain;
