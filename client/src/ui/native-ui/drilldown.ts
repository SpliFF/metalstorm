/**
 * drilldown.ts — the container primitive every drill-down surface is built from
 * (DESIGN-DRILLDOWN.md §4, the U0 framework)
 *
 * ONE widget shape, three rungs of the ladder:
 *
 *     rung 1  a summary chip     — a name, a state word, at most three numbers
 *     rung 2  a context panel    — the detail, one click down
 *     rung 3  an action row      — what you can DO about it, in that panel
 *
 * Nothing about a particular kind of thing lives here. A caller supplies a
 * `FocusRef`, a `summary()` that returns key numbers, a `detail()` that fills a
 * host element, and optionally `actions()`. Squads, objectives, towns and enemy
 * contacts are all the same widget with different callbacks — which is the
 * point: U1/U2/U3 add kinds, not mechanisms, and the HUD cannot drift into
 * five differently-behaved expanding things.
 *
 * ── The rules this file ENFORCES rather than documents ──
 *
 *  1. **A summary may show at most `SUMMARY_MAX_STATS` numbers.** Passing more
 *     truncates and warns. The directive's whole complaint is a UI that shows
 *     everything at once; a cap written only in prose is a cap that erodes one
 *     well-meaning field at a time.
 *  2. **At most one context panel is open.** Expanding drives
 *     `FocusModel.drill`, which replaces whatever was drilled, and every
 *     drilldown watches the model and closes itself when it stops being the
 *     drilled one. Two open panels is a dashboard, and a dashboard is the
 *     spreadsheet.
 *  3. **Esc closes, and closes only this.** The consumed Escape is stopped in
 *     the capture phase so it never also reaches main.ts's global handler and
 *     opens the quit dialog behind the panel the player just closed.
 *  4. **The detail is rebuilt on open, not kept warm.** A collapsed drilldown
 *     holds no live detail DOM and no subscriptions of its own, so a HUD full
 *     of collapsed chips costs a HUD full of chips.
 */

import { focusModel, focusRefKey, type FocusModel, type FocusRef } from './focus-model.js';
import { canTravelTo, createGoThereButton, type TravelTarget } from './camera-travel.js';

/** Rung 1's budget. Three is what fits on one line at HUD type size next to a
 *  name, and it is also about as many numbers as a player reads without
 *  stopping to parse. A fourth belongs one click down. */
export const SUMMARY_MAX_STATS = 3;

export type StatTone = 'good' | 'bad' | 'accent' | 'gold';

/** One key number. `label` is a word, not a sentence: the chip has no room for
 *  a sentence and a number that needs one is a rung-2 number. */
export interface DrilldownStat {
    label: string;
    value: string;
    tone?: StatTone;
}

export interface DrilldownSummary {
    /** The thing's name. */
    title: string;
    /** One state word ("idle", "moving", "contested"). Optional. */
    state?: string;
    stats?: DrilldownStat[];
}

export interface DrilldownAction {
    id: string;
    label: string;
    /** Shown as the button's tooltip — and, when `disabled`, it MUST say why.
     *  A greyed button with no explanation is the same dead end as a button
     *  that silently does nothing. */
    hint?: string;
    disabled?: boolean;
    tone?: 'primary' | 'danger';
    run(): void;
}

export interface DrilldownSpec {
    /** What this drilldown is about. Its key is the model's identity for it. */
    ref: FocusRef;
    /** Rung 1. Called on every `refresh()`, so it must be cheap and pure. */
    summary(): DrilldownSummary;
    /** Rung 2. Fills `host` with the detail view. Called on expand and on
     *  every `refresh()` while expanded; must clear up after itself or be
     *  idempotent — the primitive empties `host` before each call. */
    detail(host: HTMLElement): void;
    /** Rung 3. Absent ⇒ no action row. */
    actions?(): DrilldownAction[];
    /** Where "go there" goes. Defaults to `ref` itself; pass `null` to suppress
     *  the affordance for something that genuinely has no place on the map. */
    travel?: TravelTarget | null;
    /** Defaults to the session focus model. Injectable for tests. */
    model?: FocusModel;
}

export interface DrilldownHandle {
    /** The root element. Caller appends it wherever it belongs. */
    readonly el: HTMLElement;
    expand(): void;
    collapse(): void;
    toggle(): void;
    isExpanded(): boolean;
    /** Re-read `summary()` (and `detail()`/`actions()` while open). */
    refresh(): void;
    dispose(): void;
}

let warnedStatCap = false;

export function createDrilldown(spec: DrilldownSpec): DrilldownHandle {
    const model = spec.model ?? focusModel;
    const key = focusRefKey(spec.ref);

    const root = document.createElement('div');
    root.className = 'nui-dd';
    root.dataset.focusKey = key;

    // ── rung 1: the chip ────────────────────────────────────────────────
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'nui-dd__chip';
    chip.setAttribute('aria-expanded', 'false');

    const chipTitle = document.createElement('span');
    chipTitle.className = 'nui-dd__title';
    const chipState = document.createElement('span');
    chipState.className = 'nui-dd__state';
    const chipStats = document.createElement('span');
    chipStats.className = 'nui-dd__stats';
    const caret = document.createElement('span');
    caret.className = 'nui-dd__caret';
    caret.textContent = '▸';
    caret.setAttribute('aria-hidden', 'true');

    chip.append(chipTitle, chipState, chipStats, caret);

    // "Go there" sits OUTSIDE the chip button, not inside it: nesting a button
    // in a button is invalid HTML and the inner one is unreachable by keyboard.
    const chipRow = document.createElement('div');
    chipRow.className = 'nui-dd__row';
    chipRow.append(chip);

    const travelTarget = spec.travel === undefined ? spec.ref : spec.travel;
    if (travelTarget && canTravelTo(travelTarget)) {
        chipRow.append(createGoThereButton(travelTarget));
    }

    // ── rung 2/3: the panel (built on expand, torn down on collapse) ─────
    const panel = document.createElement('div');
    panel.className = 'nui-dd__panel';
    panel.hidden = true;
    const body = document.createElement('div');
    body.className = 'nui-dd__body';
    const actionRow = document.createElement('div');
    actionRow.className = 'nui-dd__actions';
    panel.append(body, actionRow);

    root.append(chipRow, panel);

    let expanded = false;
    let disposed = false;

    const renderSummary = (): void => {
        const summary = spec.summary();
        chipTitle.textContent = summary.title;

        chipState.textContent = summary.state ?? '';
        chipState.hidden = !summary.state;

        let stats = summary.stats ?? [];
        if (stats.length > SUMMARY_MAX_STATS) {
            if (!warnedStatCap) {
                warnedStatCap = true;
                console.warn(
                    `[drilldown] "${summary.title}" offered ${stats.length} summary stats; ` +
                    `rung 1 shows at most ${SUMMARY_MAX_STATS} (DESIGN-DRILLDOWN.md §4). ` +
                    'The rest belong in detail().',
                );
            }
            stats = stats.slice(0, SUMMARY_MAX_STATS);
        }

        chipStats.replaceChildren();
        for (const stat of stats) {
            const el = document.createElement('span');
            el.className = 'nui-dd__stat';
            const label = document.createElement('span');
            label.className = 'nui-dd__stat-label';
            label.textContent = stat.label;
            const value = document.createElement('span');
            value.className = 'nui-dd__stat-value';
            if (stat.tone) value.classList.add(`nui-dd__stat-value--${stat.tone}`);
            value.textContent = stat.value;
            el.append(label, value);
            chipStats.append(el);
        }
    };

    const renderDetail = (): void => {
        body.replaceChildren();
        spec.detail(body);

        actionRow.replaceChildren();
        const actions = spec.actions?.() ?? [];
        for (const action of actions) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'nui-btn nui-btn--sm';
            if (action.tone) btn.classList.add(`nui-btn--${action.tone}`);
            btn.dataset.actionId = action.id;
            btn.textContent = action.label;
            if (action.hint) btn.title = action.hint;
            btn.disabled = action.disabled === true;
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                action.run();
            });
            actionRow.append(btn);
        }
        actionRow.hidden = actions.length === 0;
    };

    const setExpanded = (next: boolean): void => {
        if (disposed || expanded === next) return;
        expanded = next;
        chip.setAttribute('aria-expanded', String(next));
        caret.textContent = next ? '▾' : '▸';
        root.classList.toggle('is-open', next);
        panel.hidden = !next;
        if (next) renderDetail();
        else body.replaceChildren();       // drop the detail DOM while closed
    };

    const expand = (): void => {
        if (disposed) return;
        // Drive the model FIRST: it is what closes any other open panel, and
        // its notification is what makes this one's own state authoritative.
        model.drill(spec.ref);
        setExpanded(true);
    };

    const collapse = (): void => {
        if (disposed) return;
        if (model.isDrilled(spec.ref)) model.collapse();
        setExpanded(false);
    };

    chip.addEventListener('click', () => { expanded ? collapse() : expand(); });

    // Esc, consumed in the capture phase — see rule 3 in the file header.
    const onKeyDown = (e: KeyboardEvent): void => {
        if (e.key !== 'Escape' || !expanded) return;
        e.preventDefault();
        e.stopPropagation();
        collapse();
    };
    document.addEventListener('keydown', onKeyDown, true);

    // The model is the arbiter of which panel is open. A drilldown that
    // expanded and then lost the drill (another chip was clicked, or the
    // selection changed under it) closes itself here rather than each caller
    // having to remember to.
    const unsubscribe = model.subscribe((state) => {
        const stillOurs = state.drilled !== null && focusRefKey(state.drilled) === key;
        if (expanded && !stillOurs) setExpanded(false);
    });

    renderSummary();

    return {
        el: root,
        expand,
        collapse,
        toggle: () => { expanded ? collapse() : expand(); },
        isExpanded: () => expanded,
        refresh: () => {
            if (disposed) return;
            renderSummary();
            if (expanded) renderDetail();
        },
        dispose: () => {
            if (disposed) return;
            disposed = true;
            document.removeEventListener('keydown', onKeyDown, true);
            unsubscribe();
            if (model.isDrilled(spec.ref)) model.collapse();
            root.remove();
        },
    };
}

// ───────────────────────────── detail helpers ───────────────────────────
//
// Rung 2 is a handful of labelled facts and a handful of references. These two
// builders are what keep every context panel looking the same without each
// caller re-inventing a definition list.

/** A labelled fact: "Roster — 6 of 6". */
export function detailRow(label: string, value: string): HTMLElement {
    const row = document.createElement('div');
    row.className = 'nui-dd__fact';
    const l = document.createElement('span');
    l.className = 'nui-dd__fact-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'nui-dd__fact-value';
    v.textContent = value;
    row.append(l, v);
    return row;
}

/**
 * A reference to somewhere, with its own travel affordance.
 *
 * This is the row that makes "one more click gets them there" literal: any
 * place a context panel MENTIONS becomes a place the player can go, without
 * the caller wiring a camera anywhere.
 */
export function detailReference(
    label: string,
    target: TravelTarget,
    opts: { note?: string } = {},
): HTMLElement {
    const row = document.createElement('div');
    row.className = 'nui-dd__ref';
    const l = document.createElement('span');
    l.className = 'nui-dd__fact-label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'nui-dd__fact-value';
    v.textContent = opts.note ?? '';
    row.append(l, v, createGoThereButton(target));
    return row;
}
