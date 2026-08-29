/**
 * focus-hud.ts — the story-1 vertical slice: select a squad, drill in, go there
 * (DESIGN-DRILLDOWN.md §6)
 *
 *     select a squad  →  a floating summary appears (name · state · 2 numbers)
 *                     →  click it  →  a context panel with detail + actions
 *                     →  click a location it names  →  the camera travels there
 *
 * That is the WHOLE of this widget's scope. It exists to prove the U0
 * framework end to end on the player path, not to be the finished HUD:
 * objectives (U1), world markers (U2), event moments (U3) and the NL command
 * line (U4) are all more `createDrilldown` calls against more `FocusKind`s,
 * added here or beside here — never a second mechanism.
 *
 * ── Where it mounts, and why not at the bottom ──
 *
 * `top-center`, as a bare (chrome-less) widget: no panel frame, no header, no
 * collapse toggle, and NOTHING AT ALL in the DOM while the selection is empty.
 * A summary affordance that is present-but-empty is still clutter.
 *
 * Bottom-centre would be the conventional RTS home for a selection readout, and
 * it is taken: the design system reserves the centre and lower centre for
 * selection gestures and orders (native-ui.css's occlusion budget), and the
 * engine HUD's own `#hud-selection` / minimap / help strip already occupy the
 * bottom band. Top-centre is the only dock that is both near the player's eye
 * line and outside the zone they are clicking in.
 *
 * ── Live data, without a per-frame anything ──
 *
 * Strength and movement come from the NL census (`nlCensus` via
 * `censusCacheHolder`) — the same LOS-honest unit mirror the command language
 * reads, so the HUD and a sentence can never disagree about a squad's state.
 * The census is pulled on selection change and then at `REFRESH_MS` while a
 * selection exists, and not at all while nothing is selected. PLAN-native-ui.md
 * forbids per-frame DOM mutation; this is 1 Hz and it stops.
 */

import { censusCacheHolder, SCALE_WORDS, type Census } from './query-engine.js';
import { cameraPortHolder } from './camera-port.js';
import { namedEntityIndex } from './named-entity-index.js';
import {
    focusModel, focusRefKey, type FocusRef, type FocusState,
} from './focus-model.js';
import {
    createDrilldown, detailRow, detailReference,
    type DrilldownAction, type DrilldownHandle, type DrilldownStat, type DrilldownSummary,
} from './drilldown.js';
import type { Widget, WidgetContext } from './widget-loader.js';

/** How often the summary re-reads the census while something is selected. Slow
 *  enough to be free, fast enough that a squad taking fire visibly loses
 *  strength while the player watches it. */
export const REFRESH_MS = 1000;

/**
 * How many summary affordances may be on screen at once.
 *
 * A selection spanning eight groups is a real thing a player can do, and
 * answering it with eight stacked chips would rebuild the wall of panels this
 * framework exists to remove. Beyond the cap the HUD says how many it is not
 * showing rather than silently dropping them.
 */
export const MAX_SUMMARIES = 3;

/** Place types "near what?" may name. Objectives are deliberately excluded —
 *  an objective is a rung of its own (U1), not a landmark. */
const PLACE_TYPES = ['region', 'district', 'city', 'landmark'] as const;

/** Spring's STOP. Duplicated from `command-buffer.ts`'s CMD table rather than
 *  imported: that module is worker-side and pulls in the wire encoder. */
const CMD_STOP = 0;

interface SquadFacts {
    /** Members the census can currently see. May be fewer than the selection
     *  if the mirror is behind, and that is reported rather than papered over. */
    seen: number;
    /** Mean health across seen members, 0..1. Null when no member reported one. */
    strength: number | null;
    /** Weakest member's health, 0..1. Null when unknown. */
    weakest: number | null;
    moving: boolean;
    centroid: { x: number; z: number } | null;
    /** `ms_class` of the majority of members ("tanks"), when they agree. */
    className: string | null;
    /** `ms_scale` of the majority of members (1..4), when they agree. */
    scale: number | null;
}

const focusHud: Widget = {
    id: 'focus-hud',
    init(ctx: WidgetContext): void {
        mount(ctx);
    },
    dispose(): void {
        teardown?.();
        teardown = null;
    },
};

let teardown: (() => void) | null = null;

function mount(ctx: WidgetContext): void {
    // Re-mount without a dispose (a resync) must not leave the old
    // subscriptions running against a detached DOM.
    teardown?.();

    const root = document.createElement('div');
    root.className = 'nui-focus';
    ctx.mount.append(root);

    const handles = new Map<string, DrilldownHandle>();
    let overflowEl: HTMLElement | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const refreshCensus = (): void => { void censusCacheHolder.current?.refresh(); };

    const render = (state: FocusState): void => {
        const subjects = state.subjects.slice(0, MAX_SUMMARIES);
        const wanted = new Set(subjects.map(focusRefKey));

        for (const [key, handle] of handles) {
            if (!wanted.has(key)) {
                handle.dispose();
                handles.delete(key);
            }
        }

        for (const subject of subjects) {
            const key = focusRefKey(subject);
            const existing = handles.get(key);
            if (existing) {
                existing.refresh();
                // Keep DOM order matching subject order without rebuilding —
                // appending an already-attached node moves it.
                root.append(existing.el);
                continue;
            }
            const handle = createDrilldown(specFor(subject));
            handles.set(key, handle);
            root.append(handle.el);
        }

        const hidden = state.subjects.length - subjects.length;
        if (hidden > 0) {
            if (!overflowEl) {
                overflowEl = document.createElement('div');
                overflowEl.className = 'nui-focus__overflow';
            }
            overflowEl.textContent = `+${hidden} more selected`;
            root.append(overflowEl);
        } else {
            overflowEl?.remove();
            overflowEl = null;
        }

        // The whole affordance disappears when nothing is focused. This is the
        // directive's "out of the way until it is needed", made literal.
        root.hidden = handles.size === 0;

        const wantTimer = handles.size > 0;
        if (wantTimer && timer === null) {
            refreshCensus();
            timer = setInterval(() => {
                refreshCensus();
                for (const handle of handles.values()) handle.refresh();
            }, REFRESH_MS);
        } else if (!wantTimer && timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    };

    const unsubscribe = focusModel.subscribe(render);
    render(focusModel.getState());

    teardown = () => {
        unsubscribe();
        if (timer !== null) clearInterval(timer);
        timer = null;
        for (const handle of handles.values()) handle.dispose();
        handles.clear();
        root.remove();
    };

    // ── the one kind this slice knows how to render ─────────────────────

    function specFor(ref: FocusRef) {
        return {
            ref,
            summary: (): DrilldownSummary => summaryFor(ref),
            detail: (host: HTMLElement) => renderDetail(host, ref),
            actions: (): DrilldownAction[] => actionsFor(ctx, ref),
        };
    }
}

// ────────────────────────────── rung 1 ──────────────────────────────────

/**
 * The summary a chip shows: a name, a state word and TWO numbers.
 *
 * Two, not three — the cap in `drilldown.ts` is a ceiling, not a target. What
 * a player glancing at a selected squad needs is "how many, and are they
 * hurt"; anything else they need, they can ask for by clicking.
 */
export function summaryFor(ref: FocusRef, facts = factsFor(ref)): DrilldownSummary {
    const selected = ref.unitIds?.length ?? 0;
    const roster = Number(ref.data?.rosterCount ?? selected);
    const partial = ref.data?.partial === true;

    const stats: DrilldownStat[] = [{
        label: 'Units',
        value: partial ? `${selected}/${roster}` : String(selected),
    }];
    if (facts.strength !== null) {
        stats.push({
            label: 'Str',
            value: `${Math.round(facts.strength * 100)}%`,
            tone: facts.strength >= 0.85 ? 'good' : facts.strength <= 0.4 ? 'bad' : undefined,
        });
    }

    return { title: titleFor(ref, facts), state: stateWord(ref, facts), stats };
}

/**
 * What the chip calls this force.
 *
 * A named group is called by its name, full stop. An UNGROUPED selection has no
 * name, and `resolveSelectionSubjects` correctly refuses to invent one — but
 * "4 units" is not something a player recognises on a battlefield, and
 * Metalstorm's showcase scenarios spawn squad units without ever creating an
 * org group, so that is the common case rather than an edge one. So the chip
 * names it by CLASS, from the same census the command language reads and using
 * the same scale words (`SCALE_WORDS`, `_builder.lua`'s table) a sentence would
 * use — "4 × heavy tanks".
 *
 * This is a display name, not a second identity: `ref.label` is unchanged, and
 * the NL layer never addresses an ungrouped selection by label anyway (it is
 * the `selection` subject, a count — see nl-context.ts's `self.selection`).
 */
function titleFor(ref: FocusRef, facts: SquadFacts): string {
    if (ref.kind !== 'unit' || !facts.className) return ref.label;
    const scaleWord = facts.scale !== null
        ? SCALE_WORDS[facts.scale as 1 | 2 | 3 | 4]
        : undefined;
    const phrase = scaleWord ? `${scaleWord} ${facts.className}` : facts.className;
    const count = ref.unitIds?.length ?? 0;
    return count > 1 ? `${count} × ${phrase}` : phrase;
}

function stateWord(ref: FocusRef, facts: SquadFacts): string {
    if (facts.moving) return 'moving';
    // "tasked" beats "idle": a stationary squad with a directive is holding,
    // not doing nothing, and the difference is what a player acts on.
    if (ref.data?.tasked === true) return 'tasked';
    return 'idle';
}

// ────────────────────────────── rung 2 ──────────────────────────────────

function renderDetail(host: HTMLElement, ref: FocusRef): void {
    const facts = factsFor(ref);
    const selected = ref.unitIds?.length ?? 0;
    const roster = Number(ref.data?.rosterCount ?? selected);

    host.append(detailRow('Roster', ref.data?.partial === true
        ? `${selected} of ${roster} selected`
        : `${selected} selected`));

    if (facts.className) {
        const scaleWord = facts.scale !== null ? SCALE_WORDS[facts.scale as 1 | 2 | 3 | 4] : undefined;
        host.append(detailRow('Class', scaleWord ? `${scaleWord} ${facts.className}` : facts.className));
    }

    if (facts.strength === null) {
        // Say which of the two it is. "Unknown" and "0%" must never render the
        // same, and a mirror that has not answered yet is not a dead squad.
        host.append(detailRow('Strength', facts.seen === 0
            ? 'not reported yet'
            : 'unknown'));
    } else {
        const weakest = facts.weakest === null ? '' :
            ` (weakest ${Math.round(facts.weakest * 100)}%)`;
        host.append(detailRow('Strength', `${Math.round(facts.strength * 100)}%${weakest}`));
    }

    // ── the references: everywhere this squad IS, one click from going there
    if (facts.centroid) {
        host.append(detailReference('Position', facts.centroid, {
            note: `${Math.round(facts.centroid.x)}, ${Math.round(facts.centroid.z)}`,
        }));
        const near = nearestPlace(facts.centroid);
        if (near) {
            host.append(detailReference('Near', { x: near.x, z: near.z }, {
                note: near.name,
            }));
        }
    } else if (ref.unitIds && ref.unitIds.length > 0) {
        // No census position yet, but the worker can still frame a member by
        // id — so the affordance is live rather than greyed on a technicality.
        host.append(detailReference('Position', { unitId: ref.unitIds[0] }, {
            note: 'resolving…',
        }));
    }
}

// ────────────────────────────── rung 3 ──────────────────────────────────

function actionsFor(ctx: WidgetContext, ref: FocusRef): DrilldownAction[] {
    const unitIds = [...(ref.unitIds ?? [])];
    const port = cameraPortHolder.current;
    const following = port?.followingLabel() === ref.label;

    return [
        {
            id: 'halt',
            label: 'Halt',
            hint: unitIds.length === 0
                ? 'Nothing selected to halt'
                : `Stop ${unitIds.length} unit(s)`,
            disabled: unitIds.length === 0 || !ctx.sendCommand,
            run: () => {
                ctx.sendCommand?.({
                    type: 'PlayerCommand', cmdId: CMD_STOP, unitIds, params: [], options: 0,
                });
            },
        },
        {
            id: 'follow',
            label: following ? 'Stop following' : 'Follow',
            hint: following
                ? 'Release the camera'
                : 'Keep the camera on this force until you move it',
            disabled: !port || unitIds.length === 0,
            run: () => {
                if (!port) return;
                if (following) { port.stopFollow('stopped'); return; }
                port.follow({
                    label: ref.label,
                    // Re-read every tick: a follow that captured one centroid
                    // tracks a photograph (see camera-port.ts's onFollowTick).
                    position: () => factsFor(ref).centroid,
                });
            },
        },
    ];
}

// ───────────────────────────── census reads ─────────────────────────────

/** Everything the two rungs above need, derived from one census snapshot. */
export function factsFor(ref: FocusRef, census: Census | null = snapshot()): SquadFacts {
    const empty: SquadFacts = {
        seen: 0, strength: null, weakest: null, moving: false,
        centroid: null, className: null, scale: null,
    };
    const ids = ref.unitIds;
    if (!census || !ids || ids.length === 0) return empty;

    const wanted = new Set(ids);
    let sumX = 0, sumZ = 0, seen = 0;
    let healthSum = 0, healthCount = 0, weakest: number | null = null;
    let movingCount = 0;
    const classes = new Map<string, number>();
    const scales = new Map<number, number>();

    for (const unit of census.units) {
        if (!wanted.has(unit.unitId)) continue;
        seen++;
        sumX += unit.x;
        sumZ += unit.z;
        if (typeof unit.health === 'number') {
            healthSum += unit.health;
            healthCount++;
            weakest = weakest === null ? unit.health : Math.min(weakest, unit.health);
        }
        if (unit.moving) movingCount++;
        if (unit.className) classes.set(unit.className, (classes.get(unit.className) ?? 0) + 1);
        if (typeof unit.scale === 'number') scales.set(unit.scale, (scales.get(unit.scale) ?? 0) + 1);
    }

    if (seen === 0) return empty;

    let className: string | null = null;
    let best = 0;
    for (const [name, count] of classes) if (count > best) { best = count; className = name; }

    let scale: number | null = null;
    let bestScale = 0;
    for (const [value, count] of scales) if (count > bestScale) { bestScale = count; scale = value; }

    return {
        seen,
        strength: healthCount > 0 ? healthSum / healthCount : null,
        weakest,
        // Any member under way means the force is under way — a column whose
        // rear has stopped is still moving, and "idle" would be a lie.
        moving: movingCount > 0,
        centroid: { x: sumX / seen, z: sumZ / seen },
        className,
        scale,
    };
}

function snapshot(): Census | null {
    return censusCacheHolder.current?.snapshot() ?? null;
}

/** The nearest named place to a point, or null when the index holds none.
 *  Straight-line distance: "near" is a bearing for the player, not a path. */
export function nearestPlace(
    at: { x: number; z: number },
    entities = namedEntityIndex.getAll(),
): { name: string; x: number; z: number } | null {
    let best: { name: string; x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (const e of entities) {
        if (!(PLACE_TYPES as readonly string[]).includes(e.type)) continue;
        // Org groups and anything else that landed in the index without a real
        // position sit at (0,0); a "nearest place" that is always the map
        // corner is worse than no answer (see entity-index-producer.ts).
        if (e.x === 0 && e.z === 0) continue;
        const dist = Math.hypot(e.x - at.x, e.z - at.z);
        if (dist < bestDist) { bestDist = dist; best = { name: e.name, x: e.x, z: e.z }; }
    }
    return best;
}

export default focusHud;
