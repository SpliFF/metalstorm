/**
 * model-viewer — interactive model/animation test harness
 * (PLAN-model-harness). Boots the bench map, spawns one chosen unit
 * centre-stage ("the pedestal") and exercises everything it can visually
 * do from a derived button panel (F8), with an orbit camera and a sun
 * control. Capture presets turn it into the beta-units / PoC judgment
 * loop.
 *
 *   ?scenario=model-viewer&game=zk&def=cormaw
 *   ?scenario=model-viewer&game=papertanks&def=pt_lighttank
 *   ?scenario=model-viewer&game=zk&def=cormaw&capture=turntable&views=16
 *
 * Params: `game` (default: sticky dev game id, else zk), `def` (initial
 * unit; optional in interactive mode — the panel has a picker), `map`
 * (default green_flat_x34_v3), `capture` = turntable | clips | sun,
 * `views` (turntable headings, default 8), `download=0` (manifest only).
 *
 * Progress + results land on `window.modelViewer` (state / captures /
 * api) for MCP-driven runs.
 */

import type { AssertionResult, Scenario } from '../types.js';
import { sleep } from '../types.js';
import type { TestHarness } from '../../core/test-harness.js';
import {
    deriveShowcases,
    parseTransporteeProbe,
    pickTransporteeFallback,
    probeFromDef,
    transporteeProbeLua,
    unquoteExec,
    type CapabilityProbe,
    type DefWireLike,
    type ShowcaseId,
} from './capability-probe.js';
import {
    resetStage,
    runShowcase,
    unitAlive,
    type ModelViewerState,
    type StageContext,
} from './routines.js';
import {
    expectedCaptureCount,
    runCapture,
    type CaptureEntry,
    type CapturePreset,
} from './capture.js';
import { createModelViewerPanel, type ModelViewerPanel } from './panel.js';

// Map metrics: green_flat_x34_v3 is 17408×17408 elmos, completely flat.
const MAP_CENTER = 8704;

function param(name: string): string | null {
    return new URLSearchParams(location.search).get(name);
}

function numParam(name: string, fallback: number): number {
    const v = Number(param(name));
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

declare global {
    interface Window {
        modelViewer?: {
            state: ModelViewerState;
            captures: CaptureEntry[];
            api: {
                respawn(def?: string): Promise<number>;
                run(id: ShowcaseId): void;
                stopReset(): Promise<void>;
                capture(preset: CapturePreset): void;
                /** Toggle an authored clip (task 6): play if stopped,
                 *  stop if it is the one playing. */
                playClip(name: string): void;
            };
        };
    }
}

class ModelViewerStage implements StageContext {
    h: TestHarness;
    center = { x: MAP_CENTER, z: MAP_CENTER };
    probe: CapabilityProbe | null = null;
    transportee: string | null = null;
    state: ModelViewerState = {
        phase: 'booting',
        def: null,
        team: 0,
        stageUnitId: null,
        showcases: [],
        running: null,
        clips: [],
        playingClip: null,
        badge: null,
        lastError: null,
        slowMo: false,
    };
    captures: CaptureEntry[] = [];

    private panel: ModelViewerPanel | null = null;
    private luaDefNames: string[] | null = null;
    private capturePreset: CapturePreset | null;

    constructor(h: TestHarness, capturePreset: CapturePreset | null) {
        this.h = h;
        this.capturePreset = capturePreset;
    }

    notify = (): void => {
        this.panel?.refresh();
    };

    async boot(initialDef: string | null): Promise<void> {
        window.modelViewer = {
            state: this.state,
            captures: this.captures,
            api: {
                respawn: (def?: string) => this.respawn(def),
                run: (id: ShowcaseId) => { void runShowcase(this, id).catch(() => { /* surfaced via state.lastError */ }); },
                stopReset: () => resetStage(this),
                capture: (preset: CapturePreset) => {
                    void runCapture(this, preset, {
                        views: numParam('views', 8),
                        download: param('download') !== '0',
                    }).then((entries) => this.captures.push(...entries));
                },
                playClip: (name: string) => {
                    void this.toggleClip(name).catch(() => { /* surfaced via state.lastError */ });
                },
            },
        };

        await this.h.simSpeed(1).catch(() => { /* best-effort */ });
        if (initialDef) {
            try {
                await this.respawn(initialDef);
            } catch (err) {
                // A bad &def= must not kill the panel — it's the only
                // interactive recovery path (live-found: stale def names).
                // Capture mode still fails its capture-def assertion.
                this.state.badge = `spawn failed: ${(err as Error).message}`;
                this.state.lastError = (err as Error).message;
            }
        }

        if (!this.capturePreset) {
            this.panel = createModelViewerPanel({
                h: this.h,
                state: this.state,
                listAllDefNames: () => this.listAllDefNames(),
                respawn: (def?: string) => this.respawn(def),
                run: (id: ShowcaseId) => window.modelViewer!.api.run(id),
                stopReset: () => resetStage(this),
                capture: (preset: CapturePreset) => window.modelViewer!.api.capture(preset),
                playClip: (name: string) => window.modelViewer!.api.playClip(name),
                reorbit: async () => {
                    const id = this.state.stageUnitId;
                    if (id) await this.h.orbit(id, { follow: true });
                },
            });
        }
        this.state.phase = 'ready';
        this.notify();
    }

    /** Clear the stage and spawn `def` (or the current def) centre-stage;
     *  probe capabilities, re-anchor the orbit rig, run the E1 model
     *  check. Returns the new stage unit id. */
    async respawn(def?: string): Promise<number> {
        const name = (def ?? this.state.def)?.trim();
        if (!name) throw new Error('no def selected — pass &def= or pick one in the panel');
        // Task 6: a looping clip must not survive the respawn (the old
        // unit id dies with the clear; the player would auto-stop anyway,
        // but the panel state has to agree).
        await this.h.stopClip().catch(() => { /* clip player may be idle */ });
        this.state.playingClip = null;
        this.state.clips = [];
        await this.h.clear().catch(() => { /* empty board is fine */ });
        await sleep(150);
        this.state.badge = null;
        this.state.lastError = null;
        const out = await this.h.spawn(name, this.center.x, this.center.z, 0, 1);
        const id = Number(out.match(/:\s*(\d+)/)?.[1] ?? 0);
        if (!id) throw new Error(`spawn parse failed for ${name}: ${out}`);
        this.state.def = name;
        this.state.stageUnitId = id;
        this.notify();
        await sleep(300); // first entity-state tick

        const wire = await this.pollDefWire(name, 10000);
        this.probe = wire ? probeFromDef(wire) : null;
        this.state.showcases = this.probe ? deriveShowcases(this.probe) : [];
        if (!this.probe) this.state.badge = 'def not streamed — probe unavailable';
        await this.probeTransportee(name);

        // The server filters entity state by viewport. If the camera (and
        // so the viewport) isn't over the pedestal — first spawn, or a rig
        // stuck on its origin fallback after a failed spawn — the fresh
        // stage unit never streams, and orbiting it would anchor at the
        // fallback forever (a deadlock: the anchored-away camera keeps the
        // unit out of the viewport). Snap the camera to the pedestal and
        // wait for the first entity tick before entering the rig.
        //
        // Retry loop (cold-boot race guard): even with the runner's
        // connection gate, a viewport update can be dropped if it races the
        // first authenticated frame. Re-snap the camera + wait a few times —
        // this is exactly what a manual "Respawn" click does, automated and
        // bounded. Each pass re-sends the viewport once the stream is live.
        if (!(await this.h.entityBounds(id).catch(() => null))) {
            let streamed = false;
            for (let attempt = 0; attempt < 4 && !streamed; attempt++) {
                await this.h.orbitStop().catch(() => { /* rig may be off */ });
                await this.h.focusOn(this.center.x, this.center.z, 0)
                    .catch(() => { /* camera may not be ready */ });
                streamed = await this.waitStreamed(id, 3000);
            }
            if (!streamed) {
                // Accurate diagnosis: the unit exists server-side (spawn
                // returned an id) but never streamed to the worker. Ask the
                // connection what actually went wrong rather than letting it
                // masquerade as a model-load timeout downstream.
                this.state.badge = await this.diagnoseNoStream(id);
                this.state.lastError = this.state.badge;
                this.notify();
            }
        }
        await this.h.orbit(id, { follow: true }).catch(() => { /* camera may lag the spawn */ });

        // E1: fallback-shape badge. Capture mode must wait for the verdict
        // (a turntable of a placeholder cube IS the test outcome — badge it);
        // interactive mode polls in the background.
        const badgePoll = this.pollModelBadge(id);
        if (this.capturePreset) await badgePoll;
        this.notify();
        return id;
    }

    /** Streamed defs + sim-side UnitDefs name dump, merged for the picker
     *  (§1: DefCache once defs stream, plus test.lua for not-yet-
     *  encountered defs). */
    async listAllDefNames(): Promise<{ name: string; humanName?: string }[]> {
        const streamed = await this.h.listUnitDefs().catch(() => []);
        if (!this.luaDefNames) {
            try {
                const out = await this.h.lua(
                    'local t = {} for id, d in pairs(UnitDefs) do t[#t+1] = d.name end '
                    + 'table.sort(t) return table.concat(t, ",")');
                this.luaDefNames = unquoteExec(out).split(',').filter(Boolean);
            } catch {
                this.luaDefNames = [];
            }
        }
        const byName = new Map<string, { name: string; humanName?: string }>();
        for (const n of this.luaDefNames) byName.set(n, { name: n });
        for (const d of streamed) byName.set(d.name, { name: d.name, humanName: d.humanName });
        return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    }

    /** Wait until the worker has entity state for `id` (the server only
     *  streams entities inside the viewport). */
    private async waitStreamed(id: number, timeoutMs: number): Promise<boolean> {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            if (await this.h.entityBounds(id).catch(() => null)) return true;
            await sleep(300);
        }
        return false;
    }

    private async pollDefWire(name: string, timeoutMs: number): Promise<DefWireLike | null> {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            const d = await this.h.unitDefByName(name).catch(() => null);
            if (d) return d as unknown as DefWireLike;
            await sleep(400);
        }
        return null;
    }

    /** §2 transport row: transportee picked via the sim's own def rules
     *  (test.lua probe); streamed-def fallback only if the probe fails. */
    private async probeTransportee(name: string): Promise<void> {
        this.transportee = null;
        if (!this.probe || this.probe.transportCapacity <= 0) return;
        try {
            this.transportee = parseTransporteeProbe(await this.h.lua(transporteeProbeLua(name)));
        } catch { /* fall through */ }
        if (!this.transportee) {
            const defs = await this.h.listUnitDefs().catch(() => []);
            this.transportee = pickTransporteeFallback(defs, {
                transportMass: this.probe.transportMass,
                transportSize: this.probe.transportSize,
            });
        }
    }

    private async pollModelBadge(unitId: number): Promise<void> {
        const deadline = performance.now() + 60000;
        let everStreamed = false;
        while (performance.now() < deadline) {
            if (this.state.stageUnitId !== unitId) return; // stage moved on
            const b = await this.h.entityBounds(unitId).catch(() => null);
            if (b) everStreamed = true;
            if (b?.hasModel === true) {
                await this.loadClips(unitId);
                return;
            }
            if (b?.hasModel === false) {
                this.state.badge = 'fallback-model';
                this.notify();
                return;
            }
            await sleep(500);
        }
        // Accurate timeout: only call it a "model" timeout if the entity
        // actually streamed and its model just never finished loading (a real
        // texture/geometry stall). If the entity never streamed at all, it's a
        // connection/viewport problem — name that, so it stops masquerading as
        // a model failure (the trap that cost a whole colossus debug session).
        this.state.badge = everStreamed
            ? 'model-load-timeout — entity streamed but its model never loaded (stuck KTX2/geometry?)'
            : await this.diagnoseNoStream(unitId);
        this.notify();
    }

    /** Explain why unit `id` never streamed to the worker — a connection /
     *  viewport problem, not a model failure. Reads the worker game-connection
     *  state so the badge names the real cause instead of "model timeout". */
    private async diagnoseNoStream(id: number): Promise<string> {
        const c = await this.h.gameConnected().catch(() => null);
        if (!c) return `unit ${id} never streamed — worker connection state unavailable`;
        if (c.authFailed) return `unit ${id} never streamed — worker game connection auth FAILED: ${c.authFailed}`;
        if (!c.authenticated) return `unit ${id} never streamed — worker game connection not authenticated (never connected?)`;
        if (!c.receivedState) return `unit ${id} never streamed — connection authenticated but NO entity state received (viewport/stream issue)`;
        return `unit ${id} never streamed — connection is live + streaming other state; the unit may be outside the viewport`;
    }

    /** Task 6: once the model is in, surface its authored clip list
     *  (empty for every converted S3O/DAE model — buttons only appear
     *  for native glTF assets that ship clips). */
    private async loadClips(unitId: number): Promise<void> {
        const clips = await this.h.listClips(unitId).catch(() => null);
        if (this.state.stageUnitId !== unitId) return; // stage moved on
        this.state.clips = clips ?? [];
        this.notify();
    }

    /** Task 6 panel/API entry: toggle an authored clip on the stage unit. */
    async toggleClip(name: string): Promise<void> {
        const id = this.state.stageUnitId;
        if (!id) throw new Error('no stage unit — pick a def / respawn first');
        try {
            if (this.state.playingClip === name) {
                await this.h.stopClip();
                this.state.playingClip = null;
            } else {
                await this.h.playClip(id, name, { loop: true });
                this.state.playingClip = name;
            }
            this.state.lastError = null;
        } catch (err) {
            this.state.playingClip = null;
            this.state.lastError = (err as Error).message;
            throw err;
        } finally {
            this.notify();
        }
    }
}

let stage: ModelViewerStage | null = null;

const scenario: Scenario = {
    name: 'model-viewer',
    description: 'Interactive model/animation harness: one unit centre-stage, derived showcase '
        + 'buttons (F8 panel), orbit camera, sun control, capture presets (PLAN-model-harness).',
    map: param('map') ?? 'green_flat_x34_v3',
    gameId: param('game') ?? localStorage.getItem('springrts-game-id') ?? 'zk',
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: 0,

    async setup(h: TestHarness): Promise<void> {
        const preset = param('capture') as CapturePreset | null;
        if (preset && !['turntable', 'clips', 'sun'].includes(preset)) {
            throw new Error(`unknown capture preset "${preset}" (turntable | clips | sun)`);
        }
        stage = new ModelViewerStage(h, preset);
        await stage.boot(param('def'));
    },

    async run(h: TestHarness): Promise<AssertionResult[]> {
        const results: AssertionResult[] = [];
        const s = stage!;
        const preset = param('capture') as CapturePreset | null;

        if (preset) {
            if (!s.state.def) {
                return [{ name: 'capture-def', ok: false, detail: 'capture mode needs &def=<name>' }];
            }
            const views = numParam('views', 8);
            const entries = await runCapture(s, preset, {
                views,
                download: param('download') !== '0',
            });
            s.captures.push(...entries);
            const expected = expectedCaptureCount(
                preset, views, s.state.showcases.map((x) => x.id));
            results.push({
                name: `capture-${preset}-count`,
                ok: entries.length === expected,
                detail: `${entries.length}/${expected} frames`,
            });
            results.push({
                name: 'capture-frames-nonempty',
                ok: entries.every((e) => e.dataUrl.startsWith('data:image/png') && e.dataUrl.length > 1000),
            });
            s.state.phase = 'done';
        } else {
            results.push({
                name: 'panel-up',
                ok: document.getElementById('model-viewer-panel') !== null,
            });
        }

        if (s.state.def) {
            results.push({
                name: 'stage-unit-alive',
                ok: s.state.stageUnitId !== null
                    && await unitAlive(h, s.state.stageUnitId),
                detail: `unit ${s.state.stageUnitId}`,
            });
            results.push({
                name: 'capability-probe',
                ok: s.state.showcases.length > 0,
                detail: s.state.showcases.map((x) => x.id).join(','),
            });
            results.push({
                name: 'orbit-rig-active',
                ok: (await h.orbitState().catch(() => null)) !== null,
            });
            results.push({
                name: 'model-not-fallback',
                ok: s.state.badge !== 'fallback-model',
                detail: s.state.badge ?? 'model ok',
            });
        }
        return results;
    },
};

export default scenario;
