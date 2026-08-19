/**
 * world-notifications.test.ts — PLAN-worldsim.md W11, the pure half.
 *
 * No DOM here, matching `war-notice.ts`'s own test file: `parseWorldStagingEvent`
 * and `pushNotice` are plain data functions, and the defects worth catching
 * are the ones that would corrupt data silently — a malformed event crashing
 * the SSE handler, or the notification list growing without bound.
 */

import { describe, it, expect } from 'vitest';
import {
    parseWorldStagingEvent, pushNotice, stagingNoticeClass, WORLD_NOTICE_CAP,
    type WorldStagingNotice, type WorldStagingNoticeEvent,
} from './world-notifications';

const RAW_OPENED = JSON.stringify({
    world: 'earth', poi: 'randtown', poiName: 'Randtown', kind: 'opened',
    attackerFaction: 'iron-order', defenderFaction: 'dust-legion',
    stagingId: 42, worldMs: 5_000_000, headline: 'Staging has opened at Randtown.',
});

describe('parseWorldStagingEvent', () => {
    it('parses a well-formed opened event', () => {
        const ev = parseWorldStagingEvent(RAW_OPENED);
        expect(ev).toEqual({
            world: 'earth', poi: 'randtown', poiName: 'Randtown', kind: 'opened',
            attackerFaction: 'iron-order', defenderFaction: 'dust-legion',
            stagingId: 42, worldMs: 5_000_000, headline: 'Staging has opened at Randtown.',
        });
    });

    it('returns null on unparseable JSON rather than throwing', () => {
        expect(parseWorldStagingEvent('not json')).toBeNull();
    });

    it('returns null when poi is missing', () => {
        expect(parseWorldStagingEvent(JSON.stringify({ kind: 'opened' }))).toBeNull();
    });

    it('returns null on an unknown kind — a future server must not crash an old client', () => {
        expect(parseWorldStagingEvent(JSON.stringify({ poi: 'randtown', kind: 'exploded' })))
            .toBeNull();
    });

    it('defaults missing optional fields rather than rejecting the whole event', () => {
        const ev = parseWorldStagingEvent(JSON.stringify({ poi: 'randtown', kind: 'cancelled' }));
        expect(ev).toEqual({
            world: '', poi: 'randtown', poiName: 'randtown', kind: 'cancelled',
            attackerFaction: '', defenderFaction: '', stagingId: 0, worldMs: 0, headline: '',
        });
    });

    it.each(['opened', 'materialised', 'cancelled', 'failed'] as const)(
        'accepts every kind the server can send: %s', (kind) => {
            const ev = parseWorldStagingEvent(JSON.stringify({ poi: 'randtown', kind }));
            expect(ev?.kind).toBe(kind);
        });
});

describe('stagingNoticeClass', () => {
    it('gives every kind a class, and materialised (a battle starting) reads as urgent', () => {
        expect(stagingNoticeClass('materialised')).toBe('bad');
        expect(stagingNoticeClass('opened')).toBe('wait');
        expect(stagingNoticeClass('cancelled')).toBe('wait');
        expect(stagingNoticeClass('failed')).toBe('wait');
    });
});

describe('pushNotice', () => {
    const ev: WorldStagingNoticeEvent = {
        world: 'earth', poi: 'randtown', poiName: 'Randtown', kind: 'opened',
        attackerFaction: 'iron-order', defenderFaction: '', stagingId: 1, worldMs: 1000,
        headline: 'Staging has opened at Randtown.',
    };

    it('prepends the new notice, newest first', () => {
        const list = pushNotice([], ev, 1, 5000);
        expect(list).toHaveLength(1);
        expect(list[0]).toEqual({ ...ev, id: 1, receivedAt: 5000 });
    });

    it('does not mutate the list handed in', () => {
        const original: WorldStagingNotice[] = [];
        const next = pushNotice(original, ev, 1, 5000);
        expect(original).toHaveLength(0);
        expect(next).not.toBe(original);
    });

    it('caps at WORLD_NOTICE_CAP, dropping the oldest', () => {
        let list: WorldStagingNotice[] = [];
        for (let i = 0; i < WORLD_NOTICE_CAP + 5; i++)
            list = pushNotice(list, { ...ev, stagingId: i }, i, 1000 + i);
        expect(list).toHaveLength(WORLD_NOTICE_CAP);
        // Newest (last pushed) is first; the oldest 5 were dropped off the end.
        expect(list[0].stagingId).toBe(WORLD_NOTICE_CAP + 4);
        expect(list[list.length - 1].stagingId).toBe(5);
    });
});
