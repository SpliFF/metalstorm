/**
 * SoundEventPlayer — bridges server SoundEvents to AudioManager.
 *
 * The server emits one SoundEvent per fire / hit / death / build /
 * select. Each event carries (sourceKind, sourceDefId, soundId,
 * channel) which indexes into the matching def's `sounds` SoundRef
 * array and tags the channel to mix into. The SoundRef supplies the
 * asset path, the raw logical name (for SoundItem lookup), and
 * per-asset gain/pitch defaults.
 *
 * Resolution order matches PLAN-audio.md:
 *   1. `SoundItems[name]` (lower-cased) — authoritative when present
 *   2. `SoundRef.path` (server's NormalizeSoundPath result) — file URL fallback
 *   3. `normalizeSoundPath(name)` heuristic — last resort
 *
 * When a SoundItem is found, its `gain` / `pitch` / `priority` /
 * `maxconcurrent` / `maxdist` / `rolloff` / `in3d` defaults feed
 * the SoundRequest; server-emitted SoundEvent.priority is overridden
 * by SoundItem.priority when set.
 */

import { AudioChannel, rewriteAudioExtensionToWebm,
    type AudioManager, type SoundItem } from './audio.js';
import type { DefCache } from './def-cache.js';
import type { SoundEventInfo, SoundRefInfo } from './connection.js';

type SourceKind = 0 /* Unit */ | 1 /* Weapon */ | 2 /* Feature */ | 3 /* Global */;

export class SoundEventPlayer {
    private audio: AudioManager;
    private defCache: DefCache;
    private gameContentBaseUrl: string;
    private pending = new Map<string, Promise<AudioBuffer | null>>();

    constructor(audio: AudioManager, defCache: DefCache, gameContentBaseUrl: string) {
        this.audio = audio;
        this.defCache = defCache;
        this.gameContentBaseUrl = gameContentBaseUrl.replace(/\/+$/, '') + '/';
    }

    handleBatch(events: SoundEventInfo[]): void {
        for (const e of events) this.handleOne(e);
    }

    private handleOne(e: SoundEventInfo): void {
        const ref = this.lookupSoundRef(e.sourceKind as SourceKind, e.sourceDefId, e.soundId);
        if (!ref) return;

        // Resolve SoundItem (per gamedata/sounds.lua) if a name is set.
        const item: SoundItem | undefined =
            ref.name ? this.audio.resolveSoundItem(ref.name) : undefined;

        // Pick a URL. SoundItem.file wins when present, otherwise the
        // server's already-`.webm` path on the SoundRef. Either way
        // the extension rewrite leaves it as `<stem>.webm`.
        let url: string;
        if (item && item.file) {
            const rel = rewriteAudioExtensionToWebm(
                item.file.startsWith('sounds/')
                    ? item.file
                    : 'sounds/' + item.file);
            url = this.gameContentBaseUrl + rel;
        } else if (ref.path) {
            url = this.gameContentBaseUrl + rewriteAudioExtensionToWebm(ref.path);
        } else {
            return;
        }

        // Combine SoundItem + SoundRef + SoundEvent layers per the
        // resolution order in PLAN-audio.md.
        const itemGain  = item?.gain  ?? 1;
        const itemPitch = item?.pitch ?? 1;
        const gainMod   = item?.gainmod  ?? 0;
        const pitchMod  = item?.pitchmod ?? 0;
        const r01 = (Math.random() * 2 - 1);
        const r02 = (Math.random() * 2 - 1);
        const itemGainRand  = itemGain  * (1 + r01 * gainMod);
        const itemPitchRand = itemPitch * (1 + r02 * pitchMod);

        const volume = itemGainRand
            * (ref.volume > 0 ? ref.volume : 1)
            * (e.volume   > 0 ? e.volume   : 1);
        const pitch  = itemPitchRand
            * (ref.pitch  > 0 ? ref.pitch  : 1)
            * (e.pitch    > 0 ? e.pitch    : 1);

        const priority = item?.priority ?? e.priority;
        const channel: AudioChannel = e.channel as AudioChannel;
        const spatial = item?.in3d !== false;
        const rolloff = item?.rolloff;
        const maxDist = item?.maxdist;

        const cached = this.audio.getBuffer(url);
        if (cached) {
            this.audio.play({
                buffer: cached,
                x: e.x, y: e.y, z: e.z,
                volume, pitch, priority,
                channel, spatial, rolloff, maxDist,
            });
            return;
        }

        const promise = this.pending.get(url) ?? this.audio.loadSound(url, url);
        this.pending.set(url, promise);
        promise.then((buf) => {
            this.pending.delete(url);
            if (!buf) return;
            this.audio.play({
                buffer: buf,
                x: e.x, y: e.y, z: e.z,
                volume, pitch, priority,
                channel, spatial, rolloff, maxDist,
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
            return undefined;
        }
        if (!sounds) return undefined;
        if (soundId < sounds.length && sounds[soundId].id === soundId) {
            return sounds[soundId];
        }
        return sounds.find((s) => s.id === soundId);
    }
}
