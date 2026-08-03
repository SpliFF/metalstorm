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

/** SoundCategory codes — the `category` field the server stamps on each
 *  unit-def SoundRef (`LuaDefsSerializer.inl` / `schemas/protocol.fbs`
 *  `SoundCategory`). Used client-side to pick the right sound for a UI
 *  event (select / order-ack / cancel) since those are unsynced and the
 *  server never emits a SoundEvent for them. */
export const SoundCategory = {
    Select: 0,
    OrderAck: 1,   // "ok"
    Move: 2,       // "arrived"
    BuildStart: 3,
    Working: 4,
    UnderAttack: 5,
    Cancel: 6,     // "cant"
    Activate: 7,
    Deactivate: 8,
} as const;

/** Pick a SoundRef of `category` from a unit-def's `sounds` array, choosing a
 *  uniform-random variant when the category has several (faithful to Recoil
 *  `AudioChannel::PlayRandomSample` → `guRNG.NextInt(NumSounds())`). Returns
 *  null when the def authors no sound for that category. `rng` is injectable
 *  for deterministic tests. */
export function pickUnitDefSound(
    sounds: readonly SoundRefInfo[] | undefined,
    category: number,
    rng: () => number = Math.random,
): SoundRefInfo | null {
    if (!sounds || sounds.length === 0) return null;
    const variants = sounds.filter((s) => s.category === category);
    if (variants.length === 0) return null;
    if (variants.length === 1) return variants[0];
    return variants[Math.floor(rng() * variants.length)];
}

/** A SoundEvent with its SoundRef already resolved against the def cache. The
 *  ref lookup needs the unit/weapon defs; in the game-processor worker (GW4) the
 *  defs live next to the connection, so the worker resolves the ref there and
 *  posts these to main, where the AudioContext + AudioManager play them
 *  (`gp:audioSoundEvents`). Structured-cloneable (both members are plain). */
export interface ResolvedSoundEvent {
    e: SoundEventInfo;
    ref: SoundRefInfo;
}

/** Resolve the SoundRef for a SoundEvent from the def cache. Free function so
 *  the worker (which owns the def cache) can resolve before posting to main —
 *  the player itself no longer needs the def cache. */
export function resolveSoundRef(
    defCache: DefCache, kind: SourceKind, defId: number, soundId: number,
): SoundRefInfo | undefined {
    let sounds: SoundRefInfo[] | undefined;
    if (kind === 1) {
        sounds = defCache.getWeaponDef(defId)?.sounds;
    } else if (kind === 0) {
        sounds = defCache.getUnitDef(defId)?.sounds;
    } else {
        return undefined;
    }
    if (!sounds) return undefined;
    if (soundId < sounds.length && sounds[soundId].id === soundId) {
        return sounds[soundId];
    }
    return sounds.find((s) => s.id === soundId);
}

export class SoundEventPlayer {
    private audio: AudioManager;
    private gameContentBaseUrl: string;
    private pending = new Map<string, Promise<AudioBuffer | null>>();
    /// URLs that 404'd or failed to decode — never re-fetched (negative cache).
    private failedUrls = new Set<string>();

    constructor(audio: AudioManager, gameContentBaseUrl: string) {
        this.audio = audio;
        this.gameContentBaseUrl = gameContentBaseUrl.replace(/\/+$/, '') + '/';
    }

    /** Play a batch of pre-resolved sound events (refs resolved upstream — in
     *  the worker for GW4, since the def cache lives there). */
    handleResolvedBatch(items: ResolvedSoundEvent[]): void {
        for (const it of items) this.playResolved(it.e, it.ref);
    }

    private playResolved(e: SoundEventInfo, ref: SoundRefInfo): void {
        // A named sound that doesn't resolve yet might just be racing the
        // async gamedata/sounds.lua ingest (LuaUI boot posts SoundItems well
        // after combat can start) rather than genuinely missing. ref.path is
        // the server's flat `sounds/<name>.webm` guess — it doesn't know
        // about subdirectories or SoundItem key→filename remaps (e.g.
        // `ac_fire` → `sounds/weapons/autocannon_fire.webm`), so it 404s
        // reliably for anything not living directly under sounds/. Wait
        // (bounded) for the ingest instead of taking that fallback and
        // permanently negative-caching a URL that was never going to work.
        if (ref.name && !this.audio.resolveSoundItem(ref.name)) {
            void this.audio.whenSoundItemsReady(5000).then(() => this.playResolvedNow(e, ref));
            return;
        }
        this.playResolvedNow(e, ref);
    }

    private playResolvedNow(e: SoundEventInfo, ref: SoundRefInfo): void {
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
        // UI-channel sounds (select-all "MultiSelect", failed-command) are
        // always 2D in Recoil (`Channels::UserInterface->PlaySample` has no
        // position); never spatialise them regardless of the SoundItem in3d
        // flag. Other channels honour the SoundItem's in3d (default 3D).
        const spatial = channel === AudioChannel.UserInterface
            ? false
            : (item?.in3d !== false);
        const rolloff = item?.rolloff;
        const maxDist = item?.maxdist;

        // Negative cache: a sound whose .webm is missing (404) or fails to decode
        // resolves to null. Without remembering that, every repeat of the event
        // (e.g. a weapon firing each second) re-fetches the missing file —
        // flooding the network + log server. Skip URLs we've already seen fail.
        if (this.failedUrls.has(url)) return;

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
            if (!buf) { this.failedUrls.add(url); return; }
            this.audio.play({
                buffer: buf,
                x: e.x, y: e.y, z: e.z,
                volume, pitch, priority,
                channel, spatial, rolloff, maxDist,
            });
        });
    }

}
