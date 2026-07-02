/**
 * FrameProfiler — permanent per-phase frame-time accumulator (PLAN-perf P0).
 *
 * The game-processor render loop stamps each phase's duration every frame
 * (camera / entity / fx / decals+lights / render / ui, plus the frame total);
 * this class keeps a rolling, time-windowed ring of those samples and computes
 * mean / p50 / p95 / p99 / max per phase on demand. It turns the old ">150 ms
 * long-frame log" — which only fired on hitches and still left the *steady
 * state* unattributed — into a measurable distribution, so a framerate
 * regression can be pinned to a specific subsystem with numbers instead of
 * guessed (PLAN-perf P0 attribution matrix).
 *
 * Cheap by design: the hot path (`beginFrame` / `mark` / `endFrame`) does a
 * handful of typed-array writes with **zero per-frame allocation** — percentile
 * math and array building happen only at `dump()` time (on demand). Left on
 * permanently; this is instrumentation, not scaffolding.
 *
 * Reachable from the main devtools console / test harness:
 *   - `window.test.perfDump()` — structured dump + pre-formatted table
 *   - `window.__gp('__frameProfiler.dump()')` — raw worker-global access
 */

/** Frame phases in the order the render loop marks them. `total` is the whole
 *  rAF callback (includes the small post-`ui` scene-state/minimap posts). */
export const FRAME_PHASES = [
    'camera', 'entity', 'fx', 'decals+lights', 'render', 'ui', 'total',
] as const;
export type FramePhase = typeof FRAME_PHASES[number];

export interface PhaseStats {
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
}

export interface FrameProfileDump {
    /** Window actually covered (ms) — min(requested, buffered span). */
    windowMs: number;
    /** Frames sampled inside the window. */
    frames: number;
    /** Derived fps over the sampled window. */
    fps: number;
    /** Per-phase stats, keyed by FRAME_PHASES name. */
    phases: Record<FramePhase, PhaseStats>;
    /** Human-readable fixed-width table (handy for a console / hand-off). */
    table: string;
}

const N_PHASES = FRAME_PHASES.length;
const TOTAL_IDX = N_PHASES - 1;

function statsOf(sorted: number[]): PhaseStats {
    const n = sorted.length;
    if (n === 0) return { mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sorted[i];
    const pct = (p: number) => sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
    return {
        mean: sum / n,
        p50: pct(50),
        p95: pct(95),
        p99: pct(99),
        max: sorted[n - 1],
    };
}

export class FrameProfiler {
    private readonly cap: number;
    readonly windowMs: number;
    /** Per-sample frame-start timestamp (performance.now()). */
    private readonly ts: Float64Array;
    /** Row-major [cap × N_PHASES] durations in ms. */
    private readonly data: Float32Array;
    private head = 0;    // next write row
    private count = 0;   // valid rows (≤ cap)
    // Hot-path scratch for the in-progress frame (no allocation).
    private writeBase = 0;
    private frameStart = 0;
    private prevMark = 0;
    private lastRow = 0;

    /**
     * @param windowMs default reporting window (30 s per P0).
     * @param capacity ring size in frames. 8192 covers a 30 s window up to
     *   ~270 fps; beyond that the effective window shortens (reported in the
     *   dump's `windowMs`), never overflows.
     */
    constructor(windowMs = 30000, capacity = 8192) {
        this.windowMs = windowMs;
        this.cap = capacity;
        this.ts = new Float64Array(capacity);
        this.data = new Float32Array(capacity * N_PHASES);
    }

    /** Start a frame at `now`; subsequent `mark`s diff against this. */
    beginFrame(now: number): void {
        this.frameStart = now;
        this.prevMark = now;
        this.writeBase = this.head * N_PHASES;
    }

    /** Record phase `idx` (0..5, FRAME_PHASES order) as ending `now`. */
    mark(idx: number, now: number): void {
        this.data[this.writeBase + idx] = now - this.prevMark;
        this.prevMark = now;
    }

    /** Close the frame at `now`; fills the `total` column and advances the
     *  ring. Returns the frame total (ms) so the caller can gate a long-frame
     *  log without re-reading the buffer. */
    endFrame(now: number): number {
        const total = now - this.frameStart;
        this.data[this.writeBase + TOTAL_IDX] = total;
        this.ts[this.head] = this.frameStart;
        this.lastRow = this.head;
        this.head = (this.head + 1) % this.cap;
        if (this.count < this.cap) this.count++;
        return total;
    }

    /** `camera=1 entity=2 …` breakdown of the most recent frame (long-frame
     *  log; allocates — call only on a genuine hitch). */
    formatLastFrame(): string {
        const base = this.lastRow * N_PHASES;
        const parts: string[] = [];
        for (let p = 0; p < TOTAL_IDX; p++) {
            parts.push(`${FRAME_PHASES[p]}=${this.data[base + p] | 0}`);
        }
        return parts.join(' ');
    }

    /** Percentile table over the last `windowMs` (default: constructor value). */
    dump(windowMs = this.windowMs, now = performance.now()): FrameProfileDump {
        const cutoff = now - windowMs;
        const cols: number[][] = Array.from({ length: N_PHASES }, () => []);
        let minTs = Infinity;
        let maxTs = -Infinity;
        // Walk oldest → newest so timestamps are monotonic for the span calc.
        const start = (this.head - this.count + this.cap) % this.cap;
        for (let k = 0; k < this.count; k++) {
            const row = (start + k) % this.cap;
            const t = this.ts[row];
            if (t < cutoff) continue;
            if (t < minTs) minTs = t;
            if (t > maxTs) maxTs = t;
            const base = row * N_PHASES;
            for (let p = 0; p < N_PHASES; p++) cols[p].push(this.data[base + p]);
        }
        const frames = cols[TOTAL_IDX].length;
        const spanS = frames > 1 ? (maxTs - minTs) / 1000 : 0;
        const fps = spanS > 0 ? Math.round(((frames - 1) / spanS) * 10) / 10 : 0;

        const phases = {} as Record<FramePhase, PhaseStats>;
        for (let p = 0; p < N_PHASES; p++) {
            cols[p].sort((a, b) => a - b);
            phases[FRAME_PHASES[p]] = statsOf(cols[p]);
        }
        const effWindowMs = frames > 1 ? Math.round(maxTs - minTs) : 0;
        return {
            windowMs: effWindowMs,
            frames,
            fps,
            phases,
            table: FrameProfiler.format(phases, frames, fps, effWindowMs),
        };
    }

    /** Drop all buffered samples (e.g. before a fresh measurement run). */
    reset(): void {
        this.head = 0;
        this.count = 0;
    }

    /** Fixed-width table: one row per phase, columns mean/p50/p95/p99/max (ms). */
    static format(
        phases: Record<FramePhase, PhaseStats>,
        frames: number,
        fps: number,
        windowMs: number,
    ): string {
        const f = (n: number) => n.toFixed(2).padStart(7);
        const lines: string[] = [];
        lines.push(`frames=${frames} fps=${fps} window=${(windowMs / 1000).toFixed(1)}s`);
        lines.push(`phase           mean    p50    p95    p99    max`);
        for (const name of FRAME_PHASES) {
            const s = phases[name];
            lines.push(`${name.padEnd(14)}${f(s.mean)}${f(s.p50)}${f(s.p95)}${f(s.p99)}${f(s.max)}`);
        }
        return lines.join('\n');
    }
}
