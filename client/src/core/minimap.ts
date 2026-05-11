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
import { Texture } from '@babylonjs/core';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { EntityRenderer, type EntityMeta } from './entity-renderer.js';
import type { LosBitmap } from './los-bitmap.js';
import { CommandBuffer, CMD } from './command-buffer.js';
import type { Connection } from './connection.js';
import type { MapDimensions } from './terrain.js';

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
    // Fog-of-war overlay: a textured plane above the terrain, populated
    // from the per-allyteam LOS bitmap stream (envelope 0x07). The
    // texture is a tiny RGBA canvas the size of the bitmap (<=64×64)
    // that gets rewritten when a new snapshot arrives — Babylon then
    // samples it with bilinear filtering across the minimap quad, so
    // the edge of the fog looks smooth rather than chunky despite the
    // low-resolution source. Allocated lazily on the first bitmap.
    private fogQuad: Mesh | null = null;
    private fogTexture: DynamicTexture | null = null;
    private fogBitmapSize: { w: number; h: number } = { w: 0, h: 0 };
    // One thin-instance mesh per team (colour baked into material).
    private teamMeshes: Mesh[] = [];
    // Per-team dimmed-blip mesh for radar-only enemy contacts. Smaller
    // and translucent so the player can tell radar from LOS at a glance.
    private radarMeshes: Mesh[] = [];
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
     * Load the minimap backdrop texture and build the textured quad.
     * Uses the preprocessed `minimap.ktx2` (UASTC-encoded SMF minimap)
     * — no per-tile atlas compositing needed for the minimap, since
     * the standalone 1024x1024 image already covers the whole map.
     */
    async loadBackground(mapBaseUrl: string, _dims: MapDimensions): Promise<void> {
        // mapBaseUrl looks like "http://host:port/api/maps/data/<mapId>".
        // We just need the last path component for the detached viewport
        // backdrop fetch.
        const trimmed = mapBaseUrl.replace(/\/+$/, '');
        const lastSlash = trimmed.lastIndexOf('/');
        if (lastSlash >= 0) this.mapId = trimmed.substring(lastSlash + 1);

        try {
            this.terrainQuad?.dispose();

            const quad = MeshBuilder.CreateGround('minimapGround', {
                width: this.mapWidth, height: this.mapHeight,
            }, this.scene);
            quad.position.x = this.mapWidth / 2;
            quad.position.z = this.mapHeight / 2;

            const tex = new Texture(`${mapBaseUrl}/minimap.ktx2`, this.scene);
            const mat = new StandardMaterial('minimapMat', this.scene);
            mat.diffuseTexture = tex;
            mat.emissiveTexture = tex;
            mat.disableLighting = true;
            quad.material = mat;

            this.terrainQuad = quad;
            console.log('[minimap] backdrop loaded from minimap.ktx2');
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

    /** Apply a per-allyteam fog-of-war snapshot. Called from main.ts
     *  whenever the connection delivers an `ENVELOPE_LOS_BITMAP` frame
     *  (~1 Hz) for the local viewer's ally team. Spectators receive
     *  multiple ally teams round-robin — we use the *most recent* one
     *  for the overlay so the spec sees one team's vision at a time.
     *
     *  Tint scheme (alpha on a black overlay):
     *    inLos                → no overlay
     *    inRadar && !inLos    → 35% black
     *    explored & !inRadar  → 60% black
     *    !explored            → 100% black
     */
    applyLosBitmap(bitmap: LosBitmap): void {
        const { width, height, inLos, inRadar, explored } = bitmap;
        if (width === 0 || height === 0) return;

        // (Re)allocate the texture if dimensions changed.
        if (!this.fogTexture
            || this.fogBitmapSize.w !== width
            || this.fogBitmapSize.h !== height)
        {
            this.fogTexture?.dispose();
            this.fogTexture = new DynamicTexture(
                'minimapFog',
                { width, height },
                this.scene,
                false,
            );
            this.fogTexture.hasAlpha = true;
            this.fogTexture.wrapU = Texture.CLAMP_ADDRESSMODE;
            this.fogTexture.wrapV = Texture.CLAMP_ADDRESSMODE;
            this.fogBitmapSize = { w: width, h: height };

            if (!this.fogQuad) {
                const quad = MeshBuilder.CreateGround('minimapFog', {
                    width: this.mapWidth, height: this.mapHeight,
                }, this.scene);
                quad.position.x = this.mapWidth / 2;
                quad.position.z = this.mapHeight / 2;
                // Just above the terrain quad and below the entity dots
                // (terrain at y=0, dots at y=8..20). Avoids z-fighting
                // and keeps the dots crisp on top of the fog.
                quad.position.y = 2;
                quad.isPickable = false;
                const mat = new StandardMaterial('minimapFogMat', this.scene);
                mat.emissiveTexture = this.fogTexture;
                mat.diffuseColor = new Color3(0, 0, 0);
                mat.emissiveColor = new Color3(1, 1, 1);
                mat.disableLighting = true;
                mat.useAlphaFromDiffuseTexture = false;
                mat.opacityTexture = this.fogTexture;
                mat.backFaceCulling = false;
                quad.material = mat;
                this.fogQuad = quad;
            } else {
                const mat = this.fogQuad.material as StandardMaterial;
                mat.emissiveTexture = this.fogTexture;
                mat.opacityTexture = this.fogTexture;
            }
        }

        // Repaint the texture from the three planes.
        const ctx = this.fogTexture.getContext() as CanvasRenderingContext2D;
        const img = ctx.createImageData(width, height);
        const data = img.data;
        for (let row = 0; row < height; ++row) {
            for (let col = 0; col < width; ++col) {
                const idx = row * width + col;
                const byte = idx >> 3;
                const bit = 7 - (idx & 7);
                const mask = 1 << bit;
                const losBit   = (inLos[byte]    & mask) !== 0;
                const radarBit = (inRadar[byte]  & mask) !== 0;
                const expBit   = (explored[byte] & mask) !== 0;
                let alpha255 = 255;
                if (losBit)              alpha255 = 0;
                else if (radarBit)       alpha255 = Math.round(0.35 * 255);
                else if (expBit)         alpha255 = Math.round(0.60 * 255);
                // alpha255 stays 255 for unexplored squares.
                const o = idx * 4;
                data[o    ] = 0;     // R — black overlay
                data[o + 1] = 0;     // G
                data[o + 2] = 0;     // B
                data[o + 3] = alpha255;
            }
        }
        ctx.putImageData(img, 0, 0);
        this.fogTexture.update(false);
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

    /** Dimmer half-scale variant of the team dot for radar-only and
     *  ghost contacts — so the player can tell at a glance which dots
     *  are confirmed sightings vs sensor blips. */
    private ensureRadarMesh(team: number): Mesh {
        if (this.radarMeshes[team]) return this.radarMeshes[team];
        const dot = MeshBuilder.CreatePlane(`minimapRadar_${team}`, { size: 36 }, this.scene);
        dot.rotation.x = Math.PI / 2;
        dot.position.y = 8;
        dot.isPickable = false;
        const mat = new StandardMaterial(`minimapRadarMat_${team}`, this.scene);
        const [r, g, b] = TEAM_COLORS[team % TEAM_COLORS.length];
        // ~45% brightness so the dim variant reads as "uncertain" without
        // being invisible against the dark backdrop.
        mat.emissiveColor = new Color3(r * 0.45, g * 0.45, b * 0.45);
        mat.disableLighting = true;
        mat.alpha = 0.7;
        dot.material = mat;
        this.radarMeshes[team] = dot;
        return dot;
    }

    /**
     * Rebuild thin-instance buffers for entity dots + selection rings.
     * Called every render tick (~10 Hz) — cheap enough for reasonable
     * entity counts.
     */
    private updateEntityInstances(): void {
        // Bucket entities by team and by visibility tier:
        //   - perTeam       : full-LOS dot (or own units / permissive sessions)
        //   - perTeamRadar  : dim half-size dot for radar-only / ghost contacts
        // Hidden contacts (los === 0) are skipped entirely so the minimap
        // doesn't leak ground-truth positions of fog-of-war enemies.
        const perTeam = new Map<number, { x: number; z: number }[]>();
        const perTeamRadar = new Map<number, { x: number; z: number }[]>();
        const selected: { x: number; z: number }[] = [];

        for (const [id, meta] of this.entityRenderer.getEntities() as IterableIterator<[number, EntityMeta]>) {
            const pos = this.entityRenderer.getEntityPosition(id);
            if (!pos) continue;
            const los = meta.losState;
            if (los === 0) continue; // fog of war
            const team = meta.team;
            const inLos = (los & 0x01) !== 0;
            const bucket = inLos ? perTeam : perTeamRadar;
            let b = bucket.get(team);
            if (!b) { b = []; bucket.set(team, b); }
            b.push({ x: pos.x, z: pos.z });
            // Selection rings only for confirmed-LOS contacts (the only
            // ones the player can actually click & order anyway).
            if (inLos && this.selectedIds.has(id)) {
                selected.push({ x: pos.x, z: pos.z });
            }
        }

        // Update each team mesh's thin instances (full-LOS bucket)
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

        // Radar-only / ghost bucket — same per-team breakdown, dim mesh.
        for (const [team, ents] of perTeamRadar) {
            const mesh = this.ensureRadarMesh(team);
            const matrices = new Float32Array(ents.length * 16);
            const rot = Quaternion.Identity();
            const scale = Vector3.One();
            for (let i = 0; i < ents.length; i++) {
                const e = ents[i];
                const m = Matrix.Compose(scale, rot, new Vector3(e.x, 8, e.z));
                m.copyToArray(matrices, i * 16);
            }
            mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
        }
        for (let t = 0; t < this.radarMeshes.length; t++) {
            const mesh = this.radarMeshes[t];
            if (mesh && !perTeamRadar.has(t)) {
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
    /// popup stays alive as an orphaned connection to a game server
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

        this.fogTexture?.dispose();
        this.fogTexture = null;
        this.fogQuad?.dispose();
        this.fogQuad = null;
        this.scene.dispose();
        this.engine.dispose();
        this.canvas.remove();
        this.commandBuffer?.dispose();
        this.channel?.close();
    }
}
