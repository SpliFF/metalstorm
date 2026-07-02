import { describe, it, expect } from 'vitest';
import { FrameProfiler, FRAME_PHASES } from './frame-profiler.js';

/// Record N frames whose phase durations follow a fixed pattern, spaced 16 ms
/// apart, starting at t0. Phase p of frame k gets value f(k, p).
function feed(
    fp: FrameProfiler,
    n: number,
    f: (k: number, p: number) => number,
    t0 = 1000,
    stepMs = 16,
): number {
    let t = t0;
    for (let k = 0; k < n; k++) {
        fp.beginFrame(t);
        let cursor = t;
        for (let p = 0; p < FRAME_PHASES.length - 1; p++) {
            cursor += f(k, p);
            fp.mark(p, cursor);
        }
        // endFrame stamps `total` = end - frameStart on its own; advance wall
        // time to the next frame slot.
        fp.endFrame(cursor);
        t += stepMs;
    }
    return t;
}

describe('FrameProfiler', () => {
    it('mark() diffs against the previous mark, endFrame() fills total', () => {
        const fp = new FrameProfiler(30000, 64);
        // frame: camera 1, entity 2, fx 3, decals 4, render 5, ui 6 → total 21
        const end = feed(fp, 1, (_k, p) => p + 1);
        const d = fp.dump(30000, end);
        expect(d.frames).toBe(1);
        expect(d.phases.camera.mean).toBeCloseTo(1);
        expect(d.phases.entity.mean).toBeCloseTo(2);
        expect(d.phases.ui.mean).toBeCloseTo(6);
        expect(d.phases.total.mean).toBeCloseTo(1 + 2 + 3 + 4 + 5 + 6);
    });

    it('computes p50/p95/p99/max over the window', () => {
        const fp = new FrameProfiler(30000, 4096);
        // render phase = frame index 0..99; every other phase constant 0.
        const end = feed(fp, 100, (k, p) => (p === 4 ? k : 0));
        const d = fp.dump(30000, end);
        expect(d.frames).toBe(100);
        const r = d.phases.render;
        // sorted render values are 0..99; percentile index = floor(p/100 * n).
        expect(r.max).toBe(99);
        expect(r.p50).toBe(50); // floor(0.50*100)=50 → sorted[50]=50
        expect(r.p95).toBe(95);
        expect(r.p99).toBe(99);
        expect(r.mean).toBeCloseTo(49.5);
    });

    it('honours the time window — old samples fall out', () => {
        const fp = new FrameProfiler(30000, 4096);
        // 100 frames, 16 ms apart → ~1.6 s span. Ask for only the last 160 ms.
        const end = feed(fp, 100, (_k, p) => (p === 0 ? 1 : 0));
        const recent = fp.dump(160, end);
        // 160 ms / 16 ms ≈ 10 frames (cutoff = end-160; inclusive of boundary).
        expect(recent.frames).toBeGreaterThan(8);
        expect(recent.frames).toBeLessThanOrEqual(11);
        // effective reported window never exceeds the requested window.
        expect(recent.windowMs).toBeLessThanOrEqual(160);
    });

    it('ring wraps without overflow past capacity', () => {
        const fp = new FrameProfiler(60000, 8); // tiny ring
        const end = feed(fp, 50, (_k, p) => (p === 4 ? 7 : 0), 1000, 1);
        const d = fp.dump(60000, end);
        // Only the last 8 frames survive; each render=7.
        expect(d.frames).toBe(8);
        expect(d.phases.render.mean).toBeCloseTo(7);
        expect(d.phases.render.max).toBe(7);
    });

    it('reset() clears buffered samples', () => {
        const fp = new FrameProfiler();
        const end = feed(fp, 20, () => 1);
        fp.reset();
        const d = fp.dump(30000, end + 1);
        expect(d.frames).toBe(0);
        expect(d.phases.total.mean).toBe(0);
        expect(d.fps).toBe(0);
    });

    it('derives fps from the sampled span', () => {
        const fp = new FrameProfiler(30000, 4096);
        // 61 frames at 16 ms spacing → span 60*16=960 ms; fps=(61-1)/0.96=62.5
        const end = feed(fp, 61, () => 1, 1000, 16);
        const d = fp.dump(30000, end);
        expect(d.frames).toBe(61);
        expect(d.fps).toBeCloseTo(62.5, 1);
    });

    it('table output lists every phase', () => {
        const fp = new FrameProfiler();
        const end = feed(fp, 5, (_k, p) => p);
        const { table } = fp.dump(30000, end);
        for (const name of FRAME_PHASES) expect(table).toContain(name);
        expect(table).toContain('mean');
    });
});
