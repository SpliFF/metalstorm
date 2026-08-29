/**
 * nl-interpretation.ts — say back what you understood, before the army moves
 * (DESIGN-DRILLDOWN.md §3, battle-clarity U4)
 *
 * A natural-language order has one failure mode nothing else in this stack
 * has: it can be understood as a DIFFERENT, entirely valid order. A misspelled
 * place refuses and a missing verb refuses, but "pull them back" pointed at the
 * wrong squad executes perfectly and loses the line. The player is the only one
 * who can catch that, and they can only catch it if they are shown the reading
 * before it happens.
 *
 * So every sentence that moves something is echoed as the interpretation it
 * actually resolved to — **names, not the words that were typed**:
 *
 *     you:  attack that town
 *     game: 3rd Tanks attacking Storm Sound        ← this module
 *
 * "that town" never appears. If the echo says Storm Sound and the player meant
 * Amber Row, the mistake is on screen with a Cancel next to it.
 *
 * ── Where the echo is shown, and why it is not always a question ──
 *
 * The text is handed to the executor as the envelope's `say`, which the
 * executor already defers until something actually succeeds — so an
 * interpretation is never printed for an order that then refused, and the
 * "standing order set" / "which West Scarp did you mean?" inversion that
 * deferral was written for cannot come back through this door either.
 *
 * When the reading DEPENDED on the focus — a pronoun was bound by
 * `nl-focus.ts` — the console shows it first, with `Do it` / `Cancel`, and
 * nothing is sent until the player taps. That gate is deliberately not on every
 * sentence: an order that names its own subject and target has already been
 * confirmed by being typed, and a confirmation step on all of them is a click
 * tax on the common case (and would make voice a two-step interaction, which
 * is the opposite of the point). The gate sits exactly where this step ADDS
 * ambiguity, which is where the pronoun is.
 *
 * ── Why resolution happens twice ──
 *
 * The echo resolves the same names the executor will resolve, moments earlier,
 * through the SAME resolver instance. That is a real duplication and it buys
 * the only property that matters here: the echo names what will actually be
 * ordered, not what was written. "attack storm" echoes "Storm Sound" because
 * that is what the fuzzy match found — and if it found the wrong thing, that is
 * precisely the sentence the player needs to see. Resolution is pure lookups
 * over in-memory indexes; nothing here sends, spends or mutates.
 */

import type { NLResolver } from './nl-resolver.js';
import type { FocusBinding } from './nl-focus.js';
import type {
    NLAction, NLCommandIntent, NLResponse, NLSubject, NLTarget, NLWhen,
} from './nl-envelope.js';
import type { CommandVerb } from './compile-table.js';

/** The reading of one sentence, ready to be shown or confirmed. */
export interface InterpretationPlan {
    /** "3rd Tanks attacking Storm Sound · high priority". */
    text: string;
    /** Actions that spend authority or move an army — the ones worth a gate. */
    commits: boolean;
    /** The focus bindings this reading depended on. Empty ⇒ nothing in the
     *  sentence was a pronoun, and the reading is just the sentence. */
    bindings: readonly FocusBinding[];
    /** Show it as a question with `Do it` / `Cancel` before executing. */
    needsConfirm: boolean;
}

export interface InterpretDeps {
    /** The resolver the executor will use. Names are resolved through it so the
     *  echo says what will happen, not what was typed. */
    resolver?: NLResolver;
    /** Group id → display name, for a subject that resolved to an id. */
    groupLabel?: (groupId: number) => string;
    /** What `bindFocusReferences` substituted, if anything. */
    bindings?: readonly FocusBinding[];
}

/**
 * Build the reading, or null when there is nothing worth echoing.
 *
 * Null for a pure question, a pure refusal, or an envelope of camera / panel /
 * query actions: those speak for themselves through the executor's own lines
 * ("camera on Slag Forge", "You have 4 tanks"), and a second sentence saying
 * the same thing in different words is the clutter this whole lane is against.
 */
export function interpret(
    response: NLResponse, deps: InterpretDeps = {},
): InterpretationPlan | null {
    const bindings = deps.bindings ?? [];
    if (response.clarify) return null;

    const parts: string[] = [];
    let commits = false;

    for (const action of response.actions) {
        const phrase = describe(action, deps);
        if (!phrase) continue;
        parts.push(phrase);
        if (action.kind === 'command' || action.kind === 'guidance') commits = true;
    }

    if (parts.length === 0) return null;

    return {
        text: parts.join('; '),
        commits,
        bindings,
        // A pronoun that only steered the camera is not worth a gate: framing
        // the wrong hill costs a keystroke, which is the same trade
        // `camera-port.ts` documents for non-strict camera resolution.
        needsConfirm: commits && bindings.some((b) => b.slot !== 'camera-target'),
    };
}

// ───────────────────────────── one action ─────────────────────────────

function describe(action: NLAction, deps: InterpretDeps): string | null {
    switch (action.kind) {
        case 'command': return describeCommand(action.intent, deps);
        case 'guidance': return null;   // the guidance codec writes its own line
        case 'camera': case 'ui': case 'query': case 'group': case 'refuse':
            return null;
    }
}

function describeCommand(intent: NLCommandIntent, deps: InterpretDeps): string | null {
    const subject = describeSubject(intent.subject, deps);
    const place = intent.target ? describeTarget(intent.verb, intent.target, deps) : null;
    if (!place) return null;

    const { participle, preposition } = VERB_PHRASING[intent.verb]
        ?? { participle: `${intent.verb}ing`, preposition: '' };
    const where = preposition ? `${preposition} ${place}` : place;

    const tail: string[] = [];
    if (intent.priority && intent.priority !== 'normal') tail.push(`${intent.priority} priority`);
    const when = intent.when ? describeWhen(intent.when) : null;
    if (when) tail.push(when);

    return `${subject} ${participle} ${where}${tail.length ? ` · ${tail.join(' · ')}` : ''}`;
}

/**
 * Present participle + the preposition the verb wants, so the echo reads as
 * one English sentence rather than as a form with the slots filled in.
 *
 * Keyed off `CommandVerb`, which is `compile-table.ts`'s closed list — a verb
 * added there and not here still echoes (the "+ing" fallback), so this table
 * can never be the reason an order stops working.
 */
const VERB_PHRASING: Partial<Record<CommandVerb, { participle: string; preposition: string }>> = {
    attack:    { participle: 'attacking',    preposition: '' },
    secure:    { participle: 'securing',     preposition: '' },
    defend:    { participle: 'defending',    preposition: '' },
    hold:      { participle: 'holding',      preposition: '' },
    patrol:    { participle: 'patrolling',   preposition: '' },
    screen:    { participle: 'screening',    preposition: '' },
    scout:     { participle: 'scouting',     preposition: '' },
    escort:    { participle: 'escorting',    preposition: 'to' },
    withdraw:  { participle: 'pulling back', preposition: 'to' },
    reinforce: { participle: 'reinforcing',  preposition: '' },
    build:     { participle: 'building',     preposition: 'at' },
};

/**
 * Who, by name.
 *
 * `class-count` is deliberately NOT resolved to squad names here. The executor
 * ranks those candidates against the TARGET's position, and re-running the
 * ranking from this side without that position can pick different squads — an
 * echo naming Chimera while Basilisk gets the order is worse than no echo at
 * all. The player's own phrase is honest, and the executor prints one line per
 * squad it actually tasked immediately below.
 */
function describeSubject(subject: NLSubject, deps: InterpretDeps): string {
    switch (subject.type) {
        case 'selection': {
            const bound = deps.bindings?.find((b) => b.slot === 'subject');
            return bound?.label ?? 'Your selection';
        }
        case 'any': return 'Whoever is free';
        case 'ai': return 'The AI commander';
        case 'idle-filter': return `Idle ${subject.filterClass}`;
        case 'class-count':
            // The resolver owns the phrasing (`ms_class` keys are already
            // plural — "2 tankss" is what naive pluralisation gets you here,
            // and U3 fixed the same defect in the battle-moment wording).
            return deps.resolver?.classCountLabel(subject) ?? subject.class;
        case 'entity-ref': {
            const resolved = deps.resolver?.resolveGroupId(subject.name);
            if (resolved?.kind === 'ok' && deps.groupLabel) return deps.groupLabel(resolved.value);
            return subject.name;
        }
    }
}

/** Where, by the name the resolver actually landed on. */
function describeTarget(
    verb: CommandVerb, target: NLTarget, deps: InterpretDeps,
): string | null {
    if (target.type === 'point') return null;   // a coordinate is not a reading

    const resolved = deps.resolver?.resolveTarget(verb, target);
    if (resolved?.kind === 'ok' && resolved.value.entity?.name) {
        return resolved.value.entity.name;
    }
    // Unresolved: quote the phrase rather than assert a name. This echo is only
    // ever PRINTED after something succeeded, so in practice the executor has
    // already turned this into a question or a refusal by the time it matters.
    return `"${target.name}"`;
}

function describeWhen(when: NLWhen): string | null {
    switch (when.type) {
        case 'now': return null;
        case 'under-attack': return 'if attacked';
        case 'region-contested': return `when ${when.regionRef} is contested`;
        case 'objective-complete': return `once ${when.objectiveRef} is done`;
        case 'strength-below': return `below ${when.percent}% strength`;
    }
}
