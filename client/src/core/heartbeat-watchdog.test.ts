import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeartbeatWatchdog } from './heartbeat-watchdog.js';

describe('HeartbeatWatchdog', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('never fires onWedged while the ping keeps resolving promptly', async () => {
        const ping = vi.fn().mockResolvedValue(undefined);
        const onWedged = vi.fn();
        const onRecovered = vi.fn();
        const wd = new HeartbeatWatchdog({ ping, isSuppressed: () => false, onWedged, onRecovered });
        wd.start();
        for (let i = 0; i < 10; i++) {
            await vi.advanceTimersByTimeAsync(2000);
        }
        expect(onWedged).not.toHaveBeenCalled();
        expect(onRecovered).not.toHaveBeenCalled();
        expect(wd.wedged).toBe(false);
    });

    it('declares wedged after 3 consecutive missed 2s beats, and only once', async () => {
        const ping = vi.fn(() => new Promise(() => { /* never resolves */ }));
        const onWedged = vi.fn();
        const onRecovered = vi.fn();
        const wd = new HeartbeatWatchdog({ ping, isSuppressed: () => false, onWedged, onRecovered });
        wd.start();

        await vi.advanceTimersByTimeAsync(2000); // tick 1: ping sent, in flight
        expect(onWedged).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000); // tick 2: miss 1
        expect(onWedged).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000); // tick 3: miss 2
        expect(onWedged).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000); // tick 4: miss 3 -> wedged
        expect(onWedged).toHaveBeenCalledTimes(1);
        expect(wd.wedged).toBe(true);

        // Stays wedged, but onWedged doesn't refire every subsequent tick.
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(2000);
        expect(onWedged).toHaveBeenCalledTimes(1);
    });

    it('recovers and reports onRecovered once the ping resolves again', async () => {
        let resolvePing: (() => void) | null = null;
        const ping = vi.fn(() => new Promise<void>((resolve) => { resolvePing = resolve; }));
        const onWedged = vi.fn();
        const onRecovered = vi.fn();
        const wd = new HeartbeatWatchdog({ ping, isSuppressed: () => false, onWedged, onRecovered });
        wd.start();

        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(2000);
        expect(onWedged).not.toHaveBeenCalled();

        // The outstanding ping finally answers before the next tick.
        resolvePing!();
        await vi.advanceTimersByTimeAsync(0);
        expect(onRecovered).toHaveBeenCalledTimes(1);
        expect(wd.wedged).toBe(false);
        expect(wd.missCount).toBe(0);
    });

    it('E3 discipline: suppressed ticks (tab hidden / test.pause()) never count as misses', async () => {
        const ping = vi.fn(() => new Promise(() => { /* never resolves */ }));
        const onWedged = vi.fn();
        const onRecovered = vi.fn();
        let suppressed = true;
        const wd = new HeartbeatWatchdog({ ping, isSuppressed: () => suppressed, onWedged, onRecovered });
        wd.start();

        for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(2000);
        expect(ping).not.toHaveBeenCalled();
        expect(onWedged).not.toHaveBeenCalled();

        // Unsuppressing resumes normal miss counting from zero.
        suppressed = false;
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(2000);
        expect(onWedged).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        await vi.advanceTimersByTimeAsync(2000);
        expect(onWedged).toHaveBeenCalledTimes(1);
    });

    it('a slow-but-alive frame never trips the watchdog (rides its own timer, not the render loop)', async () => {
        // A ping that resolves after 1900ms — under the 2s interval — is
        // "slow" (LuaUI's measured 90ms frames are nothing by comparison)
        // but must never miss a beat.
        const ping = vi.fn(() => new Promise((resolve) => setTimeout(resolve, 1900)));
        const onWedged = vi.fn();
        const wd = new HeartbeatWatchdog({ ping, isSuppressed: () => false, onWedged, onRecovered: () => {} });
        wd.start();
        for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(2000);
        expect(onWedged).not.toHaveBeenCalled();
    });

    it('stop() clears the timer and resets state', async () => {
        const ping = vi.fn(() => new Promise(() => { /* never resolves */ }));
        const onWedged = vi.fn();
        const wd = new HeartbeatWatchdog({ ping, isSuppressed: () => false, onWedged, onRecovered: () => {} });
        wd.start();
        await vi.advanceTimersByTimeAsync(6000);
        wd.stop();
        expect(wd.wedged).toBe(false);
        expect(wd.missCount).toBe(0);
        await vi.advanceTimersByTimeAsync(10000);
        expect(onWedged).not.toHaveBeenCalled();
    });
});
