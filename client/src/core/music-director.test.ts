import { describe, it, expect, vi } from 'vitest';
import { MusicDirector, MusicState } from './music-director.js';
import type { AudioManager, SoundItem } from './audio.js';

function makeAudioStub() {
    return { playMusic: vi.fn(), stopMusic: vi.fn() } as unknown as AudioManager;
}

describe('MusicDirector — music_calm alias for MusicState.Peace', () => {
    it('ingests a music_calm SoundItem into the Peace playlist and plays it on a Peace event', () => {
        const audio = makeAudioStub();
        const dir = new MusicDirector(audio, 'http://content/');
        const items = new Map<string, SoundItem>();
        items.set('music_calm', { file: 'sounds/music/music_calm.webm' });
        dir.ingestPlaylistsFromSoundItems(items);
        dir.arm();
        dir.handleMusicEvent(MusicState.Peace, 1500);
        expect(audio.playMusic).toHaveBeenCalledWith(
            'http://content/sounds/music/music_calm.webm', 1.0, 1500);
    });

    it('still accepts the wire-protocol music_peace name (no regression)', () => {
        const audio = makeAudioStub();
        const dir = new MusicDirector(audio, 'http://content/');
        const items = new Map<string, SoundItem>();
        items.set('music_peace_1', { file: 'sounds/music/legacy_peace.webm' });
        dir.ingestPlaylistsFromSoundItems(items);
        dir.arm();
        dir.handleMusicEvent(MusicState.Peace, 800);
        expect(audio.playMusic).toHaveBeenCalledWith(
            'http://content/sounds/music/legacy_peace.webm', 1.0, 800);
    });

    it('music_tension and music_battle keys resolve to their own states', () => {
        const audio = makeAudioStub();
        const dir = new MusicDirector(audio, 'http://content/');
        const items = new Map<string, SoundItem>();
        items.set('music_tension', { file: 'sounds/music/music_tension.webm' });
        items.set('music_battle', { file: 'sounds/music/music_battle.webm' });
        dir.ingestPlaylistsFromSoundItems(items);
        dir.arm();
        dir.handleMusicEvent(MusicState.Battle, 500);
        expect(audio.playMusic).toHaveBeenCalledWith(
            'http://content/sounds/music/music_battle.webm', 1.0, 500);
    });
});
