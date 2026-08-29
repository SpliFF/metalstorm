/**
 * objective-phrasing.test.ts — the sentences are content, so they are pinned
 * (DESIGN-DRILLDOWN.md §4; U1, interaction story 2)
 *
 * `objective-phrasing.ts` exists because the player's report was that the word
 * `control` and a bare progress bar told them nothing. Every sentence it
 * produces is composed client-side from structured fields, which makes this
 * module the one place a phrase can quietly start CLAIMING something the wire
 * never carried. That is what these assertions guard, in three groups:
 *
 *  1. **the verb-first rule** — a chip is read in a glance mid-battle, so it
 *     opens with what to DO, never with a type tag;
 *  2. **honesty about what is not known** — no invented place name, no invented
 *     clock, no invented denominator. The nastiest failure mode here is a
 *     confident sentence about a field the server never published;
 *  3. **one wording per objective** — the chip, the panel and the toast all name
 *     the same objective through `shortName`, so they cannot drift into three
 *     different names for one thing.
 *
 * What is NOT here: whether any of it LOOKS right. DOM assertions and string
 * assertions are both blind to CSS; the live screenshots in the step report are
 * the evidence for that.
 */

import { describe, it, expect } from 'vitest';
import {
    announcement, briefing, consequencePhrase, formatClock, originPhrase,
    progressPhrase, progressWord, rewardPhrase, shortName, stateWord, taskLine,
    timePhrase,
} from './objective-phrasing.js';
import { FRAMES_PER_SECOND, type ObjectiveRecord, type ObjectivePlace } from './objective-model.js';

const obj = (over: Partial<ObjectiveRecord> = {}): ObjectiveRecord => ({
    id: 1, type: 'control', scope: 'strategic', state: 'active', ...over,
});

const named: ObjectivePlace = { name: 'Raven Basin', x: 100, z: 200, approximate: false };
const approx: ObjectivePlace = { name: 'Storm Sound', x: 100, z: 200, approximate: true };

// ──────────────────────────── 1. verb first ─────────────────────────────

describe('shortName', () => {
    it('opens with the verb and names the place, never the type tag', () => {
        // This is the whole user report in one assertion: the old panel showed
        // "control"; a player needs "Hold Raven Basin".
        expect(shortName(obj({ type: 'control' }), named)).toBe('Hold Raven Basin');
        expect(shortName(obj({ type: 'control' }), named)).not.toContain('control');
    });

    it('has a phrasing of its own for every published objective type', () => {
        // The six v0 types in game_objectives.lua's TYPES table, checked on the
        // NAMELESS form. That is where a fall-through shows: with a place in
        // hand the default branch produces "Protect Raven Basin", which is also
        // what the real `protect` case produces, so a named title cannot tell
        // the two apart. Without a place, every handled type says something a
        // human wrote ("Destroy the target") and the default says only the
        // capitalised tag — the type-tag reading the player complained about.
        const types = ['control', 'kill', 'escort', 'protect', 'extract', 'infra'];
        for (const type of types) {
            const title = shortName(obj({ type }), null);
            expect(title, type).not.toBe(type);
            expect(title.toLowerCase(), type).not.toBe(type.toLowerCase());
            // More than one word: the tag alone is never an instruction.
            expect(title.split(/\s+/).length, type).toBeGreaterThan(1);
        }
    });

    it('renders an unknown future type without breaking', () => {
        // A seventh type added server-side must degrade to something readable
        // rather than blanking the chip.
        expect(shortName(obj({ type: 'blockade' }), named)).toBe('Blockade Raven Basin');
    });

    it('distinguishes the two extract stages, because they are different jobs', () => {
        expect(shortName(obj({ type: 'extract', stage: 'secure' }), named))
            .toContain('Secure');
        expect(shortName(obj({ type: 'extract', stage: 'evac' }), named))
            .toContain('Evacuate');
    });

    it('says "near X" for an approximate place and bare X for a region', () => {
        // An x/z hint is a UNIT's position; claiming it IS the region would be
        // the model asserting something publish() never said.
        expect(shortName(obj({ type: 'kill' }), approx)).toContain('near Storm Sound');
        expect(shortName(obj({ type: 'kill' }), named)).not.toContain('near');
    });

    it('never invents a place name when none resolved', () => {
        const title = shortName(obj({ type: 'control' }), null);
        expect(title).toBe('Hold the ground');
        expect(title).not.toMatch(/undefined|null|NaN/);
    });
});

describe('taskLine', () => {
    it('is the chip sentence: verb, place, and how far along', () => {
        expect(taskLine(obj({ progress: 0.62 }), named)).toBe('Hold Raven Basin — 62% held');
    });

    it('omits the progress clause entirely when the sim published none', () => {
        expect(taskLine(obj(), named)).toBe('Hold Raven Basin');
    });
});

// ─────────────────────── 2. honesty about the wire ──────────────────────

describe('progressPhrase', () => {
    it('carries a unit word so the number needs no legend', () => {
        expect(progressPhrase(obj({ type: 'control', progress: 0.62 }))).toBe('62% held');
        expect(progressPhrase(obj({ type: 'kill', progress: 0.5 }))).toBe('50% destroyed');
        expect(progressPhrase(obj({ type: 'escort', progress: 0.25 }))).toBe('25% of the way');
    });

    it('is null — not "0%" — when the sim published no progress at all', () => {
        // "0% held" and "we were never told" are different facts, and a player
        // acts differently on them.
        expect(progressPhrase(obj({ progress: undefined }))).toBeNull();
        expect(progressPhrase(obj({ progress: 0 }))).toBe('0% held');
    });

    it('clamps out-of-range progress rather than rendering it', () => {
        expect(progressPhrase(obj({ progress: 1.4 }))).toBe('100% held');
        expect(progressPhrase(obj({ progress: -0.2 }))).toBe('0% held');
    });

    it('gives every type a unit word', () => {
        for (const type of ['control', 'kill', 'escort', 'protect', 'extract', 'infra']) {
            expect(progressWord(obj({ type })), type).toBeTruthy();
        }
    });
});

describe('timePhrase', () => {
    it('counts down from the ABSOLUTE expire frame against the live clock', () => {
        // expire is a sim frame, not a duration — the conversion is the bug
        // magnet, so it is pinned with real numbers.
        const o = obj({ expire: 1000 * FRAMES_PER_SECOND });
        expect(timePhrase(o, 900 * FRAMES_PER_SECOND)).toBe('Lapses in 1:40');
    });

    it('says there is no limit rather than inventing one', () => {
        expect(timePhrase(obj({ expire: undefined }), 500)).toBe('No time limit');
    });

    it('refuses to render a countdown before the clock is known', () => {
        // Frame 0 means "the scene feed has not answered yet". A countdown from
        // it would be wildly wrong, and a player will march on a countdown.
        const phrase = timePhrase(obj({ expire: 9000 }), 0);
        expect(phrase).toContain('clock not yet known');
        expect(phrase).not.toMatch(/Lapses in/);
    });

    it('says "Lapsed" once the frame is past, not a negative clock', () => {
        expect(timePhrase(obj({ expire: 100 }), 500)).toBe('Lapsed');
    });
});

describe('formatClock', () => {
    it('renders m:ss with a padded seconds field', () => {
        expect(formatClock(0)).toBe('0:00');
        expect(formatClock(5 * FRAMES_PER_SECOND)).toBe('0:05');
        expect(formatClock(130 * FRAMES_PER_SECOND)).toBe('2:10');
    });

    it('never renders a negative clock', () => {
        expect(formatClock(-500)).toBe('0:00');
    });
});

describe('rewardPhrase', () => {
    it('says what it is worth and who is paid', () => {
        expect(rewardPhrase(obj({ reward: 250 }))).toBe('+250 authority to whoever completes it');
    });

    it('says "unpublished" rather than "+0" when there is no reward field', () => {
        expect(rewardPhrase(obj({ reward: undefined }))).toBe('unpublished');
    });
});

describe('consequencePhrase — the half the old panel never showed', () => {
    it('leads with the war-ending stake when this is the terminal objective', () => {
        const phrase = consequencePhrase(obj({ victory: 1 }));
        expect(phrase).toContain('ends the war');
    });

    it('tells the loser of an open race that the reward went elsewhere', () => {
        // `team` is eligibility (-1 for an open race), so completedBy is the
        // ONLY field that can distinguish our win from theirs.
        expect(consequencePhrase(obj({ state: 'complete', completedBy: 1 }), 0))
            .toContain('whoever finished it');
        expect(consequencePhrase(obj({ state: 'complete', completedBy: 0 }), 0)).toBe('Paid.');
    });

    it('names the type-specific loss for the two types that can be lost outright', () => {
        expect(consequencePhrase(obj({ type: 'escort' }))).toContain('transport dies');
        expect(consequencePhrase(obj({ type: 'protect' }))).toContain('killed');
    });

    it('is honest that ignoring an open-ended objective costs nothing', () => {
        expect(consequencePhrase(obj({ type: 'control', expire: undefined })))
            .toContain('No penalty');
    });
});

describe('stateWord', () => {
    it('is exactly one word — rung 1 has room for one', () => {
        const cases: ObjectiveRecord[] = [
            obj({ state: 'active' }),
            obj({ state: 'failed' }),
            obj({ state: 'expired' }),
            obj({ state: 'complete', completedBy: 0 }),
            obj({ type: 'extract', stage: 'evac' }),
        ];
        for (const o of cases) {
            expect(stateWord(o, { frame: 100, teamId: 0 }).split(/\s+/), o.state).toHaveLength(1);
        }
    });

    it('distinguishes a win from a loss on an open race', () => {
        expect(stateWord(obj({ state: 'complete', completedBy: 0 }), { frame: 1, teamId: 0 }))
            .toBe('complete');
        expect(stateWord(obj({ state: 'complete', completedBy: 1 }), { frame: 1, teamId: 0 }))
            .toBe('lost');
    });

    it('reads an elapsed clock as lapsed even before the sim republishes', () => {
        // The gadget evaluates every 90 frames, so the chip would otherwise say
        // "active" for up to three seconds after its own countdown hit zero.
        expect(stateWord(obj({ state: 'active', expire: 100 }), { frame: 500 })).toBe('lapsed');
    });
});

describe('briefing — the "further information" the player asked for by name', () => {
    it('explains the mechanic, not just the goal', () => {
        // The reason a control objective is confusing is the reset rule, which
        // nothing on screen ever stated.
        expect(briefing(obj({ type: 'control' }), named)).toContain('resets the hold clock');
    });

    it('adds the war-ending stake as its own sentence', () => {
        expect(briefing(obj({ victory: 1 }), named)).toContain('ends the war');
    });

    it('says an open race pays only the finisher', () => {
        expect(briefing(obj({ team: -1 }), named)).toContain('Open race');
    });

    it('distinguishes a joint objective from an open race', () => {
        const joint = briefing(obj({ team: 0, team2: 1 }), named);
        expect(joint).toContain('parley partner');
        expect(joint).not.toContain('Open race');
    });

    it('names a bounty stake and a systemic origin differently', () => {
        expect(briefing(obj({ team: 0, source: 'bounty' }), named)).toContain('staked');
        expect(briefing(obj({ team: 0, source: 'systemic' }), named)).toContain('Raised by the world');
    });

    it('degrades to "the marked ground" rather than naming a place it cannot', () => {
        const text = briefing(obj({ type: 'kill' }), null);
        expect(text).toContain('the marked ground');
        expect(text).not.toMatch(/undefined|null|NaN/);
    });

    it('never leaves a placeholder in any type/place combination', () => {
        for (const type of ['control', 'kill', 'escort', 'protect', 'extract', 'infra']) {
            for (const place of [named, approx, null]) {
                const text = briefing(obj({ type }), place);
                expect(text, `${type}/${place?.name ?? 'nowhere'}`)
                    .not.toMatch(/undefined|null|NaN|\[object/);
                expect(text.trim().length, type).toBeGreaterThan(10);
            }
        }
    });
});

describe('originPhrase', () => {
    it('keeps scope and source distinguishable', () => {
        expect(originPhrase(obj({ scope: 'strategic', source: 'bounty' })))
            .toBe('strategic · bounty');
    });

    it('does not invent a source when the sim published none', () => {
        expect(originPhrase(obj({ scope: 'tactical', source: undefined }))).toBe('tactical');
    });
});

// ─────────────────────── 3. one wording per objective ───────────────────

describe('announcement', () => {
    it('names the objective the same way the chip does', () => {
        // A toast that names an objective differently from the chip it is about
        // is two objectives as far as a player under fire is concerned.
        const o = obj({ type: 'control', reward: 300 });
        for (const kind of ['appeared', 'complete', 'lost-race', 'failed', 'expired'] as const) {
            expect(announcement(kind, o, named), kind).toContain(shortName(o, named));
        }
    });

    it('distinguishes losing a race from failing outright', () => {
        const o = obj({ reward: 300 });
        expect(announcement('lost-race', o, named)).toContain('went to the other side');
        expect(announcement('failed', o, named)).toContain('failed');
    });

    it('states the reward gained or lost, and never renders a bare NaN', () => {
        expect(announcement('complete', obj({ reward: 300 }), named)).toContain('+300');
        expect(announcement('failed', obj({ reward: undefined }), named)).toContain('—');
    });

    it('stays one short line for every kind', () => {
        // It is read in passing, mid-battle, over the world.
        const o = obj({ type: 'escort', reward: 300 });
        for (const kind of ['appeared', 'complete', 'lost-race', 'failed', 'expired'] as const) {
            expect(announcement(kind, o, named).length, kind).toBeLessThan(80);
        }
    });
});
