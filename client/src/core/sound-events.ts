/**
 * SoundEventPlayer — bridges server SoundEvents to AudioManager.
 *
 * The server emits one SoundEvent per fire / hit / death / build /
 * select. Each event carries (sourceKind, sourceDefId, soundId) which
 * indexes into the matching def's `sounds` SoundRef array. The
 * SoundRef supplies the asset path and per-asset gain/pitch defaults.
 *
 * This module:
 *   1. Resolves the SoundRef from DefCache (skips when the def isn't
 *      cached yet — rare; would only happen if the server bug-orders).
 *   2. Resolves the SoundRef's `path` to an HTTP URL under the
 *      lobby's `/api/games/data/<gameId>/` content root.
 *   3. Kicks off (or reuses) an async fetch+decode via AudioManager.
 *   4. Plays the decoded buffer through the 96-voice pool with HRTF
 *      panning at the event's position.
 */

import type { AudioManager } from './audio.js';
import type { DefCache } from './def-cache.js';
import type { SoundEventInfo, SoundRefInfo } from './connection.js';

type SourceKind = 0 /* Unit */ | 1 /* Weapon */ | 2 /* Feature */ | 3 /* Global */;

export class SoundEventPlayer {
    private audio: AudioManager;
    private defCache: DefCache;
    private gameContentBaseUrl: string;
    /// Tracks the in-flight `loadSound()` promises so the same buffer
    /// isn't fetched-and-decoded twice when many emissions arrive in a
    /// single tick before the decode resolves.
    private pending = new Map<string, Promise<AudioBuffer | null>>();

    constructor(audio: AudioManager, defCache: DefCache, gameContentBaseUrl: string) {
        this.audio = audio;
        this.defCache = defCache;
        // Ensure a single trailing slash for clean concatenation.
        this.gameContentBaseUrl = gameContentBaseUrl.replace(/\/+$/, '') + '/';
    }

    handleBatch(events: SoundEventInfo[]): void {
        for (const e of events) this.handleOne(e);
    }

    private handleOne(e: SoundEventInfo): void {
        const ref = this.lookupSoundRef(e.sourceKind as SourceKind, e.sourceDefId, e.soundId);
        if (!ref || !ref.path) return;

        const url = this.gameContentBaseUrl + ref.path;
        const volume = (ref.volume > 0 ? ref.volume : 1) * (e.volume > 0 ? e.volume : 1);
        const pitch  = (ref.pitch  > 0 ? ref.pitch  : 1) * (e.pitch  > 0 ? e.pitch  : 1);

        const cached = this.audio.getBuffer(url);
        if (cached) {
            this.audio.play({
                buffer: cached,
                x: e.x, y: e.y, z: e.z,
                volume, pitch,
                priority: e.priority,
            });
            return;
        }

        // Cache miss — fetch+decode, then play if still relevant. We do
        // NOT delay play() beyond the network round-trip the first time
        // a given sound is heard. Subsequent plays use the cached buffer.
        const promise = this.pending.get(url) ?? this.audio.loadSound(url, url);
        this.pending.set(url, promise);
        promise.then((buf) => {
            this.pending.delete(url);
            if (!buf) return;
            this.audio.play({
                buffer: buf,
                x: e.x, y: e.y, z: e.z,
                volume, pitch,
                priority: e.priority,
            });
        });
    }

    private lookupSoundRef(kind: SourceKind, defId: number, soundId: number): SoundRefInfo | undefined {
        let sounds: SoundRefInfo[] | undefined;
        if (kind === 1) {
            sounds = this.defCache.getWeaponDef(defId)?.sounds;
        } else if (kind === 0) {
            sounds = this.defCache.getUnitDef(defId)?.sounds;
        } else {
            // Feature / Global sound defs not yet supported.
            return undefined;
        }
        if (!sounds) return undefined;
        // SoundRef.id matches the runtime counter assigned server-side
        // so a direct lookup is fine, but fall back to scanning in case
        // the def was authored sparsely.
        if (soundId < sounds.length && sounds[soundId].id === soundId) {
            return sounds[soundId];
        }
        return sounds.find((s) => s.id === soundId);
    }
}
