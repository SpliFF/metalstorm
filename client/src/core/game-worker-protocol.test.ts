import { describe, it, expect } from 'vitest';
import type { GpMessageToMain } from './game-worker-protocol.js';

// L-AUDIO wiring: mapinfo.lua's sound.preset travels worker(game-processor.ts)
// → main.ts as `gp:soundPreset`. Pins the wire shape both sides switch on —
// a typo in either the `type` literal or the `preset` field would silently
// desync the worker's postMessage from main's `case` without this.
describe('gp:soundPreset message shape', () => {
    it('carries just a type discriminant and the raw parsed preset string', () => {
        const msg: GpMessageToMain = { type: 'gp:soundPreset', preset: 'valley' };
        expect(msg).toEqual({ type: 'gp:soundPreset', preset: 'valley' });
    });

    it('allows the empty string — the worker posts ParsedMapData.soundPreset verbatim; defaulting is main\'s job', () => {
        const msg: GpMessageToMain = { type: 'gp:soundPreset', preset: '' };
        expect(msg.preset).toBe('');
    });
});
