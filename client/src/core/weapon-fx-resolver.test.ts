/**
 * weapon-fx-resolver tests — the L-FX content gate.
 *
 * Reads the SHIPPED data/games/metalstorm files (not fixtures): every weapon
 * def in weapons.lua must resolve to drawable slots, and every effect any of
 * those slots names must exist in library.json. This is the test that fails
 * when a weapon family is added without FX, which is exactly how combat ended
 * up rendering flat orange cubes.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { resolveEffect, type FxLibrary } from './native-fx/effect-compiler.js';
import {
    resolveWeaponFx, slotsHaveEffects, weaponTypeForProjectileType,
    type WeaponFxMap,
} from './weapon-fx-resolver.js';
import { ProjectileType } from './weapon-fx-dispatch.js';

const GAME = path.resolve(__dirname, '../../../data/games/metalstorm');
const LIB = JSON.parse(
    fs.readFileSync(path.join(GAME, 'effects/library.json'), 'utf8')) as FxLibrary;
const MAP = JSON.parse(
    fs.readFileSync(path.join(GAME, 'effects/weapon-fx.json'), 'utf8')) as WeaponFxMap;
const WEAPONS_LUA = fs.readFileSync(path.join(GAME, 'weapons/weapons.lua'), 'utf8');

/**
 * Enumerate (name, weapontype) out of weapons.lua without a Lua runtime. The
 * file builds defs three ways and only three:
 *   defs.NAME = { … }         — a literal entry
 *   NAME = { … } inside `local defs = {`
 *   family('PREFIX', { weapontype = … }, { n scale entries })  → PREFIX_S1..Sn
 * A shape this parser cannot see is a test failure by construction (the count
 * assertion below), not a silent skip.
 */
function weaponDefsFromLua(src: string): { name: string; weaponType: string }[] {
    const out: { name: string; weaponType: string }[] = [];

    for (const m of src.matchAll(/\bdefs\.([A-Z0-9_]+)\s*=\s*\{([\s\S]*?)\n\}/g)) {
        out.push({ name: m[1], weaponType: weaponTypeOf(m[2]) });
    }
    // The seed table's inline entries (`NOWEAPON = { … }`).
    const seed = /local defs = \{([\s\S]*?)\n\}\n/.exec(src);
    if (seed) {
        for (const m of seed[1].matchAll(/^\s{4}([A-Z0-9_]+)\s*=\s*\{([\s\S]*?)\n\s{4}\}/gm)) {
            out.push({ name: m[1], weaponType: weaponTypeOf(m[2]) });
        }
    }
    for (const m of src.matchAll(
        /family\('([A-Z0-9_]+)',\s*\{([\s\S]*?)\n\},\s*\{([\s\S]*?)\n\}\)/g)) {
        const type = weaponTypeOf(m[2]);
        const scales = m[3].split('\n').filter((l) => /^\s*\{\s*name\s*=/.test(l)).length;
        expect(scales, `family ${m[1]} has no scale entries`).toBeGreaterThan(0);
        for (let i = 1; i <= scales; i++) out.push({ name: `${m[1]}_S${i}`, weaponType: type });
    }
    return out;
}

function weaponTypeOf(body: string): string {
    return /weapontype\s*=\s*'([A-Za-z]+)'/.exec(body)?.[1] ?? '';
}

const DEFS = weaponDefsFromLua(WEAPONS_LUA);

describe('weapons.lua × weapon-fx.json coverage', () => {
    it('parses every weapon def out of weapons.lua', () => {
        // 32 defs today; the bound guards against the parser silently
        // matching nothing after an authoring refactor.
        expect(DEFS.length).toBeGreaterThanOrEqual(30);
        expect(new Set(DEFS.map((d) => d.name)).size).toBe(DEFS.length);
    });

    it('every def resolves to slots', () => {
        for (const d of DEFS) {
            const slots = resolveWeaponFx(MAP, d.name, d.weaponType);
            expect(slots, `${d.name} resolved to nothing`).toBeTruthy();
        }
    });

    it('every def but NOWEAPON resolves to drawable FX', () => {
        const bare = DEFS
            .filter((d) => d.name !== 'NOWEAPON')
            .filter((d) => !slotsHaveEffects(resolveWeaponFx(MAP, d.name, d.weaponType)))
            .map((d) => d.name);
        expect(bare, 'weapon defs with no native FX').toEqual([]);
    });

    it('every effect any weapon names exists in library.json', () => {
        const entries = [...Object.values(MAP.weapons), MAP.__fallback,
            ...Object.values(MAP.defaults)];
        const missing: string[] = [];
        for (const slots of entries) {
            if (!slots || typeof slots !== 'object') continue;
            for (const key of ['muzzle', 'projectile', 'trail', 'impact'] as const) {
                const name = (slots as Record<string, unknown>)[key];
                if (typeof name !== 'string') continue;
                try {
                    resolveEffect(LIB, name);
                } catch {
                    missing.push(`${key}=${name}`);
                }
            }
        }
        expect(missing).toEqual([]);
    });

    it('resolves case-insensitively (the engine lowercases def names)', () => {
        const slots = resolveWeaponFx(MAP, 'ms_ac_s2');
        expect(slots.muzzle).toBe(MAP.weapons.MS_AC_S2.muzzle);
    });

    it('falls through exact → defaults → __fallback', () => {
        expect(resolveWeaponFx(MAP, 'no_such_weapon', 'MissileLauncher').impact)
            .toBe((MAP.defaults.MissileLauncher as { impact: string }).impact);
        expect(resolveWeaponFx(MAP, 'no_such_weapon', 'NoSuchType').impact)
            .toBe(MAP.__fallback.impact);
    });

    it('maps the streamed projectileType onto the authored weapontype', () => {
        expect(weaponTypeForProjectileType(ProjectileType.Missile)).toBe('MissileLauncher');
        expect(weaponTypeForProjectileType(ProjectileType.Torpedo)).toBe('TorpedoLauncher');
        expect(weaponTypeForProjectileType(ProjectileType.Explosive)).toBe('Cannon');
        expect(weaponTypeForProjectileType(ProjectileType.Laser)).toBeUndefined();
    });
});
