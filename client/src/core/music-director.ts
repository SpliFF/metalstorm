/**
 * MusicDirector — picks a track from the per-state playlist on each
 * MusicEvent and hands it to AudioManager.playMusic.
 *
 * Per PLAN-audio.md §"Client-side track selection":
 *
 *   1. Playlists are sourced from `gamedata/sounds.lua` SoundItems
 *      whose names match `music_<state>_<n>` (e.g. `music_peace_1`)
 *      OR a parallel `gamedata/music.lua` table — at the time of
 *      writing, only the SoundItem convention is loaded.
 *   2. On MusicEvent: pick a random track from the new state's
 *      playlist, crossfade in over `fade_ms` against whatever
 *      track is currently playing. Track choice persists for the
 *      duration of the state.
 *   3. Music is gated on critical-asset readiness — events that fire
 *      before `arm()` is called are stashed and the latest is
 *      applied (without replay of intermediate transitions) once
 *      the gate opens.
 */

import type { AudioManager, SoundItem } from './audio.js';
import { rewriteAudioExtensionToWebm } from './audio.js';

/// MusicState wire values match SoundChannel / protocol.fbs.
export enum MusicState {
    Peace = 0,
    Tension = 1,
    Battle = 2,
    Victory = 3,
    Defeat = 4,
}

const STATE_NAMES: Record<MusicState, string> = {
    [MusicState.Peace]:   'peace',
    [MusicState.Tension]: 'tension',
    [MusicState.Battle]:  'battle',
    [MusicState.Victory]: 'victory',
    [MusicState.Defeat]:  'defeat',
};

export class MusicDirector {
    private audio: AudioManager;
    private contentBaseUrl: string;

    /// Per-state playlist of resolved `.webm` URLs. Built from the
    /// SoundItem map when ingestPlaylistsFromSoundItems is called.
    private playlists: Map<MusicState, string[]> = new Map();

    /// Whether the music gate has been opened. MusicEvents that fire
    /// before this stash their target state; on arm() the latest
    /// stashed state is applied (no replay of intermediate fades).
    private armed = false;
    private pendingState: MusicState | null = null;
    private pendingFadeMs = 2000;

    /// Current state — we only restart a track when the state
    /// changes, not on every batch (the server only sends a
    /// transition when state changes, but a defensive guard cheap).
    private currentState: MusicState | null = null;

    constructor(audio: AudioManager, contentBaseUrl: string) {
        this.audio = audio;
        this.contentBaseUrl = contentBaseUrl.replace(/\/+$/, '') + '/';
    }

    /// Extract `music_<state>_<n>` SoundItems and build per-state
    /// playlists. Called by lua-widget-manager after it receives the
    /// `soundItems` worker message and hands the map to
    /// AudioManager.ingestSoundItems. Items are looked up by name
    /// against the same map AudioManager already holds.
    ingestPlaylistsFromSoundItems(items: Map<string, SoundItem>): void {
        this.playlists.clear();
        // Pattern: name lowercases to `music_<state>_<n>` where
        // <state> is one of the STATE_NAMES values. Some games
        // author single-track playlists as `music_<state>` (no
        // trailing index); we accept both.
        const re = /^music_(peace|tension|battle|victory|defeat)(?:_\d+)?$/i;
        for (const [rawKey, item] of items) {
            const m = re.exec(rawKey);
            if (!m) continue;
            const stateName = m[1].toLowerCase();
            const state = this.stateByName(stateName);
            if (state == null || !item.file) continue;
            const url = this.resolveTrackUrl(item.file);
            const arr = this.playlists.get(state) ?? [];
            arr.push(url);
            this.playlists.set(state, arr);
        }

        const counts: string[] = [];
        for (const [st, arr] of this.playlists) {
            counts.push(`${STATE_NAMES[st]}=${arr.length}`);
        }
        console.log(`[music] playlists: ${counts.join(' ') || 'none'}`);
    }

    /// Open the music gate. Called by main.ts once critical assets
    /// (terrain mesh + first entity batch + preload SoundItems) are
    /// ready. If a MusicEvent fired before this, applies the latest
    /// stashed state immediately.
    arm(): void {
        if (this.armed) return;
        this.armed = true;
        if (this.pendingState !== null) {
            this.applyState(this.pendingState, this.pendingFadeMs);
            this.pendingState = null;
        }
    }

    /// Handle a server MusicEvent. Before arm() this just stashes
    /// the latest state; after arm() it picks a track and crossfades.
    handleMusicEvent(stateRaw: number, fadeMs: number): void {
        const state = stateRaw as MusicState;
        if (!STATE_NAMES[state]) {
            console.warn(`[music] unknown state ${stateRaw}`);
            return;
        }
        if (!this.armed) {
            this.pendingState = state;
            this.pendingFadeMs = fadeMs;
            return;
        }
        this.applyState(state, fadeMs);
    }

    private applyState(state: MusicState, fadeMs: number): void {
        if (state === this.currentState) return;
        this.currentState = state;
        const tracks = this.playlists.get(state);
        if (!tracks || tracks.length === 0) {
            // No track for this state — stop whatever's playing.
            // Defeat / victory without a sting falls into this path;
            // we still want the prior battle music to fade out.
            this.audio.stopMusic(fadeMs);
            return;
        }
        const url = tracks[Math.floor(Math.random() * tracks.length)];
        this.audio.playMusic(url, 1.0, fadeMs);
    }

    private stateByName(name: string): MusicState | null {
        switch (name.toLowerCase()) {
            case 'peace':   return MusicState.Peace;
            case 'tension': return MusicState.Tension;
            case 'battle':  return MusicState.Battle;
            case 'victory': return MusicState.Victory;
            case 'defeat':  return MusicState.Defeat;
            default:        return null;
        }
    }

    private resolveTrackUrl(file: string): string {
        const rel = rewriteAudioExtensionToWebm(
            file.startsWith('sounds/') ? file : 'sounds/' + file);
        return this.contentBaseUrl + rel;
    }
}
