/**
 * objectives-panel-widget.test.ts — a Metalstorm objective that fails must
 * leave a trace the player can read.
 *
 * Regression for PLAN-endtoend D46 (fire 21). The panel rendered
 * `forTeam(teamId, 'active')` and nothing else, so an objective that reached
 * `state=failed` simply left the filter and the row disappeared — measured
 * live on `objective_8` (escort, team 0, reward 100, failed at progress 0.47),
 * with no notification, no toast and nothing in the player's log. A player
 * could lose a 100-authority reward with nothing on screen ever naming it.
 *
 * Two surfaces are asserted here because they cover different windows: the
 * live list carries the outcome for the server's 30 s retention window
 * (game_objectives.lua RESOLVE_RETENTION_FRAMES, published for exactly this
 * and never read until now), and the panel's own outcome log outlives it.
 *
 * jsdom is not installed in this project (see authority-bar-widget.test.ts),
 * so the DOM the widget touches is faked over the classes its own markup
 * declares.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

interface FakeNode {
    className: string;
    innerHTML: string;
    textContent: string;
    hidden: boolean;
    value: string;
    children: FakeNode[];
    appendChild(n: FakeNode): void;
    addEventListener(type: string, cb: (ev: unknown) => void): void;
    querySelector(sel: string): FakeNode | null;
}

function makeNode(): FakeNode {
    const slots = new Map<string, FakeNode>();
    const node: FakeNode = {
        className: '',
        innerHTML: '',
        textContent: '',
        hidden: false,
        value: '',
        children: [],
        appendChild(n) { this.children.push(n); },
        addEventListener() { /* no listener is exercised here */ },
        querySelector(sel) {
            const cls = sel.replace(/^\./, '');
            if (!slots.has(cls)) slots.set(cls, makeNode());
            return slots.get(cls)!;
        },
    };
    return node;
}

/** The rulesParams an escort objective publishes while it is being run. */
function activeEscort(id: number, team: number): Record<string, unknown> {
    return {
        [`objective_${id}_type`]: 'escort',
        [`objective_${id}_scope`]: 'tactical',
        [`objective_${id}_state`]: 'active',
        [`objective_${id}_team`]: team,
        [`objective_${id}_reward`]: 100,
        [`objective_${id}_progress`]: 0.2,
    };
}

function makeCtx(game: Map<string, unknown>) {
    const mount = makeNode();
    const subscribers: Array<() => void> = [];
    const badges: Array<string | number | null> = [];
    const ctx = {
        mount,
        identity: { playerId: 1, teamId: 0, accountId: 135 },
        setBadge: (t: string | number | null) => { badges.push(t); },
        store: {
            gameRulesParam: (key: string) => game.get(key),
            teamRulesParam: () => undefined,
            subscribe: (_keys: string[], cb: () => void) => {
                subscribers.push(cb);
                return () => { /* unsubscribe */ };
            },
        },
    };
    return {
        ctx,
        badges,
        /** Publish a batch and fire the store subscriptions, as the wire does. */
        publish(params: Record<string, unknown>) {
            for (const [k, v] of Object.entries(params)) game.set(k, v);
            for (const cb of subscribers) cb();
        },
        list: () => mount.children[0]!.querySelector('.ms-obj-list')!.innerHTML,
        outcomeLog: () => mount.children[0]!.querySelector('.ms-obj-outcome-list')!.innerHTML,
        outcomeSection: () => mount.children[0]!.querySelector('.ms-obj-outcomes')!,
    };
}

async function loadWidget() {
    const mod = await import(
        '../../../../data/games/metalstorm/ui/widgets/objectives-panel.js'
    );
    return mod.default as { id: string; init(ctx: unknown): void; dispose?(): void };
}

describe('metalstorm objectives-panel outcomes (D46)', () => {
    const originalDocument = (globalThis as { document?: unknown }).document;

    beforeEach(() => {
        (globalThis as { document?: unknown }).document = { createElement: () => makeNode() };
    });

    afterEach(() => {
        (globalThis as { document?: unknown }).document = originalDocument;
    });

    it('keeps a failed objective in the list, named, with the progress it died at', async () => {
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 8]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish(activeEscort(8, 0));
        expect(h.list()).toContain('escort');

        h.publish({ objective_8_state: 'failed', objective_8_progress: 0.47 });
        const list = h.list();
        expect(list).toContain('escort');       // did NOT vanish
        expect(list).toContain('FAILED');
        expect(list).toContain('failed at 47%');
        expect(list).toContain('100 lost');
    });

    it('logs the outcome so it outlives the 30s retention clear', async () => {
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 8]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish(activeEscort(8, 0));
        expect(h.outcomeSection().hidden).toBe(true);

        h.publish({ objective_8_state: 'failed', objective_8_progress: 0.47 });
        // The server clears every per-id field once retention expires.
        h.publish({
            objective_8_type: null, objective_8_scope: null, objective_8_state: null,
            objective_8_team: null, objective_8_reward: null, objective_8_progress: null,
        });

        expect(h.list()).not.toContain('escort');       // gone from the live list, as designed
        expect(h.outcomeSection().hidden).toBe(false);
        const log = h.outcomeLog();
        expect(log).toContain('escort');
        expect(log).toContain('FAILED');
        expect(log).toContain('100 lost');
    });

    it('marks the collapsed-panel badge while a loss is on the list, and clears it after', async () => {
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 8]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish(activeEscort(8, 0));
        expect(h.badges.at(-1)).toBe(1);

        h.publish({ objective_8_state: 'failed' });
        expect(h.badges.at(-1)).toBe('0 ⚠');

        h.publish({
            objective_8_type: null, objective_8_state: null,
            objective_8_team: null, objective_8_reward: null, objective_8_progress: null,
        });
        expect(h.badges.at(-1)).toBeNull();
    });

    it('never announces an outcome for another team\'s objective', async () => {
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 9]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish(activeEscort(9, 3));            // team 3, we are team 0
        h.publish({ objective_9_state: 'failed' });

        expect(h.list()).not.toContain('escort');
        expect(h.outcomeSection().hidden).toBe(true);
        expect(h.outcomeLog()).toBe('');
    });

    it('tells the loser of an open race that another team took it', async () => {
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 4]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish(activeEscort(4, -1));           // open race: published to both sides
        h.publish({ objective_4_state: 'complete', objective_4_completed_by: 3, objective_4_progress: 1 });

        const list = h.list();
        expect(list).toContain('completed by another team');
        expect(list).toContain('100 lost');
        expect(list).not.toContain('+100');
    });

    it('does not replay history as news for an objective first seen resolved', async () => {
        // Mounting mid-retention-window: the row is shown (the server is still
        // publishing it) but nothing is logged as having just happened to us.
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 8]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish({ ...activeEscort(8, 0), objective_8_state: 'failed' });

        expect(h.list()).toContain('FAILED');
        expect(h.outcomeSection().hidden).toBe(true);
    });
});

describe('metalstorm objectives-panel reward legibility (D49)', () => {
    const originalDocument = (globalThis as { document?: unknown }).document;

    beforeEach(() => {
        (globalThis as { document?: unknown }).document = { createElement: () => makeNode() };
    });

    afterEach(() => {
        (globalThis as { document?: unknown }).document = originalDocument;
    });

    // A reward is normalised by 1/velocity in the sim and then crosses the wire
    // as a float32, so this is the value the panel actually receives — measured
    // live at `114.55000305175781` on the player path.
    const NOISY = 114.55000305175781;

    it('prints an active objective reward to one decimal, not 18 figures', async () => {
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 8]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish({ ...activeEscort(8, 0), objective_8_reward: NOISY });

        const list = h.list();
        expect(list).toContain('⬡ 114.6');
        expect(list).not.toContain('114.55000305175781');
    });

    it('spells the same reward the same way once it resolves', async () => {
        // The outcome row and the live row it replaces used to disagree — the
        // outcome path rounded (`115`) while the active path printed the raw
        // float. Same reward, two spellings, in one panel.
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 8]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish({ ...activeEscort(8, 0), objective_8_reward: NOISY });
        h.publish({ objective_8_state: 'failed', objective_8_progress: 0.47 });

        const list = h.list();
        expect(list).toContain('114.6 lost');
        expect(list).not.toContain('115 lost');
        expect(h.outcomeLog()).toContain('114.6 lost');
    });
});

/**
 * PLAN-endtoend.md D59 — a joint objective was invisible to the team it was
 * widened to. `GG.Objectives.WidenEligibility` (game_parley.lua's accept path)
 * sets `forTeam2` and publishes `objective_<id>_team2`, and the sim enforces
 * it (objectives/control.lua's gate is `forTeam or forTeam2`) — but the client
 * mirror listed neither the field nor the team, so the widened-to team's panel
 * showed nothing at all for an objective it could actually complete.
 *
 * We are team 0 throughout; the objective belongs to team 4 and is widened to
 * us, which is the exact shape a parley accept produces.
 */
describe('metalstorm objectives-panel joint objectives (D59)', () => {
    const originalDocument = (globalThis as { document?: unknown }).document;

    beforeEach(() => {
        (globalThis as { document?: unknown }).document = { createElement: () => makeNode() };
    });

    afterEach(() => {
        (globalThis as { document?: unknown }).document = originalDocument;
    });

    it('shows an objective widened to us, and marks it joint', async () => {
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 5]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish(activeEscort(5, 4));                 // team 4's — not ours
        expect(h.list()).not.toContain('escort');

        h.publish({ objective_5_team2: 0 });           // parley accepted: widened to us
        const list = h.list();
        expect(list).toContain('escort');
        expect(list).toContain('joint');
    });

    it('marks it joint for the original owner too — its objective became a race', async () => {
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 5]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish(activeEscort(5, 0));                 // ours
        expect(h.list()).not.toContain('joint');

        h.publish({ objective_5_team2: 4 });
        expect(h.list()).toContain('joint');
    });

    it('hides it again if the widening is withdrawn', async () => {
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 5]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish({ ...activeEscort(5, 4), objective_5_team2: 0 });
        expect(h.list()).toContain('escort');

        h.publish({ objective_5_team2: null });
        expect(h.list()).not.toContain('escort');
    });

    it('announces the partner completing it, and names it as the joint partner', async () => {
        // The award goes to whoever finishes (game_objectives.lua awards
        // completingTeam; the parley's terms.split is published but not
        // enforced), so this is a real loss to us — but not to a stranger.
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 5]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish({ ...activeEscort(5, 4), objective_5_team2: 0 });
        h.publish({ objective_5_state: 'complete', objective_5_completed_by: 4, objective_5_progress: 1 });

        const list = h.list();
        expect(list).toContain('completed by the joint partner');
        expect(list).toContain('100 lost');
        expect(h.outcomeLog()).toContain('completed by the joint partner');
    });

    it('credits us normally when we are the one who completes it', async () => {
        const widget = await loadWidget();
        const game = new Map<string, unknown>([['objective_count', 5]]);
        const h = makeCtx(game);
        widget.init(h.ctx);

        h.publish({ ...activeEscort(5, 4), objective_5_team2: 0 });
        h.publish({ objective_5_state: 'complete', objective_5_completed_by: 0, objective_5_progress: 1 });

        const list = h.list();
        expect(list).toContain('⬡ +100');
        expect(list).not.toContain('lost');
    });
});
