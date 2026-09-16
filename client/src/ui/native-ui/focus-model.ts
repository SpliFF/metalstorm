/**
 * focus-model.ts — what the player is currently paying attention to
 * (DESIGN-DRILLDOWN.md §3, the U0 framework)
 *
 * ONE source of truth for "what is selected / opened / drilled into", read by
 * the HUD, by every drill-down surface, and (story 4) by the natural-language
 * layer when it resolves "them", "it", "that town".
 *
 * ── Why this is not just `uiStore.getSelection()` ──
 *
 * The store's selection is a list of raw sim unit ids — the wire's own answer
 * to "what did the player click". That is the right thing for the store to
 * hold and the wrong thing for the UI to reason about, because none of the
 * four interaction stories are about unit ids:
 *
 *   - a player who box-selects a squad has selected ONE THING with a name, not
 *     six numbered units;
 *   - "pull them back" has to mean a subject, and a subject is what a name
 *     addresses;
 *   - a context panel that is open is part of the focus too ("defend it" with
 *     an objective drilled means that objective), and no selection carries it.
 *
 * So this model sits one rung above the store: it takes the raw id list plus
 * the org-group roster and RESOLVES it into `subjects` — named refs the whole
 * UI can render and the NL layer can name. `resolveSelectionSubjects` is pure
 * and exported so the resolution rules are testable without a store, a DOM or
 * a worker.
 *
 * ── The three fields, and why each is separately load-bearing ──
 *
 *   `subjects`      what the world selection means. The default antecedent.
 *   `drilled`       the ONE ref whose context panel is open. Takes precedence
 *                   over `subjects` for a pronoun, because the player is
 *                   looking straight at it.
 *   `openSurfaces`  ids of open panels/overlays, so "close that" and
 *                   "what does this say" have something to bind to, and so a
 *                   later rung can know the HUD is already busy.
 *
 * ── No DOM, no store import, no camera ──
 *
 * This module is state and rules only. `bindSelectionToFocus` is the one
 * adapter, and it takes its store as an argument rather than importing the
 * singleton, so a test can drive the whole binding with a fake.
 */

// ─────────────────────────────── the shape ──────────────────────────────

/**
 * What kind of thing a focus reference names.
 *
 * Deliberately the vocabulary of the DIRECTIVE's four stories (squads, towns,
 * enemy groups, objectives) plus the two primitives everything else decays to
 * — a raw unit set, and a bare place on the map. A kind is added here only
 * when a rung of the ladder can genuinely render a summary AND a detail view
 * for it; a kind with no detail view is a dead end the player can click into.
 */
export type FocusKind =
    | 'squad'         // an org group, or a metalstorm squad unit
    | 'unit'          // raw unit ids that resolved to nothing named
    | 'town'          // a settlement / claimable POI
    | 'enemy-force'   // a spotted hostile grouping (a selection of enemy units)
    | 'objective'     // a live objective
    | 'area'          // a named place: region, district, landmark, zone
    | 'ai';           // the team's co-commander AI (ai-hud.ts owns its rung 2)

/**
 * One thing the player can be focused on.
 *
 * `position` is what makes a ref TRAVELLABLE (see camera-travel.ts): a ref
 * that carries one gets a "go there" affordance everywhere it is rendered, and
 * one that does not, does not — rather than a button that silently does
 * nothing. `unitIds` is the other travel route: a ref with members can be
 * framed worker-side without the client knowing where they are.
 */
export interface FocusRef {
    kind: FocusKind;
    /** Stable within `kind`. Numeric for units/groups/objectives, string for places. */
    id: string | number;
    /** What the player is shown and what a sentence may call this. */
    label: string;
    /** Ground position, when this ref names somewhere. Absent ⇒ not travellable by position. */
    position?: { x: number; z: number };
    /** Sim unit ids this ref covers. Empty for pure places. */
    unitIds?: readonly number[];
    /**
     * The NAME of the place this ref is at, when one is known — "Raven Basin"
     * for the objective whose chip reads "Hold Raven Basin".
     *
     * A name, deliberately, not the `position` above: this is what story 4's
     * "defend it" binds to, and the NL envelope is name-addressed, so a
     * position here would be unusable at the one seam it exists for. It has to
     * be a name the entity index also holds, because that is what the resolver
     * will look up — an objective's own TITLE is not (the index calls it
     * "Hold: Raven Basin"), which is exactly why this field is separate from
     * `label` rather than being derived from it.
     */
    place?: string;
    /** Kind-specific payload the detail view reads. Never rendered generically. */
    data?: Record<string, unknown>;
}

/** `kind:id` — the identity a subscriber compares to know the focus MOVED. */
export function focusRefKey(ref: FocusRef): string {
    return `${ref.kind}:${ref.id}`;
}

export interface FocusState {
    /** The raw selection, exactly as the worker reported it. */
    unitIds: readonly number[];
    /** What that selection resolves to. Empty when nothing is selected. */
    subjects: readonly FocusRef[];
    /** The ref whose context panel is open, if any. */
    drilled: FocusRef | null;
    /** Ids of open panels / overlays, in the order they were opened. */
    openSurfaces: readonly string[];
}

const EMPTY: FocusState = Object.freeze({
    unitIds: Object.freeze([]) as readonly number[],
    subjects: Object.freeze([]) as readonly FocusRef[],
    drilled: null,
    openSurfaces: Object.freeze([]) as readonly string[],
});

// ───────────────────────────── selection → subjects ─────────────────────

/** The org-group slice resolution needs. Structural, so `OrgGroupSummary`
 *  satisfies it without this module depending on the store's types. */
export interface FocusGroupLike {
    groupId: number;
    name: string;
    memberIds: readonly number[];
    /** 0 = no directive assigned ⇒ the group reads as `idle`. */
    currentDirectiveId?: number;
}

/**
 * Turn a raw selection into named subjects.
 *
 * Three rules, in order, and the ORDER is the design:
 *
 *  1. **Exact roster ⇒ the group.** Selecting every member of "3rd Tanks" and
 *     nothing else means the player selected 3rd Tanks. This is the same
 *     exact-set rule `cost-preview.ts`'s `matchSelectionToGroup` applies to
 *     pre-fill the composer's Subject slot, kept identical on purpose: the
 *     HUD and the order path must never disagree about what is selected.
 *
 *  2. **Partial ⇒ the group, marked partial.** A player who box-selects four
 *     of a six-tank group is still looking at 3rd Tanks, and telling them
 *     "4 units" instead is exactly the spreadsheet reading the directive
 *     rejects. The `partial` flag is carried in `data` so the summary can say
 *     "4 of 6" and an order path can refuse to treat it as the whole group.
 *
 *  3. **Anything left over ⇒ one anonymous unit ref.** Ungrouped units are
 *     real and selectable; they get a ref so the ladder still has a rung 1,
 *     but no invented name.
 *
 * A selection spanning several groups yields several subjects — that is a
 * truthful answer, not an ambiguity to resolve here. Whoever needs ONE subject
 * (an order, a pronoun) applies its own tie-break with the whole list in hand.
 */
export interface ResolveOptions {
    /**
     * Whether a unit id is an ENEMY unit. Supplied by the binding from the
     * LOS-honest census (`side === 'enemy'`); absent ⇒ nothing is hostile.
     *
     * Hostile units never join an org group (a group is ours by construction),
     * so they are split out of the loose remainder into an `enemy-force` ref —
     * the directive's own third selectable kind. A selection of enemy tanks
     * labelled "3 units" with a Halt button is a lie twice over: the sim will
     * refuse the order, and the chip has told the player nothing about whose
     * tanks they are.
     */
    isHostile?: (unitId: number) => boolean;
}

export function resolveSelectionSubjects(
    unitIds: readonly number[],
    groups: readonly FocusGroupLike[],
    opts: ResolveOptions = {},
): FocusRef[] {
    if (unitIds.length === 0) return [];

    const selected = new Set(unitIds);
    const claimed = new Set<number>();
    const subjects: FocusRef[] = [];

    for (const group of groups) {
        if (group.memberIds.length === 0) continue;
        const present = group.memberIds.filter((id) => selected.has(id));
        if (present.length === 0) continue;

        for (const id of present) claimed.add(id);
        const partial = present.length < group.memberIds.length;
        subjects.push({
            kind: 'squad',
            id: group.groupId,
            label: group.name || `Group ${group.groupId}`,
            unitIds: present,
            data: {
                partial,
                selectedCount: present.length,
                rosterCount: group.memberIds.length,
                tasked: (group.currentDirectiveId ?? 0) !== 0,
            },
        });
    }

    const unclaimed = unitIds.filter((id) => !claimed.has(id));
    const isHostile = opts.isHostile;
    const hostile = isHostile ? unclaimed.filter((id) => isHostile(id)) : [];
    const loose = isHostile ? unclaimed.filter((id) => !isHostile(id)) : unclaimed;

    if (loose.length > 0) {
        subjects.push({
            kind: 'unit',
            // Id-stable across re-resolutions of the same set, so a subscriber
            // comparing keys doesn't see a move that didn't happen.
            id: loose.slice().sort((a, b) => a - b).join(','),
            label: loose.length === 1 ? `Unit ${loose[0]}` : `${loose.length} units`,
            unitIds: loose,
            data: { selectedCount: loose.length },
        });
    }

    if (hostile.length > 0) {
        subjects.push({
            kind: 'enemy-force',
            id: hostile.slice().sort((a, b) => a - b).join(','),
            label: hostile.length === 1 ? 'Enemy unit' : `${hostile.length} enemy units`,
            unitIds: hostile,
            data: { selectedCount: hostile.length, hostile: true },
        });
    }

    return subjects;
}

// ─────────────────────────────── the model ──────────────────────────────

type Listener = (state: FocusState) => void;

/**
 * One focus reference as the natural-language layer sees it: a kind, a name,
 * and — when the thing is somewhere — the NAME of that somewhere.
 *
 * No ids and no coordinates, for the reason `nl-context.ts`'s header gives at
 * length: the envelope that comes back is name-addressed, `nl-resolver.ts` is
 * what turns a name into an id under rules the local path shares, and an id
 * handed to the model is a resolver bypass wearing a helpful face.
 */
export interface FocusBrief {
    kind: FocusKind;
    label: string;
    /** `FocusRef.place` — what "defend IT" binds to. */
    place?: string;
}

/** What `nlFocus()` answers. The whole of story 4's interpretation context. */
export interface NLFocusView {
    /** The pronoun antecedent: `drilled > the single subject > null`. */
    primary: FocusBrief | null;
    subjects: FocusBrief[];
    drilled: FocusBrief | null;
    /**
     * The ref under the pointer right now, if any — a chip being hovered, an
     * objective row the mouse is resting on. Weaker than `primary`: it is
     * what "this one" may mean while the pointer is on it, and nothing once
     * the pointer leaves. Never promoted to `primary` here; an interpreter
     * that wants to prefer it does so explicitly (see lib/focus.js's
     * `primaryOf` for the documented tie-break).
     */
    hovered?: FocusBrief | null;
    openSurfaces: string[];
    selectionCount: number;
}

/**
 * The selection as an ORDER path sees it — ids included, and therefore never
 * shipped anywhere near the model.
 *
 * Separate from `nlFocus()` on purpose. `nlFocus` answers "what may a sentence
 * call this"; this answers "which group would an order actually move", which
 * needs the id and needs to know whether the whole roster is selected. The
 * `partial` flag is the reason it is not just `matchSelectionToGroup`: a
 * player with four of six tanks selected is LOOKING at 3rd Tanks (so rung 1
 * says so) but has not selected 3rd Tanks (so an order must not quietly move
 * the other two).
 */
export interface FocusOrderSubject {
    label: string;
    /** The org-group id, when this subject is a group. Absent ⇒ loose units. */
    groupId?: number;
    /** Some of the group's roster is selected, not all of it. */
    partial: boolean;
    /** How many units this subject covers. Carried so a sentence about it can
     *  agree with it: "9 units ARE not in a squad", "1 unit IS". A refusal
     *  that counts the subjects instead says "is" for all nine — the same
     *  agreement defect U3 fixed in the battle-moment wording. */
    count: number;
}

/** `place`, for a ref that has one either explicitly or by being one. */
function placeNameOf(ref: FocusRef): string | undefined {
    if (ref.place) return ref.place;
    if (ref.kind === 'town' || ref.kind === 'area') return ref.label;
    return undefined;
}

/**
 * The session's focus state.
 *
 * Every mutator collapses to "compute the next state, notify if it differs".
 * Notification is synchronous and deduplicated by shallow comparison, because
 * a drill-down that re-renders on every unchanged selection tick is a
 * per-frame DOM mutation with extra steps (PLAN-native-ui.md forbids those).
 */
export class FocusModel {
    private state: FocusState = EMPTY;
    private listeners = new Set<Listener>();
    /**
     * The hovered ref lives OUTSIDE `FocusState` and has its own listeners.
     * Hover changes on every pointer move across a chip stack; routing them
     * through `commit` would re-render every drilldown on every mouse pass —
     * the per-frame DOM churn PLAN-native-ui.md forbids, arriving by a side
     * door. Surfaces that render from `subscribe` never see a hover; the NL
     * layer reads it through `nlFocus()` at the moment it needs it.
     */
    private hovered: FocusRef | null = null;
    private hoverListeners = new Set<(ref: FocusRef | null) => void>();

    getState(): FocusState {
        return this.state;
    }

    /** Notified on every real change. Returns an unsubscribe. */
    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    // ── hover: the weakest focus ──────────────────────────────────────────

    /** The pointer is on `ref`'s affordance. Replaces any previous hover. */
    hover(ref: FocusRef): void {
        if (this.hovered && focusRefKey(this.hovered) === focusRefKey(ref)) return;
        this.hovered = ref;
        this.notifyHover();
    }

    /**
     * The pointer left `ref` (or, with no argument, left whatever it was on).
     * Scoped by ref so a `mouseleave` from an old chip that fires AFTER the
     * `mouseenter` of its neighbour cannot clear the neighbour's hover.
     */
    unhover(ref?: FocusRef): void {
        if (this.hovered === null) return;
        if (ref && focusRefKey(ref) !== focusRefKey(this.hovered)) return;
        this.hovered = null;
        this.notifyHover();
    }

    getHovered(): FocusRef | null {
        return this.hovered;
    }

    /** Hover-only notifications, kept off the main listener set on purpose. */
    subscribeHover(listener: (ref: FocusRef | null) => void): () => void {
        this.hoverListeners.add(listener);
        return () => { this.hoverListeners.delete(listener); };
    }

    private notifyHover(): void {
        for (const listener of this.hoverListeners) {
            try { listener(this.hovered); } catch (e) {
                console.error('[focus-model] hover subscriber threw:', e);
            }
        }
    }

    /**
     * Replace the world selection and its resolved subjects.
     *
     * A selection change RETRACTS the drill-down: the context panel the player
     * opened describes something they have just stopped looking at, and
     * leaving it up is how a HUD accumulates. The exception is a drilled ref
     * that is still among the new subjects (re-resolution after a roster
     * change), which stays open.
     */
    setSelection(unitIds: readonly number[], subjects: readonly FocusRef[]): void {
        const nextIds = unitIds.slice();
        const nextSubjects = subjects.slice();
        if (
            sameNumbers(this.state.unitIds, nextIds) &&
            sameRefs(this.state.subjects, nextSubjects)
        ) return;

        const drilled = this.state.drilled;
        const keep = drilled !== null && (
            // A place/objective drill-down is not about the selection at all,
            // so a selection change must not close it.
            drilled.kind === 'objective' || drilled.kind === 'area' ||
            drilled.kind === 'town' || drilled.kind === 'ai' ||
            nextSubjects.some((s) => focusRefKey(s) === focusRefKey(drilled))
        );

        this.commit({
            ...this.state,
            unitIds: nextIds,
            subjects: nextSubjects,
            drilled: keep ? drilled : null,
        });
    }

    /** Open the context panel for `ref` (rung 2). Replaces any previous one —
     *  only one context panel exists, by design: two is a dashboard. */
    drill(ref: FocusRef): void {
        if (this.state.drilled && focusRefKey(this.state.drilled) === focusRefKey(ref)) return;
        this.commit({ ...this.state, drilled: ref });
    }

    /** Close the context panel. Idempotent. This is what Esc does at rung 2. */
    collapse(): void {
        if (this.state.drilled === null) return;
        this.commit({ ...this.state, drilled: null });
    }

    /** True while `ref`'s context panel is the open one. */
    isDrilled(ref: FocusRef): boolean {
        return this.state.drilled !== null && focusRefKey(this.state.drilled) === focusRefKey(ref);
    }

    /** Record that a panel/overlay opened. Ids are the ui-action-registry's. */
    openSurface(id: string): void {
        if (this.state.openSurfaces.includes(id)) return;
        this.commit({ ...this.state, openSurfaces: [...this.state.openSurfaces, id] });
    }

    closeSurface(id: string): void {
        if (!this.state.openSurfaces.includes(id)) return;
        this.commit({
            ...this.state,
            openSurfaces: this.state.openSurfaces.filter((s) => s !== id),
        });
    }

    isSurfaceOpen(id: string): boolean {
        return this.state.openSurfaces.includes(id);
    }

    /** Full reset — session teardown, or a game that ended. */
    clear(): void {
        if (this.hovered !== null) { this.hovered = null; this.notifyHover(); }
        if (this.state === EMPTY) return;
        this.commit(EMPTY);
    }

    /**
     * The focus, reduced to what an interpreter needs (story 4).
     *
     * Names and kinds only, no ids and no positions: the NL envelope is
     * name-addressed (see nl-context.ts's header for why shipping ids to a
     * model is a bug, not an optimisation), and this payload has to obey the
     * same rule or it becomes the hole in it.
     *
     * `primary` is the pronoun antecedent: the drilled ref if there is one,
     * else the single subject if there is exactly one. With several subjects
     * there IS no unambiguous "it", and saying so is the honest answer — the
     * clarify path exists for exactly this.
     */
    nlFocus(): NLFocusView {
        const brief = (r: FocusRef): FocusBrief => ({
            kind: r.kind,
            label: r.label,
            // A place name, never a position — see `FocusRef.place`. `town`
            // and `area` refs ARE their place, so they supply it themselves
            // rather than every producer having to remember to set the field
            // to the string it just put in `label`.
            ...(placeNameOf(r) ? { place: placeNameOf(r)! } : {}),
        });
        const drilled = this.state.drilled ? brief(this.state.drilled) : null;
        const subjects = this.state.subjects.map(brief);
        return {
            primary: drilled ?? (subjects.length === 1 ? subjects[0] : null),
            subjects,
            drilled,
            hovered: this.hovered ? brief(this.hovered) : null,
            openSurfaces: [...this.state.openSurfaces],
            selectionCount: this.state.unitIds.length,
        };
    }

    /**
     * What the selection means to an ORDER (ids included — main-thread only).
     *
     * `resolveSelectionSubjects` has already decided what the raw id list
     * means; this only projects it. That matters more than it looks: before
     * story 4 the order path asked `matchSelectionToGroup` and the HUD asked
     * the focus model, and the two agreed only because they implement the same
     * rule twice. One reader of one resolution is how they stay agreed.
     *
     * Loose units come back with no `groupId`: they are a real selection the
     * player can see, and an order path that dropped them would silently
     * answer "nothing is selected" to someone looking at six selected tanks.
     */
    orderSubjects(): FocusOrderSubject[] {
        return this.state.subjects.map((s) => ({
            label: s.label,
            ...(s.kind === 'squad' && typeof s.id === 'number' ? { groupId: s.id } : {}),
            partial: s.data?.partial === true,
            count: s.unitIds?.length
                ?? (typeof s.data?.selectedCount === 'number' ? s.data.selectedCount : 1),
        }));
    }

    /** One line of prose for a transcript echo or a debug readout. */
    describe(): string {
        const { subjects, drilled } = this.state;
        if (drilled) return `${drilled.label} (open)`;
        if (subjects.length === 0) return 'nothing selected';
        if (subjects.length === 1) return subjects[0].label;
        return subjects.map((s) => s.label).join(', ');
    }

    private commit(next: FocusState): void {
        this.state = next;
        for (const listener of this.listeners) {
            try {
                listener(next);
            } catch (e) {
                // One broken subscriber must not stop the others from seeing
                // the focus move — a HUD half-updated to a stale selection is
                // worse than a logged exception.
                console.error('[focus-model] subscriber threw:', e);
            }
        }
    }
}

/** The session's focus. Installed by nothing — it is plain state, and
 *  `bindSelectionToFocus` is what feeds it. */
export const focusModel = new FocusModel();

// ─────────────────────────────── the binding ────────────────────────────

/** The ui-store slice the binding reads. Structural, so `UIStore` satisfies
 *  it and a test can pass three functions. */
export interface FocusStoreLike {
    subscribe(paths: string[], callback: () => void): () => void;
    getSelection(): { unitIds: number[] };
    getOrgGroups(): readonly FocusGroupLike[];
}

/**
 * Keep `model` in step with the store's selection + org-group mirrors.
 *
 * Subscribed to BOTH paths, not just `selection`: a group renamed or
 * re-rostered while its members are selected changes what the selection MEANS,
 * and a focus model that only watched the id list would keep showing the old
 * name until the player clicked elsewhere.
 *
 * Returns an unsubscribe. Does an immediate resolve so a binding installed
 * after the first selection lands is not a frame behind.
 */
export function bindSelectionToFocus(
    store: FocusStoreLike,
    model: FocusModel = focusModel,
    opts: ResolveOptions = {},
): () => void {
    const resolve = () => {
        const ids = store.getSelection().unitIds;
        model.setSelection(ids, resolveSelectionSubjects(ids, store.getOrgGroups(), opts));
    };
    const unsubscribe = store.subscribe(['selection', 'orgGroups'], resolve);
    resolve();
    if (model === focusModel) sessionResolve = resolve;
    return () => {
        unsubscribe();
        if (sessionResolve === resolve) sessionResolve = null;
    };
}

/** The live binding's resolve, so a later data arrival can re-run it. */
let sessionResolve: (() => void) | null = null;

/**
 * Re-resolve the session selection against whatever the resolvers know NOW.
 *
 * The binding re-runs on a selection or roster change and on nothing else,
 * but `isHostile` reads a census snapshot that arrives AFTER the selection it
 * describes (the HUD pulls one on selection change). Without this, a click on
 * enemy tanks resolves to "3 units" a moment before the census can say whose,
 * and stays that way until the player clicks again. `focus-hud.ts` calls it
 * once each census refresh lands. No-op with no session binding.
 */
export function refocusSelection(): void {
    sessionResolve?.();
}

// ──────────────────────────────── helpers ───────────────────────────────

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

/** Refs compare by identity AND by the summary numbers a rung-1 chip renders,
 *  so "same squad, one member fewer" counts as a change worth redrawing. */
function sameRefs(a: readonly FocusRef[], b: readonly FocusRef[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (focusRefKey(a[i]) !== focusRefKey(b[i])) return false;
        if (a[i].label !== b[i].label) return false;
        if ((a[i].unitIds?.length ?? 0) !== (b[i].unitIds?.length ?? 0)) return false;
    }
    return true;
}
