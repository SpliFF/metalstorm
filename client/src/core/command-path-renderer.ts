/**
 * CommandPathRenderer — visualises queued orders for the current
 * selection as colour-coded thin lines between waypoints.
 *
 * Direct port of Recoil's CCommandDrawer::DrawCommands +
 * CLineDrawer::DrawLine (rts/Rendering/CommandDrawer.cpp,
 * rts/Rendering/LineDrawer.h, rts/Game/UI/CommandColors.cpp). Visual
 * goals (in priority order):
 *
 *   1. Straight 3D segments between waypoints, NOT terrain-tessellated.
 *      Recoil draws direct A→B lines and lets depth-disable handle the
 *      "see through hills" look.
 *   2. Slight per-segment fade — the start vertex of each segment uses
 *      a darker "restart" colour, end uses the full command colour.
 *      This produces Spring's signature "pulse to bright at each
 *      waypoint" look. Implemented as two stacked draws: a wide
 *      restart-coloured base layer + a narrower full-colour overlay.
 *   3. Visible width. Recoil uses `glLineWidth(1.49)` which works on
 *      desktop GL; WebGL drivers cap line width at 1px on most
 *      platforms, so we use Babylon's GreasedLine (vertex-shader-
 *      expanded billboarded quads) at ~3-4px screen-space width.
 *   4. Default colours from rts/Game/UI/CommandColors.cpp:
 *      start  = (1.0,1.0,1.0,0.7)  white
 *      restart= (0.4,0.4,0.4,0.7)  gray (gradient endpoint)
 *      move   = (0.5,1.0,0.5,0.7)  light green
 *      attack = (1.0,0.2,0.2,0.7)  red
 *      build  = (0.0,1.0,0.0,0.7)  green
 *      fight  = (0.5,0.5,1.0,0.7)  blue (NOT green like move)
 *      patrol = (0.3,0.3,1.0,0.7)  blue
 *      guard  = (0.3,0.3,1.0,0.7)  blue
 *      repair = (0.3,1.0,1.0,0.7)  cyan
 *      reclaim= (1.0,0.2,1.0,0.7)  magenta
 *      capture= (1.0,1.0,0.3,0.7)  yellow
 *
 * Endpoint Y is sampled terrain height + 3 elmos (matching
 * `CGround::GetHeightReal(x,z) + 3.0` in CommandDrawer.cpp). Origin is
 * the unit's mid-position.
 *
 * Visibility gesture: paths render only while the player holds Shift,
 * matching Spring/Recoil's "show queued orders" UI convention.
 *
 * X-ray render: depth test always passes so paths stay visible behind
 * hills. CommandDrawer does the same with `glDisable(GL_DEPTH_TEST)`.
 */

import {
    Scene,
    Color3,
    Vector3,
    Mesh,
    MeshBuilder,
    StandardMaterial,
    CreateGreasedLine,
    GreasedLineMeshColorMode,
    GreasedLineMeshMaterialType,
    RawTexture,
    Engine,
    Texture,
    type InstancedMesh,
} from '@babylonjs/core';
import type { GreasedLineSimpleMaterial } from '@babylonjs/core/Materials/GreasedLine/greasedLineSimpleMaterial.js';
import type { EntityRenderer } from './entity-renderer.js';
import type { ParsedMapData } from './map-data.js';

interface OrderInfo {
    cmdId: number;
    params: number[];
}

interface QueueInfo {
    unitId: number;
    orders: ReadonlyArray<OrderInfo>;
}

/** Spring command IDs we colour-code. The negative range is build. */
const CMD_MOVE     = 10;
const CMD_PATROL   = 15;
const CMD_FIGHT    = 16;
const CMD_ATTACK   = 20;
const CMD_GUARD    = 25;
const CMD_REPAIR   = 40;
const CMD_RECLAIM  = 90;
const CMD_RESURRECT = 125;
const CMD_CAPTURE  = 130;

/** Recoil CommandColors.cpp defaults. Alpha is implicit 0.7 on every
 *  queue colour, applied via the material's overall alpha. */
const COLOR_MOVE    = new Color3(0.5, 1.0, 0.5);
const COLOR_ATTACK  = new Color3(1.0, 0.2, 0.2);
const COLOR_BUILD   = new Color3(0.0, 1.0, 0.0);
const COLOR_FIGHT   = new Color3(0.5, 0.5, 1.0);
const COLOR_PATROL  = new Color3(0.3, 0.3, 1.0);
const COLOR_GUARD   = new Color3(0.3, 0.3, 1.0);
const COLOR_REPAIR  = new Color3(0.3, 1.0, 1.0);
const COLOR_RECLAIM = new Color3(1.0, 0.2, 1.0);
const COLOR_CAPTURE = new Color3(1.0, 1.0, 0.3);
const COLOR_RESURRECT = new Color3(0.2, 0.6, 1.0);

/// gl.ALWAYS — always pass depth test so the X-ray effect works.
/// Mirror of `glDisable(GL_DEPTH_TEST)` in CommandDrawer.cpp.
const DEPTH_ALWAYS = 519;

/// Recoil's CommandDrawer adds +3 elmos to terrain height for endpoint Y
/// (`CGround::GetHeightReal(x,z) + 3.0f`). Same constant.
const ENDPOINT_TERRAIN_LIFT = 3;

/// Width in scene units. Recoil's queuedLineWidth=1.49 is in screen
/// pixels via glLineWidth (no longer reliable in WebGL). Bumping to 4
/// scene-units gives a comparable visual weight at typical RTS zoom
/// (camera ~1000 elmos high). Lowered with sizeAttenuation=true so it
/// stays roughly screen-constant at different zooms.
const LINE_WIDTH = 4;

/// Per-segment alpha baked into the colors texture (see
/// bakeAlphaIntoColorsTexture). Lower than Recoil's 0.7 default because
/// our GreasedLine quads cover noticeably more screen pixels than the
/// engine's 1.49-px lines, so the same alpha reads as much heavier ink.
const LINE_ALPHA = 0.55;

/// Glow halo pass: drawn behind the core line, wider and dimmer, with
/// additive blending so overlapping path colours stack to white-ish at
/// the centre. Looks like the soft bloom Recoil's lines get under FXAA.
const GLOW_WIDTH_MULT = 2.4;
const GLOW_ALPHA = 0.18;

/// Diameter of the start-point marker drawn at the selected unit's
/// origin. Recoil paints `cmdColors.start = (1,1,1,0.7)` here — a
/// small white sphere that anchors the path visually.
const START_MARKER_SIZE = 6;

function colorForCmd(cmdId: number): Color3 {
    if (cmdId < 0) return COLOR_BUILD;
    switch (cmdId) {
        case CMD_MOVE:      return COLOR_MOVE;
        case CMD_PATROL:    return COLOR_PATROL;
        case CMD_FIGHT:     return COLOR_FIGHT;
        case CMD_ATTACK:    return COLOR_ATTACK;
        case CMD_GUARD:     return COLOR_GUARD;
        case CMD_REPAIR:    return COLOR_REPAIR;
        case CMD_RECLAIM:   return COLOR_RECLAIM;
        case CMD_RESURRECT: return COLOR_RESURRECT;
        case CMD_CAPTURE:   return COLOR_CAPTURE;
        default:            return COLOR_MOVE;
    }
}

/** Pull a 3-vector destination off an order's param list. Spring orders
 *  carry positional commands as `[x, y, z]` (and optionally facing/radius
 *  trailers). Single-param commands (Attack <unitId>, Guard <unitId>) have
 *  no world position — we skip those segments. */
function destOf(order: OrderInfo): Vector3 | null {
    const p = order.params;
    if (p.length >= 3) {
        return new Vector3(p[0], p[1], p[2]);
    }
    return null;
}

export class CommandPathRenderer {
    private scene: Scene;
    private entityRenderer: EntityRenderer;
    /// Core (sharp, full-colour) line mesh.
    private linesMesh: Mesh | null = null;
    /// Glow halo mesh — same polylines, wider + dimmer, additive blend.
    /// Drawn first (lower renderingGroupId equivalent via order) so the
    /// core line sits inside the halo.
    private glowMesh: Mesh | null = null;
    /// Start-point markers (one InstancedMesh per selected unit). Shares a
    /// single master plane + white-disc material.
    private startMaster: Mesh | null = null;
    private startMaterial: StandardMaterial | null = null;
    private startMarkers: InstancedMesh[] = [];
    private mapData: ParsedMapData | null = null;
    /// Path overlay only shows while the player is holding shift —
    /// mirrors Spring/Recoil's "show queued orders" gesture.
    private shiftHeld = false;
    /// Latest selection + queue snapshot. Cached so a shift press can
    /// repaint the overlay without waiting for the next 1-second
    /// UnitCommandQueuesUpdate broadcast.
    private lastSelection: ReadonlyArray<number> = [];
    private lastQueues: ReadonlyArray<QueueInfo> = [];
    /// Fingerprint of the most-recently-rendered (selection, queue
    /// content) snapshot. Server broadcasts UnitCommandQueuesUpdate every
    /// ~1 s with freshly-allocated objects even when the orders haven't
    /// changed; rebuilding the GreasedLine mesh on every broadcast caused
    /// a one-frame gap between dispose and re-create that read as a
    /// 1 Hz flicker. Skipping the rebuild when content is unchanged
    /// eliminates the flicker entirely while shift is held steady.
    private renderedFingerprint: string = '';

    constructor(scene: Scene, entityRenderer: EntityRenderer) {
        this.scene = scene;
        this.entityRenderer = entityRenderer;
    }

    setShiftHeld(held: boolean): void {
        if (held === this.shiftHeld) return;
        this.shiftHeld = held;
        if (held) {
            // Force a render even if nothing changed since shift was last
            // pressed — clear() between presses wipes the mesh, so the
            // fingerprint cache shouldn't gate the first frame of an
            // overlay session.
            this.renderedFingerprint = '';
            this.render();
        } else {
            this.clear();
        }
    }

    setMapData(map: ParsedMapData): void {
        this.mapData = map;
    }

    /** Bilinear height sample at world (x, z). Returns 0 outside the
     *  map (rare — orders are clamped to map bounds server-side). */
    private sampleHeight(x: number, z: number): number {
        const m = this.mapData;
        if (!m || m.heightmap.length === 0) return 0;
        const hmW = m.mapx + 1;
        const hmH = m.mapy + 1;
        const hRange = m.maxHeight - m.minHeight;
        const fx = x / m.squareSize;
        const fz = z / m.squareSize;
        const x0 = Math.max(0, Math.min(hmW - 1, Math.floor(fx)));
        const z0 = Math.max(0, Math.min(hmH - 1, Math.floor(fz)));
        const x1 = Math.min(hmW - 1, x0 + 1);
        const z1 = Math.min(hmH - 1, z0 + 1);
        const tx = Math.max(0, Math.min(1, fx - x0));
        const tz = Math.max(0, Math.min(1, fz - z0));
        const h00 = m.heightmap[z0 * hmW + x0];
        const h10 = m.heightmap[z0 * hmW + x1];
        const h01 = m.heightmap[z1 * hmW + x0];
        const h11 = m.heightmap[z1 * hmW + x1];
        const h0 = h00 * (1 - tx) + h10 * tx;
        const h1 = h01 * (1 - tx) + h11 * tx;
        const raw = h0 * (1 - tz) + h1 * tz;
        return m.minHeight + (raw / 65535) * hRange;
    }

    /** Cache the latest queue + selection snapshot. Render is gated on
     *  shiftHeld — when shift isn't held, we keep the data fresh but
     *  draw nothing. */
    update(queues: ReadonlyArray<QueueInfo>, selection: ReadonlyArray<number>): void {
        this.lastQueues = queues;
        this.lastSelection = selection;
        if (this.shiftHeld) this.render();
    }

    /** Build a fingerprint from selection + queue content (ignoring
     *  unit positions, which drift every frame as units interpolate).
     *  Two snapshots with the same fingerprint produce identical
     *  geometry once we lock the start point to the unit's *current*
     *  position — see render() for the build-then-swap pattern. */
    private fingerprint(): string {
        const sel = this.lastSelection.length === 0 ? '' : this.lastSelection.slice().sort((a, b) => a - b).join(',');
        const qparts: string[] = [];
        for (const q of this.lastQueues) {
            qparts.push(`${q.unitId}:${q.orders.map(o => `${o.cmdId}|${o.params.join(',')}`).join(';')}`);
        }
        return `${sel}#${qparts.join('/')}`;
    }

    private render(): void {
        const selection = this.lastSelection;
        const queues = this.lastQueues;

        // Skip rebuild when neither selection nor queue content changed.
        // Unit interpolation moves the start point every frame, but the
        // path's *visual* anchor at the unit reads fine even if the start
        // segment lags by ~1 s (the next broadcast interval). This is
        // the difference between a steady visible overlay and a 1 Hz
        // dispose/recreate flicker.
        const fp = this.fingerprint();
        if (fp === this.renderedFingerprint && this.linesMesh) return;

        if (selection.length === 0) {
            this.disposeMesh();
            this.renderedFingerprint = fp;
            return;
        }

        const sel = new Set(selection);

        /// Each selected unit's queue becomes one polyline (Vector3[]).
        /// GreasedLine takes Vector3[][] for the multi-line case and
        /// Color3[] (one per segment) for per-segment colouring. The
        /// segment count = sum over all polylines of (points-1).
        const polylines: Vector3[][] = [];
        const segmentColors: Color3[] = [];

        for (const q of queues) {
            if (!sel.has(q.unitId)) continue;
            if (q.orders.length === 0) continue;

            const start = this.entityRenderer.getEntityPosition(q.unitId);
            if (!start) continue;

            const points: Vector3[] = [];
            const colors: Color3[] = [];

            // Origin: lift slightly above the unit's feet so the line
            // doesn't disappear into its base mesh. Recoil uses
            // GetObjDrawMidPos which is roughly halfway up the unit.
            points.push(new Vector3(start.x, start.y + 10, start.z));

            for (const o of q.orders) {
                const dest = destOf(o);
                if (!dest) continue;

                // Endpoint Y: terrain + 3 elmos (matches
                // CGround::GetHeightReal(x,z) + 3.0f in CommandDrawer.cpp).
                const groundY = this.sampleHeight(dest.x, dest.z);
                if (!Number.isFinite(groundY)) continue;
                const endY = Math.max(dest.y, groundY) + ENDPOINT_TERRAIN_LIFT;
                points.push(new Vector3(dest.x, endY, dest.z));
                colors.push(colorForCmd(o.cmdId));
            }

            if (points.length < 2) continue;
            polylines.push(points);
            // GreasedLine auto-builds per-vertex colour pointers
            // [0,0, 1,1, ..., N-1,N-1] and samples
            //   texture.lookup = colorPointer / colorsWidth
            // For a polyline of N points with N-1 segment colours, the
            // last vertex's lookup is (N-1)/(N-1) = 1.0, which the
            // default REPEAT wrap mode aliases back to colour[0] — the
            // visible symptom is "every other segment colours wrong".
            // Pad colours to length N (duplicate the last segment's
            // colour onto the trailing vertex) and clamp wrap mode
            // below to keep the lookup in-range.
            for (const c of colors) segmentColors.push(c);
            segmentColors.push(colors[colors.length - 1]);
        }

        if (polylines.length === 0) {
            this.disposeMesh();
            this.renderedFingerprint = fp;
            return;
        }

        // Build the new meshes BEFORE disposing the old ones. Atomic swap
        // means the GPU never sees a frame with neither mesh present —
        // critical for stopping the 1 Hz flicker even when content
        // genuinely does change between broadcasts.
        const oldLines = this.linesMesh;
        const oldGlow = this.glowMesh;

        // Glow pass first — drawn behind the core line. Wider, dimmer,
        // additive blend. Gives the path a soft halo so the eye reads the
        // colour as a glow rather than a sharp ribbon. Order in the
        // scene matters: we use the same renderingGroupId but rely on
        // creation order so the additive glow renders BEFORE the alpha
        // core (Babylon iterates the active mesh list in creation order
        // within a renderingGroup).
        const glow = this.buildLineMesh(
            'cmd-paths-glow',
            polylines,
            segmentColors,
            LINE_WIDTH * GLOW_WIDTH_MULT,
            GLOW_ALPHA,
            /* additive */ true,
        );

        const core = this.buildLineMesh(
            'cmd-paths',
            polylines,
            segmentColors,
            LINE_WIDTH,
            LINE_ALPHA,
            /* additive */ false,
        );

        this.glowMesh = glow;
        this.linesMesh = core;
        if (oldLines) {
            oldLines.material?.dispose();
            oldLines.dispose();
        }
        if (oldGlow) {
            oldGlow.material?.dispose();
            oldGlow.dispose();
        }

        // Rebuild start-point markers. Tiny white discs at each selected
        // unit's mid-position — matches Recoil's `cmdColors.start` dot.
        this.rebuildStartMarkers();

        this.renderedFingerprint = fp;
    }

    /** Build a single GreasedLine mesh with the desired width / alpha /
     *  blend mode. Used for both the core line and the glow halo —
     *  identical geometry, different visual treatment. */
    private buildLineMesh(
        name: string,
        polylines: Vector3[][],
        segmentColors: Color3[],
        width: number,
        alpha: number,
        additive: boolean,
    ): Mesh {
        const mesh = CreateGreasedLine(
            name,
            {
                points: polylines,
                updatable: false,
            },
            {
                width,
                // sizeAttenuation=false: width is in world (scene) units,
                // so the line stays the configured width in 3D and gets
                // smaller as the camera pulls back. That's the look Recoil
                // gives — at high zoom the queued lines almost vanish.
                sizeAttenuation: false,
                useColors: true,
                colors: segmentColors,
                colorMode: GreasedLineMeshColorMode.COLOR_MODE_SET,
                // Force the SIMPLE material variant so `mesh.material`
                // IS the GreasedLine material (not StandardMaterial with
                // a plugin). Otherwise our colorsTexture override below
                // sets a property on the StandardMaterial wrapper that
                // the actual shader-bound texture (held by the plugin)
                // never reads — alpha bake-in silently has no effect.
                materialType: GreasedLineMeshMaterialType.MATERIAL_TYPE_SIMPLE,
            },
            this.scene,
        );

        // X-ray: draw on top of everything so paths stay visible behind
        // hills the unit is about to climb. Recoil's CommandDrawer does
        // `glDisable(GL_DEPTH_TEST)` for the whole queue draw.
        const mat = mesh.material;
        if (mat) {
            mat.disableDepthWrite = true;
            mat.depthFunction = DEPTH_ALWAYS;
            // Two-part alpha fix (see bakeAlphaIntoColorsTexture):
            //   1. Bake alpha into a replacement colors texture so the
            //      shader output has alpha < 1.
            //   2. Set `mat.alpha < 1` so GreasedLineSimpleMaterial's
            //      needAlphaBlending() returns true.
            // Premultiplied flag: for the core line, bake the RGB *
            // alpha into the texture so the shader outputs premultiplied
            // values. Babylon's default ALPHA_COMBINE blend
            // (gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA) reads premultiplied
            // RGBA correctly if we ALSO switch the blend mode to
            // ALPHA_PREMULTIPLIED (gl.ONE, gl.ONE_MINUS_SRC_ALPHA). Result:
            // the dark fringe artefact (premult-aware sampling against an
            // unpremult texture) goes away.
            const premultiplied = !additive;
            this.bakeAlphaIntoColorsTexture(
                mat as unknown as GreasedLineSimpleMaterial,
                segmentColors,
                alpha,
                premultiplied,
            );
            mat.alpha = alpha;
            if (additive) {
                // Additive blend: gl.ONE, gl.ONE. Overlapping path
                // colours brighten where they cross, which reads as a
                // soft glow that survives behind hills (depth-always).
                mat.alphaMode = Engine.ALPHA_ADD;
            } else {
                mat.alphaMode = Engine.ALPHA_PREMULTIPLIED;
            }
        }
        mesh.isPickable = false;
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.renderingGroupId = 3;
        return mesh as unknown as Mesh;
    }

    /** Ensure the start-marker master mesh + material exist. A single
     *  shared plane lying flat on the ground; instances inherit material
     *  + geometry, so per-unit cost is one TransformMatrix. */
    private ensureStartMaster(): Mesh {
        if (this.startMaster) return this.startMaster;

        const mat = new StandardMaterial('cmd-start-mat', this.scene);
        mat.emissiveColor = new Color3(1, 1, 1);
        mat.disableLighting = true;
        mat.alpha = 0.85;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.depthFunction = DEPTH_ALWAYS;
        this.startMaterial = mat;

        // Slim diamond/circle effect from a unit-square plane laid flat.
        // Visually small enough to read as a dot, big enough to be
        // visible against arbitrary terrain.
        const master = MeshBuilder.CreatePlane('cmd-start-master',
            { size: START_MARKER_SIZE, sideOrientation: Mesh.DOUBLESIDE },
            this.scene,
        );
        master.rotation.x = Math.PI / 2;
        master.material = mat;
        master.isVisible = false;
        master.isPickable = false;
        master.renderingGroupId = 3;
        master.alwaysSelectAsActiveMesh = true;
        this.startMaster = master;
        return master;
    }

    private rebuildStartMarkers(): void {
        for (const m of this.startMarkers) m.dispose();
        this.startMarkers = [];

        const sel = new Set(this.lastSelection);
        for (const q of this.lastQueues) {
            if (!sel.has(q.unitId)) continue;
            if (q.orders.length === 0) continue;
            const start = this.entityRenderer.getEntityPosition(q.unitId);
            if (!start) continue;
            const master = this.ensureStartMaster();
            const inst = master.createInstance(`cmd-start-${q.unitId}`);
            inst.position.set(start.x, start.y + 10, start.z);
            inst.rotation.x = Math.PI / 2;
            inst.isPickable = false;
            inst.alwaysSelectAsActiveMesh = true;
            inst.renderingGroupId = 3;
            this.startMarkers.push(inst);
        }
    }

    /** Replace GreasedLineSimpleMaterial's auto-built colors texture
     *  with one where alpha is baked in. The default
     *  `Color3toRGBAUint8` writes alpha=255 unconditionally; the
     *  fragment shader's SET-mode path (`gl_FragColor = textureColor`)
     *  then leaves alpha at 1 regardless of `material.alpha`. By
     *  writing alpha=alpha*255 into the texture directly, the shader
     *  outputs the desired alpha and Babylon's alpha-blend pipeline
     *  blends correctly against the framebuffer.
     *
     *  When `premultiplied` is set we also multiply RGB by alpha before
     *  packing — required to pair with `Engine.ALPHA_PREMULTIPLIED`
     *  blending. Without this the line's quad antialiasing samples the
     *  unpremultiplied colour against a transparent-black background,
     *  producing a visible dark fringe at the quad edges. With
     *  premultiplied data + premultiplied blend, the fringe disappears
     *  because the "background" already encodes alpha=0 cleanly. */
    private bakeAlphaIntoColorsTexture(
        mat: GreasedLineSimpleMaterial,
        colors: ReadonlyArray<Color3>,
        alpha: number,
        premultiplied: boolean,
    ): void {
        const a = Math.max(0, Math.min(1, alpha));
        const a8 = Math.round(a * 255);
        const rgbMult = premultiplied ? a : 1;
        const data = new Uint8Array(colors.length * 4);
        for (let i = 0, j = 0; i < colors.length; i++) {
            data[j++] = Math.round(colors[i].r * rgbMult * 255);
            data[j++] = Math.round(colors[i].g * rgbMult * 255);
            data[j++] = Math.round(colors[i].b * rgbMult * 255);
            data[j++] = a8;
        }
        const oldTex = mat.colorsTexture;
        const tex = new RawTexture(
            data,
            colors.length,
            1,
            Engine.TEXTUREFORMAT_RGBA,
            this.scene,
            false,                          // generateMipMaps
            true,                           // invertY
            Texture.NEAREST_SAMPLINGMODE,   // crisp 1px-per-segment lookup
        );
        // CLAMP wrap mode: per-vertex colour pointer at the line tail
        // samples lookup=1.0, which the default REPEAT mode aliases
        // back to colour[0]. Clamping holds the last colour instead.
        tex.wrapU = Texture.CLAMP_ADDRESSMODE;
        tex.wrapV = Texture.CLAMP_ADDRESSMODE;
        tex.name = `${mat.name}-colors-alpha`;
        mat.colorsTexture = tex;
        oldTex?.dispose();
    }

    private disposeMesh(): void {
        if (this.linesMesh) {
            this.linesMesh.material?.dispose();
            this.linesMesh.dispose();
            this.linesMesh = null;
        }
        if (this.glowMesh) {
            this.glowMesh.material?.dispose();
            this.glowMesh.dispose();
            this.glowMesh = null;
        }
        for (const m of this.startMarkers) m.dispose();
        this.startMarkers = [];
    }

    clear(): void {
        this.disposeMesh();
        this.renderedFingerprint = '';
    }

    dispose(): void {
        this.clear();
        if (this.startMaster) {
            this.startMaster.dispose();
            this.startMaster = null;
        }
        if (this.startMaterial) {
            this.startMaterial.dispose();
            this.startMaterial = null;
        }
    }
}
