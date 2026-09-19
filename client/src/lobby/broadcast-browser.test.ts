import { describe, it, expect } from 'vitest';
import { describeBroadcastEntry, type BroadcastListing } from './broadcast-browser.js';

const base: BroadcastListing = {
    file: 'room-42-1726500000.msb',
    mission_title: 'Crossing Standoff',
    map: 'meridian_basin',
    game: 'metalstorm',
    state: 'live',
    behind_seconds: 3600,
    available_since: '2026-09-17T02:00:00Z',
    duration: 205,
};

describe('describeBroadcastEntry', () => {
    it('shows the mission title, the delay chip and the named watch copy', () => {
        const m = describeBroadcastEntry(base);
        expect(m.title).toBe('Crossing Standoff');
        expect(m.chip).toBe('Broadcast · 1h behind');
        expect(m.duration).toBe('3:25');
        expect(m.watchLabel).toBe('Watch this Mission — 1h behind');
    });

    it('shows Recorded, with no delay, for a finished segment', () => {
        const m = describeBroadcastEntry({ ...base, state: 'recorded', behind_seconds: undefined });
        expect(m.chip).toBe('Recorded');
        expect(m.watchLabel).toBe('Watch');
    });

    it('falls back to map/game, then the filename, when there is no mission title', () => {
        expect(describeBroadcastEntry({ ...base, mission_title: undefined }).title)
            .toBe('meridian_basin · metalstorm');
        expect(describeBroadcastEntry({ ...base, mission_title: undefined, map: undefined }).title)
            .toBe(base.file);
    });

    it('reads available_since as UNIX seconds, the shape the lobby actually sends', () => {
        // Regression: the lobby sends `availableSinceMs / 1000` (a number), so
        // `new Date(n)` read it as ms and rendered 22 Jan 1970 (beta-e2e pass 1).
        const m = describeBroadcastEntry({ ...base, available_since: 1789616390 });
        const expected = new Date(1789616390 * 1000).toLocaleString(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        expect(m.detail).toContain(expected);
        expect(m.detail).not.toMatch(/1970/);
    });

    it('offers to join an existing cast rather than start a second relay', () => {
        expect(describeBroadcastEntry({ ...base, watching_room: 7 }).watchLabel).toBe('Join cast');
    });

    it('formats a longer delay in whole hours, and a dev-floor delay in minutes', () => {
        expect(describeBroadcastEntry({ ...base, behind_seconds: 7260 }).chip)
            .toBe('Broadcast · 2h behind');
        expect(describeBroadcastEntry({ ...base, behind_seconds: 90 }).chip)
            .toBe('Broadcast · 2m behind');
    });

    it('says nothing about duration when the catalog has none yet', () => {
        expect(describeBroadcastEntry({ ...base, duration: undefined }).duration).toBe('');
    });
});
