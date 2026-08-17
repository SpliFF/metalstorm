import { describe, it, expect } from 'vitest';
import { formatDigestLine, formatAway, formatDigest } from './war-digest';
import type { WarDigestEvent } from './join-preview';
import type { WarSide } from './war-browser';

// PLAN-persistence.md §4, task 4b — the while-you-were-away digest.
//
// The one property worth testing here is that a line says WHOSE. A war that
// tells a returning player "a region changed hands" has told them nothing;
// "Union took Ridge Crossing" is the news, and "You took Ridge Crossing" is a
// different piece of news again. Everything below is that rule and the ways it
// has to degrade — a team the war no longer fields, a kind this build has
// never heard of, a history the server could not fully recover.

const SIDES: WarSide[] = [
    { team: 0, faction: 'compact', bound: 2, open: true },
    { team: 1, faction: 'union', bound: 1, open: true },
];

function ev(p: Partial<WarDigestEvent>): WarDigestEvent {
    return { seq: 1, kind: 'region', subject: 'Ridge Crossing', detail: 'captured',
             team: 1, frame: 900, ...p };
}

describe('formatDigestLine', () => {
    it('names the faction that took a region', () => {
        expect(formatDigestLine(ev({}), SIDES)).toBe('Union took Ridge Crossing');
    });

    it('says "You" for the reader\'s own side', () => {
        // The whole reason the preview carries `team`: after three days away,
        // which of the things that happened were MINE is the first question.
        expect(formatDigestLine(ev({ team: 0 }), SIDES, 0))
            .toBe('You took Ridge Crossing');
    });

    it('falls back to a sideless phrasing rather than printing a team number', () => {
        // A team the war no longer fields (re-authored sides) — a card must
        // never show "team 4", which means nothing outside the sim.
        expect(formatDigestLine(ev({ team: 4 }), SIDES))
            .toBe('Ridge Crossing changed hands');
    });

    it('reports a region falling out of everyone\'s hands as its own outcome', () => {
        expect(formatDigestLine(ev({ detail: 'lost', team: -1 }), SIDES))
            .toBe("Ridge Crossing slipped out of anyone's control");
    });

    it('carries objective failures, not just wins', () => {
        // The digest hooks resolveObjective rather than the OnComplete hook a
        // scoreboard uses, precisely so this line can exist: "the extraction
        // you left running expired" is the most useful thing it can say.
        expect(formatDigestLine(ev({ kind: 'objective', subject: 'extract',
                                     detail: 'expired', team: 0 }), SIDES, 0))
            .toBe('Extract objective expired');
        expect(formatDigestLine(ev({ kind: 'objective', subject: 'control',
                                     detail: 'failed', team: 0 }), SIDES, 0))
            .toBe('Control objective failed');
    });

    it('names who completed an objective', () => {
        expect(formatDigestLine(ev({ kind: 'objective', subject: 'control',
                                     detail: 'complete', team: 1 }), SIDES, 0))
            .toBe('Union completed the control objective');
    });

    it('names the breaker of a pact', () => {
        expect(formatDigestLine(ev({ kind: 'pact', subject: 'ceasefire',
                                     detail: 'broken', team: 1 }), SIDES, 0))
            .toBe('Union broke a ceasefire');
        expect(formatDigestLine(ev({ kind: 'pact', subject: 'ceasefire',
                                     detail: 'made', team: 0 }), SIDES, 0))
            .toBe('A ceasefire was agreed');
    });

    it('states an unrecoverable gap rather than hiding it', () => {
        // The sim's ring lapped before the server drained it. A digest that
        // silently drops events cannot be trusted on the ones it does show.
        expect(formatDigestLine(ev({ kind: 'elided', detail: '6', team: -1 }), SIDES))
            .toBe('6 earlier event(s) were not recorded');
    });

    it('says the war\'s own rules moved, and never blames a side for it', () => {
        // PLAN-def-reconciliation §2 step 6. The one line a returning player
        // cannot possibly derive: why their veterans have a different health bar
        // and where the objective they left running went. `team` is -1 by
        // construction at the emitter — nobody did this — and the wording must
        // not acquire a "who" even if a team ever rides along.
        expect(formatDigestLine(ev({ kind: 'patch', subject: '11 units retuned, 6 units lost',
                                     detail: 'summary', team: -1 }), SIDES, 0))
            .toBe('A balance patch reached this war: 11 units retuned, 6 units lost');
        expect(formatDigestLine(ev({ kind: 'patch', subject: 'bastion',
                                     detail: 'removed', team: 0 }), SIDES, 0))
            .toBe('bastion was withdrawn from the war');
    });

    it('drops a kind it has no wording for', () => {
        // A lobby ahead of its client. Fewer lines, never `undefined`.
        expect(formatDigestLine(ev({ kind: 'weather' }), SIDES)).toBe('');
        expect(formatDigestLine(ev({ kind: 'pact', detail: 'pondered' }), SIDES)).toBe('');
    });
});

describe('formatAway', () => {
    it('says nothing for an absence that was not one', () => {
        // A player still connected has `last_seen_at` refreshed every minute
        // by the war-state sweep, so a sub-minute "away" is the sweep's
        // granularity, not a session.
        expect(formatAway(30)).toBe('');
    });

    it('coarsens as it gets longer', () => {
        expect(formatAway(20 * 60)).toBe('20 minutes');
        expect(formatAway(5 * 3600)).toBe('5 hours');
        expect(formatAway(4 * 86400)).toBe('4 days');
    });
});

describe('formatDigest', () => {
    it('is null when there is nothing to say', () => {
        // The ordinary case for every war a player is currently playing —
        // and it has to be distinguishable from "events we cannot word", or
        // an empty box renders on every card.
        expect(formatDigest([], 0, SIDES)).toBeNull();
        expect(formatDigest(undefined, undefined, SIDES)).toBeNull();
        expect(formatDigest([ev({ kind: 'weather' })], 1, SIDES)).toBeNull();
    });

    it('heads the list with how long the absence was', () => {
        const d = formatDigest([ev({})], 1, SIDES, { awaySec: 3 * 86400 });
        expect(d!.heading).toBe('While you were away (3 days)');
        expect(d!.lines).toEqual(['Union took Ridge Crossing']);
        expect(d!.more).toBe(0);
    });

    it('drops the duration when the absence is too short to name', () => {
        const d = formatDigest([ev({})], 1, SIDES, { awaySec: 10 });
        expect(d!.heading).toBe('While you were away');
    });

    it('counts what the server had, not what it sent', () => {
        // The cap is on the card, not on the history: "47 earlier, not shown"
        // is a true statement about a month away, and five lines must not read
        // as the whole story.
        const events = Array.from({ length: 8 }, (_, i) => ev({ seq: i + 1 }));
        const d = formatDigest(events, 52, SIDES, { awaySec: 30 * 86400 });
        expect(d!.lines).toHaveLength(5);
        expect(d!.more).toBe(47);
    });

    it('keeps the NEWEST lines when it caps', () => {
        // Same rule as the server's own truncation, and the reason `more` is
        // rendered above the list rather than below it: what a shortened story
        // loses is its beginning.
        const events = Array.from({ length: 8 }, (_, i) =>
            ev({ seq: i + 1, subject: `R${i + 1}` }));
        const d = formatDigest(events, 8, SIDES);
        expect(d!.lines[0]).toBe('Union took R4');
        expect(d!.lines[4]).toBe('Union took R8');
        expect(d!.more).toBe(3);
    });

    it('shows everything when it fits', () => {
        const events = Array.from({ length: 3 }, (_, i) => ev({ seq: i + 1 }));
        const d = formatDigest(events, 3, SIDES);
        expect(d!.lines).toHaveLength(3);
        expect(d!.more).toBe(0);
    });

    it('folds a line it could not word into the "and N more" count', () => {
        // An event this build has no wording for still happened. Counting it
        // as shown would be the one lie the digest cannot afford.
        const d = formatDigest([ev({ seq: 1 }), ev({ seq: 2, kind: 'weather' })],
                               2, SIDES);
        expect(d!.lines).toHaveLength(1);
        expect(d!.more).toBe(1);
    });
});
