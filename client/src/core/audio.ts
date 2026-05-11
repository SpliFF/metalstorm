/**
 * AudioManager — Web Audio voice pool with 3D spatial sound.
 *
 * Per PLAN-audio.md:
 *   - 96-voice pool with distance-based priority culling
 *   - PannerNode for 3D positional audio tied to camera
 *   - Pre-decoded AudioBuffer cache for SFX
 *   - Streamed MediaElementAudioSourceNode for music
 *   - Must resume AudioContext on first user interaction
 */

/** A single voice in the pool. */
interface Voice {
    source: AudioBufferSourceNode | null;
    panner: PannerNode;
    gain: GainNode;
    priority: number;
    startTime: number;
    active: boolean;
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
    /// Optional emitter velocity in world units per second. When
    /// any component is non-zero, AudioManager schedules a linear
    /// position ramp on the PannerNode for the duration of the
    /// buffer so the source slides past the listener naturally
    /// (PLAN-audio.md — moving-emitter ramps). Stationary sources omit
    /// this and the panner is set once at request time as before.
    vx?: number;
    vy?: number;
    vz?: number;
}

const POOL_SIZE = 96;
/// When more than this many voices are active we start placing new
/// low-priority requests on `equalpower` panners instead of `HRTF` to
/// cut DSP cost. HRTF is ~10× more expensive than equalpower per voice
/// on a typical desktop; below this threshold the difference is
/// inaudible against the limiter, above it the budget matters.
const HRTF_HOT_THRESHOLD = 50;
/// Priority below which a hot-pool voice falls back to equalpower
/// panning. Fire/impact events sit at 128+, deaths at 192 — both stay
/// HRTF even when the pool is full. Select/order chatter at 0 takes
/// the cheap path.
const HRTF_FALLBACK_PRIORITY = 100;

/// Camera-height → zoom-factor mapping. The camera lives in the
/// y∈[minHeight,maxHeight] band defined by RtsCamera (defaults 100
/// and 5000). We treat anything ≤ 400 elmos as "close" (factor 0)
/// and anything ≥ 3500 as "far" (factor 1). The cutoffs are picked
/// empirically to match the camera bands the player actually uses:
/// scrolling around at ~600–1500 stays in the gentle-falloff range.
const ZOOM_CLOSE_HEIGHT = 400;
const ZOOM_FAR_HEIGHT = 3500;

/// Attenuation envelope from PLAN-audio.md §"Zoom-aware attenuation"
/// re-parameterised against a 0..1 zoom factor:
///   factor ≤ 0.15 → full volume
///   factor ≥ 0.85 → 0.2× volume
///   between → linear falloff
/// The plateau at low zoom prevents the bus from breathing while the
/// player nudges the camera near the close stop; the floor at high
/// zoom keeps distant explosions audible rather than silent.
function zoomAttenuation(factor: number): number {
    if (factor <= 0.15) return 1.0;
    if (factor >= 0.85) return 0.2;
    return 1.0 - (factor - 0.15) * (0.8 / 0.7);
}

/// Priority floor as a function of zoom factor. When zoomed in,
/// every sound plays (floor 0). When zoomed far out, only sounds
/// flagged with priority ≥ 100 — fire/impact events on big weapons,
/// unit deaths — make it into the pool; ambient/select/order chatter
/// is suppressed so the mix doesn't turn to mush at strategic zoom.
function zoomPriorityFloor(factor: number): number {
    if (factor <= 0.2) return 0;
    if (factor >= 0.9) return 100;
    return Math.floor((factor - 0.2) * (100 / 0.7));
}

export class AudioManager {
    private ctx: AudioContext;
    /** Expose AudioContext for procedural sound generation. */
    get context(): AudioContext { return this.ctx; }
    private masterGain: GainNode;
    /// SFX bus — sits between the voice pool and the master gain so
    /// zoom-based attenuation can ride the spatial mix without
    /// pulling music down with it.
    private sfxBus: GainNode;
    private voices: Voice[] = [];
    private bufferCache = new Map<string, AudioBuffer>();
    private resumed = false;
    /// Priority floor: play() rejects requests below this priority.
    /// Driven by setZoomFactor() so zoom-out culls low-importance
    /// chatter (select/order acks) before it even hits the pool.
    private priorityFloor = 0;
    /// Last listener position pushed via setListenerPosition. Used by
    /// eviction to break priority ties — at saturation, drop the
    /// furthest voice first so nearby sounds aren't sacrificed to
    /// distant ones of the same importance.
    private listenerX = 0;
    private listenerY = 0;
    private listenerZ = 0;

    // Music
    private musicElement: HTMLAudioElement | null = null;
    private musicSource: MediaElementAudioSourceNode | null = null;
    private musicGain: GainNode;

    constructor() {
        this.ctx = new AudioContext();
        this.masterGain = this.ctx.createGain();

        // Master limiter — dozens of overlapping HRTF voices in a heavy
        // combat tick sum well past 1.0 and clip hard at `destination`.
        // A soft-knee compressor with a low threshold catches the spikes
        // while leaving the average mix untouched.
        const limiter = this.ctx.createDynamicsCompressor();
        limiter.threshold.value = -6;   // dB
        limiter.knee.value = 0;
        limiter.ratio.value = 12;
        limiter.attack.value = 0.003;   // 3 ms
        limiter.release.value = 0.25;   // 250 ms
        this.masterGain.connect(limiter);
        limiter.connect(this.ctx.destination);

        this.sfxBus = this.ctx.createGain();
        this.sfxBus.connect(this.masterGain);

        this.musicGain = this.ctx.createGain();
        this.musicGain.gain.value = 0.3;
        this.musicGain.connect(this.masterGain);

        // Pre-create voice pool
        for (let i = 0; i < POOL_SIZE; i++) {
            const panner = this.ctx.createPanner();
            panner.panningModel = 'HRTF';
            panner.distanceModel = 'inverse';
            panner.refDistance = 50;
            panner.maxDistance = 5000;
            panner.rolloffFactor = 1;

            const gain = this.ctx.createGain();
            panner.connect(gain);
            gain.connect(this.sfxBus);

            this.voices.push({
                source: null,
                panner,
                gain,
                priority: 0,
                startTime: 0,
                active: false,
            });
        }
    }

    /**
     * Resume the AudioContext. Must be called from a user interaction
     * event handler (click, keydown) due to browser autoplay policy.
     */
    async resume(): Promise<void> {
        if (this.resumed) return;
        await this.ctx.resume();
        this.resumed = true;
    }

    /**
     * Update zoom-based attenuation. `cameraHeight` is the camera's
     * world Y coordinate; the manager normalises against the close/far
     * cutoffs and drives both the SFX bus gain and the priority floor.
     *
     * Called every frame from the render loop alongside
     * `setListenerPosition`. The bus gain rides a smooth `setTargetAtTime`
     * ramp so rapid wheel-zoom motion doesn't audibly pump the mix; the
     * priority floor updates instantly because it's only consulted on
     * the next play() call.
     */
    setZoomFactor(cameraHeight: number): void {
        const span = ZOOM_FAR_HEIGHT - ZOOM_CLOSE_HEIGHT;
        const raw = (cameraHeight - ZOOM_CLOSE_HEIGHT) / span;
        const factor = Math.max(0, Math.min(1, raw));
        const gain = zoomAttenuation(factor);
        // setTargetAtTime with a ~200 ms time-constant gives a soft
        // exponential approach — fast enough to react to wheel zoom,
        // slow enough that an active sound doesn't notch when the
        // factor jumps a small step between frames.
        this.sfxBus.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.2);
        this.priorityFloor = zoomPriorityFloor(factor);
    }

    /** Update the listener position (call each frame with camera position). */
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

    /** Load and cache an audio buffer from a URL. */
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

    /** Get a cached audio buffer by name. */
    getBuffer(name: string): AudioBuffer | undefined {
        return this.bufferCache.get(name);
    }

    /**
     * Play a spatial sound effect. Acquires a voice from the pool,
     * evicting the lowest-priority voice if the pool is full.
     */
    play(req: SoundRequest): void {
        if (!this.resumed) return;

        const priority = req.priority ?? 0;
        // Zoom-driven cull: drop low-priority requests outright when the
        // floor exceeds them. Cheaper than acquiring then evicting and
        // matches the spec's "raise priority threshold" hint.
        if (priority < this.priorityFloor) return;

        const voice = this.acquireVoice(priority);
        if (!voice) return;

        // Stop any existing sound on this voice
        if (voice.source) {
            try { voice.source.stop(); } catch { /* already stopped */ }
        }

        const source = this.ctx.createBufferSource();
        source.buffer = req.buffer;
        source.playbackRate.value = req.pitch ?? 1;
        source.connect(voice.panner);

        // Panning-model tier: HRTF gives elevation cues but is ~10×
        // costlier than equalpower per voice. When the pool is hot and
        // this request isn't a high-priority hit/death, fall back to
        // equalpower so the DSP budget stays flat. Switching is free —
        // PannerNode lets you re-assign the model between play() calls.
        const activeCount = this.countActiveVoices();
        const hot = activeCount > HRTF_HOT_THRESHOLD;
        const wantsHrtf = !hot || priority >= HRTF_FALLBACK_PRIORITY;
        voice.panner.panningModel = wantsHrtf ? 'HRTF' : 'equalpower';

        const now = this.ctx.currentTime;
        const vx = req.vx ?? 0;
        const vy = req.vy ?? 0;
        const vz = req.vz ?? 0;
        const moving = (vx !== 0 || vy !== 0 || vz !== 0);

        // Cancel any ramps left over from the previous voice owner —
        // panners aren't disposable so we must reset the timeline
        // before scheduling new automation. Without this a fast-moving
        // sound followed by a stationary one inherits the prior ramp.
        voice.panner.positionX.cancelScheduledValues(now);
        voice.panner.positionY.cancelScheduledValues(now);
        voice.panner.positionZ.cancelScheduledValues(now);

        if (moving) {
            // Account for pitch — a buffer at 2× pitch plays for half
            // its natural duration. Pass-through when pitch is missing.
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
        } else {
            voice.panner.positionX.setValueAtTime(req.x, now);
            voice.panner.positionY.setValueAtTime(req.y, now);
            voice.panner.positionZ.setValueAtTime(req.z, now);
        }

        voice.gain.gain.value = req.volume ?? 1;
        voice.source = source;
        voice.priority = priority;
        voice.startTime = now;
        voice.active = true;

        source.onended = () => {
            voice.active = false;
            voice.source = null;
        };

        source.start();
    }

    /** Start streaming music from a URL. */
    playMusic(url: string, volume: number = 0.3): void {
        this.stopMusic();

        this.musicElement = new Audio(url);
        this.musicElement.loop = true;
        this.musicElement.crossOrigin = 'anonymous';
        this.musicSource = this.ctx.createMediaElementSource(this.musicElement);
        this.musicSource.connect(this.musicGain);
        this.musicGain.gain.value = volume;
        this.musicElement.play().catch(() => {});
    }

    /** Stop music playback. */
    stopMusic(): void {
        if (this.musicElement) {
            this.musicElement.pause();
            this.musicElement = null;
        }
        if (this.musicSource) {
            this.musicSource.disconnect();
            this.musicSource = null;
        }
    }

    /** Set master volume (0-1). */
    setVolume(volume: number): void {
        this.masterGain.gain.value = Math.max(0, Math.min(1, volume));
    }

    private countActiveVoices(): number {
        let n = 0;
        for (const v of this.voices) if (v.active) n++;
        return n;
    }

    private acquireVoice(priority: number): Voice | null {
        // Find an inactive voice
        for (const voice of this.voices) {
            if (!voice.active) return voice;
        }

        // Evict by priority; break ties by distance to the listener so
        // a distant low-priority voice drops before a nearby one of the
        // same priority (PLAN-audio.md — voice eviction tie-break).
        let victimIdx = 0;
        let victimPriority = this.voices[0].priority;
        let victimDist = this.distanceFromListener(this.voices[0]);
        for (let i = 1; i < this.voices.length; i++) {
            const v = this.voices[i];
            const better =
                v.priority < victimPriority ||
                (v.priority === victimPriority && this.distanceFromListener(v) > victimDist);
            if (better) {
                victimPriority = v.priority;
                victimDist = this.distanceFromListener(v);
                victimIdx = i;
            }
        }

        // Only evict if our priority is higher
        if (priority < victimPriority) return null;

        const voice = this.voices[victimIdx];
        if (voice.source) {
            try { voice.source.stop(); } catch { /* ok */ }
        }
        voice.active = false;
        return voice;
    }

    private distanceFromListener(voice: Voice): number {
        const dx = voice.panner.positionX.value - this.listenerX;
        const dy = voice.panner.positionY.value - this.listenerY;
        const dz = voice.panner.positionZ.value - this.listenerZ;
        return dx * dx + dy * dy + dz * dz; // squared — ordering is identical
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
}
