import { describe, it, expect } from 'vitest';
import {
    filterWars, fightLabel, formatControl, formatSide, formatUptime,
    formatDeploy, formatWarDetail, hasRoomForFaction, sideForFaction,
    type WarInfo, type WarRow,
} from './war-browser';

// PLAN-metalstorm-lobby.md §4, task 6 — the war browser.
//
// The property under test throughout: every field the browser shows is either
// durable (and therefore correct for a war whose server is down) or live (and
// therefore absent in that state). A formatter that reads a live field
// without checking `live` produces a card that claims four people are
// fighting in a war with no process — the exact failure task 3 made possible
// by letting a war outlive its server.

function war(over: Partial<WarInfo> = {}): WarInfo {
    return {
        live: true,
        capacity_per_side: 8,
        sides: [
            { team: 0, faction: 'compact', bound: 2, open: 6, online: 2, ais: 1, regions: 4 },
            { team: 1, faction: 'union', bound: 1, open: 7, online: 0, ais: 0, regions: 3 },
        ],
        spectators: 3,
        uptime_sec: 900,
        control: { total: 11, contested: 2, neutral: 4 },
        ...over,
    };
}

function row(over: Partial<WarRow> = {}): WarRow {
    return {
        id: 1, name: 'Meridian', mapId: 'meridian_basin', state: 4,
        war: war(), ...over,
    };
}

describe('sideForFaction', () => {
    it('finds the side a faction fields', () => {
        expect(sideForFaction(war(), 'union')?.team).toBe(1);
    });
    it('is undefined for a faction the war does not field', () => {
        expect(sideForFaction(war(), 'robots')).toBeUndefined();
        // An account with no faction matches nothing — the same rule the
        // server's TeamForFactionIn uses, and for the same reason.
        expect(sideForFaction(war(), '')).toBeUndefined();
    });
});

describe('hasRoomForFaction', () => {
    it('is true when the faction has a side with a seat left', () => {
        expect(hasRoomForFaction(war(), 'compact')).toBe(true);
    });
    it('is false when the side is full', () => {
        const full = war({ sides: [
            { team: 0, faction: 'compact', bound: 8, open: 0 },
        ] });
        expect(hasRoomForFaction(full, 'compact')).toBe(false);
    });
    it('is false when the war fields no side for the faction', () => {
        expect(hasRoomForFaction(war(), 'robots')).toBe(false);
    });
    it('reads seats from the DURABLE count, not the live one', () => {
        // Every bound player is offline: the war looks empty and is full.
        // Offering these seats is exactly the promise the game server breaks.
        const held = war({ sides: [
            { team: 0, faction: 'compact', bound: 8, open: 0, online: 0 },
        ] });
        expect(hasRoomForFaction(held, 'compact')).toBe(false);
    });
});

describe('filterWars', () => {
    const mine = row({ id: 1, returning: true });
    const theirs = row({ id: 2, war: war({ sides: [
        { team: 0, faction: 'robots', bound: 0, open: 8 },
    ] }) });
    const wars = [mine, theirs];

    it('my-faction keeps wars that field my side, full or not', () => {
        // Deliberately not "wars I can join": a full war my faction is
        // fighting is still the war that is happening in the world.
        const full = row({ id: 3, war: war({ sides: [
            { team: 0, faction: 'compact', bound: 8, open: 0 },
        ] }) });
        expect(filterWars([...wars, full], 'my-faction', 'compact').map(w => w.id))
            .toEqual([1, 3]);
    });
    it('my-wars keeps only wars I hold a seat in', () => {
        expect(filterWars(wars, 'my-wars', 'compact').map(w => w.id)).toEqual([1]);
    });
    it('all keeps everything', () => {
        expect(filterWars(wars, 'all', 'compact')).toHaveLength(2);
    });
    it('my-faction with no faction shows nothing rather than everything', () => {
        expect(filterWars(wars, 'my-faction', '')).toHaveLength(0);
    });
});

describe('formatSide', () => {
    it('quotes seats held against capacity', () => {
        expect(formatSide({ team: 0, faction: 'compact', bound: 2, open: 6 }, 8, false))
            .toBe('Compact 2/8');
    });
    it('names the gap between seats held and people present', () => {
        // The case a player has to be able to see: a side can be full of
        // people who are not there.
        expect(formatSide(
            { team: 0, faction: 'compact', bound: 8, open: 0, online: 1 }, 8, true))
            .toBe('Compact 8/8 (1 online)');
    });
    it('says nothing about online counts when the war is not live', () => {
        expect(formatSide(
            { team: 0, faction: 'compact', bound: 8, open: 0, online: 1 }, 8, false))
            .toBe('Compact 8/8');
    });
    it('mentions AI on the side', () => {
        expect(formatSide(
            { team: 1, faction: 'union', bound: 1, open: 7, online: 1, ais: 2 }, 8, true))
            .toBe('Union 1/8 (2 AI)');
    });
});

describe('formatUptime', () => {
    it('reads coarsely', () => {
        expect(formatUptime(30)).toBe('just started');
        expect(formatUptime(900)).toBe('up 15m');
        expect(formatUptime(3 * 3600 + 120)).toBe('up 3h 02m');
    });
});

describe('formatControl', () => {
    it('summarises the front', () => {
        expect(formatControl(war())).toBe('11 regions · 2 contested · 4 neutral');
    });
    it('is empty when the map publishes no regions', () => {
        // Not "0 regions": a map with no regions gadget is not a stalled war.
        expect(formatControl(war({ control: { total: 0, contested: 0, neutral: 0 } })))
            .toBe('');
        expect(formatControl(war({ control: undefined }))).toBe('');
    });
});

describe('formatWarDetail', () => {
    it('lists map, both sides, watchers and uptime', () => {
        // Union's seat-holder is away: `1/8 (0 online)`, which is the whole
        // reason the two numbers are printed separately.
        expect(formatWarDetail(row())).toBe(
            'meridian_basin · Compact 2/8 (1 AI) · Union 1/8 (0 online) · ' +
            '3 watching · up 15m');
    });
    it('says a war with no server is resumable rather than going quiet', () => {
        const idle = row({ war: war({
            live: false, spectators: undefined, uptime_sec: undefined,
        }) });
        expect(formatWarDetail(idle)).toBe(
            'meridian_basin · Compact 2/8 · Union 1/8 · ' +
            'no server running — a join restarts it');
    });
});

describe('fightLabel', () => {
    it('offers a rejoin to a player who already holds a seat', () => {
        expect(fightLabel(row({ returning: true }))).toBe('Rejoin');
        expect(fightLabel(row())).toBe('Fight');
    });
});

// ── Per-side capacity + Deploy (PLAN-metalstorm-lobby.md §6, task 7) ────────
//
// Task 6 rendered one capacity for every side because there WAS one. §6's
// seeding sizes each side to its own faction's registered population, so the
// two sides of a war are routinely different sizes and a card that prints the
// war-level number against both is wrong on at least one of them.

describe('per-side capacity', () => {
    it('prefers the side\'s own capacity over the war-level fallback', () => {
        expect(formatSide(
            { team: 1, faction: 'union', bound: 3, open: 17, capacity: 20 },
            8, false)).toBe('Union 3/20');
    });
    it('falls back to the war-level number for a side that states none', () => {
        // Every war created before task 7 is this shape, and it must render
        // exactly as it did.
        expect(formatSide({ team: 0, faction: 'compact', bound: 2, open: 6 }, 8, false))
            .toBe('Compact 2/8');
    });
    it('prints a bare count for an unlimited side', () => {
        // There is no denominator, and inventing the fallback as one would
        // show a cap that does not exist.
        expect(formatSide(
            { team: 0, faction: 'compact', bound: 12, open: 0, capacity: 0, unlimited: true },
            8, false)).toBe('Compact 12');
    });
    it('never calls an unlimited side full', () => {
        // `open: 0` is what FULL looks like, and it is what the server sends
        // for an uncapped side because there is no count to send. Reading the
        // number alone locks everyone out of the one side that has no cap.
        const uncapped = war({ sides: [
            { team: 0, faction: 'compact', bound: 40, open: 0, capacity: 0, unlimited: true },
        ] });
        expect(hasRoomForFaction(uncapped, 'compact')).toBe(true);
    });
    it('still calls a full bounded side full', () => {
        const full = war({ sides: [
            { team: 0, faction: 'compact', bound: 8, open: 0, capacity: 8 },
        ] });
        expect(hasRoomForFaction(full, 'compact')).toBe(false);
    });
});

describe('formatDeploy', () => {
    it('says what it optimised for when it picks a war', () => {
        // Deploy sends a player somewhere they did not choose. Without the
        // reason, declining to send them to the busiest war on the list reads
        // as a random pick.
        expect(formatDeploy({
            outcome: 'join', faction: 'compact', underdog_by: 5,
            room_id: 2, room_name: 'Meridian Basin',
        })).toBe('Deploying to “Meridian Basin”: your side is outnumbered ' +
                 'there by 5, and needs you most.');
    });
    it('does not claim a deficit that is not there', () => {
        expect(formatDeploy({
            outcome: 'join', faction: 'compact', underdog_by: 0,
            room_id: 2, room_name: 'Meridian Basin',
        })).toBe('Deploying to “Meridian Basin”.');
    });
    it('names a return as a return', () => {
        expect(formatDeploy({
            outcome: 'return', faction: 'compact', underdog_by: 0,
            room_id: 1, room_name: 'The Long Siege',
        })).toContain('already hold a seat');
    });
    it('reads a full faction as a new war, not as a refusal', () => {
        // §6 offers "queue or seed"; this builds the second, so the wording
        // has to end somewhere rather than leave the player waiting.
        expect(formatDeploy({ outcome: 'seed', faction: 'compact', underdog_by: 0 }))
            .toContain('create a new war');
    });
    it('tells a factionless account it can still watch', () => {
        expect(formatDeploy({ outcome: 'no_faction', faction: '', underdog_by: 0 }))
            .toContain('watch any war');
    });
});
