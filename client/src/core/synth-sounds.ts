/**
 * SynthSounds — procedurally generated sound effects via Web Audio.
 *
 * Creates short audio buffers for common game sounds (weapon fire,
 * explosion, impact) using oscillators and noise. No external audio
 * files needed.
 */

/// 5 ms attack ramps in from zero so the wavetable doesn't start at a
/// non-zero sample (the audible "click" before this fix). 30 ms release
/// tail fades the final samples to zero so the buffer doesn't end on a
/// hard step.
const ATTACK_SECS = 0.005;
const RELEASE_SECS = 0.030;

/** Generate a short AudioBuffer from parameters. */
function generateBuffer(
    ctx: AudioContext,
    duration: number,
    generator: (t: number, sampleRate: number) => number,
): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(duration * sampleRate);
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);

    const attack = Math.min(ATTACK_SECS, duration * 0.5);
    const release = Math.min(RELEASE_SECS, duration * 0.5);
    const releaseStart = duration - release;

    for (let i = 0; i < length; i++) {
        const t = i / sampleRate;
        let env: number;
        if (t < attack) {
            env = t / attack;
        } else if (t > releaseStart) {
            env = Math.max(0, (duration - t) / release);
        } else {
            env = 1;
        }
        data[i] = generator(t, sampleRate) * env;
    }

    return buffer;
}

/** White noise with envelope. */
function noise(_t: number, _sr: number): number {
    return (Math.random() * 2 - 1);
}

/** Sine wave at a given frequency with pitch drop. */
function toneDrop(freq: number, dropRate: number) {
    return (t: number, _sr: number): number => {
        const f = freq * Math.exp(-dropRate * t);
        return Math.sin(2 * Math.PI * f * t);
    };
}

export function createSynthSounds(ctx: AudioContext): Map<string, AudioBuffer> {
    const sounds = new Map<string, AudioBuffer>();

    // Cannon fire: sharp click + low tone
    sounds.set('cannon', generateBuffer(ctx, 0.15, (t, sr) => {
        const click = t < 0.01 ? (Math.random() * 2 - 1) * 2 : 0;
        const tone = Math.sin(2 * Math.PI * 120 * Math.exp(-20 * t) * t) * 0.5;
        return (click + tone) * Math.max(0, 1 - t / 0.15);
    }));

    // Explosion: low rumble + noise burst
    sounds.set('explosion', generateBuffer(ctx, 0.4, (t, sr) => {
        const rumble = toneDrop(60, 8)(t, sr) * 0.7;
        const burst = noise(t, sr) * Math.exp(-10 * t) * 0.6;
        return rumble + burst;
    }));

    // Impact: short thud
    sounds.set('impact', generateBuffer(ctx, 0.08, (t, sr) => {
        return toneDrop(200, 40)(t, sr) * 0.4 + noise(t, sr) * Math.exp(-30 * t) * 0.3;
    }));

    // Machine gun: rapid clicks
    sounds.set('machinegun', generateBuffer(ctx, 0.06, (t, sr) => {
        return noise(t, sr) * Math.exp(-50 * t);
    }));

    return sounds;
}
