/**
 * TestHarness — runtime API on `window.test` for automated and manual
 * testing of the in-game client. Pairs with the server-side `server`
 * exec scope verbs (spawn / kill / damage / order / log) and the
 * spring-debug MCP `test_*` tool family.
 *
 * Two halves:
 *   - server-bound: `spawn`, `order`, `kill`, `damage`, `clear`, `log`,
 *     `state`, `units`, `unitState` — all proxy through
 *     `lobby.lobbyPost('/api/exec', …)` so they go through the same
 *     auth + scope routing as the debug console.
 *   - client-bound: `focus`, `pause`, `resume`, `screenshot`, `select`,
 *     `selection` — read/write local renderer/camera/scene state.
 *
 * Tests are expected to run after `startGame()` has wired up the camera
 * and entity renderer; `window.test` is replaced by a fresh instance on
 * every `startGame()` call and torn down by `quitToLobby()`.
 */

import * as BABYLON from '@babylonjs/core';
import type { Engine, Scene } from '@babylonjs/core';
import type { RTSCamera } from './rts-camera.js';
import type { EntityRenderer } from './entity-renderer.js';
import type { Connection } from './connection.js';
import type { InputManager } from './input-manager.js';
import type { LobbyUI } from '../lobby/lobby-ui.js';

/** A minimal subset of the lobby UI needed for `/api/exec` requests. */
export interface TestLobbyHandle {
    lobbyPost(path: string, body?: Record<string, unknown>): Promise<unknown>;
    token: string;
}

export interface TestHarnessDeps {
    engine: Engine;
    scene: Scene;
    camera: RTSCamera;
    entityRenderer: EntityRenderer | null;
    connection: Connection;
    inputManager: InputManager | null;
    lobby: TestLobbyHandle;
    /** Called when pause()/resume() flips state — main.ts uses this to
     *  short-circuit its render loop. */
    setPaused: (paused: boolean) => void;
    isPaused: () => boolean;
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

    constructor(deps: TestHarnessDeps) {
        this.deps = deps;
    }

    // ─── Server scope: structured exec helpers ───────────────────────
    //
    // Exec routing — the lobby's `/api/exec` only handles `sql` and
    // `lobby` scopes; `server`, `LuaRules`, `LuaGaia`, and `LuaAI:*`
    // live on the game server's HTTP listener. We POST to the game
    // server URL directly (Connection exposes `gameHttpUrl`) with the
    // lobby's auth token (the game server validates it against the
    // shared SQLite user table).

    private async execOnGameServer(scope: string, code: string): Promise<ExecResult> {
        const base = this.deps.connection.gameHttpUrl;
        if (!base) throw new Error('[test] connection.gameHttpUrl not set — game server not connected?');
        const resp = await fetch(`${base}/api/exec`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.deps.lobby.token}`,
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

    // ─── Camera ─────────────────────────────────────────────────────

    /** Move the camera to look down at the unit's current (interpolated)
     *  position. Resolves once the animation completes. */
    async focus(unitId: number, opts: { durationMs?: number; height?: number } = {}): Promise<void> {
        if (!this.deps.entityRenderer) throw new Error('[test] no entityRenderer');
        const pos = this.deps.entityRenderer.getEntityPosition(unitId);
        if (!pos) throw new Error(`[test] no client-side position for unit ${unitId}`);
        const dur = opts.durationMs ?? DEFAULT_FOCUS_MS;
        const h = opts.height ?? DEFAULT_FOCUS_HEIGHT;
        // Look-at lands on the unit; camera sits `h` elmos directly above.
        // We use lookAtPosition which keeps the current view distance, so
        // bump the camera high first via setCameraHeight.
        this.setCameraHeight(h);
        this.deps.camera.lookAtPosition(pos.x, pos.y, pos.z, dur);
        if (dur > 0) await wait(dur + 16);
    }

    /** Move the camera to (x, z). Resolves once the animation completes. */
    async focusOn(x: number, z: number, durationMs = DEFAULT_FOCUS_MS): Promise<void> {
        this.deps.camera.focusOn(x, z, durationMs);
        if (durationMs > 0) await wait(durationMs + 16);
    }

    /** Force the camera to a specific height above the look-at target.
     *  Instant. Used by `focus()` to standardise top-down framing. */
    setCameraHeight(height: number): void {
        const pos = this.deps.camera.position;
        const tgt = this.deps.camera.target;
        const dy = height - (pos.y - tgt.y);
        this.deps.camera.lookAtPosition(tgt.x, tgt.y, tgt.z, 0);
        // RTSCamera doesn't expose a direct height setter — re-establish
        // by translating the camera up by `dy`. Save+restore round-trips
        // through the public API.
        const view = this.deps.camera.saveView();
        view.pos.y += dy;
        this.deps.camera.restoreView(view, 0);
    }

    // ─── Programmatic camera API — mirrors window.camera ───────────────
    //
    // Tests routinely want a *precise* camera pose ("look at unit X from
    // 200 elmos south at 40° pitch") rather than RTSCamera's
    // ergonomic-but-fuzzy `focusOn`. These methods forward straight to
    // the underlying RTSCamera primitives so the harness, JS console and
    // Lua bridge all behave identically. All accept the same shapes as
    // `window.camera.*`.

    /** Get the current camera pose ({pos, lookAt} of {x,y,z}). */
    cameraPose(): { pos: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } } {
        return this.deps.camera.getPose();
    }

    /** Set the camera to a specific pose. */
    async setCameraPose(pose: { pos: { x: number; y: number; z: number }; lookAt: { x: number; y: number; z: number } }, durationMs = 0): Promise<void> {
        this.deps.camera.setPose(pose, durationMs);
        if (durationMs > 0) await wait(durationMs + 16);
    }

    /** Orbit around the current look-at. opts: {yawDeg?, pitchDeg?, distance?, durationMs?} */
    async cameraOrbit(opts: { yawDeg?: number; pitchDeg?: number; distance?: number; durationMs?: number } = {}): Promise<void> {
        this.deps.camera.orbit(opts);
        const d = opts.durationMs ?? 0;
        if (d > 0) await wait(d + 16);
    }

    /** Look at a unit by ID — uses the entityRenderer's interpolated
     *  client position. opts: {height?, pitchDeg?, durationMs?} */
    async cameraSnapToUnit(unitId: number, opts: { height?: number; pitchDeg?: number; durationMs?: number } = {}): Promise<void> {
        if (!this.deps.entityRenderer) throw new Error('[test] no entityRenderer');
        const p = this.deps.entityRenderer.getEntityPosition(unitId);
        if (!p) throw new Error(`[test] no client-side position for unit ${unitId}`);
        this.deps.camera.snapToGround(p.x, p.z, opts);
        const d = opts.durationMs ?? 0;
        if (d > 0) await wait(d + 16);
    }

    /** Look at a ground point. opts: {height?, pitchDeg?, durationMs?} */
    async cameraSnapToGround(x: number, z: number, opts: { height?: number; pitchDeg?: number; durationMs?: number } = {}): Promise<void> {
        this.deps.camera.snapToGround(x, z, opts);
        const d = opts.durationMs ?? 0;
        if (d > 0) await wait(d + 16);
    }

    /** Top-down view of the entire map. */
    async cameraFitMap(opts: { padding?: number; pitchDeg?: number; durationMs?: number } = {}): Promise<void> {
        this.deps.camera.fitMap(opts);
        const d = opts.durationMs ?? 0;
        if (d > 0) await wait(d + 16);
    }

    /** Programmatically toggle the player-facing tracking camera (the
     *  `T` hotkey). When on, the camera re-fits the current selection
     *  every frame. Scenarios use this to start in tracking mode
     *  without needing the user to press the key. */
    setTrackingCamera(on: boolean): void {
        this.deps.inputManager?.setTrackingCamera(on);
    }

    /** Frame all of `unitIds` so they sit inside the vertical FOV. Used
     *  by SFX/effects benches to keep both shooter and target visible
     *  through projectile travel — the camera tilts to `pitchDeg`
     *  (default 55°, side-on enough to see arcs) and distances out
     *  according to the units' bounding box. Units that the renderer
     *  doesn't yet know about are silently skipped. */
    async cameraFitUnits(unitIds: number[], opts: {
        padding?: number;
        pitchDeg?: number;
        durationMs?: number;
        minDistance?: number;
    } = {}): Promise<void> {
        if (!this.deps.entityRenderer) throw new Error('[test] no entityRenderer');
        const pts: { x: number; y: number; z: number }[] = [];
        for (const id of unitIds) {
            const p = this.deps.entityRenderer.getEntityPosition(id);
            if (p) pts.push(p);
        }
        if (pts.length === 0) return;
        this.deps.camera.fitPoints(pts, opts);
        const d = opts.durationMs ?? 0;
        if (d > 0) await wait(d + 16);
    }

    /** Save the current pose into a numbered slot. */
    cameraSaveSlot(slot: number): void { this.deps.camera.saveSlot(slot); }
    /** Recall a numbered slot. Returns false when empty. */
    async cameraLoadSlot(slot: number, durationMs = 0): Promise<boolean> {
        const ok = this.deps.camera.loadSlot(slot, durationMs);
        if (ok && durationMs > 0) await wait(durationMs + 16);
        return ok;
    }

    // ─── Render-loop pause + screenshots ────────────────────────────

    /** Stop the render loop. Sim continues on the server unless you
     *  also call `simPause()`. The frozen frame remains visible so
     *  you can take a screenshot at a deterministic moment. */
    pause(): void { this.deps.setPaused(true); }
    resume(): void { this.deps.setPaused(false); }
    get paused(): boolean { return this.deps.isPaused(); }

    /** Capture the current canvas as a PNG. Returns a data-URL.
     *  Use `download(url, name)` if you also want it written to disk
     *  via the browser. The canvas was created with
     *  `preserveDrawingBuffer: true` so this works without re-render. */
    screenshot(): string {
        const canvas = this.deps.engine.getRenderingCanvas();
        if (!canvas) throw new Error('[test] no rendering canvas');
        return canvas.toDataURL('image/png');
    }

    /** Save the current canvas to a downloaded PNG file. Triggers a
     *  browser download to `<filename>.png` (default: `spring-test-<ts>.png`). */
    saveScreenshot(filename?: string): string {
        const url = this.screenshot();
        const a = document.createElement('a');
        a.href = url;
        a.download = filename ?? `spring-test-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return url;
    }

    /** Babylon's built-in screenshot helper — writes a PNG of the
     *  scene at a chosen resolution (independent of canvas size). */
    async highResScreenshot(width = 1920, height = 1080): Promise<string> {
        const camera = this.deps.scene.activeCamera;
        if (!camera) throw new Error('[test] no active camera');
        return new Promise((resolve) => {
            BABYLON.Tools.CreateScreenshotUsingRenderTarget(
                this.deps.engine, camera, { width, height },
                (data) => resolve(data),
            );
        });
    }

    // ─── Selection helpers ──────────────────────────────────────────

    /** Replace the client selection with the given unit IDs. */
    select(unitIds: number[]): void {
        this.deps.inputManager?.setSelectionFromWidget(unitIds);
    }

    /** Read-only snapshot of currently selected unit IDs. */
    get selection(): readonly number[] {
        return this.deps.inputManager?.selection ?? [];
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
        // entity-state tick away (~100ms). Wait briefly so getEntityPosition
        // doesn't return null on the first call.
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
