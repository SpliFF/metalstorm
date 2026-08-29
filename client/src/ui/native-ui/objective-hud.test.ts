// @vitest-environment happy-dom
/**
 * objective-hud.test.ts — interaction story 2, end to end
 * (DESIGN-DRILLDOWN.md §2/§4/§5; U1)
 *
 * Four groups of assertion, split the same way `focus-hud.test.ts` splits:
 *
 *  1. **the loader contract + manifest wiring** — that the objective board is a
 *     chrome-less top-centre built-in AND that `objectives-panel` really is gone
 *     from the manifest. The demotion is half this step's deliverable, and a
 *     re-added rail entry is a silent regression no other test would catch;
 *  2. **the rung-1 budget** — a name, one state word, ≤3 numbers, and nothing
 *     claimed that the wire did not carry (the countdown is the trap: it must
 *     not appear before the clock is known);
 *  3. **the mounted widget** — nothing in the DOM on an empty board, chips when
 *     there is one, drill-down detail, the overflow line, and the three rung-3
 *     actions with the two unsupported ones disabled AND explained;
 *  4. **announcements decay** — the directive's hard requirement. A state change
 *     must be noticed and must then LEAVE, with nothing accumulating.
 *
 * What is NOT here: whether any of it LOOKS right. DOM assertions are blind to
 * CSS — that is a trap this repo has already paid for — so the live screenshots
 * in the step report are the evidence for appearance and layout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import objectiveHud, {
    ANNOUNCE_MS, REFRESH_MS, objectiveRefFor, summaryFor, type Board,
} from './objective-hud.js';
import { MAX_OBJECTIVE_CHIPS, type ObjectivePlace, type ObjectiveRecord } from './objective-model.js';
import { SUMMARY_MAX_STATS } from './drilldown.js';
import { focusModel } from './focus-model.js';
import { cameraPortHolder } from './camera-port.js';
import { namedEntityIndex } from './named-entity-index.js';
import { uiStore } from './ui-store.js';
import type { WidgetContext } from './widget-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(
    HERE, '..', '..', '..', '..',
    'data', 'games', 'metalstorm', 'ui', 'metalstorm.ui.json',
);

/**
 * Let the store's batched notification land.
 *
 * `UIStore.notifySubscribers` coalesces through `requestAnimationFrame`, so a
 * rulesParams write is NOT synchronous — asserting straight after one reads the
 * previous frame's DOM. Advancing one refresh tick flushes the rAF and runs the
 * widget's own 1 Hz re-read, which is exactly what happens in a battle.
 */
function flush(): void {
    vi.advanceTimersByTime(REFRESH_MS);
}

const place: ObjectivePlace = { name: 'Raven Basin', x: 4400, z: 4400, approximate: false };

const rec = (over: Partial<ObjectiveRecord> = {}): ObjectiveRecord => ({
    id: 1, type: 'control', scope: 'strategic', state: 'active', ...over,
});

/** A board with one objective in it, as the widget assembles one. */
function board(records: ObjectiveRecord[], over: Partial<Board> = {}): Board {
    return {
        byId: new Map(records.map((o) => [o.id, o])),
        placeById: new Map(records.map((o) => [o.id, place])),
        frame: 900, teamId: 0, delegated: new Set(), announcedUntil: new Map(),
        ...over,
    };
}

/** The `objective_<id>_*` slice as `game_objectives.lua` publishes it. */
function publish(...objectives: Record<string, number | string>[]): Record<string, number | string> {
    const params: Record<string, number | string> = { objective_count: objectives.length };
    objectives.forEach((o, i) => {
        for (const [field, value] of Object.entries(o)) {
            params[`objective_${i + 1}_${field}`] = value;
        }
    });
    return params;
}

// ─────────────────────── 1. loader + manifest wiring ────────────────────

describe('loader contract', () => {
    it('exports the widget interface the loader requires', () => {
        expect(objectiveHud.id).toBe('objective-hud');
        expect(typeof objectiveHud.init).toBe('function');
        expect(typeof objectiveHud.dispose).toBe('function');
    });

    it('is registered in BUILTIN_WIDGETS under its manifest id', () => {
        // A `builtin: true` entry with no registry entry mounts nothing and
        // only logs — the two lists must agree.
        const source = readFileSync(join(HERE, 'widget-loader.ts'), 'utf8');
        expect(source).toContain("'objective-hud':");
    });

    it('is declared in the manifest as a CHROME-LESS top-centre built-in', () => {
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
        const entry = manifest.widgets.find((w: { id: string }) => w.id === 'objective-hud');
        expect(entry).toBeDefined();
        expect(entry.builtin).toBe(true);
        expect(entry.mount).toBe('top-center');
        // No `title`: the loader builds the collapsible panel frame only for
        // titled widgets, and a summary affordance wrapped in panel chrome is
        // the resident panel this step exists to remove.
        expect(entry.title).toBeUndefined();
        expect(entry.subscribes).toContain('gameRulesParams');
    });

    it('has RETIRED objectives-panel from the rails', () => {
        // This is the demotion, and it is the half of the step that a purely
        // additive change would silently skip. DESIGN-DRILLDOWN §7 files the
        // panel as "DEMOTE to rung 1 + 2"; if it comes back to a rail, the
        // board is a resident list again and the directive is broken.
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
        const ids = manifest.widgets.map((w: { id: string }) => w.id);
        expect(ids).not.toContain('objectives-panel');
        // Nothing objective-shaped may sit in a rail. `focus-hud` shares the
        // top-centre dock on purpose — both are stacks of rung-1 summary
        // affordances, which is the one thing that dock is for — so the check
        // is that no RAIL widget claims the objectives.
        for (const w of manifest.widgets) {
            // Only titled widgets get panel chrome, so only they can BE a rail
            // panel; the chrome-less built-ins have no title at all.
            if (typeof w.title !== 'string') continue;
            expect(w.title, w.id).not.toMatch(/objective/i);
        }
    });

    it('is NOT hidden for spectators', () => {
        // Rungs 1 and 2 are reading, not ordering; `ctx.sendCommand` is already
        // gated for spectators at integration.ts's one choke-point.
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
        const entry = manifest.widgets.find((w: { id: string }) => w.id === 'objective-hud');
        expect(entry.hideForSpectator).toBeUndefined();
    });
});

// ──────────────────────────── 2. the rung-1 budget ──────────────────────

describe('summaryFor — what rung 1 may say', () => {
    it('never offers more than the enforced stat cap', () => {
        // Progress + Time + Reward is exactly three. A fourth field added here
        // would be silently truncated by drilldown.ts, so it is pinned at the
        // source rather than discovered on screen.
        const s = summaryFor(board([rec({ progress: 0.62, expire: 6000, reward: 300 })]), 1);
        expect(s.stats!.length).toBeLessThanOrEqual(SUMMARY_MAX_STATS);
        expect(s.stats!.length).toBe(3);
    });

    it('titles the chip with the verb-first name, not the type tag', () => {
        expect(summaryFor(board([rec({ type: 'control' })]), 1).title).toBe('Hold Raven Basin');
    });

    it('carries one state word', () => {
        const s = summaryFor(board([rec()]), 1);
        expect(s.state).toBe('active');
        expect(s.state!.split(/\s+/)).toHaveLength(1);
    });

    it('omits the countdown entirely when the sim published no expiry', () => {
        const s = summaryFor(board([rec({ progress: 0.5, reward: 300 })]), 1);
        expect(s.stats!.map((x) => x.label)).not.toContain('Time');
    });

    it('omits the countdown when the clock is not known yet', () => {
        // frame 0 is "the scene feed has not answered". A countdown invented
        // from it is worse than none, because a player will march on it.
        const s = summaryFor(board([rec({ expire: 6000 })], { frame: 0 }), 1);
        expect(s.stats!.map((x) => x.label)).not.toContain('Time');
    });

    it('renders the countdown as a clock, not a frame count', () => {
        const s = summaryFor(board([rec({ expire: 4800 })], { frame: 1800 }), 1);
        const time = s.stats!.find((x) => x.label === 'Time');
        expect(time!.value).toBe('1:40');
    });

    it('tones an urgent countdown as bad', () => {
        const s = summaryFor(board([rec({ expire: 1800 })], { frame: 900 }), 1);
        expect(s.stats!.find((x) => x.label === 'Time')!.tone).toBe('bad');
    });

    it('degrades honestly when the objective left the board mid-render', () => {
        // Retention expiry clears every field for an id; the chip must not
        // render "undefined" for the frame between that and its own removal.
        const s = summaryFor(board([]), 99);
        expect(s.title).toBe('Objective');
        expect(s.state).toBe('gone');
    });
});

describe('objectiveRefFor — the U2 seam', () => {
    it('addresses the objective by a travellable ref with the chip label', () => {
        // U2's world marker supplies the SAME ref, so the marker inherits the
        // label, the travel and the detail view rather than re-deriving them.
        const ref = objectiveRefFor(rec(), place);
        expect(ref.kind).toBe('objective');
        expect(ref.id).toBe(1);
        expect(ref.label).toBe('Hold Raven Basin');
        expect(ref.position).toEqual({ x: 4400, z: 4400 });
    });

    it('carries no position when the objective could not be placed', () => {
        // Which is what greys "Go there" out with a reason instead of
        // travelling somewhere wrong.
        expect(objectiveRefFor(rec(), null).position).toBeUndefined();
    });
});

// ───────────────────────────── 3. the widget ────────────────────────────

describe('the mounted widget', () => {
    let mount: HTMLElement;
    let sent: unknown[];

    const ctx = (): WidgetContext => ({
        store: {} as WidgetContext['store'],
        mount,
        identity: { playerId: 0, teamId: 0, accountId: 0 },
        sendCommand: (cmd, fields) => sent.push([cmd, fields]),
    });

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        mount = document.createElement('div');
        document.body.append(mount);
        sent = [];
        focusModel.clear();
        uiStore.clear();
        cameraPortHolder.install({ call: () => {}, pose: () => null });
        namedEntityIndex.replaceAll([{
            id: 'raven_basin', type: 'region', name: 'Raven Basin',
            x: 4400, z: 4400, aliases: [],
        } as never]);
        uiStore.setGameFrame(900);
    });

    afterEach(() => {
        objectiveHud.dispose();
        focusModel.clear();
        uiStore.clear();
        namedEntityIndex.clear();
        cameraPortHolder.clear();
        vi.useRealTimers();
    });

    it('renders NOTHING while the board is empty', () => {
        objectiveHud.init(ctx());
        flush();
        expect((mount.querySelector('.nui-objectives') as HTMLElement).hidden).toBe(true);
        expect(mount.querySelector('.nui-dd')).toBeNull();
    });

    it('shows a chip per objective, named by what to DO', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'raven_basin', progress: 0.62, reward: 300,
        }));
        flush();
        expect(mount.querySelectorAll('.nui-dd')).toHaveLength(1);
        expect(mount.querySelector('.nui-dd__title')?.textContent).toBe('Hold Raven Basin');
        expect(mount.querySelector('.nui-dd__state')?.textContent).toBe('active');
    });

    it('hides an objective this team is not eligible for', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish(
            { type: 'control', state: 'active', region: 'raven_basin', team: 0 },
            { type: 'kill', state: 'active', region: 'raven_basin', team: 1 },
        ));
        flush();
        expect(mount.querySelectorAll('.nui-dd')).toHaveLength(1);
        expect(mount.querySelector('.nui-dd__title')?.textContent).toBe('Hold Raven Basin');
    });

    it('caps the stack and offers the rest behind one line', () => {
        objectiveHud.init(ctx());
        flush();
        // crossing_standoff alone gives one side five at once; five stacked
        // rows is the wall this framework exists to remove.
        uiStore.updateGameRulesParams(publish(
            ...Array.from({ length: MAX_OBJECTIVE_CHIPS + 2 }, () => ({
                type: 'control', state: 'active', region: 'raven_basin',
            })),
        ));
        flush();
        expect(mount.querySelectorAll('.nui-dd')).toHaveLength(MAX_OBJECTIVE_CHIPS);
        const overflow = mount.querySelector('.nui-objectives__overflow') as HTMLButtonElement;
        expect(overflow.hidden).toBe(false);
        expect(overflow.textContent).toBe('+2 more objectives');

        overflow.click();
        expect(mount.querySelectorAll('.nui-dd')).toHaveLength(MAX_OBJECTIVE_CHIPS + 2);
        expect(overflow.textContent).toBe('Show fewer');
    });

    it('ranks the war-ending objective to the top', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish(
            { type: 'kill', state: 'active', region: 'raven_basin', reward: 900 },
            { type: 'control', state: 'active', region: 'raven_basin', victory: 1, reward: 10 },
        ));
        flush();
        const first = mount.querySelector('.nui-dd') as HTMLElement;
        expect(first.classList.contains('is-victory')).toBe(true);
        expect(first.querySelector('.nui-dd__title')?.textContent).toBe('Hold Raven Basin');
    });

    it('drills into a briefing with place, stakes and clock', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'raven_basin',
            progress: 0.62, reward: 300, expire: 6000,
        }));
        flush();
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();

        const panel = mount.querySelector('.nui-dd__panel') as HTMLElement;
        expect(panel.hidden).toBe(false);
        // The four things the old panel never showed at all.
        expect(panel.textContent).toContain('Raven Basin');       // WHERE
        expect(panel.textContent).toContain('Lapses in');          // WHEN
        expect(panel.textContent).toContain('authority');          // REWARD
        expect(panel.textContent).toContain('Stakes');             // CONSEQUENCE
        // And the briefing prose — the "further information" asked for by name.
        expect(panel.querySelector('.nui-dd__prose')?.textContent)
            .toContain('resets the hold clock');
    });

    it('opens on the same sentence the chip showed', () => {
        // A panel that opens on different words than the chip it came from
        // reads as a different thing.
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'raven_basin', progress: 0.62,
        }));
        flush();
        const title = mount.querySelector('.nui-dd__title')!.textContent!;
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();
        expect(mount.querySelector('.nui-dd__panel')!.textContent).toContain(title);
    });

    it('offers "Go there" on the chip and on the Where row', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'raven_basin',
        }));
        flush();
        const chipTravel = mount.querySelector('.nui-dd__row .nui-go-there') as HTMLButtonElement;
        expect(chipTravel).not.toBeNull();
        expect(chipTravel.disabled).toBe(false);

        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();
        const refs = [...mount.querySelectorAll('.nui-dd__ref')];
        expect(refs.length).toBeGreaterThan(0);
        expect((refs[0].querySelector('.nui-go-there') as HTMLButtonElement).disabled).toBe(false);
    });

    it('says WHY rather than omitting Where when it cannot place the objective', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'nowhere_at_all',
        }));
        flush();
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();
        const panel = mount.querySelector('.nui-dd__panel') as HTMLElement;
        expect(panel.textContent).toContain('not on the map index yet');
        // A silently missing "Where" reads as a UI that forgot.
        expect(panel.textContent).toContain('Where');
    });

    // ── rung 3: respond / refine / cancel ────────────────────────────────

    it('offers all three story-2 actions, with the unsupported two DISABLED', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'raven_basin',
        }));
        flush();
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();
        const panel = mount.querySelector('.nui-dd__panel') as HTMLElement;

        const delegate = panel.querySelector('[data-action-id="delegate"]') as HTMLButtonElement;
        const refine = panel.querySelector('[data-action-id="refine"]') as HTMLButtonElement;
        const standDown = panel.querySelector('[data-action-id="stand-down"]') as HTMLButtonElement;

        // Respond: the one with a wire behind it.
        expect(delegate.disabled).toBe(false);
        // Refine and cancel: no wire verb exists, so they are visible, greyed,
        // and carry the reason. A missing button is a feature the player never
        // learns exists; a live-looking dead one teaches that the UI is broken.
        expect(refine.disabled).toBe(true);
        expect(standDown.disabled).toBe(true);
    });

    it('every disabled action carries a SPECIFIC reason', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'raven_basin',
        }));
        flush();
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();
        for (const btn of mount.querySelectorAll<HTMLButtonElement>('.nui-dd__actions button')) {
            if (!btn.disabled) continue;
            expect(btn.title, btn.dataset.actionId).toBeTruthy();
            // "not implemented" tells a player nothing and the next fire
            // nothing either; the reason names the missing wire verb.
            expect(btn.title, btn.dataset.actionId).toMatch(/wire verb|cannot be declined|resolved/);
        }
    });

    it('Assign to AI issues a real guidance.delegate down the command bridge', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'raven_basin',
        }));
        flush();
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();
        (mount.querySelector('[data-action-id="delegate"]') as HTMLButtonElement).click();
        expect(sent).toEqual([['guidance.delegate', { objectiveId: 1, delegated: '1' }]]);
    });

    it('flips to "Take it back" once the sim reports the delegation', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'raven_basin',
        }));
        flush();
        uiStore.updateTeamRulesParams(0, { guidance_0_delegated_keys: '1' });
        flush();
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();
        const delegate = mount.querySelector('[data-action-id="delegate"]') as HTMLButtonElement;
        expect(delegate.textContent).toBe('Take it back');
        expect(mount.querySelector('.nui-dd__panel')!.textContent).toContain('delegated');
    });

    it('disables delegation on an already-resolved objective', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'complete', region: 'raven_basin', completed_by: 0,
        }));
        flush();
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();
        const delegate = mount.querySelector('[data-action-id="delegate"]') as HTMLButtonElement;
        expect(delegate.disabled).toBe(true);
    });

    // ── lifetime ─────────────────────────────────────────────────────────

    it('ticks the countdown without a store notification', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'raven_basin', expire: 4800,
        }));
        flush();
        const before = mount.querySelector('.nui-dd__stat-value')!.textContent;
        uiStore.setGameFrame(900 + 30 * 30);          // 30 sim seconds later
        vi.advanceTimersByTime(REFRESH_MS);
        expect(mount.querySelector('.nui-dd__stat-value')!.textContent).not.toBe(before);
    });

    it('dispose leaves no timer and no DOM behind', () => {
        objectiveHud.init(ctx());
        flush();
        uiStore.updateGameRulesParams(publish({
            type: 'control', state: 'active', region: 'raven_basin',
        }));
        flush();
        objectiveHud.dispose();
        expect(mount.querySelector('.nui-objectives')).toBeNull();
        // A surviving interval would keep rendering into a detached root.
        expect(() => vi.advanceTimersByTime(5 * REFRESH_MS)).not.toThrow();
        expect(mount.querySelector('.nui-dd')).toBeNull();
    });
});

// --------------------- 4. announcements decay -------------------------

describe('state changes announce themselves and then LEAVE', () => {
    let mount: HTMLElement;

    const ctx = (): WidgetContext => ({
        store: {} as WidgetContext['store'],
        mount,
        identity: { playerId: 0, teamId: 0, accountId: 0 },
        sendCommand: () => {},
    });

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        mount = document.createElement('div');
        document.body.append(mount);
        focusModel.clear();
        uiStore.clear();
        cameraPortHolder.install({ call: () => {}, pose: () => null });
        namedEntityIndex.replaceAll([{
            id: 'raven_basin', type: 'region', name: 'Raven Basin',
            x: 4400, z: 4400, aliases: [],
        } as never]);
        uiStore.setGameFrame(900);
    });

    afterEach(() => {
        objectiveHud.dispose();
        focusModel.clear();
        uiStore.clear();
        namedEntityIndex.clear();
        cameraPortHolder.clear();
        vi.useRealTimers();
    });

    const active = { type: 'control', state: 'active', region: 'raven_basin', reward: 300 };

    /**
     * Mount against a board that is ALREADY populated, which is the real case.
     *
     * The widget mounts once when the battle UI initialises, into a store the
     * rulesParam stream has usually already filled. Mounting against an EMPTY
     * store and then publishing would make the first publish a genuine
     * appearance, so every test below would be measuring its own setup.
     */
    function mountOver(...objectives: Record<string, number | string>[]): void {
        uiStore.updateGameRulesParams(publish(...objectives));
        objectiveHud.init(ctx());
        flush();
    }

    it('does NOT replay the board as toasts on mount', () => {
        // A HUD mounting into an already-populated store would otherwise
        // announce the whole match history at the moment the player joined.
        mountOver(active, active);
        expect(mount.querySelectorAll('.nui-toast')).toHaveLength(0);
        expect(mount.querySelectorAll('.nui-dd')).toHaveLength(2);
    });

    it('toasts an objective that appears, and highlights its chip', () => {
        mountOver(active);
        uiStore.updateGameRulesParams(publish(active, active));
        flush();

        const toasts = [...mount.querySelectorAll('.nui-toast')];
        expect(toasts).toHaveLength(1);
        expect(toasts[0].textContent).toContain('New objective');
        expect(mount.querySelectorAll('.nui-dd.is-announcing')).toHaveLength(1);
    });

    it('toasts a completion with the reward', () => {
        mountOver(active);
        uiStore.updateGameRulesParams(publish({ ...active, state: 'complete', completed_by: 0 }));
        flush();
        const toast = mount.querySelector('.nui-toast')!;
        expect(toast.textContent).toContain('Objective complete');
        expect(toast.textContent).toContain('+300');
        expect(toast.classList.contains('nui-toast--award')).toBe(true);
    });

    it('tells the loser of an open race that it went to the other side', () => {
        // `team -1` published to BOTH sides, so completedBy is the only field
        // that can tell our win from theirs, and the loser must not see an
        // award toast for the objective they just lost.
        mountOver({ ...active, team: -1 });
        uiStore.updateGameRulesParams(publish({
            ...active, team: -1, state: 'complete', completed_by: 1,
        }));
        flush();
        const toast = mount.querySelector('.nui-toast')!;
        expect(toast.textContent).toContain('went to the other side');
        expect(toast.classList.contains('nui-toast--award')).toBe(false);
        expect(toast.classList.contains('nui-toast--refusal')).toBe(true);
    });

    it('toasts a failure and an expiry as losses', () => {
        for (const state of ['failed', 'expired']) {
            objectiveHud.dispose();
            mount.replaceChildren();
            uiStore.clear();
            uiStore.setGameFrame(900);

            mountOver(active);
            uiStore.updateGameRulesParams(publish({ ...active, state }));
            flush();
            const toast = mount.querySelector('.nui-toast');
            expect(toast, state).not.toBeNull();
            expect(toast!.textContent, state).toMatch(/failed|lapsed/);
            expect(toast!.textContent, state).toContain('300');   // what it cost
        }
    });

    it('the toast and the highlight BOTH decay, nothing accumulates', () => {
        // This is the directive hard requirement: the change is noticed, and
        // then the screen returns to its resting state on its own.
        mountOver(active);
        uiStore.updateGameRulesParams(publish(active, active));
        flush();
        expect(mount.querySelectorAll('.nui-toast')).toHaveLength(1);
        expect(mount.querySelectorAll('.nui-dd.is-announcing')).toHaveLength(1);

        vi.advanceTimersByTime(ANNOUNCE_MS + REFRESH_MS + 10);
        expect(mount.querySelectorAll('.nui-toast')).toHaveLength(0);
        expect(mount.querySelectorAll('.nui-dd.is-announcing')).toHaveLength(0);
        // The chips themselves stay: the news left, the board did not.
        expect(mount.querySelectorAll('.nui-dd').length).toBeGreaterThan(0);
    });

    it('does not announce an objective first seen already resolved', () => {
        // Mounting mid-retention-window is history, not news: the sim keeps a
        // resolved objective published for 30 s, and a player who joins inside
        // that window must not be told it just happened.
        mountOver(active, { ...active, state: 'complete', completed_by: 0 });
        expect(mount.querySelectorAll('.nui-toast')).toHaveLength(0);
    });

    it('dispose clears pending toast timers', () => {
        mountOver(active);
        uiStore.updateGameRulesParams(publish(active, active));
        flush();
        objectiveHud.dispose();
        expect(() => vi.advanceTimersByTime(ANNOUNCE_MS * 2)).not.toThrow();
        expect(document.querySelectorAll('.nui-toast')).toHaveLength(0);
    });
});
