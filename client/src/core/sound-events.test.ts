import { describe, it, expect } from 'vitest';
import { pickUnitDefSound, SoundCategory, chooseSoundKey } from './sound-events.js';
import type { SoundRefInfo } from './connection.js';
import type { SoundItem } from './audio.js';

const ref = (id: number, category: number, name: string): SoundRefInfo => ({
    id, category, name, path: `sounds/${name}`, volume: 1, pitch: 1,
});

describe('pickUnitDefSound', () => {
    // BAR armpw-style sounds array: several `select`/`cant`/`count` variants,
    // one `ok`. Categories: Select=0, OrderAck=1, Cancel=6.
    const sounds: SoundRefInfo[] = [
        ref(0, SoundCategory.Select, 'servtny1'),
        ref(1, SoundCategory.Select, 'servtny2'),
        ref(2, SoundCategory.OrderAck, 'servtny3'),
        ref(3, SoundCategory.Cancel, 'cantdo4'),
    ];

    it('returns the single variant of a category', () => {
        expect(pickUnitDefSound(sounds, SoundCategory.OrderAck)?.name).toBe('servtny3');
        expect(pickUnitDefSound(sounds, SoundCategory.Cancel)?.name).toBe('cantdo4');
    });

    it('picks a uniform-random variant when a category has several', () => {
        // rng → index 0 then index 1 (Math.floor(rng()*2)).
        expect(pickUnitDefSound(sounds, SoundCategory.Select, () => 0.1)?.id).toBe(0);
        expect(pickUnitDefSound(sounds, SoundCategory.Select, () => 0.9)?.id).toBe(1);
    });

    it('only ever returns refs of the requested category', () => {
        for (let i = 0; i < 20; i++) {
            const r = pickUnitDefSound(sounds, SoundCategory.Select, () => i / 20);
            expect(r?.category).toBe(SoundCategory.Select);
        }
    });

    it('returns null when the category is absent or sounds empty/undefined', () => {
        expect(pickUnitDefSound(sounds, SoundCategory.Activate)).toBeNull();
        expect(pickUnitDefSound([], SoundCategory.Select)).toBeNull();
        expect(pickUnitDefSound(undefined, SoundCategory.Select)).toBeNull();
    });
});

describe('chooseSoundKey', () => {
    // Mirrors gamedata/sounds.lua's ac_fire / ac_fire_far pair: close item
    // sets maxdist=900 (the switch point), far item has its own longer reach.
    const items = new Map<string, SoundItem>([
        ['ac_fire', { file: 'sounds/weapons/autocannon_fire.webm', maxdist: 900 }],
        ['ac_fire_far', { file: 'sounds/weapons/autocannon_fire_far.webm', maxdist: 3200 }],
        // A key with no `_far` sibling and no explicit maxdist at all.
        ['ui_click', { file: 'sounds/ui/ui_click.webm' }],
    ]);
    const resolve = (name: string): SoundItem | undefined => items.get(name);

    it('stays on the close key inside the switch distance', () => {
        expect(chooseSoundKey('ac_fire', 899, resolve)).toBe('ac_fire');
        expect(chooseSoundKey('ac_fire', 900, resolve)).toBe('ac_fire');
    });

    it('hands off to `_far` once past the close item\'s own maxdist', () => {
        expect(chooseSoundKey('ac_fire', 901, resolve)).toBe('ac_fire_far');
        expect(chooseSoundKey('ac_fire', 5000, resolve)).toBe('ac_fire_far');
    });

    it('falls back to the close key when no `_far` sibling is authored', () => {
        expect(chooseSoundKey('ui_click', 100, resolve)).toBe('ui_click');
        // No maxdist on the close item → default 900-elmo switch applies,
        // but there's still nothing to hand off to.
        expect(chooseSoundKey('ui_click', 5000, resolve)).toBe('ui_click');
    });

    it('falls back to the default 900-elmo switch when the close item is unresolved', () => {
        expect(chooseSoundKey('unknown_key', 899, resolve)).toBe('unknown_key');
        expect(chooseSoundKey('unknown_key', 901, resolve)).toBe('unknown_key');
    });
});
