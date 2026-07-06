/**
 * model-viewer — interactive model/animation test harness
 * (PLAN-model-harness). Boots the bench map, spawns one chosen unit
 * centre-stage ("the pedestal") and exercises everything it can visually
 * do from a derived button panel (F8), with an orbit camera and a sun
 * control. Capture presets turn it into the beta-units / PoC judgment
 * loop.
 *
 *   ?scenario=model-viewer&game=zk&def=cormaw
 *   ?scenario=model-viewer&game=papertanks&def=lighttank
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
            },
        };

        await this.h.simSpeed(1).catch(() => { /* best-effort */ });
        if (initialDef) await this.respawn(initialDef);

        if (!this.capturePreset) {
            this.panel = createModelViewerPanel({
                h: this.h,
                state: this.state,
                listAllDefNames: () => this.listAllDefNames(),
                respawn: (def?: string) => this.respawn(def),
                run: (id: ShowcaseId) => window.modelViewer!.api.run(id),
                stopReset: () => resetStage(this),
                capture: (preset: CapturePreset) => window.modelViewer!.api.capture(preset),
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
                this.luaDefNames = out.trim().split(',').filter(Boolean);
            } catch {
                this.luaDefNames = [];
            }
        }
        const byName = new Map<string, { name: string; humanName?: string }>();
        for (const n of this.luaDefNames) byName.set(n, { name: n });
        for (const d of streamed) byName.set(d.name, { name: d.name, humanName: d.humanName });
        return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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
        const deadline = performance.now() + 12000;
        while (performance.now() < deadline) {
            if (this.state.stageUnitId !== unitId) return; // stage moved on
            const b = await this.h.entityBounds(unitId).catch(() => null);
            if (b?.hasModel === true) return;
            if (b?.hasModel === false) {
                this.state.badge = 'fallback-model';
                this.notify();
                return;
            }
            await sleep(500);
        }
        this.state.badge = 'model-load-timeout (still loading after 12 s)';
        this.notify();
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
