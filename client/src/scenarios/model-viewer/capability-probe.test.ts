/**
 * Capability-probe fixtures (PLAN-model-harness §11): def shapes →
 * expected button sets, including transportee selection via a mocked sim
 * probe reply.
 */

import { describe, expect, it } from 'vitest';
import {
    deriveClipButtons,
    deriveShowcases,
    parseTransporteeProbe,
    pickTransporteeFallback,
    probeFromDef,
    UDF,
    type DefWireLike,
} from './capability-probe.js';

function ids(d: DefWireLike): string[] {
    return deriveShowcases(probeFromDef(d)).map((s) => s.id);
}

const ALWAYS = ['idle', 'damage', 'explode', 'respawn'];

describe('deriveShowcases', () => {
    it('armed ground tank: circuit + turn + all weapon showcases', () => {
        const got = ids({
            name: 'lighttank', flags: UDF.CAN_MOVE, speed: 60,
            weaponDefIds: [7], wreckName: 'lighttank_dead', health: 900,
        });
        expect(got).toEqual([
            'idle', 'circuit', 'turn-in-place', 'aim', 'volley', 'sustained',
            'damage', 'explode', 'respawn',
        ]);
    });

    it('aircraft gets the fly circuit, not the ground one', () => {
        const got = ids({
            name: 'fighter', flags: UDF.CAN_MOVE | UDF.CAN_FLY, speed: 240,
            weaponDefIds: [1, 2],
        });
        expect(got).toContain('fly-circuit');
        expect(got).not.toContain('circuit');
        expect(got).not.toContain('turn-in-place');
    });

    it('ship/sub gets the sail circuit', () => {
        expect(ids({ name: 'boat', flags: UDF.CAN_MOVE | UDF.FLOAT_ON_WATER, speed: 80 }))
            .toContain('sail-circuit');
        const sub = deriveShowcases(probeFromDef(
            { name: 'sub', flags: UDF.CAN_MOVE | UDF.CAN_SUBMERGE, speed: 70 }));
        const sail = sub.find((s) => s.id === 'sail-circuit')!;
        expect(sail.label).toContain('sub');
    });

    it('canMove with speed 0 (ZK factories) gets NO movement rows', () => {
        const got = ids({
            name: 'factorycloak',
            flags: UDF.CAN_MOVE | UDF.IS_BUILDER | UDF.IS_FACTORY | UDF.IS_BUILDING,
            speed: 0, buildOptions: [10],
        });
        expect(got).not.toContain('circuit');
        expect(got).not.toContain('turn-in-place');
        expect(got).not.toContain('fly-circuit');
        expect(got).toContain('produce');
    });

    it('static turret: weapons but no movement showcases', () => {
        const got = ids({
            name: 'turret', flags: UDF.IS_BUILDING, weaponDefIds: [3],
        });
        expect(got).toEqual(['idle', 'construction', 'aim', 'volley', 'sustained',
            'damage', 'explode', 'respawn']);
    });

    it('building gets the construction showcase; a plain unit does not', () => {
        expect(ids({ name: 'depot', flags: UDF.IS_BUILDING })).toContain('construction');
        expect(ids({ name: 'solo', flags: UDF.CAN_MOVE })).not.toContain('construction');
    });

    it('a factory building gets construction AND produce', () => {
        const got = ids({
            name: 'foundry',
            flags: UDF.IS_BUILDER | UDF.IS_FACTORY | UDF.IS_BUILDING,
            buildOptions: [10],
        });
        expect(got).toContain('construction');
        expect(got).toContain('produce');
    });

    it('unarmed mobile builder gets build, factory gets produce instead', () => {
        const builder = ids({
            name: 'con', flags: UDF.CAN_MOVE | UDF.IS_BUILDER, buildOptions: [10, 11],
        });
        expect(builder).toContain('build');
        expect(builder).not.toContain('produce');

        // Factories are builders too (bit 0 set) — produce must win.
        const factory = ids({
            name: 'fac', flags: UDF.IS_BUILDER | UDF.IS_FACTORY | UDF.IS_BUILDING,
            buildOptions: [10],
        });
        expect(factory).toContain('produce');
        expect(factory).not.toContain('build');
    });

    it('builder without build options gets neither', () => {
        const got = ids({ name: 'oddball', flags: UDF.IS_BUILDER });
        expect(got).not.toContain('build');
        expect(got).not.toContain('produce');
    });

    it('transport capacity enables load/unload', () => {
        const got = ids({
            name: 'trans', flags: UDF.CAN_MOVE | UDF.CAN_FLY,
            transportCapacity: 1, transportMass: 5000, transportSize: 4,
        });
        expect(got).toContain('load-unload');
    });

    it('always-rows appear for a def with nothing else', () => {
        expect(ids({ name: 'prop', flags: 0 })).toEqual(ALWAYS);
    });

    it('wreck-less def relabels explode and says so', () => {
        const specs = deriveShowcases(probeFromDef({ name: 'x', flags: 0 }));
        const explode = specs.find((s) => s.id === 'explode')!;
        expect(explode.label).toBe('Explode');
        const specsW = deriveShowcases(probeFromDef(
            { name: 'x', flags: 0, wreckName: 'x_dead' }));
        expect(specsW.find((s) => s.id === 'explode')!.label).toContain('wreck');
    });

    it('metalstorm squads surface the fan-out row', () => {
        const got = ids({
            name: 'ms_tanks_s2', flags: UDF.CAN_MOVE, weaponDefIds: [1],
            customParams: { squad_size: '4' },
        });
        expect(got).toContain('squad-fanout');
        // …and a plain unit does not.
        expect(ids({ name: 'solo', flags: UDF.CAN_MOVE })).not.toContain('squad-fanout');
    });
});

describe('transportee selection', () => {
    it('accepts a clean sim-probe reply', () => {
        expect(parseTransporteeProbe('lighttank\n')).toBe('lighttank');
    });

    it('strips the exec scope’s literal string quoting (live-found)', () => {
        expect(parseTransporteeProbe('"cloakraid"')).toBe('cloakraid');
        expect(parseTransporteeProbe('""')).toBeNull();
    });

    it('rejects empty / error-shaped replies', () => {
        expect(parseTransporteeProbe('')).toBeNull();
        expect(parseTransporteeProbe('   ')).toBeNull();
        expect(parseTransporteeProbe('[string "..."]:3: attempt to index nil')).toBeNull();
    });

    it('fallback picks the cheapest def passing the def-level rules', () => {
        const picked = pickTransporteeFallback([
            { name: 'heavy', flags: UDF.CAN_MOVE, mass: 9000, xsize: 4, metalCost: 800 },
            { name: 'cheap', flags: UDF.CAN_MOVE, mass: 100, xsize: 2, metalCost: 40 },
            { name: 'flyer', flags: UDF.CAN_MOVE | UDF.CAN_FLY, mass: 50, xsize: 2, metalCost: 10 },
            { name: 'building', flags: UDF.IS_BUILDING, mass: 100, xsize: 2, metalCost: 5 },
            { name: 'wide', flags: UDF.CAN_MOVE, mass: 100, xsize: 12, metalCost: 20 },
        ], { transportMass: 5000, transportSize: 4 });
        expect(picked).toBe('cheap');
    });

    it('fallback returns null when nothing qualifies', () => {
        expect(pickTransporteeFallback(
            [{ name: 'heavy', flags: UDF.CAN_MOVE, mass: 9000, xsize: 4 }],
            { transportMass: 100, transportSize: 2 },
        )).toBeNull();
    });
});

describe('deriveClipButtons (task 6)', () => {
    it('one labelled button per authored clip, deduped + sorted', () => {
        expect(deriveClipButtons(['walk', 'idle', 'walk', 'death'])).toEqual([
            { clip: 'death', label: 'Play clip: death' },
            { clip: 'idle', label: 'Play clip: idle' },
            { clip: 'walk', label: 'Play clip: walk' },
        ]);
    });

    it('clipless model (every converted S3O/DAE today) yields no buttons', () => {
        expect(deriveClipButtons([])).toEqual([]);
    });
});
