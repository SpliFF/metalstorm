import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecoveryLadder, type RecoveryLadderDeps } from './recovery-ladder.js';

/** Build a ladder over controllable deps. `now` is a manual clock (window
 *  accounting); the grace + softReset timers ride vi's fake setTimeout. */
function makeLadder(over: Partial<RecoveryLadderDeps> = {}) {
    let nowMs = 0;
    // Prefer an override for any injected fn so `h.softReset` is the SAME mock
    // the ladder actually calls (spreading softReset again would leave h.* stale).
    const softReset = (over.softReset ?? vi.fn<[], Promise<boolean>>().mockResolvedValue(true)) as ReturnType<typeof vi.fn>;
    const respawn = (over.respawn ?? vi.fn()) as ReturnType<typeof vi.fn>;
    const showErrorScreen = (over.showErrorScreen ?? vi.fn()) as ReturnType<typeof vi.fn>;
    const emitRungEvent = (over.emitRungEvent ?? vi.fn()) as ReturnType<typeof vi.fn>;
    const ladder = new RecoveryLadder({
        // tight caps + short grace keep the tests legible; the defaults are
        // r1Max=2 / r2Max=2 / grace=4000 / window=5min.
        r1Max: 2, r2Max: 2, contextRestoreGraceMs: 4000, windowMs: 300_000,
        ...over,
        softReset, respawn, showErrorScreen, emitRungEvent,
        now: () => nowMs,
    });
    return {
        ladder, softReset, respawn, showErrorScreen, emitRungEvent,
        setNow: (n: number) => { nowMs = n; },
        advanceNow: (d: number) => { nowMs += d; },
    };
}

/** Flush pending microtasks so a resolved softReset's `.then` runs. */
const flush = () => Promise.resolve().then(() => Promise.resolve());

const rungs = (emit: ReturnType<typeof vi.fn>): string[] =>
    emit.mock.calls.map((c) => (c[0] as { rung: string }).rung);

describe('RecoveryLadder', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('takes R1 (soft reset) when a lost context restores within the grace', async () => {
        const h = makeLadder();
        h.ladder.notifyContextLost();
        h.ladder.notifyContextRestored();
        await flush();
        expect(h.softReset).toHaveBeenCalledTimes(1);
        expect(h.respawn).not.toHaveBeenCalled();
        expect(rungs(h.emitRungEvent)).toEqual(['R1']);
        expect(h.ladder.isTerminal).toBe(false);
        expect(h.ladder.isRecovering).toBe(false); // cleared on successful ack
    });

    it('takes R2 (respawn) on a wedged worker', async () => {
        const h = makeLadder();
        h.ladder.trigger('wedged');
        await flush();
        expect(h.respawn).toHaveBeenCalledTimes(1);
        expect(h.softReset).not.toHaveBeenCalled();
        expect(rungs(h.emitRungEvent)).toEqual(['R2']);
    });

    it('takes R2 when a lost context never restores (grace times out)', async () => {
        const h = makeLadder();
        h.ladder.notifyContextLost();
        expect(h.respawn).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(4000); // grace expiry
        await flush();
        expect(h.respawn).toHaveBeenCalledTimes(1);
        expect(rungs(h.emitRungEvent)).toEqual(['R2']);
    });

    it('a restore inside the grace cancels the R2 timeout (soft R1 instead)', async () => {
        const h = makeLadder();
        h.ladder.notifyContextLost();
        await vi.advanceTimersByTimeAsync(1000);
        h.ladder.notifyContextRestored();
        await flush();
        await vi.advanceTimersByTimeAsync(5000); // past where the grace would have fired
        await flush();
        expect(h.softReset).toHaveBeenCalledTimes(1);
        expect(h.respawn).not.toHaveBeenCalled();
        expect(rungs(h.emitRungEvent)).toEqual(['R1']);
    });

    it('escalates R1 → R2 when the soft reset fails (worker cannot ack)', async () => {
        const h = makeLadder({ softReset: vi.fn().mockResolvedValue(false) });
        h.ladder.notifyContextLost();
        h.ladder.notifyContextRestored();
        await flush();
        expect(h.respawn).toHaveBeenCalledTimes(1);
        expect(rungs(h.emitRungEvent)).toEqual(['R1', 'R2']);
    });

    it('escalates R1 → R2 when the soft reset rejects', async () => {
        const h = makeLadder({ softReset: vi.fn().mockRejectedValue(new Error('gone')) });
        h.ladder.notifyContextRestored();
        await flush();
        expect(h.respawn).toHaveBeenCalledTimes(1);
        expect(rungs(h.emitRungEvent)).toEqual(['R1', 'R2']);
    });

    it('is monotonic: a third context restore escalates to R2 once r1Max R1s ran', async () => {
        const h = makeLadder();
        for (let i = 0; i < 3; i++) {
            h.ladder.notifyContextRestored();
            await flush();
        }
        // First two restores are R1; the third can no longer ping-pong R1 — it
        // escalates to R2 (the loop guard's anti-storm property).
        expect(h.softReset).toHaveBeenCalledTimes(2);
        expect(h.respawn).toHaveBeenCalledTimes(1);
        expect(rungs(h.emitRungEvent)).toEqual(['R1', 'R1', 'R2']);
    });

    it('reaches R3 after r2Max respawns in the window, then goes terminal', async () => {
        const h = makeLadder();
        h.ladder.trigger('wedged'); await flush(); // R2 #1
        h.ladder.trigger('wedged'); await flush(); // R2 #2
        h.ladder.trigger('wedged'); await flush(); // → R3
        expect(h.respawn).toHaveBeenCalledTimes(2);
        expect(h.showErrorScreen).toHaveBeenCalledTimes(1);
        expect(h.ladder.isTerminal).toBe(true);
        expect(rungs(h.emitRungEvent)).toEqual(['R2', 'R2', 'R3']);
        // The report id handed to the screen matches the R3 telemetry event.
        const r3 = h.emitRungEvent.mock.calls.at(-1)![0] as { reportId: string };
        expect(h.showErrorScreen).toHaveBeenCalledWith(r3.reportId);
    });

    it('PROVABLE TERMINATION: a crash storm is bounded to r1Max+r2Max+1 actions then silent', async () => {
        const h = makeLadder();
        // 100 back-to-back fatals (a render loop throwing every frame).
        for (let i = 0; i < 100; i++) {
            h.ladder.trigger('fatal');
            await flush();
        }
        // Total recovery ACTIONS is bounded by the constant r1Max+r2Max+1 = 5,
        // regardless of trigger volume — no storm. All-fatal means no R1, so:
        expect(h.respawn).toHaveBeenCalledTimes(2);       // ≤ r2Max
        expect(h.showErrorScreen).toHaveBeenCalledTimes(1); // exactly one R3
        expect(h.emitRungEvent.mock.calls.length).toBeLessThanOrEqual(2 + 2 + 1);
        expect(h.ladder.isTerminal).toBe(true);
    });

    it('the recovering latch absorbs triggers that land mid-recovery (one action per episode)', async () => {
        let resolveSoft: ((ok: boolean) => void) | null = null;
        const softReset = vi.fn(() => new Promise<boolean>((r) => { resolveSoft = r; }));
        const h = makeLadder({ softReset });
        h.ladder.notifyContextRestored();        // starts R1 (softReset pending)
        expect(h.ladder.isRecovering).toBe(true);
        // A flood of fatals arrives while R1 is still in flight — all absorbed.
        for (let i = 0; i < 5; i++) h.ladder.trigger('fatal');
        expect(h.respawn).not.toHaveBeenCalled();
        expect(h.softReset).toHaveBeenCalledTimes(1);
        // The absorbed triggers still appear in the chain for telemetry.
        expect(h.ladder.triggerChain).toContain('fatal');
        resolveSoft!(true);
        await flush();
        expect(h.ladder.isRecovering).toBe(false);
        expect(rungs(h.emitRungEvent)).toEqual(['R1']); // still just the one rung
    });

    it('opens a fresh window (floor resets) after windowMs of non-terminal quiet', async () => {
        const h = makeLadder();
        h.ladder.notifyContextRestored(); await flush(); // R1 #1
        h.ladder.notifyContextRestored(); await flush(); // R1 #2 (r1 now at cap)
        expect(rungs(h.emitRungEvent)).toEqual(['R1', 'R1']);
        // Quiet past the window → counts + floor reset.
        h.advanceNow(300_001);
        h.ladder.notifyContextRestored(); await flush(); // R1 again, not escalated
        expect(h.softReset).toHaveBeenCalledTimes(3);
        expect(h.respawn).not.toHaveBeenCalled();
        expect(rungs(h.emitRungEvent)).toEqual(['R1', 'R1', 'R1']);
        expect(h.ladder.currentFloor).toBe(1);
    });

    it('every rung event carries the trigger chain + a citable report id', async () => {
        const h = makeLadder();
        h.ladder.notifyContextLost();
        h.ladder.notifyContextRestored();
        await flush();
        const ev = h.emitRungEvent.mock.calls[0][0] as {
            rung: string; reason: string; chain: string[]; reportId: string;
        };
        expect(ev.rung).toBe('R1');
        expect(ev.reason).toBe('context-restored');
        expect(ev.chain).toEqual(['context-lost', 'context-restored']);
        expect(ev.reportId).toMatch(/^rcv-[0-9a-f]+$/);
    });

    it('ignores all triggers once terminal (R3 is the end)', async () => {
        const h = makeLadder({ r2Max: 1 });
        h.ladder.trigger('wedged'); await flush(); // R2 #1
        h.ladder.trigger('wedged'); await flush(); // → R3 (r2Max=1)
        expect(h.ladder.isTerminal).toBe(true);
        const before = h.emitRungEvent.mock.calls.length;
        h.ladder.trigger('fatal');
        h.ladder.notifyContextLost();
        h.ladder.notifyContextRestored();
        await vi.advanceTimersByTimeAsync(5000);
        await flush();
        expect(h.emitRungEvent.mock.calls.length).toBe(before);
        expect(h.respawn).toHaveBeenCalledTimes(1);
    });

    it('reset() clears state so a new game session starts from a clean ladder', async () => {
        const h = makeLadder({ r2Max: 1 });
        h.ladder.trigger('wedged'); await flush();
        h.ladder.trigger('wedged'); await flush(); // R3
        expect(h.ladder.isTerminal).toBe(true);
        h.ladder.reset();
        expect(h.ladder.isTerminal).toBe(false);
        expect(h.ladder.currentFloor).toBe(0);
        expect(h.ladder.counts).toEqual({ r1: 0, r2: 0 });
        h.ladder.notifyContextRestored(); await flush();
        expect(h.softReset).toHaveBeenCalledTimes(1); // R1 works again
    });
});
