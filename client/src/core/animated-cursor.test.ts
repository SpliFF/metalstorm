import { describe, it, expect } from 'vitest';
import { stripAnimsManifestSuffix } from './animated-cursor.js';

describe('stripAnimsManifestSuffix (AnimatedCursor game-root recovery)', () => {
    it('strips a manifest directly under Anims/', () => {
        expect(stripAnimsManifestSuffix('https://host/api/games/data/bar/Anims/cursormove.txt'))
            .toBe('https://host/api/games/data/bar');
    });
    it('strips a manifest nested under a cursor-pack subdirectory (U9)', () => {
        // Previously the `[^/]+` segment couldn't match across the extra
        // slash, so the regex failed to match at all and gameRoot stayed
        // equal to the full manifest URL — frame paths then got appended
        // onto the .txt path itself, 404ing every frame.
        expect(stripAnimsManifestSuffix(
            'https://host/api/games/data/bar/Anims/icexuick_75/cursornormal.txt',
        )).toBe('https://host/api/games/data/bar');
    });
    it('is case-insensitive on the Anims directory name', () => {
        expect(stripAnimsManifestSuffix('https://host/data/bar/anims/pack/cursorfight.txt'))
            .toBe('https://host/data/bar');
    });
    it('leaves a URL with no Anims/ segment unchanged', () => {
        expect(stripAnimsManifestSuffix('https://host/data/bar/cursormove.txt'))
            .toBe('https://host/data/bar/cursormove.txt');
    });
});
