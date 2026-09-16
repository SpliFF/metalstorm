// @vitest-environment happy-dom
/**
 * moment-hud.test.ts — awareness, end to end on the main thread
 * (battle-clarity U3)
 *
 * Four groups, split the way `objective-hud.test.ts` splits:
 *
 *  1. **the wording** — every kind says WHOSE and WHERE, and an unworded kind
 *     degrades to nothing rather than to "undefined";
 *  2. **the manifest wiring** — the notices are a chrome-less dock widget, the
 *     log is a rung-4 tab, and BOTH RAILS ARE EMPTY (the removal half of this
 *     step, which a purely additive change would silently skip);
 *  3. **the mounted notice layer** — nothing in the DOM until something
 *     happens, a notice per moment, a drill-down with place + travel, and an
 *     edge pointer only for the moments the camera is not looking at;
 *  4. **the rung-4 log** — newest first, rendered from the moment records.
 *
 * DOM assertions are blind to CSS. Appearance and layout are evidenced by the
 * live screenshots in the step report, not here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import momentHud, { eventLog, contextFor, momentRefFor, momentInScope } from './moment-hud.js';
import {
    momentBriefing, momentHeadline, momentState, momentTone, frameClock, placePhrase,
} from './battle-moment-phrasing.js';
import { NOTICE_MS } from './notice-lane.js';
import { focusModel } from './focus-model.js';
import { namedEntityIndex } from './named-entity-index.js';
import { uiStore } from './ui-store.js';
import type { BattleMoment } from '../../core/battle-events.js';
import type { WidgetContext } from './widget-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(
    HERE, '..', '..', '..', '..',
    'data', 'games', 'metalstorm', 'ui', 'metalstorm.ui.json',
);

const moment = (over: Partial<BattleMoment> = {}): BattleMoment => ({
    id: 1, kind: 'under-fire', frame: 900, x: 4400, z: 4400,
    count: 3, unitIds: [11, 12, 13], className: 'tanks', ...over,
});

/** Flush the store's rAF-batched notification. */
function flush(): void {
    vi.advanceTimersByTime(20);
}

// ───────────────────────────── 1. wording ───────────────────────────────

describe('the wording', () => {
    const at = { place: { name: 'Raven Basin', approximate: false } };

    it('names a force by its GROUP name when the roster has one', () => {
        expect(momentHeadline(moment(), { ...at, subject: '3rd Tanks' }))
            .toBe('3rd Tanks under fire at Raven Basin');
    });

    it('falls back to the class, and then to an honest count', () => {
        expect(momentHeadline(moment(), at))
            .toBe('3 tanks under fire at Raven Basin');
        expect(momentHeadline(moment({ className: undefined }), at))
            .toBe('3 units under fire at Raven Basin');
    });

    it('says "squads" when the units are squads', () => {
        expect(momentHeadline(moment({ squads: true, className: undefined, count: 2 }), at))
            .toContain('2 squads');
        // Found live: `ms_class` keys are already PLURAL ("soldiers"), so a
        // naive "<class> squads" produced "4 soldiers squads".
        expect(momentHeadline(
            moment({ kind: 'enemy-reinforcements', squads: true, className: 'soldiers', count: 4 }),
            at,
        )).toBe('Enemy wave at Raven Basin: 4 soldier squads');
        // And "Enemy wave … 4 ENEMY soldier squads" said whose twice.
        expect(momentHeadline(
            moment({ kind: 'kills', squads: true, className: 'soldiers', count: 4 }), at,
        )).toBe('4 enemy soldier squads destroyed at Raven Basin');
    });

    it('never names an enemy force — we do not see their org chart', () => {
        const line = momentHeadline(
            moment({ kind: 'kills', count: 2 }), { ...at, subject: '3rd Tanks' });
        expect(line).not.toContain('3rd Tanks');
        expect(line).toBe('2 enemy tanks destroyed at Raven Basin');
    });

    it('says NEAR when the nearest named place is not the place', () => {
        expect(placePhrase({ place: { name: 'Storm Sound', approximate: true } }))
            .toBe('near Storm Sound');
    });

    it('drops the place rather than inventing one', () => {
        expect(momentHeadline(moment({ kind: 'first-contact' }), {}))
            .toBe('First contact');
    });

    it('degrades an unknown kind to an empty line, never to "undefined"', () => {
        const alien = moment({ kind: 'nothing-we-know' as BattleMoment['kind'] });
        expect(momentHeadline(alien, at)).toBe('');
        expect(momentState(alien.kind)).toBe('');
    });

    it('tones losses badly and kills well', () => {
        expect(momentTone('losses')).toBe('bad');
        expect(momentTone('kills')).toBe('good');
    });

    it('agrees its verb with what it is counting', () => {
        // Caught on screen: "1 tank squad WERE destroyed".
        expect(momentBriefing(moment({ kind: 'losses', count: 1, className: undefined }), at))
            .toContain('1 unit was destroyed');
        expect(momentBriefing(moment({ kind: 'losses', count: 3, className: undefined }), at))
            .toContain('3 units were destroyed');
        // A named force is spoken of in the plural however many units it holds.
        expect(momentBriefing(moment({ kind: 'under-fire', count: 1 }), { ...at, subject: '3rd Tanks' }))
            .toContain('3rd Tanks are taking fire');
    });

    it('says whether the player was looking at it', () => {
        expect(momentBriefing(moment({ offScreen: true }), at)).toContain('off screen');
        expect(momentBriefing(moment(), at)).toContain('in view');
    });

    it('reads the sim clock in minutes and seconds', () => {
        expect(frameClock(0)).toBe('0:00');
        expect(frameClock(30 * 125)).toBe('2:05');
    });
});

// ───────────────────────── 2. manifest wiring ───────────────────────────

describe('manifest wiring', () => {
    const manifest = () => JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

    it('mounts the notices chrome-less, outside the chip stacks', () => {
        const entry = manifest().widgets.find((w: { id: string }) => w.id === 'moment-hud');
        expect(entry.builtin).toBe(true);
        expect(entry.mount).toBe('top-right');
        // No title: a notice is not a panel, and the loader builds panel chrome
        // only for titled widgets.
        expect(entry.title).toBeUndefined();
        expect(entry.subscribes).toContain('gameEvents');
        expect(entry.subscribes).toContain('battleMarkers');
    });

    it('puts the full history behind the ONE access point, not on the HUD', () => {
        const entry = manifest().widgets.find((w: { id: string }) => w.id === 'event-log');
        expect(entry.mount).toBe('menu:events');
    });

    it('EMPTIES BOTH RAILS — the removal half of this step', () => {
        // DESIGN-DRILLDOWN §7's target resting HUD: "Both rails are empty."
        // A panel that comes back to a rail is the resident-panel HUD the
        // directive rejects, and nothing else would catch it.
        //
        // The journey lane (PLAN-beta.md "Mentorship") docks two FIRST-MISSION
        // cards on the left, and they are the named exception rather than a
        // relaxation of the rule: both render nothing at all outside the state
        // they exist for (no mentorship, no tutorial ⇒ no DOM), so the resting
        // HUD of an ordinary mission still has both rails empty.
        const rails = manifest().widgets
            .filter((w: { mount: string }) => w.mount === 'left' || w.mount === 'right')
            .map((w: { id: string }) => w.id);
        expect(rails).toEqual(['mentor-card', 'tutorial-guide']);
    });

    it('folds statistics, diplomacy and reports behind the access point', () => {
        const byId = new Map<string, { mount: string }>(
            manifest().widgets.map((w: { id: string; mount: string }) => [w.id, w]));
        expect(byId.get('scoreboard-panel')!.mount).toBe('menu:statistics');
        expect(byId.get('parley-panel')!.mount).toBe('menu:diplomacy');
        expect(byId.get('ai-command-panel')!.mount).toBe('menu:reports');
        expect(byId.get('briefing-panel')!.mount).toBe('menu:reports');
        expect(byId.get('objective-board')!.mount).toBe('menu:objectives');
    });

    it('registers every built-in it declares', () => {
        const source = readFileSync(join(HERE, 'widget-loader.ts'), 'utf8');
        for (const id of ['moment-hud', 'event-log', 'objective-board', 'briefing-panel']) {
            expect(source, id).toContain(`'${id}':`);
        }
    });
});

// ────────────────────── 3. the mounted notice layer ─────────────────────

describe('the notice layer', () => {
    let mount: HTMLElement;
    let uiRoot: HTMLElement;

    const ctx = (): WidgetContext => ({
        store: uiStore,
        mount,
        identity: { playerId: 0, teamId: 0, accountId: 0 },
    });

    beforeEach(() => {
        vi.useFakeTimers();
        uiStore.clear();
        focusModel.clear();
        namedEntityIndex.clear();
        // `#ui-root` is created by the ui-store module itself on import — the
        // edge-pointer layer parents to THAT one, so a decoy created here
        // would silently never receive a pointer.
        uiRoot = document.getElementById('ui-root')
            ?? Object.assign(document.createElement('div'), { id: 'ui-root' });
        if (!uiRoot.isConnected) document.body.append(uiRoot);
        mount = document.createElement('div');
        document.body.append(mount);
    });

    afterEach(() => {
        momentHud.dispose();
        mount.parentElement?.removeChild(mount);
        uiRoot.replaceChildren();
        uiStore.clear();
        vi.useRealTimers();
    });

    it('has NOTHING in the DOM until something happens', () => {
        momentHud.init(ctx());
        expect(mount.querySelectorAll('.nui-toast')).toHaveLength(0);
        expect(uiRoot.querySelectorAll('.nui-edge')).toHaveLength(0);
    });

    it('raises one notice per moment, as a chip that drills', () => {
        momentHud.init(ctx());
        uiStore.addBattleMoments([moment()]);
        flush();

        const chip = mount.querySelector('.nui-toast--drill .nui-dd__chip') as HTMLElement;
        expect(chip.textContent).toContain('under fire');
        chip.click();
        const panel = mount.querySelector('.nui-dd__panel')!;
        expect(panel.textContent).toContain('Where');
        expect(panel.textContent).toContain('When');
        // "Go there" is present and LIVE — a moment the player cannot be sent
        // to is a moment they cannot act on.
        expect(mount.querySelector('.nui-go-there')).toBeTruthy();
    });

    it('does not re-announce a moment when a later one arrives', () => {
        momentHud.init(ctx());
        uiStore.addBattleMoments([moment({ id: 1 })]);
        flush();
        uiStore.addBattleMoments([moment({ id: 2, kind: 'kills' })]);
        flush();
        const keys = [...mount.querySelectorAll('.nui-toast')]
            .map((n) => (n as HTMLElement).dataset.noticeKey);
        expect(keys).toEqual(['moment:1', 'moment:2']);
    });

    it('lets the notice DECAY — nothing accumulates', () => {
        momentHud.init(ctx());
        uiStore.addBattleMoments([moment()]);
        flush();
        expect(mount.querySelectorAll('.nui-toast')).toHaveLength(1);
        vi.advanceTimersByTime(NOTICE_MS + 1000);
        expect(mount.querySelectorAll('.nui-toast')).toHaveLength(0);
    });

    it('points at a fight the camera is NOT looking at, and only that one', () => {
        momentHud.init(ctx());
        uiStore.addBattleMoments([moment({ id: 1 }), moment({ id: 2, x: 100, z: 100 })]);
        flush();
        uiStore.setBattleMarkers([
            { id: 1, sx: 1.7, sy: 0.4, onScreen: false },
            { id: 2, sx: 0.5, sy: 0.5, onScreen: true },
        ]);
        flush();

        const pointers = [...uiRoot.querySelectorAll('.nui-edge')] as HTMLElement[];
        expect(pointers.map((p) => p.dataset.momentId)).toEqual(['1']);
        // Clamped ONTO the edge: an un-clamped 1.7 would put the glyph off the
        // screen it is meant to point from.
        expect(parseFloat(pointers[0].style.left)).toBeLessThanOrEqual(100);
        expect(pointers[0].title).toContain('under fire');
    });

    it('takes the pointer away once the player looks at it', () => {
        momentHud.init(ctx());
        uiStore.addBattleMoments([moment({ id: 1 })]);
        flush();
        uiStore.setBattleMarkers([{ id: 1, sx: 1.7, sy: 0.4, onScreen: false }]);
        flush();
        expect(uiRoot.querySelectorAll('.nui-edge')).toHaveLength(1);

        uiStore.setBattleMarkers([{ id: 1, sx: 0.5, sy: 0.5, onScreen: true }]);
        flush();
        expect(uiRoot.querySelectorAll('.nui-edge')).toHaveLength(0);
    });

    it('leaves nothing behind on dispose', () => {
        momentHud.init(ctx());
        uiStore.addBattleMoments([moment()]);
        flush();
        uiStore.setBattleMarkers([{ id: 1, sx: 2, sy: 0.4, onScreen: false }]);
        flush();
        momentHud.dispose();
        expect(mount.querySelectorAll('.nui-toast')).toHaveLength(0);
        expect(uiRoot.querySelectorAll('.nui-edge-layer')).toHaveLength(0);
    });
});

// ────────────────────────── 4. the rung-4 log ───────────────────────────

describe('the battle log', () => {
    let mount: HTMLElement;

    const ctx = (): WidgetContext => ({
        store: uiStore,
        mount,
        identity: { playerId: 0, teamId: 0, accountId: 0 },
    });

    beforeEach(() => {
        vi.useFakeTimers();
        uiStore.clear();
        namedEntityIndex.clear();
        mount = document.createElement('div');
        document.body.append(mount);
    });

    afterEach(() => {
        eventLog.dispose();
        mount.parentElement?.removeChild(mount);
        uiStore.clear();
        vi.useRealTimers();
    });

    it('says so plainly when nothing has happened', () => {
        eventLog.init(ctx());
        expect(mount.querySelector('.nui-log__empty')!.textContent)
            .toContain('Nothing has happened');
    });

    it('renders NEWEST FIRST, from the records and not from any prose', () => {
        eventLog.init(ctx());
        uiStore.addBattleMoments([
            moment({ id: 1, kind: 'first-contact', frame: 300 }),
            moment({ id: 2, kind: 'kills', frame: 900, count: 2 }),
        ]);
        flush();
        const rows = [...mount.querySelectorAll('.nui-log__row')] as HTMLElement[];
        expect(rows.map((r) => r.dataset.momentId)).toEqual(['2', '1']);
        expect(rows[0].querySelector('.nui-log__when')!.textContent).toBe('0:30');
        expect(rows[0].querySelector('.nui-go-there')).toBeTruthy();
    });
});

// ─────────────────────────── the ref contract ───────────────────────────

describe('a moment is a place you can go', () => {
    beforeEach(() => { namedEntityIndex.clear(); uiStore.clear(); });

    it('carries a position, which is what makes travel work everywhere', () => {
        const m = moment();
        const ref = momentRefFor(m, contextFor(m));
        expect(ref.position).toEqual({ x: 4400, z: 4400 });
        expect(ref.kind).toBe('area');
        expect(ref.id).toBe('moment:1');
    });
});

/** PLAN-beta.md "Mentorship" — a mentored player's notices are cut to the
 *  squads they are responsible for. */
describe('momentInScope', () => {
    it('keeps everything when nothing is assigned', () => {
        expect(momentInScope(moment({ unitIds: [5] }), new Set())).toBe(true);
    });

    it('keeps a moment about my squads and drops the rest', () => {
        const mine = new Set([11, 12]);
        expect(momentInScope(moment({ unitIds: [12, 30] }), mine)).toBe(true);
        expect(momentInScope(moment({ unitIds: [30] }), mine)).toBe(false);
        expect(momentInScope(moment({ unitIds: [] }), mine)).toBe(false);
    });
});
