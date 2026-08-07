/**
 * authority-bar-widget.test.ts — the shipped Metalstorm authority bar paints
 * once at init, from whatever the store already holds.
 *
 * Regression for PLAN-endtoend D44 (fire 21). The bar used to write its two
 * numbers ONLY from inside `store.subscribe(...)`, and a subscription fires on
 * the next update, never on the current state. Re-entering a war whose
 * broadcast pipeline had stopped — a finished war freezes it — mounted the
 * widget after the last `RulesParamUpdate`, so it sat on its `—` placeholder
 * indefinitely against a store that already held the right values (measured
 * live: store `authority_player_1 = 92` / `authority_pool = 620`, bar `—/—`).
 *
 * jsdom is not installed in this project (see command-composer.test.ts), so the
 * DOM the widget touches during `init` is faked here: createElement, className,
 * innerHTML and querySelector over the three classes its own markup declares.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

interface FakeNode {
    className: string;
    innerHTML: string;
    textContent: string;
    children: FakeNode[];
    appendChild(n: FakeNode): void;
    querySelector(sel: string): FakeNode | null;
}

/** The classes authority-bar's own innerHTML declares, and nothing else. */
const KNOWN_CLASSES = ['ms-auth-player', 'ms-auth-team', 'ms-auth-toasts'];

function makeNode(): FakeNode {
    const slots = new Map<string, FakeNode>();
    const node: FakeNode = {
        className: '',
        innerHTML: '',
        textContent: '',
        children: [],
        appendChild(n) { this.children.push(n); },
        querySelector(sel) {
            const cls = sel.replace(/^\./, '');
            if (!KNOWN_CLASSES.includes(cls)) return null;
            if (!slots.has(cls)) slots.set(cls, makeNode());
            return slots.get(cls)!;
        },
    };
    return node;
}

interface FakeStoreReads { team: Map<string, number>; game: Map<string, number | string> }

function makeCtx(reads: FakeStoreReads, opts: { fireSubscription: boolean }) {
    const mount = makeNode();
    let subscriber: (() => void) | null = null;
    const ctx = {
        mount,
        identity: { playerId: 1, teamId: 0, accountId: 135 },
        store: {
            teamRulesParam: (teamId: number, key: string) =>
                teamId === 0 ? reads.team.get(key) : undefined,
            gameRulesParam: (key: string) => reads.game.get(key),
            subscribe: (_keys: string[], cb: () => void) => {
                subscriber = cb;
                if (opts.fireSubscription) cb();
                return () => { subscriber = null; };
            },
        },
    };
    return { ctx, fire: () => subscriber?.() };
}

async function loadWidget() {
    const mod = await import(
        '../../../../data/games/metalstorm/ui/widgets/authority-bar.js'
    );
    return mod.default as { id: string; init(ctx: unknown): void; dispose?(): void };
}

describe('metalstorm authority-bar widget', () => {
    const originalDocument = (globalThis as { document?: unknown }).document;

    beforeEach(() => {
        (globalThis as { document?: unknown }).document = {
            createElement: () => makeNode(),
        };
    });

    afterEach(() => {
        (globalThis as { document?: unknown }).document = originalDocument;
    });

    it('paints both pools at init, with no store update after mount', async () => {
        const widget = await loadWidget();
        const reads: FakeStoreReads = {
            team: new Map([['authority_pool', 620], ['authority_player_1', 92]]),
            game: new Map(),
        };
        // fireSubscription: false is the whole point — this is a widget mounting
        // into a store that is already populated and will never update again.
        const { ctx } = makeCtx(reads, { fireSubscription: false });

        widget.init(ctx);

        const el = (widget as unknown as { el: FakeNode }).el;
        expect(el.querySelector('.ms-auth-player')!.textContent).toBe('92');
        expect(el.querySelector('.ms-auth-team')!.textContent).toBe('620');
    });

    it('still tracks later updates through the subscription', async () => {
        const widget = await loadWidget();
        const reads: FakeStoreReads = {
            team: new Map([['authority_pool', 500], ['authority_player_1', 100]]),
            game: new Map(),
        };
        const { ctx, fire } = makeCtx(reads, { fireSubscription: false });

        widget.init(ctx);
        reads.team.set('authority_player_1', 98);
        fire();

        const el = (widget as unknown as { el: FakeNode }).el;
        expect(el.querySelector('.ms-auth-player')!.textContent).toBe('98');
    });

    it('falls back to 0, not the placeholder, when the store is empty', async () => {
        const widget = await loadWidget();
        const { ctx } = makeCtx(
            { team: new Map(), game: new Map() },
            { fireSubscription: false },
        );

        widget.init(ctx);

        const el = (widget as unknown as { el: FakeNode }).el;
        expect(el.querySelector('.ms-auth-player')!.textContent).toBe('0');
        expect(el.querySelector('.ms-auth-team')!.textContent).toBe('0');
    });
});
