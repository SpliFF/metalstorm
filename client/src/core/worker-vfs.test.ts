import { describe, it, expect } from 'vitest';
import { presentDirListEntries } from './worker-vfs.js';

// presentDirListEntries makes VFS.DirList faithful for `sounds/` listings:
// the game ships .wav/.ogg sources; our gameconverter ADDS a .webm playback
// artifact. Real Spring only ever lists the authored sources, so a game that
// parses the filename out of DirList (BAR's gamedata/sounds.lua does
// `string.find(name, ".wav") - 1` on every entry) must NOT see the .webm —
// it crashes on the non-.wav entry and aborts the whole SoundItems build.
describe('presentDirListEntries', () => {
    it('drops the .webm artifact when an authored .wav source sibling exists (un-pruned import — BAR/ZK)', () => {
        // BAR ships both side by side; returning both regressed sounds.lua.
        const entries = ['lasrfir1.wav', 'lasrfir1.webm', 'cannon1.wav', 'cannon1.webm'];
        expect(presentDirListEntries('sounds/weapons/', entries)).toEqual([
            'lasrfir1.wav', 'cannon1.wav',
        ]);
    });

    it('keeps an .ogg source and drops its .webm sibling', () => {
        const entries = ['music1.ogg', 'music1.webm'];
        expect(presentDirListEntries('sounds/music/', entries)).toEqual(['music1.ogg']);
    });

    it('presents an orphan .webm (pruned source) under the assumed .wav ext', () => {
        const entries = ['boom.webm', 'zap.webm'];
        expect(presentDirListEntries('sounds/', entries)).toEqual(['boom.wav', 'zap.wav']);
    });

    it('leaves a source-only listing untouched', () => {
        const entries = ['select.wav', 'ok.ogg'];
        expect(presentDirListEntries('sounds/ui/', entries)).toEqual(['select.wav', 'ok.ogg']);
    });

    it('handles a mix of sibling-paired and orphan .webm in the same dir', () => {
        // kept.wav has a source → drop kept.webm; orphan.webm has none → swap.
        const entries = ['kept.wav', 'kept.webm', 'orphan.webm'];
        expect(presentDirListEntries('sounds/atmos/', entries)).toEqual(['kept.wav', 'orphan.wav']);
    });

    it('is case-insensitive about the source sibling', () => {
        const entries = ['Foo.WAV', 'foo.webm'];
        expect(presentDirListEntries('sounds/x/', entries)).toEqual(['Foo.WAV']);
    });

    it('passes non-sounds directories straight through (no audio rewrite)', () => {
        const entries = ['model.webm', 'tex.webm'];
        expect(presentDirListEntries('unittextures/', entries)).toEqual(['model.webm', 'tex.webm']);
    });
});
