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
import type { Connection, ResourceUpdateInfo, SendToUnsyncedArgInfo } from './connection.js';
import type { EntityStateSnapshot } from './entity-state.js';
import type { AudioManager } from './audio.js';
import { AudioChannel, rewriteAudioExtensionToWebm } from './audio.js';
import { debugConsole } from './debug-console.js';
import { clientSettings } from './client-settings.js';
import { logIngest } from './log-ingest.js';
import { IntelTransitionTracker } from './intel-transitions.js';
import type { LosBitmap } from './los-bitmap.js';
import type { Minimap } from './minimap.js';

// Vite worker import — bundles the worker as a separate chunk
import WidgetWorker from './lua-widget-worker.ts?worker';

/// Heuristic resolver for `Spring.PlaySoundFile(name, …)` from widget
/// Lua. Recoil itself resolves `name` through the `soundItemDefsMap`
/// built from `gamedata/sounds.lua` first (see CSound::GetSoundId),
/// only falling back to a literal-VFS open if no item matches — the
/// SoundItem's `file` field is what supplies the fully-qualified
/// "sounds/foo.wav". We don't ship that map to the client yet, so
/// this approximates it: prepend `sounds/`, append `.wav` when no
/// extension is present. Works for ZK because every `sounds/reply/*`
/// asset is `.wav`; will break for any game shipping `.ogg`/`.mp3`
/// SFX. Proper fix is to honour the SoundItem map — see PLAN-audio.md
/// "Open issues" and "Content-prep audio conversion" (re-encoding
/// every asset to a single canonical `.webm` extension lets us drop
/// this heuristic entirely).
function normalizeSoundPath(name: string): string {
    if (!name) return '';
    let out = name.replace(/^\/+/, '');
    if (out.toLowerCase().startsWith('sounds/')) out = out.substring(7);
    const lastSlash = out.lastIndexOf('/');
    const lastDot = out.lastIndexOf('.');
    const hasExt = lastDot >= 0 && lastDot > lastSlash;
    if (!hasExt) out += '.wav';
    return 'sounds/' + out;
}

/// Map a Spring.PlaySoundFile channel arg to the AudioChannel enum.
/// Recoil accepts both string aliases (`"battle"`/`"sfx"` etc.) and
/// numeric channel IDs (1..3). Anything unrecognised defaults to
/// General — matches Recoil's CLuaUnsyncedCtrl::PlaySoundFile fallback.
function mapChannelName(value: unknown): AudioChannel {
    if (typeof value === 'number') {
        // Recoil's numeric: 1 = Battle, 2 = UnitReply, 3 = UserInterface.
        switch (value) {
            case 1: return AudioChannel.Battle;
            case 2: return AudioChannel.UnitReply;
            case 3: return AudioChannel.UserInterface;
            default: return AudioChannel.General;
        }
    }
    if (typeof value !== 'string') return AudioChannel.General;
    return mapChannelByName(value) ?? AudioChannel.General;
}

/// String channel name → AudioChannel, or null when unrecognised.
/// Used by the volume-config bridge so the worker can target a
/// specific channel by its canonical name.
function mapChannelByName(name: string): AudioChannel | null {
    switch (name.toLowerCase()) {
        case 'general':       return AudioChannel.General;
        case 'sfx':           return AudioChannel.Battle;  // Recoil alias
        case 'battle':        return AudioChannel.Battle;
        case 'voice':         return AudioChannel.UnitReply;  // Recoil alias
        case 'unitreply':     return AudioChannel.UnitReply;
        case 'ui':            return AudioChannel.UserInterface;
        case 'userinterface': return AudioChannel.UserInterface;
        case 'music':         return AudioChannel.BGMusic;
        case 'bgmusic':       return AudioChannel.BGMusic;
        default:              return null;
    }
}

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
    private audioManager: AudioManager | null = null;

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

    /** Pending CommandNotify round-trips: id → resolver. Each
     *  `notifyCommand()` posts a request to the worker and stores its
     *  resolver here; the worker's `commandNotifyResult` reply pops the
     *  resolver and feeds back the consumed flag. A 50ms timer drops
     *  resolvers that never reply (worker stalled / shutting down) so the
     *  main thread never blocks the command pipeline forever — fail-open
     *  semantics: a timeout reports the command as NOT consumed. */
    private pendingCommandNotifies = new Map<number, (consumed: boolean) => void>();
    private commandNotifyRequestId = 0;

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
    /** Latest DOM-space pointer position (window.clientX / clientY). Tracked
     *  separately from `mouseState` because the minimap hit-test runs in
     *  DOM space while the worker mouse state runs in canvas backing-buffer
     *  space with Y flipped to match Spring's screen coords. */
    private lastClientX = 0;
    private lastClientY = 0;

    /** Native minimap instance, registered via setMinimap() once main.ts
     *  has constructed both this manager and the Minimap. When a widget
     *  calls `gl.ConfigMiniMap` / `gl.DrawMiniMapEvents` the manager
     *  forwards the intent here. Null when no minimap exists for this
     *  game (lobby preview, headless tests). */
    private minimap: Minimap | null = null;

    /** Current game frame counter (updated by forwardEntityState) */
    private currentFrame = 0;

    /** Ids currently inside the camera frustum, used to diff which
     *  units entered/left view between updateVisibleUnits ticks. The
     *  worker mirrors this set internally to dispatch widget callins
     *  (gui_attackrange_gl4 reads it for per-frame range stencils). */
    private visibleUnitSet = new Set<number>();
    /** Wall-clock of the last updateVisibleUnits dispatch. 10 Hz cap —
     *  units don't cross the frustum edge every render frame. Aliasing
     *  isn't visible to widgets at this rate. */
    private lastVisibleUnitsTick = 0;

    /** Synthesises UnitEnteredLos / LeftLos / EnteredRadar / LeftRadar /
     *  Cloaked / Decloaked widget callins by diffing snapshot losStates and
     *  stateBits. The server doesn't send transition events directly — see
     *  intel-transitions.ts and PLAN-intel.md Phase 4. */
    private intelTracker = new IntelTransitionTracker();
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

    /** Fired when a widget called the full Spring.SetCameraState form.
     *  `state` is the same table the widget passed in, with any subset
     *  of {px,py,pz, tx,ty,tz, rx,ry,rz, dist, height, fov} populated.
     *  Main.ts maps these onto RTSCamera primitives — fields the host
     *  can't honour are silently ignored. `smoothness` is the same
     *  seconds-ish pacing hint as `onCameraTargetRequest`. */
    onCameraStateRequest?: (state: Record<string, unknown>, smoothness: number) => void;

    /** Fired when a widget called Spring.SetActiveCommand and the API
     *  resolved it to a real cmdId (build cmdIds are negative). Main.ts
     *  wires this to InputManager — build commands enter ground placement
     *  (or queue directly on a pure-factory selection); positive cmdIds with
     *  a world target arm a modal command resolved by the next world click.
     *  `cmdType` is the Spring CMDTYPE_* constant (the host maps it to a
     *  ground / unit / either target). Instant + state-toggle commands are
     *  issued in the worker before this fires, so they don't arrive here. */
    onSetActiveCommandRequest?: (cmdId: number, mods: { left: boolean; right: boolean; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean }, cmdType: number) => void;

    /** Worker→main reply for a `defaultCommandTarget` dispatch. Carries
     *  the cmdId after widget DefaultCommand overrides ran — caller (main.ts)
     *  forwards it into InputManager so the next right-click honours the
     *  override. */
    onDefaultCommandResolved?: (info: { cmdId: number; targetType: 'unit' | 'feature' | null; targetId: number }) => void;

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
    setLiveDataSources(rtsCamera: RTSCamera, connection: Connection, audioManager?: AudioManager): void {
        this.rtsCamera = rtsCamera;
        this.connection = connection;
        if (audioManager) this.audioManager = audioManager;
    }

    /** Hook the MusicDirector so the SoundItem ingest also feeds
     *  per-state playlists. The worker reads gamedata/sounds.lua
     *  once and posts the full map; we hand it to both
     *  AudioManager (for SoundItem lookups) and MusicDirector
     *  (for music_<state>_<n> entries) in one go. */
    setMusicDirector(director: import('./music-director.js').MusicDirector): void {
        this.musicDirector = director;
    }
    private musicDirector: import('./music-director.js').MusicDirector | null = null;

    /** Wire the AnimatedCursor so worker-side AssignMouseCursor /
     *  SetMouseCursor calls reach a real cursor renderer. Without this
     *  set, the cursor messages are silently dropped (the API still
     *  returns true to widgets so Initialize() doesn't crash). */
    setAnimatedCursor(cursor: import('./animated-cursor.js').AnimatedCursor): void {
        this.animatedCursor = cursor;
    }
    private animatedCursor: import('./animated-cursor.js').AnimatedCursor | null = null;

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
            // `ErrorEvent.message` is often empty for worker errors that
            // fire before module init completes or get masked by the
            // cross-origin sanitiser. Surface every diagnostic field —
            // `error` carries the actual Error (with stack) when present.
            const parts: string[] = [];
            if (e.message) parts.push(e.message);
            if (e.filename) parts.push(`${e.filename}:${e.lineno}:${e.colno}`);
            if (e.error) {
                parts.push(e.error.stack ?? String(e.error));
            }
            console.error('[LuaUI] Worker error:', parts.length ? parts.join(' | ') : '(no detail; check Network tab for worker script load failure)', e);
        };
        this.worker.addEventListener('messageerror', (e) => {
            console.error('[LuaUI] Worker messageerror (deserialisation failed):', e);
        });

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

        // Collect localStorage entries the worker needs a synchronous copy
        // of: luaui:* (widget config + saved state) and springConfig.*
        // (Spring.GetConfigInt store, read through ctx.configGet — see
        // PLAN-settings.md §2). The worker can't touch localStorage, so it
        // seeds its storageCache from this snapshot. Also seed any
        // ClientSettings defaults that have no stored value yet, so the
        // worker's first GetConfigInt for a registered key returns the
        // medium-preset default rather than the caller's fallback.
        const storageData: Record<string, string> = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith('luaui:') || k?.startsWith('springConfig.')) {
                storageData[k] = localStorage.getItem(k) ?? '';
            }
        }
        for (const def of clientSettings.defs()) {
            const storageKey = 'springConfig.' + def.key;
            if (!(storageKey in storageData)) {
                storageData[storageKey] = clientSettings.getStored(def.key);
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

        // Get view and projection matrices for WorldToScreenCoords.
        // Babylon's getViewMatrix/getProjectionMatrix can transiently return
        // undefined before the first render frame after a scene rebuild
        // (game restart, hot-reload), so guard both the matrix and toArray.
        const rawView = this.scene.activeCamera ? this.scene.getViewMatrix() : undefined;
        const rawProj = this.scene.activeCamera ? this.scene.getProjectionMatrix() : undefined;
        const viewMatrix = rawView ? new Float32Array(rawView.asArray()) : undefined;
        const projMatrix = rawProj ? new Float32Array(rawProj.asArray()) : undefined;

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
                // Spring's sim playerNum, not the DB account id — this is what
                // Spring.GetLocalPlayerID() must return for a widget's checks
                // against synced playerIDs to hold. See PLAN-native-ui §3.3.
                myPlayerId: conn.playerNum,
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
            this.lastClientX = e.clientX;
            this.lastClientY = e.clientY;
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
        // Window-level pointer tracker for lastClientX / lastClientY.
        // Needed because the chili-controlled minimap canvas sits on top
        // of the main canvas — when the cursor is over the minimap, the
        // `move` listener above doesn't fire (pointer events don't
        // bubble out of the minimap), so isCursorOverUI() would read a
        // stale position.
        const winMove = (e: MouseEvent) => {
            this.lastClientX = e.clientX;
            this.lastClientY = e.clientY;
        };
        window.addEventListener('mousemove', winMove);
        this.mouseTrackingCleanups.push(
            () => canvas.removeEventListener('mousemove', move),
            () => canvas.removeEventListener('mouseenter', enter),
            () => canvas.removeEventListener('mouseleave', leave),
            () => canvas.removeEventListener('mousedown', down),
            () => window.removeEventListener('mouseup', up),
            () => window.removeEventListener('mousemove', winMove),
        );
    }

    /** Track modifier key state */
    private modKeys = { alt: false, ctrl: false, meta: false, shift: false };

    /** Forward an entity state snapshot to the worker for unit queries. */
    forwardEntityState(snapshot: EntityStateSnapshot, isDelta: boolean): void {
        if (this.disposed) return;
        this.currentFrame++;

        // Synthesise widget callins from snapshot diffs *before* posting the
        // snapshot itself, so the worker never sees a unit's losState change
        // without an accompanying Entered/Left callin. Cheap (one Map lookup
        // per entity per tick).
        const transitions = this.intelTracker.diffSnapshot(snapshot, isDelta);

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
            buildProgress: snapshot.buildProgress ? new Uint8Array(snapshot.buildProgress) : null,
        };

        // Build transferable list from the copies
        const transfer: Transferable[] = [];
        for (const key of ['entityIds', 'positionsX', 'positionsY', 'positionsZ', 'headings', 'health', 'defIds', 'teams', 'stateBits', 'losStates', 'buildProgress']) {
            const arr = msg[key] as ArrayBufferView | null;
            if (arr) transfer.push(arr.buffer);
        }

        this.postToWorker(msg, transfer);

        if (transitions.length > 0) {
            this.postToWorker({ type: 'intelTransitions', events: transitions });
        }
    }

    /** Forward an entity destruction to the worker. */
    forwardEntityDestroy(entityId: number): void {
        if (this.disposed) return;
        // Drop the entity from the intel tracker so the next full snapshot
        // doesn't fire spurious Left* callins for a unit that just died.
        this.intelTracker.forget(entityId);
        this.visibleUnitSet.delete(entityId);
        this.postToWorker({ type: 'entityDestroy', entityId });
    }

    /** Diff which units are inside the camera frustum and push the
     *  added / removed ids to the worker. Worker dispatches
     *  `widgetHandler:VisibleUnitAdded(unitId, defId, team)` and
     *  `widgetHandler:VisibleUnitRemoved(unitId)` from the deltas.
     *
     *  Throttled to 10 Hz — units don't cross the frustum edge every
     *  render frame and ZK widgets that consume the callin (notably
     *  `gui_attackrange_gl4`) re-evaluate per render frame anyway, so
     *  aliasing at this cadence is invisible. Callers can wire this
     *  into the per-frame render hook unconditionally; the internal
     *  rate-limit gates the actual work.
     *
     *  `iterUnits` yields one entry per live unit; only id / defId /
     *  team / position / radius are touched. Frustum planes are read
     *  from `this.scene.frustumPlanes`, which Babylon updates as part
     *  of `scene.render()` — call this AFTER the render call to read
     *  fresh planes, or pass a freshly built matrix if needed. */
    updateVisibleUnits(iterUnits: Iterable<{
        id: number; defId: number; team: number;
        x: number; y: number; z: number; radius: number;
    }>): void {
        if (this.disposed) return;
        const now = performance.now();
        if (now - this.lastVisibleUnitsTick < 100) return;
        this.lastVisibleUnitsTick = now;

        const planes = this.scene.frustumPlanes;
        if (!planes || planes.length < 6) return;

        const prev = this.visibleUnitSet;
        const next = new Set<number>();
        const added: Array<{ id: number; defId: number; team: number }> = [];

        for (const u of iterUnits) {
            // AABB-vs-frustum test: a sphere of radius r at (x,y,z) is
            // outside the frustum if it sits beyond any single plane by
            // more than r. Plane normals point inward (Babylon
            // convention); reject early on first outside plane.
            let inside = true;
            for (let i = 0; i < 6; i++) {
                const p = planes[i];
                const d = p.normal.x * u.x + p.normal.y * u.y + p.normal.z * u.z + p.d;
                if (d < -u.radius) { inside = false; break; }
            }
            if (!inside) continue;

            next.add(u.id);
            if (!prev.has(u.id)) {
                added.push({ id: u.id, defId: u.defId, team: u.team });
            }
        }

        const removed: number[] = [];
        for (const id of prev) {
            if (!next.has(id)) removed.push(id);
        }

        this.visibleUnitSet = next;

        if (added.length === 0 && removed.length === 0) return;
        this.postToWorker({
            type: 'visibleUnits',
            added,
            removed,
        });
    }

    /** Forward a per-unit sensor radius override to the worker.
     *  Emitted on the server side by `Spring.SetUnitSensorRadius`; the
     *  worker stores it in `liveState.sensorOverrides` so
     *  `Spring.GetUnitSensorRadius` returns the runtime value rather
     *  than the def baseline. `sensorType` matches SpringWeb's enum
     *  (0=los, 1=airLos, 2=radar, 3=sonar, 4=seismic, 5=radarJammer,
     *  6=sonarJammer). */
    forwardEntitySensorUpdate(entityId: number, sensorType: number, radius: number): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'entitySensorUpdate', entityId, sensorType, radius });
    }

    /** Forward a server-side `Spring.SendToUnsynced(...)` call to the
     *  worker. The worker peels `args[0]` as the topic string and
     *  dispatches via `gadgetHandler:DispatchSyncAction(topic, ...)`.
     *  Matches the upstream `CUnsyncedLuaHandle::RecvFromSynced` shape
     *  so ZK gadgets like `lups_flame_jitter` (which register sync
     *  actions for "flame_FlameShot", "flame_GameFrame", etc.) light up
     *  unchanged. */
    forwardSendToUnsynced(args: ReadonlyArray<SendToUnsyncedArgInfo>): void {
        if (this.disposed) return;
        if (args.length === 0) return;
        this.postToWorker({ type: 'sendToUnsynced', args: args as SendToUnsyncedArgInfo[] });
    }

    /** Forward per-tick seismic ping events. Each ping is the deceived
     *  position the listener "hears" — never the unit's true position.
     *  The ally team is already filtered server-side; we just dispatch. */
    forwardSeismicPings(pings: ReadonlyArray<{ x: number; y: number; z: number; strength: number; allyTeam: number }>): void {
        if (this.disposed || pings.length === 0) return;
        this.postToWorker({ type: 'seismicPings', pings: pings.map(p => ({ ...p })) });
    }

    /** Forward a per-allyteam LOS bitmap snapshot to the worker. The
     *  worker keeps the most recent bitmap per ally team in
     *  `liveState.losBitmaps`; `Spring.IsPosInLos / IsPosInRadar /
     *  IsPosInAirLos` read it on demand. Arrives ~1 Hz. The bit-packed
     *  planes are transferred as `Uint8Array` (cheap, no copy beyond
     *  what the worker postMessage clone does). */
    forwardLosBitmap(bitmap: LosBitmap): void {
        if (this.disposed) return;
        this.postToWorker({
            type: 'losBitmap',
            allyTeam: bitmap.allyTeam,
            width: bitmap.width,
            height: bitmap.height,
            frame: bitmap.frame,
            inLos: bitmap.inLos,
            inRadar: bitmap.inRadar,
            explored: bitmap.explored,
        });
    }

    /** Forward a resource update to the worker. */
    forwardResourceUpdate(info: ResourceUpdateInfo): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'resourceUpdate', ...info });
    }

    /** Forward game info (frame, speed, paused) to the worker. */
    forwardGameInfo(frame: number, speed: number, paused: boolean, gameOver: boolean,
                    wind?: { x: number; y: number; z: number; strength: number; tidal: number },
                    legacyCoordSystem?: boolean, maxUnits?: number): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'gameInfo', frame, speed, paused, gameOver, wind, legacyCoordSystem, maxUnits });
    }

    /** Update the selection state from the main thread. */
    setSelection(ids: readonly number[]): void {
        this.selectedUnitIds = [...ids];
    }

    /** Last hover target reported by the InputManager. Used as a dedupe
     *  guard so identical reports during a stationary cursor (the
     *  hit-test still re-fires on every mousemove) don't spam the worker. */
    private lastHoverKey = '';
    /** Push the current hover-target to the worker. Worker dispatches
     *  widget:DefaultCommand and caches the resolved cmdId for
     *  `Spring.GetDefaultCommand`. Filters out no-op reports so a stationary
     *  cursor doesn't push the same target every frame. */
    forwardDefaultCommandTarget(info: {
        targetType: 'unit' | 'feature' | null;
        targetId: number;
        engineCmd: number;
    }): void {
        if (this.disposed) return;
        const key = `${info.targetType ?? '-'}|${info.targetId}|${info.engineCmd}`;
        if (key === this.lastHoverKey) return;
        this.lastHoverKey = key;
        this.postToWorker({
            type: 'defaultCommandTarget',
            targetType: info.targetType,
            targetId: info.targetId,
            engineCmd: info.engineCmd,
        });
    }

    /** Ask the worker to run the widget-side CommandNotify gate against a
     *  proposed mouse-issued command. Returns true if any widget consumed
     *  the order (caller must suppress the actual `sendPlayerCommand`).
     *
     *  Round-trips via postMessage, so adds ~ms-scale latency to every
     *  mouse-issued order. Acceptable because the existing UI is
     *  optimistic — the server state update will correct any visual
     *  preview when the order lands.
     *
     *  Fail-open: if the worker hasn't booted, has shut down, or doesn't
     *  reply within 50ms, the promise resolves to false. We'd rather send
     *  an extra command than wedge the input pipeline waiting for a stalled
     *  worker. */
    notifyCommand(cmdId: number, params: readonly number[], options: number): Promise<boolean> {
        if (this.disposed || !this.worker || !this.ready) {
            return Promise.resolve(false);
        }
        const requestId = ++this.commandNotifyRequestId;
        return new Promise<boolean>((resolve) => {
            // 50ms cap matches roughly the per-frame budget at 60fps; a
            // mouse-drag waypoint that takes longer than that to dispatch
            // would be visible as lag.
            const timer = setTimeout(() => {
                if (this.pendingCommandNotifies.delete(requestId)) resolve(false);
            }, 50);
            this.pendingCommandNotifies.set(requestId, (consumed) => {
                clearTimeout(timer);
                resolve(consumed);
            });
            this.postToWorker({
                type: 'commandNotify',
                requestId,
                cmdId,
                params: [...params],
                options,
            });
        });
    }

    /** Push a batch of unit defs into the worker. Defs accumulate over
     *  the session — the server streams them on demand as the player
     *  encounters new entity types.
     *  Pass-through: every field on the wire is forwarded so the
     *  worker's buildLuaUnitDef can populate UnitDefs.<id>.customParams,
     *  transportSize, repairSpeed, yardmap, … directly. */
    forwardUnitDefs(defs: ReadonlyArray<object>): void {
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
     *  Server streams the full SCommandDescription surface (name,
     *  action, texture, tooltip, type, params, hidden, disabled) at
     *  ~1 Hz; widgets read these via Spring.GetUnitCmdDescs to render
     *  the integral menu and ZK's cmd_*.lua widgets. */
    forwardUnitCmdDescs(units: ReadonlyArray<{
        unitId: number;
        cmds: ReadonlyArray<{
            cmdId: number; disabled: boolean;
            name: string; action: string; texture: string; tooltip: string;
            type: number; params: string[]; hidden: boolean;
        }>;
    }>): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'unitCmdDescs', units: units.map(u => ({
            unitId: u.unitId,
            cmds: u.cmds.map(c => ({
                cmdId: c.cmdId, disabled: c.disabled,
                name: c.name, action: c.action, texture: c.texture, tooltip: c.tooltip,
                type: c.type, params: [...c.params], hidden: c.hidden,
            })),
        })) });
    }

    /** Push a transport-relationship snapshot into the worker.
     *  Each entry lists a transporter and its currently-carried cargo;
     *  transporters with empty cargo are absent. The worker treats
     *  each snapshot as a complete replacement of its transport cache. */
    forwardUnitTransports(transports: ReadonlyArray<{
        transporterId: number;
        cargo: number[];
    }>): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'unitTransports', transports: transports.map(t => ({
            transporterId: t.transporterId,
            cargo: [...t.cargo],
        })) });
    }

    /** Push a per-unit self-destruct countdown snapshot into the worker.
     *  Units not present in the snapshot are treated as not self-
     *  destructing. */
    forwardUnitSelfD(units: ReadonlyArray<{
        unitId: number;
        secondsRemaining: number;
    }>): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'unitSelfD', units: units.map(u => ({
            unitId: u.unitId, secondsRemaining: u.secondsRemaining,
        })) });
    }

    /** Push a per-unit stockpile-weapon state snapshot into the worker.
     *  Units not present in the snapshot have no stockpile weapon (or
     *  one with zero counters and zero in-flight progress). */
    forwardUnitStockpile(units: ReadonlyArray<{
        unitId: number;
        ready: number;
        queued: number;
        buildPercent: number;
    }>): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'unitStockpile', units: units.map(u => ({
            unitId: u.unitId, ready: u.ready, queued: u.queued, buildPercent: u.buildPercent,
        })) });
    }

    /** Push a per-unit armored toggle snapshot into the worker. Units
     *  not present have the default non-armored state (armored=false,
     *  armoredMultiple=1.0). */
    forwardUnitArmored(units: ReadonlyArray<{
        unitId: number;
        armored: boolean;
        armoredMultiple: number;
    }>): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'unitArmored', units: units.map(u => ({
            unitId: u.unitId, armored: u.armored, armoredMultiple: u.armoredMultiple,
        })) });
    }

    /** Deliver the server's `PathResponse` for a previously-sent
     *  `Spring.PathRequest` to the worker. `waypoints` is the full
     *  path or an empty list if the path manager couldn't find a
     *  route. The worker keys cached responses by `requestId` so
     *  concurrent requests don't collide. */
    forwardPathResponse(
        requestId: number,
        waypoints: ReadonlyArray<readonly [number, number, number]>,
        length: number,
    ): void {
        if (this.disposed) return;
        this.postToWorker({
            type: 'pathResponse',
            requestId,
            // Copy out of the source so we don't hold a reference to
            // the connection's parse buffer.
            waypoints: waypoints.map(w => [w[0], w[1], w[2]] as [number, number, number]),
            length,
        });
    }

    /** Push a server StandingOrderState snapshot into the worker. Each
     *  push replaces the worker's standing-order cache wholesale —
     *  server sends the full visible set on every state change so no
     *  diffing is needed. Widgets read via `Spring.GetStandingOrders`. */
    forwardStandingOrders(orders: ReadonlyArray<{
        orderId: number;
        ownerTeam: number;
        type: string;
        priority: number;
        params: number[];
        conditions: {
            idleOnly: boolean;
            squadTypes: number[];
            withinCenter: readonly [number, number, number];
            withinRadius: number;
            outsideCenter: readonly [number, number, number];
            outsideRadius: number;
            minStrength: number;
            hasCapabilities: string[];
        };
        assignedSquadCount: number;
        active: boolean;
        createdAtFrame: number;
        expiresAtFrame: number;
    }>): void {
        if (this.disposed) return;
        this.postToWorker({
            type: 'standingOrders',
            orders: orders.map(o => ({
                ...o,
                params: [...o.params],
                conditions: {
                    ...o.conditions,
                    squadTypes: [...o.conditions.squadTypes],
                    withinCenter: [...o.conditions.withinCenter] as [number, number, number],
                    outsideCenter: [...o.conditions.outsideCenter] as [number, number, number],
                    hasCapabilities: [...o.conditions.hasCapabilities],
                },
            })),
        });
    }

    /** Push a per-tick batch of lifecycle events into the worker. The
     *  worker dispatches `widget:UnitFromFactory` / `UnitTaken` /
     *  `UnitGiven` / `UnitCreated` callins from each entry. Typically
     *  empty on quiet ticks. */
    forwardUnitLifecycle(events: ReadonlyArray<{
        kind: 'fromFactory' | 'taken' | 'given' | 'created';
        unitId: number;
        unitDefId: number;
        unitTeam: number;
        factoryId: number;
        factoryDefId: number;
        userOrders: boolean;
        oldTeam: number;
        newTeam: number;
        builderId: number;
    }>): void {
        if (this.disposed || events.length === 0) return;
        this.postToWorker({
            type: 'unitLifecycle',
            events: events.map(e => ({ ...e })),
        });
    }

    /** Mirror the current live-projectile set into the worker so ZK's
     *  authored projectile-FX widgets (gfx_projectile_lights.lua, LUPS
     *  emitters) can read it via Spring.GetProjectile* (A3 seam). Called
     *  once per render frame from main.ts with the renderer's snapshot.
     *  The payload is a plain object array — projectile counts are modest
     *  (tens–low-hundreds) so per-frame typed-array transfer isn't worth
     *  the complexity; the worker rebuilds its `projectiles` map from it. */
    forwardProjectileState(projectiles: ReadonlyArray<{
        id: number; defId: number;
        x: number; y: number; z: number;
        vx: number; vy: number; vz: number;
        ttl: number; isBeam: boolean;
    }>): void {
        if (this.disposed) return;
        this.postToWorker({ type: 'projectileState', projectiles });
    }

    /** Push a per-tick batch of synced UnitCommand / UnitCmdDone events
     *  into the worker. The worker dispatches `widget:UnitCommand` /
     *  `widget:UnitCmdDone` from each entry. */
    forwardUnitCommand(events: ReadonlyArray<{
        kind: 'issued' | 'done';
        unitId: number;
        unitDefId: number;
        unitTeam: number;
        cmdId: number;
        params: number[];
        options: number;
        tag: number;
        playerId: number;
        fromSynced: boolean;
        fromLua: boolean;
    }>): void {
        if (this.disposed || events.length === 0) return;
        this.postToWorker({
            type: 'unitCommand',
            events: events.map(e => ({ ...e, params: [...e.params] })),
        });
    }

    /** Push a batch of weapon defs into the worker. The spread copies
     *  every runtime field of the passed WeaponDefInfo objects (the
     *  worker's MinimalWeaponDefWire picks the subset it surfaces as Lua
     *  globals) — including `customParams`, `colorR/G/B`, `typeName`,
     *  `range`, `size` and `beamTtl`, all of which ZK's
     *  gfx_projectile_lights.lua reads off `WeaponDefs[id]`. The narrow
     *  annotation only documents the always-present core fields. */
    forwardWeaponDefs(defs: ReadonlyArray<{
        defId: number; name: string; projectileType: number;
        projectileSpeed: number; range: number; aoe: number; size: number;
        intensity: number; colorR: number; colorG: number; colorB: number;
        duration: number; highTrajectory: boolean;
        beamTtl?: number; typeName?: string;
        customParams?: Record<string, string>;
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

    /// Push a snapshot of the active BGMusic element's currentTime /
    /// duration to the worker so Spring.GetSoundStreamTime resolves
    /// to a recent value. Called whenever music playback state
    /// changes (play, stop, pause); the worker caches the pair and
    /// returns it synchronously from Lua.
    private pushMusicTimeToWorker(): void {
        if (!this.audioManager) return;
        const [played, duration] = this.audioManager.getMusicTime();
        this.postToWorker({ type: 'musicStreamTime', played, duration });
    }

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
            || msg.type === 'entityState'
            || msg.type === 'intelTransitions'
            || msg.type === 'seismicPings') return;
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
            case 'soundItems':     summary = `soundItems (${Object.keys((msg.items as Record<string, unknown>) ?? {}).length} items)`; break;
            case 'playMusicStream':    summary = `playMusicStream ${msg.file}`; break;
            case 'stopMusicStream':    summary = 'stopMusicStream'; break;
            case 'pauseMusicStream':   summary = 'pauseMusicStream'; break;
            case 'setMusicStreamVolume': summary = `setMusicStreamVolume ${msg.volume}`; break;
            case 'setSoundEffectParams': summary = `setSoundEffectParams ${typeof msg.value === 'string' ? msg.value : '(table)'}`; break;
            case 'setChannelVolume':   summary = `setChannelVolume ${msg.channel}=${msg.volume}`; break;
            case 'setMasterVolume':    summary = `setMasterVolume ${msg.volume}`; break;
            case 'widgetList':     summary = `widgetList (${String(msg.data ?? '').length} bytes)`; break;
            case 'giveOrder':      summary = `giveOrder cmd=${msg.cmdId} units=${(msg.unitIds as unknown[])?.length ?? 0} params=${(msg.params as unknown[])?.length ?? 0}`; break;
            case 'commandNotify':       summary = `commandNotify cmd=${msg.cmdId} req=${msg.requestId} params=${(msg.params as unknown[])?.length ?? 0}`; break;
            case 'commandNotifyResult': summary = `commandNotifyResult req=${msg.requestId} consumed=${msg.consumed}`; break;
            case 'defaultCommandTarget':   summary = `defaultCommandTarget type=${msg.targetType} id=${msg.targetId} engineCmd=${msg.engineCmd}`; break;
            case 'defaultCommandResolved': summary = `defaultCommandResolved cmdId=${msg.cmdId} type=${msg.targetType} id=${msg.targetId}`; break;
            case 'sendLuaRulesMsg': summary = `sendLuaRulesMsg (${(msg.data as string)?.length ?? 0} bytes)`; break;
            case 'pathRequest':       summary = `pathRequest req=${msg.requestId} moveType=${msg.moveType}`; break;
            case 'pathRequestCancel': summary = `pathRequestCancel req=${msg.requestId}`; break;
            case 'pathResponse':      summary = `pathResponse req=${msg.requestId} waypoints=${(msg.waypoints as unknown[])?.length ?? 0}`; break;
            case 'setSelection':   summary = `setSelection units=${(msg.unitIds as unknown[])?.length ?? 0}`; break;
            case 'setCameraTarget': summary = `setCameraTarget x=${msg.x} z=${msg.z} smooth=${msg.smoothness}`; break;
            case 'setCameraState':  summary = `setCameraState (${Object.keys(msg.state as Record<string, unknown> ?? {}).length} fields) smooth=${msg.smoothness}`; break;
            case 'uiHover':        summary = `uiHover above=${msg.above}`; break;
            case 'inputConsumed':  summary = `inputConsumed kind=${msg.kind} consumed=${msg.consumed}`; break;
            case 'minimapGeometry': summary = `minimapGeometry @${msg.x},${msg.y} ${msg.w}x${msg.h} visible=${msg.visible}`; break;
            case 'minimapEvents':  summary = 'minimapEvents'; break;
            case 'minimapMarker':  summary = `minimapMarker @${msg.x},${msg.z}`; break;
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
                this.applyStartupWidgetDisables();
                break;

            case 'widgetList':
                this.lastWidgetData = msg.data;
                this.renderWidgetList(msg.data);
                break;

            case 'storage:set':
                try {
                    localStorage.setItem(msg.key, msg.value);
                } catch { /* silent */ }
                // Mirror Spring config writes into ClientSettings so native
                // subsystems (shadow quality, decals, particle caps, …) that
                // subscribed to the key apply the change live (PLAN-settings.md
                // §2/§4). ClientSettings re-persists under the same prefixed
                // key — idempotent. Non-springConfig keys (luaui:*) are left
                // to localStorage alone.
                if (msg.key.startsWith('springConfig.')) {
                    clientSettings.set(msg.key.slice('springConfig.'.length), msg.value);
                }
                break;

            case 'soundItems': {
                // Worker has parsed gamedata/sounds.lua and posted the
                // resulting SoundItems map. Hand it to AudioManager so
                // server-emitted SoundEvents (resolved via SoundRef.name)
                // and widget Spring.PlaySoundFile calls share the same
                // per-item gain / pitch / priority / maxconcurrent /
                // maxdist / rolloff / in3d defaults. Also feed the
                // MusicDirector so music_<state>_<n> entries become
                // per-state playlists.
                const items = msg.items as Record<string, import('./audio.js').SoundItem>;
                const map = new Map<string, import('./audio.js').SoundItem>();
                for (const [k, v] of Object.entries(items ?? {})) {
                    map.set(k, v);
                }
                if (this.audioManager) {
                    const contentBase =
                        `${this.options.lobbyUrl}/api/games/data/${this.options.gameId}`;
                    this.audioManager.ingestSoundItems(map, contentBase);
                }
                this.musicDirector?.ingestPlaylistsFromSoundItems(map);
                break;
            }

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

            case 'defaultCommandResolved': {
                const cmdId = Number(msg.cmdId | 0);
                const targetType = msg.targetType === 'unit' || msg.targetType === 'feature'
                    ? msg.targetType as 'unit' | 'feature'
                    : null;
                const targetId = Number(msg.targetId | 0);
                this.onDefaultCommandResolved?.({ cmdId, targetType, targetId });
                break;
            }

            case 'commandNotifyResult': {
                const requestId = Number(msg.requestId | 0);
                const consumed = msg.consumed === true;
                const resolver = this.pendingCommandNotifies.get(requestId);
                if (resolver) {
                    this.pendingCommandNotifies.delete(requestId);
                    resolver(consumed);
                }
                break;
            }

            // NOTE: the 'deferredLights' worker message was retired 2026-06-04.
            // The render core + FxLightPool moved into the worker in GW4, so
            // ZK's authored deferred lights now feed the worker's FxLightPool
            // directly (lua-widget-worker.ts _SpringWebEmitDeferredLights) with
            // no main-thread round-trip. The old sink here was orphaned by GW4.

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

            case 'setActiveCommand': {
                const cmdId = Number(msg.cmdId | 0);
                const cmdType = Number(msg.cmdType | 0);
                const mods = msg.mods as { left: boolean; right: boolean; alt: boolean; ctrl: boolean; meta: boolean; shift: boolean } | undefined;
                if (!mods || cmdId === 0) break;
                this.onSetActiveCommandRequest?.(cmdId, mods, cmdType);
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

            case 'pathRequest': {
                // Worker → main: forward Spring.PathRequest to the server.
                // The server replies asynchronously with a PathResponse
                // which we route back through `forwardPathResponse`.
                const conn = this.connection;
                if (!conn) break;
                const requestId = Number(msg.requestId | 0);
                const sx = Number(msg.startX), sy = Number(msg.startY), sz = Number(msg.startZ);
                const ex = Number(msg.endX),   ey = Number(msg.endY),   ez = Number(msg.endZ);
                const moveType = Number(msg.moveType | 0);
                const radius   = Number(msg.goalRadius);
                if (requestId <= 0 || !Number.isFinite(sx) || !Number.isFinite(ex)) break;
                conn.sendPathRequest(
                    requestId, sx, sy, sz, ex, ey, ez,
                    moveType, Number.isFinite(radius) ? radius : 8.0);
                break;
            }

            case 'pathRequestCancel': {
                const conn = this.connection;
                if (!conn) break;
                const requestId = Number(msg.requestId | 0);
                if (requestId <= 0) break;
                conn.sendPathRequestCancel(requestId);
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

            case 'setCameraState': {
                const state = (msg.state && typeof msg.state === 'object')
                    ? msg.state as Record<string, unknown> : {};
                const smoothness = Number(msg.smoothness) || 0;
                this.onCameraStateRequest?.(state, smoothness);
                break;
            }

            case 'assignMouseCursor': {
                const cursor = this.animatedCursor;
                if (!cursor) break;
                const name = typeof msg.name === 'string' ? msg.name : '';
                const file = typeof msg.file === 'string' ? msg.file : '';
                if (!name || !file) break;
                const hx = typeof msg.hotspotX === 'number' ? msg.hotspotX : null;
                const hy = typeof msg.hotspotY === 'number' ? msg.hotspotY : null;
                const overwrite = msg.overwrite !== false;
                cursor.assign(name, file, hx, hy, overwrite);
                break;
            }

            case 'setMouseCursor': {
                const cursor = this.animatedCursor;
                if (!cursor) break;
                const name = typeof msg.name === 'string' ? msg.name : '';
                cursor.setActive(name || null);
                break;
            }

            case 'playSound': {
                // Worker-side Spring.PlaySoundFile forwards here. Resolve
                // the path against the game's data root, look up
                // SoundItem metadata in the AudioManager's map, decode
                // lazily, and play through the voice pool on the
                // requested channel.
                const am = this.audioManager;
                if (!am) break;
                const path = typeof msg.path === 'string' ? msg.path : '';
                if (!path) break;
                const volume = typeof msg.volume === 'number' ? msg.volume : 1;
                const x = typeof msg.x === 'number' ? msg.x : 0;
                const y = typeof msg.y === 'number' ? msg.y : 0;
                const z = typeof msg.z === 'number' ? msg.z : 0;
                const spatial = !!msg.spatial;

                // Map the caller-supplied channel arg (Recoil bind form)
                // to our AudioChannel enum. Defaults to General.
                const channel = mapChannelName(msg.channel);

                // SoundItem lookup — when the widget asked for a logical
                // name (`"reply/bot_select"`, `"weapon/laser1"`) and the
                // game's gamedata/sounds.lua has a matching entry, use
                // its gain / pitch / priority / etc. defaults instead
                // of the engine defaults.
                const item = am.resolveSoundItem(path);
                let url: string;
                if (item && item.file) {
                    const rel = rewriteAudioExtensionToWebm(
                        item.file.startsWith('sounds/')
                            ? item.file
                            : 'sounds/' + item.file);
                    url = `${this.options.lobbyUrl}/api/games/data/${this.options.gameId}/${rel}`;
                } else {
                    // Widgets pass Spring-convention paths like
                    // "reply/bot_select" — engine convention prepends
                    // `sounds/` and the audioconverter pass made the
                    // file `.webm`.
                    const resolved = rewriteAudioExtensionToWebm(
                        normalizeSoundPath(path));
                    url = `${this.options.lobbyUrl}/api/games/data/${this.options.gameId}/${resolved}`;
                }

                const itemGain  = item?.gain  ?? 1;
                const itemPitch = item?.pitch ?? 1;
                const gainMod   = item?.gainmod  ?? 0;
                const pitchMod  = item?.pitchmod ?? 0;
                const r01 = (Math.random() * 2 - 1);
                const r02 = (Math.random() * 2 - 1);
                const finalVolume = itemGain * (1 + r01 * gainMod) * volume;
                const finalPitch  = itemPitch * (1 + r02 * pitchMod);
                const finalPriority = item?.priority ?? 0;
                const finalSpatial = spatial && (item?.in3d !== false);
                const rolloff = item?.rolloff;
                const maxDist = item?.maxdist;

                am.loadSound(url, url).then((buf) => {
                    if (!buf) return;
                    am.play({
                        buffer: buf,
                        x: finalSpatial ? x : 0,
                        y: finalSpatial ? y : 0,
                        z: finalSpatial ? z : 0,
                        volume: finalVolume,
                        pitch: finalPitch,
                        priority: finalPriority,
                        channel,
                        spatial: finalSpatial,
                        rolloff, maxDist,
                    });
                });
                break;
            }

            case 'playMusicStream': {
                const am = this.audioManager;
                if (!am) break;
                const file = typeof msg.file === 'string' ? msg.file : '';
                if (!file) break;
                const v = typeof msg.volume === 'number' ? msg.volume : 1;
                const rel = rewriteAudioExtensionToWebm(
                    file.startsWith('sounds/') ? file : 'sounds/' + file);
                const url = `${this.options.lobbyUrl}/api/games/data/${this.options.gameId}/${rel}`;
                // No fade for widget-driven music — the music-state
                // machine path uses crossfades on broadcast MusicEvents.
                am.playMusic(url, v, 0);
                this.pushMusicTimeToWorker();
                break;
            }
            case 'stopMusicStream': {
                const fadeMs = typeof msg.fadeMs === 'number' ? msg.fadeMs : 250;
                this.audioManager?.stopMusic(fadeMs);
                this.pushMusicTimeToWorker();
                break;
            }
            case 'pauseMusicStream':
                this.audioManager?.pauseMusic();
                this.pushMusicTimeToWorker();
                break;
            case 'setMusicStreamVolume': {
                const v = typeof msg.volume === 'number' ? msg.volume : 1;
                this.audioManager?.setChannelVolume(
                    4 /* BGMusic */, Math.max(0, Math.min(1, v)));
                break;
            }
            case 'setSoundEffectParams': {
                const v = msg.value;
                const am = this.audioManager;
                if (!am) break;
                if (typeof v === 'string') {
                    const contentBase = `${this.options.lobbyUrl}/api/games/data/${this.options.gameId}`;
                    void am.setReverbPreset(v, contentBase);
                } else if (v && typeof v === 'object') {
                    const obj = v as Record<string, unknown>;
                    if (typeof obj.preset === 'string') {
                        const contentBase = `${this.options.lobbyUrl}/api/games/data/${this.options.gameId}`;
                        void am.setReverbPreset(obj.preset, contentBase);
                    }
                    const wet = typeof obj.wet === 'number' ? obj.wet : undefined;
                    const dry = typeof obj.dry === 'number' ? obj.dry : undefined;
                    if (wet !== undefined || dry !== undefined) {
                        am.setReverbMix(wet ?? 0.5, dry ?? 0.5);
                    }
                }
                break;
            }
            case 'setChannelVolume': {
                const v = typeof msg.volume === 'number' ? msg.volume : 1;
                const chName = typeof msg.channel === 'string' ? msg.channel : '';
                const ch = mapChannelByName(chName);
                if (ch !== null) {
                    this.audioManager?.setChannelVolume(
                        ch, Math.max(0, Math.min(1, v)));
                }
                break;
            }
            case 'setMasterVolume': {
                const v = typeof msg.volume === 'number' ? msg.volume : 1;
                this.audioManager?.setMasterVolume(Math.max(0, Math.min(1, v)));
                break;
            }

            case 'uiHover':
                // Fire-and-forget hover state pushed by the worker after each
                // mousemove. InputManager reads this via isCursorOverUI() to
                // gate ground selection / orders on the next mousedown.
                this.cursorOverUI = !!msg.above;
                break;

            case 'inputConsumed':
                // Per-click authoritative answer from the worker's
                // widgetHandler:MousePress. The mousemove-driven `cursorOverUI`
                // flag lags the cursor by a postMessage round-trip and reads
                // stale-false when a panel appears under a stationary cursor or
                // a click beats the next mousemove. When the worker reports a
                // widget actually consumed the press, latch `cursorOverUI` true
                // so the matching pointerup's isCursorOverUI() check (in
                // InputManager.onLeftUp) suppresses the ground deselect. The
                // next real mousemove re-derives the true hover state.
                if (msg.kind === 'mousepress' && msg.consumed) {
                    this.cursorOverUI = true;
                }
                break;

            case 'minimapGeometry': {
                // gl.ConfigMiniMap / Spring.SetMiniMapGeometry from a widget
                // (typically gui_chili_minimap.lua). Coords are Spring
                // screen-space (Y-up from bottom-left); applyMinimapGeometry
                // converts to DOM-space and applies to the native canvas.
                const x = Number(msg.x ?? 0);
                const y = Number(msg.y ?? 0);
                const w = Number(msg.w ?? 0);
                const h = Number(msg.h ?? 0);
                const visible = msg.visible !== false;
                this.applyMinimapGeometry(x, y, w, h, visible);
                break;
            }

            case 'minimapEvents':
                // gl.DrawMiniMapEvents — widget asked for the events
                // overlay this frame. The minimap suppresses it in
                // widget-owned mode unless this signal arrives recently.
                this.minimap?.markEventsRequested();
                break;

            case 'minimapMarker':
                // Spring.MarkerAddPoint / MarkerAddLine — push a cyan
                // ring pulse onto the minimap event layer. Local-only
                // (the engine doesn't currently broadcast Lua marker
                // calls to other clients).
                this.minimap?.pushMarkerPing({
                    x: msg.x as number,
                    z: msg.z as number,
                });
                // Also unlock the events overlay so widget-owned mode
                // doesn't hide the marker the user just dropped.
                this.minimap?.markEventsRequested();
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
     *  selection when the click belongs to LuaUI. Also returns true when the
     *  cursor is over the widget-claimed minimap rect, so InputManager treats
     *  clicks there as belonging to the minimap (handled by the canvas's own
     *  mousedown listener) rather than the ground. */
    isCursorOverUI(): boolean {
        if (this.cursorOverUI) return true;
        // Also claim clicks on the widget-controlled minimap rect — the
        // canvas owns its own mousedown handler (camera move / order
        // placement), so InputManager must not also process the same
        // click as a ground action. Hit-test in DOM client coords
        // against the tracked rect.
        const m = this.minimap;
        if (!m) return false;
        return m.hitTest(this.lastClientX, this.lastClientY);
    }

    /** Register the native Minimap. Once set, widget calls to
     *  `gl.ConfigMiniMap` / `gl.DrawMiniMapEvents` and
     *  `Spring.SetMiniMapGeometry` reach the minimap through here. */
    setMinimap(minimap: Minimap | null): void {
        this.minimap = minimap;
    }

    /** Forward a seismic ping to the native minimap's events layer.
     *  Mirrors `forwardSeismicPings` (which goes to the widget worker);
     *  the minimap subscriber is separate so neither path has to wait
     *  on the other or read out of the worker. */
    pushMinimapSeismicPings(pings: ReadonlyArray<{ x: number; z: number }>): void {
        const m = this.minimap;
        if (!m) return;
        for (const p of pings) m.pushSeismicPing(p);
    }

    /** Apply a Spring-screen-space geometry message to the native
     *  minimap. Spring's API delivers coords with Y-up from the bottom;
     *  the canvas needs DOM-space (Y-down from the top), so we flip Y
     *  here. The chili widget passes a (0,0,0,0) config to suppress the
     *  minimap when its frame is collapsed — we treat zero-area as
     *  "hidden" rather than relocating to the corner. */
    private applyMinimapGeometry(x: number, y: number, w: number, h: number, visible: boolean): void {
        const m = this.minimap;
        if (!m) return;
        if (!visible || w <= 0 || h <= 0) {
            m.setVisible(false);
            return;
        }
        const vh = window.innerHeight;
        const domY = vh - y - h;
        m.setGeometry(x, domY, w, h);
        m.setVisible(true);
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

    /** Guards applyStartupWidgetDisables so a re-emitted `ready` (game
     *  restart / reconnect on the same manager) doesn't re-run it. */
    private startupDisablesApplied = false;

    /**
     * Disable widgets named in the `?disableWidgets=` URL param once the
     * worker is ready. Value is a comma-separated list of widget GetInfo
     * names (URL-decoded). Debug/test launches use this to suppress
     * blocking startup overlays — chiefly ZK's "Startup Info and Selector"
     * commander chooser — without affecting normal lobby launches (which
     * never carry the param, so a real player still gets the selector).
     * See the spring-debug skill for the canonical debug URL.
     */
    private applyStartupWidgetDisables(): void {
        if (this.startupDisablesApplied) return;
        this.startupDisablesApplied = true;
        let raw: string | null = null;
        try {
            raw = new URLSearchParams(window.location.search).get('disableWidgets');
        } catch { /* no window/search available */ }
        if (!raw) return;
        const names = raw.split(',').map(s => s.trim()).filter(Boolean);
        for (const name of names) {
            console.log(`[LuaUI] ?disableWidgets: disabling "${name}"`);
            this.postToWorker({ type: 'disableWidget', name });
        }
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
        this.intelTracker.reset();
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
        // Release any in-flight CommandNotify resolvers so awaiting
        // CommandBuffer.sendCommand calls fail open and the connection
        // still flushes (we don't want a torn-down widget manager to
        // silently swallow late commands).
        for (const resolver of this.pendingCommandNotifies.values()) {
            try { resolver(false); } catch { /* ignore */ }
        }
        this.pendingCommandNotifies.clear();
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
