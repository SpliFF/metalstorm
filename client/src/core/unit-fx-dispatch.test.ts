/**
 * unit-fx-dispatch tests — resolution order, death/sound dispatch, hit-flinch
 * duck-typing, damage-smoke hysteresis, and the move-dust 40-emitter /
 * camera-distance cap. Pure node; no GL, no Babylon.
 */

import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    UnitFxDispatch,
    parseUnitClassScale,
    resolveUnitFx,
    type UnitFxDeps,
    type UnitFxEntity,
    type UnitFxMap,
    type UnitFxSlots,
} from './unit-fx-dispatch.js';
import type { NativeFxSink } from './weapon-fx-resolver.js';
import type { FxLibrary } from './native-fx/effect-compiler.js';

const UNIT_FX: UnitFxMap = {
    byClass: {
        tanks: { death: 'death_vehicle_s2', sound: 'death_vehicle_light',
            damageSmoke: 'smoke_light', damageSmokeHeavy: 'smoke_heavy', moveDust: 'dust_trail' },
        soldiers: { death: 'death_infantry', sound: 'death_infantry' },
    },
    scaleOverrides: {
        tanks: { '3': { death: 'death_vehicle_s3', sound: 'death_vehicle_heavy' } },
    },
    units: {
        ms_tanks_s2_hero: { death: 'death_hero' },
    },
};

function stubSink(known: Set<string>): NativeFxSink {
    return {
        resolve: () => null,
        has: (e) => known.has(e),
        spawn: vi.fn(),
        volleyTracers: vi.fn(),
        scar: vi.fn(),
    };
}

function makeDeps(overrides: Partial<UnitFxDeps> = {}): UnitFxDeps & { sink: NativeFxSink } {
    const sink = stubSink(new Set([
        'death_vehicle_s2', 'death_vehicle_s3', 'death_infantry', 'death_hero',
        'smoke_light', 'smoke_heavy', 'dust_trail',
    ]));
    return {
        unitFx: UNIT_FX,
        sink,
        getUnitDefName: (defId) => ({ 1: 'ms_tanks_s2', 2: 'ms_soldiers_s1', 3: 'ms_tanks_s3' } as Record<number, string>)[defId],
        getEntities: function* (): IterableIterator<[number, UnitFxEntity]> {},
        getEntityPosition: () => ({ x: 0, y: 0, z: 0 }),
        ...overrides,
    };
}

describe('parseUnitClassScale', () => {
    it('parses the ms_<class>_s<n> convention case-insensitively', () => {
        expect(parseUnitClassScale('ms_tanks_s2')).toEqual({ cls: 'tanks', scale: 2 });
        expect(parseUnitClassScale('MS_Artillery_S4')).toEqual({ cls: 'artillery', scale: 4 });
    });
    it('returns null for a non-conforming name (e.g. a building)', () => {
        expect(parseUnitClassScale('barracks_01')).toBeNull();
    });
});

describe('resolveUnitFx', () => {
    it('resolves byClass as the base', () => {
        expect(resolveUnitFx(UNIT_FX, 'ms_soldiers_s1')).toMatchObject({ death: 'death_infantry' });
    });
    it('layers scaleOverrides on top of byClass', () => {
        const s = resolveUnitFx(UNIT_FX, 'ms_tanks_s3')!;
        expect(s.death).toBe('death_vehicle_s3');
        expect(s.sound).toBe('death_vehicle_heavy');
        // Fields the scale override doesn't touch fall through from byClass.
        expect(s.moveDust).toBe('dust_trail');
    });
    it('an exact units[] entry wins over class + scale', () => {
        const s = resolveUnitFx(UNIT_FX, 'ms_tanks_s2_hero')!;
        expect(s.death).toBe('death_hero');
    });
    it('returns null for an unresolvable def', () => {
        expect(resolveUnitFx(UNIT_FX, 'barracks_01')).toBeNull();
    });
});

describe('UnitFxDispatch.onDeath', () => {
    it('spawns the class death effect and plays its sound at the given position', () => {
        const deps = makeDeps();
        const dispatch = new UnitFxDispatch(deps);
        const playNamedSound = vi.fn();
        (deps as UnitFxDeps).playNamedSound = playNamedSound;

        dispatch.onDeath(42, 1 /* ms_tanks_s2 */, 10, 20, 30);

        expect(deps.sink.spawn).toHaveBeenCalledWith('death_vehicle_s2', 10, 20, 30, 0, 1, 0);
        expect(playNamedSound).toHaveBeenCalledWith('death_vehicle_light', 10, 20, 30);
    });

    it('does nothing for an unknown def id', () => {
        const deps = makeDeps();
        const dispatch = new UnitFxDispatch(deps);
        dispatch.onDeath(99, 999, 0, 0, 0);
        expect(deps.sink.spawn).not.toHaveBeenCalled();
    });
});

describe('UnitFxDispatch.onHit', () => {
    it('calls motionLean.impulse when a sink is wired', () => {
        const impulse = vi.fn();
        const deps = makeDeps({ getMotionLean: () => ({ impulse }) });
        const dispatch = new UnitFxDispatch(deps);
        dispatch.onHit(7, 1, 0, 2.5);
        expect(impulse).toHaveBeenCalledWith(7, 1, 0, 2.5);
    });

    it('is a no-op (never throws) when pres-anim has not landed motionLean', () => {
        const dispatch = new UnitFxDispatch(makeDeps());
        expect(() => dispatch.onHit(7, 1, 0, 2.5)).not.toThrow();
    });
});

describe('UnitFxDispatch damage-smoke hysteresis', () => {
    it('fires the light smoke slot once health drops below 0.5, heavy below 0.25, on the 1.5s cadence', () => {
        const meta = new Map<number, UnitFxEntity>([[1, { defId: 1, healthScale: 1 }]]);
        const deps = makeDeps({
            getEntities: () => meta.entries(),
        });
        const dispatch = new UnitFxDispatch(deps);

        // Full health: the first sweep also seeds the 1.5s eval timer.
        dispatch.tick(0.25, 0, 0, 0);
        expect(deps.sink.spawn).not.toHaveBeenCalled();

        // Drops below 0.5, but the band is only re-evaluated on the 1.5s
        // cadence (the hysteresis window) — not on every move-dust sweep.
        meta.get(1)!.healthScale = 0.4;
        dispatch.tick(0.25, 0, 0, 0);
        expect(deps.sink.spawn).not.toHaveBeenCalled();

        // Past the 1.5s window: the band re-evaluates and the light loop fires.
        dispatch.tick(1.5, 0, 0, 0);
        expect(deps.sink.spawn).toHaveBeenCalledWith('smoke_light', 0, 0, 0, 0, 1, 0);
        (deps.sink.spawn as ReturnType<typeof vi.fn>).mockClear();

        // Still inside the new 1.5s window: no second trigger yet even
        // though health has since dropped further.
        meta.get(1)!.healthScale = 0.1;
        dispatch.tick(0.25, 0, 0, 0);
        expect(deps.sink.spawn).not.toHaveBeenCalled();

        // Past the window again: re-evaluates to heavy and retriggers.
        dispatch.tick(1.5, 0, 0, 0);
        expect(deps.sink.spawn).toHaveBeenCalledWith('smoke_heavy', 0, 0, 0, 0, 1, 0);
    });
});

describe('UnitFxDispatch move-dust', () => {
    it('caps concurrent emitters at 40, nearest camera distance first', () => {
        const meta = new Map<number, UnitFxEntity>();
        const positions = new Map<number, { x: number; y: number; z: number }>();
        for (let i = 0; i < 50; i++) {
            meta.set(i, { defId: 1, healthScale: 1 });
            positions.set(i, { x: i * 10, y: 0, z: 0 });   // farther with higher id
        }
        const deps = makeDeps({
            getEntities: () => meta.entries(),
            getEntityPosition: (id) => positions.get(id) ?? null,
            getUnitSpeed: () => 4,
        });
        const dispatch = new UnitFxDispatch(deps);

        dispatch.tick(0.25, 0, 0, 0);   // sweep runs; camera at origin

        const spawnedIds = new Set(
            (deps.sink.spawn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1] / 10),
        );
        expect(spawnedIds.size).toBeLessThanOrEqual(40);
        // The nearest unit (id 0) must be among the emitters that fired.
        expect(spawnedIds.has(0)).toBe(true);
        // The farthest unit (id 49) must have been dropped by the cap.
        expect(spawnedIds.has(49)).toBe(false);
    });

    it('never spawns dust for a stationary unit (speed 0)', () => {
        const meta = new Map<number, UnitFxEntity>([[1, { defId: 1, healthScale: 1 }]]);
        const deps = makeDeps({ getEntities: () => meta.entries(), getUnitSpeed: () => 0 });
        const dispatch = new UnitFxDispatch(deps);
        dispatch.tick(0.25, 0, 0, 0);
        expect(deps.sink.spawn).not.toHaveBeenCalled();
    });
});

describe('shipped unit-fx.json (data/games/metalstorm/effects)', () => {
    const root = path.join(__dirname, '../../../data/games/metalstorm/effects');
    const shippedUnitFx = JSON.parse(
        fs.readFileSync(path.join(root, 'unit-fx.json'), 'utf8')) as UnitFxMap;
    const shippedLibrary = JSON.parse(
        fs.readFileSync(path.join(root, 'library.json'), 'utf8')) as FxLibrary;

    /** gamedata/sounds.lua's death SoundItem keys (pres-audio's owned file —
     *  not read here since it lands on a sibling branch; this pins the
     *  contract so an author typo is caught even before that file exists). */
    const KNOWN_DEATH_SOUNDS = new Set([
        'death_infantry', 'death_vehicle_light', 'death_vehicle_heavy',
        'death_aircraft', 'death_ship', 'death_building',
    ]);

    function allSlots(): UnitFxSlots[] {
        const out: UnitFxSlots[] = [];
        for (const cls of Object.keys(shippedUnitFx.byClass)) {
            for (const scale of [1, 2, 3, 4]) {
                const s = resolveUnitFx(shippedUnitFx, `ms_${cls}_s${scale}`);
                if (s) out.push(s);
            }
        }
        return out;
    }

    it('every byClass entry resolves at every authored scale', () => {
        expect(allSlots().length).toBeGreaterThan(0);
    });

    it('every visual effect referenced exists in library.json', () => {
        const visualKeys: (keyof UnitFxSlots)[] = [
            'death', 'damageSmoke', 'damageSmokeHeavy', 'burning',
            'moveDust', 'contactPlant', 'wake', 'thruster', 'buildFx',
        ];
        for (const slots of allSlots()) {
            for (const key of visualKeys) {
                const name = slots[key];
                if (name) expect(shippedLibrary.effects[name], `${key}="${name}"`).toBeDefined();
            }
        }
    });

    it('every sound field is one of the death SoundItem keys pres-audio owns', () => {
        for (const slots of allSlots()) {
            if (slots.sound) expect(KNOWN_DEATH_SOUNDS.has(slots.sound), slots.sound).toBe(true);
        }
    });
});
