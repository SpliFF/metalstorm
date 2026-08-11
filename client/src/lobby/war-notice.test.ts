/**
 * war-notice.test.ts — PLAN-persistence task 4d, the browser's half.
 *
 * The event is a BROADCAST: every browser connected to the lobby sees every
 * war's transitions, including wars this account has never played. So the
 * defect this file is written against is not a formatting one — it is telling
 * the wrong player, or telling them a promise about a world that is gone.
 */

import { describe, it, expect } from 'vitest';
import { noticeFor, parseWarStateEvent, type WarStateEvent } from './war-notice';
import type { WarRow } from './war-browser';

function row(over: Partial<WarRow> = {}): WarRow {
    return {
        id: 7,
        name: 'Meridian Basin',
        mapId: 'meridian_basin',
        state: 4,
        war: { live: false, capacity_per_side: 4, sides: [], state: 'hibernated' },
        ...over,
    } as WarRow;
}

function ev(over: Partial<WarStateEvent> = {}): WarStateEvent {
    return {
        room: 7,
        kind: 'back',
        state: 'live',
        headline: 'Your war is running again.',
        ...over,
    };
}

describe('parseWarStateEvent', () => {
    it('reads the lobby\'s payload', () => {
        const p = parseWarStateEvent(JSON.stringify({
            room: 3, kind: 'hibernated', state: 'hibernated',
            headline: 'Your war went to sleep.',
        }));
        expect(p).toEqual({
            room: 3, kind: 'hibernated', state: 'hibernated',
            headline: 'Your war went to sleep.',
        });
    });

    it('returns null rather than throwing on anything it cannot read', () => {
        // A browser one version behind must ignore an event it does not
        // understand, not lose its SSE handler for the rest of the session.
        expect(parseWarStateEvent('not json')).toBeNull();
        expect(parseWarStateEvent('null')).toBeNull();
        expect(parseWarStateEvent('[]')).toBeNull();
        expect(parseWarStateEvent('{"kind":"back"}')).toBeNull();          // no room
        expect(parseWarStateEvent('{"room":"7","kind":"back"}')).toBeNull(); // room not a number
        expect(parseWarStateEvent('{"room":7,"kind":"whatever"}')).toBeNull();
    });

    it('tolerates a missing state and a missing headline', () => {
        const p = parseWarStateEvent('{"room":7,"kind":"back"}');
        expect(p?.state).toBeUndefined();
        expect(p?.headline).toBe('');
    });
});

describe('noticeFor decides whose business the event is', () => {
    it('says nothing about a war this account is not enlisted in', () => {
        expect(noticeFor(ev(), [row({ enlisted: false })])).toBeNull();
        // Neither field present at all: a lobby older than task 4c, and the
        // fallback is `returning` — still not enlisted here.
        expect(noticeFor(ev(), [row({})])).toBeNull();
        // Watching is not enlistment. A spectator gets no "your war" sentence,
        // because it is not their war (see the module note).
        expect(noticeFor(ev(), [row({ watching: true })])).toBeNull();
    });

    it('falls back to `returning` on a lobby that does not publish enlisted', () => {
        expect(noticeFor(ev(), [row({ returning: true })])).not.toBeNull();
    });

    it('says nothing about a war the browser does not hold a row for', () => {
        // No row means no name to say and no way to know whose war it is.
        expect(noticeFor(ev({ room: 99 }), [row({ enlisted: true })])).toBeNull();
        expect(noticeFor(ev(), [])).toBeNull();
    });

    it('says nothing for `none` or a headline-less event', () => {
        expect(noticeFor(ev({ kind: 'none' }), [row({ enlisted: true })])).toBeNull();
        expect(noticeFor(ev({ headline: '' }), [row({ enlisted: true })])).toBeNull();
    });

    it('names the war, so a player with three of them knows which moved', () => {
        const n = noticeFor(ev(), [row({ enlisted: true })]);
        expect(n?.title).toBe('Meridian Basin');
        expect(n?.roomId).toBe(7);
        // A nameless room still identifies itself.
        const bare = noticeFor(ev(), [row({ enlisted: true, name: '' })]);
        expect(bare?.title).toBe('War 7');
    });

    it('shows the lobby\'s own sentence, verbatim', () => {
        const n = noticeFor(ev({ headline: 'Your war is running again.' }),
                            [row({ enlisted: true })]);
        expect(n?.detail).toBe('Your war is running again.');
    });
});

describe('noticeFor distinguishes the good news from the bad', () => {
    const mine = () => [row({ enlisted: true })];

    it('colours each kind by what it is, not by that it happened', () => {
        expect(noticeFor(ev({ kind: 'back' }), mine())?.cls).toBe('war-notice-good');
        expect(noticeFor(ev({ kind: 'resuming' }), mine())?.cls).toBe('war-notice-wait');
        expect(noticeFor(ev({ kind: 'hibernated' }), mine())?.cls).toBe('war-notice-wait');
        // The one bad reading. It must not arrive wearing the accent colour —
        // the same call task 4a made for the crashed badge.
        expect(noticeFor(ev({ kind: 'lost' }), mine())?.cls).toBe('war-notice-bad');
    });

    it('offers a join only where a join would work', () => {
        expect(noticeFor(ev({ kind: 'back' }), mine())?.canJoin).toBe(true);
        // A hibernated war is joinable — joining is HOW it comes back (task 3b).
        expect(noticeFor(ev({ kind: 'hibernated' }), mine())?.canJoin).toBe(true);
        // A resume in flight is not: the process is up and not serving, so the
        // button would be a promise the server is still working on.
        expect(noticeFor(ev({ kind: 'resuming' }), mine())?.canJoin).toBe(false);
        // A war that lost frames offers no join here either: what it needs is a
        // player who read the sentence first.
        expect(noticeFor(ev({ kind: 'lost' }), mine())?.canJoin).toBe(false);
    });
});

describe('noticeFor quotes the frozen world where it is a fact', () => {
    it('adds the world-waiting clause to a clean sleep', () => {
        const r = row({
            enlisted: true,
            war: { live: false, capacity_per_side: 4, sides: [], state: 'hibernated',
                   frozen_frame: 226800 },
        });
        const n = noticeFor(ev({ kind: 'hibernated', headline: 'Your war went to sleep.' }), [r]);
        // Sim time, from the card's own formatter — not a frame number, and not
        // a second spelling of the same arithmetic.
        expect(n?.detail).toBe('Your war went to sleep. 2h 06m of war waiting for you.');
    });

    it('never quotes a frame next to a loss', () => {
        // The frame is still published on a crashed war (task 3b: "hibernated
        // at 302" and "302 is gone" are different sentences). Appending
        // "waiting for you" to the loss sentence would tell the first one.
        const r = row({
            enlisted: true,
            war: { live: false, capacity_per_side: 4, sides: [], state: 'crashed',
                   frozen_frame: 226800 },
        });
        const n = noticeFor(ev({ kind: 'lost', headline: 'Your war stopped without saving.' }), [r]);
        expect(n?.detail).toBe('Your war stopped without saving.');
        expect(n?.detail).not.toContain('waiting for you');
    });

    it('says nothing about a world with no frames in it', () => {
        const r = row({
            enlisted: true,
            war: { live: false, capacity_per_side: 4, sides: [], state: 'hibernated',
                   frozen_frame: 0 },
        });
        const n = noticeFor(ev({ kind: 'hibernated', headline: 'Your war went to sleep.' }), [r]);
        expect(n?.detail).toBe('Your war went to sleep.');
    });
});
