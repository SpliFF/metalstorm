import { describe, it, expect } from 'vitest';
import { IdRecycleGuard } from './id-recycle-guard.js';
import { FLAG_ID_RECYCLED, FIELD_ENTITY_IDS, parseEntityState } from './entity-state.js';

const PLAIN = FIELD_ENTITY_IDS;
const FLAGGED = FIELD_ENTITY_IDS | FLAG_ID_RECYCLED;

describe('IdRecycleGuard (PLAN-long-uptime S5 task 6)', () => {
    it('never fires without a flag', () => {
        const g = new IdRecycleGuard();
        expect(g.observe(PLAIN, true)).toBe(false);
        expect(g.observe(PLAIN, false)).toBe(false);
        expect(g.flushCount).toBe(0);
    });

    it('fires on a flagged full snapshot', () => {
        const g = new IdRecycleGuard();
        expect(g.observe(FLAGGED, false)).toBe(true);
        expect(g.flushCount).toBe(1);
    });

    it('latches on a flagged DELTA and fires on the next full snapshot', () => {
        // The server flags every message in the window; the lane is
        // newest-wins, so the one that lands may well be a delta.
        const g = new IdRecycleGuard();
        expect(g.observe(FLAGGED, true)).toBe(false);
        expect(g.isPending).toBe(true);
        // Unflagged deltas in between must not fire it either — firing on a
        // delta would blank every unit the delta did not mention.
        expect(g.observe(PLAIN, true)).toBe(false);
        expect(g.observe(PLAIN, false)).toBe(true);
    });

    it('fires exactly once per announcement', () => {
        const g = new IdRecycleGuard();
        g.observe(FLAGGED, true);
        expect(g.observe(FLAGGED, false)).toBe(true);
        // The server keeps flagging until a full snapshot has gone out after
        // the raise, so the client sees the flag again on messages that are
        // still part of the SAME window; each one re-latches and costs at most
        // one further flush, never a flush per message.
        expect(g.observe(PLAIN, false)).toBe(false);
        expect(g.observe(PLAIN, true)).toBe(false);
        expect(g.flushCount).toBe(1);
    });

    it('a reset drops a latched flag', () => {
        const g = new IdRecycleGuard();
        g.observe(FLAGGED, true);
        g.reset();
        expect(g.isPending).toBe(false);
        expect(g.observe(PLAIN, false)).toBe(false);
    });

    it('the flag survives the parser and costs no payload', () => {
        // Bit 15 has no per-entity array: a parser that reads fields under
        // their own bits must produce the identical snapshot either way, and
        // the buffer lengths must match.
        const build = (mask: number): Uint8Array => {
            const buf = new Uint8Array(8 + 4);
            const dv = new DataView(buf.buffer);
            dv.setUint32(0, 1234, true);
            dv.setUint16(4, 1, true);
            dv.setUint16(6, mask, true);
            dv.setUint32(8, 77, true);
            return buf;
        };
        const plain = parseEntityState(build(PLAIN))!;
        const flagged = parseEntityState(build(FLAGGED))!;
        expect(flagged).not.toBeNull();
        expect(Array.from(flagged.entityIds!)).toEqual([77]);
        expect(Array.from(plain.entityIds!)).toEqual([77]);
        expect(flagged.baseFrame).toBe(plain.baseFrame);
        expect(flagged.count).toBe(plain.count);
        expect((flagged.fieldMask & FLAG_ID_RECYCLED) !== 0).toBe(true);
        expect((plain.fieldMask & FLAG_ID_RECYCLED) !== 0).toBe(false);
    });
});
