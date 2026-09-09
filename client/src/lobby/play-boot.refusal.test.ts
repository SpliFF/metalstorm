/**
 * play-boot.refusal.test.ts — review 2026-09-10: a `?play=` link must refuse
 * what the Create Game route refuses (a retired war), and attach mode must
 * only attach to a room that is actually running a game.
 */

import { describe, it, expect } from 'vitest';
import { isAttachableRoom, playRefusal, type ScenarioInfo } from './play-boot';
import { mapThumbUrl } from './map-list-status';

const RETIRED: ScenarioInfo = {
    id: 'meridian_basin', displayName: 'Meridian Basin', map: 'meridian_basin',
    retired: true, terminal: true,
};

describe('playRefusal', () => {
    it('refuses a retired war, naming it', () => {
        expect(playRefusal(RETIRED, 'meridian_basin')).toMatch(/"Meridian Basin" is retired/);
    });

    it('refuses an id the game does not ship', () => {
        expect(playRefusal(undefined, 'nope')).toMatch(/"nope" is not one this game ships/);
    });

    it('lets an ordinary war through', () => {
        expect(playRefusal({ ...RETIRED, retired: false }, 'meridian_basin')).toBeNull();
    });
});

describe('isAttachableRoom attaches only to a running game', () => {
    const room = { id: 12, players: [] };
    it('Loading and Active attach; everything else launches fresh', () => {
        expect(isAttachableRoom({ ...room, state: 3 })).toBe(true);
        expect(isAttachableRoom({ ...room, state: 4 })).toBe(true);
        // A finished room is recycled to Filling — a suppressed lobby parked
        // in it rendered as a blank page.
        expect(isAttachableRoom({ ...room, state: 1 })).toBe(false);
        expect(isAttachableRoom({ ...room, state: 5 })).toBe(false);
        expect(isAttachableRoom(undefined)).toBe(false);
    });
});

describe('mapThumbUrl', () => {
    it('is one spelling for every surface, and empty for no map', () => {
        expect(mapThumbUrl('scorched_crossing_v2.4')).toBe('/api/maps/thumb/scorched_crossing_v2.4');
        expect(mapThumbUrl('a b')).toBe('/api/maps/thumb/a%20b');
        expect(mapThumbUrl('')).toBe('');
    });
});
