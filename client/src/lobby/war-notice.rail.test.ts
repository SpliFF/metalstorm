/**
 * war-notice.rail.test.ts — the notice rail (review 2026-09-10, item (c)) and
 * the room-stream stall rule.
 *
 * The defect the rail is written against: a deploy hibernates every war at
 * once, and "one toast, newest wins" showed the LAST war's notice for 30 s
 * while the other two vanished unread.
 */

import { describe, it, expect } from 'vitest';
import {
    NOTICE_RAIL_CAP, dismissRailNotice, emptyRail, foldLabel, markRailRead,
    pushRailNotice, railGroups, railSummary, roomStreamRetryDelayMs,
    shouldRestartRoomStream, unreadCount, type WarNotice,
} from './war-notice';

function notice(over: Partial<WarNotice> = {}): WarNotice {
    return {
        roomId: 7, kind: 'hibernated', title: 'Meridian',
        detail: 'Your Mission went to sleep.', cls: 'war-notice-wait', canJoin: true,
        ...over,
    };
}

describe('the notice rail', () => {
    it('keeps a notice per war rather than one for the screen', () => {
        let rail = emptyRail();
        rail = pushRailNotice(rail, notice({ roomId: 1, title: 'A' }), 100);
        rail = pushRailNotice(rail, notice({ roomId: 2, title: 'B' }), 100);
        rail = pushRailNotice(rail, notice({ roomId: 3, title: 'C' }), 100);
        expect(rail.notices.map(n => n.title)).toEqual(['A', 'B', 'C']);
        expect(unreadCount(rail)).toBe(3);
        expect(railSummary(rail)).toBe('3 new');
    });

    it('a newer transition for the same war replaces its unread predecessor', () => {
        let rail = emptyRail();
        rail = pushRailNotice(rail, notice({ kind: 'resuming', detail: 'resuming', cls: 'war-notice-wait', canJoin: false }), 100);
        rail = pushRailNotice(rail, notice({ kind: 'back', detail: 'back', cls: 'war-notice-good' }), 130);
        expect(rail.notices).toHaveLength(1);
        expect(rail.notices[0]).toMatchObject({ kind: 'back', canJoin: true, count: 1 });
    });

    it('folds an exact repeat inside the window into a count', () => {
        let rail = emptyRail();
        rail = pushRailNotice(rail, notice(), 100);
        rail = pushRailNotice(rail, notice(), 105);
        expect(rail.notices).toHaveLength(1);
        expect(rail.notices[0].count).toBe(2);
        expect(rail.notices[0].at).toBe(105);
        expect(foldLabel(rail.notices[0])).toBe('×2');
        // Outside the window the same words are a war that moved again.
        rail = pushRailNotice(rail, notice(), 200);
        expect(rail.notices).toHaveLength(1);
        expect(rail.notices[0].count).toBe(1);
        expect(rail.notices[0].id).toBe(2);
    });

    it('a read notice is left alone; the new one is new', () => {
        let rail = emptyRail();
        rail = pushRailNotice(rail, notice({ kind: 'hibernated' }), 100);
        rail = markRailRead(rail, 'all');
        rail = pushRailNotice(rail, notice({ kind: 'back', detail: 'back', cls: 'war-notice-good' }), 200);
        expect(rail.notices).toHaveLength(2);
        expect(unreadCount(rail)).toBe(1);
        expect(railSummary(rail)).toBe('1 new');
        rail = markRailRead(rail, rail.notices[1].id);
        expect(railSummary(rail)).toBe('2 notices');
        expect(railSummary(emptyRail())).toBe('');
    });

    it('dismisses one, or every read one', () => {
        let rail = emptyRail();
        rail = pushRailNotice(rail, notice({ roomId: 1 }), 100);
        rail = pushRailNotice(rail, notice({ roomId: 2 }), 100);
        rail = markRailRead(rail, rail.notices[0].id);
        expect(dismissRailNotice(rail, 'read').notices.map(n => n.roomId)).toEqual([2]);
        expect(dismissRailNotice(rail, rail.notices[1].id).notices.map(n => n.roomId)).toEqual([1]);
    });

    it('trims at the cap, read notices first', () => {
        let rail = emptyRail();
        for (let i = 0; i < NOTICE_RAIL_CAP; i++)
            rail = pushRailNotice(rail, notice({ roomId: 100 + i }), 100 + i);
        rail = markRailRead(rail, rail.notices[3].id);
        rail = pushRailNotice(rail, notice({ roomId: 999 }), 500);
        expect(rail.notices).toHaveLength(NOTICE_RAIL_CAP);
        expect(rail.notices.some(n => n.roomId === 103)).toBe(false);
        expect(rail.notices.some(n => n.roomId === 100)).toBe(true);
        // With nothing read, the oldest goes.
        rail = pushRailNotice(rail, notice({ roomId: 1000 }), 600);
        expect(rail.notices.some(n => n.roomId === 100)).toBe(false);
    });

    it('groups by war, newest war first, newest notice first within it', () => {
        let rail = emptyRail();
        rail = pushRailNotice(rail, notice({ roomId: 1, title: 'A' }), 100);
        rail = markRailRead(rail, 'all');
        rail = pushRailNotice(rail, notice({ roomId: 2, title: 'B' }), 200);
        rail = pushRailNotice(rail, notice({ roomId: 1, title: 'A', kind: 'back', detail: 'b' }), 300);
        const groups = railGroups(rail);
        expect(groups.map(g => g.title)).toEqual(['A', 'B']);
        expect(groups[0].notices.map(n => n.kind)).toEqual(['back', 'hibernated']);
        expect(groups[0].unread).toBe(1);
        expect(groups[1].unread).toBe(1);
    });

    it('never mutates the state it was given', () => {
        const rail = emptyRail();
        pushRailNotice(rail, notice(), 1);
        expect(rail.notices).toEqual([]);
    });
});

describe('the room stream stall', () => {
    it('restarts only a CLOSED source — CONNECTING retries on its own', () => {
        expect(shouldRestartRoomStream(0)).toBe(false);
        expect(shouldRestartRoomStream(1)).toBe(false);
        expect(shouldRestartRoomStream(2)).toBe(true);
    });

    it('backs off and caps, and is never zero', () => {
        expect(roomStreamRetryDelayMs(0)).toBe(1000);
        expect(roomStreamRetryDelayMs(1)).toBe(2000);
        expect(roomStreamRetryDelayMs(4)).toBe(16000);
        expect(roomStreamRetryDelayMs(5)).toBe(30000);
        expect(roomStreamRetryDelayMs(50)).toBe(30000);
        expect(roomStreamRetryDelayMs(-3)).toBe(1000);
    });
});
