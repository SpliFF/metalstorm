/**
 * war-browser.review.test.ts — review sweep 2026-09-10 (war-surfaces lane).
 *
 * Three things the browser could not say before this sweep:
 *   1. the Director's PHASE — a war that is seeding, ending, settling or
 *      archived is not a war to walk into, whatever its process says;
 *   2. Deploy's real answer — a seeded war comes WITH a room id, and a room
 *      id can come WITHOUT a held seat;
 *   3. the summary card / detail drawer split the drill-down directive asks
 *      for, derived here so the DOM renders a model rather than a paragraph.
 */

import { describe, it, expect } from 'vitest';
import {
    archivedCount, deployIsEnterable, filterWars, formatDeploy, formatEta,
    formatMyStake, formatSeated, formatSidesLine, formatWarStatus,
    hasRoomForFaction, primaryAction, sortMyWars, warAcceptsJoiners,
    warCardModel, warDrawerModel, warIsOver, warStateBadge, worldFocusDetail,
    type DeployResult, type WarInfo, type WarRow,
} from './war-browser';

const NOW = 1_700_000_000;

function war(over: Partial<WarInfo> = {}): WarInfo {
    return {
        live: true,
        capacity_per_side: 8,
        sides: [
            { team: 0, faction: 'compact', bound: 2, open: 6, online: 1, ais: 1, regions: 4 },
            { team: 1, faction: 'union', bound: 1, open: 7, online: 1, ais: 0, regions: 3 },
        ],
        spectators: 3,
        uptime_sec: 900,
        control: { total: 11, contested: 2, neutral: 4 },
        state: 'live',
        ...over,
    };
}

function row(over: Partial<WarRow> = {}): WarRow {
    return { id: 1, name: 'Meridian', mapId: 'meridian_basin', state: 4, war: war(), ...over };
}

describe('the Director phase (proposed `war.phase`)', () => {
    it('an absent phase is unknown, not over and not closed', () => {
        expect(warIsOver(war())).toBe(false);
        expect(warAcceptsJoiners(war())).toBe(true);
    });

    it('the three closing phases and a finished process are over', () => {
        for (const phase of ['winding_down', 'resolving', 'archived'] as const)
            expect(warIsOver(war({ phase }))).toBe(true);
        expect(warIsOver(war({ state: 'finished' }))).toBe(true);
        expect(warIsOver(war({ phase: 'active' }))).toBe(false);
    });

    it('seeding is not over but takes no joiners', () => {
        expect(warIsOver(war({ phase: 'seeding' }))).toBe(false);
        expect(warAcceptsJoiners(war({ phase: 'seeding' }))).toBe(false);
    });

    it('every process state on an open war accepts joiners — even a lost tail', () => {
        for (const state of ['crashed', 'unresumable', 'hibernated', 'fresh'] as const)
            expect(warAcceptsJoiners(war({ phase: 'open', state }))).toBe(true);
    });

    it('a phase outranks the seats: an archived war has no room for anyone', () => {
        expect(hasRoomForFaction(war(), 'compact')).toBe(true);
        expect(hasRoomForFaction(war({ phase: 'archived' }), 'compact')).toBe(false);
        expect(hasRoomForFaction(war({ phase: 'seeding' }), 'compact')).toBe(false);
    });

    it('the badge says the phase when the phase is the truer word', () => {
        // A live process on an archived war is paperwork, not a battle.
        expect(warStateBadge(war({ phase: 'archived', state: 'live' })).label).toBe('Archived');
        expect(warStateBadge(war({ phase: 'winding_down' })).label).toBe('Ending');
        expect(warStateBadge(war({ phase: 'resolving' })).label).toBe('Settling');
        expect(warStateBadge(war({ phase: 'seeding', state: 'fresh' })).label).toBe('Seeding');
        // And stays out of the way while the war is simply being fought.
        expect(warStateBadge(war({ phase: 'active', state: 'hibernated' })).label).toBe('Hibernated');
    });

    it('the status sentence never promises a resume on a war that is over', () => {
        const s = formatWarStatus(war({ phase: 'archived', state: 'hibernated', frozen_frame: 9000 }), NOW);
        expect(s).toMatch(/archived/);
        expect(s).not.toMatch(/brings it back/);
        expect(formatWarStatus(war({ phase: 'seeding', state: 'fresh' }), NOW)).toMatch(/seeded/);
        expect(formatWarStatus(war({ phase: 'winding_down' }), NOW)).toMatch(/watched/);
    });
});

describe('filterWars hides archived wars behind a reveal', () => {
    const rows = [
        row({ id: 1 }),
        row({ id: 2, war: war({ phase: 'archived' }), enlisted: true }),
        row({ id: 3, war: war({ phase: 'winding_down' }) }),
    ];

    it('drops archived from my-faction and all by default', () => {
        expect(filterWars(rows, 'my-faction', 'compact').map(r => r.id)).toEqual([1, 3]);
        expect(filterWars(rows, 'all', 'compact').map(r => r.id)).toEqual([1, 3]);
    });

    it('keeps them when asked', () => {
        expect(filterWars(rows, 'all', 'compact', undefined, { includeArchived: true })
            .map(r => r.id)).toEqual([1, 2, 3]);
    });

    it('never drops them from my-wars — the record is the player\'s own', () => {
        expect(filterWars(rows, 'my-wars', 'compact').map(r => r.id)).toEqual([2]);
    });

    it('counts what it hid', () => {
        expect(archivedCount(rows)).toBe(1);
    });

    it('sorts an archived war below a finished one in my-wars', () => {
        const sorted = sortMyWars([
            row({ id: 5, war: war({ phase: 'archived', state: 'live' }) }),
            row({ id: 6, war: war({ state: 'finished' }) }),
            row({ id: 7, war: war({ state: 'hibernated' }) }),
        ]);
        expect(sorted.map(r => r.id)).toEqual([7, 6, 5]);
    });
});

describe('Deploy\'s real contract', () => {
    const base: DeployResult = { outcome: 'join', faction: 'compact', underdog_by: 0 };

    it('a seeded war is a destination, not a Create Game form', () => {
        const d: DeployResult = { ...base, outcome: 'seed', room_id: 9, room_name: 'Fresh',
                                  seeded: true, reservation: 'granted', reservation_expires_in: 60 };
        expect(deployIsEnterable(d)).toBe(true);
        const s = formatDeploy(d);
        expect(s).toMatch(/seeded for you/);
        expect(s).toMatch(/“Fresh”/);
        expect(s).toMatch(/held for 1 min/);
        expect(s).not.toMatch(/create a new/);
    });

    it('a failed seed says why and where to go instead', () => {
        const d: DeployResult = { ...base, outcome: 'seed', seed_error: 'no theatre free' };
        expect(deployIsEnterable(d)).toBe(false);
        expect(formatDeploy(d)).toMatch(/could not be seeded \(no theatre free\)/);
    });

    it('an older lobby that never seeds still gets the old sentence', () => {
        expect(formatDeploy({ ...base, outcome: 'seed' })).toMatch(/create a new war/);
    });

    it('a room without a held seat is not enterable and says so', () => {
        const d: DeployResult = { ...base, room_id: 4, room_name: 'X', reservation: 'side_full' };
        expect(deployIsEnterable(d)).toBe(false);
        expect(formatDeploy(d)).toMatch(/No seat could be held/);
        // An absent reservation is an older lobby: best-effort join, as before.
        expect(deployIsEnterable({ ...base, room_id: 4 })).toBe(true);
        expect(deployIsEnterable({ ...base, outcome: 'no_faction', room_id: 4 })).toBe(false);
    });

    it('names the rejoin fall-through to the veteran it happens to', () => {
        const s = formatDeploy({ ...base, room_id: 4, room_name: 'Y', rejoin_fell_through: true, underdog_by: 2 });
        expect(s).toMatch(/^Your own war could not seat you back, so: deploying to “Y”/);
        expect(s).toMatch(/outnumbered there by 2/);
    });
});

describe('primaryAction', () => {
    it('offers a seat when there is one', () => {
        expect(primaryAction(row(), 'compact')).toMatchObject({ kind: 'fight', enabled: true });
        expect(primaryAction(row({ returning: true }), 'compact')).toMatchObject({ kind: 'rejoin', enabled: true });
    });

    it('explains a dead Fight button', () => {
        expect(primaryAction(row(), '').why).toMatch(/no faction/);
        expect(primaryAction(row(), 'free_cities').why).toMatch(/Free_cities fields no side/);
        const full = row({ war: war({ sides: [{ team: 0, faction: 'compact', bound: 8, open: 0, capacity: 8 }] }) });
        expect(primaryAction(full, 'compact')).toMatchObject({ enabled: false, why: 'Your side is full (8/8).' });
    });

    it('offers only Watch on a war that is over or not yet seeded — even to a veteran', () => {
        expect(primaryAction(row({ returning: true, war: war({ phase: 'archived' }) }), 'compact'))
            .toMatchObject({ kind: 'watch', enabled: true });
        expect(primaryAction(row({ war: war({ phase: 'seeding' }) }), 'compact').why).toMatch(/seeded/);
    });
});

describe('the card and the drawer', () => {
    it('formats the small clauses', () => {
        expect(formatEta(0)).toBe('arriving now');
        expect(formatEta(45)).toBe('in 45s');
        expect(formatEta(130)).toBe('in 2m');
        expect(formatEta(3720)).toBe('in 1h 02m');
        expect(formatSidesLine(war())).toBe('Compact 2/8 vs Union 1/8');
        expect(formatSeated(war())).toBe('3 seated · 2 online · 1 AI · 3 watching');
        expect(formatSeated(war({ live: false }))).toBe('3 seated');
    });

    it('says my stake only when the lobby publishes one', () => {
        expect(formatMyStake(war(), 'compact')).toBe('');
        const staked = war({ stakes: {
            escrow: [{ faction: 'compact', transports: 1, squads: 2, state: 'engaged' },
                     { faction: 'union', transports: 3, squads: 6, state: 'committed' }],
            claims: [{ faction: 'compact', state: 'open' }, { faction: 'union', state: 'lost' }],
        } });
        expect(formatMyStake(staked, 'compact')).toBe('2 squads on 1 transport in escrow · a claim on the ground');
        expect(formatMyStake(staked, 'union')).toBe('6 squads on 3 transports in escrow');
        expect(formatMyStake(staked, '')).toBe('');
    });

    it('the card is a summary: sides, seats, status, action — no digest, no front', () => {
        const m = warCardModel(row({ enlisted: true, mySide: 'compact',
                                     war: war({ next_arrival_sec: 90 }) }), 'compact', NOW);
        expect(m).toMatchObject({
            id: 1, title: 'Meridian', mapId: 'meridian_basin',
            sides: 'Compact 2/8 vs Union 1/8', eta: 'next arrival in 1m',
            yours: 'your side: Compact', yoursLost: false, status: '',
        });
        expect(m.action.kind).toBe('rejoin' === m.action.kind ? 'rejoin' : 'fight');
        expect(Object.keys(m)).not.toContain('front');
    });

    it('the drawer carries the rest, and omits what the lobby does not publish', () => {
        const d = warDrawerModel(row(), 'compact', NOW);
        expect(d.sideLines).toEqual(['Compact 2/8 (1 online, 1 AI)', 'Union 1/8']);
        expect(d.front).toBe('11 regions · 2 contested · 4 neutral');
        expect(d.uptime).toBe('up 15m');
        expect(d.stakeLines).toEqual([]);
        expect(d.claimLines).toEqual([]);
        expect(d.poiId).toBe('');
        const staked = warDrawerModel(row({ war: war({ poi_id: 'poi:ridge', stakes: {
            escrow: [{ faction: 'union', transports: 3, squads: 6, state: 'engaged' }],
            claims: [{ faction: 'union', state: 'open' }, { faction: 'compact', state: 'withdrawn' }],
        } }) }), 'compact', NOW);
        expect(staked.stakeLines).toEqual(['Union: 6 squads on 3 transports (engaged)']);
        expect(staked.claimLines).toEqual(['Union has filed a claim']);
        expect(staked.poiId).toBe('poi:ridge');
    });

    it('the world-focus event carries room, map and (when known) POI', () => {
        expect(worldFocusDetail(row())).toEqual({ roomId: 1, mapId: 'meridian_basin', poiId: '' });
        expect(worldFocusDetail(row({ war: war({ poi_id: 'p1' }) })).poiId).toBe('p1');
    });
});
