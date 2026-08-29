/**
 * TestHarness — runtime API on `window.test` for automated and manual
 * testing of the in-game client. Pairs with the server-side `server`
 * exec scope verbs (spawn / kill / damage / order / log) and the
 * spring-debug MCP `test_*` tool family.
 *
 * Two halves (GW8 split — the render core + camera + connection now live
 * in the game-processor worker, PLAN-game-worker.md):
 *   - **server-bound** (`spawn`, `order`, `kill`, `damage`, `clear`, `log`,
 *     `state`, `units`, `unitState`, sim pause/speed, `lua`): pure HTTP to
 *     the game server's `/api/exec` using the lobby auth token — runs
 *     entirely on the **main thread**, no worker round-trip.
 *   - **client-bound** (`focus`, camera*, `select`, `selection`, `netSim`,
 *     `pause`/`resume`, `screenshot`): forwarded to the worker via
 *     `workerCall()` (a `gp:test` request/`gp:testResult` reply), since the
 *     camera/selection/renderer/connection all live there now. Read-only
 *     getters (`selection`, `cameraPose`) are served synchronously from the
 *     cached `gp:sceneState` feed to avoid a round-trip.
 *
 * `window.test` is replaced by a fresh instance on every `startGame()` call
 * and torn down by `quitToLobby()`.
 */

import type { MinimapFrameStats } from './minimap.js';
import type { Sphere } from './orbit-rig.js';
import {
    diagnose,
    luminanceVerdict,
    mergeSubjectSpheres,
    metresAcross,
    resolveFraming,
    retryFraming,
    sphereFromArea,
    sphereFromPosition,
    type AttemptRecord,
    type CaptureSubjectResult,
    type CaptureSubjectSpec,
} from './capture-subject.js';
import {
    clampFrames,
    clampSimSpeed,
    payloadChars,
    sequenceMaxDim,
    shotIntervalMs,
    summariseSequence,
    wireBudgetExceeded,
    REALTIME_BURST_BUDGET_MS,
    SEQUENCE_QUALITY,
    type CaptureSequenceSpec,
    type SequenceShot,
    type SequenceSummary,
} from './capture-sequence.js';

export type { CaptureSubjectResult, CaptureSubjectSpec } from './capture-subject.js';
export type { CaptureSequenceSpec } from './capture-sequence.js';

/** A minimal subset of the lobby UI needed for `/api/exec` requests. */
export interface TestLobbyHandle {
    lobbyPost(path: string, body?: Record<string, unknown>): Promise<unknown>;
    token: string;
}

interface Vec3 { x: number; y: number; z: number; }
interface CamPose { pos: Vec3; lookAt: Vec3; }

export interface TestHarnessDeps {
    /** Game server base URL (`http://host:gamePort`) for `/api/exec`. */
    gameHttpUrl: string;
    /** Lobby auth token (validated by the game server's shared user table). */
    token: string;
    /** Issue a client-bound request to the game-processor worker; resolves
     *  with the worker's reply value (or rejects with its error). */
    workerCall: (method: string, args?: unknown[]) => Promise<unknown>;
    /** Latest selection from the cached `gp:sceneState` feed (sync). */
    getSelection: () => readonly number[];
    /** Latest camera pose from the cached `gp:sceneState` feed (sync). */
    getCameraPose: () => CamPose | null;
    /** Latest gameFrame from the cached `gp:sceneState` feed, with the age of
     *  that reading (ms). null before the first feed message. */
    getSceneFrame: () => { gameFrame: number; ageMs: number } | null;
    /** Latest presentation-clock snapshot (`gp:sceneState.timing`), or null. */
    getTiming: () => { anchored: boolean; newestFrame: number } | null;
    /** The live main-thread `Minimap`, or null when no game session owns one.
     *  The minimap is the one rendered surface outside the worker, so it needs
     *  its own capture route — see `minimapScreenshot`. */
    getMinimap: () => MinimapCaptureSource | null;
}

/** The slice of `Minimap` the harness captures through. */
export interface MinimapCaptureSource {
    captureFrame(): string;
    captureFrameStats(): MinimapFrameStats;
}

/** Options for `captureFrame`. `region` is in DEVICE pixels (the worker
 *  canvas backing store), not CSS pixels — on a dpr>1 display a CSS-pixel
 *  region crops the wrong area (P5 R7). */
export interface CaptureFrameOpts {
    format?: 'png' | 'jpeg';
    quality?: number;          // jpeg only, 0..1
    maxDim?: number;           // default 1280 (longest edge of the output)
    region?: { x: number; y: number; width: number; height: number };
    stats?: boolean;           // worker-side luminance of the downsampled pixels
    /** `false` = do not render; read the preserved drawing buffer as it
     *  stands. Repeat calls are then byte-identical (same `frameId`), which is
     *  the only way to compare two captures of ONE frame. Only meaningful
     *  under `pause()` — a running render loop overwrites the buffer. Default
     *  (`true`) renders, so a paused capture reflects the CURRENT camera and
     *  state and therefore advances `frameId`. */
    render?: boolean;
}

export interface CaptureFrameResult {
    dataUrl: string;           // image/png or image/jpeg
    width: number;             // downsampled output size
    height: number;
    /** Babylon `scene.getFrameId()` — the count of RENDERS behind these
     *  pixels. Two captures with the same `frameId` are the same frame (that
     *  is what `render: false` gives you). Not `engine.frameId`, which counts
     *  render-loop ticks and keeps advancing while paused. */
    frameId: number;
    gameFrame: number;         // worker sim frame at capture time
    /** Luminance of the downsampled pixels (0..255), only with `stats: true`. */
    stats?: { min: number; max: number; mean: number };
}

/** One-call readiness snapshot — see `readyState()`. */
export interface ReadyState {
    harness: true;
    worker: { alive: boolean; sceneStateAgeMs: number | null };
    connection: { authenticated: boolean; authFailed: string | null; receivedState: boolean };
    frame: { gameFrame: number | null; anchored: boolean; newestBaseFrame: number };
    render: { frameId: number; meshCount: number; terrainMeshCount: number };
}

/** A parsed row of the LuaUI widget list (see `widgets()`). */
export interface WidgetRow {
    status: string;            // 'active' | 'disabled' | 'failed'
    name: string;
    author: string;
    basename: string;
    error: string;
    desc: string;
    layer: string;
    enabled: string;
}

export interface CameraDriftReport {
    posDriftElmos: number;
    lookAtDriftElmos: number;
    before: CamPose;
    after: CamPose;
    withinTolerance: boolean;
}

export interface ExecResult {
    success: boolean;
    output: string;
}

/** Reasonable defaults for camera focus animations. */
const DEFAULT_FOCUS_MS = 600;
const DEFAULT_FOCUS_HEIGHT = 800;

/** Server-scope shorthand verbs. Symbolic to keep call sites grep-friendly. */
type ServerVerb =
    | 'spawn' | 'kill' | 'damage' | 'order' | 'clear' | 'stockpile'
    | 'log' | 'state' | 'units' | 'frame' | 'pause' | 'unpause'
    | 'unit_state' | 'combat_summary' | 'defs'
    | 'cheats' | 'revive_team';

export class TestHarness {
    private deps: TestHarnessDeps;
    /** Local mirror of the worker render-loop freeze (so the `paused` getter
     *  stays synchronous; the harness is the only thing that flips it). */
    private renderPaused = false;

    constructor(deps: TestHarnessDeps) {
        this.deps = deps;
    }

    /// 8a-follow-on: the harness outlives the token it was built with. It is
    /// constructed once per page and `/api/exec` is the vehicle for every
    /// scripted verification run, several of which are longer than the 1 h
    /// access TTL — a snapshot taken at construction would 401 partway through
    /// a soak. main.ts subscribes this to the renewer.
    setToken(token: string): void { this.deps.token = token; }

    // ─── Server scope: structured exec helpers ───────────────────────
    //
    // Exec routing — the lobby's `/api/exec` only handles `sql` and
    // `lobby` scopes; `server`, `LuaRules`, `LuaGaia`, and `LuaAI:*`
    // live on the game server's HTTP listener. We POST to the game
    // server URL directly with the lobby's auth token (the game server
    // validates it against the shared SQLite user table).

    private async execOnGameServer(scope: string, code: string): Promise<ExecResult> {
        const base = this.deps.gameHttpUrl;
        if (!base) throw new Error('[test] gameHttpUrl not set — game server not connected?');
        const resp = await fetch(`${base}/api/exec`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.deps.token}`,
            },
            body: JSON.stringify({ scope, code }),
        });
        if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`[test] exec ${scope} HTTP ${resp.status}: ${text}`);
        }
        return resp.json() as Promise<ExecResult>;
    }

    /** Execute a verb in the `server` exec scope. Returns the raw text
     *  the server emitted. Throws when the request fails. */
    async server(verb: ServerVerb, ...args: (string | number)[]): Promise<string> {
        const code = [verb, ...args.map(String)].join(' ').trim();
        const r = await this.execOnGameServer('server', code);
        if (!r.success) throw new Error(`[test] server "${code}" → ${r.output}`);
        return r.output;
    }

    /** Execute a verb in the `server` exec scope asking for its STRUCTURED
     *  form (the `json ` prefix), and return the parsed object.
     *
     *  Converted verbs: frame, state, units [team], unit_state <id>,
     *  combat_summary, `log status`, `los status`, `cheats status`, spawn.
     *  Anything else runs normally and answers text — that, and a game server
     *  too old to know the prefix (it replies `unknown command: json …`), both
     *  throw here rather than handing back something that only looks parsed.
     *  A converted verb's own error arrives as `{error: "…"}` with the request
     *  reported successful, so check the key. */
    async serverJson<T = Record<string, unknown>>(
        verb: ServerVerb, ...args: (string | number)[]
    ): Promise<T> {
        const code = [verb, ...args.map(String)].join(' ').trim();
        const r = await this.execOnGameServer('server', `json ${code}`);
        if (!r.success) {
            if (r.output.startsWith('unknown command: json'))
                throw new Error(`[test] server "json ${code}" → game server predates the json prefix`);
            throw new Error(`[test] server "json ${code}" → ${r.output}`);
        }
        try {
            return JSON.parse(r.output) as T;
        } catch {
            throw new Error(`[test] server "json ${code}" → not JSON (unconverted verb?): ${r.output}`);
        }
    }

    /** Execute a Lua snippet in the LuaRules synced state. Returns the
     *  text representation of the last expression. Throws on error. */
    async lua(code: string): Promise<string> {
        const r = await this.execOnGameServer('LuaRules', code);
        if (!r.success) throw new Error(`[test] lua "${code}" → ${r.output}`);
        return r.output;
    }

    // ─── Spawn / kill / damage / order ───────────────────────────────

    /** Spawn one or more units of `defName` near (x, z) on `team`.
     *  When `count` > 1 the server lays them out in a square grid. */
    spawn(defName: string, x: number, z: number, team = 0, count = 1): Promise<string> {
        return this.server('spawn', defName, x, z, team, count);
    }

    kill(unitId: number, selfDestruct = false, reclaimed = false): Promise<string> {
        return this.server('kill', unitId, selfDestruct ? 1 : 0, reclaimed ? 1 : 0);
    }

    damage(unitId: number, amount: number, paralyze = false): Promise<string> {
        return this.server('damage', unitId, amount, paralyze ? 1 : 0);
    }

    /** Issue a raw cmdId order to a single unit. Use the `CMD.*` table
     *  from `command-buffer.ts` for the cmdId. `params` is up to 4 floats.
     *
     *  The server's `order` verb only treats the last argument as opts
     *  when there are exactly 5 floats after the cmdId — otherwise
     *  everything is interpreted as params. Calling `order(id, ATTACK,
     *  [targetId], 0)` would emit `[targetId, 0]` and CMD_ATTACK
     *  rejects 2-element params. So we only append opts when non-zero
     *  AND we pad params with zeros up to 4 to hit the "exactly 5"
     *  threshold.
     */
    order(unitId: number, cmdId: number, params: number[] = [], opts = 0): Promise<string> {
        if (opts !== 0) {
            const padded = params.slice(0, 4);
            while (padded.length < 4) padded.push(0);
            return this.server('order', unitId, cmdId, ...padded, opts);
        }
        return this.server('order', unitId, cmdId, ...params);
    }

    /** Wipe all units (or all units on a single team). */
    clear(team?: number): Promise<string> {
        return team !== undefined ? this.server('clear', team) : this.server('clear');
    }

    /** Insta-fill a unit's stockpile weapon (nukes, anti-nukes, tactical
     *  missiles) so attack/manual-fire works without the multi-minute
     *  build cycle. There is no server `stockpile` verb — set
     *  `numStockpiled` directly through synced Lua's `Spring.SetUnitStockpile`
     *  (3rd arg marks the in-progress missile 100% built). It no-ops only
     *  while the unit's `stockpileWeapon` is still unwired; scenarios call
     *  this well after spawn, by which point it's live. `queued` is
     *  accepted for back-compat but unused. */
    stockpile(unitId: number, count: number, queued = 0): Promise<string> {
        void queued;
        return this.lua(
            `if Spring.SetUnitStockpile then Spring.SetUnitStockpile(${unitId}, ${count}, 1) end`);
    }

    /** Toggle Spring cheats. Required for many test verbs (spawn,
     *  damage, set_los…) and also makes ZK's game_over.lua skip its
     *  periodic "destroy alliance with no units" sweep — i.e. keeps
     *  scenario teams alive even though no commander spawned. */
    cheats(on = true): Promise<string> {
        return this.server('cheats', on ? 'on' : 'off');
    }

    /** Reset `team.isDead` for the given team (or `'all'`). ZK marks
     *  teams dead at frame 45 when they have no units; this revives
     *  them so `Spring.CreateUnit` will accept them as a target. */
    reviveTeam(teamId: number | 'all' = 'all'): Promise<string> {
        return this.server('revive_team', String(teamId));
    }

    // ─── Debug logging toggles ──────────────────────────────────────

    /** Toggle a single subsystem's verbose log output. */
    log(subsystem: 'combat' | 'sound' | 'weapon' | 'explosion' | 'order' | 'unit' | 'script',
        on: boolean): Promise<string> {
        return this.server('log', subsystem, on ? 'on' : 'off');
    }

    /** Set multiple subsystem flags in one call. Returns the post-state. */
    async setLogging(flags: Partial<{
        combat: boolean; sound: boolean; weapon: boolean; explosion: boolean;
        order: boolean; unit: boolean; script: boolean;
    }>): Promise<string> {
        for (const [k, v] of Object.entries(flags)) {
            await this.server('log', k, v ? 'on' : 'off');
        }
        return this.server('log', 'status');
    }

    /** Snapshot of every debug-flag subsystem. */
    logStatus(): Promise<string> {
        return this.server('log', 'status');
    }

    // ─── Read-only sim queries ──────────────────────────────────────

    state(): Promise<string> { return this.server('state'); }
    frame(): Promise<string> { return this.server('frame'); }
    units(team?: number): Promise<string> {
        return team !== undefined ? this.server('units', team) : this.server('units');
    }
    unitState(unitId: number): Promise<string> {
        return this.server('unit_state', unitId);
    }
    combatSummary(): Promise<string> { return this.server('combat_summary'); }

    // ─── Sim pause / speed (server-side) ────────────────────────────

    simPause(): Promise<string> { return this.server('pause'); }
    simResume(): Promise<string> { return this.server('unpause'); }
    /** Set sim speed multiplier. Range: (0, 100]. */
    async simSpeed(mult: number): Promise<string> {
        const r = await this.execOnGameServer('server', `speed ${mult}`);
        if (!r.success) throw new Error(r.output);
        return r.output;
    }

    // ─── Network simulation (PLAN-latency L0 validation tool) ────────
    //
    // Reproduces WAN conditions on localhost so the latency mitigations can
    // be A/B'd against "does it still look right at 200 ms ± jitter, 2 %
    // loss?". Applies to the unreliable state channel only (entity state etc.).
    // Forwarded to the worker (the Connection lives there now). Watch the
    // timing overlay (F10 → presentation-clock block) for P tracking E−D.

    /** Inject artificial latency/jitter/loss on the state channel.
     *  `{ delayMs, jitterMs, lossProb }`. Call `netSimOff()` to disable. */
    netSim(cfg: { delayMs?: number; jitterMs?: number; lossProb?: number }): void {
        void this.deps.workerCall('setNetSim', [cfg]);
    }

    /** Disable artificial latency. */
    netSimOff(): void {
        void this.deps.workerCall('setNetSim', [{ delayMs: 0, jitterMs: 0, lossProb: 0 }]);
    }

    /** Per-envelope inbound/outbound bandwidth tally from the worker's
     *  net-inspector (the connection lives there — GW8). Cumulative since the
     *  game started; the data source for PLAN-performance PC-2's budget table. */
    async netStats(): Promise<unknown> {
        return this.deps.workerCall('netStats');
    }

    /** Per-phase frame-time distribution (mean/p50/p95/p99/max) over the last
     *  `windowMs` (default 30 s) from the worker's permanent FrameProfiler —
     *  the PLAN-perf P0 attribution matrix. Returns `{ frames, fps, phases,
     *  table }`; log `.table` for a readable breakdown. */
    async perfDump(windowMs?: number): Promise<unknown> {
        return this.deps.workerCall('perfDump', windowMs == null ? [] : [windowMs]);
    }

    /** Clear the FrameProfiler's buffered samples before a fresh measurement. */
    perfReset(): void {
        void this.deps.workerCall('perfReset');
    }

    /** Reset the profiler, wait a REAL measurement window, then dump — the
     *  perfDump-doesn't-wait trap closed (callers that reset and immediately
     *  dump measure an empty window). Returns `{ perf, squad }`; `squad` is
     *  null unless `opts.squad` and the loaded squad module exposes counters. */
    async perfCapture(windowMs = 5000, opts: { squad?: boolean } = {}):
        Promise<{ perf: unknown; squad: unknown }> {
        this.perfReset();
        if (opts.squad) this.squadPerfReset();
        await wait(windowMs);
        const perf = await this.perfDump(windowMs);
        const squad = opts.squad ? await this.squadPerf().catch(() => null) : null;
        return { perf, squad };
    }

    /** Squad-system perf counters (PLAN-metalstorm-squad-performance.md §14
     *  S0): per-tier squad/member counts, neighbour checks, matrix writes, and
     *  EMA-smoothed grid-rebuild/step/flush timings from the live SquadManager.
     *  The scenario-ladder recipe dumps this alongside perfDump() per rung.
     *
     *  Returns **null** when the runtime-served squad module exposes no
     *  counters. Before P5 the worker had no `squadPerf` dispatch case at all,
     *  so this threw `unknown test method` on every build. */
    async squadPerf(): Promise<unknown> {
        return this.deps.workerCall('squadPerf');
    }

    /** Reset the squad perf counters' EMA timing fields before a fresh
     *  ladder rung (frame-scoped count fields don't need resetting). */
    squadPerfReset(): void {
        void this.deps.workerCall('squadPerfReset');
    }

    /** PLAN-perf N1 — start a per-widget LuaUI cost profile: wraps every
     *  widget callin with a timing closure in the worker (widget-profiler.ts)
     *  and zeroes the gpRunUiPass fixed-tax accumulator. Adds ~2 Lua→JS clock
     *  crossings per widget callin while running — start, measure, dump, stop. */
    async uiProfileStart(): Promise<unknown> {
        return this.deps.workerCall('uiProfileStart');
    }

    /** Merged N1 report: gpRunUiPass slice means (GL save / Fengari / restore
     *  / wipeCaches / rmlFlush), runFrame block means, and the ranked
     *  per-widget callin cost table. Log `.table` for the readable form.
     *  Leaves the profiler running (dump again for a longer window). */
    async uiProfileDump(topN?: number): Promise<unknown> {
        return this.deps.workerCall('uiProfileDump', topN == null ? [] : [topN]);
    }

    /** Restore the original widget callins (ends the N1 profile session). */
    async uiProfileStop(): Promise<unknown> {
        return this.deps.workerCall('uiProfileStop');
    }

    /** PLAN-perf M27 — arm (or, with `false`, disarm) the `entity`-phase cost
     *  split: interpolation tick / per-squad pose sync / squad update /
     *  backend flush / impostor flush / event drain / residual. Arming zeroes
     *  the accumulator, so arm → run the window → dump reports that window.
     *  Measurement only; disarm when done. */
    async entityBreakdownArm(on?: boolean): Promise<unknown> {
        return this.deps.workerCall('entityBreakdownArm', on == null ? [] : [on]);
    }

    /** Per-frame means of the M27 slices, with the mean squad and entity
     *  counts of the window (the band any µs/squad figure is quoted over) and
     *  a pre-formatted `.table`. */
    async entityBreakdownDump(): Promise<unknown> {
        return this.deps.workerCall('entityBreakdownDump');
    }

    /** PLAN-fx-offload X5 — per-def cost/skip counts for the legacy
     *  per-frame entity-FX compatibility path (entity-fx-fence.ts), ranked
     *  most-expensive-first like uiProfileDump(). Always-on (no start/stop
     *  needed) — reports zero defs until some caller actually runs a
     *  legacy per-def script through the fence. */
    async entityFxFenceDump(): Promise<unknown> {
        return this.deps.workerCall('entityFxFenceDump');
    }

    /** Clear the fence's per-def stats + frame count. */
    entityFxFenceReset(): void {
        void this.deps.workerCall('entityFxFenceReset');
    }

    /** PLAN-client-resilience.md task 5 — trigger one of task 1's detection
     *  paths on demand, so the recovery ladder (task 2) and the telemetry
     *  channel (task 3) have something reliable to exercise:
     *    - `'throw'`      — an uncaught worker-global error (self.onerror)
     *    - `'rejection'`  — an unhandled promise rejection
     *    - `'wedge-loop'` — blocks the worker's event loop synchronously for
     *      `opts.ms` (default 8000ms) — the heartbeat-watchdog's target;
     *      nothing else in the worker runs until it clears on its own.
     *    - `'context-loss'` — forces `WEBGL_lose_context`, optionally
     *      restoring after `opts.restoreAfterMs` (default 500ms; 0 = stay lost)
     *  Resolves once the worker has *triggered* the fault, not once any
     *  ladder rung has run (there is no ladder yet — see the PLAN.md task 2
     *  note). `wedge-loop` resolves only after the spin ends, by construction. */
    async injectWorkerError(
        kind: 'throw' | 'rejection' | 'wedge-loop' | 'context-loss',
        opts: { ms?: number; restoreAfterMs?: number } = {},
    ): Promise<unknown> {
        return this.deps.workerCall('injectWorkerError', [kind, opts]);
    }

    /** Named WAN presets. `lan` ≈ localhost; `wan` ≈ regional; `intercont`
     *  ≈ the L0 exit-gate condition (200 ms ± 40 ms jitter, 2 % loss). */
    netSimPreset(name: 'lan' | 'wan' | 'intercont'): void {
        const presets = {
            lan:       { delayMs: 5,   jitterMs: 2,  lossProb: 0 },
            wan:       { delayMs: 80,  jitterMs: 15, lossProb: 0.005 },
            intercont: { delayMs: 200, jitterMs: 40, lossProb: 0.02 },
        } as const;
        void this.deps.workerCall('setNetSim', [presets[name]]);
    }

    // ─── Camera ─────────────────────────────────────────────────────
    //
    // The camera lives in the worker; framing calls forward there and return
    // once the animation has *started* — this.wait() then matches the duration
    // on the main thread (exactly as the in-process harness did, where the
    // animation ran on the shared render loop). Composite ops that need a
    // unit's interpolated position resolve it worker-side in one round-trip.

    /** Move the camera to look down at the unit's current (interpolated)
     *  position. Resolves once the animation completes. */
    async focus(unitId: number, opts: { durationMs?: number; height?: number } = {}): Promise<void> {
        const dur = opts.durationMs ?? DEFAULT_FOCUS_MS;
        const h = opts.height ?? DEFAULT_FOCUS_HEIGHT;
        const ok = await this.deps.workerCall('focusUnit', [unitId, dur, h]);
        if (!ok) throw new Error(`[test] no client-side position for unit ${unitId}`);
        if (dur > 0) await wait(dur + 16);
    }

    /** Move the camera to (x, z). Resolves once the animation completes. */
    async focusOn(x: number, z: number, durationMs = DEFAULT_FOCUS_MS): Promise<void> {
        await this.deps.workerCall('focusOn', [x, z, durationMs]);
        if (durationMs > 0) await wait(durationMs + 16);
    }

    /** Force the camera to a specific height above the look-at target.
     *  Instant. Used by `focus()` to standardise top-down framing. */
    setCameraHeight(height: number): void {
        void this.deps.workerCall('setCameraHeight', [height]);
    }

    // ─── Programmatic camera API — mirrors window.camera ───────────────

    /** Get the current camera pose ({pos, lookAt} of {x,y,z}). Served from
     *  the cached sceneState feed (sync). */
    cameraPose(): CamPose {
        const p = this.deps.getCameraPose();
        if (!p) return { pos: { x: 0, y: 0, z: 0 }, lookAt: { x: 0, y: 0, z: 0 } };
        return p;
    }

    /** Set the camera to a specific pose. */
    async setCameraPose(pose: CamPose, durationMs = 0): Promise<void> {
        await this.deps.workerCall('setCameraPose', [pose, durationMs]);
        if (durationMs > 0) await wait(durationMs + 16);
    }

    /** Orbit around the current look-at. opts: {yawDeg?, pitchDeg?, distance?, durationMs?} */
    async cameraOrbit(opts: { yawDeg?: number; pitchDeg?: number; distance?: number; durationMs?: number } = {}): Promise<void> {
        await this.deps.workerCall('cameraOrbit', [opts]);
        const d = opts.durationMs ?? 0;
        if (d > 0) await wait(d + 16);
    }

    /** Look at a unit by ID — uses the entityRenderer's interpolated
     *  client position. opts: {height?, pitchDeg?, durationMs?} */
    async cameraSnapToUnit(unitId: number, opts: { height?: number; pitchDeg?: number; durationMs?: number } = {}): Promise<void> {
        const ok = await this.deps.workerCall('cameraSnapToUnit', [unitId, opts]);
        if (!ok) throw new Error(`[test] no client-side position for unit ${unitId}`);
        const d = opts.durationMs ?? 0;
        if (d > 0) await wait(d + 16);
    }

    /** Look at a ground point. opts: {height?, pitchDeg?, durationMs?} */
    async cameraSnapToGround(x: number, z: number, opts: { height?: number; pitchDeg?: number; durationMs?: number } = {}): Promise<void> {
        await this.deps.workerCall('cameraSnapToGround', [x, z, opts]);
        const d = opts.durationMs ?? 0;
        if (d > 0) await wait(d + 16);
    }

    /** Top-down view of the entire map. */
    async cameraFitMap(opts: { padding?: number; pitchDeg?: number; durationMs?: number } = {}): Promise<void> {
        await this.deps.workerCall('cameraFitMap', [opts]);
        const d = opts.durationMs ?? 0;
        if (d > 0) await wait(d + 16);
    }

    /** Programmatically toggle the player-facing tracking camera (the `T`
     *  hotkey). DEFERRED in GW8 — the tracking-camera state machine lived on
     *  InputManager (main thread); it has not been ported to the worker
     *  camera yet. No-ops with a warning so scenarios don't throw. */
    setTrackingCamera(on: boolean): void {
        void this.deps.workerCall('setTrackingCamera', [on]);
    }

    /** Frame all of `unitIds` so they sit inside the vertical FOV. Used
     *  by SFX/effects benches to keep both shooter and target visible
     *  through projectile travel. Units the renderer doesn't yet know
     *  about are silently skipped (resolved worker-side). */
    async cameraFitUnits(unitIds: number[], opts: {
        padding?: number;
        pitchDeg?: number;
        durationMs?: number;
        minDistance?: number;
    } = {}): Promise<void> {
        await this.deps.workerCall('cameraFitUnits', [unitIds, opts]);
        const d = opts.durationMs ?? 0;
        if (d > 0) await wait(d + 16);
    }

    /** Save the current pose into a numbered slot. */
    cameraSaveSlot(slot: number): void { void this.deps.workerCall('cameraSaveSlot', [slot]); }
    /** Recall a numbered slot. Returns false when empty. */
    async cameraLoadSlot(slot: number, durationMs = 0): Promise<boolean> {
        const ok = await this.deps.workerCall('cameraLoadSlot', [slot, durationMs]) as boolean;
        if (ok && durationMs > 0) await wait(durationMs + 16);
        return ok;
    }

    // ─── Model harness: orbit rig + sun control (PLAN-model-harness) ──
    //
    // The orbit rig and sun override live in the worker (camera + lighting
    // moved there in GW4/GW8); these are thin dispatch wrappers. While the
    // rig is active the RTS camera input path is suppressed for the view —
    // drag orbits, wheel zooms; `orbitStop()` restores the saved RTS pose.

    /** Start (or retarget) the orbit camera rig. `target` is a unit id
     *  (tracked live — follow mode) or a static `{x, z, radius?}` ground
     *  anchor. Auto-frames on start. Returns the rig state, or false when
     *  the target/camera isn't available yet. */
    async orbit(
        target: number | { x: number; z: number; y?: number; radius?: number },
        opts: { yawDeg?: number; pitchDeg?: number; distance?: number; follow?: boolean } = {},
    ): Promise<unknown> {
        return this.deps.workerCall('orbitStart', [target, opts]);
    }

    /** Exit the orbit rig and restore the pre-orbit RTS camera view. */
    async orbitStop(): Promise<void> {
        await this.deps.workerCall('orbitStop');
    }

    /** Adjust the live rig (yaw/pitch/distance/follow). Returns rig state. */
    async orbitSet(opts: {
        yawDeg?: number; pitchDeg?: number; distance?: number; follow?: boolean;
    }): Promise<unknown> {
        return this.deps.workerCall('orbitSet', [opts]);
    }

    /** Re-frame: sphere fills `fill` (default 0.7) of the shorter viewport
     *  axis. */
    async orbitFrame(fill?: number): Promise<unknown> {
        return this.deps.workerCall('orbitFrame', fill == null ? [] : [fill]);
    }

    async orbitState(): Promise<unknown> {
        return this.deps.workerCall('orbitState');
    }

    /** Override the sun: `{azimuthDeg, elevationDeg}` (missing fields keep
     *  their current value). Pass `null` to restore the map's authored
     *  lighting. Elevation below the horizon applies the night preset
     *  (sun off + ambient floor). Purely client-side render state. */
    async sun(angles: { azimuthDeg?: number; elevationDeg?: number } | null): Promise<unknown> {
        return this.deps.workerCall('setSun', [angles]);
    }

    /** Animate a full day–night cycle every `secondsPerDay` wall seconds
     *  (azimuth 360° + dawn→noon→dusk elevation arc; below-horizon =
     *  night). Pass 0 to freeze at the current pose; `sun(null)` restores. */
    async sunCycle(secondsPerDay: number, peakElevationDeg?: number): Promise<unknown> {
        return this.deps.workerCall('sunCycle',
            peakElevationDeg == null ? [secondsPerDay] : [secondsPerDay, peakElevationDeg]);
    }

    async getSun(): Promise<unknown> {
        return this.deps.workerCall('getSun');
    }

    /** Streamed unit defs known to the worker DefCache (minimal picker /
     *  probe fields). Defs stream on-demand — spawn first, then poll. */
    async listUnitDefs(): Promise<{
        defId: number; name: string; humanName: string;
        flags: number; mass: number; xsize: number; metalCost: number;
    }[]> {
        return await this.deps.workerCall('listUnitDefs') as {
            defId: number; name: string; humanName: string;
            flags: number; mass: number; xsize: number; metalCost: number;
        }[];
    }

    /** Full streamed UnitDefInfo by def name, or null if not streamed yet. */
    async unitDefByName(name: string): Promise<Record<string, unknown> | null> {
        return await this.deps.workerCall('unitDefByName', [name]) as
            Record<string, unknown> | null;
    }

    /** World bounding sphere + model status for a unit. `hasModel`:
     *  true = real model, false = procedural fallback shape (E1 badge),
     *  null = still loading. */
    async entityBounds(unitId: number): Promise<{
        x: number; y: number; z: number; radius: number; hasModel: boolean | null;
    } | null> {
        return await this.deps.workerCall('entityBounds', [unitId]) as
            { x: number; y: number; z: number; radius: number; hasModel: boolean | null } | null;
    }

    /** Worker game-connection readiness. The WebTransport game connection comes
     *  up asynchronously after startGame; a scenario that spawns before it is
     *  authenticated loses its first viewport update and the entity never
     *  streams (reads as a phantom model-load failure). Gate spawns on
     *  `authenticated`, and use `authFailed` (server rejection message) vs
     *  `receivedState` (first snapshot seen) to report the real cause. */
    async gameConnected(): Promise<{ authenticated: boolean; authFailed: string | null; receivedState: boolean }> {
        return await this.deps.workerCall('gameConnected') as
            { authenticated: boolean; authFailed: string | null; receivedState: boolean };
    }

    /** Scene-wide wireframe toggle (F8 panel render group). */
    setWireframe(on: boolean): void {
        void this.deps.workerCall('setWireframe', [on]);
    }

    /** Force every entity to one LOD tier (F8 panel's force-LOD dropdown,
     *  PLAN-metalstorm-beta-units.md §2.1). null restores per-def thresholds. */
    setForceLodTier(tier: 'full' | 'impostor' | 'icon' | null): void {
        void this.deps.workerCall('setForceLodTier', [tier]);
    }

    // ─── Model harness: generic clip player (PLAN-model-harness task 6) ──
    //
    // Plays authored .glb animation clips through the client animator
    // wrapper (clip-player.ts) — clips the sim never triggers. The wrapper
    // API is stable across the PLAN-fx-offload animator migration.

    /** Authored clip names on a unit's model. null = template still
     *  loading / unknown unit (poll, like entityBounds); [] = model loaded
     *  with no clips (all converted S3O/DAE models). */
    async listClips(unitId: number): Promise<string[] | null> {
        return await this.deps.workerCall('listClips', [unitId]) as string[] | null;
    }

    /** Play one authored clip on the unit (loops by default). Playback is
     *  per-unit, so this replaces only this unit's clip. Also pins the unit
     *  to manual control — the movement-driven walk/idle policy leaves it
     *  alone until stopClip. Throws when the clip is unknown or the model
     *  hasn't loaded. */
    async playClip(
        unitId: number, clip: string,
        opts: { loop?: boolean; speed?: number } = {},
    ): Promise<unknown> {
        const r = await this.deps.workerCall('playClip', [unitId, clip, opts]) as
            { error?: string } | null;
        if (r && typeof r === 'object' && 'error' in r && r.error) {
            throw new Error(`[test] playClip: ${r.error}`);
        }
        return r;
    }

    /** Stop clip playback and hand the unit back to the movement policy (so
     *  a driving native resumes walking; a stationary one returns to rest
     *  pose / server-streamed piece state). No unitId = every unit. */
    async stopClip(unitId?: number): Promise<void> {
        await this.deps.workerCall('stopClip', unitId === undefined ? [] : [unitId]);
    }

    /** Playback state for a unit, or — with no unitId — for the most
     *  recently started playback. null when nothing is playing. */
    async clipState(unitId?: number): Promise<unknown> {
        return this.deps.workerCall('clipState', unitId === undefined ? [] : [unitId]);
    }

    // ─── Render-loop pause + screenshots ────────────────────────────

    /** Stop the worker render loop. Sim continues on the server unless you
     *  also call `simPause()`. The frozen frame remains visible (the canvas
     *  uses preserveDrawingBuffer) so you can screenshot a deterministic
     *  moment. */
    pause(): void { this.renderPaused = true; void this.deps.workerCall('pause'); }
    resume(): void { this.renderPaused = false; void this.deps.workerCall('resume'); }
    get paused(): boolean { return this.renderPaused; }

    /** Capture the current canvas as a PNG data-URL. The worker reads its
     *  OffscreenCanvas (created with preserveDrawingBuffer) and base64-encodes
     *  the PNG. NOTE: async now (GW8) — the canvas lives in the worker.
     *  For full-page captures prefer the chrome-devtools `take_screenshot`. */
    async screenshot(): Promise<string> {
        return await this.deps.workerCall('screenshot') as string;
    }

    /**
     * Deterministic screenshot: the worker renders and reads pixels in ONE
     * task, so a capture can no longer land between frames (the historical
     * black/stale-frame retry loop). Under `pause()` the worker renders
     * explicitly, so repeated calls return the SAME frame.
     *
     * `stats: true` computes min/max/mean luminance worker-side over the
     * downsampled pixels — no Image decode, no main thread, no DOM.
     *
     * A capture under `pause()` still RENDERS by default (so
     * pause → focusOn → capture shows the new view), which advances
     * `frameId`; pass `render: false` for a byte-identical re-read of the
     * frame already in the buffer.
     *
     * THREE capture surfaces exist and are NOT composited:
     *   - this — the worker's WebGL canvas (game world only);
     *   - chrome-devtools `take_screenshot` — DOM + HUD only, it cannot see a
     *     WebGL2 canvas;
     *   - `minimapScreenshot()` — the main-thread minimap engine.
     * Compositing them is the caller's job: take both and overlay.
     */
    async captureFrame(opts: CaptureFrameOpts = {}): Promise<CaptureFrameResult> {
        return await this.deps.workerCall('captureFrame', [opts]) as CaptureFrameResult;
    }

    /** Live entity ids for a def NAME, newest first, as the CLIENT mirror
     *  knows them. `[]` means this client cannot show you that def — which is
     *  a different (and more useful) statement than the server's unit list. */
    async entitiesByDef(defName: string): Promise<number[]> {
        return await this.deps.workerCall('entitiesByDef', [defName]) as number[];
    }

    /**
     * **Subject → usable image, in ONE call.** The primitive every "show me
     * this" workflow should reach for; hand-rolling camera math is what this
     * replaces.
     *
     * Why it is one method and not four. Over the MCP relay each round trip
     * costs seconds, and the sim does not wait: a guided playthrough on
     * 2026-08-29 advanced **1,000+ sim frames** between a camera call and the
     * screenshot call that was supposed to go with it, and the engagement it
     * was aiming at was over by the time the shutter fell. Resolve → frame →
     * hold → capture → check therefore all happen inside a single relay
     * evaluation, on the browser side of the wire.
     *
     * What it does, in order:
     *
     *  1. **Resolve the subject** to a world bounding sphere — a unit id (or
     *     several, merged), a def name (newest live instance this client
     *     actually has), a position, or a ground rectangle. A unit that has
     *     not reached the renderer is waited for, up to `resolveTimeoutMs`,
     *     and then reported as unresolvable rather than framed blind.
     *  2. **Frame from the subject's OWN radius** via the orbit rig, so a 4 m
     *     rifleman and a 65 m submarine both fill the frame. Presets are
     *     world-relative (`three-quarter` by default); the rig is the
     *     ground-anchored path — free `setCameraPose` is ignored while it owns
     *     the view.
     *  3. **Dwell, then hold.** A short live-render dwell lets newly-visible
     *     terrain and models draw; then the render loop is frozen so the
     *     capture and any retry see the same world. (Freezing the SIM is the
     *     caller's job — from the browser it would deadlock the game server's
     *     single HTTP thread. `capture_subject` does it server-side.)
     *  4. **Capture and judge.** `captureFrame` already guarantees a presented
     *     frame; this adds a mean-luminance floor, and re-frames up and out
     *     (`retryFraming`) when the frame comes back black. A frame that is
     *     still black after the retries comes back with `ok:false` and a
     *     `diagnosis` naming the candidate causes — never as a silent
     *     deliverable.
     *
     * Always restores what it changed (render pause, and the camera view
     * unless `restore:false`), including on failure.
     */
    async captureSubject(spec: CaptureSubjectSpec = {}): Promise<CaptureSubjectResult> {
        const warnings: string[] = [];
        const framing = resolveFraming(spec);
        const resolveTimeoutMs = spec.resolveTimeoutMs ?? 5000;
        const settleMs = spec.settleMs ?? 250;
        const holdRender = spec.holdRender !== false;
        const restore = spec.restore !== false;
        const retries = Math.max(0, Math.min(5, spec.retries ?? 2));

        // ── 1. Resolve the subject ──────────────────────────────────────
        const r = await this.resolveCaptureSubject(spec, resolveTimeoutMs);
        warnings.push(...r.warnings);
        const kind = r.kind;
        const unitIds = r.unitIds;
        const def = r.def;
        const hasModel = r.hasModel;
        const target = r.target;
        let sphere = r.sphere;

        // ── 2. Frame from the subject's own bounds ──────────────────────
        const started = await this.orbit(target, {
            yawDeg: framing.yawDeg, pitchDeg: framing.pitchDeg,
            follow: unitIds.length === 1,
        }) as { anchor?: Sphere } | false;
        if (!started || typeof started !== 'object') {
            throw new Error('[test] captureSubject: the orbit rig refused the subject'
                + ' (no camera, or the target has no bounds yet)');
        }
        let rig = await this.orbitFrame(framing.fill) as
            { anchor: Sphere; distance: number; pitchDeg: number; yawDeg: number };
        // The rig latched the authoritative anchor (ground height sampled for a
        // bare x/z, model centre for a unit) — report THAT, not our estimate.
        if (rig?.anchor) sphere = rig.anchor;

        // ── 3+4. Dwell, hold, capture, judge ────────────────────────────
        const attempts: AttemptRecord[] = [];
        let shot: CaptureFrameResult | null = null;
        let presentation: Awaited<ReturnType<TestHarness['presentationSnap']>> | null = null;
        try {
            if (settleMs > 0) await wait(settleMs);
            if (holdRender) this.pause();
            for (let attempt = 0; attempt <= retries; attempt++) {
                const f = retryFraming(framing, attempt);
                if (attempt > 0) {
                    await this.orbitSet({ yawDeg: f.yawDeg, pitchDeg: f.pitchDeg });
                    rig = await this.orbitFrame(f.fill) as typeof rig;
                }
                // V2: with the sim stopped (or stepped) the presentation
                // cursor has no wall-clock rate to close the gap to the state
                // the server just produced, so the shot would be of a frame
                // older than the one we deliberately stepped to.
                if (spec.syncPresentation) presentation = await this.presentationSnap();
                shot = await this.captureFrame({
                    maxDim: spec.maxDim, quality: spec.quality,
                    format: spec.format, stats: true,
                });
                const verdict = luminanceVerdict(shot.stats, {
                    luminanceFloor: spec.luminanceFloor,
                    contrastFloor: spec.contrastFloor,
                });
                attempts.push({ framing: f, stats: shot.stats, verdict });
                if (!verdict.black) break;
            }
        } finally {
            if (holdRender) this.resume();
            if (restore) await this.orbitStop().catch(() => undefined);
        }

        if (!shot) throw new Error('[test] captureSubject: no frame was captured');
        const anchor: Sphere = sphere ?? { x: 0, y: 0, z: 0, radius: 1 };
        const diagnosis = diagnose(attempts, {
            revealed: spec.revealed === true,
            underwater: anchor.y < 0,
        });
        const applied = attempts[attempts.length - 1].framing;
        return {
            dataUrl: shot.dataUrl,
            width: shot.width, height: shot.height,
            frameId: shot.frameId, gameFrame: shot.gameFrame,
            stats: shot.stats,
            subject: {
                kind,
                unitId: unitIds.length === 1 ? unitIds[0] : null,
                unitIds, def,
                sphere: anchor,
                metresAcross: metresAcross(anchor),
                hasModel,
            },
            framing: { ...applied, angle: framing.angle, distance: rig?.distance ?? 0 },
            presentation,
            attempts, warnings, diagnosis,
            ok: diagnosis === null || !attempts[attempts.length - 1].verdict.black,
        };
    }

    /**
     * Put the presentation cursor on the newest server frame this client has
     * actually received, discarding the jitter buffer for one shot.
     *
     * The capture path's companion to `sim_step`. A stopped sim has no
     * wall-clock rate for the presentation PLL to close a gap with, so after a
     * step the cursor sits behind the state the step just produced and a shot
     * photographs the *previous* pose — silently, and identically to a correct
     * shot. See PresentationClock.snapToNewest for why this is an explicit
     * escape hatch rather than the default.
     */
    async presentationSnap(): Promise<{
        ok: boolean; jumpedFrames?: number; E?: number; P?: number;
        newestFrame?: number; gameFrame?: number; paused?: boolean;
        simSpeed?: number; reason?: string;
    }> {
        return await this.deps.workerCall('presentationSnap') as {
            ok: boolean; jumpedFrames?: number;
        };
    }

    /**
     * **Film a manoeuvre.** A burst of N framed shots of one subject, taken
     * inside a SINGLE relay evaluation, with the camera re-framing on the
     * subject between shots.
     *
     * Why a burst and not N calls to `captureSubject`. Each relay round trip
     * costs seconds, so an N-shot "sequence" driven from the MCP at speed 1 is
     * N poses at an unknown, unequal and unmeasurable spacing — real images of
     * nothing you can reason about. Here the whole burst is one evaluation, so
     * the inter-shot interval is wall-clock-accurate: `shotIntervalMs()` turns
     * "3 sim frames apart at 0.1× speed" into the 1000 ms this loop sleeps.
     *
     * **This is the REALTIME mode, and its spacing is nominal.** It asks the
     * wall clock for an interval and reports what the sim actually delivered
     * (`summary.frameDeltas`) rather than assuming they match. When the
     * spacing has to be exact — M1's turn arc, anything measured off the
     * frames — use the MCP's `capture_sequence` in `step` mode instead: it
     * advances the sim by `sim_step` between shots, so the spacing is exact
     * however long the camera took. Stepping cannot be driven from here; from
     * the browser it would deadlock the game server's single HTTP thread.
     *
     * Bytes. The relay's 4 MB cap is per message and this reply carries every
     * frame, so resolution defaults DOWN with the frame count
     * (`sequenceMaxDim`) and the burst stops early rather than returning a
     * reply the relay will drop — `truncated` says so when it does.
     *
     * The failure it refuses to hide: N shots of the SAME sim frame. Every
     * image is well-exposed and well-framed and the "film" is a still life.
     * `summariseSequence` makes that `ok:false` with the causes named.
     */
    async captureSequence(spec: CaptureSequenceSpec = {}): Promise<{
        subject: CaptureSubjectResult['subject'];
        framing: ReturnType<typeof resolveFraming> & { distance: number };
        shots: SequenceShot[];
        summary: SequenceSummary;
        requested: { frames: number; everyNthSimFrame: number; simSpeed: number; intervalMs: number };
        truncated: boolean;
        payloadChars: number;
        warnings: string[];
        ok: boolean;
    }> {
        const warnings: string[] = [];
        const framing = resolveFraming(spec as Parameters<typeof resolveFraming>[0]);
        const frames = clampFrames(spec.frames);
        const stride = Math.max(1, Math.floor(spec.everyNthSimFrame ?? 3));
        const simSpeed = clampSimSpeed(spec.simSpeed ?? 1);
        const intervalMs = shotIntervalMs(stride, simSpeed);
        const resolveTimeoutMs = spec.resolveTimeoutMs ?? 5000;
        const settleMs = spec.settleMs ?? 250;
        const track = spec.trackSubject !== false;
        const sync = spec.syncPresentation !== false;
        const maxDim = spec.maxDim ?? sequenceMaxDim(frames);
        const quality = spec.quality ?? SEQUENCE_QUALITY;
        // JPEG unless told otherwise. `captureFrame` defaults to PNG, which is
        // right for one shot and wrong for a dozen: a burst of 900 px PNGs is
        // ~1.8 MB each and hits the relay wire cap at five frames.
        const format = spec.format ?? 'jpeg';

        const r = await this.resolveCaptureSubject(spec, resolveTimeoutMs);
        warnings.push(...r.warnings);

        const started = await this.orbit(r.target, {
            yawDeg: framing.yawDeg, pitchDeg: framing.pitchDeg,
            follow: r.unitIds.length === 1,
        }) as { anchor?: Sphere } | false;
        if (!started || typeof started !== 'object') {
            throw new Error('[test] captureSequence: the orbit rig refused the subject'
                + ' (no camera, or the target has no bounds yet)');
        }
        let rig = await this.orbitFrame(framing.fill) as
            { anchor: Sphere; distance: number };
        let sphere = rig?.anchor ?? r.sphere;

        if (intervalMs === 0) {
            warnings.push('sim speed reads as 0 (paused) — a realtime burst has no'
                + ' wall-clock interval to pace by, so every shot will be the same'
                + ' frame. Use the MCP capture_sequence in step mode.');
        }
        if (track && r.unitIds.length !== 1) {
            warnings.push('subject is not a single unit — the camera anchor is'
                + ' static, so a subject that moves will leave the frame');
        }

        const shots: SequenceShot[] = [];
        const t0 = performance.now();
        // The relay abandons a `test` evaluation that has not answered in 8 s,
        // taking every frame with it. Stopping short and returning what we have
        // is strictly better than a burst that vanishes.
        const deadline = t0 + REALTIME_BURST_BUDGET_MS;
        let chars = 0;
        let truncated = false;
        try {
            if (settleMs > 0) await wait(settleMs);
            for (let i = 0; i < frames; i++) {
                // Absolute deadlines, not `sleep(interval)` per iteration: the
                // capture itself takes tens of ms and sleeping *between* shots
                // would let that cost accumulate into the spacing.
                if (i > 0 && intervalMs > 0) {
                    const due = t0 + settleMs + i * intervalMs;
                    if (due > deadline) {
                        truncated = true;
                        warnings.push(`stopped after ${i} of ${frames} frames — the next`
                            + ' shot would fall outside the relay\'s 8 s main-thread'
                            + ' budget and the whole reply would be abandoned. Use'
                            + ' mode:"step" for a span this long.');
                        break;
                    }
                    const left = due - performance.now();
                    if (left > 0) await wait(left);
                }
                // Re-frame every shot: the rig follows a single unit, and a
                // subject that is turning or walking changes its bounds.
                if (track && r.unitIds.length === 1) {
                    rig = await this.orbitFrame(framing.fill) as typeof rig;
                    if (rig?.anchor) sphere = rig.anchor;
                }
                const snap = sync ? await this.presentationSnap() : null;
                const shot = await this.captureFrame({
                    maxDim, quality, format, stats: true,
                });
                // Budget check BEFORE appending: discovering the overflow after
                // the reply is built is discovering it too late.
                if (i > 0 && wireBudgetExceeded(chars, shot.dataUrl.length)) {
                    truncated = true;
                    warnings.push(`stopped after ${i} of ${frames} frames — the next`
                        + ' one would push the reply past the relay wire cap. Ask for'
                        + ' fewer frames, a smaller maxDim, or use the MCP'
                        + ' capture_sequence, which writes each frame to disk.');
                    break;
                }
                chars += shot.dataUrl.length;
                shots.push({
                    index: i,
                    // The freshest ENTITY frame this client holds, when we have
                    // it. `shot.gameFrame` comes from GameInfo — broadcast once
                    // a game-second — so it quantises to 30 and would report a
                    // burst of genuinely different frames as one instant.
                    gameFrame: snap?.newestFrame ?? shot.gameFrame,
                    clientFrame: snap?.newestFrame,
                    frameId: shot.frameId,
                    atMs: Math.round(performance.now() - t0),
                    dataUrl: shot.dataUrl,
                    width: shot.width, height: shot.height,
                    stats: shot.stats,
                    verdict: luminanceVerdict(shot.stats, {
                        luminanceFloor: spec.luminanceFloor,
                        contrastFloor: spec.contrastFloor,
                    }),
                });
            }
        } finally {
            await this.orbitStop().catch(() => undefined);
        }

        const summary = summariseSequence(shots, {
            expectedStride: stride, mode: 'realtime',
        });
        const anchor: Sphere = sphere ?? { x: 0, y: 0, z: 0, radius: 1 };
        return {
            subject: {
                kind: r.kind,
                unitId: r.unitIds.length === 1 ? r.unitIds[0] : null,
                unitIds: r.unitIds, def: r.def,
                sphere: anchor,
                metresAcross: metresAcross(anchor),
                hasModel: r.hasModel,
            },
            framing: { ...framing, distance: rig?.distance ?? 0 },
            shots, summary,
            requested: { frames, everyNthSimFrame: stride, simSpeed, intervalMs },
            truncated,
            payloadChars: payloadChars(shots.map((x) => x.dataUrl)),
            warnings,
            ok: summary.ok,
        };
    }

    /**
     * Subject spec → the bounding sphere and rig target that frame it.
     *
     * Shared by `captureSubject` (one shot) and `captureSequence` (a burst),
     * because "which unit did you mean, and has its MODEL arrived yet" is the
     * half of framing that is easy to get subtly wrong. The trap it encodes:
     * `getEntityBounds` answers with the DEF-RADIUS FALLBACK while a model
     * template is still loading, and framing off that is the wrong-zoom bug
     * itself (V1 caught a 17 m heavy reporting as 2.5 m), so resolution waits
     * for the template, not merely for the entity.
     */
    private async resolveCaptureSubject(
        spec: CaptureSubjectSpec | CaptureSequenceSpec,
        resolveTimeoutMs: number,
    ): Promise<{
        kind: CaptureSubjectResult['subject']['kind'];
        unitIds: number[];
        def: string | null;
        target: number | { x: number; z: number; y?: number; radius?: number };
        sphere: Sphere | null;
        hasModel: boolean | null;
        warnings: string[];
    }> {
        const warnings: string[] = [];
        let kind: CaptureSubjectResult['subject']['kind'];
        let unitIds: number[] = [];
        let def: string | null = null;
        let target: number | { x: number; z: number; y?: number; radius?: number };
        let hasModel: boolean | null = null;
        let sphere: Sphere | null = null;

        if (spec.def) {
            kind = 'def';
            def = spec.def;
            const found = await this.waitForDefEntities(spec.def, resolveTimeoutMs);
            if (found.length === 0) {
                throw new Error(`[test] captureSubject: no live entity of def "${spec.def}"`
                    + ` reached this client within ${resolveTimeoutMs} ms.`
                    + ' Spawn it first, check the def name, or pass unitId/position.');
            }
            if (found.length > 1) {
                warnings.push(`${found.length} live "${spec.def}" — framing the newest`
                    + ` (id ${found[0]}); pass unitIds to frame them all.`);
            }
            unitIds = [found[0]];
            target = found[0];
        } else if (spec.unitIds?.length || spec.unitId !== undefined) {
            unitIds = spec.unitIds?.length ? [...spec.unitIds] : [spec.unitId as number];
            kind = unitIds.length > 1 ? 'units' : 'unit';
            target = unitIds[0];
        } else if (spec.area) {
            kind = 'area';
            const s = sphereFromArea(spec.area);
            target = { x: s.x, z: s.z, radius: s.radius };
        } else if (spec.position) {
            kind = 'position';
            const s = sphereFromPosition(spec.position);
            target = spec.position.y === undefined
                ? { x: s.x, z: s.z, radius: s.radius }
                : { x: s.x, y: s.y, z: s.z, radius: s.radius };
        } else {
            throw new Error('[test] captureSubject needs a subject:'
                + ' unitId, unitIds, def, position or area.');
        }

        if (unitIds.length) {
            const bounds = await this.waitForBounds(unitIds, resolveTimeoutMs);
            const resolved = bounds.filter((b) => b !== null) as NonNullable<
                Awaited<ReturnType<TestHarness['entityBounds']>>>[];
            if (resolved.length === 0) {
                throw new Error(`[test] captureSubject: unit ${unitIds.join(', ')} has no`
                    + ` client-side bounds after ${resolveTimeoutMs} ms —`
                    + ' it is not streamed to this client (dead, out of LOS, or never spawned).');
            }
            if (resolved.length < unitIds.length) {
                warnings.push(`${unitIds.length - resolved.length} of ${unitIds.length}`
                    + ' units are not streamed to this client and were left out of the framing');
            }
            sphere = mergeSubjectSpheres(resolved);
            hasModel = resolved.every((b) => b.hasModel === true) ? true
                : resolved.some((b) => b.hasModel === false) ? false
                : resolved.some((b) => b.hasModel === null) ? null : true;
            if (hasModel === false) {
                warnings.push('procedural FALLBACK shape — this def has no model loaded,'
                    + ' so the image shows a placeholder, not the art');
            } else if (hasModel === null) {
                warnings.push('model template still loading — the shape may be a placeholder');
            }
            // A multi-unit subject needs a static anchor: the rig follows ONE
            // target, and following unit[0] would let the others leave frame.
            if (resolved.length > 1 && sphere) {
                target = { x: sphere.x, y: sphere.y, z: sphere.z, radius: sphere.radius };
            }
        }
        return { kind, unitIds, def, target, sphere, hasModel, warnings };
    }

    /** Poll `entitiesByDef` until it answers, or the budget runs out. Defs
     *  stream on demand, so a just-spawned unit is legitimately absent for a
     *  tick or two — this is the wait that makes spawn→capture honest. */
    private async waitForDefEntities(defName: string, timeoutMs: number): Promise<number[]> {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        for (;;) {
            const ids = await this.entitiesByDef(defName);
            if (ids.length) return ids;
            if (Date.now() >= deadline) return [];
            await wait(100);
        }
    }

    /**
     * Poll `entityBounds` for each id until every one resolves *and* its model
     * template has settled, or time runs out. Returns per-id results in the
     * order asked, nulls included.
     *
     * The `hasModel === null` wait is not fussiness. While a template is still
     * loading, `getEntityBounds` returns the DEF radius around the origin — a
     * fallback that is nothing like the model's real extent — and framing off
     * it reproduces the exact failure this whole primitive exists to remove:
     * a just-spawned 17 m heavy came back as "2.5 m across" and was
     * photographed from 34 elmos. Measured against a freshly spawned def, the
     * template lands well inside the default budget.
     */
    private async waitForBounds(
        unitIds: readonly number[], timeoutMs: number,
    ): Promise<(Awaited<ReturnType<TestHarness['entityBounds']>>)[]> {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        const unsettled = (
            out: (Awaited<ReturnType<TestHarness['entityBounds']>>)[],
        ): boolean => out.some((b) => b === null || b.hasModel === null);
        let out = await Promise.all(unitIds.map((id) => this.entityBounds(id)));
        while (unsettled(out) && Date.now() < deadline) {
            await wait(100);
            out = await Promise.all(unitIds.map((id) => this.entityBounds(id)));
        }
        return out;
    }

    /** Save the current canvas to a downloaded PNG file. */
    async saveScreenshot(filename?: string): Promise<string> {
        const url = await this.screenshot();
        const a = document.createElement('a');
        a.href = url;
        a.download = filename ?? `spring-test-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return url;
    }

    /** High-resolution screenshot at an arbitrary resolution, rendered through
     *  an offscreen render target in the worker (where the engine + camera
     *  live). Honours its arguments — before P5 it voided them and returned a
     *  canvas-resolution `screenshot()`. Pause-safe: the RTT renders its own
     *  frame. */
    async highResScreenshot(width = 1920, height = 1080): Promise<string> {
        return await this.deps.workerCall('highResScreenshot', [width, height]) as string;
    }

    /** Capture the **minimap** as a PNG data-URL. A third capture route,
     *  distinct from both `screenshot()` (worker canvas) and CDP
     *  `take_screenshot` (cannot read a WebGL2 canvas): the minimap owns its
     *  own main-thread Engine + canvas, so nothing else reaches it.
     *  Synchronous under the hood — see `Minimap.captureFrame`. */
    minimapScreenshot(): string {
        const mm = this.deps.getMinimap();
        if (!mm) throw new Error('[test] no minimap — not in a game session?');
        return mm.captureFrame();
    }

    /** Summary statistics for one minimap frame, without the base64 payload.
     *  Prefer this for assertions and A/Bs; `transparentFraction` near 1.0
     *  means the capture failed and no other field is meaningful. */
    minimapStats(): MinimapFrameStats {
        const mm = this.deps.getMinimap();
        if (!mm) throw new Error('[test] no minimap — not in a game session?');
        return mm.captureFrameStats();
    }

    // ─── Selection helpers ──────────────────────────────────────────

    /** Replace the client selection with the given unit IDs. */
    select(unitIds: number[]): void {
        void this.deps.workerCall('select', [unitIds]);
    }

    /** Read-only snapshot of currently selected unit IDs. Served from the
     *  cached sceneState feed (sync). */
    get selection(): readonly number[] {
        return this.deps.getSelection();
    }

    // ─── Org groups ─────────────────────────────────────────────────

    /**
     * Form an org group with a name and members, through the client's own
     * `OrgGroup` create path (the one the org panel will post).
     *
     * The worker's dispatcher has had this op since the macro-UI work; the
     * harness simply never bound it, so nothing outside the (not-yet-built) org
     * panel could form a POPULATED group. That mattered while verifying the
     * command language's `follow` verb (PLAN-metalstorm-command-language.md
     * §6.2): a follow needs a group whose members are in the client mirror, and
     * Metalstorm ships no way to make one — its manifest has no org panel and,
     * per the M2 field notes, `strategos` never calls `createGroup`. The
     * gadget-side `Spring.CreateOrgGroup` callout reachable from `test.lua()`
     * creates the group but attaches no members.
     *
     * Pass an empty name to let the server assign the next callsign.
     */
    orgGroupCreate(name: string, memberIds: number[]): void {
        void this.deps.workerCall('orgGroupCreate', [name, memberIds]);
    }

    /** The client's org-group snapshot (`gp:orgGroups`), as the ui-store sees it. */
    async orgGroups(): Promise<unknown> {
        return this.deps.workerCall('orgGroups');
    }

    // ─── Readiness (zero HTTP) ──────────────────────────────────────

    /** Latest sim frame from the ~10 Hz `gp:sceneState` feed. Synchronous;
     *  -1 before the first feed message. Up to `sceneStateAgeMs` stale — use
     *  `readyState()` when the staleness itself matters. */
    clientFrame(): number {
        return this.deps.getSceneFrame()?.gameFrame ?? -1;
    }

    /**
     * One-round-trip readiness snapshot: worker liveness, game connection,
     * frame progress and a render census. Issues **zero HTTP requests** —
     * unlike the old poll-the-lobby-room-state recipe, which is also wrong
     * (room state never reaches Active for an in-game client).
     *
     * Never throws: a dead or wedged worker reports `worker.alive: false`
     * with the worker-sourced fields nulled/zeroed.
     *
     * `worker.sceneStateAgeMs` is age of the CACHED feed, not liveness: the
     * feed legitimately stops while the sim is paused server-side. Liveness is
     * `worker.alive` (the round-trip), and only that.
     */
    async readyState(): Promise<ReadyState> {
        const scene = this.deps.getSceneFrame();
        const timing = this.deps.getTiming();
        const frame = {
            gameFrame: scene ? scene.gameFrame : null,
            anchored: timing?.anchored ?? false,
            newestBaseFrame: timing?.newestFrame ?? 0,
        };
        try {
            const p = await this.deps.workerCall('readyProbe') as {
                authenticated: boolean; authFailed: string | null; receivedState: boolean;
                frameId: number; meshCount: number; terrainMeshCount: number;
            };
            return {
                harness: true,
                worker: { alive: true, sceneStateAgeMs: scene ? scene.ageMs : null },
                connection: {
                    authenticated: p.authenticated,
                    authFailed: p.authFailed,
                    receivedState: p.receivedState,
                },
                frame,
                render: {
                    frameId: p.frameId,
                    meshCount: p.meshCount,
                    terrainMeshCount: p.terrainMeshCount,
                },
            };
        } catch {
            return {
                harness: true,
                worker: { alive: false, sceneStateAgeMs: scene ? scene.ageMs : null },
                connection: { authenticated: false, authFailed: null, receivedState: false },
                frame,
                render: { frameId: -1, meshCount: 0, terrainMeshCount: 0 },
            };
        }
    }

    // ─── Worker state queries ───────────────────────────────────────
    //
    // Every dispatch case below already existed in the worker; only these
    // bindings are new — nothing outside `window.__gp('…')` string-eval could
    // reach them.

    /** The NL query engine's unit census (the shape `window.units` reads). */
    async census(): Promise<unknown> {
        return this.deps.workerCall('nlCensus');
    }

    /** Per-factory build queues as the client mirror sees them (confirmed vs
     *  optimistic-pending counts). */
    async factoryQueue(): Promise<{ unitId: number; defId: number; name: string;
        count: number; confirmed: number; pending: number }[]> {
        return await this.deps.workerCall('factoryQueue') as { unitId: number;
            defId: number; name: string; count: number;
            confirmed: number; pending: number }[];
    }

    /** Optimistic build placements not yet confirmed by the server. */
    async pendingBuilds(): Promise<unknown[]> {
        return await this.deps.workerCall('pendingBuilds') as unknown[];
    }

    /** Build-menu chip counts (queued vs pending) for the current selection. */
    async buildChips(): Promise<{ defId: number; name: string;
        queued: number; pending: number }[]> {
        return await this.deps.workerCall('buildChips') as { defId: number; name: string;
            queued: number; pending: number }[];
    }

    /** Entity-snapshot arrival stats — count, last arrival, and the gap since. */
    async snapshotStats(): Promise<{ count: number; lastAtMs: number;
        sinceMs: number; nowMs: number }> {
        return await this.deps.workerCall('snapshotStats') as { count: number;
            lastAtMs: number; sinceMs: number; nowMs: number };
    }

    /** The client's directive mirror (PLAN-macro-ui). */
    async directives(): Promise<unknown> {
        return this.deps.workerCall('directives');
    }

    /** Number of order-overlay entries currently drawn for one unit. */
    async overlayOrders(unitId: number): Promise<number> {
        return await this.deps.workerCall('overlayOrders', [unitId]) as number;
    }

    /** Number of live map markers. */
    async markerCount(): Promise<number> {
        return await this.deps.workerCall('markerCount') as number;
    }

    /** Order-acknowledgement counters (attempts vs played). Pass true to
     *  zero them after reading. */
    async orderAckStats(reset = false): Promise<{ attempts: number; played: number }> {
        return await this.deps.workerCall('orderAckStats', [reset]) as
            { attempts: number; played: number };
    }

    /** Set the selection through the client's own selection path and return
     *  the resulting selection (contrast `select()`, which is fire-and-forget). */
    async selectUnits(ids: number[]): Promise<number[]> {
        return await this.deps.workerCall('selectUnits', [ids]) as number[];
    }

    /** Issue an order down the REAL client path (`Connection.sendPlayerCommand`)
     *  — it exercises the optimistic overlay, the pending registry and the wire
     *  encode. Contrast `order()`, which POSTs to the game server's `/api/exec`:
     *  the sim executes it but NO client code runs. */
    async clientOrder(unitIds: number[], cmdId: number,
                      params: number[] = [], opts = 0): Promise<void> {
        await this.deps.workerCall('clientOrder', [unitIds, cmdId, params, opts]);
    }

    // ─── LuaUI widgets ──────────────────────────────────────────────

    /** The in-worker LuaUI widget list, parsed. `[]` until the Lua runtime
     *  boots (it boots after auth + defs, which can take a while on a cold
     *  first run). */
    async widgets(): Promise<WidgetRow[]> {
        return parseWidgetList(await this.deps.workerCall('widgetList') as string);
    }

    /** Enable (re-fetches the widget source, so it doubles as a reload) or
     *  disable a widget by name. Returns the post-change list. */
    async setWidget(name: string, on: boolean): Promise<WidgetRow[]> {
        return parseWidgetList(await this.deps.workerCall('setWidget', [name, on]) as string);
    }

    // ─── Camera input lock + drift guard ────────────────────────────

    /** Lock (or unlock) USER camera input in the worker. Locking also clears
     *  held keys and drags — a CDP-synthesised keydown never gets its keyup,
     *  so without this a measurement run drifts for its whole duration.
     *  Programmatic camera calls keep working while locked. */
    async lockInput(on: boolean): Promise<boolean> {
        return await this.deps.workerCall('lockInput', [on]) as boolean;
    }

    /** Resolve once no animated camera transition is running (worker-side cap
     *  of 10 s), instead of guessing `wait(durationMs + 16)`. */
    async cameraSettle(timeoutMs = 10000): Promise<void> {
        await this.deps.workerCall('cameraSettle', [timeoutMs]);
    }

    /** Run `fn` with camera input locked and the camera settled, and report
     *  how far the pose drifted across it. Poses are read FRESH from the
     *  worker, not from the 10 Hz cached feed. Always unlocks (finally), and
     *  reports drift either way — whether drift invalidates a measurement is
     *  the caller's call. */
    async withStableCamera<T>(fn: () => Promise<T> | T,
        opts: { toleranceElmos?: number } = {},
    ): Promise<{ result: T; drift: CameraDriftReport }> {
        const tol = opts.toleranceElmos ?? 1;
        const pose = async (): Promise<CamPose> =>
            await this.deps.workerCall('cameraPose') as CamPose;
        await this.lockInput(true);
        let before: CamPose;
        let result: T;
        let after: CamPose;
        try {
            await this.cameraSettle();
            before = await pose();
            result = await fn();
        } finally {
            await this.lockInput(false).catch(() => false);
        }
        after = await pose().catch(() => before);
        const d = (a: Vec3, b: Vec3): number =>
            Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        const posDriftElmos = d(before.pos, after.pos);
        const lookAtDriftElmos = d(before.lookAt, after.lookAt);
        const withinTolerance = posDriftElmos <= tol && lookAtDriftElmos <= tol;
        if (!withinTolerance) {
            console.warn(`[test] camera drifted during withStableCamera: `
                + `pos ${posDriftElmos.toFixed(2)} / lookAt `
                + `${lookAtDriftElmos.toFixed(2)} elmos (tolerance ${tol})`);
        }
        return { result, drift: { posDriftElmos, lookAtDriftElmos,
            before, after, withinTolerance } };
    }

    // ─── Composite helpers ──────────────────────────────────────────

    /** Spawn one unit, then focus the camera on it. Returns the unit
     *  ID parsed out of the spawn response.  */
    async spawnAndFocus(defName: string, x: number, z: number, team = 0,
                       opts: { durationMs?: number; height?: number } = {}): Promise<number> {
        const out = await this.spawn(defName, x, z, team, 1);
        // Server response: "spawned 1 unit(s): <id>"
        const m = out.match(/:\s*(\d+)/);
        if (!m) throw new Error(`[test] could not parse spawn output: ${out}`);
        const id = Number(m[1]);
        // The first frame the unit exists in the client cache is one
        // entity-state tick away (~100ms). Wait briefly so the worker's
        // getEntityPosition doesn't return null on the first call.
        await wait(150);
        try {
            await this.focus(id, opts);
        } catch {
            // Fall back to focusing the spawn coordinates if the unit
            // hasn't reached the renderer yet.
            await this.focusOn(x, z, opts.durationMs ?? DEFAULT_FOCUS_MS);
        }
        return id;
    }

    /** Spawn an attacker + a target a short distance apart and order
     *  the attacker to attack. Convenient for combat-FX testing. */
    async stageCombat(attackerDef: string, targetDef: string,
                     x: number, z: number,
                     attackerTeam = 0, targetTeam = 1,
                     separation = 200): Promise<{ attackerId: number; targetId: number }> {
        const aOut = await this.spawn(attackerDef, x - separation / 2, z, attackerTeam, 1);
        const tOut = await this.spawn(targetDef,   x + separation / 2, z, targetTeam, 1);
        const aId = Number(aOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        const tId = Number(tOut.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!aId || !tId) throw new Error(`[test] stageCombat spawn parse failed: ${aOut} / ${tOut}`);
        await wait(150);
        await this.order(aId, 20 /* CMD.ATTACK */, [tId]);
        return { attackerId: aId, targetId: tId };
    }
}

/**
 * Parse the LuaUI handler's pipe-delimited widget list (see lua-ui-host's
 * `getWidgetList`): one line per widget,
 * `status|name|author|basename|error|desc|date|license|layer|enabled|handler`.
 * Empty input (the runtime has not booted) → `[]`.
 */
export function parseWidgetList(raw: string): WidgetRow[] {
    if (!raw) return [];
    const rows: WidgetRow[] = [];
    for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        const f = line.split('|');
        rows.push({
            status: f[0] ?? '', name: f[1] ?? '', author: f[2] ?? '',
            basename: f[3] ?? '', error: f[4] ?? '', desc: f[5] ?? '',
            layer: f[8] ?? '', enabled: f[9] ?? '',
        });
    }
    return rows;
}

function wait(ms: number): Promise<void> {
    return new Promise((res) => window.setTimeout(res, ms));
}
