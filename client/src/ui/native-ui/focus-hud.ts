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
    focusModel, focusRefKey, refocusSelection, type FocusRef, type FocusState,
} from './focus-model.js';
import { uiStore } from './ui-store.js';
import { DirectiveType, OrderShape } from './compile-table.js';
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
    /**
     * Whether a census snapshot answered at all.
     *
     * This is what separates "we have not looked yet" from "we looked and they
     * are not there", and the two must never render the same — it is the same
     * rule query-engine.ts holds for every NL answer. Found live: four tank
     * squads were destroyed at Raven Basin with their context panel open, and
     * without this the chip went on saying IDLE for a force that no longer
     * existed.
     */
    mirrored: boolean;
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

    // After a snapshot lands, re-resolve the selection: the census is what
    // tells the focus model whose units these are (enemy-force vs unit), and
    // it arrives after the selection it describes.
    const refreshCensus = (): void => {
        const cache = censusCacheHolder.current;
        if (!cache) return;
        void cache.refresh().then(() => refocusSelection());
    };

    const render = (state: FocusState): void => {
        // Command scope (PLAN-beta.md): the player's OWN squads read first and
        // whole; anything else they can see is dimmed, so responsibility is
        // legible without a second panel. No assignments ⇒ no ordering change
        // at all, which is every tier ≥1 player and every solo mission.
        const assigned = new Set(uiStore.getMyAssignments());
        const ordered = assigned.size === 0
            ? state.subjects
            : [...state.subjects].sort(
                (a, b) => Number(isAssignedToMe(b, assigned)) - Number(isAssignedToMe(a, assigned)));
        const subjects = ordered.slice(0, MAX_SUMMARIES);
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

        applyScope(root, subjects, handles, assigned);

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


/** Does this force include a unit the local player is responsible for? */
export function isAssignedToMe(ref: FocusRef, assigned: ReadonlySet<number>): boolean {
    if (assigned.size === 0) return false;
    return (ref.unitIds ?? []).some((id) => assigned.has(id));
}

/**
 * Label the player's own squads and dim the rest.
 *
 * The heading is a single row above the first chip rather than a section
 * container: the chips are drilldown handles the framework owns, and wrapping
 * them in a second element would break the refresh-in-place that keeps a
 * countdown ticking without a rebuild. Dimming is an inline opacity for the
 * same reason the widget carries no other style — `native-ui.css` belongs to
 * the design system, not to this lane.
 */
function applyScope(
    root: HTMLElement,
    subjects: readonly FocusRef[],
    handles: Map<string, DrilldownHandle>,
    assigned: ReadonlySet<number>,
): void {
    root.querySelector('.nui-focus__scope')?.remove();
    for (const subject of subjects) {
        const el = handles.get(focusRefKey(subject))?.el;
        if (!el) continue;
        const mine = isAssignedToMe(subject, assigned);
        el.style.opacity = assigned.size > 0 && !mine ? '0.55' : '';
        el.dataset.scope = assigned.size === 0 ? '' : mine ? 'mine' : 'other';
    }
    if (assigned.size === 0 || !subjects.some((s) => isAssignedToMe(s, assigned))) return;
    const heading = document.createElement('div');
    heading.className = 'nui-focus__scope';
    heading.textContent = 'Your squads';
    root.prepend(heading);
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
    const hostile = ref.kind === 'enemy-force';
    if ((ref.kind !== 'unit' && !hostile) || !facts.className) return ref.label;
    const scaleWord = facts.scale !== null
        ? SCALE_WORDS[facts.scale as 1 | 2 | 3 | 4]
        : undefined;
    const phrase = scaleWord ? `${scaleWord} ${facts.className}` : facts.className;
    const count = ref.unitIds?.length ?? 0;
    const body = count > 1 ? `${count} × ${phrase}` : phrase;
    // "Enemy" is a qualifier the chip supplies once, up front — the same
    // rule U3 applied to the moment headlines. Never coloured-only: a red
    // border is not something a colour-blind player can read.
    return hostile ? `Enemy ${body}` : body;
}

function stateWord(ref: FocusRef, facts: SquadFacts): string {
    // The mirror answered and none of them are in it: destroyed, or out of
    // vision. Saying "idle" here would be a claim about units we cannot see.
    if (facts.mirrored && facts.seen === 0) return 'out of contact';
    if (facts.moving) return 'moving';
    // An enemy we can see but that is not moving is "spotted", not "idle" —
    // idle is a claim about its orders, which we cannot know.
    if (ref.kind === 'enemy-force') return 'spotted';
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

    if (ref.kind === 'enemy-force') host.append(detailRow('Side', 'enemy — takes no orders from you'));

    // A superior's order on a squad this player is responsible for
    // (`assign_<unitID>_by`). Shown because the player is about to wonder why
    // their squad is moving without them: the relationship is the answer.
    for (const unitId of ref.unitIds ?? []) {
        const by = uiStore.assignedBy(unitId);
        if (by) { host.append(detailRow('Orders', by.line)); break; }
    }

    if (facts.strength === null) {
        // Say which of the three it is. "Unknown", "not visible" and "0%" must
        // never render the same: a mirror that has not answered yet is not a
        // squad we have lost, and neither is a dead one.
        host.append(detailRow('Strength', !facts.mirrored
            ? 'not reported yet'
            : facts.seen === 0
                ? 'out of contact — destroyed, or out of vision'
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

/**
 * What you can DO about a selected force.
 *
 * Every button here has a verb behind it that the client can actually send
 * today, or renders disabled and SAYS why (drilldown.ts rule 5). The census
 * of order verbs this was built against (2026-09-10):
 *
 *   Halt          `PlayerCommand` STOP                  — always
 *   Fall back     `GroupDirective` Withdraw → a point   — a named group, and a
 *                                                          friendly region to go to
 *   Reserve / Release   `guidance.lock`                 — a named group, with an AI
 *   Form a squad  `OrgGroup` create                     — loose own units
 *   Follow        camera                                — anything visible
 *
 * NOT offered, and why: a POSTURE toggle — `GroupPosture` carries a free-form
 * JSON the server stores and echoes and NOTHING reads (no squad module or
 * gadget consumes `postureJson`), so a posture button would be the dead
 * control this framework forbids. "Select the whole squad" on a partial
 * selection still needs the `SelectionPort` U0 filed.
 */
function actionsFor(ctx: WidgetContext, ref: FocusRef): DrilldownAction[] {
    const unitIds = [...(ref.unitIds ?? [])];
    const port = cameraPortHolder.current;
    const following = port?.followingLabel() === ref.label;
    const hostile = ref.kind === 'enemy-force';
    const groupId = ref.kind === 'squad' && typeof ref.id === 'number' ? ref.id : null;
    const teamId = ctx.identity?.teamId;

    const follow: DrilldownAction = {
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
    };

    // An enemy force takes no orders from us. Its rung 3 is camera only —
    // offering Halt on someone else's tanks is the dead button rule 5 forbids.
    if (hostile) return [follow];

    const actions: DrilldownAction[] = [
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
    ];

    if (groupId !== null) {
        // Fall back: a Withdraw directive to the nearest friendly region.
        const facts = factsFor(ref);
        const haven = facts.centroid ? nearestFriendlyRegion(facts.centroid, teamId) : null;
        const partial = ref.data?.partial === true;
        actions.push({
            id: 'fall-back',
            label: haven ? `Fall back to ${haven.name}` : 'Fall back',
            hint: partial
                ? 'Not available — only part of the squad is selected; a directive moves the whole group'
                : !facts.centroid
                    ? 'Not available — no position for this squad yet'
                    : !haven
                        ? 'Not available — no region your side holds is known'
                        : `Withdraw ${ref.label} to ${haven.name}`,
            disabled: partial || !haven || !ctx.sendCommand,
            run: () => {
                if (!haven) return;
                ctx.sendCommand?.({
                    type: 'GroupDirective',
                    payload: {
                        directiveId: 0, groupId, directiveType: DirectiveType.Withdraw,
                        priority: 60, shape: OrderShape.Point, params: [haven.x, 0, haven.z],
                        requestedStrength: 0,
                    },
                });
            },
        });

        // Reserve from / release to the co-commander AI (`guidance.lock`).
        const hasAi = teamId !== undefined && aiPresent(teamId);
        const locked = teamId !== undefined && lockedGroups(teamId).has(groupId);
        actions.push({
            id: 'ai-lock',
            label: locked ? 'Release to AI' : 'Reserve from AI',
            hint: !hasAi
                ? 'Not available — no AI is guiding this team'
                : locked
                    ? 'Let the co-commander AI task this squad again'
                    : 'Keep the co-commander AI\'s hands off this squad',
            disabled: !hasAi || !ctx.sendCommand,
            run: () => {
                ctx.sendCommand?.('guidance.lock', { groupId, locked: locked ? '0' : '1' });
            },
        });
    } else if (ref.kind === 'unit' && unitIds.length > 0) {
        // Loose units are real but nameless, and orders go to squads: the one
        // thing a player can usefully do with a nameless selection is name it.
        const facts = factsFor(ref);
        const name = squadNameFor(facts.className, uiStore.getOrgGroups().map((g) => g.name));
        actions.push({
            id: 'form-squad',
            label: 'Form a squad',
            hint: `Group these ${unitIds.length} unit(s) as "${name}" so orders and sentences can address them`,
            disabled: !ctx.sendCommand,
            run: () => {
                ctx.sendCommand?.({ type: 'OrgGroup', action: 'create', name, memberIds: unitIds });
            },
        });
    }

    actions.push(follow);
    return actions;
}

/** A callsign for a new squad: the class word, numbered past existing names. */
export function squadNameFor(className: string | null, existing: readonly string[]): string {
    const base = className ? className.charAt(0).toUpperCase() + className.slice(1) : 'Squad';
    const taken = new Set(existing.map((n) => n.toLowerCase()));
    let n = 1;
    while (taken.has(`${base} ${n}`.toLowerCase())) n++;
    return `${base} ${n}`;
}

/** True when a co-commander AI publishes guidance for `teamId`, or the roster
 *  seats an AI on it. Feature-detected: the chip must not promise an AI that
 *  is not there. */
export function aiPresent(teamId: number): boolean {
    if (uiStore.teamRulesParam(teamId, `guidance_${teamId}_stance`) !== undefined) return true;
    return uiStore.getPlayers().some((p) => p.isAI && p.teamId === teamId && !p.isSpectator);
}

/** Group ids under `guidance_<team>_lock_keys`. */
export function lockedGroups(teamId: number): ReadonlySet<number> {
    const raw = uiStore.teamRulesParam(teamId, `guidance_${teamId}_lock_keys`);
    const out = new Set<number>();
    if (raw === undefined || raw === null) return out;
    for (const part of String(raw).split(',')) if (part) out.add(Number(part));
    return out;
}

/**
 * The nearest region owned by `teamId` — where "fall back" goes. Region
 * ownership is `region_<key>_team` on the public wire (game_regions.lua);
 * the index supplies the centre and the name.
 */
export function nearestFriendlyRegion(
    at: { x: number; z: number },
    teamId: number | undefined,
    entities = namedEntityIndex.getByType('region'),
    ownerOf: (key: string) => number = (key) => Number(uiStore.gameRulesParam(`region_${key}_team`) ?? -1),
): { name: string; x: number; z: number } | null {
    if (teamId === undefined) return null;
    let best: { name: string; x: number; z: number } | null = null;
    let bestDist = Infinity;
    for (const e of entities) {
        if (ownerOf(String(e.id)) !== teamId) continue;
        if (e.x === 0 && e.z === 0) continue;
        const dist = Math.hypot(e.x - at.x, e.z - at.z);
        if (dist < bestDist) { bestDist = dist; best = { name: e.name, x: e.x, z: e.z }; }
    }
    return best;
}

// ───────────────────────────── census reads ─────────────────────────────

/** Everything the two rungs above need, derived from one census snapshot. */
export function factsFor(ref: FocusRef, census: Census | null = snapshot()): SquadFacts {
    const empty: SquadFacts = {
        mirrored: census !== null, seen: 0, strength: null, weakest: null,
        moving: false, centroid: null, className: null, scale: null,
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
        mirrored: true,
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
