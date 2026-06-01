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
 * Raw input forwarded from the main-thread DOM listeners. Coordinates are
 * canvas-relative and Y-flipped (origin bottom-left) — the same convention the
 * existing widget input-forward path already uses. `mods` is a bitmask:
 * 1=shift, 2=ctrl, 4=alt, 8=meta.
 */
export type GpInputToWorker =
    | { type: 'gp:pointermove'; x: number; y: number; buttons: number; mods: number }
    | { type: 'gp:pointerdown'; x: number; y: number; button: number; mods: number }
    | { type: 'gp:pointerup'; x: number; y: number; button: number; mods: number }
    | { type: 'gp:wheel'; x: number; y: number; delta: number; mods: number }
    | { type: 'gp:keydown'; code: string; mods: number }
    | { type: 'gp:keyup'; code: string; mods: number }
    | { type: 'gp:blur' }
    | { type: 'gp:resize'; width: number; height: number; dpr: number };

/** Live push of a single clientSettings/gfx key change (init carries the snapshot). */
export interface GpConfigToWorker {
    type: 'gp:config';
    key: string;
    value: unknown;
}

export type GpMessageToWorker =
    | GpInitToWorker
    | GpInputToWorker
    | GpConfigToWorker
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

export type GpMessageToMain =
    /** Decoded SoundEvents routed to the main-thread AudioManager/SoundEventPlayer. */
    | { type: 'gp:audioSoundEvents'; events: unknown }
    /** Music state transition routed to the main-thread MusicDirector. */
    | { type: 'gp:audioMusic'; state: unknown; fadeMs: number }
    | GpSceneStateToMain
    /** Minimap data (main keeps its own Engine + DOM container until GW5 review). */
    | { type: 'gp:minimapFeed'; units: unknown; los: unknown }
    /** Worker asks main to persist a value to localStorage (e.g. SHOW_ALLIES). */
    | { type: 'gp:config'; key: string; value: unknown }
    /** Game-over → main shows the results overlay. */
    | { type: 'gp:gameOver'; frame: number }
    /** Worker reached the game server + authed (mirrors connection onAuthenticated). */
    | { type: 'gp:authenticated'; playerId: number; team: number };
