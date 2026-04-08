/**
 * PerfOverlay — client-side performance metrics display.
 *
 * Shows FPS, entity count, network stats, and interpolation buffer
 * status as an overlay on the game canvas. Toggle with F11 or
 * programmatically.
 */

export class PerfOverlay {
    private element: HTMLDivElement;
    private visible = false;
    private metrics = {
        fps: 0,
        frameTime: 0,
        entityCount: 0,
        drawCalls: 0,
        triangles: 0,
        networkLatency: 0,
        bytesPerSec: 0,
        interpolationBuffer: 0,
    };

    private frameCount = 0;
    private lastFpsUpdate = performance.now();
    private frameTimes: number[] = [];

    constructor() {
        this.element = document.createElement('div');
        this.element.id = 'perf-overlay';
        this.element.style.cssText = `
            position: fixed; top: 8px; right: 8px;
            background: rgba(0,0,0,0.75); color: #0f0;
            font: 12px monospace; padding: 8px 12px;
            pointer-events: none; z-index: 9999;
            border-radius: 4px; display: none;
            white-space: pre; line-height: 1.6;
        `;
        document.body.appendChild(this.element);

        // Toggle with F11
        window.addEventListener('keydown', (e) => {
            if (e.key === 'F11') {
                e.preventDefault();
                this.toggle();
            }
        });
    }

    toggle(): void {
        this.visible = !this.visible;
        this.element.style.display = this.visible ? 'block' : 'none';
    }

    show(): void {
        this.visible = true;
        this.element.style.display = 'block';
    }

    hide(): void {
        this.visible = false;
        this.element.style.display = 'none';
    }

    /** Call every frame with delta time in ms. */
    tick(dtMs: number): void {
        if (!this.visible) return;

        this.frameCount++;
        this.frameTimes.push(dtMs);
        if (this.frameTimes.length > 60) this.frameTimes.shift();

        const now = performance.now();
        if (now - this.lastFpsUpdate >= 500) {
            const elapsed = (now - this.lastFpsUpdate) / 1000;
            this.metrics.fps = Math.round(this.frameCount / elapsed);
            this.metrics.frameTime = this.frameTimes.length > 0
                ? this.frameTimes.reduce((a, b) => a + b) / this.frameTimes.length
                : 0;
            this.frameCount = 0;
            this.lastFpsUpdate = now;
            this.render();
        }
    }

    setEntityCount(count: number): void { this.metrics.entityCount = count; }
    setDrawCalls(count: number): void { this.metrics.drawCalls = count; }
    setTriangles(count: number): void { this.metrics.triangles = count; }
    setNetworkLatency(ms: number): void { this.metrics.networkLatency = ms; }
    setBytesPerSec(bytes: number): void { this.metrics.bytesPerSec = bytes; }

    private render(): void {
        const m = this.metrics;
        const kbps = (m.bytesPerSec / 1024).toFixed(1);
        this.element.textContent =
            `FPS: ${m.fps}  (${m.frameTime.toFixed(1)}ms)\n` +
            `Entities: ${m.entityCount}\n` +
            `Draw calls: ${m.drawCalls}\n` +
            `Triangles: ${(m.triangles / 1000).toFixed(1)}K\n` +
            `Network: ${m.networkLatency}ms  ${kbps} KB/s`;
    }

    dispose(): void {
        this.element.remove();
    }
}
