/**
 * nl-executor.ts — the envelope dispatcher
 * (PLAN-metalstorm-command-language.md §1 "Executor", milestone M1)
 *
 * One validated `NLResponse` in, one decided outcome out. Every action kind is
 * dispatched over INJECTED PORTS — nothing here reaches for a singleton store,
 * a live connection, the DOM, or `window`. That is what makes the whole command
 * language testable with fake ports (§8) and what keeps the dispatch surface
 * small enough to audit.
 *
 * Two rules this file exists to enforce:
 *
 *  1. **One command path.** Orders leave through `sendCommand` — the
 *     `createSendCommand` choke-point in `integration.ts` — and nothing else.
 *     There is no branch here that touches `/api/exec`, `window.test.*`, or a
 *     `ConsoleCommand`: those are cheat/admin paths (compiled out under
 *     `SPRING_PROD`), so authority charging, `AllowCommand` and spectator
 *     gating apply to a spoken order exactly as they do to a clicked one.
 *  2. **Nothing is silently dropped.** A missing port, an unresolvable name, a
 *     shape the sim has no slot for — each produces a visible refusal naming the
 *     reason. The console must never render "done" for something that didn't
 *     happen; that was the bug the M0 milestone found in the AIGuidance path and
 *     it is the failure mode this layer is built to make impossible.
 */

import {
    compileIntent, validateIntent, getPriorityBand,
    type CommandIntent, type CommandSubject, type CommandTarget,
    type CompiledMessage, type WhenCondition,
} from './compile-table.js';
import { aiGuidanceToWire, encodeGuidance } from './guidance-wire.js';
import type { NLResolver, Resolution } from './nl-resolver.js';
import type {
    NLAction, NLCameraAction, NLClarification, NLCommandIntent,
    NLGuidance, NLGroupAction, NLQuery, NLResponse, NLUiAction,
} from './nl-envelope.js';

/** One rendered transcript line. `ask` is a clarification (chips), `refused` is
 *  a visible no-op, `ok` is something that actually happened. */
export interface NLConsoleLine {
    kind: 'ok' | 'refused' | 'ask' | 'system';
    text: string;
    /** Transparency hints — the accelerator's unmatched words, caveats. */
    notes?: string[];
    /** Clarification chips, for `ask`. */
    options?: string[];
}

export interface NLConsolePort {
    say(line: NLConsoleLine): void;
}

/**
 * The three M3 ports share one return type: `Resolution<string>` — the same
 * ok/refuse/clarify triple the resolver speaks.
 *
 * They were originally declared here (M1) returning `void`/`boolean`, which was
 * wrong in the one way this file exists to prevent: `port.focus(ref)` followed by
 * `return done('camera on ' + ref)` prints a success for a name the port may have
 * failed to resolve. A port that can fail must be able to SAY so, in its own
 * words, and a port that needs to ask (two places called "West Scarp") must be
 * able to ask — the executor's job is to relay that, not to narrate over it.
 */
export type PortResult = Resolution<string>;

/** M3's CameraPort (`camera-port.ts` — over the worker camera ops). */
export interface NLCameraPort {
    apply(action: NLCameraAction): PortResult;
}

/** M3's ui-action-registry (`ui-action-registry.ts`). */
export interface NLUiActionPort {
    apply(action: NLUiAction): PortResult;
}

/** M3's LOS-honest query engine (`query-engine.ts`). Answers are text because
 *  the console renders them; the engine owns the LOS filtering, never this
 *  dispatcher — see its header for why that is a data-path property. */
export interface NLQueryPort {
    answer(query: NLQuery): PortResult;
}

export interface ExecutorPorts {
    /** The one and only command path (`integration.ts createSendCommand`). */
    sendCommand: (cmd: unknown) => void;
    resolver: NLResolver;
    console: NLConsolePort;
    camera?: NLCameraPort;
    uiActions?: NLUiActionPort;
    queryEngine?: NLQueryPort;
}

/**
 * Exactly what this dispatcher is allowed to hand to `sendCommand`, as a closed
 * union — the whole outbound surface of the command language in one type.
 * `CompiledMessage` covers the compile table's three; `LuaRulesMsg` is the
 * guidance codec; `OrgGroup` update is the rename. There is deliberately no
 * `ConsoleCommand` and no `PlayerCommand` member: the NL layer commands at the
 * directive layer, never at the raw-unit or admin layer.
 */
export type NLSentCommand =
    | CompiledMessage
    | { type: 'LuaRulesMsg'; data: string }
    | {
          type: 'OrgGroup'; action: 'update'; groupId: number;
          addIds: number[]; removeIds: number[]; name: string;
      };

export interface ExecutionReport {
    lines: NLConsoleLine[];
    /** Every message handed to `sendCommand`, in order — what the fixture suite
     *  asserts against ("two GroupDirective sends"). */
    sent: NLSentCommand[];
    /** Machine-readable refusal texts, for tests and later telemetry. */
    refusals: string[];
    /** Set when the run stopped to ask a question instead of acting. */
    clarification?: NLClarification;
}

/**
 * Execute a VALIDATED envelope. `validateNLResponse` must have passed first —
 * this function trusts the schema and does not re-check it, exactly as
 * `compileIntent` trusts `validateIntent`.
 *
 * A clarification (from the envelope OR synthesized mid-run by the resolver)
 * STOPS the envelope: the player is about to resubmit, and finishing a plan
 * whose premise is in doubt is how the wrong squad gets moved. An individual
 * refusal does not stop it — one impossible step in a multi-step plan shouldn't
 * cancel the steps that were fine, and each refusal is reported by name.
 */
export function executeNLResponse(response: NLResponse, ports: ExecutorPorts): ExecutionReport {
    const report: ExecutionReport = { lines: [], sent: [], refusals: [] };

    const say = (line: NLConsoleLine) => { report.lines.push(line); ports.console.say(line); };
    const deny = (text: string, notes?: string[]) => {
        report.refusals.push(text);
        say({ kind: 'refused', text, ...(notes ? { notes } : {}) });
    };
    const ask = (clarification: NLClarification) => {
        report.clarification = clarification;
        say({
            kind: 'ask',
            text: clarification.question,
            ...(clarification.options ? { options: clarification.options } : {}),
        });
    };

    // Asking and acting are exclusive (the validator enforces the shape; this
    // honours it).
    if (response.clarify) {
        ask(response.clarify);
        return report;
    }

    // The acknowledgement is HELD until something actually succeeds.
    //
    // `say` is written before resolution runs — by the model in M4, by the
    // offline adapter today — so it can claim an order that resolution then
    // refuses or turns into a question. Printing it eagerly produced exactly
    // that live: "standing order set (team-wide)" one line above "Which place did
    // you mean — West Scarp (North) or West Scarp (South)?". Deferring it to the
    // first success means an envelope that achieves nothing acknowledges nothing.
    let pendingSay = response.say;
    const flushSay = () => {
        if (pendingSay === undefined) return;
        const text = pendingSay;
        pendingSay = undefined;
        say({ kind: 'system', text });
    };

    for (const action of response.actions) {
        const outcome = dispatch(action, ports, report);
        if (outcome.kind === 'clarify') {
            ask({ question: outcome.question, ...(outcome.options ? { options: outcome.options } : {}) });
            break;                                   // stop the plan — see the doc above
        }
        if (outcome.kind === 'refuse') {
            deny(outcome.reason);
            continue;
        }
        flushSay();
        for (const text of outcome.value) say({ kind: 'ok', text });
    }

    return report;
}

/** Per-action outcome: `ok` carries the console lines the action earned. */
type Dispatched = Resolution<string[]>;

const done = (...lines: string[]): Dispatched => ({ kind: 'ok', value: lines });
const no = (reason: string): Dispatched => ({ kind: 'refuse', reason });

function dispatch(action: NLAction, ports: ExecutorPorts, report: ExecutionReport): Dispatched {
    switch (action.kind) {
        case 'command': return runCommand(action.intent, ports, report);
        case 'guidance': return runGuidance(action.guidance, ports, report);
        case 'group': return runGroup(action.group, ports, report);
        case 'camera': return runCamera(action.camera, ports);
        case 'ui': return runUi(action.ui, ports);
        case 'query': return runQuery(action.query, ports);
        case 'refuse': return no(action.reason);
    }
}

// ───────────────────────────── command ─────────────────────────────

function runCommand(
    intent: NLCommandIntent, ports: ExecutorPorts, report: ExecutionReport,
): Dispatched {
    const { resolver } = ports;

    // An on-sight trigger has no wire slot: `WhenCondition` has no sighting
    // case and the sim evaluates no sighting predicate. Sending the directive
    // without its condition would be an order that fires immediately — the
    // opposite of what was asked — so it is refused by name.
    if (intent.standing) {
        return no(
            `"If you see ${intent.standing.onSight}…" needs a standing on-sight trigger, ` +
            `which the sim has no slot for yet — nothing sent.`);
    }

    if (!intent.target) {
        return no(`"${intent.verb}" needs a place I know — name a region or objective.`);
    }

    // Target first: a class-count subject ranks its candidates by distance TO
    // the target, so the target has to exist before the subject is chosen.
    const target = resolver.resolveTarget(intent.verb, intent.target);
    if (target.kind !== 'ok') return target as Dispatched;

    const when = intent.when ? resolver.resolveWhen(intent.when) : ({ kind: 'ok', value: undefined } as const);
    if (when.kind !== 'ok') return when as Dispatched;

    const priority = resolver.resolvePriority(intent.priority);
    const targetPos = targetPosition(target.value);

    // ── class-count fans out: one directive per resolved group (§1) ──
    if (intent.subject.type === 'class-count') {
        const resolved = resolver.resolveClassCount(intent.subject, targetPos);
        if (resolved.kind !== 'ok') return resolved as Dispatched;

        const lines: string[] = [];
        for (const group of resolved.value.groups) {
            const one = commitIntent(
                { verb: intent.verb, subject: { type: 'group', groupId: group.groupId }, target: target.value,
                  priority, ...(when.value ? { when: when.value } : {}) },
                ports, report,
            );
            if (one.kind !== 'ok') return one;
            lines.push(`${group.name || `Group ${group.groupId}`} — ${one.value[0]}`);
        }
        return done(...lines);
    }

    const subject = resolver.resolveSingleSubject(intent.subject);
    if (subject.kind !== 'ok') return subject as Dispatched;

    return commitIntent(
        { verb: intent.verb, subject: subject.value, target: target.value, priority,
          ...(when.value ? { when: when.value } : {}) },
        ports, report,
    );
}

/**
 * Validate → compile → send ONE intent. The single place in the NL stack that
 * hands anything to `sendCommand`, so the "one command path" rule is checkable
 * by reading one function.
 */
function commitIntent(
    intent: CommandIntent & { subject: CommandSubject; target: CommandTarget; when?: WhenCondition },
    ports: ExecutorPorts, report: ExecutionReport,
): Dispatched {
    const invalid = validateIntent(intent);
    if (invalid) return no(`${invalid}. Nothing sent.`);

    const command = compileIntent(intent);
    if (!command) return no(`I can't turn "${intent.verb}" on that target into an order. Nothing sent.`);

    ports.sendCommand(command);
    report.sent.push(command);

    return done(describeSent(command, intent));
}

/** What the player is told actually happened — caveats included. */
function describeSent(command: CompiledMessage, intent: CommandIntent): string {
    const band = getPriorityBand(intent.priority);

    if (command.type === 'AIGuidance') {
        // The guidance store paints regions and sets stances; it does not take
        // directives. Echo the store write, not the sentence.
        return `${aiGuidanceToWire(command.payload).describe} (${band} priority)`;
    }

    const base = command.type === 'StandingOrder' ? 'standing order set' : 'directive issued';
    if (command.type === 'GroupDirective' && command.payload.groupId) {
        return `${base} · ${band} priority`;
    }

    // No group id means the sim takes whatever idles; an `idle-filter` subject
    // compiles to exactly the same thing, because neither
    // `GroupDirectivePayload` nor `StandingOrderPayload` has a slot for
    // `filterClass`. Saying "directive issued" alone would imply a filter that
    // isn't applied — the same caveat the M0 console printed.
    return intent.subject.type === 'idle-filter'
        ? `${base} · ${band} priority (team-wide — the idle-class filter has no wire slot yet)`
        : `${base} · ${band} priority (team-wide — no group named)`;
}

function targetPosition(target: CommandTarget): { x: number; z: number } | undefined {
    if (target.point) return target.point;
    if (target.area) return { x: target.area.x, z: target.area.z };
    if (target.entity) return { x: target.entity.x, z: target.entity.z };
    return undefined;
}

// ───────────────────────────── guidance ─────────────────────────────

/**
 * A guidance op → `game_ai_guidance.lua`. Encoded with the gadget's own codec
 * and posted as a `LuaRulesMsg` through `sendCommand`, so it passes the same
 * spectator gate as everything else (the gadget then re-validates the writer's
 * team membership — two independent checks, neither trusting the other).
 */
function runGuidance(
    guidance: NLGuidance, ports: ExecutorPorts, report: ExecutionReport,
): Dispatched {
    const resolved = ports.resolver.resolveGuidance(guidance);
    if (resolved.kind !== 'ok') return resolved as Dispatched;

    const message = encodeGuidance(resolved.value);
    if (!message) {
        return no(`I couldn't build a '${guidance.op}' guidance message from that. Nothing sent.`);
    }

    const command = { type: 'LuaRulesMsg' as const, data: message.wire };
    ports.sendCommand(command);
    report.sent.push(command);

    return done(message.describe);
}

// ─────────────────────────────── group ───────────────────────────────

/** The selected group as a plain id, via the resolver's own `selection`
 *  subject rule — so "this group" can't come to mean two different things in
 *  two different verbs. */
function selectionGroupId(ports: ExecutorPorts): Resolution<number> {
    const subject = ports.resolver.resolveSingleSubject({ type: 'selection' });
    if (subject.kind !== 'ok') return subject as Resolution<number>;
    const groupId = subject.value.type === 'group' ? subject.value.groupId : 0;
    if (!groupId) return { kind: 'refuse', reason: 'Nothing is selected — select a group first.' };
    return { kind: 'ok', value: groupId };
}

function runGroup(group: NLGroupAction, ports: ExecutorPorts, report: ExecutionReport): Dispatched {
    if (group.op === 'rename') {
        // No groupRef = "this group" = the selection, resolved through the same
        // subject path an unqualified order uses, so "name this group X" and
        // "defend Northgate" agree on what "this" means — and produce the same
        // "nothing is selected" refusal when it means nothing.
        const id = group.groupRef !== undefined
            ? ports.resolver.resolveGroupId(group.groupRef)
            : selectionGroupId(ports);
        if (id.kind !== 'ok') return id as Dispatched;

        // The existing OrgGroup update case (integration.ts): empty add/remove
        // lists plus a name is a pure rename, which is what the wire field was
        // always for — nothing new is needed on the server.
        const command = {
            type: 'OrgGroup' as const, action: 'update' as const, groupId: id.value,
            addIds: [], removeIds: [], name: group.name,
        };
        ports.sendCommand(command);
        report.sent.push(command);

        return done(`group ${id.value} is now "${group.name}"`);
    }

    // Forming a group costs authority and interacts with AI asset locks (§5:
    // "never auto-form"), and there is no unit-name index to resolve
    // `memberRefs` against. Refused until M2 gives it a real path.
    return no(
        `Creating a group from a sentence isn't wired up yet — make it in the org panel, ` +
        `then say "name this group ${group.name}".`);
}

// ──────────────────────── camera / ui / query ────────────────────────

/** One port result → one dispatch outcome. The port already chose the words;
 *  this only lifts them into the console-line shape. */
function fromPort(result: PortResult): Dispatched {
    return result.kind === 'ok' ? done(result.value) : result as Dispatched;
}

function runCamera(camera: NLCameraAction, ports: ExecutorPorts): Dispatched {
    const port = ports.camera;
    if (!port) return no(`Camera control isn't wired up yet — "${camera.op}" not yet supported.`);
    return fromPort(port.apply(camera));
}

function runUi(ui: NLUiAction, ports: ExecutorPorts): Dispatched {
    const port = ports.uiActions;
    if (!port) return no(`Panel control isn't wired up yet — "${ui.op} ${ui.panelId}" not yet supported.`);
    return fromPort(port.apply(ui));
}

function runQuery(query: NLQuery, ports: ExecutorPorts): Dispatched {
    const port = ports.queryEngine;
    if (!port) return no(`I can't answer questions yet — "${query.op}" not yet supported.`);
    return fromPort(port.answer(query));
}
