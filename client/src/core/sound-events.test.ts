import { describe, it, expect } from 'vitest';
import { pickUnitDefSound, SoundCategory } from './sound-events.js';
import type { SoundRefInfo } from './connection.js';

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
