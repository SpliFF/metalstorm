/**
 * fx-viewer — interactive SFX test harness for the Metalstorm native FX set
 * (data/games/metalstorm/shaders/fx + effects/). The SFX sibling of
 * model-viewer (PLAN-model-harness): boot the bench map, put ONE effect on
 * the stage, and exercise it from an F8 panel with a menu + ◀ ▶ cycling.
 *
 *   ?scenario=fx-viewer                                  first impact effect
 *   ?scenario=fx-viewer&effect=expl_medium               pick effect
 *   ?scenario=fx-viewer&shader=tracer                    solo one shader program;
 *                                                        menu filters to effects
 *                                                        that use it
 *   ?scenario=fx-viewer&effect=tracer_railgun&mode=projectile
 *   ?scenario=fx-viewer&mode=loop&interval=0.4           continuous re-fire
 *
 * Params:
 *   `shader`   particle | muzzleFlash | tracer | trail | shockwave — the
 *              shader under test: menu filters to effects using it AND the
 *              stage draws only that program (solo).
 *   `mode`     impact | muzzle | projectile | loop — how the effect is used
 *              (default: derived from the effect's authored `usage`).
 *   `effect`   initial library.json effect name.
 *   `interval` auto-fire period in seconds (default 1.6; loop mode 0.6).
 *   `game`     game id carrying the FX content (default metalstorm).
 *   `fxbase`   HTTP base for the FX assets when the VFS path is unavailable.
 *
 * Selection / mode / shader changes rewrite the URL (history.replaceState)
 * so any panel state is shareable — the same deep-link discipline as the
 * capture presets. ◀ ▶ arrow keys (and panel buttons) cycle the filtered
 * effect list; Space fires.
 *
 * RENDERING NOTE (why the stage is an overlay): the game's Babylon scene and
 * renderers live in the game-processor worker (gpCtx) and the worker has no
 * native-FX loader until the Stage-7 engine ask lands. The stage therefore
 * runs the REAL authored GLSL through core/native-fx/* (the loader's
 * reference implementation) on a main-thread overlay — an isolated pedestal,
 * same philosophy as model-viewer. The game boots underneath and stays
 * reachable ("hide stage" in the panel / api.setStageVisible(false)).
 *
 * Asset fetch order: (1) sim-side VFS via test.lua VFS.LoadFile — the game
 * archive is the source of truth; hex-armoured against exec-channel
 * mangling; (2) HTTP fallback from `fxbase`. Origin is surfaced in the
 * panel and in window.fxViewer.state.sourceOrigin.
 *
 * Progress + results land on `window.fxViewer` (state / api) for MCP runs.
 */

import type { AssertionResult, Scenario } from '../types.js';
import type { TestHarness } from '../../core/test-harness.js';
import {
    defaultModeForUsage,
    effectsUsingShader,
    resolveEffect,
    SHADER_KINDS,
    type FxLibrary,
    type ShaderKind,
} from '../../core/native-fx/effect-compiler.js';
import { NATIVE_FX_SHADER_FILES, type NativeFxSources } from '../../core/native-fx/native-fx-renderer.js';
import { FxStage, type FxStageMode } from '../../core/native-fx/fx-stage.js';
import { createFxViewerPanel, type FxViewerPanel } from './panel.js';

const FX_GAME_DEFAULT = 'metalstorm';
const MODES: readonly FxStageMode[] = ['impact', 'muzzle', 'projectile', 'loop'];

function param(name: string): string | null {
    return new URLSearchParams(location.search).get(name);
}

export interface FxViewerState {
    phase: 'booting' | 'loading-fx' | 'ready' | 'error';
    sourceOrigin: 'vfs' | 'http' | null;
    effect: string | null;
    /** Effect names after the ?shader= filter — the menu/cycling list. */
    effects: string[];
    shader: ShaderKind | null;
    mode: FxStageMode;
    autoFire: boolean;
    intervalSec: number;
    lastError: string | null;
}

declare global {
    interface Window {
        fxViewer?: {
            state: FxViewerState;
            api: {
                fire(): void;
                next(): void;
                prev(): void;
                select(effect: string): void;
                setMode(mode: FxStageMode): void;
                setShader(shader: ShaderKind | null): void;
                setAutoFire(on: boolean): void;
                setStageVisible(on: boolean): void;
            };
        };
    }
}

class FxViewerHarness {
    h: TestHarness;
    stage: FxStage | null = null;
    lib: FxLibrary | null = null;
    state: FxViewerState = {
        phase: 'booting',
        sourceOrigin: null,
        effect: null,
        effects: [],
        shader: null,
        mode: 'impact',
        autoFire: true,
        intervalSec: 1.6,
        lastError: null,
    };
    private panel: FxViewerPanel | null = null;
    private fireTimer = 0;
    private explicitMode = false;   // ?mode= given → don't re-derive per effect

    constructor(h: TestHarness) {
        this.h = h;
    }

    notify = (): void => {
        this.panel?.refresh();
    };

    async boot(): Promise<void> {
        // URL param intake (validated; junk falls back loudly in the panel).
        const shaderP = param('shader');
        if (shaderP) {
            if ((SHADER_KINDS as readonly string[]).includes(shaderP)) {
                this.state.shader = shaderP as ShaderKind;
            } else {
                this.state.lastError = `unknown shader "${shaderP}" (${SHADER_KINDS.join(' | ')})`;
            }
        }
        const modeP = param('mode');
        if (modeP) {
            if ((MODES as readonly string[]).includes(modeP)) {
                this.state.mode = modeP as FxStageMode;
                this.explicitMode = true;
            } else {
                this.state.lastError = `unknown mode "${modeP}" (${MODES.join(' | ')})`;
            }
        }
        const iv = Number(param('interval'));
        this.state.intervalSec = Number.isFinite(iv) && iv > 0.05 ? iv
            : (this.state.mode === 'loop' ? 0.6 : 1.6);

        window.fxViewer = {
            state: this.state,
            api: {
                fire: () => this.fire(),
                next: () => this.cycle(1),
                prev: () => this.cycle(-1),
                select: (e) => this.select(e),
                setMode: (m) => this.setMode(m),
                setShader: (s) => this.setShader(s),
                setAutoFire: (on) => this.setAutoFire(on),
                setStageVisible: (on) => this.stage?.setVisible(on),
            },
        };

        // ── fetch the FX content (VFS → HTTP) ───────────────────────────────
        this.state.phase = 'loading-fx';
        this.notify();
        const { sources, library, origin } = await this.loadFxAssets();
        this.lib = library;
        this.state.sourceOrigin = origin;

        // ── stage + panel ────────────────────────────────────────────────────
        this.stage = new FxStage({ sources, library });
        this.stage.mode = this.state.mode;
        this.stage.solo = this.state.shader;

        this.rebuildEffectList();
        const initial = param('effect');
        if (initial && this.state.effects.includes(initial)) {
            this.select(initial, true);
        } else {
            if (initial) this.state.lastError = `effect "${initial}" not in the filtered list`;
            if (this.state.effects.length) this.select(this.state.effects[0], true);
        }

        this.panel = createFxViewerPanel(this);
        this.bindKeys();
        this.setAutoFire(this.state.autoFire);
        this.state.phase = 'ready';
        this.notify();
    }

    // ── selection & cycling ──────────────────────────────────────────────────

    rebuildEffectList(): void {
        if (!this.lib) return;
        this.state.effects = effectsUsingShader(this.lib, this.state.shader);
    }

    select(effect: string, skipUrl = false): void {
        if (!this.lib || !this.stage) return;
        try {
            const { def } = resolveEffect(this.lib, effect);
            this.state.effect = effect;
            if (!this.explicitMode) {
                this.state.mode = defaultModeForUsage(def.usage);
                this.stage.mode = this.state.mode;
            }
            this.stage.frameForMode();
            this.state.lastError = null;
            if (!skipUrl) this.syncUrl();
            this.fire();
        } catch (err) {
            this.state.lastError = (err as Error).message;
        }
        this.notify();
    }

    cycle(step: 1 | -1): void {
        const list = this.state.effects;
        if (!list.length) return;
        const cur = this.state.effect ? list.indexOf(this.state.effect) : -1;
        const next = ((cur + step) % list.length + list.length) % list.length;
        this.select(list[next]);
    }

    setMode(mode: FxStageMode): void {
        this.state.mode = mode;
        this.explicitMode = true;
        if (this.stage) {
            this.stage.mode = mode;
            this.stage.frameForMode();
        }
        this.syncUrl();
        this.notify();
    }

    setShader(shader: ShaderKind | null): void {
        this.state.shader = shader;
        if (this.stage) this.stage.solo = shader;
        this.rebuildEffectList();
        if (this.state.effect && !this.state.effects.includes(this.state.effect)) {
            this.state.effect = this.state.effects[0] ?? null;
        }
        this.syncUrl();
        this.notify();
    }

    setAutoFire(on: boolean): void {
        this.state.autoFire = on;
        window.clearInterval(this.fireTimer);
        this.fireTimer = 0;
        if (on) {
            this.fireTimer = window.setInterval(() => this.fire(),
                Math.max(100, this.state.intervalSec * 1000));
        }
        this.notify();
    }

    setInterval(sec: number): void {
        this.state.intervalSec = Math.max(0.1, sec);
        if (this.state.autoFire) this.setAutoFire(true);   // restart timer
    }

    fire(): void {
        if (!this.stage || !this.state.effect) return;
        try {
            this.stage.fire(this.state.effect);
            this.state.lastError = null;
        } catch (err) {
            this.state.lastError = (err as Error).message;
            this.notify();
        }
    }

    private syncUrl(): void {
        const u = new URL(location.href);
        const set = (k: string, v: string | null): void => {
            if (v) u.searchParams.set(k, v);
            else u.searchParams.delete(k);
        };
        set('effect', this.state.effect);
        set('mode', this.state.mode);
        set('shader', this.state.shader);
        history.replaceState(null, '', u);
    }

    private bindKeys(): void {
        window.addEventListener('keydown', (e) => {
            const t = e.target as HTMLElement | null;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
            if (e.ctrlKey || e.altKey || e.metaKey) return;
            if (e.key === 'ArrowRight') { e.preventDefault(); this.cycle(1); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); this.cycle(-1); }
            else if (e.key === ' ') { e.preventDefault(); this.fire(); }
        });
    }

    // ── asset loading ────────────────────────────────────────────────────────

    private async loadFxAssets(): Promise<{
        sources: NativeFxSources; library: FxLibrary; origin: 'vfs' | 'http';
    }> {
        try {
            const r = await this.loadViaVfs();
            console.log('[fx-viewer] FX assets loaded from the game VFS');
            return { ...r, origin: 'vfs' };
        } catch (err) {
            console.warn(`[fx-viewer] VFS load failed (${(err as Error).message}); trying HTTP`);
        }
        const r = await this.loadViaHttp();
        console.log('[fx-viewer] FX assets loaded over HTTP');
        return { ...r, origin: 'http' };
    }

    /** Read a game file through the sim's VFS (test.lua exec). Hex-armoured:
     *  the exec channel is a text pipe, so raw shader text (newlines, quotes)
     *  is not transport-safe; two hex chars per byte is. Chunked to stay
     *  under console-response payload limits. */
    private async vfsReadFile(path: string): Promise<string> {
        const CHUNK = 4000;   // hex chars per exec round-trip (2000 bytes)
        let hex = '';
        for (let start = 1; ; start += CHUNK / 2) {
            const out = await this.h.lua(
                `local f = VFS.LoadFile('${path}') `
                + `if not f then return 'MISSING' end `
                + `local part = string.sub(f, ${start}, ${start + CHUNK / 2 - 1}) `
                + `return (part:gsub('.', function(ch) return string.format('%02x', string.byte(ch)) end))`,
            );
            const clean = unquoteExec(out).trim();
            if (clean === 'MISSING') throw new Error(`VFS.LoadFile("${path}") returned nil`);
            if (!/^[0-9a-f]*$/.test(clean)) throw new Error(`non-hex exec response for ${path}`);
            hex += clean;
            if (clean.length < CHUNK) break;
        }
        let text = '';
        for (let i = 0; i < hex.length; i += 2) {
            text += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
        }
        return text;
    }

    private async loadViaVfs(): Promise<{ sources: NativeFxSources; library: FxLibrary }> {
        const sources: NativeFxSources = {};
        for (const f of NATIVE_FX_SHADER_FILES) {
            sources[f] = await this.vfsReadFile(`shaders/fx/${f}`);
        }
        const libText = await this.vfsReadFile('effects/library.json');
        return { sources, library: JSON.parse(libText) as FxLibrary };
    }

    private async loadViaHttp(): Promise<{ sources: NativeFxSources; library: FxLibrary }> {
        const game = param('game') ?? FX_GAME_DEFAULT;
        const base = param('fxbase') ?? `/data/games/${game}`;
        const get = async (rel: string): Promise<string> => {
            const res = await fetch(`${base}/${rel}`);
            if (!res.ok) throw new Error(`GET ${base}/${rel} → ${res.status}`);
            return res.text();
        };
        const sources: NativeFxSources = {};
        for (const f of NATIVE_FX_SHADER_FILES) {
            sources[f] = await get(`shaders/fx/${f}`);
        }
        const library = JSON.parse(await get('effects/library.json')) as FxLibrary;
        return { sources, library };
    }
}

/** Strip the exec channel's optional surrounding quotes (same contract as
 *  model-viewer's unquoteExec — kept local to avoid cross-harness coupling). */
function unquoteExec(out: string): string {
    const t = out.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
    return t;
}

let harness: FxViewerHarness | null = null;

const scenario: Scenario = {
    name: 'fx-viewer',
    description: 'Interactive SFX harness for the Metalstorm native FX set: effect menu + ◀ ▶ '
        + 'cycling (F8 panel), ?shader= solo, ?mode= impact|muzzle|projectile|loop. '
        + 'Renders the authored shaders/fx GLSL through core/native-fx on an isolated stage.',
    map: param('map') ?? 'green_flat_x34_v3',
    gameId: param('game') ?? FX_GAME_DEFAULT,
    aiSlots: [{ aiId: 'null', team: 1 }],
    playerTeam: 0,

    async setup(h: TestHarness): Promise<void> {
        harness = new FxViewerHarness(h);
        await harness.boot();
    },

    async run(): Promise<AssertionResult[]> {
        const s = harness!;
        const results: AssertionResult[] = [];
        results.push({
            name: 'fx-assets-loaded',
            ok: s.state.sourceOrigin !== null,
            detail: `origin=${s.state.sourceOrigin ?? 'none'}`,
        });
        results.push({
            name: 'stage-up',
            ok: s.stage !== null && document.getElementById('fx-stage-canvas') !== null,
        });
        results.push({
            name: 'panel-up',
            ok: document.getElementById('fx-viewer-panel') !== null,
        });
        results.push({
            name: 'effect-menu-populated',
            ok: s.state.effects.length > 0,
            detail: `${s.state.effects.length} effects (shader=${s.state.shader ?? 'all'})`,
        });
        // Auto-fire has had a beat by the time run() executes; at least one
        // spawn proves compile → pool → draw survived end-to-end.
        const stats = s.stage?.stats();
        results.push({
            name: 'fired-and-spawned',
            ok: (stats?.fired ?? 0) > 0,
            detail: stats
                ? `fired=${stats.fired} particles=${stats.particles} muzzles=${stats.muzzles} `
                + `tracers=${stats.tracers} trailSegs=${stats.trailSegments} shocks=${stats.shocks} `
                + `distortion=${stats.distortionAvailable}`
                : 'no stage',
        });
        return results;
    },
};

export default scenario;
