/**
 * Capture presets for the model-viewer harness (PLAN-model-harness §7) —
 * the automation payoff. `?scenario=model-viewer&…&capture=<preset>` runs
 * headless-style (no panel, deterministic sun + framing, sim paused where
 * the pose must hold still) and saves via the harness screenshot verbs.
 *
 * Presets:
 *   - turntable  N (default 8, `&views=16`) headings at noon light —
 *                the beta-units golden / PoC judgment set.
 *   - clips      4-frame strip per movement/fire/build showcase.
 *   - sun        fixed pose × 5 sun elevations (shadow regression).
 *
 * Results land as downloads (suppress with `&download=0`) plus the
 * `window.modelViewer.captures` manifest (data-URL list) so the
 * spring-debug MCP / CI harness can pull them.
 */

import { sleep } from '../types.js';
import type { ShowcaseId } from './capability-probe.js';
import { runShowcase, type StageContext } from './routines.js';

export type CapturePreset = 'turntable' | 'clips' | 'sun';

export interface CaptureEntry {
    preset: CapturePreset;
    label: string;
    dataUrl: string;
}

export interface CaptureOpts {
    /** Turntable headings (default 8). */
    views: number;
    /** Also trigger browser downloads for each frame (default true). */
    download: boolean;
}

/** Deterministic "noon" light for turntable/clips captures. */
const CAPTURE_SUN = { azimuthDeg: 40, elevationDeg: 55 };
/** Fixed camera pose for the sun sweep. */
const SUN_SWEEP_CAMERA = { yawDeg: 40, pitchDeg: 20 };
const SUN_SWEEP_ELEVATIONS = [5, 15, 30, 55, 80];
/** Frame times (ms after routine start) for the 4-frame clip strips. */
const CLIP_FRAME_TIMES_MS = [1500, 4000, 8000, 12000];

/** Movement/action showcases worth a clip strip, in preference order. */
const CLIP_CANDIDATES: ShowcaseId[] = [
    'circuit', 'fly-circuit', 'sail-circuit', 'volley', 'build', 'produce', 'load-unload',
];

async function grab(
    ctx: StageContext, out: CaptureEntry[], preset: CapturePreset, label: string,
    download: boolean,
): Promise<void> {
    const dataUrl = await ctx.h.highResScreenshot();
    out.push({ preset, label, dataUrl });
    if (download) {
        const a = document.createElement('a');
        a.href = dataUrl;
        a.download = `mv-${ctx.state.def ?? 'unknown'}-${preset}-${label}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
}

export async function runCapture(
    ctx: StageContext, preset: CapturePreset, opts: CaptureOpts,
): Promise<CaptureEntry[]> {
    const out: CaptureEntry[] = [];
    ctx.state.phase = 'capturing';
    ctx.notify();
    try {
        switch (preset) {
            case 'turntable': {
                await ctx.h.sun(CAPTURE_SUN);
                await ctx.h.orbitSet({ pitchDeg: 20, follow: false });
                await ctx.h.orbitFrame();
                await ctx.h.simPause().catch(() => { /* hold the pose */ });
                const n = Math.max(1, Math.floor(opts.views));
                for (let i = 0; i < n; i++) {
                    const yaw = (i * 360) / n;
                    await ctx.h.orbitSet({ yawDeg: yaw });
                    await sleep(350); // let the frame render at the new heading
                    await grab(ctx, out, preset, `h${String(Math.round(yaw)).padStart(3, '0')}`,
                        opts.download);
                }
                await ctx.h.simResume().catch(() => { /* — */ });
                await ctx.h.sun(null);
                await ctx.h.orbitSet({ follow: true });
                break;
            }
            case 'clips': {
                await ctx.h.sun(CAPTURE_SUN);
                const available = new Set(ctx.state.showcases.map((s) => s.id));
                const targets = CLIP_CANDIDATES.filter((id) => available.has(id));
                for (const id of targets) {
                    const routine = runShowcase(ctx, id).catch((err) =>
                        console.warn(`[model-viewer] clips: "${id}" errored:`, err));
                    const t0 = performance.now();
                    for (let f = 0; f < CLIP_FRAME_TIMES_MS.length; f++) {
                        const dueIn = CLIP_FRAME_TIMES_MS[f] - (performance.now() - t0);
                        if (dueIn > 0) await sleep(dueIn);
                        await grab(ctx, out, preset, `${id}-f${f}`, opts.download);
                    }
                    await routine; // includes the E2 stage reset
                }
                await ctx.h.sun(null);
                break;
            }
            case 'sun': {
                await ctx.h.orbitSet({ ...SUN_SWEEP_CAMERA, follow: false });
                await ctx.h.orbitFrame();
                await ctx.h.simPause().catch(() => { /* hold the pose */ });
                for (const el of SUN_SWEEP_ELEVATIONS) {
                    await ctx.h.sun({ azimuthDeg: 40, elevationDeg: el });
                    await sleep(350);
                    await grab(ctx, out, preset, `el${String(el).padStart(2, '0')}`, opts.download);
                }
                await ctx.h.simResume().catch(() => { /* — */ });
                await ctx.h.sun(null);
                await ctx.h.orbitSet({ follow: true });
                break;
            }
        }
    } finally {
        if (ctx.state.phase === 'capturing') ctx.state.phase = 'ready';
        ctx.notify();
    }
    return out;
}

/** Expected frame count per preset — the capture-mode self-assertion. */
export function expectedCaptureCount(
    preset: CapturePreset, views: number, availableShowcases: readonly ShowcaseId[],
): number {
    switch (preset) {
        case 'turntable': return Math.max(1, Math.floor(views));
        case 'sun': return SUN_SWEEP_ELEVATIONS.length;
        case 'clips': {
            const available = new Set(availableShowcases);
            return CLIP_CANDIDATES.filter((id) => available.has(id)).length
                * CLIP_FRAME_TIMES_MS.length;
        }
    }
}
