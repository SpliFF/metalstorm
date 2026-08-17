import { describe, it, expect } from 'vitest';
import {
    filterWars, fightLabel, formatControl, formatSide, formatUptime,
    formatDeploy, formatWarDetail, hasRoomForFaction, sideForFaction,
    formatAgo, formatFrozenFrame, formatResumeRefusal, formatWarStatus,
    warStateBadge, sortMyWars, formatYourWar,
    type WarInfo, type WarRow,
} from './war-browser';
/// The digest's own away-wording, imported only to be held against the card's
/// (see the last case of `formatYourWar`): two modules, one rule.
import { formatAway } from './war-digest';

/// A fixed instant, so every "ago" in this file is arithmetic and not a clock.
const NOW = 1_700_000_000;

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

describe('filterWars friends-here (task 9a)', () => {
    const withFriend = row({ id: 1 });
    const without = row({ id: 2 });
    const wars = [withFriend, without];

    it('keeps the wars a friend is standing in right now', () => {
        expect(filterWars(wars, 'friends-here', 'compact', new Set([1])).map(w => w.id))
            .toEqual([1]);
    });

    it('keeps a war closed to my faction — the refusal is the point', () => {
        // §8's join must be able to say "your faction fields no side here" out
        // loud. Narrowing this filter to seatable wars would hide the war and
        // the refusal with it.
        const closed = row({ id: 3, war: war({ sides: [
            { team: 0, faction: 'robots', bound: 0, open: 8 },
        ] }) });
        expect(filterWars([...wars, closed], 'friends-here', 'compact', new Set([3]))
            .map(w => w.id)).toEqual([3]);
    });

    it('shows nothing — not everything — when no friend is in a war', () => {
        expect(filterWars(wars, 'friends-here', 'compact', new Set())).toHaveLength(0);
    });

    it('shows nothing when the friends list never arrived', () => {
        // A lobby with no friends routes, or a fetch that failed. The other
        // filters must be unaffected by the missing argument, which is the
        // reason it is optional rather than required.
        expect(filterWars(wars, 'friends-here', 'compact')).toHaveLength(0);
        expect(filterWars(wars, 'all', 'compact')).toHaveLength(2);
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
        expect(formatWarDetail(row(), NOW)).toBe(
            'meridian_basin · Compact 2/8 (1 AI) · Union 1/8 (0 online) · ' +
            '3 watching · up 15m');
    });
    it('says a war with no server is resumable rather than going quiet', () => {
        const idle = row({ war: war({
            live: false, spectators: undefined, uptime_sec: undefined,
        }) });
        expect(formatWarDetail(idle, NOW)).toBe(
            'meridian_basin · Compact 2/8 · Union 1/8 · ' +
            'no server running — a join restarts it');
    });
    it('carries the hibernation clause into the same line', () => {
        const hib = row({ war: war({
            live: false, spectators: undefined, uptime_sec: undefined,
            state: 'hibernated', frozen_frame: 226_800, frozen_at: NOW - 7200,
        }) });
        expect(formatWarDetail(hib, NOW)).toBe(
            'meridian_basin · Compact 2/8 · Union 1/8 · ' +
            'hibernated with 2h 06m of war (2h ago) — a join brings it back');
    });
});

// ── The hibernation datums on the card (PLAN-persistence task 4) ────────────
//
// Three fields the lobby has been publishing with no renderer: `war.state`,
// `frozen_frame`, and the E1 verdict. The property under test is that the
// three no-process states stay DISTINGUISHABLE: `live` is one bit, and a card
// built on it says the same thing about a war that saved cleanly, a war that
// crashed, and a war that is going back to frame 0.

describe('warStateBadge', () => {
    it('gives the three no-process states three different badges', () => {
        expect(warStateBadge(war({ state: 'hibernated' })).label).toBe('Hibernated');
        expect(warStateBadge(war({ state: 'crashed' })).label).toBe('Interrupted');
        expect(warStateBadge(war({ state: 'unresumable' })).label).toBe('Restarting');
        // …and the crashed pair does not wear the muted "nothing here" colour.
        expect(warStateBadge(war({ state: 'crashed' })).cls)
            .not.toBe(warStateBadge(war({ state: 'hibernated' })).cls);
    });
    it('names a resume in flight, which live/idle cannot', () => {
        expect(warStateBadge(war({ state: 'resuming' })).label).toBe('Resuming');
        expect(warStateBadge(war({ state: 'live' })).label).toBe('Live');
        expect(warStateBadge(war({ state: 'fresh' })).label).toBe('Not started');
    });
    it('a war that ENDED is not a war that was interrupted', () => {
        // wars task 4, D4: a scheduled post-game exit looks exactly like a
        // crash from the lobby's side, so every correctly-finished war wore
        // the "Interrupted" badge and told its players it had lost its tail.
        expect(warStateBadge(war({ live: false, state: 'finished' })).label).toBe('Ended');
        expect(warStateBadge(war({ live: false, state: 'finished' })).cls)
            .not.toBe(warStateBadge(war({ state: 'crashed' })).cls);
        const ended = formatWarStatus(war({ live: false, state: 'finished' }), 1000);
        expect(ended).toContain('over');
        expect(ended).not.toContain('without saving');
    });
    it('falls back to the live bit on a lobby that publishes no state', () => {
        expect(warStateBadge(war()).label).toBe('Live');
        expect(warStateBadge(war({ live: false })).label).toBe('Idle');
        expect(warStateBadge(war({ live: false, state: 'not_a_war' })).label).toBe('Idle');
    });
});

describe('formatFrozenFrame', () => {
    it('states a frame as the time a player played, not as a frame number', () => {
        expect(formatFrozenFrame(226_800)).toBe('2h 06m of war');
        expect(formatFrozenFrame(1800)).toBe('1m of war');
        expect(formatFrozenFrame(300)).toBe('10s of war');
    });
});

describe('formatAgo', () => {
    it('coarsens with distance', () => {
        expect(formatAgo(NOW - 30, NOW)).toBe('just now');
        expect(formatAgo(NOW - 600, NOW)).toBe('10m ago');
        expect(formatAgo(NOW - 7200, NOW)).toBe('2h ago');
        expect(formatAgo(NOW - 86_400 * 6, NOW)).toBe('6d ago');
    });
    it('never reads as the future when the clocks disagree', () => {
        expect(formatAgo(NOW + 500, NOW)).toBe('just now');
    });
});

describe('formatWarStatus', () => {
    const frozen = { frozen_frame: 226_800, frozen_at: NOW - 7200 };
    it('promises the world back when it was checkpointed', () => {
        expect(formatWarStatus(war({ live: false, state: 'hibernated', ...frozen }), NOW))
            .toBe('hibernated with 2h 06m of war (2h ago) — a join brings it back');
    });
    it('says what a crash costs instead of claiming hibernation', () => {
        const s = formatWarStatus(
            war({ live: false, state: 'crashed', ...frozen }), NOW);
        expect(s).toContain('without saving');
        expect(s).toContain('2h 06m of war');
        expect(s).toContain('anything after it is lost');
        expect(s).not.toContain('hibernated');
    });
    it('tells a player their frozen world is going back to frame 0, and why', () => {
        const s = formatWarStatus(war({
            live: false, state: 'unresumable', ...frozen,
            resume_eligibility: 'engine_changed',
            resume_blocked_reason: 'E1: the frozen world at frame 226800 was taken ' +
                'by engine aaaa… and this server binary is bbbb…',
        }), NOW);
        expect(s).toBe('2h 06m of war (2h ago) is frozen in the store, but the game ' +
            'has been updated since — this war restarts at the beginning');
        // The operator's hashes never reach the card's own sentence.
        expect(s).not.toContain('E1');
        expect(s).not.toContain('engine aaaa');
    });
    it('distinguishes an engine change from a map change', () => {
        expect(formatResumeRefusal(war({ resume_eligibility: 'map_changed' })))
            .toContain('the map has changed');
        expect(formatResumeRefusal(war({ resume_eligibility: 'engine_changed' })))
            .toContain('the game has been updated');
        // A refusal with no verdict still says the consequence.
        expect(formatResumeRefusal(war())).toContain('restarts at the beginning');
    });
    it('names a resume in flight so a joiner does not read it as "down"', () => {
        expect(formatWarStatus(war({ live: false, state: 'resuming', ...frozen }), NOW))
            .toBe('resuming — bringing back 2h 06m of war (2h ago)');
    });
    it('says nothing extra about a live war, and says "never run" about a fresh one', () => {
        expect(formatWarStatus(war({ state: 'live' }), NOW)).toBe('');
        expect(formatWarStatus(war({ live: false, state: 'fresh' }), NOW))
            .toBe('never run — a join starts it');
    });
    it('degrades to the old sentence when the lobby publishes no state', () => {
        expect(formatWarStatus(war({ live: false }), NOW))
            .toBe('no server running — a join restarts it');
        expect(formatWarStatus(war(), NOW)).toBe('');
    });
    it('reads correctly when a state arrives with no snapshot history', () => {
        expect(formatWarStatus(war({ live: false, state: 'hibernated' }), NOW))
            .toBe('hibernated — a join brings it back');
        expect(formatWarStatus(war({ live: false, state: 'crashed' }), NOW))
            .toBe('the server stopped without saving — a join restarts the war');
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

// ── "Your games" — PLAN-persistence.md §4, task 4c ────────────────────────
//
// The property under test: "My wars" is a list of the wars this account is
// ENLISTED in, and enlistment is durable. `returning` is a seating answer —
// "would a join put you back on your team" — and it goes false the moment the
// war's sides stop seating your faction on the team your binding records. A
// list keyed on it drops the war a player has a week of history in, which is
// the one row that list exists to hold.

describe('filterWars my-wars reads enlistment, not seating', () => {
    it('keeps a war whose seat was superseded', () => {
        const superseded = row({ id: 7, returning: false, enlisted: true, seat: 'superseded' });
        const stranger = row({ id: 8, returning: false, enlisted: false, seat: 'no_binding' });
        expect(filterWars([superseded, stranger], 'my-wars', 'compact').map(w => w.id))
            .toEqual([7]);
    });
    it('falls back to `returning` against a lobby that publishes no `enlisted`', () => {
        // A client ahead of its lobby. The old bit is still the best answer
        // available, and reading a missing field as `false` would empty the
        // list for every player on that lobby.
        const old = row({ id: 9, returning: true });
        expect(filterWars([old], 'my-wars', 'compact').map(w => w.id)).toEqual([9]);
    });
    it('does not keep a war I only watch', () => {
        const watched = row({ id: 10, watching: true, enlisted: false });
        expect(filterWars([watched], 'my-wars', 'compact')).toHaveLength(0);
    });
});

describe('sortMyWars', () => {
    const at = (id: number, state: WarInfo['state'], frozenAt?: number) =>
        row({ id, enlisted: true, war: war({ live: state === 'live', state, frozen_at: frozenAt }) });

    it('puts the war being played first and the one that never started last', () => {
        const rows = [
            at(1, 'fresh'), at(2, 'hibernated', NOW - 100), at(3, 'live'),
            at(4, 'crashed', NOW - 100), at(5, 'resuming'),
        ];
        expect(sortMyWars(rows).map(w => w.id)).toEqual([3, 5, 4, 2, 1]);
    });
    it('within a rank, the most recently frozen world comes first', () => {
        const rows = [
            at(1, 'hibernated', NOW - 3600), at(2, 'hibernated', NOW - 60),
            at(3, 'hibernated', NOW - 600),
        ];
        expect(sortMyWars(rows).map(w => w.id)).toEqual([2, 3, 1]);
    });
    it('sorts a war with no snapshot last in its rank, not first', () => {
        // "Never frozen" is not "frozen just now". A sentinel at the top of the
        // range (`?? Infinity`, the reading that treats an absent snapshot as
        // the freshest thing on the list) fails this; `?? 0` and `?? -1` are
        // the same behaviour, since unix seconds are never negative.
        const rows = [at(1, 'hibernated'), at(2, 'hibernated', NOW - 3600)];
        expect(sortMyWars(rows).map(w => w.id)).toEqual([2, 1]);
    });
    it('is stable across ticks when everything else ties', () => {
        const rows = [at(3, 'live'), at(1, 'live'), at(2, 'live')];
        expect(sortMyWars(rows).map(w => w.id)).toEqual([1, 2, 3]);
        expect(sortMyWars(rows.slice().reverse()).map(w => w.id)).toEqual([1, 2, 3]);
    });
    it('does not mutate its input', () => {
        const rows = [at(2, 'hibernated', NOW), at(1, 'live')];
        sortMyWars(rows);
        expect(rows.map(w => w.id)).toEqual([2, 1]);
    });
});

describe('formatYourWar', () => {
    it('says nothing about a war I am not in', () => {
        expect(formatYourWar(row({ enlisted: false }))).toBe('');
    });
    it('names my side, my absence and the world waiting for me', () => {
        const s = formatYourWar(row({
            enlisted: true, seat: 'restored', mySide: 'union', awaySec: 3 * 86400,
            war: war({ live: false, state: 'hibernated', frozen_frame: 226_800 }),
        }));
        expect(s).toContain('your side: Union');
        expect(s).toContain('away 3 days');
        expect(s).toContain('2h 06m of war waiting for you');
    });
    it('names a superseded seat instead of a side it no longer holds', () => {
        const s = formatYourWar(row({
            enlisted: true, seat: 'superseded', mySide: '', awaySec: 7200,
            war: war({ live: false, state: 'hibernated', frozen_frame: 9000 }),
        }));
        expect(s).toContain('no longer exists');
        expect(s).not.toContain('your side');
        // The history is still theirs — the frozen world is still quoted.
        expect(s).toContain('waiting for you');
    });
    it('does not call a live war "waiting for you"', () => {
        // `frozen_frame` is published while a war is live too, where it is the
        // last durable point rather than the current world.
        const s = formatYourWar(row({
            enlisted: true, seat: 'restored', mySide: 'compact', awaySec: 600,
            war: war({ live: true, state: 'live', frozen_frame: 9000 }),
        }));
        expect(s).toContain('your side: Compact');
        expect(s).not.toContain('waiting for you');
    });
    it('omits an absence too short to be one', () => {
        const s = formatYourWar(row({
            enlisted: true, seat: 'restored', mySide: 'compact', awaySec: 20,
            war: war({ live: true, state: 'live' }),
        }));
        expect(s).toBe('your side: Compact');
    });
    it('says the away window in the same words as the digest heading', () => {
        // Two modules, one rule. If either drifts this fails rather than
        // shipping a card that says "away 2 hours" over a digest headed
        // "While you were away (120 minutes)".
        for (const sec of [3600 * 3, 86400 * 5, 60 * 30]) {
            const line = formatYourWar(row({
                enlisted: true, seat: 'restored', mySide: 'compact', awaySec: sec,
                war: war({ live: true, state: 'live' }),
            }));
            expect(line).toContain(`away ${formatAway(sec)}`);
        }
    });
    it('says nothing when enlistment is all it knows', () => {
        // No side, no absence, no snapshot: an enlisted account in a war that
        // has never run. An empty line is correct, and `.war-yours:empty`
        // hides the div rather than leaving a coloured husk.
        expect(formatYourWar(row({
            enlisted: true, seat: 'restored', war: war({ live: false, state: 'fresh' }),
        }))).toBe('');
    });
});
