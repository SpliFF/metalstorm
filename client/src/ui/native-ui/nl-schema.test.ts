/**
 * nl-schema.test.ts — the shipped schema cannot drift from the TS contract
 * (PLAN-metalstorm-command-language.md §3/§8, milestone M4)
 *
 * `data/games/metalstorm/ui/nl-response.schema.json` is loaded by TWO things
 * that share no code: the C++ proxy (`rts/Server/NlProxy.cpp`, at startup) and
 * this suite. It is generated from `nl-schema.ts`, which in turn is generated
 * from the envelope's own closed vocabularies. This file is the join: it fails
 * the moment the checked-in bytes stop matching what the contract produces.
 *
 * To regenerate after a legitimate contract change:
 *
 *     cd client && NL_SCHEMA_EMIT=1 npx vitest run src/ui/native-ui/nl-schema
 *
 * That is the whole "generator" — a golden file with an update mode, rather
 * than a build step nobody runs. The gate is that CI runs without the env var,
 * so an unregenerated schema is a red test and not a silent mismatch between
 * what the model is told and what the validator will accept.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildNLResponseSchema, serialiseSchema, type JsonValue } from './nl-schema.js';
import {
    CAMERA_OPS, COMMAND_VERBS, GUIDANCE_VALUES, NL_ACTION_KINDS, NL_GUIDANCE_OPS,
    NL_PRIORITIES, QUERY_OPS, UI_OPS, validateNLResponse,
} from './nl-envelope.js';

const SCHEMA_PATH = resolve(__dirname, '../../../../data/games/metalstorm/ui/nl-response.schema.json');
const VOCAB_PATH = resolve(__dirname, '../../../../data/games/metalstorm/ui/class-vocabulary.json');

/** The class list the SHIPPED schema is built with — read from the same file
 *  the proxy reads, sorted for determinism (JSON object key order is not a
 *  contract, and the schema's byte-stability is). */
function shippedClassNames(): string[] {
    const vocab = JSON.parse(readFileSync(VOCAB_PATH, 'utf8')) as { classes: Record<string, unknown> };
    return Object.keys(vocab.classes).sort();
}

function shippedSchemaText(): string {
    return serialiseSchema(buildNLResponseSchema({ classNames: shippedClassNames() }));
}

describe('nl-response.schema.json', () => {
    it('matches the schema built from the TS contract, byte for byte', () => {
        const expected = shippedSchemaText();

        if (process.env.NL_SCHEMA_EMIT) {
            writeFileSync(SCHEMA_PATH, expected, 'utf8');
        }

        const onDisk = readFileSync(SCHEMA_PATH, 'utf8');
        expect(onDisk).toBe(expected);
    });

    it('is byte-stable across builds — the prompt cache depends on it', () => {
        // Not a tautology: it catches a future edit that reaches for an
        // unordered container (a Set, an Object.keys over a map built at
        // runtime) somewhere inside the builder. The proxy embeds this text in
        // its cached system prompt; a wobbling key order would silently cost a
        // cache write on every single utterance.
        const a = serialiseSchema(buildNLResponseSchema({ classNames: ['tanks', 'soldiers'] }));
        const b = serialiseSchema(buildNLResponseSchema({ classNames: ['tanks', 'soldiers'] }));
        expect(a).toBe(b);
    });
});

describe('schema vocabularies agree with the validator', () => {
    // The schema is BUILT from these lists, so these assertions are about the
    // wiring rather than the values: they fail if a refactor ever leaves a
    // vocabulary hard-coded in the schema builder instead of imported.
    const schema = buildNLResponseSchema({ classNames: ['tanks'] });
    const actionVariants = ((schema.properties as Record<string, JsonValue>).actions as
        Record<string, JsonValue>);
    const items = actionVariants.items as Record<string, JsonValue>;
    const kinds = (items.anyOf as Record<string, JsonValue>[])
        .map((v) => ((v.properties as Record<string, JsonValue>).kind as Record<string, JsonValue>).const);

    it('offers exactly the seven action kinds, in contract order', () => {
        expect(kinds).toEqual([...NL_ACTION_KINDS]);
    });

    it('offers exactly the compile table\'s verbs', () => {
        const command = (items.anyOf as Record<string, JsonValue>[])[0];
        const intent = (command.properties as Record<string, JsonValue>).intent as Record<string, JsonValue>;
        const verb = (intent.properties as Record<string, JsonValue>).verb as Record<string, JsonValue>;
        expect(verb.enum).toEqual([...COMMAND_VERBS]);
        const priority = (intent.properties as Record<string, JsonValue>).priority as Record<string, JsonValue>;
        expect(priority.enum).toEqual([...NL_PRIORITIES]);
    });

    it('offers every guidance/camera/ui/query op the validator accepts', () => {
        const byKind = Object.fromEntries(
            (items.anyOf as Record<string, JsonValue>[]).map((v, i) => [kinds[i] as string, v]),
        );
        const opsOf = (kind: string, field: string) => {
            const holder = ((byKind[kind].properties as Record<string, JsonValue>)[field]) as
                Record<string, JsonValue>;
            return (holder.anyOf as Record<string, JsonValue>[])
                .map((v) => ((v.properties as Record<string, JsonValue>).op as Record<string, JsonValue>).const);
        };
        expect(opsOf('guidance', 'guidance')).toEqual([...NL_GUIDANCE_OPS]);
        expect(opsOf('camera', 'camera')).toEqual([...CAMERA_OPS]);
        expect(opsOf('query', 'query')).toEqual([...QUERY_OPS]);

        const ui = (byKind.ui.properties as Record<string, JsonValue>).ui as Record<string, JsonValue>;
        const uiOp = (ui.properties as Record<string, JsonValue>).op as Record<string, JsonValue>;
        expect(uiOp.enum).toEqual([...UI_OPS]);
    });

    it('gives each guidance op only the value set the gadget accepts', () => {
        const byKind = Object.fromEntries(
            (items.anyOf as Record<string, JsonValue>[]).map((v, i) => [kinds[i] as string, v]),
        );
        const guidance = (byKind.guidance.properties as Record<string, JsonValue>).guidance as
            Record<string, JsonValue>;
        for (const v of guidance.anyOf as Record<string, JsonValue>[]) {
            const props = v.properties as Record<string, JsonValue>;
            const op = (props.op as Record<string, JsonValue>).const as string;
            const allowed = GUIDANCE_VALUES[op as keyof typeof GUIDANCE_VALUES];
            if (allowed) {
                expect((props.value as Record<string, JsonValue>).enum).toEqual([...allowed]);
            } else {
                expect(props.value).toBeUndefined();
            }
        }
    });
});

describe('every object in the schema is closed', () => {
    // Structured outputs require `additionalProperties: false` on every object,
    // and a schema that omits it somewhere is rejected by the API at request
    // time — i.e. in production, on the first utterance, not here. Walk it.
    it('sets additionalProperties:false and required everywhere', () => {
        const offenders: string[] = [];
        const walk = (node: JsonValue, path: string): void => {
            if (Array.isArray(node)) {
                node.forEach((n, i) => walk(n, `${path}[${i}]`));
                return;
            }
            if (node === null || typeof node !== 'object') return;
            if (node.type === 'object') {
                if (node.additionalProperties !== false) offenders.push(`${path}: additionalProperties`);
                if (!Array.isArray(node.required)) offenders.push(`${path}: required`);
            }
            for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
        };
        walk(buildNLResponseSchema({ classNames: shippedClassNames() }), '$');
        expect(offenders).toEqual([]);
    });

    it('uses no keyword structured outputs rejects', () => {
        // minLength/maxLength/minimum/maximum/minItems/maxItems/pattern are all
        // unsupported. They belong to validateNLResponse, and a stray one here
        // would 400 the very first live request.
        const banned = [
            'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum',
            'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'pattern',
            'uniqueItems',
        ];
        const found: string[] = [];
        const walk = (node: JsonValue, path: string): void => {
            if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`)); return; }
            if (node === null || typeof node !== 'object') return;
            for (const [k, v] of Object.entries(node)) {
                if (banned.includes(k)) found.push(`${path}.${k}`);
                walk(v, `${path}.${k}`);
            }
        };
        walk(buildNLResponseSchema({ classNames: shippedClassNames() }), '$');
        expect(found).toEqual([]);
    });
});

describe('the fixtures the validator accepts are shaped like the schema', () => {
    // A structural smoke test rather than a full JSON-Schema engine (there is
    // no validator dependency in this client, and adding one to assert what
    // the API itself enforces would be a third implementation of the contract).
    // What this proves is the direction that matters: every action kind the
    // schema advertises is a kind the validator will accept back.
    it('round-trips one minimal envelope per action kind', () => {
        const envelopes: Record<string, unknown> = {
            command: { actions: [{ kind: 'command', intent: { verb: 'defend', subject: { type: 'selection' } } }] },
            guidance: { actions: [{ kind: 'guidance', guidance: { op: 'stance', value: 'defensive' } }] },
            camera: { actions: [{ kind: 'camera', camera: { op: 'fitMap' } }] },
            ui: { actions: [{ kind: 'ui', ui: { op: 'open', panelId: 'minimap' } }] },
            query: { actions: [{ kind: 'query', query: { op: 'resources' } }] },
            group: { actions: [{ kind: 'group', group: { op: 'rename', name: 'Hammerfall' } }] },
            refuse: { actions: [{ kind: 'refuse', reason: 'I have no record of that place.' }] },
        };
        for (const kind of NL_ACTION_KINDS) {
            const result = validateNLResponse(envelopes[kind]);
            expect(result.ok, `${kind}: ${result.ok ? '' : result.errors.join('; ')}`).toBe(true);
        }
    });
});
