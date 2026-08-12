/**
 * nl-fixtures/load-fixtures.ts — TEST-ONLY loader for the golden fixtures
 * (PLAN-metalstorm-command-language.md §8)
 *
 * Reads the fixture JSON, the shipped class vocabulary and the shared wire
 * fixtures off disk with `node:fs`, so the fixture files stay plain data that a
 * human can read and a future eval harness (`tools/nl-eval`, M7) can consume
 * without importing any client code.
 *
 * Imported only from `*.test.ts`. It is not part of any bundle — nothing in the
 * app graph references it — but it lives beside the fixtures rather than inside a
 * test file because four suites need it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ClassVocabulary, type ClassVocabularyData } from '../class-vocabulary.js';
import {
    buildFixtureWorld,
    type FixtureContext, type FixtureFile, type FixtureWorld, type NLFixture,
} from './fixture-world.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..', '..');

const VOCABULARY_PATH = join(REPO, 'data', 'games', 'metalstorm', 'ui', 'class-vocabulary.json');

/** The shared TS↔Lua codec fixtures. Also read by
 *  `LuaRules/Gadgets/tests/guidance_wire_spec.lua` — see that file's header. */
export const WIRE_FIXTURE_PATH = join(
    REPO, 'data', 'games', 'metalstorm', 'LuaRules', 'Gadgets', 'parley', 'tests', 'wire-fixtures.tsv',
);

/** Every fixture file in this directory, in a fixed order so failures are
 *  reproducible and a `.only` on one file is obvious in the output. */
export const FIXTURE_FILES = [
    'commands.json',
    'guidance.json',
    'groups-ui-query.json',
    'camera-ui-query.json',
    'clarify-refuse.json',
    'multi-step.json',
] as const;

export function loadVocabulary(): ClassVocabulary {
    return ClassVocabulary.fromData(
        JSON.parse(readFileSync(VOCABULARY_PATH, 'utf8')) as ClassVocabularyData,
    );
}

export interface LoadedFixture extends NLFixture {
    /** Which file it came from, for test names. */
    file: string;
}

export function loadFixtures(): LoadedFixture[] {
    const out: LoadedFixture[] = [];
    for (const file of FIXTURE_FILES) {
        const parsed = JSON.parse(readFileSync(join(HERE, file), 'utf8')) as FixtureFile;
        for (const fixture of parsed.fixtures) out.push({ ...fixture, file });
    }
    return out;
}

const contexts = () =>
    JSON.parse(readFileSync(join(HERE, 'contexts.json'), 'utf8')) as Record<string, FixtureContext>;

export function loadContexts(): Record<string, FixtureContext> {
    const raw = contexts();
    // The `_`-prefixed keys are documentation, not boards.
    return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('_')));
}

/** Build the world one fixture is resolved against. Throws on an unknown key so
 *  a typo in `context` fails loudly instead of silently resolving nothing. */
export function worldFor(fixture: NLFixture, vocabulary: ClassVocabulary): FixtureWorld {
    const all = loadContexts();
    const context = all[fixture.context];
    if (!context) {
        throw new Error(
            `fixture "${fixture.name}" names context "${fixture.context}", which contexts.json ` +
            `doesn't define (has: ${Object.keys(all).join(', ')})`);
    }
    return buildFixtureWorld(context, vocabulary);
}

// ─────────────────── the shared wire fixtures (TSV) ───────────────────

export interface WireFixture {
    cmd: string;
    /** The exact bytes `encodeWire` must produce. */
    wire: string;
    /** Fields as the encoder receives them (lists already split). */
    fields: Record<string, string | string[]>;
}

/**
 * Parse `wire-fixtures.tsv`. Two rules, matching the Lua reader in
 * `guidance_wire_spec.lua` exactly (see the fixture file's header): a field
 * column splits on its FIRST `=`, and a key ending `[]` marks a comma-joined
 * list.
 */
export function loadWireFixtures(): WireFixture[] {
    const text = readFileSync(WIRE_FIXTURE_PATH, 'utf8');
    const out: WireFixture[] = [];
    for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const cols = line.split('\t');
        const fields: Record<string, string | string[]> = {};
        for (const col of cols.slice(2)) {
            const eq = col.indexOf('=');
            if (eq < 0) throw new Error(`malformed field column in wire fixtures: ${col}`);
            const key = col.slice(0, eq);
            const value = col.slice(eq + 1);
            if (key.endsWith('[]')) fields[key.slice(0, -2)] = value.split(',');
            else fields[key] = value;
        }
        out.push({ cmd: cols[0], wire: cols[1], fields });
    }
    return out;
}
