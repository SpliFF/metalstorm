/**
 * AudioManager — Web Audio voice pool with Recoil-parity channel mixing.
 *
 * Per PLAN-audio.md:
 *   - 96-voice pool with distance-based priority culling
 *   - PannerNode for 3D positional audio tied to camera
 *   - Pre-decoded AudioBuffer cache for SFX
 *   - Streamed MediaElementAudioSourceNode for music (BGMusic channel)
 *   - Five named channels matching Recoil's ISoundChannels.h
 *     (General / Battle / UnitReply / UserInterface / BGMusic), each
 *     with independent volume + enable state
 *   - Master ConvolverNode for map reverb (passthrough by default)
 *   - SoundItem resolution from gamedata/sounds.lua, contributing
 *     per-item gain / pitch / priority / maxconcurrent / maxdist /
 *     rolloff / in3d defaults
 *   - Must resume AudioContext on first user interaction
 *
 * Volume persistence lives in ClientSettings (`snd_vol*`, 0..100 — see
 * PLAN-settings.md §7), the single source of truth shared with the
 * in-game options menu. The old `audio.master` / `audio.channel.*`
 * localStorage keys migrate into it once on first run.
 */
import { clientSettings } from './client-settings.js';

/// Mix channels. Indices match the SoundChannel enum in protocol.fbs
/// so wire values cast straight through.
export enum AudioChannel {
    General = 0,
    Battle = 1,
    UnitReply = 2,
    UserInterface = 3,
    BGMusic = 4,
}

/// Subset of `gamedata/sounds.lua` SoundItem fields the runtime
/// honours. `dopplerscale` is intentionally absent — Web Audio has no
/// Doppler implementation. Anything else absent from the source file
/// stays `undefined` and the AudioManager falls back to its own
/// defaults.
export interface SoundItem {
    /// Path under the game content root. Will be extension-rewritten
    /// to `.webm` at lookup time regardless of what the source file
    /// stored, so hand-authored `.wav` strings work transparently.
    file?: string;
    /// Base gain (0..1+). Multiplied into the request's volume.
    gain?: number;
    /// Base playback rate. Multiplied into the request's pitch.
    pitch?: number;
    /// Per-play random gain offset: volume *= 1 + (random()*2 - 1) * gainmod.
    gainmod?: number;
    /// Per-play random pitch offset: pitch *= 1 + (random()*2 - 1) * pitchmod.
    pitchmod?: number;
    /// Eviction priority; overrides the SoundEvent's priority when set.
    priority?: number;
    /// Stored but not enforced per-name — per-channel cap is the
    /// actual throttle. Kept on the SoundItem for future per-item logic.
    maxconcurrent?: number;
    /// Squared-distance gate at play() time; reject if listener
    /// farther than maxdist.
    maxdist?: number;
    /// Per-voice PannerNode.rolloffFactor override.
    rolloff?: number;
    /// When false, the voice bypasses the PannerNode (non-spatial mix).
    in3d?: boolean;
    /// Async pre-decode hint at SoundItem-ingest time.
    preload?: boolean;
    /// When > 0, the SoundItem is a looped ambient bed — routed
    /// through the Web Audio path (AudioBufferSource + loop=true)
    /// rather than the streamed-music path.
    looptime?: number;
}

/** A single voice in the pool. */
interface Voice {
    source: AudioBufferSourceNode | null;
    panner: PannerNode;
    gain: GainNode;
    priority: number;
    startTime: number;
    active: boolean;
    /// Mix channel this voice is currently routed to. The voice's
    /// tail (gain.disconnect / gain.connect) is re-wired per play()
    /// so we only need 96 voice slots, not 96 × 5.
    channel: AudioChannel;
    /// Last position the voice was played at. Used for distance-tie
    /// breaking in eviction.
    posX: number;
    posY: number;
    posZ: number;
}

/** Sound request with spatial info and priority. */
export interface SoundRequest {
    buffer: AudioBuffer;
    x: number;
    y: number;
    z: number;
    volume?: number;      // 0-1, default 1
    priority?: number;    // higher = more important, default 0
    pitch?: number;       // playback rate, default 1
    /// Mix channel; defaults to General.
    channel?: AudioChannel;
    /// When false, the voice bypasses the PannerNode entirely.
    /// Defaults true (3D spatial play). Matches SoundItem.in3d.
    spatial?: boolean;
    /// Per-voice rolloff override (matches SoundItem.rolloff). When
    /// undefined the channel's default panner rolloff is used.
    rolloff?: number;
    /// Squared-distance cutoff. If the listener is farther than this,
    /// the request is dropped at play() time.
    maxDist?: number;
    /// Optional emitter velocity in world units per second. When
    /// any component is non-zero, AudioManager schedules a linear
    /// position ramp on the PannerNode for the duration of the
    /// buffer so the source slides past the listener naturally
    /// (PLAN-audio.md — moving-emitter ramps).
    vx?: number;
    vy?: number;
    vz?: number;
}

const POOL_SIZE = 96;
const HRTF_HOT_THRESHOLD = 50;
const HRTF_FALLBACK_PRIORITY = 100;

/// Per-channel concurrent-source caps. Recoil enforces these at the
/// channel level (AudioChannel.cpp:100-126); the values below are a
/// reasonable starting point that gives Battle / General the lion's
/// share of the 96-voice pool with UnitReply / UI staying responsive
/// at low volumes.
const CHANNEL_MAX_CONCURRENT: Record<AudioChannel, number> = {
    [AudioChannel.General]:       32,
    [AudioChannel.Battle]:        40,
    [AudioChannel.UnitReply]:     12,
    [AudioChannel.UserInterface]: 8,
    [AudioChannel.BGMusic]:       1,
};

const CHANNEL_NAMES: Record<AudioChannel, string> = {
    [AudioChannel.General]:       'General',
    [AudioChannel.Battle]:        'Battle',
    [AudioChannel.UnitReply]:     'UnitReply',
    [AudioChannel.UserInterface]: 'UserInterface',
    [AudioChannel.BGMusic]:       'BGMusic',
};

const ALL_CHANNELS: AudioChannel[] = [
    AudioChannel.General,
    AudioChannel.Battle,
    AudioChannel.UnitReply,
    AudioChannel.UserInterface,
    AudioChannel.BGMusic,
];

/// Legacy localStorage keys (pre-ClientSettings). Read once at startup to
/// migrate, then no longer written. See PLAN-settings.md §7.
const CHANNEL_VOL_STORAGE_PREFIX = 'audio.channel.';
const MASTER_VOL_STORAGE_KEY = 'audio.master';

/// ClientSettings volume keys (0..100). `snd_volmaster` is the master;
/// the rest map per-channel. Mirrors VOLUME_CONFIG_KEYS in lua-spring-api.
const MASTER_VOL_SETTING = 'snd_volmaster';
const CHANNEL_VOL_SETTING: Record<AudioChannel, string> = {
    [AudioChannel.General]:       'snd_volgeneral',
    [AudioChannel.Battle]:        'snd_volbattle',
    [AudioChannel.UnitReply]:     'snd_volunitreply',
    [AudioChannel.UserInterface]: 'snd_volui',
    [AudioChannel.BGMusic]:       'snd_volmusic',
};

const ZOOM_CLOSE_HEIGHT = 400;
const ZOOM_FAR_HEIGHT = 3500;

function zoomAttenuation(factor: number): number {
    if (factor <= 0.15) return 1.0;
    if (factor >= 0.85) return 0.2;
    return 1.0 - (factor - 0.15) * (0.8 / 0.7);
}

function zoomPriorityFloor(factor: number): number {
    if (factor <= 0.2) return 0;
    if (factor >= 0.9) return 100;
    return Math.floor((factor - 0.2) * (100 / 0.7));
}

/// Rewrite any audio file extension to `.webm`. Used as a final
/// safety net for hand-authored SoundItem entries that still spell
/// out `.wav` / `.ogg` / `.mp3`; the server's NormalizeSoundPath
/// already does the same on the wire-format `path` field, so this is
/// only consulted on widget-initiated `Spring.PlaySoundFile` paths
/// and on the SoundItem.file lookup.
export function rewriteAudioExtensionToWebm(p: string): string {
    if (!p) return p;
    const lower = p.toLowerCase();
    const audioExts = ['.wav', '.ogg', '.mp3', '.flac', '.m4a', '.aac'];
    for (const ext of audioExts) {
        if (lower.endsWith(ext)) {
            return p.slice(0, p.length - ext.length) + '.webm';
        }
    }
    if (lower.endsWith('.webm')) return p;
    // No recognised extension — append `.webm`.
    return p + '.webm';
}

export class AudioManager {
    private ctx: AudioContext;
    get context(): AudioContext { return this.ctx; }

    /// Master gain — sits between the channel buses and the
    /// convolver/limiter chain. Driven by `setMasterVolume` /
    /// `setVolume` and the persisted `audio.master` localStorage key.
    private masterGain: GainNode;

    /// Convolver for map reverb. `buffer` is null by default →
    /// passthrough, no audible effect. Map-load wiring calls
    /// `setReverbPreset(name)` with the mapinfo.lua → sound.preset
    /// value when one is set.
    private convolver: ConvolverNode;
    /// Wet/dry mix gains around the convolver. Default 50/50 when an
    /// IR is loaded, 100% dry when buffer is null.
    private reverbWetGain: GainNode;
    private reverbDryGain: GainNode;

    /// Per-channel gain buses. Each voice's tail connects into one
    /// of these (re-routable per play() call so the 96-voice pool
    /// stays a flat pool rather than splitting per channel).
    private channelBuses: Record<AudioChannel, GainNode>;
    /// Persisted per-channel volume (0..1). Saved across sessions.
    private channelVolumes: Record<AudioChannel, number>;
    /// Per-channel enable state. Disabled channels mute everything
    /// routed through them by zeroing the bus gain.
    private channelEnabled: Record<AudioChannel, boolean>;
    /// Live active-voice count per channel — used for Recoil's
    /// per-channel maxConcurrent eviction.
    private channelActiveCount: Record<AudioChannel, number>;

    private voices: Voice[] = [];
    /// Voices currently pinned to a caller-chosen key by playLoop() — a
    /// piece-attached loop (engine idle, turret servo) that fx-bindings.ts
    /// starts/stops/repositions by name instead of fire-and-forget play().
    private activeLoops = new Map<string, Voice>();
    private bufferCache = new Map<string, AudioBuffer>();
    private resumed = false;
    private priorityFloor = 0;
    private listenerX = 0;
    private listenerY = 0;
    private listenerZ = 0;

    /// SoundItems loaded from `gamedata/sounds.lua` (post-VFS-prefetch).
    /// Keyed by lower-cased logical name (e.g. `"weapon/laser1"`,
    /// `"bot_select"`).
    private soundItems = new Map<string, SoundItem>();
    /// Set true by the first ingestSoundItems() call. Lets callers that
    /// depend on named-lookup resolution (SoundEventPlayer) tell "not found
    /// because sounds.lua hasn't loaded yet" apart from "not found, never
    /// will be" — see whenSoundItemsReady().
    private soundItemsIngested = false;
    private soundItemsReadyResolve: (() => void) | null = null;
    private soundItemsReadyPromise: Promise<void> = new Promise((resolve) => {
        this.soundItemsReadyResolve = resolve;
    });

    /// Active music streaming elements — A/B pair for crossfading.
    /// `playMusic()` always targets the inactive slot and ramps both
    /// gains; once the fade completes, the previous slot is cleared.
    private musicSlots: Array<{
        element: HTMLAudioElement;
        source: MediaElementAudioSourceNode;
        gain: GainNode;
    } | null> = [null, null];
    private activeMusicSlot = 0;

    constructor() {
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();

        // One-time migration of legacy audio.* volume keys into
        // ClientSettings (PLAN-settings.md §7). Done before the first read
        // so migrated values win; idempotent (only fills unset keys).
        this.migrateLegacyVolumes();

        // Master volume from ClientSettings (0..100 → 0..1).
        this.masterGain.gain.value = clientSettings.getInt(MASTER_VOL_SETTING, 100) / 100;

        // Master chain: master gain -> (wet/dry split through convolver)
        //               -> limiter -> destination.
        this.convolver = this.ctx.createConvolver();
        this.reverbWetGain = this.ctx.createGain();
        this.reverbDryGain = this.ctx.createGain();
        // No IR loaded yet → 100% dry. setReverbPreset bumps wet up
        // to 0.5 when a preset successfully decodes.
        this.reverbWetGain.gain.value = 0.0;
        this.reverbDryGain.gain.value = 1.0;

        this.masterGain.connect(this.reverbDryGain);
        this.masterGain.connect(this.convolver);
        this.convolver.connect(this.reverbWetGain);

        // Master limiter — dozens of overlapping voices in a heavy
        // combat tick sum well past 1.0 and clip hard at `destination`.
        const limiter = this.ctx.createDynamicsCompressor();
        limiter.threshold.value = -6;
        limiter.knee.value = 0;
        limiter.ratio.value = 12;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.25;

        this.reverbDryGain.connect(limiter);
        this.reverbWetGain.connect(limiter);
        limiter.connect(this.ctx.destination);

        // Per-channel gain buses with persisted volumes.
        this.channelBuses        = {} as Record<AudioChannel, GainNode>;
        this.channelVolumes      = {} as Record<AudioChannel, number>;
        this.channelEnabled      = {} as Record<AudioChannel, boolean>;
        this.channelActiveCount  = {} as Record<AudioChannel, number>;
        for (const ch of ALL_CHANNELS) {
            const bus = this.ctx.createGain();
            // Channel volume from ClientSettings (0..100 → 0..1).
            const vol = clientSettings.getInt(CHANNEL_VOL_SETTING[ch], 100) / 100;
            bus.gain.value = vol;
            bus.connect(this.masterGain);
            this.channelBuses[ch] = bus;
            this.channelVolumes[ch] = vol;
            this.channelEnabled[ch] = true;
            this.channelActiveCount[ch] = 0;
        }

        // Subscribe so any writer (in-game menu, our graphics/audio panel,
        // a direct Spring.SetConfigInt) applies live through one path.
        // The setters below persist by writing these same keys, so the
        // subscriber is also their apply step — no separate apply call.
        clientSettings.subscribe(MASTER_VOL_SETTING, v => {
            this.masterGain.gain.value = Math.max(0, Math.min(1, Number(v) / 100));
        });
        for (const ch of ALL_CHANNELS) {
            clientSettings.subscribe(CHANNEL_VOL_SETTING[ch], v => {
                this.applyChannelVolume(ch, Math.max(0, Math.min(1, Number(v) / 100)));
            });
        }

        // Pre-create voice pool. Each voice connects to a panner
        // and a per-voice gain; the gain's downstream is re-wired
        // to whichever channel bus the play() call names.
        for (let i = 0; i < POOL_SIZE; i++) {
            const panner = this.ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 50;
            panner.maxDistance = 5000;
            panner.rolloffFactor = 1;

            const gain = this.ctx.createGain();
            panner.connect(gain);
            // Default-route to General; play() may rewire to a
            // different channel before starting the source.
            gain.connect(this.channelBuses[AudioChannel.General]);

            this.voices.push({
                source: null,
                panner,
                gain,
                priority: 0,
                startTime: 0,
                active: false,
                channel: AudioChannel.General,
                posX: 0,
                posY: 0,
                posZ: 0,
            });
        }
    }

    // ============================================================
    // Lifecycle
    // ============================================================

    async resume(): Promise<void> {
        if (this.resumed) return;
        await this.ctx.resume();
        this.resumed = true;
    }

    /// PLAN-quickstart.md §3.4 (Part B — detach): suspend the AudioContext
    /// without tearing it down, so a parked session stops emitting sound while
    /// the worker + decoded-buffer cache stay alive. Clears `resumed` so the
    /// re-entry click's `resume()` re-arms the context (the autoplay-policy
    /// gesture is satisfied by that click). Distinct from `dispose()`, which
    /// closes the context permanently. Best-effort: a context already closed or
    /// interrupted throws, which we swallow.
    async suspend(): Promise<void> {
        this.resumed = false;
        try { await this.ctx.suspend(); } catch { /* already closed/interrupted */ }
    }

    dispose(): void {
        this.stopMusic();
        for (const voice of this.voices) {
            if (voice.source) {
                try { voice.source.stop(); } catch { /* ok */ }
            }
        }
        this.ctx.close();
    }

    // ============================================================
    // Listener / zoom
    // ============================================================

    setZoomFactor(cameraHeight: number): void {
        const span = ZOOM_FAR_HEIGHT - ZOOM_CLOSE_HEIGHT;
        const raw = (cameraHeight - ZOOM_CLOSE_HEIGHT) / span;
        const factor = Math.max(0, Math.min(1, raw));
        const gain = zoomAttenuation(factor);
        // Zoom-attenuation rides the Battle + General buses (the two
        // channels carrying spatial-mix SFX) without dragging music
        // / UI down. Apply to both at once via setTargetAtTime so
        // wheel-zoom motion doesn't audibly pump.
        const now = this.ctx.currentTime;
        const battleBase = this.channelEnabled[AudioChannel.Battle]
            ? this.channelVolumes[AudioChannel.Battle] : 0;
        const generalBase = this.channelEnabled[AudioChannel.General]
            ? this.channelVolumes[AudioChannel.General] : 0;
        this.channelBuses[AudioChannel.Battle].gain
            .setTargetAtTime(gain * battleBase, now, 0.2);
        this.channelBuses[AudioChannel.General].gain
            .setTargetAtTime(gain * generalBase, now, 0.2);
        this.priorityFloor = zoomPriorityFloor(factor);
    }

    setListenerPosition(x: number, y: number, z: number,
                        forwardX: number, forwardY: number, forwardZ: number): void {
        this.listenerX = x;
        this.listenerY = y;
        this.listenerZ = z;
        const listener = this.ctx.listener;
        if (listener.positionX) {
            listener.positionX.value = x;
            listener.positionY.value = y;
            listener.positionZ.value = z;
            listener.forwardX.value = forwardX;
            listener.forwardY.value = forwardY;
            listener.forwardZ.value = forwardZ;
            listener.upX.value = 0;
            listener.upY.value = 1;
            listener.upZ.value = 0;
        }
    }

    // ============================================================
    // Buffer cache
    // ============================================================

    /// Load and cache an audio buffer from a URL. Re-fetch of an
    /// already-cached URL is a no-op that returns the cached buffer.
    /// Errors are logged at warn and resolve to null.
    async loadSound(name: string, url: string): Promise<AudioBuffer | null> {
        const cached = this.bufferCache.get(name);
        if (cached) return cached;

        try {
            const resp = await fetch(url);
            const arrayBuf = await resp.arrayBuffer();
            const audioBuf = await this.ctx.decodeAudioData(arrayBuf);
            this.bufferCache.set(name, audioBuf);
            return audioBuf;
        } catch {
            console.warn(`[audio] failed to load sound: ${name}`);
            return null;
        }
    }

    getBuffer(name: string): AudioBuffer | undefined {
        return this.bufferCache.get(name);
    }

    // ============================================================
    // SoundItem ingest + resolution
    // ============================================================

    /// Replace the SoundItem map. Called once by the widget worker
    /// after it has executed `gamedata/sounds.lua` post-VFS-prefetch.
    /// Keys are lower-cased to match the way callers look them up.
    /// Preload-flagged items kick off an async fetch+decode here.
    ingestSoundItems(items: Map<string, SoundItem>,
                     contentBaseUrl: string): void {
        this.soundItems.clear();
        const base = contentBaseUrl.replace(/\/+$/, '') + '/';
        for (const [rawKey, item] of items) {
            const key = rawKey.toLowerCase();
            this.soundItems.set(key, item);
            if (item.preload && item.file) {
                const url = base + rewriteAudioExtensionToWebm(
                    this.stripSoundsPrefix(item.file));
                void this.loadSound(url, url);
            }
        }
        console.log(`[audio] ingested ${this.soundItems.size} SoundItem(s)`);
        this.soundItemsIngested = true;
        this.soundItemsReadyResolve?.();
        this.soundItemsReadyResolve = null;
    }

    /// Look up a SoundItem by logical name (case-insensitive).
    /// Returns undefined if no entry matches.
    resolveSoundItem(name: string): SoundItem | undefined {
        if (!name) return undefined;
        return this.soundItems.get(name.toLowerCase());
    }

    /// Resolves once ingestSoundItems() has run at least once, or after
    /// `timeoutMs` — whichever comes first. Lets a caller defer a
    /// name-based lookup that raced the async sounds.lua load instead of
    /// falling back to a less reliable path immediately (see
    /// SoundEventPlayer.playResolved). Bounded so a game that never posts
    /// SoundItems doesn't stall callers forever.
    whenSoundItemsReady(timeoutMs: number): Promise<void> {
        if (this.soundItemsIngested) return Promise.resolve();
        return Promise.race([
            this.soundItemsReadyPromise,
            new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
    }

    private stripSoundsPrefix(p: string): string {
        if (p.startsWith('sounds/')) return p.slice(7);
        return p;
    }

    // ============================================================
    // Channel volume + enable
    // ============================================================

    /// Master volume (0..1). Persists to ClientSettings (snd_volmaster,
    /// 0..100); the subscriber installed in the constructor applies it to
    /// the gain node, so persistence and apply share one path.
    setMasterVolume(v: number): void {
        const vol = Math.max(0, Math.min(1, v));
        clientSettings.set(MASTER_VOL_SETTING, Math.round(vol * 100));
    }

    /// Backwards-compatible alias for setMasterVolume.
    setVolume(volume: number): void {
        this.setMasterVolume(volume);
    }

    getMasterVolume(): number {
        return this.masterGain.gain.value;
    }

    /// Per-channel volume (0..1). Persists to ClientSettings
    /// (snd_vol<channel>, 0..100); the subscriber applies it.
    setChannelVolume(channel: AudioChannel, v: number): void {
        const vol = Math.max(0, Math.min(1, v));
        clientSettings.set(CHANNEL_VOL_SETTING[channel], Math.round(vol * 100));
    }

    /// Apply a channel volume to the audio graph (0..1) without
    /// persisting. Called by the ClientSettings subscriber.
    private applyChannelVolume(channel: AudioChannel, vol: number): void {
        this.channelVolumes[channel] = vol;
        if (this.channelEnabled[channel]) {
            this.channelBuses[channel].gain.value = vol;
        }
    }

    /// Migrate legacy audio.master / audio.channel.* localStorage keys
    /// into ClientSettings (PLAN-settings.md §7). Only fills keys that
    /// have no ClientSettings value yet, so it's a one-time, idempotent
    /// move; the legacy keys are left in place but no longer read/written.
    private migrateLegacyVolumes(): void {
        const legacyMaster = this.readNumberOrNull(MASTER_VOL_STORAGE_KEY);
        if (legacyMaster != null && !clientSettings.has(MASTER_VOL_SETTING)) {
            clientSettings.set(MASTER_VOL_SETTING, Math.round(legacyMaster * 100));
        }
        for (const ch of ALL_CHANNELS) {
            const legacy = this.readNumberOrNull(
                CHANNEL_VOL_STORAGE_PREFIX + CHANNEL_NAMES[ch]);
            if (legacy != null && !clientSettings.has(CHANNEL_VOL_SETTING[ch])) {
                clientSettings.set(CHANNEL_VOL_SETTING[ch], Math.round(legacy * 100));
            }
        }
    }

    getChannelVolume(channel: AudioChannel): number {
        return this.channelVolumes[channel];
    }

    /// Toggle a channel on/off. Disabled channels mute everything on
    /// them but voices stay in the pool — re-enable resumes mid-clip.
    setChannelEnabled(channel: AudioChannel, on: boolean): void {
        this.channelEnabled[channel] = on;
        this.channelBuses[channel].gain.value =
            on ? this.channelVolumes[channel] : 0;
    }

    isChannelEnabled(channel: AudioChannel): boolean {
        return this.channelEnabled[channel];
    }

    // ============================================================
    // Reverb plumbing
    // ============================================================

    /// Switch the master-chain convolver's IR to the named preset.
    /// Fetches `<contentRoot>/sounds/efx/<preset>.webm`; on success,
    /// fades wet/dry up to 50/50. `"default"` or unknown presets
    /// stay in passthrough (wet = 0).
    async setReverbPreset(preset: string, contentBaseUrl: string): Promise<void> {
        if (!preset || preset === 'default') {
            this.convolver.buffer = null;
            this.reverbWetGain.gain.value = 0.0;
            this.reverbDryGain.gain.value = 1.0;
            return;
        }
        const base = contentBaseUrl.replace(/\/+$/, '') + '/';
        const url = base + 'sounds/efx/' + preset + '.webm';
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error('not found');
            const bytes = await resp.arrayBuffer();
            const buf = await this.ctx.decodeAudioData(bytes);
            this.convolver.buffer = buf;
            this.reverbWetGain.gain.value = 0.5;
            this.reverbDryGain.gain.value = 0.5;
        } catch {
            // Missing IR is fine — log at debug and stay in passthrough.
            console.debug(`[audio] reverb preset '${preset}' not found, staying dry`);
            this.convolver.buffer = null;
            this.reverbWetGain.gain.value = 0.0;
            this.reverbDryGain.gain.value = 1.0;
        }
    }

    /// Override wet/dry balance — used by Lua
    /// `Spring.SetSoundEffectParams(table)` for fine control.
    setReverbMix(wet: number, dry: number): void {
        this.reverbWetGain.gain.value = Math.max(0, Math.min(1, wet));
        this.reverbDryGain.gain.value = Math.max(0, Math.min(1, dry));
    }

    // ============================================================
    // Play
    // ============================================================

    /**
     * Play a spatial (or non-spatial) sound effect. Routes to the
     * requested channel and applies Recoil-parity per-channel
     * maxConcurrent + strict-greater-priority eviction.
     */
    play(req: SoundRequest): void {
        if (!this.resumed) return;

        const channel = req.channel ?? AudioChannel.General;
        if (!this.channelEnabled[channel]) return;

        const priority = req.priority ?? 0;
        if (priority < this.priorityFloor) return;

        // maxdist gate — drop early if the listener is too far.
        if (req.maxDist !== undefined && req.maxDist > 0) {
            const dx = req.x - this.listenerX;
            const dy = req.y - this.listenerY;
            const dz = req.z - this.listenerZ;
            const distSq = dx*dx + dy*dy + dz*dz;
            if (distSq > req.maxDist * req.maxDist) return;
        }

        const voice = this.acquireVoice(channel, priority,
            req.x, req.y, req.z);
        if (!voice) return;

        if (voice.source) {
            try { voice.source.stop(); } catch { /* already stopped */ }
        }

        const source = this.ctx.createBufferSource();
        source.buffer = req.buffer;
        source.playbackRate.value = req.pitch ?? 1;

        // Re-route the voice's tail to the requested channel if needed.
        if (voice.channel !== channel) {
            voice.gain.disconnect();
            voice.gain.connect(this.channelBuses[channel]);
            voice.channel = channel;
        }

        const spatial = req.spatial !== false;
        if (spatial) {
            source.connect(voice.panner);
        } else {
            // Non-3D: skip the panner entirely. The panner stays in
            // the audio graph but unconnected until the next 3D play().
            source.connect(voice.gain);
        }

        // HRTF tier — same logic as before, applied only when spatial.
        if (spatial) {
            const activeCount = this.countActiveVoices();
            const hot = activeCount > HRTF_HOT_THRESHOLD;
            const wantsHrtf = !hot || priority >= HRTF_FALLBACK_PRIORITY;
            voice.panner.panningModel = wantsHrtf ? 'HRTF' : 'equalpower';
            voice.panner.rolloffFactor = req.rolloff ?? 1;
        }

        const now = this.ctx.currentTime;
        const vx = req.vx ?? 0;
        const vy = req.vy ?? 0;
        const vz = req.vz ?? 0;
        const moving = spatial && (vx !== 0 || vy !== 0 || vz !== 0);

        if (spatial) {
            voice.panner.positionX.cancelScheduledValues(now);
            voice.panner.positionY.cancelScheduledValues(now);
            voice.panner.positionZ.cancelScheduledValues(now);
        }

        if (moving) {
            const pitch = req.pitch ?? 1;
            const dur = (req.buffer.duration / Math.max(pitch, 0.01));
            const endX = req.x + vx * dur;
            const endY = req.y + vy * dur;
            const endZ = req.z + vz * dur;
            voice.panner.positionX.setValueAtTime(req.x, now);
            voice.panner.positionY.setValueAtTime(req.y, now);
            voice.panner.positionZ.setValueAtTime(req.z, now);
            voice.panner.positionX.linearRampToValueAtTime(endX, now + dur);
            voice.panner.positionY.linearRampToValueAtTime(endY, now + dur);
            voice.panner.positionZ.linearRampToValueAtTime(endZ, now + dur);
        } else if (spatial) {
            voice.panner.positionX.setValueAtTime(req.x, now);
            voice.panner.positionY.setValueAtTime(req.y, now);
            voice.panner.positionZ.setValueAtTime(req.z, now);
        }

        voice.gain.gain.value = req.volume ?? 1;
        voice.source = source;
        voice.priority = priority;
        voice.startTime = now;
        voice.active = true;
        voice.posX = req.x;
        voice.posY = req.y;
        voice.posZ = req.z;
        this.channelActiveCount[channel]++;

        source.onended = () => {
            voice.active = false;
            voice.source = null;
            this.channelActiveCount[voice.channel] =
                Math.max(0, this.channelActiveCount[voice.channel] - 1);
        };

        source.start();
    }

    // ============================================================
    // Piece-attached loops (fx-bindings.ts loopSound binding — PLAN-fx-offload X4)
    // ============================================================

    /**
     * Start (or reposition, if already running) a looping voice pinned to
     * `key` — the fx-bindings interpreter's own start/stop hysteresis owns
     * when this is called, so this method is a plain idempotent "make sure
     * this loop is playing at this position" rather than a toggle. Shares
     * `acquireVoice`'s channel-cap/eviction rules with one-shot `play()`;
     * a looped voice competes for the same 96-voice pool exactly like any
     * other sound, so nothing needs its own budget.
     */
    playLoop(key: string, req: SoundRequest): void {
        if (!this.resumed) return;
        const existing = this.activeLoops.get(key);
        if (existing?.active) {
            this.repositionLoop(existing, req);
            return;
        }

        const channel = req.channel ?? AudioChannel.General;
        if (!this.channelEnabled[channel]) return;
        const priority = req.priority ?? 0;
        if (priority < this.priorityFloor) return;

        const voice = this.acquireVoice(channel, priority, req.x, req.y, req.z);
        if (!voice) return;
        if (voice.source) {
            try { voice.source.stop(); } catch { /* already stopped */ }
        }

        const source = this.ctx.createBufferSource();
        source.buffer = req.buffer;
        source.loop = true;
        source.playbackRate.value = req.pitch ?? 1;

        if (voice.channel !== channel) {
            voice.gain.disconnect();
            voice.gain.connect(this.channelBuses[channel]);
            voice.channel = channel;
        }

        const spatial = req.spatial !== false;
        if (spatial) {
            source.connect(voice.panner);
            voice.panner.panningModel = 'HRTF';
            voice.panner.rolloffFactor = req.rolloff ?? 1;
            voice.panner.positionX.cancelScheduledValues(this.ctx.currentTime);
            voice.panner.positionY.cancelScheduledValues(this.ctx.currentTime);
            voice.panner.positionZ.cancelScheduledValues(this.ctx.currentTime);
            voice.panner.positionX.setValueAtTime(req.x, this.ctx.currentTime);
            voice.panner.positionY.setValueAtTime(req.y, this.ctx.currentTime);
            voice.panner.positionZ.setValueAtTime(req.z, this.ctx.currentTime);
        } else {
            source.connect(voice.gain);
        }

        voice.gain.gain.value = req.volume ?? 1;
        voice.source = source;
        voice.priority = priority;
        voice.startTime = this.ctx.currentTime;
        voice.active = true;
        voice.posX = req.x;
        voice.posY = req.y;
        voice.posZ = req.z;
        this.channelActiveCount[channel]++;

        source.onended = () => {
            // A loop only "ends" via explicit stopLoop() (which calls
            // source.stop()) or eviction by acquireVoice() elsewhere —
            // either way the voice bookkeeping is the same as a one-shot.
            voice.active = false;
            voice.source = null;
            this.channelActiveCount[voice.channel] =
                Math.max(0, this.channelActiveCount[voice.channel] - 1);
            this.activeLoops.delete(key);
        };

        this.activeLoops.set(key, voice);
        source.start();
    }

    /// Reposition an already-playing loop voice (piece moved this frame).
    /// No-op if the loop isn't spatial.
    private repositionLoop(voice: Voice, req: SoundRequest): void {
        if (req.spatial === false) return;
        const now = this.ctx.currentTime;
        voice.panner.positionX.setValueAtTime(req.x, now);
        voice.panner.positionY.setValueAtTime(req.y, now);
        voice.panner.positionZ.setValueAtTime(req.z, now);
        voice.posX = req.x;
        voice.posY = req.y;
        voice.posZ = req.z;
    }

    /// Update just the position of an active loop by key — cheaper call
    /// shape than playLoop() for the common per-frame "still moving" case.
    updateLoopPosition(key: string, x: number, y: number, z: number): void {
        const voice = this.activeLoops.get(key);
        if (!voice?.active) return;
        const now = this.ctx.currentTime;
        voice.panner.positionX.setValueAtTime(x, now);
        voice.panner.positionY.setValueAtTime(y, now);
        voice.panner.positionZ.setValueAtTime(z, now);
        voice.posX = x;
        voice.posY = y;
        voice.posZ = z;
    }

    /// Stop a loop started by playLoop(). No-op if `key` isn't active.
    stopLoop(key: string): void {
        const voice = this.activeLoops.get(key);
        if (!voice) return;
        this.activeLoops.delete(key);
        if (voice.source) {
            try { voice.source.stop(); } catch { /* already stopped */ }
        }
    }

    // ============================================================
    // Music
    // ============================================================

    /// Start streaming a music track on the BGMusic channel.
    /// `fadeMs` (default 0) crossfades with whatever's currently
    /// playing. `volume` is interpreted relative to the BGMusic
    /// channel's persisted volume.
    playMusic(url: string, volume: number = 1.0, fadeMs: number = 0): void {
        // Pick the inactive slot.
        const nextSlot = 1 - this.activeMusicSlot;
        const prev = this.musicSlots[this.activeMusicSlot];

        // Tear down anything sitting in the next slot from a prior
        // crossfade that already completed.
        const stale = this.musicSlots[nextSlot];
        if (stale) {
            try { stale.element.pause(); } catch { /* ok */ }
            try { stale.source.disconnect(); } catch { /* ok */ }
            try { stale.gain.disconnect(); } catch { /* ok */ }
            this.musicSlots[nextSlot] = null;
        }

        const element = new Audio(url);
        element.crossOrigin = 'anonymous';
        element.preload = 'auto';
        const source = this.ctx.createMediaElementSource(element);
        const gain = this.ctx.createGain();
        source.connect(gain);
        gain.connect(this.channelBuses[AudioChannel.BGMusic]);

        const targetVol = Math.max(0, Math.min(1, volume));
        const now = this.ctx.currentTime;
        if (fadeMs > 0) {
            gain.gain.value = 0;
            gain.gain.linearRampToValueAtTime(targetVol, now + fadeMs / 1000);
        } else {
            gain.gain.value = targetVol;
        }
        element.play().catch(() => { /* user gesture not yet seen */ });

        this.musicSlots[nextSlot] = { element, source, gain };
        this.activeMusicSlot = nextSlot;

        // Fade out the previous slot, then clean up.
        if (prev) {
            if (fadeMs > 0) {
                prev.gain.gain.cancelScheduledValues(now);
                prev.gain.gain.setValueAtTime(prev.gain.gain.value, now);
                prev.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
                setTimeout(() => {
                    try { prev.element.pause(); } catch { /* ok */ }
                    try { prev.source.disconnect(); } catch { /* ok */ }
                    try { prev.gain.disconnect(); } catch { /* ok */ }
                }, fadeMs + 50);
            } else {
                try { prev.element.pause(); } catch { /* ok */ }
                try { prev.source.disconnect(); } catch { /* ok */ }
                try { prev.gain.disconnect(); } catch { /* ok */ }
            }
        }
    }

    /// Stop the active music slot (with optional short fade).
    stopMusic(fadeMs: number = 0): void {
        const active = this.musicSlots[this.activeMusicSlot];
        if (!active) return;
        if (fadeMs > 0) {
            const now = this.ctx.currentTime;
            active.gain.gain.cancelScheduledValues(now);
            active.gain.gain.setValueAtTime(active.gain.gain.value, now);
            active.gain.gain.linearRampToValueAtTime(0, now + fadeMs / 1000);
            setTimeout(() => this.disposeMusicSlot(this.activeMusicSlot),
                       fadeMs + 50);
        } else {
            this.disposeMusicSlot(this.activeMusicSlot);
        }
    }

    /// Pause the active music slot, retaining position so a
    /// subsequent `playMusic` could resume from here.
    pauseMusic(): void {
        const active = this.musicSlots[this.activeMusicSlot];
        if (!active) return;
        try { active.element.pause(); } catch { /* ok */ }
    }

    /// (played, total) seconds for the active music element.
    getMusicTime(): [number, number] {
        const active = this.musicSlots[this.activeMusicSlot];
        if (!active) return [0, 0];
        return [active.element.currentTime, active.element.duration || 0];
    }

    private disposeMusicSlot(slot: number): void {
        const s = this.musicSlots[slot];
        if (!s) return;
        try { s.element.pause(); } catch { /* ok */ }
        try { s.source.disconnect(); } catch { /* ok */ }
        try { s.gain.disconnect(); } catch { /* ok */ }
        this.musicSlots[slot] = null;
    }

    // ============================================================
    // Internals
    // ============================================================

    private countActiveVoices(): number {
        let n = 0;
        for (const v of this.voices) if (v.active) n++;
        return n;
    }

    /// Acquire a voice. Applies Recoil's per-channel cap with
    /// strict-greater-priority eviction (`AudioChannel.cpp:100-126`):
    ///   1. If the channel is at its concurrent cap, scan the
    ///      channel's active voices for the lowest priority.
    ///   2. If the new request's priority is **strictly greater**
    ///      than that minimum, steal it. Else drop silently.
    ///   3. Independently, if any voice on the channel already has
    ///      priority `>=` the new request's, drop the new request
    ///      (ties favour the incumbent — matches Recoil's second
    ///      precedence pass).
    private acquireVoice(channel: AudioChannel, priority: number,
                         x: number, y: number, z: number): Voice | null {
        // Tie-favours-incumbent check (Recoil's second precedence pass).
        // Disabled to keep our existing "burst of equal-priority sounds
        // all play" behaviour for now — it's the more permissive
        // option. Flip if RTS combat starts feeling too noisy.
        // for (const v of this.voices) {
        //     if (v.active && v.channel === channel && v.priority >= priority) return null;
        // }

        // Easy case: an inactive voice exists and we're under the cap.
        const cap = CHANNEL_MAX_CONCURRENT[channel];
        if (this.channelActiveCount[channel] < cap) {
            for (const voice of this.voices) {
                if (!voice.active) return voice;
            }
        }

        // Per-channel eviction.
        let victim: Voice | null = null;
        let victimPriority = Number.POSITIVE_INFINITY;
        let victimDist = -1;
        for (const v of this.voices) {
            if (!v.active || v.channel !== channel) continue;
            const dist = this.distanceFromListener(v);
            const better =
                v.priority < victimPriority ||
                (v.priority === victimPriority && dist > victimDist);
            if (better) {
                victim = v;
                victimPriority = v.priority;
                victimDist = dist;
            }
        }
        if (!victim) {
            // No active voice on this channel but the cap was hit —
            // shouldn't happen, but fall through to the global pool.
            for (const v of this.voices) {
                if (!v.active) return v;
            }
            return null;
        }
        // Strict-greater priority: tie favours the incumbent.
        if (priority <= victimPriority) return null;

        if (victim.source) {
            try { victim.source.stop(); } catch { /* ok */ }
        }
        victim.active = false;
        this.channelActiveCount[victim.channel] =
            Math.max(0, this.channelActiveCount[victim.channel] - 1);
        // Suppress some-unused-arg warnings: x/y/z are for future
        // distance-aware admission tests that the plan hints at.
        void x; void y; void z;
        return victim;
    }

    private distanceFromListener(voice: Voice): number {
        const dx = voice.posX - this.listenerX;
        const dy = voice.posY - this.listenerY;
        const dz = voice.posZ - this.listenerZ;
        return dx * dx + dy * dy + dz * dz;
    }

    /// Read a legacy numeric localStorage key, or null if unset/invalid.
    /// Used only by migrateLegacyVolumes (PLAN-settings.md §7).
    private readNumberOrNull(key: string): number | null {
        try {
            const raw = localStorage.getItem(key);
            if (raw == null) return null;
            const v = parseFloat(raw);
            return Number.isFinite(v) ? v : null;
        } catch {
            return null;
        }
    }
}
