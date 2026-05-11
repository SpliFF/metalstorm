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
}

const POOL_SIZE = 96;

export class AudioManager {
    private ctx: AudioContext;
    /** Expose AudioContext for procedural sound generation. */
    get context(): AudioContext { return this.ctx; }
    private masterGain: GainNode;
    private voices: Voice[] = [];
    private bufferCache = new Map<string, AudioBuffer>();
    private resumed = false;

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
            gain.connect(this.masterGain);

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

    /** Update the listener position (call each frame with camera position). */
    setListenerPosition(x: number, y: number, z: number,
                        forwardX: number, forwardY: number, forwardZ: number): void {
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

        const voice = this.acquireVoice(req.priority ?? 0);
        if (!voice) return;

        // Stop any existing sound on this voice
        if (voice.source) {
            try { voice.source.stop(); } catch { /* already stopped */ }
        }

        const source = this.ctx.createBufferSource();
        source.buffer = req.buffer;
        source.playbackRate.value = req.pitch ?? 1;
        source.connect(voice.panner);

        voice.panner.positionX.value = req.x;
        voice.panner.positionY.value = req.y;
        voice.panner.positionZ.value = req.z;

        voice.gain.gain.value = req.volume ?? 1;
        voice.source = source;
        voice.priority = req.priority ?? 0;
        voice.startTime = this.ctx.currentTime;
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

    private acquireVoice(priority: number): Voice | null {
        // Find an inactive voice
        for (const voice of this.voices) {
            if (!voice.active) return voice;
        }

        // Evict the lowest-priority voice
        let lowestIdx = 0;
        let lowestPriority = this.voices[0].priority;
        for (let i = 1; i < this.voices.length; i++) {
            if (this.voices[i].priority < lowestPriority) {
                lowestPriority = this.voices[i].priority;
                lowestIdx = i;
            }
        }

        // Only evict if our priority is higher
        if (priority < lowestPriority) return null;

        const voice = this.voices[lowestIdx];
        if (voice.source) {
            try { voice.source.stop(); } catch { /* ok */ }
        }
        voice.active = false;
        return voice;
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
