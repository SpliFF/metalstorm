/**
 * battle-events.test.ts — the rules the awareness layer is allowed to interrupt on.
 *
 * These are behavioural, not structural: each case is a short battle expressed
 * as a list of calls, because the defect class this module exists inside is
 * "the client was told and said nothing" and its opposite is "the client says
 * everything". Both are only visible over a sequence.
 */

import { describe, it, expect } from 'vitest';
import {
    BattleEventDetector, COALESCE_FRAMES, ENGAGEMENT_QUIET_FRAMES,
    ENGAGEMENT_RADIUS, RETURN_GRACE_FRAMES, WAVE_MIN_UNITS, HISTORY_MAX,
    type RosterUnit,
} from './battle-events.js';

const own = (unitId: number, x = 1000, z = 1000, extra: Partial<RosterUnit> = {}): RosterUnit =>
    ({ unitId, side: 'own', x, z, health: 1, className: 'tanks', ...extra });
const foe = (unitId: number, x = 1000, z = 1000, extra: Partial<RosterUnit> = {}): RosterUnit =>
    ({ unitId, side: 'enemy', x, z, health: 1, className: 'tanks', ...extra });

/** Prime the roster (everything present at first look is the starting army). */
function primed(units: RosterUnit[], frame = 0): BattleEventDetector {
    const d = new BattleEventDetector();
    d.noteRoster(units, frame);
    d.drain(frame);
    return d;
}

describe('first contact', () => {
    it('fires once, on the first damage our side takes or deals', () => {
        const d = primed([own(1), foe(2)]);
        d.noteFire({
            attackerId: 2, targetId: 1, targetSide: 'own', attackerSide: 'enemy',
            x: 1000, z: 1000, damage: 40,
        }, 100);
        const first = d.drain(100);
        expect(first.map((m) => m.kind)).toEqual(['first-contact']);
        expect(first[0].x).toBe(1000);

        d.noteFire({
            attackerId: 2, targetId: 1, targetSide: 'own', attackerSide: 'enemy',
            x: 1010, z: 1000, damage: 40,
        }, 110);
        expect(d.drain(110)).toEqual([]);
    });

    it('does not fire for a fight between two sides we merely watch', () => {
        const d = primed([foe(2)]);
        d.noteFire({
            attackerId: 2, targetId: 3, targetSide: 'enemy', attackerSide: 'enemy',
            x: 1000, z: 1000, damage: 40,
        }, 100);
        expect(d.drain(100)).toEqual([]);
    });

    it('does not fire on a miss — zero damage is not contact', () => {
        const d = primed([own(1)]);
        d.noteFire({
            attackerId: 2, targetId: 1, targetSide: 'own', attackerSide: 'unknown',
            x: 1000, z: 1000, damage: 0,
        }, 100);
        expect(d.drain(100)).toEqual([]);
    });
});

describe('under fire', () => {
    it('announces one engagement once, however many shots land', () => {
        const d = primed([own(1), own(2)]);
        // Burn first contact somewhere else entirely.
        d.noteFire({
            attackerId: 9, targetId: 1, targetSide: 'own', attackerSide: 'enemy',
            x: 6000, z: 6000, damage: 10,
        }, 10);
        d.drain(10);

        for (let i = 0; i < 20; i++) {
            d.noteFire({
                attackerId: 9, targetId: 2, targetSide: 'own', attackerSide: 'enemy',
                x: 1000 + i, z: 1000, damage: 10,
            }, 100 + i);
        }
        const out = d.drain(140);
        expect(out.map((m) => m.kind)).toEqual(['under-fire']);
        expect(out[0].unitIds).toEqual([2]);
    });

    it('re-arms after the engagement goes quiet, so a second assault is news', () => {
        const d = primed([own(1)]);
        d.noteFire({
            attackerId: 9, targetId: 1, targetSide: 'own', attackerSide: 'enemy',
            x: 6000, z: 6000, damage: 10,
        }, 10);
        d.drain(10);

        d.noteFire({
            attackerId: 9, targetId: 1, targetSide: 'own', attackerSide: 'enemy',
            x: 1000, z: 1000, damage: 10,
        }, 100);
        expect(d.drain(100).map((m) => m.kind)).toEqual(['under-fire']);

        const later = 100 + ENGAGEMENT_QUIET_FRAMES + 1;
        d.noteFire({
            attackerId: 9, targetId: 1, targetSide: 'own', attackerSide: 'enemy',
            x: 1000, z: 1000, damage: 10,
        }, later);
        expect(d.drain(later).map((m) => m.kind)).toEqual(['under-fire']);
    });

    it('keeps a fight beyond the engagement radius as separate news', () => {
        const d = primed([own(1), own(2)]);
        d.noteFire({
            attackerId: 9, targetId: 1, targetSide: 'own', attackerSide: 'enemy',
            x: 0, z: 0, damage: 10,
        }, 10);
        d.drain(10);                       // first contact

        d.noteFire({
            attackerId: 9, targetId: 2, targetSide: 'own', attackerSide: 'enemy',
            x: ENGAGEMENT_RADIUS * 3, z: 0, damage: 10,
        }, 20);
        expect(d.drain(20).map((m) => m.kind)).toEqual(['under-fire']);
    });
});

describe('losses and kills', () => {
    it('coalesces deaths in one place into one counted moment', () => {
        const d = primed([own(1), own(2), own(3)]);
        d.noteDeath(1, 1000, 1000, 100);
        d.noteDeath(2, 1050, 1000, 101);
        d.noteDeath(3, 1100, 1000, 102);
        expect(d.drain(150)).toEqual([]);              // window still open
        const out = d.drain(100 + COALESCE_FRAMES);
        expect(out.map((m) => m.kind)).toEqual(['losses']);
        expect(out[0].count).toBe(3);
        expect(out[0].unitIds).toEqual([1, 2, 3]);
        expect(out[0].className).toBe('tanks');
    });

    it('never counts one death twice, whichever emitter reports it', () => {
        const d = primed([own(1)]);
        d.noteDeath(1, 0, 0, 100);
        d.noteDeath(1, 0, 0, 100);                     // the other outcome path
        const out = d.drain(100 + COALESCE_FRAMES);
        expect(out[0].count).toBe(1);
    });

    it('says nothing about a unit that was never in our vision', () => {
        const d = primed([own(1)]);
        d.noteDeath(77, 0, 0, 100);
        expect(d.drain(100 + COALESCE_FRAMES)).toEqual([]);
    });

    it('separates our losses from our kills', () => {
        const d = primed([own(1), foe(2)]);
        d.noteDeath(1, 0, 0, 100);
        d.noteDeath(2, 0, 0, 100);
        const kinds = d.drain(100 + COALESCE_FRAMES).map((m) => m.kind).sort();
        expect(kinds).toEqual(['kills', 'losses']);
    });

    it('marks a squad moment as squads', () => {
        const d = primed([own(1, 0, 0, { squad: true }), own(2, 0, 0, { squad: true })]);
        d.noteDeath(1, 0, 0, 100);
        d.noteDeath(2, 0, 0, 100);
        expect(d.drain(100 + COALESCE_FRAMES)[0].squads).toBe(true);
    });
});

describe('reinforcements', () => {
    it('never announces the starting army', () => {
        const d = new BattleEventDetector();
        d.noteRoster([own(1), own(2), own(3), own(4), foe(5), foe(6), foe(7)], 0);
        expect(d.drain(COALESCE_FRAMES)).toEqual([]);
    });

    it('does not prime on an EMPTY mirror — found live', () => {
        // The detector's tick starts with the render loop and the entity
        // mirror is empty for the first second of a match. Priming on the
        // first CALL rather than on the first non-empty roster made the whole
        // starting army announce itself as an 18-unit wave at frame 0, which
        // is precisely the "wall of notices" failure this layer must not ship.
        const d = new BattleEventDetector();
        d.noteRoster([], 0);
        d.drain(0);
        d.noteRoster([own(1), own(2), own(3), own(4), foe(5), foe(6), foe(7)], 30);
        expect(d.drain(30 + COALESCE_FRAMES)).toEqual([]);
    });

    it('needs a WAVE, not a trickle', () => {
        const d = primed([own(1)]);
        d.noteRoster([own(1), own(2)], 100);
        expect(d.drain(100 + COALESCE_FRAMES)).toEqual([]);

        const start = 1000;
        const arrivals = [own(1)];
        for (let i = 0; i < WAVE_MIN_UNITS; i++) arrivals.push(own(10 + i));
        d.noteRoster(arrivals, start);
        const out = d.drain(start + COALESCE_FRAMES);
        expect(out.map((m) => m.kind)).toEqual(['reinforcements']);
        expect(out[0].count).toBe(WAVE_MIN_UNITS);
    });

    it('reports a detected enemy wave separately from ours', () => {
        const d = primed([own(1)]);
        const wave = [own(1)];
        for (let i = 0; i < WAVE_MIN_UNITS; i++) wave.push(foe(20 + i));
        d.noteRoster(wave, 500);
        expect(d.drain(500 + COALESCE_FRAMES).map((m) => m.kind))
            .toEqual(['enemy-reinforcements']);
    });

    it('does not call a re-spotted force a reinforcement wave', () => {
        const seen = [foe(20), foe(21), foe(22)];
        const d = primed([own(1), ...seen]);
        d.noteRoster([own(1)], 100);                   // they went behind a ridge
        d.drain(100 + COALESCE_FRAMES);
        d.noteRoster([own(1), ...seen], 200);          // and came back
        expect(d.drain(200 + COALESCE_FRAMES)).toEqual([]);
    });

    it('does call them new once the grace has run out', () => {
        const seen = [foe(20), foe(21), foe(22)];
        const d = primed([own(1), ...seen]);
        d.noteRoster([own(1)], 100);
        d.drain(100 + COALESCE_FRAMES);
        const late = 100 + RETURN_GRACE_FRAMES + 1;
        d.noteRoster([own(1), ...seen], late);
        expect(d.drain(late + COALESCE_FRAMES).map((m) => m.kind))
            .toEqual(['enemy-reinforcements']);
    });
});

describe('an enemy nearly dead', () => {
    it('is announced once, and only while we are fighting there', () => {
        const d = primed([own(1), foe(2)]);
        // Not in a live engagement yet: a wounded enemy across the map is not
        // something the player can act on.
        d.noteRoster([own(1), foe(2, 1000, 1000, { health: 0.1 })], 50);
        expect(d.drain(50 + COALESCE_FRAMES)).toEqual([]);

        d.noteFire({
            attackerId: 1, targetId: 2, targetSide: 'enemy', attackerSide: 'own',
            x: 1000, z: 1000, damage: 50,
        }, 100);
        d.drain(100);
        d.noteRoster([own(1), foe(2, 1000, 1000, { health: 0.1 })], 110);
        const out = d.drain(110 + COALESCE_FRAMES);
        expect(out.map((m) => m.kind)).toEqual(['enemy-crippled']);

        d.noteRoster([own(1), foe(2, 1000, 1000, { health: 0.05 })], 200);
        expect(d.drain(200 + COALESCE_FRAMES)).toEqual([]);
    });
});

describe('the history behind the access point', () => {
    it('accumulates every drained moment and stays bounded', () => {
        const d = primed([own(1)]);
        for (let i = 0; i < HISTORY_MAX + 10; i++) {
            const f = 1000 + i * (ENGAGEMENT_QUIET_FRAMES + 1);
            d.noteFire({
                attackerId: 9, targetId: 1, targetSide: 'own', attackerSide: 'enemy',
                x: 1000, z: 1000, damage: 10,
            }, f);
            d.drain(f);
        }
        expect(d.getHistory().length).toBe(HISTORY_MAX);
        // The ring keeps the NEWEST, which is what a player scrolling back
        // after a fight is looking for.
        const ids = d.getHistory().map((m) => m.id);
        expect(ids[ids.length - 1]).toBe(HISTORY_MAX + 10);
    });

    it('is emptied by reset, so a second battle does not inherit the first', () => {
        const d = primed([own(1)]);
        d.noteFire({
            attackerId: 9, targetId: 1, targetSide: 'own', attackerSide: 'enemy',
            x: 0, z: 0, damage: 10,
        }, 10);
        d.drain(10);
        expect(d.getHistory().length).toBe(1);
        d.reset();
        expect(d.getHistory()).toEqual([]);
    });
});
