/**
 * nl-client.ts — the offline parser as an envelope producer, and the local run
 * (PLAN-metalstorm-command-language.md §3 "Degradation", milestone M1)
 *
 * From M4 the console's sentences go to the server proxy and come back as an
 * `NLResponse`. Until then — and forever after, whenever the proxy is disabled,
 * rate-limited or down — the SAME sentences go through the local closed-vocab
 * slot-filler. The plan's degradation rule is that both produce the identical
 * shape, so the console, the transcript copy and the refusal wording don't
 * change when the proxy lands or fails.
 *
 * This file is that adapter, and it is why the envelope path is exercised in
 * anger from M1 rather than only by fixtures: the console now runs
 *
 *     utterance → acceleratorFill/planUtterance → NLResponse
 *              → validateNLResponse → executeNLResponse → sendCommand
 *
 * Every typed order in the game already crosses the validator and the executor.
 * If the envelope contract is wrong, M1 finds out, not M4.
 *
 * The adapter emits NAMES, not the ids the slot-filler already resolved
 * (`acceleratorFill` hands back a whole `NamedEntity`). That looks like a
 * pointless round-trip and isn't: it means the resolver's rules — ambiguity
 * becomes a question, an unknown place becomes a refusal, never-guess-between-
 * armies — govern the local path too, instead of only the LLM one. Two
 * resolution policies for two producers is how "moves the wrong army" ships.
 */

import { getPriorityBand } from './compile-table.js';
import { planUtterance, type ExchangeDeps, type ExchangeOutcome } from './console-exchange.js';
import type { AcceleratorResult } from './free-text-accelerator.js';
import {
    validateNLResponse,
    type NLPriority, type NLResponse, type NLSubject, type NLTarget, type NLWhen,
    type ValidationResult,
} from './nl-envelope.js';
import {
    executeNLResponse,
    type ExecutionReport, type ExecutorPorts, type NLConsoleLine, type NLConsolePort,
} from './nl-executor.js';

/** What the offline parser produced, plus the transparency notes that belong
 *  under whatever line the executor ends up printing. */
export interface LocalParse {
    response: NLResponse;
    /** "didn't understand: 'quickly'" — the accelerator's unclaimed words. */
    notes: string[];
    /** The M0 outcome this was built from, for callers that still want its copy. */
    outcome: ExchangeOutcome;
}

/**
 * Wrap the offline parser's output in an `NLResponse`.
 *
 * Refusals become a single `refuse` action carrying the M0 refusal copy verbatim
 * — that copy was written to be actionable ("Verbs I know: …") and re-wording it
 * here would give the player two different answers to the same mistake
 * depending on whether the proxy happened to be up.
 */
export function acceleratorToEnvelope(utterance: string, deps: ExchangeDeps): LocalParse {
    const outcome = planUtterance(utterance, deps);

    if (outcome.kind === 'refused') {
        return {
            outcome,
            notes: outcome.notes,
            response: { actions: [{ kind: 'refuse', reason: clampText(outcome.text) }] },
        };
    }

    const { parsed, intent } = outcome;
    const response: NLResponse = {
        // `heard`, not `text`: the acknowledgement restates the ORDER, never its
        // outcome. `text` ends in "→ directive issued", and resolution can still
        // refuse or ask a question after this line is printed — see
        // ExchangeOutcome.heard.
        say: clampText(outcome.heard),
        actions: [{
            kind: 'command',
            intent: {
                verb: intent.verb,
                subject: subjectToEnvelope(outcome),
                ...(targetToEnvelope(parsed) ? { target: targetToEnvelope(parsed)! } : {}),
                priority: getPriorityBand(intent.priority) as NLPriority,
                ...(whenToEnvelope(parsed) ? { when: whenToEnvelope(parsed)! } : {}),
            },
        }],
    };

    return { outcome, notes: outcome.notes, response };
}

/**
 * Which subject the sentence meant, in name-space.
 *
 * The three-way rule is the M0 one, unchanged (`console-exchange.ts` decided it;
 * `subjectSource` reports which branch fired): a named group stays a name, an
 * unqualified order with a selection becomes `selection`, and an unqualified
 * order with nothing selected becomes `any` — the team-wide, take-whatever-idles
 * subject the compile table has always produced for it.
 */
function subjectToEnvelope(outcome: Extract<ExchangeOutcome, { kind: 'sent' }>): NLSubject {
    const { parsed, subjectSource } = outcome;

    if (parsed.subject?.type === 'ai') return { type: 'ai' };
    if (parsed.subject?.type === 'idle-filter') {
        return { type: 'idle-filter', filterClass: parsed.subject.filterClass ?? '' };
    }
    if (subjectSource === 'selection') return { type: 'selection' };
    if (subjectSource === 'team') return { type: 'any' };

    // A named group: hand back THE PLAYER'S OWN WORDS, not the name of whatever
    // the slot-filler's top hit happened to be. Emitting the matched name would
    // launder a guess into a certainty — "Chimera" would leave here as "Chimera
    // Reserve" and resolve exactly, moving a squad the player never named. The
    // query text lets the resolver see the same ambiguity and ask.
    const name = parsed.subjectQuery;
    return name ? { type: 'entity-ref', name } : { type: 'any' };
}

/** Same rule as the subject: the player's words, not the top hit's name. A place
 *  resolved on score dominance can still be ambiguous, and "attack Rand" must
 *  reach the resolver as "Rand". */
function targetToEnvelope(parsed: AcceleratorResult): NLTarget | null {
    const target = parsed.target;
    if (!target) return null;
    if (target.entity && parsed.targetQuery) return { type: 'entity-ref', name: parsed.targetQuery };
    if (target.point) return { type: 'point', x: target.point.x, z: target.point.z };
    if (target.area) return { type: 'point', x: target.area.x, z: target.area.z };
    return null;
}

/**
 * The when-gate in name-space. The accelerator only ever produces the two
 * keyword conditions (`under attack`, `contested`), and `contested` borrowed its
 * region from the target — so the region ref is the target's query text, kept
 * identical to the target's so the two can't resolve to different regions.
 */
function whenToEnvelope(parsed: AcceleratorResult): NLWhen | null {
    const when = parsed.when;
    if (!when) return null;
    if (when.type === 'under-attack') return { type: 'under-attack' };
    if (when.type === 'region-contested') {
        const name = parsed.targetQuery;
        return name ? { type: 'region-contested', regionRef: name } : null;
    }
    return null;
}

function clampText(text: string): string {
    return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

// ─────────────────────────── the local run ───────────────────────────

export interface LocalRunDeps extends ExchangeDeps {
    /** Executor ports. `resolver` is required; camera/ui/query are M3. */
    ports: ExecutorPorts;
}

export interface LocalRunResult {
    response: NLResponse;
    validation: ValidationResult;
    report: ExecutionReport;
}

/**
 * One typed sentence, end to end, through the envelope path.
 *
 * The validator runs even on locally-produced envelopes. That is not paranoia
 * about our own adapter — it is what keeps the adapter honest: the moment it
 * emits a class the vocabulary doesn't ship or a verb the compile table dropped,
 * the console says so instead of the executor discovering it three layers down.
 *
 * `notes` are attached to the FIRST line the executor prints, which is where the
 * M0 console rendered them (dim sub-lines under the outcome). If nothing prints
 * — impossible today, since every path prints something — they are emitted on
 * their own rather than lost.
 */
export function runLocalUtterance(utterance: string, deps: LocalRunDeps): LocalRunResult {
    const { response, notes } = acceleratorToEnvelope(utterance, deps);
    const validation = validateNLResponse(response, { vocabulary: deps.vocabulary });

    if (!validation.ok) {
        // The offline parser built something the contract rejects. Visible, and
        // specific enough to fix: the errors name the field.
        const line: NLConsoleLine = {
            kind: 'refused',
            text: `I understood that, but couldn't put it in a form the game accepts: ${validation.errors[0]}.`,
            notes: validation.errors.slice(1, 4),
        };
        deps.ports.console.say(line);
        return { response, validation, report: { lines: [line], sent: [], refusals: [line.text] } };
    }

    const report = executeNLResponse(validation.value, {
        ...deps.ports,
        console: withNotes(deps.ports.console, notes),
    });
    return { response, validation, report };
}

/** Decorate the first line with the transparency notes, then get out of the way. */
function withNotes(inner: NLConsolePort, notes: string[]): NLConsolePort {
    if (notes.length === 0) return inner;
    let first = true;
    return {
        say(line) {
            if (first && line.kind !== 'system') {
                first = false;
                inner.say({ ...line, notes: [...(line.notes ?? []), ...notes] });
                return;
            }
            inner.say(line);
        },
    };
}
