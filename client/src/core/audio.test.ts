import { describe, it, expect } from 'vitest';
import { resolveReverbPreset } from './audio.js';

describe('resolveReverbPreset', () => {
    it('defaults to open when the map sets no preset', () => {
        expect(resolveReverbPreset('')).toBe('open');
    });

    it('passes an explicit preset through unchanged', () => {
        expect(resolveReverbPreset('valley')).toBe('valley');
        expect(resolveReverbPreset('urban')).toBe('urban');
        expect(resolveReverbPreset('open')).toBe('open');
    });

    it('passes `default` through unchanged — setReverbPreset treats that as dry passthrough itself', () => {
        expect(resolveReverbPreset('default')).toBe('default');
    });
});
