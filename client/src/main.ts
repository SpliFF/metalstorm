/**
 * Spring RTS Web — Browser Client Entry Point
 *
 * Flow: Login → Room Browser → Room Setup → Game
 */

// Side-effect import: registers Babylon's KTX2 loader + pins the
// transcoder asset URLs to a CDN copy. After the KTX2 migration every
// GPU texture (unit + feature + terrain + minimap) is `.ktx2`.
import './core/ktx2-config.js';
import { DefCache } from './core/def-cache.js';
import { AudioManager } from './core/audio.js';
import { SoundEventPlayer } from './core/sound-events.js';
import { MusicDirector } from './core/music-director.js';
import { AnimatedCursor } from './core/animated-cursor.js';
import { BuildMenu } from './core/build-menu.js';
import { EconomyBar } from './core/economy-bar.js';
import { FactoryQueuePanel } from './core/factory-queue-panel.js';
import { buildTerrainMesh, loadTerrainTextures, TerrainFog, DeformableTerrain, type MapDimensions } from './core/terrain.js';
import { DecalOverlay, buildTrackTypeNames } from './core/decal-overlay.js';
import { attachDecalOverlay } from './core/decal-overlay-plugin.js';
import { LobbyUI } from './lobby/lobby-ui.js';
import { Minimap } from './core/minimap.js';
import { LosBitmapStore } from './core/los-bitmap.js';
import { CommandPathRenderer } from './core/command-path-renderer.js';
import { WaypointMarkerRenderer } from './core/waypoint-marker-renderer.js';
import { StandingOrderRenderer } from './core/standing-order-renderer.js';
import { DebugTerrainGrid } from './core/debug-terrain-grid.js';
import { Connection } from './core/connection.js';
import { TimingOverlay } from './core/timing-overlay.js';
import { fetchBuildStamp, CONFIG } from './config.js';
import GameWorker from './core/lua-widget-worker.ts?worker';
import type { GpInitToWorker, GpMinimapMetalSpots, GpTimingState } from './core/game-worker-protocol.js';
import { DetachSessionManager, DEFAULT_PARK_TTL_MS } from './core/detach-session.js';
import { fetchMapDataHttp, type ParsedMapData } from './core/map-data.js';
import { loadMapLighting, type MapLighting } from './core/map-lighting.js';
import { applyMapLighting, createSceneLighting, type SceneLighting } from './core/scene-lighting.js';
import { PerfOverlay } from './core/perf-overlay.js';
// GW8: the per-envelope net tally now lives in the worker's net-inspector
// instance (fed by the in-worker connection); read it via window.test.netStats().
// The main-thread perf-overlay (F11) re-plumb is deferred to perf checkpoint PC-1.
import { clientSettings } from './core/client-settings.js';
import { sendCameraViewport } from './core/viewport.js';
import { installCameraWindowApi, uninstallCameraWindowApi } from './core/camera-window-api.js';
import { fetchAndIngestDefs } from './core/defs-fetch.js';
import { renderMapFeatures, DynamicFeatureRenderer } from './core/feature-renderer.js';
import { CameraInput } from './core/camera-input.js';
import { RmlOverlayManager } from './ui/rml/rml-overlay.js';
import { TestHarness } from './core/test-harness.js';
import { ScenarioRunner } from './scenarios/runner.js';
import { createHUD, showHUD, updateHUD, updateSpeedHUD } from './ui/hud/hud.js';
import { showQuitConfirm } from './ui/quit-confirm/quit-confirm.js';
import { showGameOver } from './ui/game-over/game-over.js';
import { debugConsole } from './core/debug-console.js';
import { logIngest } from './core/log-ingest.js';
import { configureErrorTelemetry, reportClientError } from './core/client-error-telemetry.js';
import type { ClientErrorReason } from './core/client-error-telemetry.js';
import { HeartbeatWatchdog } from './core/heartbeat-watchdog.js';
import { RecoveryLadder, type RecoveryTrigger } from './core/recovery-ladder.js';
import {
    getDefaultLobbyTemplates,
    loadGameLobbyTemplates,
} from './ui/lobby/loader.js';
import {
    getDefaultGameTemplates,
    loadGameTemplates,
    type GameTemplates,
} from './ui/game/loader.js';

// Active in-game templates. Starts with engine defaults; overwritten when
// a game id is resolved (URL param, localStorage, or room selection).
// createHUD / showQuitConfirm / showGameOver read from this at call time.
let gameTemplates: GameTemplates = getDefaultGameTemplates();

/// Game-processor worker (PLAN-game-worker.md GW4). Owns the Babylon Engine on
/// the transferred #game-canvas.
let gameWorker: Worker | null = null;
/// GW8 tooling bridge. The test harness (window.test) + widget eval
/// (window.widgets.eval) live on main but their state lives in the worker;
/// `workerCall()` issues a `gp:test`/`evalLua` request and resolves the
/// matching reply by id. `lastSceneState` caches the worker's ~10 Hz feed so
/// the harness's read-only getters (selection, cameraPose) stay synchronous.
let gpReqId = 0;
const gpPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let evalReqResolve: ((v: string) => void) | null = null;
let lastSceneState: {
    selectedUnitIds: number[];
    camera: { x: number; y: number; z: number; tx: number; ty: number; tz: number };
} | null = null;
/// PLAN-playable.md G3a: mirrors whether the worker has a build placement armed
/// (from gp:sceneState.buildGhost). Read by the global ESC handler so ESC
/// cancels placement instead of opening the quit dialog. (The old main-thread
/// InputManager that owned this state pre-GW4 was removed in G3b.)
let buildPlacementArmed = false;
/// PLAN-playable.md G3b: mirrors whether the worker has a modal command /
/// area-attack armed (from gp:sceneState.commandModeArmed). ESC cancels it
/// before the build-placement cancel + the quit dialog.
let commandModeArmed = false;
/// Issue a client-bound request to the game-processor worker (GW8). Resolves
/// with the worker's reply value or rejects with its error string.
function workerCall(method: string, args: unknown[] = []): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const w = gameWorker;
        if (!w) { reject(new Error('[test] game worker not running')); return; }
        const id = ++gpReqId;
        gpPending.set(id, { resolve, reject });
        w.postMessage({ type: 'gp:test', id, method, args });
    });
}
/// PLAN-client-resilience.md task 1: heartbeat watchdog probe channel — a
/// dedicated `gp:ping`/`gp:pong` round-trip, deliberately NOT routed through
/// workerCall()/gp:test (gpTestDispatch has its own business logic to run
/// through; the watchdog needs a probe the worker answers from the very top
/// of its dispatcher, before anything that could itself be wedged).
let gpPingId = 0;
const gpPingPending = new Map<number, () => void>();
function sendHeartbeatPing(): Promise<void> {
    return new Promise((resolve, reject) => {
        const w = gameWorker;
        if (!w) { reject(new Error('[watchdog] no game worker')); return; }
        const id = ++gpPingId;
        gpPingPending.set(id, resolve);
        w.postMessage({ type: 'gp:ping', id });
    });
}
/// PLAN-client-resilience.md task 2 (R1 soft rung): `gp:recover`/`gp:recovered`
/// round-trip. Resolves true on the worker's ack, false on a non-ack within the
/// timeout (a worker too wedged to soft-reset), so the RecoveryLadder escalates
/// to R2. Its own timeout means the ladder never hangs waiting on a dead worker.
const GP_RECOVER_TIMEOUT_MS = 3000;
let gpRecoverId = 0;
const gpRecoverPending = new Map<number, (ok: boolean) => void>();
/// True only during an R2 respawn's re-entry into startGame(). The ladder must
/// SURVIVE an R2 respawn (its loop-guard counts are what eventually reach R3);
/// startGame()'s defensive teardown resets the ladder on every OTHER path (cold
/// boot, user re-entry) but skips it while this is set.
let r2RespawnInFlight = false;
function sendRecoverRequest(): Promise<boolean> {
    return new Promise((resolve) => {
        const w = gameWorker;
        if (!w) { resolve(false); return; }
        const id = ++gpRecoverId;
        let done = false;
        const settle = (ok: boolean) => {
            if (done) return;
            done = true;
            gpRecoverPending.delete(id);
            resolve(ok);
        };
        gpRecoverPending.set(id, settle);
        setTimeout(() => settle(false), GP_RECOVER_TIMEOUT_MS);
        w.postMessage({ type: 'gp:recover', id });
    });
}
/// PLAN-client-resilience.md task 2: the R1/R2/R3 recovery ladder + loop guard.
/// The single decision authority for worker failure. Persists across R2
/// respawns (it lives on main; the worker is what gets replaced). Every rung
/// fires ONE telemetry event stamped with the rung + trigger chain; the loop
/// guard bounds recoveries to r1Max+r2Max+1 per 5-min window (provable
/// termination — see recovery-ladder.ts). Reset on teardown so a fresh game
/// starts from a clean ladder.
const recoveryLadder = new RecoveryLadder({
    softReset: sendRecoverRequest,
    respawn: () => {
        // R2: terminate + respawn on the boot path. startGame() does its own
        // defensive worker teardown + watchdog restart; the fresh ClientSession
        // reconnects and the server re-streams a full snapshot (server-
        // authoritative → lossless). E2 (crash during initial load) lands here
        // too — respawn IS the initial boot path.
        if (lastGameArgs) {
            console.warn('[recovery] R2 — respawning game-processor worker + reconnecting');
            r2RespawnInFlight = true;
            enterGame(lastGameArgs.port, lastGameArgs.mapId, lastGameArgs.gameId);
        } else {
            console.error('[recovery] R2 requested but no lastGameArgs — falling back to lobby');
            quitToLobby();
        }
    },
    showErrorScreen: (reportId) => {
        console.error(`[recovery] R3 — giving up; report id ${reportId}`);
        showRecoveryErrorScreen(reportId);
    },
    emitRungEvent: ({ rung, reason, chain, reportId }) => {
        // The rung telemetry event: distinct from the raw per-error reports the
        // detection hooks already fire (rung 'none', rich per-crash context) —
        // this records what the LADDER decided, with the full trigger chain, so
        // the dashboard can see the recovery path taken. Low-volume by
        // construction (the loop guard caps it), so no dedup storm.
        const reasonToClass: Record<RecoveryTrigger, ClientErrorReason> = {
            'context-restored': 'contextLost',
            'context-lost-timeout': 'contextLost',
            'wedged': 'wedged',
            'fatal': 'fatal',
            'worker-error': 'fatal',
        };
        reportClientError({
            reason: reasonToClass[reason] ?? 'fatal',
            errorClass: 'RecoveryLadder',
            message: `${rung} recovery (${reportId}); triggers: ${chain.join(' → ')}`,
            recoveryRung: rung,
        });
    },
    now: () => Date.now(),
});
/// Route a failure signal into the recovery ladder. Central helper so every
/// call site (watchdog, worker onerror, worker fatal message) reads the same.
function ladderTrigger(t: RecoveryTrigger): void {
    recoveryLadder.trigger(t);
}
/// Detects a wedged worker (blocked event loop — the one failure class
/// self.onerror structurally can't catch). Started once gp:init is posted,
/// stopped on teardown. EXTENSION POINT (task 2): onWedged only reports
/// today; the R2 rung (terminate + respawn + reconnect) belongs here once
/// quickstart part B's boot/resync path lands.
const heartbeatWatchdog = new HeartbeatWatchdog({
    ping: sendHeartbeatPing,
    isSuppressed: () => document.hidden || testHarness?.paused === true,
    onWedged: () => {
        console.error('[gameWorker] watchdog: worker unresponsive after 3 missed 2s heartbeats — wedged');
        reportClientError({
            reason: 'wedged',
            errorClass: 'WatchdogWedged',
            message: 'game-processor worker unresponsive after 3 missed 2s heartbeats',
        });
        // PLAN-client-resilience.md task 2: a wedged worker is R2's trigger —
        // hand it to the ladder (terminate + respawn + reconnect). The loop
        // guard bounds repeated wedges to R3.
        ladderTrigger('wedged');
    },
    onRecovered: () => console.log('[gameWorker] watchdog: heartbeat recovered'),
});
let perfOverlay: PerfOverlay | null = null;
/// Timing telemetry panel for the presentation clock (F10). Separate from the
/// perf overlay (F11). The clock itself is worker-resident (created in gpInit,
/// fed by the in-worker connection), so this panel reads the `timing` snapshot
/// that rides gp:sceneState at ~10 Hz — see lastTimingState below.
/// (L-pre.2: main used to hold a second, never-connected PresentationClock
/// exposed as window.__presClock. It was a ghost — never ticked, never fed —
/// so any tooling reading it saw a dead clock. Removed; __gpTiming is the
/// live equivalent.)
let timingOverlay: TimingOverlay | null = null;
/// Latest worker timing snapshot (gp:sceneState.timing); null before the first
/// post / after teardown. Read by timingOverlay + window.__gpTiming.
let lastTimingState: GpTimingState | null = null;
let dynamicFeatureRenderer: DynamicFeatureRenderer | null = null;
let decalOverlay: DecalOverlay | null = null;
let audioManager: AudioManager | null = null;
/// GW4-c5c-2: audio playback stays on the main thread (AudioContext is main-only).
/// The worker decodes SoundEvents + resolves their SoundRef against its def cache,
/// then posts resolved pairs (`gp:audioSoundEvents`) / music transitions
/// (`gp:audioMusic`) here for SoundEventPlayer / MusicDirector to play.
let soundEventPlayer: SoundEventPlayer | null = null;
let musicDirector: MusicDirector | null = null;
/// MusicDirector.arm() gates music start on the scene being live; we open it on
/// the first scene-state tick from the worker (terrain is up by then).
let musicArmed = false;
/// GW4-c5b: thin main-thread DOM-input owner for the game view. Captures
/// pointer/wheel/key events on #game-canvas and forwards them to the
/// game-processor worker, where the interactive camera + scene.pick live.
let cameraInput: CameraInput | null = null;
/// GW4-c5c-3: unsubscribe handle for the gfx.* → worker `gp:config` push.
/// Set in startGame, cleared on teardown so we don't leak a subscriber (or
/// post to a terminated worker) across game sessions.
let gfxConfigUnsub: (() => void) | null = null;
/// Named resize handler so it can be removed on teardown and not leak across
/// game sessions (CODE-REVIEW C8).
let onGameResize: (() => void) | null = null;
/// Trailing-debounce timer + last-sent size for the resize handler. A real
/// size change makes the worker's engine.resize() reallocate the framebuffer +
/// the whole bloom/MSAA/CSM render-target chain on the next scene.render() (a
/// ~190ms stall at retina resolution). Window-drag / devtools-dock / DPR-flip
/// bursts fire dozens of resize events; without coalescing each one pays that
/// realloc. Debounce so a burst collapses to one resize at the end, and skip
/// the post entirely when the device size hasn't actually changed.
let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastSentResize = { w: 0, h: 0, dpr: 0 };
/// Effective render device-pixel-ratio = the display DPR capped by the
/// `gfx.renderScale` quality setting. The render is GPU-fillrate-bound, so on a
/// retina display this cap is the highest-leverage perf knob (2.0 = full
/// retina, 1.5 ≈ −44% pixels, 1.0 = CSS resolution). All canvas-size paths
/// (gp:init + gp:resize) route through here so the setting drives the backing
/// store size; changing it re-sends a resize (see onGameResize subscription).
function effectiveDpr(): number {
    return Math.min(window.devicePixelRatio || 1, clientSettings.getFloat('gfx.renderScale', 1.5));
}
/// GW4-c5b-2: the drag-select rectangle overlay. The worker computes the box
/// (CSS px, canvas-relative) and posts `gp:dragBox`; we draw the div here.
let dragOverlay: HTMLDivElement | null = null;
/// PLAN-rml.md: main-thread RmlUi DOM overlay (BAR RML widgets). Non-null while
/// a game is active; replays `rml:ops` from the worker into real DOM nodes.
let rmlOverlay: RmlOverlayManager | null = null;
/**
 * PLAN-gm-tools §3: render a GM broadcast as a transient system toast. Stacks
 * bottom-centre, auto-dismisses. Deliberately independent of the LuaUI widget
 * layer (the worker already filtered these out of widget dispatch) so a GM
 * message always shows even when the HUD widgets are broken.
 */
function showGmBroadcast(message: string): void {
    if (!message) return;
    let host = document.getElementById('gm-broadcasts');
    if (!host) {
        host = document.createElement('div');
        host.id = 'gm-broadcasts';
        host.style.cssText =
            'position:fixed;left:50%;bottom:12%;transform:translateX(-50%);z-index:60;' +
            'display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;';
        document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.textContent = '⚔ ' + message;
    el.style.cssText =
        'font:600 15px/1.4 system-ui,sans-serif;color:#eaf3ff;background:rgba(20,32,52,0.92);' +
        'border:1px solid #4a8ac0;border-radius:8px;padding:10px 18px;max-width:60vw;text-align:center;' +
        'box-shadow:0 4px 18px rgba(0,0,0,0.5);transition:opacity .4s;';
    host.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 400); }, 8000);
}

function updateDragOverlay(box: { x0: number; y0: number; x1: number; y1: number } | null): void {
    if (!box) { if (dragOverlay) dragOverlay.style.display = 'none'; return; }
    if (!dragOverlay) {
        const div = document.createElement('div');
        div.id = 'drag-select-overlay';
        div.style.position = 'fixed';
        div.style.border = '1px solid rgba(255, 220, 60, 0.9)';
        div.style.background = 'rgba(255, 220, 60, 0.12)';
        div.style.pointerEvents = 'none';
        div.style.zIndex = '50';
        document.body.appendChild(div);
        dragOverlay = div;
    }
    // Box coords are canvas-relative CSS px; offset by the canvas position so
    // the fixed-position div lines up even if the canvas isn't at (0,0).
    const rect = document.getElementById('game-canvas')?.getBoundingClientRect();
    const ox = rect?.left ?? 0;
    const oy = rect?.top ?? 0;
    dragOverlay.style.display = 'block';
    dragOverlay.style.left = `${ox + box.x0}px`;
    dragOverlay.style.top = `${oy + box.y0}px`;
    dragOverlay.style.width = `${box.x1 - box.x0}px`;
    dragOverlay.style.height = `${box.y1 - box.y0}px`;
}
let animatedCursor: AnimatedCursor | null = null;
/// PLAN-playable.md G3b: apply an armed-command cursor. `name` is a canonical
/// Spring cursor name (null → native arrow); `css` is the CSS-cursor fallback
/// shown before/without the animated overlay. Drives both the AnimatedCursor
/// overlay (Spring images) and the `#game-canvas` CSS cursor.
function applyCursorMode(name: string | null, css: string): void {
    animatedCursor?.setActive(name);
    const canvas = document.getElementById('game-canvas');
    if (canvas) canvas.style.cursor = name ? css : '';
}
let buildMenu: BuildMenu | null = null;
let economyBar: EconomyBar | null = null;
let factoryQueuePanel: FactoryQueuePanel | null = null;
let lobbyUI: LobbyUI | null = null;
let minimap: Minimap | null = null;
/// One-shot `gp:minimapFeed` payloads (map dims/backdrop + metal spots) held
/// until the Minimap can take them. The worker clears its copy after the FIRST
/// feed post regardless of delivery, so a feed that races minimap construction
/// must be buffered here — else the dims + metal spots are lost all session.
/// Applied (and cleared) on the next feed once `minimap` exists; reset on
/// session teardown.
let pendingMinimapMap: { width: number; height: number; baseUrl: string } | null = null;
let pendingMinimapMetalSpots: GpMinimapMetalSpots | null = null;
let commandPathRenderer: CommandPathRenderer | null = null;
let waypointMarkerRenderer: WaypointMarkerRenderer | null = null;
let standingOrderRenderer: StandingOrderRenderer | null = null;
let debugTerrainGrid: DebugTerrainGrid | null = null;
/// TestHarness on `window.test` — exposed in startGame(), torn down on
/// quitToLobby(). GW8: server-bound verbs run on main over HTTP; client-bound
/// (camera/selection/netSim/pause/screenshot) forward to the worker, where the
/// render loop now lives (the client render-pause is `gpRenderPaused` there).
let testHarness: TestHarness | null = null;
/// Current sim-speed multiplier for VISUAL FX aging (0 when paused). The
/// render loop scales its wall-clock dt by this before ticking the FX
/// systems (CEG particles, dynamic lights, muzzle flares, distortion,
/// combat FX) so every weapon effect plays out in sim time — slowing or
/// freezing with the game speed. That makes transient FX capturable
/// (drop the speed or pause and they linger) and is more faithful (the
/// engine ages these by sim frame). Set from onGameInfo. Camera/UI ticks
/// keep using the raw wall dt.
let fxSimSpeed = 1;
/// Capture aid: when armed (window.__captureOnFire), the next projectile
/// fire freezes the client FX clock after a short delay so the beam +
/// muzzle flash + impact all hang on screen for a screenshot — no race
/// with the wall clock. Server keeps running; only the visual FX freeze.
/// `window.__captureResume()` (or any speed change) thaws it.
let fxFrozen = false;
let captureOnFireDelayMs: number | null = null;
/// Last server-reported sim speed (for thaw + the fxFrozen override).
let lastServerSpeed = 1;
let lastServerPaused = false;

/// Freeze for capture. The SERVER is the single authority for pause/speed
/// (server_main.cpp gates SimFrame on gs->paused), so freezing pauses the
/// server — units, projectiles, sounds, combat events ALL stop coherently
/// at the source, no client-side event gating needed. We also zero the
/// client FX clock immediately so the frame freezes crisply before the
/// pause round-trips. Thawed by window.__captureResume().
function freezeFx(): void {
    fxFrozen = true;
    fxSimSpeed = 0;
    void testHarness?.simPause();
    console.log('[capture] frozen (server paused) — screenshot now; window.__captureResume() to thaw');
}
/// Cached most-recent command-queue snapshot. Lets a selection change
/// repaint the path overlay without waiting for the next server tick.
let lastCommandQueues: ReadonlyArray<{
    unitId: number;
    orders: ReadonlyArray<{ cmdId: number; params: number[]; tag?: number }>;
}> = [];
/// Game server connection. Non-null while a game is active. Hoisted out
/// of startGame() so the quit-to-lobby handler can close it cleanly.
let gameConn: Connection | null = null;

/// Monotonic session counter. Each startGame() captures the current
/// value; quitToLobby() and subsequent startGame() bumps it. Async
/// callbacks (mapPromise, defsPromise, onMapData) compare against
/// the snapshot before doing work — anything from a stale session
/// bails out, preventing the "quit during loading" leak where a
/// late-resolving fetch builds a LuaWidgetManager (and its overlay
/// canvas) for a game that no longer exists.
let activeSession = 0;

// --- Detach / re-enter (PLAN-quickstart.md Part B) ---
//
// The "detach vs quit" split: detach parks the game-processor worker (engine,
// scene, models, DefCache all alive) and shows the lobby; re-entry is a fast
// `gpResync` reconnect instead of a full boot. `detachSession` owns the pure
// keying/TTL/generation bookkeeping (core/detach-session.ts); the functions
// below drive the DOM/audio/worker handles it deliberately does not touch.
const detachSession = new DetachSessionManager();
/// TTL sweep: a parked worker the player never returns to is torn down after
/// DEFAULT_PARK_TTL_MS. Null when no session is parked.
let parkTtlTimer: number | null = null;
/// E3 guard: detach is only offered after the first rendered frame — before
/// that the worker is half-booted and quit (full teardown) is the only exit.
/// Latched by the first `gp:sceneState` from the worker, reset on each boot.
let firstFrameSeen = false;
/// Last startGame() target, so a full-boot re-entry fallback knows what to boot.
let lastGameArgs: { port: number; mapId: string; gameId: string } | null = null;

// --- Game Scene ---

let currentFrame = 0;

/// Tear down the active game session and show the lobby browser. Safe to
/// call from any in-game context: "Quit" button, ESC-confirm, Game Over
/// overlay, or an error handler. No-op if no game is active.
function quitToLobby(): void {
    // Bump session: any in-flight async work from this session (map
    // fetch, defs fetch, queued onMapData) will see a stale token and
    // bail before creating widget managers / canvases.
    activeSession++;

    // Close the game connection cleanly before disposing the renderer —
    // that way any "player left" hint reaches the game server before
    // our send queue gets torn down.
    gameConn?.disconnect();
    gameConn = null;

    // Clear saved game state so a page refresh lands on the lobby.
    localStorage.removeItem('springrts-game-room');
    localStorage.removeItem('springrts-game-port');

    // Tear down Babylon + the per-session helpers. Most of these hold
    // references to the engine/scene, so letting GC collect them is
    // enough — we just drop our handles. The minimap is an exception:
    // it owns its own engine/canvas parented to #minimap-container,
    // and that container persists across game sessions. Without an
    // explicit dispose the next startGame() would append a second
    // canvas to the container.
    minimap?.dispose();
    minimap = null;
    pendingMinimapMap = null;
    pendingMinimapMetalSpots = null;
    buildMenu?.dispose();
    buildMenu = null;
    economyBar?.dispose();
    economyBar = null;
    factoryQueuePanel?.dispose();
    factoryQueuePanel = null;
    commandPathRenderer?.dispose();
    commandPathRenderer = null;
    waypointMarkerRenderer?.dispose();
    waypointMarkerRenderer = null;
    standingOrderRenderer?.dispose();
    standingOrderRenderer = null;
    debugTerrainGrid?.dispose();
    debugTerrainGrid = null;
    lastCommandQueues = [];
    cameraInput?.dispose();
    cameraInput = null;
    rmlOverlay?.dispose();
    rmlOverlay = null;
    gfxConfigUnsub?.();
    gfxConfigUnsub = null;
    if (onGameResize) { window.removeEventListener('resize', onGameResize); onGameResize = null; }
    if (resizeDebounceTimer !== null) { clearTimeout(resizeDebounceTimer); resizeDebounceTimer = null; }
    animatedCursor?.dispose();
    animatedCursor = null;
    // Game-processor worker owns the Engine + transferred canvas (GW4).
    // Terminating it tears down the Babylon Engine inside the worker; the
    // canvas itself is replaced with a fresh clone on the next startGame().
    gameWorker?.terminate();
    gameWorker = null;
    // PLAN-client-resilience.md task 1: no worker left to ping.
    heartbeatWatchdog.stop();
    gpPingPending.clear();
    // PLAN-client-resilience.md task 2: a full quit ends any recovery episode —
    // reset the ladder + drop in-flight soft-reset requests + the respawn flag.
    recoveryLadder.reset();
    gpRecoverPending.clear();
    r2RespawnInFlight = false;
    uninstallCameraWindowApi();
    delete (window as any).test;
    delete (window as any).widgets;
    delete (window as any).__gp;
    delete (window as any).springrts;
    testHarness = null;
    // PLAN-quickstart.md Part B: a full quit ends any parked session too.
    clearParkTtl();
    detachSession.clear();
    lobbyUI?.clearParked();
    firstFrameSeen = false;
    // GW8: drop any in-flight worker-bridge requests + cached feed.
    for (const p of gpPending.values()) p.reject(new Error('[test] game ended'));
    gpPending.clear();
    evalReqResolve = null;
    lastSceneState = null;
    // The worker (and its presentation clock) is gone — drop the snapshot and
    // repaint the F10 overlay so it actually shows "waiting…" instead of
    // freezing on the last frame (its render is normally only reachable via
    // tick() ← gp:sceneState, which just stopped).
    lastTimingState = null;
    timingOverlay?.refresh();
    musicDirector = null;
    soundEventPlayer = null;
    musicArmed = false;
    audioManager?.dispose();
    audioManager = null;

    // Hide the game canvas and HUD. Any in-flight overlays (quit confirm,
    // game over) are removed here too so the lobby is the only thing left.
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
    if (canvas) canvas.style.display = 'none';
    const hud = document.getElementById('game-hud');
    if (hud) hud.style.display = 'none';
    document.getElementById('quit-confirm-overlay')?.remove();
    document.getElementById('game-over-overlay')?.remove();
    document.getElementById('recovery-error-overlay')?.remove();

    // Show the lobby. The lobby connection stayed open the whole
    // time. If the player is still a member of their room (the normal
    // case after a mid-game quit) land on the room view; otherwise
    // fall through to the room browser.
    //
    // Scenario/direct-boot sessions construct the lobby *suppressed*
    // (every show*() a no-op) — lift that first, or an ESC-quit out of a
    // `?scenario=`/`?direct=` game leaves a permanently blank page. The
    // lobby templates were deliberately kept while suppressed for this.
    lobbyUI?.unsuppress();
    lobbyUI?.showAfterGame();
    lobbyUI?.show();
}

/**
 * PLAN-client-resilience.md task 2 (R3 — give up). The recovery ladder
 * exhausted its rungs (R2 failed twice in the window); show an honest failure
 * with a citable report id and a single way out (return to lobby). Terminate
 * the (crash-looping) worker + stop the watchdog immediately so no further
 * telemetry or recovery storm continues while the screen is up; the button
 * routes through `quitToLobby` for the full teardown (which resets the ladder).
 */
function showRecoveryErrorScreen(reportId: string): void {
    gameWorker?.terminate();
    gameWorker = null;
    heartbeatWatchdog.stop();
    gpPingPending.clear();
    gpRecoverPending.clear();
    document.getElementById('recovery-error-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'recovery-error-overlay';
    overlay.style.cssText =
        'position:fixed;inset:0;z-index:200;display:flex;align-items:center;' +
        'justify-content:center;background:rgba(8,10,14,0.94);color:#e6e8ec;' +
        'font-family:system-ui,sans-serif;';
    const card = document.createElement('div');
    card.style.cssText =
        'max-width:32rem;padding:2rem 2.25rem;background:#161a22;border:1px solid #2a3140;' +
        'border-radius:10px;text-align:center;box-shadow:0 8px 40px rgba(0,0,0,0.5);';
    const h = document.createElement('h2');
    h.textContent = 'The game renderer stopped responding';
    h.style.cssText = 'margin:0 0 0.75rem;font-size:1.25rem;';
    const p = document.createElement('p');
    p.textContent =
        'We tried to recover automatically but the problem persisted. Your game ' +
        'is safe on the server — you can rejoin from the lobby.';
    p.style.cssText = 'margin:0 0 1rem;line-height:1.5;color:#aab2c0;';
    const idEl = document.createElement('p');
    idEl.textContent = `Report id: ${reportId}`;
    idEl.style.cssText =
        'margin:0 0 1.5rem;font-family:ui-monospace,monospace;font-size:0.85rem;' +
        'color:#6f7a8c;user-select:all;';
    const btn = document.createElement('button');
    btn.textContent = 'Return to lobby';
    btn.style.cssText =
        'padding:0.6rem 1.4rem;font-size:1rem;border:0;border-radius:6px;' +
        'background:#3b6fe0;color:#fff;cursor:pointer;';
    btn.addEventListener('click', () => {
        overlay.remove();
        quitToLobby();
    });
    card.append(h, p, idEl, btn);
    overlay.append(card);
    document.body.appendChild(overlay);
}

/// Clear the parked-worker TTL sweep timer (§3.1).
function clearParkTtl(): void {
    if (parkTtlTimer !== null) { clearTimeout(parkTtlTimer); parkTtlTimer = null; }
}

/**
 * PLAN-quickstart.md §3.1 (Part B — detach). Park the running game and show the
 * lobby WITHOUT tearing the worker down. The worker keeps its engine, scene,
 * models, DefCache and JS UI state alive (a `gp:detach` closes its connection
 * and pauses its render loop); main suspends audio and hides the game surface,
 * keeping every per-session helper (HUD, minimap, economy bar) alive-but-hidden
 * so re-entry rebuilds nothing. Unlike `quitToLobby`, the saved room/port keys
 * are kept — they are the reconnect creds.
 *
 * Guards: no-op unless a worker exists, the first frame has rendered (E3), and
 * no session is already parked. Metalstorm is the intended caller; the
 * mechanism is game-agnostic (BAR/ZK keep `quitToLobby` — §3.3).
 */
function detachToLobby(): void {
    if (!gameWorker || !firstFrameSeen || detachSession.isParked) return;
    const roomId = localStorage.getItem('springrts-game-room') ?? '';
    const port = Number(localStorage.getItem('springrts-game-port') ?? '0');
    detachSession.park(roomId, port, Date.now());
    gameWorker.postMessage({ type: 'gp:detach' });
    // Suspend (not dispose) the AudioContext — it resumes on the re-entry click.
    void audioManager?.suspend();
    // Hide the game surface; DO NOT dispose helpers (resync reuses them) and DO
    // NOT clear the saved room/port keys (they drive the reconnect).
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
    if (canvas) canvas.style.display = 'none';
    const hud = document.getElementById('game-hud');
    if (hud) hud.style.display = 'none';
    document.getElementById('quit-confirm-overlay')?.remove();
    // TTL sweep: dispose the parked worker if the player never returns (§3.1).
    clearParkTtl();
    parkTtlTimer = window.setTimeout(disposeParkedWorker, DEFAULT_PARK_TTL_MS);
    lobbyUI?.showAfterGame();
    lobbyUI?.show();
    // Re-enter UX (Part B task 6): a persistent "return to game" card, plus
    // E4 — dispose the parked worker immediately if the game ends while
    // parked, rather than relying solely on the TTL sweep.
    lobbyUI?.markParked(resyncReenter, disposeParkedWorker);
    console.log('[detach] session parked — worker alive; re-enter to resync');
}

/**
 * PLAN-quickstart.md §3.2 (Part B — resync). Re-enter a parked session: tell the
 * worker to flush dynamic renderer state + reconnect (`gp:resync`), resume audio
 * and re-show the game surface. Bumps the detach sub-generation so any lingering
 * pre-detach async bails. The worker's fresh ClientSession re-streams a full
 * snapshot; the world repopulates within a few ticks.
 */
function resyncReenter(): void {
    clearParkTtl();
    detachSession.bumpGeneration();
    detachSession.clear();
    lobbyUI?.clearParked();
    // Refresh the token in case the original aged past the park TTL.
    const token = localStorage.getItem('springrts-token') ?? undefined;
    gameWorker?.postMessage({ type: 'gp:resync', token });
    void audioManager?.resume();
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
    if (canvas) canvas.style.display = 'block';
    showHUD();
    lobbyUI?.hide();
    console.log('[detach] re-entering parked session (resync)');
}

/**
 * Tear down a parked worker that will never be re-entered — the TTL sweep fired
 * (§3.1) or the room ended while parked (E4). Falls through to the full
 * `quitToLobby` teardown, which terminates the worker and disposes every helper.
 */
function disposeParkedWorker(): void {
    if (!detachSession.isParked) return;
    clearParkTtl();
    detachSession.clear();
    console.log('[detach] parked session disposed (TTL / room ended)');
    quitToLobby();
}

/**
 * Enter (or re-enter) a game the lobby has driven to Active. Routes through the
 * detach manager: when a parked worker matches this exact room+port it is a fast
 * `gpResync`; otherwise (cold start, different room, restarted room ⇒ new port
 * per E5, or an expired TTL) it is a clean full boot. A stale parked worker, if
 * any, is terminated by startGame's own defensive teardown.
 */
function enterGame(gameServerPort: number, mapId: string, gameId: string): void {
    const roomId = localStorage.getItem('springrts-game-room') ?? '';
    if (detachSession.planReentry(roomId, gameServerPort, Date.now()) === 'resync') {
        resyncReenter();
        return;
    }
    clearParkTtl();
    detachSession.clear();
    startGame(gameServerPort, mapId, gameId);
}

async function startGame(gameServerPort: number, mapId: string, gameId: string = ''): Promise<void> {
    // Capture this call's session id. Late-arriving promise callbacks
    // (mapPromise, defsPromise, onMapData) compare against this and
    // bail when activeSession has moved on — covers the case where a
    // user quits mid-load and the queued mapData fetch resolves into
    // an orphaned LuaWidgetManager / overlay canvas after teardown.
    activeSession++;
    // NOTE (GW4-c1): the per-call `session` snapshot + its stale-session
    // guards lived in the gutted body; they return in c2 when the connection
    // callbacks (which compare against activeSession) move into the worker.

    // PLAN-quickstart.md Part B: a full boot supersedes any parked session.
    // The defensive teardown below terminates the stale parked worker, so drop
    // the detach bookkeeping and re-arm the first-frame (E3) latch.
    clearParkTtl();
    detachSession.clear();
    firstFrameSeen = false;
    lastGameArgs = { port: gameServerPort, mapId, gameId };

    // Defensive teardown of any leftover session state. `quitToLobby`
    // normally runs this on explicit quit, but a player can re-enter
    // a game through paths that don't go via quitToLobby — for
    // example a room state change transitions straight into a new
    // startGame(). Without this, the old minimap canvas would
    // stay parented to #minimap-container and the new Minimap would
    // append a second canvas on top of it.
    //
    if (minimap) {
        minimap.dispose();
        minimap = null;
    }
    // Stale one-shot minimap payloads from the previous session must not
    // apply to the new session's minimap (the fresh worker resends its own).
    pendingMinimapMap = null;
    pendingMinimapMetalSpots = null;
    if (gameWorker) {
        gameWorker.terminate();
        gameWorker = null;
        heartbeatWatchdog.stop();
        gpPingPending.clear();
    }
    gpRecoverPending.clear();
    // PLAN-client-resilience.md task 2: a cold boot / user re-entry starts a
    // clean ladder; but an R2 respawn re-enters here too and MUST preserve the
    // loop-guard counts (they are what escalates a crash loop to R3). Only the
    // R2 path leaves this flag set.
    if (r2RespawnInFlight) r2RespawnInFlight = false;
    else recoveryLadder.reset();
    if (gameConn) {
        gameConn.disconnect();
        gameConn = null;
    }
    musicDirector = null;
    soundEventPlayer = null;
    musicArmed = false;
    audioManager?.dispose();
    audioManager = null;
    cameraInput?.dispose();
    cameraInput = null;
    rmlOverlay?.dispose();
    rmlOverlay = null;
    gfxConfigUnsub?.();
    gfxConfigUnsub = null;
    if (onGameResize) { window.removeEventListener('resize', onGameResize); onGameResize = null; }
    if (resizeDebounceTimer !== null) { clearTimeout(resizeDebounceTimer); resizeDebounceTimer = null; }
    buildMenu?.dispose();
    buildMenu = null;
    economyBar?.dispose();
    economyBar = null;
    factoryQueuePanel?.dispose();
    factoryQueuePanel = null;
    // The previous session's cursor overlay owns a DOM node + a live rAF
    // loop — without this, a back-to-back startGame() (room-state re-entry
    // that skips quitToLobby) leaks both and stacks a second overlay.
    animatedCursor?.dispose();
    animatedCursor = null;

    showHUD();

    // PLAN-game-worker.md GW4-c1: the world render moves into the
    // game-processor worker. Main relinquishes #game-canvas via
    // transferControlToOffscreen(), so it can no longer create a Babylon
    // Engine on it — the entire main-thread render construction, render
    // loop, and Connection wiring that lived here is gone. The worker
    // rebuilds it across c2–c6 (connection+decoders → terrain → entities
    // → FX → LuaUI world pass). Until c4 the branch's game is intentionally
    // non-running (empty clear-color scene); see PLAN-game-worker.md.

    // #game-canvas is a static element in index.html and can only be
    // transferred to an OffscreenCanvas once. Replace it with a fresh clone
    // on every startGame() so re-entry (quit → relaunch) can transfer again.
    const staleCanvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    const canvas = staleCanvas.cloneNode(false) as HTMLCanvasElement;
    staleCanvas.replaceWith(canvas);
    canvas.style.display = 'block';

    // Build game server URL
    const host = window.location.hostname || 'localhost';
    const gameHttpUrl = `http://${host}:${gameServerPort}`;
    // Empty base = page-origin /api (Vite dev proxy in dev, nginx in prod).
    const lobbyHttpUrl = '';

    // Snapshot the gfx.* settings for the worker — it can't read
    // clientSettings' localStorage-backed store directly. Live changes will
    // arrive over a 'gp:config' message once that bridge lands (GW5).
    const gfx: Record<string, unknown> = {};
    for (const def of clientSettings.defs()) {
        if (def.key.startsWith('gfx.')) gfx[def.key] = clientSettings.get(def.key);
    }

    // Fetch this game's team-color lighting style from the lobby discovery
    // (modinfo `lighting`) so the worker renders the game's authored style
    // instead of a hardcoded default (PLAN-bar.md A4). Best-effort.
    let gameLighting = 'gameplay';
    // The model-material port id (PLAN-bar.md A4): which client material
    // hand-port (if any) this game's template matches. Empty ⇒ the worker
    // uses the engine-default model material. Fetched in the same /api/games
    // round-trip as `lighting`.
    let gameModelMaterialPort = '';
    if (gameId) {
        try {
            const resp = await fetch(`${lobbyHttpUrl}/api/games`);
            if (resp.ok) {
                const games = await resp.json();
                const g = Array.isArray(games) ? games.find((x: any) => x?.id === gameId) : null;
                if (g?.lighting) gameLighting = g.lighting;
                if (g?.modelMaterialPort) gameModelMaterialPort = g.modelMaterialPort;
            }
        } catch { /* default 'gameplay' / engine-default material */ }
    }

    const dpr = effectiveDpr();
    const offscreen = canvas.transferControlToOffscreen();
    // PLAN-client-resilience.md task 3: main-thread reports (worker onerror /
    // onmessageerror / watchdog-wedged below) need their own configured
    // channel — the worker configures its own copy from gp:init (each realm
    // has its own module instance; see client-error-telemetry.ts's header).
    configureErrorTelemetry({
        endpoint: CONFIG.httpUrl,
        token: localStorage.getItem('springrts-token') ?? '',
        enabled: CONFIG.errorReportingEnabled,
        buildStamp: CONFIG.buildStamp,
    });
    gameWorker = new GameWorker();
    gameWorker.onerror = (e) => {
        console.error('[gameWorker] error:',
            e.message || '(no detail)',
            e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : '',
            e.error?.stack ?? '');
        // PLAN-client-resilience.md task 1: this is the main-thread half of
        // worker fatal detection — it fires for failures the worker-side
        // self.onerror hook (lua-widget-worker.ts) can't report itself (e.g.
        // a syntax/parse-level failure that never got far enough to install
        // its own hooks). Reported with whatever ErrorEvent gives us; less
        // context than the worker-side report (no phase/log-ring/entity
        // count — the worker may already be gone).
        reportClientError({
            reason: 'fatal',
            errorClass: e.error?.name ?? 'Error',
            message: e.message || '(no detail)',
            stack: e.error?.stack ?? `${e.message} (${e.filename}:${e.lineno}:${e.colno})`,
        });
        // PLAN-client-resilience.md task 2: an uncaught worker error is R2's
        // trigger. This propagated-error path double-covers the worker's own
        // `gp:workerFatal` message (both fire for an uncaught throw) — the
        // ladder's `recovering` latch absorbs the second, so it counts once.
        ladderTrigger('worker-error');
    };
    // PLAN-client-resilience.md task 1: fires when a posted message can't be
    // structured-cloned (e.g. an unsupported value crossing the worker
    // boundary) — distinct from onerror (a thrown exception). No stack is
    // available (the spec gives no Error object here).
    gameWorker.onmessageerror = (e: MessageEvent) => {
        console.error('[gameWorker] onmessageerror:', e);
        reportClientError({
            reason: 'messageError',
            errorClass: 'DataCloneError',
            message: 'postMessage structured-clone failure across the game-processor worker boundary',
        });
    };
    // PLAN-client-resilience.md task 1: watchdog runs for the life of the
    // worker; stopped in quitToLobby()/the defensive re-entry teardown above.
    heartbeatWatchdog.start();
    // Worker → main bridge (PLAN-game-worker.md GW4). The full sceneState /
    // audio / minimap feeds land in GW5; at c2 only the connection-lifecycle
    // signals the worker raises (auth, game-over, server-restart) are handled.
    gameWorker.onmessage = (ev: MessageEvent) => {
        const m = ev.data;
        switch (m?.type) {
            case 'gp:authenticated':
                console.log(`[gameWorker] authenticated playerId=${m.playerId} team=${m.team}`);
                // G4: the lobby-roster myTeamGuess used to construct economyBar
                // can be stale/absent (spectator, late roster fetch); this is the
                // authoritative value, so re-point the bar's team filter at it.
                economyBar?.setTeam(m.team);
                break;
            // GW4-c5c: consolidated scene-state feed → the HTML HUD + native
            // build-menu (G3a) + native economy-bar + factory-queue panel (G4).
            // The order-panel remains unbuilt (dead pre-G3b code, unrelated).
            case 'gp:sceneState':
                // PLAN-quickstart.md §3.1 (E3): the worker only feeds scene
                // state once it is rendering, so the first one marks the point
                // detach becomes available.
                firstFrameSeen = true;
                // GW8: cache for the test harness's synchronous getters
                // (window.test.selection / .cameraPose()).
                lastSceneState = { selectedUnitIds: m.selectedUnitIds, camera: m.camera };
                updateHUD(m.entityCount, m.gameFrame, m.selectedUnitIds);
                updateSpeedHUD(m.simSpeed, m.paused);
                // L-pre.3: cache the worker's presentation-clock snapshot and
                // let the F10 overlay redraw from it (it self-throttles to ~3 Hz).
                if (m.timing !== undefined) {
                    lastTimingState = m.timing;
                    timingOverlay?.tick();
                }
                // PLAN-playable.md G3a: feed the native build menu the worker-
                // resolved tiles (only present when the buildable set changed),
                // and track whether a build placement is armed for the ESC handler.
                if (m.buildOptions !== undefined) buildMenu?.setBuildOptions(m.buildOptions);
                buildPlacementArmed = m.buildGhost != null;
                // PLAN-playable.md G4: feed the native economy bar the worker's
                // latest local-team ResourceUpdate (only present when a fresh one
                // arrived since the last feed).
                if (m.economy !== undefined) economyBar?.update(m.economy);
                // PLAN-playable.md G4: feed the native factory-queue panel the
                // worker-resolved queue rows for the selected factory (only
                // present when the queue changed since the last feed).
                if (m.factoryQueue !== undefined) factoryQueuePanel?.setRows(m.factoryQueue);
                // PLAN-playable.md G3b: track whether a modal command / area-attack
                // is armed so ESC cancels it first (before build-ghost + quit).
                commandModeArmed = m.commandModeArmed === true;
                // GW4-c5c-3: keep the minimap selection rings in sync with the
                // worker's selection set (the minimap matches ids against blips).
                minimap?.setSelection(m.selectedUnitIds);
                // GW4-c5c-2: keep the audio listener glued to the camera so 3D
                // panning matches the view. Forward = (target - position).
                if (audioManager) {
                    const c = m.camera;
                    audioManager.setListenerPosition(
                        c.x, c.y, c.z, c.tx - c.x, c.ty - c.y, c.tz - c.z);
                }
                break;
            // GW4-c5c-3: worker minimap feed → main-thread minimap (own Engine).
            // `map` arrives once (dims + backdrop); `los` only when a new fog
            // snapshot shipped; blips every feed. Render is driven here (~6 Hz)
            // since main has no game render loop post-GW4.
            case 'gp:minimapFeed':
                // The `map` + `metalSpots` payloads ship exactly once (the
                // worker clears them after its first post, delivered or not),
                // so stage them in the pending buffer and drain it when the
                // minimap is up — a feed that races minimap construction
                // would otherwise lose dims + metal spots for the session.
                if (m.map) pendingMinimapMap = m.map;
                if (m.metalSpots) pendingMinimapMetalSpots = m.metalSpots;
                if (minimap) {
                    if (pendingMinimapMap) {
                        minimap.setMapDimensions(
                            pendingMinimapMap.width, pendingMinimapMap.height);
                        void minimap.loadBackground(pendingMinimapMap.baseUrl);
                        pendingMinimapMap = null;
                    }
                    if (m.los) {
                        minimap.applyLosBitmap({ allyTeam: 0, frame: 0, ...m.los });
                    }
                    // PLAN-playable.md G4: metal-spot markers, delivered once
                    // (same one-shot pattern as `map` above).
                    if (pendingMinimapMetalSpots) {
                        minimap.applyMetalSpots(pendingMinimapMetalSpots);
                        pendingMinimapMetalSpots = null;
                    }
                    minimap.applyFeed(m.blips);
                    minimap.render();
                }
                break;
            // PLAN-playable.md G4 (bonus fix): gl.ConfigMiniMap / gl.DrawMiniMapEvents
            // from a chili widget (e.g. gui_chili_minimap.lua) reach lua-ui-host's
            // minimapEmitter and post these unprefixed legacy message types, but
            // post-GW4 main.ts never had a case for them — same dead-producer class
            // as onUnitCmdDescs/sendSelectionState/onResourceUpdate (G3a/U3/G4
            // session 1). Without this the native minimap stays parked in its
            // hidden default container forever (ownership only flips to 'widget'
            // inside setGeometry) — so no ZK/BAR game ever showed a sidebar
            // minimap post-GW4. Coords are Spring screen-space (Y-up from
            // bottom-left) in the *backing-store* pixel grid — Spring.GetViewSizes
            // (what the widget lays out against) mirrors liveState.viewport =
            // canvas.width/height, i.e. CSS px × effectiveDpr(), not CSS px — so
            // this also divides by the same scale factor main.ts used to size the
            // canvas before flipping to DOM (CSS-px, top-down) space. The legacy
            // lua-widget-manager.applyMinimapGeometry this replaces skipped that
            // conversion (pre-GW4 the canvas may have been unscaled 1:1); ported
            // forward correctly rather than reproducing that gap.
            case 'minimapGeometry': {
                if (minimap) {
                    const visible = m.visible !== false && m.w > 0 && m.h > 0;
                    if (!visible) {
                        minimap.setVisible(false);
                    } else {
                        const dpr = effectiveDpr();
                        const cssX = m.x / dpr;
                        const cssY = m.y / dpr;
                        const cssW = m.w / dpr;
                        const cssH = m.h / dpr;
                        const domY = window.innerHeight - cssY - cssH;
                        minimap.setGeometry(cssX, domY, cssW, cssH);
                        minimap.setVisible(true);
                    }
                }
                break;
            }
            case 'minimapEvents':
                minimap?.markEventsRequested();
                break;
            // GW4-c5c-2: resolved sound events / music transitions from the worker.
            case 'gp:audioSoundEvents':
                soundEventPlayer?.handleResolvedBatch(m.events);
                break;
            case 'gp:audioMusic':
                // Open the music gate on the first transition (scene is live).
                if (musicDirector && !musicArmed) { musicDirector.arm(); musicArmed = true; }
                musicDirector?.handleMusicEvent(m.state, m.fadeMs);
                break;
            // The worker parsed gamedata/sounds.lua and posted its SoundItems
            // map. Ingest it so the AudioManager can resolve a SoundEvent's
            // logical name to the authored file path. WITHOUT this, every
            // server SoundEvent falls through to the SoundRef's bare server
            // path (NormalizeSoundPath = `sounds/<name>`), which omits the
            // `sounds/<subdir>/` component — so every sound that lives in a
            // subdirectory (weapons/, bombs/, …) 404s. In the GW4 worker
            // architecture this message lands here, not on the legacy
            // LuaWidgetManager; mirror its handler (lua-widget-manager.ts).
            case 'soundItems': {
                const items = m.items as Record<string, import('./core/audio.js').SoundItem>;
                const map = new Map<string, import('./core/audio.js').SoundItem>();
                for (const [k, v] of Object.entries(items ?? {})) map.set(k, v);
                audioManager?.ingestSoundItems(map, soundContentBaseUrl);
                musicDirector?.ingestPlaylistsFromSoundItems(map);
                break;
            }
            case 'gp:gameOver':
                showGameOver(gameTemplates, m.frame, {
                    winningAllyTeams: m.winningAllyTeams,
                    won: m.won,
                    onReturnToLobby: quitToLobby,
                });
                break;
            // PLAN-gm-tools: a GM broadcast (already intercepted in the worker
            // before widget dispatch) → a system toast, no widget dependency.
            case 'gp:gmBroadcast':
                showGmBroadcast(String(m.message ?? ''));
                break;
            // GW8: reply to a window.test client-bound request.
            case 'gp:testResult': {
                const p = gpPending.get(m.id);
                if (p) {
                    gpPending.delete(m.id);
                    if (m.ok) p.resolve(m.value);
                    else p.reject(new Error(String(m.error ?? 'worker test error')));
                }
                break;
            }
            // PLAN-client-resilience.md task 1: heartbeat watchdog reply.
            case 'gp:pong': {
                const resolve = gpPingPending.get(m.id);
                if (resolve) { gpPingPending.delete(m.id); resolve(); }
                break;
            }
            // PLAN-client-resilience.md task 2 (R1): the worker acked a soft
            // reset. Resolve the ladder's `sendRecoverRequest` round-trip.
            case 'gp:recovered': {
                const settle = gpRecoverPending.get(m.id);
                if (settle) settle(m.ok === true);
                break;
            }
            // PLAN-client-resilience.md task 2: a genuinely-uncaught worker
            // fatal (self.onerror / unhandledrejection) → R2. The reliable
            // cross-boundary signal for E2 (an async loader crash raises
            // `unhandledrejection`, which never reaches gameWorker.onerror).
            case 'gp:workerFatal':
                console.error(`[gameWorker] worker fatal (${m.reason}${m.injected ? ', injected' : ''}) — escalating to recovery ladder`);
                ladderTrigger('fatal');
                break;
            // PLAN-client-resilience.md task 2: WebGL context loss/restore feed
            // the ladder. A lost context arms R1's grace (notifyContextLost); a
            // restore within it is the soft R1 rung; a restore that never comes
            // times out to R2 (a dead GL context needs a fresh worker).
            case 'gp:contextLost':
                console.error('[gameWorker] WebGL context lost');
                recoveryLadder.notifyContextLost();
                break;
            case 'gp:contextRestored':
                console.log('[gameWorker] WebGL context restored');
                recoveryLadder.notifyContextRestored();
                break;
            // PLAN-quickstart.md §3.1/§3.2: detach / resync acks (visibility;
            // the DOM/audio swap already happened synchronously main-side).
            case 'gp:detached':
                console.log('[gameWorker] detached — session parked');
                break;
            case 'gp:resynced':
                console.log('[gameWorker] resynced — reconnecting for a fresh snapshot');
                break;
            // GW8: reply to a window.widgets.eval() Lua eval (worker evalLua).
            case 'evalResult':
                evalReqResolve?.(String(m.result ?? 'nil'));
                evalReqResolve = null;
                break;
            case 'gp:reload':
                console.log('[gameWorker] server restarting — reloading page');
                window.location.reload();
                break;
            // GW4-c5b-2: the worker owns selection/pick but the drag-box overlay
            // is a DOM concern — draw it here in CSS-pixel space.
            case 'gp:dragBox':
                updateDragOverlay(m.box);
                break;
            // PLAN-rml.md: a batch of RML DOM ops → the main-thread overlay.
            case 'rml:ops':
                rmlOverlay?.applyOps(m.ops);
                break;
            // PLAN-playable.md G3b: armed-command cursor mode. The worker owns the
            // modal state; the cursor overlay is DOM (main). Drive the animated
            // cursor (Spring images) + the CSS fallback on #game-canvas.
            case 'gp:cursorMode':
                applyCursorMode(m.name, m.css);
                break;
            // Spring.AssignMouseCursor / ReplaceMouseCursor (widgets, worker) →
            // register a cursor pack under a logical name (ZK/BAR swap in their
            // own animated PNGs over the engine defaults).
            case 'assignMouseCursor':
                animatedCursor?.assign(m.name, m.file, m.hotspotX, m.hotspotY, m.overwrite);
                break;
            // Spring.SetMouseCursor(name) — a widget forces a cursor directly.
            case 'setMouseCursor':
                animatedCursor?.setActive(m.name || null);
                break;
            // GW4-c5b-3 / WP3b: all worker→main storage writes arrive here.
            // Mirrors lua-widget-manager.ts:1228–1241 exactly so both paths
            // (GW4 game-processor worker and legacy LuaWidgetManager) behave
            // identically. springConfig.* writes are also mirrored into
            // clientSettings so live subscribers (shadow quality, etc.) apply
            // the change immediately.
            case 'storage:set':
                try {
                    localStorage.setItem(m.key, m.value);
                } catch { /* ignore quota / private-mode */ }
                if (m.key.startsWith('springConfig.')) {
                    clientSettings.set(m.key.slice('springConfig.'.length), m.value);
                }
                break;
            // Worker postLog() output. Until the LuaWidgetManager's log bridge
            // is folded back in (GW5/GW8), surface it on the page console (and
            // thus the log server via logIngest) so the worker isn't a black box.
            case 'log': {
                const lvl = m.level ?? 1;
                const text = `[worker] ${m.msg}`;
                if (lvl >= 4) console.error(text);
                else if (lvl >= 3) console.warn(text);
                else console.log(text);
                break;
            }
            case 'error':
                console.error(`[worker] ${m.msg}`);
                break;
            default:
                break;
        }
    };
    const init: GpInitToWorker = {
        type: 'gp:init',
        canvas: offscreen,
        gameHttpUrl,
        lobbyUrl: lobbyHttpUrl,
        username: localStorage.getItem('springrts-username') ?? '',
        token: localStorage.getItem('springrts-token') ?? '',
        gameId,
        mapId,
        lighting: gameLighting,
        modelMaterialPort: gameModelMaterialPort,
        defsCacheKey: '',
        buildStamp: CONFIG.buildStamp,
        errorReportingEnabled: CONFIG.errorReportingEnabled,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr,
        gfx,
        // Canonical key matches StandingOrderRenderer's SHOW_ALLIES_KEY; default
        // true (only an explicit 'false' hides allies). The worker persists
        // changes back here via a `gp:config` message (Bucket-3).
        standingOrderShowAllies:
            localStorage.getItem('standing-orders-show-allies') !== 'false',
        // PLAN-bar.md UI-2: hand the worker the lobby room's player roster so it
        // can populate Spring.GetPlayerList()/GetPlayerInfo before LuaUI boots
        // (the worker's own roster stream is dead). Lobby player_id matches the
        // game-server playerID. Spectators ARE players in Spring's playerHandler,
        // so they're kept; AIs are excluded (no playerId; queried via the team API).
        players: (lobbyUI?.room?.players ?? []).map((p) => ({
            id: p.playerId,
            name: p.username,
            team: p.team,
            spectator: p.isSpectator,
        })),
    };
    gameWorker.postMessage(init, [offscreen]);

    // GW4-c5b: the interactive camera + scene.pick live in the worker, but the
    // canvas still receives DOM pointer/wheel events on the main thread (only its
    // render context was transferred). CameraInput captures them and forwards
    // canvas-relative input to the worker camera (view 0).
    cameraInput = new CameraInput(canvas, gameWorker, 0);

    // PLAN-playable.md G3b: the animated cursor overlay is DOM (main), but the
    // modal-command state that decides which cursor is active lives in the worker
    // (WorkerCommandModes). The worker posts `gp:cursorMode` (armed-command
    // cursor name) + `assignMouseCursor`/`setMouseCursor` (widget cursor packs);
    // this overlay renders them. Degrades gracefully to the CSS fallback if a
    // Spring cursor manifest 404s.
    animatedCursor = new AnimatedCursor(document.body, lobbyHttpUrl, gameId);

    // PLAN-rml.md: main-thread DOM overlay for RmlUi-based widgets (BAR). The
    // worker-side RmlUi proxy records DOM ops and posts them as `rml:ops`; this
    // manager owns the real `#rml-root` nodes over the canvas. R0 mounts the
    // root and accepts (ignores) the op stream; rendering lands in R1.
    rmlOverlay = new RmlOverlayManager({
        canvasId: 'game-canvas',
        assetBaseUrl: gameId ? `${lobbyHttpUrl}/api/games/data/${gameId}` : '',
    });

    // GW4-c5c-3: live gfx.* settings → worker. The worker's clientSettings was
    // seeded with the snapshot in `gp:init`; this forwards every later change so
    // a quality toggle in the settings panel re-tunes the worker's render
    // pipeline / FX gating without a restart (the worker routes it through its
    // own clientSettings.set → subscribers). Only gfx.* keys cross — audio etc.
    // are owned on main.
    gfxConfigUnsub = clientSettings.subscribeAll((value, key) => {
        if (!key.startsWith('gfx.')) return;
        gameWorker?.postMessage({ type: 'gp:config', key, value });
        // gfx.renderScale changes the canvas backing-store size, which is driven
        // by the gp:resize dpr (not gp:config). Re-run the resize path so the new
        // effective DPR is applied live (debounced + deduped inside onGameResize).
        if (key === 'gfx.renderScale') onGameResize?.();
    });

    // GW4-c5c-3: minimap on the main thread (own Babylon Engine + DOM canvas
    // parented to #minimap-container). The entity renderer + connection live in
    // the worker now, so the minimap takes neither — it renders from the
    // worker's `gp:minimapFeed` (blips + fog + map dims) via applyFeed. Initial
    // dims are placeholders; the first feed carries the real map size + backdrop.
    const minimapContainer = document.getElementById('minimap-container');
    if (minimapContainer) {
        minimap = new Minimap(
            { mapWidth: 8192, mapHeight: 8192, parentElement: minimapContainer, size: 200 },
            null);
        // Left-click → re-centre the worker's world camera (the camera is in the
        // worker; the focus intent crosses the boundary as `gp:focusWorld`).
        minimap.onCameraMove = (x, z) => {
            gameWorker?.postMessage({ type: 'gp:focusWorld', x, z });
        };
        document.getElementById('detach-minimap-btn')
            ?.addEventListener('click', () => minimap?.detach());
    }

    // PLAN-playable.md G3a: native build-menu HUD (DOM, on main). The worker owns
    // selection + defs + placement now, so this panel is a pure renderer: it's
    // fed the resolved buildable tiles via `gp:sceneState.buildOptions`, and a
    // tile click posts `gp:startBuildPlacement` to the worker's
    // WorkerBuildPlacement (ghost + snap + order emission). `myTeam` is
    // informational only (the worker does the own-team filter); best-effort from
    // the lobby room roster since auth's real team hasn't arrived yet.
    const myUsername = localStorage.getItem('springrts-username') ?? '';
    const myTeamGuess = lobbyUI?.room?.players?.find((p) => p.username === myUsername)?.team ?? -1;
    buildMenu = new BuildMenu(myTeamGuess, { lobbyHttpUrl, gameId }, {
        onPick: (defId, mods) => {
            gameWorker?.postMessage({
                type: 'gp:startBuildPlacement', defId, shift: mods.shift, ctrl: mods.ctrl });
        },
    });

    // PLAN-playable.md G4: native economy-bar HUD (DOM, on main). GW4-regression
    // fix — the component was fully built (economy-bar.ts) but never instantiated
    // post-GW4, so metal/energy income was invisible in every game (flagged as
    // dead code in the G3a field notes). `myTeamGuess` is the same best-effort
    // lobby-roster lookup buildMenu uses; corrected to the authoritative value
    // once `gp:authenticated` reports the real team below.
    economyBar = new EconomyBar({ myTeam: myTeamGuess });

    // PLAN-playable.md G4: native factory-queue panel (DOM, on main). Pure
    // renderer fed via `gp:sceneState.factoryQueue`; row clicks post
    // `gp:removeFactoryOrder` to the worker's CMD.REMOVE path (same intent-
    // crosses-the-boundary shape as BuildMenu's `gp:startBuildPlacement`).
    factoryQueuePanel = new FactoryQueuePanel({ lobbyHttpUrl, gameId }, {
        onRemoveOne: (unitId, tag) => {
            gameWorker?.postMessage({ type: 'gp:removeFactoryOrder', unitId, tags: [tag] });
        },
        onRemoveAll: (unitId, tags) => {
            gameWorker?.postMessage({ type: 'gp:removeFactoryOrder', unitId, tags });
        },
    });

    // GW4-c5c-2: audio playback chain on the main thread (AudioContext is
    // main-only). The worker resolves SoundEvent → SoundRef against its def
    // cache and posts the resolved pairs (`gp:audioSoundEvents`); music
    // transitions arrive as `gp:audioMusic`. The content base points at the
    // game's preprocessed `data/games/<id>/` root (where the .webm SFX live).
    const soundContentBaseUrl = gameId
        ? `${lobbyHttpUrl}/api/games/data/${gameId}/`
        : `${lobbyHttpUrl}/`;
    audioManager = new AudioManager();
    soundEventPlayer = new SoundEventPlayer(audioManager, soundContentBaseUrl);
    musicDirector = new MusicDirector(audioManager, soundContentBaseUrl);
    musicArmed = false;
    // AudioContext can't start until a user gesture — resume on first click.
    canvas.addEventListener('click', () => audioManager?.resume(), { once: true });

    // The worker owns the Engine + canvas now, so resize is forwarded to it.
    // Named callback so it can be removed on teardown (CODE-REVIEW C8).
    onGameResize = () => {
        if (resizeDebounceTimer !== null) clearTimeout(resizeDebounceTimer);
        resizeDebounceTimer = setTimeout(() => {
            resizeDebounceTimer = null;
            const w = window.innerWidth;
            const h = window.innerHeight;
            const dpr = effectiveDpr();
            // Skip no-op resizes: a same-size event still triggers the worker's
            // canvas write + engine.resize() bookkeeping for nothing.
            if (w === lastSentResize.w && h === lastSentResize.h && dpr === lastSentResize.dpr) return;
            lastSentResize = { w, h, dpr };
            gameWorker?.postMessage({ type: 'gp:resize', width: w, height: h, dpr });
        }, 150);
    };
    window.addEventListener('resize', onGameResize);
    // Seed the last-sent size so the first real resize is detected as a change.
    lastSentResize = { w: window.innerWidth, h: window.innerHeight, dpr: effectiveDpr() };

    // GW8: re-plumb the dev/test tooling for the worker split.
    //   window.test     — server-bound verbs run on main over HTTP; camera /
    //                      selection / netSim / pause / screenshot forward to
    //                      the worker via workerCall(); selection + cameraPose
    //                      read the cached gp:sceneState feed synchronously.
    //   window.widgets  — Lua eval bridge to the in-worker LuaUI runtime
    //                      (the spring-debug `evaluate_widget_lua` path).
    testHarness = new TestHarness({
        gameHttpUrl,
        token: localStorage.getItem('springrts-token') ?? '',
        workerCall,
        getSelection: () => lastSceneState?.selectedUnitIds ?? [],
        getCameraPose: () => {
            const c = lastSceneState?.camera;
            if (!c) return null;
            return { pos: { x: c.x, y: c.y, z: c.z }, lookAt: { x: c.tx, y: c.ty, z: c.tz } };
        },
    });
    (window as any).test = testHarness;

    // PLAN-quickstart.md Part B: the drivable detach/re-enter surface (this
    // whole plan is side-lane-M test tooling). The polished lobby "return to
    // game" card + Metalstorm PlayerRemoved(reason) wiring is Part B task 6;
    // these globals make the mechanism functional + scenario-testable now.
    (window as any).springrts = {
        /** Park the running game, keeping the worker warm (§3.1). No-op before
         *  the first frame (E3) or when already parked. */
        detach: () => detachToLobby(),
        /** Re-enter the parked game via a fast resync, or full-boot if the
         *  parked session no longer matches (§3.2 / E5 / TTL). */
        reenter: () => {
            if (detachSession.isParked && lastGameArgs) {
                enterGame(lastGameArgs.port, lastGameArgs.mapId, lastGameArgs.gameId);
            }
        },
        /** True while a session is parked (detached, worker alive). */
        get parked() { return detachSession.isParked; },
    };

    // GW8: reach the worker-resident JS debug hooks (globalThis.__entityRenderer
    // / __fxLightPool / __renderPipeline / __csm / …) from the main devtools
    // console — e.g. `await window.__gp('__entityRenderer.getUnitCount()')`.
    // The render-core move stranded these in the worker; this is the JS analogue
    // of window.widgets.eval (Lua). Dev-only; results are made clone-safe.
    (window as any).__gp = (expr: string): Promise<unknown> => workerCall('evalJs', [expr]);

    (window as any).widgets = {
        /** Evaluate a Lua snippet in the in-worker LuaUI runtime; resolves with
         *  the result's string form (or 'timeout'). Serialised — one in flight. */
        eval(code: string): Promise<string> {
            return new Promise((resolve) => {
                if (!gameWorker) { resolve('no worker'); return; }
                if (evalReqResolve) { resolve('busy'); return; }
                let done = false;
                evalReqResolve = (v) => { done = true; resolve(v); };
                gameWorker.postMessage({ type: 'evalLua', code });
                window.setTimeout(() => {
                    if (!done) { evalReqResolve = null; resolve('timeout'); }
                }, 5000);
            });
        },
    };
}

// --- Boot ---

/// Direct-start boot (`?direct=<manifest-name-or-url>`, PLAN-quickstart.md
/// Part A): fetch the manifest (a bare relative path or an absolute URL —
/// both work transparently via `fetch`), POST it to `/api/rooms/direct`,
/// then feed the response into the lobby exactly like the scenario runner
/// does with its own `/api/rooms` response (`attachSession` +
/// `setCurrentRoomFromJson`). No separate `startGame()` call is needed: the
/// direct-start response is already the room in Loading/Active with a
/// `game_server_port`, so `updateCurrentRoomFromJson` (lobby-ui.ts) fires
/// `onGameStart` on its own — the same state-driven path the normal lobby
/// walk already relies on.
async function bootDirect(manifestUrl: string, lobby: LobbyUI): Promise<void> {
    const manifestResp = await fetch(manifestUrl);
    if (!manifestResp.ok)
        throw new Error(`?direct: failed to fetch manifest '${manifestUrl}': HTTP ${manifestResp.status}`);
    const manifest = await manifestResp.json();

    const roomResp = await fetch(`${CONFIG.httpUrl}/api/rooms/direct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(manifest),
    });
    const room = await roomResp.json();
    if (!roomResp.ok)
        throw new Error(`?direct: /api/rooms/direct failed: ${room?.error ?? roomResp.status}`);

    // The host is the manifest's first declared player — same convention
    // the scenario runner uses (a single host player, test1).
    const hostUsername = manifest.players?.[0]?.username;
    const token = room.sessions?.[hostUsername];
    const hostPlayer = (room.players ?? []).find((p: any) => p.username === hostUsername);
    if (!token || !hostPlayer)
        throw new Error('?direct: response missing host session/player');

    lobby.attachSession(token, hostPlayer.player_id, hostUsername);
    lobby.setCurrentRoomFromJson(room);
}

/// Resolve which game (if any) the lobby UI should style itself for at
/// boot time. Order of precedence:
///   1. `?game=<id>` URL query parameter (browser link, dev override)
///   2. `springrts-game-id` localStorage key (sticky across reloads)
///   3. none (engine default UI)
///
/// CLI startup of the client (e.g. `npm run dev -- --game papertanks`)
/// is forwarded into the URL by the host launcher, so the same path
/// covers both browser and packaged-app entry points.
function resolveInitialGameId(): string | null {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('game');
    if (fromUrl) {
        // Persist URL choices so a refresh keeps the same skin without
        // having to re-pass the query string.
        localStorage.setItem('springrts-game-id', fromUrl);
        return fromUrl;
    }
    return localStorage.getItem('springrts-game-id');
}

document.addEventListener('DOMContentLoaded', async () => {
    await fetchBuildStamp();
    createHUD(gameTemplates, { onQuit: () => showQuitConfirm(gameTemplates, { onConfirm: quitToLobby }) });
    debugConsole.init();
    // L-pre.3: the F10 presentation-clock overlay. Built here (DOM exists, and
    // its ctor appends its panel + installs the F10 key listener) rather than
    // per-game, so F10 works before/after a game too — it just reports "waiting
    // for first frame-stamped snapshot…" until the worker's clock anchors.
    timingOverlay = new TimingOverlay(() => lastTimingState);
    // Debug hook for the L0 exit gate: read the live worker clock from the
    // devtools console (`__gpTiming()`). Replaces the removed window.__presClock,
    // which pointed at a ghost clock that was never fed (L-pre.2).
    (window as unknown as { __gpTiming: () => GpTimingState | null }).__gpTiming =
        () => lastTimingState;
    // Capture window.onerror, unhandledrejection, console.error/warn and
    // batch-POST them to the log server so every browser-side error is
    // discoverable via spring-debug + the in-game console SSE stream.
    logIngest.install();

    // Hide canvas until game starts
    const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
    canvas.style.display = 'none';

    // Global ESC handler: toggle the quit-to-lobby confirmation. Only
    // active while a game is running (gameWorker non-null), so ESC stays free
    // for lobby UI dialogs.
    //
    // PLAN-playable.md G3a/G3b: build placement + modal commands now live in the
    // worker (WorkerBuildPlacement / WorkerCommandModes). When one is armed
    // (tracked via gp:sceneState.buildGhost / .commandModeArmed), ESC cancels it
    // and swallows the event instead of opening the quit dialog — mirroring the
    // pre-GW4 InputManager ESC behaviour (that main-thread class is now removed).
    window.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!gameWorker) return;
        // PLAN-playable.md G3b: ESC cancels an armed modal command / area-attack
        // drag first (worker owns the state), then a build placement, then opens
        // the quit dialog.
        if (commandModeArmed) {
            gameWorker.postMessage({ type: 'gp:cancelCommandMode' });
            commandModeArmed = false;
            e.preventDefault();
            return;
        }
        if (buildPlacementArmed) {
            gameWorker.postMessage({ type: 'gp:cancelBuildPlacement' });
            buildPlacementArmed = false;
            e.preventDefault();
            return;
        }
        e.preventDefault();
        showQuitConfirm(gameTemplates, { onConfirm: quitToLobby });
    });

    // Scenario mode (`?scenario=<name>`) hijacks the boot flow: clear
    // any stale saved session so the lobby's auto-login doesn't race
    // with the runner's fresh login, then let the runner orchestrate
    // login → room → start.
    const scenario = ScenarioRunner.fromUrl();
    if (scenario) {
        localStorage.removeItem('springrts-token');
        localStorage.removeItem('springrts-username');
        localStorage.removeItem('springrts-game-room');
        localStorage.removeItem('springrts-game-port');
    }

    // Direct-start mode (`?direct=<manifest-name-or-url>`, PLAN-quickstart.md
    // Part A) hijacks the boot flow the same way scenario mode does: clear
    // any stale saved session first so the lobby's auto-login doesn't race
    // bootDirect's own attachSession.
    const directManifestUrl = new URLSearchParams(window.location.search).get('direct');
    if (directManifestUrl) {
        localStorage.removeItem('springrts-token');
        localStorage.removeItem('springrts-username');
        localStorage.removeItem('springrts-game-room');
        localStorage.removeItem('springrts-game-port');
    }

    // Show lobby with the engine-default templates immediately so the
    // login screen renders without waiting on a network round-trip.
    //
    // Scenario (`?scenario=`) and direct-boot (`?direct=`) modes own the
    // screen and drive the game themselves — construct the lobby
    // *suppressed* so it never puts login/room UI on screen (the async
    // game-template load would otherwise re-render and un-hide the login
    // form the runner had already hidden).
    const lobbySuppressed = !!scenario || !!directManifestUrl;
    lobbyUI = new LobbyUI((gameServerPort: number, mapId: string, gameId: string) => {
        // PLAN-quickstart.md Part B: route through enterGame so a room the
        // player detached from resyncs instead of full-booting (§3.2).
        enterGame(gameServerPort, mapId, gameId);
    }, getDefaultLobbyTemplates(), lobbySuppressed);
    (window as any).lobby = lobbyUI;

    if (directManifestUrl) {
        // Hide synchronously, before any `await` — the constructor above
        // already flipped the container to display:flex (login screen or
        // auto-login spinner) and the browser won't paint until this
        // handler yields, so this never flashes visible DOM.
        lobbyUI.hide();
        bootDirect(directManifestUrl, lobbyUI).catch((err) => {
            console.error('[direct] boot failed:', err);
        });
    }

    if (scenario) {
        // Fire and forget — the runner publishes progress and results
        // on `window.scenarioResults` for external pickup.
        const runner = new ScenarioRunner(scenario, lobbyUI, () => testHarness);
        runner.start();
    }

    // If a game id is known up front, fire-and-forget the override
    // bundle fetch and hot-swap the templates as soon as it lands.
    // Each per-file override falls back to the bundled default, so a
    // missing or partial override gracefully degrades.
    const initialGameId = resolveInitialGameId();
    if (initialGameId) {
        // Empty base = relative URL; see scope-local `lobbyHttpUrl`
        // comment above for rationale (commit 78027e4004 moved static
        // assets off the lobby; relative paths route through Vite +
        // proxy in dev and nginx in prod).
        loadGameLobbyTemplates(initialGameId, '')
            .then((templates) => lobbyUI?.setTemplates(templates))
            .catch((err) => console.warn('[lobby] game UI override failed:', err));

        loadGameTemplates(initialGameId, '')
            .then((templates) => {
                gameTemplates = templates;
                // Re-create HUD with the game's overridden templates. The
                // HUD was already built above with engine defaults — swap
                // it now that the override has landed. Re-attaches the
                // quit button listener.
                createHUD(gameTemplates, { onQuit: () => showQuitConfirm(gameTemplates, { onConfirm: quitToLobby }) });
            })
            .catch((err) => console.warn('[game] game UI override failed:', err));
    }
});
