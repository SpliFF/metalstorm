import { describe, it, expect } from 'vitest';
import { MotionLeanRegistry } from './motion-lean.js';

const CMD_MOVE = 10;
const CMD_STOP = 0;
const CMD_ATTACK = 20;
const CMD_FIRE_STATE = 45;
const BUILD_CMD = -42;

/** Registry with a controllable clock, so the ramp/hold/decay boundaries are
 *  exact rather than slept-through. RTT 100 ⇒ hold = max(700, 2·100+300) = 700. */
function mk(rttMs = 100) {
    let t = 0;
    const warnings: string[] = [];
    const reg = new MotionLeanRegistry({
        getRttMs: () => rttMs,
        now: () => t,
        warn: (m) => warnings.push(m),
    });
    return {
        reg,
        warnings,
        /** Advance the clock and roll the frame (clearing the per-frame memo),
         *  which is what the render loop does. */
        frame: (ms: number) => { t += ms; reg.beginFrame(); },
    };
}

const MAX_ELMOS = 6;
const RAMP_MS = 250;

describe('MotionLeanRegistry', () => {
    it('leans toward the waypoint as soon as the order is sent', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        frame(RAMP_MS); // fully ramped, unit has not moved
        const o = reg.offsetFor(7, 0, 0, 0)!;
        expect(o).not.toBeNull();
        // Waypoint is at +X, so the lean is pure +X at the cap.
        expect(o.dx).toBeCloseTo(MAX_ELMOS, 5);
        expect(o.dz).toBeCloseTo(0, 5);
    });

    it('never exceeds the bound, and never fires the correction alarm', () => {
        const { reg, frame, warnings } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [9000, 0, 9000] });
        for (let i = 0; i < 40; i++) {
            frame(20);
            const o = reg.offsetFor(7, 0, 0, 0);
            if (o) expect(Math.hypot(o.dx, o.dz)).toBeLessThanOrEqual(MAX_ELMOS + 1e-9);
        }
        const s = reg.stats();
        expect(s.maxOffsetElmos).toBeLessThanOrEqual(s.maxLeanElmos);
        expect(s.boundExceededTotal).toBe(0);
        expect(warnings).toEqual([]);
    });

    it('gives the lead back one-for-one as the authoritative pose advances', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        // Heading 49152 already faces +X under the renderer's yaw convention,
        // so the heading half of the lean is zero throughout and this test
        // isolates the positional half.
        const FACING_PLUS_X = 49152;
        frame(RAMP_MS);
        reg.offsetFor(7, 0, 0, FACING_PLUS_X); // latches the origin at x=0

        // Server pose has now moved 2 elmos along the order direction.
        frame(16);
        const o2 = reg.offsetFor(7, 2, 0, FACING_PLUS_X)!;
        expect(o2.dx).toBeCloseTo(MAX_ELMOS - 2, 5);

        // 4 more elmos: the lead is fully absorbed and the lean retires.
        frame(16);
        expect(reg.offsetFor(7, 6, 0, FACING_PLUS_X)).toBeNull();
        expect(reg.stats().absorbedTotal).toBe(1);
        expect(reg.stats().decayedTotal).toBe(0);
    });

    it('the heading lean outlives the positional one if the unit has not turned', () => {
        // Found by the test above: the two halves absorb independently. A unit
        // whose server pose slides toward the waypoint without turning has its
        // positional lead absorbed while the pre-turn is still unearned, and
        // holding the turn is right — it is still the cue the player is owed.
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        frame(RAMP_MS);
        reg.offsetFor(7, 0, 0, 0);
        frame(16);
        const o = reg.offsetFor(7, 20, 0, 0)!;
        expect(o.dx).toBe(0);
        expect(Math.abs(o.dHeading)).toBeGreaterThan(0);
    });

    it('the drawn position never moves backwards while the lean is absorbed', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        let x = 0;
        let prevDrawn = -Infinity;
        for (let i = 0; i < 60; i++) {
            frame(16);
            const o = reg.offsetFor(7, x, 0, 0);
            const drawn = x + (o?.dx ?? 0);
            expect(drawn).toBeGreaterThanOrEqual(prevDrawn - 1e-9);
            prevDrawn = drawn;
            x += 1.2; // authoritative motion, slower than the ramp
        }
    });

    it('eases out when the order never happens, and counts it as a correction', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        frame(RAMP_MS);
        expect(reg.offsetFor(7, 0, 0, 0)!.dx).toBeCloseTo(MAX_ELMOS, 5);

        // Hold is 700 ms; still at full lean just inside it.
        frame(400);
        expect(reg.offsetFor(7, 0, 0, 0)!.dx).toBeCloseTo(MAX_ELMOS, 5);

        // Past the hold, the offset shrinks monotonically...
        frame(200);
        const mid = reg.offsetFor(7, 0, 0, 0)!.dx;
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThan(MAX_ELMOS);

        // ...and is gone once the decay completes.
        frame(400);
        expect(reg.offsetFor(7, 0, 0, 0)).toBeNull();
        expect(reg.stats().decayedTotal).toBe(1);
        expect(reg.stats().absorbedTotal).toBe(0);
    });

    it('a unit that is turning holds its lean past the nominal hold window', () => {
        // Found live on meridian_basin 2026-08-04: a tank ordered to reverse
        // spends over a second turning before it translates at all. Sizing the
        // hold from the click expired it mid-turn and the body decayed
        // backwards for 14 frames. The hold is a window of *silence*.
        const { reg, frame } = mk(); // hold = 700 ms
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        let heading = 0;
        frame(RAMP_MS);
        reg.offsetFor(7, 0, 0, heading);
        // 2 s of turning in place — well past 700 ms, no translation at all.
        for (let i = 0; i < 20; i++) {
            frame(100);
            heading = (heading + 400) % 65536;
            expect(reg.offsetFor(7, 0, 0, heading)).not.toBeNull();
        }
        expect(reg.stats().decayedTotal).toBe(0);
    });

    it('the drawn position does not go backwards while the unit turns then moves', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        let heading = 0, x = 0, prevDrawn = -Infinity;
        for (let i = 0; i < 80; i++) {
            frame(50);
            if (i < 24) heading = (heading + 900) % 65536; // turn in place
            else x += 1.5;                                 // then translate
            const o = reg.offsetFor(7, x, 0, heading);
            const drawn = x + (o?.dx ?? 0);
            expect(drawn).toBeGreaterThanOrEqual(prevDrawn - 1e-9);
            prevDrawn = drawn;
        }
        expect(reg.stats().decayedTotal).toBe(0);
    });

    it('still decays when the unit does nothing at all', () => {
        // The silence timeout must not become "never expires".
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        for (let i = 0; i < 40; i++) { frame(50); reg.offsetFor(7, 0, 0, 0); }
        expect(reg.offsetFor(7, 0, 0, 0)).toBeNull();
        expect(reg.stats().decayedTotal).toBe(1);
    });

    it('turns toward the waypoint, bounded to the heading cap', () => {
        const { reg, frame } = mk();
        // Waypoint straight behind: a 180° turn, far past the 30° cap.
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [0, 0, 1000] });
        frame(RAMP_MS);
        const o = reg.offsetFor(7, 0, 0, 0)!;
        const cap = Math.round((30 / 360) * 65536);
        expect(Math.abs(o.dHeading)).toBeGreaterThan(0);
        expect(Math.abs(o.dHeading)).toBeLessThanOrEqual(cap);
    });

    it('faces the waypoint when the turn is inside the cap', () => {
        const { reg, frame } = mk();
        // Waypoint at -Z is heading 0 under the renderer's yaw convention
        // (forward is local -Z), so a unit at heading 0 needs no turn at all.
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [0, 0, -1000] });
        frame(RAMP_MS);
        const o = reg.offsetFor(7, 0, 0, 0)!;
        expect(o.dHeading).toBe(0);
        expect(o.dz).toBeCloseTo(-MAX_ELMOS, 5);
    });

    it('never leans past its own waypoint on a short nudge order', () => {
        // Beyond 12 elmos the elmo cap binds and the half-distance clamp is
        // slack; inside it the clamp takes over and the lean tapers.
        const far = mk();
        far.reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [20, 0, 0] });
        far.frame(RAMP_MS);
        expect(far.reg.offsetFor(7, 0, 0, 0)!.dx).toBeCloseTo(MAX_ELMOS, 5);

        const near = mk();
        near.reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [8], params: [10, 0, 0] });
        near.frame(RAMP_MS);
        expect(near.reg.offsetFor(8, 0, 0, 0)!.dx).toBeCloseTo(5, 5);
    });

    it('ignores orders that are not "go there"', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: BUILD_CMD, unitIds: [7], params: [100, 0, 100] });
        reg.onCommandSent({ commandId: CMD_FIRE_STATE, unitIds: [8], params: [0] });
        reg.onCommandSent({ commandId: CMD_ATTACK, unitIds: [9], params: [1234] });
        frame(RAMP_MS);
        expect(reg.offsetFor(7, 0, 0, 0)).toBeNull();
        expect(reg.offsetFor(8, 0, 0, 0)).toBeNull();
        expect(reg.offsetFor(9, 0, 0, 0)).toBeNull();
        expect(reg.stats().startedTotal).toBe(0);
    });

    it('a positional ATTACK order does lean', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_ATTACK, unitIds: [7], params: [500, 0, 0] });
        frame(RAMP_MS);
        expect(reg.offsetFor(7, 0, 0, 0)!.dx).toBeCloseTo(MAX_ELMOS, 5);
    });

    it('STOP drops the lean — the player refuted their own order', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        frame(RAMP_MS);
        expect(reg.offsetFor(7, 0, 0, 0)).not.toBeNull();
        reg.onCommandSent({ commandId: CMD_STOP, unitIds: [7], params: [] });
        frame(16);
        expect(reg.offsetFor(7, 0, 0, 0)).toBeNull();
    });

    it('a newer order replaces the older one for the same unit', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        frame(RAMP_MS);
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [-1000, 0, 0] });
        frame(RAMP_MS);
        expect(reg.size).toBe(1);
        expect(reg.offsetFor(7, 0, 0, 0)!.dx).toBeCloseTo(-MAX_ELMOS, 5);
    });

    it('does not lean toward a waypoint the unit is already standing on', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [4, 0, 0] });
        frame(RAMP_MS);
        expect(reg.offsetFor(7, 0, 0, 0)).toBeNull();
    });

    it('memoises within a frame so body and selection ring agree', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        frame(RAMP_MS);
        const a = reg.offsetFor(7, 0, 0, 0)!;
        // Second ask in the same frame, deliberately with a different pose:
        // the memo must win, or the ring and the body would disagree.
        const b = reg.offsetFor(7, 500, 0, 0)!;
        expect(b).toEqual(a);
        expect(reg.stats().active).toBe(0); // rolled over only by beginFrame
        frame(16);
        expect(reg.stats().active).toBe(1); // counted once, not twice
    });

    it('expires a lean for a unit that stops being drawn', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        expect(reg.size).toBe(1);
        // Unit died: never queried again. hold (700) + decay (400) elapses.
        frame(600);
        frame(600);
        expect(reg.size).toBe(0);
        expect(reg.stats().decayedTotal).toBe(1);
    });

    it('clear() drops everything (quit to lobby / reconnect)', () => {
        const { reg, frame } = mk();
        reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7, 8, 9], params: [1000, 0, 0] });
        expect(reg.size).toBe(3);
        reg.clear();
        frame(RAMP_MS);
        expect(reg.size).toBe(0);
        expect(reg.offsetFor(7, 0, 0, 0)).toBeNull();
    });

    it('a stalled link widens the hold instead of snapping the body back', () => {
        const slow = mk(2000); // 2·2000 + 300 clamps to the 3000 ms ceiling
        slow.reg.onCommandSent({ commandId: CMD_MOVE, unitIds: [7], params: [1000, 0, 0] });
        slow.frame(RAMP_MS);
        slow.frame(2000);
        // Still leaning well past the 700 ms floor a LAN game would use.
        expect(slow.reg.offsetFor(7, 0, 0, 0)!.dx).toBeCloseTo(MAX_ELMOS, 5);
    });
});
