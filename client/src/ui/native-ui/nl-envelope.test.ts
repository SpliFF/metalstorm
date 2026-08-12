/**
 * nl-envelope.test.ts — the contract, and the anti-drift guards on it
 * (PLAN-metalstorm-command-language.md §8 "the schema is the contract")
 *
 * Three jobs:
 *  1. Every golden fixture's `expected` envelope VALIDATES. A fixture that
 *     doesn't is either a bad fixture or a broken contract; both must be caught
 *     here rather than three layers down in the executor.
 *  2. Every fixture is name-shaped. The envelope must never carry an id or a
 *     coordinate the context didn't supply (design pillar 4) — this asserts it
 *     structurally instead of trusting the fixture author.
 *  3. The closed vocabularies match their sources. The guidance value sets are
 *     grepped straight out of `game_ai_guidance.lua`, and the verbs out of
 *     `compile-table.ts` — so "the gadget is the truth" is enforced, not just
 *     written down.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    validateNLResponse, GUIDANCE_VALUES, NL_GUIDANCE_OPS, MAX_ACTIONS,
    type NLResponse,
} from './nl-envelope.js';
import { TARGET_SHAPES_BY_VERB } from './compile-table.js';
import { loadFixtures, loadVocabulary, loadContexts } from './nl-fixtures/load-fixtures.test-support.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const GUIDANCE_GADGET = join(
    REPO, 'data', 'games', 'metalstorm', 'LuaRules', 'Gadgets', 'game_ai_guidance.lua',
);

const vocabulary = loadVocabulary();
const fixtures = loadFixtures();

/** `local NAME = { a = true, b = true }` → ['a','b']. */
function luaSet(source: string, name: string): string[] {
    const match = source.match(new RegExp(`local\\s+${name}\\s*=\\s*\\{([^}]*)\\}`));
    if (!match) throw new Error(`could not find "local ${name} = {...}" in game_ai_guidance.lua`);
    return [...match[1].matchAll(/([A-Za-z_][\w]*)\s*=\s*true/g)].map((m) => m[1]);
}

/** The `cmd == 'guidance.x'` branches of the gadget's RecvLuaMsg dispatch. */
function luaGuidanceOps(source: string): string[] {
    return [...source.matchAll(/cmd\s*==\s*'guidance\.(\w+)'/g)].map((m) => m[1]);
}

describe('the golden fixtures all validate', () => {
    it('there are at least 30 of them', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(30);
    });

    it('every fixture names a context that exists', () => {
        const contexts = loadContexts();
        for (const fixture of fixtures) {
            expect(Object.keys(contexts), `${fixture.file}: ${fixture.name}`)
                .toContain(fixture.context);
        }
    });

    for (const fixture of fixtures) {
        it(`${fixture.file} · ${fixture.name}`, () => {
            const result = validateNLResponse(fixture.expected, { vocabulary });
            expect(result.ok ? [] : result.errors).toEqual([]);
        });
    }

    it('covers every action kind', () => {
        const kinds = new Set(
            fixtures.flatMap((f) => f.expected.actions.map((a) => a.kind)),
        );
        for (const kind of ['command', 'guidance', 'camera', 'ui', 'query', 'group', 'refuse']) {
            expect(kinds, `no fixture exercises kind '${kind}'`).toContain(kind);
        }
    });

    it('covers clarifications from the model and multi-action envelopes', () => {
        expect(fixtures.some((f) => f.expected.clarify)).toBe(true);
        expect(fixtures.some((f) => f.expected.actions.length > 1)).toBe(true);
    });

    it('covers every guidance op the gadget accepts', () => {
        const ops = new Set(
            fixtures.flatMap((f) => f.expected.actions)
                .filter((a) => a.kind === 'guidance')
                .map((a) => (a as { guidance: { op: string } }).guidance.op),
        );
        for (const op of NL_GUIDANCE_OPS) {
            expect(ops, `no fixture exercises guidance op '${op}'`).toContain(op);
        }
    });
});

describe('the envelope is names-only (design pillar 4)', () => {
    /**
     * Walk every fixture envelope looking for a numeric field that isn't one of
     * the four the schema legitimately allows a number in (`count`, `scale`,
     * `slot`, `percent`, `radius`, `amount`, `rateCap`) — an id or a coordinate
     * would show up as an unexpected number and fail here.
     */
    const NUMERIC_FIELDS = new Set(['count', 'scale', 'slot', 'percent', 'radius', 'amount', 'rateCap', 'x', 'z']);

    for (const fixture of fixtures) {
        it(`${fixture.file} · ${fixture.name} carries no ids`, () => {
            const offenders: string[] = [];
            const walk = (value: unknown, path: string) => {
                if (typeof value === 'number') {
                    const field = path.split('.').pop() ?? '';
                    if (!NUMERIC_FIELDS.has(field)) offenders.push(`${path} = ${value}`);
                } else if (Array.isArray(value)) {
                    value.forEach((v, i) => walk(v, `${path}[${i}]`));
                } else if (value && typeof value === 'object') {
                    for (const [key, v] of Object.entries(value)) walk(v, `${path}.${key}`);
                }
            };
            walk(fixture.expected, 'expected');
            expect(offenders).toEqual([]);
        });
    }

    it('no fixture uses a bare point target — coordinates only come from context', () => {
        // `point` is legal in the schema (§1: "only from context-provided
        // coords") but no fixture needs one, and a model that invents
        // coordinates is exactly what the schema note warns about. If a fixture
        // ever legitimately needs one, this assertion is the place to argue it.
        const points = fixtures.flatMap((f) => f.expected.actions)
            .filter((a) => a.kind === 'command')
            .map((a) => (a as { intent: { target?: { type: string } } }).intent.target)
            .filter((t) => t?.type === 'point');
        expect(points).toEqual([]);
    });
});

describe('the closed vocabularies match their sources', () => {
    const gadget = readFileSync(GUIDANCE_GADGET, 'utf8');

    it("stance values are the gadget's STANCES table", () => {
        expect([...GUIDANCE_VALUES.stance!].sort()).toEqual(luaSet(gadget, 'STANCES').sort());
    });

    it("paint values are the gadget's PAINTS table", () => {
        expect([...GUIDANCE_VALUES.paint!].sort()).toEqual(luaSet(gadget, 'PAINTS').sort());
    });

    it("roe values are the gadget's ROES table", () => {
        expect([...GUIDANCE_VALUES.roe!].sort()).toEqual(luaSet(gadget, 'ROES').sort());
    });

    it("the op list is the gadget's RecvLuaMsg dispatch", () => {
        expect([...NL_GUIDANCE_OPS].sort()).toEqual([...new Set(luaGuidanceOps(gadget))].sort());
    });

    it('verbs come from the compile table, not a second list', () => {
        const verbs = Object.keys(TARGET_SHAPES_BY_VERB);
        const accepted = verbs.filter((verb) => validateNLResponse({
            actions: [{ kind: 'command', intent: { verb, subject: { type: 'any' } } }],
        }, { vocabulary }).ok);
        expect(accepted).toEqual(verbs);
    });
});

describe('rejections', () => {
    const bad = (input: unknown, ...expectedFragments: string[]) => {
        const result = validateNLResponse(input, { vocabulary });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            for (const fragment of expectedFragments) {
                expect(result.errors.join(' | ')).toContain(fragment);
            }
        }
    };

    it('rejects a non-object', () => bad(null, 'not an object'));
    it('rejects a missing actions array', () => bad({}, 'actions must be an array'));

    it('rejects clarify alongside actions — asking and acting are exclusive', () => {
        bad({
            clarify: { question: 'Which one?' },
            actions: [{ kind: 'refuse', reason: 'no' }],
        }, 'actions must be empty');
    });

    it('rejects an empty envelope that neither acts nor asks', () => {
        bad({ actions: [] }, 'nothing would happen');
    });

    it(`rejects more than ${MAX_ACTIONS} actions`, () => {
        bad({
            actions: Array.from({ length: MAX_ACTIONS + 1 }, () => ({ kind: 'refuse', reason: 'x' })),
        }, `max ${MAX_ACTIONS}`);
    });

    it('rejects an unknown action kind', () => {
        bad({ actions: [{ kind: 'exec', command: 'rm -rf' }] }, 'is not one of');
    });

    it('rejects a verb the compile table dropped', () => {
        bad({
            actions: [{ kind: 'command', intent: { verb: 'nuke', subject: { type: 'any' } } }],
        }, 'is not a known verb');
    });

    it('rejects a class the shipped vocabulary does not ship', () => {
        bad({
            actions: [{
                kind: 'command',
                intent: { verb: 'attack', subject: { type: 'class-count', class: 'battlemechs', count: 2 } },
            }],
        }, 'not a known unit class or role');
    });

    it('accepts a role as a class phrase (the resolver expands it)', () => {
        const result = validateNLResponse({
            actions: [{
                kind: 'command',
                intent: { verb: 'hold', subject: { type: 'idle-filter', filterClass: 'air defense' } },
            }],
        }, { vocabulary });
        expect(result.ok).toBe(true);
    });

    it("rejects a guidance value from another op's set", () => {
        bad({
            actions: [{ kind: 'guidance', guidance: { op: 'paint', value: 'aggressive', regionRef: 'X' } }],
        }, "not accepted for op 'paint'");
    });

    it('rejects a guidance op missing its ref', () => {
        bad({
            actions: [{ kind: 'guidance', guidance: { op: 'paint', value: 'priority' } }],
        }, 'regionRef must be a string');
    });

    it("rejects a ref the op doesn't use — a confused op is not half-honoured", () => {
        bad({
            actions: [{
                kind: 'guidance',
                guidance: { op: 'paint', value: 'priority', regionRef: 'X', groupRef: 'Y' },
            }],
        }, "groupRef is not used by op 'paint'");
    });

    it('rejects fund with neither amount nor rateCap', () => {
        bad({ actions: [{ kind: 'guidance', guidance: { op: 'fund' } }] }, "for op 'fund'");
    });

    it('rejects a negative fund amount', () => {
        bad({ actions: [{ kind: 'guidance', guidance: { op: 'fund', amount: -5 } }] }, 'amount must be');
    });

    it('rejects a name carrying wire metacharacters (prompt-injection hygiene)', () => {
        // `&` and `=` are what parley/wire.lua escapes; a name containing them
        // could otherwise try to forge a second field. The charset gate is why
        // guidance-wire.ts never sees one it didn't put there.
        bad({
            actions: [{
                kind: 'guidance',
                guidance: { op: 'paint', value: 'priority', regionRef: 'x&cmd=guidance.stance' },
            }],
        }, 'characters that are not allowed in a name');
    });

    it('rejects a name carrying markup', () => {
        bad({
            actions: [{ kind: 'group', group: { op: 'rename', groupRef: 'A', name: '<img onerror=x>' } }],
        }, 'characters that are not allowed in a name');
    });

    it('accepts the punctuation real callsigns and places use', () => {
        for (const name of ["O'Rourke", 'Al-Qarah', 'Fallow Gate #2', 'Sector B9', 'St. Ives (north)']) {
            const result = validateNLResponse({
                actions: [{ kind: 'group', group: { op: 'rename', groupRef: 'A', name } }],
            }, { vocabulary });
            expect(result.ok, `${name} should be a legal name`).toBe(true);
        }
    });

    it('rejects an over-long name', () => {
        bad({
            actions: [{ kind: 'group', group: { op: 'rename', groupRef: 'A', name: 'x'.repeat(65) } }],
        }, 'exceeds 64 chars');
    });

    it('rejects a scale outside 1..4', () => {
        bad({
            actions: [{
                kind: 'command',
                intent: { verb: 'attack', subject: { type: 'class-count', class: 'tanks', count: 1, scale: 7 } },
            }],
        }, 'must be an integer 1..4');
    });

    it('rejects a when-condition the sim cannot evaluate', () => {
        bad({
            actions: [{
                kind: 'command',
                intent: {
                    verb: 'attack', subject: { type: 'any' },
                    when: { type: 'enemy-commander-spotted' },
                },
            }],
        }, 'is not a known condition');
    });

    it('reports several problems at once', () => {
        const result = validateNLResponse({
            actions: [{ kind: 'command', intent: { verb: 'nuke', subject: { type: 'nobody' } } }],
        }, { vocabulary });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.length).toBeGreaterThan(1);
    });

    it('a valid envelope round-trips through JSON unchanged', () => {
        // The proxy will hand this validator a parsed JSON body, so anything that
        // survives validation must survive the trip.
        for (const fixture of fixtures) {
            const round = JSON.parse(JSON.stringify(fixture.expected)) as NLResponse;
            expect(validateNLResponse(round, { vocabulary }).ok, fixture.name).toBe(true);
        }
    });
});
