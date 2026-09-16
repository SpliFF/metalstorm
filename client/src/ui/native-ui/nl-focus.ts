/**
 * nl-focus.ts — the focus is the interpretation context
 * (DESIGN-DRILLDOWN.md §3 "How story 4 reads it", battle-clarity U4)
 *
 * "Attack that town." "Pull them back." "Defend it."
 *
 * None of those sentences name anything. Every one of them is what a player
 * actually says, and each is only an order because the player is LOOKING at
 * something when they say it — a selection, an open context panel. That is
 * what `focus-model.ts` holds, and this module is the seam between it and the
 * command language:
 *
 *   `focusContextFor` — the focus as the model sees it, for the §2 payload.
 *   `bindFocusReferences` — deictic phrases in an envelope, resolved to names.
 *
 * ── Why the binding is here and not in the prompt ──
 *
 * With `focus` in the context payload the model can and should write the real
 * name itself ("Storm Sound", not "it"), and it usually will. This module is
 * what makes the same sentences work with the proxy disabled, down or rate-
 * limited — the offline slot-filler has no idea what a pronoun is — and it is
 * the backstop for a model that echoes the player's word anyway. Both paths
 * therefore bind by the SAME rules, which is the standing rule in this stack
 * (`nl-client.ts`'s header: two resolution policies for two producers is how
 * "moves the wrong army" ships).
 *
 * ── The three rules, and why each refuses rather than guesses ──
 *
 * 1. **A subject pronoun means the SELECTION.** "Pull them back" is about what
 *    is selected, and `{type:'selection'}` is the envelope's word for that —
 *    which then goes through the resolver's own selection rules, including the
 *    partial-roster refusal. With nothing selected but a squad drilled, the
 *    drilled squad is the antecedent: the player is looking straight at it.
 *
 * 2. **A target pronoun means a PLACE, and only a place.** "Defend it" with
 *    3rd Tanks selected has no honest reading — a squad is not somewhere you
 *    can defend — so it refuses BY NAME ("'it' is 3rd Tanks, which isn't a
 *    place") instead of aiming at wherever that squad happens to be standing.
 *    A target binds to a `FocusBrief.place`, which is a name the entity index
 *    holds, never to a chip's title.
 *
 * 3. **No antecedent is a refusal, not a default.** `focusModel.nlFocus()`
 *    answers `primary: null` when several things are selected, deliberately;
 *    picking one here would be the same guess one rung further down. The
 *    refusal says what to do instead.
 *
 * Nothing in this file resolves a name to an id, reads a store, or touches the
 * DOM: it rewrites one validated envelope into another and reports what it
 * changed. `nl-interpretation.ts` turns that report into the sentence the
 * player confirms.
 */

import type { FocusBrief, FocusKind, NLFocusView } from './focus-model.js';
import type { NLAction, NLResponse, NLSubject, NLTarget } from './nl-envelope.js';

// ─────────────────────────── the focus CONTRACT ────────────────────────────
//
// What the NL layer needs from whoever owns the focus (today `focus-model.ts`;
// the HUD lane is adding `lib/focus.js` with a `getFocus()`). Everything below
// is NAMES — no ids, no coordinates — for the reason `nl-context.ts` gives:
// the envelope that comes back is name-addressed, and an id shipped to the
// model is a resolver bypass. A producer that cannot supply a field omits it;
// nothing here is required beyond `subjects`/`selectionCount`.

/**
 * What kind of thing a focus reference names. `focus-model.ts`'s kinds plus
 * the ones a drill-down can open that the model has no rung for yet:
 *
 *   proposal   an open parley proposal (label = its title, `target` = the
 *              counterparty's name, `place` = the region it is about if any)
 *   region     a region panel (`place` = the region's name)
 *   transport  a transport / arrival (label = the carrier, `place` = where)
 *   civilian   a civilian group or convoy
 *
 * Unknown kinds from a newer producer are carried through as-is: the binder
 * only ever reads `place`/`label`, and a kind it does not know binds like a
 * bare `unit` (no place ⇒ a target pronoun refuses by name).
 */
export type NLFocusKind = FocusKind | 'proposal' | 'region' | 'transport' | 'civilian' | (string & {});

/** One thing the player is looking at, as the NL layer sees it. */
export interface NLFocusBrief {
    kind: NLFocusKind;
    /** What the player is shown and what a sentence may call this. */
    label: string;
    /** The NAME of the place this is at — what "defend IT" binds to. Must be a
     *  name the entity index holds (a region/city/landmark/objective-place),
     *  never a chip title. */
    place?: string;
    /** A second name this thing is ABOUT: a proposal's counterparty, an
     *  objective's enemy force. Bound by "attack them" when a proposal is
     *  open, so it must be a name the index holds (an enemy-force). */
    target?: string;
}

/** The question the console is currently showing, when there is one. */
export interface NLFocusAsked {
    question: string;
    options: string[];
}

/**
 * The whole focus, as the NL layer consumes it. Structurally a superset of
 * `focus-model.ts`'s `NLFocusView`, so that view satisfies it unchanged; a
 * `lib/focus.js`-shaped producer goes through `focusViewFrom` instead.
 */
export interface NLFocusSnapshot {
    /** The pronoun antecedent: `drilled > the single subject > null`. */
    primary: NLFocusBrief | null;
    /** What the world selection resolves to, in selection order. */
    subjects: NLFocusBrief[];
    /** The ONE open context panel. */
    drilled: NLFocusBrief | null;
    /** Ids of open panels/overlays (ui-action-registry ids). */
    openSurfaces: string[];
    /** Raw selected-unit count. */
    selectionCount: number;
    /** The named place the camera is over, when the producer knows one. Not a
     *  pronoun antecedent (looking at a hill is not pointing at it) — it is
     *  context for the model and for "what's happening here". */
    cameraPlace?: string;
    /** The clarification the console is showing, so a typed answer can be
     *  read as one (the model sees it; the fast path stands aside for it). */
    asked?: NLFocusAsked | null;
}

/**
 * Feature-detect a focus producer and normalise it.
 *
 * Accepts, in order: a `FocusModel` (has `nlFocus()`), a `lib/focus.js`-style
 * store (has `getFocus()`), an already-shaped snapshot, or the WIRE shape
 * (`NLContextFocus` — `surfaces`/`selected` rather than
 * `openSurfaces`/`selectionCount`), which is what a fixture board carries.
 * Anything else ⇒ null, which the binder treats as an empty focus.
 *
 * This is the ONLY place the NL layer looks at a focus store's shape. It does
 * not create a store of its own: the focus is the HUD's, and two stores that
 * disagree about what is selected is how the wrong army moves.
 */
export function focusViewFrom(input: unknown): NLFocusSnapshot | null {
    if (!input || typeof input !== 'object') return null;
    const o = input as Record<string, unknown>;
    if (typeof o.nlFocus === 'function') return focusViewFrom((o.nlFocus as () => unknown)());
    if (typeof o.getFocus === 'function') return focusViewFrom((o.getFocus as () => unknown)());

    const brief = (v: unknown): NLFocusBrief | null => {
        if (!v || typeof v !== 'object') return null;
        const b = v as Record<string, unknown>;
        if (typeof b.label !== 'string' || typeof b.kind !== 'string') return null;
        return {
            kind: b.kind,
            label: b.label,
            ...(typeof b.place === 'string' && b.place ? { place: b.place } : {}),
            ...(typeof b.target === 'string' && b.target ? { target: b.target } : {}),
        };
    };
    const briefs = (v: unknown): NLFocusBrief[] =>
        Array.isArray(v) ? v.map(brief).filter((b): b is NLFocusBrief => b !== null) : [];
    const strings = (v: unknown): string[] =>
        Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

    const subjects = briefs(o.subjects);
    const drilled = brief(o.drilled);
    const primary = brief(o.primary) ?? drilled ?? (subjects.length === 1 ? subjects[0] : null);
    const surfaces = strings(o.openSurfaces ?? o.surfaces);
    const count = typeof o.selectionCount === 'number' ? o.selectionCount
        : typeof o.selected === 'number' ? o.selected
        : subjects.length > 0 ? 1 : 0;
    const camera = o.camera && typeof o.camera === 'object'
        ? (o.camera as Record<string, unknown>).place
        : o.cameraPlace;
    const askedRaw = o.asked && typeof o.asked === 'object' ? o.asked as Record<string, unknown> : null;
    const asked: NLFocusAsked | null = askedRaw && typeof askedRaw.question === 'string'
        ? { question: askedRaw.question, options: strings(askedRaw.options) }
        : null;

    return {
        primary, subjects, drilled,
        openSurfaces: surfaces,
        selectionCount: count,
        ...(typeof camera === 'string' && camera ? { cameraPlace: camera } : {}),
        ...(asked ? { asked } : {}),
    };
}

// ──────────────────────────── the context field ────────────────────────────

/** `NLContext.focus` — kinds, labels and place names. See `NLFocusBrief`. */
export interface NLContextFocus {
    /** The pronoun antecedent, or absent when there is genuinely no single
     *  one. Absent is a real answer and the prompt is told to treat it as one. */
    primary?: NLFocusBrief;
    /** Everything the world selection resolves to, in selection order. */
    subjects: NLFocusBrief[];
    /** The one open context panel, when there is one. */
    drilled?: NLFocusBrief;
    /** Ids of open panels/overlays, so "close that" has something to bind to. */
    surfaces: string[];
    /** Raw selected-unit count. 0 ⇒ a `selection` subject is a mistake, and
     *  the model can see that before making one. */
    selected: number;
    /** The named place under the camera, when known (contract v2). */
    camera?: { place: string };
    /** The question currently on screen, when one is (contract v2). */
    asked?: NLFocusAsked;
}

/**
 * Project a focus snapshot into the wire shape.
 *
 * Sorted? No — `subjects` is in selection order and that order is meaningful
 * ("the first one"). `surfaces` IS sorted, because it is a set with no natural
 * order and an unstable one would make two identical boards produce different
 * payloads, which is the determinism property `nl-context.ts` depends on.
 */
export function focusContextFor(view: NLFocusView | NLFocusSnapshot): NLContextFocus {
    const snap = view as NLFocusSnapshot;
    return {
        ...(snap.primary ? { primary: snap.primary } : {}),
        subjects: snap.subjects,
        ...(snap.drilled ? { drilled: snap.drilled } : {}),
        surfaces: [...snap.openSurfaces].sort(),
        selected: snap.selectionCount,
        ...(snap.cameraPlace ? { camera: { place: snap.cameraPlace } } : {}),
        ...(snap.asked ? { asked: { question: snap.asked.question, options: [...snap.asked.options] } } : {}),
    };
}

/** The wire shape back into a snapshot — what a fixture board or a replayed
 *  eval payload hands the offline path. */
export function focusViewFromContext(focus: NLContextFocus | undefined | null): NLFocusSnapshot | null {
    return focus ? focusViewFrom(focus) : null;
}

// ─────────────────────────────── the phrases ───────────────────────────────

/**
 * Phrases that mean "whoever I am pointing at".
 *
 * A closed list, matched whole (after case-folding and trimming), never as a
 * substring: a group genuinely called "Them" is a group, and `startsWith`
 * matching would eat "this ridge" as a subject pronoun. Everything here is a
 * phrase a player says INSTEAD of a name; nothing here is a word that can also
 * begin one.
 */
export const SUBJECT_DEICTICS: readonly string[] = [
    'it', 'them', 'they', 'these', 'those', 'this', 'that', 'us', 'we',
    'this one', 'that one', 'this lot',
    'my units', 'my squad', 'my squads', 'my group', 'my forces', 'my army',
    'this squad', 'that squad', 'these squads', 'those squads',
    'this group', 'that group', 'this unit', 'that unit', 'these units',
    'those units', 'this force', 'that force',
    'the selection', 'the selected units', 'the selected', 'selected units',
    'the current selection', 'everyone selected',
];

/**
 * Phrases that mean "where I am pointing".
 *
 * `it` and `that` appear in both lists; which one applies is decided by the
 * SLOT the phrase sits in, not by the word. That is the whole reason binding
 * happens on the envelope rather than on the sentence — by the time an action
 * exists, "defend it" has already been split into a verb and a target, and
 * there is nothing left to disambiguate.
 */
export const TARGET_DEICTICS: readonly string[] = [
    'it', 'there', 'here', 'this', 'that',
    'this place', 'that place', 'the place',
    'this town', 'that town', 'the town',
    'this city', 'that city', 'this region', 'that region', 'the region',
    'this area', 'that area', 'the area', 'this zone', 'that zone',
    'this objective', 'that objective', 'the objective', 'the mission',
    'this position', 'that position', 'this spot', 'that spot',
    'over there', 'right there', 'back there',
];

const SUBJECT_SET = new Set(SUBJECT_DEICTICS);
const TARGET_SET = new Set(TARGET_DEICTICS);

/** Case-folded, whitespace-collapsed, trailing punctuation dropped. */
function normalise(phrase: string): string {
    return phrase.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:]+$/, '');
}

export function isSubjectDeictic(phrase: string): boolean {
    return SUBJECT_SET.has(normalise(phrase));
}

export function isTargetDeictic(phrase: string): boolean {
    return TARGET_SET.has(normalise(phrase));
}

/**
 * The deictic phrase inside a whole sentence, longest first, or null.
 *
 * This is the OFFLINE half. The slot-filler has no grammar and no pronouns: it
 * matches names against the entity index and drops everything else into
 * `unmatched`, so "attack that town" arrives as a verb, no target and two
 * leftover words. Finding the phrase here is what lets `nl-client.ts` build the
 * deictic envelope that `bindFocusReferences` then binds — the model path
 * produces the same envelope by writing the pronoun itself, so ONE binder
 * serves both.
 *
 * Word-boundary matched, longest phrase first: "that town" must not be found
 * as "that", or the binding would point at the drilled objective when the
 * player said the name of a town.
 */
export function findTargetDeictic(utterance: string): string | null {
    return findDeictic(utterance, TARGET_DEICTICS);
}

export function findSubjectDeictic(utterance: string): string | null {
    return findDeictic(utterance, SUBJECT_DEICTICS);
}

function findDeictic(utterance: string, phrases: readonly string[]): string | null {
    const text = ` ${normalise(utterance)} `;
    let best: string | null = null;
    for (const phrase of phrases) {
        if (best !== null && phrase.length <= best.length) continue;
        if (text.includes(` ${phrase} `)) best = phrase;
    }
    return best;
}

// ─────────────────────────────── the binding ───────────────────────────────

/** Which slot of which action a phrase was bound in. */
export type FocusSlot = 'subject' | 'target' | 'camera-target';

export interface FocusBinding {
    /** Index into `response.actions`. */
    actionIndex: number;
    slot: FocusSlot;
    /** What the player (or the model) actually wrote. */
    phrase: string;
    /** What it now means — a name, or "your selection" for a `selection`
     *  subject that the resolver still has to narrow. */
    label: string;
    /** Which part of the focus supplied it. `drilled` is the open context
     *  panel, `selection` is the world selection. */
    source: 'drilled' | 'selection';
    /** True when the sentence had NO word in this slot at all and the focus
     *  filled it ("attack" with an objective open). Elision is a stronger
     *  claim than a pronoun, and the echo says so. */
    elided?: true;
}

export interface FocusBindResult {
    /** The envelope with every bindable deictic replaced, and every unbindable
     *  one replaced by a `refuse` action naming why. */
    response: NLResponse;
    /** Every substitution made, in action order. Empty ⇒ nothing in this
     *  sentence depended on the focus, and no confirmation is owed. */
    bindings: FocusBinding[];
}

/**
 * Resolve every deictic reference in a VALIDATED envelope against the focus.
 *
 * A no-op — same object identity, empty `bindings` — when the sentence names
 * everything it means, which is the common case and must cost nothing.
 *
 * `focus` absent (a headless harness, a fixture run, a session before the HUD
 * is up) is treated as an empty focus rather than as "skip binding": a pronoun
 * with nothing to point at is a refusal in both cases, and silently letting
 * "it" through to the resolver would produce "I don't know a place called
 * 'it'", which tells the player nothing about what went wrong.
 */
export function bindFocusReferences(
    response: NLResponse,
    focus?: NLFocusView | NLFocusSnapshot | null,
): FocusBindResult {
    const view: NLFocusSnapshot = focus ?? EMPTY_VIEW;
    const bindings: FocusBinding[] = [];
    let changed = false;

    const actions = response.actions.map((action, index): NLAction => {
        const bound = bindAction(action, index, view, bindings);
        if (bound !== action) changed = true;
        return bound;
    });

    if (!changed) return { response, bindings: [] };
    return { response: { ...response, actions }, bindings };
}

const EMPTY_VIEW: NLFocusSnapshot = {
    primary: null, subjects: [], drilled: null, openSurfaces: [], selectionCount: 0,
};

/**
 * Verbs whose missing target the DRILLED panel may supply (contract v2).
 *
 * "attack" with an objective open is an attack on that objective's place;
 * "defend" with a town open is that town. `withdraw` is deliberately absent:
 * its elided target is the nearest departure zone (the resolver's rule), and
 * an open objective must not turn "pull back" into "pull back INTO the
 * objective". `escort` is absent too — the drilled thing is what would be
 * escorted, not where to.
 */
const TARGET_ELISION_VERBS: ReadonlySet<string> = new Set([
    'attack', 'secure', 'defend', 'hold', 'patrol', 'screen', 'scout', 'reinforce', 'build',
]);

function bindAction(
    action: NLAction, index: number, view: NLFocusSnapshot, out: FocusBinding[],
): NLAction {
    if (action.kind === 'command') {
        const subject = bindSubject(action.intent.subject, index, view, out);
        if (subject.kind === 'refuse') return subject.action;

        let target = action.intent.target
            ? bindTarget(action.intent.target, index, 'target', view, out)
            : null;
        if (target && target.kind === 'refuse') return target.action;

        // Elision: no target at all, and the player has a place open. Only
        // the drilled panel counts — a selection is who acts, not where — and
        // only for the verbs above. Absent both, the sentence goes through
        // unchanged and the resolver refuses it by name.
        if (!target && !action.intent.target
            && TARGET_ELISION_VERBS.has(action.intent.verb)
            && view.drilled?.place) {
            out.push({
                actionIndex: index, slot: 'target', phrase: '',
                label: view.drilled.place, source: 'drilled', elided: true,
            });
            target = { kind: 'ok', value: { type: 'entity-ref', name: view.drilled.place } };
        }

        if (subject.value === action.intent.subject
            && (!target || target.value === action.intent.target)) return action;

        return {
            kind: 'command',
            intent: {
                ...action.intent,
                subject: subject.value,
                ...(target ? { target: target.value } : {}),
            },
        };
    }

    // "what's happening there" — a place pronoun in a query, bound by the
    // target rule so it means the same place an order's "there" would.
    if (action.kind === 'query' && action.query.op === 'events' && action.query.near !== undefined) {
        const bound = bindTarget(
            { type: 'entity-ref', name: action.query.near }, index, 'target', view, out);
        if (bound.kind === 'refuse') return bound.action;
        if (bound.kind === 'unchanged') return action;
        const name = bound.value.type === 'entity-ref' ? bound.value.name : null;
        if (!name) return action;
        return { kind: 'query', query: { op: 'events', near: name } };
    }

    // The camera is the other place a pronoun lands: "show me that" after
    // clicking an objective. Bound by the same rule as an order's target — the
    // camera goes to a PLACE — so the two can never disagree about what "that"
    // meant in the same breath.
    if (action.kind === 'camera'
        && (action.camera.op === 'focus' || action.camera.op === 'follow')) {
        // `follow` is the exception inside the exception: it follows a FORCE,
        // so its pronoun is a subject pronoun and its antecedent is a squad.
        const bound = action.camera.op === 'follow'
            ? bindFollowTarget(action.camera.targetRef, index, view, out)
            : bindTarget(
                { type: 'entity-ref', name: action.camera.targetRef },
                index, 'camera-target', view, out);
        if (bound.kind === 'refuse') return bound.action;
        if (bound.kind === 'unchanged') return action;
        const name = bound.value.type === 'entity-ref' ? bound.value.name : null;
        if (!name) return action;
        return { kind: 'camera', camera: { op: action.camera.op, targetRef: name } };
    }

    return action;
}

type Bound<T> =
    | { kind: 'ok'; value: T }
    | { kind: 'unchanged'; value: T }
    | { kind: 'refuse'; action: NLAction };

function refuseAction(reason: string): { kind: 'refuse'; action: NLAction } {
    return { kind: 'refuse', action: { kind: 'refuse', reason } };
}

/**
 * A subject pronoun → the selection, or the drilled squad, or a refusal.
 *
 * `{type:'selection'}` rather than the group's NAME even when there is exactly
 * one subject, deliberately: the resolver's selection case knows about partial
 * rosters and about several groups being selected at once, and substituting a
 * name here would route around all of it. This module decides WHAT was pointed
 * at; the resolver decides whether that is orderable.
 */
function bindSubject(
    subject: NLSubject, index: number, view: NLFocusSnapshot, out: FocusBinding[],
): Bound<NLSubject> {
    if (subject.type !== 'entity-ref' || !isSubjectDeictic(subject.name)) {
        return { kind: 'unchanged', value: subject };
    }

    if (view.selectionCount > 0) {
        out.push({
            actionIndex: index, slot: 'subject', phrase: subject.name,
            label: subjectLabel(view), source: 'selection',
        });
        return { kind: 'ok', value: { type: 'selection' } };
    }

    if (view.drilled?.kind === 'squad') {
        out.push({
            actionIndex: index, slot: 'subject', phrase: subject.name,
            label: view.drilled.label, source: 'drilled',
        });
        return { kind: 'ok', value: { type: 'entity-ref', name: view.drilled.label } };
    }

    return refuseAction(
        `"${subject.name}" has nothing to point at — select the units you mean, or name them.`);
}

/** How the echo says a `selection` subject before the resolver narrows it. */
function subjectLabel(view: NLFocusSnapshot): string {
    if (view.subjects.length === 1) return view.subjects[0].label;
    if (view.subjects.length > 1) return view.subjects.map((s) => s.label).join(' and ');
    return 'your selection';
}

/**
 * A target pronoun → a place NAME, or a refusal that names the mismatch.
 *
 * Priority is `drilled > exactly one place-like subject`. The drilled ref wins
 * for the same reason it wins in `nlFocus().primary`: a context panel is open
 * because the player opened it, and they are reading it as they speak.
 */
function bindTarget(
    target: NLTarget, index: number, slot: FocusSlot,
    view: NLFocusSnapshot, out: FocusBinding[],
): Bound<NLTarget> {
    if (target.type === 'point') return { kind: 'unchanged', value: target };
    if (!isTargetDeictic(target.name)) return { kind: 'unchanged', value: target };

    const drilled = view.drilled;
    if (drilled?.place) {
        out.push({
            actionIndex: index, slot, phrase: target.name,
            label: drilled.place, source: 'drilled',
        });
        return { kind: 'ok', value: { ...target, name: drilled.place } };
    }

    const placed = view.subjects.filter((s) => !!s.place);
    if (placed.length === 1) {
        out.push({
            actionIndex: index, slot, phrase: target.name,
            label: placed[0].place!, source: 'selection',
        });
        return { kind: 'ok', value: { ...target, name: placed[0].place! } };
    }
    if (placed.length > 1) {
        return refuseAction(
            `"${target.name}" could be ${placed.map((p) => p.place).join(' or ')} — ` +
            `say which one.`);
    }

    // The honest half of rule 2: there IS an antecedent, it is just not a
    // place. Naming it is the difference between a player fixing the sentence
    // and a player wondering why the game is broken.
    const antecedent = drilled ?? view.primary ?? view.subjects[0] ?? null;
    if (antecedent) {
        return refuseAction(
            `"${target.name}" is ${antecedent.label}, which isn't a place — name where.`);
    }
    return refuseAction(
        `"${target.name}" has nothing to point at — open or select the place you mean, ` +
        `or name it.`);
}

/** "follow it" — a force, not a place. Same antecedent rule as a subject. */
function bindFollowTarget(
    ref: string, index: number, view: NLFocusSnapshot, out: FocusBinding[],
): Bound<NLTarget> {
    if (!isSubjectDeictic(ref) && !isTargetDeictic(ref)) {
        return { kind: 'unchanged', value: { type: 'entity-ref', name: ref } };
    }
    const squad = view.drilled?.kind === 'squad'
        ? view.drilled
        : view.subjects.find((s) => s.kind === 'squad' || s.kind === 'enemy-force');
    if (!squad) {
        return refuseAction(`"${ref}" has nothing to follow — select or name a force.`);
    }
    out.push({
        actionIndex: index, slot: 'camera-target', phrase: ref,
        label: squad.label,
        source: view.drilled?.kind === 'squad' ? 'drilled' : 'selection',
    });
    return { kind: 'ok', value: { type: 'entity-ref', name: squad.label } };
}
