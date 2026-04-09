/**
 * Minimap — 2D canvas rendering unit positions on a heightmap background.
 *
 * Functions as a battlefield overview. Click to move camera, right-click
 * to issue commands. Can be detached as a separate browser window.
 *
 * Renders on a 2D HTML canvas (not WebGL) for lightweight performance.
 * Receives entity data from the same EntityRenderer that feeds the 3D view.
 */

import { EntityRenderer, type EntityMeta } from './entity-renderer.js';
import { CommandBuffer, CMD } from './command-buffer.js';
import type { Connection } from './connection.js';

// Re-export for minimap to decode BC1 from KTX2
const KTX2_MAGIC = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];

const TEAM_COLORS = ['#3388ff', '#ff4444', '#44cc44', '#ffcc22'];

export interface MinimapConfig {
    /** Map width in elmos. */
    mapWidth: number;
    /** Map height (Z) in elmos. */
    mapHeight: number;
    /** HTML element to attach the minimap to. */
    parentElement: HTMLElement;
    /** Canvas size in pixels. */
    size?: number;
}

export class Minimap {
    private canvas: HTMLCanvasElement;
    private ctx: CanvasRenderingContext2D;
    private entityRenderer: EntityRenderer;
    private commandBuffer: CommandBuffer | null = null;
    private mapWidth: number;
    private mapHeight: number;
    private canvasSize: number;
    private selectedIds: Set<number> = new Set();
    private backgroundImage: ImageBitmap | null = null;

    // Callback to move the main camera
    onCameraMove?: (x: number, z: number) => void;

    // BroadcastChannel for cross-window sync
    private channel: BroadcastChannel | null = null;

    constructor(
        config: MinimapConfig,
        entityRenderer: EntityRenderer,
        connection?: Connection,
    ) {
        this.entityRenderer = entityRenderer;
        this.mapWidth = config.mapWidth;
        this.mapHeight = config.mapHeight;
        this.canvasSize = config.size ?? 256;

        if (connection) {
            this.commandBuffer = new CommandBuffer(connection);
        }

        // Create canvas
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.canvasSize;
        this.canvas.height = this.canvasSize;
        this.canvas.style.cssText = `
            border: 1px solid #334; border-radius: 4px;
            cursor: crosshair; image-rendering: pixelated;
        `;
        this.ctx = this.canvas.getContext('2d')!;
        config.parentElement.appendChild(this.canvas);

        // Input handlers
        this.canvas.addEventListener('mousedown', (e) => this.handleClick(e));
        this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

        // Cross-window sync
        try {
            this.channel = new BroadcastChannel('springrts-game');
            this.channel.onmessage = (e) => this.handleBroadcast(e);
        } catch {
            // BroadcastChannel not available
        }
    }

    /** Load the minimap background image from a KTX2 file URL. */
    async loadBackground(url: string): Promise<void> {
        try {
            const resp = await fetch(url);
            if (!resp.ok) return;
            const buf = await resp.arrayBuffer();
            const view = new DataView(buf);

            // Verify KTX2 magic
            for (let i = 0; i < 12; i++) {
                if (view.getUint8(i) !== KTX2_MAGIC[i]) return;
            }
            const width = view.getUint32(20, true);
            const height = view.getUint32(24, true);
            const dataOffset = Number(view.getBigUint64(80, true));
            const dataLength = Number(view.getBigUint64(88, true));
            const bc1 = new Uint8Array(buf, dataOffset, dataLength);

            // Decode BC1 to RGBA
            const rgba = new Uint8ClampedArray(width * height * 4);
            const bw = width >> 2, bh = height >> 2;
            for (let by = 0; by < bh; by++) {
                for (let bx = 0; bx < bw; bx++) {
                    const off = (by * bw + bx) * 8;
                    const c0 = bc1[off] | (bc1[off+1] << 8);
                    const c1 = bc1[off+2] | (bc1[off+3] << 8);
                    const bits = bc1[off+4] | (bc1[off+5]<<8) | (bc1[off+6]<<16) | ((bc1[off+7]<<24)>>>0);
                    const r = (c: number) => ((c>>11)&0x1f)*255/31;
                    const g = (c: number) => ((c>>5)&0x3f)*255/63;
                    const b = (c: number) => (c&0x1f)*255/31;
                    const colors = [
                        [r(c0),g(c0),b(c0)], [r(c1),g(c1),b(c1)],
                        c0>c1 ? [0,0,0].map((_,i)=>(2*[r(c0),g(c0),b(c0)][i]+[r(c1),g(c1),b(c1)][i])/3) : [0,0,0].map((_,i)=>([r(c0),g(c0),b(c0)][i]+[r(c1),g(c1),b(c1)][i])/2),
                        c0>c1 ? [0,0,0].map((_,i)=>([r(c0),g(c0),b(c0)][i]+2*[r(c1),g(c1),b(c1)][i])/3) : [0,0,0],
                    ];
                    for (let py=0;py<4;py++) for (let px=0;px<4;px++) {
                        const idx = (bits>>(2*(py*4+px)))&3;
                        const x=bx*4+px, y=by*4+py, o=(y*width+x)*4;
                        rgba[o]=colors[idx][0]; rgba[o+1]=colors[idx][1]; rgba[o+2]=colors[idx][2]; rgba[o+3]=255;
                    }
                }
            }

            const imageData = new ImageData(rgba, width, height);
            this.backgroundImage = await createImageBitmap(imageData);
            console.log(`[minimap] background loaded: ${width}x${height}`);
        } catch (e) {
            console.warn('[minimap] failed to load background:', e);
        }
    }

    /** Update selection highlight (called when main view selection changes). */
    setSelection(ids: number[]): void {
        this.selectedIds = new Set(ids);
        // Broadcast to other windows
        this.channel?.postMessage({ type: 'selection', unitIds: ids });
    }

    /** Render the minimap. Call at ~10Hz. */
    render(): void {
        const ctx = this.ctx;
        const w = this.canvasSize;
        const h = this.canvasSize;
        const scaleX = w / this.mapWidth;
        const scaleZ = h / this.mapHeight;

        // Background — minimap image or dark fallback
        if (this.backgroundImage) {
            ctx.drawImage(this.backgroundImage, 0, 0, w, h);
        } else {
            ctx.fillStyle = '#0a0f0a';
            ctx.fillRect(0, 0, w, h);
        }

        // Draw entities
        for (const [id, meta] of this.entityRenderer.getEntities()) {
            const pos = this.entityRenderer.getEntityPosition(id);
            if (!pos) continue;

            const px = pos.x * scaleX;
            const pz = pos.z * scaleZ;
            const teamColor = TEAM_COLORS[meta.team % TEAM_COLORS.length];
            const isSelected = this.selectedIds.has(id);

            // Selection ring
            if (isSelected) {
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(px, pz, 5, 0, Math.PI * 2);
                ctx.stroke();
            }

            // Unit dot
            ctx.fillStyle = teamColor;
            ctx.beginPath();
            ctx.arc(px, pz, isSelected ? 3 : 2, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    /** Open this minimap in a detached browser window. */
    detach(): Window | null {
        const token = localStorage.getItem('springrts-session-token') ?? '';
        const url = `/viewport.html?mapW=${this.mapWidth}&mapH=${this.mapHeight}&token=${encodeURIComponent(token)}`;
        return window.open(url, 'springrts-minimap',
            `width=${this.canvasSize + 20},height=${this.canvasSize + 20},resizable=yes`);
    }

    private handleClick(e: MouseEvent): void {
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.offsetX / rect.width * this.mapWidth;
        const mz = e.offsetY / rect.height * this.mapHeight;

        if (e.button === 0) {
            // Left click — move camera to this position
            this.onCameraMove?.(mx, mz);
            this.channel?.postMessage({ type: 'focusPosition', x: mx, z: mz });
        } else if (e.button === 2 && this.commandBuffer) {
            // Right click — issue move command to selected units
            const ids = Array.from(this.selectedIds);
            if (ids.length > 0) {
                this.commandBuffer.issueImmediate(CMD.MOVE, ids, [mx, 0, mz],
                    e.shiftKey ? 32 : 0);
            }
        }
    }

    private handleBroadcast(e: MessageEvent): void {
        const data = e.data;
        if (data.type === 'selection') {
            this.selectedIds = new Set(data.unitIds);
        } else if (data.type === 'focusPosition') {
            this.onCameraMove?.(data.x, data.z);
        }
    }

    dispose(): void {
        this.canvas.remove();
        this.commandBuffer?.dispose();
        this.channel?.close();
    }
}
