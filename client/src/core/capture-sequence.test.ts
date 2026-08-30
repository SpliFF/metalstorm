/**
 * capture-sequence — pacing, byte budget and the still-life verdict.
 *
 * The rule under test that matters most is `summariseSequence`'s refusal to
 * pass a burst whose shots all share one server frame. Every such shot is
 * individually perfect — framed, exposed, luminance-checked — and the set is
 * worthless as evidence of motion, which is the only thing a sequence is for.
 */
import { describe, it, expect } from 'vitest';
import {
    clampFrames,
    clampSimSpeed,
    payloadChars,
    sequenceMaxDim,
    shotIntervalMs,
    summariseSequence,
    wireBudgetExceeded,
    GAME_SPEED,
    MAX_SEQUENCE_FRAMES,
    SEQUENCE_WIRE_BUDGET_CHARS,
    type SequenceShot,
} from './capture-sequence.js';

function shot(index: number, gameFrame: number, atMs: number,
              opts: { black?: boolean; chars?: number } = {}): SequenceShot {
    return {
        index, gameFrame, atMs,
        frameId: 1000 + index,
        dataUrl: 'data:image/jpeg;base64,' + 'x'.repeat(opts.chars ?? 100),
        width: 800, height: 500,
        stats: { min: 0, max: 200, mean: opts.black ? 2 : 90 },
        verdict: {
            black: opts.black === true, flat: false,
            mean: opts.black ? 2 : 90, contrast: 200,
            reason: opts.black ? 'near-black frame' : null,
        },
    };
}

describe('shotIntervalMs', () => {
    it('is the wall time N sim frames take at the given speed', () => {
        // 3 frames at 30 Hz = 100 ms at 1×…
        expect(shotIntervalMs(3, 1)).toBeCloseTo(100, 6);
        // …and a full second at 0.1×, which is the whole reason slow motion
        // is wired into the capture flow: 100 ms is not a spacing any
        // relay-driven loop can hit.
        expect(shotIntervalMs(3, 0.1)).toBeCloseTo(1000, 6);
        expect(shotIntervalMs(1, 1)).toBeCloseTo(1000 / GAME_SPEED, 6);
    });

    it('reports 0 for a stopped sim — there is no such wall interval', () => {
        expect(shotIntervalMs(3, 0)).toBe(0);
        expect(shotIntervalMs(3, Number.NaN)).toBe(0);
    });

    it('floors the stride at one frame', () => {
        expect(shotIntervalMs(0, 1)).toBeCloseTo(1000 / GAME_SPEED, 6);
        expect(shotIntervalMs(-5, 1)).toBeCloseTo(1000 / GAME_SPEED, 6);
    });
});

describe('clamps', () => {
    it('keeps a frame count inside what a burst can return', () => {
        expect(clampFrames(undefined)).toBe(6);
        expect(clampFrames(1)).toBe(2);          // one frame is not a sequence
        expect(clampFrames(500)).toBe(MAX_SEQUENCE_FRAMES);
        expect(clampFrames(7.9)).toBe(7);
    });

    it('keeps sim speed inside the server verb range', () => {
        expect(clampSimSpeed(0.1)).toBe(0.1);
        expect(clampSimSpeed(0)).toBe(0.05);
        expect(clampSimSpeed(1e6)).toBe(100);
        expect(clampSimSpeed(Number.NaN)).toBe(1);
    });

    it('trades resolution for frame count', () => {
        expect(sequenceMaxDim(2)).toBe(1280);
        expect(sequenceMaxDim(8)).toBe(800);
        expect(sequenceMaxDim(40)).toBe(512);
        // Monotonic: more frames never asks for a bigger image.
        for (let n = 2; n < 40; n++) {
            expect(sequenceMaxDim(n + 1)).toBeLessThanOrEqual(sequenceMaxDim(n));
        }
    });
});

describe('wire budget', () => {
    it('rejects the shot that would push the reply past the cap', () => {
        expect(wireBudgetExceeded(0, 100)).toBe(false);
        expect(wireBudgetExceeded(SEQUENCE_WIRE_BUDGET_CHARS - 50, 100)).toBe(true);
    });

    it('sums the payload of the frames actually collected', () => {
        expect(payloadChars(['abc', 'de'])).toBe(5);
        expect(payloadChars([])).toBe(0);
    });
});

describe('summariseSequence', () => {
    it('accepts a burst whose frames actually advance', () => {
        const s = summariseSequence(
            [shot(0, 100, 0), shot(1, 103, 1000), shot(2, 106, 2000)],
            { expectedStride: 3, mode: 'step' });
        expect(s.ok).toBe(true);
        expect(s.diagnosis).toBeNull();
        expect(s.distinctGameFrames).toBe(3);
        expect(s.simFramesSpanned).toBe(6);
        expect(s.frameDeltas).toEqual([3, 3]);
        expect(s.wallMs).toBe(2000);
        expect(s.warnings).toEqual([]);
    });

    it('FAILS a burst of N shots of the same sim frame — a still life, not a film', () => {
        const s = summariseSequence([shot(0, 500, 0), shot(1, 500, 900), shot(2, 500, 1800)]);
        expect(s.ok).toBe(false);
        expect(s.distinctGameFrames).toBe(1);
        expect(s.simFramesSpanned).toBe(0);
        expect(s.diagnosis).toMatch(/did not advance/);
        // and it names what to check, not just that it is broken
        expect(s.diagnosis).toMatch(/pause_sim|sim_step/);
    });

    it('fails a burst that is black all the way through', () => {
        const s = summariseSequence([
            shot(0, 100, 0, { black: true }),
            shot(1, 103, 100, { black: true }),
        ]);
        expect(s.ok).toBe(false);
        expect(s.diagnosis).toMatch(/black/);
        expect(s.blackFrames).toEqual([0, 1]);
    });

    it('warns about — but does not fail — a partly black burst', () => {
        const s = summariseSequence([
            shot(0, 100, 0),
            shot(1, 103, 100, { black: true }),
            shot(2, 106, 200),
        ]);
        expect(s.ok).toBe(true);
        expect(s.blackFrames).toEqual([1]);
        expect(s.warnings.join(' ')).toMatch(/1 of 3 frames came back black/);
    });

    it('flags uneven spacing, and blames the mode that produced it', () => {
        const realtime = summariseSequence(
            [shot(0, 100, 0), shot(1, 112, 400), shot(2, 115, 800)],
            { expectedStride: 3, mode: 'realtime' });
        expect(realtime.ok).toBe(true);   // usable, just not measurable
        expect(realtime.warnings.join(' ')).toMatch(/wall-clock pacing/);
        expect(realtime.warnings.join(' ')).toMatch(/mode:"step"/);

        const stepped = summariseSequence(
            [shot(0, 100, 0), shot(1, 112, 400), shot(2, 115, 800)],
            { expectedStride: 3, mode: 'step' });
        expect(stepped.warnings.join(' ')).toMatch(/step did not land/);
    });

    it('does not cry uneven over a spacing that is merely off by rounding', () => {
        const s = summariseSequence(
            [shot(0, 100, 0), shot(1, 104, 400), shot(2, 107, 800)],
            { expectedStride: 3, mode: 'realtime' });
        expect(s.warnings).toEqual([]);
    });

    it('calls an empty burst what it is', () => {
        const s = summariseSequence([]);
        expect(s.ok).toBe(false);
        expect(s.frames).toBe(0);
        expect(s.diagnosis).toMatch(/no frames/);
    });
});
