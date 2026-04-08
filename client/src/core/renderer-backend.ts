/**
 * RendererBackend — GPU backend detection and configuration.
 *
 * Babylon.js abstracts GPU backends. This module detects whether
 * WebGPU is available and configures the engine accordingly.
 * On WebGPU, compute shaders can be used for frustum culling,
 * GPU particle systems, and indirect draws.
 */

import { Engine } from '@babylonjs/core';

export type BackendType = 'webgl2' | 'webgpu';

export interface RendererConfig {
    backend: BackendType;
    antialias: boolean;
    preserveDrawingBuffer: boolean;
}

/**
 * Detect the best available rendering backend.
 */
export function detectBackend(): BackendType {
    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
        return 'webgpu';
    }
    return 'webgl2';
}

/**
 * Create an engine with the best available backend.
 * Falls back to WebGL2 if WebGPU is unavailable.
 *
 * WebGPU support will be added when Babylon.js WebGPU types stabilize.
 * For now, always uses WebGL2.
 */
export async function createEngine(
    canvas: HTMLCanvasElement,
    config?: Partial<RendererConfig>
): Promise<Engine> {
    const antialias = config?.antialias ?? true;
    const preserveDrawingBuffer = config?.preserveDrawingBuffer ?? true;

    const engine = new Engine(canvas, antialias, {
        preserveDrawingBuffer,
        stencil: true,
    });

    const backend = config?.backend ?? detectBackend();
    console.log(`[renderer] using WebGL2 (detected: ${backend})`);
    return engine;
}

/**
 * Get the current backend type from an engine instance.
 */
export function getBackendType(_engine: Engine): BackendType {
    return 'webgl2'; // WebGPU detection will be added later
}
