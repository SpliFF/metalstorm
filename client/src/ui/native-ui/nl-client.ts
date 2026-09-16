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
import { matchLocalPattern, type LocalPatternDeps } from './nl-local-patterns.js';
import {
    MAX_ACTIONS,
    validateNLResponse,
    type NLGroupAction, type NLPriority, type NLResponse, type NLSubject, type NLTarget,
    type NLWhen, type ValidationResult,
} from './nl-envelope.js';
import {
    executeNLResponse,
    type ExecutionReport, type ExecutorPorts, type NLConsoleLine, type NLConsolePort,
} from './nl-executor.js';
import type { NLFocusView } from './focus-model.js';
import {
    bindFocusReferences, findSubjectDeictic, findTargetDeictic, isTargetDeictic,
} from './nl-focus.js';
import { interpret, type InterpretationPlan } from './nl-interpretation.js';
import { fastPathParse, type FastPathRule } from './nl-fast-path.js';

/** What the offline parser produced, plus the transparency notes that belong
 *  under whatever line the executor ends up printing. */
export interface LocalParse {
    response: NLResponse;
    /** "didn't understand: 'quickly'" — the accelerator's unclaimed words. */
    notes: string[];
    /**
     * The M0 outcome this was built from, for callers that still want its copy.
     * Absent when the sentence never reached the slot-filler — a rename is
     * matched ahead of it (see `parseGroupRename`) and produces no
     * `CompiledMessage`, which is the only shape `ExchangeOutcome` can carry.
     */
    outcome?: ExchangeOutcome;
}

type NLRename = Extract<NLGroupAction, { op: 'rename' }>;

/**
 * What the adapter needs beyond the M0 exchange deps.
 *
 * `patterns` is OPTIONAL and its absence is meaningful: a caller with no camera,
 * no registry and no query engine (an envelope-shape test, a headless harness)
 * gets the M0/M1 behaviour exactly — the camera/panel/query sentences reach the
 * accelerator and refuse there, rather than producing envelopes for ports that
 * aren't wired.
 */
export interface AdapterDeps extends ExchangeDeps {
    patterns?: LocalPatternDeps;
    /**
     * What the player is looking at (battle-clarity U4, `nl-focus.ts`).
     *
     * Read at two points, both of them about pronouns: the offline producer
     * uses it to know that a sentence with no target still HAS one ("attack
     * that town"), and `bindFocusReferences` uses it to turn that pronoun into
     * a name. Absent ⇒ a pronoun refuses, which is the same answer an empty
     * focus gives — no sentence changes meaning because this dep is missing.
     */
    focus?: NLFocusView | null;
}

/**
 * "Name this group Hammerfall" — matched BEFORE the slot-filler.
 *
 * A rename is not one of the eleven verbs and never will be: `compile-table.ts`
 * turns verbs into directives, and this produces an `OrgGroup` update. So it is
 * a pattern in front of the accelerator rather than a twelfth entry in its
 * table — the accelerator stays a table of things that move armies.
 *
 * Two shapes, and the order they are tried in matters:
 *   1. the SELECTION form — "name/call/rename this group <name>" — which emits
 *      no `groupRef` at all (see `NLGroupAction`), and
 *   2. the REFERENCE form — "rename <group> to <name>".
 * Shape 1 is tried first because "rename this group to Hammerfall" satisfies
 * shape 2 as well, with `groupRef = "this group"` — a phrase the resolver would
 * hunt for in the name index and rightly not find.
 *
 * Nothing here resolves anything: like every other producer in this file it
 * emits names (or the absence of one) and lets `nl-resolver.ts` decide.
 */
const RENAME_SELECTION =
    /^(?:name|call|rename)\s+(?:(?:this|that|the|my)\s+)?(?:group|squad|platoon|army|force|them|it)\s+(?:(?:to|as)\s+)?(.+)$/i;
const RENAME_REFERENCE = /^rename\s+(.+?)\s+to\s+(.+)$/i;

export function parseGroupRename(utterance: string): NLRename | null {
    const text = utterance.trim();

    const selection = RENAME_SELECTION.exec(text);
    if (selection) {
        const name = cleanName(selection[1]);
        return name ? { op: 'rename', name } : null;
    }

    const reference = RENAME_REFERENCE.exec(text);
    if (reference) {
        const groupRef = cleanName(reference[1]);
        const name = cleanName(reference[2]);
        return groupRef && name ? { op: 'rename', groupRef, name } : null;
    }

    return null;
}

/** Trim the punctuation a spoken or typed name arrives wrapped in. Whatever
 *  survives still faces the envelope validator's charset/length gate — this
 *  only stops a stray quote from being *part of the callsign*. */
function cleanName(raw: string): string {
    return raw.trim().replace(/^["'`]+|["'`.!]+$/g, '').trim();
}

/**
 * Wrap the offline parser's output in an `NLResponse`.
 *
 * Refusals become a single `refuse` action carrying the M0 refusal copy verbatim
 * — that copy was written to be actionable ("Verbs I know: …") and re-wording it
 * here would give the player two different answers to the same mistake
 * depending on whether the proxy happened to be up.
 */
export function acceleratorToEnvelope(utterance: string, deps: AdapterDeps): LocalParse {
    const clauses = splitClauses(utterance);
    if (clauses) {
        const parts = clauses.map((clause) => parseOne(clause, deps));
        // All or nothing: one clause the local path can't execute means the
        // conjunction was part of a name, not a list of orders. See
        // `splitClauses`.
        const executable = parts.every((p) =>
            p.response.actions.length > 0 && p.response.actions.every((a) => a.kind !== 'refuse'));
        if (executable && parts.reduce((n, p) => n + p.response.actions.length, 0) <= MAX_ACTIONS) {
            const says = parts.map((p) => p.response.say).filter((s): s is string => !!s);
            return {
                notes: parts.flatMap((p) => p.notes),
                response: {
                    ...(says.length ? { say: clampText(says.join('; ')) } : {}),
                    actions: parts.flatMap((p) => p.response.actions),
                },
            };
        }
    }
    return parseOne(utterance, deps);
}

/**
 * "defend Northgate and show me the minimap" → two clauses, or null.
 *
 * Null means "treat the whole thing as one sentence", and it is the answer
 * whenever ANY clause fails to parse on its own. That all-or-nothing rule is
 * what keeps the split safe: "defend the grain silo and osprey fen" splits into
 * a clause and a fragment, the fragment produces no action, and the sentence
 * goes to the slot-filler whole — where "and osprey fen" ends up in the
 * unmatched-words note, exactly as before this existed. So this can only ever
 * ADD sentences the local path executes; it can never change what an existing
 * one means.
 *
 * The LLM does this properly (§1 "multi-step = ordered list", and it reads the
 * sentence rather than counting conjunctions). This is the offline half, and it
 * is why "defend <place> and show me the minimap" works with the proxy down.
 */
function splitClauses(utterance: string): string[] | null {
    const parts = utterance
        .split(/(?:,\s*(?:and\s+|then\s+)?|\s+and\s+then\s+|\s+and\s+|\s*;\s*|\s+then\s+)/i)
        .map((p) => p.trim())
        .filter(Boolean);
    if (parts.length < 2 || parts.length > MAX_ACTIONS) return null;
    return parts;
}

/** One clause (or one whole sentence) → one envelope. Never re-splits: the
 *  split has already happened by the time this is called. */
function parseOne(utterance: string, deps: AdapterDeps): LocalParse {
    // M3's camera / panel / query patterns, tried BEFORE the slot-filler for the
    // same reason the rename is: none of them is one of the eleven army-moving
    // verbs, and teaching the slot-filler about panels would make every sentence
    // mentioning one a candidate order. An unmatched sentence falls straight
    // through, so this can only ever ADD sentences the local path can execute.
    if (deps.patterns) {
        const local = matchLocalPattern(utterance, deps.patterns);
        if (local) {
            return { notes: [], response: { say: local.say, actions: [local.action] } };
        }
    }

    const rename = parseGroupRename(utterance);
    if (rename) {
        return {
            notes: [],
            response: {
                // `say` restates the ORDER, never its outcome — the executor
                // still has to find the group, and may refuse.
                say: rename.groupRef
                    ? `rename ${rename.groupRef} to "${rename.name}"`
                    : `rename the selected group to "${rename.name}"`,
                actions: [{ kind: 'group', group: rename }],
            },
        };
    }

    const outcome = planUtterance(utterance, deps);

    const deictic = deicticCommand(utterance, outcome, deps);
    if (deictic) return deictic;

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
                subject: subjectToEnvelope(outcome, utterance),
                ...(targetToEnvelope(parsed) ? { target: targetToEnvelope(parsed)! } : {}),
                priority: getPriorityBand(intent.priority) as NLPriority,
                ...(whenToEnvelope(parsed) ? { when: whenToEnvelope(parsed)! } : {}),
            },
        }],
    };

    // U4: a pronoun the subject rule consumed is no longer "not understood".
    // `outcome.notes` is the slot-filler's own transparency line, built before
    // this file knew the word was meaningful, and leaving it would tell the
    // player their pronoun was ignored one line under an order that obeyed it.
    const consumed = consumedDeictics(utterance, response);
    return { outcome, notes: withoutWords(outcome.notes, consumed), response };
}

/** The deictic words this envelope actually used, lower-cased. */
function consumedDeictics(utterance: string, response: NLResponse): Set<string> {
    const used = new Set<string>();
    for (const action of response.actions) {
        if (action.kind !== 'command') continue;
        if (action.intent.subject.type === 'selection') {
            const target = findTargetDeictic(utterance);
            const rest = target ? utterance.toLowerCase().replace(target, ' ') : utterance;
            const phrase = findSubjectDeictic(rest);
            if (phrase) for (const w of phrase.split(/\s+/)) used.add(w);
        }
        const target = action.intent.target;
        if (target && target.type !== 'point' && isTargetDeictic(target.name)) {
            for (const w of target.name.toLowerCase().split(/\s+/)) used.add(w);
        }
    }
    return used;
}

/** Rewrite the "didn't understand" note without the words that now mean
 *  something, dropping it entirely when nothing is left unexplained. */
function withoutWords(notes: string[], drop: Set<string>): string[] {
    if (drop.size === 0) return notes;
    return notes.flatMap((note) => {
        const match = /^didn't understand: (.*)$/.exec(note);
        if (!match) return [note];
        const kept = match[1].split(', ')
            .filter((quoted) => !drop.has(quoted.replace(/^'|'$/g, '').toLowerCase()));
        return kept.length ? [`didn't understand: ${kept.join(', ')}`] : [];
    });
}

/**
 * "attack that town" — the offline path's pronoun rescue (U4).
 *
 * Two boards need it, and the second is the one that matters:
 *
 * 1. The slot-filler refused for want of a target. "defend it" names nothing
 *    it can match, so without this the sentence is simply not an order.
 *
 * 2. **The slot-filler found a name INSIDE the pronoun.** `attack that town`
 *    on Meridian Basin resolves — to *Randtown*, because "town" is a substring
 *    of it, with "that" and "town" ALSO listed as unmatched words. That is the
 *    accelerator's known over-reach (PLAN §7 M5's residual: a leftover word
 *    fuzzy-matched into a target), and it is the exact failure a pronoun makes
 *    dangerous: a sentence about the town the player is looking at silently
 *    becomes an order against a town on the other side of the map.
 *
 * So the test is not "did it fail" but "is the name it found made of the
 * pronoun's own words". If every word of the matched query sits inside the
 * deictic phrase, the match is a coincidence of spelling and the phrase wins.
 * A sentence that names a real place outside the pronoun ("attack Northgate")
 * is untouched, which keeps the standing rule that this kind of pattern can
 * only ADD sentences the local path executes.
 *
 * It emits the PRONOUN, not a resolved name — exactly as the model does when
 * it echoes the player's word — so `bindFocusReferences` is the single place
 * that decides what "that town" points at, for both producers. Emitting a
 * bound name from here would be a second binding policy, and the whole reason
 * this file hands NAMES to the resolver rather than the ids the slot-filler
 * already found is that two policies is how the wrong army moves.
 */
function deicticCommand(
    utterance: string, outcome: ExchangeOutcome, deps: AdapterDeps,
): LocalParse | null {
    const parsed = outcome.parsed;
    if (!parsed?.verb) return null;

    const phrase = findTargetDeictic(utterance);
    if (!phrase) return null;

    if (outcome.kind === 'refused') {
        if (outcome.reason !== 'no-target') return null;
    } else if (!queryIsMadeOf(parsed.targetQuery, phrase)) {
        return null;
    }

    // A subject pronoun in the same sentence ("pull them back to the ridge")
    // is the selection; no pronoun and no named subject falls through to the
    // M0 three-way rule, which the executor echoes as "team-wide".
    //
    // Searched with the TARGET phrase cut out first: "that" is a subject
    // pronoun and also the first word of "that town", so scanning the whole
    // sentence would read "attack that town" as an order to the selection —
    // and refuse it outright with nothing selected.
    const withoutTarget = utterance.toLowerCase().replace(phrase, ' ');
    const subject: NLSubject = parsed.subject?.type === 'ai'
        ? { type: 'ai' }
        : parsed.subject?.type === 'idle-filter'
            ? { type: 'idle-filter', filterClass: parsed.subject.filterClass ?? '' }
            : parsed.subjectQuery
                ? { type: 'entity-ref', name: parsed.subjectQuery }
                : findSubjectDeictic(withoutTarget) !== null || deps.selectionGroupId != null
                    ? { type: 'selection' }
                    : { type: 'any' };

    return {
        outcome,
        // The unmatched-words note still rides along MINUS the pronoun: "that
        // town" is now meaningful, but "quickly" in the same sentence still
        // isn't, and dropping the whole note would hide that.
        notes: withoutWords(outcome.notes, new Set(phrase.split(/\s+/))),
        response: {
            actions: [{
                kind: 'command',
                intent: {
                    verb: parsed.verb,
                    subject,
                    target: { type: 'entity-ref', name: phrase },
                    priority: (parsed.priority
                        ? getPriorityBand(parsed.priority) as NLPriority
                        : 'normal'),
                    // `region-contested` borrows its region from the target
                    // query, and there is no target query here — so only the
                    // condition that needs no ref survives. A when-gate that
                    // silently lost its region would be an order that fires
                    // immediately, which is the opposite of what was asked.
                    ...(parsed.when?.type === 'under-attack'
                        ? { when: { type: 'under-attack' as const } } : {}),
                },
            }],
        },
    };
}

/** Is every word of the matched target query a word of the deictic phrase? */
function queryIsMadeOf(query: string | null | undefined, phrase: string): boolean {
    if (!query) return true;                       // no name found at all
    const words = new Set(phrase.toLowerCase().split(/\s+/));
    return query.toLowerCase().split(/\s+/).every((w) => words.has(w));
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
function subjectToEnvelope(
    outcome: Extract<ExchangeOutcome, { kind: 'sent' }>, utterance: string,
): NLSubject {
    const { parsed, subjectSource } = outcome;

    if (parsed.subject?.type === 'ai') return { type: 'ai' };
    if (parsed.subject?.type === 'idle-filter') {
        return { type: 'idle-filter', filterClass: parsed.subject.filterClass ?? '' };
    }
    if (subjectSource === 'selection') return { type: 'selection' };
    if (subjectSource === 'team') {
        // U4: "withdraw THEM to Amber Row" is not a team-wide order.
        //
        // The slot-filler has no grammar, so a subject pronoun lands in
        // `unmatched` and the M0 three-way rule falls through to `any` — a
        // sentence that explicitly named its subject quietly becoming "whoever
        // is free". `selection` is what the player said, and the resolver is
        // where it is decided whether that is orderable (it may refuse, or ask
        // which of two selected groups).
        //
        // The target phrase is cut out before the search, for the reason
        // `deicticCommand` does the same: "that" is a subject pronoun and also
        // the first word of "that town".
        const target = findTargetDeictic(utterance);
        const rest = target ? utterance.toLowerCase().replace(target, ' ') : utterance;
        if (findSubjectDeictic(rest) !== null) return { type: 'selection' };
        return { type: 'any' };
    }

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

export interface LocalRunDeps extends AdapterDeps {
    /** Executor ports. `resolver` is required; camera/ui/query are M3. */
    ports: ExecutorPorts;
    /**
     * The confirm gate (U4). Called with the reading of a sentence whose
     * meaning DEPENDED on the focus — a pronoun was bound — before anything is
     * sent. Returning false holds the envelope: nothing executes, and the
     * caller gets it back in `held` to put behind a `Do it` / `Cancel` chip.
     *
     * Optional, and its absence means "no gate", not "refuse": a harness, a
     * fixture run and the eval all execute straight through, which is what
     * keeps the golden fixtures a test of interpretation rather than of the
     * console's chrome.
     */
    confirm?: (plan: InterpretationPlan) => boolean;
    /** Registered panel ids (`uiActionRegistry.ids()`), so a `ui` envelope naming
     *  a panel that doesn't exist is caught by the CONTRACT rather than by the
     *  registry three layers down. Omitted ⇒ charset-only checking (§1). */
    panelIds?: readonly string[];
}

export interface LocalRunResult {
    response: NLResponse;
    validation: ValidationResult;
    report: ExecutionReport;
    /**
     * Set when the confirm gate held the sentence. `response` is then the
     * BOUND envelope — the one the player is being shown — so the console can
     * execute exactly what it echoed by handing it straight back.
     */
    held?: InterpretationPlan;
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
    const validation = validateNLResponse(response, {
        vocabulary: deps.vocabulary,
        ...(deps.panelIds ? { panelIds: deps.panelIds } : {}),
    });

    if (!validation.ok) {
        // The offline parser built something the contract rejects. Visible, and
        // specific enough to fix: the errors name the field.
        const line: NLConsoleLine = {
            kind: 'refused',
            text: `I understood that, but couldn't put it in a form the game accepts: ${validation.errors[0]}.`,
            notes: validation.errors.slice(1, 4),
        };
        deps.ports.console.say(line);
        return { response, validation, report: { lines: [line], sent: [], refusals: [line.text], ran: [], notRun: [] } };
    }

    return {
        ...deliver(validation.value, deps, notes),
        validation,
    };
}

/**
 * Run an envelope this client BUILT — the clarification-answer path (M5).
 *
 * Same validator, same binder, same reading, same gate as a sentence: an
 * envelope patched with a chosen callsign is still an envelope, and the one
 * property worth protecting is that it cannot reach `sendCommand` by a route
 * with fewer checks on it than the route a typed sentence takes.
 */
export function executeEnvelope(response: NLResponse, deps: LocalRunDeps): LocalRunResult {
    const validation = validateNLResponse(response, {
        vocabulary: deps.vocabulary,
        ...(deps.panelIds ? { panelIds: deps.panelIds } : {}),
    });
    if (!validation.ok) {
        const line: NLConsoleLine = {
            kind: 'refused',
            text: `I couldn't put that in a form the game accepts: ${validation.errors[0]}.`,
            notes: validation.errors.slice(1, 4),
        };
        deps.ports.console.say(line);
        return {
            response, validation,
            report: { lines: [line], sent: [], refusals: [line.text], ran: [], notRun: [] },
        };
    }
    return { ...deliver(validation.value, deps, []), validation };
}

/**
 * Bind the focus, echo the reading, gate it, execute it — the tail every
 * producer shares (U4).
 *
 * One function, called by the local run AND the proxy run, because the whole
 * argument for the envelope contract is that a sentence means the same thing
 * whichever parser produced it. A pronoun bound on one path and not the other
 * would be exactly the divergence `nl-envelope.ts` exists to prevent.
 *
 * The reading is handed over as the envelope's `say` rather than printed here.
 * That is not a shortcut: `executeNLResponse` holds `say` until the first
 * action actually succeeds, so an interpretation is never printed above the
 * refusal or the question that contradicts it — the failure that deferral was
 * written for. It also means the model's own `say` is REPLACED whenever we
 * could build a reading, which is the right way round: the model writes its
 * line before resolution, and this one is written after it.
 */
function deliver(
    response: NLResponse, deps: LocalRunDeps, notes: string[],
): { response: NLResponse; report: ExecutionReport; held?: InterpretationPlan } {
    const bound = bindFocusReferences(response, deps.focus);
    const plan = interpret(bound.response, {
        resolver: deps.ports.resolver,
        ...(deps.groupLabel ? { groupLabel: deps.groupLabel } : {}),
        bindings: bound.bindings,
    });

    if (plan?.needsConfirm && deps.confirm && !deps.confirm(plan)) {
        // Held. Nothing was sent, nothing was said, and the caller holds the
        // exact envelope that was echoed — so what the player confirms and
        // what executes cannot drift apart between the two moments.
        return {
            response: bound.response,
            report: { lines: [], sent: [], refusals: [], ran: [], notRun: [] },
            held: plan,
        };
    }

    const toRun = plan ? { ...bound.response, say: plan.text } : bound.response;
    const report = executeNLResponse(toRun, {
        ...deps.ports,
        console: notes.length ? withNotes(deps.ports.console, notes) : deps.ports.console,
    });
    return { response: bound.response, report };
}

// ─────────────────────────── the proxy run (M4) ───────────────────────────

/**
 * Where the envelope that just executed came from.
 *
 * Surfaced rather than inferred because the player is owed it: the offline
 * parser understands a much narrower set of sentences, and a player whose
 * "get a couple of tank squads over to Randtown" silently became "I didn't
 * understand that" deserves to know the difference between a sentence the game
 * rejects and a proxy that is down.
 */
export type NLRunSource = 'proxy' | 'offline-parser' | 'fast-path';

/** Printed under the first line whenever the local path ran instead. */
export const OFFLINE_TAG = '(offline parser)';

export interface ProxyDeps {
    /** Game-server origin — `CONFIG.httpUrl`. */
    endpoint: string;
    /** The player's session token, sent as a Bearer header. The proxy route is
     *  `RouteAuth::TokenRequired`, and the token is also what the per-user
     *  token bucket is keyed on. */
    token: string;
    /** The §2 payload (`nl-context.ts`). */
    context: unknown;
    /** ≤2 prior exchanges, oldest first, alternating you/game. */
    history?: readonly string[];
    /** Injected in tests. */
    fetchImpl?: typeof fetch;
    /**
     * Client-side abort. Deliberately LONGER than the server's own 6 s cap so
     * that a slow-but-alive upstream comes back as the server's clean 503
     * rather than as a client timeout — the two look the same to the player but
     * only one of them leaves a usable line in the server log.
     */
    timeoutMs?: number;
}

export const PROXY_TIMEOUT_MS = 8000;

export interface RemoteRunDeps extends LocalRunDeps {
    /** Absent ⇒ local-only, exactly the M0–M3 behaviour. */
    proxy?: ProxyDeps;
}

export interface RunResult extends LocalRunResult {
    source: NLRunSource;
    /** Why the proxy path was not used, when it wasn't. Logged, not shown. */
    fallbackReason?: string;
    /** Which fast-path rule claimed the sentence, when one did. Telemetry and
     *  the eval's absorption report; never shown to the player — a sentence the
     *  fast path claimed is meant to be indistinguishable from one the model
     *  read, only sooner. */
    fastPathRule?: FastPathRule;
}

/**
 * One utterance, proxy-first, falling back to the local slot-filler.
 *
 * The fallback triggers on 429 / 503 / timeout / transport error — i.e. every
 * way the proxy can be unavailable — and NOT on a 200 whose envelope fails
 * validation. That asymmetry is the point: an unavailable proxy is an
 * operational state the player should barely notice, while a proxy returning
 * an envelope the contract rejects is a bug, and quietly re-running the
 * sentence through a different parser would hide it. The second case prints the
 * validator's own complaint, the same way a bad local envelope does.
 *
 * The proxy's output is validated HERE even though the proxy asked for
 * structured output against the same schema (§3). That is not redundancy: the
 * server is a different trust domain from this executor, structured outputs
 * constrain shape but not the closed vocabularies the schema cannot express
 * (name charsets, count ranges, clarify-excludes-actions), and the executor's
 * safety argument has to hold for an envelope that arrived over the network.
 */
export async function runUtterance(
    utterance: string, deps: RemoteRunDeps,
): Promise<RunResult> {
    // The deterministic pre-LLM claim (`nl-fast-path.ts`). Tried FIRST — before
    // the proxy and before the offline parser — because a sentence it claims is
    // one whose subject and target the resolver has already agreed to, and
    // spending a round trip to be told the same thing is the one cost this
    // layer exists to remove. It declines far more often than it claims, and a
    // decline costs one index lookup.
    const claimed = fastPath(utterance, deps);
    if (claimed) return claimed;

    if (!deps.proxy) {
        return { ...runLocalUtterance(utterance, deps), source: 'offline-parser' };
    }

    let fetched: ProxyOutcome;
    try {
        fetched = await callProxy(utterance, deps.proxy);
    } catch (err) {
        fetched = { kind: 'unavailable', reason: describeError(err) };
    }

    if (fetched.kind === 'unavailable') {
        const local = runLocalUtterance(utterance, {
            ...deps,
            ports: { ...deps.ports, console: withNotes(deps.ports.console, [OFFLINE_TAG]) },
        });
        return { ...local, source: 'offline-parser', fallbackReason: fetched.reason };
    }

    const validation = validateNLResponse(fetched.envelope, {
        vocabulary: deps.vocabulary,
        ...(deps.panelIds ? { panelIds: deps.panelIds } : {}),
    });

    if (!validation.ok) {
        const line: NLConsoleLine = {
            kind: 'refused',
            text: `I understood that, but couldn't put it in a form the game accepts: ${validation.errors[0]}.`,
            notes: validation.errors.slice(1, 4),
        };
        deps.ports.console.say(line);
        return {
            response: fetched.envelope as NLResponse,
            validation,
            report: { lines: [line], sent: [], refusals: [line.text], ran: [], notRun: [] },
            source: 'proxy',
        };
    }

    // Same tail as the local path: bind the focus, echo the reading, gate it.
    // A model that wrote "it" because the player did gets the same binding the
    // offline parser gets, and a model that wrote the real name binds nothing
    // and is charged nothing for passing through here.
    return { ...deliver(validation.value, deps, []), validation, source: 'proxy' };
}

/**
 * Run the fast path, or return null.
 *
 * The claimed envelope goes through `deliver` like every other producer's — the
 * same validator, the same binder (a second time; it is idempotent and costs
 * nothing on an already-bound envelope), the same confirm gate, the same
 * executor. Skipping any of those to save a few more microseconds would make
 * this a route to `sendCommand` with fewer checks on it than a typed sentence,
 * which is the one thing `nl-envelope.ts` exists to prevent.
 */
function fastPath(utterance: string, deps: RemoteRunDeps): RunResult | null {
    let claim;
    try {
        claim = fastPathParse(utterance, {
            resolver: deps.ports.resolver,
            index: deps.ports.resolver.index,
            ...(deps.focus !== undefined ? { focus: deps.focus } : {}),
            ...(deps.selectionGroupId !== undefined
                ? { selectionGroupId: deps.selectionGroupId } : {}),
        });
    } catch {
        // A producer that throws must not take the sentence down with it: the
        // model path is still there and is the answer the player would have got
        // a moment ago.
        return null;
    }
    if (!claim) return null;

    const validation = validateNLResponse(claim.response, {
        vocabulary: deps.vocabulary,
        ...(deps.panelIds ? { panelIds: deps.panelIds } : {}),
    });
    if (!validation.ok) return null;   // stand aside, silently — the model gets it

    return {
        ...deliver(validation.value, deps, []),
        validation,
        source: 'fast-path',
        fastPathRule: claim.rule,
    };
}

type ProxyOutcome =
    | { kind: 'ok'; envelope: unknown }
    | { kind: 'unavailable'; reason: string };

async function callProxy(utterance: string, proxy: ProxyDeps): Promise<ProxyOutcome> {
    const doFetch = proxy.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== 'function') {
        return { kind: 'unavailable', reason: 'no fetch available' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), proxy.timeoutMs ?? PROXY_TIMEOUT_MS);
    try {
        const resp = await doFetch(`${proxy.endpoint}/api/nl/command`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${proxy.token}`,
            },
            body: JSON.stringify({
                utterance,
                context: proxy.context,
                ...(proxy.history?.length ? { history: [...proxy.history] } : {}),
            }),
            signal: controller.signal,
        });

        if (!resp.ok) {
            // Every non-2xx is a fallback. A 400 from the size gate means this
            // client built something malformed, which is a bug — but refusing
            // the player's sentence over it would punish them for our mistake,
            // and the local parser can still handle the simple half.
            return { kind: 'unavailable', reason: `HTTP ${resp.status}` };
        }

        return { kind: 'ok', envelope: await resp.json() };
    } finally {
        clearTimeout(timer);
    }
}

function describeError(err: unknown): string {
    if (err instanceof DOMException && err.name === 'AbortError') return 'timeout';
    if (err instanceof Error) return err.message;
    return 'transport error';
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
