import { describe, expect, it } from 'vitest';
import {
    defaultTeamForNewSlot, parseWarSides, renderSideOptions, sideForFaction, warSidesForRoom,
} from './war-sides.js';

// PLAN-metalstorm-wars.md §7.4 / PLAN-endtoend.md D19 — the room screen's
// slot dropdown offers SIDES, and the team behind each side is whatever the
// server resolved and published in the `war_sides` modoption.
//
// The bug these pin down: the dropdown used to be a hardcoded `Team 1` /
// `Team 2`, so on Meridian Basin — sides compact (teams 0–3, army on 0) and
// union (teams 4–7, army on 4) — the AI opponent was seated on team 1, a
// compact teammate with no units, and the union's whole army was skipped.
// Measured live: team 0 = 13 units, team 1 = 0 units.

describe('parseWarSides', () => {
    it('reads the meridian_basin encoding the lobby writes', () => {
        expect(parseWarSides('compact:0,union:4')).toEqual([
            { faction: 'compact', team: 0, label: 'Compact' },
            { faction: 'union', team: 4, label: 'Union' },
        ]);
    });

    it('falls back to the legacy two-team room when absent', () => {
        // Paper Tanks and ZK ship no scenarios and must keep the room they
        // have always had.
        for (const spec of [undefined, null, '', '   ']) {
            expect(parseWarSides(spec).map(s => s.team)).toEqual([0, 1]);
            expect(parseWarSides(spec).map(s => s.label))
                .toEqual(['Team 1', 'Team 2']);
        }
    });

    it('drops malformed entries rather than coercing them to team 0', () => {
        // Number('') is 0 — coercing here would seat two sides on the same
        // team, which reads as a working room until nobody has an opponent.
        expect(parseWarSides('compact:0,union:x,third:,r:7').map(s => s.team))
            .toEqual([0, 7]);
    });

    it('rejects an entry with no faction name', () => {
        expect(parseWarSides(':9,ok:2').map(s => s.team)).toEqual([2]);
    });

    it('rejects a non-integer or out-of-range team', () => {
        expect(parseWarSides('a:-1,b:1.5,c:999,d:3').map(s => s.team))
            .toEqual([3]);
    });

    it('lists a duplicated team once', () => {
        expect(parseWarSides('a:2,b:2,c:5').map(s => s.team)).toEqual([2, 5]);
    });

    it('falls back when nothing at all survives parsing', () => {
        expect(parseWarSides('nonsense').map(s => s.team)).toEqual([0, 1]);
    });

    it('title-cases multi-word faction keys', () => {
        expect(parseWarSides('free_cities:0,iron league:1').map(s => s.label))
            .toEqual(['Free Cities', 'Iron League']);
    });

    it('preserves the declared order, which is the offer order', () => {
        // The first side is where an opinion-less host is seated, so the
        // author's order has to survive to the dropdown.
        expect(parseWarSides('union:4,compact:0').map(s => s.faction))
            .toEqual(['union', 'compact']);
    });
});

describe('warSidesForRoom', () => {
    it('reads the room modoption', () => {
        expect(warSidesForRoom({ war_sides: 'compact:0,union:4' })
            .map(s => s.team)).toEqual([0, 4]);
    });

    it('handles a room with no modoptions at all', () => {
        expect(warSidesForRoom(undefined).map(s => s.team)).toEqual([0, 1]);
        expect(warSidesForRoom({}).map(s => s.team)).toEqual([0, 1]);
    });
});

describe('renderSideOptions', () => {
    const meridian = parseWarSides('compact:0,union:4');

    it('offers the sides and marks the slot’s current one', () => {
        const html = renderSideOptions(meridian, 4);
        expect(html).toBe(
            '<option value="0">Compact</option>'
            + '<option value="4" selected>Union</option>');
    });

    it('never offers the empty team the old dropdown produced', () => {
        // The literal regression guard: team 1 must not be an option on a
        // Meridian room, because the scenario stages nothing for it.
        expect(renderSideOptions(meridian, 0)).not.toContain('value="1"');
    });

    it('shows a slot sitting on a team no side offers', () => {
        // A direct-start manifest legitimately seats Meridian's reaver NPC on
        // team 8; the dropdown must say so rather than read as side one.
        const html = renderSideOptions(meridian, 8);
        expect(html).toContain('<option value="8" selected>Team 9</option>');
        expect(html).not.toContain('<option value="0" selected>');
    });

    it('escapes a faction label before it reaches innerHTML', () => {
        const html = renderSideOptions(parseWarSides('a<b:0'), 0);
        expect(html).toContain('A&lt;b');
        expect(html).not.toContain('<b');
    });

    it('renders the legacy room unchanged', () => {
        expect(renderSideOptions(parseWarSides(''), 1)).toBe(
            '<option value="0">Team 1</option>'
            + '<option value="1" selected>Team 2</option>');
    });
});

describe('defaultTeamForNewSlot', () => {
    const meridian = parseWarSides('compact:0,union:4');

    it('puts a new AI on the side nobody holds', () => {
        // "Add AI" on a fresh Meridian room has to produce an opponent. This
        // is the acceptance path for D19: host on compact, AI on union, both
        // sides staged.
        expect(defaultTeamForNewSlot(meridian, [0])).toBe(4);
    });

    it('picks the first side when the room is empty', () => {
        expect(defaultTeamForNewSlot(meridian, [])).toBe(0);
    });

    it('falls back to the last side when every side is taken', () => {
        expect(defaultTeamForNewSlot(meridian, [0, 4])).toBe(4);
    });

    it('matches the old behaviour on a legacy room', () => {
        const legacy = parseWarSides('');
        expect(defaultTeamForNewSlot(legacy, [0])).toBe(1);
        expect(defaultTeamForNewSlot(legacy, [])).toBe(0);
    });
});

describe('sideForFaction (D40)', () => {
    const meridian = parseWarSides('compact:0,union:4');

    it('binds an account to the side its faction is staged on', () => {
        expect(sideForFaction(meridian, 'union')?.team).toBe(4);
        expect(sideForFaction(meridian, 'compact')?.team).toBe(0);
    });

    it('binds nobody when the war declares no side for the faction', () => {
        expect(sideForFaction(meridian, 'reavers')).toBeUndefined();
    });

    it('binds nobody without a faction', () => {
        // Dev and /api/rooms/direct manifest accounts have none, and must keep
        // the free choice of side the test vehicles depend on.
        expect(sideForFaction(meridian, '')).toBeUndefined();
        expect(sideForFaction(meridian, undefined)).toBeUndefined();
    });

    it('never binds on a legacy room, whose sides have no faction names', () => {
        // parseWarSides('') yields faction: '' twice; a faction-carrying
        // account joining a Paper Tanks room must not match the empty key.
        expect(sideForFaction(parseWarSides(''), '')).toBeUndefined();
        expect(sideForFaction(parseWarSides(''), 'union')).toBeUndefined();
    });
});
