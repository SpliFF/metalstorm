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

    /** Scene-wide wireframe toggle (F8 panel render group). */
    setWireframe(on: boolean): void {
        void this.deps.workerCall('setWireframe', [on]);
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

    /** Play one authored clip on the unit (loops by default; one playback
     *  at a time). Returns the playback state. Throws when the clip is
     *  unknown or the model hasn't loaded. */
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

    /** Stop the current clip playback; the unit returns to rest pose /
     *  server-streamed piece state. */
    async stopClip(): Promise<void> {
        await this.deps.workerCall('stopClip');
    }

    /** Current playback state, or null when nothing is playing. */
    async clipState(): Promise<unknown> {
        return this.deps.workerCall('clipState');
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

    /** High-resolution screenshot. DEFERRED in GW8 — the RTT screenshot
     *  helper (BABYLON.Tools.CreateScreenshotUsingRenderTarget) needs the
     *  engine + camera, which are in the worker; not yet wired for a custom
     *  resolution. Falls back to the canvas-resolution `screenshot()`. */
    async highResScreenshot(width = 1920, height = 1080): Promise<string> {
        void width; void height;
        return this.screenshot();
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

function wait(ms: number): Promise<void> {
    return new Promise((res) => window.setTimeout(res, ms));
}
