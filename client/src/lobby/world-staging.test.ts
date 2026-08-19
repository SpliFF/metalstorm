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
 *
 * The DOM half runs under happy-dom, the same way briefing.test.ts does; the
 * parse half needs no DOM at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { parseWorldGraph } from './world-map';
import { WorldScreen, commitErrorText } from './world-screen';

const CLOCK = {
    worldId: 'earth', name: 'Earth', epochRealMs: 0, ratio: 24,
    worldMs: 5_000_000, paused: false,
};

/// `GET /api/world/pois` with one held POI, one contested one, and a
/// world-only one — the three cases the commitment control branches on.
function poisBody(staging: unknown[] = []): unknown {
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

function stagingEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        stagingId: 3, attackerFaction: 'ours', originPoiId: 'home',
        transports: 2, squads: 5,
        remainingWorldMs: 4 * 3600_000, endsAtWorldMs: 5_000_000 + 4 * 3600_000,
        ...over,
    };
}

/// `POST /api/world/me` as W8's panel parses it — the only thing W10 reads off
/// it is which faction this account belongs to.
function meBody(factionId: string | null): unknown {
    return {
        worldId: 'earth',
        rank: factionId === null ? null
            : { factionId, total: 3, holdings: 1, authority: 10, rank: 'commander' },
        capacity: { max: 10, spent: 0 },
        commanders: [],
        authority: 10,
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
        // A lobby built before W10 answers without the key at all, and the
        // panel must render "nothing gathering" rather than crash on it.
        const g = parseWorldGraph({ pois: [{ id: 'x', lat: 0, lon: 0 }] })!;
        expect(g.pois[0].staging).toEqual([]);
    });

    it('drops a malformed entry rather than defaulting its force to zero', () => {
        // A commitment drawn with the wrong force count is a lie about the
        // size of the incoming attack — better one fewer stack than a wrong
        // one.
        const g = parseWorldGraph(poisBody([
            stagingEntry(),
            stagingEntry({ stagingId: 0 }),
            stagingEntry({ attackerFaction: '' }),
            'not an object',
        ]))!;
        expect(g.pois.find(p => p.id === 'target')!.staging.map(s => s.stagingId)).toEqual([3]);
    });

    it('never reports a negative countdown', () => {
        // An overdue window is materialising, i.e. zero left. A negative one
        // would render as a battle that started in the past and never came.
        const g = parseWorldGraph(poisBody([stagingEntry({ remainingWorldMs: -90_000 })]))!;
        expect(g.pois.find(p => p.id === 'target')!.staging[0].remainingWorldMs).toBe(0);
    });

    it('takes the countdown from the SERVER, never from the local clock', () => {
        // The client ticks its own copy of the world clock between fetches
        // (W4). Two clocks disagreeing about "3 hours left" is the confusion
        // this mechanic cannot afford, so `remainingWorldMs` is carried
        // verbatim rather than derived from `endsAtWorldMs` minus local now.
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
    });

    it('degrades to the token for a reason this client has never heard of', () => {
        expect(commitErrorText('some_future_reason')).toBe('some_future_reason');
    });
});

// ─────────────────────────── the panel ───────────────────────────

/// The markup `lobby-ui.ts` renders around the map, cut to what W10 touches.
function mountPanel(): void {
    document.body.innerHTML =
        `<div id="world-panel"><canvas id="world-canvas"></canvas>` +
        `<div id="world-detail"></div><div id="world-player"></div>` +
        `<div id="world-status"></div></div>`;
}

interface Call { path: string; body: unknown }

function makeScreen(opts: {
    faction: string | null,
    staging?: unknown[],
    commitAnswer?: unknown,
    withPost?: boolean,
}): { screen: WorldScreen, calls: Call[] } {
    const calls: Call[] = [];
    let staging = opts.staging ?? [];
    const deps: any = {
        get: async (path: string) => {
            calls.push({ path, body: null });
            if (path === '/api/world') return CLOCK;
            if (path === '/api/world/pois') return poisBody(staging);
            return null;
        },
    };
    if (opts.withPost !== false) {
        deps.post = async (path: string, body: unknown) => {
            calls.push({ path, body });
            if (path === '/api/world/me') return meBody(opts.faction);
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

async function stage(opts: Parameters<typeof makeScreen>[0], poiId = 'target') {
    mountPanel();
    const made = makeScreen(opts);
    await made.screen.refresh();
    await (made.screen as any).refreshStats?.();
    // The stat panel is what carries "which faction am I"; fetch it the same
    // way `open()` does before selecting, so the panel has the fact it
    // branches on.
    if (opts.withPost !== false) {
        const body = await (made.screen as any).deps.post('/api/world/me');
        (made.screen as any).stats = (await import('./world-map')).parseWorldPlayerStats(body);
    }
    made.screen.selectPoi(poiId);
    return made;
}

function detail(): string {
    return document.getElementById('world-detail')!.innerHTML;
}

describe('W10: the commitment control is only offered where the rule allows it', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('offers Commit at a POI held by somebody else', async () => {
        await stage({ faction: 'ours' });
        expect(document.getElementById('world-commit-btn')).not.toBeNull();
    });

    it('offers nothing at a POI your own faction holds', async () => {
        // §7.1: "…to a POI it does not hold". Not a refusal to be explained
        // after the click — there is simply nothing here to instigate.
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
    });
});

describe('W10: committing force', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('posts the POI and the force, and never the faction', async () => {
        // The attacker is read from the session's membership server-side; a
        // body-supplied faction is a way to start a war in someone else's
        // name, exactly as the founding route refuses a body-supplied side.
        const { screen, calls } = await stage({ faction: 'ours' });
        (document.getElementById('world-commit-transports') as HTMLInputElement).value = '3';
        (document.getElementById('world-commit-squads') as HTMLInputElement).value = '7';
        document.getElementById('world-commit-btn')!.dispatchEvent(new Event('click'));
        await new Promise(r => setTimeout(r, 0));
        const post = calls.find(c => c.path === '/api/world/staging/commit')!;
        expect(post.body).toEqual({ poi: 'target', transports: 3, squads: 7 });
        expect(JSON.stringify(post.body)).not.toMatch(/faction/i);
        void screen;
    });

    it('re-reads the map, so the countdown shown is the one the server priced', async () => {
        const { calls } = await stage({ faction: 'ours' });
        document.getElementById('world-commit-btn')!.dispatchEvent(new Event('click'));
        await new Promise(r => setTimeout(r, 0));
        expect(calls.filter(c => c.path === '/api/world/pois').length).toBeGreaterThan(1);
        // …and the panel is now showing the row the re-read returned, not the
        // one it held before the click.
        expect(detail()).toMatch(/Forces gathering/);
        expect(detail()).toMatch(/2× transport/);
    });

    it('nonsense in the force fields becomes the minimum the rule names', async () => {
        const { calls } = await stage({ faction: 'ours' });
        (document.getElementById('world-commit-transports') as HTMLInputElement).value = '-4';
        (document.getElementById('world-commit-squads') as HTMLInputElement).value = 'x';
        document.getElementById('world-commit-btn')!.dispatchEvent(new Event('click'));
        await new Promise(r => setTimeout(r, 0));
        expect(calls.find(c => c.path === '/api/world/staging/commit')!.body)
            .toEqual({ poi: 'target', transports: 1, squads: 1 });
    });

    it('shows a refusal as the rule, and keeps showing it', async () => {
        await stage({ faction: 'ours', commitAnswer: { ok: false, error: 'no_transport' } });
        document.getElementById('world-commit-btn')!.dispatchEvent(new Event('click'));
        await new Promise(r => setTimeout(r, 0));
        expect(detail()).toMatch(/at least one transport/i);
    });

    it('a discarded refusal still says something, never "done"', async () => {
        // `lobbyPost` answers null on a non-200 rather than throwing, so the
        // reason is already gone by the time we see it.
        await stage({ faction: 'ours', commitAnswer: null });
        document.getElementById('world-commit-btn')!.dispatchEvent(new Event('click'));
        await new Promise(r => setTimeout(r, 0));
        expect(detail()).toMatch(/could not accept/i);
    });
});

describe('W10: the gathering list', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('shows every attacker and the time left, to everyone', async () => {
        // Public by design: the warning IS the mechanic, so the countdown is
        // not the attacker's private information.
        await stage({ faction: 'theirs', staging: [stagingEntry()] });
        expect(detail()).toMatch(/Forces gathering/);
        expect(detail()).toMatch(/Ours/);
        expect(detail()).toMatch(/2× transport · 5 squad/);
    });

    it('only your own faction gets a Withdraw button', async () => {
        await stage({ faction: 'theirs', staging: [stagingEntry()] });
        expect(document.querySelector('.world-staging-cancel')).toBeNull();
        await stage({ faction: 'ours', staging: [stagingEntry()] });
        expect(document.querySelector('.world-staging-cancel')).not.toBeNull();
    });

    it('withdrawing posts the row id and clears it from the panel', async () => {
        const { calls } = await stage({ faction: 'ours', staging: [stagingEntry()] });
        (document.querySelector('.world-staging-cancel') as HTMLElement).dispatchEvent(new Event('click'));
        await new Promise(r => setTimeout(r, 0));
        expect(calls.find(c => c.path === '/api/world/staging/cancel')!.body)
            .toEqual({ stagingId: 3 });
        expect(detail()).not.toMatch(/Forces gathering/);
    });
});

describe('W10: a refresh re-points the selection at the fresh node', () => {
    beforeEach(() => { document.body.innerHTML = ''; });

    it('does not keep painting the world as it was when the player clicked', async () => {
        // Before W10 a POI's fields never changed under a selection, so
        // holding the pre-fetch object was invisible. A live countdown makes
        // it a stale-data defect.
        mountPanel();
        let staging: unknown[] = [];
        const screen = new WorldScreen({
            get: async (path: string) => (path === '/api/world/pois' ? poisBody(staging) : null),
        } as any);
        await screen.refresh();
        screen.selectPoi('target');
        expect(detail()).not.toMatch(/Forces gathering/);
        staging = [stagingEntry()];
        await screen.refresh();
        expect(detail()).toMatch(/Forces gathering/);
    });

    it('deselects a POI the world no longer has', async () => {
        mountPanel();
        let pois = poisBody() as any;
        const screen = new WorldScreen({
            get: async (path: string) => (path === '/api/world/pois' ? pois : null),
        } as any);
        await screen.refresh();
        screen.selectPoi('target');
        pois = { ...pois, pois: pois.pois.filter((p: any) => p.id !== 'target') };
        await screen.refresh();
        expect(detail()).toMatch(/Select a point of interest/);
    });
});
