/**
 * console-exchange.ts — one typed sentence → one decided outcome
 * (PLAN-metalstorm-command-language.md M0)
 *
 * The command console's brain. `planUtterance()` takes what the player typed
 * and returns exactly what should happen and what the console should say back
 * — it never touches the DOM and never sends anything itself, so the widget
 * (`client/src/native-widgets/command-console.js`) stays DOM + wiring and this
 * whole layer is testable without a browser.
 *
 * Rules of engagement (plan §1, §4):
 *  - Nothing is ever silently dropped. Every utterance produces either a
 *    `sent` outcome with a compiled message, or a `refused` outcome carrying
 *    the reason in words the player can act on.
 *  - No verb ⇒ refusal, never a no-op. A sentence the slot-filler can't place
 *    a verb in is not a command, and pretending otherwise is how a player ends
 *    up believing an order was given.
 *  - Words the parser didn't claim are reported verbatim ("didn't understand:
 *    'quickly'") rather than quietly ignored — the accelerator's own
 *    transparency contract, surfaced instead of buried in a tooltip.
 *  - `compile-table.ts` remains the single source of truth for verbs, target
 *    shapes and which message a sentence becomes. This module chooses no
 *    directive types of its own.
 *
 * M0 is the LOCAL path only (no LLM). The same outcome shape is what the M1
 * envelope executor will produce, so the console's rendering doesn't change
 * when the proxy lands.
 */

import {
    compileIntent, validateIntent, getPriorityBand,
    type CommandIntent, type CommandSubject, type CommandTarget,
    type CompiledMessage, type CommandVerb,
} from './compile-table.js';
import { acceleratorFill, type AcceleratorSearchIndex } from './free-text-accelerator.js';
import type { ClassVocabulary } from './class-vocabulary.js';

/** Priority used when the sentence names no band — matches the composer's
 *  slider default, so a typed order and a composed one agree. */
const DEFAULT_PRIORITY = 50;

/** The verbs the parser knows, for the "I didn't hear a verb" refusal. Kept in
 *  the same order as `compile-table.ts`'s `CommandVerb` union. */
const VERB_LIST: CommandVerb[] = [
    'attack', 'secure', 'defend', 'hold', 'patrol',
    'screen', 'scout', 'escort', 'withdraw', 'reinforce', 'build',
];

export interface ExchangeDeps {
    /** Live named-entity index (regions / objectives / org groups). */
    index: AcceleratorSearchIndex;
    /** Shipped class vocabulary (`class-vocabulary.json`). */
    vocabulary: ClassVocabulary;
    /**
     * Group the player currently has selected, or null. Used only when the
     * sentence names no subject — the same "selection pre-fills the Subject"
     * rule the composer follows (PLAN-metalstorm-scripting task 4), so the two
     * command surfaces interpret an unqualified order identically.
     */
    selectionGroupId?: number | null;
    /** Display name for a group id ("Chimera Squad"); defaults to "Group N". */
    groupLabel?: (groupId: number) => string;
}

export type ExchangeOutcome =
    | {
          kind: 'sent';
          /** The `game:` line to render. */
          text: string;
          /** Hand this to `ctx.sendCommand` — the normal, authority-charged path. */
          command: CompiledMessage;
          /** Transparency hints ("didn't understand: 'quickly'"). */
          notes: string[];
          intent: CommandIntent;
      }
    | {
          kind: 'refused';
          text: string;
          notes: string[];
          /** Machine-readable reason, for tests and later telemetry. */
          reason:
              | 'empty'
              | 'no-verb'
              | 'no-target'
              | 'invalid-intent'
              | 'uncompilable'
              | 'unsupported-target';
      };

/** "didn't understand: 'quickly', 'please'" — the accelerator's `unmatched`,
 *  rendered as the plan's transparency line. */
function unmatchedNote(unmatched: string[]): string[] {
    if (unmatched.length === 0) return [];
    return [`didn't understand: ${unmatched.map((w) => `'${w}'`).join(', ')}`];
}

function describeSubject(
    subject: CommandSubject,
    deps: ExchangeDeps,
    scale: number | null,
    fromSelection: boolean,
): string {
    if (subject.type === 'ai') return 'the AI';
    if (subject.type === 'idle-filter') {
        const cls = subject.filterClass ?? '';
        const entry = deps.vocabulary.data.classes?.[cls];
        const name = entry?.plural || entry?.display || cls;
        const scaleWord = scale ? ['light ', 'line ', 'heavy ', 'super-heavy '][scale - 1] : '';
        return `idle ${scaleWord}${name}`;
    }
    if (!subject.groupId) return 'whatever is free';
    const label = deps.groupLabel?.(subject.groupId) || `Group ${subject.groupId}`;
    return fromSelection ? `${label} (selected)` : label;
}

function describeTarget(target: CommandTarget): string {
    if (target.entity) return target.entity.name;
    if (target.point) return `(${Math.round(target.point.x)}, ${Math.round(target.point.z)})`;
    if (target.area) return `the area at (${Math.round(target.area.x)}, ${Math.round(target.area.z)})`;
    if (target.route) return `a ${target.route.length}-point route`;
    return 'somewhere';
}

/**
 * What the player should be told the compiled message actually did.
 *
 * The caveats matter more than the verb. A subject that isn't a specific group
 * compiles to a team-wide order (groupId 0 / a standing order), and an
 * `idle-filter` subject compiles to exactly the same thing as no subject at
 * all: `compile-table.ts` has no wire slot for `filterClass`, so "idle heavy
 * tanks" reaches the sim as "any force". Echoing a plain "directive issued"
 * there would let the player believe a filter is being applied that isn't.
 */
function describeOutcome(command: CompiledMessage, subject: CommandSubject): string {
    const base = command.type === 'GroupDirective' ? 'directive issued'
        : command.type === 'StandingOrder' ? 'standing order set'
        : 'sent';

    if (command.type === 'GroupDirective' && command.payload.groupId) return base;
    if (subject.type === 'idle-filter') {
        return `${base} (team-wide — the idle-class filter has no wire slot yet)`;
    }
    return `${base} (team-wide — no group selected)`;
}

/**
 * Decide what one typed sentence does.
 *
 * Pure: no DOM, no network, no store reads — everything it needs arrives in
 * `deps`. The caller sends `outcome.command` (when present) through the normal
 * `sendCommand` choke-point, which is where spectator gating and the authority
 * charge live; nothing here bypasses either.
 */
export function planUtterance(utterance: string, deps: ExchangeDeps): ExchangeOutcome {
    const text = utterance.trim();
    if (!text) {
        return { kind: 'refused', reason: 'empty', notes: [], text: 'Say something like "defend Northgate".' };
    }

    const parsed = acceleratorFill(text, deps.index, deps.vocabulary);
    const notes = unmatchedNote(parsed.unmatched);

    // ── No verb ⇒ visible refusal (plan §4: never a silent no-op) ──
    if (!parsed.verb) {
        return {
            kind: 'refused',
            reason: 'no-verb',
            notes,
            text: `I didn't hear an order in that. Verbs I know: ${VERB_LIST.join(', ')}. ` +
                  `Try "defend Northgate" or "3rd Armoured attack Slag Forge high".`,
        };
    }

    // ── Subject: what was said > what is selected > the whole team ──
    // A group id of 0 is the compile table's "condition-scoped" subject, which
    // the server accepts (ClientMessageHandler: `groupId != 0` is the only
    // ownership check) — so an unqualified order still executes rather than
    // being refused for not naming a squad. Which of the three it was is
    // always stated in the echo.
    const fromSelection = !parsed.subject && deps.selectionGroupId != null;
    const subject: CommandSubject = parsed.subject
        ?? (deps.selectionGroupId != null
            ? { type: 'group', groupId: deps.selectionGroupId }
            : { type: 'group', groupId: 0 });

    // ── Target ──
    if (!parsed.target) {
        const leftovers = parsed.unmatched.length
            ? ` Nothing on the board matches ${parsed.unmatched.map((w) => `'${w}'`).join(', ')}.`
            : '';
        return {
            kind: 'refused',
            reason: 'no-target',
            notes: [],
            text: `"${parsed.verb}" needs a place I know.${leftovers} Name a region or objective, ` +
                  `e.g. "${parsed.verb} Northgate".`,
        };
    }

    const intent: CommandIntent = {
        verb: parsed.verb,
        subject,
        target: parsed.target,
        priority: parsed.priority ?? DEFAULT_PRIORITY,
        ...(parsed.when ? { when: parsed.when } : {}),
    };

    const invalid = validateIntent(intent);
    if (invalid) {
        return { kind: 'refused', reason: 'invalid-intent', notes, text: `${invalid}. Nothing sent.` };
    }

    const command = compileIntent(intent);
    if (!command) {
        return {
            kind: 'refused',
            reason: 'uncompilable',
            notes,
            text: `I can't turn "${parsed.verb} ${describeTarget(parsed.target)}" into an order. Nothing sent.`,
        };
    }

    // AIGuidance has no sim target yet — `createSendCommand` logs it and drops
    // it (integration.ts, interaction §6 not implemented). Sending it anyway
    // would render as a success line for an order that never happened, so it
    // is refused here, out loud, until the M1 guidance bridge lands.
    if (command.type === 'AIGuidance') {
        return {
            kind: 'refused',
            reason: 'unsupported-target',
            notes,
            text: 'Orders to the AI aren\'t wired to the guidance store yet — nothing sent. ' +
                  'Use the AI Command panel, or name a group.',
        };
    }

    const subjectText = describeSubject(subject, deps, parsed.subjectScale, fromSelection);
    const band = getPriorityBand(intent.priority);
    const whenText = parsed.when
        ? parsed.when.type === 'under-attack'
            ? ', when under attack'
            : parsed.when.type === 'region-contested'
            ? ', when contested'
            : ''
        : '';

    return {
        kind: 'sent',
        command,
        intent,
        notes,
        text: `${subjectText} — ${parsed.verb} ${describeTarget(parsed.target)} · ` +
              `${band} priority${whenText} → ${describeOutcome(command, subject)}.`,
    };
}
