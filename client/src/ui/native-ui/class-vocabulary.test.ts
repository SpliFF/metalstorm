/**
 * class-vocabulary.test.ts — the anti-drift guard
 * (PLAN-metalstorm-command-language.md §2, M0)
 *
 * The point of shipping the class vocabulary as data was to stop it drifting
 * from the unit defs the way `free-text-accelerator.ts`'s hand-kept
 * `IDLE_CLASSES` did (it named `statics` for a class actually called
 * `staticdefense`, invented `armour` and `infantry` as classes, and never
 * heard of `buildings`/`civilians`/`civvehicles`). Shipping it as data only
 * moves the drift unless something checks it — that is this file.
 *
 * The check reads the REAL taxonomy straight out of the Lua unit defs
 * (`data/games/metalstorm/units/*.lua`), which is what the server streams to
 * the client as `customparams.ms_class`, so adding a class to the game without
 * teaching the command language to say it — or naming a class here that the
 * game doesn't ship — fails the suite.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ClassVocabulary, type ClassVocabularyData } from './class-vocabulary.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const UNITS_DIR = join(REPO, 'data', 'games', 'metalstorm', 'units');
const VOCABULARY_PATH = join(REPO, 'data', 'games', 'metalstorm', 'ui', 'class-vocabulary.json');

/**
 * Classes that ship in unit defs but are deliberately NOT command vocabulary.
 *
 * `fable_showcase` (units/fable_*.lua) and `wz_baseline` (units/wz_baseline.lua)
 * are art/engine test fixtures spawned by the model-viewer and baseline
 * scenarios, not fielded forces — a player can't be given "the wz_baseline",
 * and offering it as an idle-filter subject would be a lie. Everything else in
 * the defs must be speakable.
 */
const NON_COMBATANT_FIXTURE_CLASSES = new Set(['fable_showcase', 'wz_baseline']);

/**
 * Every `ms_class` the shipped unit defs actually set.
 *
 * Two authoring shapes, both covered:
 *   - `_builder.lua` classes — `units/<class>.lua` passes `class = '<x>'` to
 *     the builder, which writes `customparams.ms_class = spec.class` for each
 *     of the 4 scales.
 *   - hand-written families — `buildings_military.lua` /
 *     `buildings_civilian.lua` / `civilians.lua` / `civvehicles.lua` set
 *     `customparams.ms_class = '<x>'` (or `t.customparams.ms_class = '<x>'`)
 *     directly and carry no `ms_scale`.
 */
function shippedClasses(): Set<string> {
    const found = new Set<string>();
    for (const file of readdirSync(UNITS_DIR)) {
        if (!file.endsWith('.lua') || file === '_builder.lua') continue;
        const src = readFileSync(join(UNITS_DIR, file), 'utf8');
        for (const m of src.matchAll(/ms_class\s*=\s*'([^']+)'/g)) found.add(m[1]);
        // `mk{ class = 'tanks', ... }` — the builder call's own class field.
        for (const m of src.matchAll(/^\s*class\s*=\s*'([^']+)'/gm)) found.add(m[1]);
    }
    return found;
}

function loadShippedVocabulary(): ClassVocabularyData {
    return JSON.parse(readFileSync(VOCABULARY_PATH, 'utf8')) as ClassVocabularyData;
}

describe('class-vocabulary.json ↔ unit defs', () => {
    const data = loadShippedVocabulary();
    const shipped = shippedClasses();

    it('reads a non-trivial taxonomy out of the unit defs (guards the scraper itself)', () => {
        // If the def-authoring shape changes and the regexes stop matching,
        // every other assertion here would pass vacuously. They must not.
        expect(shipped.size).toBeGreaterThanOrEqual(14);
        expect(shipped).toContain('tanks');
        expect(shipped).toContain('staticdefense');
        expect(shipped).toContain('civvehicles');
    });

    it('names only classes the game actually ships', () => {
        const invented = Object.keys(data.classes).filter((c) => !shipped.has(c));
        expect(invented).toEqual([]);
    });

    it('covers every fielded class (fixture-only classes excluded)', () => {
        const missing = [...shipped]
            .filter((c) => !NON_COMBATANT_FIXTURE_CLASSES.has(c))
            .filter((c) => !(c in data.classes))
            .sort();
        expect(missing).toEqual([]);
    });

    it('covers the shipped roster (M0 named 14; the model-integration M1/M2 roster grew it to 24)', () => {
        expect(Object.keys(data.classes).sort()).toEqual([
            'artillery', 'balloon', 'bombers', 'buildings', 'civilians',
            'civvehicles', 'command', 'courier', 'engineers', 'expedition',
            'fighters', 'landing_ship', 'mechs', 'radar', 'scout', 'ships',
            'sites', 'soldiers', 'staticdefense', 'subs', 'supply', 'tanker',
            'tanks', 'technical',
        ]);
    });

    it('does not offer the art-fixture classes as command vocabulary', () => {
        for (const fixture of NON_COMBATANT_FIXTURE_CLASSES) {
            expect(data.classes[fixture]).toBeUndefined();
        }
    });

    it('keys every `scales` entry on a real ms_scale (1-4, per _builder.lua)', () => {
        for (const [className, entry] of Object.entries(data.classes)) {
            for (const scaleKey of Object.keys(entry.scales ?? {})) {
                expect(['1', '2', '3', '4'], `${className} scale key`).toContain(scaleKey);
            }
        }
    });

    it('declares scales only for the classes _builder.lua generates in 4 scales', () => {
        // buildings / civilians / civvehicles are authored one-off and carry
        // no ms_scale at all, so a scale phrase for them could never match a
        // real unit.
        for (const className of ['buildings', 'civilians', 'civvehicles']) {
            expect(data.classes[className].scales, className).toBeUndefined();
        }
    });

    it('points every role clause at a real class', () => {
        for (const [roleName, role] of Object.entries(data.roles ?? {})) {
            for (const clause of role.matches) {
                expect(Object.keys(data.classes), `role "${roleName}"`).toContain(clause.class);
            }
        }
    });
});

describe('ClassVocabulary lookup', () => {
    const vocabulary = ClassVocabulary.fromData(loadShippedVocabulary());

    it('canonicalises a synonym to the sim\'s own class name', () => {
        expect(vocabulary.lookup('armour')).toMatchObject({ kind: 'class', className: 'tanks', scale: null });
        // The exact drift the old IDLE_CLASSES shipped: "statics" is what a
        // player says, "staticdefense" is what the def says.
        expect(vocabulary.lookup('statics')).toMatchObject({ kind: 'class', className: 'staticdefense' });
        expect(vocabulary.lookup('infantry')).toMatchObject({ kind: 'class', className: 'soldiers' });
    });

    it('resolves a scale phrase to class + ms_scale', () => {
        expect(vocabulary.lookup('heavy tanks')).toMatchObject({ kind: 'class', className: 'tanks', scale: 3, words: 2 });
        // Hyphenation is normalised the same way the accelerator tokenizes, so
        // both spellings land on the same phrase.
        expect(vocabulary.lookup('super-heavy tank')).toMatchObject({ className: 'tanks', scale: 4 });
        expect(vocabulary.lookup('superheavy tank')).toMatchObject({ className: 'tanks', scale: 4 });
    });

    it('resolves roles, keeping every matching clause', () => {
        const match = vocabulary.lookup('air defense');
        expect(match).toMatchObject({ kind: 'role', roleName: 'air defense' });
        expect(match?.kind === 'role' && match.matches).toEqual([
            { class: 'staticdefense', scaleMin: 2 },
            { class: 'fighters' },
        ]);
        expect(vocabulary.lookup('anti-air')).toMatchObject({ kind: 'role', roleName: 'air defense' });
    });

    it('matches the longest phrase at a position, not the first word', () => {
        const words = ['heavy', 'tanks', 'attack'];
        expect(vocabulary.matchAt(words, 0)).toMatchObject({ className: 'tanks', scale: 3, words: 2 });
        expect(vocabulary.matchAt(words, 1)).toMatchObject({ className: 'tanks', scale: null, words: 1 });
        expect(vocabulary.matchAt(words, 2)).toBeNull();
    });

    it('claims no phrase for two different entries', () => {
        // A phrase owned by two classes would make resolution order-dependent
        // — the loader warns and keeps the first, so catch it here instead.
        const warnings: unknown[][] = [];
        const original = console.warn;
        console.warn = (...args: unknown[]) => { warnings.push(args); };
        try {
            ClassVocabulary.fromData(loadShippedVocabulary());
        } finally {
            console.warn = original;
        }
        expect(warnings).toEqual([]);
    });

    it('an empty vocabulary resolves nothing (no hidden built-in fallback)', () => {
        const empty = ClassVocabulary.empty();
        expect(empty.lookup('tanks')).toBeNull();
        expect(empty.classNames()).toEqual([]);
        expect(empty.matchAt(['tanks'], 0)).toBeNull();
    });
});
