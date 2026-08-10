import { describe, it, expect } from 'vitest';
import { formatJoinPreview, type WarJoinPreview } from './join-preview';

// PLAN-metalstorm-lobby.md §2.4, task 5 — pre-join legibility.
//
// The numbers are the server's (and the C++ side pins that they come from the
// same functions the game server seats with — tests/test_join_preview.cpp).
// What is testable here is the sentence: a war card has to say which side your
// faction puts you on, whether the seat is already yours, and what you arrive
// holding — and when it says you will only be watching, it has to say what
// would change that.

const base: WarJoinPreview = {
    room_id: 1,
    will_fight: true,
    reason: 'admitted',
    team: 0,
    side: 'compact',
    humans_on_side: 2,
    capacity_per_side: 8,
    authority: 100,
    authority_source: 'join_grant',
    returning: false,
};

describe('formatJoinPreview', () => {
    it('names the side, the seat count including you, and the grant', () => {
        // "3/8", not "2/8": the count the server sends excludes the reader,
        // and a player reads a seat count as "where will I be", not "where is
        // everyone else".
        expect(formatJoinPreview(base)).toBe(
            'You will fight for Compact (3/8) with 100 authority.');
    });

    it('distinguishes a rejoin from a first join', () => {
        const p = { ...base, returning: true, authority_source: 'restored_pool',
                    authority: 250 };
        expect(formatJoinPreview(p)).toBe(
            'Rejoin Compact (3/8) with your 250 authority restored.');
    });

    it('says the old pool expired rather than quietly quoting a smaller number', () => {
        // A player who left with 400 and comes back to 100 is owed the reason;
        // without it the stipend reads as authority going missing.
        const p = { ...base, returning: true,
                    authority_source: 'onboarding_stipend', authority: 100 };
        expect(formatJoinPreview(p)).toContain('your old pool has expired');
        expect(formatJoinPreview(p)).toContain('100 authority stipend');
    });

    it('gives each spectating reason its own fix', () => {
        const watch = (reason: string, extra: Partial<WarJoinPreview> = {}) =>
            formatJoinPreview({ ...base, will_fight: false, reason, ...extra });

        expect(watch('account has no faction'))
            .toBe('You will watch — this account has no faction.');
        expect(watch('war declares no side for this faction'))
            .toBe('You will watch — your faction fields no side in this war.');
        // The population is still quoted on a full side: "8/8" is the useful
        // half of that refusal, and it is the one that changes over time.
        expect(watch("the faction's side is full",
                     { humans_on_side: 8, capacity_per_side: 8 }))
            .toBe('You will watch — your side is full (8/8).');
    });

    it('says nothing for a room that is not a war', () => {
        // The endpoint only returns wars, but a stale map entry must render as
        // an absent line rather than as an empty green bar.
        expect(formatJoinPreview({ ...base, will_fight: false,
                                   reason: 'not a persistent war' })).toBe('');
    });

    it('omits the seat count when the war has no per-side cap', () => {
        expect(formatJoinPreview({ ...base, capacity_per_side: 0 }))
            .toBe('You will fight for Compact with 100 authority.');
    });

    it('does not print a trailing .0 on a whole-number pool', () => {
        // The pool crosses the wire as a double and 250 must not read as
        // "250.0 authority" — the sim's own pretty-printer already produces
        // that shape elsewhere and it reads as a bug.
        expect(formatJoinPreview({ ...base, authority: 250.0 }))
            .toContain('250 authority');
        expect(formatJoinPreview({ ...base, authority: 33.333 }))
            .toContain('33.3 authority');
    });
});
