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
    createObjectiveAnnouncer, disambiguateTitles, framesRemaining, isResolved, parseObjectives,
    rankObjectives, resolvePlace, visibleTo,
    type ObjectiveEvent, type ObjectivePlace, type ObjectiveRecord,
} from './objective-model.js';
import {
    announcement, briefing, consequencePhrase, formatClock, originPhrase,
    progressPhrase, rewardPhrase, shortName, stateWord, taskLine, timePhrase,
    victoryLine,
} from './objective-phrasing.js';
import { createNoticeLane, type NoticeLane } from './notice-lane.js';
import { globalSurface } from './global-surface.js';
import type { Widget, WidgetContext } from './widget-loader.js';

/** How often the chips re-read the clock. One second, because the only thing
 *  that changes between store notifications is a countdown measured in seconds. */
export const REFRESH_MS = 1000;

/** How long a state change stays loud: the notice's life and the chip
 *  highlight's, in one number so they decay together. Long enough to notice
 *  mid-fight, short enough that nothing accumulates on screen.
 *
 *  U3 note: the notice half is now `notice-lane.ts`'s, shared with the battle
 *  moments — the brief's "one mechanism, not two". This number is passed to the
 *  lane as this widget's TTL rather than being re-implemented beside it. */
export const ANNOUNCE_MS = 7000;

/** How long a victory objective keeps reading "contested" after its published
 *  progress went backwards. A hold clock reset is a moment, not a state, and
 *  the wire carries no flag for it — see `victoryLine`. */
export const CONTESTED_MS = 20_000;

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
    /** id → qualifier for a title that collides with another on this board
     *  (`disambiguateTitles`). Empty for unique titles. */
    qualifiers?: Map<number, string>;
}

/** The chip title: the short name, qualified only when another row shares it. */
export function chipTitle(board: Board, o: ObjectiveRecord, place: ObjectivePlace | null): string {
    const q = board.qualifiers?.get(o.id);
    const name = shortName(o, place);
    return q ? `${name} ${q}` : name;
}

/** Fill `board.qualifiers` for the records about to be drawn. */
function qualifyBoard(board: Board, records: readonly ObjectiveRecord[]): void {
    board.qualifiers = disambiguateTitles(
        records,
        (o) => shortName(o, board.placeById.get(o.id) ?? null),
    );
}

/** The ref an objective is addressed by — here, and (U2) on its world marker. */
export function objectiveRefFor(o: ObjectiveRecord, place: ObjectivePlace | null): FocusRef {
    return {
        kind: 'objective',
        id: o.id,
        label: shortName(o, place),
        position: place ? { x: place.x, z: place.z } : undefined,
        // The NAME of where it is, separate from the title — story 4's "defend
        // it" resolves against this. It cannot use the title: the entity index
        // holds this objective as "Hold: Raven Basin" while the chip reads
        // "Hold Raven Basin", and a sentence that binds to the title lands on
        // a name the resolver has never heard of. `approximate` places are
        // still named ("near Storm Sound" is Storm Sound); the hedge is in the
        // phrasing, not in which place it is.
        ...(place?.name ? { place: place.name } : {}),
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

    root.append(stack, overflow);
    ctx.mount.append(root);

    // U3: the ONE notice mechanism, shared with the battle moments. U1 grew its
    // own toast queue here; it was lifted into `notice-lane.ts` rather than
    // duplicated, so there is one set of rules about how long a notice lives.
    const lane: NoticeLane = createNoticeLane(root, { defaultTtlMs: ANNOUNCE_MS });

    const board: Board = {
        byId: new Map(), placeById: new Map(), frame: 0,
        teamId: ctx.identity?.teamId, delegated: new Set(), announcedUntil: new Map(),
    };
    const handles = new Map<number, { handle: DrilldownHandle; travellable: boolean }>();
    const announcer = createObjectiveAnnouncer();
    let showAll = false;
    /** Last progress seen per objective, so a hold clock RESET is observable —
     *  the wire has no `contested` field and this is the only honest source. */
    const lastProgress = new Map<number, number>();
    /** id → wall clock until which it reads as contested. */
    const contestedUntil = new Map<number, number>();

    overflow.addEventListener('click', () => { showAll = !showAll; render(); });

    // ── the notice: one line, decaying, in the shared lane ──────────────
    //
    // PLAIN TEXT and not a drilldown, unlike a battle moment: the objective's
    // own rung-1 chip is already on screen one line up, and giving the notice a
    // second chip for the same objective would put two affordances for one
    // thing in the player's eye at once. The chip highlight (`is-announcing`)
    // is what ties the two together.
    const toast = (event: ObjectiveEvent): void => {
        lane.push({
            key: `objective:${event.id}:${event.kind}`,
            text: announcement(event.kind, event.record, board.placeById.get(event.id) ?? null),
            tone: event.kind === 'complete' ? 'good'
                : event.kind === 'appeared' ? undefined : 'bad',
        });
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

        // A hold clock that RESET is the one contested signal the wire gives
        // us, and it only exists as a difference between two reads — the
        // published `progress` going backwards. Watched here, where every read
        // already passes.
        for (const o of mine) {
            const p = typeof o.progress === 'number' ? o.progress : null;
            if (p === null) continue;
            const prev = lastProgress.get(o.id);
            if (prev !== undefined && p < prev - 0.01) {
                contestedUntil.set(o.id, now + CONTESTED_MS);
            }
            lastProgress.set(o.id, p);
        }
        for (const [id, until] of [...contestedUntil]) {
            if (until <= now) contestedUntil.delete(id);
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
        // Qualify against the WHOLE board, not the visible slice: a title that
        // is unique among three chips and duplicated in the tab must read the
        // same in both, or a player opening the tab sees a chip rename itself.
        qualifyBoard(board, ranked);
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

        // DESIGN-DRILLDOWN §6's one permitted leak: the victory condition's
        // state, always visible beside the access point, drilling into the full
        // board rather than carrying detail of its own. Filled from here
        // because this widget is the one thing that parses the objective wire —
        // a second reader is how two surfaces start disagreeing.
        const victory = ranked.find((o) => o.victory === 1 && !isResolved(o))
            ?? ranked.find((o) => o.victory === 1);
        globalSurface.setSummaryLine(
            victory
                ? victoryLine(victory, board.placeById.get(victory.id) ?? null, {
                    frame: board.frame,
                    teamId: board.teamId,
                    contested: contestedUntil.has(victory.id),
                })
                : null,
        );

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
        lane.dispose();
        for (const { handle } of handles.values()) handle.dispose();
        handles.clear();
        globalSurface.setSummaryLine(null);
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
        title: chipTitle(board, o, place),
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

// ───────────────────── rung 4: the Objectives tab ───────────────────────

/**
 * The FULL board, behind the one access point (DESIGN-DRILLDOWN.md §6).
 *
 * U1 capped the resting stack at `MAX_OBJECTIVE_CHIPS` and left the rest behind
 * an overflow line that lengthened the stack in place — the seam its `render`
 * marked for U3. This is where that line now goes: every objective, ranked the
 * same way, drawn with the SAME `createDrilldown` spec as the chips, so an
 * objective opened here reads exactly as it does at rung 1.
 *
 * It shares this file rather than importing half of it, for the same reason
 * `event-log` shares `moment-hud.ts`: the board and the chips are one reading
 * of one wire format, and two files would be two readings.
 */
const objectiveBoard: Widget = {
    id: 'objective-board',
    init(ctx: WidgetContext): void { mountBoard(ctx); },
    dispose(): void { boardTeardown?.(); boardTeardown = null; },
};

let boardTeardown: (() => void) | null = null;

function mountBoard(ctx: WidgetContext): void {
    boardTeardown?.();

    const root = document.createElement('div');
    root.className = 'nui-board';
    ctx.mount.append(root);

    const board: Board = {
        byId: new Map(), placeById: new Map(), frame: 0,
        teamId: ctx.identity?.teamId, delegated: new Set(), announcedUntil: new Map(),
    };
    const handles = new Map<number, DrilldownHandle>();

    const render = (): void => {
        const params = uiStore.getGameRulesParams();
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
        const mine = parseObjectives(params).filter((o) => visibleTo(o, board.teamId));
        board.byId = new Map(mine.map((o) => [o.id, o]));
        board.placeById = new Map(mine.map((o) => [o.id, resolvePlace(o, resolvers)]));
        board.frame = uiStore.getGameFrame();
        board.delegated = delegatedSet(ctx);

        const ranked = rankObjectives(mine, {
            frame: board.frame, playerId: ctx.identity?.playerId, changedIds: new Set(),
        });
        qualifyBoard(board, ranked);
        const wanted = new Set(ranked.map((o) => o.id));
        for (const [id, handle] of handles) {
            if (!wanted.has(id)) { handle.dispose(); handles.delete(id); }
        }
        if (ranked.length === 0) {
            root.replaceChildren();
            const empty = document.createElement('p');
            empty.className = 'nui-log__empty';
            empty.textContent = 'No objectives on the board.';
            root.append(empty);
            return;
        }
        root.querySelector('.nui-log__empty')?.remove();
        for (const o of ranked) {
            const place = board.placeById.get(o.id) ?? null;
            let handle = handles.get(o.id);
            if (!handle) {
                handle = createDrilldown({
                    ref: objectiveRefFor(o, place),
                    summary: () => summaryFor(board, o.id),
                    detail: (host) => renderDetail(host, board, o.id),
                    actions: () => actionsFor(ctx, board, o.id),
                });
                handles.set(o.id, handle);
            } else {
                handle.refresh();
            }
            root.append(handle.el);
            handle.el.classList.toggle('is-victory', o.victory === 1);
            handle.el.classList.toggle('is-resolved', isResolved(o));
        }
    };

    const unsubscribe = uiStore.subscribe(['gameRulesParams', 'teamRulesParams'], render);
    const timer = setInterval(render, REFRESH_MS);
    render();

    boardTeardown = () => {
        unsubscribe();
        clearInterval(timer);
        for (const handle of handles.values()) handle.dispose();
        handles.clear();
        root.remove();
    };
}

export { objectiveBoard };
export default objectiveHud;
