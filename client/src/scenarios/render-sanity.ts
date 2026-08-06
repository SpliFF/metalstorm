/**
 * Render sanity — "did this scenario actually draw anything?"
 *
 * A scenario that renders nothing looks exactly like a scenario that is
 * still loading: the page is up, `window.test` answers, the sim ticks,
 * and the viewport is a black rectangle. Nothing in the pipeline says
 * "this cannot work" — so a driver (human or agent) reloads the URL,
 * waits, sees black, and reloads again. That loop is what this module
 * exists to break. Every scenario is gated on it, not just the one that
 * happened to be broken when it was written.
 *
 * Three independent signals, because each one catches a failure the
 * others miss:
 *
 *   1. **The render loop is advancing.** Babylon's `engine.frameId` must
 *      move across the sample window. A frozen loop (worker died, GL
 *      context lost, an exception in the per-frame callback) leaves a
 *      stale-but-plausible frame on screen that every pixel check would
 *      happily pass.
 *   2. **The scene has geometry — specifically map terrain.** The real
 *      2026-08-04 failure was a map whose `metadata.json` 404'd: the
 *      client kept rendering, kept ticking, kept accepting orders, and
 *      drew an empty world. `meshCount > 0` alone does not catch it
 *      (HUD/FX meshes exist regardless), so terrain is checked by name.
 *   3. **The framebuffer is not a flat fill.** Catches the cases the
 *      scene graph looks fine for: everything culled, camera pointed at
 *      the void, every material failing to compile.
 *
 * **Deliberately not a brightness test.** Legitimately dark scenes exist,
 * and they get *much* darker than intuition suggests, because the two
 * dimming factors multiply. A game whose `modinfo.lua` declares
 * `lighting = 'realistic'` runs the scene-wide hemispheric ambient at 20%
 * (`scene-lighting.ts` LIGHTING_AMBIENT.realistic); terrain with no LOS is
 * then covered by the fog overlay at the `unscouted` darkening, 0.72, so
 * only 28% of that gets through. Together they land around 2% luminance —
 * visually indistinguishable from black, with nothing actually broken.
 * That is the ZK/green_flat case that started this; see the lane notes.
 * So the pixel test asks for *contrast*, not light: a dark-but-rendered
 * frame still has a luminance spread, an empty one is uniform at whatever
 * the clear colour tonemaps to.
 *
 * `evaluateRenderSanity` is pure and unit-tested; `sampleRenderState`
 * owns the browser I/O (worker eval + canvas readback).
 */

import type { TestHarness } from '../core/test-harness.js';
import { sleep } from './types.js';

/** One observation of what the renderer is currently doing. */
export interface RenderSample {
    /** Babylon `engine.frameId` delta across the sample window. */
    renderFramesAdvanced: number;
    /** Milliseconds the frame delta was measured over. */
    sampleWindowMs: number;
    /** Total meshes in the worker scene. */
    meshCount: number;
    /** Meshes that are map terrain (`terrain_x_z` / `terrainLod1_x_z`).
     *  The fog overlay (`terrainFog`) is deliberately excluded — it is
     *  present even when the map itself never loaded. */
    terrainMeshCount: number;
    /** Downsampled framebuffer luminance, 0..255. */
    luminance: { min: number; max: number; mean: number };
    /** Set when the sample could not be taken at all (worker unreachable,
     *  screenshot rejected). Any other field is meaningless then. */
    error?: string;
}

export interface RenderVerdict {
    ok: boolean;
    /** Short slug for the failing signal, or `'ok'`. */
    reason: string;
    /** Human-readable line — carries the numbers either way, so a passing
     *  run still tells you what the frame looked like. */
    detail: string;
}

/**
 * Thresholds. Set well below anything a working scene produces rather
 * than close to it: this assertion exists to catch "nothing at all", and
 * a flaky render gate is worse than none (it teaches drivers to ignore
 * the result).
 *
 * Measured on this lane 2026-08-04 (64x36 downsample, 0..255, viewport
 * only — the reported figures are from the gate's own sample, so they are
 * reproducible by re-running the scenario):
 *   - green_flat + ZK, zero LOS ('realistic' ambient x full unscouted
 *     fog) — the literal "black map" report: peak 10.4, spread 8.6.
 *     Renders correctly; 50 terrain meshes; passes, but only just.
 *   - the same frame with the fog overlay disabled: mean 19.7 (vs 10.2).
 *     i.e. neither factor alone gets you to black; the product does.
 *   - a scene with no terrain: clear colour only, spread ~0.
 *
 * The ZK figure is the important one: the darkest frame anyone has called
 * "broken" still clears these limits, which is the margin the thresholds
 * are chosen to preserve. Do NOT raise them toward it — a gate that fires
 * on a legitimately dim scene is a gate drivers learn to ignore.
 */
export const RENDER_SANITY_LIMITS = {
    /** Frames the render loop must advance across the sample window. */
    minRenderFrames: 1,
    /** Peak luminance. A truly black buffer is 0. */
    minPeakLuminance: 6,
    /** max - min. A flat fill (clear colour, one solid quad) is ~0. */
    minLuminanceSpread: 6,
} as const;

/** Classify a sample. Pure — the whole point is that this is testable
 *  without a browser. Checks run cheapest-signal-first so the reported
 *  reason names the most upstream cause, not a downstream symptom. */
export function evaluateRenderSanity(s: RenderSample): RenderVerdict {
    const L = RENDER_SANITY_LIMITS;
    const nums =
        `frames+${s.renderFramesAdvanced}/${s.sampleWindowMs}ms `
        + `meshes=${s.meshCount} terrain=${s.terrainMeshCount} `
        + `luma min/mean/max=${s.luminance.min.toFixed(1)}/`
        + `${s.luminance.mean.toFixed(1)}/${s.luminance.max.toFixed(1)}`;

    if (s.error) {
        return {
            ok: false, reason: 'sample-failed',
            detail: `could not read the renderer: ${s.error}`,
        };
    }
    if (s.renderFramesAdvanced < L.minRenderFrames) {
        return {
            ok: false, reason: 'render-loop-stalled',
            detail: `the render loop is not advancing — 0 frames in `
                + `${s.sampleWindowMs}ms. The worker is wedged or its GL `
                + `context is gone; the visible frame is stale. (${nums})`,
        };
    }
    if (s.meshCount === 0) {
        return {
            ok: false, reason: 'empty-scene',
            detail: `the scene contains no meshes at all. (${nums})`,
        };
    }
    if (s.terrainMeshCount === 0) {
        return {
            ok: false, reason: 'no-terrain',
            detail: `the map never built any terrain geometry, so the world `
                + `is empty. Usually the map failed to load — check for a `
                + `4xx on /api/maps/data/<map>/metadata.json (the lobby `
                + `serves it from the map DB, so an un-imported map 404s). `
                + `(${nums})`,
        };
    }
    const spread = s.luminance.max - s.luminance.min;
    if (s.luminance.max < L.minPeakLuminance) {
        return {
            ok: false, reason: 'black-viewport',
            detail: `the viewport is black — peak luminance `
                + `${s.luminance.max.toFixed(1)}/255 (need `
                + `${L.minPeakLuminance}). (${nums})`,
        };
    }
    if (spread < L.minLuminanceSpread) {
        return {
            ok: false, reason: 'flat-viewport',
            detail: `the viewport is a flat fill — luminance spread `
                + `${spread.toFixed(1)} (need ${L.minLuminanceSpread}). `
                + `Meshes exist but nothing is being drawn over the clear `
                + `colour: everything culled, the camera is off the map, or `
                + `materials failed to compile. (${nums})`,
        };
    }
    return { ok: true, reason: 'ok', detail: nums };
}

/** Worker-side census. Kept as one expression so it costs a single
 *  round trip; returns JSON because `evalJs` results must be clone-safe. */
const SCENE_CENSUS_EXPR = `(() => {
    const er = self.__entityRenderer;
    const s = er && er.scene;
    if (!s) return JSON.stringify({ error: 'no scene in the render worker' });
    let terrain = 0;
    for (const m of s.meshes) {
        if (/^terrain(_|Lod\\d+_)/.test(m.name)) terrain++;
    }
    return JSON.stringify({
        frameId: s.getEngine().frameId,
        meshCount: s.meshes.length,
        terrainMeshCount: terrain,
    });
})()`;

interface SceneCensus {
    frameId?: number;
    meshCount?: number;
    terrainMeshCount?: number;
    error?: string;
}

async function census(): Promise<SceneCensus> {
    const gp = (window as unknown as {
        __gp?: (expr: string) => Promise<unknown>;
    }).__gp;
    if (!gp) return { error: 'window.__gp is not wired (no render worker)' };
    const raw = await gp(SCENE_CENSUS_EXPR);
    if (typeof raw !== 'string') {
        return { error: `unexpected evalJs result: ${JSON.stringify(raw)}` };
    }
    try {
        return JSON.parse(raw) as SceneCensus;
    } catch {
        return { error: `unparseable evalJs result: ${raw}` };
    }
}

/**
 * Downsample the canvas capture and reduce it to luminance stats.
 *
 * Note this reads `TestHarness.screenshot()`, which is the *worker's*
 * OffscreenCanvas (created with `preserveDrawingBuffer`) — not a CDP page
 * capture, which cannot see a WebGL2 canvas at all and would report every
 * scenario as black.
 */
async function framebufferLuminance(
    h: TestHarness,
): Promise<{ min: number; max: number; mean: number }> {
    const dataUrl = await h.screenshot();
    const img = new Image();
    await new Promise<void>((res, rej) => {
        img.onload = () => res();
        img.onerror = () => rej(new Error('screenshot did not decode as an image'));
        img.src = dataUrl;
    });
    const W = 64, H = 36;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context for the luminance readback');
    ctx.drawImage(img, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    let min = 255, max = 0, sum = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) {
        const l = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
        if (l < min) min = l;
        if (l > max) max = l;
        sum += l;
        n++;
    }
    return n === 0
        ? { min: 0, max: 0, mean: 0 }
        : { min, max, mean: sum / n };
}

/** Take one observation. Never throws — a failure to sample is itself a
 *  reportable outcome (`RenderSample.error`), not an exception the caller
 *  has to reinterpret. */
export async function sampleRenderState(
    h: TestHarness, windowMs = 400,
): Promise<RenderSample> {
    const empty = {
        renderFramesAdvanced: 0, sampleWindowMs: windowMs,
        meshCount: 0, terrainMeshCount: 0,
        luminance: { min: 0, max: 0, mean: 0 },
    };
    try {
        const first = await census();
        if (first.error) return { ...empty, error: first.error };
        await sleep(windowMs);
        const second = await census();
        if (second.error) return { ...empty, error: second.error };

        return {
            renderFramesAdvanced: (second.frameId ?? 0) - (first.frameId ?? 0),
            sampleWindowMs: windowMs,
            meshCount: second.meshCount ?? 0,
            terrainMeshCount: second.terrainMeshCount ?? 0,
            luminance: await framebufferLuminance(h),
        };
    } catch (err) {
        return { ...empty, error: (err as Error)?.message ?? String(err) };
    }
}

/**
 * Poll until the scene passes, or the deadline expires. Returns the last
 * verdict either way.
 *
 * Polling (rather than one shot) is what makes this usable as a boot
 * gate: terrain build is async and finishes some seconds after the sim
 * starts ticking, so a single early sample would fail every healthy run.
 * A genuinely broken scenario simply never passes and burns the whole
 * budget once — which is the point, versus burning it on every reload
 * forever.
 */
export async function waitForRenderSanity(
    h: TestHarness, timeoutMs: number, pollMs = 1000,
): Promise<RenderVerdict> {
    const deadline = performance.now() + timeoutMs;
    let verdict = evaluateRenderSanity({
        renderFramesAdvanced: 0, sampleWindowMs: 0,
        meshCount: 0, terrainMeshCount: 0,
        luminance: { min: 0, max: 0, mean: 0 },
        error: 'never sampled',
    });
    for (;;) {
        verdict = evaluateRenderSanity(await sampleRenderState(h));
        if (verdict.ok) return verdict;
        if (performance.now() >= deadline) return verdict;
        await sleep(pollMs);
    }
}
