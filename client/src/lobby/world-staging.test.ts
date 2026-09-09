// @vitest-environment happy-dom
/**
 * world-staging.test.ts — PLAN-worldsim.md W10, the client half.
 *
 * W10 is the milestone where the map stops being a picture of the world and
 * starts being a place you can act on: a faction commits force at a POI it
 * does not hold, and everyone watching sees a countdown before a battle
 * exists. So the defects worth a test here are not layout ones. They are:
 *
 *   - showing a countdown that disagrees with the server's, which is the one
 *     thing a WARNING mechanic cannot survive (Capture 28: the attacker's
 *     transit is the defender's hours of notice)
 *   - offering a control the world would refuse, so the player learns the
 *     rule from an error instead of from the panel
 *   - painting a stale commitment after a refresh, i.e. lying about how big
 *     the incoming attack is
 *   - predicting a window the server would not open (the pure half:
 *     `predictStagingWindow` mirrors `WorldStaging::Commit`'s pricing)
 *
 * The DOM half runs under happy-dom, the same way briefing.test.ts does; the
 * pure half needs no DOM at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseWorldGraph, tickWorldClock } from './world-map';
import { WorldScreen, commitErrorText } from './world-screen';
import {
    parseStagingRules, stagingWindowFor, cheapestTransitTo, predictStagingWindow,
    stagingControlState, remainingAfter, cleanForceField, DEFAULT_STAGING_RULES,
} from './world-staging';

const CLOCK = {
    worldId: 'earth', name: 'Earth',
    clock: { worldMs: 5_000_000, paused: false, ratioNum: 24, ratioDen: 1, day: 1, hour: 1, minute: 23 },
};

/// `GET /api/world/pois` with one held POI, one contested one, and a
/// world-only one — the three cases the commitment control branches on.
export function poisBody(staging: unknown[] = []): any {
    return {
        worldId: 'earth',
        pois: [
            { id: 'home', name: 'Home', lat: 10, lon: 10, mapId: 'meridian_basin',
              owner: 'ours', battleStatus: 'quiet', staging: [] },
            { id: 'target', name: 'Randtown', lat: 20, lon: 20, mapId: 'meridian_basin',
              owner: 'theirs', battleStatus: staging.length ? 'staging' : 'quiet',
              staging },
            { id: 'void', name: 'Deep Field', lat: 30, lon: 30, mapId: null,
              owner: null, battleStatus: 'quiet', staging: [] },
        ],
        edges: [{ from: 'home', to: 'target', transitWorldMs: 6 * 3600_000 }],
        factions: {
            ours:   { name: 'Ours', colour: '#33cc66', archetype: 'order', state: 'active' },
            theirs: { name: 'Theirs', colour: '#cc3333', archetype: 'order', state: 'active' },
        },
    };
}

export function stagingEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        stagingId: 3, attackerFaction: 'ours', originPoiId: 'home',
        transports: 2, squads: 5,
        remainingWorldMs: 4 * 3600_000, endsAtWorldMs: 5_000_000 + 4 * 3600_000,
        ...over,
    };
}

/// `POST /api/world/me` as W7/W8 parse it — membership (which faction this
/// account belongs to) plus the stat family.
export function meBody(factionId: string | null): unknown {
    return {
        worldId: 'earth',
        accountId: 7,
        authority: 40,
        canFound: false,
        sideKey: null,
        membership: factionId === null ? null
            : { factionId, role: 'member', rank: 0, name: factionId === 'ours' ? 'Ours' : 'Theirs', colour: '#33cc66' },
        rank: factionId === null ? { factionId: null, total: 0, commanderCount: 0, poiCount: 0, loanedCount: 0, terms: {} }
            : { factionId, total: 3, commanderCount: 1, poiCount: 1, loanedCount: 0, terms: {} },
        capacity: { max: 10, spent: 0, available: 10, nextRechargeInMs: 0, rechargeHours: 24 },
        commanders: [],
    };
}

// ─────────────────────────── parsing ───────────────────────────

describe('W10: parsing the staging array off GET /api/world/pois', () => {
    it('carries every field the countdown is drawn from', () => {
        const g = parseWorldGraph(poisBody([stagingEntry()]))!;
        const target = g.pois.find(p => p.id === 'target')!;
        expect(target.staging).toHaveLength(1);
        expect(target.staging[0]).toMatchObject({
            stagingId: 3, attackerFaction: 'ours', originPoiId: 'home',
            transports: 2, squads: 5, remainingWorldMs: 4 * 3600_000,
        });
        expect(target.battleStatus).toBe('staging');
    });

    it('a POI with no staging key parses as an empty array, not undefined', () => {
        const g = parseWorldGraph({ pois: [{ id: 'x', lat: 0, lon: 0 }] })!;
        expect(g.pois[0].staging).toEqual([]);
    });

    it('drops a malformed entry rather than defaulting its force to zero', () => {
        const g = parseWorldGraph(poisBody([
            stagingEntry(),
            stagingEntry({ stagingId: 0 }),
            stagingEntry({ attackerFaction: '' }),
            'not an object',
        ]))!;
        expect(g.pois.find(p => p.id === 'target')!.staging.map(s => s.stagingId)).toEqual([3]);
    });

    it('never reports a negative countdown', () => {
        const g = parseWorldGraph(poisBody([stagingEntry({ remainingWorldMs: -90_000 })]))!;
        expect(g.pois.find(p => p.id === 'target')!.staging[0].remainingWorldMs).toBe(0);
    });

    it('takes the countdown from the SERVER, never from the local clock', () => {
        const g = parseWorldGraph(poisBody([
            stagingEntry({ remainingWorldMs: 777, endsAtWorldMs: 999_999_999 }),
        ]))!;
        expect(g.pois.find(p => p.id === 'target')!.staging[0].remainingWorldMs).toBe(777);
    });
});

describe('W10: the route tokens become sentences', () => {
    it('states the rule rather than the token', () => {
        expect(commitErrorText('no_transport')).toMatch(/transport/i);
        expect(commitErrorText('already_held')).toMatch(/already holds/i);
        expect(commitErrorText('no_battle_map')).toMatch(/no battle map/i);
        expect(commitErrorText('unauthorized')).toMatch(/sign in/i);
    });

    it('degrades to the token for a reason this client has never heard of', () => {
        expect(commitErrorText('some_future_reason')).toBe('some_future_reason');
    });
});

// ─────────────────────────── the pure pricing ───────────────────────────

describe('staging rules: the window is priced as the server prices it', () => {
    it('reads the server\'s config keys off /api/world and falls back per key', () => {
        const r = parseStagingRules({ config: { stagingWindowMinWorldMs: 5, stagingWindowMaxWorldMs: 'nope' } });
        expect(r.stagingWindowMinWorldMs).toBe(5);
        expect(r.stagingWindowMaxWorldMs).toBe(DEFAULT_STAGING_RULES.stagingWindowMaxWorldMs);
        expect(parseStagingRules(null)).toEqual(DEFAULT_STAGING_RULES);
    });

    it('StagingWindowFor: transit × factor, clamped; no transit → the default', () => {
        const rules = { ...DEFAULT_STAGING_RULES, stagingWindowPerTransitMs: 2 };
        expect(stagingWindowFor(6 * 3600_000, rules)).toBe(12 * 3600_000);
        expect(stagingWindowFor(0, rules)).toBe(rules.stagingWindowDefaultWorldMs);
        // the floor: a near cluster cannot produce a no-warning attack
        expect(stagingWindowFor(60_000, rules)).toBe(rules.stagingWindowMinWorldMs);
        // the ceiling
        expect(stagingWindowFor(1000 * 3600_000, rules)).toBe(rules.stagingWindowMaxWorldMs);
    });

    it('a max below the min is a misconfiguration and the floor wins', () => {
        const rules = { ...DEFAULT_STAGING_RULES, stagingWindowMinWorldMs: 10, stagingWindowMaxWorldMs: 5 };
        expect(stagingWindowFor(3, rules)).toBe(10);
    });

    it('CheapestTransitTo: direct edges only, one-way honoured, cheapest wins', () => {
        const edges = [
            { from: 'a', to: 't', transitWorldMs: 5, kind: '', bidirectional: true, config: {} },
            { from: 'b', to: 't', transitWorldMs: 3, kind: '', bidirectional: true, config: {} },
            // one-way AWAY from the target: not a route to it
            { from: 't', to: 'c', transitWorldMs: 1, kind: '', bidirectional: false, config: {} },
            // bidirectional listed from the target's side still counts
            { from: 't', to: 'd', transitWorldMs: 2, kind: '', bidirectional: true, config: {} },
            // two hops: a→x→t is NOT priced (the server does not route)
            { from: 'x', to: 't', transitWorldMs: 1, kind: '', bidirectional: true, config: {} },
        ];
        expect(cheapestTransitTo(edges, ['a', 'b', 'c'], 't')).toEqual({ worldMs: 3, originId: 'b' });
        expect(cheapestTransitTo(edges, ['d'], 't')).toEqual({ worldMs: 2, originId: 'd' });
        expect(cheapestTransitTo(edges, ['c'], 't')).toEqual({ worldMs: 0, originId: null });
        expect(cheapestTransitTo(edges, [], 't')).toEqual({ worldMs: 0, originId: null });
    });

    it('predictStagingWindow marches from the faction\'s holdings', () => {
        const g = parseWorldGraph(poisBody())!;
        const p = predictStagingWindow(g, 'ours', 'target', DEFAULT_STAGING_RULES);
        expect(p).toEqual({ transitWorldMs: 6 * 3600_000, originId: 'home', windowWorldMs: 6 * 3600_000, priced: 'edge' });
        const q = predictStagingWindow(g, 'theirs', 'home', DEFAULT_STAGING_RULES);
        expect(q.priced).toBe('edge');   // target→home is the same bidirectional edge
        const none = predictStagingWindow(g, null, 'target', DEFAULT_STAGING_RULES);
        expect(none).toMatchObject({ priced: 'default', originId: null, windowWorldMs: 12 * 3600_000 });
    });

    it('stagingControlState restates §7.1 as which control exists', () => {
        const poi = { mapId: 'm', owner: 'theirs' };
        expect(stagingControlState(poi, 'ours', false)).toBe('no-session');
        expect(stagingControlState(poi, null, true)).toBe('no-faction');
        expect(stagingControlState({ mapId: null, owner: null }, 'ours', true)).toBe('world-only');
        expect(stagingControlState({ mapId: 'm', owner: 'ours' }, 'ours', true)).toBe('held');
        expect(stagingControlState(poi, 'ours', true)).toBe('offer');
    });

    it('remainingAfter ticks a served countdown and never goes negative', () => {
        expect(remainingAfter(3600_000, 60_000)).toBe(3540_000);
        expect(remainingAfter(1000, 5000)).toBe(0);
        expect(remainingAfter(1000, -5)).toBe(1000);
        expect(remainingAfter(NaN, 5)).toBe(0);
    });

    it('cleanForceField: at least one, an integer, capped', () => {
        expect(cleanForceField('3')).toBe(3);
        expect(cleanForceField('-4')).toBe(1);
        expect(cleanForceField('x')).toBe(1);
        expect(cleanForceField('2.9')).toBe(2);
        expect(cleanForceField('1000')).toBe(99);
    });
});

// ─────────────────────────── the panel ───────────────────────────

/// The lobby template ships only the shell; `mount()` fills it.
export function mountPanel(): void {
    document.body.innerHTML = `<div id="world-panel" style="display:none"></div>`;
}

export interface Call { path: string; body: unknown }

export function makeScreen(opts: {
    faction: string | null,
    staging?: unknown[],
    commitAnswer?: unknown,
    withPost?: boolean,
    me?: unknown,
    now?: () => number,
    isAdmin?: boolean,
}): { screen: WorldScreen, calls: Call[] } {
    const calls: Call[] = [];
    let staging = opts.staging ?? [];
    const deps: any = {
        get: async (path: string) => {
            calls.push({ path, body: null });
            if (path === '/api/world') return CLOCK;
            if (path === '/api/world/pois') return poisBody(staging);
            if (path === '/api/world/claims') return { worldId: 'earth', rules: { claimPoiCost: 25, claimRefundFraction: 0.5, claimExpiryWorldMs: 0 }, claims: [] };
            return null;
        },
        now: opts.now,
        isAdmin: opts.isAdmin === undefined ? undefined : () => opts.isAdmin,
    };
    if (opts.withPost !== false) {
        deps.post = async (path: string, body: unknown) => {
            calls.push({ path, body });
            if (path === '/api/world/me') return opts.me ?? meBody(opts.faction);
            if (path === '/api/world/staging/commit') {
                if (opts.commitAnswer !== undefined) return opts.commitAnswer;
                // The server prices the window; the client learns it by
                // re-reading, which is what makes the countdown honest.
                staging = [stagingEntry({ transports: 2, squads: 3 })];
                return { ok: true, joined: false, staging: staging[0] };
            }
            if (path === '/api/world/staging/cancel') {
                staging = [];
                return { ok: true, cancelled: true };
            }
            return null;
        };
    }
    return { screen: new WorldScreen(deps), calls };
}

export async function stage(opts: Parameters<typeof makeScreen>[0], poiId = 'target') {
    mountPanel();
    const made = makeScreen(opts);
    made.screen.mount();
    await made.screen.refresh();
    await made.screen.refreshStats();
    made.screen.selectPoi(poiId);
    return made;
}

export function detail(): string {
    return document.getElementById('world-drawer-body')!.innerHTML;
}

export const flush = () => new Promise(r => setTimeout(r, 0));
export function click(sel: string): void {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error(`no element ${sel}`);
    el.dispatchEvent(new Event('click'));
}

describe('W10: the commitment control is only offered where the rule allows it', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('offers Commit at a POI held by somebody else', async () => {
        await stage({ faction: 'ours' });
        expect(document.getElementById('world-commit-btn')).not.toBeNull();
        expect(detail()).toMatch(/Stage an attack/);
    });

    it('offers nothing at a POI your own faction holds', async () => {
        await stage({ faction: 'ours' }, 'home');
        expect(document.getElementById('world-commit-btn')).toBeNull();
        expect(detail()).toMatch(/holds this place/i);
    });

    it('offers nothing at a world-only POI', async () => {
        await stage({ faction: 'ours' }, 'void');
        expect(document.getElementById('world-commit-btn')).toBeNull();
        expect(detail()).toMatch(/no battle can be staged/i);
    });

    it('asks a factionless player to join one instead of failing them later', async () => {
        await stage({ faction: null });
        expect(document.getElementById('world-commit-btn')).toBeNull();
        expect(detail()).toMatch(/join a faction/i);
    });

    it('offers nothing at all without a session', async () => {
        await stage({ faction: null, withPost: false });
        expect(document.getElementById('world-commit-btn')).toBeNull();
        expect(detail()).toMatch(/sign in/i);
    });

    it('a refused session (401) is told to sign in, not to join a faction', async () => {
        await stage({ faction: null, me: { error: 'unauthorized' } });
        expect(document.getElementById('world-commit-btn')).toBeNull();
        expect(detail()).toMatch(/sign in/i);
    });

    it('shows the transit from your holdings and the window it prices', async () => {
        await stage({ faction: 'ours' });
        expect(detail()).toMatch(/From your holdings/);
        expect(detail()).toMatch(/March from Home/);
        expect(detail()).toMatch(/6h/);
    });
});

describe('W10: committing force', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('asks for confirmation first, stating the force and the window', async () => {
        const { calls } = await stage({ faction: 'ours' });
        (document.getElementById('world-commit-transports') as HTMLInputElement).value = '3';
        (document.getElementById('world-commit-squads') as HTMLInputElement).value = '7';
        click('#world-commit-btn');
        expect(calls.find(c => c.path === '/api/world/staging/commit')).toBeUndefined();
        expect(detail()).toMatch(/3× transport, 7 squads/);
        expect(detail()).toMatch(/Expected window: 6h/);
        // the typed force survives the confirm re-render
        expect((document.getElementById('world-commit-transports') as HTMLInputElement).value).toBe('3');
    });

    it('posts the POI and the force, and never the faction', async () => {
        // The attacker is read from the session's membership server-side; a
        // body-supplied faction is a way to start a war in someone else's
        // name, exactly as the founding route refuses a body-supplied side.
        const { calls } = await stage({ faction: 'ours' });
        (document.getElementById('world-commit-transports') as HTMLInputElement).value = '3';
        (document.getElementById('world-commit-squads') as HTMLInputElement).value = '7';
        click('#world-commit-btn');
        click('[data-act="commit-confirm"]');
        await flush();
        const post = calls.find(c => c.path === '/api/world/staging/commit')!;
        expect(post.body).toEqual({ poi: 'target', transports: 3, squads: 7 });
        expect(JSON.stringify(post.body)).not.toMatch(/faction/i);
    });

    it('re-reads the map, so the countdown shown is the one the server priced', async () => {
        const { calls } = await stage({ faction: 'ours' });
        click('#world-commit-btn');
        click('[data-act="commit-confirm"]');
        await flush();
        expect(calls.filter(c => c.path === '/api/world/pois').length).toBeGreaterThan(1);
        expect(detail()).toMatch(/Forces gathering/);
        expect(detail()).toMatch(/2× transport/);
        expect(detail()).toMatch(/in escrow/);
    });

    it('nonsense in the force fields becomes the minimum the rule names', async () => {
        const { calls } = await stage({ faction: 'ours' });
        (document.getElementById('world-commit-transports') as HTMLInputElement).value = '-4';
        (document.getElementById('world-commit-squads') as HTMLInputElement).value = 'x';
        click('#world-commit-btn');
        click('[data-act="commit-confirm"]');
        await flush();
        expect(calls.find(c => c.path === '/api/world/staging/commit')!.body)
            .toEqual({ poi: 'target', transports: 1, squads: 1 });
    });

    it('Cancel on the confirm posts nothing', async () => {
        const { calls } = await stage({ faction: 'ours' });
        click('#world-commit-btn');
        click('[data-act="cancel-confirm"]');
        await flush();
        expect(calls.find(c => c.path === '/api/world/staging/commit')).toBeUndefined();
        expect(document.querySelector('.world-confirm')).toBeNull();
    });

    it('shows a refusal as the rule, and keeps showing it after the re-read', async () => {
        await stage({ faction: 'ours', commitAnswer: { ok: false, error: 'no_transport' } });
        click('#world-commit-btn');
        click('[data-act="commit-confirm"]');
        await flush();
        expect(detail()).toMatch(/at least one transport/i);
    });

    it('a discarded refusal still says something, never "done"', async () => {
        await stage({ faction: 'ours', commitAnswer: null });
        click('#world-commit-btn');
        click('[data-act="commit-confirm"]');
        await flush();
        expect(detail()).toMatch(/could not accept/i);
    });

    it('a 403 not_in_a_faction body is read as its token, not as success', async () => {
        await stage({ faction: 'ours', commitAnswer: { error: 'not_in_a_faction' } });
        click('#world-commit-btn');
        click('[data-act="commit-confirm"]');
        await flush();
        expect(detail()).toMatch(/join a faction/i);
    });
});

describe('W10: the gathering list', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('shows every attacker and the time left, to everyone', async () => {
        await stage({ faction: 'theirs', staging: [stagingEntry()] });
        expect(detail()).toMatch(/Forces gathering/);
        expect(detail()).toMatch(/Ours/);
        expect(detail()).toMatch(/2× transport · 5 squads/);
    });

    it('only your own faction gets a Withdraw button', async () => {
        await stage({ faction: 'theirs', staging: [stagingEntry()] });
        expect(document.querySelector('.world-staging-cancel')).toBeNull();
        await stage({ faction: 'ours', staging: [stagingEntry()] });
        expect(document.querySelector('.world-staging-cancel')).not.toBeNull();
    });

    it('withdrawing confirms, posts the row id and clears it from the panel', async () => {
        const { calls } = await stage({ faction: 'ours', staging: [stagingEntry()] });
        click('.world-staging-cancel');
        expect(calls.find(c => c.path === '/api/world/staging/cancel')).toBeUndefined();
        click('[data-act="withdraw-staging-confirm"]');
        await flush();
        expect(calls.find(c => c.path === '/api/world/staging/cancel')!.body)
            .toEqual({ stagingId: 3 });
        expect(detail()).not.toMatch(/Forces gathering/);
    });

    it('ticks the countdown between fetches on the world clock, and freezes it on a pause', async () => {
        let now = 1_000_000;
        const { screen } = await stage({ faction: 'theirs', staging: [stagingEntry()], now: () => now });
        await (screen as any).fetchWorld();
        const eta = () => document.querySelector('.world-staging-eta')!.textContent;
        expect(eta()).toBe('4h');
        // 5 real minutes at 24× = 2 world hours
        now += 5 * 60_000;
        screen.tick();
        expect(eta()).toBe('2h');
        // a pause: the clock is re-read paused, and the countdown holds
        (screen as any).clock = { ...tickWorldClock((screen as any).clock, now), paused: true };
        now += 60 * 60_000;
        screen.tick();
        expect(eta()).toBe('2h');
    });
});

describe('W10: a refresh re-points the selection at the fresh node', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('does not keep painting the world as it was when the player clicked', async () => {
        mountPanel();
        let staging: unknown[] = [];
        const screen = new WorldScreen({
            get: async (path: string) => (path === '/api/world/pois' ? poisBody(staging) : null),
        } as any);
        screen.mount();
        await screen.refresh();
        screen.selectPoi('target');
        expect(detail()).not.toMatch(/Forces gathering/);
        staging = [stagingEntry()];
        await screen.refresh();
        expect(detail()).toMatch(/Forces gathering/);
    });

    it('deselects a POI the world no longer has, and closes its panel', async () => {
        mountPanel();
        let pois = poisBody() as any;
        const screen = new WorldScreen({
            get: async (path: string) => (path === '/api/world/pois' ? pois : null),
        } as any);
        screen.mount();
        await screen.refresh();
        screen.selectPoi('target');
        expect(screen.getPanel()).toBe('poi');
        pois = { ...pois, pois: pois.pois.filter((p: any) => p.id !== 'target') };
        await screen.refresh();
        expect(screen.getPanel()).toBeNull();
        expect((document.getElementById('world-drawer') as HTMLElement).hidden).toBe(true);
    });

    it('a passive refresh does not rebuild the form under a focused field', async () => {
        const { screen } = await stage({ faction: 'ours' });
        const input = document.getElementById('world-commit-transports') as HTMLInputElement;
        input.value = '5';
        input.focus();
        await screen.refresh();
        expect((document.getElementById('world-commit-transports') as HTMLInputElement).value).toBe('5');
        input.blur();
        screen.tick();
        // the deferred render landed once the field was left
        expect((document.getElementById('world-commit-transports') as HTMLInputElement).value).toBe('1');
    });
});
