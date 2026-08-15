/**
 * nl-envelope.ts — the JSON contract an external LLM emits, and its validator
 * (PLAN-metalstorm-command-language.md §1, milestone M1)
 *
 * This file is THE CONTRACT. Everything downstream — the executor, the
 * resolver, the offline-parser adapter, and (from M4) the server proxy's
 * structured-output schema — is checked against `validateNLResponse()`. If a
 * shape isn't accepted here, it cannot execute, no matter who emitted it.
 *
 * Design pillar 1, "the LLM parses, never executes": the envelope is UNTRUSTED
 * input. It carries no coordinates it didn't get from the context payload, no
 * entity ids, no Lua, no console commands, no free-form strings that reach a
 * command path. Every reference is a NAME the client resolves against the live
 * index (pillar 4) — a hallucinated or stale id can never execute because there
 * is nowhere in this schema to put one.
 *
 * The closed vocabularies are IMPORTED, never restated:
 *   - verbs + target shapes ← `compile-table.ts` (`TARGET_SHAPES_BY_VERB`)
 *   - unit classes / roles  ← the shipped `class-vocabulary.json`
 *   - guidance ops + values ← `game_ai_guidance.lua`'s own accepted sets,
 *     mirrored in `GUIDANCE_VALUES` below and pinned to the gadget source by
 *     `nl-envelope.test.ts` (which greps the Lua file and fails on drift —
 *     the same anti-drift trick class-vocabulary.test.ts plays on the unit
 *     defs). The GADGET is the truth, not this plan's prose: e.g. the plan
 *     writes ROE as "free/observed_only/deny_area" and the gadget agrees, but
 *     it is the gadget that decides.
 *
 * Zero runtime dependencies beyond those tables: no DOM, no fetch, no store.
 * A validator that needs a live game cannot guard the proxy.
 */

import { TARGET_SHAPES_BY_VERB, type CommandVerb } from './compile-table.js';
import type { ClassVocabulary } from './class-vocabulary.js';

// ─────────────────────────── the envelope ───────────────────────────

/** Symbolic priority bands — mapped to `PRIORITY_BANDS` numbers downstream. */
export type NLPriority = 'low' | 'normal' | 'high' | 'urgent';

/** `ms_scale` values (1 Light … 4 Super-heavy — `units/_builder.lua`). */
export type NLScale = 1 | 2 | 3 | 4;

/**
 * Who executes. Names and classes only — never ids.
 *
 * `any` is not in the plan's §1 sketch and is added deliberately: it is the
 * compile table's condition-scoped subject (`groupId: 0`, "take whatever
 * idles"), which is what an unqualified order like "defend Northgate" with
 * nothing selected has ALWAYS compiled to — in the composer, in the M0 console,
 * and here. Without a name for it, the offline-parser adapter would have to
 * misrepresent that order as a `selection` (a lie when nothing is selected) or
 * refuse an order the game accepts. The executor echoes "team-wide" for it so
 * the player is never left thinking a specific squad was tasked.
 */
export type NLSubject =
    | { type: 'entity-ref'; name: string }
    | { type: 'class-count'; class: string; count: number; scale?: NLScale }
    | { type: 'idle-filter'; filterClass: string }
    | { type: 'selection' }
    | { type: 'any' }
    | { type: 'ai' };

/** Where to act. `point` is only legal for coordinates the CONTEXT supplied. */
export type NLTarget =
    | { type: 'entity-ref'; name: string }
    | { type: 'point'; x: number; z: number }
    | { type: 'area-around'; name: string; radius?: number };

/**
 * The when-gate, symbolic: regions and objectives by NAME, resolved
 * client-side into `compile-table.ts`'s `WhenCondition` (which is id-keyed).
 * Same five cases as the composer's closed WHEN menu — no new conditions are
 * invented here, because a condition the sim can't evaluate is a lie.
 */
export type NLWhen =
    | { type: 'now' }
    | { type: 'under-attack' }
    | { type: 'region-contested'; regionRef: string }
    | { type: 'objective-complete'; objectiveRef: string }
    | { type: 'strength-below'; percent: number };

export interface NLCommandIntent {
    verb: CommandVerb;
    subject: NLSubject;
    target?: NLTarget;
    priority?: NLPriority;
    when?: NLWhen;
    /**
     * "If you see chimera squad, follow it." Structurally valid and validated
     * here so the LLM has somewhere honest to put it, but there is NO wire slot
     * for an on-sight trigger yet (`WhenCondition` has no such case, and the
     * sim evaluates no sighting predicate) — the executor refuses it out loud
     * rather than sending a directive that silently drops the condition.
     */
    standing?: { onSight: string };
}

/**
 * Ops the guidance gadget accepts. Deliberately the gadget's own `guidance.*`
 * RecvLuaMsg verb list (game_ai_guidance.lua's `RecvLuaMsg` dispatch), minus
 * the `guidance.` prefix.
 */
export type NLGuidanceOp = 'stance' | 'paint' | 'lock' | 'delegate' | 'fund' | 'roe' | 'veto';

export interface NLGuidance {
    op: NLGuidanceOp;
    /** Closed per-op value set — see `GUIDANCE_VALUES`. */
    value?: string;
    /** Region NAME (resolved to the gadget's `regionKey`). */
    regionRef?: string;
    /** Group NAME (resolved to a numeric `groupId`). */
    groupRef?: string;
    /** Objective NAME (resolved to a numeric `objectiveId`). */
    objectiveRef?: string;
    /**
     * AI goal id for `veto`. Not in the plan's §1 sketch, but the gadget's
     * `guidance.veto` handler takes a `goalId` and there is nowhere else to put
     * it — goal ids come from the AI's own proposals (ai-command-panel), so
     * this is one of the few refs that is legitimately a number-as-string.
     */
    goalRef?: string;
    /** One-shot authority transfer (`guidance.fund` amount). */
    amount?: number;
    /** Standing funding rate cap (`guidance.fund` rateCap). */
    rateCap?: number;
}

/** STUB in M1 — the CameraPort lands in M3. Validated, then refused by the
 *  executor while no port is injected, so a camera envelope never looks sent. */
export type NLCameraAction =
    | { op: 'focus'; targetRef: string }
    | { op: 'follow'; targetRef: string }
    | { op: 'fitMap' }
    | { op: 'zoom'; dir: 'in' | 'out' }
    | { op: 'saveView'; slot: number }
    | { op: 'loadView'; slot: number };

/** STUB in M1 — the ui-action-registry lands in M3. `panelId` is checked
 *  against the registry only once one exists; here it is charset/length-capped
 *  like any other untrusted string. */
export type NLUiAction = { op: 'open' | 'close' | 'toggle' | 'fullscreen'; panelId: string };

/** STUB in M1 — the LOS-honest query engine lands in M3. */
export type NLQuery =
    | { op: 'count'; class: string; scale?: NLScale; side: 'own' | 'enemy' | 'ally' }
    | { op: 'locate'; targetRef: string; side?: 'own' | 'enemy' }
    | { op: 'status'; subjectRef: string }
    | { op: 'resources' }
    | { op: 'objectives' };

/**
 * "Name this group Hammerfall" → the existing OrgGroup update case.
 *
 * `groupRef` is OPTIONAL on a rename, and its absence means "the group that is
 * selected" — the same thing `NLSubject`'s `selection` type means, and for the
 * same reason. "Name THIS group Hammerfall" is the phrasing a player actually
 * uses, and the alternative (looking up the selected group's current name and
 * shipping that as the ref) would round-trip id → name → id through a fuzzy
 * search just to arrive back where it started, with a chance of landing on a
 * different group on the way. The envelope stays id-free either way.
 */
export type NLGroupAction =
    | { op: 'create'; name: string; memberRefs?: string[] }
    | { op: 'rename'; groupRef?: string; name: string };

export type NLAction =
    | { kind: 'command'; intent: NLCommandIntent }
    | { kind: 'guidance'; guidance: NLGuidance }
    | { kind: 'camera'; camera: NLCameraAction }
    | { kind: 'ui'; ui: NLUiAction }
    | { kind: 'query'; query: NLQuery }
    | { kind: 'group'; group: NLGroupAction }
    | { kind: 'refuse'; reason: string };

export interface NLClarification {
    question: string;
    /** Rendered as chips; picking one resubmits. */
    options?: string[];
    /**
     * How many options the answer needs. Omitted ⇒ one.
     *
     * Added in M5, for the one question that genuinely takes a plural answer:
     * "you have four idle tank squads and asked for two — which two?". Without
     * it the console would have to guess whether chips are radio buttons or
     * checkboxes, and a one-at-a-time flow would ask the same question again
     * for the second pick, which is how a two-tap interaction becomes four.
     *
     * Never larger than `options.length`, and never larger than `MAX_ACTIONS`
     * — a pick that cannot fit in an envelope is a question with no answer.
     */
    pick?: number;
}

export interface NLResponse {
    actions: NLAction[];
    /** Short spoken acknowledgement ("Moving 2 tank squads to Randtown"). */
    say?: string;
    /** Present ⇒ `actions` MUST be empty (asking and acting are exclusive). */
    clarify?: NLClarification;
}

// ─────────────────────── closed vocabularies ───────────────────────

export const NL_ACTION_KINDS = [
    'command', 'guidance', 'camera', 'ui', 'query', 'group', 'refuse',
] as const;

export const NL_PRIORITIES: readonly NLPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Max actions in one envelope (plan §1 "0..4"). A longer list is a runaway
 *  model, not a multi-step plan. */
export const MAX_ACTIONS = 4;

/** Chips the console will render for one question. Past about this many, a
 *  question stops being a choice and becomes a list to read — name the squad
 *  instead. `cancel` counts against it. */
export const MAX_CLARIFY_OPTIONS = 6;

/** Every untrusted free string (names, questions, reasons) is capped. Plan §9.7
 *  prompt-injection hygiene: names are DATA, and data has a size. */
export const MAX_REF_LENGTH = 64;
export const MAX_TEXT_LENGTH = 400;

/**
 * Characters a NAME may contain. Letters/digits/space plus the punctuation that
 * shows up in real callsigns and place names (`Hammerfall`, `Osprey Fen`,
 * `Fallow Gate #2`, `Sector B9`, `Al-Qarah`, `O'Rourke`). Everything a wire or
 * a renderer would have to escape — `&`, `=`, `,`, `%`, `<`, `>`, quotes,
 * braces, newlines — is out, so a name can neither forge a `parley/wire.lua`
 * field nor smuggle markup into the transcript.
 */
const NAME_CHARSET = /^[\w \-'.#/()]+$/;

/**
 * The guidance gadget's own accepted value sets — game_ai_guidance.lua's
 * `STANCES` / `PAINTS` / `ROES` tables, mirrored. `nl-envelope.test.ts` parses
 * those tables straight out of the Lua source and fails if this disagrees, so
 * the gadget stays the single source of truth for what it will accept.
 *
 * `lock` and `delegate` are on/off toggles: the gadget reads
 * `fields.locked == '1'` / `fields.delegated ~= '0'`, and 'on'/'off' is the
 * client-side spelling `guidance-wire.ts` converts to those flags.
 */
export const GUIDANCE_VALUES: Readonly<Partial<Record<NLGuidanceOp, readonly string[]>>> = {
    stance: ['defensive', 'balanced', 'aggressive'],
    paint: ['priority', 'normal', 'forbidden'],
    roe: ['free', 'observed_only', 'deny_area'],
    lock: ['on', 'off'],
    delegate: ['on', 'off'],
};

export const NL_GUIDANCE_OPS: readonly NLGuidanceOp[] = [
    'stance', 'paint', 'lock', 'delegate', 'fund', 'roe', 'veto',
];

/**
 * Exported since M4: `nl-schema.ts` builds the proxy's JSON schema from these
 * lists rather than restating them. A closed vocabulary that the validator and
 * the schema each spell out separately is a vocabulary with two versions, and
 * the one the model is told about is the one that would silently win.
 */
export const CAMERA_OPS = ['focus', 'follow', 'fitMap', 'zoom', 'saveView', 'loadView'] as const;
export const UI_OPS = ['open', 'close', 'toggle', 'fullscreen'] as const;
export const QUERY_OPS = ['count', 'locate', 'status', 'resources', 'objectives'] as const;
export const SIDES = ['own', 'enemy', 'ally'] as const;
export const GROUP_OPS = ['create', 'rename'] as const;
export const SUBJECT_TYPES = ['entity-ref', 'class-count', 'idle-filter', 'selection', 'any', 'ai'] as const;
export const TARGET_TYPES = ['entity-ref', 'point', 'area-around'] as const;
export const WHEN_TYPES = [
    'now', 'under-attack', 'region-contested', 'objective-complete', 'strength-below',
] as const;
export const NL_SCALES = [1, 2, 3, 4] as const;

export const COMMAND_VERBS = Object.keys(TARGET_SHAPES_BY_VERB) as CommandVerb[];

// ───────────────────────────── validation ─────────────────────────────

export interface ValidateOptions {
    /**
     * Loaded `class-vocabulary.json`. When omitted, class/role names are only
     * charset-checked, not membership-checked — the proxy and the tests always
     * pass one; a client whose vocabulary failed to load would otherwise refuse
     * every class-count order with a vocabulary error rather than a real one.
     */
    vocabulary?: ClassVocabulary;
    /** Known `ui` panel ids. Omitted in M1 (no registry yet) ⇒ charset only. */
    panelIds?: readonly string[];
}

export type ValidationResult =
    | { ok: true; value: NLResponse }
    | { ok: false; errors: string[] };

/**
 * Validate an untrusted envelope. Structural + closed-vocabulary, in the style
 * of `compileIntent`/`validateIntent`: it returns EVERY problem it found rather
 * than the first, because the proxy logs these and a one-error-at-a-time
 * validator makes a bad prompt take five round-trips to diagnose.
 *
 * A `false` result means the console prints a refusal. It never means "execute
 * the parts that were fine" — a partially-understood sentence is exactly the
 * case where guessing moves the wrong army.
 */
export function validateNLResponse(input: unknown, opts: ValidateOptions = {}): ValidationResult {
    const errors: string[] = [];
    const push = (msg: string) => { if (errors.length < 20) errors.push(msg); };

    if (!isPlainObject(input)) {
        return { ok: false, errors: ['response is not an object'] };
    }

    // ── say ──
    if (input.say !== undefined) {
        if (typeof input.say !== 'string') push('say must be a string');
        else if (input.say.length > MAX_TEXT_LENGTH) push(`say exceeds ${MAX_TEXT_LENGTH} chars`);
    }

    // ── clarify ──
    let hasClarify = false;
    if (input.clarify !== undefined) {
        hasClarify = true;
        const c = input.clarify;
        if (!isPlainObject(c)) {
            push('clarify must be an object');
        } else {
            if (typeof c.question !== 'string' || !c.question.trim()) {
                push('clarify.question must be a non-empty string');
            } else if (c.question.length > MAX_TEXT_LENGTH) {
                push(`clarify.question exceeds ${MAX_TEXT_LENGTH} chars`);
            }
            if (c.options !== undefined) {
                if (!Array.isArray(c.options)) push('clarify.options must be an array');
                else if (c.options.length > MAX_CLARIFY_OPTIONS) {
                    push(`clarify.options has more than ${MAX_CLARIFY_OPTIONS} entries`);
                } else c.options.forEach((o, i) => {
                    if (typeof o !== 'string' || !o.trim()) push(`clarify.options[${i}] must be a non-empty string`);
                    else if (o.length > MAX_REF_LENGTH) push(`clarify.options[${i}] exceeds ${MAX_REF_LENGTH} chars`);
                });
            }
            // A `pick` the options can't satisfy is a question with no answer,
            // and one above MAX_ACTIONS is an answer no envelope can hold.
            if (c.pick !== undefined) {
                const options = Array.isArray(c.options) ? c.options.length : 0;
                if (typeof c.pick !== 'number' || !Number.isInteger(c.pick) || c.pick < 1) {
                    push('clarify.pick must be an integer of at least 1');
                } else if (c.pick > MAX_ACTIONS) {
                    push(`clarify.pick exceeds ${MAX_ACTIONS} (the action ceiling)`);
                } else if (c.pick > options) {
                    push(`clarify.pick is ${c.pick} but only ${options} options were offered`);
                }
            }
        }
    }

    // ── actions ──
    if (!Array.isArray(input.actions)) {
        push('actions must be an array');
    } else {
        if (input.actions.length > MAX_ACTIONS) {
            push(`actions has ${input.actions.length} entries (max ${MAX_ACTIONS})`);
        }
        // Asking and acting are exclusive: a question that also fires an order
        // means the player is asked about something already done.
        if (hasClarify && input.actions.length > 0) {
            push('clarify is present, so actions must be empty');
        }
        if (!hasClarify && input.actions.length === 0) {
            push('actions is empty and there is no clarify — nothing would happen');
        }
        input.actions.forEach((action, i) => validateAction(action, `actions[${i}]`, opts, push));
    }

    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: input as unknown as NLResponse };
}

function validateAction(
    action: unknown, path: string, opts: ValidateOptions, push: (m: string) => void,
): void {
    if (!isPlainObject(action)) { push(`${path} is not an object`); return; }
    const kind = action.kind;
    if (typeof kind !== 'string' || !(NL_ACTION_KINDS as readonly string[]).includes(kind)) {
        push(`${path}.kind ${JSON.stringify(kind)} is not one of ${NL_ACTION_KINDS.join('|')}`);
        return;
    }

    switch (kind) {
        case 'command': return validateCommand(action.intent, `${path}.intent`, opts, push);
        case 'guidance': return validateGuidance(action.guidance, `${path}.guidance`, push);
        case 'camera': return validateCamera(action.camera, `${path}.camera`, push);
        case 'ui': return validateUi(action.ui, `${path}.ui`, opts, push);
        case 'query': return validateQuery(action.query, `${path}.query`, opts, push);
        case 'group': return validateGroup(action.group, `${path}.group`, push);
        case 'refuse':
            if (typeof action.reason !== 'string' || !action.reason.trim()) {
                push(`${path}.reason must be a non-empty string`);
            } else if (action.reason.length > MAX_TEXT_LENGTH) {
                push(`${path}.reason exceeds ${MAX_TEXT_LENGTH} chars`);
            }
            return;
    }
}

function validateCommand(
    intent: unknown, path: string, opts: ValidateOptions, push: (m: string) => void,
): void {
    if (!isPlainObject(intent)) { push(`${path} is not an object`); return; }

    // Verb — the compile table's closed vocabulary, imported not restated.
    if (typeof intent.verb !== 'string' || !COMMAND_VERBS.includes(intent.verb as CommandVerb)) {
        push(`${path}.verb ${JSON.stringify(intent.verb)} is not a known verb (${COMMAND_VERBS.join(', ')})`);
    }

    // Subject
    const subject = intent.subject;
    if (!isPlainObject(subject)) {
        push(`${path}.subject is not an object`);
    } else {
        switch (subject.type) {
            case 'entity-ref':
                checkRef(subject.name, `${path}.subject.name`, push);
                break;
            case 'class-count': {
                checkClass(subject.class, `${path}.subject.class`, opts, push);
                const n = subject.count;
                if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 16) {
                    push(`${path}.subject.count must be an integer 1..16`);
                }
                checkScale(subject.scale, `${path}.subject.scale`, push);
                break;
            }
            case 'idle-filter':
                checkClass(subject.filterClass, `${path}.subject.filterClass`, opts, push);
                break;
            case 'selection':
            case 'any':
            case 'ai':
                break;
            default:
                push(`${path}.subject.type ${JSON.stringify(subject.type)} is not a known subject type`);
        }
    }

    // Target — optional in the schema (a verb with no target is caught by
    // `validateIntent` after resolution, where the verb:shape table lives).
    if (intent.target !== undefined) {
        const t = intent.target;
        if (!isPlainObject(t)) {
            push(`${path}.target is not an object`);
        } else {
            switch (t.type) {
                case 'entity-ref':
                    checkRef(t.name, `${path}.target.name`, push);
                    break;
                case 'point':
                    checkCoord(t.x, `${path}.target.x`, push);
                    checkCoord(t.z, `${path}.target.z`, push);
                    break;
                case 'area-around':
                    checkRef(t.name, `${path}.target.name`, push);
                    if (t.radius !== undefined) {
                        if (typeof t.radius !== 'number' || !Number.isFinite(t.radius)
                            || t.radius <= 0 || t.radius > 20000) {
                            push(`${path}.target.radius must be a number in (0, 20000]`);
                        }
                    }
                    break;
                default:
                    push(`${path}.target.type ${JSON.stringify(t.type)} is not a known target type`);
            }
        }
    }

    // Priority
    if (intent.priority !== undefined
        && !NL_PRIORITIES.includes(intent.priority as NLPriority)) {
        push(`${path}.priority ${JSON.stringify(intent.priority)} is not one of ${NL_PRIORITIES.join('|')}`);
    }

    // When
    if (intent.when !== undefined) {
        const w = intent.when;
        if (!isPlainObject(w)) {
            push(`${path}.when is not an object`);
        } else {
            switch (w.type) {
                case 'now':
                case 'under-attack':
                    break;
                case 'region-contested':
                    checkRef(w.regionRef, `${path}.when.regionRef`, push);
                    break;
                case 'objective-complete':
                    checkRef(w.objectiveRef, `${path}.when.objectiveRef`, push);
                    break;
                case 'strength-below':
                    if (typeof w.percent !== 'number' || !Number.isFinite(w.percent)
                        || w.percent <= 0 || w.percent >= 100) {
                        push(`${path}.when.percent must be a number in (0, 100)`);
                    }
                    break;
                default:
                    push(`${path}.when.type ${JSON.stringify(w.type)} is not a known condition`);
            }
        }
    }

    // Standing (structurally valid; executor refuses — see the field doc).
    if (intent.standing !== undefined) {
        if (!isPlainObject(intent.standing)) push(`${path}.standing is not an object`);
        else checkRef(intent.standing.onSight, `${path}.standing.onSight`, push);
    }
}

function validateGuidance(g: unknown, path: string, push: (m: string) => void): void {
    if (!isPlainObject(g)) { push(`${path} is not an object`); return; }
    const op = g.op;
    if (typeof op !== 'string' || !NL_GUIDANCE_OPS.includes(op as NLGuidanceOp)) {
        push(`${path}.op ${JSON.stringify(op)} is not one of ${NL_GUIDANCE_OPS.join('|')}`);
        return;
    }

    // Value against the GADGET's set for this op (never a union of all sets —
    // 'aggressive' is a stance, not a paint, and accepting it as a paint would
    // reach a gadget that silently rejects it, i.e. a fake success).
    const allowed = GUIDANCE_VALUES[op as NLGuidanceOp];
    if (allowed) {
        if (typeof g.value !== 'string') {
            push(`${path}.value is required for op '${op}' (one of ${allowed.join('|')})`);
        } else if (!allowed.includes(g.value)) {
            push(`${path}.value ${JSON.stringify(g.value)} is not accepted for op '${op}' (${allowed.join('|')})`);
        }
    } else if (g.value !== undefined) {
        push(`${path}.value is not used by op '${op}'`);
    }

    // Per-op required refs — mirroring which field the gadget's handler reads.
    switch (op as NLGuidanceOp) {
        case 'paint':
            checkRef(g.regionRef, `${path}.regionRef`, push);
            break;
        case 'lock':
            checkRef(g.groupRef, `${path}.groupRef`, push);
            break;
        case 'delegate':
            checkRef(g.objectiveRef, `${path}.objectiveRef`, push);
            break;
        case 'veto':
            checkRef(g.goalRef, `${path}.goalRef`, push);
            break;
        case 'fund': {
            const hasAmount = g.amount !== undefined;
            const hasCap = g.rateCap !== undefined;
            if (!hasAmount && !hasCap) push(`${path} needs amount and/or rateCap for op 'fund'`);
            if (hasAmount && (typeof g.amount !== 'number' || !Number.isFinite(g.amount)
                || g.amount <= 0 || g.amount > 100000)) {
                push(`${path}.amount must be a number in (0, 100000]`);
            }
            if (hasCap && (typeof g.rateCap !== 'number' || !Number.isFinite(g.rateCap)
                || g.rateCap < 0 || g.rateCap > 100000)) {
                push(`${path}.rateCap must be a number in [0, 100000]`);
            }
            break;
        }
        case 'stance':
        case 'roe':
            break;
    }

    // Any ref the op does NOT use is rejected rather than ignored: a paint that
    // also carries a groupRef means the model misunderstood the op, and the
    // half we'd honour might not be the half it meant.
    const refFields: Array<[NLGuidanceOp[], string]> = [
        [['paint'], 'regionRef'],
        [['lock'], 'groupRef'],
        [['delegate'], 'objectiveRef'],
        [['veto'], 'goalRef'],
    ];
    for (const [ops, field] of refFields) {
        if (!ops.includes(op as NLGuidanceOp) && (g as Record<string, unknown>)[field] !== undefined) {
            push(`${path}.${field} is not used by op '${op}'`);
        }
    }
    if (op !== 'fund') {
        if (g.amount !== undefined) push(`${path}.amount is not used by op '${op}'`);
        if (g.rateCap !== undefined) push(`${path}.rateCap is not used by op '${op}'`);
    }
}

function validateCamera(c: unknown, path: string, push: (m: string) => void): void {
    if (!isPlainObject(c)) { push(`${path} is not an object`); return; }
    const op = c.op;
    if (typeof op !== 'string' || !(CAMERA_OPS as readonly string[]).includes(op)) {
        push(`${path}.op ${JSON.stringify(op)} is not one of ${CAMERA_OPS.join('|')}`);
        return;
    }
    if (op === 'focus' || op === 'follow') checkRef(c.targetRef, `${path}.targetRef`, push);
    if (op === 'zoom' && c.dir !== 'in' && c.dir !== 'out') push(`${path}.dir must be 'in' or 'out'`);
    if (op === 'saveView' || op === 'loadView') {
        if (typeof c.slot !== 'number' || !Number.isInteger(c.slot) || c.slot < 0 || c.slot > 9) {
            push(`${path}.slot must be an integer 0..9`);
        }
    }
}

function validateUi(u: unknown, path: string, opts: ValidateOptions, push: (m: string) => void): void {
    if (!isPlainObject(u)) { push(`${path} is not an object`); return; }
    if (typeof u.op !== 'string' || !(UI_OPS as readonly string[]).includes(u.op)) {
        push(`${path}.op ${JSON.stringify(u.op)} is not one of ${UI_OPS.join('|')}`);
    }
    checkRef(u.panelId, `${path}.panelId`, push);
    // Membership only once a registry exists (M3) — see ValidateOptions.
    if (opts.panelIds && typeof u.panelId === 'string' && !opts.panelIds.includes(u.panelId)) {
        push(`${path}.panelId ${JSON.stringify(u.panelId)} is not a known panel`);
    }
}

function validateQuery(q: unknown, path: string, opts: ValidateOptions, push: (m: string) => void): void {
    if (!isPlainObject(q)) { push(`${path} is not an object`); return; }
    const op = q.op;
    if (typeof op !== 'string' || !(QUERY_OPS as readonly string[]).includes(op)) {
        push(`${path}.op ${JSON.stringify(op)} is not one of ${QUERY_OPS.join('|')}`);
        return;
    }
    switch (op) {
        case 'count':
            checkClass(q.class, `${path}.class`, opts, push);
            checkScale(q.scale, `${path}.scale`, push);
            if (typeof q.side !== 'string' || !(SIDES as readonly string[]).includes(q.side)) {
                push(`${path}.side must be one of ${SIDES.join('|')}`);
            }
            break;
        case 'locate':
            checkRef(q.targetRef, `${path}.targetRef`, push);
            if (q.side !== undefined && q.side !== 'own' && q.side !== 'enemy') {
                push(`${path}.side must be 'own' or 'enemy'`);
            }
            break;
        case 'status':
            checkRef(q.subjectRef, `${path}.subjectRef`, push);
            break;
        case 'resources':
        case 'objectives':
            break;
    }
}

function validateGroup(g: unknown, path: string, push: (m: string) => void): void {
    if (!isPlainObject(g)) { push(`${path} is not an object`); return; }
    if (g.op === 'create') {
        checkRef(g.name, `${path}.name`, push);
        if (g.memberRefs !== undefined) {
            if (!Array.isArray(g.memberRefs)) push(`${path}.memberRefs must be an array`);
            else if (g.memberRefs.length > 16) push(`${path}.memberRefs has more than 16 entries`);
            else g.memberRefs.forEach((m, i) => checkRef(m, `${path}.memberRefs[${i}]`, push));
        }
    } else if (g.op === 'rename') {
        // Absent groupRef = the selection (see NLGroupAction). Present but not
        // a valid name is still an error — an omitted field and a malformed one
        // must not mean the same thing.
        if (g.groupRef !== undefined) checkRef(g.groupRef, `${path}.groupRef`, push);
        checkRef(g.name, `${path}.name`, push);
    } else {
        push(`${path}.op ${JSON.stringify(g.op)} is not 'create' or 'rename'`);
    }
}

// ─────────────────────────── field checks ───────────────────────────

/**
 * A NAME: non-empty, length-capped, charset-capped (plan §9.7 — names are
 * data). This is the single gate every reference in the envelope passes
 * through, which is why the wire codec downstream can never see a `&` or `=`
 * it didn't put there itself.
 */
function checkRef(value: unknown, path: string, push: (m: string) => void): void {
    if (typeof value !== 'string') { push(`${path} must be a string`); return; }
    const trimmed = value.trim();
    if (!trimmed) { push(`${path} must not be empty`); return; }
    if (trimmed.length > MAX_REF_LENGTH) { push(`${path} exceeds ${MAX_REF_LENGTH} chars`); return; }
    if (!NAME_CHARSET.test(trimmed)) {
        push(`${path} contains characters that are not allowed in a name`);
    }
}

/** A class or role phrase — charset-checked always, membership-checked when a
 *  vocabulary was supplied. Both `classes` and `roles` are accepted: "air
 *  defense" is a legitimate thing to say, and the resolver expands it. */
function checkClass(
    value: unknown, path: string, opts: ValidateOptions, push: (m: string) => void,
): void {
    if (typeof value !== 'string' || !value.trim()) { push(`${path} must be a non-empty string`); return; }
    if (value.length > MAX_REF_LENGTH) { push(`${path} exceeds ${MAX_REF_LENGTH} chars`); return; }
    const vocabulary = opts.vocabulary;
    if (!vocabulary) return;
    if (vocabulary.lookup(value)) return;
    push(`${path} ${JSON.stringify(value)} is not a known unit class or role`);
}

function checkScale(value: unknown, path: string, push: (m: string) => void): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 4) {
        push(`${path} must be an integer 1..4`);
    }
}

/**
 * A map coordinate. Only ever legal because the CONTEXT payload supplied it
 * (§1 "only from context-provided coords"); the bound is a sanity cap against a
 * hallucinated number, not a map-size check — the client has no map size here,
 * and the sim clamps anyway.
 */
function checkCoord(value: unknown, path: string, push: (m: string) => void): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
        push(`${path} must be a finite coordinate in [0, 1000000]`);
    }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}
