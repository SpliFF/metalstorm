/**
 * F8 dev panel for the fx-viewer harness — the SFX sibling of the
 * model-viewer panel (same fixed-corner + inline-style DOM-overlay idiom,
 * same F8 toggle; they never coexist, one scenario boots at a time).
 *
 * Groups: Effect (menu + ◀ ▶ + fire/auto) / Filter (shader solo, mode) /
 * Stage (visibility, dressing, soft-range, distortion) / Info (live stats).
 *
 * Keyboard (window-level, ignored while typing in inputs):
 *   ← / →  cycle effects       Space  fire       F8  hide/show panel
 */

import type { FxStageMode } from '../../core/native-fx/fx-stage.js';
import { SHADER_KINDS, type ShaderKind } from '../../core/native-fx/effect-compiler.js';

/** Structural interface of the scenario harness the panel drives (kept
 *  narrow + local so panel.ts has no import cycle with index.ts). */
export interface FxPanelHost {
    state: {
        phase: string;
        sourceOrigin: 'vfs' | 'http' | null;
        effect: string | null;
        effects: string[];
        shader: ShaderKind | null;
        mode: FxStageMode;
        autoFire: boolean;
        intervalSec: number;
        lastError: string | null;
    };
    stage: {
        visible: boolean;
        drawStageDressing: boolean;
        softRange: number;
        distortionStrength: number;
        linkedImpact: boolean;
        burstHeight: number;
        setVisible(on: boolean): void;
        stats(): {
            fired: number; liveProjectiles: number; distortionAvailable: boolean;
            particles: number; muzzles: number; tracers: number;
            trailSegments: number; shocks: number;
        };
    } | null;
    fire(): void;
    cycle(step: 1 | -1): void;
    select(effect: string): void;
    setMode(mode: FxStageMode): void;
    setShader(shader: ShaderKind | null): void;
    setAutoFire(on: boolean): void;
    setInterval(sec: number): void;
}

export interface FxViewerPanel {
    refresh(): void;
    destroy(): void;
}

const PANEL_CSS = `
position:fixed; top:36px; right:8px; width:290px; max-height:calc(100vh - 60px);
overflow-y:auto; background:rgba(12,14,18,0.92); color:#cde;
font:12px/1.5 monospace; z-index:9998; padding:8px 10px; border-radius:6px;
border:1px solid #345;`;

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K, css = '', text = '',
): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text) e.textContent = text;
    return e;
}

function btn(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = el('button',
        'margin:2px; padding:2px 7px; background:#234; color:#cde; border:1px solid #456;'
        + 'border-radius:3px; cursor:pointer; font:11px monospace;', label);
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
}

function group(title: string, open = true): { root: HTMLDetailsElement; body: HTMLDivElement } {
    const root = el('details');
    root.open = open;
    const summary = el('summary',
        'cursor:pointer; color:#8cf; font-weight:bold; margin:4px 0;', title);
    const body = el('div', 'margin:2px 0 6px 4px;');
    root.append(summary, body);
    return { root, body };
}

function checkbox(label: string, title: string, onChange: (on: boolean) => void):
    { root: HTMLLabelElement; input: HTMLInputElement } {
    const root = el('label', 'display:inline-flex; align-items:center; gap:4px; margin:2px 6px 2px 0; cursor:pointer;');
    root.title = title;
    const input = el('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    root.append(input, document.createTextNode(label));
    return { root, input };
}

function slider(
    label: string, min: number, max: number, step: number, value: number,
    onInput: (v: number) => void,
): { root: HTMLDivElement; input: HTMLInputElement } {
    const root = el('div', 'display:flex; align-items:center; gap:6px;');
    const name = el('span', 'width:66px; color:#9ab;', label);
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.style.flex = '1';
    const val = el('span', 'width:34px; text-align:right;', String(value));
    input.addEventListener('input', () => {
        val.textContent = input.value;
        onInput(Number(input.value));
    });
    root.append(name, input, val);
    return { root, input };
}

function select(
    title: string, options: { value: string; label: string }[],
    onChange: (v: string) => void,
): HTMLSelectElement {
    const s = el('select',
        'background:#123; color:#cde; border:1px solid #456; font:11px monospace;'
        + 'margin:2px 4px 2px 0; max-width:100%;');
    s.title = title;
    for (const o of options) {
        const opt = el('option', '', o.label);
        opt.value = o.value;
        s.append(opt);
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
}

export function createFxViewerPanel(api: FxPanelHost): FxViewerPanel {
    const root = el('div', PANEL_CSS);
    root.id = 'fx-viewer-panel';
    root.append(el('div', 'color:#8cf; font-weight:bold; margin-bottom:4px;',
        'FX viewer — F8 to hide'));

    // ── 1. Effect ────────────────────────────────────────────────────────────
    const effect = group('Effect');
    const effectSel = select('effect under test (effects/library.json)', [], (v) => api.select(v));
    effectSel.style.width = '100%';
    const cycleRow = el('div', 'display:flex; align-items:center; gap:4px; margin:3px 0;');
    const prevB = btn('◀', 'previous effect (ArrowLeft)', () => api.cycle(-1));
    const nextB = btn('▶', 'next effect (ArrowRight)', () => api.cycle(1));
    const posLbl = el('span', 'flex:1; text-align:center; color:#9ab;');
    cycleRow.append(prevB, posLbl, nextB);
    const fireRow = el('div', 'display:flex; align-items:center; gap:6px; margin:3px 0;');
    const fireB = btn('Fire (Space)', 'trigger the effect once', () => api.fire());
    fireB.style.background = '#243b24';
    const auto = checkbox('auto', 'retrigger continuously at the interval', (on) => api.setAutoFire(on));
    const intervalIn = el('input',
        'width:44px; background:#123; color:#cde; border:1px solid #456; font:11px monospace;');
    intervalIn.title = 'auto-fire interval, seconds';
    intervalIn.addEventListener('change', () => {
        const v = Number(intervalIn.value);
        if (Number.isFinite(v) && v > 0.05) api.setInterval(v);
    });
    fireRow.append(fireB, auto.root, intervalIn, el('span', 'color:#678;', 's'));
    const usageHint = el('div', 'color:#678;');
    effect.body.append(effectSel, cycleRow, fireRow, usageHint);
    root.append(effect.root);

    // ── 2. Filter ────────────────────────────────────────────────────────────
    const filter = group('Filter');
    const shaderSel = select('solo one shader program; the menu filters to effects that use it',
        [{ value: '', label: 'shader: all' },
         ...SHADER_KINDS.map((k) => ({ value: k, label: `shader: ${k}` }))],
        (v) => api.setShader((v || null) as ShaderKind | null));
    const modeSel = select('how the effect is used on the stage',
        (['impact', 'muzzle', 'projectile', 'loop'] as const)
            .map((m) => ({ value: m, label: `mode: ${m}` })),
        (v) => api.setMode(v as FxStageMode));
    filter.body.append(shaderSel, modeSel, el('div', 'color:#678; margin-top:2px;',
        'mode auto-follows the effect’s usage until you pick one'));
    root.append(filter.root);

    // ── 3. Stage ─────────────────────────────────────────────────────────────
    const stage = group('Stage');
    const show = checkbox('show stage', 'hide to reveal the running game underneath', (on) => {
        api.stage?.setVisible(on);
    });
    show.input.checked = true;
    const dressing = checkbox('grid & markers', 'stage dressing off = pure black void (isolates additive FX)', (on) => {
        if (api.stage) api.stage.drawStageDressing = on;
    });
    dressing.input.checked = true;
    const linked = checkbox('linked impact', 'projectile mode: fire expl_small where the round lands', (on) => {
        if (api.stage) api.stage.linkedImpact = on;
    });
    linked.input.checked = true;
    const soft = slider('soft rng', 0, 40, 1, 10, (v) => {
        if (api.stage) api.stage.softRange = v;
    });
    const distort = slider('distort', 0, 0.2, 0.01, 0.06, (v) => {
        if (api.stage) api.stage.distortionStrength = v;
    });
    const height = slider('height', 0, 200, 2, 2, (v) => {
        if (api.stage) api.stage.burstHeight = v;
    });
    height.root.title = 'impact/loop detonation height — raise for airbursts (flak)';
    stage.body.append(show.root, dressing.root, linked.root, soft.root, distort.root, height.root,
        el('div', 'color:#678;', 'drag = orbit · wheel = zoom'));
    root.append(stage.root);

    // ── 4. Info ──────────────────────────────────────────────────────────────
    const info = group('Info');
    const stats = el('div', 'color:#9ab; white-space:pre;');
    const status = el('div', 'color:#fa6; min-height:14px; white-space:pre-wrap;');
    info.body.append(stats, status);
    root.append(info.root);

    document.body.appendChild(root);

    // F8 toggle — same window-level idiom as the model-viewer panel.
    const onKey = (e: KeyboardEvent): void => {
        if (e.key !== 'F8' || e.ctrlKey || e.altKey || e.metaKey) return;
        e.preventDefault();
        root.style.display = root.style.display === 'none' ? 'block' : 'none';
    };
    window.addEventListener('keydown', onKey);

    // Live stats poll (cheap; panel-local, no scenario coupling).
    const statsTimer = window.setInterval(() => {
        const s = api.stage?.stats();
        if (!s) return;
        stats.textContent =
            `fired ${s.fired} · live proj ${s.liveProjectiles}\n`
            + `spawned: prt ${s.particles} muz ${s.muzzles} trc ${s.tracers}`
            + ` seg ${s.trailSegments} shk ${s.shocks}\n`
            + `distortion: ${s.distortionAvailable ? 'on (RGBA16F)' : 'UNAVAILABLE — no EXT_color_buffer_float'}`;
    }, 500);

    function refresh(): void {
        const st = api.state;
        // Effect menu — rebuild when the filtered list changed.
        const current = [...effectSel.options].map((o) => o.value);
        if (current.length !== st.effects.length
            || st.effects.some((e, i) => current[i] !== e)) {
            effectSel.replaceChildren(...st.effects.map((name) => {
                const o = el('option', '', name);
                o.value = name;
                return o;
            }));
        }
        if (st.effect) effectSel.value = st.effect;
        const idx = st.effect ? st.effects.indexOf(st.effect) : -1;
        posLbl.textContent = idx >= 0 ? `${idx + 1} / ${st.effects.length}` : `– / ${st.effects.length}`;
        usageHint.textContent =
            `${st.effect ?? 'no effect'} · mode ${st.mode} · src ${st.sourceOrigin ?? '…'} · ${st.phase}`;
        auto.input.checked = st.autoFire;
        if (document.activeElement !== intervalIn) intervalIn.value = String(st.intervalSec);
        shaderSel.value = st.shader ?? '';
        modeSel.value = st.mode;
        status.textContent = st.lastError ?? '';
    }
    refresh();

    return {
        refresh,
        destroy(): void {
            window.clearInterval(statsTimer);
            window.removeEventListener('keydown', onKey);
            root.remove();
        },
    };
}
