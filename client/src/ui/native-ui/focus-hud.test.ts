// @vitest-environment happy-dom
/**
 * focus-hud.test.ts — the story-1 vertical slice (DESIGN-DRILLDOWN.md §6)
 *
 * Three groups of assertion, and the split is deliberate:
 *
 *  1. **the loader contract + manifest wiring** — a `builtin: true` entry with
 *     no BUILTIN_WIDGETS registration mounts nothing and only logs, and a
 *     manifest entry that grew a `title` would get panel chrome and stop being
 *     a summary affordance. Both are silent failures, so both are pinned;
 *  2. **the summary rules** — what rung 1 is allowed to say, derived from a
 *     census snapshot;
 *  3. **the mounted widget** — that it renders nothing while nothing is
 *     selected, and a chip when something is.
 *
 * What is NOT here: whether any of it LOOKS right. DOM assertions are blind to
 * CSS; the live screenshots in the step report are the evidence for that.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import focusHud, { summaryFor, factsFor, nearestPlace, MAX_SUMMARIES } from './focus-hud.js';
import { focusModel, resolveSelectionSubjects, type FocusRef } from './focus-model.js';
import { cameraPortHolder } from './camera-port.js';
import { censusCacheHolder, CensusCache, type Census } from './query-engine.js';
import type { NamedEntity } from './named-entity-index.js';
import type { WidgetContext } from './widget-loader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(
    HERE, '..', '..', '..', '..',
    'data', 'games', 'metalstorm', 'ui', 'metalstorm.ui.json',
);

const squad: FocusRef = {
    kind: 'squad', id: 7, label: '3rd Tanks', unitIds: [10, 11, 12],
    data: { partial: false, selectedCount: 3, rosterCount: 3, tasked: false },
};

function census(units: Partial<Census['units'][number]>[]): Census {
    return {
        frame: 100, myTeam: 0,
        units: units.map((u, i) => ({
            unitId: 10 + i, team: 0, side: 'own' as const, x: 0, z: 0, ...u,
        })),
    };
}

// ─────────────────────── 1. loader + manifest wiring ────────────────────

describe('loader contract', () => {
    it('exports the widget interface the loader requires', () => {
        expect(focusHud.id).toBe('focus-hud');
        expect(typeof focusHud.init).toBe('function');
        expect(typeof focusHud.dispose).toBe('function');
    });

    it('is registered in BUILTIN_WIDGETS under its manifest id', () => {
        // A `builtin: true` entry with no registry entry mounts nothing and
        // only logs — the two lists must agree.
        const source = readFileSync(join(HERE, 'widget-loader.ts'), 'utf8');
        expect(source).toContain("'focus-hud':");
    });

    it('is declared in the Metalstorm manifest as a CHROME-LESS built-in', () => {
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
        const entry = manifest.widgets.find((w: { id: string }) => w.id === 'focus-hud');
        expect(entry).toBeDefined();
        expect(entry.builtin).toBe(true);
        expect(entry.mount).toBe('top-center');
        // No `title`: the loader only builds the collapsible panel frame for
        // titled widgets, and a summary affordance wrapped in panel chrome is
        // a panel that lives there — the exact thing the directive rejects.
        expect(entry.title).toBeUndefined();
    });

    it('is NOT hidden for spectators', () => {
        // Rungs 1 and 2 are reading, not ordering. A spectator who cannot see
        // what is selected cannot follow the battle, and `ctx.sendCommand` is
        // already gated for them at the one choke-point in integration.ts.
        const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
        const entry = manifest.widgets.find((w: { id: string }) => w.id === 'focus-hud');
        expect(entry.hideForSpectator).toBeUndefined();
    });
});

// ──────────────────────────── 2. summary rules ──────────────────────────

describe('facts from the census', () => {
    it('averages strength, keeps the weakest, and centroids the position', () => {
        const facts = factsFor(squad, census([
            { health: 1.0, x: 0, z: 0 },
            { health: 0.5, x: 100, z: 200 },
            { health: 0.75, x: 200, z: 400 },
        ]));
        expect(facts.seen).toBe(3);
        expect(facts.strength).toBeCloseTo(0.75, 5);
        expect(facts.weakest).toBe(0.5);
        expect(facts.centroid).toEqual({ x: 100, z: 200 });
    });

    it('any member under way means the force is moving', () => {
        // A column whose rear has stopped is still moving; "idle" would be a lie.
        const facts = factsFor(squad, census([{ moving: false }, { moving: true }, {}]));
        expect(facts.moving).toBe(true);
    });

    it('takes the majority class', () => {
        const facts = factsFor(squad, census([
            { className: 'tanks' }, { className: 'tanks' }, { className: 'artillery' },
        ]));
        expect(facts.className).toBe('tanks');
    });

    it('ignores units that are not in the ref', () => {
        const other = census([{ health: 0 }, { health: 0 }, { health: 0 }]);
        expect(factsFor({ ...squad, unitIds: [10] }, other).seen).toBe(1);
    });

    it('a missing snapshot is not zero strength', () => {
        // "I can't see your units" and "your units are dead" must never render
        // the same — the same rule query-engine.ts holds for the census.
        expect(factsFor(squad, null).strength).toBeNull();
        expect(factsFor(squad, census([{}, {}, {}])).strength).toBeNull();
    });

    it('separates "not looked yet" from "looked, not there"', () => {
        expect(factsFor(squad, null).mirrored).toBe(false);
        const gone = factsFor(squad, census([{ unitId: 999 } as never]));
        expect(gone.mirrored).toBe(true);
        expect(gone.seen).toBe(0);
    });
});

describe('summaryFor — what rung 1 may say', () => {
    it('shows the name, a state word and TWO numbers', () => {
        const summary = summaryFor(squad, factsFor(squad, census([
            { health: 0.9 }, { health: 0.9 }, { health: 0.9 },
        ])));
        expect(summary.title).toBe('3rd Tanks');
        expect(summary.state).toBe('idle');
        expect(summary.stats?.map((s) => `${s.label} ${s.value}`)).toEqual(['Units 3', 'Str 90%']);
    });

    it('a partial selection reads "2/3", not "2"', () => {
        const partial: FocusRef = {
            ...squad, unitIds: [10, 11],
            data: { partial: true, selectedCount: 2, rosterCount: 3, tasked: false },
        };
        expect(summaryFor(partial).stats?.[0].value).toBe('2/3');
    });

    it('drops the strength stat entirely when it is unknown', () => {
        // Rather than printing "Str —", which reads as a number the player is
        // supposed to act on.
        expect(summaryFor(squad, factsFor(squad, null)).stats).toHaveLength(1);
    });

    it('tones the strength number at the ends of the scale', () => {
        const at = (h: number) => summaryFor(squad, factsFor(squad, census([{ health: h }])));
        expect(at(0.95).stats?.[1].tone).toBe('good');
        expect(at(0.2).stats?.[1].tone).toBe('bad');
        expect(at(0.6).stats?.[1].tone).toBeUndefined();
    });

    it('a force the mirror cannot see reads "out of contact", never "idle"', () => {
        // Found live: four tank squads were destroyed at Raven Basin with their
        // context panel open, and the chip went on saying IDLE for a force that
        // no longer existed.
        const gone = census([]);
        expect(summaryFor(squad, factsFor(squad, gone)).state).toBe('out of contact');
        // ...but before the first snapshot arrives we have not looked, and
        // saying we lost them would be the same lie in the other direction.
        expect(summaryFor(squad, factsFor(squad, null)).state).toBe('idle');
    });

    it('moving beats tasked beats idle', () => {
        const tasked: FocusRef = { ...squad, data: { ...squad.data, tasked: true } };
        expect(summaryFor(tasked, factsFor(tasked, census([{ moving: true }]))).state).toBe('moving');
        expect(summaryFor(tasked, factsFor(tasked, census([{}]))).state).toBe('tasked');
        expect(summaryFor(squad, factsFor(squad, census([{}]))).state).toBe('idle');
    });
});

describe('nearestPlace', () => {
    const entity = (over: Partial<NamedEntity>): NamedEntity =>
        ({ id: 'r', type: 'region', name: 'R', x: 0, z: 0, ...over });

    it('picks the closest place by straight-line distance', () => {
        const near = nearestPlace({ x: 100, z: 100 }, [
            entity({ id: 'a', name: 'Far', x: 5000, z: 5000 }),
            entity({ id: 'b', name: 'Raven Basin', x: 150, z: 120 }),
        ]);
        expect(near?.name).toBe('Raven Basin');
    });

    it('skips entities parked at the origin', () => {
        // Org groups land in the index with x/z 0 (gp:orgGroups carries no
        // centroid) — a "nearest place" that is always the map corner is worse
        // than no answer.
        const near = nearestPlace({ x: 100, z: 100 }, [
            entity({ id: 'g', type: 'group', name: 'Ghost', x: 0, z: 0 }),
            entity({ id: 'b', name: 'Raven Basin', x: 900, z: 900 }),
        ]);
        expect(near?.name).toBe('Raven Basin');
    });

    it('answers null rather than guessing when the index has no places', () => {
        expect(nearestPlace({ x: 0, z: 0 }, [])).toBeNull();
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
        sendCommand: (cmd) => sent.push(cmd),
    });

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.replaceChildren();
        mount = document.createElement('div');
        document.body.append(mount);
        sent = [];
        focusModel.clear();
        cameraPortHolder.install({ call: () => {}, pose: () => null });
        censusCacheHolder.install(new CensusCache(async () => census([
            { health: 0.8, x: 900, z: 1200, className: 'tanks' },
            { health: 0.8, x: 900, z: 1200 },
            { health: 0.8, x: 900, z: 1200 },
        ])));
    });

    afterEach(() => {
        focusHud.dispose();
        focusModel.clear();
        cameraPortHolder.clear();
        censusCacheHolder.clear();
        vi.useRealTimers();
    });

    it('renders NOTHING while nothing is selected', () => {
        focusHud.init(ctx());
        expect((mount.querySelector('.nui-focus') as HTMLElement).hidden).toBe(true);
        expect(mount.querySelector('.nui-dd')).toBeNull();
    });

    it('shows one chip per selected subject, and takes it away again', () => {
        focusHud.init(ctx());
        focusModel.setSelection([10, 11, 12], [squad]);
        expect(mount.querySelectorAll('.nui-dd')).toHaveLength(1);
        expect(mount.querySelector('.nui-dd__title')?.textContent).toBe('3rd Tanks');

        focusModel.setSelection([], []);
        expect(mount.querySelectorAll('.nui-dd')).toHaveLength(0);
        expect((mount.querySelector('.nui-focus') as HTMLElement).hidden).toBe(true);
    });

    it('caps the chips and says how many it is not showing', () => {
        focusHud.init(ctx());
        const many = Array.from({ length: MAX_SUMMARIES + 2 }, (_, i) => ({
            kind: 'squad' as const, id: i, label: `G${i}`, unitIds: [i],
        }));
        focusModel.setSelection(many.map((m) => m.id), many);
        expect(mount.querySelectorAll('.nui-dd')).toHaveLength(MAX_SUMMARIES);
        expect(mount.querySelector('.nui-focus__overflow')?.textContent).toBe('+2 more selected');
    });

    it('drills into a context panel with detail and actions', () => {
        focusHud.init(ctx());
        focusModel.setSelection([10, 11, 12], [squad]);
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();

        const panel = mount.querySelector('.nui-dd__panel') as HTMLElement;
        expect(panel.hidden).toBe(false);
        expect(panel.textContent).toContain('Roster');
        expect(panel.querySelector('[data-action-id="halt"]')).not.toBeNull();
        expect(panel.querySelector('[data-action-id="follow"]')).not.toBeNull();
    });

    it('Halt issues a real STOP down the widget command bridge', () => {
        focusHud.init(ctx());
        focusModel.setSelection([10, 11, 12], [squad]);
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();
        (mount.querySelector('[data-action-id="halt"]') as HTMLButtonElement).click();
        expect(sent).toEqual([{
            type: 'PlayerCommand', cmdId: 0, unitIds: [10, 11, 12], params: [], options: 0,
        }]);
    });

    it('the detail names the squad position as a travellable reference', async () => {
        focusHud.init(ctx());
        focusModel.setSelection([10, 11, 12], [squad]);
        await censusCacheHolder.current!.refresh();
        (mount.querySelector('.nui-dd__chip') as HTMLButtonElement).click();

        const refs = [...mount.querySelectorAll('.nui-dd__ref')];
        expect(refs.length).toBeGreaterThan(0);
        expect(refs[0].textContent).toContain('900');
        expect((refs[0].querySelector('.nui-go-there') as HTMLButtonElement).disabled).toBe(false);
    });

    it('polls the census only while something is selected', () => {
        const spy = vi.spyOn(censusCacheHolder.current!, 'refresh');
        focusHud.init(ctx());
        vi.advanceTimersByTime(5000);
        expect(spy).not.toHaveBeenCalled();          // nothing selected ⇒ no timer

        focusModel.setSelection([10, 11, 12], [squad]);
        const afterSelect = spy.mock.calls.length;
        expect(afterSelect).toBeGreaterThan(0);      // pulled once immediately
        vi.advanceTimersByTime(3000);
        expect(spy.mock.calls.length).toBeGreaterThan(afterSelect);

        const afterPoll = spy.mock.calls.length;
        focusModel.setSelection([], []);
        vi.advanceTimersByTime(5000);
        expect(spy.mock.calls.length).toBe(afterPoll);   // timer stopped
    });

    it('dispose leaves no timer and no DOM behind', () => {
        focusHud.init(ctx());
        focusModel.setSelection([10, 11, 12], [squad]);
        const spy = vi.spyOn(censusCacheHolder.current!, 'refresh');
        focusHud.dispose();
        vi.advanceTimersByTime(5000);
        expect(spy).not.toHaveBeenCalled();
        expect(mount.querySelector('.nui-focus')).toBeNull();
    });

    it('resolves a real selection end to end, through the focus model', () => {
        // The slice as a player meets it: unit ids in, a named chip out.
        focusHud.init(ctx());
        const groups = [{ groupId: 7, name: '3rd Tanks', memberIds: [10, 11, 12] }];
        const ids = [10, 11];
        focusModel.setSelection(ids, resolveSelectionSubjects(ids, groups));
        expect(mount.querySelector('.nui-dd__title')?.textContent).toBe('3rd Tanks');
        expect(mount.querySelector('.nui-dd__stat-value')?.textContent).toBe('2/3');
    });
});

describe('naming an ungrouped selection', () => {
    it('names it by class and scale, not "4 units"', () => {
        // The showcase scenarios spawn squad units and never create an org
        // group, so this is the common case, not an edge one.
        const loose: FocusRef = { kind: 'unit', id: '10,11', label: '2 units', unitIds: [10, 11] };
        const summary = summaryFor(loose, factsFor(loose, census([
            { className: 'tanks', scale: 3 }, { className: 'tanks', scale: 3 },
        ])));
        expect(summary.title).toBe('2 × heavy tanks');
    });

    it('drops the multiplier for a single unit', () => {
        const one: FocusRef = { kind: 'unit', id: '10', label: 'Unit 10', unitIds: [10] };
        expect(summaryFor(one, factsFor(one, census([{ className: 'tanks', scale: 2 }]))).title)
            .toBe('line tanks');
    });

    it('falls back to the count when the census knows no class', () => {
        const loose: FocusRef = { kind: 'unit', id: '10,11', label: '2 units', unitIds: [10, 11] };
        expect(summaryFor(loose, factsFor(loose, null)).title).toBe('2 units');
    });

    it('never renames a group — a name beats a class phrase', () => {
        const named = summaryFor(squad, factsFor(squad, census([
            { className: 'tanks', scale: 3 }, { className: 'tanks', scale: 3 }, { className: 'tanks' },
        ])));
        expect(named.title).toBe('3rd Tanks');
    });
});
