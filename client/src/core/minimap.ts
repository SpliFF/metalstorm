/**
 * Minimap — Babylon WebGL viewport rendering a top-down map view.
 *
 * Uses its own Engine + Scene + Canvas so it can be detached into a
 * separate browser window. Renders:
 *   - A textured quad using the same DXT1 tile atlas as the main terrain
 *   - Thin-instanced dots for each entity, coloured by team
 *   - A click handler that sends the clicked world position back to the
 *     main view (camera move) or the server (move command).
 */

import {
    Engine,
    Scene,
    FreeCamera,
    Vector3,
    Color3,
    Color4,
    Mesh,
    MeshBuilder,
    StandardMaterial,
    Matrix,
    Quaternion,
} from '@babylonjs/core';
import { EntityRenderer, type EntityMeta } from './entity-renderer.js';
import { CommandBuffer, CMD } from './command-buffer.js';
import type { Connection } from './connection.js';
import { buildMapAtlasTexture, applyWebGLTexture, type MapDimensions } from './terrain.js';

const TEAM_COLORS: [number, number, number][] = [
    [0.2, 0.53, 1.0],   // blue
    [1.0, 0.27, 0.27],  // red
    [0.27, 0.80, 0.27], // green
    [1.0, 0.80, 0.13],  // yellow
];

export interface MinimapConfig {
    /** Map width in elmos. */
    mapWidth: number;
    /** Map height (Z) in elmos. */
    mapHeight: number;
    /** HTML element to attach the minimap canvas to. */
    parentElement: HTMLElement;
    /** Canvas size in pixels. */
    size?: number;
}

export class Minimap {
    private canvas: HTMLCanvasElement;
    private engine: Engine;
    private scene: Scene;
    private camera: FreeCamera;
    private entityRenderer: EntityRenderer;
    private commandBuffer: CommandBuffer | null = null;
    private mapWidth: number;
    private mapHeight: number;
    private canvasSize: number;
    private selectedIds: Set<number> = new Set();

    private terrainQuad: Mesh | null = null;
    // One thin-instance mesh per team (colour baked into material).
    private teamMeshes: Mesh[] = [];
    // Selection ring mesh (thin-instanced white ring).
    private selectionMesh: Mesh | null = null;
    // Map id parsed out of the loadBackground URL. Used by detach() so
    // the popup viewport can fetch the same map's thumbnail as its
    // backdrop.
    private mapId: string = '';

    /** Callback to move the main camera when the minimap is clicked. */
    onCameraMove?: (x: number, z: number) => void;

    /** Cross-window sync for detached minimaps. */
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

        // Create canvas + Babylon engine
        this.canvas = document.createElement('canvas');
        this.canvas.width = this.canvasSize;
        this.canvas.height = this.canvasSize;
        this.canvas.style.cssText = `
            border: 1px solid #334; border-radius: 4px;
            cursor: crosshair; display: block;
        `;
        config.parentElement.appendChild(this.canvas);

        this.engine = new Engine(this.canvas, false, { preserveDrawingBuffer: false });
        this.scene = new Scene(this.engine);
        this.scene.clearColor = new Color4(0.04, 0.06, 0.09, 1);
        // No lighting — minimap uses unlit emissive materials so the
        // terrain texture shows up at full brightness regardless of angle.

        // Orthographic camera looking down
        this.camera = new FreeCamera('minimapCam',
            new Vector3(this.mapWidth / 2, 10000, this.mapHeight / 2), this.scene);
        this.camera.setTarget(new Vector3(this.mapWidth / 2, 0, this.mapHeight / 2));
        this.camera.mode = FreeCamera.ORTHOGRAPHIC_CAMERA;
        this.updateOrthoBounds();

        // Create selection-ring and entity placeholder meshes now so the
        // scene isn't empty before tiles arrive.
        this.initSelectionMesh();

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

    /** Update the map dimensions (called after MapData arrives). */
    setMapDimensions(widthElmos: number, heightElmos: number): void {
        this.mapWidth = widthElmos;
        this.mapHeight = heightElmos;
        this.camera.position.x = widthElmos / 2;
        this.camera.position.z = heightElmos / 2;
        this.camera.setTarget(new Vector3(widthElmos / 2, 0, heightElmos / 2));
        this.updateOrthoBounds();
    }

    private updateOrthoBounds(): void {
        // Fit the entire map in the camera frustum. Use max dimension so
        // square minimaps are never cropped.
        const half = Math.max(this.mapWidth, this.mapHeight) / 2;
        this.camera.orthoLeft = -half;
        this.camera.orthoRight = half;
        this.camera.orthoTop = half;
        this.camera.orthoBottom = -half;
    }

    /**
     * Load the terrain atlas from the lobby and build the textured quad.
     * The URL points to the lobby's /api/maps/data/{mapId} base so we can
     * reuse the same DXT1 upload path as the main terrain.
     */
    async loadBackground(mapBaseUrl: string, dims: MapDimensions): Promise<void> {
        // mapBaseUrl looks like "http://host:port/api/maps/data/<mapId>".
        // We just need the last path component for the detached viewport
        // backdrop fetch.
        const trimmed = mapBaseUrl.replace(/\/+$/, '');
        const lastSlash = trimmed.lastIndexOf('/');
        if (lastSlash >= 0) this.mapId = trimmed.substring(lastSlash + 1);

        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const gl = (this.engine as any)._gl as WebGL2RenderingContext;
            if (!gl) throw new Error('no WebGL context');

            const atlas = await buildMapAtlasTexture(gl, mapBaseUrl, dims);
            if (!atlas) throw new Error('atlas build failed');

            // Dispose any previous quad
            this.terrainQuad?.dispose();

            // Create a quad covering the whole map in world space.
            // Babylon's CreateGround gives us correct XZ orientation + UVs.
            const quad = MeshBuilder.CreateGround('minimapGround', {
                width: this.mapWidth, height: this.mapHeight,
            }, this.scene);
            quad.position.x = this.mapWidth / 2;
            quad.position.z = this.mapHeight / 2;
            applyWebGLTexture(this.scene, quad, atlas.webglTex, atlas.width, atlas.height);
            // Force emissive so the unlit minimap still shows the texture.
            const mat = quad.material as StandardMaterial;
            if (mat) {
                mat.emissiveTexture = mat.diffuseTexture;
                mat.disableLighting = true;
            }
            this.terrainQuad = quad;
            console.log('[minimap] terrain quad built');
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
        this.updateEntityInstances();
        this.scene.render();
    }

    private initSelectionMesh(): void {
        // Thin-instanced white square for the selection ring.
        // Slightly larger than the entity dots, rendered just above ground.
        const ring = MeshBuilder.CreatePlane('minimapSel', { size: 80 }, this.scene);
        ring.rotation.x = Math.PI / 2; // face up
        ring.position.y = 20;
        ring.isPickable = false;
        const mat = new StandardMaterial('minimapSelMat', this.scene);
        mat.emissiveColor = new Color3(1, 1, 1);
        mat.disableLighting = true;
        ring.material = mat;
        this.selectionMesh = ring;
    }

    private ensureTeamMesh(team: number): Mesh {
        if (this.teamMeshes[team]) return this.teamMeshes[team];
        const dot = MeshBuilder.CreatePlane(`minimapDot_${team}`, { size: 60 }, this.scene);
        dot.rotation.x = Math.PI / 2;
        dot.position.y = 10;
        dot.isPickable = false;
        const mat = new StandardMaterial(`minimapDotMat_${team}`, this.scene);
        const [r, g, b] = TEAM_COLORS[team % TEAM_COLORS.length];
        mat.emissiveColor = new Color3(r, g, b);
        mat.disableLighting = true;
        dot.material = mat;
        this.teamMeshes[team] = dot;
        return dot;
    }

    /**
     * Rebuild thin-instance buffers for entity dots + selection rings.
     * Called every render tick (~10 Hz) — cheap enough for reasonable
     * entity counts.
     */
    private updateEntityInstances(): void {
        // Bucket entities by team
        const perTeam = new Map<number, { x: number; z: number; selected: boolean }[]>();
        const selected: { x: number; z: number }[] = [];

        for (const [id, meta] of this.entityRenderer.getEntities() as IterableIterator<[number, EntityMeta]>) {
            const pos = this.entityRenderer.getEntityPosition(id);
            if (!pos) continue;
            const team = meta.team;
            let b = perTeam.get(team);
            if (!b) { b = []; perTeam.set(team, b); }
            const isSel = this.selectedIds.has(id);
            b.push({ x: pos.x, z: pos.z, selected: isSel });
            if (isSel) selected.push({ x: pos.x, z: pos.z });
        }

        // Update each team mesh's thin instances
        for (const [team, ents] of perTeam) {
            const mesh = this.ensureTeamMesh(team);
            if (ents.length === 0) {
                mesh.thinInstanceCount = 0;
                continue;
            }
            const matrices = new Float32Array(ents.length * 16);
            const rot = Quaternion.Identity();
            const scale = Vector3.One();
            for (let i = 0; i < ents.length; i++) {
                const e = ents[i];
                const m = Matrix.Compose(scale, rot, new Vector3(e.x, 10, e.z));
                m.copyToArray(matrices, i * 16);
            }
            mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
        }
        // Clear teams that now have zero entities
        for (let t = 0; t < this.teamMeshes.length; t++) {
            const mesh = this.teamMeshes[t];
            if (mesh && !perTeam.has(t)) {
                mesh.thinInstanceCount = 0;
            }
        }

        // Selection rings
        if (this.selectionMesh) {
            if (selected.length === 0) {
                this.selectionMesh.thinInstanceCount = 0;
            } else {
                const matrices = new Float32Array(selected.length * 16);
                const rot = Quaternion.Identity();
                const scale = Vector3.One();
                for (let i = 0; i < selected.length; i++) {
                    const e = selected[i];
                    const m = Matrix.Compose(scale, rot, new Vector3(e.x, 20, e.z));
                    m.copyToArray(matrices, i * 16);
                }
                this.selectionMesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
            }
        }
    }

    /// The detached viewport popup, if the user has opened one. We
    /// keep the handle around so `dispose()` can actively close it
    /// when the main window leaves the game — without this the
    /// popup stays alive as an orphaned WebSocket to a game server
    /// that's either stopped or now belongs to a different room.
    private detachedWindow: Window | null = null;

    /** Open this minimap in a detached browser window. */
    detach(): Window | null {
        // If a popup is already open from a previous detach(), reuse
        // it rather than stacking a second one. window.open() with
        // the same target name reloads the existing popup in place.
        const token = localStorage.getItem('springrts-session-token') ?? '';
        // The detached viewport needs to connect to the *game server*, not
        // the lobby — otherwise it authenticates fine but never receives
        // any entity state. startGame() persists the game server port to
        // localStorage; pass it through as a URL param for the viewport
        // page to consume.
        const gamePort = localStorage.getItem('springrts-game-port') ?? '';
        const params = new URLSearchParams({
            mapW: String(this.mapWidth),
            mapH: String(this.mapHeight),
            token,
        });
        if (gamePort) params.set('port', gamePort);
        // Pass the map id so the viewport can fetch the same thumbnail
        // we use in the lobby browser as its backdrop. Without this it
        // renders entities on a black grid with no terrain context.
        if (this.mapId) params.set('mapId', this.mapId);
        const url = `/viewport.html?${params.toString()}`;
        this.detachedWindow = window.open(url, 'springrts-minimap',
            `width=${this.canvasSize + 20},height=${this.canvasSize + 20},resizable=yes`);
        return this.detachedWindow;
    }

    private handleClick(e: MouseEvent): void {
        const rect = this.canvas.getBoundingClientRect();
        // Canvas-space coordinates
        const cx = (e.clientX - rect.left) / rect.width;
        const cz = (e.clientY - rect.top) / rect.height;
        // Map canvas coords to world space. The ortho camera is centred
        // on the map, so 0..1 → full map extent.
        const mx = cx * this.mapWidth;
        const mz = cz * this.mapHeight;

        if (e.button === 0) {
            // Left click — move main camera to this position
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
        // Tell any detached viewport popup to close itself. We send
        // the broadcast *before* closing our own channel so the
        // message actually goes out — BroadcastChannel is fire-and-
        // forget, but closing the channel in the same tick
        // sometimes swallows the final post on Chrome. Also try the
        // direct `window.close()` path as a backup; popups that
        // were opened by this same window are allowed to be closed
        // by it without requiring user interaction.
        this.channel?.postMessage({ type: 'gameEnded' });
        if (this.detachedWindow && !this.detachedWindow.closed) {
            try { this.detachedWindow.close(); } catch { /* cross-origin or gone */ }
        }
        this.detachedWindow = null;

        this.scene.dispose();
        this.engine.dispose();
        this.canvas.remove();
        this.commandBuffer?.dispose();
        this.channel?.close();
    }
}
