/**
 * F8 dev panel for the model-viewer harness (PLAN-model-harness §4).
 *
 * A plain DOM overlay on the MAIN thread (sibling of the F9 widget list /
 * F10–F11 overlays; same fixed-corner + inline-style idiom) — NOT a
 * game-shipped widget, so it works for every game including ports and can
 * use browser UI freely. Created by the model-viewer scenario; F8 toggles
 * visibility.
 *
 * Single column, collapsible groups: Unit / Showcases / Camera /
 * Sun & light / Render.
 */

import type { TestHarness } from '../../core/test-harness.js';
import type { CapturePreset } from './capture.js';
import { deriveClipButtons, type ShowcaseId } from './capability-probe.js';
import type { ModelViewerState } from './routines.js';

export interface PanelApi {
    h: TestHarness;
    state: ModelViewerState;
    /** Streamed defs + a sim-side name dump, merged (for the picker). */
    listAllDefNames(): Promise<{ name: string; humanName?: string }[]>;
    respawn(def?: string): Promise<number>;
    run(id: ShowcaseId): void;
    stopReset(): Promise<void>;
    capture(preset: CapturePreset): void;
    /** Toggle an authored .glb clip on the stage unit (task 6). */
    playClip(name: string): void;
    /** Re-enter orbit on the stage unit (after "RTS cam"). */
    reorbit(): Promise<void>;
    /** Open a standalone Babylon inspector popup on the staged def's model.
     *  'cdn' = unpkg UMD build; 'bundled' = the app's own Vite route. */
    inspectModel(mode: 'cdn' | 'bundled'): void;
}

export interface ModelViewerPanel {
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
    label: string, min: number, max: number, value: number,
    onInput: (v: number) => void,
): { root: HTMLDivElement; input: HTMLInputElement } {
    const root = el('div', 'display:flex; align-items:center; gap:6px;');
    const name = el('span', 'width:66px; color:#9ab;', label);
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
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

export function createModelViewerPanel(api: PanelApi): ModelViewerPanel {
    const root = el('div', PANEL_CSS);
    root.id = 'model-viewer-panel';
    root.append(el('div', 'color:#8cf; font-weight:bold; margin-bottom:4px;',
        'Model viewer — F8 to hide'));

    // ── 1. Unit ──────────────────────────────────────────────────────────
    const unit = group('Unit');
    const defInput = el('input',
        'width:100%; background:#123; color:#cde; border:1px solid #456; padding:2px 4px;'
        + 'font:12px monospace; box-sizing:border-box;');
    defInput.placeholder = 'def name… (Enter to spawn)';
    const defList = el('datalist');
    defList.id = 'model-viewer-defs';
    defInput.setAttribute('list', defList.id);
    defInput.addEventListener('focus', () => {
        void api.listAllDefNames().then((defs) => {
            defList.replaceChildren(...defs.map((d) => {
                const o = el('option');
                o.value = d.name;
                if (d.humanName && d.humanName !== d.name) o.label = d.humanName;
                return o;
            }));
        });
    });
    defInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && defInput.value.trim()) {
            void api.respawn(defInput.value.trim()).catch((err) =>
                setStatus(`spawn failed: ${(err as Error).message}`));
        }
        e.stopPropagation();
    });
    const badge = el('div',
        'display:none; background:#a22; color:#fff; padding:2px 6px; margin:4px 0;'
        + 'border-radius:3px; font-weight:bold;');
    const unitInfo = el('div', 'color:#9ab; margin-top:2px;');
    unit.body.append(defInput, defList, badge, unitInfo,
        btn('Respawn', 'clear stage + fresh spawn of the current def', () => {
            void api.respawn().catch((err) => setStatus((err as Error).message));
        }));
    root.append(unit.root);

    // ── 2. Showcases ─────────────────────────────────────────────────────
    const showcases = group('Showcases');
    const showcaseBtns = el('div');
    // Task 6: one "Play clip: X" toggle per authored .glb clip — present
    // only for native glTF models that ship clips (converted S3O/DAE
    // models have none, so the row stays empty on ZK/BAR).
    const clipBtns = el('div');
    const slow = checkbox('slow-mo (0.25×)', 'run routines at quarter sim speed (gait inspection)',
        (on) => { api.state.slowMo = on; });
    const status = el('div', 'color:#fa6; min-height:14px; margin-top:2px; white-space:pre-wrap;');
    function setStatus(msg: string): void { status.textContent = msg; }
    showcases.body.append(showcaseBtns, clipBtns, slow.root,
        btn('Stop / reset stage', 'clear orders + dummies, respawn if needed, re-frame',
            () => { void api.stopReset().catch((err) => setStatus((err as Error).message)); }),
        status);
    root.append(showcases.root);

    // ── 3. Camera ────────────────────────────────────────────────────────
    const camera = group('Camera');
    const follow = checkbox('follow', 'anchor tracks the unit (off = hold position)', (on) => {
        void api.h.orbitSet({ follow: on });
    });
    follow.input.checked = true;
    camera.body.append(
        follow.root,
        btn('Frame', 'auto-frame: unit fills ~70% of the shorter axis', () => {
            void api.h.orbitFrame();
        }),
        btn('Orbit', 're-enter the orbit rig on the stage unit', () => {
            void api.reorbit().catch((err) => setStatus((err as Error).message));
        }),
        btn('RTS cam', 'exit the rig, restore the normal RTS camera', () => {
            void api.h.orbitStop();
        }),
        el('div', 'color:#678; margin-top:2px;', 'drag = orbit · wheel = zoom'),
    );
    root.append(camera.root);

    // ── 4. Sun & light ───────────────────────────────────────────────────
    const sun = group('Sun & light');
    let az = 40, elv = 55;
    const azS = slider('azimuth', 0, 360, az, (v) => { az = v; void api.h.sun({ azimuthDeg: v }); });
    const elS = slider('elevation', -10, 90, elv, (v) => { elv = v; void api.h.sun({ elevationDeg: v }); });
    const cycleSecs = el('input',
        'width:48px; background:#123; color:#cde; border:1px solid #456; font:11px monospace;');
    cycleSecs.value = '60';
    cycleSecs.title = 'seconds per full day';
    const cycle = checkbox('day–night cycle', 'animate azimuth 360° + dawn→noon→dusk arc', (on) => {
        void (on ? api.h.sunCycle(Number(cycleSecs.value) || 60) : api.h.sunCycle(0));
    });
    const presets = el('div');
    const preset = (label: string, title: string, a: number, e: number) =>
        btn(label, title, () => {
            az = a; elv = e;
            azS.input.value = String(a);
            elS.input.value = String(e);
            void api.h.sun({ azimuthDeg: a, elevationDeg: e });
        });
    presets.append(
        preset('noon', 'high sun — clean silhouettes', 40, 60),
        preset('golden', 'low warm sun — the shadow-acne / peter-panning check', 200, 8),
        preset('night', 'below the horizon — ambient floor', 40, -20),
        btn('map light', 'restore the map’s authored lighting', () => {
            void api.h.sun(null);
        }));
    const cycleRow = el('div', 'display:flex; align-items:center; gap:4px;');
    cycleRow.append(cycle.root, cycleSecs, el('span', 'color:#678;', 's/day'));
    sun.body.append(azS.root, elS.root, cycleRow, presets);
    root.append(sun.root);

    // ── 5. Render ────────────────────────────────────────────────────────
    const render = group('Render');
    const lod = el('select',
        'background:#123; color:#cde; border:1px solid #456; font:11px monospace; margin:2px 4px 2px 0;');
    for (const [value, label] of [
        ['full', 'LOD: full model'],
        ['impostor', 'LOD: impostor (billboard)'],
        ['icon', 'LOD: icon (hidden — PLAN-macro-map.md owns strategic icons)'],
    ] as const) {
        const o = el('option', '', label);
        o.value = value;
        lod.append(o);
    }
    lod.title = 'force a LOD tier on the staged unit, overriding its def thresholds';
    lod.addEventListener('change', () => {
        api.h.setForceLodTier(lod.value as 'full' | 'impostor' | 'icon');
    });
    const wire = checkbox('wireframe', 'scene-wide forceWireframe', (on) => api.h.setWireframe(on));
    const pause = checkbox('pause render', 'freeze the worker render loop (sim keeps running)',
        (on) => { if (on) api.h.pause(); else api.h.resume(); });
    render.body.append(
        lod, wire.root, pause.root, el('div'),
        btn('Screenshot', 'save the canvas as PNG', () => { void api.h.saveScreenshot(); }),
        btn('Hi-res shot', 'high-resolution screenshot (falls back to canvas res)', () => {
            void api.h.highResScreenshot().then((url) => {
                const a = document.createElement('a');
                a.href = url;
                a.download = `mv-${api.state.def ?? 'stage'}-hires.png`;
                document.body.appendChild(a);
                a.click();
                a.remove();
            });
        }),
        el('div'),
        btn('turntable', 'capture preset: 8 headings at noon light', () => api.capture('turntable')),
        btn('clips', 'capture preset: 4-frame strip per routine', () => api.capture('clips')),
        btn('sun sweep', 'capture preset: fixed pose × 5 elevations', () => api.capture('sun')),
    );
    root.append(render.root);

    // ── 6. Inspect (Babylon) ─────────────────────────────────────────────
    // Debugging models is the whole point of this scenario, and the game's
    // render scene lives in the worker (OffscreenCanvas) where the DOM
    // Inspector can't reach. These pop a standalone Babylon scene that loads
    // the SAME model URL with the glTF loader's logging + Khronos validator
    // and the debugLayer open — a faithful reproduction of the load path.
    const inspect = group('Inspect (Babylon)');
    inspect.body.append(
        btn('Inspector ▸ CDN', 'popup: unpkg UMD Babylon 9.1.0 (isolated) — Inspector + glTF validation on the staged model',
            () => api.inspectModel('cdn')),
        btn('Inspector ▸ bundled', 'popup: the app’s own Babylon build (same module graph as the game)',
            () => api.inspectModel('bundled')),
        el('div', 'color:#678; margin-top:2px;',
            'loads the staged model in a DOM scene · console shows validator + geometry dump'),
    );
    root.append(inspect.root);

    document.body.appendChild(root);

    // F8 toggle — same window-level idiom as the F9/F10/F11 overlays.
    const onKey = (e: KeyboardEvent): void => {
        if (e.key !== 'F8' || e.ctrlKey || e.altKey || e.metaKey) return;
        e.preventDefault();
        root.style.display = root.style.display === 'none' ? 'block' : 'none';
    };
    window.addEventListener('keydown', onKey);

    function refresh(): void {
        const s = api.state;
        // Unit group
        badge.style.display = s.badge ? 'block' : 'none';
        badge.textContent = s.badge === 'fallback-model'
            ? '⚠ FALLBACK MODEL — def has no model (E1)' : (s.badge ?? '');
        unitInfo.textContent = s.def
            ? `${s.def}  ·  unit ${s.stageUnitId ?? '—'}  ·  ${s.phase}`
            : 'no def staged — type a name above';
        if (s.def && !defInput.value) defInput.value = s.def;
        // Showcase buttons (derived, disabled while one runs)
        showcaseBtns.replaceChildren(...s.showcases.map((spec) => {
            const b = btn(spec.label, spec.hint ?? '', () => api.run(spec.id));
            if (s.running) {
                b.disabled = true;
                b.title = `busy: "${s.running}" is running`;
                b.style.opacity = '0.5';
            }
            return b;
        }));
        // Clip toggles (task 6) — playing one is highlighted and relabelled
        clipBtns.replaceChildren(...deriveClipButtons(s.clips).map(({ clip, label }) => {
            const playing = s.playingClip === clip;
            const b = btn(playing ? `Stop clip: ${clip}` : label,
                'authored .glb clip via the client animator (loops until stopped)',
                () => api.playClip(clip));
            if (playing) b.style.background = '#274';
            return b;
        }));
        slow.input.checked = s.slowMo;
        if (s.lastError) setStatus(s.lastError);
        else if (s.running) setStatus(`running: ${s.running}…`);
        else setStatus('');
    }
    refresh();

    return {
        refresh,
        destroy(): void {
            window.removeEventListener('keydown', onKey);
            root.remove();
        },
    };
}
