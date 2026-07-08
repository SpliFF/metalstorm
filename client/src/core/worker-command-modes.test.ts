import { describe, it, expect } from 'vitest';
import { cursorForCommand } from './worker-command-modes.js';
import { CMD } from './command-buffer.js';

/**
 * cursorForCommand (G3b) maps an armed modal command → the canonical Spring
 * cursor name (the same strings ZK/BAR widgets pass to AssignMouseCursor) plus a
 * CSS-cursor fallback. Mirrors input-manager.ts's updateCursorMode switch — the
 * cursor a player sees is how "cursor reflects pending mode" is proven.
 */
describe('cursorForCommand (armed-command → cursor)', () => {
    it('maps the offensive commands to a crosshair-family cursor', () => {
        expect(cursorForCommand(CMD.ATTACK)).toEqual({ name: 'Attack', css: 'crosshair' });
        expect(cursorForCommand(CMD.AREA_ATTACK)).toEqual({ name: 'Area attack', css: 'crosshair' });
        expect(cursorForCommand(CMD.FIGHT)).toEqual({ name: 'Fight', css: 'crosshair' });
        expect(cursorForCommand(CMD.MANUALFIRE)).toEqual({ name: 'ManualFire', css: 'crosshair' });
    });

    it('maps movement / patrol to their own cursors', () => {
        expect(cursorForCommand(CMD.MOVE)).toEqual({ name: 'Move', css: 'move' });
        expect(cursorForCommand(CMD.PATROL)).toEqual({ name: 'Patrol', css: 'cell' });
        expect(cursorForCommand(CMD.UNLOAD_UNITS)).toEqual({ name: 'Unload units', css: 'move' });
    });

    it('maps the unit-target commands to a pointer cursor', () => {
        for (const cmd of [CMD.GUARD, CMD.REPAIR, CMD.RECLAIM, CMD.CAPTURE, CMD.RESURRECT, CMD.LOAD_UNITS]) {
            expect(cursorForCommand(cmd).css).toBe('pointer');
            expect(cursorForCommand(cmd).name).not.toBeNull();
        }
    });

    it('resets to the native arrow when nothing is armed (null)', () => {
        expect(cursorForCommand(null)).toEqual({ name: null, css: '' });
    });

    it('resets for a command with no cursor mapping (e.g. STOP)', () => {
        expect(cursorForCommand(CMD.STOP)).toEqual({ name: null, css: '' });
    });
});
