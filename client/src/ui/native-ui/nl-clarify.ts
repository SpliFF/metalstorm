/**
 * nl-clarify.ts — what happens when the player taps a chip
 * (PLAN-metalstorm-command-language.md §4 / §5, milestone M5)
 *
 * A clarification has two possible answers, and which one it gets depends on
 * WHO asked:
 *
 *  - **The resolver asked.** The question came out of a well-formed envelope
 *    the client already holds ("which of your four idle tank squads?"), and the
 *    chosen option is a name that goes straight back into it. `answerLocally`
 *    patches the envelope and the console re-runs it. No round trip, no tokens,
 *    no second chance to misread the sentence — and it works with the proxy
 *    disabled, which is what makes the whole chip flow usable offline.
 *  - **The model asked.** There is no local envelope to patch: the question is
 *    about what the sentence MEANT, and only the thing that read the sentence
 *    can act on the answer. `resubmissionText` builds the follow-up utterance,
 *    which the console sends back with `history` so the model sees its own
 *    question (§3, ≤2 exchanges).
 *
 * Everything here is pure: envelope in, envelope out, no ports, no DOM, no
 * fetch. The console owns the chips; this owns what a chip MEANS. That split is
 * why a widget with no test environment (no jsdom — see command-console.test.ts)
 * still leaves the interesting half covered.
 */

import { MAX_ACTIONS, type NLAction, type NLResponse, type NLSubject } from './nl-envelope.js';
import { CANCEL_OPTION } from './nl-resolver.js';
import type { ClarifyContext } from './nl-executor.js';

export { CANCEL_OPTION };

/** A question the console is currently showing, with everything needed to
 *  answer it either way. */
export interface PendingClarification {
    /** The sentence that raised it, verbatim — the resubmission's first half. */
    utterance: string;
    /** The envelope that was executing when it stopped. Absent for a question
     *  the model asked (there was no envelope, only a `clarify`). */
    response?: NLResponse;
    /** Which action and field the question came from, when the executor raised
     *  it. Absent ⇒ the model asked. */
    context?: ClarifyContext;
    options: string[];
    /** How many options the answer takes. */
    pick: number;
}

/** Is this the "never mind" chip? Matched case-insensitively because it is
 *  also a word a player can type. */
export function isCancel(option: string): boolean {
    return option.trim().toLowerCase() === CANCEL_OPTION;
}

/**
 * The follow-up sentence a chip tap sends back to the model.
 *
 * `"<original utterance>. <chosen option>"` — the shape the plan specifies. The
 * original is repeated rather than replaced because the answer alone ("Chimera
 * Squad") is not an order, and a model that only saw the answer would have to
 * reconstruct the verb from `history`, which is advisory context rather than
 * something it is obliged to read.
 *
 * Several picks join with "and", which is the sentence a player would say and
 * which the prompt's multi-subject rule turns into one action per squad.
 */
export function resubmissionText(utterance: string, chosen: readonly string[]): string {
    const answer = joinAnd(chosen);
    const stem = utterance.trim().replace(/[.!?]+$/, '');
    return `${stem}. ${answer}`;
}

function joinAnd(parts: readonly string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Put the chosen name(s) back into the stopped envelope.
 *
 * Returns null when the answer cannot be expressed locally — a non-patchable
 * question, a pick count the slot has no room for, an action index that no
 * longer exists. Null is not a failure: it means "ask the model", and the
 * console falls through to `resubmissionText`. Guessing a patch we are not sure
 * about would produce an order the player never confirmed, which is the one
 * outcome this whole layer exists to prevent.
 *
 * The returned envelope carries no `say`: the original acknowledgement was
 * written for the question that is now answered ("Moving 2 tank squads to
 * Randtown" — which two was the whole point), and the executor's own per-action
 * lines say what happened instead.
 */
export function answerLocally(
    pending: PendingClarification, chosen: readonly string[],
): NLResponse | null {
    const { response, context } = pending;
    if (!response || !context || !context.patchable) return null;
    if (chosen.length === 0 || chosen.some(isCancel)) return null;

    const action = response.actions[context.actionIndex];
    if (!action) return null;

    const patched = patchAction(action, context.slot, chosen);
    if (!patched) return null;

    const actions = [
        ...response.actions.slice(0, context.actionIndex),
        ...patched,
        ...response.actions.slice(context.actionIndex + 1),
    ];
    // A fan-out that overflows the ceiling is not something to trim: dropping a
    // squad the player just picked is worse than asking the model to phrase the
    // whole thing again.
    if (actions.length > MAX_ACTIONS) return null;

    return { actions };
}

/**
 * One action + the chosen name(s) → the action(s) that replace it.
 *
 * Only the `subject` slot ever returns more than one action, and only for a
 * `class-count` subject: "which two of these four?" is answered by naming two
 * squads, and one directive per squad is exactly what the class-count fan-out
 * would have produced anyway (§1). Every other slot takes a single name.
 */
function patchAction(
    action: NLAction, slot: ClarifyContext['slot'], chosen: readonly string[],
): NLAction[] | null {
    const one = chosen[0];

    switch (slot) {
        case 'subject': {
            if (action.kind !== 'command') return null;
            if (chosen.length === 1) {
                return [{
                    ...action,
                    intent: { ...action.intent, subject: entityRef(one) },
                }];
            }
            // Several squads named: one command each, same verb, same target,
            // same priority and gate. Order follows the chip order, which is
            // the ranked order the question offered them in.
            return chosen.map((name): NLAction => ({
                ...action,
                intent: { ...action.intent, subject: entityRef(name) },
            }));
        }

        case 'target': {
            if (action.kind !== 'command' || chosen.length !== 1) return null;
            const target = action.intent.target;
            if (!target || target.type === 'point') return null;
            return [{
                ...action,
                intent: { ...action.intent, target: { ...target, name: one } },
            }];
        }

        case 'when-region': {
            if (action.kind !== 'command' || chosen.length !== 1) return null;
            const when = action.intent.when;
            if (when?.type !== 'region-contested') return null;
            return [{
                ...action,
                intent: { ...action.intent, when: { ...when, regionRef: one } },
            }];
        }

        case 'guidance-ref': {
            if (action.kind !== 'guidance' || chosen.length !== 1) return null;
            const g = action.guidance;
            // Whichever ref this op reads — the validator has already proved
            // exactly one of them is present, so there is no ambiguity about
            // which name was being resolved.
            if (g.regionRef !== undefined) return [{ ...action, guidance: { ...g, regionRef: one } }];
            if (g.groupRef !== undefined) return [{ ...action, guidance: { ...g, groupRef: one } }];
            if (g.objectiveRef !== undefined) return [{ ...action, guidance: { ...g, objectiveRef: one } }];
            return null;
        }

        case 'group-ref': {
            if (action.kind !== 'group' || chosen.length !== 1) return null;
            if (action.group.op !== 'rename') return null;
            return [{ ...action, group: { ...action.group, groupRef: one } }];
        }

        case 'camera-target': {
            if (action.kind !== 'camera' || chosen.length !== 1) return null;
            const c = action.camera;
            if (c.op !== 'focus' && c.op !== 'follow') return null;
            return [{ ...action, camera: { ...c, targetRef: one } }];
        }

        case 'query-target': {
            if (action.kind !== 'query' || chosen.length !== 1) return null;
            const q = action.query;
            if (q.op === 'locate') return [{ ...action, query: { ...q, targetRef: one } }];
            if (q.op === 'status') return [{ ...action, query: { ...q, subjectRef: one } }];
            return null;
        }

        // A panel id is never ambiguous — the registry answers yes or no — so
        // there is no question here to answer. Listed rather than defaulted so
        // a new slot has to decide for itself.
        case 'panel':
            return null;
    }
}

function entityRef(name: string): NLSubject {
    return { type: 'entity-ref', name };
}
