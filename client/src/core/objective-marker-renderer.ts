/**
 * objective-marker-renderer.ts — objectives, findable by LOOKING
 * (DESIGN-DRILLDOWN.md §4 world-anchored icons; U2, interaction story 2)
 *
 * A ring on the ground at the objective's own radius, plus a label above it,
 * for every objective the viewer can act on. Sibling to
 * `standing-order-renderer.ts`, and deliberately built the same way — a ground
 * torus at renderingGroupId 3 with depth-always, rebuilt only when a
 * fingerprint changes — because a second, differently-behaving overlay
 * mechanism is exactly what §4's "world icon" row does NOT ask for.
 *
 * ── The three rules this file exists to keep ──
 *
 * **1. It is part of the WORLD, not the HUD.** Nothing here docks to a screen
 * edge, and nothing here is on screen when there are no objectives. The
 * directive's complaint was screen clutter; a marker layer that reads as
 * another panel would be the same failure in 3D.
 *
 * **2. It must not hide the fight under it.** Two things enforce that. The mark
 * is an OUTLINE, never a filled disc — a 900-elmo translucent disc over Raven
 * Basin would grey out every unit inside the objective the player is fighting
 * over. And it fades OUT as the camera descends: at the height a player fights
 * at, the ring is gone; at command height it is fully drawn. See
 * `updateCameraFade`.
 *
 * **3. It costs nothing per frame.** The mesh set is rebuilt only when
 * `markersFingerprint` changes, label textures are cached by text (so a control
 * objective ticking its progress does not re-rasterise its name), and the
 * per-frame work is one camera-height read plus, on the frames where the
 * quantised height bucket actually moves, an alpha write on a handful of
 * materials. No allocation on any frame.
 *
 * ── Faction tint ──
 *
 * Team colours come from the same palette `standing-order-renderer.ts` uses
 * (itself a copy of EntityRenderer's, which is not exported — the third copy is
 * not an improvement, so this file imports the seam it already has rather than
 * making a fourth). An OPEN RACE (`team === -1`) is not a faction and is drawn
 * in the objective gold the HUD uses for the same case, so "this is up for
 * grabs" is legible without reading a label.
 */

import {
    Scene, Color3, Vector3, Mesh, MeshBuilder, StandardMaterial,
    DynamicTexture, Texture,
} from '@babylonjs/core';
import type { ParsedMapData } from './map-data.js';
import { markersFingerprint, type ObjectiveMarker } from './objective-markers.js';

/// gl.ALWAYS — keep markers visible behind terrain. Finding an objective is the
/// whole job, and an objective behind the ridge you are standing on is exactly
/// the one you cannot find any other way. Same convention as the standing-order
/// and command-path overlays.
const DEPTH_ALWAYS = 519;

/// Lift the ring above terrain so it does not z-fight on flat ground.
const TERRAIN_LIFT = 4;

/// Team palette. Same values as `standing-order-renderer.ts` / EntityRenderer
/// (neither exports it; see the header).
const TEAM_COLORS = [
    new Color3(90 / 255, 90 / 255, 255 / 255),
    new Color3(200 / 255, 0 / 255, 0 / 255),
    new Color3(255 / 255, 255 / 255, 255 / 255),
    new Color3(38 / 255, 155 / 255, 32 / 255),
    new Color3(7 / 255, 31 / 255, 125 / 255),
    new Color3(150 / 255, 10 / 255, 180 / 255),
    new Color3(255 / 255, 255 / 255, 0 / 255),
    new Color3(50 / 255, 50 / 255, 50 / 255),
    new Color3(152 / 255, 200 / 255, 220 / 255),
    new Color3(171 / 255, 171 / 255, 131 / 255),
];

/// An open race belongs to nobody. Objective gold — the same colour
/// `native-ui.css` gives a victory objective's chip edge.
const OPEN_RACE_COLOR = new Color3(0.85, 0.68, 0.15);

/// Winning it ends the war. Drawn brighter than any team tint so the one
/// marker that matters most is the one that reads first.
const VICTORY_COLOR = new Color3(1.0, 0.85, 0.30);

/**
 * How tall the label billboard is drawn, as a fraction of the camera-to-look-at
 * distance — NOT a fixed world size.
 *
 * A fixed size cannot work at both altitudes this layer is read at. Sized to
 * read at 3600 elmos it swallows the screen at 850; sized for 850 it is a
 * smudge from up high. Measured on screen: at a fixed 90 elmos the label was
 * wider than the 654-elmo protect ring it sat in.
 *
 * Scaling with distance holds it at one apparent size, which is what a label
 * wants — its job is to be READ, and reading does not care how far away the
 * thing is. The ring keeps its true world size, because the ring's job is the
 * opposite: it says how big the objective actually is.
 */
const LABEL_SCREEN_FRACTION = 0.055;

/// Base geometry height. The live size is this times a per-frame scale, so the
/// number itself only sets the units the scale is expressed in.
const LABEL_HEIGHT = 1;

/// Label width as a multiple of its height. 4.2 fits "Escort the transport out"
/// at the plate's font size without the ellipsis.
const LABEL_ASPECT = 4.2;

/// How far above the ring's ground point the label floats, also as a fraction
/// of camera distance so it clears the terrain at every altitude.
const LABEL_LIFT_FRACTION = 0.075;

/// Distance quantum (elmos) for the per-frame label rescale. ~3% granularity at
/// command height — below what an eye resolves, and it means a camera drifting
/// does not touch a transform every frame.
const LABEL_SCALE_QUANTUM = 32;

/// A positionless-but-placed objective (a `kill` target, an objective whose
/// region carries no circle) gets a BEACON, not a ring: a small fixed marker
/// that claims a point and not an area.
const BEACON_RADIUS = 120;

/// Ring alpha at full visibility. Deliberately under half: the ring is a hint
/// about the ground, not a thing drawn on top of it.
const RING_ALPHA = 0.45;
const LABEL_ALPHA = 0.9;

/**
 * Camera-height fade band, in elmos of camera-to-look-at distance.
 *
 * Below `FADE_IN_LOW` the player is in the fight and the marker is gone
 * entirely; by `FADE_IN_HIGH` it is fully drawn. U0 measured the drill-down
 * travel arriving with a 554-elmo camera delta and called ~700–900 "command
 * height", so the band sits under both: a player who zooms in to fight loses
 * the rings, a player who pulls back to think gets them.
 */
const FADE_IN_LOW = 260;
const FADE_IN_HIGH = 520;

/// Alpha is only rewritten when the fade factor moves by more than this, so a
/// camera drifting a few elmos does not touch a material every frame.
const FADE_EPSILON = 0.02;

interface MarkerMeshes {
    ring: Mesh;
    label: Mesh | null;
    /** Ground y under the label, so the per-frame lift can be recomputed
     *  without re-sampling the heightmap. */
    groundY: number;
}

export class ObjectiveMarkerRenderer {
    private mapData: ParsedMapData | null = null;
    private markers: readonly ObjectiveMarker[] = [];
    private lastFingerprint = '';
    private built: MarkerMeshes[] = [];

    /** Ring materials, keyed by colour — one per distinct tint on screen. */
    private ringMats = new Map<string, StandardMaterial>();
    /** Label materials, keyed by `text|tint`. Cached across rebuilds so a
     *  progress tick does not re-rasterise a name every few seconds. */
    private labelMats = new Map<string, StandardMaterial>();

    /** Last applied fade, so `updateCameraFade` can early-out. */
    private appliedFade = -1;
    /** Last camera distance the label transforms were sized for, quantised. */
    private appliedScaleBucket = -1;
    /** The raw distance behind that bucket, so a rebuild can re-apply it. */
    private lastDistance = FADE_IN_HIGH;

    constructor(private readonly scene: Scene) {}

    setMapData(map: ParsedMapData): void {
        this.mapData = map;
        // Heights changed under the existing rings; rebuild from cache.
        this.lastFingerprint = '';
        this.render();
    }

    /** Wholesale replacement, like every other overlay renderer here: each push
     *  is the complete set of markers the viewer may see. */
    update(markers: readonly ObjectiveMarker[]): void {
        this.markers = markers;
        this.render();
    }

    /** How many meshes are currently live. Debug hook — `window.__gp(
     *  '__objectiveMarkers.markerCount()')` is how the live run counted rings
     *  without trusting a screenshot to have drawn them. */
    markerCount(): number {
        return this.built.length;
    }

    /** The markers as last rendered. Debug/verification hook. */
    current(): readonly ObjectiveMarker[] {
        return this.markers;
    }

    /**
     * Per-frame: fade the layer with camera height (rule 2 in the header).
     *
     * Costs one subtraction and a compare on the frames where nothing moved.
     * `distance` is the camera-to-look-at delta the RTS camera already
     * maintains, NOT the world-space y — a camera looking down at a hilltop is
     * as close to the fight as one looking down at a valley floor, and only the
     * delta says so.
     */
    updateCameraFade(distance: number): void {
        this.lastDistance = distance;
        const fade = fadeForDistance(distance);
        if (Math.abs(fade - this.appliedFade) >= FADE_EPSILON) {
            this.appliedFade = fade;
            for (const mat of this.ringMats.values()) mat.alpha = RING_ALPHA * fade;
            for (const mat of this.labelMats.values()) mat.alpha = LABEL_ALPHA * fade;
            // A fully faded layer is skipped by the renderer entirely rather
            // than drawn at alpha 0 — one less transparent pass while the
            // player is fighting.
            const visible = fade > 0;
            for (const m of this.built) {
                m.ring.isVisible = visible;
                if (m.label) m.label.isVisible = visible;
            }
        }

        // Labels hold one apparent size (see LABEL_SCREEN_FRACTION). Quantised,
        // so this writes transforms only when the camera has actually moved a
        // meaningful amount, and never at all while it sits still.
        const bucket = Math.round(distance / LABEL_SCALE_QUANTUM);
        if (bucket === this.appliedScaleBucket) return;
        this.appliedScaleBucket = bucket;
        this.applyLabelScale(distance);
    }

    private applyLabelScale(distance: number): void {
        const s = Math.max(1, distance) * LABEL_SCREEN_FRACTION;
        const lift = Math.max(1, distance) * LABEL_LIFT_FRACTION;
        for (const m of this.built) {
            if (!m.label) continue;
            // y is NEGATED — see the note where the billboard is built.
            m.label.scaling.set(s, -s, s);
            m.label.position.y = m.groundY + lift;
        }
    }

    private render(): void {
        const fp = markersFingerprint(this.markers);
        if (fp === this.lastFingerprint) return;
        this.clearMeshes();
        this.lastFingerprint = fp;

        for (const m of this.markers) {
            const color = colorFor(m);
            const radius = m.r > 0 ? m.r : BEACON_RADIUS;
            const y = this.groundY(m.x, m.z);

            const ring = this.makeRing(`objective-ring-${m.id}`, radius, color, m.r === 0);
            ring.position.set(m.x, y, m.z);

            const label = m.label
                ? this.makeLabel(`objective-label-${m.id}`, m.label, color, m.x, y, m.z)
                : null;
            this.built.push({ ring, label, groundY: y });
        }
        // Newly built meshes take the fade and the label size the camera is
        // currently at, not the defaults — a marker that appears mid-match must
        // not flash in at full brightness and full size for one frame.
        this.appliedFade = -1;
        this.appliedScaleBucket = -1;
        this.updateCameraFade(this.lastDistance);
    }

    /**
     * A flat torus at the marker's radius.
     *
     * Thickness scales with radius so a 3000-elmo hold circle and a 400-elmo
     * extract zone read as the same kind of mark rather than one hairline and
     * one pipe — the same rule `standing-order-renderer.ts` applies, with a
     * floor so a beacon-sized ring stays visible at command height.
     */
    private makeRing(name: string, radius: number, color: Color3, beacon: boolean): Mesh {
        const tess = Math.max(32, Math.min(96, Math.floor(radius / 20)));
        const thickness = Math.max(6, radius * (beacon ? 0.10 : 0.015));
        const ring = MeshBuilder.CreateTorus(name, {
            diameter: radius * 2,
            thickness,
            tessellation: tess,
        }, this.scene);
        ring.scaling.y = 0.12;
        ring.material = this.ringMaterial(color);
        ring.isPickable = false;
        ring.renderingGroupId = 3;
        ring.alwaysSelectAsActiveMesh = true;
        return ring;
    }

    private ringMaterial(color: Color3): StandardMaterial {
        const key = colorKey(color);
        const cached = this.ringMats.get(key);
        if (cached) return cached;
        const mat = new StandardMaterial(`objective-ring-mat-${key}`, this.scene);
        mat.diffuseColor = new Color3(0, 0, 0);
        mat.emissiveColor = color;
        mat.specularColor = new Color3(0, 0, 0);
        mat.disableLighting = true;
        mat.alpha = RING_ALPHA;
        mat.disableDepthWrite = true;
        mat.depthFunction = DEPTH_ALWAYS;
        this.ringMats.set(key, mat);
        return mat;
    }

    /**
     * The objective's own name, on a billboard over the centre.
     *
     * It is the SAME string `objective-phrasing.ts` puts on the chip. A world
     * marker and a summary chip that word one objective two ways is the failure
     * that module was written in one place to prevent, so the marker layer
     * composes no text of its own.
     */
    private makeLabel(name: string, text: string, color: Color3,
                      x: number, y: number, z: number): Mesh {
        const mat = this.labelMaterial(text, color);
        const plane = MeshBuilder.CreatePlane(name, {
            width: LABEL_HEIGHT * LABEL_ASPECT,
            height: LABEL_HEIGHT,
        }, this.scene);
        plane.material = mat;
        // Size and lift are set by `applyLabelScale` from the live camera
        // distance; this is only somewhere to be until the first call, which
        // `render` makes before the frame ends.
        plane.position.set(x, y, z);
        plane.billboardMode = Mesh.BILLBOARDMODE_ALL;
        // ⚠ Without this the label renders UPSIDE DOWN, and the diagnosis is
        // worth writing down because it took three screenshots to name.
        //
        // It reads at a glance like a mirroring — a billboard showing its back
        // face — and it is not: the letters are in the correct left-to-right
        // order, flipped about the horizontal axis. That is the canvas-Y vs
        // texture-V disagreement between a `DynamicTexture` and this scene, and
        // the two fixes the mirror reading suggests both make it worse. Each
        // was tried on screen:
        //
        //   `sideOrientation: Mesh.DOUBLESIDE` (the spelling copied from
        //     `standing-order-renderer.ts`) adds a second half with genuinely
        //     mirrored UVs that paints over the first — worse, not better;
        //   `uScale = -1` / `scaling.x = -1` add a HORIZONTAL flip on top of
        //     the vertical one, which lands on a clean 180° rotation: the most
        //     confidently wrong-looking of the three.
        //
        // Negating the mesh's own y scale is the one that reads correctly, and
        // it is measured rather than reasoned. Billboarding rewrites rotation,
        // never scale, so this survives the camera moving.
        //
        // `standing-order-renderer.ts`'s `makeLabelIcon` builds its billboard
        // the same way and so has the same defect. Its labels are counters like
        // "3/5", which is why nobody has read one closely enough to notice.
        // Flagged there, not fixed from here.
        plane.scaling.y = -1;
        plane.renderingGroupId = 3;
        plane.isPickable = false;
        plane.alwaysSelectAsActiveMesh = true;
        return plane;
    }

    private labelMaterial(text: string, color: Color3): StandardMaterial {
        const key = `${text}|${colorKey(color)}`;
        const cached = this.labelMats.get(key);
        if (cached) return cached;

        const w = 640, h = 152;
        const dyn = new DynamicTexture(`objective-label-tex-${key}`, { width: w, height: h },
            this.scene, false, Texture.TRILINEAR_SAMPLINGMODE);
        dyn.hasAlpha = true;
        const ctx = dyn.getContext() as CanvasRenderingContext2D;
        ctx.clearRect(0, 0, w, h);
        // A dark plate rather than a tinted one: the text has to stay legible
        // over snow, sand and water, and a team-coloured plate under white text
        // fails that on the yellow and white teams.
        ctx.fillStyle = 'rgba(8,10,14,0.62)';
        roundRect(ctx, 4, 24, w - 8, h - 48, 16);
        ctx.fill();
        ctx.strokeStyle = rgba(color, 0.95);
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 52px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(fit(ctx, text, w - 44), w / 2, h / 2);
        dyn.update(false);

        const mat = new StandardMaterial(`objective-label-mat-${key}`, this.scene);
        mat.diffuseTexture = dyn;
        mat.opacityTexture = dyn;
        mat.useAlphaFromDiffuseTexture = true;
        mat.emissiveColor = new Color3(1, 1, 1);
        mat.disableLighting = true;
        mat.backFaceCulling = false;
        mat.disableDepthWrite = true;
        mat.depthFunction = DEPTH_ALWAYS;
        mat.alpha = LABEL_ALPHA;
        this.labelMats.set(key, mat);
        return mat;
    }

    /** Bilinear terrain height, lifted. Mirrors the helper in
     *  `standing-order-renderer.ts` / `waypoint-marker-renderer.ts`. */
    private groundY(x: number, z: number): number {
        const m = this.mapData;
        if (!m || m.heightmap.length === 0) return TERRAIN_LIFT;
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
        return m.minHeight + (raw / 65535) * hRange + TERRAIN_LIFT;
    }

    private clearMeshes(): void {
        // Materials and their textures are CACHED, not owned by the mesh — a
        // rebuild disposes geometry only, which is what makes a progress tick
        // free.
        for (const m of this.built) {
            m.ring.dispose();
            m.label?.dispose();
        }
        this.built = [];
    }

    clear(): void {
        this.clearMeshes();
        this.markers = [];
        this.lastFingerprint = '';
    }

    dispose(): void {
        this.clearMeshes();
        for (const mat of this.ringMats.values()) mat.dispose();
        for (const mat of this.labelMats.values()) {
            mat.diffuseTexture?.dispose();
            mat.dispose();
        }
        this.ringMats.clear();
        this.labelMats.clear();
        this.markers = [];
        this.lastFingerprint = '';
    }
}

// ──────────────────────────── pure helpers ──────────────────────────────

/** Exported for the test: the fade curve is the "must not hide the fight"
 *  rule, so it is asserted rather than eyeballed in a screenshot. */
export function fadeForDistance(distance: number): number {
    if (!Number.isFinite(distance)) return 1;
    if (distance <= FADE_IN_LOW) return 0;
    if (distance >= FADE_IN_HIGH) return 1;
    return (distance - FADE_IN_LOW) / (FADE_IN_HIGH - FADE_IN_LOW);
}

/** The tint rule, exported so the minimap can be shown to agree with the world.
 *  Victory outranks a faction; an open race is nobody's colour. */
export function colorFor(m: ObjectiveMarker): Color3 {
    if (m.victory) return VICTORY_COLOR;
    if (m.team < 0) return OPEN_RACE_COLOR;
    return TEAM_COLORS[((m.team % TEAM_COLORS.length) + TEAM_COLORS.length) % TEAM_COLORS.length];
}

function colorKey(c: Color3): string {
    return `${c.r.toFixed(3)}_${c.g.toFixed(3)}_${c.b.toFixed(3)}`;
}

function rgba(c: Color3, a: number): string {
    return `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${a})`;
}

function roundRect(ctx: CanvasRenderingContext2D,
                   x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
}

/** Shrink an over-long title to fit the plate rather than letting it run off
 *  the edge — an objective title is composed, not bounded (see `shortName`). */
function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let out = text;
    while (out.length > 4 && ctx.measureText(`${out}…`).width > maxWidth) {
        out = out.slice(0, -1);
    }
    return `${out}…`;
}
