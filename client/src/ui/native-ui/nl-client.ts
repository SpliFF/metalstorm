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
    validateNLResponse,
    type NLGroupAction, type NLPriority, type NLResponse, type NLSubject, type NLTarget,
    type NLWhen, type ValidationResult,
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

export interface LocalRunDeps extends AdapterDeps {
    /** Executor ports. `resolver` is required; camera/ui/query are M3. */
    ports: ExecutorPorts;
    /** Registered panel ids (`uiActionRegistry.ids()`), so a `ui` envelope naming
     *  a panel that doesn't exist is caught by the CONTRACT rather than by the
     *  registry three layers down. Omitted ⇒ charset-only checking (§1). */
    panelIds?: readonly string[];
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
        return { response, validation, report: { lines: [line], sent: [], refusals: [line.text] } };
    }

    const report = executeNLResponse(validation.value, {
        ...deps.ports,
        console: withNotes(deps.ports.console, notes),
    });
    return { response, validation, report };
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
export type NLRunSource = 'proxy' | 'offline-parser';

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
            report: { lines: [line], sent: [], refusals: [line.text] },
            source: 'proxy',
        };
    }

    const report = executeNLResponse(validation.value, deps.ports);
    return { response: validation.value, validation, report, source: 'proxy' };
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
