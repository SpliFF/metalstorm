import { describe, it, expect } from 'vitest';
import { ServerClock } from './clock';

describe('ServerClock', () => {
    it('estimates zero offset for synchronized clocks', () => {
        const clock = new ServerClock();
        // Client sends at t=100, server at t=100, client receives at t=110 (RTT=10)
        clock.addSample(100, 105, 110);
        expect(clock.getOffset()).toBeCloseTo(0, 0);
    });

    it('estimates positive offset when server is ahead', () => {
        const clock = new ServerClock();
        // Client sends at t=100, server at t=205, client receives at t=110 (RTT=10)
        // Server time at midpoint = 205, client midpoint = 105, offset = +100
        clock.addSample(100, 205, 110);
        expect(clock.getOffset()).toBeCloseTo(100, 0);
    });

    it('uses median for stability', () => {
        const clock = new ServerClock();
        clock.addSample(100, 105, 110); // offset ~0
        clock.addSample(200, 205, 210); // offset ~0
        clock.addSample(300, 999, 310); // outlier offset ~694
        // Median of [0, 0, 694] = 0
        expect(Math.abs(clock.getOffset())).toBeLessThan(5);
    });

    it('converts local time to server time', () => {
        const clock = new ServerClock();
        clock.addSample(100, 155, 110); // offset = 155 - 105 = 50
        expect(clock.toServerTime(200)).toBeCloseTo(250, 0);
    });
});

/// PLAN-latency L2.3 — the boot-stall RTT contamination fix. A symmetric EMA
/// let one pathological first sample (the pong queued behind the content load)
/// hold D at its ceiling for minutes, which suppressed Tier-C cosmetic flights
/// entirely. RTT now adopts improvements immediately and damps regressions.
describe('ServerClock RTT smoothing (asymmetric)', () => {
    /// Send/receive pair producing exactly `rtt` ms with a zero clock offset.
    const ping = (clock: ServerClock, t: number, rtt: number) =>
        clock.addSample(t, t + rtt / 2, t + rtt);

    it('seeds directly from the first sample', () => {
        const clock = new ServerClock();
        ping(clock, 0, 80);
        expect(clock.getRtt()).toBeCloseTo(80, 6);
        expect(clock.getOneWayLatency()).toBeCloseTo(40, 6);
    });

    it('adopts a lower sample immediately — one clean pong clears a boot stall', () => {
        const clock = new ServerClock();
        ping(clock, 0, 45_000);       // first ping measured across the load stall
        expect(clock.getRtt()).toBeCloseTo(45_000, 6);
        ping(clock, 50_000, 72);      // first ping after the page is interactive
        expect(clock.getRtt()).toBeCloseTo(72, 6);
    });

    it('damps a single high sample instead of adopting it', () => {
        const clock = new ServerClock();
        ping(clock, 0, 80);
        ping(clock, 1000, 480);       // one-off hitch
        // 80*0.7 + 480*0.3 = 200, not 480.
        expect(clock.getRtt()).toBeCloseTo(200, 6);
    });

    it('still climbs when the link genuinely degrades', () => {
        const clock = new ServerClock();
        ping(clock, 0, 80);
        for (let i = 1; i <= 12; i++) ping(clock, i * 1000, 400);
        // Sustained 400 ms samples walk the estimate up to (nearly) 400.
        expect(clock.getRtt()).toBeGreaterThan(390);
        expect(clock.getRtt()).toBeLessThanOrEqual(400);
    });

    it('tracks the floor across an alternating good/bad sequence', () => {
        const clock = new ServerClock();
        ping(clock, 0, 5_000);
        for (let i = 1; i <= 6; i++) {
            ping(clock, i * 2000, i % 2 === 0 ? 900 : 70);
        }
        // Every clean 70 ms sample re-floors it; the interleaved 900 ms ones
        // can only lift it part-way before the next clean one lands.
        expect(clock.getRtt()).toBeLessThan(320);
    });

    it('ignores negative or non-finite round trips', () => {
        const clock = new ServerClock();
        ping(clock, 0, 80);
        clock.addSample(1000, 1000, 900);            // receive before send
        expect(clock.getRtt()).toBeCloseTo(80, 6);
        clock.addSample(2000, NaN, Number.NaN);
        expect(clock.getRtt()).toBeCloseTo(80, 6);
    });
});
