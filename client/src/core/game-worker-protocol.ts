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

export type GpMessageToWorker =
    | GpInitToWorker
    | GpInputToWorker
    | GpConfigToWorker
    | GpFocusWorldToWorker
    | { type: 'gp:shutdown' };

// ─── worker → main ──────────────────────────────────────────────────────────

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
    entityCount: number;
    /** Build-menu command descriptions; present only when changed. */
    unitCmdDescs?: unknown;
    /** Economy/resource snapshot for the economy bar; present only when changed. */
    economy?: unknown;
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
    /** Game-over → main shows the results overlay. */
    | { type: 'gp:gameOver'; frame: number }
    /** Worker reached the game server + authed (mirrors connection onAuthenticated). */
    | { type: 'gp:authenticated'; playerId: number; team: number }
    /** Server restart detected — main reloads. */
    | { type: 'gp:reload' }
    /** Reply to a gp:test request from the main test harness. */
    | { type: 'gp:testResult'; id: number; ok: boolean; value?: unknown; error?: string };
