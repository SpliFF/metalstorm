/**
 * LuaWidgetManager — Main-thread proxy for the LuaUI Web Worker.
 *
 * The heavy Lua work (fengari, VFS, bootstrap, widget callins) runs in a
 * Web Worker to avoid blocking the main thread. This class:
 *   - Creates a transparent overlay canvas for 2D widget UI (DrawScreen)
 *   - Transfers it to the worker as an OffscreenCanvas
 *   - Forwards keyboard events to the worker
 *   - Receives log messages and routes them to the debug console
 *   - Provides the F9 widget list overlay
 *
 * World-space rendering (DrawWorld, DrawWorldPreUnit) will use a command
 * buffer replayed on the Babylon GL context — not yet implemented.
 */
import type { Scene } from '@babylonjs/core/scene';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import type { ParsedMapData } from './map-data.js';
import type { RTSCamera } from './rts-camera.js';
import type { Connection, ResourceUpdateInfo } from './connection.js';
import type { EntityStateSnapshot } from './entity-state.js';
import { debugConsole } from './debug-console.js';
import { logIngest } from './log-ingest.js';

// Vite worker import — bundles the worker as a separate chunk
import WidgetWorker from './lua-widget-worker.ts?worker';

// ── Types ───────────────────────────────────────────────────────────────

export interface WidgetManagerOptions {
    gameId: string;
    /** Base URL for game data (e.g. http://localhost:8011) */
    lobbyUrl: string;
    /**
     * If set, the worker patches cawidgets.lua to load only widgets whose
     * filename contains this string. Used by `?widgetTest` to isolate the
     * gl bridge / Chili pipeline by running a single test widget.
     */
    soloWidget?: string;
}

// ── Main class ──────────────────────────────────────────────────────────

export class LuaWidgetManager {
    private scene: Scene;
    private camera: FreeCamera;
    private map: ParsedMapData;
    private options: WidgetManagerOptions;
    private rtsCamera: RTSCamera | null = null;
    private connection: Connection | null = null;

    private worker: Worker | null = null;
    /** Buffer for messages sent before initialize() creates the worker.
     *  setRoster/forwardMapFeatures/etc. are commonly called immediately after
     *  the manager is constructed; without this queue those messages would be
     *  silently dropped and widgets see an empty roster. Flushed in initialize(). */
    private pendingMessages: Array<{ msg: Record<string, unknown>; transfer?: Transferable[] }> = [];
    private overlayCanvas: HTMLCanvasElement | null = null;
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;
    private keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
    private widgetListOverlay: HTMLDivElement | null = null;
    private disposed = false;
    private stateInterval: ReturnType<typeof setInterval> | null = null;

    /** Last widget list data received from worker */
    private lastWidgetData = '';
    private ready = false;
    private fileCount = 0;
    private evalResolve: ((result: string) => void) | null = null;

    /** Input listeners registered based on worker-reported callins */
    private inputCleanups: (() => void)[] = [];
    /** Last known mouse position for delta calculation */
    private lastMouseX = 0;
    private lastMouseY = 0;

    /** Persistent mouse state for Spring.GetMouseState polling-style queries.
     *  Updated by always-on listeners (independent of MouseMove callin) and
     *  shipped to the worker via stateUpdate. outsideSpring starts true so
     *  widgets see "no pointer" before the cursor enters the canvas. */
    private mouseState = { x: 0, y: 0, lmb: false, mmb: false, rmb: false, outsideSpring: true };

    /** Whether the cursor is currently over a chili control (any widget claiming
     *  the point via widgetHandler:IsAbove). Updated by mousemove dispatches in
     *  the worker. InputManager reads this via isCursorOverUI() to skip ground
     *  selection / order placement when the click belongs to LuaUI. */
    private cursorOverUI = false;

    /** Set when F10 has been forwarded to the worker; if the worker reports
     *  the keypress wasn't consumed by any widget, the widget list opens as a
     *  fallback. Reset on the inputConsumed reply so a second F10 between
     *  dispatch and reply doesn't queue a stale toggle. */
    private lastF10Pending = false;

    /** Listener cleanup for the always-on mouse tracker. */
    private mouseTrackingCleanups: (() => void)[] = [];

    /** Current game frame counter (updated by forwardEntityState) */
    private currentFrame = 0;
    /** Currently selected unit IDs (set from main thread) */
    private selectedUnitIds: number[] = [];

    /** Fired when a widget called Spring.SelectUnit / SelectUnitArray /
     *  SelectUnitMap / DeselectUnit. Main.ts wires this to InputManager so
     *  the highlight, minimap, and build menu update. The full new
     *  selection list is provided — appends are already resolved by the
     *  worker against its mirror. */
    onSelectionRequest?: (unitIds: number[]) => void;

    /** Fired when a widget called Spring.SetCameraTarget (or the position
     *  variant of SetCameraState). Main.ts wires this to RTSCamera.focusOn.
     *  `smoothness` is Spring's seconds-ish pacing hint; 0 = teleport. */
    onCameraTargetRequest?: (x: number, z: number, smoothness: number) => void;

    constructor(
        scene: Scene,
        camera: FreeCamera,
        map: ParsedMapData,
        options: WidgetManagerOptions,
    ) {
        this.scene = scene;
        this.camera = camera;
        this.map = map;
        this.options = options;
    }

    /** Set camera and connection references for state pushing. */
    setLiveDataSources(rtsCamera: RTSCamera, connection: Connection): void {
        this.rtsCamera = rtsCamera;
        this.connection = connection;
    }

    // ── Main entry point ────────────────────────────────────────────────

    async initialize(): Promise<void> {
        // 1. Create transparent overlay canvas for 2D widget UI
        const canvas = this.createOverlayCanvas();

        // 2. Transfer to OffscreenCanvas
        const offscreen = canvas.transferControlToOffscreen();

        // 3. Start worker
        this.worker = new WidgetWorker();
        this.worker.onmessage = (e) => this.onWorkerMessage(e);
        this.worker.onerror = (e) => {
            console.error('[LuaUI] Worker error:', e.message);
        };

        // 4. Send init message with canvas and map data
        const mapData = {
            mapx: this.map.mapx,
            mapy: this.map.mapy,
            squareSize: this.map.squareSize,
            minHeight: this.map.minHeight,
            maxHeight: this.map.maxHeight,
            widthElmos: this.map.widthElmos,
            heightElmos: this.map.heightElmos,
            heightmap: this.map.heightmap,
            mapSourceUrl: this.map.mapSourceUrl,
        };

        // Collect all luaui:* localStorage entries so the worker can read config
        const storageData: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith('luaui:')) {
                storageData[k] = localStorage.getItem(k) ?? '';
            }
        }

        // Send the worker its own copy of the heightmap so transferring
        // the buffer doesn't detach the main-thread Uint16Array. The
        // main thread keeps the heightmap for terrain sampling
        // (CommandPathRenderer, DebugTerrainGrid, anything that calls
        // sampleHeight); the worker takes ownership of the clone.
        const heightmapCopy = new Uint16Array(mapData.heightmap);
        const workerMapData = { ...mapData, heightmap: heightmapCopy };
        this.postToWorker({
            type: 'init',
            canvas: offscreen,
            gameId: this.options.gameId,
            lobbyUrl: this.options.lobbyUrl,
            mapData: workerMapData,
            storageData,
            soloWidget: this.options.soloWidget,
        }, [offscreen, heightmapCopy.buffer]);

        // Flush any messages queued before the worker existed (setRoster,
        // forwardMapFeatures, forwardUnitDefs, forwardWeaponDefs etc.).
        // These must arrive before the worker runs cawidgets:Initialize, which
        // happens during VFS prefetch await; the worker processes pending
        // messages in queue order so this works as long as we send them now.
        const buffered = this.pendingMessages;
        this.pendingMessages = [];
        for (const { msg, transfer } of buffered) {
            this.postToWorker(msg, transfer);
        }

        // 5. Setup keyboard forwarding + F9 widget list
        this.setupKeyboard();

        // 6. Start pushing live state to worker at ~10 Hz
        this.stateInterval = setInterval(() => this.pushStateToWorker(), 100);

        // 7. Always-on mouse tracking for Spring.GetMouseState polling.
        const engineCanvas = this.scene.getEngine().getRenderingCanvas();
        if (engineCanvas) this.installMouseTracking(engineCanvas);

        // 8. Expose debug API
        (window as any).widgets = this.buildWindowAPI();
    }

    // ── State forwarding to worker ────────────────────────────────────

    /** Push camera, viewport, identity, and game frame to the worker at ~10Hz. */
    private pushStateToWorker(): void {
        if (!this.worker || this.disposed) return;
        const cam = this.rtsCamera;
        const conn = this.connection;
        const mainCanvas = this.scene.getEngine().getRenderingCanvas();

        // Get view and projection matrices for WorldToScreenCoords
        const viewMatrix = this.scene.activeCamera
            ? new Float32Array(this.scene.getViewMatrix().toArray())
            : undefined;
        const projMatrix = this.scene.activeCamera
            ? new Float32Array(this.scene.getProjectionMatrix().toArray())
            : undefined;

        this.postToWorker({
            type: 'stateUpdate',
            camera: cam ? {
                px: cam.position.x, py: cam.position.y, pz: cam.position.z,
                tx: cam.target.x, ty: cam.target.y, tz: cam.target.z,
                fov: this.camera.fov,
                near: this.camera.minZ, far: this.camera.maxZ,
            } : undefined,
            viewport: {
                width: mainCanvas?.width ?? window.innerWidth,
                height: mainCanvas?.height ?? window.innerHeight,
            },
            identity: conn ? {
                myTeam: conn.myTeam,
                myAllyTeam: conn.myTeam,
                myPlayerId: conn.playerId,
            } : undefined,
            gameFrame: this.currentFrame,
            selectedUnitIds: this.selectedUnitIds,
            viewMatrix,
            projMatrix,
            modKeys: this.modKeys,
            mouse: this.mouseState,
        });
    }

    /** Install always-on pointer listeners that keep mouseState fresh.
     *  Independent of the MouseMove/MousePress callin gates — those gate
     *  whether widget callbacks fire, while this gates whether
     *  Spring.GetMouseState returns a stale [0,0] tuple. */
    private installMouseTracking(canvas: HTMLCanvasElement): void {
        const move = (e: MouseEvent) => {
            this.mouseState.x = e.offsetX;
            this.mouseState.y = canvas.height - e.offsetY;
            this.mouseState.outsideSpring = false;
        };
        const enter = () => { this.mouseState.outsideSpring = false; };
        const leave = () => {
            this.mouseState.outsideSpring = true;
            this.mouseState.lmb = this.mouseState.mmb = this.mouseState.rmb = false;
        };
        const down = (e: MouseEvent) => {
            if (e.button === 0) this.mouseState.lmb = true;
            else if (e.button === 1) this.mouseState.mmb = true;
            else if (e.button === 2) this.mouseState.rmb = true;
        };
        const up = (e: MouseEvent) => {
            if (e.button === 0) this.mouseState.lmb = false;
            else if (e.button === 1) this.mouseState.mmb = false;
            else if (e.button === 2) this.mouseState.rmb = false;
        };
        canvas.addEventListener('mousemove', move);
        canvas.addEventListener('mouseenter', enter);
        canvas.addEventListener('mouseleave', leave);
        // Use window for up so a button released off-canvas still clears.
        canvas.addEventListener('mousedown', down);
        window.addEventListener('mouseup', up);
        this.mouseTrackingCleanups.push(
            () => canvas.removeEventListener('mousemove', move),
            () => canvas.removeEventListener('mouseenter', enter),
            () => canvas.removeEventListener('mouseleave', leave),
            () => canvas.removeEventListener('mousedown', down),
            () => window.removeEventListener('mouseup', up),
        );
    }

    /** Track modifier key state */
    private modKeys = { alt: false, ctrl: false, meta: false, shift: false };

    /** Forward an entity state snapshot to the worker for unit queries. */
    forwardEntityState(snapshot: EntityStateSnapshot, isDelta: boolean): void {
        if (this.disposed) return;
        this.currentFrame++;

        // Copy typed arrays so they can be transferred without detaching the originals
        const msg: Record<string, unknown> = {
            type: 'entityState',
            count: snapshot.count,
            isDelta,
            entityIds: snapshot.entityIds ? new Uint32Array(snapshot.entityIds) : null,
            positionsX: snapshot.positionsX ? new Float32Array(snapshot.positionsX) : null,
            positionsY: snapshot.positionsY ? new Float32Array(snapshot.positionsY) : null,
            positionsZ: snapshot.positionsZ ? new Float32Array(snapshot.positionsZ) : null,
            headings: snapshot.headings ? new Uint16Array(snapshot.headings) : null,
            health: snapshot.health ? new Uint16Array(snapshot.health) : null,
            defIds: snapshot.defIds ? new Uint16Array(snapshot.defIds) : null,
            teams: snapshot.teams ? new Uint8Array(snapshot.teams) : null,
            stateBits: snapshot.stateBits ? new Uint8Array(snapshot.stateBits) : null,
            losStates: snapshot.losStates ? new Uint8Array(snapshot.losStates) : null,
        };

        // Build transferable list from the copies
        const transfer: Transferable[] = [];
        for (const key of ['entityIds', 'positionsX', 'positionsY', 'positionsZ', 'headings', 'health', 'defIds', 'teams', 'stateBits', 'losStates']) {
            const arr = msg[key] as ArrayBufferView | null;
            if (arr) transfer.push(arr.buffer);
        }

        this.postToWorker(msg, transfer);
    }

    /** Forward an entity destruction to the worker. */
    forwardEntityDestroy(entityId: number): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'entityDestroy', entityId });
    }

    /** Forward a resource update to the worker. */
    forwardResourceUpdate(info: ResourceUpdateInfo): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'resourceUpdate', ...info });
    }

    /** Forward game info (frame, speed, paused) to the worker. */
    forwardGameInfo(frame: number, speed: number, paused: boolean, gameOver: boolean,
                    wind?: { x: number; y: number; z: number; strength: number; tidal: number }): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'gameInfo', frame, speed, paused, gameOver, wind });
    }

    /** Update the selection state from the main thread. */
    setSelection(ids: readonly number[]): void {
        this.selectedUnitIds = [...ids];
    }

    /** Push a batch of unit defs into the worker. Defs accumulate over
     *  the session — the server streams them on demand as the player
     *  encounters new entity types.
     *  Pass-through: every field on the wire is forwarded so the
     *  worker's buildLuaUnitDef can populate UnitDefs.<id>.customParams,
     *  transportSize, repairSpeed, yardmap, … directly. */
    forwardUnitDefs(defs: ReadonlyArray<Record<string, unknown>>): void {
        if (this.disposed || defs.length === 0) return;
        this.postToWorker({ type: 'unitDefsUpdate', defs: defs.map(d => ({ ...d })) });
    }

    /** Push a per-team unit command-queue snapshot into the worker.
     *  Replaces the cached queues for this snapshot's unit set; units
     *  not present are treated as having empty queues by the readers. */
    forwardUnitCommandQueues(queues: ReadonlyArray<{
        unitId: number;
        orders: ReadonlyArray<{ cmdId: number; params: number[]; options: number; tag: number; timeout: number }>;
    }>): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'unitCommandQueues', queues: queues.map(q => ({
            unitId: q.unitId,
            orders: q.orders.map(o => ({ ...o, params: [...o.params] })),
        })) });
    }

    /** Push a per-unit command-descriptor snapshot into the worker.
     *  Server streams build (cmdId<0) entries at ~1 Hz; widgets read
     *  these via Spring.GetUnitCmdDescs to populate their build menus. */
    forwardUnitCmdDescs(units: ReadonlyArray<{
        unitId: number;
        cmds: ReadonlyArray<{ cmdId: number; disabled: boolean }>;
    }>): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'unitCmdDescs', units: units.map(u => ({
            unitId: u.unitId,
            cmds: u.cmds.map(c => ({ cmdId: c.cmdId, disabled: c.disabled })),
        })) });
    }

    /** Push a batch of weapon defs into the worker. */
    forwardWeaponDefs(defs: ReadonlyArray<{
        defId: number; name: string; visualType: number;
        projectileSpeed: number; range: number; aoe: number; size: number;
        intensity: number; colorR: number; colorG: number; colorB: number;
        duration: number; highTrajectory: boolean;
    }>): void {
        if (this.disposed || defs.length === 0) return;
        this.postToWorker({ type: 'weaponDefsUpdate', defs: defs.map(d => ({ ...d })) });
    }

    /** Replace the worker's roster snapshot. Called by the lobby bridge
     *  immediately after the widget manager is constructed; safe to call
     *  before the worker has finished bootstrapping (the message queues
     *  via the underlying Worker). */
    setRoster(roster: {
        players?: Array<{
            id: number; name?: string; active?: boolean; spectator?: boolean;
            team: number; allyTeam?: number; pingMs?: number; cpuUsage?: number;
            country?: string; rank?: number; hasController?: boolean;
            customKeys?: Record<string, string>;
        }>;
        teams?: Array<{
            id: number; allyTeam?: number; leader?: number; isDead?: boolean;
            isAi?: boolean; side?: string; customKeys?: Record<string, string>;
        }>;
        teamColors?: Array<{ team: number; r: number; g: number; b: number; a?: number }>;
        modOptions?: Record<string, number | string>;
    }): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'rosterUpdate', ...roster });
    }

    /** Forward map features to the worker for GetAllFeatures/GetFeaturePosition. */
    forwardMapFeatures(features: Array<{ typeIndex: number; x: number; y: number; z: number }>): void {
        if (!this.worker || this.disposed) return;
        // Pack features into a flat message. Use typeIndex+10000 as a fake defId,
        // and assign feature IDs starting from 1.
        const packed = features.map((f, i) => ({
            id: i + 1,
            x: f.x,
            y: f.y,
            z: f.z,
            defId: f.typeIndex,
            team: -1,
            healthRatio: 1,
        }));
        this.postToWorker({ type: 'mapFeatures', features: packed });
    }

    // ── Overlay canvas ──────────────────────────────────────────────────

    private createOverlayCanvas(): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.id = 'luaui-overlay';
        canvas.style.cssText = `
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            pointer-events: none;
            z-index: 100;
        `;

        // Match the main canvas size
        const mainCanvas = this.scene.getEngine().getRenderingCanvas();
        if (mainCanvas) {
            canvas.width = mainCanvas.width;
            canvas.height = mainCanvas.height;
        } else {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }

        // Insert after the main canvas
        const container = mainCanvas?.parentElement ?? document.body;
        container.appendChild(canvas);
        this.overlayCanvas = canvas;

        // Resize observer — after transferControlToOffscreen() the main thread
        // can't set canvas.width/height directly, so we only notify the worker.
        const ro = new ResizeObserver(() => {
            const w = mainCanvas?.width ?? window.innerWidth;
            const h = mainCanvas?.height ?? window.innerHeight;
            this.postToWorker({ type: 'resize', width: w, height: h });
        });
        if (mainCanvas) ro.observe(mainCanvas);

        return canvas;
    }

    // ── postMessage wrappers with debug tracing ──────────────────────────
    //
    // Every message crossing the main↔worker boundary is logged at
    // debug level so the shutdown-loop diagnosis can reconstruct the
    // exact order of events. Payloads are summarised, not dumped.

    private postToWorker(msg: Record<string, unknown>, transfer?: Transferable[]): void {
        if (!this.worker) {
            // Worker not yet created (initialize() hasn't run). Buffer the
            // message; it will be flushed in initialize() before init's first
            // await point so the worker sees it before bootstrap completes.
            if (!this.disposed) this.pendingMessages.push({ msg, transfer });
            return;
        }
        this.logMessageTraffic('main→worker', msg);
        if (transfer && transfer.length) {
            this.worker.postMessage(msg, transfer);
        } else {
            this.worker.postMessage(msg);
        }
    }

    private logMessageTraffic(dir: 'main→worker' | 'worker→main', msg: Record<string, unknown>): void {
        // Skip high-frequency or meta channels to avoid drowning real logs.
        if (msg.type === 'log'
            || msg.type === 'mousemove'
            || msg.type === 'stateUpdate'
            || msg.type === 'gameInfo'
            || msg.type === 'entityState') return;
        const t = String(msg.type ?? '?');
        let summary = t;
        switch (t) {
            case 'init':           summary = `init (gameId=${msg.gameId})`; break;
            case 'shutdown':       summary = 'shutdown'; break;
            case 'resize':         summary = `resize ${msg.width}x${msg.height}`; break;
            case 'keypress':       summary = `keypress keyCode=${msg.keyCode}`; break;
            case 'keyrelease':     summary = `keyrelease keyCode=${msg.keyCode}`; break;
            case 'mousepress':     summary = `mousepress @${msg.x},${msg.y} btn=${msg.button}`; break;
            case 'mouserelease':   summary = `mouserelease @${msg.x},${msg.y} btn=${msg.button}`; break;
            case 'mousemove':      summary = `mousemove @${msg.x},${msg.y}`; break;
            case 'mousewheel':     summary = `mousewheel up=${msg.up} value=${msg.value}`; break;
            case 'getWidgetList':  summary = 'getWidgetList'; break;
            case 'toggleWidget':   summary = `toggleWidget name=${msg.name}`; break;
            case 'enableWidget':   summary = `enableWidget name=${msg.name}`; break;
            case 'disableWidget':  summary = `disableWidget name=${msg.name}`; break;
            case 'ready':          summary = `ready (fileCount=${msg.fileCount}, callins=${(msg.callins as string[])?.join(',') || 'none'})`; break;
            case 'error':          summary = `error: ${String(msg.msg ?? '')}`; break;
            case 'storage:set':    summary = `storage:set key=${msg.key}`; break;
            case 'widgetList':     summary = `widgetList (${String(msg.data ?? '').length} bytes)`; break;
            case 'worldGLCommands':summary = `worldGLCommands (${(msg.commands as unknown[])?.length ?? '?'} cmds)`; break;
            case 'giveOrder':      summary = `giveOrder cmd=${msg.cmdId} units=${(msg.unitIds as unknown[])?.length ?? 0} params=${(msg.params as unknown[])?.length ?? 0}`; break;
            case 'sendLuaRulesMsg': summary = `sendLuaRulesMsg (${(msg.data as string)?.length ?? 0} bytes)`; break;
            case 'setSelection':   summary = `setSelection units=${(msg.unitIds as unknown[])?.length ?? 0}`; break;
            case 'setCameraTarget': summary = `setCameraTarget x=${msg.x} z=${msg.z} smooth=${msg.smoothness}`; break;
            case 'uiHover':        summary = `uiHover above=${msg.above}`; break;
            case 'inputConsumed':  summary = `inputConsumed kind=${msg.kind} consumed=${msg.consumed}`; break;
        }
        debugConsole.addEntry({
            id: Date.now() + Math.random(),
            timestamp: Date.now() / 1000,
            level: 1, // debug
            section: 'lua',
            scope: 'LuaUI',
            process: 'client',
            message: `[LuaUI:${dir}] ${summary}`,
            frame: 0,
        });
    }

    // ── Worker message handling ──────────────────────────────────────────

    private onWorkerMessage(e: MessageEvent): void {
        const msg = e.data;
        // Trace worker→main traffic at debug level (skip 'log' itself
        // — those messages carry the debug text and self-logging would
        // double-size the debug console).
        if (msg?.type !== 'log') this.logMessageTraffic('worker→main', msg);
        switch (msg.type) {
            case 'log': {
                const level = (msg.level ?? 2) as number;
                console.log(`[LuaUI]`, msg.msg);
                debugConsole.addEntry({
                    id: Date.now(),
                    timestamp: Date.now() / 1000,
                    level,
                    section: 'lua',
                    scope: 'LuaUI',
                    process: 'client',
                    message: msg.msg,
                    frame: 0,
                });
                // Forward warnings and errors to the log server so every
                // widget error is discoverable via spring-debug. Below
                // warning we suppress to keep traffic light — devs can
                // still see info-level chatter in the browser console
                // and the in-game console.
                if (level >= 3) {
                    logIngest.push({
                        level: level as 3 | 4 | 5,
                        section: 'lua',
                        scope: 'LuaUI',
                        message: String(msg.msg ?? ''),
                    });
                }
                break;
            }

            case 'ready':
                this.ready = true;
                this.fileCount = msg.fileCount;
                console.log(`[LuaUI] Worker ready, ${msg.fileCount} VFS files`);
                if (msg.callins) {
                    this.registerInputListeners(msg.callins as string[]);
                }
                break;

            case 'widgetList':
                this.lastWidgetData = msg.data;
                this.renderWidgetList(msg.data);
                break;

            case 'storage:set':
                try {
                    localStorage.setItem(msg.key, msg.value);
                } catch { /* silent */ }
                break;

            case 'error':
                console.error('[LuaUI] Worker error:', msg.msg);
                break;

            case 'evalResult':
                console.log('[LuaUI:eval]', msg.result);
                if (this.evalResolve) {
                    this.evalResolve(msg.result as string);
                    this.evalResolve = null;
                }
                break;

            case 'worldGLCommands':
                // TODO: replay command buffer on Babylon GL context
                break;

            case 'giveOrder': {
                const conn = this.connection;
                if (!conn) break;
                const unitIds = Array.isArray(msg.unitIds) ? (msg.unitIds as number[]) : [];
                const params = Array.isArray(msg.params) ? (msg.params as number[]) : [];
                const cmdId = Number(msg.cmdId | 0);
                const options = Number(msg.options | 0);
                const timeoutFrames = Number(msg.timeoutFrames | 0);
                if (unitIds.length === 0) break;
                conn.sendPlayerCommand(cmdId, unitIds, params, options, timeoutFrames);
                break;
            }

            case 'sendLuaRulesMsg': {
                const conn = this.connection;
                if (!conn) break;
                const data = typeof msg.data === 'string' ? msg.data : '';
                if (!data) break;
                conn.sendLuaRulesMsg(data);
                break;
            }

            case 'setSelection': {
                // A widget called Spring.SelectUnit / SelectUnitArray / etc.
                // The worker already updated its local mirror; route the new
                // list to the host so InputManager and downstream UI sync up.
                const ids = Array.isArray(msg.unitIds)
                    ? (msg.unitIds as unknown[]).map(v => Number(v) | 0).filter(n => n > 0)
                    : [];
                // Mirror locally too so a stateUpdate that races in before
                // main.ts pushes back the canonical list is consistent.
                this.selectedUnitIds = ids;
                this.onSelectionRequest?.(ids);
                break;
            }

            case 'setCameraTarget': {
                const x = Number(msg.x);
                const z = Number(msg.z);
                const smoothness = Number(msg.smoothness) || 0;
                if (Number.isFinite(x) && Number.isFinite(z)) {
                    this.onCameraTargetRequest?.(x, z, smoothness);
                }
                break;
            }

            case 'uiHover':
                // Fire-and-forget hover state pushed by the worker after each
                // mousemove. InputManager reads this via isCursorOverUI() to
                // gate ground selection / orders on the next mousedown.
                this.cursorOverUI = !!msg.above;
                break;

            case 'inputConsumed':
                // The worker reports whether the just-dispatched event was
                // claimed by a widget. cursorOverUI (from uiHover) handles
                // mouse-click suppression on the InputManager side, so we
                // only react to keypress here: F10 falls back to the widget
                // list if no chili menu (epicmenu, etc.) claimed it.
                if (msg.kind === 'keypress' && this.lastF10Pending) {
                    this.lastF10Pending = false;
                    if (!msg.consumed) {
                        this.toggleWidgetList();
                    }
                }
                break;
        }
    }

    /** True when the cursor is hovering a chili control. Updated by mousemove
     *  → widgetHandler:IsAbove() in the worker, so the value lags the cursor by
     *  one frame. InputManager checks this at mousedown to suppress ground
     *  selection when the click belongs to LuaUI. */
    isCursorOverUI(): boolean {
        return this.cursorOverUI;
    }

    // ── Keyboard ────────────────────────────────────────────────────────

    private setupKeyboard(): void {
        this.keyHandler = (e: KeyboardEvent) => {
            // Track modifier keys for GetModKeyState
            this.modKeys = { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };

            // F9 always opens the engine widget list immediately — it's
            // the developer escape hatch and never goes through Lua. F11
            // is reserved by macOS for full-screen, so we don't use it.
            if (e.key === 'F9' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                this.toggleWidgetList();
                return;
            }

            // F10 is the conventional Spring "menu" key. Forward it to
            // the worker so a chili-bound action (e.g. ZK's crudesubmenu
            // → epicmenu) can claim it. If no widget consumes it, the
            // worker replies with inputConsumed{consumed:false} and we
            // fall back to the widget list. The fallback path lives in
            // onWorkerMessage('inputConsumed').
            if (e.key === 'F10' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                this.lastF10Pending = true;
                // Fall through so the keypress is forwarded to the worker.
            }

            // Forward keyboard events to worker
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            // Don't forward bare modifier presses — they aren't meaningful
            // as standalone keys and ZK widgets that try to early-out on
            // KEYSYMS.LSHIFT etc. miss the guard when our keycode is 0,
            // falling through to action paths that open the main menu.
            if (isModifierOnly(e)) return;

            if (e.type === 'keydown') {
                this.postToWorker({
                    type: 'keypress',
                    keyCode: springKeyCode(e),
                    alt: e.altKey,
                    ctrl: e.ctrlKey,
                    meta: e.metaKey,
                    shift: e.shiftKey,
                });
            }
        };
        window.addEventListener('keydown', this.keyHandler);
    }

    // ── Input listeners ────────────────────────────────────────────────
    //
    // Press / release / wheel / keyup are registered unconditionally.
    // They're low-frequency, and the worker safely no-ops if no widget
    // claims them. Gating them on a one-shot callin probe at "ready" time
    // races widget initialization: chili and other handler widgets often
    // declare MousePress / MouseRelease but only finish populating
    // widgetHandler.MousePressList during their first Update tick — by
    // which point we'd already missed their callin in the registration.
    //
    // MouseMove stays gated because it fires per pointer pixel; no point
    // serializing 200 events/sec across the bridge if nothing reads them.

    private registerInputListeners(callins: string[]): void {
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (!canvas) return;

        const has = (name: string) => callins.includes(name);
        console.log(`[LuaUI] Registering input for callins: ${callins.join(', ')}`);

        // KeyRelease — unconditional; the worker dispatches via
        // widgetHandler:KeyRelease which no-ops cleanly when KeyReleaseList
        // is empty.
        this.keyUpHandler = (e: KeyboardEvent) => {
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (isModifierOnly(e)) return;
            this.postToWorker({
                type: 'keyrelease',
                keyCode: springKeyCode(e),
                alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey,
            });
        };
        window.addEventListener('keyup', this.keyUpHandler);
        this.inputCleanups.push(() => {
            if (this.keyUpHandler) window.removeEventListener('keyup', this.keyUpHandler);
        });

        // MousePress / MouseRelease / MouseWheel — listen on `window` in
        // the capture phase. The Babylon scene attaches its own pointer
        // handling to the canvas (scene.onPointerObservable), and on the
        // first pointerdown it calls setPointerCapture. Bubble-phase
        // listeners we registered on the canvas were never reached after
        // that — the pointer event went straight to Babylon and never
        // bubbled. Capture phase on window runs before any element-level
        // capture, so we always see the event before Babylon does.
        //
        // Filter by hit-testing the click against the canvas bounding box
        // rather than e.target. Walking ancestors of the target works most
        // of the time, but stacking surprises (a stray overlay element,
        // a HUD panel that briefly shows, the lobby UI peeking through
        // during teardown) can pin e.target to something else even when
        // the cursor is visually over the canvas. The bounding-box check
        // is the same hit test the user sees.
        //
        // Coordinates: clientX/Y minus the canvas rect gives canvas-local
        // CSS pixels. We then scale to backing-buffer pixels so coords
        // match what chili's hit test expects.
        const localCoords = (e: MouseEvent): { x: number; y: number } | null => {
            const r = canvas.getBoundingClientRect();
            if (e.clientX < r.left || e.clientX > r.right) return null;
            if (e.clientY < r.top || e.clientY > r.bottom) return null;
            const sx = canvas.width / r.width;
            const sy = canvas.height / r.height;
            const x = (e.clientX - r.left) * sx;
            const y = (e.clientY - r.top) * sy;
            return { x, y: canvas.height - y };
        };

        // Use POINTER events, not MOUSE events. Babylon attaches its own
        // pointerdown handler to the canvas that calls preventDefault();
        // when preventDefault is called on a pointerdown, the browser
        // does not synthesize the matching mousedown — so a window-level
        // mousedown listener (capture or bubble) will never see clicks
        // on the Babylon canvas. mouseup still fires because Babylon
        // doesn't cancel pointerup, but a press without a release is
        // never enough for chili to fire OnClick.
        //
        // Pointer events bypass that compat-event suppression and fire
        // for both mouse and touch input. Capture phase + window scope
        // means we run before Babylon's listener regardless of how it's
        // attached.
        const downHandler = (e: PointerEvent) => {
            const c = localCoords(e);
            if (!c) return;
            this.postToWorker({
                type: 'mousepress',
                x: c.x, y: c.y,
                button: domButtonToSpring(e.button),
            });
        };
        window.addEventListener('pointerdown', downHandler, true);
        this.inputCleanups.push(() => window.removeEventListener('pointerdown', downHandler, true));

        const upHandler = (e: PointerEvent) => {
            const c = localCoords(e);
            if (!c) return;
            this.postToWorker({
                type: 'mouserelease',
                x: c.x, y: c.y,
                button: domButtonToSpring(e.button),
            });
        };
        window.addEventListener('pointerup', upHandler, true);
        this.inputCleanups.push(() => window.removeEventListener('pointerup', upHandler, true));

        const wheelHandler = (e: WheelEvent) => {
            if (e.target !== canvas) return;
            this.postToWorker({
                type: 'mousewheel',
                up: e.deltaY < 0,
                value: Math.abs(e.deltaY),
            });
        };
        window.addEventListener('wheel', wheelHandler, true);
        this.inputCleanups.push(() => window.removeEventListener('wheel', wheelHandler, true));

        // MouseMove → pointermove (same compat-suppression reasoning as
        // the click handlers). Gated on MouseMove/IsAbove callins because
        // it's high-frequency and we don't want to serialize per-pixel
        // events when no widget cares.
        if (has('MouseMove') || has('IsAbove')) {
            const handler = (e: PointerEvent) => {
                const c = localCoords(e);
                if (!c) return;
                const dx = c.x - this.lastMouseX;
                const dy = c.y - this.lastMouseY;
                this.lastMouseX = c.x;
                this.lastMouseY = c.y;
                this.postToWorker({
                    type: 'mousemove',
                    x: c.x, y: c.y, dx, dy,
                    button: e.buttons ? domButtonToSpring(e.button) : 0,
                });
            };
            window.addEventListener('pointermove', handler, true);
            this.inputCleanups.push(() => window.removeEventListener('pointermove', handler, true));
        }
    }

    // ── Widget list overlay (F9) ────────────────────────────────────────

    private toggleWidgetList(): void {
        if (this.widgetListOverlay) {
            this.widgetListOverlay.remove();
            this.widgetListOverlay = null;
            return;
        }
        // Request fresh data from worker
        this.postToWorker({ type: 'getWidgetList' });
        // If we have cached data, show immediately; it'll update when worker responds
        if (this.lastWidgetData) {
            this.renderWidgetList(this.lastWidgetData);
        }
    }

    private renderWidgetList(dataStr: string): void {
        // Remove existing overlay if open
        if (this.widgetListOverlay) {
            this.widgetListOverlay.remove();
        }

        const overlay = document.createElement('div');
        overlay.id = 'widget-list-overlay';
        overlay.innerHTML = WIDGET_LIST_HTML;
        document.body.appendChild(overlay);
        this.widgetListOverlay = overlay;

        const listEl = overlay.querySelector('.wl-entries')!;
        let countActive = 0, countFailed = 0, countDisabled = 0, countTotal = 0;

        if (dataStr) {
            const lines = dataStr.split('\n').filter(Boolean);
            const sorted = lines.sort((a, b) => {
                const order: Record<string, number> = { active: 0, disabled: 1, failed: 2 };
                return (order[a.split('|')[0]] ?? 3) - (order[b.split('|')[0]] ?? 3);
            });
            for (const line of sorted) {
                const parts = line.split('|');
                const status = parts[0];
                let name = parts[1] || '';
                const author = parts[2] || '';
                const basename = parts[3] || '';
                const error = parts[4] || '';
                const desc = parts[5] || '';
                const date = parts[6] || '';
                const license = parts[7] || '';
                const layer = parts[8] || '';
                const enabled = parts[9] || '';
                const handler = parts[10] || '';
                countTotal++;

                if (!name && error) {
                    const match = error.match(/Failed to load:\s+(\S+)/);
                    name = match?.[1] ?? '(unknown)';
                }

                const row = document.createElement('div');
                row.className = `wl-entry wl-${status}`;

                // Checkbox for enable/disable toggle
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.className = 'wl-cb';
                cb.checked = status === 'active';
                if (name) {
                    const widgetName = name; // capture for closure
                    cb.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.postToWorker({ type: 'toggleWidget', name: widgetName });
                    });
                } else {
                    cb.disabled = true;
                }
                row.appendChild(cb);

                const nameEl = document.createElement('span');
                nameEl.className = 'wl-name';
                nameEl.textContent = name;
                row.appendChild(nameEl);

                if (author) {
                    const authorEl = document.createElement('span');
                    authorEl.className = 'wl-author';
                    authorEl.textContent = `by ${author}`;
                    row.appendChild(authorEl);
                }

                // Expandable detail panel (hidden by default)
                const detailEl = document.createElement('div');
                detailEl.className = 'wl-detail';
                detailEl.style.display = 'none';
                const infoLines: string[] = [];
                if (desc) infoLines.push(`<b>Description:</b> ${this.esc(desc)}`);
                if (basename) infoLines.push(`<b>File:</b> ${this.esc(basename)}`);
                if (date) infoLines.push(`<b>Date:</b> ${this.esc(date)}`);
                if (license) infoLines.push(`<b>License:</b> ${this.esc(license)}`);
                if (layer) infoLines.push(`<b>Layer:</b> ${this.esc(layer)}`);
                if (enabled) infoLines.push(`<b>Default enabled:</b> ${this.esc(enabled)}`);
                if (handler && handler !== 'false' && handler !== 'nil')
                    infoLines.push(`<b>Handler access:</b> yes`);
                if (error) infoLines.push(`<b>Error:</b> <span class="wl-error-text">${this.esc(error.substring(0, 300))}</span>`);
                detailEl.innerHTML = infoLines.join('<br>');

                // Click name to expand/collapse detail
                nameEl.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const showing = detailEl.style.display !== 'none';
                    detailEl.style.display = showing ? 'none' : 'block';
                    nameEl.classList.toggle('wl-expanded', !showing);
                });

                row.appendChild(detailEl);
                listEl.appendChild(row);

                if (status === 'active') countActive++;
                else if (status === 'failed') countFailed++;
                else countDisabled++;
            }
        }

        const header = overlay.querySelector('.wl-header-count');
        if (header) {
            header.textContent = `${countActive} active, ${countDisabled} disabled, ${countFailed} failed`;
        }

        overlay.querySelector('.wl-close')?.addEventListener('click', () => {
            this.toggleWidgetList();
        });
    }

    // ── window.widgets API ──────────────────────────────────────────────

    private buildWindowAPI() {
        const mgr = this;
        return {
            /** Toggle the F9 widget list overlay */
            list() { mgr.toggleWidgetList(); },
            get ready() { return mgr.ready; },
            get vfsFileCount() { return mgr.fileCount; },
            /** Enable a widget by name. Forces a full reload from server. */
            enable(name: string) { mgr.postToWorker({ type: 'enableWidget', name }); },
            /** Disable a widget by name. */
            disable(name: string) { mgr.postToWorker({ type: 'disableWidget', name }); },
            /** Toggle a widget by name. Enabling forces reload. */
            toggle(name: string) { mgr.postToWorker({ type: 'toggleWidget', name }); },
            /** Request the current widget list data (returns via widgetList message). */
            refresh() { mgr.postToWorker({ type: 'getWidgetList' }); },
            /** Pause the frame loop. */
            pause() { mgr.postToWorker({ type: 'pauseFrames' }); },
            /** Resume the frame loop. */
            resume() { mgr.postToWorker({ type: 'resumeFrames' }); },
            /** Evaluate Lua code in the widget worker and return result. */
            eval(code: string): Promise<string> {
                return new Promise(resolve => {
                    mgr.evalResolve = resolve;
                    mgr.postToWorker({ type: 'evalLua', code });
                    setTimeout(() => { if (mgr.evalResolve === resolve) { mgr.evalResolve = null; resolve('timeout'); } }, 5000);
                });
            },
        };
    }

    /** Escape HTML special chars for safe innerHTML injection. */
    private esc(s: string): string {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── Cleanup ─────────────────────────────────────────────────────────

    dispose(): void {
        // Idempotent: a stale __widgetManagerDispose callback left on
        // window or duplicate quitToLobby paths shouldn't trigger
        // repeated shutdown messages to the worker.
        if (this.disposed) return;
        this.disposed = true;
        if (this.stateInterval) {
            clearInterval(this.stateInterval);
            this.stateInterval = null;
        }
        if (this.keyHandler) {
            window.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        if (this.keyUpHandler) {
            window.removeEventListener('keyup', this.keyUpHandler);
            this.keyUpHandler = null;
        }
        for (const cleanup of this.inputCleanups) cleanup();
        this.inputCleanups = [];
        for (const cleanup of this.mouseTrackingCleanups) cleanup();
        this.mouseTrackingCleanups = [];

        if (this.widgetListOverlay) {
            this.widgetListOverlay.remove();
            this.widgetListOverlay = null;
        }
        if (this.worker) {
            this.postToWorker({ type: 'shutdown' });
            this.worker.terminate();
            this.worker = null;
        }
        if (this.overlayCanvas) {
            this.overlayCanvas.remove();
            this.overlayCanvas = null;
        }
        delete (window as any).widgets;
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** DOM MouseEvent.button → Spring button (1=left, 2=middle, 3=right) */
function domButtonToSpring(button: number): number {
    switch (button) {
        case 0: return 1; // left
        case 1: return 2; // middle
        case 2: return 3; // right
        default: return button + 1;
    }
}

function springKeyCode(e: KeyboardEvent): number {
    const map: Record<string, number> = {
        'Backspace': 8, 'Tab': 9, 'Enter': 13, 'Escape': 27, ' ': 32,
        'Delete': 127, 'ArrowLeft': 276, 'ArrowRight': 275,
        'ArrowUp': 273, 'ArrowDown': 274, 'Home': 278, 'End': 279,
        'PageUp': 280, 'PageDown': 281, 'Insert': 277,
        'F1': 282, 'F2': 283, 'F3': 284, 'F4': 285, 'F5': 286,
        'F6': 287, 'F7': 288, 'F8': 289, 'F9': 290, 'F10': 291,
        'F11': 292, 'F12': 293,
    };
    if (map[e.key]) return map[e.key];
    // Modifier-only keypresses: emit the SDL keycode so widgets that
    // early-out on `if k == KEYSYMS.LSHIFT then return end` recognise
    // them and do nothing instead of falling through with k=0 (which
    // some widgets misinterpret as "default action").
    if (e.key === 'Shift')   return e.location === 2 ? 303 : 304;
    if (e.key === 'Control') return e.location === 2 ? 305 : 306;
    if (e.key === 'Alt')     return e.location === 2 ? 307 : 308;
    if (e.key === 'Meta')    return e.location === 2 ? 309 : 310;
    if (e.key.length === 1) return e.key.toLowerCase().charCodeAt(0);
    return 0;
}

/** True for keys that are pure modifiers (Shift / Control / Alt / Meta).
 *  We skip forwarding KeyPress for these to widgets — Spring widgets
 *  generally don't want the modifier itself as a press event, only as
 *  a flag in `mods` on real key events. Forwarding them with keyCode=0
 *  caused ZK widgets that check `key == KEYSYMS.LSHIFT` to miss the
 *  guard and fall through to default-action paths (e.g. opening the
 *  main menu when shift was just held to queue an order). */
function isModifierOnly(e: KeyboardEvent): boolean {
    const k = e.key;
    return k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta';
}

// ── Widget list overlay HTML/CSS ───────────────────────────────────────

const WIDGET_LIST_HTML = `
<style>
#widget-list-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 10000;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Consolas', 'Monaco', monospace;
    color: #ccc;
}
.wl-panel {
    background: #1a1a2e;
    border: 1px solid #444;
    border-radius: 6px;
    width: 700px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.wl-title-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid #333;
    background: #16213e;
    border-radius: 6px 6px 0 0;
}
.wl-title {
    font-size: 14px;
    font-weight: bold;
    color: #e0e0e0;
}
.wl-header-count {
    font-size: 11px;
    color: #888;
}
.wl-close {
    cursor: pointer;
    color: #888;
    font-size: 18px;
    border: none;
    background: none;
    padding: 2px 6px;
}
.wl-close:hover { color: #fff; }
.wl-entries {
    overflow-y: auto;
    padding: 8px;
    max-height: calc(80vh - 50px);
}
.wl-entry {
    padding: 4px 8px;
    margin: 1px 0;
    border-radius: 3px;
    font-size: 12px;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
}
.wl-entry { cursor: pointer; }
.wl-entry:hover { background: rgba(255,255,255,0.05); }
.wl-cb {
    flex-shrink: 0;
    width: 14px; height: 14px;
    accent-color: #4caf50;
    cursor: pointer;
    pointer-events: auto;
}
.wl-failed .wl-cb { accent-color: #f44336; }
.wl-name {
    color: #e0e0e0; font-weight: bold;
    cursor: pointer; text-decoration: underline dotted transparent;
    transition: text-decoration-color 0.15s;
}
.wl-name:hover { text-decoration-color: #888; }
.wl-name.wl-expanded { text-decoration-color: #4caf50; }
.wl-active .wl-name { color: #81c784; }
.wl-failed .wl-name { color: #ef9a9a; }
.wl-author { color: #888; font-size: 11px; }
.wl-detail {
    width: 100%;
    padding: 6px 8px 6px 22px;
    margin-top: 2px;
    font-size: 11px;
    color: #aaa;
    background: rgba(0,0,0,0.25);
    border-radius: 3px;
    line-height: 1.6;
}
.wl-detail b { color: #ccc; }
.wl-error-text { color: #e57373; }
</style>
<div class="wl-panel">
    <div class="wl-title-bar">
        <div>
            <span class="wl-title">LuaUI Widgets</span>
            <span class="wl-header-count"></span>
        </div>
        <button class="wl-close">&times;</button>
    </div>
    <div class="wl-entries"></div>
</div>
`;
