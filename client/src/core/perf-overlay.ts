/**
 * PerfOverlay — client-side performance metrics display.
 *
 * Shows FPS, frame-time distribution (mean / p95 / p99 / max), entity
 * count, draw calls, and a live per-stream network bandwidth breakdown.
 * Toggle with F11 or programmatically.
 *
 * Frame-time distribution (not just mean) is per PLAN-performance.md
 * Phase 1.1: a 60 fps mean with 120 ms p99 spikes still feels bad, so we
 * surface the tail. The network breakdown reads the always-on accumulator
 * in net-inspector.ts and diffs two snapshots to derive per-second rates
 * per envelope / FlatBuffer type (Phase 2.2/2.3 bandwidth budget).
 *
 * The render-bottleneck lines (draw calls, triangles, GPU frame time,
 * active-mesh eval, render-target time) are the `?perfprobe` piece of
 * PLAN-performance.md Phase 1.2: they stay hidden until `enableSceneProbe()`
 * attaches Babylon's `SceneInstrumentation` + `EngineInstrumentation`, which
 * answers GPU-bound vs CPU-bound and exposes whether thin-instance batching
 * holds at scale. Probe is opt-in (the `?perfprobe` query flag) because the
 * GPU-time query has a small per-frame cost.
 */

import { SceneInstrumentation, EngineInstrumentation, type Scene, type Engine } from '@babylonjs/core';
import { snapshotNetStats, type NetStatsSnapshot } from './net-inspector.js';

export class PerfOverlay {
    private element: HTMLDivElement;
    private visible = false;
    private metrics = {
        fps: 0,
        frameTime: 0,
        entityCount: 0,
        drawCalls: -1,   // -1 = not measured (e.g. SceneInstrumentation not wired)
        triangles: -1,
        networkLatency: 0,
    };

    // ?perfprobe: Babylon render instrumentation (opt-in — see file header).
    private sceneInstr: SceneInstrumentation | null = null;
    private engineInstr: EngineInstrumentation | null = null;
    private probeScene: Scene | null = null;
    private gpuFrameMs = -1;          // -1 = not available (no EXT_disjoint_timer_query)
    private activeMeshesMs = -1;
    private renderTargetsMs = -1;

    private frameCount = 0;
    private lastFpsUpdate = performance.now();
    // Larger ring than the FPS window so percentiles see the tail.
    private frameTimes: number[] = [];
    private static readonly FRAME_RING = 240;

    // Network rate derivation: diff successive cumulative snapshots.
    private lastNetSnapshot: NetStatsSnapshot | null = null;
    private lastNetTime = performance.now();
    private netLines: string[] = [];
    private inKBps = 0;
    private outKBps = 0;

    constructor() {
        this.element = document.createElement('div');
        this.element.id = 'perf-overlay';
        this.element.style.cssText = `
            position: fixed; top: 8px; right: 8px;
            background: rgba(0,0,0,0.75); color: #0f0;
            font: 12px monospace; padding: 8px 12px;
            pointer-events: none; z-index: 9999;
            border-radius: 4px; display: none;
            white-space: pre; line-height: 1.5;
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

    /**
     * Attach Babylon render instrumentation (PLAN-performance.md Phase 1.2).
     * Enables the draw-call / triangle / GPU-frame-time / active-mesh /
     * render-target lines. Auto-shows the overlay so the flag is self-evident.
     * Idempotent — a second call disposes the prior probe first.
     */
    enableSceneProbe(scene: Scene, engine: Engine): void {
        this.disposeProbe();
        this.probeScene = scene;

        const si = new SceneInstrumentation(scene);
        si.captureActiveMeshesEvaluationTime = true;
        si.captureRenderTargetsRenderTime = true;
        si.captureFrameTime = true;
        this.sceneInstr = si;

        // GPU frame time needs EXT_disjoint_timer_query; capture flag is a
        // no-op (stays at -1 below) when the extension is unavailable.
        const ei = new EngineInstrumentation(engine);
        ei.captureGPUFrameTime = true;
        this.engineInstr = ei;

        this.show();
    }

    /** Pull the latest values out of the Babylon counters (every render). */
    private readSceneProbe(): void {
        const si = this.sceneInstr;
        const scene = this.probeScene;
        if (!si || !scene) return;

        // Draw calls + drawn triangles: last-frame current is representative.
        this.metrics.drawCalls = si.drawCallsCounter.current;
        // totalActiveIndices = indices actually submitted this frame; /3 = tris.
        this.metrics.triangles = Math.round(scene.totalActiveIndicesPerfCounter.current / 3);

        // Times: lastSecAverage smooths the per-frame jitter.
        this.activeMeshesMs = si.activeMeshesEvaluationTimeCounter.lastSecAverage;
        this.renderTargetsMs = si.renderTargetsRenderTimeCounter.lastSecAverage;

        const gpuNs = this.engineInstr?.gpuFrameTimeCounter.lastSecAverage ?? 0;
        // 0 means the timer query never resolved (extension missing) — hide it.
        this.gpuFrameMs = gpuNs > 0 ? gpuNs / 1e6 : -1;
    }

    private disposeProbe(): void {
        this.sceneInstr?.dispose();
        this.engineInstr?.dispose();
        this.sceneInstr = null;
        this.engineInstr = null;
        this.probeScene = null;
        this.metrics.drawCalls = -1;
        this.metrics.triangles = -1;
        this.gpuFrameMs = -1;
        this.activeMeshesMs = -1;
        this.renderTargetsMs = -1;
    }

    /** Call every frame with delta time in ms. */
    tick(dtMs: number): void {
        if (!this.visible) return;

        this.frameCount++;
        this.frameTimes.push(dtMs);
        if (this.frameTimes.length > PerfOverlay.FRAME_RING) this.frameTimes.shift();

        const now = performance.now();
        if (now - this.lastFpsUpdate >= 500) {
            const elapsed = (now - this.lastFpsUpdate) / 1000;
            this.metrics.fps = Math.round(this.frameCount / elapsed);
            this.metrics.frameTime = this.frameTimes.length > 0
                ? this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length
                : 0;
            this.frameCount = 0;
            this.lastFpsUpdate = now;
            this.readSceneProbe();
            this.updateNetwork(now);
            this.render();
        }
    }

    setEntityCount(count: number): void { this.metrics.entityCount = count; }
    setDrawCalls(count: number): void { this.metrics.drawCalls = count; }
    setTriangles(count: number): void { this.metrics.triangles = count; }
    setNetworkLatency(ms: number): void { this.metrics.networkLatency = ms; }

    private percentile(sorted: number[], p: number): number {
        if (sorted.length === 0) return 0;
        const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
        return sorted[idx];
    }

    /** Diff the cumulative net counters against the previous snapshot to
     *  build per-second rates per stream, sorted by bytes/sec descending. */
    private updateNetwork(now: number): void {
        const snap = snapshotNetStats();
        const prev = this.lastNetSnapshot;
        const dtSec = Math.max(0.001, (now - this.lastNetTime) / 1000);
        this.lastNetSnapshot = snap;
        this.lastNetTime = now;
        if (!prev) { this.netLines = []; this.inKBps = 0; this.outKBps = 0; return; }

        this.inKBps = (snap.inboundTotalBytes - prev.inboundTotalBytes) / 1024 / dtSec;
        this.outKBps = (snap.outboundTotalBytes - prev.outboundTotalBytes) / 1024 / dtSec;

        // Per-stream inbound rates (the bulk traffic worth breaking down).
        const rows: { label: string; kbps: number; msgps: number }[] = [];
        for (const label in snap.inbound) {
            const cur = snap.inbound[label];
            const old = prev.inbound[label];
            const dBytes = cur.bytes - (old?.bytes ?? 0);
            const dCount = cur.count - (old?.count ?? 0);
            if (dBytes <= 0 && dCount <= 0) continue;
            rows.push({ label, kbps: dBytes / 1024 / dtSec, msgps: dCount / dtSec });
        }
        rows.sort((a, b) => b.kbps - a.kbps);
        this.netLines = rows.slice(0, 6).map(r =>
            `  ${r.label.padEnd(20).slice(0, 20)} ${r.kbps.toFixed(1).padStart(6)} KB/s ${Math.round(r.msgps).toString().padStart(4)}/s`);
    }

    private render(): void {
        const m = this.metrics;
        const sorted = [...this.frameTimes].sort((a, b) => a - b);
        const p95 = this.percentile(sorted, 95);
        const p99 = this.percentile(sorted, 99);
        const max = sorted.length ? sorted[sorted.length - 1] : 0;

        let txt =
            `FPS: ${m.fps}  mean ${m.frameTime.toFixed(1)}ms\n` +
            `Frame p95 ${p95.toFixed(1)}  p99 ${p99.toFixed(1)}  max ${max.toFixed(1)}ms\n` +
            `Entities: ${m.entityCount}\n`;
        if (m.drawCalls >= 0) txt += `Draw calls: ${m.drawCalls}\n`;
        if (m.triangles >= 0) txt += `Triangles: ${(m.triangles / 1000).toFixed(1)}K\n`;
        if (this.gpuFrameMs >= 0) txt += `GPU frame: ${this.gpuFrameMs.toFixed(2)}ms\n`;
        if (this.activeMeshesMs >= 0) txt += `Active-mesh eval: ${this.activeMeshesMs.toFixed(2)}ms\n`;
        if (this.renderTargetsMs >= 0) txt += `Render targets: ${this.renderTargetsMs.toFixed(2)}ms\n`;
        txt += `Net: ${m.networkLatency}ms  ↓${this.inKBps.toFixed(1)} ↑${this.outKBps.toFixed(1)} KB/s`;
        if (this.netLines.length) txt += `\n${this.netLines.join('\n')}`;

        this.element.textContent = txt;
    }

    dispose(): void {
        this.disposeProbe();
        this.element.remove();
    }
}
