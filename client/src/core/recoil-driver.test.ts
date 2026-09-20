import { describe, it, expect } from 'vitest';
import { RecoilDriver, recoilKickElmos, recoilReturnMs } from './recoil-driver.js';

describe('recoilKickElmos / recoilReturnMs', () => {
    it('scales with aoe and velocity, clamped to a readable range', () => {
        const mg = recoilKickElmos(8, 800 / 30);
        const railgun = recoilKickElmos(16, 1800 / 30);
        expect(mg).toBeGreaterThan(0);
        expect(railgun).toBeGreaterThan(mg);
        expect(railgun).toBeLessThanOrEqual(1.6);
        expect(recoilKickElmos(0, 0)).toBeGreaterThanOrEqual(0.12);
    });

    it('return time stays within the 60-140ms band', () => {
        expect(recoilReturnMs(0)).toBeCloseTo(60, 5);
        expect(recoilReturnMs(1.6)).toBeCloseTo(140, 5);
        const mid = recoilReturnMs(recoilKickElmos(16, 1800 / 30));
        expect(mid).toBeGreaterThanOrEqual(60);
        expect(mid).toBeLessThanOrEqual(140);
    });
});

describe('RecoilDriver', () => {
    it('kicks, peaks, and returns to 0 within 300ms', () => {
        const d = new RecoilDriver();
        d.kick('u1:1', 24, 650 / 30);
        let peak = 0;
        for (let i = 0; i < 300; i++) {
            d.tick(1 / 1000);
            peak = Math.max(peak, Math.abs(d.offset('u1:1')));
        }
        expect(peak).toBeGreaterThan(0);
        expect(Math.abs(d.offset('u1:1'))).toBeLessThan(1e-3);
    });

    it('is a no-op with no NaN at dt=0, before or after a kick', () => {
        const d = new RecoilDriver();
        expect(() => d.tick(0)).not.toThrow();
        d.kick('u1:1', 24, 650 / 30);
        d.tick(0);
        expect(d.offset('u1:1')).not.toBeNaN();
        expect(Number.isFinite(d.offset('u1:1'))).toBe(true);
    });

    it('stacks a re-kick mid-recoil instead of resetting', () => {
        const d = new RecoilDriver();
        d.kick('u1:1', 24, 650 / 30);
        d.tick(0.01);
        const mid = d.offset('u1:1');
        d.kick('u1:1', 24, 650 / 30);
        d.tick(0.001);
        expect(d.offset('u1:1')).toBeGreaterThan(mid);
    });

    it('offset is 0 for a key that was never kicked', () => {
        const d = new RecoilDriver();
        expect(d.offset('unknown')).toBe(0);
    });

    it('drops settled springs so the map does not grow unbounded', () => {
        const d = new RecoilDriver();
        d.kick('u1:1', 24, 650 / 30);
        for (let i = 0; i < 300; i++) d.tick(1 / 1000);
        expect(d.size).toBe(0);
    });
});
