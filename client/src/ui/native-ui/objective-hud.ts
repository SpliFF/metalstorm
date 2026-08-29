/**
 * objective-hud.ts — interaction story 2: objectives, drill-down style
 * (DESIGN-DRILLDOWN.md §2/§4/§5; U1)
 *
 *     the board rests as up to three one-line chips at top-centre
 *         →  click one   →  briefing, place, reward, consequence, clock
 *         →  actions     →  Go there · Assign to AI · (Refine / Stand down, greyed with reasons)
 *         →  a state change toasts, highlights its chip, and DECAYS
 *
 * ── What this replaces, and why it is a replacement rather than an addition ──
 *
 * The `objectives-panel` widget is retired from the right rail by the same
 * change that adds this file (see `metalstorm.ui.json`). It was a resident list
 * with a bounty FORM beside the viewport — DESIGN-DRILLDOWN §7's audit calls
 * that out by name — and it rendered the type tag `control` where a player
 * needed "Hold Raven Basin". Its one live action, "Assign to AI", survives here
 * as a rung-3 action on the objective it is about; its bounty form and its
 * five-entry outcome log are rung-4 content and are U3's to re-home. Nothing
 * that worked was deleted without a home; what has no home yet is named in the
 * step report rather than quietly dropped.
 *
 * ── Why chips rest here at all, when rule 1 says nothing rests ──
 *
 * §6's "one permitted leak" is the victory-condition line: it is on screen
 * because it changes what the player does next. The same argument extends
 * exactly as far as the ranking in `objective-model.ts` reaches and no further
 * — the war-ending objective, whatever just changed, whatever is about to
 * lapse, whatever is already underway. `MAX_OBJECTIVE_CHIPS` caps that at
 * three, and the rest sit behind one line the player can click. Five stacked
 * rows (which is what `crossing_standoff` alone would produce) is the wall this
 * framework exists to remove.
 *
 * ── The U2 seam ──
 *
 * "Zoom camera to objective" is not stubbed here: every objective with a
 * resolvable position already carries `createGoThereButton` on its chip row AND
 * on its Location row, riding U0's `camera-travel.ts`. U2's job is to put the
 * SAME `FocusRef` on a world marker so clicking the map drills the same panel —
 * `objectiveRefFor` is exported for exactly that, so the marker layer supplies a
 * target and inherits the travel, the label and the detail view unchanged.
 *
 * ── No per-frame anything ──
 *
 * Chips are rebuilt on a store notification (rulesParams are already batched
 * server-side) and re-read once a second, which is what makes a countdown tick.
 * `PLAN-native-ui.md` forbids per-frame DOM mutation; the sim frame this reads
 * for that countdown is a NON-notifying store mirror (`uiStore.getGameFrame`)
 * fed from the scene feed, precisely so a 30 Hz feed cannot drive a redraw.
 */

import { uiStore } from './ui-store.js';
import { namedEntityIndex } from './named-entity-index.js';
import { nearestPlace } from './focus-hud.js';
import type { FocusRef } from './focus-model.js';
import {
    createDrilldown, detailRow, detailReference,
    type DrilldownAction, type DrilldownHandle, type DrilldownStat, type DrilldownSummary,
} from './drilldown.js';
import {
    MAX_OBJECTIVE_CHIPS, URGENT_FRAMES,
    createObjectiveAnnouncer, framesRemaining, isResolved, parseObjectives,
    rankObjectives, resolvePlace, visibleTo,
    type ObjectiveEvent, type ObjectivePlace, type ObjectiveRecord,
} from './objective-model.js';
import {
    announcement, briefing, consequencePhrase, formatClock, originPhrase,
    progressPhrase, rewardPhrase, shortName, stateWord, taskLine, timePhrase,
} from './objective-phrasing.js';
import type { Widget, WidgetContext } from './widget-loader.js';

/** How often the chips re-read the clock. One second, because the only thing
 *  that changes between store notifications is a countdown measured in seconds. */
export const REFRESH_MS = 1000;

/** How long a state change stays loud: the toast's life and the chip
 *  highlight's, in one number so they decay together. Long enough to notice
 *  mid-fight, short enough that nothing accumulates on screen. */
export const ANNOUNCE_MS = 7000;

/**
 * A chip's live sources, looked up by id at render time.
 *
 * The drilldown holds a `FocusRef` captured at construction, but `summary()`,
 * `detail()` and `actions()` all run against whatever is in here NOW — which is
 * how a countdown ticks and a progress number climbs without the container
 * being rebuilt.
 */
export interface Board {
    byId: Map<number, ObjectiveRecord>;
    placeById: Map<number, ObjectivePlace | null>;
    frame: number;
    teamId?: number;
    delegated: ReadonlySet<number>;
    /** id → wall-clock ms at which its announcement highlight expires. */
    announcedUntil: Map<number, number>;
}

/** The ref an objective is addressed by — here, and (U2) on its world marker. */
export function objectiveRefFor(o: ObjectiveRecord, place: ObjectivePlace | null): FocusRef {
    return {
        kind: 'objective',
        id: o.id,
        label: shortName(o, place),
        position: place ? { x: place.x, z: place.z } : undefined,
        data: { objectiveType: o.type, victory: o.victory === 1, scope: o.scope },
    };
}

const objectiveHud: Widget = {
    id: 'objective-hud',
    init(ctx: WidgetContext): void { mount(ctx); },
    dispose(): void { teardown?.(); teardown = null; },
};

let teardown: (() => void) | null = null;

function mount(ctx: WidgetContext): void {
    teardown?.();

    const root = document.createElement('div');
    root.className = 'nui-objectives';

    const stack = document.createElement('div');
    stack.className = 'nui-objectives__stack';

    const overflow = document.createElement('button');
    overflow.type = 'button';
    overflow.className = 'nui-objectives__overflow';
    overflow.hidden = true;

    const toasts = document.createElement('div');
    toasts.className = 'nui-toasts nui-objectives__toasts';

    root.append(stack, overflow, toasts);
    ctx.mount.append(root);

    const board: Board = {
        byId: new Map(), placeById: new Map(), frame: 0,
        teamId: ctx.identity?.teamId, delegated: new Set(), announcedUntil: new Map(),
    };
    const handles = new Map<number, { handle: DrilldownHandle; travellable: boolean }>();
    const announcer = createObjectiveAnnouncer();
    const toastTimers = new Set<ReturnType<typeof setTimeout>>();
    let showAll = false;

    overflow.addEventListener('click', () => { showAll = !showAll; render(); });

    // ── the toast queue: one line, decaying ─────────────────────────────

    const toast = (event: ObjectiveEvent): void => {
        const el = document.createElement('div');
        el.className = 'nui-toast';
        if (event.kind === 'complete') el.classList.add('nui-toast--award');
        else if (event.kind !== 'appeared') el.classList.add('nui-toast--refusal');
        el.dataset.objectiveId = String(event.id);
        el.textContent = announcement(event.kind, event.record, board.placeById.get(event.id) ?? null);
        toasts.append(el);
        const timer = setTimeout(() => { el.remove(); toastTimers.delete(timer); }, ANNOUNCE_MS);
        toastTimers.add(timer);
    };

    // ── reading the board ───────────────────────────────────────────────

    const readBoard = (): ObjectiveRecord[] => {
        const params = uiStore.getGameRulesParams();
        const all = parseObjectives(params);

        // Regions are the named half of the position hints; landmarks and the
        // rest reach the same index, which is what `nearestPlace` walks.
        const regions = new Map(
            namedEntityIndex.getByType('region').map((r) => [String(r.id), r]),
        );
        const resolvers = {
            region: (key: string) => {
                const r = regions.get(key);
                return r ? { name: r.name, x: r.x, z: r.z } : undefined;
            },
            nearest: (at: { x: number; z: number }) => nearestPlace(at),
        };

        const mine = all.filter((o) => visibleTo(o, board.teamId));
        board.byId = new Map(mine.map((o) => [o.id, o]));
        board.placeById = new Map(mine.map((o) => [o.id, resolvePlace(o, resolvers)]));
        board.frame = uiStore.getGameFrame();
        board.delegated = delegatedSet(ctx);

        // Announce BEFORE ranking, so "something just changed" is a rank input
        // rather than something the player has to spot for themselves.
        const now = Date.now();
        for (const event of announcer.ingest(mine, board.teamId)) {
            board.announcedUntil.set(event.id, now + ANNOUNCE_MS);
            toast(event);
        }
        for (const [id, until] of [...board.announcedUntil]) {
            if (until <= now) board.announcedUntil.delete(id);
        }

        return mine;
    };

    // ── render ──────────────────────────────────────────────────────────

    function render(): void {
        const mine = readBoard();
        const changedIds = new Set(board.announcedUntil.keys());
        const ranked = rankObjectives(mine, {
            frame: board.frame, playerId: ctx.identity?.playerId, changedIds,
        });
        const visible = showAll ? ranked : ranked.slice(0, MAX_OBJECTIVE_CHIPS);
        const wanted = new Set(visible.map((o) => o.id));

        for (const [id, entry] of handles) {
            if (!wanted.has(id)) { entry.handle.dispose(); handles.delete(id); }
        }

        for (const o of visible) {
            const place = board.placeById.get(o.id) ?? null;
            const travellable = place !== null;
            const existing = handles.get(o.id);
            // A chip built before its region entity arrived captured a ref with
            // no position, so its "Go there" is greyed for good. Rebuild it once
            // travellability flips rather than leaving a dead affordance.
            if (existing && existing.travellable === travellable) {
                existing.handle.refresh();
                stack.append(existing.handle.el);
            } else {
                existing?.handle.dispose();
                const handle = createDrilldown(specFor(o.id, objectiveRefFor(o, place)));
                handles.set(o.id, { handle, travellable });
                stack.append(handle.el);
            }
            const el = handles.get(o.id)!.handle.el;
            el.classList.toggle('is-announcing', board.announcedUntil.has(o.id));
            el.classList.toggle('is-victory', o.victory === 1);
            el.classList.toggle('is-resolved', isResolved(o));
        }

        const hidden = ranked.length - visible.length;
        overflow.hidden = ranked.length <= MAX_OBJECTIVE_CHIPS;
        overflow.textContent = showAll
            ? 'Show fewer'
            : `+${hidden} more objective${hidden === 1 ? '' : 's'}`;
        // The seam for U3: once the rung-4 access point exists this line opens
        // the Objectives tab instead of lengthening the stack in place.
        overflow.title = showAll
            ? 'Collapse back to what matters right now'
            : 'Show the rest of the board';

        root.hidden = handles.size === 0;
    }

    function specFor(id: number, ref: FocusRef) {
        return {
            ref,
            summary: (): DrilldownSummary => summaryFor(board, id),
            detail: (host: HTMLElement) => renderDetail(host, board, id),
            actions: (): DrilldownAction[] => actionsFor(ctx, board, id),
        };
    }

    const unsubscribe = uiStore.subscribe(['gameRulesParams', 'teamRulesParams'], render);
    const timer = setInterval(render, REFRESH_MS);
    render();

    teardown = () => {
        unsubscribe();
        clearInterval(timer);
        for (const t of toastTimers) clearTimeout(t);
        toastTimers.clear();
        for (const { handle } of handles.values()) handle.dispose();
        handles.clear();
        root.remove();
    };
}

/** The objective ids this team has delegated to the co-commander AI
 *  (`game_ai_guidance.lua`'s `guidance_<team>_delegated_keys`). */
function delegatedSet(ctx: WidgetContext): ReadonlySet<number> {
    const teamId = ctx.identity?.teamId;
    if (teamId === undefined) return new Set();
    const raw = uiStore.teamRulesParam(teamId, `guidance_${teamId}_delegated_keys`);
    const out = new Set<number>();
    if (raw !== undefined && raw !== null) {
        for (const part of String(raw).split(',')) {
            if (part) out.add(Number(part));
        }
    }
    return out;
}

// ────────────────────────────── rung 1 ──────────────────────────────────

/**
 * A name, a state word and at most three numbers — the ladder's rung-1 budget,
 * spent on the three an objective is actually acted on by.
 *
 * `TIME` only appears when the sim published an `expire` AND we have a clock;
 * a countdown invented from a missing frame is worse than no countdown, because
 * a player will march on it.
 */
export function summaryFor(board: Board, id: number): DrilldownSummary {
    const o = board.byId.get(id);
    if (!o) return { title: 'Objective', state: 'gone' };
    const place = board.placeById.get(id) ?? null;

    const stats: DrilldownStat[] = [];
    if (typeof o.progress === 'number') {
        const pct = Math.round(Math.max(0, Math.min(1, o.progress)) * 100);
        stats.push({
            label: 'Prog', value: `${pct}%`,
            tone: pct >= 100 ? 'good' : pct > 0 ? 'accent' : undefined,
        });
    }
    const remaining = framesRemaining(o, board.frame);
    if (remaining !== null) {
        stats.push({
            label: 'Time', value: formatClock(remaining),
            tone: remaining < URGENT_FRAMES ? 'bad' : undefined,
        });
    }
    if (typeof o.reward === 'number') {
        stats.push({ label: '⬡', value: String(Math.round(o.reward)), tone: 'gold' });
    }

    return {
        title: shortName(o, place),
        state: stateWord(o, { frame: board.frame, teamId: board.teamId }),
        stats,
    };
}

// ────────────────────────────── rung 2 ──────────────────────────────────

function renderDetail(host: HTMLElement, board: Board, id: number): void {
    const o = board.byId.get(id);
    if (!o) { host.append(detailRow('Objective', 'no longer published')); return; }
    const place = board.placeById.get(id) ?? null;

    // The sentence the player clicked, first — a context panel that opens on
    // different words than the chip it came from reads as a different thing.
    host.append(detailRow('Task', taskLine(o, place)));

    const prose = document.createElement('p');
    prose.className = 'nui-dd__prose';
    prose.textContent = briefing(o, place);
    host.append(prose);

    if (place) {
        host.append(detailReference('Where', { x: place.x, z: place.z }, {
            note: place.name
                ? (place.approximate ? `near ${place.name}` : place.name)
                : `${Math.round(place.x)}, ${Math.round(place.z)}`,
        }));
    } else {
        // Say WHY rather than omitting the row: an objective the client cannot
        // place is a real state (a region key with no entry in the index yet),
        // and a silently missing "Where" reads as a UI that forgot.
        host.append(detailRow('Where', o.region
            ? `${o.region} — not on the map index yet`
            : 'no position published'));
    }

    const progress = progressPhrase(o);
    if (progress) host.append(detailRow('Progress', progress));
    host.append(detailRow('Time', timePhrase(o, board.frame)));
    host.append(detailRow('Reward', rewardPhrase(o)));
    host.append(detailRow('Stakes', consequencePhrase(o, board.teamId)));
    host.append(detailRow('Origin', originPhrase(o)));
    if (board.delegated.has(o.id)) {
        host.append(detailRow('Tasking', 'delegated to the co-commander AI'));
    }
}

// ────────────────────────────── rung 3 ──────────────────────────────────

/**
 * What you can DO about an objective.
 *
 * Story 2 asks for respond / refine / cancel. Exactly one of the three has a
 * wire behind it today — `guidance.delegate`, which `game_ai_guidance.lua`
 * genuinely listens for — so the other two render DISABLED WITH THEIR REASON
 * (drilldown.ts rule 5). A greyed button that says why is a promise; a missing
 * button is a feature the player never learns exists, and a live-looking button
 * that does nothing is how a new player concludes the UI is broken.
 */
function actionsFor(ctx: WidgetContext, board: Board, id: number): DrilldownAction[] {
    const o = board.byId.get(id);
    if (!o) return [];
    const delegated = board.delegated.has(o.id);
    const resolved = isResolved(o);

    return [
        {
            id: 'delegate',
            label: delegated ? 'Take it back' : 'Assign to AI',
            hint: resolved
                ? 'This objective is already resolved'
                : delegated
                    ? 'Stop the co-commander AI working this objective'
                    : 'Let the co-commander AI work this objective (it scores a delegated goal x5)',
            disabled: resolved || !ctx.sendCommand,
            run: () => {
                ctx.sendCommand?.('guidance.delegate', {
                    objectiveId: o.id, delegated: delegated ? '0' : '1',
                });
            },
        },
        {
            id: 'refine',
            label: 'Refine',
            // The reason is specific on purpose: "not implemented" tells a
            // player nothing, and tells the next fire nothing either.
            hint: 'Not available — the sim publishes objective terms read-only; ' +
                'changing them needs an objectives.refine wire verb, which does not exist yet',
            disabled: true,
            run: () => {},
        },
        {
            id: 'stand-down',
            label: 'Stand down',
            hint: o.source === 'bounty'
                ? 'Not available — withdrawing a staked bounty needs an objectives.cancel wire verb, which does not exist yet'
                : 'Not available — a scenario objective cannot be declined; only a staked bounty could be withdrawn',
            disabled: true,
            run: () => {},
        },
    ];
}

export default objectiveHud;
