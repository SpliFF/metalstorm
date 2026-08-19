import { describe, it, expect } from 'vitest';
import { msClassesFor, resolveUnitClassToDefIds } from './unit-class-filter.js';

/** A slice of the Metalstorm roster, `ms_class` values as units/*.lua sets them. */
const DEFS = [
    { defId: 10, customParams: { ms_class: 'tanks' } },
    { defId: 11, customParams: { ms_class: 'tanks' } },
    { defId: 20, customParams: { ms_class: 'soldiers' } },
    { defId: 30, customParams: { ms_class: 'artillery' } },
    { defId: 40, customParams: { ms_class: 'engineers' } },
    { defId: 50, customParams: { ms_class: 'radar' } },
    { defId: 60, customParams: { ms_class: 'fighters' } },
    { defId: 61, customParams: { ms_class: 'bombers' } },
    { defId: 70 },                                  // no customParams at all
];

describe('msClassesFor', () => {
    it('maps the composer vocabulary onto ms_class keys', () => {
        expect(msClassesFor('armour')).toEqual(['tanks']);
        expect(msClassesFor('infantry')).toEqual(['soldiers']);
    });

    it('treats an exact ms_class key as itself', () => {
        expect(msClassesFor('artillery')).toEqual(['artillery']);
        expect(msClassesFor('engineers')).toEqual(['engineers']);
    });

    it('expands "air" to both air classes — it is not an ms_class', () => {
        expect(msClassesFor('air')).toEqual(['fighters', 'bombers']);
    });

    it('is case- and whitespace-insensitive', () => {
        expect(msClassesFor('  Armour ')).toEqual(['tanks']);
    });

    it('returns nothing for an empty name', () => {
        expect(msClassesFor('')).toEqual([]);
        expect(msClassesFor('   ')).toEqual([]);
    });
});

describe('resolveUnitClassToDefIds', () => {
    it('resolves a class to every def in it', () => {
        expect(resolveUnitClassToDefIds('armour', DEFS)).toEqual([10, 11]);
    });

    it('distinguishes the classes the composer offers', () => {
        // The whole point of D56: these four used to compile to the same
        // message because the class never reached the wire.
        expect(resolveUnitClassToDefIds('armour', DEFS)).toEqual([10, 11]);
        expect(resolveUnitClassToDefIds('infantry', DEFS)).toEqual([20]);
        expect(resolveUnitClassToDefIds('artillery', DEFS)).toEqual([30]);
        expect(resolveUnitClassToDefIds('air', DEFS)).toEqual([60, 61]);
    });

    it('excludes the units a scenario leaves unordered', () => {
        // Engineers and the radar are the only permanently-idle units in
        // crossing_standoff, and they are what an unfiltered directive
        // actually reached. "armour" must not include them.
        const armour = resolveUnitClassToDefIds('armour', DEFS);
        expect(armour).not.toContain(40);
        expect(armour).not.toContain(50);
    });

    it('returns empty for a class this roster has none of', () => {
        // The caller must read this as "send no filter", never as "match
        // nothing" — an empty squad_types is the wire's wildcard.
        expect(resolveUnitClassToDefIds('ships', DEFS)).toEqual([]);
        expect(resolveUnitClassToDefIds('nonsense', DEFS)).toEqual([]);
    });

    it('tolerates defs with no customParams', () => {
        expect(resolveUnitClassToDefIds('armour', DEFS)).not.toContain(70);
    });
});
