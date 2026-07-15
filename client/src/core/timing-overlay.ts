/**
 * TimingOverlay — presentation-clock / latency telemetry (PLAN-latency.md L0).
 *
 * "We cannot tune what we can't see." This panel surfaces the live timing
 * model so the L0/L1/L2 mitigations can be A/B'd under the artificial-latency
 * injection (`window.test.netSim(...)`):
 *
 *   - E, P, D (frames + ms) — is the cursor tracking E − D?
 *   - measured RTT + clock offset (the values that now feed rendering)
 *   - snapshot arrival-jitter histogram
 *   - reorder / loss counts (base_frame doubles as the sequence number)
 *   - interpolation correction count + last magnitude (how far / how often the
 *     cursor snaps)
 *   - the active netSim condition
 *
 * Deliberately a SEPARATE panel from perf-overlay.ts (toggled with F10, not
 * F11): perf-overlay is being rewritten in parallel on the weapon-fx branch
 * (frame-time distribution + per-stream net breakdown), so keeping the L0
 * telemetry self-contained avoids a merge collision. The two panels can be
 * folded together once both land.
 *
 * Post-GW4 the clock itself lives in the game-processor worker, so this panel
 * reads a `GpTimingState` snapshot delivered over `gp:sceneState` (~10 Hz)
 * rather than holding a PresentationClock instance — hence the provider
 * function in the constructor (PLAN-latency-impl.md L-pre.3).
 */

import type { GpTimingState } from './game-worker-protocol.js';

export class TimingOverlay {
    private element: HTMLDivElement;
    private visible = false;
    /** Returns the latest worker timing snapshot, or null before one arrives. */
    private provider: () => GpTimingState | null;
    private lastRender = 0;

    constructor(provider: () => GpTimingState | null) {
        this.provider = provider;
        this.element = document.createElement('div');
        this.element.id = 'timing-overlay';
        this.element.style.cssText = `
            position: fixed; top: 8px; left: 8px;
            background: rgba(0,0,0,0.78); color: #6cf;
            font: 11px monospace; padding: 8px 12px;
            pointer-events: none; z-index: 9999;
            border-radius: 4px; display: none;
            white-space: pre; line-height: 1.5;
        `;
        document.body.appendChild(this.element);

        // Toggle with F10 (perf overlay owns F11).
        window.addEventListener('keydown', (e) => {
            if (e.key === 'F10') {
                e.preventDefault();
                this.toggle();
            }
        });
    }

    toggle(): void {
        this.visible = !this.visible;
        this.element.style.display = this.visible ? 'block' : 'none';
    }

    show(): void { this.visible = true; this.element.style.display = 'block'; }
    hide(): void { this.visible = false; this.element.style.display = 'none'; }

    /** Call every render frame; throttles its own DOM update to ~3 Hz. */
    tick(): void {
        if (!this.visible) return;
        const now = performance.now();
        if (now - this.lastRender < 300) return;
        this.lastRender = now;
        this.render();
    }

    private render(): void {
        const s = this.provider();
        const f = (n: number) => n.toFixed(1);

        if (!s || !s.anchored) {
            this.element.textContent =
                'PRESENTATION CLOCK (F10)\n  waiting for first frame-stamped snapshot…';
            return;
        }

        const net = s.netSim;
        const netLine = net && net.enabled
            ? `\nnetSim:   ON  delay=${net.delayMs}±${net.jitterMs}ms loss=${(net.lossProb * 100).toFixed(1)}%`
            : '\nnetSim:   off';

        // P should sit D frames behind E. Show the live gap as a sanity check.
        const gap = s.E - s.P;

        this.element.textContent =
            `PRESENTATION CLOCK (F10)\n` +
            `E (server):  ${f(s.E)}  frame\n` +
            `P (cursor):  ${f(s.P)}  frame   (E−P = ${f(gap)})\n` +
            `D (delay):   ${f(s.displayDelayFrames)} fr  ${Math.round(s.displayDelayMs)} ms\n` +
            `newest rcvd: ${s.newestFrame}   speed ${f(s.speedFactor)}×\n` +
            `RTT: ${Math.round(s.rttMs)}ms  offset: ${Math.round(s.offsetMs)}ms  (${s.clockSamples} samp)\n` +
            `arrival jitter: ${f(s.arrivalJitterMs)}ms\n` +
            this.histogram(s.arrivalDeviations) + '\n' +
            `reorder: ${s.reorderCount}  loss: ${s.lossCount}\n` +
            `corrections: ${s.correctionCount}  last: ${f(s.lastCorrectionFrames)} fr` +
            netLine;
    }

    /** Compact ASCII histogram of recent signed arrival deviations (ms),
     *  bucketed across [−50, +50] ms (outliers clamp to the end buckets). */
    private histogram(devs: readonly number[]): string {
        if (devs.length === 0) return '  [no arrival samples]';
        const BUCKETS = 11;            // centre bucket = on-time
        const RANGE = 50;              // ±50 ms span
        const counts = new Array(BUCKETS).fill(0);
        for (const d of devs) {
            const clamped = Math.max(-RANGE, Math.min(RANGE, d));
            let idx = Math.round(((clamped + RANGE) / (2 * RANGE)) * (BUCKETS - 1));
            if (idx < 0) idx = 0;
            if (idx >= BUCKETS) idx = BUCKETS - 1;
            counts[idx]++;
        }
        const max = Math.max(1, ...counts);
        const bars = ' ▁▂▃▄▅▆▇█';
        let row = '  -50ms ';
        for (const c of counts) {
            const level = Math.round((c / max) * (bars.length - 1));
            row += bars[level];
        }
        row += ' +50ms';
        return row;
    }

    dispose(): void {
        this.element.remove();
    }
}
