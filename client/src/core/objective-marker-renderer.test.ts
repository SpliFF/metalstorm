/**
 * objective-marker-renderer.test.ts — the two decisions the renderer makes that
 * a screenshot cannot check.
 *
 * The mesh building needs a real Babylon scene and is verified on screen. What
 * is pinned here is the pair of rules the design doc states in prose and which
 * would otherwise erode silently:
 *
 *   §4 "must fade with camera distance and must never hide the fight under it"
 *   §4 a world icon is faction-tinted, and an open race is nobody's faction
 *
 * `colorFor` is also what the MINIMAP tints its blips with, so this file is the
 * only place the two surfaces are proven to agree about colour.
 */

import { describe, it, expect } from 'vitest';
import { fadeForDistance, colorFor } from './objective-marker-renderer.js';
import type { ObjectiveMarker } from './objective-markers.js';

function marker(over: Partial<ObjectiveMarker> = {}): ObjectiveMarker {
    return {
        id: 1, x: 0, z: 0, r: 400, label: 'Hold Raven Basin',
        team: -1, mine: false, victory: false, progress: 0, urgent: false,
        ...over,
    };
}

describe('fadeForDistance', () => {
    it('is fully OFF inside the fight', () => {
        // A player at 120 elmos is looking at individual units. A ring drawn
        // over them is exactly the screen clutter the directive was filed about.
        expect(fadeForDistance(0)).toBe(0);
        expect(fadeForDistance(120)).toBe(0);
        expect(fadeForDistance(260)).toBe(0);
    });

    it('is fully ON at command height', () => {
        // U0 measured a drill-down travel arriving at a 554-elmo camera delta
        // and called ~700-900 command height. Both are above the band, so a
        // "Go there" always lands on a drawn marker.
        expect(fadeForDistance(554)).toBe(1);
        expect(fadeForDistance(900)).toBe(1);
        expect(fadeForDistance(6000)).toBe(1);
    });

    it('ramps monotonically in between', () => {
        let last = -1;
        for (let d = 240; d <= 560; d += 20) {
            const f = fadeForDistance(d);
            expect(f).toBeGreaterThanOrEqual(last);
            expect(f).toBeGreaterThanOrEqual(0);
            expect(f).toBeLessThanOrEqual(1);
            last = f;
        }
    });

    it('does not vanish on a garbage distance', () => {
        // A pose read before the first sceneState must not blank the layer —
        // failing visible is the right direction for a findability aid.
        expect(fadeForDistance(NaN)).toBe(1);
    });
});

describe('colorFor', () => {
    it('tints by faction', () => {
        expect(colorFor(marker({ team: 0 }))).not.toEqual(colorFor(marker({ team: 1 })));
    });

    it('gives an open race nobody\'s colour', () => {
        // `team === -1` is the sim's "open to anyone". Painting it in a team's
        // colour would tell the player it is already someone's.
        const open = colorFor(marker({ team: -1 }));
        expect(open).not.toEqual(colorFor(marker({ team: 0 })));
        expect(open).not.toEqual(colorFor(marker({ team: 1 })));
    });

    it('lets victory outrank the faction tint', () => {
        // There is at most one war-ending objective and it is why the map
        // exists; it must read first, before any question of whose it is.
        const victory = colorFor(marker({ team: 0, victory: true }));
        expect(victory).toEqual(colorFor(marker({ team: 1, victory: true })));
        expect(victory).not.toEqual(colorFor(marker({ team: 0 })));
    });

    it('never indexes out of the palette on a high team id', () => {
        for (const team of [9, 10, 47, 128]) {
            const c = colorFor(marker({ team }));
            expect(Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b)).toBe(true);
        }
    });
});
