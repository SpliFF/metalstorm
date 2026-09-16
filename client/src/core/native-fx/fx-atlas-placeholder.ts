/**
 * Procedural placeholder FX art — the stand-in atlas + ribbon strips used
 * until `unittextures/fx_atlas.png` is authored (PLAN-metalstorm.md §11,
 * L-IMAGEGEN). Extracted from fx-stage.ts so BOTH consumers can bake it: the
 * main-thread fx-viewer stage (HTMLCanvasElement) and the game-processor
 * worker's FX pass (OffscreenCanvas). Nothing here touches the DOM directly —
 * the 2D surface comes from `makeCanvas`, which defaults to OffscreenCanvas
 * where it exists and `document.createElement` otherwise.
 *
 * Cell art is deliberately simple — silhouettes match the frame's role
 * (dot/spark/fireball/smoke/…): good enough to judge motion, timing and
 * blending, which is what both consumers need. Swap-in of real art replaces
 * `buildPlaceholderAtlas` only.
 */

import type { FxLibrary } from './effect-compiler.js';

/** Any 2D-capable surface the builders can paint into and upload from. */
type PaintCanvas = OffscreenCanvas | HTMLCanvasElement;
export type CanvasFactory = (w: number, h: number) => PaintCanvas;

/** OffscreenCanvas in a worker, a DOM canvas on the main thread. */
export const defaultCanvasFactory: CanvasFactory = (w, h) => {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    return cv;
};

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Bake a procedural stand-in for every frame named in library.json.atlas.
 *  Cell art is deliberately simple — silhouettes match the frame's role
 *  (dot/spark/fireball/smoke/…): good enough to judge motion, timing, and
 *  blending, which is what the harness tests. */
export function buildPlaceholderAtlas(
    gl: WebGL2RenderingContext, lib: FxLibrary,
    makeCanvas: CanvasFactory = defaultCanvasFactory,
): WebGLTexture {
    const cols = lib.atlas.cols, rows = lib.atlas.rows;
    const cell = 64;
    const cv = makeCanvas(cols * cell, rows * cell);
    const c = cv.getContext('2d') as Ctx2D;
    c.clearRect(0, 0, cv.width, cv.height);

    const painters: Record<string, (x: number, y: number) => void> = {
        dot: (x, y) => radial(c, x, y, cell, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]),
        spark: (x, y) => {
            const g = c.createLinearGradient(x + cell / 2, y + 4, x + cell / 2, y + cell - 4);
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(0.5, 'rgba(255,255,255,1)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            c.fillStyle = g;
            c.fillRect(x + cell * 0.42, y + 2, cell * 0.16, cell - 4);
        },
        fireball: (x, y) => {
            radial(c, x, y, cell, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,240,210,0.9)'], [0.7, 'rgba(255,200,120,0.45)'], [1, 'rgba(255,160,60,0)']]);
            blotch(c, x, y, cell, 5, 'rgba(255,235,200,0.5)');
        },
        smoke: (x, y) => blotch(c, x, y, cell, 7, 'rgba(255,255,255,0.55)'),
        dust: (x, y) => blotch(c, x, y, cell, 9, 'rgba(255,255,255,0.4)'),
        flash: (x, y) => {
            radial(c, x, y, cell, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.7)'], [1, 'rgba(255,255,255,0)']]);
            c.save();
            c.translate(x + cell / 2, y + cell / 2);
            c.fillStyle = 'rgba(255,255,255,0.8)';
            for (let i = 0; i < 4; i++) {
                c.rotate(Math.PI / 4);
                c.fillRect(-cell * 0.46, -1.6, cell * 0.92, 3.2);
            }
            c.restore();
        },
        ring: (x, y) => {
            c.strokeStyle = 'rgba(255,255,255,0.9)';
            c.lineWidth = cell * 0.08;
            c.beginPath();
            c.arc(x + cell / 2, y + cell / 2, cell * 0.34, 0, Math.PI * 2);
            c.stroke();
        },
        foam: (x, y) => {
            for (let i = 0; i < 14; i++) {
                const a = (i * 2.39996) % (Math.PI * 2);   // golden-angle scatter
                const r = cell * (0.1 + 0.28 * ((i * 0.618) % 1));
                const bx = x + cell / 2 + Math.cos(a) * r;
                const by = y + cell / 2 + Math.sin(a) * r;
                radialAt(c, bx, by, cell * (0.06 + 0.05 * ((i * 0.37) % 1)),
                    [[0, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
            }
        },
        smoketrail: (x, y) => stripInCell(c, x, y, cell, 0.5),
        bubbletrail: (x, y) => {
            for (let i = 0; i < 10; i++) {
                radialAt(c, x + (i + 0.5) * (cell / 10), y + cell / 2 + Math.sin(i * 1.7) * cell * 0.14,
                    cell * 0.07, [[0, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']]);
            }
        },
        scorch: (x, y) => {
            radial(c, x, y, cell, [[0, 'rgba(255,255,255,0.9)'], [0.6, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]);
            blotch(c, x, y, cell, 6, 'rgba(255,255,255,0.35)');
        },
    };

    for (const [name, idx] of Object.entries(lib.atlas.frames)) {
        const cx = (idx % cols) * cell;
        const cy = Math.floor(idx / cols) * cell;
        (painters[name] ?? painters.dot)(cx, cy);
    }

    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv as TexImageSource);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
}

/** Ribbon strips need REPEAT along U — they get standalone textures rather
 *  than atlas cells (trail.vert tiles U beyond [0,1]; see effects/README). */
export function buildTrailStrips(
    gl: WebGL2RenderingContext,
    makeCanvas: CanvasFactory = defaultCanvasFactory,
): Record<string, WebGLTexture> {
    const mk = (paint: (c: Ctx2D, w: number, h: number) => void): WebGLTexture => {
        const cv = makeCanvas(128, 32);
        const c = cv.getContext('2d') as Ctx2D;
        paint(c, cv.width, cv.height);
        const tex = gl.createTexture()!;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv as TexImageSource);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    };
    return {
        smoketrail: mk((c, w, h) => {
            const g = c.createLinearGradient(0, 0, 0, h);
            g.addColorStop(0, 'rgba(255,255,255,0)');
            g.addColorStop(0.5, 'rgba(255,255,255,0.85)');
            g.addColorStop(1, 'rgba(255,255,255,0)');
            c.fillStyle = g;
            c.fillRect(0, 0, w, h);
        }),
        bubbletrail: mk((c, w, h) => {
            for (let i = 0; i < 24; i++) {
                const x = (i / 24) * w + (i % 3);
                const y = h / 2 + Math.sin(i * 1.9) * h * 0.22;
                const r = 2 + (i % 4);
                const g = c.createRadialGradient(x, y, 0, x, y, r);
                g.addColorStop(0, 'rgba(255,255,255,0.9)');
                g.addColorStop(1, 'rgba(255,255,255,0)');
                c.fillStyle = g;
                c.beginPath();
                c.arc(x, y, r, 0, Math.PI * 2);
                c.fill();
            }
        }),
    };
}

function radial(c: Ctx2D, x: number, y: number, cell: number,
    stops: [number, string][]): void {
    radialAt(c, x + cell / 2, y + cell / 2, cell * 0.46, stops);
}

function radialAt(c: Ctx2D, cx: number, cy: number, r: number,
    stops: [number, string][]): void {
    const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [o, col] of stops) g.addColorStop(o, col);
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fill();
}

/** Cluster of soft blobs — deterministic golden-angle placement (no RNG so
 *  the placeholder art is stable across sessions/screenshots). */
function blotch(c: Ctx2D, x: number, y: number, cell: number,
    n: number, colour: string): void {
    for (let i = 0; i < n; i++) {
        const a = i * 2.39996;
        const r = cell * 0.16 * ((i * 0.618) % 1 + 0.4);
        const bx = x + cell / 2 + Math.cos(a) * cell * 0.14;
        const by = y + cell / 2 + Math.sin(a) * cell * 0.12;
        const g = c.createRadialGradient(bx, by, 0, bx, by, r);
        g.addColorStop(0, colour);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = g;
        c.beginPath();
        c.arc(bx, by, r, 0, Math.PI * 2);
        c.fill();
    }
}

function stripInCell(c: Ctx2D, x: number, y: number, cell: number, alpha: number): void {
    const g = c.createLinearGradient(x, y, x, y + cell);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(x, y, cell, cell);
}
