/**
 * ai-command-panel-widget.test.ts — the shipped Metalstorm AI command panel's
 * intent report, and the veto it sends back.
 *
 * PLAN-ai-synced-write.md task 4. Two properties the earlier panel got wrong:
 *
 *  - the Veto button carried `data-goal` from `intent_<i>_goal`, the human LABEL
 *    ('Assault'), and sent `Number(...)` of it — NaN for every real planner goal
 *    id, which are strings ('def:basin_a', 'obj:12', ai/strategos/slate.lua).
 *    The id now comes from `intent_<i>_goal_id` and goes out as the raw string.
 *  - an entry with no planner goal (a scripted-slate directive) published
 *    `goal_id` as '' — the button was rendered anyway, offering a veto of
 *    nothing. It is now rendered only when the id is present.
 *
 * jsdom is not installed in this project (see command-composer.test.ts), so the
 * DOM the widget touches is faked here, over the classes its own markup
 * declares — same harness shape as authority-bar-widget.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

interface FakeNode {
    className: string;
    innerHTML: string;
    value: string;
    children: FakeNode[];
    listeners: Map<string, ((ev: unknown) => void)[]>;
    appendChild(n: FakeNode): void;
    addEventListener(type: string, cb: (ev: unknown) => void): void;
    querySelector(sel: string): FakeNode | null;
}

/** Every class the panel's own innerHTML/querySelector calls name. */
const KNOWN_CLASSES = [
    'ms-ai-stance', 'ms-ai-roe',
    'ms-ai-paint-region', 'ms-ai-paint-value', 'ms-ai-paint-apply', 'ms-ai-paint-list',
    'ms-ai-lock-group', 'ms-ai-lock-apply', 'ms-ai-lock-clear', 'ms-ai-lock-list',
    'ms-ai-fund-amount', 'ms-ai-fund-ratecap', 'ms-ai-fund-apply',
    'ms-ai-intent-list', 'ms-ai-change-list',
];

function makeNode(): FakeNode {
    const slots = new Map<string, FakeNode>();
    const node: FakeNode = {
        className: '',
        innerHTML: '',
        value: '',
        children: [],
        listeners: new Map(),
        appendChild(n) { this.children.push(n); },
        addEventListener(type, cb) {
            const list = this.listeners.get(type) ?? [];
            list.push(cb);
            this.listeners.set(type, list);
        },
        querySelector(sel) {
            const cls = sel.replace(/^\./, '');
            if (!KNOWN_CLASSES.includes(cls)) return null;
            if (!slots.has(cls)) slots.set(cls, makeNode());
            return slots.get(cls)!;
        },
    };
    return node;
}

type ParamValue = number | string;

function makeCtx(team: Map<string, ParamValue>) {
    const sent: { command: string; payload: Record<string, unknown> }[] = [];
    const ctx = {
        mount: makeNode(),
        identity: { playerId: 1, teamId: 0, accountId: 135 },
        store: {
            teamRulesParam: (teamId: number, key: string) =>
                teamId === 0 ? team.get(key) : undefined,
            gameRulesParam: () => undefined,
            subscribe: () => () => {},
        },
        sendCommand: (command: string, payload: Record<string, unknown>) => {
            sent.push({ command, payload });
        },
    };
    return { ctx, sent };
}

async function loadWidget() {
    const mod = await import(
        '../../../../data/games/metalstorm/ui/widgets/ai-command-panel.js'
    );
    return mod.default as {
        id: string;
        init(ctx: unknown): void;
        el: FakeNode;
        dispose?(): void;
    };
}

/** Fire the panel's delegated click handler as a Veto-button click would. */
function clickVeto(widget: { el: FakeNode }, dataset: { goal?: string } | null) {
    const handlers = widget.el.listeners.get('click') ?? [];
    for (const cb of handlers) {
        cb({ target: { closest: (sel: string) => (sel === '.ms-ai-intent-veto' && dataset ? { dataset } : null) } });
    }
}

/** One charged directive, tagged with a real (string) planner goal id. */
function taggedIntent(): Map<string, ParamValue> {
    return new Map<string, ParamValue>([
        ['guidance_0_intent_count', 1],
        ['guidance_0_intent_0_goal', 'Assault'],
        ['guidance_0_intent_0_group', 12],
        ['guidance_0_intent_0_spend', 114.55000305175781],
        ['guidance_0_intent_0_goal_id', 'def:basin_a'],
    ]);
}

describe('metalstorm ai-command-panel intent report', () => {
    const originalDocument = (globalThis as { document?: unknown }).document;

    beforeEach(() => {
        (globalThis as { document?: unknown }).document = { createElement: () => makeNode() };
    });

    afterEach(() => {
        (globalThis as { document?: unknown }).document = originalDocument;
    });

    it('renders the label from goal and the veto id from goal_id', async () => {
        const widget = await loadWidget();
        const { ctx } = makeCtx(taggedIntent());

        widget.init(ctx);

        const html = widget.el.querySelector('.ms-ai-intent-list')!.innerHTML;
        expect(html).toContain('Assault → 12');
        expect(html).toContain('⬡ 114.6');
        // The id, not the label — 'Assault' as a data-goal was the whole bug.
        expect(html).toContain('data-goal="def:basin_a"');
        expect(html).not.toContain('data-goal="Assault"');
    });

    it('sends the goal id back as a raw string, never Number()d', async () => {
        const widget = await loadWidget();
        const { ctx, sent } = makeCtx(taggedIntent());
        widget.init(ctx);

        clickVeto(widget, { goal: 'def:basin_a' });

        expect(sent).toEqual([{ command: 'guidance.veto', payload: { goalId: 'def:basin_a' } }]);
    });

    it('renders no Veto button for an entry the AI published with no goal id', async () => {
        const widget = await loadWidget();
        // '' is what publishIntent writes for an untagged entry (republish is
        // total, so the slot is cleared rather than omitted).
        const team = taggedIntent();
        team.set('guidance_0_intent_0_goal_id', '');
        const { ctx } = makeCtx(team);

        widget.init(ctx);

        const html = widget.el.querySelector('.ms-ai-intent-list')!.innerHTML;
        expect(html).toContain('Assault → 12');
        expect(html).not.toContain('ms-ai-intent-veto');
    });

    it('renders no Veto button when the goal_id key is absent entirely', async () => {
        const widget = await loadWidget();
        const team = taggedIntent();
        team.delete('guidance_0_intent_0_goal_id');
        const { ctx } = makeCtx(team);

        widget.init(ctx);

        const html = widget.el.querySelector('.ms-ai-intent-list')!.innerHTML;
        expect(html).not.toContain('ms-ai-intent-veto');
    });

    it('keeps a numeric goal id numeric-looking on the wire (the gadget re-coerces)', async () => {
        const widget = await loadWidget();
        const team = taggedIntent();
        team.set('guidance_0_intent_0_goal_id', 42);
        const { ctx, sent } = makeCtx(team);

        widget.init(ctx);
        const html = widget.el.querySelector('.ms-ai-intent-list')!.innerHTML;
        expect(html).toContain('data-goal="42"');

        clickVeto(widget, { goal: '42' });
        expect(sent[0].payload).toEqual({ goalId: '42' });
    });

    // The id is the one value here that has to survive a round trip out of the
    // DOM, and it comes from AI-authored planner data, so a quote in it must not
    // end the attribute (which would silently truncate the id being vetoed).
    it('escapes a quote in the goal id rather than ending the attribute', async () => {
        const widget = await loadWidget();
        const team = taggedIntent();
        team.set('guidance_0_intent_0_goal_id', 'def:a"b');
        const { ctx } = makeCtx(team);

        widget.init(ctx);

        const html = widget.el.querySelector('.ms-ai-intent-list')!.innerHTML;
        expect(html).toContain('data-goal="def:a&quot;b"');
    });

    it('says nothing about engine asks when there is no intent data', async () => {
        const widget = await loadWidget();
        const { ctx } = makeCtx(new Map());

        widget.init(ctx);

        const html = widget.el.querySelector('.ms-ai-intent-list')!.innerHTML;
        expect(html).toContain('No intent data yet');
        expect(html).not.toContain('I1');
    });
});
