import { describe, it, expect } from 'vitest';
import { netSimDecide, type NetSimConfig } from './net-sim.js';

const off: NetSimConfig = { enabled: false, delayMs: 0, jitterMs: 0, lossProb: 0 };
const wan: NetSimConfig = { enabled: true, delayMs: 80, jitterMs: 15, lossProb: 0.005 };
const flat: NetSimConfig = { enabled: true, delayMs: 100, jitterMs: 0, lossProb: 0 };

/** Deterministic sample source — hands out the given values in order, then 0. */
function samples(...vals: number[]): () => number {
    let i = 0;
    return () => (i < vals.length ? vals[i++] : 0);
}

const STATE = true;
const RELIABLE = false;

describe('netSimDecide — disarmed', () => {
    it('passes everything through untouched', () => {
        expect(netSimDecide(off, STATE, 1000, 0, samples()).kind).toBe('pass');
        expect(netSimDecide(off, RELIABLE, 1000, 0, samples()).kind).toBe('pass');
    });
});

describe('netSimDecide — loss is datagram-only', () => {
    it('drops a state envelope when the loss roll lands under lossProb', () => {
        // first sample is the loss roll
        expect(netSimDecide(wan, STATE, 0, 0, samples(0.001)).kind).toBe('drop');
    });

    it('keeps a state envelope when the loss roll lands above lossProb', () => {
        expect(netSimDecide(wan, STATE, 0, 0, samples(0.9, 0.5)).kind).toBe('delay');
    });

    it('NEVER drops a reliable envelope, even on a loss roll of 0', () => {
        // A reliable QUIC stream retransmits — dropping control messages
        // (auth, Pong, GameEventBatch) would be unrepresentative.
        const cfg: NetSimConfig = { ...wan, lossProb: 1 };
        for (let i = 0; i < 20; i++) {
            expect(netSimDecide(cfg, RELIABLE, i, 0, samples(0)).kind).not.toBe('drop');
        }
    });
});

describe('netSimDecide — base delay', () => {
    it('delays by delayMs with no jitter', () => {
        const v = netSimDecide(flat, RELIABLE, 500, 0, samples());
        expect(v).toMatchObject({ kind: 'delay', delayMs: 100 });
    });

    it('applies jitter symmetrically about delayMs', () => {
        // jitter roll 1.0 → +jitterMs, roll 0.0 → −jitterMs
        const hi = netSimDecide(wan, STATE, 0, 0, samples(0.9, 1.0));
        const lo = netSimDecide(wan, STATE, 0, 0, samples(0.9, 0.0));
        expect(hi).toMatchObject({ kind: 'delay', delayMs: 95 });
        expect(lo).toMatchObject({ kind: 'delay', delayMs: 65 });
    });

    it('never produces a negative delay when jitter exceeds the base', () => {
        // lossProb 0 ⇒ no loss roll is drawn, so the single sample is the jitter roll.
        const cfg: NetSimConfig = { enabled: true, delayMs: 5, jitterMs: 40, lossProb: 0 };
        const v = netSimDecide(cfg, STATE, 0, 0, samples(0.0));
        expect(v.kind).toBe('pass'); // 5 − 40 clamps to 0 ⇒ immediate
    });
});

describe('netSimDecide — the state lane reorders', () => {
    it('gives each state envelope an independent delay, so later can land first', () => {
        // Two envelopes arriving 5 ms apart; the first gets +jitter, the
        // second −jitter. Absolute release times cross over ⇒ reorder, which
        // is exactly what PresentationClock's base_frame tracking must detect.
        const first = netSimDecide(wan, STATE, 1000, 0, samples(0.9, 1.0));
        const second = netSimDecide(wan, STATE, 1005, 0, samples(0.9, 0.0));
        expect(first.kind).toBe('delay');
        expect(second.kind).toBe('delay');
        const firstAt = 1000 + (first as { delayMs: number }).delayMs;   // 1095
        const secondAt = 1005 + (second as { delayMs: number }).delayMs; // 1070
        expect(secondAt).toBeLessThan(firstAt);
    });

    it('does not advance the ordered-lane cursor', () => {
        const v = netSimDecide(wan, STATE, 1000, 4242, samples(0.9, 0.5));
        expect(v).toMatchObject({ streamReleaseAt: 4242 });
    });
});

describe('netSimDecide — the reliable lane preserves arrival order', () => {
    it('head-of-line-blocks a burst: releases are monotonic despite jitter', () => {
        // Ten envelopes arriving 1 ms apart — far tighter than the ±15 ms
        // jitter — with alternating extreme jitter rolls. Threading the cursor
        // through must still yield non-decreasing release times.
        let cursor = 0;
        const releases: number[] = [];
        for (let i = 0; i < 10; i++) {
            const now = 1000 + i;
            const jitterRoll = i % 2 === 0 ? 1.0 : 0.0;
            // Reliable lane consumes only the jitter roll — no loss roll.
            const v = netSimDecide(wan, RELIABLE, now, cursor, samples(jitterRoll));
            if (v.kind === 'delay') {
                cursor = v.streamReleaseAt;
                releases.push(now + v.delayMs);
            } else {
                releases.push(now);
            }
        }
        for (let i = 1; i < releases.length; i++) {
            expect(releases[i]).toBeGreaterThanOrEqual(releases[i - 1]);
        }
    });

    it('a late envelope delays the ones queued behind it', () => {
        // First takes the maximum jitter (+15 ⇒ due at 1095). The second
        // arrives 1 ms later wanting only 65 ms (due at 1066) but must wait
        // for 1095 instead.
        const a = netSimDecide(wan, RELIABLE, 1000, 0, samples(1.0));
        expect(a).toMatchObject({ kind: 'delay', streamReleaseAt: 1095 });
        const b = netSimDecide(wan, RELIABLE, 1001, 1095, samples(0.0));
        expect(b).toMatchObject({ kind: 'delay', streamReleaseAt: 1095 });
        expect((b as { delayMs: number }).delayMs).toBe(94); // 1095 − 1001
    });

    it('stops clamping once arrivals are spaced wider than the jitter range', () => {
        // A cursor far in the past must not inflate the next delay.
        const v = netSimDecide(flat, RELIABLE, 10_000, 500, samples());
        expect(v).toMatchObject({ kind: 'delay', delayMs: 100, streamReleaseAt: 10_100 });
    });

    it('honours a still-future cursor even at zero base delay', () => {
        const cfg: NetSimConfig = { enabled: true, delayMs: 0, jitterMs: 0, lossProb: 0.5 };
        const v = netSimDecide(cfg, RELIABLE, 1000, 1050, samples(0));
        expect(v).toMatchObject({ kind: 'delay', delayMs: 50, streamReleaseAt: 1050 });
    });
});
