/**
 * LuaWidgetManager — Main-thread proxy for the LuaUI Web Worker.
 *
 * The heavy Lua work (fengari, VFS, bootstrap, widget callins) runs in a
 * Web Worker to avoid blocking the main thread. This class:
 *   - Creates a transparent overlay canvas for 2D widget UI (DrawScreen)
 *   - Transfers it to the worker as an OffscreenCanvas
 *   - Forwards keyboard events to the worker
 *   - Receives log messages and routes them to the debug console
 *   - Provides the F9 widget list overlay
 *
 * World-space rendering (DrawWorld, DrawWorldPreUnit) will use a command
 * buffer replayed on the Babylon GL context — not yet implemented.
 */
import type { Scene } from '@babylonjs/core/scene';
import type { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import type { ParsedMapData } from './map-data.js';
import { debugConsole } from './debug-console.js';

// Vite worker import — bundles the worker as a separate chunk
import WidgetWorker from './lua-widget-worker.ts?worker';

// ── Types ───────────────────────────────────────────────────────────────

export interface WidgetManagerOptions {
    gameId: string;
    /** Base URL for game data (e.g. http://localhost:8011) */
    lobbyUrl: string;
}

// ── Main class ──────────────────────────────────────────────────────────

export class LuaWidgetManager {
    private scene: Scene;
    private camera: FreeCamera;
    private map: ParsedMapData;
    private options: WidgetManagerOptions;

    private worker: Worker | null = null;
    private overlayCanvas: HTMLCanvasElement | null = null;
    private keyHandler: ((e: KeyboardEvent) => void) | null = null;
    private keyUpHandler: ((e: KeyboardEvent) => void) | null = null;
    private widgetListOverlay: HTMLDivElement | null = null;

    /** Last widget list data received from worker */
    private lastWidgetData = '';
    private ready = false;
    private fileCount = 0;

    /** Input listeners registered based on worker-reported callins */
    private inputCleanups: (() => void)[] = [];
    /** Last known mouse position for delta calculation */
    private lastMouseX = 0;
    private lastMouseY = 0;

    constructor(
        scene: Scene,
        camera: FreeCamera,
        map: ParsedMapData,
        options: WidgetManagerOptions,
    ) {
        this.scene = scene;
        this.camera = camera;
        this.map = map;
        this.options = options;
    }

    // ── Main entry point ────────────────────────────────────────────────

    async initialize(): Promise<void> {
        // 1. Create transparent overlay canvas for 2D widget UI
        const canvas = this.createOverlayCanvas();

        // 2. Transfer to OffscreenCanvas
        const offscreen = canvas.transferControlToOffscreen();

        // 3. Start worker
        this.worker = new WidgetWorker();
        this.worker.onmessage = (e) => this.onWorkerMessage(e);
        this.worker.onerror = (e) => {
            console.error('[LuaUI] Worker error:', e.message);
        };

        // 4. Send init message with canvas and map data
        const mapData = {
            mapx: this.map.mapx,
            mapy: this.map.mapy,
            squareSize: this.map.squareSize,
            minHeight: this.map.minHeight,
            maxHeight: this.map.maxHeight,
            widthElmos: this.map.widthElmos,
            heightElmos: this.map.heightElmos,
            heightmap: this.map.heightmap,
            mapSourceUrl: this.map.mapSourceUrl,
        };

        this.worker.postMessage({
            type: 'init',
            canvas: offscreen,
            gameId: this.options.gameId,
            lobbyUrl: this.options.lobbyUrl,
            mapData,
        }, [offscreen, mapData.heightmap.buffer]);

        // 5. Setup keyboard forwarding + F9 widget list
        this.setupKeyboard();

        // 6. Expose debug API
        (window as any).widgets = this.buildWindowAPI();
    }

    // ── Overlay canvas ──────────────────────────────────────────────────

    private createOverlayCanvas(): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.id = 'luaui-overlay';
        canvas.style.cssText = `
            position: absolute;
            top: 0; left: 0;
            width: 100%; height: 100%;
            pointer-events: none;
            z-index: 100;
        `;

        // Match the main canvas size
        const mainCanvas = this.scene.getEngine().getRenderingCanvas();
        if (mainCanvas) {
            canvas.width = mainCanvas.width;
            canvas.height = mainCanvas.height;
        } else {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }

        // Insert after the main canvas
        const container = mainCanvas?.parentElement ?? document.body;
        container.appendChild(canvas);
        this.overlayCanvas = canvas;

        // Resize observer — after transferControlToOffscreen() the main thread
        // can't set canvas.width/height directly, so we only notify the worker.
        const ro = new ResizeObserver(() => {
            const w = mainCanvas?.width ?? window.innerWidth;
            const h = mainCanvas?.height ?? window.innerHeight;
            this.worker?.postMessage({ type: 'resize', width: w, height: h });
        });
        if (mainCanvas) ro.observe(mainCanvas);

        return canvas;
    }

    // ── Worker message handling ──────────────────────────────────────────

    private onWorkerMessage(e: MessageEvent): void {
        const msg = e.data;
        switch (msg.type) {
            case 'log':
                console.log(`[LuaUI]`, msg.msg);
                debugConsole.addEntry({
                    id: Date.now(),
                    timestamp: Date.now() / 1000,
                    level: msg.level ?? 2,
                    section: 'lua',
                    scope: 'LuaUI',
                    process: 'client',
                    message: msg.msg,
                    frame: 0,
                });
                break;

            case 'ready':
                this.ready = true;
                this.fileCount = msg.fileCount;
                console.log(`[LuaUI] Worker ready, ${msg.fileCount} VFS files`);
                if (msg.callins) {
                    this.registerInputListeners(msg.callins as string[]);
                }
                break;

            case 'widgetList':
                this.lastWidgetData = msg.data;
                this.renderWidgetList(msg.data);
                break;

            case 'storage:set':
                try {
                    localStorage.setItem(msg.key, msg.value);
                } catch { /* silent */ }
                break;

            case 'error':
                console.error('[LuaUI] Worker error:', msg.msg);
                break;

            case 'worldGLCommands':
                // TODO: replay command buffer on Babylon GL context
                break;
        }
    }

    // ── Keyboard ────────────────────────────────────────────────────────

    private setupKeyboard(): void {
        this.keyHandler = (e: KeyboardEvent) => {
            // F9 toggles widget list (F11 is macOS fullscreen)
            if (e.key === 'F9' && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault();
                this.toggleWidgetList();
                return;
            }

            // Forward keyboard events to worker
            const tag = (e.target as HTMLElement)?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            if (e.type === 'keydown') {
                this.worker?.postMessage({
                    type: 'keypress',
                    keyCode: springKeyCode(e),
                    alt: e.altKey,
                    ctrl: e.ctrlKey,
                    meta: e.metaKey,
                    shift: e.shiftKey,
                });
            }
        };
        window.addEventListener('keydown', this.keyHandler);
    }

    // ── Dynamic input listeners ────────────────────────────────────────
    //
    // Only registered when the worker reports widgets using those callins.
    // This avoids sending high-frequency events (MouseMove) across the
    // bridge when no widget cares about them.

    private registerInputListeners(callins: string[]): void {
        const canvas = this.scene.getEngine().getRenderingCanvas();
        if (!canvas) return;

        const has = (name: string) => callins.includes(name);
        console.log(`[LuaUI] Registering input for callins: ${callins.join(', ')}`);

        // KeyRelease
        if (has('KeyRelease')) {
            this.keyUpHandler = (e: KeyboardEvent) => {
                const tag = (e.target as HTMLElement)?.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                this.worker?.postMessage({
                    type: 'keyrelease',
                    keyCode: springKeyCode(e),
                    alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey,
                });
            };
            window.addEventListener('keyup', this.keyUpHandler);
            this.inputCleanups.push(() => {
                if (this.keyUpHandler) window.removeEventListener('keyup', this.keyUpHandler);
            });
        }

        // MousePress
        if (has('MousePress')) {
            const handler = (e: MouseEvent) => {
                this.worker?.postMessage({
                    type: 'mousepress',
                    x: e.offsetX, y: canvas.height - e.offsetY, // Spring Y is bottom-up
                    button: domButtonToSpring(e.button),
                });
            };
            canvas.addEventListener('mousedown', handler);
            this.inputCleanups.push(() => canvas.removeEventListener('mousedown', handler));
        }

        // MouseRelease
        if (has('MouseRelease')) {
            const handler = (e: MouseEvent) => {
                this.worker?.postMessage({
                    type: 'mouserelease',
                    x: e.offsetX, y: canvas.height - e.offsetY,
                    button: domButtonToSpring(e.button),
                });
            };
            canvas.addEventListener('mouseup', handler);
            this.inputCleanups.push(() => canvas.removeEventListener('mouseup', handler));
        }

        // MouseWheel
        if (has('MouseWheel')) {
            const handler = (e: WheelEvent) => {
                this.worker?.postMessage({
                    type: 'mousewheel',
                    up: e.deltaY < 0,
                    value: Math.abs(e.deltaY),
                });
            };
            canvas.addEventListener('wheel', handler);
            this.inputCleanups.push(() => canvas.removeEventListener('wheel', handler));
        }

        // MouseMove — only if widgets actually use it (high frequency)
        if (has('MouseMove') || has('IsAbove')) {
            const handler = (e: MouseEvent) => {
                const x = e.offsetX;
                const y = canvas.height - e.offsetY;
                const dx = x - this.lastMouseX;
                const dy = y - this.lastMouseY;
                this.lastMouseX = x;
                this.lastMouseY = y;
                this.worker?.postMessage({
                    type: 'mousemove',
                    x, y, dx, dy,
                    button: e.buttons ? domButtonToSpring(e.button) : 0,
                });
            };
            canvas.addEventListener('mousemove', handler);
            this.inputCleanups.push(() => canvas.removeEventListener('mousemove', handler));
        }
    }

    // ── Widget list overlay (F9) ────────────────────────────────────────

    private toggleWidgetList(): void {
        if (this.widgetListOverlay) {
            this.widgetListOverlay.remove();
            this.widgetListOverlay = null;
            return;
        }
        // Request fresh data from worker
        this.worker?.postMessage({ type: 'getWidgetList' });
        // If we have cached data, show immediately; it'll update when worker responds
        if (this.lastWidgetData) {
            this.renderWidgetList(this.lastWidgetData);
        }
    }

    private renderWidgetList(dataStr: string): void {
        // Remove existing overlay if open
        if (this.widgetListOverlay) {
            this.widgetListOverlay.remove();
        }

        const overlay = document.createElement('div');
        overlay.id = 'widget-list-overlay';
        overlay.innerHTML = WIDGET_LIST_HTML;
        document.body.appendChild(overlay);
        this.widgetListOverlay = overlay;

        const listEl = overlay.querySelector('.wl-entries')!;
        let countActive = 0, countFailed = 0, countDisabled = 0, countTotal = 0;

        if (dataStr) {
            const lines = dataStr.split('\n').filter(Boolean);
            const sorted = lines.sort((a, b) => {
                const order: Record<string, number> = { active: 0, disabled: 1, failed: 2 };
                return (order[a.split('|')[0]] ?? 3) - (order[b.split('|')[0]] ?? 3);
            });
            for (const line of sorted) {
                const parts = line.split('|');
                const status = parts[0];
                let name = parts[1] || '';
                const author = parts[2] || '';
                const error = parts[4] || '';
                countTotal++;

                if (!name && error) {
                    const match = error.match(/Failed to load:\s+(\S+)/);
                    name = match?.[1] ?? '(unknown)';
                }

                const row = document.createElement('div');
                row.className = `wl-entry wl-${status}`;

                const dot = document.createElement('span');
                dot.className = 'wl-dot';
                dot.textContent = status === 'active' ? '\u25cf'
                    : status === 'failed' ? '\u25cf' : '\u25cb';
                row.appendChild(dot);

                const nameEl = document.createElement('span');
                nameEl.className = 'wl-name';
                nameEl.textContent = name;
                row.appendChild(nameEl);

                if (author) {
                    const authorEl = document.createElement('span');
                    authorEl.className = 'wl-author';
                    authorEl.textContent = `by ${author}`;
                    row.appendChild(authorEl);
                }

                if (error) {
                    const errEl = document.createElement('div');
                    errEl.className = 'wl-error';
                    errEl.textContent = error.substring(0, 200);
                    row.appendChild(errEl);
                }

                listEl.appendChild(row);

                if (status === 'active') countActive++;
                else if (status === 'failed') countFailed++;
                else countDisabled++;
            }
        }

        const header = overlay.querySelector('.wl-header-count');
        if (header) {
            header.textContent = `${countActive} active, ${countDisabled} disabled, ${countFailed} failed`;
        }

        overlay.querySelector('.wl-close')?.addEventListener('click', () => {
            this.toggleWidgetList();
        });
    }

    // ── window.widgets API ──────────────────────────────────────────────

    private buildWindowAPI() {
        const mgr = this;
        return {
            list() { mgr.toggleWidgetList(); },
            get ready() { return mgr.ready; },
            get vfsFileCount() { return mgr.fileCount; },
        };
    }

    // ── Cleanup ─────────────────────────────────────────────────────────

    dispose(): void {
        if (this.keyHandler) {
            window.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }
        if (this.keyUpHandler) {
            window.removeEventListener('keyup', this.keyUpHandler);
            this.keyUpHandler = null;
        }
        for (const cleanup of this.inputCleanups) cleanup();
        this.inputCleanups = [];

        if (this.widgetListOverlay) {
            this.widgetListOverlay.remove();
            this.widgetListOverlay = null;
        }
        if (this.worker) {
            this.worker.postMessage({ type: 'shutdown' });
            this.worker.terminate();
            this.worker = null;
        }
        if (this.overlayCanvas) {
            this.overlayCanvas.remove();
            this.overlayCanvas = null;
        }
        delete (window as any).widgets;
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** DOM MouseEvent.button → Spring button (1=left, 2=middle, 3=right) */
function domButtonToSpring(button: number): number {
    switch (button) {
        case 0: return 1; // left
        case 1: return 2; // middle
        case 2: return 3; // right
        default: return button + 1;
    }
}

function springKeyCode(e: KeyboardEvent): number {
    const map: Record<string, number> = {
        'Backspace': 8, 'Tab': 9, 'Enter': 13, 'Escape': 27, ' ': 32,
        'Delete': 127, 'ArrowLeft': 276, 'ArrowRight': 275,
        'ArrowUp': 273, 'ArrowDown': 274, 'Home': 278, 'End': 279,
        'PageUp': 280, 'PageDown': 281, 'Insert': 277,
        'F1': 282, 'F2': 283, 'F3': 284, 'F4': 285, 'F5': 286,
        'F6': 287, 'F7': 288, 'F8': 289, 'F9': 290, 'F10': 291,
        'F11': 292, 'F12': 293,
    };
    if (map[e.key]) return map[e.key];
    if (e.key.length === 1) return e.key.toLowerCase().charCodeAt(0);
    return 0;
}

// ── Widget list overlay HTML/CSS ───────────────────────────────────────

const WIDGET_LIST_HTML = `
<style>
#widget-list-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 10000;
    background: rgba(0,0,0,0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Consolas', 'Monaco', monospace;
    color: #ccc;
}
.wl-panel {
    background: #1a1a2e;
    border: 1px solid #444;
    border-radius: 6px;
    width: 700px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.wl-title-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid #333;
    background: #16213e;
    border-radius: 6px 6px 0 0;
}
.wl-title {
    font-size: 14px;
    font-weight: bold;
    color: #e0e0e0;
}
.wl-header-count {
    font-size: 11px;
    color: #888;
}
.wl-close {
    cursor: pointer;
    color: #888;
    font-size: 18px;
    border: none;
    background: none;
    padding: 2px 6px;
}
.wl-close:hover { color: #fff; }
.wl-entries {
    overflow-y: auto;
    padding: 8px;
    max-height: calc(80vh - 50px);
}
.wl-entry {
    padding: 4px 8px;
    margin: 1px 0;
    border-radius: 3px;
    font-size: 12px;
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
}
.wl-entry:hover { background: rgba(255,255,255,0.05); }
.wl-dot { width: 12px; flex-shrink: 0; }
.wl-active .wl-dot { color: #4caf50; }
.wl-failed .wl-dot { color: #f44336; }
.wl-disabled .wl-dot { color: #666; }
.wl-name { color: #e0e0e0; font-weight: bold; }
.wl-active .wl-name { color: #81c784; }
.wl-failed .wl-name { color: #ef9a9a; }
.wl-author { color: #888; font-size: 11px; }
.wl-error {
    width: 100%;
    color: #e57373;
    font-size: 10px;
    padding-left: 20px;
    word-break: break-all;
}
</style>
<div class="wl-panel">
    <div class="wl-title-bar">
        <div>
            <span class="wl-title">LuaUI Widgets</span>
            <span class="wl-header-count"></span>
        </div>
        <button class="wl-close">&times;</button>
    </div>
    <div class="wl-entries"></div>
</div>
`;
