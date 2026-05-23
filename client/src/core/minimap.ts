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

/** Transient marker on the minimap events layer. Multiple `kind`s
 *  share the same buffer (and TTL), differing only in tint/scale so
 *  the rebuild loop can build them with one thin-instance pass.
 *
 *  - `seismic`: server-broadcast seismic ping (yellow). Position is
 *    already deceived by the server's radar-error vector.
 *  - `marker`:  player-issued `Spring.MarkerAddPoint`/`MarkerAddLine`
 *    pin (cyan). Local-only today — no other client receives the
 *    drop because the engine doesn't yet broadcast Lua marker calls,
 *    so this is a "your map notes" indicator for the local viewer.
 *  - `attack`:  reserved for future widget-driven attack alerts
 *    (red). No producer wired yet — the channel exists so the rebuild
 *    palette doesn't need re-extending when one lands. */
type MinimapPingKind = 'seismic' | 'marker' | 'attack';

interface MinimapPing {
    x: number;
    z: number;
    bornAt: number;
    kind: MinimapPingKind;
}

/** RGB per ping kind. Alpha is animated by the rebuild loop (fade-out
 *  over `PING_LIFETIME_MS`). */
const PING_COLORS: Record<MinimapPingKind, [number, number, number]> = {
    seismic: [1.0, 0.85, 0.20],
    marker:  [0.25, 0.85, 1.0],
    attack:  [1.0, 0.30, 0.30],
};

const PING_LIFETIME_MS = 4000;
const PING_SCALE_BASE = 80;
const PING_SCALE_GROWTH = 240;

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

    /** 'default' = fixed-corner sidebar (constructor-supplied parent).
     *  'widget'  = position/size controlled by a LuaUI widget via
     *              setGeometry / setVisible. Once set to 'widget' it
     *              stays there for the rest of the session unless the
     *              widget vanishes (we don't currently detect that). */
    private ownership: 'default' | 'widget' = 'default';
    /** Original parent supplied to the constructor. Kept so we can
     *  reparent the canvas back if ownership ever returns to default. */
    private defaultParent: HTMLElement;
    /** Latest geometry in DOM space (top-left origin, pixels). Mirrors
     *  what the chili minimap widget requested via gl.ConfigMiniMap. */
    private geometry: { x: number; y: number; w: number; h: number; visible: boolean } = {
        x: 0, y: 0, w: 0, h: 0, visible: true,
    };
    /** Suppresses redundant engine.resize() during a chili drag — Babylon
     *  recreates the default framebuffer on every resize, which adds up
     *  fast when the widget is fed window-mousemove events. */
    private pendingResize: { w: number; h: number } | null = null;
    private resizeRafHandle = 0;

    /** Ping ring buffer. Each entry fades over PING_LIFETIME_MS.
     *  Mixed kinds (seismic/marker/attack) share the buffer; the
     *  rebuild loop buckets them per kind for rendering. */
    private pings: MinimapPing[] = [];
    /** Per-kind ping meshes — each kind gets its own colour material
     *  (see `PING_COLORS`). Allocated lazily as pushes happen so the
     *  scene stays empty until a producer fires. */
    private pingMeshes = new Map<MinimapPingKind, Mesh>();
    /** True when a chili widget called gl.DrawMiniMapEvents recently. In
     *  ownership=widget mode the events layer is suppressed unless this
     *  was set within `eventsRequestTtlMs`; in default mode it's always
     *  rendered (no widget to drive the toggle). */
    private eventsRequestedAt = 0;
    private readonly eventsRequestTtlMs = 250;

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
        this.defaultParent = config.parentElement;

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
        // PLAN-coordinate-system Phase 2d: match the main scene's RH
        // convention so unit blips drawn from RH wire data land at the
        // expected XZ coordinates.
        this.scene.useRightHandedSystem = true;
        this.scene.clearColor = new Color4(0.04, 0.06, 0.09, 1);
        // No lighting — minimap uses unlit emissive materials so the
        // terrain texture shows up at full brightness regardless of angle.

        // Orthographic camera looking down. Server world Z runs from
        // `-mapHeight` to `0` (RH-native, Option B); centre the camera
        // at the map's middle in that frame.
        this.camera = new FreeCamera('minimapCam',
            new Vector3(this.mapWidth / 2, 10000, -this.mapHeight / 2), this.scene);
        this.camera.setTarget(new Vector3(this.mapWidth / 2, 0, -this.mapHeight / 2));
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
        this.camera.position.z = -heightElmos / 2;
        this.camera.setTarget(new Vector3(widthElmos / 2, 0, -heightElmos / 2));
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
            quad.position.z = -this.mapHeight / 2;

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

    /**
     * Hand control of the minimap's on-screen geometry to a LuaUI widget.
     * Reparents the canvas onto `document.body` with absolute positioning
     * and a z-index that sits above the main 3D canvas but below the
     * LuaUI overlay canvas (z-index 100) so chili widgets can frame it.
     * Once set, geometry comes from setGeometry / setVisible until the
     * minimap is disposed.
     */
    setOwnership(mode: 'default' | 'widget'): void {
        if (this.ownership === mode) return;
        this.ownership = mode;
        if (mode === 'widget') {
            // Strip the sidebar styling (border, rounded corners, block
            // layout) — the chili frame supplies its own chrome.
            this.canvas.style.cssText = `
                position: absolute;
                left: 0; top: 0;
                cursor: crosshair;
                pointer-events: auto;
                z-index: 50;
            `;
            document.body.appendChild(this.canvas);
        } else {
            this.canvas.style.cssText = `
                border: 1px solid #334; border-radius: 4px;
                cursor: crosshair; display: block;
            `;
            this.defaultParent.appendChild(this.canvas);
        }
        this.broadcastState();
    }

    /** Publish the current geometry + ownership on the
     *  `springrts-game` BroadcastChannel. Detached viewports listen
     *  for `minimapState` to mirror the in-page minimap layout or
     *  gate their own render on whether a chili widget has hidden
     *  the in-page copy. Sent on every setGeometry / setVisible /
     *  setOwnership change so the popup can stay in sync without
     *  polling. The schema is intentionally flat so consumers can
     *  pick fields à la carte. */
    private broadcastState(): void {
        this.channel?.postMessage({
            type: 'minimapState',
            ownership: this.ownership,
            x: this.geometry.x,
            y: this.geometry.y,
            w: this.geometry.w,
            h: this.geometry.h,
            visible: this.geometry.visible,
        });
    }

    /**
     * Set the on-screen rect for the minimap canvas in DOM-space pixels
     * (top-left origin). Called by lua-widget-manager after translating
     * the widget's Spring-space ConfigMiniMap call into DOM-space.
     * Triggers a Babylon engine resize (debounced via rAF) only when the
     * pixel dimensions actually change — repositioning alone is free.
     */
    setGeometry(x: number, y: number, w: number, h: number): void {
        if (this.ownership !== 'widget') this.setOwnership('widget');
        const changedSize = w !== this.geometry.w || h !== this.geometry.h;
        this.geometry.x = x;
        this.geometry.y = y;
        this.geometry.w = w;
        this.geometry.h = h;
        this.canvas.style.left = `${x}px`;
        this.canvas.style.top = `${y}px`;
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
        this.broadcastState();
        if (changedSize) {
            // Coalesce engine.resize() across rapid drags. The chili
            // widget can fire ConfigMiniMap on every mousemove tick;
            // calling engine.resize() each one recreates the default
            // framebuffer and triggers a noticeable hitch.
            this.pendingResize = { w: Math.max(1, w | 0), h: Math.max(1, h | 0) };
            if (this.resizeRafHandle === 0) {
                this.resizeRafHandle = requestAnimationFrame(() => {
                    this.resizeRafHandle = 0;
                    if (!this.pendingResize) return;
                    const { w: pw, h: ph } = this.pendingResize;
                    this.pendingResize = null;
                    this.canvas.width = pw;
                    this.canvas.height = ph;
                    this.engine.resize();
                });
            }
        }
    }

    /**
     * Toggle whether the canvas is visible. Used by chili widgets to
     * hide the minimap when the chili frame is collapsed (or while
     * `options.disableMinimap` is set) without losing the GL state.
     */
    setVisible(visible: boolean): void {
        this.geometry.visible = visible;
        this.canvas.style.display = visible ? 'block' : 'none';
        this.broadcastState();
    }

    /** Current rect in DOM-space pixels. Used by InputManager to ignore
     *  ground clicks that should be claimed by the minimap. */
    getGeometry(): { x: number; y: number; width: number; height: number; visible: boolean } {
        return {
            x: this.geometry.x,
            y: this.geometry.y,
            width: this.geometry.w,
            height: this.geometry.h,
            visible: this.geometry.visible,
        };
    }

    /** True iff the DOM point lies inside the visible minimap rect. */
    hitTest(clientX: number, clientY: number): boolean {
        const g = this.geometry;
        if (!g.visible || g.w <= 0 || g.h <= 0) return false;
        return clientX >= g.x && clientX < g.x + g.w
            && clientY >= g.y && clientY < g.y + g.h;
    }

    /** Called by lua-widget-manager whenever a widget invokes
     *  `gl.DrawMiniMapEvents`. The events layer is suppressed in
     *  widget-owned mode unless this was set within `eventsRequestTtlMs`
     *  — letting a widget mute pings without owning the data itself. */
    markEventsRequested(): void {
        this.eventsRequestedAt = performance.now();
    }

    /** Push a seismic ping into the events layer. Called from main.ts
     *  off the ConnectionEvents.onSeismicPings callback in parallel
     *  with the widget-worker forward. Coords are world-space elmos. */
    pushSeismicPing(p: { x: number; z: number }): void {
        this.pushPing(p.x, p.z, 'seismic');
    }

    /** Push a player-marker ping into the events layer. Fired when the
     *  widget worker invokes `Spring.MarkerAddPoint`/`MarkerAddLine`;
     *  the worker posts a message back to the main thread (via
     *  `lua-widget-manager`) which calls this. Line markers push one
     *  ping per endpoint so the cyan dots bracket the line. */
    pushMarkerPing(p: { x: number; z: number }): void {
        this.pushPing(p.x, p.z, 'marker');
    }

    /** Push an attack-alert ping. Reserved channel — no producer wired
     *  yet. The signature matches the other push methods so a future
     *  widget bridge can emit alerts without re-plumbing. */
    pushAttackPing(p: { x: number; z: number }): void {
        this.pushPing(p.x, p.z, 'attack');
    }

    private pushPing(x: number, z: number, kind: MinimapPingKind): void {
        this.pings.push({ x, z, bornAt: performance.now(), kind });
        // Cap the buffer — a stuck cloaked-unit cluster can produce
        // pings every tick; the layer only ever renders the most
        // recent.
        if (this.pings.length > 64) this.pings.splice(0, this.pings.length - 64);
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
        this.updateEventsLayer();
        this.scene.render();
    }

    private ensurePingMesh(kind: MinimapPingKind): Mesh {
        const cached = this.pingMeshes.get(kind);
        if (cached) return cached;
        const ring = MeshBuilder.CreatePlane(`minimapPing-${kind}`, { size: 1 }, this.scene);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = 12;
        ring.isPickable = false;
        const mat = new StandardMaterial(`minimapPingMat-${kind}`, this.scene);
        // Per-kind emissive (seismic yellow / marker cyan / attack red).
        // Additive blending against the fog overlay — pings are anonymous,
        // not team-coloured.
        const [r, g, b] = PING_COLORS[kind];
        mat.emissiveColor = new Color3(r, g, b);
        mat.disableLighting = true;
        mat.alpha = 0.85;
        ring.material = mat;
        this.pingMeshes.set(kind, ring);
        return ring;
    }

    /**
     * Per-tick rebuild of the events layer. Drops pings older than
     * PING_LIFETIME_MS, then sizes the rest with a growing-radius animation
     * keyed on age. Pings group by kind so each colour gets its own
     * thin-instance buffer. In widget-owned mode the layer is skipped
     * entirely unless `gl.DrawMiniMapEvents` was called recently —
     * matches Spring's model where the events overlay is opt-in per
     * widget frame.
     */
    private updateEventsLayer(): void {
        // Prune expired pings up front; this also keeps the mesh clear
        // when no events have fired in a while.
        const now = performance.now();
        if (this.pings.length > 0) {
            const cutoff = now - PING_LIFETIME_MS;
            let write = 0;
            for (let read = 0; read < this.pings.length; read++) {
                if (this.pings[read].bornAt >= cutoff) {
                    this.pings[write++] = this.pings[read];
                }
            }
            this.pings.length = write;
        }

        // Suppress the layer in widget-owned mode unless a widget asked
        // for events this frame. In default mode the layer is always on.
        const widgetOwned = this.ownership === 'widget';
        const eventsAllowed = !widgetOwned
            || (now - this.eventsRequestedAt) <= this.eventsRequestTtlMs;
        if (!eventsAllowed || this.pings.length === 0) {
            for (const mesh of this.pingMeshes.values()) mesh.thinInstanceCount = 0;
            return;
        }

        // Bucket pings by kind so each kind renders with its own colour
        // material. Most frames have ≤ a handful of kinds active, so the
        // per-kind allocation overhead is negligible.
        const byKind = new Map<MinimapPingKind, MinimapPing[]>();
        for (const p of this.pings) {
            let bucket = byKind.get(p.kind);
            if (!bucket) {
                bucket = [];
                byKind.set(p.kind, bucket);
            }
            bucket.push(p);
        }

        // Clear any kind-mesh whose bucket is empty this frame.
        for (const [kind, mesh] of this.pingMeshes) {
            if (!byKind.has(kind)) mesh.thinInstanceCount = 0;
        }

        const rot = Quaternion.Identity();
        for (const [kind, bucket] of byKind) {
            const mesh = this.ensurePingMesh(kind);
            const matrices = new Float32Array(bucket.length * 16);
            for (let i = 0; i < bucket.length; i++) {
                const p = bucket[i];
                const age = now - p.bornAt;
                const t = Math.min(1, age / PING_LIFETIME_MS);
                // Ring expands as it fades — same animation Spring uses
                // on its native minimap events. Size in elmos so it
                // scales correctly against the orthographic camera.
                const size = PING_SCALE_BASE + PING_SCALE_GROWTH * t;
                const scale = new Vector3(size, size, size);
                const m = Matrix.Compose(scale, rot, new Vector3(p.x, 12, p.z));
                m.copyToArray(matrices, i * 16);
            }
            mesh.thinInstanceSetBuffer('matrix', matrices, 16, true);
        }
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
        // on the map; world X runs `[0, mapWidth]` and world Z (under
        // RH bounds) runs `[-mapHeight, 0]`. Canvas Y=0 (top of minimap)
        // corresponds to the most-negative world Z.
        const mx = cx * this.mapWidth;
        const mz = (cz - 1) * this.mapHeight;

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

        if (this.resizeRafHandle !== 0) {
            cancelAnimationFrame(this.resizeRafHandle);
            this.resizeRafHandle = 0;
        }
        for (const mesh of this.pingMeshes.values()) mesh.dispose();
        this.pingMeshes.clear();
        this.pings.length = 0;
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
