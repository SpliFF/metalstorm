/**
 * nl-schema.ts — the NLResponse JSON Schema, built from the TS contract
 * (PLAN-metalstorm-command-language.md §3, milestone M4)
 *
 * The proxy asks Claude for **structured output** against a JSON schema. That
 * schema and `nl-envelope.ts`'s validator describe the same envelope, so the
 * only safe way to have both is to derive one from the other: this module
 * imports the closed vocabularies out of `nl-envelope.ts` / `compile-table.ts`
 * and assembles the schema from them. Nothing here restates a verb, an op or a
 * priority band — if the compile table drops a verb, the schema loses it in the
 * same commit, without anyone remembering to.
 *
 * `tools/nl-schema/emit.ts` writes the result to
 * `data/games/metalstorm/ui/nl-response.schema.json`, which is what the C++
 * proxy loads at startup (it has no TypeScript). `nl-schema.test.ts` asserts
 * the checked-in file is byte-identical to what this module produces, so the
 * shipped copy cannot drift from the contract either.
 *
 * ── What the schema deliberately does NOT express ──
 * Structured outputs support enums, const, anyOf and $ref, but NOT string
 * length limits, numeric ranges, or array-length limits (see the API's schema
 * limitations). So `MAX_REF_LENGTH`, `count` ∈ 1..16, `percent` ∈ (0,100),
 * `MAX_ACTIONS` and the charset rule are absent here by necessity — they stay
 * with `validateNLResponse`, which runs on the proxy's output at the client
 * anyway (§3: "the client validator remains the second gate"). The schema's
 * job is the SHAPE — which discriminated variant, which field names, which
 * closed vocabulary — and that is exactly the part a model gets wrong.
 *
 * Cross-field rules (clarify excludes actions; a `paint` carries a regionRef
 * and nothing else) are likewise the validator's, not the schema's: JSON
 * Schema could express some of them, but a schema that rejects what the
 * validator accepts — or vice versa — is worse than one that is honestly
 * narrower. The prompt states them in prose instead.
 */

import {
    CAMERA_OPS, COMMAND_VERBS, GROUP_OPS, GUIDANCE_VALUES, NL_ACTION_KINDS,
    NL_GUIDANCE_OPS, NL_PRIORITIES, NL_SCALES, QUERY_OPS, SIDES, SUBJECT_TYPES,
    TARGET_TYPES, UI_OPS, WHEN_TYPES,
} from './nl-envelope.js';

/** A JSON value, as it appears in a schema document. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** `{"type":"object", ...}` with the closed-world flags structured outputs
 *  requires: every object is exhaustive and forbids extra keys. */
function obj(
    properties: Record<string, JsonValue>,
    required: readonly string[],
): Record<string, JsonValue> {
    return {
        type: 'object',
        properties,
        required: [...required],
        additionalProperties: false,
    };
}

/** A discriminated variant: `{type: <tag>, ...fields}`. The tag is a `const`
 *  rather than a one-entry `enum` so the model reads it as "this branch IS
 *  this", which is what a discriminator means. */
function variant(
    discriminant: string,
    tag: string,
    fields: Record<string, JsonValue> = {},
    required: readonly string[] = [],
): Record<string, JsonValue> {
    return obj(
        { [discriminant]: { const: tag }, ...fields },
        [discriminant, ...required],
    );
}

const NAME = {
    type: 'string',
    description:
        'A name exactly as it appears in the context payload. Never invent one, '
        + 'never translate or pluralise one, never abbreviate one.',
} as const satisfies Record<string, JsonValue>;

const SCALE: Record<string, JsonValue> = {
    enum: [...NL_SCALES],
    description: 'Unit weight class: 1 light, 2 medium, 3 heavy, 4 super-heavy.',
};

// ─────────────────────────── subject / target / when ───────────────────────

function subjectSchema(classNames: readonly string[]): Record<string, JsonValue> {
    const cls: Record<string, JsonValue> = classNames.length > 0
        ? { enum: [...classNames] }
        : { type: 'string' };
    const byType: Record<(typeof SUBJECT_TYPES)[number], Record<string, JsonValue>> = {
        'entity-ref': variant('type', 'entity-ref', { name: NAME }, ['name']),
        'class-count': variant('type', 'class-count', {
            class: cls,
            count: { type: 'integer', description: 'How many groups, 1 to 16.' },
            scale: SCALE,
        }, ['class', 'count']),
        'idle-filter': variant('type', 'idle-filter', { filterClass: cls }, ['filterClass']),
        selection: variant('type', 'selection'),
        any: variant('type', 'any'),
        ai: variant('type', 'ai'),
    };
    return {
        description:
            'Who executes. `selection` is what the player currently has selected; '
            + '`any` is team-wide ("whoever is free"); `ai` hands the order to the AI commander.',
        anyOf: SUBJECT_TYPES.map((t) => byType[t]),
    };
}

const TARGET: Record<string, JsonValue> = {
    description:
        'Where to act. Use `point` ONLY for coordinates the context payload supplied; '
        + 'never guess a coordinate from a name.',
    anyOf: (() => {
        const byType: Record<(typeof TARGET_TYPES)[number], Record<string, JsonValue>> = {
            'entity-ref': variant('type', 'entity-ref', { name: NAME }, ['name']),
            point: variant('type', 'point', { x: { type: 'number' }, z: { type: 'number' } }, ['x', 'z']),
            'area-around': variant('type', 'area-around', {
                name: NAME,
                radius: { type: 'number', description: 'Elmos, up to 20000. Omit for the default.' },
            }, ['name']),
        };
        return TARGET_TYPES.map((t) => byType[t]);
    })(),
};

const WHEN: Record<string, JsonValue> = {
    description: 'The trigger gate. Omit it (or use `now`) for "do it immediately".',
    anyOf: (() => {
        const byType: Record<(typeof WHEN_TYPES)[number], Record<string, JsonValue>> = {
            now: variant('type', 'now'),
            'under-attack': variant('type', 'under-attack'),
            'region-contested': variant('type', 'region-contested', { regionRef: NAME }, ['regionRef']),
            'objective-complete': variant('type', 'objective-complete', { objectiveRef: NAME }, ['objectiveRef']),
            'strength-below': variant('type', 'strength-below', {
                percent: { type: 'number', description: 'Strictly between 0 and 100.' },
            }, ['percent']),
        };
        return WHEN_TYPES.map((t) => byType[t]);
    })(),
};

// ───────────────────────────── the seven actions ───────────────────────────

function commandAction(classNames: readonly string[]): Record<string, JsonValue> {
    return variant('kind', 'command', {
        intent: obj({
            verb: { enum: [...COMMAND_VERBS] },
            subject: subjectSchema(classNames),
            target: TARGET,
            priority: { enum: [...NL_PRIORITIES] },
            when: WHEN,
            standing: obj({ onSight: NAME }, ['onSight']),
        }, ['verb', 'subject']),
    }, ['intent']);
}

/** One variant per guidance op, because the ops do not share a field set: the
 *  gadget reads `regionRef` for a paint and `groupRef` for a lock, and an
 *  envelope carrying both is a misunderstanding, not a richer order. */
function guidanceAction(): Record<string, JsonValue> {
    const valueFor = (op: (typeof NL_GUIDANCE_OPS)[number]): Record<string, JsonValue> | null => {
        const allowed = GUIDANCE_VALUES[op];
        return allowed ? { enum: [...allowed] } : null;
    };
    const perOp: Record<string, JsonValue>[] = NL_GUIDANCE_OPS.map((op) => {
        const fields: Record<string, JsonValue> = {};
        const required: string[] = [];
        const value = valueFor(op);
        if (value) { fields.value = value; required.push('value'); }
        switch (op) {
            case 'paint': fields.regionRef = NAME; required.push('regionRef'); break;
            case 'lock': fields.groupRef = NAME; required.push('groupRef'); break;
            case 'delegate': fields.objectiveRef = NAME; required.push('objectiveRef'); break;
            case 'veto': fields.goalRef = NAME; required.push('goalRef'); break;
            case 'fund':
                fields.amount = { type: 'number', description: 'One-shot authority transfer, above 0.' };
                fields.rateCap = { type: 'number', description: 'Standing funding rate cap, 0 or above.' };
                break;
            default: break;
        }
        return variant('op', op, fields, required);
    });
    return variant('kind', 'guidance', {
        guidance: {
            description: 'Standing advice to the AI commander, not a directive to a unit.',
            anyOf: perOp,
        },
    }, ['guidance']);
}

function cameraAction(): Record<string, JsonValue> {
    const byOp: Record<(typeof CAMERA_OPS)[number], Record<string, JsonValue>> = {
        focus: variant('op', 'focus', { targetRef: NAME }, ['targetRef']),
        follow: variant('op', 'follow', { targetRef: NAME }, ['targetRef']),
        fitMap: variant('op', 'fitMap'),
        zoom: variant('op', 'zoom', { dir: { enum: ['in', 'out'] } }, ['dir']),
        saveView: variant('op', 'saveView', { slot: { type: 'integer', description: '0 to 9.' } }, ['slot']),
        loadView: variant('op', 'loadView', { slot: { type: 'integer', description: '0 to 9.' } }, ['slot']),
    };
    return variant('kind', 'camera', {
        camera: { anyOf: CAMERA_OPS.map((op) => byOp[op]) },
    }, ['camera']);
}

function uiAction(panelIds: readonly string[]): Record<string, JsonValue> {
    return variant('kind', 'ui', {
        ui: obj({
            op: { enum: [...UI_OPS] },
            panelId: panelIds.length > 0
                ? { enum: [...panelIds] }
                : { type: 'string', description: 'A panel id from the context payload.' },
        }, ['op', 'panelId']),
    }, ['ui']);
}

function queryAction(classNames: readonly string[]): Record<string, JsonValue> {
    const cls: Record<string, JsonValue> = classNames.length > 0
        ? { enum: [...classNames] }
        : { type: 'string' };
    const byOp: Record<(typeof QUERY_OPS)[number], Record<string, JsonValue>> = {
        count: variant('op', 'count', {
            class: cls, scale: SCALE, side: { enum: [...SIDES] },
        }, ['class', 'side']),
        locate: variant('op', 'locate', {
            targetRef: NAME, side: { enum: ['own', 'enemy'] },
        }, ['targetRef']),
        status: variant('op', 'status', { subjectRef: NAME }, ['subjectRef']),
        resources: variant('op', 'resources'),
        objectives: variant('op', 'objectives'),
    };
    return variant('kind', 'query', {
        query: {
            description:
                'A question the game answers locally. Queries never move anything.',
            anyOf: QUERY_OPS.map((op) => byOp[op]),
        },
    }, ['query']);
}

function groupAction(): Record<string, JsonValue> {
    const byOp: Record<(typeof GROUP_OPS)[number], Record<string, JsonValue>> = {
        create: variant('op', 'create', {
            name: NAME,
            memberRefs: { type: 'array', items: NAME },
        }, ['name']),
        rename: variant('op', 'rename', {
            groupRef: NAME,
            name: NAME,
        }, ['name']),
    };
    return variant('kind', 'group', {
        group: {
            description:
                'On a rename, omit `groupRef` to mean "the group the player has selected".',
            anyOf: GROUP_OPS.map((op) => byOp[op]),
        },
    }, ['group']);
}

const REFUSE_ACTION = variant('kind', 'refuse', {
    reason: {
        type: 'string',
        description:
            'Why the order cannot be carried out, in the player\'s own terms. '
            + 'Use this for a place or unit the context does not contain.',
    },
}, ['reason']);

// ─────────────────────────────── the envelope ──────────────────────────────

export interface SchemaOptions {
    /**
     * `ms_class` keys from `class-vocabulary.json`. When present, class fields
     * become an enum, which is the single highest-value constraint in the whole
     * schema: it is what stops "send the mechs to Randtown" producing a class
     * the sim has never heard of. Empty ⇒ a plain string (the emitted file
     * ships with the enum; the fallback exists for a caller with no vocabulary).
     */
    classNames?: readonly string[];
    /** Registered panel ids. Empty ⇒ a plain string, same reasoning. */
    panelIds?: readonly string[];
}

/**
 * Build the NLResponse JSON Schema.
 *
 * Deterministic by construction — same options in, byte-identical JSON out,
 * because every list it draws on is an ordered `as const` array and no key is
 * inserted from an unordered set. That is a hard requirement, not a nicety:
 * this schema sits inside the proxy's cached system prompt, and a schema whose
 * key order wobbled would invalidate the prompt cache on every request.
 */
export function buildNLResponseSchema(opts: SchemaOptions = {}): Record<string, JsonValue> {
    const classNames = opts.classNames ?? [];
    const panelIds = opts.panelIds ?? [];

    const byKind: Record<(typeof NL_ACTION_KINDS)[number], Record<string, JsonValue>> = {
        command: commandAction(classNames),
        guidance: guidanceAction(),
        camera: cameraAction(),
        ui: uiAction(panelIds),
        query: queryAction(classNames),
        group: groupAction(),
        refuse: REFUSE_ACTION,
    };

    return {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        title: 'NLResponse',
        description:
            'The one shape a natural-language command may take. Either `actions` '
            + 'is non-empty and `clarify` is absent, or `clarify` is present and '
            + '`actions` is empty — asking and acting are mutually exclusive.',
        ...obj({
            actions: {
                type: 'array',
                description: 'Up to 4 actions, executed in order. Empty only when clarifying.',
                items: { anyOf: NL_ACTION_KINDS.map((k) => byKind[k]) },
            },
            say: {
                type: 'string',
                description:
                    'One short spoken line confirming what is happening, e.g. '
                    + '"Moving 2 tank squads to Randtown". Present tense, no preamble.',
            },
            clarify: obj({
                question: { type: 'string', description: 'One question, asked plainly.' },
                options: {
                    type: 'array',
                    description: 'Up to 6 concrete choices, each a name from the context.',
                    items: { type: 'string' },
                },
            }, ['question']),
        }, ['actions']),
    };
}

/** The canonical serialisation — 2-space indent, trailing newline. The emitted
 *  file, the byte-stability test and the C++ loader all agree on this. */
export function serialiseSchema(schema: Record<string, JsonValue>): string {
    return `${JSON.stringify(schema, null, 2)}\n`;
}
