import { describe, it, expect, beforeEach } from 'vitest';
import {
    presentDirListEntries,
    vfsRegister, vfsRegisterPath, vfsExists, vfsLoadBinary,
    vfsCanonicalPath, setVfsBinaryFetcher, resetVfs,
} from './worker-vfs.js';

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

// VFS.LoadFile must stay consistent with VFS.FileExists for binary assets.
// Audio (and other binary) files are indexed path-only (vfsRegisterPath) so
// vfsLookup returns undefined and FileExists(true)/LoadFile(nil) disagreed —
// crashing widgets like BAR's common/wav.lua that read a .wav header. The
// on-demand binary loader closes that gap (Recoil's LoadFile returns bytes
// for any existing file). The sync transport is injected, so tests stub it.
describe('vfsLoadBinary (on-demand binary VFS.LoadFile)', () => {
    beforeEach(() => {
        resetVfs();
        setVfsBinaryFetcher(null as unknown as (p: string) => string | null);
    });

    it('loads bytes for a path-only (binary) file that FileExists reports present', () => {
        vfsRegisterPath('sounds/voice/en/alert.wav');
        expect(vfsExists('sounds/voice/en/alert.wav')).toBe(true);
        const calls: string[] = [];
        setVfsBinaryFetcher((disk) => { calls.push(disk); return 'RIFF\x00\xff'; });
        expect(vfsLoadBinary('sounds/voice/en/alert.wav')).toBe('RIFF\x00\xff');
        // fetched the canonical on-disk path
        expect(calls).toEqual(['sounds/voice/en/alert.wav']);
    });

    it('caches bytes — a second read does not re-invoke the fetcher', () => {
        vfsRegisterPath('sounds/x/beep.wav');
        let n = 0;
        setVfsBinaryFetcher(() => { n++; return 'DATA'; });
        expect(vfsLoadBinary('sounds/x/beep.wav')).toBe('DATA');
        expect(vfsLoadBinary('sounds/x/beep.wav')).toBe('DATA');
        expect(n).toBe(1);
    });

    it('returns null and does not fetch for a file that does not exist', () => {
        let fetched = false;
        setVfsBinaryFetcher(() => { fetched = true; return 'NOPE'; });
        expect(vfsLoadBinary('sounds/missing.wav')).toBeNull();
        expect(fetched).toBe(false);
    });

    it('resolves a case-folded request to the original-case on-disk path', () => {
        vfsRegisterPath('Sounds/Voice/EN/Foo.WAV');
        expect(vfsCanonicalPath('sounds/voice/en/foo.wav')).toBe('Sounds/Voice/EN/Foo.WAV');
        const calls: string[] = [];
        setVfsBinaryFetcher((disk) => { calls.push(disk); return 'X'; });
        expect(vfsLoadBinary('sounds/voice/en/foo.wav')).toBe('X');
        expect(calls).toEqual(['Sounds/Voice/EN/Foo.WAV']);
    });

    it('does not reach the binary path for a text file already held in the VFS', () => {
        vfsRegister('common/wav.lua', 'return 1');
        let fetched = false;
        setVfsBinaryFetcher(() => { fetched = true; return 'BIN'; });
        // vfsLoadBinary is the fallback; the file has content so the Lua
        // VFS.LoadFile resolves via vfsLookup first. Even if reached directly,
        // a content-bearing file should not be re-fetched as binary.
        expect(vfsLoadBinary('common/wav.lua')).toBe('return 1');
        expect(fetched).toBe(false);
    });
});
