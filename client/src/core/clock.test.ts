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
